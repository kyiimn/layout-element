/**
 * 레이아웃 편집 모드의 동작 타입.
 *
 * - `'move'`: 기본 이동 모드. 드래그하여 box를 현재 부모 내에서 이동한다.
 *   부모 경계를 벗어날 수 없으며, static 모드에서는 컬럼/라인 스냅이 적용된다.
 * - `'reparent'`: 부모 변경 모드. 드래그 중 부모 경계를 무시하고 자유롭게
 *   이동하며, mouseup 시 커서 위치의 컨테이너로 box를 reparenting한다.
 *   이를 통해 box를 다른 box 안으로 넣거나, 부모 밖으로 빼낼 수 있다.
 */
export type LayoutEditType = 'move' | 'reparent';

/**
 * 레이아웃 편집 모드 설정.
 *
 * `true`는 `{ type: 'move' }`와 동일하며, 하위 호환성을 보장한다.
 * `false`는 편집 모드 비활성화.
 */
export interface LayoutEditModeConfig {
  /** 편집 동작 타입 */
  type: LayoutEditType;
}

/**
 * `layoutEditMode` setter 입력 타입.
 *
 * - `true`  → `{ type: 'move' }` (기본 이동 모드)
 * - `false` → 편집 모드 비활성화
 * - `{ type: 'move' | 'reparent' }` → 지정한 타입으로 활성화
 */
export type LayoutEditModeInput = boolean | LayoutEditModeConfig;