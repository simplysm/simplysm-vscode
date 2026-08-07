import { test } from "node:test";
import assert from "node:assert/strict";
import { assignedNameMaxLength, normalizeAssignedName, shellDisplayName } from "./name-value.ts";

test("앞뒤 공백을 자른 값이 지정 이름이 된다", () => {
  assert.equal(normalizeAssignedName("  build watch  "), "build watch");
});

test("개행·제어문자가 섞이면 없애 한 줄로 만든다", () => {
  assert.equal(normalizeAssignedName("build\r\nwatch\u0007"), "buildwatch");
});

test("빈 값과 공백만 있는 값은 지정 해제다", () => {
  assert.equal(normalizeAssignedName(""), undefined);
  assert.equal(normalizeAssignedName("   "), undefined);
  assert.equal(normalizeAssignedName("\n\t"), undefined);
});

test("길이 상한을 넘는 값은 잘린다", () => {
  const long = "n".repeat(assignedNameMaxLength + 20);
  assert.equal(normalizeAssignedName(long)?.length, assignedNameMaxLength);
});

test("셸 이름은 실행 파일 이름에서 확장자를 뗀 값이다", () => {
  assert.equal(shellDisplayName("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "pwsh");
  assert.equal(shellDisplayName("/usr/bin/bash"), "bash");
});

test("확장자만 있는 이름은 그대로 둔다", () => {
  assert.equal(shellDisplayName("C:\\tools\\.shellrc"), ".shellrc");
});
