/**
 * 글자 수준의 시각 속성을 정의.
 *
 * `color` 필드는 CSS 색상값(`#000`, `rgb(...)`)과 CMYK 색상 이름(예: `"black"`) 모두 사용 가능.
 * CMYK 이름 사용 시 `ColorManager`가 등록된 `CMYKColorSet`에서 RGB로 변환하여 CSS 변수(`--color-{name}`)로 주입한다.
 *
 * `widthRatio`는 CSS `transform: scaleX()`로 구현된다.
 * 신문 본문에서 좁은 컬럼에 텍스트를 맞추기 위해 수평 압축할 때 사용한다.
 */
export type TextStyle = {
  /** 글자 색상 (CSS 색상 문자열 또는 CMYK 색상 이름) */
  color?: string;

  /** 폰트 패밀리명 */
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
};