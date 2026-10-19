import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  resolveShellLaunch,
  type ProfileOs,
  type ShellLaunchInput,
  type ShellSettings,
  type VariableSources,
} from "./shell-launch.ts";

const windowsEnv = {
  windir: "C:\\Windows",
  HOMEDRIVE: "C:",
  USERPROFILE: "C:\\Users\\me",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
  ProgramW6432: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  Path: "C:\\Users\\me\\AppData\\Local\\mise\\shims;C:\\Program Files\\Git\\cmd",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
};

/** VS Code 가 `terminal.integrated.profiles.windows` 에 두는 기본값. */
const windowsDefaultProfiles = {
  PowerShell: { source: "PowerShell", icon: "terminal-powershell" },
  "Command Prompt": {
    path: ["${env:windir}\\Sysnative\\cmd.exe", "${env:windir}\\System32\\cmd.exe"],
    args: [],
    icon: "terminal-cmd",
  },
  "Git Bash": { source: "Git Bash", icon: "terminal-git-bash" },
};

const projectFolder = { name: "project", path: "c:\\repo\\project" };
const toolsFolder = { name: "tools", path: "c:\\repo\\tools" };

const windowsPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const miseShimPwsh = "C:\\Users\\me\\AppData\\Local\\mise\\shims\\pwsh.exe";

interface Scenario {
  readonly os?: ProfileOs;
  readonly shellPath: string;
  readonly settings?: Partial<ShellSettings>;
  /** 있는 파일들. */
  readonly files?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly variables?: Partial<VariableSources>;
  readonly unixShells?: string;
}

function launch(scenario: Scenario) {
  const os = scenario.os ?? "windows";
  const isWindows = os === "windows";
  const pathApi = isWindows ? path.win32 : path.posix;
  const files = new Set(
    (scenario.files ?? []).map((file) =>
      isWindows ? pathApi.normalize(file).toLowerCase() : pathApi.normalize(file),
    ),
  );
  const input: ShellLaunchInput = {
    os,
    shellPath: scenario.shellPath,
    settings: {
      defaultProfileName: undefined,
      profiles: isWindows ? windowsDefaultProfiles : {},
      useWslProfiles: true,
      env: undefined,
      ...scenario.settings,
    },
    processEnv: scenario.env ?? (isWindows ? windowsEnv : { PATH: "/usr/bin:/bin" }),
    variables: {
      folder: projectFolder,
      folders: [projectFolder, toolsFolder],
      userHome: isWindows ? "C:\\Users\\me" : "/home/me",
      processCwd: isWindows ? "C:\\vscode" : "/vscode",
      readConfiguration: (section) => (section === "demo.value" ? 42 : undefined),
      extensionPath: () => undefined,
      ...scenario.variables,
    },
    isFile: (file) =>
      files.has(isWindows ? pathApi.normalize(file).toLowerCase() : pathApi.normalize(file)),
    ...(scenario.unixShells == null ? {} : { unixShells: scenario.unixShells }),
  };
  return resolveShellLaunch(input);
}

test("기본 프로필의 인자와 환경 변수를 적용하고, 경로는 VS Code 가 고른 값을 그대로 쓴다", () => {
  // 설정의 `/` 경로를 VS Code 는 `\` 로 바꿔 vscode.env.shell 로 준다.
  const result = launch({
    shellPath: miseShimPwsh,
    settings: {
      defaultProfileName: "pwsh",
      profiles: {
        ...windowsDefaultProfiles,
        pwsh: {
          path: "C:/Users/me/AppData/Local/mise/shims/pwsh.exe",
          args: ["-NoLogo"],
          env: { DEMO_PROFILE: "on" },
        },
      },
    },
    files: [miseShimPwsh],
  });
  assert.equal(result.shellPath, miseShimPwsh);
  assert.deepEqual(result.args, ["-NoLogo"]);
  assert.equal(result.env["DEMO_PROFILE"], "on");
  assert.equal(result.profileName, "pwsh");
});

test("Windows 의 문자열 인자는 명령줄 그대로 넘긴다", () => {
  const result = launch({
    shellPath: miseShimPwsh,
    settings: {
      defaultProfileName: "pwsh",
      profiles: { pwsh: { path: miseShimPwsh, args: "-NoExit -Command echo hi" } },
    },
    files: [miseShimPwsh],
  });
  assert.equal(result.args, "-NoExit -Command echo hi");
});

test("이름만 있는 경로는 PATH 와 PATHEXT 로 찾아 VS Code 가 고른 경로와 맞춰 본다", () => {
  const result = launch({
    // findExecutable 은 PATHEXT 에 적힌 대로 확장자를 붙인다.
    shellPath: "C:\\Users\\me\\AppData\\Local\\mise\\shims\\pwsh.EXE",
    settings: {
      defaultProfileName: "pwsh",
      profiles: { pwsh: { path: "pwsh", args: ["-NoLogo"] } },
    },
    files: [miseShimPwsh],
  });
  assert.deepEqual(result.args, ["-NoLogo"]);
});

test("Git Bash 는 인자를 적지 않으면 VS Code 의 기본 인자를, 적으면 적은 것을 쓴다", () => {
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const files = ["C:\\Program Files\\Git\\cmd\\git.exe", gitBash];
  const detected = launch({
    shellPath: gitBash,
    settings: { defaultProfileName: "Git Bash" },
    files,
  });
  assert.deepEqual(detected.args, ["--login", "-i"]);

  const configured = launch({
    shellPath: gitBash,
    settings: {
      defaultProfileName: "Git Bash",
      profiles: { ...windowsDefaultProfiles, "Git Bash": { source: "Git Bash", args: ["-l"] } },
    },
    files,
  });
  assert.deepEqual(configured.args, ["-l"]);
});

test("기본 프로필을 정하지 않으면 VS Code 가 고른 셸의 프로필에서 인자를 가져온다", () => {
  const result = launch({
    shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    settings: {
      profiles: {
        ...windowsDefaultProfiles,
        PowerShell: { source: "PowerShell", args: ["-NoLogo"] },
      },
    },
  });
  assert.deepEqual(result.args, ["-NoLogo"]);
  assert.equal(result.profileName, "PowerShell");
});

test("기본 프로필의 셸이 없어 VS Code 가 다른 셸로 바꿨으면 그 프로필의 인자를 붙이지 않는다", () => {
  const result = launch({
    shellPath: windowsPowerShell,
    settings: {
      defaultProfileName: "missing",
      profiles: {
        ...windowsDefaultProfiles,
        missing: { path: "C:\\nowhere\\fish.exe", args: ["--private"], env: { LEAK: "1" } },
      },
    },
    files: [windowsPowerShell],
  });
  assert.deepEqual(result.args, []);
  assert.equal(result.env["LEAK"], undefined);
  assert.equal(result.profileName, "PowerShell");
});

test("자동 감지 프로필은 기본 프로필 이름으로 고를 수 없다", () => {
  // VS Code 는 이름이 가리키는 프로필이 자동 감지라 버리고 대체 셸(PowerShell)을 띄운다.
  const result = launch({
    shellPath: windowsPowerShell,
    settings: { defaultProfileName: "Cygwin" },
    files: ["C:\\cygwin64\\bin\\bash.exe", windowsPowerShell],
  });
  assert.deepEqual(result.args, []);
  assert.equal(result.profileName, "PowerShell");
});

test("설정에서 지운 프로필은 건너뛰고 감지 프로필에서 찾는다", () => {
  const result = launch({
    shellPath: windowsPowerShell,
    settings: { profiles: { ...windowsDefaultProfiles, PowerShell: null } },
    files: [windowsPowerShell],
  });
  assert.equal(result.profileName, "Windows PowerShell");
});

test("Sysnative 경로는 System32 로 바꿔 맞춰 본다", () => {
  const result = launch({
    shellPath: "C:\\Windows\\System32\\cmd.exe",
    settings: {
      defaultProfileName: "cmd",
      profiles: { cmd: { path: "C:\\Windows\\Sysnative\\cmd.exe", args: ["/k", "echo hi"] } },
    },
    files: ["C:\\Windows\\Sysnative\\cmd.exe"],
  });
  assert.deepEqual(result.args, ["/k", "echo hi"]);
});

test("WSL 배포판 프로필은 wsl.exe 에 -d <배포판> 을 붙인다", () => {
  const result = launch({
    shellPath: "C:\\Windows\\System32\\wsl.exe",
    settings: { defaultProfileName: "Ubuntu (WSL)" },
  });
  assert.deepEqual(result.args, ["-d", "Ubuntu"]);
});

test("unix 는 문자열 인자를 버린다", () => {
  const result = launch({
    os: "linux",
    shellPath: "/bin/bash",
    settings: { defaultProfileName: "bash", profiles: { bash: { path: "/bin/bash", args: "-l" } } },
    files: ["/bin/bash"],
  });
  assert.deepEqual(result.args, []);
});

test("unix 에서 기본 프로필이 없으면 /etc/shells 자리에 얹힌 설정 프로필에서 가져온다", () => {
  // macOS 의 VS Code 기본 설정은 zsh 에 -l 을 준다.
  const result = launch({
    os: "osx",
    shellPath: "/bin/zsh",
    settings: {
      profiles: { bash: { path: "bash", args: ["-l"] }, zsh: { path: "zsh", args: ["-l"] } },
    },
    files: ["/bin/bash", "/bin/zsh"],
    env: { PATH: "/bin" },
    unixShells: "# comment\n/bin/bash\n/bin/zsh\n",
  });
  assert.deepEqual(result.args, ["-l"]);
  assert.equal(result.profileName, "zsh");
});

test("맞는 프로필이 없으면 macOS 의 zsh · bash 만 --login 으로 띄운다", () => {
  const mac = launch({ os: "osx", shellPath: "/opt/custom/zsh" });
  assert.deepEqual(mac.args, ["--login"]);
  assert.equal(mac.profileName, undefined);
  const linux = launch({ os: "linux", shellPath: "/opt/custom/zsh" });
  assert.deepEqual(linux.args, []);
});

test("환경 변수는 바탕 → terminal.integrated.env → 프로필 env 순으로 덮고 null 은 지운다", () => {
  const result = launch({
    shellPath: miseShimPwsh,
    env: {
      ...windowsEnv,
      FOO: "base",
      REMOVE_ME: "base",
      VSCODE_PID: "1",
      ELECTRON_RUN_AS_NODE: "1",
    },
    settings: {
      defaultProfileName: "pwsh",
      profiles: {
        pwsh: { path: miseShimPwsh, env: { BAR: "profile", REMOVE_ME: null } },
      },
      // Windows 는 이름의 대소문자를 가르지 않고 덮되 원래 이름 표기를 지킨다.
      env: { FOO: "config", BAR: "config", path: "C:\\override" },
    },
    files: [miseShimPwsh],
  });
  assert.equal(result.env["FOO"], "config");
  assert.equal(result.env["BAR"], "profile");
  assert.equal("REMOVE_ME" in result.env, false);
  assert.equal(result.env["Path"], "C:\\override");
  assert.equal("path" in result.env, false);
  assert.equal("VSCODE_PID" in result.env, false);
  assert.equal("ELECTRON_RUN_AS_NODE" in result.env, false);
  assert.equal(result.env["COLORTERM"], "truecolor");
});

test("인자와 환경 변수의 변수는 VS Code 처럼 풀고, 풀 수 없으면 값 전체를 그대로 둔다", () => {
  const result = launch({
    shellPath: miseShimPwsh,
    env: { ...windowsEnv, NESTED: "${env:HOMEDRIVE}\\nested", LOOP: "x${env:LOOP}y" },
    settings: {
      defaultProfileName: "pwsh",
      profiles: {
        pwsh: {
          path: miseShimPwsh,
          args: [
            "${env:userprofile}\\x",
            "${workspaceFolder}",
            "${workspaceFolderBasename}",
            "${workspaceFolder:tools}",
            "a${pathSeparator}b",
            "${unknown} ${command:pick}",
            // 풀 수 없는 변수가 하나라도 있으면 풀 수 있는 변수까지 값 전체를 남긴다.
            "${config:missing.value}\\a ${env:USERPROFILE}",
          ],
          env: {
            CONFIG_VALUE: "${env:HOMEDRIVE}-${config:demo.value}",
            MISSING_CONFIG: "${config:missing.value}",
            NESTED_VALUE: "${env:NESTED}",
            LOOP_VALUE: "${env:LOOP}",
          },
        },
      },
    },
    files: [miseShimPwsh],
  });
  assert.deepEqual(result.args, [
    "C:\\Users\\me\\x",
    "C:\\repo\\project",
    "project",
    "C:\\repo\\tools",
    "a\\b",
    "${unknown} ${command:pick}",
    "${config:missing.value}\\a ${env:USERPROFILE}",
  ]);
  assert.equal(result.env["CONFIG_VALUE"], "C:-42");
  assert.equal(result.env["MISSING_CONFIG"], "${config:missing.value}");
  assert.equal(result.env["NESTED_VALUE"], "C:\\nested");
  assert.equal(result.env["LOOP_VALUE"], "x${env:LOOP}y");
});

test("프로필 경로의 변수는 ${userHome} 까지 풀어 VS Code 가 고른 경로와 맞춰 본다", () => {
  const homePwsh = "C:\\Users\\me\\bin\\pwsh.exe";
  const result = launch({
    shellPath: homePwsh,
    settings: {
      defaultProfileName: "home",
      profiles: { home: { path: "${userHome}\\bin\\pwsh.exe", args: ["-NoLogo"] } },
    },
    files: [homePwsh],
  });
  assert.deepEqual(result.args, ["-NoLogo"]);
});

test("명세 예외 — 인자 · 환경 변수 안의 ${userHome} 을 푼다(내장 터미널은 글자 그대로 둔다)", () => {
  const result = launch({
    shellPath: miseShimPwsh,
    settings: {
      defaultProfileName: "pwsh",
      profiles: {
        pwsh: {
          path: miseShimPwsh,
          args: ["-File", "${userHome}\\scripts\\start.ps1", "${userHome}\\a ${env:USERPROFILE}"],
          env: { TOOLS_HOME: "${userHome}\\tools" },
        },
      },
      env: { CONFIG_HOME: "${userHome}${pathSeparator}config" },
    },
    files: [miseShimPwsh],
  });
  assert.deepEqual(result.args, [
    "-File",
    "C:\\Users\\me\\scripts\\start.ps1",
    "C:\\Users\\me\\a C:\\Users\\me",
  ]);
  assert.equal(result.env["TOOLS_HOME"], "C:\\Users\\me\\tools");
  assert.equal(result.env["CONFIG_HOME"], "C:\\Users\\me\\config");
});

test("명세 예외 — PATH 에서 못 찾은 이름 다음 후보로 찾은 프로필도 env 를 유지한다(내장 터미널은 버린다)", () => {
  const toolShell = "C:\\tools\\sh.exe";
  const result = launch({
    shellPath: toolShell,
    settings: {
      defaultProfileName: "tool",
      profiles: {
        tool: { path: ["not-on-path", toolShell], args: ["-x"], env: { KEPT: "1" } },
      },
    },
    files: [toolShell],
  });
  assert.deepEqual(result.args, ["-x"]);
  assert.equal(result.env["KEPT"], "1");
});
