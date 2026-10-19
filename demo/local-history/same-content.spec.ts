// 내용이 같은 파일이 한꺼번에 생겨도(같은 blob 의 동시 저장) 모두 기록되고 실패 알림이 없다.
// 예: e2e 테스트가 만드는 Electron 프로필의 Code Cache/js · wasm 색인 파일 — 내용이 같고 동시에 생긴다.
import path from "node:path";
import fs from "node:fs";
import { expect, launchVsCode, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import { prepareRecording, storeDirOf } from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-same-content-target.txt";
const folderName = "local-history-same-content";
// 내용이 같은 파일의 묶음 — 묶음마다 내용이 다르고(새 blob), 묶음 안의 파일은 같은 blob 을 동시에 저장한다
const GROUP_COUNT = 10;
const GROUP_SIZE = 10;

/** 스냅샷 로그에 아직 없는 경로 — 저장에 실패한 파일은 기록되지 않는다. */
function unrecorded(userDataDir: string, relPaths: readonly string[]): string[] {
  let log: string;
  try {
    log = fs.readFileSync(path.join(storeDirOf(userDataDir), "snapshots.jsonl"), "utf8");
  } catch {
    return [...relPaths]; // 저장소가 아직 없다
  }
  return relPaths.filter((relPath) => !log.includes(`"${relPath}"`));
}

test.skip(process.platform !== "win32", "덮어쓰기 충돌(EPERM)은 Windows 파일 동작");

test("내용이 같은 파일들이 한꺼번에 생겨도 모두 기록되고 실패 알림이 없다", async ({
  vscodeExePath,
}, testInfo) => {
  const filePath = path.join(workspaceDir, fileName);
  const folderPath = path.join(workspaceDir, folderName);
  fs.writeFileSync(filePath, "initial\n");
  fs.rmSync(folderPath, { recursive: true, force: true });
  const userDataDir = testInfo.outputPath("user-data");
  const app = await launchVsCode(vscodeExePath, {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir,
  });
  try {
    const workbox = await app.firstWindow();
    await prepareRecording(workbox, fileName, filePath);
    const failureToast = workbox.locator(".notification-list-item-message", {
      hasText: "Local History failed",
    });

    fs.mkdirSync(folderPath);
    const created: string[] = [];
    for (let group = 0; group < GROUP_COUNT; group++) {
      for (let member = 0; member < GROUP_SIZE; member++) {
        const name = `group-${group}-${member}.txt`;
        fs.writeFileSync(path.join(folderPath, name), `same content ${group}\n`);
        created.push(`${folderName}/${name}`);
      }
    }

    await expect.poll(() => unrecorded(userDataDir, created), { timeout: 30_000 }).toEqual([]);
    await expect(failureToast).toHaveCount(0);
    // 게시에 쓴 임시 파일이 남지 않는다
    const blobsDir = path.join(storeDirOf(userDataDir), "blobs");
    const leftovers = fs
      .readdirSync(blobsDir, { recursive: true, encoding: "utf8" })
      .filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    await workbox.screenshot({ path: path.join(shotDir, "same-content-no-toast.png") });
  } finally {
    await app.close();
    fs.rmSync(filePath, { force: true });
    fs.rmSync(folderPath, { recursive: true, force: true });
  }
});
