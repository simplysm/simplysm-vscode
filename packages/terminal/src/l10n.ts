// 표시 문자열 조회 — 확장 호스트와 webview 가 함께 쓰는 vscode 무의존 계층.
// 번들 출처: 호스트 = vscode.l10n.bundle, webview = 호스트가 주입, 테스트 = 미주입(영문 폴백).

declare const localizedTextBrand: unique symbol;

/** 번역을 거친 표시 문자열. 화면·알림에 글자를 넣는 자리는 이 타입만 받는다. */
export type LocalizedText = string & { readonly [localizedTextBrand]: true };

let bundle: Record<string, string> | undefined;

/** 번역 번들 주입 — undefined 는 번역이 없는 언어이며 영문 원문이 나온다. */
export function setL10nBundle(value: Record<string, string> | undefined): void {
  bundle = value;
}

/** 키 = 영문 원문. 자리 표시자는 `{0}` 인덱스이며 인자가 없으면 그대로 남는다. */
export function t(message: string, ...args: readonly (string | number)[]): LocalizedText {
  const template = bundle?.[message] ?? message;
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const arg = args[Number(index)];
    return arg == null ? placeholder : String(arg);
  }) as LocalizedText;
}
