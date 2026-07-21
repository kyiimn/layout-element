import { LayoutBoxElement } from "@/components/layout/box.element";
import { LayoutDocumentElement } from "@/components/layout/document.element";
import { EditManager } from "./edit-manager";

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
 * - **이벤트 위임**: `click`을 capture phase로 `document.documentElement`에 등록한다.
 *   `composedPath()`를 통해 shadow DOM 내부의 box까지 추적할 수 있다.
 * - **선택 전용**: 드래그/리사이즈 상태를 관리하지 않고 오직 선택만 처리한다.
 * - **필터링**: `EditManager.isBoxSelectable()`로 선택 가능 여부를 판별한다.
 *   lock, root, role, id 필터를 적용하되 `layoutEditMode` 여부는 확인하지 않는다.
 */
export class LayoutSelectionController {
  /** 이벤트 리스너가 등록되는 루트 요소 (일반적으로 `document.documentElement`) */
  private _document: HTMLElement;
  /** 컨트롤러 활성화 여부. `attach()`/`detach()`로 토글된다 */
  private _attached = false;

  /**
   * @param doc - 이벤트 리스너가 등록될 루트 HTMLElement
   */
  constructor(doc: HTMLElement) {
    this._document = doc;
  }

  /**
   * 컨트롤러를 활성화하여 문서 레벨 click 이벤트 리스너를 등록한다.
   *
   * `click`을 capture phase(`true`)로 등록하여
   * box의 shadow DOM 내부에서 발생한 이벤트도 먼저 가로챌 수 있도록 한다.
   * 이미 활성화된 경우(`_attached === true`) 중복 등록을 방지한다.
   */
  attach(): void {
    if (this._attached) return;
    this._attached = true;
    this._document.addEventListener('click', this._onClick, true);
  }

  /**
   * 컨트롤러를 비활성화하고 리스너를 제거한다.
   */
  detach(): void {
    if (!this._attached) return;
    this._attached = false;
    this._document.removeEventListener('click', this._onClick, true);
  }

  /**
   * 컨트롤러를 완전히 파괴한다. `detach()`와 동일하다.
   */
  destroy(): void {
    this.detach();
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
  private _findSelectableBoxFromEvent(event: MouseEvent): LayoutBoxElement | null {
    const path = event.composedPath();
    for (const el of path) {
      if (el instanceof LayoutBoxElement) {
        const manager = EditManager.getInstance();
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
  private _isEventFromDescendantLayout(event: MouseEvent, box: LayoutBoxElement): boolean {
    const path = event.composedPath();
    const manager = EditManager.getInstance();
    for (const el of path) {
      if (el === box) return false;
      if (el instanceof LayoutBoxElement && manager.isBoxSelectable(el)) return true;
    }
    return false;
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
    const box = this._findSelectableBoxFromEvent(event);
    const manager = EditManager.getInstance();
    if (manager.insertMode) return;
    if (manager._consumeSuppressNextClick()) return;

    if (!box) {
      // 문서 영역 내부의 빈 공간 클릭만 선택 해제로 처리한다.
      // 툴바 버튼 등 문서 영역 밖의 클릭은 무시한다.
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

    // 텍스트 편집 모드: mousedown에서 _requestFocus가 부모 box를 선택했으므로
    // 후속 click의 ctrl 토글이 그 선택을 되돌리지 않도록 건너뛴다.
    const focusedParagraph = manager.focusedParagraph;
    if (manager.textEditMode && focusedParagraph?.parentElement === box) return;

    event.stopPropagation();
    if (this._isEventFromDescendantLayout(event, box)) return;

    box.removeAttribute('hovered');

    manager._setMultiSelect(event.ctrlKey || event.metaKey);
    manager.selectLayout(box);
    manager._setMultiSelect(false);
  }
}