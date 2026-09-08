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
 * 문단 수준의 레이아웃 속성을 정의.
 *
 * `lineGap`은 `fontSize`에 대한 **배율**이다. 실제 행 높이(lineHeight)는 다음과 같이 계산된다:
 * `lineHeight = fontSize × lineGap`
 *
 * | lineGap | fontSize (mm) | lineHeight (mm) | 설명 |
 * |---------|---------------|-----------------|------|
 * | 1 | 4 | 4 | 글자 크기와 행 높이 동일 (빽빽함) |
 * | 1.5 | 4 | 6 | 150% 행간 |
 * | 2 | 4 | 8 | 200% 행간 (더블 스페이싱) |
 */
export type ParagraphStyle = {
  /** 행간 배율. `lineHeight = fontSize × lineGap`. 기본값: 1 */
  lineGap?: number;

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