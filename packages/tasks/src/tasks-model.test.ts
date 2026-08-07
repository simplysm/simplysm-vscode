import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTasksFile,
  serializeTaskLines,
  isGroupHeader,
  isCollapsed,
  type TaskLine,
} from "./tasks-model.ts";

// tasks 파일 모델 (spec §4.1) — JSONL 파싱↔직렬화·항목·그룹 헤더·알 수 없는 필드 보존·깨진 줄 오류

test("파싱: 줄 단위 JSON → 줄 목록 (순서 = 파일 줄 순서)", () => {
  const result = parseTasksFile('{"text":"a"}\n{"text":"b"}\n');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.lines.map((l) => l["text"]),
      ["a", "b"],
    );
  }
});

test("빈 파일·공백뿐인 파일 = 항목 0개 (정상)", () => {
  for (const content of ["", "\n", "   \n  \n"]) {
    const result = parseTasksFile(content);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.lines.length, 0);
  }
});

test("공백만인 줄: 무시하되 직렬화 시 재생성 안 함", () => {
  const result = parseTasksFile('{"text":"a"}\n   \n{"text":"b"}\n');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.lines.length, 2);
    assert.equal(serializeTaskLines(result.lines), '{"text":"a"}\n{"text":"b"}\n');
  }
});

test("알 수 없는 필드: 파싱↔직렬화 왕복에서 보존·되쓰기", () => {
  const source = '{"text":"a","status":"doing","n":1}\n';
  const result = parseTasksFile(source);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(serializeTaskLines(result.lines), source);
  }
});

test("여러 줄 text: \\n 이 JSON 이스케이프로 담겨 1항목 1물리줄 유지", () => {
  const lines: TaskLine[] = [{ text: "line1\nline2" }];
  const serialized = serializeTaskLines(lines);
  assert.equal(serialized.split("\n").length - 1, 1); // 물리줄 1개(마지막 개행)
  const result = parseTasksFile(serialized);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.lines[0]!["text"], "line1\nline2");
});

test("빈 문자열 text: 유효 항목", () => {
  const result = parseTasksFile('{"text":""}\n');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.lines[0]!["text"], "");
});

test("파싱 불가 줄: 오류(줄 번호 포함) — 부분 성공 없음", () => {
  const result = parseTasksFile('{"text":"a"}\nnot-json\n{"text":"b"}\n');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.line, 2);
});

test("JSON 유효하나 객체 아님 → 파싱 불가 오류", () => {
  for (const bad of ['"str"', "123", "[1,2]", "null", "true"]) {
    const result = parseTasksFile(`{"text":"a"}\n${bad}\n`);
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.equal(result.line, 2);
  }
});

test("text 가 문자열 아님·없음 → 파싱 불가 오류", () => {
  for (const bad of ['{"text":1}', '{"text":null}', '{"other":"x"}']) {
    const result = parseTasksFile(`${bad}\n`);
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.equal(result.line, 1);
  }
});

test("CRLF 파일: 관용 파싱, 저장 시 LF 로 정규화 (항목 데이터 불변)", () => {
  const result = parseTasksFile('{"text":"a"}\r\n{"text":"b"}\r\n');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.lines.map((l) => l["text"]),
      ["a", "b"],
    );
    assert.equal(serializeTaskLines(result.lines), '{"text":"a"}\n{"text":"b"}\n');
  }
});

test("직렬화: 파일은 항상 개행으로 끝남 (항목 0개면 빈 문자열)", () => {
  assert.equal(serializeTaskLines([{ text: "a" }]), '{"text":"a"}\n');
  assert.equal(serializeTaskLines([]), "");
});

test("마지막 줄 개행 없음: 정상 파싱", () => {
  const result = parseTasksFile('{"text":"a"}\n{"text":"b"}');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.lines.length, 2);
});

// --- 그룹 헤더 (spec §6.2·§4.7) ---

test("그룹 헤더 줄: group 필드 존재 = 헤더, 항목과 순서 섞여 보존", () => {
  const source = '{"text":"a"}\n{"group":"G"}\n{"text":"b"}\n';
  const result = parseTasksFile(source);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.lines.map(isGroupHeader), [false, true, false]);
    assert.equal(serializeTaskLines(result.lines), source);
  }
});

test("그룹 헤더: collapsed·알 수 없는 필드 왕복 보존", () => {
  const source = '{"group":"G","collapsed":true,"color":"red"}\n';
  const result = parseTasksFile(source);
  assert.equal(result.ok, true);
  if (result.ok) {
    const header = result.lines[0]!;
    assert.equal(isGroupHeader(header), true);
    if (isGroupHeader(header)) assert.equal(isCollapsed(header), true);
    assert.equal(serializeTaskLines(result.lines), source);
  }
});

test("collapsed: true 만 접힘 — 비boolean 등 그 외 값은 펼침 취급, 파싱 오류 아님 (되쓰기 보존)", () => {
  for (const bad of ['"yes"', "1", "false", "null"]) {
    const source = `{"group":"G","collapsed":${bad}}\n`;
    const result = parseTasksFile(source);
    assert.equal(result.ok, true, bad);
    if (result.ok) {
      const header = result.lines[0]!;
      if (isGroupHeader(header)) assert.equal(isCollapsed(header), false, bad);
      assert.equal(serializeTaskLines(result.lines), source);
    }
  }
});

test("group 이 문자열 아님 → 파싱 불가 오류", () => {
  for (const bad of ['{"group":1}', '{"group":null}']) {
    const result = parseTasksFile(`${bad}\n`);
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.equal(result.line, 1);
  }
});

test("text 와 group 을 둘 다 가진 줄 → 파싱 불가 오류", () => {
  const result = parseTasksFile('{"text":"a","group":"G"}\n');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.line, 1);
});

test("빈 그룹(헤더만)·같은 이름 그룹 중복: 유효", () => {
  const source = '{"group":"G"}\n{"group":"G"}\n';
  const result = parseTasksFile(source);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(serializeTaskLines(result.lines), source);
});

test("그룹 헤더: group 이 첫 필드가 아니어도 필드 순서 왕복 보존", () => {
  const source = '{"color":"red","group":"G","collapsed":true}\n';
  const result = parseTasksFile(source);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(serializeTaskLines(result.lines), source);
});
