/**
 * 폰트 정보를 나타내는 타입.
 *
 * `FontLoader`가 `fonts.json`에서 이 데이터를 로드하여 `FontFace` API로 브라우저에 등록한다.
 *
 * 인쇄 모드에서는 `base64Data`를 사용하여 외부 서버 요청 없이 폰트를 로드한다.
 * 화면 모드에서는 `ttfFilename`으로 서버에서 TTF 파일을 가져온다.
 *
 * `Font.family` 값이 곧 스타일 필드의 폰트 패밀리 값이다. `TextStyle.fontFamily`,
 * `TextBlockStyle.fontFamily`는 모두 여기에 등록된 `Font.family` 값만
 * 사용해야 하며, `FontLoader.getFontFamily()`가 일치하는 폰트를 찾아
 * 실제 `FontFace.family`를 반환한다. 일치하지 않으면 등록된 첫 번째 폰트로
 * 폴백된다. CSS `font-family` 키워드(`"serif"`, `"sans-serif"` 등)는
 * 사용할 수 없다.
 */
export type Font = {
  /**
   * 폰트 패밀리명 (예: "Myoungjo", "Noto Sans KR").
   *
   * 이 값이 스타일 필드(`TextStyle.fontFamily` 등)에서 참조하는
   * 식별자이다. `FontLoader.getFontFamily(name)`이 일치하는 `family`를
   * 찾아 실제 `FontFace.family`를 반환한다.
   */
  family: string;

  /** 폰트 굵기 (400, 700 등) */
  weight: number;

  /** 폰트 스타일 */
  style: 'normal' | 'italic';

  /** TTF 파일명 (서버에서 로드할 때 사용) */
  ttfFilename?: string;

  /** Base64 인코딩된 폰트 데이터 (인라인 로드용) */
  base64Data?: string;
};