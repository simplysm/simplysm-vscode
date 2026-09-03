// 확장 호스트와 webview 사이에 오가는 내용. webview 는 번역 조회 수단을 두지 않으므로,
// 화면에 그릴 글자는 확장 호스트가 번역을 마친 값으로만 실려 온다.
// 배치와 세션의 원본은 daemon 에 있고 확장 호스트가 번역해 중계한다. webview 는 daemon 의 존재를
// 모른다 — 받은 상태를 그리고 조작은 요청으로 보낸다.

import type { DisplaySettings } from "./display-settings.ts";
import type { LocalizedText } from "./l10n.ts";
import type { LayoutTree } from "./layout/layout-tree.ts";
import type { DropPosition } from "./layout/layout-operations.ts";
import type { StartDirectoryCandidate } from "./start-directory.ts";

/** 화면에 그릴 세션 하나. */
export interface ViewSession {
  readonly sessionId: string;
  /** 그 세션을 띄운 셸의 실행 파일 경로. 이름을 붙이지 않은 자리가 보일 값의 출처다. */
  readonly shellPath: string;
  /** 출력 속 상대 경로를 풀 기준 디렉터리. */
  readonly cwd: string;
  /** 끝난 세션이면 그 표시 문구. 도는 중이면 없음. */
  readonly exitedText?: LocalizedText;
}

/** webview 가 스스로 띄우는 화면의 문자열. */
export interface ViewTexts {
  /** 자리가 하나도 없는 상태의 안내. */
  readonly emptyState: LocalizedText;
  /** 그 상태에서 터미널을 다시 시작하는 수단의 라벨. */
  readonly startSession: LocalizedText;
  /** 셸이 뜨기를 기다리는 동안 그 자리에 보이는 문구. */
  readonly starting: LocalizedText;
  /** 셸이 아직 붙지 않은 자리의 이름 자리에 보이는 문구. */
  readonly choosingFolder: LocalizedText;
  /** tab 줄 끝 + 버튼의 설명. */
  readonly newTab: LocalizedText;
  /** tab 우클릭 메뉴의 이름 바꾸기 항목. */
  readonly renameTab: LocalizedText;
  /** tab 우클릭 메뉴의 tab 닫기 항목. */
  readonly closeTab: LocalizedText;
  /** 이름 바꾸기 입력창의 라벨. */
  readonly renameLabel: LocalizedText;
  /** 검색 입력창의 라벨. */
  readonly searchLabel: LocalizedText;
  /** 검색의 이전 일치로 가는 버튼 설명. */
  readonly searchPrevious: LocalizedText;
  /** 검색의 다음 일치로 가는 버튼 설명. */
  readonly searchNext: LocalizedText;
  /** 검색창 닫기 버튼 설명. */
  readonly searchClose: LocalizedText;
  /** 일치가 0건일 때 결과 자리에 보이는 문구. */
  readonly searchNoResults: LocalizedText;
}

/** 시작 대기 자리의 화면에 보일 내용. 셸이 붙기 전까지 그 자리를 채운다. */
export interface StartPrompt {
  readonly title: LocalizedText;
  readonly candidates: readonly StartDirectoryCandidate[];
  /** 고를 것이 없는 사유. 후보가 비었는데 빈 화면만 남기지 않는다. */
  readonly unavailable?: LocalizedText;
}

export type ExtensionToWebview =
  | { readonly type: "displaySettings"; readonly settings: DisplaySettings }
  /** VS Code 가 가질 키 — 에뮬레이터가 이 키를 무시해야 셸에 함께 들어가지 않는다. */
  | { readonly type: "shellKeys"; readonly blockedKeys: readonly string[] }
  /** 클립보드에서 읽은 텍스트. 그 세션의 셸 입력으로 보낸다. */
  | { readonly type: "pasteText"; readonly sessionId: string; readonly text: string }
  /** `readClipboardText` 요청의 응답. 텍스트가 없으면 빈 문자열이다. */
  | { readonly type: "clipboardText"; readonly requestId: string; readonly text: string }
  | { readonly type: "texts"; readonly texts: ViewTexts }
  /** 안내가 있으면 화면 전체를 이것만 보인다. 없으면 상태를 그린다. */
  | { readonly type: "notice"; readonly notice?: LocalizedText }
  /**
   * 터미널 서비스가 죽어 모든 세션을 잃었다. 화면 위쪽 bar 로 사실과 다시 시작할 수단을 보인다 —
   * 죽은 화면은 그대로 두어 읽고 복사할 수 있다. bar 가 없으면 숨긴다.
   */
  | {
      readonly type: "serviceLost";
      readonly banner?: { readonly text: LocalizedText; readonly action: LocalizedText };
    }
  /** 확장 호스트가 가진 상태 전체. 화면은 이 값만으로 그려진다. */
  | {
      readonly type: "state";
      readonly layout: LayoutTree;
      readonly sessions: readonly ViewSession[];
      readonly prompt: StartPrompt;
    }
  | { readonly type: "output"; readonly sessionId: string; readonly bytes: ArrayBuffer }
  /** 지난 화면 재생 — 직렬화 당시 크기로 맞춰 그린 뒤 실제 크기로 reflow 해야 한다. */
  | {
      readonly type: "restoreScreen";
      readonly sessionId: string;
      readonly bytes: ArrayBuffer;
      readonly rows: number;
      readonly cols: number;
    };

export type WebviewToExtension =
  | { readonly type: "ready" }
  /** webview 안에서 잡히지 않은 오류가 났다. webview 콘솔은 사용자가 열지 않으면 아무도 못 보므로 호스트가 기록한다. */
  | { readonly type: "viewError"; readonly detail: string }
  /** 죽은 터미널 서비스를 다시 시작해 달라. 확인은 확장 호스트가 받는다. */
  | { readonly type: "restartService" }
  /** 새 자리를 만든다. pane 을 실으면 그 pane 에, 없으면 포커스 pane 이나 빈 배치에 만든다. */
  | { readonly type: "newTab"; readonly paneId?: string }
  /** 시작 대기 자리에서 시작 폴더가 정해졌다. */
  | { readonly type: "startSession"; readonly tabId: string; readonly cwd: string }
  /** 그 자리를 없앤다. 붙어 있던 셸은 안에서 무언가 돌고 있어도 종료한다. */
  | { readonly type: "closeTab"; readonly tabId: string }
  /** 자리 이름을 넣거나(값 지정) 뺀다(없음). */
  | { readonly type: "renameTab"; readonly tabId: string; readonly name?: string }
  | {
      readonly type: "moveTab";
      readonly tabId: string;
      readonly targetPaneId: string;
      readonly position: DropPosition;
      /** center 전용 — 대상 pane 의 tab 사이 삽입 자리. 없으면 맨 뒤. */
      readonly insertIndex?: number;
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
      /** 에뮬레이터가 바이트 단위로 되돌린 응답이면 참. 글자 인코딩이 갈린다. */
      readonly binary: boolean;
    }
  | {
      readonly type: "resize";
      readonly sessionId: string;
      readonly rows: number;
      readonly cols: number;
    }
  /** 받은 출력을 화면에 다 그렸다. 이 되돌림으로 셸 출력 속도가 화면 소비 속도에 맞춰진다. */
  | { readonly type: "outputAck"; readonly sessionId: string; readonly bytes: number }
  /** 선택한 텍스트를 클립보드에 넣는다. 빈 선택은 webview 가 걸러 보내지 않는다. */
  | { readonly type: "copyText"; readonly text: string }
  /** 붙여넣기 — 클립보드를 읽어 `pasteText` 로 되돌려 달라. */
  | { readonly type: "readClipboard"; readonly sessionId: string }
  /** OSC 52 읽기 — 클립보드 텍스트를 `clipboardText` 응답으로 되돌려 달라. */
  | { readonly type: "readClipboardText"; readonly requestId: string }
  /** 출력 속 URL 을 `Ctrl` + 클릭했다. 브라우저로 연다. */
  | { readonly type: "openUrl"; readonly url: string }
  /** 출력 속 파일 경로를 `Ctrl` + 클릭했다. 상대 경로는 실은 기준 디렉터리로 푼다. */
  | {
      readonly type: "openFile";
      readonly cwd: string;
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
    }
  /** 뷰의 키보드 포커스가 바뀌었다. 셸 편집 키 조건 키의 입력이다. */
  | { readonly type: "viewFocus"; readonly focused: boolean };
