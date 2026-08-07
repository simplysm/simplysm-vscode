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

/** 문제는 아니지만 사용자가 인지해야 할 사실을 warn 알림으로 띄운다. 번역을 거친 값만 받는다. */
export function warnUser(message: LocalizedText): void {
  diagnostics?.warn(message);
  void vscode.window.showWarningMessage(message);
}
