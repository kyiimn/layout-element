/**
 * `<x-layout-canvas>` — 문단 단위 canvas 텍스트 렌더러 (CANVAS_RENDERING.md 단계 2).
 *
 * `ParagraphEngine.drawList`(mm 단위 드로잉 명령)를 `<canvas>` 1장으로 페인트한다.
 * 엔진-우선 계약:
 * - 좌표는 엔진 게터(drawList)만 소비 — paint 시점에 mm×ppm으로 변환 (§10 금지 5항).
 * - 폰트/색상은 runStyleRef를 페인트 시점에 해석 — stale 불가능 (§3.2 수정 설계).
 * - baseline은 `getCharAscentMm`(opentype ascender 엔진 게터)로 소비 — rect 역산 금지 (§4.1).
 * - DPR 캡 ≤2, backing store는 로컬 px 기준, 호스트 scale은 CSS transform (§8 메모리/DPR).
 * - 행두 걸침의 음수 x 돌출을 위해 좌우 bleed 여백 확보 (§8 걸침 클립).
 * - fillText는 `document.fonts` 폰트 로드 후에만 실행 (폰트별 FontFace.loaded 게이트).
 * - 히든 텍스트 레이어(a11y) 필수 — find-in-page·스크린리더 회복 (§7).
 *
 * @example
 * ```ts
 * const c = document.createElement('x-layout-canvas') as LayoutCanvasElement;
 * paragraph._shadowRoot.appendChild(c);
 * c.paint();  // drawList → canvas
 * ```
 *
 * @file src/components/layout/canvas.element.ts
 */

import { ParagraphEngine } from "@/engine";
import type { DrawCommand } from "@/engine/paragraph-canvas";
import type { TextStyle, InheritStyle } from "@/types";
import { FontLoader } from "@/resource/font-loader";
import { ColorRegistry } from "@/resource/color-registry";

const HOST_STYLE_ID = '__layout_canvas_style__';

/** DPR 캡 — §8 메모리/DPR 정책 (backing store 과다 방지). */
const MAX_DEVICE_PIXEL_RATIO = 2;

/** 걸침 돌출 bleed (mm) — 행두/행말 돌출량 상한 근사(글자 폭 ≤ 라인 폭 전제). */
const HANG_BLEED_MM = 20;

export class LayoutCanvasElement extends HTMLElement {
  private _shadowRoot: ShadowRoot;
  private _canvas: HTMLCanvasElement;
  private _styleEl: HTMLStyleElement;
  private _a11yText: HTMLDivElement;
  private _resolutionQuery: MediaQueryList | null = null;
  private _resolutionListener: (() => void) | null = null;

  private _engine: ParagraphEngine | null = null;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: 'open' });

    this._styleEl = document.createElement('style');
    this._styleEl.id = HOST_STYLE_ID;

    this._canvas = document.createElement('canvas');
    this._canvas.style.display = 'block';

    // a11y 히든 텍스트 레이어 — 문단 plain text 1개 요소 (§7 필수 구성).
    this._a11yText = document.createElement('div');
    this._a11yText.setAttribute('aria-hidden', 'false');
    this._a11yText.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';

    this._shadowRoot.appendChild(this._styleEl);
    this._shadowRoot.appendChild(this._canvas);
    this._shadowRoot.appendChild(this._a11yText);
  }

  connectedCallback() {
    this._applyHostStyle();
    this._watchResolution();
  }

  disconnectedCallback() {
    if (this._resolutionQuery && this._resolutionListener) {
      this._resolutionQuery.removeEventListener('change', this._resolutionListener);
      this._resolutionListener = null;
      this._resolutionQuery = null;
    }
  }

  /** 연결된 ParagraphEngine — drawList 단일 소스. */
  set engine(engine: ParagraphEngine | null) {
    this._engine = engine;
  }

  get engine(): ParagraphEngine | null {
    return this._engine;
  }

  private _applyHostStyle(): void {
    const key = JSON.stringify({ w: this.parentElement?.clientWidth ?? 0 });
    if (this._styleEl.dataset.key === key && this._styleEl.sheet && this._styleEl.sheet.cssRules.length > 0) {
      return;
    }
    this._styleEl.dataset.key = key;
    while (this._styleEl.sheet && this._styleEl.sheet.cssRules.length > 0) {
      this._styleEl.sheet.deleteRule(0);
    }
    if (this._styleEl.sheet) {
      this._styleEl.sheet.insertRule(':host { display: block; position: relative; overflow: visible; }', 0);
    }
  }

  /** `matchMedia('(resolution)')` 변경 시에만 재페인트 (§8 — 모니터 이동·브라우저 줌). */
  private _watchResolution(): void {
    if (this._resolutionQuery || typeof window === 'undefined' || !window.matchMedia) return;
    this._resolutionQuery = window.matchMedia('(resolution)');
    this._resolutionListener = () => {
      if (this._engine) this.paint();
    };
    this._resolutionQuery.addEventListener('change', this._resolutionListener);
  }

  /**
   * drawList를 canvas에 페인트한다.
   *
   * 폰트 로드 전이면 paint를 건너뛰고 로드 완료 후 재시도한다 (폴백 폰트
   * 페인트 방지 — §8). 명령 목록은 엔진 `drawList`에서 직접 소비하며
   * 좌표 공식을 재계산하지 않는다.
   *
   * @throws 없음 — 엔진 부재·미배치면 noop
   */
  paint(): void {
    const engine = this._engine;
    if (!engine) return;
    if (engine.hasPendingChanges) return;

    const pageEl = (this.parentElement as unknown as { _findPageElement?: () => { engine?: { ppm: number } } | null } | null)
      ?._findPageElement?.() ?? this._findPageElement();
    const ppm = pageEl?.engine?.ppm ?? 3.78;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);

    const parentWidthMm = engine.inheritStyle?.parentWidth ?? 0;
    const parentHeightMm = engine.inheritStyle?.parentHeight ?? 0;
    if (parentWidthMm <= 0 || parentHeightMm <= 0) return;

    const bleedMm = HANG_BLEED_MM;
    const widthLocalPx = (parentWidthMm + bleedMm * 2) * ppm;
    const heightLocalPx = parentHeightMm * ppm;
    const backingW = Math.ceil(widthLocalPx * dpr);
    const backingH = Math.ceil(heightLocalPx * dpr);
    if (this._canvas.width !== backingW || this._canvas.height !== backingH) {
      this._canvas.width = backingW;
      this._canvas.height = backingH;
      this._canvas.style.width = `${widthLocalPx}px`;
      this._canvas.style.height = `${heightLocalPx}px`;
      this._canvas.style.marginLeft = `${-bleedMm * ppm}px`;
    }

    const colorRegistry = this._findColorRegistry();
    const fontLoader = this._findFontLoader();
    if (!colorRegistry || !fontLoader) return;

    if (!this._fontsReadyFor(engine, fontLoader)) {
      // 폰트 로드 완료 후 재페인트 — FontLoader.init의 FontFace.load() 완료를
      // document.fonts.ready로 대기한다 (폰트별 게이트는 재시도 시 _fontsReadyFor가 담당).
      if (typeof document !== 'undefined' && document.fonts) {
        void document.fonts.ready.then(() => this.paint());
      }
      return;
    }

    const ctx = this._canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, widthLocalPx, heightLocalPx);
    ctx.textBaseline = 'alphabetic';

    const drawList = engine.drawList;
    // a11y 레이어 갱신 — visible 텍스트 1회 조립 (§7).
    this._a11yText.textContent = drawList.chars.map(c => c.char).join('');

    // drawList 좌표계: lineLeftMm은 문단 컨텐츠 좌측 기준(0 = 부모 박스 좌측),
    // canvas는 bleed만큼 좌측으로 확장했으므로 paint x = (bleed + lineLeft + charOffset) × ppm.
    const absLeftMm = engine.data?.parentAbsRect?.absLeft ?? 0;
    const absTopMm = engine.data?.parentAbsRect?.absTop ?? 0;
    void absLeftMm;
    void absTopMm;

    for (const cmd of drawList.chars as Extract<DrawCommand, { kind: 'char' }>[]) {
      this._paintChar(ctx, cmd, engine, colorRegistry, ppm, bleedMm);
    }
    for (const cmd of drawList.decos as Extract<DrawCommand, { kind: 'deco' }>[]) {
      this._paintDeco(ctx, cmd, colorRegistry, ppm, bleedMm);
    }
  }

  /**
   * 단일 글자 명령을 fillText로 그린다 — 장평(0.88 계수)·outline·색상을
   * 페인트 시점에 해석한다.
   */
  private _paintChar(
    ctx: CanvasRenderingContext2D,
    cmd: Extract<DrawCommand, { kind: 'char' }>,
    engine: ParagraphEngine,
    colorRegistry: ColorRegistry,
    ppm: number,
    bleedMm: number,
  ): void {
    const rs = cmd.runStyle;
    const inline = rs.inlineStyle;
    const ts: TextStyle = rs.paragraph.textStyle ?? {};
    const inherit = (rs.paragraph.inheritStyle ?? {}) as Partial<InheritStyle>;

    const fontFamilyName = inline?.fontFamily ?? ts.fontFamily ?? inherit.fontFamily;
    let family = 'sans-serif';
    try {
      family = fontFamilyName ? fontLoaderGetFamily(fontFamilyName) : fontLoaderGetFamily(undefined);
    } catch {
      // 폰트 로더 미준비 — 기본 폰트(sans-serif)로 그리고 폰트별 게이트가 재페인트를 담당한다.
    }
    const fontSizeMm = cmd.fontSizeMm;
    const fontWeight = inline?.fontWeight ?? ts.fontWeight ?? inherit.fontWeight ?? 400;
    const fontStyle = inline?.fontStyle ?? ts.fontStyle ?? inherit.fontStyle ?? 'normal';
    const fontSizePx = fontSizeMm * ppm;

    const colorName = inline?.color ?? ts.color ?? inherit.color ?? '';
    const cssColor = colorName !== '' ? colorRegistry.getCSSColor(colorName) : '#000000';

    const xPx = (bleedMm + cmd.lineLeftMm + cmd.charOffsetMm) * ppm;
    // baseline = 라인 top + verticalOffset(하단 앵커 상자 top) + ascent
    const boxTopMm = cmd.lineTopMm + engine._getCharVerticalOffset(cmd.lineMaxFontSizeMm, fontSizeMm);
    const ascentMm = engine.getCharAscentMm(inline, fontSizeMm);
    const baselinePx = (boxTopMm + ascentMm) * ppm;

    const wr = inline?.widthRatio ?? engine.widthRatio;
    const ol = (inline?.outline ?? ts.outline ?? inherit.outline ?? 0) * fontSizeMm;

    ctx.save();
    ctx.font = `${fontStyle} ${fontWeight} ${fontSizePx}px ${family}`;
    ctx.fillStyle = cssColor;
    if (ol > 0) {
      const outlineColorName = inline?.outlineColor ?? inline?.color ?? ts.color ?? inherit.color ?? colorName;
      ctx.strokeStyle = outlineColorName !== '' ? colorRegistry.getCSSColor(outlineColorName) : cssColor;
      ctx.lineWidth = ol * 2 * ppm;
      ctx.strokeText(cmd.char, xPx, baselinePx);
    }
    // 장평: DOM 경로의 scale(wr*0.88)과 동일 계수 — transformOrigin "0 center"를
    // canvas에서는 baseline 기준 수평 scale로 재현한다.
    ctx.translate(xPx, baselinePx);
    ctx.scale(wr * 0.88, 1);
    ctx.fillText(cmd.char, 0, 0);
    ctx.restore();
  }

  /** 장식선 명령을 fillRect로 그린다. */
  private _paintDeco(
    ctx: CanvasRenderingContext2D,
    cmd: Extract<DrawCommand, { kind: 'deco' }>,
    colorRegistry: ColorRegistry,
    ppm: number,
    bleedMm: number,
  ): void {
    const cssColor = cmd.colorName !== '' ? colorRegistry.getCSSColor(cmd.colorName) : '#000000';
    ctx.save();
    ctx.fillStyle = cssColor;
    ctx.fillRect(
      (bleedMm + cmd.xMm) * ppm,
      cmd.yMm * ppm,
      cmd.widthMm * ppm,
      cmd.heightMm * ppm,
    );
    ctx.restore();
  }

  /**
   * 폰트 로드 게이트 — 명령이 소비하는 모든 패밀리의 `FontFace.loaded`가
   * 해석됐는지 판정한다 (§8 — document.fonts.ready는 후행 추가 폰트를
   * 커버하지 못하므로 폰트별 게이트).
   */
  private _fontsReadyFor(engine: ParagraphEngine, fontLoader: FontLoader): boolean {
    if (!fontLoader.ready) return false;
    const families = new Set<string>();
    const collect = (rs: { inlineStyle?: { fontFamily?: string } | undefined; paragraph: { textStyle: { fontFamily?: string }; inheritStyle?: { fontFamily?: string } | undefined } }) => {
      const f = rs.inlineStyle?.fontFamily ?? rs.paragraph.textStyle.fontFamily ?? rs.paragraph.inheritStyle?.fontFamily;
      if (f) families.add(f);
    };
    for (const c of engine.drawList.chars) collect(c.runStyle);
    try {
      for (const face of fontLoader.fontFaces) {
        void face;
      }
    } catch { /* ready false — 이미 게이트에서 걸러짐 */ }
    // FontLoader가 FontFace를 document.fonts에 등록하므로 패밀리별 check()로 판정.
    if (typeof document !== 'undefined' && document.fonts) {
      for (const family of families) {
        if (!document.fonts.check(`16px ${family}`)) return false;
      }
    }
    return true;
  }

  private _findPageElement(): { engine?: { ppm: number } } | null {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el.localName === 'x-layout-page' || el.localName === 'x-layout-document') {
        const engine = (el as unknown as { engine?: { ppm: number } }).engine;
        if (engine) return el as unknown as { engine?: { ppm: number } };
      }
      el = el.parentElement;
    }
    return null;
  }

  private _findColorRegistry(): ColorRegistry | null {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el.localName === 'x-layout-document') {
        const res = (el as unknown as { resources?: { colorRegistry?: ColorRegistry } }).resources;
        if (res?.colorRegistry) return res.colorRegistry;
      }
      el = el.parentElement;
    }
    try {
      return ColorRegistry.getInstance();
    } catch {
      return null;
    }
  }

  private _findFontLoader(): FontLoader | null {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el.localName === 'x-layout-document') {
        const res = (el as unknown as { resources?: { fontLoader?: FontLoader } }).resources;
        if (res?.fontLoader) return res.fontLoader;
      }
      el = el.parentElement;
    }
    try {
      return FontLoader.getInstance();
    } catch {
      return null;
    }
  }
}

/**
 * FontLoader 싱글톤에서 패밀리명을 조회한다 — 인라인 폰트 패밀리 →
 * 등록된 FontFace.family 변환은 DOM 경로(`genCharStyle` 소비처)와 동일
 * 체인을 유지해야 한다.
 *
 * @param fontName - 문단 데이터의 fontFamily 이름 (빈 문자열이면 기본 폰트)
 * @returns 등록된 FontFace 패밀리명
 * @throws 없음 — 로더 미준비면 빈 문자열 (paint가 sans-serif로 폴백)
 */
function fontLoaderGetFamily(fontName?: string): string {
  try {
    return FontLoader.getInstance().getFontFamily(fontName || undefined);
  } catch {
    return fontName || '';
  }
}

customElements.define('x-layout-canvas', LayoutCanvasElement);