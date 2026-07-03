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

  private _dirty: boolean = false;
  private _rafId: number | null = null;
  private _styleEl: HTMLStyleElement | null = null;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.render();
  }

  disconnectedCallback() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._dirty = false;
    this._styleEl = null;
  }

  private _scheduleRender(): void {
    if (this._dirty) return;
    this._dirty = true;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._dirty = false;
      this.render();
    });
  }

  render() {
    if (!this.isConnected) return;

    if (!this._styleEl) {
      this._shadowRoot.innerHTML = '';
      this._styleEl = document.createElement('style');
      this._shadowRoot.appendChild(this._styleEl);

      const sheet = this._styleEl.sheet;
      if (sheet) {
        sheet.insertRule(":host {}", 0);
      }
    }

    const sheet = this._styleEl.sheet;
    if (!sheet || sheet.cssRules.length < 1) return;

    const rule = sheet.cssRules[0] as CSSStyleRule;
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
    } else {
      rule.style.removeProperty('visibility');
    }
  }

  set top(value: number) {
    this._top = value;
    this._scheduleRender();
  }

  get top(): number {
    return this._top;
  }

  set left(value: number) {
    this._left = value;
    this._scheduleRender();
  }

  get left(): number {
    return this._left;
  }

  set height(value: number) {
    this._height = value;
    this._scheduleRender();
  }

  get height(): number {
    return this._height;
  }

  set visible(value: boolean) {
    this._visible = value;
    this._scheduleRender();
  }

  get visible(): boolean {
    return this._visible;
  }
}

customElements.define('x-layout-cursor', LayoutCursorElement);