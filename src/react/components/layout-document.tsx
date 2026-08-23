import { forwardRef, useEffect, type ReactNode } from 'react';
import { LayoutDocumentElement } from '@/components';
import type { DocumentData, ParagraphStyle, TextStyle } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutDocumentProps {
  data?: DocumentData;
  width?: number;
  height?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  columns?: number | number[];
  gap?: number | number[];
  paragraphStyle?: ParagraphStyle;
  textStyle?: TextStyle;
  visibleGuide?: boolean;
  onRenderError?: (event: CustomEvent) => void;
  /** Called whenever innerWidth or innerHeight changes (derived from width/height minus padding) */
  onInnerSizeChange?: (innerWidth: number, innerHeight: number) => void;
  children?: ReactNode;
}

export const LayoutDocument = forwardRef<LayoutDocumentElement, LayoutDocumentProps>(
  function LayoutDocument({
    data,
    width,
    height,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    columns,
    gap,
    paragraphStyle,
    textStyle,
    visibleGuide,
    onInnerSizeChange,
    onRenderError,
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
      if (width !== undefined) element.width = width;
      if (height !== undefined) element.height = height;
      if (paddingTop !== undefined) element.paddingTop = paddingTop;
      if (paddingRight !== undefined) element.paddingRight = paddingRight;
      if (paddingBottom !== undefined) element.paddingBottom = paddingBottom;
      if (paddingLeft !== undefined) element.paddingLeft = paddingLeft;
      if (columns !== undefined) element.columns = columns;
      if (gap !== undefined) element.gap = gap;
      if (paragraphStyle !== undefined) element.paragraphStyle = paragraphStyle;
      if (textStyle !== undefined) element.textStyle = textStyle;
      if (visibleGuide !== undefined) element.visibleGuide = visibleGuide;
    }, [innerRef, data, width, height, paddingTop, paddingRight, paddingBottom, paddingLeft, columns, gap, paragraphStyle, textStyle, visibleGuide]);

    useEffect(() => {
      if (!onInnerSizeChange) return;
      const element = innerRef.current;
      if (!element) return;
      onInnerSizeChange(element.innerWidth, element.innerHeight);
    }, [innerRef, onInnerSizeChange, width, height, paddingTop, paddingRight, paddingBottom, paddingLeft, data]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || !onRenderError) return;

      const handler = (event: Event) => onRenderError(event as CustomEvent);
      element.addEventListener('render-error', handler);
      return () => element.removeEventListener('render-error', handler);
    }, [innerRef, onRenderError]);

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
