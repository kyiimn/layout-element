/**
 * `ParagraphData.content` 배열 내 인라인 런에 적용되는 스타일.
 *
 * `TextStyle`의 부분집합 + `fontStyle`로 구성된다.
 * `textAlign`, `letterSpacing`, `widthRatio`는 포함하지 않는다.
 * 정렬은 문단 전체(`ParagraphStyle.textAlign`)에서만 제어되며,
 * 자간/장평도 문단 전체 수준에서만 제어된다.
 *
 * 색상(`color`)과 폰트 패밀리(`fontFamily`)의 제약은 `TextStyle`과
 * 동일하다 — `color`는 `ColorRegistry`에 등록된 CMYK 색상 이름,
 * `fontFamily`는 `FontLoader`에 등록된 `Font.family` 값만 사용 가능하며,
 * CSS 색상 문자열이나 CSS `font-family` 키워드는 지원하지 않는다.
 * 자세한 내용은 `TextStyle` 문서를 참조.
 *
 * @see TextStyle
 */
export type TextInlineStyle = {
  /**
   * 폰트 패밀리명.
   *
   * `FontLoader`에 등록된 `Font.family` 값만 사용 가능.
   * `FontLoader.getFontFamily()`가 일치하는 등록 폰트를 찾아
   * 실제 `FontFace.family`를 반환한다. 일치하지 않으면 등록된 첫 번째
   * 폰트로 폴백된다.
   */
  fontFamily?: string;

  /** 글자 크기 (mm) */
  fontSize?: number;

  /** 폰트 굵기 */
  fontWeight?: number;

  /** 폰트 스타일 (예: 'normal', 'italic') */
  fontStyle?: 'normal' | 'italic';

  /**
   * 글자 색상.
   *
   * `ColorRegistry`에 등록된 CMYK 색상 이름(`CMYKColorSet`의 키)만
   * 사용 가능. `ColorRegistry.getCSSColor()`가 `#RRGGBB` hex로
   * 변환한다. 등록되지 않은 이름(또는 CSS 색상 문자열)은
   * 기본 색상 hex로 폴백된다.
   */
  color?: string;
}