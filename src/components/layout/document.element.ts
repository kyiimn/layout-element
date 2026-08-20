import { Z_INDEX_TYPE_LABEL } from "@/constants";
import { DocumentData, ParagraphStyle, PrintPostData, TextStyle, BoxData, Font, CMYKColorSet } from "@/types";
import { LayoutBoxElement } from "./box.element";
import { LayoutParagraphElement } from "./paragraph.element";
import { LayoutImageElement } from "./image.element";
import type { LayoutTableElement } from "./table.element";
import { genUUID, flipLayoutData, FlipLayoutOptions, BoxMetricsById } from "@/utils";
import { EditManager } from "@/edit/edit-manager";
import { DocumentEngine } from "@/engine";
import type { FontLoaderEngine, ColorRegistryEngine, ParsedFont, GridCalculatorEngine } from "@/engine";
import { FontLoader } from "@/resource/font-loader";
import { ColorRegistry } from "@/resource/color-registry";

/**
 * `FontLoader` 싱글톤을 `FontLoaderEngine` 인터페이스로 래핑하는 어댑터.
 *
 * 브라우저 환경에서 `FontLoader`가 `FontFace` 등록과 opentype.js 파싱을
 * 모두 수행하므로, 엔진 계층에 메트릭 조회만 위임한다.
 */
class FontLoaderSingletonAdapter implements FontLoaderEngine {
  private _fl: FontLoader;

  constructor(fl: FontLoader) {
    this._fl = fl;
  }

  get ready(): boolean {
    return this._fl.ready;
  }

  async init(fonts: Font[]): Promise<void> {
    await this._fl.init(fonts);
  }

  getParsedFont(fontName?: string): ParsedFont | null {
    return this._fl.getParsedFont(fontName) as unknown as ParsedFont | null;
  }

  getFontFamily(fontName?: string): string {
    return this._fl.getFontFamily(fontName);
  }
}

/**
 * `ColorRegistry` 싱글톤을 `ColorRegistryEngine` 인터페이스로 래핑하는 어댑터.
 */
class ColorRegistrySingletonAdapter implements ColorRegistryEngine {
  private _cr: ColorRegistry;

  constructor(cr: ColorRegistry) {
    this._cr = cr;
  }

  get ready(): boolean {
    return this._cr.ready;
  }

  init(colorSet: CMYKColorSet): void {
    void this._cr.init(colorSet);
  }

  get(name: string): { c: number; m: number; y: number; k: number } {
    return this._cr.get(name);
  }

  getCSSColor(name: string): string {
    return this._cr.getCSSColor(name);
  }

  getOpacityHex(opacity: number): string {
    return this._cr.getOpacityHex(opacity);
  }
}

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
  private _engine?: DocumentEngine;
  private _ppm: number = 0;

  private _shadowRoot: ShadowRoot;
  private _root?: HTMLDivElement;
  private _labelEl: HTMLDivElement | null = null;

  /** `data` 세터에서 자식을 재구축할 때 observer 중복 트리거를 방지하는 플래그. */
  private _rebuildingChildren = false;

  /** `_rebuildingChildren`이 true인 동안 getter가 반환할 캐시된 데이터. */
  private _pendingData: DocumentData | null = null;

  private _childObserver: MutationObserver | null = null;

  private _visibleGuide: boolean;

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

  /**
   * 이 문서 요소에 연결된 DocumentEngine 인스턴스를 반환한다.
   *
   * 엔진은 `connectedCallback`에서 ppm 측정 후 생성되며,
   * 하위 box/paragraph 요소들이 엔진 트리에 접근할 수 있도록 한다.
   *
   * @returns DocumentEngine 인스턴스. 연결 전이면 undefined.
   */
  get engine(): DocumentEngine | undefined { return this._engine; }

  /**
   * 이 문서의 GridCalculatorEngine을 반환한다 (엔진 기반).
   *
   * @returns GridCalculatorEngine. 엔진이 없으면 undefined.
   */
  get model(): GridCalculatorEngine | undefined { return this._engine?.gridCalculator; }

  /**
   * 측정된 pixels-per-mm 값을 반환한다.
   *
   * @returns ppm 값. 측정 전이면 0.
   */
  get ppm(): number { return this._ppm; }

  /**
   * ppm을 무효화하고 재측정한다.
   * 줌 레벨 변경이나 CSS transform 후 호출해야 한다.
   */
  resetPpm(): void {
    this._ppm = 0;
    if (this._engine) {
      this._measurePpm();
      this._engine.ppm = this._ppm;
    }
  }

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });
    this._visibleGuide = true;
    this._editManager = new EditManager(this);
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    this._measurePpm();
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
      const focusedTable = this._findFocusedTable();
      if (focusedTable) {
        const kc = (focusedTable as unknown as { keyboardController?: { selection: unknown } }).keyboardController;
        if (kc && kc.selection) {
          event.preventDefault();
        }
      }
    }
    if (event.key === 'Tab') {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLButtonElement || active instanceof HTMLSelectElement) {
        return;
      }
      const handled = this._editManager.navigateByTab(event.shiftKey);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  };

  private _findFocusedTable(): LayoutTableElement | null {
    const focused = this._editManager.focusedParagraph;
    if (!focused) return null;
    const td = focused.closest('x-layout-td');
    if (!td) return null;
    const table = td.closest('x-layout-table');
    return table as LayoutTableElement | null;
  }

  /**
   * Place Gun 활성 상태일 때 document 빈 공간 mousedown을 EditManager에 위임한다.
   *
   * box 자식에서 발생한 mousedown은 box의 `_onPlaceGunMouseDown`이 먼저 처리하고
   * `stopPropagation`을 호출하므로 여기에 도달하지 않는다.
   * document 빈 공간 클릭 시 element 항목만 주입을 시도한다.
   */
   private _onPlaceGunMouseDown = (event: MouseEvent): void => {
    const manager = this._editManager;
    if (!manager.placeGunActive) return;
    const nextItem = manager.placeGunItems[0];
    if (!nextItem || nextItem.contentType !== 'element') return;
    manager.handlePlaceGunDocumentMouseDown(this, event);
  };

  /**
   * 브라우저 DPI를 측정하여 ppm(pixels-per-mm)을 계산한다.
   * 100mm div를 DOM에 추가하여 getBoundingClientRect로 픽셀 폭을 측정.
   */
  private _measurePpm(): void {
    if (this._ppm > 0) return;
    const div = document.createElement('div');
    div.style.width = '100mm';
    div.style.height = '1px';
    div.style.position = 'absolute';
    div.style.top = '-10000px';
    div.style.left = '-10000px';
    div.style.visibility = 'hidden';
    document.body.appendChild(div);
    const pxWidth100mm = div.getBoundingClientRect().width;
    document.body.removeChild(div);
    this._ppm = pxWidth100mm / 100;
    if (this._ppm <= 0) {
      throw new Error(`LayoutDocumentElement: ppm 측정 실패 (${this._ppm}). 브라우저 렌더링 컨텍스트를 확인하세요.`);
    }
  }

  /**
   * 구조 계산: DocumentEngine 데이터 할당 및 엔진 생성/갱신.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected) return null;

    this._measurePpm();

    const fontLoader = new FontLoaderSingletonAdapter(FontLoader.getInstance());
    const colorRegistry = new ColorRegistrySingletonAdapter(ColorRegistry.getInstance());
    const docData: DocumentData = {
      id: this.id,
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
      children: this.items.map(e => e.data),
    };
    if (!this._engine) {
      this._engine = DocumentEngine.create(docData, fontLoader, colorRegistry, this._ppm);
    } else {
      this._engine.data = docData;
      this._engine.ppm = this._ppm;
    }

    this._engine.layout();

    this._syncEngineIdsToDom();

    return this;
  }

  /**
   * 엔진 트리의 id를 DOM 자식 요소에 동기화한다.
   * DocumentEngine._buildBoxEngine이 BoxData.id가 없을 때 generateEngineId()로
   * id를 발급한다. 이 id를 DOM 요소에 write-back하여,
   * 자식 connectedCallback의 findBoxEngineById(this.id)가 정상 작동하도록 한다.
   */
  private _syncEngineIdsToDom(): void {
    if (!this._engine) return;
    const engineBoxes = this._engine.childBoxEngines;
    const domBoxes = this.items;
    for (let i = 0; i < engineBoxes.length && i < domBoxes.length; i++) {
      const engineId = engineBoxes[i].data.id;
      if (engineId && domBoxes[i].id !== engineId) {
        domBoxes[i].id = engineId;
      }
    }
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
    const grid = this._engine?.gridCalculator;
    if (!grid) return;

    const existing = Array.from(this._root?.children || []).filter(
      (e): e is HTMLElement & {
        rect: unknown; fontSize: number; lineHeight: number; visible: boolean;
        left: number; top: number; width: number; height: number;
      } => e.nodeName === "X-LAYOUT-GUIDE-COLUMN",
    );

    if (existing.length === grid.columnCoords.length) {
      for (let i = 0; i < grid.columnCoords.length; i++) {
        const coord = grid.columnCoords[i];
        const el = existing[i];
        const nl = coord.x1, nt = coord.y1, nw = coord.x2 - coord.x1, nh = coord.y2 - coord.y1;
        if (el.left !== nl || el.top !== nt || el.width !== nw || el.height !== nh) {
          (el as unknown as { rect: unknown }).rect = coord;
        }
        if (el.fontSize !== grid.fontSize) el.fontSize = grid.fontSize;
        if (el.lineHeight !== grid.lineHeight) el.lineHeight = grid.lineHeight;
        if (el.visible !== this._visibleGuide) el.visible = this._visibleGuide;
      }
      return;
    }

    existing.forEach(e => e.remove());

    for (let i = 0; i < grid.columnCoords.length; i++) {
      const coord = grid.columnCoords[i];
      const colEl = document.createElement('x-layout-guide-column') as HTMLElement & {
        rect: unknown; fontSize: number; lineHeight: number; visible: boolean;
      };
      colEl.rect = coord;
      colEl.fontSize = grid.fontSize;
      colEl.lineHeight = grid.lineHeight;
      colEl.visible = this._visibleGuide;
      this._root?.appendChild(colEl);
    }
  }

  /**
   * 자식 요소에 InheritStyle 전파.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _propagateInheritStyle() {
    const grid = this._engine?.gridCalculator;
    if (!grid) return;
    this.items.forEach(childEl => {
      childEl.inheritStyle = {
        ...this.textStyle,
        ...this.paragraphStyle,
        parentHeight: grid.editableHeight,
        parentWidth: grid.editableWidth,
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
    const sortedItems = [...this.items].sort((a, b) => b.zIndex - a.zIndex);
    for (let i = 0; i < sortedItems.length; i++) {
      await sortedItems[i].render()
    }
    return this;
  }

  appendChild<T extends Node>(node: T) {
    const grid = this._engine?.gridCalculator;
    if (grid && ['X-LAYOUT-BOX', 'X-LAYOUT-PARAGRAPH', 'X-LAYOUT-IMAGE'].includes(node.nodeName)) {
      const childEl = node as unknown as (LayoutBoxElement | LayoutParagraphElement | LayoutImageElement);
      childEl.inheritStyle = {
        ...this.textStyle,
        ...this.paragraphStyle,
        parentHeight: grid.editableHeight,
        parentWidth: grid.editableWidth,
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
          this.appendChild(existingBox);
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

      this.layout();
      this.render();
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
   * 문서 또는 지정된 박스의 하위 요소 배치를 좌우/상하/상하좌우 반전한다.
   *
   * `targetId`를 지정하면 해당 박스가 root가 되며 **root 박스의 하위 요소들만** 반전한다.
   * root 박스 자체(위치/보더/패딩)는 유지된다.
   * 생략 시 문서가 root이며, 문서의 하위 박스들만 반전한다.
   *
   * 반전 전 편집 상태(포커스, 선택)를 해제한 후 `data` setter를 통해 반전된 데이터를
   * 적용한다. `data` setter가 `layout()` + `render()`를 자동 처리한다.
   *
   * @param options - 반전 옵션
   * @param options.axis - 반전 축 (`'horizontal'` | `'vertical'` | `'both'`)
   * @param options.targetId - 반전 root 박스 id. 생략 시 문서가 root.
   * @throws {Error} `targetId`가 지정되었으나 해당 id를 가진 박스를 찾지 못한 경우
   *
   * @example
   * ```ts
   * // 문서의 하위 박스들을 좌우 반전
   * documentEl.flipLayout({ axis: 'horizontal' });
   *
   * // 특정 박스의 하위 요소들만 상하 반전
   * documentEl.flipLayout({ axis: 'vertical', targetId: 'box-42' });
   *
   * // 180도 회전
   * documentEl.flipLayout({ axis: 'both' });
   * ```
   */
  flipLayout(options: FlipLayoutOptions): void {
    this.editManager.blurParagraph();
    this.editManager.clearLayoutSelection(false);

    const metricsById = this._collectBoxMetrics();
    const flipped = flipLayoutData(this.data, options, metricsById);
    this.data = flipped;
  }

  /**
   * 문서 내 모든 박스의 실제 mm 크기(absWidth/absHeight)를 수집한다.
   *
   * static 박스의 `width`/`height`는 컬럼 span 수 / 라인 수이지 mm가 아니므로,
   * `flipLayoutData`가 absolute 자식 반전 시 부모 박스의 mm 내부 영역을 알기 위해
   * DOM에서 계산된 `absWidth`/`absHeight`를 수집하여 전달한다.
   *
   * @returns 박스 id → { absWidth, absHeight } map
   *
   * @internal
   */
  private _collectBoxMetrics(): BoxMetricsById {
    const metrics: BoxMetricsById = new Map();
    const boxes = this.querySelectorAll<LayoutBoxElement>('x-layout-box');
    for (const box of boxes) {
      if (box.id) {
        metrics.set(box.id, {
          absWidth: box.absWidth,
          absHeight: box.absHeight,
        });
      }
    }
    return metrics;
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