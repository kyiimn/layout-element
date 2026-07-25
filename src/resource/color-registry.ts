import { CMYKColor, CMYKColorSet, ColorMap, RGBColor } from "@/types";

/**
 * 색상 데이터 로드 함수 타입.
 *
 * 외부에서 `ColorRegistry.registerLoader()`로 등록할 커스텀 로더가
 * 반환해야 하는 시그니처.
 *
 * @returns 서버 또는 다른 소스에서 로드한 `CMYKColorSet`
 *
 * @example
 * ```ts
 * ColorRegistry.registerLoader(async () => {
 *   const res = await fetch('/api/v1/colors');
 *   return res.json() as Promise<CMYKColorSet>;
 * });
 * ```
 */
export type ColorLoaderFn = () => Promise<CMYKColorSet>;

/**
 * CMYK 색상 로드 및 RGB 변환을 관리하는 싱글턴 레지스트리.
 *
 * `color.json`에서 `CMYKColorSet`을 로드하고, 각 색상을 RGB로 변환하여
 * CSS 변수(`--color-{name}`)로 문서에 주입한다.
 *
 * 컴포넌트에서 `backgroundColor: "red"`처럼 CMYK 이름을 사용하면
 * 해당 CSS 변수로 렌더링된다.
 *
 * 인쇄 모드(`window.matchMedia("print")`)에서는 서버 로딩을 생략하고
 * `colorSet` setter를 통해 데이터를 주입받는다.
 *
 * `registerLoader()`로 커스텀 로더를 등록하면 기본 `fetch('color.json')` 대신
 * 해당 로더를 사용한다.
 */
export class ColorRegistry {
  private static _instance?: ColorRegistry;
  private static _customLoader?: ColorLoaderFn;

  private _colorSet: CMYKColorSet = {};
  private _defaultColor: CMYKColor = { c: 0, m: 0, y: 0, k: 0 };

  private _ready: boolean = false;
  private _isPrint: boolean = false;

  private constructor() {
    this._isPrint = window.matchMedia("print").matches;
  }

  /**
   * 커스텀 색상 로더를 등록한다.
   *
   * 등록된 로더는 `_loadServer()`에서 기본 `fetch('color.json')` 대신 우선 사용된다.
   * 이미 초기화된 인스턴스가 있어도 새 로더가 다음 `init()` 호출부터 적용된다.
   *
   * @param loader - `CMYKColorSet`를 반환하는 비동기 함수
   *
   * @example
   * ```ts
   * // API 서버에서 색상 데이터를 로드하도록 커스터마이징
   * ColorRegistry.registerLoader(async () => {
   *   const res = await fetch('/api/v1/colors');
   *   if (!res.ok) throw new Error('failed to load colors');
   *   return res.json() as Promise<CMYKColorSet>;
   * });
   * ```
   */
  public static registerLoader(loader: ColorLoaderFn): void {
    ColorRegistry._customLoader = loader;
  }

  /**
   * 등록된 커스텀 로더를 제거하고 기본 로더로 되돌린다.
   */
  public static resetLoader(): void {
    ColorRegistry._customLoader = undefined;
  }

  /** 서버에서 `color.json` 로드 (또는 커스텀 로더 사용) */
  private async _loadServer(): Promise<CMYKColorSet> {
    if (ColorRegistry._customLoader) {
      return ColorRegistry._customLoader();
    }

    try {
      const res = await fetch('color.json');
      if (!res.ok) throw new Error('server connection error');

      const json = await res.json() as CMYKColorSet;
      return json;
    } catch (e) {
      throw new Error("server connection error");
    }
  }

  /** RGB를 16진수 문자열로 변환 */
  private _rgbHex(rgb: RGBColor) {
    const { r, g, b } = rgb;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  }

  /** CMYK를 RGB로 변환 */
  private _cmykToRgb = (cmyk?: CMYKColor): RGBColor => {
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

  /** 싱글턴 인스턴스 반환 */
  public static getInstance() {
    if (!this._instance) {
      this._instance = new this();
    }
    return this._instance;
  }

  public async init(colorSet?: CMYKColorSet) {
    let newColorSet: CMYKColorSet = {};

    try {
      if (this._isPrint) {
        if (!colorSet) throw new Error('not given color set');
        newColorSet = colorSet;
      } else {
        newColorSet = await this._loadServer();
      }
      this._defaultColor = { c: 0, m: 0, y: 0, k: 255 };
      this._colorSet = newColorSet;

      const sheet = globalThis.document?.styleSheets[0];
      if (!sheet) {
        this._ready = true;
        return this.colorMap;
      }

      const ruleIdx = sheet.cssRules.length;
      sheet.insertRule(":root {}", ruleIdx);

      const rule = sheet.cssRules[ruleIdx] as CSSStyleRule;
      rule.style.setProperty('--colorman-default', this._rgbHex(this._cmykToRgb(this._defaultColor)));

      Object.keys(this._colorSet).forEach(name => {
        rule.style.setProperty(`--colorman-${name}`, this._rgbHex(this._cmykToRgb(this._colorSet[name])));
      });
      this._ready = true;

      return this.colorMap;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  /**
   * CSS 변수 형태의 색상 반환.
   * @param name CMYK 색상 이름
   * @returns `var(--colorman-{name})` 또는 `var(--colorman-default)`
   */
  public getCSSColor(name: string) {
    if (!this.ready) throw new Error('color map is not ready');
    return Object.keys(this._colorSet).includes(name) ? `var(--colorman-${name})` : 'var(--colorman-default)';
  }

  /**
   * CMYK 색상값 반환.
   * @param name 색상 이름
   * @returns 해당 색상의 CMYK 값 또는 기본값
   */
  public get(name: string) {
    if (!this.ready) throw new Error('color map is not ready');
    return this._colorSet[name] || this._defaultColor;
  }

  /** RGB-CMYK 색상 쌍 배열 반환 */
  get colorMap(): ColorMap[] {
    if (!this.ready) throw new Error('color map is not ready');
    return [...Object.keys(this._colorSet).map(cmyk => ({
      rgb: this._cmykToRgb(this._colorSet[cmyk]),
      cmyk: this._colorSet[cmyk],
    })),
    {
      rgb: this._cmykToRgb(this._defaultColor),
      cmyk: this._defaultColor,
    }];
  }

  /** 초기화 완료 여부 */
  get ready() {
    return this._ready;
  }
}