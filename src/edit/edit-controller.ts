import { LayoutCursorElement, LayoutSelectionElement } from "@/components";
import { LayoutParagraphElement } from "@/components/paragraph.element";
import { CursorPosition } from "@/types/edit/cursor.type";
import { SelectionRange } from "@/types/edit/selection.type";
import { EditCoordinateMapper } from "./edit-coordinate-mapper";

/**
 * 단락 편집 상태를 관리하는 컨트롤러.
 *
 * `LayoutParagraphElement`가 `editable = true`일 때 생성되며,
 * 단락의 shadow root에 숨겨진 `<textarea>`, 커서 요소, 선택 영역 요소를 추가한다.
 * 렌더링된 문자 위치와 소스 텍스트 오프셋 간의 매핑은 `EditCoordinateMapper`가 담당한다.
 */
export class EditController {
  private _paragraph: LayoutParagraphElement;
  private _mapper: EditCoordinateMapper;

  private _textarea: HTMLTextAreaElement;
  private _cursorEl: LayoutCursorElement;
  private _selectionEl: LayoutSelectionElement;

  private _cursorModel: CursorModel = { offset: 0, selection: null };

  private _handleClick: (event: MouseEvent) => void;
  private _handleFocus: () => void;
  private _handleBlur: () => void;

  constructor(paragraph: LayoutParagraphElement) {
    this._paragraph = paragraph;
    this._mapper = new EditCoordinateMapper(paragraph);

    this._textarea = this._createTextarea();
    this._cursorEl = document.createElement("x-layout-cursor") as LayoutCursorElement;
    this._selectionEl = document.createElement("x-layout-selection") as LayoutSelectionElement;

    this._handleClick = (event: MouseEvent) => this._onClick(event);
    this._handleFocus = () => this._onFocus();
    this._handleBlur = () => this._onBlur();

    const shadowRoot = paragraph.shadowRoot;
    if (!shadowRoot) throw new Error("paragraph shadow root is not initialized");

    shadowRoot.appendChild(this._textarea);
    shadowRoot.appendChild(this._cursorEl);
    shadowRoot.appendChild(this._selectionEl);

    paragraph.addEventListener("click", this._handleClick);
    this._textarea.addEventListener("focus", this._handleFocus);
    this._textarea.addEventListener("blur", this._handleBlur);

    this._updateCursorPosition();
  }

  /**
   * 커서의 현재 소스 오프셋을 반환한다.
   */
  get cursorOffset(): number {
    return this._cursorModel.offset;
  }

  /**
   * 현재 선택 영역을 반환한다. 선택이 없으면 `null`이다.
   */
  get selection(): SelectionRange | null {
    return this._cursorModel.selection;
  }

  /**
   * 편집기를 제거하고 모든 이벤트 리스너를 해제한다.
   */
  destroy(): void {
    this._paragraph.removeEventListener("click", this._handleClick);
    this._textarea.removeEventListener("focus", this._handleFocus);
    this._textarea.removeEventListener("blur", this._handleBlur);

    if (this._textarea.parentNode) {
      this._textarea.parentNode.removeChild(this._textarea);
    }
    if (this._cursorEl.parentNode) {
      this._cursorEl.parentNode.removeChild(this._cursorEl);
    }
    if (this._selectionEl.parentNode) {
      this._selectionEl.parentNode.removeChild(this._selectionEl);
    }
  }

  /**
   * 렌더링 이후 좌표 매퍼를 재구축하고 커서/선택 영역을 다시 배치한다.
   */
  postRender(): void {
    this._mapper.rebuild();
    this._updateCursorPosition();
    this._updateSelection();
  }

  /**
   * 숨겨진 textarea에 포커스를 준다.
   */
  focus(): void {
    this._textarea.focus();
  }

  /**
   * 숨겨진 textarea에서 포커스를 해제한다.
   */
  blur(): void {
    this._textarea.blur();
  }

  private _createTextarea(): HTMLTextAreaElement {
    const textarea = document.createElement("textarea");
    textarea.style.position = "absolute";
    textarea.style.opacity = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.pointerEvents = "none";
    textarea.style.border = "none";
    textarea.style.padding = "0";
    textarea.style.margin = "0";
    textarea.style.resize = "none";
    textarea.style.overflow = "hidden";
    textarea.style.zIndex = "9999";
    textarea.setAttribute("aria-hidden", "true");
    textarea.setAttribute("tabindex", "-1");
    return textarea;
  }

  private _onClick(event: MouseEvent): void {
    const path = event.composedPath();
    let targetSpan: HTMLSpanElement | null = null;

    for (const node of path) {
      if (node instanceof HTMLSpanElement && node.dataset.offset !== undefined) {
        targetSpan = node;
        break;
      }
    }

    if (!targetSpan) return;

    const renderedOffset = parseInt(targetSpan.dataset.offset ?? "", 10);
    if (Number.isNaN(renderedOffset)) return;

    const sourceOffset = this._mapper.sourceOffset(renderedOffset);
    if (sourceOffset === null) return;

    this._cursorModel.offset = sourceOffset;
    this._cursorModel.selection = null;

    this.focus();
    this._updateCursorPosition();
    this._updateSelection();
  }

  private _onFocus(): void {
    this._cursorEl.visible = true;
  }

  private _onBlur(): void {
    this._cursorEl.visible = false;
  }

  private _updateCursorPosition(): void {
    const renderedOffset = this._mapper.renderedOffset(this._cursorModel.offset);
    if (renderedOffset === null) {
      this._cursorEl.visible = false;
      return;
    }

    const rect = this._mapper.getCharRect(renderedOffset);
    if (!rect) {
      this._cursorEl.visible = false;
      return;
    }

    this._cursorEl.top = rect.top;
    this._cursorEl.left = rect.left + rect.width;
    this._cursorEl.height = rect.height;
    this._cursorEl.visible = true;

    this._textarea.style.top = `${rect.top}px`;
    this._textarea.style.left = `${rect.left}px`;
  }

  private _updateSelection(): void {
    if (!this._cursorModel.selection) {
      this._selectionEl.setRanges([]);
      return;
    }

    const { start, end } = this._cursorModel.selection.normalized();
    const ranges = this._mapper.getTextRange(start.textOffset, end.textOffset);
    this._selectionEl.setRanges(ranges);
  }

  /**
   * 외부에서 커서 위치를 설정할 때 사용한다.
   * T10 이후 입력 핸들러에서 사용될 예정.
   */
  setCursor(position: CursorPosition): void {
    this._cursorModel.offset = position.textOffset;
    this._updateCursorPosition();
  }

  /**
   * 외부에서 선택 영역을 설정할 때 사용한다.
   * T14 이후 선택 핸들러에서 사용될 예정.
   */
  setSelection(range: SelectionRange): void {
    this._cursorModel.selection = range;
    this._updateSelection();
  }
}

/**
 * 커서/선택의 내부 상태.
 */
interface CursorModel {
  offset: number;
  selection: SelectionRange | null;
}
