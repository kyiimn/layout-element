import { useEffect } from 'react';
import type { RefObject } from 'react';
import { LayoutParagraphElement } from '@/components/layout/paragraph.element';

export interface UseEditableTextOptions {
  ref: RefObject<LayoutParagraphElement | null>;
  editableText: boolean;
}

export function useEditableText({ ref, editableText }: UseEditableTextOptions): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    element.editableText = editableText;

    return () => {
      if (element.isConnected) {
        element.editableText = false;
      }
    };
  }, [ref, editableText]);
}