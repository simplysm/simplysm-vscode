// 다른 프로세스가 독점 잠금(공유 위반 = EBUSY)한 파일 — 잠긴 동안은 알림 없이 건너뛰고,
// 잠금이 풀린 뒤 스캔이 그 변경을 기록한다.
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import { historyPaneOf, prepareRecording, showHistoryViaContextMenu } from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-locked-target.txt";
// 스캔 throttle(30초) — 잠금 해제 후 스캔 트리거(Show History)가 실제로 스캔을 돌리게 하려면 이만큼 지나야 한다
const SCAN_THROTTLE_MS = 30_000;

/** 파일을 공유 불가로 열어 내용을 쓴 뒤 핸들을 쥔 채 대기하는 프로세스 — kill 전까지 누구도 읽지 못한다. */
function holdExclusiveLock(filePath: string, content: string): ChildProcess {
  const script = [
    `$stream = [System.IO.File]::Open('${filePath}', 'Open', 'ReadWrite', 'None')`,
    "$stream.SetLength(0)",
    `$bytes = [System.Text.Encoding]::UTF8.GetBytes('${content}')`,
    "$stream.Write($bytes, 0, $bytes.Length)",
    "$stream.Flush()",
    "Start-Sleep -Seconds 600",
  ].join("; ");
  return spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, stdio: "ignore" },
  );
}

test.skip(process.platform !== "win32", "공유 위반(EBUSY)은 Windows 파일 잠금 동작");

test("잠긴 파일은 알림 없이 건너뛰고, 잠금이 풀린 뒤 스캔이 기록한다", async ({ workbox }) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "initial\n");
  let locker: ChildProcess | undefined;
  try {
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const preparedAt = Date.now(); // 기동 스캔은 이 시점 이전에 끝났다 — throttle 기준
    const historyPane = historyPaneOf(workbox);
    const failureToast = workbox.locator(".notification-list-item-message", {
      hasText: "Local History failed",
    });

    // 잠근 채로 변경 — watcher 이벤트는 오지만 읽기가 EBUSY
    locker = holdExclusiveLock(filePath, "locked change");
    await workbox.waitForTimeout(8_000); // debounce·읽기 시도·알림 표시가 일어날 시간
    await expect(failureToast).toHaveCount(0);
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline);
    await workbox.screenshot({ path: path.join(shotDir, "locked-no-toast.png") });

    // 잠금 해제 → 스캔 트리거(Show History)가 미기록 변경을 잡는다
    locker.kill();
    locker = undefined;
    await workbox.waitForTimeout(Math.max(0, SCAN_THROTTLE_MS + 1_000 - (Date.now() - preparedAt)));
    const treeItem = workbox.getByRole("treeitem", { name: fileName });
    await showHistoryViaContextMenu(workbox, treeItem, fileName);
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 1, { timeout: 15_000 });
    await expect(failureToast).toHaveCount(0);
    await workbox.screenshot({ path: path.join(shotDir, "locked-recovered.png") });
  } finally {
    locker?.kill();
    fs.rmSync(filePath, { force: true });
  }
});
