import { forwardRef, useEffect, type ReactNode } from 'react';
import { LayoutParagraphElement } from '@/components';
import type { ParagraphData } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutParagraphProps {
  data: ParagraphData;
  editable?: boolean;
  onRenderError?: (event: CustomEvent) => void;
  children?: ReactNode;
}

export const LayoutParagraph = forwardRef<LayoutParagraphElement, LayoutParagraphProps>(
  function LayoutParagraph({ data, editable, onRenderError, children }, ref) {
    const { ref: innerRef, define } = useLayoutElement<LayoutParagraphElement>();

    useEffect(() => {
      define('x-layout-paragraph', LayoutParagraphElement);
    }, [define]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      element.data = data;
    }, [innerRef, data]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || editable === undefined) return;
      element.editable = editable;
    }, [innerRef, editable]);

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
    }, [ref, innerRef]);

    return (
      <x-layout-paragraph ref={innerRef}>
        {children}
      </x-layout-paragraph>
    );
  }
);
