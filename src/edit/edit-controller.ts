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
  private _handleKeydown: (event: KeyboardEvent) => void;

  private _handleInput: (event: InputEvent) => void;
  private _handleCompositionStart: () => void;
  private _handleCompositionUpdate: (event: CompositionEvent) => void;
  private _handleCompositionEnd: (event: CompositionEvent) => void;

  private _isComposing: boolean = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(paragraph: LayoutParagraphElement) {
    this._paragraph = paragraph;
    this._mapper = new EditCoordinateMapper(paragraph);

    this._textarea = this._createTextarea();
    this._cursorEl = document.createElement("x-layout-cursor") as LayoutCursorElement;
    this._selectionEl = document.createElement("x-layout-selection") as LayoutSelectionElement;

    this._handleClick = (event: MouseEvent) => this._onClick(event);
    this._handleFocus = () => this._onFocus();
    this._handleBlur = () => this._onBlur();
    this._handleKeydown = (event: KeyboardEvent) => this._onKeydown(event);

    this._handleInput = (event: InputEvent) => this._onInput(event);
    this._handleCompositionStart = () => this._onCompositionStart();
    this._handleCompositionUpdate = () => this._onCompositionUpdate();
    this._handleCompositionEnd = (event: CompositionEvent) => this._onCompositionEnd(event);

    const shadowRoot = paragraph.shadowRoot;
    if (!shadowRoot) throw new Error("paragraph shadow root is not initialized");

    shadowRoot.appendChild(this._textarea);
    shadowRoot.appendChild(this._cursorEl);
    shadowRoot.appendChild(this._selectionEl);

    paragraph.addEventListener("click", this._handleClick);
    this._textarea.addEventListener("focus", this._handleFocus);
    this._textarea.addEventListener("blur", this._handleBlur);

    this._textarea.addEventListener("input", this._handleInput as EventListener);
    this._textarea.addEventListener("compositionstart", this._handleCompositionStart);
    this._textarea.addEventListener("compositionupdate", this._handleCompositionUpdate as EventListener);
    this._textarea.addEventListener("compositionend", this._handleCompositionEnd as EventListener);
    this._textarea.addEventListener("keydown", this._handleKeydown);

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
    this._textarea.removeEventListener("keydown", this._handleKeydown);
    this._textarea.removeEventListener("input", this._handleInput as EventListener);
    this._textarea.removeEventListener("compositionstart", this._handleCompositionStart);
    this._textarea.removeEventListener("compositionupdate", this._handleCompositionUpdate as EventListener);
    this._textarea.removeEventListener("compositionend", this._handleCompositionEnd as EventListener);

    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

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
    textarea.style.pointerEvents = "auto";
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

  private _onKeydown(event: KeyboardEvent): void {
    const model = this._paragraph.model;
    if (!model) return;

    const content = model.inputContent as string;
    const offset = this._cursorModel.offset;

    switch (event.key) {
      case "ArrowLeft": {
        event.preventDefault();
        if (offset > 0) {
          this._cursorModel.offset = offset - 1;
        }
        this._cursorModel.selection = null;
        this._updateCursorPosition();
        this._updateSelection();
        break;
      }
      case "ArrowRight": {
        event.preventDefault();
        if (offset < content.length) {
          this._cursorModel.offset = offset + 1;
        }
        this._cursorModel.selection = null;
        this._updateCursorPosition();
        this._updateSelection();
        break;
      }
      case "ArrowUp":
      case "ArrowDown": {
        event.preventDefault();
        this._moveCursorVertically(event.key === "ArrowUp" ? -1 : 1);
        this._cursorModel.selection = null;
        this._updateCursorPosition();
        this._updateSelection();
        break;
      }
      case "Home": {
        event.preventDefault();
        this._cursorModel.offset = this._findLineStart(content, offset);
        this._cursorModel.selection = null;
        this._updateCursorPosition();
        this._updateSelection();
        break;
      }
      case "End": {
        event.preventDefault();
        this._cursorModel.offset = this._findLineEnd(content, offset);
        this._cursorModel.selection = null;
        this._updateCursorPosition();
        this._updateSelection();
        break;
      }
      case "Backspace": {
        event.preventDefault();
        if (offset > 0) {
          const newContent = content.slice(0, offset - 1) + content.slice(offset);
          model.inputContent = newContent;
          this._textarea.value = newContent;
          this._cursorModel.offset = offset - 1;
          this._textarea.setSelectionRange(offset - 1, offset - 1);
          this._cursorModel.selection = null;
          this._updateCursorPosition();
          this._updateSelection();
          this._debouncedRender();
        }
        break;
      }
      case "Delete": {
        event.preventDefault();
        if (offset < content.length) {
          const newContent = content.slice(0, offset) + content.slice(offset + 1);
          model.inputContent = newContent;
          this._textarea.value = newContent;
          this._textarea.setSelectionRange(offset, offset);
          this._cursorModel.selection = null;
          this._updateCursorPosition();
          this._updateSelection();
          this._debouncedRender();
        }
        break;
      }
      case "Enter": {
        event.preventDefault();
        const newContent = content.slice(0, offset) + "\n" + content.slice(offset);
        model.inputContent = newContent;
        this._textarea.value = newContent;
        this._cursorModel.offset = offset + 1;
        this._textarea.setSelectionRange(offset + 1, offset + 1);
        this._cursorModel.selection = null;
        this._updateCursorPosition();
        this._updateSelection();
        this._debouncedRender();
        break;
      }
      default:
        // Other keys are handled by input/composition handlers
        break;
    }
  }

  private _moveCursorVertically(direction: -1 | 1): void {
    const model = this._paragraph.model;
    if (!model) return;

    const content = model.inputContent as string;
    const offset = this._cursorModel.offset;

    const cursorRect = this._getCursorLocalRect(offset);
    if (!cursorRect) {
      const newOffset = offset + direction;
      if (newOffset >= 0 && newOffset <= content.length) {
        this._cursorModel.offset = newOffset;
      }
      return;
    }

    const lineHeight = cursorRect.height;
    const paragraphRect = this._paragraph.getBoundingClientRect();
    const targetX = cursorRect.left + paragraphRect.left;
    const targetY = cursorRect.top + paragraphRect.top + direction * lineHeight;

    const result = this._mapper.getCharOffsetFromPoint(targetX, targetY);
    if (result !== null) {
      this._cursorModel.offset = result.textOffset;
    }
  }

  private _getCursorLocalRect(offset: number): DOMRect | null {
    const content = this._paragraph.model?.inputContent as string | undefined;
    if (content === undefined) return null;

    const renderedOffset = this._mapper.renderedOffset(offset);
    if (renderedOffset !== null) {
      return this._mapper.getCharRect(renderedOffset);
    }

    if (offset > 0) {
      const prevRendered = this._mapper.renderedOffset(offset - 1);
      if (prevRendered !== null) {
        const rect = this._mapper.getCharRect(prevRendered);
        if (rect) {
          return new DOMRect(rect.left + rect.width, rect.top, 0, rect.height);
        }
      }
    }

    if (offset < content.length) {
      const nextRendered = this._mapper.renderedOffset(offset + 1);
      if (nextRendered !== null) {
        return this._mapper.getCharRect(nextRendered);
      }
    }

    return null;
  }

  private _findLineStart(content: string, offset: number): number {
    let pos = offset - 1;
    while (pos >= 0 && content[pos] !== "\n") {
      pos--;
    }
    return pos + 1;
  }

  private _findLineEnd(content: string, offset: number): number {
    let pos = offset;
    while (pos < content.length && content[pos] !== "\n") {
      pos++;
    }
    return pos;
  }

  private _onInput(_event: InputEvent): void {
    if (this._isComposing) return;

    const model = this._paragraph.model;
    if (!model) return;

    const before = model.inputContent as string;
    const after = this._textarea.value;
    const change = this._computeTextChange(before, after, this._cursorModel.offset);

    model.inputContent = after;
    this._cursorModel.offset = change.newOffset;

    if (change.type === "insert" && change.text.length === 1) {
      this._optimisticSpanUpdate(change.newOffset - 1, change.text);
    } else if (change.type === "replace" && change.text.length === 1) {
      this._optimisticSpanUpdate(change.newOffset - 1, change.text);
    }

    this._updateCursorPosition();
    this._debouncedRender();
  }

  private _onCompositionStart(): void {
    this._isComposing = true;
    this._cursorModel.selection = null;
    this._updateSelection();
  }

  private _onCompositionUpdate(): void {
  }


  private _onCompositionEnd(event: CompositionEvent): void {
    this._isComposing = false;

    const model = this._paragraph.model;
    if (!model) return;

    const after = this._textarea.value;
    model.inputContent = after;
    this._cursorModel.offset = after.length;

    this._updateCursorPosition();
    this._debouncedRender();

    event.preventDefault();
  }

  private _computeTextChange(
    before: string,
    after: string,
    cursorOffset: number,
  ): { type: "insert" | "delete" | "replace"; text: string; newOffset: number } {
    if (before === after) {
      return { type: "insert", text: "", newOffset: cursorOffset };
    }

    const minLen = Math.min(before.length, after.length);
    let prefix = 0;
    while (prefix < minLen && before[prefix] === after[prefix]) prefix++;

    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
      suffix++;
    }

    const removed = before.slice(prefix, before.length - suffix);
    const inserted = after.slice(prefix, after.length - suffix);

    let type: "insert" | "delete" | "replace" = "replace";
    if (removed.length === 0) type = "insert";
    else if (inserted.length === 0) type = "delete";

    return {
      type,
      text: inserted,
      newOffset: prefix + inserted.length,
    };
  }

  private _optimisticSpanUpdate(sourceOffset: number, char: string): void {
    const renderedOffset = this._mapper.renderedOffset(sourceOffset);
    if (renderedOffset === null) return;

    const span = this._getSpanByOffset(renderedOffset);
    if (span) {
      span.innerText = char;
    }
  }

  private _getSpanByOffset(offset: number): HTMLSpanElement | null {
    const columns = Array.from(this._paragraph.querySelectorAll("x-layout-column"));
    for (const column of columns) {
      if (!column.shadowRoot) continue;
      const span = column.shadowRoot.querySelector<HTMLSpanElement>(`[data-offset="${offset}"]`);
      if (span) return span;
    }
    return null;
  }

  private _debouncedRender(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._paragraph.render();
    }, 150);
  }

  private _updateCursorPosition(): void {
    const content = this._paragraph.model?.inputContent as string | undefined;
    const offset = this._cursorModel.offset;
    let renderedOffset = this._mapper.renderedOffset(offset);
    let atEndOfChar = true; // Cursor at right edge of the rendered char

    if (renderedOffset === null && content !== undefined) {
      // Offset is at a \n position or end-of-string — fallback to adjacent chars
      if (offset > 0) {
        const prevRendered = this._mapper.renderedOffset(offset - 1);
        if (prevRendered !== null) {
          renderedOffset = prevRendered;
          atEndOfChar = true; // Show at end of previous line
        }
      }
      if (renderedOffset === null && offset < content.length) {
        const nextRendered = this._mapper.renderedOffset(offset + 1);
        if (nextRendered !== null) {
          renderedOffset = nextRendered;
          atEndOfChar = false; // Show at start of next line
        }
      }
    }

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
    this._cursorEl.left = atEndOfChar ? rect.left + rect.width : rect.left;
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
