import { ParagraphModel } from "@/model";
import { LayoutDocumentElement } from "./document.element";
import { LayoutParagraphElement } from "./paragraph.element";

/**
 * 텍스트 컬럼 렌더링 요소. `<x-layout-column>` 커스텀 엘리먼트.
 *
 * `ParagraphModel`에서 생성된 `TextLineData[]`를 받아 각 줄을 렌더링한다.
 * `LayoutParagraphElement.renderText()`에서 동적으로 생성된다.
 */
export class LayoutColumnElement extends HTMLElement {
  private _model?: ParagraphModel;
  private _index?: number;

  private _doc!: LayoutDocumentElement;
  private _parentElement!: LayoutParagraphElement;
  private _shadowRoot: ShadowRoot;

  constructor() {
    super();

    this._index = this.getAttribute("index") ? parseInt(this.getAttribute("index")!) : undefined;
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.renderText();
  }

  disconnectedCallback() {
  }

  attributeChangedCallback(name: string, oldval: string, newval: string) {
    if (name === 'index' && oldval !== newval) {
      this.index = parseInt(newval) || undefined;
    }
  }

  renderText() {
    if (!this.isConnected) return;

    this._shadowRoot.innerHTML = '';
    if (!this._model || this._index === undefined) return;

    const lines = this._model.columnContents[this._index] || [];
    const colStyle = this._model.genColumnStyle(this._index);

    const styleEl = document.createElement('style');
    this._shadowRoot.appendChild(styleEl);

    if (styleEl.sheet) {
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, colStyle);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const { endOfBlock, textBlockStyle } = line;
      const curLineStyle = this._model.genLineStyle(textBlockStyle) || {};
      let { content } = line;

      let justifyContent = (curLineStyle?.justifyContent === 'space-between' && endOfBlock) ? 'flex-start' : undefined;
      switch (textBlockStyle?.textAlign) {
        case 'center': justifyContent = 'center'; break;
        case 'right': justifyContent = 'flex-end'; break;
        default: break;
      }
      while ([' '].includes(content[0])) {
        content = content.slice(1);
      }
      while ([' '].includes(content[content.length - 1])) {
        content = content.slice(0, content.length - 1);
      }
      const lineEl = document.createElement('div');
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(lineEl.style, {
        ...curLineStyle,
        width: `calc(100% - ${line.left + line.right}mm)`,
        maxWidth: `calc(100% - ${line.left + line.right}mm)`,
        marginLeft: `${line.left}mm`,
        justifyContent: justifyContent || curLineStyle.justifyContent
      });
      this._shadowRoot.appendChild(lineEl);

      for (let j = 0; j < content.length; j++) {
        const char = content[j];
        const charEl = document.createElement('span');
        const charStyle = this._model.genCharStyle(char);
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(charEl.style, charStyle);
        charEl.innerText = char;
        lineEl.appendChild(charEl);
      }
    }
  }

  static get observedAttributes() {
    return ['index'];
  }

  set document(doc: LayoutDocumentElement) {
    this._doc = doc;
  }

  get document() {
    return this._doc;
  }

  set parentElement(el: LayoutParagraphElement) {
    this._parentElement = el;
  }

  get parentElement() {
    return this._parentElement;
  }

  get left() {
    const width = this._model?.columnWidths.slice(0, this._index).reduce((a, b) => a + b, 0) || 0;
    const gap = this.model?.gaps.slice(0, this._index).reduce((a, b) => a + b, 0) || 0;
    return gap + width;
  }

  get top() { return 0; }

  get absLeft(): number {
    return this._parentElement.absLeft + this.left;
  }

  get absTop(): number {
    return this._parentElement.absTop;
  }

  set model(model: ParagraphModel | undefined) {
    this._model = model;
    this.renderText();
  }

  get model() {
    return this._model;
  }

  set index(index: number | undefined) {
    this._index = index;
    this.renderText();
  }

  get index() {
    return this._index;
  }

  get zIndex() {
    return 0;
  }

  get type(): "column" { return 'column'; }
}
customElements.define('x-layout-column', LayoutColumnElement);