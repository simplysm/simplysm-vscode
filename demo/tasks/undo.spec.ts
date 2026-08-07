// tasks undo·redo 시연 (spec §4.5, §8 행 상시 편집) — 추가·수정·삭제·이동 각각 undo→redo 왕복 후
// UI·파일이 모두 일관 (완료 기준 그대로). pristine 입력칸의 Ctrl+Z/Y 는 문서 undo 로 위임.
import fs from "node:fs";
import path from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect, openTasksFile, retryAction, test, workspaceDir } from "../fixtures.ts";

const demoFileName = "undo-demo.tasks";
const demoFilePath = path.join(workspaceDir, demoFileName);

const initialContent = '{"text":"하나","priority":7}\n{"text":"둘"}\n';

async function openDemoFile(workbox: Page): Promise<FrameLocator> {
  const frame = await openTasksFile(workbox, demoFileName);
  await frame.locator(".task-list").first().waitFor({ state: "attached", timeout: 30_000 });
  return frame;
}

/** 폴링으로 파일 내용 도달 대기 — undo/redo 결과 즉시 저장(§4.5·§3.1) 검증. */
async function expectFileContent(expected: string): Promise<void> {
  await expect(() => {
    expect(fs.readFileSync(demoFilePath, "utf8")).toBe(expected);
  }).toPass({ timeout: 15_000 });
}

/** 행 입력칸에 포커스 — 클릭 + 확인·재시도. */
async function focusInput(workbox: Page, input: Locator): Promise<void> {
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await retryAction(
    async () => {
      const box = await input.boundingBox();
      if (box == null) throw new Error("input has no bounding box");
      await workbox.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    },
    async () => {
      await expect(input).toBeFocused({ timeout: 3_000 });
    },
  );
}

/**
 * undo/redo 키 입력 — pristine 행 입력칸(입력값 = 저장값)에 포커스를 두고 누름.
 * pristine 칸의 Ctrl+Z/Y 는 문서 undo/redo 로 위임됨 (spec §4.5, 사용자 확정).
 */
async function pressHistoryKey(
  workbox: Page,
  frame: FrameLocator,
  key: "Control+z" | "Control+y",
  verify: () => Promise<void>,
): Promise<void> {
  await focusInput(workbox, frame.locator(".task-item .task-input").first());
  await retryAction(async () => {
    await workbox.keyboard.press(key);
  }, verify);
}

test.beforeEach(() => {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(demoFilePath, initialContent);
});

test.afterEach(() => {
  fs.rmSync(demoFilePath, { force: true });
});

test("추가 undo→redo 왕복 — UI·파일 일관 (추가 직후 고스트에서 즉시 Ctrl+Z)", async ({
  workbox,
}) => {
  const frame = await openDemoFile(workbox);
  const ghost = frame.locator(".task-ghost .task-input").first();
  await ghost.fill("셋");
  await ghost.press("Enter");
  await expectFileContent(initialContent + '{"text":"셋"}\n');

  // 추가 직후 포커스는 비워진 고스트(pristine) — Ctrl+Z 가 바로 문서 undo (spec §4.5)
  await retryAction(
    async () => {
      await workbox.keyboard.press("Control+z");
    },
    async () => {
      await expect(frame.locator(".task-item")).toHaveCount(2, { timeout: 3_000 });
    },
  );
  await expectFileContent(initialContent);

  await pressHistoryKey(workbox, frame, "Control+y", async () => {
    await expect(frame.locator(".task-item")).toHaveCount(3, { timeout: 3_000 });
  });
  await expect(frame.locator(".task-item .task-input").nth(2)).toHaveValue("셋");
  await expectFileContent(initialContent + '{"text":"셋"}\n');
});

test("수정 undo→redo 왕복 — 미지 필드 포함 원상 복귀", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const input = frame.locator(".task-item .task-input").first();
  await input.fill("하나 고침");
  await input.press("Enter");
  await expectFileContent('{"text":"하나 고침","priority":7}\n{"text":"둘"}\n');

  await pressHistoryKey(workbox, frame, "Control+z", async () => {
    await expect(frame.locator(".task-item .task-input").first()).toHaveValue("하나", {
      timeout: 3_000,
    });
  });
  await expectFileContent(initialContent);

  await pressHistoryKey(workbox, frame, "Control+y", async () => {
    await expect(frame.locator(".task-item .task-input").first()).toHaveValue("하나 고침", {
      timeout: 3_000,
    });
  });
  await expectFileContent('{"text":"하나 고침","priority":7}\n{"text":"둘"}\n');
});

test("삭제 undo→redo 왕복 — 지운 항목 복구·재삭제", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const secondErase = frame.locator(".task-item").nth(1).locator(".task-erase");
  await retryAction(
    async () => {
      const box = await secondErase.boundingBox();
      if (box == null) throw new Error("erase button has no bounding box");
      await workbox.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    },
    async () => {
      await expect(frame.locator(".task-item")).toHaveCount(1, { timeout: 3_000 });
    },
  );
  await expectFileContent('{"text":"하나","priority":7}\n');

  await pressHistoryKey(workbox, frame, "Control+z", async () => {
    await expect(frame.locator(".task-item")).toHaveCount(2, { timeout: 3_000 });
  });
  await expect(frame.locator(".task-item .task-input").nth(1)).toHaveValue("둘");
  await expectFileContent(initialContent);

  await pressHistoryKey(workbox, frame, "Control+y", async () => {
    await expect(frame.locator(".task-item")).toHaveCount(1, { timeout: 3_000 });
  });
  await expectFileContent('{"text":"하나","priority":7}\n');
});

test("이동 undo→redo 왕복 — 줄 순서 원복·재적용", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  await focusInput(workbox, frame.locator(".task-item .task-input").first());
  await workbox.keyboard.press("Control+Alt+ArrowDown");
  await expectFileContent('{"text":"둘"}\n{"text":"하나","priority":7}\n');

  await pressHistoryKey(workbox, frame, "Control+z", async () => {
    await expect(frame.locator(".task-item .task-input").first()).toHaveValue("하나", {
      timeout: 3_000,
    });
  });
  await expectFileContent(initialContent);

  await pressHistoryKey(workbox, frame, "Control+y", async () => {
    await expect(frame.locator(".task-item .task-input").first()).toHaveValue("둘", {
      timeout: 3_000,
    });
  });
  await expectFileContent('{"text":"둘"}\n{"text":"하나","priority":7}\n');
});
