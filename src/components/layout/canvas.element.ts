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
import { DEFAULT_CANVAS_DRAW_MODE } from "@/constants/defaults";

const HOST_STYLE_ID = '__layout_canvas_style__';

/** DPR 캡 — §8 메모리/DPR 정책 (backing store 과다 방지). */
const MAX_DEVICE_PIXEL_RATIO = 2;

/** 걸침 돌출 bleed (mm) — 행두/행말 돌출량 상한 근사(글자 폭 ≤ 라인 폭 전제). */
const HANG_BLEED_MM = 20;

/** 글리프 Path2D LRU 캐시 용량 — 폰트×글자 조합 (문서 스케일에서 충분). */
const GLYPH_PATH_CACHE_CAPACITY = 8000;

/** 글리프 Path2D 캐시 — `(fontId|char)` 키, unitsPerEm 좌표계 경로. */
const glyphPathCache = new Map<string, Path2D | null>();

/** cmap 미등록 글자 판정 캐시 — `(fontId|char)` → gid 0 여부. */
const unmappedCharCache = new Map<string, boolean>();

/** 파싱 폰트 객체 → 안정적 캐시 키. WeakMap으로 객체 수명에 추종한다. */
const parsedFontIds = new WeakMap<object, number>();
let parsedFontIdSeq = 0;
function fontIdOf(parsedFont: object): number {
  let id = parsedFontIds.get(parsedFont);
  if (id === undefined) {
    id = parsedFontIdSeq++;
    parsedFontIds.set(parsedFont, id);
  }
  return id;
}

/**
 * 가변 폰트(wght variation 축) 여부 — synthetic bold 판정에 소비한다.
 * 축이 있으면 wght 경로가 굵기를 소유하고, 없으면 정적 폰트로 synthetic
 * bold(fill+stroke 획 확장)가 그 책임을 이어받는다.
 *
 * @param parsedFont - 파싱된 폰트
 * @returns wght 축 보유 여부
 */
function hasWeightAxis(parsedFont: NonNullable<ReturnType<FontLoader['getParsedFont']>>): boolean {
  try {
    const fvar = (parsedFont as unknown as { tables?: { fvar?: { axes?: { tag?: string }[] } } }).tables?.fvar;
    return !!fvar?.axes?.some(a => a.tag === 'wght');
  } catch {
    return false;
  }
}

/**
 * opentype 글리프 경로를 unitsPerEm 좌표계 Path2D로 변환해 캐시한다.
 *
 * opentype `getPath(x, y, fontSize, { xScale, yScale })`의 기본 스케일은
 * `fontSize / unitsPerEm`이고 `xScale: 1, yScale: 1`을 지정하면 폰트 원본
 * 좌표(unitsPerEm 스케일)가 유지된다. `getPath`가 이미 y-up 폰트 좌표계를
 * y-down 캔버스 좌표계로 반전(`-cmd.y`)하므로, 이 경로를 baseline 기준
 * 페인트에 그대로 쓸 수 있다. 폰트 크기 무관 재사용 — 페인트가
 * `ctx.scale(fontSizePx / unitsPerEm)`으로 변환한다.
 *
 * **weight 정합**: `toPathData(options, font)`는 `font` 인자가 있어야
 * `font.variation.getTransform(glyph, options.variation)`으로 가변 폰트
 * 변형(wght)을 적용한다 — font 미전달 시 기본 weight(400) 경로로 캐시되어
 * 굵게 주입이 시각적으로 무시된다. 캐시 키에 weight를 포함해 글리프×weight
 * 조합별로 경로를 분리한다.
 *
 * @param parsedFont - 파싱된 폰트
 * @param char - 글자
 * @param weight - 요청 fontWeight (가변 폰트의 wght 축 값 — 정적 폰트는 무시)
 * @returns 캐시된 Path2D. 경로 없는 글리프(빈 명령)면 null
 */
function glyphPathOf(
  parsedFont: NonNullable<ReturnType<FontLoader['getParsedFont']>>,
  char: string,
  weight: number,
): Path2D | null {
  const key = `${fontIdOf(parsedFont)}|${char}|${weight}`;
  const cached = glyphPathCache.get(key);
  if (cached !== undefined) return cached;

  let result: Path2D | null = null;
  try {
    const glyph = parsedFont.charToGlyph(char) as unknown as {
      toPathData(options?: object, font?: unknown): string;
    };
    // flipYBase: 0 필수 — toPathData 기본(flipY:true, flipYBase undefined)은
    // 글리프 boundingBox 중심(y1+y2)을 기준으로 y를 반전해 bbox top이 0에
    // 정렬된 경로를 만든다 (실측: bench 4mm에서 라인 전체 +9px 하강 — G9 판정
    // 역방향 증명 완료). flipYBase 0은 y_down = -y_up(baseline 기준)으로
    // 변환해 getPath의 y-down 좌표계와 동일해진다 — baseline 페인트 계약.
    // font 인자 + variation: 가변 폰트의 wght 축을 페인트 시점에 해석한다.
    const d = glyph.toPathData({
      decimalPlaces: 3, optimize: false, flipY: true, flipYBase: 0,
      variation: { wght: weight },
    }, parsedFont);
    if (d.length > 0) {
      result = new Path2D(d);
    }
  } catch {
    result = null;
  }

  if (glyphPathCache.size >= GLYPH_PATH_CACHE_CAPACITY) {
    const oldest = glyphPathCache.keys().next();
    if (!oldest.done) glyphPathCache.delete(oldest.value);
  }
  glyphPathCache.set(key, result);
  return result;
}

/**
 * cmap 미등록 글자 판정 (엔진 `_isUnmappedHangulSyllable`과 동일 판정을
 * 페인트 측에서 수행 — 결과만 캐시한다). 미등록이면 `.notdef`(사각형 박스
 * 글리프) 대신 기준 글자 `가` 글리프로 그린다 — 엔진 폭 폴백(`가` 폭 대체)
 * 과 화면 기하의 정합 계약.
 *
 * @param parsedFont - 파싱된 폰트
 * @param char - 글자
 * @returns 미등록 글자 여부
 */
function isUnmappedChar(parsedFont: NonNullable<ReturnType<FontLoader['getParsedFont']>>, char: string): boolean {
  const key = `${fontIdOf(parsedFont)}|${char}`;
  const cached = unmappedCharCache.get(key);
  if (cached !== undefined) return cached;
  let result = false;
  try {
    result = parsedFont.charToGlyphIndex(char) === 0;
  } catch {
    result = false;
  }
  if (unmappedCharCache.size >= GLYPH_PATH_CACHE_CAPACITY) {
    const oldest = unmappedCharCache.keys().next();
    if (!oldest.done) unmappedCharCache.delete(oldest.value);
  }
  unmappedCharCache.set(key, result);
  return result;
}

export class LayoutCanvasElement extends HTMLElement {
  private _shadowRoot: ShadowRoot;
  private _canvas: HTMLCanvasElement;
  private _styleEl: HTMLStyleElement;
  private _a11yText: HTMLDivElement;
  private _resolutionQuery: MediaQueryList | null = null;
  private _resolutionListener: (() => void) | null = null;

  private _engine: ParagraphEngine | null = null;

  /**
   * 텍스트 드로잉 방식 (CANVAS_RENDERING.md §4.1 A안/B안).
   * - `'fillText'`(기본): 브라우저 래스터라이저에 위임 — 힌팅·서브픽셀을
   *   얻지만 DOM 렌더와 래스터화 차이가 남을 수 있다.
   * - `'glyph'`: opentype.js 글리프 경로를 Path2D로 fill — 배치(advanceWidth)와
   *   래스터화(글리프 윤곽)가 동일 소스. 인쇄 패리티에 유리, 힌팅 없음.
   * 전환 시 `drawMode` setter가 재페인트를 예약한다.
   */
  private _drawMode: 'fillText' | 'glyph' = DEFAULT_CANVAS_DRAW_MODE;

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

  /** 텍스트 드로잉 방식 전환 — 변경 시 즉시 재페인트한다. */
  set drawMode(mode: 'fillText' | 'glyph') {
    if (this._drawMode === mode) return;
    this._drawMode = mode;
    if (this._engine) this.paint();
  }

  get drawMode(): 'fillText' | 'glyph' {
    return this._drawMode;
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
      if (this._drawMode === 'glyph') {
        this._paintCharGlyph(ctx, cmd, engine, colorRegistry, ppm, bleedMm, fontLoader);
      } else {
        this._paintChar(ctx, cmd, engine, colorRegistry, ppm, bleedMm);
      }
    }
    for (const cmd of drawList.decos as Extract<DrawCommand, { kind: 'deco' }>[]) {
      this._paintDeco(ctx, cmd, colorRegistry, ppm, bleedMm);
    }
  }

  /**
   * glyph 모드: opentype.js 글리프 경로(Path2D)로 글자를 fill한다
   * (CANVAS_RENDERING.md §4.1 B안).
   *
   * - 경로는 **unitsPerEm 좌표계**로 글리프당 1개 캐시(glyphPathOf) — 페인트가
   *   `ctx.scale(fontSizePx / unitsPerEm)`으로 변환한다. 배치(advanceWidth)와
   *   래스터화(글리프 윤곽)가 동일 폰트 소스에서 나온다.
   * - 장평은 fillText 경로와 동일 계수 `scale(wr × 0.88)` — DOM span transform
   *   재현.
   * - cmap 미등록 글자(gid 0)는 엔진 폭 폴백(`가` 폭 대체)과의 기하 정합을 위해
   *   기준 글자 `가` 글리프로 그린다 — `.notdef` 사각 박스가 화면에 그려지는
   *   것을 방지한다.
   * - 파싱 폰트 부재/경로 없음/폰트 로더 미준비면 fillText로 폴백한다 —
   *   브라우저 시스템 폴백 글리프가 그 책임을 이어받는다.
   */
  private _paintCharGlyph(
    ctx: CanvasRenderingContext2D,
    cmd: Extract<DrawCommand, { kind: 'char' }>,
    engine: ParagraphEngine,
    colorRegistry: ColorRegistry,
    ppm: number,
    bleedMm: number,
    fontLoader: FontLoader,
  ): void {
    const rs = cmd.runStyle;
    const inline = rs.inlineStyle;
    const ts: TextStyle = rs.paragraph.textStyle ?? {};
    const inherit = (rs.paragraph.inheritStyle ?? {}) as Partial<InheritStyle>;

    const fontFamilyName = inline?.fontFamily ?? ts.fontFamily ?? inherit.fontFamily;
    let parsedFont: ReturnType<FontLoader['getParsedFont']> = null;
    try {
      parsedFont = fontLoader.getParsedFont(fontFamilyName || undefined);
    } catch {
      parsedFont = null;
    }

    const colorName = inline?.color ?? ts.color ?? inherit.color ?? '';
    const cssColor = colorName !== '' ? colorRegistry.getCSSColor(colorName) : '#000000';

    const xPx = (bleedMm + cmd.lineLeftMm + cmd.charOffsetMm) * ppm;
    const fontSizeMm = cmd.fontSizeMm;
    const boxTopMm = cmd.lineTopMm + engine._getCharVerticalOffset(cmd.lineMaxFontSizeMm, fontSizeMm);
    const ascentMm = engine.getCharAscentMm(inline, fontSizeMm);
    const baselinePx = (boxTopMm + ascentMm) * ppm;

    const wr = inline?.widthRatio ?? engine.widthRatio;
    const ol = (inline?.outline ?? ts.outline ?? inherit.outline ?? 0) * fontSizeMm;
    const fontWeight = inline?.fontWeight ?? ts.fontWeight ?? inherit.fontWeight ?? 400;
    const fontStyle = inline?.fontStyle ?? ts.fontStyle ?? inherit.fontStyle ?? 'normal';

    const path = parsedFont
      ? (isUnmappedChar(parsedFont, cmd.char)
        ? glyphPathOf(parsedFont, '가', fontWeight)
        : glyphPathOf(parsedFont, cmd.char, fontWeight))
      : null;

    if (!path || !parsedFont) {
      // 폴백: 파싱 폰트/경로 부재 글자만 브라우저 래스터라이저로 그린다 —
      // 시스템 폴백 글리프가 DOM 경로와 동일한 선택을 따른다.
      this._paintChar(ctx, cmd, engine, colorRegistry, ppm, bleedMm);
      return;
    }

    const unitsPerEm = parsedFont.unitsPerEm > 0 ? parsedFont.unitsPerEm : 1000;
    const fontSizePx = fontSizeMm * ppm;

    ctx.save();
    ctx.fillStyle = cssColor;
    ctx.translate(xPx, baselinePx);
    // italic (synthetic oblique): baseline 고정 수평 shear — 상단이 오른쪽으로
    // 기움. opentype 경로에는 font-style 개념이 없어 브라우저의 synthetic
    // italic(fillText의 ctx.font 'italic' prefix)을 변환으로 재현한다.
    // Chrome synthetic italic 실측 관행 14도 — 12도는 4mm 글자에서 폭 증가가
    // AA 경계에 흡수되어 시각 구분이 어렵다.
    if (fontStyle === 'italic') {
      const skew = Math.tan(14 * Math.PI / 180);
      ctx.transform(1, 0, -skew, 1, 0, 0);
    }
    // 단일 scale 조합: 글자 크기(unitsPerEm→px) × 장평(0.88 계수 — DOM과 동일).
    ctx.scale((fontSizePx / unitsPerEm) * wr * 0.88, fontSizePx / unitsPerEm);
    if (ol > 0) {
      const outlineColorName = inline?.outlineColor ?? inline?.color ?? ts.color ?? inherit.color ?? colorName;
      ctx.strokeStyle = outlineColorName !== '' ? colorRegistry.getCSSColor(outlineColorName) : cssColor;
      ctx.lineWidth = ol * 2 * ppm;
      ctx.stroke(path);
    }
    ctx.fill(path);
    // synthetic bold — 정적 폰트(단일 FontFace, variation 축 없음)는 wght 700
    // 경로를 가질 수 없다. fillText의 ctx.font '700'이 브라우저 synthetic
    // bold(획 확장)로 그리는 것을 fill+stroke 획 확장으로 재현한다 — 획 두께
    // fontSize의 ~1/30 (Chromium 관행). 가변 폰트는 variation 경로가 소유하므로
    // 이중 확장을 피한다 (stroke는 미세 확장만, outline strokeText와 구분).
    const isSyntheticBold = fontWeight >= 600 && !hasWeightAxis(parsedFont);
    if (isSyntheticBold) {
      ctx.strokeStyle = cssColor;
      // lineWidth는 scale 좌표계(unitsPerEm)에서 해석된다 — scale 이후 stroke이므로
      // 목표 px 두께(fontSizePx/30 × weight 비율)를 scale 역수로 환산한다.
      // 환산 없이 px를 그대로 넣으면 scale 0.015로 실질 소멸한다 (실측: 잉크 0 증가).
      const targetPx = fontSizePx / 30 * (fontWeight / 700);
      ctx.lineWidth = targetPx / ((fontSizePx / unitsPerEm) * wr * 0.88);
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    }
    ctx.restore();
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
    // synthetic italic — 정적 단일 FontFace는 브라우저가 synthetic을 적용하지
    // 않는 케이스가 있어 fillText의 ctx.font 'italic'에 의존하지 않고 임의
    // shear로 소유한다 (glyph 경로와 동일 변환).
    const isItalic = fontStyle === 'italic';
    // synthetic bold — 등록 FontFace가 단일 weight라 브라우저 synthetic이
    // 발동하지 않는 케이스가 있어 fill+stroke 획 확장으로 소유한다.
    const isSyntheticBold = fontWeight >= 600;
    if (isItalic) {
      ctx.transform(1, 0, -Math.tan(1 * Math.PI / 180), 1, 0, 0);
    }
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
    if (isSyntheticBold) {
      // strokeText는 translate 전 좌표 — fillText와 동일 위치에 획 확장한다.
      ctx.translate(xPx, baselinePx);
      ctx.strokeStyle = cssColor;
      ctx.lineWidth = fontSizePx / 30 * (fontWeight / 700);
      ctx.lineJoin = 'round';
      ctx.strokeText(cmd.char, 0, 0);
    }
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