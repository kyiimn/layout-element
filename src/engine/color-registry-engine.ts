/**
 * Node.js 호환 색상 레지스트리 엔진.
 *
 * `ColorRegistry`에서 `fetch`/`document.styleSheets` 의존성을 제거하고
 * 주입된 `CMYKColorSet`으로 CMYK→RGB 변환만 수행하는 순수 엔진.
 *
 * @file src/engine/color-registry-engine.ts
 */

import type { CMYKColor, CMYKColorSet, RGBColor } from "@/types";
import type { ColorRegistryEngine } from "./types";

/**
 * Node.js 호환 색상 변환 엔진.
 *
 * `init(colorSet)`으로 색상 데이터를 주입받아
 * `getCSSColor(name)`에서 CMYK→RGB→hex 변환을 수행한다.
 * `fetch`나 `window.matchMedia`를 사용하지 않는다.
 *
 * @example
 * const engine = ColorRegistryEngineImpl.create();
 * engine.init({ red: { c: 0, m: 255, y: 255, k: 0 } });
 * engine.getCSSColor('red');  // '#FF0000'
 */
export class ColorRegistryEngineImpl implements ColorRegistryEngine {
  private _colorSet: CMYKColorSet = {};
  private _defaultColor: CMYKColor = { c: 0, m: 0, y: 0, k: 0 };
  private _ready: boolean = false;

  /**
   * 정적 팩토리 메서드.
   * @returns ColorRegistryEngineImpl 인스턴스
   */
  static create(): ColorRegistryEngineImpl {
    return new this();
  }

  private constructor() {}

  /** 초기화 완료 여부 */
  get ready(): boolean {
    return this._ready;
  }

  /**
   * 색상 데이터로 초기화한다 (동기).
   *
   * @param colorSet - CMYK 색상 정의
   */
  init(colorSet: CMYKColorSet): void {
    this._colorSet = colorSet;
    this._defaultColor = { c: 0, m: 0, y: 0, k: 255 };
    this._ready = true;
  }

  /**
   * RGB를 16진수 문자열로 변환한다.
   *
   * @param rgb - RGB 색상 값
   * @returns #RRGGBB hex 문자열 (대문자)
   */
  private _rgbHex(rgb: RGBColor): string {
    const { r, g, b } = rgb;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  }

  /**
   * CMYK를 RGB로 변환한다.
   *
   * @param cmyk - CMYK 색상 값. 생략 시 기본 색상.
   * @returns RGB 색상 값
   */
  private _cmykToRgb(cmyk?: CMYKColor): RGBColor {
    cmyk ??= this._defaultColor;

    const { c, m, y, k } = cmyk;

    const c_ = Math.min(1, Math.max(0, c / 255));
    const m_ = Math.min(1, Math.max(0, m / 255));
    const y_ = Math.min(1, Math.max(0, y / 255));
    const k_ = Math.min(1, Math.max(0, k / 255));

    const r = Math.round(255 * (1 - Math.min(1, c_ + k_)));
    const g = Math.round(255 * (1 - Math.min(1, m_ + k_)));
    const b = Math.round(255 * (1 - Math.min(1, y_ + k_)));

    return { r, g, b };
  }

  /**
   * 색상 이름으로 #RRGGBB hex 문자열을 반환한다.
   *
   * @param name - CMYKColorSet에 등록된 키
   * @returns #RRGGBB hex. 미등록 이름은 기본 색상 hex.
   * @throws {Error} 초기화 전 호출 시
   */
  getCSSColor(name: string): string {
    if (!this._ready) throw new Error('color map is not ready');
    return Object.keys(this._colorSet).includes(name)
      ? this._rgbHex(this._cmykToRgb(this._colorSet[name]))
      : this._rgbHex(this._cmykToRgb(this._defaultColor));
  }

  /**
   * 0~1 투명도 값을 2자리 hex alpha 문자열로 변환한다.
   *
   * @param opacity - 0~1 투명도. 범위 벗어나면 clamp.
   * @returns 00~FF hex 문자열
   */
  getOpacityHex(opacity: number): string {
    const clamped = Math.min(1, Math.max(0, opacity));
    return Math.round(clamped * 255).toString(16).padStart(2, '0').toUpperCase();
  }

  /**
   * 색상 이름으로 CMYKColor를 반환한다.
   *
   * @param name - CMYKColorSet에 등록된 키. 미등록 이름은 기본 색상.
   * @returns CMYKColor
   */
  get(name: string): CMYKColor {
    if (!this._ready) throw new Error('color map is not ready');
    return this._colorSet[name] ?? this._defaultColor;
  }
}