import { TextAlign } from "./paragraph-style.type";

/**
 * `ParagraphData` 내 개별 텍스트 블록에 적용되는 스타일.
 *
 * `TextStyle`의 부분집합 + `textAlign`으로 구성된다.
 * `letterSpacing`, `fontStyle`, `widthRatio`는 포함하지 않는다.
 * 이 속성들은 블록 단위가 아닌 문단 전체 수준에서만 제어된다.
 */
export type TextBlockStyle = {
  /** 폰트 패밀리명 */
  fontFamily?: string;

  /** 글자 크기 (mm) */
  fontSize?: number;

  /** 폰트 굵기 */
  fontWeight?: number;

  /** 글자 색상 */
  color?: string;

  /** 수평 정렬 (블록 단위 오버라이드) */
  textAlign?: TextAlign;
}