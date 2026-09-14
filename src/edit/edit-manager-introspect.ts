/**
 * EditManager 순수 로직 서브모듈 — 스레드 프레임 커버리지·최상위 레이아웃 필터.
 *
 * `edit-manager.ts`의 `_threadFrameCoverage`/`_filterTopLevelLayouts` 본문을
 * 이동한 파일이다. 요소 상태는 인자 주입으로 치환되며, first-claim-wins
 * 소속 판정(RULES §1.10)과 이벤트 페이로드 계약(EDITING_EVENTS.md)은
 * 1바이트도 변경하지 않는다.
 *
 * 이동 금지 대상(클래스 유지):
 * - `placeGunActive` getter — 공개 API (계획서 명시)
 * - `_dispatchPlaceGunChange` — 이벤트 디스패치 (계획서 명시)
 * - `placeGunItems`/`placeGunPaused` getter — 공개 API
 *
 * 소비처:
 * - `edit-manager.ts` — private 메서드 위임 (호출부 시그니처 불변)
 *   - `_threadFrameCoverage()` → `threadFrameCoverage()`
 *   - `_filterTopLevelLayouts()` → `filterTopLevelLayouts()`
 * - `transferCursorToOwningThreadFrame` → `_threadFrameCoverage` 위임 유지
 *
 * @file src/edit/edit-manager-introspect.ts
 */

import { ParagraphEngine } from "@/engine";
import type { DocumentEngine } from "@/engine";
import { LayoutBoxElement } from "@/components/layout/box.element";
import type { LayoutTableCellElement } from "@/components/layout/td.element";

/**
 * 레이아웃 선택 대상 요소 공용체 (edit-manager와 동일 정의).
 * box/td 요소를 수용한다.
 */
export type LayoutElement = LayoutBoxElement | LayoutTableCellElement;

/**
 * 스레드 프레임의 story 절대 오프셋 커버리지를 계산한다.
 *
 * `contentFrom`부터 visible 끝까지가 프레임이 표시하는 story 구간이다.
 * tail이 있으면 tail까지, 없으면(소진) story 끝까지가 visible 연속 구간이다.
 *
 * @param engine - 스레드 엔진 (DocumentEngine — findEngineById 소유)
 * @param frameId - 프레임 문단 id
 * @returns 커버리지 `{ start, end }`. 비스레드/미연결/빈 구간이면 null.
 * @throws 없음
 */
export function threadFrameCoverage(
  engine: DocumentEngine | undefined,
  frameId: string,
): { start: number; end: number } | null {
  if (!engine) return null;
  const pe = engine.findEngineById(frameId);
  if (!(pe instanceof ParagraphEngine) || !pe.isThreadFrame) return null;
  const start = pe.contentFrom;
  // tail(overflow)가 있으면 tail이 visible 끝이다. 소진(tail -1)이면
  // 남은 story 전체를 배치했으므로 story 끝이 visible 끝이다.
  // (visibleChars는 strip 공백을 제외한 수라 end 산정에 부적합하다)
  const end = pe.overflowContentFrom >= 0 ? pe.overflowContentFrom : pe.totalChars;
  return end > start ? { start, end } : null;
}

/**
 * 주어진 레이아웃 요소 목록에서 중첩 관계의 하위 요소를 제거하고
 * 최상위 요소만 필터링한다.
 *
 * @param elements - 필터링할 레이아웃 요소 목록
 * @returns 중첩 하위 요소가 제거된 LayoutBoxElement 배열.
 * @throws 없음
 */
export function filterTopLevelLayouts(elements: LayoutElement[]): LayoutBoxElement[] {
  const boxes = elements.filter(
    (el): el is LayoutBoxElement => el instanceof LayoutBoxElement
  );
  if (boxes.length <= 1) return boxes;

  const result: LayoutBoxElement[] = [];
  for (const box of boxes) {
    if (result.some(existing => existing.contains(box))) continue;

    for (let i = result.length - 1; i >= 0; i--) {
      if (box.contains(result[i])) {
        result.splice(i, 1);
      }
    }

    result.push(box);
  }
  return result;
}