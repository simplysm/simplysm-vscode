// README 미디어 캡처 전용 — 평소 `pnpm demo` 에선 skip, README_MEDIA=1 일 때만 실행.
// 프레임을 만들고 scripts/build-readme-gif.py 로 GIF 합성. 판정용 시연이 아니므로
// 단언은 장면 전환 확인 수준만 둔다.
import fs from "node:fs";
import path from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect, openTasksFile, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import {
  clickWithCursor,
  dragWithCursor,
  installCursor,
  resetCursor,
  sleep,
  startRecorder,
} from "../readme-media-utils.ts";

test.skip(process.env["README_MEDIA"] !== "1", "README 미디어 캡처 전용 (README_MEDIA=1)");

const demoFileName = "readme-demo.tasks";
const demoFilePath = path.join(workspaceDir, demoFileName);

test.afterEach(() => {
  fs.rmSync(demoFilePath, { force: true });
});

/** 대상 기준 드롭 지점 계산 — before = 위 가장자리, center = 중앙. */
async function dropPointOf(
  target: Locator,
  position: "before" | "center",
): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (box == null) throw new Error("drag target has no bounding box");
  return {
    x: box.x + box.width / 2,
    y: position === "before" ? box.y + 2 : box.y + box.height / 2,
  };
}

async function setupScene(
  workbox: Page,
  seedContent: string,
): Promise<{ frame: FrameLocator; clip: { x: number; y: number; width: number; height: number } }> {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(demoFilePath, seedContent);
  const frame = await openTasksFile(workbox, demoFileName);
  await frame.locator("#tasks-root").waitFor({ state: "visible", timeout: 30_000 });

  // 주의: 여기서 창 리사이즈(setBounds) 금지 — 리사이즈하면 webview 내부로의 마우스 입력이
  // 죽는 현상 확인됨(클릭 포커스·드래그 무반응). 세로 여백은 GIF 합성 시 상단 크롭으로 해결.
  await installCursor(workbox);
  const webviewBox = await workbox.locator("iframe.webview.ready").first().boundingBox();
  if (webviewBox == null) throw new Error("webview has no bounding box");

  // 파일 열기(트리 클릭)의 호버 툴팁이 남아 첫 프레임을 가리는 것 방지 — 중립 위치로 옮기고 정착 대기
  await resetCursor(workbox, {
    x: webviewBox.x + webviewBox.width / 2,
    y: webviewBox.y + webviewBox.height - 20,
  });
  await sleep(1_200);
  return { frame, clip: webviewBox };
}

test("GIF ① 입력·완료 — 연속 입력, 지우개 삭제, undo 복원", async ({ workbox }) => {
  const { frame, clip } = await setupScene(workbox, "");
  const framesDir = path.join(runResultsDir, "readme-media", "quick-entry");
  const recorder = startRecorder(workbox, clip, framesDir);
  try {
    // 연속 입력 — 고스트 행 클릭 후 Enter 로 이어서 추가
    const ghost = frame.locator(".task-ghost .task-input").first();
    await clickWithCursor(workbox, ghost);
    await expect(ghost).toBeFocused();
    await sleep(300);
    for (const text of ["Ship the release", "Write the changelog", "Fix login redirect"]) {
      await workbox.keyboard.type(text, { delay: 55 });
      await sleep(200);
      await workbox.keyboard.press("Enter");
      await sleep(250);
    }
    await expect(frame.locator(".task-item")).toHaveCount(3);
    await sleep(500);

    // 지우개 = 완료(삭제)
    await clickWithCursor(workbox, frame.locator(".task-item .task-erase").first());
    await expect(frame.locator(".task-item")).toHaveCount(2);
    await sleep(800);

    // undo 복원 — pristine 행 입력칸에서 Ctrl+Z (키 유실 대비, 성공 즉시 탈출)
    const firstInput = frame.locator(".task-item .task-input").first();
    await clickWithCursor(workbox, firstInput);
    await expect(firstInput).toBeFocused();
    await sleep(300);
    for (let attempt = 0; attempt < 3; attempt++) {
      await workbox.keyboard.press("Control+z");
      try {
        await expect(frame.locator(".task-item")).toHaveCount(3, { timeout: 4_000 });
        break;
      } catch {
        // 키 유실 — 한 번 더
      }
    }
    await expect(frame.locator(".task-item")).toHaveCount(3);
    await sleep(1_200);
  } finally {
    await recorder.stop();
  }
});

test("GIF ② 정렬·그룹 — 항목 드래그, 그룹으로 이동, 그룹 통째 이동", async ({ workbox }) => {
  const { frame, clip } = await setupScene(
    workbox,
    '{"text":"Ship the release"}\n' +
      '{"text":"Write the changelog"}\n' +
      '{"group":"Backlog"}\n' +
      '{"text":"Refactor settings page"}\n' +
      '{"group":"Ideas"}\n' +
      '{"text":"Dark mode"}\n',
  );
  const framesDir = path.join(runResultsDir, "readme-media", "ordering-groups");
  const recorder = startRecorder(workbox, clip, framesDir);
  try {
    const ungrouped = frame.locator(".task-group").first();
    await sleep(700);

    // 항목 드래그 — 둘째를 첫째 앞으로
    await dragWithCursor(
      workbox,
      ungrouped.locator(".task-item").nth(1).locator(".task-handle"),
      await dropPointOf(ungrouped.locator(".task-item").first(), "before"),
    );
    await expect(ungrouped.locator(".task-item .task-input").first()).toHaveValue(
      "Write the changelog",
    );
    await sleep(800);

    // 항목을 그룹 헤더에 드롭 — 그 그룹 끝으로 이동
    await dragWithCursor(
      workbox,
      ungrouped.locator(".task-item").nth(1).locator(".task-handle"),
      await dropPointOf(frame.locator(".task-group").nth(1).locator(".group-header"), "center"),
    );
    await expect(frame.locator(".task-group").nth(1).locator(".task-item")).toHaveCount(2);
    await sleep(800);

    // 그룹 통째 드래그 — Ideas 를 Backlog 앞으로
    await dragWithCursor(
      workbox,
      frame.locator(".task-group").nth(2).locator(".group-header .task-handle"),
      await dropPointOf(frame.locator(".task-group").nth(1), "before"),
    );
    await expect(frame.locator(".group-name").first()).toHaveValue("Ideas");
    await sleep(1_200);
  } finally {
    await recorder.stop();
  }
});
