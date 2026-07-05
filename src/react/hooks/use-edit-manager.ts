import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EditManager,
  EditManagerEvent,
  EditManagerEventType,
} from '@/edit/edit-manager';
import { LayoutParagraphElement } from '@/components/layout/paragraph.element';
import type { EditController, CurrentStyle } from '@/edit/edit-controller';
import type { SelectionRange } from '@/types/edit';

export interface UseEditManagerOptions {
  onFocusChange?: (event: EditManagerEvent) => void;
  onTextChange?: (event: EditManagerEvent) => void;
  onStyleChange?: (event: EditManagerEvent) => void;
  onSelectionStart?: (event: EditManagerEvent) => void;
  onSelectionEnd?: (event: EditManagerEvent) => void;
  onCursorMove?: (event: EditManagerEvent) => void;
}

export interface UseEditManagerReturn {
  focusedParagraph: LayoutParagraphElement | null;
  focusedController: EditController | null;
  cursorOffset: number | null;
  selection: SelectionRange | null;
  currentStyle: CurrentStyle | null;
  focusParagraph: (
    target: LayoutParagraphElement | string,
    options?: { cursorOffset?: number; selection?: SelectionRange },
  ) => boolean;
  blurParagraph: (target?: LayoutParagraphElement | string) => boolean;
}

const EVENT_TYPES: Array<{ key: keyof UseEditManagerOptions; type: EditManagerEventType }> = [
  { key: 'onFocusChange', type: 'focusChange' },
  { key: 'onTextChange', type: 'textChange' },
  { key: 'onStyleChange', type: 'styleChange' },
  { key: 'onSelectionStart', type: 'selectionStart' },
  { key: 'onSelectionEnd', type: 'selectionEnd' },
  { key: 'onCursorMove', type: 'cursorMove' },
];

export function useEditManager(
  options: UseEditManagerOptions = {},
): UseEditManagerReturn {
  const manager = EditManager.getInstance();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [focusedParagraph, setFocusedParagraph] =
    useState<LayoutParagraphElement | null>(manager.focusedParagraph);
  const [focusedController, setFocusedController] =
    useState<EditController | null>(manager.focusedController);
  const [cursorOffset, setCursorOffset] = useState<number | null>(manager.cursorOffset);
  const [selection, setSelection] = useState<SelectionRange | null>(manager.selection);
  const [currentStyle, setCurrentStyle] = useState<CurrentStyle | null>(manager.currentStyle);

  const syncState = useCallback(() => {
    setFocusedParagraph(manager.focusedParagraph);
    setFocusedController(manager.focusedController);
    setCursorOffset(manager.cursorOffset);
    setSelection(manager.selection);
    setCurrentStyle(manager.currentStyle);
  }, [manager]);

  useEffect(() => {
    const listeners: Array<{ type: EditManagerEventType; listener: (event: EditManagerEvent) => void }> = [];

    for (const { key, type } of EVENT_TYPES) {
      const listener = (event: EditManagerEvent) => {
        syncState();
        const handler = optionsRef.current[key];
        if (handler) handler(event);
      };
      manager.addEventListener(type, listener);
      listeners.push({ type, listener });
    }

    return () => {
      for (const { type, listener } of listeners) {
        manager.removeEventListener(type, listener);
      }
    };
  }, [manager, syncState]);

  const focusParagraph = useCallback(
    (target: LayoutParagraphElement | string, focusOptions?: { cursorOffset?: number; selection?: SelectionRange }): boolean =>
      manager.focusParagraph(target, focusOptions),
    [manager],
  );

  const blurParagraph = useCallback(
    (target?: LayoutParagraphElement | string): boolean => manager.blurParagraph(target),
    [manager],
  );

  return {
    focusedParagraph,
    focusedController,
    cursorOffset,
    selection,
    currentStyle,
    focusParagraph,
    blurParagraph,
  };
}
