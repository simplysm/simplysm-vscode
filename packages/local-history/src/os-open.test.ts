import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OPEN_PATH_ENV, OsOpenError, openInOs, osOpenCommand } from "./os-open.ts";

// OS 기본 앱으로 열기 (plan 「설계 결정」) — 열기 명령에 URL 이 아니라 경로를 그대로 넘긴다.

const tricky = String.raw`C:\Temp\simplysm-local-history\1-a\보고서 50% & 최종 (v2), 사본 (2026. 10. 18. 오후 2.07.07 변경 직전).dat`;

test("Windows — PowerShell Invoke-Item -LiteralPath 가 환경 변수의 경로를 연다(명령줄에 경로가 없다)", () => {
  const command = osOpenCommand(tricky, "win32", { Path: "C:\\Windows" });
  assert.equal(command.command, "powershell.exe");
  assert.equal(command.env[OPEN_PATH_ENV], tricky);
  assert.equal(command.env["Path"], "C:\\Windows");
  assert.ok(command.args.every((arg) => !arg.includes("보고서")));
  const encoded = command.args[command.args.indexOf("-EncodedCommand") + 1];
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(
    script,
    new RegExp(`Invoke-Item -LiteralPath \\$env:${OPEN_PATH_ENV} -ErrorAction Stop`),
  );
  assert.match(script, /exit 1/);
});

test("macOS · Linux — open · xdg-open 에 경로를 인자 하나로 넘긴다", () => {
  const unixPath = "/tmp/simplysm-local-history/1-a/보고서 50% & 최종 (v2), 사본.dat";
  assert.deepEqual(osOpenCommand(unixPath, "darwin", {}), {
    command: "open",
    args: [unixPath],
    env: {},
  });
  assert.deepEqual(osOpenCommand(unixPath, "linux", {}), {
    command: "xdg-open",
    args: [unixPath],
    env: {},
  });
});

test(
  "Windows — 열기가 실패하면 원인을 읽을 수 있는 글로 알린다(없는 파일 — 아무 앱도 뜨지 않는다)",
  { skip: process.platform !== "win32" },
  async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lh-open-test-"));
    try {
      const missing = path.join(temp, "없는 파일 50% & (x), y.dat");
      const error = await openInOs(missing).then(
        () => assert.fail("열리면 안 된다"),
        (reason: unknown) => reason,
      );
      assert.ok(error instanceof OsOpenError);
      assert.ok(error.message.length > 0);
      assert.ok(!error.message.includes("\uFFFD"), `깨진 글자: ${error.message}`);
      assert.ok(!error.message.includes("CLIXML"), `진행 표시가 섞임: ${error.message}`);
      assert.ok(error.message.includes(missing), `원인에 열려던 경로가 있다: ${error.message}`);
      console.log(`실패 원인: ${error.message}`);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  },
);

test("열기 명령을 실행하지 못하면(파일의 폴더가 없다) 그 오류로 실패한다 — 처리되지 않은 예외가 없다", async () => {
  const missingDir = path.join(os.tmpdir(), `lh-open-missing-${Date.now()}`, "a.dat");
  await assert.rejects(openInOs(missingDir));
});
