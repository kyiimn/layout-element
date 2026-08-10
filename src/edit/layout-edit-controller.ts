import { Z_INDEX_MAX_LAYOUT, Z_INDEX_ROLE_AD, Z_INDEX_ROLE_HEADER } from "@/constants";
import { BoxPosition } from "@/types";
import { LayoutBoxElement } from "@/components/layout/box.element";
import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import { LayoutImageElement } from "@/components/layout/image.element";
import { LayoutDocumentElement } from "@/components/layout/document.element";
import { LayoutTableCellElement } from "@/components/layout/td.element";
import { LayoutTableElement } from "@/components/layout/table.element";
import { genUUID } from "@/utils";
import { EditManager } from "./edit-manager";
import type { GridCalculator } from "@/core";
import type { BoxData } from "@/types/layout/box.type";
import type { TableCellSelection, CellCoord } from "@/types";

/**
 * 자석(Snap) 기능의 임계값 (단위: 화면 픽셀).
 *
 * absolute box를 드래그/리사이즈 중 부모 그리드의 컬럼/라인 경계에 이 값보다 가까이
 * 접근하면 해당 경계로 흡착한다. `EditManager.screenPxToMm()`을 통해 mm로 환산하여
 * 비교한다. 스냅은 `EditManager.snapEnabled`로 토글한다 (기본값: 활성).
 * Shift 키는 스냅 토글이 아니라 비례 제한(리사이즈)/수평수직 제한(이동)으로 동작한다.
 *
 * 값 조정 시 이 상수만 변경하면 된다.
 */
const SNAP_THRESHOLD_PX = 10;

/**
 * 드래그 이동 중 box별 상태를 보관하는 인터페이스.
 *
 * `LayoutEditController`는 각 box의 드래그 상태를 `Map<LayoutBoxElement, BoxDragState>`로 관리한다.
 * box 인스턴스 자체는 드래그 상태를 보관하지 않는다 (이관 전 box.element.ts의 private 필드를 대체).
 */
interface BoxDragState {
  /** 현재 드래그 중인지 여부 */
  isDragging: boolean;
  /** 드래그 임계값(3px)을 넘어 실제로 이동이 발생했는지 여부. 클릭과 드래그를 구분한다 */
  dragMoved: boolean;
  /**
   * mousedown 시점에 box가 이미 선택되어 있었는지 여부.
   * mouseup 단순 클릭 분기에서 selectLayout 중복 호출을 막기 위한 플래그.
   * - `true`: mousedown에서 selectLayout을 호출하지 않았으므로 mouseup에서
   *   토글/축소 동작을 처리해야 한다.
   * - `false`: mousedown에서 selectLayout을 호출하여 box를 선택했으므로
   *   mouseup에서 다시 호출하면 안 된다 (이벤트 중복).
   */
  wasSelectedOnMouseDown: boolean;
  /** 드래그 시작 시점의 마우스 X 좌표 (clientX) */
  startMouseX: number;
  /** 드래그 시작 시점의 마우스 Y 좌표 (clientY) */
  startMouseY: number;
  /** 드래그 시작 시점의 box left 값 (static: 컬럼 인덱스, absolute: mm) */
  startLeft: number;
  /** 드래그 시작 시점의 box top 값 (static: 라인 인덱스, absolute: mm) */
  startTop: number;
  /** 드래그 시작 시점의 원래 left 값. ESC 취소 시 복원에 사용 */
  originalLeft: number;
  /** 드래그 시작 시점의 원래 top 값. ESC 취소 시 복원에 사용 */
  originalTop: number;
  /** 드래그 시작 시점의 원래 width 값. ESC 취소 시 복원에 사용 */
  originalWidth: number;
  /** 드래그 시작 시점의 원래 height 값. ESC 취소 시 복원에 사용 */
  originalHeight: number;
  /** 드래그 시작 시점의 원래 position 모드. ESC 취소 시 복원에 사용 */
  originalPosition: BoxPosition;
  /** rAF 콜백에서 사용하는 최신 마우스 X 좌표. 빠른 마우스 이동 시 정확한 위치를 추적 */
  lastClientX: number;
  /** rAF 콜백에서 사용하는 최신 마우스 Y 좌표. 빠른 마우스 이동 시 정확한 위치를 추적 */
  lastClientY: number;
  /** requestAnimationFrame ID. 중복 rAF 스케줄링을 방지하기 위해 null 체크 */
  rafId: number | null;
  /** 드래그 시작 시 미리 수집된 영향받는 단락 집합. 드래그 종료 시 일괄 재렌더링에 사용 */
  affectedParagraphs: Set<LayoutParagraphElement> | null;
  /**
   * reparent 모드에서 부모 밖으로 나간 시점의 상태.
   * 부모 안에서는 box.left/top으로 이동하고, 부모 밖으로 나가면
   * box.left/top을 클램핑 위치로 고정하고 transform으로 추가 이동.
   * null이면 아직 부모 안에 있음.
   */
  reparentOutside: {
    /** 부모 밖 진입 시점의 마우스 clientX */
    mouseStartX: number;
    /** 부모 밖 진입 시점의 마우스 clientY */
    mouseStartY: number;
    /** 부모 밖 진입 시점의 box left (클램핑된 위치) */
    left: number;
    /** 부모 밖 진입 시점의 box top (클램핑된 위치) */
    top: number;
  } | null;
  /**
   * 최신 mousemove 이벤트의 Shift 키 누름 상태.
   * `true`이면 이동 시 주축(수평/수직) 제한, 리사이즈 시 비례 제한(코너 핸들)으로 동작한다.
   * rAF 콜백에서 읽기 위해 state에 보관한다.
   */
  shiftKey: boolean;
  /**
   * Shift 누름 중 이동 제한을 위한 고정 축. `null`이면 미결정.
   * 드래그 시작 후 유의미한 이동이 처음 감지된 시점에 한 번 결정되며,
   * 드래그 종료 시까지 유지된다 (사용자가 의도치 않게 축이 전환되는 현상 방지).
   */
  lockAxis: 'x' | 'y' | null;
}

/**
 * 리사이즈 중 box별 상태를 보관하는 인터페이스.
 *
 * `LayoutEditController`는 각 box의 리사이즈 상태를 `Map<LayoutBoxElement, BoxResizeState>`로 관리한다.
 */
interface BoxResizeState {
  /** 현재 리사이즈 중인지 여부 */
  isResizing: boolean;
  /** 리사이즈 핸들 방향. null이면 비활성. 코너 핸들(nw/ne/sw/se)은 absolute box만 지원. */
  handle: 'top' | 'bottom' | 'left' | 'right' | 'nw' | 'ne' | 'sw' | 'se' | null;
  /** 리사이즈 임계값(3px)을 넘어 실제로 크기 변경이 발생했는지 여부 */
  moved: boolean;
  /** 리사이즈 시작 시점의 마우스 X 좌표 (clientX) */
  startMouseX: number;
  /** 리사이즈 시작 시점의 마우스 Y 좌표 (clientY) */
  startMouseY: number;
  /** 리사이즈 시작 시점의 box left 값 */
  startLeft: number;
  /** 리사이즈 시작 시점의 box top 값 */
  startTop: number;
  /** 리사이즈 시작 시점의 box width 값. ESC 취소 시 복원에 사용 */
  startWidth: number;
  /** 리사이즈 시작 시점의 box height 값. ESC 취소 시 복원에 사용 */
  startHeight: number;
  /** rAF 콜백에서 사용하는 최신 마우스 X 좌표 */
  lastClientX: number;
  /** rAF 콜백에서 사용하는 최신 마우스 Y 좌표 */
  lastClientY: number;
  /** requestAnimationFrame ID */
  rafId: number | null;
  /** 리사이즈 시작 시 미리 수집된 영향받는 단락 집합 */
  affectedParagraphs: Set<LayoutParagraphElement> | null;
  /**
   * 최신 mousemove 이벤트의 Shift 키 누름 상태.
   * `true`이면 코너 핸들 리사이즈 시 가로세로 비율을 유지(비례 제한)한다.
   * rAF 콜백에서 읽기 위해 state에 보관한다.
   */
  shiftKey: boolean;
}

/**
 * `BoxDragState`의 기본값으로 채워진 인스턴스를 생성한다.
 *
 * @returns 모든 필드가 초기화된 `BoxDragState`
 */
function createDragState(): BoxDragState {
  return {
    isDragging: false,
    dragMoved: false,
    wasSelectedOnMouseDown: false,
    startMouseX: 0,
    startMouseY: 0,
    startLeft: 0,
    startTop: 0,
    originalLeft: 0,
    originalTop: 0,
    originalWidth: 0,
    originalHeight: 0,
    originalPosition: 'static',
    lastClientX: 0,
    lastClientY: 0,
    rafId: null,
    affectedParagraphs: null,
    reparentOutside: null,
    shiftKey: false,
    lockAxis: null,
  };
}

/**
 * `BoxResizeState`의 기본값으로 채워진 인스턴스를 생성한다.
 *
 * @returns 모든 필드가 초기화된 `BoxResizeState`
 */
function createResizeState(): BoxResizeState {
  return {
    isResizing: false,
    handle: null,
    moved: false,
    startMouseX: 0,
    startMouseY: 0,
    startLeft: 0,
    startTop: 0,
    startWidth: 0,
    startHeight: 0,
    lastClientX: 0,
    lastClientY: 0,
    rafId: null,
    affectedParagraphs: null,
    shiftKey: false,
  };
}

/**
 * 레이아웃 편집 컨트롤러.
 *
 * `EditManager.layoutEditMode`가 활성화되면 문서 레벨에서 마우스 이벤트를 위임받아
 * 편집 가능한 box의 **드래그 이동**, **리사이즈**, **선택**을 처리한다.
 *
 * ## 아키텍처
 *
 * 기존에는 각 `LayoutBoxElement` 인스턴스가 자체적으로 이벤트 리스너를 등록하고
 * 드래그/리사이즈 상태를 private 필드로 보관했다. 이 컨트롤러는 그 책임을
 * 문서 레벨의 단일 리스너로 중앙화한다.
 *
 * - **이벤트 위임**: `mousedown`과 `click`을 capture phase로 문서 요소(`LayoutDocumentElement`)에 등록한다.
 *   `composedPath()`를 통해 shadow DOM 내부의 box까지 추적할 수 있다.
 * - **상태 분리**: 각 box의 드래그/리사이즈 상태는 `Map<LayoutBoxElement, BoxDragState>` /
 *   `Map<LayoutBoxElement, BoxResizeState>`로 관리된다. box 인스턴스 자체는 상태를 보관하지 않는다.
 * - **hover 처리**: hover는 box 자체의 `mouseenter`/`mouseleave` 리스너로 유지된다
 *   (이벤트가 버블링되지 않으므로 위임이 불가능하기 때문).
 *
 * @example
 * ```ts
 * const manager = this._manager;
 * manager.setEditableRoles(['body', 'title']);
 * manager.layoutEditMode = true;
 * // → LayoutEditController가 attach()되어 편집 가능한 box의 드래그/리사이즈를 처리
 * ```
 */
export class LayoutEditController {
  /** 이벤트 리스너가 등록되는 루트 요소 (문서 요소 `LayoutDocumentElement`) */
  private _document: HTMLElement;
  /** 이 컨트롤러가 속한 EditManager 인스턴스 */
  private _manager: EditManager;
  /** 컨트롤러 활성화 여부. `attach()`/`detach()`로 토글된다 */
  private _attached = false;

  /** box별 드래그 상태 맵. 키는 box 요소, 값은 해당 box의 드래그 세션 상태 */
  private _dragStates = new Map<LayoutBoxElement, BoxDragState>();
  /** box별 리사이즈 상태 맵. 키는 box 요소, 값은 해당 box의 리사이즈 세션 상태 */
  private _resizeStates = new Map<LayoutBoxElement, BoxResizeState>();

  /** 현재 드래그가 진행 중인 box. `null`이면 드래그 중이 아니다 */
  private _activeDragBox: LayoutBoxElement | null = null;
  /** 현재 리사이즈가 진행 중인 box. `null`이면 리사이즈 중이 아니다 */
  private _activeResizeBox: LayoutBoxElement | null = null;

  /**
   * reparent 모드 드래그 중 현재 하이라이트된 컨테이너.
   * `null`이면 하이라이트 없음. 커서가 새 컨테이너로 이동하면 이전 하이라이트를 제거하고
   * 새 컨테이너에 `reparent-target` 속성을 설정한다.
   */
  private _reparentHighlightTarget: LayoutBoxElement | LayoutDocumentElement | LayoutTableCellElement | null = null;

  /**
   * @param doc - 이벤트 리스너가 등록될 루트 HTMLElement
   * @param manager - 이 컨트롤러가 속한 EditManager 인스턴스
   */
  constructor(doc: HTMLElement, manager: EditManager) {
    this._document = doc;
    this._manager = manager;
  }

  /**
   * 컨트롤러를 활성화하여 문서 레벨 이벤트 리스너를 등록한다.
   *
   * `mousedown`과 `click`을 capture phase(`true`)로 등록하여
   * box의 shadow DOM 내부에서 발생한 이벤트도 먼저 가로챌 수 있도록 한다.
   * 이미 활성화된 경우(`_attached === true`) 중복 등록을 방지한다.
   */
  attach(): void {
    if (this._attached) return;
    this._attached = true;
    this._document.addEventListener('mousedown', this._onMouseDown, true);
  }

  /**
   * 컨트롤러를 비활성화하고 리스너를 제거한다.
   *
   * 진행 중인 드래그/리사이즈 세션을 모두 취소하고,
   * 등록된 document 레벨 이벤트 리스너를 해제한다.
   */
  detach(): void {
    if (!this._attached) return;
    this._attached = false;
    this._document.removeEventListener('mousedown', this._onMouseDown, true);
    this._cancelAllDrags();
  }

  /**
   * 컨트롤러를 완전히 파괴한다. `detach()`와 동일하다.
   */
  destroy(): void {
    this.detach();
  }

  // ─── Event Detection Helpers ──────────────────────────────────

  /**
   * 특정 box가 레이아웃 편집 가능한지 판별한다.
   *
   * `EditManager.isBoxEditable()` 결과와 box의 `editableLayout` 속성을
   * OR 연산하여 기존 API(`box.editableLayout = true`)와 새 API(`layoutEditMode`)를
   * 모두 지원한다.
   *
   * @param box - 판별할 box 요소
   * @returns 편집 가능 여부
   */
  private _isBoxEditable(box: LayoutBoxElement): boolean {
    const manager = this._manager;
    if (this._isBoxOrAncestorLocked(box)) return false;
    if (!this._isWithinEditableRoot(box)) return false;
    return manager.isBoxEditable(box) || box.editableLayout;
  }

  /**
   * box 자체 또는 조상 box 중 lock이 설정된 것이 있는지 확인한다.
   */
  private _isBoxOrAncestorLocked(box: LayoutBoxElement): boolean {
    let current: LayoutBoxElement | null = box;
    while (current) {
      if (current.lock) return true;
      current = current.parentElement instanceof LayoutBoxElement ? current.parentElement : null;
    }
    return false;
  }

  /**
   * box가 편집 루트 내부에 있는지 확인한다.
   * 루트가 지정되지 않았거나 box가 루트의 자손이면 true, 루트 자체이거나 외부이면 false.
   */
  private _isWithinEditableRoot(box: LayoutBoxElement): boolean {
    const rootId = this._manager.editableRootId;
    if (rootId === null) return true;
    if (box.id === rootId) return false;
    let current: Element | null = box.parentElement;
    while (current) {
      if (current.id === rootId) return true;
      current = current.parentElement;
    }
    return false;
  }

  /**
   * 이벤트가 box의 자손(후손) box에서 발생했는지 판별한다.
   *
   * 중첩된 box 구조에서 자식 box를 클릭할 때 부모 box까지 함께 선택되거나
   * 드래그되는 것을 방지하기 위해 사용된다.
   *
   * `composedPath()`를 순회하며:
   * - `box` 자신이 나오면 `false` (이벤트가 box에서 직접 발생)
   * - box 이전에 편집 가능한 자손 box가 나오면 `true` (자손에서 발생)
   *
   * @param event - 마우스 이벤트
   * @param box - 기준이 되는 box 요소
   * @returns 자손 box에서 발생한 이벤트이면 `true`
   */
  private _isEventFromDescendantLayout(event: MouseEvent, box: LayoutBoxElement): boolean {
    const path = event.composedPath();
    for (const el of path) {
      if (el === box) return false;
      if (el instanceof LayoutBoxElement && this._isBoxEditable(el)) return true;
    }
    return false;
  }

  /**
   * 이벤트가 리사이즈 핸들에서 발생했는지 판별한다.
   *
   * `composedPath()`를 순회하며 `resize-handle` 클래스를 가진 요소가
   * box 자신보다 먼저 나오면 리사이즈 핸들에서 발생한 이벤트이다.
   *
   * @param event - 마우스 이벤트
   * @param box - 기준이 되는 box 요소
   * @returns 리사이즈 핸들에서 발생한 이벤트이면 `true`
   */
  private _isEventFromResizeHandle(event: MouseEvent, box: LayoutBoxElement): boolean {
    for (const el of event.composedPath()) {
      if (el instanceof HTMLElement && el.classList.contains('resize-handle')) return true;
      if (el === box) return false;
    }
    return false;
  }

  /**
   * 이벤트가 타입 라벨의 상위 선택 버튼(.parent-btn)에서 발생했는지 판별한다.
   *
   * `composedPath()`를 순회하며 `parent-btn` 클래스를 가진 요소가 나오면
   * 상위 선택 버튼 클릭이다. `parent-btn`은 `<x-layout-box>` shadow DOM 내부에
   * 있으므로 box 자신이 나오기 전에 매치된다.
   *
   * mousedown에서 `_startDrag`로 진입하면 box의 click 핸들러(`_selectParent`)가
   * 실행되지 않으므로, mousedown 단계에서 미리 감지하여 처리를 건너뛴다.
   *
   * @param event - 마우스 이벤트
   * @returns 상위 선택 버튼에서 발생한 이벤트이면 `true`
   */
  private _isEventFromParentBtn(event: MouseEvent): boolean {
    for (const el of event.composedPath()) {
      if (el instanceof HTMLElement && el.classList.contains('parent-btn')) return true;
    }
    return false;
  }

  // ─── Click Handling ───────────────────────────────────────────

  // ─── Mouse Down (Drag Start + Resize Handle) ─────────────────

  /**
   * mousedown 이벤트 핸들러.
   *
   * 편집 가능한 box에서 발생한 mousedown을 드래그 시작 또는 리사이즈 시작으로 분기한다.
   *
   * 처리 순서:
   * 1. 편집 가능한 box를 찾지 못하면 무시
   * 2. 삽입 모드이면 `EditManager.handleInsertMouseDown()`로 위임
   * 3. 좌클릭(button 0)이 아니면 무시
   * 4. 리사이즈 핸들에서 발생했으면 `_startResize()` 호출
   * 5. 자손 box에서 발생했으면 무시 (자손이 자체 처리)
   * 6. 타입 라벨의 상위 선택 버튼(.parent-btn)에서 발생했으면 무시
   *    (box 자체의 click 핸들러가 부모 박스 선택을 처리한다. mousedown을 막으면
   *    mouseup의 단순 클릭 분기가 selectLayout을 호출해 부모 선택을 덮어쓰게 된다)
   * 7. 그 외의 경우 `_startDrag()` 호출
   *
   * @param event - mousedown 마우스 이벤트
   */
  private _onMouseDown = (event: MouseEvent): void => {
    if (event.altKey) event.preventDefault();

    for (const el of event.composedPath()) {
      if (el instanceof HTMLElement && el.classList.contains('table-resize-handle')) {
        return;
      }
    }

    const path = event.composedPath();
    const tableEl = path.find((el) => el instanceof LayoutTableElement) as LayoutTableElement | undefined;
    if (tableEl) {
      const kc = tableEl.keyboardController;
      // reparent 모드에서는 셀 블록 처리를 건너뛰고 TD 내부 box의 reparent drag로 진행한다.
      if (kc?.selection && this._manager.layoutEditType !== 'reparent') {
        const tdEl = path.find((el) => el instanceof LayoutTableCellElement) as LayoutTableCellElement | undefined;
        if (!tdEl) {
          kc.selection = null;
          (tableEl as unknown as { _renderSelectionOverlay: (sel: null) => void })._renderSelectionOverlay(null);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (tdEl.cellLabel) {
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
            if (box) this._manager.selectLayout(box);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
      }
    }

    const box = this._findEditableBoxFromEvent(event);
    if (!box) return;
    const manager = this._manager;
    if (manager.placeGunActive) return;
    if (manager.insertMode) {
      manager.handleInsertMouseDown(event);
      return;
    }
    if (event.button !== 0) return;

    if (this._isEventFromResizeHandle(event, box)) {
      this._startResize(event, box);
      return;
    }
    if (this._isEventFromDescendantLayout(event, box)) return;

    // 타입 라벨의 상위 선택 버튼(.parent-btn) 클릭은 mousedown 처리를 건너뛴다.
    // box의 shadow DOM 내부에 등록된 click 핸들러가 부모 박스 선택을 처리한다.
    // mousedown에서 _startDrag로 진입하면 preventDefault()가 click 이벤트를
    // 발생시키지 않게 만들 수 있고, mouseup의 단순 클릭 분기에서 selectLayout이
    // 호출되어 부모 선택을 덮어쓸 수 있다.
    if (this._isEventFromParentBtn(event)) {
      event.stopPropagation();
      return;
    }

    if (event.altKey) {
      const clonedBox = this._cloneBoxForAltDrag(box);
      if (clonedBox) {
        this._startDrag(event, clonedBox);
        return;
      }
    }

    this._startDrag(event, box);
  }

  /**
   * Alt+드래그용으로 박스(및 다중 선택된 형제 박스들)를 복제한다.
   *
   * 클릭한 박스가 미선택 상태면 먼저 단일 선택으로 전환한 뒤,
   * 선택된 모든 최상위 박스를 동일한 부모 내에 복제한다.
   * 복제본은 새 ID, 새 z-index(형제 최대 + 1)를 가지며,
   * 원본은 유지되고 복제본만 선택된다.
   *
   * @param box - 복제를 시작할 기준 box 요소
   * @returns 복제된 기준 box. 실패 시 `null`
   */
  private _cloneBoxForAltDrag(box: LayoutBoxElement): LayoutBoxElement | null {
    const manager = this._manager;
    const wasSelected = box.hasAttribute('selected');
    if (!wasSelected) {
      manager.selectLayout(box);
    }

    const targets = manager.getTopLevelDragTargets();
    if (targets.length === 0) return null;

    const clonedTargets: LayoutBoxElement[] = [];
    for (const target of targets) {
      const parent = target.parentElement;
      if (!(parent instanceof LayoutBoxElement) && !(parent instanceof LayoutDocumentElement)) continue;
      const data = target.data;
      const siblings = Array.from(parent.children).filter(
        (c): c is LayoutBoxElement => c instanceof LayoutBoxElement && c !== target,
      );
      const maxZ = siblings
        .filter((c) => !c.lock && (c.zIndex ?? 0) < Z_INDEX_MAX_LAYOUT)
        .reduce((max, c) => Math.max(max, c.zIndex ?? 0), 0);
      const newData: BoxData = {
        ...data,
        id: genUUID(),
        zIndex: Math.min(maxZ + 1, Z_INDEX_MAX_LAYOUT),
      };
      const created = parent.appendChildData(newData);
      if (created instanceof LayoutBoxElement) {
        clonedTargets.push(created);
        manager._dispatchLayoutAdd({
          element: created,
          container: parent,
          source: 'insert',
        });
      }
    }

    if (clonedTargets.length === 0) return null;

    manager.clearLayoutSelection(false);
    manager._setMultiSelect(true);
    for (const cloned of clonedTargets) {
      manager.selectLayout(cloned);
    }
    manager._setMultiSelect(false);

    const originalBox = clonedTargets[targets.indexOf(box)] ?? clonedTargets[0]!;
    return originalBox;
  }

  // ─── Drag (Move) ──────────────────────────────────────────────

  /**
   * 드래그 이동을 시작한다.
   *
   * mousedown이 발생한 box의 드래그 상태를 초기화하고,
   * 다중 선택된 모든 box의 시작 위치를 기록한다.
   *
   * **선택 상태는 mousedown 시점에 box의 선택 상태에 따라 다르게 처리된다:**
   * - **미선택 box** (`!box.hasAttribute('selected')`): 즉시 `EditManager.selectLayout(box)`을
   *   호출하여 그 box를 단일 선택(Ctrl/Meta가 눌려있으면 multi-select 모드로 추가)으로
   *   전환한다. 이후 `_startLayoutDrag()`가 `getTopLevelDragTargets()`로 필터링할 때 이
   *   box만 drag 대상이 되어, 기존 선택된 box들은 그대로 유지된다.
   *   ("선택 안 된 요소를 끌면 그것만 선택되고 기존 선택은 해제되고 그것만 이동")
   *   또는 ("Ctrl+드래그로 미선택 box를 다중 선택에 추가하고 그것만 이동")
   * - **이미 선택된 box**: selectLayout을 호출하지 않음. 다중 선택 그룹의 일부일 수
   *   있으므로 선택을 유지한다. drag 시 `getTopLevelDragTargets()`로 필터된 최상위
   *   box만 이동. ("다중 선택 그룹의 자식 box를 끌어도 조상만 이동")
   *
   * mouseup 시점의 동작:
   * - 단순 클릭 (`!state.dragMoved`): `state.wasSelectedOnMouseDown`에 따라 분기.
   *   - `false` (mousedown에서 selectLayout 호출됨): mouseup에서 추가 작업 없음 (중복 방지)
   *   - `true` (mousedown에서 selectLayout 미호출): 다중 선택 축소 또는 Ctrl+클릭 토글
   * - 드래그 (`state.dragMoved === true`): selectLayout 호출 없음. mousedown 시점에
   *   결정된 선택 상태 유지.
   *
   * 처리 순서:
   * 1. box의 `BoxDragState`를 가져오거나 생성
   * 2. event.preventDefault() / event.stopPropagation() / hover 속성 제거
   * 3. 미선택 box이면 `EditManager.selectLayout(box)` 호출 (Ctrl/Meta이면 multi-select)
   * 4. `BoxDragState.wasSelectedOnMouseDown` 캡처, isDragging/dragMoved 초기화
   * 5. 마우스 시작 좌표, box 시작 위치, 원래 위치 기록
   * 6. 커서를 `grabbing`으로 변경
   * 7. `EditManager._startLayoutDrag()` 호출로 다중 선택 드래그 대상 설정
   * 8. 영향받는 단락 수집 (드래그 종료 시 일괄 재렌더링용)
   * 9. 다중 선택된 모든 box의 시작 위치를 각각의 `BoxDragState`에 기록
   * 10. document 레벨에 `mousemove`, `mouseup`, `keydown` 리스너 등록
   *
   * @param event - mousedown 이벤트
   * @param box - 드래그를 시작할 box 요소
   */
  private _startDrag(event: MouseEvent, box: LayoutBoxElement): void {
    const manager = this._manager;
    let state = this._dragStates.get(box);
    if (!state) {
      state = createDragState();
      this._dragStates.set(box, state);
    }

    event.preventDefault();
    event.stopPropagation();
    box.removeAttribute('hovered');

    // 미선택 box를 mousedown한 경우, 즉시 그 box만 단일 선택으로 전환한다.
    // 이후 _startLayoutDrag()가 getTopLevelDragTargets()로 필터링할 때
    // 이 box만 drag 대상이 되어, 기존 선택된 box들은 그대로 유지된다.
    // ("선택 안 된 요소를 끌면 그것만 선택되고 기존 선택은 해제되고 그것만 이동")
    // 이미 선택된 box는 다중 선택 그룹의 일부일 수 있으므로 선택을 유지한다.
    // Ctrl/Meta가 눌려있으면 multi-select 모드로 호출하여 추가한다.
    // ("Ctrl+클릭으로 미선택 box를 다중 선택에 추가")
    const wasSelected = box.hasAttribute('selected');
    if (!wasSelected) {
      const isCtrlClick = event.ctrlKey || event.metaKey;
      manager._setMultiSelect(isCtrlClick);
      manager.selectLayout(box);
      manager._setMultiSelect(false);
    }

    // 드래그 상태 초기화. mousedown 시점의 box 선택 상태를 캡처하여
    // mouseup의 단순 클릭 분기에서 selectLayout 중복 호출을 막는다.
    state.isDragging = true;
    state.dragMoved = false;
    state.wasSelectedOnMouseDown = wasSelected;
    state.lockAxis = null;
    state.startMouseX = event.clientX;
    state.startMouseY = event.clientY;
    state.startLeft = box.left;
    state.startTop = box.top;
    state.originalLeft = box.left;
    state.originalTop = box.top;
    state.originalWidth = box.width;
    state.originalHeight = box.height;
    state.originalPosition = box.position;
    state.lastClientX = event.clientX;
    state.lastClientY = event.clientY;
    box.style.cursor = 'grabbing';

    // EditManager에 드래그 시작을 알리고, 다중 선택된 box들을 드래그 대상으로 설정
    manager._startLayoutDrag();
    // 시작 시점의 box 부모 좌표계 AABB를 캡처하여 _collectAffectedParagraphs의
    // AABB union 비교에 사용한다. move 모드에서 이동 전/후 위치와 교차하는
    // 형제 box만 재렌더링 대상이 된다.
    const startRect = this._getRectInParent(box);
    state.affectedParagraphs = this._collectAffectedParagraphs(box, startRect);

    // 다중 선택된 모든 box의 시작 위치를 각각의 BoxDragState에 기록.
    // 이 값들은 _onMouseMove에서 각 box를 독립적으로 이동시킬 때 사용된다.
    const dragTargets = manager._getDragTargets();
    for (const target of dragTargets) {
      if (target === box) continue;
      const targetState = this._getOrCreateDragState(target);
      targetState.startLeft = target.left;
      targetState.startTop = target.top;
      targetState.originalLeft = target.left;
      targetState.originalTop = target.top;
      targetState.originalWidth = target.width;
      targetState.originalHeight = target.height;
      targetState.originalPosition = target.position;
    }

    this._activeDragBox = box;
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('keydown', this._onKeyDown);
  }

  /**
   * 드래그 중 mousemove 이벤트 핸들러.
   *
   * `requestAnimationFrame`으로 스로틀링하여 60fps 이내로 box 위치를 갱신한다.
   *
   * 처리 순서:
   * 1. 최신 마우스 좌표를 state에 저장 (rAF 콜백에서 사용)
   * 2. 3px 임계값을 넘으면 `dragMoved = true` (클릭과 드래그 구분)
   * 3. 임계값 미충족 또는 rAF가 이미 스케줄링 중이면 대기
   * 4. rAF 콜백에서:
   *    a. 활성 box(최상위 선택)의 새 위치 계산 및 적용
   *    b. 다중 선택된 다른 box들의 새 위치 계산 및 적용
   *
   * @param event - mousemove 마우스 이벤트
   */
  private _onMouseMove = (event: MouseEvent): void => {
    const box = this._activeDragBox;
    if (!box) return;
    const state = this._dragStates.get(box);
    if (!state || !state.isDragging) return;

    // 빠른 마우스 이동에도 정확한 위치를 추적하기 위해
    // rAF 콜백에서 읽을 수 있도록 최신 좌표를 state에 저장
    state.lastClientX = event.clientX;
    state.lastClientY = event.clientY;
    state.shiftKey = event.shiftKey;
    const deltaX = event.clientX - state.startMouseX;
    const deltaY = event.clientY - state.startMouseY;

    // 3px 임계값: 단순 클릭과 실제 드래그를 구분한다
    if (!state.dragMoved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
      state.dragMoved = true;
    }
    if (!state.dragMoved) return;
    // 중복 rAF 스케줄링 방지
    if (state.rafId !== null) return;

    state.rafId = requestAnimationFrame(() => {
      state.rafId = null;
      // rAF 콜백 실행 시점의 최신 마우스 좌표를 사용
      const dx = state.lastClientX - state.startMouseX;
      const dy = state.lastClientY - state.startMouseY;
      const manager = this._manager;
      const dragTargets = manager._getDragTargets();
      const isTopLevel = dragTargets.includes(box);

      // reparent 모드: 커서 위치의 컨테이너 하이라이트
      if (manager.layoutEditType === 'reparent') {
        this._updateReparentHighlight(box, state.lastClientX, state.lastClientY);
      }

      // 활성 box(최상위 선택) 위치 갱신
      if (isTopLevel) {
        if (manager.layoutEditType === 'reparent') {
          this._applyReparentDragMove(box, dx, dy, state);
        } else {
          const result = this._computeNewPosition(box, dx, dy, state.startLeft, state.startTop);
          if (result.converted) {
            this._applyPositionConversion(box, result.converted.position, result.converted.left, result.converted.top, result.converted.width, result.converted.height);
            state.startLeft = result.converted.left;
            state.startTop = result.converted.top;
            state.startMouseX = state.lastClientX;
            state.startMouseY = state.lastClientY;
          } else {
            if (box.left !== result.left) box.left = result.left;
            if (box.top !== result.top) box.top = result.top;
          }
        }
      }

      // 다중 선택된 다른 box들도 동일한 delta만큼 이동
      for (const target of dragTargets) {
        if (target === box) continue;
        const targetState = this._getOrCreateDragState(target);
        if (manager.layoutEditType === 'reparent') {
          this._applyReparentDragMove(target, dx, dy, targetState);
        } else {
          const result = this._computeNewPosition(target, dx, dy, targetState.startLeft, targetState.startTop);
          if (result.converted) {
            this._applyPositionConversion(target, result.converted.position, result.converted.left, result.converted.top, result.converted.width, result.converted.height);
            targetState.startLeft = result.converted.left;
            targetState.startTop = result.converted.top;
          } else {
            if (result.left !== target.left) target.left = result.left;
            if (result.top !== target.top) target.top = result.top;
          }
        }
      }
    });
  }

  /**
   * 드래그 종료(mouseup) 이벤트 핸들러.
   *
   * 드래그를 완료하고 최종 위치를 확정한다.
   *
   * 처리 순서:
   * 1. document 레벨 리스너 제거
   * 2. 대기 중인 rAF 취소
   * 3. 영향받는 단락 일괄 재렌더링 (텍스트 회피 적용)
   * 4. 커서를 `grab`으로 복원
   * 5. **단순 클릭** (`!state.dragMoved`): `state.wasSelectedOnMouseDown`이 true이면
   *    다중 선택 축소 또는 Ctrl+클릭 토글을 위해 `EditManager.selectLayout(box)`을
   *    호출할 수 있다. false이면 mousedown에서 이미 selectLayout이 호출되었으므로
   *    추가 작업이 없다. 이후 `_suppressLayoutClick()`으로 후속 click을 차단하고
   *    `_endLayoutDrag()`로 종료.
   * 6. **드래그** (`state.dragMoved === true`): `_suppressLayoutClick()`으로 후속
   *    click을 차단한 뒤, `_computeNewPosition()` 또는 `_tryReparent()`로 최종 위치를
   *    확정한다. 다중 선택 drag 대상이 있으면 각 box에 대해 동일한 처리를 한다.
   * 7. `EditManager._dispatchLayoutMove()`로 이동 이벤트 발생 (각 drag 대상에 대해)
   * 8. `_endLayoutDrag()`로 드래그 세션 종료
   *
   * @param event - mouseup 마우스 이벤트
   */
  private _onMouseUp = (event: MouseEvent): void => {
    const box = this._activeDragBox;
    this._activeDragBox = null;
    if (!box) return;
    const state = this._dragStates.get(box);
    if (!state || !state.isDragging) return;

    event.stopPropagation();
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('keydown', this._onKeyDown);
    this._clearReparentHighlight();
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    state.isDragging = false;

    // 드래그 중 보류된 단락 재렌더링을 즉시 실행 (텍스트 회피 최종 적용)
    this._flushRerenderAffectedParagraphs(box, state);
    box.style.cursor = this._isBoxEditable(box) ? 'grab' : '';

    const manager = this._manager;

    // 드래그 이동이 없었으면 (임계값 미충족 = 단순 클릭)
    if (!state.dragMoved) {
      box.style.transform = '';
      // 단순 클릭 시에는 선택 상태를 갱신한다. mousedown에서 _startDrag가
      // 미선택 box에 대해 selectLayout을 이미 호출했을 수 있으므로, mouseup에서는
      // 그 결과를 덮어쓰지 않도록 wasSelectedOnMouseDown 플래그로 분기한다.
      //
      // - wasSelectedOnMouseDown === false (mousedown에서 selectLayout 호출됨):
      //     - 일반 클릭: mousedown에서 단일 선택으로 전환됨. mouseup에서는 추가 작업 없음
      //     - Ctrl/Meta 클릭: mousedown에서 multi-select 모드로 추가됨. mouseup에서는 추가 작업 없음
      // - wasSelectedOnMouseDown === true (mousedown에서 selectLayout 호출 안 함):
      //     - 일반 클릭 + 다중 선택 그룹의 일부: 그것만 단일로 축소
      //     - 일반 클릭 + 단일 선택: 변화 없음
      //     - Ctrl/Meta 클릭: 그것만 선택 해제 (토글)
      //
      // 비편집 가능 box의 단순 클릭은 LayoutSelectionController가 click 이벤트로
      // 처리하지만, _startDrag가 attach된 상태(편집 모드)에서는 mousedown이 가로채져
      // mouseup에서 직접 처리해야 한다. 후속 click이 발생해도 _suppressLayoutClick으로
      // 차단된다.
      if (state.wasSelectedOnMouseDown) {
        const isInMultiSelection = manager.selectedLayouts.length > 1;
        const isCtrlClick = event.ctrlKey || event.metaKey;
        if (isCtrlClick || isInMultiSelection) {
          manager._setMultiSelect(isCtrlClick);
          manager.selectLayout(box);
          manager._setMultiSelect(false);
        }
      }
      manager._suppressLayoutClick();
      manager._endLayoutDrag();
      return;
    }

    // 드래그 이동이 있었으면 후속 click 이벤트가 빈 영역 클릭으로
    // 처리되어 선택이 해제되는 것을 방지한다.
    manager._suppressLayoutClick();

    // 최종 위치 계산 및 적용
    const dragTargets = manager._getDragTargets();
    const isTopLevel = dragTargets.includes(box);
    const deltaX = event.clientX - state.startMouseX;
    const deltaY = event.clientY - state.startMouseY;

    if (isTopLevel) {
      const startLeft = state.startLeft;
      const startTop = state.startTop;
      const previousContainer = box.parentElement as HTMLElement | null;

      // reparent 모드: transform이 유지된 상태에서 _tryReparent 호출.
      // box의 left/top은 원래 값이고, transform으로 화면 이동한 상태이므로
      // getBoundingClientRect()가 transform 반영 위치를 반환 → 새 컨테이너 기준 좌표 계산.
      const reparentResult = manager.layoutEditType === 'reparent' && state.dragMoved
        ? this._tryReparent(box, event.clientX, event.clientY, state)
        : null;

      if (reparentResult) {
        // box가 제거되고 newBox로 교체됨 → 선택 갱신
        box.style.transform = '';
        manager.selectLayout(reparentResult.newBox);
        manager._dispatchLayoutMove(
          reparentResult.newBox, startLeft, startTop, reparentResult.newBox.left, reparentResult.newBox.top, false,
          reparentResult.container,
          previousContainer ?? undefined,
        );
      } else {
        // reparent 실패 (부모 변경 없음): transform 초기화 후 일반 move 처리
        box.style.transform = '';
        const result = this._computeNewPosition(box, deltaX, deltaY, state.startLeft, state.startTop);
        if (result.converted) {
          this._applyPositionConversion(box, result.converted.position, result.converted.left, result.converted.top, result.converted.width, result.converted.height);
        } else {
          if (box.left !== result.left) box.left = result.left;
          if (box.top !== result.top) box.top = result.top;
        }
        manager._dispatchLayoutMove(box, startLeft, startTop, box.left, box.top, false);
      }
    } else {
      box.style.transform = '';
    }

    // 다중 선택된 다른 box들의 최종 위치 확정 및 이동 이벤트 발생
    for (const target of dragTargets) {
      if (target === box) continue;
      const targetState = this._getOrCreateDragState(target);
      const targetPreviousContainer = target.parentElement as HTMLElement | null;

      const targetReparentResult = manager.layoutEditType === 'reparent' && targetState.dragMoved
        ? this._tryReparent(target, event.clientX, event.clientY, targetState)
        : null;

      if (targetReparentResult) {
        target.style.transform = '';
        manager.selectLayout(targetReparentResult.newBox);
        manager._dispatchLayoutMove(
          targetReparentResult.newBox, targetState.startLeft, targetState.startTop, targetReparentResult.newBox.left, targetReparentResult.newBox.top, false,
          targetReparentResult.container,
          targetPreviousContainer ?? undefined,
        );
      } else {
        target.style.transform = '';
        const result = this._computeNewPosition(target, deltaX, deltaY, targetState.startLeft, targetState.startTop);
        if (result.converted) {
          this._applyPositionConversion(target, result.converted.position, result.converted.left, result.converted.top, result.converted.width, result.converted.height);
        } else {
          if (result.left !== target.left) target.left = result.left;
          if (result.top !== target.top) target.top = result.top;
        }
        manager._dispatchLayoutMove(target, targetState.startLeft, targetState.startTop, target.left, target.top, false);
      }
    }

    manager._endLayoutDrag();
  }

  /**
   * 드래그 중 ESC 키 이벤트 핸들러.
   *
   * ESC 키 입력 시 드래그를 취소하고 box 위치를 원래 위치로 복원한다.
   *
   * 처리 순서:
   * 1. document 레벨 리스너 제거
   * 2. 대기 중인 rAF 취소
   * 3. 영향받는 단락 일괄 재렌더링
   * 4. 모든 드래그 대상 box의 위치를 `original*` 값으로 복원
   * 5. `_dispatchLayoutMove()`에 `canceled: true`로 취소 이벤트 발생
   * 6. `_endLayoutDrag()`로 드래그 세션 종료
   *
   * @param event - 키보드 이벤트
   */
  private _onKeyDown = (event: KeyboardEvent): void => {
    const box = this._activeDragBox;
    if (!box) return;
    const state = this._dragStates.get(box);
    if (!state || !state.isDragging) return;
    if (event.key !== 'Escape') return;

    // stopPropagation: 드래그 취소 ESC가 window keydown 리스너(호스트의 모드 전환)
    // 까지 전파되면 모드가 select로 빠지는 부작용이 발생한다. 동작 취소만 수행하고
    // 모드는 유지되어야 하므로 전파를 차단한다. InsertController._onKeyDown와 동일 정책.
    event.preventDefault();
    event.stopPropagation();
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('keydown', this._onKeyDown);
    this._clearReparentHighlight();
    state.isDragging = false;
    state.dragMoved = false;
    this._flushRerenderAffectedParagraphs(box, state);
    box.style.cursor = this._isBoxEditable(box) ? 'grab' : '';
    box.style.transform = '';

    const manager = this._manager;
    const dragTargets = manager._getDragTargets();
    const isTopLevel = dragTargets.includes(box);

    // 활성 box를 원래 위치로 복원
    if (isTopLevel) {
      this._applyPositionConversion(box, state.originalPosition, state.originalLeft, state.originalTop, state.originalWidth, state.originalHeight);
      manager._dispatchLayoutMove(box, state.originalLeft, state.originalTop, state.originalLeft, state.originalTop, true);
    }

    // 다중 선택된 다른 box들도 원래 위치로 복원
    for (const target of dragTargets) {
      if (target === box) continue;
      const targetState = this._getOrCreateDragState(target);
      this._applyPositionConversion(target, targetState.originalPosition, targetState.originalLeft, targetState.originalTop, targetState.originalWidth, targetState.originalHeight);
      manager._dispatchLayoutMove(target, targetState.originalLeft, targetState.originalTop, targetState.originalLeft, targetState.originalTop, true);
    }

    manager._endLayoutDrag();
    this._activeDragBox = null;
  }

  // ─── Resize ───────────────────────────────────────────────────

  /**
   * 리사이즈를 시작한다.
   *
   * 리사이즈 핸들에서 mousedown이 발생했을 때 호출된다.
   * 선택된 box만 리사이즈할 수 있다.
   *
   * 처리 순서:
   * 1. 삽입 모드이면 무시
   * 2. box가 선택되어 있지 않으면 무시
   * 3. 리사이즈 핸들 방향(top/bottom/left/right) 확인
   * 4. box의 `BoxResizeState`를 가져오거나 생성
   * 5. 마우스 시작 좌표, box 시작 위치/크기 기록
   * 6. `EditManager._startLayoutResize()` 호출
   * 7. 영향받는 단락 수집
   * 8. document 레벨에 `mousemove`, `mouseup`, `keydown` 리스너 등록
   *
   * @param event - mousedown 이벤트
   * @param box - 리사이즈를 시작할 box 요소
   */
  private _startResize(event: MouseEvent, box: LayoutBoxElement): void {
    const manager = this._manager;
    if (manager.insertMode) return;
    if (!box.hasAttribute('selected')) return;

    event.preventDefault();
    event.stopPropagation();

    const handle = this._getResizeHandle(event, box);
    if (!handle) return;

    let state = this._resizeStates.get(box);
    if (!state) {
      state = createResizeState();
      this._resizeStates.set(box, state);
    }

    // 리사이즈 상태 초기화
    state.isResizing = true;
    state.handle = handle;
    state.moved = false;
    state.startMouseX = event.clientX;
    state.startMouseY = event.clientY;
    state.startLeft = box.left;
    state.startTop = box.top;
    state.startWidth = box.width;
    state.startHeight = box.height;
    state.lastClientX = event.clientX;
    state.lastClientY = event.clientY;

    manager._startLayoutResize();
    // 시작 시점의 box 부모 좌표계 AABB를 캡처한다. 리사이즈도 move 모드와 동일하게
    // AABB union으로 형제 box 필터링이 가능하다 (resize는 box의 width/height 변경).
    const startRect = this._getRectInParent(box);
    state.affectedParagraphs = this._collectAffectedParagraphs(box, startRect);

    this._activeResizeBox = box;
    document.addEventListener('mousemove', this._onResizeMouseMove);
    document.addEventListener('mouseup', this._onResizeMouseUp);
    document.addEventListener('keydown', this._onResizeKeyDown);
  }

  /**
   * 리사이즈 중 mousemove 이벤트 핸들러.
   *
   * `requestAnimationFrame`으로 스로틀링하여 60fps 이내로 box 크기를 갱신한다.
   *
   * 처리 순서:
   * 1. 최신 마우스 좌표를 state에 저장
   * 2. 3px 임계값을 넘으면 `moved = true`
   * 3. 임계값 미충족 또는 rAF가 이미 스케줄링 중이면 대기
   * 4. rAF 콜백에서 `_computeNewSize()`로 새 크기/위치 계산 및 box에 적용
   *
   * @param event - mousemove 마우스 이벤트
   */
  private _onResizeMouseMove = (event: MouseEvent): void => {
    const box = this._activeResizeBox;
    if (!box) return;
    const state = this._resizeStates.get(box);
    if (!state || !state.isResizing) return;

    state.lastClientX = event.clientX;
    state.lastClientY = event.clientY;
    state.shiftKey = event.shiftKey;
    const deltaX = event.clientX - state.startMouseX;
    const deltaY = event.clientY - state.startMouseY;

    // 3px 임계값: 단순 클릭과 실제 리사이즈를 구분한다
    if (!state.moved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
      state.moved = true;
    }
    if (!state.moved) return;
    if (state.rafId !== null) return;

    state.rafId = requestAnimationFrame(() => {
      state.rafId = null;
      const dx = state.lastClientX - state.startMouseX;
      const dy = state.lastClientY - state.startMouseY;
      const { left, top, width, height } = this._computeNewSize(box, state, dx, dy);
      if (left !== box.left) box.left = left;
      if (top !== box.top) box.top = top;
      if (width !== box.width) box.width = width;
      if (height !== box.height) box.height = height;
    });
  }

  /**
   * 리사이즈 종료(mouseup) 이벤트 핸들러.
   *
   * 리사이즈를 완료하고 최종 크기를 확정한다.
   *
   * 처리 순서:
   * 1. document 레벨 리스너 제거
   * 2. 대기 중인 rAF 취소
   * 3. 영향받는 단락 일괄 재렌더링
   * 4. `EditManager._endLayoutResize()` 호출
   * 5. 리사이즈 이동이 없었으면(클릭만) 종료
   * 6. 최종 크기 계산 및 적용
   * 7. `_dispatchLayoutResize()`로 리사이즈 이벤트 발생
   *
   * @param event - mouseup 마우스 이벤트
   */
  private _onResizeMouseUp = (event: MouseEvent): void => {
    const box = this._activeResizeBox;
    this._activeResizeBox = null;
    if (!box) return;
    const state = this._resizeStates.get(box);
    if (!state || !state.isResizing) return;

    event.stopPropagation();
    document.removeEventListener('mousemove', this._onResizeMouseMove);
    document.removeEventListener('mouseup', this._onResizeMouseUp);
    document.removeEventListener('keydown', this._onResizeKeyDown);
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    state.isResizing = false;

    // 리사이즈 중 보류된 단락 재렌더링을 즉시 실행
    this._flushRerenderAffectedParagraphs(box, state);
    this._manager._endLayoutResize();

    // 리사이즈 이동이 없었으면 (임계값 미충족 = 단순 클릭)
    if (!state.moved) {
      state.handle = null;
      return;
    }

    // 리사이즈 이동이 있었으면 후속 click 이벤트가 빈 영역 클릭으로
    // 처리되어 선택이 해제되는 것을 방지한다.
    this._manager._suppressLayoutClick();

    // 최종 크기 계산 및 적용
    const deltaX = event.clientX - state.startMouseX;
    const deltaY = event.clientY - state.startMouseY;
    const { left, top, width, height } = this._computeNewSize(box, state, deltaX, deltaY);
    state.handle = null;
    if (left !== box.left) box.left = left;
    if (top !== box.top) box.top = top;
    if (width !== box.width) box.width = width;
    if (height !== box.height) box.height = height;

    this._manager._dispatchLayoutResize(
      box,
      state.startLeft, state.startTop, state.startWidth, state.startHeight,
      left, top, width, height,
      false,
    );
  }

  /**
   * 리사이즈 중 ESC 키 이벤트 핸들러.
   *
   * ESC 키 입력 시 리사이즈를 취소하고 box 크기를 원래 크기로 복원한다.
   *
   * 처리 순서:
   * 1. document 레벨 리스너 제거
   * 2. 대기 중인 rAF 취소
   * 3. 영향받는 단락 일괄 재렌더링
   * 4. box의 위치/크기를 `start*` 값으로 복원
   * 5. `_dispatchLayoutResize()`에 `canceled: true`로 취소 이벤트 발생
   *
   * @param event - 키보드 이벤트
   */
  private _onResizeKeyDown = (event: KeyboardEvent): void => {
    const box = this._activeResizeBox;
    if (!box) return;
    const state = this._resizeStates.get(box);
    if (!state || !state.isResizing) return;
    if (event.key !== 'Escape') return;

    // stopPropagation: 리사이즈 취소 ESC가 window keydown 리스너(호스트 모드 전환)까지
    // 전파되면 모드가 select로 빠진다. _onKeyDown(드래그 취소)과 동일 정책.
    event.preventDefault();
    event.stopPropagation();
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    document.removeEventListener('mousemove', this._onResizeMouseMove);
    document.removeEventListener('mouseup', this._onResizeMouseUp);
    document.removeEventListener('keydown', this._onResizeKeyDown);
    state.isResizing = false;
    state.handle = null;
    this._flushRerenderAffectedParagraphs(box, state);
    this._manager._endLayoutResize();

    // 원래 크기로 복원
    if (box.left !== state.startLeft) box.left = state.startLeft;
    if (box.top !== state.startTop) box.top = state.startTop;
    if (box.width !== state.startWidth) box.width = state.startWidth;
    if (box.height !== state.startHeight) box.height = state.startHeight;

    this._manager._dispatchLayoutResize(
      box,
      state.startLeft, state.startTop, state.startWidth, state.startHeight,
      state.startLeft, state.startTop, state.startWidth, state.startHeight,
      true,
    );
    this._activeResizeBox = null;
  }

  // ─── Position Calculation (migrated from box.element.ts) ──────

  /**
   * 픽셀 델타와 시작 위치를 받아 드래그 후의 새 위치를 계산한다.
   *
   * position 모드에 따라 다른 스냅/클램핑 규칙이 적용된다:
   *
   * - **absolute 모드 (문서 직계 자식)**: 클램핑 없이 자유 이동. 음수 좌표 허용.
   * - **absolute 모드 (다른 박스 안)**: 부모 편집 영역 내로 클램핑.
   * - **static 모드**: 컬럼/라인 스냅. 가장 가까운 컬럼 인덱스로 스냅하고
   *   편집 영역을 벗어나지 않도록 클램핑한다.
   *
   * @param box - 위치를 이동할 box 요소
   * @param deltaPxX - 마우스 가로 이동량 (픽셀)
   * @param deltaPxY - 마우스 세로 이동량 (픽셀)
   * @param startLeft - 드래그 시작 left 값. 생략 시 box의 `BoxDragState.startLeft` 사용
   * @param startTop - 드래그 시작 top 값. 생략 시 box의 `BoxDragState.startTop` 사용
   * @returns 새 위치 `{ left, top }`. `converted` 필드는 position 변환 시에만 존재
   */
  private _computeNewPosition(
    box: LayoutBoxElement,
    deltaPxX: number,
    deltaPxY: number,
    startLeft?: number,
    startTop?: number,
  ): { left: number; top: number; converted?: { position: BoxPosition; left: number; top: number; width: number; height: number } } {
    const state = this._dragStates.get(box);
    const sLeft = startLeft ?? (state ? state.startLeft : box.left);
    const sTop = startTop ?? (state ? state.startTop : box.top);
    const manager = this._manager;
    const deltaMmX = manager.screenDeltaToMm(deltaPxX);
    const deltaMmY = manager.screenDeltaToMm(deltaPxY);

    const isDocumentChild = box.parentElement?.type === 'document';

    if (box.position === 'absolute') {
      // Shift 누름 시 주축(수평/수직) 제한. 축은 첫 유의미 이동 시 한 번 결정되어
      // 드래그 종료 시까지 유지된다 (사용자 의도치 않은 축 전환 방지).
      let dxMm = deltaMmX;
      let dyMm = deltaMmY;
      if (state?.shiftKey) {
        if (state.lockAxis === null) {
          if (Math.abs(deltaMmX) >= 1 || Math.abs(deltaMmY) >= 1) {
            state.lockAxis = Math.abs(deltaMmX) >= Math.abs(deltaMmY) ? 'x' : 'y';
          }
        }
        if (state.lockAxis === 'x') dyMm = 0;
        else if (state.lockAxis === 'y') dxMm = 0;
      }
      // 문서 직계 자식 absolute 요소는 편집 영역 밖으로 자유롭게 이동 가능
      if (isDocumentChild) {
        const raw = { left: sLeft + dxMm, top: sTop + dyMm };
        if (!manager.snapEnabled) return raw;
        const snapped = this._snapAbsolutePosition(
          raw.left, raw.top, box.width, box.height, box.parentModel ?? null,
          manager.screenPxToMm(SNAP_THRESHOLD_PX),
        );
        return snapped;
      }

      // parentWidth/parentHeight는 editableWidth/editableHeight로부터 온 값으로
      // 이미 부모의 padding이 차감되어 있다. 따라서 padding을 다시 빼면 이중 차감이 된다.
      // absolute box는 mm 단위로 자유롭게 이동하므로 부모의 실제 콘텐츠 영역 하단까지
      // 이동할 수 있어야 한다. editableHeight는 lineHeight 배수로 버림되어 있어
      // 부모 하단이 라인 중간에 걸친 경우 editableHeight보다 더 아래로 갈 수 없었다.
      // parentModel.contentHeight(= height - paddingTop - paddingBottom)를 사용하여
      // 부모의 실제 하단까지 이동할 수 있도록 한다.
      const parentModel = box.parentModel ?? null;
      const maxLeft = Math.max(0, (box.inheritStyle?.parentWidth || 0) - box.width);
      const maxTop = parentModel
        ? Math.max(0, parentModel.contentHeight - box.height)
        : Math.max(0, (box.inheritStyle?.parentHeight || 0) - box.height);
      const clamped = {
        left: Math.max(0, Math.min(maxLeft, sLeft + dxMm)),
        top: Math.max(0, Math.min(maxTop, sTop + dyMm)),
      };
      if (!manager.snapEnabled) return clamped;
      const snapped = this._snapAbsolutePosition(
        clamped.left, clamped.top, box.width, box.height, parentModel,
        manager.screenPxToMm(SNAP_THRESHOLD_PX),
      );
      // 스냅 후에도 부모 경계를 벗어나지 않도록 재클램핑
      return {
        left: Math.max(0, Math.min(maxLeft, snapped.left)),
        top: Math.max(0, Math.min(maxTop, snapped.top)),
      };
    }

    // static 모드: 컬럼/라인 스냅 적용
    const parentModel = box.parentModel;
    if (!parentModel) {
      return { left: sLeft, top: sTop };
    }

    const { columnCoords, lineHeight, columnCount } = parentModel;
    const editableTextHeight = parentModel.editableTextHeight;
    const startX = columnCoords[sLeft].x1;
    const startY = columnCoords[sLeft].y1 + lineHeight * sTop;

    // Shift 누름 시 주축(수평/수직) 제한. 축은 첫 유의미 이동 시 한 번 결정되어
    // 드래그 종료 시까지 유지된다.
    let dxMm = deltaMmX;
    let dyMm = deltaMmY;
    if (state?.shiftKey) {
      if (state.lockAxis === null) {
        if (Math.abs(deltaMmX) >= 1 || Math.abs(deltaMmY) >= 1) {
          state.lockAxis = Math.abs(deltaMmX) >= Math.abs(deltaMmY) ? 'x' : 'y';
        }
      }
      if (state.lockAxis === 'x') dyMm = 0;
      else if (state.lockAxis === 'y') dxMm = 0;
    }
    const newLeftMm = startX + dxMm;
    const newTopMm = startY + dyMm;

    const maxTop = Math.floor((editableTextHeight - (lineHeight * box.height - (lineHeight - parentModel.fontSize))) / lineHeight);

    if (!manager.snapEnabled) {
      // 스냅 비활성화: 컬럼/라인을 정수로 반올림하되 자유 배치
      const avgColWidth = parentModel.editableWidth / parentModel.columnCount;
      const freeLeft = Math.max(0, Math.min(columnCount - box.width, Math.round((newLeftMm - columnCoords[0]!.x1) / avgColWidth)));
      const freeTop = Math.max(0, Math.min(maxTop, Math.round((newTopMm - columnCoords[freeLeft]!.y1) / lineHeight)));
      return { left: freeLeft, top: freeTop };
    }

    // 가장 가까운 컬럼 인덱스 찾기 (스냅)
    let newLeft = 0;
    let minDist = Infinity;
    for (let i = 0; i <= columnCount - box.width; i++) {
      const dist = Math.abs(newLeftMm - columnCoords[i]!.x1);
      if (dist < minDist) {
        minDist = dist;
        newLeft = i;
      }
    }
    newLeft = Math.max(0, Math.min(columnCount - box.width, newLeft));

    // 세로 라인 스냅 및 클램핑
    const newTop = Math.max(0, Math.min(maxTop, Math.round((newTopMm - columnCoords[newLeft]!.y1) / lineHeight)));

    return { left: newLeft, top: newTop };
  }

  /**
   * absolute box 이동 시 부모 그리드의 컬럼/라인 경계로 4엣지 자석(Snap) 보정을 적용한다.
   *
   * 박스의 좌·우·상·하 네 엣지 각각이 임계값 이내로 가까운 컬럼/라인 경계를 찾아,
   * 가장 가까운 한 엣지를 기준으로 `left`/`top`을 조정한다. 박스 크기(width/height)는
   * 유지된다 — 좌·우 엣지가 동시에 임계값 이내여도 한쪽만 흡착하여 width가 변하지 않는다.
   *
   * Y축 스냅 후보는 라인 경계(`baseY + lineHeight * i`) 외에 부모 콘텐츠 영역 하단
   * (`contentHeight` = `height - paddingTop - paddingBottom`)도 포함한다. 부모 하단이
   * 라인 중간에 걸쳐있는 경우 absolute box가 실제 하단까지 자유롭게 내려갈 수 있도록 한다.
   *
   * @param left - 보정 전 left (mm)
   * @param top - 보정 전 top (mm)
   * @param width - 박스 width (mm, 변경 없음)
   * @param height - 박스 height (mm, 변경 없음)
   * @param parentModel - 부모 `GridCalculator`. null이면 보정 없이 원값 반환
   * @param thresholdMm - 스냅 임계값 (mm). 이 거리 이내일 때만 흡착
   * @returns 보정된 `{ left, top }`
   *
   * @example
   * // 임계값 1mm, 박스 left=24.5, width=10, 가장 가까운 컬럼 x1=25.0 (거리 0.5mm)
   * // → 좌측 엣지 흡착: left = 25.0, top은 그대로
   * _snapAbsolutePosition(24.5, 30, 10, 20, parentModel, 1);
   * // → { left: 25.0, top: 30 }
   */
  private _snapAbsolutePosition(
    left: number,
    top: number,
    width: number,
    height: number,
    parentModel: GridCalculator | null,
    thresholdMm: number,
  ): { left: number; top: number } {
    if (!parentModel) return { left, top };

    const { columnCoords, lineHeight } = parentModel;
    const baseY = columnCoords.length > 0 ? columnCoords[0].y1 : 0;

    // X축: 좌측(left)과 우측(left+width) 엣지 후보 수집
    const xCandidates: Array<{ edge: 'left' | 'right'; dist: number; newLeft: number }> = [];
    for (const col of columnCoords) {
      // 좌측 엣지 → 컬럼 시작선 (x1)
      const distLeft = Math.abs(left - col.x1);
      if (distLeft <= thresholdMm) {
        xCandidates.push({ edge: 'left', dist: distLeft, newLeft: col.x1 });
      }
      // 우측 엣지 → 컬럼 끝선 (x2)
      const distRight = Math.abs((left + width) - col.x2);
      if (distRight <= thresholdMm) {
        xCandidates.push({ edge: 'right', dist: distRight, newLeft: col.x2 - width });
      }
    }

    // Y축: 상단(top)과 하단(top+height) 엣지 후보 수집
    // 라인 경계(baseY + lineHeight * i)와 부모 콘텐츠 영역 하단(contentHeight)을 모두 후보로 사용한다.
    // 부모 하단이 라인 중간에 걸쳐있는 경우 absolute box가 실제 하단까지 내려갈 수 있도록 한다.
    const yCandidates: Array<{ edge: 'top' | 'bottom'; dist: number; newTop: number }> = [];
    const maxLineY = parentModel.contentHeight;

    // 라인 경계 후보 수집
    for (let i = 0; ; i++) {
      const lineY = baseY + lineHeight * i;
      if (lineY > maxLineY + thresholdMm + height) break;
      const distTop = Math.abs(top - lineY);
      if (distTop <= thresholdMm) {
        yCandidates.push({ edge: 'top', dist: distTop, newTop: lineY });
      }
      const distBottom = Math.abs((top + height) - lineY);
      if (distBottom <= thresholdMm) {
        yCandidates.push({ edge: 'bottom', dist: distBottom, newTop: lineY - height });
      }
    }

    // 부모 콘텐츠 영역 하단(contentHeight)을 추가 후보로 수집.
    // contentHeight가 마지막 라인 경계와 정확히 일치하지 않는 경우(라인 중간에 걸친 경우)
    // absolute box가 부모 실제 하단까지 자유롭게 내려갈 수 있도록 한다.
    const lastLineY = baseY + lineHeight * Math.floor((maxLineY - baseY) / lineHeight);
    if (Math.abs(maxLineY - lastLineY) > 0.001) {
      const distTop = Math.abs(top - maxLineY);
      if (distTop <= thresholdMm) {
        yCandidates.push({ edge: 'top', dist: distTop, newTop: maxLineY });
      }
      const distBottom = Math.abs((top + height) - maxLineY);
      if (distBottom <= thresholdMm) {
        yCandidates.push({ edge: 'bottom', dist: distBottom, newTop: maxLineY - height });
      }
    }

    let snappedLeft = left;
    let snappedTop = top;
    if (xCandidates.length > 0) {
      const best = xCandidates.reduce((a, b) => a.dist <= b.dist ? a : b);
      snappedLeft = best.newLeft;
    }
    if (yCandidates.length > 0) {
      const best = yCandidates.reduce((a, b) => a.dist <= b.dist ? a : b);
      snappedTop = best.newTop;
    }

    return { left: snappedLeft, top: snappedTop };
  }

  /**
   * absolute box 리사이즈 시 핸들이 담당하는 한 엣지를 부모 그리드의 컬럼/라인 경계로 자석(Snap) 보정한다.
   *
   * 핸들별 담당 엣지:
   * - `right` → 우측 엣지 (left+width) 흡착 → width 조정, left/top 고정
   * - `left` → 좌측 엣지 (left) 흡착 → left·width 조정, 우측 끝(sLeft+sWidth) 고정
   * - `bottom` → 하단 엣지 (top+height) 흡착 → height 조정, left/top 고정. 부모 콘텐츠 영역 하단(contentHeight)도 스냅 후보에 포함
   * - `top` → 상단 엣지 (top) 흡착 → top·height 조정, 하단 끝(sTop+sHeight) 고정
   *
   * @param handle - 리사이즈 핸들 방향
   * @param left - 보정 전 left (mm)
   * @param top - 보정 전 top (mm)
   * @param width - 보정 전 width (mm)
   * @param height - 보정 전 height (mm)
   * @param parentModel - 부모 `GridCalculator`. null이면 보정 없이 원값 반환
   * @param thresholdMm - 스냅 임계값 (mm). 이 거리 이내일 때만 흡착
   * @returns 보정된 `{ left, top, width, height }`
   *
   * @example
   * // right 핸들, 임계값 1mm, left=10, width=14.5, 가장 가까운 컬럼 x2=25.0 (거리 0.5mm)
   * // → 우측 엣지 흡착: width = 15.0, left/top 유지
   * _snapAbsoluteResize('right', 10, 20, 14.5, 30, parentModel, 1);
   * // → { left: 10, top: 20, width: 15.0, height: 30 }
   */
  private _snapAbsoluteResize(
    handle: 'top' | 'bottom' | 'left' | 'right',
    left: number,
    top: number,
    width: number,
    height: number,
    parentModel: GridCalculator | null,
    thresholdMm: number,
  ): { left: number; top: number; width: number; height: number } {
    if (!parentModel) return { left, top, width, height };

    const { columnCoords, lineHeight } = parentModel;
    const baseY = columnCoords.length > 0 ? columnCoords[0].y1 : 0;
    const maxLineY = parentModel.contentHeight;

    switch (handle) {
      case 'right': {
        // 우측 엣지 (left+width) → 컬럼 x2
        let best: { dist: number; value: number } | null = null;
        for (const col of columnCoords) {
          const dist = Math.abs((left + width) - col.x2);
          if (dist <= thresholdMm && (!best || dist < best.dist)) {
            best = { dist, value: col.x2 };
          }
        }
        if (best) {
          return { left, top, width: Math.max(1, best.value - left), height };
        }
        return { left, top, width, height };
      }
      case 'left': {
        // 좌측 엣지 (left) → 컬럼 x1. 우측 끝(left+width) 고정
        const rightEdge = left + width;
        let best: { dist: number; value: number } | null = null;
        for (const col of columnCoords) {
          const dist = Math.abs(left - col.x1);
          if (dist <= thresholdMm && (!best || dist < best.dist)) {
            best = { dist, value: col.x1 };
          }
        }
        if (best) {
          const newLeft = Math.max(0, Math.min(rightEdge - 1, best.value));
          return { left: newLeft, top, width: Math.max(1, rightEdge - newLeft), height };
        }
        return { left, top, width, height };
      }
      case 'bottom': {
        // 하단 엣지 (top+height) → 라인 y 또는 부모 편집 영역 하단
        let best: { dist: number; value: number } | null = null;
        for (let i = 0; ; i++) {
          const lineY = baseY + lineHeight * i;
          if (lineY > maxLineY + thresholdMm + height) break;
          const dist = Math.abs((top + height) - lineY);
          if (dist <= thresholdMm && (!best || dist < best.dist)) {
            best = { dist, value: lineY };
          }
        }
        // 부모 편집 영역 하단(maxLineY)을 추가 후보로 수집.
        // maxLineY가 라인 경계가 아닌 경우(라인 중간에 걸친 경우)에만 추가하여 중복을 방지한다.
        const lastLineY = baseY + lineHeight * Math.floor((maxLineY - baseY) / lineHeight);
        if (Math.abs(maxLineY - lastLineY) > 0.001) {
          const dist = Math.abs((top + height) - maxLineY);
          if (dist <= thresholdMm && (!best || dist < best.dist)) {
            best = { dist, value: maxLineY };
          }
        }
        if (best) {
          return { left, top, width, height: Math.max(1, best.value - top) };
        }
        return { left, top, width, height };
      }
      case 'top': {
        // 상단 엣지 (top) → 라인 y. 하단 끝(top+height) 고정
        const bottomEdge = top + height;
        let best: { dist: number; value: number } | null = null;
        for (let i = 0; ; i++) {
          const lineY = baseY + lineHeight * i;
          if (lineY > maxLineY + thresholdMm + height) break;
          const dist = Math.abs(top - lineY);
          if (dist <= thresholdMm && (!best || dist < best.dist)) {
            best = { dist, value: lineY };
          }
        }
        if (best) {
          const newTop = Math.max(0, Math.min(bottomEdge - 1, best.value));
          return { left, top: newTop, width, height: Math.max(1, bottomEdge - newTop) };
        }
        return { left, top, width, height };
      }
    }
  }

  /**
   * 픽셀 델타를 받아 리사이즈 방향에 따라 새 크기와 위치를 계산한다.
   *
   * position 모드와 핸들 방향에 따라 다른 스냅/클램핑 규칙이 적용된다:
   *
   * - **absolute 모드**: mm 단위로 직접 크기 변경. 부모 편집 영역 내로 클램핑.
   * - **static 모드**: 컬럼/라인 단위로 스냅. 컬럼 개수와 라인 수를 정수로 반올림.
   *
   * 각 핸들 방향의 동작:
   * - `right`: 우측 핸들. width만 변경. left/top/height 유지.
   * - `left`: 좌측 핸들. width와 left가 함께 변경 (우측 끝이 고정).
   * - `bottom`: 하단 핸들. height만 변경. left/top/width 유지.
   * - `top`: 상단 핸들. height와 top이 함께 변경 (하단 끝이 고정).
   *
   * @param box - 크기를 변경할 box 요소
   * @param state - box의 리사이즈 상태
   * @param deltaPxX - 마우스 가로 이동량 (픽셀)
   * @param deltaPxY - 마우스 세로 이동량 (픽셀)
   * @returns 스냅/클램핑이 적용된 새 위치와 크기 `{ left, top, width, height }`
   */
  private _computeNewSize(
    box: LayoutBoxElement,
    state: BoxResizeState,
    deltaPxX: number,
    deltaPxY: number,
  ): { left: number; top: number; width: number; height: number } {
    const handle = state.handle;
    const sLeft = state.startLeft;
    const sTop = state.startTop;
    const sWidth = state.startWidth;
    const sHeight = state.startHeight;

    if (!handle) return { left: sLeft, top: sTop, width: sWidth, height: sHeight };

    if (box.position === 'absolute') {
      const manager = this._manager;
      const deltaMmX = manager.screenDeltaToMm(deltaPxX);
      const deltaMmY = manager.screenDeltaToMm(deltaPxY);
      // parentWidth/parentHeight는 editableWidth/editableHeight로부터 온 값으로
      // 이미 부모의 padding이 차감되어 있다. 따라서 padding을 다시 빼면 이중 차감이 된다.
      const parentW = box.inheritStyle?.parentWidth || 0;
      const parentModel = box.parentModel ?? null;
      // absolute box의 하단 클램핑은 contentHeight(= height - paddingTop - paddingBottom)를 기준으로 한다.
      // editableHeight는 lineHeight 배수로 버림되어 부모 하단이 라인 중간에 걸친 경우
      // 더 아래로 확장할 수 없었다. contentHeight를 사용하여 부모의 실제 하단까지 확장 가능하다.
      const parentH = parentModel
        ? parentModel.contentHeight
        : (box.inheritStyle?.parentHeight || 0);
      const thresholdMm = manager.screenPxToMm(SNAP_THRESHOLD_PX);
      const snapEnabled = manager.snapEnabled;

      switch (handle) {
        case 'right': {
          // 우측 핸들: width만 변경, left/top/height 유지
          const maxWidth = parentW - sLeft;
          const width = Math.max(1, Math.min(maxWidth, sWidth + deltaMmX));
          const result = { left: sLeft, top: sTop, width, height: sHeight };
          if (!snapEnabled) return result;
          return this._snapAbsoluteResize('right', result.left, result.top, result.width, result.height, parentModel, thresholdMm);
        }
        case 'left': {
          // 좌측 핸들: width와 left가 함께 변경 (우측 끝 sLeft+sWidth 고정)
          const maxWidth = sLeft + sWidth;
          const width = Math.max(1, Math.min(maxWidth, sWidth - deltaMmX));
          const left = Math.max(0, Math.min(sLeft + sWidth - 1, sLeft + deltaMmX));
          const result = { left, top: sTop, width, height: sHeight };
          if (!snapEnabled) return result;
          return this._snapAbsoluteResize('left', result.left, result.top, result.width, result.height, parentModel, thresholdMm);
        }
        case 'bottom': {
          // 하단 핸들: height만 변경, left/top/width 유지
          const maxHeight = parentH - sTop;
          const height = Math.max(1, Math.min(maxHeight, sHeight + deltaMmY));
          const result = { left: sLeft, top: sTop, width: sWidth, height };
          if (!snapEnabled) return result;
          return this._snapAbsoluteResize('bottom', result.left, result.top, result.width, result.height, parentModel, thresholdMm);
        }
        case 'top': {
          // 상단 핸들: height와 top이 함께 변경 (하단 끝 sTop+sHeight 고정)
          const maxHeight = sTop + sHeight;
          const height = Math.max(1, Math.min(maxHeight, sHeight - deltaMmY));
          const top = Math.max(0, Math.min(sTop + sHeight - 1, sTop + deltaMmY));
          const result = { left: sLeft, top, width: sWidth, height };
          if (!snapEnabled) return result;
          return this._snapAbsoluteResize('top', result.left, result.top, result.width, result.height, parentModel, thresholdMm);
        }
        case 'nw':
        case 'ne':
        case 'sw':
        case 'se': {
          // 코너 핸들: 두 축 동시 리사이즈. 고정점은 대각 코너.
          // Shift 키 시 가로세로 비율 유지 (시작 크기 기준).
          const isLeftHandle = handle === 'nw' || handle === 'sw';
          const isTopHandle = handle === 'nw' || handle === 'ne';
          // 고정 대각점
          const fixedRight = sLeft + sWidth;
          const fixedBottom = sTop + sHeight;
          // 가로축 새 값
          let newWidth: number;
          let newLeft = sLeft;
          if (isLeftHandle) {
            newWidth = Math.max(1, Math.min(fixedRight, sWidth - deltaMmX));
            newLeft = Math.max(0, Math.min(fixedRight - 1, sLeft + deltaMmX));
          } else {
            const maxWidth = parentW - sLeft;
            newWidth = Math.max(1, Math.min(maxWidth, sWidth + deltaMmX));
          }
          // 세로축 새 값
          let newHeight: number;
          let newTop = sTop;
          if (isTopHandle) {
            newHeight = Math.max(1, Math.min(fixedBottom, sHeight - deltaMmY));
            newTop = Math.max(0, Math.min(fixedBottom - 1, sTop + deltaMmY));
          } else {
            const maxHeight = parentH - sTop;
            newHeight = Math.max(1, Math.min(maxHeight, sHeight + deltaMmY));
          }
          // Shift 비례 제한 (absolute 전용)
          if (state.shiftKey && sWidth > 0 && sHeight > 0) {
            const ratio = sWidth / sHeight;
            const widthDelta = Math.abs(newWidth - sWidth);
            const heightDelta = Math.abs(newHeight - sHeight);
            if (widthDelta >= heightDelta) {
              const derivedHeight = newWidth / ratio;
              if (isTopHandle) {
                newTop = fixedBottom - derivedHeight;
                newHeight = derivedHeight;
              } else {
                newHeight = derivedHeight;
              }
            } else {
              const derivedWidth = newHeight * ratio;
              if (isLeftHandle) {
                newLeft = fixedRight - derivedWidth;
                newWidth = derivedWidth;
              } else {
                newWidth = derivedWidth;
              }
            }
            // 클램핑 재적용
            if (isLeftHandle) {
              newLeft = Math.max(0, Math.min(fixedRight - 1, newLeft));
              newWidth = Math.max(1, Math.min(fixedRight - newLeft, newWidth));
            } else {
              newWidth = Math.max(1, Math.min(parentW - sLeft, newWidth));
            }
            if (isTopHandle) {
              newTop = Math.max(0, Math.min(fixedBottom - 1, newTop));
              newHeight = Math.max(1, Math.min(fixedBottom - newTop, newHeight));
            } else {
              newHeight = Math.max(1, Math.min(parentH - sTop, newHeight));
            }
          }
          return { left: newLeft, top: newTop, width: newWidth, height: newHeight };
        }
      }
    }

    // static 모드: 컬럼/라인 단위 스냅
    const parentModel = box.parentModel;
    if (!parentModel) return { left: sLeft, top: sTop, width: sWidth, height: sHeight };

    const { columnCount, lineHeight } = parentModel;
    const editableTextHeight = parentModel.editableTextHeight;
    const avgColWidth = parentModel.editableWidth / parentModel.columnCount;
    const manager = this._manager;
    const deltaMmX = manager.screenDeltaToMm(deltaPxX);
    const deltaMmY = manager.screenDeltaToMm(deltaPxY);

    // 픽셀 단위 델타를 컬럼/라인 정수 단위로 변환 (스냅)
    const deltaCols = Math.round(deltaMmX / avgColWidth);
    const deltaLines = Math.round(deltaMmY / lineHeight);
    const maxLines = Math.floor(editableTextHeight / lineHeight);

    switch (handle) {
      case 'right': {
        const maxWidth = columnCount - sLeft;
        const width = Math.max(1, Math.min(maxWidth, sWidth + deltaCols));
        return { left: sLeft, top: sTop, width, height: sHeight };
      }
      case 'left': {
        const maxWidth = sLeft + sWidth;
        const width = Math.max(1, Math.min(maxWidth, sWidth - deltaCols));
        const left = Math.max(0, Math.min(sLeft + sWidth - 1, sLeft + deltaCols));
        return { left, top: sTop, width, height: sHeight };
      }
      case 'bottom': {
        const maxHeightForBox = maxLines - sTop;
        const height = Math.max(1, Math.min(maxHeightForBox, sHeight + deltaLines));
        return { left: sLeft, top: sTop, width: sWidth, height };
      }
      case 'top': {
        const maxHeight = sTop + sHeight;
        const height = Math.max(1, Math.min(maxHeight, sHeight - deltaLines));
        const top = Math.max(0, Math.min(sTop + sHeight - 1, sTop + deltaLines));
        return { left: sLeft, top, width: sWidth, height };
      }
      case 'nw':
      case 'ne':
      case 'sw':
      case 'se': {
        // static 코너 핸들: 가로(left/right) + 세로(top/bottom) 동작 조합.
        // 비례 제한 불가 (단/라인 정수 단위이므로).
        const isLeftHandle = handle === 'nw' || handle === 'sw';
        const isTopHandle = handle === 'nw' || handle === 'ne';
        let newLeft = sLeft;
        let newWidth = sWidth;
        let newTop = sTop;
        let newHeight = sHeight;
        if (isLeftHandle) {
          const maxWidth = sLeft + sWidth;
          newWidth = Math.max(1, Math.min(maxWidth, sWidth - deltaCols));
          newLeft = Math.max(0, Math.min(sLeft + sWidth - 1, sLeft + deltaCols));
        } else {
          const maxWidth = columnCount - sLeft;
          newWidth = Math.max(1, Math.min(maxWidth, sWidth + deltaCols));
        }
        if (isTopHandle) {
          const maxHeight = sTop + sHeight;
          newHeight = Math.max(1, Math.min(maxHeight, sHeight - deltaLines));
          newTop = Math.max(0, Math.min(sTop + sHeight - 1, sTop + deltaLines));
        } else {
          const maxHeightForBox = maxLines - sTop;
          newHeight = Math.max(1, Math.min(maxHeightForBox, sHeight + deltaLines));
        }
        return { left: newLeft, top: newTop, width: newWidth, height: newHeight };
      }
    }

    return { left: sLeft, top: sTop, width: sWidth, height: sHeight };
  }

  /**
   * position 변환 시 box의 모든 좌표 필드를 원자적으로 갱신한다.
   *
   * `box.applyPositionConversion()` public 메서드로 위임한다.
   * 이 메서드는 position, left, top, width, height를 한 번에 설정하고
   * `layout()`을 한 번만 호출하여 개별 setter 호출 시 발생하는
   * 중간 상태 불일치를 방지한다.
   *
   * @param box - position을 변환할 box 요소
   * @param position - 새 position 모드 ('static' | 'absolute')
   * @param left - 새 left 값
   * @param top - 새 top 값
   * @param width - 새 width 값
   * @param height - 새 height 값
   */
  private _applyPositionConversion(
    box: LayoutBoxElement,
    position: BoxPosition,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    box.applyPositionConversion(position, left, top, width, height);
  }

  // ─── Affected Paragraphs ──────────────────────────────────────

  /**
   * 부모 좌표계 기준 사각형 (AABB) — `getBoundingClientRect()` 차이로 계산한다.
   *
   * 부모와 자식에 동일한 CSS `transform`이 적용되면(예: 미리보기 zoom) 차이
   * 계산 시 자동으로 상쇄되어 부모 좌표계 픽셀이 정확하게 얻어진다. reparent
   * 모드에서 box가 `style.transform`으로 부모 밖으로 이동한 경우 부모의 rect는
   * 변하지 않으므로 box의 rect만 변환되어 부정확해진다. 따라서 reparent 모드에
   * 서는 이 함수를 사용하지 않고 모든 형제를 수집한다.
   *
   * @param box - 사각형을 계산할 box 요소
   * @returns 부모 좌표계 기준 픽셀 사각형. 부모가 없으면 null
   */
  private _getRectInParent(box: LayoutBoxElement): { left: number; top: number; right: number; bottom: number } | null {
    const parent = box.parentElement;
    if (!parent) return null;
    const parentRect = parent.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    return {
      left: boxRect.left - parentRect.left,
      top: boxRect.top - parentRect.top,
      right: boxRect.right - parentRect.left,
      bottom: boxRect.bottom - parentRect.top,
    };
  }

  /**
   * 두 AABB가 교차하는지 판별한다.
   *
   * 경계 접촉만 있는 경우(`b.right === a.left`)는 교차하지 않는 것으로 간주하여
   * 불필요한 재렌더링을 방지한다. 엄격한 비교(`>`)를 사용한다.
   *
   * @param a - 첫 번째 사각형
   * @param b - 두 번째 사각형
   * @returns 교차하면 `true`
   */
  private _aabbIntersects(
    a: { left: number; top: number; right: number; bottom: number },
    b: { left: number; top: number; right: number; bottom: number },
  ): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  /**
   * 두 AABB의 union을 반환한다.
   *
   * @param a - 첫 번째 사각형
   * @param b - 두 번째 사각형
   * @returns union 사각형
   */
  private _aabbUnion(
    a: { left: number; top: number; right: number; bottom: number },
    b: { left: number; top: number; right: number; bottom: number },
  ): { left: number; top: number; right: number; bottom: number } {
    return {
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
    };
  }

  /**
   * 드래그/리사이즈 중 영향받는 모든 단락 요소를 수집한다.
   *
   * **최적화**: 기본적으로는 box의 모든 형제 box의 자식 단락을 수집하지만,
   * 일반 move 모드(`layoutEditType === 'move'`)에서는 이동 전/후 box의 AABB
   * union과 교차하는 형제 box만 수집하여 재렌더링 비용을 줄인다. reparent
   * 모드에서는 box가 부모 밖으로 나갈 수 있어 AABB 비교가 부정확하므로 모든
   * 형제를 수집한다.
   *
   * box 자체의 자식 단락은 항상 수집한다 (box 내부 텍스트가 box의 새 위치에
   * 맞춰 재배치되어야 함).
   *
   * @param box - 기준이 되는 box 요소
   * @param startRect - 이동/리사이즈 시작 시점의 box 부모 좌표계 AABB.
   *   `null`이면 현재 위치만 사용 (모든 형제 수집)
   * @returns 영향받는 단락 요소 집합
   */
  private _collectAffectedParagraphs(
    box: LayoutBoxElement,
    startRect: { left: number; top: number; right: number; bottom: number } | null,
  ): Set<LayoutParagraphElement> {
    const affected = new Set<LayoutParagraphElement>();

    // box 자체의 자식 단락 수집 (항상)
    for (const item of box.items) {
      this._collectParagraphs(item, affected);
    }

    // 형제 box의 자식 단락 수집
    if (box.parentElement) {
      const manager = this._manager;
      // reparent 모드에서는 box가 부모 밖으로 나갈 수 있어 AABB 비교가 부정확.
      // startRect가 없으면 (단순 클릭, 리사이즈 등) 안전하게 모든 형제 수집.
      if (manager.layoutEditType === 'reparent' || startRect === null) {
        for (const sibling of box.parentElement.items) {
          if (sibling === box) continue;
          this._collectParagraphs(sibling, affected);
        }
      } else {
        // 일반 move 모드: 이동 전/후 AABB union과 교차하는 형제만 수집
        const currentRect = this._getRectInParent(box);
        if (!currentRect) {
          // 부모가 사라진 등 예외 상황. 안전하게 모든 형제 수집.
          for (const sibling of box.parentElement.items) {
            if (sibling === box) continue;
            this._collectParagraphs(sibling, affected);
          }
          return affected;
        }
        const unionRect = this._aabbUnion(startRect, currentRect);
        for (const sibling of box.parentElement.items) {
          if (sibling === box) continue;
          // paragraph/image는 box가 아니므로 AABB 비교가 불가능하다.
          // 텍스트 회피의 실제 대상이므로 무조건 수집한다.
          if (!(sibling instanceof LayoutBoxElement)) {
            this._collectParagraphs(sibling, affected);
            continue;
          }
          const siblingRect = this._getRectInParent(sibling);
          if (siblingRect && this._aabbIntersects(unionRect, siblingRect)) {
            this._collectParagraphs(sibling, affected);
          }
        }
      }
    }

    return affected;
  }

  /**
   * 요소 트리를 재귀적으로 탐색하여 모든 단락 요소를 수집한다.
   *
   * - `paragraph` 타입이면 Set에 추가하고 반환
   * - `box` 타입이면 자식을 재귀적으로 탐색
   * - `image` 타입이면 무시
   *
   * @param element - 탐색을 시작할 요소
   * @param set - 단락 요소를 추가할 Set
   */
  private _collectParagraphs(
    element: LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | LayoutTableElement,
    set: Set<LayoutParagraphElement>,
  ): void {
    if (element.type === 'paragraph') {
      set.add(element as LayoutParagraphElement);
      return;
    }
    if (element.type === 'box') {
      for (const child of (element as LayoutBoxElement).items) {
        this._collectParagraphs(child, set);
      }
      return;
    }
    if (element.type === 'table') {
      for (const tr of (element as LayoutTableElement).items) {
        for (const td of tr.items) {
          for (const box of td.items) {
            this._collectParagraphs(box, set);
          }
        }
      }
    }
  }

  /**
   * 수집된 단락 요소들을 다시 렌더링한다.
   *
   * 각 단락의 `markStructureChangedAndRender()`를 호출하여
   * 구조 변경 플래그를 설정하고 `render()`를 실행한다.
   * 이를 통해 텍스트가 box의 새 위치/크기에 맞춰 재배치된다.
   *
   * @param affected - 재렌더링할 단락 요소 집합
   */
  private _renderAffectedParagraphs(affected: Set<LayoutParagraphElement>): void {
    for (const p of affected) {
      if (p.isConnected) {
        p.markStructureChangedAndRender();
      }
    }
  }

  /**
   * 대기 중인 rAF 재렌더링을 취소하고, 영향받는 단락을 즉시 재렌더링한다.
   *
   * 드래그/리사이즈 종료 시 호출되어, rAF로 지연되어 있던
   * 단락 재렌더링을 즉시 실행한다.
   *
   * @param _box - box 요소 (사용되지 않음, 향후 확장을 위해 유지)
   * @param state - 드래그 또는 리사이즈 상태 객체
   */
  private _flushRerenderAffectedParagraphs(_box: LayoutBoxElement, state: BoxDragState | BoxResizeState): void {
    const rafId = (state as any).rafId;
    if (rafId !== null && rafId !== undefined) {
      cancelAnimationFrame(rafId);
      (state as any).rafId = null;
    }
    const affected = state.affectedParagraphs;
    state.affectedParagraphs = null;
    if (affected) {
      this._renderAffectedParagraphs(affected);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * box의 `BoxDragState`를 가져오거나, 없으면 새로 생성하여 반환한다.
   *
   * 다중 선택 드래그 시 각 box의 시작 위치를 기록하기 위해 사용된다.
   *
   * @param box - 상태를 조회/생성할 box 요소
   * @returns box의 `BoxDragState`
   */
  /**
   * reparent 모드에서 box를 커서 위치의 컨테이너로 이동시킨다.
   *
   * `box.data`로 현재 상태(자손 트리 포함)를 추출한 뒤, 새 컨테이너 내부 좌표계로
   * `left`/`top`/`width`/`height`/`position`을 변환하고 `zIndex`를 새 컨테이너의
   * 최대값 + 1로 설정한다. 기존 box를 제거하고 `newContainer.appendChildData()`로
   * 새 box를 생성하여, `data` setter의 전체 초기화 파이프라인이 실행되도록 한다.
   *
   * @param box - reparenting할 box
   * @param clientX - 마우스 업 시점의 화면 x 좌표
   * @param clientY - 마우스 업 시점의 화면 y 좌표
   * @param state - box의 드래그 상태
   * @returns `{ container: 새 부모, newBox: 생성된 새 box }`. 부모 변경이 없으면 `null`.
   */
  private _tryReparent(
    box: LayoutBoxElement,
    clientX: number,
    clientY: number,
    _state: BoxDragState,
  ): { container: LayoutBoxElement | LayoutDocumentElement | LayoutTableCellElement; newBox: LayoutBoxElement } | null {
    const newContainer = this._findReparentContainer(box, clientX, clientY);

    if (!newContainer || newContainer === box.parentElement) return null;

    // box의 현재 화면 위치를 새 컨테이너 내부 mm 좌표로 변환
    const boxRect = box.getBoundingClientRect();
    const containerRect = newContainer.getBoundingClientRect();
    const manager = this._manager;

    let containerPaddingLeft = 0;
    let containerPaddingTop = 0;
    if (newContainer instanceof LayoutBoxElement) {
      containerPaddingLeft = newContainer.paddingLeft ?? 0;
      containerPaddingTop = newContainer.paddingTop ?? 0;
    }

    const leftMm = Math.max(0, manager.screenPxToMm(boxRect.left - containerRect.left) - containerPaddingLeft);
    const topMm = Math.max(0, manager.screenPxToMm(boxRect.top - containerRect.top) - containerPaddingTop);

    // 새 컨테이너 내에서 가장 높은 z-index + 1 (최댓값 Z_INDEX_MAX_LAYOUT 제한)
    // role=ad/header 고정 z-index(91000/91001)는 계산에서 제외
    const siblings = newContainer.items;
    const maxZ = siblings.length === 0
      ? 0
      : Math.max(...siblings.map(i => {
        const z = i.zIndex ?? 0;
        if (z === Z_INDEX_ROLE_AD || z === Z_INDEX_ROLE_HEADER) return 0;
        return z;
      }));
    const newZIndex = Math.min(maxZ + 1, Z_INDEX_MAX_LAYOUT);

    // box.data 추출 (자손 트리 포함). width/height는 원래 값(static: 컬럼/라인 수, absolute: mm)을 그대로 유지
    const boxData = box.data;

    // 원래 position 유지: static은 static으로 스냅, absolute는 absolute로 좌표 변환
    if (boxData.position === 'static' && newContainer.model) {
      if (newContainer instanceof LayoutTableCellElement) {
        boxData.left = 0;
        boxData.top = 0;
        boxData.width = 1;
        boxData.height = 1;
      } else {
        const { columnCoords, lineHeight, editableWidth, columnCount } = newContainer.model;
        const avgColWidth = editableWidth / columnCount;
        const editAreaLeft = columnCoords[0]?.x1 ?? 0;
        const editAreaTop = columnCoords[0]?.y1 ?? 0;

        const nearestColumn = Math.round((leftMm - editAreaLeft) / avgColWidth);
        const clampedColumn = Math.max(0, Math.min(columnCount - boxData.width, nearestColumn));
        const nearestLine = Math.round((topMm - editAreaTop) / lineHeight);
        const clampedLine = Math.max(0, nearestLine);

        // width/height는 원래 static 값(컬럼/라인 수) 유지
        boxData.left = clampedColumn;
        boxData.top = clampedLine;
      }
    } else {
      // absolute 요소는 absolute 좌표로 변환. width/height는 원래 mm 값 유지
      boxData.position = 'absolute';
      boxData.left = Math.round(leftMm * 100) / 100;
      boxData.top = Math.round(topMm * 100) / 100;
    }
    boxData.zIndex = newZIndex;

    // 기존 box 제거
    const previousContainer = box.parentElement;

    // layoutRemove 이벤트: box.remove() 이전에 발생해야 리스너가 DOM 분리 전 컨텍스트에 접근 가능
    if (previousContainer) {
      manager._dispatchLayoutRemove({
        element: box,
        previousContainer: previousContainer as HTMLElement,
        source: 'reparent',
      });
    }

    box.remove();

    // 새 컨테이너에 데이터 주입하여 새 box 생성
    const newBox = newContainer.appendChildData(boxData) as LayoutBoxElement;

    // layoutAdd 이벤트: 새 컨테이너에 추가됨
    manager._dispatchLayoutAdd({
      element: newBox,
      container: newContainer as HTMLElement,
      source: 'reparent',
    });

    return { container: newContainer, newBox };
  }

  /**
   * 커서 위치에서 reparent 대상 컨테이너를 찾는다.
   *
   * `_tryReparent`와 `_updateReparentHighlight`에서 공유하는 컨테이너 탐지 로직.
   * box 자신/자손, lock된 box, 비-box 자식이 있는 box는 제외한다.
   * 적합한 컨테이너가 없으면 EditManager 루트로 폴백한다.
   */
  private _findReparentContainer(box: LayoutBoxElement, clientX: number, clientY: number): LayoutBoxElement | LayoutDocumentElement | LayoutTableCellElement | null {
    const manager = this._manager;
    const rootId = manager.editableRootId;
    const rootBox = rootId
      ? document.getElementById(rootId) as LayoutBoxElement | null
      : null;

    const elements = document.elementsFromPoint(clientX, clientY);

    let newContainer: LayoutBoxElement | LayoutDocumentElement | LayoutTableCellElement | null = null;
    for (const el of elements) {
      if (el === box) continue;
      if (box.contains(el)) continue;
      if (el instanceof LayoutTableCellElement) {
        if (el.items.some(item => item.position === 'static')) continue;
        if (rootBox && !rootBox.contains(el)) continue;
        newContainer = el;
        break;
      }
      if (el instanceof LayoutBoxElement) {
        if (el.lock) continue;
        const hasNonBoxChild = el.items.some(item => item.type !== 'box');
        if (hasNonBoxChild) continue;
        if (el.contentType === 'table') continue;
        if (rootBox && !rootBox.contains(el)) continue;
        newContainer = el;
        break;
      }
      if (el instanceof LayoutDocumentElement) {
        if (rootBox) continue;
        newContainer = el;
        break;
      }
    }

    // elementsFromPoint가 커서가 박스 경계선 위에 있을 때 신뢰할 수 없는 경우
    // (드래그한 박스가 대상 박스 경계에 딱 맞아떨어질 때),
    // 기하학적 rect containment로 후보를 보충한다.
    // 드래그 중인 box의 rect를 완전히 포함하는 가장 안쪽 박스를 찾는다.
    if (!newContainer || newContainer === box.parentElement) {
      const boxRect = box.getBoundingClientRect();
      const docEl = box.closest('x-layout-document') as LayoutDocumentElement | null;
      if (docEl) {
        const allTds = docEl.querySelectorAll<LayoutTableCellElement>('x-layout-td');
        let bestTd: LayoutTableCellElement | null = null;
        let bestTdArea = Infinity;
        for (const td of allTds) {
          if (td.items.some(item => item.position === 'static')) continue;
          if (rootBox && !rootBox.contains(td)) continue;
          if (box.contains(td)) continue;

          const rect = td.getBoundingClientRect();
          if (
            boxRect.left >= rect.left - 1 && boxRect.right <= rect.right + 1 &&
            boxRect.top >= rect.top - 1 && boxRect.bottom <= rect.bottom + 1
          ) {
            const area = (rect.right - rect.left) * (rect.bottom - rect.top);
            if (area < bestTdArea) {
              bestTdArea = area;
              bestTd = td;
            }
          }
        }
        if (bestTd) {
          newContainer = bestTd;
        }

        if (!newContainer) {
          const allBoxes = docEl.querySelectorAll<LayoutBoxElement>('x-layout-box');
          let bestCandidate: LayoutBoxElement | null = null;
          let bestArea = Infinity;
          for (const candidate of allBoxes) {
            if (candidate === box) continue;
            if (box.contains(candidate)) continue;
            if (candidate.lock) continue;
            // editableRootId가 설정된 경우 root box 내부의 box만 후보
            if (rootBox && !rootBox.contains(candidate)) continue;
            const hasNonBoxChild = candidate.items.some(item => item.type !== 'box');
            if (hasNonBoxChild) continue;
            if (candidate.contentType === 'table') continue;

            const rect = candidate.getBoundingClientRect();
            // 1px 허용 오차로 서브픽셀 경계 문제를 흡수한다.
            if (
              boxRect.left >= rect.left - 1 && boxRect.right <= rect.right + 1 &&
              boxRect.top >= rect.top - 1 && boxRect.bottom <= rect.bottom + 1
            ) {
              const area = (rect.right - rect.left) * (rect.bottom - rect.top);
              if (area < bestArea) {
                bestArea = area;
                bestCandidate = candidate;
              }
            }
          }
          if (bestCandidate) {
            newContainer = bestCandidate;
          }
        }
      }
    }

    if (!newContainer) {
      // 커서 위치에 적합한 컨테이너가 없으면 EditManager 루트로 폴백
      if (rootBox && !rootBox.contains(box) && rootBox !== box) {
        newContainer = rootBox;
      }
      if (!newContainer) {
        // editableRootId가 설정된 경우 document로 폴백하지 않고 root box로 클램핑
        if (rootBox) {
          newContainer = rootBox;
        } else {
          newContainer = box.closest('x-layout-document') as LayoutDocumentElement | null;
        }
      }
    }

    return newContainer;
  }

  /**
   * reparent 모드 드래그 중 커서 위치의 컨테이너에 하이라이트를 토글한다.
   *
   * 이전 하이라이트 대상과 새 대상이 다르면 이전 `reparent-target` 속성을 제거하고
   * 새 대상에 설정한다. 현재 부모와 동일한 컨테이너이거나 드래그 중인 box 자신이면
   * 하이라이트를 제거한다.
   */
  private _updateReparentHighlight(box: LayoutBoxElement, clientX: number, clientY: number): void {
    const target = this._findReparentContainer(box, clientX, clientY);

    if (this._reparentHighlightTarget === target) return;

    if (this._reparentHighlightTarget) {
      this._reparentHighlightTarget.removeAttribute('reparent-target');
    }
    if (target) {
      target.setAttribute('reparent-target', '');
    }
    this._reparentHighlightTarget = target;
  }

  /**
   * reparent 하이라이트를 제거한다.
   * 드래그 종료(mouseup/ESC) 시 호출된다.
   */
  private _clearReparentHighlight(): void {
    if (this._reparentHighlightTarget) {
      this._reparentHighlightTarget.removeAttribute('reparent-target');
      this._reparentHighlightTarget = null;
    }
  }

  /**
   * reparent 모드 드래그 중 box 위치 갱신.
   *
   * 부모 안에서는 `_computeNewPosition`(클램핑) 결과로 `box.left`/`box.top`을 설정하여
   * 일반 이동(텍스트 회피 등)과 동일하게 동작한다.
   * 클램핑이 걸려 부모 밖으로 나가면 `box.left`/`box.top`을 클램핑 위치로 고정하고
   * `box.style.transform`으로 초과분만 추가 이동하여 부모 렌더링 크기를 유지한다.
   * 다시 부모 안으로 돌아오면 transform을 해제하고 일반 이동으로 복귀한다.
   */
  private _applyReparentDragMove(box: LayoutBoxElement, dx: number, dy: number, state: BoxDragState): void {
    const manager = this._manager;

    // 클램핑된 위치 계산 (부모 안에서의 최대 이동 가능 위치)
    const clamped = this._computeNewPosition(box, dx, dy, state.startLeft, state.startTop);

    // 클램핑 없는 자유 이동 위치 계산 (부모 밖으로 나가는 경우)
    const deltaMmX = manager.screenDeltaToMm(dx);
    const deltaMmY = manager.screenDeltaToMm(dy);
    let freeLeft: number;
    let freeTop: number;
    if (box.position === 'static') {
      const parentModel = box.parentModel;
      if (parentModel) {
        const { columnCoords, lineHeight, editableWidth, columnCount } = parentModel;
        const avgColWidth = editableWidth / columnCount;
        const editAreaLeft = columnCoords[0]?.x1 ?? 0;
        const editAreaTop = columnCoords[0]?.y1 ?? 0;
        const startAbsLeft = columnCoords[state.startLeft]?.x1 ?? 0;
        const startAbsTop = editAreaTop + lineHeight * state.startTop;
        freeLeft = Math.round((startAbsLeft + deltaMmX - editAreaLeft) / avgColWidth);
        freeTop = Math.round((startAbsTop + deltaMmY - editAreaTop) / lineHeight);
      } else {
        freeLeft = state.startLeft;
        freeTop = state.startTop;
      }
    } else {
      freeLeft = state.startLeft + deltaMmX;
      freeTop = state.startTop + deltaMmY;
    }

    const isInside = Math.abs(clamped.left - freeLeft) < 0.01 && Math.abs(clamped.top - freeTop) < 0.01;

    if (isInside) {
      // 부모 안: box.left/top으로 이동, transform 해제
      box.style.transform = '';
      if (clamped.converted) {
        this._applyPositionConversion(box, clamped.converted.position, clamped.converted.left, clamped.converted.top, clamped.converted.width, clamped.converted.height);
        state.startLeft = clamped.converted.left;
        state.startTop = clamped.converted.top;
        state.startMouseX = state.lastClientX;
        state.startMouseY = state.lastClientY;
      } else {
        if (box.left !== clamped.left) box.left = clamped.left;
        if (box.top !== clamped.top) box.top = clamped.top;
      }
      state.reparentOutside = null;
    } else {
      // 부모 밖: box.left/top을 클램핑 위치로 고정, transform으로 초과분 이동
      if (!state.reparentOutside) {
        state.reparentOutside = {
          mouseStartX: state.lastClientX,
          mouseStartY: state.lastClientY,
          left: clamped.left,
          top: clamped.top,
        };
        if (clamped.converted) {
          this._applyPositionConversion(box, clamped.converted.position, clamped.converted.left, clamped.converted.top, clamped.converted.width, clamped.converted.height);
        } else {
          if (box.left !== clamped.left) box.left = clamped.left;
          if (box.top !== clamped.top) box.top = clamped.top;
        }
      }
      // 진입 시점부터의 마우스 delta를 transform으로 적용.
      // 부모에 CSS transform: scale(s)이 적용되어 있으면 자식의 transform도
      // scale의 영향을 받으므로, scale로 나누어 보정한다.
      const outsideDx = (state.lastClientX - state.reparentOutside.mouseStartX) / manager.scale;
      const outsideDy = (state.lastClientY - state.reparentOutside.mouseStartY) / manager.scale;
      box.style.transform = `translate(${outsideDx}px, ${outsideDy}px)`;
    }
  }

  private _getOrCreateDragState(box: LayoutBoxElement): BoxDragState {
    let state = this._dragStates.get(box);
    if (!state) {
      state = createDragState();
      this._dragStates.set(box, state);
    }
    return state;
  }

  /**
   * 마우스 이벤트의 `composedPath()`를 순회하여 편집 가능한 box를 찾는다.
   *
   * shadow DOM 내부의 box도 `composedPath()`를 통해 추적할 수 있다.
   * 가장 먼저 발견된 편집 가능한 box를 반환한다 (이벤트 타겟에 가장 가까운 box).
   *
   * @param event - 마우스 이벤트
   * @returns 편집 가능한 box 요소. 없으면 `null`
   */
  private _findEditableBoxFromEvent(event: MouseEvent): LayoutBoxElement | null {
    const path = event.composedPath();
    for (const el of path) {
      if (el instanceof LayoutTableCellElement) {
        const parentBox = el.closest('x-layout-box') as LayoutBoxElement | null;
        if (parentBox && this._isBoxEditable(parentBox)) {
          return parentBox;
        }
      }
      if (el instanceof LayoutBoxElement && this._isBoxEditable(el)) {
        return el;
      }
    }
    return null;
  }

  /**
   * 마우스 이벤트에서 리사이즈 핸들의 방향을 가져온다.
   *
   * `composedPath()`를 순회하여 `resize-handle` 클래스를 가진 요소를 찾고,
   * 해당 요소의 `data-handle` 속성에서 방향을 읽는다.
   *
   * @param event - 마우스 이벤트
   * @param _box - box 요소 (현재 사용되지 않음)
   * @returns 핸들 방향. 없으면 `null`
   */
  private _getResizeHandle(event: MouseEvent, _box: LayoutBoxElement): 'top' | 'bottom' | 'left' | 'right' | 'nw' | 'ne' | 'sw' | 'se' | null {
    for (const el of event.composedPath()) {
      if (el instanceof HTMLElement && el.classList.contains('resize-handle')) {
        return (el.getAttribute('data-handle') as 'top' | 'bottom' | 'left' | 'right' | 'nw' | 'ne' | 'sw' | 'se') ?? null;
      }
    }
    return null;
  }

  /**
   * 진행 중인 모든 드래그/리사이즈 세션을 취소한다.
   *
   * `detach()` 시 호출되어 진행 중인 드래그/리사이즈가
   * 리스너 해제 후에도 계속 진행되지 않도록 한다.
   *
   * 처리 순서:
   * 1. 활성 드래그 box의 rAF 취소 및 단락 재렌더링
   * 2. 활성 리사이즈 box의 rAF 취소
   * 3. document 레벨의 모든 mousemove/mouseup/keydown 리스너 제거
   */
  private _cancelAllDrags(): void {
    if (this._activeDragBox) {
      const state = this._dragStates.get(this._activeDragBox);
      if (state) {
        state.isDragging = false;
        if (state.rafId !== null) {
          cancelAnimationFrame(state.rafId);
          state.rafId = null;
        }
        this._flushRerenderAffectedParagraphs(this._activeDragBox, state);
      }
      this._activeDragBox = null;
    }
    if (this._activeResizeBox) {
      const state = this._resizeStates.get(this._activeResizeBox);
      if (state) {
        state.isResizing = false;
        if (state.rafId !== null) {
          cancelAnimationFrame(state.rafId);
          state.rafId = null;
        }
      }
      this._activeResizeBox = null;
    }
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('mousemove', this._onResizeMouseMove);
    document.removeEventListener('mouseup', this._onResizeMouseUp);
    document.removeEventListener('keydown', this._onResizeKeyDown);
    this._clearReparentHighlight();
  }
}