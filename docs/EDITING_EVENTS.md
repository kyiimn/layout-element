# layout-element EditManager 이벤트 상세 명세

> 작성 기준: `src/edit/edit-manager.ts`, `src/edit/insert-controller.ts`, `src/edit/layout-edit-controller.ts`, `src/edit/text-edit-controller.ts`
>
> 본 문서는 `EditManager`에서 발생하는 모든 이벤트 타입, payload 필드, 발생 트리거, 리스너 등록/해제 방법, 재진입 보호, 클릭 억제 플래그 등을 상세히 기술한다.

---

## 1. 개요 (Overview)

`EditManager`는 `layout-element`의 글로벌 편집 관리 싱글톤으로, 텍스트 편집, 레이아웃 선택, 드래그 이동, 리사이즈, 요소 삽입, Box 속성 변경 등의 상태 변화를 외부 UI에 알리기 위해 15가지 이벤트 타입을 제공한다. 외부 편집 UI는 `addEventListener`로 이벤트를 수신하여 상태 동기화, undo/redo 스택, 스타일 패널 갱신 등을 수행한다.

### 1.1 이벤트 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────────────────┐
│  EditManager (singleton)                                             │
│                                                                      │
│  ├── _listeners: Map<EditManagerEventType, Set<EditManagerEventListener>>│
│  ├── _dispatching: boolean (재진입 보호)                              │
│  ├── _suppressNextClick: boolean (삽입 직후 클릭 억제)                │
│  ├── _clickConsumeHandler: ((e: MouseEvent) => void) | null         │
│  │   (드래그/리사이즈 후 window capture 클릭 소비 리스너)            │
│  ├── _clickConsumeTimer: ReturnType<setTimeout> | null              │
│  │   (click 소비 리스너 자동 제거 타이머, 200ms)                     │
│                                                                      │
│  공개 API:                                                            │
│  ├── addEventListener(type, listener)                                │
│  └── removeEventListener(type, listener)                             │
│                                                                      │
  │  내부 디스패처:                                                       │
  │  ├── _dispatch(type, controller, previousParagraph?, previousController?)│
  │  ├── _dispatchLayoutSelection(previousLayouts)                       │
  │  ├── _dispatchLayoutMove(element, prevLeft, prevTop, left, top, canceled)│
  │  ├── _dispatchLayoutResize(element, prevL, prevT, prevW, prevH, l, t, w, h, canceled)│
  │  ├── _dispatchInsert(detail: InsertEventDetail)                      │
  │  ├── _dispatchInsertCancel()                                         │
  │  ├── _dispatchLayoutAdd(detail: LayoutAddEventDetail)                │
  │  ├── _dispatchLayoutRemove(detail: LayoutRemoveEventDetail)           │
  │  ├── _dispatchBoxPropertyChange(detail: BoxPropertyChangeEventDetail) │
  │  └── _dispatchModeChange(previousMode)                               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 공개 API

### 2.1 `addEventListener(type, listener)`

```typescript
manager.addEventListener('focusChange', (event) => {
  console.log('포커스 이동:', event.previousParagraph?.id, '→', event.paragraph.id);
});
```

| 매개변수 | 타입 | 설명 |
|----------|------|------|
| `type` | `EditManagerEventType` | 이벤트 타입 |
| `listener` | `EditManagerEventListener` | `(event: EditManagerEvent) => void` |

동일한 `type`에 여러 리스너를 등록할 수 있으며, 등록 순서대로 호출된다. 동일한 리스너 참조는 `Set`에 의해 중복 등록되지 않는다.

### 2.2 `removeEventListener(type, listener)`

```typescript
const handler = (event) => { /* ... */ };
manager.addEventListener('focusChange', handler);
// ...
manager.removeEventListener('focusChange', handler);
```

| 매개변수 | 타입 | 설명 |
|----------|------|------|
| `type` | `EditManagerEventType` | 이벤트 타입 |
| `listener` | `EditManagerEventListener` | 제거할 리스너 |

등록되지 않은 리스너를 제거하려 해도 에러가 발생하지 않는다.

### 2.3 React 훅: `useEditManager`

```tsx
import { useEditManager } from 'layout-element/react';

function MyComponent() {
  const { focusedParagraph, currentStyle, onTextChange } = useEditManager({
    onFocusChange: (event) => { /* ... */ },
    onTextChange: (event) => { /* ... */ },
    onLayoutSelectionChange: (event) => { /* ... */ },
    onLayoutMove: (event) => { /* ... */ },
    onInsert: (event) => { /* ... */ },
  });
  // ...
}
```

`useEditManager` 훅은 마운트 시 `addEventListener`로 리스너를 등록하고 언마운트 시 `removeEventListener`로 해제한다. 자세한 훅 API는 `EDITING_LAYOUT.md`와 `EDITING_TEXT.md`를 참조한다.

### 2.4 `reset()` — 편집 상태 전체 초기화 (unmount용)

`EditManager`는 싱글톤이므로 컴포넌트 전환(React unmount/remount 등) 시에도 인스턴스가
유지된다. 이전 문서의 편집 상태(선택, 포커스, 모드, 컨트롤러, 필터)가 새 문서로
누출되어 요소 그리기 등의 동작을 방해하지 않도록, `LayoutEditor` 컴포넌트가
unmount될 때 `reset()`을 호출한다.

```typescript
// React 예시
React.useEffect(() => {
  return () => { EditManager.getInstance().reset(); };
}, []);
```

`reset()`이 초기화하는 항목:

| 항목 | 초기화 동작 |
|---|---|
| 선택된 레이아웃 요소 DOM | `selected`, `text-focused` 속성 제거 |
| `_selectedLayouts` | `[]` |
| 포커스된 컨트롤러 | `_blurFocusedParagraph()` + `_focusedController = null` + `_lastFocusedBox = null` |
| 드래그/리사이즈 상태 | `_isLayoutDragging = false`, `_isLayoutResizing = false`, `_dragTargets = []`, `_dragStartPositions.clear()` |
| 편집 모드 | `_textEditMode = false`, `_layoutEditMode = false`, `_layoutEditType = 'move'`, `_insertMode = null` |
| 필터 | `_editableRoles`/`_editableBoxIds`/`_editableTextRoles`/`_editableTextBoxIds`/`_editableParagraphIds`/`_selectableRoles`/`_selectableBoxIds`/`_selectableRootId`/`_editableRootId` = `null` |
| 하위 컨트롤러 | `_layoutEditController.destroy()` 후 `null`, `_insertController = null`, `_placeGunController = null` |
| 클릭 소비 | `_removeClickConsumeHandler()`, `_suppressNextClick = false` |
| Place Gun 상태 | `_placeGunItems = []`, `_placeGunPaused = false` |
| 멀티셀렉트 | `_multiSelect = false` |
| scale | `1` |
| 문서 내 편집 가능 속성 | `x-layout-box[editable-layout]`과 `x-layout-paragraph[editable-text]`를 순회하며 `editableLayout`/`editableText`를 `false`로 설정 |
| 이벤트 리스너 | 제거하지 않음 (React `useEffect` cleanup이 담당) |

`reset()` 종료 시 `modeChange` 이벤트가 발생한다 (`previousMode` = reset 전 모드, `mode` = 모두 비활성화 상태).

---

## 3. 타입 정의

### 3.1 `EditManagerEventType`

```typescript
export type EditManagerEventType =
  | 'focusChange'
  | 'textChange'
  | 'styleChange'
  | 'selectionStart'
  | 'selectionEnd'
  | 'cursorMove'
  | 'layoutSelectionChange'
  | 'layoutMove'
  | 'layoutResize'
  | 'layoutAdd'
  | 'layoutRemove'
  | 'insert'
  | 'insertCancel'
  | 'modeChange'
  | 'boxPropertyChange'
  | 'placeGunChange';
```

### 3.2 `EditManagerEvent`

```typescript
export interface EditManagerEvent {
  type: EditManagerEventType;
  paragraph: LayoutParagraphElement;
  controller: TextEditController;
  previousParagraph?: LayoutParagraphElement | null;
  previousController?: TextEditController | null;
  selectedLayouts?: LayoutElement[];
  previousLayouts?: LayoutElement[];
  layoutElement?: LayoutElement;
  element?: HTMLElement;
  container?: HTMLElement;
  /** reparent 모드에서 이동 후 부모 컨테이너 (layoutMove 이벤트에서만) */
  newContainer?: HTMLElement;
  /** reparent 모드에서 이동 전 부모 컨테이너 (layoutMove 이벤트에서만) */
  previousContainer?: HTMLElement;
  previousLeft?: number;
  previousTop?: number;
  left?: number;
  top?: number;
  canceled?: boolean;
  previousWidth?: number;
  previousHeight?: number;
  width?: number;
  height?: number;
  position?: InsertPosition;
  zIndex?: number;
  /** 레이아웃 요소 추가 상세 정보 (layoutAdd 이벤트에서만) */
  layoutAddDetail?: LayoutAddEventDetail;
  /** 레이아웃 요소 제거 상세 정보 (layoutRemove 이벤트에서만) */
  layoutRemoveDetail?: LayoutRemoveEventDetail;
  /** 모드 전환 전 상태 (modeChange 이벤트에서만) */
  previousMode?: EditModeState;
  /** 모드 전환 후 상태 (modeChange 이벤트에서만) */
  mode?: EditModeState;
  /** Box 속성 변경 상세 정보 (boxPropertyChange 이벤트에서만) */
  boxPropertyDetail?: BoxPropertyChangeEventDetail;
  /** Place Gun 상태 변경 상세 정보 (placeGunChange 이벤트에서만) */
  placeGunDetail?: PlaceGunChangeEventDetail;
}
```

### 3.3 `EditManagerEventListener`

```typescript
export type EditManagerEventListener = (event: EditManagerEvent) => void;
```

---

## 4. 이벤트 카테고리

`EditManagerEventType`는 세 가지 카테고리로 분류된다:

| 카테고리 | 이벤트 타입 | 발생 주체 |
|----------|------------|----------|
| **텍스트 편집** | `focusChange`, `textChange`, `styleChange`, `selectionStart`, `selectionEnd`, `cursorMove` | `TextEditController` |
| **레이아웃 편집** | `layoutSelectionChange`, `layoutMove`, `layoutResize`, `layoutAdd`, `layoutRemove` | `LayoutEditController`, `LayoutSelectionController`, `InsertController`, `EditManager.selectLayout` |
| **삽입 모드** | `insert`, `insertCancel` | `InsertController` |
| **모드 전환** | `modeChange` | `EditManager` (textEditMode/layoutEditMode/insertMode setter) |
| **Box 속성 변경** | `boxPropertyChange` | `LayoutBoxElement` (role/contentUid/groupMember/priority setter) |
| **Place Gun** | `placeGunChange` | `EditManager` (load/unload/remove/reorder/pause) |

---

## 5. 텍스트 편집 이벤트

텍스트 편집 이벤트는 `TextEditController`가 `EditManager._dispatch(type, controller, ...)`를 통해 발생시킨다. 모두 `paragraph`와 `controller` 필드를 가지며, `focusChange`는 추가로 `previousParagraph`와 `previousController`를 가진다.

레이아웃/삽입 이벤트에서는 `paragraph`와 `controller`가 `null as unknown as ...`로 설정된다 (이벤트 payload에 불필요).

### 5.1 `focusChange`

포커스가 다른 단락으로 이동할 때 발생한다.

```typescript
manager.addEventListener('focusChange', (event) => {
  console.log(event.type);              // 'focusChange'
  console.log(event.paragraph);         // 새로 포커스된 LayoutParagraphElement
  console.log(event.controller);        // 새 TextEditController
  console.log(event.previousParagraph); // 이전 LayoutParagraphElement | null
  console.log(event.previousController);// 이전 TextEditController | null
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'focusChange'` | 이벤트 타입 |
| `paragraph` | `LayoutParagraphElement` | 새로 포커스된 단락 |
| `controller` | `TextEditController` | 새 편집 컨트롤러 |
| `previousParagraph` | `LayoutParagraphElement \| null` | 이전 포커스 단락. 처음 포커스 시 `null` |
| `previousController` | `TextEditController \| null` | 이전 편집 컨트롤러. 처음 포커스 시 `null` |

**발생 트리거**:

| 트리거 | 호출 경로 | `previousParagraph` |
|--------|----------|---------------------|
| 다른 단락 클릭/포커스 | `TextEditController._onFocus()` → `_requestFocus()` → `_dispatch('focusChange', controller, previousParagraph, previousController)` | 이전 포커스 단락 |
| 포커스 해제 | `TextEditController._onBlur()` → `_releaseFocus()` → `_dispatch('focusChange', controller, previousParagraph, controller)` | 해제된 단락 |
| 컨트롤러 파괴 | `_unregister(controller)` (포커스 중인 경우) → `_dispatch('focusChange', controller, previousParagraph, controller)` | 해제된 단락 |
| `EditManager.focusParagraph(target, options?)` | 내부적으로 `_requestFocus()` 호출 | 이전 포커스 단락 |

**주의**: `_releaseFocus`와 `_unregister`에서는 `controller` 인자가 "이전 컨트롤러"로 전달되므로, `event.controller`는 여전히 해제된 컨트롤러를 가리킨다. `event.paragraph`도 해제된 단락이다. 이 경우 외부 UI는 `manager.focusedParagraph === null`을 확인하여 포커스가 해제되었음을 감지해야 한다.

### 5.2 `textChange`

텍스트 내용이 변경될 때 발생한다 (입력, 삭제, 붙여넣기, 줄바꿈).

```typescript
manager.addEventListener('textChange', (event) => {
  console.log(event.paragraph);  // 변경된 단락
  console.log(event.controller); // 편집 컨트롤러
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'textChange'` | 이벤트 타입 |
| `paragraph` | `LayoutParagraphElement` | 텍스트가 변경된 단락 |
| `controller` | `TextEditController` | 편집 컨트롤러 |

**발생 트리거**: `TextEditController`에서 텍스트가 변경될 때 `EditManager._notifyTextChange(controller)` → `_dispatch('textChange', controller)`.

### 5.3 `styleChange`

커서 위치가 변경되어 유효 스타일이 달라질 때 발생한다.

```typescript
manager.addEventListener('styleChange', (event) => {
  console.log(event.paragraph);
  console.log(event.controller);
  // 편집 UI의 스타일 패널을 새 스타일로 갱신
  updateStylePanel(manager.currentStyle);
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'styleChange'` | 이벤트 타입 |
| `paragraph` | `LayoutParagraphElement` | 단락 |
| `controller` | `TextEditController` | 편집 컨트롤러 |

**발생 트리거**: `TextEditController`에서 스타일이 변경될 때 `EditManager._notifyStyleChange(controller)` → `_dispatch('styleChange', controller)`.

### 5.4 `selectionStart`

마우스 드래그로 텍스트 선택이 시작될 때 발생한다.

```typescript
manager.addEventListener('selectionStart', (event) => {
  console.log('선택 시작:', event.paragraph.id);
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'selectionStart'` | 이벤트 타입 |
| `paragraph` | `LayoutParagraphElement` | 단락 |
| `controller` | `TextEditController` | 편집 컨트롤러 |

**발생 트리거**: `TextEditController`에서 마우스 드래그 선택이 시작될 때 `EditManager._notifySelectionStart(controller)` → `_dispatch('selectionStart', controller)`.

### 5.5 `selectionEnd`

마우스 드래그가 끝나고 텍스트 선택이 확정될 때 발생한다.

```typescript
manager.addEventListener('selectionEnd', (event) => {
  console.log('선택 종료:', event.paragraph.id);
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'selectionEnd'` | 이벤트 타입 |
| `paragraph` | `LayoutParagraphElement` | 단락 |
| `controller` | `TextEditController` | 편집 컨트롤러 |

**발생 트리거**: `TextEditController`에서 마우스 드래그 선택이 종료될 때 `EditManager._notifySelectionEnd(controller)` → `_dispatch('selectionEnd', controller)`.

### 5.6 `cursorMove`

커서 위치가 변경될 때 발생한다. 키보드 입력, 마우스 클릭, 외부 API 등 커서 위치가 변경될 때마다 발생한다. **키보드 연속 입력 시 최초 KeyDown과 마지막 KeyUp에만 발생**한다 (쓰로틀링).

```typescript
manager.addEventListener('cursorMove', (event) => {
  console.log('커서 이동:', event.controller.cursorOffset);
  // 커서 위치 기반 UI 업데이트 (줄/열 표시, 스크롤 동기화 등)
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'cursorMove'` | 이벤트 타입 |
| `paragraph` | `LayoutParagraphElement` | 단락 |
| `controller` | `TextEditController` | 편집 컨트롤러 |

**발생 트리거**: `TextEditController`에서 커서 위치가 변경될 때 `EditManager._notifyCursorMove(controller)` → `_dispatch('cursorMove', controller)`.

**쓰로틀링**: 키보드 연속 입력(예: 한 글자씩 빠르게 타이핑) 중에는 매 입력마다 `cursorMove`가 발생하지 않고, 최초 KeyDown과 마지막 KeyUp에만 발생한다. 이는 편집 UI의 불필요한 갱신을 방지하기 위함이다.

---

## 6. 레이아웃 편집 이벤트

레이아웃 편집 이벤트는 `EditManager`의 전용 디스패처(`_dispatchLayoutSelection`, `_dispatchLayoutMove`, `_dispatchLayoutResize`)를 통해 발생한다. `paragraph`와 `controller`는 항상 `null as unknown as ...`이다.

### 6.1 `layoutSelectionChange`

레이아웃 선택이 변경될 때 발생한다.

```typescript
manager.addEventListener('layoutSelectionChange', (event) => {
  console.log(event.selectedLayouts);   // LayoutElement[]
  console.log(event.previousLayouts);   // LayoutElement[]
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'layoutSelectionChange'` | 이벤트 타입 |
| `paragraph` | `null` | 레이아웃 이벤트에서는 항상 `null` |
| `controller` | `null` | 레이아웃 이벤트에서는 항상 `null` |
| `selectedLayouts` | `LayoutElement[]` | 현재 선택된 레이아웃 요소들 (복사본) |
| `previousLayouts` | `LayoutElement[]` | 이전에 선택되어 있던 요소들 |

**발생 트리거**:

| 트리거 | 호출 경로 |
|--------|----------|
| `EditManager.selectLayout(target, multi?)` | `_selectLayoutInternal()` → `_dispatchLayoutSelection(previousLayouts)` |
| `EditManager.clearLayoutSelection(preserveFocusedBox?)` | `_dispatchLayoutSelection(previousLayouts)`. `preserveFocusedBox=false` 시 `_lastFocusedBox`도 초기화 |
| 요소가 DOM에서 제거됨 | `_unregisterLayout(element)` → `_dispatchLayoutSelection(previousLayouts)` |
| 텍스트 편집 포커스로 인한 자동 선택 | `_selectBoxForParagraph()` → `_dispatchLayoutSelection(previousLayouts)` |
| 텍스트 편집 포커스 해제 | `_clearBoxSelectionForParagraph()` (현재 no-op) |

**`selectedLayouts`는 복사본**: `[...this._selectedLayouts]`로 새 배열을 만들어 전달하므로, 리스너에서 배열을 직접 수정해도 `EditManager` 내부 상태에 영향을 주지 않는다.

### 6.2 `layoutMove`

드래그 이동이 완료되거나 ESC로 취소될 때 발생한다. reparent 모드(`layoutEditType === 'reparent'`)에서 부모가 변경된 경우 `newContainer`/`previousContainer` 필드가 추가로 전달된다.

```typescript
manager.addEventListener('layoutMove', (event) => {
  console.log(event.layoutElement);  // 이동된 LayoutBoxElement
  console.log(event.previousLeft);   // 이동 전 left 값
  console.log(event.previousTop);    // 이동 전 top 값
  console.log(event.left);           // 이동 후 left 값 (ESC 취소 시 previousLeft와 동일)
  console.log(event.top);            // 이동 후 top 값 (ESC 취소 시 previousTop와 동일)
  console.log(event.canceled);       // ESC 취소 여부
  // reparent 모드에서만:
  console.log(event.newContainer);      // 새 부모 컨테이너 (부모 변경 시에만)
  console.log(event.previousContainer); // 이전 부모 컨테이너 (부모 변경 시에만)
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'layoutMove'` | 이벤트 타입 |
| `paragraph` | `null` | 항상 `null` |
| `controller` | `null` | 항상 `null` |
| `layoutElement` | `LayoutElement` | 이동된 레이아웃 요소 |
| `previousLeft` | `number` | 이동 전 `left` 값 (드래그 시작 위치) |
| `previousTop` | `number` | 이동 전 `top` 값 (드래그 시작 위치) |
| `left` | `number` | 이동 후 `left` 값. ESC 취소 시 `previousLeft`와 동일 |
| `top` | `number` | 이동 후 `top` 값. ESC 취소 시 `previousTop`와 동일 |
| `canceled` | `boolean` | ESC 키로 드래그가 취소되었으면 `true`, 정상 완료되었으면 `false` |
| `newContainer?` | `HTMLElement \| undefined` | reparent 모드에서 부모가 변경된 경우 새 부모 컨테이너. 부모 변경이 없거나 일반 move 모드이면 `undefined` |
| `previousContainer?` | `HTMLElement \| undefined` | reparent 모드에서 부모가 변경된 경우 이전 부모 컨테이너. `newContainer`가 있을 때만 설정됨 |

**발생 시점**:

| 시점 | `canceled` | `left`/`top` | `newContainer`/`previousContainer` |
|------|-----------|--------------|-----------------------------------|
| **mouseup (드래그 완료, move 모드)** | `false` | 스냅/클램핑 적용 최종 위치 | `undefined` |
| **mouseup (드래그 완료, reparent 모드, 부모 변경)** | `false` | 새 컨테이너 기준 좌표 | 새 부모/이전 부모 |
| **mouseup (드래그 완료, reparent 모드, 부모 유지)** | `false` | 최종 위치 | `undefined` |
| **ESC (드래그 취소)** | `true` | `previousLeft`/`previousTop`와 동일 | `undefined` (reparent는 mouseup 시에만 발생) |

**발생 트리거**: `LayoutEditController`의 `_onMouseUp` 또는 `_onKeyDown(ESC)`에서 `EditManager._dispatchLayoutMove(element, previousLeft, previousTop, left, top, canceled, newContainer?, previousContainer?)`를 호출한다.

**다중 선택 드래그**: 다중 선택 상태에서 드래그하면 선택된 각 최상위 요소마다 별도의 `layoutMove` 이벤트가 발생한다. reparent 모드에서는 각 box가 mouseup 위치의 컨테이너로 독립적으로 reparenting된다.

**발생 조건**: `BoxDragState.dragMoved === true`일 때만 발생한다. 3px 이하의 이동(클릭으로 간주)에서는 `layoutMove` 이벤트가 발생하지 않는다.

**reparent 모드 감지**: `event.newContainer !== undefined`이면 reparent가 발생했음을 나타낸다. `event.previousContainer`는 항상 `newContainer`와 함께 설정된다.

### 6.3 `layoutResize`

리사이즈가 완료되거나 ESC로 취소될 때 발생한다.

```typescript
manager.addEventListener('layoutResize', (event) => {
  console.log(event.layoutElement);   // 리사이즈된 LayoutBoxElement
  console.log(event.previousLeft);    // 리사이즈 전 left
  console.log(event.previousTop);     // 리사이즈 전 top
  console.log(event.previousWidth);   // 리사이즈 전 width
  console.log(event.previousHeight);  // 리사이즈 전 height
  console.log(event.left);            // 리사이즈 후 left
  console.log(event.top);             // 리사이즈 후 top
  console.log(event.width);           // 리사이즈 후 width
  console.log(event.height);          // 리사이즈 후 height
  console.log(event.canceled);        // ESC 취소 여부
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'layoutResize'` | 이벤트 타입 |
| `paragraph` | `null` | 항상 `null` |
| `controller` | `null` | 항상 `null` |
| `layoutElement` | `LayoutElement` | 리사이즈된 레이아웃 요소 |
| `previousLeft` | `number` | 리사이즈 전 `left` 값 |
| `previousTop` | `number` | 리사이즈 전 `top` 값 |
| `previousWidth` | `number` | 리사이즈 전 `width` 값 |
| `previousHeight` | `number` | 리사이즈 전 `height` 값 |
| `left` | `number` | 리사이즈 후 `left` 값. ESC 취소 시 `previousLeft`와 동일 |
| `top` | `number` | 리사이즈 후 `top` 값. ESC 취소 시 `previousTop`와 동일 |
| `width` | `number` | 리사이즈 후 `width` 값. ESC 취소 시 `previousWidth`와 동일 |
| `height` | `number` | 리사이즈 후 `height` 값. ESC 취소 시 `previousHeight`와 동일 |
| `canceled` | `boolean` | ESC 키로 리사이즈가 취소되었으면 `true`, 정상 완료되었으면 `false` |

**발생 시점**:

| 시점 | `canceled` | `left`/`top`/`width`/`height` |
|------|-----------|-------------------------------|
| **mouseup (리사이즈 완료)** | `false` | 스냅/클램핑이 적용된 최종 값 |
| **ESC (리사이즈 취소)** | `true` | `previousLeft`/`previousTop`/`previousWidth`/`previousHeight`와 동일 (시작 상태로 복원됨) |

**발생 트리거**: `LayoutEditController`의 `_onResizeMouseUp` 또는 `_onResizeKeyDown(ESC)`에서 `EditManager._dispatchLayoutResize(element, prevL, prevT, prevW, prevH, l, t, w, h, canceled)`를 호출한다.

**단일 요소**: 리사이즈는 항상 단일 요소에만 적용된다. 다중 선택 상태에서도 리사이즈 핸들을 드래그하면 해당 요소만 크기가 변경되므로, 이벤트도 1개만 발생한다.

**발생 조건**: `BoxResizeState.moved === true`일 때만 발생한다. 3px 이하의 이동(클릭으로 간주)에서는 `layoutResize` 이벤트가 발생하지 않는다.

---

## 7. 삽입 모드 이벤트

삽입 모드 이벤트는 `InsertController`가 `EditManager._dispatchInsert(detail)` / `_dispatchInsertCancel()`을 통해 발생시킨다. `paragraph`와 `controller`는 항상 `null as unknown as ...`이다.

### 7.1 `insert`

새 요소가 성공적으로 삽입되었을 때 발생한다.

```typescript
manager.addEventListener('insert', (event) => {
  console.log(event.type);        // 'insert'
  console.log(event.position);    // 'absolute' | 'static'
  console.log(event.element);     // 생성된 <x-layout-box> 요소
  console.log(event.container);   // 부모 컨테이너
  console.log(event.left);        // left 좌표
  console.log(event.top);         // top 좌표
  console.log(event.width);       // 너비
  console.log(event.height);      // 높이
  console.log(event.zIndex);      // z-index
  console.log(event.canceled);    // false
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'insert'` | 이벤트 타입 |
| `paragraph` | `null` | 항상 `null` |
| `controller` | `null` | 항상 `null` |
| `position` | `'absolute' \| 'static'` | 요소의 배치 모드 |
| `element` | `HTMLElement` | 생성된 최상위 요소. 항상 `<x-layout-box>`이다 |
| `container` | `HTMLElement` | 요소가 삽입된 부모 컨테이너 |
| `left` | `number` | static 모드면 컬럼 인덱스, absolute 모드면 mm |
| `top` | `number` | static 모드면 라인 인덱스, absolute 모드면 mm |
| `width` | `number` | static 모드면 컬럼 개수, absolute 모드면 mm |
| `height` | `number` | static 모드면 라인 수, absolute 모드면 mm |
| `zIndex` | `number` | 컨테이너 내 기존 자식 z-index의 최대값 + 1, 자식이 없으면 1 |
| `canceled` | `boolean` | 정상 삽입 시 `false` |

**발생 트리거**: `InsertController._finishInsert()`에서 `EditManager._dispatchInsert(detail)`를 호출한다. 드래그 거리가 3px 미만이거나, width/height가 1 미만이면 `_cleanup()` 후 return하여 이벤트가 발생하지 않는다.

**`layoutAdd` 이벤트 동시 발생**: `_dispatchInsert` 호출 직후 `_dispatchLayoutAdd`도 함께 발생한다. `insert` 이벤트의 리스너에서 `layoutAdd` 이벤트도 함께 처리해야 하는 경우, 별도 리스너로 `layoutAdd`를 구독하면 된다.

**`_suppressNextClick` 설정**: `_dispatchInsert`는 `_suppressNextClick = true`를 설정하여, 삽입 직후 발생하는 클릭 이벤트가 `LayoutSelectionController._onClick`에서 무시되도록 한다. 자세한 내용은 [9. 삽입 직후 클릭 억제](#9-삽입-직후-클릭-억제)를 참조한다.

### 7.2 `insertCancel`

삽입 모드에서 드래그가 ESC 키로 취소되었을 때 발생한다.

```typescript
manager.addEventListener('insertCancel', (event) => {
  console.log('Insert canceled');
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'insertCancel'` | 이벤트 타입 |
| `paragraph` | `null` | 항상 `null` |
| `controller` | `null` | 항상 `null` |

**발생 트리거**: `InsertController._cancel()` → `EditManager._dispatchInsertCancel()`.

**`_suppressNextClick` 설정**: `_dispatchInsertCancel`도 `_suppressNextClick = true`를 설정한다. 취소 직후 발생하는 클릭이 레이아웃 선택을 해제하지 않도록 방지한다.

---

## 8. 레이아웃 추가/제거 이벤트

레이아웃 요소(box, paragraph, image)가 DOM에 추가되거나 제거될 때 발생하는 이벤트이다. 삽입 모드, reparent, 프로그래밍 방식(`appendChildData`) 모두 포함한다.

### 8.1 `layoutAdd`

레이아웃 요소가 DOM에 추가될 때 발생한다.

```typescript
manager.addEventListener('layoutAdd', (event) => {
  console.log(event.type);               // 'layoutAdd'
  console.log(event.layoutAddDetail?.element);    // 추가된 요소
  console.log(event.layoutAddDetail?.container);  // 부모 컨테이너
  console.log(event.layoutAddDetail?.source);     // 'insert' | 'reparent' | 'programmatic'
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'layoutAdd'` | 이벤트 타입 |
| `paragraph` | `null` | 항상 `null` |
| `controller` | `null` | 항상 `null` |
| `layoutAddDetail.element` | `HTMLElement` | 추가된 요소 (`LayoutBoxElement` \| `LayoutParagraphElement` \| `LayoutImageElement`) |
| `layoutAddDetail.container` | `HTMLElement` | 부모 컨테이너 (`LayoutDocumentElement` \| `LayoutBoxElement`) |
| `layoutAddDetail.source` | `'insert' \| 'reparent' \| 'programmatic'` | 추가 방식 |

**발생 트리거**:

| source | 트리거 | 호출 경로 |
|--------|--------|----------|
| `'insert'` | 삽입 모드로 새 요소 생성 | `InsertController._finishInsert()` → `EditManager._dispatchLayoutAdd({ source: 'insert' })` |
| `'reparent'` | reparent 모드에서 box 이동 | `LayoutEditController._tryReparent()` → `EditManager._dispatchLayoutAdd({ source: 'reparent' })` |

**재진입 보호**: 다른 이벤트 디스패치 중에는 `layoutAdd` 이벤트가 발생하지 않는다 (`_dispatching` 플래그).

### 8.2 `layoutRemove`

레이아웃 요소가 DOM에서 제거될 때 발생한다.

```typescript
manager.addEventListener('layoutRemove', (event) => {
  console.log(event.type);                    // 'layoutRemove'
  console.log(event.layoutRemoveDetail?.element);          // 제거된 요소
  console.log(event.layoutRemoveDetail?.previousContainer);// 이전 부모 컨테이너
  console.log(event.layoutRemoveDetail?.source);           // 'reparent' | 'programmatic'
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'layoutRemove'` | 이벤트 타입 |
| `paragraph` | `null` | 항상 `null` |
| `controller` | `null` | 항상 `null` |
| `layoutRemoveDetail.element` | `HTMLElement` | 제거된 요소 (`LayoutBoxElement` \| `LayoutParagraphElement` \| `LayoutImageElement`) |
| `layoutRemoveDetail.previousContainer` | `HTMLElement` | 제거되기 전 부모 컨테이너 (`LayoutDocumentElement` \| `LayoutBoxElement`) |
| `layoutRemoveDetail.source` | `'reparent' \| 'programmatic'` | 제거 방식 |

**발생 트리거**:

| source | 트리거 | 호출 경로 |
|--------|--------|----------|
| `'reparent'` | reparent 모드에서 이전 컨테이너로부터 box 제거 | `LayoutEditController._tryReparent()` → `box.remove()` → `EditManager._dispatchLayoutRemove({ source: 'reparent' })` |

**재진입 보호**: 다른 이벤트 디스패치 중에는 `layoutRemove` 이벤트가 발생하지 않는다 (`_dispatching` 플래그).

### 8.3 `LayoutAddEventDetail` 타입

```typescript
interface LayoutAddEventDetail {
  element: HTMLElement;        // 추가된 요소
  container: HTMLElement;      // 부모 컨테이너
  source: 'insert' | 'reparent' | 'programmatic';  // 추가 방식
}
```

### 8.4 `LayoutRemoveEventDetail` 타입

```typescript
interface LayoutRemoveEventDetail {
  element: HTMLElement;        // 제거된 요소
  previousContainer: HTMLElement;  // 이전 부모 컨테이너
  source: 'reparent' | 'programmatic';  // 제거 방식
}
```

### 8.5 렌더링 보장

`layoutAdd` 이벤트는 요소가 DOM에 추가되고 전체 초기화 파이프라인(`_layoutStructure` → `_applyStyle` → `_renderBorder` → `_propagateInheritStyle` → `render`)이 완료된 **후**에 발생한다. 이벤트 리스너에서 요소의 위치, 크기, 자식 상태에 접근할 수 있다.

`layoutRemove` 이벤트는 요소가 DOM에서 제거되기 **직전**에 발생한다. 이벤트 리스너에서 제거될 요소의 `data` 속성 등에 여전히 접근할 수 있다.

### 8.6 프로그래매틱 `data` 세터 중간 상태 보호

`LayoutDocumentElement`와 `LayoutBoxElement` 모두 `data` 세터에서 기존 자식을 `remove()`한 후 새 자식을 `appendChild()`하는 방식으로 자식을 재구축한다. 이 과정에서 중간 상태(자식이 모두 제거된 상태)에서 `element.data` getter가 `children: []`를 반환하는 것을 방지하기 위해 두 가지 메커니즘이 적용된다.

**`_rebuildingChildren` 플래그 + `_pendingData` 캐시**: `data` 세터 실행 전 `_rebuildingChildren = true`와 `_pendingData = data`를 설정하고, `try/finally` 블록에서 항상 둘을 복원한다(`_rebuildingChildren = false`, `_pendingData = null`). 이 플래그가 `true`인 동안:

1. MutationObserver 콜백이 무시된다. 자식 제거/추가로 인한 DOM 변경이 `layout()`/`render()`를 중복 트리거하지 않는다.
2. `data` getter가 `_pendingData` 캐시를 반환한다. `this.items.map(e => e.data)`가 중간 상태(`children: []`)를 반환하는 것을 방지하여, 외부(React 래퍼, EditManager 이벤트 핸들러)에서 `element.data`를 읽더라도 항상 올바른 전체 데이터를 얻을 수 있다.

**`LayoutBoxElement`**는 `connectedCallback`에서 `_startChildObserver()`로 MutationObserver를 등록하고, `disconnectedCallback`에서 `_stopChildObserver()`로 해제한다.

**`LayoutDocumentElement`**도 동일하게 `connectedCallback`에서 `_startChildObserver()`로 등록하고, `disconnectedCallback`에서 `_stopChildObserver()`로 해제한다.

---

## 9. Box 속성 변경 이벤트

Box의 의미적 속성(`role`, `contentUid`, `groupMember`, `priority`)이 프로그래밍 방식으로 변경될 때 발생한다. `LayoutBoxElement`의 setter에서 값이 실제로 변경된 경우에만 `EditManager._dispatchBoxPropertyChange`를 통해 이벤트가 발생한다.

### 9.1 `boxPropertyChange`

```typescript
manager.addEventListener('boxPropertyChange', (event) => {
  const { box, property, oldValue, newValue } = event.boxPropertyDetail!;
  console.log(`Box ${box.id}: ${property} changed from`, oldValue, '→', newValue);
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'boxPropertyChange'` | 이벤트 타입 |
| `paragraph` | `null` | 항상 `null` |
| `controller` | `null` | 항상 `null` |
| `boxPropertyDetail` | `BoxPropertyChangeEventDetail` | 변경 상세 정보 |

**`BoxPropertyChangeEventDetail` 타입:**

```typescript
type BoxPropertyName = 'role' | 'contentUid' | 'groupMember' | 'priority';

interface BoxPropertyChangeEventDetail {
  box: HTMLElement;                                       // 속성이 변경된 LayoutBoxElement
  property: BoxPropertyName;                              // 변경된 속성명
  oldValue: BoxRole | string[] | number | string | undefined;  // 변경 전 값
  newValue: BoxRole | string[] | number | string | undefined;  // 변경 후 값
}
```

**발생 트리거:**

| 속성 | 트리거 | oldValue / newValue 타입 |
|------|--------|--------------------------|
| `role` | `box.role = 'title'` | `BoxRole` (기본값 `'none'`) |
| `contentUid` | `box.contentUid = 'article-42'` | `string \| undefined` (기본값 `undefined`) |
| `groupMember` | `box.groupMember = ['a', 'b']` | `string[]` (기본값 `[]`) |
| `priority` | `box.priority = 5` | `number` (기본값 `0`) |

**값이 동일한 경우 이벤트 미발생**: `role`과 `priority` setter는 값이 변경되지 않으면 이벤트를 발생시키지 않는다. `contentUid` setter는 값이 동일하면 이벤트를 발생시키지 않는다. `groupMember` setter는 배열 요소가 동일하면 이벤트를 발생시키지 않는다. `attributeChangedCallback`을 통한 DOM 속성 변경에서는 이벤트가 발생하지 않는다 (setter를 통해서만 발생).

**`contentUid`는 단순 메타정보**: 렌더링/레이아웃에 영향을 주지 않는다. `role`과 동일한 처리 파이프라인(개인 필드, `content-uid` DOM 속성 동기화, `data` setter/getter, `boxPropertyChange` 디스패치)을 따르지만 선택 라벨(`_updateLabelText`)에는 표시되지 않는다.

**재진입 보호**: 다른 이벤트 디스패치 중에는 `boxPropertyChange` 이벤트가 발생하지 않는다 (`_dispatching` 플래그).

---

## 9.2 `placeGunChange`

Place Gun의 장전 항목 리스트나 일시정지 상태가 변경될 때 발생한다. `loadPlaceGun`, `unloadPlaceGun`, `removePlaceGunItem`, `reorderPlaceGunItems`, `setPlaceGunPaused`, 항목 소비(`_consumePlaceGunItem`) 시 `EditManager._dispatchPlaceGunChange`를 통해 발생한다.

```typescript
manager.addEventListener('placeGunChange', (event) => {
  const { items, paused } = event.placeGunDetail!;
  console.log(`장전된 항목: ${items.length}개, 일시정지: ${paused}`);
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'placeGunChange'` | 이벤트 타입 |
| `paragraph` | `null` | 항상 `null` |
| `controller` | `null` | 항상 `null` |
| `placeGunDetail` | `PlaceGunChangeEventDetail` | 변경 상세 정보 |

**`PlaceGunChangeEventDetail` 타입:**

```typescript
interface PlaceGunChangeEventDetail {
  items: PlaceGunItem[];   // 변경 후 장전된 항목 리스트 (얕은 복사)
  paused: boolean;         // 변경 후 일시정지 여부
}
```

**발생 트리거:**

| 메서드 | 트리거 |
|--------|--------|
| `loadPlaceGun(items)` | 항목 장전 (기존 항목 교체) |
| `unloadPlaceGun()` | 모든 항목 비우기 |
| `removePlaceGunItem(index)` | 개별 항목 삭제 |
| `reorderPlaceGunItems(from, to)` | 항목 순서 변경 |
| `setPlaceGunPaused(paused)` | 일시정지 토글 |
| `_consumePlaceGunItem()` | 클릭 배치로 맨 위 항목 소비 |

**재진입 보호**: 다른 이벤트 디스패치 중에는 `placeGunChange` 이벤트가 발생하지 않는다 (`_dispatching` 플래그).

---

## 10. 모드 전환 이벤트

모드 전환 이벤트는 `EditManager`의 `textEditMode`/`layoutEditMode`/`insertMode` setter에서 모드가 실제로 변경된 후 `_dispatchModeChange()`를 통해 발생한다. `paragraph`와 `controller`는 항상 `null as unknown as ...`이다.

### 10.1 `modeChange`

편집 모드가 전환될 때 발생한다. `textEditMode`, `layoutEditMode`, `insertMode` 중 하나가 변경되면 발생한다.

```typescript
manager.addEventListener('modeChange', (event) => {
  console.log(event.previousMode); // 전환 전 모드 상태
  console.log(event.mode);         // 전환 후 모드 상태
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'modeChange'` | 이벤트 타입 |
| `paragraph` | `null` | 항상 `null` |
| `controller` | `null` | 항상 `null` |
| `previousMode` | `EditModeState` | 전환 전 모드 상태 스냅샷 |
| `mode` | `EditModeState` | 전환 후 모드 상태 스냅샷 |

**`EditModeState` 타입:**

```typescript
interface EditModeState {
  textEditMode: boolean;
  layoutEditMode: boolean;
  layoutEditType: LayoutEditType; // 'move' | 'reparent'
  insertMode: InsertMode | null;
}
```

**발생 트리거:**

| 트리거 | 호출 경로 |
|--------|----------|
| `textEditMode = true/false` | setter → `_dispatchModeChange(prevMode)` |
| `layoutEditMode = true/false/{ type }` | setter → `_dispatchModeChange(prevMode)` |
| `insertMode = mode/null` | setter → `_dispatchModeChange(prevMode)` |
| `deactivateAll()` | `textEditMode = false` → setter → `_dispatchModeChange(prevMode)` |
| paragraph 더블클릭 | `LayoutSelectionController._onDblClick` → `textEditMode = true` → setter → `_dispatchModeChange(prevMode)` |

**중간 상태 이벤트 억제**: 모드 setter가 내부적으로 다른 모드 setter를 호출할 때(예: `textEditMode = true`가 `layoutEditMode = false`와 `insertMode = null`을 호출), `_modeChangeSuppressed` 플래그로 중간 상태의 이벤트를 억제한다. 최종적으로 모드가 확정된 후 한 번만 `modeChange` 이벤트가 발생한다.

**동일 상태 no-op**: setter가 현재 값과 동일한 값을 받으면 `_dispatchModeChange`를 호출하지 않는다. 예: `textEditMode`가 이미 `true`일 때 `textEditMode = true`를 호출하면 이벤트가 발생하지 않는다.

---

## 11. 클릭 억제 (`_suppressNextClick` / `_suppressLayoutClick`)

### 10.1 `_suppressNextClick` 플래그 (삽입 완료/취소용)

브라우저는 `mouseup` 이후 자동으로 `click` 이벤트를 발생시킨다. 삽입 완료/취소 직후 이 클릭이 `LayoutSelectionController._onClick`에 의해 레이아웃 선택을 해제하는 것을 방지하기 위해, `EditManager`는 `_suppressNextClick` 플래그를 사용한다.

플래그가 설정되는 상황:

1. **삽입 완료/취소 직후** (`_dispatchInsert` / `_dispatchInsertCancel`): 삽입 완료 또는 취소 직후의 클릭이 레이아웃 선택을 해제하지 않도록 방지한다.

### 8.2 `_suppressLayoutClick()` (드래그/리사이즈 완료용)

드래그/리사이즈 완료 후에는 `_suppressNextClick` 플래그 방식 대신 **window capture phase 일회성 click 리스너**를 사용한다. 기존 플래그 방식은 mousedown의 `preventDefault()`로 인해 브라우저가 click 이벤트를 발생시키지 않을 때 플래그가 소비되지 않고 남아 다음 정상 클릭을 잘못 무시하는 문제가 있었다.

새 방식은:

1. **드래그 이동 완료 직후** (`LayoutEditController._onMouseUp`): `dragMoved === true`일 때 호출.
2. **리사이즈 완료 직후** (`LayoutEditController._onResizeMouseUp`): `moved === true`일 때 호출.
3. window capture phase에 일회성 click 리스너를 등록하여 `LayoutSelectionController._onClick`보다 먼저 실행되어 click을 소비(`stopPropagation()` + `preventDefault()`)한다.
4. click이 발생하지 않으면 200ms 타임아웃으로 리스너가 자동 제거된다.

### 8.3 동작 흐름 (삽입 완료/취소)

```
InsertController._finishInsert() 또는 _cancel()
    │
    ▼
EditManager._dispatchInsert(detail) 또는 _dispatchInsertCancel()
    ├── _suppressNextClick = true
    └── 리스너 호출 (insert/insertCancel 이벤트)
    │
    ▼
(브라우저가 click 이벤트 발생)
    │
    ▼
LayoutSelectionController._onClick(event)
    ├── _consumeSuppressNextClick() 호출
    │   ├── _suppressNextClick === true?
    │   │   ├── true → _suppressNextClick = false, return true
    │   │   └── false → return false
    │   └── return true → _onClick early return (선택 처리 생략)
    └── return false → 정상 선택 처리 진행
```

### 8.4 동작 흐름 (드래그/리사이즈 완료)

```
LayoutEditController._onMouseUp() 또는 _onResizeMouseUp()
    │
    ├── dragMoved === true (또는 moved === true)?
    │   ├── true → EditManager._suppressLayoutClick() 호출
    │   │   ├── window capture phase에 일회성 click 리스너 등록
    │   │   └── 200ms 타임아웃 설정 (자동 제거용)
    │   └── false → 억제하지 않음
    │
    ▼
(브라우저가 click 이벤트 발생)
    │
    ▼
window capture 리스너가 click 소비
    ├── stopPropagation() + preventDefault()
    └── 리스너 자동 제거 (_removeClickConsumeHandler)
    │
    ▼
LayoutSelectionController._onClick는 호출되지 않음 (stopPropagation으로 차단)

(또는 click이 발생하지 않은 경우)
    │
    ▼
200ms 타임아웃 → _removeClickConsumeHandler() → 리스너 제거
```

### 8.5 API

```typescript
/**
 * 드래그/리사이즈 완료 직후 발생하는 클릭 이벤트를 억제한다.
 * window capture phase에 일회성 click 리스너를 등록하여
 * LayoutSelectionController._onClick보다 먼저 click을 소비한다.
 * click이 발생하지 않으면 200ms 타임아웃으로 자동 제거된다.
 * @internal
 */
_suppressLayoutClick(): void

/**
 * 삽입 완료/취소 직후 발생하는 클릭 이벤트를 무시하기 위한 플래그를 소비한다.
 * _dispatchInsert, _dispatchInsertCancel에서 true로 설정되며,
 * LayoutSelectionController._onClick에서 한 번만 소비된다.
 * 드래그/리사이즈 완료 후 클릭 억제는 _suppressLayoutClick()이
 * 별도의 window capture 리스너로 처리하므로 이 플래그를 사용하지 않는다.
 * @internal
 */
_consumeSuppressNextClick(): boolean
```

이 메서드들은 `@internal`이므로 외부에서 직접 호출하지 않는다. `LayoutEditController`와 `LayoutSelectionController`가 내부적으로 사용한다.

### 8.6 일회성 소비

`_suppressNextClick`은 한 번 소비되면 `false`로 재설정된다. 이후의 클릭 이벤트는 정상적으로 처리된다. `_suppressLayoutClick()`의 window capture 리스너도 click 소비 후 즉시 제거되며, click이 발생하지 않으면 200ms 후 자동 제거된다.

---

## 11. 재진입 보호

### 11.1 `_dispatching` 플래그

`EditManager`는 `_dispatching` 플래그로 이벤트 디스패치 중 재진입을 방지한다. 리스너가 이벤트 핸들러 내에서 다시 `EditManager` 상태를 변경하여 또 다른 이벤트를 발생시키려 해도, `_dispatching === true`이면 디스패치가 무시된다.

### 11.2 적용 범위

모든 디스패처(`_dispatch`, `_dispatchLayoutSelection`, `_dispatchLayoutMove`, `_dispatchLayoutResize`, `_dispatchInsert`, `_dispatchInsertCancel`)가 `if (this._dispatching) return;` 가드로 시작한다.

```typescript
_dispatchInsert(detail: InsertEventDetail): void {
  if (this._dispatching) return;
  // ...
  this._dispatching = true;
  try {
    for (const listener of listeners) {
      try { listener({ ... }); }
      catch (e) { console.error(e); }
    }
  } finally {
    this._dispatching = false;
  }
}
```

### 11.3 리스너 예외 격리

각 리스너 호출은 개별 `try/catch`로 감싸져 있어, 하나의 리스너에서 예외가 발생해도 다른 리스너와 `EditManager` 상태에 영향을 주지 않는다. 예외는 `console.error(e)`로 출력된다.

### 11.4 리스너 없는 경우

등록된 리스너가 없거나 `Set`이 비어 있으면 디스패처는 즉시 return한다 (`if (!listeners || listeners.size === 0) return;`). 이 경우 `_dispatching`은 `true`로 설정되지 않는다.

---

## 12. 전체 이벤트 발생 흐름

### 12.1 텍스트 편집

```
사용자가 단락 클릭
    │
    ▼
TextEditController._onFocus()
    │
    ▼
EditManager._requestFocus(controller)
    ├── 이전 컨트롤러 blur 처리
    ├── _selectBoxForParagraph(newParagraph)
    ├── _focusedController = controller
    └── _dispatch('focusChange', controller, previousParagraph, previousController)
        ├── _dispatching = true
        ├── focusChange 리스너 호출
        │   └── 외부 UI: 스타일 패널 갱신, 커서 표시
        └── _dispatching = false

(텍스트 입력)
    │
    ▼
TextEditController (입력 처리)
    │
    ▼
EditManager._notifyTextChange(controller)
    └── _dispatch('textChange', controller)
        └── textChange 리스너 호출
            └── 외부 UI: undo 스택 갱신
```

### 12.2 레이아웃 선택

```
사용자가 box 클릭
    │
    ▼
LayoutSelectionController._onClick(event) 또는
LayoutEditController._onMouseDown(event)
    │
    ▼
EditManager.selectLayout(box)
    ├── 기존 선택 해제 (단일 모드) 또는 토글 (다중 모드)
    ├── selected 속성 설정/해제
    └── _dispatchLayoutSelection(previousLayouts)
        ├── _dispatching = true
        ├── layoutSelectionChange 리스너 호출
        │   └── 외부 UI: 선택 정보 표시
        └── _dispatching = false
```

### 12.3 레이아웃 드래그 이동

```
(드래그 완료 - mouseup)
    │
    ▼
LayoutEditController._onMouseUp
    ├── dragMoved === true?
    │   └── EditManager._suppressLayoutClick() 호출
    │       (window capture phase에 일회성 click 리스너 등록)
    ├── 최종 위치 계산
    ├── box.left/top 설정
    └── EditManager._dispatchLayoutMove(box, startLeft, startTop, box.left, box.top, false)
        ├── _dispatching = true
        ├── layoutMove 리스너 호출
        │   └── 외부 UI: undo 스택, 좌표 표시
        └── _dispatching = false

(또는 ESC 취소)
    │
    ▼
LayoutEditController._onKeyDown(ESC)
    ├── 원래 위치로 복원
    └── EditManager._dispatchLayoutMove(box, originalLeft, originalTop, originalLeft, originalTop, true)
        └── layoutMove 리스너 호출 (canceled = true)
```

### 12.4 요소 삽입

```
(드래그 삽입 완료 - mouseup)
    │
    ▼
InsertController._onMouseUp
    └── _finishInsert(endX, endY)
        ├── _findTargetContainer(startX, startY, endX, endY)
        ├── 좌표 변환
        ├── _createElement(...)
        ├── _cleanup()
        └── EditManager._dispatchInsert(detail)
            ├── _suppressNextClick = true
            ├── _dispatching = true
            ├── insert 리스너 호출
            │   └── 외부 UI: 새 요소 정보 표시, undo 스택
            └── _dispatching = false

(이후 브라우저가 click 이벤트 발생)
    │
    ▼
LayoutSelectionController._onClick
    └── _consumeSuppressNextClick() → true → early return (선택 해제 방지)
```

---

## 13. 이벤트 요약 표

| 이벤트 | 카테고리 | payload 핵심 필드 | 발생 조건 |
|--------|---------|-------------------|-----------|
| `focusChange` | 텍스트 | `paragraph`, `controller`, `previousParagraph?`, `previousController?` | 단락 포커스 이동 |
| `textChange` | 텍스트 | `paragraph`, `controller` | 텍스트 내용 변경 |
| `styleChange` | 텍스트 | `paragraph`, `controller` | 유효 스타일 변경 |
| `selectionStart` | 텍스트 | `paragraph`, `controller` | 텍스트 드래그 선택 시작 |
| `selectionEnd` | 텍스트 | `paragraph`, `controller` | 텍스트 드래그 선택 종료 |
| `cursorMove` | 텍스트 | `paragraph`, `controller` | 커서 위치 변경 (쓰로틀링) |
| `layoutSelectionChange` | 레이아웃 | `selectedLayouts`, `previousLayouts` | box 선택 변경 |
| `layoutMove` | 레이아웃 | `layoutElement`, `previousLeft/Top`, `left/top`, `canceled`, `newContainer?`, `previousContainer?` | 드래그 이동 완료/취소 (reparent 모드 시 부모 정보 포함) |
| `layoutResize` | 레이아웃 | `layoutElement`, `previous*`, `left/top/width/height`, `canceled` | 리사이즈 완료/취소 |
| `layoutAdd` | 레이아웃 | `layoutAddDetail.element`, `layoutAddDetail.container`, `layoutAddDetail.source` | 레이아웃 요소 DOM 추가 (삽입/reparent) |
| `layoutRemove` | 레이아웃 | `layoutRemoveDetail.element`, `layoutRemoveDetail.previousContainer`, `layoutRemoveDetail.source` | 레이아웃 요소 DOM 제거 (reparent) |
| `insert` | 삽입 | `position`, `element`, `container`, `left/top/width/height`, `zIndex`, `canceled` | 요소 삽입 완료 |
| `insertCancel` | 삽입 | (없음) | 삽입 드래그 ESC 취소 |
| `modeChange` | 모드 전환 | `previousMode`, `mode` | textEditMode/layoutEditMode/insertMode 변경 |
| `boxPropertyChange` | Box 속성 | `boxPropertyDetail.box`, `boxPropertyDetail.property`, `boxPropertyDetail.oldValue`, `boxPropertyDetail.newValue` | box의 role/contentUid/groupMember/priority 변경 |
| `placeGunChange` | Place Gun | `placeGunDetail.items`, `placeGunDetail.paused` | Place Gun 장전/비우기/삭제/재정렬/일시정지/소비 |

---

## 14. 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/edit/edit-manager.ts` | `EditManager`: 이벤트 시스템, `addEventListener`/`removeEventListener`, `_dispatch*` 디스패처, `_dispatching` 재진입 보호, `_suppressNextClick` 삽입 후 클릭 억제, `_suppressLayoutClick` 드래그/리사이즈 후 window capture 클릭 소비, `_clickConsumeHandler`/`_clickConsumeTimer`, `modeChange` 이벤트 발생 (`_dispatchModeChange` 호출), `_modeChangeSuppressed` 중간 상태 이벤트 억제 |
| `src/edit/text-edit-controller.ts` | `TextEditController`: 텍스트 편집 이벤트 발생 (`_notifyTextChange`, `_notifyStyleChange`, `_notifySelectionStart`, `_notifySelectionEnd`, `_notifyCursorMove`, `_requestFocus`, `_releaseFocus`), `getOffsetFromPoint` 좌표→오프셋 변환 |
| `src/edit/layout-edit-controller.ts` | `LayoutEditController`: `layoutMove`, `layoutResize` 이벤트 발생 (`_dispatchLayoutMove`, `_dispatchLayoutResize` 호출), `layoutAdd`/`layoutRemove` 이벤트 발생 (reparent 시 `_dispatchLayoutAdd`/`_dispatchLayoutRemove` 호출), `_suppressLayoutClick` 호출 (드래그/리사이즈 완료 후 클릭 억제) |
| `src/edit/layout-selection-controller.ts` | `LayoutSelectionController`: `_consumeSuppressNextClick` 소비 (삽입 후 클릭 억제), `layoutSelectionChange` 간접 발생 (`selectLayout` 호출). 드래그/리사이즈 후 클릭은 `_suppressLayoutClick`의 window capture 리스너가 먼저 소비하여 `_onClick`이 호출되지 않음. 더블클릭 시 텍스트 편집 모드 전환 + 포커스 부여 (`_onDblClick`) |
| `src/edit/insert-controller.ts` | `InsertController`: `insert`, `insertCancel` 이벤트 발생 (`_dispatchInsert`, `_dispatchInsertCancel` 호출), `layoutAdd` 이벤트 발생 (`_dispatchLayoutAdd` 호출) |
| `src/edit/place-gun-controller.ts` | `PlaceGunController`: Place Gun 클릭 배치 처리, `_consumePlaceGunItem` 호출로 항목 소비 → `placeGunChange` 간접 발생. 새 요소를 생성하지 않고 기존 paragraph/image에 데이터 주입하므로 `layoutAdd` 이벤트는 발생하지 않음 |
| `src/types/edit/insert.type.ts` | `InsertEventDetail` 타입 정의 (`insert` 이벤트 payload) |
| `src/types/edit/layout.type.ts` | `LayoutEditModeConfig`, `LayoutAddEventDetail`, `LayoutRemoveEventDetail`, `EditModeState`, `BoxPropertyChangeEventDetail` 타입 정의 |
| `src/types/edit/place-gun.type.ts` | `PlaceGunItem`, `PlaceGunChangeEventDetail` 타입 정의 (`placeGunChange` 이벤트 payload) |
| `src/components/layout/box.element.ts` | `LayoutBoxElement`: `role`, `contentUid`, `groupMember`, `priority` setter에서 `boxPropertyChange` 이벤트 발생 |

---

## 15. 주의사항

- **재진입 금지**: 리스너 내에서 `EditManager` 상태를 변경하여 동일한 이벤트를 다시 발생시키려 하면 무시된다 (`_dispatching` 가드). 다른 타입의 이벤트도 동일 플래그를 공유하므로, 리스너 내에서 다른 이벤트를 발생시키는 것도 차단된다.
- **예외 격리**: 리스너에서 예외가 발생해도 `console.error`로만 출력되고 다른 리스너나 `EditManager` 상태에는 영향을 주지 않는다.
- **`paragraph`/`controller`의 `null` 처리**: 레이아웃/삽입 이벤트에서 `paragraph`와 `controller`는 `null as unknown as LayoutParagraphElement`로 설정된다. 외부 UI는 `event.type`을 먼저 확인하여 필드 접근 여부를 결정해야 한다.
- **`selectedLayouts`는 복사본**: `layoutSelectionChange`의 `selectedLayouts`는 `[...this._selectedLayouts]`로 새 배열이므로, 리스너에서 직접 수정해도 내부 상태에 영향을 주지 않는다.
- **`cursorMove` 쓰로틀링**: 키보드 연속 입력 중에는 최초 KeyDown과 마지막 KeyUp에만 `cursorMove`가 발생한다. 매 입력마다 발생하지 않으므로, 실시간 커서 위치가 필요하면 `controller.cursorOffset`을 직접 조회한다.
- **`layoutMove`/`layoutResize` 발생 조건**: 3px 이하의 이동(클릭으로 간주)에서는 발생하지 않는다. `BoxDragState.dragMoved`/`BoxResizeState.moved`가 `true`일 때만 발생한다.
- **`insert` 발생 조건**: 드래그 거리 3px 이상, width/height 1 이상일 때만 발생한다. 임계값 미만이면 `_cleanup()` 후 return하여 이벤트가 발생하지 않는다.
- **`_suppressNextClick` 일회성**: 삽입/취소 직후의 첫 번째 클릭만 억제된다. 이후 클릭은 정상적으로 처리된다. 드래그/리사이즈 완료 후 클릭 억제는 `_suppressLayoutClick()`의 window capture 리스너로 처리되며, click 소비 후 즉시 제거되거나 200ms 타임아웃으로 자동 제거된다.
- **리스너 등록 순서**: 동일 `type`에 여러 리스너를 등록하면 등록 순서대로 호출된다 (`Set`의 삽입 순서 보장).
- **리스너 제거 시점**: 리스너를 제거하면 현재 디스패치 중인 `Set`에서도 즉시 제외되지만, 이미 실행 중인 리스너는 완료된다.
- **`modeChange` 중간 상태 억제**: 모드 setter가 내부적으로 다른 모드 setter를 호출할 때 `_modeChangeSuppressed` 플래그로 중간 상태의 이벤트가 억제된다. 최종적으로 모드가 확정된 후 한 번만 `modeChange` 이벤트가 발생한다. 예: `textEditMode = true` 호출 시 내부적으로 `layoutEditMode = false`와 `insertMode = null`이 호출되지만, `modeChange` 이벤트는 최종적으로 `textEditMode = true`가 확정된 후 한 번만 발생한다.
- **`modeChange` 동일 상태 no-op**: setter가 현재 값과 동일한 값을 받으면 `_dispatchModeChange`를 호출하지 않아 `modeChange` 이벤트가 발생하지 않는다.
- **`boxPropertyChange` 값 동일 시 미발생**: `role`, `contentUid`, `priority` setter는 값이 동일하면 이벤트를 발생시키지 않는다. `groupMember` setter는 배열 내용이 동일하면 이벤트를 발생시키지 않는다. `attributeChangedCallback`을 통한 DOM 속성 변경에서는 이벤트가 발생하지 않는다 (setter를 통해서만 발생).

---

## 16. 사용 예시

### 16.1 텍스트 편집 UI 연동

```typescript
const manager = EditManager.getInstance();

// 포커스 이동 → 스타일 패널 갱신
manager.addEventListener('focusChange', (event) => {
  if (event.previousParagraph) {
    console.log('포커스 이동:', event.previousParagraph.id, '→', event.paragraph.id);
  } else {
    console.log('최초 포커스:', event.paragraph.id);
  }
  updateStylePanel(manager.currentStyle);
  updateCursorInfo(manager.cursorOffset);
});

// 텍스트 변경 → undo 스택
manager.addEventListener('textChange', (event) => {
  pushUndoStack(event.paragraph, event.controller.cursorOffset);
});

// 커서 이동 → 줄/열 표시
manager.addEventListener('cursorMove', (event) => {
  updateCursorInfo(event.controller.cursorOffset);
});
```

### 16.2 레이아웃 편집 UI 연동

```typescript
// 선택 변경 → 속성 패널 표시/숨김
manager.addEventListener('layoutSelectionChange', (event) => {
  if (event.selectedLayouts.length === 0) {
    hidePropertyPanel();
  } else if (event.selectedLayouts.length === 1) {
    showPropertyPanel(event.selectedLayouts[0]);
  } else {
    showMultiSelectPanel(event.selectedLayouts.length);
  }
});

// 드래그 이동 완료 → undo 스택
manager.addEventListener('layoutMove', (event) => {
  if (event.canceled) {
    console.log('이동 취소, 복원 위치:', event.left, event.top);
  } else {
    pushUndoStack({
      type: 'move',
      element: event.layoutElement,
      from: { left: event.previousLeft, top: event.previousTop },
      to: { left: event.left, top: event.top },
    });
  }
});

// 리사이즈 완료 → undo 스택
manager.addEventListener('layoutResize', (event) => {
  if (!event.canceled) {
    pushUndoStack({
      type: 'resize',
      element: event.layoutElement,
      from: { left: event.previousLeft, top: event.previousTop, width: event.previousWidth, height: event.previousHeight },
      to: { left: event.left, top: event.top, width: event.width, height: event.height },
    });
  }
});
```

### 16.3 삽입 모드 UI 연동

```typescript
// 삽입 완료 → 새 요소 정보 표시 + undo 스택
manager.addEventListener('insert', (event) => {
  console.log('삽입:', event.type, event.position, event.element, event.container);
  pushUndoStack({
    type: 'insert',
    element: event.element,
    container: event.container,
    left: event.left,
    top: event.top,
    width: event.width,
    height: event.height,
  });
});

// 삽입 취소 → 상태 표시
manager.addEventListener('insertCancel', () => {
  console.log('삽입 취소');
  resetInsertToolState();
});
```

### 16.4 React 통합

```tsx
import { useEditManager } from 'layout-element/react';

function EditorPanel() {
  const { focusedParagraph, currentStyle, selectedLayouts } = useEditManager({
    onFocusChange: (event) => {
      // focusChange 처리
    },
    onTextChange: (event) => {
      // textChange 처리
    },
    onLayoutSelectionChange: (event) => {
      // layoutSelectionChange 처리
    },
    onLayoutMove: (event) => {
      // layoutMove 처리
    },
    onInsert: (event) => {
      // insert 처리
    },
  });

  return (
    // ...
  );
}
```

`useEditManager` 훅은 마운트 시 리스너를 등록하고 언마운트 시 해제한다. 자세한 훅 API는 `EDITING_TEXT.md`와 `EDITING_LAYOUT.md`를 참조한다.

### 16.5 모드 전환 UI 연동

```typescript
const manager = EditManager.getInstance();

manager.addEventListener('modeChange', (event) => {
  const { previousMode, mode } = event;
  console.log('모드 전환:');
  console.log('  이전:', previousMode);
  console.log('  이후:', mode);

  // 툴바 버튼 활성 상태 갱신
  updateToolbar({
    textEditMode: mode.textEditMode,
    layoutEditMode: mode.layoutEditMode,
    layoutEditType: mode.layoutEditType,
    insertMode: mode.insertMode,
  });

  // 모드별 UI 패널 표시/숨김
  if (mode.textEditMode) {
    showTextEditingPanel();
  } else if (mode.layoutEditMode) {
    showLayoutEditingPanel();
  } else if (mode.insertMode) {
    showInsertPanel();
  } else {
    showReadOnlyPanel();
  }
});
```

### 16.6 Box 속성 변경 UI 연동

```typescript
const manager = EditManager.getInstance();

manager.addEventListener('boxPropertyChange', (event) => {
  const { box, property, oldValue, newValue } = event.boxPropertyDetail!;

  switch (property) {
    case 'role':
      console.log(`Box ${box.id} role: ${oldValue} → ${newValue}`);
      updateBoxRolePanel(box, newValue as BoxRole);
      break;
    case 'groupMember':
      console.log(`Box ${box.id} groupMember: [${(oldValue as string[]).join(', ')}] → [${(newValue as string[]).join(', ')}]`);
      updateGroupMemberPanel(box, newValue as string[]);
      break;
    case 'priority':
      console.log(`Box ${box.id} priority: ${oldValue} → ${newValue}`);
      updatePriorityPanel(box, newValue as number);
      break;
  }
});
```