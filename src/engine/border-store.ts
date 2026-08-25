/**
 * 테이블 보더 면(face) 저장소.
 *
 * 테이블 그리드 위에 존재하는 독립적인 보더 면들을 관리한다.
 * 셀과 별개로 동작하며, 셀의 border getter/setter는 이 저장소에 대한 프록시 역할만 한다.
 *
 * 면 구조 (rowCount=R, colCount=C):
 * - 수평 면 `hFaces[line][col]`: line=0~R, col=0~C-1. 배열 크기 (R+1)×C
 * - 수직 면 `vFaces[row][line]`: row=0~R-1, line=0~C. 배열 크기 R×(C+1)
 *
 * @file src/engine/border-store.ts
 */

import type { BorderFace, TableBorders } from "@/types";
import type { BoxBorderStyle } from "@/types";

/** 기본 면 값 (그리지 않음). */
export const DEFAULT_BORDER_FACE: BorderFace = {
  width: 0,
  color: 'black',
  style: 'solid',
} as const;

/** 렌더링용 선분 (면 → 선분 변환 결과). 좌표는 테이블 기준 mm. */
export type BorderSegment = {
  /** 엣지 식별 키: "h-{line}-{col}" (수평) | "v-{row}-{line}" (수직) */
  readonly key: string;
  /** 엣지 방향 */
  readonly direction: 'horizontal' | 'vertical';
  /** 시작 X (mm, 테이블 기준) */
  readonly x: number;
  /** 시작 Y (mm, 테이블 기준) */
  readonly y: number;
  /** 엣지 길이 (mm) */
  readonly length: number;
  /** 보더 두께 (mm) */
  readonly width: number;
  /** 보더 색상 (ColorRegistry 이름) */
  readonly color: string;
  /** 보더 스타일 */
  readonly style: BoxBorderStyle;
  /** 그리드 라인 인덱스. 수평: 0~rowCount, 수직: 0~colCount. 외곽 판정용 */
  readonly lineIndex: number;
};

/**
 * 두 `BorderFace` 값이 동일한지 비교한다.
 *
 * @param a - 첫 번째 면
 * @param b - 두 번째 면
 * @returns 모든 필드가 같으면 `true`
 */
function faceEqual(a: BorderFace, b: BorderFace): boolean {
  return a.width === b.width && a.color === b.color && a.style === b.style;
}

/**
 * 테이블 보더 면 저장소.
 *
 * `TableData.borders`의 타입 세이프 접근 레이어.
 * 배열 크기 검증, 범위 체크, 기본값 채움, 세그먼트 변환을 담당한다.
 *
 * @example
 * ```ts
 * const store = TableBorderStore.create(3, 3);
 * store.setHFaceSpan(1, 0, 2, { width: 0.1, color: 'black', style: 'solid' });
 * const face = store.getHFace(1, 0); // { width: 0.1, color: 'black', style: 'solid' }
 * const segments = store.toSegments([10, 10, 10], [30, 30, 30]);
 * ```
 */
export class TableBorderStore {
  /** 수평 면. `hFaces[line][col]`. line=0~rowCount, col=0~colCount-1 */
  private _hFaces: BorderFace[][];
  /** 수직 면. `vFaces[row][line]`. row=0~rowCount-1, line=0~colCount */
  private _vFaces: BorderFace[][];
  private _rowCount: number;
  private _colCount: number;

  /**
   * 정적 팩토리 메서드.
   *
   * @param rowCount - 그리드 행 수
   * @param colCount - 그리드 열 수
   * @param borders - 초기 보더 데이터 (선택). 크기가 맞지 않으면 기본값으로 채움
   * @returns TableBorderStore 인스턴스
   */
  static create(rowCount: number, colCount: number, borders?: TableBorders): TableBorderStore {
    return new TableBorderStore(rowCount, colCount, borders);
  }

  private constructor(rowCount: number, colCount: number, borders?: TableBorders) {
    this._rowCount = rowCount;
    this._colCount = colCount;
    this._hFaces = TableBorderStore._initHFaces(rowCount, colCount, borders?.h);
    this._vFaces = TableBorderStore._initVFaces(rowCount, colCount, borders?.v);
  }

  /** 그리드 행 수 */
  get rowCount(): number { return this._rowCount; }
  /** 그리드 열 수 */
  get colCount(): number { return this._colCount; }

  /**
   * `TableBorders` 객체로 변환한다 (직렬화용).
   *
   * @returns 현재 면 상태를 담은 `TableBorders`
   */
  toTableBorders(): TableBorders {
    return {
      h: this._hFaces.map(row => row.map(face => ({ ...face }))),
      v: this._vFaces.map(row => row.map(face => ({ ...face }))),
    };
  }

  // ── 수평 면 ──

  /**
   * 단일 수평 면을 조회한다.
   *
   * @param line - 라인 인덱스 (0~rowCount)
   * @param col - 열 인덱스 (0~colCount-1)
   * @returns 해당 면의 값. 범위 벗어면 기본값
   */
  getHFace(line: number, col: number): BorderFace {
    const row = this._hFaces[line];
    if (!row) return DEFAULT_BORDER_FACE;
    return row[col] ?? DEFAULT_BORDER_FACE;
  }

  /**
   * 단일 수평 면에 값을 기록한다 (last-write-wins).
   *
   * @param line - 라인 인덱스 (0~rowCount)
   * @param col - 열 인덱스 (0~colCount-1)
   * @param face - 기록할 면 값
   */
  setHFace(line: number, col: number, face: BorderFace): void {
    if (line < 0 || line > this._rowCount) return;
    if (col < 0 || col >= this._colCount) return;
    this._hFaces[line][col] = { ...face };
  }

  /**
   * 여러 수평 면에 일괄 값을 기록한다 (last-write-wins).
   *
   * @param line - 라인 인덱스 (0~rowCount)
   * @param fromCol - 시작 열 (포함)
   * @param toCol - 끝 열 (포함)
   * @param face - 기록할 면 값
   */
  setHFaceSpan(line: number, fromCol: number, toCol: number, face: BorderFace): void {
    for (let c = fromCol; c <= toCol; c++) {
      this.setHFace(line, c, face);
    }
  }

  /**
   * 여러 수평 면을 조회한다. 모두 같으면 그 값, 하나라도 다르면 `undefined`.
   *
   * @param line - 라인 인덱스 (0~rowCount)
   * @param fromCol - 시작 열 (포함)
   * @param toCol - 끝 열 (포함)
   * @returns 통일된 면 값, 또는 `undefined` (섞인 경우)
   */
  getHFaceSpan(line: number, fromCol: number, toCol: number): BorderFace | undefined {
    if (fromCol > toCol) return undefined;
    const first = this.getHFace(line, fromCol);
    for (let c = fromCol + 1; c <= toCol; c++) {
      if (!faceEqual(this.getHFace(line, c), first)) return undefined;
    }
    return first;
  }

  // ── 수직 면 ──

  /**
   * 단일 수직 면을 조회한다.
   *
   * @param row - 행 인덱스 (0~rowCount-1)
   * @param line - 라인 인덱스 (0~colCount)
   * @returns 해당 면의 값. 범위 벗어면 기본값
   */
  getVFace(row: number, line: number): BorderFace {
    const r = this._vFaces[row];
    if (!r) return DEFAULT_BORDER_FACE;
    return r[line] ?? DEFAULT_BORDER_FACE;
  }

  /**
   * 단일 수직 면에 값을 기록한다 (last-write-wins).
   *
   * @param row - 행 인덱스 (0~rowCount-1)
   * @param line - 라인 인덱스 (0~colCount)
   * @param face - 기록할 면 값
   */
  setVFace(row: number, line: number, face: BorderFace): void {
    if (row < 0 || row >= this._rowCount) return;
    if (line < 0 || line > this._colCount) return;
    this._vFaces[row][line] = { ...face };
  }

  /**
   * 여러 수직 면에 일괄 값을 기록한다 (last-write-wins).
   *
   * @param fromRow - 시작 행 (포함)
   * @param toRow - 끝 행 (포함)
   * @param line - 라인 인덱스 (0~colCount)
   * @param face - 기록할 면 값
   */
  setVFaceSpan(fromRow: number, toRow: number, line: number, face: BorderFace): void {
    for (let r = fromRow; r <= toRow; r++) {
      this.setVFace(r, line, face);
    }
  }

  /**
   * 여러 수직 면을 조회한다. 모두 같으면 그 값, 하나라도 다르면 `undefined`.
   *
   * @param fromRow - 시작 행 (포함)
   * @param toRow - 끝 행 (포함)
   * @param line - 라인 인덱스 (0~colCount)
   * @returns 통일된 면 값, 또는 `undefined` (섞인 경우)
   */
  getVFaceSpan(fromRow: number, toRow: number, line: number): BorderFace | undefined {
    if (fromRow > toRow) return undefined;
    const first = this.getVFace(fromRow, line);
    for (let r = fromRow + 1; r <= toRow; r++) {
      if (!faceEqual(this.getVFace(r, line), first)) return undefined;
    }
    return first;
  }

  // ── 렌더링용 변환 ──

  /**
   * `width > 0`인 면만 선분으로 변환한다.
   *
   * @param rowHeights - 행 높이 배열 (mm)
   * @param colWidths - 열 너비 배열 (mm)
   * @returns 렌더링 대상 선분 배열
   */
  toSegments(rowHeights: number[], colWidths: number[]): BorderSegment[] {
    const segments: BorderSegment[] = [];
    const rowCount = this._rowCount;
    const colCount = this._colCount;

    for (let line = 0; line <= rowCount; line++) {
      const y = rowHeights.slice(0, line).reduce((a, b) => a + b, 0);
      for (let col = 0; col < colCount; col++) {
        const face = this.getHFace(line, col);
        if (face.width <= 0) continue;
        const x = colWidths.slice(0, col).reduce((a, b) => a + b, 0);
        const length = colWidths[col] ?? 0;
        segments.push({
          key: `h-${line}-${col}`,
          direction: 'horizontal',
          x,
          y,
          length,
          width: face.width,
          color: face.color,
          style: face.style,
          lineIndex: line,
        });
      }
    }

    for (let row = 0; row < rowCount; row++) {
      const y = rowHeights.slice(0, row).reduce((a, b) => a + b, 0);
      const length = rowHeights[row] ?? 0;
      for (let line = 0; line <= colCount; line++) {
        const face = this.getVFace(row, line);
        if (face.width <= 0) continue;
        const x = colWidths.slice(0, line).reduce((a, b) => a + b, 0);
        segments.push({
          key: `v-${row}-${line}`,
          direction: 'vertical',
          x,
          y,
          length,
          width: face.width,
          color: face.color,
          style: face.style,
          lineIndex: line,
        });
      }
    }

    return segments;
  }

  // ── 내부 초기화 ──

  /**
   * 수평 면 배열을 초기화한다.
   * `borders`가 제공되면 기존 값을 복사하고, 크기가 맞지 않으면 기본값으로 채운다.
   *
   * @param rowCount - 행 수
   * @param colCount - 열 수
   * @param hBorders - 기존 수평 면 데이터 (선택)
   * @returns 초기화된 수평 면 배열
   */
  private static _initHFaces(rowCount: number, colCount: number, hBorders?: BorderFace[][]): BorderFace[][] {
    const faces: BorderFace[][] = [];
    for (let line = 0; line <= rowCount; line++) {
      const row: BorderFace[] = [];
      for (let col = 0; col < colCount; col++) {
        const src = hBorders?.[line]?.[col];
        row.push(src ? { ...src } : { ...DEFAULT_BORDER_FACE });
      }
      faces.push(row);
    }
    return faces;
  }

  /**
   * 수직 면 배열을 초기화한다.
   * `borders`가 제공되면 기존 값을 복사하고, 크기가 맞지 않으면 기본값으로 채운다.
   *
   * @param rowCount - 행 수
   * @param colCount - 열 수
   * @param vBorders - 기존 수직 면 데이터 (선택)
   * @returns 초기화된 수직 면 배열
   */
  private static _initVFaces(rowCount: number, colCount: number, vBorders?: BorderFace[][]): BorderFace[][] {
    const faces: BorderFace[][] = [];
    for (let row = 0; row < rowCount; row++) {
      const r: BorderFace[] = [];
      for (let line = 0; line <= colCount; line++) {
        const src = vBorders?.[row]?.[line];
        r.push(src ? { ...src } : { ...DEFAULT_BORDER_FACE });
      }
      faces.push(r);
    }
    return faces;
  }
}