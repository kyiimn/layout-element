import { TextInlineData } from "./text/text-inline.type";

/**
 * 텍스트 스레딩(threading) 데이터.
 *
 * 여러 문단 프레임(paragraph)이 하나의 연속 텍스트 흐름(story)을 공유하는
 * InDesign 텍스트 스레딩 모델이다. thread가 콘텐츠의 단일 소스(single source of
 * truth)이며, 프레임은 표시 범위(window)만 소유한다.
 *
 * - `content`: story 전체 텍스트. 첫 번째 프레임(head)의 `ParagraphEngine`이
 *   이 값을 `textContent`로 소유한다.
 * - `paragraphIds`: 흐름 순서대의 프레임 문단 id 배열. head(인덱스 0)가
 *   `content`를 소유하고, 나머지 프레임은 오버플로우 tail을 engine이
 *   feed-forward로 주입받는다 (프레임 데이터 `content`는 비어 있음).
 *
 * `DocumentEngine._layoutThreadedParagraphs()`가 `layoutText()`를 프레임 순서대로
 * 실행하며, 각 프레임이 넘치는 tail을 다음 프레임의 시작점으로 전달한다.
 *
 * @example
 * const doc: DocumentData = {
 *   width: 257, height: 370, columns: 6, gap: 3,
 *   paragraphStyle: {}, textStyle: {},
 *   children: [
 *     { type: 'box', id: 'box-a', ..., children: { type: 'paragraph', id: 'para-a', content: '...' } },
 *     { type: 'box', id: 'box-b', ..., children: { type: 'paragraph', id: 'para-b', content: '' } },
 *   ],
 *   threads: [{ id: 'thread-1', paragraphIds: ['para-a', 'para-b'] }],
 * };
 */
export type ThreadData = {
  /** 스레드 고유 식별자 */
  id?: string;

  /**
   * story 전체 콘텐츠 (단일 소스).
   * - `string`: 전체에 동일 스타일 적용
   * - `(string | TextInlineData)[]`: 구간별 개별 인라인 스타일
   */
  content?: string | (string | TextInlineData)[];

  /** 흐름 순서대의 프레임 문단 id 배열 (head가 content를 소유) */
  paragraphIds?: string[];
}