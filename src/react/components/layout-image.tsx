import { forwardRef, useEffect } from 'react';
import { LayoutImageElement } from '@/components';
import type { ImageData } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutImageProps {
  data: ImageData;
}

export const LayoutImage = forwardRef<LayoutImageElement, LayoutImageProps>(
  function LayoutImage({ data }, ref) {
    const { ref: innerRef, define } = useLayoutElement<LayoutImageElement>();

    useEffect(() => {
      define('x-layout-image', LayoutImageElement);
    }, [define]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      element.data = data;
    }, [innerRef, data]);

    useEffect(() => {
      if (typeof ref === 'function') {
        ref(innerRef.current);
      } else if (ref) {
        ref.current = innerRef.current;
      }
    }, [ref, innerRef]);

    return (
      <x-layout-image ref={innerRef} />
    );
  }
);
