// 슬라이스 4 시연 — 폴더 Show History → 다중 파일 diff(vscode.changes) → 폴더 롤백(삭제 파일 복원).
// 스냅샷 기록 완료 대기는 globalStorage 의 스냅샷 파일 수로 판정한다 (UI 는 대상 파일 시점만 보여줘서).
import path from "node:path";
import fs from "node:fs";
import type { Page } from "@playwright/test";
import { expect, launchVsCode, retryAction, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import {
  countSnapshots,
  historyPaneOf,
  prepareRecording,
  showHistoryViaContextMenu,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const folderName = "local-history-folder";

const dialog = (workbox: Page) => workbox.locator(".monaco-dialog-box");

test("폴더 시점의 다중 파일 diff 를 열고, 폴더 롤백으로 삭제 파일까지 복원한다", async ({
  vscodeExePath,
}, testInfo) => {
  const folderPath = path.join(workspaceDir, folderName);
  const aPath = path.join(folderPath, "a.txt");
  const bPath = path.join(folderPath, "b.txt");
  fs.rmSync(folderPath, { recursive: true, force: true });
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(aPath, "initial\n");
  const userDataDir = testInfo.outputPath("user-data");
  const app = await launchVsCode(
    vscodeExePath,
    { extensionsDir: testInfo.outputPath("extensions"), userDataDir },
    { settings: { "window.dialogStyle": "custom" } },
  );
  try {
    const workbox = await app.firstWindow();

    // 폴더 펼침 → a.txt 로 활성화·웜업 (계획 공통 전제)
    const folderItem = workbox.getByRole("treeitem", { name: folderName });
    await folderItem.waitFor({ state: "visible", timeout: 30_000 });
    await folderItem.click();
    await prepareRecording(workbox, "a.txt", aPath);
    const recorded = () => countSnapshots(userDataDir);
    const base = recorded();

    // 변경 3건 — b 생성 → a 수정 → b 삭제, 각각 별도 시점으로 기록 대기
    fs.writeFileSync(bPath, "b content\n");
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 1);
    fs.writeFileSync(aPath, "a second\n");
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 2);
    fs.rmSync(bPath);
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 3);

    // 폴더 Show History → "a 수정" 시점(두 번째 항목) 선택 → 다중 파일 diff (b.txt 삭제분 표시)
    await showHistoryViaContextMenu(workbox, folderItem, folderName);
    const historyPane = historyPaneOf(workbox);
    const targetItem = historyPane.getByRole("treeitem").nth(1);
    await retryAction(
      async () => {
        await targetItem.click();
      },
      async () => {
        await expect(
          workbox.getByRole("tab", { name: new RegExp(`${folderName}.*Current`) }),
        ).toBeVisible({ timeout: 5_000 });
        await expect(workbox.locator(".editor-instance").getByText("b.txt").first()).toBeVisible({
          timeout: 5_000,
        });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "folder-changes.png") });

    // 시점 하위 변경 파일 목록 확인 후 폴더 롤백 → b.txt 복원, a.txt 는 그 시점 내용 유지
    await retryAction(
      async () => {
        if (!(await dialog(workbox).isVisible())) {
          await targetItem.hover();
          await targetItem.getByRole("button", { name: "Rollback to This State" }).click();
        }
      },
      async () => {
        await expect(dialog(workbox)).toContainText(`Rollback folder "${folderName}"`, {
          timeout: 3_000,
        });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "folder-rollback-dialog.png") });
    await dialog(workbox).getByRole("button", { name: "Rollback" }).click();
    await expect(dialog(workbox)).toHaveCount(0);

    await expect.poll(() => fs.existsSync(bPath), { timeout: 15_000 }).toBe(true);
    expect(fs.readFileSync(bPath, "utf8")).toBe("b content\n");
    expect(fs.readFileSync(aPath, "utf8")).toBe("a second\n");
    await workbox.screenshot({ path: path.join(shotDir, "folder-rolled-back.png") });
  } finally {
    await app.close();
    fs.rmSync(folderPath, { recursive: true, force: true });
  }
});
