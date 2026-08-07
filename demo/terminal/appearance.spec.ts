// 표시 설정·테마 추종 시연 — 설정과 테마를 바꾸면 열려 있는 화면이 즉시 새 값으로 다시 그려진다.
import fs from "node:fs";
import path from "node:path";
import { expect, launchVsCode, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");

test("색 테마와 글꼴 설정을 바꾸면 열려 있는 화면이 즉시 따라간다", async ({
  vscodeExePath,
}, testInfo) => {
  const userDataDir = testInfo.outputPath("user-data");
  const app = await launchVsCode(vscodeExePath, {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir,
  });
  try {
    const workbox = await app.firstWindow();
    await runCommand(workbox, "Simplysm Terminal");
    const frame = webviewFrame(workbox);
    const screen = frame.locator(".screen .xterm-screen");
    await expect(screen).toBeVisible({ timeout: 60_000 });

    const rows = frame.locator(".xterm-rows > div");
    const readStyle = async () =>
      await frame.locator(".xterm-rows").evaluate((element) => {
        const style = getComputedStyle(element);
        // 에뮬레이터는 표시 옵션의 배경색을 스크롤 영역 요소에 얹는다.
        const surface = element.ownerDocument.querySelector(".xterm-scrollable-element");
        return {
          fontSize: style.fontSize,
          fontFamily: style.fontFamily,
          foreground: style.color,
          background: surface == null ? "" : getComputedStyle(surface).backgroundColor,
        };
      });

    const before = await readStyle();
    const rowsBefore = await rows.count();
    await workbox.screenshot({ path: path.join(shotDir, "appearance-before.png") });

    // 사용자 설정 파일을 바꾸는 것이 실사용 경로다 — 확장은 설정 변경 이벤트로만 안다.
    const settingsPath = path.join(userDataDir, "User", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        ...settings,
        "workbench.colorTheme": "Default Light Modern",
        "terminal.integrated.fontSize": 22,
        "terminal.integrated.fontFamily": "Consolas",
      }),
    );

    await expect
      .poll(async () => (await readStyle()).fontSize, { timeout: 30_000 })
      .not.toBe(before.fontSize);
    const after = await readStyle();
    const rowsAfter = await rows.count();

    expect(after.fontFamily).not.toBe(before.fontFamily);
    expect(after.background).not.toBe(before.background);
    expect(after.foreground).not.toBe(before.foreground);
    // 글자 칸이 커졌으므로 같은 pane 에 들어가는 행 수가 줄어든다 — 크기를 다시 맞췄다는 뜻이다.
    expect(rowsAfter).toBeLessThan(rowsBefore);
    await workbox.screenshot({ path: path.join(shotDir, "appearance-after.png") });
  } finally {
    await app.close();
  }
});

test("기본 설정(gpuAcceleration=auto)에선 WebGL 렌더러로 그린다", async ({
  vscodeExePath,
}, testInfo) => {
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    // 하네스 기본값(off)을 걷어내 실사용 기본 경로를 태운다.
    { settings: { "terminal.integrated.gpuAcceleration": "auto" } },
  );
  try {
    const workbox = await app.firstWindow();
    await runCommand(workbox, "Simplysm Terminal");
    const frame = webviewFrame(workbox);
    const screen = frame.locator(".screen .xterm-screen");
    await expect(screen).toBeVisible({ timeout: 60_000 });

    // WebGL 렌더러는 canvas 로 그리고 DOM 행을 만들지 않는다 — 두 사실이 함께 성립해야
    // "폴백이 아니라 진짜 WebGL 경로" 를 뜻한다.
    await expect(screen.locator("canvas.xterm-link-layer")).toBeAttached({ timeout: 30_000 });
    await expect(frame.locator(".xterm-rows > div")).toHaveCount(0);

    // 글자가 실제로 그려졌는지는 DOM 으로 판정할 수 없다(캔버스) — 눈에 띄는 출력을 만들고
    // 프롬프트가 그려질 시간을 준 뒤 스크린샷 육안 확인용으로 남긴다.
    await screen.click();
    await workbox.keyboard.type("echo webgl-visual-marker");
    await workbox.keyboard.press("Enter");
    await workbox.waitForTimeout(5_000);
    await workbox.screenshot({ path: path.join(shotDir, "appearance-webgl.png") });
  } finally {
    await app.close();
  }
});
