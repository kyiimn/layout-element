import { DEFAULT_FONT_SIZE, DEFAULT_LINE_GAP } from "@/constants";
import { Rect } from "@/core";
import { GuideColumnData } from "@/types/layout";
import { PrintPostData, PrintPostDataRect } from "@/types/print";

/**
 * 컬럼 가이드 표시 요소. `<x-layout-guide-column>` 커스텀 엘리먼트.
 *
 * 편집 모드에서 텍스트 줄 위치를 시각적으로 안내하는 그리드를 표시한다.
 * 인쇄 모드에서는 자동으로 숨겨진다.
 */
export class LayoutGuideColumnElement extends HTMLElement {
  private _left: number;
  private _top: number;
  private _height: number;
  private _width: number;

  private _fontSize: number;
  private _lineHeight: number;

  private _visible: boolean;

  private _shadowRoot: ShadowRoot;

  constructor() {
    super();

    this._left = 0;
    this._top = 0;
    this._height = 0;
    this._width = 0;

    this._fontSize = DEFAULT_FONT_SIZE;
    this._lineHeight = DEFAULT_FONT_SIZE * DEFAULT_LINE_GAP;

    this._visible = false;

    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this._layoutAndRenderGuideColumns();
  }

  disconnectedCallback() {
  }

  /**
   * 가이드 컬럼 생성 및 스타일 적용을 동시에 수행한다.
   * shadow DOM을 초기화하고, 가시성 여부에 따라 가이드 라인을 렌더링한다.
   * 내부 전용. 각 속성 setter에서만 호출된다.
   */
  private _layoutAndRenderGuideColumns() {
    if (!this.isConnected) return;

    this._shadowRoot.innerHTML = '';
    if (!this._visible) return;

    const styleEl = document.createElement('style');
    this._shadowRoot.appendChild(styleEl);
    if (styleEl.sheet) {
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, {
        height: `${this._height}mm`,
        left: `${this._left}mm`,
        overflow: 'hidden',
        position: 'absolute',
        top: `${this._top}mm`,
        width: `${this._width}mm`,
        zIndex: '0',
      });
      styleEl.sheet.insertRule(`@media print { :host { visibility: hidden; } }`, 1);
    }

    const totalLine = Math.floor(this._height / this._lineHeight);
    for (let j = 0; j < totalLine; j++) {
      const lineEl = document.createElement('div');
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(lineEl.style, {
        borderColor: '#dddddd',
        borderStyle: 'solid',
        borderWidth: '1px',
        boxSizing: 'border-box',
        height: `${this._fontSize}mm`,
        position: 'absolute',
        top: `${this._lineHeight * j}mm`,
        width: '100%',
      });
      this._shadowRoot.appendChild(lineEl);
    }
  }

  set rect(rect: Rect) {
    this._left = rect.x1;
    this._top = rect.y1;
    this._width = rect.x2 - rect.x1;
    this._height = rect.y2 - rect.y1;

    this._layoutAndRenderGuideColumns();
  }

  set left(left: number) {
    this._left = left;
    this._layoutAndRenderGuideColumns();
  }

  set top(top: number) {
    this._top = top;
    this._layoutAndRenderGuideColumns();
  }

  set width(width: number) {
    this._width = width;
    this._layoutAndRenderGuideColumns();
  }

  set height(height: number) {
    this._height = height;
    this._layoutAndRenderGuideColumns();
  }

  set visible(visible: boolean) {
    this._visible = visible;
    this._layoutAndRenderGuideColumns();
  }

  set fontSize(fontSize: number) {
    this._fontSize = fontSize;
    this._layoutAndRenderGuideColumns();
  }

  set lineHeight(lineHeight: number) {
    this._lineHeight = lineHeight;
    this._layoutAndRenderGuideColumns();
  }

  get left() {
    return this._left;
  }

  get top() {
    return this._top;
  }

  get width() {
    return this._width;
  }

  get height() {
    return this._height;
  }

  get visible() {
    return this._visible;
  }

  get fontSize() {
    return this._fontSize;
  }

  get lineHeight() {
    return this._lineHeight;
  }

  get data(): GuideColumnData {
    return {
      type: 'guide-column',
      id: this.id || undefined,
      left: this._left,
      top: this._top,
      width: this._width,
      height: this._height,
      visible: this._visible,
      fontSize: this._fontSize,
      lineHeight: this._lineHeight,
    };
  }

  get printPostData(): PrintPostData<GuideColumnData>[] {
    const rect = this.getBoundingClientRect();
    return [{
      data: this.data,
      rect: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      } as PrintPostDataRect,
    }];
  }
}
customElements.define('x-layout-guide-column', LayoutGuideColumnElement);