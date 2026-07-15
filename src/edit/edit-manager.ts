import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import { LayoutDocumentElement } from "@/components/layout/document.element";
import { LayoutBoxElement } from "@/components/layout/box.element";
import type { EditController, CurrentStyle } from "./edit-controller";
import type { SelectionRange } from "@/types/edit";

/** 레이아웃 요소 (document 또는 box) */
export type LayoutElement = LayoutDocumentElement | LayoutBoxElement;

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
  | 'layoutResize';

/**
 * 글로벌 편집 관리 이벤트.
 */
export interface EditManagerEvent {
  /** 이벤트 타입 */
  type: EditManagerEventType;
  /** 이벤트가 발생한 단락 요소 (포커스된 단락) */
  paragraph: LayoutParagraphElement;
  /** 이벤트가 발생한 편집 컨트롤러 */
  controller: EditController;
  /** 이전 포커스 단락 (focusChange 이벤트에서만) */
  previousParagraph?: LayoutParagraphElement | null;
  /** 이전 편집 컨트롤러 (focusChange 이벤트에서만) */
  previousController?: EditController | null;
  /** 레이아웃 선택 변경 시 선택된 요소들 (layoutSelectionChange 이벤트에서만) */
  selectedLayouts?: LayoutElement[];
  /** 레이아웃 선택 변경 시 이전 선택 요소들 (layoutSelectionChange 이벤트에서만) */
  previousLayouts?: LayoutElement[];
  /** 레이아웃 이동 이벤트에서 이동된 요소 (layoutMove 이벤트에서만) */
  layoutElement?: LayoutElement;
  /** 이동 전 left 값 (layoutMove 이벤트에서만) */
  previousLeft?: number;
  /** 이동 전 top 값 (layoutMove 이벤트에서만) */
  previousTop?: number;
  /** 이동 후 left 값 (layoutMove 이벤트에서만) */
  left?: number;
  /** 이동 후 top 값 (layoutMove 이벤트에서만) */
  top?: number;
  /** 이동이 취소되었는지 여부 (ESC 취소 시 true) (layoutMove 이벤트에서만) */
  canceled?: boolean;
  /** 리사이즈 전 width 값 (layoutResize 이벤트에서만) */
  previousWidth?: number;
  /** 리사이즈 전 height 값 (layoutResize 이벤트에서만) */
  previousHeight?: number;
  /** 리사이즈 후 width 값 (layoutResize 이벤트에서만) */
  width?: number;
  /** 리사이즈 후 height 값 (layoutResize 이벤트에서만) */
  height?: number;
}

/**
 * 이벤트 리스너 함수 타입.
 */
export type EditManagerEventListener = (event: EditManagerEvent) => void;

/**
 * 글로벌 편집 관리자 (싱글톤).
 *
 * 문서 내 모든 `EditController` 인스턴스를 중앙에서 관리한다.
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
  private _controllers: Set<EditController> = new Set();
  private _focusedController: EditController | null = null;
  private _listeners: Map<EditManagerEventType, Set<EditManagerEventListener>> = new Map();
  private _dispatching = false;
  private _selectedLayouts: LayoutElement[] = [];
  private _isLayoutDragging = false;
  private _isLayoutResizing = false;

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
   * 편집 컨트롤러를 등록한다.
   * `EditController` 생성자에서 호출된다.
   * @internal
   */
  _register(controller: EditController): void {
    this._controllers.add(controller);
  }

  /**
   * 편집 컨트롤러를 해제한다.
   * `EditController.destroy()`에서 호출된다.
   * 포커스된 컨트롤러가 해제되면 포커스를 null로 설정한다.
   * @internal
   */
  _unregister(controller: EditController): void {
    this._controllers.delete(controller);
    if (this._focusedController === controller) {
      const previousParagraph = controller['_paragraph'] as LayoutParagraphElement;
      this._focusedController = null;
      this._dispatch('focusChange', controller, previousParagraph, controller);
    }
  }

  /**
   * 포커스를 요청한다.
   * `EditController._onFocus()`에서 호출된다.
   * 다른 컨트롤러가 포커스를 가지고 있으면 해당 컨트롤러의 선택 영역을 해제하고
   * blur 처리한 후, 새 컨트롤러에게 포커스를 부여한다.
   * @internal
   */
  _requestFocus(controller: EditController): void {
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

    this._focusedController = controller;
    this._dispatch('focusChange', controller, previousParagraph ?? null, previousController);
  }

  /**
   * 포커스를 해제한다.
   * `EditController._onBlur()`에서 호출된다.
   * @internal
   */
  _releaseFocus(controller: EditController): void {
    if (this._focusedController !== controller) return;
    const previousParagraph = controller['_paragraph'] as LayoutParagraphElement;
    this._focusedController = null;
    this._dispatch('focusChange', controller, previousParagraph, controller);
  }

  /**
   * 텍스트 변경 이벤트를 발생시킨다.
   * `EditController`에서 텍스트가 변경될 때 호출된다.
   * @internal
   */
  _notifyTextChange(controller: EditController): void {
    this._dispatch('textChange', controller);
  }

  /**
   * 스타일 변경 이벤트를 발생시킨다.
   * `EditController`에서 스타일이 변경될 때 호출된다.
   * @internal
   */
  _notifyStyleChange(controller: EditController): void {
    this._dispatch('styleChange', controller);
  }

  /**
   * 선택 시작 이벤트를 발생시킨다.
   * `EditController`에서 선택이 시작될 때 호출된다.
   * @internal
   */
  _notifySelectionStart(controller: EditController): void {
    this._dispatch('selectionStart', controller);
  }

  /**
   * 선택 종료 이벤트를 발생시킨다.
   * `EditController`에서 선택이 종료될 때 호출된다.
   * @internal
   */
  _notifySelectionEnd(controller: EditController): void {
    this._dispatch('selectionEnd', controller);
  }

  /**
   * 커서 이동 이벤트를 발생시킨다.
   * 키보드 입력, 마우스 클릭, 외부 API 등 커서 위치가 변경될 때 호출된다.
   * 키보드 연속 입력 시 최초 KeyDown과 마지막 KeyUp에만 발생한다.
   * @internal
   */
  _notifyCursorMove(controller: EditController): void {
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
  get focusedController(): EditController | null {
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
  get controllers(): Set<EditController> {
    return new Set(this._controllers);
  }

  /**
   * 단락 요소 또는 ID로 포커스를 설정한다.
   *
   * 지정된 단락이 편집 모드가 아니면 `editable = true`로 설정하여
   * `EditController`를 생성한 뒤 포커스를 부여한다.
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
  private _findControllerByParagraph(paragraph: LayoutParagraphElement): EditController | null {
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
    for (const controller of this._controllers) {
      const paragraph = controller['_paragraph'] as LayoutParagraphElement;
      paragraph.editableText = false;
    }
  }

  /**
   * 레이아웃 요소를 선택한다.
   *
   * `editableLayout`이 켜진 document 또는 box 요소만 선택할 수 있다.
   * `multi`가 `false`(기본값)이면 기존 선택을 모두 해제하고 지정된 요소만 선택한다.
   * `multi`가 `true`이면 기존 선택에 지정된 요소를 추가/토글한다.
   *
   * @param target - 선택할 레이아웃 요소, 요소의 ID, 또는 그 배열
   * @param multi - 다중 선택 모드. `true`면 기존 선택에 추가/토글
   * @returns 선택 성공 여부. 하나도 선택하지 못하면 `false`
   */
  selectLayout(target: LayoutElement | string | (LayoutElement | string)[]): boolean {
    const targets = Array.isArray(target) ? target : [target];
    const newSelections: LayoutElement[] = [];

    for (const t of targets) {
      const element = this._resolveLayoutElement(t);
      if (!element) continue;
      if (!element.editableLayout) continue;
      newSelections.push(element);
    }

    if (newSelections.length === 0) return false;

    const previousLayouts = [...this._selectedLayouts];

    if (this._multiSelect) {
      for (const el of newSelections) {
        const idx = this._selectedLayouts.indexOf(el);
        if (idx >= 0) {
          this._selectedLayouts.splice(idx, 1);
          el.removeAttribute('data-selected');
        } else {
          this._selectedLayouts.push(el);
          el.setAttribute('data-selected', '');
        }
      }
    } else {
      for (const prev of this._selectedLayouts) {
        prev.removeAttribute('data-selected');
      }
      this._selectedLayouts = newSelections;
      for (const el of newSelections) {
        el.setAttribute('data-selected', '');
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
      el.removeAttribute('data-selected');
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
   * 다중 선택 모드를 설정한다. `true`면 다음 `selectLayout` 호출이 토글 모드로 동작한다.
   * @internal
   */
  _setMultiSelect(value: boolean): void {
    this._multiSelect = value;
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
   *   LayoutDocumentElement은 드래그 대상이 아니므로 항상 제외된다.
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
      element.removeAttribute('data-selected');
      this._dispatchLayoutSelection(previousLayouts);
    }
  }

  /**
   * 레이아웃 요소의 이동 완료/취소 이벤트를 발생시킨다.
   * @internal
   */
  _dispatchLayoutMove(
    element: LayoutElement,
    previousLeft: number,
    previousTop: number,
    left: number,
    top: number,
    canceled: boolean,
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
            controller: null as unknown as EditController,
            layoutElement: element,
            previousLeft,
            previousTop,
            left,
            top,
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
            controller: null as unknown as EditController,
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
      if (element instanceof LayoutDocumentElement || element instanceof LayoutBoxElement) {
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
            controller: null as unknown as EditController,
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
    controller: EditController,
    previousParagraph?: LayoutParagraphElement | null,
    previousController?: EditController | null,
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
