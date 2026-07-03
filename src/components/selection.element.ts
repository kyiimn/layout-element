/**
 * 선택 영역 하이라이트 오버레이. `<x-layout-selection>` 커스텀 엘리먼트.
 *
 * 단락 내 텍스트 선택 영역을 반투명 사각형으로 표시한다.
 * `setRanges()`로 하이라이트 영역을 설정/갱신한다.
 * 모든 좌표는 단락 로컬(paragraph-local) 기준이다.
 */
export class LayoutSelectionElement extends HTMLElement {
  private _shadowRoot: ShadowRoot;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.style.position = "absolute";
    this.style.pointerEvents = "none";
    this.style.top = "0";
    this.style.left = "0";
  }

  /**
   * 하이라이트 영역을 설정한다. 기존 하이라이트를 모두 지우고 새로 생성한다.
   * 빈 배열을 전달하면 모든 하이라이트를 제거한다.
   */
  setRanges(ranges: { top: number; left: number; width: number; height: number }[]): void {
    this._shadowRoot.innerHTML = "";

    for (const range of ranges) {
      const div = document.createElement("div");
      div.style.position = "absolute";
      div.style.pointerEvents = "none";
      div.style.backgroundColor = "rgba(0, 100, 200, 0.3)";
      div.style.top = `${range.top}px`;
      div.style.left = `${range.left}px`;
      div.style.width = `${range.width}px`;
      div.style.height = `${range.height}px`;
      this._shadowRoot.appendChild(div);
    }
  }
}

customElements.define("x-layout-selection", LayoutSelectionElement);