import { useEffect } from 'react';
import type { RefObject } from 'react';
import { LayoutParagraphElement } from '@/components/layout/paragraph.element';

export interface UseEditableOptions {
  ref: RefObject<LayoutParagraphElement | null>;
  editable: boolean;
}

export function useEditable({ ref, editable }: UseEditableOptions): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    element.editable = editable;

    return () => {
      if (element.isConnected) {
        element.editable = false;
      }
    };
  }, [ref, editable]);
}
