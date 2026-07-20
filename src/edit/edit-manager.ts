import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import { LayoutDocumentElement } from "@/components/layout/document.element";
import { LayoutBoxElement } from "@/components/layout/box.element";
import { GridCalculator } from "@/core";
import type { TextEditController, CurrentStyle } from "./text-edit-controller";
import { InsertController } from "./insert-controller";
import { LayoutEditController } from "./layout-edit-controller";
import { LayoutSelectionController } from "./layout-selection-controller";
import type { SelectionRange } from "@/types/edit";
import type { InsertMode, InsertEventDetail, InsertPosition, LayoutEditType, LayoutEditModeInput } from "@/types/edit";
import type { BoxRole } from "@/types/layout";

/** 레이아웃 편집 대상 요소 (box만 해당) */
export type LayoutElement = LayoutBoxElement;

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
  | 'insert'
  | 'insertCancel';

/**
 * 글로벌 편집 관리 이벤트.
 */
export interface EditManagerEvent {
  /** 이벤트 타입 */
  type: EditManagerEventType;
  /** 이벤트가 발생한 단락 요소 (포커스된 단락) */
  paragraph: LayoutParagraphElement;
  /** 이벤트가 발생한 편집 컨트롤러 */
  controller: TextEditController;
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
 * const manager = EditManager.getInstance();
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
  private static _instance: EditManager | null = null;
  private _controllers: Set<TextEditController> = new Set();
  private _focusedController: TextEditController | null = null;
  private _listeners: Map<EditManagerEventType, Set<EditManagerEventListener>> = new Map();
  private _dispatching = false;
  private _selectedLayouts: LayoutElement[] = [];
  private _isPrint: boolean = window.matchMedia("print").matches;
  private _isLayoutDragging = false;
  private _isLayoutResizing = false;
  private _insertController: InsertController | null = null;
  private _insertMode: InsertMode | null = null;
  private _suppressNextClick = false;
  private _layoutEditMode: boolean = false;
  private _layoutEditType: LayoutEditType = 'move';
  private _selectableMode: boolean = true;
  private _editableRoles: Set<BoxRole> | null = null;
  private _editableBoxIds: Set<string> | null = null;
  private _selectableRoles: Set<BoxRole> | null = null;
  private _selectableBoxIds: Set<string> | null = null;
  private _selectableRootId: string | null = null;
  private _layoutEditController: LayoutEditController | null = null;
  private _selectionController: LayoutSelectionController | null = null;

  /**
   * CSS `transform: scale(s)`이 적용된 환경을 위한 화면 scale 보정 계수.
   * `screenPxToMm()`/`screenDeltaToMm()`이 `originalPpm * scale`을 사용해
   * 변환된 픽셀 좌표를 mm으로 정확히 환산한다. 기본값 1.0.
   */
  private _scale: number = 1;

  /** 편집 루트 box id. null이면 제한 없음. 지정 시 해당 box 내부 요소만 편집 가능, Root 자체는 편집 불가. */
  private _editableRootId: string | null = null;

  private constructor() {}

  /**
   * 싱글톤 인스턴스를 반환한다.
   */
  static getInstance(): EditManager {
    if (!EditManager._instance) {
      EditManager._instance = new EditManager();
    }
    return EditManager._instance;
  }

  /**
   * CSS `transform: scale(s)`이 적용된 환경을 위한 화면 scale 보정 계수를 설정한다.
   * 이후 `screenPxToMm()`/`screenDeltaToMm()`이 `originalPpm * scale`을 사용해
   * 변환된 픽셀 좌표를 mm으로 정확히 환산한다.
   *
   * @example
   * ```ts
   * const manager = EditManager.getInstance();
   * manager.setScale(0.5);  // zoom 50% 환경
   * manager.setScale(1);    // 원본
   * ```
   */
  setScale(scale: number): void {
    if (scale <= 0) {
      throw new Error(`EditManager.setScale: scale은 0보다 커야 합니다 (입력값: ${scale}).`);
    }
    this._scale = scale;
    document.querySelectorAll<LayoutParagraphElement>('x-layout-paragraph').forEach((p) => {
      p.markStructureChangedAndRender();
    });
  }

  /** scale 보정 계수를 1로 원복한다. 컴포넌트 unmount 시 호출한다. */
  resetScale(): void {
    this._scale = 1;
  }

  /** 현재 scale 보정 계수를 반환한다. */
  get scale(): number {
    return this._scale;
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
    return px / (GridCalculator.ppm * this._scale);
  }

  /**
   * 화면 픽셀 델타(deltaX/deltaY)를 mm 델타로 환산한다.
   * `screenPxToMm`의 델타 전용 wrapper.
   */
  screenDeltaToMm(deltaPx: number): number {
    return deltaPx / (GridCalculator.ppm * this._scale);
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
      this._focusedController = null;
      this._dispatch('focusChange', controller, previousParagraph, controller);
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
    this._dispatch('focusChange', controller, previousParagraph, controller);
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
    if (this._isPrint) return false;
    let paragraph: LayoutParagraphElement | null;

    if (typeof target === 'string') {
      const element = document.getElementById(target);
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
      const element = document.getElementById(target);
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
    this._textEditMode = false;
    for (const controller of this._controllers) {
      const paragraph = controller['_paragraph'] as LayoutParagraphElement;
      paragraph.editableText = false;
    }
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
   * const manager = EditManager.getInstance();
   * manager.setEditableTextRoles(['body', 'title']);
   * manager.textEditMode = true;
   * // → 부모 box role이 'body' 또는 'title'인 paragraph만 편집 가능
   * ```
   */
  get textEditMode(): boolean { return this._textEditMode; }
  set textEditMode(value: boolean) {
    if (this._isPrint) return;
    if (this._textEditMode === value) return;
    if (value) {
      this.layoutEditMode = false;
      this.insertMode = null;
    }
    this._textEditMode = value;
    if (!value) {
      this._blurFocusedParagraph();
      this._applyEditableTextToAllParagraphs();
    } else {
      this._applyEditableTextToAllParagraphs();
    }
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
  private _isBoxOrAncestorLocked(box: LayoutBoxElement): boolean {
    let current: LayoutBoxElement | null = box;
    while (current) {
      if (current.lock) return true;
      current = current.parentElement instanceof LayoutBoxElement ? current.parentElement : null;
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
   * 텍스트 편집 포커스가 들어온 paragraph의 부모 box를 레이아웃 선택에 추가한다.
   * 기존에 선택된 다른 box의 선택은 유지되며, 부모 box가 아직 선택되지 않았으면 추가한다.
   *
   * @param paragraph - 포커스를 얻은 단락. null이면 아무 일도 하지 않는다.
   */
  private _selectBoxForParagraph(paragraph: LayoutParagraphElement | null): void {
    if (!paragraph) return;
    const parentBox = paragraph.parentElement;
    if (!(parentBox instanceof LayoutBoxElement)) return;

    if (parentBox.hasAttribute('selected')) return;

    const previousLayouts = [...this._selectedLayouts];
    parentBox.setAttribute('selected', '');
    this._selectedLayouts.push(parentBox);
    this._dispatchLayoutSelection(previousLayouts);
  }

  /**
   * 텍스트 편집 포커스가 해제되어도 레이아웃 선택은 유지된다.
   *
   * @param paragraph - 포커스를 잃은 단락. null이면 아무 일도 하지 않는다.
   */
  private _clearBoxSelectionForParagraph(_paragraph: LayoutParagraphElement | null): void {
    // 선택 유지: 텍스트 포커스가 떠나도 레이아웃 선택은 해제되지 않는다.
  }

  /**
   * 현재 편집 가능 상태에 따라 문서 내 모든 paragraph의 `editableText` 속성을 갱신한다.
   * `isParagraphEditable()` 결과를 paragraph별로 적용한다.
   */
  private _applyEditableTextToAllParagraphs(): void {
    const paragraphs = document.querySelectorAll<LayoutParagraphElement>('x-layout-paragraph');
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
   * const manager = EditManager.getInstance();
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
    if (this._isPrint) return;

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

    if (nextActive) {
      this.textEditMode = false;
      this.insertMode = null;
    }
    this._layoutEditMode = nextActive;
    this._layoutEditType = nextType;
    if (nextActive) {
      this._applyEditableLayoutToAllBoxes();
    } else {
      this._applyEditableLayoutToAllBoxes();
      if (!this._selectableMode) {
        this.clearLayoutSelection();
      }
    }
    this._updateControllers();
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

  /**
   * 선택 모드 활성화 상태.
   *
   * `true`면 `layoutEditMode` 여부와 무관하게 box 클릭으로 선택할 수 있다.
   * 편집 모드가 꺼진 상태에서도 클릭 선택이 가능하며, 선택 시 시각적
   * 피드백(`selected` 속성)이 제공된다.
   * 이동/리사이즈는 여전히 편집 모드에서만 동작한다.
   *
   * @example
   * ```ts
   * const manager = EditManager.getInstance();
   * manager.selectableMode = true;   // 편집 모드 없이도 클릭 선택 가능
   * manager.layoutEditMode = false;  // 이동/리사이즈는 불가하지만 선택은 가능
   * ```
   */
  get selectableMode(): boolean { return this._selectableMode; }
  set selectableMode(value: boolean) {
    if (this._isPrint) return;
    if (this._selectableMode === value) return;
    this._selectableMode = value;
    this._updateControllers();
    if (!value) {
      this.clearLayoutSelection();
    }
  }

  private _updateControllers(): void {
    if (this._selectableMode) {
      if (!this._selectionController) {
        this._selectionController = new LayoutSelectionController(document.documentElement);
      }
      this._selectionController.attach();
    } else {
      if (this._selectionController) {
        this._selectionController.detach();
      }
    }

    if (this._layoutEditMode) {
      if (!this._layoutEditController) {
        this._layoutEditController = new LayoutEditController(document.documentElement);
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
   * manager.selectableMode = true;  // body, title box만 선택 가능
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
  isBoxEditable(box: LayoutBoxElement): boolean {
    if (!this._layoutEditMode) return false;
    if (this._isBoxOrAncestorLocked(box)) return false;
    if (!this._isWithinEditableRoot(box)) return false;
    if (this._editableRoles !== null && !this._editableRoles.has(box.role)) return false;
    if (this._editableBoxIds !== null && !this._editableBoxIds.has(box.id)) return false;
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
  isBoxSelectable(box: LayoutBoxElement): boolean {
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
    const roles = this._selectableRoles ?? this._editableRoles;
    if (roles !== null && !roles.has(box.role)) return false;
    const ids = this._selectableBoxIds ?? this._editableBoxIds;
    if (ids !== null && !ids.has(box.id)) return false;
    return true;
  }

  /**
   * 현재 편집 가능 상태에 따라 문서 내 모든 box의 `editableLayout` 속성을 갱신한다.
   * `isBoxEditable()` 결과를 box별로 적용한다.
   */
  private _applyEditableLayoutToAllBoxes(): void {
    const boxes = document.querySelectorAll<LayoutBoxElement>('x-layout-box');
    boxes.forEach((box) => {
      const editable = this.isBoxEditable(box);
      if (box.editableLayout !== editable) {
        box.editableLayout = editable;
      }
    });
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
    if (this._isPrint) return false;
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

    if (this._multiSelect) {
      for (const el of newSelections) {
        const idx = this._selectedLayouts.indexOf(el);
        if (idx >= 0) {
          this._selectedLayouts.splice(idx, 1);
          el.removeAttribute('selected');
        } else {
          this._selectedLayouts.push(el);
          el.setAttribute('selected', '');
        }
      }
    } else {
      for (const prev of this._selectedLayouts) {
        prev.removeAttribute('selected');
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
   * 레이아웃 선택을 모두 해제한다.
   */
  clearLayoutSelection(): void {
    if (this._selectedLayouts.length === 0) return;
    const previousLayouts = [...this._selectedLayouts];
    for (const el of this._selectedLayouts) {
      el.removeAttribute('selected');
    }
    this._selectedLayouts = [];
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
    if (this._isPrint) return;
    if (this._insertMode === mode) return;

    const isDragging = this._insertController?.isDragging ?? false;

    if (mode) {
      if (!isDragging) {
        this.layoutEditMode = false;
        this.textEditMode = false;
        this.clearLayoutSelection();
      }

      const docEl = document.querySelector('x-layout-document') as LayoutDocumentElement | null;
      if (!docEl) {
        throw new Error('EditManager.insertMode: 문서 요소(x-layout-document)를 찾을 수 없습니다.');
      }

      if (!isDragging) {
        document.querySelectorAll<LayoutBoxElement>('x-layout-box').forEach((box) => {
          box.style.cursor = 'crosshair';
        });
      }

      if (!this._insertController) {
        this._insertController = new InsertController(docEl);
      }
      this._insertController.setMode(mode);
      this._insertMode = mode;
    } else {
      if (this._insertController) {
        this._insertController.setMode(null);
      }
      this._insertMode = null;

      document.querySelectorAll<LayoutBoxElement>('x-layout-box').forEach((box) => {
        box.style.cursor = '';
      });
    }
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

    this._suppressNextClick = true;
    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            ...detail,
            type: 'insert',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null as unknown as TextEditController,
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

    this._suppressNextClick = true;
    this._dispatching = true;
    try {
      for (const listener of listeners) {
        try {
          listener({
            type: 'insertCancel',
            paragraph: null as unknown as LayoutParagraphElement,
            controller: null as unknown as TextEditController,
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
   * 삽입 완료/취소 직후 발생하는 클릭 이벤트를 무시하기 위한 플래그를 소비한다.
   * `_dispatchInsert` 또는 `_dispatchInsertCancel`에서 `true`로 설정되며,
   * `LayoutSelectionController._onClick`에서 한 번만 소비된다.
   * @internal
   */
  _consumeSuppressNextClick(): boolean {
    if (this._suppressNextClick) {
      this._suppressNextClick = false;
      return true;
    }
    return false;
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
            controller: null as unknown as TextEditController,
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
            controller: null as unknown as TextEditController,
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
      const element = document.getElementById(target);
      if (element instanceof LayoutBoxElement) {
        return element;
      }
      return null;
    }
    return target;
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
            controller: null as unknown as TextEditController,
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
   * 이벤트를 발생시킨다.
   */
  private _dispatch(
    type: EditManagerEventType,
    controller: TextEditController,
    previousParagraph?: LayoutParagraphElement | null,
    previousController?: TextEditController | null,
  ): void {
    if (this._dispatching) return;
    const listeners = this._listeners.get(type);
    if (!listeners) return;

    const event: EditManagerEvent = {
      type,
      paragraph: controller['_paragraph'] as LayoutParagraphElement,
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
}
