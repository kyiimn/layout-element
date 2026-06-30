import { BoxModel, ColorManager, FontManager } from "@/model";
import { DocumentData, ParagraphStyle, PrintPostData, TextStyle } from "@/types";
import { genUUID } from "@/utils";
import { LayoutBoxElement } from "./box.element";

/**
 * 문서 루트 요소. `<x-layout-document>` 커스텀 엘리먼트.
 *
 * `DocumentData`를 받아 전체 렌더링 파이프라인을 조율한다.
 *
 * 렌더링 파이프라인:
 * 1. `renderLayout()` - 동기. DOM 트리 구축, 자식 박스 생성, `BoxModel` 생성
 * 2. `renderImage()` - 비동기. 이미지 로딩 및 `<canvas>` 크롭, 재귀 전파
 * 3. `renderText()` - 동기. 텍스트 래핑, 컬럼 엘리먼트 생성
 *
 * 주요 책임:
 * - `ColorManager`, `FontManager` 싱글턴 초기화
 * - 최상위 `InheritStyle` 생성 및 자식에게 전파
 * - 컬럼 가이드(`<x-layout-guide-column>`) 렌더링
 */
export class LayoutDocumentElement extends HTMLElement {
  private _model?: BoxModel;

  private _colorManager: ColorManager;
  private _fontManager: FontManager;

  private _shadowRoot: ShadowRoot;
  private _root?: HTMLDivElement;

  private _visibleGuide: boolean;
  private _isPrint: boolean;

  private _width: number = 0;
  private _height: number = 0;

  private _paddingTop: number = 0;
  private _paddingLeft: number = 0;
  private _paddingBottom: number = 0;
  private _paddingRight: number = 0;

  private _columns: number | number[] = 1;
  private _gap: number | number[] = 0;

  private _textStyle: TextStyle = {};
  private _paragraphStyle: ParagraphStyle = {};

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });
    this._visibleGuide = true;
    this._isPrint = window.matchMedia("print").matches;

    this._colorManager = ColorManager.getInstance();
    this._fontManager = FontManager.getInstance();
  }

  connectedCallback() {
    if (this._isPrint) return;

    this.render();
  }

  disconnectedCallback() {
  }

  async render() {
    if (!this.isConnected) return null;

    this._shadowRoot.innerHTML = '';
    if (!this._model) {
      this._model = BoxModel.create({
        paddingTop: this._paddingTop,
        paddingRight: this._paddingRight,
        paddingBottom: this._paddingBottom,
        paddingLeft: this._paddingLeft,

        columns: this._columns,
        gap: this._gap,

        textStyle: this._textStyle,
        paragraphStyle: this._paragraphStyle,

        width: this._width,
        height: this._height,
      });
    } else {
      this._model.data = {
        paddingTop: this._paddingTop,
        paddingRight: this._paddingRight,
        paddingBottom: this._paddingBottom,
        paddingLeft: this._paddingLeft,

        columns: this._columns,
        gap: this._gap,

        textStyle: this._textStyle,
        paragraphStyle: this._paragraphStyle,

        width: this._width,
        height: this._height,
      };
    }

    if (!this._root) {
      const styleEl = document.createElement('style');
      this._shadowRoot.appendChild(styleEl);
      if (styleEl.sheet) {
        styleEl.sheet.insertRule(":host {}", 0);
        const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, {
          backgroundColor: '#ffffff !important',
          display: 'inline-flex',
          height: 'fit-content !important',
          width: 'fit-content !important',
        });
      }

      this._root = document.createElement('div');
      this._shadowRoot.appendChild(this._root);
    }
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(this._root.style, {
      boxSizing: 'border-box',
      display: 'inline-block',
      position: 'relative',
      height: `${this.height}mm`,
      width: `${this.width}mm`,
    });

    this._root.innerHTML = '';
    for (let i = 0; i < this._model.columnCoords.length; i++) {
      const coord = this._model.columnCoords[i];
      const colEl = document.createElement('x-layout-guide-column');
      colEl.rect = coord;
      colEl.fontSize = this._model.fontSize;
      colEl.lineHeight = this._model.lineHeight;
      colEl.visible = this._visibleGuide;

      this._root.appendChild(colEl);
    }
    this._root.appendChild(document.createElement('slot'));

    for (let i = 0; i < this.childBoxes.length; i++) {
      const boxEl = this.childBoxes[i];
      boxEl.parentModel = this._model;
      boxEl.inheritStyle = {
        ...this.textStyle,
        ...this.paragraphStyle,
        parentHeight: this._model.editableHeight,
        parentWidth: this._model.editableWidth,
      };
    }

    for (let i = this.childBoxes.length - 1; i >= 0; i--) {
      await this.childBoxes[i].renderLayout();
      await this.childBoxes[i].renderImage();
      await this.childBoxes[i].renderText();
    }
    return this;
  }

  set data(data: DocumentData) {
    this._paddingTop = data.paddingTop || 0;
    this._paddingLeft = data.paddingLeft || 0;
    this._paddingBottom = data.paddingBottom || 0;
    this._paddingRight = data.paddingRight || 0;

    this._columns = data.columns || 1;
    this._gap = data.gap || 0;

    this._textStyle = data.textStyle || {};
    this._paragraphStyle = data.paragraphStyle || {};

    this._width = data.width;
    this._height = data.height;

    const oldChildren = Array.from(this.childNodes);
    for (let i = 0; i < oldChildren.length; i++) {
      oldChildren[i].remove();
    }

    if (data.children) {
      for (let i = 0; i < data.children.length; i++) {
        const child = data.children[i];
        const boxEl = document.createElement('x-layout-box');
        boxEl.id = child.id || genUUID();
        boxEl.data = child;
        boxEl.document = this;
        boxEl.parentElement = this;

        if (this._model) {
          boxEl.parentModel = this._model;
          boxEl.inheritStyle = {
            ...this.textStyle,
            ...this.paragraphStyle,
            parentHeight: this._model.editableHeight,
            parentWidth: this._model.editableWidth,
          };
        }
        this.appendChild(boxEl);
      }
    }
    if (!this._isPrint) this.render();
  }

  get childBoxes() {
    return Array.from(this.children).filter(c => c instanceof LayoutBoxElement) as LayoutBoxElement[];
  }

  set textStyle(style: TextStyle) {
    if (JSON.stringify(this._textStyle) === JSON.stringify(style)) return;
    this._textStyle = style;
  }

  get textStyle() {
    return this._textStyle;
  }

  set paragraphStyle(style: ParagraphStyle) {
    if (JSON.stringify(this._paragraphStyle) === JSON.stringify(style)) return;
    this._paragraphStyle = style;
  }

  get paragraphStyle() {
    return this._paragraphStyle;
  }

  set columns(columns: number | number[]) {
    if (JSON.stringify(this._columns) === JSON.stringify(columns)) return;
    this._columns = columns;
  }

  get columns() {
    return this._columns;
  }

  set gap(gap: number | number[]) {
    if (JSON.stringify(this._gap) === JSON.stringify(gap)) return;
    this._gap = gap;
  }

  get gap() {
    return this._gap;
  }

  set width(width: number) {
    if (this._width === width) return;
    this._width = width;
  }

  get width() {
    return this._width;
  }

  set height(height: number) {
    if (this._height === height) return;
    this._height = height;
  }

  get height() {
    return this._height;
  }

  set paddingTop(paddingTop: number) {
    if (this._paddingTop === paddingTop) return;
    this._paddingTop = paddingTop;
  }

  get paddingTop() {
    return this._paddingTop;
  }

  set paddingLeft(paddingLeft: number) {
    if (this._paddingLeft === paddingLeft) return;
    this._paddingLeft = paddingLeft;
  }

  get paddingLeft() {
    return this._paddingLeft;
  }

  set paddingBottom(paddingBottom: number) {
    if (this._paddingBottom === paddingBottom) return;
    this._paddingBottom = paddingBottom;
  }

  get paddingBottom() {
    return this._paddingBottom;
  }

  set paddingRight(paddingRight: number) {
    if (this._paddingRight === paddingRight) return;
    this._paddingRight = paddingRight;
  }

  get paddingRight() {
    return this._paddingRight;
  }

  get model() {
    return this._model;
  }

  set guide(guide: boolean) {
    this._visibleGuide = guide;

    if (!this._root) return;

    const guideEl = this._root.getElementsByTagName('x-layout-guide-column');
    Array.from(guideEl).forEach(e => {
      e.visible = this._visibleGuide;
    });
  }

  get printPostData() {
    const data: PrintPostData[] = [];
    for (let i = 0; i < this.childBoxes.length; i++) {
      data.push(...this.childBoxes[i].printPostData);
    }
    return data;
  }

  get zIndex() { return 0; }

  get guide() {
    return this._visibleGuide;
  }

  get colorManager() {
    return this._colorManager;
  }

  get fontManager() {
    return this._fontManager;
  }

  get type() { return 'document' as const; }
}
customElements.define('x-layout-document', LayoutDocumentElement);