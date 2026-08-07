// 슬라이스 6 시연 — 미기동 중(VS Code 종료 상태) 변경이 재기동 시 기동 스캔으로 기록된다.
// 같은 userDataDir 로 2회 기동해 종료↔재기동을 재현한다 (fixtures 재시작 패턴).
import path from "node:path";
import fs from "node:fs";
import { expect, launchVsCode, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import {
  countSnapshots,
  historyPaneOf,
  prepareRecording,
  showHistoryViaContextMenu,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-scan-target.txt";

test("미기동 중 변경이 재기동 시 기동 스캔으로 잡힌다", async ({ vscodeExePath }, testInfo) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  try {
    // 1차 기동 — 웜업 기록으로 색인 확보 후 종료
    const firstApp = await launchVsCode(vscodeExePath, dirs);
    try {
      const workbox = await firstApp.firstWindow();
      await prepareRecording(workbox, fileName, filePath);
    } finally {
      await firstApp.close();
    }
    const before = countSnapshots(dirs.userDataDir);

    // 미기동 중 외부 변경
    fs.writeFileSync(filePath, "offline change\n");

    // 2차 기동 — 기동 스캔이 변경을 기록 (색인 덕에 무변경 파일은 재기록하지 않음 = 정확히 +1)
    const secondApp = await launchVsCode(vscodeExePath, dirs);
    try {
      const workbox = await secondApp.firstWindow();
      await expect
        .poll(() => countSnapshots(dirs.userDataDir), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(before + 1);
      await workbox.waitForTimeout(2_000); // 추가 기록이 없는지 정착 대기
      expect(countSnapshots(dirs.userDataDir)).toBe(before + 1);

      // UI 확인 — Show History 목록에 오프라인 변경 시점이 보인다
      const treeItem = workbox.getByRole("treeitem", { name: fileName });
      await treeItem.waitFor({ state: "visible", timeout: 30_000 });
      await showHistoryViaContextMenu(workbox, treeItem, fileName);
      const items = historyPaneOf(workbox).getByRole("treeitem");
      await expect(items.first()).toBeVisible({ timeout: 15_000 });
      await workbox.screenshot({ path: path.join(shotDir, "scan-offline-change.png") });
    } finally {
      await secondApp.close();
    }
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
