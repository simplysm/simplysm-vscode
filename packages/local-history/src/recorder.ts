import * as vscode from "vscode";
import type { Excludes } from "./exclude.ts";
import type { HistoryStore, IndexEntry, WorkspaceStores } from "./storage.ts";

// 이벤트 폭풍(git checkout, npm install 등) 대비 debounce — 창에 묶인 변경 = 스냅샷 1개 (spec 프로세스 1)
const DEBOUNCE_MS = 700;
// 스냅샷 쓰기 실패 후 재시도 간격 — 디스크 풀·잠금 같은 일시 장애가 풀릴 시간을 준다
const RETRY_MS = 10_000;

/** debounce 창에 쌓인 변경 1건 — 해시(삭제는 null) + rename 출처 + 색인용 uri/메타. */
interface PendingEntry {
  readonly hash: string | null;
  readonly renamedFrom?: string;
  readonly uri: vscode.Uri;
  /** 읽기 직전 stat — 색인용. 삭제(hash null)면 undefined. */
  readonly meta: FileMeta | undefined;
}

export interface FileMeta {
  readonly mtime: number;
  readonly size: number;
}

/**
 * 백그라운드 기록기 (spec 프로세스 1) — 공유 watcher 로 생성·수정·삭제를 잡아
 * blob 은 즉시 저장하고, debounce 창이 닫히면 체인지셋 스냅샷 1개를 기록한다.
 */
export class Recorder implements vscode.Disposable {
  private readonly stores: WorkspaceStores;
  private readonly disposables: vscode.Disposable[] = [];
  /** debounce 창에 쌓인 변경 — store 별 relPath → 항목. flush 성공 전까지는 여기 남는다. */
  private pending = new Map<HistoryStore, Map<string, PendingEntry>>();
  /** flush 가 쓰는 중인 배치 — 그 사이 온 같은 내용 이벤트가 lastHashes 갱신 전이라 dedup 을 빠져나가지 않게. */
  private inFlight: Map<HistoryStore, Map<string, PendingEntry>> | undefined;
  /** store 별 relPath → 마지막으로 스냅샷에 기록된 해시 — 내용 무변경 이벤트의 중복 스냅샷 방지. flush 성공 후에만 갱신. */
  private readonly lastHashes = new Map<HistoryStore, Map<string, string>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;
  private lastErrorAt = 0;
  private readonly onDidRecordEmitter = new vscode.EventEmitter<void>();
  /** 스냅샷 기록 완료 — 시점 목록 갱신용. */
  readonly onDidRecord = this.onDidRecordEmitter.event;

  private readonly logger: vscode.LogOutputChannel;
  private readonly excludes: Excludes;

  constructor(stores: WorkspaceStores, excludes: Excludes, logger: vscode.LogOutputChannel) {
    this.stores = stores;
    this.excludes = excludes;
    this.logger = logger;
    // 자체 watcher 기동 금지 — VS Code 공유 watcher 사용 (spec 프로세스 1)
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => void this.capture(uri, false)),
      watcher.onDidChange((uri) => void this.capture(uri, false)),
      watcher.onDidDelete((uri) => void this.capture(uri, true)),
      // rename 은 watcher 에 delete+create 로 보인다 — 이 이벤트로 이력 체인을 연결 (spec 프로세스 1)
      vscode.workspace.onDidRenameFiles((event) => void this.captureRenames(event)),
      this.onDidRecordEmitter,
    );
  }

  private async capture(uri: vscode.Uri, deleted: boolean): Promise<void> {
    try {
      // 진단용 — 기본 로그 레벨(info)에서는 숨겨지고, 사용자가 레벨을 올리면 보인다
      this.logger.debug(`event ${deleted ? "delete" : "change"}: ${uri.toString()}`);
      const resolved = await this.stores.resolve(uri);
      if (resolved === undefined || this.excludes.isExcluded(uri, resolved.relPath)) return;
      if (deleted) {
        await this.captureDeletion(resolved.store, resolved.relPath, uri);
        return;
      }
      const read = await readWithMeta(uri);
      if (read === undefined) return; // 삭제됨(별도 delete 이벤트가 온다) 또는 디렉터리
      const hash = await resolved.store.saveBlob(read.content);
      this.enqueue(resolved.store, resolved.relPath, hash, uri, read.meta);
    } catch (error) {
      this.reportError(error);
    }
  }

  /**
   * 경로 소멸 반영 — 기록(스냅샷)에 존재하던 파일이면 삭제 시점을 남기고,
   * 같은 창에서 생성만 됐던 파일이면 큐에서 빼서 흔적 없이 지운다. 기록된 적 없는 경로는 무시.
   */
  private async captureDeletion(
    store: HistoryStore,
    relPath: string,
    uri: vscode.Uri,
  ): Promise<void> {
    // 지금 쓰는 중인 배치가 이 경로를 담고 있으면 그것이 최신 상태 (currentState 는 쓰기 완료 후에야 갱신)
    const inFlightEntry = this.inFlight?.get(store)?.get(relPath);
    const recordedHash =
      inFlightEntry !== undefined ? inFlightEntry.hash : (await store.currentState()).get(relPath);
    if (typeof recordedHash === "string") {
      this.queue(store, relPath, null, uri);
      return;
    }
    const entries = this.pending.get(store);
    if (entries?.get(relPath)?.hash != null) {
      entries.delete(relPath);
      if (entries.size === 0) this.pending.delete(store);
    }
  }

  /** VS Code 를 통한 rename — 새 경로 항목에 `renamedFrom` 을 얹어 이력 체인을 잇는다. */
  private async captureRenames(event: vscode.FileRenameEvent): Promise<void> {
    for (const { oldUri, newUri } of event.files) {
      try {
        const stat = await vscode.workspace.fs.stat(newUri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          // 폴더 rename — 하위 파일 각각을 옛 경로와 연결
          await this.captureFolderRename(oldUri, newUri);
        } else {
          await this.captureFileRename(oldUri, newUri);
        }
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private async captureFileRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const resolvedNew = await this.stores.resolve(newUri);
    if (resolvedNew === undefined || this.excludes.isExcluded(newUri, resolvedNew.relPath)) return;
    const resolvedOld = await this.stores.resolve(oldUri);
    // 옛 경로 소멸은 rename 이벤트가 확정한다 — watcher delete 이벤트에 맡기지 않고 여기서 기록
    // (새 경로 읽기 실패로 아래에서 돌아가더라도 옛 경로 삭제는 남아야 한다)
    if (resolvedOld !== undefined && !this.excludes.isExcluded(oldUri, resolvedOld.relPath)) {
      await this.captureDeletion(resolvedOld.store, resolvedOld.relPath, oldUri);
    }
    const read = await readWithMeta(newUri);
    if (read === undefined) return; // 이벤트와 읽기 사이 재변경 — watcher 이벤트가 따로 처리한다
    const hash = await resolvedNew.store.saveBlob(read.content);
    this.queue(resolvedNew.store, resolvedNew.relPath, hash, newUri, {
      renamedFrom: resolvedOld?.relPath,
      meta: read.meta,
    });
  }

  private async captureFolderRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(newUri)) {
      const childNew = vscode.Uri.joinPath(newUri, name);
      const childOld = vscode.Uri.joinPath(oldUri, name);
      if ((type & vscode.FileType.Directory) !== 0) {
        await this.captureFolderRename(childOld, childNew);
      } else {
        await this.captureFileRename(childOld, childNew);
      }
    }
  }

  /** 외부 발견 변경(스캔 안전망 포함) 반영 — 세션 dedup 후 debounce 큐에 넣는다. */
  enqueue(
    store: HistoryStore,
    relPath: string,
    hash: string | null,
    uri: vscode.Uri,
    meta?: FileMeta,
  ): void {
    if (hash !== null && this.lastHashes.get(store)?.get(relPath) === hash) return;
    if (hash !== null && this.inFlight?.get(store)?.get(relPath)?.hash === hash) return; // 지금 쓰는 중
    if (this.pending.get(store)?.get(relPath)?.hash === hash) return; // 같은 창 안 중복 — 타이머만 늘린다
    this.queue(store, relPath, hash, uri, { meta });
  }

  private queue(
    store: HistoryStore,
    relPath: string,
    hash: string | null,
    uri: vscode.Uri,
    options?: { renamedFrom?: string; meta?: FileMeta },
  ): void {
    const entries = this.pendingOf(store);
    // watcher create 와 rename 이벤트가 같은 경로에 겹칠 수 있다 — renamedFrom 은 보존
    const existing = entries.get(relPath);
    entries.set(relPath, {
      hash,
      renamedFrom: options?.renamedFrom ?? existing?.renamedFrom,
      uri,
      meta: options?.meta,
    });
    this.schedule(DEBOUNCE_MS);
  }

  private pendingOf(store: HistoryStore): Map<string, PendingEntry> {
    let entries = this.pending.get(store);
    if (entries === undefined) {
      entries = new Map();
      this.pending.set(store, entries);
    }
    return entries;
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  /** 대기 중 변경을 스냅샷으로 기록. 진행 중이면 이번 창은 그 뒤로 미룬다 (스냅샷 시각 역전 방지). */
  private flush(): Promise<void> {
    if (this.flushPromise !== undefined) {
      this.schedule(DEBOUNCE_MS);
      return this.flushPromise;
    }
    this.flushPromise = this.doFlush().finally(() => {
      this.flushPromise = undefined;
    });
    return this.flushPromise;
  }

  /** 대기 중 변경을 지금 기록 — deactivate 용. 진행 중인 flush 를 기다린 뒤 남은 것을 마저 쓴다. */
  async flushNow(): Promise<void> {
    clearTimeout(this.timer);
    if (this.flushPromise !== undefined) await this.flushPromise;
    clearTimeout(this.timer);
    if (this.pending.size > 0) await this.flush();
  }

  private async doFlush(): Promise<void> {
    const batches = this.pending;
    this.pending = new Map();
    this.inFlight = batches;
    try {
      await this.writeBatches(batches);
    } finally {
      this.inFlight = undefined;
    }
  }

  private async writeBatches(batches: Map<HistoryStore, Map<string, PendingEntry>>): Promise<void> {
    let recorded = false;
    let restored = false;
    const failures: unknown[] = [];
    for (const [store, entries] of batches) {
      if (entries.size === 0) continue; // 창 안에서 생성→삭제로 비워진 배치 — 빈 스냅샷을 만들지 않는다
      try {
        await store.saveSnapshot(
          [...entries].map(([entryPath, pendingEntry]) => ({
            path: entryPath,
            hash: pendingEntry.hash,
            ...(pendingEntry.renamedFrom === undefined
              ? {}
              : { renamedFrom: pendingEntry.renamedFrom }),
          })),
        );
      } catch (error) {
        // 스냅샷이 안 남았다 — 큐로 되돌려 재시도. 그 사이 들어온 새 항목이 같은 경로면 새 것이 우선
        const current = this.pendingOf(store);
        for (const [entryPath, pendingEntry] of entries) {
          if (!current.has(entryPath)) current.set(entryPath, pendingEntry);
        }
        restored = true;
        failures.push(error);
        continue;
      }
      recorded = true;
      // 스냅샷이 디스크에 남은 뒤에만 세션 dedup 기준 갱신 — 실패한 창의 변경이 "이미 기록됨" 으로 오인되지 않게
      let hashes = this.lastHashes.get(store);
      if (hashes === undefined) {
        hashes = new Map();
        this.lastHashes.set(store, hashes);
      }
      const updates = new Map<string, IndexEntry | null>();
      for (const [entryPath, pendingEntry] of entries) {
        if (pendingEntry.hash === null) {
          hashes.delete(entryPath);
          updates.set(entryPath, null);
          continue;
        }
        hashes.set(entryPath, pendingEntry.hash);
        // meta = 읽기 직전 stat — 이후 파일이 또 바뀌었다면 색인이 "옛 mtime/size ↔ 옛 hash" 라 다음 스캔이 재검사한다
        if (pendingEntry.meta !== undefined) {
          updates.set(entryPath, { ...pendingEntry.meta, hash: pendingEntry.hash });
        }
      }
      try {
        await store.updateIndex(updates); // 스캔 가속 색인 — 다음 기동 스캔이 이미 기록된 변경을 재해싱하지 않게
      } catch (error) {
        failures.push(error); // 색인은 캐시 — 스냅샷은 남았으므로 되돌리지 않는다
      }
    }
    if (recorded) this.onDidRecordEmitter.fire();
    for (const failure of failures) this.reportError(failure);
    if (restored) this.schedule(RETRY_MS);
  }

  /** 기록 실패 = 이력 손실 문제 — 전부 로그에 남기고, 알림은 이벤트 폭풍 중 연속 실패 대비 10초에 1회만. */
  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`record failed: ${message}`);
    const now = Date.now();
    if (now - this.lastErrorAt < 10_000) return;
    this.lastErrorAt = now;
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Local History failed to record changes: {0}", message),
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/**
 * stat → 읽기 순서로 내용과 메타를 함께 얻는다. 없음(이벤트와 읽기 사이 삭제)·디렉터리 = undefined.
 * 권한·잠금 같은 그 밖의 실패는 던진다 — 기록 누락을 조용히 넘기지 않게.
 */
async function readWithMeta(
  uri: vscode.Uri,
): Promise<{ content: Uint8Array; meta: FileMeta } | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.File) === 0) return undefined;
    const content = await vscode.workspace.fs.readFile(uri);
    return { content, meta: { mtime: stat.mtime, size: stat.size } };
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return undefined;
    throw error;
  }
}
