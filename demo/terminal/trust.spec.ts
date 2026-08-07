// 워크스페이스 신뢰 시연 — 신뢰를 끄지 않은 기동에서 신뢰를 준 뒤 확장이 활성화되는지 본다.
import path from "node:path";
import { expect, launchVsCode, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");

test("신뢰한 워크스페이스에서 확장이 활성화되고 세션이 뜬다", async ({
  vscodeExePath,
}, testInfo) => {
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    { workspaceTrust: true },
  );
  try {
    const workbox = await app.firstWindow();
    const trustButton = workbox.getByRole("button", { name: /Yes, I trust the authors/i });
    // 확장 개발 기동은 창을 스스로 신뢰할 수 있다. 물어보면 신뢰를 주고, 안 물으면 그대로 간다.
    if (await trustButton.isVisible()) await trustButton.click();
    // 제한 모드로 남았다면 이 확장은 비활성이므로 아래 화면이 뜨지 않는다
    await expect(workbox.locator(".statusbar-item .codicon-shield")).toHaveCount(0);

    await runCommand(workbox, "Simplysm Terminal");
    const frame = webviewFrame(workbox);
    await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
    // 셸이 실제로 떠 프롬프트를 내놓는 것까지 확인한 뒤 화면을 남긴다
    await expect(frame.locator(".xterm-rows")).toContainText("PS ", { timeout: 30_000 });
    await workbox.screenshot({ path: path.join(shotDir, "trust-activated.png") });
  } finally {
    await app.close();
  }
});
