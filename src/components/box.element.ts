import { DEFAULT_BORDER_STYLE, DEFAULT_PPM } from "@/define";
import { BoxModel, ColorManager } from "@/model";
import { InheritStyle, BoxData, ParagraphStyle, TextStyle, PrintPostData, BoxPosition, BoxBorderStyle } from "@/types";
import { checkOverlap, genUUID } from "@/utils";
import { LayoutDocumentElement } from "./document.element";
import { LayoutImageElement } from "./image.element";
import { LayoutParagraphElement } from "./paragraph.element";

type ChildType = LayoutBoxElement | LayoutParagraphElement | LayoutImageElement;

/**
 * 위치 지정 가능한 컨테이너 요소. `<x-layout-box>` 커스텀 엘리먼트.
 *
 * `BoxData`를 받아 DOM 트리를 구축하고 자식 요소들을 렌더링한다.
 * `position` 값에 따라 `left`/`width`의 의미가 달라진다:
 * - `'static'`: 컬럼 그리드 기반 배치
 * - `'absolute'`: mm 좌표 기반 절대 배치
 *
 * 3단계 렌더링 파이프라인을 따르며, `InheritStyle`을 자식에게 전파한다.
 */
export class LayoutBoxElement extends HTMLElement {
  private _inheritStyle?: InheritStyle;
  private _model?: BoxModel;

  private _shadowRoot: ShadowRoot;
  private _styleRule?: CSSStyleRule;

  private _left: number = 0;
  private _top: number = 0;
  private _width: number = 0;
  private _height: number = 0;
  private _position: BoxPosition = "static";
  private _backgroundColor?: string;
  private _borderColor?: string;
  private _borderStyle: BoxBorderStyle = "solid";
  private _borderTopWidth: number = 0;
  private _borderBottomWidth: number = 0;
  private _borderLeftWidth: number = 0;
  private _borderRightWidth: number = 0;
  private _paddingTop: number = 0;
  private _paddingBottom: number = 0;
  private _paddingLeft: number = 0;
  private _paddingRight: number = 0;
  private _zIndex: number = 0;

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    if (!this.id) this.id = genUUID();
    this.layout();
  }

  disconnectedCallback() { }

  findById(id: string): ChildType | null {
    if (this.id === id) return this;
    for (let i = 0; i < this.items.length; i++) {
      const findChild = this.items[i].findById(id);
      if (findChild) return findChild;
    }
    return null;
  }

  layout() {
    if (!this.isConnected || !this.parentModel) return;

    const { columnWidth, gaps, lineHeight } = this.parentModel;

    this._model ??= BoxModel.create({
      width: 0, height: 0, columns: 1, gap: 0, paragraphStyle: {}, textStyle: {}
    });
    this._model.data = {
      paddingTop: (this.position !== 'absolute' && this.paddingTop !== undefined) ? Math.ceil(this.paddingTop / lineHeight) * lineHeight : this.paddingTop,
      paddingRight: this.paddingRight,
      paddingBottom: (this.position !== 'absolute' && this.paddingBottom !== undefined) ? Math.ceil(this.paddingBottom / lineHeight) * lineHeight : this.paddingBottom,
      paddingLeft: this.paddingLeft,

      columns: this.position !== 'absolute' ? columnWidth.slice(this.left, this.left + this.width) : 1,
      gap: this.position !== 'absolute' ? gaps.slice(this.left, this.left + this.width - 1) : 0,

      paragraphStyle: this.paragraphStyle,
      textStyle: this.textStyle,
      height: this.absHeight,
      width: this.absWidth,
    };

    if (!this._styleRule) {
      const styleEl = document.createElement('style');
      this._shadowRoot.appendChild(styleEl);
      if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

      styleEl.sheet.insertRule(":host {}", 0);
      styleEl.sheet.insertRule(`@media print { [data-border] { display: none; } }`, 1);
      this._styleRule = styleEl.sheet.cssRules[0] as CSSStyleRule;

      this._shadowRoot.appendChild(document.createElement('slot'));
    }
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
      this._styleRule.style,
      {
        display: 'inline-block',
        boxSizing: 'border-box',
        height: `${this.absHeight}mm`,
        left: `${this.relLeft}mm`,
        position: 'absolute',
        top: `${this.relTop}mm`,
        width: `${this.absWidth}mm`,
        zIndex: `${this.zIndex + 100}`,
      }
    );
    this._shadowRoot.querySelectorAll(':scope > :not(slot):not(style)').forEach(node => node.remove());

    const colorManager = ColorManager.getInstance();
    if (this.borderColor) {
      const borderStyle: Partial<CSSStyleDeclaration> = {
        overflow: 'hidden',
        position: 'absolute',
        zIndex: '99999999',
      };
      const borderInsideStyle: Partial<CSSStyleDeclaration> = {
        borderColor: colorManager.getCSSColor(this.borderColor),
        borderStyle: this.borderStyle || DEFAULT_BORDER_STYLE,
        borderWidth: '0',
      };

      if (this.borderTopWidth) {
        const border = document.createElement('div');
        border.setAttribute('data-border', 'top');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          height: `${Math.ceil(this.borderTopWidth * BoxModel.ppm)}px`, top: '0', width: '100%',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderTopWidth: `100px`, height: '0', width: '100%',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }

      if (this.borderBottomWidth) {
        const border = document.createElement('div');
        border.setAttribute('data-border', 'bottom');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          height: `${Math.ceil(this.borderBottomWidth * BoxModel.ppm)}px`, bottom: '0', width: '100%',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderBottomWidth: `100px`, height: '0', width: '100%',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }

      if (this.borderLeftWidth) {
        const border = document.createElement('div');
        border.setAttribute('data-border', 'left');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          width: `${Math.ceil(this.borderLeftWidth * BoxModel.ppm)}px`, height: '100%', left: '0',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderLeftWidth: `100px`, height: '100%', width: '0',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }

      if (this.borderRightWidth) {
        const border = document.createElement('div');
        border.setAttribute('data-border', 'right');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          width: `${Math.ceil(this.borderRightWidth * BoxModel.ppm)}px`, height: '100%', right: '0',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderRightWidth: `100px`, height: '100%', width: '0',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }
    }

    this.items.forEach(childEl => {
      const childInheritStyle: InheritStyle = {
        ...(this.inheritStyle || {}),
        paddingTop: this.paddingTop || 0,
        paddingRight: this.paddingRight || 0,
        paddingBottom: this.paddingBottom || 0,
        paddingLeft: this.paddingLeft || 0,
        parentWidth: this._model!.editableWidth,
        parentHeight: this._model!.editableHeight,
      };
      if (childEl.type === 'box') {
        childEl.inheritStyle = childInheritStyle;
      } else if (childEl.type === 'paragraph') {
        childEl.inheritStyle = {
          ...childInheritStyle,
          parentHeight: this.model!.editableTextHeight,
        }
      } else if (childEl.type === 'image') {
        childEl.inheritStyle = childInheritStyle;
      }
    });
  }

  async renderImage() {
    if (!this.isConnected) return;
    for (let i = 0; i < this.items.length; i++) {
      await this.items[i].renderImage();
    }
  }

  renderText() {
    if (!this.isConnected) return;
    this.items.forEach(c => c.renderText());
  }

  appendChild<T extends Node>(node: T) {
    if (this.model) {
      const childInheritStyle: InheritStyle = {
        ...(this.inheritStyle || {}),
        paddingTop: this.paddingTop || 0,
        paddingRight: this.paddingRight || 0,
        paddingBottom: this.paddingBottom || 0,
        paddingLeft: this.paddingLeft || 0,
        parentWidth: this.model.editableWidth,
        parentHeight: this.model.editableHeight,
      };
      if (node.nodeName === 'X-LAYOUT-BOX') {
        const layoutEl = node as unknown as LayoutBoxElement;
        layoutEl.inheritStyle = childInheritStyle;
      } else if (node.nodeName === 'X-LAYOUT-PARAGRAPH') {
        const layoutEl = node as unknown as LayoutParagraphElement;
        layoutEl.inheritStyle = {
          ...childInheritStyle,
          parentHeight: this.model.editableTextHeight,
        }
      } else if (node.nodeName === 'X-LAYOUT-IMAGE') {
        const layoutEl = node as unknown as LayoutImageElement;
        layoutEl.inheritStyle = childInheritStyle;
      }
    }
    return super.appendChild(node);
  }

  set data(data: BoxData) {
    if (data.id !== undefined) this.id = data.id;
    if (data.position !== undefined) this._position = data.position;
    if (data.zIndex !== undefined) this._zIndex = data.zIndex;
    if (data.backgroundColor !== undefined) this._backgroundColor = data.backgroundColor;
    if (data.borderTopWidth !== undefined) this._borderTopWidth = data.borderTopWidth;
    if (data.borderBottomWidth !== undefined) this._borderBottomWidth = data.borderBottomWidth;
    if (data.borderLeftWidth !== undefined) this._borderLeftWidth = data.borderLeftWidth;
    if (data.borderRightWidth !== undefined) this._borderRightWidth = data.borderRightWidth;
    if (data.borderStyle !== undefined) this._borderStyle = data.borderStyle;
    if (data.borderColor !== undefined) this._borderColor = data.borderColor;
    if (data.paddingTop !== undefined) this._paddingTop = data.paddingTop;
    if (data.paddingBottom !== undefined) this._paddingBottom = data.paddingBottom;
    if (data.paddingLeft !== undefined) this._paddingLeft = data.paddingLeft;
    if (data.paddingRight !== undefined) this._paddingRight = data.paddingRight;

    this._left = data.left;
    this._top = data.top;
    this._width = data.width;
    this._height = data.height;

    this.items.forEach(e => e.remove());

    this.layout();

    const children = data.children || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type === 'box') {
        const boxEl = document.createElement('x-layout-box');
        boxEl.data = child;
        this.appendChild(boxEl);
      } else if (child.type === 'paragraph') {
        const paragraphEl = document.createElement('x-layout-paragraph');
        paragraphEl.data = child;
        this.appendChild(paragraphEl);
      } else if (child.type === 'text') {
        const paragraphEl = document.createElement('x-layout-paragraph');
        paragraphEl.data = {
          ...child,
          type: 'paragraph',
          column: 1,
          gap: 0,
        };
        this.appendChild(paragraphEl);
      } else if (child.type === 'image') {
        const imageEl = document.createElement('x-layout-image');
        imageEl.data = child;
        this.appendChild(imageEl);
      }
    }
  }

  set left(value: number) {
    if (this._left === value) return;
    this._left = value;
    this.layout();
  }

  set top(value: number) {
    if (this._top === value) return;
    this._top = value;
    this.layout();
  }

  set width(value: number) {
    if (this._width === value) return;
    this._width = value;
    this.layout();
  }

  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this.layout();
  }

  set position(value: BoxPosition) {
    if (this._position === value) return;
    this._position = value;
    this.layout();
  }

  set zIndex(value: number) {
    if (this._zIndex === value) return;
    this._zIndex = value;
    this.layout();
  }

  set backgroundColor(value: string | undefined) {
    if (this._backgroundColor === value) return;
    this._backgroundColor = value;
    this.layout();
  }

  set borderTopWidth(value: number) {
    if (this._borderTopWidth === value) return;
    this._borderTopWidth = value;
    this.layout();
  }

  set borderBottomWidth(value: number) {
    if (this._borderBottomWidth === value) return;
    this._borderBottomWidth = value;
    this.layout();
  }

  set borderLeftWidth(value: number) {
    if (this._borderLeftWidth === value) return;
    this._borderLeftWidth = value;
    this.layout();
  }

  set borderRightWidth(value: number) {
    if (this._borderRightWidth === value) return;
    this._borderRightWidth = value;
    this.layout();
  }

  set borderStyle(value: BoxBorderStyle) {
    if (this._borderStyle === value) return;
    this._borderStyle = value;
    this.layout();
  }

  set borderColor(value: string | undefined) {
    if (this._borderColor === value) return;
    this._borderColor = value;
    this.layout();
  }

  set paddingTop(value: number) {
    if (this._paddingTop === value) return;
    this._paddingTop = value;
    this.layout();
  }

  set paddingRight(value: number) {
    if (this._paddingRight === value) return;
    this._paddingRight = value;
    this.layout();
  }

  set paddingBottom(value: number) {
    if (this._paddingBottom === value) return;
    this._paddingBottom = value;
    this.layout();
  }

  set paddingLeft(value: number) {
    if (this._paddingLeft === value) return;
    this._paddingLeft = value;
    this.layout();
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.layout();
  }

  get data(): BoxData {
    return {
      id: this.id || undefined,
      type: this.type,
      left: this.left,
      top: this.top,
      width: this.width,
      height: this.height,
      position: this.position,
      zIndex: this.zIndex,
      backgroundColor: this.backgroundColor,
      borderTopWidth: this.borderTopWidth,
      borderBottomWidth: this.borderBottomWidth,
      borderLeftWidth: this.borderLeftWidth,
      borderRightWidth: this.borderRightWidth,
      borderStyle: this.borderStyle,
      borderColor: this.borderColor,
      paddingTop: this.paddingTop,
      paddingRight: this.paddingRight,
      paddingBottom: this.paddingBottom,
      paddingLeft: this.paddingLeft,
      children: this.items.map(e => e.data).filter(e => !!e),
    };
  }

  get left() { return this._left; }
  get top() { return this._top; }
  get width() { return this._width; }
  get height() { return this._height; }
  get position() { return this._position; }
  get zIndex() { return this._zIndex; }
  get backgroundColor() { return this._backgroundColor; }
  get borderColor() { return this._borderColor; }
  get borderStyle() { return this._borderStyle; }
  get borderTopWidth() { return this._borderTopWidth; }
  get borderBottomWidth() { return this._borderBottomWidth; }
  get borderLeftWidth() { return this._borderLeftWidth; }
  get borderRightWidth() { return this._borderRightWidth; }
  get paddingTop() { return this._paddingTop; }
  get paddingRight() { return this._paddingRight; }
  get paddingBottom() { return this._paddingBottom; }
  get paddingLeft() { return this._paddingLeft; }

  get inheritStyle() { return this._inheritStyle; }
  get model() { return this._model; }

  get parentElement() {
    return super.parentElement as LayoutDocumentElement | LayoutBoxElement;
  }

  get parentModel() {
    return this.parentElement?.model;
  }

  get items() {
    return Array.from(this.querySelectorAll<LayoutBoxElement | LayoutParagraphElement | LayoutImageElement>(":scope > x-layout-box, :scope > x-layout-paragraph, :scope > x-layout-image"));
  }

  get textStyle(): TextStyle {
    return this.parentModel?.textStyle || {};
  }

  get paragraphStyle(): ParagraphStyle {
    return this.parentModel?.paragraphStyle || {};
  }

  get relLeft() {
    if (this.position !== 'absolute') {
      return this.parentModel ? this.parentModel.columnCoords[this.left].x1 : 0;
    } else {
      return (this.inheritStyle?.paddingLeft || 0) + this.left;
    }
  }

  get relTop() {
    if (this.position !== 'absolute') {
      if (this.parentModel) {
        const { columnCoords, lineHeight } = this.parentModel;
        return columnCoords[this.left].y1 + (lineHeight * this.top);
      } else {
        return 0;
      }
    } else {
      return (this.inheritStyle?.paddingTop || 0) + this.top;
    }
  }

  get absLeft(): number {
    if (this.parentElement.type === "document") return this.relLeft;
    return this.parentElement.absLeft + this.relLeft;
  }

  get absTop(): number {
    if (this.parentElement.type === "document") return this.relTop;
    return this.parentElement.absTop + this.relTop;
  }

  get absWidth() {
    if (this.position !== 'absolute') {
      if (this.parentModel) {
        const { columnCoords, columnCount } = this.parentModel;
        const col = Math.min(columnCount, this.left + this.width) - 1;
        return columnCoords[col].x2 - columnCoords[this.left].x1;
      } else {
        return 0;
      }
    } else {
      return this.width;
    }
  }

  get absHeight() {
    let calcHeight = 0;
    if (this.position !== 'absolute') {
      if (this.parentModel) {
        const { fontSize, lineHeight } = this.parentModel;
        calcHeight = lineHeight * this.height - (lineHeight - fontSize);
      }
    } else {
      calcHeight = this.height;
    }
    if (this.parentModel?.editableHeight) {
      const top = this.parentElement.type !== 'document' ? this.relTop : 0;
      calcHeight = Math.min(calcHeight, this.parentModel.editableHeight - (top - (this._inheritStyle?.paddingTop || 0)));
    }
    return calcHeight;
  }

  get overlayElements() {
    const list: LayoutBoxElement[] = [];
    if (this.parentElement.type !== 'document') {
      list.push(...this.parentElement.overlayElements);
    }

    let overlay = this.parentElement.items.filter(i => i.type === 'box' && i !== this && i.zIndex > this.zIndex) as LayoutBoxElement[];
    overlay = overlay.filter(i => checkOverlap(i, this));

    list.push(...overlay);

    return list;
  }

  get printPostData() {
    const data: PrintPostData[] = [];
    const rect = this.getBoundingClientRect();

    this.items.forEach(c => {
      data.push(...c.printPostData)
    });
    const colorManager = ColorManager.getInstance();

    data.push({
      color: this.borderColor ? colorManager.get(this.borderColor) : undefined,
      data: {
        ...this.data,
        borderStyle: this.borderStyle || DEFAULT_BORDER_STYLE,
      },
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
    });
    return data;
  }

  get type() { return 'box' as const; }

  get contentType(): 'image' | 'paragraph' | null {
    if (this.items.length !== 1) return null;
    if (this.items[0].type === 'box') return this.items[0].contentType;
    return this.items[0].type;
  }
}
customElements.define('x-layout-box', LayoutBoxElement);