import { DetailedHTMLProps, HTMLAttributes } from 'react';
import {
  LayoutBoxElement,
  LayoutColumnElement,
  LayoutDocumentElement,
  LayoutGuideColumnElement,
  LayoutImageElement,
  LayoutParagraphElement,
  LayoutVirtualColumnElement,
} from "./components";

declare global {
  interface HTMLElementTagNameMap {
    'x-layout-box': LayoutBoxElement;
    'x-layout-guide-column': LayoutGuideColumnElement;
    'x-layout-column': LayoutColumnElement;
    'x-layout-document': LayoutDocumentElement;
    'x-layout-image': LayoutImageElement;
    'x-layout-paragraph': LayoutParagraphElement;
    'x-layout-vcolumn': LayoutVirtualColumnElement;
  };
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'x-layout-document': DetailedHTMLProps<
        HTMLAttributes<LayoutDocumentElement> & {
          data?: DocumentData;
          guide?: boolean;
        },
        LayoutDocumentElement> & {
          onTextOverflow?: (e: Event) => void;
        };
    }
  }
}
export { };