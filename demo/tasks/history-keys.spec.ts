// tasks Ctrl+Z/Y 키 소유권 시연 (spec §4.5) — VS Code 는 webview 안 Ctrl+Z 를 선점해
// 문서 undo 를 무조건 실행하므로, 키바인딩 기여로 소유권을 가져와 webview 가 분기한다.
// 완료 기준: 1회 = 문서 이력 정확히 1단계, dirty 필드는 필드 텍스트 undo 만(문서·파일 불변).
// (기존 undo.spec 은 이력 1개짜리 시나리오라 이중 적용을 못 잡았다 — 이력 2개 이상으로 검증)
import fs from "node:fs";
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, openTasksFile, test, workspaceDir } from "../fixtures.ts";

const demoFileName = "history-keys-demo.tasks";
const demoFilePath = path.join(workspaceDir, demoFileName);

test.afterEach(() => {
  fs.rmSync(demoFilePath, { force: true });
});

async function openSeeded(workbox: Page, content: string): Promise<FrameLocator> {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(demoFilePath, content);
  return await openTasksFile(workbox, demoFileName);
}

/** 이력 2개 적재 — ghost 로 two, three 추가 (one 은 seed). */
async function loadTwoOps(workbox: Page, frame: FrameLocator): Promise<void> {
  const ghost = frame.locator(".task-ghost .task-input").first();
  for (const text of ["two", "three"]) {
    await ghost.fill(text);
    await ghost.press("Enter");
  }
  await expect(frame.locator(".task-item")).toHaveCount(3);
  await expect(() => {
    expect(fs.readFileSync(demoFilePath, "utf8")).toBe(
      '{"text":"one"}\n{"text":"two"}\n{"text":"three"}\n',
    );
  }).toPass({ timeout: 15_000 });
}

/**
 * 키 1회가 정확히 1단계임을 전제로 한 유실 대비 재시도 — 개수가 목표 직전 값일 때만 다시 누른다
 * (무조건 재시도는 유실이 아니라 반영 지연일 때 초과 단계를 만든다).
 */
async function pressHistoryKeyUntilCount(
  workbox: Page,
  frame: FrameLocator,
  key: "Control+z" | "Control+y",
  fromCount: number,
  toCount: number,
): Promise<void> {
  await expect(async () => {
    if ((await frame.locator(".task-item").count()) === fromCount) {
      await workbox.keyboard.press(key);
    }
    await expect(frame.locator(".task-item")).toHaveCount(toCount, { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

test("pristine 칸 Ctrl+Z 1회 = 문서 이력 정확히 1단계, 연속·redo 도 1단계씩", async ({
  workbox,
}) => {
  const frame = await openSeeded(workbox, '{"text":"one"}\n');
  await loadTwoOps(workbox, frame);

  // 추가 확정 직후 포커스는 비워진 ghost(pristine) — 문서 undo 1단계씩
  await pressHistoryKeyUntilCount(workbox, frame, "Control+z", 3, 2);
  await expect(() => {
    expect(fs.readFileSync(demoFilePath, "utf8")).toBe('{"text":"one"}\n{"text":"two"}\n');
  }).toPass({ timeout: 15_000 });

  await pressHistoryKeyUntilCount(workbox, frame, "Control+z", 2, 1);
  await expect(() => {
    expect(fs.readFileSync(demoFilePath, "utf8")).toBe('{"text":"one"}\n');
  }).toPass({ timeout: 15_000 });

  // redo 도 1단계씩
  await pressHistoryKeyUntilCount(workbox, frame, "Control+y", 1, 2);
  await expect(() => {
    expect(fs.readFileSync(demoFilePath, "utf8")).toBe('{"text":"one"}\n{"text":"two"}\n');
  }).toPass({ timeout: 15_000 });
});

test("dirty 필드 Ctrl+Z = 필드 텍스트 undo 만 — 문서·파일 불변", async ({ workbox }) => {
  const frame = await openSeeded(workbox, '{"text":"one"}\n');
  // 문서 이력 1개 적재 — dirty Ctrl+Z 가 문서를 건드리면 이게 사라져 드러난다
  const ghost = frame.locator(".task-ghost .task-input").first();
  await ghost.fill("two");
  await ghost.press("Enter");
  await expect(frame.locator(".task-item")).toHaveCount(2);

  // 첫 항목을 dirty 로 — 클릭 후 타이핑(미확정)
  const firstInput = frame.locator(".task-item .task-input").first();
  await firstInput.click();
  await workbox.keyboard.type(" edited");
  await expect(firstInput).toHaveValue("one edited");

  // Ctrl+Z — 필드 타이핑이 되돌아가고(유실 대비 재시도), 문서·파일은 그대로
  await expect(async () => {
    if ((await firstInput.inputValue()) === "one edited") {
      await workbox.keyboard.press("Control+z");
    }
    await expect(firstInput).not.toHaveValue("one edited", { timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(frame.locator(".task-item")).toHaveCount(2);
  expect(fs.readFileSync(demoFilePath, "utf8")).toBe('{"text":"one"}\n{"text":"two"}\n');
});
