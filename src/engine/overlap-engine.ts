/**
 * Node.js 호환 오버랩 판정 순수 함수.
 *
 * 기존 `src/utils/check-overlap.ts`에서 DOM 의존성을 제거한 버전.
 * - `LayoutBoxElement` 파라미터를 `OverlapInput` 순수 데이터로 대체
 * - `imageEl.canvas.getContext('2d').getImageData()`를 `ImageEngine.rgbaData`로 대체
 * - `checkOverlap()`도 `AbsRect` 기반 순수 함수로 포팅
 *
 * @file src/engine/overlap-engine.ts
 */

import type {
  AbsRect,
  MmRect,
  OverlapInput,
  OverlapParts,
  OverlapResult,
  ImageEngineRef,
} from "./types";

/**
 * 두 사각형이 교차하는지 판정한다.
 *
 * @param a - 첫 번째 사각형 (절대 좌표)
 * @param b - 두 번째 사각형 (절대 좌표)
 * @returns 교차하면 true
 *
 * @example
 * checkOverlapMm(
 *   { absLeft: 0, absTop: 0, absWidth: 100, absHeight: 50 },
 *   { absLeft: 50, absTop: 25, absWidth: 100, absHeight: 50 },
 * ); // true
 */
export function checkOverlapMm(a: AbsRect, b: AbsRect): boolean {
  const aRight = a.absLeft + a.absWidth;
  const aBottom = a.absTop + a.absHeight;
  const bRight = b.absLeft + b.absWidth;
  const bBottom = b.absTop + b.absHeight;
  return !(aRight <= b.absLeft || a.absLeft >= bRight || aBottom <= b.absTop || a.absTop >= bBottom);
}

/**
 * 라인 사각형과 오버랩 요소 사이의 겹침을 mm 단위로 계산한다.
 *
 * 기존 `getOverlapSizeMm()`의 순수 함수 버전.
 * `LayoutBoxElement` 대신 `OverlapInput`을 받으며,
 * 이미지 픽셀 검사는 `ImageEngineRef.rgbaData`를 통해 수행한다.
 *
 * @param lineRectMm - 라인 사각형 (mm)
 * @param overlay - 오버랩 요소 입력 (절대 좌표 + 모드 + 이미지 참조)
 * @returns 오버랩 판정 결과 (NONE/COVERS/PART + 겹침 구간)
 *
 * @example
 * const result = computeOverlapSizeMm(lineRect, {
 *   absRect: { absLeft: 50, absTop: 20, absWidth: 40, absHeight: 30 },
 *   overlapMode: 'box',
 *   contentType: 'image',
 *   image: null,
 * });
 * // result.direction === 'PART'
 */
export function computeOverlapSizeMm(lineRectMm: MmRect, overlay: OverlapInput): OverlapResult {
  const r1 = lineRectMm;
  const r2: MmRect = {
    left: overlay.absRect.absLeft,
    right: overlay.absRect.absLeft + overlay.absRect.absWidth,
    top: overlay.absRect.absTop,
    bottom: overlay.absRect.absTop + overlay.absRect.absHeight,
    width: overlay.absRect.absWidth,
    height: overlay.absRect.absHeight,
  };

  let padTop = 0, padRight = 0, padBottom = 0, padLeft = 0;
  let hasOverlapPadding = false;
  const padding = overlay.overlapPadding;
  if (padding !== undefined) {
    padTop = typeof padding === 'number' ? padding : padding.top ?? 0;
    padRight = typeof padding === 'number' ? padding : padding.right ?? 0;
    padBottom = typeof padding === 'number' ? padding : padding.bottom ?? 0;
    padLeft = typeof padding === 'number' ? padding : padding.left ?? 0;
    hasOverlapPadding = true;
  }

  const overlapMode = overlay.overlapMode;
  const image = overlay.image;
  const isImage = overlay.contentType === 'image' && image !== null && image !== undefined;


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

  // 'path' 모드 + 이미지 + RGBA 데이터 → 픽셀 단위 판정
  if (overlapMode === 'path' && isImage && image.rgbaData) {
    return computePixelOverlap(
      r1, r2, image,
      padTop, padRight, padBottom, padLeft, hasOverlapPadding,
    );
  }


  // 'box' 모드 또는 이미지 아님 또는 RGBA 없음 → 기하학적 판정
  if (r2.left <= r1.left && r2.right >= r1.right) {
    return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
  }

  return { direction: 'PART', parts: [{ x1: relStart, x2: relEnd }] };
}

/**
 * RGBA 픽셀 데이터를 사용한 정밀 오버랩 판정.
 * `ImageEngineRef`에서 rgbaData를 읽어 픽셀 단위로 불투명 영역을 찾는다.
 */
function computePixelOverlap(
  r1: MmRect,
  r2: MmRect,
  image: ImageEngineRef,
  padTop: number,
  padRight: number,
  padBottom: number,
  padLeft: number,
  hasOverlapPadding: boolean,
): OverlapResult {
  const imgRectMm: MmRect = r2;

  const rgba = image.rgbaData!;
  if (imgRectMm.width <= 0 || imgRectMm.height <= 0) {
    return { direction: 'NONE', parts: [] };
  }

  // image.displayRect가 제공되면 원본 표시 영역 기준으로 픽셀 스케일을 계산.
  // r2 (imgRectMm)는 contentAbsRect로 클램프된 영역이므로,
  // RGBA 픽셀 매핑은 원본 displayRect 기준이어야 정확한 픽셀을 샘플링.
  const pixelRectMm: MmRect = image.displayRect
    ? {
        left: image.displayRect.absLeft,
        right: image.displayRect.absLeft + image.displayRect.absWidth,
        top: image.displayRect.absTop,
        bottom: image.displayRect.absTop + image.displayRect.absHeight,
        width: image.displayRect.absWidth,
        height: image.displayRect.absHeight,
      }
    : imgRectMm;

  if (pixelRectMm.width <= 0 || pixelRectMm.height <= 0) {
    return { direction: 'NONE', parts: [] };
  }

  const scaleX = rgba.width / pixelRectMm.width;
  const scaleY = rgba.height / pixelRectMm.height;

  if (hasOverlapPadding) {
    return computeEllipseOverlap(
      r1, imgRectMm, pixelRectMm, rgba,
      scaleX, scaleY,
      padTop, padRight, padBottom, padLeft,
    );
  }

  const bitmap = image.opaqueRowBitmap;
  if (bitmap) {
    return computeSimplePixelOverlapFromBitmap(r1, imgRectMm, pixelRectMm, rgba, scaleX, scaleY, bitmap);
  }

  return computeSimplePixelOverlap(r1, imgRectMm, pixelRectMm, rgba, scaleX, scaleY);
}

/**
 * 타원 패딩 기반 오버랩 판정.
 */
function computeEllipseOverlap(
  r1: MmRect,
  imgMmRect: MmRect,
  pixelRectMm: MmRect,
  rgba: { data: Uint8Array; width: number; height: number },
  scaleX: number,
  scaleY: number,
  padTop: number,
  padRight: number,
  padBottom: number,
  padLeft: number,
): OverlapResult {

  const sampleTopMm = Math.max(imgMmRect.top, r1.top - padBottom);
  const sampleBottomMm = Math.min(imgMmRect.bottom, r1.bottom + padTop);

  let sy: number;
  let sh: number;

  if (sampleBottomMm > sampleTopMm) {
    const relY = sampleTopMm - pixelRectMm.top;
    sy = Math.max(0, Math.floor(relY * scaleY));
    sh = Math.min(rgba.height - sy, Math.ceil((sampleBottomMm - sampleTopMm) * scaleY));
  } else if (r1.bottom <= imgMmRect.top) {
    sy = 0;
    sh = Math.min(rgba.height, Math.ceil(padTop * scaleY));
  } else {
    sh = Math.min(rgba.height, Math.ceil(padBottom * scaleY));
    sy = rgba.height - sh;
  }

  // 픽셀 x 샘플링 범위: pixelRectMm(원본 표시 영역)에서 imgMmRect(클램프) 내 픽셀만.
  // imgMmRect가 pixelRectMm 안쪽이므로, clamp된 영역의 픽셀 x 범위를 계산.
  const pixStartX = Math.max(0, Math.floor((imgMmRect.left - pixelRectMm.left) * scaleX));
  const pixEndX = Math.min(rgba.width, Math.ceil((imgMmRect.right - pixelRectMm.left) * scaleX));
  const sx = pixStartX;
  const sw = pixEndX - pixStartX;

  if (sw <= 0 || sh <= 0) {
    // 기하학적 fallback
    const expandedR2 = {
      left: imgMmRect.left - padLeft,
      right: imgMmRect.right + padRight,
      top: imgMmRect.top - padTop,
      bottom: imgMmRect.bottom + padBottom,
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

  const opaqueColumns = new Set<number>();

  for (let y = 0; y < sh; y++) {
    const pixelMmY = (sy + y) / scaleY + pixelRectMm.top;

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

    for (let x = 0; x < sw; x++) {
      const alphaIndex = ((y + sy) * rgba.width + (x + sx)) * 4 + 3;
      if (rgba.data[alphaIndex] === 0) continue;

      const pixelMmX = (sx + x) / scaleX + pixelRectMm.left;

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
        opaqueColumns.add(x + sx);
      }
    }
  }

  if (opaqueColumns.size === 0) {
    return { direction: 'NONE', parts: [] };
  }

  // mmPerColumn은 원본 표시 영역 기준 (pixelRectMm).
  const mmPerColumn = pixelRectMm.width / rgba.width;
  const paddedParts: { x1: number; x2: number }[] = [];
  for (const col of Array.from(opaqueColumns).sort((a, b) => a - b)) {
    const colStart = pixelRectMm.left - r1.left + col * mmPerColumn - padLeft;
    const colEnd = pixelRectMm.left - r1.left + (col + 1) * mmPerColumn + padRight;
    // 결과를 imgMmRect (클램프 영역)로 x축 클립 — 박스 밖 잘린 부분 제외.
    const clipStart = imgMmRect.left - r1.left - padLeft;
    const clipEnd = imgMmRect.right - r1.left + padRight;
    const clampedStart = Math.max(colStart, clipStart);
    const clampedEnd = Math.min(colEnd, clipEnd);
    if (clampedEnd > 0 && clampedStart < r1.width) {
      paddedParts.push({
        x1: Math.max(0, clampedStart),
        x2: Math.min(r1.width, clampedEnd),
      });
    }
  }

  if (paddedParts.length === 0) {
    return { direction: 'NONE', parts: [] };
  }

  const merged = mergeOverlapParts(paddedParts);
  if (merged.length === 1 && merged[0].x1 <= 0 && merged[0].x2 >= r1.width) {
    return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
  }
  return { direction: 'PART', parts: merged };
}

/**
 * bitmap 기반 단순 픽셀 오버랩 판정 (패딩 없음).
 * 사전 빌드된 행별 bitmap을 사용하여 O(H_line) lookups로 opaque 컬럼을 머지.
 */
function computeSimplePixelOverlapFromBitmap(
  r1: MmRect,
  imgMmRect: MmRect,
  pixelRectMm: MmRect,
  _rgba: { data: Uint8Array; width: number; height: number },
  scaleX: number,
  scaleY: number,
  bitmap: Uint8Array[],
): OverlapResult {
  const imgIntersectionStart = Math.max(r1.left, imgMmRect.left);
  const imgIntersectionEnd = Math.min(r1.right, imgMmRect.right);
  const imgRawOverlapWidth = imgIntersectionEnd - imgIntersectionStart;
  if (imgRawOverlapWidth <= 0) {
    return { direction: 'NONE', parts: [] };
  }

  // imgMmRect는 pixelRectMm 안쪽(클램프)이므로, 픽셀 좌표는 pixelRectMm 기준.
  const relativeX = imgIntersectionStart - pixelRectMm.left;
  const relativeY = Math.max(r1.top, imgMmRect.top) - pixelRectMm.top;
  const relativeHeight = Math.min(r1.bottom, imgMmRect.bottom) - Math.max(r1.top, imgMmRect.top);

  const sx = Math.floor(relativeX * scaleX);
  const sy = Math.floor(relativeY * scaleY);
  const sw = Math.ceil(imgRawOverlapWidth * scaleX);
  const sh = Math.ceil(relativeHeight * scaleY);

  if (sw <= 0 || sh <= 0) {
    return { direction: 'NONE', parts: [] };
  }

  const opaqueColumns = new Set<number>();
  const endX = sx + sw;
  for (let y = 0; y < sh; y++) {
    const row = bitmap[sy + y];
    if (!row) continue;
    for (let x = sx; x < endX; x++) {
      if (row[x >> 3] & (1 << (x & 7))) {
        opaqueColumns.add(x);
      }
    }
  }

  if (opaqueColumns.size === 0) {
    return { direction: 'NONE', parts: [] };
  }

  const isFullyCovering = opaqueColumns.size === sw
    && imgIntersectionStart <= r1.left
    && imgIntersectionEnd >= r1.right;
  if (isFullyCovering) {
    return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
  }

  const sortedCols = Array.from(opaqueColumns).sort((a, b) => a - b);
  const mmPerColumn = pixelRectMm.width / _rgba.width;
  const imgRelStart = pixelRectMm.left - r1.left;

  const parts: OverlapParts[] = [];
  let partStart = sortedCols[0];
  let prevCol = sortedCols[0];

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
}

/**
 * 단순 픽셀 오버랩 판정 (패딩 없음, bitmap 없을 때 폴백).
 */
function computeSimplePixelOverlap(
  r1: MmRect,
  imgMmRect: MmRect,
  pixelRectMm: MmRect,
  rgba: { data: Uint8Array; width: number; height: number },
  scaleX: number,
  scaleY: number,
): OverlapResult {
  const imgIntersectionStart = Math.max(r1.left, imgMmRect.left);
  const imgIntersectionEnd = Math.min(r1.right, imgMmRect.right);
  const imgRawOverlapWidth = imgIntersectionEnd - imgIntersectionStart;
  if (imgRawOverlapWidth <= 0) {
    return { direction: 'NONE', parts: [] };
  }

  const relativeX = imgIntersectionStart - pixelRectMm.left;
  const relativeY = Math.max(r1.top, imgMmRect.top) - pixelRectMm.top;
  const relativeHeight = Math.min(r1.bottom, imgMmRect.bottom) - Math.max(r1.top, imgMmRect.top);

  const sx = Math.floor(relativeX * scaleX);
  const sy = Math.floor(relativeY * scaleY);
  const sw = Math.ceil(imgRawOverlapWidth * scaleX);
  const sh = Math.ceil(relativeHeight * scaleY);

  if (sw <= 0 || sh <= 0) {
    return { direction: 'NONE', parts: [] };
  }

  const opaqueColumns = new Set<number>();
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const alphaIndex = ((y + sy) * rgba.width + (x + sx)) * 4 + 3;
      if (rgba.data[alphaIndex] > 0) {
        opaqueColumns.add(x + sx);
      }
    }
  }

  if (opaqueColumns.size === 0) {
    return { direction: 'NONE', parts: [] };
  }

  const isFullyCovering = opaqueColumns.size === sw
    && imgIntersectionStart <= r1.left
    && imgIntersectionEnd >= r1.right;
  if (isFullyCovering) {
    return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
  }

  const sortedCols = Array.from(opaqueColumns).sort((a, b) => a - b);
  const mmPerColumn = pixelRectMm.width / rgba.width;
  const imgRelStart = pixelRectMm.left - r1.left;

  const parts: OverlapParts[] = [];
  let partStart = sortedCols[0];
  let prevCol = sortedCols[0];

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
}

/**
 * 인접한 오버랩 구간을 병합한다.
 * 기존 `mergeOverlapParts()`와 동일 로직 — O(n) 정렬 후 스캔.
 *
 * @param parts - 병합할 오버랩 구간 배열
 * @returns 병합된 오버랩 구간 배열
 */
export function mergeOverlapParts(parts: OverlapParts[]): OverlapParts[] {
  if (parts.length === 0) return [];
  const sorted = [...parts].sort((a, b) => a.x1 - b.x1);
  const merged: OverlapParts[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].x1 <= last.x2) {
      last.x2 = Math.max(last.x2, sorted[i].x2);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}