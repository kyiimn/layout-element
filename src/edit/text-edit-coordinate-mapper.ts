import type { LayoutColumnElement } from "@/components/layout/column.element";
import type { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import type { CursorPosition } from "@/types/edit/cursor.type";
import { DEFAULT_TEXT_ALIGN, DEFAULT_VERTICAL_ALIGN } from "@/constants";
import { EditManager } from "./edit-manager";

/**
 * `<x-layout-paragraph>` 내부의 텍스트 오프셋과 픽셀 좌표를 매핑한다.
 *
 * `data-offset`은 렌더링된 문자 위치(0, 1, 2, ...)를 나타내며,
 * 소스 문자열에 포함된 `\n` 문자나 줄 앞뒤로 제거된 공백을 반영하지 않는다.
 * 이 클래스는 렌더링 오프셋과 소스 오프셋 간의 양방향 변환을 관리한다.
 *
 * **좌표계 메모**: paragraph의 shadow root 자식 요소(cursor/selection)의
 * `top`/`left`는 paragraph local coordinate(transform: scale 적용 전 픽셀)를
 * 기대하지만, `getBoundingClientRect()`는 transform 적용 후 viewport 픽셀을
 * 반환한다. 그래서 `getCharRect` / `getTextRange` / `getFirstColumnRect`가
 * 반환하는 top/left/width/height는 모두 `EditManager.scale`로 나누어 local
 * coordinate로 변환한다. 단 `fontSize`는 `getComputedStyle`에서 오므로
 * local coordinate와 동일하여 보정하지 않는다.
 */
export class TextEditCoordinateMapper {
  private _paragraph: LayoutParagraphElement;

  /** 렌더링 오프셋 → 소스 오프셋 */
  private _renderedToSource: Map<number, number> = new Map();
  /** 소스 오프셋 → 렌더링 오프셋 */
  private _sourceToRendered: Map<number, number> = new Map();

  private _spanCache: Map<number, HTMLSpanElement> = new Map();
  private _columnSpansCache: Map<LayoutColumnElement, HTMLSpanElement[]> = new Map();
  private _columnRanges: { start: number; end: number }[] = [];
  private _columnStartOffsets: number[] = [];

  /**
   * 모든 라인의 시작 source offset을 컬럼순·라인순으로 평탄화한 배열.
   * `_lineSourceOffsets[columnIndex][lineIndex]` = 해당 라인의 시작 source offset.
   * 빈 줄(endOfBlock 직전 \n 위치)도 포함된다.
   */
  private _lineSourceOffsets: number[][] = [];

  /**
   * 모든 라인의 개수(컬럼 전체 합).
   */
  private _totalLineCount = 0;

  constructor(paragraph: LayoutParagraphElement) {
    this._paragraph = paragraph;
    this.rebuild();
  }

  /** 이 mapper가 바인딩된 paragraph 요소. */
  get paragraph(): LayoutParagraphElement {
    return this._paragraph;
  }

  /**
   * 캐시된 참조를 모두 지우고 오프셋 매핑을 다시 구축한다.
   * `paragraph.render()` 이후 컬럼이 다시 생성되면 호출해야 한다.
   */
  rebuild(): void {
    this._renderedToSource.clear();
    this._sourceToRendered.clear();
    this._spanCache.clear();
    this._columnSpansCache.clear();
    this._columnRanges = [];
    this._columnStartOffsets = [];
    this._lineSourceOffsets = [];
    this._totalLineCount = 0;

    this._rebuildMappings();
  }


  private _rebuildMappings(): void {
    const model = this._paragraph.model;
    if (!model) return;

    const columnContents = model.columnContents;
    let renderedOffset = 0;
    let sourceOffset = 0;

    for (let columnIndex = 0; columnIndex < columnContents.length; columnIndex++) {
      const lines = columnContents[columnIndex];
      const columnStart = renderedOffset;
      this._columnStartOffsets.push(columnStart);

      const lineStartOffsets: number[] = [];

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        // 라인의 시작 source offset을 기록. 빈 줄도 포함.
        lineStartOffsets.push(sourceOffset);

        for (let p = 0; p < line.parts.length; p++) {
          const part = line.parts[p];
          let content = part.content.join('');

          if (p === 0) {
            while (content.length > 0 && content[0] === ' ') {
              sourceOffset++;
              content = content.slice(1);
            }
          }
          if (p === line.parts.length - 1) {
            let trailingSpaces = 0;
            for (let i = content.length - 1; i >= 0 && content[i] === ' '; i--) {
              trailingSpaces++;
            }
            sourceOffset += trailingSpaces;
            while (content.length > 0 && content[content.length - 1] === ' ') {
              content = content.slice(0, content.length - 1);
            }
          }

          for (let i = 0; i < content.length; i++) {
            this._renderedToSource.set(renderedOffset, sourceOffset);
            this._sourceToRendered.set(sourceOffset, renderedOffset);
            renderedOffset++;
            sourceOffset++;
          }
        }

        if (line.endOfBlock) {
          sourceOffset++;
        }
      }

      this._lineSourceOffsets.push(lineStartOffsets);
      this._totalLineCount += lines.length;
      this._columnRanges.push({ start: columnStart, end: renderedOffset });
    }
  }

  /**
   * 렌더링 오프셋을 소스 문자열 오프셋으로 변환한다.
   * `\n` 문자와 제거된 공백을 고려한다.
   */
  sourceOffset(renderedOffset: number): number | null {
    return this._renderedToSource.get(renderedOffset) ?? null;
  }

  /**
   * 소스 문자열 오프셋을 렌더링 오프셋으로 변환한다.
   * `\n` 문자와 제거된 공백을 고려한다.
   */
  renderedOffset(sourceOffset: number): number | null {
    return this._sourceToRendered.get(sourceOffset) ?? null;
  }

  /**
   * 주어진 source 오프셋이 속한 라인의 컬럼 인덱스와 라인 인덱스를 반환한다.
   *
   * `columnContents`의 각 라인 시작 source offset과 비교하여 source 오프셋이
   * 어느 라인에 속하는지 이진 탐색으로 찾는다. \n 위치(빈 줄)도 해당 라인으로
   * 반환된다.
   *
   * @param sourceOffset 소스 텍스트 오프셋
   * @returns `{ columnIndex, lineIndex }` 또는 `null`(모델이 없거나 범위 밖)
   * @example
   *   // "hello\n\nworld"에서 sourceOffset 6(빈 줄) → { columnIndex: 0, lineIndex: 1 }
   */
  getLineInfoBySourceOffset(sourceOffset: number): { columnIndex: number; lineIndex: number } | null {
    for (let columnIndex = 0; columnIndex < this._lineSourceOffsets.length; columnIndex++) {
      const lineStarts = this._lineSourceOffsets[columnIndex];
      if (lineStarts.length === 0) continue;

      // 이 컬럼의 마지막 라인의 끝 source offset 계산
      const columnEnd = columnIndex < this._lineSourceOffsets.length - 1
        ? this._lineSourceOffsets[columnIndex + 1][0]  // 다음 컬럼 시작
        : sourceOffset + 1;  // 마지막 컬럼은 범위를 넓게

      if (sourceOffset < lineStarts[0] || sourceOffset >= columnEnd) continue;

      // 이진 탐색: sourceOffset이 속한 라인 찾기
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        if (lineStarts[mid] <= sourceOffset) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      return { columnIndex, lineIndex: low };
    }
    return null;
  }

  /**
   * 주어진 컬럼/라인 인덱스의 시작 source 오프셋을 반환한다.
   *
   * @param columnIndex 컬럼 인덱스
   * @param lineIndex 라인 인덱스
   * @returns 시작 source 오프셋 또는 `null`(범위 밖)
   */
  getLineStartSourceOffset(columnIndex: number, lineIndex: number): number | null {
    const lineStarts = this._lineSourceOffsets[columnIndex];
    if (!lineStarts || lineIndex < 0 || lineIndex >= lineStarts.length) return null;
    return lineStarts[lineIndex];
  }

  /**
   * 전체 라인 수(모든 컬럼 합)를 반환한다.
   *
   * @returns 라인 수
   */
  get totalLineCount(): number {
    return this._totalLineCount;
  }

  /**
   * 주어진 컬럼/라인 인덱스에 해당하는 line div의 paragraph-local rect를 반환한다.
   * 빈 줄도 line div가 존재하므로 rect를 반환한다.
   *
   * @param columnIndex 컬럼 인덱스
   * @param lineIndex 라인 인덱스
   * @returns `{ top, left, width, height }` 또는 `null`(line div가 없거나 범위 밖)
   */
  getLineRect(columnIndex: number, lineIndex: number): { top: number; left: number; width: number; height: number } | null {
    const columns = this._getAllColumns();
    const column = columns[columnIndex];
    if (!column || !column.shadowRoot) return null;

    const lineEls = Array.from(column.shadowRoot.children).filter(
      (child): child is HTMLDivElement => child.tagName === 'DIV',
    );
    if (lineIndex < 0 || lineIndex >= lineEls.length) return null;

    const lineEl = lineEls[lineIndex];
    const rect = lineEl.getBoundingClientRect();
    const paraRect = this._paragraph.getBoundingClientRect();
    const scale = EditManager.getInstance().scale;

    return {
      top: (rect.top - paraRect.top) / scale,
      left: (rect.left - paraRect.left) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    };
  }

  /**
   * 주어진 렌더링 오프셋에 해당하는 문자 span의 위치를 반환한다.
   * 좌표는 paragraph 로컬 좌표계(픽셀)로 변환된다.
   */
  getCharRect(offset: number): DOMRect | null {
    const span = this.getSpanByOffset(offset);
    if (!span) return null;

    const spanRect = span.getBoundingClientRect();
    const paragraphRect = this._paragraph.getBoundingClientRect();
    const scale = EditManager.getInstance().scale;

    return new DOMRect(
      (spanRect.left - paragraphRect.left) / scale,
      (spanRect.top - paragraphRect.top) / scale,
      spanRect.width / scale,
      spanRect.height / scale,
    );
  }

  /**
   * 뷰포트 좌표(x, y)가 포함된 문자 span의 소스 오프셋을 반환한다.
   * 컬럼 범위를 기준으로 binary search로 빠르게 탐색한다.
   */
  getCharOffsetFromPoint(x: number, y: number): CursorPosition | null {
    const columns = this._getAllColumns();
    if (columns.length === 0) return null;

    let low = 0;
    let high = columns.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const column = columns[mid];
      const rect = column.getBoundingClientRect();

      if (x < rect.left) {
        high = mid - 1;
      } else if (x >= rect.right) {
        low = mid + 1;
      } else {
        const spans = this._getColumnSpans(column);
        if (spans.length === 0) return null;

        let spanLow = 0;
        let spanHigh = spans.length - 1;

        while (spanLow <= spanHigh) {
          const spanMid = Math.floor((spanLow + spanHigh) / 2);
          const span = spans[spanMid];
          const spanRect = span.getBoundingClientRect();

          if (y < spanRect.top) {
            spanHigh = spanMid - 1;
          } else if (y >= spanRect.bottom) {
            spanLow = spanMid + 1;
          } else if (x >= spanRect.left && x < spanRect.right) {
            const renderedOffset = parseInt(span.dataset.offset ?? '', 10);
            if (Number.isNaN(renderedOffset)) return null;

            const sourceOffset = this.sourceOffset(renderedOffset);
            if (sourceOffset === null) return null;

            return { textOffset: sourceOffset };
          } else {
            // x is on the correct row but not within any span's bounds.
            // Return null so getNearestOffsetFromPoint() handles trailing/leading whitespace.
            return null;
          }
        }

        return null;
      }
    }

    return null;
  }

  /**
   * 뷰포트 좌표(x, y)에서 가장 가까운 텍스트 위치를 반환한다.
   * 행간 클릭 → 가장 가까운 행, 행의 빈 공간 클릭 → 가장 가까운 글자 위치.
   * getCharOffsetFromPoint와 달리 정확히 span 위가 아니어도 동작한다.
   */
  getNearestOffsetFromPoint(x: number, y: number): CursorPosition | null {
    // 먼저 정확한 span 위를 클릭했으면 그 결과를 그대로 반환
    const exact = this.getCharOffsetFromPoint(x, y);
    if (exact !== null) return exact;

    const columns = this._getAllColumns();
    if (columns.length === 0) return null;

    // 1. 클릭한 x 좌표가 포함된 컬럼 찾기, 또는 가장 가까운 컬럼
    let nearestColumn: LayoutColumnElement | null = null;
    let nearestColumnDist = Infinity;
    for (const col of columns) {
      const rect = col.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right) {
        nearestColumn = col;
        break;
      }
      const dist = x < rect.left ? rect.left - x : x - rect.right;
      if (dist < nearestColumnDist) {
        nearestColumnDist = dist;
        nearestColumn = col;
      }
    }
    if (!nearestColumn) return null;

    // line div 기반 라인 감지: 빈 줄(span 없는 줄)을 포함하여 클릭한 y가
    // 어느 라인에 속하는지 찾는다. 컬럼 내 line div들을 순회하며 y가 라인 범위
    // 내에 있으면 해당 라인의 시작 source offset을 반환한다.
    const columnIndex = this._getAllColumns().indexOf(nearestColumn);
    if (columnIndex >= 0) {
      const lineInfo = this._getLineAtPoint(nearestColumn, columnIndex, y);
      if (lineInfo !== null) {
        return { textOffset: lineInfo };
      }
    }

    let spans = this._getColumnSpans(nearestColumn);
    // 클릭한 컬럼에 span이 없으면(빈 컬럼) 가장 가까운 텍스트가 있는 컬럼으로 폴백
    if (spans.length === 0) {
      let bestCol: LayoutColumnElement | null = null;
      let bestColDist = Infinity;
      for (const col of columns) {
        const colSpans = this._getColumnSpans(col);
        if (colSpans.length === 0) continue;
        const colRect = col.getBoundingClientRect();
        const dist = x < colRect.left ? colRect.left - x : (x > colRect.right ? x - colRect.right : 0);
        if (dist < bestColDist) {
          bestColDist = dist;
          bestCol = col;
        }
      }
      if (bestCol) {
        nearestColumn = bestCol;
        spans = this._getColumnSpans(bestCol);
      }
    }
    if (spans.length === 0) return null;

    const spanRects = new Map<HTMLSpanElement, DOMRect>();
    for (const s of spans) {
      spanRects.set(s, s.getBoundingClientRect());
    }

    // 2. 클릭한 y 좌표가 속한 행(row) 찾기
    // 각 행의 top과 bottom을 모두 고려하여 y가 행 범위 내에 있으면 그 행을 선택.
    // 어느 행에도 속하지 않으면(행간 클릭) 행 중심에 가장 가까운 행을 선택.
    let nearestRowY = Infinity;
    const rowBounds = new Map<number, { top: number; bottom: number }>();
    for (const s of spans) {
      const r = spanRects.get(s)!;
      const rowTop = Math.round(r.top);
      const existing = rowBounds.get(rowTop);
      if (!existing || r.bottom > existing.bottom) {
        rowBounds.set(rowTop, { top: rowTop, bottom: r.bottom });
      }
    }

    // y가 행 범위 내에 있으면 그 행 선택
    for (const [rowTop, bounds] of rowBounds) {
      if (y >= bounds.top && y <= bounds.bottom) {
        nearestRowY = rowTop;
        break;
      }
    }

    // 어느 행에도 속하지 않으면 행 중심에 가장 가까운 행 선택
    if (nearestRowY === Infinity) {
      let bestRowDist = Infinity;
      for (const [rowTop, bounds] of rowBounds) {
        const centerY = (bounds.top + bounds.bottom) / 2;
        const dist = Math.abs(y - centerY);
        if (dist < bestRowDist) {
          bestRowDist = dist;
          nearestRowY = rowTop;
        }
      }
    }

    // 3. 해당 행의 span들 중에서 x 좌표와 가장 가까운 span 찾기
    let bestSpan: HTMLSpanElement | null = null;
    let bestDist = Infinity;
    for (const s of spans) {
      const r = spanRects.get(s)!;
      if (Math.round(r.top) !== nearestRowY) continue;

      let dist: number;
      if (x >= r.left && x <= r.right) {
        dist = 0;
      } else if (x < r.left) {
        dist = r.left - x;
      } else {
        dist = x - r.right;
      }

      if (dist < bestDist) {
        bestDist = dist;
        bestSpan = s;
      }
    }

    if (!bestSpan) return null;

    const renderedOffset = parseInt(bestSpan.dataset.offset ?? '', 10);
    if (Number.isNaN(renderedOffset)) return null;

    const sourceOffset = this.sourceOffset(renderedOffset);
    if (sourceOffset === null) return null;

    let rightmostSpan: HTMLSpanElement | null = null;
    let rightmostRight = -Infinity;
    let leftmostSpan: HTMLSpanElement | null = null;
    let leftmostLeft = Infinity;

    for (const s of spans) {
      const r = spanRects.get(s)!;
      if (Math.round(r.top) !== nearestRowY) continue;
      if (r.right > rightmostRight) {
        rightmostRight = r.right;
        rightmostSpan = s;
      }
      if (r.left < leftmostLeft) {
        leftmostLeft = r.left;
        leftmostSpan = s;
      }
    }

    if (rightmostSpan && x >= rightmostRight) {
      const rightmostOffset = parseInt(rightmostSpan.dataset.offset ?? '', 10);
      const rightmostSource = this.sourceOffset(rightmostOffset);
      if (rightmostSource !== null) {
        const content = this._paragraph.model?.textContent;
        if (content !== undefined && rightmostSource < content.length) {
          return { textOffset: rightmostSource + 1 };
        }
        return { textOffset: rightmostSource };
      }
    }

    if (leftmostSpan && x <= leftmostLeft) {
      const leftmostOffset = parseInt(leftmostSpan.dataset.offset ?? '', 10);
      const leftmostSource = this.sourceOffset(leftmostOffset);
      if (leftmostSource !== null) {
        return { textOffset: leftmostSource };
      }
    }

    const spanRect = spanRects.get(bestSpan)!;
    const midpoint = spanRect.left + spanRect.width / 2;
    if (x >= midpoint) {
      const content = this._paragraph.model?.textContent;
      if (content !== undefined && sourceOffset < content.length) {
        return { textOffset: sourceOffset + 1 };
      }
    }

    return { textOffset: sourceOffset };
  }

  /**
   * 컬럼 내에서 클릭한 y 좌표가 속한 빈 줄(span 없는 라인)의 시작 source offset을 반환한다.
   * 일반 라인(문자가 있는 라인)은 null을 반환하여 span 기반 로직이 가장 가까운
   * 글자 위치를 찾도록 위임한다.
   *
   * @param column 컬럼 요소
   * @param columnIndex 컬럼 인덱스
   * @param y 뷰포트 y 좌표
   * @returns 빈 줄의 시작 source offset 또는 `null`(일반 라인이거나 라인 div가 없음)
   */
  private _getLineAtPoint(
    column: LayoutColumnElement,
    columnIndex: number,
    y: number,
  ): number | null {
    if (!column.shadowRoot) return null;
    const model = this._paragraph.model;
    if (!model) return null;
    const lines = model.columnContents[columnIndex] || [];
    if (lines.length === 0) return null;

    const lineEls = Array.from(column.shadowRoot.children).filter(
      (child): child is HTMLDivElement => child.tagName === 'DIV',
    );
    if (lineEls.length === 0) return null;

    // 클릭한 y가 속한 라인 찾기
    let hitLine = -1;
    for (let i = 0; i < lineEls.length; i++) {
      const rect = lineEls[i].getBoundingClientRect();
      const isLast = i === lineEls.length - 1;
      const inRange = isLast
        ? (y >= rect.top && y <= rect.bottom)
        : (y >= rect.top && y < rect.bottom);
      if (inRange) {
        hitLine = i;
        break;
      }
    }
    // y가 라인들 사이 빈 공간이면 가장 가까운 라인 선택
    if (hitLine === -1) {
      let bestDist = Infinity;
      for (let i = 0; i < lineEls.length; i++) {
        const rect = lineEls[i].getBoundingClientRect();
        const centerY = (rect.top + rect.bottom) / 2;
        const dist = Math.abs(y - centerY);
        if (dist < bestDist) {
          bestDist = dist;
          hitLine = i;
        }
      }
    }
    if (hitLine < 0) return null;

    // 빈 줄(문자가 없는 라인)인 경우에만 line start offset 반환.
    const line = lines[hitLine];
    const lineCharCount = line.parts.reduce((sum, p) => sum + p.content.length, 0);
    if (lineCharCount === 0) {
      return this.getLineStartSourceOffset(columnIndex, hitLine);
    }
    // 일반 라인은 span 기반 로직에 위임
    return null;
  }

  /**
   * paragraph 로컬 좌표(픽셀)의 사각형 배열로 반환한다.
   * 같은 줄에 연속된 span은 하나의 사각형으로 합친다.
   */
  getTextRange(startOffset: number, endOffset: number): { top: number; left: number; width: number; height: number }[] {
    const result: { top: number; left: number; width: number; height: number }[] = [];
    if (startOffset >= endOffset) return result;

    const paragraphRect = this._paragraph.getBoundingClientRect();
    const scale = EditManager.getInstance().scale;
    const columns = this._getAllColumns();

    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const columnStartOffset = this._columnStartOffsets[columnIndex] ?? 0;
      const columnEndOffset = this._columnRanges[columnIndex]?.end ?? Infinity;

      if (startOffset >= columnEndOffset) continue;
      if (endOffset <= columnStartOffset) break;

      const column = columns[columnIndex];
      const spans = this._getColumnSpans(column);
      const rects: DOMRect[] = [];

      for (const span of spans) {
        const renderedOffset = parseInt(span.dataset.offset ?? '', 10);
        if (Number.isNaN(renderedOffset)) continue;

        const sourceOffset = this.sourceOffset(renderedOffset);
        if (sourceOffset === null) continue;

        if (sourceOffset >= startOffset && sourceOffset < endOffset) {
          const spanRect = span.getBoundingClientRect();
          rects.push(new DOMRect(
            (spanRect.left - paragraphRect.left) / scale,
            (spanRect.top - paragraphRect.top) / scale,
            spanRect.width / scale,
            spanRect.height / scale,
          ));
        }
      }

      if (rects.length === 0) continue;

      rects.sort((a, b) => a.top - b.top || a.left - b.left);

      // 같은 행의 연속된 사각형을 간격에 관계없이 병합하여
      // 글자 사이 빈 공간까지 선택 영역으로 덮도록 한다.
      let current = rects[0];
      for (let i = 1; i < rects.length; i++) {
        const rect = rects[i];
        if (Math.abs(rect.top - current.top) < 0.001) {
          // 같은 행: 간격에 관계없이 병합 (오른쪽 끝까지 확장)
          const newLeft = Math.min(current.left, rect.left);
          const newRight = Math.max(current.left + current.width, rect.left + rect.width);
          current = new DOMRect(
            newLeft,
            current.top,
            newRight - newLeft,
            Math.max(current.height, rect.height),
          );
        } else {
          result.push({
            top: current.top,
            left: current.left,
            width: current.width,
            height: current.height,
          });
          current = rect;
        }
      }

      result.push({
        top: current.top,
        left: current.left,
        width: current.width,
        height: current.height,
      });
    }

    return result;
  }

  /**
   * startOffset부터 endOffset까지(시작 포함, 끝 제외)의 소스 텍스트를 반환한다.
   * span의 innerText를 읽어 블록 사이의 `\n`을 복원한다.
   */
  getTextContent(startOffset: number, endOffset: number): string {
    if (startOffset >= endOffset) return '';

    const model = this._paragraph.model;
    if (!model) return '';

    const spans = this._getAllSortedSpans();
    let result = '';
    let lastSourceOffset: number | null = null;

    for (const span of spans) {
      const renderedOffset = parseInt(span.dataset.offset ?? '', 10);
      if (Number.isNaN(renderedOffset)) continue;

      const sourceOffset = this.sourceOffset(renderedOffset);
      if (sourceOffset === null) continue;

      if (sourceOffset < startOffset || sourceOffset >= endOffset) continue;

      if (lastSourceOffset !== null && sourceOffset > lastSourceOffset + 1) {
        // Fill the gap from the source string. Gaps contain either \n
        // characters (from block splits) or stripped spaces.
        const model = this._paragraph.model;
        if (model && typeof model.textContent === 'string') {
          const content = model.textContent;
          for (let i = lastSourceOffset + 1; i < sourceOffset; i++) {
            if (i < content.length) {
              result += content[i];
            }
          }
        } else {
          result += '\n';
        }
      }

      result += span.innerText;
      lastSourceOffset = sourceOffset;
    }

    return result;
  }

  /**
   * 첫 번째 컬럼의 paragraph-로컬 좌표와 폰트 크기를 반환한다.
   * 빈 단락에서 커서를 위치시킬 때 사용한다.
   */
  getFirstColumnRect(): { top: number; left: number; fontSize: number } | null {
    const columns = this._getAllColumns();
    if (columns.length === 0) return null;
    const firstColumn = columns[0];
    const colRect = firstColumn.getBoundingClientRect();
    const paraRect = this._paragraph.getBoundingClientRect();
    // fontSize는 getComputedStyle에서 오므로 paragraph local coordinate와 동일 (transform 영향 없음).
    const fontSize = parseFloat(getComputedStyle(firstColumn).fontSize) || 16;
    const scale = EditManager.getInstance().scale;

    const textAlign = this._paragraph.paragraphStyle?.textAlign || DEFAULT_TEXT_ALIGN;
    let left: number;
    if (textAlign === 'center') {
      left = (colRect.left - paraRect.left + colRect.width / 2) / scale;
    } else if (textAlign === 'right') {
      left = (colRect.right - paraRect.left) / scale;
    } else {
      left = (colRect.left - paraRect.left) / scale;
    }

    const verticalAlign = this._paragraph.paragraphStyle?.verticalAlign || this._paragraph.inheritStyle?.verticalAlign || DEFAULT_VERTICAL_ALIGN;
    let top: number;
    if (verticalAlign === 'center') {
      top = (colRect.top - paraRect.top + colRect.height / 2 - fontSize / 2) / scale;
    } else if (verticalAlign === 'bottom') {
      top = (colRect.bottom - paraRect.top - fontSize) / scale;
    } else {
      top = (colRect.top - paraRect.top) / scale;
    }

    return {
      top,
      left,
      fontSize,
    };
  }

  /**
   * 주어진 source 오프셋이 속한 시각적 라인의 시작과 끝 source 오프셋을 반환한다.
   * Home/End 키에서 사용 — \n 기준이 아닌 렌더링된 줄 기준.
   */
  findVisualLineBounds(sourceOffset: number): { start: number; end: number } | null {
    // renderedOffset이 null이면 인접 오프셋으로 폴백
    let renderedOffset = this.renderedOffset(sourceOffset);
    if (renderedOffset === null) {
      if (sourceOffset > 0) {
        renderedOffset = this.renderedOffset(sourceOffset - 1);
      }
      if (renderedOffset === null && sourceOffset === 0) {
        // 빈 단락이거나 오프셋 0이 렌더링되지 않은 경우
        return { start: 0, end: 0 };
      }
      if (renderedOffset === null) return null;
    }

    const anchorSpan = this.getSpanByOffset(renderedOffset);
    if (!anchorSpan) return null;

    // anchorSpan이 속한 컬럼만 검색 (다중 컬럼에서 같은 Y좌표가 다른 단인 것을 방지)
    const anchorColumn = this._findColumnBySpan(anchorSpan);
    if (anchorColumn === null) return null;

    const anchorRect = anchorSpan.getBoundingClientRect();
    let anchorTop = Math.round(anchorRect.top);

    // 공백 문자의 span은 height가 0이고 top이 실제 텍스트 행과 달라
    // 시각적 행 탐지가 틀어지므로, 가장 가까운 가시 span의 Y로 보정한다.
    if (anchorRect.height <= 1) {
      const columnSpansForY = this._getColumnSpans(anchorColumn);
      let bestSpan: HTMLSpanElement | null = null;
      let bestOffset = Infinity;
      for (const s of columnSpansForY) {
        const r = s.getBoundingClientRect();
        if (r.height <= 1) continue;
        const sOffset = parseInt(s.dataset.offset ?? '', 10);
        const distance = Math.abs(sOffset - renderedOffset);
        if (distance < bestOffset) {
          bestOffset = distance;
          bestSpan = s;
        }
      }
      if (bestSpan) {
        anchorTop = Math.round(bestSpan.getBoundingClientRect().top);
      }
    }

    // 같은 컬럼 내에서 같은 시각적 행(같은 top 좌표)의 가시 span 수집
    // 공백 등 height≤1 span은 가시 문자가 아니므로 제외
    const columnSpans = this._getColumnSpans(anchorColumn);
    const lineSpans: HTMLSpanElement[] = [];
    for (const s of columnSpans) {
      const r = s.getBoundingClientRect();
      if (r.height <= 1) continue;
      if (Math.round(r.top) === anchorTop) {
        lineSpans.push(s);
      }
    }

    if (lineSpans.length === 0) return null;

    const firstSpan = lineSpans[0];
    const lastSpan = lineSpans[lineSpans.length - 1];

    const startRendered = parseInt(firstSpan.dataset.offset ?? '', 10);
    const endRendered = parseInt(lastSpan.dataset.offset ?? '', 10);
    if (Number.isNaN(startRendered) || Number.isNaN(endRendered)) return null;

    const startSource = this.sourceOffset(startRendered);
    const endSource = this.sourceOffset(endRendered);
    if (startSource === null || endSource === null) return null;

    // end는 마지막 글자 "다음" 위치이므로 +1
    return { start: startSource, end: endSource + 1 };
  }

  /** span이 속한 컬럼 요소를 반환한다. */
  private _findColumnBySpan(span: HTMLSpanElement): LayoutColumnElement | null {
    let node: Node | null = span;
    while (node) {
      if (node instanceof HTMLElement && node.tagName.toLowerCase() === 'x-layout-column') {
        return node as LayoutColumnElement;
      }
      // Shadow DOM 경계를 넘어야 함 — span은 column의 shadow root 안에 있음
      if (node instanceof ShadowRoot) {
        node = node.host;
        continue;
      }
      node = node.parentNode;
    }
    return null;
  }

  /** paragraph의 모든 컬럼 요소를 렌더링 순서대로 반환한다. */
  private _getAllColumns(): LayoutColumnElement[] {
    return Array.from(this._paragraph.querySelectorAll('x-layout-column'));
  }

  getSpanByOffset(offset: number): HTMLSpanElement | null {
    if (this._spanCache.has(offset)) {
      return this._spanCache.get(offset)!;
    }

    const columnIndex = this._findColumnIndexByOffset(offset);
    if (columnIndex === null) return null;

    const columns = this._getAllColumns();
    const column = columns[columnIndex];
    if (!column || !column.shadowRoot) return null;

    const span = column.shadowRoot.querySelector<HTMLSpanElement>(
      `[data-offset="${offset}"]:not([data-temporary])`,
    );
    if (!span) return null;

    this._spanCache.set(offset, span);
    return span;
  }

  /** 컬럼 범위를 이용해 렌더링 오프셋이 속한 컬럼 인덱스를 반환한다. */
  private _findColumnIndexByOffset(offset: number): number | null {
    let low = 0;
    let high = this._columnRanges.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const range = this._columnRanges[mid];

      if (offset < range.start) {
        high = mid - 1;
      } else if (offset >= range.end) {
        low = mid + 1;
      } else {
        return mid;
      }
    }

    return null;
  }

  private _getColumnSpans(column: LayoutColumnElement): HTMLSpanElement[] {
    const cached = this._columnSpansCache.get(column);
    if (cached) return cached;

    if (!column.shadowRoot) return [];
    const spans = Array.from(
      column.shadowRoot.querySelectorAll<HTMLSpanElement>('[data-offset]:not([data-temporary])'),
    );
    this._columnSpansCache.set(column, spans);
    return spans;
  }

  private _getAllSortedSpans(): HTMLSpanElement[] {
    const spans: HTMLSpanElement[] = [];
    for (const column of this._getAllColumns()) {
      spans.push(...this._getColumnSpans(column));
    }
    return spans;
  }
}
