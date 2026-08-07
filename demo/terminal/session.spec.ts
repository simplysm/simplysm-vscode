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

test("정상 종료하면 그 자리가 닫히고 빈 상태 안내가 뜬다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("exit\r");

  await expect(frame.locator("#notice")).toContainText("No terminal session is open.", {
    timeout: 30_000,
  });
  await expect(frame.locator(".screen")).toHaveCount(0);
  await expect(frame.locator("#notice-action")).toContainText("Start a session");
  await workbox.screenshot({ path: path.join(shotDir, "session-empty.png") });
});

test("빈 상태에서 세션을 시작하면 다시 뜬다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("exit\r");
  await expect(frame.locator("#notice-action")).toBeVisible({ timeout: 30_000 });

  await frame.locator("#notice-action").click();
  await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  await expect(frame.locator("#notice")).toBeHidden();

  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("echo restarted-session\r");
  await expect(frame.locator(".xterm-rows")).toContainText("restarted-session", {
    timeout: 30_000,
  });
  await workbox.screenshot({ path: path.join(shotDir, "session-restarted.png") });
});

test("빈 상태는 panel 을 닫았다 열어도 세션을 자동으로 만들지 않는다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("exit\r");
  await expect(frame.locator("#notice-action")).toBeVisible({ timeout: 30_000 });

  await runCommand(workbox, "View: Close Panel");
  await expect(workbox.locator("#workbench\\.parts\\.panel")).toBeHidden();
  await runCommand(workbox, "Simplysm Terminal");

  const frameAgain = webviewFrame(workbox);
  await expect(frameAgain.locator("#notice")).toContainText("No terminal session is open.", {
    timeout: 30_000,
  });
  // 다시 보이는 동안 세션이 저절로 생기지 않는지 확인할 시간을 준다
  await workbox.waitForTimeout(8000);
  await expect(frameAgain.locator(".screen")).toHaveCount(0);
  await expect(frameAgain.locator(".tab-label")).toHaveCount(0);
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

test("비워 둔 창을 리로드해도 빈 상태가 그대로 이어진다", async ({ workbox }) => {
  // 마지막 자리를 닫은 것은 사용자의 명시 행위다 — reload 가 이를 뒤집고 세션을 만들면 안 된다.
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("exit\r");
  await expect(frame.locator("#notice-action")).toBeVisible({ timeout: 30_000 });

  await runCommand(workbox, "Developer: Reload Window");
  await workbox.waitForTimeout(5000);
  await runCommand(workbox, "Simplysm Terminal");

  const frameAgain = webviewFrame(workbox);
  await expect(frameAgain.locator("#notice")).toContainText("No terminal session is open.", {
    timeout: 60_000,
  });
  await expect(frameAgain.locator(".screen")).toHaveCount(0);
  await expect(frameAgain.locator("#notice-action")).toContainText("Start a session");
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
