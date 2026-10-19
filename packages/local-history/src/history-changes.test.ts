import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChanges, listRows } from "./history-changes.ts";
import type { ChangeRange, FileChange, HistoryScope } from "./history-changes.ts";
import type { Snapshot, SnapshotEntry } from "./storage.ts";

// 직전 ↔ 직후 계산 (spec 「3. 열람」·「4. 복원」) — 스냅샷은 오래된 것부터 적고 최신순으로 뒤집어 넣는다.

/** 오래된 것부터 적은 항목 목록 → 최신순 스냅샷(at = 1, 2, 3, …). */
function history(...changesets: SnapshotEntry[][]): Snapshot[] {
  return changesets.map((entries, index) => ({ at: index + 1, entries })).reverse();
}

const put = (path: string, hash: string, renamedFrom?: string): SnapshotEntry =>
  renamedFrom === undefined ? { path, hash } : { path, hash, renamedFrom };
const del = (path: string): SnapshotEntry => ({ path, hash: null });

const folder = (path: string): HistoryScope => ({ kind: "folder", path });
const file = (path: string): HistoryScope => ({ kind: "file", path });
const row = (at: number): ChangeRange => ({ fromAt: at, toAt: at });

/** 범위 하나의 결과를 경로순으로 — 반환 순서는 정해져 있지 않다. */
function changesOf(snapshots: Snapshot[], scope: HistoryScope, range: ChangeRange): FileChange[] {
  return computeChanges(snapshots, scope, [range])[0].toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
}

const change = (
  kind: FileChange["kind"],
  path: string,
  beforeHash: string | null,
  afterHash: string | null,
  paths: { beforePath?: string; afterPath?: string; outside?: FileChange["outside"] } = {},
): FileChange => ({
  path,
  beforePath: paths.beforePath ?? paths.afterPath ?? path,
  afterPath: paths.afterPath ?? path,
  beforeHash,
  afterHash,
  kind,
  outside: paths.outside ?? null,
});

test("폴더 줄 하나: 생성 · 수정 · 삭제를 직전 상태로 가른다", () => {
  const snapshots = history(
    [put("p/a", "a1"), put("p/c", "c1"), put("q/x", "x1")],
    [put("p/a", "a2"), put("p/b", "b1"), del("p/c"), put("q/x", "x2")],
  );
  assert.deepEqual(changesOf(snapshots, folder("p"), row(2)), [
    change("modified", "p/a", "a1", "a2"),
    change("added", "p/b", null, "b1"),
    change("deleted", "p/c", "c1", null),
  ]);
  // 폴더 "" = 워크스페이스 폴더 전체
  assert.equal(changesOf(snapshots, folder(""), row(2)).length, 4);
});

test("직전과 내용이 같은 항목은 변경이 아니다", () => {
  const snapshots = history([put("p/a", "a1")], [put("p/a", "a1"), put("p/b", "b1")]);
  assert.deepEqual(changesOf(snapshots, folder("p"), row(2)), [change("added", "p/b", null, "b1")]);
});

test("폴더 이름 변경: 새 경로 항목 하나, 직전은 옛 경로의 내용", () => {
  const snapshots = history([put("p/a", "h1")], [del("p/a"), put("p/b", "h1", "p/a")]);
  assert.deepEqual(changesOf(snapshots, folder("p"), row(2)), [
    change("renamed", "p/b", "h1", "h1", { beforePath: "p/a" }),
  ]);
});

test("옛 경로 삭제가 이른 스냅샷에 따로 적혀도 이름 변경의 직전은 옛 내용이다", () => {
  const snapshots = history([put("p/a", "h1")], [del("p/a")], [put("p/b", "h1", "p/a")]);
  assert.deepEqual(changesOf(snapshots, folder("p"), row(3)), [
    change("renamed", "p/b", "h1", "h1", { beforePath: "p/a" }),
  ]);
  // 두 줄을 덮는 범위도 같다 — 옛 경로 삭제는 흡수
  assert.deepEqual(changesOf(snapshots, folder("p"), { fromAt: 2, toAt: 3 }), [
    change("renamed", "p/b", "h1", "h1", { beforePath: "p/a" }),
  ]);
});

test("폴더 경계를 넘는 이동도 항목 하나다 — 나간 파일은 옛 경로 자리, 들어온 파일은 새 경로 자리", () => {
  const snapshots = history(
    [put("p/a", "h1"), put("q/x", "x1")],
    [put("p/a", "h2")],
    [del("p/a"), put("q/a", "h2", "p/a"), del("q/x"), put("p/x", "x1", "q/x")],
  );
  const changes = changesOf(snapshots, folder("p"), row(3));
  assert.deepEqual(changes, [
    change("renamed", "p/a", "h2", "h2", {
      beforePath: "p/a",
      afterPath: "q/a",
      outside: "after",
    }),
    change("renamed", "p/x", "x1", "x1", { beforePath: "q/x", outside: "before" }),
  ]);
  // 범위를 넓혀도 나간 파일의 직전은 범위 시작 직전의 옛 경로 내용이다
  assert.deepEqual(changesOf(snapshots, folder("p"), { fromAt: 2, toAt: 3 })[0], {
    ...changes[0],
    beforeHash: "h1",
    kind: "renamed",
  });
  // 바깥 폴더의 이력에서는 같은 이동이 반대 방향으로 보인다
  assert.deepEqual(
    changesOf(snapshots, folder("q"), row(3)).map((item) => [item.path, item.outside]),
    [
      ["q/a", "before"],
      ["q/x", "after"],
    ],
  );
});

test("폴더 밖으로 나갔다 범위 안에서 다시 들어오면 폴더 안의 이름 변경이다", () => {
  const snapshots = history(
    [put("p/a", "h1")],
    [del("p/a"), put("q/a", "h1", "p/a")],
    [del("q/a"), put("p/b", "h1", "q/a")],
  );
  assert.deepEqual(changesOf(snapshots, folder("p"), { fromAt: 2, toAt: 3 }), [
    change("renamed", "p/b", "h1", "h1", { beforePath: "p/a" }),
  ]);
});

test("폴더 밖으로 나간 뒤 삭제된 파일은 옛 경로의 삭제다", () => {
  const snapshots = history(
    [put("p/a", "h1")],
    [del("p/a"), put("q/a", "h1", "p/a")],
    [del("q/a")],
  );
  assert.deepEqual(changesOf(snapshots, folder("p"), { fromAt: 2, toAt: 3 }), [
    change("deleted", "p/a", "h1", null),
  ]);
});

test("범위 안의 이름 변경 사슬은 마지막 경로 항목 하나로 흡수된다", () => {
  const snapshots = history(
    [put("p/a", "h1")],
    [del("p/a"), put("p/b", "h1", "p/a")],
    [put("p/b", "h2")],
    [del("p/b"), put("p/c", "h2", "p/b")],
  );
  assert.deepEqual(changesOf(snapshots, folder("p"), { fromAt: 2, toAt: 4 }), [
    change("renamed", "p/c", "h1", "h2", { beforePath: "p/a" }),
  ]);
});

test("이름 변경 뒤 옛 경로에 새로 생긴 파일은 생성이다", () => {
  const snapshots = history(
    [put("p/a", "h1")],
    [del("p/a"), put("p/b", "h1", "p/a")],
    [put("p/a", "n1")],
  );
  assert.deepEqual(changesOf(snapshots, folder("p"), { fromAt: 2, toAt: 3 }), [
    change("added", "p/a", null, "n1"),
    change("renamed", "p/b", "h1", "h1", { beforePath: "p/a" }),
  ]);
});

test("삭제 뒤 같은 경로에 다시 생기면 그 경로의 직전과 비교한다", () => {
  const snapshots = history([put("p/a", "h1")], [del("p/a")], [put("p/a", "h2")]);
  assert.deepEqual(changesOf(snapshots, folder("p"), { fromAt: 2, toAt: 3 }), [
    change("modified", "p/a", "h1", "h2"),
  ]);
});

test("이름 변경의 옛 경로가 이전에 삭제됐다 다시 생긴 것이면 새 경로는 생성이다", () => {
  const snapshots = history(
    [put("p/a", "h1")],
    [del("p/a")],
    [put("p/a", "h2")],
    [del("p/a"), put("p/b", "h2", "p/a")],
  );
  assert.deepEqual(changesOf(snapshots, folder("p"), { fromAt: 2, toAt: 4 }), [
    change("deleted", "p/a", "h1", null),
    change("added", "p/b", null, "h2"),
  ]);
});

test("파일 이력: 줄 목록은 rename 체인을 잇고, 각 줄의 직후 경로는 그때의 경로다", () => {
  const snapshots = history(
    [put("old", "h1")],
    [put("old", "h2")],
    [del("old"), put("new", "h2", "old")],
    [put("new", "h3")],
  );
  assert.deepEqual(
    listRows(snapshots, file("new")).map((historyRow) => [
      historyRow.snapshot.at,
      historyRow.pathAt,
    ]),
    [
      [4, "new"],
      [3, "new"],
      [2, "old"],
      [1, "old"],
    ],
  );
  const [r4, r3, r2, r1] = computeChanges(snapshots, file("new"), [row(4), row(3), row(2), row(1)]);
  assert.deepEqual(r4, [change("modified", "new", "h2", "h3")]);
  assert.deepEqual(r3, [
    change("renamed", "new", "h2", "h2", { beforePath: "old", afterPath: "new" }),
  ]);
  assert.deepEqual(r2, [change("modified", "new", "h1", "h2", { afterPath: "old" })]);
  assert.deepEqual(r1, [change("added", "new", null, "h1", { afterPath: "old" })]);
  // 범위: 시작 직전은 옛 경로, 끝 직후는 새 경로
  assert.deepEqual(computeChanges(snapshots, file("new"), [{ fromAt: 2, toAt: 4 }])[0], [
    change("renamed", "new", "h1", "h3", { beforePath: "old", afterPath: "new" }),
  ]);
});

test("파일 이력: 범위 안에 대상 항목이 없으면 변경이 없다", () => {
  const snapshots = history([put("a", "h1")], [put("b", "x1")]);
  assert.deepEqual(computeChanges(snapshots, file("a"), [row(2)])[0], []);
});

test("여러 범위를 한 번에 구해도 범위마다 따로 구한 것과 같다", () => {
  const snapshots = history(
    [put("p/a", "a1"), put("p/b", "b1")],
    [put("p/a", "a2")],
    [put("q/x", "x1")],
    [put("p/b", "b2"), del("p/a")],
    [put("p/a", "a3")],
  );
  const ranges = [row(5), row(4), row(2), row(1), { fromAt: 2, toAt: 5 }];
  const together = computeChanges(snapshots, folder("p"), ranges);
  ranges.forEach((range, index) => {
    assert.deepEqual(together[index], computeChanges(snapshots, folder("p"), [range])[0]);
  });
  assert.deepEqual(
    together[4].toSorted((a, b) => a.path.localeCompare(b.path)),
    [change("modified", "p/a", "a1", "a3"), change("modified", "p/b", "b1", "b2")],
  );
});
