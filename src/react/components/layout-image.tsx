import { forwardRef, useEffect } from 'react';
import { LayoutImageElement } from '@/components';
import type { ImageData, OverlapMode } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutImageProps {
  data: ImageData;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  dpi?: number;
  url?: string;
  zIndex?: number;
  overlapPadding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  overlapMode?: OverlapMode;
  aiProcessing?: boolean;
}

export const LayoutImage = forwardRef<LayoutImageElement, LayoutImageProps>(
  function LayoutImage({ data, x, y, width, height, dpi, url, zIndex, overlapPadding, overlapMode, aiProcessing }, ref) {
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
      const element = innerRef.current;
      if (!element || x === undefined) return;
      element.x = x;
    }, [innerRef, x]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || y === undefined) return;
      element.y = y;
    }, [innerRef, y]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || width === undefined) return;
      element.width = width;
    }, [innerRef, width]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || height === undefined) return;
      element.height = height;
    }, [innerRef, height]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || dpi === undefined) return;
      element.dpi = dpi;
    }, [innerRef, dpi]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || url === undefined) return;
      element.url = url;
    }, [innerRef, url]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || zIndex === undefined) return;
      element.zIndex = zIndex;
    }, [innerRef, zIndex]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || overlapPadding === undefined) return;
      element.overlapPadding = overlapPadding;
    }, [innerRef, overlapPadding]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || overlapMode === undefined) return;
      element.overlapMode = overlapMode;
    }, [innerRef, overlapMode]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || aiProcessing === undefined) return;
      element.aiProcessing = aiProcessing;
    }, [innerRef, aiProcessing]);

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
      <x-layout-image ref={innerRef} />
    );
  }
);
