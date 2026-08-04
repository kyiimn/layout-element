import { Font } from "@/types";
import opentype from "opentype.js";
import type { Font as OpentypeFont } from "opentype.js";

/**
 * 폰트 로드 함수 타입.
 *
 * 외부에서 `FontLoader.registerLoader()`로 등록할 커스텀 로더가
 * 반환해야 하는 시그니처.
 *
 * @returns 서버 또는 다른 소스에서 로드한 `Font[]`
 *
 * @example
 * ```ts
 * FontLoader.registerLoader(async () => {
 *   const res = await fetch('/api/v1/fonts');
 *   return res.json() as Promise<Font[]>;
 * });
 * ```
 */
export type FontLoaderFn = () => Promise<Font[]>;

/**
 * 폰트 로드 및 등록을 관리하는 싱글턴 매니저.
 *
 * `fonts.json`에서 `Font[]` 데이터를 로드하고,
 * `FontFace` API로 브라우저에 폰트를 등록한다.
 *
 * 인쇄 모드에서는 `base64Data`를 사용하여 외부 서버 요청 없이 폰트를 로드한다.
 * 화면 모드에서는 `ttfFilename`으로 서버에서 TTF 파일을 가져온다.
 *
 * `registerLoader()`로 커스텀 로더를 등록하면 기본 `fetch('fonts.json')` 대신
 * 해당 로더를 사용한다.
 */
export class FontLoader {
  private static _instance?: FontLoader;
  private static _customLoader?: FontLoaderFn;

  private _fontFaces: { name: string, fontFace: FontFace; }[] = [];
  private _ready: boolean = false;
  private _isPrint: boolean = false;
  private _lastFontsSignature?: string;

  /**
   * opentype.js 파싱 결과 캐시.
   * 폰트 패밀리명(`Font.family`)을 키로, 파싱된 opentype.js `Font` 객체를 값으로 저장한다.
   * `init()` 시 `base64Data`가 있는 폰트를 한 번 파싱하여 캐싱한다.
   * `_opentypeEnabled === false`이면 항상 빈 맵이다.
   */
  private _opentypeFonts: Map<string, OpentypeFont> = new Map();

  /**
   * opentype.js 모드 활성화 여부.
   * `init()` 후 `true`로 설정되며, `getOpenTypeFont()` 호출 시 활성화 상태를 확인한다.
   */
  private _opentypeEnabled: boolean = false;

  private constructor() {
    this._isPrint = window.matchMedia("print").matches;
  }

  /**
   * 커스텀 폰트 로더를 등록한다.
   *
   * 등록된 로더는 `_loadServer()`에서 기본 `fetch('fonts.json')` 대신 우선 사용된다.
   * 이미 초기화된 인스턴스가 있어도 새 로더가 다음 `init()` 호출부터 적용된다.
   *
   * @param loader - `Font[]`를 반환하는 비동기 함수
   *
   * @example
   * ```ts
   * // API 서버에서 폰트 데이터를 로드하도록 커스터마이징
   * FontLoader.registerLoader(async () => {
   *   const res = await fetch('/api/v1/fonts');
   *   if (!res.ok) throw new Error('failed to load fonts');
   *   return res.json() as Promise<Font[]>;
   * });
   * ```
   */
  public static registerLoader(loader: FontLoaderFn): void {
    FontLoader._customLoader = loader;
  }

  /**
   * 등록된 커스텀 로더를 제거하고 기본 로더로 되돌린다.
   */
  public static resetLoader(): void {
    FontLoader._customLoader = undefined;
  }

  /** 서버에서 `fonts.json` 로드 (또는 커스텀 로더 사용) */
  private async _loadServer(): Promise<Font[]> {
    if (FontLoader._customLoader) {
      return FontLoader._customLoader();
    }

    try {
      const res = await fetch('fonts.json');
      if (!res.ok) throw new Error('server connection error');

      const json = await res.json() as Font[];
      return json;
    } catch (e) {
      throw new Error("server connection error");
    }
  }

  /** 싱글턴 인스턴스 반환 */
  public static getInstance() {
    if (!this._instance) {
      this._instance = new this();
    }
    return this._instance;
  }

  public async init(fonts?: Font[]) {
    if (this._ready) {
      const prevSignature = this._lastFontsSignature;
      const candidateSignature = fonts !== undefined
        ? this._computeFontsSignature(fonts)
        : undefined;
      if (prevSignature !== undefined && candidateSignature === prevSignature) {
        return this._fontFaces;
      }
    }

    globalThis.document?.fonts.clear();

    try {
      if (this._isPrint) {
        if (!fonts) throw new Error('not given fonts');
        this._fontFaces = await Promise.all(
          fonts.filter(f => f.base64Data).map(async f => {
            const fontFace = new FontFace(
              f.family,
              `url("data:font/ttf;base64,${f.base64Data}") format("truetype")`,
              { style: f.style, weight: `${f.weight}` }
            );
            globalThis.document?.fonts.add(fontFace);

            return { name: f.family, fontFace: await fontFace.load() };
          })
        );
      } else {
        fonts = await this._loadServer();
        this._fontFaces = await Promise.all(
          fonts.filter(f => f.ttfFilename || f.base64Data).map(async f => {
            const source = f.base64Data
              ? `url("data:font/ttf;base64,${f.base64Data}") format("truetype")`
              : `url("${f.ttfFilename}") format("truetype")`;
            const fontFace = new FontFace(
              f.family,
              source,
              { style: f.style, weight: `${f.weight}` }
            );
            globalThis.document?.fonts.add(fontFace);

            return { name: f.family, fontFace: await fontFace.load() };
          })
        );
      }
      this._ready = true;
      this._lastFontsSignature = this._computeFontsSignature(fonts);

      await this._parseOpentypeFonts(fonts);

      return this._fontFaces;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  /**
  /**
   * 폰트 배열에서 opentype.js `Font` 객체를 파싱하여 캐싱한다.
   *
   * `base64Data`가 있는 폰트는 base64에서 직접 파싱하고, `ttfFilename`만 있는
   * 폰트는 fetch로 ArrayBuffer를 로드하여 파싱한다. 화면 모드에서는 대부분
   * `ttfFilename`을 사용하므로 이 경로가 필수적이다.
   *
   * @param fonts - 파싱할 폰트 배열
   */
  private async _parseOpentypeFonts(fonts: Font[]): Promise<void> {
    this._opentypeEnabled = true;
    this._opentypeFonts.clear();

    for (const f of fonts) {
      if (!f.base64Data && !f.ttfFilename) continue;
      try {
        let buffer: ArrayBuffer;
        if (f.base64Data) {
          const binaryString = atob(f.base64Data);
          buffer = new ArrayBuffer(binaryString.length);
          const view = new Uint8Array(buffer);
          for (let i = 0; i < binaryString.length; i++) {
            view[i] = binaryString.charCodeAt(i);
          }
        } else {
          const res = await fetch(f.ttfFilename!);
          buffer = await res.arrayBuffer();
        }
        const otFont = opentype.parse(buffer);
        this._opentypeFonts.set(f.family, otFont);
      } catch (e) {
        console.warn(`opentype.js parse failed for font "${f.family}"`, e);
      }
    }
  }

  /**
   * opentype.js로 파싱된 폰트 객체를 반환한다.
   *
   * @param fontName - 요청할 폰트 패밀리명. 생략 시 첫 번째 폰트.
   * @returns opentype.js `Font` 객체. 파싱 실패/해당 폰트 누락 시 `null` (canvas 모드 폴백).
   */
  public getOpenTypeFont(fontName?: string): OpentypeFont | null {
    if (!this._opentypeEnabled) return null;
    if (fontName) {
      return this._opentypeFonts.get(fontName) || null;
    }
    const first = this._opentypeFonts.values().next();
    return first.done ? null : first.value;
  }

  /** opentype.js 모드 활성화 여부. `init()` 완료 후 `true`. */
  public get opentypeEnabled(): boolean {
    return this._opentypeEnabled;
  }

  /**
   * 폰트 배열의 내용을 식별 가능한 문자열로 직렬화한다.
   *
   * 같은 폰트 데이터로 `init()`이 재호출되었는지 비교하기 위해 사용된다.
   * 배열 순서, 각 폰트의 `family`/`weight`/`style`/`ttfFilename`/`base64Data`를
   * 기준으로 결정론적 문자열을 생성한다.
   *
   * @param fonts - 직렬화할 폰트 배열
   * @returns 폰트 배열의 signature 문자열
   * @example
   * ```ts
   * const sig = loader._computeFontsSignature(fonts);
   * loader._lastFontsSignature = sig;
   * ```
   */
  private _computeFontsSignature(fonts: Font[]): string {
    return fonts
      .map(f => `${f.family}|${f.weight}|${f.style}|${f.ttfFilename ?? ''}|${f.base64Data ?? ''}`)
      .join('\n');
  }

  /**
   * 폰트 패밀리명 반환.
   * @param fontName 요청된 폰트명
   * @returns 기본 폰트 패밀리명
   */
  public getFontFamily(fontName?: string) {
    if (!this.ready) throw new Error('font map is not ready');
    return this._fontFaces.find(f => f.name === fontName)?.fontFace.family || this._fontFaces[0].fontFace.family;
  }

  get fontFaces() {
    if (!this.ready) throw new Error('font map is not ready');
    return this._fontFaces.map(f => f.fontFace);
  }

  /** 초기화 완료 여부 */
  get ready() {
    return this._ready;
  }
};