import { LayoutCursorElement, LayoutSelectionElement } from "@/components";
import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import { TextBlockStyle, ParagraphStyle, TextStyle } from "@/types/style";
import { CursorPosition } from "@/types/edit/cursor.type";
import { SelectionRange } from "@/types/edit/selection.type";
import type { TextLineData } from "@/types/layout/text/text-line.type";
import { TextEditCoordinateMapper } from "./text-edit-coordinate-mapper";
import { EditManager } from "./edit-manager";
import { DEFAULT_LETTER_SPACING, DEFAULT_WIDTH_RATIO, DEFAULT_TEXT_ALIGN, DEFAULT_VERTICAL_ALIGN } from "@/constants";

/**
 * 커서 위치에서 유효한 스타일 정보.
 * 단락의 TextStyle/ParagraphStyle과 상속 스타일(InheritStyle)을 병합하고,
 * 커서가 위치한 텍스트 블록의 TextBlockStyle로 오버라이드한 결과.
 */
export type CurrentStyle = {
  /** 커서 위치에서 유효한 글자 스타일 */
  textStyle: TextStyle;
  /** 커서 위치에서 유효한 문단 스타일 */
  paragraphStyle: ParagraphStyle;
};

/**
 * 단락 편집 상태를 관리하는 컨트롤러.
 *
 * `LayoutParagraphElement`가 `editable = true`일 때 생성되며,
 * 단락의 shadow root에 숨겨진 `<textarea>`, 커서 요소, 선택 영역 요소를 추가한다.
 * 렌더링된 문자 위치와 소스 텍스트 오프셋 간의 매핑은 `TextEditCoordinateMapper`가 담당한다.
 */
export class TextEditController {
  private _paragraph: LayoutParagraphElement;
  private _mapper: TextEditCoordinateMapper;

  private _textarea: HTMLTextAreaElement;
  private _cursorEl: LayoutCursorElement;
  private _selectionEl: LayoutSelectionElement;

  private _cursorModel: CursorModel = { offset: 0, selection: null };

  private _crossRightState: 'none' | 'sticking' | 'crossed' = 'none';
  private _crossLeftState: 'none' | 'sticking' | 'crossed' = 'none';

  private _handleClick: (event: MouseEvent) => void;
  private _handleFocus: () => void;
  private _handleBlur: () => void;
  private _handleKeydown: (event: KeyboardEvent) => void;
  private _handleKeyup: (event: KeyboardEvent) => void;

  private _handleInput: (event: InputEvent) => void;
  private _handleCompositionStart: () => void;
  private _handleCompositionUpdate: (event: CompositionEvent) => void;
  private _handleCompositionEnd: (event: CompositionEvent) => void;
  private _handleCompositionCancel: () => void;
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

  private _compositionSpan: HTMLSpanElement | null = null;
  private _compositionSession: number = 0;
  private _compositionBeforeContent: string = "";
  private _debounceTimer: number | null = null;
  private _wasFocused: boolean = false;
  private _optimisticSpan: HTMLSpanElement | null = null;
  private _lastStyleJson: string | null = null;

  private _selectionAnchor: number | null = null;
  private _isMouseDown: boolean = false;
  private _wasDragged: boolean = false;
  private _isFocused: boolean = false;
  private _mousemoveRafId: number | null = null;
  private _lastMouseX: number = 0;
  private _lastMouseY: number = 0;

  constructor(paragraph: LayoutParagraphElement) {
    this._paragraph = paragraph;
    this._mapper = new TextEditCoordinateMapper(paragraph);

    this._textarea = this._createTextarea();
    this._cursorEl = document.createElement("x-layout-cursor") as LayoutCursorElement;
    this._selectionEl = document.createElement("x-layout-selection") as LayoutSelectionElement;

    this._handleClick = (event: MouseEvent) => this._onClick(event);
    this._handleFocus = () => this._onFocus();
    this._handleBlur = () => this._onBlur();
    this._handleKeydown = (event: KeyboardEvent) => this._onKeydown(event);
    this._handleKeyup = (event: KeyboardEvent) => this._onKeyup(event);

    this._handleInput = (event: InputEvent) => this._onInput(event);
    this._handleCompositionStart = () => this._onCompositionStart();
    this._handleCompositionUpdate = (event: CompositionEvent) => this._onCompositionUpdate(event);
    this._handleCompositionEnd = (event: CompositionEvent) => this._onCompositionEnd(event);
    this._handleCompositionCancel = () => this._onCompositionCancel();
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

    const printStyle = document.createElement('style');
    printStyle.textContent = '@media print { textarea, x-layout-cursor, x-layout-selection { visibility: hidden !important; } }';
    shadowRoot.appendChild(printStyle);

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
    this._textarea.addEventListener("compositioncancel", this._handleCompositionCancel);
    this._textarea.addEventListener("keydown", this._handleKeydown);
    this._textarea.addEventListener("keyup", this._handleKeyup);
    this._textarea.addEventListener("paste", this._handlePaste as EventListener);

    this._handleVisibilityChange = () => {
      if (document.hidden) {
        const wasComposing = this._isComposing;
        this._resetCompositionState();

        if (wasComposing) {
          const model = this._paragraph.model;
          if (model && typeof model.textContent === "string") {
            const after = this._textarea.value;
            model.textContent = after;
            const composedLength = after.length - this._compositionBeforeContent.length;
            this._cursorModel.offset = this._compositionStartOffset + composedLength;
            this._updateCursorPosition();
            if (this._debounceTimer !== null) {
              cancelAnimationFrame(this._debounceTimer);
              this._debounceTimer = null;
              this._wasFocused = false;
            }
            this._paragraph.render();
          }
        }
      }
    };
    document.addEventListener("visibilitychange", this._handleVisibilityChange);

    // Sync textarea value with model content so _onInput can compute correct diffs
    const model = paragraph.model;
    if (model && typeof model.textContent === "string") {
      this._textarea.value = model.textContent;
    }

    this._updateCursorPosition();

    EditManager.getInstance()._register(this);
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
   * 현재 커서 위치에서 유효한 TextStyle과 ParagraphStyle을 반환한다.
   *
   * 단락의 기본 `textStyle`/`paragraphStyle`과 부모에서 상속된
   * `inheritStyle`을 병합한 후, 커서가 위치한 텍스트 블록의
   * `textBlockStyle`로 필드를 오버라이드한다.
   *
   * 커서가 텍스트 끝이나 빈 단락에 있어도 단락 수준의 스타일을 반환한다.
   * 편집 모드가 활성화되지 않았거나 모델이 없으면 빈 객체를 반환한다.
   */
  get currentStyle(): CurrentStyle {
    const model = this._paragraph.model;
    if (!model) return { textStyle: {}, paragraphStyle: {} };

    // 1. 단락 수준 스타일 + 상속 스타일 병합
    const inheritStyle = model.inheritStyle ?? {};
    const baseTextStyle: TextStyle = {
      color: model.textStyle?.color ?? inheritStyle.color,
      fontFamily: model.textStyle?.fontFamily ?? inheritStyle.fontFamily,
      fontWeight: model.textStyle?.fontWeight ?? inheritStyle.fontWeight,
      fontStyle: model.textStyle?.fontStyle ?? inheritStyle.fontStyle,
      fontSize: model.textStyle?.fontSize ?? inheritStyle.fontSize,
      letterSpacing: model.textStyle?.letterSpacing ?? inheritStyle.letterSpacing ?? DEFAULT_LETTER_SPACING,
      widthRatio: model.textStyle?.widthRatio ?? inheritStyle.widthRatio ?? DEFAULT_WIDTH_RATIO,
    };
    const baseParagraphStyle: ParagraphStyle = {
      lineGap: model.paragraphStyle?.lineGap ?? inheritStyle.lineGap,
      verticalAlign: model.paragraphStyle?.verticalAlign ?? inheritStyle.verticalAlign ?? DEFAULT_VERTICAL_ALIGN,
      textAlign: model.paragraphStyle?.textAlign ?? inheritStyle.textAlign ?? DEFAULT_TEXT_ALIGN,
    };

    // 2. 커서가 위치한 텍스트 블록의 textBlockStyle 찾기
    const blockStyle = this._findTextBlockStyleAtOffset(this._cursorModel.offset);
    if (!blockStyle) return { textStyle: baseTextStyle, paragraphStyle: baseParagraphStyle };

    // 3. textBlockStyle로 필드 오버라이드
    const effectiveTextStyle: TextStyle = {
      ...baseTextStyle,
      ...(blockStyle.fontFamily !== undefined && { fontFamily: blockStyle.fontFamily }),
      ...(blockStyle.fontSize !== undefined && { fontSize: blockStyle.fontSize }),
      ...(blockStyle.fontWeight !== undefined && { fontWeight: blockStyle.fontWeight }),
      ...(blockStyle.color !== undefined && { color: blockStyle.color }),
    };
    const effectiveParagraphStyle: ParagraphStyle = {
      ...baseParagraphStyle,
      ...(blockStyle.textAlign !== undefined && { textAlign: blockStyle.textAlign }),
    };

    return { textStyle: effectiveTextStyle, paragraphStyle: effectiveParagraphStyle };
  }

  /**
   * 편집기를 제거하고 모든 이벤트 리스너를 해제한다.
   */
  destroy(): void {
    EditManager.getInstance()._unregister(this);

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
    this._textarea.removeEventListener("keyup", this._handleKeyup);
    this._textarea.removeEventListener("input", this._handleInput as EventListener);
    this._textarea.removeEventListener("compositionstart", this._handleCompositionStart);
    this._textarea.removeEventListener("compositionupdate", this._handleCompositionUpdate as EventListener);
    this._textarea.removeEventListener("compositionend", this._handleCompositionEnd as EventListener);
    this._textarea.removeEventListener("compositioncancel", this._handleCompositionCancel);
    this._textarea.removeEventListener("paste", this._handlePaste as EventListener);

    if (this._debounceTimer !== null) {
      cancelAnimationFrame(this._debounceTimer);
      this._debounceTimer = null;
    }

    if (this._mousemoveRafId !== null) {
      cancelAnimationFrame(this._mousemoveRafId);
      this._mousemoveRafId = null;
    }

    document.removeEventListener("visibilitychange", this._handleVisibilityChange);

    this._isFocused = false;
    this._resetCompositionState();
    if (this._optimisticSpan && this._optimisticSpan.parentNode) {
      this._optimisticSpan.remove();
    }
    this._optimisticSpan = null;

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
   *
   * @param fullRebuild - DOM이 새로 생성되었으면 true, 기존 컬럼을
   *   재사용한 경우 false. 매퍼는 항상 전체 재구축을 수행한다.
   */
  postRender(_fullRebuild: boolean = true): void {
    this._mapper.rebuild();
    this._optimisticSpan = null;
    const model = this._paragraph.model;
    if (model && typeof model.textContent === "string") {
      if (!this._isComposing) {
        this._textarea.value = model.textContent;
        this._syncTextareaSelection();
      }
    }
    this._updateCursorPosition();
    this._updateSelection();

    if (this._isComposing && this._compositionSpan) {
      this._compositionSpan.remove();
      let reattached = false;
      const renderedOffset = this._mapper.renderedOffset(this._compositionStartOffset);
      if (renderedOffset !== null) {
        const span = this._mapper.getSpanByOffset(renderedOffset);
        if (span) {
          span.before(this._compositionSpan);
          reattached = true;
        }
      } else if (this._compositionStartOffset > 0) {
        const prevRendered = this._mapper.renderedOffset(this._compositionStartOffset - 1);
        if (prevRendered !== null) {
          const prevSpan = this._mapper.getSpanByOffset(prevRendered);
          if (prevSpan) {
            prevSpan.after(this._compositionSpan);
            reattached = true;
          }
        }
      }

      if (!reattached && this._compositionStartOffset === 0) {
        const firstColumn = this._paragraph.querySelector("x-layout-column");
        if (firstColumn && firstColumn.shadowRoot) {
          const firstContainer = firstColumn.shadowRoot.firstElementChild;
          if (firstContainer instanceof HTMLElement) {
            firstContainer.appendChild(this._compositionSpan);
          }
        }
      }

      if (this._compositionSpan.parentNode) {
        this._positionCursorFromCompositionSpan();
      }
    }

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

  _blurInternal(): void {
    this._textarea.removeEventListener("blur", this._handleBlur);
    this._textarea.blur();
    this._textarea.addEventListener("blur", this._handleBlur);

    this._isFocused = false;
    this._wasFocused = false;
    this._cursorEl.visible = false;

    EditManager.getInstance()._releaseFocus(this);
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
    textarea.setAttribute("tabindex", "-1");
    textarea.setAttribute("role", "textbox");
    textarea.setAttribute("aria-label", "텍스트 편집 영역");
    return textarea;
  }

  private _onClick(event: MouseEvent): void {
    this._crossRightState = 'none';
    this._crossLeftState = 'none';
    if (this._wasDragged) {
      this._wasDragged = false;
      return;
    }

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
        const content = this._paragraph.model?.textContent;
        if (content !== undefined) {
          // 빈 공간 클릭 시 가장 가까운 텍스트 위치 찾기
          const nearest = this._mapper.getNearestOffsetFromPoint(event.clientX, event.clientY);
          const targetOffset = nearest ? nearest.textOffset : 0;
          if (event.shiftKey) {
            this._extendSelection(targetOffset);
          } else {
            this._cursorModel.offset = targetOffset;
            this._cursorModel.selection = null;
          }
          this._syncTextareaSelection();
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
      this._textarea.setSelectionRange(sourceOffset, sourceOffset);
      this._updateCursorPosition();
      this._updateSelection();
      this.focus();
      return;
    }

    this._extendSelection(sourceOffset);
    this._syncTextareaSelection();
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

    if (targetSpan.innerText === ' ') return null;

    const renderedOffset = parseInt(targetSpan.dataset.offset ?? "", 10);
    if (Number.isNaN(renderedOffset)) return null;

    const sourceOffset = this._mapper.sourceOffset(renderedOffset);
    if (sourceOffset === null) return null;

    const spanRect = targetSpan.getBoundingClientRect();
    const midpoint = spanRect.left + spanRect.width / 2;
    if (event.clientX >= midpoint) {
      const content = this._paragraph.model?.textContent as string | undefined;
      if (content !== undefined && sourceOffset < content.length) {
        return sourceOffset + 1;
      }
    }

    return sourceOffset;
  }

  private _onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;

    this._wasDragged = false;

    const sourceOffset = this._getSourceOffsetFromEvent(event);
    event.preventDefault();
    if (sourceOffset === null) {
      const rect = this._paragraph.getBoundingClientRect();
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        const content = this._paragraph.model?.textContent;
        if (content !== undefined) {
          const nearest = this._mapper.getNearestOffsetFromPoint(event.clientX, event.clientY);
          const targetOffset = nearest ? nearest.textOffset : 0;
          if (event.shiftKey) {
            this._extendSelection(targetOffset);
          } else {
            this._cursorModel.offset = targetOffset;
            this._cursorModel.selection = null;
          }
          this._isMouseDown = true;
          this._lastMouseX = event.clientX;
          this._lastMouseY = event.clientY;
          this._selectionAnchor = targetOffset;
          this._syncTextareaSelection();
          this.focus();
          this._updateCursorPosition();
          this._updateSelection();
          this._emitStyleChange();
          EditManager.getInstance()._notifyCursorMove(this);
          document.addEventListener("mousemove", this._handleMouseMove);
        }
      }
      return;
    }

    this._isMouseDown = true;
    this._lastMouseX = event.clientX;
    this._lastMouseY = event.clientY;
    if (event.shiftKey) {
      this._extendSelection(sourceOffset);
      this._syncTextareaSelection();
      this.focus();
      this._updateCursorPosition();
      this._updateSelection();
      EditManager.getInstance()._notifyCursorMove(this);
      document.addEventListener("mousemove", this._handleMouseMove);
      return;
    }
    this._selectionAnchor = sourceOffset;
    this._cursorModel.offset = sourceOffset;
    this._cursorModel.selection = null;
    this._textarea.setSelectionRange(sourceOffset, sourceOffset);
    this.focus();
    this._updateCursorPosition();
    this._updateSelection();
    this._emitStyleChange();
    EditManager.getInstance()._notifyCursorMove(this);
    document.addEventListener("mousemove", this._handleMouseMove);
  }

  private _onMouseMove(event: MouseEvent): void {
    if (!this._isMouseDown) return;
    this._lastMouseX = event.clientX;
    this._lastMouseY = event.clientY;
    if (this._mousemoveRafId !== null) return;

    if (!this._wasDragged) {
      this._wasDragged = true;
      EditManager.getInstance()._notifySelectionStart(this);
    }

    this._mousemoveRafId = requestAnimationFrame(() => {
      this._mousemoveRafId = null;
      if (!this._isMouseDown) return;

      const result = this._mapper.getNearestOffsetFromPoint(this._lastMouseX, this._lastMouseY);
      if (result === null) return;

      const focusOffset = result.textOffset;
      const anchor = this._selectionAnchor ?? this._cursorModel.offset;
      this._cursorModel.selection = SelectionRange.fromOffsets(anchor, focusOffset);
      this._cursorModel.offset = focusOffset;
      this._syncTextareaSelection();
      this._updateCursorPosition();
      this._updateSelection();
      // 의도적으로 이벤트를 발생시키지 않는다.
      // 드래그 중 매 프레임 이벤트를 발생시키면 성능 부하가 크다.
      // selectionStart(드래그 시작)와 selectionEnd(마우스 업) 사이의
      // 변경은 통지하지 않고, selectionEnd에서 최종 선택 영역을 전달한다.
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
    if (this._cursorModel.selection) {
      EditManager.getInstance()._notifySelectionEnd(this);
      EditManager.getInstance()._notifyCursorMove(this);
    }
  }

  private _onDoubleClick(event: MouseEvent): void {
    event.preventDefault();

    const sourceOffset = this._getSourceOffsetFromEvent(event);
    if (sourceOffset === null) return;

    const model = this._paragraph.model;
    if (!model) return;
    if (typeof model.textContent !== "string") return;

    const content = model.textContent;
    const { start, end } = this._findWordBoundaries(content, sourceOffset);
    this._cursorModel.selection = SelectionRange.fromOffsets(start, end);
    this._cursorModel.offset = end;
    this._textarea.setSelectionRange(end, end);
    this.focus();
    this._updateCursorPosition();
    this._updateSelection();
    EditManager.getInstance()._notifySelectionStart(this);
    EditManager.getInstance()._notifySelectionEnd(this);
    EditManager.getInstance()._notifyCursorMove(this);
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
    EditManager.getInstance()._requestFocus(this);
    this._isFocused = true;
    if (this._cursorModel.selection) {
      this._cursorEl.visible = false;
    } else {
      this._cursorEl.visible = true;
    }
  }

  private _onBlur(): void {
    const wasComposing = this._isComposing;
    this._isFocused = false;
    this._wasFocused = false;
    this._resetCompositionState();

    if (wasComposing) {
      const model = this._paragraph.model;
      if (model && typeof model.textContent === "string") {
        const after = this._textarea.value;
        model.textContent = after;
        const composedLength = after.length - this._compositionBeforeContent.length;
        this._cursorModel.offset = this._compositionStartOffset + composedLength;
        this._updateCursorPosition();
        if (this._debounceTimer !== null) {
          cancelAnimationFrame(this._debounceTimer);
          this._debounceTimer = null;
        }
        this._paragraph.render();
        EditManager.getInstance()._notifyTextChange(this);
      }
    }

    this._cursorEl.visible = false;
  }

  private _onKeydown(event: KeyboardEvent): void {
    if (this._isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        this._isComposing = false;
        this._removeCompositionSpan();
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
        event.preventDefault();
        this._textarea.setSelectionRange(this._compositionStartOffset, this._compositionStartOffset);
      }
      return;
    }
    const model = this._paragraph.model;
    if (!model) return;

    if (typeof model.textContent !== "string") return;

    const content = model.textContent;
    const offset = this._cursorModel.offset;
    const hasShortcut = event.ctrlKey || event.metaKey;

    if (hasShortcut && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this._selectAll();
      EditManager.getInstance()._notifyCursorMove(this);
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
    const isCursorKey = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key);

    switch (event.key) {
      case "ArrowLeft": {
      event.preventDefault();
      let targetLeft: number;
      if (this._crossRightState === 'crossed') {
        this._crossRightState = 'none';
        this._crossLeftState = 'none';
        targetLeft = offset;
      } else if (hasShortcut) {
        this._crossRightState = 'none';
        targetLeft = this._findWordStart(content, offset);
        this._crossLeftState = 'none';
      } else if (isShift) {
        this._crossRightState = 'none';
        targetLeft = offset > 0 ? offset - 1 : offset;
        this._crossLeftState = 'none';
      } else {
        this._crossRightState = 'none';
        const lineBounds = this._mapper.findVisualLineBounds(offset);
        const atLineStart = lineBounds && offset === lineBounds.start;
        const atSecondChar = lineBounds && offset === lineBounds.start + 1;
        if (this._crossLeftState === 'sticking' && atLineStart) {
          targetLeft = offset;
          this._crossLeftState = 'crossed';
        } else if (this._crossLeftState === 'crossed') {
          targetLeft = offset > 0 ? offset - 1 : offset;
          this._crossLeftState = 'none';
        } else if (atSecondChar) {
          targetLeft = offset - 1;
          this._crossLeftState = 'sticking';
        } else {
          targetLeft = offset > 0 ? offset - 1 : offset;
          this._crossLeftState = 'none';
        }
      }
      if (isShift) {
        this._extendSelection(targetLeft);
      } else {
        this._cursorModel.offset = targetLeft;
        this._cursorModel.selection = null;
      }
      this._syncTextareaSelection();
      this._updateCursorPosition();
      this._updateSelection();
      if (!isShift) {
        this._emitStyleChange();
      }
      if (!event.repeat && isCursorKey) {
        EditManager.getInstance()._notifyCursorMove(this);
      }
      break;
    }
    case "ArrowRight": {
      event.preventDefault();
      let targetRight: number;
      if (this._crossLeftState === 'crossed') {
        this._crossLeftState = 'none';
        this._crossRightState = 'none';
        targetRight = offset;
      } else if (hasShortcut) {
        this._crossLeftState = 'none';
        targetRight = this._findWordEnd(content, offset);
        this._crossRightState = 'none';
      } else if (isShift) {
        this._crossLeftState = 'none';
        targetRight = offset < content.length ? offset + 1 : offset;
        this._crossRightState = 'none';
      } else {
        this._crossLeftState = 'none';
        const lineBounds = offset > 0 ? this._mapper.findVisualLineBounds(offset - 1) : null;
        const atLineEnd = lineBounds && offset === lineBounds.end;
        const atLastChar = lineBounds && offset === lineBounds.end - 1;
        if (this._crossRightState === 'sticking' && atLineEnd) {
          targetRight = offset;
          this._crossRightState = 'crossed';
        } else if (this._crossRightState === 'crossed') {
          targetRight = offset < content.length ? offset + 1 : offset;
          this._crossRightState = 'none';
        } else if (atLastChar) {
          targetRight = offset + 1;
          this._crossRightState = 'sticking';
        } else {
          targetRight = offset < content.length ? offset + 1 : offset;
          this._crossRightState = 'none';
        }
      }
      if (isShift) {
        this._extendSelection(targetRight);
      } else {
        this._cursorModel.offset = targetRight;
        this._cursorModel.selection = null;
      }
      this._syncTextareaSelection();
      this._updateCursorPosition();
      this._updateSelection();
      if (!isShift) {
        this._emitStyleChange();
      }
      if (!event.repeat && isCursorKey) {
        EditManager.getInstance()._notifyCursorMove(this);
      }
      break;
    }
    case "ArrowUp":
    case "ArrowDown": {
      event.preventDefault();
      const newOffset = this._computeVerticalOffset(event.key === "ArrowUp" ? -1 : 1);
      this._crossRightState = 'none';
      this._crossLeftState = 'none';
      if (isShift) {
        this._extendSelection(newOffset ?? offset);
      } else {
        if (newOffset !== null) {
          this._cursorModel.offset = newOffset;
        }
        this._cursorModel.selection = null;
      }
      this._syncTextareaSelection();
      this._updateCursorPosition();
      this._updateSelection();
      if (!isShift) {
        this._emitStyleChange();
      }
      if (!event.repeat && isCursorKey) {
        EditManager.getInstance()._notifyCursorMove(this);
      }
      break;
    }
    case "Home": {
      event.preventDefault();
      this._crossRightState = 'none';
      if (hasShortcut) {
        const lineStart = this._findLineStart(content, offset);
        if (isShift) { this._extendSelection(lineStart); } else { this._cursorModel.offset = lineStart; this._cursorModel.selection = null; }
        this._crossLeftState = 'none';
      } else if (isShift) {
        const lineStart = this._getLogicalLineStart(offset);
        this._extendSelection(lineStart);
        this._crossLeftState = 'none';
      } else {
        const lineStart = this._getLogicalLineStart(offset);
        const atLineStart = offset === lineStart;
        if (atLineStart && offset === 0) {
          break;
        }
        if (this._crossLeftState === 'sticking') {
          this._cursorModel.offset = offset;
          this._cursorModel.selection = null;
          this._crossLeftState = 'crossed';
        } else if (this._crossLeftState === 'crossed') {
          const prevStart = this._getLogicalLineStart(Math.max(0, offset - 1));
          this._cursorModel.offset = prevStart;
          this._cursorModel.selection = null;
          this._crossLeftState = 'none';
        } else if (atLineStart) {
          this._cursorModel.offset = offset;
          this._cursorModel.selection = null;
          this._crossLeftState = 'sticking';
        } else {
          this._cursorModel.offset = lineStart;
          this._cursorModel.selection = null;
          this._crossLeftState = 'sticking';
        }
      }
      this._syncTextareaSelection();
      this._updateCursorPosition();
      this._updateSelection();
      if (!isShift) { this._emitStyleChange(); }
      if (!event.repeat && isCursorKey) { EditManager.getInstance()._notifyCursorMove(this); }
      break;
    }
    case "End": {
      event.preventDefault();
      this._crossLeftState = 'none';
      if (hasShortcut) {
        const lineEnd = this._findLineEnd(content, offset);
        if (isShift) { this._extendSelection(lineEnd); } else { this._cursorModel.offset = lineEnd; this._cursorModel.selection = null; }
        this._crossRightState = 'none';
      } else if (isShift) {
        const lineEnd = this._getEndKeyOffset(offset);
        this._extendSelection(lineEnd);
        this._crossRightState = 'none';
      } else {
        const lineEnd = this._getEndKeyOffset(offset);
        const atLineEnd = offset === lineEnd;
        if (this._crossRightState === 'sticking') {
          this._cursorModel.offset = offset;
          this._cursorModel.selection = null;
          this._crossRightState = 'crossed';
        } else if (this._crossRightState === 'crossed') {
          const nextEnd = this._getEndKeyOffset(Math.min(content.length, offset + 1));
          this._cursorModel.offset = nextEnd;
          this._cursorModel.selection = null;
          this._crossRightState = 'none';
        } else if (atLineEnd) {
          this._cursorModel.offset = offset;
          this._cursorModel.selection = null;
          this._crossRightState = 'sticking';
        } else {
          this._cursorModel.offset = lineEnd;
          this._cursorModel.selection = null;
          this._crossRightState = 'sticking';
        }
      }
      this._syncTextareaSelection();
      this._updateCursorPosition();
      this._updateSelection();
      if (!isShift) { this._emitStyleChange(); }
      if (!event.repeat && isCursorKey) { EditManager.getInstance()._notifyCursorMove(this); }
      break;
    }
      case "Backspace": {
      event.preventDefault();
      this._crossRightState = 'none';
      this._crossLeftState = 'none';
      const activeSelection = this._cursorModel.selection;
      if (activeSelection) {
        this._replaceSelection("");
      } else if (offset > 0) {
        const newContent = content.slice(0, offset - 1) + content.slice(offset);
        model.textContent = newContent;
        this._textarea.value = newContent;
        this._cursorModel.offset = offset - 1;
        this._textarea.setSelectionRange(offset - 1, offset - 1);
        this._debouncedRender();
        EditManager.getInstance()._notifyTextChange(this);
        EditManager.getInstance()._notifyCursorMove(this);
      }
      break;
    }
    case "Delete": {
      event.preventDefault();
      this._crossRightState = 'none';
      this._crossLeftState = 'none';
      const activeSelection = this._cursorModel.selection;
      if (activeSelection) {
        this._replaceSelection("");
      } else if (offset < content.length) {
        const newContent = content.slice(0, offset) + content.slice(offset + 1);
        model.textContent = newContent;
        this._textarea.value = newContent;
        this._textarea.setSelectionRange(offset, offset);
        this._debouncedRender();
        EditManager.getInstance()._notifyTextChange(this);
        EditManager.getInstance()._notifyCursorMove(this);
      }
      break;
    }
  case "Enter": {
        event.preventDefault();
        this._crossRightState = 'none';
        this._crossLeftState = 'none';
        const activeSelection = this._cursorModel.selection;
        const { start, end } = activeSelection?.normalized() ?? { start: null, end: null };
        const replaceStart = start?.textOffset ?? offset;
        const replaceEnd = end?.textOffset ?? offset;

    const newContent = content.slice(0, replaceStart) + "\n" + content.slice(replaceEnd);
    model.textContent = newContent;
    this._textarea.value = newContent;
    this._cursorModel.offset = replaceStart + 1;
    this._textarea.setSelectionRange(replaceStart + 1, replaceStart + 1);
    this._cursorModel.selection = null;
    this._debouncedRender();
    EditManager.getInstance()._notifyTextChange(this);
    EditManager.getInstance()._notifyCursorMove(this);
    break;
  }
      default:
        // Other keys are handled by input/composition handlers
        break;
    }
  }

  private _onKeyup(event: KeyboardEvent): void {
    if (this._isComposing) return;

    const cursorKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (cursorKeys.includes(event.key)) {
      EditManager.getInstance()._notifyCursorMove(this);
    }
  }

  private _extendSelection(newOffset: number): void {
    const current = this._cursorModel;
    const anchor = current.selection?.anchor.textOffset ?? current.offset;
    current.selection = SelectionRange.fromOffsets(anchor, newOffset);
    current.offset = newOffset;
  }

  private _syncTextareaSelection(): void {
    const sel = this._cursorModel.selection;
    if (sel) {
      const { start, end } = sel.normalized();
      this._textarea.setSelectionRange(start.textOffset, end.textOffset);
    } else {
      this._textarea.setSelectionRange(this._cursorModel.offset, this._cursorModel.offset);
    }
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

    if (typeof model.textContent !== "string") return;

    const content = model.textContent;
    const { start, end } = selection.normalized();
    const newContent = content.slice(0, start.textOffset) + content.slice(end.textOffset);

    model.textContent = newContent;
    this._textarea.value = newContent;
    this._cursorModel.offset = start.textOffset;
    this._cursorModel.selection = null;
    this._textarea.setSelectionRange(start.textOffset, start.textOffset);
    this._debouncedRender();
  }

  private _onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    if (this._isComposing) return;

    const model = this._paragraph.model;
    if (!model) return;

    const pastedText = event.clipboardData?.getData("text/plain") ?? "";
    if (pastedText.length === 0) return;

    if (typeof model.textContent !== "string") return;

    const content = model.textContent;
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

    model.textContent = newContent;
    this._textarea.value = newContent;
    this._cursorModel.offset = newOffset;
    this._cursorModel.selection = null;
    this._textarea.setSelectionRange(newOffset, newOffset);
    this._debouncedRender();
    EditManager.getInstance()._notifyTextChange(this);
    EditManager.getInstance()._notifyCursorMove(this);
  }

  private _selectAll(): void {
    const model = this._paragraph.model;
    if (!model) return;

    if (typeof model.textContent !== "string") return;

    const content = model.textContent;
    this._cursorModel.selection = SelectionRange.fromOffsets(0, content.length);
    this._cursorModel.offset = content.length;
    this._textarea.setSelectionRange(0, content.length);
    this._updateCursorPosition();
    this._updateSelection();
  }

  _clearSelection(): void {
    this._cursorModel.selection = null;
    this._selectionEl.setRanges([]);
    this._textarea.setSelectionRange(this._cursorModel.offset, this._cursorModel.offset);
    this._updateCursorPosition();
  }

  private _computeVerticalOffset(direction: -1 | 1): number | null {
    const model = this._paragraph.model;
    if (!model) return null;
    if (typeof model.textContent !== "string") return null;

    const offset = this._cursorModel.offset;

    const visualBounds = this._mapper.findVisualLineBounds(offset);
    const visualBoundsPrev = offset > 0 ? this._mapper.findVisualLineBounds(offset - 1) : null;
    const atVisualLineEnd = visualBoundsPrev !== null && offset === visualBoundsPrev.end;
    const atVisualLineStart = visualBounds !== null && offset === visualBounds.start;

    // \n 위치나 trailing space처럼 renderedOffset이 null인 offset은 커서가 직접
    // 위치할 수 없으므로, 마지막 visible 문자(offset === visualBounds.end - 1)를
    // 라인 끝으로 취급한다.
    const isAtLineStart = atVisualLineStart;
    const isAtLineEnd = atVisualLineEnd
      || (visualBounds !== null
        && offset === visualBounds.end - 1
        && this._mapper.renderedOffset(offset + 1) === null);

    let currentLineInfo = this._mapper.getLineInfoBySourceOffset(offset);
    if (currentLineInfo === null) return null;

    const flatIndex = this._toFlatLineIndex(currentLineInfo.columnIndex, currentLineInfo.lineIndex);
    const targetFlatIndex = flatIndex + direction;
    if (targetFlatIndex < 0 || targetFlatIndex >= this._mapper.totalLineCount) {
      return null;
    }

    const targetInfo = this._fromFlatLineIndex(targetFlatIndex);
    if (targetInfo === null) return null;

    const targetLineStart = this._mapper.getLineStartSourceOffset(targetInfo.columnIndex, targetInfo.lineIndex);
    if (targetLineStart === null) return null;
    const targetLineEnd = this._getLineEndSourceOffset(targetInfo.columnIndex, targetInfo.lineIndex);
    const targetVisualBounds = this._mapper.findVisualLineBounds(targetLineStart);
    const targetVisualEnd = targetVisualBounds && targetVisualBounds.start === targetLineStart
      ? targetVisualBounds.end - 1
      : targetLineEnd;

    if (isAtLineStart) {
      return targetLineStart;
    }
    if (isAtLineEnd) {
      const currentLineStart = this._mapper.getLineStartSourceOffset(currentLineInfo.columnIndex, currentLineInfo.lineIndex) ?? 0;
      const offsetInLine = offset - currentLineStart;
      return Math.min(targetLineStart + offsetInLine, targetVisualEnd);
    }

    const currentLineStart = this._mapper.getLineStartSourceOffset(currentLineInfo.columnIndex, currentLineInfo.lineIndex) ?? 0;
    const offsetInLine = offset - currentLineStart;
    return Math.min(targetLineStart + offsetInLine, targetVisualEnd);
  }

  /**
   * 컬럼/라인 인덱스를 전체 라인 기준 평탄화 인덱스로 변환한다.
   */
  private _toFlatLineIndex(columnIndex: number, lineIndex: number): number {
    let flat = 0;
    const columnContents = this._paragraph.model?.columnContents ?? [];
    for (let c = 0; c < columnIndex && c < columnContents.length; c++) {
      flat += columnContents[c].length;
    }
    return flat + lineIndex;
  }

  /**
   * 전체 라인 기준 평탄화 인덱스를 컬럼/라인 인덱스로 변환한다.
   */
  private _fromFlatLineIndex(flatIndex: number): { columnIndex: number; lineIndex: number } | null {
    const columnContents = this._paragraph.model?.columnContents ?? [];
    let remaining = flatIndex;
    for (let c = 0; c < columnContents.length; c++) {
      if (remaining < columnContents[c].length) {
        return { columnIndex: c, lineIndex: remaining };
      }
      remaining -= columnContents[c].length;
    }
    return null;
  }

  /**
   * 주어 라인의 끝 source offset(다음 라인 시작 또는 텍스트 끝)을 반환한다.
   */
  /**
   * 주어 라인에서 커서가 위치할 수 있는 최대 source offset을 반환한다.
   * 빈 줄은 라인 시작 자체가 끝이며, 일반 라인은 다음 라인 시작 - 1(\\n 위치),
   * 마지막 라인은 텍스트 끝(content.length)이다.
   */
  private _getLineEndSourceOffset(columnIndex: number, lineIndex: number): number {
    const model = this._paragraph.model;
    if (!model) return 0;
    const content = model.textContent;
    if (typeof content !== "string") return 0;

    const lineStart = this._mapper.getLineStartSourceOffset(columnIndex, lineIndex) ?? 0;
    const columnContents = model.columnContents;
    const nextStart = this._findNextLineStart(columnContents, columnIndex, lineIndex);

    if (nextStart === null) {
      // 마지막 라인: 텍스트 끝
      return content.length;
    }
    // 일반/빈 라인: 다음 라인 시작 - 1 (\n 위치 = 이 라인의 마지막 커서 위치)
    // 빈 줄의 경우 nextStart - 1 = lineStart (라인 시작 = 끝)
    return Math.max(lineStart, nextStart - 1);
  }

  /**
   * 다음 라인의 시작 source offset을 반환한다.
   */
  private _findNextLineStart(columnContents: TextLineData[][], columnIndex: number, lineIndex: number): number | null {
    // 같은 컬럼 내 다음 라인
    if (lineIndex + 1 < columnContents[columnIndex]?.length) {
      return this._mapper.getLineStartSourceOffset(columnIndex, lineIndex + 1);
    }
    // 다음 컬럼의 첫 라인
    if (columnIndex + 1 < columnContents.length && columnContents[columnIndex + 1].length > 0) {
      return this._mapper.getLineStartSourceOffset(columnIndex + 1, 0);
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

  /**
   * 주어진 source offset이 속한 논리적 라인의 시작 source offset을 반환한다.
   * `findVisualLineBounds`와 달리 선행/후행 공백 제거에 영향받지 않는다.
   */
  private _getLogicalLineStart(offset: number): number {
    const info = this._mapper.getLineInfoBySourceOffset(offset);
    if (!info) return 0;
    return this._mapper.getLineStartSourceOffset(info.columnIndex, info.lineIndex) ?? 0;
  }

  /**
   * 주어진 source offset이 속한 논리적 라인의 끝 source offset을 반환한다.
   * 커서가 위치할 수 있는 마지막 offset(\n 위치 또는 텍스트 끝)이다.
   */
  private _getLogicalLineEnd(offset: number): number {
    const info = this._mapper.getLineInfoBySourceOffset(offset);
    if (!info) return 0;
    return this._getLineEndSourceOffset(info.columnIndex, info.lineIndex);
  }

  /**
   * End 키로 이동해야 할 라인 끝 offset을 반환한다.
   * `_getLogicalLineEnd`가 \n 위치나 content.length이면 그대로 반환하고,
   * 렌더링된 마지막 문자 위치이면 +1을 반환하여 커서가 문자 오른쪽에 표시되도록 한다.
   */
  private _getEndKeyOffset(offset: number): number {
    const lineEnd = this._getLogicalLineEnd(offset);
    if (this._mapper.renderedOffset(lineEnd) !== null) {
      return lineEnd + 1;
    }
    return lineEnd;
  }

  /** Ctrl+ArrowLeft: 이전 단어의 시작 위치로 이동 */
  private _findWordStart(content: string, offset: number): number {
    if (offset <= 0) return 0;
    let pos = offset;
    while (pos > 0 && /\s/.test(content[pos - 1])) {
      pos--;
    }
    while (pos > 0 && !/\s/.test(content[pos - 1])) {
      pos--;
    }
    return pos;
  }

  /** Ctrl+ArrowRight: 다음 단어의 시작 위치로 이동 */
  private _findWordEnd(content: string, offset: number): number {
    if (offset >= content.length) return content.length;
    let pos = offset;
    while (pos < content.length && !/\s/.test(content[pos])) {
      pos++;
    }
    while (pos < content.length && /\s/.test(content[pos])) {
      pos++;
    }
    return pos;
  }

  /**
   * 주어진 소스 오프셋이 속한 텍스트 블록의 textBlockStyle을 반환한다.
   * 각 블록은 `\n`으로 분리되며, 블록의 시작 오프셋부터 끝 오프셋(다음 \n 또는 문자열 끝)까지가 해당 블록의 범위이다.
   */
  private _findTextBlockStyleAtOffset(offset: number): TextBlockStyle | undefined {
    const model = this._paragraph.model;
    if (!model) return undefined;

    const contents = model.contents;
    if (contents.length === 0) return undefined;

    // 각 블록의 시작 오프셋을 누적하며 커서 오프셋이 어느 블록에 속하는지 찾는다
    let currentOffset = 0;
    for (const block of contents) {
      const blockLength = block.content.length;
      const blockStart = currentOffset;
      const blockEnd = currentOffset + blockLength;

      // 커서가 이 블록의 범위 내에 있으면 (끝 오프셋 포함)
      if (offset >= blockStart && offset <= blockEnd) {
        return block.textBlockStyle;
      }

      // 다음 블록으로 이동: 블록 길이 + \n(1)
      currentOffset = blockEnd + 1;
    }

    // 커서가 마지막 블록 끝을 넘어선 경우, 마지막 블록의 스타일 반환
    return contents[contents.length - 1].textBlockStyle;
  }

  private _onInput(event: InputEvent): void {
    if (this._isComposing || event.isComposing) return;

    const model = this._paragraph.model;
    if (!model) return;
    if (typeof model.textContent !== "string") return;

    const before = model.textContent;
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

      model.textContent = replaced;
      this._textarea.value = replaced;
      this._textarea.setSelectionRange(newOffset, newOffset);
      this._cursorModel.offset = newOffset;
      this._cursorModel.selection = null;

      if (inserted.length === 1) {
        this._optimisticSpanUpdate(newOffset - 1, inserted);
      }

      if (this._optimisticSpan) {
        this._updateCursorPosition();
        this._updateSelection();
      }
      this._debouncedRender();
      EditManager.getInstance()._notifyTextChange(this);
      EditManager.getInstance()._notifyCursorMove(this);
      return;
    }

    if (before === after) return;

    const change = this._computeTextChange(before, after, this._cursorModel.offset);

    model.textContent = after;
    newOffset = change.newOffset;
    this._cursorModel.offset = newOffset;

    if (change.type === "insert" && change.text.length === 1) {
      this._optimisticSpanUpdate(newOffset - 1, change.text);
    } else if (change.type === "replace" && change.text.length === 1) {
      this._optimisticSpanUpdate(newOffset - 1, change.text);
    }

    if (this._optimisticSpan) {
      this._updateCursorPosition();
    }
    this._debouncedRender();
    this._emitStyleChange();
    EditManager.getInstance()._notifyTextChange(this);
    EditManager.getInstance()._notifyCursorMove(this);
  }

  private _replaceSelection(replacement: string): void {
    const model = this._paragraph.model;
    if (!model) return;

    if (typeof model.textContent !== "string") return;

    const content = model.textContent;
    const activeSelection = this._cursorModel.selection;
    if (!activeSelection) return;

    const { start, end } = activeSelection.normalized();
    const newContent = content.slice(0, start.textOffset) + replacement + content.slice(end.textOffset);

    model.textContent = newContent;
    this._textarea.value = newContent;
    this._cursorModel.offset = start.textOffset + replacement.length;
    this._textarea.setSelectionRange(this._cursorModel.offset, this._cursorModel.offset);
    this._cursorModel.selection = null;

    this._debouncedRender();
    EditManager.getInstance()._notifyTextChange(this);
    EditManager.getInstance()._notifyCursorMove(this);
  }

  private _onCompositionStart(): void {
    this._compositionSession++;
    this._isComposing = true;

    if (this._debounceTimer !== null) {
      cancelAnimationFrame(this._debounceTimer);
      this._debounceTimer = null;
      this._paragraph.render();
    }

    this._removeCompositionSpan();

    const model = this._paragraph.model;

    const hadSelection = this._cursorModel.selection !== null;
    if (this._cursorModel.selection) {
      const normalized = this._cursorModel.selection.normalized();
      this._compositionStartOffset = normalized.start.textOffset;

      // 조합 시작 시 선택 영역을 모델에서 삭제하여 일관성 유지
      if (model && typeof model.textContent === "string") {
        const content = model.textContent;
        model.textContent = content.slice(0, normalized.start.textOffset) + content.slice(normalized.end.textOffset);
        this._textarea.value = model.textContent;
        this._textarea.setSelectionRange(normalized.start.textOffset, normalized.start.textOffset);
      }
    } else {
      this._compositionStartOffset = this._cursorModel.offset;
    }

    // _compositionBeforeContent must be captured AFTER selection deletion
    // so that composedLength = after.length - beforeContent.length
    // correctly represents the composed text length
    if (model && typeof model.textContent === "string") {
      this._compositionBeforeContent = model.textContent;
    } else {
      this._compositionBeforeContent = "";
    }
    this._cursorModel.selection = null;
    this._updateSelection();

    if (hadSelection) {
      this._paragraph.render();
    }

    // 조합 span을 커서 위치에 생성하여 조합 중인 글자를 시각적으로 표시
    this._compositionSpan = this._createOptimisticSpan("", this._compositionStartOffset);
    this._compositionSpan.style.minWidth = "0";
    this._compositionSpan.style.textDecoration = "underline";
    this._compositionSpan.style.textUnderlineOffset = "2px";

    let spanInserted = false;
    const renderedOffset = this._mapper.renderedOffset(this._compositionStartOffset);
    if (renderedOffset !== null) {
      const span = this._mapper.getSpanByOffset(renderedOffset);
      if (span) {
        span.before(this._compositionSpan);
        spanInserted = true;
      }
    } else if (this._compositionStartOffset > 0) {
      const prevRendered = this._mapper.renderedOffset(this._compositionStartOffset - 1);
      if (prevRendered !== null) {
        const prevSpan = this._mapper.getSpanByOffset(prevRendered);
        if (prevSpan) {
          prevSpan.after(this._compositionSpan);
          spanInserted = true;
        }
      }
    }

    if (!spanInserted && this._compositionStartOffset === 0) {
      const firstColumn = this._paragraph.querySelector("x-layout-column");
      if (firstColumn && firstColumn.shadowRoot) {
        const firstContainer = firstColumn.shadowRoot.firstElementChild;
        if (firstContainer instanceof HTMLElement) {
          firstContainer.appendChild(this._compositionSpan);
        }
      }
    }

    if (!this._positionCursorFromCompositionSpan()) {
      this._updateCursorPosition();
    }
  }

  private _onCompositionUpdate(event: CompositionEvent): void {
    if (!this._isComposing) return;

    if (event.data && this._compositionSpan) {
      this._compositionSpan.innerText = event.data;

      // 조합 글자의 스타일 업데이트 (글자가 바뀌면 너비도 변함)
      const model = this._paragraph.model;
      if (model) {
        const charStyle = model.genCharStyle(event.data);
      // genCharStyle does not include textDecoration — underline must be re-applied after Object.assign
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(this._compositionSpan.style, charStyle);
        this._compositionSpan.style.textDecoration = "underline";
        this._compositionSpan.style.textUnderlineOffset = "2px";
      }

      this._cursorModel.offset = this._compositionStartOffset + event.data.length;
    } else if (this._compositionSpan) {
      this._compositionSpan.innerText = "";
      this._cursorModel.offset = this._compositionStartOffset;
    }
    if (!this._positionCursorFromCompositionSpan()) {
      this._updateCursorPosition();
    }

    this._emitStyleChange();
  }

  private _positionCursorFromCompositionSpan(): boolean {
    if (!this._compositionSpan || !this._compositionSpan.parentNode) return false;
    const spanRect = this._compositionSpan.getBoundingClientRect();
    const paragraphRect = this._paragraph.getBoundingClientRect();
    const scale = EditManager.getInstance().scale;
    const localLeft = (spanRect.left - paragraphRect.left) / scale;
    const visualWidth = spanRect.width / scale;
    const widthRatio = this._paragraph.model?.widthRatio ?? 1;
    const layoutWidth = widthRatio > 0 ? visualWidth / widthRatio : visualWidth;
    const layoutRight = localLeft + layoutWidth;
    this._cursorEl.top = (spanRect.top - paragraphRect.top) / scale;
    this._cursorEl.left = layoutRight;
    this._cursorEl.height = spanRect.height / scale;
    this._cursorEl.visible = true;
    return true;
  }


  private _onCompositionCancel(): void {
    this._isComposing = false;
    this._removeCompositionSpan();

    const model = this._paragraph.model;
    if (model && typeof model.textContent === "string") {
      model.textContent = this._compositionBeforeContent;
      this._textarea.value = this._compositionBeforeContent;
      this._cursorModel.offset = this._compositionStartOffset;
      this._textarea.setSelectionRange(this._compositionStartOffset, this._compositionStartOffset);
      if (this._debounceTimer !== null) {
        cancelAnimationFrame(this._debounceTimer);
        this._debounceTimer = null;
        this._wasFocused = false;
      }
      this._paragraph.render();
      this._updateCursorPosition();
    }
  }

  private _onCompositionEnd(_event: CompositionEvent): void {
    this._isComposing = false;

    if (this._debounceTimer !== null) {
      cancelAnimationFrame(this._debounceTimer);
      this._debounceTimer = null;
    }

    this._removeCompositionSpan();

    const model = this._paragraph.model;
    if (!model) return;
    if (typeof model.textContent !== "string") return;

    const startOffset = this._compositionStartOffset;
    const beforeContent = this._compositionBeforeContent;

    const after = this._textarea.value;
    model.textContent = after;

    const composedLength = after.length - beforeContent.length;
    this._cursorModel.offset = startOffset + composedLength;

    this._paragraph.render();
    this._updateCursorPosition();
    this._updateSelection();
    this._emitStyleChange();
    EditManager.getInstance()._notifyTextChange(this);
    EditManager.getInstance()._notifyCursorMove(this);
  }

  private _removeCompositionSpan(): void {
    if (this._compositionSpan && this._compositionSpan.parentNode) {
      this._compositionSpan.remove();
    }
    this._compositionSpan = null;
  }

  private _resetCompositionState(): void {
    this._isComposing = false;
    this._removeCompositionSpan();
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
    // Clear any previous optimistic span before creating a new one
    if (this._optimisticSpan && this._optimisticSpan.parentNode) {
      this._optimisticSpan.remove();
    }
    this._optimisticSpan = null;

    // Insert a new span BEFORE the character at sourceOffset, instead of
    // replacing the existing span's text. This prevents the visual "replace then
    // restore" flicker — the existing character stays visible and the new
    // character appears to its left, matching the insert semantics.
    if (!this._paragraph.model) return;

    let renderedOffset = this._mapper.renderedOffset(sourceOffset);
    if (renderedOffset === null) {
      // sourceOffset is at a \n position — insert after the previous rendered char
      if (sourceOffset > 0) {
        renderedOffset = this._mapper.renderedOffset(sourceOffset - 1);
      }
      if (renderedOffset === null) return;

      const prevSpan = this._mapper.getSpanByOffset(renderedOffset);
      if (prevSpan) {
        const newSpan = this._createOptimisticSpan(char, sourceOffset);
        prevSpan.after(newSpan);
        this._optimisticSpan = newSpan;
      }
      return;
    }

    const span = this._mapper.getSpanByOffset(renderedOffset);
    if (span) {
      const newSpan = this._createOptimisticSpan(char, sourceOffset);
      span.before(newSpan);
      this._optimisticSpan = newSpan;
    }
  }

  private _createOptimisticSpan(char: string, sourceOffset: number): HTMLSpanElement {
    const model = this._paragraph.model;
    const span = document.createElement('span');
    const charStyle = model?.genCharStyle(char);
    if (charStyle) {
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(span.style, charStyle);
    }
    span.dataset.offset = String(sourceOffset); // temporary offset; will be corrected on re-render
    span.dataset.temporary = "true";
    span.innerText = char;
    return span;
  }

  private _debouncedRender(): void {
    if (this._debounceTimer !== null) {
      cancelAnimationFrame(this._debounceTimer);
    }
    this._wasFocused = this._isFocused;
    this._debounceTimer = requestAnimationFrame(() => {
      this._debounceTimer = null;
      this._paragraph.render();
    });
  }

  private _updateCursorPosition(): void {
    const content = this._paragraph.model?.textContent as string | undefined;
    const offset = this._cursorModel.offset;

    if (this._optimisticSpan && this._optimisticSpan.parentNode) {
      const spanRect = this._optimisticSpan.getBoundingClientRect();
      const paragraphRect = this._paragraph.getBoundingClientRect();
      const scale = EditManager.getInstance().scale;
      const localLeft = (spanRect.left - paragraphRect.left) / scale;
      const visualWidth = spanRect.width / scale;
      const widthRatio = this._paragraph.model?.widthRatio ?? 1;
      const layoutWidth = widthRatio > 0 ? visualWidth / widthRatio : visualWidth;
      const layoutRight = localLeft + layoutWidth;
      this._cursorEl.top = (spanRect.top - paragraphRect.top) / scale;
      this._cursorEl.left = layoutRight;
      this._cursorEl.height = spanRect.height / scale;
      const hasVisibleSelection = this._cursorModel.selection !== null &&
        this._cursorModel.selection.anchor.textOffset !== this._cursorModel.selection.focus.textOffset;
      this._cursorEl.visible = this._isFocused && !hasVisibleSelection;
      this._textarea.style.top = `${(spanRect.top - paragraphRect.top) / scale}px`;
      this._textarea.style.left = `${localLeft}px`;
      return;
    }

    let renderedOffset = this._mapper.renderedOffset(offset);
    let atEndOfChar = false;

    if (this._crossRightState === 'sticking' && offset > 0) {
      const prevRendered = this._mapper.renderedOffset(offset - 1);
      if (prevRendered !== null) {
        renderedOffset = prevRendered;
        atEndOfChar = true;
      }
    }

    if (this._crossRightState === 'crossed') {
      const rendered = this._mapper.renderedOffset(offset);
      if (rendered !== null) {
        renderedOffset = rendered;
        atEndOfChar = false;
      } else {
        const nextRendered = this._mapper.renderedOffset(offset + 1);
        if (nextRendered !== null) {
          renderedOffset = nextRendered;
          atEndOfChar = false;
        }
      }
    }

    if (this._crossLeftState === 'crossed' && offset > 0) {
      const prevRendered = this._mapper.renderedOffset(offset - 1);
      if (prevRendered !== null) {
        renderedOffset = prevRendered;
        atEndOfChar = true;
      }
    }

    if (this._crossLeftState === 'sticking') {
      const rendered = this._mapper.renderedOffset(offset);
      if (rendered !== null) {
        renderedOffset = rendered;
        atEndOfChar = false;
      }
    }

    if (renderedOffset === null && content !== undefined) {
      // \n 위치: 먼저 인접 문자로 폴백하여 이전 라인 끝 또는 다음 라인 시작에 표시.
      // offset이 \n 위치이면 이전 문자의 오른쪽(atEndOfChar=true)이 이전 라인 끝에 해당.
      if (offset > 0) {
        const prevRendered = this._mapper.renderedOffset(offset - 1);
        if (prevRendered !== null) {
          renderedOffset = prevRendered;
          atEndOfChar = true;
        }
      }
      if (renderedOffset === null && offset < content.length) {
        const nextRendered = this._mapper.renderedOffset(offset + 1);
        if (nextRendered !== null) {
          renderedOffset = nextRendered;
          atEndOfChar = false;
        }
      }
      // 인접 문자도 없는 경우(빈 줄 시작): line rect 사용
      if (renderedOffset === null) {
        const lineInfo = this._mapper.getLineInfoBySourceOffset(offset);
        if (lineInfo !== null) {
          const lineRect = this._mapper.getLineRect(lineInfo.columnIndex, lineInfo.lineIndex);
          if (lineRect) {
            const textAlign = this._paragraph.paragraphStyle?.textAlign || DEFAULT_TEXT_ALIGN;
            let left: number;
            if (textAlign === 'center') {
              left = lineRect.left + lineRect.width / 2;
            } else if (textAlign === 'right') {
              left = lineRect.left + lineRect.width;
            } else {
              left = lineRect.left;
            }
            const fontSize = this._mapper.getFirstColumnRect()?.fontSize ?? lineRect.height;
            this._cursorEl.top = lineRect.top + (lineRect.height - fontSize) / 2;
            this._cursorEl.left = left;
            this._cursorEl.height = fontSize;
            const hasVisibleSelection = this._cursorModel.selection !== null &&
              this._cursorModel.selection.anchor.textOffset !== this._cursorModel.selection.focus.textOffset;
            this._cursorEl.visible = this._isFocused && !hasVisibleSelection;
            this._textarea.style.top = `${lineRect.top}px`;
            this._textarea.style.left = `${left}px`;
            return;
          }
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
        this._cursorEl.visible = this._isFocused && !hasVisibleSelection;
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

    const useFallback = rect.height <= 1;
    const cursorHeight = useFallback ? (this._mapper.getFirstColumnRect()?.fontSize ?? rect.height) : rect.height;
    const cursorTop = useFallback ? this._resolveFallbackTop(renderedOffset, cursorHeight) : rect.top;
    this._cursorEl.top = cursorTop;
    this._cursorEl.left = atEndOfChar ? rect.left + rect.width : rect.left;
    this._cursorEl.height = cursorHeight;
    const hasVisibleSelection = this._cursorModel.selection !== null &&
      this._cursorModel.selection.anchor.textOffset !== this._cursorModel.selection.focus.textOffset;
    this._cursorEl.visible = this._isFocused && !hasVisibleSelection;

    this._textarea.style.top = `${rect.top}px`;
    this._textarea.style.left = `${rect.left}px`;
  }

  /**
   * 공백 등 height≈0인 span에서 커서 top을 결정한다.
   * 인접한 일반 문자의 top을 우선 사용하고, 실패하면 rect.top에서 cursorHeight를 뺀다.
   */
  private _resolveFallbackTop(renderedOffset: number, cursorHeight: number): number {
    const offsets = [renderedOffset - 1, renderedOffset + 1];
    for (const off of offsets) {
      if (off < 0) continue;
      const neighborRect = this._mapper.getCharRect(off);
      if (neighborRect && neighborRect.height > 1) {
        return neighborRect.top;
      }
    }
    const rect = this._mapper.getCharRect(renderedOffset);
    return rect ? rect.top - cursorHeight : 0;
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
    this._emitStyleChange();
    EditManager.getInstance()._notifyCursorMove(this);
  }

  /**
   * 외부에서 선택 영역을 설정할 때 사용한다.
   * T14 이후 선택 핸들러에서 사용될 예정.
   */
  setSelection(range: SelectionRange): void {
    this._cursorModel.selection = range;
    this._updateSelection();
    this._emitStyleChange();
    EditManager.getInstance()._notifyCursorMove(this);
  }

  /**
   * 현재 커서 위치의 스타일이 이전과 다를 때만 styleChange 이벤트를 발생시킨다.
   */
  private _emitStyleChange(): void {
    const current = this.currentStyle;
    const json = JSON.stringify(current);
    if (json !== this._lastStyleJson) {
      this._lastStyleJson = json;
      EditManager.getInstance()._notifyStyleChange(this);
    }
  }
}

/**
 * 커서/선택의 내부 상태.
 */
interface CursorModel {
  offset: number;
  selection: SelectionRange | null;
}
