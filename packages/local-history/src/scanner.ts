import * as vscode from "vscode";
import { hashOf, isUnderPrefix } from "./storage.ts";
import type { Excludes } from "./exclude.ts";
import type { Recorder } from "./recorder.ts";
import type { HistoryStore, IndexEntry, WorkspaceStores } from "./storage.ts";

// 스캔 간 최소 간격 (spec 스캔 트리거 — throttle)
const THROTTLE_MS = 30_000;

/** 폴더 1개 스캔의 작업 상태 — 순회 함수들이 공유. */
interface ScanContext {
  readonly root: vscode.Uri;
  readonly store: HistoryStore;
  /** 스캔 가속 색인 — mtime/size 가 같으면 읽지 않는다. */
  readonly index: ReadonlyMap<string, IndexEntry>;
  /** 스냅샷의 마지막 기록 상태 — 변경 여부의 기준 (색인은 캐시라 기준이 못 된다). */
  readonly recorded: ReadonlyMap<string, string | null>;
  readonly seen: Set<string>;
  /** 내용 동일·메타만 갱신분 + 색인 정리. */
  readonly touches: Map<string, IndexEntry | null>;
  /** 항목 단위 실패 — 하나가 막혀도 나머지는 계속 검사하고, 끝에 한 번 보고. */
  readonly failures: { relPath: string; error: unknown }[];
  /** 열거에 실패한 디렉터리 — 그 하위는 "없음" 을 확인한 게 아니므로 삭제 판정에서 제외. */
  readonly unreadableDirs: string[];
}

/**
 * 스캔 안전망 (spec 프로세스 1) — 트리 순회 + mtime/size 비교로 이벤트 유실·미기동 기간의
 * 변경을 잡는다. 발견분은 Recorder 의 debounce 큐로 흘려 이벤트 기록과 같은 경로를 탄다.
 * 트리거: 기동 / 창 재포커스 / 열람·롤백 직전. 주기 타이머 없음 (spec 확정).
 */
export class Scanner {
  private readonly stores: WorkspaceStores;
  private readonly recorder: Recorder;
  private readonly excludes: Excludes;
  private readonly onError: (error: unknown) => void;
  private lastScanAt = 0;
  private scanning = false;

  constructor(
    stores: WorkspaceStores,
    recorder: Recorder,
    excludes: Excludes,
    onError: (error: unknown) => void,
  ) {
    this.stores = stores;
    this.recorder = recorder;
    this.excludes = excludes;
    this.onError = onError;
  }

  async scan(): Promise<void> {
    if (this.scanning || Date.now() - this.lastScanAt < THROTTLE_MS) return;
    this.scanning = true;
    this.lastScanAt = Date.now();
    try {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        // 폴더 단위 격리 — 한 폴더의 저장소 장애가 다른 폴더의 스캔을 막지 않게
        try {
          await this.scanFolder(folder);
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private async scanFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const resolved = await this.stores.resolve(folder.uri);
    if (resolved === undefined) return;
    const context: ScanContext = {
      root: folder.uri,
      store: resolved.store,
      index: await resolved.store.loadIndex(),
      recorded: await resolved.store.currentState(),
      seen: new Set(),
      touches: new Map(),
      failures: [],
      unreadableDirs: [],
    };
    await this.walk(context, folder.uri);
    const confirmedMissing = (relPath: string): boolean =>
      !context.seen.has(relPath) &&
      !context.unreadableDirs.some((dir) => isUnderPrefix(relPath, dir));
    // 기록상 존재하는데 디스크에 없음 = 미기동 기간(또는 유실된 이벤트)의 삭제
    for (const [relPath, hash] of context.recorded) {
      if (hash === null || !confirmedMissing(relPath)) continue;
      if (this.excludes.isExcluded(folder.uri, relPath)) continue; // 제외 규칙 변경 전 기록 — prune 이 소급 정리
      this.recorder.enqueue(
        resolved.store,
        relPath,
        null,
        vscode.Uri.joinPath(folder.uri, relPath),
      );
    }
    // 색인에만 남은 경로(제외됐거나 기록상 이미 삭제) 정리
    for (const relPath of context.index.keys()) {
      if (confirmedMissing(relPath)) context.touches.set(relPath, null);
    }
    if (context.touches.size > 0) await resolved.store.updateIndex(context.touches);
    if (context.failures.length > 0) {
      const [first] = context.failures;
      throw new Error(
        `${context.failures.length} item(s) could not be scanned, e.g. ${first.relPath}: ${
          first.error instanceof Error ? first.error.message : String(first.error)
        }`,
      );
    }
  }

  private async walk(context: ScanContext, dir: vscode.Uri): Promise<void> {
    let children: [string, vscode.FileType][];
    try {
      children = await vscode.workspace.fs.readDirectory(dir);
    } catch (error) {
      const relPath = relPathOf(context.root, dir);
      context.failures.push({ relPath, error });
      context.unreadableDirs.push(relPath);
      return;
    }
    for (const [name, type] of children) {
      const uri = vscode.Uri.joinPath(dir, name);
      const relPath = relPathOf(context.root, uri);
      if (this.excludes.isExcluded(uri, relPath)) continue;
      if ((type & vscode.FileType.Directory) !== 0) {
        if ((type & vscode.FileType.SymbolicLink) === 0) await this.walk(context, uri); // 링크 폴더는 순환 방지로 제외
        continue;
      }
      context.seen.add(relPath); // 검사 실패해도 "디스크에 있음" 은 확실 — 삭제로 오판하지 않게 먼저
      if ((type & vscode.FileType.SymbolicLink) !== 0) continue; // 링크 파일은 watcher 기록만 — 존재 확인은 위에서 끝
      try {
        await this.checkFile(context, uri, relPath);
      } catch (error) {
        context.failures.push({ relPath, error });
      }
    }
  }

  private async checkFile(context: ScanContext, uri: vscode.Uri, relPath: string): Promise<void> {
    const stat = await vscode.workspace.fs.stat(uri);
    const known = context.index.get(relPath);
    if (
      known !== undefined &&
      known.mtime === stat.mtime &&
      known.size === stat.size &&
      context.recorded.get(relPath) === known.hash // 색인은 캐시 — 기록(prune 으로 사라졌을 수 있음)과 맞을 때만 신뢰
    ) {
      return;
    }
    const content = await vscode.workspace.fs.readFile(uri);
    const hash = hashOf(content);
    const meta = { mtime: stat.mtime, size: stat.size };
    if (context.recorded.get(relPath) === hash) {
      // 내용이 마지막 기록과 동일 — 색인만 갱신해 다음 스캔의 재해싱 방지 (색인이 낡았거나 없던 경우)
      context.touches.set(relPath, { ...meta, hash });
      return;
    }
    await context.store.saveBlob(content);
    this.recorder.enqueue(context.store, relPath, hash, uri, meta); // 색인 갱신은 flush 가 수행
  }
}

/** 폴더 기준 상대 경로 (구분자 `/`). 폴더 자신은 "" — isUnderPrefix 의 "전체" 와 같은 뜻. */
function relPathOf(root: vscode.Uri, uri: vscode.Uri): string {
  return uri.path.length <= root.path.length ? "" : uri.path.slice(root.path.length + 1);
}
