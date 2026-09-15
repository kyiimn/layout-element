/**
 * ParagraphEngine canvas 드로잉 명령 빌더 — 모듈 함수.
 *
 * CANVAS_RENDERING.md §3.2 수정 설계: DrawCommand는 굵기·색상을 내장하지
 * 않고 `runStyleRef`(live inlineStyles 참조)를 보유한다 — 폰트/색상은
 * 페인트 시점에 해석하며 구조적으로 stale 불가능하다. 좌표는 printPostData와
 * 동일 워크(charOffsets 소비·strip 규칙·탭 스킵·오버플로 게이팅)로 mm
 * 단위로 산출하고 px 변환은 하지 않는다 (엔진-우선: mm 단일 소스).
 *
 * 소비처:
 * - `paragraph-engine.ts` — `drawList` 게터 위임 + `export` 재-export
 *
 * @file src/engine/paragraph-canvas.ts
 */

import { computeStripRange, firstNonEmpty } from "./paragraph-text-utils";
import type { TextLineData } from "@/types";
import type { ParagraphEngine } from "./paragraph-engine";

/**
 * 좌우 밀기 탭 문자 (`\t`) — 폭 0 마커. 드로잉에서 제외한다
 * (printPostData의 탭 스킵과 동일 규칙).
 */
const RIGHT_INDENT_TAB_CHAR = "\t";

/**
 * canvas paint가 페인트 시점에 해석하는 글자 런 스타일 참조.
 *
 * 굵기/색상/폰트는 명령에 내장하지 않는다 — live 참조만 보유하므로
 * 굵게/색상 주입 후 캐시 히트가 발생해도 페인트가 항상 현재 스타일을
 * 반영한다 (§3.2 결함 방어). `undefined` 필드는 페인트 시점에 문단
 * effective 스타일로 폴백한다 (printPostData와 동일 체인).
 */
export type DrawRunStyleRef = {
  /** 이 글자의 인라인 런 스타일 (live 참조 — 파트 inlineStyles 배열의 요소) */
  inlineStyle: import("@/types").TextInlineStyle | undefined;
  /** 문단 단위 폴백 소스 (paint 시점 해석용) */
  paragraph: {
    textStyle: import("@/types").TextStyle;
    inheritStyle: import("./types").InheritStyle | undefined;
  };
};

/**
 * canvas 드로잉 명령. mm 단위 — px 변환은 paint 시점에 ppm×scale로 수행.
 */
export type DrawCommand =
  | {
      kind: 'char';
      /** 글자 (공백·탭은 드로잉 생략 — 좌표만 소비) */
      char: string;
      /** 파트 기준 글자 좌측 오프셋 (mm) */
      charOffsetMm: number;
      /** 라인 좌측 절대 오프셋 (mm — parentAbsRect.absLeft + columnLeft) */
      lineLeftMm: number;
      /** 라인 상단 절대 오프셋 (mm — parentAbsRect.absTop + alignOffset + cumulativeTop) */
      lineTopMm: number;
      /** 배치 소비 폭 (mm — swidth) */
      widthMm: number;
      /** 글자 폰트 크기 (mm — rect height와 baseline 산출에 소비) */
      fontSizeMm: number;
      /** 라인 최대 폰트 크기 (mm — 하단 앵커 vertical offset 산출용) */
      lineMaxFontSizeMm: number;
      /** 페인트 시점 해석 스타일 참조 */
      runStyle: DrawRunStyleRef;
      /** 걸침 마킹 — 페인트가 컬럼 밖 돌출 위치를 그린다 */
      hangs: 'start' | 'end' | undefined;
    }
  | {
      kind: 'deco';
      /** 장식선 종류 */
      decoKind: 'underline' | 'breakline';
      /** 파트 기준 x (mm) */
      xMm: number;
      /** 라인 상단 기준 y (mm) */
      yMm: number;
      widthMm: number;
      heightMm: number;
      /** 색상 이름 (페인트 시점에 ColorRegistry가 hex로 해석 — bake 금지) */
      colorName: string;
    };

/**
 * buildParagraphDrawList 결과 — 문단 1개의 전체 드로잉 명령 목록.
 */
export type ParagraphDrawList = {
  /** 글자 명령 (공백·탭 제외 — 좌표만 소비하므로 드로잉 명령에서 생략) */
  chars: Extract<DrawCommand, { kind: 'char' }>[];
  /** 장식선 명령 (underline/breakline) */
  decos: Extract<DrawCommand, { kind: 'deco' }>[];
};

/**
 * 문단 1개의 canvas 드로잉 명령 목록을 생성한다.
 *
 * `buildParagraphPrintPostData`와 동일 워크를 수행하되 (a) px 변환 없이 mm
 * 유지, (b) 폰트/색상을 해석하지 않고 runStyleRef로 참조만 보유, (c) 공백·탭은
 * 명령에서 제외한다. 걸침 글자도 배치 좌표(charOffsets)를 그대로 소비한다 —
 * 걸친 글자의 charOffset은 파트 경계 밖 값(partWidth - 0.5×w₀ 또는 -swidth)이므로
 * 페인트가 그대로 컬럼 밖에 그린다.
 *
 * @param engine - 배치 완료된 ParagraphEngine (columnContents 조회에 소비)
 * @returns 드로잉 명령 목록
 * @throws 없음 — 배치 전(빈 columnContents)이면 빈 목록
 */
export function buildParagraphDrawList(engine: ParagraphEngine): ParagraphDrawList {
  const chars: ParagraphDrawList['chars'] = [];
  const decos: ParagraphDrawList['decos'] = [];
  const columnContents = engine.columnContents;
  const columnWidths = engine.columnWidths;
  const gaps = engine.gaps;
  const inheritStyle = engine.inheritStyle;
  const textStyle = engine.textStyle;
  const defaultLineHeightMm = engine.baseLineHeight;
  const paragraphStyleRef = { textStyle, inheritStyle };

  for (let colIdx = 0; colIdx < columnContents.length; colIdx++) {
    const col = columnContents[colIdx];
    if (!col) continue;

    let colLeftMm = 0;
    for (let i = 0; i < colIdx; i++) {
      colLeftMm += (columnWidths[i] ?? 0) + (gaps[i] ?? 0);
    }

    const baseFontSizeMm = engine.fontSize;
    const parentHeightMm = inheritStyle?.parentHeight ?? 0;
    const effectiveColumnHeightMm = parentHeightMm > 0
      ? parentHeightMm + (defaultLineHeightMm - baseFontSizeMm)
      : 0;
    const alignOffsetMm = engine._computeAlignOffsetMm(col, effectiveColumnHeightMm, baseFontSizeMm, parentHeightMm);

    let cumulativeTopMm = 0;
    let hasOverflowed = false;
    for (let li = 0; li < col.length; li++) {
      const lineData: TextLineData | undefined = col[li];
      if (!lineData) continue;

      const lineH = lineData.lineHeight ?? defaultLineHeightMm;
      const lineMaxFs = lineData.maxFontSize ?? baseFontSizeMm;

      if (hasOverflowed) break;
      if (effectiveColumnHeightMm > 0 && cumulativeTopMm + lineH > effectiveColumnHeightMm + 1e-6) {
        hasOverflowed = true;
        break;
      }

      const lineTopMm = alignOffsetMm + cumulativeTopMm;

      let partStartMm = 0;
      for (let pi = 0; pi < lineData.parts.length; pi++) {
        const part = lineData.parts[pi];
        if (!part || part.content.length === 0) {
          if (part) partStartMm += part.left + part.width;
          continue;
        }

        partStartMm += part.left;
        const partAbsLeftMm = partStartMm;

        const { content, charOffsets, inlineStyles, hangs } = part;

        const { stripStart, stripEnd } = computeStripRange(part, lineData, pi);

        for (let j = stripStart; j < stripEnd; j++) {
          const char = content[j];
          if (!char || char.length === 0) continue;
          if (char === RIGHT_INDENT_TAB_CHAR) continue;
          // 공백은 드로잉 생략 — 히트테스트/커서는 엔진 getOffsetFromPoint가
          // 좌표를 소유하므로 명령 목록에 넣지 않는다 (§4.1).
          if (char === ' ') continue;

          const k = j - stripStart;
          const charOffsetMm = charOffsets !== undefined && k < charOffsets.length
            ? (charOffsets[k] ?? 0)
            : 0;

          const inlineStyle = inlineStyles?.[j];
          const { swidth } = engine.getCharWidths(char, inlineStyle);

          chars.push({
            kind: 'char',
            char,
            charOffsetMm,
            lineLeftMm: colLeftMm + partAbsLeftMm,
            lineTopMm,
            widthMm: swidth,
            fontSizeMm: inlineStyle?.fontSize ?? engine.effectiveTextStyle.fontSize!,
            lineMaxFontSizeMm: lineMaxFs,
            runStyle: { inlineStyle, paragraph: paragraphStyleRef },
            hangs: hangs?.[j],
          });
        }
        partStartMm += part.width;
      }

      for (const part of lineData.parts) {
        if (!part || part.content.length === 0) continue;
        for (const deco of part.decorationRects ?? []) {
          decos.push({
            kind: 'deco',
            decoKind: deco.kind,
            xMm: colLeftMm + part.left + deco.x,
            yMm: lineTopMm + deco.y,
            widthMm: deco.width,
            heightMm: deco.height,
            colorName: firstNonEmpty(deco.colorName, ''),
          });
        }
      }

      cumulativeTopMm += lineH;
    }
  }

  return { chars, decos };
}