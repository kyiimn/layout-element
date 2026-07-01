/**
 * 이미지 크롭 영역과 소스를 정의하는 데이터.
 *
 * `<canvas>`를 사용해 크롭된 이미지를 렌더링한다.
 *
 * **주의**: `x`, `y`, `width`, `height`는 mm가 **아니라** 이미지 원본의 **픽셀 좌표**이다.
 * 렌더링 시 `dpi` 값을 사용해 `px → mm` 변환: `mm = px / dpi × 25.4`.
 *
 * `base64Data`가 있으면 URL 대신 인라인 데이터를 사용하며,
 * 인쇄 모드(`window.matchMedia("print")`)에서 주로 활용된다.
 */
export type ImageData = {
  /** 타입 식별자 (리터럴) */
  type: 'image',

  /** 고유 식별자 */
  id?: string;

  /** 크롭 시작 X 좌표 (원본 이미지 내 픽셀) */
  x: number;

  /** 크롭 시작 Y 좌표 (원본 이미지 내 픽셀) */
  y: number;

  /** 크롭 너비 (픽셀) */
  width: number;

  /** 크롭 높이 (픽셀) */
  height: number;

  /** 이미지 해상도. 크롭 영역을 mm로 변환할 때 사용 */
  dpi: number;

  /** 이미지 URL */
  url: string;

  /** 렌더링 순서 (z-index) */
  zIndex?: number;
}