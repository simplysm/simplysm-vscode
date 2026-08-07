// 시작 폴더 선택 시연 — 후보가 여럿이면 tab 이 먼저 생기고 그 안에서 고른다.
import path from "node:path";
import { expect, launchVsCode, rootDir, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");
const multiRootFile = path.join(rootDir, "demo", "workspace", "multi-root", "demo.code-workspace");

test("폴더가 여럿이면 새 tab 안에서 시작 폴더를 고르고 그 경로에서 셸이 뜬다", async ({
  vscodeExePath,
}, testInfo) => {
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    { openTarget: multiRootFile },
  );
  try {
    const workbox = await app.firstWindow();
    await runCommand(workbox, "Simplysm Terminal");
    const frame = webviewFrame(workbox);

    // tab 은 세션보다 먼저 생기고, 그 자리에 후보가 폴더 이름과 경로로 나열된다
    const options = frame.locator(".start-option");
    await expect(options).toHaveCount(2, { timeout: 60_000 });
    await expect(options.nth(0)).toContainText("folder-a");
    await expect(options.nth(1)).toContainText("folder-b");
    // 폴더별 재정의가 그 폴더의 후보 경로에 반영된다
    await expect(options.nth(1)).toContainText(path.join("folder-b", "sub"));
    await expect(frame.locator(".xterm-screen")).toHaveCount(0);
    await workbox.screenshot({ path: path.join(shotDir, "start-directory-choices.png") });

    await options.nth(1).click();

    await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
    await expect(frame.locator(".start-option")).toHaveCount(0);
    // 셸이 고른 경로에서 시작했음이 프롬프트에 드러난다
    await expect(frame.locator(".xterm-rows")).toContainText("sub", { timeout: 30_000 });
    await workbox.screenshot({ path: path.join(shotDir, "start-directory-started.png") });
  } finally {
    await app.close();
  }
});
