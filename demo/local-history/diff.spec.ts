// 슬라이스 2 시연 — 시점 선택 시 내장 diff 에디터로 시점(좌) ↔ 현재(우) 내용이 보인다.
import path from "node:path";
import fs from "node:fs";
import { expect, test, retryAction, runResultsDir, workspaceDir } from "../fixtures.ts";
import { historyPaneOf, prepareRecording } from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-diff-target.txt";

test("시점 선택 시 내장 diff 로 시점과 현재 내용이 나란히 보인다", async ({ workbox }) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  try {
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const historyPane = historyPaneOf(workbox);

    fs.writeFileSync(filePath, "first change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 1, { timeout: 15_000 });
    fs.writeFileSync(filePath, "second change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 2, { timeout: 15_000 });

    // 두 번째 항목(= "first change" 시점) 선택 → diff: 좌 "first change" / 우 "second change"(현재)
    // view-zone(반대편 삭제 표시줄)도 .view-lines 클래스를 가지므로 실제 본문 컨테이너만 선택
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
        await expect(original).toContainText("first change", { timeout: 5_000 });
        await expect(modified).toContainText("second change", { timeout: 5_000 });
      },
    );

    await workbox.screenshot({ path: path.join(shotDir, "diff-editor.png") });
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
