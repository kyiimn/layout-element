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
 * scale=1 기준으로 정규화된 DOMRect를 나타내는 타입.
 * `getBoundingClientRect()`의 viewport 픽셀 값을 `EditManager.scale`로 나누어,
 * CSS `transform: scale(s)`의 영향을 제거한 좌표계에서 오버랩을 판정한다.
 */
export type NormalizedRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

/**
 * `getBoundingClientRect()` 결과를 scale=1 기준으로 정규화한다.
 *
 * CSS `transform: scale(s)`가 적용된 환경에서 `getBoundingClientRect()`는
 * scale이 곱해진 viewport 픽셀을 반환한다. 서브픽셀 렌더링 정밀도는 scale에
 * 비례하므로(예: scale=0.5면 반픽셀 단위), scale마다 겹침 판정이 미세하게
 * 달라져 텍스트 배치가 어긋나는 원인이 된다.
 *
 * 모든 rect를 scale로 나누어 scale=1 기준 픽셀 좌표계로 변환하면, 모든 scale에서
 * 동일한 정밀도와 동일한 겹침 판정 결과를 보장한다.
 *
 * @param rect - `getBoundingClientRect()` 반환값 (viewport 픽셀, scale 적용됨)
 * @param scale - `EditManager.scale` 값. 0 이하이면 1로 취급하여 안전하게 처리
 * @returns scale=1 기준 픽셀 좌표로 정규화된 rect
 *
 * @example
 * // scale=0.5: r1.left=100(viewport px) → 정규화 r1.left=200(scale=1 기준)
 * // scale=2:   r1.left=400(viewport px) → 정규화 r1.left=200(scale=1 기준)
 * // 두 경우 모두 동일한 200을 반환하여 일관된 비교 기준을 제공한다.
 */
export const normalizeRect = (rect: DOMRect, scale: number): NormalizedRect => {
  const s = scale > 0 ? scale : 1;
  return {
    left: rect.left / s,
    right: rect.right / s,
    top: rect.top / s,
    bottom: rect.bottom / s,
    width: rect.width / s,
    height: rect.height / s,
  };
};

/**
 * 오버랩 크기 계산.
 *
 * `targetElement`는 항상 `LayoutBoxElement`이다:
 * 유일한 호출처인 `detectOverlapWithCache()`이 `overlayElements`에서 요소를 가져오며,
 * `overlayElements`는 `LayoutBoxElement[]` 타입이므로
 * `as LayoutBoxElement` 캐스트는 런타임에 결코 실패하지 않는다.
 *
 * @param baseElement - 라인 요소 (겹침의 기준)
 * @param targetElement - 오버랩 요소 (이미지 박스 등)
 * @param scale - `EditManager.scale` 값. 모든 `getBoundingClientRect()` 결과를
 *                scale=1 기준으로 정규화하여 scale 무관한 겹침 판정을 보장.
 *                생략 시 1 (scale 미적용 환경 호환).
 * @returns 겹침 방향(NONE/COVERS/PART)과 겹침 구간(scale=1 기준 픽셀 좌표)
 */
export const getOverlapSizePX = (baseElement: HTMLElement, targetElement: LayoutBoxElement, scale: number = 1): {
  direction: "NONE" | "COVERS" | "PART",
  parts: OverlapParts[],
} => {
  // scale=1 기준으로 정규화된 rect — 모든 후속 연산은 이 좌표계에서 수행된다.
  const r1 = normalizeRect(baseElement.getBoundingClientRect(), scale);
  const r2 = normalizeRect(targetElement.getBoundingClientRect(), scale);

  let padTop = 0, padRight = 0, padBottom = 0, padLeft = 0;
  let hasOverlapPadding = false;
  let imageEl: LayoutImageElement | null = null;
  if (targetElement.contentType === 'image') {
    imageEl = targetElement.contentElement as LayoutImageElement | null;
    if (imageEl) {
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
  if (targetElement.contentType === 'image' && imageEl) {

    // 이미지 요소의 rect를 사용하여 캔버스 픽셀과 정확히 매핑한다.
    // targetElement(박스)의 rect는 중첩 box의 경우 실제 이미지보다 클 수 있다.
    const imgRect = normalizeRect(imageEl.getBoundingClientRect(), scale);

    if (hasOverlapPadding) {

      if (imageEl.canvas) {
        const canvas = imageEl.canvas;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          // imgRect.width는 정규화된(scale=1 기준) 픽셀 폭이므로, canvas 픽셀 매핑도 scale=1 기준
          const scaleX = canvas.width / imgRect.width;
          const scaleY = canvas.height / imgRect.height;

          const sampleTopScreen = Math.max(imgRect.top, r1.top - padBottom);
          const sampleBottomScreen = Math.min(imgRect.bottom, r1.bottom + padTop);

          let sy: number;
          let sh: number;

          if (sampleBottomScreen > sampleTopScreen) {
            const relY = sampleTopScreen - imgRect.top;
            sy = Math.max(0, Math.floor(relY * scaleY));
            sh = Math.min(canvas.height - sy, Math.ceil((sampleBottomScreen - sampleTopScreen) * scaleY));
          } else if (r1.bottom <= imgRect.top) {
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
                const pixelScreenY = (sy + y) / scaleY + imgRect.top;

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

                  const pixelScreenX = (sx + x) / scaleX + imgRect.left;

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
              const pxWidth = imgRect.width / canvas.width;

              const paddedParts: { x1: number; x2: number }[] = [];
              for (const col of sortedCols) {
                const colStart = imgRect.left - r1.left + col * pxWidth - padLeft;
                const colEnd = imgRect.left - r1.left + (col + 1) * pxWidth + padRight;
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
        left: imgRect.left - padLeft,
        right: imgRect.right + padRight,
        top: imgRect.top - padTop,
        bottom: imgRect.bottom + padBottom,
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
        const scaleX = canvas.width / imgRect.width;
        const scaleY = canvas.height / imgRect.height;

        const imgIntersectionStart = Math.max(r1.left, imgRect.left);
        const imgIntersectionEnd = Math.min(r1.right, imgRect.right);
        const imgRawOverlapWidth = imgIntersectionEnd - imgIntersectionStart;
        if (imgRawOverlapWidth <= 0) {
          return { direction: 'NONE', parts: [] };
        }

        const relativeX = imgIntersectionStart - imgRect.left;
        const relativeY = Math.max(r1.top, imgRect.top) - imgRect.top;
        const relativeHeight = Math.min(r1.bottom, imgRect.bottom) - Math.max(r1.top, imgRect.top);

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
            const pxWidth = imgRawOverlapWidth / imgWidth;
            const imgRelStart = imgIntersectionStart - r1.left;

            for (let i = 1; i < sortedCols.length; i++) {
              if (sortedCols[i] === prevCol + 1) {
                prevCol = sortedCols[i];
              } else {
                parts.push({
                  x1: imgRelStart + partStart * pxWidth,
                  x2: imgRelStart + (prevCol + 1) * pxWidth,
                });
                partStart = sortedCols[i];
                prevCol = sortedCols[i];
              }
            }
            parts.push({
              x1: imgRelStart + partStart * pxWidth,
              x2: imgRelStart + (prevCol + 1) * pxWidth,
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