// 지역화 시연 — 표시 언어를 한국어로 두고 기동해 panel tab 이름과 webview 문자열이 한국어로 나오는지 본다.
import fs from "node:fs";
import path from "node:path";
import { expect, launchVsCode, rootDir, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");
const multiRootFile = path.join(rootDir, "demo", "workspace", "multi-root", "demo.code-workspace");

test("표시 언어가 한국어면 panel tab 이름과 webview 문자열이 한국어로 나온다", async ({
  vscodeExePath,
}, testInfo) => {
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  // 후보가 여럿인 워크스페이스로 열어 webview 문자열(시작 폴더 안내)까지 함께 확인한다.
  const options = { openTarget: multiRootFile, locale: "ko" };
  // VS Code 는 기동 시점에 이미 등록된 언어 팩만 쓴다. 첫 기동이 팩을 등록해 목록 파일을 쓰고,
  // 그 파일이 생긴 뒤의 기동부터 한국어가 된다.
  const firstRun = await launchVsCode(vscodeExePath, dirs, options);
  const packRegistryPath = path.join(dirs.userDataDir, "languagepacks.json");
  await expect.poll(() => fs.existsSync(packRegistryPath), { timeout: 60_000 }).toBe(true);
  await firstRun.close();

  const app = await launchVsCode(vscodeExePath, dirs, options);
  try {
    const workbox = await app.firstWindow();
    await runCommand(workbox, "Simplysm");
    const frame = webviewFrame(workbox);

    await expect(frame.locator(".start-title")).toHaveText("시작할 폴더를 고르세요", {
      timeout: 60_000,
    });
    const panelTabNames = await workbox
      .locator("#workbench\\.parts\\.panel .composite-bar .action-label")
      .allTextContents();
    expect(panelTabNames).toContain("Simplysm 터미널");
    await workbox.screenshot({ path: path.join(shotDir, "language-korean.png") });
  } finally {
    await app.close();
  }
});
