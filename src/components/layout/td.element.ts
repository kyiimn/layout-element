import { GridCalculator } from "@/core";
import { ColorRegistry } from "@/resource";
import {
  TableCellData,
  CellBorderEdge,
  BoxData,
  InheritStyle,
  PrintPostData,
  PrintPostDiagonal,
} from "@/types";
import { Z_INDEX_TABLE_DIAGONAL } from "@/constants";
import { genUUID } from "@/utils";
import { EditManager } from "@/edit/edit-manager";
import { LayoutBoxElement } from "./box.element";
import { LayoutDocumentElement } from "./document.element";
import { LayoutImageElement } from "./image.element";
import { LayoutParagraphElement } from "./paragraph.element";

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
  private _styleRule?: CSSStyleRule;

  private _model?: GridCalculator;

  private _x: number = 0;
  private _y: number = 0;
  private _width: number = 0;
  private _height: number = 0;
  private _cellLabel: string = '';
  private _cellLabels: string[] = [];

  private _colspan: number = 1;
  private _rowspan: number = 1;
  private _borderTop?: CellBorderEdge;
  private _borderRight?: CellBorderEdge;
  private _borderBottom?: CellBorderEdge;
  private _borderLeft?: CellBorderEdge;
  private _backgroundColor?: string;
  private _backgroundOpacity?: number;
  private _diagonals?: Array<'tl-br' | 'tr-bl'>;
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

  private _isPrint: boolean = window.matchMedia("print").matches;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback(): void {
    if (!this.id) this.id = genUUID();
    this._startChildObserver();
    this.layout();
  }

  disconnectedCallback(): void {
    this._stopChildObserver();
  }

  static get observedAttributes(): readonly string[] {
    return ['colspan', 'rowspan'];
  }

  attributeChangedCallback(
    name: string,
    _oldVal: string | null,
    newVal: string | null,
  ): void {
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
    const result: TableCellData = {
      type: 'td',
      colspan: this._colspan,
      rowspan: this._rowspan,
      children: this._serializeChildren(),
    };
    if (this.id) result.id = this.id;
    if (this._borderTop) result.borderTop = this._borderTop;
    if (this._borderRight) result.borderRight = this._borderRight;
    if (this._borderBottom) result.borderBottom = this._borderBottom;
    if (this._borderLeft) result.borderLeft = this._borderLeft;
    if (this._backgroundColor) result.backgroundColor = this._backgroundColor;
    if (this._backgroundOpacity !== undefined) result.backgroundOpacity = this._backgroundOpacity;
    if (this._diagonals) result.diagonals = this._diagonals;
    if (this._paddingTop) result.paddingTop = this._paddingTop;
    if (this._paddingRight) result.paddingRight = this._paddingRight;
    if (this._paddingBottom) result.paddingBottom = this._paddingBottom;
    if (this._paddingLeft) result.paddingLeft = this._paddingLeft;
    return result;
  }

  set data(data: TableCellData) {
    this._rebuildingChildren = true;
    try {
      if (data.id !== undefined) this.id = data.id;
      this._colspan = data.colspan ?? 1;
      this._rowspan = data.rowspan ?? 1;
      this.setAttribute('colspan', String(this._colspan));
      this.setAttribute('rowspan', String(this._rowspan));
      this._borderTop = data.borderTop;
      this._borderRight = data.borderRight;
      this._borderBottom = data.borderBottom;
      this._borderLeft = data.borderLeft;
      this._backgroundColor = data.backgroundColor;
      this._backgroundOpacity = data.backgroundOpacity;
      this._diagonals = data.diagonals;
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
  set backgroundColor(value: string | undefined) { this._backgroundColor = value; }

  get backgroundOpacity(): number | undefined { return this._backgroundOpacity; }
  set backgroundOpacity(value: number | undefined) { this._backgroundOpacity = value; }

  get diagonals(): Array<'tl-br' | 'tr-bl'> | undefined { return this._diagonals; }
  set diagonals(value: Array<'tl-br' | 'tr-bl'> | undefined) { this._diagonals = value; }

  get paddingTop(): number { return this._paddingTop; }
  set paddingTop(value: number) { this._paddingTop = value; }

  get paddingRight(): number { return this._paddingRight; }
  set paddingRight(value: number) { this._paddingRight = value; }

  get paddingBottom(): number { return this._paddingBottom; }
  set paddingBottom(value: number) { this._paddingBottom = value; }

  get paddingLeft(): number { return this._paddingLeft; }
  set paddingLeft(value: number) { this._paddingLeft = value; }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    if (this.isConnected) this._propagateInheritStyle();
  }

  get inheritStyle(): InheritStyle | undefined {
    return this._inheritStyle;
  }

  get cellLabel(): string { return this._cellLabel; }

  get cellLabels(): string[] { return this._cellLabels; }

  get borderTop(): CellBorderEdge | undefined { return this._borderTop; }
  get borderRight(): CellBorderEdge | undefined { return this._borderRight; }
  get borderBottom(): CellBorderEdge | undefined { return this._borderBottom; }
  get borderLeft(): CellBorderEdge | undefined { return this._borderLeft; }

  _setCellMetrics(x: number, y: number, width: number, height: number, cellLabel: string = '', cellLabels: string[] = []): void {
    const changed = this._x !== x || this._y !== y
      || this._width !== width || this._height !== height;
    this._x = x;
    this._y = y;
    this._width = width;
    this._height = height;
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

    this._model ??= GridCalculator.create({
      element: this,
      width: 0, height: 0, columns: 1, gap: 0,
      paragraphStyle: {}, textStyle: {},
    });

    this._model.data = {
      element: this,
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
    };
  }

  private _applyStyle(): void {
    if (!this.isConnected) return;

    if (!this._styleRule) {
      const styleEl = document.createElement('style');
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);
      styleEl.sheet.insertRule("@media print { .diagonal { display: none !important; } }", 1);

      this._styleRule = styleEl.sheet.cssRules[0] as CSSStyleRule;

      this._shadowRoot.appendChild(document.createElement('slot'));
    }

    const colorRegistry = ColorRegistry.getInstance();
    const bg = this._backgroundColor
      ? colorRegistry.getCSSColor(this._backgroundColor) +
        colorRegistry.getOpacityHex(this._backgroundOpacity ?? 1)
      : 'transparent';

    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      this._styleRule.style,
      {
        display: 'block',
        boxSizing: 'border-box',
        position: 'absolute',
        left: `${this._x}mm`,
        top: `${this._y}mm`,
        width: `${this._width}mm`,
        height: `${this._height}mm`,
        backgroundColor: bg,
      },
    );
  }

  private _renderDiagonals(): void {
    for (const el of this._diagonalEls) el.remove();
    this._diagonalEls = [];

    if (!this._diagonals || this._diagonals.length === 0) return;
    if (this._isPrint) return;

    const ppm = GridCalculator.ppm;
    const widthPx = this._width * ppm;
    const heightPx = this._height * ppm;

    const edge = this._borderTop ?? this._borderLeft ?? this._borderRight ?? this._borderBottom;
    if (!edge) return;

    const cssColor = ColorRegistry.getInstance().getCSSColor(edge.color);
    const widthPxBorder = Math.max(1, Math.ceil((edge.width ?? 1) * ppm));

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
   * 인쇄 모드에서는 렌더링하지 않는다. 레이아웃에 영향을 주지 않도록
   * shadow DOM 내부에 div 요소로 점선을 그린다.
   */
  private _renderPlaceholderBorder(): void {
    for (const el of this._placeholderBorderEls) el.remove();
    this._placeholderBorderEls = [];

    if (this._isPrint) return;
    if (!this.isConnected) return;

    const parentTable = this._getParentTableElement();
    if (!parentTable) return;
    const grid = parentTable.gridResolution;
    if (!grid) return;

    const maxRow = this._getMaxLogicalRow();
    const maxCol = this._getMaxLogicalCol();
    const isLastRow = maxRow >= grid.rowCount - 1;
    const isLastCol = maxCol >= grid.colCount - 1;

    const ppm = GridCalculator.ppm;
    const widthPx = this._width * ppm;
    const heightPx = this._height * ppm;
    const borderWidth = '1px';
    const borderStyle = 'dashed';
    const borderColor = 'red';

    const sides: Array<{ side: 'top' | 'bottom' | 'left' | 'right' }> = [];
    if (!this._borderTop) sides.push({ side: 'top' });
    if (!this._borderLeft) sides.push({ side: 'left' });
    if (isLastCol && !this._borderRight) sides.push({ side: 'right' });
    if (isLastRow && !this._borderBottom) sides.push({ side: 'bottom' });

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
  private _getParentTableElement(): { gridResolution: { rowCount: number; colCount: number } | undefined } | null {
    let el: Element | null = this.parentElement;
    while (el) {
      const maybeTable = el as unknown as { gridResolution?: unknown };
      if (maybeTable.gridResolution !== undefined && 'gridResolution' in el) {
        return el as unknown as { gridResolution: { rowCount: number; colCount: number } | undefined };
      }
      el = el.parentElement;
    }
    return null;
  }

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
    const ppm = GridCalculator.ppm;
    const childInherit: InheritStyle = {
      ...this._inheritStyle,
      parentWidth: this._width - this._paddingLeft - this._paddingRight,
      parentHeight: this._height - this._paddingTop - this._paddingBottom,
      paddingTop: this._paddingTop,
      paddingRight: this._paddingRight,
      paddingBottom: this._paddingBottom,
      paddingLeft: this._paddingLeft,
    };
    void ppm;
    for (const child of this.items) {
      child.inheritStyle = childInherit;
    }
  }

  appendChildData(child: BoxData): LayoutBoxElement {
    this._layoutStructure();
    const boxEl = document.createElement('x-layout-box');
    boxEl.data = child;
    this.appendChild(boxEl);
    return boxEl;
  }

  private _appendChildData(child: BoxData): void {
    this._layoutStructure();
    const boxEl = document.createElement('x-layout-box');
    boxEl.data = child;
    this.appendChild(boxEl);
  }

  private _serializeChildren(): BoxData[] {
    return this.items.map((e) => e.data).filter((e): e is BoxData => !!e);
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

  get overlayElements(): LayoutBoxElement[] {
    if (!this.parentElement) return [];
    const parent = this.parentElement as unknown as { overlayElements?: LayoutBoxElement[] };
    return parent.overlayElements ?? [];
  }

  get model(): GridCalculator | undefined {
    return this._model;
  }

  get contentType(): 'box' | 'paragraph' | 'image' | 'table' | undefined {
    const child = this.items[0];
    if (!child) return undefined;
    return child.contentType ?? undefined;
  }

  get contentElement(): LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | null {
    const child = this.items[0];
    if (!child) return null;
    if (child instanceof LayoutBoxElement) return child.contentElement;
    return child as LayoutParagraphElement | LayoutImageElement;
  }

  get items(): LayoutBoxElement[] {
    return Array.from(this.children).filter(
      (c): c is LayoutBoxElement => c instanceof LayoutBoxElement,
    );
  }

  get printPostData(): PrintPostData[] {
    const data: PrintPostData[] = [];
    const rect = this.getBoundingClientRect();
    const colorRegistry = ColorRegistry.getInstance();

    const diagonals: PrintPostDiagonal[] = [];
    if (this._diagonals && this._diagonals.length > 0) {
      const ppm = GridCalculator.ppm;
      const edge = this._borderTop ?? this._borderLeft ?? this._borderRight ?? this._borderBottom;
      if (edge) {
        const color = colorRegistry.get(edge.color);
        const widthPx = Math.max(1, Math.ceil((edge.width ?? 1) * ppm));
        const x1 = rect.x + window.scrollX;
        const y1 = rect.y + window.scrollY;
        const x2 = x1 + rect.width;
        const y2 = y1 + rect.height;
        for (const dir of this._diagonals) {
          if (dir === 'tl-br') {
            diagonals.push({ direction: 'tl-br', x1, y1, x2, y2, width: widthPx, color });
          } else {
            diagonals.push({ direction: 'tr-bl', x1: x2, y1, x2: x1, y2, width: widthPx, color });
          }
        }
      }
    }

    data.push({
      backgroundColor: this._backgroundColor
        ? colorRegistry.get(this._backgroundColor)
        : undefined,
      backgroundOpacity: this._backgroundOpacity,
      data: this.data,
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      diagonals: diagonals.length > 0 ? diagonals : undefined,
    });

    const sortedItems = [...this.items].sort((a, b) => a.zIndex - b.zIndex);
    for (const item of sortedItems) {
      data.push(...item.printPostData);
    }

    return data;
  }
}

customElements.define('x-layout-td', LayoutTableCellElement);