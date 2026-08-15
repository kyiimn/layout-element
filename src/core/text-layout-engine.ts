import { DEFAULT_FONT_SIZE, DEFAULT_INDENT, DEFAULT_LETTER_SPACING, DEFAULT_LINE_GAP, DEFAULT_SPACE_RATIO, DEFAULT_TEXT_ALIGN, DEFAULT_VERTICAL_ALIGN, DEFAULT_WIDTH_RATIO, isLineEndForbidden, isLineStartForbidden } from "@/constants";
import type { LayoutBoxElement, LayoutParagraphElement } from "@/components";
import {
  InheritStyle,
  TextBlockData,
  TextBlockStyle,
  ParagraphStyle,
  TextStyle,
  TextPartData,
  TextLineData,
  OverlapParts
} from "@/types";
import { getOverlapSizeMm, mergeOverlapParts, type MmRect, LRU } from "@/utils";
import { FontLoader } from "@/resource/font-loader";
import { ColorRegistry } from "@/resource/color-registry";


type TextLayoutEngineOptions = {
  content: string | (string | TextBlockData)[];
  column: number | number[];
  gap: number | number[];
  paragraphStyle: ParagraphStyle;
  textStyle: TextStyle;

  inheritStyle: InheritStyle;
  paragraphEl: LayoutParagraphElement;
  rootNode: Node;
};

type FreeRegion = { start: number; end: number };

/**
 * 텍스트 래핑과 다중 컬럼 렌더링을 수행하는 모델.
 *
 * `ParagraphData`를 받아 텍스트를 래핑하여 `TextLineData[][]`(컬럼별 줄 데이터)로 변환한다.
 * 정적 팩토리 메서드 `create()`로만 인스턴스를 생성한다.
 *
 * 주요 기능:
 * - 텍스트 래핑 (`layoutStructure()` + `layoutText()`): 문자 단위로 줄바꿈 처리
 * - 오버랩 회피: 이미지 등 다른 요소와 겹치는 영역 계산
 * - 스타일 적용: `genLineStyle()`, `genPartStyle()`, `genCharStyle()`으로 CSS 스타일 생성
 *
 * 렌더링 파이프라인:
 * 1. `_initLayoutMetrics()` - fontSize, lineGap, lineHeight 초기화
 * 2. `layoutStructure()` - 컬럼 폭/ppm 계산, `layoutText()` - 텍스트 래핑 수행
 * 3. `LayoutColumnElement`가 `columnContents`를 소비하여 렌더링
 */
export class TextLayoutEngine {
  private _columnWidths: number[] = [];
  private _inheritStyle: InheritStyle = undefined!;

  private _textContent: string | (string | TextBlockData)[] = "";

  private _textStyle: TextStyle = {};
  private _paragraphStyle: ParagraphStyle = {};

  private _columnContents: TextLineData[][] = [];
  private _contents: TextBlockData[] = [];
  private _gaps: number[] = [];
  private _overflow: number = 0;

  private _previousLineCount: number = -1;
  private _previousOverflow: number = -1;

  /** 성능 캐시: 문자별 외부 span 스타일. 키 `${char}|${widthRatio}`. LRU (5000). */
  private _charOuterStyleCache: LRU<string, Partial<CSSStyleDeclaration>> = new LRU(5000);
  /** 성능 캐시: 내부 span 스타일. 장평 변경 시 갱신. */
  private _charInnerStyle: Partial<CSSStyleDeclaration> = {};
  private _charInnerStyleKey: string = '';
  /** 성능 캐시: 문자 폭(mm). 키 `${char}|${fontName}|${fontSize}`. LRU (5000). */
  private _charWidthCache: LRU<string, number> = new LRU(5000);

  private _lineHeight: number = 0;

  private _paragraphElement: LayoutParagraphElement;
  private _rootNode: Node;

  /** 성능 캐시: 오버랩 요소의 mm rect 캐시. 렌더링 사이클당 한 번 구성 후 재사용하여 강제 리플로우를 최소화한다. */
  private _overlayRectsMm: Map<LayoutBoxElement, MmRect> | null = null;

  /** Skeleton 캐시: 입력 매개변수 해시가 동일하면 _layoutTextIntoColumns() 결과를 재사용. (현재 비활성화) */
  private _layoutCache: { hash: string; columnContents: TextLineData[][]; overflow: number } | null = null;

  /**
   * 정적 팩토리 메서드. `new` 직접 사용 금지.
   */
  public static create(options: TextLayoutEngineOptions) {
    return new this(options);
  }

  private constructor(options: TextLayoutEngineOptions) {
    this._paragraphElement = options.paragraphEl;
    this._rootNode = options.rootNode;

    this.data = options;
  }

  /**
   * 레이아웃 메트릭 초기화. `fontSize`, `lineGap`, `lineHeight`를 계산하고
   * `_columnContents`와 `_overflow`를 리셋한다.
   * `data` 세터와 `inheritStyle` 세터에서 호출된다.
   */
  private _initLayoutMetrics() {
    const fontSize = this.textStyle?.fontSize ?? this.inheritStyle?.fontSize ?? DEFAULT_FONT_SIZE;
    const lineGap = this.paragraphStyle?.lineGap ?? this.inheritStyle?.lineGap ?? DEFAULT_LINE_GAP;

    this._columnContents = [];
    this._overflow = 0;

    this._lineHeight = 0;
    this._lineHeight = fontSize * lineGap;
  }

  /**
   * 오버랩 영역의 여집합으로부터 텍스트가 배치될 수 있는 자유 영역을 계산한다.
   * 오버랩이 없으면 `[{ start: 0, end: lineWidth }]`를 반환한다.
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
   * 계산하므로 ppm 변환을 거치지 않아 환경(브라우저 엔진/OS/DPI)에 완전히 무관하다.
   * `Math.round()`를 사용하지 않아 부동소수점 정밀도를 보존하며,
   * 이로 인해 서로 다른 scale에서 동일한 줄바꿈 결과를 보장한다.
   *
   * **장평(`widthRatio`) 처리**: 폰트 메트릭에서 읽은 `glyph.advanceWidth`가
   * 정확한 원본 폭이므로, 호출자가 `rawWidth × widthRatio`로 모든 글자에 정확히
   * 장평을 반영한다. 상한 클램프가 없으므로 좁은 글자도 정확히 축소된다.
   *
   * **최소 폭(`minWidthMm`)**: 결함 글리프(0폭/비정상적 narrow) 방어.
   * `spaceRatio × fontSize`를 바닥값으로 사용하며, 폰트 메트릭 조회 성공 시
   * `Math.max(fontWidth, minWidthMm)`로 적용된다.
   *
   * @param char - 측정할 문자
   * @param textBlockStyle - 블록 레벨 스타일 오버라이드
   * @returns 문자 폭 (mm, 장평 미적용). scale 및 컬럼에 무관.
   *
   * @example
   * // 장평 0.8, 글자 폭 4mm → 4 × 0.8 = 3.2mm
   * // 장평 0.8, 글자 폭 3mm → 3 × 0.8 = 2.4mm
   */
  private _charWidthMm(char: string, textBlockStyle?: TextBlockStyle): number {
    const fontSize = textBlockStyle?.fontSize ?? this._textStyle?.fontSize ?? this._inheritStyle?.fontSize ?? DEFAULT_FONT_SIZE;
    const minWidthMm = this.spaceRatio * fontSize;

    if (char === ' ') {
      return minWidthMm;
    }

    const fontName = textBlockStyle?.fontFamily ?? '';
    const cacheKey = `${char}|${fontName}|${fontSize}`;
    const cached = this._charWidthCache.get(cacheKey);
    if (cached !== undefined) {
      return Math.max(cached, minWidthMm);
    }

    const fontWidth = this._charWidthMmFromFont(char, textBlockStyle, fontSize);
    if (fontWidth !== null) {
      this._charWidthCache.set(cacheKey, fontWidth);
      return Math.max(fontWidth, minWidthMm);
    }

    return minWidthMm;
  }

  /**
   * 폰트 메트릭 기반 문자 폭 측정.
   *
   * `FontLoader`에서 파싱된 폰트 객체에서 `charToGlyph(char)`로
   * 글리프를 조회하고, `glyph.advanceWidth / unitsPerEm * fontSize`로 mm 폭을
   * 계산한다. **장평(`widthRatio`) 곱셈은 호출자에서 적용**하므로 여기서는
   * 원본 폰트 메트릭 기반 값만 반환한다.
   *
   * @param char - 측정할 문자
   * @param textBlockStyle - 블록 레벨 스타일 오버라이드
   * @param fontSize - 폰트 크기 (mm 단위)
   * @returns 문자 폭 (mm, 장평 미적용). 폰트/글리프 조회 실패 시 `null`
   */
  private _charWidthMmFromFont(char: string, textBlockStyle: TextBlockStyle | undefined, fontSize: number): number | null {
    const fontLoader = FontLoader.getInstance();
    const fontName = textBlockStyle?.fontFamily;
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
    if (columnContent.length > 0 && columnContent[columnContent.length - 1].parts.every(p => p.content.length === 0)) {
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
   * 교정 방식:
   * - 행두 금지 위반 (아래 줄의 첫 글자가 금지): 위 줄의 마지막 글자를
   *   아래 줄의 앞으로 옮겨, 위 줄의 끝이 더 이상 금지 대상과 붙지 않게 한다.
   *   단, 위 줄의 마지막 글자 자체가 행말 금지 문자인 경우는 이동하지 않는다
   *   (두 금칙이 충돌하면 안전한 쪽을 택한다 — 이동하지 않음).
   * - 행말 금지 위반 (위 줄의 마지막 글자가 금지): 아래 줄의 첫 글자를
   *   위 줄의 뒤로 옮겨, 아래 줄의 시작이 더 이상 금지 대상과 붙지 않게 한다.
   *   단, 아래 줄의 첫 글자 자체가 행두 금지 문자인 경우는 이동하지 않는다.
   *
   * COVER 라인(`parts: []`)과 빈 라인은 스킵한다. 단일 패스로 순회하며,
   * 이동으로 인해 새로 발생하는 위반은 추가 패스 없이 허용한다
   * (시각적으로 1글자 어긋남이 전체 깨짐보다 낫다).
   *
   * @example
   * // "안녕" / "하세요." → 위 줄 끝 '녕'은 OK, 아래 줄 시작 '.' 은 행두 금지
   * // → 위 줄의 '녕'을 아래 줄 앞으로 이동: "안" / "녕하세요."
   * // 위 줄 끝 '안'은 행말 금지가 아니므로 OK.
   *
   * @throws 이 메서드는 예외를 던지지 않는다. 모든 경계 검사는 컨텐츠 길이로 가드한다.
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
            curLastPart.content.push(nextFirstChar);
            nextFirstPart.content.shift();
          }
          continue;
        }

        if (isLineEndForbidden(curLastChar)) {
          if (!isLineStartForbidden(nextFirstChar)) {
            nextFirstPart.content.unshift(curLastChar);
            curLastPart.content.pop();
          }
        }
      }
    }
  }

  /**
   * 오버랩 요소(이미지 등)와의 겹침 계산.
   * 성능 최적화: `_overlayRectsMm` 캐시를 사용하여 렌더링 사이클당
   * 오버랩 요소의 mm rect를 한 번 구성 후 재사용한다.
   * COVER면 라인 전체가 덮인 것이고, PART면 일부만 덮인 것이다.
   */
  private _detectOverlapWithCache(lineRectMm: MmRect): { cover: boolean; overlapParts: OverlapParts[] } {
    const overlapEls = this._paragraphElement.overlayElements;
    let cover = false;
    let parts: OverlapParts[] = [];

    if (this._overlayRectsMm === null) {
      this._overlayRectsMm = new Map();
      for (const el of overlapEls) {
        this._overlayRectsMm.set(el, {
          left: el.absLeft,
          right: el.absLeft + el.absWidth,
          top: el.absTop,
          bottom: el.absTop + el.absHeight,
          width: el.absWidth,
          height: el.absHeight,
        });
      }
    }

    for (const el of overlapEls) {
      const elRect = this._overlayRectsMm.get(el);
      if (!elRect) continue;

      if (lineRectMm.bottom <= elRect.top || lineRectMm.top >= elRect.bottom) {
        continue;
      }

      const type = getOverlapSizeMm(lineRectMm, el);
      if (type.direction === 'COVERS') cover = true;
      if (type.direction === 'PART') parts = parts.concat(type.parts);
    }

    return { cover, overlapParts: mergeOverlapParts(parts) };
  }

  /**
   * 라인의 mm 좌표를 계산하고 오버랩을 감지하여 파트를 구성한다.
   * `_detectOverlapWithCache()`로 겹침을 감지하고, `_computeFreeRegions()`로
   * 자유 영역을 계산한 뒤, 각 자유 영역에 대한 TextPartData를 생성한다.
   *
   * DOM은 생성하지 않는다. 모든 측정값과 산술은 **mm 단위**로 수행되며,
   * 라인 너비는 `_columnWidths[columnIndex]`를 직접 사용하여 브라우저 렌더링
   * 정밀도 오차를 원천 제거한다.
   *
   * @param textBlockStyle - 이 라인에 적용할 블록 스타일
   * @param columnIndex - 현재 컬럼 인덱스 (`_columnWidths` 조회용)
   * @param lineIndexInColumn - 컬럼 내에서 이 라인의 0-based 인덱스
   * @param isFirstInColumn - 첫 번째 라인 여부 (firstOfText 플래그 설정용)
   * @param isFirstOfBlock - 블록의 첫 라인 여부 (firstOfBlock 플래그 설정용)
   * @returns cover=true면 라인 전체가 덮임, overflow=true면 컬럼 높이 초과.
   *          `partWidths`는 mm 단위.
   */
  private _createLineWithParts(
    textBlockStyle: TextBlockStyle | undefined,
    columnIndex: number,
    lineIndexInColumn: number,
    isFirstInColumn: boolean,
    isFirstOfBlock: boolean,
  ): {
    cover: boolean;
    overflow: boolean;
    partWidths: number[];
    lineData: TextLineData;
  } {
    const columnLeftMm = this._columnWidths.slice(0, columnIndex).reduce((a, b) => a + b, 0)
      + this._gaps.slice(0, columnIndex).reduce((a, b) => a + b, 0);
    const lineLeftMm = this._paragraphElement.absLeft + columnLeftMm;
    const lineTopMm = this._paragraphElement.absTop + lineIndexInColumn * this._lineHeight;
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
    const isOverflow = (lineIndexInColumn + 1) * this._lineHeight > parentHeight + 1e-6;

    if (cover) {
      const lineData: TextLineData = {
        firstOfText: isFirstInColumn,
        firstOfBlock: isFirstOfBlock,
        parts: [],
        textBlockStyle,
      };
      return { cover: true, overflow: isOverflow, partWidths: [], lineData };
    }

    const freeRegions = this._computeFreeRegions(lineWidthMm, overlapParts);

    const fontSize = textBlockStyle?.fontSize ?? this._textStyle?.fontSize ?? this._inheritStyle?.fontSize ?? DEFAULT_FONT_SIZE;
    const indentMm = isFirstOfBlock ? fontSize * this.indent : 0;
    const adjustedFreeRegions = indentMm > 0
      ? freeRegions.map((r, i) => i === 0 ? { start: r.start + indentMm, end: r.end } : r)
      : freeRegions;

    // 좁은 자유 영역 필터링: 글자 하나가 들어갈 수 없는 좁은 자유 영역은 제외한다.
    // 이 필터링이 없으면 무한 루프 가드가 좁은 틈에 글자를 강제 배치하여
    // 파트 폭을 넘어 렌더링되는 현상이 발생한다.
    // 기준: 가장 넓은 글자 폭 상한(widthRatio × fontSize) + letterSpacing.
    const letterSpacingEm = this._textStyle?.letterSpacing ?? this._inheritStyle?.letterSpacing ?? DEFAULT_LETTER_SPACING;
    const minCharWidthMm = this.widthRatio * fontSize + letterSpacingEm * fontSize;
    const usableRegions = adjustedFreeRegions.filter(r => (r.end - r.start) >= minCharWidthMm);

    // 자유 영역이 없으면 라인 전체가 오버랩으로 덮인 것.
    // 호출자에서는 이미지가 영역을 덮든 COVER든 freeRegions가 없든 상관없이
    // 텍스트를 배치할 공간이 없다는 점에서 동일하게 처리된다.
    if (usableRegions.length === 0) {
      const lineData: TextLineData = {
        firstOfText: isFirstInColumn,
        firstOfBlock: isFirstOfBlock,
        parts: [],
        textBlockStyle,
      };
      return { cover: true, overflow: isOverflow, partWidths: [], lineData };
    }

    const parts: TextPartData[] = usableRegions.map((region, i) => ({
      content: [],
      left: i === 0 ? region.start : (region.start - usableRegions[i - 1].end),
      width: region.end - region.start,
    }));

    const partWidths = usableRegions.map(r => r.end - r.start);

    const lineData: TextLineData = {
      firstOfText: isFirstInColumn,
      firstOfBlock: isFirstOfBlock,
      parts,
      textBlockStyle,
    };

    return { cover: false, overflow: isOverflow, partWidths, lineData };
  }

  /**
   * 구조 측정. `_columnWidths`, `_gaps`, `_lineHeight`는 `data` 세터에서
   * 이미 초기화되어 있으므로 여기서는 컬럼 수 검사만 수행한다.
   * 내부 전용. `layoutStructure()`에서만 호출된다.
   */
  private _initStructureAndMeasureColumns() {
    if (!this._rootNode) return;
    if (this.columnCount < 1) return;
  }

  /**
   * `textContent`를 `_contents`로 파싱한다.
   * `layoutText()` 호출 시 `textContent`가 변경되었을 수 있으므로
   * 매번 다시 파싱하여 최신 텍스트를 반영한다.
   * 단일 문자열은 `{ content }`로 래핑하고, `\n`으로 블록을 분리한다.
   */
  private _parseContents() {
    const rawContents = !Array.isArray(this._textContent) ? [{
      content: this._textContent
    }] : this._textContent;

    this._contents = [];
    rawContents.forEach(c => {
      const rawBlock = (typeof c === 'string') ? { content: c } : c;
      const lines = rawBlock.content.split("\n");
      this._contents.push(...(lines.map(l => ({ ...rawBlock, content: l }))));
    });
  }

  /**
   * 문자 단위 줄바꿈 루프. `initStructureAndMeasureColumns()`가 먼저 실행되어
   * `_columnWidths`, `_gaps`, `_lineHeight`가 준비되어 있어야 한다.
   * `textContent` 변경을 반영하기 위해 `_contents`를 다시 파싱한다.
   * 결과는 `_columnContents`와 `_overflow`에 저장된다.
   *
   * 무한 루프 방지: 문자가 모든 파트 폭보다 클 경우 첫 번째 파트에 강제 배치한다.
   */
  /**
   * 문자 단위 줄바꿈 렌더링을 실행한다. `layoutStructure()`가 먼저 호출되어
   * 구조 데이터가 준비되어 있어야 한다.
   * 내부 전용. `layoutText()`에서만 호출된다.
   */
  private _layoutTextIntoColumns() {
    if (!this._rootNode || this.columnCount < 1) return;

    const inputHash = this._computeLayoutInputHash();
    if (this._layoutCache && this._layoutCache.hash === inputHash) {
      this._columnContents = this._layoutCache.columnContents;
      this._overflow = this._layoutCache.overflow;
      this._overlayRectsMm = null;
      return;
    }

    this._columnContents = [];
    this._overflow = 0;
    this._overlayRectsMm = null;
    this._parseContents();

    let beforeIdxBlock = 0;
    let beforeIdxContentOfBlock = 0;

    for (let curColumn = 0; curColumn < this.columnCount; curColumn++) {
      let columnContent: TextLineData[] = [];
      let hasLine = false;
      let partWidths: number[] = [];
      let currentPartIdx = 0;
      let cumulativeWidths: number[] = [];
      let isColumnOverflow = false;

      let idxBlock = beforeIdxBlock;
      let idxContentOfBlock = beforeIdxContentOfBlock;

      for (; idxBlock < this.contents.length; idxBlock++) {
        const block = this.contents[idxBlock];
        if (idxBlock !== beforeIdxBlock) idxContentOfBlock = 0;

        if (!hasLine || idxContentOfBlock === 0) {
          let isFirstLineInLoop = true;
          while (true) {
            const isFirstInColumn = curColumn === 0 && columnContent.length < 1 && isFirstLineInLoop;
            const result = this._createLineWithParts(block.textBlockStyle, curColumn, columnContent.length, isFirstInColumn, idxContentOfBlock === 0);
            isColumnOverflow = result.overflow;

            // M2: COVER 라인은 실제 텍스트가 없으므로 이전 라인에 endOfBlock을 설정하지 않음
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

        const letterSpacingEm = this._textStyle?.letterSpacing ?? this._inheritStyle?.letterSpacing ?? DEFAULT_LETTER_SPACING;
        const letterSpacingFontSize = block.textBlockStyle?.fontSize ?? this._textStyle?.fontSize ?? this._inheritStyle?.fontSize ?? DEFAULT_FONT_SIZE;
        const letterSpacingMm = letterSpacingEm * letterSpacingFontSize;

        for (; idxContentOfBlock < block.content.length; idxContentOfBlock++) {
          const char = block.content[idxContentOfBlock];
          const rawCharWidth = this._charWidthMm(char, block.textBlockStyle);
          const baseWidth = rawCharWidth * this.widthRatio;
          const charWidth = baseWidth + letterSpacingMm;

          const placeChar = (): boolean => {
            if (cumulativeWidths[currentPartIdx] + charWidth <= partWidths[currentPartIdx] + 1e-6) {
              cumulativeWidths[currentPartIdx] += charWidth;
              columnContent[columnContent.length - 1].parts[currentPartIdx].content.push(char);
              return true;
            }
            return false;
          };

          if (placeChar()) {
            if (idxContentOfBlock >= block.content.length - 1) {
              columnContent[columnContent.length - 1].endOfBlock = true;
            }

            if (isColumnOverflow) {
              if (curColumn < this._columnWidths.length - 1) {
                if (idxContentOfBlock < block.content.length - 1) {
                  columnContent = this._removeTrailingEmptyLine(columnContent);
                }
                break;
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
              columnContent[columnContent.length - 1].parts[currentPartIdx].content.push(char);
              placed = true;
              break;
            }
            currentPartIdx++;
          }

          if (placed) {
            if (idxContentOfBlock >= block.content.length - 1) {
              columnContent[columnContent.length - 1].endOfBlock = true;
            }

            if (isColumnOverflow) {
              if (curColumn < this._columnWidths.length - 1) {
                if (idxContentOfBlock < block.content.length - 1) {
                  columnContent = this._removeTrailingEmptyLine(columnContent);
                }
                break;
              } else {
                this._overflow++;
              }
            }
            continue;
          }

          while (true) {
            const result = this._createLineWithParts(block.textBlockStyle, curColumn, columnContent.length, false, false);
            isColumnOverflow = result.overflow;

            if (result.cover) {
              columnContent.push(result.lineData);
              partWidths = [];
              hasLine = false;
              if (result.overflow) {
                if (curColumn < this._columnWidths.length - 1) {
                  if (idxContentOfBlock < block.content.length - 1) {
                    columnContent = this._removeTrailingEmptyLine(columnContent);
                  }
                  break;
                } else {
                  this._overflow++;
                }
              }
              continue;
            }

            if (result.overflow) {
              if (curColumn < this._columnWidths.length - 1) {
                if (idxContentOfBlock < block.content.length - 1) {
                  columnContent = this._removeTrailingEmptyLine(columnContent);
                }
                hasLine = false;
                partWidths = [];
                break;
              } else {
                this._overflow++;
              }
            }

            columnContent.push(result.lineData);
            hasLine = true;
            partWidths = result.partWidths;
            currentPartIdx = 0;
            cumulativeWidths = new Array(partWidths.length).fill(0);

            if (cumulativeWidths[currentPartIdx] + charWidth <= partWidths[currentPartIdx] + 1e-6) {
              cumulativeWidths[currentPartIdx] += charWidth;
              columnContent[columnContent.length - 1].parts[currentPartIdx].content.push(char);
              break;
            }

            currentPartIdx++;
            while (currentPartIdx < partWidths.length) {
              if (cumulativeWidths[currentPartIdx] + charWidth <= partWidths[currentPartIdx] + 1e-6) {
                cumulativeWidths[currentPartIdx] += charWidth;
                columnContent[columnContent.length - 1].parts[currentPartIdx].content.push(char);
                break;
              }
              currentPartIdx++;
            }

            if (currentPartIdx >= partWidths.length) {
              const maxPartWidth = partWidths.length > 0 ? Math.max(...partWidths) : 0;
              if (charWidth > maxPartWidth + 1e-6) {
                columnContent[columnContent.length - 1].parts[0].content.push(char);
                cumulativeWidths[0] += charWidth;
                break;
              }
              columnContent = this._removeTrailingEmptyLine(columnContent);
              idxContentOfBlock--;
              currentPartIdx = 0;
              continue;
            }

            break;
          }

          if (isColumnOverflow && curColumn < this._columnWidths.length - 1) {
            break;
          }

          if (idxContentOfBlock >= block.content.length - 1) {
            columnContent[columnContent.length - 1].endOfBlock = true;
          }

          if (isColumnOverflow) {
            if (curColumn < this._columnWidths.length - 1) {
              if (idxContentOfBlock < block.content.length - 1) {
                columnContent = this._removeTrailingEmptyLine(columnContent);
              }
              break;
            } else {
              this._overflow++;
            }
          }
        }

        if (isColumnOverflow) {
          if (curColumn < this._columnWidths.length - 1) break;
        }
      }

      // C3: 텍스트가 끝났거나 컬럼에서 오버플로우 시 endOfText 설정
      if (columnContent.length > 0) {
        const isEndOfText = idxBlock === this.contents.length &&
          idxContentOfBlock >= this.contents[this.contents.length - 1].content.length;
        if (isEndOfText || isColumnOverflow) {
          columnContent[columnContent.length - 1].endOfText = true;
        }
      }
      beforeIdxContentOfBlock = idxContentOfBlock;
      beforeIdxBlock = idxBlock;

      this._columnContents.push(columnContent);
    }

    this._applyLineBreakRules();

    this._previousLineCount = this._columnContents.reduce((sum, col) => sum + col.length, 0);
    this._previousOverflow = this._overflow;

    this._layoutCache = {
      hash: inputHash,
      columnContents: this._columnContents,
      overflow: this._overflow,
    };
  }

  /**
   * 레이아웃 입력 매개변수 해시를 계산한다.
   * 해시가 동일하면 레이아웃 결과가 동일하므로 `_layoutTextIntoColumns()`를 생략할 수 있다.
   */
  private _computeLayoutInputHash(): string {
    const parts: string[] = [];

    if (typeof this._textContent === 'string') {
      parts.push(this._textContent);
    } else {
      for (const block of this._textContent) {
        if (typeof block === 'string') {
          parts.push(block);
        } else {
          parts.push(block.content);
        }
      }
    }

    parts.push(
      'cw:' + this._columnWidths.join(','),
      'g:' + this._gaps.join(','),
      'lh:' + this._lineHeight,
      'wr:' + this.widthRatio,
      'ls:' + (this._textStyle?.letterSpacing ?? this._inheritStyle?.letterSpacing ?? DEFAULT_LETTER_SPACING),
      'sr:' + this.spaceRatio,
      'fs:' + (this._textStyle?.fontSize ?? this._inheritStyle?.fontSize ?? DEFAULT_FONT_SIZE),
      'ph:' + (this._inheritStyle?.parentHeight ?? 0),
      'pl:' + this._paragraphElement.absLeft,
      'pt:' + this._paragraphElement.absTop,
    );

    const overlapEls = this._paragraphElement.overlayElements;
    for (const el of overlapEls) {
      parts.push(
        'o:' + el.absLeft + ',' + el.absTop + ',' + el.absWidth + ',' + el.absHeight,
      );
    }

    return parts.join('|');
  }

  /**
   * 구조적 레이아웃만 계산하고 캐싱한다. 컬럼 폭, 간격, lineHeight 등을
   * private 필드에 저장한다.
   * 내부적으로 `_initStructureAndMeasureColumns()`를 호출한다.
   */
  public layoutStructure() {
    this._initStructureAndMeasureColumns();
  }

  /**
   * 문자 단위 줄바꿈 렌더링을 실행한다. `layoutStructure()`가 먼저 호출되어
   * 구조 데이터가 준비되어 있어야 한다.
   * 내부적으로 `_layoutTextIntoColumns()`를 호출한다.
   */
  public layoutText() {
    this._layoutTextIntoColumns();
  }

  /**
   * 증분 렌더링 상태를 초기화한다. 구조 변경 후 전체 재생성을 보장하기 위해
   * `previousLineCount`와 `previousOverflow`를 -1로 설정한다.
   */
  public resetIncrementalState() {
    this._previousLineCount = -1;
    this._previousOverflow = -1;
    this._layoutCache = null;
  }

  /** 컬럼 스타일 생성 (Flexbox 컨테이너) */
  public genColumnStyle(idx: number): Partial<CSSStyleDeclaration> {
    const left = this._columnWidths.slice(0, idx).reduce((a, b) => a + b, 0) + this._gaps.slice(0, idx).reduce((a, b) => a + b, 0);
    const height = this._inheritStyle.parentHeight;
    const width = this._columnWidths[idx];

    const verticalAlign = this.paragraphStyle?.verticalAlign || this.inheritStyle?.verticalAlign || DEFAULT_VERTICAL_ALIGN;

    return {
      boxSizing: "border-box",
      display: 'inline-flex',
      flex: `0 0 ${width}mm`,
      flexDirection: 'column',
      height: `${height}mm`,
      justifyContent: verticalAlign === 'center' ? 'center' : verticalAlign === 'bottom' ? 'flex-end' : 'flex-start',
      left: `${left}mm`,
      lineHeight: `1em`,
      maxHeight: `${height}mm`,
      maxWidth: `${width}mm`,
      minHeight: `${height}mm`,
      minWidth: `${width}mm`,
      position: 'absolute',
      top: '0',
      width: `${width}mm`,
    };
  }

  /**
   * 줄 스타일 생성.
   *
   * - `lineGap` → `height` 계산
   * - `textBlockStyle` → 폰트, 색상, 높이 오버라이드
   */
  public genLineStyle(textBlockStyle?: TextBlockStyle): Partial<CSSStyleDeclaration> {
    const lineGap = this.paragraphStyle?.lineGap ?? this.inheritStyle?.lineGap ?? DEFAULT_LINE_GAP;

    const blockStyle: Partial<CSSStyleDeclaration> = {};
    if (textBlockStyle) {
      const fontSize = textBlockStyle.fontSize;
      if (fontSize && this.lineHeight < (fontSize * lineGap)) {
        blockStyle.alignItems = 'center';
        blockStyle.height = `${Math.ceil((fontSize * lineGap) / this.lineHeight) * this.lineHeight}mm`;
      }
    }

    return {
      display: 'flex',
      flexDirection: 'row',
      flexWrap: 'nowrap',
      flexShrink: '0',
      height: `${this._lineHeight}mm`,
      maxWidth: '100%',
      width: '100%',
      ...blockStyle,
    };
  }

  /**
   * 파트 스타일 생성.
   *
   * - `letterSpacing` → em 단위 적용
   * - `textAlign` → `justify-content` 매핑 ('justify' → 'space-between')
   * - `textBlockStyle` → 폰트, 색상, 정렬 오버라이드
   */
  public genPartStyle(textBlockStyle?: TextBlockStyle): Partial<CSSStyleDeclaration> {
    const textAlign = this.paragraphStyle?.textAlign || this.inheritStyle?.textAlign || DEFAULT_TEXT_ALIGN;

    const fontLoader = FontLoader.getInstance();
    const colorRegistry = ColorRegistry.getInstance();

    let justifyContent: "center" | "flex-start" | "flex-end" | "space-between";
    switch (textAlign) {
      case 'center': justifyContent = 'center'; break;
      case 'left': justifyContent = 'flex-start'; break;
      case 'right': justifyContent = 'flex-end'; break;
      default: justifyContent = 'space-between'; break;
    }

    const blockStyle: Partial<CSSStyleDeclaration> = {};
    if (textBlockStyle) {
      blockStyle.fontFamily = textBlockStyle.fontFamily ? fontLoader.getFontFamily(textBlockStyle.fontFamily) : undefined;
      blockStyle.fontWeight = textBlockStyle.fontWeight !== undefined ? String(textBlockStyle.fontWeight) : undefined;
      blockStyle.fontSize = textBlockStyle.fontSize && `${textBlockStyle.fontSize}mm` || undefined;
      blockStyle.color = textBlockStyle.color ? colorRegistry.getCSSColor(textBlockStyle.color) : undefined;

      switch (textBlockStyle.textAlign) {
        case 'center': justifyContent = 'center'; break;
        case 'right': justifyContent = 'flex-end'; break;
        default: break;
      }
    }

    return {
      display: 'inline-flex',
      flexDirection: 'row',
      flexWrap: 'nowrap',
      alignItems: 'baseline',
      justifyContent,
      ...blockStyle,
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
   * @returns 외부 span CSS 스타일 객체
   */
  public genCharStyle = (char: string): Partial<CSSStyleDeclaration> => {
    const wr = this.widthRatio;
    const lsEm = this._textStyle?.letterSpacing ?? this._inheritStyle?.letterSpacing ?? DEFAULT_LETTER_SPACING;
    const sr = this.spaceRatio;
    const fs = this._textStyle?.fontSize ?? this._inheritStyle?.fontSize ?? DEFAULT_FONT_SIZE;
    const cacheKey = `${char}|${wr}|${lsEm}|${sr}|${fs}`;
    const cached = this._charOuterStyleCache.get(cacheKey);
    if (cached) return cached;

    const lsMm = lsEm * fs;
    let widthMm: number;
    if (char === ' ') {
      widthMm = this.spaceRatio * fs * wr + lsMm;
    } else {
      const rawWidthMm = this._charWidthMm(char);
      widthMm = rawWidthMm * wr + lsMm;
    }

    const widthCss = `${widthMm}mm`;
    const style: Partial<CSSStyleDeclaration> = {
      display: 'inline-block',
      width: widthCss,
      minWidth: `${this.spaceRatio * fs}mm`,
      maxWidth: widthCss,
      textAlign: 'center',
    };

    this._charOuterStyleCache.set(cacheKey, style);
    return style;
  }

  /**
   * 내부 span 스타일 생성. `scale` transform으로 glyph 시각 축소.
   * 외부 span과 분리되어 레이아웃 박스 크기에 영향을 주지 않는다.
   *
   * **보정 계수 `0.88`**: opentype.js가 폰트 메트릭에서 읽은 `advanceWidth`와
   * 브라우저가 동일 폰트를 렌더링했을 때의 실제 glyph 너비 간에 미세한 차이가
   * 존재한다. opentype.js의 advance width는 글리프의 Layout 폭(side bearing
   * 포함)이고, 브라우저 렌더링은 hinting/subpixel 등으로 약간 좁게 그려진다.
   * 이 차이를 보정하지 않으면 `widthRatio`로 산정한 외부 span의 `width`보다
   * 내부 glyph가 약간 넓게 렌더링되어 글자가 오버플로우하거나 인접 글자와
   * 살짝 겹치는 현상이 발생한다. `0.88`은 이 격차를 메우는 경험적 보정값으로,
   * 절대 변경하거나 제거해서는 안 된다. 제거 시 시각적 정렬이 깨진다.
   */
  public genCharInnerStyle = (): Partial<CSSStyleDeclaration> => {
    const wr = this.widthRatio;
    const key = `inner|${wr}`;
    if (key === this._charInnerStyleKey) return this._charInnerStyle;
    this._charInnerStyleKey = key;
    this._charInnerStyle = {
      display: 'inline-block',
      scale: `${wr * 0.88} 1`,
      transformOrigin: '0 center',
    };
    return this._charInnerStyle;
  }

  /**
   * 문자의 원본 폭(mm, 장평 미적용)과 장평 적용 폭(mm)을 반환한다.
   * 디버깅용 data 속성 저장에 사용된다.
   * @param char - 대상 문자
   * @returns `{ owidth: 원본 폭 mm, swidth: 장평 적용 폭 mm }`
   */
  public getCharWidths = (char: string): { owidth: number; swidth: number } => {
    const wr = this.widthRatio;
    const fontSize = this._textStyle?.fontSize ?? this._inheritStyle?.fontSize ?? DEFAULT_FONT_SIZE;
    const lsEm = this._textStyle?.letterSpacing ?? this._inheritStyle?.letterSpacing ?? DEFAULT_LETTER_SPACING;
    const lsMm = lsEm * fontSize;
    let owidth: number;
    if (char === ' ') {
      owidth = this.spaceRatio * fontSize;
    } else {
      owidth = this._charWidthMm(char);
    }
    const swidth = owidth * wr + lsMm;
    return { owidth, swidth };
  }

  set inheritStyle(inheritStyle: InheritStyle) {
    this._inheritStyle = inheritStyle;

    this._initLayoutMetrics();
  }

  set data(options: TextLayoutEngineOptions) {
    this._lineHeight = 0;

    this._paragraphElement = options.paragraphEl;
    this._rootNode = options.rootNode;
    this._inheritStyle = options.inheritStyle;

    this._textContent = options.content;

    this._paragraphStyle = options.paragraphStyle;
    this._textStyle = options.textStyle;

    this._gaps = (() => {
      const colCount = Array.isArray(options.column) ? options.column.length : (options.column || 1);

      if (Array.isArray(options.gap)) return options.gap.slice(0, colCount - 1);
      return Array.from({ length: colCount - 1 }).map(() => options.gap as number);
    })();

    this._columnWidths = (() => {
      if (Array.isArray(options.column)) return options.column;
      const colCount = options.column as number || 1;
      return Array.from<number>({ length: colCount }).map(() => (this.inheritStyle.parentWidth - this._gaps.reduce((a, b) => a + b, 0)) / colCount);
    })();

    this._initLayoutMetrics();
  }

  public set textContent(value: string | (string | TextBlockData)[]) {
    this._textContent = value;
  }

  public get textContent() {
    return this._textContent;
  }

  /** 텍스트 블록 배열 (`\n`으로 분리된) */
  public get contents() {
    return this._contents;
  }

  public get inheritStyle() {
    return this._inheritStyle;
  }

  public get textStyle() {
    return this._textStyle;
  }

  public get paragraphStyle() {
    return this._paragraphStyle;
  }

  public get columnCount() {
    return this._columnWidths.length;
  }

  /** 컬럼별 줄 데이터. `LayoutColumnElement`가 소비 */
  public get columnContents() {
    return this._columnContents;
  }

  public get gaps() {
    return this._gaps;
  }

  public get lineHeight() {
    return this._lineHeight;
  }

  /** 오버플로우된 문자 수 (컨테이너를 벗어난 텍스트) */
  public get overflow() {
    return this._overflow;
  }

  public get previousLineCount() {
    return this._previousLineCount;
  }

  public get previousOverflow() {
    return this._previousOverflow;
  }

  /** 장평 비율 */
  public get widthRatio() {
    return this.textStyle?.widthRatio ?? this.inheritStyle?.widthRatio ?? DEFAULT_WIDTH_RATIO;
  }

  /** 공백 너비 비율 (em 단위) */
  public get spaceRatio() {
    return this.textStyle?.spaceRatio ?? this.inheritStyle?.spaceRatio ?? DEFAULT_SPACE_RATIO;
  }

  /** 첫 줄 들여쓰기 비율 (fontSize 대비) */
  public get indent() {
    return this.textStyle?.indent ?? this.inheritStyle?.indent ?? DEFAULT_INDENT;
  }

  public get columnWidths() {
    return this._columnWidths;
  }
}