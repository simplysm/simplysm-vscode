// webview 본체 — 확장 호스트가 준 상태를 그리고 마우스·키를 받는다. 배치를 스스로 바꾸지 않고
// 조작을 요청으로 올린다. 표시 문자열은 확장 호스트가 번역해 보낸 값만 쓴다.

import "@vscode/codicons/dist/codicon.css";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import type {
  ExtensionToWebview,
  StartPrompt,
  ViewSession,
  ViewTexts,
  WebviewToExtension,
} from "../webview-messages.ts";
import type { LocalizedText } from "../l10n.ts";
import { collectPanes, type LayoutTab, type LayoutTree } from "../layout/layout-tree.ts";
import { DisplayOptionsSource } from "./display-options.ts";
import { setDataText, setText } from "./dom-text.ts";
import { LayoutView, type TabView } from "./layout-ui/layout-view.ts";
import { SearchBar } from "./output/search-bar.ts";
import { normalizeAssignedName, shellDisplayName } from "./session-name/name-value.ts";
import { TerminalScreen } from "./terminal-screen.ts";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscodeApi = acquireVsCodeApi();

function post(message: WebviewToExtension): void {
  vscodeApi.postMessage(message);
}

const rootElement = document.createElement("main");
rootElement.id = "terminal-root";
const tabsElement = document.createElement("div");
tabsElement.id = "screens";
const noticeElement = document.createElement("div");
noticeElement.id = "notice";
noticeElement.hidden = true;
const noticeTextElement = document.createElement("p");
const noticeActionElement = document.createElement("button");
noticeActionElement.id = "notice-action";
noticeActionElement.hidden = true;
noticeActionElement.addEventListener("click", () => post({ type: "newTab" }));
noticeElement.append(noticeTextElement, noticeActionElement);
rootElement.append(tabsElement, noticeElement);
document.body.appendChild(rootElement);

/** 화면에 그려 둔 자리 하나. 세션이 붙기 전에는 시작 화면만 있다. */
interface Tab {
  readonly tabId: string;
  readonly rootElement: HTMLElement;
  sessionId?: string;
  screen?: TerminalScreen;
  startElement?: HTMLElement;
  /** 이 자리에 그려 둔 시작 화면의 모습. 같은 모습이면 다시 그리지 않는다. */
  startSurfaceKind?: "prompt" | "starting" | "failure";
  /** 세션을 띄운 셸의 경로. 이름을 붙이지 않은 자리가 보일 값의 출처다. */
  shellPath?: string;
}

const tabs = new Map<string, Tab>();

/** 확장 호스트가 준 배치. 여기서 바꾸지 않고 받은 값을 그대로 그린다. */
let layoutTree: LayoutTree = { root: null };
/** 배치에 담긴 자리별 값. 이름과 시작 상태의 출처다. */
let layoutTabs = new Map<string, LayoutTab>();
/** 확장 호스트가 준 세션들. */
let sessions = new Map<string, ViewSession>();
/** 시작 대기 자리가 보일 후보. */
let startPrompt: StartPrompt | undefined;
/** 끝난 것으로 이미 처리한 세션들. 끝나는 순간에 한 번만 할 일을 가린다. */
const handledExitedSessionIds = new Set<string>();

/** 확장 호스트가 미리 넘겨 둔, webview 가 스스로 띄우는 화면의 문자열. */
let viewTexts: ViewTexts | undefined;

/** 확장 호스트가 띄우라고 한 안내. 있으면 화면 전체를 이것만 보인다. */
let extensionNotice: LocalizedText | undefined;

/** 상태를 한 번이라도 받았는가. 받기 전의 빈 배치는 빈 상태가 아니다. */
let synced = false;

/** 첫 상태를 그린 뒤 한 번만 입력 자리를 잡는다. 그 뒤로는 사용자가 정한 자리를 뺏지 않는다. */
let focusedOnce = false;

/** 자리에 보이는 이름 — 붙인 이름이 있으면 그 값, 없으면 셸 이름이다. */
function tabDisplayName(tab: Tab): string | undefined {
  const assigned = layoutTabs.get(tab.tabId)?.name;
  if (assigned != null) return assigned;
  return tab.shellPath == null ? undefined : shellDisplayName(tab.shellPath);
}

/** VS Code 가 가질 키 — 에뮬레이터가 무시할 목록. 새 화면에도 이 값으로 시작한다. */
let blockedShellKeys: readonly string[] = [];

/** OSC 52 읽기의 대기 중 요청 — 확장 호스트의 `clipboardText` 응답이 풀어 준다. */
const clipboardReads = new Map<string, (text: string) => void>();

function readClipboardText(): Promise<string> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    clipboardReads.set(requestId, resolve);
    post({ type: "readClipboardText", requestId });
  });
}

const layoutView = new LayoutView(tabsElement, rootElement, {
  tabView: (tabId): TabView | undefined => {
    const tab = tabs.get(tabId);
    if (tab == null) return undefined;
    const name = tabDisplayName(tab);
    return { rootElement: tab.rootElement, ...(name == null ? {} : { name }) };
  },
  onActivateTab: (paneId, tabId) => {
    post({ type: "setActiveTab", paneId, tabId });
    post({ type: "setFocusedPane", paneId });
  },
  onFocusPane: (paneId) => post({ type: "setFocusedPane", paneId }),
  onMoveTab: (tabId, targetPaneId, position, insertIndex) =>
    post({
      type: "moveTab",
      tabId,
      targetPaneId,
      position,
      ...(insertIndex == null ? {} : { insertIndex }),
    }),
  onSetSplitRatio: (splitPath, boundaryIndex, firstRatio) =>
    post({ type: "setSplitRatio", splitPath, boundaryIndex, firstRatio }),
  // 누른 자리에 생겨야 손을 옮기지 않고 이어 쓸 수 있다.
  onNewTab: (paneId) => post({ type: "newTab", paneId }),
  onCloseTab: (tabId) => post({ type: "closeTab", tabId }),
  onRenameTab: (tabId, raw) => {
    const name = normalizeAssignedName(raw);
    post({ type: "renameTab", tabId, ...(name == null ? {} : { name }) });
  },
  // 가려져 있던 자리는 이제야 크기를 잴 수 있다. 재고 나서 입력을 받게 한다.
  onFocusTab: (tabId) => {
    const screen = tabs.get(tabId)?.screen;
    screen?.fit();
    screen?.focus();
    syncSearchTarget();
  },
});

const displayOptions = new DisplayOptionsSource((options) => {
  // 에뮬레이터가 칠하는 배경과 그 바깥 여백·자투리가 같은 색이어야 한 면으로 보인다.
  rootElement.style.setProperty("--terminal-background", options.colors.background);
  // tab 높이는 workbench 의 density 설정에서 온 값이다.
  rootElement.style.setProperty("--tab-height", `${options.tabHeight}px`);
  // modern UI 에서는 에디터 tab 이 칩 모양이라 이쪽 tab 도 같은 모양으로 그린다.
  rootElement.classList.toggle("modern-tabs", options.modernTabs);
  for (const tab of tabs.values()) tab.screen?.applyOptions(options);
});

// 테마를 바꾸면 workbench 가 이 문서의 테마 클래스를 갈아 끼운다. 짧은 간격으로 연달아 바뀌면
// 마지막 테마만 반영한다 — 매번 전체 화면을 다시 그리면 조작이 막힌다.
const themeSettleMs = 100;
let themeSettleTimer: ReturnType<typeof setTimeout> | undefined;
new MutationObserver(() => {
  clearTimeout(themeSettleTimer);
  themeSettleTimer = setTimeout(() => displayOptions.reloadColors(), themeSettleMs);
}).observe(document.body, {
  attributes: true,
  attributeFilter: ["class", "data-vscode-theme-kind", "data-vscode-theme-id"],
});

/**
 * 확장 호스트가 준 안내가 먼저다. 없고 자리가 하나도 없으면 빈 상태 안내와 함께 다시 시작할
 * 수단을 보인다 — 마지막 자리가 닫혔다고 세션을 자동으로 새로 만들지 않는다.
 */
function renderNotice(): void {
  if (extensionNotice != null) {
    setText(noticeTextElement, extensionNotice);
    noticeActionElement.hidden = true;
    noticeElement.hidden = false;
    return;
  }
  if (synced && layoutTree.root == null && viewTexts != null) {
    setText(noticeTextElement, viewTexts.emptyState);
    setText(noticeActionElement, viewTexts.startSession);
    noticeActionElement.hidden = false;
    noticeElement.hidden = false;
    return;
  }
  noticeElement.hidden = true;
}

function createTabElement(tabId: string): Tab {
  const tabRoot = document.createElement("div");
  tabRoot.className = "tab";
  tabRoot.dataset.tabId = tabId;
  const tab: Tab = { tabId, rootElement: tabRoot };
  tabs.set(tabId, tab);
  return tab;
}

/** 시작 대기 자리의 화면 자리. 없으면 만들어 붙이고, 있으면 비워 다시 채운다. */
function startSurface(tab: Tab): HTMLElement {
  const startElement = tab.startElement ?? document.createElement("div");
  startElement.className = "start";
  startElement.replaceChildren();
  if (tab.startElement == null) {
    tab.startElement = startElement;
    tab.rootElement.appendChild(startElement);
  }
  return startElement;
}

/** 시작 대기 자리에 문구 한 줄을 붙인다. */
function appendLine(parent: HTMLElement, className: string, text: LocalizedText): void {
  const element = document.createElement("p");
  element.className = className;
  setText(element, text);
  parent.appendChild(element);
}

/** 세션이 뜨기를 기다리는 화면. 기다리기를 그만두려면 그 자리를 닫는다. */
function renderStarting(tab: Tab): void {
  if (viewTexts == null) return;
  appendLine(startSurface(tab), "start-title", viewTexts.starting);
}

/** 시작 대기 자리의 화면 — 시작 폴더 후보와, 앞선 시도가 실패했으면 그 사유를 보인다. */
function renderStartPrompt(tab: Tab, failure: LocalizedText | undefined): void {
  if (startPrompt == null) return;
  const startElement = startSurface(tab);

  if (failure != null) appendLine(startElement, "start-failure", failure);
  if (startPrompt.unavailable != null) {
    appendLine(startElement, "start-failure", startPrompt.unavailable);
  }
  if (startPrompt.candidates.length > 0) {
    appendLine(startElement, "start-title", startPrompt.title);
  }

  for (const candidate of startPrompt.candidates) {
    const optionElement = document.createElement("button");
    optionElement.className = "start-option";
    const nameElement = document.createElement("span");
    nameElement.className = "start-folder";
    setDataText(nameElement, candidate.folderName);
    const pathElement = document.createElement("span");
    pathElement.className = "start-path";
    setDataText(pathElement, candidate.path);
    optionElement.append(nameElement, pathElement);
    optionElement.addEventListener("click", () =>
      post({ type: "startSession", tabId: tab.tabId, cwd: candidate.path }),
    );
    startElement.appendChild(optionElement);
  }

  startElement.querySelector<HTMLButtonElement>(".start-option")?.focus();
}

function attachScreen(tab: Tab, session: ViewSession): void {
  const displayed = displayOptions.current;
  if (displayed == null || tab.screen != null) return;
  const sessionId = session.sessionId;
  tab.sessionId = sessionId;
  tab.shellPath = session.shellPath;
  tab.startElement?.remove();
  tab.startElement = undefined;
  tab.startSurfaceKind = undefined;

  const screen = new TerminalScreen(displayed, {
    onInput: (data, binary) => post({ type: "input", sessionId, data, binary }),
    onResize: (rows, cols) => post({ type: "resize", sessionId, rows, cols }),
    onCopy: (text) => post({ type: "copyText", text }),
    onReadClipboard: () => post({ type: "readClipboard", sessionId }),
    onReadClipboardText: readClipboardText,
    onOpenUrl: (url) => post({ type: "openUrl", url }),
    onOpenFile: (link) => post({ type: "openFile", cwd: session.cwd, ...link }),
  });
  screen.applyBlockedShellKeys(blockedShellKeys);
  tab.screen = screen;
  tab.rootElement.appendChild(screen.rootElement);
  screen.fit();
}

/** 받은 상태대로 자리들을 맞춘다. 없어진 자리는 거두고, 새 자리는 만들어 채운다. */
function renderState(message: Extract<ExtensionToWebview, { type: "state" }>): void {
  synced = true;
  layoutTree = message.layout;
  layoutTabs = new Map();
  for (const pane of collectPanes(message.layout.root)) {
    for (const layoutTab of pane.tabs) layoutTabs.set(layoutTab.tabId, layoutTab);
  }
  sessions = new Map(message.sessions.map((session) => [session.sessionId, session]));
  startPrompt = message.prompt;

  for (const tab of Array.from(tabs.values())) {
    if (layoutTabs.has(tab.tabId)) continue;
    layoutView.closeOverlaysFor(tab.tabId);
    tab.screen?.dispose();
    tab.rootElement.remove();
    tabs.delete(tab.tabId);
  }

  // 자리를 먼저 만들어 화면에 놓아야 터미널이 글자 칸 크기를 잴 수 있다.
  for (const layoutTab of layoutTabs.values()) {
    if (!tabs.has(layoutTab.tabId)) createTabElement(layoutTab.tabId);
  }
  layoutView.render(layoutTree);

  for (const layoutTab of layoutTabs.values()) {
    const tab = tabs.get(layoutTab.tabId)!;
    const session = layoutTab.sessionId == null ? undefined : sessions.get(layoutTab.sessionId);
    if (session != null) {
      attachScreen(tab, session);
      if (session.exitedText != null) {
        // 그 세션 위에 떠 있던 메뉴·입력창은 대상을 잃었다. 끝나는 순간 한 번만 닫는다.
        if (!handledExitedSessionIds.has(session.sessionId)) {
          handledExitedSessionIds.add(session.sessionId);
          layoutView.closeOverlaysFor(tab.tabId);
        }
        tab.screen?.markExited(session.exitedText);
      }
      continue;
    }
    renderStartSurface(tab, layoutTab);
  }

  layoutView.render(layoutTree);
  renderNotice();
  syncSearchTarget();
  autoStartSingleCandidate();

  if (!focusedOnce) {
    const tabId = focusTargetFromTree();
    if (tabId != null) {
      focusedOnce = true;
      focusTab(tabId);
    }
  }
}

/** 세션이 없는 자리의 화면. 같은 모습이면 다시 그리지 않아 고르던 자리가 튀지 않는다. */
function renderStartSurface(tab: Tab, layoutTab: LayoutTab): void {
  const failure = layoutTab.startFailure;
  const kind = layoutTab.starting === true ? "starting" : failure != null ? "failure" : "prompt";
  if (tab.startSurfaceKind === kind && tab.startElement != null) return;
  tab.startSurfaceKind = kind;
  if (kind === "starting") {
    renderStarting(tab);
    return;
  }
  renderStartPrompt(tab, failure);
}

/** 후보가 하나면 묻지 않는다 — 고를 것이 없는데 물으면 내장 터미널과 반응이 갈린다. */
function autoStartSingleCandidate(): void {
  if (startPrompt == null || startPrompt.candidates.length !== 1) return;
  for (const layoutTab of layoutTabs.values()) {
    if (layoutTab.sessionId != null) continue;
    if (layoutTab.starting === true || layoutTab.startFailure != null) continue;
    post({ type: "startSession", tabId: layoutTab.tabId, cwd: startPrompt.candidates[0]!.path });
  }
}

/** 그 세션의 화면. 자리가 아직 없으면 없음이다. */
function screenOf(sessionId: string): TerminalScreen | undefined {
  for (const tab of tabs.values()) {
    if (tab.sessionId === sessionId) return tab.screen;
  }
  return undefined;
}

/** 지금 입력을 받아야 할 자리 — 포커스 pane 의 활성 tab 이다. */
function focusTargetFromTree(): string | undefined {
  return collectPanes(layoutTree.root).find((pane) => pane.paneId === layoutTree.focusedPaneId)
    ?.activeTabId;
}

/** 그 자리가 입력을 받게 한다. 세션이 아직 없으면 고를 후보가 입력을 받는다. */
function focusTab(tabId: string): void {
  const tab = tabs.get(tabId);
  if (tab == null) return;
  if (tab.screen != null) {
    tab.screen.focus();
    return;
  }
  tab.startElement?.querySelector<HTMLButtonElement>(".start-option")?.focus();
}

// ---- 검색 — 대상은 포커스 pane 의 활성 tab 하나다 ----

let searchTarget: TerminalScreen | undefined;
let searchResultsSubscription: { dispose(): void } | undefined;

const searchBar = new SearchBar(rootElement, {
  onQueryChange: (term) => {
    if (searchTarget == null) return;
    if (term.length === 0) {
      // 검색어가 없으면 강조를 모두 지운다. 남으면 결과로 오해한다.
      searchTarget.clearSearch();
      searchBar.setResult(undefined);
      return;
    }
    searchTarget.findNext(term, true);
  },
  onNext: (term) => {
    if (term.length > 0) searchTarget?.findNext(term, false);
  },
  onPrevious: (term) => {
    if (term.length > 0) searchTarget?.findPrevious(term);
  },
  onClose: () => {
    const closedTarget = searchTarget;
    closedTarget?.clearSearch();
    detachSearchTarget();
    // 검색을 마쳤으니 손이 터미널로 돌아간다.
    closedTarget?.focus();
  },
});

function detachSearchTarget(): void {
  searchResultsSubscription?.dispose();
  searchResultsSubscription = undefined;
  searchTarget = undefined;
}

function attachSearchTarget(screen: TerminalScreen | undefined): void {
  detachSearchTarget();
  searchTarget = screen;
  searchResultsSubscription = screen?.onSearchResults((state) => searchBar.setResult(state));
}

/** 지금 입력이 가는 화면 — 포커스 pane 의 활성 tab 이다. */
function focusedScreen(): TerminalScreen | undefined {
  const tabId = focusTargetFromTree();
  return tabId == null ? undefined : tabs.get(tabId)?.screen;
}

function openSearch(): void {
  const paneId = layoutTree.focusedPaneId;
  if (paneId == null || viewTexts == null) return;
  const paneRect = layoutView.paneRect(paneId);
  if (paneRect == null) return;
  attachSearchTarget(focusedScreen());
  searchBar.open(
    {
      label: viewTexts.searchLabel,
      previous: viewTexts.searchPrevious,
      next: viewTexts.searchNext,
      close: viewTexts.searchClose,
      noResults: viewTexts.searchNoResults,
    },
    paneRect,
  );
}

/** 검색 중 대상이 바뀌면 이전 강조를 지우고 새 대상에서 같은 검색어로 다시 찾는다. */
function syncSearchTarget(): void {
  if (!searchBar.isOpen) return;
  const paneId = layoutTree.focusedPaneId;
  const paneRect = paneId == null ? undefined : layoutView.paneRect(paneId);
  if (paneRect != null) searchBar.reposition(paneRect);
  const nextTarget = focusedScreen();
  if (nextTarget === searchTarget) return;
  searchTarget?.clearSearch();
  attachSearchTarget(nextTarget);
  const term = searchBar.term;
  if (nextTarget != null && term.length > 0) nextTarget.findNext(term, false);
  else searchBar.setResult(undefined);
}

// 검색을 여는 수단은 이 키 하나다 — 명령 등록 없이 webview 가 직접 받는다.
document.addEventListener(
  "keydown",
  (event) => {
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openSearch();
  },
  { capture: true },
);

// 뷰의 키보드 포커스 — 셸 편집 키를 덮는 keybinding 의 조건 키가 이 값을 따른다.
window.addEventListener("focus", () => post({ type: "viewFocus", focused: true }));
window.addEventListener("blur", () => post({ type: "viewFocus", focused: false }));

function handleMessage(message: ExtensionToWebview): void {
  switch (message.type) {
    case "displaySettings":
      displayOptions.applySettings(message.settings);
      return;
    case "shellKeys":
      blockedShellKeys = message.blockedKeys;
      for (const tab of tabs.values()) tab.screen?.applyBlockedShellKeys(message.blockedKeys);
      return;
    case "pasteText":
      screenOf(message.sessionId)?.pasteText(message.text);
      return;
    case "clipboardText":
      clipboardReads.get(message.requestId)?.(message.text);
      clipboardReads.delete(message.requestId);
      return;
    case "texts":
      viewTexts = message.texts;
      layoutView.setTexts(message.texts);
      layoutView.render(layoutTree);
      renderNotice();
      return;
    case "notice":
      extensionNotice = message.notice;
      renderNotice();
      return;
    case "state":
      renderState(message);
      return;
    case "output":
      screenOf(message.sessionId)?.write(new Uint8Array(message.bytes));
      return;
    case "restoreScreen":
      screenOf(message.sessionId)?.restore(
        new Uint8Array(message.bytes),
        message.rows,
        message.cols,
      );
      return;
  }
}

window.addEventListener("message", (event: MessageEvent<ExtensionToWebview>) => {
  handleMessage(event.data);
});

post({ type: "ready" });
