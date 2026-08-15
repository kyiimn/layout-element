import { LayoutBoxElement, LayoutImageElement } from "@/components";
import { OverlapMode, OverlapParts } from "@/types";

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
 * mm 좌표계에서의 사각형.
 * 모든 값은 mm 단위이며, `getBoundingClientRect()`를 사용하지 않는
 * `getOverlapSizeMm()` 함수에서 사용된다.
 */
export type MmRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

/**
 * 오버랩 크기 계산 (mm 좌표계).
 *
 * 모든 좌표와 패딩이 mm 단위이다. `getBoundingClientRect()`를 전혀 호출하지 않으며,
 * 이미지 캔버스 픽셀 매핑만 `GridCalculator.ppm`을 통해 mm→픽셀 변환을 수행한다.
 *
 * @param lineRectMm - 라인 영역 (mm). 외부에서 mm 좌표로 직접 전달한다.
 * @param overlayElement - 오버랩 요소 (이미지 박스 등). `left`/`top`/`width`/`height`는 mm 값이다.
 * @returns 겹침 방향(NONE/COVERS/PART)과 겹침 구간(mm, 라인 좌측 기준 상대 좌표)
 */
export const getOverlapSizeMm = (lineRectMm: MmRect, overlayElement: LayoutBoxElement): {
  direction: "NONE" | "COVERS" | "PART",
  parts: OverlapParts[],
} => {
  const r1 = lineRectMm;
  const r2: MmRect = {
    left: overlayElement.absLeft,
    right: overlayElement.absLeft + overlayElement.absWidth,
    top: overlayElement.absTop,
    bottom: overlayElement.absTop + overlayElement.absHeight,
    width: overlayElement.absWidth,
    height: overlayElement.absHeight,
  };

  let padTop = 0, padRight = 0, padBottom = 0, padLeft = 0;
  let hasOverlapPadding = false;
  let imageEl: LayoutImageElement | null = null;
  let overlapMode: OverlapMode = 'path';
  if (overlayElement.contentType === 'image') {
    imageEl = overlayElement.contentElement as LayoutImageElement | null;
    if (imageEl) {
      overlapMode = imageEl.overlapMode;
      const padding = imageEl.overlapPadding;
      if (padding !== undefined) {
        // overlapPadding은 이미 mm 단위이므로 변환 없이 사용한다.
        padTop = typeof padding === 'number' ? padding : padding.top ?? 0;
        padRight = typeof padding === 'number' ? padding : padding.right ?? 0;
        padBottom = typeof padding === 'number' ? padding : padding.bottom ?? 0;
        padLeft = typeof padding === 'number' ? padding : padding.left ?? 0;
        hasOverlapPadding = true;
      }
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
  // 'box' 모드에서는 캔버스 픽셀 검사를 skip하고 기하학적 rect 기준으로 판정한다.
  if (overlapMode === 'path' && overlayElement.contentType === 'image' && imageEl) {
    // 이미지 요소의 mm rect를 사용하여 캔버스 픽셀과 매핑한다.
    // overlayElement(박스)의 rect는 중첩 box의 경우 실제 이미지보다 클 수 있다.
    const imgRectMm: MmRect = {
      left: imageEl.absLeft,
      right: imageEl.absLeft + imageEl.absWidth,
      top: imageEl.absTop,
      bottom: imageEl.absTop + imageEl.absHeight,
      width: imageEl.absWidth,
      height: imageEl.absHeight,
    };

    if (hasOverlapPadding) {
      if (imageEl.canvas) {
        const canvas = imageEl.canvas;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          const scaleX = canvas.width / imgRectMm.width;
          const scaleY = canvas.height / imgRectMm.height;

          const sampleTopMm = Math.max(imgRectMm.top, r1.top - padBottom);
          const sampleBottomMm = Math.min(imgRectMm.bottom, r1.bottom + padTop);

          let sy: number;
          let sh: number;

          if (sampleBottomMm > sampleTopMm) {
            const relY = sampleTopMm - imgRectMm.top;
            sy = Math.max(0, Math.floor(relY * scaleY));
            sh = Math.min(canvas.height - sy, Math.ceil((sampleBottomMm - sampleTopMm) * scaleY));
          } else if (r1.bottom <= imgRectMm.top) {
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
                const pixelMmY = (sy + y) / scaleY + imgRectMm.top;

                let dy: number;
                if (pixelMmY < r1.top) {
                  dy = r1.top - pixelMmY;
                } else if (pixelMmY > r1.bottom) {
                  dy = pixelMmY - r1.bottom;
                } else {
                  dy = 0;
                }

                const vertPad = pixelMmY < r1.top ? padBottom : padTop;
                if (vertPad <= 0 && dy > 0) continue;
                if (vertPad > 0 && dy > vertPad) continue;

                for (let x = 0; x < imgWidth; x++) {
                  const alphaIndex = (y * imgWidth + x) * 4 + 3;
                  if (pixels[alphaIndex] === 0) continue;

                  const pixelMmX = (sx + x) / scaleX + imgRectMm.left;

                  let dx: number;
                  if (pixelMmX < r1.left) {
                    dx = r1.left - pixelMmX;
                  } else if (pixelMmX > r1.right) {
                    dx = pixelMmX - r1.right;
                  } else {
                    dx = 0;
                  }

                  const horizPad = pixelMmX < r1.left ? padRight : padLeft;
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
              const mmPerColumn = imgRectMm.width / canvas.width;

              const paddedParts: { x1: number; x2: number }[] = [];
              for (const col of sortedCols) {
                const colStart = imgRectMm.left - r1.left + col * mmPerColumn - padLeft;
                const colEnd = imgRectMm.left - r1.left + (col + 1) * mmPerColumn + padRight;
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
        left: imgRectMm.left - padLeft,
        right: imgRectMm.right + padRight,
        top: imgRectMm.top - padTop,
        bottom: imgRectMm.bottom + padBottom,
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
        const scaleX = canvas.width / imgRectMm.width;
        const scaleY = canvas.height / imgRectMm.height;

        const imgIntersectionStart = Math.max(r1.left, imgRectMm.left);
        const imgIntersectionEnd = Math.min(r1.right, imgRectMm.right);
        const imgRawOverlapWidth = imgIntersectionEnd - imgIntersectionStart;
        if (imgRawOverlapWidth <= 0) {
          return { direction: 'NONE', parts: [] };
        }

        const relativeX = imgIntersectionStart - imgRectMm.left;
        const relativeY = Math.max(r1.top, imgRectMm.top) - imgRectMm.top;
        const relativeHeight = Math.min(r1.bottom, imgRectMm.bottom) - Math.max(r1.top, imgRectMm.top);

        const sx = Math.floor(relativeX * scaleX);
        const sy = Math.floor(relativeY * scaleY);
        const sw = Math.ceil(imgRawOverlapWidth * scaleX);
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

            // 라인 전체가 교차 영역 내에 있고, 교차 영역 내 모든 column이 불투명하면 COVERS.
            // 교차 영역이 라인 전체보다 좁으면 PART로 처리한다.
            // (이미지가 라인 일부만 덮을 때 COVERS로 판정하면 과도한 빈 줄이 생김)
            const isFullyCovering = opaqueColumns.size === imgWidth
              && imgIntersectionStart <= r1.left
              && imgIntersectionEnd >= r1.right;
            if (isFullyCovering) {
              return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
            }

            // 인접한 열을 연속 구간으로 그룹화 → parts
            const sortedCols = Array.from(opaqueColumns).sort((a, b) => a - b);
            const parts: { x1: number, x2: number }[] = [];
            let partStart = sortedCols[0];
            let prevCol = sortedCols[0];
            const mmPerColumn = imgRawOverlapWidth / imgWidth;
            const imgRelStart = imgIntersectionStart - r1.left;

            for (let i = 1; i < sortedCols.length; i++) {
              if (sortedCols[i] === prevCol + 1) {
                prevCol = sortedCols[i];
              } else {
                parts.push({
                  x1: imgRelStart + partStart * mmPerColumn,
                  x2: imgRelStart + (prevCol + 1) * mmPerColumn,
                });
                partStart = sortedCols[i];
                prevCol = sortedCols[i];
              }
            }
            parts.push({
              x1: imgRelStart + partStart * mmPerColumn,
              x2: imgRelStart + (prevCol + 1) * mmPerColumn,
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
};