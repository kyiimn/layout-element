/** 수평 정렬 방식. 'justify'는 양쪽 정렬 (신문 본문에서 주로 사용) */
export type TextAlign = 'left' | 'right' | 'center' | 'justify';

/** 수직 정렬 방식. 박스 내에서 텍스트 콘텐츠의 수직 위치 */
export type VerticalAlign = 'top' | 'center' | 'bottom';

/**
 * 문단 수준의 레이아웃 속성을 정의.
 *
 * `lineGap`은 `fontSize`에 대한 **배율**이다. 실제 행 높이(lineHeight)는 다음과 같이 계산된다:
 * `lineHeight = fontSize × lineGap`
 *
 * | lineGap | fontSize (mm) | lineHeight (mm) | 설명 |
 * |---------|---------------|-----------------|------|
 * | 1 | 4 | 4 | 글자 크기와 행 높이 동일 (빽빽함) |
 * | 1.5 | 4 | 6 | 150% 행간 |
 * | 2 | 4 | 8 | 200% 행간 (더블 스페이싱) |
 */
export type ParagraphStyle = {
  /** 행간 배율. `lineHeight = fontSize × lineGap`. 기본값: 1 */
  lineGap?: number;

  /** 수직 정렬. 기본값: 'top' */
  verticalAlign?: VerticalAlign;

  /** 수평 정렬. 기본값: 'justify' */
  textAlign?: TextAlign;
}