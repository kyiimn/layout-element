/**
 * `LayoutParagraphElement`의 `render-complete` 커스텀 이벤트 페이로드.
 *
 * 단락 요소가 텍스트 래핑과 컬럼 DOM 생성을 모두 마친 직후 디스패치된다.
 * 호스트 프로그램은 이 이벤트를 수신하여 렌더링 결과(배치된 글자/라인 수,
 * 오버플로우 여부 및 통계)를 즉시 읽을 수 있다.
 *
 * 이 이벤트는 기존 `render-error` 이벤트를 대체하지 않는다.
 * `render-error`는 오버플로우가 발생한 경우에만 디스패치되지만,
 * `render-complete`는 오버플로우 발생 여부와 무관하게 **항상** 디스패치된다.
 * 두 이벤트는 동일한 `render()` 호출 내에서 순차적으로 발생하며
 * 서로의 리스너에 영향을 주지 않는다.
 *
 * @example
 * ```ts
 * const paragraph = document.querySelector('x-layout-paragraph')!;
 * paragraph.addEventListener('render-complete', (event) => {
 *   const detail = event.detail as RenderCompleteEventDetail;
 *   console.log('배치된 글자 수:', detail.placed.chars);
 *   console.log('배치된 라인 수:', detail.placed.lines);
 *   console.log('오버플로우 여부:', detail.overflow.hasOverflow);
 *   if (detail.overflow.hasOverflow) {
 *     console.log('오버플로우된 글자 수:', detail.overflow.chars);
 *     console.log('오버플로우된 라인 수:', detail.overflow.lines);
 *   }
 * });
 * ```
 */
export type RenderCompleteEventDetail = {
  /** 이벤트를 발생시킨 단락 요소의 타입 식별자 (항상 `'paragraph'`). */
  type: 'paragraph';

  /** 이벤트를 발생시킨 단락 요소의 고유 식별자. */
  id: string;

  /**
   * 컨테이너 영역 내에 실제로 배치된(보이는) 텍스트 통계.
   *
   * - `chars`: `display: none` 처리되지 않은 라인에 포함된 글자 수 총합.
   *   공백 문자, 줄 앞뒤로 제거된 공백은 `_stripSpaces` 로직에 따라
   *   렌더링된 span 개수 기준으로 집계된다.
   * - `lines`: `display: none` 처리되지 않은 라인 수.
   *   COVER 라인(`parts: []`)도 라인 수에 포함된다.
   */
  placed: {
    chars: number;
    lines: number;
  };

  /**
   * 컨테이너 영역을 벗어나 숨겨진 오버플로우 텍스트 통계.
   *
   * - `hasOverflow`: 오버플로우가 발생했는지 여부.
   *   `false`이면 `chars`와 `lines`는 모두 `0`이다.
   * - `chars`: `TextLayoutEngine.overflow` 값. 마지막 컬럼에서
   *   컨테이너 높이를 초과하여 배치된 글자 수.
   * - `lines`: `display: none` 처리된 라인 수.
   *   마지막 컬럼에서 누적 라인 높이가 `parentHeight`를 초과한 라인 수.
   */
  overflow: {
    hasOverflow: boolean;
    chars: number;
    lines: number;
  };

  /**
   * 단락이 렌더링에 사용한 컬럼 수.
   * `TextLayoutEngine.columnCount`와 동일하다.
   */
  columnCount: number;
};