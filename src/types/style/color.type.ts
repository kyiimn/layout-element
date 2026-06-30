/** RGB 색상값. 각 채널 0-255 범위 */
export type RGBColor = {
  /** Red (0–255) */
  r: number;

  /** Green (0–255) */
  g: number;

  /** Blue (0–255) */
  b: number;
};

/** CMYK 색상값. 인쇄용 색상 표현. 각 채널 0-100 범위 */
export type CMYKColor = {
  /** Cyan (0–100) */
  c: number;

  /** Magenta (0–100) */
  m: number;

  /** Yellow (0–100) */
  y: number;

  /** Key/Black (0–100) */
  k: number;
};

/**
 * 이름으로 CMYK 색상에 접근하기 위한 딕셔너리.
 *
 * `ColorManager.getInstance()`가 `color.json`에서 이 데이터를 로드한 뒤,
 * 각 색상을 RGB로 변환하여 CSS 변수(`--color-{name}`)로 문서에 주입한다.
 *
 * @example
 * // color.json 예시
 * {
 *   "black": { "c": 0, "m": 0, "y": 0, "k": 100 },
 *   "red": { "c": 0, "m": 100, "y": 100, "k": 0 }
 * }
 */
export type CMYKColorSet = { [name: string]: CMYKColor };