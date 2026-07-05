import { LayoutBoxElement, LayoutImageElement } from "@/components";
import { GridCalculator } from "@/core/grid-calculator";
import { OverlapParts } from "@/types";

export const checkOverlap = (baseElement: HTMLElement, targetElement: HTMLElement) => {
  const r1 = baseElement.getBoundingClientRect();
  const r2 = targetElement.getBoundingClientRect();

  const isIntersecting = (
    r1.right > r2.left &&
    r1.left < r2.right &&
    r1.bottom > r2.top &&
    r1.top < r2.bottom
  );
  return isIntersecting;
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

/**
 * 오버랩 크기 계산.
 *
 * `targetElement`는 항상 `LayoutBoxElement`이다:
 * 유일한 호출처인 `_applyOverlap()`이 `overlayElements`에서 요소를 가져오며,
 * `overlayElements`는 `LayoutBoxElement[]` 타입이므로
 * `as LayoutBoxElement` 캐스트는 런타임에 결코 실패하지 않는다.
 */
export const getOverlapSizePX = (baseElement: HTMLElement, targetElement: LayoutBoxElement): {
  direction: "NONE" | "COVERS" | "PART",
  parts: OverlapParts[],
} => {
  const r1 = baseElement.getBoundingClientRect();
  const r2 = targetElement.getBoundingClientRect();

  let padTop = 0, padRight = 0, padBottom = 0, padLeft = 0;
  let hasOverlapPadding = false;
  if (targetElement.contentType === 'image') {
    const imageEl = targetElement.items[0] as LayoutImageElement;
    const padding = imageEl.overlapPadding;
    if (padding !== undefined) {
      const ppm = GridCalculator.ppm;
      padTop = (typeof padding === 'number' ? padding : padding.top ?? 0) * ppm;
      padRight = (typeof padding === 'number' ? padding : padding.right ?? 0) * ppm;
      padBottom = (typeof padding === 'number' ? padding : padding.bottom ?? 0) * ppm;
      padLeft = (typeof padding === 'number' ? padding : padding.left ?? 0) * ppm;
      hasOverlapPadding = true;
    }
  }

  const effectiveR2 = hasOverlapPadding
    ? { left: r2.left - padLeft, right: r2.right + padRight, top: r2.top - padTop, bottom: r2.bottom + padBottom }
    : { left: r2.left, right: r2.right, top: r2.top, bottom: r2.bottom };

  if (r1.bottom <= effectiveR2.top || r1.top >= effectiveR2.bottom) {
    return { direction: 'NONE', parts: [] };
  }

  const intersectionStart = Math.max(r1.left, effectiveR2.left);
  const intersectionEnd = Math.min(r1.right, effectiveR2.right);
  const rawOverlapWidth = intersectionEnd - intersectionStart;
  if (rawOverlapWidth <= 0) {
    return { direction: 'NONE', parts: [] };
  }

  const relStart = intersectionStart - r1.left;
  const relEnd = intersectionEnd - r1.left;

  // 이미지 픽셀 단위 겹침 탐지 — COVERS 판정 전에 수행
  if (targetElement.contentType === 'image') {
    const imageEl = targetElement.items[0] as LayoutImageElement;

    if (hasOverlapPadding) {

      if (imageEl.canvas) {
        const canvas = imageEl.canvas;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          const scaleX = canvas.width / r2.width;
          const scaleY = canvas.height / r2.height;

          const sampleTopScreen = Math.max(r2.top, r1.top - padBottom);
          const sampleBottomScreen = Math.min(r2.bottom, r1.bottom + padTop);

          let sy: number;
          let sh: number;

          if (sampleBottomScreen > sampleTopScreen) {
            const relY = sampleTopScreen - r2.top;
            sy = Math.max(0, Math.floor(relY * scaleY));
            sh = Math.min(canvas.height - sy, Math.ceil((sampleBottomScreen - sampleTopScreen) * scaleY));
          } else if (r1.bottom <= r2.top) {
            sy = 0;
            sh = Math.min(canvas.height, Math.ceil(padTop * scaleY));
          } else {
            sh = Math.min(canvas.height, Math.ceil(padBottom * scaleY));
            sy = canvas.height - sh;
          }

          const sx = 0;
          const sw = canvas.width;

          if (sw > 0 && sh > 0) {
            try {
              const imageData = ctx.getImageData(sx, sy, sw, sh);
              const pixels = imageData.data;
              const imgWidth = imageData.width;
              const imgHeight = imageData.height;

              const opaqueColumns = new Set<number>();

              for (let y = 0; y < imgHeight; y++) {
                const pixelScreenY = (sy + y) / scaleY + r2.top;

                let dy: number;
                if (pixelScreenY < r1.top) {
                  dy = r1.top - pixelScreenY;
                } else if (pixelScreenY > r1.bottom) {
                  dy = pixelScreenY - r1.bottom;
                } else {
                  dy = 0;
                }

                const vertPad = pixelScreenY < r1.top ? padBottom : padTop;
                if (vertPad <= 0 && dy > 0) continue;
                if (vertPad > 0 && dy > vertPad) continue;

                for (let x = 0; x < imgWidth; x++) {
                  const alphaIndex = (y * imgWidth + x) * 4 + 3;
                  if (pixels[alphaIndex] === 0) continue;

                  const pixelScreenX = (sx + x) / scaleX + r2.left;

                  let dx: number;
                  if (pixelScreenX < r1.left) {
                    dx = r1.left - pixelScreenX;
                  } else if (pixelScreenX > r1.right) {
                    dx = pixelScreenX - r1.right;
                  } else {
                    dx = 0;
                  }

                  const horizPad = pixelScreenX < r1.left ? padRight : padLeft;
                  if (horizPad <= 0 && dx > 0) continue;

                  const ndx = horizPad > 0 ? dx / horizPad : 0;
                  const ndy = vertPad > 0 ? dy / vertPad : 0;

                  if (ndx * ndx + ndy * ndy <= 1) {
                    opaqueColumns.add(x);
                  }
                }
              }

              if (opaqueColumns.size === 0) {
                return { direction: "NONE", parts: [] };
              }

              // Each opaque column blocks a range extended by horizontal padding.
              const sortedCols = Array.from(opaqueColumns).sort((a, b) => a - b);
              const pxWidth = r2.width / canvas.width;

              const paddedParts: { x1: number; x2: number }[] = [];
              for (const col of sortedCols) {
                const colStart = r2.left - r1.left + col * pxWidth - padLeft;
                const colEnd = r2.left - r1.left + (col + 1) * pxWidth + padRight;
                if (colEnd > 0 && colStart < r1.width) {
                  paddedParts.push({
                    x1: Math.max(0, colStart),
                    x2: Math.min(r1.width, colEnd),
                  });
                }
              }

              if (paddedParts.length === 0) {
                return { direction: "NONE", parts: [] };
              }

              const mergedParts = mergeOverlapParts(paddedParts);
              if (mergedParts.length === 1 && mergedParts[0].x1 <= 0 && mergedParts[0].x2 >= r1.width) {
                return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
              }
              return { direction: 'PART', parts: mergedParts };
            } catch (e) { }
          }
        }
      }

      const expandedR2 = {
        left: r2.left - padLeft,
        right: r2.right + padRight,
        top: r2.top - padTop,
        bottom: r2.bottom + padBottom,
      };
      if (r1.bottom <= expandedR2.top || r1.top >= expandedR2.bottom) {
        return { direction: 'NONE', parts: [] };
      }
      const expStart = Math.max(r1.left, expandedR2.left);
      const expEnd = Math.min(r1.right, expandedR2.right);
      if (expEnd <= expStart) {
        return { direction: 'NONE', parts: [] };
      }
      if (expandedR2.left <= r1.left && expandedR2.right >= r1.right) {
        return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
      }
      return { direction: 'PART', parts: [{ x1: expStart - r1.left, x2: expEnd - r1.left }] };
    }

    if (imageEl.canvas) {
      const canvas = imageEl.canvas;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        const scaleX = canvas.width / r2.width;
        const scaleY = canvas.height / r2.height;

        const relativeX = intersectionStart - r2.left;
        const relativeY = Math.max(r1.top, r2.top) - r2.top;
        const relativeHeight = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);

        const sx = Math.floor(relativeX * scaleX);
        const sy = Math.floor(relativeY * scaleY);
        const sw = Math.ceil(rawOverlapWidth * scaleX);
        const sh = Math.ceil(relativeHeight * scaleY);

        if (sw > 0 && sh > 0) {
          try {
            const imageData = ctx.getImageData(sx, sy, sw, sh);
            const pixels = imageData.data;
            const imgWidth = imageData.width;
            const imgHeight = imageData.height;

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

            // 모든 열에 불투명 픽셀이 있으면 완전 차단
            const isFullyCovering = opaqueColumns.size === imgWidth;
            if (isFullyCovering) {
              return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
            }

            // 인접한 열을 연속 구간으로 그룹화 → parts
            const sortedCols = Array.from(opaqueColumns).sort((a, b) => a - b);
            const parts: { x1: number, x2: number }[] = [];
            let partStart = sortedCols[0];
            let prevCol = sortedCols[0];
            const pxWidth = rawOverlapWidth / imgWidth;

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
            parts.push({
              x1: relStart + partStart * pxWidth,
              x2: relStart + (prevCol + 1) * pxWidth,
            });

            return { direction: 'PART', parts };
          } catch (e) { }
        }
      }
    }
  }

  // 기하학적 COVERS 판정 (이미지가 아닌 요소 또는 픽셀 검사 실패 시)
  if (r2.left <= r1.left && r2.right >= r1.right) {
    return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
  }

  // 기하학적 겹침 (픽셀 검사 불가 또는 이미지 아님)
  return { direction: 'PART', parts: [{ x1: relStart, x2: relEnd }] };
}