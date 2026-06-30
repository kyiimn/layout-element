import { BoxModel } from "@/model";
import { InheritStyle, ImageData, PrintPostData } from "@/types";
import { LayoutBoxElement } from "./box.element";
import { LayoutDocumentElement } from "./document.element";
import { DEFAULT_IMAGE_DPI } from "@/define";
import { genUUID } from "@/utils";

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

  private _styleRule?: CSSStyleRule;

  // Attributes
  private _x: number = 0;
  private _y: number = 0;
  private _width: number = 0;
  private _height: number = 0;
  private _dpi: number = DEFAULT_IMAGE_DPI;
  private _url: string | undefined;
  private _zIndex: number = 0;

  private async _cropImage() {
    if (!this.isConnected || !this.canvas) return;

    this.canvas.width = this.canvas.width;
    this.canvas.height = this.canvas.height;

    const ctx = this.canvas.getContext('2d')!;
    if (this.url) {
      await (new Promise<boolean>((r) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
          const ppm = this.dpi / 25.4;

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
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  static get observedAttributes() {
    return ['id', 'x', 'y', 'width', 'height', 'dpi', 'url', 'z-index'];
  }

  set x(value: number) {
    if (this._x === value) return;
    this._x = value;
    this._cropImage();
  }

  set y(value: number) {
    if (this._y === value) return;
    this._y = value;
    this._cropImage();
  }

  set width(value: number) {
    if (this._width === value) return;
    this._width = value;
    this._cropImage();
  }

  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this._cropImage();
  }

  set dpi(value: number) {
    if (this._dpi === value) return;
    this._dpi = value;
    this._cropImage();
  }

  set url(value: string | undefined) {
    if (this._url === value) return;
    this._url = value;
    this._cropImage();
  }

  set zIndex(value: number) {
    if (this._zIndex === value) return;
    this._zIndex = value;
    this.render();
  }

  get x() {
    return this._x;
  }

  get y() {
    return this._y;
  }

  get width() {
    return this._width;
  }

  get height() {
    return this._height;
  }

  get dpi() {
    return this._dpi;
  }

  get url() {
    return this._url;
  }

  get zIndex() {
    return this._zIndex;
  }

  get canvas(): HTMLCanvasElement | undefined {
    return this._canvas;
  }

  get type() {
    return 'image' as const;
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string) {
    if (oldValue === newValue) return;
    switch (name) {
      case 'id':
        this.id = newValue;
        break;
      case 'x':
        this.x = Number(newValue);
        break;
      case 'y':
        this.y = Number(newValue);
        break;
      case 'width':
        this.width = Number(newValue);
        break;
      case 'height':
        this.height = Number(newValue);
        break;
      case 'dpi':
        this.dpi = Number(newValue);
        break;
      case 'url':
        this.url = newValue;
        break;
      case 'z-index':
        this.zIndex = Number(newValue);
        break;
    }
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
  }

  disconnectedCallback() { }

  async render() {
    if (!this.isConnected) return false;
    if (!this.parentModel || !this.inheritStyle) return false;

    if (!this._canvas || !this._styleRule) {
      const styleEl = document.createElement("style");
      this._shadowRoot.innerHTML = '';
      this._shadowRoot.appendChild(styleEl);

      if (!styleEl.sheet) throw new Error("LayoutImageElement.styleSheet not ready");
      styleEl.sheet.insertRule(`@media print { :host { visibility: hidden; } }`);

      const ruleIdx = styleEl.sheet.insertRule(":host {}");
      this._styleRule = styleEl.sheet.cssRules[ruleIdx] as CSSStyleRule;

      this._canvas = document.createElement('canvas');
      this._canvas.style.backgroundColor = 'transparent';
      this._canvas.style.height = "100%";
      this._canvas.style.width = "100%";

      this._shadowRoot.appendChild(this._canvas);
    }

    const lineHeight = this.parentModel.lineHeight;
    const paddingTop = this.inheritStyle.paddingTop || 0;

    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      this._styleRule.style,
      {
        display: 'flex',
        height: `${this.layoutHeight}mm`,
        left: `${this.layoutLeft}mm`,
        position: 'absolute',
        top: `${Math.ceil(paddingTop / lineHeight) * lineHeight}mm`,
        width: `${this.layoutWidth}mm`,
        zIndex: `${this.zIndex + 100}`,
      }
    );
    await this._cropImage();
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

  get data(): ImageData {
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

  get parentModel(): BoxModel | undefined {
    return this.parentElement.model;
  }

  get document(): LayoutDocumentElement {
    return this.parentElement.document;
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.render();
  }

  get inheritStyle() {
    return this._inheritStyle;
  }

  get absLeft(): number {
    return this.parentElement.absLeft + this.layoutLeft;
  }

  get absTop(): number {
    return this.parentElement.absTop + this.layoutTop;
  }

  get layoutLeft() {
    return this.inheritStyle?.paddingLeft || 0;
  }

  get layoutTop() {
    if (!this.inheritStyle || !this.parentModel) return 0;
    return Math.ceil((this.inheritStyle.paddingTop || 0) / this.parentModel.lineHeight) * this.parentModel.lineHeight;
  }

  get layoutWidth() {
    if (!this.inheritStyle) return 0;
    return this.inheritStyle.parentWidth - (this.inheritStyle.paddingLeft || 0) - (this.inheritStyle.paddingRight || 0);
  }

  get layoutHeight() {
    if (!this.inheritStyle) return 0;
    return this.inheritStyle.parentHeight - (this.inheritStyle.paddingTop || 0) - (this.inheritStyle.paddingBottom || 0);
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