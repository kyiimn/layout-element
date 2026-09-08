import type { LineGapMode } from "@/types";
import { DEFAULT_LINE_GAP, DEFAULT_LINE_GAP_FIXED, DEFAULT_LINE_GAP_MODE } from "@/constants";

/**
 * effective 스타일에서 행간 모드별 lineGap 값을 해석한다.
 *
 * `lineGapMode`와 `lineGap`은 독립 필드이므로 mode만 주입되고 lineGap이
 * 생략된 상태가 존재한다. 이때 배율용 기본값(DEFAULT_LINE_GAP = 1.25)이
 * 그대로 mm로 재해석되는 footgun을 방지한다:
 *
 * - mode가 `'fixed'`/`'fixed-min'`이고 lineGap이 undefined/미주입 →
 *   `DEFAULT_LINE_GAP_FIXED`(6mm) 적용
 * - lineGap이 명시되어 있으면 항상 그 값을 유지 (주입값 우선)
 * - mode가 `'ratio'`(또는 생략)이면 기존 `DEFAULT_LINE_GAP` 유지 — byte-identical
 *
 * 소비처: ParagraphEngine(`_initLayoutMetrics` 등 effective 스타일 소비 지점),
 * GridCalculatorEngine, DocumentEngine._documentContainerMetrics.
 *
 * @param paragraphStyle - 병합된 문단 스타일 (주입/상속/기본 병합 결과)
 * @param paragraphStyle.lineGap - 행간 값 (mode에 따라 배율 또는 mm)
 * @param paragraphStyle.lineGapMode - 행간 계산 모드
 * @returns 모드별로 기본값이 보정된 lineGap (mm 또는 배율)
 * @throws 없음 — 입력 검증을 하지 않는다 (기존 lineGap 미검증과 동일 파리티)
 * @example
 * ```ts
 * resolveLineGap({ lineGap: 6, lineGapMode: 'fixed' });    // 6 (명시값 우선)
 * resolveLineGap({ lineGapMode: 'fixed' });                // 6 (DEFAULT_LINE_GAP_FIXED)
 * resolveLineGap({ lineGapMode: 'fixed-min' });            // 6 (DEFAULT_LINE_GAP_FIXED)
 * resolveLineGap({ lineGap: 1.5, lineGapMode: 'ratio' });  // 1.5 (기존 동작)
 * resolveLineGap({});                                      // 1.25 (DEFAULT_LINE_GAP)
 * ```
 */
export function resolveLineGap(paragraphStyle: {
  lineGap?: number;
  lineGapMode?: LineGapMode;
}): number {
  const mode = paragraphStyle.lineGapMode ?? DEFAULT_LINE_GAP_MODE;
  if (paragraphStyle.lineGap !== undefined) {
    return paragraphStyle.lineGap;
  }
  return mode === "fixed" || mode === "fixed-min"
    ? DEFAULT_LINE_GAP_FIXED
    : DEFAULT_LINE_GAP;
}

/**
 * 행간 모드에 따른 라인 높이(mm)를 계산한다.
 *
 * lineHeight 도출 공식의 단일 소스. `ParagraphEngine`
 * (`_initLayoutMetrics`, `_createLineWithParts`, `_computePerLineHeights`,
 * `_confirmLineHeight`), `GridCalculatorEngine._calcColumnGridCoords`,
 * `DocumentEngine._documentContainerMetrics`가 모두 이 함수를 사용한다.
 *
 * 모드별 공식:
 * - `'ratio'`: `maxFontSizeMm × lineGap` (lineGap은 fontSize 배율)
 * - `'fixed'`: `lineGap` (고정 mm, fontSize 무시)
 * - `'fixed-min'`: `max(lineGap, maxFontSizeMm)` (최소 보장 mm,
 *   라인 최대 폰트가 더 크면 그 값으로 스케일업)
 *
 * `'ratio'` 분기는 기존 `maxFontSizeMm * lineGap` 공식과 피연산 순서까지
 * 동일하므로, 기본 모드에서의 결과는 byte-identical이다.
 *
 * @param lineGap - 행간 값. mode에 따라 배율(`'ratio'`) 또는 mm(`'fixed'`, `'fixed-min'`)
 * @param mode - 행간 계산 모드
 * @param maxFontSizeMm - 라인의 최대 폰트 크기 (mm). GC/문서 컨테이너 계산에서는
 *   인라인 개념이 없으므로 문단 기본 fontSize를 전달한다.
 * @returns 라인 높이 (mm)
 * @throws 없음 — 입력 검증을 하지 않는다 (기존 `lineGap`의 음수/0 미검증과 동일 파리티)
 * @example
 * ```ts
 * computeLineHeightMm(1.25, 'ratio', 4);    // 5   (4 × 1.25)
 * computeLineHeightMm(6, 'fixed', 4);       // 6   (fontSize 무시)
 * computeLineHeightMm(5, 'fixed-min', 8);   // 8   (max(5, 8) — 스케일업)
 * computeLineHeightMm(5, 'fixed-min', 4);   // 5
 * ```
 *
 * mode별 lineGap 기본값 보정이 필요하면 `resolveLineGap()`을 먼저 사용한다.
 */
export function computeLineHeightMm(
  lineGap: number,
  mode: LineGapMode,
  maxFontSizeMm: number,
): number {
  switch (mode) {
    case "fixed":
      return lineGap;
    case "fixed-min":
      return Math.max(lineGap, maxFontSizeMm);
    case "ratio":
    default:
      return maxFontSizeMm * lineGap;
  }
}