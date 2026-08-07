// 단축키 시연 — Ctrl+F 검색 열기와, 셸 편집 키가 내장 터미널 규칙대로 갈리는지 확인한다.
//
// 하네스는 창 포커스 없이 키를 합성하므로 VS Code 쪽 keybinding(빠른 열기 등)의 발동은 여기서
// 검증할 수 없다. 자동 검증 범위는 "그 키가 셸에 닿는가 / 걸러지는가" 이고, VS Code 쪽 반응은
// F5 육안 확인 대상이다.
import path from "node:path";
import { expect, launchVsCode, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");

async function openTerminalPanel(workbox: Parameters<typeof webviewFrame>[0]) {
  await runCommand(workbox, "Simplysm Terminal");
  const frame = webviewFrame(workbox);
  await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  return frame;
}

test("Ctrl+F — 뷰 안에서는 검색이 열리고, 뷰 밖에서는 반응하지 않는다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.press("Control+KeyF");
  await expect(frame.locator(".search-bar")).toBeVisible();
  await workbox.screenshot({ path: path.join(shotDir, "keys-ctrl-f-search.png") });
  await workbox.keyboard.press("Escape");
  await expect(frame.locator(".search-bar")).toHaveCount(0);

  // 에디터로 포커스를 옮기면 Ctrl+F 는 이 확장의 검색을 열지 않는다.
  await runCommand(workbox, "File: New Untitled Text File");
  await workbox.keyboard.press("Control+KeyF");
  await expect(frame.locator(".search-bar")).toHaveCount(0);
});

test("기본 설정 — Ctrl+R 는 셸에 닿고, skip 목록의 Ctrl+P 는 셸로 가지 않는다", async ({
  workbox,
}) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  // Ctrl+P 도달 여부를 셸에서 관찰할 수 있게 PSReadLine 에 바인딩해 둔다.
  await workbox.keyboard.type("Set-PSReadLineKeyHandler -Chord Ctrl+p -Function PreviousHistory\r");
  await workbox.keyboard.type("echo history-marker\r");
  await expect(frame.locator(".xterm-rows")).toContainText("history-marker", { timeout: 30_000 });

  // PSReadLine 의 역방향 검색 프롬프트가 뜨면 Ctrl+R 가 셸에 닿은 것이다.
  await workbox.keyboard.press("Control+KeyR");
  await expect(frame.locator(".xterm-rows")).toContainText("bck-i-search", { timeout: 30_000 });
  await workbox.screenshot({ path: path.join(shotDir, "keys-ctrl-r-shell.png") });
  await workbox.keyboard.press("Escape");

  // Ctrl+P 는 기본 skip 목록(빠른 열기)의 키라 에뮬레이터가 걸러 셸에 가지 않는다 —
  // 직전 명령이 입력 줄에 되살아나지 않아야 한다.
  const promptRows = frame.locator(".xterm-rows > div").filter({ hasText: "echo history-marker" });
  await expect(promptRows).toHaveCount(1);
  await workbox.keyboard.press("Control+KeyP");
  await workbox.waitForTimeout(2_000);
  await expect(promptRows).toHaveCount(1);
});

test("에디터로 포커스를 옮기면 셸 편집 키가 더는 셸로 가지 않는다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.press("Control+KeyR");
  await expect(frame.locator(".xterm-rows")).toContainText("bck-i-search", { timeout: 30_000 });
  await workbox.keyboard.press("Escape");

  await runCommand(workbox, "File: New Untitled Text File");
  await workbox.keyboard.press("Control+KeyR");
  await workbox.waitForTimeout(2_000);
  // 역방향 검색 프롬프트가 다시 뜨지 않아야 한다 (Esc 로 이미 닫혔고 새로 열리지 않음).
  await expect(
    frame.locator(".xterm-rows > div").filter({ hasText: "bck-i-search" }),
  ).toHaveCount(0);
});

test("commandsToSkipShell 에서 빠른 열기를 빼면 Ctrl+P 가 셸에 닿는다", async ({
  vscodeExePath,
}, testInfo) => {
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    {
      settings: {
        "terminal.integrated.commandsToSkipShell": ["-workbench.action.quickOpen"],
      },
    },
  );
  try {
    const workbox = await app.firstWindow();
    const frame = await openTerminalPanel(workbox);
    await frame.locator(".screen .xterm-screen").click();
    await workbox.keyboard.type(
      "Set-PSReadLineKeyHandler -Chord Ctrl+p -Function PreviousHistory\r",
    );
    await workbox.keyboard.type("echo previous-history-marker\r");
    await expect(frame.locator(".xterm-rows")).toContainText("previous-history-marker", {
      timeout: 30_000,
    });

    // PSReadLine 의 이전 히스토리 — 직전 명령이 입력 줄에 되살아난다.
    await workbox.keyboard.press("Control+KeyP");
    await expect(
      frame.locator(".xterm-rows > div").filter({ hasText: "echo previous-history-marker" }),
    ).toHaveCount(2, { timeout: 30_000 });
    await workbox.screenshot({ path: path.join(shotDir, "keys-ctrl-p-shell.png") });
  } finally {
    await app.close();
  }
});
