/**
 * Node.js 호환 컬럼 그리드 계산 엔진.
 *
 * 기존 `GridCalculator`에서 DOM 의존성을 제거한 순수 계산 버전.
 * - `ppm`을 정적 측정이 아닌 생성자 파라미터로 주입받음 (Locked Decision 1)
 * - `element: LayoutBoxElement` 참조 대신 `isBox: boolean` 사용
 * - `document.createElement` / `getBoundingClientRect` 사용 안 함
 *
 * 모든 좌표는 mm 단위이며, ppm은 픽셀 변환이 필요한 호출자가 사용.
 *
 * @file src/engine/grid-calculator-engine.ts
 */

import { DEFAULT_FONT_SIZE, DEFAULT_LINE_GAP } from "@/constants";
import type { ParagraphStyle, TextStyle } from "@/types";
import type { GridRect, GridCalculatorEngineOptions } from "./types";

/**
 * 컬럼 그리드 좌표와 행 높이를 계산하는 순수 엔진.
 *
 * 인스턴스는 `GridCalculatorEngine.create(options, ppm)` 팩토리로만 생성.
 * 생성자가 `private`이므로 `new` 직접 사용 불가.
 *
 * @example
 * const engine = GridCalculatorEngine.create(
 *   {
 *     width: 257, height: 370,
 *     columns: 6, gap: 3,
 *     paragraphStyle: { lineGap: 1.2 },
 *     textStyle: { fontSize: 4 },
 *     isBox: false,
 *   },
 *   3.78,
 * );
 * engine.columnCoords;  // GridRect[]
 * engine.lineHeight;    // 4.8 (4 × 1.2)
 * engine.editableWidth; // mm
 */
export class GridCalculatorEngine {
  private _ppm: number;

  private _columnCoords: GridRect[];
  private _columnWidths: number[];
  private _gaps: number[];
  private _lineHeight: number;

  private _width: number = 0;
  private _height: number = 0;
  private _paddingTop: number = 0;
  private _paddingBottom: number = 0;
  private _paddingLeft: number = 0;
  private _paddingRight: number = 0;
  private _inputColumns: number | number[] = 1;
  private _inputGap: number | number[] = 0;
  private _paragraphStyle: ParagraphStyle = {};
  private _textStyle: TextStyle = {};
  private _isBox: boolean = false;

  /**
   * 정적 팩토리 메서드. `new` 직접 사용 금지.
   *
   * @param data - 그리드 계산 옵션 (DOM 참조 없음)
   * @param ppm - pixels-per-mm. 옵셔널 (엔진 연산에는 사용되지 않음, 브라우저 호환용).
   * @returns GridCalculatorEngine 인스턴스
   */
  static create(data: GridCalculatorEngineOptions, ppm?: number): GridCalculatorEngine {
    return new this(data, ppm);
  }

  private constructor(data: GridCalculatorEngineOptions, ppm?: number) {
    this._ppm = ppm ?? 0;
    this._columnCoords = [];
    this._columnWidths = [];
    this._gaps = [];
    this._lineHeight = 0;
    this.data = data;
  }

  /**
   * 컬럼 그리드 좌표(`GridRect[]`)와 행 높이를 계산한다.
   * `padding`, `columns`, `gap` 설정에 따라 각 컬럼의 경계 사각형과 너비를 결정한다.
   *
   * 기존 `GridCalculator._calcColumnGridCoords()`와 동일한 알고리즘이며,
   * `instanceof LayoutBoxElement` 체크를 `this._isBox` 불리언으로 대체.
   */
  private _calcColumnGridCoords(): void {
    this._lineHeight = this.fontSize * this.lineGap;

    const paddingTop = this._paddingTop || 0;
    const paddingRight = this._paddingRight || 0;
    const paddingBottom = this._paddingBottom || 0;
    const paddingLeft = this._paddingLeft || 0;

    this._columnCoords = [];
    this._columnWidths = [];

    if (typeof this._inputColumns === 'number') {
      const gaps = typeof this._inputGap === 'number'
        ? Array.from({ length: this._inputColumns - 1 }).map(() => this._inputGap as number)
        : this._inputGap;
      const editableWidth = this._width - paddingLeft - paddingRight - gaps.reduce((a, b) => a + b, 0);
      const editableHeight = Math.floor((this._height - paddingTop - paddingBottom) / this._lineHeight) * this._lineHeight;
      const columnWidth = editableWidth / this._inputColumns;

      for (let i = 0; i < this._inputColumns; i++) {
        const x1 = this._columnCoords.length > 0
          ? this._columnCoords[this._columnCoords.length - 1].x2 + (gaps[i - 1] || 0)
          : paddingLeft;
        const y1 = paddingTop;
        const x2 = x1 + columnWidth;
        const y2 = paddingTop + editableHeight;

        this._columnCoords.push({ x1, y1, x2, y2 });
        this._columnWidths.push(columnWidth);
        if (i > 0) this._gaps.push(gaps[i - 1]);
      }
    } else {
      const gaps = typeof this._inputGap === 'number'
        ? Array.from({ length: this._inputColumns.length - 1 }).map(() => this._inputGap as number)
        : this._inputGap;
      const editableHeight = this._height - paddingTop - paddingBottom;

      this._columnWidths = [...this._inputColumns];
      this._gaps = [...gaps];

      if (this._isBox) {
        this._columnWidths[0] -= paddingLeft;
        this._columnWidths[this._columnWidths.length - 1] -= paddingRight;
      }

      for (let i = 0; i < this._columnWidths.length; i++) {
        const x1 = i > 0
          ? this._columnCoords[this._columnCoords.length - 1].x2 + (gaps[i - 1] || 0)
          : paddingLeft;
        const y1 = paddingTop;
        const x2 = x1 + this._columnWidths[i];
        const y2 = paddingTop + editableHeight;

        this._columnCoords.push({ x1, y1, x2, y2 });
      }
    }
  }

  /**
   * 그리드 계산 데이터를 설정하고 컬럼 좌표를 재계산한다.
   *
   * @param data - 그리드 옵션. `isBox`는 박스 컨테이너 여부 (첫/마지막 컬럼 패딩 차감용).
   */
  set data(data: GridCalculatorEngineOptions) {
    this._width = data.width;
    this._height = data.height;
    this._paddingTop = data.paddingTop || 0;
    this._paddingBottom = data.paddingBottom || 0;
    this._paddingLeft = data.paddingLeft || 0;
    this._paddingRight = data.paddingRight || 0;
    this._inputColumns = data.columns;
    this._inputGap = data.gap;
    this._paragraphStyle = data.paragraphStyle;
    this._textStyle = data.textStyle;
    this._isBox = data.isBox;

    this._calcColumnGridCoords();
  }

  /** pixels-per-mm 값 (엔진 연산에 사용되지 않음, 브라우저 호환용) */
  get ppm(): number { return this._ppm; }
  set ppm(v: number) {
    this._ppm = v;
  }

  get textStyle(): TextStyle { return this._textStyle; }
  get paragraphStyle(): ParagraphStyle { return this._paragraphStyle; }

  get columnCount(): number { return this._columnWidths.length; }
  get columnCoords(): GridRect[] { return this._columnCoords; }
  get columnWidth(): number[] { return this._columnWidths; }
  get gaps(): number[] { return this._gaps; }
  get lineHeight(): number { return this._lineHeight; }

  get editableWidth(): number {
    return this._columnCoords.length > 0
      ? (this._columnCoords[this._columnCoords.length - 1].x2 - this._columnCoords[0].x1)
      : 0;
  }

  get editableHeight(): number {
    return this._columnCoords.length > 0
      ? (this._columnCoords[0].y2 - this._columnCoords[0].y1)
      : 0;
  }

  /**
   * 텍스트가 배치될 수 있는 실제 높이 (mm).
   * lineHeight - fontSize 오차가 하위 overflow 판정으로 전파되는 것을 방지하기 위해 1e-6 반올림.
   */
  get editableTextHeight(): number {
    const raw = this.editableHeight + (this.lineHeight - this.fontSize);
    return Math.round(raw * 1e6) / 1e6;
  }

  /**
   * 부모 컨테이너의 실제 콘텐츠 영역 높이 (mm).
   * `editableHeight`가 lineHeight 정수배로 버림된 값인 반면,
   * `contentHeight`는 버림 없는 실제 하단이다.
   * absolute box 클램핑 시 사용.
   */
  get contentHeight(): number {
    return this._height - (this._paddingTop || 0) - (this._paddingBottom || 0);
  }

  get fontSize(): number {
    return this.textStyle.fontSize ?? DEFAULT_FONT_SIZE;
  }

  get lineGap(): number {
    return this.paragraphStyle.lineGap ?? DEFAULT_LINE_GAP;
  }
}