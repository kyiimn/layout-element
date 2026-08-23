import { TableRowData, TableCellData, InheritStyle } from "@/types";
import { genUUID } from "@/utils";
import { EditManager } from "@/edit/edit-manager";
import { LayoutDocumentElement } from "./document.element";
import { LayoutBoxElement } from "./box.element";
import { LayoutTableCellElement } from "./td.element";

const HOST_STYLE_ID = '__layout_host_style__';

function indexToColumnLabel(index: number): string {
  let label = '';
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/**
 * 테이블 행 요소. `<x-layout-tr>` 커스텀 엘리먼트.
 *
 * 행 자체는 시각적 요소가 없다(배경/보더 없음).
 * table이 부여하는 행 메트릭(y, height, width)으로 위치하고,
 * 자식 TD를 shadow slot으로 투영한다.
 */
export class LayoutTableRowElement extends HTMLElement {
  private _shadowRoot: ShadowRoot;

  private _y: number = 0;
  private _height: number = 0;
  private _width: number = 0;
  private _rowIndex: number = 0;

  private _cells: TableCellData[] = [];
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
    return ['height'];
  }

  attributeChangedCallback(
    name: string,
    _oldVal: string | null,
    newVal: string | null,
  ): void {
    if (name === 'height' && newVal !== null) {
      const parsed = parseFloat(newVal);
      if (!Number.isNaN(parsed) && parsed !== this._height) {
        this._height = parsed;
        if (this.isConnected) this.layout();
      }
    }
  }

  get data(): TableRowData {
    return this._rawData();
  }

  _rawData(): TableRowData {
    const result: TableRowData = {
      type: 'tr',
      height: this._height,
      children: this._serializeChildren(),
    };
    if (this.id) result.id = this.id;
    return result;
  }

  set data(data: TableRowData) {
    if (!data.id) data = { ...data, id: genUUID() };
    this._rebuildingChildren = true;
    try {
      if (data.id !== undefined) this.id = data.id;
      this._height = data.height;
      this.setAttribute('height', String(data.height));
      this._cells = data.children ?? [];

      const existingChildren = this.items;
      const existingById = new Map<string, LayoutTableCellElement>();
      for (const child of existingChildren) {
        if (child.id) existingById.set(child.id, child);
      }

      const usedIds = new Set<string>();
      for (let i = 0; i < this._cells.length; i++) {
        const cellData = this._cells[i];
        const cellId = cellData.id;

        if (cellId && existingById.has(cellId)) {
          const existingEl = existingById.get(cellId)!;
          usedIds.add(cellId);
          existingEl.data = cellData;
          if (existingEl !== this.children[i]) {
            this.appendChild(existingEl);
          }
        } else {
          this._appendChildData(cellData);
          if (cellId) usedIds.add(cellId);
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

  get height(): number { return this._height; }
  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this.setAttribute('height', String(value));
    if (this.isConnected) this.layout();
  }

  _setRowMetrics(y: number, height: number, width: number, rowIndex: number = 0): void {
    const changed = this._y !== y || this._height !== height || this._width !== width;
    this._y = y;
    this._height = height;
    this._width = width;
    this._rowIndex = rowIndex;
    if (changed && this.isConnected) {
      this.layout();
    }
  }

  get rowIndex(): number { return this._rowIndex; }

  get rowLabel(): string {
    return indexToColumnLabel(this._rowIndex);
  }

  layout(): void {
    if (!this.isConnected) return;
    this._layoutStructure();
    this._applyStyle();
    this._propagateInheritStyle();
    for (const td of this.items) {
      td.layout();
    }
  }

  async render(): Promise<void> {
    if (!this.isConnected) return;
    for (const td of this.items) {
      await td.render();
    }
  }

  private _layoutStructure(): void {
  }

  private _applyStyle(): void {
    if (!this.isConnected) return;

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
      styleEl.sheet.insertRule(":host { display: block; position: absolute; }", 0);

      if (!this._shadowRoot.querySelector('slot')) {
        this._shadowRoot.appendChild(document.createElement('slot'));
      }
    }

    const hostRule = styleEl!.sheet!.cssRules[0] as CSSStyleRule;
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      hostRule.style,
      {
        position: 'absolute',
        top: `${this._y}mm`,
        left: '0',
        width: `${this._width}mm`,
        height: `${this._height}mm`,
      },
    );
  }

  private _propagateInheritStyle(): void {
    if (!this._inheritStyle) return;
    for (const td of this.items) {
      td.inheritStyle = this._inheritStyle;
    }
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    if (this.isConnected) this._propagateInheritStyle();
  }

  get inheritStyle(): InheritStyle | undefined {
    return this._inheritStyle;
  }

  appendChildData(child: TableCellData): LayoutTableCellElement {
    const tdEl = document.createElement('x-layout-td') as LayoutTableCellElement;
    tdEl.data = child;
    this.appendChild(tdEl);
    return tdEl;
  }

  private _appendChildData(child: TableCellData): void {
    const tdEl = document.createElement('x-layout-td') as LayoutTableCellElement;
    tdEl.data = child;
    this.appendChild(tdEl);
  }

  private _serializeChildren(): TableCellData[] {
    return this.items.map((e) => e._rawData()).filter((e): e is TableCellData => !!e);
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

  get type(): 'tr' { return 'tr'; }

  get absLeft(): number {
    const parent = this.parentElement as unknown as { absLeft?: number } | null;
    return parent?.absLeft ?? 0;
  }

  get absTop(): number {
    const parent = this.parentElement as unknown as { absTop?: number } | null;
    return (parent?.absTop ?? 0) + this._y;
  }

  get absWidth(): number {
    return this._width;
  }

  get absHeight(): number {
    return this._height;
  }

  get items(): LayoutTableCellElement[] {
    return Array.from(this.children).filter(
      (c): c is LayoutTableCellElement => c instanceof LayoutTableCellElement,
    );
  }

  get overlayElements(): LayoutBoxElement[] {
    if (!this.parentElement) return [];
    const parent = this.parentElement as unknown as { overlayElements?: LayoutBoxElement[] };
    return parent.overlayElements ?? [];
  }
}

customElements.define('x-layout-tr', LayoutTableRowElement);