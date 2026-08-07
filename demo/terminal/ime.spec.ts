// 한글 입력 시연 — 확정된 글자가 한 번만 셸에 닿고, 셸이 되돌린 출력도 깨지지 않는다.
// 조합 중 상태의 자동 재현은 CDP 합성 입력이 조합을 조기 확정해 간헐적으로 어긋난다 (RISK-009).
// 조합 처리 자체는 에뮬레이터 몫이라 우리 코드에 검증할 로직이 없고, 조합 중 화면은 육안으로 확인한다.
import path from "node:path";
import { expect, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");

test("확정한 한글이 한 번만 전달되고 셸 출력에서도 깨지지 않는다", async ({
  electronApp,
  workbox,
}) => {
  await runCommand(workbox, "Simplysm Terminal");
  const frame = webviewFrame(workbox);
  const screen = frame.locator(".screen .xterm-screen");
  await expect(screen).toBeVisible({ timeout: 60_000 });
  await screen.click();

  const rows = frame.locator(".xterm-rows");
  await workbox.keyboard.type("echo ");
  await expect(rows).toContainText("echo ", { timeout: 30_000 });

  const cdp = await electronApp.context().newCDPSession(workbox);
  await cdp.send("Input.insertText", { text: "한글" });
  await expect(rows).toContainText("echo 한글", { timeout: 30_000 });
  // 같은 글자가 두 번 들어가지 않았다
  await expect(rows).not.toContainText("한글한글");

  await workbox.keyboard.press("Enter");
  // 셸이 되돌린 출력에도 확정 글자가 깨지지 않고 그대로 나온다
  await expect(rows).toContainText(/한글[\s\S]*한글/, { timeout: 30_000 });
  await workbox.screenshot({ path: path.join(shotDir, "ime-committed.png") });
});
