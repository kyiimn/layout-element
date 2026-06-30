import { Font } from "@/types";

/**
 * 폰트 로드 및 등록을 관리하는 싱글턴 매니저.
 *
 * `fonts.json`에서 `Font[]` 데이터를 로드하고,
 * `FontFace` API로 브라우저에 폰트를 등록한다.
 *
 * 인쇄 모드에서는 `base64Data`를 사용하여 외부 서버 요청 없이 폰트를 로드한다.
 * 화면 모드에서는 `ttfFilename`으로 서버에서 TTF 파일을 가져온다.
 */
export class FontManager {
  private static _instance?: FontManager;

  private _fontFaces: FontFace[] = [];
  private _ready: boolean = false;
  private _isPrint: boolean = false;

  private constructor() {
    this._isPrint = window.matchMedia("print").matches;
  }

  /** 서버에서 `fonts.json` 로드 */
  private async _loadServer() {
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
    this._ready = false;
    this._fontFaces = [];

    globalThis.document?.fonts.clear();

    try {
      if (this._isPrint) {
        if (!fonts) throw new Error('not given fonts');
        fonts.filter(f => f.base64Data).map(async f => {
          const fontFace = new FontFace(
            f.family,
            `url("data:font/ttf;base64,${f.base64Data}") format("truetype")`,
            { style: f.style, weight: `${f.weight}` }
          );
          globalThis.document?.fonts.add(fontFace);

          await fontFace.load();
        });
      } else {
        fonts = await this._loadServer();
        fonts.filter(f => f.ttfFilename).map(async f => {
          const fontFace = new FontFace(
            f.family,
            `url("${f.ttfFilename}") format("truetype")`,
            { style: f.style, weight: `${f.weight}` }
          );
          globalThis.document?.fonts.add(fontFace);

          await fontFace.load();
        });
      }
      this._ready = true;

      return this._fontFaces;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  /**
   * 폰트 패밀리명 반환.
   * @param _fontFamily 요청된 폰트 패밀리명 (현재 미사용)
   * @returns 기본 폰트 패밀리명
   */
  public getFontFamily(_fontFamily?: string) {
    if (!this.ready) throw new Error('font map is not ready');
    return 'Myoungjo';
  }

  get fontFaces() {
    if (!this.ready) throw new Error('font map is not ready');
    return this._fontFaces;
  }

  /** 초기화 완료 여부 */
  get ready() {
    return this._ready;
  }
};