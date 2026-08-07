// pane 분할과 tab 배치를 담는 레이아웃 트리 타입.
// 시작 실패 사유(F)는 자리에 따라 다르다 — daemon 은 구조화 사유를, webview 는 번역된 글자를 담는다.

import type { LocalizedText } from "../l10n.ts";

export type SplitDirection = "horizontal" | "vertical";

/** 자식들을 한 축으로 나란히 놓는 분할 노드. */
export interface SplitNode<F = LocalizedText> {
  readonly direction: SplitDirection;
  readonly children: readonly LayoutNode<F>[];
  readonly ratios: readonly number[];
}

/** pane 안의 자리 하나. 세션은 나중에 붙는다. */
export interface LayoutTab<F = LocalizedText> {
  readonly tabId: string;
  /** 붙은 세션. 없으면 시작 대기 tab 이며, 빈 문자열로 대신하지 않는다. */
  readonly sessionId?: string;
  /** 사용자가 이 자리에 붙인 이름. 없으면 셸 이름이 보이며, 빈 문자열로 대신하지 않는다. */
  readonly name?: string;
  /** 세션이 뜨기를 기다리는 중. */
  readonly starting?: boolean;
  /** 앞선 시작 시도가 실패한 사유. */
  readonly startFailure?: F;
}

/** tab 들이 겹쳐 놓인 구획 하나. */
export interface PaneNode<F = LocalizedText> {
  readonly paneId: string;
  /** 표시 순서. 1개 이상. */
  readonly tabs: readonly LayoutTab<F>[];
  readonly activeTabId: string;
}

export type LayoutNode<F = LocalizedText> = SplitNode<F> | PaneNode<F>;

export interface LayoutTree<F = LocalizedText> {
  /** null 은 tab 이 하나도 없는 빈 상태. */
  readonly root: LayoutNode<F> | null;
  /** 빈 상태에서만 없음. */
  readonly focusedPaneId?: string;
}

/** 배치를 바꾸지 못했다. 이미 사라진 자리를 뒤늦게 가리키는 조작이 여기 해당한다. */
export class LayoutError extends Error {}

export function isPaneNode<F>(node: LayoutNode<F>): node is PaneNode<F> {
  return "paneId" in node;
}

/** 트리 순서(왼쪽 우선 깊이 우선)대로 pane 을 모은다. */
export function collectPanes<F>(node: LayoutNode<F> | null): PaneNode<F>[] {
  if (node == null) return [];
  if (isPaneNode(node)) return [node];
  return node.children.flatMap((child) => collectPanes(child));
}
