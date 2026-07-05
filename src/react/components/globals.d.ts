import type { DetailedHTMLProps, HTMLAttributes } from 'react';
import {
  LayoutBoxElement,
  LayoutDocumentElement,
  LayoutGuideColumnElement,
  LayoutImageElement,
  LayoutParagraphElement,
} from '@/components';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'x-layout-document': DetailedHTMLProps<
        HTMLAttributes<LayoutDocumentElement>,
        LayoutDocumentElement
      >;
      'x-layout-box': DetailedHTMLProps<
        HTMLAttributes<LayoutBoxElement>,
        LayoutBoxElement
      >;
      'x-layout-paragraph': DetailedHTMLProps<
        HTMLAttributes<LayoutParagraphElement>,
        LayoutParagraphElement
      >;
      'x-layout-image': DetailedHTMLProps<
        HTMLAttributes<LayoutImageElement>,
        LayoutImageElement
      >;
      'x-layout-guide-column': DetailedHTMLProps<
        HTMLAttributes<LayoutGuideColumnElement>,
        LayoutGuideColumnElement
      >;
    }
  }
}

export {};
