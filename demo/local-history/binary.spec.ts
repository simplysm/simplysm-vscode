// 과거 내용 바이트 공급 시연 — 이진·이미지·비 UTF-8 텍스트·대용량 파일의 과거 쪽을 VS Code 가 현재 파일처럼 다룬다.
// (spec 「3. 열람」 과거 내용 공급)
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  launchVsCode,
  retryAction,
  runCommand,
  runResultsDir,
  test,
  workspaceDir,
} from "../fixtures.ts";
import { historyPaneOf, prepareRecording, showHistoryViaContextMenu } from "./history-utils.ts";

const shotDir = path.join(runResultsDir, "local-history");
const MB = 1024 * 1024;

/** VS Code 이진 안내 — 텍스트 에디터 대신 뜨는 자리 표시. */
const binaryNotice = /binary or uses an unsupported text encoding/;

/** 단색 PNG — 이미지 나란히 보기 시연용 (8x8, RGB). */
function solidPng(rgb: readonly [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const size = 8;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8bit, RGB, 기본 압축·필터·비인터레이스
  const row = Buffer.from([0, ...Array.from({ length: size }, () => rgb).flat()]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** NUL 바이트가 든 이진 내용 — `marker` 로 버전을 가른다. */
function binaryContent(marker: string, size = 256): Buffer {
  const content = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset++) content[offset] = (offset * 7) % 256;
  content.write(marker, 1, "latin1");
  return content;
}

/** 10MB 를 넘는 텍스트 — `version` 줄만 다르다. */
function largeText(version: string): string {
  const lines = [`version ${version}`];
  for (let index = 0; lines.length * 64 < 11 * MB; index++) {
    lines.push(`line ${String(index).padStart(8, "0")} ${"x".repeat(48)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 파일을 만들고 버전을 차례로 쓴 뒤, 그 파일의 Show History 를 연다 — 버전마다 별도 줄로 기록되길 기다린다.
 * 반환 시 목록 = [마지막 버전, …, 첫 버전] (최신순).
 */
async function recordVersions(
  workbox: Page,
  fileName: string,
  versions: readonly (string | Buffer)[],
): Promise<Locator> {
  const filePath = path.join(workspaceDir, fileName);
  fs.writeFileSync(filePath, versions[0]);
  const explorerItem = workbox.getByRole("treeitem", { name: fileName, exact: true });
  await explorerItem.waitFor({ state: "visible", timeout: 30_000 });
  await showHistoryViaContextMenu(workbox, explorerItem, fileName);
  const rows = historyPaneOf(workbox).getByRole("treeitem");
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  for (let index = 1; index < versions.length; index++) {
    fs.writeFileSync(filePath, versions[index]);
    await expect(rows).toHaveCount(index + 1, { timeout: 30_000 });
  }
  return rows;
}

/** 에디터 영역의 활성 탭 제목이 `fileName` 을 포함할 때까지. */
function activeTabOf(workbox: Page, fileName: string): Locator {
  return workbox.locator(".tab.active", { hasText: fileName });
}

/**
 * 에디터가 멈추지 않았는지 — 렌더러 응답(팜레트 열기)과 확장 호스트 응답(다른 줄의 diff 열기)을 본다.
 * 반환 = 각 조작의 응답 시간(ms).
 */
async function assertResponsive(
  workbox: Page,
  rows: Locator,
  otherRowIndex: number,
): Promise<{ paletteMs: number; switchMs: number }> {
  let started = Date.now();
  await workbox
    .locator(".agent-status-input-area:visible, .command-center-quick-pick:visible")
    .first()
    .click({ timeout: 5_000 });
  await workbox.locator(".quick-input-widget input").waitFor({ state: "visible", timeout: 5_000 });
  const paletteMs = Date.now() - started;
  await workbox.locator(".quick-input-widget input").press("Escape");
  await expect(workbox.locator(".quick-input-widget")).toBeHidden({ timeout: 5_000 });

  // 다른 줄의 diff — 탭 제목이 그 줄의 시각으로 바뀌면 확장 호스트도 응답한 것이다
  const otherLabel = (await rows.nth(otherRowIndex).innerText()).trim();
  started = Date.now();
  await rows.nth(otherRowIndex).click({ timeout: 5_000 });
  await expect(workbox.locator(".tab.active")).toContainText(otherLabel, { timeout: 10_000 });
  const switchMs = Date.now() - started;
  return { paletteMs, switchMs };
}

test("이진·이미지·대용량 파일의 과거 쪽을 VS Code 가 현재 파일처럼 다룬다", async ({
  vscodeExePath,
}, testInfo) => {
  test.setTimeout(600_000);
  const warmupName = "local-history-binary-warmup.txt";
  const binaryName = "local-history-binary.bin";
  const imageName = "local-history-image.png";
  const largeBinaryName = "local-history-large.bin";
  const largeTextName = "local-history-large.txt";
  const created = [warmupName, binaryName, imageName, largeBinaryName, largeTextName].map((name) =>
    path.join(workspaceDir, name),
  );
  // 웜업 파일은 기동 전에 만든다 — 기동 뒤에 만들면 탐색기 표시가 파일 워처 기동에 달린다
  fs.writeFileSync(created[0], "initial\n");
  const app = await launchVsCode(vscodeExePath, {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  });
  try {
    const workbox = await app.firstWindow();
    await prepareRecording(workbox, warmupName, created[0]);

    // ── 이진 파일: 범위(끝 ↔ 시작 직전) — 양쪽 모두 과거 내용(provider) → 양쪽 이진 안내
    const binaryRows = await recordVersions(workbox, binaryName, [
      binaryContent("VERSION-ONE"),
      binaryContent("VERSION-TWO"),
      binaryContent("VERSION-THREE"),
    ]);
    const editorArea = workbox.locator(".part.editor");
    await retryAction(
      async () => {
        await binaryRows.nth(0).click();
        await binaryRows.nth(1).click({ modifiers: ["Shift"] });
      },
      async () => {
        await expect(activeTabOf(workbox, binaryName)).toBeVisible({ timeout: 5_000 });
        await expect(editorArea.getByText(binaryNotice)).toHaveCount(2, { timeout: 5_000 });
      },
    );
    // 깨진 글자 없음 — 텍스트 diff 에디터가 뜨지 않고, 마커 문자열이 보이지 않는다
    await expect(editorArea.locator(".monaco-diff-editor:visible")).toHaveCount(0);
    await expect(editorArea.getByText(/VERSION-/)).toHaveCount(0);
    await workbox.screenshot({ path: path.join(shotDir, "binary-diff.png") });

    // ── PNG: 범위(끝 ↔ 시작 직전) — 양쪽 모두 과거 내용(provider) → 이미지 나란히 보기
    const imageRows = await recordVersions(workbox, imageName, [
      solidPng([220, 40, 40]),
      solidPng([40, 80, 220]),
      solidPng([40, 200, 40]),
    ]);
    // webview 는 에디터 영역 밖의 겹침 컨테이너에 붙는다 — 문서 전체에서 찾는다
    const imageFrames = workbox.locator("iframe.webview.ready");
    await retryAction(
      async () => {
        await imageRows.nth(0).click();
        await imageRows.nth(1).click({ modifiers: ["Shift"] });
      },
      async () => {
        await expect(activeTabOf(workbox, imageName)).toBeVisible({ timeout: 5_000 });
        await expect(imageFrames).toHaveCount(2, { timeout: 10_000 });
      },
    );
    // 두 webview(좌·우 이미지 미리보기) 모두 과거 내용 uri 의 이미지(8x8)를 읽어 그린다
    for (let index = 0; index < 2; index++) {
      const image = workbox
        .frameLocator(`iframe.webview.ready >> nth=${index}`)
        .frameLocator("iframe#active-frame")
        .locator("img");
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
          timeout: 15_000,
        })
        .toBe(8);
      await expect(image).toHaveAttribute("src", /simplysm-local-history/);
    }
    await expect(editorArea.getByText(binaryNotice)).toHaveCount(0);
    await workbox.screenshot({ path: path.join(shotDir, "image-diff.png") });

    // ── 10MB 초과 이진: 맨 위 줄(ONE → TWO)의 직전 ↔ 직후 diff 가 양쪽 이진 안내로 열리고, 다른 조작이 응답한다
    const largeBinaryRows = await recordVersions(workbox, largeBinaryName, [
      binaryContent("LARGE-ONE", 11 * MB),
      binaryContent("LARGE-TWO", 11 * MB),
    ]);
    await retryAction(
      async () => {
        await largeBinaryRows.nth(0).click();
      },
      async () => {
        await expect(activeTabOf(workbox, largeBinaryName)).toBeVisible({ timeout: 10_000 });
        await expect(editorArea.getByText(binaryNotice)).toHaveCount(2, { timeout: 10_000 });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "large-binary-diff.png") });
    const largeBinaryTimes = await assertResponsive(workbox, largeBinaryRows, 1);
    console.log(`[binary.spec] 10MB 초과 이진 — 응답 ms: ${JSON.stringify(largeBinaryTimes)}`);

    // ── 10MB 초과 텍스트: 맨 위 줄(one → two)의 직전 ↔ 직후 텍스트 diff 가 열리고, 다른 조작이 응답한다
    const largeTextRows = await recordVersions(workbox, largeTextName, [
      largeText("one"),
      largeText("two"),
    ]);
    const original = workbox.locator(
      ".monaco-diff-editor .editor.original .view-lines:not([monaco-view-zone])",
    );
    const modified = workbox.locator(
      ".monaco-diff-editor .editor.modified .view-lines:not([monaco-view-zone])",
    );
    await retryAction(
      async () => {
        await largeTextRows.nth(0).click();
      },
      async () => {
        await expect(original).toContainText("version one", { timeout: 15_000 });
        await expect(modified).toContainText("version two", { timeout: 15_000 });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "large-text-diff.png") });
    const largeTextTimes = await assertResponsive(workbox, largeTextRows, 1);
    console.log(`[binary.spec] 10MB 초과 텍스트 — 응답 ms: ${JSON.stringify(largeTextTimes)}`);
  } finally {
    await app.close();
    for (const filePath of created) fs.rmSync(filePath, { force: true });
  }
});

test("과거 내용 diff 탭을 연 채 다시 띄우면 복원된 탭이 과거 내용을 보인다", async ({
  vscodeExePath,
}, testInfo) => {
  test.setTimeout(300_000);
  const warmupName = "local-history-reopen-warmup.txt";
  const textName = "local-history-reopen.txt";
  const imageName = "local-history-reopen.png";
  const created = [warmupName, textName, imageName].map((name) => path.join(workspaceDir, name));
  const dirs = {
    extensionsDir: testInfo.outputPath("extensions"),
    userDataDir: testInfo.outputPath("user-data"),
  };
  /**
   * diff 의 직전 쪽에 그린 "past one" — 자리가 diff 배치를 탄다. 좌우 배치면 왼쪽 에디터 본문, 한 칸(inline)
   * 배치면 오른쪽 에디터에 끼워 넣은 지워진 줄(.line-delete)이다. VS Code 는 diff 폭이 좁으면 한 칸으로 바꾼다 —
   * 에디터 영역의 폭은 사용자 외관 설정(보조 사이드바 표시 등)을 타므로 배치에 기대지 않는다.
   * 보임이 아니라 DOM 에 있는지로 본다: 좌우에서 한 칸으로 바뀐 직후 VS Code 는 1번 줄을 제자리에 두려고
   * 그 위의 지워진 줄을 화면 위로 밀어 둔다(위로 스크롤하면 보인다. 일반 파일 두 개의 diff 도 같다).
   */
  const pastText = (workbox: Page) =>
    workbox
      .locator(
        ".monaco-diff-editor .editor.original .view-lines:not([monaco-view-zone]), " +
          ".monaco-diff-editor .editor.modified .line-delete",
      )
      .filter({ hasText: "past one" })
      .first();
  /** 두 webview(좌·우 이미지 미리보기)가 모두 과거 내용 uri 의 이미지(8x8)를 그렸는지. */
  const expectPastImages = async (workbox: Page, timeout: number) => {
    for (let index = 0; index < 2; index++) {
      const image = workbox
        .frameLocator(`iframe.webview.ready >> nth=${index}`)
        .frameLocator("iframe#active-frame")
        .locator("img");
      await expect(image).toHaveAttribute("src", /simplysm-local-history/, { timeout });
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth), {
          timeout,
        })
        .toBe(8);
    }
  };
  fs.writeFileSync(created[0], "initial\n");
  let app = await launchVsCode(vscodeExePath, dirs);
  try {
    let workbox = await app.firstWindow();
    await prepareRecording(workbox, warmupName, created[0]);

    // 텍스트: 맨 위 줄 — 좌(직전) "past one" ↔ 우(직후) "past two". 미리보기 탭이 다음 diff 에 밀리지 않게 고정한다
    const textRows = await recordVersions(workbox, textName, ["past one\n", "past two\n"]);
    await retryAction(
      async () => {
        await textRows.nth(0).click();
      },
      async () => {
        await expect(pastText(workbox)).toBeAttached({ timeout: 5_000 });
      },
    );
    await runCommand(workbox, "View: Keep Editor");

    // 이미지: 범위 — 양쪽 모두 과거 내용. 다음 그룹으로 옮겨 두 diff 가 복원 직후 함께 보이게 한다
    const imageRows = await recordVersions(workbox, imageName, [
      solidPng([220, 40, 40]),
      solidPng([40, 80, 220]),
      solidPng([40, 200, 40]),
    ]);
    await retryAction(
      async () => {
        await imageRows.nth(0).click();
        await imageRows.nth(1).click({ modifiers: ["Shift"] });
      },
      async () => {
        await expect(activeTabOf(workbox, imageName)).toBeVisible({ timeout: 5_000 });
      },
    );
    await expectPastImages(workbox, 15_000);
    await runCommand(workbox, "View: Keep Editor");
    await runCommand(workbox, "View: Move Editor into Next Group");
    await expect(workbox.locator(".part.editor .editor-group-container")).toHaveCount(2);
    await expectPastImages(workbox, 15_000);
    await expect(pastText(workbox)).toBeAttached();
    await workbox.screenshot({ path: path.join(shotDir, "reopen-before.png") });

    // 같은 user-data 로 재기동 — VS Code 가 두 diff 탭을 복원한다
    await app.close();
    app = await launchVsCode(vscodeExePath, dirs);
    workbox = await app.firstWindow();
    await expect(workbox.locator(".part.editor .editor-group-container")).toHaveCount(2, {
      timeout: 30_000,
    });
    try {
      await expect(pastText(workbox)).toBeAttached({ timeout: 30_000 });
      await expectPastImages(workbox, 30_000);
    } finally {
      await workbox.screenshot({ path: path.join(shotDir, "reopen-after.png") });
    }
    await expect(
      workbox.locator(".part.editor").getByText(/could not be opened|Unable to resolve/i),
    ).toHaveCount(0);
  } finally {
    await app.close();
    for (const filePath of created) fs.rmSync(filePath, { force: true });
  }
});

test("files.encoding 이 euckr 이면 EUC-KR 텍스트의 과거 쪽이 한글로 보인다", async ({
  vscodeExePath,
}, testInfo) => {
  const fileName = "local-history-euckr.txt";
  const filePath = path.join(workspaceDir, fileName);
  // "첫 번째 한글" / "두 번째 한글" 의 EUC-KR 바이트 (UTF-8 로 읽으면 깨진다)
  const firstEucKr = Buffer.from("c3b920b9f8c2b020c7d1b1db0a", "hex");
  const secondEucKr = Buffer.from("b5ce20b9f8c2b020c7d1b1db0a", "hex");
  fs.writeFileSync(filePath, "initial\n");
  const app = await launchVsCode(
    vscodeExePath,
    {
      extensionsDir: testInfo.outputPath("extensions"),
      userDataDir: testInfo.outputPath("user-data"),
    },
    { settings: { "files.encoding": "euckr" } },
  );
  try {
    const workbox = await app.firstWindow();
    const baseline = await prepareRecording(workbox, fileName, filePath);
    const rows = historyPaneOf(workbox).getByRole("treeitem");
    fs.writeFileSync(filePath, firstEucKr);
    await expect(rows).toHaveCount(baseline + 1, { timeout: 15_000 });
    fs.writeFileSync(filePath, secondEucKr);
    await expect(rows).toHaveCount(baseline + 2, { timeout: 15_000 });

    // 맨 위 줄(첫 번째 → 두 번째) → 좌(직전) "첫 번째 한글" / 우(직후) "두 번째 한글" — 양쪽 모두 provider
    const original = workbox.locator(
      ".monaco-diff-editor .editor.original .view-lines:not([monaco-view-zone])",
    );
    const modified = workbox.locator(
      ".monaco-diff-editor .editor.modified .view-lines:not([monaco-view-zone])",
    );
    await retryAction(
      async () => {
        await rows.nth(0).click();
      },
      async () => {
        await expect(original).toContainText("첫 번째 한글", { timeout: 5_000 });
        await expect(modified).toContainText("두 번째 한글", { timeout: 5_000 });
      },
    );
    await workbox.screenshot({ path: path.join(shotDir, "euckr-diff.png") });
  } finally {
    await app.close();
    fs.rmSync(filePath, { force: true });
  }
});
