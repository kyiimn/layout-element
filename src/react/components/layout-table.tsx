import { forwardRef, useEffect } from 'react';
import { LayoutTableElement } from '@/components';
import type { TableData } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutTableProps {
  data: TableData;
  colWidths?: number | number[];
  inheritStyle?: Record<string, unknown>;
  children?: React.ReactNode;
}

export const LayoutTable = forwardRef<LayoutTableElement, LayoutTableProps>(
  function LayoutTable({ data, colWidths, inheritStyle, children }, ref) {
    const { ref: innerRef, define } = useLayoutElement<LayoutTableElement>();

    useEffect(() => {
      define('x-layout-table', LayoutTableElement);
    }, [define]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      element.data = data;
    }, [innerRef, data]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || colWidths === undefined) return;
      element.colWidths = colWidths;
    }, [innerRef, colWidths]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || inheritStyle === undefined) return;
      element.inheritStyle = inheritStyle as never;
    }, [innerRef, inheritStyle]);

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
      <x-layout-table ref={innerRef as unknown as React.Ref<LayoutTableElement>}>
        {children}
      </x-layout-table>
    );
  },
);