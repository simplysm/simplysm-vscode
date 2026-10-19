// 저장 로그 전환 시연 — 옛 형식(snapshots/<at>.json) 저장소가 기동 때 로그(snapshots.jsonl)로 옮겨지고,
// 크래시로 남은 반쪽 줄은 적재 때 버려진 뒤 다음 기록이 정상 줄로 이어진다.
// 1차 기동으로 이력을 만들고, 종료 상태에서 저장소를 고친 뒤 재기동해 확인한다.
import path from "node:path";
import fs from "node:fs";
import type { Page } from "@playwright/test";
import { expect, launchVsCode, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import {
  countSnapshots,
  historyPaneOf,
  prepareRecording,
  showHistoryViaContextMenu,
} from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");

/** 저장소 디렉터리 — 시연 user-data 에는 워크스페이스 하나뿐이다. */
function storeDirOf(userDataDir: string): string {
  const storageRoot = path.join(
    userDataDir,
    "User",
    "globalStorage",
    "simplysm.simplysm-local-history",
  );
  return path.join(storageRoot, fs.readdirSync(storageRoot)[0]);
}

interface LoggedSnapshot {
  readonly at: number;
  readonly entries: { readonly path: string; readonly hash: string | null }[];
}

/** 로그의 스냅샷 — 쓴 순서. */
function readLogSnapshots(logPath: string): LoggedSnapshot[] {
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LoggedSnapshot);
}

const jsonFilesIn = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith(".json"));

/** 대상 파일을 열고 외부 수정 2회를 기록한 뒤, 이력 목록 라벨(시각)을 돌려준다. */
async function recordTwoChanges(workbox: Page, fileName: string, filePath: string) {
  const baseline = await prepareRecording(workbox, fileName, filePath);
  const items = historyPaneOf(workbox).getByRole("treeitem");
  fs.writeFileSync(filePath, "first change\n");
  await expect(items).toHaveCount(baseline + 1, { timeout: 15_000 });
  fs.writeFileSync(filePath, "second change\n");
  await expect(items).toHaveCount(baseline + 2, { timeout: 15_000 });
  return await items.allInnerTexts();
}

/** 재기동 창에서 대상 파일의 Show History 를 열고, 목록이 기대 개수로 차면 라벨을 돌려준다. */
async function historyLabelsAfterRestart(workbox: Page, fileName: string, expectedCount: number) {
  const treeItem = workbox.getByRole("treeitem", { name: fileName });
  await treeItem.waitFor({ state: "visible", timeout: 30_000 });
  await showHistoryViaContextMenu(workbox, treeItem, fileName);
  const items = historyPaneOf(workbox).getByRole("treeitem");
  await expect(items).toHaveCount(expectedCount, { timeout: 15_000 });
  return await items.allInnerTexts();
}

test("옛 형식 저장소가 기동 때 로그로 옮겨지고, 이후 수신함에 들어온 옛 형식도 중복 없이 들어온다", async ({
  vscodeExePath,
}, testInfo) => {
  const fileName = "local-history-migrate-target.txt";
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  try {
    // 1차 기동 — 이력을 만들고 목록 라벨을 기억한다
    let labelsBefore: string[];
    const firstApp = await launchVsCode(vscodeExePath, dirs);
    try {
      labelsBefore = await recordTwoChanges(await firstApp.firstWindow(), fileName, filePath);
    } finally {
      await firstApp.close();
    }

    // 종료 상태에서 저장소를 옛 형식으로 되돌린다 — 로그 한 줄 = 옛 스냅샷 파일 하나(본문 동일)
    const storeDir = storeDirOf(dirs.userDataDir);
    const logPath = path.join(storeDir, "snapshots.jsonl");
    const legacyDir = path.join(storeDir, "snapshots");
    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    fs.mkdirSync(legacyDir);
    for (const line of lines) {
      const { at } = JSON.parse(line) as { at: number };
      fs.writeFileSync(path.join(legacyDir, `${at}.json`), line);
    }
    fs.rmSync(logPath);

    // 2차 기동 — 기동 때 옛 형식이 로그로 옮겨지고, 가져온 파일은 지워지되 디렉터리(수신함)는 남는다
    const secondApp = await launchVsCode(vscodeExePath, dirs);
    try {
      const workbox = await secondApp.firstWindow();
      await expect.poll(() => jsonFilesIn(legacyDir).length, { timeout: 60_000 }).toBe(0);
      expect(fs.existsSync(legacyDir)).toBe(true);
      expect(fs.existsSync(logPath)).toBe(true);
      expect(countSnapshots(dirs.userDataDir)).toBeGreaterThanOrEqual(lines.length);
      // 이력 목록이 옮기기 전과 같다 (미기동 중 변경이 없어 기동 스캔이 더하는 시점도 없다)
      const labelsAfter = await historyLabelsAfterRestart(workbox, fileName, labelsBefore.length);
      expect(labelsAfter).toEqual(labelsBefore);
      await workbox.screenshot({ path: path.join(shotDir, "migrate-list.png") });
    } finally {
      await secondApp.close();
    }

    // 종료 상태에서 수신함에 옛 형식 파일을 둔다
    // - 가져온 뒤 파일을 지우기 전에 끊긴 경우: 이미 로그에 있는 스냅샷 2개
    // - 옛 확장 창이 새로 쓴 스냅샷 2개: 대상 파일의 더 이른 시점 1개 + 기존 at 과 겹치는 다른 스냅샷 1개
    const logged = readLogSnapshots(logPath);
    const targetSnapshots = logged.filter((snapshot) =>
      snapshot.entries.some((entry) => entry.path === fileName),
    );
    const targetHash = targetSnapshots[0].entries.find((entry) => entry.path === fileName)!.hash;
    const earlier = {
      at: targetSnapshots[0].at - 60_000,
      entries: [{ path: fileName, hash: targetHash }],
    };
    // 겹치는 것은 대상 파일의 마지막 상태를 그대로 두고(기동 스캔이 새 시점을 더하지 않게) 다른 경로 항목을 더해 다르게 한다
    const lastTarget = targetSnapshots.at(-1)!;
    const colliding = {
      at: lastTarget.at,
      entries: [
        ...lastTarget.entries.filter((entry) => entry.path === fileName),
        { path: "local-history-migrate-gone.txt", hash: null },
      ],
    };
    for (const snapshot of [logged[0], targetSnapshots[0], earlier, colliding]) {
      fs.writeFileSync(path.join(legacyDir, `${snapshot.at}.json`), JSON.stringify(snapshot));
    }
    // 겹치는 것은 파일 이름이 기존 파일과 같아지지 않게 따로 둔다 (옛 확장 창은 자기 at 으로 이름을 짓는다)
    fs.renameSync(
      path.join(legacyDir, `${colliding.at}.json`),
      path.join(legacyDir, `${colliding.at}-old-window.json`),
    );
    fs.writeFileSync(
      path.join(legacyDir, `${targetSnapshots.at(-1)!.at}.json`),
      JSON.stringify(targetSnapshots.at(-1)),
    );

    // 3차 기동 — 새 스냅샷 2개만 들어오고(중복 없음) at 은 유일·시각순, 수신함은 비워지되 남는다
    const thirdApp = await launchVsCode(vscodeExePath, dirs);
    try {
      const workbox = await thirdApp.firstWindow();
      await expect.poll(() => jsonFilesIn(legacyDir).length, { timeout: 60_000 }).toBe(0);
      expect(fs.existsSync(legacyDir)).toBe(true);
      const afterImport = readLogSnapshots(logPath);
      expect(afterImport.length).toBe(logged.length + 2);
      for (let index = 1; index < afterImport.length; index++) {
        expect(afterImport[index].at).toBeGreaterThan(afterImport[index - 1].at);
      }
      const labelsAfter = await historyLabelsAfterRestart(
        workbox,
        fileName,
        labelsBefore.length + 2,
      );
      // 더 이른 시점은 목록 맨 아래(가장 오래됨)에 새 라벨로 나타난다
      expect(labelsBefore).not.toContain(labelsAfter.at(-1));
      expect(labelsAfter.slice(0, -1)).toEqual(expect.arrayContaining(labelsBefore));
      await workbox.screenshot({ path: path.join(shotDir, "migrate-inbox-list.png") });
    } finally {
      await thirdApp.close();
    }
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("로그 끝의 반쪽 줄은 버려지고 다음 기록이 정상 줄로 이어진다", async ({
  vscodeExePath,
}, testInfo) => {
  const fileName = "local-history-partial-target.txt";
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  try {
    let labelsBefore: string[];
    const firstApp = await launchVsCode(vscodeExePath, dirs);
    try {
      labelsBefore = await recordTwoChanges(await firstApp.firstWindow(), fileName, filePath);
    } finally {
      await firstApp.close();
    }

    // 종료 상태에서 크래시로 끊긴 append 를 재현 — 줄바꿈 없는 반쪽 줄
    const logPath = path.join(storeDirOf(dirs.userDataDir), "snapshots.jsonl");
    const completeLines = countSnapshots(dirs.userDataDir);
    fs.appendFileSync(logPath, `{"at":${Date.now()},"entries":[{"path":"${fileName}","ha`);

    const secondApp = await launchVsCode(vscodeExePath, dirs);
    try {
      const workbox = await secondApp.firstWindow();
      // 적재가 반쪽 줄만 버리고 목록을 그대로 보인다
      const labelsAfter = await historyLabelsAfterRestart(workbox, fileName, labelsBefore.length);
      expect(labelsAfter).toEqual(labelsBefore);

      // 다음 기록 — 반쪽 줄을 잘라낸 자리에 정상 줄이 이어진다
      for (let attempt = 0; countSnapshots(dirs.userDataDir) <= completeLines; attempt++) {
        if (attempt >= 30) throw new Error("재기동 뒤 변경이 기록되지 않음");
        fs.writeFileSync(filePath, `after restart ${attempt}\n`); // 워처 기동 지연 대비 새 내용으로 재시도
        await workbox.waitForTimeout(2_000);
      }
      await expect
        .poll(() => historyPaneOf(workbox).getByRole("treeitem").count(), { timeout: 15_000 })
        .toBeGreaterThan(labelsBefore.length);
      const raw = fs.readFileSync(logPath, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      const lines = raw.slice(0, -1).split("\n");
      for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(lines.length).toBeGreaterThan(completeLines);
      expect(lines.at(-1)).toContain(fileName);
      await workbox.screenshot({ path: path.join(shotDir, "partial-line-list.png") });
    } finally {
      await secondApp.close();
    }
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
