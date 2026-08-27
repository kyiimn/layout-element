/**
 * Node.js 호환 문서 레이아웃 계산 엔진 (루트).
 *
 * 기존 `LayoutDocumentElement`에서 수치 계산 로직을 추출한 순수 엔진.
 * - `ppm`을 외부 주입받아 하위 엔진으로 전파 (Locked Decision 1)
 * - `GridCalculatorEngine`으로 컬럼 그리드 계산
 * - 자식 `BoxEngine` 트리 자체 관리
 * - DOM 의존성 없음
 *
 * @file src/engine/document-engine.ts
 */

import type { DocumentData, BoxData, BoxRole, InheritStyle, ParagraphStyle, TextStyle } from "@/types";
import type { AbsRect, FontLoaderEngine, ColorRegistryEngine, BoxEngineParent } from "./types";
import type { PrintPostData } from "@/types";
import { createDirtyError, removeBoxDataFromChildren } from "./types";
import type { FlipLayoutOptions, BoxMetricsById } from "./types";
import { GridCalculatorEngine } from "./grid-calculator-engine";
import { BoxEngine, type BoxBuildContext } from "./box-engine";
import { ImageEngine } from "./image-engine";
import { ParagraphEngine } from "./paragraph-engine";
import { TableEngine, TableCellEngine } from "./table-engine";
import { prepareImageDecoder } from "./image-decoder";

let _engineIdCounter = 0;

/**
 * `crypto.randomUUID()`를 사용할 수 있는 최소 인터페이스.
 * `lib.dom.d.ts`의 `Crypto` 타입에 대한 의존성을 제거하여
 * 엔진이 DOM lib 없이도 타입 체크가 가능하도록 한다.
 */
interface CryptoUuid {
  randomUUID(): string;
}

function generateEngineId(): string {
  _engineIdCounter++;
  const cryptoApi = (typeof globalThis !== 'undefined' && (globalThis as { crypto?: CryptoUuid }).crypto);
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return 'eng-' + Date.now().toString(36) + '-' + _engineIdCounter.toString(36);
}

export { generateEngineId };

/**
 * 문서 전체의 레이아웃을 계산하는 루트 엔진.
 *
 * `ppm`을 외부에서 주입받아 (Locked Decision 1)
 * `GridCalculatorEngine`과 하위 `BoxEngine`으로 전파한다.
 * Node 환경에서 PDF 생성 시 ppm을 설정값으로 직접 전달.
 *
 * @example
 * const engine = DocumentEngine.create(
 *   { width: 257, height: 370, columns: 6, gap: 3, ... },
 *   3.78,  // ppm
 *   fontLoaderEngine,
 *   colorRegistryEngine,
 * );
 * engine.layout();
 * engine.childBoxEngines[0].absRect;  // 첫 번째 박스의 절대 좌표
 */
export class DocumentEngine {
  private _data: DocumentData;
  private _ppm: number;
  private _fontLoader: FontLoaderEngine;
  /** @internal */ _colorRegistry: ColorRegistryEngine;
  private _gridCalculator: GridCalculatorEngine;
  private _childBoxEngines: BoxEngine[] = [];
  private _childrenData: BoxData[] = [];

  /** Generation counter — incremented on data/ppm change. Used by child BoxEngine for cache invalidation. */
  private _generation: number = 0;

  /** layout() 호출 시 새 엔진이 생성/추가되었는지 여부. _syncEngineIdsToDom 스킵 판단용. */
  private _newEnginesCreated: boolean = false;

  private _dirty: boolean = false;

  /**
   * 정적 팩토리 메서드.
   *
   * @param data - 문서 데이터
   * @param fontLoader - Node 호환 폰트 로더
   * @param colorRegistry - Node 호환 색상 레지스트리
   * @param ppm - pixels-per-mm. 옵셔널 (엔진 연산에 사용되지 않음, 브라우저 호환용).
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

  private constructor(
    data: DocumentData,
    fontLoader: FontLoaderEngine,
    colorRegistry: ColorRegistryEngine,
    ppm?: number,
  ) {
    this._data = data;
    this._ppm = ppm ?? 0;
    this._fontLoader = fontLoader;
    this._colorRegistry = colorRegistry;
    this._gridCalculator = this._createGridCalculator();
  }

  /**
   * 문서 데이터를 설정한다.
   *
   * 기하 필드(`width`/`height`/`columns`/`gap`/`padding*`)가 변경된 경우에만
   * `_gridCalculator`를 재생성하고 `_generation`을 증가시켜
   * 하위 `BoxEngine`의 `absRect` 캐시를 무효화한다.
   * 비기하 필드(`paragraphStyle`/`textStyle` 등)만 변경된 경우
   * 그리드 계산기와 generation을 유지하여 캐시 히트율을 높인다.
   *
   * @param d - 새 문서 데이터
   */
  set data(d: DocumentData) {
    const old = this._data;
    const geomChanged =
      old.width !== d.width ||
      old.height !== d.height ||
      old.columns !== d.columns ||
      old.gap !== d.gap ||
      old.paddingTop !== d.paddingTop ||
      old.paddingRight !== d.paddingRight ||
      old.paddingBottom !== d.paddingBottom ||
      old.paddingLeft !== d.paddingLeft;
    this._data = d;
    if (geomChanged) {
      this._gridCalculator = this._createGridCalculator();
      this._generation++;
    }
  }

  /** 현재 문서 데이터 */
  get data(): DocumentData {
    return this._data;
  }

  /**
   * 엔진이 현재 관리 중인 상태에서 DocumentData를 추출한다.
   *
   * `children`은 자식 박스 엔진의 `extractData`에서 동적으로 조립한다.
   *
   * @returns 엔진 현재 상태 기반의 DocumentData
   */
  get extractData(): DocumentData {
    if (this._dirty) throw createDirtyError('DocumentEngine');
    return {
      ...this._data,
      paddingTop: this.paddingTop,
      paddingRight: this.paddingRight,
      paddingBottom: this.paddingBottom,
      paddingLeft: this.paddingLeft,
      children: this._childBoxEngines.map(e => e.extractData),
    };
  }

  /** 주입된 pixels-per-mm */
  get ppm(): number {
    return this._ppm;
  }

  set ppm(v: number) {
    this._ppm = v;
    this._generation++;
  }

  /** Generation counter (캐시 무효화 감지용) */
  get generation(): number {
    return this._generation;
  }

  /** 문서 너비 (mm) */
  get width(): number {
    return this._data.width;
  }

  /** 문서 높이 (mm) */
  get height(): number {
    return this._data.height;
  }

  /** 패딩 (mm) */
  get paddingTop(): number { return this._data.paddingTop ?? 0; }
  get paddingRight(): number { return this._data.paddingRight ?? 0; }
  get paddingBottom(): number { return this._data.paddingBottom ?? 0; }
  get paddingLeft(): number { return this._data.paddingLeft ?? 0; }

  get columns(): number | number[] { return this._data.columns; }
  get gap(): number | number[] { return this._data.gap; }
  get paragraphStyle(): ParagraphStyle { return this._data.paragraphStyle; }
  get textStyle(): TextStyle { return this._data.textStyle; }

  // ── 개별 setter (dirty 표시만, layout() 호출 시 원자 반영) ──

  set width(value: number) {
    if (this._data.width === value) return;
    this._data = { ...this._data, width: value };
    this._gridCalculator = this._createGridCalculator();
    this._generation++;
    this._dirty = true;
  }

  set height(value: number) {
    if (this._data.height === value) return;
    this._data = { ...this._data, height: value };
    this._gridCalculator = this._createGridCalculator();
    this._generation++;
    this._dirty = true;
  }

  set paddingTop(value: number) {
    if ((this._data.paddingTop ?? 0) === value) return;
    this._data = { ...this._data, paddingTop: value };
    this._gridCalculator = this._createGridCalculator();
    this._generation++;
    this._dirty = true;
  }

  set paddingRight(value: number) {
    if ((this._data.paddingRight ?? 0) === value) return;
    this._data = { ...this._data, paddingRight: value };
    this._gridCalculator = this._createGridCalculator();
    this._generation++;
    this._dirty = true;
  }

  set paddingBottom(value: number) {
    if ((this._data.paddingBottom ?? 0) === value) return;
    this._data = { ...this._data, paddingBottom: value };
    this._gridCalculator = this._createGridCalculator();
    this._generation++;
    this._dirty = true;
  }

  set paddingLeft(value: number) {
    if ((this._data.paddingLeft ?? 0) === value) return;
    this._data = { ...this._data, paddingLeft: value };
    this._gridCalculator = this._createGridCalculator();
    this._generation++;
    this._dirty = true;
  }

  set columns(value: number | number[]) {
    if (this._data.columns === value) return;
    this._data = { ...this._data, columns: value };
    this._gridCalculator = this._createGridCalculator();
    this._generation++;
    this._dirty = true;
  }

  set gap(value: number | number[]) {
    if (this._data.gap === value) return;
    this._data = { ...this._data, gap: value };
    this._gridCalculator = this._createGridCalculator();
    this._generation++;
    this._dirty = true;
  }

  set paragraphStyle(value: ParagraphStyle) {
    if (this._data.paragraphStyle === value) return;
    this._data = { ...this._data, paragraphStyle: value };
    this._dirty = true;
  }

  set textStyle(value: TextStyle) {
    if (this._data.textStyle === value) return;
    this._data = { ...this._data, textStyle: value };
    this._dirty = true;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  /** 그리드 계산기 */
  get gridCalculator(): GridCalculatorEngine {
    return this._gridCalculator;
  }

  /** 자식 박스 엔진 목록 */
  get childBoxEngines(): BoxEngine[] {
    return this._childBoxEngines;
  }

  /**
   * 자식 박스 엔진을 설정한다.
   * 엔진 트리를 구축할 때 호출.
   *
   * @param engines - 자식 박스 엔진 배열
   */
  set childBoxEngines(engines: BoxEngine[]) {
    this._childBoxEngines = engines;
    this._generation++;
  }

  /** 문서는 절대 좌표가 (0, 0)에서 시작 */
  get absRect(): AbsRect {
    return {
      absLeft: 0,
      absTop: 0,
      absWidth: this.width,
      absHeight: this.height,
    };
  }

  /** document 타입 여부 (항상 true) */
  get isDocument(): boolean {
    return true;
  }

  /** 문서 자체는 오버랩 요소가 없음 */
  get overlayElements(): BoxEngine[] {
    return [];
  }

  /**
   * 자신을 부모로 하는 직계 박스 엔진 중 ID가 일치하는 것을 반환한다.
   * BoxEngineParent 인터페이스를 구현.
   */
  findBoxEngineById(id: string): BoxEngine | undefined {
    return this._childBoxEngines.find(e => e.data != null && e.data.id === id);
  }

  /**
   * 엔진 트리 전체에서 ID가 일치하는 엔진을 검색한다.
   *
   * BoxEngine, ParagraphEngine, ImageEngine, TableEngine 모두 검색 대상이다.
   * 테이블 셀 내부 박스도 재귀적으로 순회한다.
   *
   * @param id - 검색할 엔진 ID
   * @returns 일치하는 엔진 또는 undefined
   */
  findEngineById(id: string): BoxEngine | ParagraphEngine | ImageEngine | TableEngine | undefined {
    return _findEngineByIdInBoxes(this._childBoxEngines, id);
  }

  /**
   * 역할(`role`)으로 박스 엔진을 검색한다. 트리 전체를 재귀 순회하며 일치하는 모든 박스를 반환한다.
   *
   * @param role - 검색할 박스 역할 (예: `'body'`, `'title'`, `'image'`)
   * @returns 일치하는 박스 엔진 배열 (빈 배열일 수 있음)
   */
  findBoxEnginesByRole(role: BoxRole): BoxEngine[] {
    return _findBoxEnginesByRoleInBoxes(this._childBoxEngines, role);
  }

  /**
   * 엔진 트리에서 특정 자식 엔진을 제거한다.
   *
   * 엔진 우선 원칙: DOM 요소 제거 시 엔진 트리 동기화는 엔진이 담당한다.
   * DOM `disconnectedCallback`에서 `parentElement`가 이미 null이므로,
   * `connectedCallback` 시점에 캐싱한 부모 엔진 참조를 통해 이 메서드를 호출한다.
   *
   * @param engine - 제거할 자식 엔진 (BoxEngine | ParagraphEngine | ImageEngine | TableEngine)
   * @param parentEngine - 해당 엔진의 부모 (BoxEngine | DocumentEngine | TableCellEngine)
   */
  removeChildEngine(
    engine: BoxEngine | ParagraphEngine | ImageEngine | TableEngine,
    parentEngine: BoxEngineParent,
  ): void {
    if (engine instanceof BoxEngine) {
      this._removeBoxFromParent(engine, parentEngine);
    } else {
      if (parentEngine instanceof BoxEngine) {
        const children = parentEngine.childEngines;
        const idx = children.indexOf(engine as ParagraphEngine | ImageEngine | TableEngine);
        if (idx >= 0) children.splice(idx, 1);
      }
    }
  }

  /** 외부 엔진(BoxEngine)에서 reparent 시 _childrenData에서 박스 데이터를 제거하기 위한 internal API. */
  _removeBoxDataFromChildren(boxId: string): void {
    const [, updated] = removeBoxDataFromChildren(this._childrenData, boxId);
    this._childrenData = updated as BoxData[];
  }

  /**
   * 박스 엔진을 자식으로 추가한다.
   *
   * 다른 부모 엔진에 속해 있던 박스인 경우, 기존 부모에서 제거한 후 이 엔진의 자식으로 이동한다 (reparent).
   * 추가 후 `_dirty = true`를 표시하며, `layout()` 호출 시점에 트리에 반영된다.
   *
   * @param boxEngine - 추가할 박스 엔진
   */
  appendChildBoxEngine(boxEngine: BoxEngine): void {
    const oldParent = boxEngine.parent;
    if (oldParent !== this) {
      this._removeBoxFromParent(boxEngine, oldParent);
      boxEngine.parent = this;
    }
    this._childBoxEngines = [...this._childBoxEngines, boxEngine];
    this._childrenData = [...this._childrenData, boxEngine.data];
    this._generation++;
    this._dirty = true;
  }

  /**
   * 박스 엔진을 자식에서 제거한다.
   *
   * 제거 후 `_dirty = true`를 표시하며, `layout()` 호출 시점에 트리에 반영된다.
   *
   * @param boxEngine - 제거할 박스 엔진
   */
  removeChildBoxEngine(boxEngine: BoxEngine): void {
    const idx = this._childBoxEngines.indexOf(boxEngine);
    if (idx < 0) return;
    this._childBoxEngines = this._childBoxEngines.filter((_, i) => i !== idx);
    if (boxEngine.data.id) {
      const [, updated] = removeBoxDataFromChildren(this._childrenData, boxEngine.data.id);
      this._childrenData = updated as BoxData[];
    }
    this._generation++;
    this._dirty = true;
  }

  /**
   * 박스 엔진을 다른 부모 엔진으로 이동시킨다 (reparent).
   *
   * 현재 부모에서 제거하고, 새 부모의 자식으로 추가한다.
   * 박스의 `parent` 참조를 새 부모로 갱신하고, 새 부모의 `_generation`을 증가시킨다.
   * 양쪽 부모 모두 `_dirty = true`를 표시한다.
   *
   * @param boxEngine - 이동할 박스 엔진
   * @param newParent - 새 부모 엔진 (DocumentEngine | BoxEngine | TableCellEngine)
   */
  reparentBoxEngine(boxEngine: BoxEngine, newParent: BoxEngineParent): void {
    const oldParent = boxEngine.parent;
    if (oldParent === newParent) return;
    const boxData = boxEngine.data;

    // _childrenData에서 oldParent 쪽 제거
    if (oldParent instanceof DocumentEngine) {
      if (boxData.id) {
        const [, updated] = removeBoxDataFromChildren(oldParent._childrenData, boxData.id);
        oldParent._childrenData = updated as BoxData[];
      }
    } else if (oldParent instanceof BoxEngine) {
      oldParent._removeBoxDataFromChildren(boxData.id ?? '');
    }

    // 엔진 트리 수정
    this._removeBoxFromParent(boxEngine, oldParent);
    boxEngine.parent = newParent;

    // _childrenData에 newParent 쪽 추가 + 엔진 트리 추가
    if (newParent instanceof DocumentEngine) {
      newParent._childBoxEngines = [...newParent._childBoxEngines, boxEngine];
      newParent._childrenData = [...newParent._childrenData, boxData];
      newParent._generation++;
      newParent._dirty = true;
    } else if (newParent instanceof BoxEngine) {
      newParent._appendChildBoxData(boxData);
      newParent._markDirty();
    } else if (newParent instanceof TableCellEngine) {
      newParent.boxEngine = boxEngine;
    }
    this._generation++;
    this._dirty = true;
  }

  /**
   * 문서 또는 특정 박스의 하위 요소들을 좌우/상하 반전한다.
   *
   * 엔진 트리에서 각 박스의 `absWidth`/`absHeight`를 수집한 후,
   * `flipLayoutData` 순수 함수로 데이터를 변환한다.
   * `data` + `childrenData` 갱신은 호출자의 책임이다.
   *
   * @param options - 반전 옵션 (`axis`, `targetId`)
   * @returns 반전된 `DocumentData`
   */
  flipLayout(options: FlipLayoutOptions): DocumentData {
    if (this._dirty) throw createDirtyError('DocumentEngine');
    const { axis, targetId } = options;
    const metricsById = this._collectBoxMetrics();
    const container = this._documentContainerMetrics();

    if (targetId === undefined) {
      for (const be of this._childBoxEngines) {
        be.flipLayout(axis, container, metricsById);
      }
    } else {
      let found = false;
      for (const be of this._childBoxEngines) {
        if (be.data.id === targetId) {
          const childContainer = this._boxContainerMetrics(be, metricsById);
          for (const ce of be.childEngines) {
            if (ce instanceof BoxEngine) {
              ce.flipLayout(axis, childContainer, metricsById);
            } else if (ce instanceof ParagraphEngine) {
              ce.flipLayout(axis);
            }
          }
          found = true;
          break;
        }
        // 중첩 박스에서 targetId 찾기 (재귀)
        if (this._flipLayoutInNested(be, targetId, axis, metricsById)) {
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error(`flipLayout: targetId "${targetId}"를 가진 박스를 찾을 수 없습니다.`);
      }
    }

    return {
      ...this._data,
      children: this._childBoxEngines.map((be) => ({ ...be.data })),
    };
  }

  private _flipLayoutInNested(
    be: BoxEngine,
    targetId: string,
    axis: 'horizontal' | 'vertical' | 'both',
    metricsById: BoxMetricsById,
  ): boolean {
    for (const ce of be.childEngines) {
      if (ce instanceof BoxEngine) {
        if (ce.data.id === targetId) {
          const childContainer = this._boxContainerMetrics(ce, metricsById);
          for (const subCe of ce.childEngines) {
            if (subCe instanceof BoxEngine) {
              subCe.flipLayout(axis, childContainer, metricsById);
            } else if (subCe instanceof ParagraphEngine) {
              subCe.flipLayout(axis);
            }
          }
          return true;
        }
        if (this._flipLayoutInNested(ce, targetId, axis, metricsById)) {
          return true;
        }
      }
      if (ce instanceof TableEngine) {
        for (const row of ce.rowEngines) {
          for (const cell of row.cellEngines) {
            if (cell.boxEngine && this._flipLayoutInNested(cell.boxEngine, targetId, axis, metricsById)) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  private _documentContainerMetrics() {
    const columns =
      typeof this._data.columns === 'number' ? this._data.columns : this._data.columns.length;
    const innerWidth = this._data.width - (this._data.paddingLeft ?? 0) - (this._data.paddingRight ?? 0);
    const innerHeight = this._data.height - (this._data.paddingTop ?? 0) - (this._data.paddingBottom ?? 0);
    const fontSize = this._data.textStyle?.fontSize ?? 4;
    const lineGap = this._data.paragraphStyle?.lineGap ?? 1.25;
    const lineHeight = fontSize * lineGap;
    const heightLines = innerHeight / lineHeight;
    return {
      columns,
      heightLines,
      innerWidth,
      innerHeight,
      width: this._data.width,
      height: this._data.height,
      isDocument: true,
    };
  }

  private _boxContainerMetrics(be: BoxEngine, metricsById: BoxMetricsById) {
    const injected = be.data.id ? metricsById.get(be.data.id) : undefined;
    const absWidth = injected?.absWidth ?? be.absWidth;
    const absHeight = injected?.absHeight ?? be.absHeight;
    return {
      columns: be.data.width,
      heightLines: be.data.height,
      innerWidth: absWidth - (be.data.paddingLeft ?? 0) - (be.data.paddingRight ?? 0),
      innerHeight: absHeight - (be.data.paddingTop ?? 0) - (be.data.paddingBottom ?? 0),
      width: absWidth,
      height: absHeight,
      isDocument: false,
    };
  }

  /**
   * 엔진 트리에서 모든 박스의 실제 mm 크기(`absWidth`/`absHeight`)를 수집한다.
   * static 박스의 `width`/`height`는 컬럼 span/라인 수이지 mm가 아니므로,
   * `flipLayoutData`가 absolute 자식 반전 시 부모의 mm 영역을 알기 위해 필요하다.
   *
   * @returns 박스 id → { absWidth, absHeight } map
   */
  private _collectBoxMetrics(): BoxMetricsById {
    const metrics: BoxMetricsById = new Map();
    const collect = (boxes: BoxEngine[]) => {
      for (const be of boxes) {
        if (be.data.id) {
          metrics.set(be.data.id, {
            absWidth: be.absWidth,
            absHeight: be.absHeight,
          });
        }
        for (const ce of be.childEngines) {
          if (ce instanceof BoxEngine) {
            collect([ce]);
          }
          if (ce instanceof TableEngine) {
            for (const row of ce.rowEngines) {
              for (const cell of row.cellEngines) {
                if (cell.boxEngine) collect([cell.boxEngine]);
              }
            }
          }
        }
      }
    };
    collect(this._childBoxEngines);
    return metrics;
  }

  /**
   * 엔진 리소스 번들을 반환한다.
   * 하위 엔진 생성 시 전달용.
   */
  get resources(): { ppm: number; fontLoader: FontLoaderEngine; colorRegistry: ColorRegistryEngine } {
    return {
      ppm: this._ppm,
      fontLoader: this._fontLoader,
      colorRegistry: this._colorRegistry,
    };
  }

  /**
   * 그리드 계산기를 생성한다.
   * 문서 데이터의 width/height/columns/gap/padding/style 기반.
   */
  private _createGridCalculator(): GridCalculatorEngine {
    return GridCalculatorEngine.create(
      {
        width: this._data.width,
        height: this._data.height,
        paddingTop: this._data.paddingTop,
        paddingBottom: this._data.paddingBottom,
        paddingLeft: this._data.paddingLeft,
        paddingRight: this._data.paddingRight,
        columns: this._data.columns,
        gap: this._data.gap,
        paragraphStyle: this._data.paragraphStyle,
        textStyle: this._data.textStyle,
        isBox: false,
      },
      this._ppm,
    );
  }

  /**
   * Node.js ESM 환경에서 pngjs 이미지 디코더를 사전 로드한다.
   *
   * `layout()`이 동기 함수이므로, ESM 환경에서 `import("pngjs")`를
   * 미리 실행해 두어야 `layout()` 호출 시 base64 data URI 이미지의
   * rgbaData가 자동 주입된다.
   *
   * CommonJS / tsx 환경에서는 `require('pngjs')`로 동기 로드가 가능하므로
   * 이 메서드를 호출하지 않아도 된다.
   *
   * 브라우저 환경에서는 no-op (아무 작업도 수행하지 않음).
   *
   * @returns 디코더 로드 성공 여부. true면 Node.js에서 base64 이미지 자동 디코딩 가능.
   *
   * @example
   * // ESM 환경 (Node.js)
   * const engine = DocumentEngine.create(docData, fontLoader, colorRegistry);
   * await engine.prepareImageDecoder();
   * engine.layout();  // base64 이미지 rgbaData 자동 주입 → path 모드 정상 동작
   */
  async prepareImageDecoder(): Promise<boolean> {
    return prepareImageDecoder();
  }

  /**
   * 자식 박스 데이터를 설정한다.
   *
   * `data` setter는 문서 자체 속성(width/height/padding/columns/gap/style)만 담당하고,
   * 자식 박스 데이터는 이 setter가 담당한다. `_data.children`을 읽지 않아
   * "no children in `_data`" 원칙을 유지한다.
   *
   * 설정 시 `_dirty = true`를 표시하며, `layout()` 호출 시점에 트리가 구축된다.
   *
   * @param data - 최상위 박스 데이터 배열
   */
  set childrenData(data: BoxData[]) {
    this._childrenData = data;
    this._dirty = true;
  }

  /** 설정된 자식 박스 데이터. */
  get childrenData(): BoxData[] {
    return this._childrenData;
  }

  /**
   * 문서 레이아웃을 계산한다.
   *
   * `childrenData` setter로 주입된 자식 박스 데이터에서 엔진 트리 전체를 재구축한다.
   * `data` setter에서 그리드가 갱신되므로, 여기서는 트리 구축만 수행한다.
   *
   * Node.js 환경에서 base64 data URI 이미지가 포함된 경우,
   * `overlapMode: 'path'`가 정상 동작하도록 rgbaData를 자동 주입한다.
   * (브라우저는 `LayoutImageElement._feedRgbaToEngine()`이 canvas에서 RGBA 추출)
   *
   * @param childrenData - (deprecated) 자식 박스 데이터. 전달 시 `childrenData` setter를 호출. 생략 시 기존 `childrenData` 사용.
   */
  layout(childrenData?: BoxData[]): void {
    if (childrenData !== undefined) {
      this._childrenData = childrenData;
    }
    this._newEnginesCreated = false;
    this._buildTree(this._childrenData);
    this._syncIdsToData();
    this._dirty = false;
  }

  /** layout() 호출 시 새 엔진이 생성/추가되었는지 여부 (외부에서 _syncEngineIdsToDom 스킵 판단용). */
  get newEnginesCreated(): boolean {
    return this._newEnginesCreated;
  }

  /**
   * 엔진 트리에서 발급한 id를 this._data에 write-back한다.
   * _buildBoxEngine이 BoxData.id가 없을 때 generateEngineId()로 id를 발급하지만,
   * 지역 변수에만 적용되므로 layout() 완료 후 this._data에 반영해야
   * engine.data에서 id가 포함된 DocumentData를 얻을 수 있다.
   */
  private _syncIdsToData(): void {
    const engineBoxes = this._childBoxEngines;
    const dataChildren = this._data.children;
    if (!dataChildren || !Array.isArray(dataChildren)) return;
    let changed = false;
    const newChildren = dataChildren.map((child, i) => {
      const engineId = engineBoxes[i]?.data.id;
      if (engineId && child.id !== engineId) {
        changed = true;
        return { ...child, id: engineId };
      }
      return child;
    });
    if (changed) {
      this._data = { ...this._data, children: newChildren };
    }
  }

  /**
   * 전체 엔진 트리에서 printPostData를 생성한다.
   * z-index 오름차순으로 정렬하여 반환한다.
   *
   * @returns PrintPostData 배열 (z-index 오름차순)
   */
  get printPostData(): PrintPostData[] {
    if (this._dirty) throw createDirtyError('DocumentEngine');
    const data: PrintPostData[] = [];
    const sorted = [...this._childBoxEngines].sort((a, b) => a.zIndex - b.zIndex);
    for (const boxEngine of sorted) {
      data.push(...boxEngine.printPostData);
    }
    return data;
  }

  /**
   * 기존 부모 엔진에서 박스 엔진 참조를 제거한다.
   *
   * `_buildBoxEngine`에서 reparent(동일 id 박스가 다른 컨테이너로 이동) 시
   * 기존 부모의 `childEngines`/`childBoxEngines`/`boxEngine`에서 제거하지 않으면
   * 두 부모가 동일 child를 소유하여 `printPostData` 순회 시 잘못된 absRect 계산이
   * 발생한다. 부모 타입에 따라 적절한 컬렉션에서 제거한다.
   *
   * @param box - 제거할 박스 엔진
   * @param oldParent - 기존 부모 엔진 (BoxEngineParent 인터페이스)
   */
  private _removeBoxFromParent(box: BoxEngine, oldParent: BoxEngineParent): void {
    if (oldParent instanceof BoxEngine) {
      const children = oldParent.childEngines;
      const idx = children.indexOf(box);
      if (idx >= 0) children.splice(idx, 1);
    } else if (oldParent instanceof DocumentEngine) {
      const idx = oldParent.childBoxEngines.indexOf(box);
      if (idx >= 0) oldParent.childBoxEngines.splice(idx, 1);
    } else if (oldParent instanceof TableCellEngine) {
      if (oldParent.boxEngine === box) oldParent.boxEngine = null;
    }
  }

  /**
   * 자식 박스 데이터로부터 전체 엔진 트리를 구축한다.
   *
   * 최상위 BoxEngine을 생성/재사용하고 각각의 `layout()`을 호출하여
   * 자식 엔진 트리를 재귀적으로 구축한다. BoxEngine.layout()이 자식 구축을 담당한다.
   *
   * @param childrenData - 최상위 박스 데이터 목록
   */
  private _buildTree(childrenData: BoxData[]): void {
    const ctx: BoxBuildContext = {
      prevContentEnginesByBoxId: new Map(),
      newEnginesCreated: false,
    };
    this._collectPrevContentEngines(this._childBoxEngines, ctx.prevContentEnginesByBoxId);

    const docStyle = {
      paragraphStyle: this._data.paragraphStyle,
      textStyle: this._data.textStyle,
    };
    const resources = this.resources;

    const boxEngines: BoxEngine[] = [];
    for (let childData of childrenData) {
      if (!childData.id) {
        childData = { ...childData, id: generateEngineId() };
      }
      const existingBox = this.findBoxEngineById(childData.id ?? '');
      if (existingBox) {
        const oldParent = existingBox.parent;
        if (oldParent !== this) {
          this._removeBoxFromParent(existingBox, oldParent);
        }
        existingBox.data = childData;
        existingBox.parent = this;
      } else {
        ctx.newEnginesCreated = true;
      }
      const boxEngine = existingBox ?? BoxEngine.create(childData, this);
      boxEngine.childrenData = childData.children;
      boxEngine.layout(ctx, undefined, resources, docStyle);
      boxEngines.push(boxEngine);
    }
    this._childBoxEngines = boxEngines;
    this._newEnginesCreated = ctx.newEnginesCreated;
    this._refreshParagraphOverlays(boxEngines);
  }

  /**
   * 이전 엔진 트리에서 모든 BoxEngine의 content 엔진(ImageEngine, ParagraphEngine, TableEngine)을
   * boxId → contentEngines 맵으로 수집한다. 트리 재구축 시 새 BoxEngine이 만들어질 때
   * 이전 content 엔진의 상태(rgbaData 등)를 보존하기 위해 사용한다.
   */
  private _collectPrevContentEngines(
    boxEngines: BoxEngine[],
    map: Map<string, (ImageEngine | ParagraphEngine | TableEngine)[]>,
  ): void {
    for (const be of boxEngines) {
      const contentEngines = be.childEngines.filter(e => !(e instanceof BoxEngine)) as (ImageEngine | ParagraphEngine | TableEngine)[];
      if (be.data.id) {
        map.set(be.data.id, contentEngines);
      }
      const childBoxes = be.childBoxEngines;
      if (childBoxes.length > 0) {
        this._collectPrevContentEngines(childBoxes, map);
      }
      for (const ce of contentEngines) {
        if (ce instanceof TableEngine) {
          for (const rowEngine of ce.rowEngines) {
            for (const cellEngine of rowEngine.cellEngines) {
              const cellBox = cellEngine.boxEngine;
              if (cellBox) {
                this._collectPrevContentEngines([cellBox], map);
              }
            }
          }
        }
      }
    }
  }

  /**
   * 모든 박스의 paragraph overlayEngines를 갱신한다.
   *
   * 엔진 우선 원칙: 엔진 트리가 단일 소스 오브 트루스로 overlay 관계를 결정한다.
   * overlay가 0개인 paragraph도 갱신하여, 이전 렌더링에서 overlay가 있었지만
   * 현재 사라진 경우 stale overlayEngines가 남지 않도록 한다.
   *
   * overlayEngines이 이전과 동일(참조 기반)하면 `updateOverlayContext`를 스킵하여
   * 불필요한 `layoutText()` 호출을 줄인다.
   *
   * @param boxEngines - 갱신할 박스 엔진 배열 (재귀 순회)
   */
  private _refreshParagraphOverlays(boxEngines: BoxEngine[]): void {
    for (const be of boxEngines) {
      const inheritStyle = this._buildInheritStyle(be.data, be.parent);
      const childEngines = be.childEngines;
      for (const ce of childEngines) {
        if (ce instanceof ParagraphEngine) {
          const newOverlay = be.overlayElements;
          const oldOverlay = ce.data.overlayEngines;
          const overlayChanged =
            newOverlay.length !== oldOverlay.length ||
            newOverlay.some((e, i) => e !== oldOverlay[i]);
          if (overlayChanged) {
            ce.updateOverlayContext(
              newOverlay,
              be.absRect,
              {
                ...inheritStyle,
                parentHeight: be.absHeight,
                parentWidth: be.absWidth,
              },
            );
            ce.layoutText();
          } else if (!ce.hasLayoutCache) {
            ce.layoutText();
          }
        } else if (ce instanceof TableEngine) {
          for (const rowEngine of ce.rowEngines) {
            for (const cellEngine of rowEngine.cellEngines) {
              const cellBox = cellEngine.boxEngine;
              if (cellBox) {
                this._refreshParagraphOverlays([cellBox]);
              }
            }
          }
        }
      }
      const childBoxes = be.childBoxEngines;
      if (childBoxes.length > 0) {
        this._refreshParagraphOverlays(childBoxes);
      }
    }
  }

  /**
   * 부모로부터 상속 스타일을 구성한다.
   * _refreshParagraphOverlays에서 사용한다.
   */
  private _buildInheritStyle(
    _boxData: BoxData,
    parent: BoxEngineParent,
  ): InheritStyle {
    const gc = parent.gridCalculator;
    const padTop = (parent as { paddingTop?: number }).paddingTop ?? 0;
    const padRight = (parent as { paddingRight?: number }).paddingRight ?? 0;
    const padBottom = (parent as { paddingBottom?: number }).paddingBottom ?? 0;
    const padLeft = (parent as { paddingLeft?: number }).paddingLeft ?? 0;
    return {
      ...this._data.textStyle,
      ...this._data.paragraphStyle,
      parentWidth: gc ? gc.editableWidth : 0,
      parentHeight: gc ? gc.editableHeight : 0,
      paddingTop: padTop,
      paddingRight: padRight,
      paddingBottom: padBottom,
      paddingLeft: padLeft,
    };
  }
}

/**
 * 박스 엔진 배열에서 ID가 일치하는 엔진을 재귀적으로 검색한다.
 *
 * BoxEngine 자신, 자식 컨텐츠 엔진(ParagraphEngine, ImageEngine, TableEngine),
 * 그리고 중첩된 자식 박스와 테이블 셀 내부 박스까지 모두 순회한다.
 *
 * @param boxEngines - 검색 대상 박스 엔진 배열
 * @param id - 검색할 엔진 ID
 * @returns 일치하는 엔진 또는 undefined
 */
function _findEngineByIdInBoxes(
  boxEngines: BoxEngine[],
  id: string,
): BoxEngine | ParagraphEngine | ImageEngine | TableEngine | undefined {
  for (const be of boxEngines) {
    if (be.data.id === id) return be;

    for (const ce of be.childEngines) {
      if (ce instanceof ParagraphEngine && ce.id === id) return ce;
      if (ce instanceof ImageEngine && ce.id === id) return ce;
      if (ce instanceof TableEngine && ce.data.id === id) return ce;
    }

    const childBoxes = be.childBoxEngines;
    if (childBoxes.length > 0) {
      const found = _findEngineByIdInBoxes(childBoxes, id);
      if (found) return found;
    }

    for (const ce of be.childEngines) {
      if (ce instanceof TableEngine) {
        for (const rowEngine of ce.rowEngines) {
          for (const cellEngine of rowEngine.cellEngines) {
            const cellBox = cellEngine.boxEngine;
            if (cellBox) {
              const found = _findEngineByIdInBoxes([cellBox], id);
              if (found) return found;
            }
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * 박스 엔진 트리에서 특정 역할(`role`)을 가진 모든 박스 엔진을 수집한다.
 *
 * @param boxEngines - 검색 대상 박스 엔진 배열
 * @param role - 검색할 박스 역할
 * @returns 일치하는 박스 엔진 배열
 */
function _findBoxEnginesByRoleInBoxes(
  boxEngines: BoxEngine[],
  role: BoxRole,
): BoxEngine[] {
  const results: BoxEngine[] = [];
  for (const be of boxEngines) {
    if (be.role === role) results.push(be);

    const childBoxes = be.childBoxEngines;
    if (childBoxes.length > 0) {
      results.push(..._findBoxEnginesByRoleInBoxes(childBoxes, role));
    }

    for (const ce of be.childEngines) {
      if (ce instanceof TableEngine) {
        for (const rowEngine of ce.rowEngines) {
          for (const cellEngine of rowEngine.cellEngines) {
            const cellBox = cellEngine.boxEngine;
            if (cellBox) {
              results.push(..._findBoxEnginesByRoleInBoxes([cellBox], role));
            }
          }
        }
      }
    }
  }
  return results;
}