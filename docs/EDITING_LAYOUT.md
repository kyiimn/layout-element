# layout-element 레이아웃 편집 모드 상세 명세

> 작성 기준: `src/edit/edit-manager.ts`, `src/edit/layout-edit-controller.ts`, `src/edit/layout-selection-controller.ts`, `src/components/layout/box.element.ts`, `src/react/hooks/use-edit-manager.ts`
>
> 본 문서는 `layout-element` 라이브러리의 레이아웃 편집 모드 기능, 공개 API, 선택 동작, 드래그-이동, 스냅-그리드, 경계 클램핑, 텍스트 회피(리플로우), ESC 취소, 시각적 피드백, React 연동 방법을 상세히 기술한다.
>
> **관련 문서**:
> - **`EDITING_INSERT.md`**: 삽입 모드(`InsertController`) 상세 명세 — API, 대상 컨테이너 찾기 알고리즘, 요소 생성, 좌표 변환, 미리보기, ESC 취소
> - **`EDITING_EVENTS.md`**: `EditManager` 이벤트 상세 명세 — 모든 11개 이벤트 타입의 payload, 발생 트리거, 재진입 보호, 클릭 억제 플래그
> - **`EDITING_TEXT.md`**: 텍스트 편집 모드 상세 명세

---

## 1. 개요 (Overview)

레이아웃 편집 모드는 `<x-layout-box>` 요소를 시각적으로 선택하고 드래그하여 이동할 수 있는 기능이다. 텍스트 편집 모드(`editableText`)가 단락 내부의 텍스트를 수정하는 기능이라면, 레이아웃 편집 모드는 레이아웃 구조 요소 자체를 선택·이동하는 기능이다. `<x-layout-document>`는 레이아웃 편집 대상이 아니며, 오직 `<x-layout-box>`만 편집 대상이 된다.

이전에는 각 `<x-layout-box>`의 `editableLayout` 속성으로 개별적으로 편집 모드를 켰지만, 현재는 `EditManager`의 글로벌 `layoutEditMode`와 필터(`editableRoles`, `editableBoxIds`)를 통해 한 번에 제어한다. 개별 `editableLayout` 속성은 이제 DOM 속성/커서 표시용으로만 동작하며, 실제 판단은 `EditManager.isBoxEditable()`이 수행한다.

### 1.1 레이아웃 편집 모드 아키텍처

`EditManager.layoutEditMode = true`로 설정되면:

1. **모드 스위칭**: `layoutEditMode = true`는 `textEditMode`를 `false`로, `insertMode`를 `null`로 전환한다. 반대로 `textEditMode = true`는 `layoutEditMode`를 `false`로, `insertMode`를 `null`로 전환한다. `insertMode`가 활성화되면 `layoutEditMode`와 `textEditMode` 모두 `false`가 된다. `selectableMode`는 항상 독립적으로 동작하며 스위칭 대상이 아니다.
2. **전역 필터 활성화**: `editableRoles`와 `editableBoxIds`에 맞는 box가 편집 가능 상태로 전환된다.
3. **중앙 집중형 이벤트 처리**: `LayoutEditController`가 문서(document) 수준에서 `mousedown`을 캡처 단계로 감지하여, 편집 가능한 box에 한해 선택, 드래그, 리사이즈를 처리한다.
4. **선택 처리**: `LayoutSelectionController`가 문서(document) 수준에서 `click`을 캡처 단계로 감지하여 선택 가능한 box의 클릭 선택을 처리한다. 레이아웃 편집 모드에서 편집 가능한 box의 `click`은 `LayoutEditController`가 `mousedown`에서 이미 처리하므로 중복 선택을 방지하기 위해 건너뛴다.
4. **시각적 피드백**: 선택된 요소에 `selected` 속성이 설정되고, Shadow DOM의 `:host([selected])` 규칙에 의해 빨간색 `box-shadow`가 표시된다. `editableLayout` 속성이 켜진 box에는 `hovered` 상태로 파란색 외곽선이 표시된다.
5. **드래그 이동**: 선택된 요소를 마우스로 드래그하여 이동할 수 있다.
6. **크기 조정**: 선택된 요소의 가장자리 중앙에 4개의 리사이즈 핸들이 표시되며, 핸들을 드래그하여 크기를 조정할 수 있다.
7. **텍스트 리플로우**: 드래그 중 주변 단락이 실시간으로 텍스트를 다시 배치하여 이미지/박스를 회피한다.
8. **ESC 취소**: 드래그/리사이즈 중 ESC 키를 누르면 이동/크기 변경이 취소되고 시작 전 상태로 복원된다.
9. **이벤트 전파 차단**: `LayoutEditController`는 클릭 이벤트를 `stopPropagation()`하여 부모 요소까지 선택이 전파되지 않도록 한다.

```
┌─────────────────────────────────────────────────────────────────────┐
│ <x-layout-document>                                                  │
│   ┌────────────────────┐    ┌────────────────────┐                  │
│   │ <x-layout-box      │    │ <x-layout-box      │                  │
│   │  role="title"      │    │  role="body"       │                  │
│   │  [selected]        │    │  [hovered]         │                  │
│   │  cursor: grab ↄ   │    │  cursor: grab ↄ    │                  │
│   └────────────────────┘    └────────────────────┘                  │
│                                                                      │
│  EditManager (singleton)                                             │
│  ├── layoutEditMode: boolean                                         │
│  ├── selectableMode: boolean                                         │
│  ├── editableRoles: ReadonlySet<BoxRole> | null                      │
│  ├── editableBoxIds: ReadonlySet<string> | null                      │
│  ├── editableRootId: string | null                                    │
│  ├── selectableRoles: ReadonlySet<BoxRole> | null                     │
│  ├── selectableBoxIds: ReadonlySet<string> | null                     │
│  ├── selectableRootId: string | null                                   │
│  ├── setEditableRootId(id) / setSelectableRootId(id)                  │
│  ├── isBoxEditable(box) / isBoxSelectable(box)                        │
│  ├── selectedLayouts: LayoutElement[]                               │
│  ├── selectLayout()                                                  │
│  ├── clearLayoutSelection()                                          │
│  ├── setEditableRoles(roles) / setSelectableRoles(roles)              │
│  ├── setEditableBoxIds(ids) / setSelectableBoxIds(ids)                │
│  └── layoutSelectionChange event                                     │
│                                                                      │
│  LayoutSelectionController (선택 전용)                                  │
│  ├── document-level click (capture)                                    │
│  ├── isBoxSelectable → 선택 가능 box 클릭 시 selectLayout 호출          │
│  ├── 빈 영역 클릭 → clearLayoutSelection (모든 선택 해제)                │
│  └── 편집 모드 + 편집 가능 box 클릭 → 건너뜀 (mousedown에서 이미 처리)   │
│                                                                      │
│  LayoutEditController (편집 전용)                                        │
│  ├── document-level mousedown (capture)                                │
│  ├── drag state per box: Map<LayoutBoxElement, BoxDragState>          │
│  ├── resize state per box: Map<LayoutBoxElement, BoxResizeState>    │
│  ├── _computeNewPosition() / _computeNewSize()                        │
│  ├── ESC cancel                                                      │
│  └── affected paragraph rerender                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. API

### 2.1 Vanilla (Custom Element) API

#### 글로벌 레이아웃 편집 모드 (`EditManager.layoutEditMode`)

레이아웃 편집 모드는 `EditManager`의 글로벌 상태로 제어한다.

```typescript
const manager = EditManager.getInstance();

// 기본 이동 모드(move): 부모 내부에서만 이동 (경계 클램핑 적용)
manager.layoutEditMode = true;

// 부모 변경 모드(reparent): box를 다른 컨테이너로 옮기거나 부모 밖으로 빼낼 수 있음
manager.layoutEditMode = { type: 'reparent' };

// 비활성화
manager.layoutEditMode = false;

// 현재 편집 타입 조회
console.log(manager.layoutEditType); // 'move' | 'reparent'
```

`layoutEditMode`가 `true`(또는 `{ type: ... }`)가 되면 `EditManager`는 문서 안의 모든 `<x-layout-box>`를 순회하며, `isBoxEditable(box)` 결과에 따라 각 box의 `editableLayout` 속성을 갱신한다. `false`로 설정되면 모든 box의 `editableLayout` 속성이 `false`가 된다. **선택은 `selectableMode`가 `true`면 유지된다.** `selectableMode`가 `false`이고 `layoutEditMode`도 `false`가 되면 선택이 해제된다.

**기본적으로 모든 box가 허용된다.** `layoutEditMode`만 켜고 `editableRoles`와 `editableBoxIds`를 모두 `null`로 두면 Root 제한(`setEditableRootId`)과 lock을 제외한 모든 box가 편집 가능하다. 편집을 막으려면 `layoutEditMode`를 `false`로 설정하거나, `editableRoles`/`editableBoxIds`를 지정해 허용 범위를 좁혀야 한다. box의 `lock` 속성이 `true`이거나 조상 box 중 하나라도 lock이면 해당 box와 하위 요소는 항상 편집 불가이다.

**하위 호환**: `true`는 `{ type: 'move' }`와 동일하다. 기존 `boolean` API를 그대로 사용할 수 있다.

#### 역할 기반 필터: `setEditableRoles(roles)` / `editableRoles`

```typescript
manager.setEditableRoles(['body', 'title', 'none']);
console.log(manager.editableRoles); // ReadonlySet<BoxRole> | null

// 제한 해제
manager.setEditableRoles(null);
```

| 매개변수 | 타입 | 설명 |
|----------|------|------|
| `roles` | `BoxRole[] \| null` | 편집을 허용할 역할 목록. `null`이면 역할 기반 제한 없음 |

`BoxRole`에 `'none'`이 추가되었다. `box.role`이 설정되지 않았을 때는 `'none'`을 반환한다. 역할 미지정 box도 편집하려면 `'none'`을 목록에 포함해야 한다.

#### ID 기반 필터: `setEditableBoxIds(ids)` / `editableBoxIds` / `addEditableBox(id)` / `removeEditableBox(id)`

```typescript
manager.setEditableBoxIds(['box-1', 'box-2']);
manager.addEditableBox('box-3');
manager.removeEditableBox('box-1');
console.log(manager.editableBoxIds); // ReadonlySet<string> | null

// 제한 해제
manager.setEditableBoxIds(null);
```

| 매개변수 | 타입 | 설명 |
|----------|------|------|
| `ids` | `string[] \| null` | 편집을 허용할 box ID 목록. `null`이면 ID 기반 제한 없음 |
| `id` | `string` | `addEditableBox`/`removeEditableBox`로 개별 추가/제거할 box ID |

#### `isBoxEditable(box)` — 중앙 판별 함수

```typescript
const editable = manager.isBoxEditable(box); // boolean
```

판별 규칙은 AND 기반이다:

1. `layoutEditMode`가 `true`여야 한다.
2. box 자체 또는 조상 box 중 lock이 설정된 것이 있으면 `false`를 반환한다. lock은 box와 그 내부의 모든 하위 요소를 편집에서 제외한다.
3. `editableRootId`가 지정된 경우, box가 해당 Root box 내부의 자손이어야 한다. Root box 자체는 편집 불가하며 컨테이너 역할만 한다.
4. `editableRoles`가 설정되어 있으면 box의 `role`이 그 안에 포함되어야 한다.
5. `editableBoxIds`가 설정되어 있으면 box의 `id`가 그 안에 포함되어야 한다.
6. `editableRoles`와 `editableBoxIds`가 둘 다 `null`이면, Root 제한과 lock 제한을 제외한 모든 box가 편집 가능하다 (모두 허용 규칙).

| `layoutEditMode` | lock/ancestor lock | Root 범위 | `editableRoles` | `editableBoxIds` | box.role | box.id | 결과 |
|------------------|------------------|-----------|-----------------|------------------|----------|--------|------|
| false | (any) | (any) | (any) | (any) | (any) | (any) | `false` |
| true | locked | (any) | (any) | (any) | (any) | (any) | `false` |
| true | unlocked | outside Root | (any) | (any) | (any) | (any) | `false` |
| true | unlocked | inside Root | `null` | `null` | (any) | (any) | `true` |
| true | unlocked | inside Root | `['body']` | `null` | `'body'` | (any) | `true` |
| true | unlocked | inside Root | `['body']` | `null` | `'image'` | (any) | `false` |
| true | unlocked | inside Root | `null` | `['b1']` | (any) | `'b1'` | `true` |
| true | unlocked | inside Root | `['body']` | `['b1']` | `'body'` | `'b1'` | `true` |
| true | unlocked | inside Root | `['body']` | `['b1']` | `'body'` | `'b2'` | `false` |

#### 선택 모드 (`EditManager.selectableMode`)

편집 모드(`layoutEditMode`)가 꺼져 있어도 box 클릭으로 선택할 수 있는 모드이다. 이동/리사이즈/텍스트 수정은 여전히 편집 모드에서만 동작하지만, **선택 자체**는 선택 모드만 켜면 동작한다.

```typescript
const manager = EditManager.getInstance();

// 편집 모드 없이도 클릭 선택 가능
manager.selectableMode = true;

// 편집 모드도 켜면 선택 + 이동/리사이즈 모두 가능
manager.layoutEditMode = true;

// 선택 모드만 끄면 선택도 해제됨
manager.selectableMode = false;
```

| `selectableMode` | `layoutEditMode` | 선택 | 이동/리사이즈 |
|---|---|---|---|
| `false` | `false` | ✗ | ✗ |
| `true` | `false` | ✓ | ✗ |
| `false` | `true` | ✓ (편집 필터) | ✓ |
| `true` | `true` | ✓ (선택 필터 우선) | ✓ |

선택 모드가 켜지면 `LayoutSelectionController`가 부착되어 클릭 이벤트를 처리한다. 편집 모드가 꺼진 상태에서는 드래그/리사이즈는 시작되지 않고 클릭 선택만 처리된다. 문서의 빈 영역(box가 아닌 곳)을 클릭하면 모든 선택이 해제된다.

#### 모드 스위칭

각 모드의 setter는 활성화 시 다른 모드를 자동으로 비활성화한다. `selectableMode`는 항상 독립적으로 동작하며 스위칭 대상이 아니다.

| 설정 | 자동 전환 |
|------|-----------|
| `layoutEditMode = true` (또는 `{ type: 'move' }`) | `textEditMode = false`, `insertMode = null` |
| `layoutEditMode = { type: 'reparent' }` | `textEditMode = false`, `insertMode = null` |
| `textEditMode = true` | `layoutEditMode = false`, `insertMode = null` |
| `insertMode = (non-null)` | `layoutEditMode = false`, `textEditMode = false` |
| `selectableMode` | (변경 없음, 항상 독립) |

**편집 타입 전환**: `layoutEditMode = { type: 'reparent' }` → `layoutEditMode = true`(`{ type: 'move' }`) 처럼 타입만 변경할 때는 이미 편집 모드가 활성화되어 있으므로 다른 모드를 비활성화하지 않는다. `layoutEditType` getter로 현재 타입을 조회할 수 있다.

전환은 setter 호출을 통해 이루어지므로, 각 모드의 정리 로직(속성 해제, 커서 초기화, 컨트롤러 분리 등)이 자동으로 실행된다. 가드 `if (this._field === value) return`에 의해 무한 루프는 발생하지 않는다.

#### 선택 필터: `setSelectableRoles(roles)` / `setSelectableBoxIds(ids)` / `setSelectableRootId(id)`

선택 전용 필터는 편집 필터와 독립적으로 동작한다. 선택 전용 필터가 설정되지 않으면(`null`) 편집 필터를 대신 사용한다.

```typescript
// 선택 전용 role 필터 설정
manager.setSelectableRoles(['body', 'title']);
manager.selectableMode = true;

// 선택 전용 box id 필터 설정
manager.setSelectableBoxIds(['box-1', 'box-2']);

// 선택 전용 root 설정
manager.setSelectableRootId('root-box');

// 제한 해제 (편집 필터를 따름)
manager.setSelectableRoles(null);
manager.setSelectableBoxIds(null);
manager.setSelectableRootId(null);
```

| 매개변수 | 타입 | 설명 |
|----------|------|------|
| `roles` | `BoxRole[] \| null` | 선택 허용할 역할 목록. `null`이면 편집 필터(`editableRoles`)를 따름 |
| `ids` | `string[] \| null` | 선택 허용할 box ID 목록. `null`이면 편집 필터(`editableBoxIds`)를 따름 |
| `id` | `string \| null` | 선택 루트 box ID. `null`이면 편집 루트(`editableRootId`)를 따름 |

#### `isBoxSelectable(box)` — 선택 가능 판별 함수

```typescript
const selectable = manager.isBoxSelectable(box); // boolean
```

`isBoxEditable()`과 달리 `layoutEditMode` 여부와 무관하게 동작한다.

판별 규칙:

1. box 자체 또는 조상 box 중 lock이 설정된 것이 있으면 `false`를 반환한다.
2. 선택 전용 루트(`selectableRootId`)가 지정된 경우, box가 해당 루트 내부의 자손이어야 한다. `null`이면 편집 루트(`editableRootId`)를 따른다.
3. 선택 전용 role 필터(`selectableRoles`)가 설정되어 있으면 box의 `role`이 그 안에 포함되어야 한다. `null`이면 편집 필터(`editableRoles`)를 따른다.
4. 선택 전용 ID 필터(`selectableBoxIds`)가 설정되어 있으면 box의 `id`가 그 안에 포함되어야 한다. `null`이면 편집 필터(`editableBoxIds`)를 따른다.
5. 모든 필터가 `null`이면 lock/루트 제한을 제외한 모든 box가 선택 가능하다.

#### `editableLayout` 속성 (하위 호환)

**지원 요소**: `<x-layout-box>` (document는 레이아웃 편집 대상이 아님)

```typescript
// 활성화 (DOM 속성 + 커서 + 호버/선택 가능)
document.querySelector('x-layout-box').editableLayout = true;

// 비활성화
element.editableLayout = false;
```

| 동작 | `<x-layout-box>` |
|------|-------------------|
| `true` 설정 | `cursor: grab`, `editable-layout` DOM 속성 추가, 호버/선택 시각적 피드백 활성화 |
| `false` 설정 | `hovered`·`editable-layout` 제거, `cursor` 초기화, `EditManager._unregisterLayout()` 호출. **`selected`는 제거되지 않는다** — 선택은 `selectableMode`에 의해 독립적으로 관리된다 |
| 인쇄 모드 | `editableLayout` 설정 무시 |

> **설계**: `editableLayout` 속성은 더 이상 이벤트 리스너를 직접 등록하지 않는다. `connectedCallback`은 `mouseenter`와 `mouseleave`만 등록하고, `click`/`mousedown`/리사이즈 핸들 이벤트는 `LayoutEditController`가 문서 수준에서 처리한다. 개별 box에 `editableLayout = true`를 설정하면 `EditManager.isBoxEditable()`은 아니지만 `LayoutEditController`가 이전 버전과의 호환을 위해 여전히 편집 가능한 것으로 간주한다.

> **참고**: `<x-layout-document>`는 레이아웃 편집 대상이 아니므로 `editableLayout` 속성이 없다. 드래그와 선택은 `<x-layout-box>`에서만 동작한다.

#### 선택 동작

| 입력 | 동작 |
|------|------|
| **클릭** | 기존 선택을 모두 해제하고 클릭한 요소만 선택 |
| **Ctrl+클릭** (또는 **Cmd+클릭**) | 기존 선택에 추가. 이미 선택된 요소를 다시 클릭하면 선택 해제(토글) |
| **빈 영역 클릭** (box가 아닌 문서 여백) | 모든 선택 해제 (`clearLayoutSelection()`) |
| **클릭** (이벤트 전파) | `stopPropagation()`으로 부모 요소의 클릭 이벤트 차단. 중첩된 box를 클릭해도 상위 box가 함께 선택되지 않음 |
| **하위 요소 클릭** | 이벤트가 하위 레이아웃 요소(box)에서 발생한 경우, 상위 요소의 `LayoutEditController._onClick`/`LayoutEditController._onMouseDown`은 `_isEventFromDescendantLayout()` 검사로 해당 이벤트를 무시한다. 이를 통해 상위 요소가 선택된 상태에서도 하위 요소를 클릭하여 선택할 수 있다 |
| **선택되지 않은 요소 mousedown** | 선택되지 않은 요소를 mousedown하면 기존 선택을 해제하고 해당 요소를 선택한 후 드래그를 시작한다. `BoxDragState.selectedOnMouseDown` 플래그로 click에서 중복 선택을 방지한다 |

#### 드래그 이동 동작

| 입력 | 동작 |
|------|------|
| **선택된 box에서 mousedown + drag** | 박스를 마우스 이동 방향으로 이동. 이동 임계값 3px 초과 시 드래그로 인식 |
| **ESC (드래그 중)** | 드래그 취소, 시작 전 위치로 복원, 모든 드래그 리스너 해제 |
| **mouseup (드래그 완료)** | 최종 스냅 위치로 확정, 드래그 리스너 해제 |

#### 시각적 피드백

**선택 표시** (`selected`):

```css
:host([selected]) {
  box-shadow: red 0px 0px 0px 1px inset, red 0px 0px 0px 1px;
}
```

**호버 표시** (`hovered`) — `<x-layout-box>`만 해당:

```css
:host([hovered]) {
  box-shadow: #4a90d9 0px 0px 0px 1px inset, #4a90d9 0px 0px 0px 1px;
}
```

| 속성 | 색상 | 적용 대상 | 조건 |
|------|------|----------|------|
| `selected` | 빨간색 (`red`) | box | 레이아웃 편집 모드에서 클릭으로 선택됨, **또는** 텍스트 편집 모드에서 내부 paragraph가 포커스됨 |
| `hovered` | 파란색 (`#4a90d9`) | box만 | 마우스 hover, 선택되지 않은 요소만 |

- **inset shadow**: 요소 내부에 1px 테두리
- **outset shadow**: 요소 외부에 1px 테두리
- 기존 `border`가 있는 요소에서도 표시가 정상적으로 보인다
- `outline` 대신 `box-shadow`를 사용하는 이유: `outline`은 기존 `border`와 겹칠 때 표시되지 않을 수 있기 때문

**호버 동작 규칙**:

1. 인쇄 모드가 아니고 `selected`가 없는 `<x-layout-box>`에 마우스가 올라가면 `hovered`가 설정된다. 레이아웃 편집 모드 여부와 관계없이 화면 렌더링 중에는 항상 동작한다.
2. 이미 선택된 요소(`selected`)는 호버 표시가 나타나지 않는다. 텍스트 편집 포커스로 인해 `selected`가 설정된 box도 동일하게 호버가 억제된다.
3. **paragraph 포커스로 인해 부모 box가 `selected`로 전환될 때, 해당 box의 기존 `hovered` 속성은 제거된다**. 이는 paragraph 위에 마우스가 있는 상태에서 클릭으로 포커스를 줄 때, 즉시 빨간색 `selected` 테두리가 파란색 `hovered` 테두리를 덮어쓰도록 보장한다.
4. 마우스가 요소에 진입하면 **조상 요소의 `hovered`를 모두 제거**하여, 가장 안쪽(최상위) 요소만 호버 표시가 보인다
5. 마우스가 자식 요소에서 부모 영역으로 돌아갈 때, `elementFromPoint`를 사용하여 마우스 위치 아래의 가장 가까운 `LayoutBoxElement`를 찾아 호버를 복원한다
6. **드래그 이동 중이거나 크기 조정 중에는 hover가 동작하지 않는다**. `EditManager._isDraggingLayout()` 또는 `_isResizingLayout()`이 `true`이면 `LayoutBoxElement._onLayoutMouseEnter`와 `_onLayoutMouseLeave`가 early return하여 hover 표시가 나타나지 않는다. 이로 인해 드래그/리사이즈 중에 마우스가 다른 박스 위로 이동해도 방해가 되지 않는다. 드래그/리사이즈가 종료되면 정상적으로 hover가 동작한다. 비편집 모드에서는 드래그/리사이즈가 활성화되지 않으므로 이 제한이 적용되지 않는다.
7. **삽입 드래그 중에도 hover가 동작하지 않는다**. `EditManager._isInsertDragging()`이 `true`인 동안(= 사용자가 드래그로 새 요소를 그리고 있는 동안) `_onLayoutMouseEnter`/`_onLayoutMouseLeave`가 early return한다. 단, 삽입 모드(`insertMode`)가 활성화되어 있더라도 드래그 중이 아니면 hover가 정상 동작한다. 요소 삽입 완료 후 `insertMode`를 유지한 채로 다른 box 위로 마우스를 올리면 파란색 hover 테두리가 표시된다.

**CSS 우선순위**: `:host([hovered])` 규칙이 `:host([selected])` 규칙보다 먼저 정의되어, 동일 specificity일 때 `selected`가 시각적으로 우선 적용된다. `hovered`와 `selected`가 동시에 있으면 빨간색 `selected` 테두리가 표시된다.

| 상태 | 커서 | 시각적 피드백 |
|------|------|-------------|
| 비편집 모드 (선택 안 됨, hover) | (기본값) | 파란색 테두리 (`hovered`) |
| 비편집 모드 (선택 됨, selectableMode) | (기본값) | 빨간색 테두리 (`selected`), 리사이즈 핸들은 미표시 |
| 비편집 모드 (선택 안 됨, 미호버) | (기본값) | 회색 기본 테두리 (`:host(:not([border]))`) |
| 텍스트 편집 포커스 (내부 paragraph가 포커스) | (기본값) | 빨간색 테두리 (`selected`), 리사이즈 핸들은 미표시 |
| `editableLayout = true` (선택 안 됨, hover) | `grab` | 파란색 테두리 (`hovered`) |
| `editableLayout = true` (선택됨, 대기) | `grab` | 빨간색 테두리 (`selected`), 리사이즈 핸들 4개 표시 |
| `editableLayout = true` (드래그 중) | `grabbing` | 빨간색 테두리 (`selected`) |
| `editableLayout = true` (리사이즈 중) | 핸들 방향별 (`ns-resize`/`ew-resize`) | 빨간색 테두리 (`selected`) |
| 인쇄 모드 | (해당 없음) | hover/선택 highlight 모두 억제 |

#### 리사이즈 핸들 (Resize Handles)

선택된 `<x-layout-box>`의 가장자리 중앙에 4개의 리사이즈 핸들이 표시된다.

```
                  ┌─────── [top] ───────┐
                  │         •           │
              [left]•                 •[right]
                  │         •         │
                  └─────── [bottom] ───┘
```

| 핸들 | 위치 | 커서 | 방향 |
|------|------|------|------|
| `top` | 상단 가장자리 중앙 | `ns-resize` | 상하 리사이즈 |
| `bottom` | 하단 가장자리 중앙 | `ns-resize` | 상하 리사이즈 |
| `left` | 좌측 가장자리 중앙 | `ew-resize` | 좌우 리사이즈 |
| `right` | 우측 가장자리 중앙 | `ew-resize` | 좌우 리사이즈 |

핸들은 CSS로 표시/숨김을 제어한다:
- `:host([editable-layout][selected]) .resize-handle { display: block; }` — 레이아웃 편집 모드(`editable-layout`)에서 선택(`selected`) 시 표시
- `:host(:not([selected])) .resize-handle { display: none; }` — 미선택 시 숨김
- 핸들의 `mousedown` 이벤트는 `stopPropagation()`으로 버블링을 차단하여, 드래그-이동이 함께 트리거되지 않도록 한다.

> **참고**: `editable-layout` 속성은 `EditManager.layoutEditMode = true`일 때 `_applyEditableLayoutToAllBoxes()`를 통해 설정된다. 따라서 텍스트 편집 모드에서 paragraph 포커스로 인해 부모 box가 `selected`가 되더라도 `editable-layout`이 없으면 리사이즈 핸들은 표시되지 않는다. 레이아웃 편집 모드에서만 리사이즈 핸들이 노출된다.

### 2.2 `LayoutEditController` 중앙 이벤트 처리

`LayoutEditController`는 `EditManager.layoutEditMode`가 활성화될 때 생성되어 문서(document) 수준에서 마우스 이벤트를 캡처 단계로 처리한다. 이전의 per-box 핸들러(`box._onLayoutClick`, `box._onLayoutMouseDown` 등)는 제거되었고, 모든 드래그/리사이즈/선택 로직이 여기로 집중되었다.

`LayoutEditController`는 `EditManager.isBoxEditable()` 외에도 lock과 `editableRootId`를 별도로 검사한다. 따라서 `EditManager`에서 잠금이나 루트 제한을 판별하지 않더라도, 이벤트 처리 단계에서 동일한 제한이 적용되어 lock/Root 밖의 box는 드래그/리사이즈/선택되지 않는다.

#### 이벤트 등록

```typescript
// EditManager.layoutEditMode = true 일 때
this._layoutEditController = new LayoutEditController(document.documentElement);
this._layoutEditController.attach();
```

`attach()`는 다음 리스너를 등록한다:

| 이벤트 | 단계 | 콜백 | 목적 |
|--------|------|------|------|
| `mousedown` | capture | `_onMouseDown` | 드래그 시작, 리사이즈 핸들 감지, 삽입 모드 위임 |

`detach()`는 위 리스너를 제거하고 진행 중인 모든 드래그/리사이즈를 취소한다.

### 2.3 `LayoutSelectionController` 클릭 선택 처리

`LayoutSelectionController`는 `EditManager.selectableMode`가 활성화될 때 생성되어 문서(document) 수준에서 `click` 이벤트를 캡처 단계로 처리한다. 편집 모드(`layoutEditMode`)와 무관하게 동작하며, **선택만** 처리한다. 드래그/리사이즈는 `LayoutEditController`가 담당한다.

```typescript
// EditManager.selectableMode = true 일 때
this._selectionController = new LayoutSelectionController(document.documentElement);
this._selectionController.attach();
```

`attach()`는 다음 리스너를 등록한다:

| 이벤트 | 단계 | 콜백 | 목적 |
|--------|------|------|------|
| `click` | capture | `_onClick` | 단일/다중 선택 |

`detach()`는 위 리스너를 제거한다.

#### `_onClick` 처리 흐름

```
클릭 이벤트 (capture phase)
    │
    ▼
LayoutSelectionController._onClick(event)
    ├── _findSelectableBoxFromEvent(event) → box
    ├── EditManager.insertMode? → return (삽입 모드에서는 선택 무시)
    ├── box === null? → clearLayoutSelection(); return (빈 영역 클릭 → 모든 선택 해제)
    ├── layoutEditMode && isBoxEditable(box)? → return (편집 모드에서는 mousedown이 이미 선택 처리)
    ├── event.stopPropagation()
    ├── _isEventFromDescendantLayout(event, box)? → return
    ├── box.removeAttribute('hovered')
    ├── _setMultiSelect(event.ctrlKey || event.metaKey)
    ├── selectLayout(box)
    └── _setMultiSelect(false)
```

**빈 영역 클릭**: 선택 가능한 box가 아닌 곳(문서 여백, 텍스트 등)을 클릭하면 `clearLayoutSelection()`이 호출되어 모든 선택이 해제된다.

**편집 모드 가드**: `layoutEditMode`가 `true`이고 클릭한 box가 `isBoxEditable()`을 통과하면, `mousedown`에서 `LayoutEditController`가 이미 선택을 처리했으므로 `click`에서 중복 실행을 건너뛴다. 편집 가능하지 않은 box(필터링된 role 등)는 `click`에서 선택 처리된다.

> **참고**: `LayoutSelectionController`는 드래그/리사이즈 상태를 관리하지 않으므로, 드래그 직후 클릭 무시 로직이 없다. 이는 `LayoutEditController`의 `_onClick`에만 존재했는데, 선택 컨트롤러가 클릭만 처리하므로 드래그 후 클릭 무시가 필요 없다.

#### 상태 저장 방식

각 box별 상태는 box 인스턴스가 아닌 `LayoutEditController` 내부의 `Map`에 저장된다.

```typescript
private _dragStates = new Map<LayoutBoxElement, BoxDragState>();
private _resizeStates = new Map<LayoutBoxElement, BoxResizeState>();
```

| 상태 | 필드 | 설명 |
|------|------|------|
| 드래그 | `BoxDragState` | `isDragging`, `dragMoved`, `selectedOnMouseDown`, `startMouseX/Y`, `startLeft/Top`, `originalLeft/Top/Width/Height/Position`, `lastClientX/Y`, `rafId`, `affectedParagraphs` |
| 리사이즈 | `BoxResizeState` | `isResizing`, `handle`, `moved`, `startMouseX/Y`, `startLeft/Top/Width/Height`, `lastClientX/Y`, `rafId`, `affectedParagraphs` |

#### 삽입 모드 위임

`_onMouseDown`은 `EditManager.insertMode`가 활성화되어 있으면 `EditManager.handleInsertMouseDown(event)`를 호출한 후 모든 레이아웃 편집 동작을 중단한다.

#### 하위 요소 이벤트 무시

`_isEventFromDescendantLayout(event, box)`는 `event.composedPath()`를 검사하여 하위 box에서 시작된 이벤트인지 확인한다. 하위 box에서 시작된 이벤트면 상위 box의 처리를 건너뛴다.

---

### 2.3 EditManager API

`EditManager`는 텍스트 편집과 레이아웃 선택 모두를 관리하는 글로벌 싱글톤이다.

#### 레이아웃 편집 모드 및 필터

```typescript
const manager = EditManager.getInstance();

// 글로벌 모드
manager.layoutEditMode = true;

// 역할 필터 (null = 제한 없음)
manager.setEditableRoles(['body', 'title', 'none']);
console.log(manager.editableRoles); // ReadonlySet<BoxRole> | null

// ID 필터 (null = 제한 없음)
manager.setEditableBoxIds(['box-1', 'box-2']);
manager.addEditableBox('box-3');
manager.removeEditableBox('box-1');
console.log(manager.editableBoxIds); // ReadonlySet<string> | null

// 편집 루트 (null = 문서 전체)
manager.setEditableRootId('box-1');
console.log(manager.editableRootId); // string | null

// 판별
const editable = manager.isBoxEditable(box); // boolean
```

#### 레이아웃 선택 관련 메서드

```typescript
// 선택
manager.selectLayout(element);              // 단일 요소 선택 (기존 선택 해제)
manager.selectLayout('element-id');          // ID로 선택
manager.selectLayout([element1, element2]);  // 여러 요소 선택

// 모든 선택 해제
manager.clearLayoutSelection();

// 현재 선택된 요소들
manager.selectedLayouts;   // LayoutElement[]
manager.selectedLayoutIds; // string[]
```

#### `selectLayout(target, multi?)`

| 매개변수 | 타입 | 설명 |
|----------|------|------|
| `target` | `LayoutElement \| string \| (LayoutElement \| string)[]` | 선택할 요소, ID, 또는 배열 |
| 반환값 | `boolean` | 하나 이상 선택되면 `true`, 모두 실패하면 `false` |

**동작**:
- `EditManager.isBoxEditable(element)`가 `true`이거나, 하위 호환을 위해 `element.editableLayout`이 `true`인 요소만 선택 가능하다. 둘 다 아니면 무시된다.
- lock이거나 조상 lock인 box, 또는 `editableRootId`가 지정된 경우 Root 밖의 box는 선택되지 않는다.
- 기본(단일 선택) 모드: 기존 선택을 모두 해제하고 지정된 요소만 선택한다.
- 다중 선택 모드(`_multiSelect = true`): 기존 선택에 추가. 이미 선택된 요소를 다시 지정하면 선택 해제(토글).
- 다중 선택 모드는 클릭 핸들러가 Ctrl/Meta 키 상태에 따라 설정한다. 직접 호출해서는 변경할 수 없다.

#### `getTopLevelDragTargets()`

선택된 레이아웃 요소들 중에서 중첩(ancestor-descendant) 관계에 있는 하위 요소를 제외하고, 최상위 `LayoutBoxElement`만 반환한다.

- 서로 ancestor-descendant 관계에 있는 요소 중 ancestor만 유지되고 descendant는 제외된다.
- 서로 독립적인(형제 또는 다른 트리의) 요소들은 모두 유지된다.
- 단일 요소만 선택된 경우 필터링 없이 그대로 반환된다.

#### `_isDraggingLayout()`

현재 레이아웃 드래그 이동 중인지 반환한다.

| 반환값 | 타입 | 설명 |
|--------|------|------|
| 반환값 | `boolean` | 드래그 이동 중이면 `true`, 아니면 `false` |

`_startLayoutDrag()`가 호출되면 `true`로 설정되고, `_endLayoutDrag()`가 호출되면 `false`로 설정된다. 이 값은 `LayoutBoxElement._onLayoutMouseEnter`/`_onLayoutMouseLeave`에서 hover 표시를 차단하는 데 사용된다.

#### `_isResizingLayout()`

현재 레이아웃 크기 조정 중인지 반환한다.

| 반환값 | 타입 | 설명 |
|--------|------|------|
| 반환값 | `boolean` | 크기 조정 중이면 `true`, 아니면 `false` |

`_startLayoutResize()`가 호출되면 `true`로 설정되고, `_endLayoutResize()`가 호출되면 `false`로 설정된다. 이 값은 `LayoutBoxElement._onLayoutMouseEnter`/`_onLayoutMouseLeave`에서 hover 표시를 차단하는 데 사용된다.

#### `_isInsertDragging()`

현재 삽입 드래그를 진행 중인지 반환한다.

| 반환값 | 타입 | 설명 |
|--------|------|------|
| 반환값 | `boolean` | 삽입 드래그 중이면 `true`, 아니면 `false` |

`InsertController.isDragging` 값을 위임하며, `InsertController.startDrag()`가 호출되면 `true`로, `_cleanup()`이 호출되면 `false`로 전환된다. `insertMode`가 활성화되어 있더라도 드래그 중이 아니면 `false`를 반환한다. 이 값은 `LayoutBoxElement._onLayoutMouseEnter`/`_onLayoutMouseLeave`에서 삽입 드래그 중 hover 표시를 차단하는 데 사용된다.

#### `setEditableRootId(id)` / `editableRootId`

```typescript
// 특정 box 내부 요소만 편집 가능. Root 자체는 이동/크기조정 불가
manager.setEditableRootId('box-1');
manager.setEditableRoles(['body']);
manager.layoutEditMode = true;
// → box-1 내부의 role='body' box만 편집 가능
// → box-1 자체는 편집 불가 (컨테이너)
// → box-1 외부의 box는 편집 불가

// 제한 해제
manager.setEditableRootId(null);
```

| 매개변수 | 타입 | 설명 |
|----------|------|------|
| `id` | `string \| null` | 편집 루트로 지정할 box ID. `null`이면 루트 제한 없음 |

`setEditableRootId`는 레이아웃 편집 모드와 텍스트 편집 모드 모두에 동시에 적용된다. 값이 변경되면 두 모드에 대해 각각 `_applyEditableLayoutToAllBoxes()`와 `_applyEditableTextToAllParagraphs()`가 호출되어, 활성화된 모드의 요소 상태를 갱신한다.

#### 이벤트: `layoutSelectionChange` / `layoutMove` / `layoutResize` / `insert` / `insertCancel`

레이이아웃 편집 및 삽입 관련 이벤트의 payload 필드, 발생 시점, 발생 조건, 사용 예시는 **`EDITING_EVENTS.md`**를 참조한다. 본 문서에서는 이벤트 발생과 관련된 동작 흐름만 기술한다.

- `layoutSelectionChange`: box 선택이 변경될 때 발생. [3.1 요소 선택 흐름](#31-요소-선택-흐름)과 [6.4 `layoutMove` 이벤트 흐름](#64-layoutmove-이벤트-흐름) 참조.
- `layoutMove`: 드래그 이동 완료/취소 시 발생. [6.4 `layoutMove` 이벤트 흐름](#64-layoutmove-이벤트-흐름) 참조.
- `layoutResize`: 리사이즈 완료/취소 시 발생. [11.5 `layoutResize` 이벤트](#115-layoutresize-이벤트) 참조.
- `insert` / `insertCancel`: 삽입 완료/취소 시 발생. **`EDITING_INSERT.md`** 및 **`EDITING_EVENTS.md`** 참조.

#### 화면 scale 보정 (`EditManager.setScale`/`screenPxToMm`)

미리보기 영역에 CSS `transform: scale(s)`이 적용된 환경에서는 `MouseEvent.clientX/clientY` 및 `Element.getBoundingClientRect()`가 변환된 픽셀 좌표를 반환한다. 이때 `GridCalculator.ppm`을 그대로 사용하면 `mm ↔ px` 환산이 어긋나 영역 그리기, 드래그 이동, 리사이즈의 좌표가 모두 어긋난다. 단 `GridCalculator.ppm` 자체를 보정하면 `text-layout-engine`의 `fontSizePx = fontSize * ppm` 계산까지 절반/두배로 줄어드는 부작용이 생긴다.

해결: `EditManager`가 별도의 `_scale` 보정 계수를 보관하고, `screenPxToMm(px)` / `screenDeltaToMm(deltaPx)` 헬퍼가 `px / (GridCalculator.ppm * _scale)`로 환산한다. `GridCalculator.ppm`은 항상 `originalPpm`을 반환하므로 폰트 크기/column 폭 계산은 정상이다. `InsertController`/`LayoutEditController`의 모든 mm 환산은 이 헬퍼를 통해 정확하게 동작한다.

텍스트 편집(`TextEditController`/`TextEditCoordinateMapper`)은 `getBoundingClientRect()`만으로 좌표를 비교하므로 scale 보정과 무관하게 정확하다 (입력 clientX와 비교 대상 rect 모두 같은 viewport 픽셀 좌표계).

**scale 변경 시 paragraph 재렌더링**: `setScale(s)`는 보정 계수를 설정한 뒤, 문서 내 모든 `<x-layout-paragraph>`에 대해 `markStructureChangedAndRender()`를 호출한다. 이는 `TextLayoutEngine._columnPpm`(컬럼 픽셀/mm 비율)이 `layoutStructure()` 시점의 scale을 반영하여 측정되기 때문이다. scale이 변경되어도 `paragraph.render()`가 `_perfStructureChanged = false` 상태로 호출되면 `layoutText()`만 실행되어 이전 scale 기준의 `_columnPpm`이 재사용되고, `partWidths`(현재 scale의 viewport 픽셀)와 `_charWidthPx`(이전 scale ppm 기반)가 불일치하여 컬럼에 들어가는 문자 수가 잘못 계산된다. `markStructureChangedAndRender()`가 `_perfStructureChanged = true`를 설정하여 다음 `render()`에서 `layoutStructure()`가 호출되도록 보장함으로써 `_columnPpm`이 새 scale 기준으로 재측정된다.

```typescript
const manager = EditManager.getInstance();

// 마운트 시: zoom 상태에 맞춰 보정 계수 적용
React.useEffect(() => {
  manager.setScale(previewScale);
}, [previewScale]);

// 언마운트 시: 1로 원복 (다른 인스턴스에 영향 방지)
React.useEffect(() => {
  return () => manager.resetScale();
}, []);
```

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `EditManager.setScale(s)` | `(scale: number) => void` | 보정 계수 설정. `s > 0`. 이후 `screenPxToMm`/`screenDeltaToMm`이 `originalPpm * s`로 환산. 또한 문서 내 모든 `<x-layout-paragraph>`에 대해 `markStructureChangedAndRender()`를 호출하여 `_columnPpm`이 새 scale 기준으로 재측정되도록 한다 |
| `EditManager.resetScale()` | `() => void` | 보정 계수를 `1`로 원복 |
| `EditManager.scale` | getter | 현재 보정 계수 |
| `EditManager.screenPxToMm(px)` | `(px: number) => number` | 화면 픽셀 → mm 환산 (`px / (ppm * scale)`) |
| `EditManager.screenDeltaToMm(deltaPx)` | `(deltaPx: number) => number` | 화면 픽셀 델타 → mm 델타 환산 |

**주의**: `_scale`은 `EditManager` 인스턴스에 종속된다. LayoutEditor는 단일 `EditManager` 인스턴스를 사용하므로 정상 동작하지만, 미니맵·툴팁 등 다른 동시 렌더링이 있다면 보정 없이 `1`로 유지하거나, unmount 시 반드시 `resetScale()`을 호출해 다른 인스턴스에 영향이 없도록 해야 한다.

### 2.4 LayoutElement 타입

```typescript
type LayoutElement = LayoutBoxElement;
```

`LayoutElement`은 `EditManager`에서 레이아웃 선택 대상이 되는 요소의 타입이다. `<x-layout-document>`은 레이아웃 편집 대상이 아니며, `<x-layout-paragraph>`도 레이아웃 선택 대상이 아니다.

#### 2.4.1 BoxRole (박스 역할)

`<x-layout-box>`는 `role` 속성을 통해 의미적 역할을 가진다. `BoxData.role` 필드에 매핑되며, 렌더링 및 레이아웃 배치 시 참조된다.

```typescript
type BoxRole =
  | 'group-article'   // 기사 그룹 컨테이너
  | 'body'            // 본문 영역
  | 'image'           // 이미지 영역
  | 'title'           // 제목 영역
  | 'caption'         // 캡션 영역
  | 'group-image'     // 이미지 그룹 컨테이너
  | 'header'          // 면머리 그룹 컨테이너
  | 'ad'              // 광고 이미지 영역
  | 'none';           // 역할 미지정 (기본값)
```

| 역할 | 설명 |
|------|------|
| `'group-article'` | 기사 그룹 컨테이너. 여러 박스를 묶어 하나의 기사 단위로 구성 |
| `'body'` | 본문 영역. 일반 텍스트 본문이 위치하는 박스 |
| `'image'` | 이미지 영역. 단일 이미지가 위치하는 박스 |
| `'title'` | 제목 영역. 기사 제목이 위치하는 박스 |
| `'caption'` | 캡션 영역. 이미지 캡션 등 부가 설명이 위치하는 박스 |
| `'group-image'` | 이미지 그룹 컨테이너. 여러 이미지 박스를 묶어 하나의 이미지 그룹으로 구성 |
| `'header'` | 면머리 그룹 컨테이너. 신문 지면 상단의 면머리 영역을 구성하는 박스 그룹 |
| `'ad'` | 광고 이미지 영역. 광고 이미지가 위치하는 박스 |
| `'none'` | 역할 미지정. `role` 속성이 없는 box의 기본값 |

`role` 속성은 `<x-layout-box>`의 `observedAttributes`에 등록되어 있어, DOM 속성 변경 시 `attributeChangedCallback`을 통해 `_role` 필드로 반영된다. `data` setter를 통해서도 `data.role`에서 `_role`로 동기화된다. React 래퍼(`LayoutBox`)는 `role` prop을 통해 이 값을 설정한다. role이 설정되지 않은 box의 `box.role` getter는 이제 `null` 대신 `'none'`을 반환한다.

### 2.4.2 `lock` (편집 잠금)

`BoxData.lock?: boolean`은 box의 편집 잠금 상태를 나타낸다. `true`이면 box 자체와 내부의 모든 자식 요소(box, paragraph, image 등)가 편집에서 제외된다. 조상 box 중 하나라도 lock이면 하위 요소 전부에 적용된다.

```typescript
const boxData: BoxData = {
  type: 'box',
  id: 'locked-group',
  lock: true,
  // lock이 적용되어 있으므로 이 안의 모든 자식 요소도 편집 불가
  children: [
    { type: 'box', /* ... */ },
    { type: 'box', /* ... */ },
  ],
};
```

| 상태 | 레이아웃 편집 | 텍스트 편집 | 요소 삽입 |
|------|--------------|------------|----------|
| lock = false, 조상도 unlock | 필터 통과 시 가능 | 필터 통과 시 가능 | 가능 |
| lock = true 또는 조상 lock | box 이동/리사이즈 불가 | 내부 paragraph 포커스/입력 불가 | lock 영역 내부에 삽입 불가 |

`LayoutBoxElement`는 `lock`을 DOM 속성(`[lock]`)과 JS getter/setter로 노출한다. `data` setter로 `BoxData.lock`을 설정하거나, `element.lock = true`로 직접 설정할 수 있다. lock이 변경되면 `EditManager`가 활성화된 편집 모드에 따라 모든 box/paragraph의 `editableLayout`/`editableText`를 재평가한다.

### 2.5 React API

#### `useEditManager` 훅

```typescript
import { useEditManager } from 'layout-element/react';

function MyComponent() {
  const {
    selectedLayouts,        // LayoutElement[]
    selectedLayoutIds,      // string[]
    selectLayout,           // (target) => boolean
    clearLayoutSelection,   // () => void
    layoutEditMode,         // boolean
    setLayoutEditMode,      // (value: boolean) => void
    setEditableRoles,       // (roles: BoxRole[] | null) => void
    setEditableBoxIds,    // (ids: string[] | null) => void
    onLayoutSelectionChange, // callback
    onLayoutMove,           // callback
  } = useEditManager({
    onLayoutSelectionChange: (event) => {
      console.log('Selection changed:', event.selectedLayouts);
    },
    onLayoutMove: (event) => {
      if (event.canceled) {
        console.log('Drag canceled, restored to:', event.previousLeft, event.previousTop);
      } else {
        console.log('Drag completed:', event.left, event.top);
      }
    },
  });

  return (
    // ...
  );
}
```

| 반환값 | 타입 | 설명 |
|--------|------|------|
| `selectedLayouts` | `LayoutElement[]` | 현재 선택된 레이아웃 요소 배열 |
| `selectedLayoutIds` | `string[]` | 선택된 요소의 ID 배열 |
| `selectLayout` | `(target) => boolean` | 레이아웃 선택 |
| `clearLayoutSelection` | `() => void` | 모든 레이아웃 선택 해제 |
| `layoutEditMode` | `boolean` | 현재 글로벌 레이아웃 편집 모드 상태 |
| `setLayoutEditMode` | `(value: boolean) => void` | 글로벌 레이아웃 편집 모드 설정 |
| `setEditableRoles` | `(roles: BoxRole[] \| null) => void` | 편집 허용 역할 집합 설정 |
| `setEditableBoxIds` | `(ids: string[] \| null) => void` | 편집 허용 box ID 집합 설정 |

#### 컴포넌트 Props

```tsx
<LayoutDocument>
  {/* 권장: EditManager의 글로벌 모드 + 필터로 제어 */}
  <LayoutBox role="body" id="body-1">
    {/* ... */}
  </LayoutBox>
  <LayoutBox role="image" id="image-1">
    {/* ... */}
  </LayoutBox>
</LayoutDocument>
```

| Prop | 타입 | 설명 |
|------|------|------|
| `editableLayout` | `boolean?` | 하위 호환용. DOM 속성/커서/시각적 피드백만 제어. 실제 편집 가능 여부는 `EditManager.isBoxEditable()`이 결정 |
| `role` | `BoxRole?` | 박스의 의미적 역할. `'none'`이 기본값. 자세한 값은 [2.4.1 BoxRole](#241-boxrole-박스-역할) 참조 |
| `id` | `string?` | box ID. `editableBoxIds` 필터와 `editableRootId`에 사용 |
| `lock` | `boolean?` | 편집 잠금. `true`이면 box와 내부 자식 요소 모두 편집 불가. 조상 lock도 하위에 상속 적용 |

---

## 3. 동작 세부 사항

### 3.1 요소 선택 흐름

선택은 두 개의 독립적인 컨트롤러가 처리한다:

**`LayoutSelectionController._onClick`** (선택 전용, `click` capture):
```
클릭 이벤트
    │
    ▼
LayoutSelectionController._onClick(event)
    ├── _findSelectableBoxFromEvent(event) ← composedPath에서 가장 안쪽 선택 가능 box 반환
    ├── insertMode? → return
    ├── box === null? → clearLayoutSelection(); return (빈 영역 클릭)
    ├── layoutEditMode && isBoxEditable(box)? → return (편집 모드에서는 mousedown이 이미 처리)
    ├── event.stopPropagation()             ← 부모 요소로의 이벤트 전파 차단
    ├── _isEventFromDescendantLayout(event, box)? ← 하위 레이아웃 요소에서 온 이벤트면 무시
    │   └── return (하위 요소가 자체적으로 처리)
    ├── _setMultiSelect(event.ctrlKey || event.metaKey)
    ├── EditManager.selectLayout(box)
    │   ├── isBoxSelectable(box) 검증
    │   ├── 기존 선택 해제 (단일 선택 모드)
    │   │   또는 토글 (다중 선택 모드)
    │   ├── selected 속성 설정/해제
    │   └── layoutSelectionChange 이벤트 발생
    └── _setMultiSelect(false)
```

**`LayoutEditController._onMouseDown`** (드래그/리사이즈, `mousedown` capture):
```
mousedown 이벤트
    │
    ▼
LayoutEditController._onMouseDown(event)
    ├── _findEditableBoxFromEvent(event) ← composedPath에서 가장 안쪽 편집 가능 box 반환
    ├── box === null? → return
    ├── insertMode? → handleInsertMouseDown(event); return
    ├── button !== 0? → return
    ├── _isEventFromResizeHandle(event, box)? → _startResize(event, box); return
    ├── _isEventFromDescendantLayout(event, box)? → return
    └── _startDrag(event, box)
        ├── !box.hasAttribute('selected')?
        │   ├── _setMultiSelect(event.ctrlKey || event.metaKey)
        │   ├── selectLayout(box)          ← 기존 선택 해제 + 이 요소 선택
        │   ├── _setMultiSelect(false)
        │   └── BoxDragState.selectedOnMouseDown = true
        ├── event.preventDefault()
        ├── event.stopPropagation()
        └── ... (드래그 상태 초기화)
```

### 3.1.1 mousedown에서의 자동 선택

선택되지 않은 요소를 mousedown하면 기존 선택을 해제하고 해당 요소를 선택한 후 드래그를 시작한다.
이를 통해 사용자가 먼저 클릭하여 선택한 후 드래그하는 두 단계 동작 없이,
한 번의 드래그 동작으로 요소를 선택하고 이동할 수 있다.

```
LayoutEditController._onMouseDown(event)
    ├── _findSelectableBoxFromEvent(event)
    ├── button !== 0? → return
    ├── _isEventFromResizeHandle(event, box)? → _startResize(event, box); return
    ├── _isEventFromDescendantLayout(event, box)? → return (하위 요소가 처리)
    ├── !box.hasAttribute('selected')? (선택되지 않은 요소)
    │   ├── EditManager.selectLayout(box)   ← 기존 선택 해제 + 이 요소 선택
    │   └── BoxDragState.selectedOnMouseDown = true  ← click에서 중복 선택 방지 플래그
    ├── event.preventDefault()
    ├── event.stopPropagation()
    ├── _startDrag(event, box)              ← 드래그 상태 초기화
    │   ├── BoxDragState.isDragging = true
    │   ├── BoxDragState.dragMoved = false
    │   └── EditManager._startLayoutDrag()
    └── ...
```

`BoxDragState.selectedOnMouseDown` 플래그:
- `true`: mousedown에서 선택 처리를 완료했음. 이후 click 이벤트에서 `selectLayout`을 다시 호출하지 않음.
- `false`: mousedown에서 선택하지 않았음(이미 선택된 요소). click에서 정상적으로 선택 토글 처리.

### 3.1.2 하위 요소 클릭 시 이벤트 처리

중첩된 레이아웃 요소 구조에서 하위 box를 클릭하면:

```
하위 box 클릭 (상위 box가 선택된 상태)
    │
    ├── mousedown 이벤트 (document capture)
    │   ├── LayoutEditController._onMouseDown
    │   │   └── _findSelectableBoxFromEvent → 가장 안쪽 선택 가능 box 반환
    │   └── _isEventFromDescendantLayout(event, 상위 box) === true → return (상위는 무시)
    │
    └── click 이벤트 (document capture)
        └── LayoutEditController._onClick
            ├── _findSelectableBoxFromEvent → 하위 box
            ├── event.stopPropagation()
            ├── selectedOnMouseDown === true → return (중복 선택 방지)
            └── (selectLayout 생략, 이미 mousedown에서 선택 완료)
```

`LayoutEditController`의 `_onMouseDown`과 `_onClick`은 `_isEventFromDescendantLayout()` 검사로
하위 레이아웃 요소에서 온 이벤트를 무시한다. 이를 통해 상위 요소가 선택된 상태에서도
하위 요소를 클릭하여 선택을 전환할 수 있다.

### 3.2 단일 선택 vs 다중 선택

| 모드 | 조건 | 동작 |
|------|------|------|
| 단일 선택 | 일반 클릭 | 기존 선택 모두 해제 → 클릭한 요소만 선택 |
| 다중 선택 | Ctrl+클릭 / Cmd+클릭 | 이미 선택된 요소 → 선택 해제. 미선택 요소 → 선택 추가 |

### 3.3 `editableLayout` 비활성화 시 정리

`editableLayout`을 `false`로 설정하면:

**`<x-layout-box>`**:
1. `selected` 속성 제거 (선택 시각적 피드백 해제)
2. `hovered` 속성 제거 (호버 시각적 피드백 해제)
3. `editable-layout` DOM 속성 제거
4. `cursor` 스타일 초기화
5. `EditManager._unregisterLayout()` 호출 (선택 목록에서 제거, `layoutSelectionChange` 이벤트 발생)

이벤트 리스너는 box에서 직접 등록하지 않으므로 제거할 `click`/`mousedown` 리스너도 없다.

### 3.4 `disconnectedCallback` 정리

요소가 DOM에서 제거되면 `EditManager._unregisterLayout()`이 호출되어 선택 목록을 정리한다. `LayoutEditController`는 계속 문서에 부착되어 있으며, 다음 이벤트에서 더 이상 DOM에 없는 box를 자연스럽게 무시한다.

### 3.5 EditManager의 텍스트 편집과 레이아웃 선택의 관계

텍스트 편집(`focusParagraph`)과 레이아웃 선택(`selectLayout`)은 독립적으로 동작한다. 단락 포커스 변경이 레이아웃 선택에 영향을 주지 않으며, 반대도 마찬가지다.

---

## 4. 드래그 이동 (Drag-to-Move)

### 4.1 개요

선택된 `<x-layout-box>` 요소는 마우스 드래그로 이동할 수 있다. 드래그 중에도 주변 텍스트가 실시간으로 회피(리플로우)하여, 박스가 이동하면 텍스트가 그 주변을 흘러가는 신문 레이아웃 특유의 동작이 구현된다.

**다중 선택 드래그**: 여러 요소가 선택된 상태에서 드래그하면 선택된 모든 최상위 요소가 함께 이동한다. 중첩(ancestor-descendant) 관계에 있는 요소 중 하위 요소는 무시되고 가장 상위 요소만 이동한다. 예를 들어, 부모 box와 그 안의 자식 box가 모두 선택된 상태에서 드래그하면 부모 box만 이동하고 자식 box는 부모와 함께 자연스럽게 이동하므로 별도로 움직이지 않는다.

### 4.2 드래그 전체 흐름

```
┌─────────────────────────────────────────────────────────────────────┐
│                     드래그 생명주기 (Drag Lifecycle)                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ① mousedown (선택된 box 위에서)                                     │
│     │                                                               │
│     ├── LayoutEditController._onMouseDown (document capture)         │
│     ├── _findSelectableBoxFromEvent(event)                             │
│     ├── button !== 0? → 무시                                        │
│     ├── _isEventFromResizeHandle(event, box)? → _startResize(); return│
│     ├── _isEventFromDescendantLayout(event, box)? → return            │
│     ├── !box.hasAttribute('selected')?                              │
│     │   ├── EditManager.selectLayout(box)                            │
│     │   └── BoxDragState.selectedOnMouseDown = true                  │
│     ├── event.preventDefault()                                       │
│     ├── BoxDragState.isDragging = true                               │
│     ├── BoxDragState.dragMoved = false                               │
│     ├── BoxDragState.startMouseX/Y = clientX/Y                       │
│     ├── BoxDragState.startLeft/Top = box.left/top (시작 위치 저장)   │
│     ├── BoxDragState.originalLeft/Top/Width/Height/Position = 현재값   │
│     ├── box.style.cursor = 'grabbing'                               │
│     ├── EditManager._startLayoutDrag()                               │
│     │   ├── 선택된 요소 중 중첩 하위 요소 제거 (최상위만 유지)         │
│     │   └── 각 이동 대상의 시작 위치(left/top) 기록                   │
│     ├── BoxDragState.affectedParagraphs = _collectAffectedParagraphs(box)
│     └── document에 mousemove, mouseup, keydown 리스너 등록            │
│                                                                     │
│  ② mousemove (드래그 중)                                              │
│     │                                                               │
│     ├── LayoutEditController._onMouseMove                            │
│     ├── activeDragBox가 없으면 return                                │
│     ├── BoxDragState.lastClientX/Y 업데이트                           │
│     ├── 이동 거리 ≤ 3px? → dragMoved 유지, return                    │
│     ├── BoxDragState.dragMoved = true                                │
│     ├── rAF 이미 예약? → return (중복 방지)                           │
│     └── requestAnimationFrame:                                       │
│          ├── BoxDragState.rafId = null                               │
│          ├── dx = lastClientX - startMouseX                           │
│          ├── dy = lastClientY - startMouseY                           │
│          ├── newPos = LayoutEditController._computeNewPosition(box, dx, dy, startLeft, startTop)│
│          ├── if (newPos.converted) _applyPositionConversion(...)     │
│          ├── else if (newPos.left !== box.left) box.left = newPos.left│
│          ├── else if (newPos.top !== box.top) box.top = newPos.top    │
│          └── for each other drag target:                              │
│               ├── targetState = _dragStates.get(t)                   │
│               ├── tNewPos = _computeNewPosition(t, dx, dy, targetState.startLeft, targetState.startTop)│
│               ├── if (tNewPos.converted) _applyPositionConversion(t, ...)│
│               ├── else if (tNewPos.left !== t.left) t.left = tNewPos.left│
│               └── else if (tNewPos.top !== t.top) t.top = tNewPos.top │
│                                                                     │
│  ③ mouseup (드래그 완료)                                              │
│     │                                                               │
│     ├── LayoutEditController._onMouseUp                              │
│     ├── document 리스너 제거 (mousemove, mouseup, keydown)            │
│     ├── rAF 취소 (있으면)                                             │
│     ├── BoxDragState.isDragging = false                              │
│     ├── _flushRerenderAffectedParagraphs(box, state)                 │
│     ├── box.style.cursor = 'grab' (편집 가능 시)                     │
│     ├── BoxDragState.dragMoved === false? → EditManager._endLayoutDrag(), return│
│     ├── 최종 위치 계산 → box.left/top 설정                           │
│     ├── EditManager._dispatchLayoutMove(box, ...)                    │
│     ├── for each other drag target:                                  │
│     │    ├── tNewPos = _computeNewPosition(t, dx, dy, targetState.startLeft, targetState.startTop)│
│     │    ├── t.left/top 설정                                         │
│     │    └── EditManager._dispatchLayoutMove(t, ...)                 │
│     └── EditManager._endLayoutDrag()                                 │
│                                                                     │
│  ③' ESC 키 (드래그 취소)                                              │
│     │                                                               │
│     ├── LayoutEditController._onKeyDown                              │
│     ├── rAF 취소 (있으면)                                             │
│     ├── document 리스너 제거 (mousemove, mouseup, keydown)            │
│     ├── BoxDragState.isDragging = false                              │
│     ├── BoxDragState.dragMoved = false                               │
│     ├── _flushRerenderAffectedParagraphs(box, state)                 │
│     ├── box.style.cursor = 'grab' (편집 가능 시)                     │
│     ├── _applyPositionConversion(box, originalPosition, originalLeft/Top/Width/Height)│
│     ├── EditManager._dispatchLayoutMove(box, start, start, canceled=true)│
│     ├── for each other drag target:                                  │
│     │    ├── _applyPositionConversion(t, targetState.originalPosition, targetState.originalLeft/Top/Width/Height)│
│     │    └── EditManager._dispatchLayoutMove(t, start, start, canceled=true)│
│     └── EditManager._endLayoutDrag()                                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.3 위치 계산: `LayoutEditController._computeNewPosition(box, deltaPxX, deltaPxY, startLeft?, startTop?)`

드래그 중 마우스 이동량(픽셀)을 받아 최종 위치를 계산한다. `position` 모드와 부모 요소 종류에 따라 다른 스냅/클램핑/변환 로직을 적용한다.

다중 선택 드래그에서 각 대상 요소의 시작 위치를 독립적으로 전달할 수 있다. `startLeft`/`startTop`을 생략하면 해당 box의 `BoxDragState.startLeft`/`startTop`을 사용한다.

**반환값**: `{ left: number; top: number; converted?: { position: BoxPosition; left: number; top: number; width: number; height: number } }`

`converted` 필드가 있으면 위치 변환이 필요함을 나타낸다. 드래그 핸들러는 이 필드를 확인하여 `position`, `left`, `top`, `width`, `height`를 모두 갱신한다.

실제 구현은 `src/edit/layout-edit-controller.ts`에 있으며, box 인스턴스에 의존하지 않고 인자로 받은 box의 좌표계와 부모 모델(parentModel)을 기반으로 계산한다.

#### 4.3.1 static 모드 (컬럼 그리드)

```
deltaPxX, deltaPxY (마우스 이동 픽셀)
    │
    ▼
deltaMmX = deltaPxX / GridCalculator.ppm     ← 픽셀 → mm 변환
deltaMmY = deltaPxY / GridCalculator.ppm
    │
    ▼
startX = columnCoords[dragStartLeft].x1         ← 시작 컬럼의 mm 좌표
startY = columnCoords[dragStartLeft].y1 + lineHeight * dragStartTop
newLeftMm = startX + deltaMmX                   ← mm 좌표계에서 이동
newTopMm  = startY + deltaMmY
    │
    ▼
newLeft = 컬럼 탐색: newLeftMm에 가장 가까운 컬럼의 x1을 찾아 해당 인덱스 결정
    │   (정확히 컬럼 범위 안에 없으면 가장 가까운 컬럼으로 스냅)
    │
    ▼
newLeft = clamp(newLeft, 0, columnCount - width)  ← 컬럼 스냅 + 범위 제한
    │
    ▼
maxTop = floor((editableTextHeight - absHeight) / lineHeight)
newTop = clamp(round((newTopMm - columnCoords[newLeft].y1) / lineHeight),
               0, maxTop)                          ← 라인 스냅 + 범위 제한
    │
    ▼
return { left: newLeft, top: newTop }

- **static 요소는 편집 영역 밖으로 나갈 수 없다.** 컬럼/라인 스냅과 클램핑으로 항상 편집 영역 내에 유지된다.
- **position 자동 변환은 발생하지 않는다.** 드래그 중 static ↔ absolute 변환이 일어나지 않는다.
```

- **컬럼 스냅**: 박스의 왼쪽 가장자리가 가장 가까운 컬럼에 스냅된다.
- **라인 스냅**: 박스의 위쪽 가장자리가 `lineHeight` 단위로 스냅된다.
- **범위 제한**: 박스가 `columnCount - width` 이상의 컬럼, `maxTop` 이상의 라인으로 이동하지 못한다.
- **문서 영역 밖 변환**: 클램핑 전의 mm 위치가 편집 영역 밖이면 absolute 위치로 자동 변환된다.
- **`maxTop` 계산**: `editableTextHeight`와 box의 `absHeight`를 사용하여, 박스의 하단이 편집 영역 하단(`editableTextHeight`)을 넘지 않도록 제한한다.
- `columnCoords`, `lineHeight`, `columnCount`, `editableTextHeight`는 부모의 `GridCalculator`(=`parentModel`)에서 가져온다.
- `parentModel`이 없으면 (예: 박스가 DOM에 연결되지 않은 경우) 시작 위치를 그대로 반환한다.

#### 4.3.2 absolute 모드 (mm 좌표)

```
deltaPxX, deltaPxY (마우스 이동 픽셀)
    │
    ▼
deltaMmX = deltaPxX / GridCalculator.ppm     ← 픽셀 → mm 변환
deltaMmY = deltaPxY / GridCalculator.ppm
    │
    ▼
newLeft = dragStartLeft + deltaMmX              ← 시작 위치 + 이동량
newTop  = dragStartTop  + deltaMmY
    │
    ▼
 문서 직계 자식인지 확인:
    ├── YES → 클램핑 없이 자유 이동 (음수 좌표 허용)
    │       return { left: newLeft, top: newTop }
    └── NO → 부모 경계 클램핑
        maxLeft = max(0, parentWidth - paddingLeft - paddingRight - width)
        maxTop  = max(0, parentHeight - paddingTop  - paddingBottom - height)
        return { left: clamp(newLeft, 0, maxLeft),
                 top:  clamp(newTop,  0, maxTop) }
```

- **문서 직계 자식**: 클램핑 없이 자유롭게 이동. 음수 좌표도 가능. position은 absolute를 유지한다.
- **다른 박스 안**: 부모의 padding을 고려하여 박스가 부모 영역 밖으로 나가지 않도록 클램핑.
- **position 자동 변환은 발생하지 않는다.** absolute 요소가 편집 영역 안으로 들어와도 static으로 변환되지 않는다.

### 4.4 위치 설정 시 파이프라인: `left`/`top` setter

```typescript
set left(value: number) {
  if (this._left === value) return;  // 동일 값이면 무시 (불필요한 리렌더 방지)
  this._left = value;
  this.layout();                     // ← 1) DOM 재배치
  this._rerenderAffectedParagraphs();// ← 2) 주변 텍스트 리플로우
}

set top(value: number) {
  if (this._top === value) return;
  this._top = value;
  this.layout();                     // ← 1) DOM 재배치
  this._rerenderAffectedParagraphs();// ← 2) 주변 텍스트 리플로우
}
```

setter가 호출될 때마다:
1. **`this.layout()`**: GridCalculator를 사용하여 박스와 자식 요소의 위치·크기를 재계산하고 DOM 스타일을 업데이트한다.
2. **`this._rerenderAffectedParagraphs()`**: 영향받는 단락들의 텍스트 레이아웃을 재실행하여 이미지/박스 회피를 다시 계산한다.

### 4.4 드래그 중 position 변환 불가

드래그 중에는 `position` 자동 변환이 발생하지 않는다. static 요소는 항상 static으로, absolute 요소는 항상 absolute로 유지된다.

- **static 요소**: 컬럼/라인 스냅과 클램핑으로 편집 영역 내에 유지된다. 편집 영역 밖으로 드래그해도 absolute로 변환되지 않고 클램핑된 위치에 머무른다.
- **absolute 요소**: 자유롭게 이동하며, 편집 영역 안으로 들어와도 static으로 변환되지 않는다.

position 변환이 필요하면 `convertPosition()`을 명시적으로 호출해야 한다 (4.4.6 참조).

#### 4.4.1 ESC 취소 시 위치/크기/position 복원

ESC 키로 드래그를 취소하면 원래 상태로 완전히 복원된다:

1. `box.applyPositionConversion(originalPosition, originalLeft, originalTop, originalWidth, originalHeight)` (static ↔ absolute 복원)

`BoxDragState.originalPosition`, `originalLeft`, `originalTop`, `originalWidth`, `originalHeight`는 `_startDrag()`에서 저장된다. 다중 선택의 경우, `LayoutEditController`가 모든 드래그 대상의 시작 상태를 저장하고, ESC 시 각각 `applyPositionConversion()`을 호출하여 원래 상태로 복원한다.

#### 4.4.5 컬럼 보존: `_savedColumns` / `_savedGap`

`position: 'static'` → `position: 'absolute'` 변환 시, `layout()`은 `columns: 1, gap: 0`으로 설정하여 다중 컬럼 단락이 단일 컬럼으로 붕괘되는 문제가 있었다. 이를 방지하기 위해 변환 전 컬럼/갭 설정을 저장한다.

**필드**:
```typescript
private _savedColumns: number | number[] = 1;
private _savedGap: number | number[] = 0;
```

**저장 시점** (`_applyPositionConversion` 호출 시):

| 변환 방향 | 동작 |
|-----------|------|
| `static` → `absolute` | `parentModel.columnWidth.slice(left, left + width)` → `_savedColumns`<br>`parentModel.gaps.slice(left, left + width - 1)` → `_savedGap` |
| `absolute` → `static` | `_savedColumns = 1`, `_savedGap = 0` (기본값 복원, `layout()`이 static 좌표로 재계산) |

**`layout()`에서의 사용**:

```typescript
columns: this.position !== 'absolute'
  ? columnWidth.slice(this.left, this.left + this.width)  // static: 컬럼 슬라이스
  : this._savedColumns,                                     // absolute: 저장된 값
gap: this.position !== 'absolute'
  ? gaps.slice(this.left, this.left + this.width - 1)     // static: 갭 슬라이스
  : this._savedGap,                                         // absolute: 저장된 값
```

이렇게 하면 absolute 모드에서도 박스 내부의 단락이 원래 컬럼 수를 유지하여 텍스트 레이아웃이 붕괴되지 않는다.

**ESC 취소 시**: `_dragOriginal*` 필드에 드래그 시작 전 원래 `position`/`left`/`top`/`width`/`height`가 저장되어 있으므로, ESC 시 `_applyPositionConversion(_dragOriginalPosition, ...)`을 호출하면 `absolute` → `static` 변환 경로를 타서 `_savedColumns = 1`, `_savedGap = 0`으로 초기화되고 `layout()`이 static 좌표로 컬럼/갭을 재계산한다.

#### 4.4.6 프로그래밍 API: `convertPosition(targetPosition)` / `applyPositionConversion()`

프로그래밍 방식으로 position 모드를 변환할 수 있는 public 메서드. 드래그 중에는 자동 변환이 발생하지 않으므로, 변환이 필요하면 이 메서드를 명시적으로 호출해야 한다.

```typescript
box.convertPosition('absolute');  // static → absolute
box.convertPosition('static');    // absolute → static
```

`LayoutEditController`는 드래그 중 position 변환이 필요할 때 `box.applyPositionConversion(position, left, top, width, height)`를 호출한다. 이 메서드는 `_applyPositionConversion()`의 public wrapper로, position과 좌표/크기를 원자적으로 갱신하고 한 번의 `layout()` 호출로 처리한다.

**static → absolute 변환**:
1. `columnCoords[left].x1` → `absLeft`
2. `columnCoords[left].y1 + lineHeight * top` → `absTop`
3. `absWidth` getter → `absWidth` (컬럼 스팬 → mm)
4. `absHeight` getter → `absHeight` (라인 수 → mm)
5. `_applyPositionConversion('absolute', ...)` 호출 → `_savedColumns`/`_savedGap` 보존

**absolute → static 변환**:
1. `round((left - editAreaLeft) / avgColWidth)` → `clampedColumn` (범위 클램핑)
2. `round((top - editAreaTop) / lineHeight)` → `clampedLine` (범위 클램핑)
3. `round(width / avgColWidth)` → `staticWidth` (최소 1)
4. `round(height / lineHeight)` → `staticHeight` (최소 1)
5. `_applyPositionConversion('static', ...)` 호출 → `_savedColumns = 1`, `_savedGap = 0` 초기화

**주의사항**:
- `parentModel`이 없으면 `Error`를 throw한다. 요소가 DOM에 연결되고 렌더링된 상태에서만 호출 가능.
- 현재 position과 동일한 모드를 지정하면 아무 동작도 하지 않는다 (no-op).
- 드래그 중에는 position 자동 변환이 발생하지 않는다. 변환이 필요하면 드래그 완료 후 `convertPosition()`을 명시적으로 호출해야 한다.

#### 4.4.7 변환 조건 요약

| 현재 position | 조건 | 동작 |
|---------------|------|------|
| `static` | 모든 경우 | 컬럼/라인 스냅 + 클램핑. 편집 영역 밖으로 나갈 수 없음. 변환 없음 |
| `absolute` (문서 직계 자식) | 모든 경우 | 클램핑 없이 자유 이동 (음수 좌표 가능). 변환 없음 |
| `absolute` (다른 박스 안) | 모든 경우 | 부모 padding 영역 내로 클램핑. 변환 없음 |

### 4.5 부모 변경 모드 (Reparent Mode)

`layoutEditType`이 `'reparent'`인 경우의 드래그 동작. `layoutEditMode = { type: 'reparent' }`로 활성화한다.

#### 4.5.1 개요

reparent 모드에서는 box를 드래그하여 다른 컨테이너로 옮기거나 부모 밖으로 빼낼 수 있다. 일반 `move` 모드와 달리 부모 경계를 벗어날 수 있으며, mouseup 시점의 커서 위치로 새 부모를 결정한다.

```typescript
manager.layoutEditMode = { type: 'reparent' };
```

#### 4.5.2 드래그 중 동작: 부모 안/밖 자동 전환

reparent 모드에서는 부모 안과 밖을 자동으로 전환하며 동작한다:

| 상태 | 조건 | 동작 |
|------|------|------|
| **부모 안** | 클램핑 위치 = 자유 이동 위치 | `box.left`/`box.top` 설정 (일반 이동), `transform = ''` |
| **부모 밖** | 클램핑 위치 ≠ 자유 이동 위치 | `box.left`/`box.top`을 클램핑 위치로 고정, `transform`으로 초과분 이동 |

매 rAF 프레임마다 `_applyReparentDragMove`가 호출되어:

1. `_computeNewPosition`(클램핑 포함)으로 부모 안에서의 최대 이동 위치 계산 → `clamped`
2. 클램핑 없는 자유 이동 위치 계산 → `free`
   - static box: 시작 위치를 absolute mm로 변환 + delta → 다시 컬럼/라인 인덱스로 변환
   - absolute box: `startLeft + deltaMm`
3. `clamped == free` → **부모 안**: `box.left`/`box.top` 설정, `transform = ''`
4. `clamped != free` → **부모 밖**:
   - 처음 진입 시: `reparentOutside`에 마우스 위치와 클램핑된 box 위치 기록
   - `box.left`/`box.top`을 클램핑 위치로 고정 (box 렌더링 크기 유지)
   - 진입 시점부터의 마우스 delta를 `box.style.transform`으로 적용

이 방식으로 부모 안에서는 텍스트 회피 등 일반 렌더링이 동작하고, 부모 밖으로 나가면 box의 렌더링 크기가 찌그러지지 않는다.

#### 4.5.3 드래그 중 컨테이너 하이라이트

reparent 모드 드래그 중, 커서 위치의 들어갈 수 있는 컨테이너에 **주황색(`#ff9800`) 2px 테두리**가 표시된다.

```
_onMouseMove rAF 콜백
    │
    ▼
_updateReparentHighlight(box, clientX, clientY)
    │
    ├── _findReparentContainer(box, clientX, clientY) → candidate
    ├── candidate === box.parentElement? → target = null (하이라이트 없음)
    ├── target === _reparentHighlightTarget? → no-op (동일 컨테이너)
    ├── 이전 하이라이트 제거: _reparentHighlightTarget.removeAttribute('reparent-target')
    └── 새 하이라이트 설정: target.setAttribute('reparent-target', '')
```

| 속성 | 색상 | 적용 대상 | 조건 |
|------|------|----------|------|
| `reparent-target` | 주황 (`#ff9800`, 2px) | box 또는 document | reparent 드래그 중 들어갈 수 있는 컨테이너 |

하이라이트는 `_onMouseUp`, `_onKeyDown`(ESC), `_cancelAllDrags`(detach)에서 `_clearReparentHighlight()`로 제거된다.

#### 4.5.4 mouseup 시 부모 변경 (`_tryReparent`)

mouseup 시점에 `_tryReparent`가 호출된다. 이 메서드는 **data 추출 → 좌표 변환 → 기존 box 제거 → 새 box 생성** 방식으로 동작한다.

```
_onMouseUp (reparent 모드, dragMoved === true)
    │
    ▼
_tryReparent(box, clientX, clientY, state)
    │
    ├── 1. _findReparentContainer(box, clientX, clientY) → newContainer
    │   ├── elementsFromPoint로 후보 수집
    │   ├── box 자신/자손, lock, 비-box 자식이 있는 box 제외
    │   └── 없으면 EditManager 루트(editableRootId 또는 document)로 폴백
    │
    ├── 2. newContainer === box.parentElement? → return null (부모 변경 없음)
    │
    ├── 3. box의 화면 위치(getBoundingClientRect)를 새 컨테이너 내부 mm 좌표로 변환
    │   ├── containerPaddingLeft/Top 고려
    │   └── screenPxToMm() 사용 (scale 보정 적용)
    │
    ├── 4. 새 컨테이너 내 최대 z-index + 1 계산
    │
    ├── 5. box.data 추출 (자손 트리 포함, 원래 position/width/height 유지)
    │
    ├── 6. boxData 좌표 변환 (position 유지):
    │   ├── static + newContainer.model → 컬럼/라인 스냅 (left/top만 변환, width/height 유지)
    │   └── absolute (또는 모델 없음) → absolute mm 좌표 (left/top만 변환, width/height 유지)
    │
    ├── 7. boxData.zIndex = 새 컨테이너 최대 z-index + 1
    │
    ├── 8. box.remove() — 기존 box 제거
    │
    ├── 9. newContainer.appendChildData(boxData) — 새 box 생성
    │   └── data setter 전체 파이프라인 실행 (layout + render)
    │
    └── 10. return { container: newContainer, newBox }
```

**position 유지**: 원래 `static`인 box는 새 컨테이너에서도 `static`으로 유지되며, 컬럼/라인 스냅이 적용된다. 원래 `absolute`인 box는 `absolute`로 유지되며 mm 좌표로 변환된다.

**width/height 보존**: `box.data`에서 추출한 원래 `width`/`height`가 그대로 유지된다. 화면 위치(`getBoundingClientRect`)에서 다시 계산하지 않으므로, 부모 밖으로 드래그하여 box 렌더링 크기가 찌그러진 상태에서도 올바른 크기로 새 box가 생성된다.

**zIndex**: 새 컨테이너 내 기존 자식들의 최대 z-index + 1로 설정되어, 옮겨간 box가 최상위에 표시된다.

**id 보존**: `box.data`의 `id`가 그대로 전달되므로, 새 box도 동일한 `id`를 갖는다.

**`appendChildData`**: `LayoutBoxElement`와 `LayoutDocumentElement`의 public 메서드로, `BoxData`를 받아 `<x-layout-box>` 요소를 생성하고 `data` setter의 전체 초기화 파이프라인(`_layoutStructure` → `_applyStyle` → `_renderBorder` → `_propagateInheritStyle` → `render`)을 실행하여 반환한다.

**레이아웃 추가/제거 이벤트**: `_tryReparent`는 기존 box 제거 후 `_dispatchLayoutRemove`, 새 box 생성 후 `_dispatchLayoutAdd`를 호출하여 레이아웃 변경을 외부에 알린다. `source` 필드는 `'reparent'`로 설정된다.

#### 4.5.5 `_onMouseUp`에서의 reparent 처리

reparent 모드에서 `_onMouseUp`은 transform이 유지된 상태에서 `_tryReparent`를 먼저 호출한다:

```
_onMouseUp (reparent 모드)
    │
    ├── transform 초기화하지 않은 상태에서 _tryReparent 호출
    │   └── getBoundingClientRect()가 transform 반영된 화면 위치 반환
    │
    ├── reparent 성공 시:
    │   ├── box.style.transform = '' (box가 제거되었으므로 의미 없지만 일관성)
    │   ├── manager.selectLayout(newBox) — 새 box로 선택 갱신
    │   └── _dispatchLayoutMove(newBox, ..., newContainer, previousContainer)
    │
    └── reparent 실패 시 (부모 변경 없음):
        ├── box.style.transform = '' — 원위치 복원
        ├── _computeNewPosition → box.left/top 설정 (일반 move 처리)
        └── _dispatchLayoutMove(box, ...)
```

#### 4.5.6 `layoutMove` 이벤트에 reparent 정보 포함

reparent가 발생하면 `layoutMove` 이벤트에 `newContainer`와 `previousContainer` 필드가 추가된다. 부모 변경이 없으면 두 필드 모두 `undefined`이다.

```typescript
manager.addEventListener('layoutMove', (event) => {
  if (event.newContainer) {
    console.log('Reparented:', event.previousContainer?.id, '→', event.newContainer.id);
  } else {
    console.log('Moved within same parent');
  }
});
```

이벤트 payload의 자세한 명세는 `EDITING_EVENTS.md`를 참조한다.

#### 4.5.7 제한 사항

- **자기 자신/자손 안으로 넣을 수 없음**: `elementsFromPoint` 결과에서 box 자신과 box의 자손을 제외한다.
- **lock된 box 안으로 넣을 수 없음**: lock된 컨테이너는 후보에서 제외된다.
- **비-box 자식이 있는 box 안으로 넣을 수 없음**: 단락이나 이미지가 이미 들어 있는 박스는 컨테이너로 부적합 (삽입 모드와 동일한 규칙).
- **다중 선택 reparent**: 다중 선택 상태에서 reparent 모드 드래그 시 각 box가 mouseup 위치의 컨테이너로 독립적으로 reparenting된다.
- **ESC 취소 시 원래 부모로 복원**: ESC는 `box.style.transform = ''`로 초기화하고 position/좌표를 원래 상태로 복원한다. reparenting 자체는 mouseup 시에만 발생하므로 ESC 시점에는 부모가 변경되지 않은 상태이다.
- **새 box 참조**: reparent 성공 시 기존 box는 제거되고 새 box가 생성되므로, 외부에서 기존 box 참조를 보유하고 있으면 무효화된다. `layoutMove` 이벤트의 `layoutElement`는 새 box를 가리킨다.

---

## 5. 텍스트 회피 (Text Reflow) 상세

### 5.1 개요

드래그 중 박스가 이동하면 주변 단락의 텍스트가 실시간으로 박스를 회피하여 다시 배치된다. 이것이 신문 레이아웃 엔진의 핵심 기능이다: 텍스트가 이미지나 다른 박스 주변을 자연스럽게 흘러가는 동작.

### 5.2 `_rerenderAffectedParagraphs()` 호출 흐름

```
left/top setter 호출
    │
    ▼
_rerenderAffectedParagraphs()
    │
    ├── 1) 자식 단락 수집
    │   for (item of this.items):
    │     if item.type === 'paragraph' → affected.add(item)
    │
    ├── 2) 형제 단락 수집
    │   for (sibling of this.parentElement.items):
    │     if sibling === this → skip
    │     _collectParagraphs(sibling, affected)
    │         ├── paragraph → add
    │         └── box → 재귀적으로 자식 탐색
    │
    └── 3) 수집된 단락 리렌더
        for (p of affected):
          p._structureDirty = true     ← 구조 변경 플래그
          p.render()                    ← 전체 렌더 파이프라인 재실행
```

**수집 범위**:
- **자식 단락**: 이동하는 박스 안에 포함된 단락들. 박스가 이동하면 내부 단락도 함께 이동하므로 재배치가 필요하다.
- **형제 단락**: 같은 부모 안에 있는 다른 박스/단락. 박스가 이동하면 형제 단락의 오버랩 회피 영역이 변하므로 리렌더가 필요하다.

### 5.3 단락 렌더 파이프라인 (`paragraph.render()`)

```
paragraph.render()
    │
    ▼
_structureDirty === true?
    │
    ├── YES → 전체 재생성
    │   ├── layout() 호출
    │   │   └── GridCalculator 생성/업데이트
    │   │       ├── 컬럼 폭, 라인 높이, 간격 계산
    │   │       └── ppm (pixels-per-mm) 측정
    │   │
    │   ├── TextLayoutEngine.create()
    │   │   ├── overlapRects 수집
    │   │   │   └── getOverlapSizePX(): 이미지/박스의 오버랩 영역 계산
    │   │   │       ├── 캔버스 픽셀 스캔 (불투명 픽셀 감지)
    │   │   │       ├── overlapPadding 적용 (타원형 패딩 존)
    │   │   │       └── 차단 범위(BlockingRange) 리스트 반환
    │   │   │           └── 각 컬럼별: { top, bottom } (픽셀 단위)
    │   │   │
    │   │   └── _overlayRects 캐시에 저장
    │   │
    │   └── layoutText() 호출
    │       └── _layoutTextIntoColumns()
    │           ├── _parseContents() — 텍스트 파싱
    │           ├── 각 컬럼마다:
    │           │   ├── 가상 컬럼(v-column) 생성
    │           │   ├── _createLineWithParts() — 라인 생성
    │           │   │   ├── 오버랩 영역 확인
    │           │   │   │   └── _overlayRects에서 해당 컬럼의 차단 범위 조회
    │           │   │   ├── 차단 영역이 있으면:
    │           │   │   │   └── COVER 라인 생성 (빈 라인, 텍스트 없음)
    │           │   │   └── 차단 영역이 없으면:
    │           │   │       └── 정상 라인 생성 (parts로 구성)
    │           │   ├── 문자 단위 배치:
    │           │   │   ├── _charWidthPx() — 각 문자 폭 측정 (Canvas measureText)
    │           │   │   ├── part 너비 초과 시 다음 part로 이동
    │           │   │   └── 모든 part 초과 시 다음 라인으로 줄바꿈
    │           │   └── 오버플로우 시 다음 컬럼으로 이동
    │           └── _columnContents에 결과 저장
    │
    └── render() 호출
        └── 각 자식 column 요소의 renderText() 호출
            └── DOM 업데이트 (span 기반 diff 렌더링)
```

### 5.4 오버랩 회피 (Overlap Avoidance) 상세

텍스트가 이미지나 박스 주변을 흘러가는 메커니즘:

#### 5.4.1 오버랩 영역 계산: `getOverlapSizePX()`

```
이미지/박스 위치 변경
    │
    ▼
getOverlapSizePX(columnIndex, textTopMM, textBottomMM)
    │
    ├── 캔버스 사용 가능?
    │   ├── YES → 픽셀 단위 정밀 스캔
    │   │   ├── 이미지 캔버스에서 해당 컬럼 범위의 픽셀 스캔
    │   │   ├── 각 불투명 픽셀에 대해:
    │   │   │   ├── overlapPadding 적용 (타원형 패딩)
    │   │   │   │   ndx = dx / horizontalPadding
    │   │   │   │   ndy = dy / verticalPadding
    │   │   │   │   if (ndx² + ndy² ≤ 1) → 패딩 존 내
    │   │   │   ├── 패딩 존 내 픽셀의 차단 범위 계산
    │   │   │   └── 차단 범위를 left/right로 확장 (padLeft, padRight)
    │   │   └── 결과: BlockingRange[] (컬럼별 top/bottom)
    │   │
    │   └── NO → 기하학적 사각형 계산 (fallback)
    │       └── 불투명 영역 + padding → 확장된 사각형
    │
    └── 결과: OverlapParts[] (각 컬럼별 차단 범위)
```

#### 5.4.2 overlapPadding (타원형 패딩)

`overlapPadding`은 `ImageData`의 속성으로, 이미지의 불투명 영역 주변에 텍스트 회피 영역을 추가한다.

```typescript
// number인 경우: 모든 방향에 동일한 패딩 (mm)
overlapPadding: 5

// 객체인 경우: 방향별 비대칭 패딩 (mm)
overlapPadding: { top: 2, right: 5, bottom: 2, left: 5 }
```

- 값은 mm 단위이며, 내부적으로 `GridCalculator.ppm`을 사용해 픽셀로 변환된다.
- 타원형 패딩(`ndx² + ndy² ≤ 1`)을 사용하여 자연스럽게 둥근 회피 영역을 만든다.
- 투명 픽셀은 텍스트를 차단하지 않는다.

#### 5.4.3 텍스트 레이아웃에서의 오버랩 적용

`_createLineWithParts()`에서 각 라인을 생성할 때:

1. 현재 컬럼의 오버랩 영역을 `_overlayRects`에서 조회
2. 현재 y 위치와 오버랩 영역이 겹치면:
   - **COVER 라인**: 텍스트가 없는 빈 라인. 오버랩 영역의 높이만큼 공간을 차지한다.
   - **PART 분할**: 오버랩 영역이 라인 중간에 있으면, 라인을 여러 part로 나누어 오버랩 영역을 우회한다.
   - 각 part의 `left`(mm)와 `width`(mm)는 오버랩 영역을 제외한 가용 공간을 기반으로 계산된다.

### 5.5 `_collectParagraphs()` 재귀 탐색

```
_collectParagraphs(element, set)
    │
    ├── element.type === 'paragraph'
    │   └── set.add(element)  ← 단락 발견, 수집
    │
    ├── element.type === 'box'
    │   └── for (child of element.items):
    │       _collectParagraphs(child, set)  ← 중첩 박스 재귀 탐색
    │
    └── element.type === 'image'
        └── (이미지는 단락이 아니므로 무시)
```

---

## 6. ESC 키 취소 (Drag Cancel)

### 6.1 동작

드래그 중 ESC 키를 누르면:

1. **rAF 취소**: 대기 중인 `requestAnimationFrame` 콜백을 취소한다.
2. **리스너 해제**: `document`에 등록된 `mousemove`, `mouseup`, `keydown` 리스너를 모두 제거한다.
3. **상태 초기화**: `BoxDragState.isDragging = false`, `BoxDragState.dragMoved = false`로 설정한다.
4. **커서 복원**: `box.style.cursor`를 `'grab'`(편집 가능 시) 또는 `''`(편집 불가 시)로 복원한다.
5. **위치/크기/position 복원**: `_applyPositionConversion(box, originalPosition, originalLeft, originalTop, originalWidth, originalHeight)`를 호출하여 원래 상태로 복원한다. `applyPositionConversion()`은 private 필드를 원자적으로 갱신하고 `layout()` + `_renderAffectedParagraphs()`를 한 번만 실행하여 텍스트도 원래 배치로 복원한다. `LayoutEditController`는 `box.applyPositionConversion()` public wrapper를 호출한다.
6. **다중 선택 복원**: 모든 드래그 대상의 시작 상태를 `applyPositionConversion()`으로 복원한다.

### 6.2 구현

```typescript
private _onKeyDown = (event: KeyboardEvent): void => {
  const box = this._activeDragBox;
  if (!box) return;
  const state = this._dragStates.get(box);
  if (!state || !state.isDragging) return;
  if (event.key !== 'Escape') return;

  event.preventDefault();
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  document.removeEventListener('mousemove', this._onMouseMove);
  document.removeEventListener('mouseup', this._onMouseUp);
  document.removeEventListener('keydown', this._onKeyDown);
  state.isDragging = false;
  state.dragMoved = false;
  this._flushRerenderAffectedParagraphs(box, state);
  box.style.cursor = this._isBoxEditable(box) ? 'grab' : '';

  const manager = EditManager.getInstance();
  const dragTargets = manager._getDragTargets();
  const isTopLevel = dragTargets.includes(box);

  if (isTopLevel) {
    this._applyPositionConversion(
      box,
      state.originalPosition,
      state.originalLeft,
      state.originalTop,
      state.originalWidth,
      state.originalHeight,
    );
    manager._dispatchLayoutMove(box, state.originalLeft, state.originalTop, state.originalLeft, state.originalTop, true);
  }

  for (const target of dragTargets) {
    if (target === box) continue;
    const targetState = this._getOrCreateDragState(target);
    this._applyPositionConversion(
      target,
      targetState.originalPosition,
      targetState.originalLeft,
      targetState.originalTop,
      targetState.originalWidth,
      targetState.originalHeight,
    );
    manager._dispatchLayoutMove(
      target,
      targetState.originalLeft,
      targetState.originalTop,
      targetState.originalLeft,
      targetState.originalTop,
      true,
    );
  }

  manager._endLayoutDrag();
  this._activeDragBox = null;
}
```

### 6.3 리스너 수명 주기

| 이벤트 | 등록 시점 | 해제 시점 |
|--------|----------|----------|
| `mousemove` | `LayoutEditController._startDrag` | `LayoutEditController._onMouseUp`, `LayoutEditController._onKeyDown(ESC)` |
| `mouseup` | `LayoutEditController._startDrag` | `LayoutEditController._onMouseUp`, `LayoutEditController._onKeyDown(ESC)` |
| `keydown` | `LayoutEditController._startDrag` | `LayoutEditController._onMouseUp`, `LayoutEditController._onKeyDown(ESC)` |

모든 드래그 종료 경로(mouseup, ESC)에서 세 리스너가 모두 해제됨을 보장한다.

### 6.4 `layoutMove` 이벤트 흐름

```
┌──────────────────────────────────────────────────────────┐
│               드래그 완료 (mouseup)                       │
│                                                          │
│  LayoutEditController._onMouseUp                           │
│      ├── 리스너 해제 (mousemove, mouseup, keydown)        │
│      ├── rAF 취소                                         │
│      ├── BoxDragState.isDragging = false                  │
│      ├── _flushRerenderAffectedParagraphs(box, state)   │
│      ├── BoxDragState.dragMoved === false? → return (클릭이었음) │
│      ├── 최종 위치 계산: _computeNewPosition(box, delta, startLeft, startTop)│
│      ├── if (converted) _applyPositionConversion(box, ...) │
│      ├── else box.left = left → layout() + reflow        │
│      ├──      box.top  = top  → layout() + reflow        │
│      └── EditManager._dispatchLayoutMove(                 │
│              box, startLeft, startTop, box.left, box.top, false)│
│                        │                                  │
│                        ▼                                  │
│          layoutMove 이벤트 발생                            │
│          (canceled = false, left/top = 최종 위치)          │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│               드래그 취소 (ESC)                           │
│                                                          │
│  LayoutEditController._onKeyDown                          │
│      ├── rAF 취소                                         │
│      ├── 리스너 해제 (mousemove, mouseup, keydown)        │
│      ├── BoxDragState.isDragging = false, dragMoved = false│
│      ├── _flushRerenderAffectedParagraphs(box, state)     │
│      ├── cursor = 'grab' (편집 가능 시)                   │
│      ├── _applyPositionConversion(box, originalPosition, originalLeft/Top/Width/Height)│
│      │    → layout() + reflow                              │
│      └── EditManager._dispatchLayoutMove(                 │
│              box, originalLeft, originalTop, originalLeft, originalTop, true)│
│                        │                                  │
│                        ▼                                  │
│          layoutMove 이벤트 발생                            │
│          (canceled = true, left/top = originalLeft/originalTop)│
└──────────────────────────────────────────────────────────┘
```

**발생 조건**: `BoxDragState.dragMoved === true`일 때만. 3px 이하의 이동(클릭으로 간주)에서는 `layoutMove` 이벤트가 발생하지 않는다.

**ESC 취소 시**: `left`/`top` 값은 `previousLeft`/`previousTop`과 동일하다. 이동이 취소되어 원래 위치로 복원되었음을 나타낸다.

---

## 7. 전체 드래그-리플로우 플로우차트

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          사용자가 box를 드래그                           │
└──────────────────────┬───────────────────────────────────────────────────┘
                       │
                       ▼
            ┌─────────────────────┐
             │ _onMouseDown (capture)│ ← document capture; 편집 가능 box 감지
             │ (button=0 필터)      │
             └──────────┬──────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │ _onMouseMove         │ ← rAF로 60fps 쓰로틀링
             │ delta > 3px? →      │    이동 임계값 초과 시 드래그로 인식
             │   dragMoved = true  │
             └──────────┬──────────┘
                        │
                        ▼
             ┌─────────────────────┐
             │ _computeNewPosition  │ ← position 모드에 따라 분기
             │ (box, dx, dy, ...)   │
             │                     │
             │  ┌─────────────────┐│
             │  │ absolute 모드   ││ ← mm 좌표 + padding 경계 클램핑
             │  │ clamp(0, max)   ││
             │  └────────┬────────┘│
             │           │         │
             │  ┌─────────────────┐│
             │  │ static 모드      ││ ← 컬럼 스냅 + 라인 스냅 + 범위 제한
             │  │ 컬럼 인덱스 스냅 ││
             │  │ 라인 단위 스냅   ││
             │  └────────┬────────┘│
             │           │         │
             └───────────┼─────────┘
                         │
                         ▼
             ┌─────────────────────┐
             │ box.left = newLeft │ ← setter 호출
             │ box.top  = newTop  │
             └──────────┬──────────┘
                        │
               ┌────────┴────────┐
               │                  │
               ▼                  ▼
     ┌──────────────────┐  ┌───────────────────────────┐
     │   box.layout()   │  │ _renderAffectedParagraphs│
     │                  │  │                             │
     │ GridCalculator   │  │ 1) 자식 단락 수집           │
     │ 재계산           │  │ 2) 형제 단락 수집           │
     │ DOM 스타일 업데이트│  │ 3) _structureDirty = true  │
     │                  │  │ 4) paragraph.render() 호출   │
     └────────┬─────────┘  └──────────┬──────────────────┘
             │                       │
             │              ┌────────┴────────┐
             │              │                 │
             │              ▼                 ▼
             │    ┌─────────────────┐  ┌────────────────────┐
             │    │ layout()       │  │ TextLayoutEngine    │
             │    │ (구조 재계산)   │  │ .create()           │
             │    │                │  │                     │
             │    │ ppm 측정       │  │ overlapRects 수집    │
             │    │ 컬럼 폭 계산   │  │ ┌─────────────────┐ │
             │    │ 라인 높이 계산 │  │ │ getOverlapSizePX│ │
             │    └────────┬────────┘  │ │                 │ │
             │             │           │ │ 캔버스 픽셀 스캔 │ │
             │             │           │ │ overlapPadding   │ │
             │             │           │ │ 타원형 패딩 존   │ │
             │             │           │ └────────┬────────┘ │
             │             │           │          │          │
             │             │           │          ▼          │
             │             │           │ _overlayRects 캐시   │
             │             │           └────────┬────────────┘
             │             │                    │
             │             │                    ▼
             │             │           ┌────────────────────┐
             │             │           │ layoutText()        │
             │             │           │ _layoutTextIntoColumns│
             │             │           │                     │
             │             │           │ 각 컬럼마다:        │
             │             │           │ ├── _createLineWithParts│
             │             │           │ │   ├── 오버랩? → COVER 라인 │
             │             │           │ │   └── 정상 → PART 분할 │
             │             │           │ ├── 문자 단위 배치  │
             │             │           │ └── 오버플로우 → 다음 컬럼│
             │             │           └────────┬────────────┘
             │             │                    │
             │             │                    ▼
             │             │           ┌────────────────────┐
             │             │           │ renderText()        │
             │             │           │ (DOM 업데이트)      │
             │             │           │                     │
             │             │           │ span 기반 diff 렌더링│
             │             │           │ data-source-offset  │
             │             │           │ 기반 재사용/갱신    │
             │             │           └────────────────────┘
             │             │
             └─────┬───────┘
                   │
                   ▼
          ┌──────────────────────┐
          │ 다음 rAF 프레임      │ ← 60fps 쓰로틀링
          │ (또는 mouseup/ESC)   │
          └──────────────────────┘
```

---

## 8. 키보드 단축키

| 입력 | 동작 | 구현 여부 | 발생 이벤트 |
|------|------|-----------|------------|
| 클릭 | 단일 선택 | ✅ | `layoutSelectionChange` |
| Ctrl+클릭 / Cmd+클릭 | 다중 선택 (토글) | ✅ | `layoutSelectionChange` |
| 마우스 드래그 | 선택된 box 이동 | ✅ | `layoutMove` (canceled=false) |
| ESC (드래그 중) | 드래그 취소, 시작 전 위치로 복원 | ✅ | `layoutMove` (canceled=true) |
| 리사이즈 핸들 드래그 | 선택된 box 크기 조정 (4방향) | ✅ | `layoutResize` (canceled=false) |
| ESC (리사이즈 중) | 리사이즈 취소, 시작 전 크기로 복원 | ✅ | `layoutResize` (canceled=true) |
| Escape | 전체 선택 해제 | ❌ | — |
| Delete | 선택된 요소 삭제 | ❌ | — |
| 방향키 | 선택 이동 | ❌ | — |
| `ESC` (삽입 모드 드래그 중) | 삽입 취소 | ✅ | `insertCancel` |

---

## 9. 제한 사항

- **드래그 대상**: `<x-layout-box>`만 드래그 이동할 수 있다.
- **리사이즈 대상**: `<x-layout-box>`만 리사이즈할 수 있다. `<x-layout-document>`는 리사이즈할 수 없다.
- **리사이즈 방향**: 상/하/좌/우 4방향만 지원한다. 대각선 리사이즈는 지원하지 않는다.
- **리사이즈 단일 요소**: 리사이즈는 항상 단일 요소에만 적용된다. 다중 선택 상태에서도 리사이즈 핸들을 드래그하면 해당 요소만 크기가 변경된다.
- **선택 대상**: `<x-layout-box>`만 선택할 수 있다. `<x-layout-document>`, `<x-layout-paragraph>`, `<x-layout-image>`, `<x-layout-column>`은 레이아웃 선택 대상이 아니다.
- **중첩 요소 무시**: 다중 선택 드래그 시 선택된 요소들 중 ancestor-descendant 관계에 있으면 가장 상위(ancestor) 요소만 이동하고 하위(descendant) 요소는 무시된다. 하위 요소는 상위 요소와 함께 자연스럽게 이동하므로 별도 이동 처리가 불필요하다. `EditManager.getTopLevelDragTargets()`가 이 필터링을 수행한다.
- **텍스트 편집과 독립**: 레이아웃 선택은 텍스트 편집 포커스와 무관하게 동작한다. 한 단락이 텍스트 편집 중이더라도 레이아웃 요소를 선택할 수 있다.
- **시각적 피드백**: 선택 표시는 `box-shadow`를 사용하므로 요소의 레이아웃에 영향을 주지 않는다. `outline`은 기존 `border`와 충돌할 수 있어 사용하지 않는다.
- **rAF 쓰로틀링**: 드래그 중 위치 업데이트는 `requestAnimationFrame`으로 60fps로 제한된다. 중복 rAF 요청은 무시된다.
- **이동 임계값**: mousedown 후 3px 이하의 이동은 클릭으로 간주하며, 드래그로 인식되지 않는다.
- **`BoxDragState.dragMoved` 플래그**: 드래그 후 `click` 이벤트가 발생하면 `LayoutEditController._onClick`에서 `dragMoved`를 확인하여 드래그 중 클릭을 무시한다.
- **`parentModel` 필수**: `LayoutEditController._computeNewPosition`에서 `position: 'static'` 모드는 `parentModel`(부모의 `GridCalculator`)이 필요하다. 없으면 시작 위치를 그대로 반환한다.
- **`maxTop` 계산**: static 모드에서 박스의 하단이 편집 영역 하단을 넘지 않도록 `editableTextHeight`와 `absHeight`를 사용하여 `maxTop`을 계산한다. `editableHeight`만 사용하면 마지막 줄의 leading 공간이 무시되어 박스가 하단에 딱 붙지 않는다.
- **문서 영역 밖 드래그**: 문서 직계 자식 박스(`this.parentElement?.type === 'document'`)만 위치 변환 대상이다. 다른 박스 안에 중첩된 박스는 이 동작의 대상이 아니다.
- **absolute → static 변환 시 크기 근사**: 절대 위치에서 static으로 복귀할 때 `width = round(absWidth / avgColWidth)`, `height = round(absHeight / lineHeight)`로 근사 변환한다. 정밀한 값이 아닐 수 있으므로 사용자가 조정해야 할 수 있다.

---

## 10. 새 세션에서 레이아웃 편집 작업을 위한 참조

### 10.1 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/components/layout/box.element.ts` | 박스 렌더링, 위치/크기 setter, `convertPosition()`, `applyPositionConversion()`, `requestRerenderAffectedParagraphs()`, `editableLayout` 속성(DOM 속성/커서/시각적 피드백), `_onLayoutMouseEnter`/`_onLayoutMouseLeave` |
| `src/edit/edit-manager.ts` | 레이아웃 편집 모드/필터(`layoutEditMode`, `editableRoles`, `editableBoxIds`, `isBoxEditable`), 레이아웃 선택 상태 관리, `selectLayout`, `clearLayoutSelection`, `_startLayoutDrag`, `_endLayoutDrag`, `_startLayoutResize`, `_endLayoutResize`, `_isDraggingLayout`, `_isResizingLayout`, `getTopLevelDragTargets`, `_unregisterLayout`, `layoutSelectionChange` 이벤트, `_dispatchLayoutResize`, `insertMode`, `activateInsert`, `deactivateInsert`, `insert`/`insertCancel` 이벤트 |
| `src/edit/layout-edit-controller.ts` | 문서 수준 이벤트 처리, 드래그/리사이즈 상태(`Map` 기반), `_computeNewPosition`, `_computeNewSize`, ESC 취소, `applyPositionConversion` 호출, 영향받는 단락 재렌더링 |
| `src/react/hooks/use-edit-manager.ts` | React 훅: `selectedLayouts`, `selectLayout`, `clearLayoutSelection`, `layoutEditMode`, `setLayoutEditMode`, `setEditableRoles`, `setEditableBoxIds`, `onLayoutSelectionChange` |
| `src/core/text-layout-engine.ts` | `_layoutTextIntoColumns`, 오버랩 회피, COVER 라인, PART 분할 |
| `src/components/layout/paragraph.element.ts` | `render()`, `_structureDirty`, TextLayoutEngine 생성 |
| `src/components/layout/column.element.ts` | `renderText()`, span 기반 diff 렌더링 |
| `src/utils/check-overlap.ts` | `checkOverlap()`, `mergeOverlapParts()`, `getOverlapSizePX()` |

### 10.2 드래그/리사이즈 관련 상태

드래그와 리사이즈 상태는 이전에는 `box.element.ts`의 private 필드에 있었으나, 현재는 `LayoutEditController` 내부의 `Map`으로 관리된다.

```typescript
// layout-edit-controller.ts
private _dragStates = new Map<LayoutBoxElement, BoxDragState>();
private _resizeStates = new Map<LayoutBoxElement, BoxResizeState>();

interface BoxDragState {
  isDragging: boolean;
  dragMoved: boolean;
  selectedOnMouseDown: boolean;
  startMouseX: number;
  startMouseY: number;
  startLeft: number;
  startTop: number;
  originalLeft: number;
  originalTop: number;
  originalWidth: number;
  originalHeight: number;
  originalPosition: BoxPosition;
  lastClientX: number;
  lastClientY: number;
  rafId: number | null;
  affectedParagraphs: Set<LayoutParagraphElement> | null;
}

interface BoxResizeState {
  isResizing: boolean;
  handle: 'top' | 'bottom' | 'left' | 'right' | null;
  moved: boolean;
  startMouseX: number;
  startMouseY: number;
  startLeft: number;
  startTop: number;
  startWidth: number;
  startHeight: number;
  lastClientX: number;
  lastClientY: number;
  rafId: number | null;
  affectedParagraphs: Set<LayoutParagraphElement> | null;
}

// box.element.ts (box 인스턴스에 남아있는 필드)
private _editableLayout: boolean = false;
private _savedColumns: number | number[] = 1;
private _savedGap: number | number[] = 0;
private _resizeHandles: HTMLDivElement[] = [];

// edit-manager.ts (드래그 상태 관리)
private _dragTargets: LayoutBoxElement[] = [];  // 드래그 중인 이동 대상 요소들 (중첩 하위 요소 제외)
private _dragStartPositions: Map<LayoutBoxElement, { left: number; top: number }>;  // 각 대상의 시작 위치
```

### 10.3 `left`/`top`의 의미 (position 모드에 따라 다름)

| `position` | `left` | `top` | `width` | `height` |
|------------|--------|-------|---------|----------|
| `'static'` | 컬럼 인덱스 (0부터) | 라인 인덱스 (0부터) | 컬럼 스팬 수 | 라인 수 |
| `'absolute'` | mm 좌표 | mm 좌표 | mm | mm |

### 10.4 드래그에서 `layout()` + `_renderAffectedParagraphs()`가 호출되는 경로

```
drag rAF 콜백
  → _computeNewPosition(box, dx, dy, startLeft, startTop) → { left, top, converted? }
  → if converted:
      → _applyPositionConversion(box, converted.position, converted.left, converted.top, converted.width, converted.height)
      → BoxDragState.startLeft/Top = converted.left/top (델타 재계산용)
      → BoxDragState.startMouseX/Y = lastClientX/Y (델타 재계산용)
  → else:
      → box.left = left  → setter → layout() + _renderAffectedParagraphs()
      → box.top  = top   → setter → layout() + _renderAffectedParagraphs()
  → for each other drag target:
      → targetState = _dragStates.get(t)
      → 동일한 변환 로직 적용

ESC 취소
  → _applyPositionConversion(box, originalPosition, originalLeft, originalTop, originalWidth, originalHeight)
     → layout() + _renderAffectedParagraphs() (원자적 갱신)
  → EditManager._dispatchLayoutMove(box, originalLeft, originalTop, originalLeft, originalTop, canceled=true)
  → for each other drag target:
      → _applyPositionConversion(t, targetState.originalPosition, targetState.originalLeft, targetState.originalTop, targetState.originalWidth, targetState.originalHeight)
      → EditManager._dispatchLayoutMove(t, targetState.originalLeft, targetState.originalTop, targetState.originalLeft, targetState.originalTop, canceled=true)
  → EditManager._endLayoutDrag()

mouseup
  → _computeNewPosition(deltaX, deltaY) → { left, top, converted? }
  → if converted:
      → _applyPositionConversion(box, converted.position, converted.left, converted.top, converted.width, converted.height)
  → else:
      → box.left = left  → setter → layout() + _renderAffectedParagraphs()
      → box.top  = top   → setter → layout() + _renderAffectedParagraphs()
  → EditManager._dispatchLayoutMove(box, startLeft, startTop, box.left, box.top, canceled=false)
  → for each other drag target:
      → 동일한 변환 로직 적용
      → EditManager._dispatchLayoutMove(t, targetState.startLeft, targetState.startTop, t.left, t.top, canceled=false)
  → EditManager._endLayoutDrag()
```

### 10.5 오버랩 회피 캐시 무효화

`_rerenderAffectedParagraphs()`에서 `_structureDirty = true`를 설정하면, 다음 `paragraph.render()` 호출 시 `TextLayoutEngine.create()`가 재실행되어 `_overlayRects` 캐시가 새로 계산된다. 박스가 이동할 때마다 오버랩 영역이 변하므로 이 캐시 무효화가 필수적이다.

### 10.6 성능: 중첩된 하위 요소를 가진 박스의 드래그/리사이즈

드래그나 리사이즈 중 **박스가 움직이거나 크기가 바뀔 때마다** 영향받는 단락들을 다시 렌더링한다. `LayoutEditController`는 `_startDrag()`/`_startResize()`에서 `_collectAffectedParagraphs(box)`로 영향받는 단락 집합을 수집하고, drag/resize 종료 시 `_flushRerenderAffectedParagraphs()`로 한 번에 다시 렌더링한다. 이 메서드는 다음 작업을 수행한다:

1. 자식 단락 수집: `box.items`를 재귀적으로 순회
2. 형제 단락 수집: 부모의 `items`를 재귀적으로 순회
3. 수집된 모든 `LayoutParagraphElement`에 대해 `_structureDirty = true`를 설정하고 `render()` 호출

`render()`는 `TextLayoutEngine.layoutText()`를 실행하여 **문자 단위**로 줄바꿈과 오버랩 회피를 다시 계산한다. 따라서 단락 수가 많거나 텍스트가 길수록 비용이 커진다. 특히 중첩된 박스 하위에 많은 단락이 있으면, 상위 박스 하나를 움직여도 하위 트리 전체의 단락을 다시 렌더링하게 되어 프레임 저하가 발생할 수 있다.

#### 10.6.1 성능 병목 현황

| 단계 | 비용 | 빈도 |
|------|------|------|
| `_collectAffectedParagraphs()`가 수집하는 단락 수 | O(박스 하위 트리 크기) | 드래그/리사이즈 시작 시 한 번 |
| `_collectParagraphs()` 재귀 순회 | O(트리 노드 수) | rAF 프레임마다 |
| `paragraph.layout()` | DOM 측정, GridCalculator 재생성/업데이트 | `_structureDirty` 변경 시 |
| `TextLayoutEngine.layoutText()` | 문자 단위 줄바꿈 + 오버랩 계산 | rAF 프레임마다 |
| `_createLineWithParts()` | 가상 컬럼 생성 + `getBoundingClientRect()` | 매 라인마다 |
| `_applyOverlap()` | `getBoundingClientRect()` 호출 | 매 라인마다, 오버랩 요소마다 |
| `column.renderText()` | span 단위 diff + DOM 조작 | rAF 프레임마다 |

#### 10.6.2 최적화 전략

**1. 렌더링 쓰로틀링 / 디바운싱 (가장 효과 큼)**
- 드래그/리사이즈 중 마우스 이동은 연속적으로 발생하지만, **사용자가 보는 것은 화면 프레임(60fps)**이다.
- 매 rAF마다 전체 텍스트를 재계산하지 않고, **누적된 마우스 이동을 한 번에 처리**하도록 조정.
- 또는 `_rerenderAffectedParagraphs()`를 쓰로틀링하여 16ms보다 긴 간격(예: 33ms, 50ms)으로만 실행.

**2. `_collectAffectedParagraphs()` 결과 캐싱**
- 드래그 중 영향받는 단락 집합(`Set<LayoutParagraphElement>`)은 변하지 않는다면 매 프레임마다 재귀 순회할 필요 없음.
- `BoxDragState.affectedParagraphs`/`BoxResizeState.affectedParagraphs`에 캐시하고, 드래그/리사이즈 시작 시 한 번만 수집.

**3. `_structureDirty`와 `render()` 디바운싱**
- `paragraph.render()`를 즉시 실행하지 않고, **microtask/macrotask 큐에 예약**하여 동일한 rAF 안에서 여러 번 위치가 바뀌어도 한 번만 렌더링.
- 또는 `requestAnimationFrame`을 사용해 화면 갱신 직전에 한 번에 처리.

**4. 오버랩 캐시 갱신 최소화**
- `_applyOverlap()`은 매 라인마다 `getBoundingClientRect()`를 호출하고, `_overlayRects`는 `_layoutTextIntoColumns()` 시작 시 초기화된다.
- 드래그 중 박스 위치만 변할 때는 오버랩 요소의 **rect가 이미 알고 있으므로** 매번 DOM 측정 대신 마지막 위치에서 이동량을 더하는 식으로 추정 가능.
- 또는 `_overlayRects`를 `_layoutTextIntoColumns()` 외부에서 미리 계산해두고, 텍스트 배치 중에는 캐시만 참조.

**5. 증분 텍스트 레이아웃 활용**
- `TextLayoutEngine`은 이미 `layoutText()`만 호출하면 `_columnContents`를 증분 갱신할 수 있다.
- 다만 `_structureDirty = true`이면 `layoutStructure()` + `layoutText()`를 모두 재실행하여 비용이 커진다.
- 박스 이동 시 컬럼 구조(폭, 간격)가 변하지 않으면 `_structureDirty = false`로 유지할 수 있다면 증분 갱신 가능.

**6. DOM 측정 최소화**
- `_createLineWithParts()`에서 `lineEl.getBoundingClientRect()`를 호출하여 라인 폭을 얻는다.
- 이 값은 이미 `_columnWidths`에서 알 수 있으므로, `getBoundingClientRect()` 대신 계산된 값을 사용하면 reflow/layout 비용을 줄일 수 있다.

**7. 중첩 트리 순회 최적화**
- `_collectParagraphs()`는 재귀적으로 모든 하위 박스를 탐색한다.
- `Set`에 이미 추가된 박스 하위 트리는 스킵하도록 memoization.
- 형제 박스의 하위 단락도 중복 수집될 수 있으므로, 전체 문서에서 중복 제거된 단락 집합을 한 번만 수집.

**8. 사용자 경험 트레이드오프**
- 실시간 텍스트 회피 vs. 끊김 없는 드래그: 둘 사이의 균형.
- 드래그/리사이즈 중에는 박스 윤곽선만 이동시키고, **mouseup 후에 텍스트 회피를 적용**하는 "ghost drag" 모드를 선택적으로 제공.
- 또는 드래그 중에는 100ms~200ms 간격으로만 텍스트 회피를 업데이트하여 성능 확보.

### 10.7 주의사항

- **`LayoutEditController._onClick`과 `_onMouseDown`의 관계**: `_onMouseDown`은 편집 가능한 box에서 드래그/리사이즈를 시작한다. `_onClick`은 `BoxDragState.dragMoved`나 `BoxResizeState.moved`가 `true`이면 무시한다. 두 핸들러는 문서 수준에서 캡처 단계로 동작한다.
- **`_onClick`의 `stopPropagation()`**: 클릭이 부모 박스나 문서로 전파되는 것을 막는다. 이로 인해 중첩된 박스를 클릭해도 부모가 함께 선택되지 않는다.
- **`_structureDirty`**: `paragraph.render()`에서 이 플래그가 `true`이면 `layout()`과 `TextLayoutEngine.create()`를 재실행한다. `false`이면 기존 모델을 재사용하여 `layoutText()`만 재실행한다. 드래그 중에는 박스 위치가 변하므로 항상 `true`로 설정해야 한다.
- **`_overlayRects`**: `TextLayoutEngine`이 `_layoutTextIntoColumns()` 시작 시 `null`로 초기화한다. `paragraph.render()`에서 `TextLayoutEngine.create()` 호출 시 `getOverlapSizePX()`를 통해 새로 계산된다.
- **`layoutMove` 이벤트**: 드래그 완료(mouseup) 또는 취소(ESC) 시 `EditManager._dispatchLayoutMove()`를 통해 발생한다. 단순 클릭(이동 임계값 3px 미만)에서는 발생하지 않는다. `canceled` 필드로 완료와 취소를 구분할 수 있다.
- **호버 표시 (`hovered`)**: `<x-layout-box>`에만 적용되며, `<x-layout-document>`는 호버 표시를 지원하지 않는다. `mouseenter` 시 조상 요소의 `hovered`를 모두 제거하여 가장 안쪽 요소만 호버 표시가 보이도록 한다. `mouseleave` 시 `elementFromPoint`로 마우스 아래의 가장 가까운 `LayoutBoxElement`를 찾아 호버를 복원한다. 이 동작은 중첩된 박스에서 자식→부모로 마우스가 돌아갈 때 부모의 호버가 복원되도록 보장한다.
- **호버와 선택의 우선순위**: `selected`가 있는 요소는 `hovered`를 표시하지 않는다. `LayoutBoxElement._onLayoutMouseEnter`에서 `hasAttribute('selected')`를 먼저 검사하여, 이미 선택된 요소 위에 마우스가 있을 때 파란색 호버 테두리가 빨간색 선택 테두리와 겹치지 않도록 한다. 조상의 `hovered` 제거는 `selected` 체크 전에 수행되어, 선택된 요소 위에서 마우스가 움직일 때 조상 요소의 호버 표시도 제거된다.
- **드래그/리사이즈 중 hover 차단**: `EditManager._isDraggingLayout()` 또는 `_isResizingLayout()`이 `true`이면 `LayoutBoxElement._onLayoutMouseEnter`와 `_onLayoutMouseLeave`가 early return하여 hover 표시가 전혀 나타나지 않는다. 드래그 이동 중이나 크기 조정 중에 마우스가 다른 박스 위로 이동해도 방해가 되지 않도록 한다. 드래그/리사이즈가 종료되면 `EditManager._endLayoutDrag()`/`_endLayoutResize()`에서 플래그가 해제되어 hover가 정상 동작한다.

---

## 11. 크기 조정 (Resize)

### 11.1 개요

선택된 `<x-layout-box>` 요소는 4개의 리사이즈 핸들을 통해 크기를 조정할 수 있다. 핸들은 상/하/좌/우 가장자리의 중앙에 위치하며, 대각선 리사이즈는 지원하지 않는다.

### 11.2 리사이즈 핸들

선택된 box(`selected` 속성 있음)에서만 핸들이 표시된다. 핸들은 Shadow DOM 내부의 `<div>` 요소이며, CSS로 표시/숨김을 제어한다:

- 기본: `.resize-handle { display: none; }`
- 선택 시: `:host([selected]) .resize-handle { display: block; }`

핸들의 시각적 속성:
- 크기: 8px × 8px 원형
- 배경: 흰색
- 테두리: 1px solid #4a90d9
- z-index: 99999999 (다른 요소 위에 표시)
- pointer-events: auto (핸들 위에서만 마우스 이벤트 수신)

### 11.3 리사이즈 상호작용

```
┌─────────────────────────────────────────────────────────────────────┐
│                     리사이즈 생명주기 (Resize Lifecycle)              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ① mousedown on resize handle                                       │
│     │                                                               │
│     ├── LayoutEditController._onMouseDown (document capture)         │
│     ├── _findSelectableBoxFromEvent(event) → box                       │
│     ├── _isEventFromResizeHandle(event, box)? → _startResize(event, box)│
│     ├── button !== 0? → 무시                                        │
│     ├── !box.hasAttribute('selected')? → 무시                        │
│     ├── event.preventDefault() + stopPropagation()                   │
│     ├── BoxResizeState.handle = handle direction                     │
│     ├── BoxResizeState.isResizing = true                             │
│     ├── BoxResizeState.moved = false                                 │
│     ├── BoxResizeState.startMouseX/Y = clientX/Y                     │
│     ├── BoxResizeState.startLeft/Top/Width/Height = 현재 값            │
│     ├── BoxResizeState.affectedParagraphs = _collectAffectedParagraphs(box)│
│     ├── EditManager._startLayoutResize() ← hover 차단 플래그 설정       │
│     └── document에 mousemove, mouseup, keydown 리스너 등록            │
│                                                                     │
│  ② mousemove (리사이즈 중)                                           │
│     │                                                               │
│     ├── LayoutEditController._onResizeMouseMove                      │
│     ├── activeResizeBox가 없으면 return                              │
│     ├── BoxResizeState.lastClientX/Y 업데이트                         │
│     ├── 이동 거리 ≤ 3px? → moved 유지, return                         │
│     ├── BoxResizeState.moved = true                                  │
│     ├── rAF 이미 예약? → return (중복 방지)                           │
│     └── requestAnimationFrame:                                       │
│          ├── BoxResizeState.rafId = null                             │
│          ├── dx = lastClientX - startMouseX                           │
│          ├── dy = lastClientY - startMouseY                           │
│          ├── newSize = _computeNewSize(box, state, dx, dy)           │
│          └── if 변경됨: box.left/top/width/height 설정                 │
│                                                                     │
│  ③ mouseup (리사이즈 완료)                                            │
│     │                                                               │
│     ├── LayoutEditController._onResizeMouseUp                        │
│     ├── document 리스너 제거 (mousemove, mouseup, keydown)            │
│     ├── rAF 취소 (있으면)                                             │
│     ├── BoxResizeState.isResizing = false, BoxResizeState.handle = null│
│     ├── _flushRerenderAffectedParagraphs(box, state)                 │
│     ├── EditManager._endLayoutResize() ← hover 차단 플래그 해제        │
│     ├── BoxResizeState.moved === false? → return (클릭이었음)        │
│     ├── 최종 크기 계산 → box.left/top/width/height 설정               │
│     └── EditManager._dispatchLayoutResize(                           │
│              box, start, end, canceled=false)                        │
│                                                                     │
│  ③' ESC 키 (리사이즈 취소)                                           │
│     │                                                               │
│     ├── LayoutEditController._onResizeKeyDown                        │
│     ├── rAF 취소 (있으면)                                             │
│     ├── document 리스너 제거 (mousemove, mouseup, keydown)            │
│     ├── BoxResizeState.isResizing = false, BoxResizeState.handle = null│
│     ├── _flushRerenderAffectedParagraphs(box, state)                 │
│     ├── EditManager._endLayoutResize() ← hover 차단 플래그 해제        │
│     ├── box.left/top/width/height = 시작 값 복원                     │
│     └── EditManager._dispatchLayoutResize(                           │
│              box, start, start, canceled=true)                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 11.4 `LayoutEditController._computeNewSize(box, state, deltaPxX, deltaPxY)`

픽셀 델타를 받아 리사이즈 방향(`BoxResizeState.handle`)과 `position` 모드에 따라 새 크기와 위치를 계산한다. 실제 구현은 `src/edit/layout-edit-controller.ts`에 있으며, box 인스턴스에 의존하지 않고 인자로 전달받는다.

#### 11.4.1 absolute 모드 (mm 좌표)

```
deltaPxX, deltaPxY → deltaMmX/Y = px / GridCalculator.ppm
padL/R/T/B = inheritStyle padding values
parentWidth/Height = inheritStyle parent dimensions

right handle:
  maxWidth = parentWidth - padL - padR - startLeft
  width = clamp(startWidth + deltaMmX, 1, maxWidth)
  left, top unchanged

left handle:
  maxWidth = startLeft + startWidth
  width = clamp(startWidth - deltaMmX, 1, maxWidth)
  left = clamp(startLeft + deltaMmX, 0, startLeft + startWidth - 1)
  top unchanged

bottom handle:
  maxHeight = parentHeight - padT - padB - startTop
  height = clamp(startHeight + deltaMmY, 1, maxHeight)
  left, top unchanged

top handle:
  maxHeight = startTop + startHeight
  height = clamp(startHeight - deltaMmY, 1, maxHeight)
  top = clamp(startTop + deltaMmY, 0, startTop + startHeight - 1)
  left unchanged
```

#### 11.4.2 static 모드 (컬럼/라인 그리드)

```
deltaPxX, deltaPxY → deltaMmX/Y = px / GridCalculator.ppm
deltaCols = round(deltaMmX / avgColWidth)
deltaLines = round(deltaMmY / lineHeight)
avgColWidth = parentModel.editableWidth / parentModel.columnCount

right handle:
  maxWidth = columnCount - startLeft
  width = clamp(startWidth + deltaCols, 1, maxWidth)
  left, top unchanged

left handle:
  maxWidth = startLeft + startWidth
  width = clamp(startWidth - deltaCols, 1, maxWidth)
  left = clamp(startLeft + deltaCols, 0, startLeft + startWidth - 1)
  top unchanged

bottom handle:
  maxLines = floor(editableTextHeight / lineHeight)
  maxHeightForBox = maxLines - startTop
  height = clamp(startHeight + deltaLines, 1, maxHeightForBox)
  left, top unchanged

top handle:
  maxHeight = startTop + startHeight
  height = clamp(startHeight - deltaLines, 1, maxHeight)
  top = clamp(startTop + deltaLines, 0, startTop + startHeight - 1)
  left unchanged
```

### 11.5 `layoutResize` 이벤트

`EditManager`에서 발생하는 이벤트로, 리사이즈 완료 또는 취소 시 발생한다. 단일 요소에만 적용된다 (다중 선택 리사이즈 없음).

### 11.6 리사이즈와 드래그-이동의 상호작용

`LayoutEditController._onMouseDown`이 실행될 때, `_isEventFromResizeHandle()`로 먼저 핸들 클릭을 감지한다. 핸일 클릭이면 `_startResize()`를 호출하고 리턴한다. 핸들 DOM에는 별도의 리스너가 없으므로 `stopPropagation()`만으로 충분하지 않고, `composedPath()`에서 `.resize-handle` 클래스가 있는지 검사하여 핸들 클릭과 box 본체 클릭을 구분한다.

### 11.7 `editableLayout` 비활성화 시 정리

`editableLayout`을 `false`로 설정하면:
1. `selected` 속성 제거
2. `hovered` 속성 제거
3. `editable-layout` DOM 속성 제거
4. `cursor` 스타일 초기화
5. `EditManager._unregisterLayout()` 호출

`LayoutEditController`는 문서에 계속 부착되어 있으며, 다음 이벤트에서 `isBoxEditable()`/`editableLayout` 조건을 만족하지 않는 box는 무시한다.

### 11.8 리사이즈 관련 private 필드

리사이즈 상태도 `src/edit/layout-edit-controller.ts`의 `BoxResizeState` 인터페이스와 `_resizeStates` Map으로 이전되었다. box 인스턴스에는 `_resizeHandles` 배열만 남아 핸들 DOM 요소를 재활용한다.

---

## 12. 삽입 모드 (Insert Mode)

삽입 모드(`InsertController`)의 상세 명세는 **`EDITING_INSERT.md`**를 참조한다. 본 절에서는 레이아웃 편집 모드와의 관계만 요약한다.

### 12.1 요약

- 삽입 모드는 `EditManager.insertMode = { type, position }`로 활성화한다.
- 활성화 시 `layoutEditMode = false`, `textEditMode = false`로 자동 전환된다 (모드 스위칭).
- 삽입 모드 중에는 레이아웃 선택/드래그/리사이즈가 비활성화된다.
- 삽입 완료 시 `insert` 이벤트, ESC 취소 시 `insertCancel` 이벤트가 발생한다 (이벤트 명세는 `EDITING_EVENTS.md` 참조).
- 대상 컨테이너는 드래그 영역의 **네 꼭짓점**을 기준으로 결정된다 — 드래그 사각형을 완전히 포함하는 가장 안쪽 유효 컨테이너를 선택하며, 없으면 `EditManager.editableRootId`의 루트 box 또는 document 루트로 폴백한다.

자세한 내용:

- API (`insertMode` getter/setter, `activateInsert`, `deactivateInsert`, `InsertMode` 타입)
- 대상 컨테이너 찾기 알고리즘 (4-point hit test + 포함 검사 + 루트 폴백)
- 요소 생성 (`_createElement`, `column`/`gap` 상속, `zIndex` 계산)
- 좌표 변환 (`_screenToContainerMm`, `_mmToStatic`, absolute/static 모드)
- 미리보기 사각형 (`_createPreview`, `_updatePreview`, static 모드 스냅)
- ESC 취소, 드래그 임계값, mousedown 위임, 빈 공간 처리
- 핵심 파일, 주의사항