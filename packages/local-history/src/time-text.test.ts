import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDateTimeIn, formatRangeIn, formatTimeIn, isSameDay } from "./time-text.ts";

// 시각 표기 규칙 (spec 「3. 열람」) — 로컬 시각대 기준이라 시각은 로컬 날짜로 만든다.

const local = (day: number, hours: number, minutes: number, seconds: number): number =>
  new Date(2026, 9, day, hours, minutes, seconds).getTime();

test("범위: 끝이 시작과 같은 날이면 끝은 시각만 적는다", () => {
  const from = local(18, 13, 0, 0);
  const to = local(18, 13, 5, 9);
  for (const language of ["en", "ko"]) {
    assert.deepEqual(formatRangeIn(language, from, to), [
      formatDateTimeIn(language, from),
      formatTimeIn(language, to),
    ]);
  }
  const [, englishTo] = formatRangeIn("en", from, to);
  assert.doesNotMatch(englishTo, /2026/);
  assert.match(englishTo, /^1:05:09\s?PM$/);
  const [koreanFrom, koreanTo] = formatRangeIn("ko", from, to);
  assert.match(koreanFrom, /^2026\. 10\. 18\. 오후 1:00:00$/);
  assert.equal(koreanTo, "오후 1:05:09");
});

test("범위: 날이 다르면 끝도 날짜까지 적는다 — 자정 경계 포함", () => {
  const from = local(17, 23, 59, 59);
  const to = local(18, 0, 0, 0);
  assert.equal(isSameDay(from, to), false);
  for (const language of ["en", "ko"]) {
    assert.deepEqual(formatRangeIn(language, from, to), [
      formatDateTimeIn(language, from),
      formatDateTimeIn(language, to),
    ]);
  }
  const [englishFrom, englishTo] = formatRangeIn("en", from, to);
  assert.match(englishFrom, /^10\/17\/2026, 11:59:59\s?PM$/);
  assert.match(englishTo, /^10\/18\/2026, 12:00:00\s?AM$/);
  assert.deepEqual(formatRangeIn("ko", from, to), [
    "2026. 10. 17. 오후 11:59:59",
    "2026. 10. 18. 오전 12:00:00",
  ]);
});

test("같은 날 판정은 로컬 날짜 기준이다", () => {
  assert.equal(isSameDay(local(18, 0, 0, 0), local(18, 23, 59, 59)), true);
  assert.equal(isSameDay(local(18, 23, 59, 59), local(19, 0, 0, 0)), false);
});
