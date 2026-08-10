import * as vscode from "vscode";
import { DisplaySettingsSource } from "./display-settings.ts";
import { resolveFileLinkPath } from "./file-link.ts";
import { setL10nBundle, t } from "./l10n.ts";
import { logFailure, setDiagnosticsChannel, warnUser } from "./notify.ts";
import { DaemonClient, DaemonRejectedError, pipePathForWorkspace } from "./daemon-client.ts";
import type { DaemonLayoutTree, DaemonSession } from "./daemon-protocol.ts";
import { toViewLayout, toViewSessions } from "./view-state.ts";
import type {
  ExtensionToWebview,
  StartPrompt,
  ViewTexts,
  WebviewToExtension,
} from "./webview-messages.ts";
import { computeBlockedShellKeys, computeShellKeyStates } from "./shell-keys.ts";
import {
  resolveStartDirectoryCandidates,
  type StartDirectoryCandidate,
} from "./start-directory.ts";
import { buildWebviewHtml } from "./webview-html.ts";

const viewId = "simplysm-terminal.view";

/** 셸이 물려받으면 VS Code CLI 와 webview 가 깨지는 변수들. 세션 환경에서 걷어 낸다. */
function shellEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null || key === "ELECTRON_RUN_AS_NODE" || /^VSCODE_/i.test(key)) continue;
    environment[key] = value;
  }
  // 에뮬레이터(xterm.js)가 24bit 색을 실제로 지원한다 — 셸 프로그램의 truecolor 감지용.
  // 내장 터미널과 같은 선언 (name=xterm-256color 만으로는 256색으로 강등된다).
  environment["COLORTERM"] = "truecolor";
  return environment;
}

function startDirectoryCandidates(): StartDirectoryCandidate[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return resolveStartDirectoryCandidates(
    folders.map((folder) => {
      const configuredCwd = vscode.workspace
        .getConfiguration("terminal.integrated", folder.uri)
        .get<string>("cwd");
      return {
        name: folder.name,
        path: folder.uri.fsPath,
        ...(configuredCwd == null ? {} : { configuredCwd }),
      };
    }),
  );
}

/** webview 가 스스로 띄우는 화면의 문자열. */
function viewTexts(): ViewTexts {
  return {
    emptyState: t("No terminal session is open."),
    startSession: t("Start a session"),
    starting: t("Starting a session…"),
    choosingFolder: t("Choosing a folder…"),
    newTab: t("New terminal tab"),
    renameTab: t("Rename…"),
    closeTab: t("Close tab"),
    renameLabel: t("Tab name"),
    searchLabel: t("Find"),
    searchPrevious: t("Previous match"),
    searchNext: t("Next match"),
    searchClose: t("Close find"),
    searchNoResults: t("No results"),
  };
}

/** 확장 호스트 쪽 본체 — 세션을 쥔 daemon 과 webview 사이를 잇는다. 세션의 진실은 daemon 에 있다. */
class TerminalPanel implements vscode.WebviewViewProvider {
  readonly #extensionUri: vscode.Uri;
  /** daemon 식별의 바탕 — 워크스페이스+프로필별 저장소 경로. 워크스페이스가 없으면 없음. */
  readonly #storagePath: string | undefined;
  readonly #settings: DisplaySettingsSource;
  readonly #readSetting: (settingKey: string) => unknown;
  readonly #disposables: vscode.Disposable[] = [];
  #view?: vscode.WebviewView;
  #viewDisposables: vscode.Disposable[] = [];
  #daemon?: DaemonClient;
  /** daemon 이 보내 온 마지막 상태. webview 가 다시 만들어져도 이 값으로 곧장 그린다. */
  #daemonState?: { layout: DaemonLayoutTree; sessions: readonly DaemonSession[] };
  /** 진행 중이거나 끝난 연결 시도. 활성화 직후 탐색과 webview ready 가 겹쳐도 한 번만 붙는다. */
  #connectPromise?: Promise<DaemonClient | undefined>;
  /** 같은 워크스페이스의 다른 창이 daemon 을 쥐고 있어 거절당했다 — 다시 시도하지 않는다. */
  #rejected = false;

  constructor(extensionUri: vscode.Uri, storagePath: string | undefined) {
    this.#extensionUri = extensionUri;
    this.#storagePath = storagePath;
    const readSetting = (settingKey: string): unknown =>
      vscode.workspace.getConfiguration().get(settingKey);
    this.#readSetting = readSetting;
    this.#settings = new DisplaySettingsSource(readSetting, (settings) =>
      this.#post({ type: "displaySettings", settings }),
    );
    this.#refreshShellKeyContexts();
    this.#disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        // window.density 는 tab 높이의 출처다 — 표시 설정과 같은 길로 내려간다.
        if (
          !event.affectsConfiguration("terminal.integrated") &&
          !event.affectsConfiguration("window.density")
        ) {
          return;
        }
        this.#settings.notifyChanged();
        // 설정이 바뀌면 넘길 키 목록도 곧바로 바뀌어야 한다. 재로드를 요구하면 안 된다.
        this.#refreshShellKeyContexts();
        // scrollback 등 daemon 이 쥐는 값도 같은 길로 내려간다.
        this.#daemon?.send(this.#initMessage());
      }),
    );
    // reload 복원 — daemon 이 세션을 쥔 채 기다리고 있을 수 있다. webview 가 열리기 전에
    // 붙어야 10초 재연결 한도를 넘기지 않는다. 없으면(첫 기동) 여기서는 띄우지 않는다.
    if (this.#storagePath != null && (vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      void this.#ensureDaemon(false);
    }
  }

  #initMessage(): Parameters<DaemonClient["send"]>[0] {
    return {
      type: "init",
      shell: { shellPath: vscode.env.shell, env: shellEnvironment() },
      scrollback: (this.#readSetting("terminal.integrated.scrollback") as number | undefined) ?? 1000,
    };
  }

  /** 키별 조건 키 — 켜진 키는 no-op 명령이 VS Code 기본 동작을 덮어 셸이 그 키를 받는다. */
  #refreshShellKeyContexts(): void {
    for (const [contextKey, sendToShell] of Object.entries(
      computeShellKeyStates(this.#readSetting),
    )) {
      void vscode.commands.executeCommand("setContext", contextKey, sendToShell);
    }
    // VS Code 가 가질 키는 에뮬레이터도 무시해야 한다. 안 그러면 셸에 함께 들어간다.
    this.#post({ type: "shellKeys", blockedKeys: computeBlockedShellKeys(this.#readSetting) });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    // 새 webview 는 아직 받을 준비가 안 됐다. 준비를 알려 오기 전에 보낸 것은 닿지 못한다.
    for (const disposable of this.#viewDisposables) disposable.dispose();
    this.#viewDisposables = [];

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.#extensionUri, "dist")],
    };
    view.webview.html = buildWebviewHtml(view.webview, this.#extensionUri);

    this.#viewDisposables.push(
      view.webview.onDidReceiveMessage((message: WebviewToExtension) => {
        void this.#dispatchWebviewMessage(message);
      }),
      // 숨은 뷰의 포커스 상실 신호는 오지 않는다. 조건 키가 켜진 채 남으면 셸 키가 밖에서 산다.
      view.onDidChangeVisibility(() => {
        if (!view.visible) void this.#setViewFocusContext(false);
      }),
      view.onDidDispose(() => {
        if (this.#view === view) this.#view = undefined;
        void this.#setViewFocusContext(false);
      }),
    );
  }

  dispose(): void {
    for (const disposable of [...this.#disposables, ...this.#viewDisposables]) disposable.dispose();
    this.#settings.dispose();
    // (슬라이스 1) 연결을 닫으면 daemon 이 끊김을 보고 셸을 정리하며 스스로 끝난다.
    this.#daemon?.dispose();
  }

  /** 화면에서 온 것을 처리한다. 실패는 화면에 그대로 드러나므로 원인만 출력 채널에 남긴다. */
  async #dispatchWebviewMessage(message: WebviewToExtension): Promise<void> {
    try {
      await this.#handleWebviewMessage(message);
    } catch (error) {
      logFailure(`Could not handle "${message.type}".`, detailOf(error));
    }
  }

  async #handleWebviewMessage(message: WebviewToExtension): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.#startView();
        return;
      case "viewFocus":
        await this.#setViewFocusContext(message.focused);
        return;
      case "copyText":
        await vscode.env.clipboard.writeText(message.text);
        return;
      case "readClipboard": {
        // 텍스트가 아닌 것(이미지, 파일)만 있으면 빈 문자열이 온다. 붙일 것이 없으므로 보내지 않는다.
        const text = await vscode.env.clipboard.readText();
        if (text.length > 0) this.#post({ type: "pasteText", sessionId: message.sessionId, text });
        return;
      }
      case "readClipboardText": {
        const text = await vscode.env.clipboard.readText();
        this.#post({ type: "clipboardText", requestId: message.requestId, text });
        return;
      }
      case "openUrl": {
        const opened = await vscode.env.openExternal(vscode.Uri.parse(message.url));
        if (!opened) logFailure(`Could not open the link: ${message.url}`);
        return;
      }
      case "openFile":
        await this.#openFileLink(message.cwd, message.path, message.line, message.column);
        return;
      case "newTab":
        this.#requireDaemon().send({
          type: "newTab",
          ...(message.paneId == null ? {} : { paneId: message.paneId }),
        });
        return;
      case "startSession":
        this.#requireDaemon().send({ type: "startSession", tabId: message.tabId, cwd: message.cwd });
        return;
      case "closeTab":
        this.#requireDaemon().send({ type: "closeTab", tabId: message.tabId });
        return;
      case "renameTab":
        this.#requireDaemon().send({
          type: "renameTab",
          tabId: message.tabId,
          ...(message.name == null ? {} : { name: message.name }),
        });
        return;
      case "moveTab":
        this.#requireDaemon().send({
          type: "moveTab",
          tabId: message.tabId,
          targetPaneId: message.targetPaneId,
          position: message.position,
          ...(message.insertIndex == null ? {} : { insertIndex: message.insertIndex }),
        });
        return;
      case "setActiveTab":
        this.#requireDaemon().send({
          type: "setActiveTab",
          paneId: message.paneId,
          tabId: message.tabId,
        });
        return;
      case "setFocusedPane":
        this.#requireDaemon().send({ type: "setFocusedPane", paneId: message.paneId });
        return;
      case "setSplitRatio":
        this.#requireDaemon().send({
          type: "setSplitRatio",
          splitPath: message.splitPath,
          boundaryIndex: message.boundaryIndex,
          firstRatio: message.firstRatio,
        });
        return;
      case "input":
        this.#requireDaemon().send({
          type: "input",
          sessionId: message.sessionId,
          data: message.data,
          binary: message.binary,
        });
        return;
      case "resize":
        this.#requireDaemon().send({
          type: "resize",
          sessionId: message.sessionId,
          rows: message.rows,
          cols: message.cols,
        });
        return;
    }
  }

  /** daemon 에 붙기 전에는 화면에 조작할 자리가 없다. 여기 닿았다면 어긋난 것이므로 드러낸다. */
  #requireDaemon(): DaemonClient {
    if (this.#daemon == null) throw new Error("The terminal daemon is not connected yet.");
    return this.#daemon;
  }

  /**
   * daemon 연결을 하나로 모은다 — 활성화 직후 탐색(띄우지 않음)과 webview ready(띄움)가
   * 겹쳐도 연결은 한 번이다. 탐색이 빈손이었으면 띄우는 시도로 이어 간다.
   */
  #ensureDaemon(spawnIfMissing: boolean): Promise<DaemonClient | undefined> {
    if (this.#daemon != null) return Promise.resolve(this.#daemon);
    const previous = this.#connectPromise ?? Promise.resolve(undefined);
    this.#connectPromise = previous.then((existing) => {
      if (existing != null || this.#rejected) return existing;
      return this.#connect(spawnIfMissing);
    });
    return this.#connectPromise;
  }

  async #connect(spawnIfMissing: boolean): Promise<DaemonClient | undefined> {
    try {
      const daemon = await DaemonClient.connect(
        {
          pipePath: pipePathForWorkspace(this.#storagePath!),
          daemonModulePath: vscode.Uri.joinPath(this.#extensionUri, "dist", "daemon.cjs").fsPath,
          spawnIfMissing,
        },
        {
          onState: (layout, sessions) => {
            this.#daemonState = { layout, sessions };
            this.#postState();
          },
          onOutput: (sessionId, bytes) => {
            // Buffer 는 내부 풀을 공유한다 — webview 로 보낼 ArrayBuffer 는 새로 복사한다.
            const copy = new Uint8Array(bytes);
            this.#post({ type: "output", sessionId, bytes: copy.buffer as ArrayBuffer });
          },
          onReplayScreen: (sessionId, bytes, rows, cols) => {
            const copy = new Uint8Array(bytes);
            this.#post({
              type: "restoreScreen",
              sessionId,
              bytes: copy.buffer as ArrayBuffer,
              rows,
              cols,
            });
          },
          onDisconnected: () => {
            // daemon 이 죽었다(크래시 등). 화면이 살아있는 척 멈춰 있으면 안 된다 —
            // 모든 세션을 종료 상태로 표시한다. 자동 재기동은 하지 않는다.
            this.#daemon = undefined;
            this.#connectPromise = undefined;
            this.#markSessionsLost();
            logFailure("The terminal daemon connection was lost.");
          },
          onOperationFailed: (context, detail) =>
            logFailure(`Could not handle "${context}".`, detail),
        },
      );
      this.#daemon = daemon;
      daemon.send(this.#initMessage());
      if (daemon.recoveredDump != null) {
        // 확장 업데이트로 구 daemon 과 버전이 어긋났다 — 탭들은 이전 화면을 담은 종료 상태로
        // 되살아난다. 사실을 warn 으로 고지하고, 재시작은 사용자가 화면을 보고 직접 한다.
        daemon.send({ type: "restoreDump", tabs: daemon.recoveredDump });
        warnUser(t("Terminal sessions could not be restored after the extension update."));
      }
      return daemon;
    } catch (error) {
      if (error instanceof DaemonRejectedError) {
        this.#rejected = true;
      } else if (spawnIfMissing) {
        logFailure("Could not connect to the terminal daemon.", detailOf(error));
      }
      // 띄우지 않는 탐색의 빈손은 실패가 아니다 — daemon 이 없었을 뿐이다.
      return undefined;
    }
  }

  /** webview 가 준비됐다. daemon 에 붙고, 복원이면 지난 화면을 되살리고, 첫 기동이면 첫 자리를 연다. */
  async #startView(): Promise<void> {
    this.#post({ type: "displaySettings", settings: this.#settings.current });
    this.#post({ type: "shellKeys", blockedKeys: computeBlockedShellKeys(this.#readSetting) });
    this.#post({ type: "texts", texts: viewTexts() });

    if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
      this.#post({ type: "notice", notice: t("Open a folder to use the terminal.") });
      return;
    }
    this.#post({ type: "notice" });

    const alreadyConnected = this.#daemon != null;
    const daemon = await this.#ensureDaemon(true);
    if (daemon == null) {
      this.#post({
        type: "notice",
        notice: this.#rejected
          ? // 같은 워크스페이스의 다른 창이 세션을 쥐고 있다 — 이 창의 터미널 뷰는 안내만 보인다.
            t("Another window is already using the terminal in this workspace.")
          : t("Could not start the terminal service."),
      });
      return;
    }

    if (alreadyConnected || daemon.restored || daemon.recoveredDump != null) {
      // 이 webview 는 새로 만들어졌다 — 상태를 다시 그리고 지난 화면을 되살린다.
      // 자리가 비어 있어도 새로 만들지 않는다 — 다시 시작은 사용자가 누른다.
      this.#postState();
      daemon.send({ type: "replay" });
      return;
    }
    daemon.send({ type: "newTab" });
  }

  /** 시작 대기 자리가 보일 내용. 셸이 없으면 고를 것도 없으므로 그 사유를 대신 싣는다. */
  #startPrompt(): StartPrompt {
    const shellMissing = vscode.env.shell.length === 0;
    return {
      title: t("Choose the folder to start in"),
      candidates: shellMissing ? [] : startDirectoryCandidates(),
      ...(shellMissing
        ? { unavailable: t("This environment has no shell, so no session can start.") }
        : {}),
    };
  }

  /** daemon 이 죽었다 — 아직 살아 있던 세션 전부를 잃은 것으로 바꿔 화면에 드러낸다. */
  #markSessionsLost(): void {
    if (this.#daemonState == null) return;
    this.#daemonState = {
      layout: this.#daemonState.layout,
      sessions: this.#daemonState.sessions.map((session) =>
        session.exitedCause != null ? session : { ...session, exitedCause: { kind: "daemonLost" } },
      ),
    };
    this.#postState();
  }

  #postState(): void {
    if (this.#daemonState == null) return;
    this.#post({
      type: "state",
      layout: toViewLayout(this.#daemonState.layout),
      sessions: toViewSessions(this.#daemonState.sessions),
      prompt: this.#startPrompt(),
    });
  }

  /** 뷰 포커스 조건 키 — 셸 편집 키를 덮는 keybinding 이 이 값으로 켜지고 꺼진다. */
  async #setViewFocusContext(focused: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", "simplysm-terminal.viewFocused", focused);
  }

  /** 출력 속 파일 경로 열기. 상대 경로는 그 세션의 시작 디렉터리 기준이다. */
  async #openFileLink(
    cwd: string,
    rawPath: string,
    line: number | undefined,
    column: number | undefined,
  ): Promise<void> {
    const resolvedPath = resolveFileLinkPath(cwd, rawPath);
    try {
      // 존재하지 않는 파일이 링크처럼 열리는 척하면 안 된다. 먼저 실재를 확인한다.
      await vscode.workspace.fs.stat(vscode.Uri.file(resolvedPath));
      const position = new vscode.Position(
        Math.max((line ?? 1) - 1, 0),
        Math.max((column ?? 1) - 1, 0),
      );
      await vscode.window.showTextDocument(
        vscode.Uri.file(resolvedPath),
        line == null ? undefined : { selection: new vscode.Range(position, position) },
      );
    } catch {
      // 열리지 않았다는 사실은 화면에 그대로 보인다. 원인만 남긴다.
      logFailure(`Could not open the file: ${resolvedPath}`);
    }
  }

  #post(message: ExtensionToWebview): void {
    void this.#view?.webview.postMessage(message);
  }
}

function detailOf(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function activate(context: vscode.ExtensionContext): void {
  setL10nBundle(vscode.l10n.bundle);
  const diagnostics = vscode.window.createOutputChannel("Simplysm Terminal", { log: true });
  setDiagnosticsChannel(diagnostics);
  const panel = new TerminalPanel(context.extensionUri, context.storageUri?.fsPath);
  context.subscriptions.push(
    diagnostics,
    // 셸로 넘길 키를 덮는 no-op 명령 — 키는 webview 의 에뮬레이터가 이미 셸로 보냈고,
    // 이 명령은 같은 키의 VS Code 기본 명령이 실행되는 것만 막는다.
    vscode.commands.registerCommand("simplysm-terminal.shieldShellKey", () => {}),
    vscode.window.registerWebviewViewProvider(viewId, panel, {
      // panel tab 을 오갈 때 화면과 스크롤백이 유지되어야 하므로 숨겨도 살려 둔다.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    panel,
  );
}

export function deactivate(): void {}
