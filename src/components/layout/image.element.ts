import { InheritStyle, ImageData, ImageObjectFit, PrintPostData } from "@/types";
import { LayoutBoxElement } from "./box.element";
import { genUUID } from "@/utils";
import { DEFAULT_IMAGE_DPI } from "@/constants";

/**
 * URL 로더 함수 타입.
 *
 * 원본 URL을 받아 실제로 로드할 URL로 변환한다. 동기 또는 비동기로 동작할 수 있으며,
 * 인쇄 모드처럼 인라인 데이터(`base64Data`)를 직접 반환하는 시나리오도 지원한다.
 *
 * @param url 원본 URL (`ImageData.url`)
 * @param data 이미지 데이터 전체. 로더가 컨텍스트(예: `base64Data`, `dpi`)를 참조할 때 사용
 * @returns 실제로 로드할 URL 문자열, 또는 로드하지 않을 경우 `undefined`/`null`
 *
 * @example
 * ```ts
 * // 동기 변환 예: CDN 경로로 치환
 * LayoutImageElement.urlLoader = (url) => `https://cdn.example.com/${url}`;
 *
 * // 비동기 변환 예: 서버에서 서명된 URL 발급
 * LayoutImageElement.urlLoader = async (url) => {
 *   const res = await fetch(`/api/sign?url=${encodeURIComponent(url)}`);
 *   const { signedUrl } = await res.json();
 *   return signedUrl;
 * };
 *
 * // 인쇄 모드: base64Data를 직접 반환
 * LayoutImageElement.urlLoader = (_url, data) => data.base64Data;
 * ```
 */
export type URLLoader = (
  url: string,
  data: ImageData,
) => string | null | undefined | Promise<string | null | undefined>;

/**
 * 이미지 크롭 렌더링 요소. `<x-layout-image>` 커스텀 엘리먼트.
 *
 * `ImageData`를 받아 `<canvas>`를 사용해 크롭된 이미지를 렌더링한다.
 * 원본 이미지에서 `x`, `y`, `width`, `height`로 정의된 영역을
 * `dpi`를 기준으로 mm 단위로 변환하여 표시한다.
 *
 * ### Custom URL Loader
 *
 * 정적 멤버 `LayoutImageElement.urlLoader`에 {@link URLLoader}를 설정하면,
 * `render()` 시점에 원본 URL(`ImageData.url`)을 loader를 거쳐 실제 로드할 URL로 변환한다.
 * loader가 설정되지 않으면 원본 URL을 그대로 사용한다(기존 동작).
 * loader는 모든 이미지 요소 인스턴스에서 공유된다.
 *
 * @example
 * ```ts
 * // 로더 설정
 * LayoutImageElement.urlLoader = (url) => `https://cdn.example.com/${url}`;
 *
 * // 로더 해제 (원본 URL 직접 사용)
 * LayoutImageElement.urlLoader = undefined;
 * ```
 */
export class LayoutImageElement extends HTMLElement {
  private _inheritStyle?: InheritStyle;
  private _styleRule?: CSSStyleRule;

  private _canvas?: HTMLCanvasElement;
  private _shadowRoot: ShadowRoot;

  private _x?: number;
  private _y?: number;
  private _width?: number;
  private _height?: number;
  private _dpi: number = DEFAULT_IMAGE_DPI;
  private _url?: string;
  private _zIndex: number = 0;
  private _overlapPadding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  private _objectUrl?: string;
  private _originalWidth?: number;
  private _originalHeight?: number;
  private _objectFit: ImageObjectFit = 'cover';

  /**
   * 캐싱된 `HTMLImageElement`. `render()`가 호출될 때마다 `new Image()`를 만들고
   * `onload`를 기다리는 비용을 피하기 위해, 한 번 로드한 이미지를 재사용한다.
   * 캐시 키는 `_cachedImageSrc`이며, `url`이나 `urlLoader` 결과가 바뀌면 무효화된다.
   */
  private _cachedImage?: HTMLImageElement;

  /**
   * `_cachedImage`가 로드된 resolved URL.
   * `_resolveUrl()` 결과와 비교하여 캐시 유효성을 판정한다.
   */
  private _cachedImageSrc?: string;

  /**
   * 진행 중인 이미지 로드 Promise. 같은 URL에 대한 `render()` 동시 호출 시
   * 중복 네트워크 요청을 방지한다.
   */
  private _imageLoadingPromise?: Promise<HTMLImageElement | null>;

  /**
   * 캐싱된 `_resolveUrl()` 결과. `url`이 바뀌지 않는 한 재계산하지 않아
   * `render()`가 완전 동기 경로로 실행될 수 있다.
   */
  private _cachedResolvedUrl?: string | null;

  /**
   * 전역 URL 로더. 모든 `LayoutImageElement` 인스턴스가 공유한다.
   *
   * `undefined`가 아니면 `render()` 시점에 원본 URL(`ImageData.url`)을 로더에 전달하여
   * 실제로 로드할 URL을 얻는다. `undefined`면 원본 URL을 그대로 사용한다.
   *
   * @example
   * ```ts
   * LayoutImageElement.urlLoader = async (url) => fetchSignedUrl(url);
   * ```
   */
  static urlLoader?: URLLoader;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    this.layout();
  }

  disconnectedCallback() {
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = undefined;
    }
    this._clearImageCache();
  }

  /**
   * 구조 계산: 스타일 규칙 생성 및 캔버스 요소 생성.
   * 첫 호출 시 `<style>`과 `<canvas>`를 shadow DOM에 추가한다.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected) return;

    if (!this.parentModel || !this._inheritStyle) return;

    if (!this._styleRule) {
      const styleEl = document.createElement("style");
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);
      styleEl.sheet.insertRule(`@media print { :host { visibility: hidden; } }`, 1);
      this._styleRule = styleEl.sheet.cssRules[0] as CSSStyleRule;

      this._shadowRoot.appendChild(document.createElement('slot'));

      this._canvas = document.createElement('canvas');
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
        this._canvas.style,
        {
          backgroundColor: 'transparent',
          height: "100%",
          width: "100%",
        }
      );
      this.appendChild(this._canvas);
    }
  }

  /**
   * CSS 스타일 적용: 이미지 위치/크기/z-index 스타일을 갱신한다.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _applyStyle() {
    if (!this.isConnected) return;
    if (!this.parentModel || !this._inheritStyle) return;

    const paddingTop = this._inheritStyle.paddingTop || 0;

    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      this._styleRule!.style,
      {
        display: 'flex',
        height: `${this.absHeight}mm`,
        left: `${this.relLeft}mm`,
        position: 'absolute',
        top: `${paddingTop}mm`,
        width: `${this.absWidth}mm`,
        zIndex: `${this.zIndex + 100}`,
      }
    );
  }

  /**
   * 레이아웃 오케스트레이터. `_layoutStructure()`와 `_applyStyle()`를 순서대로 호출한다.
   * 기존 호출자와의 호환성을 위해 유지한다.
   */
  layout() {
    if (!this.isConnected) return;

    this._layoutStructure();
    this._applyStyle();
  }

  /**
   * 캔버스 이미지 렌더링: 원본 이미지에서 크롭 영역을 추출하여 캔버스에 그린다.
   * `dpi`를 기준으로 픽셀/mm 변환을 수행한다.
   *
   * 깜빡임 방지를 위해 캔버스를 먼저 비우지 않는다. `_drawImage()`가 새 캔버스
   * 크기가 기존과 다를 때만 `width`/`height`를 설정(이때 내용이 지워진 뒤 즉시
   * `drawImage`로 채운다)하고, 크기가 같으면 `clearRect` + `drawImage`로
   * 교체한다. 캐시 히트 시에는 `await` 없이 완전 동기로 실행되므로 빈 프레임이
   * 노출되지 않는다.
   *
   * `urlLoader`가 설정되어 있으면 원본 URL을 loader에 전달하여 실제 로드할 URL을
   * 얻는다. loader가 `null`/`undefined`를 반환하면 이미지를 로드하지 않는다.
   */
  async render() {
    if (!this.isConnected || !this.canvas) return;

    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

    if (!this.url) {
      this._cachedResolvedUrl = null;
      this._fillTransparent(ctx);
      return;
    }

    // 캐시된 resolved URL이 있으면 await 없이 동기 경로로 진행
    let resolvedUrl: string | null | undefined;
    if (this._cachedResolvedUrl !== undefined && this._cachedResolvedUrl !== null) {
      resolvedUrl = this._cachedResolvedUrl;
    } else {
      resolvedUrl = await this._resolveUrl(this.url);
      this._cachedResolvedUrl = resolvedUrl;
    }

    if (!resolvedUrl) {
      this._clearImageCache();
      this._fillTransparent(ctx);
      return;
    }

    // 캐시 히트: 동기 drawImage (await 없음, 빈 프레임 없음)
    if (this._cachedImage && this._cachedImageSrc === resolvedUrl) {
      this._drawImage(ctx, this._cachedImage);
      return;
    }

    // 캐시 미스: 로드 후 그리기
    this._clearImageCache();
    if (this._objectUrl && this._objectUrl !== resolvedUrl) {
      URL.revokeObjectURL(this._objectUrl);
    }
    if (resolvedUrl.startsWith('blob:')) {
      this._objectUrl = resolvedUrl;
    }

    const img = await this._loadImage(resolvedUrl);
    if (!img) return;
    this._drawImage(ctx, img);
  }

  /**
   * 캔버스를 투명하게 채운다. 캔버스 크기를 유지하면서 `clearRect`만 수행하여
   * 불필요한 리사이즈로 인한 깜빡임을 방지한다.
   */
  private _fillTransparent(ctx: CanvasRenderingContext2D): void {
    ctx.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
  }

  /**
   * `HTMLImageElement`를 로드하고 캐싱한다.
   * 같은 `src`에 대한 동시 호출은 진행 중인 Promise를 재사용하여 중복 네트워크
   * 요청을 방지한다.
   *
   * @param src - 로드할 이미지 URL
   * @returns 로드된 `HTMLImageElement`. 로드 실패 시 `null`
   */
  private _loadImage(src: string): Promise<HTMLImageElement | null> {
    if (this._imageLoadingPromise && this._cachedImageSrc === src) {
      return this._imageLoadingPromise;
    }

    this._imageLoadingPromise = new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        this._cachedImage = img;
        this._cachedImageSrc = src;
        this._imageLoadingPromise = undefined;
        resolve(img);
      };
      img.onerror = () => {
        this._imageLoadingPromise = undefined;
        resolve(null);
      };
      img.src = src;
    });
    return this._imageLoadingPromise;
  }

  /**
   * 캔버스에 크롭 영역을 그린다. `objectFit`이 `'none'`이 아니고 원본 크기를
   * 알면 `_computeObjectFit()`으로 크롭 영역을 재계산한다.
   *
   * 깜빡임 방지: 새 캔버스 크기가 기존과 같으면 `clearRect` + `drawImage`로
   * 교체하고, 다르면 `width`/`height`를 설정한 뒤 즉시 `drawImage`로 채운다.
   * `width`/`height` 설정 시 캔버스가 지워지지만 다음 줄에서 바로 그리므로
   * 빈 프레임이 노출되지 않는다.
   *
   * @param ctx - 캔버스 2D 컨텍스트
   * @param img - 원본 이미지
   */
  private _drawImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement): void {
    const dpi = this.dpi;
    const ppm = dpi / 25.4;
    const canvas = this.canvas!;

    if (this._objectFit === 'none') {
      // objectFit 'none': x/y/width/height are mm-based display position and size.
      // Defaults: x=0, y=0, width=box width, height=box height.
      const dx = Math.round((this._x ?? 0) * ppm);
      const dy = Math.round((this._y ?? 0) * ppm);
      const dw = Math.round((this._width ?? this.absWidth) * ppm);
      const dh = Math.round((this._height ?? this.absHeight) * ppm);

      const canvasW = Math.round(this.absWidth * ppm);
      const canvasH = Math.round(this.absHeight * ppm);

      if (canvas.width !== canvasW || canvas.height !== canvasH) {
        canvas.width = canvasW;
        canvas.height = canvasH;
      } else {
        ctx.clearRect(0, 0, canvasW, canvasH);
      }

      const origW = this._originalWidth ?? img.naturalWidth;
      const origH = this._originalHeight ?? img.naturalHeight;

      try {
        ctx.drawImage(
          img,
          0, 0, origW, origH,
          dx, dy, dw, dh,
        );
      } catch (_) {
        // drawImage 실패 — 무시
      }
      return;
    }

    // objectFit cover/contain/fill: compute source crop in mm, convert to px.
    // x/y/width/height are optional internal crop coordinates (default 0).
    let drawX = this._x ?? 0;
    let drawY = this._y ?? 0;
    let drawW = this._width ?? 0;
    let drawH = this._height ?? 0;

    if (this._originalWidth && this._originalHeight) {
      const fit = this._computeObjectFit(
        this._objectFit,
        this.absWidth, this.absHeight,
        this._originalWidth, this._originalHeight,
        ppm,
      );
      drawX = fit.x;
      drawY = fit.y;
      drawW = fit.width;
      drawH = fit.height;
    }

    const sx = Math.round(drawX * ppm);
    const sy = Math.round(drawY * ppm);
    const sWidth = Math.round(drawW * ppm);
    const sHeight = Math.round(drawH * ppm);

    if (canvas.width !== sWidth || canvas.height !== sHeight) {
      canvas.width = sWidth;
      canvas.height = sHeight;
    } else {
      ctx.clearRect(0, 0, sWidth, sHeight);
    }

    try {
      ctx.drawImage(
        img,
        sx, sy, sWidth, sHeight,
        0, 0, sWidth, sHeight
      );
    } catch (_) {
      // drawImage 실패 — 무시
    }
  }

  /**
   * 이미지 캐시를 무효화한다. `url`/`data` 세터 변경이나 `disconnectedCallback`
   * 시 호출하여 새 이미지를 강제로 로드하게 한다.
   */
  private _clearImageCache(): void {
    this._cachedImage = undefined;
    this._cachedImageSrc = undefined;
    this._imageLoadingPromise = undefined;
    this._cachedResolvedUrl = undefined;
  }

  /**
   * object-fit 모드에 따라 크롭 영역(mm)을 계산한다.
   *
   * - `'cover'`: box를 채우면서 비율 유지. 넘치는 부분 크롭, 중앙 정렬.
   * - `'fill'`: box에 맞춰 늘림. 비율 무시. 전체 원본 사용.
   * - `'contain'`: box 안에 전체 이미지 표시. 여백 발생, 중앙 정렬.
   *
   * @param fit - object-fit 모드
   * @param boxWmm - box 너비 (mm)
   * @param boxHmm - box 높이 (mm)
   * @param origW - 원본 이미지 너비 (픽셀)
   * @param origH - 원본 이미지 높이 (픽셀)
   * @param ppm - 픽셀/mm 변환 비율 (dpi / 25.4)
   * @returns `{ x, y, width, height }` (mm 단위)
   *
   * @example
   * ```ts
   * // cover: box 55×35mm, image 800×600px, dpi 72
   * // → ppm=2.835, boxWpx=156, boxHpx=99
   * // → imgAspect 1.33 < boxAspect 1.57 → 너비 기준, 상하 크롭
   * // → cropHPx=509, cropHmm=179.6, y=16.2mm
   * ```
   */
  private _computeObjectFit(
    fit: ImageObjectFit,
    boxWmm: number,
    boxHmm: number,
    origW: number,
    origH: number,
    ppm: number,
  ): { x: number; y: number; width: number; height: number } {
    const origWmm = origW / ppm;
    const origHmm = origH / ppm;

    if (fit === 'fill') {
      return { x: 0, y: 0, width: boxWmm, height: boxHmm };
    }

    const boxWpx = boxWmm * ppm;
    const boxHpx = boxHmm * ppm;
    const boxAspect = boxWpx / boxHpx;
    const imgAspect = origW / origH;

    if (fit === 'cover') {
      if (imgAspect > boxAspect) {
        const scale = boxHpx / origH;
        const cropWPx = Math.round(boxWpx / scale);
        return {
          x: Math.round((origW - cropWPx) / 2) / ppm,
          y: 0,
          width: cropWPx / ppm,
          height: origHmm,
        };
      }
      const scale = boxWpx / origW;
      const cropHPx = Math.round(boxHpx / scale);
      return {
        x: 0,
        y: Math.round((origH - cropHPx) / 2) / ppm,
        width: origWmm,
        height: cropHPx / ppm,
      };
    }

    // contain
    if (imgAspect > boxAspect) {
      const scale = boxWpx / origW;
      const fittedHPx = Math.round(boxHpx / scale);
      return {
        x: 0,
        y: Math.round((fittedHPx - origH) / 2) / ppm,
        width: origWmm,
        height: origHmm,
      };
    }
    const scale = boxHpx / origH;
    const fittedWPx = Math.round(boxWpx / scale);
    return {
      x: Math.round((fittedWPx - origW) / 2) / ppm,
      y: 0,
      width: origWmm,
      height: origHmm,
    };
  }

  /**
   * 원본 URL을 로더를 거쳐 실제 로드할 URL로 변환한다.
   *
   * @param url 원본 URL (`ImageData.url`)
   * @returns 실제로 로드할 URL. `null`/`undefined`면 로드하지 않음
   */
  private async _resolveUrl(url: string): Promise<string | null | undefined> {
    const loader = LayoutImageElement.urlLoader;
    if (!loader) return url;
    const result = await loader(url, this.data);
    return result;
  }

  set data(data: ImageData) {
    if (data.id !== undefined) this.id = data.id;
    if (data.zIndex !== undefined) this._zIndex = data.zIndex;
    if (data.overlapPadding !== undefined) this._overlapPadding = data.overlapPadding;

    const urlChanged = this._url !== data.url;
    this._x = data.x;
    this._y = data.y;
    this._width = data.width;
    this._height = data.height;
    this._dpi = data.dpi;
    this._url = data.url;
    this._originalWidth = data.originalWidth;
    this._originalHeight = data.originalHeight;
    this._objectFit = data.objectFit ?? 'cover';

    if (urlChanged) {
      this._clearImageCache();
    }

    this.layout();
    this.render();
  }

  set x(value: number | undefined) {
    if (this._x === value) return;
    this._x = value;
    this.render();
  }

  set y(value: number | undefined) {
    if (this._y === value) return;
    this._y = value;
    this.render();
  }

  set width(value: number | undefined) {
    if (this._width === value) return;
    this._width = value;
    this.render();
  }

  set height(value: number | undefined) {
    if (this._height === value) return;
    this._height = value;
    this.render();
  }

  set dpi(value: number) {
    if (this._dpi === value) return;
    this._dpi = value;
    this.render();
  }

  set url(value: string | undefined) {
    if (this._url === value) return;
    this._url = value;
    this._clearImageCache();
    this.render();
  }

  set zIndex(value: number) {
    if (this._zIndex === value) return;
    this._zIndex = value;
    this.layout();
    this.render();
    this.parentElement?.requestRerenderAffectedParagraphs();
  }

  set overlapPadding(value: number | { top?: number; right?: number; bottom?: number; left?: number } | undefined) {
    if (this._overlapPadding === value) return;
    this._overlapPadding = value;
    this.layout();
    this.render();
    this.parentElement?.requestRerenderAffectedParagraphs();
  }

  get overlapPadding() {
    return this._overlapPadding;
  }

  set originalWidth(value: number | undefined) {
    this._originalWidth = value;
  }

  get originalWidth(): number | undefined {
    return this._originalWidth;
  }

  set originalHeight(value: number | undefined) {
    this._originalHeight = value;
  }

  get originalHeight(): number | undefined {
    return this._originalHeight;
  }

  set objectFit(value: ImageObjectFit) {
    if (this._objectFit === value) return;
    this._objectFit = value;
    this.render();
  }

  get objectFit(): ImageObjectFit {
    return this._objectFit;
  }

  get data() {
    return {
      id: this.id,
      zIndex: this._zIndex,
      overlapPadding: this._overlapPadding,
      x: this._x,
      y: this._y,
      width: this._width,
      height: this._height,
      dpi: this._dpi,
      url: this._url || '',
      originalWidth: this._originalWidth,
      originalHeight: this._originalHeight,
      objectFit: this._objectFit,
      type: this.type,
    };
  }

  get x() { return this._x; }
  get y() { return this._y; }
  get width() { return this._width; }
  get height() { return this._height; }
  get dpi() { return this._dpi; }
  get url() { return this._url; }
  get zIndex() { return this._zIndex; }

  get canvas() { return this._canvas; }
  get type() { return 'image' as const; }

  get parentElement() {
    return super.parentElement as LayoutBoxElement;
  }

  get parentModel() {
    return this.parentElement?.model;
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.layout();
    // absWidth/absHeight는 inheritStyle.parentWidth/parentHeight에 의존하므로
    // 상위 box의 크기/여백 변경 시 이미지 캔버스 크기와 크롭 영역이 달라진다.
    // layout()은 CSS 위치/크기만 갱신하므로 render()로 캔버스 픽셀을 다시 그려야 한다.
    this.render();
  }

  get inheritStyle() {
    return this._inheritStyle;
  }

  get relLeft() {
    return this._inheritStyle?.paddingLeft || 0;
  }

  get relTop() {
    if (!this._inheritStyle || !this.parentModel) return 0;
    return this._inheritStyle.paddingTop || 0;
  }

  get absLeft(): number {
    return this.parentElement.absLeft + this.relLeft;
  }

  get absTop(): number {
    return this.parentElement.absTop + this.relTop;
  }

  get absWidth() {
    if (!this._inheritStyle) return 0;
    return this._inheritStyle.parentWidth;
  }

  get absHeight() {
    if (!this._inheritStyle) return 0;
    return this._inheritStyle.parentHeight;
  }

  get overlayElements() {
    return this.parentElement.overlayElements;
  }

  get printPostData(): PrintPostData[] {
    const rect = this.getBoundingClientRect();
    return [{
      data: this.data,
      rect: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height
      }
    }];
  }
}
customElements.define("x-layout-image", LayoutImageElement);