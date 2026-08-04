declare module 'opentype.js' {
  export interface Glyph {
    advanceWidth: number;
  }
  export interface Font {
    charToGlyph(char: string): Glyph | null;
    unitsPerEm: number;
  }
  export function parse(buffer: ArrayBuffer): Font;
}