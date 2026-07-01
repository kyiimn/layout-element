import { BoxModel, ColorManager, FontManager } from "@/model";
import { DocumentData, PrintPostData } from "@/types";
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
  private _data?: DocumentData;
  private _model?: BoxModel;

  private _colorManager: ColorManager;
  private _fontManager: FontManager;

  private _children: LayoutBoxElement[];

  private _shadowRoot: ShadowRoot;
  private _root?: HTMLDivElement;

  private _visibleGuide: boolean;
  private _isPrint: boolean;

  constructor() {
    super();

    this._children = [];
    this._shadowRoot = this.attachShadow({ mode: "open" });
    this._visibleGuide = true;
    this._isPrint = window.matchMedia("print").matches;

    this._colorManager = ColorManager.getInstance();
    this._fontManager = FontManager.getInstance();
  }

  connectedCallback() {
    if (this._isPrint) return;

    this.layout();

    (async () => {
      await this.renderImage();
      this.renderText();
    })();
  }

  disconnectedCallback() {
    if (this._data) delete this._data;
    if (this._model) delete this._model;
  }

  /** ID로 자식 요소 찾기 (재귀) */
  findById(id: string) {
    for (let i = 0; i < this._children.length; i++) {
      const child = this._children[i];
      const findChild = child.findById(id);
      if (findChild) return findChild;
    }
    return null;
  }

  /** 1단계: 레이아웃 렌더링 (동기) */
  layout() {
    if (!this.isConnected) return null;

    this._children = [];
    this._shadowRoot.innerHTML = '';
    if (this._model) delete this._model;
    if (!this._data) return;

    this._model = BoxModel.create(this._data);

    const styleEl = document.createElement('style');
    this._shadowRoot.appendChild(styleEl);
    if (styleEl.sheet) {
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, {
        backgroundColor: '#ffffff !important',
        display: 'inline-flex',
        position: 'relative',
        height: 'fit-content !important',
        width: 'fit-content !important',
      });
    }

    this._root = document.createElement('div');
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(this._root.style, {
      boxSizing: 'border-box',
      display: 'inline-block',
      position: 'relative',
      height: `${this._data.height}mm`,
      width: `${this._data.width}mm`,
    });
    this._shadowRoot.appendChild(this._root);

    for (let i = 0; i < this._model.columnCoords.length; i++) {
      const coord = this._model.columnCoords[i];
      const colEl = document.createElement('x-layout-guide-column');
      colEl.rect = coord;
      colEl.fontSize = this._model.fontSize;
      colEl.lineHeight = this._model.lineHeight;
      colEl.visible = this._visibleGuide;

      this._root.appendChild(colEl);
    }

    if (this._data.children) {
      for (let i = 0; i < this._data.children.length; i++) {
        const child = this._data.children[i];
        const boxEl = document.createElement('x-layout-box');
        boxEl.id = child.id || genUUID();
        boxEl.data = child;
        boxEl.document = this;
        boxEl.parentElement = this;
        boxEl.parentModel = this._model;

        boxEl.inheritStyle = {
          ...this.textStyle,
          ...this.paragraphStyle,
          parentHeight: this._model.editableHeight,
          parentWidth: this._model.editableWidth,
        };
        this._children.push(boxEl);
        this._root.appendChild(boxEl);
      }
    }
    return this;
  }

  /** 2단계: 이미지 렌더링 (비동기) */
  async renderImage() {
    if (!this.isConnected) return null;
    for (let i = 0; i < this._children.length; i++) {
      await this._children[i].renderImage()
    }
    return this;
  }

  /** 3단계: 텍스트 렌더링 (동기) */
  renderText() {
    if (!this.isConnected) return null;
    this._children.forEach(c => c.renderText());
    return this;
  }

  set data(data: DocumentData | undefined) {
    this._data = data;

    if (this._isPrint) return;
    (async () => {
      let self = this.layout();
      self = await self?.renderImage();
      self = self?.renderText();
    })();
  }

  get textStyle() {
    return this._data?.textStyle || {};
  }

  get paragraphStyle() {
    return this._data?.paragraphStyle || {};
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
    this._children.forEach(c => data.push(...c.printPostData));
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

  get items() {
    return this._children;
  }

  get type(): "document" { return 'document'; }
}
customElements.define('x-layout-document', LayoutDocumentElement);