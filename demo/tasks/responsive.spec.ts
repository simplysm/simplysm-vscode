// 폭 대응 검증 — 창을 실제로 좁혀(실사용자의 창/패널 축소 경로) 가로 스크롤이 생기지 않고
// 여러 줄 항목 높이가 다시 맞춰지는지 확인. 스크린샷은 직접 열람해 잘림 여부를 시각 판정.
import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, openTasksFile, runResultsDir, test, workspaceDir } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "responsive");
const demoFileName = "responsive.tasks";
const demoFilePath = path.join(workspaceDir, demoFileName);

const longText = "아주 긴 항목 텍스트입니다 ".repeat(6).trim();

test.beforeAll(() => {
  fs.mkdirSync(shotDir, { recursive: true });
});

test.beforeEach(() => {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    demoFilePath,
    `${JSON.stringify({ text: longText })}\n` +
      `${JSON.stringify({ group: "그룹 A" })}\n` +
      `${JSON.stringify({ text: longText })}\n`,
  );
});

test.afterEach(() => {
  fs.rmSync(demoFilePath, { force: true });
});

/** 창 폭 변경 — 실사용자의 창 축소와 같은 경로(webview 는 resize 이벤트를 받음). */
async function setWindowWidth(
  electronApp: ElectronApplication,
  workbox: Page,
  width: number,
): Promise<void> {
  const windowHandle = await electronApp.browserWindow(workbox);
  await windowHandle.evaluate((win, nextWidth) => {
    const bounds = win.getBounds();
    win.setBounds({ ...bounds, width: nextWidth });
  }, width);
}

test("창을 좁혀도 가로 스크롤 없음 + 여러 줄 항목 높이 재계산", async ({
  electronApp,
  workbox,
}) => {
  const frame = await openTasksFile(workbox, demoFileName);
  const firstInput = frame.locator(".task-item .task-input").first();
  await firstInput.waitFor({ state: "visible", timeout: 30_000 });

  const wideHeight = await firstInput.evaluate((el) => el.clientHeight);
  await frame.locator("body").screenshot({ path: path.join(shotDir, "wide.png") });

  await setWindowWidth(electronApp, workbox, 640);

  // 가로 스크롤 없음 — flex 자식 최소폭 해제 확인
  await expect
    .poll(
      async () =>
        await frame
          .locator("body")
          .evaluate((el) => el.scrollWidth - el.clientWidth <= 1 && el.clientWidth > 0),
      { timeout: 15_000 },
    )
    .toBe(true);

  // 폭이 좁아져 줄 수가 늘었으므로 입력칸이 더 높아져야 함 (잘리면 높이가 그대로)
  await expect
    .poll(async () => await firstInput.evaluate((el) => el.clientHeight), { timeout: 15_000 })
    .toBeGreaterThan(wideHeight);

  // 잘림·겹침은 수치로 안 잡히므로 스크린샷 직접 열람으로 판정
  await frame.locator("body").screenshot({ path: path.join(shotDir, "narrow.png") });
});
