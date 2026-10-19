import { computeChanges, listRows } from "./history-changes.ts";
import { baseName, compareTreeOrder, isUnderPrefix } from "./rel-path.ts";
import type { ChangeRange, FileChange, HistoryScope } from "./history-changes.ts";
import type { FileNode, FolderNode, RowNode } from "./history-tree.ts";
import type { Snapshot } from "./storage.ts";

// 목록에서 고른 것 → 열 비교 (spec 「3. 열람」 고르기와 diff), 복원할 것 (「4. 복원」). vscode 에 의존하지 않아 단위 테스트한다.
// 비교의 양쪽은 `computeChanges` 가 돌려준 FileChange 그대로다 — 복원이 같은 값을 써서
// "diff 의 왼쪽 = 복원 결과"가 되게 하려면, 여기서 직전 상태를 따로 계산하지 않는다.

/** 비교를 고를 수 있는 노드 — 더 보기는 클릭 명령만 가진 항목이라 뺀다. */
export type SelectableNode = RowNode | FolderNode | FileNode;

/** diff 한쪽에 보일 내용 — 그때의 경로와 blob 해시. 해시 null = 그때 없던 파일(빈 내용). */
export interface FileSide {
  readonly path: string;
  readonly hash: string | null;
}

interface ComparisonBase {
  /** 제목의 이름 — 고른 것의 이름(파일 이름 또는 폴더 이름). */
  readonly name: string;
  /** 비교하는 변경의 범위 — 제목에 시각으로 적는다. 줄 하나는 `fromAt === toAt` 다. */
  readonly range: ChangeRange;
  /** 바뀐 파일의 직전 ↔ 직후 — 이 순서로 보인다. 바뀐 파일이 없으면 빈다. */
  readonly changes: readonly FileChange[];
}

/**
 * 열 비교 하나. 바뀐 파일이 없어도 연다(spec 「3. 열람」) — 파일은 양쪽이 같은 diff, 폴더는 빈 다중 diff.
 * - "diff": 파일 하나의 내장 diff(`vscode.diff`). 양쪽은 `before` · `after` 다.
 * - "changes": 다중 파일 diff(`vscode.changes`). 항목은 `changes` 다.
 */
export type Comparison =
  | (ComparisonBase & {
      readonly view: "diff";
      readonly before: FileSide;
      readonly after: FileSide;
    })
  | (ComparisonBase & { readonly view: "changes" });

/** 선택을 풀어 낸 결과. */
export type SelectionResult =
  /** 줄 하나 또는 연속한 줄의 범위 — 비교는 `rangeComparison` 으로 구한다(스냅샷이 필요하다). */
  | { readonly kind: "range"; readonly range: ChangeRange }
  /** 한 줄 아래의 항목 — 고른 항목에 해당하는 파일만. */
  | { readonly kind: "items"; readonly comparison: Comparison }
  /** 허용하지 않는 선택 — 이 노드 하나만 남긴다(마지막으로 클릭한 노드). */
  | { readonly kind: "reselect"; readonly node: SelectableNode };

/**
 * 고른 노드 → 할 일.
 * - 선택된 줄의 아래 항목은 그 줄에 포함된 것으로 본다.
 *   근거(spec): 폴더 이력의 줄을 클릭하면 트리가 그 줄을 펼친다. 그 뒤 Shift 로 넓히면 펼쳐진 줄의 항목까지
 *   선택에 든다. 포함으로 보지 않으면 범위 선택이 동작하지 않는다.
 * - 줄만 남고 연속이면 범위다. 줄 하나는 길이 1인 범위다.
 * - 한 줄 아래의 항목만 골랐으면 그 항목의 파일이다.
 * - 그 밖(비연속 줄, 줄과 선택되지 않은 다른 줄의 항목, 다른 줄들의 항목)은 마지막으로 클릭한
 *   노드 하나로 되돌린다. 근거(spec): "고른 변경들만 합치기"는 상태 비교 구조로 표현할 수 없어 오해를 만든다.
 *
 * `previous` = 직전 선택(클릭한 노드를 가린다). `loadedRowAts` = 불러온 줄의 at(최신순, 연속 판정에 쓴다).
 * `targetName` = 이력 대상의 이름(여러 항목 비교의 제목에 쓴다).
 */
export function resolveSelection(
  selection: readonly SelectableNode[],
  previous: readonly SelectableNode[],
  loadedRowAts: readonly number[],
  targetName: string,
): SelectionResult | undefined {
  if (selection.length === 0) return undefined;
  const reselect = (): SelectionResult => ({
    kind: "reselect",
    node: lastClicked(selection, previous),
  });
  const rows = selection.filter((node): node is RowNode => node.kind === "row");
  const items = selection.filter((node): node is FolderNode | FileNode => node.kind !== "row");
  if (rows.length > 0) {
    const ats = [...new Set(rows.map((row) => row.snapshot.at))];
    // 선택된 줄의 항목은 그 줄에 포함 — 남는 항목은 선택되지 않은 줄의 것이다(섞기)
    if (items.some((item) => !ats.includes(item.row.snapshot.at))) return reselect();
    if (ats.length === 1) return { kind: "range", range: { fromAt: ats[0], toAt: ats[0] } };
    // 연속 판정 — 고른 줄이 불러온 줄 목록에서 빈틈 없는 구간이어야 한다
    const positions = ats.map((at) => loadedRowAts.indexOf(at));
    const newest = Math.min(...positions);
    const oldest = Math.max(...positions);
    if (positions.includes(-1) || oldest - newest + 1 !== positions.length) return reselect();
    return { kind: "range", range: { fromAt: loadedRowAts[oldest], toAt: loadedRowAts[newest] } };
  }
  const row = items[0].row;
  if (items.some((item) => item.row.snapshot.at !== row.snapshot.at)) return reselect(); // 다른 줄의 항목
  return { kind: "items", comparison: itemsComparison(row, items, targetName) };
}

/** 복원 버튼이 가리키는 것 — 범위(파일은 `rangeComparison` 으로 구한다) 또는 한 줄 아래의 항목. */
export type RestoreTarget = Extract<SelectionResult, { kind: "range" } | { kind: "items" }>;

/**
 * 복원 버튼을 누른 노드 → 복원할 것 (spec 「4. 복원」 대상은 사용자가 고른 것뿐이다).
 * 누른 노드가 선택 안에 있으면 선택을 `resolveSelection` 으로 풀어, 열린 diff 와 같은 것을 고른다.
 * - 줄의 버튼: 선택이 그 줄을 담은 범위면 그 범위, 아니면 그 줄 하나.
 * - 항목의 버튼: 선택이 한 줄 아래의 항목들이면 그 항목들, 아니면 그 항목 하나.
 *   줄까지 고른 선택(범위)에서 항목의 버튼을 누르면 그 항목 하나다 — 범위는 줄의 버튼이 맡는다.
 *
 * `selected` = VS Code 가 명령에 함께 넘긴 선택(누른 노드가 여러 개의 선택에 들 때만 온다).
 */
export function resolveRestoreTarget(
  clicked: SelectableNode,
  selected: readonly SelectableNode[],
  loadedRowAts: readonly number[],
  targetName: string,
): RestoreTarget {
  const key = nodeKey(clicked);
  const selection = selected.some((node) => nodeKey(node) === key) ? selected : [clicked];
  const result = resolveSelection(selection, [], loadedRowAts, targetName);
  if (clicked.kind === "row") {
    if (result?.kind === "range") return result;
    return { kind: "range", range: { fromAt: clicked.snapshot.at, toAt: clicked.snapshot.at } };
  }
  if (result?.kind === "items") return result;
  return { kind: "items", comparison: itemsComparison(clicked.row, [clicked], targetName) };
}

/**
 * 줄 하나 또는 범위의 비교 — 범위 시작 직전 ↔ 범위 끝 직후.
 * 파일 이력은 내장 diff, 폴더 이력은 다중 파일 diff(탐색기 순서)다.
 * `snapshots` = `HistoryStore.listSnapshots()`, `scope` · `targetName` = 이력 대상.
 */
export function rangeComparison(
  snapshots: readonly Snapshot[],
  scope: HistoryScope,
  targetName: string,
  range: ChangeRange,
): Comparison {
  const [changes] = computeChanges(snapshots, scope, [range]);
  if (scope.kind === "file") {
    const [change] = changes;
    if (change !== undefined) return fileComparison(targetName, range, change);
    // 범위 안에서 원래대로 돌아왔다 — 직전 = 직후(computeChanges 의 판정)이니 양쪽에 범위 끝의 상태를 보인다
    const side = fileStateAfter(snapshots, scope, range.toAt);
    return { name: targetName, range, changes, view: "diff", before: side, after: side };
  }
  return {
    name: targetName,
    range,
    changes: changes.toSorted((a, b) => compareTreeOrder(a.path, b.path)),
    view: "changes",
  };
}

/** 바뀐 파일 하나의 직전 · 직후 — FileChange 의 (beforePath, beforeHash) ↔ (afterPath, afterHash). */
function sidesOfChange(change: FileChange): { before: FileSide; after: FileSide } {
  return {
    before: { path: change.beforePath, hash: change.beforeHash },
    after: { path: change.afterPath, hash: change.afterHash },
  };
}

/** 바뀐 파일 하나의 내장 diff. */
function fileComparison(name: string, range: ChangeRange, change: FileChange): Comparison {
  return { name, range, changes: [change], view: "diff", ...sidesOfChange(change) };
}

/** 스냅샷에 적힌 `path` 의 상태 — 그 변경 직후의 내용이다. 적히지 않았으면 빈 내용. */
function stateIn(snapshot: Snapshot, path: string): FileSide {
  return { path, hash: snapshot.entries.find((entry) => entry.path === path)?.hash ?? null };
}

/**
 * 파일 이력에서 `at` 줄의 변경 직후 상태 — 그 줄의 경로(rename 체인)와 그 스냅샷에 적힌 해시.
 * 줄이 없으면(일어나지 않는다) 지금 경로의 빈 내용이다.
 */
function fileStateAfter(snapshots: readonly Snapshot[], scope: HistoryScope, at: number): FileSide {
  const row = listRows(snapshots, scope).find((candidate) => candidate.snapshot.at === at);
  return row === undefined
    ? { path: scope.path, hash: null }
    : stateIn(row.snapshot, row.pathAt ?? scope.path);
}

/** 노드 하나가 가리키는 변경의 시각과 직전 · 직후 (spec 「3. 열람」 기본 앱으로 열기). */
export interface ChangeSides {
  readonly at: number;
  readonly before: FileSide;
  readonly after: FileSide;
}

/**
 * 기본 앱으로 열 직전 · 직후 — 그 노드를 골랐을 때 diff 가 여는 양쪽과 같다.
 * 대상은 파일 이력의 줄과 폴더 이력의 파일 항목이다. 폴더 이력의 줄(`pathAt` 없음)은 undefined.
 * 파일 이력의 줄에 바뀐 내용이 없으면(직전 = 직후) diff 처럼 양쪽 모두 그 줄 직후의 상태다.
 */
export function changeSidesOf(node: RowNode | FileNode): ChangeSides | undefined {
  if (node.kind === "file") return { at: node.row.snapshot.at, ...sidesOfChange(node.change) };
  if (node.pathAt === undefined) return undefined;
  const [change] = node.changes;
  if (change !== undefined) return { at: node.snapshot.at, ...sidesOfChange(change) };
  const side = stateIn(node.snapshot, node.pathAt);
  return { at: node.snapshot.at, before: side, after: side };
}

/**
 * 노드의 `contextValue` — 메뉴의 `when`(package.json)이 본다. 노드 종류에, 기본 앱으로 열 내용이 있는 쪽을 덧붙인다.
 * 예: "row.before.after", "file.after"(생성 — 직전 없음), "file.before"(삭제 — 직후 없음), "row"(폴더 이력의 줄), "folder".
 */
export function contextValueOf(node: SelectableNode): string {
  if (node.kind === "folder") return "folder";
  const sides = changeSidesOf(node);
  if (sides === undefined) return node.kind;
  return `${node.kind}${sides.before.hash === null ? "" : ".before"}${sides.after.hash === null ? "" : ".after"}`;
}

/**
 * 한 줄 아래 항목의 비교 — 파일 항목 하나는 그 파일의 내장 diff, 폴더 항목은 그 아래 바뀐 파일의
 * 다중 파일 diff, 여러 항목은 고른 항목에 해당하는 파일만 담은 다중 파일 diff 다. 순서는 줄 아래 트리 순서다.
 */
function itemsComparison(
  row: RowNode,
  items: readonly (FolderNode | FileNode)[],
  targetName: string,
): Comparison {
  const range = { fromAt: row.snapshot.at, toAt: row.snapshot.at };
  const [only] = items;
  if (items.length === 1 && only.kind === "file") {
    return fileComparison(baseName(only.change.path), range, only.change);
  }
  const changes = row.changes.filter((change) =>
    items.some((item) =>
      item.kind === "file" ? item.change.path === change.path : isUnderPrefix(change.path, item.path),
    ),
  );
  const name = items.length === 1 && only.kind === "folder" ? baseName(only.path) : targetName;
  return { name, range, changes, view: "changes" };
}

/** 노드의 식별 — 목록을 다시 읽으면 노드 객체가 새로 만들어지므로 객체 대신 이 값으로 비교한다. */
function nodeKey(node: SelectableNode): string {
  switch (node.kind) {
    case "row":
      return String(node.snapshot.at);
    case "folder":
      return `${node.row.snapshot.at}#${node.path}/`;
    case "file":
      return `${node.row.snapshot.at}#${node.change.path}`;
  }
}

/**
 * 마지막으로 클릭한 노드. TreeView API 는 클릭한 노드를 알리지 않아, 직전 선택과 비교해 가린다.
 * 선택은 화면 순서로 온다.
 * - 새로 든 노드가 하나(Ctrl+클릭, Shift+↑↓): 그 노드.
 * - 여럿(Shift+클릭): 기준점은 직전 선택 쪽 끝에 있다. 그 반대쪽 끝이 클릭한 노드다.
 * - 없음(Ctrl+클릭으로 랼): 빠진 노드. Ctrl+클릭을 일반 클릭과 같게 다룬다.
 */
function lastClicked(
  selection: readonly SelectableNode[],
  previous: readonly SelectableNode[],
): SelectableNode {
  const previousKeys = new Set(previous.map(nodeKey));
  const added = selection.filter((node) => !previousKeys.has(nodeKey(node)));
  if (added.length === 1) return added[0];
  if (added.length > 1) {
    return previousKeys.has(nodeKey(selection[0])) ? selection.at(-1)! : selection[0];
  }
  const selectedKeys = new Set(selection.map(nodeKey));
  const removed = previous.filter((node) => !selectedKeys.has(nodeKey(node)));
  return removed.length === 1 ? removed[0] : selection.at(-1)!;
}
