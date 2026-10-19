import * as vscode from "vscode";
import { createHash, randomBytes } from "node:crypto";
import { deflate, inflate } from "node:zlib";
import { promisify } from "node:util";
import path from "node:path";
import fs, { type FileHandle } from "node:fs/promises";
import { isProcessAlive } from "./process-alive.ts";
import { isUnderPrefix } from "./rel-path.ts";

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

/** 보존 기한 1년 (spec 확정) — 초과 스냅샷은 기동 시 백그라운드 prune. */
export const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/** 색인 쓰기 유휴 지연 — 색인은 캐시라 낡아도 재해싱 비용뿐이므로, 매 flush 전체 재기록 대신 모아 쓴다. */
const INDEX_WRITE_IDLE_MS = 5_000;

/** 스냅샷 항목 — `hash === null` = 그 시점에 삭제됨. `renamedFrom` = 이 시점에 그 경로에서 개명됨. */
export interface SnapshotEntry {
  readonly path: string;
  readonly hash: string | null;
  readonly renamedFrom?: string;
}

/** 스냅샷 = 체인지셋 매니페스트 — 그 debounce 창에서 변경된 파일만 담는다 (spec 저장 구조). */
export interface Snapshot {
  readonly at: number;
  readonly entries: SnapshotEntry[];
}

/**
 * 워크스페이스 폴더 1개의 이력 저장소.
 * globalStorage/<폴더 경로 sha1>/ 하위 — 워크스페이스 밖이라 사용자 Git 저장소를 오염시키지 않는다.
 * - blobs/<해시 앞2>/<나머지> : zlib 압축 content-addressed blob
 * - snapshots.jsonl : 체인지셋 매니페스트의 추가 전용 로그 (진실). 한 줄 = 스냅샷 하나, 쓴 순서대로.
 *   파일 하나라서 적재 비용이 스냅샷 수만큼의 파일 열기가 아니라 한 번의 읽기다.
 * - snapshots.lock : 로그를 바꾸는 작업의 프로세스 사이 잠금 (`LogLock`)
 * - index.json : 스캔 가속용 경로별 mtime/size 캐시 — 낡거나 없어도 재해싱 비용만 늘 뿐 결과는 같다
 * - snapshots/<at>.json : 옛 형식(파일 다수) 수신함 — init 때마다 로그로 가져오고 가져온 파일만 지운다.
 *   이 확장은 이 디렉터리를 만들거나 여기에 쓰지 않는다(쓰는 쪽은 아직 다시 로드하지 않은 옛 확장 창).
 *
 * 같은 폴더를 두 창이 열면(폴더 창 + 그 폴더를 담은 멀티루트 창) 확장 호스트 둘이 이 저장소를 함께 쓴다.
 * 그래서 로그를 바꾸는 작업(이전 · append · 반쪽 줄 잘라내기 · prune 다시 쓰기)은 모두 `LogLock` 아래에서 한다.
 * 적재의 파일 읽기도 잠금 아래에서 한다 — Windows 는 열려 있는 파일을 rename 으로 덮지 못하기 때문이다.
 */
export class HistoryStore {
  private readonly storeDir: string;
  private readonly blobsDir: string;
  private readonly logPath: string;
  private readonly legacySnapshotsDir: string;
  private readonly logLock: LogLock;
  private readonly indexPath: string;
  private readonly onError: (error: unknown) => void;
  private index: Map<string, IndexEntry> | undefined;
  private indexDirty = false;
  private indexWriteTimer: ReturnType<typeof setTimeout> | undefined;
  /** 스냅샷 목록 메모리 캐시(최신순) — 쓰기 주체가 이 인스턴스뿐이라 save/prune 때만 갱신하면 된다. */
  private snapshotsCache: Snapshot[] | undefined;
  /** 경로별 마지막 기록 상태(null = 삭제) — 스냅샷 재생 결과의 캐시, save/prune 때 함께 갱신. */
  private currentStateCache: Map<string, string | null> | undefined;
  /** 캐시 세대 — save·prune 로 로그가 바뀔 때마다 올려서, 그 사이에 계산된 낡은 상태가 캐시로 굳는 것을 막는다. */
  private cacheGeneration = 0;
  /**
   * 로그 작업 대기열 — 이 인스턴스의 이전 · append · prune 재작성 · 적재를 차례로 실행한다.
   * 캐시 갱신 순서를 로그에 쓴 순서와 맞추기 위해서다. 프로세스 사이 배타는 `logLock` 이 맡는다.
   */
  private logQueue: Promise<unknown> = Promise.resolve();

  /** `onError` = 유휴 색인 쓰기처럼 호출자가 없는 백그라운드 실패의 보고 경로. */
  constructor(storageRoot: string, workspaceFolderPath: string, onError: (error: unknown) => void) {
    const workspaceId = createHash("sha1").update(workspaceFolderPath).digest("hex");
    this.storeDir = path.join(storageRoot, workspaceId);
    this.blobsDir = path.join(this.storeDir, "blobs");
    this.logPath = path.join(this.storeDir, "snapshots.jsonl");
    this.legacySnapshotsDir = path.join(this.storeDir, "snapshots");
    this.logLock = new LogLock(path.join(this.storeDir, "snapshots.lock"));
    this.indexPath = path.join(this.storeDir, "index.json");
    this.onError = onError;
  }

  /** 스캔 가속 색인 (경로 → 마지막 기록 시점의 mtime/size) — 최초 접근 시 파일에서 적재. */
  async loadIndex(): Promise<ReadonlyMap<string, IndexEntry>> {
    if (this.index === undefined) {
      try {
        this.index = new Map(
          Object.entries(
            JSON.parse(await fs.readFile(this.indexPath, "utf8")) as Record<string, IndexEntry>,
          ),
        );
      } catch (error) {
        // 없음(최초 실행)만 빈 색인. 손상·권한 오류는 숨기지 않는다 — 조용히 빈 색인으로 덮어쓰면 원인이 사라진다
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.index = new Map();
      }
    }
    return this.index;
  }

  /** 색인 항목 갱신(값 null = 삭제) — 메모리에 반영하고 디스크 쓰기는 유휴 시 1회로 모은다. */
  async updateIndex(updates: ReadonlyMap<string, IndexEntry | null>): Promise<void> {
    await this.loadIndex();
    const index = this.index!;
    for (const [entryPath, entry] of updates) {
      if (entry === null) index.delete(entryPath);
      else index.set(entryPath, entry);
    }
    this.indexDirty = true;
    clearTimeout(this.indexWriteTimer);
    this.indexWriteTimer = setTimeout(
      () => void this.flushIndex().catch(this.onError),
      INDEX_WRITE_IDLE_MS,
    );
  }

  /** 색인을 지금 디스크에 쓴다 — 유휴 타이머 만료·deactivate 시. 변경 없으면 no-op. */
  async flushIndex(): Promise<void> {
    clearTimeout(this.indexWriteTimer);
    if (!this.indexDirty || this.index === undefined) return;
    this.indexDirty = false;
    try {
      await writeFileAtomic(this.indexPath, JSON.stringify(Object.fromEntries(this.index)));
    } catch (error) {
      this.indexDirty = true; // 다음 갱신·flush 가 재시도
      throw error;
    }
  }

  private initPromise: Promise<void> | undefined;

  /** 저장 디렉터리 생성 + 옛 형식 가져오기 — 멱등. 동시 호출이 같은 1회 수행을 기다린다. */
  init(): Promise<void> {
    this.initPromise ??= (async () => {
      await fs.mkdir(this.blobsDir, { recursive: true });
      const imported = await this.enqueueLogTask(() => this.importLegacySnapshots());
      this.removeImportedFiles(imported);
    })();
    return this.initPromise;
  }

  /**
   * 옛 형식 수신함(snapshots/<at>.json) → 로그 가져오기. 반환 = 로그에 들어간(또는 이미 있던) 파일 경로.
   * 수신함인 이유: 업데이트 뒤 아직 다시 로드하지 않은 창은 옛 확장으로 이 디렉터리에 계속 기록한다.
   * 그래서 기동마다 가져오고, 디렉터리 자체는 지우지 않는다(지우면 그 창의 기록이 ENOENT 로 실패한다).
   * - 같은 스냅샷 = at 과 entries 가 같다. 가져온 뒤 파일을 지우기 전에 끊겨도 다시 가져오며 건너뛴다.
   * - at 이 로그의 다른 스냅샷과 겹치면 비어 있는 다음 at 으로 옮긴다. 다시 가져올 때도 같은 순서로
   *   찾아 가므로(같은 at 이면 entries 비교, 다르면 다음 at) 옮겨 넣은 것도 중복으로 알아본다.
   * - 가져온 스냅샷은 원래 시각 자리에 끼운다 — 로그를 at 순으로 다시 쓴다(목록이 시각순, at 유일).
   */
  private async importLegacySnapshots(): Promise<string[]> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.legacySnapshotsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; // 옛 형식 없음
      throw error;
    }
    // 원자 쓰기 임시 파일(.tmp-*)은 아직 다 쓰이지 않았거나 잔재다 — 스냅샷이 아니다
    const snapshotPaths = fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) => path.join(this.legacySnapshotsDir, fileName));
    if (snapshotPaths.length === 0) return []; // 잠금 없이 끝낸다 — 흔한 경우
    return await this.logLock.run(async () => {
      // 순차 읽기 — 병렬(Promise.all)로 전부 열면 스냅샷 수천 개에서 EMFILE 발생
      const incoming: Snapshot[] = [];
      const readPaths: string[] = [];
      for (const snapshotPath of snapshotPaths) {
        let raw: string;
        try {
          raw = await fs.readFile(snapshotPath, "utf8");
        } catch (error) {
          // 다른 창이 먼저 가져가 지웠거나(지우는 중이면 Windows 는 EPERM) 옛 확장의 prune 이 지웠다.
          // 다른 프로세스가 잠시 쥐고 있는 파일이면 이번에는 건너뛰고 다음 기동에 가져온다(지우지도 않는다)
          if ((error as NodeJS.ErrnoException).code === "ENOENT" || isWindowsBusy(error)) continue;
          throw error;
        }
        incoming.push(parseSnapshotFile(snapshotPath, raw));
        readPaths.push(snapshotPath);
      }
      const logged = parseLog(this.logPath, await readLog(this.logPath));
      const entriesByAt = new Map(
        logged.map((snapshot) => [snapshot.at, JSON.stringify(snapshot.entries)]),
      );
      const added: Snapshot[] = [];
      for (const snapshot of incoming.sort((a, b) => a.at - b.at)) {
        const entriesKey = JSON.stringify(snapshot.entries);
        let at = snapshot.at;
        let duplicate = false;
        for (let taken = entriesByAt.get(at); taken !== undefined; taken = entriesByAt.get(++at)) {
          if (taken === entriesKey) {
            duplicate = true;
            break;
          }
        }
        if (duplicate) continue;
        entriesByAt.set(at, entriesKey);
        added.push({ at, entries: snapshot.entries });
      }
      if (added.length > 0) {
        await writeFileAtomic(
          this.logPath,
          serializeSnapshots([...logged, ...added].sort((a, b) => a.at - b.at)),
        );
        this.cacheGeneration++;
        this.snapshotsCache = undefined;
        this.currentStateCache = undefined;
      }
      return readPaths;
    });
  }

  /**
   * 로그에 들어간 옛 형식 파일 지우기 — 백그라운드. 파일 수만 개를 지우는 데 수십 초가 걸려, 기다리면
   * 기록·열람이 그만큼 멈춘다. 가져온 뒤 새로 들어온 파일은 목록에 없어 다음 기동에 가져온다.
   * 실패는 알리지 않는다 — 남은 파일은 다음 기동의 가져오기가 중복으로 건너뛰고 다시 지운다.
   * 하나씩 차례로 지운다 — 한꺼번에 지우면(`fs.rm(recursive)` 등) libuv 스레드 풀을 다 차지해서
   * 그동안 같은 프로세스의 다른 파일 작업(적재·기록)이 밀린다(합성 7만 개 실측 14초).
   */
  private removeImportedFiles(filePaths: readonly string[]): void {
    if (filePaths.length === 0) return;
    void (async () => {
      for (const filePath of filePaths) await fs.rm(filePath, { force: true });
    })().catch(() => undefined);
  }

  /** 로그 작업을 대기열 끝에 넣는다. 앞 작업의 실패는 그 호출자가 받고, 뒤 작업을 막지 않는다. */
  private enqueueLogTask<T>(task: () => Promise<T>): Promise<T> {
    const run = this.logQueue.then(task);
    this.logQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * 스냅샷 하나를 로그에 덧붙인다 — 대기열 안에서만 부른다. 반환 = 실제로 기록한 스냅샷.
   * 매번 잠금 안에서 끝의 반쪽 줄부터 잘라낸다. 반쪽 줄은 어느 프로세스의 크래시나 쓰기 실패로도 생길 수 있고,
   * 잠금 아래에서는 쓰는 중인 다른 프로세스의 줄이 없으므로 반쪽 줄은 곧 잔재다.
   * at(스냅샷 식별자 — 트리 id 등)도 잠금 안에서 정한다. 로그 마지막 줄의 at 과 이 인스턴스의 마지막 값보다
   * 크게 정해, 두 창이 같은 ms 에 저장해도 저장소 안에서 유일하고 로그가 시각순이다.
   */
  private async appendSnapshot(entries: SnapshotEntry[]): Promise<Snapshot> {
    return await this.logLock.run(async () => {
      const lastLoggedAt = await prepareLogTail(this.logPath);
      const at = Math.max(Date.now(), (lastLoggedAt ?? 0) + 1, this.lastSavedAt + 1);
      const snapshot: Snapshot = { at, entries };
      await fs.appendFile(this.logPath, `${JSON.stringify(snapshot)}\n`);
      this.lastSavedAt = at;
      return snapshot;
    });
  }

  /** 내용을 content-addressed blob 으로 저장하고 해시를 반환. 같은 내용이 이미 있으면 참조만. */
  async saveBlob(content: Uint8Array): Promise<string> {
    const hash = hashOf(content);
    const blobPath = path.join(this.blobsDir, hash.slice(0, 2), hash.slice(2));
    if (await touchBlob(blobPath)) return hash; // 동일 내용 blob 존재 — 중복 저장 방지
    await fs.mkdir(path.dirname(blobPath), { recursive: true });
    const tempPath = `${blobPath}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      await fs.writeFile(tempPath, await deflateAsync(Buffer.from(content)));
      await linkBlob(tempPath, blobPath);
    } finally {
      await fs.rm(tempPath, { force: true }); // 크래시 잔재는 prune 의 .tmp- 정리가 지운다
    }
    return hash;
  }

  /**
   * 시점 복원용 상태 재생 (spec 저장 구조) — prefix 하위 경로별로 `at` 이전 마지막 항목을 모은다.
   * prefix "" = 워크스페이스 폴더 전체. 항목이 없는 경로 = 기록 없음(무변경 간주).
   */
  async stateAt(prefix: string, at: number): Promise<Map<string, string | null>> {
    const state = new Map<string, string | null>();
    for (const snapshot of await this.listSnapshots()) {
      if (snapshot.at > at) continue;
      for (const entry of snapshot.entries) {
        if (!isUnderPrefix(entry.path, prefix)) continue;
        if (!state.has(entry.path)) state.set(entry.path, entry.hash); // 최신순 — 첫 항목이 마지막 상태
      }
    }
    return state;
  }

  /**
   * 경로별 마지막 기록 상태 (전체) — 변경 판정의 기준. 값 null = 마지막 기록이 삭제.
   * 반환 맵은 캐시 그 자체이므로 수정하지 말 것.
   */
  async currentState(): Promise<ReadonlyMap<string, string | null>> {
    if (this.currentStateCache === undefined) {
      const generation = this.cacheGeneration;
      const state = await this.stateAt("", Number.MAX_SAFE_INTEGER);
      if (generation === this.cacheGeneration) this.currentStateCache = state;
      return state;
    }
    return this.currentStateCache;
  }

  /** blob 내용을 읽어 원본 바이트로 반환. */
  async readBlob(hash: string): Promise<Uint8Array> {
    const blobPath = path.join(this.blobsDir, hash.slice(0, 2), hash.slice(2));
    return await inflateAsync(await fs.readFile(blobPath));
  }

  private lastSavedAt = 0;

  async saveSnapshot(entries: SnapshotEntry[]): Promise<Snapshot> {
    return await this.enqueueLogTask(async () => {
      const snapshot = await this.appendSnapshot(entries);
      // 캐시 갱신도 대기열 안에서 — prune 의 캐시 설치와 순서가 뒤바뀌지 않게
      this.cacheGeneration++;
      this.snapshotsCache?.unshift(snapshot); // 로그의 어느 at 보다 크다 — 항상 최신이라 맨 앞 삽입
      if (this.currentStateCache !== undefined) {
        for (const entry of entries) this.currentStateCache.set(entry.path, entry.hash);
      }
      return snapshot;
    });
  }

  /**
   * 스냅샷·blob 정리 (spec 저장 구조 — prune, 기동 시 백그라운드).
   * - `cutoff` 이전 스냅샷 삭제 (보존 기한)
   * - 남은 스냅샷에서 `isExcluded` 에 걸리는 entry 제거(제외 규칙 변경의 소급 정리) — 빈 스냅샷은 삭제
   * - 남은 스냅샷이 참조하지 않는 blob 삭제
   */
  async prune(cutoff: number, isExcluded: (entryPath: string) => boolean): Promise<void> {
    // 로그 읽기 → 재작성은 대기열과 잠금 안에서 — 그 사이의 append(이 창이든 다른 창이든)가
    // 재작성에 덮여 사라지지 않게 뒤로 미룬다
    const referenced = await this.enqueueLogTask(() =>
      this.logLock.run(async () => {
        const kept: Snapshot[] = [];
        const keptHashes = new Set<string>();
        let mutated = false;
        for (const snapshot of parseLog(this.logPath, await readLog(this.logPath))) {
          const entries =
            snapshot.at < cutoff ? [] : snapshot.entries.filter((entry) => !isExcluded(entry.path));
          if (entries.length === 0) {
            mutated = true;
            continue;
          }
          if (entries.length === snapshot.entries.length) {
            kept.push(snapshot);
          } else {
            kept.push({ ...snapshot, entries });
            mutated = true;
          }
          for (const entry of entries) {
            if (entry.hash !== null) keptHashes.add(entry.hash);
          }
        }
        if (mutated) {
          await writeFileAtomic(this.logPath, serializeSnapshots(kept));
          this.cacheGeneration++;
          this.currentStateCache = undefined;
        }
        // 대기열 안에서 읽은 로그 = 디스크의 진실 — 다음 열람이 다시 적재하지 않게 그대로 캐시로 둔다
        if (mutated || this.snapshotsCache === undefined) this.snapshotsCache = newestFirst(kept);
        return keptHashes;
      }),
    );
    // 최근 blob 은 스냅샷 flush(debounce) 대기 중일 수 있다 — 1시간 이내 생성분은 참조 오판 방지로 보존.
    // 원자 쓰기 임시 파일(.tmp-*)도 같은 규칙으로 — 진행 중이면 최근이라 보존, 크래시 잔재면 정리된다.
    const recentGuard = Date.now() - 60 * 60 * 1000;
    for (const prefix of await fs.readdir(this.blobsDir)) {
      const prefixDir = path.join(this.blobsDir, prefix);
      for (const rest of await fs.readdir(prefixDir)) {
        if (referenced.has(`${prefix}${rest}`)) continue;
        await removeIfStale(path.join(prefixDir, rest), recentGuard);
      }
    }
    // 로그·색인의 임시 파일 잔재 — 정상 경로에서는 rename 으로 사라지므로 오래된 것은 크래시 잔재
    for (const name of await fs.readdir(this.storeDir)) {
      if (name.includes(".tmp-")) await removeIfStale(path.join(this.storeDir, name), recentGuard);
    }
  }

  private snapshotsLoading: Promise<Snapshot[]> | undefined;

  /** 전체 스냅샷 목록, 최신순 — 최초 접근 시 로그에서 적재 후 메모리 캐시. 동시 호출은 같은 적재를 기다린다. */
  async listSnapshots(): Promise<readonly Snapshot[]> {
    if (this.snapshotsCache !== undefined) return this.snapshotsCache;
    this.snapshotsLoading ??= this.enqueueLogTask(async () => {
      // 대기열 안 = 이 인스턴스의 쓰기와 겹치지 않는다. 앞선 prune 이 이미 캐시를 설치했으면 그것을 쓴다
      if (this.snapshotsCache === undefined) {
        // 읽기도 잠금 아래서 — Windows 는 열려 있는 파일을 rename 으로 덮지 못해(EPERM),
        // 다른 창이 읽는 동안 prune 의 다시 쓰기가 실패한다. 파싱은 잠금을 푼 뒤에 한다
        const bytes = await this.logLock.run(() => readLog(this.logPath));
        this.snapshotsCache = newestFirst(parseLog(this.logPath, bytes));
      }
      return this.snapshotsCache;
    }).finally(() => {
      this.snapshotsLoading = undefined;
    });
    return await this.snapshotsLoading;
  }
}

/** 옛 형식 스냅샷 파일 파싱 — 손상 시 어느 파일인지 드러낸다 (이전이 막히는 원인을 찾을 수 있게). */
function parseSnapshotFile(snapshotPath: string, raw: string): Snapshot {
  try {
    return JSON.parse(raw) as Snapshot;
  } catch (error) {
    throw new Error(
      `Corrupt snapshot file: ${snapshotPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** 로그 파일 내용. 없으면(아직 스냅샷이 없음) 빈 내용. */
async function readLog(logPath: string): Promise<Buffer> {
  try {
    return await fs.readFile(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

/**
 * 로그 → 스냅샷 목록(쓴 순서). 줄바꿈으로 끝나지 않은 마지막 줄은 크래시로 남은 반쪽 줄이라 버린다.
 * 줄마다 따로 디코딩한다 — 로그 전체를 문자열 하나로 만들면 V8 문자열 길이 상한(약 512MB)에 걸린다.
 * 손상된 줄은 어느 줄인지 드러낸다 (열람 전체가 막히는 원인을 찾을 수 있게).
 */
function parseLog(logPath: string, bytes: Buffer): Snapshot[] {
  const snapshots: Snapshot[] = [];
  let lineStart = 0;
  let lineNumber = 0;
  for (;;) {
    const lineEnd = bytes.indexOf(0x0a, lineStart);
    if (lineEnd < 0) break;
    lineNumber++;
    if (lineEnd > lineStart) {
      try {
        snapshots.push(JSON.parse(bytes.toString("utf8", lineStart, lineEnd)) as Snapshot);
      } catch (error) {
        throw new Error(
          `Corrupt snapshot log: ${logPath} line ${lineNumber} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    lineStart = lineEnd + 1;
  }
  return snapshots;
}

/** 쓴 순서(시각순) 목록 → 최신순 새 배열. 시계가 뒤로 간 세션의 줄도 시각순에 맞춘다(거의 정렬돼 있어 비용 미미). */
function newestFirst(snapshots: readonly Snapshot[]): Snapshot[] {
  return snapshots.toReversed().sort((a, b) => b.at - a.at);
}

/**
 * 스냅샷 목록 → 로그 내용. 약 1MB 단위 조각으로 내보낸다 —
 * 문자열 하나로 합치면 V8 문자열 길이 상한에 걸리고, 줄마다 쓰면 쓰기 호출이 스냅샷 수만큼 늘어난다.
 */
function* serializeSnapshots(snapshots: readonly Snapshot[]): Generator<string> {
  let chunk = "";
  for (const snapshot of snapshots) {
    chunk += `${JSON.stringify(snapshot)}\n`;
    if (chunk.length >= 1024 * 1024) {
      yield chunk;
      chunk = "";
    }
  }
  if (chunk.length > 0) yield chunk;
}

/**
 * append 준비 — `LogLock` 아래에서만 부른다. 로그 끝의 반쪽 줄(마지막 줄바꿈 뒤)을 잘라내고,
 * 마지막 완결 줄의 at 을 돌려준다(로그가 없거나 비었으면 undefined). 끝에서부터 거꾸로 읽는다.
 */
async function prepareLogTail(logPath: string): Promise<number | undefined> {
  let handle: FileHandle;
  try {
    handle = await fs.open(logPath, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; // 첫 append 가 만든다
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const keep = (await lastNewlineBefore(handle, size)) + 1; // 남길 길이 = 마지막 줄바꿈까지
    if (keep < size) await handle.truncate(keep);
    if (keep === 0) return undefined;
    const lineStart = (await lastNewlineBefore(handle, keep - 1)) + 1;
    const line = Buffer.alloc(keep - 1 - lineStart);
    await handle.read(line, 0, line.length, lineStart);
    try {
      return (JSON.parse(line.toString("utf8")) as Snapshot).at;
    } catch (error) {
      throw new Error(
        `Corrupt snapshot log: ${logPath} last line (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  } finally {
    await handle.close();
  }
}

/** `end` 앞에서 가장 가까운 줄바꿈의 위치. 없으면 -1. 끝에서부터 64KB 씩 거꾸로 읽는다. */
async function lastNewlineBefore(handle: FileHandle, end: number): Promise<number> {
  const chunk = Buffer.alloc(64 * 1024);
  for (let scanEnd = end; scanEnd > 0;) {
    const scanStart = Math.max(0, scanEnd - chunk.length);
    const { bytesRead } = await handle.read(chunk, 0, scanEnd - scanStart, scanStart);
    const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) return scanStart + newline;
    scanEnd = scanStart;
  }
  return -1;
}

/** 잠금 갱신 간격 — 잠금을 쥐고 있는 동안 잠금 파일 mtime 을 이 간격으로 갱신한다. */
const LOCK_HEARTBEAT_MS = 5_000;
/**
 * 잠금이 이만큼 갱신되지 않으면 죽은 잠금으로 본다 — 소유 pid 가 다른 프로세스에 재사용돼 살아 있는 것처럼
 * 보일 때의 안전망. 갱신 간격보다 크게 둬서, 확장 호스트가 잠시 바빠도 살아 있는 잠금을 빼앗지 않게 한다.
 */
const LOCK_STALE_MS = 60_000;
/** 회수 표식이 이만큼 오래되면 회수 도중 죽은 프로세스의 것이다 — 회수 자체는 수 ms 만에 끝난다. */
const LOCK_RECLAIM_ABANDONED_MS = 10_000;

/** 잠금 파일 내용 — 소유 프로세스와, 잠금마다 새로 만드는 일회용 token. */
interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

/**
 * 프로세스 사이 로그 잠금 — 배타 생성한 잠금 파일 하나.
 * - 잠금: 내용({pid, token})을 다 쓴 임시 파일을 잠금 경로로 hard link 한다. link 는 대상이 있으면 EEXIST 로
 *   실패하므로 배타 생성이고, 내용이 빈 잠금 파일을 다른 프로세스가 보는 일이 없다.
 * - 크래시 회수: 소유 pid 가 없거나 잠금이 LOCK_STALE_MS 동안 갱신되지 않았으면 죽은 잠금이다.
 *   회수는 그 token 의 회수 표식을 배타 생성한 프로세스 하나만 하고, 잠금 파일을 다시 읽어 같은 token 일 때만
 *   지운다. 그래서 두 프로세스가 동시에 회수해도 한쪽이 다른 쪽의 새 잠금을 지우지 않는다.
 * 재진입하지 않는다 — 잠금 안에서 다시 run 을 부르면 자기 자신을 기다린다.
 */
class LogLock {
  private readonly lockPath: string;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const token = await this.acquire();
    const heartbeat = setInterval(() => {
      const now = new Date();
      // 갱신 실패는 무시 — 한 번 놓쳐도 LOCK_STALE_MS 안에 다음 갱신이 있다
      fs.utimes(this.lockPath, now, now).catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    try {
      return await task();
    } finally {
      clearInterval(heartbeat);
      // 내 token 일 때만 지운다 — 멈춰 있던 사이 회수됐다면 지금 잠금은 남의 것이다
      // ("busy" = 누군가 이미 지우는 중 — 내가 지울 것이 없다)
      const current = await readLockOwner(this.lockPath);
      if (typeof current === "object" && current.owner.token === token) {
        await fs.rm(this.lockPath, { force: true });
      }
    }
  }

  private async acquire(): Promise<string> {
    const token = randomBytes(8).toString("hex");
    const tempPath = `${this.lockPath}.tmp-${token}`; // 크래시 잔재는 prune 의 .tmp- 정리가 지운다
    await fs.writeFile(tempPath, JSON.stringify({ pid: process.pid, token } satisfies LockOwner));
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.link(tempPath, this.lockPath);
          return token;
        } catch (error) {
          // EEXIST = 다른 잠금이 있다. busy = 지워지는 중인 잠금이 아직 이름을 차지한다(Windows)
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" && !isWindowsBusy(error)) {
            throw error;
          }
        }
        if (await this.reclaimIfStale()) continue;
        await delay(Math.min(200, 10 * 2 ** Math.min(attempt, 5)));
      }
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }

  /** 죽은 잠금이면 지운다. 반환 = 지금 다시 잠금을 시도할 만한가(잠금이 없어졌거나 지웠다). */
  private async reclaimIfStale(): Promise<boolean> {
    const lock = await readLockOwner(this.lockPath);
    if (lock === undefined) return true;
    if (lock === "busy") return false; // 지워지는 중 — 잠시 뒤 다시
    const stale = !isProcessAlive(lock.owner.pid) || lock.mtimeMs < Date.now() - LOCK_STALE_MS;
    if (!stale) return false;
    const markerPath = `${this.lockPath}.tmp-reclaim-${lock.owner.token}`;
    try {
      await (await fs.open(markerPath, "wx")).close();
    } catch (error) {
      if (isWindowsBusy(error)) return false; // 표식이 지워지는 중 — 잠시 뒤 다시
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // 다른 프로세스가 회수 중 — 그가 회수 도중 죽었으면 표식을 치워 다음 시도가 이어받게 한다
      try {
        await removeIfStale(markerPath, Date.now() - LOCK_RECLAIM_ABANDONED_MS);
      } catch (removeError) {
        if (!isWindowsBusy(removeError)) throw removeError;
      }
      return false;
    }
    try {
      // 표식을 쥐고 있는 동안 이 token 의 잠금을 지울 수 있는 것은 이 프로세스뿐이다.
      // 표식을 만들기 전에 다른 프로세스가 이미 회수해 새 잠금을 걸었을 수 있으니 다시 읽어 확인한다
      const current = await readLockOwner(this.lockPath);
      if (typeof current === "object" && current.owner.token === lock.owner.token) {
        await fs.rm(this.lockPath, { force: true });
      }
    } finally {
      await fs.rm(markerPath, { force: true });
    }
    return true;
  }
}

/**
 * 잠금 파일의 소유자와 마지막 갱신 시각. 잠금이 없으면 undefined.
 * "busy" = 다른 프로세스가 지우는 중이다(Windows 는 지워지는 중인 파인 파일을 열면 EPERM).
 * 내용을 읽을 수 없는 잠금(디스크 손상 등)은 pid 를 모르는 잠금으로 다룬다 — 갱신 시각으로만 회수된다.
 */
async function readLockOwner(
  lockPath: string,
): Promise<{ owner: LockOwner; mtimeMs: number } | "busy" | undefined> {
  let raw: string;
  let mtimeMs: number;
  try {
    [raw, { mtimeMs }] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (isWindowsBusy(error)) return "busy";
    throw error;
  }
  try {
    return { owner: JSON.parse(raw) as LockOwner, mtimeMs };
  } catch {
    return { owner: { pid: -1, token: `unreadable-${mtimeMs}` }, mtimeMs };
  }
}

/**
 * Windows 에서 다른 프로세스가 파일을 잠시 쥐고 있어서 나는 오류인가 — 열려 있는 파일 덮어쓰기, 지워지는 중인 파일 열기·
 * 같은 이름 만들기가 EPERM · EACCES · EBUSY 로 실패한다. 잠시 뒤 다시 하면 된다.
 */
function isWindowsBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** recentGuard 보다 오래된 파일만 삭제. 그 사이 사라진 파일(동시 진행 중인 원자 쓰기의 rename 등)은 없음이 진실이라 무시. */
async function removeIfStale(filePath: string, recentGuard: number): Promise<void> {
  try {
    if ((await fs.stat(filePath)).mtimeMs > recentGuard) return;
    await fs.rm(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * 원자 쓰기 — 임시 파일에 쓴 뒤 rename. 쓰기 도중 크래시·전원 차단이 나도 대상 파일은
 * "이전 내용 그대로" 아니면 "새 내용 전체" 둘 중 하나다 (잘린 JSON·blob·로그가 남지 않는다).
 */
async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array | Iterable<string>,
): Promise<void> {
  const tempPath = `${filePath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(tempPath, data);
    await renameWithRetry(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

/** rename · blob 게시 재시도 기한 — 열고 있는 쪽(백신 검사·색인기)이 파일을 닫기를 기다리는 시간. */
const RENAME_RETRY_MS = 10_000;

/**
 * blob 이 있으면 mtime 을 갱신하고 참을 반환한다. 없거나 지금 건드릴 수 없으면 거짓.
 * mtime 을 갱신해 두면, 동시 진행 중인 prune 이 아직 flush 전인 이 참조를
 * 미참조로 오판해도 recentGuard 가 삭제를 막는다.
 */
async function touchBlob(blobPath: string): Promise<boolean> {
  try {
    const now = new Date();
    await fs.utimes(blobPath, now, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * blob 게시 — 다 쓴 임시 파일을 blob 경로에 hard link 로 건다. blob 이 없을 때만 만들고, 있는 blob 은 덮지 않는다.
 * content-addressed 라 이미 있는 blob 은 같은 내용이다(EEXIST) — 게시가 끝난 것으로 보고 mtime 만 갱신한다.
 * rename 으로 덮어쓰면, 같은 내용을 동시에 저장하는 쪽(같은 창의 동시 이벤트 · 같은 저장소를 쓰는 다른 창)이
 * 막 게시한 blob 과 부딪친다. Windows 는 다른 쪽이 쥐고 있는 파일 위로 rename 하지 못한다(EPERM).
 * 지워지는 중인 blob(prune)이 이름을 차지하거나 백신 검사가 파일을 쥐고 있으면 기한 안에서 다시 시도한다.
 */
async function linkBlob(tempPath: string, blobPath: string): Promise<void> {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      await fs.link(tempPath, blobPath);
      return;
    } catch (error) {
      const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
      if (!exists && !isWindowsBusy(error)) throw error;
      // 있던 blob 이 갱신 직전에 사라졌으면(prune) 다음 시도의 link 가 새로 만든다
      if (exists && (await touchBlob(blobPath))) return;
      if (Date.now() >= deadline) throw error;
    }
    await delay(wait);
  }
}

/**
 * rename — Windows 에서는 다른 프로세스가 열고 있는 대상 파일을 덮지 못한다(EPERM · EACCES · EBUSY).
 * 이 확장의 프로세스끼리는 `LogLock` 으로 피하지만 백신 검사·색인기는 잠깐 열었다 닫으므로, 기한 안에서 다시 시도한다.
 */
async function renameWithRetry(fromPath: string, toPath: string): Promise<void> {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      await fs.rename(fromPath, toPath);
      return;
    } catch (error) {
      if (!isWindowsBusy(error) || Date.now() >= deadline) throw error;
    }
    await delay(wait);
  }
}

/** 스캔 가속 색인 항목 — 마지막으로 기록된 시점의 파일 메타데이터 (spec 스캔 트리거). */
export interface IndexEntry {
  readonly mtime: number;
  readonly size: number;
  readonly hash: string;
}

/** Show History 대상 — 저장소 + 워크스페이스 폴더 기준 상대 경로(구분자 `/`). */
export interface ResolvedTarget {
  readonly store: HistoryStore;
  readonly relPath: string;
}

/** 내용의 content-addressed 해시 — blob 저장 없이 현재 디스크 상태 비교용. */
export function hashOf(content: Uint8Array): string {
  return createHash("sha1").update(content).digest("hex");
}

/** 워크스페이스 폴더별 HistoryStore 를 만들어 캐시하고, uri → (store, relPath) 를 해석한다. */
export class WorkspaceStores {
  private readonly storageRoot: string;
  private readonly onError: (error: unknown) => void;
  private readonly stores = new Map<string, HistoryStore>();

  constructor(storageRoot: string, onError: (error: unknown) => void) {
    this.storageRoot = storageRoot;
    this.onError = onError;
  }

  async resolve(uri: vscode.Uri): Promise<ResolvedTarget | undefined> {
    if (uri.scheme !== "file") return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) return undefined;
    const folderKey = folder.uri.toString();
    let store = this.stores.get(folderKey);
    if (store === undefined) {
      store = new HistoryStore(this.storageRoot, folder.uri.fsPath, this.onError);
      // await 전에 등록 — 동시 resolve 가 폴더 하나에 인스턴스 2개를 만들면
      // 기록과 열람이 서로 다른 인스턴스(메모리 캐시)를 잡아 목록이 빈 채 고착된다
      this.stores.set(folderKey, store);
    }
    await store.init();
    const relPath = path.relative(folder.uri.fsPath, uri.fsPath).replaceAll("\\", "/");
    return { store, relPath };
  }

  /** 모든 store 의 색인을 지금 디스크에 쓴다 — deactivate 용. 하나가 실패해도 나머지는 쓰고, 실패는 모아 던진다. */
  async flushIndexes(): Promise<void> {
    const failures: unknown[] = [];
    for (const store of this.stores.values()) {
      try {
        await store.flushIndex();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Failed to save history indexes");
  }
}
