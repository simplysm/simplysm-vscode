// 시연 하네스 공용 fixture — @vscode/test-electron(다운로드) + @playwright/test(_electron 직접 구동).
// launch 인자는 vscode-test 공식 러너와 동일 구성 (https://github.com/microsoft/vscode-test lib/runTest.ts).
import { test as base, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 전용 시연 워크스페이스 — 시연 산출 파일이 실작업과 섞이지 않게 분리 (2026-07-10 사용자 확정)
export const workspaceDir = path.join(rootDir, "demo", "workspace");

// 이 실행의 산출물 뿌리 — playwright outputDir 과 같은 곳. 실행마다 분리돼 동시 실행이
// 서로의 산출물을 지우지 않는다 (playwright.config.ts 가 만든다).
export const runResultsDir = process.env["DEMO_RUN_DIR"]!;

const VSCODE_VERSION = "1.127.0"; // engines ^1.127.0 하한 고정 — 캐시 재사용 (RISK-003)
const execFileAsync = promisify(execFile);

type WorkerFixtures = {
  vscodeExePath: string;
};

type TestFixtures = {
  electronApp: ElectronApplication;
  workbox: Page;
};

type DemoBrowserWindow = {
  blur(): void;
  setFocusable(focusable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  setOpacity(opacity: number): void;
  webContents: { isOffscreen(): boolean };
};

/** Windows 창을 활성화하지 않고 Z-order 맨 뒤로 이동. */
async function sendWindowToBottom(nativeWindowHandle: string): Promise<void> {
  if (!/^[1-9]\d*$/.test(nativeWindowHandle)) {
    throw new Error(`Invalid native window handle: ${nativeWindowHandle}`);
  }

  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Demo {
    public static class WindowZOrder {
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetWindowPos(
            IntPtr windowHandle,
            IntPtr insertAfter,
            int x,
            int y,
            int width,
            int height,
            uint flags);
    }
}
'@

$windowHandle = [IntPtr]::new([Int64]${nativeWindowHandle})
$bottom = [IntPtr]::new(1)
$noMoveNoSizeNoActivate = [UInt32]0x0013
if (-not [Demo.WindowZOrder]::SetWindowPos(
    $windowHandle,
    $bottom,
    0,
    0,
    0,
    0,
    $noMoveNoSizeNoActivate
)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "SetWindowPos(HWND_BOTTOM) failed with Win32 error $errorCode"
}
`;
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
    { windowsHide: true },
  );
}

// 실사용 외관 재현 — 사용자 실환경의 시각 설정만 발췌.
// 색 테마는 Catppuccin Mocha 고정 — 사용자 실환경과 일치시키고, error 계열이
// "밝은 배경 + 어두운 전경" 쌍이라 토큰 쌍 위반을 가장 먼저 드러냄 (2026-07-29 사용자 확정).
// 하네스 조작을 깨는 설정은 제외: window.commandCenter=false 는 runCommand 가 클릭하는
// "Open Quick Access" 버튼을 없애고, workbench.list/tree openMode=doubleClick 은
// openTasksFile 의 단일 클릭을 무효화함.
const visualSettings = {
  "workbench.colorTheme": "Catppuccin Mocha",
  "workbench.iconTheme": "vscode-icons",
  "editor.fontFamily": "'Sarasa Fixed K', Consolas, 'Courier New', monospace",
  "editor.fontSize": 13,
  "editor.fontWeight": 300,
  "editor.minimap.enabled": false,
  "workbench.activityBar.compact": true,
  "window.density.editorTabHeight": "compact",
  "window.menuBarVisibility": "compact",
  "workbench.layoutControl.enabled": false,
  "explorer.compactFolders": false,
};

// 실사용 외관 재현에 필요한 확장 — 로컬 설치본에서 demo extensionsDir 로 복사.
const visualExtensionIds = ["vscode-icons-team.vscode-icons", "catppuccin.catppuccin-vsc"];

function copyVisualExtensions(extensionsDir: string): void {
  const localExtensionsRoot = path.join(os.homedir(), ".vscode", "extensions");
  for (const extensionId of visualExtensionIds) {
    const candidates = fs.existsSync(localExtensionsRoot)
      ? fs
          .readdirSync(localExtensionsRoot)
          .filter((dirName) => dirName.startsWith(`${extensionId}-`))
      : [];
    if (candidates.length === 0) {
      throw new Error(
        `데모 시각 재현용 확장이 로컬 VS Code 에 없음: ${extensionId} — 설치 후 재실행 필요`,
      );
    }
    const latestDirName = candidates.sort().at(-1)!;
    const destDir = path.join(extensionsDir, latestDirName);
    if (!fs.existsSync(destDir)) {
      fs.cpSync(path.join(localExtensionsRoot, latestDirName), destDir, { recursive: true });
    }
  }
}

/**
 * 표시 언어 전환은 언어 팩이 있어야 성립한다(`--locale` 만으로는 영어로 남는다).
 * 받아 둔 팩을 캐시에 두고 시연 extensionsDir 로 복사한다.
 */
function copyLanguagePack(vscodeExePath: string, locale: string, extensionsDir: string): void {
  const cacheDir = path.join(rootDir, ".vscode-test", "lang-extensions");
  const packPrefix = `ms-ceintl.vscode-language-pack-${locale}-`;
  const findPack = (): string | undefined =>
    fs.existsSync(cacheDir)
      ? fs.readdirSync(cacheDir).find((dirName) => dirName.startsWith(packPrefix))
      : undefined;

  if (findPack() === undefined) {
    const cliPath = path.join(
      path.dirname(vscodeExePath),
      "bin",
      process.platform === "win32" ? "code.cmd" : "code",
    );
    execFileSync(
      cliPath,
      [
        `--install-extension=MS-CEINTL.vscode-language-pack-${locale}`,
        `--extensions-dir=${cacheDir}`,
        `--user-data-dir=${path.join(rootDir, ".vscode-test", "lang-user-data")}`,
      ],
      { stdio: "ignore", shell: process.platform === "win32" },
    );
  }

  const packDirName = findPack();
  if (packDirName === undefined) {
    throw new Error(`언어 팩을 받지 못했습니다: ${locale}`);
  }
  const destDir = path.join(extensionsDir, packDirName);
  if (!fs.existsSync(destDir)) {
    fs.cpSync(path.join(cacheDir, packDirName), destDir, { recursive: true });
  }
}

/**
 * 시연 VS Code 가 띄운 terminal daemon 을 즉시 정리한다. daemon 은 설계상 연결이 끊긴 뒤
 * 10초 재연결 창 동안 남는데, playwright 의 close 가 프로세스 트리 종료를 기다려 시연마다
 * 10초씩 늘어난다. `.vscode-test` 의 시연용 VS Code 가 띄운 것만 지워 실작업 daemon 은 건드리지
 * 않는다.
 */
function killDemoTerminalDaemons(): void {
  if (process.platform !== "win32") return;
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%daemon.cjs%'\" | " +
          "Where-Object { $_.ExecutablePath -like '*.vscode-test*' } | " +
          "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ],
      { windowsHide: true },
    );
  } catch {
    // 정리는 시간 절약일 뿐이다 — 실패해도 daemon 이 10초 뒤 스스로 끝난다.
  }
}

/** 기본 기동에서 벗어나야 하는 시연만 쓰는 갈래 — 기본값은 기존 기동과 같다. */
export interface LaunchOverrides {
  /** 열 폴더나 워크스페이스 파일. `null` 이면 아무 것도 열지 않은 창. */
  readonly openTarget?: string | null;
  /** 참이면 워크스페이스 신뢰를 끄지 않고 기동해 신뢰 선언을 실제로 태운다. */
  readonly workspaceTrust?: boolean;
  /** VS Code 표시 언어. */
  readonly locale?: string;
  readonly settings?: Record<string, unknown>;
}

/** VS Code 기동 — 재시작 시연은 같은 userDataDir 로 2회 호출해 세션 탭 복원을 재현. */
export async function launchVsCode(
  vscodeExePath: string,
  dirs: { extensionsDir: string; userDataDir: string },
  overrides: LaunchOverrides = {},
): Promise<ElectronApplication> {
  fs.mkdirSync(workspaceDir, { recursive: true });
  // 기동 직후 파일 열기가 확장 등록 완료 전이면 default 커스텀 에디터가 무시되고
  // 텍스트 에디터로 폴백되는 VS Code 레이스(microsoft/vscode#117145) 우회 —
  // 사용자 설정에 연결을 선기록해 해석을 결정적으로 만듦 (하네스 한정, 제품 동작 아님).
  const userSettingsPath = path.join(dirs.userDataDir, "User", "settings.json");
  fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
  fs.writeFileSync(
    userSettingsPath,
    JSON.stringify({
      ...visualSettings,
      "workbench.editorAssociations": { "*.tasks": "simplysm-tasks.editor" },
      // 하네스 판정은 .xterm-rows DOM 텍스트에 의존 — WebGL 렌더러는 DOM 행을 만들지 않으므로
      // 시연에선 DOM 렌더러로 고정한다 (WebGL 경로는 전용 시연이 이 값을 되돌려 확인).
      "terminal.integrated.gpuAcceleration": "off",
      ...overrides.settings,
    }),
  );
  copyVisualExtensions(dirs.extensionsDir);
  if (overrides.locale != null) {
    copyLanguagePack(vscodeExePath, overrides.locale, dirs.extensionsDir);
  }
  // VSCODE_* 상속 제거 — 남으면 webview ServiceWorker 등록 실패 (InvalidStateError).
  // ELECTRON_RUN_AS_NODE 도 제거 — 확장 호스트(터미널)에서 상속되면 Code.exe 가 순수 node 로
  // 기동돼 VS Code CLI 옵션을 "bad option" 으로 거부(exitCode 9)하며 기동 자체가 실패한다.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && !/^VSCODE_/i.test(key) && key !== "ELECTRON_RUN_AS_NODE") {
      env[key] = value;
    }
  }
  const openTarget = overrides.openTarget === undefined ? workspaceDir : overrides.openTarget;
  const electronApp = await _electron.launch({
    executablePath: vscodeExePath,
    env,
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      ...(overrides.workspaceTrust === true ? [] : ["--disable-workspace-trust"]),
      ...(overrides.locale == null ? [] : [`--locale=${overrides.locale}`]),
      `--extensions-dir=${dirs.extensionsDir}`,
      `--user-data-dir=${dirs.userDataDir}`,
      `--extensionDevelopmentPath=${path.join(rootDir, "packages", "focus-refresh")}`,
      `--extensionDevelopmentPath=${path.join(rootDir, "packages", "local-history")}`,
      `--extensionDevelopmentPath=${path.join(rootDir, "packages", "tasks")}`,
      `--extensionDevelopmentPath=${path.join(rootDir, "packages", "terminal")}`,
      ...(openTarget == null ? [] : [openTarget]),
    ],
  });

  // 모든 시연이 close 로 끝나므로 여기서 한 번에 — 닫기 직전 시연용 daemon 을 정리해
  // 프로세스 트리 종료 대기(10초 재연결 창)를 없앤다.
  const originalClose = electronApp.close.bind(electronApp);
  electronApp.close = async (): Promise<void> => {
    killDemoTerminalDaemons();
    await originalClose();
  };

  try {
    const sendToBottom = process.platform === "win32";

    // 포커스를 막고, Windows에서는 맨 뒤 배치 전까지 투명·마우스 통과 상태로 유지.
    await electronApp.evaluate(({ app, BrowserWindow }, hideInitialWindow) => {
      let initialWindowPrepared = false;
      const prepareWindow = (browserWindow: DemoBrowserWindow) => {
        browserWindow.setFocusable(false);
        browserWindow.blur();
        if (
          hideInitialWindow &&
          !initialWindowPrepared &&
          !browserWindow.webContents.isOffscreen()
        ) {
          initialWindowPrepared = true;
          browserWindow.setOpacity(0);
          browserWindow.setIgnoreMouseEvents(true);
        }
      };

      app.on("browser-window-created", (_event: unknown, browserWindow: DemoBrowserWindow) =>
        prepareWindow(browserWindow),
      );
      for (const browserWindow of BrowserWindow.getAllWindows()) {
        prepareWindow(browserWindow);
      }
    }, sendToBottom);

    if (sendToBottom) {
      const workbox = await electronApp.firstWindow();
      const browserWindowHandle = await electronApp.browserWindow(workbox);
      try {
        const nativeWindowHandle = await browserWindowHandle.evaluate(
          (browserWindow: { getNativeWindowHandle(): Buffer }) => {
            const handleBuffer = browserWindow.getNativeWindowHandle();
            if (handleBuffer.byteLength === 8) {
              return handleBuffer.readBigUInt64LE(0).toString();
            }
            if (handleBuffer.byteLength === 4) {
              return handleBuffer.readUInt32LE(0).toString();
            }
            throw new Error(`Unexpected native window handle size: ${handleBuffer.byteLength}`);
          },
        );
        await sendWindowToBottom(nativeWindowHandle);
        await browserWindowHandle.evaluate(
          (browserWindow: {
            setIgnoreMouseEvents(ignore: boolean): void;
            setOpacity(opacity: number): void;
          }) => {
            browserWindow.setIgnoreMouseEvents(false);
            browserWindow.setOpacity(1);
          },
        );
      } finally {
        await browserWindowHandle.dispose();
      }
    }

    return electronApp;
  } catch (setupError) {
    try {
      await electronApp.close();
    } catch (closeError) {
      throw new AggregateError(
        [setupError, closeError],
        "Failed to configure and close the VS Code demo window",
      );
    }
    throw setupError;
  }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  vscodeExePath: [
    // oxlint-disable-next-line no-empty-pattern -- playwright fixture 는 첫 인자 구조분해 서명 강제
    async ({}, use) => {
      const exePath = await downloadAndUnzipVSCode({
        version: VSCODE_VERSION,
        cachePath: path.join(rootDir, ".vscode-test"),
      });
      await use(exePath);
    },
    { scope: "worker", timeout: 0 },
  ],

  electronApp: async ({ vscodeExePath }, use, testInfo) => {
    const app = await launchVsCode(vscodeExePath, {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    });
    await use(app);
    await app.close();
  },

  workbox: async ({ electronApp }, use) => {
    await use(await electronApp.firstWindow());
  },
});

export { expect } from "@playwright/test";

/** 명령 팔레트로 명령 실행 — 확장 API 채널 없이 실사용자와 동일 경로. */
export async function runCommand(workbox: Page, commandTitle: string): Promise<void> {
  // 키보드 단축키는 창 포커스 없으면 유실 — 커맨드 센터 버튼 클릭이 결정적.
  // 라벨은 표시 언어를 타므로 클래스로 찾는다 (언어 전환 시연이 같은 경로를 쓴다).
  await workbox
    .locator(".agent-status-input-area:visible, .command-center-quick-pick:visible")
    .first()
    .click();
  const paletteInput = workbox.locator(".quick-input-widget input");
  await paletteInput.waitFor({ state: "visible" });
  await paletteInput.fill(`>${commandTitle}`);
  // Enter 키는 창 포커스가 없으면 간헐 유실 — 첫 항목 클릭이 결정적
  const firstOption = workbox.locator(".quick-input-widget .monaco-list-row").first();
  await firstOption.waitFor({ state: "visible" });
  await firstOption.click();
}

/** 활성 webview 내부 프레임 — 중첩 iframe(바깥 webview → #active-frame) 통과. */
export function webviewFrame(workbox: Page) {
  return workbox.frameLocator("iframe.webview.ready").frameLocator("iframe#active-frame");
}

/**
 * .tasks 파일을 Explorer 트리 클릭으로 열어 리스트 UI 프레임 반환.
 * 기동 직후엔 확장 에디터 등록 전이라 텍스트 에디터로 폴백될 수 있음(microsoft/vscode#117145)
 * — 리스트 UI 루트(#tasks-root)가 안 뜨면 탭을 닫고 재클릭.
 */
export async function openTasksFile(
  workbox: Page,
  fileName: string,
): Promise<ReturnType<typeof webviewFrame>> {
  const treeItem = workbox.getByRole("treeitem", { name: fileName });
  await treeItem.waitFor({ state: "visible", timeout: 30_000 });
  for (let attempt = 0; ; attempt++) {
    await treeItem.click();
    const frame = webviewFrame(workbox);
    try {
      await frame.locator("#tasks-root").waitFor({ state: "attached", timeout: 10_000 });
      return frame;
    } catch (err) {
      if (attempt >= 3) throw err;
      // 텍스트 에디터 폴백 — 탭 닫기 버튼으로 닫고 재시도 (키보드는 창 포커스 없으면 유실)
      await workbox
        .getByRole("tab", { name: new RegExp(fileName) })
        .getByRole("button", { name: /Close/ })
        .click();
    }
  }
}

/**
 * 좌표 조작 재시도 — 커스텀 에디터 webview 는 이벤트가 간헐적으로 문서에 미도달
 * (hit-target 오작동·레이아웃 정착 전 좌표). 조작 후 기대 상태를 확인하고 미달 시 재시도.
 */
export async function retryAction(
  action: () => Promise<void>,
  verify: () => Promise<void>,
  attempts = 5,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await action();
    try {
      await verify();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
