// webview 화면에 글자를 넣는 출입구. 번역을 거친 값과 사용자 데이터를 나눠 받아,
// 번역이 빠진 원문이 화면에 닿는 경로를 만들지 않는다.

import type { LocalizedText } from "../l10n.ts";

/** 확장 호스트가 번역해 보낸 표시 문자열. */
export function setText(element: HTMLElement, text: LocalizedText): void {
  element.textContent = text;
}

/** 경로·이름처럼 번역 대상이 아닌 값. 셸 출력과 같은 성격이라 원문 그대로 보인다. */
export function setDataText(element: HTMLElement, value: string): void {
  element.textContent = value;
}

/** 잘려 보이는 값의 전체를 확인하는 툴팁. 값은 사용자 환경에서 온 것이라 번역하지 않는다. */
export function setDataTooltip(element: HTMLElement, value: string): void {
  element.title = value;
}

/** 표시 문자열로 다는 설명. 버튼·입력창처럼 글자 없이 그리는 요소가 대상이다. */
export function setLabel(element: HTMLElement, text: LocalizedText): void {
  element.ariaLabel = text;
  element.title = text;
}
