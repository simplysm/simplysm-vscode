// 포커스 pane 위에 뜨는 검색창. 대상 화면에서 찾는 일은 밖(컨트롤러)이 하고,
// 이 모듈은 입력·이동 버튼·결과 표시만 담당한다.

import type { LocalizedText } from "../../l10n.ts";
import { setDataText, setLabel, setText } from "../dom-text.ts";
import type { SearchResultState } from "../terminal-screen.ts";

export interface SearchBarTexts {
  readonly label: LocalizedText;
  readonly previous: LocalizedText;
  readonly next: LocalizedText;
  readonly close: LocalizedText;
  readonly noResults: LocalizedText;
}

export interface SearchBarHandlers {
  /** 입력이 바뀌었다. 빈 값이면 강조를 지워야 한다. */
  readonly onQueryChange: (term: string) => void;
  readonly onNext: (term: string) => void;
  readonly onPrevious: (term: string) => void;
  readonly onClose: () => void;
}

export class SearchBar {
  readonly #hostElement: HTMLElement;
  readonly #handlers: SearchBarHandlers;
  #element?: HTMLElement;
  #inputElement?: HTMLInputElement;
  #resultElement?: HTMLElement;
  #texts?: SearchBarTexts;

  constructor(hostElement: HTMLElement, handlers: SearchBarHandlers) {
    this.#hostElement = hostElement;
    this.#handlers = handlers;
  }

  get isOpen(): boolean {
    return this.#element != null;
  }

  get term(): string {
    return this.#inputElement?.value ?? "";
  }

  /** 이미 열려 있으면 입력만 다시 포커스한다 — 치던 검색어를 지우지 않는다. */
  open(texts: SearchBarTexts, paneRect: DOMRect): void {
    this.#texts = texts;
    if (this.#element == null) this.#build(texts);
    this.reposition(paneRect);
    this.#inputElement?.focus();
    this.#inputElement?.select();
  }

  close(): void {
    if (this.#element == null) return;
    this.#element.remove();
    this.#element = undefined;
    this.#inputElement = undefined;
    this.#resultElement = undefined;
    this.#handlers.onClose();
  }

  /** 포커스 pane 이 바뀌거나 배치가 다시 그려지면 그 pane 의 오른쪽 위로 따라간다. */
  reposition(paneRect: DOMRect): void {
    const element = this.#element;
    if (element == null) return;
    const hostRect = this.#hostElement.getBoundingClientRect();
    element.style.top = `${paneRect.top - hostRect.top}px`;
    element.style.right = `${hostRect.right - paneRect.right}px`;
  }

  /** 결과 표시 — 검색어가 없으면 비우고, 0건이면 그 사실을 보인다. */
  setResult(state: SearchResultState | undefined): void {
    const resultElement = this.#resultElement;
    if (resultElement == null) return;
    if (this.term.length === 0 || state == null) {
      setDataText(resultElement, "");
      resultElement.classList.remove("no-results");
      return;
    }
    if (state.resultCount === 0) {
      if (this.#texts != null) setText(resultElement, this.#texts.noResults);
      resultElement.classList.add("no-results");
      return;
    }
    resultElement.classList.remove("no-results");
    // 상한 초과로 인덱스를 모르는 경우(-1)는 총 건수만 보인다.
    setDataText(
      resultElement,
      state.resultIndex >= 0
        ? `${state.resultIndex + 1}/${state.resultCount}`
        : `${state.resultCount}`,
    );
  }

  #build(texts: SearchBarTexts): void {
    const element = document.createElement("div");
    element.className = "search-bar";

    const inputElement = document.createElement("input");
    inputElement.className = "search-input";
    inputElement.type = "text";
    setLabel(inputElement, texts.label);
    inputElement.addEventListener("input", () => this.#handlers.onQueryChange(inputElement.value));
    inputElement.addEventListener("keydown", (event) => {
      // 입력창의 키가 터미널·다른 UI 로 흐르면 안 된다.
      event.stopPropagation();
      if (event.key === "Enter" && event.shiftKey) this.#handlers.onPrevious(inputElement.value);
      else if (event.key === "Enter") this.#handlers.onNext(inputElement.value);
      else if (event.key === "Escape") this.close();
    });

    const resultElement = document.createElement("span");
    resultElement.className = "search-result";

    const previousElement = document.createElement("button");
    previousElement.className = "search-button codicon codicon-arrow-up";
    setLabel(previousElement, texts.previous);
    previousElement.addEventListener("click", () =>
      this.#handlers.onPrevious(inputElement.value),
    );

    const nextElement = document.createElement("button");
    nextElement.className = "search-button codicon codicon-arrow-down";
    setLabel(nextElement, texts.next);
    nextElement.addEventListener("click", () => this.#handlers.onNext(inputElement.value));

    const closeElement = document.createElement("button");
    closeElement.className = "search-button codicon codicon-close";
    setLabel(closeElement, texts.close);
    closeElement.addEventListener("click", () => this.close());

    element.append(inputElement, resultElement, previousElement, nextElement, closeElement);
    this.#hostElement.appendChild(element);
    this.#element = element;
    this.#inputElement = inputElement;
    this.#resultElement = resultElement;
  }
}
