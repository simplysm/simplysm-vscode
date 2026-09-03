// 확장 호스트의 진단·알림 출입구. 실패는 알림을 띄우지 않고 출력 채널에만 쌓는다 —
// 사용자가 방금 한 조작의 결과는 화면에 그대로 드러나므로, 같은 사실을 알림으로 되풀이하지 않는다.
// 사용자 조작 없이 벌어진 일(업데이트로 인한 복원 불가 등)만 warn 알림으로 고지한다.

import * as vscode from "vscode";
import type { LocalizedText } from "./l10n.ts";

let diagnostics: vscode.LogOutputChannel | undefined;

/** 진단을 남길 출력 채널을 준다. 없으면 진단은 아무 데도 남지 않는다. */
export function setDiagnosticsChannel(channel: vscode.LogOutputChannel): void {
  diagnostics = channel;
}

export function logFailure(summary: string, detail?: string): void {
  diagnostics?.error(detail == null ? summary : `${summary} — ${detail}`);
}

/** 문제일 수 있으나 확정은 아닌 사실 — 알림 없이 출력 채널에만 남긴다. */
export function logWarning(summary: string): void {
  diagnostics?.warn(summary);
}

/** 시작 경로의 이정표 — 화면이 비었을 때 어디까지 왔는지 출력 채널만으로 가리기 위한 기록. */
export function logInfo(summary: string): void {
  diagnostics?.info(summary);
}

/** 문제는 아니지만 사용자가 인지해야 할 사실을 warn 알림으로 띄운다. 번역을 거친 값만 받는다. */
export function warnUser(message: LocalizedText): void {
  diagnostics?.warn(message);
  void vscode.window.showWarningMessage(message);
}

/** 되돌릴 수 없는 조작 앞의 확인. 사용자가 그 행동 버튼을 골랐을 때만 참. 번역을 거친 값만 받는다. */
export async function confirmWarning(message: LocalizedText, action: LocalizedText): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, action);
  return choice === action;
}
