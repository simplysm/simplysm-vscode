import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlainAltKeydown } from "./menubar-alt.ts";

const keys = (mods: { alt?: boolean; ctrl?: boolean; meta?: boolean }) => ({
  altKey: mods.alt ?? false,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
});

test("Ctrl·Meta 없이 Alt 가 낀 keydown 은 VS Code 에 넘기지 않는다", () => {
  // Alt 키 자신, Alt+V, Alt 를 누른 채 누른 Shift 가 모두 여기에 든다.
  assert.equal(isPlainAltKeydown(keys({ alt: true })), true);
});

test("Ctrl 이나 Meta 가 함께 눌린 keydown 은 넘긴다 — Ctrl+Alt 단축키용", () => {
  assert.equal(isPlainAltKeydown(keys({ alt: true, ctrl: true })), false);
  assert.equal(isPlainAltKeydown(keys({ alt: true, meta: true })), false);
});

test("Alt 가 없는 keydown 은 넘긴다", () => {
  assert.equal(isPlainAltKeydown(keys({})), false);
  assert.equal(isPlainAltKeydown(keys({ ctrl: true })), false);
});
