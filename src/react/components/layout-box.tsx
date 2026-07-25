import { forwardRef, useEffect, type ReactNode } from 'react';
import { LayoutBoxElement } from '@/components';
import type { BoxData, BoxPosition, BoxBorderStyle, BoxRole } from '@/types';
import { useLayoutElement } from '@/react/hooks';

export interface LayoutBoxProps {
  data: BoxData;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  position?: BoxPosition;
  zIndex?: number;
  backgroundColor?: string;
  borderTopWidth?: number;
  borderBottomWidth?: number;
  borderLeftWidth?: number;
  borderRightWidth?: number;
  borderStyle?: BoxBorderStyle;
  borderColor?: string;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  editableLayout?: boolean;
  role?: BoxRole;
  contentUid?: string;
  groupMember?: string[];
  priority?: number;
  children?: ReactNode;
}

export const LayoutBox = forwardRef<LayoutBoxElement, LayoutBoxProps>(
  function LayoutBox({
    data,
    left,
    top,
    width,
    height,
    position,
    zIndex,
    backgroundColor,
    borderTopWidth,
    borderBottomWidth,
    borderLeftWidth,
    borderRightWidth,
    borderStyle,
    borderColor,
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    editableLayout,
    role,
    contentUid,
    groupMember,
    priority,
    children,
  }, ref) {
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
      const element = innerRef.current;
      if (!element || left === undefined) return;
      element.left = left;
    }, [innerRef, left]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || top === undefined) return;
      element.top = top;
    }, [innerRef, top]);

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
      if (!element || position === undefined) return;
      element.position = position;
    }, [innerRef, position]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || zIndex === undefined) return;
      element.zIndex = zIndex;
    }, [innerRef, zIndex]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || backgroundColor === undefined) return;
      element.backgroundColor = backgroundColor;
    }, [innerRef, backgroundColor]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || borderTopWidth === undefined) return;
      element.borderTopWidth = borderTopWidth;
    }, [innerRef, borderTopWidth]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || borderBottomWidth === undefined) return;
      element.borderBottomWidth = borderBottomWidth;
    }, [innerRef, borderBottomWidth]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || borderLeftWidth === undefined) return;
      element.borderLeftWidth = borderLeftWidth;
    }, [innerRef, borderLeftWidth]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || borderRightWidth === undefined) return;
      element.borderRightWidth = borderRightWidth;
    }, [innerRef, borderRightWidth]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || borderStyle === undefined) return;
      element.borderStyle = borderStyle;
    }, [innerRef, borderStyle]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || borderColor === undefined) return;
      element.borderColor = borderColor;
    }, [innerRef, borderColor]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || editableLayout === undefined) return;
      element.editableLayout = editableLayout;
    }, [innerRef, editableLayout]);

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
      const element = innerRef.current;
      if (!element || role === undefined) return;
      element.role = role;
    }, [innerRef, role]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || contentUid === undefined) return;
      element.contentUid = contentUid;
    }, [innerRef, contentUid]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || groupMember === undefined) return;
      element.groupMember = groupMember;
    }, [innerRef, groupMember]);

    useEffect(() => {
      const element = innerRef.current;
      if (!element || priority === undefined) return;
      element.priority = priority;
    }, [innerRef, priority]);

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
      <x-layout-box ref={innerRef}>
        {children}
      </x-layout-box>
    );
  }
);
