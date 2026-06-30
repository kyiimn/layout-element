import { DEFAULT_FONT_SIZE, DEFAULT_LINE_GAP, DEFAULT_PPM } from "@/define";
import { DocumentData } from "@/types";

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
export class BoxModel {
  private _columnCoords: Rect[];
  private _columnWidths: number[];
  private _gaps: number[];
  private _lineHeight: number;

  private _ppm: number;

  private _data!: DocumentData;

  /**
   * 정적 팩토리 메서드. `new` 직접 사용 금지.
   * @param data 문서 데이터
   */
  public static create(data: DocumentData) {
    return new this(data);
  }

  private constructor(data: DocumentData) {
    this._columnCoords = [];
    this._columnWidths = [];
    this._gaps = [];
    this._lineHeight = 0;
    this._ppm = DEFAULT_PPM;

    this._calcPxPerMM();
    this.data = data;
  }

  /**
   * 브라우저 DPI를 측정하여 픽셀/mm 변환 비율 계산.
   * 임시 100mm `<div>`를 DOM에 삽입 후 `offsetWidth`를 측정한다.
   */
  private _calcPxPerMM() {
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

  /** 컬럼 좌표 및 행 높이 계산 */
  private _calcCoordUnit() {
    this._lineHeight = this.fontSize * this.lineGap;

    const paddingTop = this._data.paddingTop || 0;
    const paddingRight = this._data.paddingRight || 0;
    const paddingBottom = this._data.paddingBottom || 0;
    const paddingLeft = this._data.paddingLeft || 0;

    this._columnCoords = [];
    this._columnWidths = [];

    if (typeof this._data.columns === 'number') {
      const gaps = typeof this._data.gap === 'number' ? Array.from({ length: this._data.columns - 1 }).map(() => this._data.gap as number) : this._data.gap;
      const editableWidth = this._data.width - paddingLeft - paddingRight - gaps.reduce((a, b) => a + b, 0);
      const editableHeight = Math.floor((this._data.height - paddingTop - paddingBottom) / this._lineHeight) * this._lineHeight;
      const columnWidth = editableWidth / this._data.columns;

      for (let i = 0; i < this._data.columns; i++) {
        const x1 = this._columnCoords.length > 0 ? this._columnCoords[this._columnCoords.length - 1].x2 + (gaps[i - 1] || 0) : paddingLeft;
        const y1 = paddingTop;
        const x2 = x1 + columnWidth;
        const y2 = paddingTop + editableHeight;

        this._columnCoords.push({ x1, y1, x2, y2 });
        this._columnWidths.push(columnWidth);
        if (i > 0) this._gaps.push(gaps[i - 1]);
      }
    } else {
      const gaps = typeof this._data.gap === 'number' ? Array.from({ length: this._data.columns.length - 1 }).map(() => this._data.gap as number) : this._data.gap;
      const editableHeight = this._data.height - paddingTop - paddingBottom;

      this._columnWidths = [...this._data.columns];
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

  set data(data: DocumentData) {
    this._data = data;

    this._calcCoordUnit();
  }

  /** 문서의 텍스트 스타일 */
  public get textStyle() {
    return this._data.textStyle;
  }

  /** 문서의 문단 스타일 */
  public get paragraphStyle() {
    return this._data.paragraphStyle;
  }

  /** 문서 너비 (mm) */
  public get width() {
    return this._data.width;
  }

  /** 문서 높이 (mm) */
  public get height() {
    return this._data.height;
  }

  /** 컬럼 개수 */
  public get columnCount() {
    return this._columnWidths.length;
  }

  /** 각 컬럼의 좌표 영역 */
  public get columnCoords() {
    return this._columnCoords;
  }

  /** 각 컬럼의 너비 배열 (mm) */
  public get columnWidth() {
    return this._columnWidths;
  }

  /** 컬럼 간격 배열 (mm) */
  public get gaps() {
    return this._gaps;
  }

  /** 상단 여백 (mm) */
  public get paddingTop() {
    return this._data.paddingTop || 0;
  }

  /** 우측 여백 (mm) */
  public get paddingRight() {
    return this._data.paddingRight || 0;
  }

  /** 하단 여백 (mm) */
  public get paddingBottom() {
    return this._data.paddingBottom || 0;
  }

  /** 좌측 여백 (mm) */
  public get paddingLeft() {
    return this._data.paddingLeft || 0;
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