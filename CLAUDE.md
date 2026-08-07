# simplysm-vscode

VS Code 확장 모노레포. spec 은 `.specs/<주제>.md` — 주제별 전제·설계는 각 spec 소관.

- 확장 패키지(`packages/*`) 추가·삭제 시 `.vscode/launch.json` 의 `--extensionDevelopmentPath` 목록도 함께 갱신 — F5 가 모든 확장을 로드해야 함.
- `.back`폴더 및 `.gitignore`에 포함된 폴더는 사용자가 정확한 경로로 요청하기전엔 읽기/쓰기 금지.

## 검증·시연 (에이전트 직접 수행)

- 단위 검증·시연 = `pnpm demo` — VS Code 를 playwright(`_electron`)로 직접 기동해 실사용자 경로(팔레트·입력창 타이핑)로 조작. 사용자 개입 0회.
  - 본인이 수정한 부분에 대해서만 demo 수행. 모두 수행하면 엄청 오래걸림.
- 판정 = webview 내부 DOM 단언 + 스크린샷 직접 열람(가시성 단언은 z-order 가려짐을 못 잡음 — 시각 확인은 스크린샷으로).
- 하네스 위치 = `demo/`(spec + `fixtures.ts`), 워크스페이스 = `demo/workspace/`(실작업과 분리).
- 사용자에게 F5 실행·로그 회신을 요구하지 않는다 — 자동 판정 불가한 미세 시각 품질만 육안 요청.

## 명령

- `pnpm build` / `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm demo [spec경로]`
  - `pnpm demo <spec경로>` = 그 spec 만 실행. 경로 생략 = 전체(15분+).

## 언어

코드내 주석, 혹은 각종 개발 문서등은 한국어. 확장의 사용자에게 보일 텍스트는 영어 (다국어 지원 가능시 영어를 기본으로 하며, 한국어도 지원함).
