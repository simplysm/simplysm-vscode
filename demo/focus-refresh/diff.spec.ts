// Show Diff 시연 — 충돌 모달에서 Show Diff 선택 시 디스크 ↔ 에디터 diff 가 열리고 결정은 유보된다.
import path from "node:path";
import fs from "node:fs";
import {
  expect,
  launchVsCode,
  retryAction,
  runResultsDir,
  test,
  workspaceDir,
} from "../fixtures.ts";
import { simulateFocusRegain } from "./focus-utils.ts";

const shotDir = path.join(runResultsDir, "focus-refresh");
const fileName = "focus-diff-target.txt";
const filePath = path.join(workspaceDir, fileName);

test("충돌 모달: Show Diff 로 디스크↔에디터 diff 를 열고 다음 포커스 때 재표시된다", async ({
  vscodeExePath,
}, testInfo) => {
  fs.writeFileSync(filePath, "original content\n");
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    {
      settings: {
        "files.watcherExclude": { [`**/${fileName}`]: true },
        "window.dialogStyle": "custom",
      },
    },
  );
  try {
    const workbox = await app.firstWindow();
    const dialog = workbox.locator(".monaco-dialog-box");

    const treeItem = workbox.getByRole("treeitem", { name: fileName });
    await treeItem.waitFor({ state: "visible", timeout: 30_000 });
    await treeItem.click();
    const editor = workbox.locator(".editor-instance .view-lines");
    await expect(editor).toContainText("original content", { timeout: 30_000 });
    const tab = workbox.getByRole("tab", { name: new RegExp(fileName) });

    // 활성화 프로브 (plan "데모 하네스 확인 사항")
    fs.writeFileSync(filePath, "activation probe\n");
    await retryAction(
      async () => {
        await simulateFocusRegain(app, workbox);
      },
      async () => {
        await expect(editor).toContainText("activation probe", { timeout: 5_000 });
      },
    );

    // dirty + 외부 변경 → 충돌
    await retryAction(
      async () => {
        await editor.click();
        await workbox.keyboard.type("edited-in-editor ");
      },
      async () => {
        await expect(tab).toHaveClass(/dirty/, { timeout: 3_000 });
      },
    );
    fs.writeFileSync(filePath, "changed on disk\n");

    await simulateFocusRegain(app, workbox);
    await expect(dialog).toContainText(`"${fileName}" has changed on disk.`, {
      timeout: 15_000,
    });
    await dialog.getByRole("button", { name: "Show Diff" }).click();

    // diff 에디터 열림 — 좌: 디스크 버전, 우: 에디터 버전
    const diffEditor = workbox.locator(".monaco-diff-editor");
    await expect(diffEditor).toBeVisible({ timeout: 15_000 });
    // [data-mprt="8"] = 실제 라인 컨테이너 — diff view-zone(.view-lines.line-delete) 중복 매칭 배제
    await expect(
      diffEditor.locator('.editor.original .view-lines[data-mprt="8"]'),
    ).toContainText("changed on disk");
    await expect(
      diffEditor.locator('.editor.modified .view-lines[data-mprt="8"]'),
    ).toContainText("edited-in-editor");
    await workbox.screenshot({ path: path.join(shotDir, "conflict-diff.png") });

    // 결정 유보 — 다음 포커스 복귀 때 재표시
    await simulateFocusRegain(app, workbox);
    await expect(dialog).toContainText(`"${fileName}" has changed on disk.`, {
      timeout: 15_000,
    });
    await dialog.getByRole("button", { name: "Cancel" }).click();
  } finally {
    await app.close();
    fs.rmSync(filePath, { force: true });
  }
});
