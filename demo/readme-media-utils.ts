// README 미디어 캡처 공용 헬퍼 — 가짜 커서 오버레이 + 주기 스크린샷 녹화.
// OS 커서는 스크린샷에 안 찍히므로 최상위 문서에 오버레이를 만들어 실제 마우스와 함께 움직인다.
import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function installCursor(workbox: Page): Promise<void> {
  await workbox.evaluate(() => {
    // 워크벤치 호버 툴팁 숨김 — 실제 OS 커서가 창 위에 걸쳐 있으면 툴팁이 프레임에 남는다
    const style = document.createElement("style");
    style.textContent = ".monaco-hover { display: none !important; }";
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.style.cssText =
      "position:fixed;left:0;top:0;width:20px;height:26px;z-index:2147483647;" +
      "pointer-events:none;display:none;background-repeat:no-repeat;background-size:contain;" +
      // 흰 테두리 + 검정 몸통 화살표 (밝은/어두운 배경 모두에서 보임)
      `background-image:url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 26"><path d="M2 1 L2 20 L7 16 L10 24 L13 22.5 L10 15 L16 15 Z" fill="black" stroke="white" stroke-width="1.6"/></svg>')`;
    document.body.appendChild(cursor);
  });
}

async function setCursor(workbox: Page, x: number, y: number): Promise<void> {
  await workbox.evaluate(
    ([cursorX, cursorY]) => {
      const cursor = document.getElementById("demo-cursor")!;
      cursor.style.display = "block";
      cursor.style.left = `${cursorX}px`;
      cursor.style.top = `${cursorY}px`;
    },
    [x, y],
  );
}

let lastCursorPos = { x: 0, y: 0 };

/** 커서 시작점 지정 — 장면 시작 시 중립 위치로 실제 마우스와 함께 맞춘다. */
export async function resetCursor(workbox: Page, pos: { x: number; y: number }): Promise<void> {
  await workbox.mouse.move(pos.x, pos.y);
  lastCursorPos = pos;
}

/** 실제 마우스와 오버레이를 함께 움직인다 — steps 를 쪼개 GIF 프레임에 이동 경로가 남게. */
async function moveWithCursor(
  workbox: Page,
  to: { x: number; y: number },
  steps: number,
  stepDelayMs = 25,
): Promise<void> {
  const from = lastCursorPos;
  for (let step = 1; step <= steps; step++) {
    const x = from.x + ((to.x - from.x) * step) / steps;
    const y = from.y + ((to.y - from.y) * step) / steps;
    await workbox.mouse.move(x, y);
    await setCursor(workbox, x, y);
    await sleep(stepDelayMs);
  }
  lastCursorPos = to;
}

async function centerOf(target: Locator): Promise<{ x: number; y: number }> {
  await target.waitFor({ state: "visible", timeout: 30_000 });
  const box = await target.boundingBox();
  if (box == null) throw new Error("target has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function glideTo(workbox: Page, target: Locator): Promise<{ x: number; y: number }> {
  const to = await centerOf(target);
  await moveWithCursor(workbox, to, 12);
  return to;
}

export async function clickWithCursor(workbox: Page, target: Locator): Promise<void> {
  await glideTo(workbox, target);
  await sleep(150);
  // locator 클릭 — 히트타겟 검증 포함 (가림·좌표 어긋남을 오류로 표면화)
  await target.click({ timeout: 5_000 });
}

/**
 * source 중심을 잡아 지정 지점으로 드래그 — 커서 오버레이 동반.
 * 실제 드래그는 down → 연속 move → up 을 끊김 없이 보낸다 (중간에 evaluate 를 끼우면
 * HTML5 드래그 스트림이 깨져 드롭이 무시되는 현상 관찰됨). 오버레이는 CSS transition 으로
 * 페이지 스스로 움직여 프레임에 이동 경로가 남는다.
 */
export async function dragWithCursor(
  workbox: Page,
  source: Locator,
  dropPoint: { x: number; y: number },
): Promise<void> {
  await glideTo(workbox, source);
  await sleep(150);
  const durationMs = 500;
  await workbox.evaluate(
    ([x, y, ms]) => {
      const cursor = document.getElementById("demo-cursor")!;
      cursor.style.transition = `left ${ms}ms linear, top ${ms}ms linear`;
      void cursor.offsetWidth; // 리플로우 — transition 적용 보장
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    },
    [dropPoint.x, dropPoint.y, durationMs],
  );
  await workbox.mouse.down();
  // 이동을 천천히 쪼갠다 — 프레임에 드래그 중간 상태(드롭 미리보기)가 남게.
  // 이동 중 evaluate 는 금지(오버레이는 CSS transition 으로 스스로 움직인다).
  const from = { ...lastCursorPos };
  const steps = 12;
  for (let step = 1; step <= steps; step++) {
    await workbox.mouse.move(
      from.x + ((dropPoint.x - from.x) * step) / steps,
      from.y + ((dropPoint.y - from.y) * step) / steps,
    );
    await sleep(durationMs / steps);
  }
  await workbox.mouse.move(dropPoint.x, dropPoint.y);
  await sleep(250);
  await workbox.mouse.up();
  await workbox.evaluate(() => {
    document.getElementById("demo-cursor")!.style.transition = "";
  });
  lastCursorPos = dropPoint;
}

/**
 * 화면 녹화 — CDP screencast(푸시형). 요청형 스크린샷(Page.captureScreenshot)을 주기 호출하면
 * HTML5 드래그의 드롭이 유실되는 간섭이 확인돼 푸시형을 쓴다. 프레임 파일명 = 수신 시각(ms) —
 * 합성 스크립트가 실제 간격을 duration 으로 쓴다. 프레임은 창 전체라 clip 은 clip.json 으로
 * 넘겨 합성 시 잘라낸다.
 */
export async function startRecorder(
  workbox: Page,
  clip: { x: number; y: number; width: number; height: number },
  framesDir: string,
): Promise<{ stop(): Promise<void> }> {
  fs.mkdirSync(framesDir, { recursive: true });
  const viewportWidth = await workbox.evaluate(() => window.innerWidth);
  fs.writeFileSync(path.join(framesDir, "clip.json"), JSON.stringify({ ...clip, viewportWidth }));

  const client = await workbox.context().newCDPSession(workbox);
  const pending: Promise<unknown>[] = [];
  client.on("Page.screencastFrame", (frameEvent: { data: string; sessionId: number }) => {
    fs.writeFileSync(
      path.join(framesDir, `${Date.now()}.png`),
      Buffer.from(frameEvent.data, "base64"),
    );
    pending.push(
      client
        .send("Page.screencastFrameAck", { sessionId: frameEvent.sessionId })
        .catch(() => undefined),
    );
  });
  await client.send("Page.startScreencast", { format: "png", everyNthFrame: 2 });
  return {
    stop: async () => {
      await client.send("Page.stopScreencast").catch(() => undefined);
      await Promise.all(pending);
      await client.detach().catch(() => undefined);
    },
  };
}
