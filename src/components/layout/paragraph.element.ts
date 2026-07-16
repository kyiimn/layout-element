import { TextLayoutEngine } from "@/core";
import { EditController } from "@/edit/edit-controller";
import { ColorRegistry } from "@/resource";
import { InheritStyle, ParagraphData, ParagraphStyle, TextBlockData, TextStyle } from "@/types";
import { checkOverlap, genUUID } from "@/utils";
import { LayoutBoxElement } from "./box.element";
import { LayoutColumnElement } from "./column.element";

/**
 * 다중 컬럼 텍스트 영역 요소. `<x-layout-paragraph>` 커스텀 엘리먼트.
 *
 * `ParagraphData`를 받아 `TextLayoutEngine`을 통해 텍스트 래핑을 수행하고,
 * `LayoutColumnElement`를 생성하여 각 컬럼을 렌더링한다.
 *
 * 오버플로우 발생 시 `render-error` 커스텀 이벤트를 디스패치한다.
 */
export class LayoutParagraphElement extends HTMLElement {
  private _inheritStyle?: InheritStyle;
  private _styleRule?: CSSStyleRule;

  private _model?: TextLayoutEngine;

  private _shadowRoot: ShadowRoot;

  private _content: string | (string | TextBlockData)[];
  private _column?: number | number[];
  private _gap?: number | number[];

  private _paragraphStyle: ParagraphStyle;
  private _textStyle: TextStyle;

  private _zIndex: number;

  private _editableText: boolean = false;
  private _editController: EditController | null = null;
  private _isPrint: boolean = window.matchMedia("print").matches;

  /** 성능 최적화: 구조 변경 여부 플래그. true면 다음 render()에서 전체 재생성을 수행한다. */
  private _perfStructureChanged: boolean = true;

  constructor() {
    super();

    this._shadowRoot = this.attachShadow({ mode: "open" });

    this._content = "";
    this._paragraphStyle = {};
    this._textStyle = {};
    this._zIndex = 0;
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    this.layout();
    if (this._editableText && !this._editController) {
      this._editController = new EditController(this);
    }
  }

  disconnectedCallback() {
    this._editController?.destroy();
    this._editController = null;
  }

  /**
   * 구조 계산: TextLayoutEngine 데이터 할당 및 모델 생성/갱신.
   * 내부 전용. `layout()`에서만 호출된다.
   */
  private _layoutStructure() {
    if (!this.isConnected || !this.parentModel || !this._inheritStyle) return;

    const paragraphData = {
      column: this._column !== undefined && this._gap !== undefined ? this._column : this.parentModel.columnWidth,
      gap: this._column !== undefined && this._gap !== undefined ? this._gap : this.parentModel.gaps,

      content: this._content,
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
    const fontSize = this.textStyle.fontSize || this._inheritStyle.fontSize;
    const lineHeight = this.parentModel.lineHeight;
    const paddingTop = this._inheritStyle.paddingTop || 0;

    const colorManager = ColorRegistry.getInstance();
    if (!this._styleRule) {
      const styleEl = document.createElement('style');
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);
      styleEl.sheet.insertRule(`@media print { :host { overflow: hidden; } }`, 1);
      this._styleRule = styleEl.sheet.cssRules[0] as CSSStyleRule;

      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
        this._styleRule.style,
        {
          display: 'flex',
          flexDirection: 'row',
          position: 'absolute',
          overflow: "hidden",
        }
      );
      this._shadowRoot.appendChild(document.createElement('slot'));
    }
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      this._styleRule.style,
      {
        color: color !== undefined ? colorManager.getCSSColor(color) : undefined,
        fontFamily,
        fontStyle,
        fontWeight: fontWeight ? String(fontWeight) : undefined,
        fontSize: `${fontSize}mm`,
        height: `${this.absHeight}mm`,
        left: `${this.relLeft}mm`,
        top: `${Math.ceil(paddingTop / lineHeight) * lineHeight}mm`,
        width: `${this.absWidth}mm`,
        zIndex: `${this.zIndex + 100}`,
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

  set data(data: ParagraphData) {
    if (data.id !== undefined) this.id = data.id;
    if (data.column !== undefined) this._column = data.column;
    if (data.gap !== undefined) this._gap = data.gap;
    if (data.textStyle !== undefined) this._textStyle = data.textStyle;
    if (data.paragraphStyle !== undefined) this._paragraphStyle = data.paragraphStyle;
    if (data.zIndex !== undefined) this._zIndex = data.zIndex;

    this._content = data.content;

    this.layout();
    this._perfStructureChanged = true;
  }

  get data() {
    return {
      id: this.id,
      column: this._column,
      content: this._content,
      gap: this._gap,
      paragraphStyle: this._paragraphStyle,
      textStyle: this._textStyle,
      zIndex: this._zIndex,
      type: this.type,
    };
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

  get textStyle(): TextStyle {
    return this._textStyle;
  }

  get paragraphStyle(): ParagraphStyle {
    return this._paragraphStyle;
  }

  get relLeft() {
    return this._inheritStyle?.paddingLeft || 0;
  }

  get relTop() {
    if (!this._inheritStyle || !this.parentModel) return 0;
    return Math.ceil((this._inheritStyle.paddingTop || 0) / this.parentModel.lineHeight) * this.parentModel.lineHeight;
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
    const list: LayoutBoxElement[] = this.parentElement.overlayElements;
    const self: any = this;

    let overlay = this.parentElement.items.filter(i => i.type === 'box' && i !== self && i.zIndex > this.zIndex) as LayoutBoxElement[];
    overlay = overlay.filter(i => checkOverlap(i, this));

    list.push(...overlay);

    return list;
  }

  get printPostData() {
    return [];
  }

  get type() { return 'paragraph' as const; }

  get zIndex() { return this._zIndex; }

  /**
   * 구조 변경 플래그를 설정하고 `render()`를 호출한다.
   * 외부 컨트롤러가 단락의 재렌더링을 트리거할 때 사용한다.
   */
  markStructureChangedAndRender(): void {
    this._perfStructureChanged = true;
    this.render();
  }

  get editableText(): boolean {
    return this._editableText;
  }

  set editableText(value: boolean) {
    if (this._isPrint) return;
    if (value && !this._editController) {
      this._editController = new EditController(this);
    } else if (!value && this._editController) {
      this._editController.destroy();
      this._editController = null;
    }
    this._editableText = value;
  }
}
customElements.define('x-layout-paragraph', LayoutParagraphElement);