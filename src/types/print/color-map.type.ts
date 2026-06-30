import { CMYKColor, RGBColor } from "../style";

/**
 * RGB와 CMYK 색상 쌍을 나타내는 타입.
 *
 * `ColorManager`가 CMYK → RGB 변환 결과를 캐싱할 때 사용한다.
 * 인쇄 시스템에서 RGB 화면 표시와 CMYK 인쇄 색상을 함께 관리한다.
 */
export type ColorMap = {
  /** RGB 색상값 (화면 표시용) */
  rgb: RGBColor;

  /** 대응하는 CMYK 색상값 (인쇄용) */
  cmyk: CMYKColor;
};