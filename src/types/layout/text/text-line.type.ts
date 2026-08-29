import { TextInlineStyle } from "../../style";

/**
 * `TextLayoutEngine.layoutText()`의 출력물. 텍스트 래핑 후 **한 줄**에 해당하는 데이터.
 *
 * **내부 전용 타입**: 외부에서 직접 생성하지 않는다.
 * `TextLayoutEngine`이 텍스트 래핑 과정에서 자동 생성하며,
 * `LayoutColumnElement`가 이 데이터를 소비하여 각 줄을 렌더링한다.
 *
 * 플래그 조합 예시:
 * | firstOfBlock | endOfBlock | firstOfText | endOfText | 의미 |
 * |:---:|:---:|:---:|:---:|------|
 * | ✓ | ✓ | ✓ | ✓ | 전체 텍스트가 한 줄 |
 * | ✓ | | ✓ | | 첫 블록의 첫 줄 |
 * | | ✓ | | | 어떤 블록의 마지막 줄 |
 * | ✓ | | | | 새 블록의 시작 줄 |
 * | | | | ✓ | 전체 텍스트의 마지막 줄 |
 */

export type OverlapParts = { x1: number; x2: number; };

export type TextPartData = {
  /** 이 파트(세그먼트)에 포함된 글자 배열 (글자 단위 분리) */
  content: string[];

  /**
   * 각 글자에 적용되는 인라인 스타일.
   *
   * `content[i]`에 대응하며, 원소가 `undefined`이면 해당 글자는
   * 문단 기본 스타일을 사용한다. 런(run) 경계에서 파트가 분할되므로
   * 하나의 파트 내부에서는 일반적으로 동일한 스타일이 적용되지만,
   * 금칙 교정 등으로 런 경계를 가로지르는 파트에서는 글자별로
   * 다른 스타일이 지정될 수 있다.
   */
  inlineStyles?: (TextInlineStyle | undefined)[];

  /** 줄 시작점으로부터의 좌측 여백 (mm) - 오버랩 요소 회피용 */
  left: number;

  /** 파트의 가로 폭 (mm) - 텍스트가 배치될 수 있는 공간 */
  width: number;

  /**
   * 각 글자의 파트 내 x 오프셋 (mm, 정렬 반영).
   *
   * `TextLayoutEngine._computeCharOffsets()` 후처리 패스가 산출한다.
   * `content[i]`의 좌측 끝 x 좌표(파트 기준)가 `charOffsets[i]`에 저장된다.
   * 글자의 렌더링 폭(`genCharStyle()`의 `width`)과 무관하게,
   * `textAlign`(`left`/`right`/`center`/`justify`)에 따른 정렬 후 위치이다.
   *
   * - `left`: `charOffsets[i] = Σ charWidth[0..i-1]`
   * - `right`: `charOffsets[i] = (partWidth - Σ charWidth) + Σ charWidth[0..i-1]`
   * - `center`: `charOffsets[i] = (partWidth - Σ charWidth) / 2 + Σ charWidth[0..i-1]`
   * - `justify`: 첫 글자는 0, 마지막 글자는 `partWidth - lastCharWidth`,
   *   중간 간격은 `(partWidth - Σ charWidth) / (charCount - 1)`로 균등 분배.
   *   단, 마지막 줄(`endOfBlock`)이거나 글자가 1개이면 `left`와 동일.
   *
   * `undefined`인 경우 레거시 호환 — `LayoutColumnElement.renderText()`는
   * 기존 flexbox `justify-content` 경로로 폴백한다.
   *
   * 글자 폭에는 `letterSpacingMm`이 포함되어 있으므로(see `_charWidthMm` 호출부),
   * `charOffsets` 산출 시 letter-spacing을 별도로 더하지 않는다.
   */
  charOffsets?: number[];
};

export type TextLineData = {
  /** 이 줄이 라인의 첫 번째 줄인지 (`\n` 직후 라인) */
  firstOfBlock?: boolean;

  /** 이 줄이 전체 텍스트의 첫 번째 줄인지 */
  firstOfText?: boolean;

  /** 이 줄이 라인의 마지막 줄인지 (`\n` 직전 라인) */
  endOfBlock?: boolean;

  /** 이 줄이 전체 텍스트의 마지막 줄인지 */
  endOfText?: boolean;

  /** 이 줄을 구성하는 수평 파트(오버랩 영역 사이의 세그먼트) 목록 */
  parts: TextPartData[];

  /**
   * 이 줄의 최대 폰트 크기 (mm).
   *
   * 줄에 배치된 모든 파트의 인라인 스타일(`inlineStyles[j].fontSize`)과
   * 문단 기본 폰트 크기 중 최대값이다. 라인 높이(`lineHeight`)의 산출 근거.
   *
   * 빈 줄(cover 줄 등)이거나 인라인 스타일이 없는 줄은 문단 기본 폰트 크기와 같다.
   */
  maxFontSize?: number;

  /**
   * 이 줄의 높이 (mm). `maxFontSize × lineGap`으로 계산된다.
   *
   * 레이아웃 후(post-layout) `_computePerLineHeights()`가 산출한다.
   * 라인 배치/오버플로우 판정 중(레이아웃 과정)에는 아직 채워지지 않는다.
   *
   * 마지막 라인의 line gap 제외 규칙은 소비자가 `maxFontSize`로 처리한다:
   * - `top = cumulativeHeightBefore + alignOffset`
   * - 마지막 라인 높이 = `maxFontSize` (lineGap 미포함)
   */
  lineHeight?: number;
};
