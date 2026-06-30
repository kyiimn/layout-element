import { ParagraphStyle, TextStyle } from "../style";

/**
 * 단순 텍스트 블록 데이터.
 *
 * `ParagraphData`와 달리 **컬럼 분할이나 텍스트 래핑을 지원하지 않는** 단일 텍스트.
 * 부모 박스 크기에 맞춰 렌더링된다.
 *
 * 내부적으로 `LayoutBoxElement`에서 `ParagraphData`로 변환되어 처리된다
 * (`column: 1, gap: 0`로 래핑).
 */
export type TextData = {
  /** 타입 식별자 (리터럴) */
  type: 'text';

  /** 고유 식별자 */
  id?: string;

  /** 텍스트 내용 (문자열만 가능) */
  content: string;

  /** 문단 스타일 */
  paragraphStyle?: ParagraphStyle;

  /** 텍스트 스타일 */
  textStyle?: TextStyle;
}