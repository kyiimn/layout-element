import type { BoxData, BoxBorderStyle } from "./box.type";

/**
 * 단일 보더 면(face)의 값.
 *
 * 테이블 그리드 위에 존재하는 독립적인 보더 단위.
 * 셀과 별개로 테이블이 관리하며, 기본값은 `{ width: 0, color: 'black', style: 'solid' }` (그리지 않음)이다.
 *
 * @example
 * // 0.1mm 검은 실선
 * { width: 0.1, color: 'black', style: 'solid' }
 */
export type BorderFace = {
  /** 두께 (mm). 0 = 그리지 않음 */
  readonly width: number;
  /** 색상 (ColorRegistry CMYK 이름) */
  readonly color: string;
  /** 스타일 */
  readonly style: BoxBorderStyle;
};

/**
 * 테이블 전체 보더 면 집합.
 *
 * - `h[line][col]`: 수평 면. `line`은 0~`rowCount` (행 사이 + 외곽). `col`은 0~`colCount-1`.
 *   배열 크기: `(rowCount + 1) × colCount`
 * - `v[row][line]`: 수직 면. `row`는 0~`rowCount-1`. `line`은 0~`colCount` (열 사이 + 외곽).
 *   배열 크기: `rowCount × (colCount + 1)`
 *
 * 3×3 테이블 예시:
 * ```
 *      col0      col1      col2
 *    ┌─────────┬─────────┬─────────┐
 * h0 │ h[0][0] │ h[0][1] │ h[0][2] │  ← 최상단 (3개)
 *    ├─────────┼─────────┼─────────┤
 * h1 │ h[1][0] │ h[1][1] │ h[1][2] │  ← 1-2행 사이
 *    ├─────────┼─────────┼─────────┤
 * h2 │ h[2][0] │ h[2][1] │ h[2][2] │  ← 2-3행 사이
 *    ├─────────┼─────────┼─────────┤
 * h3 │ h[3][0] │ h[3][1] │ h[3][2] │  ← 최하단
 *    └─────────┴─────────┴─────────┘
 *    v[0][0]   v[0][1]   v[0][2]   v[0][3]  ← 1행 (4개)
 *    v[1][0]   v[1][1]   v[1][2]   v[1][3]  ← 2행
 *    v[2][0]   v[2][1]   v[2][2]   v[2][3]  ← 3행
 * ```
 *
 * 생략 시 모든 면이 기본값 `{ width: 0, color: 'black', style: 'solid' }` (그리지 않음)이다.
 */
export type TableBorders = {
  /** 수평 면. `hFaces[line][col]`. `line`: 0~rowCount, `col`: 0~colCount-1 */
  readonly h: BorderFace[][];
  /** 수직 면. `vFaces[row][line]`. `row`: 0~rowCount-1, `line`: 0~colCount */
  readonly v: BorderFace[][];
};

/**
 * 테이블 데이터. box의 콘텐츠 타입(`BoxData.children`에 직접 지정).
 *
 * 테이블 자체의 위치/크기/배경/외곽 테두리는 부모 box가 정의한다.
 * 테이블은 부모 box의 콘텐츠 영역(box width/height - padding)을 가득 채우며,
 * 내부를 colWidths × 행 높이 그리드로 분할한다.
 *
 * 셀 내부 테두리는 `borders`에서 면(face) 단위로 관리한다.
 * 셀 자체는 테두리를 보유하지 않고, 부모 테이블의 면에 대한 getter/setter 프록시 역할만 한다.
 *
 * @example
 * // box 안에 3컬럼 테이블, 모든 외곽 0.1mm 검은 실선
 * const box: BoxData = {
 *   type: 'box', left: 0, top: 0, width: 3, height: 10,
 *   children: {
 *     type: 'table',
 *     colWidths: [40, 30, 30],
 *     borders: {
 *       h: [
 *         [{ width: 0.1, color: 'black', style: 'solid' }, ...],  // h0
 *         [{ width: 0, color: 'black', style: 'solid' }, ...],    // h1 (내부, 안 그림)
 *         ...
 *       ],
 *       v: [
 *         [{ width: 0.1, color: 'black', style: 'solid' }, ...],  // v0
 *         ...
 *       ],
 *     },
 *     children: [
 *       { type: 'tr', height: 5, children: [
 *         { type: 'td', children: [{ type: 'box', ... }] },
 *       ]},
 *     ],
 *   },
 * };
 */
export type TableData = {
  /** 타입 식별자 (리터럴) */
  type: 'table';

  /** 고유 식별자 (선택) */
  id?: string;

  /**
   * 컬럼별 너비(mm).
   * - `number` = 모든 컬럼 동일 너비
   * - `number[]` = 컬럼별 개별 너비. 합이 부모 box 콘텐츠 폭과 일치 권장.
   * - 누락 시 콘텐츠 폭을 컬럼 수로 균등 분할.
   * @unit mm
   */
  colWidths?: number | number[];

  /**
   * 테이블 전체 보더 면 집합.
   * 생략 시 모든 면이 기본값(그리지 않음)이다.
   */
  borders?: TableBorders;

  /** 행 데이터 (자식). 기존 명명 규칙에 따라 `children` 사용 */
  children: TableRowData[];
};

/**
 * 테이블 행 데이터.
 *
 * @example
 * { type: 'tr', height: 10, children: [cell1, cell2, cell3] }
 */
export type TableRowData = {
  /** 타입 식별자 (리터럴) */
  type: 'tr';

  /** 고유 식별자 (선택) */
  id?: string;

  /**
   * 행 높이.
   * @unit mm
   */
  height: number;

  /** 셀 데이터 (자식) */
  children: TableCellData[];
};

/**
 * 테이블 셀 데이터.
 *
 * 각 셀은 box들을 자식으로 가지며(paragraph/image/nested-table은 항상 box로 감싸임),
 * 자체 GridCalculator(columns=1)를 보유하여 cell 내부를 box 배치 컨텍스트로 동작시킨다.
 *
 * 셀 자체는 테두리를 보유하지 않는다. 테두리는 부모 테이블의 `borders` 면에서 관리되며,
 * 셀의 border getter/setter는 부모 테이블 면에 대한 프록시 역할만 한다.
 * 병합 셀의 border getter는 여러 면을 조회하며, 값이 섞여 있으면 `undefined`를 반환한다.
 *
 * @example
 * {
 *   type: 'td',
 *   colspan: 2,
 *   backgroundColor: 'lightgray',
 *   diagonals: ['tl-br'],
 *   children: [{ type: 'box', ... }],
 * }
 */
export type TableCellData = {
  /** 타입 식별자 (리터럴) */
  type: 'td';

  /** 고유 식별자 (선택) */
  id?: string;

  /** 열 병합. 기본 1 */
  colspan?: number;

  /** 행 병합. 기본 1 */
  rowspan?: number;

  /**
   * 배경색. ColorRegistry에 등록된 CMYK 색상 이름 사용.
   * `ColorRegistry.getCSSColor()` 가 `#RRGGBB` hex로 변환.
   */
  backgroundColor?: string;

  /** 배경색 투명도 (0~1). 생략 시 1(불투명) */
  backgroundOpacity?: number;

  /**
   * 대각선. 셀 내부에 그려진다 (보더 공유 대상 아님).
   * - `'tl-br'`: 좌상→우하
   * - `'tr-bl'`: 우상→좌하
   * 복수 지정 가능 (X 표시).
   */
  diagonals?: Array<'tl-br' | 'tr-bl'>;

  /** 대각선 두께. @unit mm. 생략 시 0.1mm */
  diagonalWidth?: number;

  /** 대각선 색상. ColorRegistry CMYK 색상 이름. 생략 시 'black' */
  diagonalColor?: string;

  /** 셀 내부 상단 여백 (mm) */
  paddingTop?: number;

  /** 셀 내부 우측 여백 (mm) */
  paddingRight?: number;

  /** 셀 내부 하단 여백 (mm) */
  paddingBottom?: number;

  /** 셀 내부 좌측 여백 (mm) */
  paddingLeft?: number;

  /** 셀 내용. BoxData[]만 허용 — paragraph/image/table은 항상 box로 감싸임 */
  children: BoxData[];
};