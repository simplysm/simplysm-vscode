// 슬라이스 8 시연 — 한국어 표시 언어에서 명령 제목(nls)·뷰 이름·런타임 문자열(l10n 번들)이 한국어로 보인다.
// VS Code 는 기동 시점에 이미 등록된 언어 팩만 쓴다 — 첫 기동이 팩을 등록하고,
// languagepacks.json 이 생긴 뒤의 기동부터 한국어가 된다 (focus-refresh conflict.spec 과 동일).
import path from "node:path";
import fs from "node:fs";
import { expect, launchVsCode, runResultsDir, runCommand, test, workspaceDir } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-l10n-target.txt";

test("한국어 UI — 명령 제목·뷰 이름·알림이 한국어로 보인다", async ({
  vscodeExePath,
}, testInfo) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  try {
    // 1차 기동 — 언어 팩 등록
    const firstRun = await launchVsCode(vscodeExePath, dirs, { locale: "ko" });
    await expect
      .poll(() => fs.existsSync(path.join(dirs.userDataDir, "languagepacks.json")), {
        timeout: 60_000,
      })
      .toBe(true);
    await firstRun.close();

    // 2차 기동 — 한국어 UI
    const app = await launchVsCode(vscodeExePath, dirs, { locale: "ko" });
    try {
      const workbox = await app.firstWindow();
      const treeItem = workbox.getByRole("treeitem", { name: fileName });
      await treeItem.waitFor({ state: "visible", timeout: 30_000 });

      // 파일을 열지 않은 채 한국어 명령 제목(nls)으로 실행 → 런타임 번들(l10n) 경고가 한국어로
      await runCommand(workbox, "이력 보기");
      await expect(
        workbox.locator(".notification-toast").filter({ hasText: "이력을 보려면 파일을 여세요." }),
      ).toBeVisible({ timeout: 15_000 });

      // 파일을 열고 다시 실행 → 뷰 이름(nls) "로컬 이력" pane 표시
      await treeItem.click();
      await expect(workbox.locator(".editor-instance .view-lines")).toContainText("initial", {
        timeout: 30_000,
      });
      await runCommand(workbox, "이력 보기");
      await workbox
        .locator(".pane-header", { hasText: "로컬 이력" })
        .waitFor({ state: "visible", timeout: 15_000 });
      await workbox.screenshot({ path: path.join(shotDir, "l10n-ko.png") });
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
