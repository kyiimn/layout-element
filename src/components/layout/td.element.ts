import { GridCalculatorEngine, TableCellEngine } from "@/engine";
import { ColorRegistry } from "@/resource";
import {
  TableCellData,
  BoxData,
  BoxBorderStyle,
  BorderFace,
  InheritStyle,
} from "@/types";
import { Z_INDEX_TABLE_DIAGONAL, Z_INDEX_TYPE_LABEL } from "@/constants";
import { genUUID } from "@/utils";
import { EditManager } from "@/edit/edit-manager";
import { LayoutBoxElement } from "./box.element";
import { LayoutDocumentElement } from "./document.element";
import { LayoutImageElement } from "./image.element";
import { LayoutParagraphElement } from "./paragraph.element";
import { LayoutTableElement } from "./table.element";
import { LayoutTableRowElement } from "./tr.element";

const HOST_STYLE_ID = '__layout_host_style__';

const DEFAULT_BORDER_FACE: BorderFace = { width: 0, color: 'black', style: 'solid' };

/**
 * 테이블 셀 요소. `<x-layout-td>` 커스텀 엘리먼트.
 *
 * table이 부여하는 메트릭(x, y, width, height)으로 위치하고,
 * 자체 GridCalculator(columns=1)를 보유하여 cell 내부를 box 배치 컨텍스트로 동작시킨다.
 * 셀 자체는 테두리를 보유하지 않고, 부모 테이블의 보더 면 저장소에 대한
 * getter/setter 프록시 역할만 한다. 대각선은 TD shadow root에 렌더링한다.
 */
export class LayoutTableCellElement extends HTMLElement {
  private _shadowRoot: ShadowRoot;

  private _model?: GridCalculatorEngine;
  private _cellEngine?: TableCellEngine;

  private _x: number = 0;
  private _y: number = 0;
  private _width: number = 0;
  private _height: number = 0;
  private _cellLabel: string = '';
  private _cellLabels: string[] = [];

  private _colspan: number = 1;
  private _rowspan: number = 1;
  private _backgroundColor?: string;
  private _backgroundOpacity?: number;
  private _diagonals?: Array<'tl-br' | 'tr-bl'>;
  private _diagonalWidth: number = 0.1;
  private _diagonalColor?: string;
  private _paddingTop: number = 0;
  private _paddingRight: number = 0;
  private _paddingBottom: number = 0;
  private _paddingLeft: number = 0;

  private _diagonalEls: HTMLDivElement[] = [];
  private _placeholderBorderEls: HTMLDivElement[] = [];
  private _labelEl: HTMLDivElement | null = null;

  private _inheritStyle?: InheritStyle;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback(): void {
    this.addEventListener('mouseenter', this._onLayoutMouseEnter);
    this.addEventListener('mouseleave', this._onLayoutMouseLeave);
    this.layout();
  }

  disconnectedCallback(): void {
    this.removeEventListener('mouseenter', this._onLayoutMouseEnter);
    this.removeEventListener('mouseleave', this._onLayoutMouseLeave);
  }

  static get observedAttributes(): readonly string[] {
    return ['colspan', 'rowspan', 'selected', 'hovered', 'reparent-target'];
  }

  get locked(): boolean {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el instanceof LayoutBoxElement && el.lock) return true;
      el = el.parentElement;
    }
    return false;
  }

  attributeChangedCallback(
    name: string,
    _oldVal: string | null,
    newVal: string | null,
  ): void {
    if (name === 'selected' || name === 'hovered' || name === 'reparent-target') {
      if (this.isConnected) this._renderPlaceholderBorder();
      return;
    }
    if (newVal === null) return;
    const parsed = parseInt(newVal, 10);
    if (Number.isNaN(parsed) || parsed < 1) return;
    if (name === 'colspan' && parsed !== this._colspan) {
      this._colspan = parsed;
      if (this.isConnected) this.layout();
    } else if (name === 'rowspan' && parsed !== this._rowspan) {
      this._rowspan = parsed;
      if (this.isConnected) this.layout();
    }
  }

  get data(): TableCellData {
    if (this._cellEngine?.extractData) return this._cellEngine.extractData;
    return this._rawData();
  }

  _rawData(): TableCellData {
    const result: TableCellData = {
      type: 'td',
      colspan: this._colspan,
      rowspan: this._rowspan,
      children: this.items.map(e => e._rawData()),
    };
    if (this.id) result.id = this.id;
    if (this._backgroundColor) result.backgroundColor = this._backgroundColor;
    if (this._backgroundOpacity !== undefined) result.backgroundOpacity = this._backgroundOpacity;
    if (this._diagonals) result.diagonals = this._diagonals;
    if (this._diagonalWidth !== 0.1) result.diagonalWidth = this._diagonalWidth;
    if (this._diagonalColor !== undefined) result.diagonalColor = this._diagonalColor;
    if (this._paddingTop) result.paddingTop = this._paddingTop;
    if (this._paddingRight) result.paddingRight = this._paddingRight;
    if (this._paddingBottom) result.paddingBottom = this._paddingBottom;
    if (this._paddingLeft) result.paddingLeft = this._paddingLeft;
    return result;
  }

  set data(data: TableCellData) {
    if (!data.id) data = { ...data, id: genUUID() };
    if (data.id !== undefined) this.id = data.id;
      this._colspan = data.colspan ?? 1;
      this._rowspan = data.rowspan ?? 1;
      this.setAttribute('colspan', String(this._colspan));
      this.setAttribute('rowspan', String(this._rowspan));
      this._backgroundColor = data.backgroundColor;
      this._backgroundOpacity = data.backgroundOpacity;
      this._diagonals = data.diagonals;
      this._diagonalWidth = data.diagonalWidth ?? 0.1;
      this._diagonalColor = data.diagonalColor;
      this._paddingTop = data.paddingTop ?? 0;
      this._paddingRight = data.paddingRight ?? 0;
      this._paddingBottom = data.paddingBottom ?? 0;
      this._paddingLeft = data.paddingLeft ?? 0;

      const wasRebuilding = (this as unknown as { _rebuildingChildren?: boolean })._rebuildingChildren;
      (this as unknown as { _rebuildingChildren?: boolean })._rebuildingChildren = true;
      try {
      const existingChildren = this.items;
      const existingById = new Map<string, LayoutBoxElement>();
      for (const child of existingChildren) {
        if (child.id) existingById.set(child.id, child);
      }

      const childrenData = data.children ?? [];
      const usedIds = new Set<string>();
      for (let i = 0; i < childrenData.length; i++) {
        const childData = childrenData[i];
        const childId = childData.id;

        if (childId && existingById.has(childId)) {
          const existingEl = existingById.get(childId)!;
          usedIds.add(childId);
          // 셀 내 박스의 layout+render 캐스케이드를 억제 — 테이블 전체 복원 시
          // O(셀 × 콘텐츠) 중복 렌더를 차단한다 (부모 table/tr이 이미 rebuilding 중).
          (existingEl as unknown as { _rebuildingChildren?: boolean })._rebuildingChildren = true;
          try {
            existingEl.data = childData;
          } finally {
            (existingEl as unknown as { _rebuildingChildren?: boolean })._rebuildingChildren = false;
          }
          if (existingEl !== this.children[i]) {
            this.appendChild(existingEl);
          }
        } else {
          this._appendChildData(childData);
          if (childId) usedIds.add(childId);
        }
      }

      for (const child of existingChildren) {
        if (child.id && !usedIds.has(child.id)) {
          Element.prototype.remove.call(child);
        }
      }
      } finally {
        (this as unknown as { _rebuildingChildren?: boolean })._rebuildingChildren = wasRebuilding;
      }

      if (!wasRebuilding) {
        this.layout();
        void this.render();
      }
  }

  get colspan(): number { return this._colspan; }
  set colspan(value: number) {
    if (this._colspan === value) return;
    this._colspan = value;
    this.setAttribute('colspan', String(value));
    if (this.isConnected) this.layout();
  }

  get rowspan(): number { return this._rowspan; }
  set rowspan(value: number) {
    if (this._rowspan === value) return;
    this._rowspan = value;
    this.setAttribute('rowspan', String(value));
    if (this.isConnected) this.layout();
  }

  get backgroundColor(): string | undefined { return this._backgroundColor; }
  set backgroundColor(value: string | undefined) {
    this._backgroundColor = value;
    if (this.isConnected) this.layout();
  }

  get backgroundOpacity(): number | undefined { return this._backgroundOpacity; }
  set backgroundOpacity(value: number | undefined) {
    this._backgroundOpacity = value;
    if (this.isConnected) this.layout();
  }

  get diagonals(): Array<'tl-br' | 'tr-bl'> | undefined { return this._diagonals; }
  set diagonals(value: Array<'tl-br' | 'tr-bl'> | undefined) {
    this._diagonals = value;
    if (this.isConnected) {
      this._renderDiagonals();
      this._renderPlaceholderBorder();
    }
  }

  get diagonalWidth(): number { return this._diagonalWidth; }
  set diagonalWidth(value: number) {
    this._diagonalWidth = value;
    if (this.isConnected) this._renderDiagonals();
  }

  get diagonalColor(): string | undefined { return this._diagonalColor; }
  set diagonalColor(value: string | undefined) {
    this._diagonalColor = value;
    if (this.isConnected) this._renderDiagonals();
  }

  get paddingTop(): number { return this._paddingTop; }
  set paddingTop(value: number) {
    this._paddingTop = value;
    if (this.isConnected) this.layout();
  }

  get paddingRight(): number { return this._paddingRight; }
  set paddingRight(value: number) {
    this._paddingRight = value;
    if (this.isConnected) this.layout();
  }

  get paddingBottom(): number { return this._paddingBottom; }
  set paddingBottom(value: number) {
    this._paddingBottom = value;
    if (this.isConnected) this.layout();
  }

  get paddingLeft(): number { return this._paddingLeft; }
  set paddingLeft(value: number) {
    this._paddingLeft = value;
    if (this.isConnected) this.layout();
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    if (this.isConnected) this._propagateInheritStyle();
  }

  get inheritStyle(): InheritStyle | undefined {
    return this._inheritStyle;
  }

  get cellLabel(): string { return this._cellLabel; }

  get cellLabels(): string[] { return this._cellLabels; }

  get borderTopWidth(): number | undefined {
    return this._queryFace('top')?.width;
  }
  set borderTopWidth(value: number | undefined) {
    this._writeFace('top', { ...this._readFace('top'), width: value ?? 0 });
  }

  get borderTopColor(): string | undefined {
    return this._queryFace('top')?.color;
  }
  set borderTopColor(value: string | undefined) {
    this._writeFace('top', { ...this._readFace('top'), color: value ?? 'black' });
  }

  get borderTopStyle(): BoxBorderStyle | undefined {
    return this._queryFace('top')?.style;
  }
  set borderTopStyle(value: BoxBorderStyle | undefined) {
    this._writeFace('top', { ...this._readFace('top'), style: value ?? 'solid' });
  }

  get borderRightWidth(): number | undefined {
    return this._queryFace('right')?.width;
  }
  set borderRightWidth(value: number | undefined) {
    this._writeFace('right', { ...this._readFace('right'), width: value ?? 0 });
  }

  get borderRightColor(): string | undefined {
    return this._queryFace('right')?.color;
  }
  set borderRightColor(value: string | undefined) {
    this._writeFace('right', { ...this._readFace('right'), color: value ?? 'black' });
  }

  get borderRightStyle(): BoxBorderStyle | undefined {
    return this._queryFace('right')?.style;
  }
  set borderRightStyle(value: BoxBorderStyle | undefined) {
    this._writeFace('right', { ...this._readFace('right'), style: value ?? 'solid' });
  }

  get borderBottomWidth(): number | undefined {
    return this._queryFace('bottom')?.width;
  }
  set borderBottomWidth(value: number | undefined) {
    this._writeFace('bottom', { ...this._readFace('bottom'), width: value ?? 0 });
  }

  get borderBottomColor(): string | undefined {
    return this._queryFace('bottom')?.color;
  }
  set borderBottomColor(value: string | undefined) {
    this._writeFace('bottom', { ...this._readFace('bottom'), color: value ?? 'black' });
  }

  get borderBottomStyle(): BoxBorderStyle | undefined {
    return this._queryFace('bottom')?.style;
  }
  set borderBottomStyle(value: BoxBorderStyle | undefined) {
    this._writeFace('bottom', { ...this._readFace('bottom'), style: value ?? 'solid' });
  }

  get borderLeftWidth(): number | undefined {
    return this._queryFace('left')?.width;
  }
  set borderLeftWidth(value: number | undefined) {
    this._writeFace('left', { ...this._readFace('left'), width: value ?? 0 });
  }

  get borderLeftColor(): string | undefined {
    return this._queryFace('left')?.color;
  }
  set borderLeftColor(value: string | undefined) {
    this._writeFace('left', { ...this._readFace('left'), color: value ?? 'black' });
  }

  get borderLeftStyle(): BoxBorderStyle | undefined {
    return this._queryFace('left')?.style;
  }
  set borderLeftStyle(value: BoxBorderStyle | undefined) {
    this._writeFace('left', { ...this._readFace('left'), style: value ?? 'solid' });
  }

  /**
   * 부모 테이블에서 현재 셀의 지정 방향 면을 조회한다.
   * 병합 셀 등 여러 면을 덮는 경우 값이 섞여 있으면 `undefined`를 반환한다.
   *
   * @param side - 보더 방향
   * @returns 면 값, 또는 `undefined` (섞였거나 부모 테이블 없음)
   */
  private _queryFace(side: 'top' | 'right' | 'bottom' | 'left'): BorderFace | undefined {
    const table = this._getParentTableElement();
    const cellEngine = this._cellEngine;
    if (!table || !cellEngine) return undefined;
    return table.getCellBorder(cellEngine, side);
  }

  /**
   * 부모 테이블에서 현재 셀의 지정 방향 면을 읽어온다.
   * `_queryFace`가 `undefined`를 반환하면 기본값을 사용한다.
   *
   * @param side - 보더 방향
   * @returns 면 값 (절대 `undefined` 아님)
   */
  private _readFace(side: 'top' | 'right' | 'bottom' | 'left'): BorderFace {
    return this._queryFace(side) ?? DEFAULT_BORDER_FACE;
  }

  /**
   * 부모 테이블의 현재 셀 지정 방향 면에 값을 기록한다.
   *
   * @param side - 보더 방향
   * @param face - 기록할 면 값
   */
  private _writeFace(side: 'top' | 'right' | 'bottom' | 'left', face: BorderFace): void {
    const table = this._getParentTableElement();
    const cellEngine = this._cellEngine;
    if (!table || !cellEngine) return;
    table.setCellBorder(cellEngine, side, face);
  }

  _setCellMetrics(x: number, y: number, width: number, height: number, cellLabel: string = '', cellLabels: string[] = [], cellEngine?: TableCellEngine): void {
    const engineChanged = !!cellEngine && this._cellEngine !== cellEngine;
    const metricsChanged = this._cellEngine
      ? (this._cellEngine.x !== x || this._cellEngine.y !== y
        || this._cellEngine.width !== width || this._cellEngine.height !== height
        || this._cellEngine.cellLabel !== cellLabel)
      : true;
    const changed = engineChanged || metricsChanged;
    if (cellEngine) {
      this._cellEngine = cellEngine;
    } else {
      this._cellEngine?.setCellMetrics(x, y, width, height, cellLabel, cellLabels);
    }
    this._cellLabel = cellLabel;
    this._cellLabels = cellLabels;
    if (changed && this.isConnected) {
      this.layout();
    }
  }

  layout(): void {
    if (!this.isConnected) return;
    this._layoutStructure();
    this._applyStyle();
    this._renderDiagonals();
    this._renderPlaceholderBorder();
    this._propagateInheritStyle();
    for (const box of this.items) {
      box.layout();
    }
    this._updateLabelText();
  }

  async render(): Promise<void> {
    if (!this.isConnected) return;
    const sortedItems = [...this.items].sort((a, b) => a.zIndex - b.zIndex);
    for (const item of sortedItems) {
      await item.render();
    }
  }

  private _layoutStructure(): void {
    if (!this.isConnected) return;

    const parentTable = this._getParentTableElement();
    if (!parentTable) return;

    const found = parentTable.engine?.findCellEngineByLabel(this.cellLabel);
    if (found instanceof TableCellEngine) {
      this._cellEngine = found;
      this._model = found.gridCalculator ?? undefined;
      return;
    }

    const ppm = this._getPpm();
    if (ppm <= 0) return;

    const fallback = this._ensureFallbackCellEngine(ppm);
    this._model = fallback.gridCalculator ?? undefined;

    this._model ??= GridCalculatorEngine.create({
      width: 0, height: 0, columns: 1, gap: 0,
      paragraphStyle: {}, textStyle: {}, isBox: true,
    }, ppm);

    this._model.data = {
      paddingTop: this._paddingTop,
      paddingRight: this._paddingRight,
      paddingBottom: this._paddingBottom,
      paddingLeft: this._paddingLeft,
      columns: 1,
      gap: 0,
      paragraphStyle: this._inheritStyle ?? {},
      textStyle: this._inheritStyle ?? {},
      width: this._width,
      height: this._height,
      isBox: true,
    };
  }

  /**
   * 부모 테이블 요소를 반환한다.
   */
  private _getParentTableElement(): LayoutTableElement | null {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el instanceof LayoutTableRowElement) {
        el = el.parentElement;
      } else if (el instanceof LayoutTableElement) {
        return el;
      } else {
        el = el.parentElement;
      }
    }
    return null;
  }

  /**
   * 과거 로직과의 호환을 위한 fallback cell engine.
   * 부모 TableEngine에서 셀 엔진을 찾지 못한 경우에만 사용.
   */
  private _ensureFallbackCellEngine(ppm: number): TableCellEngine {
    if (!this._cellEngine) {
      this._cellEngine = new TableCellEngine();
      this._cellEngine.setCellMetrics(this._x, this._y, this._width, this._height, this._cellLabel, this._cellLabels);
      this._cellEngine._gridCalculator = GridCalculatorEngine.create({
        width: 0, height: 0, columns: 1, gap: 0,
        paragraphStyle: {}, textStyle: {}, isBox: true,
      }, ppm);
    }
    return this._cellEngine;
  }

  /**
   * 문서 요소에서 ppm을 가져온다.
   */
  private _getPpm(): number {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el instanceof HTMLElement && 'ppm' in el) {
        return (el as unknown as { ppm: number }).ppm;
      }
      el = el.parentElement;
    }
    return 3.78;
  }

  private _applyStyle(): void {
    if (!this.isConnected) return;

    const x = this._cellEngine?.x ?? this._x;
    const y = this._cellEngine?.y ?? this._y;
    const width = this._cellEngine?.width ?? this._width;
    const height = this._cellEngine?.height ?? this._height;

    let styleEl = this._shadowRoot.querySelector<HTMLStyleElement>(`style#${HOST_STYLE_ID}`);
    let needsInit = !styleEl
      || !styleEl.sheet
      || styleEl.sheet.cssRules.length === 0;

    if (needsInit) {
      if (styleEl) styleEl.remove();
      styleEl = document.createElement('style');
      styleEl.id = HOST_STYLE_ID;
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);
      styleEl.sheet.insertRule("@media screen { :host([hovered]) { outline: #4a90d9 solid 1px !important; outline-offset: -1px !important; } }", 1);
      styleEl.sheet.insertRule("@media screen { :host([selected]) { outline: red solid 1px !important; outline-offset: -1px !important; } }", 2);
      styleEl.sheet.insertRule("@media screen { :host([reparent-target]) { outline: #ff9800 solid 2px !important; outline-offset: -2px !important; } }", 3);
      styleEl.sheet.insertRule(`@media screen { .type-label { position: absolute; top: 0; left: 0; padding: 0px 0px 0px 6px; color: #fff; font-family: "Wanted Sans Variable"; font-size: 12px; line-height: 1.3; pointer-events: none; user-select: none; z-index: ${Z_INDEX_TYPE_LABEL}; display: none; white-space: nowrap; } }`, 4);
      styleEl.sheet.insertRule("@media screen { :host([selected]) .type-label { display: flex; align-items: center; gap: 4px; background: rgba(255, 0, 0, 0.85); } }", 5);
      styleEl.sheet.insertRule("@media screen { :host([hovered]) .type-label { display: flex; align-items: center; gap: 4px; background: rgba(74, 144, 217, 0.85); } }", 6);
      styleEl.sheet.insertRule("@media screen { .type-label .parent-btn { pointer-events: auto; cursor: pointer; padding: 1px 8px 3px 0px; user-select: none; opacity: 0.85; } }", 7);
      styleEl.sheet.insertRule("@media screen { .type-label .parent-btn:hover { opacity: 1; } }", 8);

      if (!this._shadowRoot.querySelector('slot')) {
        this._shadowRoot.appendChild(document.createElement('slot'));
      }

      if (!this._labelEl) {
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
    }

    const colorRegistry = ColorRegistry.getInstance();
    const bg = this._backgroundColor
      ? colorRegistry.getCSSColor(this._backgroundColor) +
      colorRegistry.getOpacityHex(this._backgroundOpacity ?? 1)
      : 'transparent';

    const hostRule = styleEl!.sheet!.cssRules[0] as CSSStyleRule;
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      hostRule.style,
      {
        display: 'block',
        boxSizing: 'border-box',
        position: 'absolute',
        left: `${x}mm`,
        top: `${y}mm`,
        width: `${width}mm`,
        height: `${height}mm`,
        backgroundColor: bg,
      },
    );
  }

  private _renderDiagonals(): void {
    for (const el of this._diagonalEls) el.remove();
    this._diagonalEls = [];

    if (!this._diagonals || this._diagonals.length === 0) return;

    const ppm = this._getPpm();
    const width = this._cellEngine?.width ?? this._width;
    const height = this._cellEngine?.height ?? this._height;
    const widthPx = width * ppm;
    const heightPx = height * ppm;

    const cssColor = ColorRegistry.getInstance().getCSSColor(this._diagonalColor ?? 'black');
    const widthPxBorder = Math.max(1, Math.ceil(this._diagonalWidth * ppm));

    for (const dir of this._diagonals) {
      const div = document.createElement('div');
      div.classList.add('diagonal');
      div.style.position = 'absolute';
      div.style.pointerEvents = 'none';
      div.style.zIndex = String(Z_INDEX_TABLE_DIAGONAL);

      const lengthPx = Math.sqrt(widthPx * widthPx + heightPx * heightPx);
      const angleRad = Math.atan2(heightPx, widthPx);

      if (dir === 'tl-br') {
        div.style.width = `${lengthPx}px`;
        div.style.height = `${widthPxBorder}px`;
        div.style.left = '0';
        div.style.top = '0';
        div.style.transformOrigin = 'top left';
        div.style.transform = `rotate(${angleRad}rad)`;
        div.style.backgroundColor = cssColor;
      } else {
        div.style.width = `${lengthPx}px`;
        div.style.height = `${widthPxBorder}px`;
        div.style.right = '0';
        div.style.top = '0';
        div.style.transformOrigin = 'top right';
        div.style.transform = `rotate(-${angleRad}rad)`;
        div.style.backgroundColor = cssColor;
      }

      this._shadowRoot.appendChild(div);
      this._diagonalEls.push(div);
    }
  }

  /**
   * 셀 border가 선언되지 않은 면에 빨간 점선 placeholder border를 렌더링한다.
   *
   * - 위쪽, 왼쪽: 항상 표시 (해당 면 border 없을 때)
    * - 오른쪽: 셀이 논리적으로 마지막 열에 닿을 때만 (해당 면 border 없을 때)
    * - 아랫쪽: 셀이 논리적으로 마지막 행에 닿을 때만 (해당 면 border 없을 때)
    *
    * 레이아웃에 영향을 주지 않도록 shadow DOM 내부에 div 요소로 점선을 그린다.
    */
  private _renderPlaceholderBorder(): void {
    for (const el of this._placeholderBorderEls) el.remove();
    this._placeholderBorderEls = [];

    if (!this.isConnected) return;
    if (!this.editManager?.showPlaceholderBorders) return;
    if (this.hasAttribute('selected')) return;
    if (this.hasAttribute('hovered')) return;
    if (this.hasAttribute('reparent-target')) return;
    if (this._cellLabels.length === 0) return;

    const parentTable = this._getParentTableElement();
    if (!parentTable) return;
    const grid = parentTable.gridResolution;
    if (!grid) return;

    const maxRow = this._getMaxLogicalRow();
    const maxCol = this._getMaxLogicalCol();
    const isLastRow = maxRow >= grid.rowCount - 1;
    const isLastCol = maxCol >= grid.colCount - 1;

    const ppm = this._getPpm();
    const width = this._cellEngine?.width ?? this._width;
    const height = this._cellEngine?.height ?? this._height;
    const widthPx = width * ppm;
    const heightPx = height * ppm;
    const borderWidth = '1px';
    const borderStyle = 'dashed';
    const borderColor = '#aaaaaa';

    const sides: Array<{ side: 'top' | 'bottom' | 'left' | 'right' }> = [];
    const topFace = this._queryFace('top');
    if (!topFace || topFace.width <= 0) sides.push({ side: 'top' });
    const leftFace = this._queryFace('left');
    if (!leftFace || leftFace.width <= 0) sides.push({ side: 'left' });
    const rightFace = this._queryFace('right');
    if (isLastCol && (!rightFace || rightFace.width <= 0)) sides.push({ side: 'right' });
    const bottomFace = this._queryFace('bottom');
    if (isLastRow && (!bottomFace || bottomFace.width <= 0)) sides.push({ side: 'bottom' });

    for (const { side } of sides) {
      const div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.pointerEvents = 'none';
      div.style.boxSizing = 'border-box';

      if (side === 'top') {
        div.style.left = '0';
        div.style.top = '0';
        div.style.width = `${widthPx}px`;
        div.style.height = '0';
        div.style.borderTop = `${borderWidth} ${borderStyle} ${borderColor}`;
      } else if (side === 'bottom') {
        div.style.left = '0';
        div.style.top = `${heightPx}px`;
        div.style.width = `${widthPx}px`;
        div.style.height = '0';
        div.style.borderTop = `${borderWidth} ${borderStyle} ${borderColor}`;
      } else if (side === 'left') {
        div.style.left = '0';
        div.style.top = '0';
        div.style.width = '0';
        div.style.height = `${heightPx}px`;
        div.style.borderLeft = `${borderWidth} ${borderStyle} ${borderColor}`;
      } else {
        div.style.left = `${widthPx}px`;
        div.style.top = '0';
        div.style.width = '0';
        div.style.height = `${heightPx}px`;
        div.style.borderLeft = `${borderWidth} ${borderStyle} ${borderColor}`;
      }

      this._shadowRoot.appendChild(div);
      this._placeholderBorderEls.push(div);
    }
  }

  /**
   * 부모 테이블 요소를 반환한다.
   * 순환 의존성을 피하기 위해 `instanceof` 대신 `gridResolution` getter로 판별한다.
   */


  /**
   * `_cellLabels`에서 이 셀이 커버하는 최대 논리 행 인덱스를 추출한다.
   *
   * @returns 최대 논리 행 인덱스 (0-based). 라벨이 없으면 0
   */
  private _getMaxLogicalRow(): number {
    let maxRow = 0;
    for (const label of this._cellLabels) {
      const match = /^([A-Z]+)(\d+)$/.exec(label);
      if (!match) continue;
      const rowPart = match[1];
      let rowIdx = 0;
      for (let i = 0; i < rowPart.length; i++) {
        rowIdx = rowIdx * 26 + (rowPart.charCodeAt(i) - 64);
      }
      rowIdx -= 1;
      if (rowIdx > maxRow) maxRow = rowIdx;
    }
    return maxRow;
  }

  /**
   * `_cellLabels`에서 이 셀이 커버하는 최대 논리 열 인덱스를 추출한다.
   *
   * @returns 최대 논리 열 인덱스 (0-based). 라벨이 없으면 0
   */
  private _getMaxLogicalCol(): number {
    let maxCol = 0;
    for (const label of this._cellLabels) {
      const match = /^([A-Z]+)(\d+)$/.exec(label);
      if (!match) continue;
      const colIdx = parseInt(match[2], 10) - 1;
      if (colIdx > maxCol) maxCol = colIdx;
    }
    return maxCol;
  }

  private _propagateInheritStyle(): void {
    if (!this._inheritStyle) return;
    const width = this._cellEngine?.width ?? this._width;
    const height = this._cellEngine?.height ?? this._height;
    const childInherit: InheritStyle = {
      ...this._inheritStyle,
      parentWidth: width - this._paddingLeft - this._paddingRight,
      parentHeight: height - this._paddingTop - this._paddingBottom,
      paddingTop: this._paddingTop,
      paddingRight: this._paddingRight,
      paddingBottom: this._paddingBottom,
      paddingLeft: this._paddingLeft,
    };
    for (const child of this.items) {
      child.inheritStyle = childInherit;
    }
  }

  /**
   * 셀에 새로운 자식 박스 데이터를 추가한다.
   *
   * 실제 DOM 생성은 `_appendChildData`가 담당하고, 이 메서드는
   * `layout()` + `render()`를 호출하여 엔진을 재구축한다.
   * `data` setter를 재진입하지 않으므로
   * `set data` → `_appendChildData` → `appendChildData` → `set data` 무한 재귀가
   * 발생하지 않는다 (`box.element.ts`와 동일한 패턴).
   *
   * @param child - 추가할 박스 데이터
   * @returns 생성된 `LayoutBoxElement`
   * @example
   *   const newBox = td.appendChildData({ type: 'box', /* ... *\/ });
   *   // newBox는 셀의 마지막 자식으로 렌더링된다
   */
  appendChildData(child: BoxData): LayoutBoxElement {
    const wasEmpty = this.items.length === 0;
    this._appendChildData(child);
    this.layout();
    void this.render();
    const newBox = this.items[this.items.length - 1] as LayoutBoxElement;
    if (wasEmpty) {
      const manager = this.editManager;
      if (manager && manager.selectedLayouts.includes(this)) {
        manager.clearLayoutSelection(false);
        manager.selectLayout(newBox);
      }
    }
    return newBox;
  }

  /**
   * 데이터 기반 자식 box 삭제.
   *
   * @param id - 삭제할 box의 id
   */
  removeChildData(id: string): void {
    const child = this.items.find(e => e.id === id);
    if (!child) return;
    Element.prototype.remove.call(child);
    this.layout();
    void this.render();
  }

  /**
   * DOM에서 제거될 때 부모 TR의 data를 재설정하여 엔진을 갱신한다.
   */
  remove(): void {
    const parent = this.parentElement;
    if (parent && 'removeChildData' in parent && this.id) {
      (parent as unknown as { removeChildData: (id: string) => void }).removeChildData(this.id);
    } else {
      super.remove();
    }
  }

  /**
   * 자식 박스 DOM 요소를 생성하여 셀에 직접 추가한다.
   *
   * `data` setter를 거치지 않고 DOM만 조작하므로 재귀가 발생하지 않는다.
   * `data` setter의 자식 조정(reconcile) 루프와 `appendChildData` 양쪽에서 호출된다.
   *
   * @param child - 생성할 박스 데이터
   */
  private _appendChildData(child: BoxData): void {
    const boxEl = document.createElement('x-layout-box') as LayoutBoxElement;
    boxEl.data = child;
    this.appendChild(boxEl);
  }

  get editManager(): EditManager | null {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el instanceof LayoutDocumentElement) return el.editManager;
      el = el.parentElement;
    }
    return null;
  }

  get type(): 'td' { return 'td'; }

  get absLeft(): number {
    const parent = this.parentElement as unknown as { absLeft?: number } | null;
    return (parent?.absLeft ?? 0) + (this._cellEngine?.x ?? this._x);
  }

  get absTop(): number {
    const parent = this.parentElement as unknown as { absTop?: number } | null;
    return (parent?.absTop ?? 0) + (this._cellEngine?.y ?? this._y);
  }

  get absWidth(): number {
    return this._cellEngine?.width ?? this._width;
  }

  get absHeight(): number {
    return this._cellEngine?.height ?? this._height;
  }

  get overlayElements(): LayoutBoxElement[] {
    if (!this.parentElement) return [];
    const parent = this.parentElement as unknown as { overlayElements?: LayoutBoxElement[] };
    return parent.overlayElements ?? [];
  }

  get model(): GridCalculatorEngine | undefined {
    return this._cellEngine?.gridCalculator ?? this._model;
  }

  get engine(): TableCellEngine | undefined {
    return this._cellEngine;
  }

  get contentType(): 'box' | 'paragraph' | 'image' | 'table' | undefined {
    const child = this.items[0];
    if (!child) return undefined;
    return child.contentType ?? undefined;
  }

  get contentElement(): LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | LayoutTableElement | null {
    const child = this.items[0];
    if (!child) return null;
    if (child instanceof LayoutBoxElement) return child.contentElement;
    return child as LayoutParagraphElement | LayoutImageElement | LayoutTableElement;
  }

  get items(): LayoutBoxElement[] {
    return Array.from(this.children).filter(
      (c): c is LayoutBoxElement => c instanceof LayoutBoxElement,
    );
  }

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

  private _updateLabelText(): void {
    if (!this._labelEl) return;
    const isEmpty = this.items.length === 0;
    const text = isEmpty ? '빈 셀' : '';
    const span = this._labelEl.firstElementChild as HTMLSpanElement | null;
    if (span && span.textContent !== text) {
      span.textContent = text;
    }
    this._labelEl.style.display = isEmpty ? '' : 'none';
  }

  private _onLayoutMouseEnter = (): void => {
    if (this.locked) return;
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
  };

  private _onLayoutMouseLeave = (event: MouseEvent): void => {
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
  };
}

customElements.define('x-layout-td', LayoutTableCellElement);