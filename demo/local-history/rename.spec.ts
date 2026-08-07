// 슬라이스 5 시연 — 탐색기 rename(onDidRenameFiles) 후에도 새 이름의 Show History 가
// 옛 경로의 시점까지 하나의 체인으로 보여준다.
import path from "node:path";
import fs from "node:fs";
import { expect, retryAction, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import { historyPaneOf, prepareRecording, showHistoryViaContextMenu } from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const oldName = "local-history-rename-old.txt";
const newName = "local-history-rename-new.txt";

test("rename 후에도 옛 경로의 시점이 한 체인으로 이어진다", async ({ workbox }) => {
  const oldPath = path.join(workspaceDir, oldName);
  const newPath = path.join(workspaceDir, newName);
  fs.rmSync(newPath, { force: true });
  fs.writeFileSync(oldPath, "initial\n");
  try {
    const baseline = await prepareRecording(workbox, oldName, oldPath);
    const historyPane = historyPaneOf(workbox);

    fs.writeFileSync(oldPath, "first change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 1, { timeout: 15_000 });

    // 탐색기 우클릭 → Rename... → 새 이름 입력 — 무포커스 키 유실 대비 결과 확인 후 재시도
    const oldItem = workbox.getByRole("treeitem", { name: oldName });
    const newItem = workbox.getByRole("treeitem", { name: newName });
    const renameInput = workbox.locator(".explorer-folders-view .monaco-inputbox input");
    // 하네스 창은 document.hasFocus() 가 false 라 rename 입력창이 즉시 닫힌다
    // (focus-utils 의 포커스 시뮬레이션과 동일 메커니즘) — 입력 동안만 참으로 스텁.
    await workbox.evaluate(() => (document.hasFocus = () => true));
    // 선택 후 F2 → 입력 → Enter — 컨텍스트 메뉴 경유는 메뉴 닫힘의 포커스 복원이
    // rename 입력창을 즉시 blur 시켜 닫아버림(하네스 무포커스 창 한정).
    await retryAction(
      async () => {
        await oldItem.click();
        await oldItem.press("F2");
        try {
          await renameInput.waitFor({ state: "visible", timeout: 2_000 });
        } catch {
          return; // 입력창 미표시 — verify 실패로 재시도
        }
        await renameInput.fill(newName);
        await renameInput.press("Enter");
      },
      async () => {
        await expect(newItem).toBeVisible({ timeout: 3_000 });
      },
    );

    // 새 이름으로 Show History → 옛 경로 시점까지 체인으로 나열 (rename 시점 +1 = baseline + 2)
    await showHistoryViaContextMenu(workbox, newItem, newName);
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 2, { timeout: 15_000 });

    // rename 시점 기록 완료 후 수정 1회 — 시점 내용을 현재와 다르게 만들어 diff 를 검증 가능하게
    fs.writeFileSync(newPath, "renamed change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 3, { timeout: 15_000 });

    // rename 이전 시점(세 번째 항목 = "first change") 선택 → 옛 경로 blob 이 diff 좌측에 공급됨
    const original = workbox.locator(
      ".monaco-diff-editor .editor.original .view-lines:not([monaco-view-zone])",
    );
    const modified = workbox.locator(
      ".monaco-diff-editor .editor.modified .view-lines:not([monaco-view-zone])",
    );
    await retryAction(
      async () => {
        await historyPane.getByRole("treeitem").nth(2).click();
      },
      async () => {
        await expect(original).toContainText("first change", { timeout: 5_000 });
        await expect(modified).toContainText("renamed change", { timeout: 5_000 });
      },
    );

    await workbox.screenshot({ path: path.join(shotDir, "rename-chain.png") });
  } finally {
    fs.rmSync(oldPath, { force: true });
    fs.rmSync(newPath, { force: true });
  }
});
