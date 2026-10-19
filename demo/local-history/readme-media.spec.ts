// local-history README 미디어 캡처 전용 — README_MEDIA=1 일 때만 실행.
// 정적 스크린샷 1장(images/show-history.png 의 원본): 폴더 이력 — 줄 아래 폴더 트리와 변경 종류,
// 고른 줄의 직전 ↔ 직후 다중 파일 diff 가 함께 보이는 화면 (spec 「3. 열람」).
import fs from "node:fs";
import path from "node:path";
import type { Locator } from "@playwright/test";
import {
  expect,
  launchVsCode,
  retryAction,
  runResultsDir,
  test,
  workspaceDir,
} from "../fixtures.ts";
import {
  activeTabOf,
  countSnapshots,
  historyPaneOf,
  historyRowAt,
  multiDiffNamesOf,
  multiDiffSidesOf,
  prepareRecording,
  showHistoryViaContextMenu,
} from "./history-utils.ts";

test.skip(process.env["README_MEDIA"] !== "1", "README 미디어 캡처 전용 (README_MEDIA=1)");

const folderName = "checkout";
const warmupName = "scratch.txt";

const lines = (...text: string[]) => [...text, ""].join("\n");

const cartItem = [
  "export interface CartItem {",
  "  readonly price: number;",
  "  readonly qty: number;",
  "}",
  "",
];
// 줄은 diff 한쪽 폭(약 70자) 안에 둔다 — 잘린 줄 없이 찍히게
const subtotalLine = "  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);";

// cart.ts — 기동 때 있던 내용 → 반올림 수정 → 쿠폰으로 바꿈(맨 위 줄)
const cartInitial = lines(
  'import { applyDiscount } from "../pricing/discount";',
  "",
  ...cartItem,
  "export function cartTotal(items: CartItem[]): number {",
  subtotalLine,
  "  return applyDiscount(subtotal);",
  "}",
);
const cartRounded = lines(
  'import { applyDiscount } from "../pricing/discount";',
  "",
  ...cartItem,
  "export function cartTotal(items: CartItem[]): number {",
  subtotalLine,
  "  return Math.round(applyDiscount(subtotal) * 100) / 100;",
  "}",
);
const cartCoupon = lines(
  'import { applyCoupon, type Coupon } from "../pricing/coupon";',
  "",
  ...cartItem,
  "export function cartTotal(items: CartItem[], coupon?: Coupon): number {",
  subtotalLine,
  "  return Math.round(applyCoupon(subtotal, coupon) * 100) / 100;",
  "}",
);
const discountSource = lines(
  "export function applyDiscount(amount: number): number {",
  "  return amount >= 100 ? amount * 0.9 : amount;",
  "}",
);
const couponSource = lines(
  "export interface Coupon {",
  "  readonly percentOff: number;",
  "}",
  "",
  "export function applyCoupon(amount: number, coupon?: Coupon): number {",
  "  return coupon ? amount * (1 - coupon.percentOff / 100) : amount;",
  "}",
);
const formatPriceSource = lines(
  "export function formatPrice(value: number): string {",
  '  return "$" + value.toFixed(2);',
  "}",
);

/** 줄 아래 항목 — 이름이 `name` 이고, `description` 을 주면 설명 글자(변경 종류)도 같은 것. */
function itemOf(pane: Locator, name: string, description?: string): Locator {
  const exact = (text: string) => new RegExp(`^${text.replaceAll(".", "\\.")}$`);
  let item = pane
    .locator(".monaco-list-row:not([aria-level='1'])")
    .filter({ has: pane.page().locator(".label-name", { hasText: exact(name) }) });
  if (description !== undefined) {
    item = item.filter({
      has: pane.page().locator(".label-description", { hasText: exact(description) }),
    });
  }
  return item;
}

test("스크린샷 — 폴더 이력의 폴더 트리 · 변경 종류 + 직전 ↔ 직후 다중 diff", async ({
  vscodeExePath,
}, testInfo) => {
  const folderPath = path.join(workspaceDir, folderName);
  const warmupPath = path.join(workspaceDir, warmupName);
  const cartPath = path.join(folderPath, "api", "cart.ts");
  const discountPath = path.join(folderPath, "pricing", "discount.ts");
  const couponPath = path.join(folderPath, "pricing", "coupon.ts");
  fs.rmSync(folderPath, { recursive: true, force: true });
  fs.mkdirSync(path.join(folderPath, "api"), { recursive: true });
  fs.mkdirSync(path.join(folderPath, "pricing"), { recursive: true });
  // 기동 전에 만든다 — 기동 스캔이 한 줄(맨 아래 줄)로 기록한다
  fs.writeFileSync(cartPath, cartInitial);
  fs.writeFileSync(discountPath, discountSource);
  fs.writeFileSync(path.join(folderPath, "price-format.ts"), formatPriceSource);
  fs.writeFileSync(path.join(folderPath, "README.md"), "# checkout\n");
  fs.writeFileSync(warmupPath, "initial\n");
  const userDataDir = testInfo.outputPath("user-data");
  const app = await launchVsCode(vscodeExePath, {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir,
  });
  try {
    const workbox = await app.firstWindow();
    const folderItem = workbox.getByRole("treeitem", { name: folderName, exact: true });
    await folderItem.waitFor({ state: "visible", timeout: 30_000 });
    await folderItem.click(); // 펼친다 — 아래 이름 변경은 탐색기에서 한다
    // 워처 웜업은 폴더 밖 파일로 — 폴더 이력에 웜업 줄이 생기지 않게
    await prepareRecording(workbox, warmupName, warmupPath);
    const recorded = () => countSnapshots(userDataDir);
    const base = recorded();

    // 변경 1: cart.ts 수정
    fs.writeFileSync(cartPath, cartRounded);
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 1);

    // 변경 2: 탐색기에서 이름 변경(price-format.ts → format-price.ts) — rename.spec 과 같은 경로
    const oldItem = workbox.getByRole("treeitem", { name: "price-format.ts" });
    const newItem = workbox.getByRole("treeitem", { name: "format-price.ts" });
    const renameInput = workbox.locator(".explorer-folders-view .monaco-inputbox input");
    // 하네스 창은 document.hasFocus() 가 false 라 rename 입력창이 즉시 닫힌다 — 참으로 스텁
    await workbox.evaluate(() => (document.hasFocus = () => true));
    await retryAction(
      async () => {
        await oldItem.click();
        await oldItem.press("F2");
        await renameInput.waitFor({ state: "visible", timeout: 2_000 });
        await renameInput.fill("format-price.ts");
        await renameInput.press("Enter");
      },
      async () => {
        await expect(newItem).toBeVisible({ timeout: 3_000 });
      },
    );
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 2);

    // 변경 3(한 debounce 창): cart.ts 수정 · coupon.ts 생성 · discount.ts 삭제
    fs.writeFileSync(cartPath, cartCoupon);
    fs.writeFileSync(couponPath, couponSource);
    fs.rmSync(discountPath);
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 3);

    // 폴더 Show History — 줄 = [변경 3, 변경 2, 변경 1, 기동 스캔]
    await showHistoryViaContextMenu(workbox, folderItem, folderName);
    const pane = historyPaneOf(workbox);
    const row = (position: number) => historyRowAt(pane, position);
    await expect(row(1).locator(".label-description")).toHaveText("cart.ts and 2 more", {
      timeout: 15_000,
    });
    await expect(row(2).locator(".label-description")).toHaveText("format-price.ts");
    await expect(row(3).locator(".label-description")).toHaveText("cart.ts");
    await expect(row(4)).toHaveCount(1);
    await expect(row(5)).toHaveCount(0);

    // 이름 변경 줄은 펼치기만 — 고르지 않는다
    await row(2).locator(".monaco-tl-twistie").click();
    await expect(itemOf(pane, "format-price.ts", "renamed from price-format.ts")).toBeVisible({
      timeout: 5_000,
    });

    // 맨 위 줄 클릭 → 펼쳐지고 그 변경의 직전 ↔ 직후 다중 diff 가 열린다(탐색기 순서)
    const names = multiDiffNamesOf(workbox);
    await retryAction(
      async () => {
        if ((await row(1).getAttribute("aria-expanded")) === "true") {
          await row(1).locator(".monaco-tl-twistie").click(); // 접어 둔다 — 아래 클릭이 펼친다
        }
        await row(1).click();
      },
      async () => {
        await expect(activeTabOf(workbox)).toContainText(`${folderName} (change at`, {
          timeout: 5_000,
        });
        await expect(names).toHaveText(["cart.ts", "coupon.ts", "discount.ts"], {
          timeout: 5_000,
        });
        await expect(row(1)).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 });
      },
    );
    await expect(itemOf(pane, "api")).toBeVisible();
    await expect(itemOf(pane, "pricing")).toBeVisible();
    await expect(itemOf(pane, "cart.ts", "modified")).toBeVisible();
    await expect(itemOf(pane, "coupon.ts", "added")).toBeVisible();
    await expect(itemOf(pane, "discount.ts", "deleted")).toBeVisible();
    const cartSides = multiDiffSidesOf(workbox, "cart.ts");
    await expect(cartSides.original).toContainText("applyDiscount");
    await expect(cartSides.modified).toContainText("applyCoupon");

    // 변경 목록을 키운다 — 펼친 줄이 모두 보이게. 위 뷰와의 경계(sash)를 위로 끌어올린다
    const paneBox = await pane.boundingBox();
    if (paneBox == null) throw new Error("Local History pane has no bounding box");
    const sidebarBox = await workbox.locator(".part.sidebar").boundingBox();
    if (sidebarBox == null) throw new Error("sidebar has no bounding box");
    const targetTop = sidebarBox.y + sidebarBox.height - 330;
    if (paneBox.y > targetTop) {
      const sashes = await workbox
        .locator(".part.sidebar .monaco-sash.horizontal:not(.disabled)")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }),
        );
      const sash = sashes
        .filter((point) => point.y <= paneBox.y + 4)
        .sort((left, right) => right.y - left.y)[0];
      if (sash === undefined) throw new Error("no sash above the Local History pane");
      await workbox.mouse.move(sash.x, sash.y);
      await workbox.mouse.down();
      for (let step = 1; step <= 10; step++) {
        await workbox.mouse.move(sash.x, sash.y - ((paneBox.y - targetTop) * step) / 10);
      }
      await workbox.mouse.up();
    }
    await expect(row(4)).toBeVisible();

    // 웜업 파일은 탐색기에서 치운다 — 폴더 밖이라 변경 목록은 그대로다
    fs.rmSync(warmupPath, { force: true });
    await expect(workbox.getByRole("treeitem", { name: warmupName })).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(row(5)).toHaveCount(0);

    // 화면 정리 — 팔레트 경유 금지(에이전트 입력창이 대신 열려 화면을 강탈함): DOM 버튼 직접 클릭.
    // 보조 사이드바(챗) 닫기
    const hideAuxButton = workbox
      .locator(".part.auxiliarybar")
      .getByRole("button", { name: /Hide Secondary Side Bar/ });
    if (await hideAuxButton.isVisible()) await hideAuxButton.click();
    // 알림 토스트 개별 닫기
    for (const toast of await workbox.locator(".notification-toast").all()) {
      const clearButton = toast.locator(".codicon-notifications-clear").first();
      try {
        await toast.hover();
        await clearButton.click({ timeout: 2_000 });
      } catch {
        // 이미 사라진 토스트 — 무시
      }
    }
    await workbox.mouse.move(700, 860);
    await workbox.waitForTimeout(1_500);

    const shotDir = path.join(runResultsDir, "readme-media");
    fs.mkdirSync(shotDir, { recursive: true });
    await workbox.screenshot({ path: path.join(shotDir, "local-history-show-history.png") });
  } finally {
    await app.close();
    fs.rmSync(folderPath, { recursive: true, force: true });
    fs.rmSync(warmupPath, { force: true });
  }
});
