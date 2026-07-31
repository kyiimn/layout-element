import { TextLayoutEngine } from "@/core";
import { LayoutParagraphElement } from "./paragraph.element";

/**
 * 텍스트 래핑용 가상 컬럼 요소. `<x-layout-vcolumn>` 커스텀 엘리먼트.
 *
 * `TextLayoutEngine._layoutTextIntoColumns()`에서 오버플로우 측정을 위해 임시로 생성된다.
 * 실제 렌더링(`LayoutColumnElement`)이 시작되기 전에 제거된다.
 */
export class LayoutVirtualColumnElement extends HTMLElement {
  private _model?: TextLayoutEngine;
  private _index?: number;

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
    this._renderVirtualColumn();
  }

  attributeChangedCallback(name: string, oldval: string | null, newval: string | null) {
    if (name === 'index' && oldval !== newval) {
      this.index = parseInt(newval!) || undefined;
    }
  }

  /**
   * 가상 컬럼 스타일 설정: `genColumnStyle()` 결과를 `:host` 규칙에 적용한다.
   * 텍스트 래핑 측정용으로 임시 생성되며, 측정 완료 후 즉시 제거된다.
   * 내부 전용. `render()`에서만 호출된다.
   */
  private _renderVirtualColumn() {
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
    if (!this._model) return false;
    const lineCount = Array.from(this._shadowRoot.children)
      .filter((el): el is HTMLDivElement => el instanceof HTMLDivElement).length;
    const contentHeightMm = lineCount * this._model.lineHeight;
    const containerHeightMm = this._model.inheritStyle?.parentHeight ?? 0;
    // 부동소수점 오차(예: 15*4.8=72 vs parentHeight=71.99999999999999)로 인한
    // 잘못된 overflow 판정을 방지하기 위해 1e-6 tolerance를 적용한다.
    // 이 기준은 LayoutParagraphElement._computeRenderStats()의
    // `accumulatedHeightMm + lineHeightMm > parentHeight + 1e-6`과 동일하다.
    return contentHeightMm > containerHeightMm + 1e-6;
  }

  set model(model: TextLayoutEngine | undefined) {
    this._model = model;
    this._renderVirtualColumn();
  }

  set index(index: number | undefined) {
    this._index = index;
    this._renderVirtualColumn();
  }

  get type(): "column" { return 'column'; }
}
customElements.define('x-layout-vcolumn', LayoutVirtualColumnElement);