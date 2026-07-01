import { BoxModel } from "@/model";
import { InheritStyle, ImageData, PrintPostData } from "@/types";
import { LayoutBoxElement } from "./box.element";
import { LayoutDocumentElement } from "./document.element";

/**
 * 이미지 크롭 렌더링 요소. `<x-layout-image>` 커스텀 엘리먼트.
 *
 * `ImageData`를 받아 `<canvas>`를 사용해 크롭된 이미지를 렌더링한다.
 * 원본 이미지에서 `x`, `y`, `width`, `height`로 정의된 영역을
 * `dpi`를 기준으로 mm 단위로 변환하여 표시한다.
 */
export class LayoutImageElement extends HTMLElement {
  private _parentModel?: BoxModel;
  private _inheritStyle?: InheritStyle;

  private _data?: ImageData;

  private _doc!: LayoutDocumentElement;

  private _canvas?: HTMLCanvasElement;
  private _parentElement!: LayoutBoxElement;
  private _shadowRoot: ShadowRoot;

  private _cropImage() {
    return new Promise<boolean>((r) => {
      if (!this._data || !this._canvas) r(false);

      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        const dpi = this._data!.dpi;
        const ppm = dpi / 25.4;

        const sx = Math.round(this._data!.x * ppm);
        const sy = Math.round(this._data!.y * ppm);
        const sWidth = Math.round(this._data!.width * ppm);
        const sHeight = Math.round(this._data!.height * ppm);

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
      if (this._data!.base64Data) {
        img.src = `data:image/png;base64,${this._data!.base64Data}`;
      } else {
        img.src = this._data!.url;
      }
    });
  }

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.renderLayout();
  }

  disconnectedCallback() { }

  findById(id: string) {
    if (this.id === id) return this;
    return null;
  }

  renderLayout() {
    if (!this.isConnected) return;

    this._shadowRoot.innerHTML = '';
    if (!this._data || !this._parentModel || !this._inheritStyle) return;

    const lineHeight = this._parentModel.lineHeight;
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
    if (!this.isConnected || !this._data || !this._canvas) return;
    this._canvas.width = this._canvas.width;
    await this._cropImage();
  }

  renderText() {
    if (!this.isConnected) return;
  }

  set data(data: ImageData | undefined) {
    this._data = data;
    this.renderLayout();
  }

  get data() {
    return this._data;
  }

  set document(doc: LayoutDocumentElement) {
    this._doc = doc;
  }

  get document() {
    return this._doc;
  }

  set parentElement(el: LayoutBoxElement) {
    this._parentElement = el;
  }

  get parentElement() {
    return this._parentElement;
  }

  set parentModel(model: BoxModel | undefined) {
    this._parentModel = model;
    this.renderLayout();
  }

  get parentModel() {
    return this._parentModel;
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.renderLayout();
  }

  get inheritStyle() {
    return this._inheritStyle;
  }

  get left() {
    return this._inheritStyle?.paddingLeft || 0;
  }

  get top() {
    if (!this._inheritStyle || !this._parentModel) return 0;
    return Math.ceil((this._inheritStyle.paddingTop || 0) / this._parentModel.lineHeight) * this._parentModel.lineHeight;
  }

  get absLeft(): number {
    return this._parentElement.absLeft + this.left;
  }

  get absTop(): number {
    return this._parentElement.absTop + this.top;
  }

  get width() {
    if (!this._inheritStyle) return 0;
    return this._inheritStyle.parentWidth - (this._inheritStyle.paddingLeft || 0) - (this._inheritStyle.paddingRight || 0);
  }

  get height() {
    if (!this._inheritStyle) return 0;
    return this._inheritStyle.parentHeight;
  }

  get overlayElements() {
    return this._parentElement.overlayElements;
  }

  get printPostData(): PrintPostData[] {
    if (!this._data) return [];
    const rect = this.getBoundingClientRect();
    return [{
      data: this._data,
      rect: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height
      }
    }];
  }

  get canvas() { return this._canvas; }

  get type(): "image" { return 'image'; }

  get zIndex() { return this._data?.zIndex || 0; }
}
customElements.define("x-layout-image", LayoutImageElement);