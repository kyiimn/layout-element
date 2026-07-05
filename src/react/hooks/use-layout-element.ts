import {
  useRef,
  useEffect,
  useCallback,
  type RefObject,
} from 'react';

type Constructor<T> = abstract new () => T;

export interface UseLayoutElementReturn<T> {
  ref: RefObject<T | null>;
  define: (name: string, constructor: Constructor<T>) => void;
}

export function useLayoutElement<T extends HTMLElement>(): UseLayoutElementReturn<T> {
  const ref = useRef<T | null>(null);

  const define = useCallback((name: string, constructor: Constructor<T>) => {
    if (!customElements.get(name)) {
      customElements.define(name, constructor as unknown as CustomElementConstructor);
    }
  }, []);

  useEffect(() => {
    return () => {
      ref.current = null;
    };
  }, []);

  return { ref, define };
}
