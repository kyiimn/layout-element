import { forwardRef, useEffect, type ReactNode } from 'react';
import { LayoutBoxElement } from '@/components';
import type { BoxData } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutBoxProps {
  data: BoxData;
  children?: ReactNode;
}

export const LayoutBox = forwardRef<LayoutBoxElement, LayoutBoxProps>(
  function LayoutBox({ data, children }, ref) {
    const { ref: innerRef, define } = useLayoutElement<LayoutBoxElement>();

    useEffect(() => {
      define('x-layout-box', LayoutBoxElement);
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
      <x-layout-box ref={innerRef}>
        {children}
      </x-layout-box>
    );
  }
);
