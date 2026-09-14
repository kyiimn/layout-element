/**
 * 문서 엔진 (Phase B — 페이지 모델).
 *
 * 문서는 페이지 배열(`PageEngine[]`)과 스레드 정의, 전역 기본 스타일의 단일 소스다.
 * - 페이지 스코프 배치(그리드·박스·오버레이)는 각 `PageEngine`이 소유한다.
 * - 스레드는 페이지를 가로지르므로 문서 엔진이 소유한다: `ThreadEngine` 조정,
 *   story writeback, 범위-증명 스킵, dirty/stale 신선화.
 * - `findEngineById`는 전 페이지 트리를 가로질러 조회한다 (id 기반 — 문단 id는
 *   전 페이지 통틀어 유일).
 *
 * Node.js 호환: DOM/Canvas/FontFace를 참조하지 않는다.
 * DOM 요소(`LayoutPageElement`)는 이 엔진의 결과를 표시만 한다.
 *
 * @file src/engine/document-engine.ts
 */

import { DocumentData, PageData, normalizeDocumentData } from "@/types";
import { ParagraphStyle, TextStyle } from "@/types";
import type { AbsRect, FlipLayoutOptions, FontLoaderEngine, ColorRegistryEngine } from "./types";
import { GridCalculatorEngine } from "./grid-calculator-engine";
import { ThreadEngine, ThreadLayoutOptions, ThreadLayoutResult } from "./thread-engine";
import { PageEngine } from "./page-engine";
import { ParagraphEngine } from "./paragraph-engine";
import type { BoxEngine } from "./box-engine";
import type { ImageEngine } from "./image-engine";
import type { TableEngine } from "./table-engine";
import type { PrintPostData } from "@/types/print";
import { createDirtyError } from "./types";

/**
 * 문서 전용 계약 (감사 D-7 — BoxEngineParent 스텁 격리).
 *
 * DocumentEngine이 BoxEngineParent를 "암시적으로 만족"하기 위해 두던
 * 스텁들(childBoxEngines[]/appendChildBoxEngine 등 no-op/absRect 0/
 * gridCalculator 매호출 생성)은 실제 소비처가 0건인 설계 부채였다. 페이지
 * 트리에 진입하는 엔진의 부모는 PageEngine이므로 문서는 BoxEngineParent
 * 계약에서 격리되고, 이 인터페이스는 문서 엔진의 **실제 표면**만 선언한다.
 *
 * @example
 * ```ts
 * // 호출부는 문서 엔진을 BoxEngineParent로 기대하지 않는다 —
 * // DocumentEngineParent로 소비하거나 구체 DocumentEngine을 쓴다.
 * function orchestrate(doc: DocumentEngineParent): void {
 *   doc.relayoutThreads();
 * }
 * ```
 */
export interface DocumentEngineParent {
  /** 문서 자체는 절대 (0,0) 사각형이 아니다 — 표시 계층이 좌표를 소유 */
  readonly absRect: AbsRect;
  /** 스레드 조정 — story writeback + 체인 재배치 (문서 스코프 단일 소스) */
  relayoutThreads(sourceFrameIds?: ReadonlySet<string>, pinnedFrameIds?: ReadonlySet<string>): ThreadLayoutResult[];
  /** 문서 전체 dirty 소진 (명시적 스냅샷 경계) */
  ensureCommitted(): void;
}

export class DocumentEngine {
  private _data: DocumentData;
  private _ppm: number;
  private _fontLoader: FontLoaderEngine;
  private _colorRegistry: ColorRegistryEngine;
  private _pageEngines: PageEngine[] = [];
  private _threadEngine: ThreadEngine | null = null;

  private constructor(
    data: DocumentData,
    fontLoader: FontLoaderEngine,
    colorRegistry: ColorRegistryEngine,
    ppm?: number,
  ) {
    this._data = normalizeDocumentData(data);
    this._ppm = ppm ?? 0;
    this._fontLoader = fontLoader;
    this._colorRegistry = colorRegistry;
  }

  /**
   * 정적 팩토리. `new` 직접 사용 금지.
   *
   * @param data - 문서 데이터 (레거시 children 입력도 normalize로 수용)
   * @param fontLoader - 폰트 로더 엔진
   * @param colorRegistry - 컬러 레지스트리 엔진
   * @param ppm - pixels-per-mm (옵셔널, 표시 전용)
   * @returns DocumentEngine 인스턴스
   */
  static create(
    data: DocumentData,
    fontLoader: FontLoaderEngine,
    colorRegistry: ColorRegistryEngine,
    ppm?: number,
  ): DocumentEngine {
    return new this(data, fontLoader, colorRegistry, ppm);
  }

  set data(d: DocumentData) {
    this._data = normalizeDocumentData(d);
  }

  get data(): DocumentData {
    return this._data;
  }

  /** 정규화된 페이지 데이터 배열 (단일 소스) */
  get pages(): PageData[] {
    return this._data.pages ?? [];
  }

  get ppm(): number { return this._ppm; }
  set ppm(v: number) { this._ppm = v; }

  get paragraphStyle(): ParagraphStyle | undefined { return this._data.paragraphStyle; }
  get textStyle(): TextStyle | undefined { return this._data.textStyle; }

  /**
   * 문서 dirty 여부 — 소유 페이지 엔진 dirty의 집계 (단일 소스: PageEngine._dirty).
   *
   * PageEngine은 개별 setter/appendChild 등에서 `_dirty = true`를 세우고
   * `layout()`에서 해제한다. 문서는 자체 dirty 플래그를 두지 않고 페이지의
   * 상태를 집계한다 — 이중 소스는 문서 계층에서 가드가 무력화되는 원인이 된다
   * (감사 A-1: 구현은 있었으나 `_dirty`를 세는 경로가 없어 DirtyPendingError
   * 가드가 도달 불가능했다).
   *
   * @returns 소유 페이지 중 하나라도 dirty이면 true
   */
  get dirty(): boolean {
    return this._pageEngines.some(pageEngine => pageEngine.dirty);
  }

  get pageEngines(): PageEngine[] { return this._pageEngines; }

  /**
   * DOM이 소유한 페이지 엔진을 편입한다 (engine 복제 방지 — 단일 소스 유지).
   *
   * 각 페이지 요소(`LayoutPageElement`)가 독립적으로 만든 `PageEngine`을
   * 문서 엔진의 페이지 배열로 등록한다. 페이지 엔진은 기존 인스턴스 그대로
   * 재사용되므로 `_layoutCache`·rgbaData 등 증분 상태가 보존된다.
   *
   * 이후 `_layoutThreads`는 이 배열을 가로질러 프레임 문단을 조회한다.
   *
   * @param pageEngines - 페이지 엔진 배열 (문서 순서)
   */
  adoptPageEngines(pageEngines: PageEngine[]): void {
    this._pageEngines = [...pageEngines];
    const docDefaults = {
      paragraphStyle: this._data.paragraphStyle,
      textStyle: this._data.textStyle,
    };
    for (const pe of this._pageEngines) {
      pe.docDefaults = docDefaults;
    }
  }

  get resources(): { ppm: number; fontLoader: FontLoaderEngine; colorRegistry: ColorRegistryEngine } {
    return { ppm: this._ppm, fontLoader: this._fontLoader, colorRegistry: this._colorRegistry };
  }

  /**
   * 스레드 체인을 배치한다. 페이지 엔진은 DOM 또는 Node 직접 경로에서 이미
   * 구축되어 있다(자체 layout 또는 `adoptPageEngines`). threads가 없으면 no-op.
   */
  layout(): void {
    this._layoutThreads();
  }

  /**
   * 전 페이지 트리를 가로질러 엔진을 조회한다 (id 기반).
   *
   * @param id - 검색할 엔진 ID
   * @returns 일치하는 엔진 또는 undefined
   */
  findEngineById(id: string): BoxEngine | ParagraphEngine | ImageEngine | TableEngine | undefined {
    for (const pageEngine of this._pageEngines) {
      const found = pageEngine.findEngineById(id);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * 여러 ID의 엔진을 전 페이지 트리 1회 순회로 일괄 조회한다.
   *
   * @param ids - 검색할 엔진 ID 집합
   * @returns id → 엔진 맵
   */
  findEnginesByIds(ids: ReadonlySet<string>): Map<string, BoxEngine | ParagraphEngine | ImageEngine | TableEngine> {
    const out = new Map<string, BoxEngine | ParagraphEngine | ImageEngine | TableEngine>();
    for (const pageEngine of this._pageEngines) {
      for (const [id, engine] of pageEngine.findEnginesByIds(ids)) {
        out.set(id, engine);
      }
    }
    return out;
  }

  /**
   * 문서 전체 printPostData (페이지 순서, 페이지별 z-index 정렬).
   *
   * @throws DirtyPendingError dirty 페이지가 있으면
   */
  get printPostData(): PrintPostData[] {
    if (this.dirty) throw createDirtyError('DocumentEngine');
    const out: PrintPostData[] = [];
    for (const pageEngine of this._pageEngines) {
      out.push(...pageEngine.printPostData);
    }
    return out;
  }

  /**
   * 모든 페이지 엔진의 pending 변경을 커밋한다 (명시적 스냅샷 경계).
   */
  public ensureCommitted(): void {
    for (const pageEngine of this._pageEngines) {
      pageEngine.ensureCommitted();
    }
  }

  /**
   * 문서 전체 데이터를 엔진 현재 상태에서 추출한다.
   *
   * @throws DirtyPendingError dirty 페이지가 있으면
   */
  get extractData(): DocumentData {
    if (this.dirty) throw createDirtyError('DocumentEngine');
    return {
      ...this._data,
      pages: this._pageEngines.map(pe => pe.extractData),
    };
  }

  /**
   * 스레드 체인을 순차 배치한다. threads가 없으면 no-op.
   * 로직은 PageEngine에서 이동 없이 그대로 이식 (PageEngine 소스 참조).
   */
  private _layoutThreads(opts?: ThreadLayoutOptions): ThreadLayoutResult[] {
    const threads = this._data.threads;
    if (!threads || threads.length === 0) return [];
    if (!this._threadEngine) {
      this._threadEngine = ThreadEngine.create();
    }
    return this._threadEngine.layoutThreads(
      threads,
      id => this.findEngineById(id),
      ids => this.findEnginesByIds(ids),
      opts,
    );
  }

  /**
   * 스레드 배치를 재실행한다 (편집 전파 경로).
   *
   * @param sourceFrameIds - 편집이 발생한 프레임 id 집합
   * @param pinnedFrameIds - 스킵 금지 프레임 id 집합 (포커스된 문단)
   * @returns 스레드별 배치 결과 배열
   */
  public relayoutThreads(sourceFrameIds?: ReadonlySet<string>, pinnedFrameIds?: ReadonlySet<string>): ThreadLayoutResult[] {
    let editPsByThreadKey: Map<string, number> | undefined;
    if (sourceFrameIds && sourceFrameIds.size > 0) {
      editPsByThreadKey = this._writebackThreadStory(sourceFrameIds);
    }
    return this._layoutThreads({ editPsByThreadKey, pinnedFrameIds });
  }

  /**
   * 지정 스레드 프레임들을 신선한 상태로 만든다 (범위-증명 편집 안전장치).
   *
   * @param frameIds - 신선화 대상 프레임(문단) id 집합
   * @returns 신선화가 실제로 수행됐으면 true
   */
  public ensureThreadFramesFresh(frameIds: ReadonlySet<string>): boolean {
    const threads = this._data.threads;
    if (!threads || threads.length === 0) return false;
    if (frameIds.size === 0) return false;
    const te = this._threadEngine;
    if (!te) return false;
    const touched = new Set<string>();
    for (const thread of threads) {
      const ids = thread.paragraphIds ?? [];
      if (!ids.some(id => frameIds.has(id))) continue;
      const key = ThreadEngine.threadKeyOf(thread);
      if (te.hasStaleSkippedFrames(key)) touched.add(key);
    }
    if (touched.size === 0) return false;
    this._layoutThreads();
    for (const thread of threads) {
      const key = ThreadEngine.threadKeyOf(thread);
      if (!touched.has(key)) continue;
      for (const id of thread.paragraphIds ?? []) {
        const pe = this.findEngineById(id);
        if (pe instanceof ParagraphEngine && pe.hasPendingChanges) {
          pe.layoutText();
        }
      }
    }
    return true;
  }

  /**
   * 편집 프레임의 textContent를 소속 스레드의 story에 writeback한다.
   *
   * PageEngine 구현과 동일 로직 — 소유자만 DocumentEngine으로 바뀌었다.
   * story(threads[].content)는 문서 데이터의 원본 객체에 기록된다 (객체 identity
   * 계약 — ThreadEngine이 커밋 체인을 키잉할 때 동일 참조를 요구).
   *
   * @param sourceFrameIds - 편집이 발생한 프레임 id 집합
   * @returns 스레드 키 → 편집 시작 오프셋(Ps) 맵
   */
  private _writebackThreadStory(sourceFrameIds: ReadonlySet<string>): Map<string, number> {
    const editPsByThread = new Map<string, number>();
    const threads = this._data.threads;
    if (!threads) return editPsByThread;
    // 소속 판정은 ThreadEngine.validate의 first-claim-wins 단일 소스를 소비한다
    // (RULES §1.10 — validate(정합성)·layoutThreads(배치)·writeback(story 기록)이
    // 동일 판정을 사용해야 한다. 별도 claimed Set은 발산 원인이므로 금지).
    // 소속 조회는 **판정된(judged) paragraphIds**로 한다 — 중복 소속 프레임은
    // 첫 thread만 소유하므로 둘째 thread에서 편집 프레임을 찾지 않는다.
    // story 기록은 originOf로 되찾은 **원본 객체**에 한다 — validate 복사본에
    // 기록하면 engine.data.threads 원본에 반영되지 않아 story가 소실된다
    // (identity 계약).
    const originThreads = threads;
    const validThreads = ThreadEngine.validate(threads);
    for (const judgedThread of validThreads) {
      const judgedIds = (judgedThread.paragraphIds ?? []).filter(Boolean);
      const sourceId = judgedIds.find(id => sourceFrameIds.has(id));
      if (sourceId === undefined) continue;
      const thread = ThreadEngine.originOf(judgedThread, originThreads);
      if (thread === undefined) continue;
      const sourcePe = this.findEngineById(sourceId);
      if (!(sourcePe instanceof ParagraphEngine)) continue;
      const oldStory = thread.content;
      const newStory = sourcePe.textContent;
      thread.content = newStory;
      const key = ThreadEngine.threadKeyOf(thread);
      if (oldStory === undefined) {
        editPsByThread.set(key, 0);
      } else {
        const oldPlain = ParagraphEngine.plainTextOf(oldStory);
        const newPlain = sourcePe.plainText;
        if (oldPlain.length === newPlain.length
          && this._firstDiffOffset(oldPlain, newPlain) === oldPlain.length) {
          editPsByThread.set(key, sourcePe.contentFrom);
        } else {
          editPsByThread.set(key, this._firstDiffOffset(oldPlain, newPlain));
        }
      }
    }
    return editPsByThread;
  }

  /**
   * 두 문자열의 첫 차이 오프셋을 반환한다. 동일하면 짧은 쪽 길이를 반환한다.
   *
   * @param a - 이전 story
   * @param b - 새 story
   * @returns 첫 차이 오프셋
   */
  private _firstDiffOffset(a: string, b: string): number {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }

  /**
   * flipLayout은 페이지 엔진 소유 — 문서는 페이지에 위임한다.
   * (BoxEngineParent 스텁이 아니라 실제 위임 메서드로 유지 — DOM page.element가
   *  문서 스코프 반전을 요청할 수 있다.)
   */
  flipLayout(options: FlipLayoutOptions): void {
    for (const pageEngine of this._pageEngines) {
      pageEngine.flipLayout(options);
    }
  }

  /** 박스 레이아웃 결과 스코프다운 스텁 (문서는 페이지 배열만 소유). */
  get boxLayoutResults(): PageData[] {
    return this._pageEngines.map(pe => pe.extractData);
  }

  /** AbsRect 스텁 (문서는 물리적 사각형이 아니다 — 표시 계층이 좌표를 소유). */
  get absRect(): AbsRect { return { absLeft: 0, absTop: 0, absWidth: 0, absHeight: 0 }; }

  /**
   * 그리드 계산기 스텁 — 그리드는 페이지 스코프 (PageEngine 소유).
   *
   * 매호출 `GridCalculatorEngine.create`였던 스텁(D-7)을 싱글턴으로 교체한다 —
   * 호출자는 0건이지만 미래 호출자가 매호출 새 인스턴스 할당을 유발하지
   * 않도록 불변 빈 계산기를 1회만 생성한다.
   */
  private static readonly _EMPTY_GRID = GridCalculatorEngine.create(
    { width: 0, height: 0, columns: 1, gap: 0, paragraphStyle: {}, textStyle: {}, isBox: true },
  );
  get gridCalculator(): GridCalculatorEngine { return DocumentEngine._EMPTY_GRID; }
}