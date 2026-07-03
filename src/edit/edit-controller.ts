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
  private _handlePaste: (event: ClipboardEvent) => void;

  private _handleMouseDown: (event: MouseEvent) => void;
  private _handleMouseMove: (event: MouseEvent) => void;
  private _handleMouseUp: (event: MouseEvent) => void;
  private _handleDoubleClick: (event: MouseEvent) => void;
  private _handleTripleClick: (event: MouseEvent) => void;
  private _handleVisibilityChange: () => void;
  private _clickCount: number = 0;
  private _clickTimer: ReturnType<typeof setTimeout> | null = null;

  private _isComposing: boolean = false;
  private _compositionStartOffset: number = 0;
  private _compositionJustEnded: boolean = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _wasFocused: boolean = false;

  private _selectionAnchor: number | null = null;
  private _isMouseDown: boolean = false;
  private _mousemoveRafId: number | null = null;

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
    this._handlePaste = (event: ClipboardEvent) => this._onPaste(event);

    this._handleMouseDown = (event: MouseEvent) => this._onMouseDown(event);
    this._handleMouseMove = (event: MouseEvent) => this._onMouseMove(event);
    this._handleMouseUp = (event: MouseEvent) => this._onMouseUp(event);
    this._handleDoubleClick = (event: MouseEvent) => this._onDoubleClick(event);
    this._handleTripleClick = (event: MouseEvent) => this._onTripleClick(event);
    void this._handleTripleClick;

    const shadowRoot = paragraph.shadowRoot;
    if (!shadowRoot) throw new Error("paragraph shadow root is not initialized");

    shadowRoot.appendChild(this._textarea);
    shadowRoot.appendChild(this._cursorEl);
    shadowRoot.appendChild(this._selectionEl);

    paragraph.addEventListener("click", this._handleClick);
    paragraph.addEventListener("mousedown", this._handleMouseDown);
    paragraph.addEventListener("dblclick", this._handleDoubleClick);
    document.addEventListener("mouseup", this._handleMouseUp);

    this._textarea.addEventListener("focus", this._handleFocus);
    this._textarea.addEventListener("blur", this._handleBlur);

    this._textarea.addEventListener("input", this._handleInput as EventListener);
    this._textarea.addEventListener("compositionstart", this._handleCompositionStart);
    this._textarea.addEventListener("compositionupdate", this._handleCompositionUpdate as EventListener);
    this._textarea.addEventListener("compositionend", this._handleCompositionEnd as EventListener);
    this._textarea.addEventListener("keydown", this._handleKeydown);
    this._textarea.addEventListener("paste", this._handlePaste as EventListener);

    this._handleVisibilityChange = () => {
      if (document.hidden) {
        this._isComposing = false;
        this._compositionJustEnded = false;
      }
    };
    document.addEventListener("visibilitychange", this._handleVisibilityChange);

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
    this._paragraph.removeEventListener("mousedown", this._handleMouseDown);
    this._paragraph.removeEventListener("dblclick", this._handleDoubleClick);
    document.removeEventListener("mouseup", this._handleMouseUp);
    document.removeEventListener("mousemove", this._handleMouseMove);

    if (this._clickTimer !== null) {
      clearTimeout(this._clickTimer);
      this._clickTimer = null;
    }

    this._textarea.removeEventListener("focus", this._handleFocus);
    this._textarea.removeEventListener("blur", this._handleBlur);
    this._textarea.removeEventListener("keydown", this._handleKeydown);
    this._textarea.removeEventListener("input", this._handleInput as EventListener);
    this._textarea.removeEventListener("compositionstart", this._handleCompositionStart);
    this._textarea.removeEventListener("compositionupdate", this._handleCompositionUpdate as EventListener);
    this._textarea.removeEventListener("compositionend", this._handleCompositionEnd as EventListener);
    this._textarea.removeEventListener("paste", this._handlePaste as EventListener);

    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    if (this._mousemoveRafId !== null) {
      cancelAnimationFrame(this._mousemoveRafId);
      this._mousemoveRafId = null;
    }

    document.removeEventListener("visibilitychange", this._handleVisibilityChange);

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
    if (this._wasFocused) {
      this._textarea.focus();
      this._wasFocused = false;
    }
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
    this._clickCount++;
    if (this._clickTimer !== null) {
      clearTimeout(this._clickTimer);
    }
    this._clickTimer = setTimeout(() => {
      this._clickCount = 0;
      this._clickTimer = null;
    }, 300);

    if (this._clickCount >= 3) {
      event.preventDefault();
      this._clickCount = 0;
      if (this._clickTimer !== null) {
        clearTimeout(this._clickTimer);
        this._clickTimer = null;
      }
      this._onTripleClick(event);
      return;
    }

    const sourceOffset = this._getSourceOffsetFromEvent(event);
    if (sourceOffset === null) {
      const rect = this._paragraph.getBoundingClientRect();
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        const content = this._paragraph.model?.inputContent;
        if (content !== undefined) {
          if (event.shiftKey) {
            this._extendSelection(0);
          } else {
            this._cursorModel.offset = 0;
            this._cursorModel.selection = null;
          }
          this.focus();
          this._updateCursorPosition();
          this._updateSelection();
        }
      }
      return;
    }

    if (!event.shiftKey) {
      this._cursorModel.offset = sourceOffset;
      this._cursorModel.selection = null;
      this._updateCursorPosition();
      this._updateSelection();
      this.focus();
      return;
    }

    this._extendSelection(sourceOffset);
    this.focus();
    this._updateCursorPosition();
    this._updateSelection();
  }

  private _onTripleClick(event: MouseEvent): void {
    event.preventDefault();
    this._selectAll();
  }

  private _getSourceOffsetFromEvent(event: MouseEvent): number | null {
    const path = event.composedPath();
    let targetSpan: HTMLSpanElement | null = null;

    for (const node of path) {
      if (node instanceof HTMLSpanElement && node.dataset.offset !== undefined) {
        targetSpan = node;
        break;
      }
    }

    if (!targetSpan) return null;

    const renderedOffset = parseInt(targetSpan.dataset.offset ?? "", 10);
    if (Number.isNaN(renderedOffset)) return null;

    const sourceOffset = this._mapper.sourceOffset(renderedOffset);
    if (sourceOffset === null) return null;

    const spanRect = targetSpan.getBoundingClientRect();
    const midpoint = spanRect.left + spanRect.width / 2;
    if (event.clientX >= midpoint) {
      const content = this._paragraph.model?.inputContent as string | undefined;
      if (content !== undefined && sourceOffset < content.length) {
        return sourceOffset + 1;
      }
    }

    return sourceOffset;
  }

  private _onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;

    const sourceOffset = this._getSourceOffsetFromEvent(event);
    if (sourceOffset === null) {
      const rect = this._paragraph.getBoundingClientRect();
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        const content = this._paragraph.model?.inputContent;
        if (content !== undefined) {
          if (event.shiftKey) {
            this._extendSelection(0);
          } else {
            this._cursorModel.offset = 0;
            this._cursorModel.selection = null;
          }
          this._isMouseDown = true;
          this._selectionAnchor = 0;
          this.focus();
          this._updateCursorPosition();
          this._updateSelection();
          document.addEventListener("mousemove", this._handleMouseMove);
        }
      }
      return;
    }

    event.preventDefault();
    this._isMouseDown = true;
    if (event.shiftKey) {
      this._extendSelection(sourceOffset);
      this.focus();
      this._updateCursorPosition();
      this._updateSelection();
      document.addEventListener("mousemove", this._handleMouseMove);
      return;
    }
    this._selectionAnchor = sourceOffset;
    this._cursorModel.offset = sourceOffset;
    this._cursorModel.selection = null;
    this.focus();
    this._updateCursorPosition();
    this._updateSelection();
    document.addEventListener("mousemove", this._handleMouseMove);
  }

  private _onMouseMove(event: MouseEvent): void {
    if (!this._isMouseDown) return;
    if (this._mousemoveRafId !== null) return;

    this._mousemoveRafId = requestAnimationFrame(() => {
      this._mousemoveRafId = null;
      if (!this._isMouseDown) return;

      const result = this._mapper.getCharOffsetFromPoint(event.clientX, event.clientY);
      if (result === null) return;

      const focusOffset = result.textOffset;
      const anchor = this._selectionAnchor ?? this._cursorModel.offset;
      this._cursorModel.selection = SelectionRange.fromOffsets(anchor, focusOffset);
      this._cursorModel.offset = focusOffset;
      this._updateCursorPosition();
      this._updateSelection();
    });
  }

  private _onMouseUp(_event: MouseEvent): void {
    if (!this._isMouseDown) return;
    this._isMouseDown = false;
    this._selectionAnchor = null;
    if (this._mousemoveRafId !== null) {
      cancelAnimationFrame(this._mousemoveRafId);
      this._mousemoveRafId = null;
    }
    document.removeEventListener("mousemove", this._handleMouseMove);
  }

  private _onDoubleClick(event: MouseEvent): void {
    event.preventDefault();

    const sourceOffset = this._getSourceOffsetFromEvent(event);
    if (sourceOffset === null) return;

    const model = this._paragraph.model;
    if (!model) return;

    const content = model.inputContent as string;
    const { start, end } = this._findWordBoundaries(content, sourceOffset);
    this._cursorModel.selection = SelectionRange.fromOffsets(start, end);
    this._cursorModel.offset = end;
    this.focus();
    this._updateCursorPosition();
    this._updateSelection();
  }

  private _findWordBoundaries(content: string, offset: number): { start: number; end: number } {
    const clamped = Math.max(0, Math.min(offset, content.length));

    if (clamped < content.length && /\s/.test(content[clamped])) {
      let end = clamped;
      while (end < content.length && /\s/.test(content[end])) end++;
      let start = clamped;
      while (start > 0 && /\s/.test(content[start - 1])) start--;
      return { start, end };
    }

    let start = clamped;
    let end = clamped;
    while (start > 0 && !this._isWordBoundary(content[start - 1])) start--;
    while (end < content.length && !this._isWordBoundary(content[end])) end++;
    return { start, end };
  }

  private _isWordBoundary(char: string): boolean {
    return /\s/.test(char);
  }

  private _onFocus(): void {
    if (this._cursorModel.selection) {
      this._cursorEl.visible = false;
    } else {
      this._cursorEl.visible = true;
    }
  }

  private _onBlur(): void {
    this._isComposing = false;
    this._compositionJustEnded = false;
    this._cursorEl.visible = false;
  }

  private _onKeydown(event: KeyboardEvent): void {
    this._compositionJustEnded = false;
    if (this._isComposing && event.key !== "Escape") return;
    const model = this._paragraph.model;
    if (!model) return;

    if (typeof model.inputContent !== "string") return;

    const content = model.inputContent;
    const offset = this._cursorModel.offset;
    const hasShortcut = event.ctrlKey || event.metaKey;

    if (hasShortcut && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this._selectAll();
      return;
    }

    if (hasShortcut && (event.key.toLowerCase() === "c" || event.key.toLowerCase() === "x")) {
      event.preventDefault();
      this._copySelection();
      if (event.key.toLowerCase() === "x") {
        this._deleteSelection();
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      this._clearSelection();
      return;
    }

    const isShift = event.shiftKey;

    switch (event.key) {
      case "ArrowLeft": {
        event.preventDefault();
        if (isShift) {
          this._extendSelection(offset > 0 ? offset - 1 : offset);
        } else {
          if (offset > 0) {
            this._cursorModel.offset = offset - 1;
          }
          this._cursorModel.selection = null;
        }
        this._updateCursorPosition();
        this._updateSelection();
        break;
      }
      case "ArrowRight": {
        event.preventDefault();
        if (isShift) {
          this._extendSelection(offset < content.length ? offset + 1 : offset);
        } else {
          if (offset < content.length) {
            this._cursorModel.offset = offset + 1;
          }
          this._cursorModel.selection = null;
        }
        this._updateCursorPosition();
        this._updateSelection();
        break;
      }
      case "ArrowUp":
      case "ArrowDown": {
        event.preventDefault();
        const newOffset = this._computeVerticalOffset(event.key === "ArrowUp" ? -1 : 1);
        if (isShift) {
          this._extendSelection(newOffset ?? offset);
        } else {
          if (newOffset !== null) {
            this._cursorModel.offset = newOffset;
          }
          this._cursorModel.selection = null;
        }
        this._updateCursorPosition();
        this._updateSelection();
        break;
      }
      case "Home": {
        event.preventDefault();
        const lineStart = this._findLineStart(content, offset);
        if (isShift) {
          this._extendSelection(lineStart);
        } else {
          this._cursorModel.offset = lineStart;
          this._cursorModel.selection = null;
        }
        this._updateCursorPosition();
        this._updateSelection();
        break;
      }
      case "End": {
        event.preventDefault();
        const lineEnd = this._findLineEnd(content, offset);
        if (isShift) {
          this._extendSelection(lineEnd);
        } else {
          this._cursorModel.offset = lineEnd;
          this._cursorModel.selection = null;
        }
        this._updateCursorPosition();
        this._updateSelection();
        break;
      }
      case "Backspace": {
        event.preventDefault();
        const activeSelection = this._cursorModel.selection;
        if (activeSelection) {
          this._replaceSelection("");
          this._updateCursorPosition();
          this._updateSelection();
          this._debouncedRender();
        } else if (offset > 0) {
          const newContent = content.slice(0, offset - 1) + content.slice(offset);
          model.inputContent = newContent;
          this._textarea.value = newContent;
          this._cursorModel.offset = offset - 1;
          this._textarea.setSelectionRange(offset - 1, offset - 1);
          this._updateCursorPosition();
          this._updateSelection();
          this._debouncedRender();
        }
        break;
      }
      case "Delete": {
        event.preventDefault();
        const activeSelection = this._cursorModel.selection;
        if (activeSelection) {
          this._replaceSelection("");
          this._updateCursorPosition();
          this._updateSelection();
          this._debouncedRender();
        } else if (offset < content.length) {
          const newContent = content.slice(0, offset) + content.slice(offset + 1);
          model.inputContent = newContent;
          this._textarea.value = newContent;
          this._textarea.setSelectionRange(offset, offset);
          this._updateCursorPosition();
          this._updateSelection();
          this._debouncedRender();
        }
        break;
      }
      case "Enter": {
        event.preventDefault();
        const activeSelection = this._cursorModel.selection;
        const { start, end } = activeSelection?.normalized() ?? { start: null, end: null };
        const replaceStart = start?.textOffset ?? offset;
        const replaceEnd = end?.textOffset ?? offset;

        const newContent = content.slice(0, replaceStart) + "\n" + content.slice(replaceEnd);
        model.inputContent = newContent;
        this._textarea.value = newContent;
        this._cursorModel.offset = replaceStart + 1;
        this._textarea.setSelectionRange(replaceStart + 1, replaceStart + 1);
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

  private _extendSelection(newOffset: number): void {
    const current = this._cursorModel;
    const anchor = current.selection?.anchor.textOffset ?? current.offset;
    current.selection = SelectionRange.fromOffsets(anchor, newOffset);
    current.offset = newOffset;
  }

  private _copySelection(): void {
    const selection = this._cursorModel.selection;
    if (!selection) return;

    const { start, end } = selection.normalized();
    const text = this._mapper.getTextContent(start.textOffset, end.textOffset);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => this._copyWithFallback(text));
    } else {
      this._copyWithFallback(text);
    }
  }

  private _copyWithFallback(text: string): void {
    const saved = this._textarea.value;
    const savedStart = this._textarea.selectionStart;
    const savedEnd = this._textarea.selectionEnd;
    this._textarea.value = text;
    this._textarea.select();
    document.execCommand("copy");
    this._textarea.value = saved;
    this._textarea.setSelectionRange(savedStart, savedEnd);
  }

  private _deleteSelection(): void {
    const model = this._paragraph.model;
    if (!model) return;

    const selection = this._cursorModel.selection;
    if (!selection) return;

    const content = model.inputContent as string;
    const { start, end } = selection.normalized();
    const newContent = content.slice(0, start.textOffset) + content.slice(end.textOffset);

    model.inputContent = newContent;
    this._textarea.value = newContent;
    this._cursorModel.offset = start.textOffset;
    this._cursorModel.selection = null;
    this._textarea.setSelectionRange(start.textOffset, start.textOffset);
    this._updateCursorPosition();
    this._updateSelection();
    this._debouncedRender();
  }

  private _onPaste(event: ClipboardEvent): void {
    event.preventDefault();

    const model = this._paragraph.model;
    if (!model) return;

    const pastedText = event.clipboardData?.getData("text/plain") ?? "";
    if (pastedText.length === 0) return;

    const content = model.inputContent as string;
    let startOffset = this._cursorModel.offset;
    let endOffset = this._cursorModel.offset;

    const selection = this._cursorModel.selection;
    if (selection) {
      const { start, end } = selection.normalized();
      startOffset = start.textOffset;
      endOffset = end.textOffset;
    }

    const newContent = content.slice(0, startOffset) + pastedText + content.slice(endOffset);
    const newOffset = startOffset + pastedText.length;

    model.inputContent = newContent;
    this._textarea.value = newContent;
    this._cursorModel.offset = newOffset;
    this._cursorModel.selection = null;
    this._textarea.setSelectionRange(newOffset, newOffset);
    this._updateCursorPosition();
    this._updateSelection();
    this._debouncedRender();
  }

  private _selectAll(): void {
    const model = this._paragraph.model;
    if (!model) return;

    const content = model.inputContent as string;
    this._cursorModel.selection = SelectionRange.fromOffsets(0, content.length);
    this._cursorModel.offset = content.length;
    this._updateCursorPosition();
    this._updateSelection();
  }

  private _clearSelection(): void {
    this._cursorModel.selection = null;
    this._selectionEl.setRanges([]);
    this._updateCursorPosition();
  }

  private _computeVerticalOffset(direction: -1 | 1): number | null {
    const model = this._paragraph.model;
    if (!model) return null;

    const content = model.inputContent as string;
    const offset = this._cursorModel.offset;

    const cursorRect = this._getCursorLocalRect(offset);
    if (!cursorRect) {
      const newOffset = offset + direction;
      if (newOffset >= 0 && newOffset <= content.length) {
        return newOffset;
      }
      return null;
    }

    const lineHeight = cursorRect.height;
    const paragraphRect = this._paragraph.getBoundingClientRect();
    const targetX = cursorRect.left + paragraphRect.left;
    const targetY = cursorRect.top + paragraphRect.top + direction * lineHeight;

    const result = this._mapper.getCharOffsetFromPoint(targetX, targetY);
    return result?.textOffset ?? null;
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

  private _onInput(event: InputEvent): void {
    if (this._isComposing) return;
    if (this._compositionJustEnded) {
      this._compositionJustEnded = false;
      return;
    }

    const model = this._paragraph.model;
    if (!model) return;
    if (typeof model.inputContent !== "string") return;

    const before = model.inputContent;
    let after = this._textarea.value;
    let newOffset: number;

    const activeSelection = this._cursorModel.selection;
    if (activeSelection) {
      const { start, end } = activeSelection.normalized();
      const startOffset = start.textOffset;
      const endOffset = end.textOffset;

      let inserted = "";
      if (event.data !== null && event.data !== undefined) {
        inserted = event.data;
      }

      const replaced = before.slice(0, startOffset) + inserted + before.slice(endOffset);
      newOffset = startOffset + inserted.length;

      model.inputContent = replaced;
      this._textarea.value = replaced;
      this._textarea.setSelectionRange(newOffset, newOffset);
      this._cursorModel.offset = newOffset;
      this._cursorModel.selection = null;

      if (inserted.length === 1) {
        this._optimisticSpanUpdate(newOffset - 1, inserted);
      }

      this._updateCursorPosition();
      this._updateSelection();
      this._debouncedRender();
      return;
    }

    const change = this._computeTextChange(before, after, this._cursorModel.offset);

    model.inputContent = after;
    newOffset = change.newOffset;
    this._cursorModel.offset = newOffset;

    if (change.type === "insert" && change.text.length === 1) {
      this._optimisticSpanUpdate(newOffset - 1, change.text);
    } else if (change.type === "replace" && change.text.length === 1) {
      this._optimisticSpanUpdate(newOffset - 1, change.text);
    }

    this._updateCursorPosition();
    this._debouncedRender();
  }

  private _replaceSelection(replacement: string): void {
    const model = this._paragraph.model;
    if (!model) return;

    const content = model.inputContent as string;
    const activeSelection = this._cursorModel.selection;
    if (!activeSelection) return;

    const { start, end } = activeSelection.normalized();
    const newContent = content.slice(0, start.textOffset) + replacement + content.slice(end.textOffset);

    model.inputContent = newContent;
    this._textarea.value = newContent;
    this._cursorModel.offset = start.textOffset + replacement.length;
    this._textarea.setSelectionRange(this._cursorModel.offset, this._cursorModel.offset);
    this._cursorModel.selection = null;

    this._updateCursorPosition();
    this._updateSelection();
    this._debouncedRender();
  }

  private _onCompositionStart(): void {
    this._isComposing = true;

    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    if (this._cursorModel.selection) {
      this._compositionStartOffset = this._cursorModel.selection.normalized().start.textOffset;
    } else {
      this._compositionStartOffset = this._cursorModel.offset;
    }
    this._cursorModel.selection = null;
    this._updateSelection();
  }

  private _onCompositionUpdate(): void {
    if (!this._isComposing) return;
    this._updateCursorPosition();
  }


  private _onCompositionEnd(event: CompositionEvent): void {
    this._isComposing = false;

    const model = this._paragraph.model;
    if (!model) return;
    if (typeof model.inputContent !== "string") return;

    const after = this._textarea.value;
    model.inputContent = after;

    const composedText = event.data ?? "";
    this._cursorModel.offset = this._compositionStartOffset + composedText.length;

    this._updateCursorPosition();
    this._debouncedRender();
    this._compositionJustEnded = true;
    setTimeout(() => {
      this._compositionJustEnded = false;
    }, 100);

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
    let renderedOffset = this._mapper.renderedOffset(sourceOffset);
    if (renderedOffset === null) {
      if (sourceOffset > 0) {
        renderedOffset = this._mapper.renderedOffset(sourceOffset - 1);
      }
      if (renderedOffset === null) return;

      const span = this._mapper.getSpanByOffset(renderedOffset);
      if (span && span.nextSibling && span.nextSibling instanceof HTMLSpanElement) {
        span.nextSibling.innerText = char;
      }
      return;
    }

    const span = this._mapper.getSpanByOffset(renderedOffset);
    if (span) {
      span.innerText = char;
    }
  }

  private _debouncedRender(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }
    this._wasFocused = document.activeElement === this._textarea;
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

    if (renderedOffset === null && offset === 0) {
      const firstCol = this._mapper.getFirstColumnRect();
      if (firstCol) {
        this._cursorEl.top = firstCol.top;
        this._cursorEl.left = firstCol.left;
        this._cursorEl.height = firstCol.fontSize;
        const hasVisibleSelection = this._cursorModel.selection !== null &&
          this._cursorModel.selection.anchor.textOffset !== this._cursorModel.selection.focus.textOffset;
        this._cursorEl.visible = document.activeElement === this._textarea && !hasVisibleSelection;
        this._textarea.style.top = `${firstCol.top}px`;
        this._textarea.style.left = `${firstCol.left}px`;
        return;
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
    const hasVisibleSelection = this._cursorModel.selection !== null &&
      this._cursorModel.selection.anchor.textOffset !== this._cursorModel.selection.focus.textOffset;
    this._cursorEl.visible = document.activeElement === this._textarea && !hasVisibleSelection;

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

    this._cursorEl.visible = false;
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
