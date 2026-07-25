import { InheritStyle, ImageData, PrintPostData } from "@/types";
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

  private _x: number = 0;
  private _y: number = 0;
  private _width: number = 0;
  private _height: number = 0;
  private _dpi: number = DEFAULT_IMAGE_DPI;
  private _url?: string;
  private _zIndex: number = 0;
  private _overlapPadding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  private _objectUrl?: string;

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
   * `urlLoader`가 설정되어 있으면 원본 URL을 loader에 전달하여 실제 로드할 URL을 얻는다.
   * loader가 `null`/`undefined`를 반환하면 이미지를 로드하지 않는다.
   */
  async render() {
    if (!this.isConnected || !this.canvas) return;
    this.canvas.width = this.canvas.width;

    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    if (this.url) {
      const resolvedUrl = await this._resolveUrl(this.url);
      if (!resolvedUrl) {
        ctx.fillStyle = 'transparent';
        ctx.fillRect(0, 0, this.canvas!.width, this.canvas!.height);
        return;
      }

      if (this._objectUrl && this._objectUrl !== resolvedUrl) {
        URL.revokeObjectURL(this._objectUrl);
      }
      if (resolvedUrl.startsWith('blob:')) {
        this._objectUrl = resolvedUrl;
      }

      await (new Promise<boolean>((r) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
          const dpi = this.dpi;
          const ppm = dpi / 25.4;

          const sx = Math.round(this.x * ppm);
          const sy = Math.round(this.y * ppm);
          const sWidth = Math.round(this.width * ppm);
          const sHeight = Math.round(this.height * ppm);

          this.canvas!.width = sWidth;
          this.canvas!.height = sHeight;

          try {
            ctx.drawImage(
              img,
              sx, sy, sWidth, sHeight,
              0, 0, sWidth, sHeight
            );
            r(true);
          } catch (_) {
            r(false);
          }
        };
        img.onerror = (_) => r(false);
        img.src = resolvedUrl;
      }));
    } else {
      ctx.fillStyle = 'transparent';
      ctx.fillRect(0, 0, this.canvas!.width, this.canvas!.height);
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

  set data(data: ImageData) {
    if (data.id !== undefined) this.id = data.id;
    if (data.zIndex !== undefined) this._zIndex = data.zIndex;
    if (data.overlapPadding !== undefined) this._overlapPadding = data.overlapPadding;

    this._x = data.x;
    this._y = data.y;
    this._width = data.width;
    this._height = data.height;
    this._dpi = data.dpi;
    this._url = data.url;

    this.layout();
  }

  set x(value: number) {
    if (this._x === value) return;
    this._x = value;
    this.render();
  }

  set y(value: number) {
    if (this._y === value) return;
    this._y = value;
    this.render();
  }

  set width(value: number) {
    if (this._width === value) return;
    this._width = value;
    this.render();
  }

  set height(value: number) {
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
    return this._inheritStyle.parentWidth - (this._inheritStyle.paddingLeft || 0) - (this._inheritStyle.paddingRight || 0);
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