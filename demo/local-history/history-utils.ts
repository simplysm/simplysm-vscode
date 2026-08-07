// local-history demo 공용 헬퍼 — 워처 웜업 게이트·Show History 조작 (계획 공통 전제 참조)
import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, retryAction, runCommand } from "../fixtures.ts";

/** globalStorage 에 기록된 스냅샷 파일 수 — 워크스페이스 디렉터리는 해시명이라 열거로 찾는다. */
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
    const snapshotsDir = path.join(storageRoot, workspaceId, "snapshots");
    if (fs.existsSync(snapshotsDir)) {
      count += fs.readdirSync(snapshotsDir).filter((name) => name.endsWith(".json")).length;
    }
  }
  return count;
}

/** Local History 시점 목록 pane. */
export function historyPaneOf(workbox: Page): Locator {
  return workbox.locator(".pane").filter({
    has: workbox.locator(".pane-header", { hasText: "Local History" }),
  });
}

/** 우클릭 → Show History — 창 무포커스 시 메뉴 클릭이 간헐 유실되므로 결과 확인 후 재시도. */
export async function showHistoryViaContextMenu(
  workbox: Page,
  item: Locator,
  expectedFileName: string,
): Promise<void> {
  const menuItem = workbox.getByRole("menuitem", { name: "Show History" });
  const description = historyPaneOf(workbox).locator(".pane-header .description");
  await retryAction(
    async () => {
      if (!(await menuItem.isVisible())) {
        await item.click({ button: "right" });
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
  await workbox.waitForTimeout(2_000); // 웜업 변경의 debounce 플러시 대기
  const baseline = await historyPane.getByRole("treeitem").count();
  expect(baseline).toBeGreaterThanOrEqual(1); // 웜업 변경이 기록됐어야 함
  return baseline;
}
