import { ImageData } from "./image.type";
import { ParagraphData } from "./paragraph.type";
import { TextData } from "./text.type";

/**
 * 박스 배치 모드.
 * - `'static'`: 컬럼 그리드 기반 배치. `left`는 컬럼 인덱스(0부터), `width`는 컬럼 개수(span)를 의미.
 * - `'absolute'`: mm 좌표 기반 절대 배치. `left`와 `width`가 실제 mm 단위 좌표/크기.
 */
export type BoxPosition = 'static' | 'absolute';

/**
 * 박스 테두리 스타일. CSS `border-style`과 동일.
 */
export type BoxBorderStyle = 'solid' | 'dotted' | 'dashed';

/**
 * 박스의 의미적 역할.
 * - `'group-article'`: 기사 그룹 컨테이너
 * - `'body'`: 본문 영역
 * - `'image'`: 이미지 영역
 * - `'title'`: 제목 영역
 * - `'caption'`: 캡션 영역
 * - `'group-image'`: 이미지 그룹 컨테이너
 * - `'header'`: 면머리 그룹 컨테이너
 * - `'ad'`: 광고 이미지 영역
 * - `'byline'`: 기자정보 영역. paragraph를 가진 박스에 설정하여 기자정보를 표시한다.
 * - `'none'`: 역할 미지정 (기본값)
 */
export type BoxRole = 'group-article' | 'body' | 'image' | 'title' | 'caption' | 'group-image' | 'header' | 'ad' | 'byline' | 'none';

/**
 * 위치 지정 가능한 컨테이너 데이터.
 *
 * `position` 값에 따라 `left`/`width`의 의미가 달라진다:
 * - `'static'` (기본값): `left`는 컬럼 인덱스, `width`는 차지할 컬럼 개수
 * - `'absolute'`: `left`는 mm 좌표, `width`는 실제 너비(mm)
 *
 * `GridCalculator.create()`가 static 모드의 컬럼 기반 좌표를 실제 mm 좌표(`Rect`)로 변환한다.
 *
 * @example
 * // static 모드: 부모 그리드의 2번째 컬럼부터 3개 컬럼 차지
 * { left: 1, width: 3, position: 'static' }
 *
 * @example
 * // absolute 모드: 부모 기준 (10mm, 20mm) 위치에 50mm×30mm 박스
 * { left: 10, top: 20, width: 50, height: 30, position: 'absolute' }
 */
export type BoxData = {
  /** 타입 식별자 (리터럴) */
  type: 'box';

  /** 고유 식별자 (선택) */
  id?: string;

  /**
   * 좌측 위치.
   * - `position: 'static'`: 컬럼 인덱스 (0부터)
   * - `position: 'absolute'`: mm 좌표
   * @unit mm (static 모드에서는 컬럼 인덱스)
   */
  left: number;

  /**
   * 상단 위치.
   * @unit mm
   */
  top: number;

  /**
   * 너비.
   * - `position: 'static'`: 차지할 컬럼 개수 (span)
   * - `position: 'absolute'`: 실제 너비
   * @unit mm (static 모드에서는 컬럼 개수)
   */
  width: number;

  /**
   * 높이.
   * - `position: 'static'`: 줄 수 (lineHeight 배수로 변환됨)
   * - `position: 'absolute'`: 실제 높이
   * @unit mm (static 모드에서는 줄 수)
   */
  height: number;

  /** 배치 모드. 기본값: `'static'` */
  position?: BoxPosition;

  /** 렌더링 순서 (z-index). 높을수록 위에 표시됨 */
  zIndex?: number;

  /** 배경색 (CSS 색상 문자열 또는 CMYK 색상 이름) */
  backgroundColor?: string;

  /** 상단 테두리 두께 */
  borderTopWidth?: number;

  /** 우측 테두리 두께 */
  borderRightWidth?: number;

  /** 하단 테두리 두께 */
  borderBottomWidth?: number;

  /** 좌측 테두리 두께 */
  borderLeftWidth?: number;

  /** 테두리 색상 (CSS 색상 문자열 또는 CMYK 색상 이름) */
  borderColor?: string;

  /** 테두리 스타일. 기본값: `'solid'` */
  borderStyle?: BoxBorderStyle;

  /** 내부 상단 여백 */
  paddingTop?: number;

  /** 내부 우측 여백 */
  paddingRight?: number;

  /** 내부 하단 여백 */
  paddingBottom?: number;

  /** 내부 좌측 여백 */
  paddingLeft?: number;

  /** 박스의 의미적 역할 (예: 기사 그룹, 본문, 이미지) */
  role?: BoxRole;

  /**
   * 박스가 담고 있는 콘텐츠의 외부 식별자(UID).
   * 렌더링/레이아웃에 영향을 주지 않는 단순 메타정보이며 `role`과 동일하게 취급된다.
   * `data` setter/`attributeChangedCallback`을 통해 `content-uid` DOM 속성과 동기화된다.
   */
  contentUid?: string;

  /** 그룹 멤버 ID 목록. 쉼표로 구분된 문자열로 직렬화됨 (요소의 JS getter/setter는 string[]로 동작) */
  groupMember?: string;

  /** 정렬 우선순위 (높을수록 중요). 렌더링 및 레이아웃 배치 시 참조 */
  priority?: number;

  /**
   * 편집 잠금 여부. `true`이면 box 자체와 내부의 모든 자식 요소가
   * 편집(레이아웃 드래그/리사이즈, 텍스트 편집, 요소 삽입)에서 제외된다.
   * 조상 box 중 하나라도 lock이면 하위 요소 전부에 적용된다.
   */
  lock?: boolean;

  /** 자식 요소들. 복수의 중첩 박스이거나 단일 컨텐츠(문단, 텍스트, 이미지)이다. */
  children?: BoxData[] | ParagraphData | TextData | ImageData;
};