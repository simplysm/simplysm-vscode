import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupBlockRange,
  sectionEndIndex,
  expandHeader,
  computeLayout,
  moveLine,
  moveGroupBlock,
} from "./list-ops.ts";
import { isCollapsed, type GroupHeader, type TaskItem, type TaskLine } from "./tasks-model.ts";

// 리스트 재배치 순수 로직 (spec §4.4·§4.7) — 이동·그룹블록·삽입위치·펼침 계산
// 배열 identity 로 줄을 식별하므로 fixture 를 만들어 참조로 단언한다.

const item = (text: string): TaskItem => ({ text });
const header = (group: string, extra: Record<string, unknown> = {}): GroupHeader => ({
  group,
  ...extra,
});

test("groupBlockRange: 헤더 + 연속 소속 항목의 [시작,끝)", () => {
  const g = header("G");
  const lines: TaskLine[] = [item("a"), g, item("b"), item("c"), header("H"), item("d")];
  assert.deepEqual(groupBlockRange(lines, g), [1, 4]); // g(1) + b,c(2,3), H(4) 전까지
});

test("groupBlockRange: 마지막 그룹은 배열 끝까지, 빈 그룹은 헤더 다음까지", () => {
  const last = header("Last");
  const empty = header("Empty");
  const lines: TaskLine[] = [empty, last, item("x")];
  assert.deepEqual(groupBlockRange(lines, last), [1, 3]);
  assert.deepEqual(groupBlockRange(lines, empty), [0, 1]); // 바로 다음이 헤더 → 빈 그룹
});

test("sectionEndIndex: 미분류(null) = 첫 헤더 앞, 헤더 없으면 길이", () => {
  const g = header("G");
  assert.equal(sectionEndIndex([item("a"), item("b"), g, item("c")], null), 2);
  assert.equal(sectionEndIndex([item("a"), item("b")], null), 2); // 헤더 없음
});

test("sectionEndIndex: 그룹 = 그 블록 끝", () => {
  const g = header("G");
  const lines: TaskLine[] = [g, item("a"), item("b"), header("H")];
  assert.equal(sectionEndIndex(lines, g), 3); // g,a,b 다음(H 앞)
});

test("expandHeader: collapsed 만 제거, 미지 필드·group 보존", () => {
  const h = header("G", { collapsed: true, color: "red" });
  const out = expandHeader(h);
  assert.equal(isCollapsed(out), false);
  assert.equal(out.group, "G");
  assert.equal(out["color"], "red");
  assert.equal("collapsed" in out, false);
});

test("computeLayout: 미분류 항목 + 헤더 아래 소속 항목", () => {
  const g = header("G");
  const layout = computeLayout([item("a"), g, item("b"), item("c")]);
  assert.equal(layout.length, 2);
  assert.equal(layout[0]!.header, null);
  assert.deepEqual(
    layout[0]!.items.map((i) => i.text),
    ["a"],
  );
  assert.equal(layout[1]!.header, g);
  assert.deepEqual(
    layout[1]!.items.map((i) => i.text),
    ["b", "c"],
  );
});

test("computeLayout: 빈 파일도 미분류 섹션 1개", () => {
  const layout = computeLayout([]);
  assert.equal(layout.length, 1);
  assert.equal(layout[0]!.header, null);
  assert.equal(layout[0]!.items.length, 0);
});

test("moveLine: 아래로 한 칸, 순서만 바뀜", () => {
  const a = item("a");
  const b = item("b");
  const result = moveLine([a, b], a, 1);
  assert.notEqual(result, null);
  assert.deepEqual(result!.lines, [b, a]);
  assert.equal(result!.expanded, null);
});

test("moveLine: 목록 끝을 벗어나면 null(무동작)", () => {
  const a = item("a");
  const b = item("b");
  assert.equal(moveLine([a, b], a, -1), null); // 첫 항목 위로
  assert.equal(moveLine([a, b], b, 1), null); // 끝 항목 아래로
});

test("moveLine: 그룹 헤더를 넘으면 그 그룹 소속으로 진입", () => {
  const a = item("a");
  const g = header("G");
  // a, [G] 에서 a 를 아래로 → [G], a (a 가 G 소속)
  const result = moveLine([a, g], a, 1);
  assert.notEqual(result, null);
  assert.deepEqual(result!.lines, [g, a]);
});

test("moveLine: 접힌 그룹으로 진입하면 자동 펼침 + 재바인딩 정보 반환", () => {
  const a = item("a");
  const g = header("G", { collapsed: true });
  const result = moveLine([a, g], a, 1);
  assert.notEqual(result, null);
  // g 는 펼쳐진 새 헤더로 교체됨
  const movedHeader = result!.lines[0] as GroupHeader;
  assert.equal(isCollapsed(movedHeader), false);
  assert.equal(result!.expanded!.from, g);
  assert.equal(result!.expanded!.to, movedHeader);
  assert.equal((result!.lines[1] as TaskItem).text, "a");
});

test("moveGroupBlock: 뒤 그룹 아래로 통째 이동 (before=false)", () => {
  const g1 = header("G1");
  const g2 = header("G2");
  const lines: TaskLine[] = [g1, item("a"), g2, item("b")];
  // g1 블록을 g2 뒤로
  const out = moveGroupBlock(lines, g1, g2, false);
  assert.deepEqual(
    out.map((l) => ("group" in l ? `[${l.group}]` : (l as TaskItem).text)),
    ["[G2]", "b", "[G1]", "a"],
  );
});

test("moveGroupBlock: 앞 그룹 위로 통째 이동 (before=true)", () => {
  const g1 = header("G1");
  const g2 = header("G2");
  const lines: TaskLine[] = [g1, item("a"), g2, item("b")];
  // g2 블록을 g1 앞으로
  const out = moveGroupBlock(lines, g2, g1, true);
  assert.deepEqual(
    out.map((l) => ("group" in l ? `[${l.group}]` : (l as TaskItem).text)),
    ["[G2]", "b", "[G1]", "a"],
  );
});

test("moveGroupBlock: target=null 이면 첫 그룹 앞(미분류 뒤)으로", () => {
  const g1 = header("G1");
  const g2 = header("G2");
  const lines: TaskLine[] = [item("misc"), g1, item("a"), g2, item("b")];
  // g2 를 첫 그룹 앞으로 = 미분류(misc) 바로 뒤
  const out = moveGroupBlock(lines, g2, null, false);
  assert.deepEqual(
    out.map((l) => ("group" in l ? `[${l.group}]` : (l as TaskItem).text)),
    ["misc", "[G2]", "b", "[G1]", "a"],
  );
});
