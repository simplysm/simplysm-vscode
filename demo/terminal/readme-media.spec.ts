// terminal README 미디어 캡처 전용 — README_MEDIA=1 일 때만 실행 (tasks 쪽과 동일 방식).
// GIF: 그리드 분할 — tab 드래그로 좌우/상하 분할(드롭 미리보기), 경계 드래그로 크기 조절.
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, runCommand, runResultsDir, test, webviewFrame } from "../fixtures.ts";
import {
  clickWithCursor,
  dragWithCursor,
  installCursor,
  resetCursor,
  sleep,
  startRecorder,
} from "../readme-media-utils.ts";

test.skip(process.env["README_MEDIA"] !== "1", "README 미디어 캡처 전용 (README_MEDIA=1)");

async function openTerminalPanel(workbox: Page): Promise<FrameLocator> {
  await runCommand(workbox, "Simplysm Terminal");
  const frame = webviewFrame(workbox);
  await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  return frame;
}

/** + 클릭으로 자리 추가 — 세션이 붙을 때까지 대기. */
async function addTabWithCursor(
  workbox: Page,
  frame: FrameLocator,
  paneIndex: number,
): Promise<void> {
  const before = await frame.locator(".tab-label").count();
  await clickWithCursor(workbox, frame.locator(".pane").nth(paneIndex).locator(".tab-add"));
  await expect(frame.locator(".tab-label")).toHaveCount(before + 1, { timeout: 60_000 });
  await expect(frame.locator(".screen .xterm-screen")).toHaveCount(before + 1, {
    timeout: 60_000,
  });
}

/** 대상 pane 안 비율 지점의 절대 좌표. */
async function spotIn(
  frame: FrameLocator,
  paneIndex: number,
  xRatio: number,
  yRatio: number,
): Promise<{ x: number; y: number }> {
  const box = await frame.locator(".pane").nth(paneIndex).boundingBox();
  if (box == null) throw new Error("pane has no bounding box");
  return { x: box.x + box.width * xRatio, y: box.y + box.height * yRatio };
}

test("GIF 그리드 분할 — tab 드래그 분할, 경계 크기 조절", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  // panel 을 최대화해 그리드가 잘 보이게
  await runCommand(workbox, "Toggle Maximized Panel");
  await sleep(800);

  await installCursor(workbox);
  const webviewBox = await workbox.locator("iframe.webview.ready").first().boundingBox();
  if (webviewBox == null) throw new Error("webview has no bounding box");
  await resetCursor(workbox, {
    x: webviewBox.x + webviewBox.width / 2,
    y: webviewBox.y + webviewBox.height - 30,
  });
  await sleep(1_000);

  const framesDir = path.join(runResultsDir, "readme-media", "terminal-grid");
  const recorder = startRecorder(workbox, clipOf(webviewBox), framesDir);
  try {
    // 두 번째 자리 추가 → 오른쪽 가장자리로 끌어 좌우 분할
    await addTabWithCursor(workbox, frame, 0);
    await sleep(600);
    await dragWithCursor(
      workbox,
      frame.locator(".tab-label").nth(1),
      await spotIn(frame, 0, 0.95, 0.5),
    );
    await expect(frame.locator(".pane")).toHaveCount(2, { timeout: 15_000 });
    await sleep(900);

    // 왼쪽 pane 에 자리 추가 → 아래로 끌어 상하 분할
    await addTabWithCursor(workbox, frame, 0);
    await sleep(600);
    await dragWithCursor(
      workbox,
      frame.locator(".pane").first().locator(".tab-label").nth(1),
      await spotIn(frame, 0, 0.5, 0.85),
    );
    await expect(frame.locator(".pane")).toHaveCount(3, { timeout: 15_000 });
    await sleep(900);

    // 경계 드래그로 크기 조절
    const divider = frame.locator(".divider").first();
    const dividerBox = await divider.boundingBox();
    if (dividerBox == null) throw new Error("divider has no bounding box");
    await dragWithCursor(workbox, divider, {
      x: dividerBox.x + dividerBox.width / 2,
      y: dividerBox.y - 60,
    });
    await sleep(1_500);
  } finally {
    await recorder.stop();
  }
});

function clipOf(box: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}
