import { forwardRef, useEffect } from 'react';
import { LayoutTableRowElement } from '@/components';
import type { TableRowData } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutTableRowProps {
  data: TableRowData;
  height?: number;
  children?: React.ReactNode;
}

export const LayoutTableRow = forwardRef<LayoutTableRowElement, LayoutTableRowProps>(
  function LayoutTableRow({ data, height, children }, ref) {
    const { ref: innerRef, define } = useLayoutElement<LayoutTableRowElement>();

    useEffect(() => {
      define('x-layout-tr', LayoutTableRowElement);
    }, [define]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      element.data = data;
    }, [innerRef, data]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || height === undefined) return;
      element.height = height;
    }, [innerRef, height]);

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
      <x-layout-tr ref={innerRef as unknown as React.Ref<LayoutTableRowElement>}>
        {children}
      </x-layout-tr>
    );
  },
);