// 변경 목록 시연 (spec 「3. 열람」 변경 목록 · 폴더 이력의 줄 아래) — 줄 라벨, 폴더 트리와 변경 종류,
// 100줄 나눠 읽기와 "Load more…", 열린 동안의 새 기록, 빈 목록 안내, 자동 선택 없음.
// 줄이 100개를 넘는 이력은 1차 기동으로 저장소를 만든 뒤 종료 상태에서 로그에 줄로 심는다.
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { expect, launchVsCode, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import {
  activeTabOf,
  countSnapshots,
  historyPaneOf,
  prepareRecording,
  showHistoryViaContextMenu,
  storeDirOf,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const warmupName = "local-history-list-warmup.txt";

interface LoggedEntry {
  readonly path: string;
  readonly hash: string | null;
  readonly renamedFrom?: string;
}

interface LoggedSnapshot {
  readonly at: number;
  readonly entries: readonly LoggedEntry[];
}

function readLog(logPath: string): LoggedSnapshot[] {
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LoggedSnapshot);
}

/** 심는 스냅샷의 가짜 해시 — blob 은 없다(이 시연은 diff 를 열지 않는다). */
const fakeHash = (seed: string) => createHash("sha1").update(seed).digest("hex");

/** `daysAgo` 일 전 지역 시각 hh:mm:ss 의 at. */
function localAt(daysAgo: number, hours: number, minutes: number, seconds: number): number {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hours, minutes, seconds, 0);
  return date.getTime();
}

// 목록 행 DOM 은 재사용돼 화면 순서와 다를 수 있다 — 줄은 위치(aria-posinset, 1부터)로 짚는다
const rowsOf = (pane: Locator) => pane.locator(".monaco-list-row[aria-level='1']");
const rowAt = (pane: Locator, position: number) =>
  pane.locator(`.monaco-list-row[aria-level='1'][aria-posinset='${position}']`);
const rowLabel = (row: Locator) => row.locator(".label-name");
const rowDescription = (row: Locator) => row.locator(".label-description");
const selectedRows = (pane: Locator) => pane.locator(".monaco-list-row[aria-selected='true']");
const editorTabs = (workbox: Page) => workbox.locator(".tabs-container .tab");

/** 목록을 끝까지 굴린다 — 목록은 보이는 줄만 DOM 에 그린다(가상화). */
async function scrollToEnd(workbox: Page, pane: Locator): Promise<void> {
  const box = (await pane.locator(".monaco-list").boundingBox())!;
  await workbox.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const atEnd = () =>
    rowsOf(pane).evaluateAll((rows) =>
      rows.some((row) => row.getAttribute("aria-posinset") === row.getAttribute("aria-setsize")),
    );
  // 휠 한 번은 몇 줄만 굴린다 — 끝 줄이 그려질 때까지 반복
  for (let step = 0; step < 400 && !(await atEnd()); step++) {
    await workbox.mouse.wheel(0, 2_000);
  }
  await workbox.waitForTimeout(500); // 마지막 휠의 그리기 정착
  expect(await atEnd()).toBe(true);
}

test("줄 라벨 · 폴더 트리 · 100줄 나눠 읽기 · 열린 동안의 새 기록", async ({
  vscodeExePath,
}, testInfo) => {
  const folderName = "local-history-list";
  const outsideName = "local-history-list-outside"; // 폴더 경계를 넘는 이동의 바깥 폴더
  const folderPath = path.join(workspaceDir, folderName);
  const outsidePath = path.join(workspaceDir, outsideName);
  const warmupPath = path.join(workspaceDir, warmupName);
  fs.rmSync(folderPath, { recursive: true, force: true });
  fs.rmSync(outsidePath, { recursive: true, force: true });
  fs.mkdirSync(path.join(folderPath, "sub"), { recursive: true });
  fs.mkdirSync(outsidePath, { recursive: true });
  fs.writeFileSync(path.join(outsidePath, "moved.txt"), "moved\n");
  fs.writeFileSync(path.join(folderPath, "came.txt"), "came\n");
  fs.writeFileSync(path.join(folderPath, "a.txt"), "a\n");
  fs.writeFileSync(path.join(folderPath, "new.txt"), "new\n");
  fs.writeFileSync(path.join(folderPath, "sub", "b.txt"), "b\n");
  fs.writeFileSync(warmupPath, "initial\n");
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  try {
    // 1차 기동 — 기동 스캔이 워크스페이스 파일을 기록해 저장소를 만든다
    const firstApp = await launchVsCode(vscodeExePath, dirs);
    try {
      const workbox = await firstApp.firstWindow();
      await expect
        .poll(() => countSnapshots(dirs.userDataDir), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(1);
      await workbox.waitForTimeout(3_000); // 기동 스캔의 남은 기록 정착
    } finally {
      await firstApp.close();
    }

    // 종료 상태에서 폴더 이력을 심는다 — 모두 1차 기록보다 이르고, 마지막 상태는 디스크와 같다
    // (사라진 경로는 삭제로 끝낸다 — 기동 스캔이 새 줄을 만들지 않게).
    //   2일 전: 12:00:00 c.txt · old.txt · a.txt 생성, 12:00:01~04 a.txt 수정 4줄
    //   1일 전: 12:00:00 부터 1초간격 a.txt 수정 134줄, 13:00:00 폴더 트리 줄(생성 · 수정 · 삭제 · 이름 변경)
    const logPath = path.join(storeDirOf(dirs.userDataDir), "snapshots.jsonl");
    const recorded = readLog(logPath);
    const p = (name: string) => `${folderName}/${name}`;
    const o = (name: string) => `${outsideName}/${name}`;
    const seeded: LoggedSnapshot[] = [
      {
        at: localAt(2, 12, 0, 0),
        entries: [
          { path: p("a.txt"), hash: fakeHash("a0") },
          { path: p("c.txt"), hash: fakeHash("c0") },
          { path: p("old.txt"), hash: fakeHash("old0") },
          { path: p("gone.txt"), hash: fakeHash("gone0") },
          { path: o("came.txt"), hash: fakeHash("came0") },
        ],
      },
    ];
    for (let index = 1; index <= 4; index++) {
      seeded.push({
        at: localAt(2, 12, 0, index),
        entries: [{ path: p("a.txt"), hash: fakeHash(`d2-${index}`) }],
      });
    }
    for (let index = 0; index < 134; index++) {
      seeded.push({
        at: localAt(1, 12, 0, 0) + index * 1_000,
        entries: [{ path: p("a.txt"), hash: fakeHash(`d1-${index}`) }],
      });
    }
    seeded.push({
      at: localAt(1, 13, 0, 0),
      entries: [
        { path: p("a.txt"), hash: fakeHash("tree-a") },
        { path: p("sub/b.txt"), hash: fakeHash("tree-b") },
        { path: p("c.txt"), hash: null },
        { path: p("old.txt"), hash: null },
        { path: p("new.txt"), hash: fakeHash("old0"), renamedFrom: p("old.txt") },
        // 폴더 밖으로 나간 파일 · 밖에서 들어온 파일
        { path: p("gone.txt"), hash: null },
        { path: o("moved.txt"), hash: fakeHash("gone0"), renamedFrom: p("gone.txt") },
        { path: o("came.txt"), hash: null },
        { path: p("came.txt"), hash: fakeHash("came0"), renamedFrom: o("came.txt") },
      ],
    });
    expect(seeded.at(-1)!.at).toBeLessThan(recorded[0].at);
    fs.writeFileSync(
      logPath,
      [...seeded, ...recorded].map((snapshot) => `${JSON.stringify(snapshot)}\n`).join(""),
    );
    const folderRowCount = () =>
      readLog(logPath).filter((snapshot) =>
        snapshot.entries.some((entry) => entry.path.startsWith(`${folderName}/`)),
      ).length;
    const totalRows = folderRowCount();
    expect(totalRows).toBeGreaterThan(100);

    // 2차 기동 — 폴더 밖 파일로 워처 웜업 후 폴더 이력을 연다
    const app = await launchVsCode(vscodeExePath, dirs);
    try {
      const workbox = await app.firstWindow();
      await prepareRecording(workbox, warmupName, warmupPath);
      expect(folderRowCount()).toBe(totalRows); // 기동 스캔이 폴더에 줄을 더하지 않았다
      const folderItem = workbox.getByRole("treeitem", { name: folderName, exact: true });
      await showHistoryViaContextMenu(workbox, folderItem, folderName);
      const pane = historyPaneOf(workbox);
      const row = (position: number) => rowAt(pane, position);
      // 탐색기 pane 을 접어 변경 목록이 넓게 보이게 한다 (보이는 줄만 DOM 에 있다)
      await workbox.locator(".pane-header", { hasText: "workspace" }).first().click();
      await expect(folderItem).toBeHidden();
      const tabCount = await editorTabs(workbox).count();

      // 처음 100줄 + "Load more…" — 형제 수(aria-setsize)로 판정(보이는 줄만 DOM 에 있다)
      await expect(row(1)).toHaveAttribute("aria-setsize", "101", { timeout: 15_000 });
      await expect(selectedRows(pane)).toHaveCount(0); // 줄을 자동으로 고르지 않는다
      const year = (daysAgo: number) => String(new Date(localAt(daysAgo, 12, 0, 0)).getFullYear());

      // 줄 라벨: 맨 위(오늘)와 날짜가 바뀐 줄(1일 전 13:00:00)에만 날짜, 시각은 초까지
      const t0Rows = totalRows - 140;
      const treeRow = row(t0Rows + 1);
      await expect(rowLabel(row(1))).toContainText(year(0));
      await expect(rowLabel(treeRow)).toContainText(year(1));
      await expect(rowLabel(treeRow)).toContainText(":00:00");
      await expect(rowDescription(treeRow)).toHaveText("b.txt and 5 more");
      // 영어 UI — 시각은 VS Code 표시 언어 형식(OS 지역 설정이 한국어여도 오전/오후가 없다)
      await expect(rowLabel(treeRow)).toHaveText(/\d{1,2}:\d{2}:\d{2}\s?PM$/);
      await expect(rowLabel(row(1))).not.toContainText(/오전|오후/);
      const sameDayRow = row(t0Rows + 2); // 1일 전 12:02:13 — 위 줄과 같은 날
      await expect(rowLabel(sameDayRow)).toContainText("12:02:13");
      await expect(rowLabel(sameDayRow)).not.toContainText(year(1));
      await expect(rowDescription(sameDayRow)).toHaveText("a.txt");

      // 열린 동안의 새 기록 — 맨 위에 붙고, 불러온 100줄은 그대로(101줄 + Load more…)
      fs.writeFileSync(path.join(folderPath, "a.txt"), "a while open\n");
      await expect(row(1)).toHaveAttribute("aria-setsize", "102", { timeout: 15_000 });
      await expect(rowLabel(row(1))).toContainText(year(0));
      await expect(rowLabel(row(2))).not.toContainText(year(0)); // 아래로 밀린 오늘 줄 — 시각만
      await expect(selectedRows(pane)).toHaveCount(0);

      // 폴더 트리 — 폴더 먼저 · 이름순, 파일 항목마다 변경 종류, 이름 변경은 새 경로 항목 하나
      const movedTreeRow = row(t0Rows + 2);
      await expect(rowDescription(movedTreeRow)).toHaveText("b.txt and 5 more");
      await movedTreeRow.locator(".monaco-tl-twistie").click();
      const children = pane.locator(
        ".monaco-list-row[aria-level='2'], .monaco-list-row[aria-level='3']",
      );
      await expect(children).toHaveCount(7, { timeout: 5_000 });
      // 화면 순서(세로 위치)대로 [깊이, 라벨, 설명 글자]
      const childTexts = await children.evaluateAll((elements) =>
        elements
          .toSorted((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
          .map((element) => [
            element.getAttribute("aria-level"),
            element.querySelector(".label-name")?.textContent ?? "",
            element.querySelector(".label-description")?.textContent ?? "",
          ]),
      );
      expect(childTexts).toEqual([
        ["2", "sub", ""],
        ["3", "b.txt", "added"],
        ["2", "a.txt", "modified"],
        ["2", "c.txt", "deleted"],
        ["2", "came.txt", `renamed from ${outsideName}/came.txt`],
        ["2", "gone.txt", `moved to ${outsideName}/moved.txt`],
        ["2", "new.txt", "renamed from old.txt"],
      ]);
      await expect(editorTabs(workbox)).toHaveCount(tabCount); // 펼치기는 diff 를 열지 않는다
      await workbox.screenshot({ path: path.join(shotDir, "list-folder-tree.png") });

      // 끝의 "Load more…" → 다음 100줄(남은 줄 전부)을 붙이고 항목이 사라진다. diff 는 열리지 않는다
      const loadMore = pane.getByRole("treeitem", { name: "Load more…" });
      await scrollToEnd(workbox, pane);
      await expect(loadMore).toBeVisible({ timeout: 5_000 });
      await workbox.screenshot({ path: path.join(shotDir, "list-load-more-before.png") });
      await loadMore.click();
      await expect(rowsOf(pane).first()).toHaveAttribute("aria-setsize", String(totalRows + 1), {
        timeout: 15_000,
      });
      await workbox.waitForTimeout(1_000);
      await expect(editorTabs(workbox)).toHaveCount(tabCount);

      // 끝까지 굴려 날짜가 바뀜 줄(2일 전 12:00:04)과 그 아래 같은 날 줄을 본다
      await scrollToEnd(workbox, pane);
      await expect(loadMore).toHaveCount(0);
      const lastRow = row(totalRows + 1);
      const dayChangeRow = row(totalRows + 1 - 4);
      await expect(rowLabel(lastRow)).toContainText("12:00:00", { timeout: 5_000 });
      await expect(rowLabel(lastRow)).not.toContainText(year(2));
      await expect(rowDescription(lastRow)).toHaveText("a.txt and 3 more");
      await expect(rowLabel(dayChangeRow)).toContainText(year(2));
      await expect(rowLabel(dayChangeRow)).toContainText("12:00:04");
      await expect(rowLabel(row(totalRows + 1 - 5))).not.toContainText(year(1)); // 1일 전 마지막 줄
      await workbox.screenshot({ path: path.join(shotDir, "list-load-more-after.png") });

      // 줄을 클릭해 다중 diff 가 열려도 클릭한 줄은 목록 안 제자리에 있다 (spec 「3. 열람」 — 포커스를
      // 목록으로 되돌리지 않는다). 되돌리면 VS Code 가 고른 줄을 목록 가운데로 스크롤한다. 목록이 끝까지
      // 굴러 있고 위쪽 줄을 클릭하므로, 가운데로 옮기면 위치가 바뀐다.
      const clickedPosition = await pane.evaluate((element) => {
        const listTop = element.querySelector(".monaco-list")!.getBoundingClientRect().top;
        const visible = [...element.querySelectorAll(".monaco-list-row[aria-level='1']")]
          .filter((rowElement) => rowElement.getBoundingClientRect().top >= listTop)
          .map((rowElement) => Number(rowElement.getAttribute("aria-posinset")))
          .sort((a, b) => a - b);
        return visible[1];
      });
      const clicked = row(clickedPosition);
      const topInList = async (): Promise<number> => {
        const rowBox = (await clicked.boundingBox())!;
        const listBox = (await pane.locator(".monaco-list").boundingBox())!;
        return Math.round(rowBox.y - listBox.y);
      };
      const topBefore = await topInList();
      await clicked.click();
      await expect(activeTabOf(workbox)).toContainText(`${folderName} (change at`, {
        timeout: 10_000,
      });
      await workbox.waitForTimeout(1_000);
      expect(await topInList()).toBe(topBefore);
      await workbox.screenshot({ path: path.join(shotDir, "list-click-stays.png") });
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(folderPath, { recursive: true, force: true });
    fs.rmSync(outsidePath, { recursive: true, force: true });
    fs.rmSync(warmupPath, { force: true });
  }
});

test("빈 목록은 이유를 알린다 — 기록 없음 · 제외 대상(파일 · 폴더)", async ({
  vscodeExePath,
}, testInfo) => {
  const emptyName = "local-history-list-empty";
  const excludedName = "local-history-list-excluded";
  const emptyPath = path.join(workspaceDir, emptyName);
  const excludedPath = path.join(workspaceDir, excludedName);
  const warmupPath = path.join(workspaceDir, warmupName);
  fs.rmSync(emptyPath, { recursive: true, force: true });
  fs.rmSync(excludedPath, { recursive: true, force: true });
  fs.mkdirSync(emptyPath, { recursive: true });
  fs.mkdirSync(excludedPath, { recursive: true });
  fs.writeFileSync(path.join(excludedPath, "x.txt"), "x\n");
  fs.writeFileSync(warmupPath, "initial\n");
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    { settings: { "simplysm-local-history.exclude": { [`**/${excludedName}`]: true } } },
  );
  try {
    const workbox = await app.firstWindow();
    await prepareRecording(workbox, warmupName, warmupPath);
    const pane = historyPaneOf(workbox);
    const message = pane.locator(".message");

    // 기록 없음 — 빈 폴더
    const emptyItem = workbox.getByRole("treeitem", { name: emptyName });
    await showHistoryViaContextMenu(workbox, emptyItem, emptyName);
    await expect(message).toHaveText("No changes recorded yet.", { timeout: 15_000 });
    await expect(rowsOf(pane)).toHaveCount(0);
    await workbox.screenshot({ path: path.join(shotDir, "list-empty.png") });

    // 기록이 생기면 안내가 사라지고 줄이 보인다 — 자동으로 고르지는 않는다
    fs.writeFileSync(path.join(emptyPath, "first.txt"), "first\n");
    await expect(rowsOf(pane)).toHaveCount(1, { timeout: 15_000 });
    await expect(message).toBeHidden();
    await expect(rowDescription(rowAt(pane, 1))).toHaveText("first.txt");
    await expect(selectedRows(pane)).toHaveCount(0);

    // 제외 대상 — 폴더, 그 안의 파일
    const excludedItem = workbox.getByRole("treeitem", { name: excludedName });
    await showHistoryViaContextMenu(workbox, excludedItem, excludedName);
    await expect(message).toHaveText("This folder is excluded from Local History.", {
      timeout: 15_000,
    });
    await workbox.screenshot({ path: path.join(shotDir, "list-excluded-folder.png") });
    await excludedItem.click(); // 탐색기에서 펼친다
    const excludedFile = workbox.getByRole("treeitem", { name: "x.txt" });
    await excludedFile.waitFor({ state: "visible", timeout: 10_000 });
    await showHistoryViaContextMenu(workbox, excludedFile, "x.txt");
    await expect(message).toHaveText("This file is excluded from Local History.", {
      timeout: 15_000,
    });
    await workbox.screenshot({ path: path.join(shotDir, "list-excluded-file.png") });
  } finally {
    await app.close();
    fs.rmSync(emptyPath, { recursive: true, force: true });
    fs.rmSync(excludedPath, { recursive: true, force: true });
    fs.rmSync(warmupPath, { force: true });
  }
});
