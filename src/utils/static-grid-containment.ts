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
 * 컨테이너의 그리드는 `model.columnCount`(컬럼 수)와 `model.editableHeight / model.lineHeight`
 * (라인 수)로 정의된다. 요소의 `left + width`(컬럼 인덱스 + 스팬)가 컨테이너의
 * 컬럼 수를 초과하거나, `top + height`(라인 인덱스 + 라인 수)가 컨테이너의
 * 라인 수를 초과하면 컨테이너 밖으로 벗어나므로 `false`를 반환한다.
 *
 * `editableHeight`는 마지막 줄의 `lineHeight`를 제외한 높이다. 마지막 줄은 그 아래에
 * 위치하지만 `lineHeight`만큼의 공간이 없으므로 높이가 `lineHeight`보다 짧다.
 * 따라서 라인 수는 `Math.floor(editableHeight / lineHeight) + 1`로 계산한다.
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
 * // editableHeight=180, lineHeight=5 → 36줄 + 1(마지막 줄) = 37줄
 * // top=22, height=15 → bottom=37 ≤ 37 → true
 * staticGridContains(box, 0, 22, 3, 15); // true
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

  const { columnCount, lineHeight, editableHeight } = model;

  const containerLineCount = lineHeight > 0
    ? Math.floor(Math.round((editableHeight / lineHeight) * 1e6) / 1e6) + 1
    : 0;

  if (elementLeft < 0) return false;
  if (elementWidth < 1) return false;
  if (elementLeft + elementWidth > columnCount) return false;

  if (elementTop < 0) return false;
  if (elementHeight < 1) return false;
  if (elementTop + elementHeight > containerLineCount + 1e-6) return false;

  return true;
}