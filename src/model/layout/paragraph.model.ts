import { DEFAULT_FONT_SIZE, DEFAULT_LINE_GAP } from "@/define";
import type { LayoutParagraphElement } from "@/components";
import {
  InheritStyle,
  TextBlockData,
  TextLineData,
  TextBlockStyle,
  ParagraphStyle,
  TextStyle
} from "@/types";
import { getOverlapSizePX } from "@/utils";
import { FontManager } from "../font.manager";
import { ColorManager } from "../color.manager";
import { BoxModel } from "./box.model";

type ParagraphModelOptions = {
  content: string | (string | TextBlockData)[];
  column: number | number[];
  gap: number | number[];
  paragraphStyle: ParagraphStyle;
  textStyle: TextStyle;

  inheritStyle: InheritStyle;
  paragraphEl: LayoutParagraphElement;
  rootNode: Node;
};

/**
 * 텍스트 래핑과 다중 컬럼 렌더링을 수행하는 모델.
 *
 * `ParagraphData`를 받아 텍스트를 래핑하여 `TextLineData[][]`(컬럼별 줄 데이터)로 변환한다.
 * 정적 팩토리 메서드 `create()`로만 인스턴스를 생성한다.
 *
 * 주요 기능:
 * - 텍스트 래핑 (`preTextWrap()`): 문자 단위로 줄바꿈 처리
 * - 오버랩 회피: 이미지 등 다른 요소와 겹치는 영역 계산
 * - 스타일 적용: `genLineStyle()`, `genCharStyle()`으로 CSS 스타일 생성
 *
 * 렌더링 파이프라인:
 * 1. `_initLayout()` - fontSize, lineGap, lineHeight 초기화
 * 2. `preTextWrap()` - 텍스트를 줄 단위로 분리, 오버랩 처리, `TextLineData[]` 생성
 * 3. `LayoutColumnElement`가 `columnContents`를 소비하여 렌더링
 */
export class ParagraphModel {
  private _columnWidths: number[] = [];
  private _inheritStyle: InheritStyle = undefined!;

  private _inputContent: string | (string | TextBlockData)[] = "";

  private _textStyle: TextStyle = {};
  private _paragraphStyle: ParagraphStyle = {};

  private _columnContents: TextLineData[][] = [];
  private _contents: TextBlockData[] = [];
  private _gaps: number[] = [];
  private _overflow: number = 0;

  private _lineHeight: number = 0;

  private _paragraphElement: LayoutParagraphElement;
  private _rootNode: Node;

  /**
   * 정적 팩토리 메서드. `new` 직접 사용 금지.
   */
  public static create(options: ParagraphModelOptions) {
    return new this(options);
  }

  private constructor(options: ParagraphModelOptions) {
    this._paragraphElement = options.paragraphEl;
    this._rootNode = options.rootNode;

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
      flexWrap: 'wrap',
      justifyContent: 'flex-start',
    });
    return lineEl;
  }

  /**
   * 오버랩 요소(이미지 등)와의 겹침 계산.
   * `getBoundingClientRect()`로 실제 렌더링된 크기를 측정한다.
   */
  private _applyOverlap(lineEl: HTMLElement) {
    const overlapEls = this._paragraphElement.overlayElements;
    let left = 0, right = 0, cover = false;
    overlapEls.forEach(el => {
      const type = getOverlapSizePX(lineEl, el);
      switch (type.direction) {
        case 'COVERS':
          cover = true;
          break;
        case 'LEFT':
          left = Math.max(left, type.width);
          break;
        case 'RIGHT':
          right = Math.max(right, type.width);
          break;
        default:
          break;
      }
    });
    const leftMM = left ? Math.ceil(left / BoxModel.ppm) : 0;
    const rightMM = right ? Math.ceil(right / BoxModel.ppm) : 0;

    if (cover) {
      lineEl.style.width = `0`;
    } else {
      lineEl.style.width = `calc(100% - ${leftMM + rightMM}mm)`;
    }
    lineEl.style.maxWidth = lineEl.style.width;

    return { left: leftMM, right: rightMM };
  }

  /**
   * 텍스트 래핑 수행. `TextLineData[][]` 생성.
   *
   * 처리 과정:
   * 1. `content`를 `\n` 단위로 분리하여 `TextBlockData[]` 변환
   * 2. 각 컬럼마다 가상 컬럼(`x-layout-vcolumn`) 생성하여 실제 렌더링 크기 측정
   * 3. 문자 단위로 줄바꿈 판단 (오버플로우 시 다음 줄/컬럼으로)
   * 4. `_columnContents`에 `TextLineData[]` 저장
   */
  public preTextWrap() {
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

    let beforeIdxBlock = 0;
    let beforeIdxContentOfBlock = 0;

    for (let curColumn = 0; curColumn < this.columnCount; curColumn++) {
      let columnContent: TextLineData[] = [];
      let lineEl: HTMLDivElement | null = null;

      let idxBlock = beforeIdxBlock;
      let idxContentOfBlock = beforeIdxContentOfBlock;

      const vColumnEl = document.createElement('x-layout-vcolumn');
      vColumnEl.index = curColumn;
      vColumnEl.model = this;
      vColumnEl.parentElement = this._paragraphElement;
      this._rootNode.appendChild(vColumnEl);

      for (; idxBlock < this.contents.length; idxBlock++) {
        const block = this.contents[idxBlock];
        if (idxBlock !== beforeIdxBlock) idxContentOfBlock = 0;

        if (!lineEl || idxContentOfBlock === 0) {
          lineEl = this._createLineElement(block.textBlockStyle);
          vColumnEl.appendChild(lineEl);
          if (vColumnEl.isOverflow) {
            if (curColumn < this._columnWidths.length - 1) break;
          }
          const overlapSize = this._applyOverlap(lineEl);

          if (columnContent.length > 0) columnContent[columnContent.length - 1].endOfBlock = true;
          columnContent.push({
            firstOfText: curColumn === 0 && columnContent.length < 1,
            firstOfBlock: curColumn === 0 && columnContent.length < 1,
            content: [],
            textBlockStyle: block.textBlockStyle,
            ...overlapSize
          });
        }

        for (; idxContentOfBlock < block.content.length; idxContentOfBlock++) {
          const char = block.content[idxContentOfBlock];
          const charEl = document.createElement('span');
          Object.assign(charEl.style, this.genCharStyle(char));

          charEl.innerText = char;
          lineEl.appendChild(charEl);

          const firstCharRect = (lineEl.children.item(0) as HTMLDivElement).getBoundingClientRect();
          const charRect = charEl.getBoundingClientRect();
          const lineRect = lineEl.getBoundingClientRect();
          if ((lineEl.childNodes.length > 1 && charRect.x === firstCharRect.x) || lineRect.width < charRect.width) {
            if ([')', '.', ',', '!', '?', '\'', '"'].includes(char) && lineRect.width >= charRect.width) {
              charEl.remove();
            } else {
              lineEl = this._createLineElement(block.textBlockStyle);
              vColumnEl.appendChild(lineEl);
              const overlapSize = this._applyOverlap(lineEl);

              columnContent.push({
                content: [],
                textBlockStyle: block.textBlockStyle,
                ...overlapSize
              });
              if (lineRect.width < charRect.width) {
                idxContentOfBlock--;
                continue;
              }
              lineEl.appendChild(charEl);
            }
          }
          if (idxContentOfBlock >= block.content.length - 1) {
            columnContent[columnContent.length - 1].endOfBlock = true;
          }
          if (vColumnEl.isOverflow) {
            if (curColumn < this._columnWidths.length - 1) {
              if (idxContentOfBlock < block.content.length - 1 && columnContent[columnContent.length - 1].content.length < 1) {
                columnContent = columnContent.slice(0, columnContent.length - 1);
              }
              break;
            } else {
              this._overflow++;
            }
          }
          columnContent[columnContent.length - 1].content.push(char);
        }
        if (vColumnEl.isOverflow) {
          if (curColumn < this._columnWidths.length - 1) break;
        }
      }

      if (idxBlock === this.contents.length &&
        idxContentOfBlock === this.contents[this.contents.length - 1].content.length &&
        columnContent.length > 0
      ) {
        columnContent[columnContent.length - 1].endOfText = true;
      }
      beforeIdxContentOfBlock = idxContentOfBlock;
      beforeIdxBlock = idxBlock;

      vColumnEl.remove();

      this._columnContents.push(columnContent);
    }
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
   * - `letterSpacing` → em 단위 적용
   * - `textAlign` → `justify-content` 매핑 ('justify' → 'space-between')
   * - `textBlockStyle` → 폰트, 색상 오버라이드
   */
  public genLineStyle(textBlockStyle?: TextBlockStyle): Partial<CSSStyleDeclaration> {
    const lineGap = this.paragraphStyle?.lineGap || this.inheritStyle?.lineGap || DEFAULT_LINE_GAP;
    const letterSpacing = this.textStyle?.letterSpacing || this.inheritStyle?.letterSpacing;
    const textAlign = this.paragraphStyle?.textAlign || this.inheritStyle?.textAlign || 'justify';

    const fontManager = FontManager.getInstance();
    const colorManager = ColorManager.getInstance();

    let justifyContent: "center" | "flex-start" | "flex-end" | "space-between";
    switch (textAlign) {
      case 'center': justifyContent = 'center'; break;
      case 'left': justifyContent = 'flex-start'; break;
      case 'right': justifyContent = 'flex-end'; break;
      default: justifyContent = 'space-between'; break;
    }

    const blockStyle: Partial<CSSStyleDeclaration> = {};
    if (textBlockStyle) {
      blockStyle.fontFamily = textBlockStyle.fontFamily ? fontManager.getFontFamily(textBlockStyle.fontFamily) : undefined;
      blockStyle.fontWeight = textBlockStyle.fontWeight !== undefined ? String(textBlockStyle.fontWeight) : undefined;
      blockStyle.fontSize = textBlockStyle.fontSize && `${textBlockStyle.fontSize}mm` || undefined;
      blockStyle.color = textBlockStyle.color ? colorManager.getCSSColor(textBlockStyle.color) : undefined;

      if (textBlockStyle.fontSize && this.lineHeight < (textBlockStyle.fontSize * lineGap)) {
        blockStyle.alignItems = 'center';
        blockStyle.height = `${Math.ceil((textBlockStyle.fontSize * lineGap) / this.lineHeight) * this.lineHeight}mm`;
      }
      switch (textBlockStyle.textAlign) {
        case 'center': justifyContent = 'center'; break;
        case 'right': justifyContent = 'flex-end'; break;
        default: break;
      }
    }
    return {
      alignItems: 'baseline',
      display: 'inline-flex',
      flexDirection: 'row',
      flexShrink: '0',
      flexWrap: 'nowrap',
      height: `${this._lineHeight}mm`,
      justifyContent,
      letterSpacing: letterSpacing !== undefined ? `${letterSpacing}em` : undefined,
      maxWidth: '100%',
      width: '100%',
      ...blockStyle,
    };
  }

  /**
   * 글자 스타일 생성.
   *
   * - `widthRatio` → CSS `scale` 적용 (장평)
   * - 1바이트 문자/공백 → `minWidth` 차등 적용
   */
  public genCharStyle = (char: string): Partial<CSSStyleDeclaration> => {
    const isOneByte = char.length === 1 && char.charCodeAt(0) <= 255;
    const isSpace = char === ' ';

    return {
      display: 'inline-block',
      maxWidth: `${this.widthRatio}em`,
      minWidth: isSpace ? '0.15em' : isOneByte ? '0.35em' : '0.15em',
      scale: `${this.widthRatio} 1`,
      textAlign: 'center',
      transformOrigin: '0',
    };
  }

  set inheritStyle(inheritStyle: InheritStyle) {
    this._inheritStyle = inheritStyle;

    this._initLayout();
  }

  set data(options: ParagraphModelOptions) {
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

  /** 오버플로우된 줄 수 (컨테이너를 벗어난 텍스트) */
  public get overflow() {
    return this._overflow;
  }

  /** 장평 비율 */
  public get widthRatio() {
    return this.textStyle?.widthRatio || this.inheritStyle?.widthRatio || 1;
  }

  public get columnWidths() {
    return this._columnWidths;
  }
}