// 레이아웃 트리 위의 순수 연산. 현재 트리와 인자를 받아 새 트리를 돌려주고, 입력 트리는 바꾸지 않는다.
// pane 최소 크기 판정은 없다 — 분할과 비율 변경은 크기와 무관하게 허용된다.
// 시작 실패 사유 타입(F)은 트리를 따라간다 — 여기서는 값을 해석하지 않고 담기만 한다.

import {
  collectPanes,
  isPaneNode,
  LayoutError,
  type LayoutNode,
  type LayoutTree,
  type PaneNode,
  type SplitDirection,
  type SplitNode,
} from "./layout-tree.ts";

/** tab 드롭 위치. 가운데는 합류, 네 방향은 분할이다. */
export type DropPosition = "center" | "top" | "bottom" | "left" | "right";

export function createFirstPane<F>(
  tree: LayoutTree<F>,
  tabId: string,
  paneId: string,
): LayoutTree<F> {
  if (tree.root != null) {
    throw new LayoutError("The first pane can only be created in an empty layout.");
  }
  return {
    root: { paneId, tabs: [{ tabId }], activeTabId: tabId },
    focusedPaneId: paneId,
  };
}

export function addTab<F>(tree: LayoutTree<F>, paneId: string, tabId: string): LayoutTree<F> {
  const panes = collectPanes(tree.root);
  if (panes.some((p) => p.tabs.some((tab) => tab.tabId === tabId))) {
    throw new LayoutError(`The tab is already in the layout: ${tabId}`);
  }
  requirePane(panes, paneId);
  const root = replacePane(tree.root, paneId, (pane) => ({
    ...pane,
    tabs: [...pane.tabs, { tabId }],
    activeTabId: tabId,
  }));
  return { ...tree, root };
}

/** 시작 대기 tab 에 세션을 붙인다. 이미 붙었거나 그 세션이 다른 tab 에 있으면 오류다. */
export function attachSession<F>(
  tree: LayoutTree<F>,
  tabId: string,
  sessionId: string,
): LayoutTree<F> {
  const panes = collectPanes(tree.root);
  const owner = findOwnerPane(tree, tabId);
  const target = owner.tabs.find((tab) => tab.tabId === tabId)!;
  if (target.sessionId != null) {
    throw new LayoutError(`The tab already has a session: ${tabId}`);
  }
  if (panes.some((p) => p.tabs.some((tab) => tab.sessionId === sessionId))) {
    throw new LayoutError(`The session is already attached to another tab: ${sessionId}`);
  }
  const root = replacePane(tree.root, owner.paneId, (pane) => ({
    ...pane,
    tabs: pane.tabs.map((tab) => {
      if (tab.tabId !== tabId) return tab;
      const { starting: _starting, startFailure: _failure, ...rest } = tab;
      return { ...rest, sessionId };
    }),
  }));
  return { ...tree, root };
}

/** 그 자리를 세션이 뜨기를 기다리는 상태로 둔다. 앞선 실패 사유는 지운다. */
export function markTabStarting<F>(tree: LayoutTree<F>, tabId: string): LayoutTree<F> {
  const owner = findOwnerPane(tree, tabId);
  const target = owner.tabs.find((tab) => tab.tabId === tabId)!;
  if (target.sessionId != null) {
    throw new LayoutError(`The tab already has a session: ${tabId}`);
  }
  const root = replacePane(tree.root, owner.paneId, (pane) => ({
    ...pane,
    tabs: pane.tabs.map((tab) => {
      if (tab.tabId !== tabId) return tab;
      const { startFailure: _failure, ...rest } = tab;
      return { ...rest, starting: true };
    }),
  }));
  return { ...tree, root };
}

/** 그 자리의 시작 시도가 실패했음을 사유와 함께 남긴다. 자리는 그대로 두어 다시 고를 수 있게 한다. */
export function markTabStartFailed<F>(
  tree: LayoutTree<F>,
  tabId: string,
  startFailure: F,
): LayoutTree<F> {
  const owner = findOwnerPane(tree, tabId);
  const root = replacePane(tree.root, owner.paneId, (pane) => ({
    ...pane,
    tabs: pane.tabs.map((tab) => {
      if (tab.tabId !== tabId) return tab;
      const { starting: _starting, ...rest } = tab;
      return { ...rest, startFailure };
    }),
  }));
  return { ...tree, root };
}

/**
 * tab 에 이름을 넣거나(값 지정) 뺀다(없음). 값의 해석은 부르는 쪽 몫이고, 여기서는 자리에 담기만
 * 한다. 이름은 그 tab 을 따라다니므로 옮기고 합류시켜도 유지된다.
 */
export function setTabName<F>(
  tree: LayoutTree<F>,
  tabId: string,
  name: string | undefined,
): LayoutTree<F> {
  if (name != null && name.length === 0) {
    throw new LayoutError("A tab name cannot be empty.");
  }
  const owner = findOwnerPane(tree, tabId);
  const root = replacePane(tree.root, owner.paneId, (pane) => ({
    ...pane,
    tabs: pane.tabs.map((tab) => {
      if (tab.tabId !== tabId) return tab;
      const { name: _cleared, ...rest } = tab;
      return name == null ? rest : { ...rest, name };
    }),
  }));
  return { ...tree, root };
}

/** 그 세션이 붙은 tab 의 식별자. 없으면 없음. */
export function findTabBySession<F>(tree: LayoutTree<F>, sessionId: string): string | undefined {
  for (const pane of collectPanes(tree.root)) {
    const found = pane.tabs.find((tab) => tab.sessionId === sessionId);
    if (found !== undefined) return found.tabId;
  }
  return undefined;
}

export function removeTab<F>(tree: LayoutTree<F>, tabId: string): LayoutTree<F> {
  const owner = findOwnerPane(tree, tabId);
  if (owner.tabs.length > 1) {
    const root = replacePane(tree.root, owner.paneId, (pane) => shrinkPane(pane, tabId));
    return { ...tree, root };
  }
  return removeWholePane(tree, owner.paneId);
}

export function moveTab<F>(
  tree: LayoutTree<F>,
  tabId: string,
  targetPaneId: string,
  position: DropPosition,
  newPaneId?: string,
  insertIndex?: number,
): LayoutTree<F> {
  const source = findOwnerPane(tree, tabId);
  const target = requirePane(collectPanes(tree.root), targetPaneId);
  // 옮기는 것은 자리와 거기 붙은 세션이 함께다. 새로 만들면 붙어 있던 세션을 잃는다.
  const moving = source.tabs.find((tab) => tab.tabId === tabId)!;

  if (position === "center") {
    // 삽입 위치는 옮기기 전 대상 pane 의 tab 사이 자리다 (0 = 맨 앞, tab 수 = 맨 뒤).
    if (insertIndex != null && (insertIndex < 0 || insertIndex > target.tabs.length)) {
      throw new LayoutError(`The insert index is out of range: ${insertIndex}`);
    }
    if (source.paneId === targetPaneId) {
      if (insertIndex == null) return tree;
      const currentIndex = source.tabs.findIndex((tab) => tab.tabId === tabId);
      // 자기 앞뒤 사이에 놓는 것은 순서가 그대로다.
      if (insertIndex === currentIndex || insertIndex === currentIndex + 1) return tree;
      const adjustedIndex = insertIndex > currentIndex ? insertIndex - 1 : insertIndex;
      const root = replacePane(tree.root, targetPaneId, (pane) => {
        const tabs = pane.tabs.filter((tab) => tab.tabId !== tabId);
        tabs.splice(adjustedIndex, 0, moving);
        return { ...pane, tabs };
      });
      return { ...tree, root };
    }
    const removed = removeTabForMove(tree, tabId, source);
    const root = replacePane(removed.root, targetPaneId, (pane) => {
      const tabs = [...pane.tabs];
      tabs.splice(insertIndex ?? tabs.length, 0, moving);
      return { ...pane, tabs, activeTabId: tabId };
    });
    return { ...removed, root };
  }

  if (newPaneId === undefined) {
    throw new LayoutError("Splitting to a side needs an identifier for the new pane.");
  }
  if (source.paneId === targetPaneId && source.tabs.length === 1) {
    // 옮길 tab 이 사라진 원본 pane 이 붕괴해 결과가 분할 전과 같아진다 — 변화 없음.
    return tree;
  }
  if (collectPanes(tree.root).some((p) => p.paneId === newPaneId)) {
    throw new LayoutError(`The pane is already in the layout: ${newPaneId}`);
  }

  const removed = removeTabForMove(tree, tabId, source);
  const direction: SplitDirection =
    position === "left" || position === "right" ? "horizontal" : "vertical";
  const newPane: PaneNode<F> = { paneId: newPaneId, tabs: [moving], activeTabId: tabId };
  const root = replacePane(removed.root, targetPaneId, (pane) => ({
    direction,
    children: position === "left" || position === "top" ? [newPane, pane] : [pane, newPane],
    ratios: [0.5, 0.5],
  }));
  return { ...removed, root };
}

export function setActiveTab<F>(tree: LayoutTree<F>, paneId: string, tabId: string): LayoutTree<F> {
  const pane = requirePane(collectPanes(tree.root), paneId);
  if (!pane.tabs.some((tab) => tab.tabId === tabId)) {
    throw new LayoutError(`The tab is not in that pane: ${tabId}`);
  }
  const root = replacePane(tree.root, paneId, (p) => ({ ...p, activeTabId: tabId }));
  return { ...tree, root };
}

export function setFocusedPane<F>(tree: LayoutTree<F>, paneId: string): LayoutTree<F> {
  requirePane(collectPanes(tree.root), paneId);
  return { ...tree, focusedPaneId: paneId };
}

/**
 * 맞닿은 두 형제(boundaryIndex, boundaryIndex+1) 사이의 경계를 옮긴다. 두 비율의 합은 보존된다.
 * splitPath 는 루트에서 그 분할 노드까지의 자식 번호 목록이다 (루트 자신은 빈 배열).
 */
export function setSplitRatio<F>(
  tree: LayoutTree<F>,
  splitPath: readonly number[],
  boundaryIndex: number,
  firstRatio: number,
): LayoutTree<F> {
  const split = resolveSplitNode(tree, splitPath);
  if (boundaryIndex < 0 || boundaryIndex > split.children.length - 2) {
    throw new LayoutError(`The split boundary is out of range: ${boundaryIndex}`);
  }
  const pairSum = split.ratios[boundaryIndex] + split.ratios[boundaryIndex + 1];
  const secondRatio = pairSum - firstRatio;
  if (firstRatio <= 0 || secondRatio <= 0) {
    throw new LayoutError("A split size must be greater than zero.");
  }
  const ratios = [...split.ratios];
  ratios[boundaryIndex] = firstRatio;
  ratios[boundaryIndex + 1] = secondRatio;
  const root = replaceAtPath(tree.root as LayoutNode<F>, splitPath, { ...split, ratios });
  return { ...tree, root: normalizeNode(root) };
}

// ---- 내부 도우미 ----

function requirePane<F>(panes: readonly PaneNode<F>[], paneId: string): PaneNode<F> {
  const pane = panes.find((p) => p.paneId === paneId);
  if (pane === undefined) {
    throw new LayoutError(`The pane is not in the layout: ${paneId}`);
  }
  return pane;
}

function findOwnerPane<F>(tree: LayoutTree<F>, tabId: string): PaneNode<F> {
  const owner = collectPanes(tree.root).find((p) => p.tabs.some((tab) => tab.tabId === tabId));
  if (owner === undefined) {
    throw new LayoutError(`The tab is not in the layout: ${tabId}`);
  }
  return owner;
}

/** tab 하나를 뺀 pane. 활성 tab 이 빠지면 오른쪽 이웃, 없으면 왼쪽이 활성이 된다. */
function shrinkPane<F>(pane: PaneNode<F>, tabId: string): PaneNode<F> {
  const index = pane.tabs.findIndex((tab) => tab.tabId === tabId);
  const tabs = pane.tabs.filter((tab) => tab.tabId !== tabId);
  const activeTabId =
    pane.activeTabId === tabId ? tabs[Math.min(index, tabs.length - 1)].tabId : pane.activeTabId;
  return { ...pane, tabs, activeTabId };
}

/** 이동을 위해 원본 pane 에서 tab 을 뗀다. 마지막 tab 이면 pane 이 붕괴한다. */
function removeTabForMove<F>(
  tree: LayoutTree<F>,
  tabId: string,
  source: PaneNode<F>,
): LayoutTree<F> {
  if (source.tabs.length > 1) {
    const root = replacePane(tree.root, source.paneId, (pane) => shrinkPane(pane, tabId));
    return { ...tree, root };
  }
  return removeWholePane(tree, source.paneId);
}

/** pane 을 통째로 뗀다. 포커스가 그 pane 이었으면 형제 중 다음 pane, 없으면 이전 pane 으로 옮긴다. */
function removeWholePane<F>(tree: LayoutTree<F>, paneId: string): LayoutTree<F> {
  const focusedPaneId =
    tree.focusedPaneId === paneId
      ? findFocusFallback(tree.root as LayoutNode<F>, paneId)
      : tree.focusedPaneId;
  const stripped = stripPane(tree.root as LayoutNode<F>, paneId);
  if (stripped == null) {
    return { root: null };
  }
  return { root: normalizeNode(stripped), focusedPaneId };
}

function findFocusFallback<F>(root: LayoutNode<F>, paneId: string): string | undefined {
  const located = findParent(root, paneId, undefined);
  if (located === undefined) return undefined; // 루트가 그 pane — 트리가 비게 된다.
  const { parent, index } = located;
  const nextSibling = parent.children[index + 1];
  if (nextSibling !== undefined) return collectPanes(nextSibling)[0].paneId;
  const previousSibling = parent.children[index - 1];
  return collectPanes(previousSibling).at(-1)?.paneId;
}

function findParent<F>(
  node: LayoutNode<F>,
  paneId: string,
  parentInfo: { parent: SplitNode<F>; index: number } | undefined,
): { parent: SplitNode<F>; index: number } | undefined {
  if (isPaneNode(node)) {
    return node.paneId === paneId ? parentInfo : undefined;
  }
  for (const [index, child] of node.children.entries()) {
    const found = findParent(child, paneId, { parent: node, index });
    if (found !== undefined) return found;
  }
  return undefined;
}

function stripPane<F>(node: LayoutNode<F>, paneId: string): LayoutNode<F> | null {
  if (isPaneNode(node)) {
    return node.paneId === paneId ? null : node;
  }
  const children: LayoutNode<F>[] = [];
  const ratios: number[] = [];
  for (const [index, child] of node.children.entries()) {
    const strippedChild = stripPane(child, paneId);
    if (strippedChild != null) {
      children.push(strippedChild);
      ratios.push(node.ratios[index]);
    }
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children, ratios };
}

function replacePane<F>(
  root: LayoutNode<F> | null,
  paneId: string,
  replace: (pane: PaneNode<F>) => LayoutNode<F>,
): LayoutNode<F> {
  if (root == null) {
    throw new LayoutError(`The pane is not in the layout: ${paneId}`);
  }
  const rebuild = (node: LayoutNode<F>): LayoutNode<F> => {
    if (isPaneNode(node)) {
      return node.paneId === paneId ? replace(node) : node;
    }
    return { ...node, children: node.children.map(rebuild) };
  };
  return normalizeNode(rebuild(root));
}

/** 비율 합을 1 로 되돌리고, 같은 방향 중첩 분할을 부모로 평탄화한다. */
function normalizeNode<F>(node: LayoutNode<F>): LayoutNode<F> {
  if (isPaneNode(node)) return node;
  const normalizedChildren = node.children.map(normalizeNode);
  const sum = node.ratios.reduce((a, b) => a + b, 0);
  const normalizedRatios = node.ratios.map((ratio) => ratio / sum);

  const children: LayoutNode<F>[] = [];
  const ratios: number[] = [];
  for (const [index, child] of normalizedChildren.entries()) {
    if (!isPaneNode(child) && child.direction === node.direction) {
      for (const [childIndex, grandChild] of child.children.entries()) {
        children.push(grandChild);
        ratios.push(child.ratios[childIndex] * normalizedRatios[index]);
      }
    } else {
      children.push(child);
      ratios.push(normalizedRatios[index]);
    }
  }
  if (children.length === 1) return children[0];
  return { direction: node.direction, children, ratios };
}

function resolveSplitNode<F>(tree: LayoutTree<F>, splitPath: readonly number[]): SplitNode<F> {
  let node: LayoutNode<F> | null = tree.root;
  for (const index of splitPath) {
    if (node == null || isPaneNode(node) || node.children[index] === undefined) {
      throw new LayoutError(`The split path does not match the layout: [${splitPath.join(", ")}]`);
    }
    node = node.children[index];
  }
  if (node == null || isPaneNode(node)) {
    throw new LayoutError(`The split path does not point at a split: [${splitPath.join(", ")}]`);
  }
  return node;
}

function replaceAtPath<F>(
  root: LayoutNode<F>,
  path: readonly number[],
  replacement: LayoutNode<F>,
): LayoutNode<F> {
  if (path.length === 0) return replacement;
  if (isPaneNode(root)) {
    throw new LayoutError(`The split path does not match the layout: [${path.join(", ")}]`);
  }
  const [head, ...rest] = path;
  const children = [...root.children];
  children[head] = replaceAtPath(children[head], rest, replacement);
  return { ...root, children };
}
