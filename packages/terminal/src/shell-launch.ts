// 새 세션이 띄울 셸을 정한다 — VS Code 내장 터미널이 기본 프로필로 새 터미널을 열 때와 같은
// 경로 · 인자 · 환경 변수다. vscode API 는 쓰지 않는다: 확장 호스트가 설정 · 환경을 읽어 넘기고,
// 이 모듈은 VS Code 의 해석 규칙만 옮긴다.
//
// 근거(microsoft/vscode 1.127.0):
// - 기본 프로필 고르기 · 경로/인자 다듬기:
//   src/vs/workbench/contrib/terminal/browser/terminalProfileResolverService.ts
//   (_getUnresolvedDefaultProfile · _getUnresolvedFallbackDefaultProfile · _resolveProfile)
// - 기본 프로필 이름으로 찾기: src/vs/workbench/contrib/terminal/browser/terminalProfileService.ts
//   (getDefaultProfile — 자동 감지 프로필은 이름으로 고를 수 없다)
// - 프로필 목록 · 경로 확인 · source 의 기본 인자: src/vs/platform/terminal/node/terminalProfiles.ts
// - PATH 찾기: src/vs/base/node/processes.ts (findExecutable)
// - 환경 변수 합치기: src/vs/workbench/contrib/terminal/common/terminalEnvironment.ts
//   (createTerminalEnvironment · mergeEnvironments)
// - 변수 풀기: src/vs/workbench/services/configurationResolver/common/variableResolver.ts
//   · configurationResolverExpression.ts
//
// 경로는 VS Code 가 고른 값(vscode.env.shell)을 그대로 쓴다. VS Code 는 해석된 기본 프로필의
// 인자 · 환경 변수를 확장에 주지 않으므로, 설정에서 같은 규칙으로 프로필을 다시 고르고 그 프로필이
// 그 경로를 내는지 확인한다 — 경로와 인자가 서로 다른 프로필에서 오면 안 된다.
//
// 예외: VS Code 의 결함 때문에 사용자가 적은 값이 무시되는 경우는 적은 대로 적용한다
// (.specs/terminal-shell.md 「규칙」의 예외 항목). 그 자리마다 "명세 예외" 주석을 달았다.

import path from "node:path";
import type { ShellLaunch } from "./daemon-protocol.ts";

/** 터미널 설정 키의 OS 끝말 — `terminal.integrated.defaultProfile.windows` · `.osx` · `.linux`. */
export type ProfileOs = "windows" | "osx" | "linux";

export function profileOsOf(platform: NodeJS.Platform): ProfileOs {
  return platform === "win32" ? "windows" : platform === "darwin" ? "osx" : "linux";
}

type Env = Readonly<Record<string, string | undefined>>;

export interface WorkspaceFolderRef {
  readonly name: string;
  /** 워크스페이스 폴더의 절대 경로. */
  readonly path: string;
}

/** 편집기에 매인 변수(`${file}` 등)의 출처. 활성 편집기가 없으면 비운다. */
export interface EditorVariables {
  readonly filePath?: string;
  /** 그 파일이 든 워크스페이스 폴더의 경로. */
  readonly fileWorkspaceFolderPath?: string;
  /** 1부터 센 커서 줄. */
  readonly lineNumber?: string;
  /** 1부터 센 커서 칸. */
  readonly columnNumber?: string;
  readonly selectedText?: string;
}

/** `${…}` 변수를 푸는 데 쓰는 값들. */
export interface VariableSources {
  /** 변수를 푸는 기준 폴더 — 세션이 시작하는 폴더. */
  readonly folder?: WorkspaceFolderRef;
  readonly folders: readonly WorkspaceFolderRef[];
  readonly userHome: string;
  /** `${cwd}` 를 폴더 없이 쓸 때의 값. */
  readonly processCwd: string;
  readonly execPath?: string;
  /** `${execInstallFolder}` 의 값. */
  readonly appRoot?: string;
  readonly editor?: EditorVariables;
  /** `${config:…}` 의 값. 폴더가 있으면 그 폴더 범위로 읽는다. */
  readonly readConfiguration: (section: string, folder: WorkspaceFolderRef | undefined) => unknown;
  /** `${extensionInstallFolder:…}` 의 값. 설치되지 않았으면 없음. */
  readonly extensionPath: (extensionId: string) => string | undefined;
}

/** 셸을 정하는 터미널 설정 — 읽은 값을 검사하지 않고 그대로 넘긴다. */
export interface ShellSettings {
  /** `terminal.integrated.defaultProfile.<OS>` */
  readonly defaultProfileName: unknown;
  /** `terminal.integrated.profiles.<OS>` — VS Code 기본값과 합쳐진 값. */
  readonly profiles: unknown;
  /** `terminal.integrated.useWslProfiles` */
  readonly useWslProfiles: unknown;
  /** `terminal.integrated.env.<OS>` */
  readonly env: unknown;
}

export interface ShellLaunchInput {
  readonly os: ProfileOs;
  /** VS Code 가 고른 기본 셸 경로(`vscode.env.shell`). 띄울 경로는 언제나 이것이다. */
  readonly shellPath: string;
  readonly settings: ShellSettings;
  /**
   * 확장 호스트 프로세스의 환경 변수 — 세션 환경의 바탕이고, `${env:…}` · 감지 프로필 자리 ·
   * PATH 찾기의 출처다.
   */
  readonly processEnv: Env;
  readonly variables: VariableSources;
  /** 그 경로에 파일이 있으면 참. 폴더는 거짓이다. */
  readonly isFile: (filePath: string) => boolean;
  /** unix 의 `/etc/shells` 내용. 없으면 없음. */
  readonly unixShells?: string;
}

export interface ResolvedShellLaunch extends ShellLaunch {
  /** 인자 · 환경 변수를 가져온 프로필. VS Code 가 만든 대체 셸이면 없음. */
  readonly profileName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 환경 변수 하나. Windows 는 이름의 대소문자를 가르지 않는다. */
function envValue(env: Env, name: string, ignoreCase: boolean): string | undefined {
  if (!ignoreCase) return env[name];
  const upperName = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upperName) return value;
  }
  return undefined;
}

// ---- 변수 풀기 (variableResolver.ts · configurationResolverExpression.ts) ----

/** 변수를 풀 수 없다. VS Code 는 이때 그 값 전체를 풀지 않은 채로 둔다. */
class VariableError extends Error {}

interface ParsedVariable {
  /** `${name:argument}` 전체. */
  readonly id: string;
  readonly name: string;
  readonly argument?: string;
  /** 닫는 `}` 의 위치. */
  readonly end: number;
}

/** `${` 에서 시작해 짝이 맞는 `}` 까지를 변수 하나로 읽는다. 짝이 없으면 변수가 아니다. */
function parseVariable(text: string, start: number): ParsedVariable | undefined {
  let end = start + 2;
  let depth = 1;
  while (end < text.length) {
    if (text[end] === "{") depth++;
    else if (text[end] === "}") {
      depth--;
      if (depth === 0) break;
    }
    end++;
  }
  if (depth !== 0) return undefined;
  const id = text.slice(start, end + 1);
  const inner = text.slice(start + 2, end);
  const colonIndex = inner.indexOf(":");
  return colonIndex < 0
    ? { id, name: inner, end }
    : { id, name: inner.slice(0, colonIndex), argument: inner.slice(colonIndex + 1), end };
}

/**
 * 문자열 속 변수를 푼다. 같은 변수는 한 번만 풀고, 푼 값 속의 변수도 다시 푼다 — 단, 자기를 다시
 * 부르는 변수는 그대로 둔다. 풀 수 없는 변수가 하나라도 있으면 VariableError 를 던진다.
 */
function substituteVariables(
  text: string,
  evaluate: (variable: ParsedVariable) => string | undefined,
  cache: Map<string, string | undefined> = new Map(),
  chain: readonly string[] = [],
): string {
  let result = "";
  let position = 0;
  for (;;) {
    const start = text.indexOf("${", position);
    if (start < 0) break;
    const variable = parseVariable(text, start);
    if (variable == null) {
      result += text.slice(position, start + 2);
      position = start + 2;
      continue;
    }
    result += text.slice(position, start);
    position = variable.end + 1;
    if (chain.includes(variable.id)) {
      result += variable.id;
      continue;
    }
    if (!cache.has(variable.id)) cache.set(variable.id, evaluate(variable));
    const value = cache.get(variable.id);
    result +=
      value === undefined
        ? variable.id
        : substituteVariables(value, evaluate, cache, [...chain, variable.id]);
  }
  return result + text.slice(position);
}

/** Windows 경로의 드라이브 글자를 대문자로 — VS Code 가 폴더 · 파일 경로 변수에 하는 정리. */
function normalizeDriveLetter(value: string, isWindows: boolean): string {
  return isWindows && /^[a-zA-Z]:/.test(value) ? value[0]!.toUpperCase() + value.slice(1) : value;
}

interface VariableContext {
  readonly isWindows: boolean;
  readonly env: Env;
  readonly sources: VariableSources;
}

function evaluateVariable(variable: ParsedVariable, context: VariableContext): string | undefined {
  const { name, argument } = variable;
  const { isWindows, sources } = context;
  const pathApi = isWindows ? path.win32 : path.posix;

  const folderPath = (): string => {
    if (argument) {
      const named = sources.folders.filter((folder) => folder.name === argument).pop();
      if (named == null) throw new VariableError(`No such folder: ${argument}`);
      return named.path;
    }
    if (sources.folder != null) return sources.folder.path;
    throw new VariableError(`${variable.id} needs a workspace folder.`);
  };
  const filePath = (): string => {
    const value = sources.editor?.filePath;
    if (value) return normalizeDriveLetter(value, isWindows);
    throw new VariableError(`${variable.id} needs an open editor.`);
  };
  const fileFolderPath = (): string => {
    filePath();
    const value = sources.editor?.fileWorkspaceFolderPath;
    if (value) return normalizeDriveLetter(value, isWindows);
    throw new VariableError(`${variable.id} cannot find the workspace folder of the file.`);
  };
  const editorValue = (value: string | undefined): string => {
    if (value) return value;
    throw new VariableError(`${variable.id} needs an editor selection.`);
  };

  switch (name) {
    case "env":
      if (!argument) throw new VariableError("No environment variable name is given.");
      return envValue(context.env, argument, isWindows) ?? "";
    case "config": {
      if (!argument) throw new VariableError("No setting name is given.");
      const value = sources.readConfiguration(argument, sources.folder);
      if (value == null || isRecord(value)) {
        throw new VariableError(`The setting cannot be used: ${argument}`);
      }
      return String(value);
    }
    case "command":
    case "input":
      // 대화형 변수 — 터미널 경로에서는 값을 줄 수 없어 그대로 남는다.
      return undefined;
    case "extensionInstallFolder": {
      if (!argument) throw new VariableError("No extension name is given.");
      const extensionPath = sources.extensionPath(argument);
      if (extensionPath == null) throw new VariableError(`Not installed: ${argument}`);
      return extensionPath;
    }
    case "workspaceRoot":
    case "workspaceFolder":
      return normalizeDriveLetter(folderPath(), isWindows);
    case "cwd":
      if (sources.folder == null && !argument) return sources.processCwd;
      return normalizeDriveLetter(folderPath(), isWindows);
    case "workspaceRootFolderName":
    case "workspaceFolderBasename":
      return pathApi.basename(folderPath());
    case "userHome":
      // 명세 예외(.specs/terminal-shell.md): 인자 · 환경 변수에서도 푼다. VS Code 1.127 은 프로필
      // 경로에서만 풀고(resolveAsync) 인자 · 환경 변수에서는 풀지 못해(resolveWithEnvironment 가
      // userHome 을 넘기지 않는다) 값 전체를 글자 그대로 둔다 — 적은 값이 조용히 무시되는 결함이다.
      if (sources.userHome) return sources.userHome;
      throw new VariableError("The user home is not available.");
    case "lineNumber":
      return editorValue(sources.editor?.lineNumber);
    case "columnNumber":
      return editorValue(sources.editor?.columnNumber);
    case "selectedText":
      return editorValue(sources.editor?.selectedText);
    case "file":
      return filePath();
    case "fileWorkspaceFolder":
      return fileFolderPath();
    case "fileWorkspaceFolderBasename":
      return pathApi.basename(fileFolderPath());
    case "relativeFile":
      return sources.folder != null || argument
        ? pathApi.relative(folderPath(), filePath())
        : filePath();
    case "relativeFileDirname": {
      const dirname = pathApi.dirname(filePath());
      if (sources.folder == null && !argument) return dirname;
      const relative = pathApi.relative(folderPath(), dirname);
      return relative.length === 0 ? "." : relative;
    }
    case "fileDirname":
      return pathApi.dirname(filePath());
    case "fileExtname":
      return pathApi.extname(filePath());
    case "fileBasename":
      return pathApi.basename(filePath());
    case "fileBasenameNoExtension": {
      const basename = pathApi.basename(filePath());
      return basename.slice(0, basename.length - pathApi.extname(basename).length);
    }
    case "fileDirnameBasename":
      return pathApi.basename(pathApi.dirname(filePath()));
    case "execPath":
      return sources.execPath || undefined;
    case "execInstallFolder":
      return sources.appRoot || undefined;
    case "pathSeparator":
    case "/":
      return pathApi.sep;
    default:
      // 모르는 변수는 그대로 남는다.
      return undefined;
  }
}

/** 값을 풀되, 풀 수 없는 변수가 있으면 VS Code 처럼 값 전체를 그대로 돌려준다. */
function resolveOrKeep(text: string, context: VariableContext): string {
  try {
    return substituteVariables(text, (variable) => evaluateVariable(variable, context));
  } catch (error) {
    if (error instanceof VariableError) return text;
    throw error;
  }
}

// ---- 프로필 목록 (terminalProfiles.ts) ----

interface ProfileEntry {
  readonly name: string;
  readonly profile: Record<string, unknown>;
  /** VS Code 가 스스로 찾은 프로필. 기본 프로필 이름으로는 고를 수 없다. */
  readonly autoDetected: boolean;
}

interface HostContext {
  readonly os: ProfileOs;
  readonly isWindows: boolean;
  readonly pathApi: path.PlatformPath;
  readonly env: Env;
  readonly processCwd: string;
  readonly isFile: (filePath: string) => boolean;
  /** 프로필 경로의 변수 풀기. */
  readonly resolvePathVariables: (text: string) => string;
}

/** VS Code 가 설정과 따로 찾아 두는 프로필(detectAvailableWindowsProfiles · detectAvailableUnixProfiles). */
function detectedProfiles(host: HostContext, unixShells: string | undefined): ProfileEntry[] {
  const detected = (name: string, profile: Record<string, unknown>): ProfileEntry => ({
    name,
    profile,
    autoDetected: true,
  });
  if (host.isWindows) {
    const env = (name: string): string | undefined => envValue(host.env, name, true);
    // 32비트 VS Code 가 64비트 Windows 에서 돌면 Sysnative 를 가리킨다.
    const system32 = `${env("windir")}\\${env("PROCESSOR_ARCHITEW6432") == null ? "System32" : "Sysnative"}`;
    const homeDrive = env("HOMEDRIVE");
    const cmderPath = `${env("CMDER_ROOT") || `${homeDrive}\\cmder`}\\vendor\\bin\\vscode_init.cmd`;
    return [
      detected("PowerShell", { source: "PowerShell" }),
      detected("Windows PowerShell", {
        path: `${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`,
      }),
      detected("Git Bash", { source: "Git Bash" }),
      detected("Command Prompt", { path: `${system32}\\cmd.exe` }),
      detected("Cygwin", {
        path: [`${homeDrive}\\cygwin64\\bin\\bash.exe`, `${homeDrive}\\cygwin\\bin\\bash.exe`],
        args: ["--login"],
      }),
      detected("bash (MSYS2)", {
        path: [`${homeDrive}\\msys64\\usr\\bin\\bash.exe`],
        args: ["--login", "-i"],
        env: { CHERE_INVOKING: "1" },
      }),
      detected("Cmder", {
        path: `${system32}\\cmd.exe`,
        args: ["/K", cmderPath],
        requiresPath: cmderPath,
      }),
    ];
  }
  // /etc/shells 의 줄마다 하나 — 이름은 파일 이름이고, 같은 이름이 또 나오면 " (2)" 처럼 번호를 붙인다.
  const entries: ProfileEntry[] = [];
  const counts = new Map<string, number>();
  for (const line of (unixShells ?? "").split("\n")) {
    const hashIndex = line.indexOf("#");
    const shellPath = hashIndex < 0 ? line : line.slice(0, hashIndex);
    if (shellPath.trim().length === 0) continue;
    let name = path.posix.basename(shellPath);
    const count = (counts.get(name) ?? 0) + 1;
    if (count > 1) name = `${name} (${count})`;
    counts.set(name, count);
    entries.push(detected(name, { path: shellPath }));
  }
  return entries;
}

/**
 * 찾아 둔 프로필 위에 설정을 얹는다(applyConfigProfilesToMap). 값이 null 이거나 path · source 가 없는
 * 항목은 같은 이름의 프로필을 지운다. 이미 있는 이름은 자리를 지킨 채 바뀐다.
 */
function applyConfiguredProfiles(entries: ProfileEntry[], configured: unknown): ProfileEntry[] {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  if (isRecord(configured)) {
    for (const [name, profile] of Object.entries(configured)) {
      if (!isRecord(profile) || (!("path" in profile) && !("source" in profile))) {
        byName.delete(name);
      } else {
        byName.set(name, { name, profile, autoDetected: profile.isAutoDetected === true });
      }
    }
  }
  return [...byName.values()];
}

/** 이름만 있는 실행 파일 찾기(findExecutable). Windows 는 PATH 항목마다 PATHEXT 의 확장자를 먼저 붙여 본다. */
function findExecutable(command: string, host: HostContext): string | undefined {
  const { pathApi, isFile } = host;
  if (pathApi.isAbsolute(command)) return isFile(command) ? command : undefined;
  if (pathApi.dirname(command) !== ".") {
    const fullPath = pathApi.join(host.processCwd, command);
    return isFile(fullPath) ? fullPath : undefined;
  }
  const envPath = envValue(host.env, "PATH", host.isWindows);
  const pathEntries = envPath ? envPath.split(pathApi.delimiter) : [];
  for (const pathEntry of pathEntries) {
    const fullPath = pathApi.isAbsolute(pathEntry)
      ? pathApi.join(pathEntry, command)
      : pathApi.join(host.processCwd, pathEntry, command);
    if (host.isWindows) {
      const pathExts = (envValue(host.env, "PATHEXT", true) || ".COM;.EXE;.BAT;.CMD").split(";");
      for (const ext of pathExts) {
        if (isFile(fullPath + ext)) return fullPath + ext;
      }
    }
    if (isFile(fullPath)) return fullPath;
  }
  const fullPath = pathApi.join(host.processCwd, command);
  return isFile(fullPath) ? fullPath : undefined;
}

/** `source: "Git Bash"` 가 찾는 자리(getGitBashPaths). */
function gitBashPaths(host: HostContext): string[] {
  const env = (name: string): string | undefined => envValue(host.env, name, true);
  const gitDirs = new Set<string>();
  const gitExePath = findExecutable("git.exe", host);
  if (gitExePath != null) gitDirs.add(path.win32.resolve(path.win32.dirname(gitExePath), "../.."));
  for (const gitDir of [
    env("ProgramW6432"),
    env("ProgramFiles"),
    env("ProgramFiles(X86)"),
    `${env("LocalAppData")}\\Program`,
  ]) {
    if (gitDir) gitDirs.add(gitDir);
  }
  return [
    ...[...gitDirs].flatMap((gitDir) => [
      `${gitDir}\\Git\\bin\\bash.exe`,
      `${gitDir}\\Git\\usr\\bin\\bash.exe`,
      `${gitDir}\\usr\\bin\\bash.exe`,
    ]),
    `${env("UserProfile")}\\scoop\\apps\\git\\current\\bin\\bash.exe`,
    `${env("UserProfile")}\\scoop\\apps\\git-with-openssh\\current\\bin\\bash.exe`,
  ];
}

/**
 * 셸 경로의 마지막 다듬기(_resolveProfile) — Windows 에서 WoW64 가 아니면 Sysnative 를 System32 로,
 * `/` 를 `\` 로 바꾼다.
 */
function finishShellPath(shellPath: string, host: HostContext): string {
  if (!host.isWindows) return shellPath;
  let result = shellPath;
  const windir = envValue(host.env, "windir", true);
  if (envValue(host.env, "PROCESSOR_ARCHITEW6432", true) == null && windir) {
    const sysnativePath = path.win32.join(windir, "Sysnative").replace(/\//g, "\\").toLowerCase();
    if (result.toLowerCase().startsWith(sysnativePath)) {
      result = path.win32.join(windir, "System32", result.slice(sysnativePath.length + 1));
    }
  }
  return result.replace(/\//g, "\\");
}

function isSamePath(left: string, right: string, host: HostContext): boolean {
  const normalizedLeft = host.pathApi.normalize(left);
  const normalizedRight = host.pathApi.normalize(right);
  return host.isWindows
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** 프로필 하나를 확인한 결과 — 인자 · 환경 변수는 아직 풀지 않은 설정 값 그대로다. */
interface ResolvedProfile {
  readonly name?: string;
  /** 그 셸 경로가 이 프로필에서 나오는가. */
  readonly yields: (shellPath: string) => boolean;
  readonly args: unknown;
  readonly env: unknown;
}

/** 셸 이름(확장자 뺀 파일 이름). Windows 는 대소문자를 가르지 않게 소문자로. */
function shellName(shellPath: string, host: HostContext): string {
  const name = host.pathApi.parse(shellPath).name;
  return host.isWindows ? name.toLowerCase() : name;
}

/** 프로필의 실행 파일을 찾는다(getValidatedProfile · validateProfilePaths). 쓸 수 없는 프로필이면 없음. */
function resolveProfile(entry: ProfileEntry, host: HostContext): ResolvedProfile | undefined {
  const { profile } = entry;
  let candidates: string[] | undefined;
  let args: unknown;
  // source 가 있으면 path 보다 먼저다.
  if ("source" in profile) {
    // source 는 Windows 에서만 쓸 수 있다.
    if (!host.isWindows) return undefined;
    if (profile.source === "Git Bash") {
      candidates = gitBashPaths(host);
      // 설정한 인자가 있으면 source 의 기본 인자를 대신한다.
      args = profile.args || ["--login", "-i"];
    } else if (profile.source === "PowerShell") {
      // 설치된 PowerShell 을 정해진 순서로 찾는다(enumeratePowerShellInstallations) — 끝에는 늘
      // Windows PowerShell 이 있어 언제나 쓸 수 있다. 그 순서는 옮기지 않고 셸 이름만 맞춰 본다.
      args = profile.args || undefined;
    } else {
      return undefined;
    }
  } else {
    const rawPaths: unknown[] = Array.isArray(profile.path) ? profile.path : [profile.path];
    candidates = rawPaths.flatMap((rawPath) => {
      const candidate = isRecord(rawPath) ? rawPath.path : rawPath;
      return typeof candidate === "string" ? [host.resolvePathVariables(candidate)] : [];
    });
    // unix 는 배열만 인자로 받는다.
    args = host.isWindows ? profile.args : Array.isArray(profile.args) ? profile.args : undefined;
  }

  const requiresPath = isRecord(profile.requiresPath)
    ? profile.requiresPath.path
    : profile.requiresPath;
  if (profile.requiresPath && (typeof requiresPath !== "string" || !host.isFile(requiresPath))) {
    return undefined;
  }

  if (candidates == null) {
    return {
      name: entry.name,
      yields: (shellPath) => ["pwsh", "powershell"].includes(shellName(shellPath, host)),
      args,
      env: profile.env,
    };
  }

  // 명세 예외(.specs/terminal-shell.md): 이름만 있는 후보를 PATH 에서 못 찾고 다음 후보로 넘어가도
  // 프로필의 env 를 유지한다. VS Code 1.127 은 이때 env 를 버린다(validateProfilePaths 가 다음 호출에
  // env 를 넘기지 않는다) — 적은 값이 조용히 무시되는 결함이다.
  for (const candidate of candidates) {
    if (candidate === "") continue;
    const found =
      host.pathApi.basename(candidate) === candidate
        ? findExecutable(candidate, host)
        : host.isFile(host.pathApi.normalize(candidate))
          ? candidate
          : undefined;
    if (found == null) continue;
    const shellPath = finishShellPath(found, host);
    return {
      name: entry.name,
      yields: (expected) => isSamePath(shellPath, expected, host),
      args,
      env: profile.env,
    };
  }
  return undefined;
}

/**
 * WSL 배포판 프로필(getWslProfiles) — VS Code 가 wsl.exe 를 실행해 찾으므로 설정에는 없다.
 * 같은 이름의 설정 항목이 있으면 그것이 이긴다.
 */
function wslProfile(
  name: string,
  settings: ShellSettings,
  host: HostContext,
): ResolvedProfile | undefined {
  if (!host.isWindows || settings.useWslProfiles === false) return undefined;
  if (isRecord(settings.profiles) && Object.hasOwn(settings.profiles, name)) return undefined;
  const distroName = /^(.+) \(WSL\)$/.exec(name)?.[1];
  if (distroName == null || distroName.startsWith("docker-desktop")) return undefined;
  const system32 = `${envValue(host.env, "windir", true)}\\${envValue(host.env, "PROCESSOR_ARCHITEW6432", true) == null ? "System32" : "Sysnative"}`;
  const shellPath = finishShellPath(`${system32}\\wsl.exe`, host);
  return {
    name,
    yields: (expected) => isSamePath(shellPath, expected, host),
    args: ["-d", distroName],
    env: undefined,
  };
}

/**
 * VS Code 가 고른 셸 경로를 낸 프로필을 찾는다.
 * 1. 기본 프로필 이름이 가리키는 (자동 감지가 아닌) 프로필이 그 경로를 내면 그것이다.
 * 2. 아니면 VS Code 는 시스템 셸과 이름이 같은 첫 프로필로 대신했다 — 그 경로를 내는 첫 프로필이다.
 * 3. 그런 프로필도 없으면 VS Code 가 만든 프로필이다 — macOS 의 zsh · bash 만 `--login` 을 받는다.
 */
function selectProfile(
  shellPath: string,
  settings: ShellSettings,
  host: HostContext,
  unixShells: string | undefined,
): ResolvedProfile {
  const entries = applyConfiguredProfiles(detectedProfiles(host, unixShells), settings.profiles);
  const defaultName = settings.defaultProfileName;
  if (typeof defaultName === "string" && defaultName.length > 0) {
    const entry = entries.find(
      (candidate) => candidate.name === defaultName && !candidate.autoDetected,
    );
    const named =
      entry == null ? wslProfile(defaultName, settings, host) : resolveProfile(entry, host);
    if (named?.yields(shellPath)) return named;
  }
  for (const entry of entries) {
    const resolved = resolveProfile(entry, host);
    if (resolved?.yields(shellPath)) return resolved;
  }
  const loginShell = host.os === "osx" && /(zsh|bash)/.test(host.pathApi.parse(shellPath).name);
  return { yields: () => true, args: loginShell ? ["--login"] : [], env: undefined };
}

// ---- 인자 · 환경 변수 (terminalProfileResolverService.ts · terminalEnvironment.ts) ----

function finishArgs(args: unknown, context: VariableContext): string | string[] {
  if (typeof args === "string") return context.isWindows ? resolveOrKeep(args, context) : [];
  if (!Array.isArray(args)) return [];
  return args.map((arg) => (typeof arg === "string" ? resolveOrKeep(arg, context) : String(arg)));
}

/** 설정의 환경 변수 묶음 — 문자열 값만 푼다. null 은 "지운다" 는 뜻이라 그대로 둔다. */
function resolveEnvValues(
  env: unknown,
  context: VariableContext,
): Record<string, unknown> | undefined {
  if (!isRecord(env)) return undefined;
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      typeof value === "string" ? resolveOrKeep(value, context) : value,
    ]),
  );
}

/**
 * 환경 변수를 덮는다(mergeEnvironments). 문자열은 넣고 그 밖의 값(null 등)은 지운다. Windows 는
 * 이름의 대소문자를 가리지 않고 덮되, 원래 있던 이름의 표기를 지킨다.
 */
function mergeEnvironment(
  target: Record<string, string>,
  other: Record<string, unknown> | undefined,
  isWindows: boolean,
): void {
  if (other == null) return;
  for (const [key, value] of Object.entries(other)) {
    if (value === undefined) continue;
    const actualKey = isWindows
      ? (Object.keys(target).find((existing) => existing.toLowerCase() === key.toLowerCase()) ??
        key)
      : key;
    if (typeof value === "string") target[actualKey] = value;
    else delete target[actualKey];
  }
}

/** 셸이 물려받으면 VS Code CLI 와 webview 가 깨지는 변수들. 세션 환경의 바탕에서 걷어 낸다. */
function baseEnvironment(processEnv: Env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value == null || key === "ELECTRON_RUN_AS_NODE" || /^VSCODE_/i.test(key)) continue;
    environment[key] = value;
  }
  return environment;
}

/** 새 세션이 띄울 셸 — 경로는 VS Code 가 고른 값, 인자 · 환경 변수는 그 경로를 낸 프로필의 것. */
export function resolveShellLaunch(input: ShellLaunchInput): ResolvedShellLaunch {
  const isWindows = input.os === "windows";
  const variableContext: VariableContext = {
    isWindows,
    env: input.processEnv,
    sources: input.variables,
  };
  const host: HostContext = {
    os: input.os,
    isWindows,
    pathApi: isWindows ? path.win32 : path.posix,
    env: input.processEnv,
    processCwd: input.variables.processCwd,
    isFile: input.isFile,
    resolvePathVariables: (text) => resolveOrKeep(text, variableContext),
  };
  const profile = selectProfile(input.shellPath, input.settings, host, input.unixShells);

  // 바탕 → terminal.integrated.env.<OS> → 프로필 env 순으로 덮고, 터미널이 더하는 키를 마지막에 넣는다.
  const env = baseEnvironment(input.processEnv);
  mergeEnvironment(env, resolveEnvValues(input.settings.env, variableContext), isWindows);
  mergeEnvironment(env, resolveEnvValues(profile.env, variableContext), isWindows);
  // 에뮬레이터(xterm.js)가 24bit 색을 실제로 지원한다 — 셸 프로그램의 truecolor 감지용.
  // 내장 터미널과 같은 선언 (name=xterm-256color 만으로는 256색으로 강등된다).
  env["COLORTERM"] = "truecolor";

  return {
    shellPath: input.shellPath,
    args: finishArgs(profile.args, variableContext),
    env,
    ...(profile.name == null ? {} : { profileName: profile.name }),
  };
}
