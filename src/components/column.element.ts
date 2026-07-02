import { LayoutParagraphElement } from "./paragraph.element";

/**
 * 텍스트 컬럼 렌더링 요소. `<x-layout-column>` 커스텀 엘리먼트.
 *
 * `ParagraphModel`에서 생성된 `TextLineData[]`를 받아 각 줄을 렌더링한다.
 * `LayoutParagraphElement.renderText()`에서 동적으로 생성된다.
 */
export class LayoutColumnElement extends HTMLElement {
  private _index?: number;
  private _shadowRoot: ShadowRoot;

  constructor() {
    super();

    this._index = this.getAttribute("index") ? parseInt(this.getAttribute("index")!) : undefined;
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.renderText();
  }

  disconnectedCallback() { }

  attributeChangedCallback(name: string, oldval: string, newval: string) {
    if (name === 'index' && oldval !== newval) {
      this.index = parseInt(newval) || undefined;
    }
  }

  renderText() {
    if (!this.isConnected) return;

    this._shadowRoot.innerHTML = '';
    if (!this.model || this._index === undefined) return;

    const lines = this.model.columnContents[this._index] || [];
    const colStyle = this.model.genColumnStyle(this._index);

    const styleEl = document.createElement('style');
    this._shadowRoot.appendChild(styleEl);

    if (styleEl.sheet) {
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, colStyle);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const { endOfBlock, textBlockStyle } = line;
      const curLineStyle = this.model.genLineStyle(textBlockStyle) || {};
      const curPartStyle = this.model.genPartStyle(textBlockStyle) || {};

      const lineEl = document.createElement('div');
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(lineEl.style, curLineStyle);
      this._shadowRoot.appendChild(lineEl);

      for (let p = 0; p < line.parts.length; p++) {
        const part = line.parts[p];
        let { content } = part;

        let partJustify = curPartStyle.justifyContent;
        if (p === line.parts.length - 1 && endOfBlock && partJustify === 'space-between') {
          partJustify = 'flex-start';
        }
        switch (textBlockStyle?.textAlign) {
          case 'center': partJustify = 'center'; break;
          case 'right': partJustify = 'flex-end'; break;
          default: break;
        }

        if (p === 0) {
          while (content.length > 0 && content[0] === ' ') content = content.slice(1);
        }
        if (p === line.parts.length - 1) {
          while (content.length > 0 && content[content.length - 1] === ' ') content = content.slice(0, content.length - 1);
        }

        const partEl = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(partEl.style, {
          ...curPartStyle,
          width: `${part.width}mm`,
          marginLeft: `${part.left}mm`,
          justifyContent: partJustify || curPartStyle.justifyContent,
        });
        lineEl.appendChild(partEl);

        for (let j = 0; j < content.length; j++) {
          const char = content[j];
          const charEl = document.createElement('span');
          const charStyle = this.model.genCharStyle(char);
          Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(charEl.style, charStyle);
          charEl.innerText = char;
          partEl.appendChild(charEl);
        }
      }
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
