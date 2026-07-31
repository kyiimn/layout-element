import { Z_INDEX_AI_PROCESSING } from "@/constants";

/**
 * AI 처리 중 오버레이 요소의 식별자. shadow DOM 내에서 고유해야 한다.
 */
const OVERLAY_ID = "__ai_processing_overlay__";

const OVERLAY_STYLE = `
.__ai-overlay__ {
  position: absolute;
  inset: 0;
  z-index: ${Z_INDEX_AI_PROCESSING};
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.55);
  overflow: hidden;
  pointer-events: auto;
}
.__ai-overlay__[data-active="true"] {
  display: flex;
}
.__ai-overlay__::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(99, 179, 237, 0.4) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: __ai_shimmer__ 1.6s linear infinite;
}
.__ai-overlay__::after {
  content: "";
  width: 28px;
  height: 28px;
  border: 3px solid rgba(99, 179, 237, 0.3);
  border-top-color: rgba(59, 130, 246, 0.9);
  border-radius: 50%;
  animation: __ai_spin__ 0.8s linear infinite;
}
@keyframes __ai_shimmer__ {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes __ai_spin__ {
  to { transform: rotate(360deg); }
}
@media print {
  .__ai-overlay__ { display: none !important; }
}
`;

/**
 * AI 처리 중 오버레이를 shadow DOM에 생성한다.
 *
 * shadow root에 `<style>`과 `<div>`를 한 번만 주입한다.
 * 오버레이는 기본적으로 `display: none` 상태이며,
 * {@link setAiProcessingActive}로 활성화한다.
 *
 * @param shadowRoot - 오버레이를 삽입할 shadow root
 * @throws `shadowRoot`에 접근할 수 없거나 stylesheet 생성에 실패한 경우
 *
 * @example
 * ```ts
 * // shadow DOM 초기화 시점에 호출
 * createAiProcessingOverlay(this._shadowRoot);
 * ```
 */
export function createAiProcessingOverlay(shadowRoot: ShadowRoot): void {
  if (shadowRoot.getElementById(OVERLAY_ID)) return;

  const styleEl = document.createElement("style");
  shadowRoot.appendChild(styleEl);
  if (!styleEl.sheet) throw new Error("stylesheet is not initialized");
  styleEl.textContent = OVERLAY_STYLE;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "__ai-overlay__";
  shadowRoot.appendChild(overlay);
}

/**
 * AI 처리 중 오버레이의 활성화 상태를 토글한다.
 *
 * 오버레이가 shadow DOM에 없으면 아무 작업도 수행하지 않는다.
 * `layout()`/`render()`를 트리거하지 않으므로 비용이 거의 없다.
 *
 * @param shadowRoot - 오버레이가 위치한 shadow root
 * @param active - `true`면 오버레이 표시, `false`면 숨김
 *
 * @example
 * ```ts
 * // AI 처리 시작
 * setAiProcessingActive(this._shadowRoot, true);
 *
 * // AI 처리 완료
 * setAiProcessingActive(this._shadowRoot, false);
 * ```
 */
export function setAiProcessingActive(shadowRoot: ShadowRoot, active: boolean): void {
  const overlay = shadowRoot.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.setAttribute("data-active", active ? "true" : "false");
}

/**
 * AI 처리 중 오버레이의 현재 활성화 상태를 반환한다.
 *
 * 오버레이가 shadow DOM에 없으면 `false`를 반환한다.
 *
 * @param shadowRoot - 오버레이가 위치한 shadow root
 * @returns 활성화 여부. 오버레이 미존재 시 `false`
 *
 * @example
 * ```ts
 * if (isAiProcessingActive(this._shadowRoot)) {
 *   // AI 처리 중 로직
 * }
 * ```
 */
export function isAiProcessingActive(shadowRoot: ShadowRoot): boolean {
  const overlay = shadowRoot.getElementById(OVERLAY_ID);
  return overlay?.getAttribute("data-active") === "true";
}

/**
 * AI 처리 중 오버레이를 shadow DOM에서 제거한다.
 *
 * `disconnectedCallback` 등에서 호출하여 잔류 DOM을 정리한다.
 * 오버레이가 없으면 아무 작업도 수행하지 않는다.
 *
 * @param shadowRoot - 오버레이가 위치한 shadow root
 *
 * @example
 * ```ts
 * disconnectedCallback() {
 *   removeAiProcessingOverlay(this._shadowRoot);
 * }
 * ```
 */
export function removeAiProcessingOverlay(shadowRoot: ShadowRoot): void {
  const overlay = shadowRoot.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
}