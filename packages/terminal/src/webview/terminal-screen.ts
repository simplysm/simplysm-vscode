// tab 하나에 대응하는 터미널 화면. 출력을 그대로 넣고, 키 입력과 크기를 셸로 내보낸다.

import {
  Terminal,
  type FontWeight,
  type ITerminalOptions,
  type ITheme,
} from "@xterm/xterm";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { LocalizedText } from "../l10n.ts";
import type { DisplayOptions } from "./display-options.ts";
import { setText } from "./dom-text.ts";
import { detectFileLinks } from "./output/file-link-detect.ts";

/** 출력에서 찾은 파일 링크 한 건. 상대 경로 해석은 세션 시작 디렉터리를 아는 확장 호스트 몫이다. */
export interface FileLinkRequest {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

export interface TerminalScreenCallbacks {
  /** 셸로 보낼 바이트. 에뮬레이터가 스스로 되돌리는 응답도 같은 경로로 나온다. */
  readonly onInput: (data: string, binary: boolean) => void;
  readonly onResize: (rows: number, cols: number) => void;
  /** 선택한 텍스트를 클립보드에 넣어 달라. 빈 선택은 여기 오지 않는다. */
  readonly onCopy: (text: string) => void;
  /** 클립보드를 읽어 붙여넣기를 이어 달라. */
  readonly onReadClipboard: () => void;
  /** OSC 52 읽기 — 클립보드 텍스트를 되돌려 달라. 텍스트가 없으면 빈 문자열이다. */
  readonly onReadClipboardText: () => Promise<string>;
  readonly onOpenUrl: (url: string) => void;
  readonly onOpenFile: (link: FileLinkRequest) => void;
}

export interface SearchResultState {
  readonly resultIndex: number;
  readonly resultCount: number;
}

function toTheme(options: DisplayOptions): ITheme {
  const { colors } = options;
  const ansi = colors.ansi;
  return {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.cursorForeground,
    cursorAccent: colors.cursorBackground,
    selectionBackground: colors.selectionBackground,
    ...(colors.selectionForeground == null
      ? {}
      : { selectionForeground: colors.selectionForeground }),
    selectionInactiveBackground: colors.inactiveSelectionBackground,
    ...(ansi == null
      ? {}
      : {
          black: ansi[0],
          red: ansi[1],
          green: ansi[2],
          yellow: ansi[3],
          blue: ansi[4],
          magenta: ansi[5],
          cyan: ansi[6],
          white: ansi[7],
          brightBlack: ansi[8],
          brightRed: ansi[9],
          brightGreen: ansi[10],
          brightYellow: ansi[11],
          brightBlue: ansi[12],
          brightMagenta: ansi[13],
          brightCyan: ansi[14],
          brightWhite: ansi[15],
        }),
  };
}

/** 글꼴 이름이 없으면 에디터 글꼴로 그린다. 내장 터미널과 같은 대체다. */
function resolveFontFamily(options: DisplayOptions): string | undefined {
  if (options.fontFamily != null) return options.fontFamily;
  const editorFont = getComputedStyle(document.documentElement)
    .getPropertyValue("--vscode-editor-font-family")
    .trim();
  return editorFont.length === 0 ? undefined : editorFont;
}

export class TerminalScreen {
  readonly rootElement: HTMLElement;
  readonly #terminal: Terminal;
  readonly #fitAddon = new FitAddon();
  readonly #searchAddon = new SearchAddon();
  readonly #resizeObserver: ResizeObserver;
  readonly #exitElement: HTMLElement;
  readonly #callbacks: TerminalScreenCallbacks;
  /** VS Code 가 가질 키. 에뮬레이터가 무시해야 같은 키가 셸에도 들어가는 이중 반응이 없다. */
  #blockedShellKeys: ReadonlySet<string> = new Set();
  #displayed: DisplayOptions;
  #exited = false;
  /** 지난 화면 재생 중 — 크기 맞춤이 끼어들면 재생 크기가 어긋난다. */
  #restoring = false;
  #webglAddon?: WebglAddon;
  /** WebGL 이 한 번 실패한 화면은 다시 시도하지 않는다 — 같은 환경에서 또 실패한다. */
  #webglFailed = false;

  constructor(options: DisplayOptions, callbacks: TerminalScreenCallbacks) {
    this.#callbacks = callbacks;
    this.#displayed = options;

    this.rootElement = document.createElement("div");
    this.rootElement.className = "screen";
    const surfaceElement = document.createElement("div");
    surfaceElement.className = "screen-surface";
    this.#exitElement = document.createElement("div");
    this.#exitElement.className = "screen-exit";
    this.#exitElement.hidden = true;
    this.rootElement.append(surfaceElement, this.#exitElement);

    this.#terminal = new Terminal({ allowProposedApi: true, ...toTerminalOptions(options) });
    this.#terminal.loadAddon(this.#fitAddon);
    this.#terminal.loadAddon(this.#searchAddon);
    // OSC 52 — 셸 안의 프로그램(vim, tmux 등)의 클립보드 접근. 내장 터미널과 같은 부가기능이며,
    // webview 는 클립보드를 직접 만질 수 없어 확장 호스트를 거친다.
    this.#terminal.loadAddon(
      new ClipboardAddon(undefined, {
        readText: () => callbacks.onReadClipboardText(),
        writeText: async (_selection, text) => callbacks.onCopy(text),
      }),
    );
    this.#terminal.open(surfaceElement);
    this.#applyRenderer(options);
    this.#registerWebLinks();
    this.#registerFileLinkProvider();
    this.#wireOutputActions(surfaceElement);

    // 셸로 넘기지 않을 키 걸러내기 — 내장 터미널도 skip 목록의 키를 에뮬레이터에 넣지 않는다.
    this.#terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      // 내장 터미널과 같은 복사·붙여넣기 — Ctrl+C 는 선택이 있을 때만 복사, 없으면 SIGINT 로 셸에 간다.
      // Ctrl+Shift+C·Ctrl+Shift+V 는 선택 여부와 무관하게 복사·붙여넣기다.
      if (event.ctrlKey && !event.altKey && !event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === "c" && (event.shiftKey || this.#terminal.hasSelection())) {
          event.preventDefault();
          this.copySelection();
          return false;
        }
        if (key === "v") {
          // Ctrl+V 는 workbench 가 webview 에 native paste 이벤트를 넣어 이미 붙여넣는다.
          // 여기서 또 요청하면 두 번 붙는다 — 에뮬레이터가 ^V 를 셸로 보내지 않게만 막는다.
          if (event.shiftKey) {
            // Ctrl+Shift+V 는 workbench 가 다루지 않아 직접 요청한다.
            event.preventDefault();
            this.requestPaste();
          }
          return false;
        }
      }
      const combo = plainCtrlCombo(event);
      return combo == null || !this.#blockedShellKeys.has(combo);
    });

    // 끝난 세션에는 보낼 곳이 없다. 보내면 호스트가 없는 셸에 대한 오류로 되돌린다.
    this.#terminal.onData((data) => {
      if (!this.#exited) callbacks.onInput(data, false);
    });
    this.#terminal.onBinary((data) => {
      if (!this.#exited) callbacks.onInput(data, true);
    });
    this.#terminal.onResize(({ rows, cols }) => {
      if (!this.#exited) callbacks.onResize(rows, cols);
    });

    // 화면 영역이 바뀌면 다시 맞춘다. 감지는 우리 몫이고 환산은 크기 맞춤이 한다.
    this.#resizeObserver = new ResizeObserver(() => this.fit());
    this.#resizeObserver.observe(surfaceElement);
    this.fit();
  }

  /** 받은 순서와 내용 그대로 넣는다. */
  write(bytes: Uint8Array): void {
    this.#terminal.write(bytes);
  }

  /**
   * 지난 화면 재생 — 직렬화 당시 크기로 맞춰 그대로 그린 뒤, 실제 pane 크기로 한 번만
   * reflow 한다. 재생 중의 크기 맞춤은 잠근다 — 다른 크기로 재생되면 줄바꿈이 어긋난다.
   */
  restore(bytes: Uint8Array, rows: number, cols: number): void {
    this.#restoring = true;
    this.#terminal.resize(cols, rows);
    this.#terminal.write(bytes, () => {
      this.#restoring = false;
      this.fit();
    });
  }

  applyOptions(options: DisplayOptions): void {
    this.#displayed = options;
    const next = toTerminalOptions(options);
    for (const [key, value] of Object.entries(next)) {
      (this.#terminal.options as Record<string, unknown>)[key] = value;
    }
    this.#applyRenderer(options);
    this.fit();
  }

  /** 숨긴 화면은 크기를 잴 수 없어 맞추지 않는다. 마지막으로 알린 행·열이 그대로 유지된다. */
  fit(): void {
    if (this.#restoring) return;
    if (this.rootElement.offsetParent == null) return;
    this.#fitAddon.fit();
  }

  focus(): void {
    this.#terminal.focus();
  }

  /** 세션이 끝났다. 입력을 더 받지 않고 마지막 출력을 그대로 둔 채 사유만 덧붙인다. */
  markExited(text: LocalizedText): void {
    this.#exited = true;
    this.#terminal.options.disableStdin = true;
    setText(this.#exitElement, text);
    this.#exitElement.hidden = false;
  }

  /** 렌더러를 설정에 맞춘다. 내장 터미널과 같이 "off" 만 DOM 이고, WebGL 실패 시 DOM 으로 돌아간다. */
  #applyRenderer(options: DisplayOptions): void {
    const wantWebgl = options.gpuAcceleration !== "off" && !this.#webglFailed;
    if (wantWebgl === (this.#webglAddon != null)) return;

    if (!wantWebgl) {
      this.#webglAddon?.dispose();
      this.#webglAddon = undefined;
      return;
    }

    try {
      const addon = new WebglAddon();
      // GPU context 를 잃으면(드라이버 재시작 등) DOM 렌더러로 내려간다.
      addon.onContextLoss(() => this.#dropWebgl("context loss"));
      this.#terminal.loadAddon(addon);
      this.#webglAddon = addon;
    } catch (error) {
      this.#webglAddon = undefined;
      this.#dropWebgl(error);
    }
  }

  #dropWebgl(reason: unknown): void {
    this.#webglFailed = true;
    this.#webglAddon?.dispose();
    this.#webglAddon = undefined;
    console.error("terminal: WebGL renderer unavailable, falling back to DOM renderer.", reason);
  }

  dispose(): void {
    this.#resizeObserver.disconnect();
    this.#terminal.dispose();
    this.rootElement.remove();
  }

  // ---- 출력 활용 — 검색·링크·복사·붙여넣기 ----

  applyBlockedShellKeys(blockedKeys: readonly string[]): void {
    this.#blockedShellKeys = new Set(blockedKeys);
  }

  /** 검색 — 강조 색은 테마의 터미널 검색 색이다. 결과 유무를 그대로 되돌린다. */
  findNext(term: string, incremental: boolean): boolean {
    return this.#searchAddon.findNext(term, { ...this.#searchOptions(), incremental });
  }

  findPrevious(term: string): boolean {
    return this.#searchAddon.findPrevious(term, this.#searchOptions());
  }

  /** 검색어가 없어졌거나 대상이 바뀌었다. 이전 강조가 남으면 결과로 오해한다. */
  clearSearch(): void {
    this.#searchAddon.clearDecorations();
    this.#terminal.clearSelection();
  }

  onSearchResults(listener: (state: SearchResultState) => void): { dispose(): void } {
    return this.#searchAddon.onDidChangeResults(listener);
  }

  /** 선택이 비었으면 클립보드를 건드리지 않는다. 접힌 줄 이어 붙이기는 에뮬레이터가 이미 했다. */
  copySelection(): void {
    const selection = this.#terminal.getSelection();
    if (selection.length === 0) return;
    this.#callbacks.onCopy(selection);
  }

  /** 붙여넣기의 진입점. 클립보드는 확장 호스트만 읽을 수 있다. */
  requestPaste(): void {
    if (this.#exited) return;
    this.#callbacks.onReadClipboard();
  }

  /** 붙여넣기. 대괄호 붙여넣기 감싸기는 에뮬레이터가 한다. */
  pasteText(text: string): void {
    if (this.#exited || text.length === 0) return;
    this.#terminal.paste(text);
  }

  #searchOptions(): ISearchOptions {
    const { colors } = this.#displayed;
    return {
      decorations: {
        matchBackground: colors.findMatchHighlightBackground,
        ...(colors.findMatchHighlightBorder == null
          ? {}
          : { matchBorder: colors.findMatchHighlightBorder }),
        activeMatchBackground: colors.findMatchBackground,
        ...(colors.findMatchBorder == null ? {} : { activeMatchBorder: colors.findMatchBorder }),
        matchOverviewRuler: colors.findMatchHighlightBackground,
        activeMatchColorOverviewRuler: colors.findMatchBackground,
      },
    };
  }

  /** URL 링크는 에뮬레이터 부가기능 몫이다. */
  #registerWebLinks(): void {
    this.#terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        // 링크는 Ctrl 을 누른 채 클릭할 때만 연다. 그냥 클릭은 선택이다.
        if (!event.ctrlKey) return;
        this.#callbacks.onOpenUrl(uri);
      }),
    );
  }

  /** 파일 경로 인식은 에뮬레이터에 없어 자체로 붙인다. */
  #registerFileLinkProvider(): void {
    this.#terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const lineText = this.#terminal.buffer.active
          .getLine(bufferLineNumber - 1)
          ?.translateToString(true);
        if (lineText == null || lineText.length === 0) {
          callback(undefined);
          return;
        }
        callback(
          detectFileLinks(lineText).map((match) => ({
            range: {
              start: { x: match.startIndex + 1, y: bufferLineNumber },
              end: { x: match.startIndex + match.length, y: bufferLineNumber },
            },
            text: lineText.slice(match.startIndex, match.startIndex + match.length),
            activate: (event: MouseEvent) => {
              if (!event.ctrlKey) return;
              this.#callbacks.onOpenFile({
                path: match.path,
                ...(match.line == null ? {} : { line: match.line }),
                ...(match.column == null ? {} : { column: match.column }),
              });
            },
          })),
        );
      },
    });
  }

  /** 마우스 조작 — 우클릭은 내장 터미널의 Windows 기본과 같다: 선택이 있으면 복사, 없으면 붙여넣기. */
  #wireOutputActions(surfaceElement: HTMLElement): void {
    // capture + 전파 중단 — 에뮬레이터의 자체 우클릭 처리(브라우저 기본 메뉴용으로 숨은
    // textarea 에 선택 텍스트를 채움)가 돌면 그 값이 입력 경로로 흘러 셸에 붙여넣어진다.
    surfaceElement.addEventListener(
      "contextmenu",
      (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.#terminal.hasSelection()) {
          this.copySelection();
          // 내장 터미널과 같다 — 복사를 마친 선택은 풀어, 다음 우클릭이 붙여넣기로 이어진다.
          this.#terminal.clearSelection();
          return;
        }
        this.requestPaste();
      },
      { capture: true },
    );
  }

}

/** 수식 없는 Ctrl+글자 조합의 표기. 그 밖의 키는 걸러낼 대상이 아니다. */
function plainCtrlCombo(event: KeyboardEvent): string | undefined {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return undefined;
  return /^[a-z]$/i.test(event.key) ? `ctrl+${event.key.toLowerCase()}` : undefined;
}

function toTerminalOptions(options: DisplayOptions): ITerminalOptions {
  const fontFamily = resolveFontFamily(options);
  return {
    ...(fontFamily == null ? {} : { fontFamily }),
    fontSize: options.fontSize,
    // 굵기는 VS Code 설정 스키마가 허용한 숫자·이름이 그대로 오며, 에뮬레이터가 받는 값과 같다.
    fontWeight: options.fontWeight as FontWeight,
    fontWeightBold: options.fontWeightBold as FontWeight,
    letterSpacing: options.letterSpacing,
    lineHeight: options.lineHeight,
    scrollback: options.scrollback,
    theme: toTheme(options),
  };
}
