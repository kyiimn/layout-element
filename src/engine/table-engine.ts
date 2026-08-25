/**
 * Node.js 호환 테이블 레이아웃 계산 엔진.
 *
 * 기존 `resolveTableGrid()` (이미 순수 함수)를 래핑하여
 * 엔진 트리 구조에 통합.
 *
 * @file src/engine/table-engine.ts
 */

import { resolveTableGrid, type GridResolution } from "./table-grid-resolver";
import { TableBorderStore } from "./border-store";
import type { TableData, TableRowData, TableCellData, BoxData, PrintPostData, PrintPostBorderEdge, PrintPostDiagonal } from "@/types";
import { BoxEngine } from "./box-engine";
import { GridCalculatorEngine } from "./grid-calculator-engine";
import { DocumentEngine } from "./document-engine";
import type { ParagraphEngine } from "./paragraph-engine";
import type { ImageEngine } from "./image-engine";
import type { AbsRect, ColorRegistryEngine } from "./types";
import { checkOverlapMm } from "./overlap-engine";

/**
 * 테이블 셀 레이아웃 엔진.
 * 각 셀의 배치 좌표(x, y, width, height)를 보유.
 * `BoxEngineParent` 인터페이스를 구현하여 자식 박스가 부모로 참조 가능.
 */
export class TableCellEngine {
  readonly isTableCellEngine = true;

  private _x: number = 0;
  private _y: number = 0;
  private _rowY: number = 0;
  private _width: number = 0;
  private _height: number = 0;
  private _cellLabel: string = '';
  private _labels: string[] = [];
  private _boxEngine: BoxEngine | null = null;
  private _parentAbsRect?: AbsRect;
  private _cellData?: TableCellData;
  _gridCalculator?: GridCalculatorEngine;
  /** @internal TableEngine에서 쓰기 접근. 패키지 외부에서는 사용 금지. */
  _tableEngine: TableEngine | null = null;

  /** Generation counter — incremented on setCellMetrics/parentAbsRect/boxEngine change. */
  private _generation: number = 0;

  /**
   * 셀 메트릭을 설정한다.
   * `TableEngine.layout()`에서 그리드 해석 후 각 셀에 주입.
   *
   * @param x - 셀 X 좌표 (mm, 테이블 내 상대)
   * @param y - 셀 Y 좌표 (mm, 테이블 내 상대)
   * @param width - 셀 너비 (mm)
   * @param height - 셀 높이 (mm)
   * @param cellLabel - 셀 라벨 (예: "A1")
   * @param labels - 셀이 커버하는 라벨 목록 (span 시 복수)
   * @param cellData - 원본 TableCellData (배경/대각선/보더 등 렌더 속성 접근용)
   */
  setCellMetrics(x: number, y: number, width: number, height: number, cellLabel: string, labels: string[], cellData?: TableCellData, rowY?: number): void {
    this._x = x;
    this._y = y;
    this._rowY = rowY ?? 0;
    this._width = width;
    this._height = height;
    this._cellLabel = cellLabel;
    this._labels = labels;
    this._cellData = cellData;
    this._generation++;
  }

  /** 셀 X (mm) */
  get x(): number { return this._x; }
  /** 셀 Y (mm) */
  get y(): number { return this._y; }
  /** 셀 너비 (mm) */
  get width(): number { return this._width; }
  /** 셀 높이 (mm) */
  get height(): number { return this._height; }
  /** 셀 라벨 */
  get cellLabel(): string { return this._cellLabel; }
  /** 셀 커버 라벨 목록 */
  get labels(): string[] { return this._labels; }
  /** 원본 셀 데이터 (배경/대각선/보더 등 렌더 속성). span된 셀은 undefined. */
  get cellData(): TableCellData | undefined { return this._cellData; }

  /** 셀 내용 박스 엔진 */
  get boxEngine(): BoxEngine | null { return this._boxEngine; }
  set boxEngine(engine: BoxEngine | null) {
    this._boxEngine = engine;
    this._generation++;
  }

  /**
   * 상위 테이블(또는 상위 박스)의 절대 사각형을 설정한다.
   * 셀 내부 박스 엔진이 누적된 페이지 절대 좌표를 계산할 수 있도록 한다.
   */
  set parentAbsRect(rect: AbsRect | undefined) {
    this._parentAbsRect = rect;
    this._generation++;
  }

  /** Generation counter (캐시 무효화 감지용) */
  get generation(): number {
    return this._generation;
  }

  /**
   * `BoxEngineParent` 인터페이스 구현.
   * 셀 내부 박스가 부모로 참조할 때 사용.
   */

  /** 절대 사각형 (mm) — parentAbsRect가 설정되면 페이지 절대 좌표, 아니면 테이블 상대 좌표 */
  get absRect(): { absLeft: number; absTop: number; absWidth: number; absHeight: number } {
    const dx = this._parentAbsRect?.absLeft ?? 0;
    const dy = this._parentAbsRect?.absTop ?? 0;
    return {
      absLeft: this._x + dx,
      absTop: this._rowY + this._y + dy,
      absWidth: this._width,
      absHeight: this._height,
    };
  }

  /** document 타입 여부 (항상 false) */
  get isDocument(): boolean {
    return false;
  }

  /** 셀 패딩은 항상 0 (셀 내부 박스가 자체 padding 처리) */
  get paddingTop(): number {
    return 0;
  }

  /** 그리드 계산기 (셀은 단일 컬럼 그리드) */
  get gridCalculator(): GridCalculatorEngine | null {
    return this._gridCalculator ?? null;
  }

  /** 오버랩 요소 목록 — 테이블 박스의 overlayElements 중 셀과 공간적으로 겹치는 것을 전파 */
  get overlayElements(): BoxEngine[] {
    if (!this._tableEngine) return [];
    const parentBox = this._tableEngine.parentBox;
    const cellRect = this.absRect;
    return parentBox.overlayElements.filter(e => checkOverlapMm(e.absRect, cellRect));
  }

  /** 자식 박스 엔진 목록 (셀 내부 박스, 0개 또는 1개) */
  get childBoxEngines(): BoxEngine[] {
    return this._boxEngine ? [this._boxEngine] : [];
  }

  findBoxEngineById(id: string): BoxEngine | undefined {
    return this._boxEngine?.data.id === id ? this._boxEngine : undefined;
  }

  /**
   * 셀 내부 박스에서 ID가 일치하는 엔진을 재귀적으로 검색한다.
   *
   * @param id - 검색할 엔진 ID
   * @returns 일치하는 엔진 또는 undefined
   */
  findEngineById(id: string): BoxEngine | ParagraphEngine | ImageEngine | TableEngine | undefined {
    return this._boxEngine?.findEngineById(id);
  }

  get extractData(): TableCellData {
    const children: BoxData[] = this._boxEngine ? [this._boxEngine.extractData] : [];
    const base = this._cellData ?? { type: 'td' as const, children: [] as BoxData[] };
    return {
      ...base,
      colspan: base.colspan ?? 1,
      rowspan: base.rowspan ?? 1,
      paddingTop: base.paddingTop ?? 0,
      paddingRight: base.paddingRight ?? 0,
      paddingBottom: base.paddingBottom ?? 0,
      paddingLeft: base.paddingLeft ?? 0,
      children,
    };
  }
}

/**
 * 테이블 행 레이아웃 엔진.
 * 행의 Y 위치와 높이를 보유.
 */
export class TableRowEngine {
  private _y: number = 0;
  private _height: number = 0;
  private _rowIndex: number = 0;
  private _rowLabel: string = '';
  private _id: string | undefined;
  private _cellEngines: TableCellEngine[] = [];

  /**
   * 행 메트릭을 설정한다.
   *
   * @param y - 행 Y 좌표 (mm, 테이블 내 상대)
   * @param height - 행 높이 (mm)
   * @param contentWidth - 콘텐츠 너비 (mm)
   * @param rowIndex - 행 인덱스
   * @param rowLabel - 행 라벨 (예: "A")
   * @param id - 행 ID
   */
  setRowMetrics(y: number, height: number, _contentWidth: number, rowIndex: number, rowLabel: string = '', id?: string): void {
    this._y = y;
    this._height = height;
    this._rowIndex = rowIndex;
    this._rowLabel = rowLabel;
    this._id = id;
  }

  /** 행 라벨 */
  get rowLabel(): string { return this._rowLabel; }

  /** 행 ID */
  get id(): string | undefined { return this._id; }

  /** 행 Y (mm) */
  get y(): number { return this._y; }
  /** 행 높이 (mm) */
  get height(): number { return this._height; }
  /** 행 인덱스 */
  get rowIndex(): number { return this._rowIndex; }

  /** 셀 엔진 목록 */
  get cellEngines(): TableCellEngine[] { return this._cellEngines; }
  set cellEngines(engines: TableCellEngine[]) { this._cellEngines = engines; }
}

/**
 * 테이블 그리드 해석과 셀 배치를 수행하는 엔진.
 *
 * 기존 `resolveTableGrid()` 순수 함수를 래핑하여 엔진 트리에 통합.
 * DOM 의존성 없음.
 *
 * @example
 * const tableEngine = TableEngine.create(
 *   { type: 'table', colWidths: [40, 30, 30], children: rows },
 *   parentBoxEngine,
 *   resources,
 * );
 * tableEngine.layout();
 * tableEngine.gridResolution;  // GridResolution
 */
export class TableEngine {
  private _data: TableData;
  private _parentBox: BoxEngine;
  private _gridResolution: GridResolution | null = null;
  private _rowEngines: TableRowEngine[] = [];
  private _borderStore: TableBorderStore | null = null;

  /**
   * 정적 팩토리 메서드.
   *
   * @param data - 테이블 데이터
   * @param parentBox - 부모 박스 엔진
   * @returns TableEngine 인스턴스
   */
  static create(data: TableData, parentBox: BoxEngine): TableEngine {
    return new this(data, parentBox);
  }

  private constructor(data: TableData, parentBox: BoxEngine) {
    this._data = data;
    this._parentBox = parentBox;
  }

  /** 테이블 데이터 설정 */
  set data(d: TableData) {
    this._data = d;
  }

  /** 현재 테이블 데이터 */
  get data(): TableData {
    return this._data;
  }

  /**
   * 엔진이 현재 관리 중인 상태에서 TableData를 추출한다.
   *
   * `children`은 행 엔진의 `extractData`에서 동적으로 조립한다.
   * `borders`는 `borderStore`의 현재 상태를 반환한다.
   *
   * @returns 엔진 현재 상태 기반의 TableData
   */
  get extractData(): TableData {
    const children: TableRowData[] = this._rowEngines.map((re) => {
      return {
        type: 'tr' as const,
        id: re.id,
        height: re.height,
        children: re.cellEngines.map(ce => ce.extractData),
      };
    });

    return {
      ...this._data,
      borders: this._borderStore?.toTableBorders() ?? this._data.borders,
      children,
    };
  }

  /** 그리드 해석 결과 */
  get gridResolution(): GridResolution | null {
    return this._gridResolution;
  }

  /** 행 엔진 목록 */
  get rowEngines(): TableRowEngine[] {
    return this._rowEngines;
  }

  /** 모든 셀 엔진을 평탄화하여 반환 */
  get cellEngines(): TableCellEngine[] {
    return this._rowEngines.flatMap(r => r.cellEngines);
  }

  /** 부모 박스 엔진 */
  get parentBox(): BoxEngine {
    return this._parentBox;
  }

  /** 보더 면 저장소 (단일 진실 소스) */
  get borderStore(): TableBorderStore | null {
    return this._borderStore;
  }

  /**
   * 문서 엔진에서 ColorRegistry를 조회한다.
   * 부모 박스 엔진 체인을 따라 DocumentEngine까지 올라간다.
   *
   * @returns ColorRegistryEngine 또는 null (문서 엔진 미연결 시)
   */
  private _getColorRegistry(): ColorRegistryEngine | null {
    let p = this._parentBox.parent;
    while (p instanceof BoxEngine) {
      p = p.parent;
    }
    if (p instanceof DocumentEngine) return p._colorRegistry;
    return null;
  }

  /**
   * 셀 라벨로 셀 엔진을 찾는다.
   *
   * @param label - 셀 라벨 (예: "A1")
   * @returns 일치하는 TableCellEngine 또는 undefined
   */
  findCellEngineByLabel(label: string): TableCellEngine | undefined {
    return this.cellEngines.find(e => e.cellLabel === label);
  }

  /**
   * 테이블 그리드를 해석하고 셀 배치를 계산한다.
   * `resolveTableGrid()`를 호출하고 결과를 행/셀 엔진에 분배.
   * 보더 면 저장소를 그리드 크기에 맞춰 구축한다.
   */
  layout(rowsData?: TableRowData[]): void {
    const parentAbsRect = this._parentBox.absRect;
    const contentWidth = parentAbsRect.absWidth - this._parentBox.paddingLeft - this._parentBox.paddingRight;
    const contentHeight = parentAbsRect.absHeight - this._parentBox.paddingTop - this._parentBox.paddingBottom;

    const rows = rowsData ?? [];
    this._gridResolution = resolveTableGrid(
      rows,
      contentWidth,
      contentHeight,
      this._data.colWidths,
    );

    const rowCount = this._gridResolution.rowCount;
    const colCount = this._gridResolution.colCount;
    this._borderStore = TableBorderStore.create(rowCount, colCount, this._data.borders);

    // 기존 셀 엔진의 boxEngine 참조를 보존하기 위한 맵.
    // layout()이 재호출될 때마다 새 TableCellEngine이 생성되므로,
    // cellLabel을 키로 기존 boxEngine을 새 셀 엔진에 복원한다.
    const prevBoxEngines = new Map<string, BoxEngine | null>();
    for (const oldCell of this.cellEngines) {
      prevBoxEngines.set(oldCell.cellLabel, oldCell.boxEngine);
    }

    // 행 엔진 구축
    this._rowEngines = rows.map(() => new TableRowEngine());

    // 각 행에 메트릭 주입
    for (let r = 0; r < rows.length && r < this._gridResolution.rowHeights.length; r++) {
      const rowHeight = this._gridResolution.rowHeights[r];
      const y = this._gridResolution.rowHeights.slice(0, r).reduce((sum, h) => sum + h, 0);
      const rowLabel = TableEngine._indexToRowLabel(r);
      this._rowEngines[r].setRowMetrics(y, rowHeight, contentWidth, r, rowLabel, rows[r].id);

      // 셀 엔진 구축
      const rowPlacements = this._gridResolution.placements.filter(p => p.gridRow === r);
      const cellEngines = rowPlacements.map((p) => {
        const cellEngine = new TableCellEngine();
        const trY = y;
        const cellData = p.cell;
        const cellLabel = TableEngine._buildCellLabel(rowLabel, p.gridCol);
        const labels = TableEngine._buildCellLabels(p);
        cellEngine.setCellMetrics(
          p.x,
          p.y - trY,
          p.width,
          p.height,
          cellLabel,
          labels,
          cellData,
          trY,
        );
        cellEngine.parentAbsRect = parentAbsRect;
        cellEngine._tableEngine = this;
        cellEngine._gridCalculator = GridCalculatorEngine.create({
          width: p.width,
          height: p.height,
          columns: 1,
          gap: 0,
          paddingTop: cellData?.paddingTop ?? 0,
          paddingRight: cellData?.paddingRight ?? 0,
          paddingBottom: cellData?.paddingBottom ?? 0,
          paddingLeft: cellData?.paddingLeft ?? 0,
          paragraphStyle: {},
          textStyle: {},
          isBox: true,
        });
        // 기존 boxEngine 참조 복원
        if (prevBoxEngines.has(cellLabel)) {
          cellEngine.boxEngine = prevBoxEngines.get(cellLabel) ?? null;
        }
        return cellEngine;
      });
      this._rowEngines[r].cellEngines = cellEngines;
    }
  }

  /**
   * 테이블의 printPostData를 생성한다 (mm 단위).
   *
   * DOM `table.element.ts` / `td.element.ts`의 printPostData와 동일한 구조:
   * 1. `table` 타입 항목 (borderEdges 포함)
   * 2. 각 셀별 `td` 타입 항목 (backgroundColor/backgroundOpacity/diagonals 포함)
   *    + 셀 내부 boxEngine의 printPostData
   *
   * @returns PrintPostData 배열 (mm 단위)
   */
  get printPostData(): PrintPostData[] {
    const data: PrintPostData[] = [];
    const colorRegistry = this._getColorRegistry();
    const parentAbsRect = this._parentBox.absRect;

    // 1. table 항목 + borderEdges
    const borderEdges: PrintPostBorderEdge[] = [];
    if (this._gridResolution && this._borderStore) {
      const segments = this._borderStore.toSegments(
        this._gridResolution.rowHeights,
        this._gridResolution.colWidths,
      );
      for (const seg of segments) {
        borderEdges.push({
          direction: seg.direction,
          x: parentAbsRect.absLeft + seg.x,
          y: parentAbsRect.absTop + seg.y,
          length: seg.length,
          width: seg.width,
          color: colorRegistry ? colorRegistry.get(seg.color) : { c: 0, m: 0, y: 0, k: 255 },
          style: seg.style,
          lineIndex: seg.lineIndex,
        });
      }
    }

    data.push({
      data: this._data,
      rect: {
        x: parentAbsRect.absLeft,
        y: parentAbsRect.absTop,
        width: parentAbsRect.absWidth,
        height: parentAbsRect.absHeight,
      },
      borderEdges: borderEdges.length > 0 ? borderEdges : undefined,
      tableRowCount: this._gridResolution?.rowCount,
      tableColCount: this._gridResolution?.colCount,
    });

    // 2. 각 셀별 td 항목 + 내부 box printPostData
    for (const rowEngine of this._rowEngines) {
      for (const cellEngine of rowEngine.cellEngines) {
        const cellData = cellEngine.cellData;
        const cellAbsRect = cellEngine.absRect;

        const diagonals: PrintPostDiagonal[] = [];
        if (cellData?.diagonals && cellData.diagonals.length > 0) {
          const diagColor = colorRegistry
            ? colorRegistry.get(cellData.diagonalColor ?? 'black')
            : { c: 0, m: 0, y: 0, k: 255 };
          const diagWidth = cellData.diagonalWidth ?? 0.1;

          // 대각선 끝점을 보더 안쪽 가장자리로 보정한다 (EDITING_TABLE.md 9.4 정렬 규칙).
          // 셀 경계(absLeft/absTop/absRight/absBottom)에서 보더 두께만큼 안쪽으로 당긴다.
          // 외곽 면은 전체 두께, 내부 면은 절반만큼 당긴다.
          const grid = this._gridResolution;
          const store = this._borderStore;
          const placement = grid?.placements.find(p => p.x === cellEngine.x && p.y === cellEngine.y);
          const gr = placement?.gridRow ?? 0;
          const gc = placement?.gridCol ?? 0;
          const spanR = placement?.spanRows ?? 1;
          const spanC = placement?.spanCols ?? 1;
          const rowCount = grid?.rowCount ?? 0;
          const colCount = grid?.colCount ?? 0;

          const maxHWidth = (line: number, fromCol: number, toCol: number): number => {
            if (!store) return 0;
            let max = 0;
            for (let c = fromCol; c <= toCol; c++) {
              const w = store.getHFace(line, c).width;
              if (w > max) max = w;
            }
            return max;
          };
          const maxVWidth = (fromRow: number, toRow: number, line: number): number => {
            if (!store) return 0;
            let max = 0;
            for (let r = fromRow; r <= toRow; r++) {
              const w = store.getVFace(r, line).width;
              if (w > max) max = w;
            }
            return max;
          };

          // 상단: line=gr. 외곽(gr===0)이면 전체 두께, 내부면 절반.
          const topW = maxHWidth(gr, gc, gc + spanC - 1);
          const topInset = gr === 0 ? topW : topW / 2;
          // 하단: line=gr+spanR. 외곽(gr+spanR===rowCount)이면 전체, 내부면 절반.
          const bottomW = maxHWidth(gr + spanR, gc, gc + spanC - 1);
          const bottomInset = gr + spanR === rowCount ? bottomW : bottomW / 2;
          // 좌측: line=gc. 외곽(gc===0)이면 전체, 내부면 절반.
          const leftW = maxVWidth(gr, gr + spanR - 1, gc);
          const leftInset = gc === 0 ? leftW : leftW / 2;
          // 우측: line=gc+spanC. 외곽(gc+spanC===colCount)이면 전체, 내부면 절반.
          const rightW = maxVWidth(gr, gr + spanR - 1, gc + spanC);
          const rightInset = gc + spanC === colCount ? rightW : rightW / 2;

          const x1 = cellAbsRect.absLeft + leftInset;
          const y1 = cellAbsRect.absTop + topInset;
          const x2 = cellAbsRect.absLeft + cellAbsRect.absWidth - rightInset;
          const y2 = cellAbsRect.absTop + cellAbsRect.absHeight - bottomInset;
          for (const dir of cellData.diagonals) {
            if (dir === 'tl-br') {
              diagonals.push({ direction: 'tl-br', x1, y1, x2, y2, width: diagWidth, color: diagColor });
            } else {
              diagonals.push({ direction: 'tr-bl', x1: x2, y1, x2: x1, y2, width: diagWidth, color: diagColor });
            }
          }
        }

        data.push({
          backgroundColor: cellData?.backgroundColor && colorRegistry
            ? colorRegistry.get(cellData.backgroundColor)
            : undefined,
          backgroundOpacity: cellData?.backgroundOpacity,
          data: cellData ?? { type: 'td', children: [] },
          rect: {
            x: cellAbsRect.absLeft,
            y: cellAbsRect.absTop,
            width: cellAbsRect.absWidth,
            height: cellAbsRect.absHeight,
          },
          diagonals: diagonals.length > 0 ? diagonals : undefined,
        });

        const boxEngine = cellEngine.boxEngine;
        if (boxEngine) {
          data.push(...boxEngine.printPostData);
        }
      }
    }

    return data;
  }

  /**
   * 행 인덱스를 행 라벨로 변환한다 (0 → "A", 1 → "B", ...).
   *
   * @param index - 행 인덱스
   * @returns 행 라벨 문자열
   */
  private static _indexToRowLabel(index: number): string {
    let label = '';
    let n = index;
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  }

  /**
   * 셀 라벨을 생성한다 (예: "A1").
   *
   * @param rowLabel - 행 라벨
   * @param gridCol - 그리드 열 인덱스
   * @returns 셀 라벨 문자열
   */
  private static _buildCellLabel(rowLabel: string, gridCol: number): string {
    return `${rowLabel}${gridCol + 1}`;
  }

  /**
   * 셀이 커버하는 모든 라벨 목록을 생성한다.
   *
   * @param placement - 셀 배치 정보
   * @returns 커버하는 라벨 문자열 배열
   */
  private static _buildCellLabels(placement: GridResolution['placements'][number]): string[] {
    const labels: string[] = [];
    for (let dr = 0; dr < placement.spanRows; dr++) {
      const subRowLabel = TableEngine._indexToRowLabel(placement.gridRow + dr);
      for (let dc = 0; dc < placement.spanCols; dc++) {
        labels.push(`${subRowLabel}${placement.gridCol + dc + 1}`);
      }
    }
    return labels;
  }
}
