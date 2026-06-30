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
 * 렌더링 완료 후 인쇄/후처리 시스템으로 전달되는 데이터.
 *
 * 각 요소의 원본 데이터와 렌더링된 위치·크기를 함께 담는다.
 * 제네릭 타입으로 `T`에 `BoxData`, `ImageData`, `ParagraphData` 중 하나가 들어간다.
 *
 * @example
 * const boxPostData: PrintPostData<BoxData> = {
 *   color: { c: 0, m: 0, y: 0, k: 100 },  // 테두리 CMYK 색상
 *   data: boxData,                          // 원본 BoxData
 *   rect: { x: 100, y: 200, width: 300, height: 150 }  // 렌더링된 위치
 * };
 */
export type PrintPostData<T = BoxData | ImageData | ParagraphData> = {
  /** 이 요소에 사용된 CMYK 색상 (인쇄용) */
  color?: CMYKColor;

  /** 원본 레이아웃 데이터 */
  data: T;

  /** 렌더링된 위치·크기 */
  rect: PrintPostDataRect;
};