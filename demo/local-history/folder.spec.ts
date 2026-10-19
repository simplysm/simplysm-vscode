// 폴더 이력의 비교 시연 (spec 「3. 열람」 고르기와 diff) — 줄은 그 변경의 파일만, 범위는 구간 시작 직전 ↔
// 끝 직후를 다중 파일 diff(vscode.changes)로 연다. 줄 아래 항목은 고른 것에 해당하는 파일만 연다.
// 스냅샷 기록 완료 대기는 스냅샷 로그의 줄 수로 판정한다 (목록은 대상 폴더의 줄만 보여 줘서).
import path from "node:path";
import fs from "node:fs";
import type { Locator } from "@playwright/test";
import { expect, launchVsCode, retryAction, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import {
  activeTabOf,
  countSnapshots,
  diffSidesOf,
  historyListFocused,
  historyPaneOf,
  historyRowAt,
  multiDiffNamesOf,
  multiDiffSidesOf,
  prepareRecording,
  selectedNodesOf,
  showHistoryViaContextMenu,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const folderName = "local-history-folder";

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

test("폴더 줄은 그 변경의 파일만, 범위는 구간 시작 직전 ↔ 끝 직후를 다중 diff 로 연다", async ({
  vscodeExePath,
}, testInfo) => {
  const folderPath = path.join(workspaceDir, folderName);
  const aPath = path.join(folderPath, "a.txt");
  const bPath = path.join(folderPath, "b.txt");
  fs.rmSync(folderPath, { recursive: true, force: true });
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(aPath, "initial\n");
  const userDataDir = testInfo.outputPath("user-data");
  const app = await launchVsCode(vscodeExePath, {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir,
  });
  try {
    const workbox = await app.firstWindow();

    // 폴더 펼침 → a.txt 로 활성화·웜업 (계획 공통 전제)
    const folderItem = workbox.getByRole("treeitem", { name: folderName });
    await folderItem.waitFor({ state: "visible", timeout: 30_000 });
    await folderItem.click();
    await prepareRecording(workbox, "a.txt", aPath);
    const recorded = () => countSnapshots(userDataDir);
    const base = recorded();

    // 변경 3건 — b 생성 → a 수정 → b 삭제, 각각 별도 시점으로 기록 대기
    fs.writeFileSync(bPath, "b content\n");
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 1);
    fs.writeFileSync(aPath, "a second\n");
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 2);
    fs.rmSync(bPath);
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 3);

    // 폴더 Show History — 줄 = [b 삭제, a 수정, b 생성, 웜업…]
    await showHistoryViaContextMenu(workbox, folderItem, folderName);
    const historyPane = historyPaneOf(workbox);
    const row = (position: number) => historyRowAt(historyPane, position);
    const targetItem = row(2);
    // 폴더 이력의 줄은 시각 뒤에 바뀐 파일 요약을 적는다
    await expect(targetItem.locator(".label-description")).toHaveText("a.txt", {
      timeout: 15_000,
    });
    const names = multiDiffNamesOf(workbox);
    const aSides = multiDiffSidesOf(workbox, "a.txt");
    const bSides = multiDiffSidesOf(workbox, "b.txt");

    // "a 수정" 줄 → 그 변경에 든 a.txt 만. 그 뒤에 바뀐 b.txt(삭제)는 담지 않는다
    await retryAction(
      async () => {
        await targetItem.click();
      },
      async () => {
        await expect(activeTabOf(workbox)).toContainText(
          `${folderName} (change at`,
          { timeout: 5_000 },
        );
        await expect(names).toHaveText(["a.txt"], { timeout: 5_000 });
      },
    );
    await expect(aSides.original).toContainText("warmup");
    await expect(aSides.modified).toContainText("a second");
    await workbox.waitForTimeout(500); // 무관한 파일이 늦게 더해지지 않는다
    await expect(names).toHaveText(["a.txt"]);
    await workbox.screenshot({ path: path.join(shotDir, "folder-changes.png") });

    // 다중 diff 는 포커스를 에디터로 가져간다. 확장은 되돌리지 않는다(spec 「3. 열람」) — 키보드를 이어 쓰려면
    // 사용자가 목록을 한 번 클릭한다. 고른 줄을 다시 클릭하면 선택은 그대로고 펼침만 바뀐다.
    await expect.poll(() => historyListFocused(workbox), { timeout: 5_000 }).toBe(false);
    await targetItem.click();
    await expect.poll(() => historyListFocused(workbox), { timeout: 5_000 }).toBe(true);
    await expect(selectedNodesOf(historyPane)).toHaveCount(1);
    // Shift+↓ 로 "b 생성" 줄까지 넓힌다 — "a 수정" 줄이 펼쳐져 있으면 그 줄의 a.txt 항목을 거친다(줄에 포함)
    for (let step = 0; step < 3 && (await row(3).getAttribute("aria-selected")) !== "true"; step++) {
      await workbox.keyboard.press("Shift+ArrowDown");
      await workbox.waitForTimeout(300);
    }
    await expect(row(3)).toHaveAttribute("aria-selected", "true");
    await expect(names).toHaveText(["a.txt", "b.txt"], { timeout: 5_000 });
    await expect(bSides.modified).toContainText("b content");
    await workbox.screenshot({ path: path.join(shotDir, "folder-keyboard.png") });

    // 빠르게 옮겨 고른다: "b 생성" → "a 수정" → "b 삭제". 마지막 줄의 diff 만 남는다
    await row(3).click();
    await row(2).click();
    await row(1).click();
    await expect(selectedNodesOf(historyPane)).toHaveCount(1);
    await expect(row(1)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
    await expect(names).toHaveText(["b.txt"], { timeout: 5_000 });
    await expect(bSides.original).toContainText("b content", { timeout: 5_000 });
    await workbox.waitForTimeout(1_500); // 먼저 고른 줄의 늦은 열기가 덮지 않는다
    await expect(names).toHaveText(["b.txt"]);
    await expect(bSides.original).toContainText("b content");
    await workbox.screenshot({ path: path.join(shotDir, "folder-rapid.png") });

    // 범위: "a 수정" 줄 클릭(트리가 펼친다) → "b 생성" 줄 Shift+클릭. VS Code 가 펼쳐진 줄의 a.txt 항목까지
    // 선택에 넣지만, 선택된 줄의 항목은 그 줄에 포함된다 → 줄 범위의 구간 시작 직전 ↔ 끝 직후:
    // a.txt 수정, b.txt 생성
    await retryAction(
      async () => {
        if ((await row(2).getAttribute("aria-expanded")) === "true") {
          await row(2).locator(".monaco-tl-twistie").click(); // 접어 둔다 — 아래 클릭이 펼친다
        }
        await row(2).click();
        await expect(row(2)).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 });
        await row(3).click({ modifiers: ["Shift"] });
      },
      async () => {
        // 줄 2 · 그 줄의 a.txt 항목 · 줄 3
        await expect(selectedNodesOf(historyPane)).toHaveCount(3, { timeout: 5_000 });
        await expect(activeTabOf(workbox)).toContainText(
          `${folderName} (changes `,
          { timeout: 5_000 },
        );
        await expect(names).toHaveText(["a.txt", "b.txt"], { timeout: 5_000 });
      },
    );
    await expect(aSides.original).toContainText("warmup");
    await expect(aSides.modified).toContainText("a second");
    await expect(bSides.modified).toContainText("b content");
    await workbox.screenshot({ path: path.join(shotDir, "folder-range.png") });

    // 범위 "b 삭제" ~ "b 생성"(위 범위에 Ctrl 로 줄 1 을 더함) → b.txt 는 구간 시작 직전에도 끝 직후에도
    // 없다 — a.txt 만
    await retryAction(
      async () => {
        if ((await row(1).getAttribute("aria-selected")) !== "true") {
          await row(1).click({ modifiers: ["Control"] });
        }
      },
      async () => {
        await expect(row(1)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
        await expect(row(3)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
        await expect(names).toHaveText(["a.txt"], { timeout: 5_000 });
      },
    );
  } finally {
    await app.close();
    fs.rmSync(folderPath, { recursive: true, force: true });
  }
});

test("줄 아래 항목은 고른 것의 파일만 열고, 줄과 항목 · 다른 줄의 항목을 섞으면 마지막 클릭 하나로 되돌린다", async ({
  vscodeExePath,
}, testInfo) => {
  const itemsName = "local-history-items";
  const warmupName = "local-history-items-warmup.txt";
  const itemsPath = path.join(workspaceDir, itemsName);
  const warmupPath = path.join(workspaceDir, warmupName);
  const cPath = path.join(itemsPath, "sub", "c.txt");
  fs.rmSync(itemsPath, { recursive: true, force: true });
  fs.mkdirSync(path.join(itemsPath, "sub"), { recursive: true });
  // 기동 전에 만든다 — 기동 스캔이 네 파일을 한 줄로 기록한다
  fs.writeFileSync(path.join(itemsPath, "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(itemsPath, "b.txt"), "bravo\n");
  fs.writeFileSync(cPath, "charlie\n");
  fs.writeFileSync(path.join(itemsPath, "sub", "d.txt"), "delta\n");
  fs.writeFileSync(warmupPath, "initial\n");
  const userDataDir = testInfo.outputPath("user-data");
  const app = await launchVsCode(vscodeExePath, {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir,
  });
  try {
    const workbox = await app.firstWindow();
    await prepareRecording(workbox, warmupName, warmupPath);
    const recorded = () => countSnapshots(userDataDir);
    const base = recorded();
    fs.writeFileSync(cPath, "charlie second\n");
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 1);

    // 폴더 이력 — 줄 1 = c.txt 수정, 줄 2 = 기동 스캔(네 파일 생성)
    const folderItem = workbox.getByRole("treeitem", { name: itemsName, exact: true });
    await showHistoryViaContextMenu(workbox, folderItem, itemsName);
    const pane = historyPaneOf(workbox);
    const editRow = historyRowAt(pane, 1);
    const scanRow = historyRowAt(pane, 2);
    await expect(scanRow.locator(".label-description")).toHaveText("c.txt and 3 more", {
      timeout: 15_000,
    });
    await expect(editRow.locator(".label-description")).toHaveText("c.txt");
    await expect(historyRowAt(pane, 3)).toHaveCount(0);
    await scanRow.locator(".monaco-tl-twistie").click(); // 펼치기만 — 고르지 않는다
    const aItem = itemOf(pane, "a.txt", "added");
    const bItem = itemOf(pane, "b.txt", "added");
    const subItem = itemOf(pane, "sub");
    await expect(aItem).toBeVisible({ timeout: 5_000 });
    const { original, modified } = diffSidesOf(workbox);
    const names = multiDiffNamesOf(workbox);

    // 파일 항목 하나 → 그 파일의 내장 diff (직전 = 없음, 직후 = alpha). 제목은 그 파일 이름
    await retryAction(
      async () => {
        await aItem.click();
      },
      async () => {
        await expect(activeTabOf(workbox)).toContainText("a.txt (change at", {
          timeout: 5_000,
        });
        await expect(modified).toContainText("alpha", { timeout: 5_000 });
      },
    );
    await expect(original).not.toContainText("alpha");
    await workbox.screenshot({ path: path.join(shotDir, "items-file.png") });

    // 폴더 항목 → 그 아래 바뀐 파일만 담은 다중 diff
    await retryAction(
      async () => {
        await subItem.click();
      },
      async () => {
        await expect(activeTabOf(workbox)).toContainText("sub (change at", {
          timeout: 5_000,
        });
        await expect(names).toHaveText(["c.txt", "d.txt"], { timeout: 5_000 });
      },
    );
    await expect(multiDiffSidesOf(workbox, "c.txt").modified).toContainText("charlie");
    await workbox.screenshot({ path: path.join(shotDir, "items-folder.png") });

    // 여러 항목 → 고른 항목의 파일만 담은 다중 diff
    await retryAction(
      async () => {
        await aItem.click();
        await bItem.click({ modifiers: ["Control"] });
      },
      async () => {
        await expect(selectedNodesOf(pane)).toHaveCount(2, { timeout: 5_000 });
        await expect(activeTabOf(workbox)).toContainText(
          `${itemsName} (change at`,
          { timeout: 5_000 },
        );
        await expect(names).toHaveText(["a.txt", "b.txt"], { timeout: 5_000 });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "items-multi.png") });

    // 줄과 항목을 섞으면 마지막 클릭 항목 하나로 되돌린다
    await retryAction(
      async () => {
        await editRow.click({ modifiers: ["Control"] });
        await expect(selectedNodesOf(pane)).toHaveCount(1, { timeout: 5_000 });
        await aItem.click({ modifiers: ["Control"] });
      },
      async () => {
        await expect(selectedNodesOf(pane)).toHaveCount(1, { timeout: 5_000 });
        await expect(aItem).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
        await expect(activeTabOf(workbox)).toContainText("a.txt (change at", {
          timeout: 5_000,
        });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "items-mixed-row.png") });

    // 다른 줄의 항목을 섞어도 마지막 클릭 항목 하나로 되돌린다 — 줄 1 의 c.txt(수정)
    await editRow.locator(".monaco-tl-twistie").click();
    const cEdited = itemOf(pane, "c.txt", "modified");
    await expect(cEdited).toBeVisible({ timeout: 5_000 });
    await retryAction(
      async () => {
        await aItem.click();
        await expect(aItem).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
        await cEdited.click({ modifiers: ["Control"] });
      },
      async () => {
        await expect(selectedNodesOf(pane)).toHaveCount(1, { timeout: 5_000 });
        await expect(cEdited).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
        await expect(original).toContainText("charlie", { timeout: 5_000 });
        await expect(modified).toContainText("charlie second", { timeout: 5_000 });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "items-mixed-rows.png") });

    // 범위 안에서 원래대로 돌아온 경우 — c.txt 를 바꿨다 되돌린다. 그 두 줄의 범위는 바뀐 파일이 없어도
    // 빈 다중 diff 를 연다. 앞의 diff 미리보기 탭(c.txt)은 남지 않는다
    const beforeRevert = recorded();
    fs.writeFileSync(cPath, "charlie third\n");
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(beforeRevert + 1);
    fs.writeFileSync(cPath, "charlie second\n");
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(beforeRevert + 2);
    await expect(historyRowAt(pane, 4)).toHaveCount(1, { timeout: 15_000 });
    await expect(activeTabOf(workbox)).toContainText("c.txt (change at"); // 앞의 diff
    await retryAction(
      async () => {
        await historyRowAt(pane, 1).click(); // 되돌림(펼쳐지면 그 항목도 아래 범위에 든다 — 줄에 포함)
        await historyRowAt(pane, 2).click({ modifiers: ["Shift"] }); // "charlie third"
      },
      async () => {
        await expect(activeTabOf(workbox)).toContainText(`${itemsName} (changes `, {
          timeout: 5_000,
        });
        await expect(activeTabOf(workbox)).toContainText("(0 files)");
        await expect(
          workbox.locator(".part.editor").getByText("No Changed Files", { exact: true }),
        ).toBeVisible({ timeout: 5_000 });
      },
    );
    await expect(workbox.locator(".tabs-container .tab")).toHaveCount(1);
    await workbox.screenshot({ path: path.join(shotDir, "items-unchanged.png") });
  } finally {
    await app.close();
    fs.rmSync(itemsPath, { recursive: true, force: true });
    fs.rmSync(warmupPath, { force: true });
  }
});
