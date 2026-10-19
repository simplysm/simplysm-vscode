import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLineCells, type LineCell } from "./line-cells.ts";

/** 텍스트를 칸 배열로 만든다. wide 에 든 글자는 2칸(앞 칸 + 폭 0 뒤 칸)을 차지한다. */
function cellsOf(characters: readonly string[], wide: ReadonlySet<string>): LineCell[] {
  return characters.flatMap((chars) =>
    wide.has(chars)
      ? [
          { chars, width: 2 },
          { chars: "", width: 0 },
        ]
      : [{ chars, width: 1 }],
  );
}

test("모두 좁은 글자면 텍스트 위치가 곧 칸 번호다", () => {
  const line = mapLineCells(cellsOf([..."see a.ts"], new Set()));
  assert.equal(line.text, "see a.ts");
  assert.deepEqual(line.columnRangeOf(4, 4), { startColumn: 5, endColumn: 8 });
});

test("앞에 한글이 있으면 그 글자 수만큼 칸이 밀린다", () => {
  const line = mapLineCells(cellsOf([..."바꿨습니다(a.ts)"], new Set("바꿨습니다")));
  assert.equal(line.text, "바꿨습니다(a.ts)");
  // "a.ts" 는 텍스트 6번째(0부터)지만, 화면에서는 한글 5자(10칸) + "(" 다음인 12번째 칸부터다.
  assert.deepEqual(line.columnRangeOf(6, 4), { startColumn: 12, endColumn: 15 });
});

test("끝 글자가 넓으면 구간이 그 글자의 뒤 칸까지 덮는다", () => {
  const line = mapLineCells(cellsOf([..."C:\\작업"], new Set("작업")));
  assert.deepEqual(line.columnRangeOf(0, 5), { startColumn: 1, endColumn: 7 });
});

test("두 코드 유닛 이모지는 두 코드 유닛 모두 같은 2칸에 놓인다", () => {
  const line = mapLineCells(cellsOf(["😀", " ", "a"], new Set(["😀"])));
  assert.equal(line.text, "😀 a");
  assert.deepEqual(line.columnRangeOf(0, 2), { startColumn: 1, endColumn: 2 });
  assert.deepEqual(line.columnRangeOf(3, 1), { startColumn: 4, endColumn: 4 });
});

test("결합 문자는 여러 코드 유닛이 한 칸에 놓인다", () => {
  const line = mapLineCells(cellsOf(["e\u0301", "a"], new Set()));
  assert.equal(line.text, "e\u0301a");
  assert.deepEqual(line.columnRangeOf(2, 1), { startColumn: 2, endColumn: 2 });
});

test("빈 칸은 공백으로 읽는다", () => {
  const line = mapLineCells([
    { chars: "a", width: 1 },
    { chars: "", width: 1 },
    { chars: "b", width: 1 },
  ]);
  assert.equal(line.text, "a b");
  assert.deepEqual(line.columnRangeOf(2, 1), { startColumn: 3, endColumn: 3 });
});
