// 프로세스 생존 확인 — 로그 잠금 회수(storage.ts)와 지난 세션의 사본 정리(default-app-copy.ts)가 쓴다.
// vscode 에 의존하지 않아 단위 테스트에서도 쓴다.

/** pid 의 프로세스가 살아 있는가 — 신호 0 은 존재 확인만 한다. EPERM = 있지만 권한 없음. */
export function isProcessAlive(pid: number): boolean {
  // 모르는 pid 는 살아 있다고 본다 — 0 이하는 POSIX 에서 프로세스 그룹을 뜻해 항상 성공한다
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
