// local-history README 미디어 캡처 전용 — README_MEDIA=1 일 때만 실행.
// 정적 스크린샷 1장: Show History 트리뷰 + 내장 diff 에디터가 함께 보이는 화면.
import fs from "node:fs";
import path from "node:path";
import { expect, retryAction, runCommand, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import { historyPaneOf, prepareRecording } from "./history-utils.ts";

test.skip(process.env["README_MEDIA"] !== "1", "README 미디어 캡처 전용 (README_MEDIA=1)");

const fileName = "user-service.ts";

const versionA = [
  "export function formatPrice(value: number): string {",
  '  return "$" + value.toFixed(2);',
  "}",
  "",
].join("\n");

const versionB = [
  "export function formatPrice(value: number, currency = \"USD\"): string {",
  "  const amount = value.toFixed(2);",
  '  return currency === "USD" ? "$" + amount : amount + " " + currency;',
  "}",
  "",
].join("\n");

test("스크린샷 — Show History 트리뷰 + diff", async ({ workbox }) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(filePath, "initial\n");
  try {
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const historyPane = historyPaneOf(workbox);

    fs.writeFileSync(filePath, versionA);
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 1, { timeout: 15_000 });
    fs.writeFileSync(filePath, versionB);
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 2, { timeout: 15_000 });

    // versionA 시점 선택 → diff: 좌 versionA / 우 versionB(현재)
    const original = workbox.locator(
      ".monaco-diff-editor .editor.original .view-lines:not([monaco-view-zone])",
    );
    const modified = workbox.locator(
      ".monaco-diff-editor .editor.modified .view-lines:not([monaco-view-zone])",
    );
    await retryAction(
      async () => {
        await historyPane.getByRole("treeitem").nth(1).click();
      },
      async () => {
        await expect(original).toContainText("formatPrice", { timeout: 5_000 });
        await expect(modified).toContainText("currency", { timeout: 5_000 });
      },
    );

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
    await workbox.mouse.move(400, 700);
    await workbox.waitForTimeout(1_500);

    const shotDir = path.join(runResultsDir, "readme-media");
    fs.mkdirSync(shotDir, { recursive: true });
    await workbox.screenshot({ path: path.join(shotDir, "local-history-show-history.png") });
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
