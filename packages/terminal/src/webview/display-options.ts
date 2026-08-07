// 표시 옵션의 두 조각을 합쳐 화면에 줄 값을 만든다. 설정 조각은 확장 호스트가 보내고
// 색 팔레트는 webview 가 테마에서 읽으므로, 두 조각은 서로 다른 시점에 도착한다.

import type { DisplaySettings } from "../display-settings.ts";
import { readColorPalette, type ColorPalette } from "./theme-colors.ts";

/** 화면 표시 옵션 전체. */
export interface DisplayOptions extends DisplaySettings {
  readonly colors: ColorPalette;
}

/**
 * 화면들이 보는 표시 옵션의 유일한 출처. 두 조각이 다 모이기 전에는 아무 값도 내주지 않아,
 * 임의 팔레트로 그린 화면이 잠깐 보이는 일이 없다.
 */
export class DisplayOptionsSource {
  readonly #onChange: (options: DisplayOptions) => void;
  #settings?: DisplaySettings;
  #colors: ColorPalette;

  constructor(onChange: (options: DisplayOptions) => void) {
    this.#onChange = onChange;
    this.#colors = readColorPalette();
  }

  get current(): DisplayOptions | undefined {
    return this.#settings == null ? undefined : { ...this.#settings, colors: this.#colors };
  }

  applySettings(settings: DisplaySettings): void {
    this.#settings = settings;
    this.#notify();
  }

  /** 테마가 바뀌었다. 색을 다시 읽어 팔레트를 새로 만든다. */
  reloadColors(): void {
    this.#colors = readColorPalette();
    this.#notify();
  }

  #notify(): void {
    const options = this.current;
    if (options != null) this.#onChange(options);
  }
}
