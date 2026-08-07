// 셸 편집 키 되찾기 계산. 셸로 넘길 키는 `terminal.integrated.commandsToSkipShell` 에 없는
// 명령의 키이고, 조합키 시작은 `allowChords` 를 따른다.
//
// 후보 키는 셸 편집(readline 등)에 쓰이면서 VS Code 기본 keybinding 이 가로채는 키로 한정한다.
// `Ctrl+F` 는 검색을 여는 키라 후보가 아니고, `Ctrl+C`·`Ctrl+D`·`Ctrl+L` 처럼 VS Code 기본
// keybinding 이 없는 키는 덮을 것이 없어 이미 셸에 닿는다.

import type { SettingsReader } from "./display-settings.ts";

interface ShellKeyCandidate {
  /** 조건 키 이름의 끝 조각. package.json keybinding 의 when 과 1:1 이다. */
  readonly contextName: string;
  /** 에뮬레이터 키 이벤트와 대조할 키 표기. */
  readonly key: string;
  /** 그 키의 VS Code 기본 명령. 조합키 시작이면 명령 대신 chord 로 표시한다. */
  readonly commandId?: string;
  readonly chord?: boolean;
}

/** 키 → 기본 명령 대응 (근거: VS Code 1.127 Windows 기본 keybinding). */
const shellKeyCandidates: readonly ShellKeyCandidate[] = [
  { contextName: "ctrlA", key: "ctrl+a", commandId: "editor.action.selectAll" },
  { contextName: "ctrlB", key: "ctrl+b", commandId: "workbench.action.toggleSidebarVisibility" },
  { contextName: "ctrlE", key: "ctrl+e", commandId: "workbench.action.quickOpen" },
  { contextName: "ctrlG", key: "ctrl+g", commandId: "workbench.action.gotoLine" },
  { contextName: "ctrlH", key: "ctrl+h", commandId: "editor.action.startFindReplaceAction" },
  { contextName: "ctrlJ", key: "ctrl+j", commandId: "workbench.action.togglePanel" },
  { contextName: "ctrlK", key: "ctrl+k", chord: true },
  { contextName: "ctrlN", key: "ctrl+n", commandId: "workbench.action.files.newUntitledFile" },
  { contextName: "ctrlO", key: "ctrl+o", commandId: "workbench.action.files.openFile" },
  { contextName: "ctrlP", key: "ctrl+p", commandId: "workbench.action.quickOpen" },
  { contextName: "ctrlR", key: "ctrl+r", commandId: "workbench.action.openRecent" },
  { contextName: "ctrlT", key: "ctrl+t", commandId: "workbench.action.showAllSymbols" },
  { contextName: "ctrlU", key: "ctrl+u", commandId: "cursorUndo" },
  { contextName: "ctrlW", key: "ctrl+w", commandId: "workbench.action.closeActiveEditor" },
  { contextName: "ctrlY", key: "ctrl+y", commandId: "redo" },
];

/**
 * 후보 명령 중 VS Code 의 기본 skip 목록에 이미 들어 있는 것. 설정값은 이 기본 목록에
 * 더하고(`명령`) 빼는(`-명령`) 증분이다 (근거: VS Code 설정 스키마의 commandsToSkipShell 설명
 * — `-` 접두로 기본 목록에서 제거. 기본 목록은 VS Code 1.127 설치본 workbench 번들의
 * 기본 배열 실측).
 */
const defaultSkippedCandidateCommands = new Set([
  "workbench.action.quickOpen",
  "workbench.action.togglePanel",
]);

/** 조건 키 이름 → 켜짐(그 키를 셸로 넘김) 여부. */
export function computeShellKeyStates(read: SettingsReader): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const candidate of shellKeyCandidates) {
    states[`simplysm-terminal.shellKey.${candidate.contextName}`] =
      !vscodeKeepsKey(candidate, read);
  }
  return states;
}

/**
 * VS Code 가 가질 후보 키 목록. 에뮬레이터가 이 키를 무시해야 그 키가 셸에도 함께 들어가는
 * 이중 반응이 없다 — 내장 터미널도 skip 목록의 키를 에뮬레이터에 넣지 않는다.
 */
export function computeBlockedShellKeys(read: SettingsReader): string[] {
  return shellKeyCandidates
    .filter((candidate) => vscodeKeepsKey(candidate, read))
    .map((candidate) => candidate.key);
}

function vscodeKeepsKey(candidate: ShellKeyCandidate, read: SettingsReader): boolean {
  const skipSetting = read("terminal.integrated.commandsToSkipShell");
  const entries = Array.isArray(skipSetting)
    ? skipSetting.filter((entry): entry is string => typeof entry === "string")
    : [];
  const removedCommands = new Set(
    entries.filter((entry) => entry.startsWith("-")).map((entry) => entry.slice(1)),
  );
  const addedCommands = new Set(entries.filter((entry) => !entry.startsWith("-")));
  const allowChords = read("terminal.integrated.allowChords") !== false;

  if (candidate.chord === true) return allowChords;
  return (
    candidate.commandId != null &&
    ((defaultSkippedCandidateCommands.has(candidate.commandId) &&
      !removedCommands.has(candidate.commandId)) ||
      addedCommands.has(candidate.commandId))
  );
}
