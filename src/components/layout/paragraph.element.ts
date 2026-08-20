import { TextEditController } from "@/edit/text-edit-controller";
import { EditManager } from "@/edit/edit-manager";
import { DEFAULT_LINE_GAP } from "@/constants";
import { ColorRegistry, FontLoader } from "@/resource";
import { InheritStyle, ParagraphData, ParagraphOverlapMode, ParagraphStyle, PrintPostData, PrintPostDataChar, RenderCompleteEventDetail, TextBlockData, TextStyle } from "@/types";
import { genUUID, valueEqual, createAiProcessingOverlay, setAiProcessingActive, isAiProcessingActive, removeAiProcessingOverlay } from "@/utils";
import { checkOverlapMm } from "@/engine";
import { LayoutBoxElement } from "./box.element";
import { LayoutImageElement } from "./image.element";
import { LayoutColumnElement } from "./column.element";
import { LayoutDocumentElement } from "./document.element";
import { ParagraphEngine } from "@/engine";
import type { ParagraphEngineData } from "@/engine";

/**
 * 다중 컬럼 텍스트 영역 요소. `<x-layout-paragraph>` 커스텀 엘리먼트.
 *
 * `ParagraphData`를 받아 `TextLayoutEngine`을 통해 텍스트 래핑을 수행하고,
 * `LayoutColumnElement`를 생성하여 각 컬럼을 렌더링한다.
 *
 * 오버플로우 발생 시 `render-error` 커스텀 이벤트를 디스패치한다.
 * 렌더링 완료 후 항상 `render-complete` 커스텀 이벤트를 디스패치하여
 * 배치된 글자/라인 수와 오버플로우 통계를 전달한다.
 */

export class LayoutParagraphElement extends HTMLElement {
  private _inheritStyle?: InheritStyle;

  private _model?: ParagraphEngine;
  private _engine?: ParagraphEngine;

  private _shadowRoot: ShadowRoot;

  private _sourceContent: string | (string | TextBlockData)[];
  private _column?: number | number[];
  private _gap?: number | number[];

  private _paragraphStyle: ParagraphStyle;
  private _textStyle: TextStyle;

  private _zIndex: number;

  private _overlapMode: ParagraphOverlapMode = 'box';

  private _editableText: boolean = false;
  private _editController: TextEditController | null = null;
  private _editManagerRef: EditManager | null = null;

  private _savedCursorOffset: number | null = null;
  private _savedSelection: import("@/types").SelectionRange | null = null;

  /** 성능 최적화: 구조 변경 여부 플래그. true면 다음 render()에서 전체 재생성을 수행한다. */
  private _perfStructureChanged: boolean = true;

  /** 성능 최적화: render() 배치 플래그. 한 마이크로태스크 내의 다중 render() 호출을 하나로 통합한다. */
  private _renderScheduled: boolean = false;

  /**
   * 오버플로우 시각 표시기 활성화 여부. `render()`에서 텍스트 오버플로우가
   * 감지되면 `true`로 설정되어 하단 8px 빨간 inset shadow가 표시된다.
   * 인쇄 모드에서는 항상 `false`이다.
   */
  private _hasOverflow: boolean = false;

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });

    this._sourceContent = "";
    this._paragraphStyle = {};
    this._textStyle = {};
    this._zIndex = 0;
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    this._editManagerRef = this.editManager;
    this.layout();
    createAiProcessingOverlay(this._shadowRoot);
    if (this._editableText && !this._editController) {
      this._editController = this._editManagerRef ? new TextEditController(this, this._editManagerRef) : null;
      if (this._editController && this._savedCursorOffset !== null) {
        this._editController.setCursor({ textOffset: this._savedCursorOffset });
        if (this._savedSelection) {
          this._editController.setSelection(this._savedSelection);
        }
      }
      this._savedCursorOffset = null;
      this._savedSelection = null;
    }
  }

  /**
   * 이 paragraph가 속한 문서의 EditManager를 반환한다.
   *
   * parent 체인을 따라 올라가 `LayoutDocumentElement.editManager`를 발견한다.
   * 문서에 연결되지 않은 경우 `null`을 반환한다.
   *
   * @returns 소속 문서의 EditManager. 문서에 연결되지 않았으면 `null`.
   */
  get editManager(): EditManager | null {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el instanceof LayoutBoxElement) {
        const boxManager = el.editManager;
        if (boxManager) return boxManager;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * 이 paragraph에 연결된 ParagraphEngine 인스턴스를 반환한다.
   *
   * @returns ParagraphEngine 인스턴스. 연결 전이면 undefined.
   */
  get engine(): ParagraphEngine | undefined { return this._engine; }

  disconnectedCallback() {
    removeAiProcessingOverlay(this._shadowRoot);
    if (this._editController) {
      this._savedCursorOffset = this._editController.cursorOffset;
      this._savedSelection = this._editController.selection;
      this._editController.destroy();
      this._editController = null;
    }
    this._editManagerRef = null;
    // 엔진을 부모 childEngines에서 splice하지 않는다 — box.element.ts 참조.
    // DocumentEngine._buildTree()가 전체 트리를 재구축하므로 불필요하며,
    // 기존 엔진을 유지하는 편이 재사용 측면에서 더 효율적이다.
  }

  /**
   * 구조 계산: ParagraphEngine 데이터 할당 및 모델 생성/갱신.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected || !this.parentModel || !this._inheritStyle) return;

    const docEl = this._findDocumentElement();
    const resources = docEl?.engine?.resources;
    if (!resources) return;

    const parentBox = this.parentElement;
    if (!parentBox) return;

    const parentBoxEngine = parentBox.engine;
    const existing = parentBoxEngine?.childEngines.find(e => e instanceof ParagraphEngine);
    if (existing && this._model !== existing) {
      this._model = existing;
    }

    const overlayBoxEngines: import("@/engine").BoxEngine[] = parentBoxEngine
      ? parentBoxEngine.overlayElements
      : [];

    const engineData: ParagraphEngineData = {
      content: this._model?.textContent ?? this._sourceContent,
      column: this._column !== undefined ? this._column : this.parentModel.columnWidth,
      gap: this._gap !== undefined ? this._gap : this.parentModel.gaps,
      paragraphStyle: this.paragraphStyle,
      textStyle: this.textStyle,
      inheritStyle: {
        ...this._inheritStyle,
        parentHeight: this.absHeight,
        parentWidth: this.absWidth,
      },
      overlayEngines: overlayBoxEngines,
      parentAbsRect: {
        absLeft: parentBox.absLeft,
        absTop: parentBox.absTop,
        absWidth: parentBox.absWidth,
        absHeight: parentBox.absHeight,
      },
      resources,
    };

    if (!this._model) {
      this._model = ParagraphEngine.create(engineData);
      if (parentBoxEngine) {
        parentBoxEngine.childEngines = [...parentBoxEngine.childEngines, this._model];
      }
    } else {
      this._model.data = engineData;
    }

    this._engine = this._model;

    this._perfStructureChanged = true;
  }

  private _findDocumentElement(): LayoutDocumentElement | null {
    let el: Element | null = this.parentElement;
    while (el) {
      if (el instanceof LayoutDocumentElement) return el;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * CSS 스타일 적용: `:host` 규칙 생성 및 단락 위치/크기 스타일 갱신.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _applyStyle() {
    if (!this.isConnected || !this.parentModel || !this._inheritStyle) return;

    const color = this.textStyle.color || this._inheritStyle.color;
    const fontFamily = this.textStyle.fontFamily || this._inheritStyle.fontFamily;
    const fontWeight = this.textStyle.fontWeight || this._inheritStyle.fontWeight;
    const fontStyle = this.textStyle.fontStyle || this._inheritStyle.fontStyle;
    const fontSize = this.textStyle.fontSize ?? this._inheritStyle.fontSize;
    const paddingTop = this._inheritStyle.paddingTop || 0;

    const colorRegistry = ColorRegistry.getInstance();
    const fontLoader = FontLoader.getInstance();

    let styleEl = this._shadowRoot.querySelector('style');
    let needsInit = !styleEl
      || !styleEl.sheet
      || styleEl.sheet.cssRules.length === 0;

    if (needsInit) {
      if (styleEl) styleEl.remove();
      styleEl = document.createElement('style');
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);

      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
        (styleEl.sheet.cssRules[0] as CSSStyleRule).style,
        {
          display: 'flex',
          flexDirection: 'row',
          position: 'absolute',
          overflow: "hidden",
        }
      );
      this._shadowRoot.appendChild(document.createElement('slot'));
    }
    const hostRule = styleEl!.sheet!.cssRules[0] as CSSStyleRule;
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      hostRule.style,
      {
        color: color !== undefined ? colorRegistry.getCSSColor(color) : undefined,
        fontFamily: fontFamily !== undefined ? fontLoader.getFontFamily(fontFamily) : undefined,
        fontStyle,
        fontWeight: fontWeight ? String(fontWeight) : undefined,
        fontSize: `${fontSize}mm`,
        height: `${this.absHeight}mm`,
        left: `${this.relLeft}mm`,
        top: `${paddingTop}mm`,
        width: `${this.absWidth}mm`,
        zIndex: `${this.zIndex}`,
        boxShadow: this._hasOverflow
          ? 'inset 0 -8px 0 0 #ff0000'
          : '',
      }
    );
  }

  /**
   * 레이아웃 오케스트레이터. `_layoutStructure()`, `_applyStyle()`를
   * 순서대로 호출한다. 기존 호출자와의 호환성을 위해 유지한다.
   */
  layout() {
    if (!this.isConnected || !this.parentModel || !this._inheritStyle) return;

    this._layoutStructure();
    this._applyStyle();
  }

  /**
   * 텍스트 컬럼 렌더링: TextLayoutEngine으로 텍스트 래핑을 수행하고
   * 컬럼 DOM을 생성/갱신한다. 오버플로우 발생 시 `render-error` 이벤트를 디스패치한다.
   * 렌더링 완료 후 항상 `render-complete` 이벤트를 디스패치하여 배치/오버플로우 통계를 전달한다.
   * 오버플로우 시 하단 8px 빨간 inset shadow로 시각적 표시를 적용한다.
   */
  render() {
    if (!this.isConnected || !this._model) return;

    const manager = this._editManagerRef ?? this.editManager;
    if (manager) {
      this._model.scale = manager.scale;
    }

    const lineCountBefore = this._model.previousLineCount;
    const overflowBefore = this._model.previousOverflow;

    if (this._perfStructureChanged) {
      this._layoutStructure();
      this._model.resetIncrementalState();
      this._model.layoutStructure();
      this._model.layoutText();
      this._perfStructureChanged = false;
    } else {
      const parentBox = this.parentElement;
      if (parentBox) {
        const parentBoxEngine = parentBox.engine;
        const overlayBoxEngines: import("@/engine").BoxEngine[] = parentBoxEngine
          ? parentBoxEngine.overlayElements
          : [];
        this._model.updateOverlayContext(
          overlayBoxEngines,
          {
            absLeft: parentBox.absLeft,
            absTop: parentBox.absTop,
            absWidth: parentBox.absWidth,
            absHeight: parentBox.absHeight,
          },
          {
            ...this._inheritStyle!,
            parentHeight: this.absHeight,
            parentWidth: this.absWidth,
          },
        );
      }
      this._model.layoutText();
    }

    const renderStats = this._computeRenderStats();

    const hadOverflow = this._hasOverflow;
    const hasOverflowNow = renderStats.overflow.hasOverflow;
    if (hasOverflowNow !== hadOverflow) {
      this._hasOverflow = hasOverflowNow;
      this._applyStyle();
    }

    if (this._model.overflow > 0) {
      const event = new CustomEvent('render-error', {
        detail: { id: this.id, type: 'text-overflow', overflow: this._model.overflow },
        bubbles: true,
        composed: true,
      });
      this.dispatchEvent(event);
    }

    const lineCountAfter = this._model.columnContents.reduce((sum, col) => sum + col.length, 0);
    const overflowAfter = this._model.overflow;

    const needsFullRecreate = this._perfShouldFullRecreate(lineCountBefore, overflowBefore, lineCountAfter, overflowAfter);

    if (needsFullRecreate) {
      this.replaceChildren();

      const columnContents = this._model.columnContents;
      for (let i = 0; i < columnContents.length; i++) {
        const columnEl = document.createElement('x-layout-column');
        columnEl.index = i;

        this.appendChild(columnEl);
        columnEl.renderText();
      }
    } else {
      const columnContents = this._model.columnContents;
      const columnEls = this.querySelectorAll('x-layout-column');
      if (columnEls.length !== columnContents.length) {
        this.replaceChildren();
        for (let i = 0; i < columnContents.length; i++) {
          const columnEl = document.createElement('x-layout-column');
          columnEl.index = i;
          this.appendChild(columnEl);
        }
      } else {
        for (let i = 0; i < columnEls.length; i++) {
          (columnEls[i] as LayoutColumnElement).renderText();
        }
      }
    }

    if (this._editController) {
      this._editController.postRender(needsFullRecreate);
    }

    this.dispatchEvent(new CustomEvent('render-complete', {
      detail: renderStats,
      bubbles: true,
      composed: true,
    }));
  }

  /**
   * 성능 최적화: 전체 재생성이 필요한지 판별한다.
   *
   * 라인 수와 오버플로우가 동일하면 diff 경로로 진입하여
   * `_skipSpanStyleIfUnchanged`가 모든 span을 스킵하도록 한다. 박스 이동 시
   * Skeleton 레이아웃 캐시가 히트하면 `columnContents`가 동일 → 라인 수/오버플로우
   * 불변 → diff 렌더링으로 매 프레임 `replaceChildren()` + 전체 span 재생성을 회피.
   *
   * 단, `lineCountBefore === -1`(초기 렌더 또는 `resetIncrementalState()` 직후)은
   * 항상 전체 재생성이 필요하다 — 이전 상태가 없으므로 diff 비교가 불가능하다.
   *
   * @param lineCountBefore - 이전 렌더의 총 라인 수. `-1`이면 초기 상태.
   * @param overflowBefore - 이전 렌더의 오버플로우 문자 수.
   * @param lineCountAfter - 현재 렌더의 총 라인 수.
   * @param overflowAfter - 현재 렌더의 오버플로우 문자 수.
   * @returns `true`이면 전체 재생성(`replaceChildren()`), `false`이면 diff 렌더링.
   */
  private _perfShouldFullRecreate(
    lineCountBefore: number,
    overflowBefore: number,
    lineCountAfter: number,
    overflowAfter: number,
  ): boolean {
    return lineCountBefore === -1
      || lineCountBefore !== lineCountAfter
      || overflowBefore !== overflowAfter;
  }

  /**
   * `render()` 완료 시 `render-complete` 이벤트의 페이로드를 계산한다.
   *
   * `columnContents`를 순회하며 각 라인의 누적 높이(mm)와 컬럼 높이
   * (`inheritStyle.parentHeight`, mm)를 비교해 오버플로우 라인을 식별한다.
   * `LayoutColumnElement.renderText()`의 `display: none` 처리 로직과 동일한
   * 기준을 사용하되 DOM에 의존하지 않고 모델 데이터만으로 동작한다.
   * `textBlockStyle`에 의해 라인 높이가 오버라이드된 경우를 반영하기 위해
   * `genLineStyle()`의 height 오버라이드 규칙을 적용한다.
   *
   * @returns `RenderCompleteEventDetail` 페이로드 객체
   */
  private _computeRenderStats(): RenderCompleteEventDetail {
    const model = this._model;
    if (!model) {
      return {
        type: 'paragraph',
        id: this.id,
        placed: { chars: 0, lines: 0 },
        overflow: { hasOverflow: false, chars: 0, lines: 0 },
        columnCount: 0,
      };
    }

    const columnContents = model.columnContents;
    const columnCount = columnContents.length;
    const parentHeight = this.absHeight;
    const lineGap = this._paragraphStyle?.lineGap ?? this._inheritStyle?.lineGap ?? DEFAULT_LINE_GAP;
    const defaultLineHeight = model.lineHeight;
    const lastColumnIdx = columnCount - 1;

    let placedChars = 0;
    let placedLines = 0;
    let overflowLines = 0;
    const overflowChars = model.overflow;

    for (let c = 0; c < columnCount; c++) {
      const lines = columnContents[c] || [];
      let accumulatedHeightMm = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const fontSize = line.textBlockStyle?.fontSize;
        let lineHeightMm = defaultLineHeight;
        if (fontSize !== undefined && fontSize > 0 && defaultLineHeight < fontSize * lineGap) {
          lineHeightMm = Math.ceil((fontSize * lineGap) / defaultLineHeight) * defaultLineHeight;
        }

        const isOverflowLine = parentHeight > 0 && accumulatedHeightMm + lineHeightMm > parentHeight + 1e-6;

        if (isOverflowLine) {
          if (c === lastColumnIdx) {
            overflowLines++;
          }
        } else {
          accumulatedHeightMm += lineHeightMm;
          placedLines++;
          for (const part of line.parts) {
            placedChars += part.content.length;
          }
        }
      }
    }

    return {
      type: 'paragraph',
      id: this.id,
      placed: { chars: placedChars, lines: placedLines },
      overflow: {
        hasOverflow: overflowChars > 0 || overflowLines > 0,
        chars: overflowChars,
        lines: overflowLines,
      },
      columnCount,
    };
  }

  set data(data: ParagraphData) {
    if (data.id !== undefined) this.id = data.id;
    if (data.column !== undefined) this._column = data.column;
    if (data.gap !== undefined) this._gap = data.gap;
    if (data.textStyle !== undefined) this._textStyle = data.textStyle;
    if (data.paragraphStyle !== undefined) this._paragraphStyle = data.paragraphStyle;
    if (data.zIndex !== undefined) this._zIndex = data.zIndex;
    if (data.overlapMode !== undefined) this._overlapMode = data.overlapMode;

    this._sourceContent = data.content;
    if (this._model && data.content !== undefined) {
      const manager = this._editManagerRef ?? this.editManager;
      const isEditingThis = manager?.focusedParagraph === this;
      if (!isEditingThis) {
        this._model.textContent = data.content;
      }
    }

    this.layout();
    this._perfStructureChanged = true;
    this.scheduleRender();
  }

  /**
   * 단락의 현재 데이터를 반환한다.
   * `content`는 렌더링된 실제 텍스트를 기반으로 한다.
   * 편집 모드에서 텍스트가 수정된 경우 `model.textContent`에서
   * 현재 렌더링된 텍스트를 가져오며, 모델이 아직 생성되지 않은
   * 초기 상태에서는 세터로 전달된 원본 콘텐츠를 반환한다.
   *
   * @returns 렌더링된 텍스트가 반영된 단락 데이터
   */
  get data() {
    return {
      id: this.id,
      column: this._column,
      content: this.content,
      gap: this._gap,
      paragraphStyle: this._paragraphStyle,
      textStyle: this._textStyle,
      zIndex: this._zIndex,
      overlapMode: this._overlapMode,
      type: this.type,
    };
  }

  /**
   * 단락의 텍스트 콘텐츠를 반환한다.
   *
   * 렌더링된 실제 텍스트를 기준으로 한다. `TextEditController`로 편집 중인 경우
   * `model.textContent`를, model이 아직 생성되지 않은 초기 상태에서는
   * 세터로 전달된 원본 콘텐츠(`_sourceContent`)를 반환한다.
   *
   * @returns 렌더링된 텍스트 콘텐츠. `string` 또는 `TextBlockData[]`.
   */
  get content(): string | (string | TextBlockData)[] {
    return this._model?.textContent ?? this._sourceContent;
  }

  /**
   * 단락의 텍스트 콘텐츠를 설정한다.
   *
   * `data` setter의 `content` 갱신 경로를 캡슐화한다. 다음 상태를
   * 동시에 동기화한 뒤 재렌더링까지 한 번에 수행한다.
   *
   * 1. `_sourceContent` — model이 없는 초기 상태에서 `data` getter가
   *    반환할 폴백 콘텐츠.
   * 2. `model.textContent` — model이 이미 존재하는 경우 `layout()`의
   *    `_layoutStructure()`가 `_model.textContent ?? _sourceContent`를
   *    평가하므로, 새 텍스트를 model에도 직접 반영해야 기존 텍스트가
   *    우선되는 규칙을 덮어쓸 수 있다. `string`인 경우에만 갱신한다.
   * 3. `markStructureChangedAndRender()` — 구조 변경 플래그 설정 후
   *    `render()` 호출.
   *
   * `data` setter는 내부 필드를 직접 갱신한 뒤 자체 `layout()`을
   * 호출하므로 이 setter를 거치지 않는다 (중복 렌더링 방지).
   *
   * @param value - 새 텍스트 콘텐츠. `string` 또는 `TextBlockData[]`.
   *
   * @example
   * ```ts
   * // 외부 컨트롤러(PlaceGun, AI fit 등)에서 텍스트 주입
   * paragraph.content = '새 본문 텍스트';
   * ```
   */
  set content(value: string | (string | TextBlockData)[]) {
    this._sourceContent = value;
    if (this._model) this._model.textContent = value;
    this.markStructureChangedAndRender();
  }

  get columnEl() {
    return Array.from(this.querySelectorAll('x-layout-column'));
  }

  /**
   * 단락의 모든 단(column)을 순회하며, 텍스트가 실제로 끝나는 단 인덱스와
   * 그 단의 보이는 라인 수를 반환한다.
   *
   * 각 단의 `visibleLineCount`는 `TextLayoutEngine`이 이 단락 자체의
   * `textStyle.fontSize`와 `paragraphStyle.lineGap`을 곱해 계산한
   * `lineHeight`(mm)로 렌더링한 line div 중 `display: none`이 아닌 것의 수이다.
   * 따라서 document 기본 스타일이 아닌 단락 자체 스타일 기반의 가시 라인 수이다.
   *
   * 이 메서드는 단락의 컬럼 요소(`LayoutColumnElement.visibleLineCount`)를
   * 통해서만 가시 라인 수를 가져오므로, 외부 코드가 컬럼의 shadow DOM 내부
   * 구조(line div, span 등)를 직접 순회할 필요를 제거한다.
   *
   * @returns `{ columnIndex, visibleLineCount }` — 보이는 라인이 있는 가장 마지막
   *   단의 0-base 인덱스와 그 단의 보이는 라인 수. 단이 없거나 보이는 라인이
   *   하나도 없으면 `null`.
   * @example
   * const last = paragraph.getVisibleLineCount();
   * if (last) {
   *   console.log(`텍스트 끝: ${last.columnIndex + 1}번 단, ${last.visibleLineCount}줄`);
   * }
   */
  getVisibleLineCount(): { columnIndex: number; visibleLineCount: number } | null {
    const columns = this.columnEl;
    if (columns.length === 0) return null;

    let result: { columnIndex: number; visibleLineCount: number } | null = null;
    for (let c = 0; c < columns.length; c++) {
      const column = columns[c];
      if (!column) continue;
      const visible = column.visibleLineCount;
      if (visible > 0) {
        result = { columnIndex: c, visibleLineCount: visible };
      }
    }
    return result;
  }

  get parentElement() {
    return super.parentElement as LayoutBoxElement;
  }

  get parentModel() {
    return this.parentElement?.model;
  }

  get model() {
    return this._model;
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.layout();
    this._perfStructureChanged = true;
  }

  get inheritStyle() {
    return this._inheritStyle;
  }

  /**
   * 단락의 글자 스타일을 설정한다.
   * 스타일이 변경되면 단락의 구조 재계산과 텍스트 재렌더링을 수행한다.
   *
   * @param value - 새로운 TextStyle 객체. 기존 값과 같으면 아무 작업도 수행하지 않는다.
   */
  set textStyle(value: TextStyle) {
    if (this._textStyle === value) return;
    this._textStyle = value;
    this.layout();
    this._perfStructureChanged = true;
    this.scheduleRender();
  }

  get textStyle(): TextStyle {
    return this._textStyle;
  }

  /**
   * 단락의 문단 스타일을 설정한다.
   * 스타일이 변경되면 단락의 구조 재계산과 텍스트 재렌더링을 수행한다.
   *
   * @param value - 새로운 ParagraphStyle 객체. 기존 값과 같으면 아무 작업도 수행하지 않는다.
   */
  set paragraphStyle(value: ParagraphStyle) {
    if (this._paragraphStyle === value) return;
    this._paragraphStyle = value;
    this.layout();
    this._perfStructureChanged = true;
    this.scheduleRender();
  }

  get paragraphStyle(): ParagraphStyle {
    return this._paragraphStyle;
  }

  /**
   * 단락의 하위 컬럼 그리드 정의를 설정한다.
   * `number`는 동일 너비 컬럼 수, `number[]`는 컬럼별 명시적 너비 배열이다.
   * 값이 변경되면 단락의 구조 재계산과 텍스트 재렌더링을 수행한다.
   *
   * @param value - 새로운 컬럼 정의. `undefined`로 설정하면 부모의 컬럼 설정을 상속받는다.
   *
   * @example
   * // 3개 동일 너비 컬럼
   * paragraph.column = 3;
   *
   * @example
   * // 컬럼별 명시적 너비 (mm)
   * paragraph.column = [30, 40, 30];
   */
  set column(value: number | number[] | undefined) {
    if (valueEqual(this._column, value)) return;
    this._column = value;
    this.layout();
    this._perfStructureChanged = true;
    this.scheduleRender();
  }

  /**
   * 단락의 하위 컬럼 그리드 정의를 반환한다.
   * `undefined`이면 부모의 컬럼 설정을 상속받는다.
   *
   * @returns 컬럼 정의. `number`는 동일 너비 컬럼 수, `number[]`는 명시적 너비 배열.
   */
  get column(): number | number[] | undefined {
    return this._column;
  }

  /**
   * 단락의 하위 컬럼 간격을 설정한다.
   * `number`는 균일 간격, `number[]`는 컬럼 사이별 명시적 간격 배열이다.
   * 값이 변경되면 단락의 구조 재계산과 텍스트 재렌더링을 수행한다.
   *
   * @param value - 새로운 간격. `undefined`로 설정하면 부모의 간격 설정을 상속받는다.
   *
   * @example
   * // 모든 컬럼 사이에 3mm 간격
   * paragraph.gap = 3;
   *
   * @example
   * // 컬럼 사이별 명시적 간격 (mm)
   * paragraph.gap = [2, 4, 2];
   */
  set gap(value: number | number[] | undefined) {
    if (valueEqual(this._gap, value)) return;
    this._gap = value;
    this.layout();
    this._perfStructureChanged = true;
    this.scheduleRender();
  }

  /**
   * 단락의 하위 컬럼 간격을 반환한다.
   * `undefined`이면 부모의 간격 설정을 상속받는다.
   *
   * @returns 컬럼 간격. `number`는 균일 간격, `number[]`는 명시적 간격 배열.
   */
  get gap(): number | number[] | undefined {
    return this._gap;
  }

  get relLeft() {
    return this._inheritStyle?.paddingLeft || 0;
  }

  get relTop() {
    if (!this._inheritStyle || !this.parentModel) return 0;
    return this._inheritStyle.paddingTop || 0;
  }

  get absLeft(): number {
    return this.parentElement.absLeft + this.relLeft;
  }

  get absTop(): number {
    return this.parentElement.absTop + this.relTop;
  }

  get absWidth() {
    if (!this._inheritStyle) return 0;
    return this._inheritStyle.parentWidth;
  }

  get absHeight() {
    if (!this._inheritStyle) return 0;
    return this._inheritStyle.parentHeight;
  }

  get overlayElements() {
    // 부모의 overlayElements는 부모 box 기준으로 교차를 판정하므로,
    // paragraph 자체와 교차하지 않는 box가 포함될 수 있다.
    // paragraph 기준으로 다시 한 번 필터링한다.
    const list: LayoutBoxElement[] = this.parentElement.overlayElements
      .filter(el => {
        if (el.contentType === 'image') {
          const imgEl = el.contentElement as LayoutImageElement | null;
          if (imgEl && imgEl.overlapMode === 'none') return false;
        }
        if (el.contentType === 'paragraph') {
          const paraEl = el.contentElement as LayoutParagraphElement | null;
          if (paraEl && paraEl.overlapMode === 'none') return false;
        }
        if (el.contentType === null) {
          const paraEl = el.querySelector('x-layout-paragraph') as LayoutParagraphElement | null;
          if (paraEl && paraEl.overlapMode === 'none') return false;
        }
        return checkOverlapMm(el, this);
      });

    const self: any = this;

    let overlay = this.parentElement.items.filter(i => i.type === 'box' && i !== self && i.zIndex > this.zIndex) as LayoutBoxElement[];
    overlay = overlay.filter(i => {
      if (i.contentType === 'image') {
        const imgEl = i.contentElement as LayoutImageElement | null;
        if (imgEl && imgEl.overlapMode === 'none') return false;
      }
      if (i.contentType === 'paragraph') {
        const paraEl = i.contentElement as LayoutParagraphElement | null;
        if (paraEl && paraEl.overlapMode === 'none') return false;
      }
      if (i.contentType === null) {
        const paraEl = i.querySelector('x-layout-paragraph') as LayoutParagraphElement | null;
        if (paraEl && paraEl.overlapMode === 'none') return false;
      }
      return true;
    });
    overlay = overlay.filter(i => checkOverlapMm(i, this));

    list.push(...overlay);

    return list;
  }

  get printPostData(): PrintPostData[] {
    const docEl = this._findDocumentElement();
    const ppm = docEl?.ppm ?? 3.78;
    const model = this._model;

    if (model === undefined) {
      return [{
        data: this.data,
        rect: {
          x: this.absLeft * ppm,
          y: this.absTop * ppm,
          width: (this._inheritStyle?.parentWidth ?? 0) * ppm,
          height: (this._inheritStyle?.parentHeight ?? 0) * ppm,
        },
        chars: [],
      }];
    }

    const enginePostData = model.printPostData;
    if (enginePostData.length === 0) {
      return [{
        data: this.data,
        rect: {
          x: this.absLeft * ppm,
          y: this.absTop * ppm,
          width: (this._inheritStyle?.parentWidth ?? 0) * ppm,
          height: (this._inheritStyle?.parentHeight ?? 0) * ppm,
        },
        chars: [],
      }];
    }

    const first = enginePostData[0];
    const chars: PrintPostDataChar[] = first.chars?.map((char) => ({
      ...char,
      rect: {
        x: char.rect.x * ppm,
        y: char.rect.y * ppm,
        width: char.rect.width * ppm,
        height: char.rect.height * ppm,
      },
    })) ?? [];

    return [{
      data: this.data,
      rect: {
        x: first.rect.x * ppm,
        y: first.rect.y * ppm,
        width: first.rect.width * ppm,
        height: first.rect.height * ppm,
      },
      chars,
    }];
  }

  get type() { return 'paragraph' as const; }

  get zIndex() { return this._zIndex; }

  /**
   * 다른 paragraph가 이 paragraph를 감싼 박스를 텍스트 회피 대상으로 취급할지 제어한다.
   *
   * `'none'`으로 변경하면 다른 paragraph가 이 박스와 겹쳐도 텍스트를 회피하지 않는다.
   * 변경 시 영향받는 형제 paragraph들을 재렌더링하도록 부모 box에 요청한다.
   *
   * @param value - 오버랩 모드 (`'box'` | `'none'`)
   */
  set overlapMode(value: ParagraphOverlapMode) {
    if (this._overlapMode === value) return;
    this._overlapMode = value;
    this.parentElement?.requestRerenderAffectedParagraphs();
  }

  get overlapMode(): ParagraphOverlapMode {
    return this._overlapMode;
  }

  /**
   * 구조 변경 플래그를 설정하고 `scheduleRender()`를 호출한다.
   * 외부 컨트롤러가 단락의 재렌더링을 트리거할 때 사용한다.
   */
  markStructureChangedAndRender(): void {
    this._perfStructureChanged = true;
    this.scheduleRender();
  }

  /**
   * 구조 변경 플래그를 설정하고 즉시 `render()`를 실행한다.
   * rAF 콜백 내에서 드래그/리사이즈 중 영향받는 단락을 갱신할 때 사용 —
   * `scheduleRender()`의 microtask 지연 없이 rAF 콜백 내에서 렌더링을 완료한다.
   */
  markStructureChangedAndFlushRender(): void {
    this._perfStructureChanged = true;
    this.flushRender();
  }

  /**
   * 드래그/리사이즈 중 영향받는 단락을 즉시 `render()`로 갱신한다.
   * `markStructureChangedAndFlushRender()`와 달리 `_perfStructureChanged`를
   * `true`로 설정하지 않는다 — 텍스트 내용이 아닌 박스 위치만 변경된 경우,
   * Skeleton 레이아웃 캐시가 히트하면 `columnContents`가 동일하므로 diff 기반
   * `renderText()` 경로로 진입하여 `_skipSpanStyleIfUnchanged`가 모든 span을
   * 스킵하도록 한다. 전체 재생성(`replaceChildren()`)을 피한다.
   *
   * 단, 오버랩 요소의 위치가 변경되었을 수 있으므로 `_layoutStructure()`를
   * 호출하여 `overlayEngines`를 갱신한다 — 엔진의 `data` setter가
   * 새 `overlayEngines` / `parentAbsRect`를 받아 skeleton 캐시 해시가
   * 변경되어 재래핑이 트리거된다.
   */
  renderForDrag(): void {
    this._layoutStructure();
    this.flushRender();
  }

  /**
   * `render()`를 마이크로태스크 배치로 예약한다.
   * 한 이벤트 루프 틱 내의 다중 `scheduleRender()` 호출을 하나의 `render()`로 통합하여
   * 불필요한 중복 렌더링을 방지한다.
   */
  scheduleRender(): void {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    queueMicrotask(() => {
      this._renderScheduled = false;
      this.render();
    });
  }

  /**
   * 대기 중인 `scheduleRender()` 배치를 취소하고 즉시 `render()`를 실행한다.
   * `render()` 직후에 동기적으로 커서/선택을 갱신해야 하는 호출자
   * (예: `TextEditController`의 Enter/compositionend 핸들러)가 사용한다.
   */
  flushRender(): void {
    this._renderScheduled = false;
    this.render();
  }

  get editableText(): boolean {
    return this._editableText;
  }

  set editableText(value: boolean) {
    if (value && !this._editController) {
      const manager = this._editManagerRef ?? this.editManager;
      if (manager) {
        this._editController = new TextEditController(this, manager);
      }
    } else if (!value && this._editController) {
      this._editController.destroy();
      this._editController = null;
    }
    this._editableText = value;
    this.markStructureChangedAndRender();
  }

  /**
   * AI 처리 중 상태를 반환한다.
   *
   * `data` getter에 포함되지 않는 휘발성 속성으로, 저장/직렬화 시 자동 제외된다.
   *
   * @returns AI 처리 중 여부
   *
   * @example
   * ```ts
   * if (paragraphElement.aiProcessing) {
   *   // AI 처리 중 로직
   * }
   * ```
   */
  get aiProcessing(): boolean {
    return isAiProcessingActive(this._shadowRoot);
  }

  /**
   * AI 처리 중 상태를 설정한다.
   *
   * `true`이면 요소를 반투명 오버레이로 덮고 shimmer + spinner 애니메이션을 표시한다.
   * 오버레이는 `pointer-events: auto`로 마우스 이벤트를 가로채 요소 조작을 차단한다.
   * `layout()`/`render()`를 트리거하지 않으므로 비용이 거의 없다.
   * `data` setter와 독립적이며 저장 시 직렬화되지 않는다.
   *
   * @param value - `true`면 AI 처리 중 오버레이 표시, `false`면 숨김
   *
   * @example
   * ```ts
   * // AI 처리 시작
   * paragraphElement.aiProcessing = true;
   *
   * // AI 처리 완료
   * paragraphElement.aiProcessing = false;
   * ```
   */
  set aiProcessing(value: boolean) {
    setAiProcessingActive(this._shadowRoot, value);
  }
}
customElements.define('x-layout-paragraph', LayoutParagraphElement);