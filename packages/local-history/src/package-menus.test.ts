import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// package.json 메뉴의 표시 조건 — 노드의 contextValue(`contextValueOf`)와 메뉴 `when` 의 정규식이 맞물리는지,
// 기본 앱으로 열기가 원격 작업과 명령 팔레트에서 숨는지 (spec 「3. 열람」 기본 앱으로 열기, 「4. 복원」).

interface MenuItem {
  readonly command: string;
  readonly when: string;
  readonly group?: string;
}

const manifest = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { contributes: { menus: Record<string, MenuItem[]> } };
const menus = manifest.contributes.menus;

const openBefore = "simplysm-local-history.openBeforeInDefaultApp";
const openAfter = "simplysm-local-history.openAfterInDefaultApp";
const restore = "simplysm-local-history.restore";

function itemMenu(command: string): MenuItem {
  const item = menus["view/item/context"].find((candidate) => candidate.command === command);
  assert.ok(item !== undefined, command);
  return item;
}

/** `when` 의 `viewItem =~ /…/` 정규식. */
function viewItemPattern(item: MenuItem): RegExp {
  const match = /viewItem =~ \/(.+?)\/(?= |$)/.exec(item.when);
  assert.ok(match !== null, item.when);
  return new RegExp(match[1]);
}

/** contextValue → 그 메뉴가 보이는가(기대값: 직전 열기, 직후 열기, 복원). */
const expected: Record<string, [boolean, boolean, boolean]> = {
  "row.before.after": [true, true, true],
  "row.before": [true, false, true],
  "row.after": [false, true, true],
  row: [false, false, true], // 폴더 이력의 줄
  "file.before.after": [true, true, true],
  "file.before": [true, false, true],
  "file.after": [false, true, true],
  folder: [false, false, true],
  more: [false, false, false],
};

test("기본 앱으로 열기 · 복원 메뉴는 contextValue 의 종류와 직전 · 직후 유무를 따른다", () => {
  const patterns = [openBefore, openAfter, restore].map((command) =>
    viewItemPattern(itemMenu(command)),
  );
  for (const [contextValue, shown] of Object.entries(expected)) {
    assert.deepEqual(
      patterns.map((pattern) => pattern.test(contextValue)),
      shown,
      contextValue,
    );
  }
});

test("기본 앱으로 열기는 우클릭 메뉴에만 있고, 원격 작업에서는 숨는다. 팔레트에는 없다", () => {
  for (const command of [openBefore, openAfter]) {
    const item = itemMenu(command);
    assert.match(item.when, /(^| )view == simplysm-local-history\.view( |$)/);
    assert.match(item.when, /(^| )!remoteName( |$)/);
    assert.notEqual(item.group, "inline");
    assert.deepEqual(
      menus["commandPalette"].filter((candidate) => candidate.command === command),
      [{ command, when: "false" }],
    );
  }
});
