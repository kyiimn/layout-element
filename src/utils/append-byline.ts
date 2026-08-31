/**
 * 바이라인(검별)을 본문 텍스트 맨 뒤에 결합한다.
 *
 * byline이 빈 문자열이면 본문을 그대로 반환한다. 존재하면
 * 탭 문자(`\t`)를 구분자로 사용하여 `{body}\t{byline}` 형태로 결합한다.
 *
 * @param body - 기사 본문 텍스트
 * @param byline - 기자명(검별). 빈 문자열일 수 있다.
 * @returns byline이 결합된 본문 텍스트
 *
 * @example
 * ```ts
 * appendBylineToBody('본문 내용', '─ 홍길동 기자');
 * // → '본문 내용\t─ 홍길동 기자'
 *
 * appendBylineToBody('본문 내용', '');
 * // → '본문 내용'
 * ```
 */
export const appendBylineToBody = (body: string, byline: string): string => {
  if (!byline) return body;
  return `${body}\t${byline}`;
};