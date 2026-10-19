// 복원 시연 (spec 「4. 복원」) — 고른 파일만 고른 변경의 직전 상태로 놓는다. 확인 창 → 진행 알림(복원 버튼 숨김) → 완료 알림.
// 미저장 편집은 먼저 저장돼 복원 직전 기록에 남고, 복원도 기록이라 복원할 수 있다.
// 네이티브 다이얼로그는 DOM 단언 불가 — 커스텀(DOM) 다이얼로그를 강제해 기동한다.
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  launchVsCode,
  retryAction,
  runResultsDir,
  test,
  workspaceDir,
} from "../fixtures.ts";
import {
  countSnapshots,
  diffSidesOf,
  historyPaneOf,
  historyRowAt,
  prepareRecording,
  showHistoryViaContextMenu,
  storeDirOf,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const restoreLabel = "Restore to Before This Change";
const customDialog = { settings: { "window.dialogStyle": "custom" } };

const dialog = (workbox: Page) => workbox.locator(".monaco-dialog-box");
const toast = (workbox: Page, text: string) =>
  workbox.locator(".notification-toast").filter({ hasText: text });

/** 노드(줄 · 항목)의 인라인 복원 버튼 → 확인 창 — 무포커스 클릭 유실 대비 재시도. */
async function openRestoreDialog(workbox: Page, node: Locator): Promise<void> {
  await retryAction(
    async () => {
      if (!(await dialog(workbox).isVisible())) {
        await node.hover();
        await node.getByRole("button", { name: restoreLabel }).click();
      }
    },
    async () => {
      await expect(dialog(workbox)).toContainText("Restore ", { timeout: 3_000 });
    },
  );
}

/** 확인 창의 버튼(Restore · Cancel). */
async function answerDialog(workbox: Page, button: "Restore" | "Cancel"): Promise<void> {
  await dialog(workbox).getByRole("button", { name: button, exact: true }).click();
  await expect(dialog(workbox)).toHaveCount(0);
}

/** 줄 아래 항목 — 이름이 `name` 인 것. */
function itemOf(pane: Locator, name: string): Locator {
  return pane
    .locator(".monaco-list-row:not([aria-level='1'])")
    .filter({ has: pane.page().locator(".label-name", { hasText: new RegExp(`^${name}$`) }) });
}

/** 목록에 그려진 복원 버튼 수 — 호버 전에는 감춰져 있어도 DOM 에는 줄마다 있다. */
function restoreButtonsOf(pane: Locator): Locator {
  return pane.locator(`.action-label[aria-label="${restoreLabel}"]`);
}

test("파일 이력 — 미저장 편집을 저장해 기록한 뒤 복원하고, 에디터는 복원 내용을 보이며, 복원도 복원한다", async ({
  vscodeExePath,
}, testInfo) => {
  const fileName = "local-history-restore-target.txt";
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    customDialog,
  );
  try {
    const workbox = await app.firstWindow();
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const pane = historyPaneOf(workbox);
    const rows = pane.getByRole("treeitem");
    // 줄 수 — 목록은 보이는 줄만 그리므로(가상화) 맨 위 줄의 aria-setsize 로 셈다
    const expectRowCount = async (count: number, timeout = 15_000) =>
      await expect(historyRowAt(pane, 1)).toHaveAttribute("aria-setsize", String(count), {
        timeout,
      });
    const editor = workbox.locator(".editor-instance .view-lines");
    // 파일 에디터 탭 — diff 탭 제목도 파일 이름으로 시작하므로 뺀다
    const diffTab = workbox.locator(".tab", { hasText: "(change at" });
    const tab = workbox.locator(".tab", { hasText: fileName }).filter({ hasNotText: "(change at" });

    fs.writeFileSync(filePath, "first change\n");
    await expect(rows).toHaveCount(baseline + 1, { timeout: 15_000 });
    fs.writeFileSync(filePath, "second change\n");
    await expect(rows).toHaveCount(baseline + 2, { timeout: 15_000 });
    await expect(editor).toContainText("second change", { timeout: 15_000 });

    // 미저장 편집 — 키 입력은 창 포커스 없으면 간헐 유실이라 재시도
    await retryAction(
      async () => {
        await editor.click();
        await workbox.keyboard.type("unsaved edit ");
      },
      async () => {
        await expect(tab).toHaveClass(/dirty/, { timeout: 3_000 });
      },
    );

    // "second change" 줄 복원 — 그 변경 직전(first change)으로. 확인 창이 미저장 편집 저장을 밝힌다
    await openRestoreDialog(workbox, historyRowAt(pane, 1));
    await expect(dialog(workbox)).toContainText("Restore 1 file(s) to before the change at ");
    await expect(dialog(workbox)).toContainText(
      "Unsaved edits will be saved first and kept in Local History.",
    );
    await workbox.screenshot({ path: path.join(shotDir, "restore-dialog-file.png") });
    await answerDialog(workbox, "Restore");
    await expect(toast(workbox, "Restored 1 file(s).")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => fs.readFileSync(filePath, "utf8"), { timeout: 15_000 })
      .toBe("first change\n");
    // 열린 에디터는 저장돼 깨끗하고, 복원 내용을 보인다
    await expect(editor).toContainText("first change", { timeout: 15_000 });
    await expect(editor).not.toContainText("unsaved edit");
    await expect(tab).not.toHaveClass(/dirty/);
    await workbox.screenshot({ path: path.join(shotDir, "restore-file-done.png") });

    // 줄 = [복원, 복원 직전 기록(미저장 편집), second change, first change, 웜업…]
    await expectRowCount(baseline + 4);
    const { original, modified } = diffSidesOf(workbox);
    await retryAction(
      async () => {
        await historyRowAt(pane, 2).click();
      },
      async () => {
        await expect(original).toContainText("second change", { timeout: 5_000 });
        await expect(modified).toContainText("unsaved edit", { timeout: 5_000 });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "restore-file-saved-edit.png") });
    await diffTab.getByRole("button", { name: /Close/ }).click();
    await expect(diffTab).toHaveCount(0);

    // 복원도 복원한다 — 복원 줄의 직전 = 복원 직전 기록. 마지막 기록과 같아서 복원 직전 기록은 생략된다
    await openRestoreDialog(workbox, historyRowAt(pane, 1));
    await expect(dialog(workbox)).toContainText("Restore 1 file(s) to before the change at ");
    await expect(dialog(workbox)).not.toContainText("Unsaved edits");
    await answerDialog(workbox, "Restore");
    await expect
      .poll(() => fs.readFileSync(filePath, "utf8"), { timeout: 15_000 })
      .toContain("unsaved edit");
    await expectRowCount(baseline + 5);
    await workbox.waitForTimeout(1_500); // 저장한 편집의 뒤늦은 이벤트가 줄을 더 만들지 않는다
    await expectRowCount(baseline + 5);
    await workbox.screenshot({ path: path.join(shotDir, "restore-file-restored-back.png") });

    // 복원 뒤 편집 · 저장 — "디스크 파일이 더 최신" 충돌 없이 저장된다
    await expect(editor).toContainText("unsaved edit", { timeout: 15_000 });
    await expect(tab).not.toHaveClass(/dirty/);
    await retryAction(
      async () => {
        await editor.click();
        await workbox.keyboard.type("after restore ");
      },
      async () => {
        await expect(tab).toHaveClass(/dirty/, { timeout: 3_000 });
      },
    );
    await retryAction(
      async () => {
        await editor.click();
        await workbox.keyboard.press("Control+S");
      },
      async () => {
        await expect(tab).not.toHaveClass(/dirty/, { timeout: 3_000 });
      },
    );
    expect(fs.readFileSync(filePath, "utf8")).toContain("after restore");
    await expect(workbox.locator(".notification-toast").filter({ hasText: "newer" })).toHaveCount(
      0,
    );
    await expect(dialog(workbox)).toHaveCount(0);
    await workbox.screenshot({ path: path.join(shotDir, "restore-file-saved-after.png") });
  } finally {
    await app.close();
    fs.rmSync(filePath, { force: true });
  }
});

test("폴더 이력 — 고른 변경의 파일만 그 직전으로 놓고, 이름 변경을 되돌리며, 복원 중에는 복원 버튼이 숨는다", async ({
  vscodeExePath,
}, testInfo) => {
  test.slow(); // 변경 네 줄 + 복원 다섯 번 — 기본 제한 시간을 넘는다
  const folderName = "local-history-restore-folder";
  const bulkName = "local-history-restore-bulk";
  const warmupName = "local-history-restore-warmup.txt";
  const folderPath = path.join(workspaceDir, folderName);
  const bulkPath = path.join(workspaceDir, bulkName);
  const warmupPath = path.join(workspaceDir, warmupName);
  const file = (name: string) => path.join(folderPath, name);
  const bulkCount = 300;
  const bulkFile = (index: number) => path.join(bulkPath, `f${String(index).padStart(3, "0")}.txt`);
  fs.rmSync(folderPath, { recursive: true, force: true });
  fs.rmSync(bulkPath, { recursive: true, force: true });
  // 기동 전에 만든다 — 기동 스캔이 한 줄로 기록한다. keep/empty-before 는 복원 전부터 있던 빈 폴더
  fs.mkdirSync(path.join(folderPath, "inner"), { recursive: true });
  fs.mkdirSync(path.join(folderPath, "keep", "empty-before"), { recursive: true });
  fs.writeFileSync(file("alpha.txt"), "alpha 1\n");
  fs.writeFileSync(file("bravo.txt"), "bravo 1\n");
  fs.writeFileSync(file("delta.txt"), "delta 1\n");
  fs.writeFileSync(file("inner/xray.txt"), "xray 1\n");
  fs.mkdirSync(bulkPath, { recursive: true });
  for (let index = 0; index < bulkCount; index++) fs.writeFileSync(bulkFile(index), "v1\n");
  fs.writeFileSync(warmupPath, "initial\n");
  const userDataDir = testInfo.outputPath("user-data");
  const app = await launchVsCode(
    vscodeExePath,
    { extensionsDir: testInfo.outputPath("extensions"), userDataDir },
    customDialog,
  );
  try {
    const workbox = await app.firstWindow();
    const folderItem = workbox.getByRole("treeitem", { name: folderName, exact: true });
    await folderItem.waitFor({ state: "visible", timeout: 30_000 });
    await folderItem.click(); // 펼친다 — 아래 inner 이름 변경에 쓴다
    await prepareRecording(workbox, warmupName, warmupPath);
    const recorded = () => countSnapshots(userDataDir);

    // 변경 1(한 줄) — alpha 수정 · charlie 생성 · delta 삭제 · 새 폴더 newdir/nested 에 note 생성 ·
    // 원래 빈 폴더만 담은 keep 에 kfile 생성
    let base = recorded();
    fs.writeFileSync(file("alpha.txt"), "alpha 2\n");
    fs.writeFileSync(file("charlie.txt"), "charlie 1\n");
    fs.rmSync(file("delta.txt"));
    fs.mkdirSync(file("newdir/nested"), { recursive: true });
    fs.writeFileSync(file("newdir/nested/note.txt"), "note 1\n");
    fs.writeFileSync(file("keep/kfile.txt"), "kfile 1\n");
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 1);
    // 변경 2 — 변경 1 뒤의 무관한 수정
    base = recorded();
    fs.writeFileSync(file("bravo.txt"), "bravo 2\n");
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 1);
    // 변경 3 — bulk 전부 수정(아래 복원 중 버튼 숨김을 보려고 파일을 많이)
    base = recorded();
    for (let index = 0; index < bulkCount; index++) fs.writeFileSync(bulkFile(index), "v2\n");
    await expect.poll(recorded, { timeout: 30_000 }).toBeGreaterThanOrEqual(base + 1);
    // 변경 4 — 탐색기에서 inner → inner-renamed 이름 변경 (onDidRenameFiles)
    base = recorded();
    const innerItem = workbox.getByRole("treeitem", { name: "inner", exact: true });
    const renamedItem = workbox.getByRole("treeitem", { name: "inner-renamed", exact: true });
    const renameInput = workbox.locator(".explorer-folders-view .monaco-inputbox input");
    // 하네스 창은 document.hasFocus() 가 false 라 rename 입력창이 즉시 닫힌다 — rename.spec 과 같은 스텁
    await workbox.evaluate(() => (document.hasFocus = () => true));
    await retryAction(
      async () => {
        await innerItem.click();
        await innerItem.press("F2");
        await renameInput.waitFor({ state: "visible", timeout: 2_000 }); // 미표시면 이 시도는 실패 — 재시도
        await renameInput.fill("inner-renamed");
        await renameInput.press("Enter");
      },
      async () => {
        await expect(renamedItem).toBeVisible({ timeout: 3_000 });
      },
    );
    await expect.poll(recorded, { timeout: 15_000 }).toBeGreaterThanOrEqual(base + 1);
    expect(fs.existsSync(file("inner-renamed/xray.txt"))).toBe(true);

    // 폴더 이력 — 줄 = [이름 변경, bravo 수정, 변경 1, 기동 스캔…]
    await showHistoryViaContextMenu(workbox, folderItem, folderName);
    const pane = historyPaneOf(workbox);
    const row = (position: number) => historyRowAt(pane, position);
    await expect(row(3).locator(".label-description")).toHaveText("kfile.txt and 4 more", {
      timeout: 15_000,
    });
    await expect(row(2).locator(".label-description")).toHaveText("bravo.txt");
    await expect(row(1).locator(".label-description")).toHaveText("xray.txt");

    // 변경 1 줄 복원 — alpha 되돌림 · charlie · note · kfile 지움 · delta 되살림. 뒤의 bravo 수정 · 이름 변경은 그대로
    await openRestoreDialog(workbox, row(3));
    await expect(dialog(workbox)).toContainText("Restore 5 file(s) to before the change at ");
    await expect(dialog(workbox)).toContainText(
      "3 file(s) that did not exist before the change will be deleted.",
    );
    await expect(dialog(workbox)).not.toContainText("outside the folder");
    await expect(dialog(workbox)).not.toContainText("Unsaved edits");
    await workbox.screenshot({ path: path.join(shotDir, "restore-dialog-folder.png") });
    await answerDialog(workbox, "Restore");
    await expect(toast(workbox, "Restored 5 file(s).")).toBeVisible({ timeout: 15_000 });
    expect(fs.readFileSync(file("alpha.txt"), "utf8")).toBe("alpha 1\n");
    expect(fs.existsSync(file("charlie.txt"))).toBe(false);
    expect(fs.readFileSync(file("delta.txt"), "utf8")).toBe("delta 1\n");
    expect(fs.readFileSync(file("bravo.txt"), "utf8")).toBe("bravo 2\n");
    expect(fs.readFileSync(file("inner-renamed/xray.txt"), "utf8")).toBe("xray 1\n");
    expect(fs.existsSync(file("inner/xray.txt"))).toBe(false);
    // 복원이 비게 만든 폴더는 위로 이어서 지워진다(newdir/nested → newdir). 복원 전부터 있던 빈 폴더와
    // 그것을 담은 keep 은 남는다
    expect(fs.existsSync(file("newdir"))).toBe(false);
    expect(fs.existsSync(file("keep/kfile.txt"))).toBe(false);
    expect(fs.existsSync(file("keep/empty-before"))).toBe(true);
    // 복원 줄이 맨 위에 생긴다 — 복원 직전 기록은 마지막 기록과 같아 생략
    await expect(row(1).locator(".label-description")).toHaveText("kfile.txt and 4 more", {
      timeout: 15_000,
    });
    await expect(row(2).locator(".label-description")).toHaveText("xray.txt");
    await workbox.screenshot({ path: path.join(shotDir, "restore-folder-done.png") });

    // 폴더 경계를 넘은 이동 — inner-renamed 의 이력에서 xray 는 밖(inner)에서 들어왔다.
    // 확인 창이 폴더 밖 경로가 바뀜을 밝힌다. 취소하면 아무것도 바뀌지 않는다
    await showHistoryViaContextMenu(workbox, renamedItem, `${folderName}/inner-renamed`);
    await expect(row(1).locator(".label-description")).toHaveText("xray.txt", {
      timeout: 15_000,
    });
    await openRestoreDialog(workbox, row(1));
    await expect(dialog(workbox)).toContainText("Restore 1 file(s) to before the change at ");
    await expect(dialog(workbox)).toContainText(
      "1 file(s) moved across the folder boundary will be moved back, so paths outside the folder also change.",
    );
    await workbox.screenshot({ path: path.join(shotDir, "restore-dialog-outside.png") });
    await answerDialog(workbox, "Cancel");
    await workbox.waitForTimeout(1_000);
    expect(fs.existsSync(file("inner-renamed/xray.txt"))).toBe(true);
    expect(fs.existsSync(file("inner/xray.txt"))).toBe(false);

    // 폴더 이력의 이름 변경 줄 복원 — 옛 경로를 되살리고 새 경로를 지운다
    await showHistoryViaContextMenu(workbox, folderItem, folderName);
    await expect(row(2).locator(".label-description")).toHaveText("xray.txt", {
      timeout: 15_000,
    });
    await openRestoreDialog(workbox, row(2));
    await expect(dialog(workbox)).toContainText("Restore 1 file(s) to before the change at ");
    await expect(dialog(workbox)).not.toContainText("will be deleted");
    await answerDialog(workbox, "Restore");
    await expect.poll(() => fs.existsSync(file("inner/xray.txt")), { timeout: 15_000 }).toBe(true);
    expect(fs.readFileSync(file("inner/xray.txt"), "utf8")).toBe("xray 1\n");
    // 이름 변경으로 생긴 새 폴더는 남지 않는다
    expect(fs.existsSync(file("inner-renamed"))).toBe(false);
    await expect(toast(workbox, "Restored 1 file(s).")).toBeVisible({ timeout: 15_000 });
    await expect(innerItem).toBeVisible({ timeout: 15_000 });
    await expect(renamedItem).toBeHidden({ timeout: 15_000 });
    // 복원 줄이 더해졌다 — 목록은 보이는 줄만 그리므로 줄 수는 aria-setsize 로 셈다
    await expect(row(1)).toHaveAttribute("aria-setsize", "6", { timeout: 15_000 });
    await workbox.screenshot({ path: path.join(shotDir, "restore-folder-renamed-back.png") });

    // 복원 줄도 이름 변경 항목 하나다(생성 + 삭제로 갈리지 않는다) — spec 「3. 열람」
    await expect(row(1).locator(".label-description")).toHaveText("xray.txt");
    if ((await row(1).getAttribute("aria-expanded")) !== "true") {
      await row(1).locator(".monaco-tl-twistie").click();
    }
    const xrayEntry = itemOf(pane, "xray.txt");
    await expect(xrayEntry.locator(".label-description")).toHaveText(
      `renamed from ${folderName}/inner-renamed/xray.txt`,
      { timeout: 5_000 },
    );
    // 줄 아래 = 폴더 inner 와 그 아래 xray.txt 둘뿐(생성 + 삭제였다면 inner-renamed 쪽 항목까지 넷)
    await expect(pane.locator(".monaco-list-row:not([aria-level='1'])")).toHaveCount(2);
    await workbox.screenshot({ path: path.join(shotDir, "restore-folder-rename-row.png") });

    // 그 항목 하나만 복원 — 파일은 두 곳에 생기거나 사라지지 않고 inner-renamed 한 곳으로 옮겨진다
    await openRestoreDialog(workbox, xrayEntry);
    await expect(dialog(workbox)).toContainText("Restore 1 file(s) to before the change at ");
    await expect(dialog(workbox)).not.toContainText("will be deleted");
    await answerDialog(workbox, "Restore");
    await expect
      .poll(() => fs.existsSync(file("inner-renamed/xray.txt")), { timeout: 15_000 })
      .toBe(true);
    expect(fs.readFileSync(file("inner-renamed/xray.txt"), "utf8")).toBe("xray 1\n");
    expect(fs.existsSync(file("inner"))).toBe(false);
    await expect(row(1)).toHaveAttribute("aria-setsize", "7", { timeout: 15_000 });
    await expect(row(1).locator(".label-description")).toHaveText("xray.txt");

    // 파일 이력 — 이름 변경 · 복원을 넘어 체인이 이어진다:
    // [항목 복원(inner 에서), 줄 복원(inner-renamed 에서), 이름 변경(inner 에서), 기동 스캔]
    const explorerTree = workbox.locator(".explorer-folders-view");
    const xrayFile = explorerTree.getByRole("treeitem", { name: "xray.txt", exact: true });
    await retryAction(
      async () => {
        if (!(await xrayFile.isVisible())) await renamedItem.click(); // inner-renamed 펼치기
      },
      async () => {
        await expect(xrayFile).toBeVisible({ timeout: 3_000 });
      },
    );
    await showHistoryViaContextMenu(workbox, xrayFile, `${folderName}/inner-renamed/xray.txt`);
    await expect(row(1)).toHaveAttribute("aria-setsize", "4", { timeout: 15_000 });
    await expect(row(1).locator(".label-description")).toHaveText(
      `renamed from ${folderName}/inner/xray.txt`,
    );
    await expect(row(2).locator(".label-description")).toHaveText(
      `renamed from ${folderName}/inner-renamed/xray.txt`,
    );
    await expect(row(3).locator(".label-description")).toHaveText(
      `renamed from ${folderName}/inner/xray.txt`,
    );
    await expect(row(4)).not.toContainText("renamed");
    await workbox.screenshot({ path: path.join(shotDir, "restore-file-chain.png") });

    // bulk 폴더 이력 — 줄 = [bulk 수정, 기동 스캔]
    const bulkItem = workbox.getByRole("treeitem", { name: bulkName, exact: true });
    await showHistoryViaContextMenu(workbox, bulkItem, bulkName);
    await expect(row(1).locator(".label-description")).toHaveText(
      `f000.txt and ${bulkCount - 1} more`,
      { timeout: 15_000 },
    );

    // 파일 항목 여럿을 고르고 그중 하나의 복원 버튼 — 고른 파일들만. 취소한다
    await row(1).locator(".monaco-tl-twistie").click();
    const first = itemOf(pane, "f000.txt");
    const second = itemOf(pane, "f001.txt");
    await expect(second).toBeVisible({ timeout: 5_000 });
    await retryAction(
      async () => {
        await first.click();
        await second.click({ modifiers: ["Control"] });
      },
      async () => {
        await expect(first).toHaveAttribute("aria-selected", "true", { timeout: 3_000 });
        await expect(second).toHaveAttribute("aria-selected", "true", { timeout: 3_000 });
      },
    );
    await openRestoreDialog(workbox, second);
    await expect(dialog(workbox)).toContainText("Restore 2 file(s) to before the change at ");
    await workbox.screenshot({ path: path.join(shotDir, "restore-dialog-items.png") });
    await answerDialog(workbox, "Cancel");

    // 쓰기 도중 실패 — 마지막 파일(f299)이 읽기 전용이다. 앞의 299개를 쓴 뒤 실패하고, 쓴 파일을 복원 전 내용으로
    // 되돌린다. 알림은 실패 원인과 "파일은 바뀌지 않았다"를 밝힌다
    fs.chmodSync(bulkFile(bulkCount - 1), 0o444);
    await openRestoreDialog(workbox, row(1));
    await expect(dialog(workbox)).toContainText(
      `Restore ${bulkCount} file(s) to before the change at `,
    );
    await answerDialog(workbox, "Restore");
    const failed = toast(
      workbox,
      "Local History failed to restore. No files were changed. Cause: ",
    );
    await expect(failed).toBeVisible({ timeout: 30_000 });
    await expect(failed).toContainText("EPERM");
    for (let index = 0; index < bulkCount; index++) {
      expect(fs.readFileSync(bulkFile(index), "utf8")).toBe("v2\n");
    }
    await expect(restoreButtonsOf(pane).first()).toBeAttached({ timeout: 5_000 });
    await workbox.screenshot({ path: path.join(shotDir, "restore-bulk-failed.png") });
    // 이력의 마지막 상태 = 디스크(v2) — 쓰기와 되돌리기는 일어난 대로 기록되고, 끝 상태가 어긋나지 않는다
    const v2Hash = createHash("sha1").update("v2\n").digest("hex");
    const lastRecorded = (): Map<string, string | null> => {
      const last = new Map<string, string | null>();
      const log = fs.readFileSync(path.join(storeDirOf(userDataDir), "snapshots.jsonl"), "utf8");
      for (const line of log.split("\n").filter((text) => text !== "")) {
        const snapshot = JSON.parse(line) as { entries: { path: string; hash: string | null }[] };
        for (const entry of snapshot.entries) last.set(entry.path, entry.hash);
      }
      return last;
    };
    await expect
      .poll(
        () => {
          const last = lastRecorded();
          return Array.from({ length: bulkCount }, (_, index) =>
            last.get(`${bulkName}/f${String(index).padStart(3, "0")}.txt`),
          ).every((hash) => hash === v2Hash);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    await workbox.waitForTimeout(1_500); // 기록 정착 — 아래에서 줄 수를 기준으로 쓴다
    fs.chmodSync(bulkFile(bulkCount - 1), 0o644);

    // bulk 수정 줄 복원 — 복원하는 동안 진행 알림이 뜨고 목록의 복원 버튼이 모두 숨는다.
    // 짧은 상태라 렌더러의 DOM 변화마다 (진행 알림, 복원 버튼 수)를 남겨 판정한다.
    // 줄 = [(실패한 복원의 쓰기 · 되돌리기가 남긴 줄…), bulk 수정, 기동 스캔] — bulk 수정은 끝에서 둘째
    const rowCount = Number(await row(1).getAttribute("aria-setsize"));
    const bulkRow = row(rowCount - 1);
    await expect(bulkRow.locator(".label-description")).toHaveText(
      `f000.txt and ${bulkCount - 1} more`,
    );
    await expect(restoreButtonsOf(pane).first()).toBeAttached();
    await openRestoreDialog(workbox, bulkRow);
    await expect(dialog(workbox)).toContainText(
      `Restore ${bulkCount} file(s) to before the change at `,
    );
    await pane.evaluate((paneElement, label) => {
      const samples: { progress: boolean; buttons: number }[] = [];
      const sample = () => {
        const progress = [...document.querySelectorAll(".notification-toast")].some(
          (toastElement) => toastElement.textContent?.includes("Restoring "),
        );
        const buttons = paneElement.querySelectorAll(`.action-label[aria-label="${label}"]`).length;
        samples.push({ progress, buttons });
      };
      new MutationObserver(sample).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      (window as unknown as { restoreSamples: typeof samples }).restoreSamples = samples;
    }, restoreLabel);
    await answerDialog(workbox, "Restore");
    await expect(toast(workbox, `Restored ${bulkCount} file(s).`)).toBeVisible({ timeout: 30_000 });
    const samples = await workbox.evaluate(
      () =>
        (window as unknown as { restoreSamples: { progress: boolean; buttons: number }[] })
          .restoreSamples,
    );
    // 진행 알림이 보이는 동안 복원 버튼이 없다
    console.log(
      `restore samples: ${samples.length}, progress ${samples.filter((state) => state.progress).length}, ` +
        `progress+hidden ${samples.filter((state) => state.progress && state.buttons === 0).length}, ` +
        `progress+shown ${samples.filter((state) => state.progress && state.buttons > 0).length}`,
    );
    expect(samples.some((state) => state.progress && state.buttons === 0)).toBe(true);
    // 끝나면 다시 보인다
    await expect(restoreButtonsOf(pane).first()).toBeAttached({ timeout: 5_000 });
    for (let index = 0; index < bulkCount; index++) {
      expect(fs.readFileSync(bulkFile(index), "utf8")).toBe("v1\n");
    }
    // 복원 줄이 더해졌다
    await expect(row(1)).toHaveAttribute("aria-setsize", String(rowCount + 1), { timeout: 15_000 });
    await workbox.screenshot({ path: path.join(shotDir, "restore-bulk-done.png") });
  } finally {
    await app.close();
    fs.rmSync(folderPath, { recursive: true, force: true });
    if (fs.existsSync(bulkFile(bulkCount - 1))) fs.chmodSync(bulkFile(bulkCount - 1), 0o644);
    fs.rmSync(bulkPath, { recursive: true, force: true });
    fs.rmSync(warmupPath, { force: true });
  }
});
