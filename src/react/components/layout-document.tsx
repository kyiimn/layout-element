import { forwardRef, useEffect, type ReactNode } from 'react';
import { LayoutDocumentElement } from '@/components';
import type { DocumentData, ParagraphStyle, TextStyle } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutDocumentProps {
  data?: DocumentData;
  paragraphStyle?: ParagraphStyle;
  textStyle?: TextStyle;
  visibleGuide?: boolean;
  children?: ReactNode;
}

export const LayoutDocument = forwardRef<LayoutDocumentElement, LayoutDocumentProps>(
  function LayoutDocument({
    data,
    paragraphStyle,
    textStyle,
    visibleGuide,
    children,
  }, ref) {
    const { ref: innerRef, define } = useLayoutElement<LayoutDocumentElement>();

    useEffect(() => {
      define('x-layout-document', LayoutDocumentElement);
    }, [define]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      if (data !== undefined) element.data = data;
      if (paragraphStyle !== undefined) element.paragraphStyle = paragraphStyle;
      if (textStyle !== undefined) element.textStyle = textStyle;
      if (visibleGuide !== undefined) element.visibleGuide = visibleGuide;
    }, [innerRef, data, paragraphStyle, textStyle, visibleGuide]);

    useEffect(() => {
      if (typeof ref === 'function') {
        ref(innerRef.current);
      } else if (ref) {
        ref.current = innerRef.current;
      }
      return () => {
        if (typeof ref === 'function') {
          ref(null);
        } else if (ref) {
          ref.current = null;
        }
      };
    }, [ref, innerRef]);

    return (
      <x-layout-document ref={innerRef}>
        {children}
      </x-layout-document>
    );
  }
);