// 뷰 안에서 누른 Alt 가 VS Code 메뉴 막대로 포커스를 옮기지 않게 한다.
//
// VS Code(Windows·Linux)는 다른 키 없이 Alt 만 눌렀다 떼면 메뉴 막대로 포커스를 옮긴다. "다른 키 없이"는
// Alt 를 누른 뒤 다른 키의 keydown 을 받았는지로 판정한다. webview 는 뷰의 window 까지 전파된 키 이벤트만
// VS Code 에 넘기는데, 에뮬레이터가 처리한 키(Alt+V 등)는 에뮬레이터가 전파를 끊는다. 그래서 Alt 를
// 먼저 떼면 VS Code 는 Alt+V 를 Alt 단독으로 보고 메뉴 막대로 간다.
//
// 그 keydown 을 VS Code 에 넘겨 주는 길은 쓸 수 없다. VS Code 가 Alt+글자를 메뉴 단축 문자로도
// 처리해(Alt+V = 보기 메뉴) keybinding 으로 덮어도 메뉴가 열린다. 대신 Ctrl·Meta 없이 Alt 가 낀
// keydown 을 VS Code 에 넘기지 않는다. VS Code 는 Alt 누름을 keydown 으로만 알아차리므로, 뷰에서
// 누른 Alt 는 조합키든 단독이든 메뉴 막대를 움직이지 않는다.
//
// Ctrl·Meta 가 낀 keydown 은 그대로 넘긴다. Ctrl+Alt 로 시작하는 VS Code 단축키가 동작해야 하고,
// Ctrl·Meta 가 눌린 동안의 Alt 는 VS Code 가 메뉴 막대로 가는 판정에 쓰지 않는다.
// keyup 도 그대로 넘긴다. VS Code 는 keyup 만으로는 Alt 누름을 시작하지 않는다.
// macOS 의 VS Code 는 Alt(Option) 로 메뉴 막대에 가지 않으므로 건드리지 않는다.

interface KeyEventLike {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** VS Code 에 넘기지 않을 keydown 인가 — Ctrl·Meta 없이 Alt 가 낀 keydown 이다(Alt 키 자신도 포함). */
export function isPlainAltKeydown(event: KeyEventLike): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey;
}

/**
 * 뷰 문서에 건다. 문서의 전파 단계에서 멈추므로 에뮬레이터와 뷰의 다른 처리는 이 keydown 을 그대로 받고,
 * window 에서 키를 받아 VS Code 에 넘기는 webview 호스트만 못 받는다.
 */
export function keepPlainAltInView(doc: Document): void {
  if (navigator.userAgent.includes("Macintosh")) return;
  doc.addEventListener("keydown", (event) => {
    if (isPlainAltKeydown(event)) event.stopPropagation();
  });
}
