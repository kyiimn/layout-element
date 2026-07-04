import { DEFAULT_FONT_SIZE, DEFAULT_LINE_GAP } from "@/constants";
import type { LayoutBoxElement, LayoutParagraphElement } from "@/components";
import type { LayoutVirtualColumnElement } from "@/components/layout/v-column.element";
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
import { GridCalculator } from "@/core/grid-calculator";
import { getOverlapSizePX, mergeOverlapParts } from "@/utils";
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
 * 1. `_initLayout()` - fontSize, lineGap, lineHeight 초기화
 * 2. `layoutStructure()` - 컬럼 폭/ppm 계산, `layoutText()` - 텍스트 래핑 수행
 * 3. `LayoutColumnElement`가 `columnContents`를 소비하여 렌더링
 */
export class TextLayoutEngine {
  private _columnWidths: number[] = [];
  private _inheritStyle: InheritStyle = undefined!;

  private _inputContent: string | (string | TextBlockData)[] = "";

  private _textStyle: TextStyle = {};
  private _paragraphStyle: ParagraphStyle = {};

  private _columnContents: TextLineData[][] = [];
  private _contents: TextBlockData[] = [];
  private _gaps: number[] = [];
  private _overflow: number = 0;

  private _previousLineCount: number = -1;
  private _previousOverflow: number = -1;

  private _cachedWidthRatio: number = 0;
  private _cachedHalfWidthStyle: Partial<CSSStyleDeclaration> = {};
  private _cachedFullWidthStyle: Partial<CSSStyleDeclaration> = {};
  private _cachedSpaceStyle: Partial<CSSStyleDeclaration> = {};

  private _lineHeight: number = 0;

  private _columnPpm: number[] = [];

  private _paragraphElement: LayoutParagraphElement;
  private _rootNode: Node;

  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;

  /** Font string cache: avoids recomputing on every character */
  private _lastFontKey: string = '';
  private _lastFontString: string = '';

  /** Overlay rect cache: avoids repeated getBoundingClientRect on overlay elements per render cycle */
  private _overlayRects: Map<LayoutBoxElement, DOMRect> | null = null;

  /**
   * 정적 팩토리 메서드. `new` 직접 사용 금지.
   */
  public static create(options: TextLayoutEngineOptions) {
    return new this(options);
  }

  private constructor(options: TextLayoutEngineOptions) {
    this._paragraphElement = options.paragraphEl;
    this._rootNode = options.rootNode;

    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d')!;

    this.data = options;
  }

  /** fontSize, lineGap, lineHeight 초기화 */
  private _initLayout() {
    const fontSize = this.textStyle?.fontSize || this.inheritStyle?.fontSize || DEFAULT_FONT_SIZE;
    const lineGap = this.paragraphStyle?.lineGap || this.inheritStyle?.lineGap || DEFAULT_LINE_GAP;

    this._columnContents = [];
    this._overflow = 0;

    this._lineHeight = 0;
    this._lineHeight = fontSize * lineGap;
  }

  /** 줄 요소 생성 (Flexbox 컨테이너) */
  private _createLineElement(textBlockStyle?: TextBlockStyle) {
    const lineEl = document.createElement('div');
    const lineStyle = this.genLineStyle(textBlockStyle);
    Object.assign(lineEl.style, {
      ...lineStyle,
      flexWrap: 'nowrap',
    });
    return lineEl;
  }

  /** 파트 요소 생성 (줄 내부 수평 세그먼트) */
  private _createPartElement(widthPx: number, marginLeftPx: number) {
    const partEl = document.createElement('div');
    Object.assign(partEl.style, {
      display: 'inline-flex',
      flexDirection: 'row',
      flexWrap: 'nowrap',
      overflow: 'hidden',
      width: `${widthPx}px`,
      marginLeft: `${marginLeftPx}px`,
      alignItems: 'baseline',
    });
    return partEl;
  }

  /**
   * 오버랩 영역의 여집합으로부터 텍스트가 배치될 수 있는 자유 영역을 계산한다.
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

  private _getCanvasFont(textBlockStyle?: TextBlockStyle, ppm?: number): string {
    const fontLoader = FontLoader.getInstance();
    const fontFamily = textBlockStyle?.fontFamily
      ? fontLoader.getFontFamily(textBlockStyle.fontFamily)
      : fontLoader.getFontFamily();
    const fontSize = textBlockStyle?.fontSize
      ? textBlockStyle.fontSize
      : this._textStyle?.fontSize || this._inheritStyle?.fontSize || DEFAULT_FONT_SIZE;
    const fontWeight = textBlockStyle?.fontWeight || this._textStyle?.fontWeight || this._inheritStyle?.fontWeight || 'normal';
    const effectivePpm = ppm ?? (this._columnPpm[0] || GridCalculator.ppm);
    const fontSizePx = fontSize * effectivePpm;

    const key = `${fontWeight}|${fontSizePx}|${fontFamily}`;
    if (key === this._lastFontKey) return this._lastFontString;

    const fontString = `${fontWeight} ${fontSizePx}px ${fontFamily}`;
    this._lastFontKey = key;
    this._lastFontString = fontString;
    return fontString;
  }

  private _charWidthPx(char: string, textBlockStyle?: TextBlockStyle, ppm?: number): number {
    const effectivePpm = ppm ?? (this._columnPpm[0] || GridCalculator.ppm);
    this._ctx.font = this._getCanvasFont(textBlockStyle, effectivePpm);
    const metrics = this._ctx.measureText(char);
    const rawWidth = metrics.width;
    const fontSize = textBlockStyle?.fontSize || this._textStyle?.fontSize || this._inheritStyle?.fontSize || DEFAULT_FONT_SIZE;
    const fontSizePx = fontSize * effectivePpm;
    const maxWidthPx = this.widthRatio * fontSizePx;
    const isHalfWidth = char.length === 1 && char.charCodeAt(0) <= 255;
    const minWidthEm = (char === ' ' || !isHalfWidth) ? 0.15 : 0.35;
    const minWidthPx = minWidthEm * fontSizePx;
    return Math.round(Math.min(Math.max(rawWidth, minWidthPx), maxWidthPx));
  }

  /** 마지막 줄이 빈 파트만 있으면 제거 */
  private _removeEmptyLastLine(columnContent: TextLineData[]): TextLineData[] {
    if (columnContent.length > 0 && columnContent[columnContent.length - 1].parts.every(p => p.content.length === 0)) {
      return columnContent.slice(0, columnContent.length - 1);
    }
    return columnContent;
  }

  /**
   * 오버랩 요소(이미지 등)와의 겹침 계산.
   * `getBoundingClientRect()`로 실제 렌더링된 크기를 측정한다.
   */
  private _applyOverlap(lineEl: HTMLElement): { cover: boolean; overlapParts: OverlapParts[] } {
    const overlapEls = this._paragraphElement.overlayElements;
    let cover = false;
    let parts: OverlapParts[] = [];

    if (this._overlayRects === null) {
      this._overlayRects = new Map();
      for (const el of overlapEls) {
        this._overlayRects.set(el, el.getBoundingClientRect());
      }
    }

    const lineRect = lineEl.getBoundingClientRect();

    for (const el of overlapEls) {
      const elRect = this._overlayRects.get(el);
      if (!elRect) continue;

      if (lineRect.bottom <= elRect.top || lineRect.top >= elRect.bottom) {
        continue;
      }

      const type = getOverlapSizePX(lineEl, el);
      if (type.direction === 'COVERS') cover = true;
      if (type.direction === 'PART') parts = parts.concat(type.parts);
    }

    if (cover) lineEl.style.width = '0';
    lineEl.style.maxWidth = lineEl.style.width;

    return { cover, overlapParts: mergeOverlapParts(parts) };
  }

  /**
   * 라인 요소를 생성하고 오버랩을 감지하여 파트를 구성한다.
   *
   * `_applyOverlap()`으로 겹침을 감지하고, `_computeFreeRegions()`로
   * 자유 영역을 계산한 뒤, 각 자유 영역에 대한 파트 요소와 TextPartData를 생성한다.
   *
   * @param vColumnEl - 가상 컬럼 요소 (DOM에 삽입되어 있어야 함)
   * @param textBlockStyle - 이 라인에 적용할 블록 스타일
   * @param ppm - 픽셀/mm 변환 비율
   * @param isFirstInColumn - 첫 번째 라인 여부 (firstOfText/firstOfBlock 플래그 설정용)
   * @returns cover=true면 라인 전체가 덮임 (lineEl=null, partEls=[]),
   *          overflow=true면 컬럼 높이 초과로 라인을 제거해야 함,
   *          cover=false && overflow=false면 정상 라인
   */
  private _createLineWithParts(
    vColumnEl: HTMLElement,
    textBlockStyle: TextBlockStyle | undefined,
    ppm: number,
    isFirstInColumn: boolean,
  ): {
    cover: boolean;
    overflow: boolean;
    lineEl: HTMLDivElement | null;
    partEls: HTMLDivElement[];
    partWidths: number[];
    lineData: TextLineData;
  } {
    const lineEl = this._createLineElement(textBlockStyle);
    vColumnEl.appendChild(lineEl);

    const { cover, overlapParts } = this._applyOverlap(lineEl);

    if (cover) {
      const lineData: TextLineData = {
        firstOfText: isFirstInColumn,
        firstOfBlock: isFirstInColumn,
        parts: [],
        textBlockStyle,
      };
      return { cover: true, overflow: (vColumnEl as LayoutVirtualColumnElement).isOverflow, lineEl: null, partEls: [], partWidths: [], lineData };
    }

    // 오버플로우 시에도 lineEl을 DOM에 유지하고 freeRegions를 계산하여
    // 문자 배치를 시도한다. 원래 코드에서도 오버플로우 시 lineEl을 제거하지 않았다.
    // 오버플로우 플래그는 최종 반환값에 반영한다.
    const isOverflow = (vColumnEl as LayoutVirtualColumnElement).isOverflow;

    const lineWidth = lineEl.getBoundingClientRect().width;
    const freeRegions = this._computeFreeRegions(lineWidth, overlapParts);

    // 자유 영역이 없으면 라인 전체가 오버랩으로 덮인 것.
    // 호출자에서는 이미지가 영역을 덮든 COVER든 freeRegions가 없든 상관없이
    // 텍스트를 배치할 공간이 없다는 점에서 동일하게 처리된다.
    if (freeRegions.length === 0) {
      const lineData: TextLineData = {
        firstOfText: isFirstInColumn,
        firstOfBlock: isFirstInColumn,
        parts: [],
        textBlockStyle,
      };
      return { cover: true, overflow: (vColumnEl as LayoutVirtualColumnElement).isOverflow, lineEl: null, partEls: [], partWidths: [], lineData };
    }

    const parts: TextPartData[] = freeRegions.map((region, i) => ({
      content: [],
      left: i === 0 ? region.start / ppm : (region.start - freeRegions[i - 1].end) / ppm,
      width: (region.end - region.start) / ppm,
    }));

    const partWidths = freeRegions.map(r => r.end - r.start);

    const partEls = freeRegions.map(region => this._createPartElement(
      region.end - region.start,
      0,
    ));
    partEls.forEach((partEl, i) => {
      const gapPx = i === 0 ? freeRegions[0].start : freeRegions[i].start - freeRegions[i - 1].end;
      if (gapPx > 0) partEl.style.marginLeft = `${gapPx}px`;
      lineEl.appendChild(partEl);
    });

    const lineData: TextLineData = {
      firstOfText: isFirstInColumn,
      firstOfBlock: isFirstInColumn,
      parts,
      textBlockStyle,
    };

    return { cover: false, overflow: isOverflow, lineEl, partEls, partWidths, lineData };
  }

  /**
   * 구조적 레이아웃 초기화. 컬럼 폭/간격/lineHeight를 계산하고, 가상 컬럼을
   * 생성하여 픽셀/mm 비율(`_columnPpm`)을 측정한 뒤 제거한다.
   * `_inputContent`를 파싱한 `_contents`도 이 단계에서 생성한다.
   */
  private _initStructure() {
    if (!this._rootNode) return;

    this._columnContents = [];
    this._overflow = 0;
    this._overlayRects = null;

    const rawContents = !Array.isArray(this._inputContent) ? [{
      content: this._inputContent
    }] : this._inputContent;

    this._contents = [];
    rawContents.forEach(c => {
      const rawBlock = (typeof c === 'string') ? { content: c } : c;
      const lines = rawBlock.content.split("\n");
      this._contents.push(...(lines.map(l => ({ ...rawBlock, content: l }))));
    });

    if (this.columnCount < 1) return;

    this._columnPpm = [];
    const vColumnEls: LayoutVirtualColumnElement[] = [];
    for (let curColumn = 0; curColumn < this.columnCount; curColumn++) {
      const vColumnEl = document.createElement('x-layout-vcolumn');
      vColumnEl.index = curColumn;
      vColumnEl.model = this;
      vColumnEl.parentElement = this._paragraphElement;
      this._rootNode.appendChild(vColumnEl);
      vColumnEls.push(vColumnEl);
    }

    for (let i = 0; i < vColumnEls.length; i++) {
      const ppm = vColumnEls[i].getBoundingClientRect().width / this._columnWidths[i];
      this._columnPpm.push(ppm);
    }

    for (const vColumnEl of vColumnEls) {
      vColumnEl.remove();
    }
  }

  /**
   * `inputContent`를 `_contents`로 파싱한다.
   * `layoutText()` 호출 시 `inputContent`가 변경되었을 수 있으므로
   * 매번 다시 파싱하여 최신 텍스트를 반영한다.
   */
  private _parseContents() {
    const rawContents = !Array.isArray(this._inputContent) ? [{
      content: this._inputContent
    }] : this._inputContent;

    this._contents = [];
    rawContents.forEach(c => {
      const rawBlock = (typeof c === 'string') ? { content: c } : c;
      const lines = rawBlock.content.split("\n");
      this._contents.push(...(lines.map(l => ({ ...rawBlock, content: l }))));
    });
  }

  /**
   * 문자 단위 줄바꿈 루프. `_initStructure()`가 먼저 실행되어 `_columnWidths`,
   * `_gaps`, `_lineHeight`, `_columnPpm`이 준비되어 있어야 한다.
   * `inputContent` 변경을 반영하기 위해 `_contents`를 다시 파싱한다.
   * 결과는 `_columnContents`와 `_overflow`에 저장된다.
   */
  private _layoutTextIntoColumns() {
    if (!this._rootNode || this.columnCount < 1) return;

    this._parseContents();

    this._columnContents = [];
    this._overflow = 0;
    this._overlayRects = null;

    let beforeIdxBlock = 0;
    let beforeIdxContentOfBlock = 0;

    for (let curColumn = 0; curColumn < this.columnCount; curColumn++) {
      let columnContent: TextLineData[] = [];
      let lineEl: HTMLDivElement | null = null;
      let partEls: HTMLDivElement[] = [];
      let partWidths: number[] = [];
      let currentPartIdx = 0;
      let cumulativeWidths: number[] = [];

      let idxBlock = beforeIdxBlock;
      let idxContentOfBlock = beforeIdxContentOfBlock;

      const vColumnEl = document.createElement('x-layout-vcolumn');
      vColumnEl.index = curColumn;
      vColumnEl.model = this;
      vColumnEl.parentElement = this._paragraphElement;
      this._rootNode.appendChild(vColumnEl);

      const ppm = this._columnPpm[curColumn];

      for (; idxBlock < this.contents.length; idxBlock++) {
        const block = this.contents[idxBlock];
        if (idxBlock !== beforeIdxBlock) idxContentOfBlock = 0;

        if (!lineEl || idxContentOfBlock === 0) {
          let isFirstLineInLoop = true;
          while (true) {
            const isFirstInColumn = curColumn === 0 && columnContent.length < 1 && isFirstLineInLoop;
            const result = this._createLineWithParts(vColumnEl, block.textBlockStyle, ppm, isFirstInColumn);

            // M2: COVER 라인은 실제 텍스트가 없으므로 이전 라인에 endOfBlock을 설정하지 않음
            if (columnContent.length > 0 && !result.cover) {
              columnContent[columnContent.length - 1].endOfBlock = true;
            }

            if (result.cover) {
              columnContent.push(result.lineData);
              partEls = [];
              lineEl = null;
              isFirstLineInLoop = false;
              if (result.overflow) {
                break;
              }
              continue;
            }

            if (result.overflow) {
              lineEl = null;
              partEls = [];
              break;
            }

            columnContent.push(result.lineData);
            lineEl = result.lineEl;
            partEls = result.partEls;
            partWidths = result.partWidths;
            currentPartIdx = 0;
            cumulativeWidths = new Array(partWidths.length).fill(0);
            isFirstLineInLoop = false;
            break;
          }

          if (!lineEl) {
            if (vColumnEl.isOverflow && curColumn < this._columnWidths.length - 1) break;
          }

          if (!lineEl || partEls.length === 0) {
            if (vColumnEl.isOverflow) continue;
            break;
          }
        }

        const letterSpacingEm = this._textStyle?.letterSpacing || this._inheritStyle?.letterSpacing || 0;
        const letterSpacingFontSize = block.textBlockStyle?.fontSize || this._textStyle?.fontSize || this._inheritStyle?.fontSize || DEFAULT_FONT_SIZE;
        const letterSpacingPx = letterSpacingEm * letterSpacingFontSize * ppm;

        for (; idxContentOfBlock < block.content.length; idxContentOfBlock++) {
          const char = block.content[idxContentOfBlock];
          const charWidth = this._charWidthPx(char, block.textBlockStyle, ppm) + letterSpacingPx;

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

            if (vColumnEl.isOverflow) {
              if (curColumn < this._columnWidths.length - 1) {
                if (idxContentOfBlock < block.content.length - 1) {
                  columnContent = this._removeEmptyLastLine(columnContent);
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

            if (vColumnEl.isOverflow) {
              if (curColumn < this._columnWidths.length - 1) {
                if (idxContentOfBlock < block.content.length - 1) {
                  columnContent = this._removeEmptyLastLine(columnContent);
                }
                break;
              } else {
                this._overflow++;
              }
            }
            continue;
          }

          while (true) {
            const result = this._createLineWithParts(vColumnEl, block.textBlockStyle, ppm, false);

            if (result.cover) {
              columnContent.push(result.lineData);
              partEls = [];
              partWidths = [];
              lineEl = null;
              if (result.overflow) {
                if (curColumn < this._columnWidths.length - 1) {
                  if (idxContentOfBlock < block.content.length - 1) {
                    columnContent = this._removeEmptyLastLine(columnContent);
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
                  columnContent = this._removeEmptyLastLine(columnContent);
                }
                lineEl = null;
                partEls = [];
                partWidths = [];
                break;
              } else {
                this._overflow++;
              }
            }

            columnContent.push(result.lineData);
            lineEl = result.lineEl;
            partEls = result.partEls;
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
                break;
              }
              columnContent = this._removeEmptyLastLine(columnContent);
              idxContentOfBlock--;
              currentPartIdx = 0;
              continue;
            }

            break;
          }

          if (vColumnEl.isOverflow && curColumn < this._columnWidths.length - 1) {
            break;
          }

          if (idxContentOfBlock >= block.content.length - 1) {
            columnContent[columnContent.length - 1].endOfBlock = true;
          }

          if (vColumnEl.isOverflow) {
            if (curColumn < this._columnWidths.length - 1) {
              if (idxContentOfBlock < block.content.length - 1) {
                columnContent = this._removeEmptyLastLine(columnContent);
              }
              break;
            } else {
              this._overflow++;
            }
          }
        }

        if (vColumnEl.isOverflow) {
          if (curColumn < this._columnWidths.length - 1) break;
        }
      }

      // C3: 텍스트가 끝났거나 컬럼에서 오버플로우 시 endOfText 설정
      if (columnContent.length > 0) {
        const isEndOfText = idxBlock === this.contents.length &&
          idxContentOfBlock >= this.contents[this.contents.length - 1].content.length;
        const isOverflow = vColumnEl.isOverflow;
        if (isEndOfText || isOverflow) {
          columnContent[columnContent.length - 1].endOfText = true;
        }
      }
      beforeIdxContentOfBlock = idxContentOfBlock;
      beforeIdxBlock = idxBlock;

      vColumnEl.remove();

      this._columnContents.push(columnContent);
    }

    this._previousLineCount = this._columnContents.reduce((sum, col) => sum + col.length, 0);
    this._previousOverflow = this._overflow;
  }

  /**
   * 구조적 레이아웃만 계산하고 캐싱한다. 컬럼 폭, 간격, ppm 등 DOM 측정에
   * 의존하는 값들을 `_columnPpm`과 기타 private 필드에 저장한다.
   */
  public layoutStructure() {
    this._initStructure();
  }

  /**
   * 문자 단위 줄바꿈 레이아웃을 실행한다. `layoutStructure()`가 먼저 호출되어
   * 구조 데이터가 준비되어 있어야 한다.
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
  }

  /** 컬럼 스타일 생성 (Flexbox 컨테이너) */
  public genColumnStyle(idx: number): Partial<CSSStyleDeclaration> {
    const left = this._columnWidths.slice(0, idx).reduce((a, b) => a + b, 0) + this._gaps.slice(0, idx).reduce((a, b) => a + b, 0);
    const height = this._inheritStyle.parentHeight;
    const width = this._columnWidths[idx];

    const verticalAlign = this.paragraphStyle?.verticalAlign || this.inheritStyle?.verticalAlign;

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
    const lineGap = this.paragraphStyle?.lineGap || this.inheritStyle?.lineGap || DEFAULT_LINE_GAP;

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
    const letterSpacing = this.textStyle?.letterSpacing || this.inheritStyle?.letterSpacing;
    const textAlign = this.paragraphStyle?.textAlign || this.inheritStyle?.textAlign || 'justify';

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
      letterSpacing: letterSpacing !== undefined ? `${letterSpacing}em` : undefined,
      ...blockStyle,
    };
  }

  /**
   * 글자 스타일 생성.
   *
   * - `widthRatio` → CSS `scale` 적용 (장평)
   * - 반각 문자/공백 → `minWidth` 차등 적용
   *
   * `isHalfWidth`는 Latin-1 범위(128-255)의 전각 문자를 반각으로 오분류할 수 있다.
   * 정밀한 분류가 필요하면 Unicode East Asian Width 범위 기반 판별로 교체해야 한다.
   */
  private _updateCharStyleCache(): void {
    const wr = this.widthRatio;
    if (wr === this._cachedWidthRatio) return;
    this._cachedWidthRatio = wr;

    this._cachedHalfWidthStyle = {
      display: 'inline-block',
      maxWidth: `${wr}em`,
      minWidth: '0.35em',
      scale: `${wr} 1`,
      textAlign: 'center',
      transformOrigin: '0',
    };

    this._cachedFullWidthStyle = {
      display: 'inline-block',
      maxWidth: `${wr}em`,
      minWidth: '0.15em',
      scale: `${wr} 1`,
      textAlign: 'center',
      transformOrigin: '0',
    };

    this._cachedSpaceStyle = {
      display: 'inline-block',
      maxWidth: `${wr}em`,
      minWidth: '0.15em',
      scale: `${wr} 1`,
      textAlign: 'center',
      transformOrigin: '0',
    };
  }

  public genCharStyle = (char: string): Partial<CSSStyleDeclaration> => {
    this._updateCharStyleCache();
    if (char === ' ') return this._cachedSpaceStyle;
    if (char.length === 1 && char.charCodeAt(0) <= 255) return this._cachedHalfWidthStyle;
    return this._cachedFullWidthStyle;
  }

  set inheritStyle(inheritStyle: InheritStyle) {
    this._inheritStyle = inheritStyle;

    this._initLayout();
  }

  set data(options: TextLayoutEngineOptions) {
    this._lineHeight = 0;

    this._paragraphElement = options.paragraphEl;
    this._rootNode = options.rootNode;
    this._inheritStyle = options.inheritStyle;

    this._inputContent = options.content;

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

    this._initLayout();
  }

  public set inputContent(value: string | (string | TextBlockData)[]) {
    this._inputContent = value;
  }

  public get inputContent() {
    return this._inputContent;
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
    return this.textStyle?.widthRatio || this.inheritStyle?.widthRatio || 1;
  }

  public get columnWidths() {
    return this._columnWidths;
  }
}