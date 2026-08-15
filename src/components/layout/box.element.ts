import { DEFAULT_BORDER_STYLE, Z_INDEX_RESIZE_HANDLE, Z_INDEX_TYPE_LABEL, Z_INDEX_ROLE_AD, Z_INDEX_ROLE_HEADER, Z_INDEX_MAX_LAYOUT } from "@/constants";
import { GridCalculator } from "@/core";
import { ColorRegistry } from "@/resource";
import { InheritStyle, BoxData, ParagraphData, TextData, ImageData, TableData, ParagraphStyle, TextStyle, PrintPostData, BoxPosition, BoxBorderStyle, BoxRole } from "@/types";
import { checkOverlap, genUUID } from "@/utils";
import { EditManager } from "@/edit/edit-manager";
import { LayoutDocumentElement } from "./document.element";
import { LayoutImageElement } from "./image.element";
import { LayoutParagraphElement } from "./paragraph.element";
import { LayoutTableElement } from "./table.element";
import { LayoutTableCellElement } from "./td.element";

/**
 * 드래그/리사이즈 중 한 번이라도 오버랩된 단락 집합.
 * 매 rAF 프레임마다 누적되어 드래그 종료 시까지 모든 단락이 갱신된다.
 * null이면 드래그/리사이즈 중이 아님.
 */
type DragAffectedSet = Set<LayoutParagraphElement> | null;

/**
 * 위치 지정 가능한 컨테이너 요소. `<x-layout-box>` 커스텀 엘리먼트.
 *
 * `BoxData`를 받아 DOM 트리를 구축하고 자식 요소들을 렌더링한다.
 * `position` 값에 따라 `left`/`width`의 의미가 달라진다:
 * - `'static'`: 컬럼 그리드 기반 배치
 * - `'absolute'`: mm 좌표 기반 절대 배치
 *
 * 3단계 렌더링 파이프라인을 따르며, `InheritStyle`을 자식에게 전파한다.
 */
export class LayoutBoxElement extends HTMLElement {
  private _inheritStyle?: InheritStyle;
  private _model?: GridCalculator;

  private _shadowRoot: ShadowRoot;

  private _left: number = 0;
  private _top: number = 0;
  private _width: number = 0;
  private _height: number = 0;
  private _position: BoxPosition = "static";
  private _backgroundColor?: string;
  private _backgroundOpacity?: number;
  private _borderColor?: string;
  private _borderStyle: BoxBorderStyle = "solid";
  private _borderTopWidth: number = 0;
  private _borderBottomWidth: number = 0;
  private _borderLeftWidth: number = 0;
  private _borderRightWidth: number = 0;
  private _paddingTop: number = 0;
  private _paddingBottom: number = 0;
  private _paddingLeft: number = 0;
  private _paddingRight: number = 0;
  private _zIndex: number = 0;
  private _role?: BoxRole;
  private _contentUid?: string;
  private _groupMember?: string;
  private _priority?: number;
  private _lock: boolean = false;
  private _editableLayout: boolean = false;
  private _isPrint: boolean = window.matchMedia("print").matches;

  private _savedColumns: number | number[] = 1;
  private _savedGap: number | number[] = 0;

  private _resizeHandles: HTMLDivElement[] = [];

  /** 드래그/리사이즈 중 한 번이라도 오버랩된 단락 집합. null이면 비활성. */
  private _dragAffectedParagraphs: DragAffectedSet = null;

  /** 드래그/리사이즈 중 보류된 rAF ID. */
  private _dragRafId: number | null = null;

  /** 비드래그 시 영향받는 단락 재렌더링 배치 플래그. */
  private _rerenderScheduled: boolean = false;

  /** 테두리 바깥 요소(방향별). `top`/`bottom`/`left`/`right` 키로 관리한다. */
  private _borderEls: Record<string, HTMLDivElement | null> = {
    top: null, bottom: null, left: null, right: null,
  };

  /** 선택된 박스의 좌측상단에 표시되는 타입/role 라벨 요소. */
  private _labelEl: HTMLDivElement | null = null;

  /** DOM 자식 변경(추가/제거)을 감지하여 layout + render를 자동 수행하는 MutationObserver. */
  private _childObserver: MutationObserver | null = null;

  /** `data` 세터에서 자식을 재구축할 때 observer 중복 트리거를 방지하는 플래그. */
  private _rebuildingChildren = false;

  /** `_rebuildingChildren`이 true인 동안 getter가 반환할 캐시된 데이터. */
  private _pendingData: BoxData | null = null;

  /**
   * `attributeChangedCallback`에서 property 세터를 호출할 때 true.
   * property 세터가 다시 `setAttribute`를 호출하여 발생하는 무한 루프를 방지한다.
   */
  private _isSyncingAttribute = false;

  /** `connectedCallback`에서 캐싱한 EditManager. `disconnectedCallback`에서 사용. */
  private _editManagerRef: EditManager | null = null;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    this._editManagerRef = this.editManager;
    this._startChildObserver();
    this.addEventListener('mouseenter', this._onLayoutMouseEnter);
    this.addEventListener('mouseleave', this._onLayoutMouseLeave);
    this.addEventListener('mousedown', this._onPlaceGunMouseDown);
    if (this._editManagerRef?.showPlaceholderBorders) {
      this.setAttribute('show-placeholder-borders', '');
    }
    this.layout();
    this._updateTdStaticAttr();
  }

  /**
   * 이 box가 속한 문서의 EditManager를 반환한다.
   *
   * parent 체인을 따라 올라가 `LayoutDocumentElement.editManager`를 발견한다.
   * 문서에 연결되지 않은 경우 `null`을 반환한다.
   *
   * @returns 소속 문서의 EditManager. 문서에 연결되지 않았으면 `null`.
   */
  get editManager(): EditManager | null {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el instanceof LayoutDocumentElement) return el.editManager;
      el = el.parentElement;
    }
    return null;
  }

  disconnectedCallback() {
    this._stopChildObserver();
    this.removeEventListener('mouseenter', this._onLayoutMouseEnter);
    this.removeEventListener('mouseleave', this._onLayoutMouseLeave);
    this.removeEventListener('mousedown', this._onPlaceGunMouseDown);
    this._editManagerRef?._unregisterLayout(this);
    this._editManagerRef = null;
  }

  static get observedAttributes() {
    return ['role', 'content-uid', 'group-member', 'priority', 'lock'] as const;
  }

  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null) {
    if (this._isSyncingAttribute) return;
    this._isSyncingAttribute = true;
    try {
      if (name === 'role') {
        this._role = newVal as BoxRole | undefined;
        this._updateLabelText();
      } else if (name === 'content-uid') {
        this._contentUid = newVal ?? undefined;
      } else if (name === 'group-member') {
        this._groupMember = newVal ?? undefined;
      } else if (name === 'priority') {
        this._priority = newVal !== null ? Number(newVal) : undefined;
      } else if (name === 'lock') {
        this._lock = newVal !== null;
      }
    } finally {
      this._isSyncingAttribute = false;
    }
  }

  /**
   * 구조 계산: GridCalculator 데이터 할당, 스타일 규칙 생성, 리사이즈 핸들 생성.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected || !this.parentModel) return;

    const tdParent = this.parentElement instanceof LayoutTableCellElement
      ? this.parentElement as LayoutTableCellElement
      : null;

    if (tdParent && this.position !== 'absolute') {
      const tdModel = tdParent.model;
      if (tdModel) {
        const tdContentWidth = tdModel.editableWidth;
        const tdContentHeight = tdModel.contentHeight;

        this._model ??= GridCalculator.create({
          element: this,
          width: 0, height: 0, columns: 1, gap: 0, paragraphStyle: {}, textStyle: {}
        });
        this._model.data = {
          element: this,
          paddingTop: this.paddingTop,
          paddingRight: this.paddingRight,
          paddingBottom: this.paddingBottom,
          paddingLeft: this.paddingLeft,
          columns: [tdContentWidth],
          gap: [],
          paragraphStyle: this.paragraphStyle,
          textStyle: this.textStyle,
          height: tdContentHeight,
          width: tdContentWidth,
        };
        return;
      }
    }

    const { columnWidth, gaps } = this.parentModel;

    this._model ??= GridCalculator.create({
      element: this,
      width: 0, height: 0, columns: 1, gap: 0, paragraphStyle: {}, textStyle: {}
    });
    this._model.data = {
      element: this,

      paddingTop: this.paddingTop,
      paddingRight: this.paddingRight,
      paddingBottom: this.paddingBottom,
      paddingLeft: this.paddingLeft,

      columns: this.position !== 'absolute' ? columnWidth.slice(this.left, this.left + this.width) : this._savedColumns,
      gap: this.position !== 'absolute' ? gaps.slice(this.left, this.left + this.width - 1) : this._savedGap,

      paragraphStyle: this.paragraphStyle,
      textStyle: this.textStyle,
      height: this.absHeight,
      width: this.absWidth,
    };
  }

  /**
   * CSS 스타일 적용: `:host` 규칙, 리사이즈 핸들 규칙, 박스 위치/크기 스타일.
   * 첫 호출 시 스타일시트와 리사이즈 핸들을 생성하고, 이후 호출 시 스타일만 갱신한다.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _applyStyle() {
    if (!this.isConnected || !this.parentModel) return;

    let styleEl = this._shadowRoot.querySelector('style');
    let needsInit = !styleEl
      || !styleEl.sheet
      || styleEl.sheet.cssRules.length === 0;

    if (needsInit) {
      if (styleEl) styleEl.remove();
      styleEl = document.createElement('style');
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);
      styleEl.sheet.insertRule("@media screen { :host([show-placeholder-borders]:not([border]):not([td-static]):not([hovered]):not([reparent-target]):not([selected])) { outline: #aaaaaa dashed 1px !important; outline-offset: -1px !important; box-shadow: none !important; } }", 1);
      styleEl.sheet.insertRule("@media screen { :host([hovered]) { outline: #4a90d9 solid 1px !important; outline-offset: -1px !important; box-shadow: none !important; } }", 2);
      styleEl.sheet.insertRule("@media screen { :host([selected]) { outline: red solid 1px !important; outline-offset: -1px !important; box-shadow: none !important; } }", 3);
      styleEl.sheet.insertRule("@media screen { :host([content-type-null][selected]) { outline: red solid 3px !important; outline-offset: -2px !important; box-shadow: none !important; } }", 4);
      styleEl.sheet.insertRule("@media screen { :host([reparent-target]) { outline: #ff9800 solid 2px !important; outline-offset: -2px !important; box-shadow: none !important; } }", 5);
      styleEl.sheet.insertRule(`@media print { [border] { display: none !important; } }`, 6);
      styleEl.sheet.insertRule('@media screen { .resize-handle { position: absolute; width: 8px; height: 8px; background: white; border: 1px solid #4a90d9; border-radius: 50%; z-index: ' + Z_INDEX_RESIZE_HANDLE + '; pointer-events: auto; display: none; } }', 7);
      styleEl.sheet.insertRule('@media screen { :host([editable-layout][selected]) .resize-handle { display: block; } }', 8);
      styleEl.sheet.insertRule('@media screen { :host([td-static]) .resize-handle { display: none !important; } }', 9);
      styleEl.sheet.insertRule('@media screen { :host([td-static][hovered]) { outline: #4a90d9 solid 1px !important; outline-offset: -1px !important; box-shadow: none !important; } }', 10);
      styleEl.sheet.insertRule('@media screen { :host([td-static][selected]) { outline: red solid 1px !important; outline-offset: -1px !important; box-shadow: none !important; } }', 11);
      styleEl.sheet.insertRule('@media screen { :host([td-static][content-type-null][selected]) { outline: red solid 3px !important; outline-offset: -2px !important; box-shadow: none !important; } }', 12);
      styleEl.sheet.insertRule('@media screen { .resize-handle[data-handle="top"] { top: -4px; left: 50%; transform: translateX(-50%); cursor: ns-resize; } }', 13);
      styleEl.sheet.insertRule('@media screen { .resize-handle[data-handle="bottom"] { bottom: -4px; left: 50%; transform: translateX(-50%); cursor: ns-resize; } }', 14);
      styleEl.sheet.insertRule('@media screen { .resize-handle[data-handle="left"] { left: -4px; top: 50%; transform: translateY(-50%); cursor: ew-resize; } }', 15);
      styleEl.sheet.insertRule('@media screen { .resize-handle[data-handle="right"] { right: -4px; top: 50%; transform: translateY(-50%); cursor: ew-resize; } }', 16);
      styleEl.sheet.insertRule('@media screen { .resize-handle[data-handle="nw"] { top: -4px; left: -4px; cursor: nwse-resize; } }', 17);
      styleEl.sheet.insertRule('@media screen { .resize-handle[data-handle="ne"] { top: -4px; right: -4px; cursor: nesw-resize; } }', 18);
      styleEl.sheet.insertRule('@media screen { .resize-handle[data-handle="sw"] { bottom: -4px; left: -4px; cursor: nesw-resize; } }', 19);
      styleEl.sheet.insertRule('@media screen { .resize-handle[data-handle="se"] { bottom: -4px; right: -4px; cursor: nwse-resize; } }', 20);
      styleEl.sheet.insertRule('@media screen { .type-label { position: absolute; top: 0; left: 0; padding: 0px 0px 0px 6px; color: #fff; font-family: "Wanted Sans Variable"; font-size: 12px; line-height: 1.3; pointer-events: auto; user-select: none; cursor: grab; z-index: ' + Z_INDEX_TYPE_LABEL + '; display: none; white-space: nowrap; } }', 21);
      styleEl.sheet.insertRule('@media screen { :host([selected]) .type-label { display: flex; align-items: center; gap: 4px; background: rgba(255, 0, 0, 0.85); cursor: grab; } }', 22);
      styleEl.sheet.insertRule('@media screen { :host([hovered]) .type-label { display: flex; align-items: center; gap: 4px; background: rgba(74, 144, 217, 0.85); cursor: grab; } }', 23);
      styleEl.sheet.insertRule('@media screen { :host([reparent-target]) .type-label { display: flex; align-items: center; gap: 4px; background: rgba(255, 152, 0, 0.85); cursor: grab; } }', 24);
      styleEl.sheet.insertRule('@media screen { :host([editable-layout][selected]) .type-label:active, :host([editable-layout][hovered]) .type-label:active { cursor: grabbing; } }', 25);
      styleEl.sheet.insertRule('@media screen { :host([text-focused]) .type-label { display: none; } }', 26);
      styleEl.sheet.insertRule('@media screen { .type-label .parent-btn { pointer-events: auto; cursor: pointer; padding: 1px 8px 3px 0px; user-select: none; opacity: 0.85; } }', 27);
      styleEl.sheet.insertRule('@media screen { .type-label .parent-btn:hover { opacity: 1; } }', 28);
      styleEl.sheet.insertRule('@media print { .type-label { display: none !important; } }', 29);

      this._shadowRoot.appendChild(document.createElement('slot'));

      this._labelEl = document.createElement('div');
      this._labelEl.classList.add('type-label');
      const labelSpan = document.createElement('span');
      this._labelEl.appendChild(labelSpan);
      const parentBtn = document.createElement('span');
      parentBtn.classList.add('parent-btn');
      parentBtn.textContent = '▲';
      parentBtn.title = '상위 요소 선택';
      this._labelEl.appendChild(parentBtn);
      this._shadowRoot.appendChild(this._labelEl);
      this._updateLabelText();
      parentBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        this._selectParent();
      });
    }

    this._ensureResizeHandles();
    const colorRegistry = ColorRegistry.getInstance();

    const tdParent = this.parentElement instanceof LayoutTableCellElement
      ? this.parentElement as LayoutTableCellElement
      : null;
    const isStaticInTd = !!tdParent && this.position !== 'absolute';

    const styleHeight = isStaticInTd && this._model
      ? `${this._model.editableHeight}mm`
      : `${this.absHeight}mm`;
    const styleWidth = isStaticInTd && this._model
      ? `${this._model.editableWidth}mm`
      : `${this.absWidth}mm`;
    const styleLeft = isStaticInTd ? `${tdParent!.paddingLeft}mm` : `${this.relLeft}mm`;
    const styleTop = isStaticInTd ? `${tdParent!.paddingTop}mm` : `${this.relTop}mm`;

    const hostRule = styleEl!.sheet!.cssRules[0] as CSSStyleRule;
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      hostRule.style,
      {
        display: 'inline-block',
        boxSizing: 'border-box',
        height: styleHeight,
        left: styleLeft,
        position: 'absolute',
        top: styleTop,
        width: styleWidth,
        zIndex: `${this.zIndex + 100}`,
        backgroundColor: this._backgroundColor
          ? colorRegistry.getCSSColor(this._backgroundColor) +
          colorRegistry.getOpacityHex(this._backgroundOpacity ?? 1)
          : 'transparent',
      }
    );
  }

  private _ensureResizeHandles(): void {
    if (this._resizeHandles.length === 8) return;

    this._resizeHandles = [];
    this._shadowRoot.querySelectorAll('.resize-handle').forEach((h) => h.remove());

    for (const dir of ['top', 'bottom', 'left', 'right', 'nw', 'ne', 'sw', 'se'] as const) {
      const handle = document.createElement('div');
      handle.classList.add('resize-handle');
      handle.setAttribute('data-handle', dir);
      this._shadowRoot.appendChild(handle);
      this._resizeHandles.push(handle);
    }
  }

  /**
   * 테두리 DOM 생성·갱신: `borderColor`가 설정된 경우 상/하/좌/우 테두리 요소를
   * 생성하거나 기존 요소를 갱신한다. `borderColor`가 없으면 모든 테두리 요소를 제거한다.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _renderBorder() {
    if (!this.isConnected || !this.parentModel) return;

    const ppm = GridCalculator.ppm;
    const colorRegistry = ColorRegistry.getInstance();

    if (this.borderColor) {
      this.setAttribute('border', '');
      const borderStyle: Partial<CSSStyleDeclaration> = {
        overflow: 'hidden',
        position: 'absolute',
        zIndex: String(Z_INDEX_RESIZE_HANDLE),
      };
      const borderInsideStyle: Partial<CSSStyleDeclaration> = {
        borderColor: colorRegistry.getCSSColor(this.borderColor),
        borderStyle: this.borderStyle || DEFAULT_BORDER_STYLE,
        borderWidth: '0',
      };

      const directions: Array<{ dir: string; width: number; outerStyle: Partial<CSSStyleDeclaration>; innerStyle: Partial<CSSStyleDeclaration> }> = [];

      if (this.borderTopWidth) {
        directions.push({
          dir: 'top',
          width: this.borderTopWidth,
          outerStyle: { ...borderStyle, height: `${Math.ceil(this.borderTopWidth * ppm)}px`, top: '0', width: '100%' },
          innerStyle: { ...borderInsideStyle, borderTopWidth: '100px', height: '0', width: '100%' },
        });
      }
      if (this.borderBottomWidth) {
        directions.push({
          dir: 'bottom',
          width: this.borderBottomWidth,
          outerStyle: { ...borderStyle, height: `${Math.ceil(this.borderBottomWidth * ppm)}px`, bottom: '0', width: '100%' },
          innerStyle: { ...borderInsideStyle, borderBottomWidth: '100px', height: '0', width: '100%' },
        });
      }
      if (this.borderLeftWidth) {
        directions.push({
          dir: 'left',
          width: this.borderLeftWidth,
          outerStyle: { ...borderStyle, width: `${Math.ceil(this.borderLeftWidth * ppm)}px`, height: '100%', left: '0' },
          innerStyle: { ...borderInsideStyle, borderLeftWidth: '100px', height: '100%', width: '0' },
        });
      }
      if (this.borderRightWidth) {
        directions.push({
          dir: 'right',
          width: this.borderRightWidth,
          outerStyle: { ...borderStyle, width: `${Math.ceil(this.borderRightWidth * ppm)}px`, height: '100%', right: '0' },
          innerStyle: { ...borderInsideStyle, borderRightWidth: '100px', height: '100%', width: '0' },
        });
      }

      const activeDirs = new Set(directions.map(d => d.dir));

      if (activeDirs.size === 0) {
        this.removeAttribute('border');
        for (const dir of ['top', 'bottom', 'left', 'right'] as const) {
          if (this._borderEls[dir]) {
            this._borderEls[dir]!.remove();
            this._borderEls[dir] = null;
          }
        }
        return;
      }

      for (const { dir, outerStyle, innerStyle } of directions) {
        if (this._borderEls[dir] && this._borderEls[dir]!.isConnected) {
          const border = this._borderEls[dir]!;
          Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, outerStyle);
          const borderInside = border.firstElementChild as HTMLDivElement | null;
          if (borderInside) {
            Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, innerStyle);
          }
        } else {
          const border = document.createElement('div');
          border.setAttribute('border', dir);
          Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, outerStyle);
          const borderInside = document.createElement('div');
          Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, innerStyle);
          border.appendChild(borderInside);
          this._shadowRoot.appendChild(border);
          this._borderEls[dir] = border;
        }
      }

      for (const dir of ['top', 'bottom', 'left', 'right'] as const) {
        if (!activeDirs.has(dir) && this._borderEls[dir]) {
          this._borderEls[dir]!.remove();
          this._borderEls[dir] = null;
        }
      }
    } else {
      this.removeAttribute('border');
      for (const dir of ['top', 'bottom', 'left', 'right'] as const) {
        if (this._borderEls[dir]) {
          this._borderEls[dir]!.remove();
          this._borderEls[dir] = null;
        }
      }
    }
  }

  /**
   * 자식 요소에 InheritStyle 전파.
   * 박스/단락/이미지 자식마다 다른 `parentHeight`를 적용한다.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _propagateInheritStyle() {
    if (!this.isConnected || !this.parentModel) return;

    this.items.forEach(childEl => {
      const childInheritStyle: InheritStyle = {
        ...(this.inheritStyle || {}),
        paddingTop: this.paddingTop || 0,
        paddingRight: this.paddingRight || 0,
        paddingBottom: this.paddingBottom || 0,
        paddingLeft: this.paddingLeft || 0,
        parentWidth: this._model!.editableWidth,
        parentHeight: this._model!.editableHeight,
      };
      if (childEl.type === 'box' || childEl.type === 'table') {
        childEl.inheritStyle = childInheritStyle;
      } else if (childEl.type === 'paragraph') {
        childEl.inheritStyle = {
          ...childInheritStyle,
          parentHeight: this.model!.editableTextHeight,
        }
      } else if (childEl.type === 'image') {
        childEl.inheritStyle = childInheritStyle;
      }
    });
  }

  /**
   * 레이아웃 오케스트레이터. `_layoutStructure()`, `_applyStyle()`,
   * `_renderBorder()`, `_propagateInheritStyle()`를 순서대로 호출한다.
   */
  layout() {
    if (!this.isConnected || !this.parentModel) return;

    this._layoutStructure();
    this._applyStyle();
    this._renderBorder();
    this._propagateInheritStyle();
    this._updateLabelText();

    for (const child of this.children) {
      if (child instanceof LayoutTableElement) child.layout();
    }
  }

  /**
   * 자식 요소를 z-index 역순으로 렌더링한다.
   * 이미지 로딩 등 비동기 처리를 위해 각 자식의 `render()`를 await한다.
   */
  async render() {
    if (!this.isConnected) return;
    const sortedItems = [...this.items].sort((a, b) => a.zIndex - b.zIndex).reverse();
    for (let i = 0; i < sortedItems.length; i++) {
      await sortedItems[i].render();
    }
  }

  appendChild<T extends Node>(node: T) {
    if (this.model) {
      const childInheritStyle: InheritStyle = {
        ...(this.inheritStyle || {}),
        paddingTop: this.paddingTop || 0,
        paddingRight: this.paddingRight || 0,
        paddingBottom: this.paddingBottom || 0,
        paddingLeft: this.paddingLeft || 0,
        parentWidth: this.model.editableWidth,
        parentHeight: this.model.editableHeight,
      };
      if (node.nodeName === 'X-LAYOUT-BOX') {
        const layoutEl = node as unknown as LayoutBoxElement;
        layoutEl.inheritStyle = childInheritStyle;
      } else if (node.nodeName === 'X-LAYOUT-PARAGRAPH') {
        const layoutEl = node as unknown as LayoutParagraphElement;
        layoutEl.inheritStyle = {
          ...childInheritStyle,
          parentHeight: this.model.editableTextHeight,
        }
      } else if (node.nodeName === 'X-LAYOUT-IMAGE') {
        const layoutEl = node as unknown as LayoutImageElement;
        layoutEl.inheritStyle = childInheritStyle;
      }
    }
    return super.appendChild(node);
  }

  set data(data: BoxData) {
    this._rebuildingChildren = true;
    this._pendingData = data;
    try {
      if (data.id !== undefined) this.id = data.id;
      if (data.position !== undefined) this._position = data.position;
      if (data.zIndex !== undefined && this._role !== 'ad' && this._role !== 'header') this._zIndex = data.zIndex;
      if (data.backgroundColor !== undefined) this._backgroundColor = data.backgroundColor;
      if (data.backgroundOpacity !== undefined) this._backgroundOpacity = data.backgroundOpacity;
      if (data.borderTopWidth !== undefined) this._borderTopWidth = data.borderTopWidth;
      if (data.borderBottomWidth !== undefined) this._borderBottomWidth = data.borderBottomWidth;
      if (data.borderLeftWidth !== undefined) this._borderLeftWidth = data.borderLeftWidth;
      if (data.borderRightWidth !== undefined) this._borderRightWidth = data.borderRightWidth;
      if (data.borderStyle !== undefined) this._borderStyle = data.borderStyle;
      if (data.borderColor !== undefined) this._borderColor = data.borderColor;
      if (data.paddingTop !== undefined) this._paddingTop = data.paddingTop;
      if (data.paddingBottom !== undefined) this._paddingBottom = data.paddingBottom;
      if (data.paddingLeft !== undefined) this._paddingLeft = data.paddingLeft;
      if (data.paddingRight !== undefined) this._paddingRight = data.paddingRight;
      if (data.role !== undefined) this.role = data.role;
      if (data.contentUid !== undefined) this.contentUid = data.contentUid;
      if (data.groupMember !== undefined) this.groupMember = data.groupMember.split(',').filter(s => s.length > 0);
      if (data.priority !== undefined) this.priority = data.priority;
      // `lock`은 명시적으로 `true`일 때만 잠금. `undefined`/`false`는 모두 잠금 해제.
      // role 전환(viewer→layout 등) 시 setBoxLockDeep(false)가 `delete next.lock`으로
      // `data.lock`을 `undefined`로 만들기 때문에, 조건부 할당을 사용하면 이전 잠금
      // 상태가 남아 선택/편집 이벤트가 비활성화되는 버그가 발생한다.
      this.lock = data.lock === true;

      this._left = data.left;
      this._top = data.top;
      this._width = data.width;
      this._height = data.height;

      // 자식 reconcile 전에 부모 모델(columnCoords)을 새 데이터로 갱신해야
      // appendChild 중 자식 connectedCallback → layout → relLeft getter가
      // stale columnCoords[this.left]를 읽어 `undefined.x1` 크래시가 발생하지 않는다.
      this._layoutStructure();

      const existingChildren = this.items;
      const existingById = new Map<string, LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | HTMLElement>();
      for (const child of existingChildren) {
        if (child.id) existingById.set(child.id, child);
      }

      const children = data.children;
      const childArray = children
        ? (Array.isArray(children) ? children : [children])
        : [];
      const usedIds = new Set<string>();

      for (let i = 0; i < childArray.length; i++) {
        const child = childArray[i];
        const childId = child.id;

        if (childId && existingById.has(childId)) {
          const existingEl = existingById.get(childId)!;
          usedIds.add(childId);
          const targetType = child.type === 'text' ? 'paragraph' : child.type;
          if (existingEl.localName === 'x-layout-' + targetType) {
            (existingEl as unknown as { data: typeof child }).data = child.type === 'text'
              ? { ...child, type: 'paragraph' as const, column: 1, gap: 0 }
              : child;
            if (existingEl !== this.children[i]) {
              this.appendChild(existingEl);
            }
            continue;
          }
        }

        this._appendChildData(child);
        if (childId) usedIds.add(childId);
      }

      for (const child of existingChildren) {
        if (child.id && !usedIds.has(child.id)) {
          child.remove();
        }
      }

      this.layout();
      this.render();
      this.requestRerenderAffectedParagraphs();
    } finally {
      this._rebuildingChildren = false;
      this._pendingData = null;
    }
  }

  /**
   * 자식 데이터를 받아 적절한 커스텀 엘리먼트를 생성하여 추가한다.
   *
   * @param child - BoxData | ParagraphData | TextData | ImageData
   */
  /**
   * 자식 데이터를 받아 적절한 커스텀 엘리먼트를 생성하여 추가하고, 생성된 요소를 반환한다.
   *
   * `_appendChildData`의 public 래퍼로, 외부(예: `LayoutEditController`의 reparent)에서
   * 새 자식을 추가할 때 사용한다. `data` setter의 전체 초기화 파이프라인
   * (`_layoutStructure` → `_applyStyle` → `_renderBorder` → `_propagateInheritStyle` → `render`)
   * 가 실행되므로, 부모 컨텍스트에 맞춰 모델/상속 스타일이 올바르게 설정된다.
   *
   * @example
   * ```ts
   * const newBox = parentBox.appendChildData(childData) as LayoutBoxElement;
   * // newBox는 parentBox의 자식으로 완전히 초기화됨
   * ```
   *
    * @param child - 추가할 자식 데이터 (BoxData | ParagraphData | TextData | ImageData)
    * @returns 생성된 커스텀 엘리먼트. 타입별로 LayoutBoxElement | LayoutParagraphElement | LayoutImageElement
    *
    * 자식 추가 후 형제 박스/단락의 오버랩 회피 재계산을 위해
    * `requestRerenderAffectedParagraphs()`를 호출한다. 새 자식이 높은 zIndex를 가지면
    * 기존 단락들이 새 자식과 겹치는 영역을 회피하도록 재렌더링된다.
    */
  appendChildData(child: BoxData | ParagraphData | TextData | ImageData | TableData): LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | HTMLElement {
    if (child.type === 'box') {
      const boxEl = document.createElement('x-layout-box');
      boxEl.data = child;
      this.appendChild(boxEl);
      this.requestRerenderAffectedParagraphs();
      return boxEl;
    } else if (child.type === 'paragraph') {
      const paragraphEl = document.createElement('x-layout-paragraph');
      paragraphEl.data = child;
      this.appendChild(paragraphEl);
      this.requestRerenderAffectedParagraphs();
      return paragraphEl;
    } else if (child.type === 'text') {
      const paragraphEl = document.createElement('x-layout-paragraph');
      paragraphEl.data = {
        ...child,
        type: 'paragraph',
        column: 1,
        gap: 0,
      };
      this.appendChild(paragraphEl);
      this.requestRerenderAffectedParagraphs();
      return paragraphEl;
    } else if (child.type === 'table') {
      const tableEl = document.createElement('x-layout-table');
      (tableEl as unknown as { data: TableData }).data = child;
      this.appendChild(tableEl);
      this.requestRerenderAffectedParagraphs();
      return tableEl;
    } else {
      const imageEl = document.createElement('x-layout-image');
      imageEl.data = child;
      this.appendChild(imageEl);
      this.requestRerenderAffectedParagraphs();
      return imageEl;
    }
  }

  private _appendChildData(child: BoxData | ParagraphData | TextData | ImageData | TableData): void {
    if (child.type === 'box') {
      const boxEl = document.createElement('x-layout-box');
      boxEl.data = child;
      this.appendChild(boxEl);
    } else if (child.type === 'paragraph') {
      const paragraphEl = document.createElement('x-layout-paragraph');
      paragraphEl.data = child;
      this.appendChild(paragraphEl);
    } else if (child.type === 'text') {
      const paragraphEl = document.createElement('x-layout-paragraph');
      paragraphEl.data = {
        ...child,
        type: 'paragraph',
        column: 1,
        gap: 0,
      };
      this.appendChild(paragraphEl);
    } else if (child.type === 'table') {
      const tableEl = document.createElement('x-layout-table');
      (tableEl as unknown as { data: TableData }).data = child;
      this.appendChild(tableEl);
    } else if (child.type === 'image') {
      const imageEl = document.createElement('x-layout-image');
      imageEl.data = child;
      this.appendChild(imageEl);
    }
  }

  /**
   * 자식 요소들을 `BoxData[] | ParagraphData | TextData | ImageData` 형태로 직렬화한다.
   * 자식이 1개이고 box가 아닌 경우 단일 객체를 반환하고, 그 외에는 배열을 반환한다.
   */
  private _serializeChildren(): BoxData[] | ParagraphData | TextData | ImageData | TableData | undefined {
    const allChildren = Array.from(this.children).filter(
      (c): c is HTMLElement & { data: BoxData | ParagraphData | TextData | ImageData | TableData } =>
        c instanceof LayoutBoxElement || c instanceof LayoutTableElement
        || c instanceof LayoutParagraphElement || c instanceof LayoutImageElement,
    );
    const items = allChildren.map(e => e.data).filter(e => !!e) as (BoxData | ParagraphData | TextData | ImageData | TableData)[];
    if (items.length === 0) return undefined;
    if (items.length === 1 && items[0].type !== 'box') return items[0];
    return items as BoxData[];
  }

  set left(value: number) {
    if (this._left === value) return;
    this._left = value;
    this.layout();
    if (this._dragAffectedParagraphs !== null) this._scheduleDragRerender();
    else this.scheduleRerenderAffectedParagraphs();
  }

  set top(value: number) {
    if (this._top === value) return;
    this._top = value;
    this.layout();
    if (this._dragAffectedParagraphs !== null) this._scheduleDragRerender();
    else this.scheduleRerenderAffectedParagraphs();
  }

  set width(value: number) {
    if (this._width === value) return;
    this._width = value;
    this.layout();
    if (this._dragAffectedParagraphs !== null) this._scheduleDragRerender();
    else this.scheduleRerenderAffectedParagraphs();
  }

  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this.layout();
    if (this._dragAffectedParagraphs !== null) this._scheduleDragRerender();
    else this.scheduleRerenderAffectedParagraphs();
  }

  set position(value: BoxPosition) {
    if (this._position === value) return;
    this._position = value;
    this._updateTdStaticAttr();
    this.layout();
  }

  set zIndex(value: number) {
    if (this._role === 'ad' || this._role === 'header') return;
    const oldValue = this._zIndex;
    if (this._zIndex === value) return;
    this._zIndex = value;
    this.layout();
    this.requestRerenderAffectedParagraphs();
    this.editManager?._dispatchBoxPropertyChange({
      box: this,
      property: 'zIndex',
      oldValue,
      newValue: value,
    });
  }

  set backgroundColor(value: string | undefined) {
    if (this._backgroundColor === value) return;
    this._backgroundColor = value;
    this.layout();
  }

  set backgroundOpacity(value: number | undefined) {
    if (this._backgroundOpacity === value) return;
    this._backgroundOpacity = value;
    this.layout();
  }

  set borderTopWidth(value: number) {
    if (this._borderTopWidth === value) return;
    this._borderTopWidth = value;
    this._renderBorder();
  }

  set borderBottomWidth(value: number) {
    if (this._borderBottomWidth === value) return;
    this._borderBottomWidth = value;
    this._renderBorder();
  }

  set borderLeftWidth(value: number) {
    if (this._borderLeftWidth === value) return;
    this._borderLeftWidth = value;
    this._renderBorder();
  }

  set borderRightWidth(value: number) {
    if (this._borderRightWidth === value) return;
    this._borderRightWidth = value;
    this._renderBorder();
  }

  set borderStyle(value: BoxBorderStyle) {
    if (this._borderStyle === value) return;
    this._borderStyle = value;
    this._renderBorder();
  }

  set borderColor(value: string | undefined) {
    if (this._borderColor === value) return;
    this._borderColor = value;
    this._renderBorder();
  }

  set paddingTop(value: number) {
    if (this._paddingTop === value) return;
    this._paddingTop = value;
    this.layout();
    if (this._dragAffectedParagraphs !== null) this._scheduleDragRerender();
    else this.scheduleRerenderAffectedParagraphs();
  }

  set paddingRight(value: number) {
    if (this._paddingRight === value) return;
    this._paddingRight = value;
    this.layout();
    if (this._dragAffectedParagraphs !== null) this._scheduleDragRerender();
    else this.scheduleRerenderAffectedParagraphs();
  }

  set paddingBottom(value: number) {
    if (this._paddingBottom === value) return;
    this._paddingBottom = value;
    this.layout();
    if (this._dragAffectedParagraphs !== null) this._scheduleDragRerender();
    else this.scheduleRerenderAffectedParagraphs();
  }

  set paddingLeft(value: number) {
    if (this._paddingLeft === value) return;
    this._paddingLeft = value;
    this.layout();
    if (this._dragAffectedParagraphs !== null) this._scheduleDragRerender();
    else this.scheduleRerenderAffectedParagraphs();
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.layout();
  }

  get data(): BoxData {
    if (this._rebuildingChildren && this._pendingData) {
      return this._pendingData;
    }
    return {
      id: this.id || undefined,
      type: this.type,
      left: this.left,
      top: this.top,
      width: this.width,
      height: this.height,
      position: this.position,
      zIndex: this.zIndex,
      backgroundColor: this.backgroundColor,
      backgroundOpacity: this.backgroundOpacity,
      borderTopWidth: this.borderTopWidth,
      borderBottomWidth: this.borderBottomWidth,
      borderLeftWidth: this.borderLeftWidth,
      borderRightWidth: this.borderRightWidth,
      borderStyle: this.borderStyle,
      borderColor: this.borderColor,
      paddingTop: this.paddingTop,
      paddingRight: this.paddingRight,
      paddingBottom: this.paddingBottom,
      paddingLeft: this.paddingLeft,
      role: this._role,
      contentUid: this._contentUid,
      groupMember: this._groupMember,
      priority: this.priority,
      lock: this._lock || undefined,
      children: this._serializeChildren(),
    };
  }

  get left() { return this._left; }
  get top() { return this._top; }
  get width() { return this._width; }
  get height() { return this._height; }
  get position() { return this._position; }
  get zIndex() {
    if (this._role === 'ad') return Z_INDEX_ROLE_AD;
    if (this._role === 'header') return Z_INDEX_ROLE_HEADER;
    return this._zIndex;
  }
  get backgroundColor() { return this._backgroundColor; }
  get backgroundOpacity() { return this._backgroundOpacity; }
  get borderColor() { return this._borderColor; }
  get borderStyle() { return this._borderStyle; }
  get borderTopWidth() { return this._borderTopWidth; }
  get borderBottomWidth() { return this._borderBottomWidth; }
  get borderLeftWidth() { return this._borderLeftWidth; }
  get borderRightWidth() { return this._borderRightWidth; }
  get paddingTop() { return this._paddingTop; }
  get paddingRight() { return this._paddingRight; }
  get paddingBottom() { return this._paddingBottom; }
  get paddingLeft() { return this._paddingLeft; }

  get role(): BoxRole { return this._role ?? 'none'; }
  set role(value: BoxRole | null | undefined) {
    const normalized = (value === null || value === undefined || value === 'none') ? 'none' : value;
    const oldValue = this._role ?? 'none';
    if (normalized === oldValue) return;

    // 역할 고정 z-index에서 해제되는 경우, 형제 요소 중 최대 z-index + 1로 복원
    const wasOverrideRole = (oldValue === 'ad' || oldValue === 'header');
    const isOverrideRole = (normalized === 'ad' || normalized === 'header');
    if (wasOverrideRole && !isOverrideRole) {
      const parent = this.parentElement as LayoutBoxElement | LayoutDocumentElement | null;
      const siblings = parent?.items ?? [];
      const maxZ = siblings.length === 0
        ? 0
        : Math.max(...siblings
          .filter(s => s !== this)
          .map(s => {
            const z = s.zIndex;
            if (z === Z_INDEX_ROLE_AD || z === Z_INDEX_ROLE_HEADER) return 0;
            return z ?? 0;
          })
        );
      this._zIndex = Math.min(maxZ + 1, Z_INDEX_MAX_LAYOUT);
    }

    if (value === null || value === undefined || value === 'none') {
      this._role = undefined;
      this.removeAttribute('role');
    } else {
      this._role = value;
      this.setAttribute('role', value);
    }
    this.layout();
    this.requestRerenderAffectedParagraphs();
    this.editManager?._dispatchBoxPropertyChange({
      box: this,
      property: 'role',
      oldValue,
      newValue: normalized,
    });
  }

  get contentUid(): string | undefined { return this._contentUid; }
  set contentUid(value: string | null | undefined) {
    const normalized = value ?? undefined;
    const oldValue = this._contentUid;
    if (normalized === oldValue) return;
    if (normalized === undefined) {
      this._contentUid = undefined;
      this.removeAttribute('content-uid');
    } else {
      this._contentUid = normalized;
      this.setAttribute('content-uid', normalized);
    }
    this.editManager?._dispatchBoxPropertyChange({
      box: this,
      property: 'contentUid',
      oldValue,
      newValue: normalized,
    });
  }

  get groupMember(): string[] {
    if (!this._groupMember) return [];
    return this._groupMember.split(',').filter(s => s.length > 0);
  }
  set groupMember(value: string[]) {
    const oldValue = this._groupMember ? this._groupMember.split(',').filter(s => s.length > 0) : [];
    if (value.length > 0) {
      const joined = value.join(',');
      this._groupMember = joined;
      this.setAttribute('group-member', joined);
    } else {
      this._groupMember = undefined;
      this.removeAttribute('group-member');
    }
    const newValue = this._groupMember ? this._groupMember.split(',').filter(s => s.length > 0) : [];
    if (oldValue.length !== newValue.length || oldValue.some((v, i) => v !== newValue[i])) {
      this.editManager?._dispatchBoxPropertyChange({
        box: this,
        property: 'groupMember',
        oldValue,
        newValue,
      });
    }
  }

  get priority() { return this._priority ?? 0; }
  set priority(value: number) {
    const oldValue = this._priority ?? 0;
    if (value === oldValue) return;
    this._priority = value;
    this.setAttribute('priority', String(value));
    this.editManager?._dispatchBoxPropertyChange({
      box: this,
      property: 'priority',
      oldValue,
      newValue: value,
    });
  }

  get lock(): boolean { return this._lock; }
  set lock(value: boolean) {
    this._lock = value;
    if (value) {
      this.setAttribute('lock', '');
    } else {
      this.removeAttribute('lock');
    }
  }

  get inheritStyle() { return this._inheritStyle; }
  get model() { return this._model; }

  get parentElement() {
    return super.parentElement as LayoutDocumentElement | LayoutBoxElement;
  }

  get parentModel() {
    return this.parentElement?.model;
  }

  get items() {
    return Array.from(this.querySelectorAll<LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | LayoutTableElement>(":scope > x-layout-box, :scope > x-layout-paragraph, :scope > x-layout-image, :scope > x-layout-table"));
  }

  get textStyle(): TextStyle {
    return this.parentModel?.textStyle || {};
  }

  get paragraphStyle(): ParagraphStyle {
    return this.parentModel?.paragraphStyle || {};
  }

  get relLeft() {
    if (this.position !== 'absolute') {
      if (this.parentModel) {
        const coord = this.parentModel.columnCoords[this.left];
        return coord ? coord.x1 : 0;
      }
      return 0;
    } else {
      return (this.inheritStyle?.paddingLeft || 0) + this.left;
    }
  }

  get relTop() {
    if (this.position !== 'absolute') {
      if (this.parentModel) {
        const { columnCoords, lineHeight } = this.parentModel;
        const coord = columnCoords[this.left];
        return coord ? coord.y1 + (lineHeight * this.top) : 0;
      } else {
        return 0;
      }
    } else {
      return (this.inheritStyle?.paddingTop || 0) + this.top;
    }
  }

  get absLeft(): number {
    if (this.parentElement.type === "document") return this.relLeft;
    return this.parentElement.absLeft + this.relLeft;
  }

  get absTop(): number {
    if (this.parentElement.type === "document") return this.relTop;
    return this.parentElement.absTop + this.relTop;
  }

  get absWidth() {
    if (this.position !== 'absolute') {
      if (this.parentModel) {
        const { columnCoords, columnCount } = this.parentModel;
        const col = Math.min(columnCount, this.left + this.width) - 1;
        if (col < 0 || !columnCoords[col] || !columnCoords[this.left]) return 0; // guard: width=0 crash
        return columnCoords[col].x2 - columnCoords[this.left].x1;
      } else {
        return 0;
      }
    } else {
      return this.width;
    }
  }

  get absHeight(): number {
    // TD 내부 static box는 height가 line count(=1)가 아닌 TD의 content height로
    // 해석되어야 한다. 그렇지 않으면 lineHeight * 1 - (lineHeight - fontSize) =
    // fontSize가 되어, 이 box를 부모로 하는 중첩 표의 contentHeight가 폰트 크기
    // 수준으로 붕괴한다. TD의 GridCalculator.contentHeight가 곧 box의 높이다.
    const tdParent: LayoutTableCellElement | null = this.parentElement instanceof LayoutTableCellElement
      ? this.parentElement as LayoutTableCellElement
      : null;
    if (tdParent && this.position !== 'absolute') {
      const tdModel: GridCalculator | undefined = tdParent.model;
      if (tdModel) {
        return Math.max(0, tdModel.contentHeight);
      }
    }

    let calcHeight = 0;
    if (this.position !== 'absolute') {
      if (this.parentModel) {
        const { fontSize, lineHeight } = this.parentModel;
        calcHeight = lineHeight * this.height - (lineHeight - fontSize);
      }
    } else {
      calcHeight = this.height;
    }
    // absolute box는 부모의 실제 콘텐츠 영역 하단(contentHeight)까지 확장될 수 있다.
    // editableHeight는 lineHeight 배수로 버림된 값이라 부모 하단이 라인 중간에 걸친 경우
    // 박스 하단이 더 아래로 내려가지 못하고 height가 줄어드는 문제가 있었다.
    const limitHeight = this.parentModel?.contentHeight
      ?? this.parentModel?.editableHeight
      ?? 0;
    if (limitHeight) {
      const top = this.parentElement.type !== 'document' ? this.relTop : 0;
      calcHeight = Math.min(calcHeight, limitHeight - (top - (this._inheritStyle?.paddingTop || 0)));
    }
    return Math.max(0, calcHeight);
  }

  get overlayElements() {
    const list: LayoutBoxElement[] = [];
    if (this.parentElement.type !== 'document') {
      list.push(...this.parentElement.overlayElements);
    }

    let overlay = this.parentElement.items.filter(i => i.type === 'box' && i !== this && i.zIndex > this.zIndex) as LayoutBoxElement[];
    overlay = overlay.filter(i => checkOverlap(i, this));
    // overlapMode === 'none'인 이미지 박스는 오버랩 요소에서 제외
    overlay = overlay.filter(i => {
      if (i.contentType === 'image') {
        const imgEl = i.contentElement as LayoutImageElement | null;
        if (imgEl && imgEl.overlapMode === 'none') return false;
      }
      return true;
    });

    list.push(...overlay);

    return list;
  }

  get printPostData() {
    const data: PrintPostData[] = [];
    const rect = this.getBoundingClientRect();

    const colorRegistry = ColorRegistry.getInstance();

    data.push({
      color: this.borderColor ? colorRegistry.get(this.borderColor) : undefined,
      backgroundColor: this.backgroundColor ? colorRegistry.get(this.backgroundColor) : undefined,
      backgroundOpacity: this.backgroundOpacity,
      data: {
        ...this.data,
        borderStyle: this.borderStyle || DEFAULT_BORDER_STYLE,
      },
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
    });

    // z-index 오름차순(낮은 것부터)으로 push한다.
    // PDF 콘텐츠 스트림은 나중에 추가된 것이 위에 렌더링되므로,
    // CSS z-index 동작(낮은 것이 먼저 그려지고 높은 것이 위에 덮임)과
    // 일치하려면 낮은 z-index부터 배열에 들어가야 한다.
    const allChildren = Array.from(this.children).filter(
      (c): c is HTMLElement & { printPostData: PrintPostData[]; zIndex: number } =>
        c instanceof LayoutBoxElement || c instanceof LayoutTableElement
        || c instanceof LayoutParagraphElement || c instanceof LayoutImageElement,
    );
    const sortedChildren = allChildren.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
    for (const child of sortedChildren) {
      data.push(...child.printPostData);
    }

    return data;
  }

  get type() { return 'box' as const; }

  get contentType(): 'image' | 'paragraph' | 'table' | null {
    if (this.items.length !== 1) {
      const tableChild = Array.from(this.children).find(
        (c): c is LayoutTableElement => c instanceof LayoutTableElement,
      );
      return tableChild ? 'table' : null;
    }
    if (this.items[0].type === 'box') return this.items[0].contentType;
    if (this.items[0] instanceof LayoutTableElement) return 'table';
    return this.items[0].type;
  }

  /**
   * `contentType`과 동일한 재귀 경로를 따라 가장 깊은 비-box 자식 요소를 반환한다.
   *
   * `contentType === 'image'`인 경우, 실제 `LayoutImageElement`는 중첩 box 안에
   * 있을 수 있다. `getOverlapSizePX` 등에서 `items[0]`을 직접 image로
   * 캐스트하면 중첩 box인 경우 잘못된 요소를 참조하게 되므로 이 getter로
   * 실제 image/paragraph 요소를 안전하게 얻는다.
   *
   * @returns 자식이 하나이고 그 자식이 box이면 재귀적으로 파고들어
   *          최종 non-box 자식을 반환. 자식이 없거나 여럿이면 null.
   *
   * @example
   * // box(A) → box(B) → image(C)
   * // A.contentElement → C (LayoutImageElement)
   * // A.contentType → 'image'
   */
  get contentElement(): LayoutImageElement | LayoutParagraphElement | null {
    if (this.items.length !== 1) return null;
    const child = this.items[0];
    if (child.type === 'box') return (child as LayoutBoxElement).contentElement;
    return child as LayoutImageElement | LayoutParagraphElement;
  }

  /**
   * 선택 시 좌측상단에 표시할 라벨 텍스트를 갱신한다.
   * - 자식이 하나인 paragraph/image 박스: `텍스트` / `이미지`
   * - 그 외: `박스`
   * - role이 'none'이 아닐 경우 `[role=XXX]` 접미사를 붙인다.
   * @returns 없음
   * @example 단일 paragraph + role=body → `텍스트[role=body]`
   * @example 자식이 여러 box → `박스[role=group-article]`
   */
  private _updateLabelText(): void {
    if (!this._labelEl) return;

    const contentType = this.contentType;
    const base = contentType === 'image'
      ? '이미지'
      : contentType === 'paragraph'
        ? '텍스트'
        : contentType === 'table'
          ? '표'
          : '박스';
    const role = this._role && this._role !== 'none' ? this._role : undefined;
    const text = role ? `${base}[role=${role}]` : base;
    const span = this._labelEl.firstElementChild as HTMLSpanElement | null;
    if (span && span.textContent !== text) {
      span.textContent = text;
    }

    if (contentType === null) {
      this.setAttribute('content-type-null', '');
    } else {
      this.removeAttribute('content-type-null');
    }
  }

  /**
   * 라벨의 `▲` 버튼 클릭 핸들러.
   * 현재 선택을 모두 해제한 뒤, 이 박스의 부모 박스가 존재하면 그 부모를 선택한다.
   * 부모가 document(루트)이거나 선택 제한에 걸리면 아무 일도 일어나지 않는다.
   * 선택 이동 후 마우스가 여전히 이 박스 위에 있으므로 hover 상태를 복원한다.
   * @returns 없음
   * @example 단일 paragraph + role=body → `텍스트[role=body]`
   * @example 자식이 여러 box → `박스[role=group-article]`
   */
  private _selectParent(): void {
    const manager = this.editManager;
    if (!manager) return;
    let parent: HTMLElement | null = this.parentElement;
    while (parent && !(parent instanceof LayoutBoxElement)) {
      parent = parent.parentElement;
    }
    if (!parent || !(parent instanceof LayoutBoxElement)) return;
    manager.clearLayoutSelection(false);
    manager.selectLayout(parent);
    this._onLayoutMouseEnter();
  }

  private _updateTdStaticAttr(): void {
    if (!this._editableLayout) {
      this.removeAttribute('td-static');
      return;
    }
    if (this.parentElement instanceof LayoutTableCellElement && this._position === 'static') {
      this.setAttribute('td-static', '');
    } else {
      this.removeAttribute('td-static');
    }
  }

  get editableLayout() { return this._editableLayout; }

  set editableLayout(value: boolean) {
    if (this._isPrint) return;
    if (this._editableLayout === value) return;
    this._editableLayout = value;

    if (value) {
      this.style.cursor = 'grab';
      this.setAttribute('editable-layout', '');
      this._updateTdStaticAttr();
    } else {
      this.removeAttribute('hovered');
      this.removeAttribute('editable-layout');
      this.style.cursor = '';
    }
  }

  private _onLayoutMouseEnter = (): void => {
    if (this._isPrint) return;
    if (this._lock) return;
    const manager = this.editManager;
    if (!manager) return;
    if (manager._isDraggingLayout() || manager._isResizingLayout()) return;
    if (manager._isInsertDragging()) return;
    let ancestor: Element | null = this.parentElement;
    while (ancestor) {
      if (ancestor.hasAttribute('hovered')) {
        ancestor.removeAttribute('hovered');
      }
      ancestor = ancestor.parentElement;
    }
    if (this.hasAttribute('selected')) return;
    this.setAttribute('hovered', '');
  }

  private _onLayoutMouseLeave = (event: MouseEvent): void => {
    if (this._isPrint) return;
    this.removeAttribute('hovered');
    const manager = this.editManager;
    if (!manager) return;
    if (manager._isDraggingLayout() || manager._isResizingLayout()) return;
    if (manager._isInsertDragging()) return;
    const related = event.relatedTarget as Element | null;
    if (!related) return;
    let target: Element | null = related;
    while (target) {
      if (target === this) return;
      target = target.parentElement;
    }
    this._hoverNearestLayoutChild(event.clientX, event.clientY);
  }

  private _hoverNearestLayoutChild(clientX: number, clientY: number): void {
    const root = this.shadowRoot;
    if (!root) return;
    const hit = root.elementFromPoint(clientX, clientY);
    if (!hit) return;
    // 라벨/버튼은 box 영역의 일부이므로 hit 대상에서 제외한다.
    if (hit.closest('.type-label')) return;
    let el: Element | null = hit;
    while (el) {
      if (el instanceof LayoutBoxElement && !el.hasAttribute('selected')) {
        el._onLayoutMouseEnter();
        return;
      }
      el = el.parentElement;
    }
  }

  /**
   * Place Gun 활성 상태일 때 box의 mousedown 이벤트를 EditManager에 위임한다.
   *
   * Place Gun이 비활성이면 아무 동작도 하지 않고 다른 핸들러가 정상 동작하도록 한다.
   * 활성이면 `EditManager.handlePlaceGunMouseDown`이 매칭 검사 후 주입을 수행하고,
   * 매칭 성공 시 `preventDefault` + `stopPropagation`으로 후속 핸들러를 차단한다.
   */
  private _onPlaceGunMouseDown = (event: MouseEvent): void => {
    if (this._isPrint) return;
    const manager = this.editManager;
    if (!manager) return;
    if (!manager.placeGunActive) return;
    manager.handlePlaceGunMouseDown(this, event);
  }

  /**
   * position 변환 시 모든 좌표 필드를 원자적으로 갱신하고 layout()을 한 번만 호출한다.
   *
   * setter를 개별 호출하면 position이 먼저 바뀐 상태에서 left/width가 아직 이전 좌표계 값인
   * 상태로 layout()이 실행되어 columnWidth.slice(-122, ...) 같은 잘못된 인덱스가 발생한다.
   * 이 메서드는 private 필드를 직접 설정한 후 layout()과 scheduleRerenderAffectedParagraphs()를
   * 한 번씩만 호출하여 문제를 방지한다.
   *
   * @param position - 새 position 모드 ('static' | 'absolute')
   * @param left - 새 left 값 (static: 컬럼 인덱스, absolute: mm)
   * @param top - 새 top 값 (static: 라인 인덱스, absolute: mm)
   * @param width - 새 width 값 (static: 컬럼 스팬 수, absolute: mm)
   * @param height - 새 height 값 (static: 라인 수, absolute: mm)
   */
  applyPositionConversion(
    position: BoxPosition,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    this._applyPositionConversion(position, left, top, width, height);
  }

  /**
   * position 변환 시 모든 좌표 필드를 원자적으로 갱신하고 layout()을 한 번만 호출한다.
   *
   * setter를 개별 호출하면 position이 먼저 바뀐 상태에서 left/width가 아직 이전 좌표계 값인
   * 상태로 layout()이 실행되어 columnWidth.slice(-122, ...) 같은 잘못된 인덱스가 발생한다.
   * 이 메서드는 private 필드를 직접 설정한 후 layout()과 scheduleRerenderAffectedParagraphs()를
   * 한 번씩만 호출하여 문제를 방지한다.
   *
   * @param position - 새 position 모드 ('static' | 'absolute')
   * @param left - 새 left 값 (static: 컬럼 인덱스, absolute: mm)
   * @param top - 새 top 값 (static: 라인 인덱스, absolute: mm)
   * @param width - 새 width 값 (static: 컬럼 스팬 수, absolute: mm)
   * @param height - 새 height 값 (static: 라인 수, absolute: mm)
   */
  private _applyPositionConversion(
    position: BoxPosition,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    if (position === 'absolute' && this._position === 'static') {
      const parentModel = this.parentModel;
      if (parentModel) {
        const { columnWidth, gaps } = parentModel;
        this._savedColumns = columnWidth.slice(this._left, this._left + this._width);
        this._savedGap = gaps.slice(this._left, this._left + this._width - 1);
      }
    } else if (position === 'static') {
      this._savedColumns = 1;
      this._savedGap = 0;
    }

    this._position = position;
    this._left = left;
    this._top = top;
    this._width = width;
    this._height = height;
    this.layout();
    this.scheduleRerenderAffectedParagraphs();
  }

  // ─── Position Conversion Helpers ───────────────────────────────

  /**
   * static 좌표(컬럼 인덱스, 라인 인덱스)를 absolute 좌표(mm)로 변환한다.
   * width/height는 absWidth/absHeight getter를 통해 mm로 변환한다.
   * parentModel이 필요하다.
   */
  private _staticToAbsoluteCoords(left: number, top: number): { left: number; top: number; width: number; height: number } {
    const { columnCoords, lineHeight } = this.parentModel!;
    return {
      left: columnCoords[left].x1,
      top: columnCoords[left].y1 + lineHeight * top,
      width: this.absWidth,
      height: this.absHeight,
    };
  }

  /**
   * absolute 좌표(mm)를 static 좌표(컬럼 인덱스, 라인 인덱스)로 변환한다.
   * 컬럼/라인 스냅과 범위 클램핑을 적용한다.
   * parentModel이 필요하다.
   */
  private _absoluteToStaticCoords(left: number, top: number, width: number, height: number): { left: number; top: number; width: number; height: number } {
    const { columnCoords, lineHeight, fontSize, editableWidth, editableHeight, columnCount } = this.parentModel!;
    const avgColWidth = editableWidth / columnCount;
    const editAreaLeft = columnCoords[0].x1;
    const editAreaTop = columnCoords[0].y1;

    const nearestColumn = Math.round((left - editAreaLeft) / avgColWidth);
    const clampedColumn = Math.max(0, Math.min(columnCount - Math.round(width / avgColWidth), nearestColumn));
    const nearestLine = Math.round((top - editAreaTop) / lineHeight);
    const maxTop = Math.floor((editableHeight - (lineHeight * Math.round(height / lineHeight) - (lineHeight - fontSize))) / lineHeight);
    const clampedLine = Math.max(0, Math.min(maxTop, nearestLine));
    const staticWidth = Math.max(1, Math.round(width / avgColWidth));
    const staticHeight = Math.max(1, Math.round(height / lineHeight));

    return {
      left: clampedColumn,
      top: clampedLine,
      width: staticWidth,
      height: staticHeight,
    };
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * 박스의 position 모드를 변환한다.
   * static → absolute: 컬럼/라인 단위의 좌표를 mm 단위로 변환하고, column/gap 설정을 보존한다.
   * absolute → static: mm 단위의 좌표를 컬럼/라인 단위로 변환하고, column/gap을 재계산한다.
   *
   * 이 메서드는 드래그 중 문서 영역 밖 이동 시 자동 호출되며, 프로그래밍 방식으로도 사용할 수 있다.
   *
   * @param targetPosition - 변환할 position 모드 ('static' | 'absolute')
   * @throws {Error} parentModel이 없는 경우 (DOM에 연결되지 않았거나 렌더링되지 않은 경우)
   */
  convertPosition(targetPosition: BoxPosition): void {
    if (this._position === targetPosition) return;

    const parentModel = this.parentModel;
    if (!parentModel) {
      throw new Error('Cannot convert position: parentModel is not available. Ensure the element is connected and rendered.');
    }

    if (this._position === 'static' && targetPosition === 'absolute') {
      const { left: absLeft, top: absTop, width: absWidth, height: absHeight } = this._staticToAbsoluteCoords(this._left, this._top);
      this._applyPositionConversion('absolute', absLeft, absTop, absWidth, absHeight);
    } else if (this._position === 'absolute' && targetPosition === 'static') {
      const { left: clampedColumn, top: clampedLine, width: staticWidth, height: staticHeight } = this._absoluteToStaticCoords(this._left, this._top, this._width, this._height);
      this._applyPositionConversion('static', clampedColumn, clampedLine, staticWidth, staticHeight);
    }
  }

  /**
   * 영향받는 단락 요소를 즉시 다시 렌더링한다. (외부 API용)
   */
  private scheduleRerenderAffectedParagraphs(): void {
    if (this._rerenderScheduled) return;
    this._rerenderScheduled = true;
    queueMicrotask(() => {
      this._rerenderScheduled = false;
      const affected = this._collectAffectedParagraphs();
      this._renderAffectedParagraphs(affected);
    });
  }

  /**
   * 드래그/리사이즈 시작. 추적 Set 초기화.
   * `LayoutEditController`가 드래그/리사이즈 시작 시 호출한다.
   */
  startDragTracking(): void {
    this._dragAffectedParagraphs = new Set();
  }

  /**
   * 드래그/리사이즈 종료. 보류된 rAF 취소 후 모든 누적 단락 즉시 갱신.
   * `LayoutEditController`가 드래그/리사이즈 종료 시 호출한다.
   */
  flushDragRerender(): void {
    if (this._dragRafId !== null) {
      cancelAnimationFrame(this._dragRafId);
      this._dragRafId = null;
    }
    this.layout();
    if (this._dragAffectedParagraphs) {
      this._renderAffectedParagraphs(this._dragAffectedParagraphs);
    }
    this._dragAffectedParagraphs = null;
  }

  /**
   * 드래그/리사이즈 중 영향받는 단락을 rAF로 배치하여 갱신한다.
   * 동일 rAF 프레임 내 여러 setter 호출을 1회 갱신으로 배치한다.
   */
  private _scheduleDragRerender(): void {
    if (this._dragRafId === null) {
      this._dragRafId = requestAnimationFrame(() => {
        this._dragRafId = null;
        this.layout();
        const current = this._collectAffectedParagraphs();
        if (this._dragAffectedParagraphs) {
          for (const p of current) this._dragAffectedParagraphs.add(p);
          this._renderAffectedParagraphs(this._dragAffectedParagraphs);
        }
      });
    }
  }

  /**
   * 영향받는 단락 요소 집합을 수집한다.
   * 자식 박스를 재귀적으로 탐색하여 모든 단락 요소를 찾는다.
   *
   * **최적화**: 형제 box의 자식 단락은 모두 수집하는 대신, 현재 box의 사각형과
   * 실제로 교차하는 형제 box의 자식 단락만 수집한다. 이를 통해 매 setter 호출마다
   * (drag/resize 중 rAF 콜백마다) 발생하던 형제 전체 순회 비용을 줄인다.
   * box 자체의 자식 단락은 항상 수집한다 (box 내부 텍스트가 box의 새 위치에
   * 맞춰 재배치되어야 함).
   */
  private _collectAffectedParagraphs(): Set<LayoutParagraphElement> {
    const affected = new Set<LayoutParagraphElement>();

    for (const item of this.items) {
      this._collectParagraphs(item, affected);
    }

    const tableChild = Array.from(this.children).find(
      (c): c is LayoutTableElement => c instanceof LayoutTableElement,
    );
    if (tableChild) {
      this._collectParagraphs(tableChild, affected);
    }

    if (this.parentElement) {
      const myRect = this._getRectInParentForCollection();
      if (!myRect) {
        // 부모가 없거나 rect를 계산할 수 없는 예외 상황. 안전하게 모든 형제 수집.
        for (const sibling of this.parentElement.items) {
          if (sibling === this) continue;
          this._collectParagraphs(sibling, affected);
        }
        return affected;
      }
      for (const sibling of this.parentElement.items) {
        if (sibling === this) continue;
        // paragraph/image는 box가 아니므로 AABB 비교가 불가능하다.
        // 텍스트 회피의 실제 대상이므로 무조건 수집한다.
        if (!(sibling instanceof LayoutBoxElement)) {
          this._collectParagraphs(sibling, affected);
          continue;
        }
        const siblingRect = this._getSiblingRectInParent(sibling);
        if (siblingRect && this._aabbIntersectsForCollection(myRect, siblingRect)) {
          this._collectParagraphs(sibling, affected);
        }
      }
    }

    return affected;
  }

  /**
   * 부모 좌표계 기준 box의 사각형. CSS `transform`은 부모-자식에 동일하게
   * 적용되므로 차이 계산 시 자동 상쇄된다.
   */
  private _getRectInParentForCollection(): { left: number; top: number; right: number; bottom: number } | null {
    const parent = this.parentElement;
    if (!parent) return null;
    const parentRect = parent.getBoundingClientRect();
    const myRect = this.getBoundingClientRect();
    return {
      left: myRect.left - parentRect.left,
      top: myRect.top - parentRect.top,
      right: myRect.right - parentRect.left,
      bottom: myRect.bottom - parentRect.top,
    };
  }

  /**
   * 형제 box의 부모 좌표계 사각형.
   */
  private _getSiblingRectInParent(sibling: LayoutBoxElement): { left: number; top: number; right: number; bottom: number } | null {
    const parent = this.parentElement;
    if (!parent) return null;
    const parentRect = parent.getBoundingClientRect();
    const siblingRect = sibling.getBoundingClientRect();
    return {
      left: siblingRect.left - parentRect.left,
      top: siblingRect.top - parentRect.top,
      right: siblingRect.right - parentRect.left,
      bottom: siblingRect.bottom - parentRect.top,
    };
  }

  /**
   * 두 AABB의 교차 여부. 경계 접촉만 있는 경우 교차하지 않는 것으로 간주.
   */
  private _aabbIntersectsForCollection(
    a: { left: number; top: number; right: number; bottom: number },
    b: { left: number; top: number; right: number; bottom: number },
  ): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  /**
   * 수집된 단락 요소들을 다시 렌더링한다.
   */
  private _renderAffectedParagraphs(affected: Set<LayoutParagraphElement>): void {
    for (const p of affected) {
      if (p.isConnected) {
        p.markStructureChangedAndFlushRender();
      }
    }
  }

  /**
   * 오버랩 관계 단락 재렌더링 예약. 이미지 overlapPadding/zIndex 변경 시 호출.
   * @see scheduleRerenderAffectedParagraphs
   */
  requestRerenderAffectedParagraphs(): void {
    this.scheduleRerenderAffectedParagraphs();
  }

  /** 요소 트리를 재귀적으로 탐색하여 모든 단락 요소를 수집한다. */
  private _collectParagraphs(
    element: LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | LayoutTableElement,
    set: Set<LayoutParagraphElement>
  ): void {
    if (element.type === 'paragraph') {
      set.add(element as LayoutParagraphElement);
      return;
    }
    if (element.type === 'box') {
      for (const child of (element as LayoutBoxElement).items) {
        this._collectParagraphs(child, set);
      }
      return;
    }
    if (element.type === 'table') {
      for (const tr of (element as LayoutTableElement).items) {
        for (const td of tr.items) {
          for (const box of td.items) {
            this._collectParagraphs(box, set);
          }
        }
      }
    }
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

  /** MutationObserver 연결을 해제한다. */
  private _stopChildObserver(): void {
    if (this._childObserver) {
      this._childObserver.disconnect();
      this._childObserver = null;
    }
  }
}
customElements.define('x-layout-box', LayoutBoxElement);