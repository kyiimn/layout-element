import type { CursorPosition } from './cursor.type';

/**
 * 텍스트 선택 영역을 나타낸다.
 *
 * `anchor`는 선택이 시작된 위치(사용자가 처음 누른 곳)이고,
 * `focus`는 선택이 끝난 위치(사용자가 드래그를 놓은 곳)이다.
 * 둘은 문서 순서와 무관하게 보존되며, 방향 선택(역방향 드래그)에서는
 * `anchor.textOffset > focus.textOffset`가 될 수 있다.
 *
 * 문서 순서대로 정렬된 시작/끝 위치가 필요하면 `normalized()`를 사용한다.
 */
export class SelectionRange {
  /** 선택 시작점 (사용자가 처음 누른 위치) */
  readonly anchor: CursorPosition;
  /** 선택 끝점 (사용자가 드래그를 놓은 위치) */
  readonly focus: CursorPosition;

  constructor(anchor: CursorPosition, focus: CursorPosition) {
    this.anchor = anchor;
    this.focus = focus;
  }

  /**
   * 텍스트 오프셋 두 개로 `SelectionRange`를 생성하는 팩토리 메서드.
   *
   * @param anchor - 선택 시작점의 문자 오프셋
   * @param focus  - 선택 끝점의 문자 오프셋
   */
  static fromOffsets(anchor: number, focus: number): SelectionRange {
    return new SelectionRange(
      { textOffset: anchor },
      { textOffset: focus },
    );
  }

  /**
   * anchor/focus를 문서 순서대로 정렬하여 반환한다.
   *
   * 항상 `start.textOffset <= end.textOffset`을 보장한다.
   * 역방향 선택(anchor > focus)에서도 올바른 범위를 얻을 수 있다.
   */
  normalized(): { start: CursorPosition; end: CursorPosition } {
    if (this.anchor.textOffset <= this.focus.textOffset) {
      return { start: this.anchor, end: this.focus };
    }
    return { start: this.focus, end: this.anchor };
  }
}