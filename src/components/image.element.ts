import { InheritStyle, ImageData, PrintPostData } from "@/types";
import { LayoutBoxElement } from "./box.element";
import { genUUID } from "@/utils";
import { DEFAULT_IMAGE_DPI } from "@/define";

/**
 * 이미지 크롭 렌더링 요소. `<x-layout-image>` 커스텀 엘리먼트.
 *
 * `ImageData`를 받아 `<canvas>`를 사용해 크롭된 이미지를 렌더링한다.
 * 원본 이미지에서 `x`, `y`, `width`, `height`로 정의된 영역을
 * `dpi`를 기준으로 mm 단위로 변환하여 표시한다.
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

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    this.layout();
  }

  disconnectedCallback() { }

  layout() {
    if (!this.isConnected) return;

    if (!this.parentModel || !this._inheritStyle) return;

    const lineHeight = this.parentModel.lineHeight;
    const paddingTop = this._inheritStyle.paddingTop || 0;

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
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      this._styleRule.style,
      {
        display: 'flex',
        height: `${this.absHeight}mm`,
        left: `${this.relLeft}mm`,
        position: 'absolute',
        top: `${Math.ceil(paddingTop / lineHeight) * lineHeight}mm`,
        width: `${this.absWidth}mm`,
        zIndex: `${this.zIndex + 100}`,
      }
    );
  }

  async render() {
    if (!this.isConnected || !this.canvas) return;
    this.canvas.width = this.canvas.width;

    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    if (this.url) {
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
        img.src = this.url!;
      }));
    } else {
      ctx.fillStyle = 'transparent';
      ctx.fillRect(0, 0, this.canvas!.width, this.canvas!.height);
    }
  }

  set data(data: ImageData) {
    if (data.id !== undefined) this.id = data.id;
    if (data.zIndex !== undefined) this._zIndex = data.zIndex;

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
  }

  get data() {
    return {
      id: this.id,
      zIndex: this._zIndex,
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
    return Math.ceil((this._inheritStyle.paddingTop || 0) / this.parentModel.lineHeight) * this.parentModel.lineHeight;
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