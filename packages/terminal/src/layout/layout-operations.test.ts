// 모든 레이아웃 연산은 순수 계산이라 입력 트리가 변하지 않아야 한다.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectPanes,
  isPaneNode,
  LayoutError,
  type LayoutNode,
  type LayoutTree,
  type PaneNode,
  type SplitNode,
} from "./layout-tree.ts";
import {
  addTab,
  attachSession,
  createFirstPane,
  findTabBySession,
  moveTab,
  removeTab,
  setActiveTab,
  setFocusedPane,
  setSplitRatio,
  setTabName,
} from "./layout-operations.ts";

const emptyTree: LayoutTree = { root: null };

/**
 * 어떤 연산을 거쳐도 트리가 지켜야 할 것들. 깨지면 화면이 그릴 수 없는 배치가 된다.
 * 부동소수 반복 연산의 오차만 흡수하면 되고, 이보다 작은 비율 차이는 화면에서 구분되지 않는다.
 */
const ratioSumTolerance = 1e-3;

function assertLayoutInvariants(tree: LayoutTree): void {
  const panes = collectPanes(tree.root);
  if (tree.root == null) {
    assert.equal(tree.focusedPaneId, undefined);
    return;
  }
  assert.ok(panes.some((p) => p.paneId === tree.focusedPaneId));
  assert.equal(new Set(panes.map((p) => p.paneId)).size, panes.length);

  const tabIds = panes.flatMap((p) => p.tabs.map((tab) => tab.tabId));
  assert.equal(new Set(tabIds).size, tabIds.length);
  const sessionIds = panes.flatMap((p) =>
    p.tabs.map((tab) => tab.sessionId).filter((id) => id != null),
  );
  assert.equal(new Set(sessionIds).size, sessionIds.length);

  for (const paneNode of panes) {
    assert.ok(paneNode.tabs.length > 0);
    assert.ok(paneNode.tabs.some((tab) => tab.tabId === paneNode.activeTabId));
  }
  assertNodeInvariants(tree.root, undefined);
}

function assertNodeInvariants(node: LayoutNode, parentDirection: string | undefined): void {
  if (isPaneNode(node)) return;
  assert.notEqual(node.direction, parentDirection);
  assert.ok(node.children.length >= 2);
  assert.equal(node.ratios.length, node.children.length);
  assert.ok(node.ratios.every((ratio) => Number.isFinite(ratio) && ratio > 0));
  const sum = node.ratios.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) <= ratioSumTolerance);
  for (const child of node.children) assertNodeInvariants(child, node.direction);
}

function pane(paneId: string, tabIds: string[], activeTabId = tabIds[0]): PaneNode {
  return { paneId, tabs: tabIds.map((tabId) => ({ tabId })), activeTabId };
}

/** [P1(t1), P2(t2)] 가로 분할 트리 */
function twoPaneTree(): LayoutTree {
  return {
    root: {
      direction: "horizontal",
      children: [pane("p1", ["t1"]), pane("p2", ["t2"])],
      ratios: [0.5, 0.5],
    },
    focusedPaneId: "p1",
  };
}

test("빈 트리에 첫 pane 을 만들며 tab 을 놓는다", () => {
  const tree = createFirstPane(emptyTree, "t1", "p1");
  assert.deepEqual(tree, {
    root: pane("p1", ["t1"]),
    focusedPaneId: "p1",
  });
  assertLayoutInvariants(tree);
});

test("시작 대기 tab 에 세션을 붙이면 그 tab 으로 찾을 수 있다", () => {
  const tree = attachSession(createFirstPane(emptyTree, "t1", "p1"), "t1", "s1");
  assert.deepEqual(tree.root, {
    paneId: "p1",
    tabs: [{ tabId: "t1", sessionId: "s1" }],
    activeTabId: "t1",
  });
  assert.equal(findTabBySession(tree, "s1"), "t1");
  assert.equal(findTabBySession(tree, "s2"), undefined);
  assertLayoutInvariants(tree);
});

test("이미 세션이 붙은 tab 이나 이미 쓰는 세션을 붙이면 오류다", () => {
  const tree = attachSession(
    addTab(createFirstPane(emptyTree, "t1", "p1"), "p1", "t2"),
    "t1",
    "s1",
  );
  assert.throws(() => attachSession(tree, "t1", "s2"), LayoutError);
  assert.throws(() => attachSession(tree, "t2", "s1"), LayoutError);
  assert.throws(() => attachSession(tree, "없는tab", "s2"), LayoutError);
});

test("tab 에 이름을 넣고 뺄 수 있고, 빈 이름은 오류다", () => {
  const named = setTabName(createFirstPane(emptyTree, "t1", "p1"), "t1", "build");
  assert.deepEqual((named.root as PaneNode).tabs, [{ tabId: "t1", name: "build" }]);
  const cleared = setTabName(named, "t1", undefined);
  assert.deepEqual((cleared.root as PaneNode).tabs, [{ tabId: "t1" }]);
  assert.throws(() => setTabName(named, "t1", ""), LayoutError);
  assert.throws(() => setTabName(named, "없는tab", "x"), LayoutError);
  assertLayoutInvariants(named);
});

test("이름은 세션이 붙기 전에도 붙고, 자리를 옮겨도 따라간다", () => {
  const named = setTabName(twoPaneTree(), "t1", "server");
  const attached = attachSession(named, "t1", "s1");
  const moved = moveTab(attached, "t1", "p2", "center");
  const target = (moved.root as PaneNode).tabs.find((tab) => tab.tabId === "t1");
  assert.deepEqual(target, { tabId: "t1", sessionId: "s1", name: "server" });
});

test("tab 을 옮겨도 붙어 있던 세션이 함께 간다", () => {
  const tree = attachSession(twoPaneTree(), "t1", "s1");
  const merged = moveTab(tree, "t1", "p2", "center");
  assert.equal(findTabBySession(merged, "s1"), "t1");
  const split = moveTab(tree, "t1", "p2", "right", "p3");
  assert.equal(findTabBySession(split, "s1"), "t1");
  assertLayoutInvariants(split);
});

test("비어 있지 않은 트리에 첫 pane 을 만들면 오류다", () => {
  assert.throws(() => createFirstPane(twoPaneTree(), "t9", "p9"), LayoutError);
});

test("tab 추가는 목록 끝에 붙고 곧바로 활성이 된다", () => {
  const tree = createFirstPane(emptyTree, "t1", "p1");
  const next = addTab(tree, "p1", "t2");
  assert.deepEqual(next.root, pane("p1", ["t1", "t2"], "t2"));
});

test("없는 pane 에 tab 을 추가하면 오류이고 트리는 그대로다", () => {
  const tree = createFirstPane(emptyTree, "t1", "p1");
  assert.throws(() => addTab(tree, "없는pane", "t2"), LayoutError);
  assert.deepEqual(tree, createFirstPane(emptyTree, "t1", "p1"));
});

test("이미 트리에 있는 tab 식별자를 추가하면 오류다", () => {
  const tree = twoPaneTree();
  assert.throws(() => addTab(tree, "p1", "t2"), LayoutError);
});

test("마지막 tab 을 제거하면 빈 트리가 되고 오류가 아니다", () => {
  const tree = createFirstPane(emptyTree, "t1", "p1");
  const next = removeTab(tree, "t1");
  assert.deepEqual(next, { root: null });
  assertLayoutInvariants(next);
});

test("없는 tab 을 제거하면 오류다", () => {
  assert.throws(() => removeTab(twoPaneTree(), "없는tab"), LayoutError);
});

test("활성 tab 이 제거되면 오른쪽 이웃, 없으면 왼쪽이 활성이 된다", () => {
  const tree: LayoutTree = { root: pane("p1", ["a", "b", "c"], "b"), focusedPaneId: "p1" };
  const afterMiddle = removeTab(tree, "b");
  assert.equal((afterMiddle.root as PaneNode).activeTabId, "c");

  const tail: LayoutTree = { root: pane("p1", ["a", "b", "c"], "c"), focusedPaneId: "p1" };
  const afterTail = removeTab(tail, "c");
  assert.equal((afterTail.root as PaneNode).activeTabId, "b");
});

test("tab 을 잃은 pane 은 사라지고 형제가 공간을 전부 차지한다", () => {
  const next = removeTab(twoPaneTree(), "t1");
  assert.deepEqual(next, { root: pane("p2", ["t2"]), focusedPaneId: "p2" });
});

test("포커스 pane 이 사라지면 형제 중 다음, 없으면 이전으로 옮긴다", () => {
  const base: LayoutTree = {
    root: {
      direction: "horizontal",
      children: [pane("p1", ["t1"]), pane("p2", ["t2"]), pane("p3", ["t3"])],
      ratios: [1 / 3, 1 / 3, 1 / 3],
    },
    focusedPaneId: "p2",
  };
  assert.equal(removeTab(base, "t2").focusedPaneId, "p3");

  const last: LayoutTree = { ...base, focusedPaneId: "p3" };
  assert.equal(removeTab(last, "t3").focusedPaneId, "p2");
});

test("셋 이상 형제에서 pane 이 빠지면 남은 비율이 비례 확대된다", () => {
  const base: LayoutTree = {
    root: {
      direction: "horizontal",
      children: [pane("p1", ["t1"]), pane("p2", ["t2"]), pane("p3", ["t3"])],
      ratios: [0.5, 0.25, 0.25],
    },
    focusedPaneId: "p1",
  };
  const next = removeTab(base, "t2");
  const root = next.root as SplitNode;
  assert.deepEqual(
    root.children.map((c) => (c as PaneNode).paneId),
    ["p1", "p3"],
  );
  assert.ok(Math.abs(root.ratios[0] - 2 / 3) < 1e-9);
  assert.ok(Math.abs(root.ratios[1] - 1 / 3) < 1e-9);
});

test("자기 자신 pane 의 가운데에 놓으면 변화가 없다", () => {
  const tree: LayoutTree = { root: pane("p1", ["a", "b"], "a"), focusedPaneId: "p1" };
  const next = moveTab(tree, "b", "p1", "center");
  assert.deepEqual(next, tree);
});

test("tab 이 하나뿐인 pane 에서 같은 pane 의 방향 구역에 놓으면 변화가 없다", () => {
  const tree = twoPaneTree();
  const next = moveTab(tree, "t1", "p1", "right", "새pane");
  assert.deepEqual(next, tree);
});

test("가운데로 합류한 tab 은 대상 pane 목록 끝에 붙고 곧바로 활성이 된다", () => {
  const tree = twoPaneTree();
  const next = moveTab(tree, "t1", "p2", "center");
  assert.deepEqual(next, { root: pane("p2", ["t2", "t1"], "t1"), focusedPaneId: "p2" });
});

test("삽입 자리를 실으면 같은 pane 안에서 tab 순서가 바뀌고 활성은 그대로다", () => {
  const tree: LayoutTree = { root: pane("p1", ["a", "b", "c"], "a"), focusedPaneId: "p1" };
  const next = moveTab(tree, "c", "p1", "center", undefined, 0);
  assert.deepEqual(
    (next.root as PaneNode).tabs.map((tab) => tab.tabId),
    ["c", "a", "b"],
  );
  assert.equal((next.root as PaneNode).activeTabId, "a");
  assertLayoutInvariants(next);
});

test("자기 앞뒤 사이 삽입 자리는 변화가 없다", () => {
  const tree: LayoutTree = { root: pane("p1", ["a", "b"], "a"), focusedPaneId: "p1" };
  assert.deepEqual(moveTab(tree, "a", "p1", "center", undefined, 0), tree);
  assert.deepEqual(moveTab(tree, "a", "p1", "center", undefined, 1), tree);
});

test("다른 pane 으로의 합류도 삽입 자리를 지킨다", () => {
  const tree = addTab(twoPaneTree(), "p2", "t3");
  const next = moveTab(tree, "t1", "p2", "center", undefined, 1);
  assert.deepEqual(
    (next.root as PaneNode).tabs.map((tab) => tab.tabId),
    ["t2", "t1", "t3"],
  );
  assert.equal((next.root as PaneNode).activeTabId, "t1");
  assertLayoutInvariants(next);
});

test("범위 밖 삽입 자리는 오류다", () => {
  const tree: LayoutTree = { root: pane("p1", ["a", "b"], "a"), focusedPaneId: "p1" };
  assert.throws(() => moveTab(tree, "a", "p1", "center", undefined, -1), LayoutError);
  assert.throws(() => moveTab(tree, "a", "p1", "center", undefined, 3), LayoutError);
});

test("4방향 드롭이 그 방향으로 pane 을 가르고 절반씩 나눠 갖는다", () => {
  const single = createFirstPane(emptyTree, "t1", "p1");
  const two = addTab(single, "p1", "t2");

  const right = moveTab(two, "t2", "p1", "right", "p2");
  assert.deepEqual(right.root, {
    direction: "horizontal",
    children: [pane("p1", ["t1"]), pane("p2", ["t2"])],
    ratios: [0.5, 0.5],
  });

  const left = moveTab(two, "t2", "p1", "left", "p2");
  assert.deepEqual((left.root as SplitNode).children[0], pane("p2", ["t2"]));
  assert.equal((left.root as SplitNode).direction, "horizontal");

  const top = moveTab(two, "t2", "p1", "top", "p2");
  assert.equal((top.root as SplitNode).direction, "vertical");
  assert.deepEqual((top.root as SplitNode).children[0], pane("p2", ["t2"]));

  const bottom = moveTab(two, "t2", "p1", "bottom", "p2");
  assert.equal((bottom.root as SplitNode).direction, "vertical");
  assert.deepEqual((bottom.root as SplitNode).children[1], pane("p2", ["t2"]));
});

test("같은 방향 분할이 중첩되면 부모로 평탄화된다", () => {
  const tree = twoPaneTree();
  const withTab = addTab(tree, "p2", "t3");
  const next = moveTab(withTab, "t3", "p2", "right", "p3");
  const root = next.root as SplitNode;
  assert.equal(root.direction, "horizontal");
  assert.deepEqual(
    root.children.map((c) => (c as PaneNode).paneId),
    ["p1", "p2", "p3"],
  );
  assert.deepEqual(root.ratios, [0.5, 0.25, 0.25]);
  assertLayoutInvariants(next);
});

test("방향 드롭에 새 pane 식별자가 없으면 오류다", () => {
  const tree = addTab(createFirstPane(emptyTree, "t1", "p1"), "p1", "t2");
  assert.throws(() => moveTab(tree, "t2", "p1", "right"), LayoutError);
});

test("없는 tab·대상 pane 을 가리키는 이동은 오류다", () => {
  const tree = twoPaneTree();
  assert.throws(() => moveTab(tree, "없는tab", "p1", "center"), LayoutError);
  assert.throws(() => moveTab(tree, "t1", "없는pane", "center"), LayoutError);
});

test("이동으로 tab 을 잃은 pane 은 붕괴하고 트리가 정리된다", () => {
  const tree = twoPaneTree();
  const next = moveTab(tree, "t2", "p1", "center");
  assert.deepEqual(next, { root: pane("p1", ["t1", "t2"], "t2"), focusedPaneId: "p1" });
});

test("활성 tab 이 다른 pane 으로 옮겨 가면 남은 pane 의 오른쪽 이웃이 활성이 된다", () => {
  const tree: LayoutTree = {
    root: {
      direction: "horizontal",
      children: [pane("p1", ["a", "b"], "a"), pane("p2", ["c"])],
      ratios: [0.5, 0.5],
    },
    focusedPaneId: "p1",
  };
  const next = moveTab(tree, "a", "p2", "center");
  const root = next.root as SplitNode;
  assert.equal((root.children[0] as PaneNode).activeTabId, "b");
});

test("활성 tab 변경과 포커스 pane 변경이 동작하고, 없는 식별자는 오류다", () => {
  const tree: LayoutTree = { root: pane("p1", ["a", "b"], "a"), focusedPaneId: "p1" };
  assert.equal((setActiveTab(tree, "p1", "b").root as PaneNode).activeTabId, "b");
  assert.throws(() => setActiveTab(tree, "p1", "없는tab"), LayoutError);
  assert.throws(() => setActiveTab(tree, "없는pane", "a"), LayoutError);

  const two = twoPaneTree();
  assert.equal(setFocusedPane(two, "p2").focusedPaneId, "p2");
  assert.throws(() => setFocusedPane(two, "없는pane"), LayoutError);
});

test("분할 비율 변경은 맞닿은 두 형제 사이에서만 일어나고 합이 보존된다", () => {
  const tree: LayoutTree = {
    root: {
      direction: "horizontal",
      children: [pane("p1", ["t1"]), pane("p2", ["t2"]), pane("p3", ["t3"])],
      ratios: [0.5, 0.25, 0.25],
    },
    focusedPaneId: "p1",
  };
  const next = setSplitRatio(tree, [], 0, 0.3);
  const root = next.root as SplitNode;
  assert.ok(Math.abs(root.ratios[0] - 0.3) < 1e-9);
  assert.ok(Math.abs(root.ratios[1] - 0.45) < 1e-9);
  assert.ok(Math.abs(root.ratios[2] - 0.25) < 1e-9);
  assert.ok(Math.abs(root.ratios.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assertLayoutInvariants(next);
});

test("비율을 0 이하로 만드는 변경은 오류다", () => {
  const tree = twoPaneTree();
  assert.throws(() => setSplitRatio(tree, [], 0, 0), LayoutError);
  assert.throws(() => setSplitRatio(tree, [], 0, 1), LayoutError);
});

test("없는 분할 경로·경계 번호는 오류다", () => {
  const tree = twoPaneTree();
  assert.throws(() => setSplitRatio(tree, [9], 0, 0.5), LayoutError);
  assert.throws(() => setSplitRatio(tree, [0], 0, 0.5), LayoutError);
  assert.throws(() => setSplitRatio(tree, [], 1, 0.5), LayoutError);
});

test("임의 조작을 연속 적용해도 불변식이 깨지지 않는다", () => {
  // 결정적 의사난수 — 실패 재현이 가능해야 한다.
  let seed = 20260730;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];

  let tree: LayoutTree = { root: null };
  let idCounter = 0;
  for (let step = 0; step < 300; step++) {
    const panes: PaneNode[] = [];
    const collect = (node: LayoutTree["root"]): void => {
      if (node == null) return;
      if ("paneId" in node) panes.push(node);
      else node.children.forEach(collect);
    };
    collect(tree.root);

    const splitPaths: number[][] = [];
    const collectSplits = (node: LayoutTree["root"], path: number[]): void => {
      if (node == null || "paneId" in node) return;
      splitPaths.push(path);
      node.children.forEach((child, index) => collectSplits(child, [...path, index]));
    };
    collectSplits(tree.root, []);

    const before = structuredClone(tree);
    try {
      if (panes.length === 0) {
        tree = createFirstPane(tree, `t${idCounter}`, `p${idCounter}`);
        idCounter++;
      } else {
        const op = pick([
          "add",
          "remove",
          "moveCenter",
          "moveSplit",
          "active",
          "focus",
          "ratio",
        ] as const);
        const target = pick(panes);
        if (op === "add") {
          tree = addTab(tree, target.paneId, `t${idCounter++}`);
        } else if (op === "remove") {
          tree = removeTab(tree, pick(target.tabs).tabId);
        } else if (op === "moveCenter") {
          const source = pick(panes);
          tree = moveTab(tree, pick(source.tabs).tabId, target.paneId, "center");
        } else if (op === "moveSplit") {
          const source = pick(panes);
          tree = moveTab(
            tree,
            pick(source.tabs).tabId,
            target.paneId,
            pick(["top", "bottom", "left", "right"] as const),
            `p${idCounter++}`,
          );
        } else if (op === "active") {
          tree = setActiveTab(tree, target.paneId, pick(target.tabs).tabId);
        } else if (op === "focus") {
          tree = setFocusedPane(tree, target.paneId);
        } else if (op === "ratio" && splitPaths.length > 0) {
          const path = pick(splitPaths);
          tree = setSplitRatio(tree, path, 0, 0.25 + rand() * 0.5);
        }
      }
    } catch (error) {
      // 오류로 거부된 요청은 트리를 바꾸지 않아야 한다.
      assert.ok(error instanceof LayoutError);
      assert.deepEqual(tree, before);
    }
    assertLayoutInvariants(tree);
  }
});
