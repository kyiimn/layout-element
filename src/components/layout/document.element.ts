import { PARKED_PAGE_ATTR } from "@/constants";
import { DocumentData, PageData, ParagraphStyle, TextStyle, ThreadData } from "@/types";
import { normalizeDocumentData } from "@/types";
import { LayoutPageElement, FontLoaderSingletonAdapter, ColorRegistrySingletonAdapter } from "./page.element";
import { LayoutParagraphElement } from "./paragraph.element";
import { EditManager } from "@/edit/edit-manager";
import type { EditManagerHost } from "@/edit/edit-manager-host";
import { DocumentEngine, PageEngine } from "@/engine";
import type { FontLoaderEngine, ColorRegistryEngine } from "@/engine";
import { FontLoader } from "@/resource/font-loader";
import { ColorRegistry } from "@/resource/color-registry";
import { flushThreadRelayout, syncThreadFramesToDom, hasUnsyncedThreadFrames, type ThreadRelayoutContext } from "@/utils/thread-relayout-coordinator";

const HOST_STYLE_ID = '__layout_host_style__';

/**
 * 문서 루트 요소. `<x-layout-document>` 커스텀 엘리먼트.
 *
 * Phase B(페이지 모델)의 최상위 계층이다. 문서는 페이지 배열과 스레드 정의,
 * 전역 기본 스타일을 소유한다:
 * ```
 * <x-layout-document>          ← 문서 (EditManager·스레드·park 소유)
 *   <x-layout-page id="p1">    ← 페이지 (그리드·박스·가이드·엔진 스코프)
 *     <x-layout-box> ...
 *   <x-layout-page id="p2">
 * ```
 *
 * - **EditManager는 문서당 1개** — 선택·포커스·모드가 페이지를 가로지른다.
 *   페이지·박스·문단의 `editManager` getter는 부모 체인을 타고 이 요소에
 *   도달한다 (table/tr/td 패턴과 동일).
 * - **스레드는 문서 소유** — 체인이 페이지를 가로지르므로 `DocumentEngine`이
 *   `ThreadEngine` 조정·story writeback·범위-증명 스킵을 소유한다. 페이지
 *   요소의 thread 요청은 이 요소로 위임된다.
 * - **보관(park) 단위는 페이지** — `parkPage()`가 `<x-layout-page>`를
 *   플레이스홀더로 교체하고 보관한다 (가상화 단위 승격).
 * - 페이지 엔진은 각 페이지 요소가 소유하며, 문서 엔진은 `adoptPageEngines()`
   으로 편입한다 (엔진 복제 방지 — 단일 소스 유지).
 */
export class LayoutDocumentElement extends HTMLElement implements EditManagerHost {
  private _shadowRoot: ShadowRoot;
  private _engine?: DocumentEngine;
  private _ppm: number = 0;

  private _rebuildingChildren = false;
  private _pendingData: DocumentData | null = null;

  /**
   * 가상화로 DOM에서 분리된 페이지 보관소 (G1 방어).
   *
   * `parkPage()`가 페이지 요소를 `PARKED_PAGE_ATTR` 플레이스홀더로 교체하고
   * 요소+스냅샷 데이터를 여기에 보관한다. 보관된 페이지는 `data` setter의
   * DOM 재생성 대상에서 제외되지만, `_collectPagesData()`가 엔진에 보관
   * 스냅샷을 합류시켜 스레딩·printPostData는 완결을 유지한다.
   */
  private _parkedPages = new Map<string, { element: LayoutPageElement }>();

  private _visibleGuide: boolean;

  /**
   * 문서 기준 기하 (용지 너비·높이·컬럼·간격, mm).
   *
   * 개별 페이지의 실제 크기가 아니라 문서 전체의 기준점이다. 페이지는 각자
   * 다른 사이즈를 가질 수 있으나, 새 페이지 추가 시 이 값이 기본값이 된다
   * (`appendChildData`의 생략 필드 보충).
   */
  private _width: number = 0;
  private _height: number = 0;
  private _columns: number | number[] = 1;
  private _gap: number | number[] = 0;
  private _paddingTop: number = 0;
  private _paddingRight: number = 0;
  private _paddingBottom: number = 0;
  private _paddingLeft: number = 0;
  private _pageStart: 'left' | 'right' = 'right';
  private _spreadPages: number = 2;

  private _paragraphStyle: ParagraphStyle = {};
  private _textStyle: TextStyle = {};

  /** 스레딩 정의 (옵셔널). `data` 세터에서 설정되어 엔진에 전달된다. */
  private _threads?: ThreadData[];

  /** 스레드 체인 재배치 예약 소스(편집 프레임 id) 집합. 마이크로태스크에서 소비. */
  private _threadRelayoutSources: Set<string> | null = null;
  private _threadRelayoutFlushing = false;

  /** 자기 layout() 진행 중 페이지의 조기 thread 확정 요청을 흡수한다. */
  private _suppressThreadConfirm = false;

  /**
   * 문서 소유 리소스 어댑터 (fontLoader/colorRegistry — 문서에서 관리).
   *
   * 싱글톤 래퍼이므로 기능적으로 동일하나, 소유권은 문서에 있다.
   * 문서 아래 페이지는 생성 시 이 인스턴스를 재사용한다.
   */
  private _fontLoaderAdapter?: FontLoaderSingletonAdapter;
  private _colorRegistryAdapter?: ColorRegistrySingletonAdapter;

  /** 문서 관리 리소스 어댑터. 페이지 요소가 부모 문서를 통해 소비한다. */
  get resources(): { fontLoader: FontLoaderEngine; colorRegistry: ColorRegistryEngine } {
    if (!this._fontLoaderAdapter) {
      this._fontLoaderAdapter = new FontLoaderSingletonAdapter(FontLoader.getInstance());
    }
    if (!this._colorRegistryAdapter) {
      this._colorRegistryAdapter = new ColorRegistrySingletonAdapter(ColorRegistry.getInstance());
    }
    return { fontLoader: this._fontLoaderAdapter, colorRegistry: this._colorRegistryAdapter };
  }

  /**
   * 이 문서 요소 전용 EditManager 인스턴스.
   *
   * constructor에서 생성되어 요소 생명주기 내내 존재한다.
   * 하위 page/box/paragraph 요소들은 parent 체인을 통해 이 인스턴스에 접근한다.
   */
  private _editManager: EditManager;

  /** 문서 요소 전용 EditManager 인스턴스 */
  get editManager(): EditManager { return this._editManager; }

  /**
   * 이 문서 요소에 연결된 DocumentEngine 인스턴스를 반환한다.
   *
   * @returns DocumentEngine 인스턴스. 연결 전이면 undefined.
   */
  get engine(): DocumentEngine | undefined { return this._engine; }

  /** 측정된 pixels-per-mm (표시 전용) */
  get ppm(): number { return this._ppm; }

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
    this._visibleGuide = true;
    // EditManagerHost 계약 구현 선언 — 페이지 위장 캐스팅 제거 (E-1).
    this._editManager = new EditManager(this);
  }

  connectedCallback() {
    this._measurePpm();
    this.addEventListener('mousedown', this._onPlaceGunMouseDown);
    window.addEventListener('keydown', this._onWindowKeyDown, true);
    this.layout();
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener('mousedown', this._onPlaceGunMouseDown);
    window.removeEventListener('keydown', this._onWindowKeyDown, true);
    this._editManager.reset();
  }

  private _onWindowKeyDown = (event: KeyboardEvent): void => {
    const path = event.composedPath();
    const inTable = path.some((el) => el instanceof HTMLElement && el.closest('x-layout-table'));
    const hasSelectedBoxInTd = this._editManager.selectedLayouts.some(box =>
      box instanceof HTMLElement && box.closest('x-layout-td')
    );

    if (event.key === 'F5') {
      if (this._editManager.layoutEditMode && (inTable || hasSelectedBoxInTd)) {
        event.preventDefault();
      }
    }
    if (event.key === 'Tab') {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLButtonElement || active instanceof HTMLSelectElement) {
        return;
      }
      const target = event.composedPath()[0];
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        return;
      }
      const handled = this._editManager.navigateByTab(event.shiftKey);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  };

  /**
   * Place Gun 활성 상태일 때 문서 빈 공간 mousedown을 EditManager에 위임한다.
   */
  private _onPlaceGunMouseDown = (event: MouseEvent): void => {
    const manager = this._editManager;
    if (!manager.placeGunActive) return;
    const nextItem = manager.placeGunItems[0];
    if (!nextItem || nextItem.contentType !== 'element') return;
    manager.handlePlaceGunDocumentMouseDown(this as unknown as LayoutPageElement, event);
  };

  private _measurePpm(): void {
    if (this._ppm > 0) return;
    const div = document.createElement('div');
    div.style.width = '100mm';
    div.style.height = '1px';
    div.style.position = 'absolute';
    div.style.top = '-10000px';
    div.style.left = '-10000px';
    div.style.visibility = 'hidden';
    document.body.appendChild(div);
    const pxWidth100mm = div.getBoundingClientRect().width;
    document.body.removeChild(div);
    this._ppm = pxWidth100mm / 100;
    if (this._ppm <= 0) {
      throw new Error(`LayoutDocumentElement: ppm 측정 실패 (${this._ppm}). 브라우저 렌더링 컨텍스트를 확인하세요.`);
    }
  }

  /**
   * 구조 계산: DocumentEngine 데이터 할당 및 엔진 생성/갱신.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected) return null;

    this._measurePpm();

    const docData = normalizeDocumentData({
      id: this.id || undefined,
      pages: this._collectPagesData(),
      threads: this._threads,
      paragraphStyle: this._paragraphStyle,
      textStyle: this._textStyle,
      width: this._width,
      height: this._height,
      columns: this._columns,
      gap: this._gap,
      pageStart: this._pageStart,
      spreadPages: this._spreadPages,
    });

    if (!this._engine) {
      const res = this.resources;
      this._engine = DocumentEngine.create(
        docData,
        res.fontLoader,
        res.colorRegistry,
        this._ppm,
      );
    } else {
      this._engine.data = docData;
      this._engine.ppm = this._ppm;
    }

    return this;
  }

  /**
   * 레이아웃 오케스트레이터. 페이지 자가 배치 → 엔진 편입 → 스레드 체인 순서.
   */
  layout() {
    if (!this.isConnected) return null;

    this._suppressThreadConfirm = true;
    try {
      this._layoutStructure();
      this._applyStyle();
      for (const page of this.items) {
        page.layout();
      }
      this._layoutPageOrder();
      this._engine?.adoptPageEngines(
        [...this.items]
          .sort((a, b) => (a.pageNumber ?? Number.MAX_SAFE_INTEGER) - (b.pageNumber ?? Number.MAX_SAFE_INTEGER))
          .map(e => e.engine)
          .filter((e): e is PageEngine => e !== undefined),
      );
      this._engine?.layout();
      this._syncThreadFramesToDom();
    } finally {
      this._suppressThreadConfirm = false;
    }
    return this;
  }

  /**
   * 자식 페이지를 문서 순서로 렌더링한다.
   */
  async render() {
    if (!this.isConnected) return null;
    for (const page of this.items) {
      await page.render();
    }
    if (this._hasUnsyncedThreadFrames()) {
      this.confirmThreadChain();
    }
    return this;
  }

  private _applyStyle() {
    if (!this.isConnected) return;

    let styleEl = this._shadowRoot.querySelector<HTMLStyleElement>(`style#${HOST_STYLE_ID}`);
    let needsInit = !styleEl
      || !styleEl.sheet
      || styleEl.sheet.cssRules.length === 0;

    if (needsInit) {
      if (styleEl) styleEl.remove();
      styleEl = document.createElement('style');
      styleEl.id = HOST_STYLE_ID;
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");
      styleEl.sheet.insertRule(":host { display: block; position: relative; width: fit-content; height: fit-content; }", 0);
      if (!this._shadowRoot.querySelector('slot')) {
        this._shadowRoot.appendChild(document.createElement('slot'));
      }
    }
  }

  get items(): LayoutPageElement[] {
    // localName 매칭 (instanceof 금지 — page.element와 순환 참조 회피).
    return Array.from(this.children).filter(
      (c): c is LayoutPageElement => c.localName === 'x-layout-page',
    );
  }

  /**
   * 페이지를 pageNumber 슬롯 순서로 펼침면(spread) 그리드에 절대 배치한다.
   *
   * 배치 순서는 문서 순서가 아니라 pageNumber가 소유한다. 번호 1 페이지는
   * 첫 행(커버행)에 단독으로 배치되며, 2번부터는 판독 순서대로 이후 행에
   * spreadPages개씩 채워진다. 행 인덱스: n=1 → 0, n≥2 → 1 + floor((n-2) /
   * spread). 배치는 항상 왼쪽→오른쪽이며, `pageStart`는 1페이지의 시작
   * 위치만을 결정한다 (`'right'`이면 커버행 우측 끝, `'left'`이면 좌측 끝).
   *
   * 좌표는 문서 기준 너비(`this._width`)가 소유한다: 슬롯 pitch는
   * `max(문서 너비, 페이지 폭)`이며, 문서 너비보다 넓은 페이지는 이웃 슬롯을
   * 밀어낸다 (겹침 없음). 행 높이는 `max(문서 기준 높이, 행 내 페이지 높이)`다.
   * 번호 구간이 행 전체를 건너뛰면 빈 행 개수만큼 문서 기준 높이의 실제
   * 공간을 소비한다 (행 사이만 — 선행 빈 행은 소비하지 않는다).
   *
   * 문서 너비가 미정(`_width === 0`)이면 그리드 계산이 불가능하므로 배치를
   * 건너뛴다 — 마크업에 페이지를 직접 주입하는 레거시 사용은 기존 정적
   * 흐름을 유지한다. DOM 기록은 좌표가 실제로 달라질 때만 일어난다.
   */
  private _layoutPageOrder(): void {
    const docWidth = this._width;
    const docHeight = this._height;
    const spread = Math.max(1, this._spreadPages);
    if (docWidth <= 0) return;

    type Entry = { id: string; num: number | undefined; node: Element; parked: boolean };
    const entries: Entry[] = [];
    for (const node of Array.from(this.childNodes)) {
      if (!(node instanceof Element)) continue;
      if (node.nodeName === 'X-LAYOUT-PAGE') {
        const el = node as unknown as LayoutPageElement;
        entries.push({ id: el.id, num: el.pageNumber, node, parked: false });
      } else if (node instanceof HTMLDivElement) {
        const parkedId = node.getAttribute(PARKED_PAGE_ATTR);
        if (parkedId) {
          const num = this._parkedPages.get(parkedId)?.element.pageNumber;
          entries.push({ id: parkedId, num, node, parked: true });
        }
      }
    }
    const indexed = entries.map((e, i) => ({ e, i }));
    indexed.sort((a, b) => {
      const na = a.e.num, nb = b.e.num;
      if (na === undefined && nb === undefined) return a.i - b.i;
      if (na === undefined) return 1;
      if (nb === undefined) return -1;
      return na - nb || a.i - b.i;
    });
    const sorted = indexed.map(x => x.e);

    const pageWidthOf = (en: Entry): number => {
      if (en.parked) {
        const w = this._parkedPages.get(en.id)?.element.width ?? 0;
        return w > 0 ? w : docWidth;
      }
      return Math.max(docWidth, (en.node as unknown as LayoutPageElement).width || docWidth);
    };
    const pageHeightOf = (en: Entry): number => {
      if (en.parked) {
        const h = this._parkedPages.get(en.id)?.element.height ?? 0;
        return h > 0 ? h : docHeight;
      }
      return (en.node as unknown as LayoutPageElement).height || docHeight;
    };

    interface Slot { en: Entry; slot: number; pitch: number; height: number; }
    const slots: Slot[] = [];
    let numberedMax = 0;
    for (const en of sorted) {
      if (en.num !== undefined && en.num > numberedMax) numberedMax = en.num;
    }
    let nextVirtual = Math.max(1, numberedMax + 1);
    for (const en of sorted) {
      const sn = en.num !== undefined ? Math.max(1, Math.floor(en.num)) : nextVirtual++;
      slots.push({ en, slot: sn, pitch: Math.max(docWidth, pageWidthOf(en)), height: pageHeightOf(en) });
    }

    // 커버 행 컨벤션 (국배판 펼침): 번호 1 페이지는 첫 행에 단독으로 배치되고,
    // 2번부터는 판독 순서대로 이후 행에 spreadPages개씩 채워진다.
    // 행 인덱스: n=1 → 0, n≥2 → 1 + floor((n-2) / spread).
    const rowOfSlot = (slot: number): number => (slot <= 1 ? 0 : 1 + Math.floor((slot - 2) / spread));
    const posOfSlot = (slot: number): number => (slot <= 1 ? 0 : (slot - 2) % spread);

    interface Row { top: number; height: number; }
    const rows = new Map<number, Row>();
    for (const s of slots) {
      const row = rowOfSlot(s.slot);
      if (!rows.has(row)) rows.set(row, { top: 0, height: Math.max(docHeight, s.height) });
      else if (s.height > rows.get(row)!.height) rows.get(row)!.height = Math.max(docHeight, s.height);
    }
    let cursorTop = 0;
    let lastRow = -1;
    for (const row of [...rows.keys()].sort((a, b) => a - b)) {
      const info = rows.get(row)!;
      const skipped = row - (lastRow + 1);
      if (skipped > 0) cursorTop += skipped * (docHeight > 0 ? docHeight : info.height);
      info.top = cursorTop;
      cursorTop += info.height;
      lastRow = row;
    }

    interface Placed extends Entry { left: number; top: number; }
    const placed: Placed[] = [];
    let totalW = 0;
    for (const row of rows.keys()) {
      const rowSlots = slots.filter(s => rowOfSlot(s.slot) === row);
      const gridColOf = (s: (typeof slots)[number]): number => {
        if (row === 0) return this._pageStart === 'right' ? spread - 1 : 0;
        return posOfSlot(s.slot);
      };
      const colStarts: number[] = [];
      let acc = 0;
      for (let c = 0; c < spread; c++) {
        colStarts.push(acc);
        const over = rowSlots
          .filter(s => {
            const p = posOfSlot(s.slot);
            return (row === 0
              ? (this._pageStart === 'right' ? spread - 1 : 0)
              : p) === c;
          })
          .reduce((mx, s) => Math.max(mx, s.pitch), docWidth);
        acc += over;
      }
      totalW = Math.max(totalW, acc);
      for (const s of rowSlots) {
        placed.push({ ...s.en, left: colStarts[gridColOf(s)]!, top: rows.get(row)!.top });
      }
    }

    let dirty = false;
    for (const p of placed) {
      const style = (p.node as HTMLElement).style;
      if (style.position !== 'absolute') { style.position = 'absolute'; dirty = true; }
      if (style.left !== `${p.left}mm`) { style.left = `${p.left}mm`; dirty = true; }
      if (style.top !== `${p.top}mm`) { style.top = `${p.top}mm`; dirty = true; }
    }
    const totalH = rows.size > 0
      ? Math.max(...[...rows.values()].map(r => r.top + r.height))
      : 0;
    const hostStyle = this.style;
    if (totalW > 0 && hostStyle.width !== `${totalW}mm`) {
      hostStyle.width = `${totalW}mm`;
      dirty = true;
    }
    if (totalH > 0 && hostStyle.height !== `${totalH}mm`) {
      hostStyle.height = `${totalH}mm`;
      dirty = true;
    }
    if (dirty) this._applyStyle();
  }

  /**
   * 엔진에 전달할 페이지 데이터를 조립한다. 마운트된 페이지는 DOM 순서의
   * `_rawData()`를, 분리 보관(park)된 페이지는 플레이스홀더 위치의 보관
   * 스냅샷을 사용한다 (가상화 여부와 무관하게 문서 순서 보존).
   */
  private _collectPagesData(): PageData[] {
    if (this._parkedPages.size === 0) {
      return this.items.map(e => e._rawData());
    }
    const out: PageData[] = [];
    for (const node of Array.from(this.childNodes)) {
      if (node.nodeName === 'X-LAYOUT-PAGE') {
        out.push((node as unknown as LayoutPageElement)._rawData());
      } else if (node instanceof HTMLDivElement) {
        const parkedId = node.getAttribute(PARKED_PAGE_ATTR);
        if (parkedId) {
          // 수집은 element.data(= engine.extractData)로 한다 — 분리 중에도
          // 페이지 엔진이 살아 있고 스레드 writeback이 상태를 갱신하므로
          // park 시점 스냅숏이 아닌 현재 엔진 상태가 진실이다 (감사 A-3).
          // flush-then-read (멱등): ensureCommitted가 서브트리를 커밋하고,
          // 편집 소유 PE를 건너뛰는 예외는 parked 요소에 적용되지 않는다
          // (컨트롤러 destroy된 detached 상태) — PE pending을 직접 커밋.
          const parked = this._parkedPages.get(parkedId);
          if (parked) {
            parked.element.engine?.ensureCommitted();
            for (const p of parked.element.querySelectorAll('x-layout-paragraph')) {
              const eng = p.engine;
              if (eng?.hasPendingChanges) eng.layoutText();
            }
            out.push(parked.element.data as PageData);
          }
        }
      }
    }
    return out;
  }

  /**
   * 스레드 배치를 재실행한다 (문서 스코프).
   */
  private _relayoutThreads(): void {
    const engine = this._engine;
    if (!engine?.data.threads?.length) return;
    engine.relayoutThreads();
  }

  /**
   * 스레드 체인 확정 — layout 종료 시점(모든 페이지 model push 후) 재실행.
   * 페이지 요소의 요청(`page._delegateThreadChainConfirm`)이 도달하는 진입점.
   * 자기 layout() 중에는 흡수 플래그로 무시된다 (문서 layout 종료 시 1회 실행).
   */
  confirmThreadChain(): void {
    if (this._suppressThreadConfirm) return;
    this._relayoutThreads();
    this._syncThreadFramesToDom();
  }

  /**
   * 스레드 프레임 편집(타이핑) 전파 — 체인 재배치를 예약한다.
   *
   * @param sourceFrameId - 편집이 발생한 스레드 프레임 id
   */
  requestThreadRelayout(sourceFrameId: string): void {
    if (!this._threadRelayoutSources) {
      const sources = new Set<string>();
      this._threadRelayoutSources = sources;
      queueMicrotask(() => {
        this._threadRelayoutSources = null;
        this._flushThreadRelayout(sources);
      });
    }
    this._threadRelayoutSources.add(sourceFrameId);
  }

  /**
   * 예약된 스레드 체인 재배치를 실행한다 — 공용 coordinator 위임 (C-1).
   *
   * 본체 로직(writeback·동기화·렌더 범위·재진입 차단)은
   * `thread-relayout-coordinator.ts`가 소유한다. 재진입 차단 플래그는
   * 요소별 인스턴스 상태로 유지한다 (flush 중 파생 relayout 이월 계약 — E-2).
   *
   * @param sources - 편집이 발생한 프레임 id 집합
   */
  private _flushThreadRelayout(sources: Set<string>): void {
    if (this._threadRelayoutFlushing) return;
    this._threadRelayoutFlushing = true;
    try {
      flushThreadRelayout(this._threadRelayoutContext(), sources);
    } finally {
      this._threadRelayoutFlushing = false;
    }
  }

  /** coordinator 주입 컨텍스트. */
  private _threadRelayoutContext(): ThreadRelayoutContext {
    return {
      engine: this._engine,
      focusedParagraphId: this._editManager.focusedParagraph?.id,
      queryParagraphs: () => this.querySelectorAll<LayoutParagraphElement>('x-layout-paragraph'),
    };
  }

  /**
   * 스레딩 프레임 DOM model을 엔진 트리 PE(스레드 배치 완료 상태)로 동기화한다
   * — 공용 coordinator 위임 (C-1).
   */
  private _syncThreadFramesToDom(): void {
    syncThreadFramesToDom(this._threadRelayoutContext());
  }

  /**
   * 스레드 프레임 중 엔진 트리 PE가 아직 스레드 배치가 적용되지 않은 것이 있는지
   * — 공용 coordinator 위임 (C-1).
   */
  private _hasUnsyncedThreadFrames(): boolean {
    return hasUnsyncedThreadFrames(this._threadRelayoutContext());
  }

  /**
   * PageData를 받아 `<x-layout-page>` 요소를 생성하여 추가하고, 생성된 요소를 반환한다.
   *
   * @param child - 추가할 페이지 데이터
   * @returns 생성된 LayoutPageElement
   */
  appendChildData(child: PageData): LayoutPageElement {
    if (child.pageNumber === undefined) {
      child = { ...child, pageNumber: this.items.length + 1 };
    }
    const pageEl = document.createElement('x-layout-page') as LayoutPageElement;
    const { width, height, columns, gap, paddingTop, paddingRight, paddingBottom, paddingLeft, paragraphStyle, textStyle, ...rest } = child;
    pageEl.data = {
      ...rest,
      width: width ?? this._width,
      height: height ?? this._height,
      columns: columns ?? this._columns,
      gap: gap ?? this._gap,
      paddingTop: paddingTop ?? this._paddingTop,
      paddingRight: paddingRight ?? this._paddingRight,
      paddingBottom: paddingBottom ?? this._paddingBottom,
      paddingLeft: paddingLeft ?? this._paddingLeft,
      paragraphStyle: paragraphStyle ?? this._paragraphStyle,
      textStyle: textStyle ?? this._textStyle,
    };
    this.appendChild(pageEl);
    this.layout();
    return pageEl;
  }

  /**
   * 데이터 기반 자식 페이지 삭제.
   *
   * @param id - 삭제할 페이지의 id
   */
  removeChildData(id: string): void {
    if (this._parkedPages.has(id)) {
      this._parkedPages.delete(id);
      this.querySelector(`div[${PARKED_PAGE_ATTR}="${CSS.escape(id)}"]`)?.remove();
    }
    const child = this.items.find(e => e.id === id);
    if (!child) return;
    Element.prototype.remove.call(child);
    this.layout();
    this.render();
  }

  /**
   * 페이지 요소를 DOM에서 분리하고 보관한다 (DOM 가상화 — 페이지 단위).
   *
   * 보관소는 요소 참조만 유지한다 — 페이지 엔진(`LayoutPageElement.engine`)이
   * 분리 중에도 계속 살아 있고 스레드 writeback이 그 상태를 갱신하므로,
   * park 시점 데이터 스냅숏을 별도로 저장하면 제2의 진실 소스가 되어 수집 시
   * 엔진 상태를 롤백시킨다 (감사 A-3). 수집 경로는 `element.data`
   * (engine.extractData)를 읽는다.
   *
   * @param id - 분리할 페이지의 id
   * @returns 생성된 플레이스홀더. 이미 보관 중이면 기존 플레이스홀더,
   *   대상이 없으면 `null`
   */
  parkPage(id: string): HTMLDivElement | null {
    if (this._parkedPages.has(id)) {
      return this.querySelector<HTMLDivElement>(`div[${PARKED_PAGE_ATTR}="${CSS.escape(id)}"]`);
    }
    const child = this.items.find(e => e.id === id);
    if (!child) return null;
    // 보관 경계에서 pending 개별 setter 변경을 커밋한다 — 수집 경로가
    // element.data(= engine.extractData)를 읽는데 extractData는 dirty를
    // 자가 치유하지 않고 throw한다 (DirtyPendingError 계약 — flush-then-read).
    // 스냅숏 저장은 제2의 진실 소스라 금지 (감사 A-3).
    child.engine?.ensureCommitted();
    const placeholder = document.createElement('div');
    placeholder.setAttribute(PARKED_PAGE_ATTR, id);
    child.replaceWith(placeholder);
    this._parkedPages.set(id, { element: child });
    return placeholder;
  }

  /**
   * 보관된 페이지 요소를 플레이스홀더 자리에 복원한다.
   *
   * @param id - 복원할 페이지의 id
   * @returns 복원된 페이지 요소. 보관 내역이 없고 이미 마운트되어 있으면 그 요소,
   *   둘 다 없으면 `null`
   */
  unparkPage(id: string): LayoutPageElement | null {
    const parked = this._parkedPages.get(id);
    if (!parked) return this.items.find(e => e.id === id) ?? null;
    const placeholder = this.querySelector(`div[${PARKED_PAGE_ATTR}="${CSS.escape(id)}"]`);
    if (placeholder) {
      placeholder.replaceWith(parked.element);
    } else {
      this.appendChild(parked.element);
    }
    this._parkedPages.delete(id);
    return parked.element;
  }

  /**
   * 현재 보관 중인(언마운트된) 페이지 id 목록을 반환한다.
   */
  get parkedPageIds(): string[] {
    return [...this._parkedPages.keys()];
  }

  set data(data: DocumentData) {
    // 문서 요소 자신의 id는 자동 생성하지 않는다 — HTML 마크업이 부여한
    // id(`<x-layout-document id="doc">`)를 data 주입이 난수로 덮어쓰면
    // document.getElementById가 요소를 못 찾는다.
    this._rebuildingChildren = true;
    this._pendingData = data;
    try {
      if (data.id !== undefined) this.id = data.id;
      if (data.width !== undefined) this._width = data.width;
      if (data.height !== undefined) this._height = data.height;
      if (data.columns !== undefined) this._columns = data.columns;
      if (data.gap !== undefined) this._gap = data.gap;
      if (data.paddingTop !== undefined) this._paddingTop = data.paddingTop;
      if (data.paddingRight !== undefined) this._paddingRight = data.paddingRight;
      if (data.paddingBottom !== undefined) this._paddingBottom = data.paddingBottom;
      if (data.paddingLeft !== undefined) this._paddingLeft = data.paddingLeft;
      if (data.pageStart !== undefined) this._pageStart = data.pageStart;
      if (data.spreadPages !== undefined) this._spreadPages = data.spreadPages;
      if (data.paragraphStyle !== undefined) this._paragraphStyle = data.paragraphStyle;
      if (data.textStyle !== undefined) this._textStyle = data.textStyle;
      this._threads = data.threads;

      const normalized = normalizeDocumentData(data);
      const docData: DocumentData = {
        ...normalized,
        id: this.id || undefined,
        pageStart: this._pageStart,
        spreadPages: this._spreadPages,
        width: this._width,
        height: this._height,
        columns: this._columns,
        gap: this._gap,
        threads: this._threads,
        paragraphStyle: this._paragraphStyle,
        textStyle: this._textStyle,
      };
      const res = this.resources;
      if (!this._engine) {
        this._engine = DocumentEngine.create(
          docData,
          res.fontLoader,
          res.colorRegistry,
          this._ppm,
        );
      } else {
        this._engine.data = docData;
        this._engine.ppm = this._ppm;
      }
      const existingPages = this.items;
      const existingById = new Map<string, LayoutPageElement>();
      for (const page of existingPages) {
        if (page.id) existingById.set(page.id, page);
      }

      // 정규화된 pages로 reconcile — 레거시 입력(children 루트)은
      // 1원소 pages로 래핑되어 자식 유실 없이 복원된다.
      const pages = normalized.pages ?? [];
      const usedIds = new Set<string>();

      for (let i = 0; i < pages.length; i++) {
        // 페이지 번호: 호스트 지정값 우선, 미지정 시 문서 순서(1-based) 부여.
        // 번호는 저장 가능한 데이터이므로 자식 데이터에 주입해 왕복 보존한다.
        const rawChild = pages[i]!;
        const child = rawChild.pageNumber === undefined
          ? { ...rawChild, pageNumber: i + 1 }
          : rawChild;
        const childId = child.id;

        if (childId && existingById.has(childId)) {
          const existingPage = existingById.get(childId)!;
          usedIds.add(childId);
          (existingPage as unknown as { _rebuildingChildren?: boolean })._rebuildingChildren = true;
          try {
            existingPage.data = child;
          } finally {
            (existingPage as unknown as { _rebuildingChildren?: boolean })._rebuildingChildren = false;
          }
          if (existingPage.parentElement === this && existingPages[i] === existingPage) {
            continue;
          }
          this.appendChild(existingPage);
        } else {
          if (childId && this._parkedPages.has(childId)) {
            // G1(가상화): 분리 보관 중인 페이지는 DOM을 재생성하지 않는다.
            // 요소 props만 갱신한다 — 스냅숏은 없고 엔진이 진실 소스다 (A-3).
            const parked = this._parkedPages.get(childId)!;
            usedIds.add(childId);
            parked.element.data = child;
            // A-4: placeholder도 reconcile 순서에 맞춰 이동한다 — mounted
            // 페이지의 appendChild 재정렬이 placeholder를 건드리지 않으면
            // DOM 순서(_collectPagesData의 수집 순서)가 데이터 순서와 어긋나
            // 엔진에 잘못된 페이지 순서가 주입된다. appendChild는 이미 올바른
            // 순서(마지막 자식)일 때도 안전(no-op 위치)이다.
            const placeholder = this.querySelector<HTMLDivElement>(
              `div[${PARKED_PAGE_ATTR}="${CSS.escape(childId)}"]`,
            );
            if (placeholder) this.appendChild(placeholder);
            continue;
          }
          const pageEl = document.createElement('x-layout-page') as LayoutPageElement;
          pageEl.data = child;
          this.appendChild(pageEl);
          if (childId) usedIds.add(childId);
        }
      }

      for (const page of existingPages) {
        if (page.id && !usedIds.has(page.id)) {
          Element.prototype.remove.call(page);
        }
      }

      // 보관 중인데 새 data.pages에 없는 페이지(보관 중 삭제)는 보관소와
      // 플레이스홀더를 함께 정리한다.
      if (this._parkedPages.size > 0) {
        const childIds = new Set(pages.map(c => c.id));
        for (const parkedId of [...this._parkedPages.keys()]) {
          if (!childIds.has(parkedId)) {
            this._parkedPages.delete(parkedId);
            this.querySelector(`div[${PARKED_PAGE_ATTR}="${CSS.escape(parkedId)}"]`)?.remove();
          }
        }
      }

      this._rebuildingChildren = true;
      try {
        this.layout();
      } finally {
        this._rebuildingChildren = false;
      }
      this.render();
    } finally {
      this._rebuildingChildren = false;
      this._pendingData = null;
    }
  }

  get data() {
    if (this._rebuildingChildren && this._pendingData) {
      return this._pendingData;
    }
    if (this._engine?.extractData) return this._engine.extractData;
    return this._rawData();
  }

  _rawData() {
    return {
      id: this.id || undefined,
      width: this._width,
      height: this._height,
      columns: this._columns,
      gap: this._gap,
      paddingTop: this._paddingTop,
      paddingRight: this._paddingRight,
      paddingBottom: this._paddingBottom,
      paddingLeft: this._paddingLeft,
      pageStart: this._pageStart,
      spreadPages: this._spreadPages,
      paragraphStyle: this.paragraphStyle,
      textStyle: this.textStyle,
      threads: this._threads,
      pages: this._collectPagesData(),
    }
  }

  get paragraphStyle() { return this._paragraphStyle; }
  get textStyle() { return this._textStyle; }
  /** 스레딩 정의 (옵셔널) */
  get threads() { return this._threads; }

  /** 문서 기준 용지 너비 (mm) — 새 페이지 추가 시 기본값 */
  get width() { return this._width; }
  /** 문서 기준 용지 높이 (mm) — 새 페이지 추가 시 기본값 */
  get height() { return this._height; }
  /** 문서 기준 컬럼 그리드 — 새 페이지 추가 시 기본값 */
  get columns() { return this._columns; }
  /** 문서 기준 컬럼 간격 — 새 페이지 추가 시 기본값 */
  get gap() { return this._gap; }
  /** 문서 기준 상단 여백 — 새 페이지 추가 시 기본값 */
  get paddingTop() { return this._paddingTop; }
  /** 문서 기준 우측 여백 — 새 페이지 추가 시 기본값 */
  get paddingRight() { return this._paddingRight; }
  /** 문서 기준 하단 여백 — 새 페이지 추가 시 기본값 */
  get paddingBottom() { return this._paddingBottom; }
  /** 문서 기준 좌측 여백 — 새 페이지 추가 시 기본값 */
  get paddingLeft() { return this._paddingLeft; }
  /** 페이지 시작 방향 ('right' 기본) — 펼친면 계산의 기준 */
  get pageStart() { return this._pageStart; }
  /** 펼친면 구성 페이지 수 (2 기본) */
  get spreadPages() { return this._spreadPages; }

  get visibleGuide() { return this._visibleGuide; }
  get type() { return 'document' as const; }
  get zIndex() { return 0; }

  /**
   * EditManagerHost 문서 식별 계약 (E-1).
   *
   * EditManager의 스레드 엔진 해석(`_threadEngine`)이 duck-typing
   * `type === 'document'` 우회 판정 대신 이 메서드로 문서 루트를 식별한다.
   * @returns 문서 호스트이므로 항상 true
   */
  isDocumentHost(): boolean { return true; }

  set visibleGuide(value: boolean) {
    if (this._visibleGuide === value) return;
    this._visibleGuide = value;
    for (const page of this.items) {
      page.visibleGuide = value;
    }
  }

  set paragraphStyle(value: ParagraphStyle) {
    if (this._paragraphStyle === value) return;
    this._paragraphStyle = value;
    this.layout();
    this.render();
  }

  set textStyle(value: TextStyle) {
    if (this._textStyle === value) return;
    this._textStyle = value;
    this.layout();
    this.render();
  }
}

customElements.define('x-layout-document', LayoutDocumentElement);