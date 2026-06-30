import { CMYKColor, CMYKColorSet, ColorMap, RGBColor } from "@/types";

/**
 * CMYK 색상 로드 및 RGB 변환을 관리하는 싱글턴 매니저.
 *
 * `color.json`에서 `CMYKColorSet`을 로드하고, 각 색상을 RGB로 변환하여
 * CSS 변수(`--color-{name}`)로 문서에 주입한다.
 *
 * 컴포넌트에서 `backgroundColor: "red"`처럼 CMYK 이름을 사용하면
 * 해당 CSS 변수로 렌더링된다.
 *
 * 인쇄 모드(`window.matchMedia("print")`)에서는 서버 로딩을 생략하고
 * `colorSet` setter를 통해 데이터를 주입받는다.
 */
export class ColorManager {
  private static _instance?: ColorManager;

  private _colorSet: CMYKColorSet = {};
  private _defaultColor: CMYKColor = { c: 0, m: 0, y: 0, k: 0 };

  private _ready: boolean = false;
  private _isPrint: boolean = false;

  private constructor() {
    this._isPrint = window.matchMedia("print").matches;
    !this._isPrint && this._loadServer();
  }

  /** 서버에서 `color.json` 로드 */
  private async _loadServer() {
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

    const c_ = Math.min(1, Math.max(0, c));
    const m_ = Math.min(1, Math.max(0, m));
    const y_ = Math.min(1, Math.max(0, y));
    const k_ = Math.min(1, Math.max(0, k));

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
    this._ready = false;
    this._colorSet = {};

    try {
      if (this._isPrint) {
        if (!colorSet) throw new Error('not given color set');
        this._colorSet = colorSet;
      } else {
        this._colorSet = await this._loadServer();
      }
      this._defaultColor = { c: 0, m: 0, y: 0, k: 0 };

      const sheet = globalThis.document?.styleSheets[0];
      if (!sheet) return;

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