/**
 * 편집 커서 요소. `<x-layout-cursor>` 커스텀 엘리먼트.
 *
 * 단락 내 깜빡이는 수직 커서를 렌더링한다.
 * 좌표는 단락 로컬(px) 기준이며, `position: absolute` + `pointer-events: none`으로
 * 텍스트 위에 오버레이된다.
 */
export class LayoutCursorElement extends HTMLElement {
  private _shadowRoot: ShadowRoot;
  private _top: number = 0;
  private _left: number = 0;
  private _height: number = 0;
  private _visible: boolean = true;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.render();
  }

  render() {
    if (!this.isConnected) return;

    this._shadowRoot.innerHTML = '';

    const styleEl = document.createElement('style');
    this._shadowRoot.appendChild(styleEl);

    if (styleEl.sheet) {
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, {
        position: 'absolute',
        pointerEvents: 'none',
        top: `${this._top}px`,
        left: `${this._left}px`,
        width: '2px',
        height: `${this._height}px`,
      });
      rule.style.setProperty('background-color', 'currentColor');

      if (!this._visible) {
        rule.style.setProperty('visibility', 'hidden');
      }
    }

    styleEl.sheet!.insertRule(
      `@keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }`,
      styleEl.sheet!.cssRules.length,
    );
    styleEl.sheet!.insertRule(
      `:host { animation: blink 1060ms step-end infinite; }`,
      styleEl.sheet!.cssRules.length,
    );
  }

  set top(value: number) {
    this._top = value;
    this.render();
  }

  get top(): number {
    return this._top;
  }

  set left(value: number) {
    this._left = value;
    this.render();
  }

  get left(): number {
    return this._left;
  }

  set height(value: number) {
    this._height = value;
    this.render();
  }

  get height(): number {
    return this._height;
  }

  set visible(value: boolean) {
    this._visible = value;
    this.render();
  }

  get visible(): boolean {
    return this._visible;
  }
}

customElements.define('x-layout-cursor', LayoutCursorElement);