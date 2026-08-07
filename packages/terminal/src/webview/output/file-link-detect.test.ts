import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFileLinks } from "./file-link-detect.ts";

test("절대 경로를 찾는다", () => {
  const links = detectFileLinks("error in C:\\work\\app\\src\\main.ts during build");
  assert.deepEqual(links, [
    { startIndex: 9, length: 23, path: "C:\\work\\app\\src\\main.ts" },
  ]);
});

test("POSIX 절대 경로를 찾는다", () => {
  const links = detectFileLinks("error in /home/user/app/src/main.ts during build");
  assert.deepEqual(links, [
    { startIndex: 9, length: 26, path: "/home/user/app/src/main.ts" },
  ]);
});

test("POSIX 절대 경로의 콜론 줄·열 번호를 해석한다", () => {
  const links = detectFileLinks("/home/a/b.ts:12:3");
  assert.deepEqual(links, [
    { startIndex: 0, length: 17, path: "/home/a/b.ts", line: 12, column: 3 },
  ]);
});

test("콜론 뒤 줄·열 번호를 해석한다", () => {
  const links = detectFileLinks("C:\\a\\b.ts:12:3");
  assert.deepEqual(links, [
    { startIndex: 0, length: 14, path: "C:\\a\\b.ts", line: 12, column: 3 },
  ]);
});

test("괄호 표기 줄·열 번호를 해석한다", () => {
  const links = detectFileLinks("C:\\a\\b.ts(7,2) error TS1005");
  assert.deepEqual(links, [
    { startIndex: 0, length: 14, path: "C:\\a\\b.ts", line: 7, column: 2 },
  ]);
});

test("상대 경로를 찾는다", () => {
  const links = detectFileLinks("see ./src/util.ts:3 and ..\\lib\\a.js");
  assert.deepEqual(links, [
    { startIndex: 4, length: 15, path: "./src/util.ts", line: 3 },
    { startIndex: 24, length: 11, path: "..\\lib\\a.js" },
  ]);
});

test("문장 끝 마침표는 경로에 넣지 않는다", () => {
  const links = detectFileLinks("open C:\\a\\b.ts.");
  assert.deepEqual(links, [{ startIndex: 5, length: 9, path: "C:\\a\\b.ts" }]);
});

test("접두 없는 상대 경로 — tsc 꼴을 찾는다", () => {
  const links = detectFileLinks("src/util.ts(3,5): error TS1005");
  assert.deepEqual(links, [
    { startIndex: 0, length: 16, path: "src/util.ts", line: 3, column: 5 },
  ]);
});

test("접두 없는 상대 경로 — 역슬래시 구분자와 콜론 줄 번호", () => {
  const links = detectFileLinks("at src\\webview\\main.ts:12");
  assert.deepEqual(links, [
    { startIndex: 3, length: 22, path: "src\\webview\\main.ts", line: 12 },
  ]);
});

test("구분자 없는 파일명은 줄 번호가 붙어 있을 때만 찾는다", () => {
  assert.deepEqual(detectFileLinks("open util.ts(3)"), [
    { startIndex: 5, length: 10, path: "util.ts", line: 3 },
  ]);
  assert.deepEqual(detectFileLinks("open util.ts now"), []);
});

test("다중 점 파일명도 찾는다", () => {
  assert.deepEqual(detectFileLinks("src\\util.spec.ts(3,5): error"), [
    { startIndex: 0, length: 21, path: "src\\util.spec.ts", line: 3, column: 5 },
  ]);
  assert.deepEqual(detectFileLinks("open util.spec.ts:3"), [
    { startIndex: 5, length: 14, path: "util.spec.ts", line: 3 },
  ]);
});

test("확장자 없는 낱말 짝은 경로로 보지 않는다", () => {
  assert.deepEqual(detectFileLinks("use and/or both"), []);
});

test("URL 내부 조각은 파일 경로로 보지 않는다", () => {
  assert.deepEqual(detectFileLinks("see https://github.com/a/b.ts today"), []);
});

test("경로 꼴이 없으면 빈 목록이다", () => {
  assert.deepEqual(detectFileLinks("plain text with no paths"), []);
});

test("한 줄의 여러 경로를 모두 찾는다", () => {
  const links = detectFileLinks("C:\\one.ts C:\\two.ts");
  assert.equal(links.length, 2);
  assert.equal(links[0]!.path, "C:\\one.ts");
  assert.equal(links[1]!.path, "C:\\two.ts");
});
