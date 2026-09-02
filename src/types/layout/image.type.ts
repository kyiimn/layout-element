/**
 * 이미지 object-fit 동작.
 *
 * `ImageEngine.displayRect`가 모드별로 표시 위치/크기를 계산하는 단일 소스다:
 *
 * - `'cover'`: box 영역을 채우면서 원본 비율 유지. 넘치는 부분 크롭(중앙 정렬).
 * - `'contain'`: box 안에 전체 이미지 표시. 여백 발생(중앙 정렬).
 * - `'fill'`: box 영역에 맞춰 늘림. 비율 무시.
 * - `'none'`: `x`/`y`/`width`/`height` **입력값을 그대로** 사용해 박스 내
 *   지정 위치/크기로 배치. 생략된 `width`/`height`는 원본 크기(1:1) 폴백.
 *
 * `cover`/`contain`/`fill`에서는 입력 `x`/`y`/`width`/`height`를 **무시**한다.
 *
 * @readonly
 */
export type ImageObjectFit = 'cover' | 'fill' | 'contain' | 'none';

/**
 * 이미지 오버랩 처리 모드.
 *
 * 단락보다 앞쪽에 떠 있는(z-index가 큰) 이미지가 텍스트와 겹칠 때,
 * 텍스트가 이미지를 어떻게 회피할지 결정한다.
 *
 * - **`'path'`** (기본값): 이미지 캔버스의 불투명 픽셀 윤곽을 따라 텍스트가 흐른다.
 *   투명 영역은 통과하며, `overlapPadding`이 설정되면 타원 기반 패딩이 적용된다.
 *   현재 동작과 동일하다.
 * - **`'box'`**: 이미지를 일반 박스처럼 취급한다. 캔버스 픽셀 검사를 수행하지 않고
 *   박스 기하학적 rect 기준으로 오버랩을 판정한다. `overlapPadding`은 적용된다.
 *   투명 영역도 텍스트를 차단한다.
 * - **`'none'`**: 오버랩 회피를完全不히 하지 않는다. 텍스트가 이미지 아래에
 *   그대로 쓰여지고 이미지가 그 위를 덮는다. `overlayElements`에서 제외되어
 *   `TextLayoutEngine`이 이 이미지를 오버랩 요소로 취급하지 않는다.
 *
 * @readonly
 */
export type OverlapMode = 'path' | 'box' | 'none';

/**
 * 이미지 표시 영역과 소스를 정의하는 데이터.
 *
 * `<canvas>`를 사용해 이미지를 렌더링한다. 원본 이미지를 `width`×`height`(mm)
 * 크기로 리사이즈하여 박스 내 `(x, y)` 위치에 배치한다. 박스(캔버스) 크기를
 * 벗어나는 부분은 자동으로 clip되어 크롭 효과를 낸다.
 *
 * ### 엔진-우선 원칙 (objectFit 모드별 시맨틱)
 *
 * `ImageEngine.displayRect`가 표시 위치/크기의 단일 소스다:
 *
 * - `objectFit`이 `'cover'`/`'contain'`/`'fill'`이면 `x`/`y`/`width`/`height`
 *   **입력값을 무시**하고, `objectFit` + `originalWidth`/`originalHeight` +
 *   박스 크기(`contentAbsRect`)로 자동 계산한 값으로만 렌더링한다.
 * - `objectFit`이 `'none'`이면 `x`/`y`/`width`/`height` **입력값을 그대로** 사용해
 *   박스 내 지정 위치/크기로 배치한다. 생략된 `width`/`height`는 원본 크기(1:1) 폴백.
 *
 * `urlLoader`가 설정되면 원본 URL을 로더에 전달하여 실제 로드할 URL을 얻는다.
 * CDN URL 리라이팅, 서명된 URL 발급, base64 인라인 데이터 반환 등의
 * 시나리오를 지원한다.
 */
export type ImageData = {
  /** 타입 식별자 (리터럴) */
  type: 'image';

  /** 고유 식별자 */
  id?: string;

  /**
   * 박스 내 이미지 표시 시작 X 위치 (mm).
   *
   * `objectFit`이 `'none'`일 때만 렌더링에 반영된다.
   * `cover`/`contain`/`fill`에서는 무시되고 엔진이 자동 계산한다.
   * 음수면 이미지가 박스 왼쪽으로 치워져 원본의 오른쪽 일부가 크롭된다.
   * 생략 시 0.
   */
  x?: number;

  /**
   * 박스 내 이미지 표시 시작 Y 위치 (mm).
   *
   * `objectFit`이 `'none'`일 때만 렌더링에 반영된다.
   * `cover`/`contain`/`fill`에서는 무시되고 엔진이 자동 계산한다.
   * 음수면 이미지가 박스 위쪽으로 치워져 원본의 아래쪽 일부가 크롭된다.
   * 생략 시 0.
   */
  y?: number;

  /**
   * 이미지 표시 너비 (mm).
   *
   * `objectFit`이 `'none'`일 때만 렌더링에 반영된다. 생략 시 원본 너비(1:1).
   * `cover`/`contain`/`fill`에서는 무시되고 엔진이 자동 계산한다.
   */
  width?: number;

  /**
   * 이미지 표시 높이 (mm).
   *
   * `objectFit`이 `'none'`일 때만 렌더링에 반영된다. 생략 시 원본 높이(1:1).
   * `cover`/`contain`/`fill`에서는 무시되고 엔진이 자동 계산한다.
   */
  height?: number;

  /**
   * 이미지 해상도 (DPI).
   *
   * mm 단위 좌표를 캔버스 픽셀로 변환할 때 사용된다. 원본 메타데이터의
   * dpi와 무관하게 캔버스 렌더링 해상도만 결정한다.
   */
  dpi: number;

  /** 이미지 URL. `urlLoader`가 설정되면 로더를 거쳐 실제 로드할 URL로 변환된다. */
  url: string;

  /** 렌더링 순서 (z-index) */
  zIndex?: number;

  /** 오버랩 감지 시 이미지 불투명 픽셀 주변의 패딩 (mm). 숫자면 상하좌우 동일. */
  overlapPadding?: number | { top?: number; right?: number; bottom?: number; left?: number };

  /**
   * 오버랩 처리 모드.
   *
   * 단락보다 앞쪽에 떠 있는(z-index가 큰) 이미지가 텍스트와 겹칠 때,
   * 텍스트가 이미지를 어떻게 회피할지 결정한다.
   *
   * - `'path'` (기본값): 불투명 픽셀 윤곽을 따라 흐름. 투명 영역 통과.
   * - `'box'`: 박스 rect 기준으로 오버랩. 투명 영역도 차단. `overlapPadding` 적용.
   * - `'none'`: 오버랩 회피 없음. 텍스트가 이미지 아래에 쓰여지고 이미지가 덮음.
   *
   * 생략 시 `'path'`.
   */
  overlapMode?: OverlapMode;

  /**
   * 원본 이미지 너비 (mm).
   *
   * Place Gun에서 이미지 등록 시 `px / dpi * 25.4`로 변환하여 주입한다.
   * 렌더링 시 원본 비율 기반 계산에 사용된다.
   */
  originalWidth?: number;

  /**
   * 원본 이미지 높이 (mm).
   *
   * Place Gun에서 이미지 등록 시 `px / dpi * 25.4`로 변환하여 주입한다.
   * 렌더링 시 원본 비율 기반 계산에 사용된다.
   */
  originalHeight?: number;

  /**
   * object-fit 동작.
   *
   * `ImageEngine.displayRect`가 표시 위치/크기를 계산하는 단일 소스다:
   *
   * - `'cover'`/`'contain'`/`'fill'`: 입력 `x`/`y`/`width`/`height`를 무시하고
   *   `originalWidth`/`originalHeight` + 박스 크기로 자동 계산한다.
   * - `'none'`: 입력 `x`/`y`/`width`/`height`를 그대로 사용한다.
   *
   * 기본값 `'cover'`.
   */
  objectFit?: ImageObjectFit;
}