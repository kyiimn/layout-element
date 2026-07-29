import { forwardRef, useEffect, type ReactNode } from 'react';
import { LayoutParagraphElement } from '@/components';
import type { ParagraphData, RenderCompleteEventDetail } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutParagraphProps {
  data: ParagraphData;
  editableText?: boolean;
  onRenderError?: (event: CustomEvent) => void;
  onRenderComplete?: (detail: RenderCompleteEventDetail) => void;
  children?: ReactNode;
}

export const LayoutParagraph = forwardRef<LayoutParagraphElement, LayoutParagraphProps>(
  function LayoutParagraph({ data, editableText, onRenderError, onRenderComplete, children }, ref) {
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
      if (!element || editableText === undefined) return;
      element.editableText = editableText;
    }, [innerRef, editableText]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || !onRenderError) return;

      const handler = (event: Event) => onRenderError(event as CustomEvent);
      element.addEventListener('render-error', handler);
      return () => element.removeEventListener('render-error', handler);
    }, [innerRef, onRenderError]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || !onRenderComplete) return;

      const handler = (event: Event) => onRenderComplete((event as CustomEvent).detail as RenderCompleteEventDetail);
      element.addEventListener('render-complete', handler);
      return () => element.removeEventListener('render-complete', handler);
    }, [innerRef, onRenderComplete]);

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
      <x-layout-paragraph ref={innerRef}>
        {children}
      </x-layout-paragraph>
    );
  }
);