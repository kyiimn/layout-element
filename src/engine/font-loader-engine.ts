/**
 * Node.js 호환 폰트 로더 엔진.
 *
 * `FontLoader`에서 `FontFace`/`document.fonts` 의존성을 제거하고
 * `opentype.js` 파싱만 수행하는 순수 엔진.
 *
 * 브라우저의 `FontLoader` 싱글톤이 내부적으로 이 엔진을 소유하고
 * 폰트 메트릭 조회를 위임한다. Node 환경에서는 직접 사용.
 *
 * @file src/engine/font-loader-engine.ts
 */

import type { Font } from "@/types";
import type { FontLoaderEngine, ParsedFont } from "./types";

/**
 * opentype.js 모듈의 최소 인터페이스.
 * `opentype.parse(buffer)` → `Font` 객체.
 */
interface OpenTypeModule {
  parse(buffer: ArrayBuffer | Uint8Array): ParsedFont;
}

/**
 * opentype.js 모듈 로딩 (지연 로드).
 * 브라우저와 Node 모두에서 동작.
 */
let _opentype: OpenTypeModule | null = null;
async function getOpenType(): Promise<OpenTypeModule> {
  if (_opentype) return _opentype;
  const mod = await import("opentype.js");
  _opentype = mod as unknown as OpenTypeModule;
  return _opentype;
}

/**
 * Node.js 호환 폰트 메트릭 엔진.
 *
 * `FontFace` API 없이 `opentype.js`로 폰트를 파싱하여
 * 글리프 advanceWidth를 제공한다.
 *
 * @example
 * const engine = FontLoaderEngineImpl.create();
 * await engine.init([
 *   { family: 'Myoungjo', weight: 400, style: 'normal', base64Data: '...' },
 * ]);
 * const parsed = engine.getParsedFont('Myoungjo');
 * const glyph = parsed?.charToGlyph('한');
 * const width = glyph ? glyph.advanceWidth / parsed.unitsPerEm * 4 : 2;
 */
export class FontLoaderEngineImpl implements FontLoaderEngine {
  private _parsedFonts: Map<string, ParsedFont> = new Map();
  private _fonts: Font[] = [];
  private _ready: boolean = false;

  /**
   * 정적 팩토리 메서드.
   * @returns FontLoaderEngineImpl 인스턴스
   */
  static create(): FontLoaderEngineImpl {
    return new this();
  }

  private constructor() {}

  /** 초기화 완료 여부 */
  get ready(): boolean {
    return this._ready;
  }

  /**
   * 폰트 배열로 초기화한다.
   * `base64Data`가 있는 폰트만 파싱한다.
   * `ttfFilename`만 있는 폰트는 외부에서 fetch 후 base64Data를 채워 재호출해야 한다.
   *
   * @param fonts - 폰트 메타데이터 배열
   * @throws {Error} opentype.js 로드 실패 또는 파싱 실패 시
   */
  async init(fonts: Font[]): Promise<void> {
    this._fonts = fonts;
    this._parsedFonts.clear();

    const opentype = await getOpenType();

    for (const font of fonts) {
      if (!font.base64Data) continue;

      try {
        const binaryStr = atob(font.base64Data);
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        const parsed = opentype.parse(bytes.buffer);
        this._parsedFonts.set(font.family, parsed);
      } catch (e) {
        // 파싱 실패 시 해당 폰트만 스킵 (기존 FontLoader 동작과 일치)
      }
    }

    this._ready = true;
  }

  /**
   * 파싱된 폰트 객체를 반환한다.
   *
   * @param fontName - 폰트 family 이름. 생략 시 첫 번째 입력 폰트.
   * @returns ParsedFont 객체.
   * @throws {Error} 초기화 전이거나 폰트가 없는 경우.
   * @throws {Error} `fontName`이 지정되었으나 파싱 실패한 경우.
   * @throws {Error} `fontName` 생략 시 첫 번째 폰트가 파싱 실패한 경우.
   */
  getParsedFont(fontName?: string): ParsedFont | null {
    if (!this._ready || this._fonts.length === 0) {
      throw new Error("font map is not ready");
    }

    const targetName = fontName ?? this._fonts[0]!.family;
    const parsed = this._parsedFonts.get(targetName);
    if (parsed) return parsed;

    throw new Error(`parsed font not found: "${targetName}"`);
  }

  /**
   * 폰트 패밀리명을 반환한다.
   *
   * @param fontName - 조회할 family 이름. 생략 시 첫 번째 폰트.
   * @returns Font.family 문자열
   */
  getFontFamily(fontName?: string): string {
    if (!this._ready || this._fonts.length === 0) {
      throw new Error("font map is not ready");
    }

    if (fontName) {
      const font = this._fonts.find(f => f.family === fontName);
      if (font) return font.family;
    }

    return this._fonts[0].family;
  }
}