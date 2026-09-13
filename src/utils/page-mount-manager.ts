import { PARKED_PAGE_ATTR } from "@/constants";
import type { LayoutBoxElement } from "../components/layout/box.element";
import type { LayoutDocumentElement } from "../components/layout/document.element";

/**
 * `PageMountManager` 생성 옵션.
 */
export interface PageMountManagerOptions {
  /**
   * 가상화를 적용할 문서 요소. 최상위 `x-layout-box`가 페이지 단위이다.
   */
  document: LayoutDocumentElement;
  /**
   * IntersectionObserver root (스크롤 컨테이너). 생략 시 뷰포트를 사용한다.
   * scaled 서브트리 밖에 있어야 한다.
   */
  root?: Element | null;
  /**
   * 가시 페이지 앞뒤로 유지할 페이지 수. 기본값 `1`.
   * 마운트 판정은 인덱스 윈도우 방식이므로 `transform: scale`과 무관하다.
   */
  window?: number;
  /**
   * 화면 scale 보정 계수 getter. 플레이스홀더 footprint를 레이아웃 px로 환산할 때
   * 사용한다 (`getBoundingClientRect`는 transform 적용 픽셀을 반환하므로 scale로
   * 나눈다). 기본값은 항상 1. 호스트 줌 환경에서는
   * `() => docEl.editManager.scale`을 전달한다.
   */
  scale?: () => number;
  /**
   * 페이지 마운트 후 호출된다 (비동기 페인트 확정 후가 아니라 교체 직후).
   */
  onMount?: (id: string, element: LayoutBoxElement) => void;
  /**
   * 페이지 언마운트(보관) 직후 호출된다.
   */
  onUnmount?: (id: string) => void;
}

/**
 * DOM 가상화 마운트 매니저.
 *
 * 문서의 최상위 박스(페이지)를 `IntersectionObserver`로 감시하고, 윈도우
 * 밖 페이지는 `LayoutDocumentElement.parkPage()`로 DOM에서 분리(플레이스홀더로
 * 교체)하고 윈도우 안 페이지는 `unparkPage()`로 복원한다. 분리된 페이지의
 * 엔진은 유지되므로 재마운트는 캐시 히트로 동작한다.
 *
 * 설계 계약:
 * - 마운트 판정은 인덱스 윈도우(가시 페이지 ± `window`) 방식이다.
 *   `getBoundingClientRect` 기반 intersection은 transform을 반영하므로
 *   `transform: scale` 줌과 무관하게 동작한다. 경계 flapping 방지용 2px
 *   히스테리시스 밴드(`rootMargin`, root 좌표계라 스케일 무관) + rAF 병합 적용으로
 *   IO 배치당 DOM surgery가 발생하지 않는다.
 * - 마운트 단위는 최상위 박스 서브트리 전체이다. 부모-자식 connectedCallback
 *   순서가 DOM 삽입 순서를 따르므로 서브트리 통째 재삽입만 안전하다.
 * - 플레이스홀더 footprint는 fractional 레이아웃 px(`getBoundingClientRect /
 *   scale`)로 지정한다. 정수 반올림(`offsetWidth`)은 이웃을 경계 너머로 밀어
 *   flapping을 유발한다.
 * - 호스트가 매니저 몰래 문서 구조를 바꾸면(appendChildData 등) `refresh()`를
 *   호출해야 한다.
 * - 편집 중인 페이지는 `pin()`으로 고정한다. 포커스된 페이지가 언마운트되면
 *   IME 조합 상태가 소실되므로, 호스트는 focusChange에서 pin/unpin해야 한다.
 *
 * @example
 * ```ts
 * const manager = new PageMountManager({ document: docEl, window: 1 });
 * manager.attach();
 * editManager.addEventListener('focusChange', (e) => {
 *   // e.controller? — 포커스된 문단의 페이지를 pin
 *   const para = editManager.focusedParagraph;
 *   const pageId = para?.closest('x-layout-box')?.id;
 *   ...
 * });
 * ```
 */
export class PageMountManager {
  private readonly _doc: LayoutDocumentElement;
  private readonly _root: Element | null;
  private readonly _window: number;
  private readonly _scale: () => number;
  private readonly _onMount?: (id: string, element: LayoutBoxElement) => void;
  private readonly _onUnmount?: (id: string) => void;

  private _observer: IntersectionObserver | null = null;
  private _order: string[] = [];
  private readonly _nodes = new Map<string, Element>();
  private readonly _nodeToId = new Map<Element, string>();
  private readonly _mounted = new Set<string>();
  private readonly _pinned = new Set<string>();
  /**
   * 최신 가시 집합. IO 배치마다 갱신되고 `_apply()`가 소비한다.
   * 경계 flapping 배치는 여기서 흡수되어 DOM surgery까지 전파되지 않는다.
   */
  private readonly _visible = new Set<string>();
  private _applyScheduled = false;

  /**
   * @param options - 매니저 옵션
   * @throws {Error} `options.document`가 없을 경우
   * @throws {RangeError} `window`가 0 미만의 정수가 아닐 경우
   */
  constructor(options: PageMountManagerOptions) {
    if (!options || !options.document) {
      throw new Error('PageMountManager: options.document가 필요합니다.');
    }
    const window = options.window ?? 1;
    if (!Number.isInteger(window) || window < 0) {
      throw new RangeError(`PageMountManager: window는 0 이상의 정수여야 합니다 (입력값: ${options.window}).`);
    }
    this._doc = options.document;
    this._root = options.root ?? null;
    this._window = window;
    this._scale = options.scale ?? (() => 1);
    this._onMount = options.onMount;
    this._onUnmount = options.onUnmount;
  }

  /**
   * 감시를 시작한다. 현재 문서 구조를 스캔하고 모든 페이지·플레이스홀더를
   * observe한다. 초기 콜백에서 윈도우가 즉시 적용된다.
   *
   * @throws {Error} `IntersectionObserver`를 사용할 수 없는 환경일 경우
   */
  attach(): void {
    if (this._observer) return;
    if (typeof IntersectionObserver === 'undefined') {
      throw new Error('PageMountManager.attach: IntersectionObserver를 사용할 수 없는 환경입니다.');
    }
    this._observer = new IntersectionObserver(
      (entries) => this._onEntries(entries),
      // 2px 히스테리시스 밴드: mm 기반 fractional px 경계에 페이지가 정확히
      // 걸리면 반올림 노이즈로 0/1이 토글되어 park/unpark이 무한 반복된다
      // (실측). 밴드 안에서는 상태가 유지되어 flapping 배치가 DOM surgery까지
      // 전파되지 않는다. root 좌표계 px이므로 transform scale과 무관하다.
      { root: this._root, threshold: 0, rootMargin: '2px' },
    );
    this.refresh();
  }

  /**
   * 감시를 중단한다. 마운트 상태는 그대로 둔다 (언마운트하지 않는다).
   */
  detach(): void {
    this._observer?.disconnect();
    this._observer = null;
  }

  /**
   * 문서 구조를 다시 스캔한다. 호스트가 매니저 몰래 자식을 추가·삭제·재정렬한
   * 뒤 호출해야 한다. 재스캔 후 초기 콜백에서 윈도우가 다시 적용된다.
   */
  refresh(): void {
    const observer = this._observer;
    if (!observer) return;
    observer.disconnect();
    this._order = [];
    this._nodes.clear();
    this._nodeToId.clear();
    this._mounted.clear();
    this._visible.clear();
    for (const node of Array.from(this._doc.childNodes)) {
      if (!(node instanceof Element)) continue;
      if (node.nodeName === 'X-LAYOUT-BOX') {
        const id = node.id;
        if (!id) continue;
        this._track(id, node);
        this._mounted.add(id);
      } else if (node.nodeName === 'DIV') {
        const parkedId = node.getAttribute(PARKED_PAGE_ATTR);
        if (parkedId) this._track(parkedId, node);
      }
    }
  }

  /**
   * 페이지를 언마운트 대상에서 제외한다 (편집 중 페이지 고정).
   *
   * @param id - 고정할 페이지 id
   */
  pin(id: string): void {
    this._pinned.add(id);
  }

  /**
   * `pin()`을 해제한다.
   *
   * @param id - 해제할 페이지 id
   */
  unpin(id: string): void {
    this._pinned.delete(id);
  }

  /**
   * 현재 마운트된 페이지 id 목록을 문서 순서로 반환한다.
   *
   * @returns 마운트된 페이지 id 배열
   */
  get mountedIds(): string[] {
    return this._order.filter(id => this._mounted.has(id));
  }

  /**
   * 현재 고정된 페이지 id 목록을 반환한다.
   *
   * @returns 고정된 페이지 id 배열
   */
  get pinnedIds(): string[] {
    return [...this._pinned];
  }

  /**
   * @param id - 추적할 페이지 id
   * @param node - 박스 요소 또는 플레이스홀더
   */
  private _track(id: string, node: Element): void {
    this._order.push(id);
    this._nodes.set(id, node);
    this._nodeToId.set(node, id);
    this._observer?.observe(node);
  }

  /**
   * @param entries - IntersectionObserver 콜백 항목
   */
  private _onEntries(entries: IntersectionObserverEntry[]): void {
    let changed = false;
    for (const entry of entries) {
      const id = this._nodeToId.get(entry.target);
      if (id === undefined) continue;
      if (entry.isIntersecting) {
        if (!this._visible.has(id)) {
          this._visible.add(id);
          changed = true;
        }
      } else if (this._visible.delete(id)) {
        changed = true;
      }
    }
    if (changed) this._scheduleApply();
  }

  /**
   * rAF에 적용을 예약한다. IO 배치는 프레임당 여러 번 올 수 있고 detach 직후
   * 무효 배치가 섞이므로, 최신 `_visible` 기준으로 프레임당 1회만 적용한다.
   */
  private _scheduleApply(): void {
    if (this._applyScheduled) return;
    this._applyScheduled = true;
    requestAnimationFrame(() => {
      this._applyScheduled = false;
      this._apply();
    });
  }

  /**
   * 최신 가시 집합을 인덱스 윈도우로 확장해 마운트 상태를 수렴시킨다.
   */
  private _apply(): void {
    if (!this._observer) return;
    for (const id of [...this._visible]) {
      if (!this._nodes.has(id)) this._visible.delete(id);
    }
    if (this._visible.size === 0) return;

    const wanted = new Set<string>();
    const last = this._order.length - 1;
    for (const id of this._visible) {
      const idx = this._order.indexOf(id);
      if (idx < 0) continue;
      for (let i = Math.max(0, idx - this._window); i <= Math.min(last, idx + this._window); i++) {
        wanted.add(this._order[i]);
      }
    }

    for (const id of wanted) {
      if (!this._mounted.has(id)) this._mount(id);
    }
    for (const id of [...this._mounted]) {
      if (!wanted.has(id) && !this._pinned.has(id)) this._unmount(id);
    }
  }

  /**
   * 보관된 페이지를 복원하고 비동기 페인트를 확정한다.
   *
   * @param id - 마운트할 페이지 id
   */
  private _mount(id: string): void {
    const prev = this._nodes.get(id);
    const el = this._doc.unparkPage(id);
    if (!el) return;
    const observer = this._observer;
    if (observer && prev) observer.unobserve(prev);
    if (prev) this._nodeToId.delete(prev);
    this._nodes.set(id, el);
    this._nodeToId.set(el, id);
    if (observer) observer.observe(el);
    this._mounted.add(id);
    // 텍스트·테이블은 connectedCallback 경로에서 복원된다. 이미지 등
    // 비동기 페인트 확정만 여기서 수행한다 (테이블의 `void this.render()` 선례).
    void el.render();
    this._onMount?.(id, el);
  }

  /**
   * 페이지를 분리 보관하고 플레이스홀더에 분리 전 footprint를 지정한다.
   *
   * @param id - 언마운트할 페이지 id
   */
  private _unmount(id: string): void {
    const node = this._nodes.get(id);
    if (!node || node.nodeName !== 'X-LAYOUT-BOX') return;
    const box = node as unknown as LayoutBoxElement;
    // 분리 전 footprint 측정 — 연결 상태에서만 유효하므로 park보다 먼저 수행한다.
    // offsetWidth/Height는 정수 반올림이라 이웃 페이지를 fractional 경계 너머로
    // 밀어 flapping을 유발할 수 있으므로, fractional인 getBoundingClientRect를
    // scale로 나눈 레이아웃 px를 사용한다.
    const scale = this._scale() || 1;
    const rect = box.getBoundingClientRect();
    const width = rect.width / scale;
    const height = rect.height / scale;
    const computed = getComputedStyle(box);
    const isAbsolute = computed.position === 'absolute';
    const left = computed.left;
    const top = computed.top;
    const placeholder = this._doc.parkPage(id);
    if (!placeholder) return;
    // static 흐름 유지: offset 치수로 고정. absolute 박스는 계산 위치를 복사한다
    // (px 단위 — transform scale과 무관한 레이아웃 좌표계).
    placeholder.style.width = `${width}px`;
    placeholder.style.height = `${height}px`;
    if (isAbsolute) {
      placeholder.style.position = 'absolute';
      placeholder.style.left = left;
      placeholder.style.top = top;
    }
    const observer = this._observer;
    if (observer) {
      observer.unobserve(node);
      observer.observe(placeholder);
    }
    this._nodes.set(id, placeholder);
    this._nodeToId.delete(node);
    this._nodeToId.set(placeholder, id);
    this._mounted.delete(id);
    this._onUnmount?.(id);
  }
}
