// 슬라이스 7 시연 — 보존 기한(1년) 초과 스냅샷과 미참조 blob 이 기동 시 백그라운드로 정리된다.
// 1차 기동으로 저장소를 만들고, 종료 상태에서 오래된 스냅샷·blob 을 심은 뒤 재기동해 정리를 확인.
import path from "node:path";
import fs from "node:fs";
import { expect, launchVsCode, test, workspaceDir } from "../fixtures.ts";
import { countSnapshots, prepareRecording } from "./history-utils.ts";

const fileName = "local-history-prune-target.txt";

test("1년 초과 스냅샷과 미참조 blob 이 재기동 시 정리된다", async ({ vscodeExePath }, testInfo) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  try {
    // 1차 기동 — 저장소 생성 + 최근 스냅샷 기록
    const firstApp = await launchVsCode(vscodeExePath, dirs);
    try {
      await prepareRecording(await firstApp.firstWindow(), fileName, filePath);
    } finally {
      await firstApp.close();
    }

    // 종료 상태에서 1년 넘은 스냅샷과 그것만 참조하는 blob 을 심는다
    const storageRoot = path.join(
      dirs.userDataDir,
      "User",
      "globalStorage",
      "simplysm.simplysm-local-history",
    );
    const workspaceId = fs.readdirSync(storageRoot)[0];
    const storeDir = path.join(storageRoot, workspaceId);
    const staleHash = "00d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1";
    const staleAt = Date.now() - 400 * 24 * 60 * 60 * 1000;
    const logPath = path.join(storeDir, "snapshots.jsonl");
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({ at: staleAt, entries: [{ path: "stale.txt", hash: staleHash }] })}\n`,
    );
    const staleBlobPath = path.join(storeDir, "blobs", staleHash.slice(0, 2), staleHash.slice(2));
    fs.mkdirSync(path.dirname(staleBlobPath), { recursive: true });
    fs.writeFileSync(staleBlobPath, "stale-blob");
    const staleTime = new Date(staleAt);
    fs.utimesSync(staleBlobPath, staleTime, staleTime); // 최근 blob 보호 가드를 지나도록 과거로
    const recentSnapshotCount = countSnapshots(dirs.userDataDir); // 심은 것 포함

    // 2차 기동 — 기동 prune 이 오래된 스냅샷·미참조 blob 만 지운다
    const secondApp = await launchVsCode(vscodeExePath, dirs);
    try {
      await expect
        .poll(() => fs.readFileSync(logPath, "utf8"), { timeout: 60_000 })
        .not.toContain(staleHash);
      await expect.poll(() => fs.existsSync(staleBlobPath), { timeout: 15_000 }).toBe(false);
      // 새 저장 형식은 스냅샷 디렉터리를 만들지 않는다
      expect(fs.existsSync(path.join(storeDir, "snapshots"))).toBe(false);
      // 최근 스냅샷은 보존 (심은 것만 제거 — 재기동 중 새 기록이 있을 수 있어 하한으로 단언)
      expect(countSnapshots(dirs.userDataDir)).toBeGreaterThanOrEqual(recentSnapshotCount - 1);
    } finally {
      await secondApp.close();
    }
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
