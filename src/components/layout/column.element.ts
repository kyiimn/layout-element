import { LayoutParagraphElement } from "./paragraph.element";
import type { TextLineData, TextPartData } from "@/types/layout/text/text-line.type";
import type { TextBlockStyle } from "@/types/style/text-block-style.type";

const HOST_STYLE_ID = '__layout_host_style__';

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

  /**
   * 파트 요소에 스타일, 너비, `marginLeft`, `justifyContent`를 적용한다.
   *
   * `part.charOffsets`가 정의되어 있으면 flexbox 정렬을 우회하고
   * `justify-content: flex-start` + `position: relative` + `height: 100%`로 설정하여
   * 각 span이 `position: absolute; left: ${charOffset}mm; top: 0`으로 정확히 배치되도록 한다.
   * `height: 100%`는 absolute 자식이 플로우에서 벗어나 part div가 높이를 잃지 않도록 보장한다.
   * `charOffsets`가 없으면 기존 flexbox `justify-content` 정렬 경로를 유지한다.
   */
  private _applyPartStyle(partEl: HTMLDivElement, part: TextPartData, _lineData: TextLineData, curPartStyle: Record<string, string>, partJustify: string | undefined): void {
    partEl.style.cssText = '';
    const useCharOffsets = part.charOffsets !== undefined;
    const effectiveJustify = useCharOffsets ? 'flex-start' : (partJustify || curPartStyle.justifyContent);
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(partEl.style, {
      ...curPartStyle,
      width: `${part.width}mm`,
      marginLeft: `${part.left}mm`,
      justifyContent: effectiveJustify,
      ...(useCharOffsets && { position: 'relative', height: '100%' }),
    });
  }

  /** 글자(span) DOM 요소를 생성하고 `genCharStyle()` 결과와 오프셋 속성을 적용한다. */
  private _createSpanElement(char: string, renderedOffset: number, sourceOffset: number, charOffsetMm: number | undefined, textBlockStyle: TextBlockStyle | undefined): HTMLSpanElement {
    const charEl = document.createElement('span');
    this._applySpanStyle(charEl, char, renderedOffset, sourceOffset, charOffsetMm, textBlockStyle);
    return charEl;
  }

  /**
   * 글자 요소에 `genCharStyle()` 스타일, `data-offset`, `data-source-offset`, `innerText`를 적용한다.
   *
   * `textBlockStyle`이 제공되면 `genCharStyle`/`getCharWidths`에 전달하여 블록별
   * `fontSize`/`fontFamily` 오버라이드가 span 폭에 반영되도록 한다. 이는
   * `_layoutTextIntoColumns`의 줄바꿈 계산(`_charWidthMm(char, textBlockStyle)`)과
   * 동일한 폭을 사용하도록 보장한다.
   *
   * `charOffsetMm`가 제공되면(정렬 계산 경로) span에 `position: absolute; left: ${charOffsetMm}mm; top: 0`를
   * 적용하여 부모 파트 기준 절대 좌표로 직접 배치한다. flexbox 자연 위치 연산을 거치지 않으므로
   * 브라우저 렌더링 결과가 계산된 `charOffsets[j]`와 정확히 일치한다.
   * `top: 0`은 수직 정렬을 부모 part div(`alignItems: baseline`이 무시되므로 부모 top 기준)에 맡긴다 —
   * 폰트 메트릭 기반 렌더링에서 span 높이는 `lineHeight`와 일치하므로 top=0이면 시각적으로 올바르다.
   *
   * charOffsets 경로에서는 **단일 span** 구조를 사용한다 — outer/inner 중첩 없이
   * `scale`/`transformOrigin`을 이 span에 직접 적용(`genCharStyleFlat`). absolute 배치이므로
   * outer의 `width`/`textAlign`이 의미 없고, 정렬은 charOffsets가 직접 산출한다.
   * DOM 노드 수 절반, querySelector/inner span 갱신 비용 제거.
   *
   * `charOffsetMm === undefined`이면 레거시 flexbox 정렬 경로를 유지한다 (outer/inner 중첩).
   */
  private _applySpanStyle(charEl: HTMLSpanElement, char: string, renderedOffset: number, sourceOffset: number, charOffsetMm: number | undefined, textBlockStyle: TextBlockStyle | undefined): void {
    charEl.style.cssText = '';

    if (charOffsetMm !== undefined) {
      // 단일 span 경로: scale/transformOrigin을 직접 적용, inner span 없음
      const flatStyle = this.model!.genCharStyleFlat(char, textBlockStyle);
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(charEl.style, flatStyle);
      charEl.style.position = 'absolute';
      charEl.style.left = `${charOffsetMm}mm`;
      charEl.style.top = '0';
      charEl.textContent = char;

      // flexbox→charOffsets 전환 시 기존 inner span 제거
      const existingInner = charEl.querySelector<HTMLSpanElement>(':scope > span[data-char-inner]');
      if (existingInner) existingInner.remove();
    } else {
      // 중첩 span 경로: outer width/textAlign + inner scale
      const charStyle = this.model!.genCharStyle(char, textBlockStyle);
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(charEl.style, charStyle);
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

    charEl.dataset.offset = String(renderedOffset);
    charEl.dataset.sourceOffset = String(sourceOffset);
    if (charOffsetMm !== undefined) {
      charEl.dataset.charOffset = String(charOffsetMm);
    } else {
      delete charEl.dataset.charOffset;
    }

    const { rawWidth, swidth } = this.model!.getCharWidths(char, textBlockStyle);
    charEl.dataset.owidth = String(rawWidth);
    charEl.dataset.swidth = String(swidth);
  }

  /**
   * 재사용 span에서 글자/오프셋이 모두 동일하면 스타일 재적용을 스킵한다.
   * `genCharStyle()`는 이미 LRU 캐시되어 있어 객체 생성 비용은 낮지만,
   * `Object.assign(style, ...)` + `cssText = ''` + inner span 처리는 매 span마다
   * DOM 쓰기를 발생시키므로 변경이 없으면 전체 스킵한다.
   *
   * `charOffsetMm`가 변경되면 스킵하지 않는다 (정렬 변경 시 재적용 필요).
   *
   * charOffsets 경로(단일 span)에서는 `textContent`를 직접 비교하고,
   * flexbox 경로(중첩 span)에서는 inner span의 `textContent`를 비교한다.
   *
   * @param charEl - 재사용 대상 span
   * @param char - 현재 글자
   * @param renderedOffset - 현재 렌더링 오프셋
   * @param sourceOffset - 현재 소스 오프셋
   * @param charOffsetMm - 절대 정렬 오프셋 (undefined = 레거시 경로)
   * @returns 스킵했으면 `true`, 스타일을 적용했으면 `false`
   */
  private _skipSpanStyleIfUnchanged(
    charEl: HTMLSpanElement,
    char: string,
    renderedOffset: number,
    sourceOffset: number,
    charOffsetMm?: number,
  ): boolean {
    if (
      charEl.dataset.offset === String(renderedOffset) &&
      charEl.dataset.sourceOffset === String(sourceOffset)
    ) {
      const existingCharOffset = charEl.dataset.charOffset;
      const newCharOffsetStr = charOffsetMm !== undefined ? String(charOffsetMm) : undefined;
      if (existingCharOffset === newCharOffsetStr) {
        // charOffsets 경로(단일 span): textContent 직접 비교
        if (charOffsetMm !== undefined) {
          return charEl.textContent === char;
        }
        // flexbox 경로(중첩 span): inner span textContent 비교
        const inner = charEl.querySelector<HTMLSpanElement>(':scope > span[data-char-inner]');
        return inner !== null && inner.textContent === char;
      }
    }
    return false;
  }

  /**
   * Diff 기반 텍스트 렌더링: 기존 span 요소를 `data-source-offset` 키로 재사용하며
   * 변경된 부분만 업데이트한다. COVER 라인(`parts: []`)은 라인 div의 자식을 모두 제거한다.
   *
   * 오버플로우 라인은 part/span DOM 노드 생성을 생략하고 lineEl만 `display: none`으로 유지한다.
   * 단, diff 렌더링의 인덱스 매칭을 위해 lineEl 자체는 보존한다.
   */
  renderText() {
    if (!this.isConnected) return;

    // Preserve existing <style> element instead of innerHTML = ''
    const existingStyleEl = this._shadowRoot.querySelector<HTMLStyleElement>(`style#${HOST_STYLE_ID}`);

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
      styleEl.id = HOST_STYLE_ID;
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
    const baseLineHeightMm = this.model.lineHeight;
    const baseFontSizeMm = this.model.fontSize;
    // 엔진(_createLineWithParts)의 overflow 판정과 동일 기준:
    // effectiveColumnHeight = parentHeight + (lineHeight - fontSize)
    const effectiveColumnHeightMm = columnHeightMm + (baseLineHeightMm - baseFontSizeMm);
    let accumulatedHeightMm = 0;
    let hasOverflowed = false;

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

      // 마지막 라인은 lineHeight가 아닌 fontSize만큼만 높이를 차지한다.
      // BoxEngine.absHeight = lineHeight * height - (lineHeight - fontSize)
      // 단, textBlockStyle.fontSize가 기본 fontSize와 다르면 genLineStyle이
      // 계산한 블록 전용 높이를 유지한다 (해당 라인은 자체 높이를 가짐).
      const isLastLineInColumn = i === lines.length - 1;
      const lineFontSizeMm = textBlockStyle?.fontSize ?? baseFontSizeMm;
      if (isLastLineInColumn && lineFontSizeMm === baseFontSizeMm && lineEl.style.height !== `${lineFontSizeMm}mm`) {
        lineEl.style.height = `${lineFontSizeMm}mm`;
      }

      const lineHeightMm = this._getLineHeightMm(lineEl);
      // 한 번 overflow 발생 후 이후 라인이 마지막 라인 높이 규칙(fontSize)으로
      // 다시 visible로 잘못 판정되는 것을 방지한다.
      const isOverflow = hasOverflowed
        || (effectiveColumnHeightMm > 0 && accumulatedHeightMm + lineHeightMm > effectiveColumnHeightMm + 1e-6);
      lineEl.style.display = isOverflow ? 'none' : '';

      if (!isOverflow) {
        accumulatedHeightMm += lineHeightMm;
      } else {
        hasOverflowed = true;
      }

      if (isOverflow) {
        while (lineEl.firstChild) lineEl.firstChild.remove();

        const advanced = this._computeSkippedLineOffsets(line, curRenderedOffset, curSourceOffset);
        curRenderedOffset = advanced.renderedOffset;
        curSourceOffset = advanced.sourceOffset;
        continue;
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

        const charOffsets = part.charOffsets;

        for (let j = 0; j < content.length; j++) {
          const char = content[j];
          const thisCharSourceOffset = String(curSourceOffset);
          const existingSpan = existingSpans.get(thisCharSourceOffset);

          const offsetMm = charOffsets !== undefined && j < charOffsets.length
            ? charOffsets[j]
            : undefined;

          let charEl: HTMLSpanElement;
          if (existingSpan) {
            charEl = existingSpan;
            if (!this._skipSpanStyleIfUnchanged(charEl, char, curRenderedOffset, curSourceOffset, offsetMm)) {
              this._applySpanStyle(charEl, char, curRenderedOffset, curSourceOffset, offsetMm, textBlockStyle);
            }
            existingSpans.delete(thisCharSourceOffset);
          } else {
            charEl = this._createSpanElement(char, curRenderedOffset, curSourceOffset, offsetMm, textBlockStyle);
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

  /**
   * 렌더링에서 생략된(오버플로우) 라인의 part content를 순회하며
   * `renderedOffset`/`sourceOffset`을 렌더링하지 않은 만큼 advance시킨다.
   *
   * `renderText()`의 정상 part 렌더링 경로와 동일한 공백/`\n` 처리를 미러링하여
   * 이후 라인의 `data-source-offset` diff 키가 정확히 일치하도록 보장한다.
   *
   * @param line - 생략된 라인 데이터
   * @param renderedOffset - 현재 렌더링 오프셋
   * @param sourceOffset - 현재 소스 오프셋
   * @returns 갱신된 오프셋
   * @example
   * const adv = this._computeSkippedLineOffsets(line, 10, 20);
   * // adv.renderedOffset === 14, adv.sourceOffset === 24
   */
  private _computeSkippedLineOffsets(
    line: TextLineData,
    renderedOffset: number,
    sourceOffset: number,
  ): { renderedOffset: number; sourceOffset: number } {
    let curRendered = renderedOffset;
    let curSource = sourceOffset;

    for (let p = 0; p < line.parts.length; p++) {
      const original = line.parts[p].content;
      const isFirst = p === 0;
      const isLast = p === line.parts.length - 1;

      let leadingSpaces = 0;
      if (isFirst && line.firstOfBlock !== true) {
        for (let k = 0; k < original.length && original[k] === ' '; k++) leadingSpaces++;
        curSource += leadingSpaces;
      }

      const content = this._stripSpaces(
        original,
        isFirst,
        isLast,
        line.firstOfBlock === true,
        line.endOfBlock === true,
      );

      curRendered += content.length;
      curSource += content.length;

      if (isLast && line.endOfBlock !== true) {
        const afterLeading: string[] = isFirst ? original.slice(leadingSpaces) : original;
        let trailingSpaces = 0;
        for (let k = afterLeading.length - 1; k >= 0 && afterLeading[k] === ' '; k--) trailingSpaces++;
        curSource += trailingSpaces;
      }
    }

    if (line.endOfBlock && curSource < (this.model?.textContent?.length ?? 0) && this.model?.textContent?.[curSource] === '\n') {
      curSource++;
    }

    return { renderedOffset: curRendered, sourceOffset: curSource };
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

  /**
   * 이 컬럼의 shadow DOM 내에서 `display: none`이 아닌 line div의 수를 반환한다.
   *
   * `renderText()`가 오버플로우된 줄을 `display: none`으로 숨기므로,
   * 이 게터는 실제로 화면에 보이는 줄 수만 센다. `TextLayoutEngine`이 paragraph
   * 자체 `textStyle.fontSize`와 `paragraphStyle.lineGap`을 곱해 계산한
   * `lineHeight`(mm)를 기준으로 렌더링된 결과이므로, document 기본 스타일이
   * 아닌 paragraph 자체 스타일 기반의 가시 라인 수이다.
   *
   * 외부 코드는 shadow DOM 내부 구조(line div 등)를 직접 순회하지 않고
   * 이 게터를 통해 캡슐화된 가시 라인 수만 가져올 수 있다.
   *
   * @returns 보이는 라인 수. 컬럼이 연결되지 않았거나 line div가 없으면 0.
   * @example
   * const column = paragraph.columnEl[0];
   * if (column) {
   *   const visible = column.visibleLineCount;
   *   console.log(`첫 번째 단의 보이는 라인 수: ${visible}`);
   * }
   */
  get visibleLineCount(): number {
    let count = 0;
    for (const child of this._shadowRoot.children) {
      if (child.tagName === 'DIV' && (child as HTMLDivElement).style.display !== 'none') {
        count++;
      }
    }
    return count;
  }

  set index(index: number | undefined) {
    this._index = index;
    this.renderText();
  }
}
customElements.define('x-layout-column', LayoutColumnElement);
