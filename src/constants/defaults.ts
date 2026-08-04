export const DEFAULT_BORDER_STYLE = 'solid';
export const DEFAULT_FONT_SIZE = 4;
export const DEFAULT_FONT_STYLE = 'normal';
export const DEFAULT_FONT_WEIGHT = 400;
export const DEFAULT_LINE_GAP = 1.25;
export const DEFAULT_PPM = 96 / 25.4;
export const DEFAULT_IMAGE_DPI = 72;
export const DEFAULT_SPACE_RATIO = 0.25;
export const DEFAULT_LETTER_SPACING = -0.1;
export const DEFAULT_WIDTH_RATIO = 0.8;
export const DEFAULT_TEXT_ALIGN = 'justify';
export const DEFAULT_VERTICAL_ALIGN = 'top';

/**
 * 텍스트 문자 폭 측정 모드.
 *
 * - `'canvas'`: Canvas `measureText().width` 기반 측정.
 *   브라우저 렌더링 파이프라인에 의존하므로 환경(브라우저 엔진/OS/DPI/hinting)마다
 *   미세하게 다른 결과를 낼 수 있다. 모니터 내에서 scale 무관성은 보장되지만,
 *   클라이언트 ↔ 서버(Playwright) 간 일치성은 보장되지 않는다.
 *   장평(`widthRatio`)은 상한 클램프로 적용되어, 원본 폭이 상한보다 좁은 글자에는
 *   장평이 반영되지 않는 한계가 있다.
 *
 * - `'opentype'` (기본값): opentype.js로 폰트 메트릭 테이블(`hmtx`)을 직접 파싱하여
 *   advance width를 계산. 같은 TTF 파일을 사용하는 한 환경에 무관하게
 *   동일한 mm 값을 반환하므로, 모니터 작업 결과가 서버 재렌더링/윤전기
 *   인쇄물과 동일하게 보장된다. 장평은 곱셈으로 적용되어 모든 글자에 정확히
 *   반영된다. 특정 폰트 파싱 실패 또는 글리프 누락 시 자동으로 `'canvas'` 모드로
 *   폴백한다. opentype.js는 필수 의존성(`peerDependencies`)이다.
 *
 * 런타임 비교/검증을 위해 두 모드를 토글할 수 있다. 모드 변경 후에는
 * 모든 단락을 재렌더링해야 결과가 반영된다.
 */
export const TEXT_MEASUREMENT_MODE: 'canvas' | 'opentype' = 'opentype';

/** 레이아웃 요소 zIndex 최댓값. 90001 이상은 예약 범위이므로 사용 불가 */
export const Z_INDEX_MAX_LAYOUT = 90000;

/** 예약: 리사이즈 핸들 (resize-handle) z-index */
export const Z_INDEX_RESIZE_HANDLE = 99999;

/** 예약: 타입 라벨 (type-label) z-index */
export const Z_INDEX_TYPE_LABEL = 99998;

/** 예약: 삽입 미리보기 오버레이 (insert preview) z-index */
export const Z_INDEX_INSERT_PREVIEW = 99997;

/** 예약: AI 처리 중 오버레이 (ai processing) z-index */
export const Z_INDEX_AI_PROCESSING = 99996;

/** 예약: 텍스트 편집 textarea (IME 입력) z-index */
export const Z_INDEX_TEXTAREA = 9999;

/** 역할 고정 z-index: 광고 (ad) */
export const Z_INDEX_ROLE_AD = 91000;

/** 역할 고정 z-index: 면머리 (header) */
export const Z_INDEX_ROLE_HEADER = 91001;