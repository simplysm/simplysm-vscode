import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootPath = path.resolve(import.meta.dirname, "..");
const targetDirNames = new Set(["node_modules", ".cache", "dist"]);
const skipDirNames = new Set([".git", ".back"]);

const deletedPaths = [];

function removeDir(dirPath) {
  if (process.platform === "win32") {
    // symlink/junction 많은 폴더(node_modules 등)는 rd /s /q 가 최속 + 안전(링크를 따라가지 않음)
    try {
      execFileSync("cmd", ["/c", "rd", "/s", "/q", dirPath], { stdio: "inherit" });
    } catch {
      // rd 가 MAX_PATH 초과 등으로 일부 못 지우고 비정상 종료 → 아래 fallback 으로 완결
    }
    if (fs.existsSync(dirPath)) {
      // MAX_PATH(260자) 초과 잔존분 fallback — \\?\ 리터럴 경로로 재삭제
      fs.rmSync(`\\\\?\\${dirPath}`, { recursive: true, force: true });
    }
    if (fs.existsSync(dirPath)) {
      throw new Error(`삭제 실패: ${dirPath}`);
    }
  } else {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function scan(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (targetDirNames.has(entry.name)) {
      removeDir(fullPath);
      deletedPaths.push(fullPath);
    } else if (!skipDirNames.has(entry.name)) {
      scan(fullPath);
    }
  }
}

scan(rootPath);

const lockFilePath = path.join(rootPath, "pnpm-lock.yaml");
if (fs.existsSync(lockFilePath)) {
  fs.rmSync(lockFilePath);
  deletedPaths.push(lockFilePath);
}

for (const deletedPath of deletedPaths) {
  console.log(`deleted: ${path.relative(rootPath, deletedPath)}`);
}
console.log(`total: ${deletedPaths.length}`);
