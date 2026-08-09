import type { CellPlacement, GridResolution } from "./table-grid-resolver";
import type { CellBorderEdge, TableCellData } from "@/types";

/**
 * 해석된 단일 보더 엣지.
 */
export type ResolvedBorderEdge = {
  /** 엣지 식별 키: "h-{row}-{col}" (수평) | "v-{row}-{col}" (수직) */
  key: string;

  /** 엣지 방향 */
  direction: 'horizontal' | 'vertical';

  /** 시작 X (mm, 테이블 기준) */
  x: number;

  /** 시작 Y (mm, 테이블 기준) */
  y: number;

  /** 엣지 길이 (mm). 수평=너비, 수직=높이 */
  length: number;

  /** 보더 두께 (mm) */
  width: number;

  /** 보더 색상 (ColorRegistry 이름) */
  color: string;

  /** 보더 스타일 */
  style: 'solid' | 'dotted' | 'dashed';
};

/**
 * 보더 해석 결과.
 */
export type BorderResolution = {
  /** 렌더링 대상 엣지들 (중복 제거됨) */
  edges: ResolvedBorderEdge[];

  /** 충돌 경고 */
  warnings: string[];
};

/**
 * `TableCellData`의 방향별 개별 보더 필드에서 `CellBorderEdge`를 조립한다.
 *
 * `width`가 0 이하이거나 `color`가 누락된 경우 `undefined`를 반환하여
 * 해당 방향 보더가 없음을 나타낸다.
 *
 * @param cell - 셀 데이터
 * @param side - 보더 방향
 * @returns 조립된 엣지 선언, 또는 보더가 없으면 `undefined`
 */
function getCellBorderEdge(
  cell: TableCellData,
  side: 'top' | 'right' | 'bottom' | 'left',
): CellBorderEdge | undefined {
  let width: number | undefined;
  let color: string | undefined;
  let style: 'solid' | 'dotted' | 'dashed' | undefined;

  if (side === 'top') {
    width = cell.borderTopWidth;
    color = cell.borderTopColor;
    style = cell.borderTopStyle;
  } else if (side === 'right') {
    width = cell.borderRightWidth;
    color = cell.borderRightColor;
    style = cell.borderRightStyle;
  } else if (side === 'bottom') {
    width = cell.borderBottomWidth;
    color = cell.borderBottomColor;
    style = cell.borderBottomStyle;
  } else {
    width = cell.borderLeftWidth;
    color = cell.borderLeftColor;
    style = cell.borderLeftStyle;
  }

  if (width === undefined || width <= 0 || !color) return undefined;
  return { width, color, style: style ?? 'solid' };
}

function makeVerticalEdge(
  key: string,
  x: number,
  y: number,
  height: number,
  border: CellBorderEdge,
): ResolvedBorderEdge {
  return {
    key,
    direction: 'vertical',
    x,
    y,
    length: height,
    width: border.width,
    color: border.color,
    style: border.style ?? 'solid',
  };
}

function makeHorizontalEdge(
  key: string,
  x: number,
  y: number,
  width: number,
  border: CellBorderEdge,
): ResolvedBorderEdge {
  return {
    key,
    direction: 'horizontal',
    x,
    y,
    length: width,
    width: border.width,
    color: border.color,
    style: border.style ?? 'solid',
  };
}

/**
 * 테이블 셀들의 보더 선언을 해석하여 렌더링 대상 엣지 집합을 생성한다.
 *
 * 공유 규칙:
 * - A.borderRight와 B.borderLeft는 동일 엣지 (인접 셀).
 * - 충돌 시 (양쪽 다 선언하고 값이 다름): 나중 등장 셀 우선.
 * - 직접 주입된 override가 있으면 최우선.
 *
 * 렌더링 규칙 (중복 제거):
 * - 수직 엣지: 각 row의 col=0은 left+right, col≥1은 right만.
 * - 수평 엣지: row=0은 top+bottom, row≥1은 bottom만.
 *
 * @param grid - resolveTableGrid() 결과
 * @param overrides - 직접 주입된 엣지 override (key → CellBorderEdge). 선택.
 * @returns 보더 해석 결과
 */
export function resolveTableBorders(
  grid: GridResolution,
  overrides?: Map<string, CellBorderEdge>,
): BorderResolution {
  const warnings: string[] = [];
  const edgeMap = new Map<string, ResolvedBorderEdge>();

  const cellMap = new Map<string, CellPlacement>();
  for (const p of grid.placements) {
    for (let dr = 0; dr < p.spanRows; dr++) {
      for (let dc = 0; dc < p.spanCols; dc++) {
        cellMap.set(`${p.gridRow + dr}-${p.gridCol + dc}`, p);
      }
    }
  }

  const ov = overrides ?? new Map<string, CellBorderEdge>();

  for (let r = 0; r < grid.rowCount; r++) {
    for (let c = 0; c < grid.colCount; c++) {
      const p = cellMap.get(`${r}-${c}`);
      if (!p) continue;

      if (p.gridRow !== r || p.gridCol !== c) continue;

      const cell = p.cell;

      const leftCol = p.gridCol;
      if (leftCol === 0) {
        const edgeKey = `v-${r}-${leftCol}`;
        let candidate = getCellBorderEdge(cell, 'left');
        if (ov.has(edgeKey)) {
          candidate = ov.get(edgeKey)!;
        }
        if (candidate && candidate.width > 0) {
          const yStart = grid.rowHeights.slice(0, r).reduce((a, b) => a + b, 0);
          const totalHeight = grid.rowHeights
            .slice(r, r + p.spanRows)
            .reduce((a, b) => a + b, 0);
          edgeMap.set(
            edgeKey,
            makeVerticalEdge(edgeKey, p.x, yStart, totalHeight, candidate),
          );
        }
      }

      const rightCol = p.gridCol + p.spanCols;
      {
        const edgeKey = `v-${r}-${rightCol}`;
        let candidate = getCellBorderEdge(cell, 'right');
        if (ov.has(edgeKey)) {
          candidate = ov.get(edgeKey)!;
        }
        const nextP = cellMap.get(`${r}-${rightCol}`);
        if (nextP) {
          const nextLeft = getCellBorderEdge(nextP.cell, 'left');
          if (nextLeft) {
            candidate = nextLeft;
          }
        }
        if (candidate && candidate.width > 0) {
          const yStart = grid.rowHeights.slice(0, r).reduce((a, b) => a + b, 0);
          const totalHeight = grid.rowHeights
            .slice(r, r + p.spanRows)
            .reduce((a, b) => a + b, 0);
          edgeMap.set(
            edgeKey,
            makeVerticalEdge(edgeKey, p.x + p.width, yStart, totalHeight, candidate),
          );
        }
      }

      const topRow = p.gridRow;
      if (topRow === 0) {
        const edgeKey = `h-${topRow}-${c}`;
        let candidate = getCellBorderEdge(cell, 'top');
        if (ov.has(edgeKey)) {
          candidate = ov.get(edgeKey)!;
        }
        if (candidate && candidate.width > 0) {
          const xStart = grid.colWidths.slice(0, c).reduce((a, b) => a + b, 0);
          const totalWidth = grid.colWidths
            .slice(c, c + p.spanCols)
            .reduce((a, b) => a + b, 0);
          edgeMap.set(
            edgeKey,
            makeHorizontalEdge(edgeKey, xStart, p.y, totalWidth, candidate),
          );
        }
      }

      const bottomRow = p.gridRow + p.spanRows;
      {
        const edgeKey = `h-${bottomRow}-${c}`;
        let candidate = getCellBorderEdge(cell, 'bottom');
        if (ov.has(edgeKey)) {
          candidate = ov.get(edgeKey)!;
        }
        const nextP = cellMap.get(`${bottomRow}-${c}`);
        if (nextP) {
          const nextTop = getCellBorderEdge(nextP.cell, 'top');
          if (nextTop) {
            candidate = nextTop;
          }
        }
        if (candidate && candidate.width > 0) {
          const xStart = grid.colWidths.slice(0, c).reduce((a, b) => a + b, 0);
          const totalWidth = grid.colWidths
            .slice(c, c + p.spanCols)
            .reduce((a, b) => a + b, 0);
          edgeMap.set(
            edgeKey,
            makeHorizontalEdge(edgeKey, xStart, p.y + p.height, totalWidth, candidate),
          );
        }
      }
    }
  }

  const renderTargetCols = new Set<number>();
  for (const p of grid.placements) {
    renderTargetCols.add(p.gridCol + p.spanCols);
  }

  const renderTargetRows = new Set<number>();
  for (const p of grid.placements) {
    renderTargetRows.add(p.gridRow + p.spanRows);
  }

  const filteredEdges: ResolvedBorderEdge[] = [];
  for (const [key, edge] of edgeMap) {
    const parts = key.split('-');
    const dir = parts[0];
    const idx = parseInt(parts[1], 10);
    const colIdx = parseInt(parts[2], 10);

    if (dir === 'v') {
      if (colIdx === 0 || renderTargetCols.has(colIdx)) {
        filteredEdges.push(edge);
      }
    } else {
      if (idx === 0 || renderTargetRows.has(idx)) {
        filteredEdges.push(edge);
      }
    }
  }

  return { edges: filteredEdges, warnings };
}