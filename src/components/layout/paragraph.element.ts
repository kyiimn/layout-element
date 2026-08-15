import { TextLayoutEngine } from "@/core";
import { TextEditController } from "@/edit/text-edit-controller";
import { EditManager } from "@/edit/edit-manager";
import { DEFAULT_LINE_GAP } from "@/constants";
import { ColorRegistry, FontLoader } from "@/resource";
import { InheritStyle, ParagraphData, ParagraphStyle, PrintPostData, PrintPostDataChar, RenderCompleteEventDetail, TextBlockData, TextStyle } from "@/types";
import { checkOverlap, genUUID, valueEqual, createAiProcessingOverlay, setAiProcessingActive, isAiProcessingActive, removeAiProcessingOverlay } from "@/utils";
import { LayoutBoxElement } from "./box.element";
import { LayoutColumnElement } from "./column.element";

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

  private _model?: TextLayoutEngine;

  private _shadowRoot: ShadowRoot;

  private _sourceContent: string | (string | TextBlockData)[];
  private _column?: number | number[];
  private _gap?: number | number[];

  private _paragraphStyle: ParagraphStyle;
  private _textStyle: TextStyle;

  private _zIndex: number;

  private _editableText: boolean = false;
  private _editController: TextEditController | null = null;
  private _editManagerRef: EditManager | null = null;
  private _isPrint: boolean = window.matchMedia("print").matches;

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

  disconnectedCallback() {
    removeAiProcessingOverlay(this._shadowRoot);
    this._editController?.destroy();
    this._editController = null;
    this._editManagerRef = null;
  }

  /**
   * 구조 계산: TextLayoutEngine 데이터 할당 및 모델 생성/갱신.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected || !this.parentModel || !this._inheritStyle) return;

    const paragraphData = {
      column: this._column !== undefined ? this._column : this.parentModel.columnWidth,
      gap: this._gap !== undefined ? this._gap : this.parentModel.gaps,

      content: this._model?.textContent ?? this._sourceContent,
      paragraphStyle: this.paragraphStyle,
      textStyle: this.textStyle,

      paragraphEl: this,
      rootNode: this._shadowRoot,
      inheritStyle: {
        ...this._inheritStyle,
        parentHeight: this.absHeight,
        parentWidth: this.absWidth,
      },
    };

    if (!this._model) {
      this._model = TextLayoutEngine.create(paragraphData);
    } else {
      this._model.data = paragraphData;
    }

    this._perfStructureChanged = true;
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
      styleEl.sheet.insertRule(`@media print { :host { overflow: hidden; } }`, 1);

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
        zIndex: `${this.zIndex + 100}`,
        boxShadow: this._hasOverflow && !this._isPrint
          ? 'inset 0 -8px 0 0 #ff0000'
          : '',
      }
    );
  }

  /**
   * InheritStyle 전파: 단락은 자식이 없으므로 아무 작업도 수행하지 않는다.
   * 레이아웃 파이프라인 일관성을 위해 빈 메서드로 존재한다.
   * 내부 전용.
   */
  private _propagateInheritStyle() {
    // 단락 요소는 레이아웃 자식이 없으므로 전파할 대상이 없다.
  }

  /**
   * 레이아웃 오케스트레이터. `_layoutStructure()`, `_applyStyle()`,
   * `_propagateInheritStyle()`를 순서대로 호출한다.
   * 기존 호출자와의 호환성을 위해 유지한다.
   */
  layout() {
    if (!this.isConnected || !this.parentModel || !this._inheritStyle) return;

    this._layoutStructure();
    this._applyStyle();
    this._propagateInheritStyle();
  }

  /**
   * 텍스트 컬럼 렌더링: TextLayoutEngine으로 텍스트 래핑을 수행하고
   * 컬럼 DOM을 생성/갱신한다. 오버플로우 발생 시 `render-error` 이벤트를 디스패치한다.
   * 렌더링 완료 후 항상 `render-complete` 이벤트를 디스패치하여 배치/오버플로우 통계를 전달한다.
   * 오버플로우 시 하단 8px 빨간 inset shadow로 시각적 표시를 적용한다.
   */
  render() {
    if (!this.isConnected || !this._model) return;

    const wasStructureDirty = this._perfStructureChanged;
    const lineCountBefore = this._model.previousLineCount;
    const overflowBefore = this._model.previousOverflow;

    if (this._perfStructureChanged) {
      this._model.resetIncrementalState();
      this._model.layoutStructure();
      this._model.layoutText();
      this._perfStructureChanged = false;
    } else {
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

    const needsFullRecreate = this._perfShouldFullRecreate(wasStructureDirty, lineCountBefore, overflowBefore, lineCountAfter, overflowAfter);

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
   * 구조 변경, 줄 수 변경, 오버플로우 변경 시 전체 재생성이 필요하다.
   */
  private _perfShouldFullRecreate(
    wasStructureDirty: boolean,
    lineCountBefore: number,
    overflowBefore: number,
    lineCountAfter: number,
    overflowAfter: number,
  ): boolean {
    return wasStructureDirty
      || lineCountBefore === -1
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
        hasOverflow: !this._isPrint && (overflowChars > 0 || overflowLines > 0),
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

    this._sourceContent = data.content;
    if (this._model && typeof data.content === 'string') this._model.textContent = data.content;

    this.layout();
    this._perfStructureChanged = true;
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
    if (this._model && typeof value === 'string') this._model.textContent = value;
    this.markStructureChangedAndRender();
  }

  get columnEl() {
    return Array.from(this.querySelectorAll('x-layout-column'));
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
      .filter(el => checkOverlap(el, this));

    const self: any = this;

    let overlay = this.parentElement.items.filter(i => i.type === 'box' && i !== self && i.zIndex > this.zIndex) as LayoutBoxElement[];
    overlay = overlay.filter(i => checkOverlap(i, this));

    list.push(...overlay);

    return list;
  }

  get printPostData(): PrintPostData[] {
    const rect = this.getBoundingClientRect();
    const chars: PrintPostDataChar[] = [];
    const registry = ColorRegistry.getInstance();
    const model = this._model;

    for (const col of this.columnEl) {
      const root = col.shadowRoot;
      if (root === null) continue;
      const lineDivs = Array.from(root.children).filter(
        (c): c is HTMLDivElement => c.tagName === 'DIV',
      );

      const columnIndex = col.index;
      const lines = model !== undefined && columnIndex !== undefined
        ? model.columnContents[columnIndex] ?? []
        : [];

      for (let li = 0; li < lineDivs.length; li++) {
        const lineDiv = lineDivs[li]!;
        if (lineDiv.style.display === 'none') continue;
        const lineData = lines[li];
        if (lineData === undefined) continue;
        // genPartStyle()의 CSS 상속과 동일한 우선순위: textBlockStyle → textStyle → inheritStyle.
        // 상속 색상을 무시하면 검은 배경 박스의 흰 글자가 default(검은색)로 폴백되어 보이지 않는다.
        const colorName = lineData?.textBlockStyle?.color
          ?? this._textStyle?.color
          ?? this._inheritStyle?.color;
        const cmyk = colorName !== undefined
          ? registry.get(colorName)
          : registry.get('default');

        const partDivs = Array.from(lineDiv.children).filter(
          (c): c is HTMLDivElement => c.tagName === 'DIV',
        );
        for (const partDiv of partDivs) {
          const spans = partDiv.querySelectorAll<HTMLSpanElement>(':scope > span[data-source-offset]');
          for (const span of spans) {
            const inner = span.querySelector<HTMLSpanElement>(':scope > span[data-char-inner]');
            const char = inner ? inner.textContent : span.textContent;
            if (char.length === 0) continue;

            const spanRect = span.getBoundingClientRect();
            const style = window.getComputedStyle(span);

            const scaleValue = (inner ? window.getComputedStyle(inner).scale : style.scale) || '1 1';
            const widthRatio = parseFloat(scaleValue.split(' ')[0] || '1');
            if (Number.isNaN(widthRatio)) continue;

            const charFontFamily = lineData?.textBlockStyle?.fontFamily
              ? FontLoader.getInstance().getFontFamily(lineData.textBlockStyle.fontFamily)
              : style.fontFamily;
            const charFontSize = lineData?.textBlockStyle?.fontSize !== undefined
              ? `${lineData.textBlockStyle.fontSize}mm`
              : style.fontSize;
            const charFontWeight = lineData?.textBlockStyle?.fontWeight !== undefined
              ? String(lineData.textBlockStyle.fontWeight)
              : style.fontWeight;

            chars.push({
              char,
              rect: {
                x: spanRect.x + window.scrollX,
                y: spanRect.y + window.scrollY,
                width: spanRect.width,
                height: spanRect.height,
              },
              fontFamily: charFontFamily,
              fontSize: charFontSize,
              fontWeight: charFontWeight,
              widthRatio,
              color: cmyk,
            });
          }
        }
      }
    }

    return [{
      data: this.data,
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      chars,
    }];
  }

  get type() { return 'paragraph' as const; }

  get zIndex() { return this._zIndex; }

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
    if (this._isPrint) return;
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