import type { TableRowData, TableCellData } from "@/types";
import { MIN_TABLE_COL_WIDTH, MIN_TABLE_ROW_HEIGHT } from "@/constants";

/**
 * 셀의 그리드 배치 결과.
 */
export type CellPlacement = {
  /** 원본 셀 데이터 */
  cell: TableCellData;

  /** 셀이 차지하는 시작 그리드 열 인덱스 (0부터) */
  gridCol: number;

  /** 셀이 차지하는 시작 그리드 행 인덱스 (0부터) */
  gridRow: number;

  /** 차지하는 열 개수 (colspan) */
  spanCols: number;

  /** 차지하는 행 개수 (rowspan) */
  spanRows: number;

  /** 셀의 mm 좌표 (테이블 기준) */
  x: number;

  /** 셀의 mm 좌표 (테이블 기준) */
  y: number;

  /** 셀의 mm 너비 */
  width: number;

  /** 셀의 mm 높이 */
  height: number;
};

/**
 * 행 높이 배열.
 */
export type RowHeights = number[];

/**
 * 컬럼 너비 배열.
 */
export type ColWidths = number[];

/**
 * 그리드 해석 결과.
 */
export type GridResolution = {
  /** 각 행의 높이 */
  rowHeights: RowHeights;

  /** 각 컬럼의 너비 */
  colWidths: ColWidths;

  /** 총 그리드 행 수 */
  rowCount: number;

  /** 총 그리드 열 수 */
  colCount: number;

  /** 셀 배치 결과 (TR 순서, TD 순서) */
  placements: CellPlacement[];

  /** 오류/경고 메시지 (빈 배열 = 정상) */
  warnings: string[];
};

/**
 * 셀 너비/높이 배열을 정규화한다.
 *
 * 규칙:
 * 1. 합 = targetSize (테이블 크기를 넘지 않음)
 * 2. 각 셀 >= minSize (최소 크기 보장)
 * 3. 최초 데이터 주입 시: 앞순서 셀의 크기를 우선시, 나머지 조정
 * 4. 최소 크기로도 targetSize 초과 시: 균등하게 축소
 *
 * @param inputs - 원본 셀 크기 배열
 * @param targetSize - 목표 합 (contentWidth 또는 contentHeight)
 * @param minSize - 최소 셀 크기 (MIN_TABLE_COL_WIDTH 또는 MIN_TABLE_ROW_HEIGHT)
 * @returns 정규화된 셀 크기 배열
 *
 * @example
 * // 3개 셀, 합 100mm, 최소 5mm
 * // 원본 [60, 30, 30] → 합 120 > 100
 * // 앞순서 우선: 셀0 = min(60, 100 - 2*5) = 60 → 남은 40
 * //   셀1 = min(30, 40 - 1*5) = 30 → 남은 10
 * //   셀2 = 10 (나머지)
 * // 결과: [60, 30, 10] (합=100)
 */
export function normalizeWidths(
  inputs: number[],
  targetSize: number,
  minSize: number,
): number[] {
  const n = inputs.length;
  if (n === 0) return [];

  const sum = inputs.reduce((a, b) => a + b, 0);

  if (sum === targetSize) {
    const result = inputs.map((v) => Math.max(v, minSize));
    const diff = targetSize - result.reduce((a, b) => a + b, 0);
    result[n - 1] += diff;
    return result;
  }

  if (sum < targetSize) {
    const result = inputs.map((v) => Math.max(v, minSize));
    const diff = targetSize - result.reduce((a, b) => a + b, 0);
    result[n - 1] += diff;
    return result;
  }

  const result = new Array<number>(n).fill(0);
  let remaining = targetSize;

  for (let i = 0; i < n - 1; i++) {
    const remainingCount = n - i - 1;
    const maxForThis = remaining - remainingCount * minSize;
    result[i] = Math.max(minSize, Math.min(inputs[i], maxForThis));
    remaining -= result[i];
  }

  result[n - 1] = Math.max(minSize, remaining);

  if (result.every((v) => v === minSize) && result.reduce((a, b) => a + b, 0) > targetSize) {
    const scale = targetSize / (n * minSize);
    for (let i = 0; i < n; i++) {
      result[i] = Math.max(minSize, result[i] * scale);
    }
  }

  return result;
}

/**
 * 테이블 그리드를 해석하여 각 셀의 배치와 mm 좌표를 계산한다.
 *
 * 알고리즘 (HTML table placement와 동일):
 * 1. rows 배열에서 각 행의 height를 읽어 rowHeights 구성.
 * 2. colWidths 정규화 (normalizeWidths 호출).
 * 3. 컬럼 수 확정 후 점유 배열 생성 (boolean[][]).
 * 4. 각 행을 순서대로 순회하며 셀 배치.
 * 5. 경고 검사.
 *
 * @param rows - 행 데이터 배열 (TableRowData[])
 * @param contentWidth - 부모 box의 콘텐츠 폭 (mm). colWidths 정규화 기준.
 * @param contentHeight - 부모 box의 콘텐츠 높이 (mm). rowHeights 정규화 기준.
 * @param colWidthsInput - 사용자 지정 colWidths (number | number[] | undefined)
 * @returns 그리드 해석 결과
 *
 * @example
 * const result = resolveTableGrid(
 *   [{ type: 'tr', height: 10, children: [
 *     { type: 'td', colspan: 2, children: [...] },
 *     { type: 'td', children: [...] },
 *   ]}],
 *   100, // contentWidth mm
 *   80,  // contentHeight mm
 *   [60, 40], // colWidths
 * );
 */
export function resolveTableGrid(
  rows: TableRowData[],
  contentWidth: number,
  contentHeight: number,
  colWidthsInput: number | number[] | undefined,
): GridResolution {
  const warnings: string[] = [];

  const rawRowHeights = rows.map((r) => r.height);
  const rowSum = rawRowHeights.reduce((a, b) => a + b, 0);
  let rowHeights: number[];
  if (rowSum > contentHeight) {
    rowHeights = normalizeWidths(rawRowHeights, contentHeight, MIN_TABLE_ROW_HEIGHT);
  } else {
    rowHeights = normalizeWidths(rawRowHeights, contentHeight, MIN_TABLE_ROW_HEIGHT);
  }

  const maxCellsInRow = rows.length > 0
    ? Math.max(...rows.map((r) => r.children.length))
    : 0;

  let colCount: number;
  if (Array.isArray(colWidthsInput)) {
    colCount = colWidthsInput.length;
  } else if (typeof colWidthsInput === 'number') {
    colCount = maxCellsInRow;
  } else {
    colCount = maxCellsInRow;
  }

  if (colCount === 0) colCount = 1;

  let colWidths: number[];
  if (Array.isArray(colWidthsInput)) {
    colWidths = normalizeWidths(colWidthsInput, contentWidth, MIN_TABLE_COL_WIDTH);
  } else if (typeof colWidthsInput === 'number') {
    const uniform = new Array<number>(colCount).fill(colWidthsInput);
    colWidths = normalizeWidths(uniform, contentWidth, MIN_TABLE_COL_WIDTH);
  } else {
    const eachWidth = contentWidth / colCount;
    colWidths = new Array<number>(colCount).fill(eachWidth);
  }

  const rowCount = rows.length;
  const occupied: boolean[][] = Array.from(
    { length: rowCount },
    () => new Array<boolean>(colCount).fill(false),
  );

  const placements: CellPlacement[] = [];

  for (let r = 0; r < rowCount; r++) {
    let gridCol = 0;
    for (const cell of rows[r].children) {
      while (gridCol < colCount && occupied[r][gridCol]) {
        gridCol++;
      }

      if (gridCol >= colCount) {
        warnings.push(`Row ${r}: 빈 슬롯 없음, 셀 스킵`);
        continue;
      }

      const spanCols = cell.colspan ?? 1;
      const spanRows = cell.rowspan ?? 1;

      let actualSpanCols = spanCols;
      let actualSpanRows = spanRows;

      if (gridCol + actualSpanCols > colCount) {
        warnings.push(
          `Row ${r}: colspan ${actualSpanCols}이 그리드 범위 초과, ${colCount - gridCol}로 clamp`,
        );
        actualSpanCols = colCount - gridCol;
      }

      if (r + actualSpanRows > rowCount) {
        warnings.push(
          `Row ${r}: rowspan ${actualSpanRows}이 그리드 범위 초과, ${rowCount - r}로 clamp`,
        );
        actualSpanRows = rowCount - r;
      }

      for (let dr = 0; dr < actualSpanRows; dr++) {
        for (let dc = 0; dc < actualSpanCols; dc++) {
          occupied[r + dr][gridCol + dc] = true;
        }
      }

      const x = colWidths.slice(0, gridCol).reduce((a, b) => a + b, 0);
      const y = rowHeights.slice(0, r).reduce((a, b) => a + b, 0);
      const width = colWidths.slice(gridCol, gridCol + actualSpanCols).reduce((a, b) => a + b, 0);
      const height = rowHeights.slice(r, r + actualSpanRows).reduce((a, b) => a + b, 0);

      placements.push({
        cell,
        gridCol,
        gridRow: r,
        spanCols: actualSpanCols,
        spanRows: actualSpanRows,
        x,
        y,
        width,
        height,
      });

      gridCol += actualSpanCols;
    }
  }

  const colWidthsSum = colWidths.reduce((a, b) => a + b, 0);
  if (Math.abs(colWidthsSum - contentWidth) > 0.01) {
    warnings.push(
      `colWidths 합(${colWidthsSum.toFixed(2)})이 콘텐츠 폭(${contentWidth.toFixed(2)})과 불일치`,
    );
  }

  const rowHeightsSum = rowHeights.reduce((a, b) => a + b, 0);
  if (Math.abs(rowHeightsSum - contentHeight) > 0.01) {
    warnings.push(
      `rowHeights 합(${rowHeightsSum.toFixed(2)})이 콘텐츠 높이(${contentHeight.toFixed(2)})과 불일치`,
    );
  }

  return {
    rowHeights,
    colWidths,
    rowCount,
    colCount,
    placements,
    warnings,
  };
}