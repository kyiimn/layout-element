/**
 * Node.js 호환 테이블 레이아웃 계산 엔진.
 *
 * 기존 `resolveTableGrid()` (이미 순수 함수)를 래핑하여
 * 엔진 트리 구조에 통합.
 *
 * @file src/engine/table-engine.ts
 */

import { resolveTableGrid, type GridResolution } from "@/core/table-grid-resolver";
import type { TableData } from "@/types";
import type { BoxEngine } from "./box-engine";
import type { GridCalculatorEngine } from "./grid-calculator-engine";

/**
 * 테이블 셀 레이아웃 엔진.
 * 각 셀의 배치 좌표(x, y, width, height)를 보유.
 * `BoxEngineParent` 인터페이스를 구현하여 자식 박스가 부모로 참조 가능.
 */
export class TableCellEngine {
  private _x: number = 0;
  private _y: number = 0;
  private _width: number = 0;
  private _height: number = 0;
  private _cellLabel: string = '';
  private _labels: string[] = [];
  private _boxEngine: BoxEngine | null = null;

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
   */
  setCellMetrics(x: number, y: number, width: number, height: number, cellLabel: string, labels: string[]): void {
    this._x = x;
    this._y = y;
    this._width = width;
    this._height = height;
    this._cellLabel = cellLabel;
    this._labels = labels;
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

  /** 셀 내용 박스 엔진 */
  get boxEngine(): BoxEngine | null { return this._boxEngine; }
  set boxEngine(engine: BoxEngine | null) { this._boxEngine = engine; }

  /**
   * `BoxEngineParent` 인터페이스 구현.
   * 셀 내부 박스가 부모로 참조할 때 사용.
   */

  /** 절대 사각형 (mm) — 셀의 x, y, width, height를 절대 좌표로 변환 */
  get absRect(): { absLeft: number; absTop: number; absWidth: number; absHeight: number } {
    return {
      absLeft: this._x,
      absTop: this._y,
      absWidth: this._width,
      absHeight: this._height,
    };
  }

  /** document 타입 여부 (항상 false) */
  get isDocument(): boolean {
    return false;
  }

  /** 그리드 계산기 (셀은 자체 그리드 없음, null 반환) */
  get gridCalculator(): GridCalculatorEngine | null {
    return null;
  }

  /** 오버랩 요소 목록 (셀 자체는 오버랩 대상 아님, 빈 배열) */
  get overlayElements(): BoxEngine[] {
    return [];
  }

  /** 자식 박스 엔진 목록 (셀 내부 박스, 0개 또는 1개) */
  get childBoxEngines(): BoxEngine[] {
    return this._boxEngine ? [this._boxEngine] : [];
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
  private _cellEngines: TableCellEngine[] = [];

  /**
   * 행 메트릭을 설정한다.
   *
   * @param y - 행 Y 좌표 (mm, 테이블 내 상대)
   * @param height - 행 높이 (mm)
   * @param contentWidth - 콘텐츠 너비 (mm)
   * @param rowIndex - 행 인덱스
   */
  setRowMetrics(y: number, height: number, _contentWidth: number, rowIndex: number): void {
    this._y = y;
    this._height = height;
    this._rowIndex = rowIndex;
  }

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

  /**
   * 테이블 그리드를 해석하고 셀 배치를 계산한다.
   * `resolveTableGrid()`를 호출하고 결과를 행/셀 엔진에 분배.
   */
  layout(): void {
    const parentAbsRect = this._parentBox.absRect;
    const contentWidth = parentAbsRect.absWidth - this._parentBox.paddingLeft - this._parentBox.paddingRight;
    const contentHeight = parentAbsRect.absHeight - this._parentBox.paddingTop - this._parentBox.paddingBottom;

    const rows = this._data.children ?? [];
    this._gridResolution = resolveTableGrid(
      rows,
      contentWidth,
      contentHeight,
      this._data.colWidths,
    );

    // 행 엔진 구축
    this._rowEngines = rows.map(() => new TableRowEngine());

    // 각 행에 메트릭 주입
    for (let r = 0; r < rows.length && r < this._gridResolution.rowHeights.length; r++) {
      const rowHeight = this._gridResolution.rowHeights[r];
      const y = this._gridResolution.rowHeights.slice(0, r).reduce((sum, h) => sum + h, 0);
      this._rowEngines[r].setRowMetrics(y, rowHeight, contentWidth, r);

      // 셀 엔진 구축
      const rowPlacements = this._gridResolution.placements.filter(p => p.gridRow === r);
      const cellEngines = rowPlacements.map(p => {
        const cellEngine = new TableCellEngine();
        const trY = y;
        cellEngine.setCellMetrics(
          p.x,
          p.y - trY,
          p.width,
          p.height,
          '',  // cellLabel — 엘리먼트에서 설정
          [],  // labels — 엘리먼트에서 설정
        );
        return cellEngine;
      });
      this._rowEngines[r].cellEngines = cellEngines;
    }
  }
}