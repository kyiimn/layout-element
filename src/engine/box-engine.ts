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

import type { BoxData, BoxPosition, BoxRole, ParagraphData, ImageData, TableData } from "@/types";
import type { AbsRect, BoxContentType } from "./types";
import type { PrintPostData } from "@/types";
import type { GridCalculatorEngine } from "./grid-calculator-engine";
import { ImageEngine } from "./image-engine";
import { ParagraphEngine } from "./paragraph-engine";
import { TableEngine } from "./table-engine";
import { checkOverlapMm } from "./overlap-engine";
import type { BoxEngineParent } from "./types";
import { DocumentEngine } from "./document-engine";
import { DEFAULT_BORDER_STYLE } from "@/constants";

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
}