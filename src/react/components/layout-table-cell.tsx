import { forwardRef, useEffect } from 'react';
import { LayoutTableCellElement } from '@/components';
import type { TableCellData } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutTableCellProps {
  data: TableCellData;
  colspan?: number;
  rowspan?: number;
  backgroundColor?: string;
  backgroundOpacity?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  children?: React.ReactNode;
}

export const LayoutTableCell = forwardRef<LayoutTableCellElement, LayoutTableCellProps>(
  function LayoutTableCell({
    data,
    colspan,
    rowspan,
    backgroundColor,
    backgroundOpacity,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    children,
  }, ref) {
    const { ref: innerRef, define } = useLayoutElement<LayoutTableCellElement>();

    useEffect(() => {
      define('x-layout-td', LayoutTableCellElement);
    }, [define]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element) return;
      element.data = data;
    }, [innerRef, data]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || colspan === undefined) return;
      element.colspan = colspan;
    }, [innerRef, colspan]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || rowspan === undefined) return;
      element.rowspan = rowspan;
    }, [innerRef, rowspan]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || backgroundColor === undefined) return;
      element.backgroundColor = backgroundColor;
    }, [innerRef, backgroundColor]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || backgroundOpacity === undefined) return;
      element.backgroundOpacity = backgroundOpacity;
    }, [innerRef, backgroundOpacity]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || paddingTop === undefined) return;
      element.paddingTop = paddingTop;
    }, [innerRef, paddingTop]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || paddingRight === undefined) return;
      element.paddingRight = paddingRight;
    }, [innerRef, paddingRight]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || paddingBottom === undefined) return;
      element.paddingBottom = paddingBottom;
    }, [innerRef, paddingBottom]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || paddingLeft === undefined) return;
      element.paddingLeft = paddingLeft;
    }, [innerRef, paddingLeft]);

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
      <x-layout-td ref={innerRef as unknown as React.Ref<LayoutTableCellElement>}>
        {children}
      </x-layout-td>
    );
  },
);