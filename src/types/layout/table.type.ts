import type { BoxData, BoxBorderStyle } from "./box.type";

/**
 * 테이블 데이터. box의 콘텐츠 타입(`BoxData.children`에 직접 지정).
 *
 * 테이블 자체의 위치/크기/배경/외곽 테두리는 부모 box가 정의한다.
 * 테이블은 부모 box의 콘텐츠 영역(box width/height - padding)을 가득 채우며,
 * 내부를 colWidths × 행 높이 그리드로 분할한다.
 *
 * @example
 * // box 안에 3컬럼 테이블
 * const box: BoxData = {
 *   type: 'box', left: 0, top: 0, width: 3, height: 10,
 *   children: {
 *     type: 'table',
 *     colWidths: [40, 30, 30],
 *     children: [
 *       { type: 'tr', height: 5, children: [
 *         { type: 'td', children: [{ type: 'box', left: 0, top: 0, width: 1, height: 5, children: { type: 'paragraph', content: 'A' } }] },
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
 * 셀 자체의 테두리는 방향별로 선언하며 인접 셀과 공유된다.
 * 실제 테두리 렌더링은 부모 table이 담당하고, 셀은 선언만 보유한다.
 *
 * @example
 * {
 *   type: 'td',
 *   colspan: 2,
 *   borderTopWidth: 1, borderTopColor: 'black', borderTopStyle: 'solid',
 *   borderRightWidth: 1, borderRightColor: 'black', borderRightStyle: 'solid',
 *   borderBottomWidth: 1, borderBottomColor: 'black', borderBottomStyle: 'solid',
 *   borderLeftWidth: 1, borderLeftColor: 'black', borderLeftStyle: 'solid',
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
   * 방향별 테두리 두께/색상/스타일.
   *
   * 인접 셀과 공유됨 — A의 우측 보더와 B의 좌측 보더는 동일 엣지.
   * 테이블 렌더 단계에서 border-collapse 레이어로 한 번만 그려진다.
   * 셀 자체는 테두리를 렌더링하지 않고 선언만 보유한다.
   *
   * 각 방향별로 `width`/`color`/`style`을 독립적으로 지정한다.
   * `width`가 0이거나 `color`가 누락되면 해당 방향 보더는 렌더링하지 않는다.
   *
   * @unit width: mm
   *
   * @example
   * // 모든 방향 0.1mm 검은 실선
   * {
   *   borderTopWidth: 0.1, borderTopColor: 'black', borderTopStyle: 'solid',
   *   borderRightWidth: 0.1, borderRightColor: 'black', borderRightStyle: 'solid',
   *   borderBottomWidth: 0.1, borderBottomColor: 'black', borderBottomStyle: 'solid',
   *   borderLeftWidth: 0.1, borderLeftColor: 'black', borderLeftStyle: 'solid',
   * }
   */
  borderTopWidth?: number;
  borderTopColor?: string;
  borderTopStyle?: BoxBorderStyle;
  borderRightWidth?: number;
  borderRightColor?: string;
  borderRightStyle?: BoxBorderStyle;
  borderBottomWidth?: number;
  borderBottomColor?: string;
  borderBottomStyle?: BoxBorderStyle;
  borderLeftWidth?: number;
  borderLeftColor?: string;
  borderLeftStyle?: BoxBorderStyle;

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

/**
 * 단일 엣지 테두리 선언.
 *
 * `border-resolver`의 override 메커니즘(`resolveTableBorders`의 `overrides` 파라미터,
 * `LayoutTableElement.setBorderOverride`)에서 키 → 엣지 매핑을 위해 사용된다.
 * `TableCellData` 본체에서는 방향별 개별 속성(`borderTopWidth`/`borderTopColor`/...)
 * 로 풀어서 선언하므로 `CellBorderEdge`를 직접 사용하지 않는다.
 *
 * @example
 * { width: 1, color: 'black', style: 'solid' }
 */
export type CellBorderEdge = {
  /** 두께. @unit mm */
  width: number;

  /** 색상 (ColorRegistry CMYK 이름) */
  color: string;

  /** 스타일. 기본 'solid' */
  style?: BoxBorderStyle;
};