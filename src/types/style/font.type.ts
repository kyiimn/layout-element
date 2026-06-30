/**
 * 폰트 정보를 나타내는 타입.
 *
 * `FontManager`가 `fonts.json`에서 이 데이터를 로드하여 `FontFace` API로 브라우저에 등록한다.
 *
 * 인쇄 모드에서는 `base64Data`를 사용하여 외부 서버 요청 없이 폰트를 로드한다.
 * 화면 모드에서는 `ttfFilename`으로 서버에서 TTF 파일을 가져온다.
 */
export type Font = {
  /** 폰트 패밀리명 (예: "Noto Sans KR") */
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