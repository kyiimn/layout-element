/**
 * 글자 수준의 시각 속성을 정의.
 *
 * `color` 필드는 `ColorRegistry`에 등록된 **CMYK 색상 이름**이어야 한다
 * (예: `"black"`, `"red"`). `ColorRegistry.getCSSColor()`가 해당 이름을
 * `#RRGGBB` hex 문자열로 변환하여 렌더링한다.
 * CSS 색상 문자열(`#000`, `rgb(...)`)은 **지원하지 않는다** — 등록되지
 * 않은 이름은 기본 색상 hex로 폴백되어 의도한 색상이 나오지
 * 않는다. 등록 가능한 이름은 `ColorRegistry.init()`으로 주입한
 * `CMYKColorSet`의 키(`CMYKColorSet` 참조)이다.
 *
 * `fontFamily` 필드는 `FontLoader`에 등록된 `Font.family` 값이어야 한다
 * (예: `"Myoungjo"`, `"Noto Sans KR"`). `FontLoader.getFontFamily()`가
 * 등록된 폰트 중 일치하는 `family`를 찾아 실제 `FontFace.family`를
 * 반환한다. 일치하는 폰트가 없으면 등록된 첫 번째 폰트로 폴백된다.
 * CSS `font-family` 문자열(`"serif"`, `"sans-serif"` 등)은 **지원하지
 * 않는다** — 등록된 `Font`의 `family` 값만 사용 가능하다.
 *
 * `widthRatio`는 CSS `transform: scaleX()`로 구현된다.
 * 신문 본문에서 좁은 컬럼에 텍스트를 맞추기 위해 수평 압축할 때 사용한다.
 *
 * `spaceRatio`는 공백 문자의 최소 너비 비율(em 단위)을 설정한다.
 * 공백 문자의 렌더링 너비는 `spaceRatio × fontSizePx`로 제한되며,
 * 기본값은 0.15로 반각 문자보다 좁은 공백을 표현한다.
 *
 * @example
 * // 올바른 사용 — ColorRegistry에 등록된 색상 이름, FontLoader에 등록된 폰트 family
 * const style: TextStyle = {
 *   color: 'black',        // ColorRegistry CMYKColorSet 키
 *   fontFamily: 'Myoungjo', // FontLoader에 등록된 Font.family
 *   fontSize: 4,
 * };
 *
 * @example
 * // 잘못된 사용 — CSS 색상 문자열 / CSS font-family 키워드는 동작하지 않음
 * const bad: TextStyle = {
 *   color: '#000000',        // 미등록 이름 → 기본 색상 hex로 폴백
 *   fontFamily: 'serif',     // 미등록 폰트 → 등록된 첫 폰트로 폴백
 * };
 */
export type TextStyle = {
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
   * 폰트 패밀리명.
   *
   * `FontLoader`에 등록된 `Font.family` 값만 사용 가능.
   * `FontLoader.getFontFamily()`가 일치하는 등록 폰트를 찾아
   * 실제 `FontFace.family`를 반환한다. 일치하지 않으면 등록된 첫 번째
   * 폰트로 폴백된다. CSS `font-family` 키워드(`"serif"` 등)는 사용할 수 없다.
   */
  fontFamily?: string;

  /** 폰트 굵기. 기본값: 400 */
  fontWeight?: number;

  /** 폰트 스타일. 기본값: 'normal' */
  fontStyle?: 'normal' | 'italic';

  /** 글자 크기 (mm). 기본값: 4 */
  fontSize?: number;

  /** 자간 (em 단위). 글자 사이 추가 간격 */
  letterSpacing?: number;

  /** 장평 비율. 1.0 = 100%, 0.8 = 80%로 수평 압축 */
  widthRatio?: number;

  /** 공백 너비 비율 (em 단위). 공백 문자의 최소 렌더링 너비. 기본값: 0.15 */
  spaceRatio?: number;

  /**
   * 문단 첫 줄 들여쓰기 비율 (0.0 ~ 1.0).
   *
   * `fontSize`에 대한 비율로, 각 문단(block)의 첫 줄에만 적용된다.
   * 예: `indent=0.1`, `fontSize=4mm`이면 `4 × 0.1 = 0.4mm`만큼 문단 첫 줄을 오른쪽으로 밀어준다.
   * `0.0`이면 들여쓰기 없음. 기본값: 0
   */
  indent?: number;
};