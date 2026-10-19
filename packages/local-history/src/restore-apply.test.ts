import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRestore, RestoreWriteError } from "./restore-apply.ts";
import { parentPath } from "./rel-path.ts";
import { planRestore } from "./restore-plan.ts";
import type { RestoreDisk } from "./restore-apply.ts";
import type { FileChange } from "./history-changes.ts";
import type { RenameLink } from "./restore-plan.ts";

// 복원 계획의 디스크 반영 (spec 「4. 복원」) — 비게 된 폴더 정리, 쓰기 도중 실패의 되돌리기.

/** 메모리 디스크 — 파일(경로 → 해시)과 폴더. 읽기 전용 파일 · 잠긴 폴더로 실패를 만든다. */
class MemoryDisk implements RestoreDisk {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  /** 쓰기 · 지우기가 실패하는 파일. */
  readonly readOnly = new Set<string>();
  /** 지우기가 실패하는 폴더. */
  readonly lockedFolders = new Set<string>();
  /** 일어난 일 — 순서 단언용. */
  readonly log: string[] = [];

  constructor(files: Record<string, string>, emptyFolders: readonly string[] = []) {
    for (const [path, hash] of Object.entries(files)) this.put(path, hash);
    for (const folder of emptyFolders) this.addFolders(folder);
  }

  private addFolders(folder: string): void {
    for (let current = folder; current !== ""; current = parentPath(current)) {
      this.folders.add(current);
    }
  }

  private put(path: string, hash: string): void {
    this.addFolders(parentPath(path));
    this.files.set(path, hash);
  }

  async writeFile(path: string, hash: string): Promise<void> {
    if (this.readOnly.has(path)) throw new Error(`EPERM: ${path}`);
    this.put(path, hash);
    this.log.push(`write ${path}=${hash}`);
  }

  async deleteFile(path: string): Promise<void> {
    if (this.readOnly.has(path)) throw new Error(`EPERM: ${path}`);
    this.files.delete(path);
    this.log.push(`delete ${path}`);
  }

  async hashOf(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async exists(path: string): Promise<boolean> {
    return this.folders.has(path) || this.files.has(path);
  }

  async removeFolderIfEmpty(path: string): Promise<void> {
    if (!this.folders.has(path)) return;
    const under = (entry: string) => entry.startsWith(`${path}/`);
    if ([...this.files.keys()].some(under) || [...this.folders].some(under)) return;
    if (this.lockedFolders.has(path)) throw new Error(`EBUSY: ${path}`);
    this.folders.delete(path);
    this.log.push(`rmdir ${path}`);
  }
}

const change = (fields: Partial<FileChange> & Pick<FileChange, "path">): FileChange => ({
  beforePath: fields.path,
  afterPath: fields.path,
  beforeHash: null,
  afterHash: null,
  kind: "modified",
  outside: null,
  ...fields,
});

/** 디스크의 지금 상태로 계획을 세우고 반영한다 — restore.ts 와 같은 순서. */
async function restore(
  disk: MemoryDisk,
  changes: readonly FileChange[],
): Promise<{ links: string[]; warnings: string[] }> {
  const before = new Map<string, string | null>();
  for (const item of changes) {
    for (const path of [item.path, item.beforePath, item.afterPath]) {
      before.set(path, disk.files.get(path) ?? null);
    }
  }
  const plan = planRestore(changes, "folder", before, new Set());
  const links: string[] = [];
  const warnings: string[] = [];
  await applyRestore(plan, before, disk, {
    link: (link: RenameLink, fromHash, toHash) => {
      links.push(`${link.from}(${fromHash}) -> ${link.to}(${toHash})`);
    },
    warn: (message) => warnings.push(message),
  });
  return { links, warnings };
}

test("복원이 파일을 지워 비게 된 폴더는 위로 이어서 지운다 — 비지 않은 폴더에서 멈추고, 복원 전부터 빈 폴더는 남는다", async () => {
  const disk = new MemoryDisk(
    {
      "p/new/deep/x": "x1", // 그 변경에서 생긴 파일 — new · deep 도 그때 생긴 폴더
      "p/keep/y": "y1", // 그 변경에서 생긴 파일 — keep 에는 원래 빈 폴더가 있다
      "p/a": "a1",
    },
    ["p/keep/empty-before", "p/also-empty"],
  );
  await restore(disk, [
    change({ path: "p/new/deep/x", afterHash: "x1", kind: "added" }),
    change({ path: "p/keep/y", afterHash: "y1", kind: "added" }),
  ]);
  assert.deepEqual([...disk.files.keys()], ["p/a"]);
  assert.equal(disk.folders.has("p/new"), false);
  assert.equal(disk.folders.has("p/new/deep"), false);
  // keep 은 원래 빈 폴더를 담고 있어 비지 않는다. 원래 빈 폴더들은 그대로
  assert.equal(disk.folders.has("p/keep"), true);
  assert.equal(disk.folders.has("p/keep/empty-before"), true);
  assert.equal(disk.folders.has("p/also-empty"), true);
  assert.equal(disk.folders.has("p"), true);
  assert.deepEqual(
    disk.log.filter((entry) => entry.startsWith("rmdir")),
    ["rmdir p/new/deep", "rmdir p/new"],
  );
});

test("폴더 이름 변경을 되돌리면 새 폴더가 남지 않고, 두 경로를 다 쓴 뒤 이름 변경을 잇는다", async () => {
  const disk = new MemoryDisk({ "p/renamed/x": "x1" });
  const { links } = await restore(disk, [
    change({
      path: "p/renamed/x",
      beforePath: "p/inner/x",
      afterPath: "p/renamed/x",
      beforeHash: "x1",
      afterHash: "x1",
      kind: "renamed",
    }),
  ]);
  assert.deepEqual([...disk.files], [["p/inner/x", "x1"]]);
  assert.equal(disk.folders.has("p/renamed"), false);
  assert.deepEqual(disk.log, ["write p/inner/x=x1", "delete p/renamed/x", "rmdir p/renamed"]);
  assert.deepEqual(links, ["p/renamed/x(null) -> p/inner/x(x1)"]);
});

test("폴더 지우기 실패는 복원 실패가 아니다 — 로그만 남긴다", async () => {
  const disk = new MemoryDisk({ "p/new/x": "x1", "p/a": "a1" });
  disk.lockedFolders.add("p/new");
  const { warnings } = await restore(disk, [
    change({ path: "p/new/x", afterHash: "x1", kind: "added" }),
  ]);
  assert.equal(disk.files.has("p/new/x"), false);
  assert.equal(disk.folders.has("p/new"), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /p\/new: EBUSY/);
});

test("쓰기가 도중에 실패하면 쓴 파일을 복원 직전 상태로 되돌리고, 복원이 만든 빈 폴더를 지운 뒤 던진다", async () => {
  const disk = new MemoryDisk({ "p/a": "a2", "p/c": "c1", "p/z": "z2" }, ["p/empty-before"]);
  disk.readOnly.add("p/z"); // 뒤쪽 파일 — 쓰기가 시작도 못 하고 실패
  const changes = [
    change({ path: "p/a", beforeHash: "a1", afterHash: "a2" }), // 수정 → 되돌림
    change({ path: "p/c", afterHash: "c1", kind: "added" }), // 생성 → 지움
    change({ path: "p/d/deep/e", beforeHash: "e1", kind: "deleted" }), // 삭제(폴더째) → 되살림
    change({ path: "p/z", beforeHash: "z1", afterHash: "z2" }),
  ];
  await assert.rejects(restore(disk, changes), (error: unknown) => {
    assert.ok(error instanceof RestoreWriteError);
    assert.deepEqual(error.unrestored, []);
    assert.equal(error.message, "EPERM: p/z");
    return true;
  });
  // 파일은 복원 전 그대로, 복원이 만든 폴더(p/d, p/d/deep)는 지워지고 원래 빈 폴더는 남는다
  assert.deepEqual([...disk.files].toSorted(), [
    ["p/a", "a2"],
    ["p/c", "c1"],
    ["p/z", "z2"],
  ]);
  assert.equal(disk.folders.has("p/d"), false);
  assert.equal(disk.folders.has("p/d/deep"), false);
  assert.equal(disk.folders.has("p/empty-before"), true);
  // 나중에 쓴 것부터 되돌린다 — 실패한 파일(p/z)은 이미 그 상태라 건드리지 않는다
  assert.deepEqual(disk.log, [
    "write p/a=a1",
    "delete p/c",
    "write p/d/deep/e=e1",
    "delete p/d/deep/e",
    "write p/c=c1",
    "write p/a=a2",
    "rmdir p/d/deep",
    "rmdir p/d",
  ]);
});

test("되돌리기도 실패하면 되돌리지 못한 파일을 담아 던진다 — 나머지는 되돌린다", async () => {
  const disk = new MemoryDisk({ "p/a": "a2", "p/b": "b2", "p/z": "z2" });
  disk.readOnly.add("p/z");
  // p/b 는 쓴 뒤 잠긴다(다른 프로세스가 연 상황) — 되돌리기 쓰기가 실패한다
  const write = disk.writeFile.bind(disk);
  disk.writeFile = async (path, hash) => {
    await write(path, hash);
    if (path === "p/b") disk.readOnly.add("p/b");
  };
  const changes = [
    change({ path: "p/a", beforeHash: "a1", afterHash: "a2" }),
    change({ path: "p/b", beforeHash: "b1", afterHash: "b2" }),
    change({ path: "p/z", beforeHash: "z1", afterHash: "z2" }),
  ];
  await assert.rejects(restore(disk, changes), (error: unknown) => {
    assert.ok(error instanceof RestoreWriteError);
    assert.deepEqual(error.unrestored, ["p/b"]);
    return true;
  });
  assert.equal(disk.files.get("p/a"), "a2");
  assert.equal(disk.files.get("p/b"), "b1");
  assert.equal(disk.files.get("p/z"), "z2");
});
