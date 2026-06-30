import { DEFAULT_BORDER_STYLE, DEFAULT_PPM } from "@/define";
import { BoxModel } from "@/model";
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
  private _parentModel?: BoxModel;
  private _inheritStyle?: InheritStyle;

  private _data?: BoxData;
  private _model?: BoxModel;

  private _children: ChildType[];

  private _doc!: LayoutDocumentElement;
  private _parentElement!: LayoutDocumentElement | LayoutBoxElement;
  private _shadowRoot: ShadowRoot;

  constructor() {
    super();

    this._children = [];
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.renderLayout();
  }

  disconnectedCallback() {
    if (this._data) delete this._data;
    if (this._model) delete this._model;
  }

  renderLayout() {
    if (!this.isConnected) return;

    this._children = [];
    this._shadowRoot.innerHTML = '';
    this.removeAttribute('style');
    if (this._model) delete this._model;
    if (!this._data || !this._parentModel) return;

    const { left, width, position, paddingTop, paddingRight, paddingBottom, paddingLeft } = this._data;
    const { columnWidth, gaps, lineHeight } = this._parentModel;
    this._model = BoxModel.create({
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
    });

    const styleEl = document.createElement('style');
    this._shadowRoot.appendChild(styleEl);
    if (styleEl.sheet) {
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, {
        display: 'inline-block',
        boxSizing: 'border-box',
        height: `${this.height}mm`,
        left: `${this.left}mm`,
        position: 'absolute',
        top: `${this.top}mm`,
        width: `${this.width}mm`,
        zIndex: `${this.zIndex + 100}`,
      });
      styleEl.sheet.insertRule(`@media print { [data-border] { display: none; } }`, 1);
    }

    if (this._data.borderColor) {
      const { borderBottomWidth, borderLeftWidth, borderRightWidth, borderTopWidth } = this._data;
      const borderStyle: Partial<CSSStyleDeclaration> = {
        overflow: 'hidden',
        position: 'absolute',
        zIndex: '99999999',
      };
      const borderInsideStyle: Partial<CSSStyleDeclaration> = {
        borderColor: this._doc.colorManager.getCSSColor(this._data.borderColor),
        borderStyle: this._data.borderStyle || DEFAULT_BORDER_STYLE,
        borderWidth: '0',
      };

      if (borderTopWidth) {
        const border = document.createElement('div');
        border.setAttribute('data-border', 'top');
        Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(border.style, {
          ...borderStyle,
          height: `${Math.ceil(borderTopWidth * (this._model?.ppm || DEFAULT_PPM))}px`, top: '0', width: '100%',
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
          height: `${Math.ceil(borderBottomWidth * (this._model?.ppm || DEFAULT_PPM))}px`, bottom: '0', width: '100%',
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
          width: `${Math.ceil(borderLeftWidth * (this._model?.ppm || DEFAULT_PPM))}px`, height: '100%', left: '0',
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
          width: `${Math.ceil(borderRightWidth * (this._model?.ppm || DEFAULT_PPM))}px`, height: '100%', right: '0',
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
    this._shadowRoot.appendChild(document.createElement('slot'));

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
          boxEl.document = this._doc;
          boxEl.inheritStyle = childInheritStyle;
          boxEl.parentElement = this;
          boxEl.parentModel = this._model

          this._children.push(boxEl);
          this.appendChild(boxEl);
        } else if (child.type === 'paragraph') {
          const paragraphEl = document.createElement('x-layout-paragraph');
          paragraphEl.id = child.id || genUUID();
          paragraphEl.data = child;
          paragraphEl.document = this._doc;
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
          paragraphEl.document = this._doc;
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

          this._children.push(imageEl);
          this.appendChild(imageEl);
        }
      }
    }
  }

  async renderImage() {
    if (!this.isConnected) return;
    for (let i = 0; i < this._children.length; i++) {
      const child = this._children[i] as any;
      if (child.renderImage) await child.renderImage();
    }
  }

  renderText() {
    if (!this.isConnected) return;
    for (let i = 0; i < this._children.length; i++) {
      const child = this._children[i] as any;
      if (child.renderText) child.renderText();
    }
  }

  set data(data: BoxData | undefined) {
    this._data = data;
    this.renderLayout();
  }

  get data() {
    return this._data;
  }

  set document(doc: LayoutDocumentElement) {
    this._doc = doc;
  }

  get document() {
    return this._doc;
  }

  set parentElement(el: LayoutDocumentElement | LayoutBoxElement) {
    this._parentElement = el;
  }

  get parentElement() {
    return this._parentElement;
  }

  get items() {
    return this._children;
  }

  set parentModel(model: BoxModel | undefined) {
    this._parentModel = model;
    this.renderLayout();
  }

  get parentModel() {
    return this._parentModel;
  }

  set inheritStyle(style: InheritStyle | undefined) {
    this._inheritStyle = style;
    this.renderLayout();
  }

  get inheritStyle() {
    return this._inheritStyle;
  }

  get textStyle(): TextStyle {
    return this._parentModel?.textStyle || {};
  }

  get paragraphStyle(): ParagraphStyle {
    return this._parentModel?.paragraphStyle || {};
  }

  get left() {
    if (!this._data) return 0;
    const { left, position } = this._data;
    if (position !== 'absolute') {
      return this._parentModel ? this._parentModel.columnCoords[left].x1 : 0;
    } else {
      return (this._inheritStyle?.paddingLeft || 0) + left;
    }
  }

  get top() {
    if (!this._data) return 0;
    const { left, top, position } = this._data;
    if (position !== 'absolute') {
      if (this._parentModel) {
        const { columnCoords, lineHeight } = this._parentModel;
        return columnCoords[left].y1 + (lineHeight * top);
      } else {
        return 0;
      }
    } else {
      return (this._inheritStyle?.paddingTop || 0) + top;
    }
  }

  get absLeft(): number {
    if (this._parentElement.type === "document") return this.left;
    return this._parentElement.absLeft + this.left;
  }

  get absTop(): number {
    if (this._parentElement.type === "document") return this.top;
    return this._parentElement.absTop + this.top;
  }

  get width() {
    if (!this._data) return 0;
    const { left, position, width } = this._data;
    if (position !== 'absolute') {
      if (this._parentModel) {
        const { columnCoords, columnCount } = this._parentModel;
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
      if (this._parentModel) {
        const { fontSize, lineHeight } = this._parentModel;
        calcHeight = lineHeight * height - (lineHeight - fontSize);
      }
    } else {
      calcHeight = height;
    }
    if (this._parentModel?.editableHeight) {
      const top = this.parentElement.type !== 'document' ? this.top : 0;
      calcHeight = Math.min(calcHeight, this._parentModel.editableHeight - (top - (this._inheritStyle?.paddingTop || 0)));
    }
    return calcHeight;
  }

  get overlayElements() {
    const list: LayoutBoxElement[] = [];
    if (this.parentElement.type !== 'document') {
      list.push(...this.parentElement.overlayElements);
    }

    let overlay = Array.from(this.parentElement.children).filter(i => i.type === 'box' && i !== this && i.zIndex > this.zIndex) as LayoutBoxElement[];
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

    data.push({
      color: this._data?.borderColor ? this._doc.colorManager.get(this._data.borderColor) : undefined,
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

  get model() { return this._model; }
}
customElements.define('x-layout-box', LayoutBoxElement);