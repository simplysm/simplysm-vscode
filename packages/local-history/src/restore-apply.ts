import { parentPath } from "./rel-path.ts";
import { deepestFirst, emptiedFolderCandidates } from "./restore-plan.ts";
import type { RenameLink, RestorePlan } from "./restore-plan.ts";

// 복원 계획을 디스크에 반영한다 (spec 「4. 복원」) — 파일 쓰기, 이름 변경 연결, 비게 된 폴더 정리,
// 쓰기가 도중에 실패하면 쓴 파일을 복원 직전 상태로 되돌리기. 디스크는 주입받아 vscode 없이 단위 테스트한다.

/** 복원이 쓰는 디스크 — 경로는 작업 폴더 기준. `restore.ts` 가 vscode.workspace.fs 로 구현한다. */
export interface RestoreDisk {
  /** 파일을 그 내용(blob 해시)으로 쓴다. 부모 폴더가 없으면 만든다. */
  writeFile(path: string, hash: string): Promise<void>;
  /** 파일을 지운다. 없으면 그대로 둔다. */
  deleteFile(path: string): Promise<void>;
  /** 지금 내용의 해시 — 없으면 null. */
  hashOf(path: string): Promise<string | null>;
  /** 그 경로에 뭔가(폴더) 있는가. */
  exists(path: string): Promise<boolean>;
  /** 폴더가 비었으면 지운다(비재귀). 없거나 비지 않으면 그대로 둔다. */
  removeFolderIfEmpty(path: string): Promise<void>;
}

export interface RestoreHooks {
  /** 되돌린 이름 변경의 두 경로를 다 썼다 — 기록기에 연결을 넘긴다. `fromHash` = `from` 에 쓴 상태(null = 지움). */
  link(link: RenameLink, fromHash: string | null, toHash: string): void;
  /** 복원 실패로 보지 않는 문제(폴더 지우기 실패) — 로그만 남긴다. */
  warn(message: string): void;
}

/**
 * 쓰기가 도중에 실패했다 — 쓴 파일을 되돌린 뒤 던진다. `cause` = 실패 원인.
 * `unrestored` = 복원 직전 상태로 되돌리지 못한 파일. 비었으면 파일은 바뀌지 않았다.
 */
export class RestoreWriteError extends Error {
  readonly unrestored: readonly string[];

  constructor(cause: unknown, unrestored: readonly string[]) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.unrestored = unrestored;
  }
}

/**
 * 계획대로 쓴다. `before` = 경로별 복원 직전 상태(복원 직전 기록에 남긴 것, blob 저장됨).
 * - 이름 변경: 두 경로를 다 쓴 곧바로 `hooks.link` — watcher 가 잡은 두 변경과 같은 기록 창에 들게.
 * - 다 쓰면 복원이 파일을 지워 비게 된 폴더를 지운다(위로 이어서).
 * - 쓰기가 실패하면 이미 쓴 파일과 실패한 파일을 `before` 상태로 되돌리고, 복원이 만든 폴더 중 비게 된 것을 지운 뒤
 *   `RestoreWriteError` 를 던진다. 근거(spec): 사용자는 복원이 실패하면 파일이 그대로일 것을 예상한다.
 */
export async function applyRestore(
  plan: RestorePlan,
  before: ReadonlyMap<string, string | null>,
  disk: RestoreDisk,
  hooks: RestoreHooks,
): Promise<void> {
  const written = new Map<string, string | null>(); // 쓴 경로 → 쓴 상태
  const deleted: string[] = [];
  const created: string[] = []; // 복원이 만든 폴더
  let links = plan.links;
  for (const write of plan.writes) {
    try {
      if (write.hash === null) {
        await disk.deleteFile(write.path);
        deleted.push(write.path);
      } else {
        created.push(...(await missingFolders(disk, write.path)));
        await disk.writeFile(write.path, write.hash);
      }
    } catch (error) {
      const unrestored = await putBack([...written.keys(), write.path], before, disk);
      await removeEmptyFolders(deepestFirst(created), disk, hooks);
      throw new RestoreWriteError(error, unrestored);
    }
    written.set(write.path, write.hash);
    links = links.filter((link) => {
      const toHash = written.get(link.to);
      if (toHash == null || !written.has(link.from)) return true;
      hooks.link(link, written.get(link.from) ?? null, toHash);
      return false;
    });
  }
  await removeEmptyFolders(emptiedFolderCandidates(deleted), disk, hooks);
}

/** 파일을 쓰면 새로 생길 상위 폴더 — 있는 폴더를 만날 때까지 위로. */
async function missingFolders(disk: RestoreDisk, path: string): Promise<string[]> {
  const missing: string[] = [];
  for (let folder = parentPath(path); folder !== ""; folder = parentPath(folder)) {
    if (await disk.exists(folder)) break;
    missing.push(folder);
  }
  return missing;
}

/**
 * 쓴 파일을 복원 직전 상태로 되돌린다 — 나중에 쓴 것부터. 이미 그 상태인 파일(예: 쓰기가 시작도 못한 읽기 전용 파일)은
 * 건드리지 않는다. 반환 = 되돌리지 못한 파일.
 */
async function putBack(
  paths: readonly string[],
  before: ReadonlyMap<string, string | null>,
  disk: RestoreDisk,
): Promise<string[]> {
  const unrestored: string[] = [];
  for (const path of paths.toReversed()) {
    const hash = before.get(path) ?? null;
    try {
      if ((await disk.hashOf(path)) === hash) continue;
      if (hash === null) await disk.deleteFile(path);
      else await disk.writeFile(path, hash);
    } catch {
      unrestored.push(path);
    }
  }
  return unrestored.toReversed();
}

/** 폴더를 차례로(깊은 것부터) 비었으면 지운다. 실패는 복원 실패가 아니다 — 로그만 남긴다. */
async function removeEmptyFolders(
  folders: readonly string[],
  disk: RestoreDisk,
  hooks: RestoreHooks,
): Promise<void> {
  for (const folder of folders) {
    try {
      await disk.removeFolderIfEmpty(folder);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      hooks.warn(`restore: could not remove emptied folder ${folder}: ${cause}`);
    }
  }
}
