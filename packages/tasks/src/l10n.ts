// 번역 조회 함수 (spec §4.9) — vscode 무의존 공용 계층.
// 호스트: activate 시 vscode.l10n.bundle 주입 / webview: HTML inline JSON 주입 / 테스트: 미주입 = 영문 폴백.

let bundle: Record<string, string> | undefined;

/** 번역 번들 주입 — undefined = 영문 폴백(번역 없는 locale·테스트). */
export function setL10nBundle(value: Record<string, string> | undefined): void {
  bundle = value;
}

/**
 * 키 = 영문 원문. 번들에 키 있으면 번역문, 없으면 원문(정상 폴백).
 * 자리표시자 = {0} 인덱스 나열 인자 — vscode.l10n.t 동형.
 */
export function t(message: string, ...args: readonly (string | number)[]): string {
  const template = bundle?.[message] ?? message;
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const arg = args[Number(index)];
    return arg == null ? placeholder : String(arg);
  });
}
