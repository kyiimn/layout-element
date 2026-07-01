import { ColorManager, ParagraphModel } from "@/model";
import { InheritStyle, ParagraphData, ParagraphStyle, TextStyle } from "@/types";
import { checkOverlap } from "@/utils";
import { LayoutBoxElement } from "./box.element";
import { LayoutColumnElement } from "./column.element";

/**
 * 다중 컬럼 텍스트 영역 요소. `<x-layout-paragraph>` 커스텀 엘리먼트.
 *
 * `ParagraphData`를 받아 `ParagraphModel`을 통해 텍스트 래핑을 수행하고,
 * `LayoutColumnElement`를 생성하여 각 컬럼을 렌더링한다.
 *
 * 오버플로우 발생 시 `render-error` 커스텀 이벤트를 디스패치한다.
 */
export class LayoutParagraphElement extends HTMLElement {
  private _inheritStyle?: InheritStyle;

  private _data?: ParagraphData;
  private _model?: ParagraphModel;

  private _columnEl: LayoutColumnElement[];

  private _shadowRoot: ShadowRoot;

  constructor() {
    super();

    this._columnEl = [];
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.renderLayout();
  }

  disconnectedCallback() {
    if (this._data) delete this._data;
    if (this._model) delete this._model;
  }

  findById(id: string) {
    if (this.id === id) return this;
    return null;
  }

  renderLayout() {
    if (!this.isConnected) return;

    this._columnEl = [];
    this._shadowRoot.innerHTML = '';
    if (this._model) delete this._model;
    if (!this._data || !this.parentModel || !this._inheritStyle) return;

    const color = this.textStyle.color || this._inheritStyle.color;
    const fontFamily = this.textStyle.fontFamily || this._inheritStyle.fontFamily;
    const fontWeight = this.textStyle.fontWeight || this._inheritStyle.fontWeight;
    const fontStyle = this.textStyle.fontStyle || this._inheritStyle.fontStyle;
    const fontSize = this.textStyle.fontSize || this._inheritStyle.fontSize;

    const lineHeight = this.parentModel.lineHeight;
    const paddingTop = this._inheritStyle.paddingTop || 0;

    const styleEl = document.createElement('style');
    this._shadowRoot.appendChild(styleEl);
    if (styleEl.sheet) {
      const colorManager = ColorManager.getInstance();
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, {
        color: color !== undefined ? colorManager.getCSSColor(color) : undefined,
        display: 'flex',
        flexDirection: 'row',
        fontFamily,
        fontStyle,
        fontWeight: fontWeight ? String(fontWeight) : undefined,
        fontSize: `${fontSize}mm`,
        height: `${this.height}mm`,
        left: `${this.left}mm`,
        position: 'absolute',
        top: `${Math.ceil(paddingTop / lineHeight) * lineHeight}mm`,
        width: `${this.width}mm`,
        zIndex: `${this.zIndex + 100}`,
        overflow: "hidden",
      });
      styleEl.sheet.insertRule(`@media print { :host { overflow: hidden; } }`, 1);
    }

    this._model = ParagraphModel.create({
      data: {
        ...this._data,
        column: this._data.column !== undefined && this._data.gap !== undefined ? this._data.column : this.parentModel.columnWidth,
        gap: this._data.column !== undefined && this._data.gap !== undefined ? this._data.gap : this.parentModel.gaps,
      },
      paragraphEl: this,
      rootNode: this._shadowRoot,
      inheritStyle: {
        ...this._inheritStyle,
        parentHeight: this.height,
        parentWidth: this.width,
      },
    });

    if (this._model.overflow > 0) {
      const event = new CustomEvent('render-error', {
        detail: { id: this.id, type: 'text-overflow', overflow: this._model.overflow },
        bubbles: true,
        composed: true,
      });
      this.dispatchEvent(event);
    }
  }

  async renderImage() { return; }

  renderText() {
    if (!this.isConnected || !this._model) return;

    this._model.preTextWrap();

    const columnContents = this._model.columnContents;
    for (let i = 0; i < columnContents.length; i++) {
      const columnEl = document.createElement('x-layout-column');
      columnEl.index = i;
      columnEl.model = this._model;
      columnEl.parentElement = this;

      this._columnEl.push(columnEl);
      this._shadowRoot.appendChild(columnEl);
    }
  }

  set data(data: ParagraphData | undefined) {
    this._data = data;
    this.renderLayout();
  }

  get data() {
    return this._data;
  }

  get parentElement() {
    return super.parentElement as LayoutBoxElement;
  }

  get parentModel() {
    return this.parentElement?.model;
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.renderLayout();
  }

  get inheritStyle() {
    return this._inheritStyle;
  }

  get textStyle(): TextStyle {
    return this._data?.textStyle || {};
  }

  get paragraphStyle(): ParagraphStyle {
    return this._data?.paragraphStyle || {};
  }

  get left() {
    return this._inheritStyle?.paddingLeft || 0;
  }

  get top() {
    if (!this._inheritStyle || !this.parentModel) return 0;
    return Math.ceil((this._inheritStyle.paddingTop || 0) / this.parentModel.lineHeight) * this.parentModel.lineHeight;
  }

  get absLeft(): number {
    return this.parentElement.absLeft + this.left;
  }

  get absTop(): number {
    return this.parentElement.absTop + this.top;
  }

  get width() {
    if (!this._inheritStyle) return 0;
    return this._inheritStyle.parentWidth;
  }

  get height() {
    if (!this._inheritStyle) return 0;
    return this._inheritStyle.parentHeight;
  }

  get overlayElements() {
    const list: LayoutBoxElement[] = this.parentElement.overlayElements;
    const self: any = this;

    let overlay = this.parentElement.items.filter(i => i.type === 'box' && i !== self && i.zIndex > this.zIndex) as LayoutBoxElement[];
    overlay = overlay.filter(i => checkOverlap(i, this));

    list.push(...overlay);

    return list;
  }

  get printPostData() {
    return [];
  }

  get type(): "paragraph" { return 'paragraph'; }

  get zIndex() { return this._data?.zIndex || 0; }
}
customElements.define('x-layout-paragraph', LayoutParagraphElement);