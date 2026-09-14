/**
 * ParagraphEngine print 데이터 빌더 — 모듈 함수.
 *
 * `buildParagraphPrintPostData`를 `paragraph-engine.ts`에서 본문 그대로
 * 이동한 파일이다. DOM 없이 `columnContents` 기반으로 글자별 위치·폰트·
 * 색상을 mm 좌표로 변환한다. 좌표 공식(charOffsets 소비·strip 규칙·탭
 * 스킵)과 `PrintPostData` 타입 계약은 1바이트도 변경하지 않는다.
 *
 * 소비처:
 * - `paragraph-engine.ts` — `printPostData` 게터 위임 + `export` 재-export
 *   (기존 소비처 import 경로 호환 유지)
 *
 * @file src/engine/paragraph-print.ts
 */

import { DEFAULT_FONT_STYLE } from "@/constants";
import type {
  ParagraphData,
  PrintPostData,
  PrintPostDataChar,
  PrintPostDecoration,
  TextInlineData,
} from "@/types";
import { computeStripRange, firstNonEmpty } from "./paragraph-text-utils";
import type { ParagraphEngine } from "./paragraph-engine";

/**
 * 좌우 밀기 탭 문자 (`\t`).
 *
 * InDesign의 Shift+Tab(좌우 밀기 탭)과 동일한 의미론을 가지는
 * 특수 마커 문자이다. 레이아웃 폭은 항상 **0**이며, `_computeCharOffsets()`
 * 후처리에서 이 문자 이후의 같은 파트 내 텍스트를 파트 오른쪽 끝에
 * 우측 정렬시키는 기준점으로 사용된다.
 *
 * 폭 0 규칙: 모든 폭 계산 경로(`_charWidthMm`, `_layoutColumnsPass`,
 * `_computeCharOffsets`, `getCharWidths`, `genCharStyle`, `genCharStyleFlat`)는
 * 이 문자를 특수 처리하여 0을 반환해야 한다. 폰트 글리프 조회 폴백
 * (`minWidthMm`)이 적용되면 의도치 않은 공백 폭이 생기므로 금지.
 */
const RIGHT_INDENT_TAB_CHAR = "\t";

/**
 * ParagraphEngine의 printPostData를 생성한다.
 * columnContents를 순회하여 글자별 위치·폰트·색상을 픽셀 좌표로 변환한다.
 *
 * @param engine - ParagraphEngine 인스턴스
 * @param ppm - pixels-per-mm
 * @param colorRegistry - 색상 레지스트리 엔진
 * @param fontLoader - 폰트 로더 엔진
 * @param paragraphData - 단락 원본 데이터
 * @param absLeftMm - 단락 절대 X (mm)
 * @param absTopMm - 단락 절대 Y (mm)
 * @param parentWidthMm - 부모 너비 (mm)
 * @param parentHeightMm - 부모 높이 (mm)
 * @returns PrintPostData 배열
 */
export function buildParagraphPrintPostData(
  engine: ParagraphEngine,
  colorRegistry: { get: (name: string) => { c: number; m: number; y: number; k: number } },
  fontLoader: { getFontFamily: (name?: string) => string },
  paragraphData: ParagraphData,
  absLeftMm: number,
  absTopMm: number,
  parentWidthMm: number,
  parentHeightMm: number,
): PrintPostData[] {
  const chars: PrintPostDataChar[] = [];
  const columnContents = engine.columnContents;
  const columnWidths = engine.columnWidths;
  const gaps = engine.gaps;
  const inheritStyle = engine.inheritStyle;
  const textStyle = engine.textStyle;
  const defaultLineHeightMm = engine.baseLineHeight;

  for (let colIdx = 0; colIdx < columnContents.length; colIdx++) {
    const col = columnContents[colIdx];
    if (!col) continue;

    let colLeftMm = absLeftMm;
    for (let i = 0; i < colIdx; i++) {
      colLeftMm += (columnWidths[i] ?? 0) + (gaps[i] ?? 0);
    }

    const baseFontSizeMm = engine.fontSize;
    const effectiveColumnHeightMm = parentHeightMm > 0
      ? parentHeightMm + (defaultLineHeightMm - baseFontSizeMm)
      : 0;

    const columnHeightMm = parentHeightMm;
    const alignOffsetMm = engine._computeAlignOffsetMm(col, effectiveColumnHeightMm, baseFontSizeMm, columnHeightMm);

    let cumulativeTopMm = 0;
    let hasOverflowed = false;
    for (let li = 0; li < col.length; li++) {
      const lineData = col[li];
      if (!lineData) continue;

      const lineH = lineData.lineHeight ?? defaultLineHeightMm;
      const lineMaxFs = lineData.maxFontSize ?? baseFontSizeMm;

      if (hasOverflowed) break;
      if (effectiveColumnHeightMm > 0 && cumulativeTopMm + lineH > effectiveColumnHeightMm + 1e-6) {
        hasOverflowed = true;
        break;
      }

      const lineTopMm = absTopMm + alignOffsetMm + cumulativeTopMm;

      let partStartMm = 0;
      for (let pi = 0; pi < lineData.parts.length; pi++) {
        const part = lineData.parts[pi];
        if (!part || part.content.length === 0) {
          if (part) partStartMm += part.left + part.width;
          continue;
        }

        partStartMm += part.left;
        const partAbsLeftMm = partStartMm;

        const { content, charOffsets, inlineStyles } = part;

        const { stripStart, stripEnd } = computeStripRange(part, lineData, pi);

        for (let j = stripStart; j < stripEnd; j++) {
          const char = content[j];
          if (!char || char.length === 0) continue;
          if (char === RIGHT_INDENT_TAB_CHAR) continue;

          const inlineStyle = inlineStyles?.[j];

          const k = j - stripStart;
          const charOffsetMm = charOffsets !== undefined && k < charOffsets.length
            ? (charOffsets[k] ?? 0)
            : 0;
          const charXMm = colLeftMm + partAbsLeftMm + charOffsetMm;

          const { swidth } = engine.getCharWidths(char, inlineStyle);
          const charWidthMm = swidth;

          const widthRatio = inlineStyle?.widthRatio
            ?? engine.widthRatio;
          const letterSpacing = inlineStyle?.letterSpacing
            ?? engine.effectiveTextStyle.letterSpacing!;
          const spaceRatio = inlineStyle?.spaceRatio
            ?? engine.spaceRatio;

          const charFontFamilyName = inlineStyle?.fontFamily
            ?? textStyle?.fontFamily
            ?? inheritStyle?.fontFamily;
          const charFontFamily = charFontFamilyName !== undefined
            ? fontLoader.getFontFamily(charFontFamilyName)
            : fontLoader.getFontFamily();
          const charFontSize = inlineStyle?.fontSize
            ?? engine.effectiveTextStyle.fontSize!;
          const charFontWeight = inlineStyle?.fontWeight
            ?? textStyle?.fontWeight
            ?? inheritStyle?.fontWeight
            ?? 400;
          const charFontStyle = inlineStyle?.fontStyle
            ?? textStyle?.fontStyle
            ?? inheritStyle?.fontStyle
            ?? DEFAULT_FONT_STYLE;
          const colorName = firstNonEmpty(
            inlineStyle?.color,
            textStyle?.color,
            inheritStyle?.color,
          );
          const cmyk = colorName !== ''
            ? colorRegistry.get(colorName)
            : { c: 0, m: 0, y: 0, k: 255 };

          const outlineEm = inlineStyle?.outline
            ?? textStyle?.outline
            ?? inheritStyle?.outline
            ?? 0;
          const outlineColorName = firstNonEmpty(
            inlineStyle?.outlineColor,
            textStyle?.outlineColor,
            inheritStyle?.outlineColor,
            colorName,
          );
          const outlineCmyk = outlineColorName !== ''
            ? colorRegistry.get(outlineColorName)
            : { c: 0, m: 0, y: 0, k: 255 };

          chars.push({
            char,
            rect: {
              x: charXMm,
              y: lineTopMm + engine._getCharVerticalOffset(lineMaxFs, charFontSize),
              width: charWidthMm,
              height: charFontSize,
            },
            fontFamily: charFontFamily,
            fontSize: charFontSize,
            fontWeight: charFontWeight,
            fontStyle: charFontStyle,
            widthRatio,
            letterSpacing,
            spaceRatio,
            color: cmyk,
            outline: outlineEm * charFontSize,
            outlineColor: outlineCmyk,
          });
        }
        partStartMm += part.width;
      }

      cumulativeTopMm += lineH;
    }
  }

  const decorations: PrintPostDecoration[] = [];
  for (let colIdx = 0; colIdx < columnContents.length; colIdx++) {
    const col = columnContents[colIdx];
    if (!col) continue;

    let colLeftMm = absLeftMm;
    for (let i = 0; i < colIdx; i++) {
      colLeftMm += (columnWidths[i] ?? 0) + (gaps[i] ?? 0);
    }

    const baseFontSizeMm2 = engine.fontSize;
    const effectiveColumnHeightMm2 = parentHeightMm > 0
      ? parentHeightMm + (defaultLineHeightMm - baseFontSizeMm2)
      : 0;
    const alignOffsetMm2 = engine._computeAlignOffsetMm(col, effectiveColumnHeightMm2, baseFontSizeMm2, parentHeightMm);

    let cumulativeTopMm = 0;
    for (const lineData of col) {
      if (!lineData) continue;
      const lineH = lineData.lineHeight ?? defaultLineHeightMm;
      for (const part of lineData.parts) {
        if (!part || part.content.length === 0) continue;
        for (const deco of part.decorationRects ?? []) {
          const decoCmyk = deco.colorName !== ''
            ? colorRegistry.get(deco.colorName)
            : { c: 0, m: 0, y: 0, k: 255 };
          decorations.push({
            kind: deco.kind,
            x: colLeftMm + part.left + deco.x,
            y: absTopMm + alignOffsetMm2 + cumulativeTopMm + deco.y,
            width: deco.width,
            height: deco.height,
            color: decoCmyk,
          });
        }
      }
      cumulativeTopMm += lineH;
    }
  }

  return [{
    data: paragraphData,
    rect: {
      x: absLeftMm,
      y: absTopMm,
      width: parentWidthMm,
      height: parentHeightMm,
    },
    chars,
    decorations,
  }];
}

/**
 * inline 콘텐츠를 plain 오프셋 범위로 슬라이싱한다 (런 경계 보존).
 *
 * 스레딩 feed-forward가 tail을 잘라 다음 프레임에 전달할 때 사용한다.
 * plain 오프셋은 `\n`을 포함한 편집 공간(plainText getter와 동일) 기준이다.
 * 런의 절반 지점 분할은 스타일이 동일한 문자열 런 내부에서만 발생하므로
 * 배치 결과에 영향이 없다.
 *
 * @param content - 원본 콘텐츠 (string 또는 인라인 런 배열)
 * @param start - 시작 plain 오프셋 (포함)
 * @param end - 끝 plain 오프셋 (제외)
 * @returns 슬라이스된 콘텐츠 배열. 빈 범위면 빈 배열.
 * @throws 없음
 */
export function sliceInlineContent(
  content: string | (string | TextInlineData)[] | undefined,
  start: number,
  end: number,
): (string | TextInlineData)[] {
  if (content === undefined) return [];
  const raw: (string | TextInlineData)[] = typeof content === 'string'
    ? [content]
    : content;
  const result: (string | TextInlineData)[] = [];
  let offset = 0;
  for (const item of raw) {
    if (offset >= end) break;
    const text = typeof item === 'string' ? item : item.content;
    const itemEnd = offset + text.length;
    if (itemEnd <= start) {
      offset += text.length;
      continue;
    }
    const sliceStart = Math.max(0, start - offset);
    const sliceEnd = Math.min(text.length, end - offset);
    const slice = text.slice(sliceStart, sliceEnd);
    if (slice.length > 0) {
      if (typeof item === 'string' || item.textInlineStyle === undefined) {
        result.push(slice);
      } else {
        result.push({ content: slice, textInlineStyle: item.textInlineStyle });
      }
    }
    offset += text.length;
  }
  return result;
}