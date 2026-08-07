// tasks 외부 변경 동기화 시연 (spec §4.6, §8 행 상시 편집) — 외부 수정·외부 파손·복구 각각에서
// UI 가 파일 상태를 따라가고, 입력 중 텍스트가 유실되지 않는 것을 검증 (완료 기준 그대로).
import fs from "node:fs";
import path from "node:path";
import type { FrameLocator, Page } from "@playwright/test";
import { expect, openTasksFile, test, workspaceDir } from "../fixtures.ts";

const demoFileName = "sync-demo.tasks";
const demoFilePath = path.join(workspaceDir, demoFileName);

async function openDemoFile(workbox: Page): Promise<FrameLocator> {
  const frame = await openTasksFile(workbox, demoFileName);
  await frame.locator(".task-list").first().waitFor({ state: "attached", timeout: 30_000 });
  return frame;
}

test.beforeEach(() => {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(demoFilePath, '{"text":"기존 항목","priority":7}\n');
});

test.afterEach(() => {
  fs.rmSync(demoFilePath, { force: true });
});

test("외부 수정: 밖에서 바뀐 내용이 목록에 자동 반영", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  await expect(frame.locator(".task-item .task-input").first()).toHaveValue("기존 항목");
  // 밖(다른 도구)에서 파일 교체 — 항목 텍스트 변경 + 항목 추가
  fs.writeFileSync(demoFilePath, '{"text":"밖에서 고침"}\n{"text":"밖에서 추가"}\n');
  await expect(frame.locator(".task-item .task-input").first()).toHaveValue("밖에서 고침", {
    timeout: 15_000,
  });
  await expect(frame.locator(".task-item .task-input").nth(1)).toHaveValue("밖에서 추가");
});

test("외부 파손 → 오류 화면, 복구 → 목록 복귀", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  await expect(frame.locator(".task-item .task-input").first()).toHaveValue("기존 항목");
  // 밖에서 깨진 줄 기록 → 편집 차단 + 오류 안내 (spec §3.2·§4.6)
  fs.writeFileSync(demoFilePath, '{"text":"정상"}\nbroken-line\n');
  await expect(frame.locator(".parse-error")).toBeVisible({ timeout: 15_000 });
  // 밖에서 고침 → 목록 복귀
  fs.writeFileSync(demoFilePath, '{"text":"고쳐짐"}\n');
  await expect(frame.locator(".task-item .task-input").first()).toHaveValue("고쳐짐", {
    timeout: 15_000,
  });
});

test("입력 중 유지: 고스트 새 행 입력 중 외부 변경 → 목록 갱신 + 입력 텍스트 보존", async ({
  workbox,
}) => {
  const frame = await openDemoFile(workbox);
  const ghost = frame.locator(".task-ghost .task-input").first();
  await ghost.fill("쓰다 만 메모");
  // 확정 전 외부 변경
  fs.writeFileSync(demoFilePath, '{"text":"밖에서 고침"}\n');
  await expect(frame.locator(".task-item .task-input").first()).toHaveValue("밖에서 고침", {
    timeout: 15_000,
  });
  await expect(ghost).toHaveValue("쓰다 만 메모");
  // 확정 → 최신 파일 기준 목록 끝에 추가 (spec §4.6 충돌 규칙)
  await ghost.press("Enter");
  await expect(() => {
    expect(fs.readFileSync(demoFilePath, "utf8")).toBe(
      '{"text":"밖에서 고침"}\n{"text":"쓰다 만 메모"}\n',
    );
  }).toPass({ timeout: 15_000 });
});

test("편집 중 행 보호: 외부 변경에도 입력값 유지, 확정 시 최신 파일 기준 반영", async ({
  workbox,
}) => {
  fs.writeFileSync(demoFilePath, '{"text":"기존 항목","priority":7}\n{"text":"둘째"}\n');
  const frame = await openDemoFile(workbox);
  const firstInput = frame.locator(".task-item .task-input").first();
  await firstInput.fill("고치는 중");
  // 외부 변경 — 편집 중 행(마지막 저장값 "기존 항목")은 보호되고 둘째만 바뀜
  fs.writeFileSync(demoFilePath, '{"text":"기존 항목","priority":7}\n{"text":"둘째-외부수정"}\n');
  await expect(frame.locator(".task-item .task-input").nth(1)).toHaveValue("둘째-외부수정", {
    timeout: 15_000,
  });
  // 편집 중 입력값 유지 (텍스트 매칭 재식별, spec §4.6)
  await expect(firstInput).toHaveValue("고치는 중");
  await firstInput.press("Enter");
  await expect(() => {
    expect(fs.readFileSync(demoFilePath, "utf8")).toBe(
      '{"text":"고치는 중","priority":7}\n{"text":"둘째-외부수정"}\n',
    );
  }).toPass({ timeout: 15_000 });
});

test("편집 중 항목 사라짐: 임시 행으로 유지 → 확정 시 목록 끝 새 항목 전환", async ({
  workbox,
}) => {
  const frame = await openDemoFile(workbox);
  const firstInput = frame.locator(".task-item .task-input").first();
  await firstInput.fill("살릴 텍스트");
  // 외부 변경으로 편집 중 항목 소멸
  fs.writeFileSync(demoFilePath, '{"text":"전혀 다른 항목"}\n');
  await expect(frame.locator(".task-item .task-input").first()).toHaveValue("전혀 다른 항목", {
    timeout: 15_000,
  });
  // 임시 행으로 유지 + 텍스트 보존 (spec §4.6, 사용자 확정) — 기존 행 노드가 그대로 임시 행이 됨
  const draft = frame.locator(".task-item .task-input").nth(1);
  await expect(draft).toHaveValue("살릴 텍스트");
  await draft.press("Enter");
  await expect(() => {
    expect(fs.readFileSync(demoFilePath, "utf8")).toBe(
      '{"text":"전혀 다른 항목"}\n{"text":"살릴 텍스트"}\n',
    );
  }).toPass({ timeout: 15_000 });
});
