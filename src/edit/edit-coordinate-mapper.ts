import type { LayoutColumnElement } from "@/components/column.element";
import type { LayoutParagraphElement } from "@/components/paragraph.element";
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

    const model = this._paragraph.model;
    if (!model) return;

    const columnContents = model.columnContents;
    let renderedOffset = 0;
    let sourceOffset = 0;

    for (const lines of columnContents) {
      const columnStart = renderedOffset;

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
    const span = this._getSpanByOffset(offset);
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
            break;
          }
        }

        return null;
      }
    }

    return null;
  }

  /**
   * startOffset부터 endOffset까지(시작 포함, 끝 제외)의 문자 영역을
   * paragraph 로컬 좌표(픽셀)의 사각형 배열로 반환한다.
   * 같은 줄에 연속된 span은 하나의 사각형으로 합친다.
   */
  getTextRange(startOffset: number, endOffset: number): { top: number; left: number; width: number; height: number }[] {
    const result: { top: number; left: number; width: number; height: number }[] = [];
    if (startOffset >= endOffset) return result;

    const paragraphRect = this._paragraph.getBoundingClientRect();

    for (const column of this._getAllColumns()) {
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

      let current = rects[0];
      for (let i = 1; i < rects.length; i++) {
        const rect = rects[i];
        if (
          Math.abs(rect.top - current.top) < 0.001 &&
          Math.abs(rect.left - (current.left + current.width)) < 0.001
        ) {
          current = new DOMRect(
            current.left,
            current.top,
            current.width + rect.width,
            current.height,
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
        result += '\n';
      }

      result += span.innerText;
      lastSourceOffset = sourceOffset;
    }

    return result;
  }

  /** paragraph의 모든 컬럼 요소를 렌더링 순서대로 반환한다. */
  private _getAllColumns(): LayoutColumnElement[] {
    return Array.from(this._paragraph.querySelectorAll('x-layout-column'));
  }

  /** 렌더링 오프셋에 해당하는 span을 전체 컬럼에서 찾는다. */
  private _getSpanByOffset(offset: number): HTMLSpanElement | null {
    if (this._spanCache.has(offset)) {
      return this._spanCache.get(offset)!;
    }

    const columnIndex = this._findColumnIndexByOffset(offset);
    if (columnIndex === null) return null;

    const columns = this._getAllColumns();
    const column = columns[columnIndex];
    if (!column || !column.shadowRoot) return null;

    const span = column.shadowRoot.querySelector<HTMLSpanElement>(`[data-offset="${offset}"]`);
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
    return Array.from(column.shadowRoot.querySelectorAll<HTMLSpanElement>('[data-offset]'));
  }

  /** 전체 paragraph의 모든 문자 span을 data-offset 순서대로 반환한다. */
  private _getAllSortedSpans(): HTMLSpanElement[] {
    const spans: HTMLSpanElement[] = [];
    for (const column of this._getAllColumns()) {
      spans.push(...this._getColumnSpans(column));
    }
    spans.sort((a, b) => {
      const offsetA = parseInt(a.dataset.offset ?? '', 10);
      const offsetB = parseInt(b.dataset.offset ?? '', 10);
      return offsetA - offsetB;
    });
    return spans;
  }
}
