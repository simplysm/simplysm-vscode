// pty 세션의 진짜 소유자 — 확장 호스트와 별개의 detached 프로세스로 떠서 창 재시작을 넘긴다.
// 연결이 끊기면 10초 동안 재연결을 기다린다: 그 안에 돌아오면 reload 였으므로 세션을 그대로
// 잇고, 지나면 창이 정말 닫힌 것이므로 셸을 정리하고 스스로 끝난다(유령 프로세스 금지).
// vscode API 는 여기서 절대 쓸 수 없다. 번역·설정도 확장 호스트가 건네준 값만 쓴다.

import fs from "node:fs";
import net from "node:net";
import { createHash } from "node:crypto";
import {
  createLineDecoder,
  encodeMessage,
  type DaemonToExtension,
  type ExtensionToDaemon,
} from "./daemon-protocol.ts";
import { SessionManager } from "./session-manager.ts";

const pipePath = process.argv[2];
if (pipePath == null || pipePath.length === 0) {
  process.stderr.write("Usage: daemon.cjs <pipePath>\n");
  process.exit(1);
}

/**
 * [동결 계층] 버전 키 — 자기 번들의 내용 해시. 기동 시점에 읽어 둔다: 확장 업데이트가
 * 도는 중에 파일을 갈아치워도, 실행 중인 코드의 버전을 말해야 한다.
 */
const selfVersion = createHash("sha256").update(fs.readFileSync(__filename)).digest("hex");

/** 끊김 후 재연결 대기 한도. 안에 돌아오면 reload, 지나면 창 완전 종료로 판정한다. */
const reconnectWaitMs = 10_000;
/** 확장이 띄워 놓고 첫 연결에 실패했을 때 고아로 남지 않기 위한 대기 한도. */
const firstConnectWaitMs = 10_000;

let client: net.Socket | undefined;
let manager: SessionManager | undefined;
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;

function shutdown(): void {
  manager?.dispose();
  process.exit(0);
}

function send(socket: net.Socket, message: DaemonToExtension): void {
  socket.write(encodeMessage(message));
}

function sendState(socket: net.Socket): void {
  if (manager == null) return;
  send(socket, { type: "state", layout: manager.layout, sessions: manager.sessions });
}

// async 지만 셸 조작은 첫 await 전에 동기로 끝난다 — 조작 순서는 도착 순서 그대로다.
// await 를 품는 것은 dump·replay(화면 flush 대기)뿐이다.
async function handleMessage(socket: net.Socket, message: ExtensionToDaemon): Promise<void> {
  // ---- 동결 계층 — 어떤 버전의 확장이 보내도 통해야 한다 ----
  if (message.type === "dump") {
    send(socket, { type: "dump", tabs: manager == null ? [] : await manager.dumpTabs() });
    return;
  }
  if (message.type === "shutdown") {
    shutdown();
    return;
  }
  // ---- 본 프로토콜 ----
  if (message.type === "init") {
    if (manager == null) {
      manager = new SessionManager(message.shell, message.scrollback, {
        onStateChanged: () => {
          if (client != null) sendState(client);
        },
        onOutput: (sessionId, bytes) => {
          if (client != null) {
            send(client, {
              type: "output",
              sessionId,
              bytesBase64: Buffer.from(bytes).toString("base64"),
            });
          }
        },
      });
    } else {
      // 재연결 — 세션은 그대로 두고 준비물만 갈아끼운다.
      manager.update(message.shell, message.scrollback);
    }
    sendState(socket);
    return;
  }
  if (manager == null) throw new Error("The daemon has not been initialized yet.");
  switch (message.type) {
    case "restoreDump":
      manager.restoreDeadTabs(message.tabs);
      return;
    case "replay":
      // 새 webview 가 지난 화면을 그린다. 직렬화 당시 크기를 함께 보내야 그대로 재생된다.
      for (const { sessionId, data, rows, cols } of await manager.serializeScreens()) {
        send(socket, {
          type: "replayScreen",
          sessionId,
          dataBase64: Buffer.from(data, "utf8").toString("base64"),
          rows,
          cols,
        });
      }
      return;
    case "newTab":
      manager.newTab(message.paneId);
      return;
    case "startSession":
      manager.startSession(message.tabId, message.cwd);
      return;
    case "closeTab":
      manager.closeTab(message.tabId);
      return;
    case "renameTab":
      manager.renameTab(message.tabId, message.name);
      return;
    case "moveTab":
      manager.moveTab(message.tabId, message.targetPaneId, message.position, message.insertIndex);
      return;
    case "setActiveTab":
      manager.setActiveTab(message.paneId, message.tabId);
      return;
    case "setFocusedPane":
      manager.setFocusedPane(message.paneId);
      return;
    case "setSplitRatio":
      manager.setSplitRatio(message.splitPath, message.boundaryIndex, message.firstRatio);
      return;
    case "input":
      manager.write(message.sessionId, message.data, message.binary);
      return;
    case "resize":
      manager.resize(message.sessionId, message.rows, message.cols);
      return;
  }
}

const server = net.createServer((socket) => {
  // 같은 워크스페이스의 후발 창 — 세션 소유는 한 창뿐이다. 거절만 알리고 닫는다.
  if (client != null) {
    send(socket, { type: "hello", accepted: false, restored: false, version: selfVersion });
    socket.end();
    return;
  }
  clearTimeout(shutdownTimer);
  client = socket;
  send(socket, { type: "hello", accepted: true, restored: manager != null, version: selfVersion });

  const decode = createLineDecoder((raw) => {
    const message = raw as ExtensionToDaemon;
    // 조작은 응답을 기다리지 않는다. 실패 사실만 알려 확장이 기록하게 한다.
    handleMessage(socket, message).catch((error: unknown) => {
      send(socket, {
        type: "operationFailed",
        context: message.type,
        detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    });
  });
  socket.on("data", decode);
  socket.on("error", () => {});
  // 확장 호스트가 사라졌다. reload 라면 곧 돌아온다 — 한도를 두고 기다린다.
  socket.on("close", () => {
    if (client !== socket) return;
    client = undefined;
    if (manager == null) {
      shutdown();
      return;
    }
    shutdownTimer = setTimeout(shutdown, reconnectWaitMs);
  });
});

// unix domain socket 은 파일로 남는다. 앞선 daemon 이 비정상 종료했으면 지워야 다시 열린다.
if (process.platform !== "win32" && fs.existsSync(pipePath)) fs.unlinkSync(pipePath);

// 이미 다른 daemon 이 이 워크스페이스의 pipe 를 쥐고 있다 — 그쪽이 주인이므로 조용히 물러난다.
server.on("error", () => process.exit(0));
server.listen(pipePath);

setTimeout(() => {
  if (client == null && manager == null) process.exit(0);
}, firstConnectWaitMs);
