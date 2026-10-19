// 슬라이스 8 시연 — 한국어 표시 언어에서 명령 제목(nls)·뷰 이름·런타임 문자열(l10n 번들)이 한국어로 보인다.
// VS Code 는 기동 시점에 이미 등록된 언어 팩만 쓴다 — 첫 기동이 팩을 등록하고,
// languagepacks.json 이 생긴 뒤의 기동부터 한국어가 된다 (focus-refresh conflict.spec 과 동일).
import path from "node:path";
import fs from "node:fs";
import {
  expect,
  launchVsCode,
  retryAction,
  runResultsDir,
  runCommand,
  test,
  workspaceDir,
} from "../fixtures.ts";
import {
  activeTabOf,
  historyPaneOf,
  historyRowAt,
  showHistoryViaContextMenu,
  storeDirOf,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-l10n-target.txt";
const folderName = "local-history-l10n-folder";
const emptyName = "local-history-l10n-empty";
const koreanLabels = { menu: "이력 보기", pane: "로컬 이력" };

test("한국어 UI — 명령 제목·뷰 이름·알림이 한국어로 보인다", async ({
  vscodeExePath,
}, testInfo) => {
  const filePath = path.join(workspaceDir, fileName);
  const folderPath = path.join(workspaceDir, folderName);
  const emptyPath = path.join(workspaceDir, emptyName);
  fs.rmSync(folderPath, { recursive: true, force: true });
  fs.rmSync(emptyPath, { recursive: true, force: true });
  fs.writeFileSync(filePath, "initial\n");
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  try {
    // 폴더 이력의 첫 줄 — 1차 기동 스캔이 a · b 를 한 줄로 기록한다
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(path.join(folderPath, "a.txt"), "a\n");
    fs.writeFileSync(path.join(folderPath, "b.txt"), "b\n");

    // 1차 기동 — 언어 팩 등록. 기동 스캔의 기록도 기다린다
    const firstRun = await launchVsCode(vscodeExePath, dirs, { locale: "ko" });
    const folderRecorded = (): boolean => {
      try {
        const log = fs.readFileSync(path.join(storeDirOf(dirs.userDataDir), "snapshots.jsonl"), "utf8");
        return log.includes(`"${folderName}/a.txt"`) && log.includes(`"${folderName}/b.txt"`);
      } catch {
        return false; // 저장소가 아직 없다
      }
    };
    await expect
      .poll(() => fs.existsSync(path.join(dirs.userDataDir, "languagepacks.json")), {
        timeout: 60_000,
      })
      .toBe(true);
    await expect.poll(folderRecorded, { timeout: 60_000 }).toBe(true);
    await firstRun.close();

    // 폴더 이력의 둘째 줄 — 2차 기동 스캔이 c 를 기록한다
    fs.mkdirSync(emptyPath, { recursive: true });
    fs.writeFileSync(path.join(folderPath, "c.txt"), "c\n");

    // 2차 기동 — 한국어 UI. 복원 확인 창을 DOM 으로 보려고 커스텀 다이얼로그를 쓴다
    const app = await launchVsCode(vscodeExePath, dirs, {
      locale: "ko",
      settings: { "window.dialogStyle": "custom" },
    });
    try {
      const workbox = await app.firstWindow();
      const treeItem = workbox.getByRole("treeitem", { name: fileName });
      await treeItem.waitFor({ state: "visible", timeout: 30_000 });

      // 파일을 열지 않은 채 한국어 명령 제목(nls)으로 실행 → 런타임 번들(l10n) 경고가 한국어로
      await runCommand(workbox, "이력 보기");
      await expect(
        workbox.locator(".notification-toast").filter({ hasText: "이력을 보려면 파일을 여세요." }),
      ).toBeVisible({ timeout: 15_000 });

      // 파일을 열고 다시 실행 → 뷰 이름(nls) "로컬 이력" pane 표시
      await treeItem.click();
      await expect(workbox.locator(".editor-instance .view-lines")).toContainText("initial", {
        timeout: 30_000,
      });
      await runCommand(workbox, "이력 보기");
      await workbox
        .locator(".pane-header", { hasText: "로컬 이력" })
        .waitFor({ state: "visible", timeout: 15_000 });
      await workbox.screenshot({ path: path.join(shotDir, "l10n-ko.png") });

      // 변경 목록 문구 — 폴더 줄 요약, 변경 종류, 빈 목록 안내
      const pane = historyPaneOf(workbox, koreanLabels);
      const folderItem = workbox.getByRole("treeitem", { name: folderName, exact: true });
      await showHistoryViaContextMenu(workbox, folderItem, folderName, koreanLabels);
      // 줄 = [c 생성, a · b 생성]
      const topRow = historyRowAt(pane, 1);
      const row = historyRowAt(pane, 2);
      await expect(row.locator(".label-description")).toHaveText("a.txt 외 1개", {
        timeout: 15_000,
      });
      await expect(topRow.locator(".label-description")).toHaveText("c.txt");
      // 시각은 VS Code 표시 언어(한국어) 형식 — 맨 위 줄은 날짜까지, 같은 날의 아래 줄은 시각만
      await expect(topRow.locator(".label-name")).toHaveText(
        /^\d{4}\. \d{1,2}\. \d{1,2}\. (오전|오후) \d{1,2}:\d{2}:\d{2}$/,
      );
      await expect(row.locator(".label-name")).toHaveText(/^(오전|오후) \d{1,2}:\d{2}:\d{2}$/);
      await row.locator(".monaco-tl-twistie").click();
      await expect(pane.locator(".monaco-list-row[aria-level='2'] .label-description")).toHaveText(
        ["생성됨", "생성됨"],
        { timeout: 5_000 },
      );
      await workbox.screenshot({ path: path.join(shotDir, "l10n-ko-folder.png") });
      // diff 제목 — "폴더 (날짜 시각 변경)", 시각은 표시 언어(한국어) 형식
      await retryAction(
        async () => {
          await row.click();
        },
        async () => {
          await expect(activeTabOf(workbox)).toContainText(
            new RegExp(
              `${folderName} \\(\\d{4}\\. \\d{1,2}\\. \\d{1,2}\\. (오전|오후) \\d{1,2}:\\d{2}:\\d{2} 변경\\)`,
            ),
            { timeout: 5_000 },
          );
        },
      );
      await workbox.screenshot({ path: path.join(shotDir, "l10n-ko-diff-title.png") });
      // 범위 제목 — "폴더 (X – Y 변경)", 같은 날이라 Y 는 시각만
      const koreanTime = "(오전|오후) \\d{1,2}:\\d{2}:\\d{2}";
      await retryAction(
        async () => {
          await topRow.click({ modifiers: ["Shift"] });
        },
        async () => {
          await expect(activeTabOf(workbox)).toContainText(
            new RegExp(
              `${folderName} \\(\\d{4}\\. \\d{1,2}\\. \\d{1,2}\\. ${koreanTime} – ${koreanTime} 변경\\)`,
            ),
            { timeout: 5_000 },
          );
        },
      );
      await workbox.screenshot({ path: path.join(shotDir, "l10n-ko-range-title.png") });
      // 복원 — 범위를 고른 상태에서 줄의 복원 버튼은 범위 안에서 바뀐 파일 전부(a · b · c)를 그 범위 직전으로
      const dialog = workbox.locator(".monaco-dialog-box");
      await retryAction(
        async () => {
          if (!(await dialog.isVisible())) {
            await row.hover();
            await row.getByRole("button", { name: "이 변경 직전으로 복원" }).click();
          }
        },
        async () => {
          await expect(dialog).toContainText(
            new RegExp(
              `파일 3개를 \\d{4}\\. \\d{1,2}\\. \\d{1,2}\\. ${koreanTime} 변경 직전으로 복원할까요\\?`,
            ),
            { timeout: 3_000 },
          );
        },
      );
      await expect(dialog).toContainText("변경 직전에 없던 파일 3개는 지워집니다.");
      await workbox.screenshot({ path: path.join(shotDir, "l10n-ko-restore-dialog.png") });
      await dialog.getByRole("button", { name: "복원", exact: true }).click();
      await expect(
        workbox.locator(".notification-toast").filter({ hasText: "파일 3개를 복원했습니다." }),
      ).toBeVisible({ timeout: 15_000 });
      // 파일을 다 지워 비게 된 폴더는 복원이 지운다
      await expect.poll(() => fs.existsSync(folderPath), { timeout: 15_000 }).toBe(false);
      await expect(folderItem).toBeHidden({ timeout: 15_000 });
      await workbox.screenshot({ path: path.join(shotDir, "l10n-ko-restored.png") });
      const emptyItem = workbox.getByRole("treeitem", { name: emptyName, exact: true });
      await showHistoryViaContextMenu(workbox, emptyItem, emptyName, koreanLabels);
      await expect(pane.locator(".message")).toHaveText("아직 기록된 변경이 없습니다.", {
        timeout: 15_000,
      });
      await workbox.screenshot({ path: path.join(shotDir, "l10n-ko-empty.png") });
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(folderPath, { recursive: true, force: true });
    fs.rmSync(emptyPath, { recursive: true, force: true });
  }
});
