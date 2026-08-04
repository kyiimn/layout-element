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