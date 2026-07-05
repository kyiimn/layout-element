import { forwardRef, useEffect, type ReactNode } from 'react';
import { LayoutDocumentElement } from '@/components';
import type { DocumentData } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutDocumentProps {
  data: DocumentData;
  visibleGuide?: boolean;
  onRenderError?: (event: CustomEvent) => void;
  children?: ReactNode;
}

export const LayoutDocument = forwardRef<LayoutDocumentElement, LayoutDocumentProps>(
  function LayoutDocument({ data, visibleGuide, onRenderError, children }, ref) {
    const { ref: innerRef, define } = useLayoutElement<LayoutDocumentElement>();

    useEffect(() => {
      define('x-layout-document', LayoutDocumentElement);
    }, [define]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      element.data = data;
    }, [innerRef, data]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || visibleGuide === undefined) return;
      element.visibleGuide = visibleGuide;
    }, [innerRef, visibleGuide]);

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
      <x-layout-document ref={innerRef}>
        {children}
      </x-layout-document>
    );
  }
);
