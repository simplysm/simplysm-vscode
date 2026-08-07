// 레이아웃 조작 시연 — tab 을 끌어 4방향으로 pane 을 가르고, 경계로 크기를 조절하고,
// 우클릭 메뉴로 이름을 바꾸거나 자리를 닫는 흐름을 확인한다.
import path from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect, launchVsCode, rootDir, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");
const multiRootFile = path.join(rootDir, "demo", "workspace", "multi-root", "demo.code-workspace");

async function openTerminalPanel(workbox: Page): Promise<FrameLocator> {
  await runCommand(workbox, "Simplysm Terminal");
  const frame = webviewFrame(workbox);
  await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  return frame;
}

/** + 를 눌러 그 pane 에 자리를 하나 더 만든다. 세션이 붙어 이름이 보일 때까지 기다린다. */
async function addTab(frame: FrameLocator, paneIndex = 0): Promise<void> {
  const before = await frame.locator(".tab-label").count();
  await frame.locator(".pane").nth(paneIndex).locator(".tab-add").click();
  await expect(frame.locator(".tab-label")).toHaveCount(before + 1, { timeout: 60_000 });
  await expect(frame.locator(".screen .xterm-screen")).toHaveCount(before + 1, {
    timeout: 60_000,
  });
}

/** tab 을 대상 요소의 한 지점으로 끈다. 마지막 지점에서 멈춘 채 놓지 않는 것도 고를 수 있다. */
async function dragTab(
  workbox: Page,
  source: Locator,
  target: Locator,
  spot: { xRatio: number; yRatio: number },
  options: { drop: boolean } = { drop: true },
): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (sourceBox == null || targetBox == null) throw new Error("드래그 대상의 위치를 못 잡았습니다");
  await workbox.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await workbox.mouse.down();
  const dropX = targetBox.x + targetBox.width * spot.xRatio;
  const dropY = targetBox.y + targetBox.height * spot.yRatio;
  await workbox.mouse.move(dropX, dropY, { steps: 12 });
  await workbox.mouse.move(dropX, dropY);
  if (options.drop) await workbox.mouse.up();
}

test("tab 을 아래로 끌면 위아래로 갈라지고, 옆으로 끌면 좌우로 갈라진다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await addTab(frame);

  // 두 번째 tab 을 pane 아래쪽으로 끌어 위아래 분할
  await dragTab(workbox, frame.locator(".tab-label").nth(1), frame.locator(".pane").first(), {
    xRatio: 0.5,
    yRatio: 0.9,
  });
  await expect(frame.locator(".split.vertical")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame.locator(".pane")).toHaveCount(2);

  // 아래 pane 에 자리를 더해 왼쪽으로 끌면 그 안이 좌우로 갈라진다
  await addTab(frame, 1);
  await dragTab(workbox, frame.locator(".pane").nth(1).locator(".tab-label").nth(1), frame.locator(".pane").nth(1), {
    xRatio: 0.05,
    yRatio: 0.5,
  });
  await expect(frame.locator(".split.horizontal")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame.locator(".pane")).toHaveCount(3);
  await workbox.screenshot({ path: path.join(shotDir, "layout-4way.png") });
});

test("tab 을 다른 pane 가운데로 끌면 그 pane 의 tab 으로 합류하고 빈 pane 은 사라진다", async ({
  workbox,
}) => {
  const frame = await openTerminalPanel(workbox);
  await addTab(frame);
  await dragTab(workbox, frame.locator(".tab-label").nth(1), frame.locator(".pane").first(), {
    xRatio: 0.5,
    yRatio: 0.9,
  });
  await expect(frame.locator(".pane")).toHaveCount(2, { timeout: 15_000 });

  // 아래 pane 의 유일한 tab 을 위 pane 가운데로 되돌리면 아래 pane 이 사라진다
  await dragTab(workbox, frame.locator(".pane").nth(1).locator(".tab-label").first(), frame.locator(".pane").first(), {
    xRatio: 0.5,
    yRatio: 0.5,
  });
  await expect(frame.locator(".pane")).toHaveCount(1, { timeout: 15_000 });
  await expect(frame.locator(".pane").first().locator(".tab-label")).toHaveCount(2);
});

test("끄는 동안 놓을 자리가 보이고, 결과가 같아지는 자리는 보이지 않는다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await addTab(frame);

  // 다른 자리로 옮겨지는 구역은 미리 보기가 뜬다
  await dragTab(
    workbox,
    frame.locator(".tab-label").nth(1),
    frame.locator(".pane").first(),
    { xRatio: 0.5, yRatio: 0.9 },
    { drop: false },
  );
  await expect(frame.locator(".drop-preview.bottom")).toBeVisible({ timeout: 15_000 });
  await workbox.screenshot({ path: path.join(shotDir, "layout-drop-preview.png") });

  // 자기 pane 의 가운데는 놓아도 그대로라 미리 보기가 없다
  const paneBox = await frame.locator(".pane").first().boundingBox();
  if (paneBox == null) throw new Error("pane 위치를 못 잡았습니다");
  await workbox.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
  await expect(frame.locator(".drop-preview:visible")).toHaveCount(0);
  await workbox.mouse.up();
  await expect(frame.locator(".pane")).toHaveCount(1);
  await expect(frame.locator(".tab-label")).toHaveCount(2);
});

test("드래그 도중 Esc 를 누르면 배치가 그대로다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await addTab(frame);

  await dragTab(
    workbox,
    frame.locator(".tab-label").nth(1),
    frame.locator(".pane").first(),
    { xRatio: 0.5, yRatio: 0.9 },
    { drop: false },
  );
  await workbox.keyboard.press("Escape");
  await workbox.mouse.up();

  await expect(frame.locator(".pane")).toHaveCount(1);
  await expect(frame.locator(".split")).toHaveCount(0);
});

test("tab 을 누르면 활성만 바뀌고 화면이 그 자리로 전환된다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await frame.locator(".screen .xterm-screen").first().click();
  await workbox.keyboard.type("echo first-tab-mark\r");
  await expect(frame.locator(".xterm-rows").first()).toContainText("first-tab-mark", {
    timeout: 30_000,
  });

  await addTab(frame);
  await expect(frame.locator(".tab-label").nth(1)).toHaveClass(/active/);
  await expect(frame.locator(".pane")).toHaveCount(1);

  await frame.locator(".tab-label").first().click();
  await expect(frame.locator(".tab-label").first()).toHaveClass(/active/);
  await expect(frame.locator(".tab").first()).toBeVisible();
  await expect(frame.locator(".tab").nth(1)).toBeHidden();
});

test("pane 경계를 끌면 맞닿은 두 pane 의 크기가 함께 바뀐다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await addTab(frame);
  await dragTab(workbox, frame.locator(".tab-label").nth(1), frame.locator(".pane").first(), {
    xRatio: 0.5,
    yRatio: 0.9,
  });
  await expect(frame.locator(".pane")).toHaveCount(2, { timeout: 15_000 });

  const firstBefore = await frame.locator(".pane").first().boundingBox();
  const divider = frame.locator(".divider").first();
  const dividerBox = await divider.boundingBox();
  if (firstBefore == null || dividerBox == null) throw new Error("경계 위치를 못 잡았습니다");

  await workbox.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
  await workbox.mouse.down();
  await workbox.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y - 40, { steps: 8 });
  await workbox.mouse.up();

  const firstAfter = await frame.locator(".pane").first().boundingBox();
  if (firstAfter == null) throw new Error("pane 위치를 못 잡았습니다");
  expect(firstAfter.height).toBeLessThan(firstBefore.height);
  await workbox.screenshot({ path: path.join(shotDir, "layout-divider.png") });
});

test("경계를 화면 끝까지 밀어도 배치가 유지되고 pane 이 사라지지 않는다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await addTab(frame);
  await dragTab(workbox, frame.locator(".tab-label").nth(1), frame.locator(".pane").first(), {
    xRatio: 0.5,
    yRatio: 0.9,
  });
  await expect(frame.locator(".pane")).toHaveCount(2, { timeout: 15_000 });

  const divider = frame.locator(".divider").first();
  const dividerBox = await divider.boundingBox();
  const panelBox = await frame.locator("#screens").boundingBox();
  if (dividerBox == null || panelBox == null) throw new Error("경계 위치를 못 잡았습니다");

  const firstBefore = await frame.locator(".pane").first().boundingBox();
  if (firstBefore == null) throw new Error("pane 위치를 못 잡았습니다");

  // panel 맨 위보다 더 위로 밀어도 배치가 깨지지 않고, 위 pane 은 아주 작아진 채 남는다
  await workbox.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y);
  await workbox.mouse.down();
  await workbox.mouse.move(dividerBox.x + dividerBox.width / 2, panelBox.y - 200, { steps: 10 });
  await workbox.mouse.up();

  const firstAfter = await frame.locator(".pane").first().boundingBox();
  if (firstAfter == null) throw new Error("pane 위치를 못 잡았습니다");
  expect(firstAfter.height).toBeLessThan(firstBefore.height);
  await expect(frame.locator(".pane")).toHaveCount(2);
});

test("배치가 바뀌면 셸이 아는 열 수가 새 크기로 바뀐다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  const readWidths = async (paneIndex: number): Promise<number[]> => {
    const text =
      (await frame.locator(".pane").nth(paneIndex).locator(".xterm-rows").first().textContent()) ??
      "";
    return [...text.matchAll(/W=(\d+)/g)].map((match) => Number(match[1]));
  };

  await frame.locator(".screen .xterm-screen").first().click();
  await workbox.keyboard.type('Write-Output "W=$($Host.UI.RawUI.WindowSize.Width)"\r');
  await expect(frame.locator(".xterm-rows").first()).toContainText("W=", { timeout: 30_000 });
  const [beforeWidth] = await readWidths(0);

  // 새 자리를 왼쪽으로 끌면 원래 자리는 오른쪽 pane 으로 좁아진다
  await addTab(frame);
  await dragTab(workbox, frame.locator(".tab-label").nth(1), frame.locator(".pane").first(), {
    xRatio: 0.05,
    yRatio: 0.5,
  });
  await expect(frame.locator(".pane")).toHaveCount(2, { timeout: 15_000 });

  await frame.locator(".pane").nth(1).locator(".xterm-screen").click();
  await workbox.keyboard.type('Write-Output "W=$($Host.UI.RawUI.WindowSize.Width)"\r');
  await expect(async () => {
    const widths = await readWidths(1);
    expect(widths.at(-1)).toBeLessThan(beforeWidth!);
  }).toPass({ timeout: 30_000 });
});

test("panel 크기가 바뀌어도 분할 비율이 유지된다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await addTab(frame);
  await dragTab(workbox, frame.locator(".tab-label").nth(1), frame.locator(".pane").first(), {
    xRatio: 0.5,
    yRatio: 0.9,
  });
  await expect(frame.locator(".pane")).toHaveCount(2, { timeout: 15_000 });

  const ratioNow = async (): Promise<number> => {
    const first = await frame.locator(".pane").first().boundingBox();
    const second = await frame.locator(".pane").nth(1).boundingBox();
    if (first == null || second == null) throw new Error("pane 위치를 못 잡았습니다");
    return first.height / (first.height + second.height);
  };
  const before = await ratioNow();

  await runCommand(workbox, "View: Toggle Maximized Panel");
  await expect(async () => {
    expect(await ratioNow()).toBeCloseTo(before, 1);
  }).toPass({ timeout: 15_000 });
  await workbox.screenshot({ path: path.join(shotDir, "layout-panel-resized.png") });
});

test("panel 밖에 놓으면 tab 이 원래 자리에 그대로 남는다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await addTab(frame);

  const editorArea = workbox.locator("#workbench\\.parts\\.editor");
  // 에디터 위를 지나 panel 로 돌아왔다가 다시 나가 놓는다 — 오가는 동안 상태가 어긋나면 안 된다
  await dragTab(
    workbox,
    frame.locator(".tab-label").nth(1),
    frame.locator(".pane").first(),
    { xRatio: 0.5, yRatio: 0.9 },
    { drop: false },
  );
  const editorBox = await editorArea.boundingBox();
  if (editorBox == null) throw new Error("에디터 위치를 못 잡았습니다");
  await workbox.mouse.move(editorBox.x + editorBox.width / 2, editorBox.y + editorBox.height / 2, {
    steps: 10,
  });
  await workbox.mouse.up();

  await expect(frame.locator(".pane")).toHaveCount(1);
  await expect(frame.locator(".tab-label")).toHaveCount(2);
});

test("드래그 도중 그 세션이 끝나면 드래그만 취소되고 배치는 그대로다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await addTab(frame);

  // 두 번째 자리에서 잠시 뒤 스스로 끝나게 해 두고, 그 tab 을 끄는 도중에 끝나게 한다
  await frame.locator(".pane").first().locator(".xterm-screen").nth(1).click();
  await workbox.keyboard.type("timeout /t 3 > nul & exit\r");
  await dragTab(
    workbox,
    frame.locator(".tab-label").nth(1),
    frame.locator(".pane").first(),
    { xRatio: 0.5, yRatio: 0.9 },
    { drop: false },
  );
  await expect(frame.locator(".tab-label")).toHaveCount(1, { timeout: 30_000 });
  await workbox.mouse.up();

  await expect(frame.locator(".pane")).toHaveCount(1);
  await expect(frame.locator(".split")).toHaveCount(0);
});

test("시작 폴더를 고르는 중인 tab 도 끌어 놓을 수 있다", async ({ vscodeExePath }, testInfo) => {
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

    // 첫 자리는 폴더를 골라 세션을 붙이고, 두 번째 자리는 고르는 중으로 남긴다
    await expect(frame.locator(".start-option")).toHaveCount(2, { timeout: 60_000 });
    await frame.locator(".start-option").first().click();
    await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });

    await frame.locator(".tab-add").click();
    await expect(frame.locator(".tab-label")).toHaveCount(2);
    await expect(frame.locator(".start-option")).toHaveCount(2);

    await dragTab(workbox, frame.locator(".tab-label").nth(1), frame.locator(".pane").first(), {
      xRatio: 0.5,
      yRatio: 0.9,
    });
    await expect(frame.locator(".pane")).toHaveCount(2, { timeout: 15_000 });
    // 고르는 중이던 자리가 아래 pane 으로 옮겨 가 후보를 그대로 보인다
    await expect(frame.locator(".pane").nth(1).locator(".start-option")).toHaveCount(2);
    await workbox.screenshot({ path: path.join(shotDir, "layout-start-tab-moved.png") });
  } finally {
    await app.close();
  }
});

test("tab 우클릭 메뉴로 자리를 닫는다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  await addTab(frame);

  await frame.locator(".tab-label").first().click({ button: "right" });
  await expect(frame.locator(".tab-menu")).toBeVisible();
  // 활성은 우클릭으로 바뀌지 않는다
  await expect(frame.locator(".tab-label").nth(1)).toHaveClass(/active/);
  await workbox.screenshot({ path: path.join(shotDir, "layout-tab-menu.png") });

  await frame.locator(".tab-menu-item", { hasText: "Close tab" }).click();
  await expect(frame.locator(".tab-label")).toHaveCount(1, { timeout: 15_000 });
});
