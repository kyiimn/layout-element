import { ParagraphModel } from "@/model";
import { LayoutDocumentElement } from "./document.element";
import { LayoutParagraphElement } from "./paragraph.element";

/**
 * 텍스트 래핑용 가상 컬럼 요소. `<x-layout-vcolumn>` 커스텀 엘리먼트.
 *
 * `ParagraphModel.preTextWrap()`에서 오버플로우 측정을 위해 임시로 생성된다.
 * 실제 렌더링(`LayoutColumnElement`)이 시작되기 전에 제거된다.
 */
export class LayoutVirtualColumnElement extends HTMLElement {
  private _model?: ParagraphModel;
  private _index?: number;

  private _doc!: LayoutDocumentElement;
  private _parentElement!: LayoutParagraphElement;
  private _shadowRoot: ShadowRoot;

  static get observedAttributes() {
    return ['index'];
  }

  constructor() {
    super();

    this._index = this.getAttribute("index") ? parseInt(this.getAttribute("index")!) : undefined;
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name: string, oldval: string, newval: string) {
    if (name === 'index' && oldval !== newval) {
      this.index = parseInt(newval) || undefined;
    }
  }

  render() {
    if (!this.isConnected) return;

    this._shadowRoot.innerHTML = '';
    if (!this._model || this._index === undefined) return;

    const colStyle = this._model.genColumnStyle(this._index);
    const styleEl = document.createElement('style');
    this._shadowRoot.appendChild(styleEl);

    if (styleEl.sheet) {
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, colStyle);
    }
  }

  appendChild<T extends Node>(node: T): T {
    return this._shadowRoot.appendChild(node);
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

  get isOverflow() {
    const height = Array.from(this._shadowRoot.children).reduce<number>((a, b) => a + b.scrollHeight, 0);
    return height > this.clientHeight;
  }

  set model(model: ParagraphModel | undefined) {
    this._model = model;
    this.render();
  }

  set index(index: number | undefined) {
    this._index = index;
    this.render();
  }

  get type(): "column" { return 'column'; }
}
customElements.define('x-layout-vcolumn', LayoutVirtualColumnElement);