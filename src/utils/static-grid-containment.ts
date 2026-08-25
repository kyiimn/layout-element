import type { LayoutBoxElement } from "@/components/layout/box.element";
import type { LayoutDocumentElement } from "@/components/layout/document.element";
import type { LayoutTableCellElement } from "@/components/layout/td.element";

/**
 * static 좌표계(컬럼 인덱스 × 라인 수)에서 요소의 영역이 컨테이너의
 * 편집 그리드 내에 완전히 포함되는지 검증한다.
 *
 * absolute 모드와 달리 static 모드는 좌표계가 "컬럼 인덱스"와 "라인 수"이므로,
 * 픽셀 단위의 4꼭짓점 containment가 아닌 그리드 범위 containment로 검증해야 한다.
 *
 * 컨테이너의 그리드는 `model.columnCount`(컬럼 수)와 라인 수로 정의된다.
 * 요소의 `left + width`(컬럼 인덱스 + 스팬)가 컨테이너의 컬럼 수를 초과하거나,
 * `top + height`(라인 인덱스 + 라인 수)가 컨테이너의 라인 수를 초과하면
 * 컨테이너 밖으로 벗어나므로 `false`를 반환한다.
 *
 * static box 렌더링 원칙: 박스 높이 N라인 = (N-1)*lineHeight + fontSize.
 * 마지막 라인의 line gap(= lineHeight - fontSize)은 렌더링에서 제외된다.
 * 컨테이너가 수용할 수 있는 최대 라인 인덱스 + 1 (= 라인 수)은:
 *   floor((editableTextHeight - fontSize) / lineHeight) + 1
 *
 * @param container - 삽입 대상 컨테이너 (LayoutDocumentElement 또는 LayoutBoxElement)
 * @param elementLeft - 요소의 static left (컬럼 인덱스, 0부터)
 * @param elementTop - 요소의 static top (라인 인덱스, 0부터)
 * @param elementWidth - 요소의 static width (컬럼 스팬 수, ≥1)
 * @param elementHeight - 요소의 static height (라인 수, ≥1)
 * @returns 요소 영역이 컨테이너 그리드 내에 완전히 포함되면 `true`, 아니면 `false`
 *
 * @example
 * ```ts
 * // 4컬럼 box에 left=2, width=3 → 컬럼 4(인덱스 0~3 범위 초과) → false
 * staticGridContains(box, 2, 5, 3, 10); // false
 * // 4컬럼 box에 left=1, width=3 → 컬럼 1,2,3 (인덱스 3 이내) → true
 * staticGridContains(box, 1, 5, 3, 10); // true
 * // editableTextHeight=180, fontSize=4, lineHeight=5 → (180-4)/5=35.2 → 36줄
 * // top=22, height=15 → bottom=37 > 36 → false
 * staticGridContains(box, 0, 22, 3, 15); // false
 * ```
 */
export function staticGridContains(
  container: LayoutDocumentElement | LayoutBoxElement | LayoutTableCellElement,
  elementLeft: number,
  elementTop: number,
  elementWidth: number,
  elementHeight: number,
): boolean {
  const model = container.model;
  if (!model) return false;

  const { columnCount, lineHeight, editableTextHeight, fontSize } = model;

  const containerLineCount = lineHeight > 0
    ? Math.floor(Math.round(((editableTextHeight - fontSize) / lineHeight) * 1e6) / 1e6) + 1
    : 0;

  if (elementLeft < 0) return false;
  if (elementWidth < 1) return false;
  if (elementLeft + elementWidth > columnCount) return false;

  if (elementTop < 0) return false;
  if (elementHeight < 1) return false;
  if (elementTop + elementHeight > containerLineCount + 1e-6) return false;

  return true;
}

/**
 * static 좌표계에서 요소의 left/top/width/height를 컨테이너 그리드 내에 맞춘다.
 *
 * - `left`는 `0 ~ columnCount - width` 범위로 clamp.
 * - `width`는 `1 ~ columnCount` 범위로 clamp.
 * - `top`는 `0 ~ containerLineCount - height` 범위로 clamp.
 * - `height`는 `1 ~ containerLineCount` 범위로 clamp.
 *
 * `containerLineCount`는 static box 렌더링 원칙((N-1)*lineHeight + fontSize)에
 * 따라 `floor((editableTextHeight - fontSize) / lineHeight) + 1`로 계산한다.
 *
 * @param container - 삽입 대상 컨테이너
 * @param left - 요소의 static left (컬럼 인덱스)
 * @param top - 요소의 static top (라인 인덱스)
 * @param width - 요소의 static width (컬럼 스팬 수)
 * @param height - 요소의 static height (라인 수)
 * @returns 컨테이너 그리드 내에 맞춰진 `{ left, top, width, height }`
 *
 * @example
 * ```ts
 * // 3컬럼 box에 left=2, width=2 → left=2+2=4 > 3 → left=1, width=2
 * clampStaticToContainer(box, 2, 0, 2, 5); // { left: 1, top: 0, width: 2, height: 5 }
 * // 3컬럼 box에 width=5 → width=3
 * clampStaticToContainer(box, 0, 0, 5, 5); // { left: 0, top: 0, width: 3, height: 5 }
 * ```
 */
export function clampStaticToContainer(
  container: LayoutDocumentElement | LayoutBoxElement | LayoutTableCellElement,
  left: number,
  top: number,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const model = container.model;
  if (!model) return { left: 0, top: 0, width: 1, height: 1 };

  const { columnCount, lineHeight, editableTextHeight, fontSize } = model;
  const containerLineCount = lineHeight > 0
    ? Math.floor(Math.round(((editableTextHeight - fontSize) / lineHeight) * 1e6) / 1e6) + 1
    : 1;

  const clampedWidth = Math.max(1, Math.min(width, columnCount));
  const clampedHeight = Math.max(1, Math.min(height, containerLineCount));
  const clampedLeft = Math.max(0, Math.min(left, columnCount - clampedWidth));
  const clampedTop = Math.max(0, Math.min(top, Math.max(0, containerLineCount - clampedHeight)));

  return { left: clampedLeft, top: clampedTop, width: clampedWidth, height: clampedHeight };
}

/**
 * absolute 좌표계에서 요소의 left/top/width/height를 컨테이너 편집 영역 내에 맞춘다.
 *
 * - `left`는 `0 ~ editableWidth - width` 범위로 clamp.
 * - `width`는 `1 ~ editableWidth` 범위로 clamp.
 * - `top`는 `0 ~ editableHeight - height` 범위로 clamp.
 * - `height`는 `1 ~ editableHeight` 범위로 clamp.
 *
 * @param container - 삽입 대상 컨테이너
 * @param leftMm - 요소의 absolute left (mm)
 * @param topMm - 요소의 absolute top (mm)
 * @param widthMm - 요소의 absolute width (mm)
 * @param heightMm - 요소의 absolute height (mm)
 * @returns 컨테이너 편집 영역 내에 맞춰진 `{ left, top, width, height }` (mm)
 *
 * @example
 * ```ts
 * // editableWidth=200mm에 left=150, width=100 → 150+100=250 > 200 → left=100, width=100
 * clampAbsoluteToContainer(box, 150, 0, 100, 50); // { left: 100, top: 0, width: 100, height: 50 }
 * // editableWidth=200mm에 width=300 → width=200
 * clampAbsoluteToContainer(box, 0, 0, 300, 50); // { left: 0, top: 0, width: 200, height: 50 }
 * ```
 */
export function clampAbsoluteToContainer(
  container: LayoutDocumentElement | LayoutBoxElement | LayoutTableCellElement,
  leftMm: number,
  topMm: number,
  widthMm: number,
  heightMm: number,
): { left: number; top: number; width: number; height: number } {
  const model = container.model;
  if (!model) return { left: 0, top: 0, width: 1, height: 1 };

  const { editableWidth, editableHeight } = model;

  const clampedWidth = Math.max(1, Math.min(widthMm, editableWidth));
  const clampedHeight = Math.max(1, Math.min(heightMm, editableHeight));
  const clampedLeft = Math.max(0, Math.min(leftMm, Math.max(0, editableWidth - clampedWidth)));
  const clampedTop = Math.max(0, Math.min(topMm, Math.max(0, editableHeight - clampedHeight)));

  return { left: clampedLeft, top: clampedTop, width: clampedWidth, height: clampedHeight };
}