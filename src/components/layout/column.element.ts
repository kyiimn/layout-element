import { LayoutParagraphElement } from "./paragraph.element";
import type { TextLineData, TextPartData } from "@/types/layout/text/text-line.type";
import type { TextBlockStyle } from "@/types/style/text-block-style.type";

/**
 * 텍스트 컬럼 렌더링 요소. `<x-layout-column>` 커스텀 엘리먼트.
 *
 * `TextLayoutEngine`에서 생성된 `TextLineData[]`를 받아 각 줄을 렌더링한다.
 * `LayoutParagraphElement.renderText()`에서 동적으로 생성된다.
 */
export class LayoutColumnElement extends HTMLElement {
  private _index?: number;
  private _shadowRoot: ShadowRoot;
  private _cachedColStyleKey: string = '';

  constructor() {
    super();

    this._index = this.getAttribute("index") ? parseInt(this.getAttribute("index")!, 10) : undefined;
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.renderText();
  }

  disconnectedCallback() { }

  attributeChangedCallback(name: string, oldval: string | null, newval: string | null) {
    if (name === 'index' && oldval !== newval) {
      this.index = newval ? parseInt(newval, 10) : undefined;
    }
  }

  /**
   * 성능 최적화: 소스 오프셋 계산. diff 렌더링에서 기존 span 재사용을 위해
   * 현재 컬럼 이전의 렌더링된 오프셋과 소스 오프셋을 계산한다.
   */
  private _computePerfSourceOffsets(): { renderedOffset: number; sourceOffset: number } {
    let renderedOffset = 0;
    let sourceOffset = 0;
    const model = this.model!;
    for (let c = 0; c < this._index!; c++) {
      const colLines = model.columnContents[c] || [];
      for (const line of colLines) {
        for (let p = 0; p < line.parts.length; p++) {
          const original = line.parts[p].content;
          let content = original;
          if (p === 0) {
            while (content.length > 0 && content[0] === ' ') { sourceOffset++; content = content.slice(1); }
          }
          if (p === line.parts.length - 1) {
            let trailingSpaces = 0;
            for (let i = content.length - 1; i >= 0 && content[i] === ' '; i--) trailingSpaces++;
            sourceOffset += trailingSpaces;
            while (content.length > 0 && content[content.length - 1] === ' ') content = content.slice(0, content.length - 1);
          }
          renderedOffset += content.length;
          sourceOffset += content.length;
        }
        if (line.endOfBlock && sourceOffset < (model.textContent?.length ?? 0) && model.textContent?.[sourceOffset] === '\n') sourceOffset++;
      }
    }
    return { renderedOffset, sourceOffset };
  }

  /** 줄의 양 끝 공백을 제거하여 렌더링된 문자열을 정리한다. */
  private _stripSpaces(content: string[], isFirst: boolean, isLast: boolean, firstOfBlock: boolean = false, endOfBlock: boolean = false): string[] {
    let result = content;
    if (isFirst && !firstOfBlock) {
      while (result.length > 0 && result[0] === ' ') { result = result.slice(1); }
    }
    if (isLast && !endOfBlock) {
      while (result.length > 0 && result[result.length - 1] === ' ') { result = result.slice(0, result.length - 1); }
    }
    return result;
  }

  /** 줄(line) DOM 요소를 생성하고 `genLineStyle()`으로 스타일을 적용한다. */
  private _createLineElement(lineData: TextLineData, textBlockStyle: TextBlockStyle | undefined): HTMLDivElement {
    const lineEl = document.createElement('div');
    this._applyLineStyle(lineEl, lineData, textBlockStyle);
    return lineEl;
  }

  /** 줄 요소에 `genLineStyle()` 결과를 적용하여 기존 스타일을 갱신한다. */
  private _applyLineStyle(lineEl: HTMLDivElement, _lineData: TextLineData, textBlockStyle: TextBlockStyle | undefined): void {
    const curLineStyle = this.model!.genLineStyle(textBlockStyle) || {};
    lineEl.style.cssText = '';
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(lineEl.style, curLineStyle);
  }

  /**
   * 줄 요소의 실제 렌더링 높이(mm)를 반환한다.
   * `genLineStyle()`이 `textBlockStyle`에 의해 height를 오버라이드할 수 있으므로
   * `model.lineHeight`가 아닌 실제 적용된 스타일에서 추출한다.
   * @param lineEl - 높이를 측정할 줄 DOM 요소
   * @returns 줄 높이(mm). 추출 실패 시 `model.lineHeight` 폴백
   * @example
   * // lineEl.style.height === '4mm' → 4 반환
   * const h = this._getLineHeightMm(lineEl); // 4
   */
  private _getLineHeightMm(lineEl: HTMLDivElement): number {
    const heightStr = lineEl.style.height;
    if (heightStr) {
      const parsed = parseFloat(heightStr);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return this.model!.lineHeight;
  }

  /** 파트(part) DOM 요소를 생성하고 `genPartStyle()` 결과를 적용한다. */
  private _createPartElement(part: TextPartData, lineData: TextLineData, curPartStyle: Record<string, string>, partJustify: string | undefined): HTMLDivElement {
    const partEl = document.createElement('div');
    this._applyPartStyle(partEl, part, lineData, curPartStyle, partJustify);
    return partEl;
  }

  /** 파트 요소에 스타일, 너비, `marginLeft`, `justifyContent`를 적용한다. */
  private _applyPartStyle(partEl: HTMLDivElement, part: TextPartData, _lineData: TextLineData, curPartStyle: Record<string, string>, partJustify: string | undefined): void {
    partEl.style.cssText = '';
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(partEl.style, {
      ...curPartStyle,
      width: `${part.width}mm`,
      marginLeft: `${part.left}mm`,
      justifyContent: partJustify || curPartStyle.justifyContent,
    });
  }

  /** 글자(span) DOM 요소를 생성하고 `genCharStyle()` 결과와 오프셋 속성을 적용한다. */
  private _createSpanElement(char: string, renderedOffset: number, sourceOffset: number): HTMLSpanElement {
    const charEl = document.createElement('span');
    this._applySpanStyle(charEl, char, renderedOffset, sourceOffset);
    return charEl;
  }

  /** 글자 요소에 `genCharStyle()` 스타일, `data-offset`, `data-source-offset`, `innerText`를 적용한다. */
  private _applySpanStyle(charEl: HTMLSpanElement, char: string, renderedOffset: number, sourceOffset: number): void {
    const charStyle = this.model!.genCharStyle(char);
    charEl.style.cssText = '';
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(charEl.style, charStyle);
    charEl.dataset.offset = String(renderedOffset);
    charEl.dataset.sourceOffset = String(sourceOffset);

    const { owidth, swidth } = this.model!.getCharWidths(char);
    charEl.dataset.owidth = String(owidth);
    charEl.dataset.swidth = String(swidth);
    let inner = charEl.querySelector<HTMLSpanElement>(':scope > span[data-char-inner]');
    if (!inner) {
      inner = document.createElement('span');
      inner.dataset.charInner = 'true';
      charEl.appendChild(inner);
    }
    const innerStyle = this.model!.genCharInnerStyle();
    inner.style.cssText = '';
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(inner.style, innerStyle);
    inner.textContent = char;
  }

  /**
   * 재사용 span에서 글자/오프셋이 모두 동일하면 스타일 재적용을 스킵한다.
   * `genCharStyle()`는 이미 LRU 캐시되어 있어 객체 생성 비용은 낮지만,
   * `Object.assign(style, ...)` + `cssText = ''` + inner span 처리는 매 span마다
   * DOM 쓰기를 발생시키므로 변경이 없으면 전체 스킵한다.
   *
   * @param charEl - 재사용 대상 span
   * @param char - 현재 글자
   * @param renderedOffset - 현재 렌더링 오프셋
   * @param sourceOffset - 현재 소스 오프셋
   * @returns 스킵했으면 `true`, 스타일을 적용했으면 `false`
   */
  private _skipSpanStyleIfUnchanged(
    charEl: HTMLSpanElement,
    char: string,
    renderedOffset: number,
    sourceOffset: number,
  ): boolean {
    if (
      charEl.dataset.offset === String(renderedOffset) &&
      charEl.dataset.sourceOffset === String(sourceOffset)
    ) {
      const inner = charEl.querySelector<HTMLSpanElement>(':scope > span[data-char-inner]');
      if (inner && inner.textContent === char) {
        return true;
      }
    }
    return false;
  }

  /**
   * Diff 기반 텍스트 렌더링: 기존 span 요소를 `data-source-offset` 키로 재사용하며
   * 변경된 부분만 업데이트한다. COVER 라인(`parts: []`)은 라인 div의 자식을 모두 제거한다.
   */
  renderText() {
    if (!this.isConnected) return;

    // Preserve existing <style> element instead of innerHTML = ''
    const existingStyleEl = this._shadowRoot.querySelector('style');

    if (!this.model || this._index === undefined) {
      // Early return: remove line elements only, keep <style>
      const lineEls = Array.from(this._shadowRoot.children).filter(
        (child): child is HTMLDivElement => child.tagName === 'DIV'
      );
      for (const el of lineEls) el.remove();
      return;
    }

    const lines = this.model.columnContents[this._index] || [];
    const colStyle = this.model.genColumnStyle(this._index);

    const { renderedOffset, sourceOffset } = this._computePerfSourceOffsets();

    // Reuse or create <style> element
    const styleEl = existingStyleEl || document.createElement('style');
    if (!existingStyleEl) {
      this._shadowRoot.appendChild(styleEl);
    }
    // Update style rules only when colStyle actually changed
    const colStyleKey = JSON.stringify(colStyle);
    if (colStyleKey !== this._cachedColStyleKey && styleEl.sheet) {
      this._cachedColStyleKey = colStyleKey;
      while (styleEl.sheet.cssRules.length > 0) {
        styleEl.sheet.deleteRule(0);
      }
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      rule.style.cssText = '';
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, colStyle);
    }

    // Remove data-temporary spans (created by TextEditController) before collecting existing lines
    const temporarySpans = this._shadowRoot.querySelectorAll('span[data-temporary]');
    for (const span of temporarySpans) span.remove();

    // Collect existing line elements for diff rendering (Task 4)
    const existingLineEls = Array.from(this._shadowRoot.children).filter(
      (child): child is HTMLDivElement => child.tagName === 'DIV'
    );

    let curRenderedOffset = renderedOffset;
    let curSourceOffset = sourceOffset;

    const columnHeightMm = this.model.inheritStyle?.parentHeight ?? 0;
    let accumulatedHeightMm = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const { endOfBlock, textBlockStyle } = line;
      const curPartStyle = this.model.genPartStyle(textBlockStyle) || {};

      const lineEl = i < existingLineEls.length
        ? existingLineEls[i]
        : this._createLineElement(line, textBlockStyle);
      if (i < existingLineEls.length) {
        this._applyLineStyle(lineEl, line, textBlockStyle);
      } else {
        this._shadowRoot.appendChild(lineEl);
      }

      const lineHeightMm = this._getLineHeightMm(lineEl);
      const isOverflow = columnHeightMm > 0 && accumulatedHeightMm + lineHeightMm > columnHeightMm + 1e-6;
      lineEl.style.display = isOverflow ? 'none' : '';

      if (!isOverflow) {
        accumulatedHeightMm += lineHeightMm;
      }

      if (line.parts.length === 0) {
        while (lineEl.firstChild) lineEl.firstChild.remove();
        if (endOfBlock && curSourceOffset < (this.model?.textContent?.length ?? 0) && this.model?.textContent?.[curSourceOffset] === '\n') curSourceOffset++;
        continue;
      }

      const existingPartEls = Array.from(lineEl.children).filter(
        (child): child is HTMLDivElement => child.tagName === 'DIV'
      );

      for (let p = 0; p < line.parts.length; p++) {
        const part = line.parts[p];
        const original = part.content;
        const isFirst = p === 0;
        const isLast = p === line.parts.length - 1;

        let leadingSpaces = 0;
        if (isFirst && line.firstOfBlock !== true) {
          for (let k = 0; k < original.length && original[k] === ' '; k++) leadingSpaces++;
          curSourceOffset += leadingSpaces;
        }

        const content = this._stripSpaces(part.content, isFirst, isLast, line.firstOfBlock === true, line.endOfBlock === true);

        let partJustify = curPartStyle.justifyContent;
        if (isLast && endOfBlock && partJustify === 'space-between') {
          partJustify = 'flex-start';
        }
        switch (textBlockStyle?.textAlign) {
          case 'center': partJustify = 'center'; break;
          case 'right': partJustify = 'flex-end'; break;
          default: break;
        }

        const partEl = p < existingPartEls.length
          ? existingPartEls[p]
          : this._createPartElement(part, line, curPartStyle as Record<string, string>, partJustify);
        if (p < existingPartEls.length) {
          this._applyPartStyle(partEl, part, line, curPartStyle as Record<string, string>, partJustify);
        } else {
          lineEl.appendChild(partEl);
        }

        const existingSpans = new Map<string, HTMLSpanElement>();
        const currentSpans = partEl.querySelectorAll(':scope > span[data-source-offset]') as NodeListOf<HTMLSpanElement>;
        for (const span of currentSpans) {
          const key = span.dataset.sourceOffset;
          if (key !== undefined) existingSpans.set(key, span);
        }

        let nextRef: Node | null = partEl.firstChild;

        for (let j = 0; j < content.length; j++) {
          const char = content[j];
          const thisCharSourceOffset = String(curSourceOffset);
          const existingSpan = existingSpans.get(thisCharSourceOffset);

          let charEl: HTMLSpanElement;
          if (existingSpan) {
            charEl = existingSpan;
            if (!this._skipSpanStyleIfUnchanged(charEl, char, curRenderedOffset, curSourceOffset)) {
              this._applySpanStyle(charEl, char, curRenderedOffset, curSourceOffset);
            }
            existingSpans.delete(thisCharSourceOffset);
          } else {
            charEl = this._createSpanElement(char, curRenderedOffset, curSourceOffset);
          }

          if (nextRef === charEl) {
            nextRef = charEl.nextSibling;
          } else {
            partEl.insertBefore(charEl, nextRef);
          }

          curRenderedOffset++;
          curSourceOffset++;
        }

        for (const unusedSpan of existingSpans.values()) {
          unusedSpan.remove();
        }

        if (isLast && line.endOfBlock !== true) {
          const afterLeading: string[] = isFirst ? original.slice(leadingSpaces) : original;
          let trailingSpaces = 0;
          for (let k = afterLeading.length - 1; k >= 0 && afterLeading[k] === ' '; k--) trailingSpaces++;
          curSourceOffset += trailingSpaces;
        }
      }

      for (let p = line.parts.length; p < existingPartEls.length; p++) {
        existingPartEls[p].remove();
      }

      if (endOfBlock && curSourceOffset < (this.model?.textContent?.length ?? 0) && this.model?.textContent?.[curSourceOffset] === '\n') curSourceOffset++;
    }

    for (let i = lines.length; i < existingLineEls.length; i++) {
      existingLineEls[i].remove();
    }
  }

  static get observedAttributes() { return ['index']; }

  get index() { return this._index; }
  get zIndex() { return 0; }
  get type() { return 'column' as const; }

  get parentElement() {
    return super.parentElement as LayoutParagraphElement;
  }

  get left() {
    const width = this.model?.columnWidths.slice(0, this._index).reduce((a, b) => a + b, 0) || 0;
    const gap = this.model?.gaps.slice(0, this._index).reduce((a, b) => a + b, 0) || 0;
    return gap + width;
  }

  get top() { return 0; }

  get absLeft(): number {
    return this.parentElement.absLeft + this.left;
  }

  get absTop(): number {
    return this.parentElement.absTop;
  }

  get model() {
    return this.parentElement.model;
  }

  set index(index: number | undefined) {
    this._index = index;
    this.renderText();
  }
}
customElements.define('x-layout-column', LayoutColumnElement);
