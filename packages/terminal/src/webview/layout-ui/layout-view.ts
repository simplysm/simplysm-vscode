// 레이아웃 트리를 pane 배치로 그리고, 마우스 조작을 레이아웃 모델의 연산으로 옮긴다.
// 배치 계산은 여기서 하지 않는다 — 어떤 조작도 그 연산 하나를 부르는 것으로 표현한다.

import {
  collectPanes,
  isPaneNode,
  type LayoutNode,
  type LayoutTree,
  type PaneNode,
  type SplitDirection,
  type SplitNode,
} from "../../layout/layout-tree.ts";
import type { DropPosition } from "../../layout/layout-operations.ts";
import type { ViewTexts } from "../../webview-messages.ts";
import { setDataText, setDataTooltip, setLabel, setText } from "../dom-text.ts";
import { isUnchangedDrop, resolveDropZone, resolveTabInsertIndex } from "./drop-zone.ts";
import { Overlays } from "./overlays.ts";

/** tab 하나를 그리는 데 필요한 것. 이름은 사용자 환경에서 온 값이라 번역 대상이 아니다. */
export interface TabView {
  readonly rootElement: HTMLElement;
  /** 그 자리에 보일 이름. 붙인 이름도 셸 이름도 없으면 고르는 중임을 대신 보인다. */
  readonly name?: string;
}

/**
 * 조작을 뜻 그대로 올린다. 배치를 바꾸는 것은 확장 호스트이고, 여기서는 새 트리를 만들지 않는다.
 */
export interface LayoutHost {
  readonly tabView: (tabId: string) => TabView | undefined;
  readonly onActivateTab: (paneId: string, tabId: string) => void;
  readonly onFocusPane: (paneId: string) => void;
  readonly onMoveTab: (
    tabId: string,
    targetPaneId: string,
    position: DropPosition,
    insertIndex?: number,
  ) => void;
  readonly onSetSplitRatio: (
    splitPath: readonly number[],
    boundaryIndex: number,
    firstRatio: number,
  ) => void;
  readonly onNewTab: (paneId: string) => void;
  readonly onCloseTab: (tabId: string) => void;
  readonly onRenameTab: (tabId: string, raw: string) => void;
  readonly onFocusTab: (tabId: string) => void;
}

/** 드래그로 옮기는 중인 tab. 놓을 자리 판정과 미리 보기가 이 값을 본다. */
interface DragState {
  readonly tabId: string;
  readonly sourcePaneId: string;
  readonly sourceTabCount: number;
}

export class LayoutView {
  readonly #containerElement: HTMLElement;
  readonly #host: LayoutHost;
  readonly #overlays: Overlays;
  #texts?: ViewTexts;
  #tree: LayoutTree = { root: null };
  /** 마지막으로 그린 구조. 같으면 요소를 다시 만들지 않고 값만 갱신한다. */
  #structure = "";
  /** 지금 그려 둔 tab 별 화면 요소. 복구로 요소가 새로 만들어지면 여기서 어긋난다. */
  #placedElements = new Map<string, HTMLElement>();
  #drag?: DragState;

  constructor(containerElement: HTMLElement, overlayElement: HTMLElement, host: LayoutHost) {
    this.#containerElement = containerElement;
    this.#host = host;
    this.#overlays = new Overlays(overlayElement);
  }

  /** 표시 문자열이 새로 오면 + 버튼 설명처럼 만들 때 한 번 붙는 글자까지 다시 그린다. */
  setTexts(texts: ViewTexts): void {
    this.#texts = texts;
    this.#structure = "";
  }

  /** 그 tab 에 딸린 메뉴·입력창을 닫는다. 세션이 끝나면 열어 둔 것을 남기지 않는다. */
  closeOverlaysFor(tabId: string): void {
    this.#overlays.closeFor(tabId);
  }

  /** 그 pane 이 그려진 자리. 검색창이 이 자리의 오른쪽 위에 붙는다. */
  paneRect(paneId: string): DOMRect | undefined {
    return this.#containerElement
      .querySelector(`.pane[data-pane-id="${CSS.escape(paneId)}"]`)
      ?.getBoundingClientRect();
  }

  render(tree: LayoutTree): void {
    this.#tree = tree;
    const structure = structureSignature(tree.root);
    if (structure !== this.#structure || this.#hasStaleElements(tree)) {
      this.#structure = structure;
      this.#placedElements = new Map();
      const rootElement = tree.root == null ? undefined : this.#buildNode(tree.root, []);
      this.#containerElement.replaceChildren(...(rootElement == null ? [] : [rootElement]));
    }
    if (tree.root != null) {
      this.#syncNode(tree.root, this.#containerElement.firstElementChild as HTMLElement);
    }
    // 드래그하던 tab 이 사라졌으면 진행 중이던 드래그도 의미가 없다.
    if (this.#drag != null && this.#host.tabView(this.#drag.tabId) == null) this.#endDrag();
  }

  /** 그려 둔 화면 요소가 지금 tab 이 든 것과 다른가. 복구로 자리들을 새로 만든 경우다. */
  #hasStaleElements(tree: LayoutTree): boolean {
    for (const pane of collectPanes(tree.root)) {
      for (const tab of pane.tabs) {
        const view = this.#host.tabView(tab.tabId);
        if (view == null) continue;
        if (this.#placedElements.get(tab.tabId) !== view.rootElement) return true;
      }
    }
    return false;
  }

  // ---- 만들기 ----

  #buildNode(node: LayoutNode, path: readonly number[]): HTMLElement {
    return isPaneNode(node) ? this.#buildPane(node) : this.#buildSplit(node, path);
  }

  #buildSplit(node: SplitNode, path: readonly number[]): HTMLElement {
    const splitElement = document.createElement("div");
    splitElement.className = `split ${node.direction}`;
    node.children.forEach((child, index) => {
      if (index > 0) {
        splitElement.appendChild(this.#buildDivider(node.direction, path, index - 1));
      }
      splitElement.appendChild(this.#buildNode(child, [...path, index]));
    });
    return splitElement;
  }

  #buildDivider(
    direction: SplitDirection,
    path: readonly number[],
    boundaryIndex: number,
  ): HTMLElement {
    const dividerElement = document.createElement("div");
    dividerElement.className = "divider";
    dividerElement.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      dividerElement.setPointerCapture(event.pointerId);
      this.#dragDivider(dividerElement, direction, path, boundaryIndex, event.pointerId);
    });
    return dividerElement;
  }

  #buildPane(node: PaneNode): HTMLElement {
    const paneElement = document.createElement("div");
    paneElement.className = "pane";
    paneElement.dataset.paneId = node.paneId;

    const tabBarElement = document.createElement("div");
    tabBarElement.className = "tab-bar";
    // 넘친 tab 은 가로 스크롤로 접근한다 — 세로 휠을 가로 이동으로 옮긴다.
    tabBarElement.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaY === 0) return;
        event.preventDefault();
        tabBarElement.scrollLeft += event.deltaY;
      },
      { passive: false },
    );
    for (const tab of node.tabs) {
      tabBarElement.appendChild(this.#buildTabLabel(node.paneId, tab.tabId));
    }
    tabBarElement.appendChild(this.#buildAddButton(node.paneId));

    const bodyElement = document.createElement("div");
    bodyElement.className = "pane-body";
    for (const tab of node.tabs) {
      const view = this.#host.tabView(tab.tabId);
      if (view == null) continue;
      bodyElement.appendChild(view.rootElement);
      this.#placedElements.set(tab.tabId, view.rootElement);
    }

    // 분할 미리 보기는 몸통 위에만 뜬다 — tab bar 는 분할이 아니라 삽입의 영역이다.
    const previewElement = document.createElement("div");
    previewElement.className = "drop-preview";
    previewElement.hidden = true;
    bodyElement.appendChild(previewElement);

    const insertLineElement = document.createElement("div");
    insertLineElement.className = "tab-insert-line";
    insertLineElement.hidden = true;
    tabBarElement.appendChild(insertLineElement);

    paneElement.append(tabBarElement, bodyElement);
    this.#wirePaneFocus(paneElement, node.paneId);
    this.#wireBodyDrop(bodyElement, previewElement, node.paneId);
    this.#wireTabBarDrop(tabBarElement, insertLineElement, node.paneId);
    return paneElement;
  }

  #buildTabLabel(paneId: string, tabId: string): HTMLElement {
    // X 버튼을 안에 두려면 button 을 겹칠 수 없어 tab 자체는 div 로 만든다.
    const labelElement = document.createElement("div");
    labelElement.className = "tab-label";
    labelElement.dataset.tabId = tabId;
    labelElement.draggable = true;

    const nameElement = document.createElement("span");
    nameElement.className = "tab-name";
    labelElement.appendChild(nameElement);

    const closeElement = document.createElement("button");
    closeElement.className = "tab-close codicon codicon-close";
    if (this.#texts != null) setLabel(closeElement, this.#texts.closeTab);
    closeElement.addEventListener("click", (event) => {
      // 닫기가 활성 전환으로 번지지 않게 여기서 끊는다.
      event.stopPropagation();
      this.#host.onCloseTab(tabId);
    });
    labelElement.appendChild(closeElement);

    labelElement.addEventListener("click", () => {
      this.#host.onActivateTab(paneId, tabId);
      this.#host.onFocusTab(tabId);
    });
    labelElement.addEventListener("contextmenu", (event) => {
      // 우클릭은 활성 전환도 드래그 시작도 아니다. 대상 tab 만 메뉴가 가리킨다.
      event.preventDefault();
      this.#openTabMenu(tabId, labelElement);
    });
    labelElement.addEventListener("dragstart", (event) => {
      const pane = collectPanes(this.#tree.root).find((p) => p.paneId === paneId);
      if (pane == null) return;
      this.#overlays.close();
      this.#drag = { tabId, sourcePaneId: paneId, sourceTabCount: pane.tabs.length };
      labelElement.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", tabId);
      if (event.dataTransfer != null) event.dataTransfer.effectAllowed = "move";
    });
    labelElement.addEventListener("dragend", () => {
      labelElement.classList.remove("dragging");
      this.#endDrag();
    });
    return labelElement;
  }

  /** + 는 codicon 아이콘으로 그린다. 아이콘은 언어를 타지 않고, 설명만 번역해 단다. */
  #buildAddButton(paneId: string): HTMLElement {
    const addElement = document.createElement("button");
    addElement.className = "tab-add codicon codicon-add";
    if (this.#texts != null) setLabel(addElement, this.#texts.newTab);
    addElement.addEventListener("click", () => this.#host.onNewTab(paneId));
    return addElement;
  }

  // ---- 갱신 ----

  #syncNode(node: LayoutNode, element: HTMLElement): void {
    if (isPaneNode(node)) {
      element.classList.toggle("focused", this.#tree.focusedPaneId === node.paneId);
      for (const tab of node.tabs) {
        const isActive = tab.tabId === node.activeTabId;
        const view = this.#host.tabView(tab.tabId);
        if (view != null) view.rootElement.hidden = !isActive;
        const labelElement = element.querySelector<HTMLElement>(
          `.tab-label[data-tab-id="${CSS.escape(tab.tabId)}"]`,
        );
        if (labelElement == null) continue;
        labelElement.classList.toggle("active", isActive);
        this.#applyTabName(labelElement, view);
      }
      return;
    }
    const childElements = [...element.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && !child.matches(".divider"),
    );
    node.children.forEach((child, index) => {
      const childElement = childElements[index];
      if (childElement == null) return;
      childElement.style.flexGrow = String(node.ratios[index]);
      this.#syncNode(child, childElement);
    });
  }

  /** 이름이 있으면 그 값, 없으면 시작 폴더를 고르는 중이라는 사실을 보인다. */
  #applyTabName(labelElement: HTMLElement, view: TabView | undefined): void {
    const nameElement = labelElement.querySelector<HTMLElement>(".tab-name");
    if (nameElement == null) return;
    if (view?.name != null) {
      setDataText(nameElement, view.name);
      setDataTooltip(labelElement, view.name);
      return;
    }
    if (this.#texts == null) return;
    setText(nameElement, this.#texts.choosingFolder);
    setDataTooltip(labelElement, this.#texts.choosingFolder);
  }

  // ---- 조작 ----

  #wirePaneFocus(paneElement: HTMLElement, paneId: string): void {
    // 화면 안 어디를 눌러 포커스가 들어오든 그 pane 이 입력을 받는 자리가 된다.
    paneElement.addEventListener("focusin", () => {
      if (this.#tree.focusedPaneId === paneId) return;
      this.#host.onFocusPane(paneId);
    });
  }

  #wireBodyDrop(bodyElement: HTMLElement, previewElement: HTMLElement, paneId: string): void {
    bodyElement.addEventListener("dragover", (event) => {
      const zone = this.#dropZoneAt(event, bodyElement, paneId);
      if (zone == null) {
        previewElement.hidden = true;
        return;
      }
      event.preventDefault();
      if (event.dataTransfer != null) event.dataTransfer.dropEffect = "move";
      previewElement.className = `drop-preview ${zone}`;
      previewElement.hidden = false;
    });
    bodyElement.addEventListener("dragleave", (event) => {
      const goingTo = event.relatedTarget;
      if (goingTo instanceof Node && bodyElement.contains(goingTo)) return;
      previewElement.hidden = true;
    });
    bodyElement.addEventListener("drop", (event) => {
      const zone = this.#dropZoneAt(event, bodyElement, paneId);
      previewElement.hidden = true;
      if (zone == null) return;
      event.preventDefault();
      this.#dropTab(zone, paneId);
    });
  }

  /** tab bar 는 분할 없이 삽입만 받는다 — 놓을 자리를 tab 사이 세로 선으로 보인다. */
  #wireTabBarDrop(
    tabBarElement: HTMLElement,
    insertLineElement: HTMLElement,
    paneId: string,
  ): void {
    tabBarElement.addEventListener("dragover", (event) => {
      const insert = this.#tabInsertAt(event, tabBarElement);
      if (insert == null) {
        insertLineElement.hidden = true;
        return;
      }
      event.preventDefault();
      if (event.dataTransfer != null) event.dataTransfer.dropEffect = "move";
      insertLineElement.style.left = `${insert.lineX}px`;
      insertLineElement.hidden = false;
    });
    tabBarElement.addEventListener("dragleave", (event) => {
      const goingTo = event.relatedTarget;
      if (goingTo instanceof Node && tabBarElement.contains(goingTo)) return;
      insertLineElement.hidden = true;
    });
    tabBarElement.addEventListener("drop", (event) => {
      const insert = this.#tabInsertAt(event, tabBarElement);
      insertLineElement.hidden = true;
      const drag = this.#drag;
      if (insert == null || drag == null) return;
      event.preventDefault();
      this.#host.onMoveTab(drag.tabId, paneId, "center", insert.index);
      this.#endDrag();
    });
  }

  /** tab bar 위 포인터의 삽입 자리와 선을 그을 x(바 기준). 드래그 중이 아니면 없음. */
  #tabInsertAt(
    event: DragEvent,
    tabBarElement: HTMLElement,
  ): { index: number; lineX: number } | undefined {
    if (this.#drag == null) return undefined;
    const barRect = tabBarElement.getBoundingClientRect();
    const rects = [...tabBarElement.querySelectorAll<HTMLElement>(".tab-label")].map((label) =>
      label.getBoundingClientRect(),
    );
    const index = resolveTabInsertIndex(event.clientX, rects);
    // 좌표는 화면 기준이라 스크롤된 만큼 되돌려야 bar 내용 기준이 된다.
    const lineX =
      (index < rects.length ? rects[index].left : (rects.at(-1)?.right ?? 0)) -
      barRect.left +
      tabBarElement.scrollLeft;
    return { index, lineX };
  }

  /** 놓을 수 있는 자리면 그 구역, 변화가 없거나 끄는 중이 아니면 없음. */
  #dropZoneAt(
    event: DragEvent,
    bodyElement: HTMLElement,
    paneId: string,
  ): DropPosition | undefined {
    const drag = this.#drag;
    if (drag == null) return undefined;
    const rect = bodyElement.getBoundingClientRect();
    const zone = resolveDropZone(event.clientX, event.clientY, rect);
    if (isUnchangedDrop(drag.sourcePaneId, drag.sourceTabCount, paneId, zone)) return undefined;
    return zone;
  }

  #dropTab(zone: DropPosition, paneId: string): void {
    const drag = this.#drag;
    if (drag == null) return;
    this.#host.onMoveTab(drag.tabId, paneId, zone);
    this.#endDrag();
  }

  #dragDivider(
    dividerElement: HTMLElement,
    direction: SplitDirection,
    path: readonly number[],
    boundaryIndex: number,
    pointerId: number,
  ): void {
    const splitElement = dividerElement.parentElement;
    if (splitElement == null) return;
    const childElements = [...splitElement.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && !child.matches(".divider"),
    );
    const firstElement = childElements[boundaryIndex];
    const secondElement = childElements[boundaryIndex + 1];
    if (firstElement == null || secondElement == null) return;

    const isHorizontal = direction === "horizontal";
    const firstRect = firstElement.getBoundingClientRect();
    const secondRect = secondElement.getBoundingClientRect();
    const pairStart = isHorizontal ? firstRect.left : firstRect.top;
    const pairEnd = isHorizontal ? secondRect.right : secondRect.bottom;
    const pairSum = ratioPairSum(this.#tree, path, boundaryIndex);
    if (pairSum == null) return;
    // 끄는 동안에는 경계선만 따라 움직인다. 배치를 바꾸는 것은 손을 뗀 뒤 한 번이다.
    let dragged: number | undefined;

    const onMove = (event: PointerEvent): void => {
      const pointer = isHorizontal ? event.clientX : event.clientY;
      const firstRatio = (pairSum * (pointer - pairStart)) / (pairEnd - pairStart);
      // 비율 0 이하는 불변식 위반이다 — 경계 밖으로 나간 포인터는 따라가지 않는다.
      if (firstRatio <= 0 || firstRatio >= pairSum) return;
      dragged = firstRatio;
      firstElement.style.flexGrow = String(firstRatio);
      secondElement.style.flexGrow = String(pairSum - firstRatio);
    };

    const onUp = (): void => {
      dividerElement.removeEventListener("pointermove", onMove);
      dividerElement.removeEventListener("pointerup", onUp);
      dividerElement.removeEventListener("lostpointercapture", onUp);
      if (dividerElement.hasPointerCapture(pointerId)) {
        dividerElement.releasePointerCapture(pointerId);
      }
      if (dragged != null) this.#host.onSetSplitRatio(path, boundaryIndex, dragged);
    };

    dividerElement.addEventListener("pointermove", onMove);
    dividerElement.addEventListener("pointerup", onUp);
    dividerElement.addEventListener("lostpointercapture", onUp);
  }

  #openTabMenu(tabId: string, labelElement: HTMLElement): void {
    const texts = this.#texts;
    const view = this.#host.tabView(tabId);
    if (texts == null || view == null) return;
    const items = [
      {
        label: texts.renameTab,
        run: () =>
          this.#overlays.openRename(
            tabId,
            labelElement.getBoundingClientRect(),
            view.name ?? "",
            texts.renameLabel,
            (raw) => this.#host.onRenameTab(tabId, raw),
          ),
      },
      { label: texts.closeTab, run: () => this.#host.onCloseTab(tabId) },
    ];
    this.#overlays.openMenu(tabId, labelElement.getBoundingClientRect(), items);
  }

  #endDrag(): void {
    this.#drag = undefined;
    for (const element of this.#containerElement.querySelectorAll<HTMLElement>(
      ".drop-preview, .tab-insert-line",
    )) {
      element.hidden = true;
    }
  }

}

/** 요소를 다시 만들어야 하는 변화인지 가리는 값. 비율·활성·포커스는 값 갱신으로 충분하다. */
function structureSignature(node: LayoutNode | null): string {
  if (node == null) return "";
  if (isPaneNode(node)) {
    return `pane(${node.paneId}:${node.tabs.map((tab) => tab.tabId).join(",")})`;
  }
  return `${node.direction}[${node.children.map((child) => structureSignature(child)).join("|")}]`;
}

function splitAt(tree: LayoutTree, path: readonly number[]): SplitNode | undefined {
  let node: LayoutNode | null = tree.root;
  for (const index of path) {
    if (node == null || isPaneNode(node)) return undefined;
    node = node.children[index] ?? null;
  }
  return node == null || isPaneNode(node) ? undefined : node;
}

function ratioPair(
  tree: LayoutTree,
  path: readonly number[],
  boundaryIndex: number,
): [number, number] | undefined {
  const split = splitAt(tree, path);
  if (split == null) return undefined;
  const first = split.ratios[boundaryIndex];
  const second = split.ratios[boundaryIndex + 1];
  return first == null || second == null ? undefined : [first, second];
}

function ratioPairSum(
  tree: LayoutTree,
  path: readonly number[],
  boundaryIndex: number,
): number | undefined {
  const pair = ratioPair(tree, path, boundaryIndex);
  return pair == null ? undefined : pair[0] + pair[1];
}
