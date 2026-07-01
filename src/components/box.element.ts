import { DEFAULT_BORDER_STYLE, DEFAULT_PPM } from "@/define";
import { BoxModel, ColorManager } from "@/model";
import { InheritStyle, BoxData, ParagraphStyle, TextStyle, PrintPostData } from "@/types";
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

  private _data?: BoxData;
  private _model?: BoxModel;

  private _children: ChildType[];

  private _shadowRoot: ShadowRoot;
  private _styleRule?: CSSStyleRule;

  constructor() {
    super();

    this._children = [];
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.layout();
  }

  disconnectedCallback() { }

  findById(id: string): ChildType | null {
    if (this.id === id) return this;
    for (let i = 0; i < this._children.length; i++) {
      const findChild = this._children[i].findById(id);
      if (findChild) return findChild;
    }
    return null;
  }

  layout() {
    if (!this.isConnected) return;

    if (!this._data || !this.parentModel) return;

    const { left, width, position, paddingTop, paddingRight, paddingBottom, paddingLeft } = this._data;
    const { columnWidth, gaps, lineHeight } = this.parentModel;

    this._model ??= BoxModel.create({
      width: 0, height: 0, columns: 1, gap: 0, paragraphStyle: {}, textStyle: {}
    });
    this._model.data = {
      paddingTop: (this._data.position !== 'absolute' && paddingTop !== undefined) ? Math.ceil(paddingTop / lineHeight) * lineHeight : paddingTop,
      paddingRight,
      paddingBottom: (this._data.position !== 'absolute' && paddingBottom !== undefined) ? Math.ceil(paddingBottom / lineHeight) * lineHeight : paddingBottom,
      paddingLeft,

      columns: position !== 'absolute' ? columnWidth.slice(left, left + width) : 1,
      gap: position !== 'absolute' ? gaps.slice(left, left + width - 1) : 0,

      paragraphStyle: this.paragraphStyle,
      textStyle: this.textStyle,
      height: this.height,
      width: this.width,
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
        height: `${this.height}mm`,
        left: `${this.left}mm`,
        position: 'absolute',
        top: `${this.top}mm`,
        width: `${this.width}mm`,
        zIndex: `${this.zIndex + 100}`,
      }
    );
    this._shadowRoot.querySelectorAll(':scope > :not(slot):not(style)').forEach(node => node.remove());

    const colorManager = ColorManager.getInstance();
    if (this._data.borderColor) {
      const { borderBottomWidth, borderLeftWidth, borderRightWidth, borderTopWidth } = this._data;
      const borderStyle: Partial<CSSStyleDeclaration> = {
        overflow: 'hidden',
        position: 'absolute',
        zIndex: '99999999',
      };
      const borderInsideStyle: Partial<CSSStyleDeclaration> = {
        borderColor: colorManager.getCSSColor(this._data.borderColor),
        borderStyle: this._data.borderStyle || DEFAULT_BORDER_STYLE,
        borderWidth: '0',
      };

      if (borderTopWidth) {
        const border = document.createElement('div');
        border.setAttribute('data-border', 'top');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          height: `${Math.ceil(borderTopWidth * BoxModel.ppm)}px`, top: '0', width: '100%',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderTopWidth: `100px`, height: '0', width: '100%',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }

      if (borderBottomWidth) {
        const border = document.createElement('div');
        border.setAttribute('data-border', 'bottom');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          height: `${Math.ceil(borderBottomWidth * BoxModel.ppm)}px`, bottom: '0', width: '100%',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderBottomWidth: `100px`, height: '0', width: '100%',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }

      if (borderLeftWidth) {
        const border = document.createElement('div');
        border.setAttribute('data-border', 'left');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          width: `${Math.ceil(borderLeftWidth * BoxModel.ppm)}px`, height: '100%', left: '0',
        });
        const borderInside = document.createElement('div');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(borderInside.style, {
          ...borderInsideStyle,
          borderLeftWidth: `100px`, height: '100%', width: '0',
        });
        border.appendChild(borderInside);
        this._shadowRoot.appendChild(border);
      }

      if (borderRightWidth) {
        const border = document.createElement('div');
        border.setAttribute('data-border', 'right');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          width: `${Math.ceil(borderRightWidth * BoxModel.ppm)}px`, height: '100%', right: '0',
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
    if (this._data.children) {
      const childInheritStyle: InheritStyle = {
        ...(this.inheritStyle || {}),
        paddingTop: paddingTop || 0,
        paddingRight: paddingRight || 0,
        paddingBottom: paddingBottom || 0,
        paddingLeft: paddingLeft || 0,
        parentWidth: this._model.editableWidth,
        parentHeight: this._model.editableHeight,
      };
      for (let i = 0; i < this._data.children.length; i++) {
        const child = this._data.children[i];
        if (child.type === 'box') {
          const boxEl = document.createElement('x-layout-box');
          boxEl.id = child.id || genUUID();
          boxEl.data = child;
          boxEl.inheritStyle = childInheritStyle;

          this._children.push(boxEl);
          this.appendChild(boxEl);
        } else if (child.type === 'paragraph') {
          const paragraphEl = document.createElement('x-layout-paragraph');
          paragraphEl.id = child.id || genUUID();
          paragraphEl.data = child;
          paragraphEl.parentElement = this;
          paragraphEl.parentModel = this._model;
          paragraphEl.inheritStyle = {
            ...childInheritStyle,
            parentHeight: this._model.editableTextHeight,
          };

          this._children.push(paragraphEl);
          this.appendChild(paragraphEl);
        } else if (child.type === 'text') {
          const paragraphEl = document.createElement('x-layout-paragraph');
          paragraphEl.data = {
            ...child,
            type: 'paragraph',
            column: 1,
            gap: 0,
          };
          paragraphEl.id = child.id || genUUID();
          paragraphEl.parentElement = this;
          paragraphEl.parentModel = this._model;
          paragraphEl.inheritStyle = {
            ...childInheritStyle,
            parentHeight: this._model.editableTextHeight,
          };

          this._children.push(paragraphEl);
          this.appendChild(paragraphEl);
        } else if (child.type === 'image') {
          const imageEl = document.createElement('x-layout-image');
          imageEl.id = child.id || genUUID();
          imageEl.data = child;
          imageEl.inheritStyle = childInheritStyle;
          imageEl.parentElement = this;
          imageEl.parentModel = this._model;

          this._children.push(imageEl);
          this.appendChild(imageEl);
        }
      }
    }
  }

  async renderImage() {
    if (!this.isConnected) return;
    for (let i = 0; i < this._children.length; i++) {
      await this._children[i].renderImage();
    }
  }

  renderText() {
    if (!this.isConnected) return;
    this._children.forEach(c => c.renderText());
  }

  set data(data: BoxData | undefined) {
    this._data = data;
    this.layout();
  }

  get data() {
    return this._data;
  }

  get parentElement() {
    return super.parentElement as LayoutDocumentElement | LayoutBoxElement;
  }

  get items() {
    return this._children;
  }

  get parentModel() {
    return this.parentElement?.model;
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.layout();
  }

  get inheritStyle() {
    return this._inheritStyle;
  }

  get model() {
    return this._model;
  }

  get textStyle(): TextStyle {
    return this.parentModel?.textStyle || {};
  }

  get paragraphStyle(): ParagraphStyle {
    return this.parentModel?.paragraphStyle || {};
  }

  get left() {
    if (!this._data) return 0;
    const { left, position } = this._data;
    if (position !== 'absolute') {
      return this.parentModel ? this.parentModel.columnCoords[left].x1 : 0;
    } else {
      return (this._inheritStyle?.paddingLeft || 0) + left;
    }
  }

  get top() {
    if (!this._data) return 0;
    const { left, top, position } = this._data;
    if (position !== 'absolute') {
      if (this.parentModel) {
        const { columnCoords, lineHeight } = this.parentModel;
        return columnCoords[left].y1 + (lineHeight * top);
      } else {
        return 0;
      }
    } else {
      return (this._inheritStyle?.paddingTop || 0) + top;
    }
  }

  get absLeft(): number {
    if (this.parentElement.type === "document") return this.left;
    return this.parentElement.absLeft + this.left;
  }

  get absTop(): number {
    if (this.parentElement.type === "document") return this.top;
    return this.parentElement.absTop + this.top;
  }

  get width() {
    if (!this._data) return 0;
    const { left, position, width } = this._data;
    if (position !== 'absolute') {
      if (this.parentModel) {
        const { columnCoords, columnCount } = this.parentModel;
        const col = Math.min(columnCount, left + this._data.width) - 1;
        return columnCoords[col].x2 - columnCoords[left].x1;
      } else {
        return 0;
      }
    } else {
      return width;
    }
  }

  get height() {
    if (!this._data) return 0;
    const { height, position } = this._data;
    let calcHeight = 0;
    if (position !== 'absolute') {
      if (this.parentModel) {
        const { fontSize, lineHeight } = this.parentModel;
        calcHeight = lineHeight * height - (lineHeight - fontSize);
      }
    } else {
      calcHeight = height;
    }
    if (this.parentModel?.editableHeight) {
      const top = this.parentElement.type !== 'document' ? this.top : 0;
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
    if (!this._data) return [];

    const data: PrintPostData[] = [];
    const rect = this.getBoundingClientRect();

    this._children.forEach(c => {
      data.push(...c.printPostData)
    });
    const colorManager = ColorManager.getInstance();

    data.push({
      color: this._data?.borderColor ? colorManager.get(this._data.borderColor) : undefined,
      data: {
        ...this._data,
        borderStyle: this._data.borderStyle || DEFAULT_BORDER_STYLE,
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

  get type(): "box" { return 'box'; }

  get contentType(): 'image' | 'paragraph' | null {
    if (this.items.length !== 1) return null;
    if (this.items[0].type === 'box') return this.items[0].contentType;
    return this.items[0].type;
  }

  get zIndex() { return this._data?.zIndex || 0; }
}
customElements.define('x-layout-box', LayoutBoxElement);