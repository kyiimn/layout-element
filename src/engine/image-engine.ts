import { DEFAULT_IMAGE_DPI } from "@/constants";
import type { OverlapMode, ImageObjectFit } from "@/types";
import type { ImageData, PrintPostData } from "@/types";
import type { ImageEngineData, MmRect, OverlapResult, AbsRect } from "./types";
import { createDirtyError } from "./types";
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

  private _dirty: boolean = false;

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
    this._dirty = true;
  }

  get zIndex(): number | undefined {
    return this._zIndex;
  }

  set contentAbsRect(rect: AbsRect | null) {
    this._contentAbsRect = rect;
    this._displayRectDirty = true;
    this._dirty = true;
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
   *
   * objectFit 모드에 따라 단일 소스로 계산한다:
   * - `'cover'`/`'contain'`/`'fill'`: 입력 x/y/width/height를 **무시**하고
   *   `computeObjectFit()` 결과만 사용한다. `contentAbsRect`가 없으면
   *   계산 불가(빈 rect), 원본 크기 미설정이면 박스 영역으로 폴백.
   * - `'none'`: 입력 x/y/width/height를 그대로 사용한다. 생략된 필드는
   *   x/y → 0, width/height → originalWidth/originalHeight(1:1) 폴백.
   *   `contentAbsRect`가 없으면 입력값을 절대 좌표로 해석한다.
   *
   * 메모이제이션: contentAbsRect/data 변경 시 dirty 플래그로 무효화.
   *
   * @returns 표시 영역 AbsRect
   *
   * @example
   * ```ts
   * // cover: 원본 100×50mm → 박스 80×80mm → { absLeft: box.x-60, absTop: box.y, 160, 80 }
   * // none + { x: 10, y: 5, width: 50, height: 25 } → 박스 내 (10, 5)에 50×25mm 배치
   * ```
   */
  get displayRect(): AbsRect {
    if (this._displayRectCache !== null && !this._displayRectDirty) {
      return this._displayRectCache;
    }

    const content = this._contentAbsRect;
    const objectFit = this.effectiveObjectFit;
    let result: AbsRect;

    if (objectFit === 'none') {
      // none: 입력 x/y/width/height를 그대로 사용.
      // width/height 생략 시 originalWidth/originalHeight(1:1) 폴백.
      const w = this._data.width ?? this.effectiveOriginalWidth ?? 0;
      const h = this._data.height ?? this.effectiveOriginalHeight ?? 0;
      const relX = this.effectiveX;
      const relY = this.effectiveY;

      result = content
        ? {
            absLeft: content.absLeft + relX,
            absTop: content.absTop + relY,
            absWidth: w,
            absHeight: h,
          }
        : {
            absLeft: relX,
            absTop: relY,
            absWidth: w,
            absHeight: h,
          };
    } else if (!content) {
      // cover/contain/fill이지만 contentAbsRect 미설정(초기 라이프사이클):
      // 계산 불가 — 빈 rect.
      result = { absLeft: 0, absTop: 0, absWidth: 0, absHeight: 0 };
    } else {
      const origW = this.effectiveOriginalWidth;
      const origH = this.effectiveOriginalHeight;

      if (origW <= 0 || origH <= 0) {
        // 원본 크기 미설정 — 박스 영역으로 폴백(기존 동작 유지).
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
    const displayRect: AbsRect = this.displayRect;
    const overlapMode = this.effectiveOverlapMode;

    // displayRect를 contentAbsRect로 클램프하여 박스 밖 잘린 부분을 오버랩 판정에서 제외.
    // cover 모드 등에서 displayRect가 contentAbsRect 밖으로 넘칠 때,
    // 넘친 부분은 실제로 보이지 않으므로 오버랩 영역에서 제외되어야 한다.
    const clip = this._contentAbsRect;
    const clampedAbsRect: AbsRect = clip
      ? {
          absLeft: Math.max(displayRect.absLeft, clip.absLeft),
          absTop: Math.max(displayRect.absTop, clip.absTop),
          absWidth: Math.min(displayRect.absLeft + displayRect.absWidth, clip.absLeft + clip.absWidth) -
            Math.max(displayRect.absLeft, clip.absLeft),
          absHeight: Math.min(displayRect.absTop + displayRect.absHeight, clip.absTop + clip.absHeight) -
            Math.max(displayRect.absTop, clip.absTop),
        }
      : displayRect;

    if (clampedAbsRect.absWidth <= 0 || clampedAbsRect.absHeight <= 0) {
      return { direction: 'NONE', parts: [] };
    }

    return computeOverlapSizeMm(lineRectMm, {
      absRect: clampedAbsRect,
      overlapMode,
      overlapPadding: this._data.overlapPadding,
      image: this._rgbaData ? {
        rgbaData: this._rgbaData,
        overlapMode,
        overlapPadding: this._data.overlapPadding,
        opaqueRowBitmap: this._opaqueRowBitmap,
        displayRect,
      } : null,
      contentType: 'image',
    });
  }

  layout(): { cropRectMm: AbsRect; displayRectMm: AbsRect } {
    const rect = this.displayRect;
    this._dirty = false;
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

  // ── 개별 setter (dirty 표시만, layout() 호출 시 원자 반영) ──

  set x(value: number | undefined) {
    if (this._data.x === value) return;
    this._data = { ...this._data, x: value };
    this._displayRectDirty = true;
    this._dirty = true;
  }

  set y(value: number | undefined) {
    if (this._data.y === value) return;
    this._data = { ...this._data, y: value };
    this._displayRectDirty = true;
    this._dirty = true;
  }

  set width(value: number | undefined) {
    if (this._data.width === value) return;
    this._data = { ...this._data, width: value };
    this._displayRectDirty = true;
    this._dirty = true;
  }

  set height(value: number | undefined) {
    if (this._data.height === value) return;
    this._data = { ...this._data, height: value };
    this._displayRectDirty = true;
    this._dirty = true;
  }

  set dpi(value: number) {
    if ((this._data.dpi ?? DEFAULT_IMAGE_DPI) === value) return;
    this._data = { ...this._data, dpi: value };
    this._dirty = true;
  }

  set url(value: string) {
    if (this._data.url === value) return;
    this._data = { ...this._data, url: value };
    this._dirty = true;
  }

  set overlapMode(value: OverlapMode) {
    if ((this._data.overlapMode ?? 'path') === value) return;
    this._data = { ...this._data, overlapMode: value };
    this._dirty = true;
  }

  set overlapPadding(value: number | { top?: number; right?: number; bottom?: number; left?: number } | undefined) {
    if (this._data.overlapPadding === value) return;
    this._data = { ...this._data, overlapPadding: value };
    this._dirty = true;
  }

  set objectFit(value: ImageObjectFit) {
    if ((this._data.objectFit ?? 'cover') === value) return;
    this._data = { ...this._data, objectFit: value };
    this._displayRectDirty = true;
    this._dirty = true;
  }

  set originalWidth(value: number | undefined) {
    if (this._data.originalWidth === value) return;
    this._data = { ...this._data, originalWidth: value };
    this._displayRectDirty = true;
    this._dirty = true;
  }

  set originalHeight(value: number | undefined) {
    if (this._data.originalHeight === value) return;
    this._data = { ...this._data, originalHeight: value };
    this._displayRectDirty = true;
    this._dirty = true;
  }

  /** 개별 setter로 인해 커밋되지 않은 변경이 있는지 여부. */
  get dirty(): boolean {
    return this._dirty;
  }

  get extractData(): ImageData {
    if (this._dirty) throw createDirtyError('ImageEngine');
    const d = this._data;

    // 엔진-우선: x/y/width/height는 displayRect(모드별 단일 소스)에서 산출.
    // contentAbsRect가 있으면 박스 기준 상대 좌표로 변환.
    const display = this.displayRect;
    const content = this._contentAbsRect;
    const x = content ? display.absLeft - content.absLeft : display.absLeft;
    const y = content ? display.absTop - content.absTop : display.absTop;

    return {
      type: 'image',
      id: this._id,
      url: d.url,
      x,
      y,
      width: display.absWidth,
      height: display.absHeight,
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