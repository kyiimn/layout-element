/**
 * Node.js 호환 박스 레이아웃 계산 엔진.
 *
 * 기존 `LayoutBoxElement`에서 수치 계산 로직을 추출한 순수 엔진.
 * - `relLeft`/`relTop`/`absLeft`/`absTop`/`absWidth`/`absHeight` 계산
 * - `overlayElements` (형제 박스 중 z-index 높고 교차하는 요소)
 * - `contentType`/`contentElement` (자식 트리에서 실제 콘텐츠 식별)
 * - DOM 트리 대신 엔진 트리(부모/자식 엔진 참조) 사용
 * - 부모 엔진 객체를 직접 참조하여 실시간으로 부모 상태 반영
 *
 * @file src/engine/box-engine.ts
 */

import type { BoxData, BoxPosition, BoxRole, ParagraphData, ImageData, TableData, InheritStyle, ParagraphStyle, TextStyle, TextData } from "@/types";
import type { AbsRect, BoxContentType, EngineResources, GridCalculatorEngineOptions } from "./types";
import type { PrintPostData } from "@/types";
import { GridCalculatorEngine } from "./grid-calculator-engine";
import { ImageEngine } from "./image-engine";
import type { RgbaData } from "./image-engine";
import { ParagraphEngine } from "./paragraph-engine";
import { TableEngine, TableCellEngine } from "./table-engine";
import { checkOverlapMm } from "./overlap-engine";
import type { BoxEngineParent } from "./types";
import { DocumentEngine, generateEngineId } from "./document-engine";
import { DEFAULT_BORDER_STYLE } from "@/constants";
import { valueEqual } from "@/utils/value-equal";
import { isNodeJs, decodeBase64ImageToRgbaSync } from "./image-decoder";

/**
 * 박스 레이아웃과 좌표를 계산하는 순수 엔진.
 *
 * 부모 엔진 객체를 직접 참조하여 실시간으로 부모의 absRect/gridCalculator를 읽는다.
 * 반전/데이터 변경 시 부모의 상태가 변경되어도 자동으로 반영된다.
 *
 * @example
 * const boxEngine = BoxEngine.create(
 *   { type: 'box', left: 0, top: 0, width: 3, height: 10, position: 'static' },
 *   documentEngine,
 * );
 * boxEngine.absRect;  // { absLeft: 0, absTop: 0, absWidth: 120, absHeight: 48 }
 */
export class BoxEngine {
  private _data: BoxData;
  private _parent: BoxEngineParent;
  private _childEngines: (BoxEngine | ImageEngine | ParagraphEngine | TableEngine)[] = [];
  private _gridCalculator: GridCalculatorEngine | null = null;

  /** 엔진 트리 구축 시 필요한 리소스. layout() 호출 시 주입된다. */
  private _resources: EngineResources | null = null;

  /** 문서 기본 스타일 (GC 옵션 및 inheritStyle 계산용). layout() 호출 시 주입된다. */
  private _docStyle: { paragraphStyle: ParagraphStyle; textStyle: TextStyle } | null = null;

  /** Generation counter — incremented on data/parent/gridCalculator change. */
  private _generation: number = 0;

  /** 성능 캐시: absRect. parent generation 및 자신의 generation mismatch 시 무효화. */
  private _absRectCache: AbsRect | null = null;
  private _absRectParentGen: number = -1;
  private _absRectSelfGen: number = -1;

  /**
   * 성능 캐시: overlayElements.
   * 자기 generation, 부모 generation, 형제 박스 generation 합계, 부모 overlayElements 배열 참조 기반 무효화.
   * 형제 generation 합계는 O(N)이지만 overlayElements 자체가 O(N)이므로
   * 캐시 히트 시 checkOverlapMm × 형제 수 + filter × 3회를 스킵하여 이득.
   * 부모 overlayElements 배열 참조로 부모의 overlay 재계산(형제 추가 등)도 감지.
   */
  private _overlayElementsCache: BoxEngine[] | null = null;
  private _overlaySelfGen: number = -1;
  private _overlayParentGen: number = -1;
  private _overlaySiblingGenSum: number = -1;
  private _overlayParentOverlayRef: BoxEngine[] | null = null;

  /**
   * 정적 팩토리 메서드. `new` 직접 사용 금지.
   *
   * @param data - 박스 데이터
   * @param parent - 부모 엔진 (DocumentEngine | BoxEngine | TableCellEngine)
   * @returns BoxEngine 인스턴스
   */
  static create(data: BoxData, parent: BoxEngineParent): BoxEngine {
    return new this(data, parent);
  }

  private constructor(data: BoxData, parent: BoxEngineParent) {
    this._data = data;
    this._parent = parent;
  }

  /**
   * 박스 데이터를 설정한다.
   *
   * 기하 필드(`left`/`top`/`width`/`height`/`position`) 또는
   * `zIndex`/`role`이 변경된 경우에만 `_generation`을 증가시켜
   * `absRect`/`overlayElements` 캐시를 무효화한다.
   *
   * @param d - 새 박스 데이터
   */
  set data(d: BoxData) {
    const old = this._data;
    const cacheInvalidating =
      old.left !== d.left ||
      old.top !== d.top ||
      old.width !== d.width ||
      old.height !== d.height ||
      (old.position ?? 'static') !== (d.position ?? 'static') ||
      old.zIndex !== d.zIndex ||
      old.role !== d.role;
    this._data = d;
    if (cacheInvalidating) {
      this._generation++;
    }
  }

  /** 현재 박스 데이터 */
  get data(): BoxData {
    return this._data;
  }

  /** Generation counter (캐시 무효화 감지용) */
  get generation(): number {
    return this._generation;
  }

  /**
   * 형제 박스의 `overlayElements` 캐시를 무효화한다.
   * 자식 엔진의 `overlapMode` 변경 시 호출 —
   * `overlayElements`가 `overlapMode`에 의존하지만
   * `overlapMode` 변경은 `data` setter를 거치지 않으므로 명시적 무효화가 필요.
   */
  _invalidateOverlayCache(): void {
    this._generation++;
  }

  /**
   * 엔진이 현재 관리 중인 상태에서 BoxData를 추출한다.
   *
   * `children`은 원본이 아닌 자식 엔진의 `extractData`에서 동적으로 조립한다.
   * 메모이제이션: children이 없는 경우에만 캐시 (자식 변경 추적 비용 회피).
   *
   * @returns 엔진 현재 상태 기반의 BoxData
   */
  get extractData(): BoxData {
    const children: BoxData[] | ParagraphData | ImageData | TableData | undefined = (() => {
      if (this._childEngines.length === 0) return undefined;
      const childData = this._childEngines.map(e => e.extractData);
      if (childData.length === 1 && childData[0].type !== 'box') {
        return childData[0] as ParagraphData | ImageData | TableData;
      }
      return childData as BoxData[];
    })();

    return {
      ...this._data,
      position: this.position,
      zIndex: this.zIndex,
      role: this.role,
      paddingTop: this.paddingTop,
      paddingRight: this.paddingRight,
      paddingBottom: this.paddingBottom,
      paddingLeft: this.paddingLeft,
      borderTopWidth: this._data.borderTopWidth ?? 0,
      borderBottomWidth: this._data.borderBottomWidth ?? 0,
      borderLeftWidth: this._data.borderLeftWidth ?? 0,
      borderRightWidth: this._data.borderRightWidth ?? 0,
      borderStyle: this._data.borderStyle ?? DEFAULT_BORDER_STYLE,
      backgroundOpacity: this._data.backgroundOpacity ?? 1,
      priority: this._data.priority ?? 0,
      lock: this._data.lock ?? false,
      children,
    };
  }

  /** 부모 엔진 참조 */
  get parent(): BoxEngineParent {
    return this._parent;
  }

  /** 부모 엔진 참조를 갱신한다. */
  set parent(p: BoxEngineParent) {
    if (this._parent === p) return;
    this._parent = p;
    this._generation++;
  }

  /** 박스 position 모드 ('static' | 'absolute') */
  get position(): BoxPosition {
    return this._data.position ?? 'static';
  }

  /** 박스 left 값 (static=컬럼 인덱스, absolute=mm) */
  get left(): number {
    return this._data.left;
  }

  /** 박스 top 값 (mm) */
  get top(): number {
    return this._data.top;
  }

  /** 박스 width 값 (static=컬럼 span, absolute=mm) */
  get width(): number {
    return this._data.width;
  }

  /** 박스 height 값 (static=라인 수, absolute=mm) */
  get height(): number {
    return this._data.height;
  }

  /** z-index (role 기반 override 적용) */
  get zIndex(): number {
    const role = this._data.role;
    if (role === 'ad') return 91000;
    if (role === 'header') return 91001;
    return this._data.zIndex ?? 0;
  }

  /** 박스 role */
  get role(): BoxRole {
    return this._data.role ?? 'none';
  }

  /** 패딩 (mm) */
  get paddingTop(): number { return this._data.paddingTop ?? 0; }
  get paddingRight(): number { return this._data.paddingRight ?? 0; }
  get paddingBottom(): number { return this._data.paddingBottom ?? 0; }
  get paddingLeft(): number { return this._data.paddingLeft ?? 0; }

  /**
   * 부모 기준 상대 X 좌표 (mm).
   * static: 부모 그리드의 컬럼 좌표.
   * absolute: 부모 패딩 + left.
   */
  get relLeft(): number {
    if (this.position !== 'absolute') {
      const gc = this._parent.gridCalculator;
      if (!gc) return 0;
      const coord = gc.columnCoords[this.left];
      return coord ? coord.x1 : 0;
    }
    return this.paddingLeft + this.left;
  }

  /**
   * 부모 기준 상대 Y 좌표 (mm).
   * static: 부모 그리드의 컬럼 y1 + lineHeight × top.
   * absolute: 부모 패딩 + top.
   */
  get relTop(): number {
    if (this.position !== 'absolute') {
      const gc = this._parent.gridCalculator;
      if (!gc) return 0;
      const { columnCoords, lineHeight } = gc;
      const coord = columnCoords[this.left];
      return coord ? coord.y1 + (lineHeight * this.top) : 0;
    }
    return this.paddingTop + this.top;
  }

  /**
   * 지면 기준 절대 X 좌표 (mm).
   * 부모가 document면 relLeft와 동일, 아니면 부모 absLeft + relLeft.
   */
  get absLeft(): number {
    if (this._parent.isDocument) return this.relLeft;
    return this._parent.absRect.absLeft + this.relLeft;
  }

  /**
   * 지면 기준 절대 Y 좌표 (mm).
   * 부모가 document면 relTop과 동일, 아니면 부모 absTop + relTop.
   */
  get absTop(): number {
    if (this._parent.isDocument) return this.relTop;
    return this._parent.absRect.absTop + this.relTop;
  }

  /**
   * 절대 너비 (mm).
   * static: 부모 그리드 컬럼 좌표로 계산.
   * absolute: width 그대로.
   */
  get absWidth(): number {
    if (this.position !== 'absolute') {
      const gc = this._parent.gridCalculator;
      if (!gc) return 0;
      const { columnCoords, columnCount } = gc;
      const col = Math.min(columnCount, this.left + this.width) - 1;
      if (col < 0 || !columnCoords[col] || !columnCoords[this.left]) return 0;
      return columnCoords[col].x2 - columnCoords[this.left].x1;
    }
    return this.width;
  }

  /**
   * 절대 높이 (mm).
   * static: lineHeight × height - (lineHeight - fontSize).
   * 부모 contentHeight로 클램프.
   * 테이블 셀(TableCellEngine) 내부 static box는 셀 높이로 stretch —
   * DOM(`box.element.ts` `_applyStyle`)이 `tdContentHeight`를 height로 사용하는 것과 일치.
   * absolute: height 그대로.
   */
  get absHeight(): number {
    if (this.position !== 'absolute') {
      const gc = this._parent.gridCalculator;
      if (!gc) return 0;
      if ((this._parent as { isTableCellEngine?: boolean }).isTableCellEngine) {
        return Math.max(0, gc.contentHeight);
      }
      const { fontSize, lineHeight, contentHeight } = gc;
      let calcHeight = lineHeight * this.height - (lineHeight - fontSize);
      if (contentHeight) {
        const parentPadTop = this._parent.paddingTop;
        calcHeight = Math.min(calcHeight, contentHeight - (this.relTop - parentPadTop));
      }
      return Math.max(0, calcHeight);
    }
    return this.height;
  }

  /**
   * 절대 사각형 (mm).
   * 메모이제이션: 자신의 generation 및 부모의 generation이 변경되지 않으면 캐시 재사용.
   * @returns 절대 사각형 AbsRect
   */
  get absRect(): AbsRect {
    const parentGen = this._parent.generation;
    if (this._absRectCache !== null
      && this._absRectParentGen === parentGen
      && this._absRectSelfGen === this._generation) {
      return this._absRectCache;
    }

    const result: AbsRect = {
      absLeft: this.absLeft,
      absTop: this.absTop,
      absWidth: this.absWidth,
      absHeight: this.absHeight,
    };

    this._absRectCache = result;
    this._absRectParentGen = parentGen;
    this._absRectSelfGen = this._generation;
    return result;
  }

  /**
   * 콘텐츠 영역의 절대 사각형 (mm).
   * padding을 제외한 영역으로, 자식 image/paragraph가 차지하는 실제 영역.
   * `LayoutImageElement.absLeft/absTop/absWidth/absHeight`와 동일 공식.
   */
  get contentAbsRect(): AbsRect {
    return {
      absLeft: this.absLeft + this.paddingLeft,
      absTop: this.absTop + this.paddingTop,
      absWidth: this.absWidth - this.paddingLeft - this.paddingRight,
      absHeight: this.absHeight - this.paddingTop - this.paddingBottom,
    };
  }

  /**
   * 박스가 담고 있는 콘텐츠의 타입.
   * 자식이 1개이고 그 자식이 box면 재귀적으로 파고들어 식별.
   */
  get contentType(): BoxContentType {
    if (this._childEngines.length !== 1) {
      return null;
    }
    const child = this._childEngines[0];
    if (child instanceof BoxEngine) return child.contentType;
    if (child instanceof TableEngine) return 'table';
    if (child instanceof ImageEngine) return 'image';
    if (child instanceof ParagraphEngine) return 'paragraph';
    return null;
  }

  /**
   * 가장 깊은 비-box 자식 엔진.
   * 중첩 box(A→B→image)에서 image 엔진을 반환.
   */
  get contentElement(): ImageEngine | ParagraphEngine | TableEngine | null {
    if (this._childEngines.length !== 1) {
      return null;
    }
    const child = this._childEngines[0];
    if (child instanceof BoxEngine) return child.contentElement;
    return child as ImageEngine | ParagraphEngine | TableEngine | null;
  }

  /**
   * 이 박스보다 z-index가 높고 교차하는 형제 박스 엔진 목록.
   * 부모의 overlayElements(상위 전파) + 부모의 자식 박스 중 z-index 높고 교차하는 것.
   * overlapMode === 'none'인 이미지/단락 박스는 제외.
   *
   * 메모이제이션: 자기 generation, 부모 generation, 형제 박스 generation 합계,
   * 부모 overlayElements 배열 참조가 모두 불변이면 캐시된 결과를 반환.
   * 형제 박스의 위치/zIndex 변경은 형제 generation 증가로 감지되며,
   * 부모의 형제 추가 등은 부모 overlayElements 배열 참조 변경으로 감지된다.
   * @returns 오버레이 박스 엔진 배열
   */
  get overlayElements(): BoxEngine[] {
    const parentGen = this._parent.generation;
    const selfGen = this._generation;
    const siblingBoxes = this._parent.childBoxEngines;
    let siblingGenSum = 0;
    for (const s of siblingBoxes) siblingGenSum += s._generation;

    const parentOverlay = this._parent.isDocument ? null : this._parent.overlayElements;

    if (this._overlayElementsCache !== null
      && this._overlaySelfGen === selfGen
      && this._overlayParentGen === parentGen
      && this._overlaySiblingGenSum === siblingGenSum
      && this._overlayParentOverlayRef === parentOverlay) {
      return this._overlayElementsCache;
    }

    const list: BoxEngine[] = [];
    if (parentOverlay) {
      list.push(...parentOverlay.filter(e => checkOverlapMm(e.absRect, this.absRect)));
    }

    const self = this;
    let overlay = siblingBoxes.filter(e => e !== self && e.zIndex > this.zIndex);
    overlay = overlay.filter(e => {
      const ct = e.contentType;
      if (ct === 'image') {
        const img = e.contentElement as ImageEngine | null;
        if (img && img.overlapMode === 'none') return false;
      }
      if (ct === 'paragraph') {
        const para = e.contentElement as ParagraphEngine | null;
        if (para && para.overlapMode === 'none') return false;
      }
      if (ct === null) {
        const para = e.childEngines.find(ce => ce instanceof ParagraphEngine) as ParagraphEngine | undefined;
        if (para && para.overlapMode === 'none') return false;
      }
      return true;
    });
    overlay = overlay.filter(e => checkOverlapMm(e.absRect, this.absRect));

    list.push(...overlay);

    this._overlayElementsCache = list;
    this._overlaySelfGen = selfGen;
    this._overlayParentGen = parentGen;
    this._overlaySiblingGenSum = siblingGenSum;
    this._overlayParentOverlayRef = parentOverlay;
    return list;
  }

  /**
   * 자신을 부모로 하는 직계 박스 엔진 중 ID가 일치하는 것을 반환한다.
   * BoxEngineParent 인터페이스를 구현.
   */
  findBoxEngineById(id: string): BoxEngine | undefined {
    return this._childEngines.find(
      (e): e is BoxEngine => e instanceof BoxEngine && e.data.id === id,
    );
  }

  /**
   * 이 박스의 자식 엔진 중 ID가 일치하는 엔진을 재귀적으로 검색한다.
   *
   * BoxEngine, ParagraphEngine, ImageEngine, TableEngine 모두 검색 대상이다.
   * 테이블 셀 내부 박스도 재귀적으로 순회한다.
   *
   * @param id - 검색할 엔진 ID
   * @returns 일치하는 엔진 또는 undefined
   */
  findEngineById(id: string): BoxEngine | ParagraphEngine | ImageEngine | TableEngine | undefined {
    if (this._data.id === id) return this;

    for (const ce of this._childEngines) {
      if (ce instanceof ParagraphEngine && ce.id === id) return ce;
      if (ce instanceof ImageEngine && ce.id === id) return ce;
      if (ce instanceof TableEngine && ce.data.id === id) return ce;
    }

    for (const ce of this._childEngines) {
      if (ce instanceof BoxEngine) {
        const found = ce.findEngineById(id);
        if (found) return found;
      }
      if (ce instanceof TableEngine) {
        for (const rowEngine of ce.rowEngines) {
          for (const cellEngine of rowEngine.cellEngines) {
            const cellBox = cellEngine.boxEngine;
            if (cellBox) {
              const found = cellBox.findEngineById(id);
              if (found) return found;
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * 자식 엔진 목록을 설정한다.
   * 엔진 트리를 구축할 때 호출.
   *
   * @param engines - 자식 엔진 배열
   */
  set childEngines(engines: (BoxEngine | ImageEngine | ParagraphEngine | TableEngine)[]) {
    if (this._childEngines === engines) return;
    this._childEngines = engines;
    this._generation++;
  }

  /** 자식 엔진 목록 */
  get childEngines(): (BoxEngine | ImageEngine | ParagraphEngine | TableEngine)[] {
    return this._childEngines;
  }

  /** 자식 박스 엔진만 필터링하여 반환 (overlayElements 계산용) */
  get childBoxEngines(): BoxEngine[] {
    return this._childEngines.filter((e): e is BoxEngine => e instanceof BoxEngine);
  }

  /** 그리드 계산기 (자식 박스 배치용) */
  get gridCalculator(): GridCalculatorEngine | null {
    return this._gridCalculator;
  }

  /** 그리드 계산기를 설정한다. */
  set gridCalculator(calc: GridCalculatorEngine | null) {
    this._gridCalculator = calc;
    this._generation++;
  }

  /** document 타입 여부 (항상 false) */
  get isDocument(): boolean {
    return false;
  }

  /**
   * 이 박스와 자식 요소들의 printPostData를 생성한다.
   * z-index 오름차순으로 자식을 정렬하여 반환한다.
   */
  get printPostData(): PrintPostData[] {
    const data: PrintPostData[] = [];

    const doc = this._findDocumentEngine();
    const colorRegistry = doc?._colorRegistry;

    const rect = this.absRect;
    data.push({
      color: this._data.borderColor && colorRegistry
        ? colorRegistry.get(this._data.borderColor)
        : undefined,
      backgroundColor: this._data.backgroundColor && colorRegistry
        ? colorRegistry.get(this._data.backgroundColor)
        : undefined,
      backgroundOpacity: this._data.backgroundOpacity ?? 1,
      data: this.extractData,
      rect: {
        x: rect.absLeft,
        y: rect.absTop,
        width: rect.absWidth,
        height: rect.absHeight,
      },
    });

    const sorted = [...this._childEngines].sort((a, b) => {
      const az = a instanceof BoxEngine ? a.zIndex : 0;
      const bz = b instanceof BoxEngine ? b.zIndex : 0;
      return az - bz;
    });
    for (const child of sorted) {
      if (child instanceof BoxEngine) data.push(...child.printPostData);
      else if (child instanceof ParagraphEngine) data.push(...child.printPostData);
      else if (child instanceof ImageEngine) {
        data.push(...child.buildPrintPostData(this.contentAbsRect));
      }
      else if (child instanceof TableEngine) {
        data.push(...child.printPostData);
      }
    }

    return data;
  }

  private _findDocumentEngine(): DocumentEngine | null {
    let p: BoxEngineParent = this._parent;
    while (p instanceof BoxEngine) {
      p = p.parent;
    }
    if (p instanceof DocumentEngine) return p;
    return null;
  }

  /**
   * 이 박스의 자식 엔진 트리를 `this._data.children`로부터 재구축한다.
   *
   * DocumentEngine._buildTree()가 최상위 박스에 대해 호출하며,
   * 내부적으로 재귀적으로 자식 박스의 layout()을 호출한다.
   * 기존 content 엔진(ParagraphEngine, ImageEngine, TableEngine)은 id 매칭으로 보존한다.
   *
   * @param ctx - 트리 구축 컨텍스트 (prevContentEnginesByBoxId, newEnginesCreated)
   * @param resources - 엔진 리소스 (ppm, fontLoader, colorRegistry)
   * @param docStyle - 문서 기본 스타일 (paragraphStyle, textStyle)
   */
  layout(
    ctx: BoxBuildContext,
    childrenData: BoxData[] | ParagraphData | TextData | ImageData | TableData | undefined,
    resources?: EngineResources,
    docStyle?: { paragraphStyle: ParagraphStyle; textStyle: TextStyle },
  ): void {
    if (resources) this._resources = resources;
    if (docStyle) this._docStyle = docStyle;
    if (!this._resources || !this._docStyle) return;

    const boxData = this._data;
    const parent = this._parent;

    const inheritStyle = this._buildInheritStyle(parent);
    const parentGc = parent.gridCalculator;
    const isStatic = boxData.position !== 'absolute';
    const columns = isStatic && parentGc
      ? parentGc.columnWidth.slice(boxData.left, boxData.left + boxData.width)
      : [boxData.width];
    const gap = isStatic && parentGc
      ? parentGc.gaps.slice(boxData.left, boxData.left + boxData.width - 1)
      : [];
    const gcOptions: GridCalculatorEngineOptions = {
      width: this.absWidth,
      height: this.absHeight,
      paddingTop: boxData.paddingTop,
      paddingBottom: boxData.paddingBottom,
      paddingLeft: boxData.paddingLeft,
      paddingRight: boxData.paddingRight,
      columns,
      gap,
      paragraphStyle: this._docStyle!.paragraphStyle,
      textStyle: this._docStyle!.textStyle,
      isBox: true,
    };

    const existingGc = this._gridCalculator;
    if (existingGc && this._gcParamsEqual(existingGc, gcOptions)) {
      // 파라미터 동일 → GC 재사용, _calcColumnGridCoords 재실행 스킵
    } else {
      this._gridCalculator = GridCalculatorEngine.create(gcOptions, this._resources!.ppm);
    }

    if (!childrenData) {
      if (this._childEngines.length > 0) this._childEngines = [];
      return;
    }

    const prevContentEngines = this._childEngines.filter(
      e => !(e instanceof BoxEngine),
    ) as (ImageEngine | ParagraphEngine | TableEngine)[];
    if (prevContentEngines.length === 0 && boxData.id) {
      const fromMap = ctx.prevContentEnginesByBoxId.get(boxData.id);
      if (fromMap) prevContentEngines.push(...fromMap);
    }

    const childEngines: (BoxEngine | ImageEngine | ParagraphEngine | TableEngine)[] = [];

    if (Array.isArray(childrenData)) {
      for (const childBoxData of childrenData) {
        const childBE = this._buildChildBoxEngine(childBoxData, ctx);
        childEngines.push(childBE);
      }
    } else {
      const content = childrenData;
      if (content.type === 'paragraph' || content.type === 'text') {
        const paraData: ParagraphData = content.type === 'text'
          ? { type: 'paragraph', id: content.id, content: content.content, column: 1, gap: 0, paragraphStyle: content.paragraphStyle, textStyle: content.textStyle }
          : content;
        const pe = this._buildParagraphEngine(paraData, inheritStyle, ctx);
        childEngines.push(pe);
      } else if (content.type === 'image') {
        const ie = this._buildImageEngine(content, prevContentEngines, ctx);
        childEngines.push(ie);
      } else if (content.type === 'table') {
        const te = this._buildTableEngine(content, ctx);
        childEngines.push(te);
      }
    }

    this._childEngines = childEngines;
    this._generation++;
  }

  /**
   * 자식 BoxData로부터 BoxEngine을 구축하거나 재사용하고 layout()을 재귀 호출한다.
   * reparent(동일 id 박스가 다른 컨테이너로 이동) 시 기존 부모에서 제거한다.
   */
  private _buildChildBoxEngine(
    childBoxData: BoxData,
    ctx: BoxBuildContext,
  ): BoxEngine {
    if (!childBoxData.id) {
      childBoxData = { ...childBoxData, id: generateEngineId() };
    }

    const existingBox = this.findBoxEngineById(childBoxData.id ?? '');
    if (existingBox) {
      const oldParent = existingBox.parent;
      if (oldParent !== this) {
        this._removeBoxFromParent(existingBox, oldParent);
      }
      existingBox.data = childBoxData;
      existingBox.parent = this;
    } else {
      ctx.newEnginesCreated = true;
    }
    const childBoxEngine = existingBox ?? BoxEngine.create(childBoxData, this);

    childBoxEngine.layout(ctx, childBoxData.children, this._resources!, this._docStyle!);
    return childBoxEngine;
  }

  /**
   * 기존 부모 엔진에서 박스 엔진 참조를 제거한다 (reparent 시).
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
   * ParagraphData로부터 ParagraphEngine을 구축한다.
   * 기존 단락 엔진이 있을 때, 텍스트/컬럼/스타일/부모 기하가 불변이면
   * `data` setter(전체 리셋) 대신 `updateOverlayContext`(캐시 보존)를 사용한다.
   */
  private _buildParagraphEngine(
    paraData: ParagraphData,
    inheritStyle: InheritStyle,
    ctx: BoxBuildContext,
  ): ParagraphEngine {
    if (!paraData.id) {
      paraData = { ...paraData, id: generateEngineId() };
    }
    const gc = this._gridCalculator;
    if (!gc) {
      throw new Error('BoxEngine.gridCalculator must be set before building ParagraphEngine');
    }
    const column = paraData.column ?? gc.columnWidth;
    const gap = paraData.gap ?? gc.gaps;

    const overlayEngines = this.overlayElements;

    const newInheritStyle = {
      ...inheritStyle,
      parentHeight: this.absHeight,
      parentWidth: this.absWidth,
    };
    const parentAbsRect = this.absRect;
    const resources = this._resources!;

    const existingPara = this._childEngines.find(e => e instanceof ParagraphEngine);
    if (existingPara) {
      const pe = existingPara as ParagraphEngine;
      const oldData = pe.data;

      const structureUnchanged =
        oldData.content === paraData.content &&
        oldData.column === column &&
        oldData.gap === gap &&
        oldData.paragraphStyle === paraData.paragraphStyle &&
        oldData.textStyle === paraData.textStyle &&
        oldData.inheritStyle.parentWidth === newInheritStyle.parentWidth &&
        oldData.inheritStyle.parentHeight === newInheritStyle.parentHeight;

      if (structureUnchanged) {
        pe.updateOverlayContext(overlayEngines, parentAbsRect, newInheritStyle);
      } else {
        pe.data = {
          id: paraData.id,
          zIndex: paraData.zIndex,
          content: paraData.content,
          column,
          gap,
          paragraphStyle: paraData.paragraphStyle ?? {},
          textStyle: paraData.textStyle ?? {},
          inheritStyle: newInheritStyle,
          overlayEngines,
          parentAbsRect,
          resources,
          parentBox: this,
        };
        pe.layoutStructure();
      }
      return pe;
    }

    ctx.newEnginesCreated = true;
    const engineData = {
      id: paraData.id,
      zIndex: paraData.zIndex,
      content: paraData.content,
      column,
      gap,
      paragraphStyle: paraData.paragraphStyle ?? {},
      textStyle: paraData.textStyle ?? {},
      inheritStyle: newInheritStyle,
      overlayEngines,
      parentAbsRect,
      resources,
      parentBox: this,
    };
    const pe = ParagraphEngine.create(engineData);
    pe.layoutStructure();
    return pe;
  }

  /**
   * ImageData로부터 ImageEngine을 구축한다.
   * 기존 rgbaData는 URL이 동일할 때 보존하고, Node.js 환경에서 base64 data URI를 자동 디코딩한다.
   */
  private _buildImageEngine(
    imgData: ImageData,
    prevContentEngines: (ImageEngine | ParagraphEngine | TableEngine)[],
    ctx: BoxBuildContext,
  ): ImageEngine {
    if (!imgData.id) {
      imgData = { ...imgData, id: generateEngineId() };
    }
    const contentAbsRect = this.contentAbsRect;

    const existing = this._childEngines.find(e => e instanceof ImageEngine)
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
    ctx.newEnginesCreated = true;
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

  private _decodeRgbaIfNode(url: string): RgbaData | null {
    if (!isNodeJs()) return null;
    if (!url.startsWith('data:image/')) return null;
    return decodeBase64ImageToRgbaSync(url);
  }

  /**
   * TableData로부터 TableEngine을 구축하고 셀 내부 박스 엔진을 재귀 구축한다.
   */
  private _buildTableEngine(
    tableData: TableData,
    ctx: BoxBuildContext,
  ): TableEngine {
    if (!tableData.id) {
      tableData = { ...tableData, id: generateEngineId() };
    }
    const existing = this._childEngines.find(e => e instanceof TableEngine) as TableEngine | undefined;
    const te = existing ?? TableEngine.create(tableData, this);
    if (existing) {
      te.data = tableData;
    }
    te.layout(tableData.children);

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
      if (!cellChildren || cellChildren.length === 0) {
        cellEngine.boxEngine = null;
        continue;
      }

      const cellBoxData = cellChildren.length === 1
        ? cellChildren[0]
        : { type: 'box' as const, left: 0, top: 0, width: 1, height: 1, children: cellChildren };
      const cellBoxEngine = this._buildCellBoxEngine(cellBoxData, cellEngine, ctx);
      cellEngine.boxEngine = cellBoxEngine;
    }

    return te;
  }

  /**
   * 테이블 셀 내부 박스 엔진을 구축하거나 재사용하고 layout()을 호출한다.
   *
   * `TableEngine.buildCellBoxEngines()`에서도 호출하여
   * `TableElement._layoutStructure()`가 `engine.layout()` 후 셀 박스 엔진을
   * 재구축할 수 있도록 공개 메서드로 제공한다.
   *
   * @param cellBoxData - 셀 내부 박스 데이터
   * @param cellEngine - 셀 엔진
   * @param ctx - 박스 빌드 컨텍스트
   * @returns 구축 또는 재사용된 BoxEngine
   */
  buildCellBoxEngine(
    cellBoxData: BoxData,
    cellEngine: TableCellEngine,
    ctx: BoxBuildContext,
  ): BoxEngine {
    if (!cellBoxData.id) {
      cellBoxData = { ...cellBoxData, id: generateEngineId() };
    }

    const existingBox = cellEngine.findBoxEngineById(cellBoxData.id ?? '');
    if (existingBox) {
      existingBox.data = cellBoxData;
      existingBox.parent = cellEngine;
    } else {
      ctx.newEnginesCreated = true;
    }
    const cellBoxEngine = existingBox ?? BoxEngine.create(cellBoxData, cellEngine);

    cellBoxEngine.layout(ctx, cellBoxData.children, this._resources!, this._docStyle!);
    return cellBoxEngine;
  }

  /**
   * `_buildCellBoxEngine`의 internal 별칭.
   * 기존 호출 호환성을 위해 유지한다.
   */
  private _buildCellBoxEngine = this.buildCellBoxEngine;

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
  private _buildInheritStyle(parent: BoxEngineParent): InheritStyle {
    const gc = parent.gridCalculator;
    const padTop = (parent as { paddingTop?: number }).paddingTop ?? 0;
    const padRight = (parent as { paddingRight?: number }).paddingRight ?? 0;
    const padBottom = (parent as { paddingBottom?: number }).paddingBottom ?? 0;
    const padLeft = (parent as { paddingLeft?: number }).paddingLeft ?? 0;
    const docStyle = this._docStyle;
    return {
      ...(docStyle?.textStyle ?? {}),
      ...(docStyle?.paragraphStyle ?? {}),
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
 * BoxEngine.layout() 트리 구축 중 공유되는 컨텍스트.
 * - prevContentEnginesByBoxId: 이전 트리의 content 엔진을 id로 보존하여 rgbaData 등 유지
 * - newEnginesCreated: 새 엔진이 생성되었는지 여부 (DocumentEngine._syncEngineIdsToDom 스킵 판단)
 */
export interface BoxBuildContext {
  prevContentEnginesByBoxId: Map<string, (ImageEngine | ParagraphEngine | TableEngine)[]>;
  newEnginesCreated: boolean;
}