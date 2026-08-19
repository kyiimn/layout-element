/**
 * Node.js 호환 이미지 레이아웃/오버랩 계산 엔진.
 *
 * 기존 `LayoutImageElement`에서 canvas 의존성을 제거한 순수 계산 버전.
 * - `canvas.getContext('2d').getImageData()` 대신 `rgbaData: Uint8Array`를 주입받음
 * - 브라우저: 엘리먼트가 canvas에서 RGBA 추출 후 주입
 * - Node: `pngjs.decode(ArrayBuffer)` 결과를 주입 (Locked Decision 2)
 * - 오버랩 판정 알고리즘 (타원 패딩, opaque columns)은 기존과 동일
 *
 * @file src/engine/image-engine.ts
 */

import { DEFAULT_IMAGE_DPI } from "@/constants";
import type { OverlapMode } from "@/types";
import type { ImageData, PrintPostData } from "@/types";
import type { ImageEngineData, MmRect, OverlapResult, OverlapParts, AbsRect } from "./types";
import { mergeOverlapParts } from "./overlap-engine";

/**
 * RGBA 픽셀 데이터.
 * canvas `ImageData` 또는 pngjs 디코딩 결과의 공통 인터페이스.
 */
export interface RgbaData {
  /** RGBA 픽셀 배열 (0-255, row-major, stride = width × 4) */
  data: Uint8Array;
  /** 픽셀 너비 */
  width: number;
  /** 픽셀 높이 */
  height: number;
}

/**
 * 이미지 레이아웃과 오버랩 판정을 수행하는 순수 엔진.
 *
 * 인스턴스는 `ImageEngine.create(data)` 팩토리로만 생성.
 * RGBA 데이터는 `rgbaData` setter를 통해 외부에서 주입된다
 * (브라우저: canvas, Node: pngjs).
 *
 * @example
 * const engine = ImageEngine.create({
 *   url: 'photo.png',
 *   dpi: 72,
 *   overlapMode: 'path',
 *   objectFit: 'cover',
 * });
 * // 브라우저: canvas에서 추출
 * engine.rgbaData = { data: uint8Array, width: 800, height: 600 };
 * // Node: pngjs에서 추출
 * engine.rgbaData = { data: png.data, width: png.width, height: png.height };
 *
 * const result = engine.computeOverlap(lineRectMm, imgRectMm);
 */
export class ImageEngine {
  private _data: ImageEngineData;
  private _rgbaData: RgbaData | null = null;

  /**
   * 정적 팩토리 메서드. `new` 직접 사용 금지.
   *
   * @param data - 이미지 엔진 데이터
   * @returns ImageEngine 인스턴스
   */
  static create(data: ImageEngineData): ImageEngine {
    return new this(data);
  }

  private constructor(data: ImageEngineData) {
    this._data = data;
  }

  /**
   * 이미지 데이터를 설정한다.
   *
   * @param d - 새 이미지 엔진 데이터
   */
  set data(d: ImageEngineData) {
    this._data = d;
  }

  /** 현재 이미지 엔진 데이터 */
  get data(): ImageEngineData {
    return this._data;
  }

  /**
   * RGBA 픽셀 데이터를 주입한다.
   *
   * 브라우저: `canvas.getContext('2d').getImageData(0,0,w,h)` 결과에서
   * `new Uint8Array(id.data.buffer)`를 전달.
   *
   * Node: `pngjs.decode(Buffer)` 결과에서
   * `new Uint8Array(png.data)`를 전달.
   *
   * `null`을 설정하면 RGBA 데이터가 없는 상태가 되며,
   * `overlapMode === 'path'`일 때 기하학적 fallback으로 동작한다.
   *
   * @param input - RGBA 데이터 또는 null
   */
  set rgbaData(input: RgbaData | null) {
    this._rgbaData = input;
  }

  /** 주입된 RGBA 데이터 (없으면 null) */
  get rgbaData(): RgbaData | null {
    return this._rgbaData;
  }

  /** 오버랩 처리 모드 */
  get overlapMode(): OverlapMode {
    return this._data.overlapMode;
  }

  /** 오버랩 패딩 (mm) */
  get overlapPadding(): number | { top?: number; right?: number; bottom?: number; left?: number } | undefined {
    return this._data.overlapPadding;
  }

  /**
   * 라인 사각형과 이미지 사각형의 오버랩을 판정한다.
   *
   * `overlapMode === 'path'`이고 `rgbaData`가 있으면 픽셀 단위 판정을 수행한다.
   * `rgbaData`가 없으면 기하학적 rect 기반 fallback.
   * `overlapMode === 'box'`이면 항상 기하학적 rect 기반.
   *
   * @param lineRectMm - 라인 사각형 (mm)
   * @param imgRectMm - 이미지 절대 사각형 (mm)
   * @returns 오버랩 판정 결과
   */
  computeOverlap(lineRectMm: MmRect, imgRectMm: AbsRect): OverlapResult {
    const r1 = lineRectMm;
    const r2: MmRect = {
      left: imgRectMm.absLeft,
      right: imgRectMm.absLeft + imgRectMm.absWidth,
      top: imgRectMm.absTop,
      bottom: imgRectMm.absTop + imgRectMm.absHeight,
      width: imgRectMm.absWidth,
      height: imgRectMm.absHeight,
    };

    let padTop = 0, padRight = 0, padBottom = 0, padLeft = 0;
    let hasOverlapPadding = false;
    const padding = this._data.overlapPadding;
    if (padding !== undefined) {
      padTop = typeof padding === 'number' ? padding : padding.top ?? 0;
      padRight = typeof padding === 'number' ? padding : padding.right ?? 0;
      padBottom = typeof padding === 'number' ? padding : padding.bottom ?? 0;
      padLeft = typeof padding === 'number' ? padding : padding.left ?? 0;
      hasOverlapPadding = true;
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

    const overlapMode = this._data.overlapMode;

    // 'path' 모드 + RGBA 데이터 있음 → 픽셀 단위 판정
    if (overlapMode === 'path' && this._rgbaData) {
      return this._computePixelOverlap(r1, imgRectMm, padTop, padRight, padBottom, padLeft, hasOverlapPadding);
    }

    // 'box' 모드 또는 RGBA 없음 → 기하학적 판정
    if (r2.left <= r1.left && r2.right >= r1.right) {
      return { direction: 'COVERS', parts: [{ x1: 0, x2: r1.width }] };
    }

    const relStart = intersectionStart - r1.left;
    const relEnd = intersectionEnd - r1.left;
    return { direction: 'PART', parts: [{ x1: relStart, x2: relEnd }] };
  }

  /**
   * RGBA 픽셀 데이터를 사용한 정밀 오버랩 판정.
   *
   * 기존 `check-overlap.ts`의 canvas 기반 알고리즘을 Uint8Array 기반으로 포팅.
   * 타원 패딩(overlapPadding)과 opaque column 그룹화 로직은 동일.
   */
  private _computePixelOverlap(
    r1: MmRect,
    imgRectMm: AbsRect,
    padTop: number,
    padRight: number,
    padBottom: number,
    padLeft: number,
    hasOverlapPadding: boolean,
  ): OverlapResult {
    const imgMmRect: MmRect = {
      left: imgRectMm.absLeft,
      right: imgRectMm.absLeft + imgRectMm.absWidth,
      top: imgRectMm.absTop,
      bottom: imgRectMm.absTop + imgRectMm.absHeight,
      width: imgRectMm.absWidth,
      height: imgRectMm.absHeight,
    };

    const rgba = this._rgbaData!;
    if (imgMmRect.width <= 0 || imgMmRect.height <= 0) {
      return { direction: 'NONE', parts: [] };
    }
    const scaleX = rgba.width / imgMmRect.width;
    const scaleY = rgba.height / imgMmRect.height;

    if (hasOverlapPadding) {
      const sampleTopMm = Math.max(imgMmRect.top, r1.top - padBottom);
      const sampleBottomMm = Math.min(imgMmRect.bottom, r1.bottom + padTop);

      let sy: number;
      let sh: number;

      if (sampleBottomMm > sampleTopMm) {
        const relY = sampleTopMm - imgMmRect.top;
        sy = Math.max(0, Math.floor(relY * scaleY));
        sh = Math.min(rgba.height - sy, Math.ceil((sampleBottomMm - sampleTopMm) * scaleY));
      } else if (r1.bottom <= imgMmRect.top) {
        sy = 0;
        sh = Math.min(rgba.height, Math.ceil(padTop * scaleY));
      } else {
        sh = Math.min(rgba.height, Math.ceil(padBottom * scaleY));
        sy = rgba.height - sh;
      }

      const sx = 0;
      const sw = rgba.width;

      if (sw > 0 && sh > 0) {
        const opaqueColumns = this._findOpaqueColumnsEllipse(
          rgba.data, rgba.width,
          sx, sy, sw, sh,
          scaleX, scaleY,
          imgMmRect, r1,
          padTop, padBottom, padLeft, padRight,
        );

        if (opaqueColumns.size === 0) {
          return { direction: 'NONE', parts: [] };
        }

        const mmPerColumn = imgMmRect.width / rgba.width;
        const paddedParts: { x1: number; x2: number }[] = [];
        for (const col of Array.from(opaqueColumns).sort((a, b) => a - b)) {
          const colStart = imgMmRect.left - r1.left + col * mmPerColumn - padLeft;
          const colEnd = imgMmRect.left - r1.left + (col + 1) * mmPerColumn + padRight;
          if (colEnd > 0 && colStart < r1.width) {
            paddedParts.push({
              x1: Math.max(0, colStart),
              x2: Math.min(r1.width, colEnd),
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
    }

    // overlapPadding 없음 → 단순 opaque column 판정
    const imgIntersectionStart = Math.max(r1.left, imgMmRect.left);
    const imgIntersectionEnd = Math.min(r1.right, imgMmRect.right);
    const imgRawOverlapWidth = imgIntersectionEnd - imgIntersectionStart;
    if (imgRawOverlapWidth <= 0) {
      return { direction: 'NONE', parts: [] };
    }

    const relativeX = imgIntersectionStart - imgMmRect.left;
    const relativeY = Math.max(r1.top, imgMmRect.top) - imgMmRect.top;
    const relativeHeight = Math.min(r1.bottom, imgMmRect.bottom) - Math.max(r1.top, imgMmRect.top);

    const sx = Math.floor(relativeX * scaleX);
    const sy = Math.floor(relativeY * scaleY);
    const sw = Math.ceil(imgRawOverlapWidth * scaleX);
    const sh = Math.ceil(relativeHeight * scaleY);

    if (sw <= 0 || sh <= 0) {
      return { direction: 'NONE', parts: [] };
    }

    const opaqueColumns = this._findOpaqueColumnsSimple(
      rgba.data, rgba.width,
      sx, sy, sw, sh,
    );

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
    const mmPerColumn = imgRawOverlapWidth / sw;
    const imgRelStart = imgIntersectionStart - r1.left;

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
   * 타원 기반 패딩을 적용하여 불투명 픽셀 열을 찾는다.
   * `ndx² + ndy² ≤ 1` 조건으로 패딩 영역 내 픽셀을 판정.
   */
  private _findOpaqueColumnsEllipse(
    data: Uint8Array,
    imgWidth: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    scaleX: number,
    scaleY: number,
    imgMmRect: MmRect,
    r1: MmRect,
    padTop: number,
    padBottom: number,
    padLeft: number,
    padRight: number,
  ): Set<number> {
    const opaqueColumns = new Set<number>();

    for (let y = 0; y < sh; y++) {
      const pixelMmY = (sy + y) / scaleY + imgMmRect.top;

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
        const alphaIdx = ((y + sy) * imgWidth + (x + sx)) * 4 + 3;
        if (data[alphaIdx] === 0) continue;

        const pixelMmX = (sx + x) / scaleX + imgMmRect.left;

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

    return opaqueColumns;
  }

  /**
   * 단순 불투명 픽셀 열 찾기 (타원 패딩 없음).
   */
  private _findOpaqueColumnsSimple(
    data: Uint8Array,
    imgWidth: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): Set<number> {
    const opaqueColumns = new Set<number>();
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const alphaIdx = ((y + sy) * imgWidth + (x + sx)) * 4 + 3;
        if (data[alphaIdx] > 0) {
          opaqueColumns.add(x + sx);
        }
      }
    }
    return opaqueColumns;
  }

  /**
   * 이미지 레이아웃을 계산한다.
   * objectFit/originalWidth/originalHeight로부터 크롭/디스플레이 영역을 산출.
   *
   * @returns 이미지 레이아웃 결과 (mm)
   */
  layout(): { cropRectMm: AbsRect; displayRectMm: AbsRect } {
    const d = this._data;
    const x = d.x ?? 0;
    const y = d.y ?? 0;
    const width = d.width ?? 0;
    const height = d.height ?? 0;

    return {
      cropRectMm: { absLeft: x, absTop: y, absWidth: width, absHeight: height },
      displayRectMm: { absLeft: x, absTop: y, absWidth: width, absHeight: height },
    };
  }

  /** 이미지 DPI (기본값 72) */
  get dpi(): number {
    return this._data.dpi ?? DEFAULT_IMAGE_DPI;
  }

  /**
   * 이미지 엔진의 printPostData를 생성한다 (mm 단위).
   *
   * @param absRect - 이미지의 절대 사각형 (mm)
   * @param imageData - 이미지 원본 데이터
   * @returns PrintPostData 배열 (단일 항목, mm 단위)
   */
  buildPrintPostData(absRect: AbsRect, imageData: ImageData): PrintPostData[] {
    return [{
      data: imageData,
      rect: {
        x: absRect.absLeft,
        y: absRect.absTop,
        width: absRect.absWidth,
        height: absRect.absHeight,
      },
    }];
  }
}