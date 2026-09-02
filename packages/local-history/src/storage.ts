import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { deflate, inflate } from "node:zlib";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

/** 보존 기한 1년 (spec 확정) — 초과 스냅샷은 기동 시 백그라운드 prune. */
export const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

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
 * - snapshots/<at>.json : 체인지셋 매니페스트
 */
export class HistoryStore {
  private readonly blobsDir: string;
  private readonly snapshotsDir: string;
  private readonly indexPath: string;
  private index: Map<string, IndexEntry> | undefined;
  /** 스냅샷 목록 메모리 캐시(최신순) — 쓰기 주체가 이 인스턴스뿐이라 save/prune 때만 갱신하면 된다. */
  private snapshotsCache: Snapshot[] | undefined;
  /** 캐시 세대 — 적재 진행 중 prune·save 로 디스크가 바뀌면 올려서, 낡은 적재 결과가 캐시로 굳는 것을 막는다. */
  private cacheGeneration = 0;

  constructor(storageRoot: string, workspaceFolderPath: string) {
    const workspaceId = createHash("sha1").update(workspaceFolderPath).digest("hex");
    this.blobsDir = path.join(storageRoot, workspaceId, "blobs");
    this.snapshotsDir = path.join(storageRoot, workspaceId, "snapshots");
    this.indexPath = path.join(storageRoot, workspaceId, "index.json");
  }

  /** 스캔 비교 색인 (경로 → 마지막 기록 메타데이터) — 최초 접근 시 파일에서 적재. */
  async loadIndex(): Promise<ReadonlyMap<string, IndexEntry>> {
    if (this.index === undefined) {
      try {
        this.index = new Map(
          Object.entries(
            JSON.parse(await fs.readFile(this.indexPath, "utf8")) as Record<string, IndexEntry>,
          ),
        );
      } catch {
        this.index = new Map(); // 최초 실행 — 색인 없음
      }
    }
    return this.index;
  }

  /** 색인 항목 갱신(값 null = 삭제) 후 저장. */
  async updateIndex(updates: ReadonlyMap<string, IndexEntry | null>): Promise<void> {
    await this.loadIndex();
    const index = this.index!;
    for (const [entryPath, entry] of updates) {
      if (entry === null) index.delete(entryPath);
      else index.set(entryPath, entry);
    }
    await fs.writeFile(this.indexPath, JSON.stringify(Object.fromEntries(index)));
  }

  private initPromise: Promise<void> | undefined;

  /** 저장 디렉터리 생성 — 멱등. 동시 호출이 같은 1회 수행을 기다린다. */
  init(): Promise<void> {
    this.initPromise ??= (async () => {
      await fs.mkdir(this.blobsDir, { recursive: true });
      await fs.mkdir(this.snapshotsDir, { recursive: true });
    })();
    return this.initPromise;
  }

  /** 내용을 content-addressed blob 으로 저장하고 해시를 반환. 같은 내용이 이미 있으면 참조만. */
  async saveBlob(content: Uint8Array): Promise<string> {
    const hash = hashOf(content);
    const blobPath = path.join(this.blobsDir, hash.slice(0, 2), hash.slice(2));
    try {
      // 동일 내용 blob 존재 — 중복 저장 방지 (content-addressed).
      // mtime 을 갱신해 두면, 동시 진행 중인 prune 이 아직 flush 전인 이 참조를
      // 미참조로 오판해도 recentGuard 가 삭제를 막는다.
      const now = new Date();
      await fs.utimes(blobPath, now, now);
      return hash;
    } catch {
      // 없음 — 새로 저장
    }
    await fs.mkdir(path.dirname(blobPath), { recursive: true });
    await fs.writeFile(blobPath, await deflateAsync(Buffer.from(content)));
    return hash;
  }

    /**
   * 파일 시점 목록 (최신순) — rename 체인(`renamedFrom`)을 따라 과거 경로의 이력까지 잇는다.
   * 각 항목의 `path` = 그 시점에서의 경로.
   */
  async listFileSnapshots(relPath: string): Promise<FileSnapshotRef[]> {
    const refs: FileSnapshotRef[] = [];
    let chainPath = relPath;
    for (const snapshot of await this.listSnapshots()) {
      const entry = snapshot.entries.find((snapshotEntry) => snapshotEntry.path === chainPath);
      if (entry === undefined) continue;
      refs.push({ snapshot, path: chainPath });
      if (entry.renamedFrom !== undefined) chainPath = entry.renamedFrom;
    }
    return refs;
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

  /** blob 파일(압축) 크기 — diff 열람 상한 판정용. 압축 크기 ≤ 원본이라 보수적 판정. */
  async blobSize(hash: string): Promise<number> {
    const blobPath = path.join(this.blobsDir, hash.slice(0, 2), hash.slice(2));
    return (await fs.stat(blobPath)).size;
  }

  /** blob 내용을 읽어 원본 바이트로 반환. */
  async readBlob(hash: string): Promise<Uint8Array> {
    const blobPath = path.join(this.blobsDir, hash.slice(0, 2), hash.slice(2));
    return await inflateAsync(await fs.readFile(blobPath));
  }

  async saveSnapshot(entries: SnapshotEntry[]): Promise<Snapshot> {
    const snapshot: Snapshot = { at: Date.now(), entries };
    await fs.writeFile(
      path.join(this.snapshotsDir, `${snapshot.at}.json`),
      JSON.stringify(snapshot),
    );
    if (this.snapshotsCache !== undefined) {
      this.snapshotsCache.unshift(snapshot); // at = 현재 시각 — 항상 최신이라 맨 앞 삽입
    } else {
      this.cacheGeneration++; // 적재 진행 중이면 그 결과에 이 스냅샷이 빠져 있을 수 있음 — 설치 무효화
    }
    return snapshot;
  }

  /**
   * 스냅샷·blob 정리 (spec 저장 구조 — prune, 기동 시 백그라운드).
   * - `cutoff` 이전 스냅샷 삭제 (보존 기한)
   * - 남은 스냅샷에서 `isExcluded` 에 걸리는 entry 제거(제외 규칙 변경의 소급 정리) — 빈 스냅샷은 삭제
   * - 남은 스냅샷이 참조하지 않는 blob 삭제
   */
  async prune(cutoff: number, isExcluded: (entryPath: string) => boolean): Promise<void> {
    const referenced = new Set<string>();
    let mutated = false;
    for (const fileName of await fs.readdir(this.snapshotsDir)) {
      if (!fileName.endsWith(".json")) continue;
      const snapshotPath = path.join(this.snapshotsDir, fileName);
      const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as Snapshot;
      const kept =
        snapshot.at < cutoff ? [] : snapshot.entries.filter((entry) => !isExcluded(entry.path));
      if (kept.length === 0) {
        await fs.rm(snapshotPath);
        mutated = true;
        continue;
      }
      if (kept.length !== snapshot.entries.length) {
        await fs.writeFile(snapshotPath, JSON.stringify({ ...snapshot, entries: kept }));
        mutated = true;
      }
      for (const entry of kept) {
        if (entry.hash !== null) referenced.add(entry.hash);
      }
    }
    if (mutated) {
      this.cacheGeneration++; // 진행 중이던 적재 결과도 무효 — stale 설치 방지
      this.snapshotsCache = undefined; // 디스크가 진실 — 다음 접근 시 재적재
    }
    // 최근 blob 은 스냅샷 flush(debounce) 대기 중일 수 있다 — 1시간 이내 생성분은 참조 오판 방지로 보존
    const recentGuard = Date.now() - 60 * 60 * 1000;
    for (const prefix of await fs.readdir(this.blobsDir)) {
      const prefixDir = path.join(this.blobsDir, prefix);
      for (const rest of await fs.readdir(prefixDir)) {
        if (referenced.has(`${prefix}${rest}`)) continue;
        const blobPath = path.join(prefixDir, rest);
        if ((await fs.stat(blobPath)).mtimeMs > recentGuard) continue;
        await fs.rm(blobPath);
      }
    }
  }

  /** 전체 스냅샷 목록, 최신순 — 최초 접근 시 디스크에서 적재 후 메모리 캐시. */
  async listSnapshots(): Promise<readonly Snapshot[]> {
    if (this.snapshotsCache !== undefined) return this.snapshotsCache;
    const generation = this.cacheGeneration;
    const fileNames = await fs.readdir(this.snapshotsDir);
    // 순차 읽기 — 병렬(Promise.all)로 전부 열면 스냅샷 수천 개에서 EMFILE 발생
    const snapshots: Snapshot[] = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = await fs.readFile(path.join(this.snapshotsDir, fileName), "utf8");
      } catch (error) {
        // 적재 중 동시 prune 이 지운 파일 — 삭제가 진실이므로 건너뛴다
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      snapshots.push(JSON.parse(raw) as Snapshot);
    }
    snapshots.sort((a, b) => b.at - a.at);
    // 적재 중 디스크가 바뀌었으면(세대 변경) 이 결과를 캐시로 설치하지 않는다 — stale 고착 방지
    if (generation === this.cacheGeneration) this.snapshotsCache = snapshots;
    return snapshots;
  }
}

/** 스캔 비교 색인 항목 — 마지막으로 기록된 시점의 파일 메타데이터 (spec 스캔 트리거). */
export interface IndexEntry {
  readonly mtime: number;
  readonly size: number;
  readonly hash: string;
}

/** 파일 시점 참조 — `path` = 그 시점에서의 경로 (rename 체인 통과 결과). */
export interface FileSnapshotRef {
  readonly snapshot: Snapshot;
  readonly path: string;
}

/** Show History 대상 — 저장소 + 워크스페이스 폴더 기준 상대 경로(구분자 `/`). */
export interface ResolvedTarget {
  readonly store: HistoryStore;
  readonly relPath: string;
}

/** 경로가 prefix(폴더 상대 경로, "" = 전체) 하위인지 판정. */
export function isUnderPrefix(entryPath: string, prefix: string): boolean {
  return prefix === "" || entryPath === prefix || entryPath.startsWith(`${prefix}/`);
}

/** 내용의 content-addressed 해시 — blob 저장 없이 현재 디스크 상태 비교용. */
export function hashOf(content: Uint8Array): string {
  return createHash("sha1").update(content).digest("hex");
}

/** 워크스페이스 폴더별 HistoryStore 를 만들어 캐시하고, uri → (store, relPath) 를 해석한다. */
export class WorkspaceStores {
  private readonly storageRoot: string;
  private readonly stores = new Map<string, HistoryStore>();

  constructor(storageRoot: string) {
    this.storageRoot = storageRoot;
  }

  async resolve(uri: vscode.Uri): Promise<ResolvedTarget | undefined> {
    if (uri.scheme !== "file") return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) return undefined;
    const folderKey = folder.uri.toString();
    let store = this.stores.get(folderKey);
    if (store === undefined) {
      store = new HistoryStore(this.storageRoot, folder.uri.fsPath);
      // await 전에 등록 — 동시 resolve 가 폴더 하나에 인스턴스 2개를 만들면
      // 기록과 열람이 서로 다른 인스턴스(메모리 캐시)를 잡아 목록이 빈 채 고착된다
      this.stores.set(folderKey, store);
    }
    await store.init();
    const relPath = path.relative(folder.uri.fsPath, uri.fsPath).replaceAll("\\", "/");
    return { store, relPath };
  }
}
