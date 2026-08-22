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

import type { DocumentData, BoxData, ParagraphData, ImageData, TableData, InheritStyle } from "@/types";
import type { AbsRect, FontLoaderEngine, ColorRegistryEngine, BoxEngineParent, GridCalculatorEngineOptions } from "./types";
import type { PrintPostData } from "@/types";
import { GridCalculatorEngine } from "./grid-calculator-engine";
import { BoxEngine } from "./box-engine";
import { ImageEngine } from "./image-engine";
import type { RgbaData } from "./image-engine";
import { ParagraphEngine } from "./paragraph-engine";
import { TableEngine, TableCellEngine } from "./table-engine";
import { valueEqual } from "@/utils/value-equal";
import { isNodeJs, decodeBase64ImageToRgbaSync, prepareImageDecoder } from "./image-decoder";

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

  /** Generation counter — incremented on data/ppm change. Used by child BoxEngine for cache invalidation. */
  private _generation: number = 0;

  /** layout() 호출 시 새 엔진이 생성/추가되었는지 여부. _syncEngineIdsToDom 스킵 판단용. */
  private _newEnginesCreated: boolean = false;

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
   * 문서 데이터를 설정하고 그리드를 재계산한다.
   *
   * @param d - 새 문서 데이터
   */
  set data(d: DocumentData) {
    this._data = d;
    this._gridCalculator = this._createGridCalculator();
    this._childBoxEngines = [];
    this._generation++;
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
   * 문서 레이아웃을 계산한다.
   * data setter에서 그리드가 갱신되므로, 여기서는 엔진 트리 전체를 재구축한다.
   * DOM 요소 없이 DocumentData만으로 전체 엔진 트리를 구축한다.
   *
   * Node.js 환경에서 base64 data URI 이미지가 포함된 경우,
   * `overlapMode: 'path'`가 정상 동작하도록 rgbaData를 자동 주입한다.
   * (브라우저는 `LayoutImageElement._feedRgbaToEngine()`이 canvas에서 RGBA 추출)
   */
  layout(): void {
    this._newEnginesCreated = false;
    this._buildTree(this._data);
    this._syncIdsToData();
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
   * DocumentData로부터 전체 엔진 트리를 재귀적으로 구축한다.
   *
   * @param data - 문서 데이터
   */
  private _buildTree(data: DocumentData): void {
    const prevContentEnginesByBoxId = new Map<string, (ImageEngine | ParagraphEngine | TableEngine)[]>();
    this._collectPrevContentEngines(this._childBoxEngines, prevContentEnginesByBoxId);

    const boxEngines: BoxEngine[] = [];
    for (const childData of data.children ?? []) {
      const be = this._buildBoxEngine(childData, this, prevContentEnginesByBoxId);
      boxEngines.push(be);
    }
    this._childBoxEngines = boxEngines;
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
    }
  }

  /**
   * 모든 박스의 paragraph overlayEngines를 갱신한다.
   *
   * 엔진 우선 원칙: 엔진 트리가 단일 소스 오브 트루스로 overlay 관계를 결정한다.
   * overlay가 0개인 paragraph도 갱신하여, 이전 렌더링에서 overlay가 있었지만
   * 현재 사라진 경우 stale overlayEngines가 남지 않도록 한다.
   *
   * @param boxEngines - 갱신할 박스 엔진 배열 (재귀 순회)
   */
  private _refreshParagraphOverlays(boxEngines: BoxEngine[]): void {
    for (const be of boxEngines) {
      const inheritStyle = this._buildInheritStyle(be.data, be.parent);
      const childEngines = be.childEngines;
      for (const ce of childEngines) {
        if (ce instanceof ParagraphEngine) {
          const overlayEngines = be.overlayElements;
          // updateOverlayContext: _layoutCache를 보존하면서 overlay 문맥만 갱신.
          // data setter + resetIncrementalState() 대신 사용하여,
          // 입력 해시가 동일하면 layoutText()가 캐시 hit로 O(1) 스킵.
          ce.updateOverlayContext(
            overlayEngines,
            be.absRect,
            {
              ...inheritStyle,
              parentHeight: be.absHeight,
              parentWidth: be.absWidth,
            },
          );
          ce.layoutText();
        } else if (ce instanceof TableEngine) {
          // 테이블 셀 내부 박스도 순회하여 paragraph overlay 갱신.
          // TableEngine은 BoxEngine.childBoxEngines에 포함되지 않으므로
          // 별도로 rowEngines → cellEngines → childBoxEngines로 진입.
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
   * BoxData로부터 BoxEngine과 그 자식 엔진들을 재귀적으로 구축한다.
   *
   * @param boxData - 박스 데이터
   * @param parent - 부모 엔진 (DocumentEngine | BoxEngine | TableCellEngine)
   * @returns 구축된 BoxEngine
   */
  private _buildBoxEngine(
    boxData: BoxData,
    parent: BoxEngine | DocumentEngine | TableCellEngine,
    prevContentEnginesByBoxId: Map<string, (ImageEngine | ParagraphEngine | TableEngine)[]>,
  ): BoxEngine {
    if (!boxData.id) {
      boxData = { ...boxData, id: generateEngineId() };
    }

    const existingBox = parent.findBoxEngineById?.(boxData.id ?? '');
    if (existingBox) {
      const oldParent = existingBox.parent;
      if (oldParent !== parent) {
        this._removeBoxFromParent(existingBox, oldParent);
      }
      existingBox.data = boxData;
      existingBox.parent = parent;
    } else {
      this._newEnginesCreated = true;
    }
    const boxEngine = existingBox ?? BoxEngine.create(boxData, parent);

    const inheritStyle = this._buildInheritStyle(boxData, parent);
    const parentGc = parent.gridCalculator;
    const isStatic = boxData.position !== 'absolute';
    const columns = isStatic && parentGc
      ? parentGc.columnWidth.slice(boxData.left, boxData.left + boxData.width)
      : [boxData.width];
    const gap = isStatic && parentGc
      ? parentGc.gaps.slice(boxData.left, boxData.left + boxData.width - 1)
      : [];
    const gcOptions = {
      width: boxEngine.absWidth,
      height: boxEngine.absHeight,
      paddingTop: boxData.paddingTop,
      paddingBottom: boxData.paddingBottom,
      paddingLeft: boxData.paddingLeft,
      paddingRight: boxData.paddingRight,
      columns,
      gap,
      paragraphStyle: this._data.paragraphStyle,
      textStyle: this._data.textStyle,
      isBox: true,
    };

    const existingGc = boxEngine.gridCalculator;
    if (existingGc && this._gcParamsEqual(existingGc, gcOptions)) {
      // 파라미터 동일 → GC 재사용, _calcColumnGridCoords 재실행 스킵
    } else {
      boxEngine.gridCalculator = GridCalculatorEngine.create(gcOptions, this._ppm);
    }

    const children = boxData.children;
    if (!children) {
      boxEngine.childEngines = [];
      return boxEngine;
    }

    const prevContentEngines = boxEngine.childEngines.filter(
      e => !(e instanceof BoxEngine),
    ) as (ImageEngine | ParagraphEngine | TableEngine)[];
    if (prevContentEngines.length === 0 && boxData.id) {
      const fromMap = prevContentEnginesByBoxId.get(boxData.id);
      if (fromMap) prevContentEngines.push(...fromMap);
    }

    const childEngines: (BoxEngine | ImageEngine | ParagraphEngine | TableEngine)[] = [];

    if (Array.isArray(children)) {
      for (const childBoxData of children) {
        const childBE = this._buildBoxEngine(childBoxData, boxEngine, prevContentEnginesByBoxId);
        childEngines.push(childBE);
      }
    } else {
      const content = children;
      if (content.type === 'paragraph' || content.type === 'text') {
        const paraData: ParagraphData = content.type === 'text'
          ? { type: 'paragraph', id: content.id, content: content.content, column: 1, gap: 0, paragraphStyle: content.paragraphStyle, textStyle: content.textStyle }
          : content;
        const pe = this._buildParagraphEngine(paraData, boxEngine, inheritStyle);
        childEngines.push(pe);
      } else if (content.type === 'image') {
        const ie = this._buildImageEngine(content, boxEngine, prevContentEngines);
        childEngines.push(ie);
      } else if (content.type === 'table') {
        const te = this._buildTableEngine(content, boxEngine, prevContentEnginesByBoxId);
        childEngines.push(te);
      }
    }

    boxEngine.childEngines = childEngines;

    return boxEngine;
  }

  /**
   * ParagraphData로부터 ParagraphEngine을 구축한다.
   */
  private _buildParagraphEngine(
    paraData: ParagraphData,
    parentBox: BoxEngine,
    inheritStyle: InheritStyle,
  ): ParagraphEngine {
    const gc = parentBox.gridCalculator;
    if (!gc) {
      throw new Error('parentBox.gridCalculator must be set before building ParagraphEngine');
    }
    if (!paraData.id) {
      paraData = { ...paraData, id: generateEngineId() };
    }
    const column = paraData.column ?? gc.columnWidth;
    const gap = paraData.gap ?? gc.gaps;

    const overlayEngines = parentBox.overlayElements;

    const engineData = {
      id: paraData.id,
      zIndex: paraData.zIndex,
      content: paraData.content,
      column,
      gap,
      paragraphStyle: paraData.paragraphStyle ?? {},
      textStyle: paraData.textStyle ?? {},
      inheritStyle: {
        ...inheritStyle,
        parentHeight: parentBox.absHeight,
        parentWidth: parentBox.absWidth,
      },
      overlayEngines,
      parentAbsRect: parentBox.absRect,
      resources: this.resources,
    };

    const existingPara = parentBox.childEngines.find(e => e instanceof ParagraphEngine);
    if (existingPara) {
      const pe = existingPara as ParagraphEngine;
      pe.data = engineData;
      pe.layoutStructure();
      return pe;
    }

    this._newEnginesCreated = true;
    const pe = ParagraphEngine.create(engineData);
    pe.layoutStructure();
    return pe;
  }

  /**
   * ImageData로부터 ImageEngine을 구축한다.
   *
   * **rgbaData 자동 주입 (Node.js)**: Node.js 환경에서 `imgData.url`이
   * base64 data URI(`data:image/...`)인 경우, pngjs로 동기 디코딩하여
   * `ImageEngine.rgbaData`에 자동 주입한다. 이를 통해 `overlapMode: 'path'`가
   * 정상 동작한다 (rgbaData 없으면 box 모드로 폴백).
   *
   * **브라우저**: 자동 주입을 수행하지 않는다. 브라우저에서는
   * `LayoutImageElement._feedRgbaToEngine()`이 canvas `getImageData()`로
   * RGBA를 추출하여 `ImageEngine.rgbaData`에 주입한다.
   *
   * **기존 rgbaData 보존**: 엔진 재사용 시 기존 rgbaData가 있으면 보존한다.
   * 단, URL이 변경된 경우 새로 디코딩한다.
   *
   * @param imgData - 이미지 데이터
   * @param parentBox - 부모 박스 엔진
   * @param prevContentEngines - 이전 컨텐츠 엔진 배열 (재사용 대상)
   * @returns 구축된 ImageEngine
   */
  private _buildImageEngine(
    imgData: ImageData,
    parentBox: BoxEngine,
    prevContentEngines: (ImageEngine | ParagraphEngine | TableEngine)[],
  ): ImageEngine {
    if (!imgData.id) {
      imgData = { ...imgData, id: generateEngineId() };
    }
    const contentAbsRect = parentBox.contentAbsRect;

    const existing = parentBox.childEngines.find(e => e instanceof ImageEngine)
      ?? prevContentEngines.find(e => e instanceof ImageEngine);
    if (existing) {
      const imgEngine = existing as ImageEngine;
      const prevUrl = imgEngine.data.url;
      const preservedRgba = (prevUrl === imgData.url) ? imgEngine.rgbaData : null;
      imgEngine.data = {
        url: imgData.url,
        x: imgData.x,
        y: imgData.y,
        width: imgData.width,
        height: imgData.height,
        dpi: imgData.dpi,
        overlapPadding: imgData.overlapPadding,
        overlapMode: imgData.overlapMode ?? 'path',
        objectFit: imgData.objectFit ?? 'cover',
        originalWidth: imgData.originalWidth,
        originalHeight: imgData.originalHeight,
      };
      imgEngine.id = imgData.id;
      imgEngine.zIndex = imgData.zIndex;
      imgEngine.contentAbsRect = contentAbsRect;
      if (preservedRgba) {
        imgEngine.rgbaData = preservedRgba;
      } else {
        imgEngine.rgbaData = this._decodeRgbaIfNode(imgData.url);
      }
      return imgEngine;
    }
    this._newEnginesCreated = true;
    const newEngine = ImageEngine.create({
      url: imgData.url,
      x: imgData.x,
      y: imgData.y,
      width: imgData.width,
      height: imgData.height,
      dpi: imgData.dpi,
      overlapPadding: imgData.overlapPadding,
      overlapMode: imgData.overlapMode ?? 'path',
      objectFit: imgData.objectFit ?? 'cover',
      originalWidth: imgData.originalWidth,
      originalHeight: imgData.originalHeight,
    });
    newEngine.id = imgData.id;
    newEngine.zIndex = imgData.zIndex;
    newEngine.contentAbsRect = contentAbsRect;
    newEngine.rgbaData = this._decodeRgbaIfNode(imgData.url);
    return newEngine;
  }

  /**
   * Node.js 환경에서 base64 data URI 이미지를 디코딩하여 RgbaData를 반환한다.
   *
   * 브라우저 환경이거나 data URI가 아닌 경우 null을 반환한다.
   * pngjs 모듈이 로드되지 않은 경우(ESM 환경에서 `prepareImageDecoder()` 미호출)에도
   * null을 반환하며, 이때는 path 모드가 box로 폴백된다.
   *
   * @param url - 이미지 URL (data URI 또는 일반 URL)
   * @returns 디코딩된 RgbaData 또는 null
   * @internal
   */
  private _decodeRgbaIfNode(url: string): RgbaData | null {
    if (!isNodeJs()) return null;
    if (!url.startsWith('data:image/')) return null;
    return decodeBase64ImageToRgbaSync(url);
  }

  private _buildTableEngine(
    tableData: TableData,
    parentBox: BoxEngine,
    prevContentEnginesByBoxId: Map<string, (ImageEngine | ParagraphEngine | TableEngine)[]>,
  ): TableEngine {
    if (!tableData.id) {
      tableData = { ...tableData, id: generateEngineId() };
    }
    const te = TableEngine.create(tableData, parentBox);
    te.layout();

    const placements = te.gridResolution?.placements ?? [];
    for (const placement of placements) {
      const rowEngine = te.rowEngines[placement.gridRow];
      if (!rowEngine) continue;

      const placementIdx = rowEngine.cellEngines.findIndex(
        ce => ce.x === placement.x && ce.y === (placement.y - rowEngine.y),
      );
      if (placementIdx < 0) continue;
      const cellEngine = rowEngine.cellEngines[placementIdx];

      const cellChildren = placement.cell.children;
      if (!cellChildren || cellChildren.length === 0) continue;

      const cellBoxData = cellChildren.length === 1
        ? cellChildren[0]
        : { type: 'box' as const, left: 0, top: 0, width: 1, height: 1, children: cellChildren };
      const cellBoxEngine = this._buildBoxEngine(cellBoxData, cellEngine, prevContentEnginesByBoxId);
      cellEngine.boxEngine = cellBoxEngine;
    }

    return te;
  }

  /**
   * 기존 GridCalculatorEngine의 입력 파라미터와 새 옵션이 동일한지 비교한다.
   * 동일하면 _calcColumnGridCoords 재실행을 스킵하여 GC 인스턴스를 재사용.
   */
  private _gcParamsEqual(
    existing: GridCalculatorEngine,
    opts: GridCalculatorEngineOptions,
  ): boolean {
    const g = existing as unknown as {
      _width: number; _height: number;
      _paddingTop: number; _paddingBottom: number; _paddingLeft: number; _paddingRight: number;
      _inputColumns: number | number[]; _inputGap: number | number[];
      _paragraphStyle: object; _textStyle: object; _isBox: boolean;
    };
    return g._width === opts.width
      && g._height === opts.height
      && g._paddingTop === (opts.paddingTop || 0)
      && g._paddingBottom === (opts.paddingBottom || 0)
      && g._paddingLeft === (opts.paddingLeft || 0)
      && g._paddingRight === (opts.paddingRight || 0)
      && valueEqual(g._inputColumns, opts.columns)
      && valueEqual(g._inputGap, opts.gap)
      && g._paragraphStyle === opts.paragraphStyle
      && g._textStyle === opts.textStyle
      && g._isBox === opts.isBox;
  }

  /**
   * 부모로부터 상속 스타일을 구성한다.
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