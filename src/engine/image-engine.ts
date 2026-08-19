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
import type { ImageEngineData, MmRect, OverlapResult, AbsRect } from "./types";
import { computeOverlapSizeMm } from "./overlap-engine";

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
   * `overlap-engine.ts`의 `computeOverlapSizeMm()`에 위임한다.
   * `overlapMode === 'path'`이고 `rgbaData`가 있으면 픽셀 단위 판정을 수행한다.
   * `rgbaData`가 없으면 기하학적 rect 기반 fallback.
   * `overlapMode === 'box'`이면 항상 기하학적 rect 기반.
   *
   * @param lineRectMm - 라인 사각형 (mm)
   * @param imgRectMm - 이미지 절대 사각형 (mm)
   * @returns 오버랩 판정 결과
   */
  computeOverlap(lineRectMm: MmRect, imgRectMm: AbsRect): OverlapResult {
    return computeOverlapSizeMm(lineRectMm, {
      absRect: imgRectMm,
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

  /**
   * 이미지 레이아웃을 계산한다.
   * objectFit/originalWidth/originalHeight로부터 크롭/디스플레이 영역을 산출.
   *
   * `objectFit !== 'none'`이고 `originalWidth`/`originalHeight`가 설정된 경우,
   * `computeObjectFit` 로직을 적용하여 박스 내 표시 위치/크기를 계산한다.
   * `objectFit === 'none'`이면 raw `x/y/w/h`를 그대로 사용한다.
   *
   * @returns 이미지 레이아웃 결과 (mm)
   */
  layout(): { cropRectMm: AbsRect; displayRectMm: AbsRect } {
    const d = this._data;
    const x = d.x ?? 0;
    const y = d.y ?? 0;
    const width = d.width ?? 0;
    const height = d.height ?? 0;

    const objectFit = d.objectFit ?? 'cover';
    const originalWidth = d.originalWidth;
    const originalHeight = d.originalHeight;

    if (objectFit !== 'none' && originalWidth !== undefined && originalHeight !== undefined && originalWidth > 0 && originalHeight > 0 && width > 0 && height > 0) {
      const imgAspect = originalWidth / originalHeight;
      const boxAspect = width / height;

      let fitX: number, fitY: number, fitW: number, fitH: number;

      if (objectFit === 'fill') {
        fitX = 0; fitY = 0; fitW = width; fitH = height;
      } else if (objectFit === 'cover') {
        if (imgAspect > boxAspect) {
          fitH = height;
          fitW = height * imgAspect;
          fitX = (width - fitW) / 2;
          fitY = 0;
        } else {
          fitW = width;
          fitH = width / imgAspect;
          fitX = 0;
          fitY = (height - fitH) / 2;
        }
      } else {
        if (imgAspect > boxAspect) {
          fitW = width;
          fitH = width / imgAspect;
          fitX = 0;
          fitY = (height - fitH) / 2;
        } else {
          fitH = height;
          fitW = height * imgAspect;
          fitX = (width - fitW) / 2;
          fitY = 0;
        }
      }

      return {
        cropRectMm: { absLeft: x + fitX, absTop: y + fitY, absWidth: fitW, absHeight: fitH },
        displayRectMm: { absLeft: x + fitX, absTop: y + fitY, absWidth: fitW, absHeight: fitH },
      };
    }

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