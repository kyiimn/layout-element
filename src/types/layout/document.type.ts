import { ParagraphStyle, TextStyle } from "../style";
import { BoxData } from "./box.type";

/**
 * 문서 전체의 루트 데이터. 용지 크기, 컬럼 그리드, 기본 스타일을 정의한다.
 *
 * 렌더링 파이프라인:
 * 1. `LayoutDocumentElement`가 `data` setter를 통해 이 데이터를 받음
 * 2. `BoxModel.create(this._data)`로 컬럼 좌표(`Rect[]`) 계산
 * 3. `textStyle` + `paragraphStyle`을 합쳐 `InheritStyle` 생성 후 자식에게 전파
 *
 * @example
 * const doc: DocumentData = {
 *   width: 257,    // A4 너비 (mm)
 *   height: 370,   // A4 높이 (mm)
 *   columns: 6,    // 6등분 컬럼
 *   gap: 3,        // 컬럼 간격 3mm
 *   paragraphStyle: { lineGap: 1.2, textAlign: 'justify' },
 *   textStyle: { fontFamily: 'Noto Sans', fontSize: 4, color: '#000' },
 *   children: [/* BoxData 배열 *\/]
 * };
 */
export type DocumentData = {
  /** 용지 너비. 기본값 없음 (필수) */
  width: number;

  /** 용지 높이. 기본값 없음 (필수) */
  height: number;

  /** 상단 여백. 기본값: 0 */
  paddingTop?: number;

  /** 우측 여백. 기본값: 0 */
  paddingRight?: number;

  /** 하단 여백. 기본값: 0 */
  paddingBottom?: number;

  /** 좌측 여백. 기본값: 0 */
  paddingLeft?: number;

  /**
   * 컬럼 그리드 정의.
   * - `number`: 균등 분할 컬럼 개수 (예: 6 → 용지를 6등분)
   * - `number[]`: 각 컬럼의 명시적 너비 (예: [30, 50, 30] → 3개 컬럼, 각각 30mm·50mm·30mm)
   */
  columns: number | number[];

  /**
   * 컬럼 간격.
   * - `number`: 모든 컬럼 간격 동일 (mm)
   * - `number[]`: 각 간격의 명시적 크기. 길이 = `columns - 1`
   */
  gap: number | number[];

  /** 문서 전체 기본 문단 스타일 (필수). 자식 요소에서 오버라이드 가능 */
  paragraphStyle: ParagraphStyle;

  /** 문서 전체 기본 텍스트 스타일 (필수). 자식 요소에서 오버라이드 가능 */
  textStyle: TextStyle;

  /** 최상위 박스 자식들 */
  children?: BoxData[];
};