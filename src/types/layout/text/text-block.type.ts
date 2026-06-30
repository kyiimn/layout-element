import { TextBlockStyle } from "../../style";

/**
 * `ParagraphData`의 `content` 배열에서 개별 스타일을 가진 텍스트 조각.
 *
 * 일반 문자열과 `TextBlockData`를 혼합하여 사용할 수 있다.
 * 일반 문자열은 상속 스타일을 그대로 사용하고,
 * `TextBlockData`는 `textBlockStyle`로 해당 블록만 스타일을 오버라이드한다.
 *
 * @example
 * const content: (string | TextBlockData)[] = [
 *   "기본 스타일 텍스트",
 *   { content: "굵은 텍스트", textBlockStyle: { fontWeight: 700 } },
 *   "다시 기본 스타일"
 * ];
 */
export type TextBlockData = {
  /** 텍스트 내용 */
  content: string;

  /** 이 블록에만 적용되는 스타일 */
  textBlockStyle?: TextBlockStyle;
}