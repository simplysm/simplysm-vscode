// 시연 하네스 공용 fixture — @vscode/test-electron(다운로드) + @playwright/test(_electron 직접 구동).
// launch 인자는 vscode-test 공식 러너와 동일 구성 (https://github.com/microsoft/vscode-test lib/runTest.ts).
import { test as base, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
// 제품의 셸 해석 모듈(vscode 비의존) — 제품이 새 세션에 쓸 프로필을 제품과 같은 규칙으로 푼다("시연 셸 탐지").
import {
  profileOsOf,
  resolveShellLaunch,
  type ResolvedShellLaunch,
  type ShellSettings,
} from "../packages/terminal/src/shell-launch.ts";
import { ClipboardKeeper, noteDemoAppClosing } from "./clipboard-guard/clipboard-guard.ts";

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
  clipboardKeeper: ClipboardKeeper;
};

type TestFixtures = {
  electronApp: ElectronApplication;
  workbox: Page;
  preserveClipboard: void;
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

// 실사용 외관 재현 — 사용자 VS Code(기본 프로필)의 설정에서 화면에 보이는 설정(아래 목록)을 모두 읽어 시연에
// 그대로 쓴다. 시연 · README 이미지가 사용자가 실제로 보는 화면과 같아야 하기 때문이다 (2026-10-18 사용자 확정).
// 사용자 설정에 없는 키는 시연 설정에도 넣지 않아 VS Code 기본값을 쓴다.
// 편집 동작 · 확장 기능 · 계정 · 경로 같은 비외관 설정은 읽지 않는다.
// 터미널 프로필은 셸 경로를 담지만 읽는다. 시연 터미널에 뜨는 셸(시작 배너 · 프롬프트 · tab 이름)을 정하는
// 외관 설정이기 때문이다 (2026-10-19 사용자 확정).
// 터미널 환경 변수(terminal.integrated.env.*)도 읽는다. Simplysm Terminal 이 내장 터미널처럼 시연 셸의 환경에
// 합치므로, 그 셸이 화면에 내는 것(프롬프트 등)을 바꿀 수 있기 때문이다 (2026-10-19 확정).
// 단, 시연 셸의 입력 기록은 하네스가 시연 폴더로 돌린다 — prepareDemoShell 주석 참고.
// 색 · 아이콘 테마도 고정하지 않는다. 이전 결정(2026-07-29: Catppuccin Mocha 고정 — error 계열 토큰 쌍 위반을
// 가장 먼저 드러냄)은 거뒀다. 그 검출을 다른 수단으로 대신하지도 않는다 (2026-10-18 사용자 확정).
// 화면에 보이지만 하네스 조작을 깨는 설정은 읽지 않는다:
// - window.commandCenter=false: runCommand 가 클릭하는 "Open Quick Access" 버튼을 없앤다.
// - workbench.list.openMode · workbench.tree.expandMode=doubleClick: 하네스의 단일 클릭(openTasksFile 의
//   파일 열기 · 탐색기 폴더 펼치기)을 무효화한다.
// - terminal.integrated.gpuAcceleration: 하네스가 "off"(DOM 렌더러)로 고정한다 — launchVsCode 주석 참고.
// 항목이 `접두어.*` 꼴이면 그 접두어로 시작하는 키를 모두 읽는다.
const appearanceSettingKeys = [
  // 테마
  "workbench.colorTheme",
  "workbench.iconTheme",
  // 워크벤치 배치 · 밀도
  "workbench.experimental.modernUI",
  "workbench.activityBar.compact",
  "workbench.layoutControl.enabled",
  "workbench.secondarySideBar.defaultVisibility",
  "workbench.browser.showInTitleBar",
  "workbench.notifications.position",
  "workbench.tree.indent",
  "workbench.tree.renderIndentGuides",
  "window.menuBarVisibility",
  "window.density.editorTabHeight",
  // AI 기능의 화면 요소 — CHAT 패널 표시 여부, 커맨드 센터 자리의 에이전트 입력창, 세션 목록 배치
  "chat.disableAIFeatures",
  "chat.unifiedAgentsBar.enabled",
  "chat.viewSessions.orientation",
  // 탐색기
  "explorer.autoReveal",
  "explorer.compactFolders",
  "explorer.fileNesting.*",
  // 에디터
  "editor.fontFamily",
  "editor.fontSize",
  "editor.fontWeight",
  "editor.lineHeight",
  "editor.minimap.enabled",
  "editor.wordWrap",
  // 터미널 · 디버그 콘솔 · 마크다운 미리 보기의 글꼴
  "terminal.integrated.fontFamily",
  "terminal.integrated.fontSize",
  "terminal.integrated.fontWeight",
  "terminal.integrated.lineHeight",
  "debug.console.fontSize",
  "markdown.preview.fontFamily",
  "markdown.preview.fontSize",
  "markdown.preview.lineHeight",
  // 터미널 셸 — VS Code 는 이 키들로 기본 프로필을 고르고 그 셸 경로를 vscode.env.shell 로 확장에 준다.
  // Simplysm Terminal 은 셸 설정을 따로 두지 않고 그 경로를, 기본 프로필의 인자 · 환경 변수와 함께 띄운다.
  "terminal.integrated.defaultProfile.windows",
  "terminal.integrated.defaultProfile.osx",
  "terminal.integrated.defaultProfile.linux",
  "terminal.integrated.profiles.windows",
  "terminal.integrated.profiles.osx",
  "terminal.integrated.profiles.linux",
  // 터미널 셸 환경 변수 — Simplysm Terminal 이 기본 프로필의 env 보다 먼저 셸 환경에 합친다.
  "terminal.integrated.env.windows",
  "terminal.integrated.env.osx",
  "terminal.integrated.env.linux",
];

/** 설정 키가 `appearanceSettingKeys` 의 항목에 맞으면 참. */
function isAppearanceSettingKey(key: string): boolean {
  return appearanceSettingKeys.some((entry) =>
    entry.endsWith(".*") ? key.startsWith(entry.slice(0, -1)) : key === entry,
  );
}

// 언어별 설정 키(`[markdown]`, `[javascript][typescript]`) — VS Code 의 OVERRIDE_PROPERTY_REGEX 와 같은 꼴.
const languageOverrideKeyPattern = /^(\[[^\]]+\])+$/;

/**
 * 설정 객체에서 외관 설정만 고른다. 언어별 설정은 그 안의 키를 같은 기준으로 고르고, 남는 키가 없으면 뺀다.
 */
function pickAppearanceSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (languageOverrideKeyPattern.test(key)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const pickedOverride = pickAppearanceSettings(value as Record<string, unknown>);
      if (Object.keys(pickedOverride).length > 0) picked[key] = pickedOverride;
    } else if (isAppearanceSettingKey(key)) {
      picked[key] = value;
    }
  }
  return picked;
}

/** 사용자 VS Code(기본 프로필)의 설정 파일. */
function userVsCodeSettingsPath(): string {
  const configRoot =
    process.platform === "win32"
      ? (process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : (process.env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config"));
  return path.join(configRoot, "Code", "User", "settings.json");
}

/** 사용자 VS Code(기본 프로필)의 확장 폴더. */
const userExtensionsRoot = path.join(os.homedir(), ".vscode", "extensions");

/**
 * 사용자 VS Code 설정에서 외관 설정만 읽는다 — 파일은 읽기만 한다.
 * settings.json 은 주석 · 끝 쉼표를 허용하는 JSONC 라 VS Code 와 같은 파서(jsonc-parser)로 읽는다.
 */
function readUserAppearanceSettings(): Record<string, unknown> {
  const settingsPath = userVsCodeSettingsPath();
  if (!fs.existsSync(settingsPath)) return {};
  const errors: ParseError[] = [];
  const settings: unknown = parseJsonc(fs.readFileSync(settingsPath, "utf8"), errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
  });
  if (errors.length > 0) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)} @${error.offset}`)
      .join(", ");
    throw new Error(`사용자 VS Code 설정을 읽지 못했습니다: ${settingsPath} (${detail})`);
  }
  if (settings === undefined) return {};
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error(`사용자 VS Code 설정의 최상위가 객체가 아닙니다: ${settingsPath}`);
  }
  return pickAppearanceSettings(settings as Record<string, unknown>);
}

type ThemeContribution = { id?: unknown; label?: unknown; path?: unknown };
type ExtensionManifest = {
  engines?: { vscode?: unknown };
  contributes?: Record<string, unknown>;
};

/** 확장의 package.json. 없거나 읽지 못하면 undefined. */
function readExtensionManifest(extensionDir: string): ExtensionManifest | undefined {
  const manifestPath = path.join(extensionDir, "package.json");
  if (!fs.existsSync(manifestPath)) return undefined;
  const manifest: unknown = parseJsonc(fs.readFileSync(manifestPath, "utf8"));
  return typeof manifest === "object" && manifest !== null ? manifest : undefined;
}

/** package.json 의 `%키%` 문자열을 package.nls.json(영어 기본값)으로 푼다. */
function localizeManifestString(extensionDir: string, value: string): string {
  const key = /^%(.+)%$/.exec(value)?.[1];
  const nlsPath = path.join(extensionDir, "package.nls.json");
  if (key === undefined || !fs.existsSync(nlsPath)) return value;
  const nls = parseJsonc(fs.readFileSync(nlsPath, "utf8")) as Record<string, unknown> | undefined;
  const entry = nls?.[key];
  if (typeof entry === "string") return entry;
  if (typeof entry === "object" && entry !== null && "message" in entry) {
    return String(entry.message);
  }
  return value;
}

// 테마 설정 키마다 — 그 테마를 기여하는 package.json 항목과, VS Code 가 설정 값과 맞춰 보는
// 테마 식별자(settingsId). 식별자 규칙은 VS Code 의 ColorThemeData · FileIconThemeData 와 같다:
// 색 테마는 id → label → path 의 파일 이름 순, 아이콘 테마는 id.
const themeSettings = [
  {
    key: "workbench.colorTheme",
    contributes: "themes",
    settingsIdOf: (theme: ThemeContribution, extensionDir: string): unknown =>
      theme.id ??
      (typeof theme.label === "string"
        ? localizeManifestString(extensionDir, theme.label)
        : typeof theme.path === "string"
          ? path.basename(theme.path)
          : undefined),
  },
  {
    key: "workbench.iconTheme",
    contributes: "iconThemes",
    settingsIdOf: (theme: ThemeContribution): unknown => theme.id,
  },
];

/** 그 확장이 설정 값 `settingsId` 의 테마를 기여하면 참. */
function contributesTheme(
  extensionDir: string,
  manifest: ExtensionManifest,
  themeSetting: (typeof themeSettings)[number],
  settingsId: string,
): boolean {
  const contributions = manifest.contributes?.[themeSetting.contributes];
  return (
    Array.isArray(contributions) &&
    contributions.some(
      (theme: ThemeContribution) => themeSetting.settingsIdOf(theme, extensionDir) === settingsId,
    )
  );
}

/** 확장의 engines.vscode 하한이 시연 VS Code 버전보다 높으면 참 — 시연 VS Code 가 그 확장을 싣지 않는다. */
function requiresNewerVsCode(manifest: ExtensionManifest): boolean {
  const engine = manifest.engines?.vscode;
  const required = typeof engine === "string" ? /(\d+)\.(\d+)\.(\d+)/.exec(engine) : null;
  if (required === null) return false;
  const demo = VSCODE_VERSION.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const requiredPart = Number(required[index + 1]);
    if (requiredPart !== demo[index]) return requiredPart > demo[index]!;
  }
  return false;
}

/** 시연 VS Code 의 내장 확장 폴더들. Windows 판은 실행 파일 옆 커밋 해시 폴더 아래에 resources 를 둔다. */
function builtinExtensionDirs(vscodeExePath: string): string[] {
  const exeDir = path.dirname(vscodeExePath);
  const candidates = [
    path.join(exeDir, "resources", "app", "extensions"),
    ...fs
      .readdirSync(exeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(exeDir, entry.name, "resources", "app", "extensions")),
    path.join(exeDir, "..", "Resources", "app", "extensions"), // macOS
  ];
  const builtinRoot = candidates.find((candidate) => fs.existsSync(candidate));
  if (builtinRoot === undefined) {
    throw new Error(`시연 VS Code 의 내장 확장 폴더를 찾지 못했습니다: ${exeDir}`);
  }
  return fs.readdirSync(builtinRoot).map((name) => path.join(builtinRoot, name));
}

/**
 * 사용자 VS Code 에 설치된 확장 폴더들 — 확장 폴더의 목록 파일(extensions.json) 기준.
 * 지웠지만 아직 폴더가 남은 확장은 목록 파일에 없어 제외된다.
 */
function userExtensionDirs(): string[] {
  const listPath = path.join(userExtensionsRoot, "extensions.json");
  if (!fs.existsSync(listPath)) return [];
  const entries = parseJsonc(fs.readFileSync(listPath, "utf8")) as { relativeLocation?: unknown }[];
  return entries.flatMap((entry) =>
    typeof entry.relativeLocation === "string"
      ? [path.join(userExtensionsRoot, entry.relativeLocation)]
      : [],
  );
}

/**
 * 외관 설정이 가리키는 테마를 기여하는 확장을 사용자 확장 폴더에서 시연 extensionsDir 로 복사한다.
 * VS Code 내장 테마와 값이 없는 설정(VS Code 기본 테마 = 내장)은 복사할 것이 없다.
 * 테마 확장을 찾지 못하거나 시연 VS Code 가 실을 수 없으면 오류로 멈춘다 — VS Code 는 테마를 못 찾으면
 * 기본 테마로 조용히 바꾸므로, 진행하면 사용자 화면과 다른 외관이 스크린샷 · README 이미지에 남는다.
 */
function copyThemeExtensions(
  vscodeExePath: string,
  appearanceSettings: Record<string, unknown>,
  extensionsDir: string,
): void {
  const builtinDirs = builtinExtensionDirs(vscodeExePath);
  const userDirs = userExtensionDirs();
  for (const themeSetting of themeSettings) {
    const settingsId = appearanceSettings[themeSetting.key];
    // undefined = 사용자 설정에 없음(기본 테마), null = 아이콘 테마 없음 — 둘 다 복사할 확장이 없다.
    if (settingsId == null) continue;
    if (typeof settingsId !== "string") {
      throw new Error(`사용자 VS Code 설정 ${themeSetting.key} 가 문자열이 아닙니다`);
    }
    const providedBy = (extensionDir: string) => {
      const manifest = readExtensionManifest(extensionDir);
      return (
        manifest !== undefined && contributesTheme(extensionDir, manifest, themeSetting, settingsId)
      );
    };
    if (builtinDirs.some(providedBy)) continue;

    const sourceDir = userDirs.find(providedBy);
    if (sourceDir === undefined) {
      throw new Error(
        `사용자 VS Code 설정 ${themeSetting.key}="${settingsId}" 의 테마를 기여하는 확장을 ` +
          `시연 VS Code ${VSCODE_VERSION} 의 내장 확장과 사용자 확장 폴더(${userExtensionsRoot})에서 ` +
          `찾지 못했습니다 — 사용자 화면과 다른 외관으로 시연하지 않도록 멈춥니다.`,
      );
    }
    if (requiresNewerVsCode(readExtensionManifest(sourceDir)!)) {
      throw new Error(
        `${themeSetting.key}="${settingsId}" 의 테마 확장(${sourceDir})이 시연 VS Code ` +
          `${VSCODE_VERSION} 보다 새 버전을 요구해 실리지 않습니다 — 사용자 화면과 다른 외관으로 ` +
          `시연하지 않도록 멈춥니다.`,
      );
    }
    const destDir = path.join(extensionsDir, path.basename(sourceDir));
    if (!fs.existsSync(destDir)) {
      fs.cpSync(sourceDir, destDir, { recursive: true });
    }
  }
}

/** 값이 배열이 아닌 객체면 참. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 그 경로에 파일이 있으면 참 — 폴더는 거른다. */
function isFile(filePath: string): boolean {
  return fs.statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** 환경 변수 값. Windows 는 이름의 대소문자를 가르지 않는다. */
function envValue(env: Record<string, string>, name: string): string | undefined {
  if (process.platform !== "win32") return env[name];
  return Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

// ---- 시연 셸 탐지 ----
// 시연 VS Code 가 띄울 셸은 VS Code 에 직접 묻는다 — 하네스는 VS Code 의 셸 고르기 규칙을 옮기지 않는다.
// 하네스 전용 탐지 확장(demo/shell-probe)을 실은 VS Code 를 시연과 같은 실행 파일 · 설정 · 환경 변수로 잠깐 띄워,
// VS Code 가 고른 기본 셸(vscode.env.shell)과 그때 제품이 읽을 터미널 설정(VS Code 기본값과 합쳐진 값)을 받는다.
// 그 답을 제품의 셸 해석 모듈(packages/terminal/src/shell-launch.ts)에 넣어, 제품이 그 셸에 쓸 프로필을 고른다.
// - 탐지용 VS Code 는 터미널을 열지 않아 셸을 띄우지 않는다.
// - 탐지용 VS Code 의 extensions 는 시연 것을 쓰고, user-data 는 시연 것과 따로 둔다(둘 다 사용자 것과 격리).
//   같은 user-data 를 쓰면 탐지용 VS Code 가 남긴 창 · 세션 상태가 시연(특히 같은 user-data 로 다시 띄우는
//   재시작 시연)에 섞인다.
// - 답은 캐시한다(shellProbeDir). 키는 VS Code 실행 파일 · 버전, 탐지에 넣는 터미널 설정, 셸 해석에 영향을 주는
//   환경 변수다.
// - 시연 VS Code 에도 탐지 확장을 실어, VS Code 가 실제로 고른 셸이 탐지한 셸과 다르면 멈춘다. 캐시가 낡았거나
//   (셸을 새로 깔았는데 키가 같음) 탐지와 시연의 조건이 다를 때(열린 워크스페이스의 설정 등)를 잡는다.

/** 이 OS 의 터미널 설정 키 끝말 — `terminal.integrated.profiles.windows` · `.osx` · `.linux`. */
const profileOs = profileOsOf(process.platform);

/** 이 OS 의 터미널 프로필 설정 키. */
const terminalProfilesKey = `terminal.integrated.profiles.${profileOs}`;

/** 이 OS 의 기본 터미널 프로필 설정 키. */
const defaultTerminalProfileKey = `terminal.integrated.defaultProfile.${profileOs}`;

// 탐지 캐시의 키에 넣는 설정 — VS Code 가 기본 셸을 고르고 제품이 셸을 해석할 때 읽는 터미널 설정
// (shell-launch.ts 의 ShellSettings 의 출처).
const shellSettingKeys = [
  defaultTerminalProfileKey,
  terminalProfilesKey,
  "terminal.integrated.useWslProfiles",
  `terminal.integrated.env.${profileOs}`,
];

// 탐지 캐시의 키에 넣는 환경 변수 — VS Code 가 프로필 자리(감지 프로필 · PowerShell 설치 · Git Bash)와 시스템
// 셸을 정하고 PATH 에서 실행 파일을 찾을 때 읽는 변수다. 설정이 `${env:이름}` 으로 가리키는 변수도 더한다.
const shellEnvNames = [
  "PATH",
  "PATHEXT",
  "windir",
  "HOMEDRIVE",
  "USERPROFILE",
  "HOME",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "PROCESSOR_ARCHITEW6432",
  "CMDER_ROOT",
  "SHELL",
];

/** 하네스 전용 탐지 확장의 폴더. */
const shellProbeExtensionDir = path.join(rootDir, "demo", "shell-probe");

/** 탐지 확장의 식별자(publisher.name) — VS Code 가 그 확장의 전역 저장 폴더 이름으로 쓴다. */
const shellProbeExtensionId = "simplysm-demo.shell-probe";

/** 탐지 캐시와 탐지용 VS Code 의 user-data 를 두는 하네스 전용 폴더. */
const shellProbeDir = path.join(rootDir, ".vscode-test", "shell-probe");

/** 탐지 확장의 첫 답이 온 뒤 더 기다리는 시간 — 기본 프로필이 처음 정해진 뒤 곧 다시 바뀌는 경우를 받는다. */
const shellReportSettleMs = 1_000;

/** 탐지 확장의 답을 기다리는 최대 시간. */
const shellReportTimeoutMs = 60_000;

/** 탐지 확장이 적는 답 하나 — VS Code 가 고른 기본 셸과, 그때 제품이 읽을 터미널 설정. */
type ShellReport = { readonly shell: string; readonly settings: ShellSettings };

/** 그 user-data 에서 탐지 확장이 답을 적는 폴더(그 확장의 전역 저장 폴더). */
function shellReportDir(userDataDir: string): string {
  return path.join(userDataDir, "User", "globalStorage", shellProbeExtensionId);
}

/** 탐지 확장이 지금까지 적은 답들 — 적은 순서. */
function readShellReports(userDataDir: string): ShellReport[] {
  const reportDir = shellReportDir(userDataDir);
  if (!fs.existsSync(reportDir)) return [];
  return fs
    .readdirSync(reportDir)
    .filter((name) => /^report-\d+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(reportDir, name), "utf8")) as ShellReport);
}

/** 탐지 확장의 첫 답을 기다려 그때까지의 답들을 돌려준다. 제한 시간 안에 오지 않으면 오류. */
async function waitForShellReports(userDataDir: string): Promise<ShellReport[]> {
  const deadline = Date.now() + shellReportTimeoutMs;
  for (;;) {
    const reports = readShellReports(userDataDir);
    if (reports.length > 0) return reports;
    if (Date.now() > deadline) {
      throw new Error(
        `탐지 확장이 ${shellReportTimeoutMs}ms 안에 VS Code 의 기본 셸(vscode.env.shell)을 알리지 않았습니다: ` +
          shellReportDir(userDataDir),
      );
    }
    await sleep(100);
  }
}

/** 탐지 캐시의 키 — VS Code 실행 파일 · 버전, 탐지에 넣는 터미널 설정, 셸 해석에 영향을 주는 환경 변수. */
function shellProbeCacheKey(
  vscodeExePath: string,
  settings: Record<string, unknown>,
  env: Record<string, string>,
): string {
  const shellSettings = Object.fromEntries(
    shellSettingKeys.filter((key) => key in settings).map((key) => [key, settings[key]]),
  );
  const referencedEnvNames = [...JSON.stringify(shellSettings).matchAll(/\$\{env:([^}]+)\}/g)].map(
    (match) => match[1]!,
  );
  const envNames = [
    ...new Set(
      [...shellEnvNames, ...referencedEnvNames].map((name) =>
        process.platform === "win32" ? name.toUpperCase() : name,
      ),
    ),
  ].sort();
  return JSON.stringify({
    vscodeExePath,
    vscodeVersion: VSCODE_VERSION,
    settings: shellSettings,
    env: Object.fromEntries(envNames.map((name) => [name, envValue(env, name) ?? null])),
  });
}

/**
 * 탐지용 VS Code 를 띄워 VS Code 가 고른 기본 셸을 물는다. 설정 · 환경 변수 · extensions 는 시연과 같고,
 * user-data 는 이번 탐지만 쓰고 지운다. 폴더를 열지 않고 터미널도 열지 않는다.
 */
async function runShellProbe(
  vscodeExePath: string,
  extensionsDir: string,
  settings: Record<string, unknown>,
  env: Record<string, string>,
): Promise<ShellReport> {
  const runsDir = path.join(shellProbeDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(runsDir, "user-data-"));
  try {
    const settingsPath = path.join(userDataDir, "User", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const app = await startVsCodeWindow(vscodeExePath, env, [
      "--disable-workspace-trust",
      `--extensions-dir=${extensionsDir}`,
      `--user-data-dir=${userDataDir}`,
      `--extensionDevelopmentPath=${shellProbeExtensionDir}`,
    ]);
    try {
      await waitForShellReports(userDataDir);
      await sleep(shellReportSettleMs);
      return readShellReports(userDataDir).at(-1)!;
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/**
 * VS Code 가 그 설정 · 환경 변수에서 고를 기본 셸 — 캐시에 있으면 그 답을, 없으면 탐지용 VS Code 에 물어 캐시한다.
 * 캐시한 셸 파일이 없어졌으면 다시 묻는다. `cacheEntry` 는 그 답을 담은 캐시 파일이다.
 */
async function probeShell(
  vscodeExePath: string,
  extensionsDir: string,
  settings: Record<string, unknown>,
  env: Record<string, string>,
): Promise<{ report: ShellReport; cacheEntry: string }> {
  const key = shellProbeCacheKey(vscodeExePath, settings, env);
  const cachePath = path.join(
    shellProbeDir,
    "cache",
    `${createHash("sha256").update(key).digest("hex")}.json`,
  );
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      key: string;
      report: ShellReport;
    };
    const shell = cached.report.shell;
    if (cached.key === key && (!path.isAbsolute(shell) || isFile(shell))) {
      return { report: cached.report, cacheEntry: cachePath };
    }
  }
  const report = await runShellProbe(vscodeExePath, extensionsDir, settings, env);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ key, report }));
  return { report, cacheEntry: cachePath };
}

/** 탐지한 답으로 제품이 새 세션에 쓸 셸을 푸는다 — 제품과 같은 해석 모듈(shell-launch.ts)이다. */
function resolveDemoShellLaunch(
  report: ShellReport,
  env: Record<string, string>,
): ResolvedShellLaunch {
  return resolveShellLaunch({
    os: profileOs,
    shellPath: report.shell,
    settings: report.settings,
    processEnv: env,
    variables: {
      folders: [],
      userHome: os.homedir(),
      processCwd: process.cwd(),
      readConfiguration: () => undefined,
      extensionPath: () => undefined,
    },
    isFile,
    ...(profileOs === "windows" || !isFile("/etc/shells")
      ? {}
      : { unixShells: fs.readFileSync("/etc/shells", "utf8") }),
  });
}

/**
 * 시연 VS Code 가 실제로 고른 기본 셸이 탐지한 셸과 같은지 확인한다. 비교하는 것은 기동 뒤 첫 답이다.
 * 다르면 그 답을 낸 탐지 캐시 항목을 지우고 오류로 멈춘다 — 입력 기록 격리 인자를 붙인 프로필이 그 셸에
 * 쓰이는지 알 수 없다. 항목을 지웠으므로 다음 실행은 탐지용 VS Code 에 새로 묻는다.
 */
async function checkDemoShell(userDataDir: string, demoShell: DemoShell): Promise<void> {
  const [firstReport] = await waitForShellReports(userDataDir);
  if (firstReport!.shell === demoShell.shell) return;
  for (const cacheEntry of demoShell.cacheEntries) fs.rmSync(cacheEntry, { force: true });
  throw new Error(
    `시연 VS Code 가 고른 기본 셸(${firstReport!.shell})이 탐지한 셸(${demoShell.shell})과 다릅니다 — ` +
      `탐지 캐시가 낡았거나 탐지와 시연의 조건이 다릅니다. 입력 기록 격리 인자가 그 셸에 붙었는지 알 수 없어 ` +
      `멈춥니다. 그 답을 낸 탐지 캐시 항목(${demoShell.cacheEntries.join(", ")})을 지웠으니 다시 실행하면 ` +
      `새로 묻습니다.`,
  );
}

/** 프로필 설정 항목이 프로필을 만들면(path · source 가 있으면) 참. 아니면 같은 이름의 프로필을 지우는 항목이다. */
function isProfileEntry(profile: unknown): profile is Record<string, unknown> {
  return isPlainObject(profile) && ("path" in profile || "source" in profile);
}

// ---- 시연 셸의 입력 기록 격리 ----
// 사용자 설정 재현이 아니라 하네스 고정 조작이다. 시연 셸은 사용자와 같은 셸 · 프로필 스크립트로 뜬다. 그대로 두면
// PowerShell 의 PSReadLine 이 사용자의 입력 기록 파일(ConsoleHost_history.txt)을 읽고(위 화살표 · 입력 추천)
// 시연 입력을 거기 쌓는다 — 시연 명령이 사용자의 실제 입력 기록과 입력 추천에 남는, 하네스가 사용자 환경을
// 고치는 부작용이다. 그 파일 자리는 Windows 에서 known folder(ApplicationData)로 정해져 환경 변수로 돌릴 수 없고,
// 공식 수단은 세션 안의 `Set-PSReadLineOption -HistorySavePath` 뿐이다. 그래서 시연 설정의 기본 프로필 인자 끝에
// `-NoExit -File <init>` 을 붙이고, init 스크립트가 저장 위치를 그 시연의 user-data 아래로 돌린다.
// - pwsh 는 프로필 스크립트($PROFILE)를 실행한 다음 -File 스크립트를 실행한다. 사용자 프로필이 저장 위치를 바꿔도
//   init 이 나중에 바꿔 시연 폴더가 이긴다.
// - PSReadLine 은 첫 프롬프트에서 입력 기록 파일을 읽는다(DelayedOneTimeInitialize). init 은 그 전에 실행되므로
//   사용자 파일은 읽히지도 않는다.
// - `-NoExit -File` 은 시작 배너와 사용자 프롬프트를 그대로 둔다. `-Command` 는 배너를 없애고, `-NoProfile` 은
//   사용자 프롬프트를 바꿔 쓰지 않는다.
// 인자를 붙일 프로필은 VS Code 가 고른 기본 셸(위 "시연 셸 탐지")을 제품이 어느 프로필로 띄우는지로 정한다 —
// 기본 프로필을 정하지 않아 VS Code 가 대신 고른 셸도 같다. 그 프로필이 설정에 없는 자동 감지 프로필이면, 같은 이름 ·
// 같은 해석 결과의 항목을 시연 설정에 넣고 VS Code 가 고르는 셸이 그대로인지 다시 물어 확인한다.
// 손대지 않는 경우: PowerShell 이 아닌 셸 — 시연 spec 은 PowerShell 문법으로 입력해 PowerShell 을 전제한다.
// cmd 는 입력 기록을 파일에 남기지 않는다. bash 등이 기본 셸이 되면 그 셸의 격리 수단(HISTFILE 등)을 따로 두어야 한다.

type PwshParameterKind = "switch" | "value" | "run";

// pwsh 명령줄 매개변수 — PowerShell 7.6 의 CommandLineParameterParser.ParseHelper 가 검사하는 순서 그대로다
// (별칭은 따로 한 줄). [이름, 가장 짧은 약어, 종류, Windows 전용].
// 인자에서 `-` · `--` · `/` 를 뗀 나머지가 이름의 앞부분이고 가장 짧은 약어보다 짧지 않으면 그 매개변수다(대소문자 무시).
// 종류: switch = 값 없음, value = 다음 인자가 값, run = 실행할 것(스크립트 · 명령 · 그 인자)을 정한다.
// https://github.com/PowerShell/PowerShell/blob/v7.6.0/src/Microsoft.PowerShell.ConsoleHost/host/msh/CommandLineParameterParser.cs
const pwshParameters: readonly (readonly [
  name: string,
  shortest: string,
  kind: PwshParameterKind,
  windowsOnly?: true,
])[] = [
  ["version", "v", "switch"],
  ["help", "h", "switch"],
  ["?", "?", "switch"],
  ["login", "l", "switch"],
  ["noexit", "noe", "switch"],
  ["noprofile", "nop", "switch"],
  ["nologo", "nol", "switch"],
  ["noninteractive", "noni", "switch"],
  ["socketservermode", "so", "switch"],
  ["v2socketservermode", "v2so", "switch", true],
  ["servermode", "s", "switch"],
  ["namedpipeservermode", "nam", "switch"],
  ["sshservermode", "sshs", "switch"],
  ["noprofileloadtime", "noprofileloadtime", "switch"],
  ["interactive", "i", "switch"],
  ["configurationfile", "configurationfile", "value"],
  ["configurationname", "config", "value"],
  ["custompipename", "cus", "value"],
  ["commandwithargs", "commandwithargs", "run"],
  ["cwa", "cwa", "run"],
  ["command", "c", "run"],
  ["windowstyle", "w", "value"],
  ["file", "f", "run"],
  ["outputformat", "o", "value"],
  ["of", "o", "value"],
  ["inputformat", "inp", "value"],
  ["if", "if", "value"],
  ["executionpolicy", "ex", "value"],
  ["ep", "ep", "value"],
  ["encodedcommand", "e", "run"],
  ["ec", "e", "run"],
  ["encodedarguments", "encodeda", "run"],
  ["ea", "ea", "run"],
  ["settingsfile", "settings", "value"],
  ["sta", "sta", "switch"],
  ["mta", "mta", "switch"],
  ["workingdirectory", "wo", "value"],
  ["wd", "wd", "value"],
  [
    "removeworkingdirectorytrailingcharacter",
    "removeworkingdirectorytrailingcharacter",
    "switch",
    true,
  ],
  ["token", "to", "value", true],
  ["utctimestamp", "utc", "value", true],
];

/** pwsh 가 대시로 치는 글자(CharExtensions.IsDash) — hyphen-minus · en dash · em dash · horizontal bar. */
const pwshDashes = ["-", "\u2013", "\u2014", "\u2015"];

/**
 * pwsh 인자에서 실행할 것을 정하는 첫 인자. 없으면 undefined.
 * -File · -Command 같은 매개변수와, pwsh 가 매개변수로 알아보지 못해 스크립트 파일로 보는 인자(위치 인자 포함)다.
 */
function findPwshRunArgument(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!.trim();
    const prefix = arg.charAt(0);
    if (!pwshDashes.includes(prefix) && prefix !== "/") return args[index];
    let key = arg.slice(1);
    if (pwshDashes.includes(prefix) && key.startsWith(prefix)) key = key.slice(1);
    const lowerKey = key.toLowerCase();
    const parameter = pwshParameters.find(
      ([name, shortest, , windowsOnly]) =>
        (windowsOnly !== true || process.platform === "win32") &&
        lowerKey.length >= shortest.length &&
        name.startsWith(lowerKey),
    );
    if (parameter === undefined || parameter[2] === "run") return args[index];
    if (parameter[2] === "value") index++;
  }
  return undefined;
}

/**
 * Windows 명령줄을 프로그램이 받는 인자로 나눈다(CommandLineToArgvW 규칙). 공백 · 탭이 인자를 가르고, 큰따옴표 안의
 * 공백은 가르지 않는다. 큰따옴표 앞의 역슬래시 2n 개는 n 개가 되고, 2n+1 개는 n 개와 글자 그대로의 큰따옴표가 된다.
 * 따옴표 안의 `""` 는 큰따옴표 하나다.
 */
function splitWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let inQuotes = false;
  for (let index = 0; index < commandLine.length; index++) {
    const char = commandLine[index]!;
    if (char === "\\") {
      let slashes = 0;
      while (commandLine[index] === "\\") {
        slashes++;
        index++;
      }
      if (commandLine[index] === '"') {
        current += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) current += '"';
        else inQuotes = !inQuotes;
      } else {
        current += "\\".repeat(slashes);
        index--;
      }
      inArg = true;
    } else if (char === '"') {
      if (inQuotes && commandLine[index + 1] === '"') {
        current += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      inArg = true;
    } else if ((char === " " || char === "\t") && !inQuotes) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += char;
      inArg = true;
    }
  }
  if (inArg) args.push(current);
  return args;
}

/**
 * PowerShell 인자 끝에 붙인 `-NoExit -File <init>` 이 init 으로 실행되지 않는 까늭. 실행되면 undefined.
 * `shellName` 은 셸 실행 파일의 이름(pwsh · powershell)이다.
 */
function powerShellInitArgsBlocker(
  shellName: string,
  userArgs: readonly string[],
): string | undefined {
  if (shellName !== "pwsh") {
    return userArgs.length === 0
      ? undefined
      : `셸이 Windows PowerShell 이고 인자가 있습니다. 하네스는 Windows PowerShell 의 인자 규칙을 따지지 않아 ` +
          `붙인 인자가 해석되는 방식을 확인할 수 없습니다`;
  }
  const runArgument = findPwshRunArgument(userArgs);
  return runArgument === undefined
    ? undefined
    : `인자 ${JSON.stringify(runArgument)} 를 pwsh 는 실행할 것(스크립트 · 명령)으로 받습니다(-File · -Command 같은 ` +
        `매개변수이거나, 매개변수로 알아보지 못해 스크립트 파일로 보는 인자). pwsh 는 실행할 것을 하나만 받고, ` +
        `-File · -Command · 스크립트 파일은 그 뒤의 인자를 모두 제 몫으로 가져갑니다`;
}

/** 입력 기록 격리용으로 PowerShell 프로필 인자 끝에 붙이는 인자. */
function powerShellInitArgs(initPath: string): string[] {
  return ["-NoExit", "-File", initPath];
}

/** 제품이 셸에 넘길 인자가 입력 기록 격리용 인자로 끝나면 참. */
function endsWithInitArgs(args: string | readonly string[], initPath: string): boolean {
  const argList = typeof args === "string" ? splitWindowsCommandLine(args) : args;
  const initArgs = powerShellInitArgs(initPath);
  return (
    argList.length >= initArgs.length &&
    argList.slice(-initArgs.length).every((arg, index) => arg === initArgs[index])
  );
}

/**
 * PowerShell 프로필의 인자 끝에 `-NoExit -File <init>` 을 붙인 값. `shellName` 은 셸 실행 파일의 이름(pwsh · powershell)이다. 붙인 `-File` 이 init 으로 실행되지 않으면
 * 오류로 멈춘다 — 진행하면 시연 셸이 사용자의 입력 기록을 쓴다.
 * 인자는 VS Code 가 셸에 넘기는 대로 다룬다. 배열은 인자 목록이다. 문자열은 Windows 에서만 명령줄 그대로 넘기고,
 * 다른 OS 에서는 버린다. 사용자 인자에 -NoExit 가 있어도 따지지 않는다 — pwsh 는 같은 스위치를 거듭 써도 된다.
 */
function withPowerShellInitArgs(
  args: unknown,
  shellName: string,
  initPath: string,
  profileLabel: string,
): string | unknown[] {
  const initArgs = powerShellInitArgs(initPath);
  const commandLine = typeof args === "string" && process.platform === "win32" ? args : undefined;
  const argList = Array.isArray(args) ? args : [];
  const userArgs =
    commandLine === undefined ? argList.map(String) : splitWindowsCommandLine(commandLine);
  const blocker = powerShellInitArgsBlocker(shellName, userArgs);
  const combined =
    commandLine === undefined ? undefined : `${commandLine} -NoExit -File "${initPath}"`;
  // 사용자 명령줄의 닫히지 않은 따옴표 등으로, 붙인 인자가 따로 나뉘지 않는 경우도 멈춘다.
  const combinedArgs = combined === undefined ? undefined : splitWindowsCommandLine(combined);
  const splitBlocker =
    combinedArgs === undefined ||
    (combinedArgs.length === userArgs.length + initArgs.length &&
      combinedArgs.slice(userArgs.length).every((arg, index) => arg === initArgs[index]))
      ? undefined
      : `명령줄 끝에 붙인 "-NoExit -File <init>" 이 따로 인자로 나뉘지 않습니다`;
  const reason = blocker ?? splitBlocker;
  if (reason !== undefined) {
    throw new Error(
      `${profileLabel} 의 인자 끝에 하네스가 입력 기록 격리용 "-NoExit -File <init>" 을 ` +
        `붙일 수 없습니다 — ${reason}. 시연 셸이 사용자의 PowerShell 입력 기록을 쓰지 않도록 멈춥니다.`,
    );
  }
  return combined ?? [...argList, ...initArgs];
}

/** PowerShell 작은따옴표 문자열. 작은따옴표로 치는 글자(' · ‘ · ’ · ‚ · ‛)는 두 번 써서 글자 그대로 둔다. */
function powerShellSingleQuoted(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/** 시연 셸 준비 결과 — 시연 VS Code 에 쓸 설정과, VS Code 가 고를 기본 셸. */
export type DemoShell = {
  readonly settings: Record<string, unknown>;
  readonly shell: string;
  /** 이 답을 낸 탐지 캐시 항목들 — 시연 VS Code 가 실제로 고른 셸이 다르면 지운다. */
  readonly cacheEntries: readonly string[];
};

/**
 * 시연 설정에서 VS Code 가 띄울 기본 셸을 탐지하고(위 "시연 셸 탐지"), 그 셸이 PowerShell 이면 입력 기록을
 * 격리한 설정을 돌려준다(위 "시연 셸의 입력 기록 격리"). init 스크립트는 `<userDataDir>/demo-shell/` 에 만들고,
 * 그 시연 셸의 입력 기록은 `<userDataDir>/demo-shell/ConsoleHost_history.txt` 에 쌓인다.
 * 다음 경우 오류로 멈춘다.
 * - 기본 프로필을 정했는데 VS Code 가 고른 셸이 그 프로필에서 나오지 않았다 — VS Code 는 기본 프로필의 셸을
 *   못 찾으면 다른 셸로 조용히 바꾸므로, 진행하면 설정한 셸과 다른 셸이 스크린샷 · README 이미지에 남는다.
 * - PowerShell 인데 격리 인자를 붙일 수 없거나, 붙인 뒤 VS Code 가 고르는 셸이 바뀌거나, 제품이 붙인 인자를 쓰지
 *   않는다 — 진행하면 시연 셸이 사용자의 입력 기록을 쓴다.
 * 시연이 시연 VS Code 의 설정 파일을 직접 고칠 때도 이것을 거쳐 써야 그 뒤에 뜨는 셸이 격리된다.
 * `dirs.extensionsDir` 는 탐지용 VS Code 가 쓸 시연의 extensions, `env` 는 시연 VS Code 에 줄 환경 변수다.
 */
export async function prepareDemoShell(
  vscodeExePath: string,
  dirs: { extensionsDir: string; userDataDir: string },
  settings: Record<string, unknown>,
  env: Record<string, string> = demoProcessEnv({}),
): Promise<DemoShell> {
  const { report, cacheEntry } = await probeShell(
    vscodeExePath,
    dirs.extensionsDir,
    settings,
    env,
  );
  const cacheEntries = [cacheEntry];
  const launch = resolveDemoShellLaunch(report, env);
  const defaultProfileName = report.settings.defaultProfileName;
  if (
    typeof defaultProfileName === "string" &&
    defaultProfileName.length > 0 &&
    launch.profileName !== defaultProfileName
  ) {
    const chosenProfile =
      launch.profileName === undefined ? "VS Code 가 만든 프로필" : `프로필 "${launch.profileName}"`;
    throw new Error(
      `시연 설정 ${defaultTerminalProfileKey}="${defaultProfileName}" 의 셸 대신 VS Code 가 다른 셸` +
        `(${report.shell}, ${chosenProfile})을 골랐습니다. VS Code 가 그 프로필의 셸을 찾지 못했거나 그 이름으로 ` +
        `고를 수 없는 프로필입니다 — 설정한 셸과 다른 셸로 시연하지 않도록 멈춥니다.`,
    );
  }
  const shellName = path.parse(report.shell).name.toLowerCase();
  if (shellName !== "pwsh" && shellName !== "powershell") {
    return { settings, shell: report.shell, cacheEntries };
  }

  const stopSuffix = "시연 셸이 사용자의 PowerShell 입력 기록을 쓰지 않도록 멈춥니다.";
  const profileName = launch.profileName;
  if (profileName === undefined) {
    throw new Error(
      `VS Code 가 고른 셸(${report.shell})이 어느 프로필에서도 나오지 않았습니다(VS Code 가 만든 프로필). ` +
        `하네스가 입력 기록 격리용 인자를 붙일 프로필이 없습니다 — ${stopSuffix}`,
    );
  }
  const shellDir = path.join(dirs.userDataDir, "demo-shell");
  const initPath = path.join(shellDir, "init.ps1");
  const mergedProfiles = isPlainObject(report.settings.profiles) ? report.settings.profiles : {};
  const configuredProfile = mergedProfiles[profileName];
  // 자동 감지 프로필은 설정에 없다 — 같은 이름에 같은 해석 결과(셸 경로 · 인자)의 항목을 넣고 거기에 붙인다.
  const autoDetected = !isProfileEntry(configuredProfile);
  const baseProfile: Record<string, unknown> = autoDetected
    ? { path: report.shell, args: launch.args }
    : configuredProfile;
  const profile = {
    ...baseProfile,
    args: withPowerShellInitArgs(
      baseProfile.args,
      shellName,
      initPath,
      `시연 설정의 터미널 프로필 "${profileName}"`,
    ),
  };
  const settingProfiles = settings[terminalProfilesKey];
  const isolatedSettings = {
    ...settings,
    [terminalProfilesKey]: {
      ...(isPlainObject(settingProfiles) ? settingProfiles : {}),
      [profileName]: profile,
    },
  };

  // 붙인 인자를 제품이 쓰는지 제품의 해석으로 확인한다. 설정에 있던 프로필은 인자만 바뀌어 VS Code 가 고르는
  // 셸이 그대로다(셸 고르기는 인자를 보지 않는다). 자동 감지 프로필은 항목을 넣었으니 VS Code 에 다시 물어 본다.
  let isolatedReport: ShellReport;
  if (autoDetected) {
    const isolatedProbe = await probeShell(
      vscodeExePath,
      dirs.extensionsDir,
      isolatedSettings,
      env,
    );
    cacheEntries.push(isolatedProbe.cacheEntry);
    isolatedReport = isolatedProbe.report;
  } else {
    isolatedReport = {
      shell: report.shell,
      settings: { ...report.settings, profiles: { ...mergedProfiles, [profileName]: profile } },
    };
  }
  if (isolatedReport.shell !== report.shell) {
    throw new Error(
      `자동 감지 프로필 "${profileName}" 을 시연 설정에 넣자 VS Code 가 고르는 셸이 ${report.shell} 에서 ` +
        `${isolatedReport.shell} (으)로 바뀌었습니다 — 설정한 셸과 다른 셸로 시연하지 않도록 멈춥니다.`,
    );
  }
  const isolatedLaunch = resolveDemoShellLaunch(isolatedReport, env);
  if (isolatedLaunch.profileName !== profileName || !endsWithInitArgs(isolatedLaunch.args, initPath)) {
    throw new Error(
      `터미널 프로필 "${profileName}" 에 붙인 입력 기록 격리용 인자를 제품이 쓰지 않습니다(제품이 고른 프로필: ` +
        `${isolatedLaunch.profileName ?? "없음"}, 인자: ${JSON.stringify(isolatedLaunch.args)}) — ${stopSuffix}`,
    );
  }

  fs.mkdirSync(shellDir, { recursive: true });
  // BOM 을 붙인다 — Windows PowerShell 은 BOM 없는 스크립트를 시스템 코드 페이지로 읽어 비 ASCII 글자가 깨진다.
  fs.writeFileSync(
    initPath,
    "\uFEFF# 시연 하네스가 만든 파일 — 시연 셸의 PSReadLine 입력 기록을 이 폴더로 돌려 사용자 입력 기록과 가른다.\n" +
      `Set-PSReadLineOption -HistorySavePath ${powerShellSingleQuoted(path.join(shellDir, "ConsoleHost_history.txt"))}\n`,
  );
  return { settings: isolatedSettings, shell: report.shell, cacheEntries };
}

/**
 * 시연 VS Code 의 CLI 로 확장을 하네스 캐시 폴더에 받는다 — 사용자의 VS Code 와 그 확장 폴더는 건드리지 않는다.
 */
function installExtensionToCache(
  vscodeExePath: string,
  extensionId: string,
  cacheDir: string,
): void {
  const cliPath = path.join(
    path.dirname(vscodeExePath),
    "bin",
    process.platform === "win32" ? "code.cmd" : "code",
  );
  execFileSync(
    cliPath,
    [
      `--install-extension=${extensionId}`,
      `--extensions-dir=${cacheDir}`,
      `--user-data-dir=${path.join(rootDir, ".vscode-test", "cli-user-data")}`,
    ],
    { stdio: "ignore", shell: process.platform === "win32" },
  );
}

/** 확장 폴더 묶음(`extensionsRoot`)에서 그 확장의 가장 나중 폴더. 없으면 undefined. */
function findExtensionDir(extensionsRoot: string, extensionId: string): string | undefined {
  if (!fs.existsSync(extensionsRoot)) return undefined;
  const prefix = `${extensionId.toLowerCase()}-`;
  const dirName = fs
    .readdirSync(extensionsRoot)
    .filter((name) => name.toLowerCase().startsWith(prefix))
    .sort()
    .at(-1);
  return dirName === undefined ? undefined : path.join(extensionsRoot, dirName);
}

/**
 * 표시 언어 전환은 언어 팩이 있어야 성립한다(`--locale` 만으로는 영어로 남는다).
 * 받아 둔 팩을 캐시에 두고 시연 extensionsDir 로 복사한다.
 */
function copyLanguagePack(vscodeExePath: string, locale: string, extensionsDir: string): void {
  const cacheDir = path.join(rootDir, ".vscode-test", "lang-extensions");
  const packId = `MS-CEINTL.vscode-language-pack-${locale}`;

  if (findExtensionDir(cacheDir, packId) === undefined) {
    installExtensionToCache(vscodeExePath, packId, cacheDir);
  }

  const packDir = findExtensionDir(cacheDir, packId);
  if (packDir === undefined) {
    throw new Error(`언어 팩을 받지 못했습니다: ${locale}`);
  }
  const destDir = path.join(extensionsDir, path.basename(packDir));
  if (!fs.existsSync(destDir)) {
    fs.cpSync(packDir, destDir, { recursive: true });
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
  /**
   * VS Code 프로세스(과 그 확장 호스트)의 환경 변수 — 기존 값을 덮는다. Windows 는 이름의 대소문자를 가르지 않아
   * (`Path` · `PATH`) 같은 이름의 기존 항목을 지우고 넣는다.
   */
  readonly env?: Record<string, string>;
}

/**
 * 시연 VS Code 프로세스(와 그 확장 호스트 · 셸)의 환경 변수 — 하네스의 환경에서 아래 변수를 빼고 `overrides` 로 덮는다.
 * - VSCODE_*: 남으면 webview ServiceWorker 등록이 실패한다 (InvalidStateError).
 * - ELECTRON_RUN_AS_NODE: 확장 호스트(터미널)에서 상속되면 Code.exe 가 순수 node 로 기동돼 VS Code CLI
 *   옵션을 "bad option" 으로 거부(exitCode 9)하며 기동 자체가 실패한다.
 * Windows 는 이름의 대소문자를 가르지 않아(`Path` · `PATH`) 덮을 때 같은 이름의 기존 항목을 지우고 넣는다.
 */
function demoProcessEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value != null && !/^VSCODE_/i.test(key) && key !== "ELECTRON_RUN_AS_NODE") {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(env)) {
      if (
        process.platform === "win32"
          ? existing.toUpperCase() === key.toUpperCase()
          : existing === key
      ) {
        delete env[existing];
      }
    }
    env[key] = value;
  }
  return env;
}

/** 시연 VS Code 와 탐지용 VS Code 가 함께 쓰는 실행 인자 — vscode-test 공식 러너와 같은 구성. */
const baseVsCodeArgs = [
  "--no-sandbox",
  "--disable-gpu-sandbox",
  "--disable-updates",
  "--skip-welcome",
  "--skip-release-notes",
];

/** VS Code 기동 — 재시작 시연은 같은 userDataDir 로 2회 호출해 세션 탭 복원을 재현. */
export async function launchVsCode(
  vscodeExePath: string,
  dirs: { extensionsDir: string; userDataDir: string },
  overrides: LaunchOverrides = {},
): Promise<ElectronApplication> {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const env = demoProcessEnv(overrides.env ?? {});
  const appearanceSettings = readUserAppearanceSettings();
  copyThemeExtensions(vscodeExePath, appearanceSettings, dirs.extensionsDir);
  const demoSettingsPath = path.join(dirs.userDataDir, "User", "settings.json");
  fs.mkdirSync(path.dirname(demoSettingsPath), { recursive: true });
  // VS Code 가 띄울 셸을 탐지해 설정한 기본 프로필의 셸인지 확인하고, 시연 셸의 입력 기록을 시연 폴더로
  // 돌린다 — 하네스 고정 조작(prepareDemoShell 주석 참고). 시연이 지정한 기본 프로필도 격리하도록 시연 지정
  // 설정까지 합친 뒤에 적용한다.
  const demoShell = await prepareDemoShell(
    vscodeExePath,
    dirs,
    {
      ...appearanceSettings,
      // 기동 직후 파일 열기가 확장 등록 완료 전이면 default 커스텀 에디터가 무시되고
      // 텍스트 에디터로 폴백되는 VS Code 레이스(microsoft/vscode#117145) 우회 —
      // 시연 VS Code 의 사용자 설정에 연결을 선기록해 해석을 결정적으로 만듦 (하네스 한정, 제품 동작 아님).
      "workbench.editorAssociations": { "*.tasks": "simplysm-tasks.editor" },
      // 하네스 판정은 .xterm-rows DOM 텍스트에 의존 — WebGL 렌더러는 DOM 행을 만들지 않으므로
      // 시연에선 DOM 렌더러로 고정한다 (WebGL 경로는 전용 시연이 이 값을 되돌려 확인).
      "terminal.integrated.gpuAcceleration": "off",
      // 시연 워크스페이스(demo/workspace)는 이 저장소 안에 있어, 기본값(prompt)이면 git 확장이 "A git repository
      // was found in the parent folders" 알림을 띄운다. 사용자의 실제 화면에는 없는 하네스 배치 탓이라 끄고,
      // 부모 저장소도 열지 않는다(always 면 이 저장소의 변경 수가 소스 제어 배지로 뜨는 다른 하네스 흔적이 생긴다).
      // 사용자 설정을 재현하는 키가 아니라 하네스 고정 설정이다.
      "git.openRepositoryInParentFolders": "never",
      ...overrides.settings,
    },
    env,
  );
  fs.writeFileSync(demoSettingsPath, JSON.stringify(demoShell.settings));
  if (overrides.locale != null) {
    copyLanguagePack(vscodeExePath, overrides.locale, dirs.extensionsDir);
  }
  const openTarget = overrides.openTarget === undefined ? workspaceDir : overrides.openTarget;
  // 같은 user-data 로 다시 띄우는 시연(재시작)에서 지난 기동의 탐지 답을 읽지 않게 지운다.
  fs.rmSync(shellReportDir(dirs.userDataDir), { recursive: true, force: true });
  const electronApp = await startVsCodeWindow(vscodeExePath, env, [
    ...(overrides.workspaceTrust === true ? [] : ["--disable-workspace-trust"]),
    ...(overrides.locale == null ? [] : [`--locale=${overrides.locale}`]),
    `--extensions-dir=${dirs.extensionsDir}`,
    `--user-data-dir=${dirs.userDataDir}`,
    `--extensionDevelopmentPath=${path.join(rootDir, "packages", "focus-refresh")}`,
    `--extensionDevelopmentPath=${path.join(rootDir, "packages", "local-history")}`,
    `--extensionDevelopmentPath=${path.join(rootDir, "packages", "tasks")}`,
    `--extensionDevelopmentPath=${path.join(rootDir, "packages", "terminal")}`,
    // 시연 VS Code 가 실제로 고른 셸을 탐지한 셸과 대조하려고 싣는다("시연 셸 탐지" 주석).
    `--extensionDevelopmentPath=${shellProbeExtensionDir}`,
    ...(openTarget == null ? [] : [openTarget]),
  ]);
  // 모든 시연이 close 로 끝나므로 여기서 한 번에 — 닫기 직전 시연용 daemon 을 정리해
  // 프로세스 트리 종료 대기(10초 재연결 창)를 없앤다. 탐지용 VS Code 는 터미널을 열지 않아 이 정리를 하지 않는다 —
  // 정리는 .vscode-test 의 daemon 을 모두 지우므로, 시연 도중의 탐지(설정을 바꾸는 시연)가 시연의 daemon 을 죽인다.
  // 닫기 전에 클립보드를 시연이 넣었는지도 가려 둔다 — 닫으면 시연 VS Code · 셸의 클립보드 소유 창이 사라져 가릴 수
  // 없다(clipboard-guard/clipboard-guard.ts 주석). 셸을 끝내는 daemon 정리보다 먼저 한다.
  const originalClose = electronApp.close.bind(electronApp);
  electronApp.close = async (): Promise<void> => {
    await noteDemoAppClosing();
    killDemoTerminalDaemons();
    await originalClose();
  };
  try {
    await checkDemoShell(dirs.userDataDir, demoShell);
  } catch (checkError) {
    await electronApp.close();
    throw checkError;
  }
  return electronApp;
}

/**
 * VS Code 를 띄운다 — 창이 포커스를 빼앗지 않게 하고, Windows 는 맨 뒤로 보낸다.
 * `args` 는 공통 실행 인자(baseVsCodeArgs) 뒤에 붙는다.
 */
async function startVsCodeWindow(
  vscodeExePath: string,
  env: Record<string, string>,
  args: readonly string[],
): Promise<ElectronApplication> {
  const electronApp = await _electron.launch({
    executablePath: vscodeExePath,
    env,
    args: [...baseVsCodeArgs, ...args],
  });

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

  clipboardKeeper: [
    // oxlint-disable-next-line no-empty-pattern -- playwright fixture 는 첫 인자 구조분해 서명 강제
    async ({}, use) => {
      await use(await ClipboardKeeper.create());
    },
    { scope: "worker", timeout: 180_000 }, // 처음 한 번 도구를 컴파일한다.
  ],

  // 시연이 바꾼 사용자 클립보드를 시연 뒤 되돌린다 — 설계와 적용 범위는 clipboard-guard/clipboard-guard.ts 주석.
  // 자동 fixture 라 시연이 부르지 않아도 모든 시연에 걸린다. playwright 는 자동 fixture 를 다른 fixture 보다 먼저
  // 세우고 세운 역순으로 걷어, 되돌리기는 시연 VS Code 를 닫은(electronApp 을 걷은) 뒤에 한다.
  preserveClipboard: [
    async ({ clipboardKeeper }, use) => {
      await clipboardKeeper.beforeTest();
      await use();
      await clipboardKeeper.afterTest();
    },
    { auto: true, timeout: 90_000 },
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
 * 조작 재시도 — 조작이 간헐적으로 유실된다(커스텀 에디터 webview 의 hit-target 오작동 · 레이아웃 정착 전
 * 좌표, 창 무포커스 시 우클릭 · 메뉴 클릭 유실). 조작 후 기대 상태를 확인하고 미달이면 다시 한다.
 * 조작 안에서 나는 예외(예: 우클릭이 유실돼 메뉴 대기가 시간 초과)도 그 시도의 실패로 보고 다시 한다.
 * 시도를 다 쓰면 마지막 오류를 던진다.
 */
export async function retryAction(
  action: () => Promise<void>,
  verify: () => Promise<void>,
  attempts = 5,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await action();
      await verify();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
