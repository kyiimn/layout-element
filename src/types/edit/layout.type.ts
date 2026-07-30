import type { InsertMode } from "./insert.type";
import type { BoxRole } from "@/types/layout";

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

/**
 * 편집 모드 상태 스냅샷.
 *
 * `modeChange` 이벤트의 payload로 전달되며, 전환 전후의 모드 상태를 담는다.
 * 세 모드(text/layout/insert)는 동시에 하나만 활성화될 수 있으며,
 * 나머지는 항상 비활성화 상태이다.
 */
export interface EditModeState {
  /** 텍스트 편집 모드 활성 여부 */
  textEditMode: boolean;
  /** 레이아웃 편집 모드 활성 여부 */
  layoutEditMode: boolean;
  /** 레이아웃 편집 모드의 동작 타입 (layoutEditMode가 false여도 유지됨) */
  layoutEditType: LayoutEditType;
  /** 삽입 모드. `null`이면 비활성화 */
  insertMode: InsertMode | null;
}

/**
 * 레이아웃 요소 추가 이벤트 상세 정보.
 *
 * `layoutAdd` 이벤트는 레이아웃 요소(box, paragraph, image)가 DOM에 추가될 때 발생한다.
 * 삽입 모드, reparent, 프로그래밍 방식(`appendChildData`) 모두 포함한다.
 */
export interface LayoutAddEventDetail {
  /** 추가된 요소 (LayoutBoxElement | LayoutParagraphElement | LayoutImageElement) */
  element: HTMLElement;
  /** 추가된 요소의 부모 컨테이너 (LayoutDocumentElement | LayoutBoxElement) */
  container: HTMLElement;
  /** 추가 방식 */
  source: 'insert' | 'reparent' | 'programmatic';
}

/**
 * 레이아웃 요소 제거 이벤트 상세 정보.
 *
 * `layoutRemove` 이벤트는 레이아웃 요소(box, paragraph, image)가 DOM에서 제거될 때 발생한다.
 * reparent 시 이전 컨테이너에서 제거되는 경우와 프로그래밍 방식 제거 모두 포함한다.
 */
export interface LayoutRemoveEventDetail {
  /** 제거된 요소 (LayoutBoxElement | LayoutParagraphElement | LayoutImageElement) */
  element: HTMLElement;
  /** 제거되기 전 부모 컨테이너 (LayoutDocumentElement | LayoutBoxElement) */
  previousContainer: HTMLElement;
  /** 제거 방식 */
  source: 'reparent' | 'programmatic';
}

/**
 * Box 속성 변경 이벤트에서 변경된 속성을 식별하는 타입.
 *
 * `boxPropertyChange` 이벤트의 `property` 필드로 사용되며,
 * 어떤 속성이 변경되었는지 리스너에 알려준다.
 */
export type BoxPropertyName = 'role' | 'contentUid' | 'groupMember' | 'priority' | 'zIndex';

/**
 * Box 속성 변경 이벤트 상세 정보.
 *
 * `boxPropertyChange` 이벤트는 box의 의미적 속성(role, groupMember, priority)이
 * 프로그래밍 방식으로 변경될 때 발생한다. DOM 속성(attribute)만 변경된 경우에는
 * 발생하지 않는다.
 *
 * @example
 * ```ts
 * EditManager.getInstance().addEventListener('boxPropertyChange', (event) => {
 *   const { box, property, oldValue, newValue } = event.boxPropertyDetail!;
 *   console.log(`${box.id}.${property}: ${oldValue} → ${newValue}`);
 * });
 * ```
 */
export interface BoxPropertyChangeEventDetail {
  /** 속성이 변경된 box 요소 */
  box: HTMLElement;
  /** 변경된 속성명 */
  property: BoxPropertyName;
  /** 변경 전 값 */
  oldValue: BoxRole | string[] | number | string | undefined;
  /** 변경 후 값 */
  newValue: BoxRole | string[] | number | string | undefined;
}