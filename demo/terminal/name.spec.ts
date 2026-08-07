// 세션 이름 시연 — 지정 전에는 셸 이름이 보이고, 우클릭 메뉴에서 붙인 이름이 그 자리를 대신한다.
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, launchVsCode, rootDir, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");
const multiRootFile = path.join(rootDir, "demo", "workspace", "multi-root", "demo.code-workspace");

async function openTerminalPanel(workbox: Page): Promise<FrameLocator> {
  await runCommand(workbox, "Simplysm Terminal");
  const frame = webviewFrame(workbox);
  await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  return frame;
}

/** 우클릭 메뉴에서 이름 바꾸기를 골라 값을 확정한다. */
async function renameTab(frame: FrameLocator, tabIndex: number, value: string): Promise<void> {
  await frame.locator(".tab-label").nth(tabIndex).click({ button: "right" });
  await frame.locator(".tab-menu-item", { hasText: "Rename…" }).click();
  const input = frame.locator(".tab-rename-input");
  await expect(input).toBeVisible();
  await input.fill(value);
  await input.press("Enter");
}

test("이름을 지정하기 전 tab 에 셸 이름이 보인다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await expect(frame.locator(".tab-label").first()).toHaveText("pwsh");
});

test("이름을 지정하면 그 이름이 보이고, 비우고 확정하면 셸 이름으로 돌아간다", async ({
  workbox,
}) => {
  const frame = await openTerminalPanel(workbox);

  await renameTab(frame, 0, "build watch");
  await expect(frame.locator(".tab-label").first()).toHaveText("build watch");
  await expect(frame.locator(".tab-label").first()).toHaveAttribute("title", "build watch");
  await workbox.screenshot({ path: path.join(shotDir, "name-assigned.png") });

  await renameTab(frame, 0, "   ");
  await expect(frame.locator(".tab-label").first()).toHaveText("pwsh");
});

test("이름 바꾸기를 Esc 로 그만두면 이름이 그대로다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await renameTab(frame, 0, "server");
  await expect(frame.locator(".tab-label").first()).toHaveText("server");

  await frame.locator(".tab-label").first().click({ button: "right" });
  await frame.locator(".tab-menu-item", { hasText: "Rename…" }).click();
  const input = frame.locator(".tab-rename-input");
  await input.fill("throw away");
  await input.press("Escape");

  await expect(input).toHaveCount(0);
  await expect(frame.locator(".tab-label").first()).toHaveText("server");
});

test("같은 이름을 여러 자리에 붙일 수 있고, 긴 이름은 잘려 보이되 툴팁에 전체가 남는다", async ({
  workbox,
}) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".tab-add").click();
  await expect(frame.locator(".screen .xterm-screen")).toHaveCount(2, { timeout: 60_000 });

  await renameTab(frame, 0, "same name");
  await renameTab(frame, 1, "same name");
  await expect(frame.locator(".tab-label").first()).toHaveText("same name");
  await expect(frame.locator(".tab-label").nth(1)).toHaveText("same name");

  const longName = "aggregate integration watcher for the whole workspace tree";
  await renameTab(frame, 1, longName);
  await expect(frame.locator(".tab-label").nth(1)).toHaveAttribute("title", longName);
  const labelBox = await frame.locator(".tab-label").nth(1).boundingBox();
  const barBox = await frame.locator(".tab-bar").first().boundingBox();
  if (labelBox == null || barBox == null) throw new Error("tab 줄 위치를 못 잡았습니다");
  expect(labelBox.width).toBeLessThan(barBox.width);
  await workbox.screenshot({ path: path.join(shotDir, "name-truncated.png") });
});

test("이름 바꾸기 도중 세션이 끝나면 입력창이 닫히고 종료 표시로 넘어간다", async ({
  workbox,
}) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").click();
  await workbox.keyboard.type("timeout /t 3 > nul & exit 3\r");

  await frame.locator(".tab-label").first().click({ button: "right" });
  await frame.locator(".tab-menu-item", { hasText: "Rename…" }).click();
  await expect(frame.locator(".tab-rename-input")).toBeVisible();

  await expect(frame.locator(".tab-rename-input")).toHaveCount(0, { timeout: 30_000 });
  await expect(frame.locator(".screen-exit")).toContainText("exited with code 3");
});

test("세션이 붙기 전 자리에도 이름을 붙일 수 있고 세션이 붙어도 유지된다", async ({
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
    await expect(frame.locator(".start-option")).toHaveCount(2, { timeout: 60_000 });

    await renameTab(frame, 0, "planned");
    await expect(frame.locator(".tab-label").first()).toHaveText("planned");

    await frame.locator(".start-option").first().click();
    await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
    await expect(frame.locator(".tab-label").first()).toHaveText("planned");
  } finally {
    await app.close();
  }
});

test("세션이 붙기 전 자리에는 폴더를 고르는 중임이 이름 자리에 보인다", async ({
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

    await expect(frame.locator(".start-option")).toHaveCount(2, { timeout: 60_000 });
    await expect(frame.locator(".tab-label").first()).toHaveText("Choosing a folder…");
    await workbox.screenshot({ path: path.join(shotDir, "name-choosing-folder.png") });

    // 세션이 붙으면 그 자리 이름이 셸 이름으로 바뀐다
    await frame.locator(".start-option").first().click();
    await expect(frame.locator(".tab-label").first()).toHaveText("pwsh", { timeout: 60_000 });
  } finally {
    await app.close();
  }
});
