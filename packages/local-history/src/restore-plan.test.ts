import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChanges } from "./history-changes.ts";
import { emptiedFolderCandidates, planRestore, restorePaths } from "./restore-plan.ts";
import type { FileChange } from "./history-changes.ts";

// 복원 계획 (spec 「4. 복원」) — 파일마다 diff 의 왼쪽(직전) 상태로 놓는다.

const change = (fields: Partial<FileChange> & Pick<FileChange, "path">): FileChange => ({
  beforePath: fields.path,
  afterPath: fields.path,
  beforeHash: null,
  afterHash: null,
  kind: "modified",
  outside: null,
  ...fields,
});

const noUnsaved = new Set<string>();

test("직전에 있던 파일은 직전 내용으로, 직전에 없던 파일은 지운다 — 삭제됐던 파일은 되살아난다", () => {
  const changes = [
    change({ path: "a", beforeHash: "a1", afterHash: "a2" }),
    change({ path: "c", beforeHash: null, afterHash: "c1", kind: "added" }),
    change({ path: "d", beforeHash: "d1", afterHash: null, kind: "deleted" }),
  ];
  const current = new Map([
    ["a", "a2"],
    ["c", "c1"],
  ]);
  assert.deepEqual(planRestore(changes, "folder", current, noUnsaved), {
    writes: [
      { path: "a", hash: "a1" },
      { path: "c", hash: null },
      { path: "d", hash: "d1" },
    ],
    links: [],
    fileCount: 3,
    deletedCount: 1,
    outsideCount: 0,
    hasUnsaved: false,
  });
});

test("이미 직전 상태인 파일은 바뀌는 파일에 들지 않는다", () => {
  const changes = [
    change({ path: "a", beforeHash: "a1", afterHash: "a2" }),
    change({ path: "c", beforeHash: null, afterHash: "c1", kind: "added" }),
  ];
  const plan = planRestore(changes, "folder", new Map([["a", "a1"]]), noUnsaved);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.fileCount, 0);
  assert.equal(plan.deletedCount, 0);
});

test("미저장 편집이 있는 경로는 디스크가 직전 상태와 같아도 바뀐다 — 저장하면 달라진다", () => {
  const changes = [change({ path: "a", beforeHash: "a1", afterHash: "a2" })];
  const plan = planRestore(changes, "file", new Map([["a", "a1"]]), new Set(["a"]));
  assert.deepEqual(plan.writes, [{ path: "a", hash: "a1" }]);
  assert.equal(plan.fileCount, 1);
  assert.equal(plan.hasUnsaved, true);
});

test("파일 이력의 이름 변경은 지금 경로에 내용만 쓴다 — 옛 경로는 건드리지 않는다", () => {
  const changes = [
    change({
      path: "new",
      beforePath: "old",
      afterPath: "new",
      beforeHash: "h0",
      afterHash: "h1",
      kind: "renamed",
    }),
  ];
  assert.deepEqual(restorePaths(changes, "file"), ["new"]);
  const plan = planRestore(changes, "file", new Map([["new", "h1"]]), noUnsaved);
  assert.deepEqual(plan.writes, [{ path: "new", hash: "h0" }]);
  assert.deepEqual(plan.links, []);
  assert.equal(plan.fileCount, 1);
});

test("폴더 이력의 이름 변경은 옛 경로를 되살리고 새 경로를 지운다 — 파일 하나로 센다, 기록도 이름 변경이다", () => {
  // 기록기가 남기는 모양 그대로: 폴더 sub → sub2 이름 변경
  const snapshots = [
    {
      at: 2,
      entries: [
        { path: "p/sub/x", hash: null },
        { path: "p/sub2/x", hash: "x1", renamedFrom: "p/sub/x" },
      ],
    },
    { at: 1, entries: [{ path: "p/sub/x", hash: "x1" }] },
  ];
  const [changes] = computeChanges(snapshots, { kind: "folder", path: "p" }, [
    { fromAt: 2, toAt: 2 },
  ]);
  assert.deepEqual(restorePaths(changes, "folder"), ["p/sub/x", "p/sub2/x"]);
  const plan = planRestore(changes, "folder", new Map([["p/sub2/x", "x1"]]), noUnsaved);
  // 옛 경로 쓰기 바로 뒤에 새 경로 지우기 — 기록의 같은 창에 든다
  assert.deepEqual(plan.writes, [
    { path: "p/sub/x", hash: "x1" },
    { path: "p/sub2/x", hash: null },
  ]);
  assert.deepEqual(plan.links, [{ from: "p/sub2/x", to: "p/sub/x" }]);
  assert.equal(plan.fileCount, 1);
  assert.equal(plan.deletedCount, 0);
  assert.equal(plan.outsideCount, 0);
  // 새 경로가 이미 없으면(그 뒤에 지워짐) 되살리기만 한다 — 옮길 파일이 없으니 이름 변경이 아니다
  const revived = planRestore(changes, "folder", new Map(), noUnsaved);
  assert.deepEqual(revived.writes, [{ path: "p/sub/x", hash: "x1" }]);
  assert.deepEqual(revived.links, []);
});

test("폴더 경계를 넘은 이동도 되돌리고, 그 수를 센다", () => {
  // p/sub2 의 이력 — p/sub/x 가 들어왔다(옛 경로는 폴더 밖)
  const snapshots = [
    {
      at: 2,
      entries: [
        { path: "p/sub/x", hash: null },
        { path: "p/sub2/x", hash: "x1", renamedFrom: "p/sub/x" },
      ],
    },
    { at: 1, entries: [{ path: "p/sub/x", hash: "x1" }] },
  ];
  const [changes] = computeChanges(snapshots, { kind: "folder", path: "p/sub2" }, [
    { fromAt: 2, toAt: 2 },
  ]);
  const plan = planRestore(changes, "folder", new Map([["p/sub2/x", "x1"]]), noUnsaved);
  assert.deepEqual(plan.writes, [
    { path: "p/sub/x", hash: "x1" },
    { path: "p/sub2/x", hash: null },
  ]);
  assert.deepEqual(plan.links, [{ from: "p/sub2/x", to: "p/sub/x" }]);
  assert.equal(plan.fileCount, 1);
  assert.equal(plan.outsideCount, 1);
});

test("직전에 없던 파일의 이름 변경은 지워지는 파일로 센다", () => {
  const changes = [
    change({ path: "b", beforePath: "a", afterPath: "b", beforeHash: null, kind: "renamed" }),
  ];
  const plan = planRestore(changes, "folder", new Map([["b", "b1"]]), noUnsaved);
  assert.deepEqual(plan.writes, [{ path: "b", hash: null }]);
  assert.deepEqual(plan.links, []);
  assert.equal(plan.deletedCount, 1);
});

test("같은 경로의 상태가 겹치면 내용 쓰기가 지우기를 이긴다 — 그 경로의 직전 상태다", () => {
  // a → b 이름 변경 뒤 a 에 새 파일
  const snapshots = [
    {
      at: 2,
      entries: [
        { path: "p/a", hash: "new" },
        { path: "p/b", hash: "old", renamedFrom: "p/a" },
      ],
    },
    { at: 1, entries: [{ path: "p/a", hash: "old" }] },
  ];
  const [changes] = computeChanges(snapshots, { kind: "folder", path: "p" }, [
    { fromAt: 2, toAt: 2 },
  ]);
  assert.equal(changes.length, 2);
  const current = new Map([
    ["p/a", "new"],
    ["p/b", "old"],
  ]);
  const plan = planRestore(changes, "folder", current, noUnsaved);
  assert.deepEqual(plan.writes, [
    { path: "p/a", hash: "old" },
    { path: "p/b", hash: null },
  ]);
  assert.deepEqual(plan.links, [{ from: "p/b", to: "p/a" }]);
  assert.equal(plan.fileCount, 2);
  assert.equal(plan.deletedCount, 0);
});

test("비게 된 폴더 후보 — 지운 파일의 상위 폴더만, 깊은 것부터, 작업 폴더 루트 제외", () => {
  assert.deepEqual(emptiedFolderCandidates([]), []);
  assert.deepEqual(emptiedFolderCandidates(["top.txt"]), []);
  assert.deepEqual(emptiedFolderCandidates(["p/a/b/x", "p/c/y", "p/a/z"]), [
    "p/a/b",
    "p/a",
    "p/c",
    "p",
  ]);
  // 폴더 하나는 한 번만 — 같은 폴더의 파일을 여럿 지워도
  assert.deepEqual(emptiedFolderCandidates(["p/a/x", "p/a/y"]), ["p/a", "p"]);
});

test("두 파일을 맞바꾼 이름 변경은 양쪽 모두 이름 변경으로 되돌린다", () => {
  // a ↔ b 맞바꿈(a → t, b → a, t → b)
  const changes = [
    change({ path: "a", beforePath: "b", afterPath: "a", beforeHash: "B", afterHash: "B" }),
    change({ path: "b", beforePath: "a", afterPath: "b", beforeHash: "A", afterHash: "A" }),
  ].map((renamed) => ({ ...renamed, kind: "renamed" as const }));
  const current = new Map([
    ["a", "B"],
    ["b", "A"],
  ]);
  const plan = planRestore(changes, "folder", current, noUnsaved);
  assert.deepEqual(plan.writes, [
    { path: "b", hash: "B" },
    { path: "a", hash: "A" },
  ]);
  assert.deepEqual(plan.links, [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
  ]);
  assert.equal(plan.deletedCount, 0);
});
