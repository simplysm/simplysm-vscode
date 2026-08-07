// tab 위에 잠깐 뜨는 것들 — 우클릭 메뉴와 이름 바꾸기 입력창.
// 배치를 다시 그려도 사라지지 않게 pane 바깥 자리에 띄우고, 열려 있는 것은 언제나 하나다.

import type { LocalizedText } from "../../l10n.ts";
import { setLabel, setText } from "../dom-text.ts";

export interface MenuItem {
  readonly label: LocalizedText;
  readonly run: () => void;
}

/** 아래 공간이 모자라면 위쪽으로 펼친다. */
function place(element: HTMLElement, anchor: DOMRect, hostRect: DOMRect): void {
  element.style.left = `${anchor.left - hostRect.left}px`;
  const belowTop = anchor.bottom - hostRect.top;
  const fitsBelow = anchor.bottom + element.offsetHeight <= hostRect.bottom;
  if (fitsBelow) {
    element.style.top = `${belowTop}px`;
    return;
  }
  element.style.top = `${anchor.top - hostRect.top - element.offsetHeight}px`;
}

export class Overlays {
  readonly #hostElement: HTMLElement;
  #element?: HTMLElement;
  /** 열려 있는 것이 어느 tab 의 것인가. 그 세션이 끝나면 닫아야 한다. */
  #tabId?: string;

  constructor(hostElement: HTMLElement) {
    this.#hostElement = hostElement;
    document.addEventListener("pointerdown", (event) => {
      if (this.#element == null) return;
      if (event.target instanceof Node && this.#element.contains(event.target)) return;
      this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
    });
  }

  openMenu(tabId: string, anchor: DOMRect, items: readonly MenuItem[]): void {
    const menuElement = this.#open(tabId, "tab-menu");
    for (const item of items) {
      const itemElement = document.createElement("button");
      itemElement.className = "tab-menu-item";
      setText(itemElement, item.label);
      itemElement.addEventListener("click", () => {
        this.close();
        item.run();
      });
      menuElement.appendChild(itemElement);
    }
    place(menuElement, anchor, this.#hostElement.getBoundingClientRect());
  }

  /** 현재 표시 이름을 채워 둔 입력창. Enter 로 확정하고 Esc 와 바깥 조작으로 버린다. */
  openRename(
    tabId: string,
    anchor: DOMRect,
    currentName: string,
    label: LocalizedText,
    commit: (raw: string) => void,
  ): void {
    const boxElement = this.#open(tabId, "tab-rename");
    const inputElement = document.createElement("input");
    inputElement.className = "tab-rename-input";
    inputElement.type = "text";
    setLabel(inputElement, label);
    inputElement.value = currentName;
    inputElement.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const raw = inputElement.value;
        this.close();
        commit(raw);
        return;
      }
      if (event.key === "Escape") {
        // 입력창을 닫는 Esc 가 터미널로도 흘러가면 셸이 그 키를 받는다.
        event.stopPropagation();
        this.close();
      }
    });
    boxElement.appendChild(inputElement);
    boxElement.style.width = `${Math.max(anchor.width, 140)}px`;
    place(boxElement, anchor, this.#hostElement.getBoundingClientRect());
    inputElement.focus();
    inputElement.select();
  }

  /** 그 tab 의 것이 떠 있으면 닫는다. */
  closeFor(tabId: string): void {
    if (this.#tabId !== tabId) return;
    this.close();
  }

  close(): void {
    this.#element?.remove();
    this.#element = undefined;
    this.#tabId = undefined;
  }

  #open(tabId: string, className: string): HTMLElement {
    this.close();
    const element = document.createElement("div");
    element.className = className;
    this.#hostElement.appendChild(element);
    this.#element = element;
    this.#tabId = tabId;
    return element;
  }
}
