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
  colorUrl?: string;
  fontsUrl?: string;
  children: ReactNode;
}

function fetchColorSet(url: string): Promise<CMYKColorSet> {
  return fetch(url).then(res => {
    if (!res.ok) throw new Error(`failed to load color set from ${url}`);
    return res.json() as Promise<CMYKColorSet>;
  });
}

function fetchFonts(url: string): Promise<Font[]> {
  return fetch(url).then(res => {
    if (!res.ok) throw new Error(`failed to load fonts from ${url}`);
    return res.json() as Promise<Font[]>;
  });
}

export function LayoutProvider(props: LayoutProviderProps): ReactElement {
  const { colorSet, fonts, colorUrl = 'color.json', fontsUrl = 'fonts.json', children } = props;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const colorRegistry = ColorRegistry.getInstance();
  const fontLoader = FontLoader.getInstance();

  const initialize = useCallback(async () => {
    setReady(false);
    setError(null);

    try {
      const resolvedColorSet = colorSet ?? await fetchColorSet(colorUrl);
      const resolvedFonts = fonts ?? await fetchFonts(fontsUrl);

      await Promise.all([
        colorRegistry.init(resolvedColorSet),
        fontLoader.init(resolvedFonts),
      ]);
      setReady(true);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      setReady(false);
    }
  }, [colorRegistry, fontLoader, colorSet, fonts, colorUrl, fontsUrl]);

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
