// MS 마켓플레이스 자동 배포: 변경 감지 → 버전업 → CHANGELOG → package → publish → commit/tag/push
// - 패키지별 `<name>@<version>` git tag 를 배포 기준점으로 사용.
// - tag 가 없는 패키지는 현재 버전으로 baseline tag 만 생성하고 배포는 건너뜀.
// - 사용법: pnpm publish:marketplace [--minor|--major] [--force <디렉터리명>]...
// - 토큰은 루트 .env 의 VSCE_PAT 사용 (.gitignore 대상)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootPath = path.resolve(import.meta.dirname, "..");
const artifactPath = path.join(rootPath, ".local-vsix", "publish");
const extensionDirNames = ["focus-refresh", "local-history", "tasks", "terminal"];

//-- 인자 파싱
const args = process.argv.slice(2);
const bumpType = args.includes("--major") ? "major" : args.includes("--minor") ? "minor" : "patch";
const forcedDirNames = new Set();
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--force") {
    const dirName = args[i + 1];
    if (!dirName || !extensionDirNames.includes(dirName)) {
      console.error(`--force 뒤에 패키지 디렉터리명이 필요합니다: ${extensionDirNames.join(", ")}`);
      process.exit(1);
    }
    forcedDirNames.add(dirName);
    i++;
  }
}

//-- 토큰 확인
const envPath = path.join(rootPath, ".env");
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const token = process.env.VSCE_PAT;
if (!token) {
  console.error("VSCE_PAT 가 없습니다. 루트 .env 에 VSCE_PAT=<토큰> 을 넣어주세요.");
  process.exit(1);
}

function run(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: rootPath,
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} 실패`);
  return result.stdout?.trim() ?? "";
}

function git(...gitArgs) {
  return run("git", gitArgs, { capture: true });
}

// 마켓플레이스에 실제 배포된 버전 조회 (미등록이면 null)
function getMarketplaceVersion(manifest) {
  const result = spawnSync(
    "pnpm", ["exec", "vsce", "show", `${manifest.publisher}.${manifest.name}`, "--json"],
    { cwd: rootPath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", shell: process.platform === "win32" },
  );
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout).versions[0].version;
}

function tagExists(tag) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], {
    cwd: rootPath,
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

function bumpVersion(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (bumpType === "major") return `${major + 1}.0.0`;
  if (bumpType === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

//-- 워킹트리 가드 (스크립트가 커밋을 만들므로 깨끗해야 함)
if (git("status", "--porcelain") !== "") {
  console.error("워킹트리에 미커밋 변경이 있습니다. 커밋하거나 정리한 뒤 다시 실행하세요.");
  process.exit(1);
}

//-- 변경 감지
const targets = []; // { dirName, manifestPath, manifest, newVersion, subjects }
const baselineTags = [];
for (const dirName of extensionDirNames) {
  const manifestPath = path.join(rootPath, "packages", dirName, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const currentTag = `${manifest.name}@${manifest.version}`;

  if (!tagExists(currentTag)) {
    // 첫 실행: 마켓플레이스 실제 버전과 대조해 기준점의 정합성을 확인
    const marketVersion = getMarketplaceVersion(manifest);
    if (marketVersion !== manifest.version) {
      console.error(
        `[${dirName}] tag 없음 + 마켓플레이스 버전(${marketVersion ?? "미등록"}) ≠ 로컬(${manifest.version}).\n` +
        `  마지막 배포 시점 커밋에 ${currentTag} tag 를 만든 뒤 다시 실행하세요.`,
      );
      process.exit(1);
    }
    // 마켓 버전과 일치 → 현재 상태를 배포 기준점으로 삼고 배포는 건너뜀
    git("tag", currentTag);
    baselineTags.push(currentTag);
    console.log(`[${dirName}] baseline tag 생성: ${currentTag} (배포 건너뜀)`);
    continue;
  }

  const log = git(
    "log", "--no-merges", "--format=%s",
    `${currentTag}..HEAD`, "--", `packages/${dirName}`,
  );
  const subjects = log === "" ? [] : log.split("\n");
  if (subjects.length === 0 && !forcedDirNames.has(dirName)) {
    console.log(`[${dirName}] 변경 없음 — 건너뜀`);
    continue;
  }
  targets.push({ dirName, manifestPath, manifest, newVersion: bumpVersion(manifest.version), subjects });
}

if (targets.length === 0) {
  if (baselineTags.length > 0) git("push", "origin", ...baselineTags);
  console.log("배포할 패키지가 없습니다.");
  process.exit(0);
}

//-- 버전업 + CHANGELOG
const today = new Date().toISOString().slice(0, 10);
for (const target of targets) {
  target.manifest.version = target.newVersion;
  fs.writeFileSync(target.manifestPath, JSON.stringify(target.manifest, null, 2) + "\n");

  const changelogPath = path.join(rootPath, "packages", target.dirName, "CHANGELOG.md");
  const existing = fs.existsSync(changelogPath)
    ? fs.readFileSync(changelogPath, "utf8")
    : "# Changelog\n";
  const bullets = target.subjects.map((subject) => `- ${subject}`).join("\n");
  const section = `## ${target.newVersion} - ${today}\n\n${bullets ? bullets + "\n" : ""}`;
  // "# Changelog" 헤더 바로 아래에 새 섹션 삽입
  const updated = existing.replace(/^(# Changelog\n)/, `$1\n${section}`);
  fs.writeFileSync(changelogPath, updated);
  console.log(`[${target.dirName}] ${target.manifest.name} ${target.newVersion} (${target.subjects.length}개 커밋)`);
}

//-- build → package → publish
run("pnpm", ["build"]);

fs.rmSync(artifactPath, { recursive: true, force: true });
fs.mkdirSync(artifactPath, { recursive: true });

const vsixPaths = [];
for (const target of targets) {
  const vsixPath = path.join(artifactPath, `${target.manifest.name}-${target.newVersion}.vsix`);
  run("pnpm", [
    "--dir", `packages/${target.dirName}`,
    "exec", "vsce", "package", "--no-dependencies",
    // monorepo — vsce 는 README 상대경로를 repo 루트 기준으로 재작성하므로 패키지 폴더 기준 URL 지정
    "--baseContentUrl", `https://github.com/simplysm/simplysm-vscode/raw/HEAD/packages/${target.dirName}/`,
    "--baseImagesUrl", `https://github.com/simplysm/simplysm-vscode/raw/HEAD/packages/${target.dirName}/`,
    "--out", vsixPath,
  ]);
  vsixPaths.push(vsixPath);
}

// 전체 패키징 성공 후에만 publish 시작 (부분 배포 최소화)
for (const vsixPath of vsixPaths) {
  run("pnpm", ["exec", "vsce", "publish", "--packagePath", vsixPath, "-p", token]);
  console.log(`배포 완료: ${path.basename(vsixPath)}`);
}

//-- 배포 성공 후 commit + tag + push
const releasedNames = targets.map((t) => `${t.manifest.name}@${t.newVersion}`);
git("add", ...targets.flatMap((t) => [
  `packages/${t.dirName}/package.json`,
  `packages/${t.dirName}/CHANGELOG.md`,
]));
git("commit", "-m", `chore(release): ${releasedNames.join(", ")}`);
for (const name of releasedNames) git("tag", name);
git("push", "origin", "HEAD", ...baselineTags, ...releasedNames);

console.log("\n마켓플레이스 배포 완료. 반영까지 몇 분 걸릴 수 있습니다.");
