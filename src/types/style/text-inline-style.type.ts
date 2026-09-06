/**
 * `ParagraphData.content` 배열 내 인라인 런에 적용되는 스타일.
 *
 * `TextStyle`의 부분집합 + `fontStyle`로 구성된다.
 * `textAlign`은 포함하지 않는다. 정렬은 문단 전체(`ParagraphStyle.textAlign`)에서만 제어된다.
 *
 * 자간(`letterSpacing`), 장평(`widthRatio`), 공백 너비 비율(`spaceRatio`)은
 * **인라인 런 단위로 오버라이드 가능**하다. 미정의 시 문단 effective 값
 * (`TextStyle` → `InheritStyle` → 기본값)을 따른다. 폭 계산(`_charWidthMm`,
 * `charOffsets`)과 렌더링(`genCharStyle*`)은 항상 per-run 값을 소비한다.
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

  /**
   * 자간 (em 단위). 글자 사이 추가 간격.
   *
   * 미정의 시 문단 effective `letterSpacing`을 따른다.
   * 폭 계산 시 `letterSpacing × fontSize`(mm)가 글자 폭에 더해진다.
   */
  letterSpacing?: number;

  /**
   * 장평 비율. 1.0 = 100%, 0.8 = 80%로 수평 압축.
   *
   * 미정의 시 문단 effective `widthRatio`을 따른다.
   * 렌더링은 `scale: ${widthRatio * 0.88} 1`로 글리프를 축소한다.
   */
  widthRatio?: number;

  /**
   * 공백 너비 비율 (em 단위). 공백 문자의 최소 렌더링 너비.
   *
   * 미정의 시 문단 effective `spaceRatio`을 따른다.
   * 공백 폭은 `spaceRatio × fontSize`(mm)로 고정되며 결함 글리프의
   * 최소 폭 바닥값으로도 사용된다.
   */
  spaceRatio?: number;
}