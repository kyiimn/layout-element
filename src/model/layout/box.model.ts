import { DEFAULT_FONT_SIZE, DEFAULT_LINE_GAP } from "@/define";
import { DocumentData, ParagraphStyle, TextStyle } from "@/types";

/**
 * 컬럼의 좌표 영역을 나타내는 사각형.
 * `BoxModel`이 컬럼 그리드를 계산할 때 각 컬럼의 경계를 이 타입으로 표현한다.
 */
export type Rect = {
  /** 좌측 경계 (mm) */
  x1: number;

  /** 상단 경계 (mm) */
  y1: number;

  /** 우측 경계 (mm) */
  x2: number;

  /** 하단 경계 (mm) */
  y2: number;
};

type BoxModelOptions = {
  width: number;
  height: number;
  paddingTop?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  paddingRight?: number;
  columns: number | number[];
  gap: number | number[];
  paragraphStyle: ParagraphStyle;
  textStyle: TextStyle;
}

/**
 * 문서 레이아웃의 컬럼 그리드와 스타일을 계산하는 모델.
 *
 * `DocumentData`를 받아 컬럼 좌표(`Rect[]`), 행 높이, 편집 가능 영역 등을 계산한다.
 * 정적 팩토리 메서드 `create()`로만 인스턴스를 생성한다.
 *
 * 주요 기능:
 * - `columns`/`gap` 설정에 따른 컬럼 그리드 좌표 계산
 * - DPI 측정을 통한 픽셀/mm 변환 비율(`ppm`) 계산
 * - 행 높이(`lineHeight = fontSize × lineGap`) 계산
 *
 * @example
 * const model = BoxModel.create(documentData);
 * console.log(model.columnCoords);  // Rect[] - 각 컬럼의 좌표
 * console.log(model.lineHeight);    // number - 행 높이 (mm)
 * console.log(model.editableWidth); // number - 편집 가능 너비 (mm)
 */
export class BoxModel {
  private static _ppm: number | undefined;

  private _columnCoords: Rect[];
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

  /**
   * 정적 팩토리 메서드. `new` 직접 사용 금지.
   * @param data 문서 데이터
   */
  static create(data: BoxModelOptions) {
    return new this(data);
  }

  private constructor(data: BoxModelOptions) {
    this._columnCoords = [];
    this._columnWidths = [];
    this._gaps = [];
    this._lineHeight = 0;

    this.data = data;
  }

  /**
   * 브라우저 DPI를 측정하여 픽셀/mm 변환 비율 계산.
   * 임시 100mm `<div>`를 DOM에 삽입 후 `offsetWidth`를 측정한다.
   */
  static get ppm() {
    if (!this._ppm) {
      const div = document.createElement('div');
      div.style.width = '100mm';
      div.style.height = '1px';
      div.style.position = 'absolute';
      div.style.top = '-10000px';
      div.style.left = '-10000px';
      div.style.visibility = 'hidden';

      document.body.appendChild(div);

      const pxWidth100mm = div.getBoundingClientRect().width;
      document.body.removeChild(div);

      this._ppm = pxWidth100mm / 100;
    }
    return this._ppm;
  }

  /** 컬럼 좌표 및 행 높이 계산 */
  private _calcCoordUnit() {
    this._lineHeight = this.fontSize * this.lineGap;

    const paddingTop = this._paddingTop || 0;
    const paddingRight = this._paddingRight || 0;
    const paddingBottom = this._paddingBottom || 0;
    const paddingLeft = this._paddingLeft || 0;

    this._columnCoords = [];
    this._columnWidths = [];

    if (typeof this._inputColumns === 'number') {
      const gaps = typeof this._inputGap === 'number' ? Array.from({ length: this._inputColumns - 1 }).map(() => this._inputGap as number) : this._inputGap;
      const editableWidth = this._width - paddingLeft - paddingRight - gaps.reduce((a, b) => a + b, 0);
      const editableHeight = Math.floor((this._height - paddingTop - paddingBottom) / this._lineHeight) * this._lineHeight;
      const columnWidth = editableWidth / this._inputColumns;

      for (let i = 0; i < this._inputColumns; i++) {
        const x1 = this._columnCoords.length > 0 ? this._columnCoords[this._columnCoords.length - 1].x2 + (gaps[i - 1] || 0) : paddingLeft;
        const y1 = paddingTop;
        const x2 = x1 + columnWidth;
        const y2 = paddingTop + editableHeight;

        this._columnCoords.push({ x1, y1, x2, y2 });
        this._columnWidths.push(columnWidth);
        if (i > 0) this._gaps.push(gaps[i - 1]);
      }
    } else {
      const gaps = typeof this._inputGap === 'number' ? Array.from({ length: this._inputColumns.length - 1 }).map(() => this._inputGap as number) : this._inputGap;
      const editableHeight = this._height - paddingTop - paddingBottom;

      this._columnWidths = [...this._inputColumns];
      this._gaps = [...gaps];

      this._columnWidths[0] = this._columnWidths[0] - paddingLeft;
      this._columnWidths[this._columnWidths.length - 1] = this._columnWidths[this._columnWidths.length - 1] - paddingRight;

      for (let i = 0; i < this._columnWidths.length; i++) {
        const x1 = i > 0 ? this._columnCoords[this._columnCoords.length - 1].x2 + (gaps[i - 1] || 0) : paddingLeft;
        const y1 = paddingTop;
        const x2 = x1 + this._columnWidths[i];
        const y2 = paddingTop + editableHeight;

        this._columnCoords.push({ x1, y1, x2, y2 });
      }
    }
  }

  set data(data: BoxModelOptions) {
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

    this._calcCoordUnit();
  }

  set width(value: number) {
    if (this._width === value) return;
    this._width = value;
    this._calcCoordUnit();
  }

  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this._calcCoordUnit();
  }

  set paddingTop(value: number) {
    if (this._paddingTop === value) return;
    this._paddingTop = value;
    this._calcCoordUnit();
  }

  set paddingBottom(value: number) {
    if (this._paddingBottom === value) return;
    this._paddingBottom = value;
    this._calcCoordUnit();
  }

  set paddingLeft(value: number) {
    if (this._paddingLeft === value) return;
    this._paddingLeft = value;
    this._calcCoordUnit();
  }

  set paddingRight(value: number) {
    if (this._paddingRight === value) return;
    this._paddingRight = value;
    this._calcCoordUnit();
  }

  set columns(value: number | number[]) {
    if (this._inputColumns === value) return;
    this._inputColumns = value;
    this._calcCoordUnit();
  }

  set gap(value: number | number[]) {
    if (this._inputGap === value) return;
    this._inputGap = value;
    this._calcCoordUnit();
  }
  get width() { return this._width; }
  get height() { return this._height; }
  get paddingTop() { return this._paddingTop; }
  get paddingBottom() { return this._paddingBottom; }
  get paddingLeft() { return this._paddingLeft; }
  get paddingRight() { return this._paddingRight; }
  get textStyle() { return this._textStyle; }
  get paragraphStyle() { return this._paragraphStyle; }

  get columnCount() { return this._columnWidths.length; }
  get columnCoords() { return this._columnCoords; }
  get columnWidth() { return this._columnWidths; }
  get gaps() { return this._gaps; }
  get lineHeight() { return this._lineHeight; }

  get editableWidth() {
    return this._columnCoords.length > 0 ? (this._columnCoords[this._columnCoords.length - 1].x2 - this._columnCoords[0].x1) : 0;
  }

  get editableHeight() {
    return this._columnCoords.length > 0 ? (this._columnCoords[0].y2 - this._columnCoords[0].y1) : 0;
  }

  get editableTextHeight() {
    return this.editableHeight + (this.lineHeight - this.fontSize);
  }

  get fontSize() {
    return this.textStyle.fontSize || DEFAULT_FONT_SIZE;
  }

  get lineGap() {
    return this.paragraphStyle.lineGap || DEFAULT_LINE_GAP;
  }
}