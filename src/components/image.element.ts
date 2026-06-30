import { BoxModel } from "@/model";
import { InheritStyle, ImageData, PrintPostData } from "@/types";
import { LayoutBoxElement } from "./box.element";
import { LayoutDocumentElement } from "./document.element";
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

  private _canvas?: HTMLCanvasElement;
  private _shadowRoot: ShadowRoot;

  private _cropImage() {
    return new Promise<boolean>((r) => {
      if (!this._canvas) r(false);

      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        const dpi = this._dpi;
        const ppm = dpi / 25.4;

        const sx = Math.round(this._x * ppm);
        const sy = Math.round(this._y * ppm);
        const sWidth = Math.round(this._width * ppm);
        const sHeight = Math.round(this._height * ppm);

        this._canvas!.width = sWidth;
        this._canvas!.height = sHeight;

        const ctx = this._canvas!.getContext('2d')!;
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
      img.src = this._url;
    });
  }

  connectedCallback() {
    this.renderLayout();
  }

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  static get observedAttributes() {
    return ['id', 'x', 'y', 'width', 'height', 'dpi', 'url', 'z-index'];
  }

  private _x: number = 0;
  private _y: number = 0;
  private _width: number = 0;
  private _height: number = 0;
  private _dpi: number = DEFAULT_IMAGE_DPI;
  private _url: string = '';
  private _zIndex: number = 0;

  attributeChangedCallback(name: string, oldValue: string, newValue: string) {
    if (oldValue === newValue) return;
    switch (name) {
      case 'id':
        this.id = newValue;
        break;
      case 'x':
        this._x = Number(newValue);
        this.renderLayout();
        break;
      case 'y':
        this._y = Number(newValue);
        this.renderLayout();
        break;
      case 'width':
        this._width = Number(newValue);
        this.renderLayout();
        break;
      case 'height':
        this._height = Number(newValue);
        this.renderLayout();
        break;
      case 'dpi':
        this._dpi = Number(newValue);
        this.renderLayout();
        break;
      case 'url':
        this._url = newValue;
        this.renderLayout();
        break;
      case 'z-index':
        this._zIndex = Number(newValue);
        this.renderLayout();
        break;
    }
  }

  disconnectedCallback() { }

  findById(id: string) {
    if (this.id === id) return this;
    return null;
  }

  renderLayout() {
    if (!this.isConnected) return;

    this._shadowRoot.innerHTML = '';
    if (!this.parentModel || !this._inheritStyle) return;

    const lineHeight = this.parentModel.lineHeight;
    const paddingTop = this._inheritStyle.paddingTop || 0;

    const styleEl = document.createElement("style");
    this._shadowRoot.appendChild(styleEl);
    if (styleEl.sheet) {
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, {
        display: 'flex',
        height: `${this.height}mm`,
        left: `${this.left}mm`,
        position: 'absolute',
        top: `${Math.ceil(paddingTop / lineHeight) * lineHeight}mm`,
        width: `${this.width}mm`,
        zIndex: `${this.zIndex + 100}`,
      });
      styleEl.sheet.insertRule(`@media print { :host { visibility: hidden; } }`, 1);
    }
    this._canvas = document.createElement('canvas');
    this._canvas.style.backgroundColor = 'transparent';
    this._canvas.style.height = "100%";
    this._canvas.style.width = "100%";

    this._shadowRoot.appendChild(this._canvas);
  }

  async renderImage() {
    if (!this.isConnected || !this._canvas) return;
    this._canvas.width = this._canvas.width;
    await this._cropImage();
  }

  renderText() {
    if (!this.isConnected) return;
  }

  set data(data: ImageData) {
    this.setAttribute('x', String(data.x));
    this.setAttribute('y', String(data.y));
    this.setAttribute('width', String(data.width));
    this.setAttribute('height', String(data.height));
    this.setAttribute('dpi', String(data.dpi));
    this.setAttribute('url', String(data.url));
    this.setAttribute('z-index', String(data.zIndex));
  }

  get data() {
    return {
      type: 'image',
      x: this._x,
      y: this._y,
      width: this._width,
      height: this._height,
      dpi: this._dpi,
      url: this._url,
      zIndex: this._zIndex
    };
  }

  get parentElement(): LayoutBoxElement {
    if (!this.isConnected || !super.parentElement) throw new Error('Not connected to DOM');
    if (!(super.parentElement instanceof LayoutBoxElement)) throw new Error('Not connected to LayoutBoxElement');
    return super.parentElement;
  }

  get parentModel() {
    return this.parentElement.model;
  }

  get document() {
    return this.parentElement.document;
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.renderLayout();
  }

  get inheritStyle() {
    return this._inheritStyle;
  }

  get left() {
    return this.inheritStyle?.paddingLeft || 0;
  }

  get top() {
    if (!this.inheritStyle || !this.parentModel) return 0;
    return Math.ceil((this.inheritStyle.paddingTop || 0) / this.parentModel.lineHeight) * this.parentModel.lineHeight;
  }

  get absLeft(): number {
    return this.parentElement.absLeft + this.left;
  }

  get absTop(): number {
    return this.parentElement.absTop + this.top;
  }

  get width() {
    if (!this.inheritStyle) return 0;
    return this.inheritStyle.parentWidth - (this.inheritStyle.paddingLeft || 0) - (this.inheritStyle.paddingRight || 0);
  }

  get height() {
    if (!this.inheritStyle) return 0;
    return this.inheritStyle.parentHeight;
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

  get canvas() { return this._canvas; }

  get type() { return 'image' as const; }

  get zIndex() { return this._zIndex; }
}
customElements.define("x-layout-image", LayoutImageElement);