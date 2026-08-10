// 리스트 UI webview 본체 (spec §4.2·§4.3·§4.4·§4.7, §8 "행 상시 편집" 재설계) —
// 모든 행이 항상 편집 가능한 textarea 이고, 갱신은 행 단위 재조정으로 수행한다.
// 편집 중인 행의 DOM 을 파괴하지 않으므로 포커스·캐럿·입력값이 구조적으로 유지된다.

import "@vscode/codicons/dist/codicon.css";
import "./style.css";
import {
  parseTasksFile,
  isGroupHeader,
  isCollapsed,
  type TaskItem,
  type GroupHeader,
  type TaskLine,
} from "../tasks-model.ts";
import * as listOps from "../list-ops.ts";
import { setL10nBundle, t } from "../l10n.ts";

type HostMessage =
  | { type: "doc"; text: string }
  | { type: "config"; lineHeight: string }
  | { type: "historyKey"; action: "undo" | "redo" };

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};
const vscodeApi = acquireVsCodeApi();

// 번역 번들 — 호스트가 HTML inline JSON 으로 주입 (spec §4.9)
setL10nBundle((globalThis as { __simplysmTasksL10n?: Record<string, string> }).__simplysmTasksL10n);

/** codicon 아이콘 요소 (spec §4.2 — VS Code 공식 아이콘 폰트). */
function createIcon(iconName: string): HTMLSpanElement {
  const iconEl = document.createElement("span");
  iconEl.className = `codicon codicon-${iconName}`;
  iconEl.setAttribute("aria-hidden", "true"); // 장식 아이콘 — 접근성 트리 제외 (리뷰)
  return iconEl;
}

// ---------------------------------------------------------------------------
// 루트 DOM — 목록 컨테이너·오류 화면·그룹 추가 영역은 영속 노드 (전체 재렌더 금지, spec §8)
// ---------------------------------------------------------------------------

const rootEl = document.createElement("main");
rootEl.id = "tasks-root";
// 빈 상태 안내 (리뷰: 첫 진입 발견성) — 항목·그룹 0 일 때만 노출.
// 입력법 + "완료=삭제·undo" 철학을 최초 알리는 유일 지점.
const emptyHintEl = document.createElement("p");
emptyHintEl.className = "empty-hint";
emptyHintEl.hidden = true;
emptyHintEl.textContent = t(
  "Click below and type to add your first task. Enter saves, Shift+Enter adds a line. The eraser button deletes a task — Undo brings it back.",
);
const sectionsEl = document.createElement("div");
sectionsEl.id = "tasks-sections";
const errorEl = document.createElement("div");
errorEl.className = "parse-error";
errorEl.setAttribute("role", "alert");
errorEl.hidden = true;
rootEl.append(emptyHintEl, sectionsEl, errorEl);
document.body.appendChild(rootEl);

/** 현재 파일 상태의 줄들(항목·그룹 헤더) — 미지 필드 보존을 위해 객체 전체 유지 (spec §4.3·§5.2). */
let currentLines: TaskLine[] = [];

// ---------------------------------------------------------------------------
// 삭제 Undo 토스트 (리뷰: "완료=삭제" 안전망 가시화) — 삭제 순간 인라인 되돌리기 노출.
// 툴팁 밖 발견성 0 이던 undo(Ctrl+Z) 를 클릭 어포던스로 표면화. 문서 이력 undo 로 위임.
// ---------------------------------------------------------------------------

const undoToastEl = document.createElement("div");
undoToastEl.className = "undo-toast";
undoToastEl.hidden = true;
undoToastEl.setAttribute("role", "status");
const undoToastLabel = document.createElement("span");
const undoToastButton = document.createElement("button");
undoToastButton.className = "undo-toast-action";
undoToastButton.textContent = t("Undo");
undoToastEl.append(undoToastLabel, undoToastButton);
document.body.appendChild(undoToastEl);

let undoToastTimer: ReturnType<typeof setTimeout> | undefined;

function hideUndoToast(): void {
  undoToastEl.hidden = true;
  if (undoToastTimer != null) clearTimeout(undoToastTimer);
  undoToastTimer = undefined;
}

/** 삭제 직후 인라인 되돌리기 배너 — 수 초 후 자동 소멸, 새 삭제는 타이머 갱신. */
function showUndoToast(message: string): void {
  undoToastLabel.textContent = message;
  undoToastEl.hidden = false;
  if (undoToastTimer != null) clearTimeout(undoToastTimer);
  undoToastTimer = setTimeout(hideUndoToast, 5000);
}

undoToastButton.addEventListener("click", () => {
  hideUndoToast();
  vscodeApi.postMessage({ type: "history", action: "undo" });
});

// ---------------------------------------------------------------------------
// 행 — 항목 행(파일 기록)·고스트 행(그룹 끝 상시 추가 입력)·임시 행(Enter 로 생성, 미기록)
// ---------------------------------------------------------------------------

interface Row {
  kind: "item" | "ghost" | "draft";
  /** kind=item 일 때 대응 줄 — 수정 확정 시 새 객체로 재바인딩. */
  line: TaskItem | null;
  /** kind=ghost 일 때 소속 섹션 헤더(null = 미분류). */
  sectionHeader: GroupHeader | null;
  /** kind=draft 일 때 삽입 기준(이 항목 뒤). 사라지면 확정 시 목록 끝 (spec §4.6). */
  anchor: TaskItem | null;
  readonly rootEl: HTMLLIElement;
  readonly textarea: HTMLTextAreaElement;
}

/** 항목 행 레지스트리 — 줄 객체 identity → 행. 수정·외부 변경 시 키 재바인딩. */
const itemRows = new Map<TaskItem, Row>();

/** 임시 행은 동시에 1개 (Enter 연속 입력용, spec §4.3). */
let draftRow: Row | null = null;

/** 행이 미수정 상태인가 — pristine 이면 Ctrl+Z/Y 를 문서 undo 로 위임 (spec §4.5). */
function isPristine(row: Row): boolean {
  return row.kind === "item" ? row.textarea.value === row.line!.text : row.textarea.value === "";
}

/** textarea 높이를 내용에 맞춤 — 여러 줄 항목 표시. */
function resizeTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

/** 재조정으로 포커스 노드가 이동해도 포커스·캐럿을 되살림 (spec §8 행 단위 재조정). */
function withFocusPreserved(update: () => void): void {
  const active = document.activeElement;
  const isEditable =
    (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
    rootEl.contains(active);
  if (!isEditable) {
    update();
    return;
  }
  const selStart = active.selectionStart ?? 0;
  const selEnd = active.selectionEnd ?? 0;
  update();
  if (document.activeElement !== active && active.isConnected) {
    active.focus();
    active.setSelectionRange(selStart, selEnd);
  }
}

/**
 * blur = 확정 (spec §4.3). 단 재조정의 노드 이동이 내는 일시 blur 는 확정이 아니므로,
 * 다음 태스크에서 포커스가 같은 칸으로 복원됐으면 건너뜀 (withFocusPreserved 가 동기 복원).
 */
function onEditableBlur(el: HTMLElement, confirm: () => void): void {
  el.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement === el || !el.isConnected) return;
      confirm();
    }, 0);
  });
}

// ---------------------------------------------------------------------------
// 확정 조작 → 즉시 저장 (spec §4.3·§3.1) — 낙관 갱신 + 호스트 위임, 성공 시 에코 없음
// ---------------------------------------------------------------------------

function applyLines(nextLines: TaskLine[]): void {
  hideUndoToast(); // 새 확정 편집이 들어오면 이전 삭제 토스트는 되돌림 대상이 어긋나므로 내림 (리뷰)
  currentLines = nextLines;
  vscodeApi.postMessage({ type: "apply", lines: nextLines });
  render();
}

/** 무변경이면 저장 생략 (원위치 드롭·끝 이동, spec §4.4). */
function reorderLines(nextLines: TaskLine[]): void {
  if (
    nextLines.length === currentLines.length &&
    nextLines.every((cur, i) => cur === currentLines[i])
  ) {
    render();
    return;
  }
  applyLines(nextLines);
}

/**
 * 행 확정 (spec §4.3) — 무변경 = 생략, 빈 값 = 항목이면 삭제·고스트/임시면 미생성.
 * 확정 후 살아있는 항목을 반환(삭제·미생성이면 null).
 */
function confirmRow(row: Row): TaskItem | null {
  const value = row.textarea.value;
  if (row.kind === "item") {
    const line = row.line!;
    if (!currentLines.includes(line)) {
      // 고아(외부 변경으로 소멸) — 임시 행 규칙으로 전환해 처리 (spec §4.6)
      row.kind = "draft";
      row.line = null;
      row.anchor = null;
      itemRows.delete(line);
      return confirmRow(row);
    }
    if (value === line.text) return line; // 무변경 — 기록 생략 (spec §4.3)
    if (value.trim() === "") {
      // 빈 텍스트 확정 = 삭제 취급 (spec §4.3, 사용자 확정)
      itemRows.delete(line);
      row.rootEl.remove();
      applyLines(currentLines.filter((cur) => cur !== line));
      showUndoToast(t("Task deleted"));
      return null;
    }
    const nextItem: TaskItem = { ...line, text: value }; // 미지 필드 보존 (spec §5.2)
    itemRows.delete(line);
    itemRows.set(nextItem, row);
    row.line = nextItem;
    applyLines(currentLines.map((cur) => (cur === line ? nextItem : cur)));
    return nextItem;
  }
  if (row.kind === "ghost") {
    if (value.trim() === "") return null; // 빈 확정 = 미생성 (spec §4.3)
    const nextItem: TaskItem = { text: value };
    row.textarea.value = ""; // 고스트는 비워져 그대로 연속 입력 대기 (spec §4.3)
    resizeTextarea(row.textarea);
    const nextLines = [...currentLines];
    nextLines.splice(listOps.sectionEndIndex(currentLines, row.sectionHeader), 0, nextItem);
    applyLines(nextLines);
    return nextItem;
  }
  // 임시 행 — 확정 시 기준 항목 뒤(사라졌으면 목록 끝, spec §4.6)에 실 항목으로 전환
  if (value.trim() === "") {
    removeDraftRow(row);
    return null;
  }
  const nextItem: TaskItem = { text: value };
  const anchorIndex = row.anchor == null ? -1 : currentLines.indexOf(row.anchor);
  const insertAt = anchorIndex === -1 ? currentLines.length : anchorIndex + 1;
  // 임시 행 노드를 실 항목 행으로 재바인딩 — 포커스 연속 (spec §4.3 연속 입력)
  row.kind = "item";
  row.line = nextItem;
  row.anchor = null;
  itemRows.set(nextItem, row);
  if (draftRow === row) draftRow = null;
  const nextLines = [...currentLines];
  nextLines.splice(insertAt, 0, nextItem);
  applyLines(nextLines);
  return nextItem;
}

function removeDraftRow(row: Row): void {
  row.rootEl.remove();
  if (draftRow === row) draftRow = null;
}

/** Enter = 확정 + 아래 임시 새 행 생성·포커스 (spec §4.3, 사용자 확정). */
function createDraftAfter(anchor: TaskItem): void {
  if (draftRow != null) removeDraftRow(draftRow);
  const row = createRow("draft");
  row.anchor = anchor;
  draftRow = row;
  render();
  row.textarea.focus();
}

// ---------------------------------------------------------------------------
// 키보드 (spec §4.3·§4.4·§4.5, 사용자 확정 키 규약)
// ---------------------------------------------------------------------------

/** Ctrl+Alt+↑/↓ 정확 일치 판정 — 다른 보조키 동시 눌림은 무동작 (spec §4.4). */
function moveKeyDelta(event: KeyboardEvent): -1 | 1 | null {
  if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return null;
  if (event.key === "ArrowUp") return -1;
  if (event.key === "ArrowDown") return 1;
  return null;
}

/**
 * Ctrl+Alt+↑/↓ 한 칸 이동 — 그룹 헤더 줄을 넘으면 소속 변경, 끝이면 무동작 (spec §4.4).
 * 접힌 그룹으로 들어가면 그 그룹을 자동 펼침 — 이동 항목이 시야에서 사라지지 않게
 * (spec §4.4, 사용자 확정. collapsed 해제도 같은 확정 조작으로 함께 저장).
 */
function moveLineBy(item: TaskItem, delta: -1 | 1): void {
  const result = listOps.moveLine(currentLines, item, delta);
  if (result == null) return;
  // 접힌 그룹으로 진입해 자동 펼쳐졌으면 그 섹션 헤더를 DOM 재바인딩 (spec §4.4)
  if (result.expanded != null) {
    const section = groupSections.get(result.expanded.from);
    if (section != null) rebindHeader(result.expanded.from, result.expanded.to, section);
  }
  reorderLines(result.lines);
}

/** 그룹 이름칸 Ctrl+Alt+↑/↓ = 블록 1칸 이동 — 미분류 위 금지·끝 무동작 (spec §4.7, 사용자 확정). */
function moveGroupBy(header: GroupHeader, delta: -1 | 1): void {
  const headers = currentLines.filter((line): line is GroupHeader => isGroupHeader(line));
  const index = headers.indexOf(header);
  const target = headers[index + delta];
  if (target == null) return; // 첫 그룹 위(미분류 위 금지)·마지막 그룹 아래 = 무동작
  moveGroupBlock(header, target, delta === -1);
}

/** 필드별 pristine 판정 레지스트리 — handleHistoryKey 가 활성 필드의 미수정 여부를 묻는다. */
const pristineCheckers = new WeakMap<HTMLElement, () => boolean>();

/**
 * 키바인딩이 호스트를 거쳐 위임한 undo/redo (spec §4.5) — VS Code 가 webview 안 Ctrl+Z/Y 를
 * 선점(기본동작 차단 + 워크벤치 undo 실행)하므로 webview keydown 처리로는 성립 불가.
 * package.json 키바인딩 → historyKey 명령 → 이 분기가 유일한 진입로:
 * 수정 중(dirty) 필드 = 필드 텍스트 undo/redo, 그 외(pristine·필드 밖) = 문서 이력 1단계.
 */
function handleHistoryKey(action: "undo" | "redo"): void {
  const active = document.activeElement;
  const checker = active instanceof HTMLElement ? pristineCheckers.get(active) : undefined;
  if (checker != null && !checker()) {
    // execCommand 는 deprecated 지만 필드 네이티브 undo 스택을 쓰는 유일한 수단 (대체 API 부재)
    document.execCommand(action);
    return;
  }
  vscodeApi.postMessage({ type: "history", action });
}

function wireRowKeys(row: Row): void {
  row.textarea.addEventListener("keydown", (event) => {
    // Enter = 확정 + 아래 임시 새 행 / Shift·Ctrl·Alt+Enter = 줄바꿈 (사용자 확정)
    if (event.key === "Enter" && !event.isComposing) {
      if (event.shiftKey) return; // 브라우저 기본 = 줄바꿈
      event.preventDefault();
      if (event.ctrlKey || event.altKey) {
        // Ctrl/Alt+Enter 는 기본이 줄바꿈이 아니므로 직접 삽입
        row.textarea.setRangeText(
          "\n",
          row.textarea.selectionStart,
          row.textarea.selectionEnd,
          "end",
        );
        resizeTextarea(row.textarea);
        return;
      }
      const confirmed = confirmRow(row);
      if (row.kind === "ghost") return; // 고스트: 비워진 그 칸에서 연속 입력 (spec §4.3)
      if (confirmed != null) createDraftAfter(confirmed);
      return;
    }
    // Esc = 마지막 저장값 복원, 파일 무기록 (사용자 확정)
    if (event.key === "Escape") {
      if (event.isComposing) return; // 조합 중 Esc 는 IME 조합 취소에 위임 (리뷰)
      event.preventDefault();
      if (row.kind === "item") {
        row.textarea.value = row.line!.text;
        resizeTextarea(row.textarea);
      } else if (row.kind === "ghost") {
        row.textarea.value = "";
        resizeTextarea(row.textarea);
      } else {
        removeDraftRow(row);
      }
      return;
    }
    // Ctrl+Alt+↑/↓ = 수정 확정 후 그 행 이동, 포커스·캐럿 유지 (spec §4.4)
    const delta = moveKeyDelta(event);
    if (delta != null) {
      event.preventDefault();
      if (row.kind === "ghost") return; // 고스트엔 이동할 항목이 없음 — 무동작 (리뷰)
      const confirmed = confirmRow(row);
      if (confirmed != null && row.kind === "item") moveLineBy(confirmed, delta);
      return;
    }
    // Ctrl+Z/Y 는 여기 안 온다 — VS Code 선점 + 키바인딩 위임 (handleHistoryKey 참조)
  });
}

// ---------------------------------------------------------------------------
// 드래그 (spec §4.4·§4.7) — 핸들만 드래그 시작점, 여백 드롭 = 취소
// ---------------------------------------------------------------------------

let draggedItem: TaskItem | null = null;
let draggedGroup: GroupHeader | null = null;

function clearDropIndicators(): void {
  for (const el of rootEl.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
    el.classList.remove("drop-before", "drop-after", "drop-into");
  }
}

function wireItemDrag(row: Row, handleEl: HTMLElement): void {
  handleEl.draggable = true;
  handleEl.addEventListener("dragstart", (event) => {
    if (row.kind !== "item") return;
    draggedItem = row.line;
    event.dataTransfer?.setData("text/plain", row.line!.text);
    row.rootEl.classList.add("dragging");
  });
  handleEl.addEventListener("dragend", () => {
    draggedItem = null;
    row.rootEl.classList.remove("dragging");
    clearDropIndicators();
  });
  row.rootEl.addEventListener("dragover", (event) => {
    if (draggedItem == null || draggedItem === row.line) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = row.rootEl.getBoundingClientRect();
    const isBefore = event.clientY < rect.top + rect.height / 2;
    row.rootEl.classList.toggle("drop-before", isBefore);
    row.rootEl.classList.toggle("drop-after", !isBefore);
  });
  row.rootEl.addEventListener("dragleave", () => {
    row.rootEl.classList.remove("drop-before", "drop-after");
  });
  // 드롭 위치에 항목이 끼어들고 나머지가 밀림 — 그룹 경계를 넘으면 소속 변경 (spec §4.4)
  row.rootEl.addEventListener("drop", (event) => {
    const dropped = draggedItem;
    const target = row.line;
    if (dropped == null || target == null || dropped === target) return;
    event.preventDefault();
    event.stopPropagation();
    clearDropIndicators();
    const rect = row.rootEl.getBoundingClientRect();
    const isBefore = event.clientY < rect.top + rect.height / 2;
    const nextLines = currentLines.filter((cur) => cur !== dropped);
    nextLines.splice(nextLines.indexOf(target) + (isBefore ? 0 : 1), 0, dropped);
    reorderLines(nextLines);
  });
}

// ---------------------------------------------------------------------------
// 행 생성 — 노드는 생성 후 재사용 (행 단위 재조정, spec §8)
// ---------------------------------------------------------------------------

function createRow(kind: Row["kind"]): Row {
  const rootLi = document.createElement("li");
  const textarea = document.createElement("textarea");
  textarea.className = "task-input";
  textarea.rows = 1;
  textarea.addEventListener("input", () => {
    resizeTextarea(textarea);
  });

  const row: Row = {
    kind,
    line: null,
    sectionHeader: null,
    anchor: null,
    rootEl: rootLi,
    textarea,
  };

  // Ctrl+Z/Y 분기용 pristine 판정 (handleHistoryKey)
  pristineCheckers.set(textarea, () => isPristine(row));

  textarea.title = t("Enter to save, Shift+Enter for new line");
  // 임시 행(draft)도 항목 행과 같은 DOM — Enter 확정 시 kind 만 item 으로 바뀌므로,
  // 여기서 항목 구조(체크·핸들·task-item 클래스)를 갖춰야 확정 후 실 항목으로 즉시 보임.
  // (ghost 로 만들면 확정해도 "Add a task…" 고스트로 남아 새 항목이 안 뜬다.)
  if (kind === "item" || kind === "draft") {
    rootLi.className = "task-item";
    textarea.setAttribute("aria-label", t("Task")); // 항목값(text)과 별도로 필드 정체를 SR 에 (리뷰)
    const handleEl = document.createElement("span");
    handleEl.className = "task-handle";
    handleEl.title = t("Drag to reorder (Ctrl+Alt+↑/↓)");
    handleEl.appendChild(createIcon("gripper"));
    // 앞쪽 지우개 = 완료 = 삭제 (spec §4.3, 사용자 확정 — "완료=삭제" 철학의 UI 표현).
    // 확인 대화 없음, undo 가 안전망. 그룹 삭제(휴지통)와 파급 범위가 달라 아이콘을 분리.
    const eraseEl = document.createElement("button");
    eraseEl.className = "task-erase";
    eraseEl.title = t("Delete task (Ctrl+Z to undo)");
    eraseEl.setAttribute("aria-label", t("Delete task (Ctrl+Z to undo)"));
    eraseEl.appendChild(createIcon("eraser"));
    eraseEl.addEventListener("click", () => {
      // 미확정 임시 행의 체크 = 그 행 폐기 (파일 미기록이라 삭제할 항목이 없음)
      if (row.kind === "draft") {
        removeDraftRow(row);
        return;
      }
      const line = row.line;
      if (line == null || !currentLines.includes(line)) return;
      // 삭제 후 인접 행으로 포커스 이동 — 키보드 연속 조작 유지 (리뷰)
      const focusTarget = row.rootEl.nextElementSibling ?? row.rootEl.previousElementSibling;
      itemRows.delete(line);
      row.rootEl.remove();
      applyLines(currentLines.filter((cur) => cur !== line));
      showUndoToast(t("Task deleted"));
      focusTarget
        ?.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea, input")
        ?.focus();
    });
    rootLi.append(handleEl, eraseEl, textarea);
    wireItemDrag(row, handleEl);
  } else {
    rootLi.className = "task-ghost";
    textarea.placeholder = t("Add a task…");
    textarea.setAttribute("aria-label", t("Add a task…")); // placeholder 는 안정적 이름이 아님 (리뷰)
    rootLi.appendChild(textarea);
    // 고스트 행 = 항목 드롭 대상 — 그 섹션 끝 삽입 (spec §4.4, 사용자 확정: 빈 미분류 진입로)
    rootLi.addEventListener("dragover", (event) => {
      if (draggedItem == null || row.kind !== "ghost") return;
      event.preventDefault();
      event.stopPropagation();
      rootLi.classList.add("drop-into");
    });
    rootLi.addEventListener("dragleave", () => {
      rootLi.classList.remove("drop-into");
    });
    rootLi.addEventListener("drop", (event) => {
      const dropped = draggedItem;
      if (dropped == null || row.kind !== "ghost") return;
      event.preventDefault();
      event.stopPropagation();
      clearDropIndicators();
      const nextLines = currentLines.filter((cur) => cur !== dropped);
      nextLines.splice(listOps.sectionEndIndex(nextLines, row.sectionHeader), 0, dropped);
      reorderLines(nextLines);
    });
  }

  wireRowKeys(row);
  onEditableBlur(textarea, () => {
    confirmRow(row);
  });
  return row;
}

function itemRowFor(line: TaskItem): Row {
  let row = itemRows.get(line);
  if (row == null) {
    row = createRow("item");
    row.line = line;
    row.textarea.value = line.text;
    itemRows.set(line, row);
    queueMicrotask(() => {
      resizeTextarea(row!.textarea);
    });
  }
  return row;
}

// ---------------------------------------------------------------------------
// 섹션 — 그룹 헤더(이름 상시 편집) + 항목 목록 + 고스트 새 행 (spec §4.7)
// ---------------------------------------------------------------------------

interface Section {
  header: GroupHeader | null;
  readonly rootEl: HTMLElement;
  readonly listEl: HTMLUListElement;
  readonly ghost: Row;
  nameInput: HTMLTextAreaElement | null;
  toggleEl: HTMLButtonElement | null;
  /** 접힘 시 소속 항목 수 배지 (spec §4.7, 사용자 확정). */
  countEl: HTMLElement | null;
  /** 미분류 라벨 — 그룹이 있을 때만 표시 (spec §4.7, 사용자 확정). */
  labelEl: HTMLElement | null;
}

const groupSections = new Map<GroupHeader, Section>();

/** 그룹 헤더 이름 확정 — 빈/무변경 = 마지막 저장 이름 복원(기록 생략) (spec §4.7). */
function confirmGroupName(section: Section): void {
  const header = section.header;
  const input = section.nameInput!;
  if (header == null || !currentLines.includes(header)) {
    // 고아(외부 변경으로 소멸) — 입력 폐기 (spec §4.7, 사용자 확정)
    return;
  }
  const nextName = input.value;
  if (nextName === header.group) return;
  if (nextName.trim() === "") {
    input.value = header.group; // 빈 이름 = 원래 이름 유지 (사용자 확정)
    resizeTextarea(input);
    return;
  }
  const nextHeader: GroupHeader = { ...header, group: nextName }; // 미지 필드 보존 (spec §5.2)
  rebindHeader(header, nextHeader, section);
  applyLines(currentLines.map((cur) => (cur === header ? nextHeader : cur)));
}

function rebindHeader(oldHeader: GroupHeader, nextHeader: GroupHeader, section: Section): void {
  groupSections.delete(oldHeader);
  groupSections.set(nextHeader, section);
  section.header = nextHeader;
  section.ghost.sectionHeader = nextHeader;
}

/** 접기 토글 — 접힘 = collapsed:true 기록, 펼침 = 필드 제거. undo 대상 (spec §4.7). */
function toggleCollapse(section: Section): void {
  const header = section.header;
  if (header == null || !currentLines.includes(header)) return;
  const nextHeader: GroupHeader = isCollapsed(header)
    ? listOps.expandHeader(header)
    : { ...header, collapsed: true };
  rebindHeader(header, nextHeader, section);
  applyLines(currentLines.map((cur) => (cur === header ? nextHeader : cur)));
}

/** 그룹 블록 통째 이동 — 미분류 위로는 못 끌음 (spec §4.7, 사용자 확정). */
function moveGroupBlock(header: GroupHeader, target: GroupHeader | null, before: boolean): void {
  reorderLines(listOps.moveGroupBlock(currentLines, header, target, before));
}

function createSection(header: GroupHeader | null): Section {
  const sectionEl = document.createElement("section");
  sectionEl.className = "task-group";
  const listEl = document.createElement("ul");
  listEl.className = "task-list";
  const ghost = createRow("ghost");
  ghost.sectionHeader = header;

  const section: Section = {
    header,
    rootEl: sectionEl,
    listEl,
    ghost,
    nameInput: null,
    toggleEl: null,
    countEl: null,
    labelEl: null,
  };

  if (header == null) {
    // 미분류 라벨 — 그룹이 1개 이상일 때만 표시, 비인터랙티브 (spec §4.7, 사용자 확정)
    const labelEl = document.createElement("div");
    labelEl.className = "group-label";
    labelEl.textContent = t("Ungrouped");
    labelEl.hidden = true;
    section.labelEl = labelEl;
    sectionEl.appendChild(labelEl);
  }

  if (header != null) {
    const headerEl = document.createElement("div");
    headerEl.className = "group-header";

    const handleEl = document.createElement("span");
    handleEl.className = "task-handle";
    handleEl.title = t("Drag to reorder group (Ctrl+Alt+↑/↓)");
    handleEl.appendChild(createIcon("gripper"));
    handleEl.draggable = true;
    handleEl.addEventListener("dragstart", (event) => {
      draggedGroup = section.header;
      event.dataTransfer?.setData("text/plain", section.header?.group ?? "");
      headerEl.classList.add("dragging");
    });
    handleEl.addEventListener("dragend", () => {
      draggedGroup = null;
      headerEl.classList.remove("dragging");
      clearDropIndicators();
    });

    const toggleEl = document.createElement("button");
    toggleEl.className = "group-toggle";
    toggleEl.addEventListener("click", () => {
      toggleCollapse(section);
    });
    section.toggleEl = toggleEl;

    // 좁은 폭에서 긴 이름이 잘리지 않게 textarea + 자동 높이 — 항목 행과 동일 패턴 (리뷰).
    // 줄바꿈 "입력"은 계속 불허 — 모든 Enter 변형이 아래 keydown 에서 확정으로 처리돼 기본동작 차단.
    const nameInput = document.createElement("textarea");
    nameInput.rows = 1;
    nameInput.className = "group-name";
    nameInput.addEventListener("input", () => {
      resizeTextarea(nameInput);
    });
    nameInput.setAttribute("aria-label", t("Group name")); // 상시 편집 필드 정체를 SR 에 (리뷰)
    nameInput.title = t("Rename group — Enter to save"); // 편집 가능 발견성 (리뷰)
    section.nameInput = nameInput;
    // 이름 상시 편집 — Enter/blur 확정, Esc 복원, Ctrl+Alt+↑/↓ 블록 이동, pristine Ctrl+Z 위임 (spec §4.7)
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        confirmGroupName(section);
        // 확정 후 그 그룹 첫 항목칸으로 포커스 이동 — 항목칸 연속 입력 흐름과 일관 (리뷰).
        // 접힌 그룹은 고스트가 숨겨져 focus 불가 — 이동 생략 (리뷰).
        if (section.header != null && !isCollapsed(section.header)) {
          section.ghost.textarea.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        if (event.isComposing) return; // 조합 중 Esc 는 IME 조합 취소에 위임 (리뷰)
        event.preventDefault();
        if (section.header != null) {
          nameInput.value = section.header.group;
          resizeTextarea(nameInput);
        }
        return;
      }
      const delta = moveKeyDelta(event);
      if (delta != null) {
        event.preventDefault();
        confirmGroupName(section);
        if (section.header != null) moveGroupBy(section.header, delta);
        return;
      }
    });
    // Ctrl+Z/Y 분기용 pristine 판정 (handleHistoryKey) — 저장된 그룹명과 같으면 미수정
    pristineCheckers.set(
      nameInput,
      () => section.header == null || nameInput.value === section.header.group,
    );
    onEditableBlur(nameInput, () => {
      confirmGroupName(section);
    });

    // 접힘 시 소속 항목 수 배지 (spec §4.7, 사용자 확정 — 안 보이는 삭제 범위 인지)
    const countEl = document.createElement("span");
    countEl.className = "group-count";
    countEl.hidden = true;
    section.countEl = countEl;

    // 그룹 삭제 = 헤더 + 소속 항목 전부, 확인 대화 없음 — undo 안전망 (spec §4.7).
    // hover 시 삭제될 블록 전체 하이라이트 — 파급 범위 사전 시각화 (사용자 확정).
    const trashEl = document.createElement("button");
    trashEl.className = "group-trash";
    trashEl.title = t("Delete group and its tasks (Ctrl+Z to undo)");
    trashEl.setAttribute("aria-label", t("Delete group and its tasks (Ctrl+Z to undo)"));
    trashEl.appendChild(createIcon("trash"));
    trashEl.addEventListener("mouseenter", () => {
      sectionEl.classList.add("delete-hover");
    });
    trashEl.addEventListener("mouseleave", () => {
      sectionEl.classList.remove("delete-hover");
    });
    // 키보드 포커스에서도 삭제 파급 미리보기 — hover 전용 발견성 보완 (리뷰)
    trashEl.addEventListener("focus", () => {
      sectionEl.classList.add("delete-hover");
    });
    trashEl.addEventListener("blur", () => {
      sectionEl.classList.remove("delete-hover");
    });
    trashEl.addEventListener("click", () => {
      const cur = section.header;
      if (cur == null || !currentLines.includes(cur)) return;
      sectionEl.classList.remove("delete-hover");
      // 삭제 후 인접 섹션으로 포커스 이동 (리뷰)
      const focusTarget = sectionEl.nextElementSibling ?? sectionEl.previousElementSibling;
      const [start, end] = listOps.groupBlockRange(currentLines, cur);
      applyLines([...currentLines.slice(0, start), ...currentLines.slice(end)]);
      showUndoToast(t("Group deleted"));
      focusTarget
        ?.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea, input")
        ?.focus();
    });

    // 헤더 위 항목 드롭 = 접힘·펼침 불문 그 그룹 끝 삽입 — 빈·접힌 그룹의 진입로 (spec §4.4)
    headerEl.addEventListener("dragover", (event) => {
      if (draggedItem == null) return;
      event.preventDefault();
      event.stopPropagation();
      headerEl.classList.add("drop-into");
    });
    headerEl.addEventListener("dragleave", () => {
      headerEl.classList.remove("drop-into");
    });
    headerEl.addEventListener("drop", (event) => {
      const dropped = draggedItem;
      const cur = section.header;
      if (dropped == null || cur == null) return;
      event.preventDefault();
      event.stopPropagation();
      clearDropIndicators();
      const nextLines = currentLines.filter((line) => line !== dropped);
      nextLines.splice(listOps.sectionEndIndex(nextLines, cur), 0, dropped);
      reorderLines(nextLines);
    });

    // 평시: ⠿ ▸ (배지) 🗑 이름 — trash 상시 표시 (우측 정렬 요소 없음, 사용자 확정)
    headerEl.append(handleEl, toggleEl, countEl, trashEl, nameInput);
    sectionEl.appendChild(headerEl);
  }

  sectionEl.appendChild(listEl);

  // 그룹 드래그의 섹션 드롭 대상 — 미분류는 "뒤"만 허용 (spec §4.7)
  sectionEl.addEventListener("dragover", (event) => {
    if (draggedGroup == null || draggedGroup === section.header) return;
    event.preventDefault();
    const rect = sectionEl.getBoundingClientRect();
    const isBefore = section.header != null && event.clientY < rect.top + rect.height / 2;
    sectionEl.classList.toggle("drop-before", isBefore);
    sectionEl.classList.toggle("drop-after", !isBefore);
  });
  sectionEl.addEventListener("dragleave", () => {
    sectionEl.classList.remove("drop-before", "drop-after");
  });
  sectionEl.addEventListener("drop", (event) => {
    const dropped = draggedGroup;
    if (dropped == null || dropped === section.header) return;
    event.preventDefault();
    clearDropIndicators();
    const rect = sectionEl.getBoundingClientRect();
    const isBefore = section.header != null && event.clientY < rect.top + rect.height / 2;
    moveGroupBlock(dropped, section.header, isBefore);
  });

  return section;
}

/** 미분류 섹션 — 싱글턴 (spec §4.7 최상단 고정). */
const miscSection = createSection(null);

// ---------------------------------------------------------------------------
// 그룹 추가 (spec §4.7 생성) — 목록 끝 상시 입력칸 (항목 고스트 행과 같은 방식, 사용자 확정)
// ---------------------------------------------------------------------------

const addGroupEl = document.createElement("div");
const addGroupInput = document.createElement("input");
addGroupInput.type = "text";
addGroupInput.className = "group-new";
addGroupInput.placeholder = t("Add group…");
addGroupInput.setAttribute("aria-label", t("Add group…")); // placeholder 안정적 이름 보강 (리뷰)
addGroupEl.append(addGroupInput);
rootEl.appendChild(addGroupEl);

/** 그룹 생성 확정 — 목록 끝에 빈 그룹, 빈 이름 = 미생성 (spec §4.7, 사용자 확정). */
function confirmAddGroup(): void {
  const nextName = addGroupInput.value;
  addGroupInput.value = ""; // 확정 후 비워져 그대로 연속 입력 대기 (항목 고스트와 동일)
  if (nextName.trim() === "") return;
  applyLines([...currentLines, { group: nextName }]);
}

addGroupInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    confirmAddGroup();
  } else if (event.key === "Escape") {
    if (event.isComposing) return; // 조합 중 Esc 는 IME 조합 취소에 위임
    event.preventDefault();
    addGroupInput.value = "";
  }
});
onEditableBlur(addGroupInput, confirmAddGroup);
// Ctrl+Z/Y 분기용 pristine 판정 (handleHistoryKey) — 비어 있으면 미수정
pristineCheckers.set(addGroupInput, () => addGroupInput.value === "");

// ---------------------------------------------------------------------------
// 렌더 — 행 단위 재조정 (spec §8): 노드 재사용, 순서만 동기화, 포커스 노드 보존
// ---------------------------------------------------------------------------

/** 자식 순서 동기화 — 제자리 노드는 건드리지 않음(포커스 보존), 밖의 노드는 제거. */
function syncChildren(parent: Element, desired: readonly Element[]): void {
  const desiredSet = new Set(desired);
  // oxlint-disable-next-line no-useless-spread -- children 은 live collection — 제거 중 순회는 스냅샷 필수
  for (const child of [...parent.children]) {
    if (!desiredSet.has(child)) child.remove();
  }
  let cursor = parent.firstElementChild;
  for (const el of desired) {
    if (cursor === el) {
      cursor = el.nextElementSibling;
      continue;
    }
    parent.insertBefore(el, cursor);
  }
}

function render(): void {
  withFocusPreserved(() => {
    // 빈 상태 안내 — 항목·그룹이 하나도 없을 때만 (첫 진입 발견성, 리뷰)
    emptyHintEl.hidden = currentLines.length > 0;
    const layout = listOps.computeLayout(currentLines);
    const desiredSections: Element[] = [];
    const usedHeaders = new Set<GroupHeader>();

    for (const part of layout) {
      let section: Section;
      if (part.header == null) {
        section = miscSection;
      } else {
        section = groupSections.get(part.header) ?? createSection(part.header);
        groupSections.set(part.header, section);
        section.header = part.header;
        section.ghost.sectionHeader = part.header;
        usedHeaders.add(part.header);
      }

      // 접힘→펼침 전환 감지용 직전 상태 — 펼쳐지는 순간 항목 높이 재측정에 사용 (리뷰)
      const wasCollapsed = section.rootEl.classList.contains("collapsed");

      // 헤더 표시 갱신 — 이름은 포커스 중(수정 보호)이 아니면 저장값으로 동기화 (spec §4.6)
      if (section.nameInput != null && part.header != null) {
        if (document.activeElement !== section.nameInput) {
          const nameInput = section.nameInput;
          nameInput.value = part.header.group;
          // 새 섹션은 아직 미부착(scrollHeight 0) — 부착 후 재측정 (itemRowFor 와 동일 패턴)
          queueMicrotask(() => {
            resizeTextarea(nameInput);
          });
        }
        const collapsed = isCollapsed(part.header);
        section.rootEl.classList.toggle("collapsed", collapsed);
        section.toggleEl!.replaceChildren(createIcon(collapsed ? "chevron-right" : "chevron-down"));
        section.toggleEl!.title = collapsed ? t("Expand") : t("Collapse");
        section.toggleEl!.setAttribute("aria-label", collapsed ? t("Expand") : t("Collapse"));
        section.toggleEl!.setAttribute("aria-expanded", String(!collapsed));
        // 접힘 시 항목 수 배지 — 안 보이는 삭제 범위·빈 그룹 구분 (spec §4.7)
        section.countEl!.textContent = String(part.items.length);
        section.countEl!.setAttribute("aria-label", t("{0} tasks", part.items.length)); // 배지 숫자 맥락 (리뷰)
        section.countEl!.hidden = !collapsed;
      }
      // 미분류 라벨 — 그룹이 1개 이상일 때만 (spec §4.7)
      if (section.labelEl != null) {
        section.labelEl.hidden = layout.length <= 1;
      }

      // 행 구성: 항목들 + (임시 행: 기준 항목 뒤) + 고스트
      const desiredRows: Element[] = [];
      for (const item of part.items) {
        desiredRows.push(itemRowFor(item).rootEl);
        if (draftRow != null && draftRow.anchor === item) desiredRows.push(draftRow.rootEl);
      }
      desiredRows.push(section.ghost.rootEl);
      syncChildren(section.listEl, desiredRows);

      // 접힘 중 숨겨져(display:none → scrollHeight 0) 높이가 굳은 항목을, 펼쳐지는 순간
      // 내용 높이로 다시 맞춤 — 여러 줄 항목이 1줄로 잘려 보이는 것 방지 (리뷰).
      if (part.header != null && wasCollapsed && !isCollapsed(part.header)) {
        for (const item of part.items) {
          const row = itemRows.get(item);
          if (row != null) resizeTextarea(row.textarea);
        }
      }

      desiredSections.push(section.rootEl);
    }

    // 사라진 그룹 섹션 제거 — 고스트 입력 상태도 함께 폐기 (spec §4.7, 사용자 확정)
    for (const [header, section] of groupSections) {
      if (!usedHeaders.has(header)) {
        groupSections.delete(header);
        section.rootEl.remove();
      }
    }
    // 사라진 항목 행 제거 (고아 전환은 문서 수신부에서 선처리)
    const liveLines = new Set<TaskLine>(currentLines);
    for (const [line, row] of itemRows) {
      if (!liveLines.has(line)) {
        itemRows.delete(line);
        row.rootEl.remove();
      }
    }
    // 기준 항목이 사라진 임시 행 — 미분류 끝으로 이동하지 않고 그대로 유지(확정 시 목록 끝, spec §4.6).
    // 단 DOM 에서 떨어졌으면(소속 섹션 제거) 미분류 목록 끝에 다시 붙임.
    if (draftRow != null && !draftRow.rootEl.isConnected) {
      miscSection.listEl.insertBefore(draftRow.rootEl, miscSection.ghost.rootEl);
    }

    syncChildren(sectionsEl, desiredSections);
  });
}

// ---------------------------------------------------------------------------
// 파싱 오류 화면 (spec §4.2·§3.2) — 목록은 숨김 보존(입력 중 값 유지, spec §4.6)
// ---------------------------------------------------------------------------

function renderParseError(message: string): void {
  errorEl.replaceChildren();
  const titleEl = document.createElement("p");
  // 파서 원인 메시지 병기 — "line N: invalid JSON" 등 (spec §4.2, 사용자 확정)
  titleEl.textContent = t("Cannot edit this file: {0}", message);
  const hintEl = document.createElement("p");
  hintEl.textContent = t("Fix the broken line in the text editor, then reopen this file.");
  const openEl = document.createElement("button");
  openEl.className = "open-as-text";
  openEl.textContent = t("Open as Text");
  openEl.addEventListener("click", () => {
    vscodeApi.postMessage({ type: "openAsText" });
  });
  errorEl.append(titleEl, hintEl, openEl);
  hideUndoToast();
  emptyHintEl.hidden = true;
  errorEl.hidden = false;
  sectionsEl.hidden = true;
  addGroupEl.hidden = true;
  openEl.focus(); // 오류 화면의 유일 조작으로 포커스 이동 — 숨김 처리로 인한 포커스 유실 방지 (리뷰)
}

function hideParseError(): void {
  errorEl.hidden = true;
  sectionsEl.hidden = false;
  addGroupEl.hidden = false;
}

// ---------------------------------------------------------------------------
// 문서 수신 (spec §4.6) — 외부 변경·undo 를 행 단위 재조정으로 즉시 반영
// ---------------------------------------------------------------------------

/**
 * 새 파싱 결과에 기존 행·섹션을 재바인딩 — ID 없는 줄의 재식별 (spec §4.6·§8):
 * 항목 = 마지막 저장 텍스트 매칭(중복 첫 번째), 헤더 = 이름 매칭.
 * 편집 중(포커스) 행의 입력값은 덮어쓰지 않고, 소멸한 편집 중 행은 임시 행으로 전환.
 */
function adoptExternalLines(newLines: TaskLine[]): void {
  const newItems = newLines.filter((line): line is TaskItem => !isGroupHeader(line));
  const newHeaders = newLines.filter((line): line is GroupHeader => isGroupHeader(line));
  const usedItems = new Set<TaskItem>();
  const usedHeaders = new Set<GroupHeader>();

  // 항목 행 재바인딩 — 마지막 저장 텍스트 기준
  // oxlint-disable-next-line no-useless-spread -- 순회 중 delete/set 병행 — 스냅샷 필수
  for (const [oldLine, row] of [...itemRows]) {
    const match = newItems.find((cand) => !usedItems.has(cand) && cand.text === oldLine.text);
    if (match != null) {
      usedItems.add(match);
      itemRows.delete(oldLine);
      itemRows.set(match, row);
      row.line = match;
      if (document.activeElement !== row.textarea) {
        row.textarea.value = match.text;
        resizeTextarea(row.textarea);
      }
      continue;
    }
    // 소멸 — 편집 중(포커스 + 미확정 변경)이면 임시 행으로 유지, 아니면 제거 (spec §4.6)
    itemRows.delete(oldLine);
    if (document.activeElement === row.textarea && row.textarea.value !== oldLine.text) {
      row.kind = "draft";
      row.line = null;
      row.anchor = null;
      if (draftRow != null && draftRow !== row) removeDraftRow(draftRow);
      draftRow = row;
    } else {
      row.rootEl.remove();
    }
  }

  // 그룹 섹션 재바인딩 — 마지막 저장 이름 기준
  // oxlint-disable-next-line no-useless-spread -- 순회 중 delete/set 병행 — 스냅샷 필수
  for (const [oldHeader, section] of [...groupSections]) {
    const match = newHeaders.find(
      (cand) => !usedHeaders.has(cand) && cand.group === oldHeader.group,
    );
    if (match != null) {
      usedHeaders.add(match);
      rebindHeader(oldHeader, match, section);
    }
    // 미매칭 섹션은 render 의 prune 이 제거 — 이름 입력 중 값은 폐기 (spec §4.7)
  }

  currentLines = newLines;
  render();
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  if (event.data.type === "config") {
    // editor.lineHeight 반영 — VS Code 가 CSS 변수로 안 주는 설정을 호스트가 환산해 전달 (spec §4.2)
    document.body.style.lineHeight = event.data.lineHeight;
    return;
  }
  if (event.data.type === "historyKey") {
    handleHistoryKey(event.data.action);
    return;
  }
  if (event.data.type !== "doc") return;
  const result = parseTasksFile(event.data.text);
  if (!result.ok) {
    // 파싱 오류 — 편집 차단 + 오류 안내, 목록 DOM 은 숨김 보존 (spec §3.2·§4.6)
    renderParseError(result.message);
    return;
  }
  hideParseError();
  adoptExternalLines(result.lines);
});

// 패널 폭이 바뀌면 줄바꿈 수가 달라지므로 모든 입력칸 높이를 다시 맞춤 —
// 안 하면 폭을 줄였을 때 여러 줄 항목이 이전 높이에 잘려 보인다.
let lastViewportWidth = window.innerWidth;
window.addEventListener("resize", () => {
  if (window.innerWidth === lastViewportWidth) return; // 세로만 변한 경우 재측정 불필요
  lastViewportWidth = window.innerWidth;
  for (const textarea of rootEl.querySelectorAll("textarea")) {
    resizeTextarea(textarea);
  }
});

vscodeApi.postMessage({ type: "ready" });
