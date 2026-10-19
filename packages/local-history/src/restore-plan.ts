import { parentPath } from "./rel-path.ts";
import type { FileChange, HistoryScope } from "./history-changes.ts";

// 복원 계획 (spec 「4. 복원」) — 고른 변경의 FileChange 를 경로별로 놓을 상태로 바꾸고, 지금 상태와 비교해
// 실제로 바뀌는 것을 센다. 직전 상태는 FileChange(diff 의 왼쪽) 그대로 쓴다 — 여기서 따로 계산하지 않는다.
// vscode 에 의존하지 않아 단위 테스트한다.

/** 경로 하나에 놓을 상태 — 해시 null = 그 경로에 파일이 없어야 한다. */
export interface PathState {
  readonly path: string;
  readonly hash: string | null;
}

/**
 * 항목 하나를 복원하면 놓이는 상태.
 * - 파일 이력: 그 파일의 지금 경로(`path`)에 직전 내용. 이름은 되돌리지 않는다.
 * - 폴더 이력의 이름 변경(폴더 경계를 넘은 이동 포함): 옛 경로에 직전 내용, 새 경로는 지운다.
 * - 그 밖: 그 경로에 직전 내용. 직전에 없던 파일(해시 null)은 지운다.
 */
export function statesOf(change: FileChange, scopeKind: HistoryScope["kind"]): PathState[] {
  if (scopeKind === "file" || change.beforePath === change.afterPath) {
    return [{ path: change.path, hash: change.beforeHash }];
  }
  return [
    { path: change.beforePath, hash: change.beforeHash },
    { path: change.afterPath, hash: null },
  ];
}

/** 복원이 건드릴 수 있는 경로 전부(중복 없이) — 지금 상태를 읽고, 미저장 편집을 찾고, 복원 직전 기록을 남길 경로. */
export function restorePaths(
  changes: readonly FileChange[],
  scopeKind: HistoryScope["kind"],
): string[] {
  return [
    ...new Set(changes.flatMap((change) => statesOf(change, scopeKind).map((state) => state.path))),
  ];
}

/**
 * 복원이 되돌리는 이름 변경 — `from`(지금 경로, 지워지거나 덮인다)의 내용이 `to`(옛 경로)로 돌아간다.
 * 기록도 이름 변경으로 남긴다 (spec 「3. 열람」 이름 변경은 항목 하나).
 */
export interface RenameLink {
  readonly from: string;
  readonly to: string;
}

/**
 * 복원이 지운 파일들의 상위 폴더 — 비게 됐으면 지울 후보다 (spec 「4. 복원」). 작업 폴더 루트("")는 빼고, 깊은 것부터다 —
 * 아래 폴더를 먼저 지워야 위 폴더가 비었는지 안다. 비지 않은 폴더의 위는 그 폴더를 담아 비지 않는다.
 * 지운 파일을 담았던 폴더만 후보라서, 복원 전부터 비어 있던 폴더는 후보가 되지 않는다.
 */
export function emptiedFolderCandidates(deletedPaths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const deleted of deletedPaths) {
    for (let folder = parentPath(deleted); folder !== ""; folder = parentPath(folder)) {
      folders.add(folder);
    }
  }
  return deepestFirst([...folders]);
}

/** 폴더 목록을 깊은 것부터 — 빈 폴더를 아래에서 위로 지울 순서. 같은 깊이는 주어진 순서대로. */
export function deepestFirst(folders: readonly string[]): string[] {
  const depth = (folder: string) => folder.split("/").length;
  return folders.toSorted((a, b) => depth(b) - depth(a));
}

export interface RestorePlan {
  /**
   * 쓸 상태 — 지금과 다른 경로만, 항목 순서대로. 이름 변경 항목은 `to` 다음에 `from` 이다(앞 항목이 이미 넣은
   * 경로는 그 자리에 있다) — 두 변경을 잇달아 써서 기록의 같은 창(debounce)에 들게 한다.
   */
  readonly writes: readonly PathState[];
  /** 되돌리는 이름 변경 — `to` 와 `from` 을 모두 쓴 뒤 기록기에 연결을 넘긴다. */
  readonly links: readonly RenameLink[];
  /** 실제로 바뀌는 파일(항목) 수 — 확인 창 · 진행 · 완료 알림의 N. 이름 변경은 항목 하나라 파일 하나다. */
  readonly fileCount: number;
  /** 바뀌는 파일 중 복원으로 없어지는 것 — 직전에 없던 파일. */
  readonly deletedCount: number;
  /** 바뀌는 파일 중 폴더 경계를 넘은 이동 — 되돌리면 폴더 밖 경로도 바뀐다. */
  readonly outsideCount: number;
  /** 바뀌는 경로에 미저장 편집이 있다 — 먼저 저장된다. */
  readonly hasUnsaved: boolean;
}

/**
 * 복원 계획. `current` = 경로별 지금 디스크 상태(해시, 없으면 null 또는 빠짐). `unsaved` = 미저장 편집이 있는 경로 —
 * 저장하면 디스크가 바뀌므로 지금 디스크와 같아도 바뀌는 것으로 센다.
 *
 * 같은 경로에 두 항목의 상태가 겹치면 내용 쓰기가 지우기를 이긴다. 예: a → b 이름 변경 뒤 a 에 새 파일이 생기면
 * 항목은 "b(a 에서 이름 변경)"와 "a(생성)"다. 둘 다 복원하면 a 는 새 파일이 지워지고 옛 내용이 돌아온다 —
 * 그 경로의 직전 상태다.
 */
export function planRestore(
  changes: readonly FileChange[],
  scopeKind: HistoryScope["kind"],
  current: ReadonlyMap<string, string | null>,
  unsaved: ReadonlySet<string>,
): RestorePlan {
  const itemStates = changes.map((change) => statesOf(change, scopeKind));
  const targets = new Map<string, string | null>();
  for (const state of itemStates.flat()) {
    if (!targets.has(state.path) || targets.get(state.path) === null) {
      targets.set(state.path, state.hash);
    }
  }
  const changing = new Set(
    [...targets]
      .filter(([path, hash]) => unsaved.has(path) || (current.get(path) ?? null) !== hash)
      .map(([path]) => path),
  );
  let fileCount = 0;
  let deletedCount = 0;
  let outsideCount = 0;
  const links: RenameLink[] = [];
  changes.forEach((change, index) => {
    const states = itemStates[index];
    if (!states.some((state) => changing.has(state.path))) return;
    fileCount++;
    if (states.every((state) => targets.get(state.path) === null)) deletedCount++;
    if (change.outside !== null) outsideCount++;
    // 이름 변경을 되돌린다 = 옛 경로에 이 항목의 직전 내용을 쓰고, 새 경로의 파일은 없앤다(지우거나 덮는다)
    const [before, after] = states;
    if (
      after !== undefined &&
      before.hash !== null &&
      targets.get(before.path) === before.hash &&
      changing.has(before.path) &&
      changing.has(after.path)
    ) {
      links.push({ from: after.path, to: before.path });
    }
  });
  return {
    // targets 의 넣은 순서 = 항목별 [옛 경로, 새 경로] (statesOf)
    writes: [...changing].map((path) => ({ path, hash: targets.get(path) ?? null })),
    links,
    fileCount,
    deletedCount,
    outsideCount,
    hasUnsaved: [...changing].some((path) => unsaved.has(path)),
  };
}
