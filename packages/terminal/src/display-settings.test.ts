import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DisplaySettingsSource,
  readDisplaySettings,
  settingsSettleMs,
  type DisplaySettings,
} from "./display-settings.ts";

/** VS Code 설정 스키마의 기본값 한 벌 — 개별 케이스는 필요한 키만 덮어쓴다. */
const schemaDefaults: Record<string, unknown> = {
  "terminal.integrated.fontFamily": undefined,
  "terminal.integrated.fontSize": 14,
  "terminal.integrated.fontWeight": "normal",
  "terminal.integrated.fontWeightBold": "bold",
  "terminal.integrated.letterSpacing": 0,
  "terminal.integrated.lineHeight": 1,
  "terminal.integrated.scrollback": 1000,
  "terminal.integrated.gpuAcceleration": "auto",
  "window.density.editorTabHeight": "default",
  "workbench.experimental.modernUI": false,
};

function createReader(overrides: Record<string, unknown> = {}) {
  const values = { ...schemaDefaults, ...overrides };
  const read = (key: string): unknown => values[key];
  return {
    read,
    set(key: string, value: unknown): void {
      values[key] = value;
    },
  };
}

test("각 표시 설정 키가 대응 값으로 옮겨진다", () => {
  const { read } = createReader({
    "terminal.integrated.fontFamily": "Cascadia Code",
    "terminal.integrated.fontSize": 13,
    "terminal.integrated.fontWeight": 300,
    "terminal.integrated.lineHeight": 1.2,
    "terminal.integrated.scrollback": 5000,
  });

  assert.deepEqual(readDisplaySettings(read), {
    fontFamily: "Cascadia Code",
    fontSize: 13,
    fontWeight: 300,
    fontWeightBold: "bold",
    letterSpacing: 0,
    lineHeight: 1.2,
    scrollback: 5000,
    gpuAcceleration: "auto",
    tabHeight: 35,
    modernTabs: false,
  } satisfies DisplaySettings);
});

test("window.density.editorTabHeight 가 compact 면 tab 높이가 compact 수치가 된다", () => {
  const { read } = createReader({ "window.density.editorTabHeight": "compact" });
  assert.equal(readDisplaySettings(read).tabHeight, 22);
});

test("modern UI 가 켜지면 modernTabs 와 함께 tab 높이도 modern 수치가 된다", () => {
  const { read } = createReader({ "workbench.experimental.modernUI": true });
  const settings = readDisplaySettings(read);
  assert.equal(settings.modernTabs, true);
  assert.equal(settings.tabHeight, 32);
});

test("modern UI + compact 밀도는 modern compact 수치가 된다", () => {
  const { read } = createReader({
    "workbench.experimental.modernUI": true,
    "window.density.editorTabHeight": "compact",
  });
  assert.equal(readDisplaySettings(read).tabHeight, 28);
});

test("빈 글꼴 이름은 기본값으로 채우지 않고 결측으로 전달한다", () => {
  const { read } = createReader({ "terminal.integrated.fontFamily": "" });
  assert.equal("fontFamily" in readDisplaySettings(read), false);
});

test("스크롤백 0 은 이력 없음이므로 기본값으로 바뀌지 않는다", () => {
  const { read } = createReader({ "terminal.integrated.scrollback": 0 });
  assert.equal(readDisplaySettings(read).scrollback, 0);
});

test("값이 그대로면 알리지 않는다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes: DisplaySettings[] = [];
  const { read } = createReader();
  const source = new DisplaySettingsSource(read, (settings) => changes.push(settings));

  source.notifyChanged();
  t.mock.timers.tick(settingsSettleMs);

  assert.deepEqual(changes, []);
  source.dispose();
});

test("짧은 간격의 연속 변경이 마지막 값 한 번으로 수렴한다", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const changes: DisplaySettings[] = [];
  const reader = createReader();
  const source = new DisplaySettingsSource(reader.read, (settings) => changes.push(settings));

  for (const size of [11, 12, 13]) {
    reader.set("terminal.integrated.fontSize", size);
    source.notifyChanged();
    t.mock.timers.tick(settingsSettleMs / 2);
  }
  t.mock.timers.tick(settingsSettleMs);

  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.fontSize, 13);
  assert.equal(source.current.fontSize, 13);
  source.dispose();
});
