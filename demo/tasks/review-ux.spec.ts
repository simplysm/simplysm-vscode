// UX 리뷰 개선 시각 검증 — 빈 상태 안내·삭제 Undo 배너·편집 행 강조를
// DOM 단언 + 스크린샷으로 확인. 스크린샷은 사람이 직접 열람해 미세 시각 판정.
import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, openTasksFile, retryAction, runResultsDir, test, workspaceDir } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "review-ux");
const demoFiles = ["review-empty.tasks", "review-list.tasks"];

test.beforeAll(() => {
  fs.mkdirSync(shotDir, { recursive: true });
});

test.beforeEach(() => {
  fs.mkdirSync(workspaceDir, { recursive: true });
});

test.afterEach(() => {
  for (const fileName of demoFiles) {
    fs.rmSync(path.join(workspaceDir, fileName), { force: true });
  }
});

/** 행 입력칸에 포커스 — 클릭 + 확인·재시도 (undo.spec 패턴). */
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

test("빈 파일 → 빈 상태 안내 노출, 첫 항목 추가 시 사라짐", async ({ workbox }) => {
  fs.writeFileSync(path.join(workspaceDir, "review-empty.tasks"), "");
  const frame = await openTasksFile(workbox, "review-empty.tasks");
  const hint = frame.locator(".empty-hint");
  await expect(hint).toBeVisible({ timeout: 30_000 });
  await frame.locator("body").screenshot({ path: path.join(shotDir, "empty-hint.png") });

  const ghost = frame.locator(".task-ghost .task-input").first();
  await ghost.fill("첫 항목");
  await ghost.press("Enter");
  await expect(hint).toBeHidden();
});

test("항목 삭제 → Undo 배너 노출 + Undo 클릭으로 복구", async ({ workbox }) => {
  fs.writeFileSync(
    path.join(workspaceDir, "review-list.tasks"),
    '{"text":"살아남을 항목"}\n{"text":"지울 항목"}\n',
  );
  const frame = await openTasksFile(workbox, "review-list.tasks");
  const erase = frame.locator(".task-item").nth(1).locator(".task-erase");
  await retryAction(
    async () => {
      const box = await erase.boundingBox();
      if (box == null) throw new Error("erase button has no bounding box");
      await workbox.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    },
    async () => {
      await expect(frame.locator(".task-item")).toHaveCount(1, { timeout: 3_000 });
    },
  );

  const toast = frame.locator(".undo-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Task deleted");
  await toast.screenshot({ path: path.join(shotDir, "undo-toast.png") });

  await frame.locator(".undo-toast-action").click();
  await expect(frame.locator(".task-item")).toHaveCount(2, { timeout: 15_000 });
  await expect(toast).toBeHidden();
});

test("접근성 속성 — 지우개 aria-label·접기 aria-expanded 노출", async ({ workbox }) => {
  fs.writeFileSync(
    path.join(workspaceDir, "review-list.tasks"),
    '{"text":"미분류 항목"}\n{"group":"그룹 A"}\n{"text":"A-1"}\n',
  );
  const frame = await openTasksFile(workbox, "review-list.tasks");
  await expect(frame.locator(".task-item").first().locator(".task-erase")).toHaveAttribute(
    "aria-label",
    /Delete task/,
    { timeout: 30_000 },
  );
  await expect(frame.locator(".group-toggle").first()).toHaveAttribute("aria-expanded", "true");
});

type Rgba = { r: number; g: number; b: number; a: number };

/** `rgb()`/`rgba()` computed 값 파싱 — 브라우저는 색을 항상 이 형태로 직렬화. */
function parseRgba(value: string): Rgba {
  const nums = value.match(/[\d.]+/g);
  if (nums == null || nums.length < 3) throw new Error(`Unparsable color: ${value}`);
  return {
    r: Number(nums[0]),
    g: Number(nums[1]),
    b: Number(nums[2]),
    a: nums.length > 3 ? Number(nums[3]) : 1,
  };
}

/** source-over 합성 — 반투명 배경을 조상 위에 얹어 실제 렌더 색 산출. */
function composite(front: Rgba, back: Rgba): Rgba {
  const a = front.a + back.a * (1 - front.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (f: number, b: number) => (f * front.a + b * back.a * (1 - front.a)) / a;
  return { r: mix(front.r, back.r), g: mix(front.g, back.g), b: mix(front.b, back.b), a };
}

/** WCAG 2.1 상대 휘도 (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance). */
function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 대비비 (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio). */
function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 요소 전경 vs 실렌더 배경 대비비 — 조상 배경을 뒤에서 앞으로 합성해 투명도 반영. */
async function measureContrast(target: Locator): Promise<number> {
  const measured = await target.evaluate((el: Element) => {
    const backgrounds: string[] = [];
    for (let cur: Element | null = el; cur != null; cur = cur.parentElement) {
      backgrounds.push(getComputedStyle(cur).backgroundColor);
    }
    return { color: getComputedStyle(el).color, backgrounds };
  });
  let background: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  for (const layer of measured.backgrounds.reverse()) {
    background = composite(parseRgba(layer), background);
  }
  const foreground = composite(parseRgba(measured.color), background);
  return contrastRatio(foreground, background);
}

test("그룹 삭제 hover 강조 — 블록 내부 텍스트·아이콘 가독 유지", async ({ workbox }) => {
  fs.writeFileSync(
    path.join(workspaceDir, "review-list.tasks"),
    '{"text":"미분류1"}\n{"group":"그룹 A"}\n{"text":"A-1"}\n{"text":"A-2"}\n',
  );
  const frame = await openTasksFile(workbox, "review-list.tasks");
  const groupA = frame.locator(".task-group").nth(1);
  const trash = groupA.locator(".group-trash");
  await trash.waitFor({ state: "visible", timeout: 30_000 });
  await retryAction(
    async () => {
      const box = await trash.boundingBox();
      if (box == null) throw new Error("trash button has no bounding box");
      await workbox.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    },
    async () => {
      await expect(groupA).toHaveClass(/delete-hover/, { timeout: 3_000 });
    },
  );
  await groupA.screenshot({ path: path.join(shotDir, "group-delete-hover.png") });

  // WCAG 2.1 AA 본문 대비 4.5:1 (SC 1.4.3), 아이콘은 비텍스트 3:1 (SC 1.4.11)
  // soft — 세 지표를 한 번에 보고 (첫 실패로 나머지가 가려지면 원인 파악이 늦어짐)
  expect.soft(await measureContrast(groupA.locator(".group-name"))).toBeGreaterThanOrEqual(4.5);
  expect
    .soft(await measureContrast(groupA.locator(".task-input").first()))
    .toBeGreaterThanOrEqual(4.5);
  expect.soft(await measureContrast(trash)).toBeGreaterThanOrEqual(3);
});

test("편집 행 강조 (시각 스크린샷)", async ({ workbox }) => {
  const lines = ['{"group":"그룹 A"}'];
  for (let i = 1; i <= 18; i++) lines.push(`{"text":"항목 ${i}"}`);
  fs.writeFileSync(path.join(workspaceDir, "review-list.tasks"), `${lines.join("\n")}\n`);
  const frame = await openTasksFile(workbox, "review-list.tasks");
  await focusInput(workbox, frame.locator(".task-item .task-input").nth(2));
  await frame.locator("body").screenshot({ path: path.join(shotDir, "edit-highlight.png") });
});
