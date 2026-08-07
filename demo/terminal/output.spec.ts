// 출력 활용 시연 — 검색·파일 링크 열기·복사·붙여넣기가 동작하는지 확인한다.
import path from "node:path";
import { expect, retryAction, runResultsDir, runCommand, test, webviewFrame } from "../fixtures.ts";

const shotDir = path.join(runResultsDir, "terminal");

async function openTerminalPanel(workbox: Parameters<typeof webviewFrame>[0]) {
  await runCommand(workbox, "Simplysm Terminal");
  const frame = webviewFrame(workbox);
  await expect(frame.locator(".screen .xterm-screen")).toBeVisible({ timeout: 60_000 });
  return frame;
}

/**
 * xterm 은 여러 레이어가 글자 위를 덮어 요소 클릭이 가로채인다.
 * 요소의 자리만 얻어 페이지 좌표로 마우스를 직접 움직인다.
 */
async function pointOf(
  locator: ReturnType<ReturnType<typeof webviewFrame>["locator"]>,
  offsetX: number,
): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box == null) throw new Error("클릭할 요소의 자리를 얻지 못했습니다.");
  return { x: box.x + offsetX, y: box.y + box.height / 2 };
}

test("검색 — Ctrl+F 로 열고, 결과 수·이동·비움·0건이 갈린다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  const screen = frame.locator(".screen .xterm-screen");
  await screen.click();
  await workbox.keyboard.type("1..30 | ForEach-Object { \"needle-line-$_\" }\r");
  await expect(frame.locator(".xterm-rows")).toContainText("needle-line-30", { timeout: 30_000 });

  await workbox.keyboard.press("Control+KeyF");
  const searchInput = frame.locator(".search-input");
  await expect(searchInput).toBeVisible();
  await searchInput.fill("needle-line");
  // 결과 수가 "n/총건" 으로 보인다 (명령 에코까지 포함되므로 총건만 확인).
  await expect(frame.locator(".search-result")).toHaveText(/\d+\/\d+/, { timeout: 15_000 });
  const before = await frame.locator(".search-result").textContent();

  // 다음·이전 이동으로 현재 위치가 바뀐다.
  await workbox.keyboard.press("Enter");
  await expect(frame.locator(".search-result")).not.toHaveText(before!, { timeout: 15_000 });
  await workbox.screenshot({ path: path.join(shotDir, "output-search.png") });

  // 0건이면 그 사실이 보인다.
  await searchInput.fill("no-such-text-anywhere");
  await expect(frame.locator(".search-result")).toHaveText("No results", { timeout: 15_000 });

  // 검색어를 비우면 결과 표시도 강조도 사라진다.
  await searchInput.fill("");
  await expect(frame.locator(".search-result")).toHaveText("");

  // Esc 로 닫으면 검색창이 사라지고 포커스가 터미널로 돌아간다.
  await workbox.keyboard.press("Escape");
  await expect(frame.locator(".search-bar")).toHaveCount(0);
});

test("파일 링크 — 출력 속 경로를 Ctrl+클릭하면 에디터로 열린다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  const screen = frame.locator(".screen .xterm-screen");
  await screen.click();
  await workbox.keyboard.type('"link-me" | Out-File demo-link-target.txt\r');
  await workbox.keyboard.type('echo ".\\demo-link-target.txt"\r');
  const linkRow = frame.locator(".xterm-rows > div", { hasText: "demo-link-target.txt" }).last();
  await expect(linkRow).toBeVisible({ timeout: 30_000 });

  await retryAction(
    async () => {
      const point = await pointOf(linkRow, 60);
      await workbox.keyboard.down("Control");
      await workbox.mouse.click(point.x, point.y);
      await workbox.keyboard.up("Control");
    },
    async () => {
      await expect(
        workbox.getByRole("tab", { name: /demo-link-target\.txt/ }),
      ).toBeVisible({ timeout: 5_000 });
    },
  );
  await workbox.screenshot({ path: path.join(shotDir, "output-file-link.png") });
});

test("복사·붙여넣기 — 우클릭은 선택이 있으면 복사, 없으면 붙여넣기다 (메뉴 없음)", async ({
  workbox,
}) => {
  const frame = await openTerminalPanel(workbox);
  const screen = frame.locator(".screen .xterm-screen");
  await screen.click();
  await workbox.keyboard.type("echo unique-copy-token\r");
  const outputRow = frame.locator(".xterm-rows > div", { hasText: "unique-copy-token" }).last();
  await expect(outputRow).toBeVisible({ timeout: 30_000 });

  // 더블클릭 단어 선택 → 우클릭이 곧 복사다. 메뉴는 뜨지 않는다.
  const wordPoint = await pointOf(outputRow, 40);
  await workbox.mouse.dblclick(wordPoint.x, wordPoint.y);
  await workbox.mouse.click(wordPoint.x, wordPoint.y, { button: "right" });
  await expect(frame.locator(".tab-menu")).toHaveCount(0);
  // 복사만 되어야 한다 — 선택 텍스트가 입력 줄로 흘러 붙여넣어지는 회귀 방지 (에코·출력 2줄 그대로).
  await expect(frame.locator(".xterm-rows > div", { hasText: "unique-copy-token" })).toHaveCount(2);
  await workbox.screenshot({ path: path.join(shotDir, "output-copy-paste.png") });

  // 셸로 클립보드를 읽어 복사가 실제로 됐는지 확인한다.
  await workbox.keyboard.type("Get-Clipboard\r");
  await expect(frame.locator(".xterm-rows")).toContainText(/Get-Clipboard[\s\S]*unique-copy/, {
    timeout: 30_000,
  });

  // 복사가 선택을 풀었으므로, 이어지는 우클릭은 붙여넣기다.
  const screenPoint = await pointOf(screen, 120);
  await workbox.mouse.click(screenPoint.x, screenPoint.y, { button: "right" });
  await expect(frame.locator(".xterm-rows > div", { hasText: "unique-copy-token" })).toHaveCount(
    4, // 에코·출력·Get-Clipboard 출력·붙여넣은 입력 줄
    { timeout: 30_000 },
  );
});

test("OSC 52 — 셸 프로그램의 이스케이프 시퀀스로 클립보드에 복사된다", async ({ workbox }) => {
  const frame = await openTerminalPanel(workbox);
  const screen = frame.locator(".screen .xterm-screen");
  await screen.click();
  // OSC 52 쓰기: ESC]52;c;<base64>BEL 을 출력하면 에뮬레이터가 클립보드에 담는다.
  await workbox.keyboard.type(
    "$b=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('osc52-copied-token')); " +
      'Write-Host -NoNewline "`e]52;c;$b`a"\r',
  );
  await workbox.keyboard.type("Get-Clipboard\r");
  await expect(frame.locator(".xterm-rows")).toContainText(/Get-Clipboard[\s\S]*osc52-copied/, {
    timeout: 30_000,
  });
});

test("복사·붙여넣기 — 선택 중 Ctrl+C 는 복사, Ctrl+V 는 붙여넣기, 선택 없는 Ctrl+C 는 셸로 간다", async ({
  workbox,
}) => {
  const frame = await openTerminalPanel(workbox);
  const screen = frame.locator(".screen .xterm-screen");
  await screen.click();
  await workbox.keyboard.type("echo unique-key-token\r");
  const outputRow = frame.locator(".xterm-rows > div", { hasText: "unique-key-token" }).last();
  await expect(outputRow).toBeVisible({ timeout: 30_000 });

  // 더블클릭 단어 선택 → Ctrl+C 복사 (셸로 SIGINT 가 가지 않고 클립보드에 담긴다).
  const wordPoint = await pointOf(outputRow, 40);
  await workbox.mouse.dblclick(wordPoint.x, wordPoint.y);
  await workbox.keyboard.press("Control+KeyC");
  await workbox.keyboard.type("Get-Clipboard\r");
  await expect(frame.locator(".xterm-rows")).toContainText(/Get-Clipboard[\s\S]*unique-key/, {
    timeout: 30_000,
  });
  await workbox.screenshot({ path: path.join(shotDir, "output-copy-paste-keys.png") });

  // Ctrl+V 붙여넣기 — 클립보드 값이 입력 줄에 들어간다.
  await workbox.keyboard.press("Control+KeyV");
  await expect(frame.locator(".xterm-rows > div", { hasText: "unique-key-token" })).toHaveCount(
    4, // 에코·출력·Get-Clipboard 출력·붙여넣은 입력 줄
    { timeout: 30_000 },
  );
  // 한 번만 붙어야 한다 — 이중 붙여넣기 회귀 방지.
  await expect(
    frame.locator(".xterm-rows > div", { hasText: /unique-key-token.*unique-key-token/ }),
  ).toHaveCount(0);

  // 선택 없는 Ctrl+C 는 셸로 가 입력 줄이 취소된다 (붙여넣은 값이 실행되지 않는다).
  await workbox.keyboard.press("Control+KeyC");
  await workbox.keyboard.type("echo after-sigint\r");
  await expect(frame.locator(".xterm-rows")).toContainText("after-sigint", { timeout: 30_000 });
});
