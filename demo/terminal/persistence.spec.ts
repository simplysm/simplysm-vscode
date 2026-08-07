// 세션 영속 시연 — 창을 리로드해도 daemon 이 쥔 세션·배치·화면이 그대로 이어지는지 확인한다.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, rootDir, runCommand, runResultsDir, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");

async function openTerminalPanel(workbox: Page): Promise<FrameLocator> {
  await runCommand(workbox, "Simplysm Terminal");
  const frame = webviewFrame(workbox);
  await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  return frame;
}

test("리로드해도 세션·탭·이름·화면 내용이 그대로 이어진다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);

  // 화면에 남을 표식을 찍고, 이름 붙인 둘째 자리도 만들어 배치가 함께 복원되는지 본다.
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("echo persist-marker-before-reload\r");
  await expect(frame.locator(".xterm-rows")).toContainText("persist-marker-before-reload", {
    timeout: 30_000,
  });
  await frame.locator(".tab-add").click();
  await expect(frame.locator(".tab-label")).toHaveCount(2, { timeout: 60_000 });
  await frame.locator(".tab-label").nth(1).click({ button: "right" });
  await frame.locator(".tab-menu-item", { hasText: "Rename…" }).click();
  const renameInput = frame.locator(".tab-rename-input");
  await expect(renameInput).toBeVisible();
  await renameInput.fill("second tab");
  await renameInput.press("Enter");
  await expect(frame.locator(".tab-label").nth(1)).toHaveText("second tab");

  await runCommand(workbox, "Developer: Reload Window");
  await workbox.waitForTimeout(5000);
  await runCommand(workbox, "Simplysm Terminal");

  const frameAgain = webviewFrame(workbox);
  // 배치·이름 복원
  await expect(frameAgain.locator(".tab-label")).toHaveCount(2, { timeout: 60_000 });
  await expect(frameAgain.locator(".tab-label").nth(1)).toHaveText("second tab");
  // 화면 내용 복원 — 리로드 전 출력이 다시 그려져 있다
  await frameAgain.locator(".tab-label").first().click();
  await expect(frameAgain.locator(".xterm-rows").first()).toContainText(
    "persist-marker-before-reload",
    { timeout: 30_000 },
  );
  // 크기 어긋난 재생으로 줄이 깨지지 않았다 — 에코·출력 두 줄 그대로다.
  await expect(
    frameAgain.locator(".xterm-rows").first().locator("> div", {
      hasText: "persist-marker-before-reload",
    }),
  ).toHaveCount(2);
  // 같은 셸이 살아 있다 — 이어서 입력이 된다
  await frameAgain.locator(".screen .xterm-screen").first().click();
  await workbox.keyboard.type("echo persist-marker-after-reload\r");
  await expect(frameAgain.locator(".xterm-rows").first()).toContainText(
    "persist-marker-after-reload",
    { timeout: 30_000 },
  );
  await workbox.screenshot({ path: path.join(shotDir, "persistence-after-reload.png") });
});

test("확장 업데이트로 버전이 어긋나면 이전 화면을 담은 종료 상태로 복원되고 warn 알림이 뜬다", async ({
  workbox,
}) => {
  // 실제 업데이트를 재현: 리로드 사이에 daemon 번들 내용을 바꿔 해시를 어긋나게 한다.
  const daemonPath = path.join(rootDir, "packages", "terminal", "dist", "daemon.cjs");
  const original = fs.readFileSync(daemonPath);
  try {
    const frame = await openTerminalPanel(workbox);
    await frame.locator(".screen .xterm-screen").click();
    await workbox.keyboard.type("echo update-marker-before\r");
    await expect(frame.locator(".xterm-rows")).toContainText("update-marker-before", {
      timeout: 30_000,
    });

    fs.writeFileSync(
      daemonPath,
      Buffer.concat([original, Buffer.from("\n// demo: version drift\n")]),
    );
    await runCommand(workbox, "Developer: Reload Window");
    await workbox.waitForTimeout(5000);
    await runCommand(workbox, "Simplysm Terminal");

    const frameAgain = webviewFrame(workbox);
    // 탭이 이전 화면을 담은 종료 상태로 돌아온다 — 새 셸 자동 시작은 없다
    await expect(frameAgain.locator(".screen-exit")).toContainText(
      "This session could not be restored after an extension update.",
      { timeout: 60_000 },
    );
    await expect(frameAgain.locator(".xterm-rows")).toContainText("update-marker-before");
    await expect(frameAgain.locator(".screen")).toHaveCount(1);
    // warn 알림 고지
    await expect(
      workbox.locator(".notification-toast", { hasText: "could not be restored" }),
    ).toBeVisible({ timeout: 30_000 });
    await workbox.screenshot({ path: path.join(shotDir, "persistence-update-drift.png") });
  } finally {
    fs.writeFileSync(daemonPath, original);
  }
});

/** 시연 VS Code(.vscode-test)가 띄운 daemon 을 강제 종료한다 — 크래시 재현. */
function killDemoDaemon(): void {
  execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%daemon.cjs%'\" | " +
        "Where-Object { $_.ExecutablePath -like '*.vscode-test*' } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    ],
    { windowsHide: true },
  );
}

test("daemon 이 죽으면 모든 세션이 종료 상태로 표시되고 자동 재기동은 없다", async ({
  workbox,
}) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("echo daemon-lost-marker\r");
  await expect(frame.locator(".xterm-rows")).toContainText("daemon-lost-marker", {
    timeout: 30_000,
  });

  killDemoDaemon();

  // 화면이 살아있는 척 멈춰 있으면 안 된다 — 종료 상태가 드러난다
  await expect(frame.locator(".screen-exit")).toContainText(
    "The terminal service ended unexpectedly",
    { timeout: 30_000 },
  );
  // 마지막 화면 내용은 남고, 새 세션이 저절로 생기지 않는다
  await expect(frame.locator(".xterm-rows")).toContainText("daemon-lost-marker");
  await workbox.waitForTimeout(3000);
  await expect(frame.locator(".screen")).toHaveCount(1);
  await workbox.screenshot({ path: path.join(shotDir, "persistence-daemon-lost.png") });
});

test("리로드 전 셸 안의 변수까지 살아 있다 — 프로세스가 같은 프로세스다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("$env:PERSIST_PROOF = 'alive-across-reload'\r");
  await expect(frame.locator(".xterm-rows")).toContainText("PERSIST_PROOF", { timeout: 30_000 });

  await runCommand(workbox, "Developer: Reload Window");
  await workbox.waitForTimeout(5000);
  await runCommand(workbox, "Simplysm Terminal");

  const frameAgain = webviewFrame(workbox);
  await expect(frameAgain.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  await frameAgain.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("echo \"proof=$env:PERSIST_PROOF\"\r");
  await expect(frameAgain.locator(".xterm-rows")).toContainText("proof=alive-across-reload", {
    timeout: 30_000,
  });
});
