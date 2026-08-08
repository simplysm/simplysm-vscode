// 셸 세션들과 그것들이 놓인 배치를 소유한다. daemon 프로세스 안에서 돌며, 표시 문구 대신
// 구조화 사유만 담는다 — 번역은 확장 호스트 몫이다.

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as pty from "@lydell/node-pty";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { DaemonLayoutTree, DaemonSession, DumpTab, ShellSpec } from "./daemon-protocol.ts";
import type { SessionEndCause, StartFailureCause } from "./session-causes.ts";
import { collectPanes } from "./layout/layout-tree.ts";
import {
  addTab,
  attachSession,
  createFirstPane,
  findTabBySession,
  markTabStartFailed,
  markTabStarting,
  moveTab,
  removeTab,
  setActiveTab,
  setFocusedPane,
  setSplitRatio,
  setTabName,
  type DropPosition,
} from "./layout/layout-operations.ts";

/** 셸에 알리는 터미널 종류. 화면 쪽 에뮬레이터가 지원하는 능력과 같은 값. */
const terminalTypeName = "xterm-256color";

/** 새 세션이 뜰 때의 첫 크기. 화면이 붙으면 곧바로 실제 크기로 다시 맞춰진다. */
const initialRows = 24;
const initialCols = 80;

// pty 는 출력을 잘게 쪼개 준다. 청크마다 IPC·postMessage 를 태우면 대량 출력에서 메시지가
// 폭주하므로, 짧게 모았다가 한 덩어리로 보낸다. 지연은 1프레임(16ms) 미만이라 체감되지 않는다.
const outputFlushDelayMs = 5;
const outputFlushBytes = 64 * 1024;

interface Session {
  readonly sessionId: string;
  readonly shellPath: string;
  readonly cwd: string;
  /** 셸 프로세스. 구 daemon 에서 화면만 회수한 세션(restoreFailed)에는 없다. */
  readonly shell?: pty.IPty;
  /** 출력 전부를 먹여 화면 상태를 유지하는 headless 에뮬레이터 — 재연결 시 화면 복원의 출처. */
  readonly screen: Terminal;
  readonly serializer: SerializeAddon;
  exitedCause?: SessionEndCause;
  /** 아직 내보내지 않은 출력 조각들 — 시간·크기 임계에 이르면 한 덩어리로 내보낸다. */
  pendingOutput: Buffer[];
  pendingBytes: number;
  flushTimer?: NodeJS.Timeout;
}

export interface SessionManagerCallbacks {
  /** 배치나 세션 목록이 달라졌다. 무엇이 바뀌었는지 가리지 않고 전체를 다시 그린다. */
  readonly onStateChanged: () => void;
  readonly onOutput: (sessionId: string, bytes: Uint8Array) => void;
}

export class SessionManager {
  readonly #callbacks: SessionManagerCallbacks;
  #shell: ShellSpec;
  #scrollback: number;
  readonly #sessions = new Map<string, Session>();
  #layout: DaemonLayoutTree = { root: null };

  constructor(shell: ShellSpec, scrollback: number, callbacks: SessionManagerCallbacks) {
    this.#shell = shell;
    this.#scrollback = scrollback;
    this.#callbacks = callbacks;
  }

  /** 재연결·설정 변경으로 준비물이 갱신됐다. 이미 도는 세션은 그대로 두고 다음 것부터 적용한다. */
  update(shell: ShellSpec, scrollback: number): void {
    this.#shell = shell;
    this.#scrollback = scrollback;
    for (const session of this.#sessions.values()) session.screen.options.scrollback = scrollback;
  }

  /**
   * 세션별 화면 상태를 표준 VT 시퀀스로 직렬화한다 — 직렬화 당시 크기의 화면에 그대로
   * write 하면 복원된다. 크기가 다르면 어긋나므로 rows·cols 를 함께 돌려준다.
   */
  async serializeScreens(): Promise<
    { sessionId: string; data: string; rows: number; cols: number }[]
  > {
    await this.#flushScreens();
    return [...this.#sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      data: session.serializer.serialize(),
      rows: session.screen.rows,
      cols: session.screen.cols,
    }));
  }

  /** [동결 계층의 재료] 배치 순서대로 세션 붙은 탭들을 덤프한다 — 버전이 어긋날 때 회수용. */
  async dumpTabs(): Promise<DumpTab[]> {
    await this.#flushScreens();
    const result: DumpTab[] = [];
    for (const pane of collectPanes(this.#layout.root)) {
      for (const tab of pane.tabs) {
        if (tab.sessionId == null) continue;
        const session = this.#sessions.get(tab.sessionId);
        if (session == null) continue;
        result.push({
          ...(tab.name == null ? {} : { name: tab.name }),
          shellPath: session.shellPath,
          cwd: session.cwd,
          screenBase64: Buffer.from(session.serializer.serialize(), "utf8").toString("base64"),
        });
      }
    }
    return result;
  }

  /** 모아둔 출력을 지금 내보낸다. 직렬화·종료 전에 불러 중복·유실 없이 순서를 맞춘다. */
  #flushOutput(session: Session): void {
    if (session.flushTimer != null) {
      clearTimeout(session.flushTimer);
      session.flushTimer = undefined;
    }
    if (session.pendingOutput.length === 0) return;
    const merged =
      session.pendingOutput.length === 1
        ? session.pendingOutput[0]!
        : Buffer.concat(session.pendingOutput);
    session.pendingOutput = [];
    session.pendingBytes = 0;
    this.#callbacks.onOutput(session.sessionId, new Uint8Array(merged));
  }

  #queueOutput(session: Session, bytes: Buffer): void {
    session.pendingOutput.push(bytes);
    session.pendingBytes += bytes.length;
    if (session.pendingBytes >= outputFlushBytes) {
      this.#flushOutput(session);
      return;
    }
    session.flushTimer ??= setTimeout(() => this.#flushOutput(session), outputFlushDelayMs);
  }

  /** 화면 에뮬레이터의 write 는 비동기다 — 큐가 다 그려진 다음에야 직렬화가 실제 화면이 된다. */
  async #flushScreens(): Promise<void> {
    // 모아둔 출력을 먼저 내보내야 직렬화 결과와 이후 출력이 겹치지 않는다.
    for (const session of this.#sessions.values()) this.#flushOutput(session);
    await Promise.all(
      [...this.#sessions.values()].map(
        (session) => new Promise<void>((resolve) => session.screen.write("", resolve)),
      ),
    );
  }

  /**
   * 구 daemon 에서 회수한 탭들을 같은 구성으로 되살린다 — 전부 종료 상태다. 죽은 출력 밑에
   * 새 프롬프트를 잇는 것은 기만이므로 새 셸은 띄우지 않는다. 재시작은 사용자가 한다.
   */
  restoreDeadTabs(tabs: readonly DumpTab[]): void {
    for (const tab of tabs) {
      const tabId = randomUUID();
      this.#changeLayout((tree) =>
        tree.root == null
          ? createFirstPane(tree, tabId, randomUUID())
          : addTab(tree, tree.focusedPaneId!, tabId),
      );
      if (tab.name != null) this.#changeLayout((tree) => setTabName(tree, tabId, tab.name));

      const screen = new Terminal({
        rows: initialRows,
        cols: initialCols,
        scrollback: this.#scrollback,
        allowProposedApi: true,
      });
      const serializer = new SerializeAddon();
      screen.loadAddon(serializer);
      screen.write(new Uint8Array(Buffer.from(tab.screenBase64, "base64")));

      const session: Session = {
        sessionId: randomUUID(),
        shellPath: tab.shellPath,
        cwd: tab.cwd,
        screen,
        serializer,
        exitedCause: { kind: "restoreFailed" },
        pendingOutput: [],
        pendingBytes: 0,
      };
      this.#sessions.set(session.sessionId, session);
      this.#changeLayout((tree) => attachSession(tree, tabId, session.sessionId));
    }
  }

  get layout(): DaemonLayoutTree {
    return this.#layout;
  }

  get sessions(): DaemonSession[] {
    return [...this.#sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      shellPath: session.shellPath,
      cwd: session.cwd,
      ...(session.exitedCause == null ? {} : { exitedCause: session.exitedCause }),
    }));
  }

  /** 새 자리를 만든다. pane 을 주면 그 pane 에, 없으면 포커스 pane 이나 빈 배치에 만든다. */
  newTab(paneId?: string): void {
    this.#changeLayout((tree) => {
      if (paneId == null && tree.root == null) {
        return createFirstPane(tree, randomUUID(), randomUUID());
      }
      const target = paneId ?? tree.focusedPaneId;
      if (target == null) throw new Error("There is no focused pane to add a tab to.");
      return addTab(tree, target, randomUUID());
    });
  }

  /** 그 자리에 셸을 띄워 붙인다. 못 띄우면 자리를 남긴 채 사유를 그 자리에 적는다. */
  startSession(tabId: string, cwd: string): void {
    this.#changeLayout((tree) => markTabStarting(tree, tabId));

    // 시작 디렉터리가 없으면 셸을 띄우지 않는다. 그냥 띄우면 셸이 뜬 직후 끝나
    // 사용자에게는 원인 없는 종료로 보인다.
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      this.#failStart(tabId, { kind: "cwdMissing", cwd });
      return;
    }

    let shell: pty.IPty;
    try {
      shell = pty.spawn(this.#shell.shellPath, [], {
        name: terminalTypeName,
        cwd,
        env: { ...this.#shell.env },
        rows: initialRows,
        cols: initialCols,
        encoding: null,
        useConptyDll: true,
      });
    } catch (error) {
      this.#failStart(tabId, { kind: "spawnFailed", detail: String(error) });
      return;
    }

    // serialize addon 은 proposed API(buffer 접근)를 쓴다.
    const screen = new Terminal({
      rows: initialRows,
      cols: initialCols,
      scrollback: this.#scrollback,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);

    const session: Session = {
      sessionId: randomUUID(),
      shellPath: this.#shell.shellPath,
      cwd,
      shell,
      screen,
      serializer,
      pendingOutput: [],
      pendingBytes: 0,
    };
    this.#sessions.set(session.sessionId, session);
    shell.onData((chunk: string | Buffer) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      screen.write(new Uint8Array(bytes));
      this.#queueOutput(session, bytes);
    });
    shell.onExit(({ exitCode, signal }) => this.#handleExit(session, exitCode, signal));

    this.#changeLayout((tree) => attachSession(tree, tabId, session.sessionId));
  }

  /** 그 자리를 없애고, 붙어 있던 셸이 있으면 함께 끝낸다. */
  closeTab(tabId: string): void {
    const session = this.#sessionOfTab(tabId);
    if (session != null) this.#sessions.delete(session.sessionId);
    this.#changeLayout((tree) => removeTab(tree, tabId));
    if (session != null) {
      if (session.flushTimer != null) clearTimeout(session.flushTimer);
      if (session.exitedCause == null) session.shell?.kill();
      session.screen.dispose();
    }
  }

  renameTab(tabId: string, name: string | undefined): void {
    this.#changeLayout((tree) => setTabName(tree, tabId, name));
  }

  moveTab(tabId: string, targetPaneId: string, position: DropPosition): void {
    this.#changeLayout((tree) => moveTab(tree, tabId, targetPaneId, position, randomUUID()));
  }

  setActiveTab(paneId: string, tabId: string): void {
    this.#changeLayout((tree) => setActiveTab(tree, paneId, tabId));
  }

  setFocusedPane(paneId: string): void {
    this.#changeLayout((tree) => setFocusedPane(tree, paneId));
  }

  setSplitRatio(splitPath: readonly number[], boundaryIndex: number, firstRatio: number): void {
    this.#changeLayout((tree) => setSplitRatio(tree, splitPath, boundaryIndex, firstRatio));
  }

  write(sessionId: string, data: string, binary: boolean): void {
    const session = this.#liveSession(sessionId);
    session.shell.write(binary ? Buffer.from(data, "latin1") : data);
  }

  resize(sessionId: string, rows: number, cols: number): void {
    const session = this.#liveSession(sessionId);
    session.shell.resize(cols, rows);
    session.screen.resize(cols, rows);
  }

  /** daemon 이 끝난다. 남은 셸을 모두 끝낸다 — 남기면 창이 닫힌 뒤에도 프로세스가 산다. */
  dispose(): void {
    for (const session of this.#sessions.values()) {
      if (session.flushTimer != null) clearTimeout(session.flushTimer);
      if (session.exitedCause == null) session.shell?.kill();
      session.screen.dispose();
    }
    this.#sessions.clear();
    this.#layout = { root: null };
  }

  #failStart(tabId: string, cause: StartFailureCause): void {
    this.#changeLayout((tree) => markTabStartFailed(tree, tabId, cause));
  }

  /** 스스로 정상으로 끝난 셸의 자리는 닫는다. 그 밖의 끝맺음은 자리를 남겨 사유를 보이게 한다. */
  #handleExit(session: Session, exitCode: number, signal: number | undefined): void {
    if (!this.#sessions.has(session.sessionId) || session.exitedCause != null) return;
    // 더 올 출력이 없다 — 모아둔 마지막 출력을 내보내고 끝맺는다.
    this.#flushOutput(session);
    // 신호로 끝나면 종료 코드가 없다.
    const endedBySignal = signal != null && signal !== 0;
    session.exitedCause = endedBySignal ? { kind: "endedBySignal" } : { kind: "exited", exitCode };

    if (!endedBySignal && exitCode === 0) {
      const tabId = findTabBySession(this.#layout, session.sessionId);
      if (tabId != null) {
        this.closeTab(tabId);
        return;
      }
    }
    this.#callbacks.onStateChanged();
  }

  #changeLayout(change: (tree: DaemonLayoutTree) => DaemonLayoutTree): void {
    this.#layout = change(this.#layout);
    this.#callbacks.onStateChanged();
  }

  /** 그 자리에 붙어 있는 세션. 자리가 없거나 아직 셸이 붙지 않았으면 없음이다. */
  #sessionOfTab(tabId: string): Session | undefined {
    const tab = collectPanes(this.#layout.root)
      .flatMap((pane) => pane.tabs)
      .find((candidate) => candidate.tabId === tabId);
    return tab?.sessionId == null ? undefined : this.#sessions.get(tab.sessionId);
  }

  /** 죽은 셸에 쓰면 조용히 사라져 화면과 실제가 어긋나므로, 살아 있는 세션만 받는 자리에 쓴다. */
  #liveSession(sessionId: string): Session & { readonly shell: pty.IPty } {
    const session = this.#sessions.get(sessionId);
    if (session?.shell == null || session.exitedCause != null) {
      throw new Error(`That terminal session is no longer open: ${sessionId}`);
    }
    return session as Session & { readonly shell: pty.IPty };
  }
}
