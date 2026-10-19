import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  COPY_ROOT_NAME,
  CopyFolder,
  LEGACY_COPY_ROOT_NAME,
  WINDOWS_PATH_LIMIT,
  copyNameFits,
  fileNameSafe,
  fitCopyName,
  splitExtension,
} from "./default-app-copy.ts";
import { formatDateTimeIn } from "./time-text.ts";
import type { CopyNameParts } from "./default-app-copy.ts";

// 기본 앱으로 열 사본 (spec 「3. 열람」 기본 앱으로 열기) — 이름, 길이 상한, 읽기 전용, 겹치지 않는 이름,
// 지난 세션 정리.

const AT = new Date(2026, 9, 18, 14, 7, 7).getTime();

/** 표시 문구 — l10n 번들과 같은 꼴(영어 · 한국어, 직전). */
const englishMark = (stem: string) => `${stem} (before change at 10-18-2026, 4.12.47 PM)`;
const koreanMark = (stem: string) => `${stem} (2026. 10. 18. 오후 4.12.11 변경 직전)`;

const partsOf = (
  stem: string,
  ext: string,
  decorate: (stem: string) => string = englishMark,
): CopyNameParts => ({ stem, ext, decorate });

/** Windows 사본 폴더 흉내 — 전체 경로 = 이 폴더(12자) + "\" + 이름 → 이름은 205자까지. */
const WINDOWS_SESSION = "C:\\T\\slh\\1-a";
const windowsFits = copyNameFits("win32", WINDOWS_SESSION);
const windowsPathLength = (name: string) => WINDOWS_SESSION.length + 1 + name.length;

/** 끝에 짝 없는 서로게이트가 있는가 — 문자 중간에서 자른 흔적. */
const hasLoneSurrogate = (text: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

/** 테스트마다 따로인 임시 폴더. */
async function tempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "lh-copy-test-"));
}

test("시각 표기를 파일 이름에 쓸 수 있게 바꾼다 — 영어 · 한국어", () => {
  const english = fileNameSafe(formatDateTimeIn("en", AT));
  assert.match(english, /^10-18-2026, 2\.07\.07\sPM$/u);
  const korean = fileNameSafe(formatDateTimeIn("ko", AT));
  assert.equal(korean, "2026. 10. 18. 오후 2.07.07");
  // 날짜에 "/" 를 쓰는 언어
  assert.equal(fileNameSafe(formatDateTimeIn("ja", AT)), "2026-10-18 14.07.07");
  // 그 밖의 금지 문자
  assert.equal(fileNameSafe('a<b>c"d|e?f*g\\h\u0001'), "a_b_c_d_e_f_g-h_");
});

test("확장자를 가른다 — 점으로 시작하는 이름은 확장자가 없다", () => {
  assert.deepEqual(splitExtension("report.xlsx"), ["report", ".xlsx"]);
  assert.deepEqual(splitExtension("archive.tar.gz"), ["archive.tar", ".gz"]);
  assert.deepEqual(splitExtension(".gitignore"), [".gitignore", ""]);
  assert.deepEqual(splitExtension("Makefile"), ["Makefile", ""]);
  assert.deepEqual(splitExtension("보고서 50% & 최종 (v2), 사본.dat"), [
    "보고서 50% & 최종 (v2), 사본",
    ".dat",
  ]);
});

test("사본은 세션 폴더에 읽기 전용으로 쓰고, 같은 이름이 있으면 덮지 않고 번호를 붙인다", async () => {
  const temp = await tempDir();
  try {
    const copies = new CopyFolder({ tempDir: temp, pid: 4242, startedAt: 1000 });
    assert.equal(copies.sessionDir, path.join(temp, "slh", "4242-rs"));
    assert.equal(COPY_ROOT_NAME, "slh");
    const before = partsOf("a", ".txt", (stem) => `${stem} (before change at X)`);
    const first = await copies.write(before, Buffer.from("one"));
    assert.equal(first, path.join(copies.sessionDir, "a (before change at X).txt"));
    assert.equal(await fs.readFile(first, "utf8"), "one");
    assert.equal((await fs.stat(first)).mode & 0o222, 0); // 읽기 전용
    await assert.rejects(fs.writeFile(first, "changed")); // 다른 앱도 저장하지 못한다

    // 같은 변경을 다시 열기 — 앞 사본은 그대로
    const second = await copies.write(before, Buffer.from("two"));
    assert.equal(path.basename(second), "a (before change at X) (2).txt");
    assert.equal(await fs.readFile(first, "utf8"), "one");
    assert.equal(await fs.readFile(second, "utf8"), "two");

    // 직전 · 직후는 이름이 다르다
    const after = await copies.write(
      partsOf("a", ".txt", (stem) => `${stem} (after change at X)`),
      Buffer.from("three"),
    );
    assert.equal(path.basename(after), "a (after change at X).txt");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("다른 세션 폴더(예전 뿌리 포함)에 같은 이름이 있어도 피한다 — 같은 이름을 함께 열지 못하는 앱을 위해", async () => {
  const temp = await tempDir();
  try {
    const mark = (stem: string) => `${stem} (before change at X)`;
    const other = new CopyFolder({ tempDir: temp, pid: 1, startedAt: 1 });
    await other.write(partsOf("Report", ".xlsx", mark), Buffer.from("old"));
    // 예전 뿌리에 남은 사본 — 엑셀이 아직 잡고 있을 수 있다
    const legacySession = path.join(temp, LEGACY_COPY_ROOT_NAME, "3-x");
    await fs.mkdir(legacySession, { recursive: true });
    await fs.writeFile(path.join(legacySession, "Report (before change at X) (2).xlsx"), "older");
    const copies = new CopyFolder({ tempDir: temp, pid: 2, startedAt: 2 });
    // Linux 밖은 대소문자만 다른 이름도 같은 이름이다
    const stem = process.platform === "linux" ? "Report" : "report";
    const copy = await copies.write(partsOf(stem, ".xlsx", mark), Buffer.from("new"));
    assert.equal(path.basename(copy), `${stem} (before change at X) (3).xlsx`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Windows — 전체 경로 218자는 그대로, 219자부터 원래 이름의 줄기 끝을 잘라 … 로 바꾼다", () => {
  const ext = ".xlsx";
  const markLength = englishMark("").length;
  // 이름 205자 = 경로 218자가 되는 줄기 길이
  const fitting = "r".repeat(205 - markLength - ext.length);
  const exact = fitCopyName(partsOf(fitting, ext), 1, windowsFits);
  assert.equal(windowsPathLength(exact), WINDOWS_PATH_LIMIT);
  assert.equal(exact, englishMark(fitting) + ext);

  const over = fitCopyName(partsOf(`${fitting}s`, ext), 1, windowsFits);
  assert.equal(windowsPathLength(over), WINDOWS_PATH_LIMIT);
  // 표시 · 확장자는 그대로, 줄기는 앞부분 + …
  assert.equal(over, englishMark(`${fitting.slice(0, -1)}…`) + ext);
});

test("Windows — 번호가 붙어도 번호는 그대로 두고 줄기를 더 자른다", () => {
  const stem = "보고서 ".repeat(60);
  const second = fitCopyName(partsOf(stem, ".xlsx"), 2, windowsFits);
  assert.equal(windowsPathLength(second), WINDOWS_PATH_LIMIT);
  assert.match(second, /… \(before change at 10-18-2026, 4\.12\.47 PM\) \(2\)\.xlsx$/);
  const third = fitCopyName(partsOf(stem, ".xlsx"), 1000, windowsFits);
  assert.equal(windowsPathLength(third), WINDOWS_PATH_LIMIT);
  assert.ok(third.endsWith(" (1000).xlsx"));
  assert.ok(stem.startsWith(third.slice(0, third.indexOf("…"))));
});

test("Windows — 한국어 표시도 같은 규칙이다. 확장자가 없는 이름도 표시는 그대로다", () => {
  const stem = "가".repeat(200);
  const korean = fitCopyName(partsOf(stem, ".dat", koreanMark), 1, windowsFits);
  assert.equal(windowsPathLength(korean), WINDOWS_PATH_LIMIT);
  assert.ok(korean.endsWith("… (2026. 10. 18. 오후 4.12.11 변경 직전).dat"));
  const bare = fitCopyName(partsOf(stem, ""), 1, windowsFits);
  assert.equal(windowsPathLength(bare), WINDOWS_PATH_LIMIT);
  assert.ok(bare.endsWith("… (before change at 10-18-2026, 4.12.47 PM)"));
  // 점으로 시작하는 이름은 전부 줄기다
  const [dotStem, dotExt] = splitExtension(`.${"g".repeat(200)}`);
  const dotted = fitCopyName(partsOf(dotStem, dotExt), 1, windowsFits);
  assert.equal(windowsPathLength(dotted), WINDOWS_PATH_LIMIT);
  assert.ok(dotted.startsWith(".ggg"));
});

test("확장자만 길어 줄기를 다 잘라도 들어가지 않으면 가장 짧은 이름 — 표시 · 확장자는 자르지 않는다", () => {
  const ext = `.${"x".repeat(200)}`;
  const name = fitCopyName(partsOf("report", ext), 1, windowsFits);
  assert.equal(name, englishMark("…") + ext);
  assert.equal(windowsFits(name), false);
});

test("문자 중간(서로게이트 쌍 · 결합 문자 · 이모지 시퀀스)에서 자르지 않는다", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const graphemesOf = (text: string) =>
    Array.from(segmenter.segment(text), (piece) => piece.segment);
  for (const unit of ["😀", "e\u0301", "👨\u200d👩\u200d👧", "각"]) {
    const stem = unit.repeat(120);
    const name = fitCopyName(partsOf(stem, ".dat"), 1, windowsFits);
    assert.ok(windowsPathLength(name) <= WINDOWS_PATH_LIMIT);
    // 한 글자를 더 남기면 넘는다 — 들어가는 가장 긴 앞부분
    assert.ok(windowsPathLength(name) + unit.length > WINDOWS_PATH_LIMIT);
    const kept = name.slice(0, name.indexOf("…"));
    assert.equal(hasLoneSurrogate(kept), false, JSON.stringify(unit));
    assert.ok(
      graphemesOf(kept).every((piece) => piece === unit),
      JSON.stringify(unit),
    );
  }
});

test("macOS · Linux — 경로가 아니라 이름 하나가 255 바이트(UTF-8) 이하다", () => {
  const unixFits = copyNameFits("linux", `/tmp/${"deep/".repeat(100)}slh/1-a`);
  // 경로는 길어도 이름이 짧으면 그대로
  assert.equal(fitCopyName(partsOf("a", ".txt"), 1, unixFits), englishMark("a") + ".txt");
  const name = fitCopyName(partsOf("가".repeat(100), ".dat", koreanMark), 1, unixFits);
  const bytes = Buffer.byteLength(name, "utf8");
  assert.ok(bytes <= 255);
  assert.ok(bytes + 3 > 255); // 한글 한 글자(3바이트)를 더 남기면 넘는다
  assert.ok(name.endsWith("… (2026. 10. 18. 오후 4.12.11 변경 직전).dat"));
  assert.equal(copyNameFits("darwin", "/x")("a".repeat(256)), false);
});

test("사본 파일도 줄인 이름으로 만들어진다 — 이 OS 의 실제 경로", async () => {
  const temp = await tempDir();
  try {
    const copies = new CopyFolder({ tempDir: temp, pid: 7, startedAt: 7 });
    const copy = await copies.write(partsOf("긴 이름 ".repeat(80), ".dat"), Buffer.from("x"));
    assert.ok(copyNameFits(process.platform, copies.sessionDir)(path.basename(copy)));
    assert.ok(path.basename(copy).includes("… (before change at "));
    assert.equal(await fs.readFile(copy, "utf8"), "x");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("지난 세션의 사본만 지운다 — 살아 있는 다른 창과 이 세션은 남긴다", async () => {
  const temp = await tempDir();
  try {
    const alive = new Set([10, 30]);
    const session = (pid: number, startedAt: number) =>
      new CopyFolder({
        tempDir: temp,
        pid,
        startedAt,
        isAlive: (candidate) => alive.has(candidate),
      });
    const dead = session(20, 1); // 끝난 세션
    const live = session(10, 1); // 살아 있는 다른 창
    const reused = session(30, 1); // 같은 pid 를 다시 쓴 지난 세션
    const own = session(30, 2); // 이 세션
    for (const copies of [dead, live, reused, own]) {
      await copies.write(partsOf("a", ".txt"), Buffer.from("x"));
      await copies.write(partsOf("a", ".txt"), Buffer.from("y"));
    }
    // 이 확장이 만들지 않은 폴더는 건드리지 않는다
    const foreign = path.join(own.root, "not-a-session");
    await fs.mkdir(foreign);
    const warnings: string[] = [];
    const result = await own.removeStale((message) => warnings.push(message));
    assert.deepEqual(result, { removed: 4, held: 0 });
    assert.deepEqual(warnings, []);
    assert.deepEqual((await fs.readdir(own.root)).toSorted(), [
      path.basename(live.sessionDir),
      path.basename(own.sessionDir),
      "not-a-session",
    ]);
    assert.equal((await fs.readdir(own.sessionDir)).length, 2);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("예전 뿌리(simplysm-local-history)의 남은 사본도 같은 규칙으로 지우고, 비면 뿌리도 지운다", async () => {
  const temp = await tempDir();
  try {
    const alive = new Set([10]);
    const own = new CopyFolder({
      tempDir: temp,
      pid: 30,
      startedAt: 2,
      isAlive: (candidate) => alive.has(candidate),
    });
    const legacyRoot = path.join(temp, LEGACY_COPY_ROOT_NAME);
    const seed = async (session: string) => {
      await fs.mkdir(path.join(legacyRoot, session), { recursive: true });
      await fs.writeFile(path.join(legacyRoot, session, "a (before change at X).txt"), "x");
      await fs.chmod(path.join(legacyRoot, session, "a (before change at X).txt"), 0o444);
    };
    await seed("20-1"); // 끝난 세션
    await seed("10-1"); // 살아 있는 다른 창(예전 확장)
    assert.deepEqual(await own.removeStale(() => assert.fail()), { removed: 1, held: 0 });
    assert.deepEqual(await fs.readdir(legacyRoot), ["10-1"]);
    // 그 창도 끝나면 다음 기동에서 뿌리까지 지워진다
    alive.clear();
    assert.deepEqual(await own.removeStale(() => assert.fail()), { removed: 1, held: 0 });
    await assert.rejects(fs.stat(legacyRoot), { code: "ENOENT" });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("사본을 연 적이 없으면 정리할 것이 없다", async () => {
  const temp = await tempDir();
  try {
    const copies = new CopyFolder({ tempDir: temp, pid: 1, startedAt: 1 });
    assert.deepEqual(await copies.removeStale(() => assert.fail()), { removed: 0, held: 0 });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
