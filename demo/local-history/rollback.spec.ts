// 슬라이스 3 시연 — 시점 인라인 버튼으로 롤백(확인 다이얼로그) 후, 롤백 자체도 히스토리로 역롤백.
// 네이티브 다이얼로그는 DOM 단언 불가 — 커스텀(DOM) 다이얼로그를 강제해 기동한다.
import path from "node:path";
import fs from "node:fs";
import type { Page } from "@playwright/test";
import { expect, launchVsCode, retryAction, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import { historyPaneOf, prepareRecording } from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-rollback-target.txt";

const dialog = (workbox: Page) => workbox.locator(".monaco-dialog-box");

/** 시점 항목의 인라인 Rollback 버튼 → 확인 다이얼로그 → Rollback — 무포커스 클릭 유실 대비 재시도. */
async function rollbackViaInlineButton(
  workbox: Page,
  itemIndex: number,
  screenshotPath?: string,
): Promise<void> {
  const item = historyPaneOf(workbox).getByRole("treeitem").nth(itemIndex);
  await retryAction(
    async () => {
      if (!(await dialog(workbox).isVisible())) {
        await item.hover();
        await item.getByRole("button", { name: "Rollback to This State" }).click();
      }
    },
    async () => {
      await expect(dialog(workbox)).toContainText("Rollback", { timeout: 3_000 });
    },
  );
  if (screenshotPath !== undefined) {
    await workbox.screenshot({ path: screenshotPath });
  }
  await dialog(workbox).getByRole("button", { name: "Rollback" }).click();
  await expect(dialog(workbox)).toHaveCount(0);
}

test("시점으로 롤백하고, 롤백 직전 상태로 역롤백한다", async ({ vscodeExePath }, testInfo) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    { settings: { "window.dialogStyle": "custom" } },
  );
  try {
    const workbox = await app.firstWindow();
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const historyPane = historyPaneOf(workbox);

    fs.writeFileSync(filePath, "first change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 1, { timeout: 15_000 });
    fs.writeFileSync(filePath, "second change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 2, { timeout: 15_000 });

    // "first change" 시점(두 번째 항목)으로 롤백 — 다이얼로그 스크린샷 포함
    await rollbackViaInlineButton(workbox, 1, path.join(shotDir, "rollback-dialog.png"));

    // 디스크가 시점 내용으로 되돌아가고, 롤백 결과가 새 시점으로 기록된다
    await expect.poll(() => fs.readFileSync(filePath, "utf8"), { timeout: 15_000 }).toBe(
      "first change\n",
    );
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 3, { timeout: 15_000 });

    // 역롤백 — 롤백 전 상태("second change" 시점, 이제 두 번째 항목)로 복귀
    await rollbackViaInlineButton(workbox, 1);
    await expect.poll(() => fs.readFileSync(filePath, "utf8"), { timeout: 15_000 }).toBe(
      "second change\n",
    );
    await workbox.screenshot({ path: path.join(shotDir, "rollback-reverted.png") });
  } finally {
    await app.close();
    fs.rmSync(filePath, { force: true });
  }
});
