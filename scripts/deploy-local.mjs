import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootPath = path.resolve(import.meta.dirname, "..");
const artifactRootPath = path.join(rootPath, ".local-vsix");
const currentArtifactPath = path.join(artifactRootPath, "current");
const nextArtifactPath = path.join(artifactRootPath, "next");
const rollbackArtifactPath = path.join(artifactRootPath, "rollback");
const extensionConfigs = [
  { dirName: "focus-refresh", extensionId: "simplysm.simplysm-focus-refresh" },
  { dirName: "local-history", extensionId: "simplysm.simplysm-local-history" },
  { dirName: "tasks", extensionId: "simplysm.simplysm-tasks" },
  { dirName: "terminal", extensionId: "simplysm.simplysm-terminal" },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootPath,
    encoding: "utf8",
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env ?? process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} 실패${detail ? `\n${detail}` : ""}`);
  }

  return result.stdout ?? "";
}

function runPnpm(args) {
  const pnpmScriptPath = process.env.npm_execpath;
  if (pnpmScriptPath) {
    const isJavaScriptFile = /\.[cm]?js$/i.test(pnpmScriptPath);
    run(isJavaScriptFile ? process.execPath : pnpmScriptPath, [
      ...(isJavaScriptFile ? [pnpmScriptPath] : []),
      ...args,
    ]);
  } else {
    run("pnpm", args, { shell: process.platform === "win32" });
  }
}

let windowsCodeCli;

function resolveWindowsCodeCli() {
  if (windowsCodeCli != null) return windowsCodeCli;
  const codeCmdPaths = run("where.exe", ["code.cmd"], { capture: true })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const codeCmdPath = codeCmdPaths[0];
  if (codeCmdPath == null) throw new Error("PATH에서 VS Code CLI(code.cmd)를 찾지 못했습니다.");

  const launcherText = fs.readFileSync(codeCmdPath, "utf8");
  const cliMatch = /%~dp0\.\.\\([^"\r\n]*resources\\app\\out\\cli\.js)/i.exec(launcherText);
  if (cliMatch?.[1] == null)
    throw new Error(`VS Code CLI 실행 경로를 해석하지 못했습니다: ${codeCmdPath}`);

  const installPath = path.resolve(path.dirname(codeCmdPath), "..");
  windowsCodeCli = {
    executablePath: path.join(installPath, "Code.exe"),
    cliPath: path.join(installPath, cliMatch[1]),
  };
  return windowsCodeCli;
}

function runCode(args, capture = false) {
  if (process.platform !== "win32") return run("code", args, { capture });
  const { executablePath, cliPath } = resolveWindowsCodeCli();
  return run(executablePath, [cliPath, ...args], {
    capture,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "" },
  });
}

function incrementPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`patch 증가를 지원하지 않는 버전: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function getInstalledVersions() {
  const output = runCode(["--list-extensions", "--show-versions"], true);
  const installedVersions = new Map();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const separatorIndex = line.lastIndexOf("@");
    if (separatorIndex < 1) continue;
    installedVersions.set(
      line.slice(0, separatorIndex).toLowerCase(),
      line.slice(separatorIndex + 1),
    );
  }

  return installedVersions;
}

function readDeploymentMetadata(dirPath) {
  const metadataPath = path.join(dirPath, "deployment.json");
  if (!fs.existsSync(metadataPath)) return undefined;
  return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
}

function restoreInstalledExtensions(installedBefore, previousMetadata, previousArtifactPath) {
  const installedAfter = getInstalledVersions();
  const restorePaths = [];
  const uninstallIds = [];

  for (const config of extensionConfigs) {
    const extensionId = config.extensionId.toLowerCase();
    if (installedBefore.has(extensionId)) {
      const previousExtension = previousMetadata.extensions.find(
        (item) => item.extensionId.toLowerCase() === extensionId,
      );
      restorePaths.push(path.join(previousArtifactPath, previousExtension.fileName));
    } else if (installedAfter.has(extensionId)) {
      uninstallIds.push(config.extensionId);
    }
  }

  if (restorePaths.length > 0) {
    runCode(
      restorePaths.flatMap((vsixPath) => ["--install-extension", vsixPath]).concat("--force"),
    );
  }
  if (uninstallIds.length > 0) {
    runCode(uninstallIds.flatMap((extensionId) => ["--uninstall-extension", extensionId]));
  }
}

const manifests = extensionConfigs.map((config) => {
  const packagePath = path.join(rootPath, "packages", config.dirName, "package.json");
  const originalText = fs.readFileSync(packagePath, "utf8");
  const manifest = JSON.parse(originalText);
  const nextVersion = incrementPatch(manifest.version);
  return { ...config, packagePath, originalText, manifest, nextVersion };
});

let versionsChanged = false;
let actualInstallStarted = false;
let installedBefore;
let previousMetadata;
let previousArtifactPath = currentArtifactPath;

try {
  for (const item of manifests) {
    item.manifest.version = item.nextVersion;
    fs.writeFileSync(item.packagePath, `${JSON.stringify(item.manifest, undefined, 2)}\n`);
  }
  versionsChanged = true;

  runPnpm(["build"]);
  // runPnpm(["typecheck"]);
  // runPnpm(["lint"]);
  // runPnpm(["test"]);

  fs.rmSync(nextArtifactPath, { recursive: true, force: true });
  fs.mkdirSync(nextArtifactPath, { recursive: true });

  const deploymentMetadata = { extensions: [] };
  for (const item of manifests) {
    const fileName = `${item.manifest.name}-${item.nextVersion}.vsix`;
    const vsixPath = path.join(nextArtifactPath, fileName);
    runPnpm([
      "--dir",
      `packages/${item.dirName}`,
      "exec",
      "vsce",
      "package",
      "--no-dependencies",
      "--skip-license",
      "--allow-missing-repository",
      "--out",
      vsixPath,
    ]);
    deploymentMetadata.extensions.push({
      extensionId: item.extensionId,
      version: item.nextVersion,
      fileName,
    });
  }
  fs.writeFileSync(
    path.join(nextArtifactPath, "deployment.json"),
    `${JSON.stringify(deploymentMetadata, undefined, 2)}\n`,
  );

  const preflightPath = path.join(artifactRootPath, "preflight");
  fs.rmSync(preflightPath, { recursive: true, force: true });
  const nextVsixPaths = deploymentMetadata.extensions.map((item) =>
    path.join(nextArtifactPath, item.fileName),
  );
  try {
    runCode([
      "--user-data-dir",
      path.join(preflightPath, "user-data"),
      "--extensions-dir",
      path.join(preflightPath, "extensions"),
      ...nextVsixPaths.flatMap((vsixPath) => ["--install-extension", vsixPath]),
      "--force",
    ]);
  } finally {
    fs.rmSync(preflightPath, { recursive: true, force: true });
  }

  installedBefore = getInstalledVersions();
  previousMetadata = readDeploymentMetadata(currentArtifactPath);
  for (const config of extensionConfigs) {
    const installedVersion = installedBefore.get(config.extensionId.toLowerCase());
    if (!installedVersion) continue;

    const previousExtension = previousMetadata?.extensions.find(
      (item) => item.extensionId.toLowerCase() === config.extensionId.toLowerCase(),
    );
    if (!previousExtension || previousExtension.version !== installedVersion) {
      throw new Error(
        `${config.extensionId}@${installedVersion}의 롤백 VSIX가 없습니다. 설치 상태를 바꾸지 않았습니다.`,
      );
    }
  }

  actualInstallStarted = true;
  runCode(nextVsixPaths.flatMap((vsixPath) => ["--install-extension", vsixPath]).concat("--force"));

  fs.rmSync(rollbackArtifactPath, { recursive: true, force: true });
  if (fs.existsSync(currentArtifactPath)) {
    fs.renameSync(currentArtifactPath, rollbackArtifactPath);
    previousArtifactPath = rollbackArtifactPath;
  }
  fs.renameSync(nextArtifactPath, currentArtifactPath);
  fs.rmSync(rollbackArtifactPath, { recursive: true, force: true });

  console.log("\n로컬 배포 완료. VS Code에서 'Developer: Reload Window'를 실행하세요.");
} catch (error) {
  let rollbackError;
  if (actualInstallStarted) {
    try {
      restoreInstalledExtensions(installedBefore, previousMetadata, previousArtifactPath);
    } catch (caught) {
      rollbackError = caught;
    }
  }

  if (fs.existsSync(rollbackArtifactPath)) {
    fs.rmSync(currentArtifactPath, { recursive: true, force: true });
    fs.renameSync(rollbackArtifactPath, currentArtifactPath);
  }
  if (versionsChanged) {
    for (const item of manifests) fs.writeFileSync(item.packagePath, item.originalText);
  }
  fs.rmSync(nextArtifactPath, { recursive: true, force: true });

  if (rollbackError) {
    throw new AggregateError([error, rollbackError], "로컬 배포와 설치 롤백이 모두 실패했습니다.");
  }
  throw error;
}
