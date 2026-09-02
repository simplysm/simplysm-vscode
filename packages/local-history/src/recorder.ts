import * as vscode from "vscode";
import type { Excludes } from "./exclude.ts";
import type { HistoryStore, IndexEntry, WorkspaceStores } from "./storage.ts";

// 이벤트 폭풍(git checkout, npm install 등) 대비 debounce — 창에 묶인 변경 = 스냅샷 1개 (spec 프로세스 1)
const DEBOUNCE_MS = 700;

/**
 * 백그라운드 기록기 (spec 프로세스 1) — 공유 watcher 로 생성·수정·삭제를 잡아
 * blob 은 즉시 저장하고, debounce 창이 닫히면 체인지셋 스냅샷 1개를 기록한다.
 */
export class Recorder implements vscode.Disposable {
  private readonly stores: WorkspaceStores;
  private readonly disposables: vscode.Disposable[] = [];
  /** debounce 창에 쌓인 변경 — store 별 relPath → 해시(삭제는 null)+rename 출처+색인용 uri. */
  private readonly pending = new Map<
    HistoryStore,
    Map<string, { hash: string | null; renamedFrom?: string; uri: vscode.Uri }>
  >();
  /** store 별 relPath → 마지막 기록 해시 — 내용 무변경 이벤트의 중복 스냅샷 방지. */
  private readonly lastHashes = new Map<HistoryStore, Map<string, string>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
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
        // 세션 중 기록된 적 없는 파일의 삭제 — 미기동 기간 삭제는 스캔 안전망 소관
        if (!this.lastHashes.get(resolved.store)?.has(resolved.relPath)) return;
        this.queue(resolved.store, resolved.relPath, null, uri);
        return;
      }
      let content: Uint8Array;
      try {
        content = await vscode.workspace.fs.readFile(uri);
      } catch {
        // 이벤트와 읽기 사이 삭제됨(별도 delete 이벤트가 온다) 또는 디렉터리 — 기록 대상 아님
        return;
      }
      const hash = await resolved.store.saveBlob(content);
      this.enqueue(resolved.store, resolved.relPath, hash, uri);
    } catch (error) {
      this.reportError(error);
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
    let content: Uint8Array;
    try {
      content = await vscode.workspace.fs.readFile(newUri);
    } catch {
      return; // 이벤트와 읽기 사이 재변경 — watcher 이벤트가 따로 처리한다
    }
    const hash = await resolvedNew.store.saveBlob(content);
    this.queue(resolvedNew.store, resolvedNew.relPath, hash, newUri, {
      renamedFrom: resolvedOld?.relPath,
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
  enqueue(store: HistoryStore, relPath: string, hash: string | null, uri: vscode.Uri): void {
    if (hash !== null && this.lastHashes.get(store)?.get(relPath) === hash) return;
    this.queue(store, relPath, hash, uri);
  }

  private queue(
    store: HistoryStore,
    relPath: string,
    hash: string | null,
    uri: vscode.Uri,
    options?: { renamedFrom?: string },
  ): void {
    let hashes = this.lastHashes.get(store);
    if (hashes === undefined) {
      hashes = new Map();
      this.lastHashes.set(store, hashes);
    }
    if (hash === null) hashes.delete(relPath);
    else hashes.set(relPath, hash);
    let entries = this.pending.get(store);
    if (entries === undefined) {
      entries = new Map();
      this.pending.set(store, entries);
    }
    // watcher create 와 rename 이벤트가 같은 경로에 겹칠 수 있다 — renamedFrom 은 보존
    const existing = entries.get(relPath);
    entries.set(relPath, {
      hash,
      renamedFrom: options?.renamedFrom ?? existing?.renamedFrom,
      uri,
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    const batches = [...this.pending];
    this.pending.clear();
    try {
      for (const [store, entries] of batches) {
        await store.saveSnapshot(
          [...entries].map(([entryPath, pendingEntry]) => ({
            path: entryPath,
            hash: pendingEntry.hash,
            ...(pendingEntry.renamedFrom === undefined
              ? {}
              : { renamedFrom: pendingEntry.renamedFrom }),
          })),
        );
        // 스캔 비교 색인 갱신 — 다음 기동 스캔이 이미 기록된 변경을 다시 잡지 않게
        const updates = new Map<string, IndexEntry | null>();
        for (const [entryPath, pendingEntry] of entries) {
          if (pendingEntry.hash === null) {
            updates.set(entryPath, null);
            continue;
          }
          try {
            const stat = await vscode.workspace.fs.stat(pendingEntry.uri);
            updates.set(entryPath, {
              mtime: stat.mtime,
              size: stat.size,
              hash: pendingEntry.hash,
            });
          } catch {
            // 기록과 stat 사이 삭제됨 — 색인은 다음 이벤트/스캔이 정리
          }
        }
        await store.updateIndex(updates);
      }
      this.onDidRecordEmitter.fire();
    } catch (error) {
      this.reportError(error);
    }
  }

  /** 기록 실패 = 이력 손실 문제 — error 등급으로 알리되, 이벤트 폭풍 중 연속 실패는 10초에 1회만. */
  private reportError(error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorAt < 10_000) return;
    this.lastErrorAt = now;
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Local History failed to record changes: {0}",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }
}
