import { test } from "node:test";
import assert from "node:assert/strict";
import { isUnchangedDrop, resolveDropZone, resolveTabInsertIndex } from "./drop-zone.ts";

const rect = { x: 100, y: 200, width: 300, height: 300 };

test("가운데 안쪽에 놓으면 합류 구역이다", () => {
  assert.equal(resolveDropZone(250, 350, rect), "center");
});

test("네 가장자리가 각 방향 구역으로 갈린다", () => {
  assert.equal(resolveDropZone(110, 350, rect), "left");
  assert.equal(resolveDropZone(390, 350, rect), "right");
  assert.equal(resolveDropZone(250, 210, rect), "top");
  assert.equal(resolveDropZone(250, 490, rect), "bottom");
});

test("모서리는 더 가까운 축의 방향으로 정해진다", () => {
  // 왼쪽 변에서 5px, 위쪽 변에서 40px — 왼쪽이 가깝다
  assert.equal(resolveDropZone(105, 240, rect), "left");
  // 위쪽 변에서 5px, 왼쪽 변에서 40px — 위쪽이 가깝다
  assert.equal(resolveDropZone(140, 205, rect), "top");
});

test("가장자리 구역의 경계는 세로·가로 각각 3분의 1 지점이다", () => {
  assert.equal(resolveDropZone(199, 350, rect), "left");
  assert.equal(resolveDropZone(201, 350, rect), "center");
  assert.equal(resolveDropZone(250, 299, rect), "top");
  assert.equal(resolveDropZone(250, 301, rect), "center");
});

test("자기 pane 의 가운데에 놓는 것은 변화가 없다", () => {
  assert.equal(isUnchangedDrop("pane-1", 3, "pane-1", "center"), true);
});

test("tab 이 하나뿐인 pane 에서 자기 방향 구역에 놓는 것은 변화가 없다", () => {
  assert.equal(isUnchangedDrop("pane-1", 1, "pane-1", "left"), true);
  assert.equal(isUnchangedDrop("pane-1", 2, "pane-1", "left"), false);
});

test("tab 중간점을 기준으로 삽입 자리가 정해진다", () => {
  const tabRects = [
    { x: 0, y: 0, width: 100, height: 30 },
    { x: 100, y: 0, width: 100, height: 30 },
  ];
  assert.equal(resolveTabInsertIndex(10, tabRects), 0);
  assert.equal(resolveTabInsertIndex(60, tabRects), 1);
  assert.equal(resolveTabInsertIndex(140, tabRects), 1);
  assert.equal(resolveTabInsertIndex(160, tabRects), 2);
});

test("tab 이 없으면 삽입 자리는 맨 앞이다", () => {
  assert.equal(resolveTabInsertIndex(50, []), 0);
});

test("다른 pane 으로 놓는 것은 어느 구역이든 변화가 있다", () => {
  assert.equal(isUnchangedDrop("pane-1", 1, "pane-2", "center"), false);
  assert.equal(isUnchangedDrop("pane-1", 1, "pane-2", "bottom"), false);
});
