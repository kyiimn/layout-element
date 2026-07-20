import { BoxPosition } from "@/types";
import { LayoutBoxElement } from "@/components/layout/box.element";
import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import { LayoutImageElement } from "@/components/layout/image.element";
import { EditManager } from "./edit-manager";

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
  /** mousedown 시점에 이 box가 새로 선택되었는지 여부. click 이벤트에서 중복 선택을 방지한다 */
  selectedOnMouseDown: boolean;
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
}

/**
 * 리사이즈 중 box별 상태를 보관하는 인터페이스.
 *
 * `LayoutEditController`는 각 box의 리사이즈 상태를 `Map<LayoutBoxElement, BoxResizeState>`로 관리한다.
 */
interface BoxResizeState {
  /** 현재 리사이즈 중인지 여부 */
  isResizing: boolean;
  /** 리사이즈 핸들 방향 ('top' | 'bottom' | 'left' | 'right'). null이면 비활성 */
  handle: 'top' | 'bottom' | 'left' | 'right' | null;
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
    selectedOnMouseDown: false,
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
 * - **이벤트 위임**: `mousedown`과 `click`을 capture phase로 `document.documentElement`에 등록한다.
 *   `composedPath()`를 통해 shadow DOM 내부의 box까지 추적할 수 있다.
 * - **상태 분리**: 각 box의 드래그/리사이즈 상태는 `Map<LayoutBoxElement, BoxDragState>` /
 *   `Map<LayoutBoxElement, BoxResizeState>`로 관리된다. box 인스턴스 자체는 상태를 보관하지 않는다.
 * - **hover 처리**: hover는 box 자체의 `mouseenter`/`mouseleave` 리스너로 유지된다
 *   (이벤트가 버블링되지 않으므로 위임이 불가능하기 때문).
 *
 * @example
 * ```ts
 * const manager = EditManager.getInstance();
 * manager.setEditableRoles(['body', 'title']);
 * manager.layoutEditMode = true;
 * // → LayoutEditController가 attach()되어 편집 가능한 box의 드래그/리사이즈를 처리
 * ```
 */
export class LayoutEditController {
  /** 이벤트 리스너가 등록되는 루트 요소 (일반적으로 `document.documentElement`) */
  private _document: HTMLElement;
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
   * @param doc - 이벤트 리스너가 등록될 루트 HTMLElement
   */
  constructor(doc: HTMLElement) {
    this._document = doc;
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
    const manager = EditManager.getInstance();
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
    const rootId = EditManager.getInstance().editableRootId;
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
   * 6. 그 외의 경우 `_startDrag()` 호출
   *
   * @param event - mousedown 마우스 이벤트
   */
  private _onMouseDown = (event: MouseEvent): void => {
    const box = this._findEditableBoxFromEvent(event);
    if (!box) return;
    const manager = EditManager.getInstance();
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

    this._startDrag(event, box);
  }

  // ─── Drag (Move) ──────────────────────────────────────────────

  /**
   * 드래그 이동을 시작한다.
   *
   * mousedown이 발생한 box의 드래그 상태를 초기화하고,
   * 다중 선택된 모든 box의 시작 위치를 기록한다.
   *
   * 처리 순서:
   * 1. box의 `BoxDragState`를 가져오거나 생성
   * 2. box가 선택되어 있지 않으면 먼저 선택 (Ctrl+클릭 시 다중 선택)
   * 3. 마우스 시작 좌표, box 시작 위치, 원래 위치 기록
   * 4. 커서를 `grabbing`으로 변경
   * 5. `EditManager._startLayoutDrag()` 호출로 다중 선택 드래그 대상 설정
   * 6. 영향받는 단락 수집 (드래그 종료 시 일괄 재렌더링용)
   * 7. 다중 선택된 모든 box의 시작 위치를 각각의 `BoxDragState`에 기록
   * 8. document 레벨에 `mousemove`, `mouseup`, `keydown` 리스너 등록
   *
   * @param event - mousedown 이벤트
   * @param box - 드래그를 시작할 box 요소
   */
  private _startDrag(event: MouseEvent, box: LayoutBoxElement): void {
    const manager = EditManager.getInstance();
    let state = this._dragStates.get(box);
    if (!state) {
      state = createDragState();
      this._dragStates.set(box, state);
    }

    // box가 선택되어 있지 않으면 먼저 선택. selectedOnMouseDown 플래그로
    // 후속 click 이벤트에서 중복 선택을 방지한다.
    state.selectedOnMouseDown = false;
    if (!box.hasAttribute('selected')) {
      manager._setMultiSelect(event.ctrlKey || event.metaKey);
      manager.selectLayout(box);
      manager._setMultiSelect(false);
      state.selectedOnMouseDown = true;
    }

    event.preventDefault();
    event.stopPropagation();
    box.removeAttribute('hovered');

    // 드래그 상태 초기화
    state.isDragging = true;
    state.dragMoved = false;
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
    state.affectedParagraphs = this._collectAffectedParagraphs(box);

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
      const manager = EditManager.getInstance();
      const dragTargets = manager._getDragTargets();
      const isTopLevel = dragTargets.includes(box);

      // 활성 box(최상위 선택) 위치 갱신
      if (isTopLevel) {
        const result = this._computeNewPosition(box, dx, dy, state.startLeft, state.startTop);
        if (result.converted) {
          // position 변환이 발생한 경우 (static ↔ absolute)
          this._applyPositionConversion(box, result.converted.position, result.converted.left, result.converted.top, result.converted.width, result.converted.height);
          // 변환 후 시작 위치를 갱신하여 연속 드래그가 자연스럽게 이어지도록 한다
          state.startLeft = result.converted.left;
          state.startTop = result.converted.top;
          state.startMouseX = state.lastClientX;
          state.startMouseY = state.lastClientY;
        } else {
          if (box.left !== result.left) box.left = result.left;
          if (box.top !== result.top) box.top = result.top;
        }
      }

      // 다중 선택된 다른 box들도 동일한 delta만큼 이동
      for (const target of dragTargets) {
        if (target === box) continue;
        const targetState = this._getOrCreateDragState(target);
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
   * 5. 드래그 이동이 없었으면(클릭만) `_endLayoutDrag()`만 호출
   * 6. 최종 위치 계산 및 적용
   * 7. `EditManager._dispatchLayoutMove()`로 이동 이벤트 발생
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
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    state.isDragging = false;

    // 드래그 중 보류된 단락 재렌더링을 즉시 실행 (텍스트 회피 최종 적용)
    this._flushRerenderAffectedParagraphs(box, state);
    box.style.cursor = this._isBoxEditable(box) ? 'grab' : '';

    const manager = EditManager.getInstance();

    // 드래그 이동이 없었으면 (임계값 미충족 = 단순 클릭)
    if (!state.dragMoved) {
      manager._endLayoutDrag();
      return;
    }

    // 최종 위치 계산 및 적용
    const dragTargets = manager._getDragTargets();
    const isTopLevel = dragTargets.includes(box);
    const deltaX = event.clientX - state.startMouseX;
    const deltaY = event.clientY - state.startMouseY;

    if (isTopLevel) {
      const startLeft = state.startLeft;
      const startTop = state.startTop;
      const result = this._computeNewPosition(box, deltaX, deltaY, state.startLeft, state.startTop);
      if (result.converted) {
        this._applyPositionConversion(box, result.converted.position, result.converted.left, result.converted.top, result.converted.width, result.converted.height);
      } else {
        if (result.left !== box.left) box.left = result.left;
        if (result.top !== box.top) box.top = result.top;
      }
      manager._dispatchLayoutMove(box, startLeft, startTop, box.left, box.top, false);
    }

    // 다중 선택된 다른 box들의 최종 위치 확정 및 이동 이벤트 발생
    for (const target of dragTargets) {
      if (target === box) continue;
      const targetState = this._getOrCreateDragState(target);
      const result = this._computeNewPosition(target, deltaX, deltaY, targetState.startLeft, targetState.startTop);
      if (result.converted) {
        this._applyPositionConversion(target, result.converted.position, result.converted.left, result.converted.top, result.converted.width, result.converted.height);
      } else {
        if (result.left !== target.left) target.left = result.left;
        if (result.top !== target.top) target.top = result.top;
      }
      manager._dispatchLayoutMove(target, targetState.startLeft, targetState.startTop, target.left, target.top, false);
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

    event.preventDefault();
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('keydown', this._onKeyDown);
    state.isDragging = false;
    state.dragMoved = false;
    this._flushRerenderAffectedParagraphs(box, state);
    box.style.cursor = this._isBoxEditable(box) ? 'grab' : '';

    const manager = EditManager.getInstance();
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
    const manager = EditManager.getInstance();
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
    state.affectedParagraphs = this._collectAffectedParagraphs(box);

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
    EditManager.getInstance()._endLayoutResize();

    // 리사이즈 이동이 없었으면 (임계값 미충족 = 단순 클릭)
    if (!state.moved) {
      state.handle = null;
      return;
    }

    // 최종 크기 계산 및 적용
    const deltaX = event.clientX - state.startMouseX;
    const deltaY = event.clientY - state.startMouseY;
    const { left, top, width, height } = this._computeNewSize(box, state, deltaX, deltaY);
    state.handle = null;
    if (left !== box.left) box.left = left;
    if (top !== box.top) box.top = top;
    if (width !== box.width) box.width = width;
    if (height !== box.height) box.height = height;

    EditManager.getInstance()._dispatchLayoutResize(
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

    event.preventDefault();
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
    EditManager.getInstance()._endLayoutResize();

    // 원래 크기로 복원
    if (box.left !== state.startLeft) box.left = state.startLeft;
    if (box.top !== state.startTop) box.top = state.startTop;
    if (box.width !== state.startWidth) box.width = state.startWidth;
    if (box.height !== state.startHeight) box.height = state.startHeight;

    EditManager.getInstance()._dispatchLayoutResize(
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
    const manager = EditManager.getInstance();
    const deltaMmX = manager.screenDeltaToMm(deltaPxX);
    const deltaMmY = manager.screenDeltaToMm(deltaPxY);

    const isDocumentChild = box.parentElement?.type === 'document';

    if (box.position === 'absolute') {
      const padL = box.inheritStyle?.paddingLeft || 0;
      const padR = box.inheritStyle?.paddingRight || 0;
      const padT = box.inheritStyle?.paddingTop || 0;
      const padB = box.inheritStyle?.paddingBottom || 0;

      // 문서 직계 자식 absolute 요소는 편집 영역 밖으로 자유롭게 이동 가능
      if (isDocumentChild) {
        return { left: sLeft + deltaMmX, top: sTop + deltaMmY };
      }

      // 다른 박스 안의 absolute 요소는 부모 편집 영역 내로 클램핑
      const maxLeft = Math.max(0, (box.inheritStyle?.parentWidth || 0) - padL - padR - box.width);
      const maxTop = Math.max(0, (box.inheritStyle?.parentHeight || 0) - padT - padB - box.height);
      return {
        left: Math.max(0, Math.min(maxLeft, sLeft + deltaMmX)),
        top: Math.max(0, Math.min(maxTop, sTop + deltaMmY)),
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
    const newLeftMm = startX + deltaMmX;
    const newTopMm = startY + deltaMmY;

    // 가장 가까운 컬럼 인덱스 찾기 (스냅)
    let newLeft = 0;
    let minDist = Infinity;
    for (let i = 0; i <= columnCount - box.width; i++) {
      const dist = Math.abs(newLeftMm - columnCoords[i].x1);
      if (dist < minDist) {
        minDist = dist;
        newLeft = i;
      }
    }
    newLeft = Math.max(0, Math.min(columnCount - box.width, newLeft));

    // 세로 라인 스냅 및 클램핑
    const maxTop = Math.floor((editableTextHeight - (lineHeight * box.height - (lineHeight - parentModel.fontSize))) / lineHeight);
    const newTop = Math.max(0, Math.min(maxTop, Math.round((newTopMm - columnCoords[newLeft].y1) / lineHeight)));

    return { left: newLeft, top: newTop };
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
      const manager = EditManager.getInstance();
      const deltaMmX = manager.screenDeltaToMm(deltaPxX);
      const deltaMmY = manager.screenDeltaToMm(deltaPxY);
      const padL = box.inheritStyle?.paddingLeft || 0;
      const padR = box.inheritStyle?.paddingRight || 0;
      const padT = box.inheritStyle?.paddingTop || 0;
      const padB = box.inheritStyle?.paddingBottom || 0;
      const parentW = box.inheritStyle?.parentWidth || 0;
      const parentH = box.inheritStyle?.parentHeight || 0;

      switch (handle) {
        case 'right': {
          // 우측 핸들: width만 변경, left/top/height 유지
          const maxWidth = parentW - padL - padR - sLeft;
          const width = Math.max(1, Math.min(maxWidth, sWidth + deltaMmX));
          return { left: sLeft, top: sTop, width, height: sHeight };
        }
        case 'left': {
          // 좌측 핸들: width와 left가 함께 변경 (우측 끝 sLeft+sWidth 고정)
          const maxWidth = sLeft + sWidth;
          const width = Math.max(1, Math.min(maxWidth, sWidth - deltaMmX));
          const left = Math.max(0, Math.min(sLeft + sWidth - 1, sLeft + deltaMmX));
          return { left, top: sTop, width, height: sHeight };
        }
        case 'bottom': {
          // 하단 핸들: height만 변경, left/top/width 유지
          const maxHeight = parentH - padT - padB - sTop;
          const height = Math.max(1, Math.min(maxHeight, sHeight + deltaMmY));
          return { left: sLeft, top: sTop, width: sWidth, height };
        }
        case 'top': {
          // 상단 핸들: height와 top이 함께 변경 (하단 끝 sTop+sHeight 고정)
          const maxHeight = sTop + sHeight;
          const height = Math.max(1, Math.min(maxHeight, sHeight - deltaMmY));
          const top = Math.max(0, Math.min(sTop + sHeight - 1, sTop + deltaMmY));
          return { left: sLeft, top, width: sWidth, height };
        }
      }
    }

    // static 모드: 컬럼/라인 단위 스냅
    const parentModel = box.parentModel;
    if (!parentModel) return { left: sLeft, top: sTop, width: sWidth, height: sHeight };

    const { columnCount, lineHeight } = parentModel;
    const editableTextHeight = parentModel.editableTextHeight;
    const avgColWidth = parentModel.editableWidth / parentModel.columnCount;
    const manager = EditManager.getInstance();
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
   * 드래그/리사이즈 중 영향받는 모든 단락 요소를 수집한다.
   *
   * box 자체의 자식 단락뿐만 아니라 **형제 box의 자식 단락**도 포함한다.
   * 이는 box가 이동/크기 변경 시 형제 box 내의 텍스트도 오버랩 회피를 위해
   * 재렌더링되어야 하기 때문이다.
   *
   * @param box - 기준이 되는 box 요소
   * @returns 영향받는 단락 요소 집합
   */
  private _collectAffectedParagraphs(box: LayoutBoxElement): Set<LayoutParagraphElement> {
    const affected = new Set<LayoutParagraphElement>();

    // box 자체의 자식 단락 수집
    for (const item of box.items) {
      this._collectParagraphs(item, affected);
    }

    // 형제 box의 자식 단락도 수집 (오버랩 영향)
    if (box.parentElement) {
      for (const sibling of box.parentElement.items) {
        if (sibling === box) continue;
        this._collectParagraphs(sibling, affected);
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
    element: LayoutBoxElement | LayoutParagraphElement | LayoutImageElement,
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
   * @returns 핸들 방향 ('top' | 'bottom' | 'left' | 'right'). 없으면 `null`
   */
  private _getResizeHandle(event: MouseEvent, _box: LayoutBoxElement): 'top' | 'bottom' | 'left' | 'right' | null {
    for (const el of event.composedPath()) {
      if (el instanceof HTMLElement && el.classList.contains('resize-handle')) {
        return (el.getAttribute('data-handle') as 'top' | 'bottom' | 'left' | 'right') ?? null;
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
  }
}