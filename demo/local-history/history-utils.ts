// local-history demo 공용 헬퍼 — 워처 웜업 게이트·Show History 조작 (계획 공통 전제 참조)
import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, retryAction, runCommand } from "../fixtures.ts";

/**
 * globalStorage 에 기록된 스냅샷 수 = 스냅샷 로그(snapshots.jsonl)의 완결된 줄 수.
 * 워크스페이스 디렉터리는 해시명이라 열거로 찾는다.
 */
export function countSnapshots(userDataDir: string): number {
  const storageRoot = path.join(
    userDataDir,
    "User",
    "globalStorage",
    "simplysm.simplysm-local-history",
  );
  if (!fs.existsSync(storageRoot)) return 0;
  let count = 0;
  for (const workspaceId of fs.readdirSync(storageRoot)) {
    const logPath = path.join(storageRoot, workspaceId, "snapshots.jsonl");
    if (fs.existsSync(logPath)) {
      count += fs.readFileSync(logPath, "utf8").split("\n").length - 1; // 줄바꿈 수 — 끝의 반쪽 줄은 세지 않는다
    }
  }
  return count;
}

/** 이력 저장소 디렉터리 — 시연 user-data 에는 워크스페이스 하나뿐이다. */
export function storeDirOf(userDataDir: string): string {
  const storageRoot = path.join(
    userDataDir,
    "User",
    "globalStorage",
    "simplysm.simplysm-local-history",
  );
  return path.join(storageRoot, fs.readdirSync(storageRoot)[0]);
}

/** 표시 언어를 타는 문구 — 기본은 영어. */
export interface HistoryLabels {
  readonly menu: string;
  readonly pane: string;
}

const englishLabels: HistoryLabels = { menu: "Show History", pane: "Local History" };

/** Local History 변경 목록 pane. */
export function historyPaneOf(workbox: Page, labels: HistoryLabels = englishLabels): Locator {
  return workbox.locator(".pane").filter({
    has: workbox.locator(".pane-header", { hasText: labels.pane }),
  });
}

/**
 * 변경 목록의 줄(맨 위 = 1) — 줄 아래 항목을 펼치면 treeitem 순서가 밀리므로 위치(aria-posinset)로 짚는다.
 */
export function historyRowAt(pane: Locator, position: number): Locator {
  return pane.locator(`.monaco-list-row[aria-level='1'][aria-posinset='${position}']`);
}

/** 변경 목록에서 고른 노드(줄 · 항목). */
export function selectedNodesOf(pane: Locator): Locator {
  return pane.locator(".monaco-list-row[aria-selected='true']");
}

/** 키보드 포커스가 변경 목록 안에 있는가 — ↑↓ 탐색이 목록으로 가는가. */
export async function historyListFocused(workbox: Page): Promise<boolean> {
  return await historyPaneOf(workbox).evaluate((pane) => pane.contains(document.activeElement));
}

/** 활성 에디터 탭. */
export function activeTabOf(workbox: Page): Locator {
  return workbox.locator(".tab.active");
}

/**
 * 내장 diff(파일 하나)의 좌(직전) · 우(직후) 본문 — view-zone(반대편 삭제 표시줄)도 .view-lines 클래스를
 * 가지므로 실제 본문 컨테이너만 고른다.
 */
export function diffSidesOf(workbox: Page): { original: Locator; modified: Locator } {
  const side = (name: string) =>
    workbox.locator(`.monaco-diff-editor .editor.${name} .view-lines:not([monaco-view-zone])`);
  return { original: side("original"), modified: side("modified") };
}

/** 글자 그대로 전체가 같은지 보는 정규식. */
function exactText(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`);
}

/**
 * 다중 파일 diff(`vscode.changes`)의 항목 이름(직후 쪽 라벨) — 화면 순서.
 * 에디터는 지난 비교의 항목 요소를 숨긴 채 DOM 에 남기므로 보이는 항목만 고른다.
 */
export function multiDiffNamesOf(workbox: Page): Locator {
  return workbox.locator(".multiDiffEditor .multiDiffEntry:visible .title.modified .label-name");
}

/** 다중 파일 diff 의 항목 하나(직후 쪽 라벨 = `name`)의 좌(직전) · 우(직후) 본문. */
export function multiDiffSidesOf(
  workbox: Page,
  name: string,
): { original: Locator; modified: Locator } {
  const entry = workbox.locator(".multiDiffEditor .multiDiffEntry:visible").filter({
    has: workbox.locator(".title.modified .label-name", { hasText: exactText(name) }),
  });
  const side = (sideName: string) =>
    entry.locator(`.editor.${sideName} .view-lines:not([monaco-view-zone])`);
  return { original: side("original"), modified: side("modified") };
}

/** 우클릭 → Show History — 창 무포커스 시 메뉴 클릭이 간헐 유실되므로 결과 확인 후 재시도. */
export async function showHistoryViaContextMenu(
  workbox: Page,
  item: Locator,
  expectedFileName: string,
  labels: HistoryLabels = englishLabels,
): Promise<void> {
  const menuItem = workbox.getByRole("menuitem", { name: labels.menu });
  const openMenu = workbox.locator(".context-view.monaco-menu-container");
  const description = historyPaneOf(workbox, labels).locator(".pane-header .description");
  await retryAction(
    async () => {
      if (!(await menuItem.isVisible())) {
        // 대상 항목이 없는 메뉴가 열려 있으면 닫는다. 기동 직후 확장의 메뉴 기여가 등록되기 전에 우클릭하면
        // Show History 가 없는 탐색기 메뉴가 열리고(실측), 그 메뉴의 막(context-view-block)이 다음 우클릭을 가로채
        // 닫지 않으면 재시도가 모두 막힌다.
        if (await openMenu.isVisible()) {
          await workbox.keyboard.press("Escape");
          await openMenu.waitFor({ state: "hidden", timeout: 2_000 });
        }
        await item.click({ button: "right", timeout: 5_000 });
        await menuItem.waitFor({ state: "visible", timeout: 5_000 });
      }
      await menuItem.click();
    },
    async () => {
      await expect(menuItem).toBeHidden({ timeout: 3_000 });
      await expect(description).toContainText(expectedFileName, { timeout: 3_000 });
    },
  );
}

/**
 * 기록 시나리오 공통 준비 — 파일을 에디터로 열고(내용 "initial" 전제), 팔레트 Show History 로
 * 확장 활성화를 확인한 뒤, 워처 웜업 게이트(외부 쓰기 → 에디터 자동 리로드 확인)를 통과한다.
 * 반환 = 웜업 직후 시점 개수(baseline) — 이후 수정 횟수만큼 증가를 단언할 것.
 */
export async function prepareRecording(
  workbox: Page,
  fileName: string,
  filePath: string,
): Promise<number> {
  const treeItem = workbox.getByRole("treeitem", { name: fileName });
  await treeItem.waitFor({ state: "visible", timeout: 30_000 });
  await treeItem.click();
  const editor = workbox.locator(".editor-instance .view-lines");
  await expect(editor).toContainText("initial", { timeout: 30_000 });

  await runCommand(workbox, "Simplysm Local History: Show History");
  const historyPane = historyPaneOf(workbox);
  // 기동 스캔(슬라이스 6)이 최초 1회 전체 파일을 기록하므로 시점 0개를 가정하지 않는다
  await historyPane.waitFor({ state: "visible", timeout: 15_000 });

  // 워처 웜업 — VS Code 파일 워처 기동이 세션에 따라 지연됨(플랫폼 한계, spec 보장 수준)
  let warmedUp = false;
  for (let attempt = 0; attempt < 45 && !warmedUp; attempt++) {
    fs.writeFileSync(filePath, `warmup ${attempt}\n`);
    try {
      await expect(editor).toContainText(`warmup ${attempt}`, { timeout: 2_000 });
      warmedUp = true;
    } catch {
      // 아직 워처 미기동 — 새 쓰기로 재시도
    }
  }
  if (!warmedUp) throw new Error("VS Code 파일 워처가 기동되지 않아 시연을 진행할 수 없음");
  // 웜업 변경 기록 대기 — flush(debounce)·트리 렌더가 늦을 수 있어 즉시 count 가 아닌 poll 로 단언
  await expect
    .poll(() => historyPane.getByRole("treeitem").count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  await workbox.waitForTimeout(2_000); // 추가 기록 정착 대기 — 반환값은 안정된 baseline 이어야 함
  return await historyPane.getByRole("treeitem").count();
}
