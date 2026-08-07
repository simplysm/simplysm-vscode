import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBlockedShellKeys, computeShellKeyStates } from "./shell-keys.ts";

function reader(values: Record<string, unknown>): (settingKey: string) => unknown {
  return (settingKey) => values[settingKey];
}

const defaults = {
  "terminal.integrated.commandsToSkipShell": [],
  "terminal.integrated.allowChords": true,
};

test("기본 설정 — 기본 skip 목록의 키와 조합키만 VS Code 로 남고 나머지는 셸로 간다", () => {
  const states = computeShellKeyStates(reader(defaults));
  assert.equal(states["simplysm-terminal.shellKey.ctrlA"], true);
  assert.equal(states["simplysm-terminal.shellKey.ctrlR"], true);
  assert.equal(states["simplysm-terminal.shellKey.ctrlW"], true);
  assert.equal(states["simplysm-terminal.shellKey.ctrlB"], true);
  // 빠른 열기(Ctrl+P·Ctrl+E)와 panel 토글(Ctrl+J)은 기본 skip 목록에 있어 VS Code 가 가진다.
  assert.equal(states["simplysm-terminal.shellKey.ctrlP"], false);
  assert.equal(states["simplysm-terminal.shellKey.ctrlE"], false);
  assert.equal(states["simplysm-terminal.shellKey.ctrlJ"], false);
  // 조합키 시작(Ctrl+K)은 allowChords 기본값에서 VS Code 가 가진다.
  assert.equal(states["simplysm-terminal.shellKey.ctrlK"], false);
});

test("skip 목록에서 빠른 열기를 빼면 그 키가 셸로 간다", () => {
  const states = computeShellKeyStates(
    reader({
      ...defaults,
      "terminal.integrated.commandsToSkipShell": ["-workbench.action.quickOpen"],
    }),
  );
  assert.equal(states["simplysm-terminal.shellKey.ctrlP"], true);
  assert.equal(states["simplysm-terminal.shellKey.ctrlE"], true);
});

test("skip 목록에 후보 명령을 더하면 그 키를 VS Code 가 가진다", () => {
  const states = computeShellKeyStates(
    reader({
      ...defaults,
      "terminal.integrated.commandsToSkipShell": ["workbench.action.openRecent"],
    }),
  );
  assert.equal(states["simplysm-terminal.shellKey.ctrlR"], false);
  // 다른 키는 그대로다.
  assert.equal(states["simplysm-terminal.shellKey.ctrlA"], true);
});

test("allowChords 를 끄면 조합키 시작도 셸로 간다", () => {
  const states = computeShellKeyStates(
    reader({ ...defaults, "terminal.integrated.allowChords": false }),
  );
  assert.equal(states["simplysm-terminal.shellKey.ctrlK"], true);
});

test("차단 목록 — VS Code 가 가질 키만 에뮬레이터 무시 대상이 된다", () => {
  assert.deepEqual(computeBlockedShellKeys(reader(defaults)).sort(), [
    "ctrl+e",
    "ctrl+j",
    "ctrl+k",
    "ctrl+p",
  ]);
  assert.deepEqual(
    computeBlockedShellKeys(
      reader({
        ...defaults,
        "terminal.integrated.commandsToSkipShell": [
          "-workbench.action.quickOpen",
          "-workbench.action.togglePanel",
        ],
        "terminal.integrated.allowChords": false,
      }),
    ),
    [],
  );
});

test("후보에 없는 명령을 넣고 빼도 아무 키도 바뀌지 않는다", () => {
  const before = computeShellKeyStates(reader(defaults));
  const after = computeShellKeyStates(
    reader({
      ...defaults,
      "terminal.integrated.commandsToSkipShell": ["workbench.action.terminal.paste"],
    }),
  );
  assert.deepEqual(after, before);
});
