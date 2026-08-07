import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFileLinkPath } from "./file-link.ts";

test("시작 디렉터리가 Windows 꼴이면 상대 경로를 Windows 경로 규칙으로 푼다", () => {
  assert.equal(resolveFileLinkPath("C:\\work\\app", "./src/main.ts"), "C:\\work\\app\\src\\main.ts");
});

test("시작 디렉터리가 POSIX 꼴이면 상대 경로를 POSIX 경로 규칙으로 푼다", () => {
  assert.equal(resolveFileLinkPath("/home/user/app", "./src/main.ts"), "/home/user/app/src/main.ts");
});

test("절대 경로는 시작 디렉터리와 무관하게 그대로 쓴다", () => {
  assert.equal(resolveFileLinkPath("C:\\work\\app", "D:\\etc\\hosts.ts"), "D:\\etc\\hosts.ts");
  assert.equal(resolveFileLinkPath("/home/user/app", "/etc/hosts"), "/etc/hosts");
});
