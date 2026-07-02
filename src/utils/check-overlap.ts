import { LayoutBoxElement, LayoutImageElement } from "@/components";
import { OverlapParts } from "@/types";

export const checkOverlap = (baseElement: HTMLElement, targetElement: HTMLElement) => {
  const r1 = baseElement.getBoundingClientRect();
  const r2 = targetElement.getBoundingClientRect();

  const isIntersceting = (
    r1.right > r2.left &&
    r1.left < r2.right &&
    r1.bottom > r2.top &&
    r1.top < r2.bottom
  );
  return isIntersceting;
}

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

export const getOverlapSizePX = (baseElement: HTMLElement, targetElement: HTMLElement): {
  direction: "NONE" | "COVERS" | "PART",
  parts: OverlapParts[],
} => {
  const r1 = baseElement.getBoundingClientRect();
  const r2 = targetElement.getBoundingClientRect();
  if (r1.bottom <= r2.top || r1.top >= r2.bottom) {
    return { direction: 'NONE', parts: [] };
  }

  const intersectionStart = Math.max(r1.left, r2.left);
  const intersectionEnd = Math.min(r1.right, r2.right);
  const rawOverlapWidth = intersectionEnd - intersectionStart;
  if (rawOverlapWidth <= 0) {
    return { direction: 'NONE', parts: [] };
  }

  // baseElement 기준 상대 좌표
  const relStart = intersectionStart - r1.left;
  const relEnd = intersectionEnd - r1.left;

  if (r2.left <= r1.left && r2.right >= r1.right) {
    return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
  }

  // 이미지 픽셀 단위 겹침 탐지
  if ((targetElement as LayoutBoxElement).contentType === 'image') {
    const imageEl = (targetElement as LayoutBoxElement).items[0] as LayoutImageElement;
    if (imageEl.canvas) {
      const canvas = imageEl.canvas;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        const scaleX = canvas.width / r2.width;
        const scaleY = canvas.height / r2.height;

        const relativeX = intersectionStart - r2.left;
        const relativeY = Math.max(r1.top, r2.top) - r2.top; // 수직 겹침 시작점
        const relativeHeight = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);

        // 정수 좌표로 변환 (픽셀 데이터 접근을 위해)
        const sx = Math.floor(relativeX * scaleX);
        const sy = Math.floor(relativeY * scaleY);
        const sw = Math.ceil(rawOverlapWidth * scaleX);
        const sh = Math.ceil(relativeHeight * scaleY);

        // 캔버스 범위를 벗어나지 않도록 클램핑
        if (sw <= 0 || sh <= 0) return { direction: "NONE", parts: [] };

        try {
          // 겹치는 영역의 픽셀 데이터 추출
          const imageData = ctx.getImageData(sx, sy, sw, sh);
          const pixels = imageData.data;
          const imgWidth = imageData.width;
          const imgHeight = imageData.height;

          // 불투명 픽셀이 하나라도 있는 열(col) 수집
          const opaqueColumns = new Set<number>();
          for (let y = 0; y < imgHeight; y++) {
            for (let x = 0; x < imgWidth; x++) {
              const alphaIndex = (y * imgWidth + x) * 4 + 3;
              if (pixels[alphaIndex] > 0) {
                opaqueColumns.add(x);
              }
            }
          }

          if (opaqueColumns.size === 0) return { direction: "NONE", parts: [] };

          // 인접한 열을 연속 구간으로 그룹화 → parts
          const sortedCols = Array.from(opaqueColumns).sort((a, b) => a - b);
          const parts: { x1: number, x2: number }[] = [];
          let partStart = sortedCols[0];
          let prevCol = sortedCols[0];
          const pxWidth = rawOverlapWidth / imgWidth; // imageData 픽셀 1열당 화면 px 폭

          for (let i = 1; i < sortedCols.length; i++) {
            if (sortedCols[i] === prevCol + 1) {
              prevCol = sortedCols[i];
            } else {
              parts.push({
                x1: relStart + partStart * pxWidth,
                x2: relStart + (prevCol + 1) * pxWidth,
              });
              partStart = sortedCols[i];
              prevCol = sortedCols[i];
            }
          }
          // 마지막 구간
          parts.push({
            x1: relStart + partStart * pxWidth,
            x2: relStart + (prevCol + 1) * pxWidth,
          });

          return { direction: 'PART', parts };
        } catch (e) { }
      }
    }
  }

  // 기하학적 겹침 (픽셀 검사 불가 또는 이미지 아님)
  return { direction: 'PART', parts: [{ x1: relStart, x2: relEnd }] };
}