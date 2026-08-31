declare module 'opentype.js' {
  export interface Glyph {
    advanceWidth: number;
  }
  export interface Font {
    charToGlyph(char: string): Glyph | null;
    charToGlyphIndex(char: string): number;
    unitsPerEm: number;
  }
  export function parse(buffer: ArrayBuffer): Font;
  const opentype: {
    parse: typeof parse;
  };
  export default opentype;
}