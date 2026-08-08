import { LayoutBoxElement } from "@/components/layout/box.element";
import { LayoutDocumentElement } from "@/components/layout/document.element";
import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import { LayoutTableCellElement } from "@/components/layout/td.element";
import { LayoutTableElement } from "@/components/layout/table.element";
import { Z_INDEX_MARQUEE_RECT } from "@/constants";
import { EditManager } from "./edit-manager";
import type { TableCellSelection, CellCoord } from "@/types";

/**
 * 마키(고무줄) 선택 중 상태.
 */
interface MarqueeState {
  /** 마키 시작 시점의 마우스 clientX. */
  startX: number;
  /** 마키 시작 시점의 마우스 clientY. */
  startY: number;
  /** 3px 임계값을 넘어 실제 마키 드래그가 시작되었는지 여부. */
  active: boolean;
  /** 마키 사각형 DOM 요소. null이면 아직 생성되지 않음. */
  rectEl: HTMLDivElement | null;
  /** 마우스가 눌려 있는 동안의 최신 clientX. */
  lastX: number;
  /** 마우스가 눌려 있는 동안의 최신 clientY. */
  lastY: number;
  /** rAF ID. 중복 스케줄링 방지. */
  rafId: number | null;
  /** 드래그 중 하이라이트된 박스 목록 (DOM 속성만 조작, EditManager state 미반영). */
  highlightedBoxes: Set<LayoutBoxElement>;
}

/**
 * 레이아웃 선택 컨트롤러.
 *
 * 인쇄 모드와 인서트 모드를 제외하면 항상 활성화되어
 * 클릭으로 box를 선택할 수 있다.
 *
 * `LayoutEditController`가 드래그 이동/리사이즈를 담당한다면,
 * 이 컨트롤러는 모드와 무관하게 **선택만** 처리한다.
 * 이동/리사이즈는 여전히 편집 모드(`layoutEditMode`)에서만 동작한다.
 *
 * ## 아키텍처
 *
 * - **이벤트 위임**: `click`을 capture phase로 문서 요소(`LayoutDocumentElement`)에 등록한다.
 *   `composedPath()`를 통해 shadow DOM 내부의 box까지 추적할 수 있다.
 * - **선택 전용**: 드래그/리사이즈 상태를 관리하지 않고 오직 선택만 처리한다.
 * - **필터링**: `EditManager.isBoxSelectable()`로 선택 가능 여부를 판별한다.
 *   lock, root, role, id 필터를 적용하되 `layoutEditMode` 여부는 확인하지 않는다.
 */
export class LayoutSelectionController {
  /** 이벤트 리스너가 등록되는 루트 요소 (문서 요소 `LayoutDocumentElement`) */
  private _document: HTMLElement;
  /** 이 컨트롤러가 속한 EditManager 인스턴스 */
  private _manager: EditManager;
  /** 컨트롤러 활성화 여부. `attach()`/`detach()`로 토글된다 */
  private _attached = false;

  /** 마키 선택 상태. null이면 마키 진행 중 아님. */
  private _marquee: MarqueeState | null = null;
  /** 마키 시작 시 mousedown이 빈 영역(box가 아닌 곳)에서 발생했는지. */
  private _marqueePending = false;
  /** 마키 시작 시점의 Ctrl/Meta 키 상태 (기존 선택에 추가 여부 결정). */
  private _marqueeAdditive = false;
  private _cellDrag: { tableEl: LayoutTableElement; anchor: CellCoord; moved: boolean; startX: number; startY: number } | null = null;

  /**
   * @param doc - 이벤트 리스너가 등록될 루트 HTMLElement
   * @param manager - 이 컨트롤러가 속한 EditManager 인스턴스
   */
  constructor(doc: HTMLElement, manager: EditManager) {
    this._document = doc;
    this._manager = manager;
  }

  /**
   * 컨트롤러를 활성화하여 문서 레벨 click 이벤트 리스너를 등록한다.
   *
   * `click`과 `mousedown`을 capture phase(`true`)로 등록하여
   * box의 shadow DOM 내부에서 발생한 이벤트도 먼저 가로챌 수 있도록 한다.
   * 이미 활성화된 경우(`_attached === true`) 중복 등록을 방지한다.
   */
  attach(): void {
    if (this._attached) return;
    this._attached = true;
    this._document.addEventListener('mousedown', this._onMouseDown, true);
    this._document.addEventListener('click', this._onClick, true);
    this._document.addEventListener('dblclick', this._onDblClick, true);
    this._document.addEventListener('contextmenu', this._onContextMenu, true);
  }

  /**
   * 컨트롤러를 비활성화하고 리스너를 제거한다.
   */
  detach(): void {
    if (!this._attached) return;
    this._attached = false;
    this._document.removeEventListener('mousedown', this._onMouseDown, true);
    this._document.removeEventListener('click', this._onClick, true);
    this._document.removeEventListener('dblclick', this._onDblClick, true);
    this._document.removeEventListener('contextmenu', this._onContextMenu, true);
    this._cancelMarquee();
  }

  /**
   * 컨트롤러를 완전히 파괴한다. `detach()`와 동일하다.
   */
  destroy(): void {
    this.detach();
  }

  // ─── Marquee Selection ─────────────────────────────────────────

  /**
   * 마키 선택을 시작할지 결정하기 위해 pointerdown을 감지한다.
   *
   * 삽입 모드, 텍스트 편집 모드, 편집 가능 box에서는 마키를 시작하지 않는다.
   * 문서 내부의 빈 영역(box가 아닌 곳)에서 pointerdown이 발생하면 마키 후보로 기록한다.
   * window 레벨에 pointermove/up을 capture phase로 등록하여 빠른 드래그에도 이벤트를 보장한다.
   *
   * @param event - pointerdown 포인터 이벤트
   */
  private _onMouseDown = (event: MouseEvent): void => {
    const manager = this._manager;
    if (manager.insertMode) return;
    if (manager.placeGunActive) return;
    if (manager.spacePressed) return;
    if (manager.textEditMode && manager.focusedParagraph) return;
    if (event.button !== 0) return;

    for (const el of event.composedPath()) {
      if (el instanceof HTMLElement && el.classList.contains('table-resize-handle')) {
        return;
      }
    }

    const path = event.composedPath();
    const tableEl = path.find((el) => el instanceof LayoutTableElement) as LayoutTableElement | undefined;
    if (tableEl) {
      const kc = tableEl.keyboardController;
      if (kc?.selection && manager.layoutEditMode) {
        const tdEl = path.find((el) => el instanceof LayoutTableCellElement) as LayoutTableCellElement | undefined;
        if (tdEl && tdEl.cellLabel) {
          const kcInternal = kc as unknown as { _labelToCoord: (label: string) => CellCoord | null };
          const coord = kcInternal._labelToCoord ? kcInternal._labelToCoord(tdEl.cellLabel) : null;
          if (coord) {
            kc.selection = {
              mode: 'single',
              anchor: { ...coord },
              focus: { ...coord },
              selectMode: 'cell',
            };
            (tableEl as unknown as { _renderSelectionOverlay: (sel: TableCellSelection | null) => void })._renderSelectionOverlay(kc.selection);
            const box = tdEl.items[0];
            if (box) manager.selectLayout(box);
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
          }
        }
      }

      const tdElForDrag = path.find((el) => el instanceof LayoutTableCellElement) as LayoutTableCellElement | undefined;
      if (tdElForDrag && tdElForDrag.cellLabel && kc && manager.layoutEditMode) {
        const kcInternal = kc as unknown as { _labelToCoord: (label: string) => CellCoord | null };
        const coord = kcInternal._labelToCoord ? kcInternal._labelToCoord(tdElForDrag.cellLabel) : null;
        if (coord) {
          for (const t of document.querySelectorAll('x-layout-table')) {
            const otherKc = (t as LayoutTableElement).keyboardController;
            if (otherKc && otherKc !== kc && otherKc.selection) {
              otherKc.selection = null;
              (t as unknown as { _renderSelectionOverlay: (sel: null) => void })._renderSelectionOverlay(null);
            }
          }
          kc.selection = {
            mode: 'range',
            anchor: { ...coord },
            focus: { ...coord },
            selectMode: 'cell',
          };
          (tableEl as unknown as { _renderSelectionOverlay: (sel: TableCellSelection | null) => void })._renderSelectionOverlay(kc.selection);
          const box = tdElForDrag.items[0];
          if (box) manager.selectLayout(box);
          this._cellDrag = { tableEl, anchor: { ...coord }, moved: false, startX: event.clientX, startY: event.clientY };
          window.addEventListener('pointermove', this._onCellDragMove, true);
          window.addEventListener('pointerup', this._onCellDragUp, true);
          window.addEventListener('pointercancel', this._onCellDragUp, true);
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
    }

    let clearedTable = false;
    for (const t of document.querySelectorAll('x-layout-table')) {
      const kc = (t as LayoutTableElement).keyboardController;
      if (kc?.selection) {
        kc.selection = null;
        (t as unknown as { _renderSelectionOverlay: (sel: null) => void })._renderSelectionOverlay(null);
        clearedTable = true;
      }
    }

    const box = this._findSelectableBoxFromEvent(event);
    if (box) return;

    if (tableEl && !clearedTable) return;

    const isInsideDocument = event.composedPath().some(
      (el) => el instanceof LayoutDocumentElement
    );
    if (!isInsideDocument) return;

    this._marqueePending = true;
    this._marqueeAdditive = event.ctrlKey || event.metaKey;
    event.preventDefault();
    this._marquee = {
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      rectEl: null,
      lastX: event.clientX,
      lastY: event.clientY,
      rafId: null,
      highlightedBoxes: new Set(),
    };

    window.addEventListener('pointermove', this._onMarqueeMouseMove, true);
    window.addEventListener('pointerup', this._onMarqueeMouseUp, true);
    window.addEventListener('pointercancel', this._onMarqueeMouseUp, true);
  };

  private _onCellDragMove = (event: PointerEvent): void => {
    if (!this._cellDrag) return;
    const { tableEl, anchor, startX, startY } = this._cellDrag;
    const kc = tableEl.keyboardController;
    if (!kc) return;

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!this._cellDrag.moved) {
      if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
      this._cellDrag.moved = true;
    }

    const elements = document.elementsFromPoint(event.clientX, event.clientY);
    let targetTd: LayoutTableCellElement | null = null;
    for (const el of elements) {
      if (el instanceof LayoutTableCellElement && tableEl.contains(el)) {
        targetTd = el;
        break;
      }
    }
    if (!targetTd || !targetTd.cellLabel) return;

    const kcInternal = kc as unknown as { _labelToCoord: (label: string) => CellCoord | null };
    const coord = kcInternal._labelToCoord ? kcInternal._labelToCoord(targetTd.cellLabel) : null;
    if (!coord) return;

    if (kc.selection && kc.selection.focus.row === coord.row && kc.selection.focus.col === coord.col) return;

    kc.selection = {
      mode: 'range',
      anchor: { ...anchor },
      focus: { ...coord },
      selectMode: 'cell',
    };
    (tableEl as unknown as { _renderSelectionOverlay: (sel: TableCellSelection | null) => void })._renderSelectionOverlay(kc.selection);
    const selectedCells = kc.getSelectedCells();
    const boxes = selectedCells.map(c => c.items[0]).filter(Boolean);
    if (boxes.length > 0) this._manager.selectLayout(boxes);
  };

  private _onCellDragUp = (_event: PointerEvent): void => {
    window.removeEventListener('pointermove', this._onCellDragMove, true);
    window.removeEventListener('pointerup', this._onCellDragUp, true);
    window.removeEventListener('pointercancel', this._onCellDragUp, true);
    if (this._cellDrag) {
      if (!this._cellDrag.moved) {
        const kc = this._cellDrag.tableEl.keyboardController;
        if (kc && kc.selection) {
          kc.selection = {
            mode: 'single',
            anchor: { ...this._cellDrag.anchor },
            focus: { ...this._cellDrag.anchor },
            selectMode: 'cell',
          };
          (this._cellDrag.tableEl as unknown as { _renderSelectionOverlay: (sel: TableCellSelection | null) => void })._renderSelectionOverlay(kc.selection);
        }
      }
      this._cellDrag = null;
    }
  };

  /**
   * 마키 진행 중 pointermove 이벤트 핸들러.
   *
   * 3px 임계값을 넘으면 마키 사각형을 생성하고 표시한다.
   * 이후 rAF로 스로틀링하여 마키 사각형 갱신과 교차 박스 선택을 처리한다.
   *
   * @param event - pointermove 포인터 이벤트
   */
  private _onMarqueeMouseMove = (event: PointerEvent): void => {
    const marquee = this._marquee;
    if (!marquee) return;
    marquee.lastX = event.clientX;
    marquee.lastY = event.clientY;

    if (!marquee.active) {
      const dx = event.clientX - marquee.startX;
      const dy = event.clientY - marquee.startY;
      if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
      marquee.active = true;
      marquee.rectEl = this._createMarqueeRect();
      this._manager._suppressLayoutClick();
    }

    if (marquee.rafId !== null) return;
    marquee.rafId = requestAnimationFrame(() => {
      if (!marquee || !marquee.rectEl) return;
      marquee.rafId = null;
      this._updateMarqueeRect(marquee.rectEl, marquee.startX, marquee.startY, marquee.lastX, marquee.lastY);
      this._highlightIntersectingBoxes(marquee, this._marqueeAdditive);
    });
  };

  /**
   * 마키 종료 pointerup 이벤트 핸들러.
   *
   * 마키가 활성화되지 않았으면(단순 클릭) 빈 영역 클릭으로 처리한다.
   * 활성화되었으면 최종 교차 박스를 선택하고 마키를 정리한다.
   */
  private _onMarqueeMouseUp = (_event: PointerEvent): void => {
    this._removeMarqueeListeners();

    const marquee = this._marquee;
    this._marquee = null;

    if (!marquee) return;

    if (marquee.rafId !== null) {
      cancelAnimationFrame(marquee.rafId);
      marquee.rafId = null;
    }

    if (!marquee.active) {
      this._removeMarqueeRect(marquee);
      this._manager.clearLayoutSelection(false);
      this._manager.blurParagraph();
      this._marqueePending = false;
      return;
    }

    this._selectIntersectingBoxes(marquee, this._marqueeAdditive);
    this._removeMarqueeRect(marquee);
    // _marqueePending은 후속 click 이벤트를 _onClick에서 무시하기 위해 true로 유지.
    // _onClick이 호출되면 _marqueePending을 false로 소비한다.
    // click이 발생하지 않을 수 있으므로 타임아웃으로 안전망 제공.
    window.setTimeout(() => { this._marqueePending = false; }, 300);
  };

  /**
   * 마키 관련 window 리스너를 제거한다.
   */
  private _removeMarqueeListeners(): void {
    window.removeEventListener('pointermove', this._onMarqueeMouseMove, true);
    window.removeEventListener('pointerup', this._onMarqueeMouseUp, true);
    window.removeEventListener('pointercancel', this._onMarqueeMouseUp, true);
  }

  /**
   * 마키 사각형 DOM 요소를 생성하여 body에 추가한다.
   *
   * @returns 생성된 마키 사각형 div 요소
   */
  private _createMarqueeRect(): HTMLDivElement {
    const rect = document.createElement('div');
    rect.className = 'layout-marquee-rect';
    rect.style.position = 'fixed';
    rect.style.border = '1px dashed #4a90d9';
    rect.style.background = 'rgba(74, 144, 217, 0.1)';
    rect.style.pointerEvents = 'none';
    rect.style.zIndex = String(Z_INDEX_MARQUEE_RECT);
    rect.style.left = '0px';
    rect.style.top = '0px';
    rect.style.width = '0px';
    rect.style.height = '0px';
    document.body.appendChild(rect);
    return rect;
  }

  /**
   * 마키 사각형의 위치와 크기를 갱신한다.
   *
   * @param rectEl - 마키 사각형 DOM 요소
   * @param startX - 시작 X (clientX)
   * @param startY - 시작 Y (clientY)
   * @param currentX - 현재 X (clientX)
   * @param currentY - 현재 Y (clientY)
   */
  private _updateMarqueeRect(
    rectEl: HTMLDivElement,
    startX: number,
    startY: number,
    currentX: number,
    currentY: number,
  ): void {
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    rectEl.style.left = `${left}px`;
    rectEl.style.top = `${top}px`;
    rectEl.style.width = `${width}px`;
    rectEl.style.height = `${height}px`;
  }

  /**
   * 마키 사각형 DOM 요소를 제거한다.
   *
   * @param marquee - 마키 상태
   */
  private _removeMarqueeRect(marquee: MarqueeState): void {
    if (marquee.rectEl && marquee.rectEl.parentElement) {
      marquee.rectEl.parentElement.removeChild(marquee.rectEl);
    }
    marquee.rectEl = null;
  }

  /**
   * 마키 영역과 교차하는 선택 가능한 box를 찾는다.
   *
   * @param marqueeRect - 마키 사각형의 화면 좌표
   * @returns 교차하는 선택 가능 박스 목록
   */
  private _findIntersectingBoxes(marqueeRect: DOMRect): LayoutBoxElement[] {
    if (marqueeRect.width === 0 || marqueeRect.height === 0) return [];
    const manager = this._manager;
    const docEl = manager.docEl;
    const candidates: LayoutBoxElement[] = [];
    const allBoxes = docEl.querySelectorAll('x-layout-box');
    for (const box of allBoxes) {
      if (!(box instanceof LayoutBoxElement)) continue;
      if (!manager.isBoxSelectable(box)) continue;
      const boxRect = box.getBoundingClientRect();
      if (boxRect.width === 0 || boxRect.height === 0) continue;
      const intersects =
        marqueeRect.left < boxRect.right &&
        marqueeRect.right > boxRect.left &&
        marqueeRect.top < boxRect.bottom &&
        marqueeRect.bottom > boxRect.top;
      if (intersects) candidates.push(box);
    }
    return candidates;
  }

  /**
   * 마키 영역과 교차하는 박스에 `selected` 속성을 직접 부여하여 실시간 하이라이트한다.
   *
   * EditManager의 선택 state(`_selectedLayouts`)는 건드리지 않고 DOM 속성만 조작한다.
   * 이전 하이라이트에서 벗어난 박스는 `selected`를 제거하고, 새로 진입한 박스는 추가한다.
   * Ctrl/Cmd(additive) 모드에서는 마키 시작 시점의 기존 선택 박스를 유지한다.
   *
   * @param marquee - 마키 상태
   * @param additive - true면 기존 선택 유지 위에 하이라이트, false면 마키 영역만 하이라이트
   */
  private _highlightIntersectingBoxes(marquee: MarqueeState, additive: boolean): void {
    const rectEl = marquee.rectEl;
    if (!rectEl) return;
    const marqueeRect = rectEl.getBoundingClientRect();
    const candidates = this._findIntersectingBoxes(marqueeRect);
    const candidateSet = new Set(candidates);

    const manager = this._manager;
    const existing = additive ? new Set(manager.selectedLayouts) : null;

    const desired = new Set<LayoutBoxElement>();
    for (const box of candidateSet) {
      if (existing && existing.has(box)) continue;
      desired.add(box);
    }

    const prev = marquee.highlightedBoxes;
    for (const box of prev) {
      if (!desired.has(box)) {
        box.removeAttribute('selected');
      }
    }
    for (const box of desired) {
      box.setAttribute('selected', '');
    }
    marquee.highlightedBoxes = desired;
  }

  /**
   * 마키 영역과 교차하는 선택 가능한 box를 찾아 선택한다.
   *
   * @param marquee - 마키 상태
   * @param additive - true면 기존 선택에 추가, false면 기존 선택 해제 후 새로 선택
   */
  private _selectIntersectingBoxes(marquee: MarqueeState, additive: boolean): void {
    const rectEl = marquee.rectEl;
    if (!rectEl) return;
    const marqueeRect = rectEl.getBoundingClientRect();
    const candidates = this._findIntersectingBoxes(marqueeRect);

    const manager = this._manager;
    for (const box of marquee.highlightedBoxes) {
      box.removeAttribute('selected');
    }
    marquee.highlightedBoxes.clear();

    if (!additive) {
      manager.clearLayoutSelection(false);
      if (candidates.length === 0) return;
      manager._setMultiSelect(true);
      for (const box of candidates) manager.selectLayout(box);
      manager._setMultiSelect(false);
      return;
    }

    manager._setMultiSelect(true);
    for (const box of candidates) {
      if (!manager.selectedLayouts.includes(box)) {
        manager.selectLayout(box);
      }
    }
    manager._setMultiSelect(false);
  }

  /**
   * 진행 중인 마키를 취소하고 정리한다.
   */
  private _cancelMarquee(): void {
    if (this._marquee) {
      if (this._marquee.rafId !== null) {
        cancelAnimationFrame(this._marquee.rafId);
      }
      for (const box of this._marquee.highlightedBoxes) {
        box.removeAttribute('selected');
      }
      this._removeMarqueeRect(this._marquee);
      this._marquee = null;
    }
    this._marqueePending = false;
    this._removeMarqueeListeners();
  }

  // ─── Event Detection Helpers ──────────────────────────────────

  /**
   * 이벤트 경로에서 선택 가능한 가장 안쪽 box를 찾는다.
   *
   * `composedPath()`를 순회하며 `LayoutBoxElement` 인스턴스 중
   * `EditManager.isBoxSelectable()`을 통과하는 첫 번째 요소를 반환한다.
   * shadow DOM 내부의 box도 `composedPath()`를 통해 추적할 수 있다.
   *
   * @param event - 마우스 이벤트
   * @returns 선택 가능한 box 요소. 없으면 `null`
   */
  private _findSelectableBoxFromEvent(event: MouseEvent): LayoutBoxElement | LayoutTableCellElement | null {
    const path = event.composedPath();
    for (const el of path) {
      if (el instanceof LayoutTableCellElement) {
        const manager = this._manager;
        if (manager.isBoxSelectable(el)) {
          return el;
        }
      }
      if (el instanceof LayoutBoxElement) {
        const manager = this._manager;
        if (manager.isBoxSelectable(el)) {
          return el;
        }
      }
    }
    return null;
  }

  /**
   * 이벤트가 box의 자손(후손) box에서 발생했는지 판별한다.
   *
   * 중첩된 box 구조에서 자식 box를 클릭할 때 부모 box까지 함께 선택되는 것을
   * 방지하기 위해 사용된다.
   *
   * @param event - 마우스 이벤트
   * @param box - 기준이 되는 box 요소
   * @returns 자손 box에서 발생한 이벤트이면 `true`
   */
  private _isEventFromDescendantLayout(event: MouseEvent, box: LayoutBoxElement | LayoutTableCellElement): boolean {
    const path = event.composedPath();
    const manager = this._manager;
    for (const el of path) {
      if (el === box) return false;
      if (el instanceof LayoutBoxElement && manager.isBoxSelectable(el)) return true;
    }
    return false;
  }

  /**
   * 이벤트 경로에서 가장 안쪽의 `LayoutParagraphElement`를 찾는다.
   *
   * `composedPath()`를 순회하며 `LayoutParagraphElement` 인스턴스 중
   * 부모 box가 `EditManager.isBoxSelectable()`을 통과하는 첫 번째 요소를 반환한다.
   * 부모 box가 선택 가능하지 않으면(예: lock) 더 이상 탐색하지 않고 `null`을 반환한다.
   * shadow DOM 내부의 paragraph도 `composedPath()`를 통해 추적할 수 있다.
   *
   * @param event - 마우스 이벤트
   * @returns 선택 가능한 부모 box를 가진 paragraph 요소. 없으면 `null`
   */
  private _findParagraphFromEvent(event: MouseEvent): LayoutParagraphElement | null {
    const path = event.composedPath();
    const manager = this._manager;
    for (const el of path) {
      if (el instanceof LayoutParagraphElement) {
        const parentBox = el.parentElement;
        if (parentBox instanceof LayoutBoxElement && manager.isBoxSelectable(parentBox)) {
          return el;
        }
        // 부모 box가 선택 불가능하면 더 이상 위로 탐색하지 않는다.
        return null;
      }
    }
    return null;
  }

  // ─── Click Handling ───────────────────────────────────────────

  /**
   * 클릭 이벤트 핸들러.
   *
   * 선택 가능한 box에서 발생한 클릭을 처리하여 선택한다.
   * 삽입 모드이면 무시하고, 자손 box에서 발생한 이벤트도 무시한다.
   *
   * @param event - 클릭 마우스 이벤트
   */
  private _onClick = (event: MouseEvent): void => {
    const manager = this._manager;
    if (manager.insertMode) return;
    if (manager._consumeSuppressNextClick()) return;

    if (this._marqueePending) {
      this._marqueePending = false;
      return;
    }

    const path = event.composedPath();
    if (path.some((el) => el instanceof Element && el.closest('.parent-btn'))) return;

    const tableEl = path.find((el) => el instanceof LayoutTableElement) as LayoutTableElement | undefined;
    if (tableEl) {
      const kc = tableEl.keyboardController;
      if (kc?.selection) {
        return;
      }
    }

    const box = this._findSelectableBoxFromEvent(event);

    if (!box) {
      const isInsideDocument = event.composedPath().some(
        (el) => el instanceof LayoutDocumentElement
      );
      if (isInsideDocument) {
        manager.clearLayoutSelection(false);
        manager.blurParagraph();
      }
      return;
    }

    if (manager.layoutEditMode && manager.isBoxEditable(box)) return;

    if (box.hasAttribute('text-focused')) return;

    event.stopPropagation();
    if (this._isEventFromDescendantLayout(event, box)) return;

    box.removeAttribute('hovered');

    manager._setMultiSelect(event.ctrlKey || event.metaKey);
    manager.selectLayout(box);
    manager._setMultiSelect(false);
  }

  // ─── Double-Click Handling ─────────────────────────────────────

  /**
   * 더블클릭 이벤트 핸들러.
   *
   * paragraph 위에서 더블클릭 시 현재 모드에 상관없이 텍스트 편집 모드로 전환하고
   * 해당 paragraph에 포커스를 부여한다. 삽입 모드이거나 편집 가능하지 않은
   * paragraph(예: lock된 box 내부)에서는 무시한다.
   *
   * 동작 순서:
   * 1. 삽입 모드(`insertMode`)이면 무시한다.
   * 2. `composedPath()`에서 `LayoutParagraphElement`를 찾는다.
   * 3. `EditManager.textEditMode = true`로 설정하여 다른 모드를 모두 끄고
   *    문서 전체의 paragraph 편집 가능 여부를 갱신한다.
   * 4. `EditManager.focusParagraph(paragraph)`로 해당 paragraph에 포커스를 준다.
   *    이 호출은 `editableText = true` 설정과 `TextEditController` 생성을
   *    내부적으로 수행한다.
   * 5. 더블클릭한 위치의 소스 오프셋을 구하여 커서를 해당 위치로 이동한다.
   *    `TextEditController.getOffsetFromPoint()`로 뷰포트 좌표를 오프셋으로 변환 후
   *    `setCursor()`로 커서 위치를 설정한다.
   *
   * @param event - 더블클릭 마우스 이벤트
   */
  private _onDblClick = (event: MouseEvent): void => {
    const manager = this._manager;
    if (manager.insertMode) return;

    const paragraph = this._findParagraphFromEvent(event);
    if (!paragraph) return;

    event.stopPropagation();
    event.preventDefault();

    manager.textEditMode = true;
    manager.focusParagraph(paragraph);

    const controller = manager.focusedController;
    if (controller) {
      const offset = controller.getOffsetFromPoint(event.clientX, event.clientY);
      if (offset !== null) {
        controller.setCursor({ textOffset: offset });
      }
    }
  }

  // ─── Context Menu Handling ─────────────────────────────────────

  /**
   * 컨텍스트 메뉴(우클릭) 이벤트 핸들러.
   *
   * 선택 룰에 따라 우클릭한 요소의 선택 상태를 갱신한 뒤
   * `contextMenu` 이벤트를 `EditManager`를 통해 디스패치한다.
   *
   * 선택 룰:
   * 1. 이미 선택된 box에서 우클릭 → 기존 selection 유지 (멀티 선택 포함)
   * 2. 선택되지 않은 box 우클릭 → 기존 selection 해제 후 해당 box만 선택
   * 3. 빈 공간 우클릭 → selection 해제, element는 `null`
   * 4. document 영역에서 우클릭 (box 외부) → element는 document, selection은 빈 상태
   *
   * @param event - 컨텍스트 메뉴 마우스 이벤트
   */
  private _onContextMenu = (event: MouseEvent): void => {
    const manager = this._manager;

    const box = this._findSelectableBoxFromEvent(event);

    if (box) {
      const isSelected = manager.selectedLayouts.includes(box);
      if (!isSelected) {
        manager.clearLayoutSelection(false);
        manager.selectLayout(box);
      }
    } else {
      const isInsideDocument = event.composedPath().some(
        (el) => el instanceof LayoutDocumentElement
      );
      if (isInsideDocument) {
        manager.clearLayoutSelection(false);
      } else {
        return;
      }
    }

    const docElement = event.composedPath().find(
      (el) => el instanceof LayoutDocumentElement
    ) as LayoutDocumentElement | undefined;

    const element = box ?? docElement ?? null;

    manager._dispatchContextMenu({
      element,
      mouseX: event.clientX,
      mouseY: event.clientY,
      selectedLayouts: [...manager.selectedLayouts],
    });
  }
}