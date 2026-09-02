// 제외 시연 — `simplysm-local-history.exclude` 에 걸리는 경로는 기록되지 않고,
// 규칙 추가 전에 기록된 오염 entry 는 재기동 prune 이 소급 정리한다.
import path from "node:path";
import fs from "node:fs";
import { expect, launchVsCode, test, workspaceDir } from "../fixtures.ts";
import { countSnapshots, prepareRecording } from "./history-utils.ts";

const fileName = "local-history-exclude-target.txt";
const excludedDirName = "local-history-exclude-gen";

/** 모든 스냅샷 매니페스트 본문 — 제외 경로가 기록됐는지 전수 확인용. */
function readManifests(userDataDir: string): string[] {
  const storageRoot = path.join(
    userDataDir,
    "User",
    "globalStorage",
    "simplysm.simplysm-local-history",
  );
  if (!fs.existsSync(storageRoot)) return [];
  const texts: string[] = [];
  for (const workspaceId of fs.readdirSync(storageRoot)) {
    const snapshotsDir = path.join(storageRoot, workspaceId, "snapshots");
    if (!fs.existsSync(snapshotsDir)) continue;
    for (const name of fs.readdirSync(snapshotsDir)) {
      if (name.endsWith(".json")) {
        texts.push(fs.readFileSync(path.join(snapshotsDir, name), "utf8"));
      }
    }
  }
  return texts;
}

test("제외 설정 경로는 기록되지 않고 기존 오염 entry 는 재기동 시 정리된다", async ({
  vscodeExePath,
}, testInfo) => {
  const filePath = path.join(workspaceDir, fileName);
  const excludedDir = path.join(workspaceDir, excludedDirName);
  fs.writeFileSync(filePath, "initial\n");
  fs.mkdirSync(excludedDir, { recursive: true });
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  const settings = {
    "simplysm-local-history.exclude": { [`**/${excludedDirName}`]: true },
  };
  try {
    // 1차 기동 — 제외 경로 변경은 기록되지 않고, 일반 파일 변경만 기록된다
    const firstApp = await launchVsCode(vscodeExePath, dirs, { settings });
    try {
      const workbox = await firstApp.firstWindow();
      await prepareRecording(workbox, fileName, filePath);
      const before = countSnapshots(dirs.userDataDir);
      fs.writeFileSync(path.join(excludedDir, "generated.txt"), "generated\n");
      fs.writeFileSync(filePath, "tracked change\n");
      await expect
        .poll(() => countSnapshots(dirs.userDataDir), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(before + 1);
      await workbox.waitForTimeout(2_000); // 추가 기록 정착 대기
      expect(readManifests(dirs.userDataDir).join("\n")).not.toContain(excludedDirName);
    } finally {
      await firstApp.close();
    }

    // 종료 상태에서 제외 경로 entry 만 담은 스냅샷(=규칙 추가 전 오염)과 그 blob 을 심는다
    const storageRoot = path.join(
      dirs.userDataDir,
      "User",
      "globalStorage",
      "simplysm.simplysm-local-history",
    );
    const workspaceId = fs.readdirSync(storageRoot)[0];
    const storeDir = path.join(storageRoot, workspaceId);
    const plantedHash = "00e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2";
    const plantedAt = Date.now() - 60 * 60 * 1000; // 보존 기한 안 — 제외 정리만으로 지워져야 함
    const plantedSnapshotPath = path.join(storeDir, "snapshots", `${plantedAt}.json`);
    fs.writeFileSync(
      plantedSnapshotPath,
      JSON.stringify({
        at: plantedAt,
        entries: [{ path: `${excludedDirName}/polluted.txt`, hash: plantedHash }],
      }),
    );
    const plantedBlobPath = path.join(
      storeDir,
      "blobs",
      plantedHash.slice(0, 2),
      plantedHash.slice(2),
    );
    fs.mkdirSync(path.dirname(plantedBlobPath), { recursive: true });
    fs.writeFileSync(plantedBlobPath, "polluted-blob");
    const plantedTime = new Date(plantedAt - 24 * 60 * 60 * 1000);
    fs.utimesSync(plantedBlobPath, plantedTime, plantedTime); // 최근 blob 보호 가드를 지나도록 과거로
    // 색인에도 제외 경로를 심는다 — 스캔이 "미기동 기간 삭제"로 기록하지 않고 색인만 정리해야 함
    const indexPath = path.join(storeDir, "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>;
    index[`${excludedDirName}/polluted.txt`] = { mtime: 1, size: 1, hash: plantedHash };
    fs.writeFileSync(indexPath, JSON.stringify(index));
    const beforeRestart = countSnapshots(dirs.userDataDir); // 심은 것 포함

    // 2차 기동 — 기동 prune 이 제외 entry 스냅샷과 미참조 blob 을 소급 정리
    const secondApp = await launchVsCode(vscodeExePath, dirs, { settings });
    try {
      await expect.poll(() => fs.existsSync(plantedSnapshotPath), { timeout: 60_000 }).toBe(false);
      await expect.poll(() => fs.existsSync(plantedBlobPath), { timeout: 15_000 }).toBe(false);
      // 제외 아닌 기존 이력은 살아남는다 (심은 것만 제거 — 재기동 중 새 기록이 있을 수 있어 하한으로 단언)
      expect(countSnapshots(dirs.userDataDir)).toBeGreaterThanOrEqual(beforeRestart - 1);
      // 스캔이 제외 경로를 삭제 스냅샷으로 기록하지 않았고, 색인에서도 정리했다
      expect(readManifests(dirs.userDataDir).join("\n")).not.toContain(excludedDirName);
      await expect
        .poll(() => fs.readFileSync(indexPath, "utf8"), { timeout: 30_000 })
        .not.toContain(excludedDirName);
    } finally {
      await secondApp.close();
    }
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(excludedDir, { recursive: true, force: true });
  }
});
