import type { OverlapParts } from "@/types";

/**
 * mm 좌표계에서 오버랩 판정을 위한 최소 요소 인터페이스.
 */
interface MmMeasurable {
  absLeft: number;
  absTop: number;
  absWidth: number;
  absHeight: number;
}

/**
 * 두 요소의 mm 기반 AABB 교차 여부를 판정한다.
 */
export const checkOverlap = (baseElement: MmMeasurable, targetElement: MmMeasurable): boolean => {
  const baseRight = baseElement.absLeft + baseElement.absWidth;
  const baseBottom = baseElement.absTop + baseElement.absHeight;
  const targetRight = targetElement.absLeft + targetElement.absWidth;
  const targetBottom = targetElement.absTop + targetElement.absHeight;

  return !(
    baseRight <= targetElement.absLeft ||
    baseElement.absLeft >= targetRight ||
    baseBottom <= targetElement.absTop ||
    baseElement.absTop >= targetBottom
  );
};

export type MmRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export const mergeOverlapParts = (parts: OverlapParts[]): OverlapParts[] => {
  if (parts.length === 0) return [];
  const sorted = [...parts].sort((a, b) => a.x1 - b.x1);
  const merged: OverlapParts[] = [{ x1: sorted[0].x1, x2: sorted[0].x2 }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].x1 <= last.x2) {
      last.x2 = Math.max(last.x2, sorted[i].x2);
    } else {
      merged.push({ x1: sorted[i].x1, x2: sorted[i].x2 });
    }
  }
  return merged;
};