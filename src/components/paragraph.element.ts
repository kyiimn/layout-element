import { ColorManager, ParagraphModel } from "@/model";
import { InheritStyle, ParagraphData, ParagraphStyle, TextBlockData, TextStyle } from "@/types";
import { checkOverlap, genUUID } from "@/utils";
import { LayoutBoxElement } from "./box.element";

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
  private _styleRule?: CSSStyleRule;

  private _model?: ParagraphModel;

  private _shadowRoot: ShadowRoot;

  private _content: string | (string | TextBlockData)[];
  private _column?: number | number[];
  private _gap?: number | number[];

  private _paragraphStyle: ParagraphStyle;
  private _textStyle: TextStyle;

  private _zIndex: number;

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });

    this._content = "";
    this._paragraphStyle = {};
    this._textStyle = {};
    this._zIndex = 0;
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    this.layout();
  }

  disconnectedCallback() { }

  layout() {
    if (!this.isConnected || !this.parentModel || !this._inheritStyle) return;

    const color = this.textStyle.color || this._inheritStyle.color;
    const fontFamily = this.textStyle.fontFamily || this._inheritStyle.fontFamily;
    const fontWeight = this.textStyle.fontWeight || this._inheritStyle.fontWeight;
    const fontStyle = this.textStyle.fontStyle || this._inheritStyle.fontStyle;
    const fontSize = this.textStyle.fontSize || this._inheritStyle.fontSize;

    const lineHeight = this.parentModel.lineHeight;
    const paddingTop = this._inheritStyle.paddingTop || 0;

    const colorManager = ColorManager.getInstance();
    if (!this._styleRule) {
      const styleEl = document.createElement('style');
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);
      styleEl.sheet.insertRule(`@media print { :host { overflow: hidden; } }`, 1);
      this._styleRule = styleEl.sheet.cssRules[0] as CSSStyleRule;

      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
        this._styleRule.style,
        {
          display: 'flex',
          flexDirection: 'row',
          position: 'absolute',
          overflow: "hidden",
        }
      );
      this._shadowRoot.appendChild(document.createElement('slot'));
    }
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      this._styleRule.style,
      {
        color: color !== undefined ? colorManager.getCSSColor(color) : undefined,
        fontFamily,
        fontStyle,
        fontWeight: fontWeight ? String(fontWeight) : undefined,
        fontSize: `${fontSize}mm`,
        height: `${this.absHeight}mm`,
        left: `${this.relLeft}mm`,
        top: `${Math.ceil(paddingTop / lineHeight) * lineHeight}mm`,
        width: `${this.absWidth}mm`,
        zIndex: `${this.zIndex + 100}`,
      }
    );

    const paragraphData = {
      column: this._column !== undefined && this._gap !== undefined ? this._column : this.parentModel.columnWidth,
      gap: this._column !== undefined && this._gap !== undefined ? this._gap : this.parentModel.gaps,

      content: this._content,
      paragraphStyle: this.paragraphStyle,
      textStyle: this.textStyle,

      paragraphEl: this,
      rootNode: this._shadowRoot,
      inheritStyle: {
        ...this._inheritStyle,
        parentHeight: this.absHeight,
        parentWidth: this.absWidth,
      },
    };

    if (!this._model) {
      this._model = ParagraphModel.create(paragraphData);
    } else {
      this._model.data = paragraphData;
    }

    if (this._model.overflow > 0) {
      const event = new CustomEvent('render-error', {
        detail: { id: this.id, type: 'text-overflow', overflow: this._model.overflow },
        bubbles: true,
        composed: true,
      });
      this.dispatchEvent(event);
    }
  }

  render() {
    if (!this.isConnected || !this._model) return;

    this._model.preTextWrap();

    const columnContents = this._model.columnContents;
    for (let i = 0; i < columnContents.length; i++) {
      const columnEl = document.createElement('x-layout-column');
      columnEl.index = i;

      this.appendChild(columnEl);
    }
  }

  set data(data: ParagraphData) {
    if (data.id !== undefined) this.id = data.id;
    if (data.column !== undefined) this._column = data.column;
    if (data.gap !== undefined) this._gap = data.gap;
    if (data.textStyle !== undefined) this._textStyle = data.textStyle;
    if (data.paragraphStyle !== undefined) this._paragraphStyle = data.paragraphStyle;
    if (data.zIndex !== undefined) this._zIndex = data.zIndex;

    this._content = data.content;

    this.layout();
  }

  get data() {
    return {
      id: this.id,
      column: this._column,
      content: this._content,
      gap: this._gap,
      paragraphStyle: this._paragraphStyle,
      textStyle: this._textStyle,
      zIndex: this._zIndex,
      type: this.type,
    };
  }

  get columnEl() {
    return Array.from(this.querySelectorAll('x-layout-column'));
  }

  get parentElement() {
    return super.parentElement as LayoutBoxElement;
  }

  get parentModel() {
    return this.parentElement?.model;
  }

  get model() {
    return this._model;
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.layout();
  }

  get inheritStyle() {
    return this._inheritStyle;
  }

  get textStyle(): TextStyle {
    return this._textStyle;
  }

  get paragraphStyle(): ParagraphStyle {
    return this._paragraphStyle;
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
    return this._inheritStyle.parentWidth;
  }

  get absHeight() {
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

  get type() { return 'paragraph' as const; }

  get zIndex() { return this._zIndex; }
}
customElements.define('x-layout-paragraph', LayoutParagraphElement);