import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import { LayoutDocumentElement } from "@/components/layout/document.element";
import { LayoutBoxElement } from "@/components/layout/box.element";
import { LayoutTableCellElement } from "@/components/layout/td.element";
import { LayoutTableElement } from "@/components/layout/table.element";
import type { TextEditController, CurrentStyle } from "./text-edit-controller";
import { InsertController } from "./insert-controller";
import { LayoutEditController } from "./layout-edit-controller";
import { LayoutSelectionController } from "./layout-selection-controller";
import { PlaceGunController } from "./place-gun-controller";
import type { SelectionRange } from "@/types/edit";
import type { InsertMode, InsertEventDetail, InsertPosition, LayoutEditType, LayoutEditModeInput, LayoutAddEventDetail, LayoutRemoveEventDetail, EditModeState, BoxPropertyChangeEventDetail, ContextMenuEventDetail, PlaceGunItem, PlaceGunChangeEventDetail, PlaceGunBeforeEventDetail, PlaceGunAfterEventDetail, TableCellSelectionChangeDetail } from "@/types/edit";
import type { BoxRole } from "@/types/layout";

/** 레이아웃 편집 대상 요소 (box 및 TD) */
export type LayoutElement = LayoutBoxElement | LayoutTableCellElement;

/**
 * 글로벌 편집 관리 이벤트 타입.
 */
export type EditManagerEventType =
  | 'focusChange'
  | 'textChange'
  | 'styleChange'
  | 'selectionStart'
  | 'selectionEnd'
  | 'cursorMove'
  | 'layoutSelectionChange'
  | 'layoutMove'
  | 'layoutResize'
  | 'layoutAdd'
  | 'layoutRemove'
  | 'insert'
  | 'insertCancel'
  | 'modeChange'
  | 'boxPropertyChange'
  | 'contextMenu'
  | 'placeGunChange'
  | 'placeGunBefore'
  | 'placeGunAfter'
  | 'cellSelectionChange';

/**
 * 글로벌 편집 관리 이벤트.
 */
export interface EditManagerEvent {
  /** 이벤트 타입 */
  type: EditManagerEventType;
  /** 이벤트가 발생한 단락 요소 (포커스된 단락) */
  paragraph: LayoutParagraphElement;
  /** 이벤트가 발생한 편집 컨트롤러 (레이아웃/삽입/PlaceGun 이벤트에서는 null) */
  controller: TextEditController | null;
  /** 이전 포커스 단락 (focusChange 이벤트에서만) */
  previousParagraph?: LayoutParagraphElement | null;
  /** 이전 편집 컨트롤러 (focusChange 이벤트에서만) */
  previousController?: TextEditController | null;
  /** 레이아웃 선택 변경 시 선택된 요소들 (layoutSelectionChange 이벤트에서만) */
  selectedLayouts?: LayoutElement[];
  /** 레이아웃 선택 변경 시 이전 선택 요소들 (layoutSelectionChange 이벤트에서만) */
  previousLayouts?: LayoutElement[];
  /** 레이아웃 이동 이벤트에서 이동된 요소 (layoutMove 이벤트에서만) */
  layoutElement?: LayoutElement;
  /** 삽입 완료 시 삽입된 요소 (insert 이벤트에서만) */
  element?: HTMLElement;
  /** 삽입 완료 시 부모 컨테이너 (insert 이벤트에서만) */
  container?: HTMLElement;
  /** reparent 모드에서 이동 후 부모 컨테이너 (layoutMove 이벤트에서만, reparent 시에만) */
  newContainer?: HTMLElement;
  /** reparent 모드에서 이동 전 부모 컨테이너 (layoutMove 이벤트에서만, reparent 시에만) */
  previousContainer?: HTMLElement;
  /** 이동 전 left 값 (layoutMove 이벤트에서만) */
  previousLeft?: number;
  /** 이동 전 top 값 (layoutMove 이벤트에서만) */
  previousTop?: number;
  /** 이동 후 left 값 (layoutMove, insert 이벤트에서만) */
  left?: number;
  /** 이동 후 top 값 (layoutMove, insert 이벤트에서만) */
  top?: number;
  /** 이동이 취소되었는지 여부 (ESC 취소 시 true) (layoutMove, insert 이벤트에서만) */
  canceled?: boolean;
  /** 리사이즈 전 width 값 (layoutResize 이벤트에서만) */
  previousWidth?: number;
  /** 리사이즈 전 height 값 (layoutResize 이벤트에서만) */
  previousHeight?: number;
  /** 리사이즈 후 width 값 (layoutResize, insert 이벤트에서만) */
  width?: number;
  /** 리사이즈 후 height 값 (layoutResize, insert 이벤트에서만) */
  height?: number;
  /** 삽입 요소의 배치 모드 (insert 이벤트에서만) */
  position?: InsertPosition;
  /** 삽입 요소의 zIndex (insert 이벤트에서만) */
  zIndex?: number;
  /** 레이아웃 요소 추가 상세 정보 (layoutAdd 이벤트에서만) */
  layoutAddDetail?: LayoutAddEventDetail;
  /** 레이아웃 요소 제거 상세 정보 (layoutRemove 이벤트에서만) */
  layoutRemoveDetail?: LayoutRemoveEventDetail;
  /** 모드 전환 전 상태 (modeChange 이벤트에서만) */
  previousMode?: EditModeState;
  /** 모드 전환 후 상태 (modeChange 이벤트에서만) */
  mode?: EditModeState;
  /** Box 속성 변경 상세 정보 (boxPropertyChange 이벤트에서만) */
  boxPropertyDetail?: BoxPropertyChangeEventDetail;
  /** 컨텍스트 메뉴 상세 정보 (contextMenu 이벤트에서만) */
  contextMenuDetail?: ContextMenuEventDetail;
  /** Place Gun 상태 변경 상세 정보 (placeGunChange 이벤트에서만) */
  placeGunDetail?: PlaceGunChangeEventDetail;
  /** Place Gun 발사 전 상세 정보 (placeGunBefore 이벤트에서만) */
  placeGunBeforeDetail?: PlaceGunBeforeEventDetail;
  /** Place Gun 발사 후 상세 정보 (placeGunAfter 이벤트에서만) */
  placeGunAfterDetail?: PlaceGunAfterEventDetail;
  /** 셀 블록 선택 변경 상세 정보 (cellSelectionChange 이벤트에서만) */
  cellSelectionDetail?: TableCellSelectionChangeDetail;
}

/**
 * 이벤트 리스너 함수 타입.
 */
export type EditManagerEventListener = (event: EditManagerEvent) => void;

/**
 * 글로벌 편집 관리자 (싱글톤).
 *
 * 문서 내 모든 `TextEditController` 인스턴스를 중앙에서 관리한다.
 * 한 번에 하나의 단락만 포커스를 가질 수 있으며, 포커스가 이동하면
 * 이전 단락의 선택 영역이 자동으로 해제된다.
 *
 * 외부 편집 UI에서 편집 상태를 제어하고 이벤트를 수신할 수 있도록
 * 이벤트 시스템과 상태 조회 API를 제공한다.
 *
 * @example
 * ```ts
 * const manager = layoutDocEl.editManager;
 *
 * // 이벤트 리스너 등록
 * manager.addEventListener('focusChange', (e) => {
 *   console.log('Focus moved to', e.paragraph);
 * });
 * manager.addEventListener('textChange', (e) => {
 *   console.log('Text changed in', e.paragraph);
 * });
 * manager.addEventListener('styleChange', (e) => {
 *   console.log('Style changed in', e.paragraph);
 * });
 *
 * // 상태 조회
 * const focusedParagraph = manager.focusedParagraph;
 * const cursorOffset = manager.cursorOffset;
 * const selection = manager.selection;
 * const style = manager.currentStyle;
 * ```
 */
export class EditManager {
  private _docEl: LayoutDocumentElement;
  private _controllers: Set<TextEditController> = new Set();
  private _focusedController: TextEditController | null = null;
  private _lastFocusedBox: LayoutBoxElement | null = null;
  private _listeners: Map<EditManagerEventType, Set<EditManagerEventListener>> = new Map();
  private _dispatching = false;
  private _selectedLayouts: LayoutElement[] = [];
  private _isLayoutDragging = false;
  private _isLayoutResizing = false;
  private _insertController: InsertController | null = null;
  private _insertMode: InsertMode | null = null;
  private _clickConsumeHandler: ((e: MouseEvent) => void) | null = null;
  private _clickConsumeTimer: ReturnType<typeof setTimeout> | null = null;
  private _layoutEditMode: boolean = false;
  private _layoutEditType: LayoutEditType = 'move';
  private _selectionController: LayoutSelectionController | null = null;
  private _layoutEditController: LayoutEditController | null = null;
  private _editableRoles: Set<BoxRole> | null = null;
  private _editableBoxIds: Set<string> | null = null;
  private _selectableRoles: Set<BoxRole> | null = null;
  private _selectableBoxIds: Set<string> | null = null;
  private _selectableRootId: string | null = null;

  private _placeGunItems: PlaceGunItem[] = [];
  private _placeGunPaused: boolean = false;
  private _placeGunController: PlaceGunController | null = null;

  /**
   * CSS `transform: scale(s)`이 적용된 환경을 위한 화면 scale 보정 계수.
   * `screenPxToMm()`/`screenDeltaToMm()`이 `originalPpm * scale`을 사용해
   * 변환된 픽셀 좌표를 mm으로 정확히 환산한다. 기본값 1.0.
   */
  private _scale: number = 1;

  /**
   * 편집 중 보더가 없는 box/td에 빨간 점선 placeholder border를 표시할지 여부.
   * 휘발성 — 데이터에 저장되지 않으며 편집 세션 중에만 적용된다.
   */
  private _showPlaceholderBorders: boolean = true;

  /**
   * 모드 전환 이벤트 억제 플래그.
   *
   * 모드 setter가 내부에서 다른 모드 setter를 호출할 때 중간 상태의
   * `modeChange` 이벤트가 발생하는 것을 방지한다.
   * 최종적으로 모드가 확정된 후 한 번만 이벤트가 발생한다.
   */
  private _modeChangeSuppressed: boolean = false;

  /** 편집 루트 box id. null이면 제한 없음. 지정 시 해당 box 내부 요소만 편집 가능, Root 자체는 편집 불가. */
  private _editableRootId: string | null = null;

  /** 드래그/리사이즈 시 그리드 스냅 활성 여부. true면 스냅, false면 자유 이동/크기. */
  private _snapEnabled = true;

  /** 스페이스 키 누름 여부. 팬 모드에서 마키/드래그를 억제한다. 외부에서 설정. */
  private _spacePressed = false;

  /**
   * 이 EditManager가 관리하는 문서 요소.
   *
   * 문서별로 독립적인 인스턴스이므로, 전역 DOM 순회(`document.querySelectorAll`)
   * 대신 이 요소의 하위 트리만 순회한다.
   */
  get docEl(): LayoutDocumentElement { return this._docEl; }

  /**
   * 주어진 문서 요소를 관리하는 편집 관리자를 생성한다.
   *
   * 문서별로 하나의 인스턴스를 생성하며, `LayoutDocumentElement.connectedCallback`
   * 또는 외부(LayoutEditor React 컴포넌트)가 인스턴스를 생성해 `editManager`
   * 프로퍼티로 할당한다. 생성 시 `LayoutSelectionController`를 즉시 생성하고
   * attach하여 클릭/더블클릭/컨텍스트메뉴 이벤트를 문서 연결과 동시에 처리한다.
   *
   * @param docEl - 이 EditManager가 관리할 `LayoutDocumentElement`
   */
  constructor(docEl: LayoutDocumentElement) {
    this._docEl = docEl;
    this._selectionController = new LayoutSelectionController(this._docEl, this);
    this._selectionController.attach();
  }

  /**
   * 현재 편집 모드 상태 스냅샷을 반환한다.
   *
   * `modeChange` 이벤트의 payload 생성에 사용된다.
   *
   * @returns 현재 모드 상태
   */
  private _getModeState(): EditModeState {
    return {
      textEditMode: this._textEditMode,
      layoutEditMode: this._layoutEditMode,
      layoutEditType: this._layoutEditType,
      insertMode: this._insertMode,
    };
  }

  /**
   * 모드 전환 이벤트를 발생시킨다.
   *
   * `textEditMode`/`layoutEditMode`/`insertMode` setter에서 모드가 실제로 변경된 후 호출된다.
   * 이전 모드 상태와 새 모드 상태를 payload로 전달한다.
   *
   * @param previousMode - 전환 전 모드 상태
   * @internal
   */
  _dispatchModeChange(previousMode: EditModeState): void {
    if (this._dispatching) return;
    if (this._modeChangeSuppressed) return;
    const listeners = this._listeners.get('modeChange');
    if (!listeners || listeners.size === 0) return;

    const mode = this._getModeState();
    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'modeChange',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            previousMode,
            mode,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * CSS `transform: scale(s)`이 적용된 환경을 위한 화면 scale 보정 계수를 설정한다.
   * 이후 `screenPxToMm()`/`screenDeltaToMm()`이 `originalPpm * scale`을 사용해
   * 변환된 픽셀 좌표를 mm으로 정확히 환산한다.
   *
   * @example
   * ```ts
   * const manager = layoutDocEl.editManager;
   * manager.setScale(0.5);  // zoom 50% 환경
   * manager.setScale(1);    // 원본
   * ```
   */
  setScale(scale: number): void {
    if (scale <= 0) {
      throw new Error(`EditManager.setScale: scale은 0보다 커야 합니다 (입력값: ${scale}).`);
    }
    this._scale = scale;
    this._docEl.querySelectorAll<LayoutParagraphElement>('x-layout-paragraph').forEach((p) => {
      p.markStructureChangedAndRender();
    });
  }

  /** scale 보정 계수를 1로 원복한다. 컴포넌트 unmount 시 호출한다. */
  resetScale(): void {
    this._scale = 1;
  }

  /**
   * 모든 편집 상태를 초기화한다. LayoutEditor 컴포넌트가 unmount될 때 호출한다.
   *
   * 싱글톤 EditManager는 컴포넌트 전환 시에도 인스턴스가 유지되므로,
   * 이전 문서의 편집 상태(선택, 포커스, 모드, 컨트롤러, 필터 등)가
   * 새 문서에서 그대로 남아 요소 그리기 등의 동작을 방해하는 것을 방지한다.
   *
   * - 선택된 레이아웃 요소의 DOM 속성(`selected`, `text-focused`)을 제거한다.
   * - 포커스된 컨트롤러를 해제하고 blur 처리한다.
   * - 드래그/리사이즈 상태를 초기화한다.
   * - 모드(레이아웃 편집, 텍스트 편집, 삽입)를 모두 비활성화한다.
   * - 필터 역할/ID/루트를 초기화한다.
   * - 하위 컨트롤러(SelectionController 제외)를 detach/destroy한다.
   * - 클릭 소비 핸들러와 타이머를 정리한다.
   * - scale을 1로 원복한다.
   * - 이벤트 리스너는 제거하지 않는다 (React useEffect cleanup이 담당).
   *
    * @example
    * ```ts
    * // LayoutEditor unmount 시
    * React.useEffect(() => {
    *   return () => { layoutDocEl.editManager?.reset(); };
    * }, [layoutDocEl]);
    * ```
   */
  reset(): void {
    for (const el of this._selectedLayouts) {
      el.removeAttribute('selected');
      el.removeAttribute('text-focused');
    }
    this._selectedLayouts = [];

    this._blurFocusedParagraph();
    this._focusedController = null;
    this._lastFocusedBox = null;

    this._isLayoutDragging = false;
    this._isLayoutResizing = false;
    this._dragTargets = [];
    this._dragStartPositions.clear();

    this._modeChangeSuppressed = true;
    this.textEditMode = false;
    this.layoutEditMode = false;
    this.insertMode = null;
    this._modeChangeSuppressed = false;

    this._editableRoles = null;
    this._editableBoxIds = null;
    this._editableTextRoles = null;
    this._editableTextBoxIds = null;
    this._editableParagraphIds = null;
    this._selectableRoles = null;
    this._selectableBoxIds = null;
    this._selectableRootId = null;
    this._editableRootId = null;
    this._snapEnabled = true;
    this._spacePressed = false;

    if (this._layoutEditController) {
      this._layoutEditController.destroy();
      this._layoutEditController = null;
    }
    this._insertController = null;
    this._placeGunController = null;

    this._removeClickConsumeHandler();

    this._placeGunItems = [];
    this._placeGunPaused = false;
    this._multiSelect = false;
    this._scale = 1;

    this._dispatchModeChange({
      textEditMode: false,
      layoutEditMode: false,
      layoutEditType: 'move',
      insertMode: null,
    });
  }

  /** 현재 scale 보정 계수를 반환한다. */
  get scale(): number {
    return this._scale;
  }

  /** 보더 없는 box/td의 placeholder border 표시 여부를 반환한다. */
  get showPlaceholderBorders(): boolean {
    return this._showPlaceholderBorders;
  }

  /**
   * 보더 없는 box/td의 placeholder border 표시 여부를 설정한다.
   * 변경 시 모든 box/td에 `[show-placeholder-borders]` 속성을 토글하여
   * CSS 규칙이 즉시 반응하도록 하고, document의 가이드 컬럼 표시도
   * 함께 토글한다.
   */
  set showPlaceholderBorders(value: boolean) {
    if (this._showPlaceholderBorders === value) return;
    this._showPlaceholderBorders = value;
    const boxes = this._docEl.querySelectorAll('x-layout-box');
    for (const el of boxes) {
      if (value) {
        el.setAttribute('show-placeholder-borders', '');
      } else {
        el.removeAttribute('show-placeholder-borders');
      }
    }
    const tds = this._docEl.querySelectorAll('x-layout-td');
    for (const el of tds) {
      (el as unknown as { layout: () => void }).layout();
    }
    this._docEl.visibleGuide = value;
  }

  /**
   * 화면 clientX/clientY 픽셀 좌표를 mm으로 환산한다.
   * `transform: scale(s)` 환경에서 `getBoundingClientRect()`가 반환하는 픽셀과
   * 같은 좌표계이므로 `originalPpm * s`로 나누어 정확하게 환산한다.
   *
   * @example
   * ```ts
   * const leftMm = manager.screenPxToMm(event.clientX - rect.left);
   * ```
   */
  screenPxToMm(px: number): number {
    return px / (this._docEl.ppm * this._scale);
  }

  /**
   * 화면 픽셀 델타(deltaX/deltaY)를 mm 델타로 환산한다.
   * `screenPxToMm`의 델타 전용 wrapper.
   */
  screenDeltaToMm(deltaPx: number): number {
    return deltaPx / (this._docEl.ppm * this._scale);
  }

  /**
   * 편집 컨트롤러를 등록한다.
   * `TextEditController` 생성자에서 호출된다.
   * @internal
   */
  _register(controller: TextEditController): void {
    this._controllers.add(controller);
  }

  /**
   * 편집 컨트롤러를 해제한다.
   * `TextEditController.destroy()`에서 호출된다.
   * 포커스된 컨트롤러가 해제되면 포커스를 null로 설정한다.
   * @internal
   */
  _unregister(controller: TextEditController): void {
    this._controllers.delete(controller);
    if (this._focusedController === controller) {
      const previousParagraph = controller['_paragraph'] as LayoutParagraphElement;
      this._clearBoxSelectionForParagraph(previousParagraph);

      const parentBox = previousParagraph?.parentElement;
      if (parentBox instanceof LayoutBoxElement && this._selectedLayouts.includes(parentBox)) {
        const previousLayouts = [...this._selectedLayouts];
        parentBox.removeAttribute('selected');
        this._selectedLayouts = this._selectedLayouts.filter(el => el !== parentBox);
        this._dispatchLayoutSelection(previousLayouts);
      }

      this._lastFocusedBox = null;
      this._focusedController = null;
      this._dispatch('focusChange', null, previousParagraph, controller);
    }
  }

  /**
   * 포커스를 요청한다.
   * `TextEditController._onFocus()`에서 호출된다.
   * 다른 컨트롤러가 포커스를 가지고 있으면 해당 컨트롤러의 선택 영역을 해제하고
   * blur 처리한 후, 새 컨트롤러에게 포커스를 부여한다.
   * @internal
   */
  _requestFocus(controller: TextEditController): void {
    if (this._focusedController === controller) return;

    const previousController = this._focusedController;
    const previousParagraph = previousController?.['_paragraph'] as LayoutParagraphElement | undefined;

    // _blurInternal이 _releaseFocus를 호출하여 focusChange를 dispatch할 수 있으므로,
    // 먼저 _focusedController를 null로 설정하여 _releaseFocus가 no-op이 되도록 한다.
    this._focusedController = null;

    if (previousController) {
      (previousController as unknown as { _clearSelection(): void })._clearSelection();
      (previousController as unknown as { _blurInternal(): void })._blurInternal();
    }

    if (previousParagraph) {
      this._clearBoxSelectionForParagraph(previousParagraph);
    }
    const newParagraph = controller['_paragraph'] as LayoutParagraphElement;
    this._selectBoxForParagraph(newParagraph);
    this._lastFocusedBox = newParagraph.parentElement instanceof LayoutBoxElement
      ? newParagraph.parentElement
      : null;
    this._focusedController = controller;
    this._dispatch('focusChange', controller, previousParagraph ?? null, previousController);
  }

  /**
   * 포커스를 해제한다.
   * `TextEditController._onBlur()`에서 호출된다.
   * @internal
   */
  _releaseFocus(controller: TextEditController): void {
    if (this._focusedController !== controller) return;
    const previousParagraph = controller['_paragraph'] as LayoutParagraphElement;
    this._clearBoxSelectionForParagraph(previousParagraph);
    this._focusedController = null;
    this._dispatch('focusChange', null, previousParagraph, controller);

    if (controller._consumePendingTextChange()) {
      this._dispatch('textChange', controller);
    }
  }

  /**
   * 텍스트 변경 이벤트를 발생시킨다.
   * `TextEditController`에서 텍스트가 변경될 때 호출된다.
   * @internal
   */
  _notifyTextChange(controller: TextEditController): void {
    this._dispatch('textChange', controller);
  }

  /**
   * 텍스트 변경 이벤트를 외부에서 발생시킨다.
   *
   * `TextEditController`를 거치지 않고 텍스트가 변경되는 경로
   * (PlaceGun 주입, AI fit 등)에서 호출하여 `textChange` 이벤트를
   * 디스패치한다. 구독자(`LayoutEditor`의 동기화 핸들러 등)는
   * 이벤트 페이로드에 의존하지 않고 자체적으로 최신 `element.data`를
   * 읽어 React state와 동기화한다.
   *
   * @param paragraph - 텍스트가 변경된 paragraph 요소. 이벤트 페이로드의
   *   `paragraph` 필드에 설정된다.
   * @example
   * ```ts
   * const manager = layoutDocEl.editManager;
   * // PlaceGun/AI fit 등 컨트롤러 외부 경로에서 텍스트 주입 후
   * manager.notifyTextChange(paragraph);
   * ```
   */
  notifyTextChange(paragraph: LayoutParagraphElement): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('textChange');
    if (!listeners || listeners.size === 0) return;

    const event: EditManagerEvent = {
      type: 'textChange',
      paragraph,
      controller: null,
    };

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * 스타일 변경 이벤트를 발생시킨다.
   * `TextEditController`에서 스타일이 변경될 때 호출된다.
   * @internal
   */
  _notifyStyleChange(controller: TextEditController): void {
    this._dispatch('styleChange', controller);
  }

  /**
   * 선택 시작 이벤트를 발생시킨다.
   * `TextEditController`에서 선택이 시작될 때 호출된다.
   * @internal
   */
  _notifySelectionStart(controller: TextEditController): void {
    this._dispatch('selectionStart', controller);
  }

  /**
   * 선택 종료 이벤트를 발생시킨다.
   * `TextEditController`에서 선택이 종료될 때 호출된다.
   * @internal
   */
  _notifySelectionEnd(controller: TextEditController): void {
    this._dispatch('selectionEnd', controller);
  }

  /**
   * 커서 이동 이벤트를 발생시킨다.
   * 키보드 입력, 마우스 클릭, 외부 API 등 커서 위치가 변경될 때 호출된다.
   * 키보드 연속 입력 시 최초 KeyDown과 마지막 KeyUp에만 발생한다.
   * @internal
   */
  _notifyCursorMove(controller: TextEditController): void {
    this._dispatch('cursorMove', controller);
  }

  /**
   * 이벤트 리스너를 등록한다.
   */
  addEventListener(type: EditManagerEventType, listener: EditManagerEventListener): void {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type)!.add(listener);
  }

  /**
   * 이벤트 리스너를 제거한다.
   */
  removeEventListener(type: EditManagerEventType, listener: EditManagerEventListener): void {
    this._listeners.get(type)?.delete(listener);
  }

  /**
   * 현재 포커스된 단락 요소를 반환한다.
   * 포커스된 단락이 없으면 `null`이다.
   */
  get focusedParagraph(): LayoutParagraphElement | null {
    return this._focusedController?.['_paragraph'] as LayoutParagraphElement | null ?? null;
  }

  /**
   * 현재 포커스된 편집 컨트롤러를 반환한다.
   * 포커스된 컨트롤러가 없으면 `null`이다.
   */
  get focusedController(): TextEditController | null {
    return this._focusedController;
  }

  /**
   * 현재 커서 위치를 반환한다.
   * 포커스된 단락이 없으면 `null`이다.
   */
  get cursorOffset(): number | null {
    return this._focusedController?.cursorOffset ?? null;
  }

  /**
   * 현재 선택 영역을 반환한다.
   * 선택이 없거나 포커스된 단락이 없으면 `null`이다.
   * DOM의 `Selection` API와 유사하게 현재 selection 객체를 직접 조회할 수 있다.
   */
  get selection(): SelectionRange | null {
    return this._focusedController?.selection ?? null;
  }

  /**
   * 현재 커서 위치에서 유효한 스타일을 반환한다.
   * 포커스된 단락이 없으면 `null`이다.
   */
  get currentStyle(): CurrentStyle | null {
    return this._focusedController?.currentStyle ?? null;
  }

  /**
   * 등록된 모든 편집 컨트롤러를 반환한다.
   */
  get controllers(): Set<TextEditController> {
    return new Set(this._controllers);
  }

  /**
   * 단락 요소 또는 ID로 포커스를 설정한다.
   *
   * 지정된 단락이 편집 모드가 아니면 `editable = true`로 설정하여
   * `TextEditController`를 생성한 뒤 포커스를 부여한다.
   * 단락을 찾을 수 없거나 등록되지 않은 경우 `false`를 반환한다.
   *
   * @param target - 포커스를 설정할 단락 요소 또는 단락 요소의 ID
   * @param options - 커서 위치 및 선택 영역 설정 옵션 (선택 사항)
   * @param options.cursorOffset - 포커스 후 커서를 배치할 소스 텍스트 오프셋.
   *   생략하면 커서 위치를 변경하지 않는다.
   * @param options.selection - 포커스 후 설정할 선택 영역.
   *   `cursorOffset`과 함께 지정하면 `selection`의 적용이 우선이며,
   *   커서 위치는 `selection.focus.textOffset`으로 설정된다.
   * @returns 포커스 설정 성공 여부
   */
  focusParagraph(
    target: LayoutParagraphElement | string,
    options?: { cursorOffset?: number; selection?: SelectionRange },
  ): boolean {
    if (!this._textEditMode) return false;
    let paragraph: LayoutParagraphElement | null;

    if (typeof target === 'string') {
      const element = this._docEl.querySelector('#' + CSS.escape(target));
      paragraph = element instanceof LayoutParagraphElement
        ? element
        : null;
    } else {
      paragraph = target;
    }

    if (!paragraph) return false;

    if (!paragraph.editableText) {
      paragraph.editableText = true;
    }

    let controller = this._findControllerByParagraph(paragraph);
    if (!controller) {
      paragraph.editableText = false;
      paragraph.editableText = true;
      controller = this._findControllerByParagraph(paragraph);
    }
    if (!controller) return false;

    controller.focus();

    if (options?.selection) {
      controller.setSelection(options.selection);
    } else if (options?.cursorOffset !== undefined) {
      controller.setCursor({ textOffset: options.cursorOffset });
    }

    return true;
  }

  /**
   * 단락 요소에 해당하는 편집 컨트롤러를 찾는다.
   */
  private _findControllerByParagraph(paragraph: LayoutParagraphElement): TextEditController | null {
    for (const controller of this._controllers) {
      if ((controller as unknown as { _paragraph: LayoutParagraphElement })._paragraph === paragraph) {
        return controller;
      }
    }
    return null;
  }

  /**
   * 단락 요소 또는 ID로 포커스를 해제한다.
   *
   * 지정된 단락이 현재 포커스된 단락이면 커서와 선택 영역을 숨기고
   * `focusChange` 이벤트를 발생시킨다. 포커스된 단락이 아니면 아무 동작도 하지 않는다.
   *
   * `target`을 생략하면 현재 포커스된 단락의 포커스를 해제한다.
   *
   * @param target - 포커스를 해제할 단락 요소, 단락 요소의 ID, 또는 생략
   * @returns 포커스 해제 성공 여부. 포커스된 단락이 없으면 `false`.
   */
  blurParagraph(target?: LayoutParagraphElement | string): boolean {
    if (!this._focusedController) return false;

    if (target === undefined) {
      (this._focusedController as unknown as { _blurInternal(): void })._blurInternal();
      return true;
    }

    let paragraph: LayoutParagraphElement | null;

    if (typeof target === 'string') {
      const element = this._docEl.querySelector('#' + CSS.escape(target));
      paragraph = element instanceof LayoutParagraphElement
        ? element
        : null;
    } else {
      paragraph = target;
    }

    if (!paragraph) return false;

    const currentParagraph = this._focusedController['_paragraph'] as LayoutParagraphElement;
    if (currentParagraph !== paragraph) return false;

    (this._focusedController as unknown as { _blurInternal(): void })._blurInternal();
    return true;
  }

  /**
   * 모든 단락의 편집 모드를 비활성화한다.
   */
  deactivateAll(): void {
    this.textEditMode = false;
  }

  // ─── Text Edit Mode ───────────────────────────────────────────

  private _textEditMode: boolean = false;
  private _editableTextRoles: Set<BoxRole> | null = null;
  private _editableTextBoxIds: Set<string> | null = null;
  private _editableParagraphIds: Set<string> | null = null;

  /**
   * 텍스트 편집 모드 활성 여부.
   *
   * `true`이면 `isParagraphEditable()` 통과 시 paragraph 편집(커서, 선택, IME 입력)이 가능하다.
   * `false`이면 모든 paragraph가 편집 불가이며 포커스가 해제된다.
   *
   * 활성화 시 `editableTextRoles`/`editableTextBoxIds`/`editableParagraphIds`를
   * 명시적으로 지정하지 않으면 lock과 `editableRootId` 제한을 제외한 모든
   * paragraph가 편집 가능하다 (모두 허용 규칙).
   *
   * @example
   * ```ts
   * const manager = layoutDocEl.editManager;
   * manager.setEditableTextRoles(['body', 'title']);
   * manager.textEditMode = true;
   * // → 부모 box role이 'body' 또는 'title'인 paragraph만 편집 가능
   * ```
   */
  get textEditMode(): boolean { return this._textEditMode; }
  set textEditMode(value: boolean) {
    if (this._textEditMode === value) return;
    const prevMode = this._getModeState();
    if (value) {
      this._modeChangeSuppressed = true;
      this.layoutEditMode = false;
      this.insertMode = null;
      this._modeChangeSuppressed = false;
      this._reduceSelectionToSingleForTextMode();
    }
    this._textEditMode = value;
    if (!value) {
      this._blurFocusedParagraph();
      this._applyEditableTextToAllParagraphs();
    } else {
      this._applyEditableTextToAllParagraphs();
    }
    this._dispatchModeChange(prevMode);
  }



  /**
   * 편집 허용 box role 집합 (텍스트 편집용). `null`이면 role 기반 제한 없음.
   *
   * paragraph의 부모 box role이 이 집합에 포함되어야 편집 가능하다.
   *
   * @param roles - 허용할 BoxRole 배열. `null`이면 role 제한 해제.
   *
   * @example
   * ```ts
   * manager.setEditableTextRoles(['body', 'title', 'none']);
   * manager.setEditableTextRoles(null);  // role 제한 없음
   * ```
   */
  setEditableTextRoles(roles: BoxRole[] | null): void {
    this._editableTextRoles = roles === null ? null : new Set(roles);
    if (this._textEditMode) this._applyEditableTextToAllParagraphs();
  }

  get editableTextRoles(): ReadonlySet<BoxRole> | null {
    return this._editableTextRoles;
  }

  /**
   * 편집 허용 box id 집합 (텍스트 편집용). `null`이면 box id 기반 제한 없음.
   *
   * paragraph의 부모 box id가 이 집합에 포함되어야 편집 가능하다.
   *
   * @param ids - 허용할 box id 배열. `null`이면 box id 제한 해제.
   */
  setEditableTextBoxIds(ids: string[] | null): void {
    this._editableTextBoxIds = ids === null ? null : new Set(ids);
    if (this._textEditMode) this._applyEditableTextToAllParagraphs();
  }

  get editableTextBoxIds(): ReadonlySet<string> | null {
    return this._editableTextBoxIds;
  }

  /**
   * 편집 허용 paragraph id 집합. `null`이면 paragraph id 기반 제한 없음.
   *
   * paragraph 자체의 id가 이 집합에 포함되어야 편집 가능하다.
   *
   * @param ids - 허용할 paragraph id 배열. `null`이면 paragraph id 제한 해제.
   */
  setEditableParagraphIds(ids: string[] | null): void {
    this._editableParagraphIds = ids === null ? null : new Set(ids);
    if (this._textEditMode) this._applyEditableTextToAllParagraphs();
  }

  get editableParagraphIds(): ReadonlySet<string> | null {
    return this._editableParagraphIds;
  }

  /**
   * 개별 paragraph id를 텍스트 편집 허용 목록에 추가한다.
   *
   * @param id - 추가할 paragraph id
   */
  addEditableParagraph(id: string): void {
    if (this._editableParagraphIds === null) {
      this._editableParagraphIds = new Set();
    }
    this._editableParagraphIds.add(id);
    if (this._textEditMode) this._applyEditableTextToAllParagraphs();
  }

  /**
   * 개별 paragraph id를 텍스트 편집 허용 목록에서 제거한다.
   *
   * @param id - 제거할 paragraph id
   */
  removeEditableParagraph(id: string): void {
    if (this._editableParagraphIds === null) return;
    this._editableParagraphIds.delete(id);
    if (this._textEditMode) this._applyEditableTextToAllParagraphs();
  }

  /**
   * 특정 paragraph가 텍스트 편집 가능한지 판별한다.
   *
   * 판별 규칙:
   * 1. `_textEditMode`가 `true`여야 함
   * 2. 조상 box 중 lock이 없어야 함
   * 3. `_editableRootId`가 지정된 경우, paragraph가 Root 내부에 있어야 함
   * 4. `_editableTextRoles`가 `null`이 아니면 부모 box의 role이 Set에 포함되어야 함
   * 5. `_editableTextBoxIds`가 `null`이 아니면 부모 box의 id가 Set에 포함되어야 함
   * 6. `_editableParagraphIds`가 `null`이 아니면 paragraph 자체 id가 Set에 포함되어야 함
   * 7. 모든 필터가 `null`이면 Root 내부의 모든 paragraph 편집 가능
   *
   * @param paragraph - 판별할 paragraph 요소
   * @returns 편집 가능 여부
   */
  isParagraphEditable(paragraph: LayoutParagraphElement): boolean {
    if (!this._textEditMode) return false;
    if (this._isAncestorBoxLocked(paragraph)) return false;
    if (!this._isWithinEditableRoot(paragraph)) return false;

    const parentBox = paragraph.parentElement;
    if (this._editableTextRoles !== null) {
      if (!parentBox || !this._editableTextRoles.has(parentBox.role)) return false;
    }
    if (this._editableTextBoxIds !== null) {
      if (!parentBox || !this._editableTextBoxIds.has(parentBox.id)) return false;
    }
    if (this._editableParagraphIds !== null) {
      if (!this._editableParagraphIds.has(paragraph.id)) return false;
    }
    return true;
  }

  /**
   * box 자체 또는 조상 box 중 lock이 설정된 것이 있는지 확인한다.
   *
   * @param box - 확인할 box 요소
   * @returns lock된 box가 하나라도 있으면 `true`
   */
  private _isBoxOrAncestorLocked(box: LayoutElement): boolean {
    let current: LayoutElement | null = box;
    while (current) {
      if (current instanceof LayoutBoxElement && current.lock) return true;
      current = current.parentElement instanceof LayoutBoxElement || current.parentElement instanceof LayoutTableCellElement
        ? (current.parentElement as LayoutElement)
        : null;
    }
    return false;
  }

  /**
   * 요소의 조상 box 중 lock이 설정된 것이 있는지 확인한다.
   * paragraph 등 box가 아닌 요소의 편집 가능 여부 판별에 사용된다.
   *
   * @param element - 확인할 요소 (paragraph 등)
   * @returns 조상 box 중 lock된 것이 있으면 `true`
   */
  private _isAncestorBoxLocked(element: Element): boolean {
    let current: Element | null = element.parentElement;
    while (current) {
      if (current instanceof LayoutBoxElement && current.lock) return true;
      current = current.parentElement;
    }
    return false;
  }

  /**
   * 현재 포커스된 단락의 포커스를 해제한다.
   */
  private _blurFocusedParagraph(): void {
    if (this._focusedController) {
      (this._focusedController as unknown as { _blurInternal(): void })._blurInternal();
    }
  }

  /**
   * 현재 포커스된 단락의 부모 box를 반환한다.
   * 포커스된 단락이 없으면 `_lastFocusedBox`를 폴백으로 사용한다.
   * 둘 다 없으면 `null`을 반환한다.
   *
   * @returns 포커스된 단락의 부모 box, 폴백 box, 또는 `null`
   */
  private _getFocusedParentBox(): LayoutBoxElement | null {
    const focusedParagraph = this._focusedController?.['_paragraph'] as LayoutParagraphElement | undefined;
    const focusedParentBox = focusedParagraph?.parentElement;
    return (focusedParentBox instanceof LayoutBoxElement ? focusedParentBox : null)
      ?? this._lastFocusedBox;
  }

  /**
   * 텍스트 편집 포커스가 들어온 paragraph의 부모 box를 레이아웃 선택한다.
   * 기존 선택은 모두 해제하고 부모 box만 단일 선택으로 설정한다.
   * 텍스트 편집 모드는 단일 paragraph 포커스만 허용하므로 멀티선택을 허용하지 않는다.
   *
   * @param paragraph - 포커스를 얻은 단락. null이면 아무 일도 하지 않는다.
   */
  private _selectBoxForParagraph(paragraph: LayoutParagraphElement | null): void {
    if (!paragraph) return;
    const parentBox = paragraph.parentElement;
    if (!(parentBox instanceof LayoutBoxElement)) return;

    const previousLayouts = [...this._selectedLayouts];
    const isAlreadySelected = this._selectedLayouts.length === 1 && this._selectedLayouts[0] === parentBox;

    if (!isAlreadySelected) {
      for (const prev of this._selectedLayouts) {
        prev.removeAttribute('selected');
        prev.removeAttribute('text-focused');
      }
      this._selectedLayouts = [parentBox];
      parentBox.setAttribute('selected', '');
    }
    parentBox.setAttribute('text-focused', '');
    this._dispatchLayoutSelection(previousLayouts);
  }

  /**
   * 텍스트 편집 포커스가 해제되어도 레이아웃 선택은 유지된다.
   * 단, `text-focused` 속성은 제거하여 라벨이 다시 표시되도록 한다.
   *
   * @param paragraph - 포커스를 잃은 단락. null이면 아무 일도 하지 않는다.
   */
  private _clearBoxSelectionForParagraph(paragraph: LayoutParagraphElement | null): void {
    if (!paragraph) return;
    const parentBox = paragraph.parentElement;
    if (parentBox instanceof LayoutBoxElement) {
      parentBox.removeAttribute('text-focused');
    }
  }

  /**
   * 텍스트 편집 모드 진입 시 멀티 선택을 단일 선택으로 줄인다.
   *
   * 선택된 항목 중 `contentType === 'paragraph'`인 box가 있으면
   * 그중 DOM 순서상 가장 위에 있는 항목만 남기고 모두 선택 해제한다.
   * 그렇지 않으면 가장 위에 있는 항목만 남기고 모두 선택 해제한다.
   */
  private _reduceSelectionToSingleForTextMode(): void {
    if (this._selectedLayouts.length === 0) return;

    const paragraphBoxes = this._selectedLayouts.filter(
      (el): el is LayoutBoxElement => el instanceof LayoutBoxElement && el.contentType === 'paragraph'
    );

    const target = paragraphBoxes.length > 0 ? paragraphBoxes[0] : this._selectedLayouts[0];
    if (!target) return;

    if (this._selectedLayouts.length > 1) {
      const previousLayouts = [...this._selectedLayouts];
      for (const el of this._selectedLayouts) {
        if (el !== target) {
          el.removeAttribute('selected');
          el.removeAttribute('text-focused');
        }
      }
      this._selectedLayouts = [target];
      this._dispatchLayoutSelection(previousLayouts);
    }

    if (target instanceof LayoutBoxElement) {
      const paragraph = target.querySelector('x-layout-paragraph');
      if (paragraph instanceof LayoutParagraphElement) {
        this.focusParagraph(paragraph);
      }
    }
  }

  /**
   * 현재 편집 가능 상태에 따라 문서 내 모든 paragraph의 `editableText` 속성을 갱신한다.
   * `isParagraphEditable()` 결과를 paragraph별로 적용한다.
   */
  private _applyEditableTextToAllParagraphs(): void {
    const paragraphs = this._docEl.querySelectorAll<LayoutParagraphElement>('x-layout-paragraph');
    paragraphs.forEach((paragraph) => {
      const editable = this.isParagraphEditable(paragraph);
      if (paragraph.editableText !== editable) {
        paragraph.editableText = editable;
      }
    });
  }

  /**
   * 레이아웃 편집 모드 활성 여부.
   *
   * `true`이면 레이아웃 편집이 활성화되어 `isBoxEditable()` 통과 시 box 편집(드래그/리사이즈)이 가능하다.
   * `false`이면 모든 box가 편집 불가이며 선택도 해제된다.
   *
   * 활성화 시 `editableRoles`/`editableBoxIds`를 명시적으로 지정하지 않으면
   * lock과 `editableRootId` 제한을 제외한 모든 box가 편집 가능하다 (모두 허용 규칙).
   *
   * @example
   * ```ts
   * const manager = layoutDocEl.editManager;
   * manager.setEditableRoles(['body', 'title']);
   * manager.layoutEditMode = true;
   * // → role이 'body' 또는 'title'인 box만 편집 가능
   *
   * // 부모 변경(reparent) 모드: box를 다른 컨테이너로 옮기거나 빼낼 수 있다
   * manager.layoutEditMode = { type: 'reparent' };
   * ```
   *
   * @param value - `true`/`false` 또는 `{ type: 'move' | 'reparent' }`.
   *                `true`는 `{ type: 'move' }`와 동일.
   */
  get layoutEditMode(): boolean { return this._layoutEditMode; }
  set layoutEditMode(value: LayoutEditModeInput) {
    // 입력 정규화: boolean → { type: 'move' | (비활성) }
    let nextActive: boolean;
    let nextType: LayoutEditType;
    if (value === false) {
      nextActive = false;
      nextType = this._layoutEditType; // 유지 (다시 켤 때 복원)
    } else if (value === true) {
      nextActive = true;
      nextType = 'move';
    } else {
      nextActive = true;
      nextType = value.type;
    }

    // 동일 상태면 no-op
    if (this._layoutEditMode === nextActive && this._layoutEditType === nextType) return;

    const prevMode = this._getModeState();
    if (nextActive) {
      this._modeChangeSuppressed = true;
      this.textEditMode = false;
      this.insertMode = null;
      this._modeChangeSuppressed = false;
    }
    this._layoutEditMode = nextActive;
    this._layoutEditType = nextType;
    this._applyEditableLayoutToAllBoxes();
    this._updateControllers();
    this._dispatchModeChange(prevMode);
  }

  /**
   * 현재 레이아웃 편집 모드의 동작 타입.
   *
   * - `'move'`: 기본 이동 모드. 부모 내부에서만 이동 (경계 클램핑 적용).
   * - `'reparent'`: 부모 변경 모드. 드래그로 box를 자유롭게 이동하고
   *   mouseup 시 커서 위치의 컨테이너로 reparenting.
   *
   * `layoutEditMode`가 `false`일 때도 이전 타입을 유지하여 반환한다.
   */
  get layoutEditType(): LayoutEditType { return this._layoutEditType; }

  private _updateControllers(): void {
    if (this._selectionController) {
      this._selectionController.attach();
    }

    if (this._layoutEditMode) {
      if (!this._layoutEditController) {
        this._layoutEditController = new LayoutEditController(this._docEl, this);
      }
      this._layoutEditController.attach();
    } else {
      if (this._layoutEditController) {
        this._layoutEditController.detach();
      }
    }
  }

  /**
   * 선택 허용 role 집합. `null`이면 role 기반 제한 없음.
   * 선택 전용 필터가 설정되면 편집 필터 대신 사용된다.
   *
   * @param roles - 선택 허용할 BoxRole 배열. `null`이면 role 제한 해제.
   *
   * @example
   * ```ts
   * manager.setSelectableRoles(['body', 'title']);
   * // body, title box만 선택 가능
   * ```
   */
  setSelectableRoles(roles: BoxRole[] | null): void {
    this._selectableRoles = roles === null ? null : new Set(roles);
  }

  get selectableRoles(): ReadonlySet<BoxRole> | null {
    return this._selectableRoles;
  }

  /**
   * 선택 허용 box id 집합. `null`이면 id 기반 제한 없음.
   * 선택 전용 필터가 설정되면 편집 필터 대신 사용된다.
   *
   * @param ids - 선택 허용할 box id 배열. `null`이면 id 제한 해제.
   */
  setSelectableBoxIds(ids: string[] | null): void {
    this._selectableBoxIds = ids === null ? null : new Set(ids);
  }

  get selectableBoxIds(): ReadonlySet<string> | null {
    return this._selectableBoxIds;
  }

  /**
   * 선택 루트 box id. `null`이면 제한 없음.
   * 지정 시 해당 box 내부 요소만 선택 가능, Root 자체는 선택 불가.
   * 선택 전용 루트가 설정되면 편집 루트 대신 사용된다.
   *
   * @param id - 선택 루트 box id. `null`이면 제한 해제.
   */
  setSelectableRootId(id: string | null): void {
    this._selectableRootId = id;
  }

  get selectableRootId(): string | null {
    return this._selectableRootId;
  }

  /**
   * 편집 허용 role 집합. `null`이면 role 기반 제한 없음.
   *
   * @param roles - 허용할 BoxRole 배열. `null`이면 role 제한 해제.
   *
   * @example
   * ```ts
   * manager.setEditableRoles(['body', 'title', 'none']);  // 본문, 제목, 역할 없는 box 허용
   * manager.setEditableRoles(null);                         // role 제한 없음
   * ```
   */
  setEditableRoles(roles: BoxRole[] | null): void {
    this._editableRoles = roles === null ? null : new Set(roles);
    if (this._layoutEditMode) this._applyEditableLayoutToAllBoxes();
  }

  get editableRoles(): ReadonlySet<BoxRole> | null {
    return this._editableRoles;
  }

  /**
   * 편집 허용 box id 집합. `null`이면 id 기반 제한 없음.
   *
   * @param ids - 허용할 box id 배열. `null`이면 id 제한 해제.
   *
   * @example
   * ```ts
   * manager.setEditableBoxIds(['box-1', 'box-2']);
   * manager.addEditableBox('box-3');       // 개별 추가
   * manager.removeEditableBox('box-1');    // 개별 제거
   * ```
   */
  setEditableBoxIds(ids: string[] | null): void {
    this._editableBoxIds = ids === null ? null : new Set(ids);
    if (this._layoutEditMode) this._applyEditableLayoutToAllBoxes();
  }

  get editableBoxIds(): ReadonlySet<string> | null {
    return this._editableBoxIds;
  }

  /**
   * 개별 box id를 편집 허용 목록에 추가한다.
   * `_editableBoxIds`가 `null`이면 새 Set을 생성한다.
   *
   * @param id - 추가할 box id
   */
  addEditableBox(id: string): void {
    if (this._editableBoxIds === null) {
      this._editableBoxIds = new Set();
    }
    this._editableBoxIds.add(id);
    if (this._layoutEditMode) this._applyEditableLayoutToAllBoxes();
  }

  /**
   * 개별 box id를 편집 허용 목록에서 제거한다.
   *
   * @param id - 제거할 box id
   */
  removeEditableBox(id: string): void {
    if (this._editableBoxIds === null) return;
    this._editableBoxIds.delete(id);
    if (this._layoutEditMode) this._applyEditableLayoutToAllBoxes();
  }

  /**
   * 편집 루트 box id를 설정한다.
   *
   * `null`이 아닌 값을 설정하면, 해당 box 내부의 요소만 편집 가능하다.
   * 루트 box 자체는 이동/크기 조정이 불가하다 (편집 컨테이너 역할).
   * `null`을 설정하면 루트 제한이 해제되어 문서 전체가 편집 대상이 된다.
   *
   * layout 편집 모드와 text 편집 모드 모두에 공유되어 적용된다.
   *
   * @example
   * ```ts
   * manager.setEditableRootId('box-1');
   * manager.setEditableRoles(['body']);
   * manager.layoutEditMode = true;
   * // → box-1 내부의 role='body' box만 편집 가능
   * // → box-1 자체는 편집 불가 (컨테이너)
   * // → box-1 외부의 box는 편집 불가
   * ```
   */
  setEditableRootId(id: string | null): void {
    this._editableRootId = id;
    if (this._layoutEditMode) this._applyEditableLayoutToAllBoxes();
    if (this._textEditMode) this._applyEditableTextToAllParagraphs();
  }

  get editableRootId(): string | null {
    return this._editableRootId;
  }

  /** 드래그/리사이즈 시 그리드 스냅 활성 여부. */
  get snapEnabled(): boolean {
    return this._snapEnabled;
  }

  set snapEnabled(value: boolean) {
    this._snapEnabled = value;
  }

  /** 스페이스 키 누름 여부. 팬 모드에서 마키/드래그 억제용. */
  get spacePressed(): boolean {
    return this._spacePressed;
  }

  set spacePressed(value: boolean) {
    this._spacePressed = value;
  }

  /**
   * 요소가 지정된 선택 루트 box의 내부(자손)에 있는지 확인한다.
   *
   * 선택 전용 루트(`_selectableRootId`)가 설정되면 그것을 사용하고,
   * 아니면 편집 루트(`_editableRootId`)를 사용한다.
   * 둘 다 null이면 제한 없이 `true`를 반환한다.
   *
   * @param element - 확인할 요소
   * @returns 루트가 지정되지 않았거나, 요소가 루트의 자손이면 `true`.
   *           요소가 루트 자체이거나 루트 외부이면 `false`.
   */
  private _isWithinSelectableRoot(element: Element): boolean {
    const rootId = this._selectableRootId ?? this._editableRootId;
    if (rootId === null) return true;
    if (element.id === rootId) return false;
    let current: Element | null = element.parentElement;
    while (current) {
      if (current.id === rootId) return true;
      current = current.parentElement;
    }
    return false;
  }

  /**
   * 요소가 지정된 루트 box의 내부(자손)에 있는지 확인한다.
   *
   * @param element - 확인할 요소
   * @returns 루트가 지정되지 않았거나, 요소가 루트의 자손이면 `true`.
   *           요소가 루트 자체이거나 루트 외부이면 `false`.
   */
  private _isWithinEditableRoot(element: Element): boolean {
    if (this._editableRootId === null) return true;
    if (element.id === this._editableRootId) return false;
    let current: Element | null = element.parentElement;
    while (current) {
      if (current.id === this._editableRootId) return true;
      current = current.parentElement;
    }
    return false;
  }

  /**
   * 특정 box가 레이아웃 편집 가능한지 판별한다.
   *
   * 판별 규칙:
   * 1. `_layoutEditMode`가 `true`여야 함
   * 2. box 자체 또는 조상 box 중 lock이 없어야 함
   * 3. `_editableRootId`가 지정된 경우, box가 Root 내부에 있어야 함 (Root 자체는 불가)
   * 4. `_editableRoles`가 `null`이 아니면 box.role이 Set에 포함되어야 함
   * 5. `_editableBoxIds`가 `null`이 아니면 box.id가 Set에 포함되어야 함
   * 6. 모든 필터가 `null`이면 Root 내부의 모든 box 편집 가능
   *
   * @param box - 판별할 box 요소
   * @returns 편집 가능 여부
   */
  isBoxEditable(box: LayoutElement): boolean {
    if (!this._layoutEditMode) return false;
    if (this._isBoxOrAncestorLocked(box)) return false;
    if (!this._isWithinEditableRoot(box)) return false;
    if (box instanceof LayoutBoxElement) {
      if (this._editableRoles !== null && !this._editableRoles.has(box.role)) return false;
      if (this._editableBoxIds !== null && !this._editableBoxIds.has(box.id)) return false;
    }
    return true;
  }

  /**
   * 특정 box가 선택 가능한지 판별한다.
   *
   * `isBoxEditable()`과 달리 `_layoutEditMode` 여부와 무관하게 동작한다.
   * 선택 전용 필터(`_selectableRoles`, `_selectableBoxIds`)가 설정되면 그에 따르고,
   * 설정이 없으면 편집 필터(`_editableRoles`, `_editableBoxIds`)를 대신 사용한다.
   * 루트 제한은 선택 전용 `_selectableRootId`를 우선하되, 없으면 `_editableRootId`를 사용한다.
   * lock 상태의 box는 선택할 수 없다.
   *
   * @param box - 판별할 box 요소
   * @returns 선택 가능 여부
   */
  isBoxSelectable(box: LayoutElement): boolean {
    if (this._isBoxOrAncestorLocked(box)) return false;
    const rootId = this._selectableRootId ?? this._editableRootId;
    if (rootId !== null) {
      if (box.id === rootId) return false;
      let parent: Element | null = box.parentElement;
      let found = false;
      while (parent) {
        if (parent.id === rootId) { found = true; break; }
        parent = parent.parentElement;
      }
      if (!found) return false;
    }
    if (box instanceof LayoutBoxElement) {
      const roles = this._selectableRoles ?? this._editableRoles;
      if (roles !== null && !roles.has(box.role)) return false;
      const ids = this._selectableBoxIds ?? this._editableBoxIds;
      if (ids !== null && !ids.has(box.id)) return false;
    }
    return true;
  }

  /**
   * 현재 편집 가능 상태에 따라 문서 내 모든 box의 `editableLayout` 속성을 갱신한다.
   * `isBoxEditable()` 결과를 box별로 적용한다.
   *
   * 동시에, 필터 변경으로 인해 더 이상 `isBoxSelectable()`을 통과하지 못하게 된
   * 선택된 box의 선택을 해제한다. 일반 모드에서 `editableRoles=null`로 모든 box가
   * 선택 가능했던 상태에서 레이아웃 편집 모드 진입 시 `editableRoles`가 좁혀지면,
   * 새 필터 기준에서 선택 불가능해진 box들은 자동으로 선택 해제된다.
   * 포커스된 paragraph의 부모 box는 텍스트 편집 포커스 유지를 위해 보존된다.
   */
  private _applyEditableLayoutToAllBoxes(): void {
    const boxes = this._docEl.querySelectorAll<LayoutBoxElement>('x-layout-box');
    boxes.forEach((box) => {
      const editable = this.isBoxEditable(box);
      if (box.editableLayout !== editable) {
        box.editableLayout = editable;
      }
    });

    this._pruneUnselectableSelections();
  }

  /**
   * 현재 선택된 레이아웃 요소 중 `isBoxSelectable()`을 통과하지 못하는 요소를
   * 선택에서 제거한다. 포커스된 paragraph의 부모 box는 보존한다.
   *
   * `setEditableRoles` / `setEditableBoxIds` / `setEditableRootId` / `layoutEditMode`
   * 변경 시 `_applyEditableLayoutToAllBoxes`를 통해 호출되어, 필터 좁힘으로 인해
   * 선택 불가능해진 box의 선택이 남지 않도록 한다.
   */
  private _pruneUnselectableSelections(): void {
    if (this._selectedLayouts.length === 0) return;
    const previousLayouts = [...this._selectedLayouts];
    const focusedParentBox = this._getFocusedParentBox();

    const removed: LayoutElement[] = [];
    const kept: LayoutElement[] = [];
    for (const el of this._selectedLayouts) {
      if (!this.isBoxSelectable(el) && el !== focusedParentBox) {
        el.removeAttribute('selected');
        el.removeAttribute('text-focused');
        removed.push(el);
      } else {
        kept.push(el);
      }
    }

    if (removed.length === 0) return;
    this._selectedLayouts = kept;
    this._dispatchLayoutSelection(previousLayouts);
  }

  /**
   * 레이아웃 요소를 선택한다.
   *
   * `isBoxSelectable()`을 통과한 box 요소만 선택할 수 있다.
   * 편집 모드가 꺼져 있어도 선택은 가능하다 (lock/root/role/id 필터만 적용).
   * `multi`가 `false`(기본값)이면 기존 선택을 모두 해제하고 지정된 요소만 선택한다.
   * `multi`가 `true`이면 기존 선택에 지정된 요소를 추가/토글한다.
   *
   * @param target - 선택할 레이아웃 요소, 요소의 ID, 또는 그 배열
   * @returns 선택 성공 여부. 하나도 선택하지 못하면 `false`
   */
  selectLayout(target: LayoutElement | string | (LayoutElement | string)[]): boolean {
    const targets = Array.isArray(target) ? target : [target];
    const newSelections: LayoutElement[] = [];

    for (const t of targets) {
      const element = this._resolveLayoutElement(t);
      if (!element) continue;
      if (this._isBoxOrAncestorLocked(element)) continue;
      if (!this._isWithinSelectableRoot(element)) continue;
      if (!this.isBoxSelectable(element)) continue;
      newSelections.push(element);
    }

    if (newSelections.length === 0) return false;

    const previousLayouts = [...this._selectedLayouts];

    // text-focused 속성은 텍스트 포커스 시스템이 소유하므로,
    // 포커스된 paragraph의 부모 box에서는 selectLayout이 제거하지 않는다.
    const focusedParentBox = this._getFocusedParentBox();

    if (this._multiSelect) {
      for (const el of newSelections) {
        const idx = this._selectedLayouts.indexOf(el);
        if (idx >= 0) {
          this._selectedLayouts.splice(idx, 1);
          el.removeAttribute('selected');
          if (el !== focusedParentBox) {
            el.removeAttribute('text-focused');
          }
        } else {
          this._selectedLayouts.push(el);
          el.setAttribute('selected', '');
        }
      }
    } else {
      for (const prev of this._selectedLayouts) {
        prev.removeAttribute('selected');
        if (prev !== focusedParentBox) {
          prev.removeAttribute('text-focused');
        }
      }
      this._selectedLayouts = newSelections;
      for (const el of newSelections) {
        el.setAttribute('selected', '');
      }
    }

    this._dispatchLayoutSelection(previousLayouts);
    return true;
  }

  /**
   * 단일 요소를 명시적으로 선택한다. `multiSelect` 상태와 무관하게
   * 기존 선택을 모두 제거하고 대상 요소만 선택하여 `layoutSelectionChange`를 1회 발생시킨다.
   *
   * 컨텍스트 메뉴 우클릭 등 clear+select를 원자적으로 수행해야 하는 경우 사용한다.
   *
   * @param target - 선택할 단일 레이아웃 요소.
   * @returns 선택 성공 여부. 대상이 검증을 통과하지 못하면 `false`를 반환하고
   *   기존 선택은 유지된다.
   */
  selectLayoutExclusive(target: LayoutElement | string): boolean {
    const element = this._resolveLayoutElement(target);
    if (!element) return false;
    if (this._isBoxOrAncestorLocked(element)) return false;
    if (!this._isWithinSelectableRoot(element)) return false;
    if (!this.isBoxSelectable(element)) return false;

    if (this._selectedLayouts.length === 1 && this._selectedLayouts[0] === element) return true;

    const previousLayouts = [...this._selectedLayouts];
    const focusedParentBox = this._getFocusedParentBox();

    for (const prev of this._selectedLayouts) {
      prev.removeAttribute('selected');
      if (prev !== focusedParentBox) {
        prev.removeAttribute('text-focused');
      }
    }

    this._selectedLayouts = [element];
    element.setAttribute('selected', '');

    this._dispatchLayoutSelection(previousLayouts);
    return true;
  }

  /**
   * 레이아웃 선택을 모두 해제한다.
   *
   * `preserveFocusedBox`가 `true`(기본값)이면 텍스트 편집 포커스가 있는
   * paragraph의 부모 box는 모드 전환 시에도 선택 상태를 유지한다.
   * `false`이면 포커스 box 보� 없이 모든 선택을 해제한다
   * (빈 공간 클릭 등 명시적 선택 해제 시 사용).
   *
   * @param preserveFocusedBox - 포커스된 paragraph의 부모 box 선택을 유지할지 여부.
   *   기본값 `true`. 빈 공간 클릭 등 명시적 해제 시 `false`로 호출한다.
   */
  clearLayoutSelection(preserveFocusedBox: boolean = true): void {
    if (this._selectedLayouts.length === 0) return;
    const previousLayouts = [...this._selectedLayouts];

    if (preserveFocusedBox) {
      const preserveBox = this._getFocusedParentBox();

      for (const el of this._selectedLayouts) {
        if (el === preserveBox) continue;
        el.removeAttribute('selected');
        el.removeAttribute('text-focused');
      }

      if (preserveBox) {
        this._selectedLayouts = [preserveBox];
      } else {
        this._selectedLayouts = [];
      }
    } else {
      this._lastFocusedBox = null;
      for (const el of this._selectedLayouts) {
        el.removeAttribute('selected');
        el.removeAttribute('text-focused');
      }
      this._selectedLayouts = [];
    }
    this._dispatchLayoutSelection(previousLayouts);
  }

  /**
   * 현재 선택된 레이아웃 요소들을 반환한다.
   */
  get selectedLayouts(): LayoutElement[] {
    return [...this._selectedLayouts];
  }

  /**
   * 현재 선택된 레이아웃 요소들의 ID 배열을 반환한다.
   */
  get selectedLayoutIds(): string[] {
    return this._selectedLayouts.map(el => el.id).filter(Boolean);
  }

  private _multiSelect = false;

  /** 드래그 중인 이동 대상 요소들 (중첩 하위 요소 제외) */
  private _dragTargets: LayoutBoxElement[] = [];
  /** 각 드래그 대상 요소의 시작 위치 */
  private _dragStartPositions: Map<LayoutBoxElement, { left: number; top: number }> = new Map();

  /**
   * 현재 삽입 모드를 반환한다. 활성화되지 않은 경우 `null`이다.
   */
  get insertMode(): InsertMode | null {
    return this._insertMode;
  }

  /**
   * 삽입 모드를 설정한다.
   *
   * `null`이 아닌 값을 설정하면 드래그-삽입 모드가 활성화되어
   * 문서 표면에서 드래그로 새 요소를 그릴 수 있다.
   * `null`을 설정하면 삽입 모드가 비활성화된다.
   */
  set insertMode(mode: InsertMode | null) {
    if (this._insertMode === mode) return;

    const isDragging = this._insertController?.isDragging ?? false;
    const prevMode = this._getModeState();

    if (mode) {
      // 다른 편집 모드는 드래그 중에도 반드시 비활성화한다.
      // isDragging 우회는 커서 변경/선택 해제 등 드래그를 방해하는 부작용에만 적용한다.
      this._modeChangeSuppressed = true;
      this.layoutEditMode = false;
      this.textEditMode = false;
      this._modeChangeSuppressed = false;

      if (!isDragging) {
        this.clearLayoutSelection(false);
      }

      const docEl = this._docEl;
      if (!docEl.isConnected) {
        throw new Error('EditManager.insertMode: 문서 요소(x-layout-document)가 연결되어 있지 않습니다.');
      }

      if (!isDragging) {
        this._docEl.querySelectorAll<LayoutBoxElement>('x-layout-box').forEach((box) => {
          box.style.cursor = 'crosshair';
        });
      }

      if (!this._insertController) {
        this._insertController = new InsertController(docEl, this);
      }
      this._insertController.setMode(mode);
      this._insertMode = mode;
    } else {
      if (this._insertController) {
        this._insertController.setMode(null);
      }
      this._insertMode = null;

      this._docEl.querySelectorAll<LayoutBoxElement>('x-layout-box').forEach((box) => {
        box.style.cursor = '';
      });
    }
    this._dispatchModeChange(prevMode);
  }

  /**
   * 삽입 모드를 활성화한다. `insertMode = mode`와 동일하다.
   */
  activateInsert(mode: InsertMode): void {
    this.insertMode = mode;
  }

  /**
   * 삽입 모드 중 mousedown 이벤트를 InsertController에 위임한다.
   * 레이아웃 편집 핸들러(_onLayoutMouseDown 등)에서 삽입 모드일 때 호출한다.
   */
  handleInsertMouseDown(event: MouseEvent): void {
    if (!this._insertController || !this._insertMode) return;
    this._insertController.startDrag(event);
  }

  /**
   * Place Gun 활성 상태에서 box mousedown 이벤트를 PlaceGunController에 위임한다.
   * `LayoutBoxElement`의 mousedown 핸들러에서 호출한다.
   *
   * @param box - mousedown이 발생한 box 요소
   * @param event - mousedown 이벤트
   * @returns 주입 성공 여부
   */
  handlePlaceGunMouseDown(box: LayoutBoxElement, event: MouseEvent): boolean {
    if (!this._placeGunController || !this.placeGunActive) return false;
    return this._placeGunController.handleBoxMouseDown(box, event);
  }

  handlePlaceGunDocumentMouseDown(doc: LayoutDocumentElement, event: MouseEvent): boolean {
    if (!this._placeGunController || !this.placeGunActive) return false;
    return this._placeGunController.handleDocumentMouseDown(doc, event);
  }

  /**
   * 삽입 모드를 비활성화한다. `insertMode = null`과 동일하다.
   */
  deactivateInsert(): void {
    this.insertMode = null;
  }

  /**
   * 삽입 완료 이벤트를 발생시킨다.
   * @internal
   */
  _dispatchInsert(detail: InsertEventDetail): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('insert');
    if (!listeners || listeners.size === 0) return;

    this._suppressLayoutClick();
    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            ...detail,
            type: 'insert',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * 삽입 취소 이벤트를 발생시킨다.
   * @internal
   */
  _dispatchInsertCancel(): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('insertCancel');
    if (!listeners || listeners.size === 0) return;

    this._suppressLayoutClick();
    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'insertCancel',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * 다중 선택 모드를 설정한다. `true`면 다음 `selectLayout` 호출이 토글 모드로 동작한다.
   * @internal
   */
  _setMultiSelect(value: boolean): void {
    this._multiSelect = value;
  }

  /**
   * 드래그/리사이즈 완료 직후 발생하는 클릭 이벤트를 억제한다.
   *
   * 마우스가 box 밖에서 mouseup되면 후속 click 이벤트가 빈 영역 클릭으로
   * 처리되어 선택이 해제되는 것을 방지한다. window capture phase에
   * 일회성 click 리스너를 등록하여 `LayoutSelectionController._onClick`보다
   * 먼저 실행되어 click을 소비한다. click이 발생하지 않으면 타임아웃(200ms) 후
   * 자동 제거된다.
   * @internal
   */
  _suppressLayoutClick(): void {
    if (this._clickConsumeHandler !== null) {
      window.removeEventListener('click', this._clickConsumeHandler, true);
      if (this._clickConsumeTimer !== null) {
        clearTimeout(this._clickConsumeTimer);
      }
    }

    this._clickConsumeHandler = (e: MouseEvent): void => {
      e.stopPropagation();
      e.preventDefault();
      this._removeClickConsumeHandler();
    };

    window.addEventListener('click', this._clickConsumeHandler, true);

    this._clickConsumeTimer = setTimeout(() => {
      this._removeClickConsumeHandler();
    }, 200);
  }

  /**
   * 등록된 click 소비 리스너와 타이머를 정리한다.
   * @internal
   */
  private _removeClickConsumeHandler(): void {
    if (this._clickConsumeHandler !== null) {
      window.removeEventListener('click', this._clickConsumeHandler, true);
      this._clickConsumeHandler = null;
    }
    if (this._clickConsumeTimer !== null) {
      clearTimeout(this._clickConsumeTimer);
      this._clickConsumeTimer = null;
    }
  }

  /**
   * 선택된 레이아웃 요소들 중에서 중첩(ancestor-descendant) 관계에 있는
   * 하위 요소를 제외하고, 최상위 요소만 반환한다.
   *
   * 두 요소가 서로 ancestor-descendant 관계에 있으면 ancestor만 유지하고
   * descendant는 제외한다. 서로 독립적인(형제 또는 다른 트리의) 요소들은 모두 유지한다.
   *
   * @example
   * ```ts
   * // boxA 안에 boxB가 중첩되어 있고, boxC는 독립적인 경우:
   * // selectedLayouts = [boxA, boxB, boxC]
   * // → getTopLevelDragTargets() = [boxA, boxC]
   * // (boxB는 boxA의 하위 요소이므로 제외됨)
   * ```
   *
   * @returns 중첩 하위 요소가 제거된 최상위 레이아웃 요소 배열
   */
  getTopLevelDragTargets(): LayoutBoxElement[] {
    return this._filterTopLevelLayouts(this._selectedLayouts);
  }

  /**
   * 선택된 박스들을 방향키로 누지(nudge) 이동한다.
   *
   * - `position: 'static'` 박스: 단/라인 단위로 1씩 이동 (Shift 여부 무관).
   * - `position: 'absolute'` 박스: `deltaMm`만큼 이동 (Shift 시 `shiftDeltaMm`).
   *
   * 부모 편집 영역 경계를 벗어나지 않도록 클램핑한다.
   * 각 박스에 대해 `_dispatchLayoutMove` 이벤트를 발생시켜 undo/redo 스택에 push한다.
   *
   * @param directionX - 가로 방향 (-1, 0, 1)
   * @param directionY - 세로 방향 (-1, 0, 1)
   * @param deltaMm - 기본 이동량 (mm). absolute 박스에 적용.
   * @param shiftDeltaMm - Shift 누름 시 이동량 (mm). absolute 박스에만 적용.
   * @example
   * ```ts
   * // ArrowUp: 위로 1mm (absolute), 위로 1라인 (static)
   * manager.nudgeSelectedLayouts(0, -1, 1, 10);
   * // Shift+ArrowUp: 위로 10mm (absolute), 위로 1라인 (static)
   * manager.nudgeSelectedLayouts(0, -1, 1, 10);
   * ```
   */
  nudgeSelectedLayouts(
    directionX: number,
    directionY: number,
    deltaMm: number,
    shiftDeltaMm: number,
    shiftKey: boolean,
  ): void {
    const targets = this.getTopLevelDragTargets();
    if (targets.length === 0) return;

    const mm = shiftKey ? shiftDeltaMm : deltaMm;

    for (const box of targets) {
      const prevLeft = box.left;
      const prevTop = box.top;

      if (box.position === 'absolute') {
        const parentModel = box.parentModel;
        const parentW = box.inheritStyle?.parentWidth ?? 0;
        const parentH = parentModel ? parentModel.contentHeight : (box.inheritStyle?.parentHeight ?? 0);
        const maxLeft = Math.max(0, parentW - box.width);
        const maxTop = Math.max(0, parentH - box.height);
        box.left = Math.max(0, Math.min(maxLeft, prevLeft + directionX * mm));
        box.top = Math.max(0, Math.min(maxTop, prevTop + directionY * mm));
      } else {
        const parentModel = box.parentModel;
        if (!parentModel) continue;
        const { columnCount } = parentModel;
        const editableTextHeight = parentModel.editableTextHeight;
        const lineHeight = parentModel.lineHeight;
        const maxTop = Math.floor(
          (editableTextHeight - (lineHeight * box.height - (lineHeight - parentModel.fontSize))) / lineHeight,
        );
        const newLeft = Math.max(0, Math.min(columnCount - box.width, prevLeft + directionX));
        const newTop = Math.max(0, Math.min(maxTop, prevTop + directionY));
        box.left = newLeft;
        box.top = newTop;
      }

      if (box.left !== prevLeft || box.top !== prevTop) {
        this._dispatchLayoutMove(box, prevLeft, prevTop, box.left, box.top, false);
      }
    }
  }

  /**
   * 주어진 레이아웃 요소 목록에서 중첩 관계의 하위 요소를 제거하고
   * 최상위 요소만 필터링한다.
   *
   * @param elements - 필터링할 레이아웃 요소 목록
   * @returns 중첩 하위 요소가 제거된 LayoutBoxElement 배열.
   */
  private _filterTopLevelLayouts(elements: LayoutElement[]): LayoutBoxElement[] {
    const boxes = elements.filter(
      (el): el is LayoutBoxElement => el instanceof LayoutBoxElement
    );
    if (boxes.length <= 1) return boxes;

    const result: LayoutBoxElement[] = [];
    for (const box of boxes) {
      if (result.some(existing => existing.contains(box))) continue;

      for (let i = result.length - 1; i >= 0; i--) {
        if (box.contains(result[i])) {
          result.splice(i, 1);
        }
      }

      result.push(box);
    }
    return result;
  }

  /**
   * 드래그 이동을 시작한다.
   *
   * 선택된 요소들 중에서 중첩 관계를 필터링하여 최상위 요소만 이동 대상으로 설정한다.
   * 각 이동 대상의 시작 위치(left, top)를 기록하여 드래그 중 상대적 이동에 사용한다.
   *
   * @internal
   */
  _startLayoutDrag(): void {
    this._isLayoutDragging = true;
    this._dragTargets = this.getTopLevelDragTargets();
    this._dragStartPositions.clear();
    for (const target of this._dragTargets) {
      this._dragStartPositions.set(target, { left: target.left, top: target.top });
    }
  }

  /**
   * 드래그 이동을 종료하고 내부 상태를 초기화한다.
   * @internal
   */
  _endLayoutDrag(): void {
    this._isLayoutDragging = false;
    this._dragTargets = [];
    this._dragStartPositions.clear();
  }

  /**
   * 레이아웃 크기 조정을 시작한다.
   * @internal
   */
  _startLayoutResize(): void {
    this._isLayoutResizing = true;
  }

  /**
   * 레이아웃 크기 조정을 종료하고 내부 상태를 초기화한다.
   * @internal
   */
  _endLayoutResize(): void {
    this._isLayoutResizing = false;
  }

  /**
   * 현재 레이아웃 드래그 이동 중인지 반환한다.
   * @internal
   */
  _isDraggingLayout(): boolean {
    return this._isLayoutDragging;
  }

  /**
   * 현재 레이아웃 크기 조정 중인지 반환한다.
   * @internal
   */
  _isResizingLayout(): boolean {
    return this._isLayoutResizing;
  }

  /**
   * 현재 삽입 드래그를 진행 중인지 반환한다.
   * @internal
   */
  _isInsertDragging(): boolean {
    return this._insertController?.isDragging ?? false;
  }

  /**
   * 현재 드래그 중인 이동 대상 요소들을 반환한다.
   * @internal
   */
  _getDragTargets(): LayoutBoxElement[] {
    return this._dragTargets;
  }

  /**
   * 지정된 이동 대상 요소의 드래그 시작 위치를 반환한다.
   *
   * @param element - 시작 위치를 조회할 요소
   * @returns 시작 위치 객체 `{ left, top }`. 요소가 드래그 대상이 아니면 `undefined`.
   * @internal
   */
  _getDragStartPosition(element: LayoutBoxElement): { left: number; top: number } | undefined {
    return this._dragStartPositions.get(element);
  }

  /**
   * 레이아웃 요소가 DOM에서 제거될 때 선택에서 해제한다.
   * @internal
   */
  _unregisterLayout(element: LayoutElement): void {
    const idx = this._selectedLayouts.indexOf(element);
    if (idx >= 0) {
      const previousLayouts = [...this._selectedLayouts];
      this._selectedLayouts.splice(idx, 1);
      element.removeAttribute('selected');
      element.removeAttribute('text-focused');
      this._dispatchLayoutSelection(previousLayouts);
    }
  }

  /**
   * 레이아웃 요소의 이동 완료/취소 이벤트를 발생시킨다.
   *
   * reparent 모드에서 부모가 변경된 경우 `newContainer`와 `previousContainer`를 전달한다.
   * 일반 move 모드에서는 두 필드 모두 `undefined`이다.
   * @internal
   */
  _dispatchLayoutMove(
    element: LayoutElement,
    previousLeft: number,
    previousTop: number,
    left: number,
    top: number,
    canceled: boolean,
    newContainer?: HTMLElement,
    previousContainer?: HTMLElement,
  ): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('layoutMove');
    if (!listeners || listeners.size === 0) return;

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'layoutMove',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            layoutElement: element,
            previousLeft,
            previousTop,
            left,
            top,
            canceled,
            newContainer,
            previousContainer,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * 레이아웃 요소의 크기 조정 완료/취소 이벤트를 발생시킨다.
   * @internal
   */
  _dispatchLayoutResize(
    element: LayoutElement,
    previousLeft: number,
    previousTop: number,
    previousWidth: number,
    previousHeight: number,
    left: number,
    top: number,
    width: number,
    height: number,
    canceled: boolean,
  ): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('layoutResize');
    if (!listeners || listeners.size === 0) return;

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'layoutResize',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            layoutElement: element,
            previousLeft,
            previousTop,
            previousWidth,
            previousHeight,
            left,
            top,
            width,
            height,
            canceled,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  private _resolveLayoutElement(target: LayoutElement | string): LayoutElement | null {
    if (typeof target === 'string') {
      const element = this._docEl.querySelector('#' + CSS.escape(target));
      if (element instanceof LayoutBoxElement) {
        return element;
      }
      return null;
    }
    return target;
  }

  /**
   * 레이아웃 요소 추가 이벤트를 발생시킨다.
   * 삽입 모드, reparent, 프로그래밍 방식 모두 포함한다.
   * @internal
   */
  _dispatchLayoutAdd(detail: LayoutAddEventDetail): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('layoutAdd');
    if (!listeners || listeners.size === 0) return;

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'layoutAdd',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            layoutAddDetail: detail,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * 레이아웃 요소 제거 이벤트를 발생시킨다.
   * reparent 시 이전 컨테이너에서 제거, 프로그래밍 방식 제거 모두 포함한다.
   * @internal
   */
  _dispatchLayoutRemove(detail: LayoutRemoveEventDetail): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('layoutRemove');
    if (!listeners || listeners.size === 0) return;

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'layoutRemove',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            layoutRemoveDetail: detail,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * Box 속성(role, groupMember, priority) 변경 이벤트를 발생시킨다.
   * 프로그래밍 방식으로 속성이 변경될 때 호출된다.
   * @internal
   */
  _dispatchBoxPropertyChange(detail: BoxPropertyChangeEventDetail): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('boxPropertyChange');
    if (!listeners || listeners.size === 0) return;

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'boxPropertyChange',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            boxPropertyDetail: detail,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  private _dispatchLayoutSelection(previousLayouts: LayoutElement[]): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('layoutSelectionChange');
    if (!listeners || listeners.size === 0) return;

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'layoutSelectionChange',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            selectedLayouts: [...this._selectedLayouts],
            previousLayouts,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * 컨텍스트 메뉴 이벤트를 디스패치한다.
   *
   * @param detail - 컨텍스트 메뉴 이벤트 상세 정보
   * @internal
   */
  _dispatchContextMenu(detail: ContextMenuEventDetail): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('contextMenu');
    if (!listeners || listeners.size === 0) return;

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'contextMenu',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            contextMenuDetail: detail,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * 셀 블록 선택 변경 이벤트를 디스패치한다.
   *
   * `TableKeyboardController._updateSelection`이 셀 블록(mode/anchor/focus)을
   * 변경한 직후 호출한다. 기존 `layoutSelectionChange`와는 독립적으로 동작하며,
   * 셀 블록 메타데이터와 실제 선택된 TD 요소 배열을 전달한다.
   *
   * @param detail - 셀 블록 선택 변경 상세 정보
   * @internal
   */
  _dispatchCellSelectionChange(detail: TableCellSelectionChangeDetail): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('cellSelectionChange');
    if (!listeners || listeners.size === 0) return;

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'cellSelectionChange',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            cellSelectionDetail: detail,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * 이벤트를 발생시킨다.
   */
  private _dispatch(
    type: EditManagerEventType,
    controller: TextEditController | null,
    previousParagraph?: LayoutParagraphElement | null,
    previousController?: TextEditController | null,
  ): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get(type);
    if (!listeners || listeners.size === 0) return;

    const event: EditManagerEvent = {
      type,
      paragraph: controller ? controller['_paragraph'] as LayoutParagraphElement : null as unknown as LayoutParagraphElement,
      controller,
      previousParagraph: previousParagraph ?? undefined,
      previousController: previousController ?? undefined,
    };

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  // ─── Place Gun ───────────────────────────────────────────────

  /**
   * 현재 Place Gun에 장전된 항목 리스트를 반환한다.
   *
   * 리스트의 맨 앞(index 0)이 "다음으로 쏠 항목"이다.
   * 반환되는 배열은 내부 배열의 얕은 복사이므로 안전하게 수정할 수 있다.
   *
   * @returns 장전된 항목 배열 (얕은 복사)
   *
   * @example
   * ```ts
   * const items = manager.placeGunItems;
   * if (items.length > 0) {
   *   console.log('다음 항목:', items[0]?.title);
   * }
   * ```
   */
  get placeGunItems(): PlaceGunItem[] {
    return [...this._placeGunItems];
  }

  /**
   * Place Gun이 일시정지 상태인지 반환한다.
   *
   * `true`이면 장전된 항목이 있어도 클릭 배치가 동작하지 않고
   * 커서도 기본 상태로 유지된다.
   *
   * @returns 일시정지 여부
   */
  get placeGunPaused(): boolean {
    return this._placeGunPaused;
  }

  /**
   * Place Gun이 활성 상태인지 반환한다.
   *
   * 활성 = 항목이 1개 이상 장전되어 있고 일시정지되지 않음.
   * 활성 상태에서만 문서 클릭 시 항목이 배치된다.
   *
   * @returns 활성 여부
   */
  get placeGunActive(): boolean {
    return this._placeGunItems.length > 0 && !this._placeGunPaused;
  }

  /**
   * Place Gun에 항목들을 장전한다.
   *
   * 기존에 장전된 항목은 모두 교체된다. 항목이 1개 이상이면 자동으로
   * PlaceGunController가 생성되어 문서 클릭 리스너가 활성화된다.
   *
   * @param items - 장전할 항목 배열. 빈 배열이면 `unloadPlaceGun()`과 동일.
   *
   * @example
   * ```ts
   * manager.loadPlaceGun([
   *   { contentType: 'text', title: '기사1', sourceId: 'a1', content: '내용...' },
   *   { contentType: 'image', title: '사진1', sourceId: 'i1', content: '/img/1.png' },
   * ]);
   * ```
   */
  loadPlaceGun(items: readonly PlaceGunItem[]): void {
    this._placeGunItems = [...items];
    this._placeGunPaused = false;
    this._syncPlaceGunController();
    this._dispatchPlaceGunChange();
  }

  /**
   * Place Gun에 장전된 모든 항목을 비운다.
   *
   * 일시정지 상태도 해제되고 PlaceGunController가 제거된다.
   */
  unloadPlaceGun(): void {
    if (this._placeGunItems.length === 0 && !this._placeGunPaused && !this._placeGunController) return;
    this._placeGunItems = [];
    this._placeGunPaused = false;
    this._syncPlaceGunController();
    this._dispatchPlaceGunChange();
  }

  /**
   * 특정 인덱스의 항목을 제거한다.
   *
   * @param index - 제거할 항목의 0-based 인덱스
   * @throws {RangeError} index가 범위를 벗어나면
   */
  removePlaceGunItem(index: number): void {
    if (index < 0 || index >= this._placeGunItems.length) {
      throw new RangeError(`EditManager.removePlaceGunItem: index ${index}가 범위를 벗어났습니다 (길이: ${this._placeGunItems.length}).`);
    }
    this._placeGunItems.splice(index, 1);
    this._syncPlaceGunController();
    this._dispatchPlaceGunChange();
  }

  /**
   * 항목의 순서를 변경한다.
   *
   * `from` 인덱스의 항목을 `to` 인덱스로 이동한다.
   * 맨 위(0)로 옮기면 다음으로 쏠 항목이 된다.
   *
   * @param from - 이동할 항목의 현재 인덱스
   * @param to - 항목의 새 인덱스
   * @throws {RangeError} from 또는 to가 범위를 벗어나면
   *
   * @example
   * ```ts
   * // 3번째 항목을 맨 위로
   * manager.reorderPlaceGunItems(2, 0);
   * ```
   */
  reorderPlaceGunItems(from: number, to: number): void {
    const len = this._placeGunItems.length;
    if (from < 0 || from >= len) {
      throw new RangeError(`EditManager.reorderPlaceGunItems: from ${from}가 범위를 벗어났습니다 (길이: ${len}).`);
    }
    if (to < 0 || to >= len) {
      throw new RangeError(`EditManager.reorderPlaceGunItems: to ${to}가 범위를 벗어났습니다 (길이: ${len}).`);
    }
    if (from === to) return;
    const [item] = this._placeGunItems.splice(from, 1);
    this._placeGunItems.splice(to, 0, item);
    this._dispatchPlaceGunChange();
  }

  /**
   * Place Gun 일시정지 상태를 설정한다.
   *
   * `true`로 설정하면 장전된 항목이 있어도 클릭 배치가 동작하지 않고
   * 커서가 기본 상태로 복원된다. `false`면 다시 배치 가능 상태가 된다.
   *
   * @param paused - 일시정지 여부
   */
  setPlaceGunPaused(paused: boolean): void {
    if (this._placeGunPaused === paused) return;
    this._placeGunPaused = paused;
    this._syncPlaceGunController();
    this._dispatchPlaceGunChange();
  }

  /**
   * 맨 위 항목을 소비하고 반환한다.
   *
   * PlaceGunController가 클릭 배치를 완료한 후 호출된다.
   * 항목이 제거되고 리스트가 갱신되며, 리스트가 비면 컨트롤러가 자동
   * 비활성화된다.
   *
   * @returns 소비된 항목. 장전된 항목이 없거나 일시정지 상태면 `null`.
   * @internal
   */
  _consumePlaceGunItem(): PlaceGunItem | null {
    if (!this.placeGunActive) return null;
    const [item, ...rest] = this._placeGunItems;
    this._placeGunItems = rest;
    this._syncPlaceGunController();
    this._dispatchPlaceGunChange();
    return item ?? null;
  }

  /**
   * 현재 장전/일시정지 상태에 따라 PlaceGunController를 동기화한다.
   *
   * `placeGunActive`가 true면 컨트롤러를 생성/활성화하고,
   * false면 컨트롤러를 비활성화한다.
   */
  private _syncPlaceGunController(): void {
    if (this.placeGunActive) {
      if (!this._placeGunController) {
        this._placeGunController = new PlaceGunController(this);
      }
      this._placeGunController.attach();
    } else {
      if (this._placeGunController) {
        this._placeGunController.detach();
      }
    }
  }

  /**
   * `placeGunChange` 이벤트를 발생시킨다.
   */
  private _dispatchPlaceGunChange(): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('placeGunChange');
    if (!listeners || listeners.size === 0) return;

    const detail: PlaceGunChangeEventDetail = {
      items: [...this._placeGunItems],
      paused: this._placeGunPaused,
    };

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'placeGunChange',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            placeGunDetail: detail,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * `placeGunBefore` 이벤트를 발생시킨다.
   * PlaceGunController가 항목을 주입하기 직전에 호출한다.
   *
   * @param item - 주입할 Place Gun 항목
   * @param box - 주입 대상 box 요소
   * @internal
   */
  _dispatchPlaceGunBefore(item: PlaceGunItem, box: HTMLElement): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('placeGunBefore');
    if (!listeners || listeners.size === 0) return;

    const detail: PlaceGunBeforeEventDetail = { item, box };

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'placeGunBefore',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            placeGunBeforeDetail: detail,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * `placeGunAfter` 이벤트를 발생시킨다.
   * PlaceGunController가 항목 주입을 완료한 직후에 호출한다.
   *
   * @param item - 주입된 Place Gun 항목
   * @param box - 주입 대상 box 요소
   * @param success - 주입 성공 여부
   * @internal
   */
  _dispatchPlaceGunAfter(item: PlaceGunItem, box: HTMLElement, success: boolean): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get('placeGunAfter');
    if (!listeners || listeners.size === 0) return;

    const detail: PlaceGunAfterEventDetail = { item, box, success };

    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'placeGunAfter',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null,
            placeGunAfterDetail: detail,
          });
        } catch (e) {
          console.error(e);
        }
      }
    } finally {
      this._dispatching = false;
    }
  }

  /**
   * Tab/Shift+Tab 키로 편집 가능한 요소 사이를 순환 이동한다.
   *
   * 현재 편집 모드에 따라 동작 대상이 결정된다:
   * - **텍스트 편집 모드** (`textEditMode === true`): 문서 내 편집 가능한
   *   모든 `LayoutParagraphElement`를 zIndex 오름차순으로 평탄화한 뒤,
   *   현재 포커스된 단락의 다음/이전 단락으로 포커스를 이동한다.
   *   `focusParagraph()`를 호출해 `editableText` 활성화, 부모 box 자동 선택,
   *   `focusChange` 이벤트 발생을 한 번에 수행한다.
   * - **레이아웃 편집 모드** (그 외): 문서 내 선택 가능한 모든 `LayoutBoxElement`를
   *   zIndex 오름차순으로 평탄화한 뒤, 현재 선택된 마지막 box의 다음/이전 box로
   *   단일 선택을 이동한다. `selectLayout()`을 호출해 기존 선택을 모두 해제하고
   *   대상만 선택하며 `layoutSelectionChange` 이벤트를 발생시킨다.
   *   Tab은 항상 단일 선택이므로 `_setMultiSelect(true)`를 호출하지 않는다.
   *
   * 인쇄 모드 또는 삽입 모드에서는 동작하지 않고 `false`를 반환한다.
   * 후보가 하나도 없으면 `false`를 반환한다.
   *
   * @param shiftKey - `true`면 Shift+Tab (역방향), `false`면 Tab (순방향)
   * @returns 이동 성공 여부. 가드 조건 미충족 또는 후보 없음 시 `false`
   */
  navigateByTab(shiftKey: boolean): boolean {
    // 삽입 모드에서는 Tab 동작을 수행하지 않는다.
    if (this._insertMode !== null) return false;

    const isTextMode = this._textEditMode;

    if (isTextMode) {
      // 텍스트 편집 모드: 편집 가능한 paragraph 평탄화.
      // _flattenParagraphs는 LayoutElement(Box|TD)를 받지만 document도 items getter를
      // 가지므로 구조적으로 호환됨 — 헬퍼 내부에서는 instanceof 분기만 사용한다.
      const candidates: LayoutParagraphElement[] = [];
      this._flattenParagraphs(this._docEl as unknown as LayoutElement, candidates);
      if (candidates.length === 0) return false;

      const current = this.focusedParagraph;
      const currentIdx = current ? candidates.indexOf(current) : -1;

      const nextIdx = shiftKey
        ? (currentIdx <= 0 ? candidates.length - 1 : currentIdx - 1)
        : (currentIdx < 0 ? 0 : (currentIdx + 1) % candidates.length);

      this.focusParagraph(candidates[nextIdx]);
      return true;
    } else {
      // 레이아웃 편집 모드: 선택 가능한 box 평탄화 (위와 동일한 캐스트 사유).
      const candidates: LayoutBoxElement[] = [];
      this._flattenBoxes(this._docEl as unknown as LayoutElement, candidates);
      if (candidates.length === 0) return false;

      const current = this._selectedLayouts.length > 0
        ? this._selectedLayouts[this._selectedLayouts.length - 1]
        : null;
      const currentIdx = current ? candidates.indexOf(current as LayoutBoxElement) : -1;

      const nextIdx = shiftKey
        ? (currentIdx <= 0 ? candidates.length - 1 : currentIdx - 1)
        : (currentIdx < 0 ? 0 : (currentIdx + 1) % candidates.length);

      // Tab은 항상 단일 선택 — _setMultiSelect(true) 호출 없이 selectLayout만 호출.
      this.selectLayout(candidates[nextIdx]);
      return true;
    }
  }

  /**
   * 형제 요소들을 zIndex 오름차순으로 안정 정렬한다.
   *
   * `box.zIndex` getter를 사용하여 role override(ad=91000, header=91001)가
   * 정렬 순서에 반영되도록 한다. 동일한 zIndex를 가진 요소는 원래 순서를 유지한다.
   * (ECMAScript 2019 이후 `Array.prototype.sort`는 안정 정렬을 보장한다.)
   *
   * @param items - 정렬할 형제 요소 배열 (box/paragraph/image/table 혼합 가능)
   * @returns zIndex 오름차순으로 정렬된 새 배열 (원본 불변)
   */
  private _sortSiblings<T extends { zIndex: number }>(items: T[]): T[] {
    return [...items].sort((a, b) => a.zIndex - b.zIndex);
  }

  /**
   * 컨테이너 하위의 모든 선택 가능한 box를 평탄화하여 수집한다.
   *
   * Pre-order DFS로 순회하며, 각 컨테이너의 자식을 `_sortSiblings`로 zIndex 정렬한다.
   * - `LayoutBoxElement`이고 `isBoxSelectable` 통과 시 result에 추가.
   *   단, 부모 box가 lock 상태가 아니면 자식으로 재귀 (lock은 조상 lock을 통해
   *   `isBoxSelectable`/`isBoxEditable`이 자동으로 차단하므로, lock된 box의
   *   자식도 `isBoxSelectable`에서 걸러짐).
   * - `LayoutTableElement` → `_flattenTableBoxes`로 위임.
   * - `LayoutParagraphElement`, `LayoutImageElement` → 건너뜀.
   *
   * @param container - 순회할 컨테이너 (document 또는 box)
   * @param result - 수집 결과를 누적할 배열
   */
  private _flattenBoxes(container: LayoutElement, result: LayoutBoxElement[]): void {
    const sorted = this._sortSiblings(container.items);
    for (const child of sorted) {
      if (child instanceof LayoutBoxElement) {
        if (this.isBoxSelectable(child)) {
          result.push(child);
        }
        // lock 여부와 무관하게 자식으로 재귀 — 자식이 선택 가능하면 수집해야 함.
        // 단, lock된 box의 자식은 isBoxSelectable이 조상 lock을 검사하므로 자동 제외됨.
        this._flattenBoxes(child, result);
      } else if (child instanceof LayoutTableElement) {
        this._flattenTableBoxes(child, result);
      }
    }
  }

  /**
   * 컨테이너 하위의 모든 편집 가능한 paragraph를 평탄화하여 수집한다.
   *
   * Pre-order DFS로 순회하며, 각 컨테이너의 자식을 `_sortSiblings`로 zIndex 정렬한다.
   * - `LayoutParagraphElement`이고 `isParagraphEditable` 통과 시 result에 추가.
   * - `LayoutBoxElement` → 자식으로 재귀 (하위에 paragraph가 있을 수 있음).
   * - `LayoutTableElement` → `_flattenTableParagraphs`로 위임.
   * - `LayoutImageElement` → 건너뜀.
   *
   * @param container - 순회할 컨테이너 (document 또는 box)
   * @param result - 수집 결과를 누적할 배열
   */
  private _flattenParagraphs(container: LayoutElement, result: LayoutParagraphElement[]): void {
    const sorted = this._sortSiblings(container.items);
    for (const child of sorted) {
      if (child instanceof LayoutParagraphElement) {
        if (this.isParagraphEditable(child)) {
          result.push(child);
        }
      } else if (child instanceof LayoutBoxElement) {
        this._flattenParagraphs(child, result);
      } else if (child instanceof LayoutTableElement) {
        this._flattenTableParagraphs(child, result);
      }
    }
  }

  /**
   * 표 내부의 모든 선택 가능한 box를 평탄화하여 수집한다.
   *
   * `table.gridResolution`의 placements를 (gridRow, gridCol) 오름차순으로 정렬한 뒤,
   * 각 placement에 해당하는 TD를 찾아 첫 번째 box를 후보로 검사한다.
   * - box가 존재하고 `isBoxSelectable` 통과 시 result에 추가.
   * - `_flattenBoxes(box, result)` 호출로 box 하위의 모든 box를 수집한다.
   *   (중첩 box 및 중첩 table은 `_flattenBoxes`가 내부적으로 처리한다.)
   *
   * @param table - 순회할 표 요소
   * @param result - 수집 결과를 누적할 배열
   */
  private _flattenTableBoxes(table: LayoutTableElement, result: LayoutBoxElement[]): void {
    const grid = table.gridResolution;
    if (!grid || grid.placements.length === 0) return;

    const sortedPlacements = [...grid.placements].sort(
      (a, b) => a.gridRow - b.gridRow || a.gridCol - b.gridCol,
    );

    for (const placement of sortedPlacements) {
      const td = this._findTdAt(table, placement.gridRow, placement.gridCol);
      if (!td) continue;
      const box = td.items[0];
      if (!box) continue;

      if (this.isBoxSelectable(box)) {
        result.push(box);
      }
      // _flattenBoxes already handles nested boxes AND nested tables (LayoutTableElement
      // children are dispatched to _flattenTableBoxes). No explicit nested-table loop needed.
      this._flattenBoxes(box, result);
    }
  }

  /**
   * 표 내부의 모든 편집 가능한 paragraph를 평탄화하여 수집한다.
   *
   * `table.gridResolution`의 placements를 (gridRow, gridCol) 오름차순으로 정렬한 뒤,
   * 각 placement에 해당하는 TD를 찾아 첫 번째 box의 하위 paragraph를 검사한다.
   * - `_flattenParagraphs(box, result)` 호출로 box 하위의 모든 paragraph를 수집한다.
   *   (중첩 box 및 중첩 table은 `_flattenParagraphs`가 내부적으로 처리한다.)
   *
   * @param table - 순회할 표 요소
   * @param result - 수집 결과를 누적할 배열
   */
  private _flattenTableParagraphs(table: LayoutTableElement, result: LayoutParagraphElement[]): void {
    const grid = table.gridResolution;
    if (!grid || grid.placements.length === 0) return;

    const sortedPlacements = [...grid.placements].sort(
      (a, b) => a.gridRow - b.gridRow || a.gridCol - b.gridCol,
    );

    for (const placement of sortedPlacements) {
      const td = this._findTdAt(table, placement.gridRow, placement.gridCol);
      if (!td) continue;
      const box = td.items[0];
      if (!box) continue;

      // _flattenParagraphs already collects paragraphs from box.items AND handles
      // nested boxes/tables. No explicit paragraph or nested-table loop needed.
      this._flattenParagraphs(box, result);
    }
  }

  /**
   * 표에서 지정된 (gridRow, gridCol) 좌표에 해당하는 TD를 찾는다.
   *
   * `table.items`는 TR 배열이며, 각 TR의 `items`는 TD 배열이다.
   * placement의 gridRow로 TR을 찾고, 해당 TR의 TD 중 cellLabels가
   * placement 좌표를 포함하는 TD를 반환한다.
   *
   * @param table - 검색할 표 요소
   * @param gridRow - placement의 시작 행 인덱스
   * @param gridCol - placement의 시작 열 인덱스
   * @returns 해당 좌표의 TD 요소, 찾지 못하면 null
   */
  private _findTdAt(table: LayoutTableElement, gridRow: number, gridCol: number): LayoutTableCellElement | null {
    const tr = table.items[gridRow];
    if (!tr) return null;
    const targetLabel = this._coordToLabel(gridRow, gridCol);
    for (const td of tr.items) {
      if (td.cellLabels.includes(targetLabel)) return td;
    }
    for (const td of tr.items) {
      if (td.cellLabel === targetLabel) return td;
    }
    // fallback: 첫 번째 TD (gridResolution과 DOM이 불일치하는 극단적 케이스)
    return tr.items[0] ?? null;
  }

  /**
   * (row, col) 좌표를 셀 라벨(A1, B2, ...)로 변환한다.
   *
   * @param row - 행 인덱스 (0부터)
   * @param col - 열 인덱스 (0부터)
   * @returns 셀 라벨 문자열
   */
  private _coordToLabel(row: number, col: number): string {
    let label = '';
    let n = row;
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return `${label}${col + 1}`;
  }
}
