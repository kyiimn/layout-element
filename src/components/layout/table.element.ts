import {
  TableData,
  TableRowData,
  CellBorderEdge,
  InheritStyle,
} from "@/types";
import {
  GridResolution,
  BorderResolution,
  ResolvedBorderEdge,
  resolveTableBorders,
  TableEngine,
} from "@/engine";
import { ColorRegistry } from "@/resource";
import { Z_INDEX_TABLE_BORDER, Z_INDEX_TABLE_RESIZE, Z_INDEX_TABLE_SELECTION, MIN_TABLE_COL_WIDTH, MIN_TABLE_ROW_HEIGHT } from "@/constants";
import { genUUID } from "@/utils";
import { EditManager } from "@/edit/edit-manager";
import { TableKeyboardController } from "@/edit/table-keyboard-controller";
import { TableStructureEditor } from "@/edit/table-structure-editor";
import { LayoutDocumentElement } from "./document.element";
import { LayoutBoxElement } from "./box.element";
import { LayoutTableRowElement } from "./tr.element";

interface TableResizeState {
  isResizing: boolean;
  handle: string | null;
  moved: boolean;
  startMouseX: number;
  startMouseY: number;
  startColWidths: number[];
  startRowHeights: number[];
  lastClientX: number;
  lastClientY: number;
  rafId: number | null;
}

const HIT_WIDTH = 8;
const HOST_STYLE_ID = '__layout_host_style__';

/**
 * 테이블 요소. `<x-layout-table>` 커스텀 엘리먼트.
 *
 * box의 콘텐츠 타입으로, 부모 box의 콘텐츠 영역을 가득 채우며
 * 내부를 colWidths × 행 높이 그리드로 분할한다.
 * 보더 레이어를 shadow root에 렌더링하고, 자식 TR/TD에 메트릭을 부여한다.
 */
export class LayoutTableElement extends HTMLElement {
  private _shadowRoot: ShadowRoot;
  private _engine?: TableEngine;

  private _borderLayerEl: HTMLDivElement | null = null;
  private _borderEdgeMap: Map<string, HTMLDivElement> = new Map();

  private _childObserver: MutationObserver | null = null;
  private _rebuildingChildren = false;

  private _colWidths?: number | number[];
  private _rows: TableRowData[] = [];

  get rows(): TableRowData[] { return this._rows; }

  private _inheritStyle?: InheritStyle;

  private _gridResolution?: GridResolution;
  private _borderResolution?: BorderResolution;

  private _borderOverrides: Map<string, CellBorderEdge> = new Map();

  private _resolvedColWidths: number[] = [];

  private _resizeHandleLayerEl: HTMLDivElement | null = null;
  private _resizeHandleEls: HTMLDivElement[] = [];
  private _resizeState: TableResizeState | null = null;
  private _resizeListenerRegistered: boolean = false;
  private _keyboardController: TableKeyboardController | null = null;
  private _structureEditor: TableStructureEditor | null = null;
  private _selectionLayerEl: HTMLDivElement | null = null;
  private _selectionCircleMap: Map<string, HTMLDivElement> = new Map();

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback(): void {
    this._startChildObserver();
    this.layout();
    const editManager = this.editManager;
    if (editManager) {
      editManager.addEventListener('modeChange', this._onModeChange);
      this._activateKeyboardEditing();
      if (editManager.layoutEditMode) {
        this._activateTableEditing();
      }
    }
  }

  disconnectedCallback(): void {
    this._stopChildObserver();
    const editManager = this.editManager;
    if (editManager) {
      editManager.removeEventListener('modeChange', this._onModeChange);
    }
    this._deactivateKeyboardEditing();
    this._deactivateTableEditing();
  }

  /**
   * 이 테이블에 연결된 TableEngine 인스턴스를 반환한다.
   *
   * @returns TableEngine 인스턴스. 연결 전이면 undefined.
   */
  get engine(): TableEngine | undefined { return this._engine; }

  private _onModeChange = (event: { mode?: { layoutEditMode?: boolean } }): void => {
    const mode = event?.mode;
    if (mode?.layoutEditMode) {
      this._activateTableEditing();
    } else {
      this._deactivateTableEditing();
    }
  };

  private _activateKeyboardEditing(): void {
    const editManager = this.editManager;
    if (!editManager) return;
    if (!this._structureEditor) {
      this._structureEditor = new TableStructureEditor(this, editManager);
    }
    if (!this._keyboardController) {
      this._keyboardController = new TableKeyboardController(this, editManager, this._structureEditor);
    }
    this._keyboardController.activate();
    this.setAttribute('tabindex', '-1');
    document.addEventListener('keydown', this._onTableKeyDown, true);
  }

  private _deactivateKeyboardEditing(): void {
    document.removeEventListener('keydown', this._onTableKeyDown, true);
    this._keyboardController?.deactivate();
    this.removeAttribute('tabindex');
  }

  static get observedAttributes(): readonly string[] {
    return [];
  }

  attributeChangedCallback(
    _name: string,
    _oldVal: string | null,
    _newVal: string | null,
  ): void {
  }

  get data(): TableData {
    if (this._engine?.extractData) return this._engine.extractData;
    return this._rawData();
  }

  _rawData(): TableData {
    const result: TableData = {
      type: 'table',
      children: this._serializeChildren(),
    };
    if (this.id) result.id = this.id;
    if (this._colWidths !== undefined) result.colWidths = this._colWidths;
    return result;
  }

  set data(data: TableData) {
    if (!data.id) data = { ...data, id: genUUID() };
    this._rebuildingChildren = true;
    try {
      if (data.id !== undefined) this.id = data.id;
      this._colWidths = data.colWidths;
      this._rows = data.children ?? [];

      this._layoutStructure();

      const existingChildren = this.items;
      const existingById = new Map<string, LayoutTableRowElement>();
      for (const child of existingChildren) {
        if (child.id) existingById.set(child.id, child);
      }

      const usedIds = new Set<string>();
      for (let i = 0; i < this._rows.length; i++) {
        const rowData = this._rows[i];
        const rowId = rowData.id;

        if (rowId && existingById.has(rowId)) {
          const existingEl = existingById.get(rowId)!;
          usedIds.add(rowId);
          existingEl.data = rowData;
          this.appendChild(existingEl);
        } else {
          this._appendChildData(rowData);
          if (rowId) usedIds.add(rowId);
        }
      }

      for (const child of existingChildren) {
        if (child.id && !usedIds.has(child.id)) {
          child.remove();
        }
      }

      this.layout();
      requestAnimationFrame(() => { void this.render(); });
    } finally {
      this._rebuildingChildren = false;
    }
  }

  get colWidths(): number | number[] | undefined { return this._colWidths; }
  set colWidths(value: number | number[] | undefined) {
    this._colWidths = value;
    if (this.isConnected) {
      this._engine?.layout();
      this.layout();
      void this.render();
    }
  }

  get gridResolution(): GridResolution | undefined {
    return this._gridResolution;
  }

  get resolvedColWidths(): number[] {
    return this._resolvedColWidths;
  }

  get keyboardController(): TableKeyboardController | null {
    return this._keyboardController;
  }

  get structureEditor(): TableStructureEditor | null {
    return this._structureEditor;
  }

  get inheritStyle(): InheritStyle | undefined {
    return this._inheritStyle;
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    if (this.isConnected) this._propagateInheritStyle();
  }

  layout(): void {
    if (!this.isConnected) return;
    this._layoutStructure();
    this._applyStyle();
    this._renderBorder();
    this._renderResizeHandles();
    this._propagateInheritStyle();
    for (const tr of this.items) {
      tr.layout();
    }
    if (this._keyboardController?.selection) {
      this._renderSelectionOverlay(this._keyboardController.selection);
    }
  }

  async render(): Promise<void> {
    if (!this.isConnected) return;
    for (const tr of this.items) {
      await tr.render();
    }
  }

  private _layoutStructure(): void {
    if (!this.isConnected) return;

    const parentBox = this.parentElement;
    if (!(parentBox instanceof LayoutBoxElement)) {
      this._gridResolution = undefined;
      return;
    }

    const contentWidth = parentBox.absWidth
      - (parentBox.paddingLeft ?? 0) - (parentBox.paddingRight ?? 0);

    const parentBoxEngine = parentBox.engine;
    if (!parentBoxEngine) {
      this._gridResolution = undefined;
      return;
    }

    const existing = parentBoxEngine.childEngines.find(e => e instanceof TableEngine);
    if (existing) {
      this._engine = existing;
    }

    this._rows = this._serializeChildren();

    const tableData: TableData = {
      type: 'table',
      id: this.id || undefined,
      colWidths: this._colWidths,
      children: this._rows,
    };

    if (!this._engine) {
      this._engine = TableEngine.create(tableData, parentBoxEngine);
      parentBoxEngine.childEngines = [...parentBoxEngine.childEngines, this._engine];
    } else {
      this._engine.data = tableData;
    }
    this._engine.layout();

    this._gridResolution = this._engine.gridResolution ?? undefined;
    this._resolvedColWidths = this._gridResolution?.colWidths ?? [];

    // 계산된 rowHeights/colWidths를 원본 데이터에 write-back하여
    // 이후 layout(부모 box 리사이즈 등)에서 리사이즈된 값이 입력으로 사용되도록 한다.
    // 리사이즈 핸들 드래그 중에는 핸들러가 직접 _colWidths/_rows.height를
    // 관리하므로 write-back하지 않는다.
    if (this._gridResolution && !this._resizeState) {
      const resolvedRowHeights = this._gridResolution.rowHeights;
      for (let r = 0; r < this._rows.length && r < resolvedRowHeights.length; r++) {
        this._rows[r].height = resolvedRowHeights[r];
      }
      if (this._colWidths === undefined || typeof this._colWidths === 'number') {
        this._colWidths = [...this._gridResolution.colWidths];
      }
    }

    if (this._gridResolution && this._gridResolution.warnings.length > 0) {
      this.dispatchEvent(new CustomEvent('render-error', {
        detail: { type: 'table-grid', warnings: this._gridResolution.warnings },
      }));
    }

    const engineRows = this._engine.rowEngines;
    for (let r = 0; r < engineRows.length; r++) {
      const rowEngine = engineRows[r];
      if (!rowEngine) continue;
      const trEls = this.querySelectorAll<LayoutTableRowElement>(':scope > x-layout-tr');
      const trEl = trEls[r] as LayoutTableRowElement | undefined;
      if (trEl && trEl.localName === 'x-layout-tr') {
        trEl._setRowMetrics(rowEngine.y, rowEngine.height, contentWidth, r);
      }
    }

    for (let r = 0; r < engineRows.length; r++) {
      const rowEngine = engineRows[r];
      if (!rowEngine) continue;
      const trEls = this.querySelectorAll<LayoutTableRowElement>(':scope > x-layout-tr');
      const trEl = trEls[r] as LayoutTableRowElement | undefined;
      if (!trEl) continue;
      const tdEls = trEl.items;
      const rowLabel = trEl.rowLabel;
      const cellEngines = rowEngine.cellEngines;
      for (let i = 0; i < cellEngines.length && i < tdEls.length; i++) {
        const cellEngine = cellEngines[i];
        if (!cellEngine) continue;
        const tdEl = tdEls[i];
        const cellLabel = cellEngine.cellLabel || `${rowLabel}${i + 1}`;
        tdEl._setCellMetrics(cellEngine.x, cellEngine.y, cellEngine.width, cellEngine.height, cellLabel, cellEngine.labels, cellEngine);
      }
    }
  }

  private _findDocumentElement(): LayoutDocumentElement | null {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el instanceof LayoutDocumentElement) return el;
      el = el.parentElement;
    }
    return null;
  }

  private _getPpm(): number {
    return this._findDocumentElement()?.ppm ?? 3.78;
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
      styleEl.sheet.insertRule(":host { display: block; position: absolute; top: 0; left: 0; width: 100%; height: 100%; }", 0);

      if (!this._shadowRoot.querySelector('slot')) {
        this._shadowRoot.appendChild(document.createElement('slot'));
      }
    }
  }

  private _renderBorder(): void {
    if (!this.isConnected) return;

    this._borderResolution = this._resolveBorders();
    if (!this._borderResolution) return;

    if (!this._borderLayerEl) {
      const layer = document.createElement('div');
      layer.classList.add('border-layer');
      layer.style.position = 'absolute';
      layer.style.top = '0';
      layer.style.left = '0';
      layer.style.width = '100%';
      layer.style.height = '100%';
      layer.style.pointerEvents = 'none';
      layer.style.zIndex = String(Z_INDEX_TABLE_BORDER);
      this._shadowRoot.appendChild(layer);
      this._borderLayerEl = layer;
    }

    this._renderBorderLayer(this._borderResolution.edges);
  }

  private _renderBorderLayer(edges: ResolvedBorderEdge[]): void {
    const ppm = this._getPpm();
    const colorRegistry = ColorRegistry.getInstance();
    const layer = this._borderLayerEl!;
    const newKeys = new Set<string>();

    for (const edge of edges) {
      newKeys.add(edge.key);

      let div = this._borderEdgeMap.get(edge.key);
      if (!div || !div.isConnected) {
        div = document.createElement('div');
        div.style.position = 'absolute';
        div.style.pointerEvents = 'none';
        layer.appendChild(div);
        this._borderEdgeMap.set(edge.key, div);
      }

      const cssColor = colorRegistry.getCSSColor(edge.color);
      const widthPx = Math.ceil(edge.width * ppm);
      const lengthPx = edge.length * ppm;

      if (edge.direction === 'horizontal') {
        div.style.left = `${edge.x * ppm}px`;
        div.style.top = `${edge.y * ppm}px`;
        div.style.width = `${lengthPx}px`;
        div.style.height = '0';
        div.style.borderTop = `${widthPx}px ${edge.style} ${cssColor}`;
        div.style.borderBottom = 'none';
        div.style.borderLeft = 'none';
        div.style.borderRight = 'none';
      } else {
        div.style.left = `${edge.x * ppm}px`;
        div.style.top = `${edge.y * ppm}px`;
        div.style.width = '0';
        div.style.height = `${lengthPx}px`;
        div.style.borderLeft = `${widthPx}px ${edge.style} ${cssColor}`;
        div.style.borderTop = 'none';
        div.style.borderBottom = 'none';
        div.style.borderRight = 'none';
      }
    }

    for (const [key, div] of this._borderEdgeMap) {
      if (!newKeys.has(key)) {
        div.remove();
        this._borderEdgeMap.delete(key);
      }
    }
  }

  private _resolveBorders(): BorderResolution | undefined {
    if (!this._gridResolution) return undefined;
    return resolveTableBorders(this._gridResolution, this._borderOverrides);
  }

  setBorderOverride(key: string, edge: CellBorderEdge): void {
    this._borderOverrides.set(key, edge);
    if (this.isConnected) {
      this._renderBorder();
    }
  }

  clearBorderOverride(key: string): void {
    this._borderOverrides.delete(key);
    if (this.isConnected) {
      this._renderBorder();
    }
  }

  notifyTablePropertyChange(): void {
    this._notifyTablePropertyChange();
  }

  /**
   * TR/TD 요소에서 border/padding/diagonals 데이터를 직렬화하여 `_rows`를 갱신하고
   * border 레이어만 재렌더링한다. 자식 요소 재생성 없이 TD 속성 변경을
   * border resolver에 반영하기 위해 사용한다.
   */
  refreshBorder(): void {
    if (!this.isConnected) return;
    this._rows = this._serializeChildren();
    this._engine?.layout();
    this._layoutStructure();
    this._renderBorder();
  }

  private _notifyTablePropertyChange(): void {
    const parentBox = this.parentElement;
    if (parentBox instanceof LayoutBoxElement) {
      const editManager = parentBox.editManager;
      editManager?._dispatchBoxPropertyChange({
        element: parentBox,
        property: 'table-grid',
      } as unknown as Parameters<typeof editManager._dispatchBoxPropertyChange>[0]);
    }
  }

  private _renderResizeHandles(): void {
    if (!this._gridResolution) return;
    const editManager = this.editManager;
    if (!editManager?.layoutEditMode) return;
    const grid = this._gridResolution;
    const ppm = this._getPpm();

    if (!this._resizeHandleLayerEl) {
      const layer = document.createElement('div');
      layer.classList.add('table-resize-layer');
      layer.style.position = 'absolute';
      layer.style.top = '0';
      layer.style.left = '0';
      layer.style.width = '100%';
      layer.style.height = '100%';
      layer.style.pointerEvents = 'none';
      layer.style.zIndex = String(Z_INDEX_TABLE_RESIZE);
      layer.style.userSelect = 'none';
      this._shadowRoot.appendChild(layer);
      this._resizeHandleLayerEl = layer;
    }

    if (!this._resizeListenerRegistered) {
      this.addEventListener('pointerdown', this._startTableResize);
      this._resizeListenerRegistered = true;
    }

    for (const h of this._resizeHandleEls) h.remove();
    this._resizeHandleEls = [];

    for (let c = 1; c < grid.colCount; c++) {
      const xMm = grid.colWidths.slice(0, c).reduce((a, b) => a + b, 0);
      const xPx = xMm * ppm;
      const totalHeightPx = grid.rowHeights.reduce((a, b) => a + b, 0) * ppm;
      const handle = document.createElement('div');
      handle.classList.add('table-resize-handle');
      handle.style.position = 'absolute';
      handle.style.left = `${xPx - HIT_WIDTH / 2}px`;
      handle.style.top = '0';
      handle.style.width = `${HIT_WIDTH}px`;
      handle.style.height = `${totalHeightPx}px`;
      handle.style.cursor = 'ew-resize';
      handle.style.pointerEvents = 'auto';
      handle.style.userSelect = 'none';
      handle.setAttribute('data-handle', `v-${c}`);
      this._resizeHandleLayerEl.appendChild(handle);
      this._resizeHandleEls.push(handle);
    }

    for (let r = 1; r < grid.rowCount; r++) {
      const yMm = grid.rowHeights.slice(0, r).reduce((a, b) => a + b, 0);
      const yPx = yMm * ppm;
      const totalWidthPx = grid.colWidths.reduce((a, b) => a + b, 0) * ppm;
      const handle = document.createElement('div');
      handle.classList.add('table-resize-handle');
      handle.style.position = 'absolute';
      handle.style.left = '0';
      handle.style.top = `${yPx - HIT_WIDTH / 2}px`;
      handle.style.width = `${totalWidthPx}px`;
      handle.style.height = `${HIT_WIDTH}px`;
      handle.style.cursor = 'ns-resize';
      handle.style.pointerEvents = 'auto';
      handle.style.userSelect = 'none';
      handle.setAttribute('data-handle', `h-${r}`);
      this._resizeHandleLayerEl.appendChild(handle);
      this._resizeHandleEls.push(handle);
    }
  }

  private _startTableResize = (event: PointerEvent): void => {
    const editManager = this.editManager;
    if (!editManager?.layoutEditMode) return;

    let handleEl: HTMLElement | null = null;
    for (const el of event.composedPath()) {
      if (el instanceof HTMLElement && el.classList.contains('table-resize-handle')) {
        handleEl = el as HTMLElement;
        break;
      }
    }
    if (!handleEl) return;
    if (handleEl.hasAttribute('disabled')) return;
    // 중첩 표 환경에서 composedPath()는 부모 표의 pointerdown 리스너까지
    // 자식 표의 handle을 전달한다. 이 표가 소유한 handle인지 검증하지 않으면
    // 부모 표가 자식 표의 handle을 자신의 것으로 오인하여 잘못된 열/행을
    // 리사이즈하고, 두 표 모두 _resizeState에 진입해 경쟁 상태가 발생한다.
    if (!this._resizeHandleEls.includes(handleEl as HTMLDivElement)) return;

    const handle = handleEl.getAttribute('data-handle')!;

    const grid = this._gridResolution!;
    this._resizeState = {
      isResizing: true,
      handle,
      moved: false,
      startMouseX: event.clientX,
      startMouseY: event.clientY,
      startColWidths: [...this._resolvedColWidths],
      startRowHeights: [...grid.rowHeights],
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      rafId: null,
    };

    event.preventDefault();
    event.stopPropagation();

    document.addEventListener('pointermove', this._onTableResizeMouseMove);
    document.addEventListener('pointerup', this._onTableResizeMouseUp);
    document.addEventListener('keydown', this._onTableResizeKeyDown);
  };

  private _onTableResizeMouseMove = (event: PointerEvent): void => {
    if (!this._resizeState || !this._resizeState.isResizing) return;
    event.preventDefault();
    this._resizeState.lastClientX = event.clientX;
    this._resizeState.lastClientY = event.clientY;

    const dx = event.clientX - this._resizeState.startMouseX;
    const dy = event.clientY - this._resizeState.startMouseY;
    if (!this._resizeState.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      this._resizeState.moved = true;
    }
    if (!this._resizeState.moved) return;
    if (this._resizeState.rafId !== null) return;

    this._resizeState.rafId = requestAnimationFrame(() => {
      if (!this._resizeState) return;
      this._resizeState.rafId = null;
      const ppm = this._getPpm();
      const handle = this._resizeState.handle!;
      if (handle.startsWith('v-')) {
        const col = parseInt(handle.slice(2), 10);
        const deltaMm = (this._resizeState.lastClientX - this._resizeState.startMouseX) / ppm;
        this._applyColumnResize(col, deltaMm);
      } else if (handle.startsWith('h-')) {
        const row = parseInt(handle.slice(2), 10);
        const deltaMm = (this._resizeState.lastClientY - this._resizeState.startMouseY) / ppm;
        this._applyRowResize(row, deltaMm);
      }
    });
  };

  private _applyColumnResize(col: number, deltaMm: number): void {
    if (!this._resizeState) return;
    const state = this._resizeState;
    const leftIdx = col - 1;
    const rightIdx = col;
    const oldLeft = state.startColWidths[leftIdx];
    const oldRight = state.startColWidths[rightIdx];
    const total = oldLeft + oldRight;
    const newLeft = Math.max(MIN_TABLE_COL_WIDTH, Math.min(oldLeft + deltaMm, total - MIN_TABLE_COL_WIDTH));
    const newRight = total - newLeft;
    if (newLeft === oldLeft) return;
    const newColWidths = [...state.startColWidths];
    newColWidths[leftIdx] = newLeft;
    newColWidths[rightIdx] = newRight;
    this._colWidths = newColWidths;
    this.layout();
    void this.render();
    this._notifyTablePropertyChange();
  }

  private _applyRowResize(row: number, deltaMm: number): void {
    if (!this._resizeState) return;
    const state = this._resizeState;
    const topIdx = row - 1;
    const bottomIdx = row;
    const oldTop = state.startRowHeights[topIdx];
    const oldBottom = state.startRowHeights[bottomIdx];
    const total = oldTop + oldBottom;
    const newTop = Math.max(MIN_TABLE_ROW_HEIGHT, Math.min(oldTop + deltaMm, total - MIN_TABLE_ROW_HEIGHT));
    const newBottom = total - newTop;
    if (newTop === oldTop) return;
    this._rows[topIdx].height = newTop;
    this._rows[bottomIdx].height = newBottom;
    this._engine?.layout();
    this.layout();
    void this.render();
    this._notifyTablePropertyChange();
  }

  private _onTableResizeMouseUp = (_event: PointerEvent): void => {
    if (!this._resizeState) return;
    if (this._resizeState.rafId !== null) {
      cancelAnimationFrame(this._resizeState.rafId);
      this._resizeState.rafId = null;
    }
    this._resizeState = null;
    document.removeEventListener('pointermove', this._onTableResizeMouseMove);
    document.removeEventListener('pointerup', this._onTableResizeMouseUp);
    document.removeEventListener('keydown', this._onTableResizeKeyDown);
    if (this._keyboardController?.selection) {
      this._renderSelectionOverlay(this._keyboardController.selection);
    }
  };

  private _onTableResizeKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this._resizeState) return;
    event.preventDefault();
    event.stopPropagation();
    if (this._resizeState.rafId !== null) {
      cancelAnimationFrame(this._resizeState.rafId);
      this._resizeState.rafId = null;
    }
    const state = this._resizeState;
    this._resizeState = null;
    if (state.handle!.startsWith('v-')) {
      this._colWidths = state.startColWidths;
    } else if (state.handle!.startsWith('h-')) {
      for (let i = 0; i < state.startRowHeights.length; i++) {
        const trEl = this.children[i] as LayoutTableRowElement | undefined;
        if (trEl) trEl.height = state.startRowHeights[i];
        this._rows[i].height = state.startRowHeights[i];
      }
    }
    this.layout();
    void this.render();
    document.removeEventListener('pointermove', this._onTableResizeMouseMove);
    document.removeEventListener('pointerup', this._onTableResizeMouseUp);
    document.removeEventListener('keydown', this._onTableResizeKeyDown);
  };

  _activateTableEditing(): void {
    const editManager = this.editManager;
    if (!editManager?.layoutEditMode) return;
    this.layout();
  }

  _deactivateTableEditing(): void {
    if (this._resizeState) {
      this._resizeState = null;
      document.removeEventListener('pointermove', this._onTableResizeMouseMove);
      document.removeEventListener('pointerup', this._onTableResizeMouseUp);
      document.removeEventListener('keydown', this._onTableResizeKeyDown);
    }
    for (const h of this._resizeHandleEls) h.remove();
    this._resizeHandleEls = [];
    if (this._resizeHandleLayerEl) {
      this._resizeHandleLayerEl.remove();
      this._resizeHandleLayerEl = null;
    }
    this.removeEventListener('pointerdown', this._startTableResize);
    this._resizeListenerRegistered = false;
    this.layout();
  }

  private _onTableKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as Node;
    // this.contains(target)는 중첩 표에서 부모 표가 자식 표의 이벤트까지
    // 수신하게 만든다. target이 속한 가장 안쪽 표가 this인지 검증하여
    // 각 표가 자신의 셀 이벤트만 처리하도록 제한한다.
    const inTable = (target instanceof Element && target.closest?.('x-layout-table') === this)
      || target === this;
    const em = this.editManager;
    const hasSelectedBoxInTd = em?.selectedLayouts.some(box => {
      if (!(box instanceof LayoutBoxElement)) return false;
      const td = box.closest('x-layout-td');
      if (!td) return false;
      const owningTable = td.closest('x-layout-table');
      return owningTable === this;
    });
    if (!inTable && !hasSelectedBoxInTd) return;
    if (this._keyboardController) {
      const handled = this._keyboardController.handleKeyDown(event);
      if (handled) {
        event.stopPropagation();
      }
    }
  };

  private _propagateInheritStyle(): void {
    if (!this._inheritStyle) return;
    for (const tr of this.items) {
      tr.inheritStyle = this._inheritStyle;
    }
  }

  _renderSelectionOverlay(selection: { mode: string; anchor: { row: number; col: number }; focus: { row: number; col: number } } | null): void {
    this._clearSelectionOverlay();
    if (!selection || !this._gridResolution) return;

    if (!this._selectionLayerEl) {
      const layer = document.createElement('div');
      layer.style.position = 'absolute';
      layer.style.top = '0';
      layer.style.left = '0';
      layer.style.width = '100%';
      layer.style.height = '100%';
      layer.style.pointerEvents = 'none';
      layer.style.zIndex = String(Z_INDEX_TABLE_SELECTION);
      this._shadowRoot.appendChild(layer);
      this._selectionLayerEl = layer;
    }

    const ppm = this._getPpm();
    const coords = this._getSelectionCoords(selection as { anchor: { row: number; col: number }; focus: { row: number; col: number } });
    const focusCell = (selection as { focus: { row: number; col: number } }).focus;

    for (const coord of coords) {
      const placement = this._findPlacementAt(coord);
      if (!placement) continue;

      const overlay = document.createElement('div');
      overlay.style.position = 'absolute';
      overlay.style.left = `${placement.x * ppm}px`;
      overlay.style.top = `${placement.y * ppm}px`;
      overlay.style.width = `${placement.width * ppm}px`;
      overlay.style.height = `${placement.height * ppm}px`;
      overlay.style.backgroundColor = 'rgba(0, 100, 200, 0.3)';
      overlay.style.pointerEvents = 'none';
      overlay.setAttribute('data-cell', `${coord.row}-${coord.col}`);

      this._selectionLayerEl.appendChild(overlay);
      this._selectionCircleMap.set(`${coord.row}-${coord.col}`, overlay);

      if (selection.mode === 'range' && coord.row === focusCell.row && coord.col === focusCell.col) {
        const dot = document.createElement('div');
        dot.style.position = 'absolute';
        dot.style.left = `${(placement.x + placement.width / 2) * ppm - 5}px`;
        dot.style.top = `${(placement.y + placement.height / 2) * ppm - 5}px`;
        dot.style.width = '10px';
        dot.style.height = '10px';
        dot.style.borderRadius = '50%';
        dot.style.backgroundColor = 'red';
        dot.style.pointerEvents = 'none';
        dot.setAttribute('data-cell-cursor', `${coord.row}-${coord.col}`);
        this._selectionLayerEl.appendChild(dot);
        this._selectionCircleMap.set(`cursor-${coord.row}-${coord.col}`, dot);
      }
    }
  }

  _clearSelectionOverlay(): void {
    for (const [, circle] of this._selectionCircleMap) {
      circle.remove();
    }
    this._selectionCircleMap.clear();
  }

  private _findPlacementAt(coord: { row: number; col: number }): { x: number; y: number; width: number; height: number } | null {
    if (!this._gridResolution) return null;
    for (const p of this._gridResolution.placements) {
      if (coord.row >= p.gridRow && coord.row < p.gridRow + p.spanRows
        && coord.col >= p.gridCol && coord.col < p.gridCol + p.spanCols) {
        return { x: p.x, y: p.y, width: p.width, height: p.height };
      }
    }
    return null;
  }

  private _getSelectionCoords(selection: { anchor: { row: number; col: number }; focus: { row: number; col: number } }): { row: number; col: number }[] {
    const minRow = Math.min(selection.anchor.row, selection.focus.row);
    const maxRow = Math.max(selection.anchor.row, selection.focus.row);
    const minCol = Math.min(selection.anchor.col, selection.focus.col);
    const maxCol = Math.max(selection.anchor.col, selection.focus.col);
    const coords: { row: number; col: number }[] = [];
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        coords.push({ row: r, col: c });
      }
    }
    return coords;
  }

  appendChildData(child: TableRowData): LayoutTableRowElement {
    const trEl = document.createElement('x-layout-tr') as LayoutTableRowElement;
    trEl.data = child;
    this.appendChild(trEl);
    return trEl;
  }

  private _appendChildData(child: TableRowData): void {
    const trEl = document.createElement('x-layout-tr') as LayoutTableRowElement;
    trEl.data = child;
    this.appendChild(trEl);
  }

  private _serializeChildren(): TableRowData[] {
    return this.items.map((e) => e._rawData()).filter((e): e is TableRowData => !!e);
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

  get type(): 'table' { return 'table'; }

  get absLeft(): number {
    const parent = this.parentElement as unknown as { absLeft?: number } | null;
    return parent?.absLeft ?? 0;
  }

  get absTop(): number {
    const parent = this.parentElement as unknown as { absTop?: number } | null;
    return parent?.absTop ?? 0;
  }

  get absWidth(): number {
    const parent = this.parentElement as unknown as { absWidth?: number } | null;
    return parent?.absWidth ?? 0;
  }

  get absHeight(): number {
    const parent = this.parentElement as unknown as { absHeight?: number } | null;
    return parent?.absHeight ?? 0;
  }

  /** 테이블은 부모 box의 zIndex를 따르므로 정렬 시 영향을 주지 않는 0을 반환 */
  get zIndex(): number { return 0; }

  get items(): LayoutTableRowElement[] {
    return Array.from(this.children).filter(
      (c): c is LayoutTableRowElement => c instanceof LayoutTableRowElement,
    );
  }

  get overlayElements(): LayoutBoxElement[] {
    if (!this.parentElement) return [];
    const parent = this.parentElement as unknown as { overlayElements?: LayoutBoxElement[] };
    return parent.overlayElements ?? [];
  }
}

customElements.define('x-layout-table', LayoutTableElement);