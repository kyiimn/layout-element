import { TextInlineStyle } from "../../style";

/**
 * `ParagraphData.content` 배열 내 스타일 런(run) 데이터.
 *
 * 콘텐츠는 하나의 연속 텍스트 흐름이며, 일반 문자열과 `TextInlineData`를
 * 혼합하여 사용할 수 있다. 일반 문자열은 상속 스타일을 그대로 사용하고,
 * `TextInlineData`는 `textInlineStyle`로 해당 구간만 스타일을 오버라이드한다.
 *
 * 런은 라인/블록 경계와 무관하다. 한 라인이 여러 런을 가로지를 수 있고,
 * 한 런이 여러 라인에 걸쳐 흐를 수 있다.
 *
 * @example
 * const content: (string | TextInlineData)[] = [
 *   "기본 스타일 텍스트 ",
 *   { content: "굵은 텍스트", textInlineStyle: { fontWeight: 700 } },
 *   " 다시 기본 스타일"
 * ];
 */
export type TextInlineData = {
  /** 텍스트 내용 */
  content: string;

  /** 이 런에만 적용되는 스타일 */
  textInlineStyle?: TextInlineStyle;
}