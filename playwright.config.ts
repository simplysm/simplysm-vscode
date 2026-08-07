// 시연 자동화 하네스 설정 — 제품 코드 아님, 개발 환경 도구.
import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const resultsRoot = path.join(rootDir, "demo", "results");

// 실행마다 산출물 폴더를 분리한다 — playwright 는 실행 시작 시 outputDir 을 통째로 비우므로,
// 폴더를 공유하면 동시 실행이 서로의 산출물(스크린샷·진단)을 지운다.
// 이 파일은 worker 프로세스에서도 다시 로드되므로, 최초 로드(러너)에서만 만들고 env 로 물려준다.
if (process.env["DEMO_RUN_DIR"] == null) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  process.env["DEMO_RUN_DIR"] = path.join(resultsRoot, runId);

  // 지난 실행 산출물 정리 — 하루 넘은 폴더만. 진행 중인 다른 실행은 최근 폴더라 대상이 안 된다.
  const keepMs = 24 * 60 * 60 * 1000;
  if (fs.existsSync(resultsRoot)) {
    for (const entryName of fs.readdirSync(resultsRoot)) {
      const entryPath = path.join(resultsRoot, entryName);
      if (Date.now() - fs.statSync(entryPath).mtimeMs > keepMs) {
        fs.rmSync(entryPath, { recursive: true, force: true });
      }
    }
  }
}

export default defineConfig({
  testDir: path.join(rootDir, "demo"),
  workers: 1, // VS Code 인스턴스 직렬 실행
  timeout: 120_000, // VS Code 실기동 + 확장 활성화 대기 포함
  outputDir: process.env["DEMO_RUN_DIR"],
  reporter: [["list"]],
});
