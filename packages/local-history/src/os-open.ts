import { spawn } from "node:child_process";
import path from "node:path";

// OS 기본 앱으로 열기 (plan 「설계 결정」) — 확장 호스트가 OS 의 열기 명령에 경로를 넘긴다.
// vscode 에 의존하지 않아 단위 테스트한다.
// `vscode.env.openExternal`(file URL)을 쓰지 않는 이유: Windows 는 비 ASCII 가 퍼센트 인코딩된 file URL 의 파일을
// 찾지 못한다(실측: "지정된 파일을 찾을 수 없습니다. (0x2)"). 한국어 시각이 든 사본 이름이 항상 열리지 않는다.

/** Windows 에서 열 경로를 PowerShell 에 넘기는 환경 변수 — 명령줄 인용을 거치지 않아 `&` `%` `"` 등이 안전하다. */
export const OPEN_PATH_ENV = "SIMPLYSM_LOCAL_HISTORY_OPEN_PATH";

/**
 * Windows 의 열기 스크립트 — `Invoke-Item -LiteralPath`(와일드카드 해석 없음)가 ShellExecute 로 연결 앱을 띄운다.
 * 연결 앱이 없는 형식은 탐색기처럼 "연결 프로그램 선택" 창이 뜬다(실측).
 * `Start-Process` 가 아닌 이유: Windows PowerShell 5.1(Windows 기본)의 `Start-Process` 에는 `-LiteralPath` 가 없다(실측).
 * 실패하면 원인을 표준 오류에 한 줄로 쓰고 1 로 끝난다.
 * - 표준 오류는 UTF-8 로 — 원인 문구가 OS 언어(한국어 등)다.
 * - 진행 표시를 끈다 — 표준 오류가 리디렉션되면 PowerShell 이 모듈 준비 진행을 CLIXML 로 섞어 쓴다(실측).
 */
const windowsScript = [
  "$ProgressPreference = 'SilentlyContinue'",
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
  `try { Invoke-Item -LiteralPath $env:${OPEN_PATH_ENV} -ErrorAction Stop } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
].join("\n");

/** 열기 명령 하나 — 셀을 거치지 않고 실행한다. */
export interface OsOpenCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * OS 별 열기 명령 — Windows: PowerShell `Invoke-Item -LiteralPath`(경로는 환경 변수), macOS: `open`, Linux: `xdg-open`.
 * macOS · Linux 는 경로를 인자 하나로 넘긴다(셀이 없어 인용이 필요 없고, 절대 경로라 옵션으로 읽히지 않는다).
 */
export function osOpenCommand(
  filePath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): OsOpenCommand {
  switch (platform) {
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(windowsScript, "utf16le").toString("base64"),
        ],
        env: { ...env, [OPEN_PATH_ENV]: filePath },
      };
    case "darwin":
      return { command: "open", args: [filePath], env };
    default:
      return { command: "xdg-open", args: [filePath], env };
  }
}

/** 열기 명령이 실패했다(종료 코드 ≠ 0) — 메시지는 명령이 알린 원인이다. */
export class OsOpenError extends Error {}

/**
 * 파일을 OS 기본 앱으로 연다 — 열기 명령이 끝나면(앱이 뜨면) 끝난다.
 * 실행하지 못하면 그 오류(예: ENOENT), 종료 코드가 0 이 아니면 `OsOpenError` 로 실패한다.
 * 작업 폴더(cwd)는 파일의 폴더(이 확장의 사본 폴더)다 — Windows 는 명령을 PATH 보다 작업 폴더에서 먼저 찾는데,
 * 확장 호스트의 작업 폴더는 사용자가 VS Code 를 띄운 폴더(남의 저장소일 수 있다)일 수 있다.
 * 사본 폴더에는 이름에 시각 표시가 붙은 사본만 있어 명령 이름과 겹치지 않는다.
 */
export async function openInOs(filePath: string): Promise<void> {
  const { command, args, env } = osOpenCommand(filePath, process.platform, process.env);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.dirname(filePath),
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    // 실행에 실패하면(작업 폴더가 없는 등) 표준 오류 스트림도 오류(ENOTCONN)를 낸다 — 받지 않으면 처리되지 않은
    // 예외가 된다(실측). 실패는 프로세스의 error 가 알린다.
    child.stderr.on("error", () => undefined);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new OsOpenError(stderr.trim() || `${command} exited with ${code ?? signal}`));
    });
  });
}
