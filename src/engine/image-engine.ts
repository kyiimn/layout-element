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

export class ImageEngine {
  private _data: ImageEngineData;
  private _rgbaData: RgbaData | null = null;
  private _contentAbsRect: AbsRect | null = null;
  private _id: string | undefined;
  private _zIndex: number | undefined;

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
    return this.effectiveOverlapMode;
  }

  get overlapPadding(): number | { top?: number; right?: number; bottom?: number; left?: number } | undefined {
    return this._data.overlapPadding;
  }

  get displayRect(): AbsRect {
    const content = this._contentAbsRect;
    if (!content) {
      return {
        absLeft: this.effectiveX,
        absTop: this.effectiveY,
        absWidth: this.effectiveWidth,
        absHeight: this.effectiveHeight,
      };
    }

    const objectFit = this.effectiveObjectFit;
    const origW = this.effectiveOriginalWidth;
    const origH = this.effectiveOriginalHeight;

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
    const overlapMode = this.effectiveOverlapMode;

    return computeOverlapSizeMm(lineRectMm, {
      absRect,
      overlapMode,
      overlapPadding: this._data.overlapPadding,
      image: this._rgbaData ? {
        rgbaData: this._rgbaData,
        overlapMode,
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
    return [{
      data: this.extractData,
      rect: {
        x: absRect.absLeft,
        y: absRect.absTop,
        width: absRect.absWidth,
        height: absRect.absHeight,
      },
    }];
  }
}