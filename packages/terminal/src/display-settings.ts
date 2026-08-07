// VS Code 터미널 설정에서 표시 옵션의 설정 조각을 읽는다. 색 팔레트는 확장 호스트가 조회할 수 없어
// webview 쪽에서 만들고, 두 조각을 합치는 것도 webview 쪽이다.

/** 연달아 오는 설정 변경을 마지막 값 하나로 모으는 대기 시간. */
export const settingsSettleMs = 100;

/** 표시 옵션 중 VS Code 설정에서 오는 계열. 색 팔레트는 여기 없다. */
export interface DisplaySettings {
  /** 설정이 비었으면 없음. 에디터 글꼴로의 대체는 화면이 해석한다. */
  readonly fontFamily?: string;
  readonly fontSize: number;
  readonly fontWeight: number | string;
  readonly fontWeightBold: number | string;
  readonly letterSpacing: number;
  readonly lineHeight: number;
  /** 0 은 "이력 없음" 을 뜻하는 유효한 값이다. */
  readonly scrollback: number;
  /** 렌더러 선택. "off" 만 DOM 렌더러를 뜻하고 나머지는 WebGL 을 시도한다. */
  readonly gpuAcceleration: string;
  /**
   * tab 높이(px). window.density.editorTabHeight 를 따른다 — webview 는 workbench 가
   * 에디터 tab 에 넣는 CSS 변수를 받지 못해 여기서 수치로 만든다.
   * (근거: VS Code 1.127 실측 — EDITOR_TAB_HEIGHT = { normal: 35, compact: 22 })
   */
  readonly tabHeight: number;
}

/** 설정 하나를 읽는 창구. VS Code 설정은 지정하지 않은 키에도 스키마 기본값을 돌려준다. */
export type SettingsReader = (settingKey: string) => unknown;

const settingPrefix = "terminal.integrated.";

/**
 * 현재 설정 값으로 조각을 만든다. 값을 검사하지 않고 그대로 옮긴다 — 이상한 값이 들어 있으면
 * 내장 터미널과 똑같이 반응해야 한다.
 */
export function readDisplaySettings(read: SettingsReader): DisplaySettings {
  const pick = <T>(name: string): T => read(`${settingPrefix}${name}`) as T;

  // 비어 있으면 없음으로 둔다. 여기서 값을 지어내면 "설정 안 함" 과 "그 값을 지정함" 이 뭉개진다.
  const fontFamily = pick<string | undefined>("fontFamily");

  return {
    ...(fontFamily == null || fontFamily.length === 0 ? {} : { fontFamily }),
    fontSize: pick("fontSize"),
    fontWeight: pick("fontWeight"),
    fontWeightBold: pick("fontWeightBold"),
    letterSpacing: pick("letterSpacing"),
    lineHeight: pick("lineHeight"),
    scrollback: pick("scrollback"),
    gpuAcceleration: pick("gpuAcceleration"),
    tabHeight: read("window.density.editorTabHeight") === "compact" ? 22 : 35,
  };
}

function isSameSettings(left: DisplaySettings, right: DisplaySettings): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) return false;
  return leftEntries.every(
    ([key, value]) => value === (right as unknown as Record<string, unknown>)[key],
  );
}

/**
 * 최신 설정 조각을 들고 있으면서 바뀔 때만 알린다. 알림은 마지막 값 하나로 모아 보내,
 * 슬라이더 조작 같은 연속 변경에서 매번 전체 재계산이 돌지 않게 한다.
 */
export class DisplaySettingsSource {
  readonly #read: SettingsReader;
  readonly #onChange: (settings: DisplaySettings) => void;
  #current: DisplaySettings;
  #settleTimer?: NodeJS.Timeout;

  constructor(read: SettingsReader, onChange: (settings: DisplaySettings) => void) {
    this.#read = read;
    this.#onChange = onChange;
    this.#current = readDisplaySettings(read);
  }

  /** webview 가 생기면 이 값으로 시작한다 — 알림을 놓친 동안의 변경도 여기 반영돼 있다. */
  get current(): DisplaySettings {
    return this.#current;
  }

  /** 터미널 설정이 바뀌었다는 신호. 실제로 값이 달라졌는지는 여기서 가린다. */
  notifyChanged(): void {
    clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => this.#settle(), settingsSettleMs);
  }

  dispose(): void {
    clearTimeout(this.#settleTimer);
    this.#settleTimer = undefined;
  }

  #settle(): void {
    this.#settleTimer = undefined;
    const previous = this.#current;
    const settings = readDisplaySettings(this.#read);
    this.#current = settings;
    if (isSameSettings(settings, previous)) return;
    this.#onChange(settings);
  }
}
