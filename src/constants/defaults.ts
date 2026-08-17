export const DEFAULT_BORDER_STYLE = 'solid';
export const DEFAULT_FONT_SIZE = 4;
export const DEFAULT_FONT_STYLE = 'normal';
export const DEFAULT_FONT_WEIGHT = 400;
export const DEFAULT_LINE_GAP = 1.25;
export const DEFAULT_PPM = 96 / 25.4;
export const DEFAULT_IMAGE_DPI = 72;
export const DEFAULT_SPACE_RATIO = 0.5;
export const DEFAULT_LETTER_SPACING = -0.1;
export const DEFAULT_WIDTH_RATIO = 0.8;
export const DEFAULT_INDENT = 0;
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

/** 마키(고무줄) 선택 사각형 z-index */
export const Z_INDEX_MARQUEE_RECT = 99995;

/** 역할 고정 z-index: 광고 (ad) */
export const Z_INDEX_ROLE_AD = 91000;

/** 역할 고정 z-index: 면머리 (header) */
export const Z_INDEX_ROLE_HEADER = 91001;

/** 테이블 보더 레이어 z-index. 셀 배경 위, 셀 컨텐츠(box) 아래. */
export const Z_INDEX_TABLE_BORDER = 99990;

/** 테이블 대각선 z-index. 셀 컨텐츠 위, 보더 레이어와 독립. */
export const Z_INDEX_TABLE_DIAGONAL = 99991;

/** 테이블 리사이즈 핸들 레이어 z-index. �들이 보더/대각선 위에 표시. */
export const Z_INDEX_TABLE_RESIZE = 99992;

/** 테이블 셀 블록 선택 레이어 z-index. border-layer(99990) 아래. */
export const Z_INDEX_TABLE_SELECTION = 99989;

/** 테이블 컬럼 최소 너비 (mm). 리사이즈 시 이하로 축소 불가. */
export const MIN_TABLE_COL_WIDTH = 5;

/** 테이블 행 최소 높이 (mm). 리사이즈 시 이하로 축소 불가. */
export const MIN_TABLE_ROW_HEIGHT = 5;

/** 키보드 셀 크기 조절 단위 (mm per key press). */
export const TABLE_KEYBOARD_RESIZE_STEP = 1;