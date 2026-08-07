// 충돌 모달 시연 — dirty + 외부 변경 파일에 대해 포커스 복귀 시 파일별 모달로 결정.
// 대상 파일은 워처 제외(files.watcherExclude)로 내장 동작과 격리 (reload.spec 과 동일).
import path from "node:path";
import fs from "node:fs";
import { type ElectronApplication, type Page } from "@playwright/test";
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
const fileName = "focus-conflict-target.txt";
const filePath = path.join(workspaceDir, fileName);

async function launchWithConflict(
  vscodeExePath: string,
  testInfo: { outputPath(name: string): string },
  locale?: string,
): Promise<{ app: ElectronApplication; workbox: Page }> {
  fs.writeFileSync(filePath, "original content\n");
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    {
      locale,
      settings: {
        "files.watcherExclude": { [`**/${fileName}`]: true },
        // 네이티브 다이얼로그는 DOM 단언 불가 — 커스텀(DOM) 다이얼로그 강제
        "window.dialogStyle": "custom",
      },
    },
  );
  const workbox = await app.firstWindow();

  // 파일 열고 타이핑으로 dirty 상태 생성 — 키 입력은 창 포커스 없으면 간헐 유실이라 재시도
  const treeItem = workbox.getByRole("treeitem", { name: fileName });
  await treeItem.waitFor({ state: "visible", timeout: 30_000 });
  await treeItem.click();
  const editor = workbox.locator(".editor-instance .view-lines");
  await expect(editor).toContainText("original content", { timeout: 30_000 });
  const tab = workbox.getByRole("tab", { name: new RegExp(fileName) });

  // 확장 활성화(onStartupFinished)가 끝나기 전의 외부 수정은 원본 스냅샷에 흡수됨 —
  // 조용한 리로드 1회가 성립할 때까지 재시도해 활성화 완료를 확인한 뒤 충돌을 만든다.
  fs.writeFileSync(filePath, "activation probe\n");
  await retryAction(
    async () => {
      await simulateFocusRegain(app, workbox);
    },
    async () => {
      await expect(editor).toContainText("activation probe", { timeout: 5_000 });
    },
  );
  await retryAction(
    async () => {
      await editor.click();
      await workbox.keyboard.type("edited-in-editor ");
    },
    async () => {
      await expect(tab).toHaveClass(/dirty/, { timeout: 3_000 });
    },
  );

  // 외부 도구의 파일 수정 재현 → 충돌 성립
  fs.writeFileSync(filePath, "changed on disk\n");
  return { app, workbox };
}

const dialog = (workbox: Page) => workbox.locator(".monaco-dialog-box");

test("충돌 모달: Esc(Cancel)로 유보 후 다음 포커스 때 재표시, Reload from Disk 로 리로드", async ({
  vscodeExePath,
}, testInfo) => {
  const { app, workbox } = await launchWithConflict(vscodeExePath, testInfo);
  try {
    const editor = workbox.locator(".editor-instance .view-lines");
    const tab = workbox.getByRole("tab", { name: new RegExp(fileName) });

    await simulateFocusRegain(app, workbox);
    await expect(dialog(workbox)).toContainText(`"${fileName}" has changed on disk.`, {
      timeout: 15_000,
    });
    await workbox.screenshot({ path: path.join(shotDir, "conflict-modal.png") });

    // 유보(Cancel) — dirty 와 편집 내용 유지
    await dialog(workbox).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(workbox)).toHaveCount(0);
    await expect(editor).toContainText("edited-in-editor");
    await expect(tab).toHaveClass(/dirty/);

    // 다음 포커스 복귀 때 재표시 → Reload from Disk → 디스크 버전 로드 + clean
    await simulateFocusRegain(app, workbox);
    await expect(dialog(workbox)).toContainText(`"${fileName}" has changed on disk.`, {
      timeout: 15_000,
    });
    await dialog(workbox).getByRole("button", { name: "Reload from Disk" }).click();
    await expect(editor).toContainText("changed on disk", { timeout: 15_000 });
    await expect(tab).not.toHaveClass(/dirty/);
    await workbox.screenshot({ path: path.join(shotDir, "conflict-reloaded.png") });
  } finally {
    await app.close();
    fs.rmSync(filePath, { force: true });
  }
});

test("충돌 모달: Keep Editor Version 은 재프롬프트를 억제하고, 디스크가 또 바뀌면 다시 묻는다", async ({
  vscodeExePath,
}, testInfo) => {
  const { app, workbox } = await launchWithConflict(vscodeExePath, testInfo);
  try {
    const tab = workbox.getByRole("tab", { name: new RegExp(fileName) });

    await simulateFocusRegain(app, workbox);
    await expect(dialog(workbox)).toContainText(`"${fileName}" has changed on disk.`, {
      timeout: 15_000,
    });
    await dialog(workbox).getByRole("button", { name: "Keep Editor Version" }).click();
    await expect(dialog(workbox)).toHaveCount(0);
    // dirty 유지 + 디스크 미덮어쓰기
    await expect(tab).toHaveClass(/dirty/);
    expect(fs.readFileSync(filePath, "utf8")).toBe("changed on disk\n");

    // 같은 디스크 버전이면 재프롬프트하지 않는다
    await simulateFocusRegain(app, workbox);
    await workbox.waitForTimeout(2000);
    await expect(dialog(workbox)).toHaveCount(0);

    // 디스크가 또 바뀌면 다시 묻는다
    fs.writeFileSync(filePath, "changed on disk again\n");
    await simulateFocusRegain(app, workbox);
    await expect(dialog(workbox)).toContainText(`"${fileName}" has changed on disk.`, {
      timeout: 15_000,
    });
    await workbox.screenshot({ path: path.join(shotDir, "conflict-reprompt.png") });
    await dialog(workbox).getByRole("button", { name: "Cancel" }).click();
  } finally {
    await app.close();
    fs.rmSync(filePath, { force: true });
  }
});

test("한국어 로케일에서 충돌 모달이 번역되어 뜨고 동작한다", async ({
  vscodeExePath,
}, testInfo) => {
  // VS Code 는 기동 시점에 이미 등록된 언어 팩만 쓴다 — 첫 기동이 팩을 등록하고,
  // languagepacks.json 이 생긴 뒤의 기동부터 한국어가 된다.
  const userDataDir = testInfo.outputPath("user-data");
  const firstRun = await launchVsCode(
    vscodeExePath,
    { extensionsDir: testInfo.outputPath("extensions"), userDataDir },
    { locale: "ko" },
  );
  await expect
    .poll(() => fs.existsSync(path.join(userDataDir, "languagepacks.json")), {
      timeout: 60_000,
    })
    .toBe(true);
  await firstRun.close();

  const { app, workbox } = await launchWithConflict(vscodeExePath, testInfo, "ko");
  try {
    const editor = workbox.locator(".editor-instance .view-lines");

    await simulateFocusRegain(app, workbox);
    await expect(dialog(workbox)).toContainText(
      `"${fileName}" 파일이 디스크에서 변경되었습니다.`,
      { timeout: 15_000 },
    );
    await workbox.screenshot({ path: path.join(shotDir, "conflict-modal-ko.png") });
    await dialog(workbox).getByRole("button", { name: "디스크에서 다시 불러오기" }).click();
    await expect(editor).toContainText("changed on disk", { timeout: 15_000 });
  } finally {
    await app.close();
    fs.rmSync(filePath, { force: true });
  }
});
