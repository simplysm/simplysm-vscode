// 출력 한 줄에서 파일 경로 꼴을 찾는다. URL 인식은 에뮬레이터 부가기능 몫이고, 파일 경로 인식은
// 거기에 없어 자체로 만든다.

export interface FileLinkMatch {
  /** 밑줄을 그을 구간 — 경로에 줄·열 표기가 붙어 있으면 그 표기까지 포함한다. */
  readonly startIndex: number;
  readonly length: number;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

// 경로 본체 + 선택적 줄·열 표기(`:12:3` 또는 `(7,2)`). 본체는 세 꼴이다:
// - 절대(`C:\…`, POSIX `/…` — Remote-SSH 리눅스 세션 출력)·접두 상대(`.\…`·`..\…`) —
//   글자에서 공백·콜론·괄호·따옴표류를 뺀다.
// - 접두 없는 상대(`src\util.ts`) — 구분자를 하나 이상 두고 끝 조각에 확장자가 있어야 한다.
//   tsc 등 빌드 도구가 이 꼴로 찍는다.
// - 구분자 없는 파일명(`util.ts`) — 오인이 많아 줄·열 표기가 붙어 있을 때만 경로로 본다.
const fileLinkPattern =
  /((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)[^\s:*?"'<>|()[\]]+|[\w.-]+(?:[\\/][\w.-]+)*[\\/][\w-]+(?:\.[\w-]+)+|[\w-]+(?:\.[\w-]+)+(?=:\d|\(\d))(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))?/g;

/** 줄 끝 문장부호는 경로가 아니라 문장의 것이다. */
function trimTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;]+$/, "");
}

export function detectFileLinks(lineText: string): FileLinkMatch[] {
  const matches: FileLinkMatch[] = [];
  for (const match of lineText.matchAll(fileLinkPattern)) {
    // URL 등 다른 무언가의 꼬리 조각이다 — 앞이 경로·단어 글자면 독립된 경로가 아니다.
    const precedingChar = match.index > 0 ? lineText[match.index - 1] : undefined;
    if (precedingChar != null && /[\w.:\\/-]/.test(precedingChar)) continue;
    const lineNumberText = match[2] ?? match[4];
    const columnNumberText = match[3] ?? match[5];

    // 줄·열 표기를 뗀 경로 본체를 얻는다.
    const suffixPattern = /(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))$/;
    const wholeText = match[0];
    const pathText = trimTrailingPunctuation(wholeText.replace(suffixPattern, ""));
    if (pathText.length === 0) continue;
    const linkedLength = suffixPattern.test(wholeText) ? wholeText.length : pathText.length;

    matches.push({
      startIndex: match.index,
      length: linkedLength,
      path: pathText,
      ...(lineNumberText == null ? {} : { line: Number(lineNumberText) }),
      ...(columnNumberText == null ? {} : { column: Number(columnNumberText) }),
    });
  }
  return matches;
}
