// 세션 시작 실패·종료 사유의 구조화 표현. daemon 은 번역 수단이 없으므로 사유를
// 코드+파라미터로만 담고, 확장 호스트가 화면에 보내기 직전에 번역한다.

/** 세션 시작 시도가 실패한 사유. */
export type StartFailureCause =
  | { readonly kind: "cwdMissing"; readonly cwd: string }
  | { readonly kind: "spawnFailed"; readonly detail: string };

/** 셸 프로세스가 끝난 사유. */
export type SessionEndCause =
  | { readonly kind: "endedBySignal" }
  | { readonly kind: "exited"; readonly exitCode: number }
  /** 확장 업데이트로 버전이 어긋나 셸은 잃고 화면만 회수한 세션. */
  | { readonly kind: "restoreFailed" }
  /** daemon 연결이 끊겨(크래시 등) 셸을 잃은 세션 — 확장 호스트가 감지 시점에 붙인다. */
  | { readonly kind: "daemonLost" };
