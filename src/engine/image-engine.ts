import { DEFAULT_IMAGE_DPI } from "@/constants";
import type { OverlapMode } from "@/types";
import type { ImageData, PrintPostData } from "@/types";
import type { ImageEngineData, MmRect, OverlapResult, AbsRect } from "./types";
import { computeOverlapSizeMm } from "./overlap-engine";
import { computeObjectFit } from "./object-fit-engine";

export interface RgbaData {
  data: Uint8Array;
  width: number;
  height: number;
}

export class ImageEngine {
  private _data: ImageEngineData;
  private _rgbaData: RgbaData | null = null;
  private _contentAbsRect: AbsRect | null = null;

  static create(data: ImageEngineData): ImageEngine {
    return new this(data);
  }

  private constructor(data: ImageEngineData) {
    this._data = data;
  }

  set data(d: ImageEngineData) {
    this._data = d;
  }

  get data(): ImageEngineData {
    return this._data;
  }

  set contentAbsRect(rect: AbsRect | null) {
    this._contentAbsRect = rect;
  }

  get contentAbsRect(): AbsRect | null {
    return this._contentAbsRect;
  }

  set rgbaData(input: RgbaData | null) {
    this._rgbaData = input;
  }

  get rgbaData(): RgbaData | null {
    return this._rgbaData;
  }

  get overlapMode(): OverlapMode {
    return this._data.overlapMode;
  }

  get overlapPadding(): number | { top?: number; right?: number; bottom?: number; left?: number } | undefined {
    return this._data.overlapPadding;
  }

  get displayRect(): AbsRect {
    const d = this._data;
    const content = this._contentAbsRect;
    if (!content) {
      return {
        absLeft: d.x ?? 0,
        absTop: d.y ?? 0,
        absWidth: d.width ?? 0,
        absHeight: d.height ?? 0,
      };
    }

    const objectFit = d.objectFit ?? 'cover';
    const origW = d.originalWidth ?? 0;
    const origH = d.originalHeight ?? 0;

    if (objectFit === 'none' || origW <= 0 || origH <= 0) {
      return content;
    }

    const fit = computeObjectFit({
      fit: objectFit,
      originalWidth: origW,
      originalHeight: origH,
      boxWidth: content.absWidth,
      boxHeight: content.absHeight,
    });

    return {
      absLeft: content.absLeft + fit.x,
      absTop: content.absTop + fit.y,
      absWidth: fit.width,
      absHeight: fit.height,
    };
  }

  computeOverlap(lineRectMm: MmRect): OverlapResult {
    const absRect: AbsRect = this.displayRect;

    return computeOverlapSizeMm(lineRectMm, {
      absRect,
      overlapMode: this._data.overlapMode,
      overlapPadding: this._data.overlapPadding,
      image: this._rgbaData ? {
        rgbaData: this._rgbaData,
        overlapMode: this._data.overlapMode,
        overlapPadding: this._data.overlapPadding,
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