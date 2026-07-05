import { forwardRef, useEffect } from 'react';
import { LayoutGuideColumnElement } from '@/components';
import type { Rect } from '@/core';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutGuideColumnProps {
  rect?: Rect;
  visible?: boolean;
  fontSize?: number;
  lineHeight?: number;
}

export const LayoutGuideColumn = forwardRef<LayoutGuideColumnElement, LayoutGuideColumnProps>(
  function LayoutGuideColumn({ rect, visible, fontSize, lineHeight }, ref) {
    const { ref: innerRef, define } = useLayoutElement<LayoutGuideColumnElement>();

    useEffect(() => {
      define('x-layout-guide-column', LayoutGuideColumnElement);
    }, [define]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || rect === undefined) return;
      element.rect = rect;
    }, [innerRef, rect]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || visible === undefined) return;
      element.visible = visible;
    }, [innerRef, visible]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || fontSize === undefined) return;
      element.fontSize = fontSize;
    }, [innerRef, fontSize]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || lineHeight === undefined) return;
      element.lineHeight = lineHeight;
    }, [innerRef, lineHeight]);

    useEffect(() => {
      if (typeof ref === 'function') {
        ref(innerRef.current);
      } else if (ref) {
        ref.current = innerRef.current;
      }
    }, [ref, innerRef]);

    return (
      <x-layout-guide-column ref={innerRef} />
    );
  }
);
