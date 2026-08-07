// tasks 항목 편집 시연 (spec §4.3, §8 행 상시 편집) — 추가·수정·삭제가 파일에 즉시·정확히 반영,
// 여러 줄 왕복 보존, Enter 연속 입력, Esc 취소, 미지 필드 보존 (완료 기준 그대로).
import fs from "node:fs";
import path from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect, openTasksFile, retryAction, test, workspaceDir } from "../fixtures.ts";

const demoFileName = "edit-demo.tasks";
const demoFilePath = path.join(workspaceDir, demoFileName);

/** webview 내부 요소 클릭 — 절대 좌표 클릭 + 기대 상태 확인·재시도 (retryAction 참조). */
async function clickAt(workbox: Page, target: Locator, verify: () => Promise<void>): Promise<void> {
  await target.waitFor({ state: "visible", timeout: 30_000 });
  await retryAction(async () => {
    const box = await target.boundingBox();
    if (box == null) throw new Error("target has no bounding box");
    await workbox.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }, verify);
}

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

test.beforeEach(() => {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(demoFilePath, '{"text":"기존 항목","priority":7}\n');
});

test.afterEach(() => {
  fs.rmSync(demoFilePath, { force: true });
});

test("추가: 고스트 새 행 확정 → 목록 끝 추가 + 즉시 저장 + 연속 입력 대기", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const ghost = frame.locator(".task-ghost .task-input").first();
  await ghost.fill("새 메모");
  await ghost.press("Enter");
  await expect(frame.locator(".task-item .task-input").nth(1)).toHaveValue("새 메모");
  // 고스트는 비워져 연속 입력 대기 (spec §4.3)
  await expect(ghost).toHaveValue("");
  await expectFileContent('{"text":"기존 항목","priority":7}\n{"text":"새 메모"}\n');
});

test("추가: 빈 확정 → 항목 미생성·파일 불변", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  await frame.locator(".task-ghost .task-input").first().press("Enter");
  await expect(frame.locator(".task-item")).toHaveCount(1);
  expect(fs.readFileSync(demoFilePath, "utf8")).toBe('{"text":"기존 항목","priority":7}\n');
});

test("수정: 행에서 바로 편집 확정 → 즉시 저장 + 미지 필드 보존", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const input = frame.locator(".task-item .task-input").first();
  await input.fill("고친 항목");
  await input.press("Enter");
  await expect(input).toHaveValue("고친 항목");
  await expectFileContent('{"text":"고친 항목","priority":7}\n');
});

test("Enter 연속 입력: 확정 후 아래 임시 행 생성·포커스 → 이어서 추가", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const input = frame.locator(".task-item .task-input").first();
  await input.fill("고친 항목");
  await input.press("Enter");
  // Enter 확정 → 바로 아래 임시 행에 포커스 (spec §4.3 키 규약)
  await workbox.keyboard.type("이어서 적음");
  await workbox.keyboard.press("Enter");
  await expectFileContent('{"text":"고친 항목","priority":7}\n{"text":"이어서 적음"}\n');
});

test("Esc: 수정 취소 — 마지막 저장값 복원, 파일 무기록", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const input = frame.locator(".task-item .task-input").first();
  await input.fill("바꾸다 맘");
  await input.press("Escape");
  await expect(input).toHaveValue("기존 항목");
  expect(fs.readFileSync(demoFilePath, "utf8")).toBe('{"text":"기존 항목","priority":7}\n');
});

test("수정: 여러 줄(Shift+Enter) → 1물리줄 왕복 보존", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const input = frame.locator(".task-item .task-input").first();
  await input.fill("첫 줄");
  await input.press("Shift+Enter");
  await input.pressSequentially("둘째 줄");
  await input.press("Enter");
  await expectFileContent('{"text":"첫 줄\\n둘째 줄","priority":7}\n');
  await expect(frame.locator(".task-item .task-input").first()).toHaveValue("첫 줄\n둘째 줄");
});

test("수정: 빈 텍스트 확정 = 삭제 취급", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const input = frame.locator(".task-item .task-input").first();
  await input.fill("");
  await input.press("Enter");
  await expect(frame.locator(".task-item")).toHaveCount(0);
  await expectFileContent("");
});

test("동시 조작: 편집 중 다른 항목 삭제 클릭 → 확정·삭제 둘 다 반영", async ({ workbox }) => {
  fs.writeFileSync(demoFilePath, '{"text":"기존 항목","priority":7}\n{"text":"둘째"}\n');
  const frame = await openDemoFile(workbox);
  await frame.locator(".task-item .task-input").first().fill("고침");
  const secondErase = frame.locator(".task-item").nth(1).locator(".task-erase");
  await clickAt(workbox, secondErase, async () => {
    await expect(frame.locator(".task-item")).toHaveCount(1, { timeout: 3_000 });
  });
  // 포커스 이탈 확정(첫 항목 수정) + 클릭 조작(둘째 삭제) 모두 반영 (spec §4.3 동시 조작)
  await expect(frame.locator(".task-item .task-input").first()).toHaveValue("고침");
  await expectFileContent('{"text":"고침","priority":7}\n');
});

test("삭제: 앞쪽 지우개 클릭 → 즉시 제거 + 즉시 저장 (확인 대화 없음)", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  await clickAt(workbox, frame.locator(".task-erase").first(), async () => {
    await expect(frame.locator(".task-item")).toHaveCount(0, { timeout: 3_000 });
  });
  await expectFileContent("");
});
