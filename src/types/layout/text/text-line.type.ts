import { TextBlockStyle } from "../../style";

/**
 * `ParagraphModel.preTextWrap()`의 출력물. 텍스트 래핑 후 **한 줄**에 해당하는 데이터.
 *
 * **내부 전용 타입**: 외부에서 직접 생성하지 않는다.
 * `ParagraphModel`이 텍스트 래핑 과정에서 자동 생성하며,
 * `LayoutColumnElement`와 `LayoutVirtualColumnElement`가 이 데이터를 소비하여 각 줄을 렌더링한다.
 *
 * 플래그 조합 예시:
 * | firstOfBlock | endOfBlock | firstOfText | endOfText | 의미 |
 * |:---:|:---:|:---:|:---:|------|
 * | ✓ | ✓ | ✓ | ✓ | 전체 텍스트가 한 줄 |
 * | ✓ | | ✓ | | 첫 블록의 첫 줄 |
 * | | ✓ | | | 어떤 블록의 마지막 줄 |
 * | ✓ | | | | 새 블록의 시작 줄 |
 * | | | | ✓ | 전체 텍스트의 마지막 줄 |
 */

export type OverlapParts = { x1: number; x2: number; };

export type TextPartData = {
  /** 이 파트(세그먼트)에 포함된 글자 배열 (글자 단위 분리) */
  content: string[];

  /** 줄 시작점으로부터의 좌측 여백 (mm) - 오버랩 요소 회피용 */
  left: number;

  /** 파트의 가로 폭 (mm) - 텍스트가 배치될 수 있는 공간 */
  width: number;
};

export type TextLineData = {
  /** 이 줄이 블록의 첫 번째 줄인지 */
  firstOfBlock?: boolean;

  /** 이 줄이 전체 텍스트의 첫 번째 줄인지 */
  firstOfText?: boolean;

  /** 이 줄이 블록의 마지막 줄인지 */
  endOfBlock?: boolean;

  /** 이 줄이 전체 텍스트의 마지막 줄인지 */
  endOfText?: boolean;

  /** 이 줄을 구성하는 수평 파트(오버랩 영역 사이의 세그먼트) 목록 */
  parts: TextPartData[];

  /** 이 줄에 적용되는 블록 스타일 */
  textBlockStyle?: TextBlockStyle;
};
