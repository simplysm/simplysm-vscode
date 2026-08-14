// 범위선택 시연 — 시점 2개를 ctrl+클릭으로 선택하면 구간 병합 diff(시작 직전 ↔ 끝 시점)가 보인다.
import path from "node:path";
import fs from "node:fs";
import { expect, test, retryAction, runResultsDir, workspaceDir } from "../fixtures.ts";
import { historyPaneOf, prepareRecording } from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-range-diff-target.txt";

test("시점 범위선택 시 구간 병합 diff 로 시작 직전과 끝 시점 내용이 나란히 보인다", async ({
  workbox,
}) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  try {
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const historyPane = historyPaneOf(workbox);

    // 변경 3건 — 범위선택으로 중간 시점("second")이 흡수되는지 본다
    fs.writeFileSync(filePath, "first change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 1, { timeout: 15_000 });
    fs.writeFileSync(filePath, "second change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 2, { timeout: 15_000 });
    fs.writeFileSync(filePath, "third change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 3, { timeout: 15_000 });

    // shift 범위선택: "third"~"first" → 병합 diff: 좌 = "first" 직전(웜업 내용) / 우 = "third"
    const original = workbox.locator(
      ".monaco-diff-editor .editor.original .view-lines:not([monaco-view-zone])",
    );
    const modified = workbox.locator(
      ".monaco-diff-editor .editor.modified .view-lines:not([monaco-view-zone])",
    );
    await retryAction(
      async () => {
        await historyPane.getByRole("treeitem").nth(0).click(); // "third" 시점
        await historyPane.getByRole("treeitem").nth(2).click({ modifiers: ["Shift"] }); // "first" 시점
      },
      async () => {
        await expect(original).toContainText("warmup", { timeout: 5_000 });
        await expect(modified).toContainText("third change", { timeout: 5_000 });
      },
    );

    await workbox.screenshot({ path: path.join(shotDir, "range-diff-editor.png") });

    // ctrl 비연속 선택은 불허 — 마지막 클릭 항목("first")만 남고 그 시점 단일 diff("first" ↔ 현재)가 열린다
    await retryAction(
      async () => {
        await historyPane.getByRole("treeitem").nth(0).click(); // "third" 시점
        await historyPane.getByRole("treeitem").nth(2).click({ modifiers: ["Control"] }); // "first" — 비연속
      },
      async () => {
        await expect(original).toContainText("first change", { timeout: 5_000 });
        await expect(modified).toContainText("third change", { timeout: 5_000 });
        await expect(historyPane.locator(".monaco-list-row.selected")).toHaveCount(1, {
          timeout: 5_000,
        });
      },
    );
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
