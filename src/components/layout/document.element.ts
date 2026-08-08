import { GridCalculator } from "@/core";
import { Z_INDEX_TYPE_LABEL } from "@/constants";
import { DocumentData, ParagraphStyle, PrintPostData, TextStyle, BoxData } from "@/types";
import { LayoutBoxElement } from "./box.element";
import { LayoutParagraphElement } from "./paragraph.element";
import { LayoutImageElement } from "./image.element";
import { genUUID } from "@/utils";
import { EditManager } from "@/edit/edit-manager";

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
  private _labelEl: HTMLDivElement | null = null;

  /** `data` 세터에서 자식을 재구축할 때 observer 중복 트리거를 방지하는 플래그. */
  private _rebuildingChildren = false;

  /** `_rebuildingChildren`이 true인 동안 getter가 반환할 캐시된 데이터. */
  private _pendingData: DocumentData | null = null;

  private _childObserver: MutationObserver | null = null;

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

  /**
   * 이 문서 요소 전용 EditManager 인스턴스.
   *
   * constructor에서 생성되어 요소 생명주기 내내 존재한다.
   * 하위 box/paragraph 요소들은 parent 체인을 통해 이 인스턴스에 접근한다.
   */
  private _editManager: EditManager;

  /**
   * 이 문서 요소 전용 EditManager 인스턴스를 반환한다.
   *
   * @returns EditManager 인스턴스.
   */
  get editManager(): EditManager { return this._editManager; }

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });
    this._visibleGuide = true;
    this._isPrint = window.matchMedia("print").matches;
    this._editManager = new EditManager(this);
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    if (this._isPrint) return;
    this._startChildObserver();
    this.addEventListener('mousedown', this._onPlaceGunMouseDown);
    window.addEventListener('keydown', this._onWindowKeyDown, true);
    this.layout();
    this.render();
  }

  disconnectedCallback() {
    this._stopChildObserver();
    this.removeEventListener('mousedown', this._onPlaceGunMouseDown);
    window.removeEventListener('keydown', this._onWindowKeyDown, true);
    this._editManager.reset();
  }

  private _onWindowKeyDown = (event: KeyboardEvent): void => {
    const path = event.composedPath();
    const inTable = path.some((el) => el instanceof HTMLElement && el.closest('x-layout-table'));
    const hasSelectedBoxInTd = this._editManager.selectedLayouts.some(box =>
      box instanceof HTMLElement && box.closest('x-layout-td')
    );

    if (event.key === 'F5') {
      if (this._editManager.layoutEditMode && (inTable || hasSelectedBoxInTd)) {
        event.preventDefault();
      }
    }
    if (event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      if (!hasSelectedBoxInTd) return;
      const tables = this.querySelectorAll('x-layout-table');
      for (const table of tables) {
        const kc = (table as unknown as { keyboardController?: { selection: unknown } }).keyboardController;
        if (kc && kc.selection) {
          event.preventDefault();
          break;
        }
      }
    }
  };

  /**
   * Place Gun 활성 상태일 때 document 빈 공간 mousedown을 EditManager에 위임한다.
   *
   * box 자식에서 발생한 mousedown은 box의 `_onPlaceGunMouseDown`이 먼저 처리하고
   * `stopPropagation`을 호출하므로 여기에 도달하지 않는다.
   * document 빈 공간 클릭 시 element 항목만 주입을 시도한다.
   */
  private _onPlaceGunMouseDown = (event: MouseEvent): void => {
    if (this._isPrint) return;
    const manager = this._editManager;
    if (!manager.placeGunActive) return;
    const nextItem = manager.placeGunItems[0];
    if (!nextItem || nextItem.contentType !== 'element') return;
    manager.handlePlaceGunDocumentMouseDown(this, event);
  };

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
      styleEl.sheet.insertRule("@media screen { :host([reparent-target]) { box-shadow: #ff9800 0px 0px 0px 2px inset; } }", 1);
      styleEl.sheet.insertRule('@media screen { .type-label { position: absolute; top: 0; left: 0; padding: 2px 6px; color: #fff; font-family: "Wanted Sans Variable"; font-size: 12px; line-height: 1.3; pointer-events: none; user-select: none; cursor: default; z-index: ' + Z_INDEX_TYPE_LABEL + '; display: none; white-space: nowrap; } }', 2);
      styleEl.sheet.insertRule('@media screen { :host([reparent-target]) .type-label { display: block; background: rgba(255, 152, 0, 0.85); } }', 3);
      styleEl.sheet.insertRule('@media print { .type-label { display: none !important; } }', 4);
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

      this._labelEl = document.createElement('div');
      this._labelEl.classList.add('type-label');
      this._labelEl.textContent = '지면';
      this._root.appendChild(this._labelEl);

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
    boxEl.requestRerenderAffectedParagraphs();
    return boxEl;
  }

  set data(data: DocumentData) {
    this._rebuildingChildren = true;
    this._pendingData = data;
    try {
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

      // 자식 reconcile 전에 부모 모델(columnCoords)을 새 데이터로 갱신해야
      // appendChild 중 자식 connectedCallback → layout → relLeft getter가
      // stale columnCoords[this.left]를 읽어 `undefined.x1` 크래시가 발생하지 않는다.
      this._layoutStructure();

      const existingBoxes = this.items;
      const existingById = new Map<string, LayoutBoxElement>();
      for (const box of existingBoxes) {
        if (box.id) existingById.set(box.id, box);
      }

      const children = data.children || [];
      const usedIds = new Set<string>();

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const childId = child.id;

        if (childId && existingById.has(childId)) {
          const existingBox = existingById.get(childId)!;
          usedIds.add(childId);
          existingBox.data = child;
          if (existingBox !== this.children[i]) {
            this.appendChild(existingBox);
          }
        } else {
          const boxEl = document.createElement('x-layout-box') as LayoutBoxElement;
          boxEl.data = child;
          this.appendChild(boxEl);
          if (childId) usedIds.add(childId);
        }
      }

      for (const box of existingBoxes) {
        if (box.id && !usedIds.has(box.id)) {
          box.remove();
        }
      }

      if (!this._isPrint) {
        this.layout();
        this.render();
      }
    } finally {
      this._rebuildingChildren = false;
      this._pendingData = null;
    }
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
    if (this._rebuildingChildren && this._pendingData) {
      return this._pendingData;
    }
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
    // z-index 오름차순(낮은 것부터)으로 push한다.
    // PDF 콘텐츠 스트림은 나중에 추가된 것이 위에 렌더링되므로,
    // CSS z-index 동작(낮은 것이 먼저 그려지고 높은 것이 위에 덮임)과
    // 일치하려면 낮은 z-index부터 배열에 들어가야 한다.
    const sortedItems = [...this.items].sort((a, b) => a.zIndex - b.zIndex);
    for (const item of sortedItems) {
      data.push(...item.printPostData);
    }
    this.querySelectorAll('x-layout-guide-column').forEach((gc: any) => {
      if (gc.printPostData) data.push(...gc.printPostData);
    });
    return data;
  }

  get items() {
    return Array.from(this.querySelectorAll<LayoutBoxElement>(":scope > x-layout-box"));
  }

  /**
   * MutationObserver를 시작하여 직접 DOM 조작에 의한 자식 추가/제거를 감지한다.
   * `data` 세터를 통한 자식 재구축 시에는 `_rebuildingChildren` 플래그로 무시한다.
   */
  private _startChildObserver(): void {
    if (this._childObserver) return;
    this._childObserver = new MutationObserver((mutations) => {
      if (this._rebuildingChildren) return;

      let hasChildListChange = false;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          hasChildListChange = true;
          break;
        }
      }
      if (!hasChildListChange) return;

      this.layout();
      this.render();
    });
    this._childObserver.observe(this, { childList: true });
  }

  private _stopChildObserver(): void {
    if (this._childObserver) {
      this._childObserver.disconnect();
      this._childObserver = null;
    }
  }
}
customElements.define('x-layout-document', LayoutDocumentElement);