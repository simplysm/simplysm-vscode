// focus-refresh 시연 공용 유틸 — 포커스 시뮬레이션 (plan "데모 하네스 확인 사항" 참고).
import { type ElectronApplication, type Page } from "@playwright/test";

/**
 * 포커스 아웃→복귀 시뮬레이션 — 하네스 창은 setFocusable(false) 라 OS 포커스를 못 받으므로,
 * VS Code 메인 프로세스가 창 포커스 추적에 쓰는 Electron app 이벤트를 직접 발생시킨다.
 * 렌더러는 이벤트 수신 시 `document.hasFocus()` 를 다시 읽어 상태를 정하므로 함께 스텁한다.
 * blur→focus 연속 emit 은 레이스로 유실됨 — 사이 대기 필수.
 */
export async function simulateFocusRegain(
  app: ElectronApplication,
  workbox: Page,
): Promise<void> {
  const emitAppEvent = (eventName: string) =>
    app.evaluate(({ app: electronApp, BrowserWindow }, name) => {
      electronApp.emit(name, {}, BrowserWindow.getAllWindows()[0]);
    }, eventName);
  await workbox.evaluate(() => (document.hasFocus = () => false));
  await emitAppEvent("browser-window-blur");
  await workbox.waitForTimeout(500);
  await workbox.evaluate(() => (document.hasFocus = () => true));
  await emitAppEvent("browser-window-focus");
}
