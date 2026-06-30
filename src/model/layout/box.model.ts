import { DEFAULT_FONT_SIZE, DEFAULT_LINE_GAP, DEFAULT_PPM } from "@/define";
import { DocumentData, ParagraphStyle, TextStyle } from "@/types";

/**
 * 브라우저 DPI를 측정하여 픽셀/mm 변환 비율 계산.
 * 임시 100mm `<div>`를 DOM에 삽입 후 `offsetWidth`를 측정한다.
 */
const _calcPxPerMM = () => {
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

  return pxWidth100mm / 100;
}

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

export type BoxModelCreateParams = {
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;

  columns?: number | number[];
  gap?: number | number[];

  width: number;
  height: number;

  paragraphStyle: ParagraphStyle;
  textStyle: TextStyle;
}

export class BoxModel {
  private _columnCoords: Rect[];
  private _columnWidths: number[];
  private _gaps: number[];
  private _lineHeight: number;
  private _ppm: number;

  private _paddingTop: number = 0;
  private _paddingRight: number = 0;
  private _paddingBottom: number = 0;
  private _paddingLeft: number = 0;

  private _columns: number | number[] = 1;
  private _gap: number | number[] = 0;

  private _width: number = 0;
  private _height: number = 0;

  private _paragraphStyle: ParagraphStyle = {};
  private _textStyle: TextStyle = {};

  /**
   * 정적 팩토리 메서드. `new` 직접 사용 금지.
   * @param data 문서 데이터
   */
  public static create(params: BoxModelCreateParams) {
    return new this(params);
  }

  private constructor(params: BoxModelCreateParams) {
    this._columnCoords = [];
    this._columnWidths = [];
    this._gaps = [];
    this._lineHeight = 0;
    this._ppm = DEFAULT_PPM;
    this._ppm = _calcPxPerMM();

    this.data = params;
  }

  /** 컬럼 좌표 및 행 높이 계산 */
  private _calcCoordUnit() {
    this._lineHeight = this.fontSize * this.lineGap;

    this._columnCoords = [];
    this._columnWidths = [];

    if (typeof this._columns === 'number') {
      const gaps = typeof this._gap === 'number' ? Array.from({ length: this._columns - 1 }).map(() => this._gap as number) : this._gap;
      const editableWidth = this._width - this.paddingLeft - this.paddingRight - gaps.reduce((a, b) => a + b, 0);
      const editableHeight = Math.floor((this._height - this.paddingTop - this.paddingBottom) / this.lineHeight) * this.lineHeight;
      const columnWidth = editableWidth / this._columns;

      for (let i = 0; i < this._columns; i++) {
        const x1 = this._columnCoords.length > 0 ? this._columnCoords[this._columnCoords.length - 1].x2 + (gaps[i - 1] || 0) : this.paddingLeft;
        const y1 = this.paddingTop;
        const x2 = x1 + columnWidth;
        const y2 = this.paddingTop + editableHeight;

        this._columnCoords.push({ x1, y1, x2, y2 });
        this._columnWidths.push(columnWidth);
        if (i > 0) this._gaps.push(gaps[i - 1]);
      }
    } else {
      const gaps = typeof this._gap === 'number' ? Array.from({ length: this._columns.length - 1 }).map(() => this._gap as number) : this._gap;
      const editableHeight = this.height - this.paddingTop - this.paddingBottom;

      this._columnWidths = [...this._columns];
      this._gaps = [...gaps];

      this._columnWidths[0] = this._columnWidths[0] - this.paddingLeft;
      this._columnWidths[this._columnWidths.length - 1] = this._columnWidths[this._columnWidths.length - 1] - this.paddingRight;

      for (let i = 0; i < this._columnWidths.length; i++) {
        const x1 = i > 0 ? this._columnCoords[this._columnCoords.length - 1].x2 + (gaps[i - 1] || 0) : this.paddingLeft;
        const y1 = this.paddingTop;
        const x2 = x1 + this._columnWidths[i];
        const y2 = this.paddingTop + editableHeight;

        this._columnCoords.push({ x1, y1, x2, y2 });
      }
    }
  }

  set data(params: BoxModelCreateParams) {
    if (params.paddingTop) this._paddingTop = params.paddingTop;
    if (params.paddingRight) this._paddingRight = params.paddingRight;
    if (params.paddingBottom) this._paddingBottom = params.paddingBottom;
    if (params.paddingLeft) this._paddingLeft = params.paddingLeft;

    if (params.columns) this._columns = params.columns;
    if (params.gap) this._gap = params.gap;

    this._width = params.width;
    this._height = params.height;

    this._paragraphStyle = { ...params.paragraphStyle };
    this._textStyle = { ...params.textStyle };

    this._calcCoordUnit();
  }

  set paddingTop(value: number) {
    if (this._paddingTop === value) return;
    this._paddingTop = value;
    this._calcCoordUnit();
  }

  /** 상단 여백 (mm) */
  get paddingTop() {
    return this._paddingTop;
  }

  set paddingRight(value: number) {
    if (this._paddingRight === value) return;
    this._paddingRight = value;
    this._calcCoordUnit();
  }

  /** 우측 여백 (mm) */
  get paddingRight() {
    return this._paddingRight;
  }

  set paddingBottom(value: number) {
    if (this._paddingBottom === value) return;
    this._paddingBottom = value;
    this._calcCoordUnit();
  }

  /** 하단 여백 (mm) */
  get paddingBottom() {
    return this._paddingBottom;
  }

  set paddingLeft(value: number) {
    if (this._paddingLeft === value) return;
    this._paddingLeft = value;
    this._calcCoordUnit();
  }

  /** 좌측 여백 (mm) */
  get paddingLeft() {
    return this._paddingLeft;
  }

  set width(value: number) {
    if (this._width === value) return;
    this._width = value;
    this._calcCoordUnit();
  }

  /** 문서 너비 (mm) */
  get width() {
    return this._width;
  }

  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this._calcCoordUnit();
  }

  /** 문서 높이 (mm) */
  get height() {
    return this._height;
  }

  set textStyle(value: TextStyle) {
    if (this._textStyle === value) return;
    this._textStyle = { ...value };
    this._calcCoordUnit();
  }

  /** 문서의 텍스트 스타일 */
  get textStyle() {
    return this._textStyle;
  }

  set paragraphStyle(value: ParagraphStyle) {
    if (this._paragraphStyle === value) return;
    this._paragraphStyle = { ...value };
    this._calcCoordUnit();
  }

  /** 문서의 문단 스타일 */
  get paragraphStyle() {
    return this._paragraphStyle;
  }

  set columns(value: number | number[]) {
    if (this._columns === value) return;
    this._columns = value;
    this._calcCoordUnit();
  }

  set gap(value: number | number[]) {
    if (this._gap === value) return;
    this._gap = value;
    this._calcCoordUnit();
  }

  /** 컬럼 개수 */
  get columnCount() {
    return this._columnWidths.length;
  }

  /** 각 컬럼의 좌표 영역 */
  get columnCoords() {
    return this._columnCoords;
  }

  /** 각 컬럼의 너비 배열 (mm) */
  get columnWidth() {
    return this._columnWidths;
  }

  /** 컬럼 간격 배열 (mm) */
  public get gaps() {
    return this._gaps;
  }

  /** 행 높이 (mm) = fontSize × lineGap */
  public get lineHeight() {
    return this._lineHeight;
  }

  /** 글자 크기 (mm) */
  public get fontSize() {
    return this.textStyle.fontSize || DEFAULT_FONT_SIZE;
  }

  /** 행간 배율 */
  public get lineGap() {
    return this.paragraphStyle.lineGap || DEFAULT_LINE_GAP;
  }

  /** 편집 가능 너비 (mm) - 여백 제외 */
  public get editableWidth() {
    return this._columnCoords.length > 0 ? (this._columnCoords[this._columnCoords.length - 1].x2 - this._columnCoords[0].x1) : 0;
  }

  /** 편집 가능 높이 (mm) - 여백 제외, 행 높이의 배수로 정렬 */
  public get editableHeight() {
    return this._columnCoords.length > 0 ? (this._columnCoords[0].y2 - this._columnCoords[0].y1) : 0;
  }

  /** 편집 가능 텍스트 높이 (mm) - 마지막 줄의 하단 여분 포함 */
  public get editableTextHeight() {
    return this.editableHeight + (this.lineHeight - this.fontSize);
  }

  /** 픽셀/mm 변환 비율 */
  public get ppm() {
    return this._ppm;
  }
}