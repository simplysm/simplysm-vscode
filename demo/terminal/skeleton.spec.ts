// 골격 밴드 시연 — panel tab 을 열면 세션 1개가 뜨고 명령 입출력이 되는 최초 실행 상태를 확인한다.
import path from "node:path";
import { expect, launchVsCode, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");

/** panel 의 이 확장 tab 을 열고 화면이 뜰 때까지 기다린다. */
async function openTerminalPanel(workbox: Parameters<typeof webviewFrame>[0]) {
  await runCommand(workbox, "Simplysm Terminal");
  const frame = webviewFrame(workbox);
  await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  return frame;
}

test("panel tab 을 열면 세션 1개가 떠 명령 입출력이 된다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);

  // 내장 TERMINAL 과 같은 줄에 놓인다
  const panelTabNames = await workbox
    .locator("#workbench\\.parts\\.panel .composite-bar .action-label")
    .allTextContents();
  expect(panelTabNames).toContain("Terminal");
  expect(panelTabNames).toContain("Simplysm Terminal");

  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("echo simplysm-demo-output\r");
  await expect(frame.locator(".xterm-rows")).toContainText("simplysm-demo-output", {
    timeout: 30_000,
  });

  // truecolor 선언이 셸 환경에 실제로 실린다 — truecolor 감지 프로그램(TUI)의 색 강등 방지.
  await workbox.keyboard.type("echo COLORTERM=$env:COLORTERM\r");
  await expect(frame.locator(".xterm-rows")).toContainText("COLORTERM=truecolor", {
    timeout: 30_000,
  });

  await workbox.screenshot({ path: path.join(shotDir, "skeleton-session.png") });
});

test("다른 panel tab 으로 갔다 돌아오면 그동안의 출력이 채워진다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("echo before-switch\r");
  await expect(frame.locator(".xterm-rows")).toContainText("before-switch", { timeout: 30_000 });

  // 숨은 동안 출력이 쌓이도록 지연 실행을 걸어 두고 내장 TERMINAL 로 옮겨 간다
  await workbox.keyboard.type("timeout /t 2 > nul & echo after-switch\r");
  await runCommand(workbox, "View: Toggle Terminal");
  await workbox.waitForTimeout(4000);

  const frameAgain = await openTerminalPanel(workbox);
  await expect(frameAgain.locator(".xterm-rows")).toContainText("after-switch", {
    timeout: 30_000,
  });
  await workbox.screenshot({ path: path.join(shotDir, "skeleton-restored.png") });
});

test("panel 을 닫았다 다시 열면 배치와 화면이 복구된다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("echo before-hide\r");
  await expect(frame.locator(".xterm-rows")).toContainText("before-hide", { timeout: 30_000 });

  await runCommand(workbox, "View: Close Panel");
  await expect(workbox.locator("#workbench\\.parts\\.panel")).toBeHidden();

  const frameAgain = await openTerminalPanel(workbox);
  await expect(frameAgain.locator(".xterm-rows")).toContainText("before-hide", { timeout: 30_000 });
});

test("대량 출력이 쏟아지는 동안에도 입력이 반응한다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();

  await workbox.keyboard.type('1..4000 | ForEach-Object { "flood line $_" }\r');
  // 출력이 쏟아지는 도중에 친 명령이 그대로 받아들여져 실행된다
  await workbox.keyboard.type("echo typed-while-flooding\r");
  await expect(frame.locator(".xterm-rows")).toContainText("typed-while-flooding", {
    timeout: 60_000,
  });
});

// 코드 0 으로 끝나면 그 자리가 자동으로 닫히므로(세션 관리), 종료 표시는 0 아닌 코드로 확인한다.
test("셸이 끝나면 종료 표시가 뜨고 입력을 더 받지 않는다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("exit 3\r");

  await expect(frame.locator(".screen-exit")).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator(".screen-exit")).toContainText("exited with code 3");
  await workbox.screenshot({ path: path.join(shotDir, "skeleton-exited.png") });

  // 종료된 화면은 입력을 받지 않으므로 친 글자가 화면에 남지 않는다
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("after-exit");
  await expect(frame.locator(".xterm-rows")).not.toContainText("after-exit");
});

test("폴더를 열지 않은 창에서는 안내만 보이고 확장은 살아 있다", async ({
  vscodeExePath,
}, testInfo) => {
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    { openTarget: null },
  );
  try {
    const emptyWindow = await app.firstWindow();
    await runCommand(emptyWindow, "Simplysm Terminal");
    const frame = webviewFrame(emptyWindow);
    await expect(frame.locator("#notice")).toContainText("Open a folder", { timeout: 60_000 });
    await expect(frame.locator(".screen")).toHaveCount(0);
    await emptyWindow.screenshot({ path: path.join(shotDir, "skeleton-no-folder.png") });
  } finally {
    await app.close();
  }
});
