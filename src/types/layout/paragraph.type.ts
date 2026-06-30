import { ParagraphStyle, TextStyle } from "../style";
import { TextBlockData } from "./text/text-block.type";

/**
 * 다중 컬럼 텍스트 영역 데이터. 텍스트 래핑, 블록 단위 스타일링을 지원한다.
 *
 * `ParagraphModel.preTextWrap()`이 텍스트를 래핑하여 `TextLineData[]`로 변환하고,
 * `LayoutColumnElement`가 이를 렌더링한다.
 *
 * `content` 필드는 세 가지 형태를 지원:
 * 1. `"단순 문자열"` → 전체에 동일 스타일 적용
 * 2. `["문자열", ...]` → 각 문자열이 하나의 블록
 * 3. `["문자열", TextBlockData, ...]` → 블록별 개별 스타일 가능
 *
 * @example
 * // 단순 문자열
 * { type: 'paragraph', content: "모든 텍스트에 동일한 스타일" }
 *
 * @example
 * // 블록별 스타일
 * {
 *   type: 'paragraph',
 *   content: [
 *     "기본 스타일 텍스트",
 *     { content: "굵은 텍스트", textBlockStyle: { fontWeight: 700 } },
 *     "다시 기본 스타일"
 *   ]
 * }
 */
export type ParagraphData = {
  /** 타입 식별자 (리터럴) */
  type: 'paragraph';

  /** 고유 식별자 */
  id?: string;

  /**
   * 하위 컬럼 그리드 정의. `DocumentData.columns`와 동일 형식.
   * 생략 시 부모의 컬럼 설정을 상속받음.
   */
  column?: number | number[];

  /**
   * 하위 컬럼 간격. `DocumentData.gap`과 동일 형식.
   * 생략 시 부모의 간격 설정을 상속받음.
   */
  gap?: number | number[];

  /**
   * 텍스트 콘텐츠.
   * - `string`: 전체에 동일 스타일 적용
   * - `(string | TextBlockData)[]`: 블록별 개별 스타일 가능
   */
  content: string | (string | TextBlockData)[];

  /** 문단 스타일. 상위 `InheritStyle`의 값을 오버라이드 */
  paragraphStyle?: ParagraphStyle;

  /** 텍스트 스타일. 상위 `InheritStyle`의 값을 오버라이드 */
  textStyle?: TextStyle;

  /** 렌더링 순서 (z-index) */
  zIndex?: number;
}