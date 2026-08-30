/**
 * Node.js 호환 문단 레이아웃/텍스트 래핑 엔진.
 *
 * 기존 `TextLayoutEngine`에서 DOM 의존성을 제거한 순수 계산 버전.
 * - `LayoutParagraphElement` 참조 대신 `ParagraphEngineData` 순수 데이터
 * - `FontLoader.getInstance()` 대신 주입된 `FontLoaderEngine`
 * - `getOverlapSizeMm()` 대신 `./overlap-engine`의 `computeOverlapSizeMm()`
 * - `GridCalculator.ppm` 대신 `EngineResources.ppm`
 *
 * @file src/engine/paragraph-engine.ts
 */

import {
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_STYLE,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_INDENT,
  DEFAULT_LETTER_SPACING,
  DEFAULT_LINE_GAP,
  DEFAULT_SPACE_RATIO,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_VERTICAL_ALIGN,
  DEFAULT_WIDTH_RATIO,
  isLineEndForbidden,
  isLineStartForbidden,
} from "@/constants";
import {
  InheritStyle,
  TextInlineData,
  TextInlineStyle,
  ParagraphStyle,
  TextStyle,
  TextPartData,
  TextLineData,
  OverlapParts,
  ParagraphData,
  PrintPostData,
  PrintPostDataChar,
} from "@/types";
import type { BoxEngine } from "./box-engine";
import {
  AbsRect,
  CursorPlacement,
  CursorPosition,
  EngineResources,
  ImageEngineRef,
  MmRect,
  OverlapMode,
  ParagraphOverlapMode,
  createDirtyError,
  createNoParentError,
} from "./types";
import { computeOverlapSizeMm, mergeOverlapParts } from "./overlap-engine";
import type { ImageEngine } from "./image-engine";

const DEFAULT_PARAGRAPH_STYLE: Required<ParagraphStyle> = {
  lineGap: DEFAULT_LINE_GAP,
  verticalAlign: DEFAULT_VERTICAL_ALIGN,
  textAlign: DEFAULT_TEXT_ALIGN,
};

const DEFAULT_TEXT_STYLE: Required<TextStyle> = {
  color: '',
  fontFamily: '',
  fontWeight: DEFAULT_FONT_WEIGHT,
  fontStyle: DEFAULT_FONT_STYLE,
  fontSize: DEFAULT_FONT_SIZE,
  letterSpacing: DEFAULT_LETTER_SPACING,
  widthRatio: DEFAULT_WIDTH_RATIO,
  spaceRatio: DEFAULT_SPACE_RATIO,
  indent: DEFAULT_INDENT,
};

/** 엔진 생성 옵션. */
export interface ParagraphEngineData {
  id?: string;
  zIndex?: number;
  content: string | (string | TextInlineData)[];
  column: number | number[];
  gap: number | number[];
  paragraphStyle: ParagraphStyle;
  textStyle: TextStyle;
  inheritStyle: InheritStyle;
  overlayEngines: BoxEngine[];
  parentAbsRect: AbsRect;
  resources: EngineResources;
  parentBox?: BoxEngine;
}

type FreeRegion = { start: number; end: number };

/**
 * 텍스트 래핑과 다중 컬럼 렌더링을 수행하는 엔진.
 *
 * `ParagraphEngineData`를 받아 텍스트를 래핑하여 `TextLineData[][]`(컬럼별 줄 데이터)로 변환한다.
 * 정적 팩토리 메서드 `create()`로만 인스턴스를 생성한다.
 *
 * 주요 기능:
 * - 텍스트 래핑 (`layoutStructure()` + `layoutText()`): 문자 단위로 줄바꿈 처리
 * - 오버랩 회피: 이미지 등 다른 요소와 겹치는 영역 계산
 * - 스타일 적용: `genLineStyle()`, `genPartStyle()`, `genCharStyle()`으로 CSS 스타일 생성
 * - 엔진 쿼리 API: `getCharRect()`, `getOffsetFromPoint()`, `getCursorPlacement()`
 *
 * 렌더링 파이프라인:
 * 1. `_initLayoutMetrics()` - fontSize, lineGap, lineHeight 초기화
 * 2. `layoutStructure()` - 컬럼 폭/ppm 계산, `layoutText()` - 텍스트 래핑 수행
 */
export class ParagraphEngine {
  private _id: string | undefined;
  private _zIndex: number | undefined;
  private _columnWidths: number[] = [];
  private _inheritStyle: InheritStyle = undefined!;

  private _textContent: string | (string | TextInlineData)[] = "";

  private _textStyle: TextStyle = {};
  private _paragraphStyle: ParagraphStyle = {};

  private _columnContents: TextLineData[][] = [];
  /** `\n`으로 분리된 라인 원본. 각 라인은 인라인 런 배열이다. */
  private _contents: TextInlineData[][] = [];
  private _gaps: number[] = [];
  private _overflow: number = 0;

  /**
   * 컬럼별 누적 왼쪽 오프셋 (mm). `_columnWidths` + `_gaps`의 prefix sum.
   * `_layoutColumnsPass` 시작 시 1회 계산, `_createLineWithParts`에서 O(1) 조회.
   */
  private _columnLeftOffsets: number[] = [];

  private _previousLineCount: number = -1;
  private _previousOverflow: number = -1;

  /**
   * `preserveRenderShapeAcrossReset()`가 예약한 렌더 형태 보존 요청 (1회성).
   * `resetIncrementalState()`가 소비 후 null로 돌아간다.
   */
  private _renderShapePreserved: { lineCount: number; overflow: number } | null = null;

  /** 성능 캐시: 문자별 외부 span 스타일. 키 `${char}|${widthRatio}|${letterSpacing}|${spaceRatio}|${fontSize}`. LRU (5000). */
  private _charOuterStyleCache: _LRU<string, Partial<CSSStyleDeclaration>> = new _LRU(5000);
  /** 성능 캐시: 내부 span 스타일. 장평 변경 시 갱신. */
  private _charInnerStyle: Partial<CSSStyleDeclaration> = {};
  private _charInnerStyleKey: string = "";
  /** 성능 캐시: 문자 폭(mm). 키 `${char}|${fontName}|${fontSize}`. LRU (5000). */
  private _charWidthCache: _LRU<string, number> = new _LRU(5000);
  /**
   * 2단 글자 폭 캐시: 폰트/크기 조합 → (문자 → 폭 mm).
   * 핫 루프에서 매 글자마다 `${char}|${fontName}|${fontSize}` 키 생성을 제거하기 위해
   * 조합 키는 런/파트당 1회만 생성하고, 글자 조회는 단일 문자 키로 수행.
   */
  private _charWidthByFontCache: Map<string, Map<string, number>> = new Map();

  private _lineHeight: number = 0;

  private _data: ParagraphEngineData;
  private _resources: EngineResources;

  private _overlapMode: ParagraphOverlapMode = "box";

  /** 성능 캐시: 오버랩 요소의 mm rect 캐시. 렌더링 사이클마다 한 번 구성 후 재사용한다. */
  private _overlayRectsMm: Map<BoxEngine, MmRect> | null = null;

  /** Skeleton 캐시: 입력 매개변수 해시가 동일하면 _layoutTextIntoColumns() 결과를 재사용. */
  private _layoutCache: { hash: string; columnContents: TextLineData[][]; overflow: number } | null = null;

  /**
   * `_parseContents()` 결과 캐시. `textContent` 참조가 동일하면 편집(블록/런 분해)을 생략.
   * `data` setter / `textContent` setter에서 무효화.
   */
  private _parsedContentsCache: { textContent: string | (string | TextInlineData)[]; contents: TextInlineData[][] } | null = null;

  /**
   * Prefix 캐시: 캐럿 이전 컬럼들의 배치 결과를 재사용. 연속 타이핑 시 재배치 비용을
   * 캐럿 이후 길이에 비례하도록 단축. `textContent` setter에서 무효화하지 않음 —
   * 해시가 정확성을 보장. `data` setter에서만 무효화.
   */
  private _prefixCache: {
    caretOffset: number;
    hash: string;
    columnContents: TextLineData[][];
    startColumnIdx: number;
    startBlockIdx: number;
    startRunIdx: number;
    startCharIdx: number;
  } | null = null;

  /** `_layoutCache` 존재 여부 (외부 스킵 판정용). */
  get hasLayoutCache(): boolean { return this._layoutCache !== null; }

  /**
   * 개별 setter(textContent 등)로 인한 미커밋 변경 존재 여부.
   * 동기 이벤트 구독자가 extractData를 읽기 전에 커밋(render/layoutText)이
   * 선행했는지 판정하는 용도로만 사용한다.
   *
   * @returns `_dirty`가 true면 true
   * @throws 없음
   * @example
   * ```ts
   * engine.textContent = "변경";     // _dirty = true
   * engine.hasPendingChanges;        // → true
   * engine.layoutText();             // 커밋
   * engine.hasPendingChanges;        // → false
   * ```
   */
  public get hasPendingChanges(): boolean { return this._dirty; }

  /** 성능 캐시: effectiveParagraphStyle. _paragraphStyle/_inheritStyle 변경 시 무효화. */
  private _effectivePsCache: ParagraphStyle | null = null;
  private _effectivePsDirty: boolean = true;
  /** 성능 캐시: effectiveTextStyle. _textStyle/_inheritStyle 변경 시 무효화. */
  private _effectiveTsCache: TextStyle | null = null;
  private _effectiveTsDirty: boolean = true;

  private _dirty: boolean = false;

  private _caretHint: number | undefined = undefined;

  /** 성능 캐시: plainText getter 결과. textContent/data setter에서 무효화. */
  private _plainTextCache: string | null = null;

  /**
   * 소스 런 스타일 인덱스. `_textContent`의 각 아이템을 평문 오프셋 공간(`\n` 포함,
   * textarea/RunMap과 동일)의 연속된 런으로 펼친 배열. 지연 구축, `textContent`/`data`
   * setter에서 무효화. `layoutText()`와 무관 (레이아웃 전에도 조회 가능).
   */
  private _styleRuns: readonly { start: number; end: number; style: TextInlineStyle | undefined }[] | null = null;

  /**
   * 캐시된 평문 텍스트. `textContent`가 배열(인라인 런)이면 런 content를 이어붙인
   * 평문을 반환하고, 문자열이면 그대로 반환한다. 편집 전용 오프셋 판정(`\n` 스킵,
   * 라인 끝 검사, 커서 매핑)은 반드시 이 getter를 사용해야 한다 — `textContent`는
   * 배열일 수 있어 문자열 인덱싱(`textContent[i] === '\n'`)이 항상 실패한다.
   *
   * @returns `textContent`의 평문 문자열
   * @throws 없음 (빈 콘텐츠면 빈 문자열 반환)
   * @example
   * ```ts
   * // textContent가 배열인 경우
   * // ["ab", { content: "굵게", textInlineStyle: {...} }]
   * engine.plainText; // → "ab굵게"
   * ```
   */
  public get plainText(): string {
    if (this._plainTextCache !== null) return this._plainTextCache;
    const tc = this._textContent;
    if (typeof tc === "string") {
      this._plainTextCache = tc;
      return tc;
    }
    let result = "";
    for (const item of tc) {
      result += typeof item === "string" ? item : item.content;
    }
    this._plainTextCache = result;
    return result;
  }

  /**
   * 정적 팩토리 메서드. `new` 직접 사용 금지.
   *
   * @param data - 문단 엔진 데이터
   * @returns ParagraphEngine 인스턴스
   */
  public static create(data: ParagraphEngineData): ParagraphEngine {
    return new this(data);
  }

  /**
   * 부모 없이 단락 엔진을 생성한다 (고아 엔진).
   *
   * `content`와 `resources`만으로 생성하며, 부모 관련 필드(parentBox, parentAbsRect, inheritStyle)는 더미 값으로 초기화된다.
   * `appendChildContentEngine()`으로 부모 박스에 연결 후 `data` setter로 실제 데이터를 주입해야 한다.
   *
   * @param content - 텍스트 콘텐츠
   * @param resources - 엔진 리소스 (fontLoader, colorRegistry)
   * @returns 부모가 없는 ParagraphEngine 인스턴스
   */
  public static createOrphan(content: string | (string | TextInlineData)[], resources: EngineResources): ParagraphEngine {
    const orphanData: ParagraphEngineData = {
      content,
      column: 1,
      gap: 0,
      paragraphStyle: {},
      textStyle: {},
      inheritStyle: { parentWidth: 0, parentHeight: 0 },
      overlayEngines: [],
      parentAbsRect: { absLeft: 0, absTop: 0, absWidth: 0, absHeight: 0 },
      resources,
    };
    return new this(orphanData);
  }

  private constructor(data: ParagraphEngineData) {
    this._resources = data.resources;
    this._data = data;
    this.data = data;
  }

  /**
   * 레이아웃 메트릭 초기화. `fontSize`, `lineGap`, `lineHeight`를 계산하고
   * `_columnContents`와 `_overflow`를 리셋한다.
   * `data` 세터와 `inheritStyle` 세터에서 호출된다.
   */
  private _initLayoutMetrics(): void {
    const fontSize = this.effectiveTextStyle.fontSize!;
    const lineGap = this.effectiveParagraphStyle.lineGap!;

    this._columnContents = [];
    this._overflow = 0;

    this._lineHeight = fontSize * lineGap;
  }

  /**
   * 오버랩 영역의 여집합으로부터 텍스트가 배치될 수 있는 자유 영역을 계산한다.
   * 오버랩이 없으면 `[{ start: 0, end: lineWidth }]`를 반환한다.
   *
   * @param lineWidth - 라인 너비 (mm)
   * @param overlapParts - 오버랩 구간 배열
   * @returns 자유 영역 배열
   */
  private _computeFreeRegions(lineWidth: number, overlapParts: OverlapParts[]): FreeRegion[] {
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
   * 문자의 레이아웃 폭을 mm 단위로 측정한다.
   *
   * 폰트 메트릭 테이블에서 직접 `glyph.advanceWidth / unitsPerEm * fontSize`로
   * 계산하므로 ppm 변환을 거치지 않아 환경에 완전히 무관하다.
   * `Math.round()`를 사용하지 않아 부동소수점 정밀도를 보존한다.
   *
   * **장평(`widthRatio`) 처리**: 호출자가 `rawWidth × widthRatio`로 장평을 반영한다.
   *
   * **최소 폭(`minWidthMm`)**: 결함 글리프 방어. `spaceRatio × fontSize`를 바닥값으로 사용한다.
   *
   * @param char - 측정할 문자
   * @param inlineStyle - 인라인 스타일 오버라이드
   * @returns 문자 폭 (mm, 장평 미적용)
   */
  private _charWidthMm(char: string, inlineStyle?: TextInlineStyle): number {
    const fontSize = inlineStyle?.fontSize ?? this.effectiveTextStyle.fontSize!;
    const minWidthMm = this.spaceRatio * fontSize;

    if (char === " ") {
      return minWidthMm;
    }

    const fontName = inlineStyle?.fontFamily ?? "";
    const cacheKey = `${char}|${fontName}|${fontSize}`;
    const cached = this._charWidthCache.get(cacheKey);
    if (cached !== undefined) {
      return Math.max(cached, minWidthMm);
    }

    const fontWidth = this._charWidthMmFromFont(char, inlineStyle, fontSize);
    if (fontWidth !== null) {
      this._charWidthCache.set(cacheKey, fontWidth);
      return Math.max(fontWidth, minWidthMm);
    }

    return minWidthMm;
  }

  /**
   * 폰트 메트릭 기반 문자 폭 측정.
   *
   * `FontLoaderEngine`에서 파싱된 폰트 객체에서 `charToGlyph(char)`로
   * 글리프를 조회하고, `glyph.advanceWidth / unitsPerEm * fontSize`로 mm 폭을 계산한다.
   * **장평(`widthRatio`) 곱셈은 호출자에서 적용**한다.
   *
   * @param char - 측정할 문자
   * @param inlineStyle - 인라인 스타일 오버라이드
   * @param fontSize - 폰트 크기 (mm 단위)
   * @returns 문자 폭 (mm, 장평 미적용). 폰트/글리프 조회 실패 시 `null`
   */
  private _charWidthMmFromFont(char: string, inlineStyle: TextInlineStyle | undefined, fontSize: number): number | null {
    const fontLoader = this._resources.fontLoader;
    const fontName = inlineStyle?.fontFamily;
    const parsedFont = fontLoader.getParsedFont(fontName);
    if (!parsedFont) return null;

    const glyph = parsedFont.charToGlyph(char);
    if (!glyph || glyph.advanceWidth === undefined || glyph.advanceWidth === null) {
      return null;
    }

    return (glyph.advanceWidth / parsedFont.unitsPerEm) * fontSize;
  }

  /** 마지막 줄의 모든 파트가 비어 있으면 해당 줄을 제거한다. */
  private _removeTrailingEmptyLine(columnContent: TextLineData[]): TextLineData[] {
    if (columnContent.length > 0 && columnContent[columnContent.length - 1].parts.every((p) => p.content.length === 0)) {
      return columnContent.slice(0, columnContent.length - 1);
    }
    return columnContent;
  }

  /**
   * 한글 조판 금칙문자 규칙을 적용한다.
   *
   * `_layoutTextIntoColumns()`가 글자를 폭 기준으로 배치한 뒤 호출되는
   * 후처리 패스이다. 인접한 두 줄(같은 컬럼 내)의 경계에서 발생한
   * 행두/행말 금칙 위반을 교정한다.
   *
   * @returns 반환값 없음. `_columnContents`를 제자리에서 변형한다.
   */
  private _applyLineBreakRules(): void {
    for (let col = 0; col < this._columnContents.length; col++) {
      const columnContent = this._columnContents[col];
      for (let i = 0; i < columnContent.length - 1; i++) {
        const curLine = columnContent[i];
        const nextLine = columnContent[i + 1];

        if (curLine.parts.length === 0) continue;
        if (nextLine.parts.length === 0) continue;

        const curLastPart = curLine.parts[curLine.parts.length - 1];
        const nextFirstPart = nextLine.parts[0];
        if (curLastPart.content.length === 0 || nextFirstPart.content.length === 0) continue;

        const curLastChar = curLastPart.content[curLastPart.content.length - 1];
        const nextFirstChar = nextFirstPart.content[0];

        if (isLineStartForbidden(nextFirstChar)) {
          if (!isLineEndForbidden(curLastChar)) {
            const movedStyle = nextFirstPart.inlineStyles?.shift();
            curLastPart.content.push(nextFirstChar);
            if (curLastPart.inlineStyles) curLastPart.inlineStyles.push(movedStyle);
            else if (movedStyle !== undefined) {
              curLastPart.inlineStyles = new Array(curLastPart.content.length - 1).fill(undefined);
              curLastPart.inlineStyles.push(movedStyle);
            }
            nextFirstPart.content.shift();
          }
          continue;
        }

        if (isLineEndForbidden(curLastChar)) {
          if (!isLineStartForbidden(nextFirstChar)) {
            const movedStyle = curLastPart.inlineStyles?.pop();
            nextFirstPart.content.unshift(curLastChar);
            if (nextFirstPart.inlineStyles) nextFirstPart.inlineStyles.unshift(movedStyle);
            else if (movedStyle !== undefined) {
              nextFirstPart.inlineStyles = new Array(nextFirstPart.content.length).fill(undefined);
              nextFirstPart.inlineStyles[0] = movedStyle;
            }
            curLastPart.content.pop();
          }
        }
      }
    }
  }

  /**
   * 각 파트의 글자별 x 오프셋(mm)을 `textAlign`에 따라 산출한다.
   *
   * `_layoutTextIntoColumns()`와 `_applyLineBreakRules()` 이후에 호출되어
   * `TextPartData.charOffsets`를 채운다.
   */
  private _computeCharOffsets(): void {
    const defaultTextAlign = this.effectiveParagraphStyle.textAlign!;
    const effTextStyle = this.effectiveTextStyle;
    const baseFontSizeMm = effTextStyle.fontSize!;
    const wr = this.widthRatio;
    const effSpaceRatio = this.spaceRatio;
    const letterSpacingEm = effTextStyle.letterSpacing!;
    const charWidthCache = this._charWidthCache;
    const charWidthByFont = this._charWidthByFontCache;

    for (let c = 0; c < this._columnContents.length; c++) {
      const columnContent = this._columnContents[c];
      if (!columnContent) continue;

      for (let li = 0; li < columnContent.length; li++) {
        const line = columnContent[li];
        if (!line || line.parts.length === 0) continue;

        const textAlign = defaultTextAlign;
        const isLastLineOfBlock = line.endOfBlock === true;
        const partCount = line.parts.length;

        for (let p = 0; p < partCount; p++) {
          const part = line.parts[p];
          if (!part) continue;
          const content = part.content;
          if (content.length === 0) {
            part.charOffsets = [];
            continue;
          }

          const { stripStart, stripEnd } = this._computeStripRange(part, line, p);
          const strippedCount = stripEnd - stripStart;
          if (strippedCount === 0) {
            part.charOffsets = [];
            continue;
          }

          const partWidth = part.width;

          const charWidths: number[] = new Array(strippedCount);
          let totalWidth = 0;
          let prevFontKey = "";
          let prevFontMap: Map<string, number> | null = null;
          for (let i = 0; i < strippedCount; i++) {
            const ch = content[stripStart + i]!;
            const inlineStyle = part.inlineStyles?.[stripStart + i];
            // getCharWidths 인라인: 객체 할당/중복 getter 제거, 2단 캐시 직조회
            const fontSize = inlineStyle?.fontSize ?? baseFontSizeMm;
            const lsMm = letterSpacingEm * fontSize;
            const minWidthMm = effSpaceRatio * fontSize;
            let rawWidth: number;
            if (ch === " ") {
              rawWidth = minWidthMm;
            } else {
              const fontKey = (inlineStyle?.fontFamily ?? "") + "|" + fontSize;
              if (fontKey !== prevFontKey || prevFontMap === null) {
                prevFontMap = charWidthByFont.get(fontKey) ?? null;
                if (prevFontMap === null) {
                  prevFontMap = new Map();
                  charWidthByFont.set(fontKey, prevFontMap);
                }
                prevFontKey = fontKey;
              }
              let cached = prevFontMap.get(ch);
              if (cached === undefined) {
                const fontWidth = this._charWidthMmFromFont(ch, inlineStyle, fontSize);
                if (fontWidth !== null) {
                  prevFontMap.set(ch, fontWidth);
                  charWidthCache.set(ch + "|" + fontKey, fontWidth);
                  cached = fontWidth;
                } else {
                  cached = 0;
                }
              }
              rawWidth = cached > minWidthMm ? cached : minWidthMm;
            }
            const swidth = rawWidth * wr + lsMm;
            charWidths[i] = swidth;
            totalWidth += swidth;
          }

          const offsets = new Array<number>(strippedCount);
          const remaining = Math.max(0, partWidth - totalWidth);

          let align: "left" | "right" | "center" | "justify";
          if (textAlign === "center") align = "center";
          else if (textAlign === "right") align = "right";
          else if (textAlign === "justify") align = isLastLineOfBlock || strippedCount === 1 ? "left" : "justify";
          else align = "left";

          let cursor = 0;
          if (align === "left") {
            for (let i = 0; i < strippedCount; i++) {
              offsets[i] = cursor;
              cursor += charWidths[i]!;
            }
          } else if (align === "right") {
            cursor = remaining;
            for (let i = 0; i < strippedCount; i++) {
              offsets[i] = cursor;
              cursor += charWidths[i]!;
            }
          } else if (align === "center") {
            cursor = remaining / 2;
            for (let i = 0; i < strippedCount; i++) {
              offsets[i] = cursor;
              cursor += charWidths[i]!;
            }
          } else {
            const gap = strippedCount > 1 ? remaining / (strippedCount - 1) : 0;
            for (let i = 0; i < strippedCount; i++) {
              offsets[i] = cursor;
              cursor += charWidths[i]! + gap;
            }
          }

          part.charOffsets = offsets;
        }
      }
    }
  }

  /**
   * 오버랩 요소(이미지 등)와의 겹침 계산.
   * 성능 최적화: `_overlayRectsMm` 캐시를 사용하여 렌더링 사이클마다
   * 오버랩 요소의 mm rect를 한 번 구성 후 재사용한다.
   * COVER면 라인 전체가 덮인 것이고, PART면 일부만 덮인 것이다.
   *
   * @param lineRectMm - 라인 사각형 (mm)
   * @returns cover 여부와 오버랩 구간 배열
   */
  private _detectOverlapWithCache(lineRectMm: MmRect): { cover: boolean; overlapParts: OverlapParts[] } {
    const overlapEls = this._data.overlayEngines;
    let cover = false;
    let parts: OverlapParts[] = [];

    if (this._overlayRectsMm === null) {
      this._overlayRectsMm = new Map();
      for (const el of overlapEls) {
        const rect = el.absRect;
        this._overlayRectsMm.set(el, {
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
      const elRect = this._overlayRectsMm.get(el);
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

    return { cover, overlapParts: mergeOverlapParts(parts) };
  }

  /**
   * 라인의 mm 좌표를 계산하고 오버랩을 감지하여 파트를 구성한다.
   *
   * DOM은 생성하지 않는다. 모든 측정값과 산술은 **mm 단위**로 수행된다.
   *
   * @param columnIndex - 현재 컬럼 인덱스 (`_columnWidths` 조회용)
   * @param lineIndexInColumn - 컬럼 내에서 이 라인의 0-based 인덱스
   * @param isFirstInColumn - 첫 번째 라인 여부 (firstOfText 플래그 설정용)
   * @param isFirstOfBlock - `\n` 직후 첫 라인 여부 (firstOfBlock 플래그 + 들여쓰기용)
   * @returns cover=true면 라인 전체가 덮임, overflow=true면 컬럼 높이 초과
   */
  private _createLineWithParts(
    columnIndex: number,
    lineIndexInColumn: number,
    isFirstInColumn: boolean,
    isFirstOfBlock: boolean,
    alignOffsetMm: number,
  ): {
    cover: boolean;
    overflow: boolean;
    partWidths: number[];
    lineData: TextLineData;
  } {
    const columnLeftMm = this._columnLeftOffsets[columnIndex] ?? 0;
    const lineLeftMm = this._data.parentAbsRect.absLeft + columnLeftMm;
    const lineTopMm = this._data.parentAbsRect.absTop + alignOffsetMm + lineIndexInColumn * this._lineHeight;
    const lineWidthMm = this._columnWidths[columnIndex];
    const lineHeightMm = this._lineHeight;

    const lineRectMm: MmRect = {
      left: lineLeftMm,
      right: lineLeftMm + lineWidthMm,
      top: lineTopMm,
      bottom: lineTopMm + lineHeightMm,
      width: lineWidthMm,
      height: lineHeightMm,
    };

    const { cover, overlapParts } = this._detectOverlapWithCache(lineRectMm);

    const parentHeight = this._inheritStyle?.parentHeight ?? 0;
    // 마지막 라인은 lineHeight가 아닌 fontSize만큼만 높이를 차지하므로,
    // 컬럼 수용력은 parentHeight + (lineHeight - fontSize)와 같다.
    // (BoxEngine.absHeight = lineHeight * height - (lineHeight - fontSize))
    const effectiveColumnHeight = parentHeight + (this._lineHeight - this.fontSize);
    const isOverflow = (lineIndexInColumn + 1) * this._lineHeight > effectiveColumnHeight + 1e-6;

    if (cover) {
      const lineData: TextLineData = {
        firstOfText: isFirstInColumn,
        firstOfBlock: isFirstOfBlock,
        parts: [],
      };
      return { cover: true, overflow: isOverflow, partWidths: [], lineData };
    }

    const freeRegions = this._computeFreeRegions(lineWidthMm, overlapParts);

    const fontSize = this.effectiveTextStyle.fontSize!;
    const indentMm = isFirstOfBlock ? fontSize * this.indent : 0;
    const adjustedFreeRegions =
      indentMm > 0 ? freeRegions.map((r, i) => (i === 0 ? { start: r.start + indentMm, end: r.end } : r)) : freeRegions;

    const letterSpacingEm = this.effectiveTextStyle.letterSpacing!;
    const minCharWidthMm = this.widthRatio * fontSize + letterSpacingEm * fontSize;
    const usableRegions = adjustedFreeRegions.filter((r) => r.end - r.start >= minCharWidthMm);

    if (usableRegions.length === 0) {
      const lineData: TextLineData = {
        firstOfText: isFirstInColumn,
        firstOfBlock: isFirstOfBlock,
        parts: [],
      };
      return { cover: true, overflow: isOverflow, partWidths: [], lineData };
    }

    const parts: TextPartData[] = usableRegions.map((region, i) => ({
      content: [],
      left: i === 0 ? region.start : region.start - usableRegions[i - 1].end,
      width: region.end - region.start,
    }));

    const partWidths = usableRegions.map((r) => r.end - r.start);

    const lineData: TextLineData = {
      firstOfText: isFirstInColumn,
      firstOfBlock: isFirstOfBlock,
      parts,
    };

    return { cover: false, overflow: isOverflow, partWidths, lineData };
  }

  /**
   * 구조 측정. `_columnWidths`, `_gaps`, `_lineHeight`는 `data` 세터에서
   * 이미 초기화되어 있으므로 여기서는 컬럼 수 검사만 수행한다.
   * 내부 전용. `layoutStructure()`에서만 호출된다.
   */
  private _initStructureAndMeasureColumns(): void {
    if (this.columnCount < 1) return;
  }

  /**
   * `textContent`를 `_contents`(라인 × 런)로 파싱한다.
   * `layoutText()` 호출 시 `textContent`가 변경되었을 수 있으므로
   * 매번 다시 파싱하여 최신 텍스트를 반영한다.
   *
   * 콘텐츠는 하나의 연속 텍스트 흐름이다. 런(`TextInlineData`) 경계는
   * 라인 경계와 무관하므로, 먼저 전체 흐름을 (런 누적, 문자) 시퀀스로
   * 펼친 뒤 `\n` 기준으로 라인을 분리한다. 런이 `\n`을 가로지르면
   * 양쪽 라인으로 분할된다.
   */
  private _parseContents(): void {
    if (this._parsedContentsCache !== null && this._parsedContentsCache.textContent === this._textContent) {
      this._contents = this._parsedContentsCache.contents;
      return;
    }

    const rawContents = !Array.isArray(this._textContent) ? [{ content: this._textContent }] : this._textContent;

    this._contents = [];
    let curLine: TextInlineData[] = [];
    let curRun: TextInlineData | null = null;
    let lastCh = "";

    for (const c of rawContents) {
      const style = typeof c === "string" ? undefined : c.textInlineStyle;
      const content = typeof c === "string" ? c : c.content;
      for (const ch of content) {
        lastCh = ch;
        if (ch === "\n") {
          this._contents.push(curLine);
          curLine = [];
          curRun = null;
          continue;
        }
        const prev = curLine[curLine.length - 1];
        if (curRun !== null && prev === curRun && inlineStyleEqual(prev.textInlineStyle, style)) {
          prev.content += ch;
        } else {
          curRun = { content: ch, textInlineStyle: style };
          curLine.push(curRun);
        }
      }
    }
    // 텍스트가 \n으로 끝나면 마지막 빈 블록도 push한다 — 문단 끝에서 엔터를
    // 입력하면 커서가 배치될 빈 라인이 엔진에 존재해야 한다. length 체크만
    // 하면 trailing \n의 빈 블록이 사라져 매핑이 없고, 커서가 이전 라인의
    // 맨 앞으로 폴백한다. (\n 직전 push에는 length 체크가 없으므로 중간
    // 연속 개행은 이미 빈 블록을 유지한다 — 여기만 맞추면 일관된다.)
    if (curLine.length > 0 || lastCh === "\n") this._contents.push(curLine);

    this._parsedContentsCache = { textContent: this._textContent, contents: this._contents };
  }

  /**
   * 문자 단위 줄바꿈 렌더링을 실행한다. `layoutStructure()`가 먼저 호출되어
   * 구조 데이터가 준비되어 있어야 한다.
   * 내부 전용. `layoutText()`에서만 호출된다.
   */
  private _layoutTextIntoColumns(): void {
    if (this.columnCount < 1) return;

    const inputHash = this._computeLayoutInputHash();
    if (this._layoutCache && this._layoutCache.hash === inputHash) {
      this._columnContents = this._layoutCache.columnContents;
      this._overflow = this._layoutCache.overflow;
      this._overlayRectsMm = null;
      this._refreshInlineStylesOnly();
      this._caretHint = undefined;
      return;
    }

    const verticalAlign = this.effectiveParagraphStyle.verticalAlign!;
    const caretOffset = this._caretHint;
    if (
      caretOffset !== undefined && caretOffset > 0 &&
      this._prefixCache !== null &&
      verticalAlign !== 'center' && verticalAlign !== 'bottom'
    ) {
      const cachedCaret = this._prefixCache.caretOffset;
      const prefixHash = this._computePrefixHash(cachedCaret);
      if (this._prefixCache.hash === prefixHash) {
        this._applyPrefixCache(caretOffset);
        this._caretHint = undefined;
        return;
      }
    }

    this._columnContents = [];
    this._overflow = 0;
    this._overlayRectsMm = null;
    this._parseContents();

    const columnHeightMm = this._inheritStyle?.parentHeight ?? 0;
    const baseFontSizeMm = this.fontSize;
    const effectiveColumnHeightMm = columnHeightMm > 0
      ? columnHeightMm + (this._lineHeight - baseFontSizeMm)
      : 0;

    this._layoutColumnsPass(new Array(this.columnCount).fill(0));

    if (verticalAlign === 'center' || verticalAlign === 'bottom') {
      for (let iter = 0; iter < 3; iter++) {
        const alignOffsetsMm = this._columnContents.map(column =>
          this._computeAlignOffsetMm(column, effectiveColumnHeightMm, baseFontSizeMm, columnHeightMm),
        );
        if (alignOffsetsMm.every(o => o === 0)) break;

        const prevLineCounts = this._columnContents.map(c => c.length);
        this._layoutColumnsPass(alignOffsetsMm);
        const newLineCounts = this._columnContents.map(c => c.length);
        if (prevLineCounts.every((n, i) => n === newLineCounts[i])) break;
      }
    }

    this._applyLineBreakRules();
    this._computeCharOffsets();
    this._computePerLineHeights();

    this._previousLineCount = this._columnContents.reduce((sum, col) => sum + col.length, 0);
    this._previousOverflow = this._overflow;

    this._layoutCache = {
      hash: inputHash,
      columnContents: this._columnContents,
      overflow: this._overflow,
    };

    if (caretOffset !== undefined && caretOffset > 0 && verticalAlign !== 'center' && verticalAlign !== 'bottom') {
      this._buildPrefixCache(caretOffset);
    }

    this._caretHint = undefined;
  }

  /**
   * 캐시된 배치 결과의 `inlineStyles`만 현재 `textContent`에서 재매핑한다.
   *
   * Skeleton 캐시 히트 시(배치 영향 필드인 fontFamily/fontSize/fontStyle이
   * 불변, fontWeight/color만 변경) 호출된다. 배치 결과(라인/파트 구조,
   * 글자 순서, charOffsets)는 캐시된 그대로 유지하고, 각 파트의
   * `inlineStyles[j]`만 최신 `_contents`에서 다시 채운다.
   *
   * 알고리즘: `_contents`를 평탄화된 글자 스트림으로 순회하며,
   * `columnContents`의 각 파트 `content` 글자를 순서대로 소비하여
   * 대응하는 런의 `textInlineStyle`을 `inlineStyles[j]`에 설정한다.
   * `_applyLineBreakRules()`로 인한 라인 간 글자 이동이 있어도
   * 전체 평탄화 순서는 불변이므로 정확히 매칭된다.
   */
  private _refreshInlineStylesOnly(): void {
    this._parseContents();

    let blockIdx = 0;
    let runIdx = 0;
    let charIdx = 0;

    const nextStyle = (): TextInlineStyle | undefined => {
      while (blockIdx < this._contents.length) {
        const runs = this._contents[blockIdx];
        if (runIdx >= runs.length) {
          blockIdx++;
          runIdx = 0;
          charIdx = 0;
          continue;
        }
        const run = runs[runIdx];
        if (charIdx >= run.content.length) {
          runIdx++;
          charIdx = 0;
          continue;
        }
        const style = run.textInlineStyle;
        charIdx++;
        return style;
      }
      return undefined;
    };

    for (const column of this._columnContents) {
      for (const line of column) {
        for (const part of line.parts) {
          if (part.content.length === 0) {
            part.inlineStyles = [];
            continue;
          }
          const styles: (TextInlineStyle | undefined)[] = new Array(part.content.length);
          for (let j = 0; j < part.content.length; j++) {
            styles[j] = nextStyle();
          }
          part.inlineStyles = styles;
        }
      }
    }

    this._computePerLineHeights();
  }

  /**
   * 캐럿 이전 텍스트 + 배치 파라미터의 해시를 계산한다.
   * `_prefixCache`에 저장된 `caretOffset`으로 계산하여, 연속 타이핑 시
   * 이전 키스트로크의 prefix와 현재 텍스트의 동일 구간을 비교한다.
   */
  private _computePrefixHash(caretOffset: number): string {
    const parts: string[] = [];
    const plain = this.plainText;
    const prefixText = plain.slice(0, caretOffset);
    parts.push("pt:" + prefixText);

    const tc = this._textContent;
    if (typeof tc !== "string") {
      let consumed = 0;
      for (const block of tc) {
        const content = typeof block === "string" ? block : block.content;
        const blockLen = content.length;
        if (consumed >= caretOffset) break;
        const end = Math.min(consumed + blockLen, caretOffset);
        const slice = content.slice(0, end - consumed);
        parts.push(slice);
        if (typeof block !== "string") {
          const s = block.textInlineStyle;
          if (s) {
            parts.push(
              "s:" + (s.fontFamily ?? "") + "," +
                    (s.fontSize ?? "") + "," +
                    (s.fontStyle ?? ""),
            );
          }
        }
        consumed += blockLen;
      }
    }

    const pAbsLeft = this._data.parentAbsRect.absLeft;
    const pAbsTop = this._data.parentAbsRect.absTop;
    const overlapEls = this._data.overlayEngines;
    for (const el of overlapEls) {
      let mode: OverlapMode | ParagraphOverlapMode = "path";
      let hasRgba = false;
      let paddingKey = "";
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
        }
      }
      const rect = el.absRect;
      const relLeft = rect.absLeft - pAbsLeft;
      const relTop = rect.absTop - pAbsTop;
      parts.push("o:" + relLeft + "," + relTop + "," + rect.absWidth + "," + rect.absHeight + "," + mode + "," + (hasRgba ? 1 : 0) + "," + paddingKey);
    }

    parts.push(
      "cw:" + this._columnWidths.join(","),
      "g:" + this._gaps.join(","),
      "lh:" + this._lineHeight,
      "wr:" + this.widthRatio,
      "ls:" + this.effectiveTextStyle.letterSpacing!,
      "sr:" + this.spaceRatio,
      "fs:" + this.effectiveTextStyle.fontSize!,
      "ph:" + (this._inheritStyle?.parentHeight ?? 0),
    );

    return parts.join("|");
  }

  /**
   * plain-text 오프셋을 `_contents`의 (blockIdx, runIdx, charIdx)로 변환한다.
   * plain-text는 `\n`을 포함하므로, 각 블록 후 `offset++`로 `\n`을 건너뛴다.
   */
  private _plainOffsetToContentsPos(plainOffset: number): { blockIdx: number; runIdx: number; charIdx: number } | null {
    let offset = 0;
    for (let blockIdx = 0; blockIdx < this._contents.length; blockIdx++) {
      const runs = this._contents[blockIdx];
      for (let runIdx = 0; runIdx < runs.length; runIdx++) {
        const run = runs[runIdx];
        const runLen = run.content.length;
        if (offset + runLen > plainOffset) {
          return { blockIdx, runIdx, charIdx: plainOffset - offset };
        }
        offset += runLen;
      }
      offset++;
    }
    return null;
  }

  /**
   * 전체 재배치 후 prefix 캐시를 구축한다.
   * 캐럿 이전의 컬럼들을 저장하고, 재배치 시작점을 계산한다.
   *
   * 수정된 시작 위치 계산:
   * - prefixColumnCount === 0 (캐럿이 첫 컬럼 내부): 캐시 구축하지 않음 (return)
   * - prefixColumnCount > 0: 시작점 = `_plainOffsetToContentsPos(globalOffset)`
   *   (컬럼 경계에 해당하는 plain-text 오프셋)
   */
  private _buildPrefixCache(caretOffset: number): void {
    const plain = this.plainText;
    if (caretOffset >= plain.length) return;

    let globalOffset = 0;
    let prefixColumnCount = 0;

    for (let c = 0; c < this._columnContents.length; c++) {
      const column = this._columnContents[c];
      let colCharCount = 0;
      for (const line of column) {
        for (const part of line.parts) {
          colCharCount += part.content.length;
        }
        // endOfBlock 라인 뒤의 블록 구분자 '\n'도 plain offset에 포함된다.
        // caretOffset가 plain 기준이므로 컬럼 경계 계산에 이를 반영해야 한다.
        // 누락 시 globalOffset이 컬럼당 블록 수만큼 짧아져 재개 위치가
        // 앞 블록 중간을 가리키고, 앞 단의 마지막 글자들이 현재 단으로
        // 당겨와 렌더된다 (3단 문서의 2·3단 타이핑 시 재현).
        if (line.endOfBlock && globalOffset + colCharCount + 1 <= plain.length && plain[globalOffset + colCharCount] === '\n') {
          colCharCount++;
        }
      }
      if (globalOffset + colCharCount <= caretOffset) {
        prefixColumnCount = c + 1;
        globalOffset += colCharCount;
      } else {
        break;
      }
    }

    if (prefixColumnCount === 0) return;

    const pos = this._plainOffsetToContentsPos(globalOffset);
    if (!pos) return;

    this._prefixCache = {
      caretOffset,
      hash: this._computePrefixHash(caretOffset),
      columnContents: this._columnContents.slice(0, prefixColumnCount),
      startColumnIdx: prefixColumnCount,
      startBlockIdx: pos.blockIdx,
      startRunIdx: pos.runIdx,
      startCharIdx: pos.charIdx,
    };
  }

  /**
   * prefix 캐시를 적용하여 캐럿 이전 컬럼은 재사용, 이후만 재배치한다.
   * `_layoutColumnsPass`를 일반화하여 `startColumn`부터 시작한다.
   */
  private _applyPrefixCache(caretOffset: number): void {
    const cache = this._prefixCache!;
    this._parseContents();

    this._columnContents = [...cache.columnContents];
    this._overflow = 0;
    this._overlayRectsMm = null;

    const startColumn = cache.startColumnIdx;
    const startBlockIdx = cache.startBlockIdx;
    const startRunIdx = cache.startRunIdx;
    const startCharIdx = cache.startCharIdx;

    this._layoutColumnsPass(
      new Array(this.columnCount).fill(0),
      startColumn,
      startBlockIdx,
      startRunIdx,
      startCharIdx,
    );

    this._applyLineBreakRules();
    this._computeCharOffsets();
    this._computePerLineHeights();

    this._previousLineCount = this._columnContents.reduce((sum, col) => sum + col.length, 0);
    this._previousOverflow = this._overflow;

    const fullHash = this._computeLayoutInputHash();
    this._layoutCache = {
      hash: fullHash,
      columnContents: this._columnContents,
      overflow: this._overflow,
    };

    this._buildPrefixCache(caretOffset);
  }

  /**
   * 각 라인의 `maxFontSize`와 `lineHeight`를 산출하여 `TextLineData`에 채운다.
   *
   * 라인 높이 = `maxFontSize × lineGap`이며, 라인 내 모든 파트의
   * 인라인 `fontSize`와 문단 기본 `fontSize` 중 최대값을 사용한다.
   *
   * 레이아웃(라인 분할/오버플로우 판정) 완료 후 호출된다.
   * 레이아웃 과정 중에는 고정 `_lineHeight`를 사용하고,
   * 완료 후 이 메서드가 실제 라인별 높이를 결정한다.
   *
   * @example
   * // 라인에 기본(4mm)과 인라인(6mm) 글자가 섞인 경우:
   * // line.maxFontSize = 6, line.lineHeight = 6 × 1.25 = 7.5
   */
  private _computePerLineHeights(): void {
    const lineGap = this.effectiveParagraphStyle.lineGap!;
    const baseFontSize = this.fontSize;

    for (const column of this._columnContents) {
      for (const line of column) {
        let maxFs = baseFontSize;
        for (const part of line.parts) {
          if (!part.inlineStyles) continue;
          for (const style of part.inlineStyles) {
            if (style?.fontSize !== undefined && style.fontSize > maxFs) {
              maxFs = style.fontSize;
            }
          }
        }
        line.maxFontSize = maxFs;
        line.lineHeight = maxFs * lineGap;
      }
    }
  }

  /**
   * 특정 컬럼/라인의 높이를 반환한다.
   *
   * @param columnIndex - 컬럼 인덱스
   * @param lineIndex - 라인 인덱스
   * @returns 라인 높이 (mm). 라인 데이터가 없으면 `baseLineHeight`
   */
  private _getLineHeightForLine(columnIndex: number, lineIndex: number): number {
    const line = this._columnContents[columnIndex]?.[lineIndex];
    return line?.lineHeight ?? this.baseLineHeight;
  }

  /**
   * 특정 컬럼에서 주어진 라인 인덱스까지의 누적 높이(해당 라인 직전까지)를 반환한다.
   *
   * @param columnIndex - 컬럼 인덱스
   * @param lineIndex - 라인 인덱스 (이 라인 직전까지 누적)
   * @returns 누적 높이 (mm)
   */
  private _getCumulativeLineTop(columnIndex: number, lineIndex: number): number {
    const column = this._columnContents[columnIndex];
    if (!column) return 0;
    let cum = 0;
    for (let i = 0; i < lineIndex && i < column.length; i++) {
      cum += column[i]?.lineHeight ?? this.baseLineHeight;
    }
    return cum;
  }

  /**
   * 라인 내 char의 수직 offset을 반환한다 (단일 소스).
   *
   * 하단 앵커 원칙: 모든 글자의 하단을 라인의 fontSize 영역 하단에 맞춘다.
   * `lineMaxFontSize`가 `charFontSize`보다 크면 offset > 0 (아래로 내려 하단 맞춤).
   * `lineMaxFontSize`가 `charFontSize`와 같으면 offset = 0.
   *
   * `genCharStyle`, `genCharStyleFlat`, `getCharRect`, `buildParagraphPrintPostData`가
   * 모두 이 메서드를 사용하여 단일 소스를 보장한다.
   *
   * @param lineMaxFontSize - 라인의 최대 폰트 크기 (mm)
   * @param charFontSize - char의 폰트 크기 (mm)
   * @returns 라인 top 기준 수직 offset (mm, ≥ 0)
   */
  public _getCharVerticalOffset(lineMaxFontSize: number, charFontSize: number): number {
    return lineMaxFontSize - charFontSize;
  }

  /**
   * 컬럼별 레이아웃 패스를 수행한다.
   * `_layoutTextIntoColumns`의 핵심 루프를 추출한 것으로,
   * `alignOffsetsMm` 파라미터로 각 컬럼의 verticalAlign 오프셋을 받는다.
   *
   * `this.contents`는 `\n`으로 분리된 라인 배열이며, 각 라인은
   * `TextInlineData[]`(런 배열)이다. 런을 펼쳐서 중간 배열(flatChars)을
   * 만들지 않고 (runIdx, charIdx) 이중 인덱스로 직접 순회한다.
   *
   * @param alignOffsetsMm - 컬럼별 alignOffsetMm 배열 (top 정렬이면 모두 0)
   * @param startColumn - 재배치 시작 컬럼 (prefix 캐시 시 0이 아님)
   * @param startBlockIdx - 재배치 시작 블록 인덱스
   * @param startRunIdx - 재배치 시작 런 인덱스
   * @param startCharIdx - 재배치 시작 글자 인덱스
   */
  private _layoutColumnsPass(
    alignOffsetsMm: number[],
    startColumn: number = 0,
    startBlockIdx: number = 0,
    startRunIdx: number = 0,
    startCharIdx: number = 0,
  ): void {
    if (startColumn === 0) {
      this._columnContents = [];
      this._overflow = 0;
      this._columnLeftOffsets = new Array(this._columnWidths.length + 1);
      let cum = 0;
      this._columnLeftOffsets[0] = 0;
      for (let i = 0; i < this._columnWidths.length; i++) {
        cum += this._columnWidths[i];
        this._columnLeftOffsets[i + 1] = cum + (i < this._gaps.length ? this._gaps[i] : 0);
      }
    }
    this._overlayRectsMm = null;

    let beforeIdxBlock = startBlockIdx;
    let beforeRunIdx = startRunIdx;
    let beforeCharIdx = startCharIdx;

    for (let curColumn = startColumn; curColumn < this.columnCount; curColumn++) {
      let columnContent: TextLineData[] = [];
      let hasLine = false;
      let partWidths: number[] = [];
      let currentPartIdx = 0;
      let cumulativeWidths: number[] = [];
      let isColumnOverflow = false;

      let idxBlock = beforeIdxBlock;
      let runIdx = beforeRunIdx;
      let charIdx = beforeCharIdx;
      const alignOffsetMm = alignOffsetsMm[curColumn] ?? 0;

      for (; idxBlock < this.contents.length; idxBlock++) {
        const runs = this.contents[idxBlock];
        if (idxBlock !== beforeIdxBlock) { runIdx = 0; charIdx = 0; }

        const blockTotalChars = runs.reduce((sum, r) => sum + r.content.length, 0);
        let flatIdxInBlock = 0;
        for (let r = 0; r < runIdx; r++) flatIdxInBlock += runs[r].content.length;
        flatIdxInBlock += charIdx;

        if (!hasLine || (runIdx === 0 && charIdx === 0)) {
          let isFirstLineInLoop = true;
          while (true) {
            const isFirstInColumn = curColumn === 0 && columnContent.length < 1 && isFirstLineInLoop;
            const result = this._createLineWithParts(
              curColumn,
              columnContent.length,
              isFirstInColumn,
              runIdx === 0 && charIdx === 0,
              alignOffsetMm,
            );
            isColumnOverflow = result.overflow;

            if (columnContent.length > 0 && !result.cover) {
              columnContent[columnContent.length - 1].endOfBlock = true;
            }

            if (result.cover) {
              columnContent.push(result.lineData);
              partWidths = [];
              hasLine = false;
              isFirstLineInLoop = false;
              if (result.overflow) {
                break;
              }
              continue;
            }

            if (result.overflow) {
              columnContent.push(result.lineData);
              hasLine = false;
              partWidths = [];
              break;
            }

            columnContent.push(result.lineData);
            hasLine = true;
            partWidths = result.partWidths;
            currentPartIdx = 0;
            cumulativeWidths = new Array(partWidths.length).fill(0);
            isFirstLineInLoop = false;
            break;
          }

          if (!hasLine) {
            if (isColumnOverflow && curColumn < this._columnWidths.length - 1) break;
          }

          if (!hasLine || partWidths.length === 0) {
            if (isColumnOverflow) continue;
            break;
          }
        }

        const letterSpacingEm = this.effectiveTextStyle.letterSpacing!;
        const effTextStyle = this.effectiveTextStyle;
        const baseFontSizeMm = effTextStyle.fontSize!;
        const wr = this.widthRatio;
        const effSpaceRatio = this.spaceRatio;
        const lastColumnIdx = this._columnWidths.length - 1;
        const charWidthCache = this._charWidthCache;
        const charWidthByFont = this._charWidthByFontCache;

        charLoop: while (runIdx < runs.length) {
          const run = runs[runIdx];
          const inlineStyle = run.textInlineStyle;
          const content = run.content;
          const inlineFontSize = inlineStyle?.fontSize ?? baseFontSizeMm;
          const inlineFontName = inlineStyle?.fontFamily ?? "";
          const letterSpacingMm = letterSpacingEm * inlineFontSize;
          const minWidthMm = effSpaceRatio * inlineFontSize;

          const fontKey = inlineFontName + "|" + inlineFontSize;
          let fontWidthMap = charWidthByFont.get(fontKey);
          if (fontWidthMap === undefined) {
            fontWidthMap = new Map();
            charWidthByFont.set(fontKey, fontWidthMap);
          }

          for (; charIdx < content.length; charIdx++, flatIdxInBlock++) {
            const char = content[charIdx];

            // _charWidthMm 인라인: 런당 1회 조합 키, 글자별 단일 키 조회
            let rawCharWidth: number;
            if (char === " ") {
              rawCharWidth = minWidthMm;
            } else {
              let cached = fontWidthMap.get(char);
              if (cached === undefined) {
                const fontWidth = this._charWidthMmFromFont(char, inlineStyle, inlineFontSize);
                if (fontWidth !== null) {
                  fontWidthMap.set(char, fontWidth);
                  charWidthCache.set(char + "|" + fontKey, fontWidth);
                  cached = fontWidth;
                } else {
                  cached = 0;
                }
              }
              rawCharWidth = cached > minWidthMm ? cached : minWidthMm;
            }
            const charWidth = rawCharWidth * wr + letterSpacingMm;

            const targetLine = columnContent[columnContent.length - 1];
            const targetPart = targetLine.parts[currentPartIdx];

            const isLastCharInBlock = flatIdxInBlock >= blockTotalChars - 1;

            if (cumulativeWidths[currentPartIdx] + charWidth <= partWidths[currentPartIdx] + 1e-6) {
              cumulativeWidths[currentPartIdx] += charWidth;
              targetPart.content.push(char);
              (targetPart.inlineStyles ??= []).length = targetPart.content.length;
              targetPart.inlineStyles[targetPart.content.length - 1] = inlineStyle;

              if (isLastCharInBlock) {
                targetLine.endOfBlock = true;
              }

              if (isColumnOverflow) {
                if (curColumn < lastColumnIdx) {
                  if (!isLastCharInBlock) {
                    columnContent = this._removeTrailingEmptyLine(columnContent);
                  }
                  break charLoop;
                } else {
                  this._overflow++;
                }
              }
              continue;
            }

            let placed = false;
            currentPartIdx++;
            while (currentPartIdx < partWidths.length) {
              if (cumulativeWidths[currentPartIdx] + charWidth <= partWidths[currentPartIdx] + 1e-6) {
                cumulativeWidths[currentPartIdx] += charWidth;
                const part = targetLine.parts[currentPartIdx];
                part.content.push(char);
                (part.inlineStyles ??= []).length = part.content.length;
                part.inlineStyles[part.content.length - 1] = inlineStyle;
                placed = true;
                break;
              }
              currentPartIdx++;
            }

            if (placed) {
              if (isLastCharInBlock) {
                targetLine.endOfBlock = true;
              }

              if (isColumnOverflow) {
                if (curColumn < lastColumnIdx) {
                  if (!isLastCharInBlock) {
                    columnContent = this._removeTrailingEmptyLine(columnContent);
                  }
                  break charLoop;
                } else {
                  this._overflow++;
                }
              }
              continue;
            }

            while (true) {
              const result = this._createLineWithParts(curColumn, columnContent.length, false, false, alignOffsetMm);
              isColumnOverflow = result.overflow;

              if (result.cover) {
                columnContent.push(result.lineData);
                partWidths = [];
                hasLine = false;
                if (result.overflow) {
                  if (curColumn < lastColumnIdx) {
                    if (!isLastCharInBlock) {
                      columnContent = this._removeTrailingEmptyLine(columnContent);
                    }
                    break charLoop;
                  } else {
                    this._overflow++;
                  }
                }
                continue;
              }

              if (result.overflow) {
                if (curColumn < lastColumnIdx) {
                  if (!isLastCharInBlock) {
                    columnContent = this._removeTrailingEmptyLine(columnContent);
                  }
                  hasLine = false;
                  partWidths = [];
                  break charLoop;
                } else {
                  this._overflow++;
                }
              }

              columnContent.push(result.lineData);
              hasLine = true;
              partWidths = result.partWidths;
              currentPartIdx = 0;
              cumulativeWidths = new Array(partWidths.length).fill(0);

              const newLine = columnContent[columnContent.length - 1];
              if (cumulativeWidths[currentPartIdx] + charWidth <= partWidths[currentPartIdx] + 1e-6) {
                cumulativeWidths[currentPartIdx] += charWidth;
                const part = newLine.parts[currentPartIdx];
                part.content.push(char);
                (part.inlineStyles ??= []).length = part.content.length;
                part.inlineStyles[part.content.length - 1] = inlineStyle;
                break;
              }

              currentPartIdx++;
              while (currentPartIdx < partWidths.length) {
                if (cumulativeWidths[currentPartIdx] + charWidth <= partWidths[currentPartIdx] + 1e-6) {
                  cumulativeWidths[currentPartIdx] += charWidth;
                  const part = newLine.parts[currentPartIdx];
                  part.content.push(char);
                  (part.inlineStyles ??= []).length = part.content.length;
                  part.inlineStyles[part.content.length - 1] = inlineStyle;
                  break;
                }
                currentPartIdx++;
              }

              if (currentPartIdx >= partWidths.length) {
                const maxPartWidth = partWidths.length > 0 ? Math.max(...partWidths) : 0;
                if (charWidth > maxPartWidth + 1e-6) {
                  const part = newLine.parts[0];
                  part.content.push(char);
                  (part.inlineStyles ??= []).length = part.content.length;
                  part.inlineStyles[part.content.length - 1] = inlineStyle;
                  cumulativeWidths[0] += charWidth;
                  break;
                }
                columnContent = this._removeTrailingEmptyLine(columnContent);
                charIdx--;
                flatIdxInBlock--;
                currentPartIdx = 0;
                continue;
              }

              break;
            }

            if (isColumnOverflow && curColumn < lastColumnIdx) {
              break charLoop;
            }

            if (isLastCharInBlock) {
              columnContent[columnContent.length - 1].endOfBlock = true;
            }

            if (isColumnOverflow) {
              if (curColumn < lastColumnIdx) {
                if (!isLastCharInBlock) {
                  columnContent = this._removeTrailingEmptyLine(columnContent);
                }
                break charLoop;
              } else {
                this._overflow++;
              }
            }
          }
          charIdx = 0;
          runIdx++;
        }

        if (isColumnOverflow) {
          if (curColumn < this._columnWidths.length - 1) break;
        }
      }

      if (columnContent.length > 0) {
        const isEndOfText = idxBlock === this.contents.length
          && runIdx >= this.contents[this.contents.length - 1].length;
        if (isEndOfText || isColumnOverflow) {
          columnContent[columnContent.length - 1].endOfText = true;
        }
      }

      beforeRunIdx = runIdx;
      beforeCharIdx = charIdx;
      beforeIdxBlock = idxBlock;

      if (curColumn < this._columnContents.length) {
        this._columnContents[curColumn] = columnContent;
      } else {
        this._columnContents.push(columnContent);
      }
    }
  }

  /**
   * 레이아웃 입력 매개변수 해시를 계산한다.
   * 해시가 동일하면 레이아웃 결과가 동일하므로 `_layoutTextIntoColumns()`를 생략할 수 있다.
   *
   * @returns 해시 문자열
   */
  private _computeLayoutInputHash(): string {
    const parts: string[] = [];

    if (typeof this._textContent === "string") {
      parts.push(this._textContent);
    } else {
      for (const block of this._textContent) {
        if (typeof block === "string") {
          parts.push(block);
        } else {
          parts.push(block.content);
          const s = block.textInlineStyle;
          if (s) {
            // 배치(글자 폭, 라인 분할)에 영향을 주는 필드만 해시에 포함.
            // fontWeight/color는 폭/높이에 무영향이므로 제외 — 스타일만 변경된
            // 주입(굵게/색상)에서 캐시 히트 → 재래핑 생략. inlineStyles는
            // _refreshInlineStylesOnly() 경량 패스로 최신화된다.
            parts.push(
              "s:" +
                (s.fontFamily ?? "") + "," +
                (s.fontSize ?? "") + "," +
                (s.fontStyle ?? ""),
            );
          }
        }
      }
    }

    const pAbsLeft = this._data.parentAbsRect.absLeft;
    const pAbsTop = this._data.parentAbsRect.absTop;

    const overlapEls = this._data.overlayEngines;
    for (const el of overlapEls) {
      let mode: OverlapMode | ParagraphOverlapMode = "path";
      let hasRgba = false;
      let paddingKey = "";
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
        }
      }
      const rect = el.absRect;
      const relLeft = rect.absLeft - pAbsLeft;
      const relTop = rect.absTop - pAbsTop;
      parts.push("o:" + relLeft + "," + relTop + "," + rect.absWidth + "," + rect.absHeight + "," + mode + "," + (hasRgba ? 1 : 0) + "," + paddingKey);
    }

    parts.push(
      "cw:" + this._columnWidths.join(","),
      "g:" + this._gaps.join(","),
      "lh:" + this._lineHeight,
      "wr:" + this.widthRatio,
      "ls:" + this.effectiveTextStyle.letterSpacing!,
      "sr:" + this.spaceRatio,
      "fs:" + this.effectiveTextStyle.fontSize!,
      "ph:" + (this._inheritStyle?.parentHeight ?? 0),
    );

    return parts.join("|");
  }

  /**
   * 구조적 레이아웃만 계산하고 캐싱한다. 컬럼 폭, 간격, lineHeight 등을
   * private 필드에 저장한다.
   * 내부적으로 `_initStructureAndMeasureColumns()`를 호출한다.
   */
  public layoutStructure(): void {
    this._initStructureAndMeasureColumns();
  }

  /**
   * 문자 단위 줄바꿈 렌더링을 실행한다. `layoutStructure()`가 먼저 호출되어
   * 구조 데이터가 준비되어 있어야 한다.
   * 내부적으로 `_layoutTextIntoColumns()`를 호출한다.
   */
  public layoutText(): void {
    if (!this._data.parentBox) {
      throw createNoParentError('ParagraphEngine', 'appendChildContentEngine');
    }
    this._layoutTextIntoColumns();
    this._dirty = false;
  }

  /**
   * 오버랩 문맥(overlayEngines, parentAbsRect, inheritStyle)만 경량 갱신한다.
   *
   * `data` setter와 달리 `_layoutCache`를 무효화하지 않는다.
   * 박스 드래그/리사이즈 시 오버랩 관계가 변할 수 있지만,
   * 텍스트 레이아웃 입력 해시가 동일하면 캐시된 결과를 재사용한다.
   * `_overlayRectsMm`만 null로 리셋하여 다음 `_detectOverlapWithCache`가
   * 새 rect를 구성하도록 한다.
   *
   * @param overlayEngines - 새 오버랩 엔진 배열
   * @param parentAbsRect - 새 부모 박스 절대 사각형
   * @param inheritStyle - 새 상속 스타일 (parentHeight/parentWidth 포함)
   */
  public updateOverlayContext(
    overlayEngines: BoxEngine[],
    parentAbsRect: AbsRect,
    inheritStyle: InheritStyle,
  ): void {
    this._data = {
      ...this._data,
      overlayEngines,
      parentAbsRect,
      inheritStyle,
    };
    this._inheritStyle = inheritStyle;
    this._effectivePsDirty = true;
    this._effectiveTsDirty = true;
    this._overlayRectsMm = null;
  }

  /**
   * 증분 렌더링 상태를 초기화한다. 구조 변경 후 전체 재생성을 보장하기 위해
   * `previousLineCount`와 `previousOverflow`를 -1로 설정한다.
   */
  public resetIncrementalState(): void {
    if (this._renderShapePreserved) {
      // preserveRenderShapeAcrossReset()이 예약한 형태 유지 요청이 있으면
      // 라인 수/오버플로우 센티널만 보존하고 캐시는 무효화한다.
      const { lineCount, overflow } = this._renderShapePreserved;
      this._previousLineCount = lineCount;
      this._previousOverflow = overflow;
      this._renderShapePreserved = null;
    } else {
      this._previousLineCount = -1;
      this._previousOverflow = -1;
    }
    this._layoutCache = null;
    this._overlayRectsMm = null;
  }

  /**
   * 다음 `data` setter의 `resetIncrementalState()`가 라인 수/오버플로우
   * 센티널을 보존하도록 현재 렌더 형태를 예약한다.
   *
   * 래핑(line breaking)에 영향을 주지 않는 스타일 변경(예: `textAlign`)은
   * 라인 수가 불변하다. 그런데 `data` setter는 센티널을 -1로 리셋하여
   * `_perfShouldFullRecreate()`가 항상 true가 되고, DOM diff 경로가 차단되어
   * 전체 span 재생성(2000자 문단에서 ~30ms)이 발생한다. 이 메서드로 렌더 직전
   * 형태를 예약하면 `layoutText()`가 커밋한 새 형태와 비교되고, 라인 수가 같으면
   * 증분 diff(position-only 델타)가 실행된다.
   *
   * 안전 가드: `layoutText()` 후 라인 수/오버플로우가 실제로 다르면
   * `_perfShouldFullRecreate()` 비교가 false→true로 정상 전체 재생성한다.
   * 예약은 1회성이며, 이후 `data` setter 호출에는 다시 -1 센티널이 적용된다.
   *
   * @returns void
   *
   * @example
   * ```ts
   * // 정렬 변경: 래핑 불변이므로 형태 보존 예약 후 data 주입
   * engine.preserveRenderShapeAcrossReset();
   * paragraph.layout();  // data setter → 센티널 보존
   * ```
   */
  public preserveRenderShapeAcrossReset(): void {
    this._renderShapePreserved = {
      lineCount: this._previousLineCount,
      overflow: this._previousOverflow,
    };
  }

  /** 컬럼 스타일 생성 (라인 절대 위치 기반 컨테이너) */
  public genColumnStyle(idx: number): Partial<CSSStyleDeclaration> {
    const left = this._columnWidths.slice(0, idx).reduce((a, b) => a + b, 0) + this._gaps.slice(0, idx).reduce((a, b) => a + b, 0);
    const height = this._inheritStyle.parentHeight;
    const width = this._columnWidths[idx];

    return {
      boxSizing: "border-box",
      display: "block",
      height: `${height}mm`,
      left: `${left}mm`,
      lineHeight: `1em`,
      maxHeight: `${height}mm`,
      maxWidth: `${width}mm`,
      minHeight: `${height}mm`,
      minWidth: `${width}mm`,
      overflow: "hidden",
      position: "absolute",
      top: "0",
      width: `${width}mm`,
    };
  }

  /**
   * 줄 스타일 생성.
   *
   * 라인 높이는 문단 기본 `fontSize` 기준으로 항상 고정이다. 인라인 폰트가
   * 커도 라인 높이가 변하지 않으며, 큰 폰트의 글자는 하단 앵커로 배치된다
   * (span의 `top` 계산은 `LayoutColumnElement`가 담당).
   *
   * `columnIndex` + `lineIndex` → `position: absolute` + `top` (verticalAlign offset + lineIndex × lineHeight)
   *
   * 엔진 우선 원칙: 엔진이 각 라인의 절대 y 좌표를 산출하고 DOM은 좌표에 라인을 배치한다.
   * `top` = `alignOffsetMm + lineIndex × lineHeight` (mm)로,
   * `buildParagraphPrintPostData`의 `lineTopMm` 계산과 동일하다.
   *
   * @param columnIndex - 컬럼 인덱스 (0-based). `top` 계산에 필요.
   * @param lineIndex - 컬럼 내 라인 인덱스 (0-based). `top` 계산에 필요.
   * @returns 줄 CSS 스타일 객체. `columnIndex`/`lineIndex` 생략 시 `position: absolute` 미적용 (레거시 호환).
   * @example
   * ```ts
   * // 2번째 컬럼의 3번째 라인 스타일
   * const style = engine.genLineStyle(1, 2);
   * // top = alignOffsetMm + 2 * lineHeight (mm)
   * ```
   */
  public genLineStyle(columnIndex?: number, lineIndex?: number): Partial<CSSStyleDeclaration> {
    const positionStyle: Partial<CSSStyleDeclaration> = {};
    if (columnIndex !== undefined && lineIndex !== undefined) {
      const baseFontSizeMm = this.fontSize;
      const columnHeightMm = this._inheritStyle?.parentHeight ?? 0;
      const effectiveColumnHeightMm = columnHeightMm > 0
        ? columnHeightMm + (this._lineHeight - baseFontSizeMm)
        : 0;
      const column = this._columnContents[columnIndex] ?? [];
      const alignOffsetMm = this._computeAlignOffsetMm(column, effectiveColumnHeightMm, baseFontSizeMm, columnHeightMm);
      const cumulativeTop = this._getCumulativeLineTop(columnIndex, lineIndex);
      const isLastLine = lineIndex === column.length - 1;
      const lineMaxFontSize = column[lineIndex]?.maxFontSize ?? baseFontSizeMm;
      positionStyle.position = "absolute";
      positionStyle.top = `${alignOffsetMm + cumulativeTop}mm`;
      positionStyle.height = `${isLastLine ? lineMaxFontSize : this._getLineHeightForLine(columnIndex, lineIndex)}mm`;
    }

    return {
      display: "flex",
      flexDirection: "row",
      flexWrap: "nowrap",
      flexShrink: "0",
      maxWidth: "100%",
      width: "100%",
      ...positionStyle,
    };
  }

  /**
   * 파트 스타일 생성.
   *
   * - `letterSpacing` → em 단위 적용
   * - `textAlign` → `justify-content` 매핑 ('justify' → 'space-between')
   *
   * 인라인 스타일(폰트/색상)은 라인/파트가 아닌 글자(span) 단위로 적용된다.
   *
   * @returns 파트 CSS 스타일 객체
   */
  public genPartStyle(): Partial<CSSStyleDeclaration> {
    const textAlign = this.effectiveParagraphStyle.textAlign!;

    let justifyContent: "center" | "flex-start" | "flex-end" | "space-between";
    switch (textAlign) {
      case "center":
        justifyContent = "center";
        break;
      case "left":
        justifyContent = "flex-start";
        break;
      case "right":
        justifyContent = "flex-end";
        break;
      default:
        justifyContent = "space-between";
        break;
    }

    return {
      display: "inline-flex",
      flexDirection: "row",
      flexWrap: "nowrap",
      alignItems: "baseline",
      justifyContent,
    };
  }

  /**
   * 글자 외부 span 스타일 생성.
   *
   * `_charWidthMm`으로 원본 폭을 측정한 뒤 `widthRatio`를 곱해 `width`를 고정한다.
   * 내부 span(`genCharInnerStyle`)이 `scale`로 glyph 축소를 담당한다.
   * 공백은 `fontSize × spaceRatio`로 고정한다.
   *
   * @param char - 대상 문자
   * @param inlineStyle - 인라인 스타일 오버라이드 (선택)
   * @returns 외부 span CSS 스타일 객체
   */
  public genCharStyle = (char: string, inlineStyle?: TextInlineStyle, lineMaxFontSize?: number): Partial<CSSStyleDeclaration> => {
    const wr = this.widthRatio;
    const lsEm = this.effectiveTextStyle.letterSpacing!;
    const sr = this.spaceRatio;
    const fs = inlineStyle?.fontSize ?? this.effectiveTextStyle.fontSize!;
    const lmfs = lineMaxFontSize ?? fs;
    const cacheKey = `${char}|${wr}|${lsEm}|${sr}|${fs}|${lmfs}`;
    const cached = this._charOuterStyleCache.get(cacheKey);
    if (cached) return cached;

    const lsMm = lsEm * fs;
    let widthMm: number;
    if (char === " ") {
      widthMm = this.spaceRatio * fs * wr + lsMm;
    } else {
      const rawWidthMm = this._charWidthMm(char, inlineStyle);
      widthMm = rawWidthMm * wr + lsMm;
    }

    const widthCss = `${widthMm}mm`;
    const style: Partial<CSSStyleDeclaration> = {
      display: "inline-block",
      width: widthCss,
      minWidth: `${this.spaceRatio * fs}mm`,
      maxWidth: widthCss,
      textAlign: "center",
    };

    const topMm = this._getCharVerticalOffset(lmfs, fs);
    if (topMm !== 0) {
      style.position = 'relative';
      style.top = `${topMm}mm`;
    }

    this._charOuterStyleCache.set(cacheKey, style);
    return style;
  };

  /**
   * 내부 span 스타일 생성. `scale` transform으로 glyph 시각 축소.
   * 외부 span과 분리되어 레이아웃 박스 크기에 영향을 주지 않는다.
   *
   * **보정 계수 `0.88`**: opentype.js advanceWidth와 브라우저 렌더링 간 격차를 보정.
   * 절대 변경하거나 제거해서는 안 된다.
   *
   * @returns 내부 span CSS 스타일 객체
   */
  public genCharInnerStyle = (): Partial<CSSStyleDeclaration> => {
    const wr = this.widthRatio;
    const key = `inner|${wr}`;
    if (key === this._charInnerStyleKey) return this._charInnerStyle;
    this._charInnerStyleKey = key;
    this._charInnerStyle = {
      display: "inline-block",
      scale: `${wr * 0.88} 1`,
      transformOrigin: "0 center",
    };
    return this._charInnerStyle;
  };

  /**
   * charOffsets(절대 좌표) 경로에서 단일 span에 적용할 통합 스타일을 반환한다.
   *
   * @param char - 대상 문자
   * @param inlineStyle - 인라인 스타일 오버라이드 (선택)
   * @returns 단일 span용 CSS 스타일 객체
   */
  public genCharStyleFlat = (char: string, inlineStyle?: TextInlineStyle, lineMaxFontSize?: number): Partial<CSSStyleDeclaration> => {
    const wr = this.widthRatio;
    const lsEm = this.effectiveTextStyle.letterSpacing!;
    const sr = this.spaceRatio;
    const fs = inlineStyle?.fontSize ?? this.effectiveTextStyle.fontSize!;
    const lmfs = lineMaxFontSize ?? fs;
    const lsMm = lsEm * fs;
    let widthMm: number;
    if (char === " ") {
      widthMm = sr * fs * wr + lsMm;
    } else {
      const rawWidthMm = this._charWidthMm(char, inlineStyle);
      widthMm = rawWidthMm * wr + lsMm;
    }
    const widthCss = `${widthMm}mm`;
    const style: Partial<CSSStyleDeclaration> = {
      display: "inline-block",
      width: widthCss,
      minWidth: `${sr * fs}mm`,
      maxWidth: widthCss,
      scale: `${wr * 0.88} 1`,
      transformOrigin: "0 center",
    };

    const topMm = this._getCharVerticalOffset(lmfs, fs);
    if (topMm !== 0) {
      style.top = `${topMm}mm`;
    }

    return style;
  };

  /**
   * 문자의 원본 폭(mm, 장평 미적용)과 장평 적용 폭(mm)을 반환한다.
   *
   * @param char - 대상 문자
   * @param inlineStyle - 인라인 스타일 오버라이드 (선택)
   * @returns `{ rawWidth: 원본 폭 mm, swidth: 장평 적용 폭 mm, widthRatio: 현재 장평 }`
   */
  public getCharWidths = (char: string, inlineStyle?: TextInlineStyle): { rawWidth: number; swidth: number; widthRatio: number } => {
    const wr = this.widthRatio;
    const fontSize = inlineStyle?.fontSize ?? this.effectiveTextStyle.fontSize!;
    const lsEm = this.effectiveTextStyle.letterSpacing!;
    const lsMm = lsEm * fontSize;
    let rawWidth: number;
    if (char === " ") {
      rawWidth = this.spaceRatio * fontSize;
    } else {
      rawWidth = this._charWidthMm(char, inlineStyle);
    }
    const swidth = rawWidth * wr + lsMm;
    return { rawWidth, swidth, widthRatio: wr };
  };

  /**
   * 컬럼 내 가시 라인 수를 세고 `verticalAlign`에 따른 y 오프셋(mm)을 계산한다.
   *
   * `buildParagraphPrintPostData`의 `alignOffsetMm` 계산 로직과 동일하다:
   * - `visibleLineCount` = `effectiveColumnHeightMm` 내 표시 가능한 라인 수
   * - `contentHeightMm` = `(visibleLineCount - 1) * lineHeight + fontSize` (마지막 라인은 lineHeight 대신 fontSize)
   * - `center`: `(columnHeight - contentHeight) / 2`
   * - `bottom`: `columnHeight - contentHeight`
   * - `top` 또는 contentHeight >= columnHeight: 0
   *
   * 엔진 우선 원칙에 따라 화면 렌더링(getCharRect, genLineStyle)과
   * printPostData(buildParagraphPrintPostData)가 동일한 오프셋을 사용한다.
   *
   * @param column - 해당 컬럼의 `TextLineData[]`
   * @param effectiveColumnHeightMm - 표시 가능 영역 높이 (mm). `parentHeight + (lineHeight - fontSize)`.
   * @param baseFontSizeMm - 기본 폰트 크기 (mm)
   * @param columnHeightMm - 컬럼 전체 높이 (mm). `parentHeight`.
   * @returns verticalAlign 오프셋 (mm). `top`이거나 콘텐츠가 꽉 차면 0.
   * @example
   * ```ts
   * // center 정렬, 10줄 라인 영역에 3줄만 표시되는 경우
   * const offset = engine._computeAlignOffsetMm(column, 40, 4, 40);
   * // visibleLineCount=3, contentHeight=2*8+4=20, offset=(40-20)/2=10
   * ```
   */
  public _computeAlignOffsetMm(
    column: TextLineData[],
    effectiveColumnHeightMm: number,
    baseFontSizeMm: number,
    columnHeightMm: number,
  ): number {
    if (columnHeightMm <= 0) return 0;

    let visibleLineCount = 0;
    let cumulativeHeightMm = 0;
    for (let li = 0; li < column.length; li++) {
      if (!column[li]) continue;
      const lineH = column[li]?.lineHeight ?? this._lineHeight;
      if (effectiveColumnHeightMm > 0 && cumulativeHeightMm + lineH > effectiveColumnHeightMm + 1e-6) break;
      cumulativeHeightMm += lineH;
      visibleLineCount++;
    }

    let contentHeightMm: number;
    if (visibleLineCount === 0) {
      contentHeightMm = 0;
    } else {
      let cum = 0;
      for (let i = 0; i < visibleLineCount - 1; i++) {
        cum += column[i]?.lineHeight ?? this._lineHeight;
      }
      const lastLineMaxFs = column[visibleLineCount - 1]?.maxFontSize ?? baseFontSizeMm;
      contentHeightMm = cum + lastLineMaxFs;
    }

    const verticalAlign = this.effectiveParagraphStyle.verticalAlign!;

    if (verticalAlign === 'center' && columnHeightMm > contentHeightMm) {
      return (columnHeightMm - contentHeightMm) / 2;
    }
    if (verticalAlign === 'bottom' && columnHeightMm > contentHeightMm) {
      return columnHeightMm - contentHeightMm;
    }
    return 0;
  }

  /**
   * source offset에 해당하는 문자의 절대 mm 사각형을 반환한다.
   *
   * `verticalAlign`에 따른 `alignOffsetMm`이 `lineTopMm`에 반영된다.
   * 이는 `buildParagraphPrintPostData`의 y 좌표 계산과 동일하다.
   *
   * `charOffsets`는 `_computeCharOffsets`에서 leading/trailing space를 strip한
   * 기준으로 산출되므로, raw content index를 stripped index로 변환하여
   * 조회해야 한다. strip 범위 밖(leading/trailing space)의 offset에 대해서는
   * 인접한 stripped 문자의 rect를 반환한다.
   *
   * @param sourceOffset - 소스 텍스트 내 문자 오프셋
   * @returns 문자 절대 사각형 (mm). 해당 문자가 없으면 null.
   */
  public getCharRect(sourceOffset: number): MmRect | null {
    if (!this._columnContents) return null;

    const baseFontSizeMm = this.fontSize;
    const columnHeightMm = this._inheritStyle?.parentHeight ?? 0;
    const effectiveColumnHeightMm = columnHeightMm > 0
      ? columnHeightMm + (this._lineHeight - baseFontSizeMm)
      : 0;

    let offset = 0;
    for (let c = 0; c < this._columnContents.length; c++) {
      const column = this._columnContents[c];
      const columnLeftMm =
        this._columnWidths.slice(0, c).reduce((a, b) => a + b, 0) +
        this._gaps.slice(0, c).reduce((a, b) => a + b, 0);

      const alignOffsetMm = this._computeAlignOffsetMm(column, effectiveColumnHeightMm, baseFontSizeMm, columnHeightMm);

      let cumulativeTopMm = 0;
      for (let li = 0; li < column.length; li++) {
        const line = column[li];
        const lineTopMm = this._data.parentAbsRect.absTop + alignOffsetMm + cumulativeTopMm;
        const lineH = line?.lineHeight ?? this._lineHeight;

        for (let p = 0; p < line.parts.length; p++) {
          const part = line.parts[p];
          if (sourceOffset >= offset && sourceOffset < offset + part.content.length) {
            const localIdx = sourceOffset - offset;
            const charOffsets = part.charOffsets;
            let charLeftInPart = 0;
            let charWidth = 0;
            if (charOffsets && charOffsets.length > 0) {
              const { stripStart, stripEnd } = this._computeStripRange(part, line, p);
              let strippedIdx: number;
              if (localIdx < stripStart) {
                strippedIdx = 0;
              } else if (localIdx >= stripEnd) {
                strippedIdx = charOffsets.length - 1;
              } else {
                strippedIdx = localIdx - stripStart;
              }
              charLeftInPart = charOffsets[strippedIdx];
              charWidth =
                strippedIdx + 1 < charOffsets.length
                  ? charOffsets[strippedIdx + 1] - charOffsets[strippedIdx]
                  : part.width - charOffsets[strippedIdx];
            }
            const left = this._data.parentAbsRect.absLeft + columnLeftMm + part.left + charLeftInPart;
            const lineMaxFs = line.maxFontSize ?? baseFontSizeMm;
            const charFs = part.inlineStyles?.[localIdx]?.fontSize ?? baseFontSizeMm;
            const top = lineTopMm + this._getCharVerticalOffset(lineMaxFs, charFs);
            return {
              left,
              right: left + charWidth,
              top,
              bottom: top + charFs,
              width: charWidth,
              height: charFs,
            };
          }
          offset += part.content.length;
        }
        cumulativeTopMm += lineH;
      }
    }

    return null;
  }

  /**
   * 파트의 leading/trailing space strip 범위를 계산한다.
   *
   * `_computeCharOffsets`와 동일한 strip 로직을 적용하여
   * `charOffsets` 인덱스를 raw content 인덱스로 변환할 때 사용한다.
   *
   * @param part - 파트 데이터
   * @param line - 파트가 속한 라인
   * @param partIdx - 라인 내 파트 인덱스
   * @returns `{ stripStart, stripEnd }` — raw content 기준 strip 범위
   */
  private _computeStripRange(part: TextPartData, line: TextLineData, partIdx: number): { stripStart: number; stripEnd: number } {
    return computeStripRange(part, line, partIdx);
  }

  /**
   * mm 좌표에 가장 가까운 source offset을 반환한다.
   *
   * @param xMm - 지면 기준 절대 X (mm)
   * @param yMm - 지면 기준 절대 Y (mm)
   * @returns `{ textOffset: number }` 또는 null
   */
  public getOffsetFromPoint(xMm: number, yMm: number): CursorPosition | null {
    const relX = xMm - this._data.parentAbsRect.absLeft;
    const relY = yMm - this._data.parentAbsRect.absTop;

    let columnIdx = -1;
    let columnLeftMm = 0;
    for (let c = 0; c < this._columnWidths.length; c++) {
      const xStart =
        this._columnWidths.slice(0, c).reduce((a, b) => a + b, 0) +
        this._gaps.slice(0, c).reduce((a, b) => a + b, 0);
      const xEnd = xStart + this._columnWidths[c];
      const isLastColumn = c === this._columnWidths.length - 1;
      if (relX >= xStart && (isLastColumn ? relX <= xEnd : relX < xEnd)) {
        columnIdx = c;
        columnLeftMm = xStart;
        break;
      }
    }
    if (columnIdx < 0) return null;

    const column = this._columnContents[columnIdx];
    if (!column) return null;

    const baseFontSizeMm = this.fontSize;
    const columnHeightMm = this._inheritStyle?.parentHeight ?? 0;
    const effectiveColumnHeightMm = columnHeightMm > 0
      ? columnHeightMm + (this._lineHeight - baseFontSizeMm)
      : 0;
    const alignOffsetMm = this._computeAlignOffsetMm(column, effectiveColumnHeightMm, baseFontSizeMm, columnHeightMm);

    let lineIdx = -1;
    let cumulativeTopMm = 0;
    for (let li = 0; li < column.length; li++) {
      const lineH = column[li]?.lineHeight ?? this._lineHeight;
      const yStart = alignOffsetMm + cumulativeTopMm;
      const yEnd = yStart + lineH;
      if (relY >= yStart && relY < yEnd) {
        lineIdx = li;
        break;
      }
      cumulativeTopMm += lineH;
    }
    if (lineIdx < 0) return null;

    const relLineX = relX - columnLeftMm;

    let globalOffset = 0;
    for (let ci = 0; ci < this._columnContents.length; ci++) {
      const col = this._columnContents[ci];
      for (let li = 0; li < col.length; li++) {
        const ln = col[li];
        const isTargetLine = ci === columnIdx && li === lineIdx;
        for (let p = 0; p < ln.parts.length; p++) {
          const part = ln.parts[p];
          if (part.content.length === 0) continue;

          if (isTargetLine) {
            const partRight = part.left + part.width;
            if (relLineX >= part.left && relLineX <= partRight) {
              const charOffsets = part.charOffsets;
              if (!charOffsets || charOffsets.length === 0) return null;

              const { stripStart } = this._computeStripRange(part, ln, p);
              const partRelX = relLineX - part.left;
              let offsetInPart = 0;
              for (let i = 0; i < charOffsets.length; i++) {
                const charRight = i + 1 < charOffsets.length ? charOffsets[i + 1] : part.width;
                const charCenter = (charOffsets[i] + charRight) / 2;
                if (partRelX < charCenter) {
                  offsetInPart = i;
                  break;
                }
                offsetInPart = i + 1;
              }

              return { textOffset: globalOffset + stripStart + offsetInPart };
            }
          }

          globalOffset += part.content.length;
        }
      }
    }

    return null;
  }

  /**
   * 특정 source offset의 커서 배치 정보를 반환한다.
   *
   * `preferLineEnd=true`이면 줄 끝(마지막 문자의 우측)에 배치한다.
   * 이 메서드는 `TextEditCoordinateMapper`의 DOM 기반 로직을 데이터 기반으로 단순화한 버전이다.
   *
   * @param sourceOffset - 소스 텍스트 내 문자 오프셋
   * @param preferLineEnd - true면 줄 마지막 문자 우측에 배치
   * @returns 커서 배치 정보 또는 null
   */
  public getCursorPlacement(sourceOffset: number, preferLineEnd = false): CursorPlacement | null {
    if (preferLineEnd) {
      const lineInfo = this._findLineBySourceOffset(sourceOffset);
      if (!lineInfo) return null;
      const lastPart = lineInfo.line.parts[lineInfo.line.parts.length - 1];
      if (!lastPart || lastPart.content.length === 0) return null;
      const lastCharOffset = lineInfo.globalOffset + lineInfo.offsetInLine + lastPart.content.length - 1;
      return { sourceOffset: lastCharOffset, atEndOfChar: true };
    }

    const rect = this.getCharRect(sourceOffset);
    if (!rect) return null;
    return { sourceOffset, atEndOfChar: false };
  }

  private _findLineBySourceOffset(sourceOffset: number): { line: TextLineData; globalOffset: number; offsetInLine: number } | null {
    if (!this._columnContents) return null;
    let globalOffset = 0;
    for (let c = 0; c < this._columnContents.length; c++) {
      const column = this._columnContents[c];
      for (let li = 0; li < column.length; li++) {
        const line = column[li];
        let lineLen = 0;
        for (const part of line.parts) lineLen += part.content.length;
        if (sourceOffset >= globalOffset && sourceOffset <= globalOffset + lineLen) {
          return { line, globalOffset, offsetInLine: sourceOffset - globalOffset };
        }
        globalOffset += lineLen;
      }
    }
    return null;
  }

  /** 상속 스타일을 설정한다. */
  set inheritStyle(inheritStyle: InheritStyle) {
    this._inheritStyle = inheritStyle;
    this._data = { ...this._data, inheritStyle };
    this._initLayoutMetrics();
  }

  /** 현재 상속 스타일 */
  get inheritStyle(): InheritStyle {
    return this._inheritStyle;
  }

  get data(): ParagraphEngineData {
    return this._data;
  }

  set data(options: ParagraphEngineData) {
    this._lineHeight = 0;

    this._data = options;
    this._resources = options.resources;
    this._inheritStyle = options.inheritStyle;
    this._textContent = options.content;
    this._plainTextCache = null;
    this._styleRuns = null;
    this._parsedContentsCache = null;
    this._prefixCache = null;
    this._paragraphStyle = options.paragraphStyle;
    this._textStyle = options.textStyle;
    this._id = options.id;
    this._zIndex = options.zIndex;

    this._effectivePsDirty = true;
    this._effectiveTsDirty = true;

    this._applyColumnGapFromData();
    this._initLayoutMetrics();
    this.resetIncrementalState();
  }

  /**
   * `data` 또는 개별 column/gap/parentBox setter가 호출한 후
   * 테이블 셀 보정을 포함한 column/gap 파생 상태(`_gaps`, `_columnWidths`)를 재계산한다.
   */
  private _applyColumnGapFromData(): void {
    const options = this._data;
    const gc = options.parentBox?.gridCalculator;
    const parentParent = options.parentBox?.parent as { isTableCellEngine?: boolean } | undefined;
    const inTableCell = !!parentParent?.isTableCellEngine && !!gc;
    const column = inTableCell ? gc.columnWidth : options.column;
    const gap = inTableCell ? gc.gaps : options.gap;

    this._gaps = (() => {
      const colCount = Array.isArray(column) ? column.length : column || 1;
      if (Array.isArray(gap)) return gap.slice(0, colCount - 1);
      return Array.from({ length: colCount - 1 }).map(() => gap as number);
    })();

    this._columnWidths = (() => {
      if (Array.isArray(column)) return column;
      const colCount = (column as number) || 1;
      return Array.from<number>({ length: colCount }).map(
        () => (this.inheritStyle.parentWidth - this._gaps.reduce((a, b) => a + b, 0)) / colCount,
      );
    })();
  }

  /**
   * 텍스트 콘텐츠를 설정한다.
   *
   * @param value - 새 텍스트 콘텐츠.
   */
  public set textContent(value: string | (string | TextInlineData)[]) {
    this._textContent = value;
    this._plainTextCache = null;
    this._styleRuns = null;
    this._parsedContentsCache = null;
    this._dirty = true;
  }

  /** 현재 텍스트 콘텐츠 */
  public get textContent(): string | (string | TextInlineData)[] {
    return this._textContent;
  }

  /**
   * 편집 위치 힌트를 설정한다. `layoutText()`가 prefix 캐시 적용 시도에 사용.
   * `textContent` setter 후, `layoutText()` 호출 전에 설정. 소비 후 자동 리셋.
   */
  public set caretHint(offset: number | undefined) {
    this._caretHint = offset;
  }

  public get caretHint(): number | undefined {
    return this._caretHint;
  }

  /** `\n`으로 분리된 라인 원본 (라인 × 인라인 런 배열) */
  public get contents(): TextInlineData[][] {
    return this._contents;
  }

  /** 텍스트 스타일 */
  public get textStyle(): TextStyle {
    return this.effectiveTextStyle;
  }

  public set textStyle(value: TextStyle) {
    if (this._textStyle === value) return;
    this._textStyle = value;
    this._effectiveTsDirty = true;
    this._dirty = true;
  }

  public get paragraphStyle(): ParagraphStyle {
    return this.effectiveParagraphStyle;
  }

  public set paragraphStyle(value: ParagraphStyle) {
    if (this._paragraphStyle === value) return;
    this._paragraphStyle = value;
    this._effectivePsDirty = true;
    this._dirty = true;
  }

  /** 컬럼 수 */
  public get columnCount(): number {
    return this._columnWidths.length;
  }

  /** 컬럼별 줄 데이터 */
  public get columnContents(): TextLineData[][] {
    return this._columnContents;
  }

  /** 컬럼 간격 배열 (mm) */
  public get gaps(): number[] {
    return this._gaps;
  }

  /**
   * 문단 기본 라인 높이 (mm). `baseFontSize × lineGap`.
   *
   * 모든 라인의 높이 하한선이다. `_lineHeight`와 동일한 값이지만
   * 외부에서는 이 getter를 통해서만 기본 라인 높이에 접근한다.
   *
   * @returns 기본 라인 높이 (mm)
   */
  public get baseLineHeight(): number {
    return this._lineHeight;
  }

  /**
   * 특정 컬럼/라인의 최대 폰트 크기를 반환한다.
   *
   * @param columnIndex - 컬럼 인덱스
   * @param lineIndex - 라인 인덱스
   * @returns 라인의 최대 폰트 크기 (mm). 라인 데이터가 없으면 `fontSize`
   */
  public getLineMaxFontSize(columnIndex: number, lineIndex: number): number {
    return this._columnContents[columnIndex]?.[lineIndex]?.maxFontSize ?? this.fontSize;
  }

  /**
   * 현재 적용된 폰트 크기 (mm).
   * `textStyle.fontSize` → `inheritStyle.fontSize` → `DEFAULT_FONT_SIZE` 순서로 해결.
   *
   * 마지막 라인은 `lineHeight`가 아닌 `fontSize`만큼만 높이를 차지하는 규칙
   * (`BoxEngine.absHeight`의 `lineHeight * height - (lineHeight - fontSize)` 공식)과
   * 일관되게 참조하기 위해 사용한다.
   *
   * @returns 폰트 크기 (mm)
   */
  public get fontSize(): number {
    return this.effectiveTextStyle.fontSize!;
  }

  /** 오버플로우된 문자 수 */
  public get overflow(): number {
    return this._overflow;
  }

  /**
   * 오버플로우 발생 여부.
   *
   * `overflow > 0`와 동일하지만, 의미를 명확히 하기 위해 boolean 게터를 제공한다.
   *
   * @returns 오버플로우가 발생했으면 `true`
   */
  public get hasOverflow(): boolean {
    return this._overflow > 0;
  }

  /**
   * 입력된 텍스트의 총 문자 수.
   *
   * `textContent`가 문자열이면 `string.length`, 배열이면 각 런의 `content.length` 합산.
   * `TextInlineData` 원소는 `content` 필드 길이를 사용하고, 문자열 원소는 그 자체의 길이를 사용한다.
   * `\n`은 `_parseContents`가 라인 분리에만 사용하므로 총 문자 수에는 포함되지 않는다.
   *
   * @returns 총 문자 수
   * @example
   * const model = ParagraphEngine.create({ content: "abc\ndef", ... });
   * model.layoutStructure(); model.layoutText();
   * model.totalChars; // 6 (개행 제외)
   */
  public get totalChars(): number {
    if (typeof this._textContent === "string") {
      return this._textContent.split("\n").reduce((sum, line) => sum + line.length, 0);
    }
    return this._textContent.reduce((sum, run) => {
      const content = typeof run === "string" ? run : run.content;
      return sum + content.split("\n").reduce((s, line) => s + line.length, 0);
    }, 0);
  }

  /**
   * 컬럼 영역 내에 실제로 보이는(visible) 문자 수.
   *
   * `_layoutTextIntoColumns`가 산출한 `columnContents`에서 컬럼 유효 높이를
   * 초과하지 않는(visible) 라인의 part content 길이를 합산한다.
   * 오버플로우로 `display: none` 처리된 라인의 문자는 제외된다.
   *
   * visible 판정 기준은 `_createLineWithParts`의 `isOverflow`와 동일하게
   * `effectiveColumnHeight = parentHeight + (lineHeight - fontSize)`를 사용한다.
   * 단, 마지막 라인은 `lineHeight`가 아닌 `fontSize`만큼만 높이를 차지하는 규칙을 반영하며,
   * 한 번 overflow가 발생하면 이후 라인은 모두 overflow로 처리한다.
   *
   * @returns visible 문자 수
   * @example
   * const model = ParagraphEngine.create({ content: "...긴 텍스트...", ... });
   * model.layoutStructure(); model.layoutText();
   * console.log(model.visibleChars); // 예: 1800
   * console.log(model.totalChars - model.visibleChars); // 오버플로우 문자 수
   */
  public get visibleChars(): number {
    const parentHeight = this._inheritStyle?.parentHeight ?? 0;
    if (parentHeight <= 0) {
      return this.totalChars;
    }

    const effectiveColumnHeight = parentHeight + (this._lineHeight - this.fontSize);
    let visible = 0;

    for (let c = 0; c < this._columnContents.length; c++) {
      const lines = this._columnContents[c] || [];
      let accumulatedHeightMm = 0;
      let hasOverflowed = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineHeightMm = line?.lineHeight ?? this._lineHeight;

        const isOverflow = hasOverflowed
          || accumulatedHeightMm + lineHeightMm > effectiveColumnHeight + 1e-6;
        if (isOverflow) {
          hasOverflowed = true;
          continue;
        }
        accumulatedHeightMm += lineHeightMm;
        for (const part of line.parts) {
          visible += part.content.length;
        }
      }
    }
    return visible;
  }

  /** 장평 비율 */
  public get widthRatio(): number {
    return this.effectiveTextStyle.widthRatio!;
  }

  public get spaceRatio(): number {
    return this.effectiveTextStyle.spaceRatio!;
  }

  public get indent(): number {
    return this.effectiveTextStyle.indent!;
  }

  /** 컬럼 너비 배열 (mm) */
  public get columnWidths(): number[] {
    return this._columnWidths;
  }

  /** 컬럼 정의 (number=동일 너비 N개, number[]=명시적 너비). layout() 시 _columnWidths/_gaps 재계산. */
  public get column(): number | number[] {
    return this._data.column;
  }

  public set column(value: number | number[]) {
    if (this._data.column === value) return;
    this._data = { ...this._data, column: value };
    this._applyColumnGapFromData();
    this._initLayoutMetrics();
    this._dirty = true;
  }

  /** 컬럼 간격 정의. layout() 시 _gaps 재계산. */
  public get gap(): number | number[] {
    return this._data.gap;
  }

  public set gap(value: number | number[]) {
    if (this._data.gap === value) return;
    this._data = { ...this._data, gap: value };
    this._applyColumnGapFromData();
    this._initLayoutMetrics();
    this._dirty = true;
  }

  /**
   * 단락의 단 설정(column/gap)을 좌우 반전한다.
   *
   * `horizontal`/`both` 축일 때 `column`/`gap`이 `number[]`인 경우 배열을 역순으로 만든다.
   * `number` (균등)인 경우 대칭이므로 그대로 유지한다.
   * `vertical` 축은 단락에 영향을 주지 않는다.
   *
   * @param axis - 반전 축
   */
  public flipLayout(axis: 'horizontal' | 'vertical' | 'both'): void {
    if (axis !== 'horizontal' && axis !== 'both') return;
    if (Array.isArray(this._data.column)) {
      this._data = { ...this._data, column: [...this._data.column].reverse() };
    }
    if (Array.isArray(this._data.gap)) {
      this._data = { ...this._data, gap: [...this._data.gap].reverse() };
    }
    this._applyColumnGapFromData();
    this._initLayoutMetrics();
  }

  /** 개별 setter로 인해 커밋되지 않은 변경이 있는지 여부. */
  public get dirty(): boolean {
    return this._dirty;
  }

  /** 이전 레이아웃의 전체 줄 수 */
  public get previousLineCount(): number {
    return this._previousLineCount;
  }

  /** 이전 레이아웃의 오버플로우 문자 수 */
  public get previousOverflow(): number {
    return this._previousOverflow;
  }

  /** 확대/축소 비율 (현재는 1 고정) */
  public get scale(): number {
    return 1;
  }

  /** 확대/축소 비율을 설정한다. (현재는 무효) */
  public set scale(v: number) {
    void v;
  }

  /**
   * 이 문단의 오버랩 처리 모드.
   * 'box'이면 다른 문단이 이 박스를 오버랩 요소로 처리한다.
   */
  public get overlapMode(): ParagraphOverlapMode {
    return this._overlapMode;
  }

  public set overlapMode(v: ParagraphOverlapMode) {
    this._overlapMode = v;
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

  /**
   * 내부 소비용: 상속값 + 주입값 + 기본값을 모두 병합한 문단 스타일.
   * 메모이제이션: _paragraphStyle/_inheritStyle 변경 시 dirty 플래그로 무효화.
   * @returns 병합된 ParagraphStyle
   */
  get effectiveParagraphStyle(): ParagraphStyle {
    if (this._effectivePsCache !== null && !this._effectivePsDirty) {
      return this._effectivePsCache;
    }
    this._effectivePsCache = { ...DEFAULT_PARAGRAPH_STYLE, ...this._inheritStyle, ...this._paragraphStyle };
    this._effectivePsDirty = false;
    return this._effectivePsCache;
  }

  /**
   * 내부 소비용: 상속값 + 주입값 + 기본값을 모두 병합한 텍스트 스타일.
   * 메모이제이션: _textStyle/_inheritStyle 변경 시 dirty 플래그로 무효화.
   * @returns 병합된 TextStyle
   */
  get effectiveTextStyle(): TextStyle {
    if (this._effectiveTsCache !== null && !this._effectiveTsDirty) {
      return this._effectiveTsCache;
    }
    this._effectiveTsCache = { ...DEFAULT_TEXT_STYLE, ...this._inheritStyle, ...this._textStyle };
    this._effectiveTsDirty = false;
    return this._effectiveTsCache;
  }

  /**
   * `_textContent`에서 소스 런 인덱스를 구축한다.
   *
   * 각 아이템(string 또는 `TextInlineData`)을 평문 오프셋 공간의 연속된 런으로
   * 펼친다. 오프셋 공간은 `\n`을 포함하며 textarea/`RunMap`과 정확히 일치한다.
   * `layoutText()`와 무관하므로 레이아웃 전에도 조회 가능하다.
   *
   * @returns 런 인덱스 (정렬됨, 비중첩, 연속)
   */
  private _buildStyleRuns(): { start: number; end: number; style: TextInlineStyle | undefined }[] {
    const content = this._textContent;
    if (typeof content === "string") {
      return content.length === 0 ? [] : [{ start: 0, end: content.length, style: undefined }];
    }
    const runs: { start: number; end: number; style: TextInlineStyle | undefined }[] = [];
    let offset = 0;
    for (const item of content) {
      const len = typeof item === "string" ? item.length : item.content.length;
      const style = typeof item === "string" ? undefined : item.textInlineStyle;
      runs.push({ start: offset, end: offset + len, style });
      offset += len;
    }
    return runs;
  }

  /**
   * 소스 오프셋이 속한 런의 주입된 인라인 스타일(raw)을 반환한다.
   *
   * 오프셋 공간은 `\n`을 포함한 평문 기준이며 textarea/`RunMap`과 동일하다.
   * 경계 의미: 반개구간 `[start, end)` — 런 경계 오프셋은 다음 런의 스타일을
   * 반환한다. 텍스트 끝(`offset === 전체 길이`)이면 마지막 런의 스타일을
   * 반환한다(타이핑 연속성). 빈 단락이거나 범위 밖이면 `undefined`.
   *
   * `layoutText()` 의존 없음 — 엔진이 Node.js 단독 모드이거나 편집 중
   * pre-layout 상태에서도 동작한다.
   *
   * @param sourceOffset - 평문 오프셋 (`\n` 포함)
   * @returns 해당 위치의 인라인 스타일. `undefined`면 문단 기본 스타일
   *
   * @example
   * ```ts
   * // content: ["ab", { content: "굵게", textInlineStyle: { fontWeight: 700 } }, "cd"]
   * engine.getInlineStyleAt(0);  // → undefined (plain "ab")
   * engine.getInlineStyleAt(2);  // → { fontWeight: 700 } (bold run 시작)
   * engine.getInlineStyleAt(4);  // → undefined (plain "cd" 시작)
   * engine.getInlineStyleAt(6);  // → undefined (텍스트 끝, 마지막 런이 plain)
   * ```
   */
  public getInlineStyleAt(sourceOffset: number): TextInlineStyle | undefined {
    const runs = this._styleRuns ?? (this._styleRuns = this._buildStyleRuns());
    if (runs.length === 0) return undefined;
    let lo = 0, hi = runs.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (runs[mid].start <= sourceOffset) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (found >= 0 && sourceOffset < runs[found].end) return runs[found].style;
    const last = runs[runs.length - 1];
    if (found === runs.length - 1 && sourceOffset === last.end) return last.style;
    return undefined;
  }

  /**
   * 소스 오프셋의 유효(effective) 텍스트 스타일을 반환한다.
   *
   * `effectiveTextStyle`(기본값 + 상속값 + 문단 주입값 병합)에 해당 위치 런의
   * 인라인 스타일 5개 필드(`fontFamily`, `fontSize`, `fontWeight`,
   * `fontStyle`, `color`)를 오버라이드한다. 런 스타일의 `undefined` 필드는
   * 무시한다 (명시적 `undefined` 키가 기본값을 덮어쓰지 않도록 조건부 spread).
   *
   * @param sourceOffset - 평문 오프셋 (`\n` 포함)
   * @returns 해당 위치의 유효 텍스트 스타일 (모든 필드 materialized)
   *
   * @example
   * ```ts
   * // 문단 기본: fontSize 4, color 'black'. 런: { fontWeight: 700 }
   * engine.getEffectiveStyleAt(2);
   * // → { color: 'black', fontFamily: '...', fontWeight: 700, fontStyle: 'normal', fontSize: 4, ... }
   * ```
   */
  public getEffectiveStyleAt(sourceOffset: number): TextStyle {
    const inline = this.getInlineStyleAt(sourceOffset);
    const base = this.effectiveTextStyle;
    if (!inline) return base;
    return {
      ...base,
      ...(inline.fontFamily !== undefined && { fontFamily: inline.fontFamily }),
      ...(inline.fontSize !== undefined && { fontSize: inline.fontSize }),
      ...(inline.fontWeight !== undefined && { fontWeight: inline.fontWeight }),
      ...(inline.fontStyle !== undefined && { fontStyle: inline.fontStyle }),
      ...(inline.color !== undefined && { color: inline.color }),
    };
  }

  /**
   * 범위 내 모든 위치의 유효 스타일이 일치하는 필드만 반환한다.
   *
   * 인라인 오버라이드 가능 필드(`color`, `fontFamily`, `fontWeight`,
   * `fontStyle`, `fontSize`)는 범위 내 런들을 순회하며 공통값만 유지한다.
   * 단락 수준 필드(`letterSpacing`, `widthRatio`, `spaceRatio`, `indent`)는
   * 런으로 오버라이드 불가능하므로 항상 `effectiveTextStyle`에서 가져온다.
   *
   * 런 단위로 비교하므로 O(범위 내 런 수)이다 — 문자 수에 비례하지 않는다.
   *
   * @param startOffset - 범위 시작 오프셋 (포함)
   * @param endOffset - 범위 끝 오프셋 (미포함)
   * @returns 공통 필드만 포함된 텍스트 스타일. 빈 범위면 전체 effective 스타일
   *
   * @example
   * ```ts
   * // "ab굵게cd"에서 [2, 6) 선택 (bold run + plain run 걸침)
   * engine.getCommonStyleInRange(2, 6);
   * // → { letterSpacing, widthRatio, spaceRatio, indent, fontSize: 4, ... }
   * //    fontWeight는 bold(700) vs plain(400) 상이 → 제외
   * ```
   */
  public getCommonStyleInRange(startOffset: number, endOffset: number): TextStyle {
    const base = this.effectiveTextStyle;
    if (endOffset <= startOffset) return { ...base };

    const INLINE_FIELDS = ["color", "fontFamily", "fontWeight", "fontStyle", "fontSize"] as const;
    const runs = this._styleRuns ?? (this._styleRuns = this._buildStyleRuns());

    let first = true;
    const common: Partial<Record<string, string | number | undefined>> = {};

    for (const run of runs) {
      if (run.end <= startOffset) continue;
      if (run.start >= endOffset) break;

      const eff = this.getEffectiveStyleAt(Math.max(run.start, startOffset));
      for (const field of INLINE_FIELDS) {
        if (first) {
          common[field] = eff[field];
        } else if (common[field] !== undefined && common[field] !== eff[field]) {
          delete common[field];
        }
      }
      first = false;
    }

    if (first) return { ...base };

    return {
      ...common,
      letterSpacing: base.letterSpacing,
      widthRatio: base.widthRatio,
      spaceRatio: base.spaceRatio,
      indent: base.indent,
    } as TextStyle;
  }

  get extractData(): ParagraphData {
    if (this._dirty) throw createDirtyError('ParagraphEngine');
    const paragraphStyle: Record<string, unknown> = {};
    for (const key of Object.keys(this._paragraphStyle)) {
      if (this._paragraphStyle[key as keyof ParagraphStyle] !== undefined) {
        paragraphStyle[key] = this._paragraphStyle[key as keyof ParagraphStyle];
      }
    }
    const textStyle: Record<string, unknown> = {};
    for (const key of Object.keys(this._textStyle)) {
      if (this._textStyle[key as keyof TextStyle] !== undefined) {
        textStyle[key] = this._textStyle[key as keyof TextStyle];
      }
    }
    const content = this._textContent;
    return {
      type: 'paragraph',
      id: this._id,
      content,
      column: this._columnWidths,
      gap: this._gaps,
      paragraphStyle: Object.keys(paragraphStyle).length > 0 ? paragraphStyle as ParagraphStyle : undefined,
      textStyle: Object.keys(textStyle).length > 0 ? textStyle as TextStyle : undefined,
      overlapMode: this._overlapMode ?? 'box',
      zIndex: this._zIndex ?? 0,
    };
  }

  /**
   * 이 문단의 printPostData를 생성한다.
   * columnContents를 순회하여 글자별 위치·폰트·색상을 픽셀 좌표로 변환한다.
   * DOM 의존성 없이 엔진 데이터만으로 생성한다.
   */
  get printPostData(): PrintPostData[] {
    if (this._dirty) throw createDirtyError('ParagraphEngine');
    const cr = this._resources.colorRegistry;
    const fl = this._resources.fontLoader;
    const parentAbsRect = this._data.parentAbsRect;
    return buildParagraphPrintPostData(
      this, cr, fl,
      this.extractData,
      parentAbsRect.absLeft, parentAbsRect.absTop,
      this._inheritStyle?.parentWidth ?? 0,
      this._inheritStyle?.parentHeight ?? 0,
    );
  }
}

/**
 * ParagraphEngine 내부 전용 LRU 캐시.
 * `@/utils` DOM 의존성을 피하기 위해 엔진 파일에 최소 구현.
 *
 * @template K - 키 타입
 * @template V - 값 타입
 */
class _LRU<K, V> {
  private readonly _map: Map<K, V> = new Map();
  private readonly _capacity: number;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new RangeError("LRU capacity must be a positive integer");
    }
    this._capacity = capacity;
  }

  get(key: K): V | undefined {
    if (!this._map.has(key)) return undefined;
    const value = this._map.get(key)!;
    this._map.delete(key);
    this._map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._capacity) {
      const oldest = this._map.keys().next();
      if (!oldest.done) {
        this._map.delete(oldest.value);
      }
    }
    this._map.set(key, value);
  }
}

// ─────────────────────────────────────────────────────────────
// printPostData — DOM 없이 columnContents 기반으로 생성
// ─────────────────────────────────────────────────────────────

/**
 * 두 인라인 스타일이 필드 단위로 동일한지 비교한다.
 * `undefined`와 빈 객체는 모두 "스타일 없음"으로 동일 취급한다.
 */
function inlineStyleEqual(a: TextInlineStyle | undefined, b: TextInlineStyle | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) {
    return (a === undefined || Object.keys(a).length === 0) && (b === undefined || Object.keys(b).length === 0);
  }
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.color === b.color
  );
}

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
function computeStripRange(part: TextPartData, line: TextLineData, partIdx: number): { stripStart: number; stripEnd: number } {
  const content = part.content;
  const isFirst = partIdx === 0;
  const isLast = partIdx === line.parts.length - 1;
  const firstOfLine = line.firstOfBlock === true;
  const endOfLine = line.endOfBlock === true;
  let stripStart = 0;
  let stripEnd = content.length;
  if (isFirst && !firstOfLine) {
    while (stripStart < stripEnd && content[stripStart] === " ") stripStart++;
  }
  if (isLast && !endOfLine) {
    while (stripEnd > stripStart && content[stripEnd - 1] === " ") stripEnd--;
  }
  return { stripStart, stripEnd };
}

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

          const inlineStyle = inlineStyles?.[j];

          const k = j - stripStart;
          const charOffsetMm = charOffsets !== undefined && k < charOffsets.length
            ? (charOffsets[k] ?? 0)
            : 0;
          const charXMm = colLeftMm + partAbsLeftMm + charOffsetMm;

          const { swidth } = engine.getCharWidths(char, inlineStyle);
          const charWidthMm = swidth;

          const widthRatio = engine.widthRatio;
          const letterSpacing = engine.effectiveTextStyle.letterSpacing!;
          const spaceRatio = engine.spaceRatio;

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
          const colorName = inlineStyle?.color
            ?? textStyle?.color
            ?? inheritStyle?.color;
          const cmyk = colorName !== undefined
            ? colorRegistry.get(colorName)
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
          });
        }
        partStartMm += part.width;
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
  }];
}
