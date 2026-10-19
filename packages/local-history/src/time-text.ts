// 시각 표기 규칙 (spec 「3. 열람」) — vscode 에 의존하지 않아 단위 테스트한다. 표시 언어는 부르는 쪽이 준다.
// 확장에서는 `time-format.ts` 가 VS Code 표시 언어를 넣어 부른다. 시각대는 로컬이다.

interface Formats {
  readonly dateTime: Intl.DateTimeFormat;
  readonly time: Intl.DateTimeFormat;
}

const formats = new Map<string, Formats>();

function formatsOf(language: string): Formats {
  let cached = formats.get(language);
  if (cached === undefined) {
    const time = { hour: "numeric", minute: "2-digit", second: "2-digit" } as const;
    cached = {
      dateTime: new Intl.DateTimeFormat(language, {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        ...time,
      }),
      time: new Intl.DateTimeFormat(language, time),
    };
    formats.set(language, cached);
  }
  return cached;
}

/** 날짜 + 시각(초까지). */
export function formatDateTimeIn(language: string, at: number): string {
  return formatsOf(language).dateTime.format(at);
}

/** 시각(초까지)만. */
export function formatTimeIn(language: string, at: number): string {
  return formatsOf(language).time.format(at);
}

/** 로컬 시각대에서 같은 날인지 — 표기와 같은 시각대로 날짜 경계를 정한다. */
export function isSameDay(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * 범위의 두 시각 (spec 「3. 열람」 diff 제목) — 시작은 날짜 + 시각, 끝은 시작과 같은 날이면 시각만.
 */
export function formatRangeIn(language: string, fromAt: number, toAt: number): [string, string] {
  return [
    formatDateTimeIn(language, fromAt),
    isSameDay(fromAt, toAt) ? formatTimeIn(language, toAt) : formatDateTimeIn(language, toAt),
  ];
}
