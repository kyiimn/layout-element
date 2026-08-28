/**
 * 소스 텍스트 문자열 내의 커서 위치.
 *
 * `textOffset`은 `\n`을 포함한 전체 소스 문자열에서의 문자 오프셋이다.
 * DOM 위치가 아닌, 콘텐츠 모델 기반의 위치 표현이다.
 *
 * V1: 평문(`string`) 콘텐츠만 지원.
 * 향후 `(string | TextInlineData)[]` 편집 지원 시 `blockIndex` 필드가 추가될 수 있다.
 */
export type CursorPosition = {
  /** `\n`을 포함한 소스 텍스트 문자열 내 문자 오프셋 (0-based) */
  textOffset: number;
};