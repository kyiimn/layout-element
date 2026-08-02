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
 * `color.json`에서 `CMYKColorSet`을 로드하여 내부에 보관하고,
 * `getCSSColor(name)` 호출 시 해당 색상을 CMYK → RGB → `#RRGGBB` hex로
 * 변환하여 반환한다. 스타일시트에 CSS 변수를 주입하지 않는다.
 *
 * 컴포넌트에서 `backgroundColor: "red"`처럼 등록된 CMYK 이름을 사용하면
 * `getCSSColor()`가 반환한 hex 문자열로 렌더링된다.
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

      this._ready = true;

      return this.colorMap;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  /**
   * CSS 색상 문자열 반환.
   *
   * 등록된 색상 이름이면 해당 색상의 `#RRGGBB` hex 문자열을 반환한다.
   * 등록되지 않은 이름(또는 CSS 색상 문자열)은 기본 색상(`_defaultColor`)의
   * hex로 폴백된다.
   *
   * 반환값이 hex 문자열이므로, `getOpacityHex()`로 생성한 2자리 alpha hex를
   * 뒤에 결합하여 `#RRGGBBAA` 형태의 투명도 포함 색상을 만들 수 있다.
   *
   * @param name CMYK 색상 이름
   * @returns `#RRGGBB` hex 문자열. 등록되지 않은 이름은 기본 색상 hex
   *
   * @example
   * ```ts
   * const bg = registry.getCSSColor('red');
   * // → '#FF0000'
   *
   * // 투명도 결합
   * const bg50 = registry.getCSSColor('red') + registry.getOpacityHex(0.5);
   * // → '#FF000080'
   * ```
   */
  public getCSSColor(name: string) {
    if (!this.ready) throw new Error('color map is not ready');
    return Object.keys(this._colorSet).includes(name)
      ? this._rgbHex(this._cmykToRgb(this._colorSet[name]))
      : this._rgbHex(this._cmykToRgb(this._defaultColor));
  }

  /**
   * 0~1 투명도 값을 2자리 hex alpha 문자열로 변환한다.
   *
   * CSS `opacity`와 동일한 0~1 범위를 받아 `00`(완전 투명) ~ `FF`(완전 불투명)
   * hex 2자리로 변환한다. `getCSSColor()`가 반환한 `#RRGGBB` hex 뒤에 결합하여
   * `#RRGGBBAA` 형태의 8자리 hex 색상을 만드는 데 사용한다.
   *
   * @param opacity 0~1 범위의 투명도. 범위를 벗어나면 clamp 처리된다.
   * @returns 2자리 hex alpha 문자열 (`00`~`FF`)
   *
   * @example
   * ```ts
   * registry.getOpacityHex(0);   // → '00'
   * registry.getOpacityHex(0.5);  // → '80'
   * registry.getOpacityHex(1);   // → 'FF'
   * registry.getOpacityHex(0.3);// → '4D'
   * ```
   */
  public getOpacityHex(opacity: number) {
    const clamped = Math.min(1, Math.max(0, opacity));
    return Math.round(clamped * 255).toString(16).padStart(2, '0').toUpperCase();
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