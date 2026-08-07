// tasks 확장 골격 시연 (spec §4.2) — .tasks 3종(정상·빈·깨진)을 열어
// 목록·빈 목록·오류 안내 화면이 뜨는 것을 확인 (완료 기준 그대로).
import fs from "node:fs";
import path from "node:path";
import { expect, openTasksFile, test, workspaceDir } from "../fixtures.ts";

const demoFiles = ["skeleton-normal.tasks", "skeleton-empty.tasks", "skeleton-broken.tasks"];

test.beforeEach(() => {
  fs.mkdirSync(workspaceDir, { recursive: true });
});

test.afterEach(() => {
  for (const fileName of demoFiles) {
    fs.rmSync(path.join(workspaceDir, fileName), { force: true });
  }
});

test("정상 파일 → 항목 목록 렌더 (행 상시 편집)", async ({ workbox }) => {
  fs.writeFileSync(
    path.join(workspaceDir, "skeleton-normal.tasks"),
    '{"text":"첫 메모"}\n{"text":"둘째 메모"}\n',
  );
  const frame = await openTasksFile(workbox, "skeleton-normal.tasks");
  const inputs = frame.locator(".task-item .task-input");
  await expect(inputs.first()).toHaveValue("첫 메모", { timeout: 30_000 });
  await expect(inputs.nth(1)).toHaveValue("둘째 메모");
});

test("빈 파일 → 빈 목록 (오류 아님)", async ({ workbox }) => {
  fs.writeFileSync(path.join(workspaceDir, "skeleton-empty.tasks"), "");
  const frame = await openTasksFile(workbox, "skeleton-empty.tasks");
  await expect(frame.locator(".task-list").first()).toBeAttached({ timeout: 30_000 });
  await expect(frame.locator(".task-item")).toHaveCount(0);
  await expect(frame.locator(".parse-error")).toBeHidden();
});

test("깨진 파일 → 오류 안내 화면 (줄 번호 + 텍스트 에디터 유도)", async ({ workbox }) => {
  fs.writeFileSync(path.join(workspaceDir, "skeleton-broken.tasks"), '{"text":"정상"}\nnot-json\n');
  const frame = await openTasksFile(workbox, "skeleton-broken.tasks");
  await expect(frame.locator(".parse-error")).toContainText("line 2: invalid JSON", {
    timeout: 30_000,
  });
  await expect(frame.locator(".open-as-text")).toBeVisible();
  await expect(frame.locator(".task-item")).toHaveCount(0);
});
