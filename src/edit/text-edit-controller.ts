import { LayoutCursorElement, LayoutSelectionElement } from "@/components";
import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import { TextInlineStyle, ParagraphStyle, TextStyle } from "@/types/style";
import { CursorPosition } from "@/types/edit/cursor.type";
import { SelectionRange } from "@/types/edit/selection.type";
import type { TextLineData } from "@/types/layout/text/text-line.type";
import { TextEditCoordinateMapper } from "./text-edit-coordinate-mapper";
import { EditManager } from "./edit-manager";
import { DEFAULT_LETTER_SPACING, DEFAULT_WIDTH_RATIO, DEFAULT_TEXT_ALIGN, DEFAULT_VERTICAL_ALIGN, Z_INDEX_TEXTAREA } from "@/constants";
import { RunMap, inlineToPlain, plainToInline, shiftRunMap, getStyleAtOffset, applyStyleToRange, normalizeRunMap, mergeAdjacentSameStyle, resolvePatchAgainstInherit, stripRunFields } from "./run-map";

/**
 * 커서 위치에서 유효한 스타일 정보.
 * 단락의 TextStyle/ParagraphStyle과 상속 스타일(InheritStyle)을 병합하고,
 * 커서가 위치한 인라인 런의 TextInlineStyle로 오버라이드한 결과.
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
  private _manager: EditManager;
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
  private _handleVisibilityChange: () => void;
  private _clickCount: number = 0;
  private _clickTimer: ReturnType<typeof setTimeout> | null = null;

  private _isComposing: boolean = false;
  private _compositionStartOffset: number = 0;

  private _compositionSession: number = 0;
  private _compositionBeforeContent: string = "";
  /** 조합 중인 텍스트 (마지막 compositionupdate의 event.data) */
  private _compositionData: string = "";
  /** postRender에서 조합 범위 span에 밑줄을 적용했는지 추적 */
  private _compositionUnderlineApplied: boolean = false;
  private _debounceTimer: number | null = null;
  private _wasFocused: boolean = false;
  private _optimisticSpan: HTMLSpanElement | null = null;
  // optimistic span의 현재 폭(mm) — 후속 span 밀어내기/되돌림에 사용
  private _optimisticSpanWidthMm: number = 0;
  private _lastStyleJson: string | null = null;
  private _runMap: RunMap = [];

  private _selectionAnchor: number | null = null;
  private _isMouseDown: boolean = false;
  private _wasDragged: boolean = false;
  private _isFocused: boolean = false;
  private _pendingTextChangeOnBlur: boolean = false;
  private _mousemoveRafId: number | null = null;
  private _lastMouseX: number = 0;
  private _lastMouseY: number = 0;

  constructor(paragraph: LayoutParagraphElement, manager: EditManager) {
    this._paragraph = paragraph;
    this._manager = manager;
    this._mapper = new TextEditCoordinateMapper(paragraph, manager);

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
          if (model) {
            const after = this._textarea.value;
            model.textContent = plainToInline(after, this._runMap);
            const composedLength = after.length - this._compositionBeforeContent.length;
            this._cursorModel.offset = this._compositionStartOffset + composedLength;
            if (this._debounceTimer !== null) {
              cancelAnimationFrame(this._debounceTimer);
              this._debounceTimer = null;
              this._wasFocused = false;
            }
            this._paragraph.scheduleRender();
          }
        }
      }
    };
    document.addEventListener("visibilitychange", this._handleVisibilityChange);

    // Sync textarea value with model content so _onInput can compute correct diffs
    const model = paragraph.model;
    if (model) {
      const { text, runMap } = inlineToPlain(model.textContent);
      this._textarea.value = text;
      this._runMap = runMap;
    }

    this._updateCursorPosition();

    this._manager._register(this);
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
   * `inheritStyle`을 병합한 후, 커서가 위치한 인라인 런의
   * `textInlineStyle`로 필드를 오버라이드한다.
   *
   * 커서가 텍스트 끝이나 빈 단락에 있어도 단락 수준의 스타일을 반환한다.
   * 편집 모드가 활성화되지 않았거나 모델이 없으면 빈 객체를 반환한다.
   */
  get currentStyle(): CurrentStyle {
    const model = this._paragraph.model;
    if (!model) return { textStyle: {}, paragraphStyle: {} };

    const sel = this._cursorModel.selection;
    if (sel) {
      const { start, end } = sel.normalized();
      if (start.textOffset < end.textOffset) {
        return this.computeSelectionCommonStyle(start.textOffset, end.textOffset);
      }
    }

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

    const inlineStyle = getStyleAtOffset(this._runMap, this._cursorModel.offset);
    if (!inlineStyle) return { textStyle: baseTextStyle, paragraphStyle: baseParagraphStyle };

    const effectiveTextStyle: TextStyle = {
      ...baseTextStyle,
      ...(inlineStyle.fontFamily !== undefined && { fontFamily: inlineStyle.fontFamily }),
      ...(inlineStyle.fontSize !== undefined && { fontSize: inlineStyle.fontSize }),
      ...(inlineStyle.fontWeight !== undefined && { fontWeight: inlineStyle.fontWeight }),
      ...(inlineStyle.fontStyle !== undefined && { fontStyle: inlineStyle.fontStyle }),
      ...(inlineStyle.color !== undefined && { color: inlineStyle.color }),
    };

    return { textStyle: effectiveTextStyle, paragraphStyle: baseParagraphStyle };
  }

  /**
   * selection 영역 내 모든 오프셋의 유효 스타일을 비교하여 공통값만 남긴다.
   *
   * 각 필드는 영역 내 모든 위치에서 동일한 값만 반환하고, 하나라도 상이하면
   * `undefined`로 지운다. 상속값 + 문단 스타일 + 런 스타일 순으로 병합한
   * 최종(effective) 스타일 기준으로 비교한다.
   *
   * @param startOffset - selection 시작 오프셋 (포함)
   * @param endOffset - selection 끝 오프셋 (미포함)
   * @returns 공통 스타일. 상이한 필드는 해당 객체에서 생략됨
   */
  computeSelectionCommonStyle(startOffset: number, endOffset: number): CurrentStyle {
    const model = this._paragraph.model;
    if (!model) return { textStyle: {}, paragraphStyle: {} };

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

    const COMMON_FIELDS: (keyof TextStyle)[] = ["color", "fontFamily", "fontWeight", "fontStyle", "fontSize"];

    const commonTextStyle: TextStyle = {};

    let first = true;
    for (let offset = startOffset; offset < endOffset; offset++) {
      const inlineStyle = getStyleAtOffset(this._runMap, offset);
      const offsetStyle: TextStyle = inlineStyle
        ? {
            ...baseTextStyle,
            ...(inlineStyle.fontFamily !== undefined && { fontFamily: inlineStyle.fontFamily }),
            ...(inlineStyle.fontSize !== undefined && { fontSize: inlineStyle.fontSize }),
            ...(inlineStyle.fontWeight !== undefined && { fontWeight: inlineStyle.fontWeight }),
            ...(inlineStyle.fontStyle !== undefined && { fontStyle: inlineStyle.fontStyle }),
            ...(inlineStyle.color !== undefined && { color: inlineStyle.color }),
          }
        : baseTextStyle;

      if (first) {
        // 공통값 기준은 첫 offset의 유효 스타일이다. 문단 기본으로 초기화하면
        // 런이 기본을 오버라이드한 순간 "상이"로 오판되어 필드가 삭제된다.
        for (const field of COMMON_FIELDS) {
          const value: string | number | undefined = offsetStyle[field];
          if (value !== undefined) {
            (commonTextStyle as Record<string, unknown>)[field] = value;
          }
        }
        first = false;
      } else {
        for (const field of COMMON_FIELDS) {
          if (commonTextStyle[field] !== undefined && commonTextStyle[field] !== offsetStyle[field]) {
            delete commonTextStyle[field];
          }
        }
      }
    }

    return { textStyle: commonTextStyle, paragraphStyle: baseParagraphStyle };
  }

  /**
   * 편집기를 제거하고 모든 이벤트 리스너를 해제한다.
   */
  destroy(): void {
    this._manager._unregister(this);

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
      this._shiftFollowingSpans(this._optimisticSpan, -this._optimisticSpanWidthMm);
      this._optimisticSpan.remove();
    }
    this._optimisticSpan = null;
    this._optimisticSpanWidthMm = 0;

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
    if (model) {
      if (!this._isComposing) {
        const { text: modelText, runMap: modelRunMap } = inlineToPlain(model.textContent);
        if (modelText !== this._textarea.value) {
          this._textarea.value = modelText;
          this._runMap = modelRunMap;
        }
        this._syncTextareaSelection();
      }
    }
    this._updateCursorPosition();
    this._updateSelection();

    if (this._isComposing) {
      this._applyCompositionUnderline();
    } else if (this._compositionUnderlineApplied) {
      this._clearCompositionUnderline();
    }

    if (this._wasFocused) {
      // preventScroll: textarea 자동 스크롤이 스크롤 컨테이너를 좌상단으로 점프시키는 버그 방지.
      this._textarea.focus({ preventScroll: true });
      this._wasFocused = false;
    }
  }

  /**
   * 숨겨진 textarea에 포커스를 준다.
   *
   * `preventScroll: true`로 브라우저 기본 스크롤-인토-뷰를 억제한다. textarea는
   * 1x1 투명 요소이므로 자동 스크롤 시 컨테이너가 좌상단으로 점프한다. 커서/선택의
   * 시각적 위치는 `_updateCursorPosition()`/`_updateSelection()`이 별도 관리한다.
   *
   * @example
   * controller.focus(); // 커서 표시, 스크롤 점프 없음
   *
   * @returns void
   */
  focus(): void {
    this._textarea.focus({ preventScroll: true });
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

    this._manager._releaseFocus(this);
  }

  /** blur 중 대기 중인 textChange를 소비한다. `_releaseFocus`가 focusChange 이후에 호출. @internal */
  _consumePendingTextChange(): boolean {
    if (this._pendingTextChangeOnBlur) {
      this._pendingTextChangeOnBlur = false;
      return true;
    }
    return false;
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
    textarea.style.zIndex = String(Z_INDEX_TEXTAREA);
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

    const sourceOffset = parseInt(targetSpan.dataset.sourceOffset ?? '', 10);
    if (Number.isNaN(sourceOffset)) return null;

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
          this._manager._notifyCursorMove(this);
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
      this._manager._notifyCursorMove(this);
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
    this._manager._notifyCursorMove(this);
    document.addEventListener("mousemove", this._handleMouseMove);
  }

  private _onMouseMove(event: MouseEvent): void {
    if (!this._isMouseDown) return;
    this._lastMouseX = event.clientX;
    this._lastMouseY = event.clientY;
    if (this._mousemoveRafId !== null) return;

    if (!this._wasDragged) {
      this._wasDragged = true;
      this._manager._notifySelectionStart(this);
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

    // 텍스트 드래그 선택이 있었으면 후속 click 이벤트가 LayoutSelectionController
    // _onClick에 도달해 선택을 가로채는 것을 방지한다.
    // 드래그 중 마우스가 paragraph를 벗어나거나 오버랩된 다른 요소 위에서
    // mouseup이 발생해도, mousedown으로 시작된 드래그 시퀀스가 mouseup까지
    // 마우스 이벤트의 소유권을 가져가야 한다.
    if (this._wasDragged) {
      this._manager._suppressLayoutClick();
    }

    if (this._cursorModel.selection) {
      this._manager._notifySelectionEnd(this);
      this._emitStyleChange();
      this._manager._notifyCursorMove(this);
    }
  }

  private _onDoubleClick(event: MouseEvent): void {
    event.preventDefault();

    const sourceOffset = this._getSourceOffsetFromEvent(event);
    if (sourceOffset === null) return;

    const model = this._paragraph.model;
    if (!model) return;
    if (typeof model.textContent !== "string" && !Array.isArray(model.textContent)) return;

    const content = this._textarea.value;
    const { start, end } = this._findWordBoundaries(content, sourceOffset);
    this._cursorModel.selection = SelectionRange.fromOffsets(start, end);
    this._cursorModel.offset = end;
    this._textarea.setSelectionRange(end, end);
    this.focus();
    this._updateCursorPosition();
    this._updateSelection();
    this._manager._notifySelectionStart(this);
    this._manager._notifySelectionEnd(this);
    this._manager._notifyCursorMove(this);
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
    this._manager._requestFocus(this);
    this._isFocused = true;
    if (this._cursorModel.selection) {
      this._cursorEl.visible = false;
    } else {
      this._cursorEl.visible = true;
    }
    this.normalizeNow();
  }

  private _onBlur(): void {
    const wasComposing = this._isComposing;
    this._isFocused = false;
    this._wasFocused = false;
    this._resetCompositionState();

    if (wasComposing) {
      const model = this._paragraph.model;
      if (model) {
        const after = this._textarea.value;
        model.textContent = plainToInline(after, this._runMap);
        const composedLength = after.length - this._compositionBeforeContent.length;
        this._cursorModel.offset = this._compositionStartOffset + composedLength;
        if (this._debounceTimer !== null) {
          cancelAnimationFrame(this._debounceTimer);
          this._debounceTimer = null;
        }
        this._paragraph.scheduleRender();
        this._pendingTextChangeOnBlur = true;
      }
    }

    this.normalizeNow();
    this._cursorEl.visible = false;
  }

  private _onKeydown(event: KeyboardEvent): void {
    if (this._isComposing) {
      if (event.key === "Escape") {
        event.preventDefault();
        this._onCompositionCancel();
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
        event.preventDefault();
        this._textarea.setSelectionRange(this._compositionStartOffset, this._compositionStartOffset);
      }
      return;
    }
    const model = this._paragraph.model;
    if (!model) return;

    if (typeof model.textContent !== "string" && !Array.isArray(model.textContent)) return;

    const content = this._textarea.value;
    const offset = this._cursorModel.offset;
    const hasShortcut = event.ctrlKey || event.metaKey;

    if (hasShortcut && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this._selectAll();
      this._manager._notifyCursorMove(this);
      return;
    }

    if (hasShortcut && event.key.toLowerCase() === "b") {
      event.preventDefault();
      this._toggleInlineStyle("fontWeight", 700);
      return;
    }

    if (hasShortcut && event.key.toLowerCase() === "i") {
      event.preventDefault();
      this._toggleInlineStyle("fontStyle", "italic");
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
      event.stopPropagation();
      if (this._cursorModel.selection) {
        this._clearSelection();
      } else {
        this._manager.blurParagraph();
      }
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
        } else if (atLineStart) {
          // 라인 시작에서 ArrowLeft: 이전 라인 끝(phantom end)으로 배치
          targetLeft = offset;
          this._crossLeftState = 'crossed';
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
      if (isCursorKey) {
        this._manager._notifyCursorMove(this);
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
      if (isCursorKey) {
        this._manager._notifyCursorMove(this);
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
      if (isCursorKey) {
        this._manager._notifyCursorMove(this);
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
      if (isCursorKey) { this._manager._notifyCursorMove(this); }
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
      if (isCursorKey) { this._manager._notifyCursorMove(this); }
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
        this._manager._notifyTextChange(this);
        this._manager._notifyCursorMove(this);
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
        this._manager._notifyTextChange(this);
        this._manager._notifyCursorMove(this);
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
    this._manager._notifyTextChange(this);
    this._manager._notifyCursorMove(this);
    break;
  }
      default:
        // Other keys are handled by input/composition handlers
        break;
    }
  }

  /**
   * keyup 이벤트 핸들러.
   *
   * 커서 이동 키(ArrowLeft/Right/Up/Down/Home/End)의 keyup에서 `cursorMove`
   * 이벤트를 발생시킨다. keydown에서 반복 입력(`event.repeat === true`) 시에도
   * `cursorMove`가 발생하므로, 외부 UI 커서 위치 표시기가 화살표 키 연속 입력
   * 중에도 갱신된다. keyup은 연속 입력의 마지막 이벤트이므로 docs의
   * "최초 KeyDown과 마지막 KeyUp에만 발생" 패턴을 구현한다.
   *
   * @param event - keyup 키보드 이벤트
   */
  private _onKeyup(event: KeyboardEvent): void {
    const isCursorKey = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key);
    if (isCursorKey) {
      this._manager._notifyCursorMove(this);
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

    if (typeof model.textContent !== "string" && !Array.isArray(model.textContent)) return;

    const content = this._textarea.value;
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

    const rawPastedText = event.clipboardData?.getData("text/plain") ?? "";
    if (rawPastedText.length === 0) return;

    const pastedText = rawPastedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    if (typeof model.textContent !== "string" && !Array.isArray(model.textContent)) return;

    const content = this._textarea.value;
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
    this._manager._notifyTextChange(this);
    this._manager._notifyCursorMove(this);
  }

  private _selectAll(): void {
    const model = this._paragraph.model;
    if (!model) return;

    if (typeof model.textContent !== "string" && !Array.isArray(model.textContent)) return;

    const content = this._textarea.value;
    this._cursorModel.selection = SelectionRange.fromOffsets(0, content.length);
    this._cursorModel.offset = content.length;
    this._textarea.setSelectionRange(0, content.length);
    this._updateCursorPosition();
    this._updateSelection();
    this._manager._notifySelectionStart(this);
    this._manager._notifySelectionEnd(this);
  }

  _clearSelection(): void {
    const hadSelection = this._cursorModel.selection !== null;
    this._cursorModel.selection = null;
    this._selectionEl.setRanges([]);
    this._textarea.setSelectionRange(this._cursorModel.offset, this._cursorModel.offset);
    this._updateCursorPosition();
    if (hadSelection) {
      this._manager._notifySelectionEnd(this);
    }
  }

  private _computeVerticalOffset(direction: -1 | 1): number | null {
    const model = this._paragraph.model;
    if (!model) return null;
    if (typeof model.textContent !== "string" && !Array.isArray(model.textContent)) return null;

    const offset = this._cursorModel.offset;

    const visualBounds = this._mapper.findVisualLineBounds(offset);
    const visualBoundsPrev = offset > 0 ? this._mapper.findVisualLineBounds(offset - 1) : null;
    const atVisualLineEnd = visualBoundsPrev !== null && offset === visualBoundsPrev.end;
    const atVisualLineStart = visualBounds !== null && offset === visualBounds.start;

    // \n 위치나 trailing space처럼 매핑이 없는 offset은 커서가 직접
    // 위치할 수 없으므로, 마지막 visible 문자(offset === visualBounds.end - 1)를
    // 라인 끝으로 취급한다.
    const isAtLineStart = atVisualLineStart;
    const isAtLineEnd = atVisualLineEnd
      || (visualBounds !== null
        && offset === visualBounds.end - 1
        && this._mapper.getCursorPlacement(offset + 1) === null);

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
      const currentLineStart = this._mapper.getLineStartSourceOffset(currentLineInfo.columnIndex, currentLineInfo.lineIndex) ?? offset;
      const offsetInLine = offset - currentLineStart;
      return Math.min(targetLineStart + offsetInLine, targetVisualEnd);
    }

    const currentLineStart = this._mapper.getLineStartSourceOffset(currentLineInfo.columnIndex, currentLineInfo.lineIndex) ?? offset;
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
    const content = this._textarea.value;
    if (typeof content !== "string") return 0;

    const lineStart = this._mapper.getLineStartSourceOffset(columnIndex, lineIndex);
    const columnContents = model.columnContents;
    const nextStart = this._findNextLineStart(columnContents, columnIndex, lineIndex);

    if (nextStart === null) {
      return content.length;
    }
    if (lineStart === null) {
      return Math.max(0, nextStart - 1);
    }
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
    if (!info) return offset;
    return this._mapper.getLineStartSourceOffset(info.columnIndex, info.lineIndex) ?? offset;
  }

  /**
   * 주어진 source offset이 속한 논리적 라인의 끝 source offset을 반환한다.
   * 커서가 위치할 수 있는 마지막 offset(\n 위치 또는 텍스트 끝)이다.
   */
  private _getLogicalLineEnd(offset: number): number {
    const info = this._mapper.getLineInfoBySourceOffset(offset);
    if (!info) return offset;
    return this._getLineEndSourceOffset(info.columnIndex, info.lineIndex);
  }

  /**
   * End 키로 이동해야 할 라인 끝 offset을 반환한다.
   * `_getLogicalLineEnd`가 \n 위치나 content.length이면 그대로 반환하고,
   * 렌더링된 마지막 문자 위치이면 +1을 반환하여 커서가 문자 오른쪽에 표시되도록 한다.
   */
  private _getEndKeyOffset(offset: number): number {
    const lineEnd = this._getLogicalLineEnd(offset);
    // lineEnd가 \n 위치이면 그대로 반환 (\n 앞에서 멈춤)
    if (this._paragraph.model?.textContent?.[lineEnd] === "\n") {
      return lineEnd;
    }
    if (this._mapper.getCursorPlacement(lineEnd) !== null) {
      return lineEnd + 1;
    }
    // lineEnd가 매핑되지 않은 위치(\n, 생략된 공백)면
    // 역방향으로 가장 가까운 매핑된 위치 + 1을 반환
    for (let back = lineEnd - 1; back >= 0; back--) {
      if (this._mapper.getCursorPlacement(back) !== null) {
        return back + 1;
      }
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

  private _getPlainText(): string {
    const model = this._paragraph.model;
    if (!model) return this._textarea.value;
    const { text } = inlineToPlain(model.textContent);
    return text;
  }

  private _onInput(event: InputEvent): void {
    if (this._isComposing || event.isComposing) return;

    const model = this._paragraph.model;
    if (!model) return;

    const before = this._getPlainText();
    const after = this._textarea.value;
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

      const deletedLen = endOffset - startOffset;
      if (deletedLen > 0) {
        this._runMap = shiftRunMap(this._runMap, startOffset, -deletedLen);
        this._runMap = applyStyleToRange(this._runMap, startOffset, startOffset, {});
      }
      if (inserted.length > 0) {
        this._runMap = shiftRunMap(this._runMap, startOffset, inserted.length);
        this._runMap = applyStyleToRange(this._runMap, startOffset, startOffset + inserted.length, {});
      }

      newOffset = startOffset + inserted.length;

      model.textContent = plainToInline(after, this._runMap);
      this._textarea.value = after;
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
      this._manager._notifyTextChange(this);
      this._manager._notifyCursorMove(this);
      return;
    }

    if (before === after) return;

    const change = this._computeTextChange(before, after, this._cursorModel.offset);

    if (change.type === "insert") {
      this._runMap = shiftRunMap(this._runMap, change.newOffset - change.text.length, change.text.length);
    } else if (change.type === "delete") {
      const deletedLen = change.text.length;
      this._runMap = shiftRunMap(this._runMap, change.newOffset, -deletedLen);
    } else if (change.type === "replace") {
      const deletedLen = change.deletedText?.length ?? 0;
      if (deletedLen > 0) {
        this._runMap = shiftRunMap(this._runMap, change.newOffset, -deletedLen);
      }
      this._runMap = shiftRunMap(this._runMap, change.newOffset, change.text.length);
    }

    model.textContent = plainToInline(after, this._runMap);
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
    this._manager._notifyTextChange(this);
    this._manager._notifyCursorMove(this);
  }

  private _replaceSelection(replacement: string): void {
    const model = this._paragraph.model;
    if (!model) return;

    if (typeof model.textContent !== "string" && !Array.isArray(model.textContent)) return;

    const content = this._textarea.value;
    const activeSelection = this._cursorModel.selection;
    if (!activeSelection) return;

    const { start, end } = activeSelection.normalized();
    const newContent = content.slice(0, start.textOffset) + replacement + content.slice(end.textOffset);
    const deletedLen = end.textOffset - start.textOffset;
    if (deletedLen > 0) {
      this._runMap = shiftRunMap(this._runMap, start.textOffset, -deletedLen);
    }
    if (replacement.length > 0) {
      this._runMap = shiftRunMap(this._runMap, start.textOffset, replacement.length);
    }

    model.textContent = plainToInline(newContent, this._runMap);
    this._textarea.value = newContent;
    this._cursorModel.offset = start.textOffset + replacement.length;
    this._textarea.setSelectionRange(this._cursorModel.offset, this._cursorModel.offset);
    this._cursorModel.selection = null;

    this._debouncedRender();
    this._manager._notifyTextChange(this);
    this._manager._notifyCursorMove(this);
  }

  private _onCompositionStart(): void {
    this._compositionSession++;
    this._isComposing = true;
    this._compositionData = "";

    if (this._debounceTimer !== null) {
      cancelAnimationFrame(this._debounceTimer);
      this._debounceTimer = null;
      this._paragraph.scheduleRender();
    }

    const model = this._paragraph.model;

    if (this._cursorModel.selection) {
      const normalized = this._cursorModel.selection.normalized();
      this._compositionStartOffset = normalized.start.textOffset;

      if (model) {
        const content = this._textarea.value;
        const deletedLen = normalized.end.textOffset - normalized.start.textOffset;
        if (deletedLen > 0) {
          this._runMap = shiftRunMap(this._runMap, normalized.start.textOffset, -deletedLen);
        }
        const newContent = content.slice(0, normalized.start.textOffset) + content.slice(normalized.end.textOffset);
        model.textContent = plainToInline(newContent, this._runMap);
        this._textarea.value = newContent;
        this._textarea.setSelectionRange(normalized.start.textOffset, normalized.start.textOffset);
      }
    } else {
      this._compositionStartOffset = this._cursorModel.offset;
    }

    if (model) {
      this._compositionBeforeContent = this._textarea.value;
    } else {
      this._compositionBeforeContent = "";
    }
    this._cursorModel.selection = null;
    this._updateSelection();

    if (this._debounceTimer !== null) {
      cancelAnimationFrame(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._wasFocused = false;
    this._paragraph.scheduleRender();
    this._updateCursorPosition();
  }

  private _onCompositionUpdate(event: CompositionEvent): void {
    if (!this._isComposing) return;

    const model = this._paragraph.model;
    if (model) {
      const before = this._compositionBeforeContent;
      const start = this._compositionStartOffset;
      const data = event.data ?? "";
      const newText = before.slice(0, start) + data + before.slice(start);
      // 조합 중 텍스트는 삽입 위치가 속한 런의 스타일을 이어받는다.
      // this._runMap은 조합 시작 전 상태를 유지하므로, 매 업데이트마다 원본 런 맵에서
      // 조합 길이만큼 임시 확장한 맵으로 변환한다 (확정 시 _onCompositionEnd에서 실제 shift).
      const tempRunMap = shiftRunMap(this._runMap, start, data.length);
      model.textContent = plainToInline(newText, tempRunMap);
      this._compositionData = data;
      this._cursorModel.offset = start + data.length;
      this._paragraph.scheduleRender();
    }

    this._updateCursorPosition();
    this._emitStyleChange();
  }

  private _onCompositionCancel(): void {
    this._isComposing = false;
    this._compositionData = "";

    const model = this._paragraph.model;
    if (model) {
      model.textContent = plainToInline(this._compositionBeforeContent, this._runMap);
      this._textarea.value = this._compositionBeforeContent;
      this._cursorModel.offset = this._compositionStartOffset;
      this._textarea.setSelectionRange(this._compositionStartOffset, this._compositionStartOffset);
      if (this._debounceTimer !== null) {
        cancelAnimationFrame(this._debounceTimer);
        this._debounceTimer = null;
        this._wasFocused = false;
      }
      this._paragraph.flushRender();
      this._updateCursorPosition();
      this._manager._notifyTextChange(this);
      this._manager._notifyCursorMove(this);
    }
  }

  private _onCompositionEnd(_event: CompositionEvent): void {
    this._isComposing = false;
    this._compositionData = "";

    if (this._debounceTimer !== null) {
      cancelAnimationFrame(this._debounceTimer);
      this._debounceTimer = null;
    }

    const model = this._paragraph.model;
    if (!model) return;
    if (typeof model.textContent !== "string" && !Array.isArray(model.textContent)) return;

    const startOffset = this._compositionStartOffset;
    const beforeContent = this._compositionBeforeContent;

    const after = this._textarea.value;
    const composedLength = after.length - beforeContent.length;
    if (composedLength !== 0) {
      this._runMap = shiftRunMap(this._runMap, startOffset, composedLength);
    }
    model.textContent = plainToInline(after, this._runMap);

    this._cursorModel.offset = startOffset + composedLength;

    this._paragraph.flushRender();
    this._clearCompositionUnderline();
    this._updateCursorPosition();
    this._updateSelection();
    this._emitStyleChange();
    this._manager._notifyTextChange(this);
    this._manager._notifyCursorMove(this);
  }

  private _resetCompositionState(): void {
    this._isComposing = false;
    this._compositionData = "";
  }

  /**
   * 조합 범위 [_compositionStartOffset, start + _compositionData.length)의
   * 엔진 렌더링 span에 밑줄 스타일을 적용한다.
   *
   * 조합 중인 텍스트가 model.textContent에 반영되어 엔진이 렌더링하므로,
   * 별도의 임시 span 없이 렌더링된 span에 스타일만 적용한다.
   */
  private _applyCompositionUnderline(): void {
    const start = this._compositionStartOffset;
    const len = this._compositionData.length;
    if (len === 0) return;

    const columns = this._paragraph.querySelectorAll('x-layout-column');
    for (const col of columns) {
      if (!col.shadowRoot) continue;
      const spans = col.shadowRoot.querySelectorAll<HTMLSpanElement>('span[data-source-offset]');
      for (const span of spans) {
        const offset = parseInt(span.dataset.sourceOffset!, 10);
        if (offset >= start && offset < start + len) {
          span.style.textDecoration = 'underline';
          span.style.textUnderlineOffset = '2px';
        }
      }
    }
    this._compositionUnderlineApplied = true;
  }

  /**
   * 조합 종료 후 모든 span에서 밑줄 스타일을 제거한다.
   *
   * renderText의 diff 기반 span 재사용으로 밑줄이 남아 있을 수 있으므로
   * 명시적으로 제거해야 한다.
   */
  private _clearCompositionUnderline(): void {
    const columns = this._paragraph.querySelectorAll('x-layout-column');
    for (const col of columns) {
      if (!col.shadowRoot) continue;
      const spans = col.shadowRoot.querySelectorAll<HTMLSpanElement>('span[data-source-offset]');
      for (const span of spans) {
        if (span.style.textDecoration) {
          span.style.textDecoration = '';
        }
        if (span.style.textUnderlineOffset) {
          span.style.textUnderlineOffset = '';
        }
      }
    }
    this._compositionUnderlineApplied = false;
  }

  private _computeTextChange(
    before: string,
    after: string,
    cursorOffset: number,
  ): { type: "insert" | "delete" | "replace"; text: string; newOffset: number; deletedText: string } {
    if (before === after) {
      return { type: "insert", text: "", newOffset: cursorOffset, deletedText: "" };
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
      deletedText: removed,
    };
  }

  private _optimisticSpanUpdate(sourceOffset: number, char: string): void {
    if (this._optimisticSpan && this._optimisticSpan.parentNode) {
      this._shiftFollowingSpans(this._optimisticSpan, -this._optimisticSpanWidthMm);
      this._optimisticSpan.remove();
    }
    this._optimisticSpan = null;
    this._optimisticSpanWidthMm = 0;
    this._mapper.invalidateSpanCache();

    if (!this._paragraph.model) return;

    const textContent = this._paragraph.model.textContent;
    if (typeof textContent !== "string") return;

    const placement = this._mapper.getCursorPlacement(sourceOffset);

    // placement가 null: \n 바로 다음(새 라인 시작)이거나 빈 줄 시작.
    // 새 라인 시작인 경우 line div 첫 자식으로 삽입.
    if (!placement) {
      if (sourceOffset > 0 && textContent[sourceOffset - 1] === '\n') {
        this._insertOptimisticSpanAtLineStart(char, sourceOffset);
      }
      return;
    }

    const span = this._mapper.getSpanByOffset(placement.sourceOffset);
    if (!span) return;

    const newSpan = this._createOptimisticSpan(char, sourceOffset);
    const leftMm = this._computeTempSpanLeft(span, placement.atEndOfChar);
    if (leftMm !== undefined) {
      newSpan.style.position = 'absolute';
      newSpan.style.left = `${leftMm}mm`;
      newSpan.style.top = '0';
    }
    if (placement.atEndOfChar) {
      span.after(newSpan);
    } else {
      span.before(newSpan);
    }
    // 후속 span들을 임시 span 폭만큼 밀어냄
    const widthMm = this._computeTempSpanWidthMm(char);
    this._shiftFollowingSpans(newSpan, widthMm);
    this._optimisticSpanWidthMm = widthMm;
    this._optimisticSpan = newSpan;
  }

  /**
   * 임시 span(optimistic/composition)에 부여할 `left` 오프셋(mm)을 계산한다.
   *
   * charOffsets 경로(absolute 배치)에서는 임시 span이 기존 span을 밀어낼 수 없으므로,
   * 삽입 위치 기준 span의 `data-char-offset`과 `data-swidth`로부터 새 span의 x 좌표를 산출한다.
   *
   * 삽입 케이스:
   *  - `atEndOfChar === true`: 기존 span 이후 → `offset + swidth`
   *  - `atEndOfChar === false`: 기존 span 이전 → `offset` (기존 span의 위치를 임시 span이 차지)
   *  - 기준 span 없음(빈 파트/라인 시작): `0`
   *
   * @param anchorSpan - 삽입 기준 span (placement.sourceOffset의 span)
   * @param atEndOfChar - 기존 span의 끝에 삽입 여부
   * @returns `left` 오프셋(mm). charOffsets 경로가 아니면 `undefined`.
   */
  private _computeTempSpanLeft(anchorSpan: HTMLSpanElement | null, atEndOfChar: boolean): number | undefined {
    if (!anchorSpan) return 0;
    const offsetStr = anchorSpan.dataset.charOffset;
    if (offsetStr === undefined) return undefined;
    const offset = parseFloat(offsetStr);
    if (Number.isNaN(offset)) return undefined;
    if (!atEndOfChar) return offset;
    const swidthStr = anchorSpan.dataset.swidth;
    if (swidthStr === undefined) return offset;
    const swidth = parseFloat(swidthStr);
    if (Number.isNaN(swidth)) return offset;
    return offset + swidth;
  }

  /**
   * charOffsets 경로에서 임시 span 삽입/갱신 후 같은 파트 내 후속 span들의 `left`를 밀어낸다.
   *
   * absolute 배치에서는 in-flow 밀어내기가 불가능하므로, 임시 span의 폭 변화량만큼
   * 후속 span들의 `left`와 `data-char-offset`을 수동으로 이동시켜야 한다.
   * 그렇지 않으면 임시 span이 기존 글자 위에 겹쳐 보인다.
   *
   * @param tempSpan - 삽입된 임시 span
   * @param deltaMm - 이동량(mm). 양수=밀어내기, 음수=되돌리기, 0=불필요.
   */
  private _shiftFollowingSpans(tempSpan: HTMLSpanElement, deltaMm: number): void {
    if (deltaMm === 0) return;
    const partDiv = tempSpan.parentElement;
    if (!partDiv) return;

    let sibling = tempSpan.nextElementSibling as HTMLSpanElement | null;
    while (sibling) {
      if (sibling.dataset.charOffset !== undefined) {
        const curOffset = parseFloat(sibling.dataset.charOffset);
        if (!Number.isNaN(curOffset)) {
          const newOffset = curOffset + deltaMm;
          sibling.dataset.charOffset = String(newOffset);
          sibling.style.left = `${newOffset}mm`;
        }
      }
      sibling = sibling.nextElementSibling as HTMLSpanElement | null;
    }
  }

  /**
   * 임시 span의 폭(mm)을 계산한다.
   * 조합 중인 텍스트의 각 글자에 대해 `getCharWidths().swidth`를 합산.
   *
   * @param text - 임시 span에 표시되는 텍스트 (조합 중인 문자열)
   * @returns 폭(mm). 빈 문자열이면 0.
   */
  private _computeTempSpanWidthMm(text: string): number {
    if (!text) return 0;
    const model = this._paragraph.model;
    if (!model) return 0;
    let total = 0;
    for (const ch of text) {
      const { swidth } = model.getCharWidths(ch);
      total += swidth;
    }
    return total;
  }

  private _createOptimisticSpan(char: string, sourceOffset: number): HTMLSpanElement {
    const model = this._paragraph.model;
    const span = document.createElement('span');
    span.dataset.sourceOffset = String(sourceOffset);
    span.dataset.temporary = "true";
    const charStyle = model?.genCharStyleFlat(char);
    if (charStyle) {
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(span.style, charStyle);
    }
    span.textContent = char;
    return span;
  }

  /**
   * \n 바로 다음 위치(새 라인 시작)에 optimistic span을 삽입한다.
   *
   * sourceOffset이 속한 라인의 line div를 찾아, 그 div의 첫 자식으로
   * optimistic span을 삽입한다. 빈 라인인 경우 line div 자체를 생성하여
   * 컬럼에 추가한 뒤 span을 삽입한다.
   *
   * @param char - 삽입할 문자
   * @param sourceOffset - 새 문자의 소스 오프셋 (\n 바로 다음)
   * @throws - model이 없으면 아무 동작도 하지 않음
   * @returns - 없음 (void)
   *
   * @example
   * // 텍스트가 "가나\n" 이고 커서가 \n 다음(sourceOffset=3)에 있을 때
   * // '다' 입력 → _insertOptimisticSpanAtLineStart('다', 3)
   * // → 새 라인의 line div 첫 자식으로 '다' span 삽입
   */
  private _insertOptimisticSpanAtLineStart(char: string, sourceOffset: number): void {
    const lineInfo = this._mapper.getLineInfoBySourceOffset(sourceOffset);
    if (!lineInfo) return;

    const columns = this._paragraph.querySelectorAll('x-layout-column');
    const column = columns[lineInfo.columnIndex];
    if (!column || !column.shadowRoot) return;

    const lineDivs = Array.from(column.shadowRoot.children).filter(
      (child): child is HTMLDivElement => child.tagName === 'DIV',
    );
    const lineDiv = lineDivs[lineInfo.lineIndex];
    if (lineDiv) {
      const partDiv = lineDiv.querySelector('div');
      const container = partDiv instanceof HTMLElement ? partDiv : lineDiv;
      const newSpan = this._createOptimisticSpan(char, sourceOffset);
      // 라인 시작 삽입 — 파트 첫 자식이므로 offset 0
      newSpan.style.position = 'absolute';
      newSpan.style.left = '0mm';
      newSpan.style.top = '0';
      container.insertBefore(newSpan, container.firstChild);
      // 후속 span들을 임시 span 폭만큼 밀어냄
      const widthMm = this._computeTempSpanWidthMm(char);
      this._shiftFollowingSpans(newSpan, widthMm);
      this._optimisticSpanWidthMm = widthMm;
      this._optimisticSpan = newSpan;
    }
  }

  private _debouncedRender(): void {
    if (this._debounceTimer !== null) {
      cancelAnimationFrame(this._debounceTimer);
    }
    this._wasFocused = this._isFocused;
    this._debounceTimer = requestAnimationFrame(() => {
      this._debounceTimer = null;
      this._paragraph.scheduleRender();
    });
  }

  private _updateCursorPosition(): void {
    const offset = this._cursorModel.offset;

    // overflow 시 textarea가 컨테이너 밖에 배치되어 브라우저가
    // 포커스/입력 시 스크롤을 유발하는 것을 방지하기 위해
    // textarea 위치를 paragraph visible 영역으로 클램핑.
    const scale = this._manager.scale || 1;
    const visibleHeightPx = this._paragraph.getBoundingClientRect().height / scale;
    const clampTop = (top: number): number => {
      if (visibleHeightPx <= 0) return top;
      return Math.max(0, Math.min(top, visibleHeightPx - 1));
    };

    const hasVisibleSelection = this._cursorModel.selection !== null &&
      this._cursorModel.selection.anchor.textOffset !== this._cursorModel.selection.focus.textOffset;
    const cursorVisible = this._isFocused && !hasVisibleSelection;

    if (this._optimisticSpan && this._optimisticSpan.parentNode) {
      const spanRect = this._optimisticSpan.getBoundingClientRect();
      const paragraphRect = this._paragraph.getBoundingClientRect();
      const localLeft = (spanRect.left - paragraphRect.left) / scale;
      const visualWidth = spanRect.width / scale;
      const widthRatio = this._paragraph.model?.widthRatio ?? 1;
      const layoutWidth = widthRatio > 0 ? visualWidth / widthRatio : visualWidth;
      const layoutRight = localLeft + layoutWidth;
      this._cursorEl.top = (spanRect.top - paragraphRect.top) / scale;
      this._cursorEl.left = layoutRight;
      this._cursorEl.height = spanRect.height / scale;
      this._cursorEl.visible = cursorVisible;
      this._textarea.style.top = `${clampTop((spanRect.top - paragraphRect.top) / scale)}px`;
      this._textarea.style.left = `${localLeft}px`;
      return;
    }

    // cross state가 커서 배치를 오버라이드하는 경우
    // 기본 조회에서 preferLineEnd=true: 라인 끝 문자 다음 offset에서 phantom end placement를 우선하여
    // 커서가 라인 끝 문자의 오른쪽에 배치되도록 한다.
    let placement = this._mapper.getCursorPlacement(offset, true);
    if (this._crossRightState === 'sticking') {
      // sticking: 라인 끝에 머무는 상태. 기본 placement(phantom end)를 그대로 사용한다.
      // phantom end placement가 없는 경우(trailing space 있음)는 기본 placement가 이미 atEndOfChar: true.
    } else if (this._crossRightState === 'crossed') {
      // crossed: 다음 라인 첫 글자의 왼쪽에 배치해야 하므로 preferLineEnd=false
      const curPlacement = this._mapper.getCursorPlacement(offset, false);
      if (curPlacement && curPlacement.sourceOffset === offset) {
        // 현재 offset이 가시 문자(또는 phantom end) 자체인 경우
        placement = { ...curPlacement, atEndOfChar: false };
      } else {
        // 현재 offset이 trailing space 등 다른 문자를 참조하는 경우:
        // 다음 라인 첫 글자를 찾아 배치한다.
        const nextPlacement = this._mapper.getCursorPlacement(offset + 1);
        if (nextPlacement) {
          placement = { ...nextPlacement, atEndOfChar: false };
        } else if (curPlacement) {
          placement = { ...curPlacement, atEndOfChar: false };
        }
      }
    } else if (this._crossLeftState === 'crossed' && offset > 0) {
      // crossed: 이전 라인 끝 글자 뒤에 배치.
      // offset은 라인 시작이고 phantom end placement가 offset에 설정되어 있으므로
      // getCursorPlacement(offset, true)로 조회하여 이전 라인 끝 글자 뒤에 배치한다.
      const curPlacement = this._mapper.getCursorPlacement(offset, true);
      if (curPlacement && curPlacement.atEndOfChar === true) {
        placement = curPlacement;
      } else {
        const prevPlacement = this._mapper.getCursorPlacement(offset - 1);
        if (prevPlacement) placement = prevPlacement;
      }
    } else if (this._crossLeftState === 'sticking') {
      const curPlacement = this._mapper.getCursorPlacement(offset, false);
      if (curPlacement) placement = { ...curPlacement, atEndOfChar: false };
    }

    // placement가 없는 경우(빈 줄 시작, offset=0 등): line rect 또는 first column rect 사용
    if (!placement) {
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
          this._cursorEl.visible = cursorVisible;
          this._textarea.style.top = `${clampTop(lineRect.top)}px`;
          this._textarea.style.left = `${left}px`;
          return;
        }
      }

      if (offset === 0) {
        const firstCol = this._mapper.getFirstColumnRect();
        if (firstCol) {
          this._cursorEl.top = firstCol.top;
          this._cursorEl.left = firstCol.left;
          this._cursorEl.height = firstCol.fontSize;
          this._cursorEl.visible = cursorVisible;
          this._textarea.style.top = `${clampTop(firstCol.top)}px`;
          this._textarea.style.left = `${firstCol.left}px`;
          return;
        }
      }

      this._cursorEl.visible = false;
      return;
    }

    const rect = this._mapper.getCharRect(placement.sourceOffset);
    if (!rect) {
      this._cursorEl.visible = false;
      return;
    }

    const useFallback = rect.height <= 1;
    const cursorHeight = useFallback ? (this._mapper.getFirstColumnRect()?.fontSize ?? rect.height) : rect.height;
    const cursorTop = useFallback ? this._resolveFallbackTop(placement.sourceOffset, cursorHeight) : rect.top;
    this._cursorEl.top = cursorTop;

    this._cursorEl.left = placement.atEndOfChar ? rect.left + rect.width : rect.left;
    this._cursorEl.height = cursorHeight;
    this._cursorEl.visible = cursorVisible;

    this._textarea.style.top = `${clampTop(rect.top)}px`;
    this._textarea.style.left = `${rect.left}px`;
  }

  /**
   * 공백 등 height≈0인 span에서 커서 top을 결정한다.
   *
   * 우선순위:
   * 1. 인접한 일반 문자(sourceOffset ± 1)의 `rect.top` — 같은 라인에 가시 문자가 있으면 가장 정확
   * 2. sourceOffset이 속한 라인 div의 `getLineRect().top` — 라인 div는 height≈0 span과 무관하게
   *    `lineHeight` 높이를 가지므로 올바른 top을 반환
   * 3. `getCharRect(sourceOffset).top` — height≈0 span이라도 top은 라인 상단과 거의 일치
   * 4. `getFirstColumnRect().top` — 빈 단락 등의 최종 폴백
   *
   * @param sourceOffset - 커서가 참조하는 source offset (placement.sourceOffset)
   * @param cursorHeight - 폴백 없을 때 사용할 커서 높이 (현재 사용하지 않음, 시그니처 호환 유지)
   * @returns 커서 top (paragraph local coordinate, 픽셀)
   * @example
   * // offset 1715가 height=0인 스페이스 span이고, 같은 라인에 '다'(1713)가 있으면
   * // '다'의 rect.top(368)을 반환한다.
   * const top = this._resolveFallbackTop(1715, 15);
   */
  private _resolveFallbackTop(sourceOffset: number, _cursorHeight: number): number {
    // 1. 인접한 일반 문자의 top 사용
    const offsets = [sourceOffset - 1, sourceOffset + 1];
    for (const off of offsets) {
      if (off < 0) continue;
      const neighborRect = this._mapper.getCharRect(off);
      if (neighborRect && neighborRect.height > 1) {
        return neighborRect.top;
      }
    }

    // 2. sourceOffset이 속한 라인 div의 top 사용
    // height≈0 span은 같은 라인의 가시 문자와 동일한 라인 div에 속하므로
    // 라인 div의 top이 정확한 커서 top이다.
    const lineInfo = this._mapper.getLineInfoBySourceOffset(sourceOffset);
    if (lineInfo) {
      const lineRect = this._mapper.getLineRect(lineInfo.columnIndex, lineInfo.lineIndex);
      if (lineRect && lineRect.height > 0) {
        return lineRect.top;
      }
    }

    // 3. height≈0 span 자체의 rect.top 사용
    // 라인 div를 찾지 못한 경우, span 자체의 top은 라인 상단과 거의 일치한다.
    const rect = this._mapper.getCharRect(sourceOffset);
    if (rect && rect.top >= 0) {
      return rect.top;
    }

    // 4. 빈 단락 등의 최종 폴백
    const firstCol = this._mapper.getFirstColumnRect();
    return firstCol?.top ?? 0;
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
   * 뷰포트 좌표(x, y)에서 가장 가까운 텍스트 위치의 소스 오프셋을 반환한다.
   *
   * 더블클릭 등 외부 이벤트에서 클릭 위치를 커서 오프셋으로 변환할 때 사용한다.
   * 내부적으로 `TextEditCoordinateMapper.getNearestOffsetFromPoint()`를 호출한다.
   *
   * @param x - 뷰포트 기준 x 좌표 (clientX)
   * @param y - 뷰포트 기준 y 좌표 (clientY)
   * @returns 가장 가까운 텍스트 위치의 소스 오프셋. 매핑할 수 없으면 `null`
   *
   * @example
   * ```ts
   * const offset = controller.getOffsetFromPoint(event.clientX, event.clientY);
   * if (offset !== null) {
   *   controller.setCursor({ textOffset: offset });
   *   controller.focus();
   * }
   * ```
   */
  getOffsetFromPoint(x: number, y: number): number | null {
    const result = this._mapper.getNearestOffsetFromPoint(x, y);
    return result ? result.textOffset : null;
  }

  /**
   * 외부에서 커서 위치를 설정할 때 사용한다.
   * @param position - 커서 위치. textOffset은 0 이상 model.textContent.length 이하로 클램핑된다.
   * @throws - model이 없으면 아무 동작도 하지 않음
   * @returns - 없음 (void)
   *
   * @example
   * controller.setCursor({ textOffset: 5 });
   * controller.focus();
   */
  setCursor(position: CursorPosition): void {
    const textContent = this._paragraph.model?.textContent;
    let maxOffset = 0;
    if (typeof textContent === 'string') {
      maxOffset = textContent.length;
    } else if (Array.isArray(textContent)) {
      maxOffset = textContent.reduce((sum, item) => sum + (typeof item === 'string' ? item.length : item.content.length), 0);
    }
    this._cursorModel.offset = Math.max(0, Math.min(position.textOffset, maxOffset));
    this._syncTextareaSelection();
    this._updateCursorPosition();
    this._emitStyleChange();
    this._manager._notifyCursorMove(this);
  }

  /**
   * 외부에서 선택 영역을 설정할 때 사용한다.
   * T14 이후 선택 핸들러에서 사용될 예정.
   */
  setSelection(range: SelectionRange): void {
    this._cursorModel.selection = range;
    this._syncTextareaSelection();
    this._updateSelection();
    this._emitStyleChange();
    this._manager._notifyCursorMove(this);
  }

  /**
   * 현재 커서 위치의 스타일이 이전과 다를 때만 styleChange 이벤트를 발생시킨다.
   */
  private _emitStyleChange(): void {
    const current = this.currentStyle;
    const json = JSON.stringify(current);
    if (json !== this._lastStyleJson) {
      this._lastStyleJson = json;
      this._manager._notifyStyleChange(this);
    }
  }

  /**
   * 텍스트/문단 스타일 주입의 단일 진입점.
   *
   * 커서/선택 상태에 따라 주입 대상을 라우팅한다:
   * 1. selection 있음 → 선택 범위에 인라인 가능 필드를 주입 (`applyStyleToRange`,
   *    기존 런은 필드 오버라이드). 인라인 불가 필드는 paragraph에 적용.
   * 2. selection 없음 + 커서가 인라인 런 안 → 해당 런만 업데이트.
   * 3. selection 없음 + 커서가 런 밖(평문) → paragraph 자체 스타일 수정
   *    + 명시 주입 필드를 모든 인라인 런에 캐스케이드.
   *
   * 처리 후 런 맵을 정규화하고(문단 기본과 동일한 런 해제 + 병합),
   * 커서/selection 위치를 보존한다. 텍스트 길이는 변하지 않으므로 오프셋은 불변.
   *
   * @param textPatch - 적용할 TextStyle 부분 객체
   * @param paragraphPatch - 적용할 ParagraphStyle 부분 객체
   */
  _applyTextStyle(textPatch: Partial<TextStyle>, paragraphPatch: Partial<ParagraphStyle>): void {
    const model = this._paragraph.model;
    if (!model) return;

    const INLINE_FIELDS = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "color"] as const;

    // 상속 회귀(inherit revert) 규칙:
    // - patch 필드 값 === inheritStyle 같은 필드 → 오버라이드를 만들지 않고 기존 오버라이드 제거
    // - patch 필드 값 === undefined → 해당 필드 오버라이드 제거 의미
    // 두 경우 모두 런 맵에서 필드를 delete하고, paragraph 자체 스타일에서는
    // 명시 필드가 inheritStyle과 같으면 새로 저장하지 않는다.
    const inheritStyle = model.inheritStyle as Record<string, unknown> | undefined;
    const resolvedTextPatch = resolvePatchAgainstInherit(
      textPatch as Record<string, unknown>,
      inheritStyle,
    ) as Partial<TextStyle>;
    const resolvedParagraphPatch = resolvePatchAgainstInherit(
      paragraphPatch as Record<string, unknown>,
      inheritStyle,
    ) as Partial<ParagraphStyle>;

    const revertTextFields: string[] = [];
    for (const field of INLINE_FIELDS) {
      // '명시적으로 undefined를 전달한' 필드만 오버라이드 제거 대상이다.
      // Partial 객체의 미정의 필드도 undefined이므로 hasOwnProperty로 구분하지 않으면
      // patch에 없는 모든 인라인 필드가 전체 런에서 삭제되는 재앙이 발생한다.
      const isExplicitlyPassed = Object.prototype.hasOwnProperty.call(textPatch, field);
      if (!isExplicitlyPassed) continue;
      if (textPatch[field] === undefined || textPatch[field] === inheritStyle?.[field]) {
        revertTextFields.push(field);
      }
    }

    const inlinePatch: Partial<TextInlineStyle> = {};
    for (const field of INLINE_FIELDS) {
      if (resolvedTextPatch[field] !== undefined) {
        (inlinePatch as Record<string, unknown>)[field] = resolvedTextPatch[field];
      }
    }

    const hasParagraphPatch = Object.keys(resolvedParagraphPatch).length > 0;
    const hasInlinePatch = Object.keys(inlinePatch).length > 0;

    const offset = this._cursorModel.offset;
    const savedSelection = this._cursorModel.selection;

    const hasSelection = savedSelection !== null &&
      savedSelection.normalized().start.textOffset < savedSelection.normalized().end.textOffset;

    const cursorRunStyle = getStyleAtOffset(this._runMap, offset);

    // paragraph 자체 스타일 갱신 — DOM element setter 사용.
    // 엔진 직접 수정 시 직후 render의 layout()이 DOM element의 구값으로
    // 엔진을 되돌려 덮어쓴다 (엔진 우선 단일 소스 흐름 유지).
    //
    // 중요: 인라인 가능 필드(fontFamily 등)의 paragraph 반영은 런 밖(캐스케이드) 경로에서만
    // 수행한다. selection/런-안 경로의 의미는 "그 영역에만 적용"이므로 paragraph 기본을
    // 바꾸면 effectiveTextStyle이 런 값과 동일해져 normalizeRunMap이 런을 해제해버린다.
    // 인라인 불가 필드(textAlign/lineGap/verticalAlign/letterSpacing/widthRatio)는
    // 항상 paragraph 소속이므로 selection이 있어도 paragraph에 반영한다.
    const paragraphOnlyTextPatch: Partial<TextStyle> = {};
    for (const key of Object.keys(resolvedTextPatch)) {
      const isInlineField = (INLINE_FIELDS as readonly string[]).includes(key);
      if (!hasSelection || !isInlineField) {
        (paragraphOnlyTextPatch as Record<string, unknown>)[key] = resolvedTextPatch[key as keyof TextStyle];
      }
    }
    if (Object.keys(paragraphOnlyTextPatch).length > 0) {
      this._paragraph.textStyle = { ...model.textStyle, ...paragraphOnlyTextPatch };
    }
    if (hasParagraphPatch) {
      this._paragraph.paragraphStyle = { ...model.paragraphStyle, ...resolvedParagraphPatch };
    }

    // 상속 회귀로 제거할 인라인 필드가 있으면 전체 런 맵에서 제거한다
    if (revertTextFields.length > 0) {
      this._runMap = stripRunFields(this._runMap, revertTextFields);
    }

    if (hasSelection && hasInlinePatch) {
      // 1. selection 있음 → 선택 범위 인라인 주입 (기존 런은 필드 오버라이드)
      const { start, end } = savedSelection!.normalized();
      this._runMap = applyStyleToRange(this._runMap, start.textOffset, end.textOffset, inlinePatch);
      // 주입으로 문단 기본과 동일해진 필드를 제거한다 — 예: 런 fontWeight가 700,
      // 문단 기본이 500일 때 선택 영역에 500을 주입하면 fontWeight 필드는
      // 기본을 따르는 중복이므로 제거되어 인접 런과 병합될 수 있다.
      const paragraphTextStyle = model.effectiveTextStyle;
      for (const entry of this._runMap) {
        if (!entry.style) continue;
        for (const field of INLINE_FIELDS) {
          if (entry.style[field] === paragraphTextStyle[field]) {
            delete entry.style[field];
          }
        }
      }
    } else if (!hasSelection && cursorRunStyle !== undefined && hasInlinePatch) {
      // 2. 커서가 인라인 런 안 → 해당 런만 업데이트
      const run = this._runMap.find(r => r.start <= offset && r.end > offset && r.style === cursorRunStyle);
      if (run && run.style) {
        run.style = { ...run.style, ...inlinePatch };
        this._runMap = mergeAdjacentSameStyle(this._runMap);
      }
    } else if (hasInlinePatch) {
      // 3. 커서가 런 밖 → 명시 주입 필드를 모든 인라인 런에 캐스케이드
      const paragraphTextStyle = model.effectiveTextStyle;
      for (const entry of this._runMap) {
        if (entry.style) {
          entry.style = { ...entry.style, ...inlinePatch };
          for (const field of INLINE_FIELDS) {
            if (entry.style[field] === paragraphTextStyle[field]) {
              delete entry.style[field];
            }
          }
        }
      }
    }

    // 정규화: 문단 기본과 동일한 런 해제 + 인접 병합
    this._runMap = normalizeRunMap(this._runMap, model.effectiveTextStyle);

    model.textContent = plainToInline(this._textarea.value, this._runMap);
    // textContent setter가 _dirty만 설정하므로 styleChange/textChange 리스너가
    // extractData를 읽기 전에 커밋(layoutText)이 선행해야 한다 (dirty 가드 throw 방지).
    this._paragraph.flushRender();

    // 커서/selection 복원 (길이 불변이므로 오프셋 유효)
    this._cursorModel.offset = offset;
    this._cursorModel.selection = savedSelection;
    this._syncTextareaSelection();
    this._updateCursorPosition();
    this._updateSelection();

    this._emitStyleChange();
    this._manager._notifyTextChange(this);
  }

  /**
   * 현재 런 맵을 문단 유효 텍스트 스타일 기준으로 정규화하여 content에 반영한다.
   *
   * 문단 기본과 동일한 런 해제 + 인접 동일 런 병합. 텍스트 길이가 변하지 않으므로
   * 커서/selection 오프셋은 그대로 유효하다. 포커스 획득/blur 시 호출된다.
   */
  normalizeNow(): void {
    const model = this._paragraph.model;
    if (!model) return;

    const offset = this._cursorModel.offset;
    const savedSelection = this._cursorModel.selection;

    const before = JSON.stringify(this._runMap);
    this._runMap = normalizeRunMap(this._runMap, model.effectiveTextStyle);
    if (JSON.stringify(this._runMap) === before) return;

    model.textContent = plainToInline(this._textarea.value, this._runMap);
    this._paragraph.flushRender();

    this._cursorModel.offset = offset;
    this._cursorModel.selection = savedSelection;
    this._syncTextareaSelection();
    this._updateCursorPosition();
    this._updateSelection();
    this._emitStyleChange();
  }

  /**
   * 현재 선택 영역에 인라인 스타일을 적용한다.
   *
   * 선택 영역이 있으면 해당 범위의 런들을 분할하여 스타일을 오버라이드하고,
   * 엔진 content를 갱신하여 재렌더링을 트리거한다.
   * 선택 영역이 없으면 아무 동작도 하지 않는다.
   *
   * @param style - 적용할 인라인 스타일 (부분 객체 — 정의된 필드만 오버라이드)
   */
  _applyInlineStyle(style: Partial<TextInlineStyle>): void {
    const sel = this._cursorModel.selection;
    if (!sel) return;

    const { start, end } = sel.normalized();
    if (start.textOffset >= end.textOffset) return;

    this._runMap = applyStyleToRange(this._runMap, start.textOffset, end.textOffset, style);

    const model = this._paragraph.model;
    if (!model) return;

    const plainText = this._textarea.value;
    model.textContent = plainToInline(plainText, this._runMap);
    this._paragraph.flushRender();
    this._emitStyleChange();
    this._manager._notifyTextChange(this);
  }

  /**
   * 현재 선택 영역의 인라인 스타일 필드를 토글한다.
   *
   * 선택 영역 전체가 이미 해당 값이면 제거(기본 복귀), 아니면 적용한다.
   *
   * @param field - 토글할 TextInlineStyle 필드명
   * @param value - 적용할 값
   */
  _toggleInlineStyle<K extends keyof TextInlineStyle>(field: K, value: NonNullable<TextInlineStyle[K]>): void {
    const sel = this._cursorModel.selection;
    if (!sel) return;

    const { start, end } = sel.normalized();
    if (start.textOffset >= end.textOffset) return;

    let allMatch = true;
    for (let i = start.textOffset; i < end.textOffset; i++) {
      const s = getStyleAtOffset(this._runMap, i);
      if (!s || s[field] !== value) { allMatch = false; break; }
    }

    if (allMatch) {
      this._runMap = applyStyleToRange(this._runMap, start.textOffset, end.textOffset, { [field]: undefined } as Partial<TextInlineStyle>);
    } else {
      this._runMap = applyStyleToRange(this._runMap, start.textOffset, end.textOffset, { [field]: value } as Partial<TextInlineStyle>);
    }

    const model = this._paragraph.model;
    if (!model) return;

    const plainText = this._textarea.value;
    model.textContent = plainToInline(plainText, this._runMap);
    this._paragraph.flushRender();
    this._emitStyleChange();
    this._manager._notifyTextChange(this);
  }
}

/**
 * 커서/선택의 내부 상태.
 */
interface CursorModel {
  offset: number;
  selection: SelectionRange | null;
}
