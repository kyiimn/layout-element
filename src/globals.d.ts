import { DetailedHTMLProps, HTMLAttributes } from 'react';
import {
  LayoutBoxElement,
  LayoutColumnElement,
  LayoutDocumentElement,
  LayoutGuideColumnElement,
  LayoutImageElement,
  LayoutParagraphElement,
  LayoutTableElement,
  LayoutTableRowElement,
  LayoutTableCellElement,
  LayoutVirtualColumnElement,
} from "./components";
import type { DocumentData, BoxData, ParagraphData, ImageData, GuideColumnData, TableData, TableRowData, TableCellData, BoxRole } from "./types";

declare global {
  interface HTMLElementTagNameMap {
    'x-layout-box': LayoutBoxElement;
    'x-layout-guide-column': LayoutGuideColumnElement;
    'x-layout-column': LayoutColumnElement;
    'x-layout-document': LayoutDocumentElement;
    'x-layout-image': LayoutImageElement;
    'x-layout-paragraph': LayoutParagraphElement;
    'x-layout-table': LayoutTableElement;
    'x-layout-tr': LayoutTableRowElement;
    'x-layout-td': LayoutTableCellElement;
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
      'x-layout-box': DetailedHTMLProps<HTMLAttributes<LayoutBoxElement> & { data?: BoxData; role?: BoxRole; contentUid?: string; groupMember?: string[]; priority?: number; lock?: boolean; }, LayoutBoxElement>;
      'x-layout-guide-column': DetailedHTMLProps<HTMLAttributes<LayoutGuideColumnElement> & { data?: GuideColumnData; }, LayoutGuideColumnElement>;
      'x-layout-column': DetailedHTMLProps<HTMLAttributes<LayoutColumnElement> & { data?: ParagraphData; }, LayoutColumnElement>;
      'x-layout-image': DetailedHTMLProps<HTMLAttributes<LayoutImageElement> & { data?: ImageData; }, LayoutImageElement>;
      'x-layout-paragraph': DetailedHTMLProps<HTMLAttributes<LayoutParagraphElement> & { data?: ParagraphData; }, LayoutParagraphElement>;
      'x-layout-table': DetailedHTMLProps<HTMLAttributes<LayoutTableElement> & { data?: TableData; }, LayoutTableElement>;
      'x-layout-tr': DetailedHTMLProps<HTMLAttributes<LayoutTableRowElement> & { data?: TableRowData; height?: number; }, LayoutTableRowElement>;
      'x-layout-td': DetailedHTMLProps<HTMLAttributes<LayoutTableCellElement> & { data?: TableCellData; colspan?: number; rowspan?: number; }, LayoutTableCellElement>;
      'x-layout-vcolumn': DetailedHTMLProps<HTMLAttributes<LayoutVirtualColumnElement>, LayoutVirtualColumnElement>;
    }
  }
}
export { };
