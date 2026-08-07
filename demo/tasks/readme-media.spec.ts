// README 미디어 캡처 전용 — 평소 `pnpm demo` 에선 skip, README_MEDIA=1 일 때만 실행.
// 가짜 커서 오버레이 + 주기 스크린샷으로 프레임을 만들고, scripts/build-readme-gif.py 로 GIF 합성.
// 판정용 시연이 아니므로 단언은 장면 전환 확인 수준만 둔다.
import fs from "node:fs";
import path from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect, openTasksFile, runResultsDir, test, workspaceDir } from "../fixtures.ts";

test.skip(process.env["README_MEDIA"] !== "1", "README 미디어 캡처 전용 (README_MEDIA=1)");

const demoFileName = "readme-demo.tasks";
const demoFilePath = path.join(workspaceDir, demoFileName);

test.afterEach(() => {
  fs.rmSync(demoFilePath, { force: true });
});

/** 가짜 커서 — OS 커서는 스크린샷에 안 찍히므로 최상위 문서에 오버레이를 만들어 따라붙인다. */
async function installCursor(workbox: Page): Promise<void> {
  await workbox.evaluate(() => {
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.style.cssText =
      "position:fixed;left:0;top:0;width:20px;height:26px;z-index:2147483647;" +
      "pointer-events:none;display:none;background-repeat:no-repeat;background-size:contain;" +
      // 흰 테두리 + 검정 몸통 화살표 (밝은/어두운 배경 모두에서 보임)
      `background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 26"><path d="M2 1 L2 20 L7 16 L10 24 L13 22.5 L10 15 L16 15 Z" fill="black" stroke="white" stroke-width="1.6"/></svg>')`;
    document.body.appendChild(cursor);
  });
}

async function setCursor(workbox: Page, x: number, y: number): Promise<void> {
  await workbox.evaluate(
    ([cursorX, cursorY]) => {
      const cursor = document.getElementById("demo-cursor")!;
      cursor.style.display = "block";
      cursor.style.left = `${cursorX}px`;
      cursor.style.top = `${cursorY}px`;
    },
    [x, y],
  );
}

/** 실제 마우스와 오버레이를 함께 움직인다 — steps 를 쪼개 GIF 프레임에 이동 경로가 남게. */
async function moveWithCursor(
  workbox: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  stepDelayMs = 25,
): Promise<void> {
  for (let step = 1; step <= steps; step++) {
    const x = from.x + ((to.x - from.x) * step) / steps;
    const y = from.y + ((to.y - from.y) * step) / steps;
    await workbox.mouse.move(x, y);
    await setCursor(workbox, x, y);
    await sleep(stepDelayMs);
  }
}

async function centerOf(target: Locator): Promise<{ x: number; y: number }> {
  await target.waitFor({ state: "visible", timeout: 30_000 });
  const box = await target.boundingBox();
  if (box == null) throw new Error("target has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastCursorPos = { x: 0, y: 0 };

async function glideTo(workbox: Page, target: Locator, offsetY = 0): Promise<{ x: number; y: number }> {
  const to = await centerOf(target);
  to.y += offsetY;
  await moveWithCursor(workbox, lastCursorPos, to, 12);
  lastCursorPos = to;
  return to;
}

async function clickWithCursor(workbox: Page, target: Locator): Promise<void> {
  await glideTo(workbox, target);
  await sleep(150);
  // locator 클릭 — 히트타겟 검증 포함 (가림·좌표 어긋남을 오류로 표면화)
  await target.click({ timeout: 5_000 });
}

async function dragWithCursor(
  workbox: Page,
  source: Locator,
  target: Locator,
  position: "before" | "center",
): Promise<void> {
  await glideTo(workbox, source);
  await sleep(200);
  await workbox.mouse.down();
  await sleep(200);
  const targetBox = await target.boundingBox();
  if (targetBox == null) throw new Error("drag target has no bounding box");
  const to = {
    x: targetBox.x + targetBox.width / 2,
    y: position === "before" ? targetBox.y + 2 : targetBox.y + targetBox.height / 2,
  };
  await moveWithCursor(workbox, lastCursorPos, to, 18);
  lastCursorPos = to;
  await sleep(250);
  await workbox.mouse.up();
}

/** 주기 스크린샷 녹화 — 프레임 파일명 = 캡처 시각(ms). 합성 스크립트가 실제 간격을 duration 으로 쓴다. */
function startRecorder(
  workbox: Page,
  clip: { x: number; y: number; width: number; height: number },
  framesDir: string,
): { stop(): Promise<void> } {
  fs.mkdirSync(framesDir, { recursive: true });
  let active = true;
  const loop = (async () => {
    while (active) {
      const startedAt = Date.now();
      await workbox.screenshot({ clip, path: path.join(framesDir, `${startedAt}.png`) });
      const elapsed = Date.now() - startedAt;
      if (elapsed < 100) await sleep(100 - elapsed);
    }
  })();
  return {
    stop: async () => {
      active = false;
      await loop;
    },
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
  console.log(`webview clip: ${JSON.stringify(webviewBox)}`);

  // 파일 열기(트리 클릭)의 호버 툴팁이 남아 첫 프레임을 가리는 것 방지 — 중립 위치로 옮기고 정착 대기
  const neutral = { x: webviewBox.x + webviewBox.width / 2, y: webviewBox.y + webviewBox.height - 20 };
  await workbox.mouse.move(neutral.x, neutral.y);
  lastCursorPos = neutral;
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

    // undo 복원 — pristine 행 입력칸에서 Ctrl+Z (키 유실 대비 도달까지 재시도, group.spec 과 동일)
    const firstInput = frame.locator(".task-item .task-input").first();
    await clickWithCursor(workbox, firstInput);
    await expect(firstInput).toBeFocused();
    await sleep(300);
    // 성공 즉시 탈출 — 대기가 짧으면 반영 전에 추가 press 가 들어가 연쇄 undo 가 된다
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
    await sleep(1200);
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
      ungrouped.locator(".task-item").first(),
      "before",
    );
    await expect(ungrouped.locator(".task-item .task-input").first()).toHaveValue(
      "Write the changelog",
    );
    await sleep(800);

    // 항목을 그룹 헤더에 드롭 — 그 그룹 끝으로 이동
    await dragWithCursor(
      workbox,
      ungrouped.locator(".task-item").nth(1).locator(".task-handle"),
      frame.locator(".task-group").nth(1).locator(".group-header"),
      "center",
    );
    await expect(frame.locator(".task-group").nth(1).locator(".task-item")).toHaveCount(2);
    await sleep(800);

    // 그룹 통째 드래그 — Ideas 를 Backlog 앞으로
    await dragWithCursor(
      workbox,
      frame.locator(".task-group").nth(2).locator(".group-header .task-handle"),
      frame.locator(".task-group").nth(1),
      "before",
    );
    await expect(frame.locator(".group-name").first()).toHaveValue("Ideas");
    await sleep(1200);
  } finally {
    await recorder.stop();
  }
});
