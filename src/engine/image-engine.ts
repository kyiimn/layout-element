import { DEFAULT_IMAGE_DPI } from "@/constants";
import type { OverlapMode, ImageObjectFit } from "@/types";
import type { ImageData, PrintPostData } from "@/types";
import type { ImageEngineData, MmRect, OverlapResult, AbsRect } from "./types";
import { computeOverlapSizeMm } from "./overlap-engine";
import { computeObjectFit } from "./object-fit-engine";

export interface RgbaData {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * 행별 opaque 컬럼 bitmap을 빌드한다.
 * 각 행은 `ceil(width/8)` 바이트의 Uint8Array — 비트 1 = 해당 컬럼이 불투명.
 * rgbaData 설정 시 1회 호출되어 O(W×H) 스캔을 사전 수행.
 * 이후 `computeSimplePixelOverlap`에서 라인 범위 행만 머지하여 O(H_line) lookups로 판정.
 *
 * @param rgba - 원본 RGBA 데이터
 * @returns 행별 비트맵 배열
 */
function buildOpaqueRowBitmap(rgba: RgbaData): Uint8Array[] {
  const { data, width, height } = rgba;
  const bytesPerRow = Math.ceil(width / 8);
  const result: Uint8Array[] = new Array(height);

  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(bytesPerRow);
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const alphaIndex = (rowOffset + x) * 4 + 3;
      if (data[alphaIndex] > 0) {
        row[x >> 3] |= 1 << (x & 7);
      }
    }
    result[y] = row;
  }

  return result;
}

export class ImageEngine {
  private _data: ImageEngineData;
  private _rgbaData: RgbaData | null = null;
  private _contentAbsRect: AbsRect | null = null;
  private _id: string | undefined;
  private _zIndex: number | undefined;

  /** 성능 캐시: displayRect. contentAbsRect/data 변경 시 무효화. */
  private _displayRectCache: AbsRect | null = null;
  private _displayRectDirty: boolean = true;

  /** 성능 캐시: 행별 opaque 컬럼 bitmap. rgbaData 설정 시 1회 빌드. computeSimplePixelOverlap에서 O(H_line) lookups로 사용. */
  private _opaqueRowBitmap: Uint8Array[] | null = null;

  static create(data: ImageEngineData): ImageEngine {
    return new this(data);
  }

  private constructor(data: ImageEngineData) {
    this._data = data;
  }

  set data(d: ImageEngineData) {
    this._data = d;
    this._displayRectDirty = true;
  }

  get data(): ImageEngineData {
    return this._data;
  }

  set id(v: string | undefined) {
    this._id = v;
  }

  get id(): string | undefined {
    return this._id;
  }

  set zIndex(v: number | undefined) {
    this._zIndex = v;
  }

  get zIndex(): number | undefined {
    return this._zIndex;
  }

  set contentAbsRect(rect: AbsRect | null) {
    this._contentAbsRect = rect;
    this._displayRectDirty = true;
  }

  get contentAbsRect(): AbsRect | null {
    return this._contentAbsRect;
  }

  set rgbaData(input: RgbaData | null) {
    this._rgbaData = input;
    this._opaqueRowBitmap = input ? buildOpaqueRowBitmap(input) : null;
  }

  get rgbaData(): RgbaData | null {
    return this._rgbaData;
  }

  /** 행별 opaque 컬럼 bitmap (rgbaData 설정 시 자동 빌드). */
  get opaqueRowBitmap(): Uint8Array[] | null {
    return this._opaqueRowBitmap;
  }

  get overlapMode(): OverlapMode {
    return this.effectiveOverlapMode;
  }

  get overlapPadding(): number | { top?: number; right?: number; bottom?: number; left?: number } | undefined {
    return this._data.overlapPadding;
  }

  /**
   * 이미지 실제 표시 영역 (절대 좌표, mm).
   * contentAbsRect + objectFit + originalWidth/Height로 계산.
   * 메모이제이션: contentAbsRect/data 변경 시 dirty 플래그로 무효화.
   * @returns 표시 영역 AbsRect
   */
  get displayRect(): AbsRect {
    if (this._displayRectCache !== null && !this._displayRectDirty) {
      return this._displayRectCache;
    }

    const content = this._contentAbsRect;
    let result: AbsRect;

    if (!content) {
      result = {
        absLeft: this.effectiveX,
        absTop: this.effectiveY,
        absWidth: this.effectiveWidth,
        absHeight: this.effectiveHeight,
      };
    } else {
      const objectFit = this.effectiveObjectFit;
      const origW = this.effectiveOriginalWidth;
      const origH = this.effectiveOriginalHeight;

      if (objectFit === 'none' || origW <= 0 || origH <= 0) {
        result = content;
      } else {
        const fit = computeObjectFit({
          fit: objectFit,
          originalWidth: origW,
          originalHeight: origH,
          boxWidth: content.absWidth,
          boxHeight: content.absHeight,
        });

        result = {
          absLeft: content.absLeft + fit.x,
          absTop: content.absTop + fit.y,
          absWidth: fit.width,
          absHeight: fit.height,
        };
      }
    }

    this._displayRectCache = result;
    this._displayRectDirty = false;
    return result;
  }

  computeOverlap(lineRectMm: MmRect): OverlapResult {
    const absRect: AbsRect = this.displayRect;
    const overlapMode = this.effectiveOverlapMode;

    return computeOverlapSizeMm(lineRectMm, {
      absRect,
      overlapMode,
      overlapPadding: this._data.overlapPadding,
      image: this._rgbaData ? {
        rgbaData: this._rgbaData,
        overlapMode,
        overlapPadding: this._data.overlapPadding,
        opaqueRowBitmap: this._opaqueRowBitmap,
      } : null,
      contentType: 'image',
    });
  }

  layout(): { cropRectMm: AbsRect; displayRectMm: AbsRect } {
    const rect = this.displayRect;
    return {
      cropRectMm: rect,
      displayRectMm: rect,
    };
  }

  get dpi(): number {
    return this._data.dpi ?? DEFAULT_IMAGE_DPI;
  }

  get effectiveOverlapMode(): OverlapMode {
    return this._data.overlapMode ?? 'path';
  }

  get effectiveObjectFit(): ImageObjectFit {
    return this._data.objectFit ?? 'cover';
  }

  get effectiveX(): number {
    return this._data.x ?? 0;
  }

  get effectiveY(): number {
    return this._data.y ?? 0;
  }

  get effectiveWidth(): number {
    return this._data.width ?? 0;
  }

  get effectiveHeight(): number {
    return this._data.height ?? 0;
  }

  get effectiveOriginalWidth(): number {
    return this._data.originalWidth ?? 0;
  }

  get effectiveOriginalHeight(): number {
    return this._data.originalHeight ?? 0;
  }

  get extractData(): ImageData {
    const d = this._data;
    return {
      type: 'image',
      id: this._id,
      url: d.url,
      x: this.effectiveX,
      y: this.effectiveY,
      width: this.effectiveWidth,
      height: this.effectiveHeight,
      dpi: this.dpi,
      overlapPadding: d.overlapPadding,
      overlapMode: this.effectiveOverlapMode,
      zIndex: this._zIndex ?? 0,
      originalWidth: this.effectiveOriginalWidth,
      originalHeight: this.effectiveOriginalHeight,
      objectFit: this.effectiveObjectFit,
    };
  }

  buildPrintPostData(absRect: AbsRect): PrintPostData[] {
    const display = this.displayRect;
    const x = display.absLeft - absRect.absLeft;
    const y = display.absTop - absRect.absTop;
    const width = display.absWidth;
    const height = display.absHeight;

    const base = this.extractData;
    const data: ImageData = {
      ...base,
      x,
      y,
      width: width,
      height: height,
    };

    return [{
      data,
      rect: {
        x: absRect.absLeft,
        y: absRect.absTop,
        width: absRect.absWidth,
        height: absRect.absHeight,
      },
    }];
  }
}