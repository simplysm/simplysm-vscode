// 기본 앱으로 열기 시연 (spec 「3. 열람」 기본 앱으로 열기) — 파일 이력의 줄 · 폴더 이력의 파일 항목 우클릭 메뉴가
// 변경의 직전 · 직후를 읽기 전용 사본으로 만들어 OS 의 열기 명령에 경로로 넘긴다. 작업 파일과 이력은 그대로다.
//
// 개발 PC 에 외부 앱을 띄우지 않는 방법(제품 코드 분기 없음) — 시연 VS Code 의 PATH 맨 앞에 기록용 스텁
// `powershell.exe` 를 둔다. 확장은 Windows 에서 `powershell.exe` 를 PATH 로 찾아 사본 경로를 환경 변수로 넘기므로,
// 스텁이 받은 경로 · 작업 폴더 · 인자를 기록하고 끝난다. 사본은 시연 전용 임시 폴더(TEMP · TMP)에 생긴다.
// 실제 OS 열기(PowerShell → ShellExecute → 연결 앱)는 opt-in 테스트(LH_DEMO_REAL_OPEN=1)가 무해한 연결
// (.cmd — cmd 가 표식 파일에 자기 경로만 쓰고 끝남)로 확인한다.
import path from "node:path";
import fs from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { Locator, Page, TestInfo } from "@playwright/test";
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
  historyPaneOf,
  historyRowAt,
  prepareRecording,
  showHistoryViaContextMenu,
  storeDirOf,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const koreanLabels = { menu: "이력 보기", pane: "로컬 이력" };

/** 기본 앱으로 열기 메뉴 문구. */
interface OpenLabels {
  readonly before: string;
  readonly after: string;
}
const english: OpenLabels = {
  before: "Open in Default App (Before This Change)",
  after: "Open in Default App (After This Change)",
};
const korean: OpenLabels = {
  before: "기본 앱으로 열기 (이 변경 직전)",
  after: "기본 앱으로 열기 (이 변경 직후)",
};

test.skip(process.platform !== "win32", "기록용 스텁이 Windows 실행 파일(powershell.exe)이다");

/** 기록용 스텁 — 받은 경로(환경 변수) · 작업 폴더 · 인자를 기록 폴더에 파일 하나로 남긴다. fail-next 가 있으면 실패한다. */
const stubSource = String.raw`
using System;
using System.IO;
using System.Text;

public static class LocalHistoryOpenStub {
  public static int Main(string[] args) {
    string logDir = Environment.GetEnvironmentVariable("LH_DEMO_OPEN_LOG");
    string target = Environment.GetEnvironmentVariable("SIMPLYSM_LOCAL_HISTORY_OPEN_PATH");
    StringBuilder record = new StringBuilder();
    record.Append(target ?? "").Append('\n');
    record.Append(Environment.CurrentDirectory).Append('\n');
    foreach (string arg in args) record.Append(arg).Append('\n');
    string name = DateTime.UtcNow.Ticks.ToString("D20") + "-" + System.Diagnostics.Process.GetCurrentProcess().Id + ".txt";
    File.WriteAllText(Path.Combine(logDir, name), record.ToString(), new UTF8Encoding(false));
    string failNext = Path.Combine(logDir, "fail-next");
    if (File.Exists(failNext)) {
      File.Delete(failNext);
      Console.Error.Write("stub open failure");
      return 1;
    }
    return 0;
  }
}
`;

/** 기록용 스텁을 빌드한다(실행마다 한 번) — Windows PowerShell 의 Add-Type(.NET Framework 컴파일러). 반환 = 스텁 폴더. */
function buildOpenStub(): string {
  const stubDir = path.join(runResultsDir, "open-stub");
  const exePath = path.join(stubDir, "powershell.exe");
  if (!fs.existsSync(exePath)) {
    fs.mkdirSync(stubDir, { recursive: true });
    const sourcePath = path.join(stubDir, "open-stub.cs");
    fs.writeFileSync(sourcePath, stubSource);
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type -Path '${sourcePath}' -OutputAssembly '${exePath}' -OutputType ConsoleApplication`,
      ],
      { windowsHide: true },
    );
  }
  return stubDir;
}

/** 시연 환경 — 사본이 생길 전용 임시 폴더, 스텁 기록 폴더, VS Code 에 줄 환경 변수. */
interface OpenDemo {
  readonly tempDir: string;
  readonly copyRoot: string;
  readonly logDir: string;
  readonly env: Record<string, string>;
}

/**
 * 임시 폴더는 실행 산출물 뿌리 바로 아래의 짧은 이름이다 — 테스트 출력 폴더는 이름이 길어 사본 경로가
 * 218자(spec 「3. 열람」)에 걸려 보통 이름까지 줄어든다. 이 폴더(약 90자)는 실제 사용자 임시 폴더보다 길다.
 */
function openDemoOf(testInfo: TestInfo, options: { readonly stub: boolean }): OpenDemo {
  const tempDir = path.join(runResultsDir, `t${Date.now().toString(36)}`);
  const logDir = testInfo.outputPath("open-log");
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const env: Record<string, string> = { TEMP: tempDir, TMP: tempDir, LH_DEMO_OPEN_LOG: logDir };
  if (options.stub) {
    const currentPath =
      Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
    env["PATH"] = `${buildOpenStub()}${path.delimiter}${currentPath}`;
  }
  return { tempDir, copyRoot: path.join(tempDir, "slh"), logDir, env };
}

/** Windows 사본 경로의 길이 상한 — Excel 이 여는 경로의 상한(spec 「3. 열람」). */
const COPY_PATH_LIMIT = 218;

/**
 * 줄인 사본 경로 — 전체 218자(글자가 모두 한 단위라 상한에 딱 맞는다), 이름 = 원래 줄기의 앞부분 + "…" +
 * 표시 · 확장자(`ending`) 그대로.
 */
function expectShortened(copyPath: string, originalStem: string, ending: string): void {
  expect(copyPath.length).toBe(COPY_PATH_LIMIT);
  const name = path.basename(copyPath);
  expect(name.endsWith(`…${ending}`), name).toBe(true);
  const kept = name.slice(0, name.length - ending.length - 1);
  expect(kept.length).toBeGreaterThan(20);
  expect(originalStem.startsWith(kept), name).toBe(true);
}

/** 스텁이 받은 열기 하나. */
interface OpenRecord {
  /** 열기 명령에 넘어간 경로(SIMPLYSM_LOCAL_HISTORY_OPEN_PATH). */
  readonly target: string;
  readonly cwd: string;
  readonly args: readonly string[];
}

function openRecordsOf(logDir: string): OpenRecord[] {
  return fs
    .readdirSync(logDir)
    .filter((name) => name.endsWith(".txt"))
    .toSorted()
    .map((name) => {
      const [target, cwd, ...args] = fs.readFileSync(path.join(logDir, name), "utf8").split("\n");
      return { target, cwd, args: args.filter((arg) => arg !== "") };
    });
}

/** `count` 번째(0부터) 열기를 기다려 돌려준다. */
async function openRecordAt(logDir: string, count: number): Promise<OpenRecord> {
  await expect.poll(() => openRecordsOf(logDir).length, { timeout: 15_000 }).toBe(count + 1);
  return openRecordsOf(logDir)[count];
}

/** 줄 라벨의 시각 → 사본 이름의 시각 — 파일 이름에 쓸 수 없는 ":" 는 ".", "/" 는 "-". */
function copyTime(label: string): string {
  return label.replace(/:/g, ".").replace(/[/\\]/g, "-");
}

const rowLabel = async (row: Locator): Promise<string> =>
  await row.locator(".label-name").first().innerText();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 폴더 이력 줄 아래의 항목 — 이름이 `name` 인 것. */
function itemOf(pane: Locator, name: string): Locator {
  return pane.locator(".monaco-list-row:not([aria-level='1'])").filter({
    has: pane.page().locator(".label-name", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
  });
}

const toast = (workbox: Page, text: string) =>
  workbox.locator(".notification-toast").filter({ hasText: text });

/**
 * 노드 우클릭 → 메뉴 항목 `label` 을 고른다 — 창 무포커스 시 우클릭이 간헐 유실되어 재시도한다.
 * `absent` = 같은 메뉴에 없어야 하는 항목, `shown` = 함께 있어야 하는 항목, `screenshot` = 메뉴가 열린 화면.
 */
async function openFromMenu(
  workbox: Page,
  node: Locator,
  label: string,
  options: { readonly absent?: string; readonly shown?: string; readonly screenshot?: string } = {},
): Promise<void> {
  const item = workbox.getByRole("menuitem", { name: label });
  await retryAction(
    async () => {
      if (!(await item.isVisible())) await node.click({ button: "right" });
    },
    async () => {
      await expect(item).toBeVisible({ timeout: 3_000 });
    },
  );
  if (options.absent !== undefined) {
    await expect(workbox.getByRole("menuitem", { name: options.absent })).toHaveCount(0);
  }
  if (options.shown !== undefined) {
    await expect(workbox.getByRole("menuitem", { name: options.shown })).toBeVisible();
  }
  if (options.screenshot !== undefined) {
    await workbox.screenshot({ path: path.join(shotDir, options.screenshot) });
  }
  // 메뉴 항목 클릭도 간헐 유실된다 — 메뉴가 남아 있을 때만 다시 누른다(열기가 두 번 일어나지 않게)
  await retryAction(
    async () => {
      if (await item.isVisible()) await item.click();
    },
    async () => {
      await expect(item).toBeHidden({ timeout: 3_000 });
    },
  );
}

/** 우클릭해도 기본 앱으로 열기 항목이 없다(폴더 이력의 줄 · 폴더 항목). */
async function expectNoOpenMenu(workbox: Page, node: Locator, labels: OpenLabels): Promise<void> {
  await node.click({ button: "right" });
  await workbox.waitForTimeout(1_500); // 메뉴가 떠도 될 시간
  await expect(workbox.getByRole("menuitem", { name: labels.before })).toHaveCount(0);
  await expect(workbox.getByRole("menuitem", { name: labels.after })).toHaveCount(0);
}

/** 사본 — 확장 전용 폴더의 세션 폴더 안, 이름 · 내용 · 읽기 전용. 열기 명령은 사본 폴더에서 실행됐다. */
function expectCopy(record: OpenRecord, copyRoot: string, name: string, content: string): void {
  const sessionDir = path.dirname(record.target);
  expect(path.dirname(sessionDir)).toBe(copyRoot);
  expect(path.basename(sessionDir)).toMatch(/^\d+-[0-9a-z]+$/);
  expect(path.basename(record.target)).toBe(name);
  expect(fs.readFileSync(record.target, "utf8")).toBe(content);
  expect(fs.statSync(record.target).mode & 0o222).toBe(0); // 읽기 전용
  expect(record.cwd.toLowerCase()).toBe(sessionDir.toLowerCase());
  expect(record.args).toContain("-EncodedCommand"); // 경로는 명령줄이 아니라 환경 변수로
  expect(record.args.join(" ")).not.toContain(path.basename(record.target));
}

/** 파일을 공유 불가로 열어 쥐고 있는 프로세스 — 엑셀처럼 사본을 잡고 있는 외부 앱 흉내. */
function holdFile(filePath: string): ChildProcess {
  return spawn(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$stream = [System.IO.File]::Open($env:LH_DEMO_HOLD, 'Open', 'Read', 'None'); Start-Sleep -Seconds 600",
    ],
    { windowsHide: true, stdio: "ignore", env: { ...process.env, LH_DEMO_HOLD: filePath } },
  );
}

/** 다른 프로세스가 파일을 공유 불가로 쥐고 있는가. */
function isHeld(filePath: string): boolean {
  try {
    fs.closeSync(fs.openSync(filePath, "r"));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EBUSY";
  }
}

/** 세션 폴더 목록(없으면 빈 목록). */
function sessionsOf(copyRoot: string): string[] {
  return fs.existsSync(copyRoot) ? fs.readdirSync(copyRoot).toSorted() : [];
}

test("파일 이력 — 줄의 우클릭 메뉴가 직전 · 직후를 읽기 전용 사본으로 열고, 작업 파일과 이력은 그대로다", async ({
  vscodeExePath,
}, testInfo) => {
  // 한글 · 공백 · 괄호 · 쉼표 · & · % 가 든 이름 — 열기 명령에 그대로 넘어가야 한다
  const stem = "local-history-open 보고서 50% & 최종 (v2), 사본";
  const fileName = `${stem}.txt`;
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  const demo = openDemoOf(testInfo, { stub: true });
  const userDataDir = testInfo.outputPath("user-data");
  const app = await launchVsCode(
    vscodeExePath,
    { extensionsDir: testInfo.outputPath("extensions"), userDataDir },
    { env: demo.env },
  );
  try {
    const workbox = await app.firstWindow();
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const pane = historyPaneOf(workbox);
    const rows = pane.getByRole("treeitem");
    const row = (position: number) => historyRowAt(pane, position);
    fs.writeFileSync(filePath, "first change\n");
    await expect(rows).toHaveCount(baseline + 1, { timeout: 15_000 });
    fs.writeFileSync(filePath, "second change\n");
    await expect(rows).toHaveCount(baseline + 2, { timeout: 15_000 });
    await workbox.waitForTimeout(2_000); // 기록 정착 — 아래 스냅샷 수가 기준이다
    const rowCount = baseline + 2;
    const recorded = countSnapshots(userDataDir);
    let opened = 0;

    // 줄 = [second change, first change, 웜업…, 기동 스캔(생성)]. 맨 위 줄은 직전 · 직후가 모두 있다
    const time = copyTime(await rowLabel(row(1))); // 맨 위 줄은 날짜까지 적는다
    await openFromMenu(workbox, row(1), english.before, {
      shown: english.after,
      screenshot: "open-menu-file-row.png",
    });
    const before = await openRecordAt(demo.logDir, opened++);
    expectCopy(before, demo.copyRoot, `${stem} (before change at ${time}).txt`, "first change\n");
    await openFromMenu(workbox, row(1), english.after);
    const after = await openRecordAt(demo.logDir, opened++);
    expectCopy(after, demo.copyRoot, `${stem} (after change at ${time}).txt`, "second change\n");
    expect(path.dirname(after.target)).toBe(path.dirname(before.target)); // 같은 세션

    // 같은 변경을 다시 열면 새 이름 — 앞 사본(외부 앱이 잡고 있을 수 있다)은 덮지 않는다
    await openFromMenu(workbox, row(1), english.before);
    const again = await openRecordAt(demo.logDir, opened++);
    expectCopy(
      again,
      demo.copyRoot,
      `${stem} (before change at ${time}) (2).txt`,
      "first change\n",
    );
    expect(fs.readFileSync(before.target, "utf8")).toBe("first change\n");

    // 맨 아래 줄(이 파일의 첫 기록 — 생성)은 직전이 없다. 내용은 기동 스캔과 웜업 쓰기 중 먼저 기록된 것
    await openFromMenu(workbox, row(rowCount), english.after, {
      absent: english.before,
      screenshot: "open-menu-file-added.png",
    });
    const added = await openRecordAt(demo.logDir, opened++);
    expect(path.basename(added.target)).toMatch(
      new RegExp(`^${escapeRegExp(stem)} \\(after change at .+\\)\\.txt$`),
    );
    expect(fs.readFileSync(added.target, "utf8")).toMatch(/^(initial|warmup \d+)\n$/);

    // 작업 파일과 이력(스냅샷 수 · 줄 수)은 그대로다
    await workbox.waitForTimeout(2_000);
    expect(fs.readFileSync(filePath, "utf8")).toBe("second change\n");
    expect(countSnapshots(userDataDir)).toBe(recorded);
    await expect(row(1)).toHaveAttribute("aria-setsize", String(rowCount));

    // 삭제 줄은 직후가 없다 — 직전을 열어도 작업 파일은 되살아나지 않는다
    fs.rmSync(filePath);
    await expect(row(1)).toHaveAttribute("aria-setsize", String(rowCount + 1), { timeout: 15_000 });
    const deletedTime = copyTime(await rowLabel(row(1)));
    await openFromMenu(workbox, row(1), english.before, {
      absent: english.after,
      screenshot: "open-menu-file-deleted.png",
    });
    const deleted = await openRecordAt(demo.logDir, opened++);
    expectCopy(
      deleted,
      demo.copyRoot,
      `${stem} (before change at ${deletedTime}).txt`,
      "second change\n",
    );
    expect(fs.existsSync(filePath)).toBe(false);

    // 열기 명령이 실패하면(종료 코드 ≠ 0) 오류 알림 — 원인은 명령이 알린 글이다
    fs.writeFileSync(path.join(demo.logDir, "fail-next"), "");
    await openFromMenu(workbox, row(2), english.after);
    await expect(
      toast(workbox, "Local History failed to open in the default app: stub open failure"),
    ).toBeVisible({ timeout: 15_000 });
    await workbox.screenshot({ path: path.join(shotDir, "open-failed.png") });
  } finally {
    await app.close();
    fs.rmSync(filePath, { force: true });
  }
});

test("폴더 이력 — 파일 항목의 우클릭 메뉴, 한국어 시각 사본 이름, 기동 때 지난 세션 사본 정리(잡힌 사본은 다음 기동)", async ({
  vscodeExePath,
}, testInfo) => {
  test.slow(); // 기동 세 번
  const folderName = "local-history-open-folder";
  const folderPath = path.join(workspaceDir, folderName);
  const warmupName = "local-history-open-warmup.txt";
  const warmupPath = path.join(workspaceDir, warmupName);
  const modifiedStem = "수정 50% & (v2), 사본";
  const modifiedName = `${modifiedStem}.dat`;
  // 긴 이름 — 사본 경로가 218자를 넘어 줄기를 자른다. 작업 파일 경로는 260자 안(약 250자)
  const longStem = `긴 이름 50% & (v2), 사본 ${"가".repeat(150)}`;
  const longName = `${longStem}.dat`;
  const file = (name: string) => path.join(folderPath, name);
  fs.rmSync(folderPath, { recursive: true, force: true });
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(file(modifiedName), "v1\n");
  fs.writeFileSync(file(longName), "long v1\n");
  fs.writeFileSync(file("gone.txt"), "gone\n");
  fs.writeFileSync(warmupPath, "initial\n");
  const demo = openDemoOf(testInfo, { stub: true });
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  // 첫 기동은 언어 팩을 등록만 한다 — 화면은 영어다. 둘째 기동부터 한국어 (l10n.spec 과 같다)
  const launch = async () =>
    await launchVsCode(vscodeExePath, dirs, { locale: "ko", env: demo.env });
  let holder: ChildProcess | undefined;
  try {
    // 1차 기동(영어) — 변경 하나(수정 · 삭제 · 생성)를 기록하고 항목마다 연다
    let lockedCopy = "";
    let firstSession = "";
    const app = await launch();
    try {
      const workbox = await app.firstWindow();
      const folderItem = workbox.getByRole("treeitem", { name: folderName, exact: true });
      await folderItem.waitFor({ state: "visible", timeout: 30_000 });
      await prepareRecording(workbox, warmupName, warmupPath);
      const base = countSnapshots(dirs.userDataDir);
      fs.writeFileSync(file(modifiedName), "v2\n");
      fs.writeFileSync(file(longName), "long v2\n");
      fs.rmSync(file("gone.txt"));
      fs.writeFileSync(file("새 파일.bin"), "new\n");
      await expect
        .poll(() => countSnapshots(dirs.userDataDir), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(base + 1);
      await workbox.waitForTimeout(2_000); // 기록 정착

      // 폴더 이력 — 줄 = [변경, 기동 스캔]
      await showHistoryViaContextMenu(workbox, folderItem, folderName);
      const pane = historyPaneOf(workbox);
      const row1 = historyRowAt(pane, 1);
      await expect(row1).toHaveAttribute("aria-setsize", "2", { timeout: 15_000 });
      const recorded = countSnapshots(dirs.userDataDir);
      // 폴더 이력의 줄에는 메뉴가 없다
      await expectNoOpenMenu(workbox, row1, english);
      if ((await row1.getAttribute("aria-expanded")) !== "true") {
        await row1.locator(".monaco-tl-twistie").click();
      }
      await expect(itemOf(pane, modifiedName)).toBeVisible({ timeout: 5_000 });
      const time = copyTime(await rowLabel(row1));
      let opened = 0;

      // 수정 항목: 직전 · 직후
      await openFromMenu(workbox, itemOf(pane, modifiedName), english.before, {
        shown: english.after,
        screenshot: "open-menu-folder-item.png",
      });
      const modified = await openRecordAt(demo.logDir, opened++);
      expectCopy(modified, demo.copyRoot, `${modifiedStem} (before change at ${time}).dat`, "v1\n");
      // 생성 항목: 직후만
      await openFromMenu(workbox, itemOf(pane, "새 파일.bin"), english.after, {
        absent: english.before,
      });
      expectCopy(
        await openRecordAt(demo.logDir, opened++),
        demo.copyRoot,
        `새 파일 (after change at ${time}).bin`,
        "new\n",
      );
      // 삭제 항목: 직전만
      await openFromMenu(workbox, itemOf(pane, "gone.txt"), english.before, {
        absent: english.after,
        screenshot: "open-menu-folder-deleted.png",
      });
      expectCopy(
        await openRecordAt(demo.logDir, opened++),
        demo.copyRoot,
        `gone (before change at ${time}).txt`,
        "gone\n",
      );
      // 긴 이름: 사본 경로를 218자로 줄인다 — 표시 · 확장자는 그대로, 줄기 끝을 … 로
      await openFromMenu(workbox, itemOf(pane, longName), english.before, {
        screenshot: "open-menu-folder-long.png",
      });
      const long = await openRecordAt(demo.logDir, opened++);
      expectShortened(long.target, longStem, ` (before change at ${time}).dat`);
      expect(fs.readFileSync(long.target, "utf8")).toBe("long v1\n");
      expect(fs.statSync(long.target).mode & 0o222).toBe(0);
      expect(path.dirname(long.target)).toBe(path.dirname(modified.target));

      // 작업 파일과 이력은 그대로다
      await workbox.waitForTimeout(2_000);
      expect(fs.readFileSync(file(modifiedName), "utf8")).toBe("v2\n");
      expect(fs.readFileSync(file(longName), "utf8")).toBe("long v2\n");
      expect(fs.existsSync(file("gone.txt"))).toBe(false);
      expect(fs.readFileSync(file("새 파일.bin"), "utf8")).toBe("new\n");
      expect(countSnapshots(dirs.userDataDir)).toBe(recorded);
      lockedCopy = modified.target;
      firstSession = path.dirname(modified.target);
      expect(fs.readdirSync(firstSession)).toHaveLength(4);
      // 다음 기동이 한국어가 되도록 언어 팩 등록을 기다린다
      await expect
        .poll(() => fs.existsSync(path.join(dirs.userDataDir, "languagepacks.json")), {
          timeout: 60_000,
        })
        .toBe(true);
    } finally {
      await app.close();
    }

    // 외부 앱이 사본 하나를 아직 잡고 있다
    holder = holdFile(lockedCopy);
    await expect.poll(() => isHeld(lockedCopy), { timeout: 15_000 }).toBe(true);

    // 2차 기동(한국어) — 지난 세션의 사본은 지워지고, 잡힌 사본은 오류 없이 남는다
    const secondApp = await launch();
    let secondSession = "";
    try {
      const workbox = await secondApp.firstWindow();
      await expect
        .poll(() => fs.readdirSync(firstSession), { timeout: 30_000 })
        .toEqual([path.basename(lockedCopy)]);

      // 한국어 메뉴 · 한국어 시각 사본 이름
      const folderItem = workbox.getByRole("treeitem", { name: folderName, exact: true });
      await folderItem.waitFor({ state: "visible", timeout: 30_000 });
      await showHistoryViaContextMenu(workbox, folderItem, folderName, koreanLabels);
      const pane = historyPaneOf(workbox, koreanLabels);
      const row1 = historyRowAt(pane, 1);
      await expect(row1).toHaveAttribute("aria-setsize", "2", { timeout: 15_000 });
      if ((await row1.getAttribute("aria-expanded")) !== "true") {
        await row1.locator(".monaco-tl-twistie").click();
      }
      await expect(itemOf(pane, modifiedName)).toBeVisible({ timeout: 5_000 });
      const time = copyTime(await rowLabel(row1));
      expect(time).toMatch(/오[전후] \d{1,2}\.\d{2}\.\d{2}$/);
      await openFromMenu(workbox, itemOf(pane, modifiedName), korean.before, {
        shown: korean.after,
        screenshot: "open-menu-ko.png",
      });
      const record = await openRecordAt(demo.logDir, 4);
      expectCopy(record, demo.copyRoot, `${modifiedStem} (${time} 변경 직전).dat`, "v1\n");
      secondSession = path.dirname(record.target);
      expect(secondSession).not.toBe(firstSession);
      // 긴 이름 — 한국어 표시도 그대로 두고 줄기를 자른다
      await openFromMenu(workbox, itemOf(pane, longName), korean.after);
      const long = await openRecordAt(demo.logDir, 5);
      expectShortened(long.target, longStem, ` (${time} 변경 직후).dat`);
      expect(fs.readFileSync(long.target, "utf8")).toBe("long v2\n");
      // 정리 실패(잡힌 사본)는 알림이 아니다
      await expect(toast(workbox, "로컬 이력")).toHaveCount(0);
      expect(fs.readdirSync(firstSession)).toEqual([path.basename(lockedCopy)]);
    } finally {
      await secondApp.close();
    }

    // 잡은 앱이 끝난 뒤 3차 기동 — 남아 있던 사본과 2차 기동의 사본이 모두 지워진다
    holder.kill();
    holder = undefined;
    await expect.poll(() => isHeld(lockedCopy), { timeout: 15_000 }).toBe(false);
    expect(sessionsOf(demo.copyRoot)).toEqual(
      [path.basename(firstSession), path.basename(secondSession)].toSorted(),
    );
    // 예전 뿌리(`simplysm-local-history`)에 남은 지난 세션의 사본 — 기동 정리가 뿌리까지 지운다
    const legacyRoot = path.join(demo.tempDir, "simplysm-local-history");
    const legacyCopy = path.join(legacyRoot, "99999999-old", "old (before change at X).txt");
    fs.mkdirSync(path.dirname(legacyCopy), { recursive: true });
    fs.writeFileSync(legacyCopy, "old\n");
    fs.chmodSync(legacyCopy, 0o444);
    const thirdApp = await launch();
    try {
      const workbox = await thirdApp.firstWindow();
      await expect.poll(() => sessionsOf(demo.copyRoot), { timeout: 30_000 }).toEqual([]);
      await expect.poll(() => fs.existsSync(legacyRoot), { timeout: 30_000 }).toBe(false);
      await expect(toast(workbox, "로컬 이력")).toHaveCount(0);
      await workbox.screenshot({ path: path.join(shotDir, "open-cleanup-done.png") });
    } finally {
      await thirdApp.close();
    }
  } finally {
    holder?.kill();
    fs.rmSync(folderPath, { recursive: true, force: true });
    fs.rmSync(warmupPath, { force: true });
  }
});

test("실제 열기(opt-in) — PowerShell → ShellExecute 가 한국어 시각 · 특수 문자 이름의 사본을 연결 앱으로 연다", async ({
  vscodeExePath,
}, testInfo) => {
  test.skip(
    process.env["LH_DEMO_REAL_OPEN"] !== "1",
    "실제 연결 앱(.cmd → cmd)을 띄운다 — 콘솔 창이 잠깐 뜬다. LH_DEMO_REAL_OPEN=1 일 때만",
  );
  test.slow(); // 기동 두 번
  // 긴 이름 — 사본은 줄기가 잘려 218자가 된다. 앞부분에 한글 · 공백 · 괄호 · 쉼표 · & · % 가 남는다
  const stem = `local-history-open-real 보고서 50% & 최종 (v2), 사본 ${"가".repeat(130)}`;
  const fileName = `${stem}.cmd`;
  const filePath = path.join(workspaceDir, fileName);
  // 표식 파일은 ASCII 경로에 — 배치 파일의 줄은 cmd 가 코드 페이지로 읽는다(테스트 출력 폴더 이름에는 한글이 있다)
  const marker = path.join(runResultsDir, `real-open-marker-${Date.now()}.txt`);
  // 연결 앱(cmd)이 사본을 실행하면 표식 파일에 `<버전> "<자기 경로>"` 한 줄을 덧붙이고 끝난다 — UTF-8(chcp 65001)
  const script = (version: string) =>
    `@echo off\r\nchcp 65001 >nul\r\n>>"${marker}" echo ${version} "%~f0"\r\n`;
  const markerLines = (): string[] =>
    fs.existsSync(marker)
      ? fs
          .readFileSync(marker, "utf8")
          .split(/\r?\n/)
          .filter((line) => line !== "")
      : [];
  fs.writeFileSync(filePath, script("v1"));
  const demo = openDemoOf(testInfo, { stub: false });
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  const launch = async () =>
    await launchVsCode(vscodeExePath, dirs, { locale: "ko", env: demo.env });
  try {
    // 1차 기동 — 언어 팩 등록, 기동 스캔이 v1 을 기록한다
    const firstApp = await launch();
    try {
      await expect
        .poll(() => fs.existsSync(path.join(dirs.userDataDir, "languagepacks.json")), {
          timeout: 60_000,
        })
        .toBe(true);
      await expect
        .poll(
          () => {
            try {
              const log = fs.readFileSync(
                path.join(storeDirOf(dirs.userDataDir), "snapshots.jsonl"),
                "utf8",
              );
              return log.includes(JSON.stringify(fileName));
            } catch {
              return false; // 저장소가 아직 없다
            }
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    } finally {
      await firstApp.close();
    }
    fs.writeFileSync(filePath, script("v2"));

    // 2차 기동(한국어) — 기동 스캔이 v2 를 기록한다. 그 줄의 직전(v1) · 직후(v2)를 연다
    const app = await launch();
    try {
      const workbox = await app.firstWindow();
      const treeItem = workbox.getByRole("treeitem", { name: fileName });
      await treeItem.waitFor({ state: "visible", timeout: 30_000 });
      await showHistoryViaContextMenu(workbox, treeItem, fileName, koreanLabels);
      const pane = historyPaneOf(workbox, koreanLabels);
      const row1 = historyRowAt(pane, 1);
      await expect(row1).toHaveAttribute("aria-setsize", "2", { timeout: 15_000 });
      const time = copyTime(await rowLabel(row1));
      expect(time).toMatch(/오[전후]/);
      const ranCopy = (line: string | undefined): string | undefined =>
        line === undefined ? undefined : /^v\d "(.*)"$/.exec(line)?.[1];

      await openFromMenu(workbox, row1, korean.before);
      await expect.poll(() => markerLines().length, { timeout: 30_000 }).toBe(1);
      const [beforeLine] = markerLines();
      expect(beforeLine.startsWith("v1 ")).toBe(true);
      const beforeCopy = ranCopy(beforeLine)!;
      expect(path.dirname(path.dirname(beforeCopy))).toBe(demo.copyRoot);
      expectShortened(beforeCopy, stem, ` (${time} 변경 직전).cmd`);
      expect(fs.existsSync(beforeCopy)).toBe(true);

      await openFromMenu(workbox, row1, korean.after);
      await expect.poll(() => markerLines().length, { timeout: 30_000 }).toBe(2);
      const afterLine = markerLines()[1];
      expect(afterLine.startsWith("v2 ")).toBe(true);
      expectShortened(ranCopy(afterLine)!, stem, ` (${time} 변경 직후).cmd`);
      await expect(toast(workbox, "로컬 이력")).toHaveCount(0);
      await workbox.screenshot({ path: path.join(shotDir, "open-real-done.png") });
      console.log(`real open: ${markerLines().join(" | ")}`);
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
