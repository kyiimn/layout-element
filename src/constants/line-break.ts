/**
 * 한글 조판 금칙문자 (행두/행말 금지) 상수 테이블.
 *
 * 한글과 CJK 조판에는 서양의 hyphenation 개념 대신, 줄 시작/끝에 올 수
 * 없는 문자를 정하는 금칙(禁則) 규칙이 있다. 본 테이블은 `TextLayoutEngine`
 * 의 줄바꿈 후처리에서 참조한다.
 *
 * @see docs/TEXT_ENGINE.md §22 (금칙문자 줄바꿈 규칙)
 */

/**
 * 행두 금지 문자 — 줄의 시작(첫 글자)에 올 수 없는 문자.
 * 주로 닫기 괄호·구두점·닫기 따옴표류.
 */
export const LINE_START_FORBIDDEN: ReadonlySet<string> = new Set([
  // 구두점
  '.', ',',
  // ASCII 닫기 괄호
  ')', ']', '}',
  // 전각 닫기 괄호
  '）', '］', '｝', '〕',
  // CJK 닫기 괄호
  '』', '」', '】', '》',
  // 닫기 따옴표 (곡선 + 직선)
  '’', '”', // "'", '"',
]);

/**
 * 행말 금지 문자 — 줄의 끝(마지막 글자)에 올 수 없는 문자.
 * 주로 열기 괄호·열기 따옴표류.
 */
export const LINE_END_FORBIDDEN: ReadonlySet<string> = new Set([
  // ASCII 열기 괄호
  '(', '[', '{',
  // 전각 열기 괄호
  '（', '［', '｛', '〔',
  // CJK 열기 괄호
  '『', '「', '【', '《',
  // 열기 따옴표 (곡선 + 직선)
  '‘', '“', // "'", '"',
]);

/**
 * 주어진 문자가 행두(줄 시작) 금지 문자인지 확인한다.
 *
 * @param char - 검사할 단일 문자. 다중 코드 유닛 surrogate pair인 경우
 *   `string.codePointAt` 기반으로 1그래프eme 단위 검사가 필요하나,
 *   본 테이블은 BMP 내 문자로만 구성되어 단일 code unit 비교로 충분하다.
 * @returns 금지 문자면 `true`
 *
 * @example
 * isLineStartForbidden('.')   // true
 * isLineStartForbidden(')')   // true
 * isLineStartForbidden('가')   // false
 */
export function isLineStartForbidden(char: string): boolean {
  return LINE_START_FORBIDDEN.has(char);
}

/**
 * 주어진 문자가 행말(줄 끝) 금지 문자인지 확인한다.
 *
 * @param char - 검사할 단일 문자
 * @returns 금지 문자면 `true`
 *
 * @example
 * isLineEndForbidden('(')   // true
 * isLineEndForbidden('가')  // false
 */
export function isLineEndForbidden(char: string): boolean {
  return LINE_END_FORBIDDEN.has(char);
}

/**
 * 행말 걸침 대상 문자 집합 — 닫기 문장부호.
 *
 * `LINE_START_FORBIDDEN`(행두 금지)와 동일한 집합이다. 닫기 부호가
 * 다음 줄 행두에 놓이는 위반이 걸침 교정의 대상이기 때문이다.
 * 직선 따옴표(`'`, `"`)는 행두 금지 테이블에서 주석 처리되어 있으므로
 * 걸침 대상에도 포함되지 않는다 (곡선 따옴표 `’`, `”`만 포함).
 */
export const HANG_LINE_END: ReadonlySet<string> = LINE_START_FORBIDDEN;

/**
 * 행두 걸침 대상 문자 집합 — 열기 문장부호.
 *
 * `LINE_END_FORBIDDEN`(행말 금지)와 동일한 집합이다. 열기 부호가
 * 행말에 놓이는 위반이 행두 걸침(다음 줄 왼쪽 밖) 교정의 대상이기 때문이다.
 */
export const HANG_LINE_START: ReadonlySet<string> = LINE_END_FORBIDDEN;

/**
 * 주어진 문자가 행말 걸침 대상(닫기 문장부호)인지 확인한다.
 *
 * @param char - 검사할 단일 문자
 * @returns 행말 걸침 대상이면 `true`
 * @throws 없음
 *
 * @example
 * isHangableLineEnd('.')  // true
 * isHangableLineEnd('가') // false
 */
export function isHangableLineEnd(char: string): boolean {
  return HANG_LINE_END.has(char);
}

/**
 * 주어진 문자가 행두 걸침 대상(열기 문장부호)인지 확인한다.
 *
 * @param char - 검사할 단일 문자
 * @returns 행두 걸침 대상이면 `true`
 * @throws 없음
 *
 * @example
 * isHangableLineStart('(') // true
 * isHangableLineStart(')') // false
 */
export function isHangableLineStart(char: string): boolean {
  return HANG_LINE_START.has(char);
}