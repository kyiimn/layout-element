/**
 * 삽입할 요소의 타입.
 * - `'box'`: 빈 박스 컨테이너
 * - `'text'`: 텍스트 (내부적으로 paragraph로 변환됨)
 * - `'paragraph'`: 단락
 * - `'image'`: 이미지
 * - `'table'`: 표
 */
export type InsertType = 'box' | 'text' | 'paragraph' | 'image' | 'table';

/**
 * 삽입할 요소의 배치 모드.
 * - `'absolute'`: mm 좌표 기반 절대 배치
 * - `'static'`: 컬럼/라인 그리드 기반 배치
 */
export type InsertPosition = 'absolute' | 'static';

/**
 * 삽입 모드 설정.
 * 삽입 모드가 활성화되면 마우스 드래그로 새 요소를 그려서 삽입할 수 있다.
 */
export interface InsertMode {
  /** 삽입할 요소 타입 */
  type: InsertType;
  /** 배치 모드 */
  position: InsertPosition;
  /** 테이블 생성 시 행 수 (type === 'table'일 때만 사용, 기본값 3) */
  tableRows?: number;
  /** 테이블 생성 시 열 수 (type === 'table'일 때만 사용, 기본값 3) */
  tableCols?: number;
  /**
   * 테이블 생성 시 각 셀을 paragraph box로 채울지 여부
   * (type === 'table'일 때만 사용, 기본값 true).
   * false면 빈 셀(children: [])로 생성.
   */
  tableFillCells?: boolean;
}

/**
 * 삽입 완료 이벤트의 상세 정보.
 */
export interface InsertEventDetail {
  /** 삽입된 요소의 타입 */
  type: InsertType;
  /** 삽입된 요소의 배치 모드 */
  position: InsertPosition;
  /** 삽입된 최상위 요소 (항상 box) */
  element: HTMLElement;
  /** 삽입된 요소의 부모 컨테이너 */
  container: HTMLElement;
  /** 삽입 위치 left (static: 컬럼 인덱스, absolute: mm) */
  left: number;
  /** 삽입 위치 top (static: 라인 인덱스, absolute: mm) */
  top: number;
  /** 삽입 크기 width (static: 컬럼 개수, absolute: mm) */
  width: number;
  /** 삽입 크기 height (static: 라인 수, absolute: mm) */
  height: number;
  /** 삽입된 요소의 zIndex */
  zIndex: number;
  /** ESC로 취소되었는지 여부 */
  canceled: boolean;
}