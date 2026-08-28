/** RGB 색상값. 각 채널 0-255 범위 */
export type RGBColor = {
  /** Red (0–255) */
  r: number;

  /** Green (0–255) */
  g: number;

  /** Blue (0–255) */
  b: number;
};

/** CMYK 색상값. 인쇄용 색상 표현. 각 채널 0-255 범위 */
export type CMYKColor = {
  /** Cyan (0–255) */
  c: number;

  /** Magenta (0–255) */
  m: number;

  /** Yellow (0–255) */
  y: number;

  /** Key/Black (0–255) */
  k: number;
};

/**
 * 이름으로 CMYK 색상에 접근하기 위한 딕셔너리.
 *
 * `ColorRegistry.getInstance()`가 `color.json`에서 이 데이터를 로드하여
 * 내부에 보관하고, `getCSSColor(name)` 호출 시 해당 색상을 RGB로 변환하여
 * `#RRGGBB` hex로 반환한다.
 *
 * 이 딕셔너리의 **키(색상 이름)가 곧 스타일 필드의 색상 값**이다.
 * `TextStyle.color`, `TextInlineStyle.color`, `BoxData.backgroundColor`,
 * `BoxData.borderColor`는 모두 여기에 등록된 키만 사용해야 하며,
 * `ColorRegistry.getCSSColor()`가 키를 `#RRGGBB` hex 문자열로
 * 변환한다. 등록되지 않은 이름이나 CSS 색상 문자열(`#000`, `rgb(...)`)은
 * 기본 색상 hex로 폴백된다.
 *
 * @example
 * // color.json 예시
 * {
 *   "black": { "c": 0, "m": 0, "y": 0, "k": 255 },
 *   "red": { "c": 0, "m": 255, "y": 255, "k": 0 }
 * }
 *
 * @example
 * // 스타일 필드에서는 이 키를 문자열로 참조
 * const textStyle: TextStyle = { color: 'black' };   // ← 'black'은 위 color.json의 키
 * const box: BoxData = { backgroundColor: 'red' };   // ← 'red' 역시 키
 */
export type CMYKColorSet = { [name: string]: CMYKColor };