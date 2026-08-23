import { GridCalculatorEngine, TableCellEngine } from "@/engine";
import { ColorRegistry } from "@/resource";
import {
  TableCellData,
  BoxData,
  BoxBorderStyle,
  InheritStyle,
} from "@/types";
import { Z_INDEX_TABLE_DIAGONAL } from "@/constants";
import { genUUID } from "@/utils";
import { EditManager } from "@/edit/edit-manager";
import { LayoutBoxElement } from "./box.element";
import { LayoutDocumentElement } from "./document.element";
import { LayoutImageElement } from "./image.element";
import { LayoutParagraphElement } from "./paragraph.element";
import { LayoutTableElement } from "./table.element";
import { LayoutTableRowElement } from "./tr.element";

const HOST_STYLE_ID = '__layout_host_style__';

/**
 * 테이블 셀 요소. `<x-layout-td>` 커스텀 엘리먼트.
 *
 * table이 부여하는 메트릭(x, y, width, height)으로 위치하고,
 * 자체 GridCalculator(columns=1)를 보유하여 cell 내부를 box 배치 컨텍스트로 동작시킨다.
 * 셀 자체의 테두리는 방향별로 선언만 보유하고, 실제 렌더링은 부모 table이 담당한다.
 * 대각선은 TD shadow root에 렌더링한다.
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
  private _borderTopWidth?: number;
  private _borderTopColor?: string;
  private _borderTopStyle?: BoxBorderStyle;
  private _borderRightWidth?: number;
  private _borderRightColor?: string;
  private _borderRightStyle?: BoxBorderStyle;
  private _borderBottomWidth?: number;
  private _borderBottomColor?: string;
  private _borderBottomStyle?: BoxBorderStyle;
  private _borderLeftWidth?: number;
  private _borderLeftColor?: string;
  private _borderLeftStyle?: BoxBorderStyle;
  private _backgroundColor?: string;
  private _backgroundOpacity?: number;
  private _diagonals?: Array<'tl-br' | 'tr-bl'>;
  private _diagonalWidth: number = 0.1;
  private _diagonalColor?: string;
  private _paddingTop: number = 0;
  private _paddingRight: number = 0;
  private _paddingBottom: number = 0;
  private _paddingLeft: number = 0;
  private _children: BoxData[] = [];

  private _diagonalEls: HTMLDivElement[] = [];
  private _placeholderBorderEls: HTMLDivElement[] = [];

  private _inheritStyle?: InheritStyle;

  private _childObserver: MutationObserver | null = null;
  private _rebuildingChildren = false;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback(): void {
    this._startChildObserver();
    this.layout();
  }

  disconnectedCallback(): void {
    this._stopChildObserver();
  }

  static get observedAttributes(): readonly string[] {
    return ['colspan', 'rowspan', 'selected', 'hovered', 'reparent-target'];
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
      children: this._serializeChildren(),
    };
    if (this.id) result.id = this.id;
    if (this._borderTopWidth !== undefined) result.borderTopWidth = this._borderTopWidth;
    if (this._borderTopColor !== undefined) result.borderTopColor = this._borderTopColor;
    if (this._borderTopStyle !== undefined) result.borderTopStyle = this._borderTopStyle;
    if (this._borderRightWidth !== undefined) result.borderRightWidth = this._borderRightWidth;
    if (this._borderRightColor !== undefined) result.borderRightColor = this._borderRightColor;
    if (this._borderRightStyle !== undefined) result.borderRightStyle = this._borderRightStyle;
    if (this._borderBottomWidth !== undefined) result.borderBottomWidth = this._borderBottomWidth;
    if (this._borderBottomColor !== undefined) result.borderBottomColor = this._borderBottomColor;
    if (this._borderBottomStyle !== undefined) result.borderBottomStyle = this._borderBottomStyle;
    if (this._borderLeftWidth !== undefined) result.borderLeftWidth = this._borderLeftWidth;
    if (this._borderLeftColor !== undefined) result.borderLeftColor = this._borderLeftColor;
    if (this._borderLeftStyle !== undefined) result.borderLeftStyle = this._borderLeftStyle;
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
    this._rebuildingChildren = true;
    try {
      if (data.id !== undefined) this.id = data.id;
      this._colspan = data.colspan ?? 1;
      this._rowspan = data.rowspan ?? 1;
      this.setAttribute('colspan', String(this._colspan));
      this.setAttribute('rowspan', String(this._rowspan));
      this._borderTopWidth = data.borderTopWidth;
      this._borderTopColor = data.borderTopColor;
      this._borderTopStyle = data.borderTopStyle;
      this._borderRightWidth = data.borderRightWidth;
      this._borderRightColor = data.borderRightColor;
      this._borderRightStyle = data.borderRightStyle;
      this._borderBottomWidth = data.borderBottomWidth;
      this._borderBottomColor = data.borderBottomColor;
      this._borderBottomStyle = data.borderBottomStyle;
      this._borderLeftWidth = data.borderLeftWidth;
      this._borderLeftColor = data.borderLeftColor;
      this._borderLeftStyle = data.borderLeftStyle;
      this._backgroundColor = data.backgroundColor;
      this._backgroundOpacity = data.backgroundOpacity;
      this._diagonals = data.diagonals;
      this._diagonalWidth = data.diagonalWidth ?? 0.1;
      this._diagonalColor = data.diagonalColor;
      this._paddingTop = data.paddingTop ?? 0;
      this._paddingRight = data.paddingRight ?? 0;
      this._paddingBottom = data.paddingBottom ?? 0;
      this._paddingLeft = data.paddingLeft ?? 0;
      this._children = data.children ?? [];

      const existingChildren = this.items;
      const existingById = new Map<string, LayoutBoxElement>();
      for (const child of existingChildren) {
        if (child.id) existingById.set(child.id, child);
      }

      const usedIds = new Set<string>();
      for (let i = 0; i < this._children.length; i++) {
        const childData = this._children[i];
        const childId = childData.id;

        if (childId && existingById.has(childId)) {
          const existingEl = existingById.get(childId)!;
          usedIds.add(childId);
          existingEl.data = childData;
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
          child.remove();
        }
      }

      this.layout();
      void this.render();
    } finally {
      this._rebuildingChildren = false;
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

  get borderTopWidth(): number | undefined { return this._borderTopWidth; }
  set borderTopWidth(value: number | undefined) {
    this._borderTopWidth = value;
    this._refreshParentTableBorder();
  }

  get borderTopColor(): string | undefined { return this._borderTopColor; }
  set borderTopColor(value: string | undefined) {
    this._borderTopColor = value;
    this._refreshParentTableBorder();
  }

  get borderTopStyle(): BoxBorderStyle | undefined { return this._borderTopStyle; }
  set borderTopStyle(value: BoxBorderStyle | undefined) {
    this._borderTopStyle = value;
    this._refreshParentTableBorder();
  }

  get borderRightWidth(): number | undefined { return this._borderRightWidth; }
  set borderRightWidth(value: number | undefined) {
    this._borderRightWidth = value;
    this._refreshParentTableBorder();
  }

  get borderRightColor(): string | undefined { return this._borderRightColor; }
  set borderRightColor(value: string | undefined) {
    this._borderRightColor = value;
    this._refreshParentTableBorder();
  }

  get borderRightStyle(): BoxBorderStyle | undefined { return this._borderRightStyle; }
  set borderRightStyle(value: BoxBorderStyle | undefined) {
    this._borderRightStyle = value;
    this._refreshParentTableBorder();
  }

  get borderBottomWidth(): number | undefined { return this._borderBottomWidth; }
  set borderBottomWidth(value: number | undefined) {
    this._borderBottomWidth = value;
    this._refreshParentTableBorder();
  }

  get borderBottomColor(): string | undefined { return this._borderBottomColor; }
  set borderBottomColor(value: string | undefined) {
    this._borderBottomColor = value;
    this._refreshParentTableBorder();
  }

  get borderBottomStyle(): BoxBorderStyle | undefined { return this._borderBottomStyle; }
  set borderBottomStyle(value: BoxBorderStyle | undefined) {
    this._borderBottomStyle = value;
    this._refreshParentTableBorder();
  }

  get borderLeftWidth(): number | undefined { return this._borderLeftWidth; }
  set borderLeftWidth(value: number | undefined) {
    this._borderLeftWidth = value;
    this._refreshParentTableBorder();
  }

  get borderLeftColor(): string | undefined { return this._borderLeftColor; }
  set borderLeftColor(value: string | undefined) {
    this._borderLeftColor = value;
    this._refreshParentTableBorder();
  }

  get borderLeftStyle(): BoxBorderStyle | undefined { return this._borderLeftStyle; }
  set borderLeftStyle(value: BoxBorderStyle | undefined) {
    this._borderLeftStyle = value;
    this._refreshParentTableBorder();
  }

  private _refreshParentTableBorder(): void {
    if (!this.isConnected) return;
    let el: Element | null = this.parentElement;
    while (el) {
      if (el instanceof HTMLElement && el.localName === 'x-layout-table' && 'refreshBorder' in el) {
        (el as unknown as { refreshBorder: () => void }).refreshBorder();
        break;
      }
      el = el.parentElement;
    }
  }

  _setCellMetrics(x: number, y: number, width: number, height: number, cellLabel: string = '', cellLabels: string[] = []): void {
    const changed = this._cellEngine
      ? (this._cellEngine.x !== x || this._cellEngine.y !== y
        || this._cellEngine.width !== width || this._cellEngine.height !== height
        || this._cellEngine.cellLabel !== cellLabel)
      : true;
    this._cellEngine?.setCellMetrics(x, y, width, height, cellLabel, cellLabels);
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
      styleEl.sheet.insertRule("@media screen { :host([reparent-target]) { outline: #ff9800 solid 2px !important; outline-offset: -2px !important; } }", 1);

      if (!this._shadowRoot.querySelector('slot')) {
        this._shadowRoot.appendChild(document.createElement('slot'));
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
    if (!this._borderTopWidth || !this._borderTopColor) sides.push({ side: 'top' });
    if (!this._borderLeftWidth || !this._borderLeftColor) sides.push({ side: 'left' });
    if (isLastCol && (!this._borderRightWidth || !this._borderRightColor)) sides.push({ side: 'right' });
    if (isLastRow && (!this._borderBottomWidth || !this._borderBottomColor)) sides.push({ side: 'bottom' });

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
   * 실제 DOM 생성은 `_appendChildData`가 담당하고, 이 메서드는 내부 `_children` 배열을
   * 갱신하고 영향받는 문단의 재렌더를 요청한다. `data` setter를 재진입하지 않으므로
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
    this._appendChildData(child);
    this._children.push(child);
    return this.items[this.items.length - 1] as LayoutBoxElement;
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

  private _serializeChildren(): BoxData[] {
    return this.items.map((e) => e._rawData()).filter((e): e is BoxData => !!e);
  }

  private _startChildObserver(): void {
    if (this._childObserver) return;
    this._childObserver = new MutationObserver(() => {
      if (this._rebuildingChildren) return;
      this.layout();
      void this.render();
    });
    this._childObserver.observe(this, { childList: true });
  }

  private _stopChildObserver(): void {
    this._childObserver?.disconnect();
    this._childObserver = null;
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
}

customElements.define('x-layout-td', LayoutTableCellElement);