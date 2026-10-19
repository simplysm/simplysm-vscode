import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChanges, listRows } from "./history-changes.ts";
import {
  changeSidesOf,
  contextValueOf,
  rangeComparison,
  resolveRestoreTarget,
  resolveSelection,
} from "./history-selection.ts";
import type { FileChange } from "./history-changes.ts";
import type { SelectableNode } from "./history-selection.ts";
import type { FileNode, FolderNode, RowNode } from "./history-tree.ts";
import type { Snapshot, SnapshotEntry } from "./storage.ts";

// 목록 선택 → 열 비교 (spec 「3. 열람」 고르기와 diff).

/** 불러온 줄의 at(최신순). */
const loaded = [5, 4, 3, 2, 1];

const modified = (path: string): FileChange => ({
  path,
  beforePath: path,
  afterPath: path,
  beforeHash: `${path}-before`,
  afterHash: `${path}-after`,
  kind: "modified",
  outside: null,
});

const row = (at: number, changes: readonly FileChange[] = []): RowNode => ({
  kind: "row",
  snapshot: { at, entries: [] },
  changes,
  showDate: false,
});
const file = (parent: RowNode, change: FileChange): FileNode => ({
  kind: "file",
  row: parent,
  parent,
  change,
});
const folder = (parent: RowNode, path: string): FolderNode => ({
  kind: "folder",
  row: parent,
  parent,
  path,
  children: [],
});

const resolve = (selection: SelectableNode[], previous: SelectableNode[] = []) =>
  resolveSelection(selection, previous, loaded, "p");

test("줄 하나는 길이 1인 범위다", () => {
  assert.deepEqual(resolve([row(3)]), { kind: "range", range: { fromAt: 3, toAt: 3 } });
});

test("연속한 줄은 범위다 — 시작 = 가장 이른 줄, 끝 = 가장 늦은 줄", () => {
  assert.deepEqual(resolve([row(4), row(3), row(2)], [row(4)]), {
    kind: "range",
    range: { fromAt: 2, toAt: 4 },
  });
});

test("비연속 줄은 마지막으로 클릭한 줄 하나로 되돌린다", () => {
  const row5 = row(5);
  const clicked = row(3);
  assert.deepEqual(resolve([row5, clicked], [row5]), { kind: "reselect", node: clicked });
  // Ctrl+클릭으로 중간 줄을 빼서 비연속이 되면 뺀 줄(클릭한 줄) 하나로
  const removed = row(4);
  assert.deepEqual(resolve([row(5), row(3)], [row(5), removed, row(3)]), {
    kind: "reselect",
    node: removed,
  });
});

test("선택된 줄의 항목은 그 줄에 포함된다 — 펼친 줄을 지나는 Shift 범위는 줄 범위다", () => {
  const row5 = row(5, [modified("p/a"), modified("p/b")]);
  const [a5, b5] = row5.changes.map((change) => file(row5, change));
  const sub5 = folder(row5, "p/sub");
  // 줄 5 클릭(펼쳐짐) → 줄 4 Shift+클릭: VS Code 가 줄 5 의 항목까지 선택에 넣는다
  assert.deepEqual(resolve([row5, sub5, a5, b5, row(4)], [row5]), {
    kind: "range",
    range: { fromAt: 4, toAt: 5 },
  });
  // 줄과 그 줄의 항목을 함께 고르면 그 줄 하나다
  assert.deepEqual(resolve([row5, a5], [row5]), {
    kind: "range",
    range: { fromAt: 5, toAt: 5 },
  });
  // 포함되어도 줄이 비연속이면 비연속 규칙을 따른다
  const row3 = row(3);
  assert.deepEqual(resolve([row5, a5, row3], [row5, a5]), { kind: "reselect", node: row3 });
});

test("줄과, 선택되지 않은 다른 줄의 항목을 섞으면 마지막으로 클릭한 노드 하나로 되돌린다", () => {
  const row5 = row(5);
  // Ctrl+클릭으로 다른 줄의 항목을 더함
  const item4 = file(row(4), modified("p/a"));
  assert.deepEqual(resolve([row5, item4], [row5]), { kind: "reselect", node: item4 });
  // Shift 범위가 줄 없이 고른 항목에서 시작하거나 끝남 — 클릭한 쪽은 기준점(직전 선택)의 반대쪽 끝
  const row6 = row(6, [modified("p/a"), modified("p/b")]);
  const [a6, b6] = row6.changes.map((change) => file(row6, change));
  const row4 = row(4);
  assert.deepEqual(resolve([a6, b6, row5, row4], [a6]), { kind: "reselect", node: row4 });
  assert.deepEqual(resolve([b6, row5, row4], [row4]), { kind: "reselect", node: b6 });
});

test("다른 줄의 항목을 섞으면 마지막으로 클릭한 항목 하나로 되돌린다", () => {
  const item5 = file(row(5), modified("p/a"));
  const item4 = folder(row(4), "p/sub");
  assert.deepEqual(resolve([item5, item4], [item5]), { kind: "reselect", node: item4 });
});

test("목록을 다시 읽어 노드 객체가 바뀌어도 같은 노드는 같게 본다", () => {
  // 직전 선택의 줄 5 와 지금 선택의 줄 5 는 다른 객체다 — 새로 든 것은 줄 3 하나다
  const clicked = row(3);
  assert.deepEqual(resolve([row(5), clicked], [row(5)]), { kind: "reselect", node: clicked });
});

test("파일 항목 하나는 그 파일의 내장 diff 다", () => {
  const change = modified("p/sub/c.txt");
  const parent = row(4, [change]);
  assert.deepEqual(resolve([file(parent, change)]), {
    kind: "items",
    comparison: {
      name: "c.txt",
      range: { fromAt: 4, toAt: 4 },
      changes: [change],
      view: "diff",
      before: { path: "p/sub/c.txt", hash: "p/sub/c.txt-before" },
      after: { path: "p/sub/c.txt", hash: "p/sub/c.txt-after" },
    },
  });
});

test("폴더 항목은 그 아래 바뀐 파일만 담은 다중 diff 다", () => {
  const [c, d, x, a] = ["p/sub/c", "p/sub/deep/d", "p/subway/x", "p/a"].map(modified);
  const parent = row(4, [c, d, x, a]);
  assert.deepEqual(resolve([folder(parent, "p/sub")]), {
    kind: "items",
    comparison: { name: "sub", range: { fromAt: 4, toAt: 4 }, changes: [c, d], view: "changes" },
  });
});

test("여러 항목은 고른 항목의 파일만 겹침 없이 줄 아래 순서로 담는다", () => {
  const [c, d, a, b] = ["p/sub/c", "p/sub/d", "p/a", "p/b"].map(modified);
  const parent = row(4, [c, d, a, b]);
  // 폴더 항목과 그 아래 파일 항목을 함께 골라도 파일은 한 번만
  const selection = [folder(parent, "p/sub"), file(parent, c), file(parent, b)];
  assert.deepEqual(resolve(selection), {
    kind: "items",
    comparison: { name: "p", range: { fromAt: 4, toAt: 4 }, changes: [c, d, b], view: "changes" },
  });
});

// 복원 버튼이 가리키는 것 (spec 「4. 복원」 대상은 사용자가 고른 것뿐이다)

const restoreOf = (clicked: SelectableNode, selected: SelectableNode[] = []) =>
  resolveRestoreTarget(clicked, selected, loaded, "p");

test("줄의 복원 버튼 — 그 줄을 담은 범위를 골랐으면 그 범위, 아니면 그 줄 하나", () => {
  assert.deepEqual(restoreOf(row(3)), { kind: "range", range: { fromAt: 3, toAt: 3 } });
  // 범위(펼친 줄의 항목 포함) 안의 줄
  const row4 = row(4, [modified("p/a")]);
  const a4 = file(row4, row4.changes[0]);
  assert.deepEqual(restoreOf(row(3), [row4, a4, row(3), row(2)]), {
    kind: "range",
    range: { fromAt: 2, toAt: 4 },
  });
  // 누른 줄이 선택에 없거나, 선택이 범위가 아니면 그 줄 하나
  assert.deepEqual(restoreOf(row(5), [row(3), row(2)]), {
    kind: "range",
    range: { fromAt: 5, toAt: 5 },
  });
  assert.deepEqual(restoreOf(row(5), [row(5), row(3)]), {
    kind: "range",
    range: { fromAt: 5, toAt: 5 },
  });
});

test("항목의 복원 버튼 — 한 줄의 항목들을 골랐으면 그 항목들, 아니면 그 항목 하나", () => {
  const [c, a, b] = ["p/sub/c", "p/a", "p/b"].map(modified);
  const parent = row(4, [c, a, b]);
  const [cItem, aItem, bItem] = [c, a, b].map((change) => file(parent, change));
  const one = (change: FileChange) => ({
    kind: "items",
    comparison: {
      name: change.path.slice(change.path.lastIndexOf("/") + 1),
      range: { fromAt: 4, toAt: 4 },
      changes: [change],
      view: "diff",
      before: { path: change.path, hash: change.beforeHash },
      after: { path: change.path, hash: change.afterHash },
    },
  });
  assert.deepEqual(restoreOf(aItem), one(a));
  // 같은 줄의 여러 항목 — 고른 파일들
  assert.deepEqual(restoreOf(bItem, [aItem, bItem]), {
    kind: "items",
    comparison: { name: "p", range: { fromAt: 4, toAt: 4 }, changes: [a, b], view: "changes" },
  });
  // 폴더 항목 — 그 아래 바뀐 파일 전부
  assert.deepEqual(restoreOf(folder(parent, "p/sub")), {
    kind: "items",
    comparison: { name: "sub", range: { fromAt: 4, toAt: 4 }, changes: [c], view: "changes" },
  });
  // 누른 항목이 선택에 없으면, 또는 줄까지 고른 선택이면 그 항목 하나
  assert.deepEqual(restoreOf(cItem, [aItem, bItem]), one(c));
  assert.deepEqual(restoreOf(aItem, [parent, cItem, aItem, bItem, row(3)]), one(a));
  // 다른 줄의 항목과 섞인 선택이면 그 항목 하나
  assert.deepEqual(restoreOf(aItem, [aItem, file(row(3), modified("p/x"))]), one(a));
});

/** 오래된 것부터 적은 항목 목록 → 최신순 스냅샷(at = 1, 2, 3, …). */
function history(...changesets: SnapshotEntry[][]): Snapshot[] {
  return changesets.map((entries, index) => ({ at: index + 1, entries })).reverse();
}

test("줄 · 범위의 비교는 computeChanges 의 직전 ↔ 직후 그대로다 — 폴더는 탐색기 순서", () => {
  const snapshots = history(
    [{ path: "p/b", hash: "b1" }],
    [
      { path: "p/b", hash: "b2" },
      { path: "p/sub/c", hash: "c1" },
      { path: "p/a", hash: "a1" },
    ],
  );
  const folderScope = { kind: "folder", path: "p" } as const;
  const range = { fromAt: 1, toAt: 2 };
  const comparison = rangeComparison(snapshots, folderScope, "p", range);
  assert.equal(comparison.view, "changes");
  assert.deepEqual(
    comparison.changes.map((change) => change.path),
    ["p/sub/c", "p/a", "p/b"],
  );
  const [computed] = computeChanges(snapshots, folderScope, [range]);
  assert.deepEqual(
    comparison.changes.toSorted((x, y) => x.path.localeCompare(y.path)),
    computed.toSorted((x, y) => x.path.localeCompare(y.path)),
  );
  // 파일 이력은 내장 diff — 범위 시작 직전(없음) ↔ 끝 직후
  assert.deepEqual(rangeComparison(snapshots, { kind: "file", path: "p/b" }, "b", range), {
    name: "b",
    range,
    changes: [
      {
        path: "p/b",
        beforePath: "p/b",
        afterPath: "p/b",
        beforeHash: null,
        afterHash: "b2",
        kind: "added",
        outside: null,
      },
    ],
    view: "diff",
    before: { path: "p/b", hash: null },
    after: { path: "p/b", hash: "b2" },
  });
});

test("범위 안에서 원래대로 돌아와도 비교를 연다 — 파일은 양쪽이 같은 diff, 폴더는 빈 다중 diff", () => {
  // old → new 이름 변경 뒤 내용이 h2 → h3 → h2 로 돌아옴
  const snapshots = history(
    [{ path: "p/old", hash: "h1" }],
    [{ path: "p/old", hash: null }, { path: "p/new", hash: "h2", renamedFrom: "p/old" }],
    [{ path: "p/new", hash: "h3" }],
    [{ path: "p/new", hash: "h2" }],
  );
  const range = { fromAt: 3, toAt: 4 };
  assert.deepEqual(rangeComparison(snapshots, { kind: "file", path: "p/new" }, "new", range), {
    name: "new",
    range,
    changes: [],
    view: "diff",
    before: { path: "p/new", hash: "h2" },
    after: { path: "p/new", hash: "h2" },
  });
  // 범위 끝의 경로는 rename 체인을 따른다 — 이름 변경 전의 줄이면 옛 경로
  const renamedLater = history(
    [{ path: "p/old", hash: "h1" }],
    [{ path: "p/old", hash: "h1" }],
    [{ path: "p/old", hash: null }, { path: "p/new", hash: "h1", renamedFrom: "p/old" }],
  );
  assert.deepEqual(
    rangeComparison(renamedLater, { kind: "file", path: "p/new" }, "new", { fromAt: 2, toAt: 2 }),
    {
      name: "new",
      range: { fromAt: 2, toAt: 2 },
      changes: [],
      view: "diff",
      before: { path: "p/old", hash: "h1" },
      after: { path: "p/old", hash: "h1" },
    },
  );
  assert.deepEqual(rangeComparison(snapshots, { kind: "folder", path: "p" }, "p", range), {
    name: "p",
    range,
    changes: [],
    view: "changes",
  });
});

/** 목록이 만드는 파일 이력의 줄 — history-tree 의 loadRows 와 같은 계산. */
function fileRows(snapshots: Snapshot[], path: string): RowNode[] {
  const scope = { kind: "file", path } as const;
  const rows = listRows(snapshots, scope);
  const changes = computeChanges(
    snapshots,
    scope,
    rows.map((candidate) => ({ fromAt: candidate.snapshot.at, toAt: candidate.snapshot.at })),
  );
  return rows.map((candidate, index) => ({
    kind: "row",
    snapshot: candidate.snapshot,
    pathAt: candidate.pathAt,
    changes: changes[index],
    showDate: false,
  }));
}

test("기본 앱으로 열 파일 이력 줄의 직전 · 직후는 그 줄의 diff 양쪽이다 — 내용이 없는 쪽은 메뉴에 없다", () => {
  // 생성 → 수정 → 이름 변경(확장자도 바뀜) → 바뀐 내용 없이 다시 기록 → 삭제
  const snapshots = history(
    [{ path: "p/old.txt", hash: "h1" }],
    [{ path: "p/old.txt", hash: "h2" }],
    [
      { path: "p/old.txt", hash: null },
      { path: "p/new.md", hash: "h2", renamedFrom: "p/old.txt" },
    ],
    [{ path: "p/new.md", hash: "h2" }],
    [{ path: "p/new.md", hash: null }],
  );
  const rows = fileRows(snapshots, "p/new.md");
  assert.deepEqual(
    rows.map((node) => node.snapshot.at),
    [5, 4, 3, 2, 1],
  );
  for (const node of rows) {
    const at = node.snapshot.at;
    const comparison = rangeComparison(snapshots, { kind: "file", path: "p/new.md" }, "new.md", {
      fromAt: at,
      toAt: at,
    });
    assert.equal(comparison.view, "diff");
    if (comparison.view !== "diff") continue;
    assert.deepEqual(changeSidesOf(node), {
      at,
      before: comparison.before,
      after: comparison.after,
    });
  }
  // 삭제(직후 없음) · 바뀐 내용 없음(양쪽 = 그 줄 직후) · 이름 변경 · 수정 · 생성(직전 없음)
  assert.deepEqual(rows.map(contextValueOf), [
    "row.before",
    "row.before.after",
    "row.before.after",
    "row.before.after",
    "row.after",
  ]);
  // 이름 변경의 직전은 옛 경로 — 사본의 이름 · 확장자가 그쪽 것이다
  assert.deepEqual(changeSidesOf(rows[2]), {
    at: 3,
    before: { path: "p/old.txt", hash: "h2" },
    after: { path: "p/new.md", hash: "h2" },
  });
  assert.deepEqual(changeSidesOf(rows[1]), {
    at: 4,
    before: { path: "p/new.md", hash: "h2" },
    after: { path: "p/new.md", hash: "h2" },
  });
});

test("기본 앱으로 열 폴더 이력 항목의 직전 · 직후 — 폴더 밖으로 나간 파일의 직후는 밖의 경로다. 폴더 줄 · 폴더 항목에는 없다", () => {
  const movedOut: FileChange = {
    path: "p/a.txt",
    beforePath: "p/a.txt",
    afterPath: "q/a.txt",
    beforeHash: "a1",
    afterHash: "a1",
    kind: "renamed",
    outside: "after",
  };
  const added: FileChange = { ...modified("p/n"), beforeHash: null, kind: "added" };
  const deleted: FileChange = { ...modified("p/d"), afterHash: null, kind: "deleted" };
  const folderRow = row(7, [movedOut, added, deleted, modified("p/m")]);
  const [outItem, addedItem, deletedItem, modifiedItem] = folderRow.changes.map((change) =>
    file(folderRow, change),
  );
  assert.deepEqual(changeSidesOf(outItem), {
    at: 7,
    before: { path: "p/a.txt", hash: "a1" },
    after: { path: "q/a.txt", hash: "a1" },
  });
  assert.equal(contextValueOf(outItem), "file.before.after");
  assert.equal(contextValueOf(addedItem), "file.after");
  assert.equal(contextValueOf(deletedItem), "file.before");
  assert.equal(contextValueOf(modifiedItem), "file.before.after");
  // 폴더 이력의 줄(pathAt 없음) · 폴더 항목은 기본 앱으로 열 것이 없다
  assert.equal(changeSidesOf(folderRow), undefined);
  assert.equal(contextValueOf(folderRow), "row");
  assert.equal(contextValueOf(folder(folderRow, "p/sub")), "folder");
});
