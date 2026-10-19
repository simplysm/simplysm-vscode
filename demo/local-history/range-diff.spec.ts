// 범위 시연 (spec 「3. 열람」 고르기와 diff) — Shift 로 줄 범위를 고르면 구간 시작 직전 ↔ 구간 끝 직후가
// 보인다. 비연속 선택(Ctrl)은 마지막 클릭 줄 하나로 되돌아간다.
import path from "node:path";
import fs from "node:fs";
import { expect, test, retryAction, runResultsDir, workspaceDir } from "../fixtures.ts";
import {
  activeTabOf,
  diffSidesOf,
  historyPaneOf,
  historyRowAt,
  prepareRecording,
  selectedNodesOf,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-range-diff-target.txt";

test("줄 범위를 고르면 구간 시작 직전 ↔ 구간 끝 직후 diff 가 열린다", async ({
  workbox,
}) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  try {
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const historyPane = historyPaneOf(workbox);

    // 변경 3건 — 범위가 중간 변경("second")을 흡수하는지 본다
    fs.writeFileSync(filePath, "first change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 1, { timeout: 15_000 });
    fs.writeFileSync(filePath, "second change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 2, { timeout: 15_000 });
    fs.writeFileSync(filePath, "third change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 3, { timeout: 15_000 });

    // Shift 범위: "third" ~ "first" 줄 → 좌 = "first" 변경 직전(웜업 내용), 우 = "third" 변경 직후
    const { original, modified } = diffSidesOf(workbox);
    await retryAction(
      async () => {
        await historyRowAt(historyPane, 1).click(); // "third"
        await historyRowAt(historyPane, 3).click({ modifiers: ["Shift"] }); // "first"
      },
      async () => {
        await expect(original).toContainText("warmup", { timeout: 5_000 });
        await expect(modified).toContainText("third change", { timeout: 5_000 });
      },
    );
    // 제목은 범위의 변경 시각 — "파일 (changes X – Y)". 같은 날이라 Y 는 시각만 적는다
    const time = "\\d{1,2}:\\d{2}:\\d{2}\\s?[AP]M";
    await expect(activeTabOf(workbox)).toContainText(
      new RegExp(`${fileName} \\(changes \\d{1,2}/\\d{1,2}/\\d{4}, ${time} – ${time}\\)`),
    );

    await workbox.screenshot({ path: path.join(shotDir, "range-diff-editor.png") });

    // Ctrl 비연속 선택은 허용하지 않는다 — 마지막 클릭 줄("first")만 남고 그 변경의 직전 ↔ 직후가 열린다
    await retryAction(
      async () => {
        await historyRowAt(historyPane, 1).click(); // "third"
        await historyRowAt(historyPane, 3).click({ modifiers: ["Control"] }); // "first" — 비연속
      },
      async () => {
        await expect(selectedNodesOf(historyPane)).toHaveCount(1, { timeout: 5_000 });
        await expect(selectedNodesOf(historyPane)).toHaveAttribute("aria-posinset", "3");
        await expect(original).toContainText("warmup", { timeout: 5_000 });
        await expect(modified).toContainText("first change", { timeout: 5_000 });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "range-diff-noncontiguous.png") });

    // 범위 안에서 원래대로 돌아온 경우 — "fourth" 로 바꿨다 "third" 로 되돌린다. 그 두 줄의 범위는 바뀐 것이
    // 없어도 비교를 연다(양쪽이 같은 diff). 앞의 diff 미리보기 탭은 남지 않는다
    // 줄이 늘어 보이는 줄만 DOM 에 그려진다(목록 가상화) — 줄 수는 aria-setsize 로 셈다
    fs.writeFileSync(filePath, "fourth change\n");
    await expect(historyRowAt(historyPane, 1)).toHaveAttribute("aria-setsize", String(baseline + 4), {
      timeout: 15_000,
    });
    fs.writeFileSync(filePath, "third change\n");
    await expect(historyRowAt(historyPane, 1)).toHaveAttribute("aria-setsize", String(baseline + 5), {
      timeout: 15_000,
    });
    await expect(activeTabOf(workbox)).toContainText(`${fileName} (change at`); // 앞의 diff
    await retryAction(
      async () => {
        await historyRowAt(historyPane, 1).click(); // "third"(되돌림)
        await historyRowAt(historyPane, 2).click({ modifiers: ["Shift"] }); // "fourth"
      },
      async () => {
        await expect(activeTabOf(workbox)).toContainText(`${fileName} (changes `, { timeout: 5_000 });
        await expect(original).toContainText("third change", { timeout: 5_000 });
        await expect(modified).toContainText("third change", { timeout: 5_000 });
      },
    );
    await expect(workbox.locator(".tabs-container .tab")).toHaveCount(1);
    await workbox.screenshot({ path: path.join(shotDir, "range-diff-unchanged.png") });
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
