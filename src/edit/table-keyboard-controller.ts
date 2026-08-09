import type { EditManager } from "./edit-manager";
import type { LayoutTableElement } from "@/components/layout/table.element";
import type { LayoutTableCellElement } from "@/components/layout/td.element";
import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import type { TableCellSelection, CellCoord } from "@/types";
import { MIN_TABLE_COL_WIDTH, MIN_TABLE_ROW_HEIGHT, TABLE_KEYBOARD_RESIZE_STEP } from "@/constants";
import type { TableStructureEditor } from "./table-structure-editor";

export class TableKeyboardController {
  private _tableEl: LayoutTableElement;
  private _editManager: EditManager;
  private _selection: TableCellSelection | null = null;
  private _structureEditor: TableStructureEditor;
  private _active: boolean = false;

  constructor(tableEl: LayoutTableElement, editManager: EditManager, structureEditor: TableStructureEditor) {
    this._tableEl = tableEl;
    this._editManager = editManager;
    this._structureEditor = structureEditor;
  }

  activate(): void {
    this._active = true;
  }

  deactivate(): void {
    this._active = false;
    this._selection = null;
  }

  get selection(): TableCellSelection | null {
    return this._selection;
  }

  set selection(value: TableCellSelection | null) {
    this._selection = value;
  }

  /**
   * TD 요소를 전달하여 셀 블록 단일 선택을 설정한다.
   *
   * TD의 cellLabel에서 좌표를 추출하여 selection을 설정하고 overlay를 갱신한다.
   * 다른 테이블의 기존 selection은 해제한다.
   *
   * @param td - 선택할 TD 요소
   * @example
   * const td = tableEl.querySelector('x-layout-td');
   * tableEl.keyboardController.selectCell(td);
   */
  selectCell(td: LayoutTableCellElement): void {
    if (!td.cellLabel) return;
    const coord = this._labelToCoord(td.cellLabel);
    if (!coord) return;

    for (const t of document.querySelectorAll('x-layout-table')) {
      const otherKc = (t as LayoutTableElement).keyboardController;
      if (otherKc && otherKc !== this && otherKc.selection) {
        otherKc.selection = null;
        (t as unknown as { _renderSelectionOverlay: (sel: null) => void })._renderSelectionOverlay(null);
      }
    }

    this._updateSelection({
      mode: 'single',
      anchor: { ...coord },
      focus: { ...coord },
      selectMode: 'cell',
    }, 'programmatic');
  }

  getSelectedCells(): LayoutTableCellElement[] {
    return this._getSelectedCells();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this._active) return false;

    const key = event.key;
    const alt = event.altKey;
    const ctrl = event.ctrlKey;
    const shift = event.shiftKey;

    if (key === 'Tab' && !alt && !ctrl) {
      if (!this._editManager.textEditMode || !this._editManager.focusedParagraph) return false;
      const handled = this.handleTab(shift);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return handled;
    }

    if (key === 'Escape') {
      if (this._selection) {
        this.handleEscape();
        return true;
      }
      return false;
    }

    if (key === 'F5') {
      if (this._editManager.focusedParagraph) return false;
      event.preventDefault();
      event.stopPropagation();
      const current = this._getCurrentCellCoord();
      if (current) this.handleF5(current);
      return true;
    }

    if (key === 'F7') {
      if (this._editManager.focusedParagraph) return false;
      event.preventDefault();
      event.stopPropagation();
      const current = this._getCurrentCellCoord();
      if (current) this.handleF7(current);
      return true;
    }

    if (key === 'F8') {
      if (this._editManager.focusedParagraph) return false;
      event.preventDefault();
      event.stopPropagation();
      const current = this._getCurrentCellCoord();
      if (current) this.handleF8(current);
      return true;
    }

    if (alt && !ctrl && !shift) {
      if (key === 'ArrowLeft') { if (this._selection) { event.preventDefault(); event.stopPropagation(); this.handleAltArrowKey('left'); return true; } }
      if (key === 'ArrowRight') { if (this._selection) { event.preventDefault(); event.stopPropagation(); this.handleAltArrowKey('right'); return true; } }
      if (key === 'ArrowUp') { if (this._selection) { event.preventDefault(); event.stopPropagation(); this.handleAltArrowKey('up'); return true; } }
      if (key === 'ArrowDown') { if (this._selection) { event.preventDefault(); event.stopPropagation(); this.handleAltArrowKey('down'); return true; } }
      return false;
    }

    if (alt && ctrl && !shift && this._selection) {
      if (key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); this.insertRowAbove(); return true; }
      if (key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); this.insertRowBelow(); return true; }
      if (key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); this.insertColLeft(); return true; }
      if (key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); this.insertColRight(); return true; }
      return false;
    }

    if (!this._selection) return false;

    if (!alt && !ctrl && !shift && (this._selection.mode === 'range' || this._selection.mode === 'single')) {
      if (key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); this.handleArrowKey('left'); return true; }
      if (key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); this.handleArrowKey('right'); return true; }
      if (key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); this.handleArrowKey('up'); return true; }
      if (key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); this.handleArrowKey('down'); return true; }
    }

    if (!alt && !ctrl && !shift) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'm') { event.preventDefault(); event.stopPropagation(); this.handleMerge(); return true; }
      if (lowerKey === 'w') { event.preventDefault(); event.stopPropagation(); this.handleEqualizeWidth(); return true; }
      if (lowerKey === 'h') { event.preventDefault(); event.stopPropagation(); this.handleEqualizeHeight(); return true; }
    }

    return false;
  }

  handleF5(currentCell: CellCoord): void {
    const grid = this._tableEl.gridResolution;
    if (!grid || grid.rowCount === 0 || grid.colCount === 0) return;
    const maxRow = grid.rowCount - 1;
    const maxCol = grid.colCount - 1;

    if (!this._selection || this._selection.mode === 'all') {
      if (this._editManager.focusedParagraph) {
        this._editManager.blurParagraph();
      }
      this._updateSelection({
        mode: 'single',
        anchor: { ...currentCell },
        focus: { ...currentCell },
        selectMode: 'cell',
      });
    } else if (this._selection.mode === 'single') {
      this._updateSelection({
        mode: 'range',
        anchor: { ...currentCell },
        focus: { ...currentCell },
        selectMode: 'cell',
      });
    } else if (this._selection.mode === 'range') {
      this._updateSelection({
        mode: 'all',
        anchor: { row: 0, col: 0 },
        focus: { row: maxRow, col: maxCol },
        selectMode: 'cell',
      });
    }
  }

  handleF7(currentCell: CellCoord): void {
    const grid = this._tableEl.gridResolution;
    if (!grid || grid.rowCount === 0 || grid.colCount === 0) return;
    const maxRow = grid.rowCount - 1;
    this._updateSelection({
      mode: 'range',
      anchor: { row: 0, col: currentCell.col },
      focus: { row: maxRow, col: currentCell.col },
      selectMode: 'col',
    });
  }

  handleF8(currentCell: CellCoord): void {
    const grid = this._tableEl.gridResolution;
    if (!grid || grid.rowCount === 0 || grid.colCount === 0) return;
    const maxCol = grid.colCount - 1;
    this._updateSelection({
      mode: 'range',
      anchor: { row: currentCell.row, col: 0 },
      focus: { row: currentCell.row, col: maxCol },
      selectMode: 'row',
    });
  }

  handleArrowKey(direction: 'up' | 'down' | 'left' | 'right'): boolean {
    if (!this._selection || this._selection.mode === 'all') return false;
    const grid = this._tableEl.gridResolution;
    if (!grid) return false;

    if (this._selection.selectMode === 'row' && (direction === 'left' || direction === 'right')) return false;
    if (this._selection.selectMode === 'col' && (direction === 'up' || direction === 'down')) return false;

    const currentCell = this._getCellAt(this._selection.focus);
    if (!currentCell) return false;

    const start = { ...this._selection.focus };
    let focus = { ...start };
    for (let i = 0; i < grid.colCount * grid.rowCount; i++) {
      const prev = { ...focus };
      switch (direction) {
        case 'up': focus.row = Math.max(0, focus.row - 1); break;
        case 'down': focus.row = Math.min(grid.rowCount - 1, focus.row + 1); break;
        case 'left': focus.col = Math.max(0, focus.col - 1); break;
        case 'right': focus.col = Math.min(grid.colCount - 1, focus.col + 1); break;
      }
      if (focus.row === prev.row && focus.col === prev.col) return false;
      const nextCell = this._getCellAt(focus);
      if (nextCell && nextCell !== currentCell) {
        const placement = grid.placements.find(p =>
          focus.row >= p.gridRow && focus.row < p.gridRow + p.spanRows &&
          focus.col >= p.gridCol && focus.col < p.gridCol + p.spanCols
        );
        if (placement) {
          focus = { row: placement.gridRow, col: placement.gridCol };
        }
        break;
      }
    }

    if (focus.row === start.row && focus.col === start.col) return false;

    if (this._selection.mode === 'single') {
      this._updateSelection({
        ...this._selection,
        anchor: focus,
        focus,
      });
    } else {
      this._updateSelection({ ...this._selection, focus });
    }
    return true;
  }

  handleAltArrowKey(direction: 'up' | 'down' | 'left' | 'right'): void {
    if (!this._selection) return;
    const grid = this._tableEl.gridResolution;
    if (!grid) return;

    const focus = this._selection.focus;
    const placement = grid.placements.find(p =>
      focus.row >= p.gridRow && focus.row < p.gridRow + p.spanRows &&
      focus.col >= p.gridCol && focus.col < p.gridCol + p.spanCols
    );
    if (!placement) return;
    const spanCols = placement.spanCols;
    const spanRows = placement.spanRows;
    const rightEdge = focus.col + spanCols - 1;
    const leftEdge = focus.col;
    const bottomEdge = focus.row + spanRows - 1;
    const topEdge = focus.row;

    if (direction === 'right' || direction === 'left') {
      const hasRight = rightEdge + 1 < grid.colCount;
      let primaryCol: number, neighborCol: number, grow: boolean;
      if (direction === 'right' && hasRight) {
        primaryCol = rightEdge; neighborCol = rightEdge + 1; grow = true;
      } else if (direction === 'right') {
        primaryCol = rightEdge; neighborCol = leftEdge - 1; grow = false;
      } else if (direction === 'left' && hasRight) {
        primaryCol = rightEdge; neighborCol = rightEdge + 1; grow = false;
      } else {
        primaryCol = leftEdge; neighborCol = leftEdge - 1; grow = true;
      }
      if (neighborCol < 0 || neighborCol >= grid.colCount) return;

      const primaryWidth = grid.colWidths[primaryCol];
      const neighborWidth = grid.colWidths[neighborCol];
      const total = primaryWidth + neighborWidth;
      const newPrimary = grow
        ? Math.min(primaryWidth + TABLE_KEYBOARD_RESIZE_STEP, total - MIN_TABLE_COL_WIDTH)
        : Math.max(primaryWidth - TABLE_KEYBOARD_RESIZE_STEP, MIN_TABLE_COL_WIDTH);
      if (newPrimary === primaryWidth) return;
      const newNeighbor = total - newPrimary;
      const newColWidths = [...grid.colWidths];
      newColWidths[primaryCol] = newPrimary;
      newColWidths[neighborCol] = newNeighbor;
      this._tableEl.colWidths = newColWidths;
      this._tableEl.notifyTablePropertyChange();
      this._refreshOverlay();
    } else {
      const hasBelow = bottomEdge + 1 < grid.rowCount;
      let primaryRow: number, neighborRow: number, grow: boolean;
      if (direction === 'down' && hasBelow) {
        primaryRow = bottomEdge; neighborRow = bottomEdge + 1; grow = true;
      } else if (direction === 'down') {
        primaryRow = bottomEdge; neighborRow = topEdge - 1; grow = false;
      } else if (direction === 'up' && hasBelow) {
        primaryRow = bottomEdge; neighborRow = bottomEdge + 1; grow = false;
      } else {
        primaryRow = topEdge; neighborRow = topEdge - 1; grow = true;
      }
      if (neighborRow < 0 || neighborRow >= grid.rowCount) return;

      const primaryHeight = grid.rowHeights[primaryRow];
      const neighborHeight = grid.rowHeights[neighborRow];
      const total = primaryHeight + neighborHeight;
      const newPrimary = grow
        ? Math.min(primaryHeight + TABLE_KEYBOARD_RESIZE_STEP, total - MIN_TABLE_ROW_HEIGHT)
        : Math.max(primaryHeight - TABLE_KEYBOARD_RESIZE_STEP, MIN_TABLE_ROW_HEIGHT);
      if (newPrimary === primaryHeight) return;
      const newNeighbor = total - newPrimary;
      this._tableEl.rows[primaryRow].height = newPrimary;
      this._tableEl.rows[neighborRow].height = newNeighbor;
      this._tableEl.layout();
      void this._tableEl.render();
      this._tableEl.notifyTablePropertyChange();
      this._refreshOverlay();
    }
  }

  private _refreshOverlay(): void {
    if (this._selection && this._tableEl) {
      (this._tableEl as unknown as { _renderSelectionOverlay(s: TableCellSelection | null): void })
        ._renderSelectionOverlay(this._selection);
    }
  }

  handleMerge(): void {
    if (!this._selection) return;
    const grid = this._tableEl.gridResolution;
    if (!grid) return;

    const focus = this._selection.focus;
    const placement = grid.placements.find(p =>
      focus.row >= p.gridRow && focus.row < p.gridRow + p.spanRows &&
      focus.col >= p.gridCol && focus.col < p.gridCol + p.spanCols
    );
    if (!placement) return;

    if (placement.spanCols > 1 || placement.spanRows > 1) {
      this._structureEditor.unmergeCell({ row: placement.gridRow, col: placement.gridCol });
      this._updateSelection({
        mode: 'single',
        anchor: { row: placement.gridRow, col: placement.gridCol },
        focus: { row: placement.gridRow, col: placement.gridCol },
        selectMode: 'cell',
      });
    } else if (this._selection.mode !== 'single') {
      const minRow = Math.min(this._selection.anchor.row, this._selection.focus.row);
      const minCol = Math.min(this._selection.anchor.col, this._selection.focus.col);
      this._structureEditor.mergeCells(this._selection);
      this._updateSelection({
        mode: 'single',
        anchor: { row: minRow, col: minCol },
        focus: { row: minRow, col: minCol },
        selectMode: 'cell',
      });
    }
  }

  handleEqualizeWidth(): void {
    if (!this._selection) return;
    this._structureEditor.equalizeWidth(this._selection);
  }

  handleEqualizeHeight(): void {
    if (!this._selection) return;
    this._structureEditor.equalizeHeight(this._selection);
  }

  insertRowBelow(): void {
    if (!this._selection) return;
    this._structureEditor.insertRowBelow();
  }

  insertRowAbove(): void {
    if (!this._selection) return;
    this._structureEditor.insertRowAbove();
  }

  insertColRight(): void {
    if (!this._selection) return;
    this._structureEditor.insertColRight();
  }

  insertColLeft(): void {
    if (!this._selection) return;
    this._structureEditor.insertColLeft();
  }

  deleteRow(): void {
    if (!this._selection) return;
    this._structureEditor.deleteRow();
  }

  deleteCol(): void {
    if (!this._selection) return;
    this._structureEditor.deleteCol();
  }

  handleEscape(): void {
    const cell = this._selection ? this._getCellAt(this._selection.focus) : null;
    this._updateSelection(null);
    if (cell) {
      const box = cell.items[0];
      if (box) {
        this._editManager.selectLayout(box);
        if (this._editManager.textEditMode) {
          const para = box.items.find((c): c is LayoutParagraphElement => c instanceof LayoutParagraphElement);
          if (para && para instanceof LayoutParagraphElement) {
            this._editManager.focusParagraph(para);
          }
        }
      }
    }
  }

  /**
   * Tab/Shift+Tab으로 표 내부 단락 간 포커스 이동.
   *
   * 텍스트 편집 모드에서 포커스된 단락이 표 내부에 있을 때만 동작한다.
   * 셀 순서는 A1 → A2 → A3 → B1 → ... 순(gridRow, gridCol 오름차순)이며,
   * 머지된 셀은 하나의 placement로 취급되어 자연스럽게 건너뛴다.
   * 마지막 셀에서 Tab → 첫 셀로 순환, 첫 셀에서 Shift+Tab → 마지막 셀로 순환.
   *
   * @param shiftKey - true면 역방향(Shift+Tab), false면 순방향(Tab)
   * @returns 포커스 이동 성공 여부. 표 내부 단락이 아니면 false.
   */
  handleTab(shiftKey: boolean): boolean {
    const grid = this._tableEl.gridResolution;
    if (!grid || grid.placements.length === 0) return false;

    const focused = this._editManager.focusedParagraph;
    if (!focused) return false;
    const currentTd = focused.closest('x-layout-td') as LayoutTableCellElement | null;
    if (!currentTd || !currentTd.cellLabel) return false;
    const currentCoord = this._labelToCoord(currentTd.cellLabel);
    if (!currentCoord) return false;

    const sorted = [...grid.placements].sort((a, b) =>
      a.gridRow - b.gridRow || a.gridCol - b.gridCol,
    );

    let currentIdx = -1;
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      if (currentCoord.row >= p.gridRow && currentCoord.row < p.gridRow + p.spanRows
        && currentCoord.col >= p.gridCol && currentCoord.col < p.gridCol + p.spanCols) {
        currentIdx = i;
        break;
      }
    }
    if (currentIdx === -1) return false;

    const nextIdx = shiftKey
      ? (currentIdx - 1 + sorted.length) % sorted.length
      : (currentIdx + 1) % sorted.length;
    const targetPlacement = sorted[nextIdx];
    if (!targetPlacement) return false;

    const targetTd = this._getCellAt({
      row: targetPlacement.gridRow,
      col: targetPlacement.gridCol,
    });
    if (!targetTd) return false;

    const box = targetTd.items[0];
    if (!box) return false;
    const para = box.items.find(
      (c): c is LayoutParagraphElement => c instanceof LayoutParagraphElement,
    );
    if (!para) return false;

    this._editManager.focusParagraph(para);
    return true;
  }

  private _getCurrentCellCoord(): CellCoord | null {
    if (this._selection) return { ...this._selection.focus };
    const grid = this._tableEl.gridResolution;
    if (!grid) return null;

    const focusedParagraph = this._editManager.focusedParagraph;
    if (focusedParagraph) {
      const tdEl = focusedParagraph.closest('x-layout-td') as LayoutTableCellElement | null;
      if (tdEl && tdEl.cellLabel) {
        const coord = this._labelToCoord(tdEl.cellLabel);
        if (coord) return coord;
      }
    }

    const selectedLayouts = this._editManager.selectedLayouts;
    for (const box of selectedLayouts) {
      const tdEl = (box as HTMLElement).closest?.('x-layout-td') as LayoutTableCellElement | null;
      if (tdEl && tdEl.cellLabel) {
        const coord = this._labelToCoord(tdEl.cellLabel);
        if (coord) return coord;
      }
    }

    return { row: 0, col: 0 };
  }

  private _getCellAt(coord: CellCoord): LayoutTableCellElement | null {
    const grid = this._tableEl.gridResolution;
    if (!grid) return null;
    const targetLabel = this._coordToLabel(coord);
    for (const placement of grid.placements) {
      if (coord.row >= placement.gridRow && coord.row < placement.gridRow + placement.spanRows
        && coord.col >= placement.gridCol && coord.col < placement.gridCol + placement.spanCols) {
        const trEl = this._tableEl.items[placement.gridRow];
        if (!trEl) continue;
        const tdEls = trEl.items;
        for (const td of tdEls) {
          if (td.cellLabels.includes(targetLabel)) return td;
        }
        for (const td of tdEls) {
          if (td.cellLabel === targetLabel) return td;
        }
        for (const td of tdEls) {
          const tdData = td.data;
          if (tdData.id && placement.cell.id === tdData.id) return td;
        }
        return tdEls[0] ?? null;
      }
    }
    return null;
  }

  private _coordToLabel(coord: CellCoord): string {
    let label = '';
    let n = coord.row;
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return `${label}${coord.col + 1}`;
  }

  private _labelToCoord(label: string): CellCoord | null {
    const match = label.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    const colStr = match[1];
    const col = parseInt(match[2], 10) - 1;
    let row = 0;
    for (let i = 0; i < colStr.length; i++) {
      row = row * 26 + (colStr.charCodeAt(i) - 64);
    }
    row -= 1;
    return { row, col };
  }

  private _getSelectedCells(): LayoutTableCellElement[] {
    if (!this._selection) return [];
    if (this._selection.mode === 'single') {
      const cell = this._getCellAt(this._selection.focus);
      return cell ? [cell] : [];
    }
    const coords = this._getSelectionCoords(this._selection);
    const cells: LayoutTableCellElement[] = [];
    const seen = new Set<string>();
    for (const coord of coords) {
      const cell = this._getCellAt(coord);
      if (cell && !seen.has(cell.id)) {
        seen.add(cell.id);
        cells.push(cell);
      }
    }
    return cells;
  }

  private _getSelectionCoords(selection: TableCellSelection): CellCoord[] {
    const minRow = Math.min(selection.anchor.row, selection.focus.row);
    const maxRow = Math.max(selection.anchor.row, selection.focus.row);
    const minCol = Math.min(selection.anchor.col, selection.focus.col);
    const maxCol = Math.max(selection.anchor.col, selection.focus.col);
    const coords: CellCoord[] = [];
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        coords.push({ row: r, col: c });
      }
    }
    return coords;
  }

  private _updateSelection(
    selection: TableCellSelection | null,
    source: 'keyboard' | 'programmatic' = 'keyboard',
  ): void {
    this._selection = selection;
    if (this._tableEl) {
      (this._tableEl as unknown as { _renderSelectionOverlay(selection: TableCellSelection | null): void })
        ._renderSelectionOverlay(selection);
    }

    const selectedCells: LayoutTableCellElement[] = selection ? this._getSelectedCells() : [];
    this._editManager._dispatchCellSelectionChange({
      selection,
      selectedCells,
      source,
    });

    if (!selection) {
      this._editManager.clearLayoutSelection(false);
      return;
    }
    if (selection.mode === 'range' || selection.mode === 'all') {
      const boxes = selectedCells.map(c => c.items[0]).filter(Boolean);
      if (boxes.length > 0) {
        this._editManager.selectLayout(boxes);
      }
    } else {
      const cell = this._getCellAt(selection.focus);
      if (cell) {
        const box = cell.items[0];
        if (box) {
          this._editManager.selectLayout(box);
        }
      }
    }
  }
}