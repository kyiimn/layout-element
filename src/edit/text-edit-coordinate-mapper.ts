import type { LayoutColumnElement } from "@/components/layout/column.element";
import type { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import type { CursorPosition } from "@/types/edit/cursor.type";
import { EditManager } from "./edit-manager";

/**
 * 커서 배치 정보: 특정 source offset에 커서를 표시할 위치를 나타낸다.
 */
export interface CursorPlacement {
  /** 커서가 참조할 가시 문자의 source offset */
  sourceOffset: number;
  /** true면 커서를 문자의 우측 끝에 배치, false면 좌측에 배치 */
  atEndOfChar: boolean;
}

/**
 * `<x-layout-paragraph>` 내부의 텍스트 오프셋과 픽셀 좌표를 매핑한다.
 *
 * source offset은 `textContent` 기반 0-indexed 위치이며 `\n`과 공백을 포함한다.
 * 렌더링에서 생략된 leading/trailing space와 `\n`은 span이 생성되지 않지만
 * `data-source-offset`이 연속된 가시 문자에 부여되므로 source offset 기반으로
 * span을 직접 찾을 수 있다.
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
  private _manager: EditManager;

  /**
   * source offset → 커서 배치 정보.
   * 가시 문자는 `{ sourceOffset, atEndOfChar: false }`로 설정된다.
   * trailing space, endOfBlock 위치는 이전 가시 문자를 `{ atEndOfChar: true }`로 참조한다.
   * 생략된 leading space와 `\n` 다음 위치는 설정되지 않아 line rect 폴백으로 처리된다.
   */
  private _sourceToPlacement: Map<number, CursorPlacement> = new Map();

  /**
   * 라인 끝 phantom end placement 맵.
   *
   * trailing space 없이 끝나는 라인의 마지막 가시 문자 다음 offset(= 다음 라인 첫 글자의 offset)에 대해,
   * 이전 라인 마지막 가시 문자를 `atEndOfChar: true`로 참조하는 placement를 저장한다.
   *
   * 이 offset은 `_sourceToPlacement`에서 다음 라인 첫 글자의 placement(`atEndOfChar: false`)와 충돌하므로
   * 별도 맵으로 관리한다. `getCursorPlacement(offset, preferLineEnd)`에서 `preferLineEnd=true`면
   * 이 맵을 우선 조회하여 라인 끝 커서 배치에 사용한다.
   */
  private _lineEndPlacements: Map<number, CursorPlacement> = new Map();

  private _spanCache: Map<number, HTMLSpanElement> = new Map();
  private _columnSpansCache: Map<LayoutColumnElement, HTMLSpanElement[]> = new Map();

  /**
   * 각 컬럼의 source offset 범위. binary search용.
   * `_columnRanges[columnIndex] = { start, end }` — start는 첫 가시 문자의 source offset, end는 마지막 가시 문자의 source offset + 1.
   */
  private _columnRanges: { start: number; end: number }[] = [];

  /**
   * 모든 라인의 시작 source offset을 컬럼순·라인순으로 평탄화한 배열.
   * `_lineSourceOffsets[columnIndex][lineIndex]` = 해당 라인의 시작 source offset.
   */
  private _lineSourceOffsets: number[][] = [];

  /**
   * 모든 라인의 개수(컬럼 전체 합).
   */
  private _totalLineCount = 0;

  /**
   * @param paragraph - 이 mapper가 바인딩된 paragraph 요소
   * @param manager - 이 mapper가 속한 EditManager 인스턴스
   */
  constructor(paragraph: LayoutParagraphElement, manager: EditManager) {
    this._paragraph = paragraph;
    this._manager = manager;
    this.rebuild();
  }

  /**
   * 이 mapper가 바인딩된 paragraph 요소를 반환한다.
   * @returns paragraph 요소
   */
  get paragraph(): LayoutParagraphElement {
    return this._paragraph;
  }

  /**
   * 캐시된 참조를 모두 지우고 오프셋 매핑을 다시 구축한다.
   * `paragraph.render()` 이후 컬럼이 다시 생성되면 호출해야 한다.
   */
  rebuild(): void {
    this._sourceToPlacement.clear();
    this._lineEndPlacements.clear();
    this._spanCache.clear();
    this._columnSpansCache.clear();
    this._columnRanges = [];
    this._lineSourceOffsets = [];
    this._totalLineCount = 0;
    this._rebuildMappings();
  }

  /**
   * `columnContents`를 순회하며 source offset별 커서 배치 맵을 구축한다.
   *
   * 각 라인의 parts를 순회하며:
   * 1. leading space: `sourceOffset` 증가, placement 미설정 (line rect 폴백)
   * 2. 가시 문자: `{ sourceOffset, atEndOfChar: false }` 설정
   * 3. trailing space: 이전 가시 문자를 `{ atEndOfChar: true }`로 참조
   * 4. endOfBlock: 이전 가시 문자를 `{ atEndOfChar: true }`로 참조
   */
  private _rebuildMappings(): void {
    const model = this._paragraph.model;
    if (!model) return;

    const columnContents = model.columnContents;
    let sourceOffset = 0;
    const textContent = model.textContent;

    for (let columnIndex = 0; columnIndex < columnContents.length; columnIndex++) {
      const lines = columnContents[columnIndex];
      const lineStartOffsets: number[] = [];
      const columnStartSourceOffset = sourceOffset;

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        lineStartOffsets.push(sourceOffset);
        let lastVisibleSourceOffset: number | null = null;
        let lineTrailingSpaces = 0;

        for (let p = 0; p < line.parts.length; p++) {
          const part = line.parts[p];
          const original = part.content;
          const isFirst = p === 0;
          const isLast = p === line.parts.length - 1;

          // leading space: sourceOffset 증가만, placement 미설정
          // 단, firstOfBlock인 경우(블록 맨 앞)는 공백을 유지하므로 placement 설정
          let leadingSpaces = 0;
          if (isFirst && line.firstOfBlock !== true) {
            for (let k = 0; k < original.length && original[k] === ' '; k++) leadingSpaces++;
            sourceOffset += leadingSpaces;
          }

          const content = this._stripSpaces(original, isFirst, isLast, line.firstOfBlock === true, line.endOfBlock === true);

          for (let i = 0; i < content.length; i++) {
            this._sourceToPlacement.set(sourceOffset, {
              sourceOffset,
              atEndOfChar: false,
            });
            lastVisibleSourceOffset = sourceOffset;
            sourceOffset++;
          }

          // trailing space: 이전 가시 문자를 atEndOfChar: true로 참조
          // 단, endOfBlock인 경우(블록 맨 끝)는 공백을 유지하므로 placement 설정
          if (isLast && line.endOfBlock !== true) {
            const afterLeading = isFirst ? original.slice(leadingSpaces) : original;
            let trailingSpaces = 0;
            for (let k = afterLeading.length - 1; k >= 0 && afterLeading[k] === ' '; k--) trailingSpaces++;
            lineTrailingSpaces += trailingSpaces;
            for (let s = 0; s < trailingSpaces; s++) {
              if (lastVisibleSourceOffset !== null) {
                this._sourceToPlacement.set(sourceOffset, {
                  sourceOffset: lastVisibleSourceOffset,
                  atEndOfChar: true,
                });
              }
              sourceOffset++;
            }
          }
        }

        // phantom end placement: trailing space 없이 끝나는 라인의 마지막 가시 문자 다음 offset.
        // 이 offset은 다음 라인 첫 글자의 offset과 동일하므로 _sourceToPlacement와 충돌한다.
        // 따라서 별도 맵(_lineEndPlacements)에 저장하여 라인 끝 커서 배치에 사용한다.
        // trailing space가 있는 라인은 _sourceToPlacement에 이미 atEndOfChar: true로 설정되어 있으므로
        // phantom end가 불필요하며, 설정하면 다음 라인 첫 글자 offset에 잘못 배치되어
        // ArrowRight crossed → none 전환 시 커서가 이전 라인으로 돌아가는 버그가 발생한다.
        // endOfBlock 라인은 별도 처리(아래)에서 _sourceToPlacement에 설정하므로 제외.
        if (!line.endOfBlock && lineTrailingSpaces === 0 && lastVisibleSourceOffset !== null) {
          this._lineEndPlacements.set(sourceOffset, {
            sourceOffset: lastVisibleSourceOffset,
            atEndOfChar: true,
          });
        }

        // endOfBlock: 라인이 블록의 끝. 이전 가시 문자를 atEndOfChar: true로 참조.
        if (line.endOfBlock) {
          if (lastVisibleSourceOffset !== null) {
            if (!this._sourceToPlacement.has(sourceOffset)) {
              this._sourceToPlacement.set(sourceOffset, {
                sourceOffset: lastVisibleSourceOffset,
                atEndOfChar: true,
              });
            }
          }
          // textContent에 실제 \n이 있으면 sourceOffset++
          if (sourceOffset < textContent.length && textContent[sourceOffset] === '\n') {
            sourceOffset++;
          }
        }
      }

      this._lineSourceOffsets.push(lineStartOffsets);
      this._totalLineCount += lines.length;
      this._columnRanges.push({ start: columnStartSourceOffset, end: sourceOffset });
    }

    // 매핑 구멍 채우기: _sourceToPlacement에 없는 source offset에 대해
    // 순방향 스캔으로 마지막 placement를 추적하여 O(n)으로 채운다.
    // 생략된 공백과 \n 다음 위치는 건너뛴다 — line rect 폴백이 처리한다.
    let lastPlacement: CursorPlacement | null = null;
    for (let i = 0; i <= textContent.length; i++) {
      const existing = this._sourceToPlacement.get(i);
      if (existing) {
        lastPlacement = existing;
        continue;
      }
      if (i > 0 && (textContent[i - 1] === '\n' || textContent[i - 1] === ' ')) continue;
      if (lastPlacement) {
        this._sourceToPlacement.set(i, {
          sourceOffset: lastPlacement.sourceOffset,
          atEndOfChar: true,
        });
      }
    }
  }

  /**
   * 주어진 컬럼/라인 인덱스의 line div rect를 반환한다.
   * @param columnIndex - 컬럼 인덱스
   * @param lineIndex - 라인 인덱스
   * @returns `{ top, left, width, height }` 또는 null
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
    const scale = this._manager.scale;

    return {
      top: (rect.top - paraRect.top) / scale,
      left: (rect.left - paraRect.left) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    };
  }

  /** 줄의 양 끝 공백을 제거하여 렌더링된 문자열을 정리한다. */
  private _stripSpaces(content: string[], isFirst: boolean, isLast: boolean, firstOfBlock: boolean = false, endOfBlock: boolean = false): string[] {
    let result = content;
    if (isFirst && !firstOfBlock) {
      while (result.length > 0 && result[0] === ' ') { result = result.slice(1); }
    }
    if (isLast && !endOfBlock) {
      while (result.length > 0 && result[result.length - 1] === ' ') { result = result.slice(0, result.length - 1); }
    }
    return result;
  }

  /**
   * 주어진 source 오프셋에 커서를 배치하기 위한 정보를 반환한다.
   *
   * 생략된 leading space, `\n` 다음 위치 등 매핑이 없는 위치에서는
   * null을 반환하여 line rect 폴백으로 처리한다.
   *
   * @param sourceOffset - 소스 텍스트 오프셋
   * @param preferLineEnd - true면 라인 끝 배치를 우선한다. trailing space 없이 끝나는 라인의
   *   마지막 가시 문자 다음 offset(= 다음 라인 첫 글자 offset)에서, `_sourceToPlacement`는
   *   다음 라인 첫 글자의 `atEndOfChar: false`를 반환하지만, `preferLineEnd=true`면
   *   `_lineEndPlacements`의 phantom end placement(이전 라인 마지막 가시 문자의 `atEndOfChar: true`)를
   *   우선 반환하여 커서가 라인 끝 문자의 오른쪽에 배치되도록 한다.
   * @returns 커서 배치 정보. 배치 불가능한 경우 null.
   * @example
   * // offset 31이 라인 끝(일)과 다음 라인 시작(()의 경계일 때:
   * mapper.getCursorPlacement(31);            // → { sourceOffset: 31, atEndOfChar: false } (()의 왼쪽)
   * mapper.getCursorPlacement(31, true);      // → { sourceOffset: 30, atEndOfChar: true } (일의 오른쪽)
   */
  getCursorPlacement(sourceOffset: number, preferLineEnd = false): CursorPlacement | null {
    if (preferLineEnd) {
      const lineEnd = this._lineEndPlacements.get(sourceOffset);
      if (lineEnd) return lineEnd;
    }
    return this._sourceToPlacement.get(sourceOffset) ?? null;
  }

  /**
   * 주어진 source 오프셋이 속한 라인의 컬럼 인덱스와 라인 인덱스를 반환한다.
   *
   * @param sourceOffset - 찾을 source 오프셋
   * @returns `{ columnIndex, lineIndex }` 또는 null
   */
  getLineInfoBySourceOffset(sourceOffset: number): { columnIndex: number; lineIndex: number } | null {
    for (let columnIndex = this._lineSourceOffsets.length - 1; columnIndex >= 0; columnIndex--) {
      const lineStarts = this._lineSourceOffsets[columnIndex];
      if (lineStarts.length === 0) continue;
      if (sourceOffset < lineStarts[0]) continue;

      for (let lineIndex = lineStarts.length - 1; lineIndex >= 0; lineIndex--) {
        if (sourceOffset >= lineStarts[lineIndex]) {
          return { columnIndex, lineIndex };
        }
      }
    }
    return null;
  }

  /**
   * 주어진 컬럼/라인 인덱스의 시작 source 오프셋을 반환한다.
   * @param columnIndex - 컬럼 인덱스
   * @param lineIndex - 라인 인덱스
   * @returns 시작 source 오프셋. 없으면 null.
   */
  getLineStartSourceOffset(columnIndex: number, lineIndex: number): number | null {
    const lineStarts = this._lineSourceOffsets[columnIndex];
    if (!lineStarts || lineIndex < 0 || lineIndex >= lineStarts.length) return null;
    return lineStarts[lineIndex];
  }

  /**
   * 전체 라인 수를 반환한다.
   * @returns 라인 수
   */
  get totalLineCount(): number {
    return this._totalLineCount;
  }

  /**
   * 주어진 source 오프셋에 해당하는 문자 span의 위치를 반환한다.
   * 좌표는 paragraph 로컬 좌표계(픽셀)로 변환된다.
   * @param sourceOffset - 소스 오프셋
   * @returns DOMRect 또는 null
   */
  getCharRect(sourceOffset: number): DOMRect | null {
    const span = this.getSpanByOffset(sourceOffset);
    if (!span) return null;

    const spanRect = span.getBoundingClientRect();
    const paragraphRect = this._paragraph.getBoundingClientRect();
    const scale = this._manager.scale;

    return new DOMRect(
      (spanRect.left - paragraphRect.left) / scale,
      (spanRect.top - paragraphRect.top) / scale,
      spanRect.width / scale,
      spanRect.height / scale,
    );
  }

  /**
   * 뷰포트 좌표(x, y) 위치의 문자에 해당하는 소스 오프셋을 반환한다.
   *
   * 1. (x, y)가 속한 컬럼을 찾는다.
   * 2. 해당 컬럼에서 y에 가장 가까운 라인 div를 찾는다.
   * 3. 그 라인 div 내의 span들 중 x에 가장 가까운 span을 찾는다.
   * 4. span의 중심점 기준으로 좌측/우측을 결정하여 offset을 반환한다.
   * 5. 빈 라인(span이 없는 경우)이면 라인 시작 offset을 반환한다.
   *
   * @param x - 뷰포트 x 좌표
   * @param y - 뷰포트 y 좌표
   * @returns CursorPosition 또는 null
   */
   getCharOffsetFromPoint(x: number, y: number): CursorPosition | null {
    const columns = this._getAllColumns();

    // y 범위에 있는 컬럼들 중 x에 가장 가까운 컬럼 찾기
    let bestColumn: LayoutColumnElement | null = null;
    let bestColumnDist = Infinity;
    for (const column of columns) {
      if (!column.shadowRoot) continue;
      const columnRect = column.getBoundingClientRect();
      if (y < columnRect.top || y > columnRect.bottom) continue;

      let dist: number;
      if (x < columnRect.left) {
        dist = columnRect.left - x;
      } else if (x > columnRect.right) {
        dist = x - columnRect.right;
      } else {
        dist = 0;
      }
      if (dist < bestColumnDist) {
        bestColumnDist = dist;
        bestColumn = column;
      }
    }
    if (!bestColumn || !bestColumn.shadowRoot) return null;

    const columnShadow = bestColumn.shadowRoot;
    const lineEls = Array.from(columnShadow.children).filter(
      (child): child is HTMLDivElement => child.tagName === 'DIV',
    );

    // y에 가장 가까운 라인 div 찾기
    let closestLineEl: HTMLDivElement | null = null;
    let closestLineIndex = -1;
    let closestLineDist = Infinity;
    for (let i = 0; i < lineEls.length; i++) {
      const lineRect = lineEls[i].getBoundingClientRect();
      const lineCenterY = lineRect.top + lineRect.height / 2;
      const dist = Math.abs(y - lineCenterY);
      if (dist < closestLineDist) {
        closestLineDist = dist;
        closestLineEl = lineEls[i];
        closestLineIndex = i;
      }
    }
    if (!closestLineEl) return null;

    const lineRect = closestLineEl.getBoundingClientRect();
    const lineTop = Math.round(lineRect.top);

    // 해당 라인의 span들 수집
    const allSpans = this._getColumnSpans(bestColumn);
    const lineSpans: HTMLSpanElement[] = [];
    for (const span of allSpans) {
      const spanRect = span.getBoundingClientRect();
      if (spanRect.height <= 1) continue;
      if (Math.round(spanRect.top) === lineTop) {
        lineSpans.push(span);
      }
    }

    // 빈 라인: 라인 시작 offset 반환
    if (lineSpans.length === 0) {
      const lineStarts = this._lineSourceOffsets[this._getAllColumns().indexOf(bestColumn)];
      if (lineStarts && closestLineIndex >= 0 && closestLineIndex < lineStarts.length) {
        return { textOffset: lineStarts[closestLineIndex] };
      }
      return null;
    }

    // x에 가장 가까운 span 찾기
    let bestSpan = lineSpans[0];
    let bestDist = Infinity;
    for (const span of lineSpans) {
      const spanRect = span.getBoundingClientRect();
      const spanCenterX = spanRect.left + spanRect.width / 2;
      const dist = Math.abs(x - spanCenterX);
      if (dist < bestDist) {
        bestDist = dist;
        bestSpan = span;
      }
    }

    const bestSpanRect = bestSpan.getBoundingClientRect();
    const srcOff = parseInt(bestSpan.dataset.sourceOffset ?? '', 10);
    if (Number.isNaN(srcOff)) return null;

    // span 중심 기준 좌/우 결정
    const isRightSide = x > bestSpanRect.left + bestSpanRect.width / 2;
    return { textOffset: isRightSide ? srcOff + 1 : srcOff };
  }

  /**
   * 뷰포트 좌표(x, y)에서 가장 가까운 텍스트 위치를 반환한다.
   *
   * `getCharOffsetFromPoint`와 동일한 로직을 사용한다.
   * 빈 공간, 라인 간 간격, 빈 라인 등 모든 경우를 처리한다.
   *
   * @param x - 뷰포트 x 좌표
   * @param y - 뷰포트 y 좌표
   * @returns CursorPosition 또는 null
   */
  getNearestOffsetFromPoint(x: number, y: number): CursorPosition | null {
    return this.getCharOffsetFromPoint(x, y);
  }

  /**
   * start부터 end까지(끝 제외)의 선택 사각형 배열을 반환한다.
   * @param startOffset - 시작 source 오프셋
   * @param endOffset - 끝 source 오프셋
   * @returns Rect 배열
   */
  getTextRange(startOffset: number, endOffset: number): { top: number; left: number; width: number; height: number }[] {
    if (startOffset >= endOffset) return [];

    const columns = this._getAllColumns();
    const paraRect = this._paragraph.getBoundingClientRect();
    const scale = this._manager.scale;
    const ranges: { top: number; left: number; width: number; height: number }[] = [];

    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex];
      if (!column.shadowRoot) continue;

      const spans = this._getColumnSpans(column);

      let currentRow: { top: number; left: number; right: number; height: number } | null = null;

      for (const span of spans) {
        const srcOff = parseInt(span.dataset.sourceOffset ?? '', 10);
        if (Number.isNaN(srcOff)) continue;

        if (srcOff < startOffset || srcOff >= endOffset) {
          if (currentRow) {
            ranges.push({
              top: currentRow.top,
              left: currentRow.left,
              width: currentRow.right - currentRow.left,
              height: currentRow.height,
            });
            currentRow = null;
          }
          continue;
        }

        const spanRect = span.getBoundingClientRect();
        if (spanRect.height <= 1) continue;

        const localTop = (spanRect.top - paraRect.top) / scale;
        const localLeft = (spanRect.left - paraRect.left) / scale;
        const localRight = (spanRect.right - paraRect.left) / scale;
        const localHeight = spanRect.height / scale;

        if (currentRow && Math.round(currentRow.top) === Math.round(localTop)) {
          currentRow.right = localRight;
        } else {
          if (currentRow) {
            ranges.push({
              top: currentRow.top,
              left: currentRow.left,
              width: currentRow.right - currentRow.left,
              height: currentRow.height,
            });
          }
          currentRow = { top: localTop, left: localLeft, right: localRight, height: localHeight };
        }
      }

      if (currentRow) {
        ranges.push({
          top: currentRow.top,
          left: currentRow.left,
          width: currentRow.right - currentRow.left,
          height: currentRow.height,
        });
      }
    }

    return ranges;
  }

  /**
   * start부터 end까지(끝 제외)의 소스 텍스트를 반환한다.
   * @param startOffset - 시작 source 오프셋
   * @param endOffset - 끝 source 오프셋
   * @returns 텍스트
   */
  getTextContent(startOffset: number, endOffset: number): string {
    if (startOffset >= endOffset) return '';

    const model = this._paragraph.model;
    if (!model) return '';

    const columns = this._getAllColumns();
    let result = '';
    let lastSourceOffset = startOffset - 1;

    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex];
      if (!column.shadowRoot) continue;

      const spans = this._getColumnSpans(column);

      for (const span of spans) {
        const srcOff = parseInt(span.dataset.sourceOffset ?? '', 10);
        if (Number.isNaN(srcOff)) continue;

        if (srcOff < startOffset || srcOff >= endOffset) continue;

        if (srcOff > lastSourceOffset + 1 && typeof model.textContent === 'string') {
          for (let gap = lastSourceOffset + 1; gap < srcOff; gap++) {
            if (gap >= startOffset && gap < endOffset) {
              result += model.textContent[gap] ?? '\n';
            }
          }
        }

        result += span.innerText;
        lastSourceOffset = srcOff;
      }
    }

    if (lastSourceOffset < endOffset - 1 && typeof model.textContent === 'string') {
      for (let gap = lastSourceOffset + 1; gap < endOffset; gap++) {
        result += model.textContent[gap] ?? '\n';
      }
    }

    return result;
  }

  /**
   * 첫 번째 컬럼의 rect와 폰트 크기를 반환한다.
   * @returns `{ top, left, fontSize }` 또는 null
   */
  getFirstColumnRect(): { top: number; left: number; fontSize: number } | null {
    const columns = this._getAllColumns();
    const firstColumn = columns[0];
    if (!firstColumn || !firstColumn.shadowRoot) return null;

    const firstLineDiv = Array.from(firstColumn.shadowRoot.children).find(
      (child): child is HTMLDivElement => child.tagName === 'DIV',
    );
    if (!firstLineDiv) return null;

    const rect = firstLineDiv.getBoundingClientRect();
    const paraRect = this._paragraph.getBoundingClientRect();
    const scale = this._manager.scale;

    const computedStyle = window.getComputedStyle(firstLineDiv);
    const fontSize = parseFloat(computedStyle.fontSize) || 0;

    return {
      top: (rect.top - paraRect.top) / scale,
      left: (rect.left - paraRect.left) / scale,
      fontSize,
    };
  }

  /**
   * 주어진 source 오프셋이 속한 시각적 라인의 시작/끝 오프셋을 반환한다.
   * @param sourceOffset - source 오프셋
   * @returns `{ start, end }` 또는 null
   */
  findVisualLineBounds(sourceOffset: number): { start: number; end: number } | null {
    const span = this.getSpanByOffset(sourceOffset);
    if (!span) return null;

    const anchorColumn = this._findColumnBySpan(span);
    if (anchorColumn === null) return null;

    const anchorRect = span.getBoundingClientRect();
    const anchorTop = Math.round(anchorRect.top);

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

    const startSource = parseInt(firstSpan.dataset.sourceOffset ?? '', 10);
    const endSource = parseInt(lastSpan.dataset.sourceOffset ?? '', 10);
    if (Number.isNaN(startSource) || Number.isNaN(endSource)) return null;

    return { start: startSource, end: endSource + 1 };
  }

  private _findColumnBySpan(span: HTMLSpanElement): LayoutColumnElement | null {
    const columns = this._getAllColumns();
    for (const column of columns) {
      if (!column.shadowRoot) continue;
      if (column.shadowRoot.contains(span)) {
        return column;
      }
    }
    return null;
  }

  private _getAllColumns(): LayoutColumnElement[] {
    return Array.from(this._paragraph.querySelectorAll('x-layout-column'));
  }

  /**
   * 주어진 source 오프셋에 해당하는 문자 `span` 요소를 반환한다.
   * 임시 span은 제외한다. `_columnRanges`로 binary search로 컬럼을 찾아 해당 컬럼만 검색한다.
   * @param sourceOffset - 소스 오프셋
   * @returns span 요소 또는 null
   */
  getSpanByOffset(sourceOffset: number): HTMLSpanElement | null {
    if (this._spanCache.has(sourceOffset)) {
      return this._spanCache.get(sourceOffset)!;
    }

    const columnIndex = this._findColumnIndexByOffset(sourceOffset);
    if (columnIndex === null) return null;

    const columns = this._getAllColumns();
    const column = columns[columnIndex];
    if (!column || !column.shadowRoot) return null;

    const span = column.shadowRoot.querySelector<HTMLSpanElement>(
      `[data-source-offset="${sourceOffset}"]:not([data-temporary])`,
    );
    if (!span) return null;

    this._spanCache.set(sourceOffset, span);
    return span;
  }

  /**
   * `_columnRanges`에서 source offset이 속한 컬럼 인덱스를 binary search로 찾는다.
   * @param sourceOffset - 찾을 source offset
   * @returns 컬럼 인덱스 또는 null
   */
  private _findColumnIndexByOffset(sourceOffset: number): number | null {
    let low = 0;
    let high = this._columnRanges.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const range = this._columnRanges[mid];

      if (sourceOffset < range.start) {
        high = mid - 1;
      } else if (sourceOffset >= range.end) {
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

    const spans: HTMLSpanElement[] = [];
    if (column.shadowRoot) {
      column.shadowRoot.querySelectorAll<HTMLSpanElement>(
        'span[data-source-offset]:not([data-temporary])',
      ).forEach(span => spans.push(span));
    }

    this._columnSpansCache.set(column, spans);
    return spans;
  }
}