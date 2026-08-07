// tasks 언어 등록 시연 — `.tasks` 를 텍스트 에디터로 열어도 확장 전용 언어로 잡혀
// JSON 언어 서비스 진단이 붙지 않음을 확인.
// 파일 앞 2줄은 정상 JSONL — `.tasks` 가 JSON 언어로 잡히면 2줄째에서 "End of file expected"
// 진단이 나고 Explorer 에 에러 배지가 뜬다. 마지막 줄만 파서 오류로 둬 확장의
// "Open as Text" 경로(결정적)로 텍스트 에디터에 진입한다.
import fs from "node:fs";
import path from "node:path";
import { expect, openTasksFile, test, workspaceDir } from "../fixtures.ts";

const demoFile = "language-text.tasks";

test.beforeEach(() => {
  fs.mkdirSync(workspaceDir, { recursive: true });
});

test.afterEach(() => {
  fs.rmSync(path.join(workspaceDir, demoFile), { force: true });
});

test(".tasks 텍스트 열기 → 언어 = Simplysm Tasks, JSON 진단 없음", async ({ workbox }) => {
  fs.writeFileSync(
    path.join(workspaceDir, demoFile),
    '{"text":"첫 메모"}\n{"text":"둘째 메모"}\nnot-json\n',
  );
  const frame = await openTasksFile(workbox, demoFile);
  await frame.locator(".open-as-text").click();

  // 상태바 언어 표시 = 확장 전용 언어 (JSON 아님)
  await expect(workbox.getByRole("button", { name: "Simplysm Tasks" })).toBeVisible({
    timeout: 30_000,
  });
  // JSON 언어 서비스 미부착 → 진단 0 (JSON 이었다면 2줄째 "End of file expected")
  await expect(workbox.getByRole("button", { name: "No Problems" })).toBeVisible();
});
