// tasks 파일 모델 (spec §4.1) — .tasks 파일 텍스트 ↔ 줄 목록(항목·그룹 헤더) 변환.
// JSONL: 1줄 = {"text": "..."} 항목 1개 또는 {"group": "..."} 그룹 헤더 1개.
// 알 수 없는 필드 보존. vscode 무의존 순수 모듈.

/** 항목 (spec §6.1) — text 필수, 그 외 필드는 편집하지 않고 보존·되쓰기. */
export interface TaskItem extends Record<string, unknown> {
  readonly text: string;
}

/** 그룹 헤더 (spec §6.2) — group 필수. 이 줄 아래 연속 항목 줄이 소속. */
export interface GroupHeader extends Record<string, unknown> {
  readonly group: string;
}

/** 파일 1물리줄에 대응하는 레코드 — 항목 또는 그룹 헤더. */
export type TaskLine = TaskItem | GroupHeader;

/** group 필드 존재 = 그룹 헤더 줄 (spec §5.2). */
export function isGroupHeader(line: TaskLine): line is GroupHeader {
  return typeof line["group"] === "string";
}

/** 접힘 판정 — true 만 접힘, 없음·비boolean 등 그 외 값은 전부 펼침 (spec §6.2, 사용자 확정). */
export function isCollapsed(header: GroupHeader): boolean {
  return header["collapsed"] === true;
}

/** 파싱 결과 — 파싱 불가 줄이 하나라도 있으면 오류(부분 성공 없음). */
export type ParseTasksResult =
  | { readonly ok: true; readonly lines: TaskLine[] }
  | { readonly ok: false; readonly line: number; readonly message: string };

/** 파일 전체 텍스트 → 줄 목록. 공백만인 줄은 무시(직렬화 시 재생성 안 함). */
export function parseTasksFile(content: string): ParseTasksResult {
  const lines: TaskLine[] = [];
  const rawLines = content.split("\n");
  for (let index = 0; index < rawLines.length; index++) {
    const rawLine = rawLines[index]!;
    if (rawLine.trim() === "") continue; // 빈 줄·공백만 — 무시
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      return { ok: false, line: lineNumber, message: `line ${lineNumber}: invalid JSON` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, line: lineNumber, message: `line ${lineNumber}: not a JSON object` };
    }
    const raw = parsed as Record<string, unknown>;
    // text 와 group 을 둘 다 가진 줄 = 파싱 불가 (spec §4.1 경계)
    if ("text" in raw && "group" in raw) {
      return {
        ok: false,
        line: lineNumber,
        message: `line ${lineNumber}: has both "text" and "group"`,
      };
    }
    if ("group" in raw) {
      if (typeof raw["group"] !== "string") {
        return {
          ok: false,
          line: lineNumber,
          message: `line ${lineNumber}: "group" is not a string`,
        };
      }
      lines.push(raw as GroupHeader);
      continue;
    }
    if (typeof raw["text"] !== "string") {
      return { ok: false, line: lineNumber, message: `line ${lineNumber}: "text" is not a string` };
    }
    lines.push(raw as TaskItem);
  }
  return { ok: true, lines };
}

/** 줄 목록 → 파일 전체 텍스트 (1레코드 1물리줄 — \n 은 JSON 이스케이프로 담김). */
export function serializeTaskLines(lines: readonly TaskLine[]): string {
  return lines.map((line) => JSON.stringify(line) + "\n").join("");
}
