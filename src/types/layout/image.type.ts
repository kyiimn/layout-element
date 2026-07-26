/**
 * 이미지 object-fit 동작.
 *
 * - `'cover'`: box 영역을 채우면서 원본 비율 유지. 넘치는 부분은 크롭.
 * - `'fill'`: box 영역에 맞춰 늘림. 비율 무시.
 * - `'contain'`: box 안에 전체 이미지 표시. 여백 발생.
 * - `'none'`: x/y/width/height를 mm 단위 표시 위치와 크기로 사용.
 *   원본 이미지 전체를 지정된 위치/크기로 렌더링한다.
 *
 * @readonly
 */
export type ImageObjectFit = 'cover' | 'fill' | 'contain' | 'none';

/**
 * 이미지 크롭 영역과 소스를 정의하는 데이터.
 *
 * `<canvas>`를 사용해 크롭된 이미지를 렌더링한다.
 *
 * **주의**: `x`, `y`, `width`, `height`의 의미가 `objectFit`에 따라 다르다:
 * - `objectFit !== 'none'` (cover/contain/fill): 픽셀 단위의 소스 크롭 영역.
 *   `dpi`로 mm 변환 후 `_computeObjectFit`에서 실제 크롭 위치를 재계산한다.
 *   이 값들은 내부 렌더링 전용이며 UI에 노출되지 않는다.
 * - `objectFit === 'none'`: mm 단위의 박스 내 표시 위치와 크기.
 *   `x`, `y`는 박스 내 오프셋, `width`, `height`는 표시 크기다.
 *   원본 이미지 전체를 지정된 위치/크기로 렌더링한다.
 *
 * `base64Data`가 있으면 URL 대신 인라인 데이터를 사용하며,
 * 인쇄 모드(`window.matchMedia("print")`)에서 주로 활용된다.
 */
export type ImageData = {
  /** 타입 식별자 (리터럴) */
  type: 'image';

  /** 고유 식별자 */
  id?: string;

  /**
   * objectFit이 'none'일 때: 박스 내 이미지 시작 X 위치 (mm).
   * 그 외: 크롭 시작 X 좌표 (원본 이미지 내 픽셀).
   *
   * `objectFit === 'none'`일 때만 의미 있으며, 생략 시 렌더링하지 않는다.
   */
  x?: number;

  /**
   * objectFit이 'none'일 때: 박스 내 이미지 시작 Y 위치 (mm).
   * 그 외: 크롭 시작 Y 좌표 (원본 이미지 내 픽셀).
   *
   * `objectFit === 'none'`일 때만 의미 있으며, 생략 시 렌더링하지 않는다.
   */
  y?: number;

  /**
   * objectFit이 'none'일 때: 이미지 표시 너비 (mm).
   * 그 외: 크롭 너비 (픽셀).
   *
   * `objectFit === 'none'`일 때만 의미 있으며, 생략 시 렌더링하지 않는다.
   */
  width?: number;

  /**
   * objectFit이 'none'일 때: 이미지 표시 높이 (mm).
   * 그 외: 크롭 높이 (픽셀).
   *
   * `objectFit === 'none'`일 때만 의미 있으며, 생략 시 렌더링하지 않는다.
   */
  height?: number;

  /** 이미지 해상도. 크롭 영역을 mm로 변환할 때 사용 */
  dpi: number;

  /** 이미지 URL */
  url: string;

  /** 렌더링 순서 (z-index) */
  zIndex?: number;

  /** 오버랩 감지 시 이미지 불투명 픽셀 주변의 패딩 (mm). 숫자면 상하좌우 동일. */
  overlapPadding?: number | { top?: number; right?: number; bottom?: number; left?: number };

  /** 원본 이미지 너비 (픽셀). 메타데이터. */
  originalWidth?: number;

  /** 원본 이미지 높이 (픽셀). 메타데이터. */
  originalHeight?: number;

  /** object-fit 동작. 기본값 'cover'. 'none'이면 x/y/width/height를 그대로 사용. */
  objectFit?: ImageObjectFit;
}