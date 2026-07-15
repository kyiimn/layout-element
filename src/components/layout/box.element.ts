import { DEFAULT_BORDER_STYLE } from "@/constants";
import { GridCalculator } from "@/core";
import { ColorRegistry } from "@/resource";
import { InheritStyle, BoxData, ParagraphStyle, TextStyle, PrintPostData, BoxPosition, BoxBorderStyle, BoxRole } from "@/types";
import { checkOverlap, genUUID } from "@/utils";
import { EditManager } from "@/edit/edit-manager";
import { LayoutDocumentElement } from "./document.element";
import { LayoutImageElement } from "./image.element";
import { LayoutParagraphElement } from "./paragraph.element";

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
  private _styleRule?: CSSStyleRule;

  private _left: number = 0;
  private _top: number = 0;
  private _width: number = 0;
  private _height: number = 0;
  private _position: BoxPosition = "static";
  private _backgroundColor?: string;
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
  private _groupMember?: string;
  private _priority?: number;
  private _editableLayout: boolean = false;
  private _isPrint: boolean = window.matchMedia("print").matches;

  private _savedColumns: number | number[] = 1;
  private _savedGap: number | number[] = 0;

  private _isDragging = false;
  private _selectedOnMouseDown = false;
  private _dragStartMouseX = 0;
  private _dragStartMouseY = 0;
  private _dragStartLeft = 0;
  private _dragStartTop = 0;
  private _dragOriginalLeft = 0;
  private _dragOriginalTop = 0;
  private _dragOriginalWidth = 0;
  private _dragOriginalHeight = 0;
  private _dragOriginalPosition: BoxPosition = 'static';
  private _dragMoved = false;
  private _dragRafId: number | null = null;
  private _dragLastClientX = 0;
  private _dragLastClientY = 0;

  private _isResizing = false;
  private _resizeHandle: 'top' | 'bottom' | 'left' | 'right' | null = null;
  private _resizeStartMouseX = 0;
  private _resizeStartMouseY = 0;
  private _resizeStartLeft = 0;
  private _resizeStartTop = 0;
  private _resizeStartWidth = 0;
  private _resizeStartHeight = 0;
  private _resizeMoved = false;
  private _resizeRafId: number | null = null;
  private _resizeLastClientX = 0;
  private _resizeLastClientY = 0;
  private _resizeHandles: HTMLDivElement[] = [];

  /** Cached set of paragraphs affected during drag/resize — computed once at start. */
  private _affectedParagraphs: Set<LayoutParagraphElement> | null = null;
  /** rAF id for throttled paragraph rerender during drag/resize. */
  private _rerenderRafId: number | null = null;

  /** DOM 자식 변경(추가/제거)을 감지하여 layout + render를 자동 수행하는 MutationObserver. */
  private _childObserver: MutationObserver | null = null;

  /** `data` 세터에서 자식을 재구축할 때 observer 중복 트리거를 방지하는 플래그. */
  private _rebuildingChildren = false;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    this._startChildObserver();
    this.addEventListener('click', this._onLayoutClick);
    this.addEventListener('mousedown', this._onLayoutMouseDown);
    this.addEventListener('mouseenter', this._onLayoutMouseEnter);
    this.addEventListener('mouseleave', this._onLayoutMouseLeave);
    this.layout();
  }

  disconnectedCallback() {
    this._stopChildObserver();
    this.removeEventListener('click', this._onLayoutClick);
    this.removeEventListener('mousedown', this._onLayoutMouseDown);
    this.removeEventListener('mouseenter', this._onLayoutMouseEnter);
    this.removeEventListener('mouseleave', this._onLayoutMouseLeave);
    EditManager.getInstance()._unregisterLayout(this);
  }

  static get observedAttributes() {
    return ['role', 'group-member', 'priority'] as const;
  }

  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null) {
    if (name === 'role') {
      this._role = newVal as BoxRole | undefined;
    } else if (name === 'group-member') {
      this._groupMember = newVal ?? undefined;
    } else if (name === 'priority') {
      this._priority = newVal !== null ? Number(newVal) : undefined;
    }
  }

  /**
   * 구조 계산: GridCalculator 데이터 할당, 스타일 규칙 생성, 리사이즈 핸들 생성.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected || !this.parentModel) return;

    const { columnWidth, gaps, lineHeight } = this.parentModel;

    this._model ??= GridCalculator.create({
      element: this,
      width: 0, height: 0, columns: 1, gap: 0, paragraphStyle: {}, textStyle: {}
    });
    this._model.data = {
      element: this,

      paddingTop: (this.position !== 'absolute' && this.paddingTop !== undefined) ? Math.ceil(this.paddingTop / lineHeight) * lineHeight : this.paddingTop,
      paddingRight: this.paddingRight,
      paddingBottom: (this.position !== 'absolute' && this.paddingBottom !== undefined) ? Math.ceil(this.paddingBottom / lineHeight) * lineHeight : this.paddingBottom,
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

    if (!this._styleRule) {
      const styleEl = document.createElement('style');
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);
      styleEl.sheet.insertRule(":host(:not([border])) { box-shadow: #ccc 0px 0px 0px 1px inset; }", 1);
      styleEl.sheet.insertRule(":host([selected]) { box-shadow: red 0px 0px 0px 1px inset, red 0px 0px 0px 1px; }", 2);
      styleEl.sheet.insertRule(":host([hovered]) { box-shadow: #4a90d9 0px 0px 0px 1px inset, #4a90d9 0px 0px 0px 1px; }", 3);
      styleEl.sheet.insertRule(":host([editable-layout][selected]) { box-shadow: red 0px 0px 0px 1px inset, red 0px 0px 0px 1px; }", 4);
      styleEl.sheet.insertRule(":host([editable-layout][hovered]) { box-shadow: #4a90d9 0px 0px 0px 1px inset, #4a90d9 0px 0px 0px 1px; }", 5);
      styleEl.sheet.insertRule(`@media print { [border] { display: none; } }`, 6);
      styleEl.sheet.insertRule('.resize-handle { position: absolute; width: 8px; height: 8px; background: white; border: 1px solid #4a90d9; border-radius: 50%; z-index: 99999999; pointer-events: auto; display: none; }', 7);
      styleEl.sheet.insertRule(':host([selected]) .resize-handle { display: block; }', 8);
      styleEl.sheet.insertRule('.resize-handle[data-handle="top"] { top: -4px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }', 9);
      styleEl.sheet.insertRule('.resize-handle[data-handle="bottom"] { bottom: -4px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }', 10);
      styleEl.sheet.insertRule('.resize-handle[data-handle="left"] { left: -4px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }', 11);
      styleEl.sheet.insertRule('.resize-handle[data-handle="right"] { right: -4px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }', 12);
      this._styleRule = styleEl.sheet.cssRules[0] as CSSStyleRule;

      this._shadowRoot.appendChild(document.createElement('slot'));
    }

    this._ensureResizeHandles();
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      this._styleRule.style,
      {
        display: 'inline-block',
        boxSizing: 'border-box',
        height: `${this.absHeight}mm`,
        left: `${this.relLeft}mm`,
        position: 'absolute',
        top: `${this.relTop}mm`,
        width: `${this.absWidth}mm`,
        zIndex: `${this.zIndex + 100}`,
      }
    );
  }

  private _ensureResizeHandles(): void {
    if (this._resizeHandles.length === 4) return;

    for (const handle of this._resizeHandles) {
      handle.removeEventListener('mousedown', this._onResizeMouseDown);
    }
    this._resizeHandles = [];
    this._shadowRoot.querySelectorAll('.resize-handle').forEach((h) => h.remove());

    for (const dir of ['top', 'bottom', 'left', 'right'] as const) {
      const handle = document.createElement('div');
      handle.classList.add('resize-handle');
      handle.setAttribute('data-handle', dir);
      this._shadowRoot.appendChild(handle);
      handle.addEventListener('mousedown', this._onResizeMouseDown);
      this._resizeHandles.push(handle);
    }
  }

  /**
   * 테두리 DOM 생성: `borderColor`가 설정된 경우 상/하/좌/우 테두리 요소를 생성한다.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _renderBorder() {
    if (!this.isConnected || !this.parentModel) return;

    this._shadowRoot.querySelectorAll(':scope > :not(slot):not(style):not(.resize-handle)').forEach(node => node.remove());

    const colorManager = ColorRegistry.getInstance();
    if (this.borderColor) {
      this.setAttribute('border', '');
      const borderStyle: Partial<CSSStyleDeclaration> = {
        overflow: 'hidden',
        position: 'absolute',
        zIndex: '99999999',
      };
      const borderInsideStyle: Partial<CSSStyleDeclaration> = {
        borderColor: colorManager.getCSSColor(this.borderColor),
        borderStyle: this.borderStyle || DEFAULT_BORDER_STYLE,
        borderWidth: '0',
      };

      if (this.borderTopWidth) {
        const border = document.createElement('div');
        border.setAttribute('border', 'top');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          height: `${Math.ceil(this.borderTopWidth * GridCalculator.ppm)}px`, top: '0', width: '100%',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderTopWidth: `100px`, height: '0', width: '100%',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }

      if (this.borderBottomWidth) {
        const border = document.createElement('div');
        border.setAttribute('border', 'bottom');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          height: `${Math.ceil(this.borderBottomWidth * GridCalculator.ppm)}px`, bottom: '0', width: '100%',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderBottomWidth: `100px`, height: '0', width: '100%',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }

      if (this.borderLeftWidth) {
        const border = document.createElement('div');
        border.setAttribute('border', 'left');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          width: `${Math.ceil(this.borderLeftWidth * GridCalculator.ppm)}px`, height: '100%', left: '0',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderLeftWidth: `100px`, height: '100%', width: '0',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }

      if (this.borderRightWidth) {
        const border = document.createElement('div');
        border.setAttribute('border', 'right');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          width: `${Math.ceil(this.borderRightWidth * GridCalculator.ppm)}px`, height: '100%', right: '0',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderRightWidth: `100px`, height: '100%', width: '0',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }
    } else {
      this.removeAttribute('border');
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
      if (childEl.type === 'box') {
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
    try {
      if (data.id !== undefined) this.id = data.id;
      if (data.position !== undefined) this._position = data.position;
      if (data.zIndex !== undefined) this._zIndex = data.zIndex;
      if (data.backgroundColor !== undefined) this._backgroundColor = data.backgroundColor;
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
      if (data.role !== undefined) this._role = data.role;
      if (data.groupMember !== undefined) this._groupMember = data.groupMember;
      if (data.priority !== undefined) this._priority = data.priority;

      this._left = data.left;
      this._top = data.top;
      this._width = data.width;
      this._height = data.height;

      this.items.forEach(e => e.remove());

      this.layout();

      const children = data.children || [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
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
        } else if (child.type === 'image') {
          const imageEl = document.createElement('x-layout-image');
          imageEl.data = child;
          this.appendChild(imageEl);
        }
      }

      this.render();
    } finally {
      this._rebuildingChildren = false;
    }
  }

  set left(value: number) {
    if (this._left === value) return;
    this._left = value;
    this.layout();
    this.scheduleRerenderAffectedParagraphs();
  }

  set top(value: number) {
    if (this._top === value) return;
    this._top = value;
    this.layout();
    this.scheduleRerenderAffectedParagraphs();
  }

  set width(value: number) {
    if (this._width === value) return;
    this._width = value;
    this.layout();
    this.scheduleRerenderAffectedParagraphs();
  }

  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this.layout();
    this.scheduleRerenderAffectedParagraphs();
  }

  set position(value: BoxPosition) {
    if (this._position === value) return;
    this._position = value;
    this.layout();
  }

  set zIndex(value: number) {
    if (this._zIndex === value) return;
    this._zIndex = value;
    this.layout();
  }

  set backgroundColor(value: string | undefined) {
    if (this._backgroundColor === value) return;
    this._backgroundColor = value;
    this.layout();
  }

  set borderTopWidth(value: number) {
    if (this._borderTopWidth === value) return;
    this._borderTopWidth = value;
    this.layout();
  }

  set borderBottomWidth(value: number) {
    if (this._borderBottomWidth === value) return;
    this._borderBottomWidth = value;
    this.layout();
  }

  set borderLeftWidth(value: number) {
    if (this._borderLeftWidth === value) return;
    this._borderLeftWidth = value;
    this.layout();
  }

  set borderRightWidth(value: number) {
    if (this._borderRightWidth === value) return;
    this._borderRightWidth = value;
    this.layout();
  }

  set borderStyle(value: BoxBorderStyle) {
    if (this._borderStyle === value) return;
    this._borderStyle = value;
    this.layout();
  }

  set borderColor(value: string | undefined) {
    if (this._borderColor === value) return;
    this._borderColor = value;
    this.layout();
  }

  set paddingTop(value: number) {
    if (this._paddingTop === value) return;
    this._paddingTop = value;
    this.layout();
  }

  set paddingRight(value: number) {
    if (this._paddingRight === value) return;
    this._paddingRight = value;
    this.layout();
  }

  set paddingBottom(value: number) {
    if (this._paddingBottom === value) return;
    this._paddingBottom = value;
    this.layout();
  }

  set paddingLeft(value: number) {
    if (this._paddingLeft === value) return;
    this._paddingLeft = value;
    this.layout();
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.layout();
  }

  get data(): BoxData {
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
      groupMember: this._groupMember,
      priority: this.priority,
      children: this.items.map(e => e.data).filter(e => !!e),
    };
  }

  get left() { return this._left; }
  get top() { return this._top; }
  get width() { return this._width; }
  get height() { return this._height; }
  get position() { return this._position; }
  get zIndex() { return this._zIndex; }
  get backgroundColor() { return this._backgroundColor; }
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

  get role(): string | null { return this._role ?? null; }
  set role(value: string | null) {
    if (value === null) {
      this._role = undefined;
    } else {
      this._role = value as BoxRole;
    }
  }

  get groupMember(): string[] {
    if (!this._groupMember) return [];
    return this._groupMember.split(',').filter(s => s.length > 0);
  }
  set groupMember(value: string[]) {
    this._groupMember = value.length > 0 ? value.join(',') : undefined;
  }

  get priority() { return this._priority ?? 0; }
  set priority(value: number) { this._priority = value; }

  get inheritStyle() { return this._inheritStyle; }
  get model() { return this._model; }

  get parentElement() {
    return super.parentElement as LayoutDocumentElement | LayoutBoxElement;
  }

  get parentModel() {
    return this.parentElement?.model;
  }

  get items() {
    return Array.from(this.querySelectorAll<LayoutBoxElement | LayoutParagraphElement | LayoutImageElement>(":scope > x-layout-box, :scope > x-layout-paragraph, :scope > x-layout-image"));
  }

  get textStyle(): TextStyle {
    return this.parentModel?.textStyle || {};
  }

  get paragraphStyle(): ParagraphStyle {
    return this.parentModel?.paragraphStyle || {};
  }

  get relLeft() {
    if (this.position !== 'absolute') {
      return this.parentModel ? this.parentModel.columnCoords[this.left].x1 : 0;
    } else {
      return (this.inheritStyle?.paddingLeft || 0) + this.left;
    }
  }

  get relTop() {
    if (this.position !== 'absolute') {
      if (this.parentModel) {
        const { columnCoords, lineHeight } = this.parentModel;
        return columnCoords[this.left].y1 + (lineHeight * this.top);
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

  get absHeight() {
    let calcHeight = 0;
    if (this.position !== 'absolute') {
      if (this.parentModel) {
        const { fontSize, lineHeight } = this.parentModel;
        calcHeight = lineHeight * this.height - (lineHeight - fontSize);
      }
    } else {
      calcHeight = this.height;
    }
    if (this.parentModel?.editableHeight) {
      const top = this.parentElement.type !== 'document' ? this.relTop : 0;
      calcHeight = Math.min(calcHeight, this.parentModel.editableHeight - (top - (this._inheritStyle?.paddingTop || 0)));
    }
    return calcHeight;
  }

  get overlayElements() {
    const list: LayoutBoxElement[] = [];
    if (this.parentElement.type !== 'document') {
      list.push(...this.parentElement.overlayElements);
    }

    let overlay = this.parentElement.items.filter(i => i.type === 'box' && i !== this && i.zIndex > this.zIndex) as LayoutBoxElement[];
    overlay = overlay.filter(i => checkOverlap(i, this));

    list.push(...overlay);

    return list;
  }

  get printPostData() {
    const data: PrintPostData[] = [];
    const rect = this.getBoundingClientRect();

    this.items.forEach(c => {
      data.push(...c.printPostData)
    });
    const colorManager = ColorRegistry.getInstance();

    data.push({
      color: this.borderColor ? colorManager.get(this.borderColor) : undefined,
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
    return data;
  }

  get type() { return 'box' as const; }

  get contentType(): 'image' | 'paragraph' | null {
    if (this.items.length !== 1) return null;
    if (this.items[0].type === 'box') return this.items[0].contentType;
    return this.items[0].type;
  }

  get editableLayout() { return this._editableLayout; }

  set editableLayout(value: boolean) {
    if (this._isPrint) return;
    if (this._editableLayout === value) return;
    this._editableLayout = value;

    if (value) {
      this.style.cursor = 'grab';
      this.setAttribute('editable-layout', '');
    } else {
      this.removeAttribute('selected');
      this.removeAttribute('hovered');
      this.removeAttribute('editable-layout');
      this.style.cursor = '';
      EditManager.getInstance()._unregisterLayout(this);
    }
  }

  private _onLayoutClick = (event: MouseEvent): void => {
    if (!this._editableLayout) return;
    event.stopPropagation();
    if (EditManager.getInstance().insertMode) return;
    if (this._isEventFromDescendantLayout(event)) return;
    if (this._isEventFromResizeHandle(event)) return;
    this.removeAttribute('hovered');
    if (this._dragMoved || this._resizeMoved) {
      this._dragMoved = false;
      this._resizeMoved = false;
      this._selectedOnMouseDown = false;
      return;
    }
    if (this._selectedOnMouseDown) {
      this._selectedOnMouseDown = false;
      return;
    }
    const manager = EditManager.getInstance();
    manager._setMultiSelect(event.ctrlKey || event.metaKey);
    manager.selectLayout(this);
    manager._setMultiSelect(false);
  }

  private _onLayoutMouseEnter = (): void => {
    if (!this._editableLayout) return;
    if (EditManager.getInstance().insertMode) return;
    const manager = EditManager.getInstance();
    if (manager._isDraggingLayout() || manager._isResizingLayout()) return;
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
    if (!this._editableLayout) return;
    if (EditManager.getInstance().insertMode) return;
    this.removeAttribute('hovered');
    const manager = EditManager.getInstance();
    if (manager._isDraggingLayout() || manager._isResizingLayout()) return;
    const related = event.relatedTarget as Element | null;
    if (!related) return;
    let target: Element | null = related;
    while (target) {
      if (target === this) return;
      target = target.parentElement;
    }
    this._hoverNearestLayoutChild(event.clientX, event.clientY);
  }

  /**
   * 마우스가 자식 요소에서 부모 영역으로 돌아올 때,
   * Shadow DOM 내부를 순회하며 마우스 위치 아래 가장 가까운 레이아웃 박스를 찾아 hover를 설정한다.
   */
  private _hoverNearestLayoutChild(clientX: number, clientY: number): void {
    const root = this.shadowRoot;
    if (!root) return;
    const hit = root.elementFromPoint(clientX, clientY);
    if (!hit) return;
    let el: Element | null = hit;
    while (el) {
      if (el instanceof LayoutBoxElement && el.editableLayout && !el.hasAttribute('selected')) {
        el._onLayoutMouseEnter();
        return;
      }
      el = el.parentElement;
    }
  }

  private _isEventFromDescendantLayout(event: MouseEvent): boolean {
    const path = event.composedPath();
    for (const el of path) {
      if (el === this) return false;
      if (el instanceof LayoutBoxElement && el.editableLayout) return true;
    }
    return false;
  }

  private _isEventFromResizeHandle(event: MouseEvent): boolean {
    for (const el of event.composedPath()) {
      if (el instanceof HTMLElement && el.classList.contains('resize-handle')) return true;
      if (el === this) return false;
    }
    return false;
  }

  private _onLayoutMouseDown = (event: MouseEvent) => {
    if (!this._editableLayout) return;
    if (event.button !== 0) return;
    if (EditManager.getInstance().insertMode) {
      EditManager.getInstance().handleInsertMouseDown(event);
      return;
    }
    if (this._isEventFromResizeHandle(event)) return;
    if (this._isEventFromDescendantLayout(event)) return;
    this._selectedOnMouseDown = false;
    if (!this.hasAttribute('selected')) {
      const manager = EditManager.getInstance();
      manager._setMultiSelect(event.ctrlKey || event.metaKey);
      manager.selectLayout(this);
      manager._setMultiSelect(false);
      this._selectedOnMouseDown = true;
    }
    event.preventDefault();
    event.stopPropagation();
    this.removeAttribute('hovered');
    this._isDragging = true;
    this._dragMoved = false;
    this._dragStartMouseX = event.clientX;
    this._dragStartMouseY = event.clientY;
    this._dragStartLeft = this.left;
    this._dragStartTop = this.top;
    this._dragOriginalLeft = this.left;
    this._dragOriginalTop = this.top;
    this._dragOriginalWidth = this.width;
    this._dragOriginalHeight = this.height;
    this._dragOriginalPosition = this.position;
    this._dragLastClientX = event.clientX;
    this._dragLastClientY = event.clientY;
    this.style.cursor = 'grabbing';
    EditManager.getInstance()._startLayoutDrag();
    this._affectedParagraphs = this._collectAffectedParagraphs();

    const dragTargets = EditManager.getInstance()._getDragTargets();
    for (const target of dragTargets) {
      if (target === this) continue;
      target._dragStartLeft = target.left;
      target._dragStartTop = target.top;
      target._dragOriginalLeft = target.left;
      target._dragOriginalTop = target.top;
      target._dragOriginalWidth = target.width;
      target._dragOriginalHeight = target.height;
      target._dragOriginalPosition = target.position;
    }

    document.addEventListener('mousemove', this._onLayoutMouseMove);
    document.addEventListener('mouseup', this._onLayoutMouseUp);
    document.addEventListener('keydown', this._onLayoutKeyDown);
  }

  private _onLayoutKeyDown = (event: KeyboardEvent) => {
    if (!this._isDragging) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (this._dragRafId !== null) {
      cancelAnimationFrame(this._dragRafId);
      this._dragRafId = null;
    }
    document.removeEventListener('mousemove', this._onLayoutMouseMove);
    document.removeEventListener('mouseup', this._onLayoutMouseUp);
    document.removeEventListener('keydown', this._onLayoutKeyDown);
    this._isDragging = false;
    this._dragMoved = false;
    this.flushRerenderAffectedParagraphs();
    this.style.cursor = this._editableLayout ? 'grab' : '';

    const manager = EditManager.getInstance();
    const dragTargets = manager._getDragTargets();
    const isTopLevel = dragTargets.includes(this);

    if (isTopLevel) {
      this._applyPositionConversion(
        this._dragOriginalPosition,
        this._dragOriginalLeft,
        this._dragOriginalTop,
        this._dragOriginalWidth,
        this._dragOriginalHeight,
      );
      manager._dispatchLayoutMove(this, this._dragOriginalLeft, this._dragOriginalTop, this._dragOriginalLeft, this._dragOriginalTop, true);
    }

    for (const target of dragTargets) {
      if (target === this) continue;
      target._applyPositionConversion(
        target._dragOriginalPosition,
        target._dragOriginalLeft,
        target._dragOriginalTop,
        target._dragOriginalWidth,
        target._dragOriginalHeight,
      );
      manager._dispatchLayoutMove(target, target._dragOriginalLeft, target._dragOriginalTop, target._dragOriginalLeft, target._dragOriginalTop, true);
    }

    manager._endLayoutDrag();
  }

  private _onLayoutMouseMove = (event: MouseEvent) => {
    if (!this._isDragging) return;
    this._dragLastClientX = event.clientX;
    this._dragLastClientY = event.clientY;
    const deltaX = event.clientX - this._dragStartMouseX;
    const deltaY = event.clientY - this._dragStartMouseY;
    if (!this._dragMoved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
      this._dragMoved = true;
    }
    if (!this._dragMoved) return;
    if (this._dragRafId !== null) return;
    this._dragRafId = requestAnimationFrame(() => {
      this._dragRafId = null;
      const dx = this._dragLastClientX - this._dragStartMouseX;
      const dy = this._dragLastClientY - this._dragStartMouseY;
      const manager = EditManager.getInstance();
      const dragTargets = manager._getDragTargets();
      const isTopLevel = dragTargets.includes(this);

      if (isTopLevel) {
        const result = this._computeNewPosition(dx, dy);
        if (result.converted) {
          this._applyPositionConversion(
            result.converted.position,
            result.converted.left,
            result.converted.top,
            result.converted.width,
            result.converted.height,
          );
          this._dragStartLeft = result.converted.left;
          this._dragStartTop = result.converted.top;
          this._dragStartMouseX = this._dragLastClientX;
          this._dragStartMouseY = this._dragLastClientY;
        } else {
          if (this.left !== result.left) this.left = result.left;
          if (this.top !== result.top) this.top = result.top;
        }
      }

      for (const target of dragTargets) {
        if (target === this) continue;
        const result = target._computeNewPosition(dx, dy, target._dragStartLeft, target._dragStartTop);
        if (result.converted) {
          target._applyPositionConversion(
            result.converted.position,
            result.converted.left,
            result.converted.top,
            result.converted.width,
            result.converted.height,
          );
          target._dragStartLeft = result.converted.left;
          target._dragStartTop = result.converted.top;
        } else {
          if (result.left !== target.left) target.left = result.left;
          if (result.top !== target.top) target.top = result.top;
        }
      }
    });
  }

  private _onLayoutMouseUp = (event: MouseEvent) => {
    if (!this._isDragging) return;
    event.stopPropagation();
    document.removeEventListener('mousemove', this._onLayoutMouseMove);
    document.removeEventListener('mouseup', this._onLayoutMouseUp);
    document.removeEventListener('keydown', this._onLayoutKeyDown);
    if (this._dragRafId !== null) {
      cancelAnimationFrame(this._dragRafId);
      this._dragRafId = null;
    }
    this._isDragging = false;
    this.flushRerenderAffectedParagraphs();
    this.style.cursor = this._editableLayout ? 'grab' : '';

    const manager = EditManager.getInstance();

    if (!this._dragMoved) {
      manager._endLayoutDrag();
      return;
    }

    const dragTargets = manager._getDragTargets();
    const isTopLevel = dragTargets.includes(this);
    const deltaX = event.clientX - this._dragStartMouseX;
    const deltaY = event.clientY - this._dragStartMouseY;

    if (isTopLevel) {
      const startLeft = this._dragStartLeft;
      const startTop = this._dragStartTop;
      const result = this._computeNewPosition(deltaX, deltaY);
      if (result.converted) {
        this._applyPositionConversion(
          result.converted.position,
          result.converted.left,
          result.converted.top,
          result.converted.width,
          result.converted.height,
        );
      } else {
        if (result.left !== this.left) this.left = result.left;
        if (result.top !== this.top) this.top = result.top;
      }
      manager._dispatchLayoutMove(this, startLeft, startTop, this.left, this.top, false);
    }

    for (const target of dragTargets) {
      if (target === this) continue;
      const result = target._computeNewPosition(deltaX, deltaY, target._dragStartLeft, target._dragStartTop);
      if (result.converted) {
        target._applyPositionConversion(
          result.converted.position,
          result.converted.left,
          result.converted.top,
          result.converted.width,
          result.converted.height,
        );
      } else {
        if (result.left !== target.left) target.left = result.left;
        if (result.top !== target.top) target.top = result.top;
      }
      manager._dispatchLayoutMove(target, target._dragStartLeft, target._dragStartTop, target.left, target.top, false);
    }

    manager._endLayoutDrag();
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
   * 픽셀 델타와 시작 위치를 받아 새 위치를 계산한다.
   *
   * 다중 선택 드래그에서 각 대상 요소의 시작 위치를 독립적으로 전달할 수 있다.
   * `startLeft`/`startTop`을 생략하면 `this._dragStartLeft`/`this._dragStartTop`을 사용한다.
   *
   * - **static 모드**: 컬럼/라인 스냅과 클램핑을 적용한다. 편집 영역 밖으로 나갈 수 없다.
   * - **absolute 모드 (문서 직계 자식)**: 클램핑 없이 자유 이동. 음수 좌표 허용.
   * - **absolute 모드 (다른 박스 안)**: 부모 영역 내로 클램핑.
   *
   * position 자동 변환(static ↔ absolute)은 드래그 중 발생하지 않는다.
   * position 변환이 필요하면 `convertPosition()`을 명시적으로 호출해야 한다.
   *
   * @param deltaPxX - 마우스 가로 이동량 (픽셀)
   * @param deltaPxY - 마우스 세로 이동량 (픽셀)
   * @param startLeft - 드래그 시작 left 값 (생략 시 this._dragStartLeft)
   * @param startTop - 드래그 시작 top 값 (생략 시 this._dragStartTop)
   * @returns 새 위치. `converted` 필드는 드래그 중 position 변환에서만 사용
   */
  private _computeNewPosition(
    deltaPxX: number,
    deltaPxY: number,
    startLeft?: number,
    startTop?: number,
  ): { left: number; top: number; converted?: { position: BoxPosition; left: number; top: number; width: number; height: number } } {
    const sLeft = startLeft ?? this._dragStartLeft;
    const sTop = startTop ?? this._dragStartTop;
    const deltaMmX = deltaPxX / GridCalculator.ppm;
    const deltaMmY = deltaPxY / GridCalculator.ppm;

    const isDocumentChild = this.parentElement?.type === 'document';

    if (this.position === 'absolute') {
      const padL = this.inheritStyle?.paddingLeft || 0;
      const padR = this.inheritStyle?.paddingRight || 0;
      const padT = this.inheritStyle?.paddingTop || 0;
      const padB = this.inheritStyle?.paddingBottom || 0;

      if (isDocumentChild) {
        // absolute 요소는 position을 유지한다. 편집 영역 안으로 들어와도 static으로 변환하지 않는다.
        return { left: sLeft + deltaMmX, top: sTop + deltaMmY };
      }

      const maxLeft = Math.max(0, (this.inheritStyle?.parentWidth || 0) - padL - padR - this.width);
      const maxTop = Math.max(0, (this.inheritStyle?.parentHeight || 0) - padT - padB - this.height);
      return {
        left: Math.max(0, Math.min(maxLeft, sLeft + deltaMmX)),
        top: Math.max(0, Math.min(maxTop, sTop + deltaMmY)),
      };
    }

    // static mode
    const parentModel = this.parentModel;
    if (!parentModel) {
      return { left: sLeft, top: sTop };
    }

    const { columnCoords, lineHeight, columnCount } = parentModel;
    const editableTextHeight = parentModel.editableTextHeight;
    const startX = columnCoords[sLeft].x1;
    const startY = columnCoords[sLeft].y1 + lineHeight * sTop;
    const newLeftMm = startX + deltaMmX;
    const newTopMm = startY + deltaMmY;

    let newLeft = 0;
    let minDist = Infinity;
    for (let i = 0; i <= columnCount - this.width; i++) {
      const dist = Math.abs(newLeftMm - columnCoords[i].x1);
      if (dist < minDist) {
        minDist = dist;
        newLeft = i;
      }
    }
    newLeft = Math.max(0, Math.min(columnCount - this.width, newLeft));

    const maxTop = Math.floor((editableTextHeight - (lineHeight * this.height - (lineHeight - parentModel.fontSize))) / lineHeight);
    let newTop = Math.max(0, Math.min(maxTop, Math.round((newTopMm - columnCoords[newLeft].y1) / lineHeight)));

    if (isDocumentChild) {
      // static 요소는 편집 영역 밖으로 나갈 수 없다.
      // 클램핑만 적용하고 absolute 변환은 수행하지 않는다.
      // absolute 요소만 편집 영역 밖으로 자유롭게 이동할 수 있다.
      return { left: newLeft, top: newTop };
    }

    return { left: newLeft, top: newTop };
  }

  private _onResizeMouseDown = (event: MouseEvent): void => {
    if (!this._editableLayout) return;
    if (event.button !== 0) return;
    if (EditManager.getInstance().insertMode) return;
    if (!this.hasAttribute('selected')) return;
    event.preventDefault();
    event.stopPropagation();

    const handle = (event.target as HTMLElement).getAttribute('data-handle') as 'top' | 'bottom' | 'left' | 'right';
    if (!handle) return;

    this._isResizing = true;
    this._resizeHandle = handle;
    this._resizeMoved = false;
    this._resizeStartMouseX = event.clientX;
    this._resizeStartMouseY = event.clientY;
    this._resizeStartLeft = this.left;
    this._resizeStartTop = this.top;
    this._resizeStartWidth = this.width;
    this._resizeStartHeight = this.height;
    this._resizeLastClientX = event.clientX;
    this._resizeLastClientY = event.clientY;

    EditManager.getInstance()._startLayoutResize();
    this._affectedParagraphs = this._collectAffectedParagraphs();
    document.addEventListener('mousemove', this._onResizeMouseMove);
    document.addEventListener('mouseup', this._onResizeMouseUp);
    document.addEventListener('keydown', this._onResizeKeyDown);
  }

  private _onResizeMouseMove = (event: MouseEvent): void => {
    if (!this._isResizing) return;
    this._resizeLastClientX = event.clientX;
    this._resizeLastClientY = event.clientY;
    const deltaX = event.clientX - this._resizeStartMouseX;
    const deltaY = event.clientY - this._resizeStartMouseY;
    if (!this._resizeMoved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
      this._resizeMoved = true;
    }
    if (!this._resizeMoved) return;
    if (this._resizeRafId !== null) return;
    this._resizeRafId = requestAnimationFrame(() => {
      this._resizeRafId = null;
      const dx = this._resizeLastClientX - this._resizeStartMouseX;
      const dy = this._resizeLastClientY - this._resizeStartMouseY;
      const { left, top, width, height } = this._computeNewSize(dx, dy);
      if (left !== this.left) this.left = left;
      if (top !== this.top) this.top = top;
      if (width !== this.width) this.width = width;
      if (height !== this.height) this.height = height;
    });
  }

  private _onResizeMouseUp = (event: MouseEvent): void => {
    if (!this._isResizing) return;
    event.stopPropagation();
    document.removeEventListener('mousemove', this._onResizeMouseMove);
    document.removeEventListener('mouseup', this._onResizeMouseUp);
    document.removeEventListener('keydown', this._onResizeKeyDown);
    if (this._resizeRafId !== null) {
      cancelAnimationFrame(this._resizeRafId);
      this._resizeRafId = null;
    }
    this._isResizing = false;
    this.flushRerenderAffectedParagraphs();
    EditManager.getInstance()._endLayoutResize();

    if (!this._resizeMoved) {
      this._resizeHandle = null;
      return;
    }

    const deltaX = event.clientX - this._resizeStartMouseX;
    const deltaY = event.clientY - this._resizeStartMouseY;
    const { left, top, width, height } = this._computeNewSize(deltaX, deltaY);
    this._resizeHandle = null;
    if (left !== this.left) this.left = left;
    if (top !== this.top) this.top = top;
    if (width !== this.width) this.width = width;
    if (height !== this.height) this.height = height;

    EditManager.getInstance()._dispatchLayoutResize(
      this,
      this._resizeStartLeft,
      this._resizeStartTop,
      this._resizeStartWidth,
      this._resizeStartHeight,
      left,
      top,
      width,
      height,
      false,
    );
  }

  private _onResizeKeyDown = (event: KeyboardEvent): void => {
    if (!this._isResizing || event.key !== 'Escape') return;
    event.preventDefault();
    if (this._resizeRafId !== null) {
      cancelAnimationFrame(this._resizeRafId);
      this._resizeRafId = null;
    }
    document.removeEventListener('mousemove', this._onResizeMouseMove);
    document.removeEventListener('mouseup', this._onResizeMouseUp);
    document.removeEventListener('keydown', this._onResizeKeyDown);
    this._isResizing = false;
    this._resizeHandle = null;
    this.flushRerenderAffectedParagraphs();
    EditManager.getInstance()._endLayoutResize();

    if (this.left !== this._resizeStartLeft) this.left = this._resizeStartLeft;
    if (this.top !== this._resizeStartTop) this.top = this._resizeStartTop;
    if (this.width !== this._resizeStartWidth) this.width = this._resizeStartWidth;
    if (this.height !== this._resizeStartHeight) this.height = this._resizeStartHeight;

    EditManager.getInstance()._dispatchLayoutResize(
      this,
      this._resizeStartLeft,
      this._resizeStartTop,
      this._resizeStartWidth,
      this._resizeStartHeight,
      this._resizeStartLeft,
      this._resizeStartTop,
      this._resizeStartWidth,
      this._resizeStartHeight,
      true,
    );
  }

  /**
   * 픽셀 델타를 받아 리사이즈 방향에 따라 새 크기와 위치를 계산한다.
   *
   * @param deltaPxX - 마우스 가로 이동량 (픽셀)
   * @param deltaPxY - 마우스 세로 이동량 (픽셀)
   * @returns 스냅/클램핑이 적용된 새 위치와 크기
   */
  private _computeNewSize(
    deltaPxX: number,
    deltaPxY: number,
  ): { left: number; top: number; width: number; height: number } {
    const handle = this._resizeHandle;
    if (!handle) return { left: this._resizeStartLeft, top: this._resizeStartTop, width: this._resizeStartWidth, height: this._resizeStartHeight };

    const sLeft = this._resizeStartLeft;
    const sTop = this._resizeStartTop;
    const sWidth = this._resizeStartWidth;
    const sHeight = this._resizeStartHeight;

    if (this.position === 'absolute') {
      const deltaMmX = deltaPxX / GridCalculator.ppm;
      const deltaMmY = deltaPxY / GridCalculator.ppm;
      const padL = this.inheritStyle?.paddingLeft || 0;
      const padR = this.inheritStyle?.paddingRight || 0;
      const padT = this.inheritStyle?.paddingTop || 0;
      const padB = this.inheritStyle?.paddingBottom || 0;
      const parentW = this.inheritStyle?.parentWidth || 0;
      const parentH = this.inheritStyle?.parentHeight || 0;

      switch (handle) {
        case 'right': {
          const maxWidth = parentW - padL - padR - sLeft;
          const width = Math.max(1, Math.min(maxWidth, sWidth + deltaMmX));
          return { left: sLeft, top: sTop, width, height: sHeight };
        }
        case 'left': {
          const maxWidth = sLeft + sWidth;
          const width = Math.max(1, Math.min(maxWidth, sWidth - deltaMmX));
          const left = Math.max(0, Math.min(sLeft + sWidth - 1, sLeft + deltaMmX));
          return { left, top: sTop, width, height: sHeight };
        }
        case 'bottom': {
          const maxHeight = parentH - padT - padB - sTop;
          const height = Math.max(1, Math.min(maxHeight, sHeight + deltaMmY));
          return { left: sLeft, top: sTop, width: sWidth, height };
        }
        case 'top': {
          const maxHeight = sTop + sHeight;
          const height = Math.max(1, Math.min(maxHeight, sHeight - deltaMmY));
          const top = Math.max(0, Math.min(sTop + sHeight - 1, sTop + deltaMmY));
          return { left: sLeft, top, width: sWidth, height };
        }
      }
    }

    const parentModel = this.parentModel;
    if (!parentModel) return { left: sLeft, top: sTop, width: sWidth, height: sHeight };

    const { columnCount, lineHeight } = parentModel;
    const editableTextHeight = parentModel.editableTextHeight;
    const avgColWidth = parentModel.editableWidth / parentModel.columnCount;
    const deltaMmX = deltaPxX / GridCalculator.ppm;
    const deltaMmY = deltaPxY / GridCalculator.ppm;
    const deltaCols = Math.round(deltaMmX / avgColWidth);
    const deltaLines = Math.round(deltaMmY / lineHeight);
    const maxLines = Math.floor(editableTextHeight / lineHeight);

    switch (handle) {
      case 'right': {
        const maxWidth = columnCount - sLeft;
        const width = Math.max(1, Math.min(maxWidth, sWidth + deltaCols));
        return { left: sLeft, top: sTop, width, height: sHeight };
      }
      case 'left': {
        const maxWidth = sLeft + sWidth;
        const width = Math.max(1, Math.min(maxWidth, sWidth - deltaCols));
        const left = Math.max(0, Math.min(sLeft + sWidth - 1, sLeft + deltaCols));
        return { left, top: sTop, width, height: sHeight };
      }
      case 'bottom': {
        const maxHeightForBox = maxLines - sTop;
        const height = Math.max(1, Math.min(maxHeightForBox, sHeight + deltaLines));
        return { left: sLeft, top: sTop, width: sWidth, height };
      }
      case 'top': {
        const maxHeight = sTop + sHeight;
        const height = Math.max(1, Math.min(maxHeight, sHeight - deltaLines));
        const top = Math.max(0, Math.min(sTop + sHeight - 1, sTop + deltaLines));
        return { left: sLeft, top, width: sWidth, height };
      }
    }

    return { left: sLeft, top: sTop, width: sWidth, height: sHeight };
  }

  /**
   * 영향받는 단락 요소를 다시 렌더링하도록 예약한다.
   * 드래그/리사이즈 중이면 rAF로 지연하고, 아니면 즉시 실행한다.
   */
  private scheduleRerenderAffectedParagraphs(): void {
    if (this._affectedParagraphs !== null) {
      this._debounceRerenderAffectedParagraphs();
      return;
    }

    const affected = this._collectAffectedParagraphs();
    this._renderAffectedParagraphs(affected);
  }

  /**
   * 영향받는 단락 요소 집합을 수집한다.
   * 자식 박스를 재귀적으로 탐색하여 모든 단락 요소를 찾는다.
   * 형제 박스의 자식 단락도 포함한다 (오버랩 영향).
   */
  private _collectAffectedParagraphs(): Set<LayoutParagraphElement> {
    const affected = new Set<LayoutParagraphElement>();

    for (const item of this.items) {
      this._collectParagraphs(item, affected);
    }

    if (this.parentElement) {
      for (const sibling of this.parentElement.items) {
        if (sibling === this) continue;
        this._collectParagraphs(sibling, affected);
      }
    }

    return affected;
  }

  /**
   * 수집된 단락 요소들을 다시 렌더링한다.
   * 각 단락의 `_perfStructureChanged`를 true로 설정하고 `render()`를 호출한다.
   * 내부 전용.
   */
  private _renderAffectedParagraphs(affected: Set<LayoutParagraphElement>): void {
    for (const p of affected) {
      if (p.isConnected) {
        (p as any)._perfStructureChanged = true;
        p.render();
      }
    }
  }

  /**
   * 성능 최적화: rAF로 단락 재렌더링을 지연시킨다.
   * 내부 전용. `scheduleRerenderAffectedParagraphs()`에서만 호출된다.
   */
  private _debounceRerenderAffectedParagraphs(): void {
    if (this._rerenderRafId !== null) return;

    this._rerenderRafId = requestAnimationFrame(() => {
      this._rerenderRafId = null;
      const affected = this._affectedParagraphs;
      if (affected) {
        this._renderAffectedParagraphs(affected);
      }
    });
  }

  /**
   * 대기 중인 rAF 재렌더링을 즉시 실행하고 취소한다.
   * 드래그/리사이즈 종료 시 호출된다.
   */
  private flushRerenderAffectedParagraphs(): void {
    if (this._rerenderRafId !== null) {
      cancelAnimationFrame(this._rerenderRafId);
      this._rerenderRafId = null;
    }
    const affected = this._affectedParagraphs;
    this._affectedParagraphs = null;
    if (affected) {
      this._renderAffectedParagraphs(affected);
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
    element: LayoutBoxElement | LayoutParagraphElement | LayoutImageElement,
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