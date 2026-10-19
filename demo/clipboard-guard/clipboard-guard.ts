// 시연 하네스의 클립보드 보존 — 시연이 사용자의 OS 클립보드를 덮어쓴 채 끝나지 않게, 시연 전 클립보드의
// 모든 형식을 꺼내 두었다가 시연이 클립보드를 바꾸면 시연 뒤에 되돌린다 (2026-10-19 사용자 확정).
// - 대상은 텍스트만이 아니라 클립보드에 든 모든 형식(이미지 · 파일 목록 등)이다.
// - 되돌리지 못한 형식이 있어도 시연을 실패로 끝내지 않는다. 어떤 형식을 되돌리지 못했는지 시연 출력에 적는다.
//   클립보드를 꺼내거나 되돌리는 일 자체가 실패해도 같다 — 시연 출력에 적고 시연은 그대로 판정한다.
// - 시연 도중에는 클립보드가 바뀌어 있다 — 받아들인 대가다.
//
// 되돌리는 것은 시연이 넣은 내용뿐이다. 시연 뒤 클립보드에 든 것을 마지막으로 넣은 것이 시연이 아니면(사용자가
// 시연 도중에 복사함) 되돌리지 않고 시연 출력에 적는다 — 되돌리면 그 사용자 복사를 하네스가 덮는다
// (2026-10-19 사용자 확정). (실측: 시연을 돌리는 동안 사용자가 다른 일을 하며 복사해, 클립보드를 쓰지 않는 시연 도중에도 클립보드가
// 바뀌었다.)
// - 넣은 프로그램은 클립보드 소유 창의 프로세스로 가린다. 이 playwright worker 나 그 자손(시연 VS Code · 그 확장 ·
//   시연 셸 · 시연이 띄운 도구)이면 시연이다.
// - 시연 VS Code 를 닫으면 그 소유 창도 사라져 누가 넣었는지 모른다. 그래서 시연 VS Code 를 닫기 직전에도
//   가려 둔다(noteDemoAppClosing — fixtures.ts 의 launchVsCode 가 닫기 직전에 부른다). 시연 뒤 클립보드 순번이 그때와
//   같으면 그때 가린 대로 따른다.
// - 소유 창 없이 넣고 곧 끝나는 프로그램(예: 시연 셸에서 돌린 Set-Clipboard)이 넣은 것은 시연으로 가리지 못해
//   되돌리지 않는다 — 시연 출력에 적힌다. 지금 시연 중 클립보드에 넣는 것은 모두 시연 VS Code 다.
// 꺼내고 넣는 일은 ClipboardGuard.cs(Win32 클립보드 API)를 컴파일한 도구가 한다. 형식별 처리와 되돌리지 못하는
// 형식(실측)은 그 파일 주석에 있다. 꺼낸 내용은 이 프로세스 메모리에만 둔다 — 사용자가 복사해 둔 비밀번호 등이
// 디스크에 남지 않게.
//
// 적용 범위 — fixtures.ts 가 모든 시연에 자동 fixture 로 건다. 클립보드를 쓰는 시연에만 표식으로 켜면, 새 시연이
// 클립보드를 쓰면서 표식을 빠뜨릴 때 사용자 클립보드를 덮은 채 끝난다. 모든 시연에 걸어도 비용이 작다.
// - 시연마다 클립보드 순번 · 소유자만 앞뒤로 읽는다(작은 도구 프로세스 2개 + 시연 VS Code 를 닫을 때마다 1개,
//   각 약 0.1초).
// - 꺼내기는 순번이 마지막으로 꺼내거나 되돌린 때와 다를 때만 한다(worker 의 첫 시연, 사용자가 그사이
//   새로 복사했을 때).
// - 되돌리기는 시연이 클립보드를 바꿨을 때만 한다. 바뀌지 않은 클립보드는 다시 넣지 않아, 소유 프로그램의
//   원래 데이터(지연 렌더링 · OLE 데이터 객체)를 그대로 둔다.
// macOS · Linux 는 아직 하지 않는다 — 시연은 Windows 에서 돈다.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guardDir = path.dirname(fileURLToPath(import.meta.url));

/** 도구의 C# 소스. */
const guardSourcePath = path.join(guardDir, "ClipboardGuard.cs");

/** 컴파일한 도구를 두는 하네스 캐시 폴더 — 소스가 바뀌면 파일 이름(소스 해시)이 바뀐다. */
const guardCacheDir = path.join(guardDir, "..", "..", ".vscode-test", "clipboard-guard");

// 도구 프로세스의 제한 시간 — 넘으면 프로세스 트리를 끝낸다.
const compileTimeoutMs = 120_000;
const seqTimeoutMs = 10_000;
// save 는 답하지 않는 소유 창을 15초까지 기다린 뒤 읽은 만큼 낸다(ClipboardGuard.cs 의 SaveBudgetMs) — 그보다 길게.
const saveTimeoutMs = 30_000;
const restoreTimeoutMs = 30_000;

/** restore 명령의 결과. */
type RestoreReport = {
  /** 되돌린 뒤의 클립보드 순번. */
  readonly seq: number;
  /** 꺼내 둔 형식 수. */
  readonly formats: number;
  readonly notRestored: readonly { readonly format: string; readonly reason: string }[];
};

/** owner 명령의 결과 — 지금 클립보드를 누가 넣었는가. */
type OwnerReport = {
  readonly seq: number;
  /** 클립보드 소유 창의 프로세스. 소유 창이 없으면 0. */
  readonly ownerPid: number;
  /** 그 프로세스의 실행 파일 이름. 모르면 빈 문자열. */
  readonly owner: string;
  /** 그 프로세스가 이 worker 거나 그 자손이면 참. */
  readonly fromDemo: boolean;
};

/** 꺼내 둔 클립보드 — 묶음과, 그 내용이 클립보드에 있었던(되돌린 뒤에는 되돌린) 때의 순번. */
type ClipboardSnapshot = { seq: number; readonly bundle: Buffer };

/** 시연 출력에 적는 줄의 머리. */
const logPrefix = "[클립보드]";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 프로세스 트리를 끝낸다. 이미 끝났으면 아무 일도 하지 않는다. */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch {
    // 이미 끝난 프로세스면 taskkill 이 실패한다.
  }
}

/**
 * 프로세스를 돌려 stdout 을 받는다. 종료 코드가 0 이 아니면 오류다.
 * 제한 시간을 넘으면 프로세스 트리를 끝내고 오류다.
 */
function runProcess(
  file: string,
  args: readonly string[],
  options: { readonly input?: Buffer; readonly timeoutMs: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const command = `${path.basename(file)} ${args.join(" ")}`;
    let settled = false;
    const settle = (error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve(Buffer.concat(stdout));
      else reject(error);
    };
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      settle(
        new Error(
          `${command} 이 ${options.timeoutMs}ms 안에 끝나지 않아 프로세스 트리를 끝냈습니다.`,
        ),
      );
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => settle(error));
    child.on("close", (code) => {
      if (code === 0) {
        settle(undefined);
        return;
      }
      const output = Buffer.concat([...stderr, ...stdout])
        .toString("utf8")
        .trim();
      settle(new Error(`${command} 이 종료 코드 ${code} 로 끝났습니다: ${output}`));
    });
    // 도구가 stdin 을 다 읽기 전에 끝나면(오류) 쓰기가 EPIPE 로 실패한다 — 결과는 종료 코드로 판정한다.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

/** Windows 에 든 .NET Framework 4 의 C# 컴파일러. */
function findCsc(): string {
  const windowsDir = process.env["windir"] ?? process.env["SystemRoot"] ?? "C:\\Windows";
  for (const framework of ["Framework64", "Framework"]) {
    const cscPath = path.join(windowsDir, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    if (fs.existsSync(cscPath)) return cscPath;
  }
  throw new Error(`.NET Framework 4 의 csc.exe 를 찾지 못했습니다: ${windowsDir}\\Microsoft.NET`);
}

/** 도구를 컴파일해(캐시에 있으면 그대로) 실행 파일 경로를 돌려준다. */
async function buildGuardTool(): Promise<string> {
  const source = fs.readFileSync(guardSourcePath);
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const exeName = `ClipboardGuard-${hash}.exe`;
  const exePath = path.join(guardCacheDir, exeName);
  if (fs.existsSync(exePath)) return exePath;

  fs.mkdirSync(guardCacheDir, { recursive: true });
  // 같은 폴더에 따로 만든 뒤 이름을 바꾼다 — 동시 실행이 반쯤 쓴 파일을 실행하지 않게.
  const tempPath = path.join(guardCacheDir, `ClipboardGuard-${hash}.${process.pid}.tmp.exe`);
  await runProcess(
    findCsc(),
    [
      "-nologo",
      "-preferreduilang:en-US",
      "-codepage:65001", // 소스는 BOM 없는 UTF-8 다 — 안 주면 시스템 코드 페이지로 읽는다.
      "-target:exe",
      "-optimize+",
      `-out:${tempPath}`,
      guardSourcePath,
    ],
    { timeoutMs: compileTimeoutMs },
  );
  try {
    fs.renameSync(tempPath, exePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    if (!fs.existsSync(exePath)) throw error;
  }
  // 지난 소스로 만든 도구를 지운다. 다른 실행이 아직 쓰는 파일은 지워지지 않아 남는다.
  for (const name of fs.readdirSync(guardCacheDir)) {
    if (name !== exeName && !name.includes(".tmp.")) {
      try {
        fs.rmSync(path.join(guardCacheDir, name), { force: true });
      } catch {
        // 쓰는 중인 파일 — 다음 빌드에서 지운다.
      }
    }
  }
  return exePath;
}

/** 이 worker 의 클립보드 보존기 — noteDemoAppClosing 이 찾는다. */
let workerKeeper: ClipboardKeeper | undefined;

/**
 * 시연 VS Code 를 닫기 직전에 부른다 — 닫으면 그 클립보드 소유 창이 사라져, 시연이 클립보드에 넣은 것인지
 * 시연 뒤에는 가릴 수 없다. 실패해도 던지지 않는다(닫기를 막지 않는다).
 */
export async function noteDemoAppClosing(): Promise<void> {
  await workerKeeper?.noteDemoAppClosing();
}

/**
 * worker 하나의 클립보드 보존기 — 시연마다 beforeTest · afterTest 를 부른다. 도구를 만들지 못했거나
 * Windows 가 아니면 아무 일도 하지 않는다.
 */
export class ClipboardKeeper {
  readonly #toolPath: string | undefined;
  #snapshot: ClipboardSnapshot | undefined;
  /** 이번 시연 전에 클립보드를 꺼내 두었는가 — 아니면 시연 뒤에 되돌리지 않는다. */
  #armed = false;
  /** 이번 시연에서 시연 VS Code 를 닫기 직전에 가린 결과들. */
  readonly #closingReports: OwnerReport[] = [];

  private constructor(toolPath: string | undefined) {
    this.#toolPath = toolPath;
  }

  static async create(): Promise<ClipboardKeeper> {
    let toolPath: string | undefined;
    if (process.platform === "win32") {
      try {
        toolPath = await buildGuardTool();
      } catch (error) {
        console.warn(
          `${logPrefix} 클립보드 보존 도구를 만들지 못했습니다 — 이 worker 의 시연은 바꾼 클립보드를 ` +
            `되돌리지 않습니다: ${errorText(error)}`,
        );
      }
    }
    workerKeeper = new ClipboardKeeper(toolPath);
    return workerKeeper;
  }

  /** 시연 전 — 클립보드가 마지막으로 꺼낸 때와 다르면 다시 꺼낸다. */
  async beforeTest(): Promise<void> {
    this.#armed = false;
    this.#closingReports.length = 0;
    if (this.#toolPath === undefined) return;
    try {
      const seq = await this.#readSeq(this.#toolPath);
      if (this.#snapshot?.seq !== seq) {
        const bundle = await runProcess(this.#toolPath, ["save"], { timeoutMs: saveTimeoutMs });
        if (bundle.length < 12 || bundle.toString("ascii", 0, 4) !== "SDCB") {
          throw new Error(`save 가 묶음이 아닌 출력을 냈습니다(${bundle.length} 바이트).`);
        }
        this.#snapshot = { seq: bundle.readUInt32LE(8), bundle };
      }
      this.#armed = true;
    } catch (error) {
      this.#snapshot = undefined;
      console.warn(
        `${logPrefix} 시연 전 클립보드를 꺼내지 못했습니다 — 이 시연이 클립보드를 바꾸면 ` +
          `되돌리지 않습니다: ${errorText(error)}`,
      );
    }
  }

  /** noteDemoAppClosing 참고. */
  async noteDemoAppClosing(): Promise<void> {
    if (!this.#armed || this.#toolPath === undefined) return;
    try {
      this.#closingReports.push(await this.#readOwner(this.#toolPath));
    } catch (error) {
      console.warn(
        `${logPrefix} 시연 VS Code 를 닫기 전에 클립보드 소유자를 읽지 못했습니다: ${errorText(error)}`,
      );
    }
  }

  /**
   * 시연 뒤 — 시연이 클립보드를 바꿨으면 꺼내 둔 내용을 되돌리고, 되돌리지 못한 형식을 적는다.
   * 마지막으로 넣은 것이 시연이 아니면 되돌리지 않고 그 사실을 적는다.
   */
  async afterTest(): Promise<void> {
    const snapshot = this.#snapshot;
    if (!this.#armed || snapshot === undefined || this.#toolPath === undefined) return;
    this.#armed = false;
    try {
      const current = await this.#readOwner(this.#toolPath);
      if (current.seq === snapshot.seq) return;
      // 순번이 같으면 내용도 같다 — 그 순번일 때 한 번이라도 소유자가 시연이었으면 시연이 넣은 것이다.
      // 닫기 직전에 가린 것을 함께 본다 — 지금은 시연 VS Code 의 소유 창이 없다.
      const sameContent = [...this.#closingReports, current].filter(
        (report) => report.seq === current.seq,
      );
      if (!sameContent.some((report) => report.fromDemo)) {
        const ownerText =
          current.ownerPid === 0 ? "소유 창 없음" : `${current.owner} pid ${current.ownerPid}`;
        console.log(
          `${logPrefix} 시연 중 클립보드가 바뀌었지만 마지막으로 넣은 것이 시연이 아니어서(${ownerText}) ` +
            `되돌리지 않았습니다.`,
        );
        return;
      }
      const output = await runProcess(this.#toolPath, ["restore"], {
        input: snapshot.bundle,
        timeoutMs: restoreTimeoutMs,
      });
      const report = JSON.parse(output.toString("utf8")) as RestoreReport;
      // 되돌린 내용은 꺼내 둔 묶음 그대로다 — 다음 시연은 순번이 그대로면 다시 꺼내지 않는다.
      snapshot.seq = report.seq;
      if (report.notRestored.length === 0) {
        console.log(
          `${logPrefix} 시연이 바꾼 클립보드를 시연 전 내용으로 되돌렸습니다(형식 ${report.formats}개).`,
        );
      } else {
        console.warn(
          `${logPrefix} 시연이 바꾼 클립보드를 되돌렸지만 형식 ${report.formats}개 중 ` +
            `${report.notRestored.length}개는 되돌리지 못했습니다:\n` +
            report.notRestored.map(({ format, reason }) => `  - ${format}: ${reason}`).join("\n"),
        );
      }
    } catch (error) {
      // 클립보드가 어떤 상태인지 모른다 — 다음 시연은 다시 꺼낸다.
      this.#snapshot = undefined;
      console.warn(
        `${logPrefix} 시연이 바꾼 클립보드를 되돌리지 못했습니다(모든 형식): ${errorText(error)}`,
      );
    }
  }

  async #readOwner(toolPath: string): Promise<OwnerReport> {
    const output = await runProcess(toolPath, ["owner", String(process.pid)], {
      timeoutMs: seqTimeoutMs,
    });
    return JSON.parse(output.toString("utf8")) as OwnerReport;
  }

  async #readSeq(toolPath: string): Promise<number> {
    const output = await runProcess(toolPath, ["seq"], { timeoutMs: seqTimeoutMs });
    const text = output.toString("utf8").trim();
    const seq = Number(text);
    if (!Number.isInteger(seq)) throw new Error(`seq 가 수가 아닌 출력을 냈습니다: ${text}`);
    return seq;
  }
}
