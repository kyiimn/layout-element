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
      if (!element || data === undefined) return;
      element.data = data;
    }, [innerRef, data]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || width === undefined) return;
      element.width = width;
    }, [innerRef, width]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || height === undefined) return;
      element.height = height;
    }, [innerRef, height]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || paddingTop === undefined) return;
      element.paddingTop = paddingTop;
    }, [innerRef, paddingTop]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || paddingRight === undefined) return;
      element.paddingRight = paddingRight;
    }, [innerRef, paddingRight]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || paddingBottom === undefined) return;
      element.paddingBottom = paddingBottom;
    }, [innerRef, paddingBottom]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || paddingLeft === undefined) return;
      element.paddingLeft = paddingLeft;
    }, [innerRef, paddingLeft]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || columns === undefined) return;
      element.columns = columns;
    }, [innerRef, columns]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || gap === undefined) return;
      element.gap = gap;
    }, [innerRef, gap]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || paragraphStyle === undefined) return;
      element.paragraphStyle = paragraphStyle;
    }, [innerRef, paragraphStyle]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || textStyle === undefined) return;
      element.textStyle = textStyle;
    }, [innerRef, textStyle]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || visibleGuide === undefined) return;
      element.visibleGuide = visibleGuide;
    }, [innerRef, visibleGuide]);

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
