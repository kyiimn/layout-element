import { BoxData, ImageData, ParagraphData } from "../layout";
import { CMYKColor } from "../style";

/**
 * 렌더링된 요소의 위치와 크기 정보.
 * 인쇄 후처리 시스템에서 요소의 렌더링된 위치를 전달할 때 사용한다.
 */
export type PrintPostDataRect = {
  /** 렌더링된 좌측 위치 (픽셀) */
  x: number;

  /** 렌더링된 상단 위치 (픽셀) */
  y: number;

  /** 렌더링된 너비 (픽셀) */
  width: number;

  /** 렌더링된 높이 (픽셀) */
  height: number;
};

/**
 * 렌더링된 개별 글자의 정보.
 *
 * paragraph의 `printPostData`가 반환하는 `chars` 배열의 각 항목이다.
 * 인쇄 후처리 시스템이 글자별 위치·폰트·장평·색상을 그대로 재현할 수 있도록
 * 렌더링 결과를 픽셀 단위 rect와 computed style 기반 스타일로 제공한다.
 */
export type PrintPostDataChar = {
  /** 글자 (빈 문자열일 수 없음) */
  char: string;

  /** 렌더링된 글자의 위치·크기 (픽셀) */
  rect: PrintPostDataRect;

  /** CSS `font-family` 값 (예: `'Myoungjo'`) */
  fontFamily: string;

  /** 폰트 크기 (px, 예: `'16px'`) */
  fontSize: string;

  /** 폰트 굵기 (예: `'normal'`, `'700'`) */
  fontWeight: string;

  /** 장평 비율. CSS `scale` 값에서 추출 (예: `0.9` = 90% 장평) */
  widthRatio: number;

  /**
   * 글자 색상 (CMYK).
   * `ColorRegistry.colorMap`에서 computed style의 RGB 값을 역추적하여
   * 원본 CMYK 색상을 반환한다.
   */
  color: CMYKColor;
};

/**
 * 렌더링 완료 후 인쇄/후처리 시스템으로 전달되는 데이터.
 *
 * 각 요소의 원본 데이터와 렌더링된 위치·크기를 함께 담는다.
 * 제네릭 타입으로 `T`에 `BoxData`, `ImageData`, `ParagraphData` 중 하나가 들어간다.
 *
 * `data.type` 필드(`'box'` | `'image'` | `'paragraph'`)가 요소 종류 구분자 역할을 한다.
 * 인쇄 후처리 시스템은 이 필드를 기준으로 분기 처리한다.
 *
 * paragraph(`PrintPostData<ParagraphData>`)의 경우 `chars` 배열에 글자별
 * 렌더링 정보가 포함된다. box/image는 `chars`를 사용하지 않는다.
 *
 * @example
 * const boxPostData: PrintPostData<BoxData> = {
 *   color: { c: 0, m: 0, y: 0, k: 255 },  // 테두리 CMYK 색상
 *   data: boxData,                          // 원본 BoxData
 *   rect: { x: 100, y: 200, width: 300, height: 150 }  // 렌더링된 위치
 * };
 */
export type PrintPostData<T = BoxData | ImageData | ParagraphData> = {
  /** 이 요소에 사용된 CMYK 색상 (인쇄용) */
  color?: CMYKColor;

  /** 원본 레이아웃 데이터. `data.type`으로 요소 종류 구분 */
  data: T;

  /** 렌더링된 위치·크기 */
  rect: PrintPostDataRect;

  /**
   * 렌더링된 글자별 정보 배열.
   * `data.type === 'paragraph'`인 경우에만 사용한다.
   * box/image는 이 필드를 생략한다.
   */
  chars?: PrintPostDataChar[];
};