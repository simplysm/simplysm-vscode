// MS 마켓플레이스 배포: build → vsce package → vsce publish
// 토큰은 루트 .env 의 VSCE_PAT 사용 (.gitignore 대상)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootPath = path.resolve(import.meta.dirname, "..");
const artifactPath = path.join(rootPath, ".local-vsix", "publish");
const extensionDirNames = ["focus-refresh", "local-history", "tasks", "terminal"];

const envPath = path.join(rootPath, ".env");
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const token = process.env.VSCE_PAT;
if (!token) {
  console.error("VSCE_PAT 가 없습니다. 루트 .env 에 VSCE_PAT=<토큰> 을 넣어주세요.");
  process.exit(1);
}

function runPnpm(args) {
  const result = spawnSync("pnpm", args, {
    cwd: rootPath,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} 실패`);
}

runPnpm(["build"]);

fs.rmSync(artifactPath, { recursive: true, force: true });
fs.mkdirSync(artifactPath, { recursive: true });

const vsixPaths = [];
for (const dirName of extensionDirNames) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(rootPath, "packages", dirName, "package.json"), "utf8"),
  );
  const vsixPath = path.join(artifactPath, `${manifest.name}-${manifest.version}.vsix`);
  runPnpm([
    "--dir",
    `packages/${dirName}`,
    "exec",
    "vsce",
    "package",
    "--no-dependencies",
    // monorepo — vsce 는 README 상대경로를 repo 루트 기준으로 재작성하므로 패키지 폴더 기준 URL 지정
    "--baseContentUrl",
    `https://github.com/simplysm/simplysm-vscode/raw/HEAD/packages/${dirName}/`,
    "--baseImagesUrl",
    `https://github.com/simplysm/simplysm-vscode/raw/HEAD/packages/${dirName}/`,
    "--out",
    vsixPath,
  ]);
  vsixPaths.push(vsixPath);
}

// 전체 패키징 성공 후에만 publish 시작 (부분 배포 최소화)
for (const vsixPath of vsixPaths) {
  runPnpm(["exec", "vsce", "publish", "--packagePath", vsixPath, "-p", token]);
  console.log(`배포 완료: ${path.basename(vsixPath)}`);
}

console.log("\n마켓플레이스 배포 완료. 반영까지 몇 분 걸릴 수 있습니다.");
