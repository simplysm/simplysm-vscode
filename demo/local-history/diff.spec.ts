// 줄 하나의 diff 시연 (spec 「3. 열람」 고르기와 diff) — 줄 하나를 고르면 그 변경의 직전(좌) ↔ 직후(우)가
// 내장 diff 로 열린다. 빠르게 옮겨 고르면 마지막으로 고른 줄의 diff 만 남는다.
import path from "node:path";
import fs from "node:fs";
import { expect, test, retryAction, runResultsDir, workspaceDir } from "../fixtures.ts";
import {
  activeTabOf,
  diffSidesOf,
  historyListFocused,
  historyPaneOf,
  historyRowAt,
  prepareRecording,
  selectedNodesOf,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-diff-target.txt";

test("줄 하나를 고르면 그 변경의 직전 ↔ 직후 diff 가 열리고, 빠르게 옮겨 고르면 마지막 줄만 연다", async ({
  workbox,
}) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  try {
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const historyPane = historyPaneOf(workbox);

    fs.writeFileSync(filePath, "first change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 1, { timeout: 15_000 });
    fs.writeFileSync(filePath, "second change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 2, { timeout: 15_000 });

    // "first change" 줄(두 번째) → 좌 = 그 변경 직전(웜업 내용), 우 = 직후("first change") — 현재와 비교하지 않는다
    const { original, modified } = diffSidesOf(workbox);
    await retryAction(
      async () => {
        await historyRowAt(historyPane, 2).click();
      },
      async () => {
        await expect(original).toContainText("warmup", { timeout: 5_000 });
        await expect(modified).toContainText("first change", { timeout: 5_000 });
      },
    );
    // 제목은 어느 변경인지만 밝힌다 — "파일 (change at 날짜 시각)". "↔ Current" 는 없다
    await expect(activeTabOf(workbox)).toContainText(
      new RegExp(`${fileName} \\(change at \\d{1,2}/\\d{1,2}/\\d{4}, \\d{1,2}:\\d{2}:\\d{2}\\s?[AP]M\\)`),
    );
    await expect(activeTabOf(workbox)).not.toContainText("Current");

    // 맨 위 줄 → 좌 "first change", 우 "second change"
    await retryAction(
      async () => {
        await historyRowAt(historyPane, 1).click();
      },
      async () => {
        await expect(original).toContainText("first change", { timeout: 5_000 });
        await expect(modified).toContainText("second change", { timeout: 5_000 });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "diff-editor.png") });

    // diff(preserveFocus)를 열어도 키보드 포커스는 목록에 남는다
    await expect.poll(() => historyListFocused(workbox), { timeout: 5_000 }).toBe(true);

    // 빠르게 옮겨 고른다: 2 → 3 → 2. diff 는 마지막으로 고른 줄(2)의 것만 남는다
    await historyRowAt(historyPane, 2).click();
    await historyRowAt(historyPane, 3).click();
    await historyRowAt(historyPane, 2).click();
    await expect(selectedNodesOf(historyPane)).toHaveCount(1);
    await expect(selectedNodesOf(historyPane)).toHaveAttribute("aria-posinset", "2");
    await expect(modified).toContainText("first change", { timeout: 5_000 });
    await workbox.waitForTimeout(1_500); // 먼저 고른 줄의 늦은 열기가 덮지 않는다
    await expect(original).toContainText("warmup");
    await expect(modified).toContainText("first change");
    await workbox.screenshot({ path: path.join(shotDir, "diff-rapid.png") });
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
