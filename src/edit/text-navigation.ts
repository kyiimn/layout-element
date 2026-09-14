/**
 * TextEditController 키 네비게이션 서브모듈 — Arrow/Home/End 커서 이동 분기.
 *
 * `text-edit-controller.ts`의 `_onKeydown` 커서 이동 분기(ArrowLeft/Right/
 * Up/Down/Home/End)를 본문 그대로 이동한 파일이다. 컨트롤러 상태
 * (`_cursorModel`/`_mapper`/`_paragraph`/`_manager` 접근과 이동 후 갱신
 * 메서드)는 `NavContext` 인터페이스로 주입하며, bias 시맨틱(e13532a)·
 * phantom end placement·클램프/overflow 경계(`maxVisibleCursorOffset`)·
 * 키 시퀀스→caret px 좌표 계약은 1바이트도 변경하지 않는다.
 *
 * 컨트롤러는 dispatch(`_onKeydown`의 switch 라우팅)를 유지하고 각 케이스
 * 본문을 이 모듈의 함수에 위임한다 — 호출부 시그니처 불변.
 *
 * Tab/Backspace/Delete/Enter는 커서 이동이 아니라 편집·포커스 이동이므로
 * 컨트롤러에 남는다 (계획서 범위: 커서 이동 분기만).
 *
 * @file src/edit/text-navigation.ts
 */

import type { TextEditCoordinateMapper } from "./text-edit-coordinate-mapper";

/**
 * 키 네비게이션 모듈 함수가 소비하는 컨트롤러 상태·동작의 주입 경계.
 *
 * 컨트롤러가 스스로를 구현해 주입한다 — 필드 접근(`_cursorModel` 등)을
 * 모듈이 직접 알지 못하게 하고, 본문의 `this._*` 사용을 전수 확인한
 * 최소 집합만 노출한다. bias 시맨틱은 `cursor`의 `bias` 필드가 소유한다
 * (RULES.md §2.4 — bias는 위치 값의 소속 소유권).
 */
export interface NavContext {
  /** textarea plain 콘텐츠 (이동 경계 계산 기준). */
  readonly content: string;
  /** 현재 커서 source offset. */
  readonly offset: number;
  /** Ctrl/Meta 눌림 여부 (단어 단위 이동 분기). */
  readonly hasShortcut: boolean;
  /** Shift 눌림 여부 (선택 확장 분기). */
  readonly isShift: boolean;
  /** 현재 커서 모델 (offset/bias/selection — 직접 변형). */
  readonly cursor: { offset: number; bias: 'start' | 'end'; selection: unknown };
  /** 좌표 매핑기 (라인 경계/placement 조회). */
  readonly mapper: TextEditCoordinateMapper;
  /** 오버플로(숨김) 라인 진입 금지 경계 (null = 클램프 없음 — 스레드 프레임). */
  cursorMaxOffset(): number | null;
  /** Shift 이동의 선택 확장 (anchor 유지, bias → 'start'). */
  extendSelection(newOffset: number): void;
  /** 커서 이동 시 pending 스타일 해제 (Shift가 아닌 이동 경로 선행 호출). */
  releasePendingOnCursorMove(): boolean;
  /** 스레드 프레임 경계 이관 — 이관되면 true (호출자는 갱신 생략). */
  transferCursorAcrossThreadBoundary(approachDirection: 'left' | 'right' | null): boolean;
  /** 수직 이동 목표 offset 계산 (ArrowUp/Down). */
  computeVerticalOffset(direction: -1 | 1): number | null;
  /** 스레드 프레임 수직 경계 (ArrowDown — 다음 프레임 시작). */
  threadBoundaryDown(): number | null;
  /** 스레드 프레임 수직 경계 (ArrowUp — 현재 프레임 시작). */
  threadBoundaryUp(): number | null;
  /** 현재 프레임이 스레드 프레임인지 (수직 경계 이관 대상 판정). */
  readonly isThreadFrame: boolean;
  /** Ctrl+Home/End의 논리 라인 시작/끝 (전체 문서 라인 기준). */
  findLineStart(content: string, offset: number): number;
  findLineEnd(content: string, offset: number): number;
  /** Shift+Home/End와 Home/End의 논리 라인 경계. */
  getLogicalLineStart(offset: number): number;
  getEndKeyOffset(offset: number): number;
  /** 이동 후 textarea 선택 동기화. */
  syncTextareaSelection(): void;
  /** 이동 후 커서 렌더 배치. */
  updateCursorPosition(): void;
  /** 이동 후 selection 렌더 갱신. */
  updateSelection(): void;
  /** 이동 후 스타일 변화 통지 (Shift가 아닌 경로). */
  emitStyleChange(): void;
  /** cursorMove 이벤트 발화 (커서 키 경로). */
  notifyCursorMove(): void;
}

/**
 * ArrowLeft 커서 이동 분기 — `_onKeydown`의 `case "ArrowLeft"` 본문.
 *
 * bias 기반 순수 머신: {X, 'end'}(라인 시작 주차=이전 라인 끝)에서 Left →
 * 이전 라인 마지막 문자 {X-1, 'start'}; {X, 'start'}에서 Left → {X-1, 'start'}
 * (X-1이 라인 끝 문자면 {X, 'end'} 주차).
 *
 * @param ctx - 컨트롤러 상태·동작 주입 경계
 * @throws 없음
 */
export function navigateArrowLeft(ctx: NavContext): void {
  const { hasShortcut, isShift, offset } = ctx;
  let targetLeft: number;
  if (hasShortcut) {
    targetLeft = findWordStart(ctx.content, offset);
  } else if (isShift) {
    targetLeft = offset > 0 ? offset - 1 : offset;
  } else {
    // bias 기반 순수 머신 (라인 시작 주차 → 이전 라인 끝 → 전진의 3단계를
    // bias가 위치 값으로 소유한다 — 히스토리 플래그 없음):
    // - {X, 'end'} (라인 시작 주차=이전 라인 끝)에서 Left → 이전 라인 마지막 문자 {X-1, 'start'}
    //   (X가 라인 경계 = 이전 라인 끝+1이므로 X-1은 이전 라인의 마지막 가시 문자).
    // - {X, 'start'}에서 Left → {X-1, 'start'}. 단, X-1이 라인 끝 문자면
    //   그 문자의 우측이 라인 끝이므로 {X, 'end'}로 주차한다 (ArrowRight의
    //   atLastChar와 대칭 — 라인 내 이동과 경계 주차가 양방향 순환).
    const lineBounds = ctx.mapper.findVisualLineBounds(offset);
    const atLineStart = lineBounds && offset === lineBounds.start;
    if (ctx.cursor.bias === 'end' && atLineStart) {
      targetLeft = offset > 0 ? offset - 1 : offset;
    } else if (atLineStart) {
      targetLeft = offset;
    } else {
      targetLeft = offset > 0 ? offset - 1 : offset;
    }
  }
  if (isShift) {
    ctx.extendSelection(targetLeft);
  } else {
    ctx.releasePendingOnCursorMove();
    // ArrowLeft bias: 라인 시작에서 제자리 이동이면 이전 라인 끝 주차('end'),
    // 실제 이동이면 다음 글자 왼쪽('start').
    ctx.cursor.offset = targetLeft;
    ctx.cursor.bias = targetLeft === offset ? 'end' : 'start';
    ctx.cursor.selection = null;
    // 스레드 경계: 커서가 이 프레임 coverage를 벗어났으면 소유 프레임으로 이관.
    if (ctx.transferCursorAcrossThreadBoundary('left')) {
      ctx.notifyCursorMove();
      return;
    }
  }
  ctx.syncTextareaSelection();
  ctx.updateCursorPosition();
  ctx.updateSelection();
  if (!isShift) {
    ctx.emitStyleChange();
  }
  ctx.notifyCursorMove();
}

/**
 * ArrowRight 커서 이동 분기 — `_onKeydown`의 `case "ArrowRight"` 본문.
 *
 * bias 기반 순수 머신 (ArrowLeft와 대칭): {X, 'end'}에서 Right → {X, 'start'}
 * 전환; {X, 'start'}에서 Right → {X+1, 'start'} (X가 마지막 가시 문자면
 * 라인 끝 주차 {X+1, 'end'}). 착지가 maxVisibleCursorOffset 경계에
 * 도달/초과하면 경계로 클램프한다 (오버플로(숨김) 라인 진입 금지).
 *
 * @param ctx - 컨트롤러 상태·동작 주입 경계
 * @throws 없음
 */
export function navigateArrowRight(ctx: NavContext): void {
  const { hasShortcut, isShift, offset, content } = ctx;
  let targetRight: number;
  if (hasShortcut) {
    targetRight = findWordEnd(content, offset);
  } else if (isShift) {
    targetRight = offset < content.length ? offset + 1 : offset;
  } else {
    // bias 기반 순수 머신 (ArrowLeft와 대칭):
    // - {X, 'end'}에서 Right: X가 라인 끝 주차(이전 라인 끝+1)이므로 다음 라인
    //   첫 글자 {X, 'start'}로 전환 (경계 소속 전환 — 렌더가 다음 라인 시작으로).
    // - {X, 'start'}에서 Right: {X+1, 'start'}. 단, X가 마지막 가시 문자면
    //   라인 끝 주차 {X+1, 'end'} (라인 끝 문자 우측).
    const lineBounds = offset > 0 ? ctx.mapper.findVisualLineBounds(offset - 1) : null;
    const atLineEnd = lineBounds && offset === lineBounds.end;
    const atLastChar = lineBounds && offset === lineBounds.end - 1;
    if (ctx.cursor.bias === 'end' && atLineEnd) {
      targetRight = offset;
    } else if (atLastChar) {
      targetRight = offset + 1;
    } else {
      targetRight = offset < content.length ? offset + 1 : offset;
    }
  }
  // 오버플로(숨김) 라인 진입 금지: 착지가 maxVisibleCursorOffset 경계에
  // 도달/초과하면 경계로 되돌린다 — 경계 밖 배치는 숨김 라인의 span
  // placement를 참조하므로 커서 렌더 폴백이 깨진다.
  const maxOffset = ctx.cursorMaxOffset();
  if (maxOffset !== null && targetRight >= maxOffset) {
    targetRight = maxOffset;
  }
  if (isShift) {
    ctx.extendSelection(targetRight);
  } else {
    ctx.releasePendingOnCursorMove();
    ctx.cursor.offset = targetRight;
    // ArrowRight bias: 제자리 이동(라인 끝 주차)이면 'end' 유지, 실제 이동 중
    // 라인 끝 문자 우측 착지면 'end', 그 외 'start'.
    const lineBounds2 = targetRight > 0 ? ctx.mapper.findVisualLineBounds(targetRight - 1) : null;
    const targetAtLineEnd = lineBounds2 && targetRight === lineBounds2.end;
    ctx.cursor.bias = targetAtLineEnd ? 'end' : 'start';
    ctx.cursor.selection = null;
    // 스레드 경계: 커서가 이 프레임 coverage를 벗어났으면 소유 프레임으로
    // 이관한다. 이관되면 이 컨트롤러는 blur 상태가 되므로 갱신을 마친다.
    if (ctx.transferCursorAcrossThreadBoundary('right')) {
      ctx.notifyCursorMove();
      return;
    }
  }
  ctx.syncTextareaSelection();
  ctx.updateCursorPosition();
  ctx.updateSelection();
  if (!isShift) {
    ctx.emitStyleChange();
  }
  ctx.notifyCursorMove();
}

/**
 * ArrowUp/ArrowDown 커서 이동 분기 — `_onKeydown`의 수직 이동 케이스 본문.
 *
 * 아래 방향만 클램프 (위 방향은 오버플로 영역으로 진입하지 않는다).
 * 수직 이동 bias-carry: End 주차('end')에서 착지도 라인 끝 근처('end'),
 * Home 주차/일반('start')에서 착지도('start'). 스레드 프레임은 프레임 경계
 * 이관이 소유한다.
 *
 * @param ctx - 컨트롤러 상태·동작 주입 경계
 * @param direction - -1 (ArrowUp) 또는 1 (ArrowDown)
 * @returns 스레드 경계 이관으로 갱신이 종료됐으면 true (호출자는 공통 갱신 생략)
 * @throws 없음
 */
export function navigateVertical(ctx: NavContext, direction: -1 | 1): boolean {
  const { isShift, offset } = ctx;
  let newOffset = ctx.computeVerticalOffset(direction);
  // 아래 방향만 클램프 — 위 방향은 오버플로 영역으로 진입하지 않는다.
  // 스레드 프레임은 _cursorMaxOffset가 null이므로 클램프 없이 이관 로직이 그대로 동작한다.
  if (direction > 0) {
    const cursorMax = ctx.cursorMaxOffset();
    if (newOffset !== null && cursorMax !== null && newOffset > cursorMax) {
      newOffset = cursorMax;
    }
  }
  // 출발 소속(bias) 보존: bias 'start'(라인 시작 소속)에서 Up/Down하면 착지도
  // 라인 시작에 그려지고, bias 'end'(라인 끝 소속)에서 Up/Down하면 착지도
  // 라인 끝 근처에 그려진다 — 아래 bias-carry가 그 소유이며,
  // 수직 이동에서 bias는 유지된다 (착지 렌더가 기본 경로(preferLineEnd)로
  // 돌아가 라인 경계 offset이 이웃 라인을 참조하는 것을 방지).
  if (isShift) {
    ctx.extendSelection(newOffset ?? offset);
  } else {
    if (newOffset !== null) {
      ctx.cursor.offset = newOffset;
      // 수직 이동 bias-carry: End 주차('end')에서 착지도 라인 끝 근처('end'),
      // Home 주차/일반('start')에서 착지도('start') — 착지 렌더 소속 유지.
      ctx.cursor.bias = ctx.cursor.bias === 'end' ? 'end' : 'start';
    }
    ctx.cursor.selection = null;
    // 스레드 경계 (수직): 프레임 첫/마지막 라인에서 이동이 끝나면(null)
    // 이전/다음 프레임의 끝/시작 라인으로 커서를 넘긴다.
    if (newOffset === null && ctx.isThreadFrame) {
      const verticalTarget = direction > 0
        ? ctx.threadBoundaryDown()
        : ctx.threadBoundaryUp();
      if (verticalTarget !== null) {
        ctx.cursor.offset = verticalTarget;
        if (ctx.transferCursorAcrossThreadBoundary(direction > 0 ? 'right' : 'left')) {
          ctx.notifyCursorMove();
          return true;
        }
      }
    } else if (newOffset !== null && ctx.transferCursorAcrossThreadBoundary(direction > 0 ? 'right' : 'left')) {
      ctx.notifyCursorMove();
      return true;
    }
  }
  return false;
}

/**
 * Home 커서 이동 분기 — `_onKeydown`의 `case "Home"` 본문.
 *
 * bias 기반 순수 머신 (End case와 대칭): {X, 'end'}(End 주차)에서 Home →
 * 출발 라인 시작 (출발 라인은 bias가 소유 — offset-1로 이전 라인을 찾음);
 * {X, 'start'}에서 Home → 라인 시작, 'start' 유지.
 *
 * @param ctx - 컨트롤러 상태·동작 주입 경계
 * @returns 이동이 없어 조기 종료했으면 true (호출자는 공통 갱신 생략)
 * @throws 없음
 */
export function navigateHome(ctx: NavContext): boolean {
  const { hasShortcut, isShift, offset, content } = ctx;
  if (hasShortcut) {
    const lineStart = ctx.findLineStart(content, offset);
    if (isShift) { ctx.extendSelection(lineStart); } else { ctx.cursor.offset = lineStart; ctx.cursor.selection = null; }
  } else if (isShift) {
    const lineStart = ctx.getLogicalLineStart(offset);
    ctx.extendSelection(lineStart);
  } else {
    // bias 기반 순수 머신 (End case와 대칭):
    // - {X, 'end'} (End 주차 = 이전 라인 끝+1)에서 Home → 출발 라인 시작.
    //   출발 라인은 bias가 소유한다 — offset-1로 이전 라인을 찾아 시작으로 이동.
    //   (라인 끝 경계 offset은 getLineInfoBySourceOffset 기준 다음 라인 소속이므로
    //   offset-1로 출발 라인을 찾는다 — 이중 소속 함정).
    // - {X, 'start'}에서 Home → 라인 시작으로 이동, 'start' 유지.
    // - 이미 라인 시작 주차 {X, 'start'} (X === 라인 시작)에서 Home → 제자리.
    if (ctx.cursor.bias === 'end') {
      const sourceLineStart = ctx.getLogicalLineStart(Math.max(0, offset - 1));
      ctx.cursor.offset = sourceLineStart === offset ? offset : sourceLineStart;
    } else {
      const lineStart = ctx.getLogicalLineStart(offset);
      if (lineStart === offset && offset === 0) {
        return true;
      }
      ctx.cursor.offset = lineStart;
    }
    ctx.cursor.selection = null;
    ctx.cursor.bias = 'start';
  }
  return false;
}

/**
 * End 커서 이동 분기 — `_onKeydown`의 `case "End"` 본문.
 *
 * bias 기반 순수 머신 (Home case와 대칭): {X, 'end'}에서 End → 제자리;
 * {X, 'start'}에서 End → 라인 끝 이동 (경계 클램프 포함), 착지는 항상 'end'
 * 주차 (phantom end placement 참조).
 *
 * @param ctx - 컨트롤러 상태·동작 주입 경계
 * @throws 없음
 */
export function navigateEnd(ctx: NavContext): void {
  const { hasShortcut, isShift, offset } = ctx;
  if (hasShortcut) {
    let lineEnd = ctx.findLineEnd(ctx.content, offset);
    // Ctrl+End는 라인이 아닌 문서 끝으로 이동하므로 단일 블록 텍스트에서
    // 숨김 영역(오버플로 라인)에 착지할 수 있다 — 경계로 클램프한다.
    const endMax = ctx.cursorMaxOffset();
    if (endMax !== null && lineEnd > endMax) lineEnd = endMax;
    if (isShift) { ctx.extendSelection(lineEnd); } else { ctx.cursor.offset = lineEnd; ctx.cursor.selection = null; }
  } else if (isShift) {
    let lineEnd = ctx.getEndKeyOffset(offset);
    // Shift+End가 커서 경계(offset)의 논리 라인이 아닌 오버플로 라인의 끝을
    // 계산하는 케이스를 경계로 되돌린다 (커서가 숨김 영역의 offset 위에 있으면
    // getLineInfoBySourceOffset가 오버플로 라인을 반환한다).
    const shiftEndMax = ctx.cursorMaxOffset();
    if (shiftEndMax !== null && lineEnd > shiftEndMax) lineEnd = shiftEndMax;
    ctx.extendSelection(lineEnd);
  } else {
    // bias 기반 순수 머신 (Home case와 대칭):
    // - {X, 'end'}에서 End → 제자리 (이미 라인 끝 주차).
    // - {X, 'start'}에서 End → 라인 끝으로 이동. 단, X가 이미 라인 끝
    //   (X === 라인 끝 경계)이면 제자리.
    // - 착지는 항상 'end' 주차 (라인 끝 문자 우측, phantom end placement 참조).
    if (ctx.cursor.bias === 'end') {
      // 제자리
    } else {
      let endOffset = ctx.getEndKeyOffset(offset);
      // 커서가 경계(마지막 visible 라인 끝)에 있으면 논리 라인이 오버플로
      // 라인이라 그 끝이 숨김 영역에 착지한다 — 경계로 되돌린다. 경계 offset은
      // line-end phantom placement를 참조하므로 커서는 마지막 visible 문자
      // 오른쪽에 그려진다.
      const endKeyMax = ctx.cursorMaxOffset();
      if (endKeyMax !== null && endOffset > endKeyMax) endOffset = endKeyMax;
      ctx.cursor.offset = endOffset;
    }
    ctx.cursor.selection = null;
    ctx.cursor.bias = 'end';
  }
}

/**
 * Ctrl+ArrowLeft: 이전 단어의 시작 위치로 이동.
 * `_onKeydown`에서 `this._findWordStart`로 소비하던 본문의 모듈 이동판.
 *
 * @param content - textarea plain 콘텐츠
 * @param offset - 현재 커서 offset
 * @returns 이전 단어 시작 offset
 * @throws 없음
 */
export function findWordStart(content: string, offset: number): number {
  if (offset <= 0) return 0;
  let pos = offset;
  while (pos > 0 && /\s/.test(content[pos - 1])) {
    pos--;
  }
  while (pos > 0 && !/\s/.test(content[pos - 1])) {
    pos--;
  }
  return pos;
}

/**
 * Ctrl+ArrowRight: 다음 단어의 시작 위치로 이동.
 * `_onKeydown`에서 `this._findWordEnd`로 소비하던 본문의 모듈 이동판.
 *
 * @param content - textarea plain 콘텐츠
 * @param offset - 현재 커서 offset
 * @returns 다음 단어 시작 offset
 * @throws 없음
 */
export function findWordEnd(content: string, offset: number): number {
  if (offset >= content.length) return content.length;
  let pos = offset;
  while (pos < content.length && !/\s/.test(content[pos])) {
    pos++;
  }
  while (pos < content.length && /\s/.test(content[pos])) {
    pos++;
  }
  return pos;
}