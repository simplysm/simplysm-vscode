// 셸 프로필 시연 — 기본 터미널 프로필의 인자 · 환경 변수를 내장 터미널처럼 적용하고, 프로필을 바꾸면
// 그 뒤에 여는 tab 부터 따른다. 떠 있던 셸은 그대로다.
import fs from "node:fs";
import path from "node:path";
import {
  expect,
  launchVsCode,
  prepareDemoShell,
  runResultsDir,
  runCommand,
  test,
  webviewFrame,
} from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");

/** pwsh 시작 배너의 첫 줄 — "PowerShell 7.6.7". */
const bannerPattern = /PowerShell \d+\.\d+/;

test("기본 프로필의 인자·환경 변수를 적용하고, 프로필을 바꾸면 새 tab 부터 따른다", async ({
  vscodeExePath,
}, testInfo) => {
  test.skip(process.platform !== "win32", "pwsh 프로필 시연은 Windows 전용이다.");
  const userDataDir = testInfo.outputPath("user-data");
  const dirs = { extensionsDir: testInfo.outputPath("extensions"), userDataDir };
  const app = await launchVsCode(
    vscodeExePath,
    dirs,
    {
      settings: {
        // 인자 없는 기본 프로필 — pwsh 가 시작 배너를 보이는 기준 화면이다.
        "terminal.integrated.profiles.windows": { "demo-pwsh": { path: "pwsh" } },
        "terminal.integrated.defaultProfile.windows": "demo-pwsh",
        // 설정 env 와 프로필 env 에 같은 이름이 있으면 프로필이 이긴다(내장 터미널의 합치는 순서).
        "terminal.integrated.env.windows": {
          SIMPLYSM_DEMO_CONFIG: "from-config",
          SIMPLYSM_DEMO_PROFILE: "from-config",
        },
      },
    },
  );
  try {
    const workbox = await app.firstWindow();
    await runCommand(workbox, "Simplysm Terminal");
    const frame = webviewFrame(workbox);
    const screens = frame.locator(".screen .xterm-screen");
    const rows = frame.locator(".xterm-rows");
    await expect(screens).toHaveCount(1, { timeout: 60_000 });
    await expect(rows.first()).toContainText(bannerPattern, { timeout: 30_000 });
    await workbox.screenshot({ path: path.join(shotDir, "shell-profile-before.png") });

    // 사용자 설정 파일을 바꾸는 것이 실사용 경로다. 같은 저장에 실린 글꼴 크기가 화면에 반영되면
    // 확장 호스트가 이 변경을 받은 것이다 — 프로필 변경은 화면에 드러나지 않아 그 표지로 기다린다.
    // 바꾼 설정도 하네스의 입력 기록 격리를 거친다 — 새 tab 의 셸이 사용자 입력 기록을 쓰지 않게.
    const readFontSize = async () =>
      await rows.first().evaluate((element) => getComputedStyle(element).fontSize);
    const fontSizeBefore = await readFontSize();
    const settingsPath = path.join(userDataDir, "User", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const changed = await prepareDemoShell(
      vscodeExePath,
      dirs,
      {
        ...settings,
        "terminal.integrated.profiles.windows": {
          "demo-pwsh": { path: "pwsh" },
          "demo-pwsh-nologo": {
            path: "pwsh",
            args: ["-NoLogo"],
            env: {
              SIMPLYSM_DEMO_PROFILE: "from-profile",
              SIMPLYSM_DEMO_FOLDER: "${workspaceFolderBasename}",
            },
          },
        },
        "terminal.integrated.defaultProfile.windows": "demo-pwsh-nologo",
        "terminal.integrated.fontSize": Number.parseFloat(fontSizeBefore) + 2,
      },
    );
    fs.writeFileSync(settingsPath, JSON.stringify(changed.settings));
    await expect.poll(readFontSize, { timeout: 30_000 }).not.toBe(fontSizeBefore);

    await frame.locator(".tab-add").first().click();
    await expect(screens).toHaveCount(2, { timeout: 60_000 });
    const newRows = rows.nth(1);
    await screens.nth(1).click();
    // 값은 입력 문자열에 없다 — 출력에 보이면 셸이 그 환경 변수를 받은 것이다.
    await workbox.keyboard.type(
      '"$env:SIMPLYSM_DEMO_PROFILE/$env:SIMPLYSM_DEMO_CONFIG/$env:SIMPLYSM_DEMO_FOLDER"\r',
    );
    await expect(newRows).toContainText("from-profile/from-config/workspace", { timeout: 30_000 });
    // -NoLogo 가 적용돼 새 tab 에는 배너가 없다.
    await expect(newRows).not.toContainText(bannerPattern);
    await workbox.screenshot({ path: path.join(shotDir, "shell-profile-new-tab.png") });

    // 떠 있던 셸은 그대로다 — 배너가 남아 있고, 새 프로필의 환경 변수를 받지 않았다.
    await frame.locator(".tab-label").first().click();
    await expect(screens.first()).toBeVisible();
    await screens.first().click();
    await workbox.keyboard.type('"[$env:SIMPLYSM_DEMO_PROFILE]"\r');
    await expect(rows.first()).toContainText("[from-config]", { timeout: 30_000 });
    await expect(rows.first()).toContainText(bannerPattern);
    await workbox.screenshot({ path: path.join(shotDir, "shell-profile-old-tab.png") });
  } finally {
    await app.close();
  }
});
