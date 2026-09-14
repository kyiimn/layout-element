/**
 * ParagraphEngine 오버랩 회피 서브모듈 — 자유 영역 계산·겹침 판정 캐시·오버랩 해시 키.
 *
 * `paragraph-engine.ts`의 `_computeFreeRegions`/`_detectOverlapWithCache`/
 * `_overlayHashKey`를 본문 그대로 이동한 파일이다. 클래스 상태 접근은 인자
 * 주입으로 치환되며, 판정 수식·`_overlayRectsMm` 무효화 시점·`overlapMode
 * 'none'` 조기 반환 시맨틱은 1바이트도 변경하지 않는다 — snapshot
 * byte-identical 계약.
 *
 * 오버랩 판정 자체는 `./overlap-engine`의 순수 함수(`computeOverlapSizeMm`)가
 * 단일 관문이다. 이 모듈은 판정 캐시(`_overlayRectsMm`) 상호작용 경계를
 * 유지하는 위임 계층이다 — 캐시 소유권은 클래스에 남고, 본 모듈은 캐시를
 * 파라미터로 받아 구성 결과를 반환한다(호출자가 write-back).
 *
 * 소비처:
 * - `paragraph-engine.ts` — private 메서드 위임 (호출부 시그니처 불변)
 *   - `_computeFreeRegions()` → `computeFreeRegions()`
 *   - `_detectOverlapWithCache()` → `detectOverlapWithCache()` (rect 캐시 주입)
 *   - `_overlayHashKey()` → `overlayHashKey()`
 * - `_computeLayoutInputHash`/`_computePrefixHash` → `_overlayHashKey` 위임 유지
 *   (`paragraph-hash.ts`의 `overlayKeysFor`는 keyFn 주입 제네릭으로 유지)
 *
 * @file src/engine/paragraph-overlap.ts
 */

import type { BoxEngine } from "./box-engine";
import type { ImageEngine } from "./image-engine";
import { computeOverlapSizeMm, mergeOverlapParts } from "./overlap-engine";
import type {
  ImageEngineRef,
  MmRect,
  OverlapMode,
  OverlapParts,
  ParagraphOverlapMode,
} from "./types";

/** 라인 내 텍스트 배치 가능 구간 (mm). */
export type FreeRegion = { start: number; end: number };

/**
 * 오버랩 영역의 여집합으로부터 텍스트가 배치될 수 있는 자유 영역을 계산한다.
 * 오버랩이 없으면 `[{ start: 0, end: lineWidth }]`를 반환한다.
 *
 * @param lineWidth - 라인 너비 (mm)
 * @param overlapParts - 오버랩 구간 배열
 * @returns 자유 영역 배열
 * @throws 없음
 */
export function computeFreeRegions(lineWidth: number, overlapParts: OverlapParts[]): FreeRegion[] {
  if (overlapParts.length === 0) {
    return [{ start: 0, end: lineWidth }];
  }

  const freeRegions: FreeRegion[] = [];
  let prevEnd = 0;

  for (const overlap of overlapParts) {
    if (overlap.x1 > prevEnd) {
      freeRegions.push({ start: prevEnd, end: overlap.x1 });
    }
    prevEnd = Math.max(prevEnd, overlap.x2);
  }

  if (prevEnd < lineWidth) {
    freeRegions.push({ start: prevEnd, end: lineWidth });
  }

  return freeRegions;
}

/**
 * 오버랩 요소(이미지 등)와의 겹침 계산.
 * 성능 최적화: rect 캐시(`rectsMm`)를 사용하여 렌더링 사이클마다
 * 오버랩 요소의 mm rect를 한 번 구성 후 재사용한다.
 * COVER면 라인 전체가 덮인 것이고, PART면 일부만 덮인 것이다.
 *
 * 캐시 소유권은 클래스(`ParagraphEngine._overlayRectsMm`)에 남는다 —
 * 이 함수는 캐시를 파라미터로 받아 null이면 구성하고, 구성된 캐시를
 * 반환값으로 돌려준다. 호출자(엔진 위임자)가 필드에 write-back한다.
 *
 * @example
 * // 엔진 위임자의 전형적 사용 (캐시 write-back 포함):
 * const result = detectOverlapWithCache(
 *   this._data.overlayEngines,
 *   lineRectMm,
 *   this._overlayRectsMm,
 * );
 * this._overlayRectsMm = result.rectsMm; // 무효화(null) 이후 재구성 반영
 *
 * @param overlayEngines - 오버랩 박스 엔진 배열 (엔진 `_data.overlayEngines`)
 * @param lineRectMm - 라인 사각형 (mm)
 * @param rectsMm - 현재 rect 캐시 (null이면 이번 호출에서 구성)
 * @returns cover 여부와 오버랩 구간 배열, 구성된 rect 캐시
 * @throws 없음
 */
export function detectOverlapWithCache(
  overlayEngines: readonly BoxEngine[],
  lineRectMm: MmRect,
  rectsMm: Map<BoxEngine, MmRect> | null,
): { cover: boolean; overlapParts: OverlapParts[]; rectsMm: Map<BoxEngine, MmRect> } {
  const overlapEls = overlayEngines;
  let cover = false;
  let parts: OverlapParts[] = [];

  let cache = rectsMm;
  if (cache === null) {
    cache = new Map();
    for (const el of overlapEls) {
      const rect = el.absRect;
      cache.set(el, {
        left: rect.absLeft,
        right: rect.absLeft + rect.absWidth,
        top: rect.absTop,
        bottom: rect.absTop + rect.absHeight,
        width: rect.absWidth,
        height: rect.absHeight,
      });
    }
  }

  for (const el of overlapEls) {
    const elRect = cache.get(el);
    if (!elRect) continue;

    if (lineRectMm.bottom <= elRect.top || lineRectMm.top >= elRect.bottom) {
      continue;
    }

    let mode: OverlapMode | ParagraphOverlapMode = "path";
    let padding: number | { top?: number; right?: number; bottom?: number; left?: number } | undefined;

    const contentType = el.contentType;
    let type: { direction: "NONE" | "COVERS" | "PART"; parts: OverlapParts[] };

    if (contentType === "image") {
      const img = el.contentElement as ImageEngine | null;
      if (img) {
        mode = img.overlapMode;
        padding = img.overlapPadding;
        type = img.computeOverlap(lineRectMm);
      } else {
        type = { direction: 'NONE', parts: [] };
      }
    } else {
      type = computeOverlapSizeMm(lineRectMm, {
        absRect: el.absRect,
        overlapMode: mode,
        overlapPadding: padding,
        image: null,
        contentType: contentType ?? 'paragraph',
      });
    }

    if (type.direction === "COVERS") cover = true;
    if (type.direction === "PART") parts = parts.concat(type.parts);
  }

  return { cover, overlapParts: mergeOverlapParts(parts), rectsMm: cache };
}

/**
 * 오버랩 요소 하나의 해시 키(배치에 영향을 주는 모든 요소)를 생성한다.
 *
 * `_computeLayoutInputHash`와 `_computePrefixHash`가 동일 키를 사용해야
 * prefix 캐시와 전체 캐시가 일관되게 무효화되므로 단일 소스로 추출했다.
 *
 * 이미지 오버랩 판정(`ImageEngine.computeOverlap`)은 박스 rect(`el.absRect`)가
 * 아니라 **`displayRect`**(objectFit/none x/y/w/h 기반 실제 표시 영역)를
 * 기준으로 수행한다. 따라서 `objectFit` 변경이나 `'none'` 모드의
 * x/y/width/height 변경은 displayRect 변화 → 오버랩 회피 결과 변화로
 * 이어지므로, 해시는 반드시 displayRect를 포함해야 stale 캐시 히트를
 * 막을 수 있다 (박스 rect는 이때 불변이므로 감지 불가).
 *
 * @param el - 오버랩 박스 엔진
 * @param pAbsLeft - 부모 박스 절대 left (mm)
 * @param pAbsTop - 부모 박스 절대 top (mm)
 * @returns 오버랩 요소 해시 키
 * @throws 없음
 */
export function overlayHashKey(el: BoxEngine, pAbsLeft: number, pAbsTop: number): string {
  let mode: OverlapMode | ParagraphOverlapMode = "path";
  let hasRgba = false;
  let paddingKey = "";
  let displayRectKey = "";
  if (el.contentType === "image") {
    const img = el.contentElement as ImageEngineRef | null;
    if (img) {
      mode = img.overlapMode;
      hasRgba = img.rgbaData !== null;
      const pad = img.overlapPadding;
      if (pad === undefined) {
        paddingKey = "0";
      } else if (typeof pad === "number") {
        paddingKey = "n" + pad;
      } else {
        paddingKey = "o" + (pad.top ?? 0) + "," + (pad.right ?? 0) + "," + (pad.bottom ?? 0) + "," + (pad.left ?? 0);
      }
      // 오버랩 판정의 실제 기준 영역. objectFit/'none' x/y/w/h 변경 감지용.
      // ImageEngineRef.displayRect는 optional이지만 ImageEngine 구현은 항상
      // 반환하므로, 미제공(레거시 stub) 시 빈 키로 폴백한다.
      const dr = img.displayRect;
      displayRectKey = dr
        ? "d:" + (dr.absLeft - pAbsLeft) + "," + (dr.absTop - pAbsTop) + "," + dr.absWidth + "," + dr.absHeight
        : "d:-";
    }
  }
  const rect = el.absRect;
  const relLeft = rect.absLeft - pAbsLeft;
  const relTop = rect.absTop - pAbsTop;
  return "o:" + relLeft + "," + relTop + "," + rect.absWidth + "," + rect.absHeight
    + "," + mode + "," + (hasRgba ? 1 : 0) + "," + paddingKey + "," + displayRectKey;
}