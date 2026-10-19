// 이름 변경 시연 — 탐색기 rename(onDidRenameFiles) 후에도 새 이름의 Show History 가 옛 경로의 줄까지
// 하나의 체인으로 보여 주고, 범위의 직전은 옛 경로의 내용이다. 폴더 이력은 구간 안의 이름 변경을
// 새 경로 항목 하나에 흡수한다 (spec 「3. 열람」 고르기와 diff).
import path from "node:path";
import fs from "node:fs";
import { expect, retryAction, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import {
  activeTabOf,
  diffSidesOf,
  historyPaneOf,
  historyRowAt,
  multiDiffNamesOf,
  multiDiffSidesOf,
  prepareRecording,
  showHistoryViaContextMenu,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const folderName = "local-history-rename";
const oldName = "local-history-rename-old.txt";
const newName = "local-history-rename-new.txt";

test("rename 후에도 옛 경로의 줄이 한 체인으로 이어지고, 폴더 범위는 이름 변경을 새 경로 항목에 흡수한다", async ({
  workbox,
}) => {
  const folderPath = path.join(workspaceDir, folderName);
  const oldPath = path.join(folderPath, oldName);
  const newPath = path.join(folderPath, newName);
  fs.rmSync(folderPath, { recursive: true, force: true });
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(oldPath, "initial\n");
  try {
    // 폴더 펼침 → 옛 이름 파일로 활성화·웜업
    const folderItem = workbox.getByRole("treeitem", { name: folderName, exact: true });
    await folderItem.waitFor({ state: "visible", timeout: 30_000 });
    await folderItem.click();
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
        await renameInput.waitFor({ state: "visible", timeout: 2_000 }); // 미표시면 이 시도는 실패 — 재시도
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
    // 이름 변경 줄(맨 위)은 옛 경로를 적는다 — 다른 줄은 시각만
    const descriptions = historyPane.locator(".monaco-list-row .label-description");
    await expect(descriptions).toHaveCount(1);
    await expect(
      historyPane.getByRole("treeitem").first().locator(".label-description"),
    ).toHaveText(`renamed from ${oldName}`);

    // 이름 변경 기록 뒤 수정 1회 — 줄 = [renamed change, 이름 변경, first change, 웜업…]
    fs.writeFileSync(newPath, "renamed change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 3, { timeout: 15_000 });
    const row = (position: number) => historyRowAt(historyPane, position);
    const { original, modified } = diffSidesOf(workbox);

    // 이름 변경 줄 하나 → 좌 = 옛 경로의 직전 내용, 우 = 새 경로의 직후 내용(내용은 같다)
    await retryAction(
      async () => {
        await row(2).click();
      },
      async () => {
        await expect(activeTabOf(workbox)).toContainText(
          `${newName} (change at`,
          { timeout: 5_000 },
        );
        await expect(original).toContainText("first change", { timeout: 5_000 });
        await expect(modified).toContainText("first change", { timeout: 5_000 });
      },
    );

    // 범위 "renamed change" ~ "first change" → 좌 = 옛 경로의 구간 시작 직전(웜업), 우 = 새 경로의 끝 직후
    await retryAction(
      async () => {
        await row(1).click();
        await row(3).click({ modifiers: ["Shift"] });
      },
      async () => {
        await expect(original).toContainText("warmup", { timeout: 5_000 });
        await expect(modified).toContainText("renamed change", { timeout: 5_000 });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "rename-chain.png") });

    // 폴더 이력 — 같은 줄들. 이름 변경 줄은 새 경로 항목 하나(옛 경로 삭제 항목 없음)
    await showHistoryViaContextMenu(workbox, folderItem, folderName);
    await expect(row(2).locator(".label-description")).toHaveText(newName, { timeout: 15_000 });
    const names = multiDiffNamesOf(workbox);
    const sides = multiDiffSidesOf(workbox, newName);
    // 범위 "이름 변경" ~ "first change" → new 항목 하나: 좌 = 옛 경로의 구간 시작 직전(웜업), 우 = first change
    await retryAction(
      async () => {
        if ((await row(2).getAttribute("aria-expanded")) === "true") {
          await row(2).locator(".monaco-tl-twistie").click();
        }
        await row(2).click(); // 펼쳐진다 — 그 줄의 항목도 아래 Shift 범위에 든다
        await row(3).click({ modifiers: ["Shift"] });
      },
      async () => {
        await expect(activeTabOf(workbox)).toContainText(`${folderName} (changes `, {
          timeout: 5_000,
        });
        await expect(names).toHaveText([newName], { timeout: 5_000 });
        await expect(sides.original).toContainText("warmup", { timeout: 5_000 });
        await expect(sides.modified).toContainText("first change", { timeout: 5_000 });
      },
    );
    await workbox.waitForTimeout(500); // 옛 경로 항목이 늦게 더해지지 않는다
    await expect(names).toHaveText([newName]);
    await workbox.screenshot({ path: path.join(shotDir, "rename-folder-range.png") });
  } finally {
    fs.rmSync(folderPath, { recursive: true, force: true });
  }
});
