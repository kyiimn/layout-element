import { InheritStyle, ImageData, ImageObjectFit, OverlapMode } from "@/types";
import { LayoutBoxElement } from "./box.element";
import { genUUID, createAiProcessingOverlay, setAiProcessingActive, isAiProcessingActive, removeAiProcessingOverlay, computeObjectFit } from "@/utils";
import { DEFAULT_IMAGE_DPI } from "@/constants";
import { ImageEngine } from "@/engine";

/**
 * URL 로더 함수 타입.
 *
 * 원본 URL을 받아 실제로 로드할 URL로 변환한다. 동기 또는 비동기로 동작할 수 있으며,
 * 인쇄 모드처럼 인라인 데이터(`data:` URL)를 직접 반환하는 시나리오도 지원한다.
 *
 * @param url 원본 URL (`ImageData.url`)
 * @param data 이미지 데이터 전체. 로더가 컨텍스트(예: `dpi`)를 참조할 때 사용
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
 * // 인쇄 모드: data: URL을 직접 반환
 * LayoutImageElement.urlLoader = (url) => `data:image/png;base64,...`;
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
  private _engine?: ImageEngine;

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
  private _overlapMode: OverlapMode = 'path';
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
    createAiProcessingOverlay(this._shadowRoot);
  }

  disconnectedCallback() {
    removeAiProcessingOverlay(this._shadowRoot);
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = undefined;
    }
    // 이미지 캐시(_cachedImage, _cachedImageSrc, _cachedResolvedUrl)를 보존한다.
    //
    // 부모 box/document의 data setter reconcile 과정에서 appendChild가 같은
    // 부모 내에서 요소를 재배치할 때 브라우저가 disconnectedCallback을
    // 트리거한다. 이때 _clearImageCache()를 호출하면 캐시된 HTMLImageElement와
    // resolved URL이 날아가서, 이어지는 connectedCallback → render()가
    // 비동기 재로딩 경로(await _resolveUrl + await _loadImage)로 빠지고
    // canvas가 빈 상태로 페인트되어 이미지 깜빡임이 발생한다.
    //
    // disconnectedCallback은 "DOM에서 분리됨"을 의미할 뿐 "요소가 파괴됨"이
    // 아니므로, 이미지 캐시는 URL 변경(data/url setter)이나 명시적
    // _clearImageCache() 호출 시에만 무효화한다.
    //
    // 엔진을 부모 childEngines에서 splice하지 않는다 — box.element.ts 참조.
    // DocumentEngine._buildTree()가 전체 트리를 재구축하므로 불필요하며,
    // 기존 엔진을 유지하는 편이 재사용 측면에서 더 효율적이다.
  }

  /**
   * 이 이미지에 연결된 ImageEngine 인스턴스를 반환한다.
   *
   * 엔진은 `data` setter에서 생성/갱신되며,
   * RGBA 데이터는 `render()` 후 canvas에서 추출하여 주입된다.
   *
   * @returns ImageEngine 인스턴스. 연결 전이면 undefined.
   */
  get engine(): ImageEngine | undefined { return this._engine; }

  /**
   * 구조 계산: 스타일 규칙 생성 및 캔버스 요소 생성.
   * 첫 호출 시 `<style>`과 `<canvas>`를 shadow DOM에 추가한다.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected) return;

    if (!this.parentModel || !this._inheritStyle) return;

    let styleEl = this._shadowRoot.querySelector('style');
    let needsStyleInit = !styleEl
      || !styleEl.sheet
      || styleEl.sheet.cssRules.length === 0;

    if (needsStyleInit) {
      if (styleEl) styleEl.remove();
      styleEl = document.createElement("style");
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);

      this._shadowRoot.appendChild(document.createElement('slot'));
    }

    if (!this._canvas || !this._canvas.isConnected) {
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

    const styleEl = this._shadowRoot.querySelector('style');
    const hostRule = styleEl!.sheet!.cssRules[0] as CSSStyleRule;
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      hostRule.style,
      {
        display: 'flex',
        height: `${this.absHeight}mm`,
        left: `${this.relLeft}mm`,
        position: 'absolute',
        top: `${paddingTop}mm`,
        width: `${this.absWidth}mm`,
        zIndex: `${this.zIndex}`,
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
      this._feedRgbaToEngine(ctx);
      this._notifyOverlapParagraphs();
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
    if (!img) {
      this._dispatchRenderError('image-load-failed', resolvedUrl);
      return;
    }
    this._drawImage(ctx, img);
    this._feedRgbaToEngine(ctx);

    this._notifyOverlapParagraphs();
  }

  /**
   * canvas에서 RGBA 픽셀 데이터를 추출하여 ImageEngine에 주입한다.
   * 브라우저 모드에서만 호출 — Node 환경에서는 pngjs 결과를 직접 주입.
   */
  private _feedRgbaToEngine(ctx: CanvasRenderingContext2D): void {
    if (!this._engine || !this.canvas) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w <= 0 || h <= 0) return;
    try {
      const imageData = ctx.getImageData(0, 0, w, h);
      const rgbaData = {
        data: new Uint8Array(imageData.data.buffer),
        width: w,
        height: h,
      };
      this._engine.rgbaData = rgbaData;

      const parentBoxEngine = this.parentElement?.engine;
      if (parentBoxEngine) {
        const treeImgEngine = parentBoxEngine.childEngines.find(e => e instanceof ImageEngine) as ImageEngine | undefined;
        if (treeImgEngine && treeImgEngine !== this._engine) {
          treeImgEngine.rgbaData = rgbaData;
        }
      }
    } catch {
      // CORS taint 등 — 엔진은 rgbaData 없이 기하학적 fallback 사용
    }
  }

  /**
   * 이미지 로드 완료 후 오버랩되는 단락에게 재렌더링을 요청한다.
   * 최초 로딩 시 이미지 canvas가 비어 있는 상태에서 단락이 먼저 렌더링되어
   * 오버랩 판정이 누락되는 문제를 해결한다.
   */
  private _notifyOverlapParagraphs(): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.requestRerenderAffectedParagraphs();
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
   * 캔버스에 이미지를 그린다.
   *
   * 원본 이미지 전체를 `width`×`height`(mm) 크기로 리사이즈하여 박스 내
   * `(x, y)` 위치에 배치한다. 캔버스 크기 = 박스 크기이므로 박스 밖 영역은
   * 자동으로 clip되어 크롭 효과를 낸다.
   *
   * 깜빡임 방지: 새 캔버스 크기가 기존과 같으면 `clearRect` + `drawImage`로
   * 교체하고, 다르면 `width`/`height`를 설정한 뒤 즉시 `drawImage`로 채운다.
   *
   * @param ctx - 캔버스 2D 컨텍스트
   * @param img - 로드된 이미지 (work 이미지)
   */
  private _drawImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement): void {
    const ppm = this.dpi / 25.4;
    const canvas = this.canvas!;

    const canvasW = Math.ceil(this.absWidth * ppm);
    const canvasH = Math.ceil(this.absHeight * ppm);

    if (canvas.width !== canvasW || canvas.height !== canvasH) {
      canvas.width = canvasW;
      canvas.height = canvasH;
    } else {
      ctx.clearRect(0, 0, canvasW, canvasH);
    }

    const dx = Math.round((this._x ?? 0) * ppm);
    const dy = Math.round((this._y ?? 0) * ppm);
    const dw = Math.round((this._width ?? this.absWidth) * ppm);
    const dh = Math.round((this._height ?? this.absHeight) * ppm);

    try {
      ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, dw, dh);
    } catch (e) {
      this._dispatchRenderError('image-draw-failed', String(e));
    }
  }

  /**
   * `render-error` CustomEvent를 디스패치한다.
   *
   * @param type - 에러 타입 (`'image-load-failed'` | `'image-draw-failed'`)
   * @param message - 에러 메시지
   */
  private _dispatchRenderError(type: string, message: string): void {
    this.dispatchEvent(new CustomEvent('render-error', {
      detail: { id: this.id, type, message },
      bubbles: true,
      composed: true,
    }));
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
    if (this._engine) {
      this._engine.rgbaData = null;
    }
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

  /**
   * 현재 `objectFit`/`originalWidth`/`originalHeight`와 박스 크기로
   * `x`/`y`/`width`/`height`를 자동 계산하여 저장한다.
   *
   * `originalWidth`/`originalHeight` 또는 `absWidth`/`absHeight`가 0이면
   * 계산을 건너뛴다(초기 라이프사이클 또는 메타데이터 미설정).
   *
   * @returns {void}
   */
  private _applyObjectFit(): void {
    const origW = this._originalWidth ?? 0;
    const origH = this._originalHeight ?? 0;
    const boxW = this.absWidth;
    const boxH = this.absHeight;
    if (origW <= 0 || origH <= 0 || boxW <= 0 || boxH <= 0) return;

    const rect = computeObjectFit({
      fit: this._objectFit,
      originalWidth: origW,
      originalHeight: origH,
      boxWidth: boxW,
      boxHeight: boxH,
    });

    this._x = rect.x;
    this._y = rect.y;
    this._width = rect.width;
    this._height = rect.height;
  }

  set data(data: ImageData) {
    if (data.id !== undefined) this.id = data.id;
    if (data.zIndex !== undefined) this._zIndex = data.zIndex;
    if (data.overlapPadding !== undefined) this._overlapPadding = data.overlapPadding;
    if (data.overlapMode !== undefined) this._overlapMode = data.overlapMode;

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

    if (data.x === undefined && data.y === undefined && data.width === undefined && data.height === undefined) {
      this._applyObjectFit();
    }

    this._updateEngine();

    this.layout();
    this.render();
  }

  /**
   * ImageEngine 인스턴스를 생성/갱신한다.
   */
  private _updateEngine(): void {
    const parentBox = this.parentElement;
    const parentBoxEngine = parentBox?.engine;
    const existing = parentBoxEngine?.childEngines.find(e => e instanceof ImageEngine);
    if (existing && this._engine !== existing) {
      const preservedRgba = this._engine?.rgbaData ?? null;
      this._engine = existing;
      if (preservedRgba && !existing.rgbaData) {
        existing.rgbaData = preservedRgba;
      }
    }

    const engineData = {
      url: this._url || '',
      x: this._x,
      y: this._y,
      width: this._width,
      height: this._height,
      dpi: this._dpi,
      overlapPadding: this._overlapPadding,
      overlapMode: this._overlapMode,
      objectFit: this._objectFit,
      originalWidth: this._originalWidth,
      originalHeight: this._originalHeight,
    };
    if (!this._engine) {
      this._engine = ImageEngine.create(engineData);
      if (parentBoxEngine) {
        parentBoxEngine.childEngines = [...parentBoxEngine.childEngines, this._engine];
      }
    } else {
      this._engine.data = engineData;
    }
  }

  set x(value: number | undefined) {
    if (this._x === value) return;
    this._x = value;
    this._updateEngine();
    this.render();
  }

  set y(value: number | undefined) {
    if (this._y === value) return;
    this._y = value;
    this._updateEngine();
    this.render();
  }

  set width(value: number | undefined) {
    if (this._width === value) return;
    this._width = value;
    this._updateEngine();
    this.render();
  }

  set height(value: number | undefined) {
    if (this._height === value) return;
    this._height = value;
    this._updateEngine();
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

  /**
   * 오버랩 처리 모드를 설정한다.
   *
   * `'path'` = 불투명 픽셀 윤곽 따라 흐름(기본값), `'box'` = 박스 rect 기준 오버랩,
   * `'none'` = 오버랩 회피 없음(텍스트가 이미지 아래에 쓰여짐).
   *
   * 변경 시 영향받는 단락을 재렌더링한다.
   *
   * @param value - 오버랩 모드
   */
  set overlapMode(value: OverlapMode) {
    if (this._overlapMode === value) return;
    this._overlapMode = value;
    this.layout();
    this.render();
    this.parentElement?.requestRerenderAffectedParagraphs();
  }

  get overlapMode(): OverlapMode {
    return this._overlapMode;
  }

  set originalWidth(value: number | undefined) {
    this._originalWidth = value;
    this._applyObjectFit();
    this.render();
  }

  get originalWidth(): number | undefined {
    return this._originalWidth;
  }

  set originalHeight(value: number | undefined) {
    this._originalHeight = value;
    this._applyObjectFit();
    this.render();
  }

  get originalHeight(): number | undefined {
    return this._originalHeight;
  }

  set objectFit(value: ImageObjectFit) {
    if (this._objectFit === value) return;
    this._objectFit = value;
    this._applyObjectFit();
    this.render();
  }

  get objectFit(): ImageObjectFit {
    return this._objectFit;
  }

  /**
   * AI 처리 중 상태를 반환한다.
   *
   * `data` getter에 포함되지 않는 휘발성 속성으로, 저장/직렬화 시 자동 제외된다.
   *
   * @returns AI 처리 중 여부
   *
   * @example
   * ```ts
   * if (imageElement.aiProcessing) {
   *   // AI 처리 중 로직
   * }
   * ```
   */
  get aiProcessing(): boolean {
    return isAiProcessingActive(this._shadowRoot);
  }

  /**
   * AI 처리 중 상태를 설정한다.
   *
   * `true`이면 요소를 반투명 오버레이로 덮고 shimmer + spinner 애니메이션을 표시한다.
   * 오버레이는 `pointer-events: auto`로 마우스 이벤트를 가로채 요소 조작을 차단한다.
   * `layout()`/`render()`를 트리거하지 않으므로 비용이 거의 없다.
   * `data` setter와 독립적이며 저장 시 직렬화되지 않는다.
   *
   * @param value - `true`면 AI 처리 중 오버레이 표시, `false`면 숨김
   *
   * @example
   * ```ts
   * // AI 처리 시작
   * imageElement.aiProcessing = true;
   *
   * // AI 처리 완료
   * imageElement.aiProcessing = false;
   * ```
   */
  set aiProcessing(value: boolean) {
    setAiProcessingActive(this._shadowRoot, value);
  }

  get data() {
    return {
      id: this.id,
      zIndex: this._zIndex,
      overlapPadding: this._overlapPadding,
      overlapMode: this._overlapMode,
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
    this._applyObjectFit();
    this._updateEngine();
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
}
customElements.define("x-layout-image", LayoutImageElement);