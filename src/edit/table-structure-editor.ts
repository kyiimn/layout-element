import type { LayoutTableElement } from "@/components/layout/table.element";
import type { TableCellSelection, CellCoord } from "@/types";
import type { TableData, TableRowData, TableCellData, BoxData } from "@/types";
import type { EditManager } from "./edit-manager";
import { MIN_TABLE_COL_WIDTH, MIN_TABLE_ROW_HEIGHT } from "@/constants";
import { normalizeWidths } from "@/engine";

export class TableStructureEditor {
  private _tableEl: LayoutTableElement;
  private _editManager: EditManager;

  constructor(tableEl: LayoutTableElement, editManager: EditManager) {
    this._tableEl = tableEl;
    this._editManager = editManager;
    void this._editManager;
  }

  mergeCells(selection: TableCellSelection): void {
    if (!selection || selection.mode === 'single') return;
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    const coords = this._getSelectionCoords(selection);
    if (coords.length < 2) return;

    const minRow = Math.min(...coords.map(c => c.row));
    const maxRow = Math.max(...coords.map(c => c.row));
    const minCol = Math.min(...coords.map(c => c.col));
    const maxCol = Math.max(...coords.map(c => c.col));
    const spanRows = maxRow - minRow + 1;
    const spanCols = maxCol - minCol + 1;

    const currentData = this._tableEl.data;
    const newRows = (currentData.children ?? []).map(tr => ({
      ...tr,
      children: tr.children.map(td => ({ ...td, children: [...td.children] })),
    }));

    for (const coord of coords) {
      const phys = this._getPhysicalCell(coord, newRows);
      if (!phys) continue;
      const td = newRows[phys.trIndex].children[phys.tdIndex];
      const cs = td.colspan ?? 1;
      const rs = td.rowspan ?? 1;
      if (cs > 1 || rs > 1) {
        const cellMinRow = phys.trIndex;
        const cellMaxRow = phys.trIndex + rs - 1;
        const cellMinCol = phys.logicalCol;
        const cellMaxCol = phys.logicalCol + cs - 1;
        if (cellMinRow < minRow || cellMaxRow > maxRow || cellMinCol < minCol || cellMaxCol > maxCol) {
          return;
        }
      }
    }

    const removeSet = new Set<string>();
    for (const coord of coords) {
      if (coord.row === minRow && coord.col === minCol) continue;
      const phys = this._getPhysicalCell(coord, newRows);
      if (!phys) continue;
      removeSet.add(`${phys.trIndex}-${phys.tdIndex}`);
    }

    const mergePhys = this._getPhysicalCell({ row: minRow, col: minCol }, newRows);
    if (!mergePhys) return;
    const mergeTd = newRows[mergePhys.trIndex].children[mergePhys.tdIndex];
    mergeTd.colspan = spanCols;
    mergeTd.rowspan = spanRows;

    for (let r = 0; r < newRows.length; r++) {
      const tdIndicesToRemove: number[] = [];
      for (let c = 0; c < newRows[r].children.length; c++) {
        if (removeSet.has(`${r}-${c}`)) tdIndicesToRemove.push(c);
      }
      for (const idx of tdIndicesToRemove.reverse()) {
        newRows[r].children.splice(idx, 1);
      }
    }

    const result: TableData = { ...currentData, children: newRows };

    this._applyNewData(result);
  }

  unmergeCell(cellCoord: CellCoord): void {
    const currentData = this._tableEl.data;
    const newRows = (currentData.children ?? []).map(tr => ({
      ...tr,
      children: tr.children.map(td => ({ ...td, children: [...td.children] })),
    }));

    const phys = this._getPhysicalCell(cellCoord, newRows);
    if (!phys) return;

    const originalTd = newRows[phys.trIndex].children[phys.tdIndex];
    const spanCols = originalTd.colspan ?? 1;
    const spanRows = originalTd.rowspan ?? 1;
    if (spanCols === 1 && spanRows === 1) return;

    const newCellsGrid: TableCellData[][] = [];
    for (let r = 0; r < spanRows; r++) {
      const row: TableCellData[] = [];
      for (let c = 0; c < spanCols; c++) {
        if (r === 0 && c === 0) {
          row.push({
            ...originalTd,
            colspan: 1,
            rowspan: 1,
            children: [...originalTd.children],
          });
        } else {
          row.push(this._createEmptyCell());
        }
      }
      newCellsGrid.push(row);
    }

    newRows[phys.trIndex].children.splice(phys.tdIndex, 1);

    for (let r = 0; r < spanRows; r++) {
      const targetRowIndex = phys.trIndex + r;
      if (targetRowIndex >= newRows.length) continue;
      if (r === 0) {
        newRows[targetRowIndex].children.splice(phys.tdIndex, 0, ...newCellsGrid[r]);
      } else {
        newRows[targetRowIndex].children.splice(Math.max(0, phys.tdIndex), 0, ...newCellsGrid[r]);
      }
    }

    this._applyNewData({ ...currentData, children: newRows });
  }

  equalizeWidth(selection: TableCellSelection): void {
    const grid = this._tableEl.gridResolution;
    if (!grid || !selection) return;
    const minCol = Math.min(selection.anchor.col, selection.focus.col);
    const maxCol = Math.max(selection.anchor.col, selection.focus.col);
    const totalWidth = grid.colWidths.slice(minCol, maxCol + 1).reduce((a, b) => a + b, 0);
    const count = maxCol - minCol + 1;
    const each = totalWidth / count;
    const newColWidths = [...grid.colWidths];
    for (let c = minCol; c <= maxCol; c++) {
      newColWidths[c] = each;
    }
    this._tableEl.colWidths = newColWidths;
    this._tableEl.notifyTablePropertyChange();
  }

  equalizeHeight(selection: TableCellSelection): void {
    const grid = this._tableEl.gridResolution;
    if (!grid || !selection) return;
    const minRow = Math.min(selection.anchor.row, selection.focus.row);
    const maxRow = Math.max(selection.anchor.row, selection.focus.row);
    const totalHeight = grid.rowHeights.slice(minRow, maxRow + 1).reduce((a, b) => a + b, 0);
    const count = maxRow - minRow + 1;
    const each = totalHeight / count;
    const rows = this._tableEl.rows;
    for (let r = minRow; r <= maxRow && r < rows.length; r++) {
      rows[r].height = each;
      const trEl = this._tableEl.items[r];
      if (trEl) trEl.height = each;
    }
    this._tableEl.layout();
    void this._tableEl.render();
    this._tableEl.notifyTablePropertyChange();
  }

  insertColRight(): void {
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    const focusCol = this._getFocusCol();
    this._insertCol(focusCol + 1, true);
  }

  insertColLeft(): void {
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    const focusCol = this._getFocusCol();
    this._insertCol(focusCol, false);
  }

  private _insertCol(insertIndex: number, isRight: boolean): void {
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    const currentData = this._tableEl.data;
    const focusCol = this._getFocusCol();
    const sourceColWidth = grid.colWidths[focusCol] ?? MIN_TABLE_COL_WIDTH;
    const halfWidth = sourceColWidth / 2;

    const allWidths = [...grid.colWidths];
    allWidths[focusCol] = halfWidth;
    allWidths.splice(insertIndex, 0, halfWidth);
    const totalWidth = allWidths.reduce((a, b) => a + b, 0);
    const normalizedWidths = normalizeWidths(allWidths, totalWidth, MIN_TABLE_COL_WIDTH);

    const newRows = (currentData.children ?? []).map(tr => ({
      ...tr,
      children: tr.children.map(td => ({ ...td, children: [...td.children] })),
    }));

    const colspanCovered: boolean[][] = [];
    for (const _tr of (currentData.children ?? [])) {
      colspanCovered.push(new Array(grid.colCount).fill(false));
    }
    for (let r = 0; r < (currentData.children ?? []).length; r++) {
      let logicalCol = 0;
      for (const td of currentData.children?.[r]?.children ?? []) {
        const cs = td.colspan ?? 1;
        const rs = td.rowspan ?? 1;
        while (logicalCol < grid.colCount && colspanCovered[r][logicalCol]) logicalCol++;
        for (let dr = 1; dr < rs; dr++) {
          for (let dc = 0; dc < cs; dc++) {
            if (r + dr < colspanCovered.length && logicalCol + dc < grid.colCount) {
              colspanCovered[r + dr][logicalCol + dc] = true;
            }
          }
        }
        logicalCol += cs;
      }
    }

    for (let r = 0; r < newRows.length; r++) {
      let logicalCol = 0;
      const tdInsert: { idx: number; refIdx: number }[] = [];
      for (let c = 0; c < newRows[r].children.length; c++) {
        const td = newRows[r].children[c];
        const cs = td.colspan ?? 1;
        while (logicalCol < grid.colCount && colspanCovered[r][logicalCol]) logicalCol++;
        if (logicalCol <= focusCol && logicalCol + cs > focusCol) {
          const isStart = logicalCol === focusCol;
          const isEnd = logicalCol + cs - 1 === focusCol;
          if (isRight) {
            if (isEnd) {
              tdInsert.push({ idx: c + 1, refIdx: c });
            } else {
              td.colspan = cs + 1;
            }
          } else {
            if (isStart) {
              tdInsert.push({ idx: c, refIdx: c });
            } else {
              td.colspan = cs + 1;
            }
          }
        }
        logicalCol += cs;
      }
      for (const { idx, refIdx } of tdInsert.reverse()) {
        const refTd = newRows[r].children[refIdx] ?? newRows[r].children[0];
        if (refTd) {
          newRows[r].children.splice(idx, 0, this._cloneCell(refTd));
        }
      }
    }

    this._applyNewData({ ...currentData, colWidths: normalizedWidths, children: newRows });
  }

  private _cloneCell(refTd: TableCellData): TableCellData {
    return {
      type: 'td',
      colspan: 1,
      rowspan: 1,
      backgroundColor: refTd.backgroundColor,
      backgroundOpacity: refTd.backgroundOpacity,
      paddingTop: refTd.paddingTop,
      paddingRight: refTd.paddingRight,
      paddingBottom: refTd.paddingBottom,
      paddingLeft: refTd.paddingLeft,
      children: [this._createEmptyBox()],
    };
  }

  insertRowBelow(): void {
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    const focusRow = this._getFocusRow();
    this._insertRow(focusRow + 1);
  }

  insertRowAbove(): void {
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    const focusRow = this._getFocusRow();
    this._insertRow(focusRow);
  }

  private _insertRow(insertIndex: number): void {
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    const currentData = this._tableEl.data;
    const focusRow = this._getFocusRow();
    const sourceRow = currentData.children?.[focusRow];
    const sourceHeight = sourceRow?.height ?? grid.rowHeights[focusRow] ?? MIN_TABLE_ROW_HEIGHT;
    const halfHeight = sourceHeight / 2;

    const rowspanCovered: boolean[][] = [];
    for (let r = 0; r < (currentData.children ?? []).length; r++) {
      rowspanCovered.push(new Array(grid.colCount).fill(false));
    }
    for (let r = 0; r < (currentData.children ?? []).length; r++) {
      let logicalCol = 0;
      for (const td of currentData.children?.[r]?.children ?? []) {
        const cs = td.colspan ?? 1;
        const rs = td.rowspan ?? 1;
        while (logicalCol < grid.colCount && rowspanCovered[r][logicalCol]) logicalCol++;
        for (let dr = 1; dr < rs; dr++) {
          for (let dc = 0; dc < cs; dc++) {
            if (r + dr < rowspanCovered.length && logicalCol + dc < grid.colCount) {
              rowspanCovered[r + dr][logicalCol + dc] = true;
            }
          }
        }
        logicalCol += cs;
      }
    }

    const newRows = (currentData.children ?? []).map(tr => ({
      ...tr,
      children: tr.children.map(td => ({ ...td, children: [...td.children] })),
    }));

    const allHeights = [...grid.rowHeights];
    allHeights[focusRow] = halfHeight;
    allHeights.splice(insertIndex, 0, halfHeight);
    const totalHeight = allHeights.reduce((a, b) => a + b, 0);
    const normalizedHeights = normalizeWidths(allHeights, totalHeight, MIN_TABLE_ROW_HEIGHT);

    const insertOccupied = insertIndex < rowspanCovered.length ? rowspanCovered[insertIndex] : new Array(grid.colCount).fill(false);
    const sourceOccupied = focusRow < rowspanCovered.length ? rowspanCovered[focusRow] : new Array(grid.colCount).fill(false);
    const newRow = this._cloneRow(sourceRow, grid.colCount, sourceOccupied, insertOccupied);
    newRow.height = normalizedHeights[insertIndex];
    newRows.splice(insertIndex, 0, newRow);

    for (let r = 0; r < newRows.length; r++) {
      if (r === insertIndex) continue;
      newRows[r].height = normalizedHeights[r];
    }

    for (let r = 0; r < newRows.length; r++) {
      if (r === insertIndex) continue;
      for (const td of newRows[r].children) {
        const rs = td.rowspan ?? 1;
        if (rs > 1 && r < insertIndex && r + rs > insertIndex) {
          td.rowspan = rs + 1;
        }
      }
    }

    this._applyNewData({ ...currentData, children: newRows });
  }

  private _cloneRow(sourceRow: TableRowData | undefined, colCount: number, sourceOccupied: boolean[], insertOccupied: boolean[]): TableRowData {
    const children: TableCellData[] = [];
    if (sourceRow) {
      let logicalCol = 0;
      let srcIdx = 0;
      while (logicalCol < colCount) {
        if (insertOccupied[logicalCol]) {
          logicalCol++;
          continue;
        }
        if (sourceOccupied[logicalCol]) {
          children.push(this._createEmptyCell());
          logicalCol++;
          continue;
        }
        if (srcIdx < sourceRow.children.length) {
          const srcTd = sourceRow.children[srcIdx];
          const cs = srcTd.colspan ?? 1;
          children.push({
            type: 'td',
            colspan: srcTd.colspan,
            rowspan: 1,
            backgroundColor: srcTd.backgroundColor,
            backgroundOpacity: srcTd.backgroundOpacity,
            paddingTop: srcTd.paddingTop,
            paddingRight: srcTd.paddingRight,
            paddingBottom: srcTd.paddingBottom,
            paddingLeft: srcTd.paddingLeft,
            children: [this._createEmptyBox()],
          });
          logicalCol += cs;
          srcIdx++;
        } else {
          children.push(this._createEmptyCell());
          logicalCol++;
        }
      }
    } else {
      for (let i = 0; i < colCount; i++) {
        if (i < insertOccupied.length && insertOccupied[i]) continue;
        children.push(this._createEmptyCell());
      }
    }
    return { type: 'tr', height: MIN_TABLE_ROW_HEIGHT, children };
  }

  private _createEmptyBox(): BoxData {
    return {
      type: 'box',
      left: 0, top: 0,
      width: 1, height: 1,
      position: 'static',
      zIndex: 1,
      children: { type: 'paragraph', content: '' },
    };
  }

  deleteRow(): void {
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    if (grid.rowCount <= 1) return;
    const focusRow = this._getFocusRow();
    this._deleteRow(focusRow);
  }

  deleteCol(): void {
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    if (grid.colCount <= 1) return;
    const focusCol = this._getFocusCol();
    this._deleteCol(focusCol);
  }

  private _deleteRow(rowIndex: number): void {
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    if (grid.rowCount <= 1) return;
    const currentData = this._tableEl.data;
    const newRows = (currentData.children ?? []).map(tr => ({
      ...tr,
      children: tr.children.map(td => ({ ...td, children: [...td.children] })),
    }));

    const occupiedForRow: boolean[] = new Array(grid.colCount).fill(false);
    for (let r = 0; r < rowIndex; r++) {
      let lc = 0;
      for (const td of newRows[r].children) {
        const cs = td.colspan ?? 1;
        const rs = td.rowspan ?? 1;
        while (lc < grid.colCount && occupiedForRow[lc]) lc++;
        for (let dc = 0; dc < cs; dc++) {
          if (r + rs > rowIndex) {
            occupiedForRow[lc + dc] = true;
          }
        }
        lc += cs;
      }
    }

    const movedCells: { td: TableCellData; logicalCol: number }[] = [];
    let logicalCol = 0;
    for (let c = 0; c < newRows[rowIndex].children.length; c++) {
      const td = newRows[rowIndex].children[c];
      const cs = td.colspan ?? 1;
      const rs = td.rowspan ?? 1;
      while (logicalCol < grid.colCount && occupiedForRow[logicalCol]) logicalCol++;
      if (rs > 1 && rowIndex + 1 < newRows.length) {
        movedCells.push({
          td: { ...td, rowspan: rs - 1, children: td.children },
          logicalCol,
        });
      }
      logicalCol += cs;
    }

    const targetOccupied: boolean[] = new Array(grid.colCount).fill(false);
    for (let r = 0; r < rowIndex; r++) {
      let lc = 0;
      for (const td of newRows[r].children) {
        const cs = td.colspan ?? 1;
        const rs = td.rowspan ?? 1;
        while (lc < grid.colCount && targetOccupied[lc]) lc++;
        const newRs = (r + rs > rowIndex) ? rs - 1 : rs;
        if (r + newRs > rowIndex + 1) {
          for (let dc = 0; dc < cs; dc++) {
            targetOccupied[lc + dc] = true;
          }
        }
        lc += cs;
      }
    }

    for (const { td, logicalCol: cellLogicalCol } of movedCells) {
      const targetRow = newRows[rowIndex + 1];
      let insertIdx = 0;
      let accumCol = 0;
      for (let c = 0; c < targetRow.children.length; c++) {
        while (accumCol < grid.colCount && targetOccupied[accumCol]) accumCol++;
        const cs = targetRow.children[c].colspan ?? 1;
        if (accumCol >= cellLogicalCol) break;
        accumCol += cs;
        insertIdx = c + 1;
      }
      targetRow.children.splice(insertIdx, 0, td);
    }

    for (let r = 0; r < rowIndex; r++) {
      for (const td of newRows[r].children) {
        const rs = td.rowspan ?? 1;
        if (rs > 1 && r + rs > rowIndex) {
          td.rowspan = rs - 1;
        }
      }
    }

    newRows.splice(rowIndex, 1);

    const allHeights = newRows.map(tr => tr.height);
    const totalHeight = allHeights.reduce((a, b) => a + b, 0);
    const normalizedHeights = normalizeWidths(allHeights, totalHeight, MIN_TABLE_ROW_HEIGHT);
    newRows.forEach((tr, i) => { tr.height = normalizedHeights[i]; });

    this._applyNewData({ ...currentData, children: newRows });
  }

  private _deleteCol(colIndex: number): void {
    const grid = this._tableEl.gridResolution;
    if (!grid) return;
    if (grid.colCount <= 1) return;
    const currentData = this._tableEl.data;
    const newRows = (currentData.children ?? []).map(tr => ({
      ...tr,
      children: tr.children.map(td => ({ ...td, children: [...td.children] })),
    }));

    for (const tr of newRows) {
      let logicalCol = 0;
      const newChildren: TableCellData[] = [];
      for (const td of tr.children) {
        const cs = td.colspan ?? 1;
        if (logicalCol <= colIndex && logicalCol + cs > colIndex) {
          if (cs > 1) {
            newChildren.push({ ...td, colspan: cs - 1 });
          }
        } else {
          newChildren.push(td);
        }
        logicalCol += cs;
      }
      tr.children = newChildren;
    }

    const newColWidths = grid.colWidths.filter((_, i) => i !== colIndex);

    this._applyNewData({ ...currentData, colWidths: newColWidths, children: newRows });
  }

  /**
   * 구조 편집 결과를 테이블에 반영하고 undo 스냅샷 경계 이벤트를 발행한다.
   *
   * `table.data = newData`는 ID 기반 reconciliation으로 TR을 재구축한다.
   * 병합/분할/행·열 삽입·삭제는 어떤 EditManager 이벤트도 자동 발생시키지
   * 않으므로, 여기서 `notifyTablePropertyChange()`(→ `boxPropertyChange`)를
   * 발행하지 않으면 키보드 단축키(M, Ctrl+Alt+화살표)로 실행한 구조 편집이
   * undo 스택에 수집되지 않는다. 편집 완료 시 1회만 발행한다 (drag 중
   * 매 프레임 발행하는 리사이즈 핸들과 달리 undo 경계가 명확하다).
   *
   * @param newData - 구조 편집이 적용된 새 테이블 데이터
   * @throws 없음 — 데이터 설정 및 이벤트 발행은 예외를 던지지 않는다
   * @returns void
   *
   * @example
   * ```ts
   * editor.mergeCells(selection);
   * // → _applyNewData(...) → notifyTablePropertyChange()
   * // → EditManager 'boxPropertyChange' → LayoutEditor pushSnapshot()
   * ```
   */
  private _applyNewData(newData: TableData): void {
    this._tableEl.data = newData;
    this._tableEl.notifyTablePropertyChange();
  }

  private _getPhysicalCell(coord: CellCoord, rows: TableRowData[]): {
    trIndex: number;
    tdIndex: number;
    logicalCol: number;
  } | null {
    const occupied: boolean[][] = [];
    for (let r = 0; r < rows.length; r++) {
      occupied.push([]);
    }
    for (let r = 0; r < rows.length; r++) {
      let logicalCol = 0;
      for (let c = 0; c < rows[r].children.length; c++) {
        const td = rows[r].children[c];
        const cs = td.colspan ?? 1;
        const rs = td.rowspan ?? 1;
        while (occupied[r][logicalCol]) logicalCol++;
        if (coord.row >= r && coord.row < r + rs && coord.col >= logicalCol && coord.col < logicalCol + cs) {
          return { trIndex: r, tdIndex: c, logicalCol };
        }
        for (let dr = 0; dr < rs; dr++) {
          for (let dc = 0; dc < cs; dc++) {
            if (r + dr < rows.length) occupied[r + dr][logicalCol + dc] = true;
          }
        }
        logicalCol += cs;
      }
    }
    return null;
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

  private _createEmptyCell(): TableCellData {
    return { type: 'td', children: [] };
  }

  private _getFocusRow(): number {
    const kc = (this._tableEl as unknown as { keyboardController?: { selection: TableCellSelection | null } }).keyboardController;
    return kc?.selection?.focus.row ?? 0;
  }

  private _getFocusCol(): number {
    const kc = (this._tableEl as unknown as { keyboardController?: { selection: TableCellSelection | null } }).keyboardController;
    return kc?.selection?.focus.col ?? 0;
  }
}