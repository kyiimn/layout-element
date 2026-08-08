import { forwardRef, useEffect } from 'react';
import { LayoutTableElement } from '@/components';
import type { TableData } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutTableProps {
  data: TableData;
  colWidths?: number | number[];
  children?: React.ReactNode;
}

export const LayoutTable = forwardRef<LayoutTableElement, LayoutTableProps>(
  function LayoutTable({ data, children }, _ref) {
    const { ref: innerRef, define } = useLayoutElement<LayoutTableElement>();

    useEffect(() => {
      define('x-layout-table', LayoutTableElement);
    }, [define]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      element.data = data;
    }, [innerRef, data]);

    return (
      <x-layout-table ref={innerRef as unknown as React.Ref<LayoutTableElement>}>
        {children}
      </x-layout-table>
    );
  },
);