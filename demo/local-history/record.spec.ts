// 슬라이스 1 시연 — 파일 외부 수정이 스냅샷으로 기록되고, Show History 로 시점 목록이 보인다.
// 파일은 기동 전에 만들어 둔다(슬라이스 1 은 스캔 없음 — 기동 중 변경만 기록되므로 수정 = 시점).
import path from "node:path";
import fs from "node:fs";
import { expect, test, runResultsDir, workspaceDir } from "../fixtures.ts";
import { historyPaneOf, prepareRecording, showHistoryViaContextMenu } from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const fileName = "local-history-target.txt";
const otherFileName = "local-history-other.txt";

test("파일 수정 2회가 시점 2개로 기록되고 Show History 로 목록이 보인다", async ({ workbox }) => {
  const filePath = path.join(workspaceDir, fileName);
  const otherPath = path.join(workspaceDir, otherFileName);
  fs.writeFileSync(filePath, "initial\n");
  fs.writeFileSync(otherPath, "other\n");
  try {
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const historyPane = historyPaneOf(workbox);

    // 외부 수정 2회 — 각 수정이 별도 시점으로 기록됨을 순차 확인
    fs.writeFileSync(filePath, "first change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 1, { timeout: 15_000 });
    fs.writeFileSync(filePath, "second change\n");
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 2, { timeout: 15_000 });

    // 실사용자 경로: 다른 파일에서 우클릭 Show History → 대상 전환이 우클릭 경로만으로 일어남을
    // 판정 (전환 자체는 helper 가 pane 설명으로 단언 — 시점 수는 기동 스캔 baseline 에 따라 0~1)
    const otherItem = workbox.getByRole("treeitem", { name: otherFileName });
    await showHistoryViaContextMenu(workbox, otherItem, otherFileName);

    // 다시 대상 파일로 전환 — 시점 목록 확인 후 스크린샷
    const treeItem = workbox.getByRole("treeitem", { name: fileName });
    await showHistoryViaContextMenu(workbox, treeItem, fileName);
    await expect(historyPane.getByRole("treeitem")).toHaveCount(baseline + 2, { timeout: 15_000 });

    // 줄 라벨 — 시각은 초까지, 맨 위 줄에만 날짜(같은 날의 아래 줄은 시각만), 파일 이력은 요약 없음
    const year = String(new Date().getFullYear());
    const labels = historyPane.locator(".monaco-list-row .label-name");
    await expect(labels.nth(0)).toContainText(year);
    await expect(labels.nth(0)).toHaveText(/\d:\d{2}:\d{2}/);
    await expect(labels.nth(1)).not.toContainText(year);
    await expect(labels.nth(1)).toHaveText(/\d:\d{2}:\d{2}/);
    // 시각은 VS Code 표시 언어(영어) 형식 — OS 지역 설정을 따르지 않는다
    await expect(labels.nth(0)).toHaveText(/\d:\d{2}:\d{2}\s?(AM|PM)$/);
    await expect(labels.nth(0)).not.toContainText(/오전|오후/);
    await expect(historyPane.locator(".monaco-list-row .label-description")).toHaveCount(0);

    await workbox.screenshot({ path: path.join(shotDir, "record-list.png") });
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(otherPath, { force: true });
  }
});
