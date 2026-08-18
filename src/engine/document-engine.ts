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
import type { AbsRect, FontLoaderEngine, ColorRegistryEngine } from "./types";
import type { PrintPostData } from "@/types";
import { GridCalculatorEngine } from "./grid-calculator-engine";
import { BoxEngine } from "./box-engine";
import { ImageEngine } from "./image-engine";
import { ParagraphEngine } from "./paragraph-engine";
import { TableEngine, type TableCellEngine } from "./table-engine";

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
  }

  /** 현재 문서 데이터 */
  get data(): DocumentData {
    return this._data;
  }

  /** 주입된 pixels-per-mm */
  get ppm(): number {
    return this._ppm;
  }

  set ppm(v: number) {
    this._ppm = v;
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
   * 문서 레이아웃을 계산한다.
   * data setter에서 그리드가 갱신되므로, 여기서는 엔진 트리 전체를 재구축한다.
   * DOM 요소 없이 DocumentData만으로 전체 엔진 트리를 구축한다.
   */
  layout(): void {
    this._buildTree(this._data);
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
   * DocumentData로부터 전체 엔진 트리를 재귀적으로 구축한다.
   *
   * @param data - 문서 데이터
   */
  private _buildTree(data: DocumentData): void {
    const boxEngines: BoxEngine[] = [];
    for (const childData of data.children ?? []) {
      const be = this._buildBoxEngine(childData, this);
      boxEngines.push(be);
    }
    this._childBoxEngines = boxEngines;
    this._refreshParagraphOverlays(boxEngines);
  }

  private _refreshParagraphOverlays(boxEngines: BoxEngine[]): void {
    for (const be of boxEngines) {
      const childEngines = be.childEngines;
      for (const ce of childEngines) {
        if (ce instanceof ParagraphEngine) {
          const overlayEngines = be.overlayElements;
          if (overlayEngines.length > 0) {
            ce.data = { ...ce.data, overlayEngines };
            ce.resetIncrementalState();
            ce.layoutStructure();
            ce.layoutText();
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
  private _buildBoxEngine(boxData: BoxData, parent: BoxEngine | DocumentEngine | TableCellEngine): BoxEngine {
    const existingBox = parent.findBoxEngineById?.(boxData.id ?? '');
    const boxEngine = existingBox ?? BoxEngine.create(boxData, parent);
    if (existingBox) {
      existingBox.data = boxData;
      existingBox.parent = parent;
    }

    // 박스 자체 그리드 계산기 생성 (자식 박스 배치용)
    const inheritStyle = this._buildInheritStyle(boxData, parent);
    const gc = GridCalculatorEngine.create({
      width: boxEngine.absWidth,
      height: boxEngine.absHeight,
      paddingTop: boxData.paddingTop,
      paddingBottom: boxData.paddingBottom,
      paddingLeft: boxData.paddingLeft,
      paddingRight: boxData.paddingRight,
      columns: boxData.position !== 'absolute'
        ? parent.gridCalculator!.columnWidth.slice(boxData.left, boxData.left + boxData.width)
        : [boxData.width],
      gap: boxData.position !== 'absolute'
        ? parent.gridCalculator!.gaps.slice(boxData.left, boxData.left + boxData.width - 1)
        : [],
      paragraphStyle: this._data.paragraphStyle,
      textStyle: this._data.textStyle,
      isBox: true,
    }, this._ppm);
    boxEngine.gridCalculator = gc;

    // 자식 엔진 구축
    const children = boxData.children;
    if (!children) {
      boxEngine.childEngines = [];
      return boxEngine;
    }

    const childEngines: (BoxEngine | ImageEngine | ParagraphEngine | TableEngine)[] = [];

    if (Array.isArray(children)) {
      for (const childBoxData of children) {
        const childBE = this._buildBoxEngine(childBoxData, boxEngine);
        childEngines.push(childBE);
      }
    } else {
      const content = children;
      if (content.type === 'paragraph' || content.type === 'text') {
        const paraData: ParagraphData = content.type === 'text'
          ? { type: 'paragraph', content: content.content, paragraphStyle: content.paragraphStyle, textStyle: content.textStyle }
          : content;
        const pe = this._buildParagraphEngine(paraData, boxEngine, inheritStyle);
        childEngines.push(pe);
      } else if (content.type === 'image') {
        const ie = this._buildImageEngine(content, boxEngine);
        childEngines.push(ie);
      } else if (content.type === 'table') {
        const te = this._buildTableEngine(content, boxEngine);
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
    const gc = parentBox.gridCalculator!;
    const column = paraData.column ?? gc.columnWidth;
    const gap = paraData.gap ?? gc.gaps;

    const overlayEngines = parentBox.overlayElements;

    const engineData = {
      content: paraData.content,
      column,
      gap,
      paragraphStyle: { ...this._data.paragraphStyle, ...paraData.paragraphStyle },
      textStyle: { ...this._data.textStyle, ...paraData.textStyle },
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
      pe.layoutText();
      return pe;
    }

    const pe = ParagraphEngine.create(engineData);
    pe.layoutStructure();
    pe.layoutText();
    return pe;
  }

  /**
   * ImageData로부터 ImageEngine을 구축한다.
   * rgbaData는 이 시점에서 주입되지 않는다 — 외부에서 별도로 주입해야 한다.
   */
  private _buildImageEngine(imgData: ImageData, parentBox: BoxEngine): ImageEngine {
    const existing = parentBox.childEngines.find(e => e instanceof ImageEngine);
    if (existing) {
      const imgEngine = existing as ImageEngine;
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
      return imgEngine;
    }
    return ImageEngine.create({
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
  }

  private _buildTableEngine(tableData: TableData, parentBox: BoxEngine): TableEngine {
    const te = TableEngine.create(tableData, parentBox);
    te.layout();

    const rows = tableData.children ?? [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const cellEngines = te.rowEngines[r]?.cellEngines ?? [];
      for (let c = 0; c < cellEngines.length && c < row.children.length; c++) {
        const cellEngine = cellEngines[c];
        const cellData = row.children[c];
        const cellChildren = cellData?.children;
        if (!cellChildren || cellChildren.length === 0) continue;

        const cellBoxData = cellChildren.length === 1
          ? cellChildren[0]
          : { type: 'box' as const, left: 0, top: 0, width: 1, height: 1, children: cellChildren };
        const cellBoxEngine = this._buildBoxEngine(cellBoxData, cellEngine);
        cellEngine.boxEngine = cellBoxEngine;
      }
    }

    return te;
  }

  /**
   * 부모로부터 상속 스타일을 구성한다.
   */
  private _buildInheritStyle(
    _boxData: BoxData,
    parent: BoxEngine | DocumentEngine | TableCellEngine,
  ): InheritStyle {
    const gc = parent.gridCalculator;
    const padTop = 'paddingTop' in parent ? parent.paddingTop : 0;
    const padRight = 'paddingRight' in parent ? parent.paddingRight : 0;
    const padBottom = 'paddingBottom' in parent ? parent.paddingBottom : 0;
    const padLeft = 'paddingLeft' in parent ? parent.paddingLeft : 0;
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