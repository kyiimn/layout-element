import { Z_INDEX_TYPE_LABEL, PARKED_PAGE_ATTR } from "@/constants";
import { PageData, ParagraphStyle, TextStyle, BoxData, Font, CMYKColorSet, ThreadData } from "@/types";
import { LayoutBoxElement } from "./box.element";
import { LayoutParagraphElement } from "./paragraph.element";
import { LayoutImageElement } from "./image.element";
import { LayoutGuideColumnElement } from "./guide-column.element";
import type { LayoutTableElement } from "./table.element";
import type { LayoutDocumentElement } from "./document.element";
import type { FlipLayoutOptions } from "@/engine";
import { EditManager } from "@/edit/edit-manager";
import type { EditManagerHost } from "@/edit/edit-manager-host";
import { PageEngine, BoxEngine, DocumentEngine } from "@/engine";
import type { FontLoaderEngine, ColorRegistryEngine, ParsedFont, GridCalculatorEngine } from "@/engine";
import { FontLoader } from "@/resource/font-loader";
import { ColorRegistry } from "@/resource/color-registry";
import { flushThreadRelayout, syncThreadFramesToDom, hasUnsyncedThreadFrames, type ThreadRelayoutContext } from "@/utils/thread-relayout-coordinator";

/**
 * `FontLoader` 싱글톤을 `FontLoaderEngine` 인터페이스로 래핑하는 어댑터.
 *
 * 브라우저 환경에서 `FontLoader`가 `FontFace` 등록과 opentype.js 파싱을
 * 모두 수행하므로, 엔진 계층에 메트릭 조회만 위임한다.
 */
export class FontLoaderSingletonAdapter implements FontLoaderEngine {
  private _fl: FontLoader;

  constructor(fl: FontLoader) {
    this._fl = fl;
  }

  get ready(): boolean {
    return this._fl.ready;
  }

  async init(fonts: Font[]): Promise<void> {
    await this._fl.init(fonts);
  }

  getParsedFont(fontName?: string): ParsedFont | null {
    return this._fl.getParsedFont(fontName) as unknown as ParsedFont | null;
  }

  getFontFamily(fontName?: string): string {
    return this._fl.getFontFamily(fontName);
  }
}

/**
 * `ColorRegistry` 싱글톤을 `ColorRegistryEngine` 인터페이스로 래핑하는 어댑터.
 */
export class ColorRegistrySingletonAdapter implements ColorRegistryEngine {
  private _cr: ColorRegistry;

  constructor(cr: ColorRegistry) {
    this._cr = cr;
  }

  get ready(): boolean {
    return this._cr.ready;
  }

  init(colorSet: CMYKColorSet): void {
    void this._cr.init(colorSet);
  }

  get(name: string): { c: number; m: number; y: number; k: number } {
    return this._cr.get(name);
  }

  getCSSColor(name: string): string {
    return this._cr.getCSSColor(name);
  }

  getOpacityHex(opacity: number): string {
    return this._cr.getOpacityHex(opacity);
  }
}

/**
 * 문서 루트 요소. `<x-layout-page>` 커스텀 엘리먼트.
 *
 * `PageData`를 받아 전체 렌더링 파이프라인을 조율한다.
 *
 * 렌더링 파이프라인:
 * 1. `renderLayout()` - 동기. DOM 트리 구축, 자식 박스 생성, `GridCalculator` 생성
 * 2. `renderImage()` - 비동기. 이미지 로딩 및 `<canvas>` 크롭, 재귀 전파
 * 3. `renderText()` - 동기. 텍스트 래핑, 컬럼 엘리먼트 생성
 *
 * 주요 책임:
 * - `ColorRegistry`, `FontLoader` 싱글턴 초기화
 * - 최상위 `InheritStyle` 생성 및 자식에게 전파
 * - 컬럼 가이드(`<x-layout-guide-column>`) 렌더링
 */
export class LayoutPageElement extends HTMLElement implements EditManagerHost {
  private _engine?: PageEngine;
  private _ppm: number = 0;

  private _shadowRoot: ShadowRoot;
  private _root?: HTMLDivElement;
  private _labelEl: HTMLDivElement | null = null;

  /** `data` 세터에서 자식을 재구축할 때 observer 중복 트리거를 방지하는 플래그. */
  private _rebuildingChildren = false;

  /** `_rebuildingChildren`이 true인 동안 getter가 반환할 캐시된 데이터. */
  private _pendingData: PageData | null = null;

  /**
   * 가상화로 DOM에서 분리된 페이지 박스 보관소 (G1 방어).
   *
   * `parkPage()`가 박스 요소를 `PARKED_PAGE_ATTR` 플레이스홀더로 교체하고
   * 요소+스냅샷 데이터를 여기에 보관한다. 보관된 페이지는 `data` setter의
   * DOM 재생성 대상에서 제외되지만, `_collectChildrenData()`가 엔진
   * `childrenData`에 합류시켜 엔진 트리·스레딩·printPostData는 완결을 유지한다.
   */
  private _parkedPages = new Map<string, { element: LayoutBoxElement }>();

  private _visibleGuide: boolean;

  private _width: number = 0;
  private _height: number = 0;
  private _paddingTop: number = 0;
  private _paddingBottom: number = 0;
  private _paddingLeft: number = 0;
  private _paddingRight: number = 0;

  private _columns: number | number[] = 1;
  private _gap: number | number[] = 0;
  private _pageNumber?: number;

  private _paragraphStyle: ParagraphStyle = {};
  private _textStyle: TextStyle = {};

  /** 스레딩 정의 (옵셔널). `data` 세터에서 설정되어 엔진에 전달된다. */
  private _threads?: ThreadData[];

  /** 스레드 체인 재배치 예약 소스(편집 프레임 id) 집합. 마이크로태스크에서 소비. */
  private _threadRelayoutSources: Set<string> | null = null;
  private _threadRelayoutFlushing = false;

  /**
   * 독립 루트용 암묵 문서 엔진. 문서 요소 아래가 아닌 페이지가 threads를
   * 가지면 문서 스코프 조정을 위해 사용한다 (스레드 단일 소유 원칙 유지 —
   * PageEngine이 아닌 DocumentEngine이 스레드를 소유).
   */
  private _threadDocEngine?: DocumentEngine;

  /**
   * 이 문서 요소 전용 EditManager 인스턴스.
   *
   * constructor에서 생성되어 요소 생명주기 내내 존재한다.
   * 하위 box/paragraph 요소들은 parent 체인을 통해 이 인스턴스에 접근한다.
   */
  private _editManager: EditManager | null = null;

  /**
   * 이 페이지가 소속된 문서(또는 자기 자신이 루트일 때 자기 자신)의
   * EditManager 인스턴스를 반환한다.
   *
   * 문서(`<x-layout-document>`) 아래에 있으면 문서의 인스턴스를 위임받고,
   * 독립 루트(레거시 단일 페이지 구성)이면 자기 자신의 인스턴스를 소유한다.
   *
   * @returns EditManager 인스턴스.
   */
  get editManager(): EditManager {
    const docEl = this._findDocumentElement();
    if (docEl) return docEl.editManager;
    if (!this._editManager) {
      this._editManager = new EditManager(this);
    }
    return this._editManager;
  }

  /**
   * 부모 체인을 타고 소속 문서 요소를 찾는다.
   *
   * @returns 문서 요소. 문서 아래가 아니면 `null`.
   */
  _findDocumentElement(): LayoutDocumentElement | null {
    // localName + 메서드 존재 여부로 판정한다 (instanceof 금지 —
    // document.element와 순환 참조 회피. 메서드 검사는 모듈 평가 순서상
    // page가 먼저 upgrade되어 조상이 아직 미승인 plain Element인 경우를
    // 제외한다 — 이 경우 standalone 경로로 동작하고 문서 upgrade 후 재확정).
    let el: Element | null = this.parentElement;
    while (el) {
      if (el.localName === 'x-layout-document'
        && typeof (el as unknown as { confirmThreadChain?: unknown }).confirmThreadChain === 'function') {
        return el as unknown as LayoutDocumentElement;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * 이 문서 요소에 연결된 PageEngine 인스턴스를 반환한다.
   *
   * 엔진은 `connectedCallback`에서 ppm 측정 후 생성되며,
   * 하위 box/paragraph 요소들이 엔진 트리에 접근할 수 있도록 한다.
   *
   * @returns PageEngine 인스턴스. 연결 전이면 undefined.
   */
  get engine(): PageEngine | undefined { return this._engine; }

  /**
   * 이 문서의 GridCalculatorEngine을 반환한다 (엔진 기반).
   *
   * @returns GridCalculatorEngine. 엔진이 없으면 undefined.
   */
  get model(): GridCalculatorEngine | undefined { return this._engine?.gridCalculator; }

  /**
   * 측정된 pixels-per-mm 값을 반환한다.
   *
   * @returns ppm 값. 측정 전이면 0.
   */
  get ppm(): number { return this._ppm; }

  /**
   * ppm을 무효화하고 재측정한다.
   * 줌 레벨 변경이나 CSS transform 후 호출해야 한다.
   */
  resetPpm(): void {
    this._ppm = 0;
    if (this._engine) {
      this._measurePpm();
      this._engine.ppm = this._ppm;
    }
  }

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });
    this._visibleGuide = true;
  }

  connectedCallback() {
    this._measurePpm();
    // 문서 아래 페이지는 문서 요소가 전역 리스너를 소유한다 (중복 Tab 이동 방지).
    // 독립 루트일 때만 자체 등록한다.
    if (!this._findDocumentElement()) {
      this.addEventListener('mousedown', this._onPlaceGunMouseDown);
      window.addEventListener('keydown', this._onWindowKeyDown, true);
    }
    this.layout();
    if (this._isDisplayPassDeferred()) return;
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener('mousedown', this._onPlaceGunMouseDown);
    window.removeEventListener('keydown', this._onWindowKeyDown, true);
    if (this._editManager) this._editManager.reset();
  }

  private _onWindowKeyDown = (event: KeyboardEvent): void => {
    if (this._findDocumentElement()) return;
    const path = event.composedPath();
    const inTable = path.some((el) => el instanceof HTMLElement && el.closest('x-layout-table'));
    const hasSelectedBoxInTd = this.editManager.selectedLayouts.some(box =>
      box instanceof HTMLElement && box.closest('x-layout-td')
    );

    if (event.key === 'F5') {
      if (this.editManager.layoutEditMode && (inTable || hasSelectedBoxInTd)) {
        event.preventDefault();
      }
    }
    if (event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      if (!hasSelectedBoxInTd) return;
      const focusedTable = this._findFocusedTable();
      if (focusedTable) {
        const kc = (focusedTable as unknown as { keyboardController?: { selection: unknown } }).keyboardController;
        if (kc && kc.selection) {
          event.preventDefault();
        }
      }
    }
    if (event.key === 'Tab') {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLButtonElement || active instanceof HTMLSelectElement) {
        return;
      }
      // paragraph shadow DOM 내부의 편집 textarea: activeElement은 host로
      // retarget되므로 위 검사를 통과한다. composedPath()[0]이 실제 이벤트
      // 대상(편집 textarea)인지 검사하여 TextEditController가 Tab을 처리하게 한다.
      const target = event.composedPath()[0];
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        return;
      }
      const handled = this.editManager.navigateByTab(event.shiftKey);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  };

  private _findFocusedTable(): LayoutTableElement | null {
    const focused = this.editManager.focusedParagraph;
    if (!focused) return null;
    const td = focused.closest('x-layout-td');
    if (!td) return null;
    const table = td.closest('x-layout-table');
    return table as LayoutTableElement | null;
  }

  /**
   * Place Gun 활성 상태일 때 document 빈 공간 mousedown을 EditManager에 위임한다.
   *
   * box 자식에서 발생한 mousedown은 box의 `_onPlaceGunMouseDown`이 먼저 처리하고
   * `stopPropagation`을 호출하므로 여기에 도달하지 않는다.
   * document 빈 공간 클릭 시 element 항목만 주입을 시도한다.
   */
   private _onPlaceGunMouseDown = (event: MouseEvent): void => {
    if (this._findDocumentElement()) return;
    const manager = this.editManager;
    if (!manager.placeGunActive) return;
    const nextItem = manager.placeGunItems[0];
    if (!nextItem || nextItem.contentType !== 'element') return;
    manager.handlePlaceGunDocumentMouseDown(this, event);
  };

  /**
   * 브라우저 DPI를 측정하여 ppm(pixels-per-mm)을 계산한다.
   * 100mm div를 DOM에 추가하여 getBoundingClientRect로 픽셀 폭을 측정.
   */
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
      throw new Error(`LayoutPageElement: ppm 측정 실패 (${this._ppm}). 브라우저 렌더링 컨텍스트를 확인하세요.`);
    }
  }

  /**
   * 구조 계산: PageEngine 데이터 할당 및 엔진 생성/갱신.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected) return null;

    this._measurePpm();

    const hostDoc = this._findDocumentElement();
    const hostRes = hostDoc?.resources;
    const fontLoader = hostRes?.fontLoader ?? new FontLoaderSingletonAdapter(FontLoader.getInstance());
    const colorRegistry = hostRes?.colorRegistry ?? new ColorRegistrySingletonAdapter(ColorRegistry.getInstance());
    const docData: PageData = {
      id: this.id,
      width: this._width,
      height: this._height,
      paddingTop: this._paddingTop,
      paddingBottom: this._paddingBottom,
      paddingLeft: this._paddingLeft,
      paddingRight: this._paddingRight,
      columns: this._columns,
      gap: this._gap,
      pageNumber: this._pageNumber,
      paragraphStyle: this._paragraphStyle,
      textStyle: this._textStyle,
      threads: this._threads,
    };
    if (!this._engine) {
      this._engine = PageEngine.create(docData, fontLoader, colorRegistry, this._ppm);
    } else {
      this._engine.data = docData;
      this._engine.ppm = this._ppm;
    }

    this._engine.childrenData = this._collectChildrenData();
    this._engine.layout();

    if (this._engine.newEnginesCreated) {
      this._syncEngineIdsToDom();
    }

    return this;
  }

  /**
   * 엔진 `childrenData`를 조립한다. 마운트된 박스는 DOM 순서의 `_rawData()`를,
   * 분리 보관(park)된 페이지는 플레이스홀더 위치의 보관 요소 `data`
   * (engine.extractData)를 사용한다.
   *
   * 플레이스홀더가 원래 DOM 인덱스에 남아 있으므로 엔진 자식 순서는 가상화
   * 여부와 무관하게 항상 문서 순서와 일치한다. 보관 페이지가 하나도 없으면
   * 기존 경로(`items.map`)와 byte-identical한 결과를 반환한다.
   *
   * 보관소는 요소 참조만 유지한다 — 보관 중에도 박스 엔진이 살아 있고
   * park 시점 스냅숏을 저장하면 수집 시 엔진 상태를 롤백시킨다 (감사 A-3).
   *
   * @returns 엔진에 전달할 최상위 박스 데이터 배열
   */
  private _collectChildrenData(): BoxData[] {
    if (this._parkedPages.size === 0) {
      return this.items.map(e => e._rawData());
    }
    const out: BoxData[] = [];
    for (const node of Array.from(this.childNodes)) {
      if (node.nodeName === 'X-LAYOUT-BOX') {
        out.push((node as unknown as LayoutBoxElement)._rawData());
        } else if (node instanceof HTMLDivElement) {
          const parkedId = node.getAttribute(PARKED_PAGE_ATTR);
          if (parkedId) {
            const parked = this._parkedPages.get(parkedId);
            if (parked) {
            // flush-then-read: extractData는 dirty를 자가 치유하지 않고
            // throw한다. reconcile 사이클 중 data setter가 보관 요소 엔진에
            // pending을 남길 수 있어 수집 시점에 커밋한다. 스냅숏 저장은
            // 제2의 진실 소스라 금지 (감사 A-3).
            // 커밋 2단계: (1) ensureCommitted — Box/Image/Table을 타입별 커밋.
            // (2) PE pending 직접 커밋 — ensureCommitted는 편집 세션(rAF
            // 디바운스) 소유 PE를 건너뛰지만 parked 요소는 컨트롤러가 destroy된
            // detached 상태라 소유 경쟁이 없으므로 layoutText()로 커밋한다.
            this._engine?.ensureCommitted();
            for (const p of parked.element.querySelectorAll('x-layout-paragraph')) {
              const eng = (p as LayoutParagraphElement).engine;
              if (eng?.hasPendingChanges) eng.layoutText();
            }
            out.push(parked.element.data as BoxData);
            }
          }
        }
    }
    return out;
  }

  /**
   * 엔진 트리의 id를 DOM 자식 요소에 동기화한다.
   * PageEngine._buildBoxEngine이 BoxData.id가 없을 때 generateEngineId()로
   * id를 발급한다. 이 id를 DOM 요소에 write-back하여,
   * 자식 connectedCallback의 findBoxEngineById(this.id)가 정상 작동하도록 한다.
   */
  private _syncEngineIdsToDom(): void {
    if (!this._engine) return;
    const engineBoxes = this._engine.childBoxEngines;
    // G1(가상화): 보관 페이지는 DOM에 없으므로 위치 기반 매칭이 어긋난다.
    // id 기반 매칭으로 전환한다 — 보관 항목은 스킵하고, id 없는 DOM 박스에
    // 엔진이 발급한 id를 write-back하는 기존 동작은 폴백으로 유지한다.
    // 보관 페이지의 id는 park 시점에 항상 존재하므로 폴백과 충돌하지 않는다.
    const domById = new Map<string, LayoutBoxElement>();
    const idLessDom: LayoutBoxElement[] = [];
    for (const box of this.items) {
      if (box.id) domById.set(box.id, box);
      else idLessDom.push(box);
    }
    let idLessIdx = 0;
    for (const engineBox of engineBoxes) {
      const engineId = engineBox.data.id;
      if (!engineId) continue;
      const domBox = domById.get(engineId);
      if (domBox) {
        this._syncEngineIdsToDomRecursive(engineBox, domBox);
        continue;
      }
      if (this._parkedPages.has(engineId)) continue;
      const target = idLessIdx < idLessDom.length ? idLessDom[idLessIdx++] : undefined;
      if (target) {
        target.id = engineId;
        this._syncEngineIdsToDomRecursive(engineBox, target);
      }
    }
  }

  private _syncEngineIdsToDomRecursive(engineBox: BoxEngine, domBox: LayoutBoxElement): void {
    const engineChildren = engineBox.childEngines;
    const domChildren = Array.from(domBox.children).filter(
      (c): c is HTMLElement => c.localName === 'x-layout-box' || c.localName === 'x-layout-paragraph'
        || c.localName === 'x-layout-image' || c.localName === 'x-layout-table',
    );
    for (let i = 0; i < engineChildren.length && i < domChildren.length; i++) {
      const engineChild = engineChildren[i];
      const domChild = domChildren[i];
      let engineId: string | undefined;
      if ('id' in engineChild && engineChild.id !== undefined) {
        engineId = engineChild.id;
      } else if ('data' in engineChild && engineChild.data?.id !== undefined) {
        engineId = engineChild.data.id;
      }
      if (engineId && domChild.id !== engineId) {
        domChild.id = engineId;
      }
      if (engineChild instanceof BoxEngine && domChild instanceof LayoutBoxElement) {
        this._syncEngineIdsToDomRecursive(engineChild, domChild);
      }
    }
  }

  /**
   * CSS 스타일 적용: shadow DOM 내의 `:host` 규칙과 루트 div 스타일을 생성/갱신한다.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _applyStyle() {
    if (!this._shadowRoot.querySelector(":scope > style")) {
      const styleEl = document.createElement('style');
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);
      styleEl.sheet.insertRule("@media screen { :host([reparent-target]) { box-shadow: #ff9800 0px 0px 0px 2px inset; } }", 1);
      styleEl.sheet.insertRule('@media screen { .type-label { position: absolute; top: 0; left: 0; padding: 2px 6px; color: #fff; font-family: "Wanted Sans Variable"; font-size: 12px; line-height: 1.3; pointer-events: none; user-select: none; cursor: default; z-index: ' + Z_INDEX_TYPE_LABEL + '; display: none; white-space: nowrap; } }', 2);
      styleEl.sheet.insertRule('@media screen { :host([reparent-target]) .type-label { display: block; background: rgba(255, 152, 0, 0.85); } }', 3);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      rule.style.setProperty('background-color', '#ffffff', 'important');
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
        rule.style,
        {
          display: 'inline-flex',
          position: 'relative',
          userSelect: 'none',
        }
      );
      rule.style.setProperty('height', 'fit-content', 'important');
      rule.style.setProperty('width', 'fit-content', 'important');
    }

    if (!this._root) {
      this._root = document.createElement('div');
      this._shadowRoot.appendChild(this._root);

      this._labelEl = document.createElement('div');
      this._labelEl.classList.add('type-label');
      this._labelEl.textContent = '지면';
      this._root.appendChild(this._labelEl);

      this._shadowRoot.appendChild(document.createElement('slot'));
    }
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      this._root.style,
      {
        boxSizing: 'border-box',
        display: 'inline-block',
        position: 'relative',
        height: `${this._height}mm`,
        width: `${this._width}mm`,
      }
    );
  }

  /**
   * 가이드 컬럼 요소 생성 및 스타일 적용.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _renderGuideColumns() {
    const grid = this._engine?.gridCalculator;
    if (!grid) return;

    const existing = Array.from(this._root?.children || []).filter(
      (e): e is HTMLElement & {
        rect: unknown; fontSize: number; lineHeight: number; visible: boolean;
        left: number; top: number; width: number; height: number;
      } => e.nodeName === "X-LAYOUT-GUIDE-COLUMN",
    );

    if (existing.length === grid.columnCoords.length) {
      for (let i = 0; i < grid.columnCoords.length; i++) {
        const coord = grid.columnCoords[i];
        const el = existing[i];
        const nl = coord.x1, nt = coord.y1, nw = coord.x2 - coord.x1, nh = coord.y2 - coord.y1;
        if (el.left !== nl || el.top !== nt || el.width !== nw || el.height !== nh) {
          (el as unknown as { rect: unknown }).rect = coord;
        }
        if (el.fontSize !== grid.fontSize) el.fontSize = grid.fontSize;
        if (el.lineHeight !== grid.lineHeight) el.lineHeight = grid.lineHeight;
        if (el.visible !== this._visibleGuide) el.visible = this._visibleGuide;
      }
      return;
    }

    existing.forEach(e => e.remove());

    for (let i = 0; i < grid.columnCoords.length; i++) {
      const coord = grid.columnCoords[i];
      const colEl = document.createElement('x-layout-guide-column') as HTMLElement & {
        rect: unknown; fontSize: number; lineHeight: number; visible: boolean;
      };
      colEl.rect = coord;
      colEl.fontSize = grid.fontSize;
      colEl.lineHeight = grid.lineHeight;
      colEl.visible = this._visibleGuide;
      this._root?.appendChild(colEl);
    }
  }

  /**
   * 자식 요소에 InheritStyle 전파.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _propagateInheritStyle() {
    const grid = this._engine?.gridCalculator;
    if (!grid) return;
    this.items.forEach(childEl => {
      childEl.inheritStyle = {
        ...this.textStyle,
        ...this.paragraphStyle,
        parentHeight: grid.editableHeight,
        parentWidth: grid.editableWidth,
      };
    });
  }

  /**
   * 문서 소유 시분할 표시 패스 억제 여부 (③′).
   * 문서 `data` 세터 reconcile 중에만 문서 요소가 플래그를 인상한다.
   *
   * @returns 문서가 reconcile 중이면 true (자체 render 억제)
   */
  private _isDisplayPassDeferred(): boolean {
    return this._findDocumentElement()?.isDisplayPassDeferred === true;
  }

  /**
   * 레이아웃 오케스트레이터. `_layoutStructure()`, `_applyStyle()`,
   * `_renderGuideColumns()`, `_propagateInheritStyle()`를 순서대로 호출한다.
   * 기존 호출자(`connectedCallback`, 세터)와의 호환성을 위해 유지한다.
   */
  layout() {
    if (!this.isConnected) return null;

    this._layoutStructure();
    this._applyStyle();
    this._renderGuideColumns();
    this._propagateInheritStyle();
    if (this._findDocumentElement()) {
      this._delegateThreadChainConfirm();
    } else {
      this._relayoutThreads();
      this._syncThreadFramesToDom();
    }
    return this;
  }

  /**
   * 자식 요소를 z-index 역순으로 렌더링한다.
   * 이미지 로딩 등 비동기 처리를 위해 각 자식의 `render()`를 await한다.
   */
  async render() {
    if (!this.isConnected) return null;
    const sortedItems = [...this.items].sort((a, b) => b.zIndex - a.zIndex);
    for (let i = 0; i < sortedItems.length; i++) {
      await sortedItems[i].render()
    }
    // 자식 render가 model을 재생성한 경우(스레드 프레임이 아직 미적용이면)
    // 스레드 체인을 재확정한다 — 초기 로드의 실질적 확정 지점.
    // 문서 아래에서는 위임이, 독립 루트에서는 암묵 문서 엔진이 처리한다.
    if (this._findDocumentElement()) {
      this._delegateThreadChainConfirm();
    } else if (this._hasUnsyncedThreadFrames()) {
      this._relayoutThreads();
      this._syncThreadFramesToDom();
    }
    return this;
  }

  /**
   * 스레드 소유 DocumentEngine을 해석한다.
   *
   * 문서 요소 아래면 null(문서가 소유). 독립 루트이고 threads가 있으면
   * 암묵 문서 엔진(1페이지 문서 취급)을 구축·갱신해 반환한다. 엔진 인스턴스는
   * 재사용하므로 ThreadEngine 커밋 기록(범위-증명 스킵 근거)이 유지된다.
   *
   * @returns 스레드 소유 엔진. threads가 없으면 undefined.
   */
  private _resolveThreadDocEngine(): DocumentEngine | undefined {
    if (this._findDocumentElement()) return undefined;
    if (!this._threads || this._threads.length === 0 || !this._engine) return undefined;
    const hostDoc = this._findDocumentElement();
    const hostRes = hostDoc?.resources;
    const fontLoader = hostRes?.fontLoader ?? new FontLoaderSingletonAdapter(FontLoader.getInstance());
    const colorRegistry = hostRes?.colorRegistry ?? new ColorRegistrySingletonAdapter(ColorRegistry.getInstance());
    if (!this._threadDocEngine) {
      this._threadDocEngine = DocumentEngine.create(
        { id: this.id || undefined, threads: this._threads,
          width: this._width, height: this._height,
          columns: this._columns, gap: this._gap,
          paragraphStyle: this._paragraphStyle, textStyle: this._textStyle },
        fontLoader,
        colorRegistry,
        this._ppm,
      );
    } else {
      this._threadDocEngine.data = {
        ...this._threadDocEngine.data,
        threads: this._threads,
      };
    }
    return this._threadDocEngine;
  }

  /**
   * 이 페이지의 스레드 소유 DocumentEngine을 반환한다 (EditManager용).
   *
   * 문서 아래면 undefined — 문서의 엔진을 사용해야 한다.
   *
   * @returns 암묵 문서 엔진 또는 undefined.
   */
  get threadEngine(): DocumentEngine | undefined {
    return this._resolveThreadDocEngine();
  }

  /**
   * 스레드 체인 확정(layout 재배치 + 프레임 DOM 동기화).
   *
   * 문서 아래의 페이지는 요청을 상위로 전달한다. 독립 루트는 암묵 문서
   * 엔진을 사용해 자체 확정한다.
   */
  private _delegateThreadChainConfirm(): void {
    const docEl = this._findDocumentElement();
    if (docEl) {
      docEl.confirmThreadChain();
      return;
    }
    this._relayoutThreads();
    this._syncThreadFramesToDom();
  }

  /**
   * 스레드 프레임을 배치한다 (독립 루트 전용).
   *
   * 독립 루트의 threads는 암묵 문서 엔진이 소유한다. 문서 아래의 페이지는
   * 문서 요소가 스레드를 담당하므로 이 메서드는 호출되지 않는다.
   */
  private _relayoutThreads(): void {
    const threadEngine = this._resolveThreadDocEngine();
    if (!threadEngine || !this._engine) return;
    threadEngine.adoptPageEngines([this._engine]);
    threadEngine.layout();
  }

  /**
   * 스레드 프레임 편집(타이핑) 전파 — 체인 재배치를 예약한다.
   *
   * 편집 중인 프레임의 model.textContent가 story의 새 진실이므로, 체인
   * 재배치 시 threads.content를 소스 프레임의 textContent로 갱신한다
   * (writeback). 마이크로태스크로 통합해 키 입력마다 체인 전체를
   * 재배치하는 비용을 한 번으로 묶는다. 문서 아래의 페이지는 요청을
   * 소속 문서 요소에 위임한다.
   *
   * @param sourceFrameId - 편집이 발생한 스레드 프레임 id
   */
  requestThreadRelayout(sourceFrameId: string): void {
    const docEl = this._findDocumentElement();
    if (docEl) {
      docEl.requestThreadRelayout(sourceFrameId);
      return;
    }
    if (!this._threads || this._threads.length === 0) return;
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
   * 예약된 스레드 체인 재배치를 실행한다 (독립 루트 전용) — 공용 coordinator
   * 위임 (C-1). 본체 로직은 `thread-relayout-coordinator.ts`가 소유하며,
   * 재진입 차단 플래그는 요소별 인스턴스 상태로 유지한다 (E-2 계약).
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

  /** coordinator 주입 컨텍스트 (독립 루트 전용 위임 엔진). */
  private _threadRelayoutContext(): ThreadRelayoutContext {
    return {
      engine: this._resolveThreadDocEngine(),
      focusedParagraphId: this.editManager.focusedParagraph?.id,
      queryParagraphs: () => this.querySelectorAll<LayoutParagraphElement>('x-layout-paragraph'),
    };
  }

  /**
   * 스레딩 프레임 DOM model을 엔진 트리 PE(스레드 배치 완료 상태)로 동기화한다
   * — 공용 coordinator 위임 (C-1).
   *
   * @returns void
   */
  private _syncThreadFramesToDom(): void {
    syncThreadFramesToDom(this._threadRelayoutContext());
  }

  /**
   * 스레드 프레임 중 엔진 트리 PE가 아직 스레드 배치가 적용되지 않은 것이 있는지
   * — 공용 coordinator 위임 (C-1).
   *
   * @returns 미적용 스레드 프레임이 있으면 true
   */
  private _hasUnsyncedThreadFrames(): boolean {
    return hasUnsyncedThreadFrames(this._threadRelayoutContext());
  }

  appendChild<T extends Node>(node: T) {
    const grid = this._engine?.gridCalculator;
    if (grid && ['X-LAYOUT-BOX', 'X-LAYOUT-PARAGRAPH', 'X-LAYOUT-IMAGE'].includes(node.nodeName)) {
      const childEl = node as unknown as (LayoutBoxElement | LayoutParagraphElement | LayoutImageElement);
      childEl.inheritStyle = {
        ...this.textStyle,
        ...this.paragraphStyle,
        parentHeight: grid.editableHeight,
        parentWidth: grid.editableWidth,
      };
    }
    return super.appendChild(node);
  }

  /**
   * BoxData를 받아 `<x-layout-box>` 요소를 생성하여 추가하고, 생성된 요소를 반환한다.
   *
   * `data` setter의 전체 초기화 파이프라인이 실행되므로, document의
   * `GridCalculator`에 맞춰 모델/상속 스타일이 올바르게 설정된다.
   * 외부(예: `LayoutEditController`의 reparent)에서 새 box를 추가할 때 사용한다.
   *
   * @param child - 추가할 box 데이터
   * @returns 생성된 LayoutBoxElement
   */
  appendChildData(child: BoxData): LayoutBoxElement {
    const boxEl = document.createElement('x-layout-box') as LayoutBoxElement;
    boxEl.data = child;
    this.appendChild(boxEl);
    this.layout();
    boxEl.requestRerenderAffectedParagraphs();
    return boxEl;
  }

  /**
   * 데이터 기반 자식 box 삭제.
   *
   * id로 자식 DOM 요소를 찾아 제거한 뒤 엔진을 재구축한다.
   * DOM 직접 `remove()` 대신 이 메서드를 사용해야 엔진 우선 원칙을 준수한다.
   *
   * @param id - 삭제할 box의 id
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
   * 페이지 박스를 DOM에서 분리하고 보관한다 (DOM 가상화).
   *
   * 박스 요소를 `PARKED_PAGE_ATTR` 플레이스홀더 div로 교체하고 요소+데이터
   * 스냅샷을 보관소에 남긴다. 엔진 트리에서는 유지되므로(`_collectChildrenData`
   * 가 플레이스홀더 위치의 데이터를 합류) 스레딩·추출·내보내기가 정상 동작한다.
   * 플레이스홀더 크기는 호출자(`PageMountManager`)가 분리 전 footprint로 지정한다.
   *
   * @param id - 분리할 최상위 박스의 id
   * @returns 생성된 플레이스홀더. 이미 보관 중이면 기존 플레이스홀더,
   *   대상이 없으면 `null`
   *
   * @example
   * ```ts
   * const w = boxEl.offsetWidth, h = boxEl.offsetHeight;
   * const ph = pageEl.parkPage('page-042');
   * if (ph) { ph.style.width = `${w}px`; ph.style.height = `${h}px`; }
   * ```
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
    // PageEngine.ensureCommitted()가 서브트리(parked 자식 포함)를 타입별로
    // 커밋한다. 스냅숏 저장은 제2의 진실 소스라 금지 (감사 A-3).
    this._engine?.ensureCommitted();
    const placeholder = document.createElement('div');
    placeholder.setAttribute(PARKED_PAGE_ATTR, id);
    child.replaceWith(placeholder);
    this._parkedPages.set(id, { element: child });
    return placeholder;
  }

  /**
   * 보관된 페이지 박스를 플레이스홀더 자리에 복원한다.
   *
   * `replaceWith`로 재삽입하면 `connectedCallback` → `layout()`이 실행되어
   * 기존 엔진에 재연결된다(엔진은 분리 중에도 유지되므로 캐시 히트).
   * 텍스트 커서 복원의 mapper 재구축은 문단 `connectedCallback`의 예약 렌더가
   * 담당하므로, 호출자는 이미지 등 비동기 페인트가 필요할 때만 `render()`를
   * 호출하면 된다.
   *
   * @param id - 복원할 페이지의 id
   * @returns 복원된 박스 요소. 보관 내역이 없고 이미 마운트되어 있으면 그 요소,
   *   둘 다 없으면 `null`
   *
   * @example
   * ```ts
   * const boxEl = pageEl.unparkPage('page-042');
   * if (boxEl) await boxEl.render();
   * ```
   */
  unparkPage(id: string): LayoutBoxElement | null {
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
   *
   * @returns 보관 중인 페이지 id 배열 (보관 순서)
   */
  get parkedPageIds(): string[] {
    return [...this._parkedPages.keys()];
  }

  set data(data: PageData) {
    // 문서 요소 자신의 id는 자동 생성하지 않는다 — HTML 마크업이 부여한
    // id(`<x-layout-page id="doc">`)를 data 주입이 난수로 덮어쓰면
    // document.getElementById가 요소를 못 찾는다. 엔진은 _rawData()에서
    // this.id(마크업 id 또는 기존값)를 주입받는다. 자식 박스/문단은
    // reconcile 키로 쓰이므로 자동 생성을 유지한다.
    this._rebuildingChildren = true;
    this._pendingData = data;
    try {
      if (data.id !== undefined) this.id = data.id;
      if (data.pageNumber !== undefined) this._pageNumber = data.pageNumber;
      if (data.paddingTop !== undefined) this._paddingTop = data.paddingTop;
      if (data.paddingBottom !== undefined) this._paddingBottom = data.paddingBottom;
      if (data.paddingLeft !== undefined) this._paddingLeft = data.paddingLeft;
      if (data.paddingRight !== undefined) this._paddingRight = data.paddingRight;

      this._width = data.width;
      this._height = data.height;
      this._columns = data.columns;
      this._gap = data.gap;
      this._paragraphStyle = data.paragraphStyle;
      this._textStyle = data.textStyle;
      this._threads = data.threads;

      // reconcile 전에 엔진의 문서 속성(width/height/columns/gap/styles)만 갱신한다.
      // childrenData + layout()은 reconcile 후에 호출해야 구 content가 엔진에
      // 재주입되지 않는다. 단, GridCalculatorEngine은 여기서 갱신하여
      // 자식 connectedCallback이 읽는 columnCoords가 신선하도록 한다.
      const fontLoader = new FontLoaderSingletonAdapter(FontLoader.getInstance());
      const colorRegistry = new ColorRegistrySingletonAdapter(ColorRegistry.getInstance());
      const docData: PageData = {
        id: this.id,
        width: this._width,
        height: this._height,
        paddingTop: this._paddingTop,
        paddingBottom: this._paddingBottom,
        paddingLeft: this._paddingLeft,
        paddingRight: this._paddingRight,
        columns: this._columns,
        gap: this._gap,
        pageNumber: this._pageNumber,
        paragraphStyle: this._paragraphStyle,
        textStyle: this._textStyle,
        threads: this._threads,
      };
      if (!this._engine) {
        this._engine = PageEngine.create(docData, fontLoader, colorRegistry, this._ppm);
      } else {
        this._engine.data = docData;
        this._engine.ppm = this._ppm;
      }
      this._engine.layout();

      const existingBoxes = this.items;
      const existingById = new Map<string, LayoutBoxElement>();
      for (const box of existingBoxes) {
        if (box.id) existingById.set(box.id, box);
      }

      const children = data.children || [];
      const usedIds = new Set<string>();

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const childId = child.id;

        if (childId && existingById.has(childId)) {
          const existingBox = existingById.get(childId)!;
          usedIds.add(childId);
          (existingBox as unknown as { _rebuildingChildren?: boolean })._rebuildingChildren = true;
          try {
            existingBox.data = child;
          } finally {
            (existingBox as unknown as { _rebuildingChildren?: boolean })._rebuildingChildren = false;
          }
          if (existingBox.parentElement === this && existingBoxes[i] === existingBox) {
            continue;
          }
          this.appendChild(existingBox);
        } else {
          if (childId && this._parkedPages.has(childId)) {
            // G1(가상화): 분리 보관 중인 페이지는 DOM을 재생성하지 않는다.
            // 엔진은 _collectChildrenData()의 플레이스홀더 위치 병합으로 유지되며,
            // 보관 요소의 프로퍼티는 detach 안전 경로(data setter)로 갱신한다
            // (미연결 요소의 생성 경로와 동일 — layout/render는 early-return).
            // 스냅숏은 없고 엔진이 진실 소스다 (감사 A-3).
            const parked = this._parkedPages.get(childId)!;
            usedIds.add(childId);
            parked.element.data = child;
            continue;
          }
          const boxEl = document.createElement('x-layout-box') as LayoutBoxElement;
          boxEl.data = child;
          this.appendChild(boxEl);
          if (childId) usedIds.add(childId);
        }
      }

      for (const box of existingBoxes) {
        if (box.id && !usedIds.has(box.id)) {
          Element.prototype.remove.call(box);
        }
      }

      // 보관 중인데 새 data.children에 없는 페이지(보관 중 삭제)는 보관소와
      // 플레이스홀더를 함께 정리한다. 방치하면 엔진에 고스트 데이터가 남는다.
      if (this._parkedPages.size > 0) {
        const childIds = new Set(children.map(c => c.id));
        for (const parkedId of [...this._parkedPages.keys()]) {
          if (!childIds.has(parkedId)) {
            this._parkedPages.delete(parkedId);
            this.querySelector(`div[${PARKED_PAGE_ATTR}="${CSS.escape(parkedId)}"]`)?.remove();
          }
        }
      }

      // reconcile 후 layout()이 _layoutStructure()를 통해 childrenData를
      // 신선한 DOM 데이터로 재설정 + 엔진 트리 재구축한다.
      // _rebuildingChildren을 유지하여 _propagateInheritStyle이 각 box/paragraph의
      // layout()을 중복 호출하지 않도록 한다.
      this._rebuildingChildren = true;
      try {
        this.layout();
      } finally {
        this._rebuildingChildren = false;
      }
      if (this._isDisplayPassDeferred()) return;
      this.render();
    } finally {
      this._rebuildingChildren = false;
      this._pendingData = null;
    }
  }

  set width(value: number) {
    if (this._width === value) return;
    this._width = value;
    this.layout();
    this.render();
  }

  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this.layout();
    this.render();
  }

  set paddingTop(value: number) {
    if (this._paddingTop === value) return;
    this._paddingTop = value;
    this.layout();
    this.render();
  }

  set paddingBottom(value: number) {
    if (this._paddingBottom === value) return;
    this._paddingBottom = value;
    this.layout();
    this.render();
  }

  set paddingLeft(value: number) {
    if (this._paddingLeft === value) return;
    this._paddingLeft = value;
    this.layout();
    this.render();
  }

  set paddingRight(value: number) {
    if (this._paddingRight === value) return;
    this._paddingRight = value;
    this.layout();
    this.render();
  }

  set columns(value: number | number[]) {
    if (this._columns === value) return;
    this._columns = value;
    this.layout();
    this.render();
  }

  set gap(value: number | number[]) {
    if (this._gap === value) return;
    this._gap = value;
    this.layout();
    this.render();
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

  get data() {
    if (this._rebuildingChildren && this._pendingData) {
      return this._pendingData;
    }
    if (this._engine?.extractData) return this._engine.extractData;
    return this._rawData();
  }

  _rawData() {
    return {
      id: this.id,
      width: this.width,
      height: this.height,
      paddingTop: this.paddingTop,
      paddingBottom: this.paddingBottom,
      paddingLeft: this.paddingLeft,
      paddingRight: this.paddingRight,
      columns: this.columns,
      gap: this.gap,
      pageNumber: this._pageNumber,
      paragraphStyle: this.paragraphStyle,
      textStyle: this.textStyle,
      children: this._collectChildrenData(),
    }
  }

  get width() { return this._width; }
  get height() { return this._height; }
  get paddingTop() { return this._paddingTop; }
  get paddingBottom() { return this._paddingBottom; }
  get paddingLeft() { return this._paddingLeft; }
  get paddingRight() { return this._paddingRight; }
  get innerWidth() { return this._width - this.paddingLeft - this.paddingRight; }
  get innerHeight() { return this._height - this.paddingTop - this.paddingBottom; }
  get columns() { return this._columns; }
  get gap() { return this._gap; }
  /** 페이지 번호 (1-based, 문서 순서). 미지정 시 undefined. */
  get pageNumber() { return this._pageNumber; }
  get paragraphStyle() { return this._paragraphStyle; }
  get textStyle() { return this._textStyle; }
  /** 스레딩 정의 (옵셔널) */
  get threads() { return this._threads; }

  get visibleGuide() { return this._visibleGuide; }
  get type() { return 'page' as const; }
  get zIndex() { return 0; }

  /**
   * EditManagerHost 문서 식별 계약 (E-1).
   *
   * 독립 페이지(레거시 단일 페이지 구성)는 문서 호스트가 아니므로 false —
   * EditManager의 스레드 엔진 해석이 `threadEngine` 폴백 경로로 간다.
   * @returns 문서 호스트가 아니므로 항상 false
   */
  isDocumentHost(): boolean { return false; }

  set visibleGuide(value: boolean) {
    this._visibleGuide = value;

    if (!this._root) return;

    const guideEl = this._root.getElementsByTagName('x-layout-guide-column');
    Array.from(guideEl).forEach(e => {
      (e as LayoutGuideColumnElement).visible = this._visibleGuide;
    });
  }

  get items() {
    return Array.from(this.querySelectorAll<LayoutBoxElement>(":scope > x-layout-box"));
  }

  /**
   * 문서 또는 지정된 박스의 하위 요소 배치를 좌우/상하/상하좌우 반전한다.
   *
   * `targetId`를 지정하면 해당 박스가 root가 되며 **root 박스의 하위 요소들만** 반전한다.
   * root 박스 자체(위치/보더/패딩)는 유지된다.
   * 생략 시 문서가 root이며, 문서의 하위 박스들만 반전한다.
   *
   * 반전 전 편집 상태(포커스, 선택)를 해제한 후 `data` setter를 통해 반전된 데이터를
   * 적용한다. `data` setter가 `layout()` + `render()`를 자동 처리한다.
   *
   * @param options - 반전 옵션
   * @param options.axis - 반전 축 (`'horizontal'` | `'vertical'` | `'both'`)
   * @param options.targetId - 반전 root 박스 id. 생략 시 문서가 root.
   * @throws {Error} `targetId`가 지정되었으나 해당 id를 가진 박스를 찾지 못한 경우
   *
   * @example
   * ```ts
   * // 문서의 하위 박스들을 좌우 반전
   * documentEl.flipLayout({ axis: 'horizontal' });
   *
   * // 특정 박스의 하위 요소들만 상하 반전
   * documentEl.flipLayout({ axis: 'vertical', targetId: 'box-42' });
   *
   * // 180도 회전
   * documentEl.flipLayout({ axis: 'both' });
   * ```
   */
  flipLayout(options: FlipLayoutOptions): void {
    this.editManager.blurParagraph();
    this.editManager.clearLayoutSelection(false);

    if (this._engine) {
      const flipped = this._engine.flipLayout(options);
      this.data = flipped;
    }
  }
}

customElements.define('x-layout-page', LayoutPageElement);