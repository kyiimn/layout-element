import { ParagraphStyle, TextStyle } from "../style";
import { BoxData } from "./box.type";
import { PageData } from "./page.type";
import { ThreadData } from "./thread.type";

/**
 * 문서 전체의 루트 데이터. 페이지 배열과 스레드 정의, 전역 기본 스타일을 정의한다.
 *
 * 계층 구조 (Phase B — 페이지 모델):
 * ```
 * DocumentData            ← 문서 (페이지 배열 + 스레드 + 전역 스타일 기본값)
 *   ├─ pages: PageData[]  ← 페이지 (용지 크기·컬럼 그리드·박스 자식)
 *   │    └─ children: BoxData[]  ← 페이지 내 floating 요소 (박스)
 *   └─ threads: ThreadData[]     ← 페이지 경계를 가로지르는 텍스트 흐름
 * ```
 *
 * 렌더링 파이프라인:
 * 1. `LayoutDocumentElement`가 `data` setter를 통해 이 데이터를 받음
 * 2. `DocumentEngine`이 각 `PageData`를 `PageEngine`으로 배치
 * 3. `threads`는 문서 엔진이 소유하며 프레임 문단(전 페이지 통틀어 유일한 id)을
 *    페이지를 가로질러 조회해 feed-forward 배치한다
 *
 * @example
 * const doc: DocumentData = {
 *   pages: [{
 *     width: 257,    // A4 너비 (mm)
 *     height: 370,   // A4 높이 (mm)
 *     columns: 6,    // 6등분 컬럼
 *     gap: 3,        // 컬럼 간격 3mm
 *     paragraphStyle: { lineGap: 1.2, textAlign: 'justify' },
 *     textStyle: { fontFamily: 'Noto Sans', fontSize: 4, color: '#000' },
 *     children: [/* BoxData 배열 *\/],
 *   }],
 *   threads: [{ id: 't1', paragraphIds: ['p1', 'p2'], content: '...' }],
 * };
 */
export type DocumentData = {
  /** 고유 식별자 (선택) */
  id?: string;

  /**
   * 페이지 배열. 각 페이지는 용지 크기·컬럼 그리드·박스 자식을 소유한다.
   * 레거시 입력(페이지 개념 없는 단일 캔버스)은 `normalizeDocumentData()`가
   * 1원소 pages로 래핑한다.
   */
  pages?: PageData[];

  /**
   * 텍스트 스레딩 정의 (옵셔널 — 생략 시 스레딩 미사용, 기존 동작 byte-identical).
   * thread가 story 콘텐츠의 단일 소스이며, 프레임 문단은 표시 범위만 소유한다.
   * 프레임 문단 id는 전 페이지 통틀어 유일해야 한다.
   */
  threads?: ThreadData[];

  /**
   * 문서 전체 기본 문단 스타일. 페이지가 오버라이드하지 않은 필드의 기본값으로
   * 사용된다 (문서→페이지 상속). 페이지·박스에서 오버라이드 가능.
   */
  paragraphStyle: ParagraphStyle;

  /**
   * 문서 전체 기본 텍스트 스타일. 페이지가 오버라이드하지 않은 필드의 기본값으로
   * 사용된다 (문서→페이지 상속). 페이지·박스에서 오버라이드 가능.
   */
  textStyle: TextStyle;

  /**
   * 문서 기준 용지 너비 (mm). 개별 페이지 크기가 아니라 문서 전체의 기준점 —
   * 페이지마다 다른 사이즈를 가질 수 있으나, 새 페이지 추가 시 이 값이 기본값이 된다.
   */
  width: number;

  /**
   * 문서 기준 용지 높이 (mm). 개별 페이지 크기가 아니라 문서 전체의 기준점.
   */
  height: number;

  /**
   * 문서 기준 컬럼 그리드 정의. 새 페이지 추가 시 기본값이 된다.
   */
  columns: number | number[];

  /**
   * 문서 기준 컬럼 간격. 새 페이지 추가 시 기본값이 된다.
   */
  gap: number | number[];

  /** 문서 기준 상단 여백 (mm). 새 페이지 추가 시 기본값이 된다. */
  paddingTop?: number;

  /** 문서 기준 우측 여백 (mm). 새 페이지 추가 시 기본값이 된다. */
  paddingRight?: number;

  /** 문서 기준 하단 여백 (mm). 새 페이지 추가 시 기본값이 된다. */
  paddingBottom?: number;

  /** 문서 기준 좌측 여백 (mm). 새 페이지 추가 시 기본값이 된다. */
  paddingLeft?: number;

  /**
   * 페이지 시작 방향 — 문서의 첫 페이지가 놓이는 쪽.
   * - `'right'`: 오른쪽 끝에서 시작 (기본값, 국배판 한자 문화권 제본)
   * - `'left'`: 왼쪽 끝에서 시작 (서양식 제본)
   * 펼친면(spread) 계산의 기준이 된다. 상속값이 아니라 문서 기준값이다.
   */
  pageStart?: 'left' | 'right';

  /**
   * 펼친면 구성 페이지 수 (기본값 2 — 양면 펼침).
   * 상속값이 아니라 문서 기준값이다.
   */
  spreadPages?: number;

  /**
   * @deprecated 레거시 0.x 입력 (페이지 개념 없는 단일 캔버스). 최상위 박스
   * 배열로서 정규화에서 1원소 `pages`의 `children`으로 이동한다. 신규 코드는
   * `pages`를 사용할 것.
   */
  children?: BoxData[];

};

/**
 * 문서 데이터를 신형(페이지 모델)으로 정규화한다.
 *
 * 단일 소스 규칙: DOM `data` setter와 `DocumentEngine` 양쪽이 이 함수를 공유한다.
 * - `pages`가 있으면 그대로 반환 (신형).
 * - `pages`가 없고 `children`(레거시 PageData 배열)이 있으면 1원소 pages로 래핑.
 *   레거시 루트의 `threads`·전역 스타일은 문서 속성으로 승격되어 그대로 유지된다.
 * - 양쪽 모두 없으면 `pages: []`.
 *
 * 원본 객체는 변경하지 않는다 (순수 함수).
 *
 * @param raw - 정규화 전 문서 데이터 (레거시 또는 신형)
 * @returns 정규화된 신형 문서 데이터 (pages 필드 보장)
 *
 * @example
 * ```ts
 * // 레거시 입력 — children이 pages로 래핑된다
 * normalizeDocumentData({ width: 257, height: 370, columns: 6, gap: 3,
 *   paragraphStyle: {}, textStyle: {}, children: [box] });
 * // → { pages: [{ width: 257, ..., children: [box] }] }
 *
 * // 신형 입력 — 무변경 반환
 * normalizeDocumentData({ pages: [{ width: 257, ... }] });
 * // → { pages: [{ width: 257, ... }] }
 * ```
 */
export function normalizeDocumentData(raw: DocumentData): Required<Pick<DocumentData, "pages">> & DocumentData {
  if (raw.pages !== undefined) {
    return { ...raw, pages: raw.pages, pageStart: raw.pageStart ?? 'right', spreadPages: raw.spreadPages ?? 2 };
  }
  const legacyChildren = raw.children ?? [];
  const legacy = raw as DocumentData & {
    width?: number; height?: number;
    columns?: number | number[]; gap?: number | number[];
  };
  return {
    ...raw,
    pageStart: raw.pageStart ?? 'right',
    spreadPages: raw.spreadPages ?? 2,
    pages: [{
      width: legacy.width ?? 0,
      height: legacy.height ?? 0,
      columns: legacy.columns ?? 1,
      gap: legacy.gap ?? 0,
      paragraphStyle: raw.paragraphStyle ?? {},
      textStyle: raw.textStyle ?? {},
      children: legacyChildren,
    }],
  };
}

/**
 * 레거시 판정. 레거시 입력(페이지 개념 없는 단일 캔버스)이면 true.
 * 판정 근거: `pages` 필드 부재. `children`이 PageData 배열이었던 0.x 입력만
 * 레거시로 간주한다.
 *
 * @param raw - 판정 대상 문서 데이터
 * @returns 레거시 형태이면 true
 */
export function isLegacyDocumentData(raw: DocumentData): boolean {
  return raw.pages === undefined && raw.children !== undefined;
}

/** BoxData 재수출 (정규화 계약 문서용 — 실제 소비는 page.type.ts). */
export type { BoxData };