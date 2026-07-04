import type { LayoutColumnElement } from "@/components/layout/column.element";
import type { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import type { CursorPosition } from "@/types/edit/cursor.type";

/**
 * `<x-layout-paragraph>` 내부의 텍스트 오프셋과 픽셀 좌표를 매핑한다.
 *
 * `data-offset`은 렌더링된 문자 위치(0, 1, 2, ...)를 나타내며,
 * 소스 문자열에 포함된 `\n` 문자나 줄 앞뒤로 제거된 공백을 반영하지 않는다.
 * 이 클래스는 렌더링 오프셋과 소스 오프셋 간의 양방향 변환을 관리한다.
 */
export class EditCoordinateMapper {
  private _paragraph: LayoutParagraphElement;

  /** 렌더링 오프셋 → 소스 오프셋 */
  private _renderedToSource: Map<number, number> = new Map();
  /** 소스 오프셋 → 렌더링 오프셋 */
  private _sourceToRendered: Map<number, number> = new Map();

  /** 오프셋 → span 캐시. rebuild() 시 초기화된다. */
  private _spanCache: Map<number, HTMLSpanElement> = new Map();

  /** 각 컬럼의 렌더링 오프셋 범위 (binary search용) */
  private _columnRanges: { start: number; end: number }[] = [];

  private _columnStartOffsets: number[] = [];

  constructor(paragraph: LayoutParagraphElement) {
    this._paragraph = paragraph;
    this.rebuild();
  }

  /**
   * 캐시된 참조를 모두 지우고 오프셋 매핑을 다시 구축한다.
   * `paragraph.render()` 이후 컬럼이 다시 생성되면 호출해야 한다.
   */
  rebuild(): void {
    this._renderedToSource.clear();
    this._sourceToRendered.clear();
    this._spanCache.clear();
    this._columnRanges = [];
    this._columnStartOffsets = [];

    this._rebuildMappings();
  }


  private _rebuildMappings(): void {
    const model = this._paragraph.model;
    if (!model) return;

    const columnContents = model.columnContents;
    let renderedOffset = 0;
    let sourceOffset = 0;

    for (const lines of columnContents) {
      const columnStart = renderedOffset;
      this._columnStartOffsets.push(columnStart);

      for (const line of lines) {
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

          if (p === line.parts.length - 1) {
            const original = part.content.join('');
            let trailingSpaces = 0;
            for (let i = original.length - 1; i >= 0 && original[i] === ' '; i--) {
              trailingSpaces++;
            }
            sourceOffset += trailingSpaces;
          }
        }

        if (line.endOfBlock) {
          sourceOffset++;
        }
      }

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
   * 주어진 렌더링 오프셋에 해당하는 문자 span의 위치를 반환한다.
   * 좌표는 paragraph 로컬 좌표계(픽셀)로 변환된다.
   */
  getCharRect(offset: number): DOMRect | null {
    const span = this.getSpanByOffset(offset);
    if (!span) return null;

    const spanRect = span.getBoundingClientRect();
    const paragraphRect = this._paragraph.getBoundingClientRect();

    return new DOMRect(
      spanRect.left - paragraphRect.left,
      spanRect.top - paragraphRect.top,
      spanRect.width,
      spanRect.height,
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

    const spans = this._getColumnSpans(nearestColumn);
    if (spans.length === 0) return null;

    // 2. 클릭한 y 좌표가 속한 행(row) 찾기
    // 각 행의 top과 bottom을 모두 고려하여 y가 행 범위 내에 있으면 그 행을 선택.
    // 어느 행에도 속하지 않으면(행간 클릭) 행 중심에 가장 가까운 행을 선택.
    let nearestRowY = Infinity;
    const rowBounds = new Map<number, { top: number; bottom: number }>();
    for (const s of spans) {
      const r = s.getBoundingClientRect();
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
      const r = s.getBoundingClientRect();
      if (Math.round(r.top) !== nearestRowY) continue;

      // 클릭이 span 내부면 거리 0
      // 클릭이 span 왼쪽이면 span.left - x
      // 클릭이 span 오른쪽이면 x - span.right
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
      const r = s.getBoundingClientRect();
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
        const content = this._paragraph.model?.inputContent;
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

    const spanRect = bestSpan.getBoundingClientRect();
    const midpoint = spanRect.left + spanRect.width / 2;
    if (x >= midpoint) {
      const content = this._paragraph.model?.inputContent;
      if (content !== undefined && sourceOffset < content.length) {
        return { textOffset: sourceOffset + 1 };
      }
    }

    return { textOffset: sourceOffset };
  }

  /**
   * paragraph 로컬 좌표(픽셀)의 사각형 배열로 반환한다.
   * 같은 줄에 연속된 span은 하나의 사각형으로 합친다.
   */
  getTextRange(startOffset: number, endOffset: number): { top: number; left: number; width: number; height: number }[] {
    const result: { top: number; left: number; width: number; height: number }[] = [];
    if (startOffset >= endOffset) return result;

    const paragraphRect = this._paragraph.getBoundingClientRect();
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
            spanRect.left - paragraphRect.left,
            spanRect.top - paragraphRect.top,
            spanRect.width,
            spanRect.height,
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
        if (model && typeof model.inputContent === 'string') {
          const content = model.inputContent;
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
    const fontSize = parseFloat(getComputedStyle(firstColumn).fontSize) || 16;

    const textAlign = this._paragraph.paragraphStyle?.textAlign;
    let left: number;
    if (textAlign === 'center') {
      left = colRect.left - paraRect.left + colRect.width / 2;
    } else if (textAlign === 'right') {
      left = colRect.right - paraRect.left;
    } else {
      left = colRect.left - paraRect.left;
    }

    const verticalAlign = this._paragraph.paragraphStyle?.verticalAlign || this._paragraph.inheritStyle?.verticalAlign;
    let top: number;
    if (verticalAlign === 'center') {
      top = colRect.top - paraRect.top + colRect.height / 2 - fontSize / 2;
    } else if (verticalAlign === 'bottom') {
      top = colRect.bottom - paraRect.top - fontSize;
    } else {
      top = colRect.top - paraRect.top;
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
    const anchorTop = Math.round(anchorRect.top);

    // 같은 컬럼 내에서 같은 시각적 행(같은 top 좌표)의 span 수집
    const columnSpans = this._getColumnSpans(anchorColumn);
    const lineSpans: HTMLSpanElement[] = [];
    for (const s of columnSpans) {
      const r = s.getBoundingClientRect();
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

  /** 한 컬럼의 shadow root 내 모든 문자 span을 data-offset 순서대로 반환한다. */
  private _getColumnSpans(column: LayoutColumnElement): HTMLSpanElement[] {
    if (!column.shadowRoot) return [];
    return Array.from(
      column.shadowRoot.querySelectorAll<HTMLSpanElement>('[data-offset]:not([data-temporary])'),
    );
  }

  private _getAllSortedSpans(): HTMLSpanElement[] {
    const spans: HTMLSpanElement[] = [];
    for (const column of this._getAllColumns()) {
      spans.push(...this._getColumnSpans(column));
    }
    return spans;
  }
}
