/**
 * 엔진 계층의 공유 타입 정의.
 *
 * 이 파일은 Node.js 호환 엔진 계층 전체에서 사용되는 타입을 정의한다.
 * DOM, Canvas, FontFace 등 브라우저 의존 API를 참조하지 않는다.
 * 모든 좌표는 mm 단위이며, 픽셀 변환은 엔진 사용자가 ppm을 통해 수행한다.
 *
 * @file src/engine/types.ts
 */

// 이 파일 내부에서 사용하는 타입은 import type으로 가져옴.
// noUnusedLocals를 만족하기 위해 로컬 사용이 없는 타입은 export type from으로만 재내보냄.
import type {
  OverlapParts,
  OverlapMode,
  ParagraphOverlapMode,
  ImageObjectFit,
  Font,
  CMYKColorSet,
  CMYKColor,
  ParagraphStyle,
  TextStyle,
  TextLineData,
} from "@/types";
import type { GridResolution } from "./table-grid-resolver";
import type { BoxEngine } from "./box-engine";
import type { GridCalculatorEngine } from "./grid-calculator-engine";

// 로컬에서 사용하지 않고 재내보내기만 하는 타입 (noUnusedLocals 회피)
export type {
  BoxData,
  DocumentData,
  ImageData,
  ParagraphData,
  TableData,
  TextData,
  BoxRole,
  BoxPosition,
  BoxBorderStyle,
} from "@/types";

export type {
  TextBlockStyle,
  TextBlockData,
  TextPartData,
} from "@/types";

export type { CursorPosition } from "@/types";

// ─────────────────────────────────────────────────────────────
// 기하 타입 (mm 단위)
// ─────────────────────────────────────────────────────────────

/**
 * 절대 좌표 기반 사각형 (mm).
 * 엔진이 계산한 지면 기준 절대 위치와 크기.
 */
export interface AbsRect {
  /** 지면 좌상단 기준 절대 X (mm) */
  absLeft: number;
  /** 지면 좌상단 기준 절대 Y (mm) */
  absTop: number;
  /** 절대 너비 (mm) */
  absWidth: number;
  /** 지면 좌상단 기준 절대 하단 Y (mm) */
  absHeight: number;
}

/**
 * mm 단위 사각형 (left/right/top/bottom 표현).
 * 오버랩 판정 등 내부 연산에 사용.
 */
export interface MmRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * 컬럼 그리드 좌표.
 * GridCalculatorEngine이 각 컬럼의 경계를 계산한 결과.
 * @/core의 `Rect`와 동일 구조이나 엔진 계층에서 독립적으로 정의.
 */
export interface GridRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// ─────────────────────────────────────────────────────────────
// 오버랩 타입
// ─────────────────────────────────────────────────────────────

/** 오버랩 방향. NONE=겹침 없음, COVERS=전체 덮임, PART=일부 겹침 */
export type OverlapDirection = "NONE" | "COVERS" | "PART";

/** 오버랩 판정 결과 */
export interface OverlapResult {
  direction: OverlapDirection;
  parts: OverlapParts[];
}

/**
 * 오버랩 판정 입력.
 * `LayoutBoxElement` 대신 순수 데이터를 받는다.
 */
export interface OverlapInput {
  /** 오버랩 요소의 절대 사각형 */
  absRect: AbsRect;
  /** 오버랩 처리 모드 */
  overlapMode: OverlapMode | ParagraphOverlapMode;
  /** 오버랩 패딩 (mm) */
  overlapPadding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  /** 이미지 엔진 (overlapMode === 'path'일 때 픽셀 검사용) */
  image?: ImageEngineRef | null;
  /** 콘텐츠 타입 ('image' | 'paragraph' | 'table' | null) */
  contentType: BoxContentType;
}

/** 이미지 엔진 참조 (순환 참조 방지를 위한 최소 인터페이스) */
export interface ImageEngineRef {
  /** 디코딩된 RGBA 데이터 (없으면 null — 아직 로드 안 됨) */
  rgbaData: { data: Uint8Array; width: number; height: number } | null;
  /** 오버랩 모드 */
  overlapMode: OverlapMode;
  /** 오버랩 패딩 */
  overlapPadding?: number | { top?: number; right?: number; bottom?: number; left?: number };
}

// ─────────────────────────────────────────────────────────────
// 박스 콘텐츠 타입
// ─────────────────────────────────────────────────────────────

/** 박스가 담고 있는 콘텐츠의 종류 */
export type BoxContentType = "image" | "paragraph" | "table" | null;

/** BoxEngine이 부모로 참조하는 최소 인터페이스. */
export interface BoxEngineParent {
  gridCalculator: GridCalculatorEngine | null;
  absRect: AbsRect;
  isDocument: boolean;
  overlayElements: BoxEngine[];
  childBoxEngines: BoxEngine[];
  findBoxEngineById(id: string): BoxEngine | undefined;
  paddingTop: number;
}

// ─────────────────────────────────────────────────────────────
// 리소스 엔진 인터페이스
// ─────────────────────────────────────────────────────────────

/**
 * Node.js 호환 폰트 로더 인터페이스.
 *
 * `FontFace` API나 `document.fonts`를 사용하지 않고,
 * `opentype.js`로 폰트 메트릭만 파싱하여 제공한다.
 * 브라우저의 `FontLoader` 싱글톤이 내부적으로 이 인터페이스를 구현한
 * 엔진을 소유하고 메트릭 조회를 위임한다.
 */
export interface FontLoaderEngine {
  /** 초기화 완료 여부 */
  readonly ready: boolean;
  /**
   * 폰트 배열로 초기화한다.
   * @param fonts - 폰트 메타데이터 + base64Data/ttfFilename
   * @throws {Error} 폰트 파싱 실패 시
   */
  init(fonts: Font[]): Promise<void>;
  /**
   * 파싱된 폰트 객체를 반환한다.
   * @param fontName - 폰트 family 이름. 생략 시 첫 번째 폰트.
   * @returns opentype.Font 객체. 파싱 실패/누락 시 null.
   */
  getParsedFont(fontName?: string): ParsedFont | null;
  /**
   * 폰트 패밀리명을 반환한다.
   * @param fontName - 조회할 family 이름. 생략 시 첫 번째 폰트.
   * @returns FontFace.family에 해당하는 문자열
   */
  getFontFamily(fontName?: string): string;
}

/**
 * opentype.js 파싱 결과 타입 (최소 인터페이스).
 * `opentype.Font`의 `charToGlyph`/`unitsPerEm`/`advanceWidth`만 사용.
 */
export interface ParsedFont {
  /** 폰트의 units per em */
  unitsPerEm: number;
  /**
   * 문자를 글리프로 변환한다.
   * @param char - 변환할 문자
   * @returns 글리프 객체
   */
  charToGlyph(char: string): { advanceWidth: number };
}

/**
 * Node.js 호환 색상 레지스트리 인터페이스.
 *
 * `fetch()`나 `document.styleSheets`를 사용하지 않고,
 * 주입된 `CMYKColorSet`으로 CMYK→RGB 변환만 수행한다.
 */
export interface ColorRegistryEngine {
  /** 초기화 완료 여부 */
  readonly ready: boolean;
  /**
   * 색상 데이터로 초기화한다 (동기).
   * @param colorSet - CMYK 색상 정의
   */
  init(colorSet: CMYKColorSet): void;
  /**
   * 색상 이름으로 CMYKColor를 반환한다.
   * @param name - CMYKColorSet에 등록된 키. 미등록 이름은 기본 색상.
   * @returns CMYKColor
   */
  get(name: string): CMYKColor;
  /**
   * 색상 이름으로 #RRGGBB hex 문자열을 반환한다.
   * @param name - CMYKColorSet에 등록된 키
   * @returns #RRGGBB hex. 미등록 이름은 기본 색상 hex.
   */
  getCSSColor(name: string): string;
  /**
   * 투명도 값을 2자리 hex alpha로 변환한다.
   * @param opacity - 0~1 투명도
   * @returns 00~FF hex 문자열
   */
  getOpacityHex(opacity: number): string;
}

/**
 * 엔진이 필요로 하는 리소스 번들.
 * DocumentEngine 생성 시 주입되어 하위 엔진으로 전파된다.
 */
export interface EngineResources {
  /** pixels-per-mm. 외부 주입 (Locked Decision 1) */
  ppm: number;
  /** Node 호환 폰트 로더 */
  fontLoader: FontLoaderEngine;
  /** Node 호환 색상 레지스트리 */
  colorRegistry: ColorRegistryEngine;
}

// ─────────────────────────────────────────────────────────────
// 커서 배치 타입
// ─────────────────────────────────────────────────────────────

/**
 * 커서 배치 정보: 특정 source offset에 커서를 표시할 위치를 나타낸다.
 *
 * 엔진 계층에서 `ParagraphEngine.getCursorPlacement()`가 반환하고,
 * 편집 계층(`@/edit/text-edit-coordinate-mapper.ts`)이 소비한다.
 * 엔진이 편집 계층에 타입 의존성을 갖지 않도록 이 파일에 원본을 정의한다.
 */
export interface CursorPlacement {
  /** 커서가 참조할 가시 문자의 source offset */
  sourceOffset: number;
  /** true면 커서를 문자의 우측 끝에 배치, false면 좌측에 배치 */
  atEndOfChar: boolean;
}

// ─────────────────────────────────────────────────────────────
// 엔진 옵션 타입
// ─────────────────────────────────────────────────────────────

/**
 * GridCalculatorEngine 옵션.
 * 기존 `GridCalculatorOptions`에서 `element` 참조를 제거하고
 * `isBox` 불리언으로 대체한 순수 데이터 형태.
 */
export interface GridCalculatorEngineOptions {
  /** 컨테이너 너비 (mm) */
  width: number;
  /** 컨테이너 높이 (mm) */
  height: number;
  /** 상단 패딩 (mm) */
  paddingTop?: number;
  /** 하단 패딩 (mm) */
  paddingBottom?: number;
  /** 좌측 패딩 (mm) */
  paddingLeft?: number;
  /** 우측 패딩 (mm) */
  paddingRight?: number;
  /** 컬럼 정의. number=동일 너비 컬럼 수, number[]=명시적 너비 배열 */
  columns: number | number[];
  /** 컬럼 간격. number=균일, number[]=개별 간격 */
  gap: number | number[];
  /** 문단 스타일 (lineGap 등) */
  paragraphStyle: ParagraphStyle;
  /** 텍스트 스타일 (fontSize 등) */
  textStyle: TextStyle;
  /**
   * 이 컨테이너가 박스인지 여부.
   * 기존 `instanceof LayoutBoxElement` 체크를 대체.
   * 박스인 경우 첫/마지막 컬럼 너비에서 패딩을 차감한다.
   */
  isBox: boolean;
}

/**
 * ImageEngine 옵션.
 * `ImageData`에서 렌더링에 불필요한 필드를 제외한 순수 계산용.
 */
export interface ImageEngineData {
  /** 이미지 URL (엔진은 로드하지 않음, 참조용) */
  url: string;
  /** 박스 내 이미지 표시 시작 X (mm) */
  x?: number;
  /** 박스 내 이미지 표시 시작 Y (mm) */
  y?: number;
  /** 이미지 표시 너비 (mm) */
  width?: number;
  /** 이미지 표시 높이 (mm) */
  height?: number;
  /** 이미지 해상도 (DPI) */
  dpi: number;
  /** 오버랩 패딩 (mm) */
  overlapPadding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  /** 오버랩 처리 모드 */
  overlapMode: OverlapMode;
  /** object-fit 프리셋 */
  objectFit: ImageObjectFit;
  /** 원본 이미지 너비 (mm) */
  originalWidth?: number;
  /** 원본 이미지 높이 (mm) */
  originalHeight?: number;
}

// ─────────────────────────────────────────────────────────────
// 레이아웃 결과 타입
// ─────────────────────────────────────────────────────────────

/** 이미지 레이아웃 결과 */
export interface ImageLayoutResult {
  /** 크롭/표시 영역 (mm) */
  cropRectMm: AbsRect;
  /** 디스플레이 영역 (mm) */
  displayRectMm: AbsRect;
}

/** 박스 레이아웃 결과 */
export interface BoxLayoutResult {
  /** 박스 절대 사각형 */
  absRect: AbsRect;
  /** 자식 레이아웃 결과 (재귀) */
  children: LayoutResult[];
}

/** 테이블 레이아웃 결과 */
export interface TableLayoutResult {
  /** 그리드 해석 결과 */
  gridResolution: GridResolution;
}

/** 문단 레이아웃 결과 */
export interface ParagraphLayoutResult {
  /** 컬럼별 줄 데이터 */
  columnContents: TextLineData[][];
  /** 오버플로우 문자 수 */
  overflow: number;
  /** 컬럼 너비 배열 (mm) */
  columnWidths: number[];
  /** 컬럼 간격 배열 (mm) */
  gaps: number[];
  /** 줄 높이 (mm) */
  lineHeight: number;
}

/** 문서 레이아웃 결과 */
export interface DocumentLayoutResult {
  /** 자식 박스 레이아웃 결과 */
  children: BoxLayoutResult[];
}

/** 모든 레이아웃 결과의 유니언 */
export type LayoutResult =
  | BoxLayoutResult
  | ImageLayoutResult
  | TableLayoutResult
  | ParagraphLayoutResult;

// ─────────────────────────────────────────────────────────────
// 로컬에서 import한 타입을 엔진 파일들이 ./types에서 import할 수 있도록 재내보내기.
export type {
  OverlapParts,
  OverlapMode,
  ParagraphOverlapMode,
  ImageObjectFit,
  Font,
  CMYKColorSet,
  CMYKColor,
  ParagraphStyle,
  TextStyle,
  InheritStyle,
  TextLineData,
  PrintPostData,
  PrintPostDataChar,
  PrintPostDataRect,
  PrintPostBorderEdge,
  PrintPostDiagonal,
  TableCellData,
  TableRowData,
} from "@/types";

export type { GridResolution } from "./table-grid-resolver";