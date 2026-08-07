// tasks 항목 이동 시연 (spec §4.4, §8 행 상시 편집) — 드래그·키보드 이동이 파일 줄 순서에 즉시 반영,
// 내용·미지 필드 불변, 이동 후 포커스 유지, 끝에서 키보드 이동은 변화 없음 (완료 기준 그대로).
import fs from "node:fs";
import path from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect, openTasksFile, retryAction, test, workspaceDir } from "../fixtures.ts";

const demoFileName = "move-demo.tasks";
const demoFilePath = path.join(workspaceDir, demoFileName);

const initialContent = '{"text":"하나","priority":7}\n{"text":"둘"}\n{"text":"셋"}\n';

async function openDemoFile(workbox: Page): Promise<FrameLocator> {
  const frame = await openTasksFile(workbox, demoFileName);
  await frame.locator(".task-list").first().waitFor({ state: "attached", timeout: 30_000 });
  return frame;
}

/** 폴링으로 파일 내용 도달 대기 — 즉시 저장(§3.1) 검증. */
async function expectFileContent(expected: string): Promise<void> {
  await expect(() => {
    expect(fs.readFileSync(demoFilePath, "utf8")).toBe(expected);
  }).toPass({ timeout: 15_000 });
}

/** 절대 좌표 마우스 드래그 — 드래그 핸들을 잡아 이동 (spec §4.4). 확인·재시도는 retryAction 참조. */
async function dragItem(
  workbox: Page,
  source: Locator,
  target: Locator,
  position: "before" | "after",
  verify: () => Promise<void>,
): Promise<void> {
  await source.waitFor({ state: "visible", timeout: 30_000 });
  await retryAction(async () => {
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (sourceBox == null || targetBox == null) throw new Error("drag target has no bounding box");
    const dropY = position === "before" ? targetBox.y + 2 : targetBox.y + targetBox.height - 2;
    await workbox.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await workbox.mouse.down();
    await workbox.mouse.move(targetBox.x + targetBox.width / 2, dropY, { steps: 10 });
    await workbox.mouse.move(targetBox.x + targetBox.width / 2, dropY);
    await workbox.mouse.up();
  }, verify);
}

/** 행 입력칸에 포커스 — 클릭 + 확인·재시도 (키보드 이동의 진입점, spec §4.4). */
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

test.beforeEach(() => {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(demoFilePath, initialContent);
});

test.afterEach(() => {
  fs.rmSync(demoFilePath, { force: true });
});

test("드래그: 첫 항목을 맨 아래로 → 파일 줄 순서 반영 + 내용·미지 필드 불변", async ({
  workbox,
}) => {
  const frame = await openDemoFile(workbox);
  const items = frame.locator(".task-item");
  await dragItem(
    workbox,
    items.first().locator(".task-handle"),
    items.nth(2),
    "after",
    async () => {
      await expect(frame.locator(".task-item .task-input").nth(2)).toHaveValue("하나", {
        timeout: 3_000,
      });
    },
  );
  await expectFileContent('{"text":"둘"}\n{"text":"셋"}\n{"text":"하나","priority":7}\n');
});

test("드래그: 셋째 항목을 첫 항목 위로 → 끼어들고 나머지 밀림", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const items = frame.locator(".task-item");
  await dragItem(
    workbox,
    items.nth(2).locator(".task-handle"),
    items.first(),
    "before",
    async () => {
      await expect(frame.locator(".task-item .task-input").first()).toHaveValue("셋", {
        timeout: 3_000,
      });
    },
  );
  await expectFileContent('{"text":"셋"}\n{"text":"하나","priority":7}\n{"text":"둘"}\n');
});

test("수정 중 Ctrl+Alt+↓ → 수정 확정 후 그 행 이동", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const input = frame.locator(".task-item .task-input").first();
  await input.fill("하나 고침");
  await workbox.keyboard.press("Control+Alt+ArrowDown");
  await expectFileContent('{"text":"둘"}\n{"text":"하나 고침","priority":7}\n{"text":"셋"}\n');
  await expect(frame.locator(".task-item .task-input").nth(1)).toHaveValue("하나 고침");
});

test("키보드: Ctrl+Alt+↓ 한 칸 이동 → 즉시 저장·포커스 유지, 맨 아래에선 변화 없음", async ({
  workbox,
}) => {
  const frame = await openDemoFile(workbox);
  await focusInput(workbox, frame.locator(".task-item .task-input").first());
  await workbox.keyboard.press("Control+Alt+ArrowDown");
  await expect(frame.locator(".task-item .task-input").nth(1)).toHaveValue("하나");
  await expectFileContent('{"text":"둘"}\n{"text":"하나","priority":7}\n{"text":"셋"}\n');
  // 연속 이동 — 이동 후에도 포커스가 그 행에 유지 (spec §4.4)
  await workbox.keyboard.press("Control+Alt+ArrowDown");
  await expectFileContent('{"text":"둘"}\n{"text":"셋"}\n{"text":"하나","priority":7}\n');
  // 맨 아래에서 ↓ → 변화 없음 (spec §4.4)
  await workbox.keyboard.press("Control+Alt+ArrowDown");
  await expect(frame.locator(".task-item .task-input").nth(2)).toHaveValue("하나");
  expect(fs.readFileSync(demoFilePath, "utf8")).toBe(
    '{"text":"둘"}\n{"text":"셋"}\n{"text":"하나","priority":7}\n',
  );
});
