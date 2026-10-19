import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { isProcessAlive } from "./process-alive.ts";

// 기본 앱으로 열 사본 (spec 「3. 열람」 기본 앱으로 열기) — OS 임시 폴더 아래 확장 전용 폴더에 읽기 전용으로 쓴다.
// vscode 에 의존하지 않아 단위 테스트한다. 사본 이름의 문구(시각 · 직전 · 직후 표시)는 부르는 쪽이 준다.
//
// 구조: <임시 폴더>/slh/<세션>/<사본>. 세션 = 확장 호스트 하나의 수명(`<pid>-<기동 시각>`).
// 뿌리 이름이 짧은 이유: 경로가 길수록 원래 이름을 덜 자른다(아래 사본 이름의 길이 상한).
// 같은 PC 의 다른 창(확장 호스트)도 같은 뿌리를 쓴다. 정리는 끝난 세션의 폴더만 지운다 — 살아 있는 다른 창이
// 열어 둔 사본은 그 창의 세션이 끝난 뒤 기동에서 지워진다.

/** 사본 폴더의 뿌리 이름 — OS 임시 폴더 바로 아래. */
export const COPY_ROOT_NAME = "slh";

/** 예전 뿌리 이름 — 기동 정리가 남은 사본을 지우고, 비면 뿌리도 지운다. 새 사본은 쓰지 않는다. */
export const LEGACY_COPY_ROOT_NAME = "simplysm-local-history";

/**
 * Windows: 사본의 전체 경로 길이 상한(UTF-16 단위) — Excel 이 여는 경로의 상한(spec 「3. 열람」).
 * Windows 자체는 260자를 넘는 경로를 기본 앱으로 열지 못한다(실측).
 */
export const WINDOWS_PATH_LIMIT = 218;

/** macOS · Linux: 파일 이름 하나의 상한(UTF-8 바이트, NAME_MAX). */
export const NAME_BYTES_LIMIT = 255;

/** 자른 자리의 표시. */
const ELLIPSIS = "…";

/** 글자 단위(서로게이트 쌍 · 결합 문자 · 이모지 시퀀스를 나누지 않는다)로 자른다. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 같은 줄기의 사본을 몇 개까지 만드는가 — " (2)" … " (1000)". */
const MAX_COPY_NUMBER = 1000;

/** 세션 폴더 이름 — `<pid>-<기동 시각(36진수)>`. */
const sessionNamePattern = /^(\d+)-[0-9a-z]+$/;

/** 파일 이름에 쓸 수 없는 문자의 대체 — 시각 표기의 ":"(시:분:초)는 ".", "/"(날짜)는 "-". */
const unsafeReplacements: Readonly<Record<string, string>> = { ":": ".", "/": "-", "\\": "-" };

/**
 * 파일 이름에 쓸 수 있게 바꾼다 — Windows 기준(가장 엄격)을 모든 OS 에 같게 적용한다.
 * ":" "/" "\" 는 시각이 읽히도록 "-" "." 로, 그 밖의 금지 문자(`<>"|?*`, 제어 문자)는 "_" 로 바꾼다.
 */
export function fileNameSafe(text: string): string {
  let result = "";
  for (const char of text) {
    const replacement = unsafeReplacements[char];
    if (replacement !== undefined) result += replacement;
    else if ('<>"|?*'.includes(char) || char.charCodeAt(0) < 0x20) result += "_";
    else result += char;
  }
  return result;
}

/**
 * 원래 이름 → [줄기, 확장자]. 확장자는 OS 가 연결 앱을 고르는 기준이라 사본에 그대로 둔다.
 * 점으로 시작하는 이름(".gitignore")은 확장자가 없다.
 */
export function splitExtension(name: string): [string, string] {
  const ext = path.posix.extname(name);
  return [name.slice(0, name.length - ext.length), ext];
}

/**
 * 사본 이름의 재료 — 원래 이름의 줄기 · 확장자와, 줄기에 시각 · 직전 · 직후 표시를 붙이는 함수(표시 문구는 부르는 쪽이 준다).
 * 이름이 길면 줄기만 자른다 — 표시 · 확장자 · 겹침 번호는 그대로다.
 */
export interface CopyNameParts {
  readonly stem: string;
  readonly ext: string;
  readonly decorate: (stem: string) => string;
}

/**
 * 사본 이름이 길이 상한 안에 드는가 (spec 「3. 열람」) — Windows 는 `sessionDir` 아래 전체 경로가 218자 이하,
 * macOS · Linux 는 이름이 255 바이트(UTF-8) 이하.
 */
export function copyNameFits(
  platform: NodeJS.Platform,
  sessionDir: string,
): (name: string) => boolean {
  return platform === "win32"
    ? (name) => path.win32.join(sessionDir, name).length <= WINDOWS_PATH_LIMIT
    : (name) => Buffer.byteLength(name, "utf8") <= NAME_BYTES_LIMIT;
}

/**
 * 사본 이름 하나 — `표시(줄기)` + (2번부터 ` (번호)`) + 확장자. 들어가지 않으면 줄기의 끝을 글자 단위로 잘라
 * "…" 로 바꾼다. 들어가는 가장 긴 앞부분을 남긴다.
 * 줄기를 다 잘라도("…" 만) 들어가지 않으면(확장자가 아주 길다) 그 가장 짧은 이름을 돌려준다 —
 * 표시 · 확장자는 자르지 않는다. 그 사본은 쓰기나 열기에서 실패해 오류 알림이 된다.
 */
export function fitCopyName(
  parts: CopyNameParts,
  number: number,
  fits: (name: string) => boolean,
): string {
  const suffix = number === 1 ? "" : ` (${number})`;
  const build = (stem: string) => `${parts.decorate(stem)}${suffix}${parts.ext}`;
  const whole = build(parts.stem);
  if (fits(whole)) return whole;
  const pieces = Array.from(graphemes.segment(parts.stem), (piece) => piece.segment);
  for (let kept = pieces.length - 1; kept > 0; kept--) {
    const name = build(pieces.slice(0, kept).join("") + ELLIPSIS);
    if (fits(name)) return name;
  }
  return build(ELLIPSIS);
}

/** 다른 프로세스가 파일을 잡고 있어서 지우지 못했다 — 다음 기동에 다시 지운다. */
function isHeld(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** 폴더 항목 — 폴더가 없으면(사본을 연 적이 없거나 다른 창이 먼저 지웠다) 빈 목록. */
async function readDirIfExists(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

/** 비었으면 폴더를 지운다 — 남긴 사본이 있거나(ENOTEMPTY) 없거나(ENOENT) 잡혀 있으면 그대로 둔다. */
async function removeDirIfEmpty(dir: string, warn: (message: string) => void): Promise<void> {
  try {
    await fs.rmdir(dir);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT" && !isHeld(error)) {
      warn(`copy cleanup: cannot remove ${dir}: ${String(error)}`);
    }
  }
}

/** 지난 세션 정리의 결과 — 로그용. */
export interface CleanupResult {
  readonly removed: number;
  /** 다른 프로세스가 잡고 있어 남긴 사본 수. */
  readonly held: number;
}

export interface CopyFolderOptions {
  /** OS 임시 폴더. */
  readonly tempDir: string;
  readonly pid: number;
  /** 이 세션의 기동 시각(ms) — 같은 pid 를 다시 쓴 지난 세션과 가른다. */
  readonly startedAt: number;
  /** pid 생존 확인 — 테스트가 바꾼다. */
  readonly isAlive?: (pid: number) => boolean;
  /** 이름 규칙을 고를 OS(길이 상한 · 대소문자) — 테스트가 바꾼다. 기본은 이 OS. */
  readonly platform?: NodeJS.Platform;
}

/** 이 세션의 사본 폴더 — 사본 쓰기와 지난 세션의 사본 정리. */
export class CopyFolder {
  readonly root: string;
  readonly sessionDir: string;
  /** 예전 뿌리 — 정리만 한다. */
  readonly legacyRoot: string;
  private readonly sessionName: string;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly platform: NodeJS.Platform;

  constructor(options: CopyFolderOptions) {
    this.root = path.join(options.tempDir, COPY_ROOT_NAME);
    this.legacyRoot = path.join(options.tempDir, LEGACY_COPY_ROOT_NAME);
    this.sessionName = `${options.pid}-${options.startedAt.toString(36)}`;
    this.sessionDir = path.join(this.root, this.sessionName);
    this.pid = options.pid;
    this.isAlive = options.isAlive ?? isProcessAlive;
    this.platform = options.platform ?? process.platform;
  }

  /** 같은 이름인가를 가르는 열쇠 — Linux 밖(Windows · macOS 기본 파일 시스템)은 대소문자를 가르지 않는다. */
  private nameKey(name: string): string {
    return this.platform === "linux" ? name : name.toLowerCase();
  }

  /**
   * 사본을 쓴다 — 이름은 `fitCopyName`(길면 원래 이름의 줄기를 자른다). 같은 이름이 있으면 " (2)" 부터 붙여
   * 겹치지 않게 한다. 반환 = 사본 경로.
   * - 있는 파일을 덮지 않는다(배타 생성) — 이미 열린 사본은 외부 앱이 잡고 있을 수 있다.
   * - 다른 세션 폴더의 이름도 피한다 — 같은 이름의 파일을 동시에 열지 못하는 앱(예: 엑셀)은 폴더가 달라도
   *   같은 이름이면 함께 열지 못한다(spec 「3. 열람」 사본 이름의 근거).
   * - 다 쓴 뒤 읽기 전용으로 바꾼다 — 외부 앱이 사본의 저장을 막는다.
   */
  async write(parts: CopyNameParts, content: Uint8Array): Promise<string> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    const taken = await this.takenNames();
    const fits = copyNameFits(this.platform, this.sessionDir);
    for (let number = 1; number <= MAX_COPY_NUMBER; number++) {
      const name = fitCopyName(parts, number, fits);
      if (taken.has(this.nameKey(name))) continue;
      const copyPath = path.join(this.sessionDir, name);
      try {
        await fs.writeFile(copyPath, content, { flag: "wx" });
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue; // 그 사이 같은 이름이 생겼다
        await fs.rm(copyPath, { force: true }); // 쓰다 실패한 파일을 남기지 않는다
        throw error;
      }
      try {
        await fs.chmod(copyPath, 0o444);
      } catch (error) {
        await fs.rm(copyPath, { force: true }); // 읽기 전용이 아닌 사본은 열지 않는다
        throw error;
      }
      return copyPath;
    }
    throw new Error(`No free name for the copy of ${parts.stem}${parts.ext}`);
  }

  /**
   * 두 뿌리(지금 · 예전) 아래 모든 세션 폴더에 있는 이름 — 예전 뿌리의 사본도 엑셀이 아직 잡고 있을 수 있다.
   * 뿌리가 없거나 읽는 사이 지워지는 폴더(다른 창의 정리)는 건너뛴다.
   */
  private async takenNames(): Promise<Set<string>> {
    const taken = new Set<string>();
    for (const root of [this.root, this.legacyRoot]) {
      for (const session of await readDirIfExists(root)) {
        if (!session.isDirectory()) continue;
        for (const entry of await readDirIfExists(path.join(root, session.name))) {
          taken.add(this.nameKey(entry.name));
        }
      }
    }
    return taken;
  }

  /** 지난 세션인가 — 소유 프로세스가 끝났다. 같은 pid 의 다른 세션은 pid 를 다시 쓴 지난 세션이다. */
  private isStale(sessionName: string): boolean {
    const match = sessionNamePattern.exec(sessionName);
    if (match === null || sessionName === this.sessionName) return false; // 이 확장이 만든 폴더가 아니거나 이 세션
    const pid = Number(match[1]);
    return pid === this.pid || !this.isAlive(pid);
  }

  /**
   * 지난 세션의 사본을 지운다 — 기동 때 백그라운드로 부른다 (spec 「3. 열람」 남은 사본은 확장이 정리한다).
   * 예전 뿌리(`simplysm-local-history`)의 세션도 같은 규칙으로 지우고, 비면 그 뿌리도 지운다.
   * 외부 앱이 아직 잡고 있는 사본(EBUSY · EPERM · EACCES)은 남긴다. 그 세션 폴더도 비지 않아 남고,
   * 다음 기동이 다시 지운다. 그 밖의 실패는 `warn` 으로 알리고 다음 것을 이어 간다.
   */
  async removeStale(warn: (message: string) => void): Promise<CleanupResult> {
    const current = await this.removeStaleIn(this.root, warn);
    const legacy = await this.removeStaleIn(this.legacyRoot, warn);
    await removeDirIfEmpty(this.legacyRoot, warn);
    return { removed: current.removed + legacy.removed, held: current.held + legacy.held };
  }

  /** 한 뿌리 아래 지난 세션의 사본을 지운다. */
  private async removeStaleIn(
    root: string,
    warn: (message: string) => void,
  ): Promise<CleanupResult> {
    let removed = 0;
    let held = 0;
    for (const session of await readDirIfExists(root)) {
      if (!session.isDirectory() || !this.isStale(session.name)) continue;
      const sessionDir = path.join(root, session.name);
      let names: string[];
      try {
        names = await fs.readdir(sessionDir);
      } catch (error) {
        if (errorCode(error) !== "ENOENT")
          warn(`copy cleanup: cannot read ${sessionDir}: ${String(error)}`);
        continue;
      }
      for (const name of names) {
        const copyPath = path.join(sessionDir, name);
        try {
          // 읽기 전용이어도 지워진다(Windows 는 libuv 가 읽기 전용 속성을 풀고 지운다)
          await fs.rm(copyPath, { force: true });
          removed++;
        } catch (error) {
          if (isHeld(error)) held++;
          else warn(`copy cleanup: cannot remove ${copyPath}: ${String(error)}`);
        }
      }
      await removeDirIfEmpty(sessionDir, warn);
    }
    return { removed, held };
  }
}
