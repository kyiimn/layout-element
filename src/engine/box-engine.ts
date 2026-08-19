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

import type { BoxData, BoxPosition, BoxRole } from "@/types";
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
   * 좌표/크기/스타일 변경 시 호출.
   *
   * @param d - 새 박스 데이터
   */
  set data(d: BoxData) {
    this._data = d;
  }

  /** 현재 박스 데이터 */
  get data(): BoxData {
    return this._data;
  }

  /** 부모 엔진 참조 */
  get parent(): BoxEngineParent {
    return this._parent;
  }

  /** 부모 엔진 참조를 갱신한다. */
  set parent(p: BoxEngineParent) {
    this._parent = p;
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
    return (this._data.paddingLeft ?? 0) + this.left;
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
    return (this._data.paddingTop ?? 0) + this.top;
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
   * absolute: height 그대로.
   */
  get absHeight(): number {
    if (this.position !== 'absolute') {
      const gc = this._parent.gridCalculator;
      if (!gc) return 0;
      const { fontSize, lineHeight, contentHeight } = gc;
      let calcHeight = lineHeight * this.height - (lineHeight - fontSize);
      if (contentHeight) {
        const parentPadTop = 'paddingTop' in this._parent ? (this._parent.paddingTop as number) : 0;
        calcHeight = Math.min(calcHeight, contentHeight - (this.relTop - parentPadTop));
      }
      return Math.max(0, calcHeight);
    }
    return this.height;
  }

  /** 절대 사각형 (mm) */
  get absRect(): AbsRect {
    return {
      absLeft: this.absLeft,
      absTop: this.absTop,
      absWidth: this.absWidth,
      absHeight: this.absHeight,
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
   */
  get overlayElements(): BoxEngine[] {
    const list: BoxEngine[] = [];
    if (!this._parent.isDocument) {
      list.push(...this._parent.overlayElements.filter(e => checkOverlapMm(e.absRect, this.absRect)));
    }

    const siblingBoxes = this._parent.childBoxEngines;
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
   * 자식 엔진 목록을 설정한다.
   * 엔진 트리를 구축할 때 호출.
   *
   * @param engines - 자식 엔진 배열
   */
  set childEngines(engines: (BoxEngine | ImageEngine | ParagraphEngine | TableEngine)[]) {
    this._childEngines = engines;
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
      backgroundOpacity: this._data.backgroundOpacity,
      data: {
        ...this._data,
        borderStyle: this._data.borderStyle ?? DEFAULT_BORDER_STYLE,
      },
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
        const imgData = child.data;
        const imgAbsRect = this.absRect;
        data.push(...child.buildPrintPostData(imgAbsRect, {
          type: 'image',
          url: imgData.url,
          x: imgData.x, y: imgData.y,
          width: imgData.width, height: imgData.height,
          dpi: imgData.dpi,
          overlapPadding: imgData.overlapPadding,
          overlapMode: imgData.overlapMode,
          objectFit: imgData.objectFit,
          originalWidth: imgData.originalWidth,
          originalHeight: imgData.originalHeight,
        }));
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