// daemon 의 구조화 상태 → webview 표시 상태 번역. daemon 은 번역할 수 없으므로
// 사유 코드가 여기서 비로소 글자가 된다. webview 계약(번역 완료 값만 수신)은 그대로다.

import { t, type LocalizedText } from "./l10n.ts";
import type { DaemonLayoutTree, DaemonSession } from "./daemon-protocol.ts";
import type { SessionEndCause, StartFailureCause } from "./session-causes.ts";
import { isPaneNode, type LayoutNode, type LayoutTree } from "./layout/layout-tree.ts";
import type { ViewSession } from "./webview-messages.ts";

export function translateStartFailure(cause: StartFailureCause): LocalizedText {
  const inner =
    cause.kind === "cwdMissing"
      ? t("The start folder does not exist: {0}", cause.cwd)
      : t("Could not start the shell: {0}", cause.detail);
  return t("Could not start a session: {0}", inner);
}

export function translateEndCause(cause: SessionEndCause): LocalizedText {
  switch (cause.kind) {
    case "endedBySignal":
      return t("The process was ended from outside.");
    case "exited":
      return t("The process exited with code {0}.", cause.exitCode);
    case "restoreFailed":
      return t("This session could not be restored after an extension update.");
    case "daemonLost":
      return t("The terminal service ended unexpectedly, so this session was lost.");
  }
}

export function toViewSessions(sessions: readonly DaemonSession[]): ViewSession[] {
  return sessions.map((session) => ({
    sessionId: session.sessionId,
    shellPath: session.shellPath,
    cwd: session.cwd,
    ...(session.exitedCause == null ? {} : { exitedText: translateEndCause(session.exitedCause) }),
  }));
}

export function toViewLayout(tree: DaemonLayoutTree): LayoutTree {
  return { ...tree, root: tree.root == null ? null : translateNode(tree.root) };
}

function translateNode(node: LayoutNode<StartFailureCause>): LayoutNode {
  if (!isPaneNode(node)) {
    return { ...node, children: node.children.map(translateNode) };
  }
  return {
    ...node,
    tabs: node.tabs.map((tab) => {
      const { startFailure, ...rest } = tab;
      return startFailure == null
        ? rest
        : { ...rest, startFailure: translateStartFailure(startFailure) };
    }),
  };
}
