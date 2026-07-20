import { GridCalculator } from "@/core";
import { DocumentData, ParagraphStyle, PrintPostData, TextStyle, BoxData } from "@/types";
import { LayoutBoxElement } from "./box.element";
import { LayoutParagraphElement } from "./paragraph.element";
import { LayoutImageElement } from "./image.element";
import { genUUID } from "@/utils";

/**
 * 문서 루트 요소. `<x-layout-document>` 커스텀 엘리먼트.
 *
 * `DocumentData`를 받아 전체 렌더링 파이프라인을 조율한다.
 *
 * 렌더링 파이프라인:
 * 1. `renderLayout()` - 동기. DOM 트리 구축, 자식 박스 생성, `GridCalculator` 생성
 * 2. `renderImage()` - 비동기. 이미지 로딩 및 `<canvas>` 크롭, 재귀 전파
 * 3. `renderText()` - 동기. 텍스트 래핑, 컬럼 엘리먼트 생성
 *
 * 주요 책임:
 * - `ColorRegistry`, `FontLoader` 싱글턴 초기화
 * - 최상위 `InheritStyle` 생성 및 자식에게 전파
 * - 컬럼 가이드(`<x-layout-guide-column>`) 렌더링
 */
export class LayoutDocumentElement extends HTMLElement {
  private _model?: GridCalculator;

  private _shadowRoot: ShadowRoot;
  private _root?: HTMLDivElement;

  private _visibleGuide: boolean;
  private _isPrint: boolean;

  private _width: number = 0;
  private _height: number = 0;
  private _paddingTop: number = 0;
  private _paddingBottom: number = 0;
  private _paddingLeft: number = 0;
  private _paddingRight: number = 0;

  private _columns: number | number[] = 1;
  private _gap: number | number[] = 0;

  private _paragraphStyle: ParagraphStyle = {};
  private _textStyle: TextStyle = {};

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });
    this._visibleGuide = true;
    this._isPrint = window.matchMedia("print").matches;
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    if (this._isPrint) return;

    this.layout();
    this.render();
  }

  disconnectedCallback() { }

  /**
   * 구조 계산: GridCalculator 데이터 할당 및 모델 생성.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected) return null;

    this._model ??= GridCalculator.create({
      element: this,
      width: 0, height: 0, columns: 1, gap: 0, paragraphStyle: {}, textStyle: {}
    });
    this._model.data = {
      element: this,
      width: this._width,
      height: this._height,
      paddingTop: this._paddingTop,
      paddingBottom: this._paddingBottom,
      paddingLeft: this._paddingLeft,
      paddingRight: this._paddingRight,
      columns: this._columns,
      gap: this._gap,
      paragraphStyle: this._paragraphStyle,
      textStyle: this._textStyle,
    };
    return this;
  }

  /**
   * CSS 스타일 적용: shadow DOM 내의 `:host` 규칙과 루트 div 스타일을 생성/갱신한다.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _applyStyle() {
    if (!this._shadowRoot.querySelector(":scope > style")) {
      const styleEl = document.createElement('style');
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);
      styleEl.sheet.insertRule(":host([reparent-target]) { box-shadow: #ff9800 0px 0px 0px 2px inset; }", 1);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      rule.style.setProperty('background-color', '#ffffff', 'important');
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
        rule.style,
        {
          display: 'inline-flex',
          position: 'relative',
        }
      );
      rule.style.setProperty('height', 'fit-content', 'important');
      rule.style.setProperty('width', 'fit-content', 'important');
    }

    if (!this._root) {
      this._root = document.createElement('div');
      this._shadowRoot.appendChild(this._root);

      this._shadowRoot.appendChild(document.createElement('slot'));
    }
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      this._root.style,
      {
        boxSizing: 'border-box',
        display: 'inline-block',
        position: 'relative',
        height: `${this._height}mm`,
        width: `${this._width}mm`,
      }
    );
  }

  /**
   * 가이드 컬럼 요소 생성 및 스타일 적용.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _renderGuideColumns() {
    if (!this._model) return;

    Array.from(this._root?.children || []).forEach(e => {
      if (e.nodeName !== "X-LAYOUT-GUIDE-COLUMN") return;
      e.remove();
    });

    for (let i = 0; i < this._model.columnCoords.length; i++) {
      const coord = this._model.columnCoords[i];
      const colEl = document.createElement('x-layout-guide-column');
      colEl.rect = coord;
      colEl.fontSize = this._model.fontSize;
      colEl.lineHeight = this._model.lineHeight;
      colEl.visible = this._visibleGuide;

      this._root?.appendChild(colEl);
    }
  }

  /**
   * 자식 요소에 InheritStyle 전파.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _propagateInheritStyle() {
    if (!this._model) return;
    this.items.forEach(childEl => {
      childEl.inheritStyle = {
        ...this.textStyle,
        ...this.paragraphStyle,
        parentHeight: this._model!.editableHeight,
        parentWidth: this._model!.editableWidth,
      };
    });
  }

  /**
   * 레이아웃 오케스트레이터. `_layoutStructure()`, `_applyStyle()`,
   * `_renderGuideColumns()`, `_propagateInheritStyle()`를 순서대로 호출한다.
   * 기존 호출자(`connectedCallback`, 세터)와의 호환성을 위해 유지한다.
   */
  layout() {
    if (!this.isConnected) return null;

    this._layoutStructure();
    this._applyStyle();
    this._renderGuideColumns();
    this._propagateInheritStyle();
    return this;
  }

  /**
   * 자식 요소를 z-index 역순으로 렌더링한다.
   * 이미지 로딩 등 비동기 처리를 위해 각 자식의 `render()`를 await한다.
   */
  async render() {
    if (!this.isConnected) return null;
    const sortedItems = [...this.items].sort((a, b) => a.zIndex - b.zIndex).reverse();
    for (let i = 0; i < sortedItems.length; i++) {
      await sortedItems[i].render()
    }
    return this;
  }

  appendChild<T extends Node>(node: T) {
    if (this._model && ['X-LAYOUT-BOX', 'X-LAYOUT-PARAGRAPH', 'X-LAYOUT-IMAGE'].includes(node.nodeName)) {
      const childEl = node as unknown as (LayoutBoxElement | LayoutParagraphElement | LayoutImageElement);
      childEl.inheritStyle = {
        ...this.textStyle,
        ...this.paragraphStyle,
        parentHeight: this._model!.editableHeight,
        parentWidth: this._model!.editableWidth,
      };
    }
    return super.appendChild(node);
  }

  /**
   * BoxData를 받아 `<x-layout-box>` 요소를 생성하여 추가하고, 생성된 요소를 반환한다.
   *
   * `data` setter의 전체 초기화 파이프라인이 실행되므로, document의
   * `GridCalculator`에 맞춰 모델/상속 스타일이 올바르게 설정된다.
   * 외부(예: `LayoutEditController`의 reparent)에서 새 box를 추가할 때 사용한다.
   *
   * @param child - 추가할 box 데이터
   * @returns 생성된 LayoutBoxElement
   */
  appendChildData(child: BoxData): LayoutBoxElement {
    const boxEl = document.createElement('x-layout-box') as LayoutBoxElement;
    boxEl.data = child;
    this.appendChild(boxEl);
    return boxEl;
  }

  set data(data: DocumentData) {
    if (data.id !== undefined) this.id = data.id;
    if (data.paddingTop !== undefined) this._paddingTop = data.paddingTop;
    if (data.paddingBottom !== undefined) this._paddingBottom = data.paddingBottom;
    if (data.paddingLeft !== undefined) this._paddingLeft = data.paddingLeft;
    if (data.paddingRight !== undefined) this._paddingRight = data.paddingRight;

    this._width = data.width;
    this._height = data.height;
    this._columns = data.columns;
    this._gap = data.gap;
    this._paragraphStyle = data.paragraphStyle;
    this._textStyle = data.textStyle;

    this.items.forEach(e => e.remove());

    if (!this._isPrint) this.layout();

    const children = data.children || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const boxEl = document.createElement('x-layout-box');
      boxEl.data = child;
      this.appendChild(boxEl);
    }
    if (!this._isPrint) this.render();
  }

  set width(value: number) {
    if (this._width === value) return;
    this._width = value;
    this.layout();
    this.render();
  }

  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this.layout();
    this.render();
  }

  set paddingTop(value: number) {
    if (this._paddingTop === value) return;
    this._paddingTop = value;
    this.layout();
    this.render();
  }

  set paddingBottom(value: number) {
    if (this._paddingBottom === value) return;
    this._paddingBottom = value;
    this.layout();
    this.render();
  }

  set paddingLeft(value: number) {
    if (this._paddingLeft === value) return;
    this._paddingLeft = value;
    this.layout();
    this.render();
  }

  set paddingRight(value: number) {
    if (this._paddingRight === value) return;
    this._paddingRight = value;
    this.layout();
    this.render();
  }

  set columns(value: number | number[]) {
    if (this._columns === value) return;
    this._columns = value;
    this.layout();
    this.render();
  }

  set gap(value: number | number[]) {
    if (this._gap === value) return;
    this._gap = value;
    this.layout();
    this.render();
  }

  set paragraphStyle(value: ParagraphStyle) {
    if (this._paragraphStyle === value) return;
    this._paragraphStyle = value;
    this.layout();
    this.render();
  }

  set textStyle(value: TextStyle) {
    if (this._textStyle === value) return;
    this._textStyle = value;
    this.layout();
    this.render();
  }

  get data() {
    return {
      id: this.id,
      width: this.width,
      height: this.height,
      paddingTop: this.paddingTop,
      paddingBottom: this.paddingBottom,
      paddingLeft: this.paddingLeft,
      paddingRight: this.paddingRight,
      columns: this.columns,
      gap: this.gap,
      paragraphStyle: this.paragraphStyle,
      textStyle: this.textStyle,
      children: this.items.map(e => e.data),
    }
  }

  get width() { return this._width; }
  get height() { return this._height; }
  get paddingTop() { return this._paddingTop; }
  get paddingBottom() { return this._paddingBottom; }
  get paddingLeft() { return this._paddingLeft; }
  get paddingRight() { return this._paddingRight; }
  get innerWidth() { return this._width - this.paddingLeft - this.paddingRight; }
  get innerHeight() { return this._height - this.paddingTop - this.paddingBottom; }
  get columns() { return this._columns; }
  get gap() { return this._gap; }
  get paragraphStyle() { return this._paragraphStyle; }
  get textStyle() { return this._textStyle; }

  get model() { return this._model; }
  get visibleGuide() { return this._visibleGuide; }
  get type() { return 'document' as const; }
  get zIndex() { return 0; }

  set visibleGuide(value: boolean) {
    this._visibleGuide = value;

    if (!this._root) return;

    const guideEl = this._root.getElementsByTagName('x-layout-guide-column');
    Array.from(guideEl).forEach(e => {
      e.visible = this._visibleGuide;
    });
  }

  get printPostData() {
    const data: PrintPostData[] = [];
    this.items.forEach(c => data.push(...c.printPostData));
    this.querySelectorAll('x-layout-guide-column').forEach((gc: any) => {
      if (gc.printPostData) data.push(...gc.printPostData);
    });
    return data;
  }

  get items() {
    return Array.from(this.querySelectorAll<LayoutBoxElement>(":scope > x-layout-box"));
  }
}
customElements.define('x-layout-document', LayoutDocumentElement);