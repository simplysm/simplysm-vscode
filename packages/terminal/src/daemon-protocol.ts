// 확장 호스트 ↔ daemon 사이의 IPC 계약. 전송로는 named pipe(unix 는 domain socket)이며,
// 메시지는 줄 단위 JSON 이다. 출력 바이트는 JSON 에 싣기 위해 base64 로 담는다.
// 세션·배치의 진실은 daemon 에 있고, 확장 호스트는 조작·출력을 중계만 한다.

import { StringDecoder } from "node:string_decoder";
import type { LayoutTree } from "./layout/layout-tree.ts";
import type { DropPosition } from "./layout/layout-operations.ts";
import type { SessionEndCause, StartFailureCause } from "./session-causes.ts";

/**
 * ---- 동결 계층 ----
 * 어떤 버전의 확장·daemon 끼리도 통해야 하는 최소 형식. **절대 변경 금지.**
 * 줄 단위 JSON 프레이밍 · hello(version 포함) · dump 요청/응답 · shutdown 이 여기 속한다.
 * 버전 키는 daemon 번들(dist/daemon.cjs) 내용 해시다 — 수동 관리 없음.
 */

/** [동결] 덤프된 탭 하나 — 이름·셸·cwd·직렬화 화면(표준 VT escape sequence, base64). */
export interface DumpTab {
  readonly name?: string;
  readonly shellPath: string;
  readonly cwd: string;
  readonly screenBase64: string;
}

/** 셸을 띄울 때 물려줄 값. 셸 경로와 환경은 확장 호스트만 알 수 있다. */
export interface ShellSpec {
  readonly shellPath: string;
  readonly env: Record<string, string>;
}

/** daemon 이 쥔 세션 하나. 표시 문구 대신 구조화 사유를 담는다 — 번역은 확장 호스트 몫이다. */
export interface DaemonSession {
  readonly sessionId: string;
  readonly shellPath: string;
  readonly cwd: string;
  readonly exitedCause?: SessionEndCause;
}

/** daemon 이 쥔 배치 — 시작 실패 사유가 구조화되어 있다. */
export type DaemonLayoutTree = LayoutTree<StartFailureCause>;

export type ExtensionToDaemon =
  /**
   * 연결 직후 한 번(설정이 바뀌면 다시). 셸을 띄울 준비물과 화면 유지 깊이를 건넨다.
   * daemon 이 이미 세션을 쥐고 있으면(재연결) 준비물만 갈아끼우고 세션은 그대로 둔다.
   */
  | { readonly type: "init"; readonly shell: ShellSpec; readonly scrollback: number }
  /**
   * 세션별 화면 내용(직렬화된 VT 시퀀스)을 output 으로 다시 보내 달라.
   * 새로 만들어진 webview 가 지난 화면을 그릴 때 쓴다.
   */
  | { readonly type: "replay" }
  /** [동결] 탭 구성을 덤프해 달라 — 버전이 어긋난 구 daemon 에서 화면·탭 회수용. */
  | { readonly type: "dump" }
  /** [동결] 셸을 모두 정리하고 스스로 끝나라. */
  | { readonly type: "shutdown" }
  /** 구 daemon 에서 회수한 탭들을 같은 구성으로, 전부 종료 상태로 되살려라. */
  | { readonly type: "restoreDump"; readonly tabs: readonly DumpTab[] }
  | { readonly type: "newTab"; readonly paneId?: string }
  | { readonly type: "startSession"; readonly tabId: string; readonly cwd: string }
  | { readonly type: "closeTab"; readonly tabId: string }
  | { readonly type: "renameTab"; readonly tabId: string; readonly name?: string }
  | {
      readonly type: "moveTab";
      readonly tabId: string;
      readonly targetPaneId: string;
      readonly position: DropPosition;
    }
  | { readonly type: "setActiveTab"; readonly paneId: string; readonly tabId: string }
  | { readonly type: "setFocusedPane"; readonly paneId: string }
  | {
      readonly type: "setSplitRatio";
      readonly splitPath: readonly number[];
      readonly boundaryIndex: number;
      readonly firstRatio: number;
    }
  | {
      readonly type: "input";
      readonly sessionId: string;
      readonly data: string;
      readonly binary: boolean;
    }
  | {
      readonly type: "resize";
      readonly sessionId: string;
      readonly rows: number;
      readonly cols: number;
    };

export type DaemonToExtension =
  /**
   * [동결] 연결 직후 daemon 의 첫마디. 거절이면 곧바로 연결이 닫힌다 — 같은 워크스페이스의
   * 후발 창이다. restored 는 daemon 이 이전 연결의 세션들을 쥔 채 기다리고 있었다는 뜻이고
   * (reload 복원), version 은 daemon 자신의 번들 내용 해시다.
   */
  | {
      readonly type: "hello";
      readonly accepted: boolean;
      readonly restored: boolean;
      readonly version: string;
    }
  /** [동결] dump 요청의 응답. */
  | { readonly type: "dump"; readonly tabs: readonly DumpTab[] }
  | {
      readonly type: "state";
      readonly layout: DaemonLayoutTree;
      readonly sessions: readonly DaemonSession[];
    }
  | { readonly type: "output"; readonly sessionId: string; readonly bytesBase64: string }
  /**
   * replay 의 응답 — 직렬화 당시의 화면 크기를 함께 싣는다. 새 webview 는 이 크기로 맞춘 뒤
   * 재생해야 줄바꿈·커서 이동이 어긋나지 않는다.
   */
  | {
      readonly type: "replayScreen";
      readonly sessionId: string;
      readonly dataBase64: string;
      readonly rows: number;
      readonly cols: number;
    }
  /** 조작이 실패했다. 응답을 기다리지 않는 조작이므로 사실만 알린다. */
  | { readonly type: "operationFailed"; readonly context: string; readonly detail: string };

export function encodeMessage(message: ExtensionToDaemon | DaemonToExtension): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * 소켓 청크를 줄 단위 JSON 으로 되살린다. 청크 경계가 메시지 경계와 다른 것을 흡수하고,
 * UTF-8 멀티바이트 문자 중간에서 잘린 청크도 StringDecoder 가 경계를 보존해 깨지지 않는다.
 */
export function createLineDecoder(onMessage: (message: unknown) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return (chunk) => {
    pending += decoder.write(chunk);
    for (;;) {
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      if (line.length > 0) onMessage(JSON.parse(line));
    }
  };
}
