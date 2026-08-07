import * as vscode from "vscode";
import { hashOf } from "./storage.ts";
import { isExcluded } from "./recorder.ts";
import type { Recorder } from "./recorder.ts";
import type { HistoryStore, IndexEntry, WorkspaceStores } from "./storage.ts";

// 스캔 간 최소 간격 (spec 스캔 트리거 — throttle)
const THROTTLE_MS = 30_000;

/**
 * 스캔 안전망 (spec 프로세스 1) — 트리 순회 + mtime/size 비교로 이벤트 유실·미기동 기간의
 * 변경을 잡는다. 발견분은 Recorder 의 debounce 큐로 흘려 이벤트 기록과 같은 경로를 탄다.
 * 트리거: 기동 / 창 재포커스 / 열람·롤백 직전. 주기 타이머 없음 (spec 확정).
 */
export class Scanner {
  private readonly stores: WorkspaceStores;
  private readonly recorder: Recorder;
  private readonly onError: (error: unknown) => void;
  private lastScanAt = 0;
  private scanning = false;

  constructor(stores: WorkspaceStores, recorder: Recorder, onError: (error: unknown) => void) {
    this.stores = stores;
    this.recorder = recorder;
    this.onError = onError;
  }

  async scan(): Promise<void> {
    if (this.scanning || Date.now() - this.lastScanAt < THROTTLE_MS) return;
    this.scanning = true;
    this.lastScanAt = Date.now();
    try {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const resolved = await this.stores.resolve(folder.uri);
        if (resolved === undefined) continue;
        const index = await resolved.store.loadIndex();
        const seen = new Set<string>();
        const touches = new Map<string, IndexEntry | null>(); // 내용 동일·메타만 갱신분
        await this.walk(folder.uri, folder.uri, resolved.store, index, seen, touches);
        // 색인에 있는데 디스크에 없음 = 미기동 기간 삭제
        for (const relPath of index.keys()) {
          if (!seen.has(relPath)) {
            this.recorder.enqueue(
              resolved.store,
              relPath,
              null,
              vscode.Uri.joinPath(folder.uri, relPath),
            );
          }
        }
        if (touches.size > 0) await resolved.store.updateIndex(touches);
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.scanning = false;
    }
  }

  private async walk(
    root: vscode.Uri,
    dir: vscode.Uri,
    store: HistoryStore,
    index: ReadonlyMap<string, IndexEntry>,
    seen: Set<string>,
    touches: Map<string, IndexEntry | null>,
  ): Promise<void> {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
      const uri = vscode.Uri.joinPath(dir, name);
      const relPath = uri.path.slice(root.path.length + 1);
      if (isExcluded(relPath)) continue;
      if ((type & vscode.FileType.SymbolicLink) !== 0) continue; // 순환 방지
      if ((type & vscode.FileType.Directory) !== 0) {
        await this.walk(root, uri, store, index, seen, touches);
        continue;
      }
      seen.add(relPath);
      const stat = await vscode.workspace.fs.stat(uri);
      const known = index.get(relPath);
      if (known !== undefined && known.mtime === stat.mtime && known.size === stat.size) continue;
      const content = await vscode.workspace.fs.readFile(uri);
      const hash = hashOf(content);
      if (known?.hash === hash) {
        // 내용 동일 — 메타데이터만 갱신해 다음 스캔의 재해싱 방지
        touches.set(relPath, { mtime: stat.mtime, size: stat.size, hash });
        continue;
      }
      await store.saveBlob(content);
      this.recorder.enqueue(store, relPath, hash, uri); // 색인 갱신은 flush 가 수행
    }
  }
}
