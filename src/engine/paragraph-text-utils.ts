/**
 * ParagraphEngine 텍스트 유틸리티 — 모듈-로컬 순수 함수 모음.
 *
 * `paragraph-engine.ts` 하단에 있던 순수 헬퍼 함수들을 본문 그대로 이동한
 * 파일이다. 클래스 상태에 접근하지 않는 순수 로직만 수용하며, 모든 함수는
 * 파라미터 주입만으로 동작한다.
 *
 * 소비처:
 * - `paragraph-engine.ts` (재-export 유지 — `@/engine/paragraph-engine` import 경로 호환)
 * - `text-edit-controller.ts` (`firstNonEmpty` 색상 폴백 체인)
 *
 * @file src/engine/paragraph-text-utils.ts
 */

import type { TextInlineStyle, TextPartData, TextLineData } from "@/types";

/**
 * 두 인라인 스타일이 필드 단위로 동일한지 비교한다.
 * `undefined`와 빈 객체는 모두 "스타일 없음"으로 동일 취급한다.
 *
 * @param a - 비교 대상 인라인 스타일 A (undefined 허용)
 * @param b - 비교 대상 인라인 스타일 B (undefined 허용)
 * @returns 필드 단위로 동일하면 `true`
 * @throws 없음
 */
export function inlineStyleEqual(a: TextInlineStyle | undefined, b: TextInlineStyle | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) {
    return (a === undefined || Object.keys(a).length === 0) && (b === undefined || Object.keys(b).length === 0);
  }
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.color === b.color &&
    a.letterSpacing === b.letterSpacing &&
    a.widthRatio === b.widthRatio &&
    a.spaceRatio === b.spaceRatio &&
    a.underline === b.underline &&
    a.breakline === b.breakline &&
    a.outline === b.outline &&
    a.underlineColor === b.underlineColor &&
    a.breaklineColor === b.breaklineColor &&
    a.outlineColor === b.outlineColor
  );
}

/**
 * 배열 콘텐츠의 후행 공백 개수 — strip 규칙 계산용.
 *
 * @param content - 글자 배열 콘텐츠
 * @returns 후행 공백(' ') 개수
 * @throws 없음
 */
export function countTrailingSpaces(content: string[]): number {
  let n = 0;
  for (let k = content.length - 1; k >= 0 && content[k] === ' '; k--) n++;
  return n;
}

/**
 * 파트의 strip 범위(라인 경계 공백 제거 범위)를 계산한다.
 *
 * 라인의 첫 파트가 아니면 leading 공백을, 마지막 파트가 아니면
 * trailing 공백을 strip 대상으로 삼는다 (라인 경계 공백은 화면·인쇄
 * 어느 쪽에도 표시되지 않는다).
 *
 * @param part - 파트 데이터
 * @param line - 파트가 속한 라인
 * @param partIdx - 라인 내 파트 인덱스
 * @returns `{ stripStart, stripEnd }` — raw content 기준 strip 범위
 * @throws 없음
 */
export function computeStripRange(part: TextPartData, line: TextLineData, partIdx: number): { stripStart: number; stripEnd: number } {
  const content = part.content;
  const isFirst = partIdx === 0;
  const isLast = partIdx === line.parts.length - 1;
  const firstOfLine = line.firstOfBlock === true;
  const endOfLine = line.endOfBlock === true;
  let stripStart = 0;
  let stripEnd = content.length;
  if (isFirst && !firstOfLine) {
    while (stripStart < stripEnd && content[stripStart] === " ") stripStart++;
  }
  if (isLast && !endOfLine) {
    while (stripEnd > stripStart && content[stripEnd - 1] === " ") stripEnd--;
  }
  return { stripStart, stripEnd };
}

/**
 * 인자 중 첫 번째 비-빈 문자열을 반환한다.
 *
 * 스타일 색상 필드는 `undefined`(미지정)와 `''`(DEFAULT_TEXT_STYLE 기본값)가
 * 모두 "값 없음"이므로 `??` 체인으로는 폴백할 수 없다 — `''`가 nullish가
 * 아니기 때문이다. 엔진(`_computeDecorations`, `buildParagraphPrintPostData`)과
 * 편집 레이어(`_applyOptimisticDecorations`)가 동일 색상 폴백 체인을
 * 구성하는 단일 소스다.
 *
 * @param values - 우선순위 순 문자열들 (undefined 허용)
 * @returns 첫 번째 비-빈 문자열. 모두 비었으면 `''`
 * @throws 없음
 */
export function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const v of values) {
    if (v !== undefined && v !== '') return v;
  }
  return '';
}