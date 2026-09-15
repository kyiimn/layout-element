import type { LayoutColumnElement } from "@/components/layout/column.element";
import type { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import type { CursorPosition } from "@/types/edit/cursor.type";
import type { CursorLineRange, CursorPlacement } from "@/engine/types";
import { EditManager } from "./edit-manager";

export type { CursorPlacement };

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
  /**
   * 엔진 좌표 쿼리 사용 여부 (피처 플래그).
   *
   * `false`: 기존 DOM 기반 `getBoundingClientRect()` 경로 사용.
   * `true` (기본값, CANVAS_RENDERING.md 단계 0 전환 완료):
   * `ParagraphEngine.getCharRect()` 엔진 쿼리 사용 — mm×ppm은 이미
   * paragraph local 픽셀이므로 EditManager.scale 보정이 불필요하다
   * (`_getCharRectFromEngine` JSDoc 좌표 provenance 참조).
   *
   * DOM 경로는 패리티 오라클로 유지 (CANVAS_RENDERING.md §5 단계 5).
   */
  static useEngineCoordinateQueries: boolean = true;

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
   * 스레딩 프레임의 story 절대 오프셋 기준점.
   *
   * 스레드 프레임은 story 전체를 `textContent`로 소유하고 `contentFrom`부터
   * 배치한다 — 렌더 span(`data-source-offset`)과 엔진 쿼리는 프레임 로컬
   * 오프셋이고, 편집 커서는 story 절대 오프셋을 사용한다. 이 기준점으로
   * 두 공간을 변환한다. 비-스레딩 문단은 0이라 변환이 항등이 된다.
   *
   * `rebuild()`/`rebuildMappingsOnly()` 시점에 model에서 읽는다.
   */
  private _contentFrom = 0;

  /**
   * 엔진 `cursorLineRanges` 캐시 — 라인 경계의 단일 소스가 엔진이다.
   * mapper는 placement 구축((b) 패스)만 소유하고, 라인 경계/소속 판정은
   * 이 캐시에서 읽는다. `rebuild`/`rebuildMappingsOnly` 시점에 갱신.
   * (구 mapper walk `_lineSourceOffsets`/`_columnRanges`/`_totalLineCount`는
   * 엔진 walk와의 이중화라 제거되었다 — 소거 커밋 계약.)
   */
  private _lineRanges: CursorLineRange[][] = [];

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
    this._lineRanges = [];
    this._rebuildMappings();
  }

  /**
   * 오프셋 매핑만 재구축하고 DOM span 캐시는 유지한다.
   *
   * 증분 렌더링(컬럼 재사용, span diff) 후에는 DOM 요소가 교체되지 않으므로
   * `querySelectorAll` 재쿼리 없이 엔진 `columnContents` 기반 매핑만 갱신하면
   * 된다. `postRender`의 타이핑 핫패스에서 이 메서드를 사용해 키 입력당
   * 컬럼 전체 `querySelectorAll` 비용을 제거한다.
   */
  rebuildMappingsOnly(): void {
    this._sourceToPlacement.clear();
    this._lineEndPlacements.clear();
    this._lineRanges = [];
    this._rebuildMappings();
  }

  invalidateSpanCache(): void {
    this._spanCache.clear();
    this._columnSpansCache.clear();
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
    this._contentFrom = model.isThreadFrame ? model.contentFrom : 0;
    const textContent = model.plainText;

    // 라인 경계(a)는 엔진 단일 소스에서 읽는다 — mapper는 배치(b)만 구축.
    // 엔진 ranges는 프레임 로컬 오프셋이므로 story 절대 공간으로 +contentFrom 변환.
    const engine = this._paragraph.engine;
    const engineRanges = engine ? engine.cursorLineRanges : [];
    this._lineRanges = engineRanges.map(column =>
      column.map(range => ({
        ...range,
        startOffset: range.startOffset + this._contentFrom,
        endOffset: range.endOffset + this._contentFrom,
        firstVisible: range.firstVisible === null ? null : range.firstVisible + this._contentFrom,
        lastVisible: range.lastVisible === null ? null : range.lastVisible + this._contentFrom,
      })),
    );

    for (let columnIndex = 0; columnIndex < columnContents.length; columnIndex++) {
      const lines = columnContents[columnIndex];
      // 라인 시작 offset은 엔진 ranges(단일 소스)에서 — placement walk((b))만 이 루프가 수행.
      const columnRange = this._lineRanges[columnIndex] ?? [];

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        let sourceOffset = columnRange[lineIndex]
          ? columnRange[lineIndex].startOffset
          : sourceOffsetFallback(columnIndex, lineIndex, this._lineRanges, textContent.length);
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

    }

    // 매핑 구멍 채우기: _sourceToPlacement에 없는 source offset에 대해
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
    if (TextEditCoordinateMapper.useEngineCoordinateQueries) {
      return this._getCursorPlacementFromEngine(sourceOffset, preferLineEnd);
    }
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
    for (let columnIndex = this._lineRanges.length - 1; columnIndex >= 0; columnIndex--) {
      const column = this._lineRanges[columnIndex];
      if (column.length === 0) continue;
      if (sourceOffset < column[0].startOffset) continue;

      for (let lineIndex = column.length - 1; lineIndex >= 0; lineIndex--) {
        if (sourceOffset >= column[lineIndex].startOffset) {
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
    const column = this._lineRanges[columnIndex];
    if (!column || lineIndex < 0 || lineIndex >= column.length) return null;
    return column[lineIndex].startOffset;
  }

  /**
   * 전체 라인 수를 반환한다.
   * @returns 라인 수
   */
  get totalLineCount(): number {
    return this._paragraph.engine?.cursorLineCount ?? 0;
  }

  /**
   * 주어진 source 오프셋에 해당하는 문자 span의 위치를 반환한다.
   * 좌표는 paragraph 로컬 좌표계(픽셀)로 변환된다.
   * @param sourceOffset - 소스 오프셋
   * @returns DOMRect 또는 null
   */
  getCharRect(sourceOffset: number): DOMRect | null {
    if (TextEditCoordinateMapper.useEngineCoordinateQueries) {
      return this._getCharRectFromEngine(sourceOffset);
    }
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
   * 엔진 쿼리 경로: `ParagraphEngine.getCharRect()`의 지면 절대 mm을
   * paragraph local 픽셀로 변환해 반환한다.
   *
   * 2단 변환 계약:
   * 1. **원점 차감 (mm)** — `getCharRect`는 parentAbsRect absLeft/absTop를
   *    포함한 지면 절대 mm를 반환하지만, 커서 오버레이 좌표계는 문단 로컬을
   *    기대하므로 `engine.data.parentAbsRect` 원점을 차감한다.
   * 2. **mm→px (scale 불변)** — ppm은 `document.body`에 직접 부착한 100mm
   *    div로 측정되므로(transform: scale 변환 밖) `mm × ppm`은 이미
   *    paragraph local 픽셀이다. `EditManager.scale` 나눗셈이 불필요하다 —
   *    DOM 경로(`getBoundingClientRect`)만 뷰포트 픽셀을 반환하므로 scale
   *    나눗셈으로 local 좌표를 재현한다 (좌표계 메모 참조).
   *
   * @param sourceOffset - story 절대 소스 오프셋
   * @returns 문단 로컬 픽셀 DOMRect. 엔진 부재·미배치 문자면 `null`.
   */
  private _getCharRectFromEngine(sourceOffset: number): DOMRect | null {
    const engine = this._paragraph.engine;
    if (!engine) return null;
    // 엔진 쿼리는 프레임 로컬 오프셋을 기대한다 — 절대 → 로컬 변환.
    const localOffset = sourceOffset - this._contentFrom;
    const mmRect = engine.getCharRect(localOffset);
    if (!mmRect) return null;

    const parentAbsRect = engine.data?.parentAbsRect;
    const localLeftMm = mmRect.left - (parentAbsRect?.absLeft ?? 0);
    const localTopMm = mmRect.top - (parentAbsRect?.absTop ?? 0);

    const pageEl = (this._paragraph as unknown as { _findPageElement: () => { engine?: { ppm: number } } | null })._findPageElement();
    const ppm = pageEl?.engine?.ppm ?? 3.78;

    return new DOMRect(
      localLeftMm * ppm,
      localTopMm * ppm,
      mmRect.width * ppm,
      mmRect.height * ppm,
    );
  }

  /**
   * 엔진 쿼리 경로: `ParagraphEngine.getCursorPlacement()`(walk 기반 라인
   * 소속·가시 경계 클램프)으로 배치를 조회한다.
   *
   * @param sourceOffset - story 절대 오프셋
   * @param preferLineEnd - true면 줄 마지막 가시 문자 우측 배치 우선
   * @returns 커서 배치 정보 또는 null
   */
  /**
   * 엔진 쿼리 경로의 배치 조회 — `ParagraphEngine.getCursorPlacement`로 위임한다.
   *
   * 엔진 게터는 story 절대 오프셋을 소비하고(walk 기반 소속 판정 + preferLineEnd
   * 시맨틱) 참조 오프셋을 프레임 로컬(columnContents 공간)로 반환한다 —
   * mapper가 `_contentFrom`으로 story 절대로 재변환해 반환한다. 소속 판정·
   * 가시 경계 클램프·phantom end 시맨틱은 모두 엔진 단일 소스에서 수행된다.
   *
   * @param sourceOffset - story 절대 오프셋
   * @param preferLineEnd - true면 라인 끝 주차 시맨틱 (라인 중간은 클릭 위치 유지)
   * @returns 커서 배치 정보 또는 null
   */
  private _getCursorPlacementFromEngine(sourceOffset: number, preferLineEnd: boolean): CursorPlacement | null {
    const engine = this._paragraph.engine;
    if (!engine) return null;
    const placement = engine.getCursorPlacement(sourceOffset - this._contentFrom, preferLineEnd);
    if (!placement) return null;
    return { sourceOffset: placement.sourceOffset + this._contentFrom, atEndOfChar: placement.atEndOfChar };
  }

  /**
   * 뷰포트 좌표(x, y) 위치의 문자에 해당하는 소스 오프셋을 반환한다.
   * canvas 모드 문단은 엔진 `getOffsetFromPoint`로 매핑한다(span 트리 부재 —
   * 클라이언트 px를 문단 로컬 mm로 환산해 엔진에 전달한다).
   *
   * @param x - 뷰포트 x 좌표
   * @param y - 뷰포트 y 좌표
   * @returns CursorPosition 또는 null
   */
   getCharOffsetFromPoint(x: number, y: number): CursorPosition | null {
    if (this._isCanvasMode()) {
      return this._getOffsetFromPointEngine(x, y);
    }
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

    // y에 가장 가까운 라인 div 찾기.
    // 우선 "y가 라인 div rect [top, top+height) 내부"인 라인을 찾는다 —
    // leading space 공백 span은 height=0으로 라인 top 경계에만 걸려 중심이
    // 라인 경계와 일치한다. 이 상태에서 중심 거리 판정은 이전/현재 라인이
    // 동률(dist 동일)이 되어 위 라인을 반환하고, 개행 뒤 텍스트 클릭이
    // 한 라인 앞 오프셋으로 매핑된다 (사용자 보고: 엔터 후 커서 +1 불일치).
    // 포함 판정을 우선하면 경계상 공백 글자 클릭도 소속 라인에 귀속된다.
    // 포함 라인이 없을 때만(컬럼 상하 여백 등) 중심 거리 폴백을 쓴다.
    let closestLineEl: HTMLDivElement | null = null;
    let closestLineIndex = -1;
    for (let i = 0; i < lineEls.length; i++) {
      const lineRect = lineEls[i].getBoundingClientRect();
      if (y >= lineRect.top && y < lineRect.bottom) {
        closestLineEl = lineEls[i];
        closestLineIndex = i;
        break;
      }
    }
    if (!closestLineEl) {
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
    }
    if (!closestLineEl) return null;

    // 해당 라인의 span들 수집 — DOM 조상 귀속 (span → part div → line div).
    // 하단 앵커(bottom anchor) 때문에 큰 폰트 span의 top/bottom은 라인 div의
    // top/bottom과 모두 다르다(윗라인 침범 + 높이 fontSize). rect 기반 매칭은
    // 특정 크기의 span을 누락하므로, 엔진이 만든 DOM 구조로 라인 소속을 판별한다.
    const allSpans = this._getColumnSpans(bestColumn);
    const lineSpans: HTMLSpanElement[] = [];
    for (const span of allSpans) {
      if (this._getLineDivOfSpan(span, bestColumn) === closestLineEl) {
        lineSpans.push(span);
      }
    }

    // 빈 라인: 라인 시작 offset 반환
    if (lineSpans.length === 0) {
      const columnIdx = this._getAllColumns().indexOf(bestColumn);
      const lineStart = this.getLineStartSourceOffset(columnIdx, closestLineIndex);
      if (lineStart !== null) {
        return { textOffset: lineStart };
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

    // span srcOff는 렌더 로컬 — story 절대로 변환해 반환한다.
    const absOff = srcOff + this._contentFrom;

    // span 중심 기준 좌/우 결정
    const isRightSide = x > bestSpanRect.left + bestSpanRect.width / 2;
    return { textOffset: isRightSide ? absOff + 1 : absOff };
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
   * 이 문단이 canvas 렌더 모드인지 판정한다 — span 트리가 없으므로
   * span 순회 기반 API(getCharOffsetFromPoint 등)는 엔진 쿼리로 분기한다.
   */
  private _isCanvasMode(): boolean {
    const el = this._paragraph as unknown as { renderMode?: 'dom' | 'canvas' };
    return el.renderMode === 'canvas';
  }

  /**
   * canvas 모드 클릭 매핑 — 엔진 `getOffsetFromPoint`(지면 절대 mm)로 조회한다.
   * 클라이언트 px를 문단 로컬 mm로 환산해 전달하고, 결과는 story 절대 오프셋으로
   * 변환해 반환한다.
   *
   * @param x - 뷰포트 x 좌표
   * @param y - 뷰포트 y 좌표
   * @returns CursorPosition 또는 null
   */
  private _getOffsetFromPointEngine(x: number, y: number): CursorPosition | null {
    const engine = this._paragraph.engine;
    if (!engine) return null;
    const paraRect = this._paragraph.getBoundingClientRect();
    const scale = this._manager.scale || 1;
    const pageEl = (this._paragraph as unknown as { _findPageElement: () => { engine?: { ppm: number } } | null })._findPageElement();
    const ppm = pageEl?.engine?.ppm ?? 3.78;
    const parentAbsRect = engine.data?.parentAbsRect;
    // 클라이언트 px → (문단 로컬 mm + parentAbsRect 원점) = 지면 절대 mm.
    const xMm = (x - paraRect.left) / (scale * ppm) + (parentAbsRect?.absLeft ?? 0);
    const yMm = (y - paraRect.top) / (scale * ppm) + (parentAbsRect?.absTop ?? 0);
    const result = engine.getOffsetFromPoint(xMm, yMm);
    if (!result) return null;
    return { textOffset: result.textOffset + this._contentFrom };
  }

  /**
   * canvas 모드 선택 rect — 엔진 `getSelectionRects`(mm)를 paragraph local
   * 픽셀로 변환해 반환한다.
   *
   * @param startOffset - story 절대 시작 오프셋
   * @param endOffset - story 절대 끝 오프셋 (제외)
   * @returns 선택 rect 배열
   */
  private _getTextRangeFromEngine(startOffset: number, endOffset: number): { top: number; left: number; width: number; height: number }[] {
    const engine = this._paragraph.engine;
    if (!engine) return [];
    const pageEl = (this._paragraph as unknown as { _findPageElement: () => { engine?: { ppm: number } } | null })._findPageElement();
    const ppm = pageEl?.engine?.ppm ?? 3.78;
    const parentAbsRect = engine.data?.parentAbsRect;
    const mmRects = engine.getSelectionRects(
      startOffset - this._contentFrom,
      endOffset - this._contentFrom,
    );
    return mmRects.map(r => ({
      left: (r.left - (parentAbsRect?.absLeft ?? 0)) * ppm,
      top: (r.top - (parentAbsRect?.absTop ?? 0)) * ppm,
      width: r.width * ppm,
      height: r.height * ppm,
    }));
  }

  /**
   * start부터 end까지(끝 제외)의 선택 사각형 배열을 반환한다.
   *
   * canvas 모드 문단은 엔진 `getSelectionRects`(walk 기반 라인별 rect 산출,
   * §4.4 선택 rect 산출 계약 준수)로 대체한다 — span 트리가 없어 span 순회
   * 경로는 사용 불가.
   *
   * @param startOffset - 시작 source 오프셋
   * @param endOffset - 끝 source 오프셋
   * @returns Rect 배열
   */
  getTextRange(startOffset: number, endOffset: number): { top: number; left: number; width: number; height: number }[] {
    if (startOffset >= endOffset) return [];

    if (this._isCanvasMode()) {
      return this._getTextRangeFromEngine(startOffset, endOffset);
    }

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
        const absOff = srcOff + this._contentFrom;

        if (absOff < startOffset || absOff >= endOffset) {
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

        // top 기준 그룹핑: 같은 라인 내 크기가 다른 런(하단 앵커로 top이 다름)은
        // 분리된 rect로 유지되어 각 크기의 실제 영역을 하이라이트한다.
        // 인접 라인 간 top 우연 일치는 불가능하다 (라인 간격 lineHeight > 침범 깊이).
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
        const absOff = srcOff + this._contentFrom;

        if (absOff < startOffset || absOff >= endOffset) continue;

        result += model.plainText[absOff] ?? span.innerText;
        lastSourceOffset = absOff;
      }
    }

    if (lastSourceOffset < endOffset - 1) {
      for (let gap = lastSourceOffset + 1; gap < endOffset; gap++) {
        result += model.plainText[gap] ?? '\n';
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
   *
   * 엔진 레인지 단일 소스(B-2) — `cursorLineRanges`의 `firstVisible`/`lastVisible`
   * 을 반환한다. 구 rect-top 그룹핑 구현은 (a) 컬럼 전체 span의
   * `getBoundingClientRect` 루프(O(spans) 레이아웃 스래시)와 (b) 하단 앵커
   * 렌더(혼합 fontSize 라인에서 span top이 제각각)로 같은 라인의 다른 폰트
   * span을 누락하는 결함이 있었다. 렌더 가능 글자가 없는 빈 라인이거나 offset이
   * 매핑 밖(span 부재)이면 기존과 동일하게 null을 반환한다.
   *
   * @param sourceOffset - source 오프셋
   * @returns `{ start, end }` 또는 null. start = 라인의 첫 배치 가능 글자 offset,
   *   end = 마지막 배치 가능 글자 offset + 1 (배타적 — 구 시맨틱 유지).
   */
  findVisualLineBounds(sourceOffset: number): { start: number; end: number } | null {
    const info = this.getLineInfoBySourceOffset(sourceOffset);
    if (info === null) return null;
    const column = this._lineRanges[info.columnIndex];
    const range = column?.[info.lineIndex];
    if (!range) return null;
    if (range.firstVisible === null || range.lastVisible === null) return null;
    return {
      start: range.firstVisible,
      end: range.lastVisible + 1,
    };
  }

  /**
   * span이 소속된 line div를 반환한다.
   *
   * 컬럼 shadow DOM 구조는 `line div > part div > span`이므로 span의
   * shadow 직계 조상(line div)을 찾는다. rect 기반 라인 판별과 달리
   * 어떤 fontSize의 span이든 정확히 한 라인에 귀속된다.
   *
   * @param span - 대상 span
   * @param column - span이 속한 컬럼 요소
   * @returns line div 또는 null
   */
  private _getLineDivOfSpan(span: HTMLSpanElement, column: LayoutColumnElement): HTMLDivElement | null {
    const shadow = column.shadowRoot;
    if (!shadow) return null;
    let el: Element | null = span.parentElement;
    while (el && el.parentElement && !(el.parentElement instanceof ShadowRoot)) {
      el = el.parentElement;
    }
    return el instanceof HTMLDivElement ? el : null;
  }

  private _getAllColumns(): LayoutColumnElement[] {
    return Array.from(this._paragraph.querySelectorAll('x-layout-column'));
  }

  /**
   * 주어진 source 오프셋에 해당하는 문자 `span` 요소를 반환한다.
   * 임시 span은 제외한다. `_lineRanges`로 binary search로 컬럼을 찾아 해당 컬럼만 검색한다.
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

    // span의 data-source-offset은 렌더 로컬 오프셋이다 (contentFrom 기준).
    const localOffset = sourceOffset - this._contentFrom;
    const span = column.shadowRoot.querySelector<HTMLSpanElement>(
      `[data-source-offset="${localOffset}"]:not([data-temporary])`,
    );
    if (!span) return null;

    this._spanCache.set(sourceOffset, span);
    return span;
  }

  /**
   * `_lineRanges`에서 source offset이 속한 컬럼 인덱스를 binary search로 찾는다.
   * @param sourceOffset - 찾을 source offset
   * @returns 컬럼 인덱스 또는 null
   */
  private _findColumnIndexByOffset(sourceOffset: number): number | null {
    let low = 0;
    let high = this._lineRanges.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const column = this._lineRanges[mid];
      const isLast = mid === this._lineRanges.length - 1;
      // 컬럼 범위: 첫 라인 startOffset ~ 마지막 라인 endOffset
      const colStart = column.length > 0 ? column[0].startOffset : Infinity;
      const colEnd = column.length > 0 ? column[column.length - 1].endOffset : -Infinity;

      if (sourceOffset < colStart) {
        high = mid - 1;
      } else if (isLast ? sourceOffset > colEnd : sourceOffset >= colEnd) {
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

/**
 * 엔진 ranges에 없는 컬럼/라인의 폴백 시작 offset.
 *
 * 정상 경로에서는 발생하지 않는다(엔진 walk와 columnContents가 동일 트리에서
 * 나오므로). 방어용 — 컬럼 인덱스가 ranges보다 앞서면 이전 컬럼의 endOffset,
 * 첫 컬럼이면 0.
 */
function sourceOffsetFallback(
  columnIndex: number,
  lineIndex: number,
  lineRanges: CursorLineRange[][],
  textContentLength: number,
): number {
  if (columnIndex > 0 && lineRanges[columnIndex - 1]?.length) {
    const prevColumn = lineRanges[columnIndex - 1];
    return prevColumn[prevColumn.length - 1].endOffset;
  }
  return lineIndex === 0 ? 0 : textContentLength;
}