import type { LayoutTableCellElement } from '@/components/layout/td.element';

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
 *
 * `cellSelectionChange` EditManager 이벤트로 전달되며, 셀 블록의 메타데이터
 * (mode/anchor/focus/selectMode)와 실제 선택된 TD 요소 배열을 포함한다.
 */
export type TableCellSelectionChangeDetail = {
  /** 현재 셀 블록 선택 상태. 해제 시 `null`. */
  selection: TableCellSelection | null;
  /** 선택된 TD 요소 배열. `selection`이 `null`이면 빈 배열. */
  selectedCells: LayoutTableCellElement[];
  /** 변경 발생 원인. 키보드 조작(F5/F7/F8/화살표/ESC) 또는 프로그램 API. */
  source: 'keyboard' | 'programmatic';
};