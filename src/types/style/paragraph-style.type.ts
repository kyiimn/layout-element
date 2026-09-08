/** 수평 정렬 방식. 'justify'는 양쪽 정렬 (신문 본문에서 주로 사용) */
export type TextAlign = 'left' | 'right' | 'center' | 'justify';

/** 수직 정렬 방식. 박스 내에서 텍스트 콘텐츠의 수직 위치 */
export type VerticalAlign = 'top' | 'center' | 'bottom';

/**
 * 걸침표 (hanging punctuation) 방향별 설정.
 *
 * 필드를 생략하면 해당 방향은 OFF이다.
 *
 * @example
 * // 행말 걸침만 켜기 (표준 — 오버플로우 시에만 걸침)
 * { lineEnd: true }
 * // 행말 + 행두 걸침 모두 켜기
 * { lineEnd: true, lineStart: true }
 * // 행말 강제 걸침 — 줄 안에 들어맞아도 항상 컬럼 밖으로 걸침
 * { lineEnd: 'always' }
 */
export type HangingPunctuationConfig = {
  /**
   * 행말 걸침: 닫기 문장부호(`. , ) ] }` 등)를 줄 우측 밖으로 걸침.
   *
   * - `true` — **표준 걸침** (InDesign ぶら下げ「標準」/ CSS `allow-end`):
   *   부호가 다음 줄 행두로 넘어갈 위기(오버플로우)일 때만 위 줄 끝으로
   *   당겨와 걸친다. 줄 안에 들어맞으면 그대로 둔다.
   * - `'always'` — **강제 걸침** (InDesign ぶら下げ「強制」/ CSS `force-end`):
   *   줄 끝의 닫기 부호가 이미 컬럼 폭 안에 들어맞아도 컬럼 우측 밖으로
   *   내보내 걸친다. 나머지 글자가 정렬을 다시 채워 텍스트 가장자리를
   *   맞춘다. 블록 마지막 줄(`\n` 직전)과 텍스트 마지막 줄은 좌측 정렬
   *   대상이 아니므로 제외된다.
   */
  lineEnd?: boolean | 'always';

  /** 행두 걸침: 열기 문장부호(`( [ {` 등)가 다음 줄 시작 왼쪽 밖으로 걸침 */
  lineStart?: boolean;
};

/**
 * 행간 계산 모드.
 *
 * - `'ratio'` — `lineGap`을 fontSize 배율로 해석 (기본값, 기존 동작과 byte-identical)
 * - `'fixed'` — `lineGap`을 **고정 mm** 행 높이로 해석 (InDesign 고정 행간)
 * - `'fixed-min'` — `lineGap`을 **최소 보장 mm** 행 높이로 해석. 라인의
 *   `maxFontSize`가 고정값보다 크면 그 값(maxFontSize 자체, 배율 재적용 없음)으로 스케일업
 */
export type LineGapMode = 'ratio' | 'fixed' | 'fixed-min';

/**
 * 문단 수준의 레이아웃 속성을 정의.
 *
 * `lineGap`의 해석은 `lineGapMode`에 따른다. 기본 모드(`'ratio'`)에서는
 * `lineGap`이 `fontSize`에 대한 **배율**이며, 실제 행 높이(lineHeight)는
 * `computeLineHeightMm()`(src/engine/line-height.ts) 단일 소스로 계산된다.
 *
 * | mode | lineGap | fontSize (mm) | lineHeight (mm) | 설명 |
 * |------|---------|---------------|-----------------|------|
 * | ratio | 1.5 | 4 | 6 | 150% 행간 (배율) |
 * | fixed | 6 | 4 | 6 | 고정 6mm (fontSize 무시) |
 * | fixed-min | 5 | 4 | 5 | 최소 보장 5mm |
 * | fixed-min | 5 | 8 | 8 | 8mm 인라인 글자 → max(5, 8) 스케일업 |
 */
export type ParagraphStyle = {
  /**
   * 행간 값. `lineGapMode`에 따라 해석이 달라진다 (기본 모드 'ratio': 배율).
   *
   * 생략 시 모드별 기본값이 적용된다 — 'ratio': `DEFAULT_LINE_GAP`(1.25 배율),
   * 'fixed'/'fixed-min': `DEFAULT_LINE_GAP_FIXED`(6mm). 명시하면 항상 그 값을 유지한다.
   */
  lineGap?: number;

  /**
   * 행간 계산 모드. 기본값: `'ratio'` (생략 시 기존 동작과 byte-identical).
   *
   * 비인라인(non-inlinable) 문단 필드 — 런에 적용되지 않고 항상 문단 소속이다.
   * 그리드(static box 그리드 좌표·`absHeight`·insert 스냅·가이드 컬럼)는
   * **문서 수준** `DocumentData.paragraphStyle`의 모드를 따르고, 문단 자체의
   * 텍스트 라인 높이는 문단 effective 스타일의 모드를 따른다 (기존 `lineGap`과
   * 동일한 두 층위 구조).
   *
   * @example
   * ```ts
   * // 고정 6mm 행간
   * paragraph.paragraphStyle = { lineGap: 6, lineGapMode: 'fixed' };
   * // 최소 5mm — 8mm 인라인 글자가 있는 줄만 8mm로 스케일업
   * paragraph.paragraphStyle = { lineGap: 5, lineGapMode: 'fixed-min' };
   * // lineGap 생략 — fixed 계열은 기본 6mm (DEFAULT_LINE_GAP_FIXED)
   * paragraph.paragraphStyle = { lineGapMode: 'fixed' };
   * ```
   */
  lineGapMode?: LineGapMode;

  /** 수직 정렬. 기본값: 'top' */
  verticalAlign?: VerticalAlign;

  /** 수평 정렬. 기본값: 'justify' */
  textAlign?: TextAlign;

  /**
   * 걸침표 (hanging punctuation). 기본값: false (OFF).
   *
   * - `true`: 행말 + 행두 걸침 모두 ON
   * - `HangingPunctuationConfig` 객체: 방향별 설정
   * - `false`/`undefined`: OFF — 기존 레이아웃과 byte 단위로 동일
   *
   * 걸침은 금칙(禁則) 교정에 우선한다. ON일 때 닫기 부호가 다음 줄
   * 행두에 놓일 상황에서는 금칙 push-down 대신 걸침으로 교정하고,
   * 열기 부호가 행말에 놓일 상황에서는 금칙 pull-up 대신 다음 줄
   * 행두 왼쪽 밖으로 내보낸다. 비인라인(non-inlinable) 문단 필드이므로
   * 스타일 주입 시 항상 문단 스타일로 적용된다.
   *
   * @example
   * ```ts
   * // 문단에 걸침표 전체 ON
   * paragraph.paragraphStyle = { ...paragraph.paragraphStyle, hangingPunctuation: true };
   * // 행말 걸침만 ON
   * paragraph.paragraphStyle = { hangingPunctuation: { lineEnd: true } };
   * ```
   */
  hangingPunctuation?: boolean | HangingPunctuationConfig;
}