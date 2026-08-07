// 현재 테마의 터미널 색을 읽어 색 팔레트를 만든다. 확장 호스트에는 색 값을 얻을 수단이 없어
// webview 에 주입된 테마 CSS 변수가 유일한 출처다.
//
// 이 변수들은 VS Code 가 기본값 사슬까지 해석한 최종 값이라 내장 터미널이 쓰는 값과 같다.
// 별도 대체 규칙이 필요한 것은 등록 기본값이 없는 터미널 배경·커서 색뿐이며, 내장 터미널과
// 같은 규칙(자기가 놓인 자리의 배경)으로 채운다.

/** 표시 옵션의 색 팔레트. */
export interface ColorPalette {
  readonly background: string;
  readonly foreground: string;
  readonly cursorForeground: string;
  readonly cursorBackground: string;
  /** 기본 8색 + 밝은 8색. 값이 안 온 색이 있으면 없음이며 에뮬레이터 기본 팔레트를 쓴다. */
  readonly ansi?: readonly string[];
  readonly selectionBackground: string;
  /** 테마가 정의하지 않으면 없음 — 원래 글자색을 유지하라는 뜻이다. */
  readonly selectionForeground?: string;
  readonly inactiveSelectionBackground: string;
  readonly findMatchBackground: string;
  readonly findMatchBorder?: string;
  readonly findMatchHighlightBackground: string;
  readonly findMatchHighlightBorder?: string;
}

const ansiColorNames = [
  "Black",
  "Red",
  "Green",
  "Yellow",
  "Blue",
  "Magenta",
  "Cyan",
  "White",
  "BrightBlack",
  "BrightRed",
  "BrightGreen",
  "BrightYellow",
  "BrightBlue",
  "BrightMagenta",
  "BrightCyan",
  "BrightWhite",
] as const;

function readVariable(style: CSSStyleDeclaration, name: string): string | undefined {
  const value = style.getPropertyValue(`--vscode-${name}`).trim();
  return value.length === 0 ? undefined : value;
}

export function readColorPalette(): ColorPalette {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string): string | undefined => readVariable(style, name);
  const requireColor = (name: string): string => {
    const value = read(name);
    if (value == null) {
      throw new Error(`The webview theme did not provide the color "${name}".`);
    }
    return value;
  };

  // 내장 터미널도 terminal.background 가 없으면 자기가 놓인 자리의 배경을 쓴다. 이 화면은 panel 에
  // 있으므로 panel 배경이 그 자리 값이다 (근거: VS Code 1.127 설치본 — 터미널 배경 조회가
  // `getColor(terminal.background) || getColor(<놓인 자리 배경>)` 순서). panel 배경은 등록
  // 기본값이 있어 항상 채워져 온다.
  const background = read("terminal-background") ?? requireColor("panel-background");
  const foreground = requireColor("terminal-foreground");

  const ansi = ansiColorNames.map((name) => read(`terminal-ansi${name}`));

  const palette: Record<string, unknown> = {
    background,
    foreground,
    cursorForeground: read("terminalCursor-foreground") ?? foreground,
    cursorBackground: read("terminalCursor-background") ?? background,
    selectionBackground: requireColor("terminal-selectionBackground"),
    inactiveSelectionBackground: requireColor("terminal-inactiveSelectionBackground"),
    findMatchBackground: requireColor("terminal-findMatchBackground"),
    findMatchHighlightBackground: requireColor("terminal-findMatchHighlightBackground"),
  };
  // 선택 필드로 규정한 색의 없음은 "원래 값을 유지하라" 는 뜻이라 임의 색으로 채우지 않는다.
  for (const [field, name] of [
    ["selectionForeground", "terminal-selectionForeground"],
    ["findMatchBorder", "terminal-findMatchBorder"],
    ["findMatchHighlightBorder", "terminal-findMatchHighlightBorder"],
  ] as const) {
    const color = read(name);
    if (color != null) palette[field] = color;
  }
  if (ansi.every((color) => color != null)) palette.ansi = ansi;

  return palette as unknown as ColorPalette;
}
