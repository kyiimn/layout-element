/**
 * 컬럼 가이드 표시 데이터.
 *
 * 편집 모드에서 텍스트 줄 위치를 시각적으로 안내하는 그리드의 위치·크기 정보.
 * 인쇄 모드에서는 요소가 숨겨지며, `printPostData`로 후처리 시스템에 전달된다.
 */
export type GuideColumnData = {
  /** 타입 식별자 (리터럴) */
  type: 'guide-column';

  /** 고유 식별자 (선택) */
  id?: string;

  /** 좌측 위치 (mm) */
  left: number;

  /** 상단 위치 (mm) */
  top: number;

  /** 너비 (mm) */
  width: number;

  /** 높이 (mm) */
  height: number;

  /** 표시 여부 */
  visible: boolean;

  /** 글꼴 크기 (mm) */
  fontSize: number;

  /** 줄 높이 (mm) */
  lineHeight: number;
};