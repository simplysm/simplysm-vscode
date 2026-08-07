// 출력에서 찾은 파일 경로를 열 실제 경로로 만든다. 세션은 확장 호스트와 같은 머신(로컬 창이면
// Windows, Remote-SSH 면 그 리눅스 호스트)에서 돌므로, 경로 규칙은 세션 시작 디렉터리의 꼴로
// 판별한다 — process.platform 분기와 달리 두 규칙 모두 단위 테스트로 검증할 수 있다.

import path from "node:path";

/** 상대 경로는 그 세션의 시작 디렉터리를 기준으로 푼다. */
export function resolveFileLinkPath(sessionCwd: string, rawPath: string): string {
  const rules = /^[A-Za-z]:[\\/]|^\\\\/.test(sessionCwd) ? path.win32 : path.posix;
  return rules.resolve(sessionCwd, rawPath);
}
