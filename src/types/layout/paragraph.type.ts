import { ParagraphStyle, TextStyle } from "../style";
import { TextInlineData } from "./text/text-inline.type";

/**
 * 다중 컬럼 텍스트 영역 데이터. 텍스트 래핑, 인라인 런 스타일링을 지원한다.
 *
 * `ParagraphEngine.layoutStructure()` + `layoutText()`이 텍스트를 래핑하여 `TextLineData[]`로 변환하고,
 * `LayoutColumnElement`가 이를 렌더링한다.
 *
 * `content` 필드는 두 가지 형태를 지원:
 * 1. `"단순 문자열"` → 전체에 동일 스타일 적용
 * 2. `["문자열", TextInlineData, ...]` → 하나의 연속 텍스트 흐름에서 구간별 개별 스타일
 *
 * @example
 * // 단순 문자열
 * { type: 'paragraph', content: "모든 텍스트에 동일한 스타일" }
 *
 * @example
 * // 인라인 런 스타일
 * {
 *   type: 'paragraph',
 *   content: [
 *     "기본 스타일 텍스트 ",
 *     { content: "굵은 텍스트", textInlineStyle: { fontWeight: 700 } },
 *     " 다시 기본 스타일"
 *   ]
 * }
 */

/**
 * paragraph가 다른 요소의 overlay(텍스트 회피) 대상이 될지 제어한다.
 *
 * `ImageData.overlapMode`와 대칭 구조이지만, paragraph는 텍스트 영역이므로
 * 이미지의 `'path'` 모드(투명 픽셀 경로 추종)는 적용하지 않는다.
 *
 * - `'box'`: (기본값) paragraph를 감싼 박스가 다른 paragraph의 텍스트 회피 대상이 된다.
 * - `'none'`: paragraph를 감싼 박스가 다른 paragraph의 텍스트 회피 대상에서 제외된다.
 *   본문과 시각적으로 겹치되 텍스트가 회피하지 않아야 하는 영역에 사용한다.
 */
export type ParagraphOverlapMode = 'box' | 'none';

export type ParagraphData = {
  /** 타입 식별자 (리터럴) */
  type: 'paragraph';

  /** 고유 식별자 */
  id?: string;

  /**
   * 하위 컬럼 그리드 정의. `DocumentData.columns`와 동일 형식.
   * 생략 시 부모의 컬럼 설정을 상속받음.
   */
  column?: number | number[];

  /**
   * 하위 컬럼 간격. `DocumentData.gap`과 동일 형식.
   * 생략 시 부모의 간격 설정을 상속받음.
   */
  gap?: number | number[];

  /**
   * 텍스트 콘텐츠.
   * - `string`: 전체에 동일 스타일 적용
   * - `(string | TextInlineData)[]`: 하나의 연속 텍스트 흐름에서 구간별 개별 스타일.
   *   런은 라인 경계와 무관하며 `\n`으로 라인이 분리된다.
   */
  content: string | (string | TextInlineData)[];

  /** 문단 스타일. 상위 `InheritStyle`의 값을 오버라이드 */
  paragraphStyle?: ParagraphStyle;

  /** 텍스트 스타일. 상위 `InheritStyle`의 값을 오버라이드 */
  textStyle?: TextStyle;

  /** 렌더링 순서 (z-index) */
  zIndex?: number;

  /**
   * 다른 paragraph가 이 paragraph를 감싼 박스를 텍스트 회피 대상으로 취급할지 제어.
   * 생략 시 `'box'`(회피 대상)가 적용된다.
   *
   * `'none'`으로 설정하면 다른 paragraph가 이 박스와 겹쳐도 텍스트를 회피하지 않는다.
   * 본문과 시각적으로 겹치되 텍스트 회피가 필요 없는 영역에 사용한다.
   *
   * @example
   * // 오버랩 박스 위를 겹치는 paragraph — 다른 paragraph가 이 영역을 회피하지 않음
   * { type: 'paragraph', content: "겹침 텍스트", overlapMode: 'none' }
   */
  overlapMode?: ParagraphOverlapMode;
}