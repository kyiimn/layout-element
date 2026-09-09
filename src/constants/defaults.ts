export const DEFAULT_BORDER_STYLE = 'solid';
export const DEFAULT_FONT_SIZE = 4;
export const DEFAULT_FONT_STYLE = 'normal';
export const DEFAULT_FONT_WEIGHT = 400;
export const DEFAULT_LINE_GAP = 1.25;

/** 행간 계산 모드 기본값. 'ratio' = 기존 동작 (fontSize 배율)과 byte-identical. */
export const DEFAULT_LINE_GAP_MODE: 'ratio' | 'fixed' | 'fixed-min' = 'ratio';

/**
 * fixed/fixed-min 모드에서 lineGap이 생략될 때의 기본 행 높이 (mm).
 *
 * DEFAULT_LINE_GAP(1.25, 배율)이 그대로 mm로 재해석되는 footgun을 방지한다:
 * `lineGapMode: 'fixed'`만 주입하면 lineGap이 DEFAULT_LINE_GAP_FIXED로
 * 해석된다 (기존 lineGap이 명시되어 있으면 그 값을 유지).
 */
export const DEFAULT_LINE_GAP_FIXED = 6;
export const DEFAULT_PPM = 96 / 25.4;
export const DEFAULT_IMAGE_DPI = 72;
export const DEFAULT_SPACE_RATIO = 0.5;
export const DEFAULT_LETTER_SPACING = -0.1;
export const DEFAULT_WIDTH_RATIO = 1;
export const DEFAULT_INDENT = 0;
export const DEFAULT_TEXT_ALIGN = 'justify';
export const DEFAULT_VERTICAL_ALIGN = 'top';

/** 걸침표 기본값. false = OFF (기존 레이아웃과 byte-identical) */
export const DEFAULT_HANGING_PUNCTUATION: boolean = false;

/** 워드 래핑 기본값. false = OFF (기존 글자 단위 줄바꿈과 byte-identical) */
export const DEFAULT_WORD_WRAP: boolean = false;

/**
 * 텍스트 스타일 단축키가 주입하는 볼드 굵기 값.
 * 문단 기본값으로 복귀는 런의 fontWeight 필드 제거(`_toggleInlineStyle`)로 수행한다.
 */
export const SHORTCUT_BOLD_WEIGHT = 700;

/** 텍스트 스타일 단축키의 글자 크기 조절 step (mm). */
export const SHORTCUT_FONT_SIZE_STEP = 0.1;

/** 텍스트 스타일 단축키의 자간/장평/공백비율 조절 step (em·ratio 1%). */
export const SHORTCUT_METRIC_STEP = 0.01;

/** 텍스트 스타일 단축키로 축소 가능한 최소 글자 크기 (mm). 폭 계산 음수 방지. */
export const SHORTCUT_MIN_FONT_SIZE = 0.1;

/** 텍스트 스타일 단축키로 축소 가능한 최소 공백비율 (em). 폭 계산 음수 방지. */
export const SHORTCUT_MIN_SPACE_RATIO = 0;

/**
 * 텍스트 스타일 단축키의 증감량 세트 (엔진 저장 단위).
 *
 * 기본값은 위 개별 상수와 동일하다. 호스트(예: layout-ui)가 업체 표시
 * 단위에 맞춰 `EditManager.shortcutSteps`로 교체한다 — 예: 급(Q) 표시 업체는
 * fontSize step을 0.25mm(=1Q)로 교체해 단축키 1회가 표시값 1만큼 움직이게 한다.
 */
export type ShortcutMetricSteps = {
  /** 글자 크기 증감량 (mm) */
  fontSize: number;
  /** 자간 증감량 (em) */
  letterSpacing: number;
  /** 장평 증감량 (ratio) */
  widthRatio: number;
  /** 공백비율 증감량 (em) */
  spaceRatio: number;
};

/** 단축키 증감량 기본값 — `SHORTCUT_*_STEP` 상수와 동일 (주입 없을 때의 동작). */
export const DEFAULT_SHORTCUT_METRIC_STEPS: ShortcutMetricSteps = {
  fontSize: SHORTCUT_FONT_SIZE_STEP,
  letterSpacing: SHORTCUT_METRIC_STEP,
  widthRatio: SHORTCUT_METRIC_STEP,
  spaceRatio: SHORTCUT_METRIC_STEP,
};

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