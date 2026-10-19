import * as vscode from "vscode";
import { formatDateTimeIn, formatRangeIn, formatTimeIn } from "./time-text.ts";

// 시각 표기 (spec 「3. 열람」 변경 목록) — VS Code 표시 언어의 형식으로, 초까지 적는다. OS 지역 설정을 따르지 않는다.
// 시각대는 로컬이다. 줄 라벨 · diff 제목 · 확인 창 등 시각을 사용자에게 보이는 곳은 모두 이 함수를 쓴다.
// 규칙은 `time-text.ts`(vscode 비의존) 에 있고, 여기서는 표시 언어만 넣는다.

export { isSameDay } from "./time-text.ts";

/** 날짜 + 시각(초까지). */
export function formatDateTime(at: number): string {
  return formatDateTimeIn(vscode.env.language, at);
}

/** 시각(초까지)만 — 같은 날의 줄에 쓴다. */
export function formatTime(at: number): string {
  return formatTimeIn(vscode.env.language, at);
}

/** 범위의 두 시각 — 끝은 시작과 같은 날이면 시각만 (diff 제목). */
export function formatRange(fromAt: number, toAt: number): [string, string] {
  return formatRangeIn(vscode.env.language, fromAt, toAt);
}
