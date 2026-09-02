// 세션 관리 시연 — 셸이 끝났을 때 자리를 닫을지 남길지, 자리가 다 없어진 뒤 무엇이 보이는지 확인한다.
import path from "node:path";
import { expect, launchVsCode, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");

async function openTerminalPanel(workbox: Parameters<typeof webviewFrame>[0]) {
  await runCommand(workbox, "Simplysm Terminal");
  const frame = webviewFrame(workbox);
  await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  return frame;
}

test("정상 종료로 마지막 자리가 닫히면 내장 터미널처럼 패널이 숨겨진다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("exit\r");

  await expect(workbox.locator("#workbench\\.parts\\.panel")).toBeHidden({ timeout: 30_000 });
  await workbox.screenshot({ path: path.join(shotDir, "session-empty.png") });
});

test("마지막 자리를 닫은 뒤 패널을 다시 열면 새 세션이 바로 뜬다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("exit\r");
  await expect(workbox.locator("#workbench\\.parts\\.panel")).toBeHidden({ timeout: 30_000 });

  await runCommand(workbox, "Simplysm Terminal");
  const frameAgain = webviewFrame(workbox);
  await expect(frameAgain.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  await expect(frameAgain.locator("#notice")).toBeHidden();
  await expect(frameAgain.locator(".tab-label")).toHaveCount(1);

  await frameAgain.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("echo restarted-session\r");
  await expect(frameAgain.locator(".xterm-rows")).toContainText("restarted-session", {
    timeout: 30_000,
  });
  await workbox.screenshot({ path: path.join(shotDir, "session-restarted.png") });
});

test("hideOnLastClosed 를 끄면 패널이 남고 빈 상태 안내에서 시작할 수 있다", async ({
  vscodeExePath,
}, testInfo) => {
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    { settings: { "terminal.integrated.hideOnLastClosed": false } },
  );
  try {
    const window = await app.firstWindow();
    const frame = await openTerminalPanel(window);
    await frame.locator(".screen .xterm-screen").click();
    await window.keyboard.type("exit\r");

    await expect(frame.locator("#notice")).toContainText("No terminal session is open.", {
      timeout: 30_000,
    });
    await expect(window.locator("#workbench\\.parts\\.panel")).toBeVisible();
    await expect(frame.locator(".screen")).toHaveCount(0);

    await frame.locator("#notice-action").click();
    await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
    await expect(frame.locator("#notice")).toBeHidden();
  } finally {
    await app.close();
  }
});

test("시작에 실패한 자리는 panel 을 닫았다 열어도 사유를 그대로 보인다", async ({
  vscodeExePath,
}, testInfo) => {
  const missingCwd = testInfo.outputPath("no-such-start-folder");
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    { settings: { "terminal.integrated.cwd": missingCwd } },
  );
  try {
    const window = await app.firstWindow();
    await runCommand(window, "Simplysm Terminal");
    const frame = webviewFrame(window);
    await expect(frame.locator(".start-failure")).toContainText("Could not start a session", {
      timeout: 60_000,
    });

    await runCommand(window, "View: Close Panel");
    await expect(window.locator("#workbench\\.parts\\.panel")).toBeHidden();
    await runCommand(window, "Simplysm Terminal");

    const frameAgain = webviewFrame(window);
    await expect(frameAgain.locator(".start-failure")).toContainText("Could not start a session", {
      timeout: 30_000,
    });
    await expect(frameAgain.locator(".tab-label")).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("비워 둔 창을 리로드해도 저절로 세션이 생기지 않고, 패널을 열면 그때 뜬다", async ({
  workbox,
}) => {
  // reload 자체는 아무것도 만들지 않는다. 세션은 사용자가 패널을 여는 순간에만 생긴다.
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("exit\r");
  await expect(workbox.locator("#workbench\\.parts\\.panel")).toBeHidden({ timeout: 30_000 });

  await runCommand(workbox, "Developer: Reload Window");
  await workbox.waitForTimeout(8000);
  await expect(workbox.locator("#workbench\\.parts\\.panel")).toBeHidden();

  await runCommand(workbox, "Simplysm Terminal");
  const frameAgain = webviewFrame(workbox);
  await expect(frameAgain.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  await expect(frameAgain.locator(".tab-label")).toHaveCount(1);
});

test("세션 생성이 실패하면 그 자리에 사유가 보이고 다시 고를 수 있다", async ({
  vscodeExePath,
}, testInfo) => {
  // 없는 폴더를 시작 경로로 주면 셸을 띄우지 못한다. 실패 화면과 재선택이 남는지 본다.
  const missingCwd = testInfo.outputPath("no-such-start-folder");
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    { settings: { "terminal.integrated.cwd": missingCwd } },
  );
  try {
    const window = await app.firstWindow();
    await runCommand(window, "Simplysm Terminal");
    const frame = webviewFrame(window);

    await expect(frame.locator(".start-failure")).toContainText("Could not start a session", {
      timeout: 60_000,
    });
    await expect(frame.locator(".start-failure")).toContainText(missingCwd);
    // 사유를 보인 뒤에도 후보가 남아 다시 고를 수 있다
    await expect(frame.locator(".start-option")).toHaveCount(1);
    await expect(frame.locator(".screen")).toHaveCount(0);
    await window.screenshot({ path: path.join(shotDir, "session-start-failure.png") });
  } finally {
    await app.close();
  }
});

test("0 이 아닌 코드로 끝나면 자리가 남고 코드가 보인다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("exit 3\r");

  await expect(frame.locator(".screen-exit")).toContainText("exited with code 3", {
    timeout: 30_000,
  });
  await expect(frame.locator(".screen")).toHaveCount(1);
  await expect(frame.locator("#notice")).toBeHidden();
  await workbox.screenshot({ path: path.join(shotDir, "session-exit-code.png") });
});
