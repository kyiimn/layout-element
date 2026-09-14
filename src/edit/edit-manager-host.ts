/**
 * EditManager가 호스트 요소(page/document)에 요구하는 계약 표면 (E-1).
 *
 * EditManager는 `LayoutPageElement`의 하위 트리 순회·좌표 환산·전역 가이드
 * 토글만 호스트에 요구한다 — 구체 요소 클래스(`LayoutPageElement`)에 의존하면
 * document 요소(`LayoutDocumentElement`)가 자신을 페이지로 위장하는 타입 거짓말
 * (`new EditManager(this as unknown as LayoutPageElement)`)이 필요해진다. 이
 * 인터페이스가 실제 소비 표면만 계약으로 분리해 그 캐스팅을 제거한다.
 *
 * @example
 * ```ts
 * // document/page 공통 구현 선언
 * export class LayoutDocumentElement extends HTMLElement implements EditManagerHost {
 *   get ppm(): number { return this._ppm; }
 *   get visibleGuide(): boolean { return this._visibleGuide; }
 *   set visibleGuide(v: boolean): void { ... }
 * }
 * new EditManager(docElement); // 캐스팅 불요 — EditManagerHost로 소비
 * ```
 *
 * @file src/edit/edit-manager-host.ts
 */

/**
 * EditManager가 호스트 요소에 요구하는 표면 (page/document 공통).
 *
 * 구현자는 `querySelector*`/`ppm`/`visibleGuide`를 제공해야 하며, 나머지
 * HTMLElement 기능(getBoundingClientRect/style 등)은
 * `EditManagerHost & HTMLElement` 조합으로 소비한다 (호출부가 HTMLElement
 * 기능을 함께 쓴다 — place-gun의 커서 복원 등).
 */
export interface EditManagerHost {
  /** 스코프 DOM 순회 — 편집 대상 탐색 (호스트 하위 트리) */
  querySelectorAll<E extends Element>(selectors: string): NodeListOf<E>;
  /** 스코프 DOM 단건 조회 — id 타깃 해석 (CSS.escape('#id') 경로) */
  querySelector<E extends Element>(selectors: string): E | null;
  /** px→mm 환산 기준 (표시 전용 — 엔진 계산에 역주입 금지) */
  readonly ppm: number;
  /** 전역 기본 가이드 표시 토글 (문서/페이지 요소가 소유) */
  visibleGuide: boolean;
}