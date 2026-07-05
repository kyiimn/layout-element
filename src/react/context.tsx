import type { ReactNode, ReactElement } from 'react';
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  createElement,
} from 'react';
import { ColorRegistry, FontLoader } from '@/resource';
import { CMYKColorSet, Font } from '@/types';

export interface LayoutContextValue {
  ready: boolean;
  error: Error | null;
  colorRegistry: ColorRegistry;
  fontLoader: FontLoader;
}

export const LayoutContext = createContext<LayoutContextValue | null>(null);

export interface LayoutProviderProps {
  colorSet?: CMYKColorSet;
  fonts?: Font[];
  children: ReactNode;
}

export function LayoutProvider(props: LayoutProviderProps): ReactElement {
  const { colorSet, fonts, children } = props;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const colorRegistry = ColorRegistry.getInstance();
  const fontLoader = FontLoader.getInstance();

  const initialize = useCallback(async () => {
    setReady(false);
    setError(null);
    try {
      if (colorSet || fonts) {
        // Print mode or explicit data injection: pass data directly
        await Promise.all([
          colorRegistry.init(colorSet),
          fontLoader.init(fonts),
        ]);
      } else {
        // Non-print mode: let managers fetch from their default URLs
        await Promise.all([
          colorRegistry.init(),
          fontLoader.init(),
        ]);
      }
      setReady(true);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      setReady(false);
    }
  }, [colorRegistry, fontLoader, colorSet, fonts]);

  useEffect(() => {
    initialize();
  }, [initialize]);

  const value: LayoutContextValue = {
    ready,
    error,
    colorRegistry,
    fontLoader,
  };

  return createElement(LayoutContext.Provider, { value }, children);
}

export function useLayoutContext(): LayoutContextValue {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error('useLayoutContext must be used within a LayoutProvider');
  }
  return context;
}
