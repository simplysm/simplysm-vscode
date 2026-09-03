// 확장 호스트에서 daemon 으로 붙는 연결. daemon 이 없으면 detached 로 띄우고 다시 붙는다.
// 조작은 응답을 기다리지 않는다 — 결과는 state·output·operationFailed 통지로 돌아온다.
// vscode 무의존 계층 — VS Code API 는 부르는 쪽(extension.ts)이 쓴다.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createLineDecoder,
  encodeMessage,
  type DaemonLayoutTree,
  type DaemonSession,
  type DaemonToExtension,
  type DumpTab,
  type ExtensionToDaemon,
} from "./daemon-protocol.ts";

/** daemon 을 띄우고 붙기까지 기다리는 한도. 넘으면 실패로 드러낸다. */
const connectTimeoutMs = 5_000;
const connectRetryIntervalMs = 100;

/** pipe 를 쥔 daemon 이 연결은 받았는데 첫마디를 하지 않는다 — 없는 것이 아니므로 새로 띄우면 안 된다. */
export class DaemonUnresponsiveError extends Error {
  constructor() {
    super("The terminal daemon accepted the connection but did not answer.");
  }
}

/** 같은 워크스페이스의 다른 창이 이미 daemon 을 쥐고 있어 거절당했다. */
export class DaemonRejectedError extends Error {
  constructor() {
    super("Another window already owns the terminal daemon for this workspace.");
  }
}

/** 워크스페이스+프로필마다 daemon 이 하나 — pipe 이름은 워크스페이스 저장소 경로의 해시다. */
export function pipePathForWorkspace(workspaceKey: string): string {
  // Windows 경로는 대소문자를 가리지 않는다. 같은 폴더가 다른 pipe 로 갈리면 안 된다.
  const normalizedKey = process.platform === "win32" ? workspaceKey.toLowerCase() : workspaceKey;
  const hash = createHash("sha256").update(normalizedKey).digest("hex").slice(0, 16);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\simplysm-terminal-${hash}`
    : path.join(os.tmpdir(), `simplysm-terminal-${hash}.sock`);
}

export interface DaemonClientCallbacks {
  readonly onState: (layout: DaemonLayoutTree, sessions: readonly DaemonSession[]) => void;
  readonly onOutput: (sessionId: string, bytes: Uint8Array) => void;
  /** 지난 화면 재생 — 직렬화 당시 크기로 맞춘 뒤 그려야 한다. */
  readonly onReplayScreen: (
    sessionId: string,
    bytes: Uint8Array,
    rows: number,
    cols: number,
  ) => void;
  /** daemon 연결이 끊겼다 (스스로 닫은 것 제외). */
  readonly onDisconnected: () => void;
  readonly onOperationFailed: (context: string, detail: string) => void;
}

export interface DaemonConnectOptions {
  readonly pipePath: string;
  /** daemon 번들(dist/daemon.cjs)의 절대 경로. */
  readonly daemonModulePath: string;
  /** daemon 이 없을 때 띄울지. 거짓이면 붙기만 시도한다 — 활성화 직후의 재연결 탐색용. */
  readonly spawnIfMissing: boolean;
}

export class DaemonClient {
  readonly #socket: net.Socket;
  /** daemon 이 이전 연결의 세션들을 쥔 채 기다리고 있었다 — reload 복원 경로다. */
  readonly restored: boolean;
  /** 버전이 어긋난 구 daemon 에서 회수한 탭들. 없으면 정상 경로였다. */
  readonly recoveredDump: readonly DumpTab[] | undefined;
  #disposed = false;

  private constructor(
    socket: net.Socket,
    restored: boolean,
    recoveredDump: readonly DumpTab[] | undefined,
    callbacks: DaemonClientCallbacks,
  ) {
    this.#socket = socket;
    this.restored = restored;
    this.recoveredDump = recoveredDump;
    const decode = createLineDecoder((raw) => {
      const message = raw as DaemonToExtension;
      switch (message.type) {
        case "hello":
          return; // 수락 hello 는 연결 단계에서 이미 소비 판정을 마쳤다.
        case "state":
          callbacks.onState(message.layout, message.sessions);
          return;
        case "output":
          callbacks.onOutput(message.sessionId, Buffer.from(message.bytesBase64, "base64"));
          return;
        case "replayScreen":
          callbacks.onReplayScreen(
            message.sessionId,
            Buffer.from(message.dataBase64, "base64"),
            message.rows,
            message.cols,
          );
          return;
        case "operationFailed":
          callbacks.onOperationFailed(message.context, message.detail);
          return;
      }
    });
    socket.on("data", decode);
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!this.#disposed) callbacks.onDisconnected();
    });
  }

  /**
   * daemon 에 붙는다. 없으면 띄워서 붙고, 후발 창이면 DaemonRejectedError 를 던진다.
   * 버전(번들 해시)이 어긋난 구 daemon 이면 동결 계층으로 탭·화면을 회수하고 종료시킨 뒤
   * (셸 정리 포함) 새 daemon 을 띄워 잇는다 — 회수분은 `recoveredDump` 로 남는다.
   */
  static async connect(
    options: DaemonConnectOptions,
    callbacks: DaemonClientCallbacks,
  ): Promise<DaemonClient> {
    const expectedVersion = createHash("sha256")
      .update(fs.readFileSync(options.daemonModulePath))
      .digest("hex");
    let recoveredDump: readonly DumpTab[] | undefined;
    for (;;) {
      // 구 daemon 을 종료시킨 뒤라면(회수분 보유) 띄우지 않는 탐색이었어도 반드시 띄운다 —
      // 안 띄우면 회수한 탭들이 버려진다.
      const spawnIfMissing = options.spawnIfMissing || recoveredDump != null;
      const { socket, accepted, restored, version } = await openSocketWithRetry(
        options,
        spawnIfMissing,
      );
      if (!accepted) {
        socket.destroy();
        throw new DaemonRejectedError();
      }
      if (version !== expectedVersion) {
        recoveredDump = await recoverDumpAndShutdown(socket);
        continue; // 구 daemon 이 pipe 를 내려놓았다 — 다음 순회가 새 daemon 을 띄운다.
      }
      return new DaemonClient(socket, restored, recoveredDump, callbacks);
    }
  }

  send(message: ExtensionToDaemon): void {
    this.#socket.write(encodeMessage(message));
  }

  /** 연결을 닫는다. (슬라이스 1) daemon 은 끊김을 보고 셸을 정리하며 스스로 끝난다. */
  dispose(): void {
    this.#disposed = true;
    this.#socket.destroy();
  }
}

interface Handshake {
  readonly socket: net.Socket;
  readonly accepted: boolean;
  readonly restored: boolean;
  readonly version: string;
}

/** daemon 이 없으면 띄우고(옵션), 한도 안에서 hello 까지 받는다. */
async function openSocketWithRetry(
  options: DaemonConnectOptions,
  spawnIfMissing: boolean,
): Promise<Handshake> {
  const deadline = Date.now() + connectTimeoutMs;
  let spawned = false;
  for (;;) {
    try {
      return await openSocket(options.pipePath);
    } catch (error) {
      // 응답 없는 daemon 은 살아서 pipe 를 쥐고 있다 — 그 위에 또 띄우면 세션을 쥔 쪽이 밀려난다.
      if (!spawnIfMissing || error instanceof DaemonUnresponsiveError) throw error;
      if (!spawned) {
        spawnDaemon(options);
        spawned = true;
      }
      if (Date.now() >= deadline) throw error;
      await delay(connectRetryIntervalMs);
    }
  }
}

/**
 * [동결 계층] 구 daemon 에서 탭·화면 덤프를 받고 종료 명령을 보낸 뒤, 연결이 닫힐 때까지
 * 기다린다 — 닫혀야 pipe 가 풀려 새 daemon 을 띄울 수 있다.
 */
function recoverDumpAndShutdown(socket: net.Socket): Promise<readonly DumpTab[]> {
  return new Promise((resolve, reject) => {
    let tabs: readonly DumpTab[] | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The old daemon did not answer the dump request."));
    }, connectTimeoutMs);
    const decode = createLineDecoder((raw) => {
      const message = raw as DaemonToExtension;
      if (message.type !== "dump") return;
      tabs = message.tabs;
      socket.write(encodeMessage({ type: "shutdown" }));
    });
    socket.on("data", decode);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      if (tabs == null) reject(new Error("The old daemon closed before sending the dump."));
      else resolve(tabs);
    });
    socket.write(encodeMessage({ type: "dump" }));
  });
}

/**
 * 연결하고 daemon 의 첫마디(hello)까지 받는다. 첫마디 전의 연결은 아직 성립이 아니다.
 * 연결은 됐는데 hello 가 한도 안에 오지 않으면 실패로 드러낸다 — 여기서 영영 기다리면
 * 그 뒤의 모든 시작이 같은 대기에 물려 화면이 아무 말 없이 빈 채로 남는다.
 */
function openSocket(pipePath: string): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    const fail = (error: Error): void => {
      clearTimeout(helloTimer);
      socket.destroy();
      reject(error);
    };
    const helloTimer = setTimeout(() => fail(new DaemonUnresponsiveError()), connectTimeoutMs);
    socket.once("error", fail);
    const decode = createLineDecoder((raw) => {
      const message = raw as DaemonToExtension;
      if (message.type !== "hello") return;
      clearTimeout(helloTimer);
      socket.off("data", decode);
      socket.off("error", fail);
      resolve({
        socket,
        accepted: message.accepted,
        restored: message.restored,
        version: message.version,
      });
    });
    socket.on("data", decode);
  });
}

/**
 * daemon 을 detached 로 띄운다. 확장 호스트(Electron)의 실행 파일을 node 모드로 쓴다 —
 * 사용자의 node 설치에 기대지 않고, node-pty 네이티브 모듈의 ABI 도 확장 호스트와 같아진다.
 */
function spawnDaemon(options: DaemonConnectOptions): void {
  spawn(process.execPath, [options.daemonModulePath, options.pipePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  }).unref();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
