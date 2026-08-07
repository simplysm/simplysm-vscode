// tasks 그룹 시연 (spec §4.7, §8 행 상시 편집) — 생성·이름변경·삭제(항목째)·그룹 드래그(블록 유지)·
// 접기 왕복이 파일에 정확히 반영되고 undo 로 복구 (완료 기준 그대로). 그룹별 고스트 추가·헤더 드롭 포함.
import fs from "node:fs";
import path from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import { expect, openTasksFile, retryAction, runResultsDir, test, workspaceDir } from "../fixtures.ts";

const demoFileName = "group-demo.tasks";
const demoFilePath = path.join(workspaceDir, demoFileName);

const initialContent =
  '{"text":"미분류1"}\n' +
  '{"group":"A","note":"keep"}\n' +
  '{"text":"a1"}\n' +
  '{"text":"a2"}\n' +
  '{"group":"B"}\n' +
  '{"text":"b1"}\n';

async function openDemoFile(workbox: Page): Promise<FrameLocator> {
  const frame = await openTasksFile(workbox, demoFileName);
  await frame.locator(".group-header").first().waitFor({ state: "attached", timeout: 30_000 });
  return frame;
}

/** 폴링으로 파일 내용 도달 대기 — 즉시 저장(§3.1) 검증. */
async function expectFileContent(expected: string): Promise<void> {
  await expect(() => {
    expect(fs.readFileSync(demoFilePath, "utf8")).toBe(expected);
  }).toPass({ timeout: 15_000 });
}

/** webview 내부 요소 클릭 — 절대 좌표 클릭 + 기대 상태 확인·재시도 (retryAction 참조). */
async function clickAt(workbox: Page, target: Locator, verify: () => Promise<void>): Promise<void> {
  await target.waitFor({ state: "visible", timeout: 30_000 });
  await retryAction(async () => {
    const box = await target.boundingBox();
    if (box == null) throw new Error("target has no bounding box");
    await workbox.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }, verify);
}

/** 절대 좌표 마우스 드래그 — 핸들을 잡아 대상 위치로 (spec §4.4·§4.7). */
async function dragTo(
  workbox: Page,
  source: Locator,
  target: Locator,
  position: "before" | "after" | "center",
  verify: () => Promise<void>,
): Promise<void> {
  await source.waitFor({ state: "visible", timeout: 30_000 });
  await retryAction(async () => {
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (sourceBox == null || targetBox == null) throw new Error("drag target has no bounding box");
    const dropY =
      position === "before"
        ? targetBox.y + 2
        : position === "after"
          ? targetBox.y + targetBox.height - 2
          : targetBox.y + targetBox.height / 2;
    await workbox.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await workbox.mouse.down();
    await workbox.mouse.move(targetBox.x + targetBox.width / 2, dropY, { steps: 10 });
    await workbox.mouse.move(targetBox.x + targetBox.width / 2, dropY);
    await workbox.mouse.up();
  }, verify);
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

test.beforeEach(() => {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(demoFilePath, initialContent);
});

test.afterEach(() => {
  fs.rmSync(demoFilePath, { force: true });
});

test("표시: 헤더 아래 소속 항목, 미분류 최상단 (spec §4.7)", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const sections = frame.locator(".task-group");
  await expect(sections).toHaveCount(3);
  await expect(sections.first().locator(".group-header")).toHaveCount(0);
  await expect(sections.first().locator(".task-item .task-input")).toHaveCount(1);
  await expect(sections.first().locator(".task-item .task-input").first()).toHaveValue("미분류1");
  await expect(sections.nth(1).locator(".group-name")).toHaveValue("A");
  await expect(sections.nth(1).locator(".task-item .task-input").first()).toHaveValue("a1");
  await expect(sections.nth(1).locator(".task-item .task-input").nth(1)).toHaveValue("a2");
  await expect(sections.nth(2).locator(".group-name")).toHaveValue("B");
  await expect(sections.nth(2).locator(".task-item .task-input").first()).toHaveValue("b1");
});

test("그룹별 추가: A 고스트 행 확정 → A 끝 삽입 + 즉시 저장 (spec §4.3)", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const groupAGhost = frame.locator(".task-group").nth(1).locator(".task-ghost .task-input");
  await groupAGhost.fill("a3");
  await groupAGhost.press("Enter");
  await expectFileContent(
    '{"text":"미분류1"}\n' +
      '{"group":"A","note":"keep"}\n' +
      '{"text":"a1"}\n' +
      '{"text":"a2"}\n' +
      '{"text":"a3"}\n' +
      '{"group":"B"}\n' +
      '{"text":"b1"}\n',
  );
  await expect(
    frame.locator(".task-group").nth(1).locator(".task-item .task-input").nth(2),
  ).toHaveValue("a3");
});

test("그룹 내 Enter 연속 입력: 항목 확정 → 아래 임시 행(항목 스타일)·포커스 → 그 그룹에 실항목 (spec §4.3)", async ({
  workbox,
}) => {
  const frame = await openDemoFile(workbox);
  const groupA = frame.locator(".task-group").nth(1);
  // a1 에 포커스 후 Enter — 바로 아래 임시 새 행이 생기고 포커스 이동 (임시 행도 .task-item 로 보임)
  await focusInput(workbox, groupA.locator(".task-item .task-input").first());
  await workbox.keyboard.press("Enter");
  // 임시 행은 고스트("Add a task…")가 아니라 항목 행 — 그룹 A 안에 뜸 (미분류로 새지 않음)
  await expect(groupA.locator(".task-item")).toHaveCount(3, { timeout: 3_000 });
  await workbox.keyboard.type("a1.5");
  await workbox.keyboard.press("Enter");
  // 파일: a1 바로 뒤(그룹 A 안)에 삽입 — 미분류·B 로 새지 않음
  await expectFileContent(
    '{"text":"미분류1"}\n' +
      '{"group":"A","note":"keep"}\n' +
      '{"text":"a1"}\n' +
      '{"text":"a1.5"}\n' +
      '{"text":"a2"}\n' +
      '{"group":"B"}\n' +
      '{"text":"b1"}\n',
  );
  // UI: 새 항목이 그룹 A 안에서 실제 .task-item 으로 인식됨 (껐다 켜지 않아도)
  await expect(groupA.locator(".task-item .task-input").nth(1)).toHaveValue("a1.5");
});

test("생성: 목록 끝 그룹 추가 칸에 이름 입력 → 목록 끝 빈 그룹 (spec §4.7)", async ({
  workbox,
}) => {
  const frame = await openDemoFile(workbox);
  await frame.locator(".group-new").fill("C");
  await frame.locator(".group-new").press("Enter");
  await expect(frame.locator(".group-name").nth(2)).toHaveValue("C");
  await expectFileContent(initialContent + '{"group":"C"}\n');
  // 확정 후 칸이 비워져 연속 입력 대기 (항목 고스트와 동일)
  await expect(frame.locator(".group-new")).toHaveValue("");
});

test("이름변경: 헤더 이름 상시 편집 → 미지 필드 보존 저장 (spec §4.7)", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const nameInput = frame.locator(".group-name").first();
  await nameInput.fill("A-renamed");
  await nameInput.press("Enter");
  await expect(frame.locator(".group-name").first()).toHaveValue("A-renamed");
  await expectFileContent(
    initialContent.replace('{"group":"A","note":"keep"}', '{"group":"A-renamed","note":"keep"}'),
  );
});

test("삭제: 헤더 trash → 헤더+소속 항목 즉시 삭제, undo 로 복구 (spec §4.7·§4.5)", async ({
  workbox,
}) => {
  const frame = await openDemoFile(workbox);
  const headerB = frame.locator(".task-group").nth(2).locator(".group-header");
  const groupBTrash = headerB.locator(".group-trash");
  await headerB.waitFor({ state: "visible", timeout: 30_000 });
  await retryAction(
    async () => {
      const headerBox = await headerB.boundingBox();
      if (headerBox == null) throw new Error("header has no bounding box");
      await workbox.mouse.move(
        headerBox.x + headerBox.width / 2,
        headerBox.y + headerBox.height / 2,
      );
      const trashBox = await groupBTrash.boundingBox();
      if (trashBox == null) throw new Error("trash has no bounding box");
      await workbox.mouse.click(trashBox.x + trashBox.width / 2, trashBox.y + trashBox.height / 2);
    },
    async () => {
      await expect(frame.locator(".group-header")).toHaveCount(1, { timeout: 3_000 });
    },
  );
  await expectFileContent(
    '{"text":"미분류1"}\n{"group":"A","note":"keep"}\n{"text":"a1"}\n{"text":"a2"}\n',
  );
  // undo — 헤더·소속 항목 함께 복구 (pristine 행 입력칸에서 Ctrl+Z, spec §4.5)
  await focusInput(workbox, frame.locator(".task-item .task-input").first());
  await retryAction(
    async () => {
      await workbox.keyboard.press("Control+z");
    },
    async () => {
      await expect(frame.locator(".group-header")).toHaveCount(2, { timeout: 3_000 });
    },
  );
  await expectFileContent(initialContent);
});

test("그룹 드래그: B 를 A 앞으로 → 블록(헤더+소속) 통째 이동 (spec §4.7)", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const handleB = frame.locator(".task-group").nth(2).locator(".group-header .task-handle");
  await dragTo(workbox, handleB, frame.locator(".task-group").nth(1), "before", async () => {
    await expect(frame.locator(".group-name").first()).toHaveValue("B", { timeout: 3_000 });
  });
  await expectFileContent(
    '{"text":"미분류1"}\n' +
      '{"group":"B"}\n' +
      '{"text":"b1"}\n' +
      '{"group":"A","note":"keep"}\n' +
      '{"text":"a1"}\n' +
      '{"text":"a2"}\n',
  );
});

test("접기 왕복: collapsed 파일 저장·필드 제거, 소속 행 숨김(DOM 보존) (spec §4.7)", async ({
  workbox,
}) => {
  const frame = await openDemoFile(workbox);
  const groupA = frame.locator(".task-group").nth(1);
  await clickAt(workbox, groupA.locator(".group-toggle"), async () => {
    await expect(groupA.locator(".task-item").first()).toBeHidden({ timeout: 3_000 });
  });
  await expect(groupA.locator(".task-ghost")).toBeHidden();
  await expectFileContent(
    initialContent.replace(
      '{"group":"A","note":"keep"}',
      '{"group":"A","note":"keep","collapsed":true}',
    ),
  );
  // 펼침 — 필드 제거로 원상 복귀
  await clickAt(workbox, groupA.locator(".group-toggle"), async () => {
    await expect(groupA.locator(".task-item").first()).toBeVisible({ timeout: 3_000 });
  });
  await expectFileContent(initialContent);
});

test("헤더 위 항목 드롭: 접힘·펼침 불문 그 그룹 끝 삽입 (spec §4.4)", async ({ workbox }) => {
  const frame = await openDemoFile(workbox);
  const sourceHandle = frame.locator(".task-group").first().locator(".task-handle").first();
  const headerB = frame.locator(".task-group").nth(2).locator(".group-header");
  await dragTo(workbox, sourceHandle, headerB, "center", async () => {
    await expect(frame.locator(".task-group").first().locator(".task-item")).toHaveCount(0, {
      timeout: 3_000,
    });
  });
  await expectFileContent(
    '{"group":"A","note":"keep"}\n' +
      '{"text":"a1"}\n' +
      '{"text":"a2"}\n' +
      '{"group":"B"}\n' +
      '{"text":"b1"}\n' +
      '{"text":"미분류1"}\n',
  );
});

test("펼침 시 여러 줄 항목 높이 복원 — 접힌 채 로드된 항목이 1줄로 잘리지 않음 (리뷰 회귀)", async ({
  workbox,
}) => {
  // 접힌 그룹 안에 여러 줄 항목 — 접힘(display:none) 중 높이 측정이 0 으로 굳는 조건 (결함 ②)
  fs.writeFileSync(
    demoFilePath,
    '{"group":"G","collapsed":true}\n{"text":"첫째 줄\\n둘째 줄\\n셋째 줄"}\n',
  );
  const frame = await openDemoFile(workbox);
  const groupG = frame.locator(".task-group").nth(1); // [0]=미분류(빈), [1]=G
  await expect(groupG).toHaveClass(/collapsed/);
  // 펼침 → 항목 노출
  await clickAt(workbox, groupG.locator(".group-toggle"), async () => {
    await expect(groupG.locator(".task-item").first()).toBeVisible({ timeout: 3_000 });
  });
  const input = groupG.locator(".task-item .task-input").first();
  await expect(input).toHaveValue("첫째 줄\n둘째 줄\n셋째 줄");
  // 여러 줄이 내용 높이만큼 펴짐 — 버그면 height 0(min 1줄)로 굳어 scrollHeight > clientHeight (내용 잘림)
  await expect(() => {
    expect(input).toBeVisible();
  }).toPass();
  const overflow = await input.evaluate(
    (el: HTMLTextAreaElement) => el.scrollHeight - el.clientHeight,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await workbox.screenshot({
    path: path.join(runResultsDir, "tasks-expand-multiline.png"),
  });
});
