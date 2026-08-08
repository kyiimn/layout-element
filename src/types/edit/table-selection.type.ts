/**
 * 셀 블록 선택 모드.
 * F5 입력 횟수에 따라 전환.
 */
export type CellBlockMode = 'single' | 'range' | 'all';

/**
 * 셀 그리드 좌표 (row, col). colspan/rowspan을 고려한 논리 좌표.
 */
export type CellCoord = {
  row: number;
  col: number;
};

/**
 * 셀 블록 선택 상태.
 */
export type TableCellSelection = {
  mode: CellBlockMode;
  anchor: CellCoord;
  focus: CellCoord;
  selectMode?: 'cell' | 'row' | 'col';
};

/**
 * 셀 블록 선택 변경 이벤트 페이로드.
 */
export type TableCellSelectionChangeDetail = {
  selection: TableCellSelection | null;
  selectedCells: unknown[];
  source: 'keyboard' | 'programmatic';
};