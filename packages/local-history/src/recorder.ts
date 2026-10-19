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
      if (isBusyError(error)) {
        this.warnBusy(uri);
        return;
      }
      this.reportError(error, uri);
    }
  }

  /** 다른 프로세스가 잠근 파일 — 지금은 누구도 못 읽는다. 색인이 안 바뀌므로 다음 스캔이 다시 읽는다. */
  private warnBusy(uri: vscode.Uri): void {
    this.logger.warn(`locked by another process, will retry on next scan: ${uri.fsPath}`);
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
    const state = await store.currentState();
    const recordedHash = this.inFlightOr(store, relPath, state);
    if (typeof recordedHash === "string") {
      this.queue(store, relPath, null, uri);
      return;
    }
    const entries = this.pending.get(store);
    if (entries?.get(relPath)?.hash != null) {
      entries.delete(relPath);
      if (entries.size === 0) this.pending.delete(store);
    }
    await this.captureFolderDeletion(store, relPath, uri, state);
  }

  /** 기록된 상태 — 지금 쓰는 중인 배치가 이 경로를 담고 있으면 그것, 아니면 `state`. */
  private inFlightOr(
    store: HistoryStore,
    relPath: string,
    state: ReadonlyMap<string, string | null>,
  ): string | null | undefined {
    const inFlightEntry = this.inFlight?.get(store)?.get(relPath);
    return inFlightEntry !== undefined ? inFlightEntry.hash : state.get(relPath);
  }

  /**
   * 지워진 경로가 폴더였으면 그 아래 기록된 파일을 모두 지운 것으로 남긴다.
   * VS Code watcher 는 폴더를 지우면 그 아래 파일의 삭제를 폴더 하나의 삭제로 합쳐 알린다. 그대로 두면 파일 삭제가
   * 다음 스캔까지 기록되지 않는다(예: 탐색기에서 폴더 삭제, 복원이 파일을 지우고 비게 된 폴더를 지움).
   * 그 경로에 다시 뭔가 있으면 건너뛴다 — 그 아래 변경은 따로 이벤트로 온다. 제외 대상은 스캔과 같게 기록하지 않는다.
   */
  private async captureFolderDeletion(
    store: HistoryStore,
    relPath: string,
    uri: vscode.Uri,
    state: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    const prefix = `${relPath}/`;
    const under = (entryPath: string) => relPath !== "" && entryPath.startsWith(prefix);
    const inFlightPaths = [...(this.inFlight?.get(store)?.keys() ?? [])];
    const recorded = new Set(
      [...state.keys(), ...inFlightPaths].filter(
        (entryPath) =>
          under(entryPath) && typeof this.inFlightOr(store, entryPath, state) === "string",
      ),
    );
    const createdInWindow = [...(this.pending.get(store) ?? [])]
      .filter(([entryPath, entry]) => under(entryPath) && entry.hash !== null)
      .map(([entryPath]) => entryPath)
      .filter((entryPath) => !recorded.has(entryPath));
    if (recorded.size === 0 && createdInWindow.length === 0) return;
    if (await pathExists(uri)) return;
    const entries = this.pending.get(store);
    for (const entryPath of createdInWindow) entries?.delete(entryPath); // 이 창에서 생겼다 사라짐
    if (entries?.size === 0) this.pending.delete(store);
    for (const entryPath of recorded) {
      const childUri = vscode.Uri.joinPath(uri, entryPath.slice(prefix.length));
      if (this.excludes.isExcluded(childUri, entryPath)) continue; // 제외 규칙 변경 전 기록 — prune 이 소급 정리
      this.queue(store, entryPath, null, childUri);
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
        if (isBusyError(error)) {
          this.warnBusy(newUri);
          continue;
        }
        this.reportError(error, newUri);
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

  /**
   * 확장이 만든 이름 변경을 잇는다 — 복원이 이름 변경 · 이동을 되돌릴 때 (spec 「4. 복원」).
   * workspace.fs 로 쓰고 지운 변경에는 VS Code rename 이벤트(onDidRenameFiles)가 없어 watcher 에 생성 + 삭제로만 보인다.
   * 그러면 기록에서 이름 변경이 항목 둘로 갈리고, 그중 하나만 복원하면 파일이 두 곳에 생기거나 사라진다(spec 「3. 열람」).
   * 그래서 rename 이벤트를 받았을 때처럼 새 경로 항목에 renamedFrom 을 얹고, 옛 경로의 상태도 같은 창에 넣는다.
   * 같은 쓰기의 watcher 이벤트는 같은 내용이라 이 항목에 합쳐진다. 두 경로를 디스크에 쓴 뒤에 부른다 — 쓰지 못한 상태를
   * 기록하지 않게. `from` = 내용이 떠난 경로(해시 null = 지움), `to` = 내용이 온 경로.
   */
  linkRename(
    store: HistoryStore,
    from: { readonly path: string; readonly hash: string | null; readonly uri: vscode.Uri },
    to: { readonly path: string; readonly hash: string; readonly uri: vscode.Uri },
  ): void {
    this.queue(store, from.path, from.hash, from.uri);
    this.queue(store, to.path, to.hash, to.uri, { renamedFrom: from.path });
  }

  /**
   * 외부 발견 변경(스캔 안전망 포함) 반영 — 세션 dedup 후 debounce 큐에 넣는다.
   * 비교 기준은 그 경로의 가장 늦은 상태다: 대기 중 → 쓰는 중 → 기록됨 순. 기록된 값부터 보면, 같은 창에서
   * 바뀌었다가(대기 중) 기록된 내용으로 돌아온 이벤트가 버려져 디스크와 다른 상태가 기록된다
   * (예: 복원이 쓰고 실패해 되돌림, 지웠다가 같은 내용으로 다시 만듦).
   */
  enqueue(
    store: HistoryStore,
    relPath: string,
    hash: string | null,
    uri: vscode.Uri,
    meta?: FileMeta,
  ): void {
    const entries = this.pending.get(store);
    const queued = entries?.get(relPath);
    if (queued === undefined) {
      if (hash !== null && this.recordedHashOf(store, relPath) === hash) return; // 이미 기록됨 · 쓰는 중
      this.queue(store, relPath, hash, uri, { meta });
      return;
    }
    if (queued.hash === hash) return; // 같은 창 안 중복
    if (
      hash !== null &&
      queued.renamedFrom === undefined &&
      this.recordedHashOf(store, relPath) === hash
    ) {
      // 이 창 안에서 바뀌었다가 마지막 기록으로 돌아왔다 — 기록할 변경이 없다
      entries?.delete(relPath);
      if (entries?.size === 0) this.pending.delete(store);
      return;
    }
    this.queue(store, relPath, hash, uri, { meta });
  }

  /** 이 세션이 아는 마지막 기록 상태 — 쓰는 중인 배치가 있으면 그것(곧 기록된다). 모르면 undefined. */
  private recordedHashOf(store: HistoryStore, relPath: string): string | null | undefined {
    const inFlight = this.inFlight?.get(store)?.get(relPath);
    return inFlight !== undefined ? inFlight.hash : this.lastHashes.get(store)?.get(relPath);
  }

  /** 세션 dedup 기준 갱신 — 그 경로의 마지막 기록이 `hash`(null = 삭제)다. */
  private rememberRecorded(store: HistoryStore, relPath: string, hash: string | null): void {
    let hashes = this.lastHashes.get(store);
    if (hashes === undefined) {
      hashes = new Map();
      this.lastHashes.set(store, hashes);
    }
    if (hash === null) hashes.delete(relPath);
    else hashes.set(relPath, hash);
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
    return this.startFlush().then(() => undefined);
  }

  /** flush 를 시작한다 — 진행 중인 flush 가 없을 때만 부른다. 반환 = `strictStore` 의 스냅샷 쓰기 실패(없으면 undefined). */
  private startFlush(strictStore?: HistoryStore): Promise<unknown> {
    const run = this.doFlush(strictStore);
    this.flushPromise = run
      .then(() => undefined)
      .finally(() => {
        this.flushPromise = undefined;
      });
    return run;
  }

  /**
   * 지금 상태를 곧바로 기록한다 — 복원 직전 기록 (spec 「4. 복원」 안전장치).
   * `states` 를 대기 중 변경과 함께 스냅샷 하나로 쓴다. 대기 중이 아닌 경로는 마지막 기록과 같으면 뺀다.
   * 이 store 의 스냅샷을 쓰지 못하면 던진다 — 기록 없이 복원하면 덮어쓴 내용을 되찾을 수 없다.
   * 이 기록도 세션 dedup 기준이 된다. 그래서 뒤늦게 온 같은 내용의 이벤트(먼저 저장한 미저장 편집 등)가 줄을 또 만들지 않는다.
   */
  async recordNow(
    store: HistoryStore,
    states: readonly {
      readonly path: string;
      readonly hash: string | null;
      readonly uri: vscode.Uri;
    }[],
  ): Promise<void> {
    clearTimeout(this.timer);
    // 진행 중인 기록이 먼저다(시각 순서). 마지막 기록은 그 뒤에 읽는다 — 읽는 사이 시작된 flush 도 기다린다
    let recorded: ReadonlyMap<string, string | null>;
    do {
      while (this.flushPromise !== undefined) await this.flushPromise;
      recorded = await store.currentState();
    } while (this.flushPromise !== undefined);
    // 여기부터 await 없이 대기열에 넣고 flush 를 시작한다 — 그 사이 다른 flush 가 끼지 않는다
    const pending = this.pending.get(store);
    for (const state of states) {
      // 대기 중인 경로는 늘 덮는다 — 대기 중인 값이 지금 상태보다 낡았을 수 있다
      if (pending?.has(state.path) !== true && (recorded.get(state.path) ?? null) === state.hash) {
        continue;
      }
      this.queue(store, state.path, state.hash, state.uri);
    }
    clearTimeout(this.timer);
    if (this.pending.size > 0) {
      const failure = await this.startFlush(store);
      if (failure !== undefined) throw failure;
    }
    // 대상 경로의 마지막 기록 = states(방금 썼거나 이미 같았다). 이 세션에서 기록한 적 없는 경로도 기준을 두어,
    // 이어지는 복원 쓰기가 실패해 되돌리면 그 창의 변경이 없던 것이 되게 한다(enqueue)
    for (const state of states) this.rememberRecorded(store, state.path, state.hash);
  }

  /** 대기 중 변경을 지금 기록 — deactivate 용. 진행 중인 flush 를 기다린 뒤 남은 것을 마저 쓴다. */
  async flushNow(): Promise<void> {
    clearTimeout(this.timer);
    if (this.flushPromise !== undefined) await this.flushPromise;
    clearTimeout(this.timer);
    if (this.pending.size > 0) await this.flush();
  }

  private async doFlush(strictStore?: HistoryStore): Promise<unknown> {
    const batches = this.pending;
    this.pending = new Map();
    this.inFlight = batches;
    try {
      return await this.writeBatches(batches, strictStore);
    } finally {
      this.inFlight = undefined;
    }
  }

  /**
   * 배치마다 스냅샷 하나를 쓴다. 실패한 배치는 큐로 되돌려 재시도한다.
   * `strictStore` 의 스냅샷 쓰기 실패는 알리지 않고 돌려준다 — 부른 쪽(복원)이 오류로 알린다.
   */
  private async writeBatches(
    batches: Map<HistoryStore, Map<string, PendingEntry>>,
    strictStore: HistoryStore | undefined,
  ): Promise<unknown> {
    let recorded = false;
    let restored = false;
    let strictFailure: unknown;
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
        if (store === strictStore) strictFailure = error;
        else failures.push(error);
        continue;
      }
      recorded = true;
      // 스냅샷이 디스크에 남은 뒤에만 세션 dedup 기준 갱신 — 실패한 창의 변경이 "이미 기록됨" 으로 오인되지 않게
      const updates = new Map<string, IndexEntry | null>();
      for (const [entryPath, pendingEntry] of entries) {
        this.rememberRecorded(store, entryPath, pendingEntry.hash);
        if (pendingEntry.hash === null) {
          updates.set(entryPath, null);
          continue;
        }
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
    return strictFailure;
  }

  /**
   * 기록 실패 = 이력 손실 문제 — 전부 로그에 남기고, 알림은 이벤트 폭풍 중 연속 실패 대비 10초에 1회만.
   * `uri` = 실패한 대상 파일 — `vscode.workspace.fs` 오류에는 경로가 없어 여기서 붙인다 (스냅샷 쓰기 실패는 대상 파일이 없음).
   */
  private reportError(error: unknown, uri?: vscode.Uri): void {
    const cause = error instanceof Error ? error.message : String(error);
    const message = uri === undefined ? cause : `${uri.fsPath}: ${cause}`;
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
 * 다른 프로세스의 독점 잠금(Windows 공유 위반 = EBUSY)인지 — `vscode.workspace.fs` 는 이 오류를
 * `Unknown` 코드로만 돌려주고 원래 코드는 메시지에만 남아 있어 메시지로 판별한다.
 */
export function isBusyError(error: unknown): boolean {
  return error instanceof Error && /\bEBUSY\b/.test(error.message);
}

/** 그 경로에 뭔가 있는가 — 없음 밖의 stat 실패는 던진다. */
async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return false;
    throw error;
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
