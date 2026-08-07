// 조용한 리로드 시연 — 외부에서 파일 수정 → 포커스 복귀 → 에디터 내용이 디스크 버전으로 갱신.
// VS Code 내장 파일 워처도 non-dirty 문서를 자동 리로드하므로, 대상 파일을 워처에서 제외해
// 이 확장의 포커스 트리거 동작만 격리 검증한다.
import path from "node:path";
import fs from "node:fs";
import { expect, launchVsCode, runResultsDir, test, workspaceDir } from "../fixtures.ts";
import { simulateFocusRegain } from "./focus-utils.ts";

const shotDir = path.join(runResultsDir, "focus-refresh");
const fileName = "focus-reload-target.txt";

test("외부에서 수정한 non-dirty 파일이 포커스 복귀 시 조용히 리로드된다", async ({
  vscodeExePath,
}, testInfo) => {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, "before external change\n");

  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    { settings: { "files.watcherExclude": { [`**/${fileName}`]: true } } },
  );
  try {
    const workbox = await app.firstWindow();

    // Explorer 트리 클릭으로 파일 열기 — 실사용자 경로
    const treeItem = workbox.getByRole("treeitem", { name: fileName });
    await treeItem.waitFor({ state: "visible", timeout: 30_000 });
    await treeItem.click();
    const editor = workbox.locator(".editor-instance .view-lines");
    await expect(editor).toContainText("before external change", { timeout: 30_000 });

    // 외부 도구의 파일 수정 재현 — 워처 제외 상태이므로 내장 자동 리로드는 일어나지 않는다
    fs.writeFileSync(filePath, "after external change\n");
    await workbox.waitForTimeout(2000);
    await expect(editor).toContainText("before external change");

    await simulateFocusRegain(app, workbox);

    await expect(editor).toContainText("after external change", { timeout: 15_000 });
    // dirty 표시가 없어야 함 — 조용한 리로드는 문서를 깨끗한 상태로 유지
    await expect(workbox.getByRole("tab", { name: new RegExp(fileName) })).not.toHaveClass(
      /dirty/,
    );
    await workbox.screenshot({ path: path.join(shotDir, "silent-reload.png") });
  } finally {
    await app.close();
    fs.rmSync(filePath, { force: true });
  }
});
