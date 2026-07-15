# layout-element 레이아웃 편집 모드 상세 명세

> 작성 기준: `src/edit/edit-manager.ts`, `src/components/layout/document.element.ts`, `src/components/layout/box.element.ts`, `src/react/hooks/use-edit-manager.ts`
>
> 본 문서는 `layout-element` 라이브러리의 레이아웃 편집 모드 기능, 공개 API, 선택 동작, 드래그-이동, 스냅-그리드, 경계 클램핑, 텍스트 회피(리플로우), ESC 취소, 시각적 피드백, React 연동 방법을 상세히 기술한다.

---

## 1. 개요 (Overview)

레이아웃 편집 모드는 `<x-layout-document>`와 `<x-layout-box>` 요소를 시각적으로 선택하고 드래그하여 이동할 수 있는 기능이다. 텍스트 편집 모드(`editableText`)가 단락 내부의 텍스트를 수정하는 기능이라면, 레이아웃 편집 모드(`editableLayout`)는 레이아웃 구조 요소 자체를 선택·이동하는 기능이다.

### 1.1 레이아웃 편집 모드 아키텍처

`editableLayout` 속성이 `true`로 설정되면:

1. **클릭 리스너 등록**: 요소에 `click` 및 `mousedown` 이벤트 리스너가 등록된다.
2. **선택 처리**: 클릭 시 `EditManager.selectLayout()`을 호출하여 요소를 선택한다.
3. **시각적 피드백**: 선택된 요소에 `data-selected` 속성이 설정되고, Shadow DOM의 `:host([data-selected])` 규칙에 의해 빨간색 `box-shadow`가 표시된다.
4. **드래그 이동**: 선택된 요소를 마우스로 드래그하여 이동할 수 있다.
5. **크기 조정**: 선택된 요소의 가장자리 중앙에 4개의 리사이즈 핸들이 표시되며, 핸들을 드래그하여 크기를 조정할 수 있다.
6. **텍스트 리플로우**: 드래그 중 주변 단락이 실시간으로 텍스트를 다시 배치하여 이미지/박스를 회피한다.
7. **ESC 취소**: 드래그/리사이즈 중 ESC 키를 누르면 이동/크기 변경이 취소되고 시작 전 상태로 복원된다.
8. **이벤트 전파 차단**: 클릭 이벤트가 `stopPropagation()`되어 부모 요소까지 선택이 전파되지 않는다.

```
┌─────────────────────────────────────────────────────┐
│ <x-layout-document editableLayout>                  │
│   ┌──────────────────┐  ┌──────────────────┐        │
│   │ <x-layout-box    │  │ <x-layout-box    │        │
│   │  editableLayout> │  │  editableLayout> │        │
│   │  [data-selected] │  │                  │        │
│   │  cursor: grab ↄ  │  │                  │        │
│   └──────────────────┘  └──────────────────┘        │
│                                                     │
│  EditManager (singleton)                            │
│  ├── selectedLayouts: LayoutElement[]               │
│  ├── selectLayout()                                 │
│  ├── clearLayoutSelection()                         │
│  └── layoutSelectionChange event                    │
└─────────────────────────────────────────────────────┘
```

---

## 2. API

### 2.1 Vanilla (Custom Element) API

#### `editableLayout` 속성

**지원 요소**: `<x-layout-document>`, `<x-layout-box>`

```typescript
// 활성화
document.querySelector('x-layout-document').editableLayout = true;
document.querySelector('x-layout-box').editableLayout = true;

// 비활성화
element.editableLayout = false;
```

| 동작 | `<x-layout-document>` | `<x-layout-box>` |
|------|----------------------|-------------------|
| `true` 설정 | `click` 리스너 등록 | `click` + `mousedown` 리스너 등록, `cursor: grab`, 리사이즈 핸들 DOM 생성 |
| `false` 설정 | `click` 리스너 해제, `data-selected` 제거 | `click` + `mousedown` 리스너 해제, `data-selected` 제거, `cursor` 초기화, 리사이즈 핸들 이벤트 리스너 해제·DOM 제거 |
| `disconnectedCallback` | `EditManager._unregisterLayout()` 호출 | `EditManager._unregisterLayout()` 호출 |

> **참고**: `<x-layout-document>`는 선택만 가능하고 드래그 이동은 지원하지 않는다. 드래그는 `<x-layout-box>`에서만 동작한다.

#### 선택 동작

| 입력 | 동작 |
|------|------|
| **클릭** | 기존 선택을 모두 해제하고 클릭한 요소만 선택 |
| **Ctrl+클릭** (또는 **Cmd+클릭**) | 기존 선택에 추가. 이미 선택된 요소를 다시 클릭하면 선택 해제(토글) |
| **클릭** (이벤트 전파) | `stopPropagation()`으로 부모 요소의 클릭 이벤트 차단. 중첩된 box를 클릭해도 document가 함께 선택되지 않음 |

#### 드래그 이동 동작

| 입력 | 동작 |
|------|------|
| **선택된 box에서 mousedown + drag** | 박스를 마우스 이동 방향으로 이동. 이동 임계값 3px 초과 시 드래그로 인식 |
| **ESC (드래그 중)** | 드래그 취소, 시작 전 위치로 복원, 모든 드래그 리스너 해제 |
| **mouseup (드래그 완료)** | 최종 스냅 위치로 확정, 드래그 리스너 해제 |

#### 시각적 피드백

**선택 표시** (`data-selected`):

```css
:host([data-selected]) {
  box-shadow: red 0px 0px 0px 1px inset, red 0px 0px 0px 1px;
}
```

**호버 표시** (`data-hovered`) — `<x-layout-box>`만, `<x-layout-document>`는 제외:

```css
:host([data-hovered]) {
  box-shadow: #4a90d9 0px 0px 0px 1px inset, #4a90d9 0px 0px 0px 1px;
}
```

| 속성 | 색상 | 적용 대상 | 조건 |
|------|------|----------|------|
| `data-selected` | 빨간색 (`red`) | document, box | 클릭으로 선택됨 |
| `data-hovered` | 파란색 (`#4a90d9`) | box만 | 마우스 hover, 선택되지 않은 요소만 |

- **inset shadow**: 요소 내부에 1px 테두리
- **outset shadow**: 요소 외부에 1px 테두리
- 기존 `border`가 있는 요소에서도 표시가 정상적으로 보인다
- `outline` 대신 `box-shadow`를 사용하는 이유: `outline`은 기존 `border`와 겹칠 때 표시되지 않을 수 있기 때문

**호버 동작 규칙**:

1. `editableLayout`이 켜져 있고 `data-selected`가 없는 `<x-layout-box>`에만 `data-hovered`가 설정된다
2. 이미 선택된 요소(`data-selected`)는 호버 표시가 나타나지 않는다
3. 마우스가 요소에 진입하면 **조상 요소의 `data-hovered`를 모두 제거**하여, 가장 안쪽(최상위) 요소만 호버 표시가 보인다
4. 마우스가 자식 요소에서 부모 영역으로 돌아갈 때, `elementFromPoint`를 사용하여 마우스 위치 아래의 가장 가까운 `LayoutBoxElement`를 찾아 호버를 복원한다
5. `<x-layout-document>`는 호버 표시를 지원하지 않는다
6. **드래그 이동 중이거나 크기 조정 중에는 hover가 동작하지 않는다**. `EditManager._isDraggingLayout()` 또는 `_isResizingLayout()`이 `true`이면 `_onLayoutMouseEnter`와 `_onLayoutMouseLeave`가 early return하여 hover 표시가 나타나지 않는다. 이로 인해 드래그/리사이즈 중에 마우스가 다른 박스 위로 이동해도 방해가 되지 않는다. 드래그/리사이즈가 종료되면 정상적으로 hover가 동작한다.

| 상태 | 커서 | 시각적 피드백 |
|------|------|-------------|
| `editableLayout = true` (선택 안 됨, hover) | `grab` | 파란색 테두리 (`data-hovered`) |
| `editableLayout = true` (선택됨, 대기) | `grab` | 빨간색 테두리 (`data-selected`), 리사이즈 핸들 4개 표시 |
| `editableLayout = true` (드래그 중) | `grabbing` | 빨간색 테두리 (`data-selected`) |
| `editableLayout = true` (리사이즈 중) | 핸들 방향별 (`ns-resize`/`ew-resize`) | 빨간색 테두리 (`data-selected`) |
| `editableLayout = false` | (기본값) | 없음 |

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
- `:host([data-selected]) .resize-handle { display: block; }` — 선택 시 표시
- `:host(:not([data-selected])) .resize-handle { display: none; }` — 미선택 시 숨김
- 핸들의 `mousedown` 이벤트는 `stopPropagation()`으로 버블링을 차단하여, 드래그-이동이 함께 트리거되지 않도록 한다.

### 2.2 EditManager API

`EditManager`는 텍스트 편집과 레이아웃 선택 모두를 관리하는 글로벌 싱글톤이다.

#### 레이아웃 선택 관련 메서드

```typescript
const manager = EditManager.getInstance();

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
- `editableLayout`이 켜진 요소만 선택 가능하다. 켜지 않은 요소는 무시된다.
- 기본(단일 선택) 모드: 기존 선택을 모두 해제하고 지정된 요소만 선택한다.
- 다중 선택 모드(`_multiSelect = true`): 기존 선택에 추가. 이미 선택된 요소를 다시 지정하면 선택 해제(토글).
- 다중 선택 모드는 클릭 핸들러가 Ctrl/Meta 키 상태에 따라 설정한다. 직접 호출해서는 변경할 수 없다.

#### `getTopLevelDragTargets()`

선택된 레이아웃 요소들 중에서 중첩(ancestor-descendant) 관계에 있는 하위 요소를 제외하고, 최상위 `LayoutBoxElement`만 반환한다.

- `LayoutDocumentElement`은 드래그 대상이 아니므로 항상 제외된다.
- 서로 ancestor-descendant 관계에 있는 요소 중 ancestor만 유지되고 descendant는 제외된다.
- 서로 독립적인(형제 또는 다른 트리의) 요소들은 모두 유지된다.
- 단일 요소만 선택된 경우 필터링 없이 그대로 반환된다.

#### `_isDraggingLayout()`

현재 레이아웃 드래그 이동 중인지 반환한다.

| 반환값 | 타입 | 설명 |
|--------|------|------|
| 반환값 | `boolean` | 드래그 이동 중이면 `true`, 아니면 `false` |

`_startLayoutDrag()`가 호출되면 `true`로 설정되고, `_endLayoutDrag()`가 호출되면 `false`로 설정된다. 이 값은 `_onLayoutMouseEnter`/`_onLayoutMouseLeave`에서 hover 표시를 차단하는 데 사용된다.

#### `_isResizingLayout()`

현재 레이아웃 크기 조정 중인지 반환한다.

| 반환값 | 타입 | 설명 |
|--------|------|------|
| 반환값 | `boolean` | 크기 조정 중이면 `true`, 아니면 `false` |

`_startLayoutResize()`가 호출되면 `true`로 설정되고, `_endLayoutResize()`가 호출되면 `false`로 설정된다. 이 값은 `_onLayoutMouseEnter`/`_onLayoutMouseLeave`에서 hover 표시를 차단하는 데 사용된다.

#### 이벤트: `layoutSelectionChange`

```typescript
manager.addEventListener('layoutSelectionChange', (event) => {
  console.log(event.selectedLayouts);  // LayoutElement[]
  console.log(event.previousLayouts);  // LayoutElement[]
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'layoutSelectionChange'` | 이벤트 타입 |
| `selectedLayouts` | `LayoutElement[]` | 현재 선택된 레이아웃 요소들 |
| `previousLayouts` | `LayoutElement[]` | 이전에 선택되어 있던 요소들 |
| `paragraph` | `null` | 레이아웃 이벤트에서는 항상 `null` |
| `controller` | `null` | 레이아웃 이벤트에서는 항상 `null` |

#### 이벤트: `layoutMove`

드래그 이동이 완료되거나 ESC로 취소될 때 발생한다.

```typescript
manager.addEventListener('layoutMove', (event) => {
  console.log(event.layoutElement);  // 이동된 LayoutBoxElement
  console.log(event.previousLeft);   // 이동 전 left 값
  console.log(event.previousTop);    // 이동 전 top 값
  console.log(event.left);           // 이동 후 left 값 (ESC 취소 시 previousLeft와 동일)
  console.log(event.top);            // 이동 후 top 값 (ESC 취소 시 previousTop와 동일)
  console.log(event.canceled);       // ESC 취소 여부
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'layoutMove'` | 이벤트 타입 |
| `layoutElement` | `LayoutElement` | 이동된 레이아웃 요소 |
| `previousLeft` | `number` | 이동 전 `left` 값 (드래그 시작 위치) |
| `previousTop` | `number` | 이동 전 `top` 값 (드래그 시작 위치) |
| `left` | `number` | 이동 후 `left` 값. ESC 취소 시 `previousLeft`와 동일 |
| `top` | `number` | 이동 후 `top` 값. ESC 취소 시 `previousTop`와 동일 |
| `canceled` | `boolean` | ESC 키로 드래그가 취소되었으면 `true`, 정상 완료되었으면 `false` |
| `paragraph` | `null` | 레이아웃 이벤트에서는 항상 `null` |
| `controller` | `null` | 레이아웃 이벤트에서는 항상 `null` |

**발생 시점**:
- **mouseup (드래그 완료)**: `canceled = false`. `left`/`top`은 스냅/클램핑이 적용된 최종 위치.
- **ESC (드래그 취소)**: `canceled = true`. `left`/`top`은 `previousLeft`/`previousTop`와 동일 (시작 위치로 복원됨).

**주의**: 단순 클릭(드래그 이동 없음)에서는 `layoutMove` 이벤트가 발생하지 않는다. 이동 임계값(3px)을 초과한 경우에만 발생한다.

#### 이벤트: `layoutResize`

리사이즈가 완료되거나 ESC로 취소될 때 발생한다.

```typescript
manager.addEventListener('layoutResize', (event) => {
  console.log(event.layoutElement);  // 리사이즈된 LayoutBoxElement
  console.log(event.previousLeft);   // 리사이즈 전 left 값
  console.log(event.previousTop);    // 리사이즈 전 top 값
  console.log(event.previousWidth);  // 리사이즈 전 width 값
  console.log(event.previousHeight); // 리사이즈 전 height 값
  console.log(event.left);           // 리사이즈 후 left 값
  console.log(event.top);            // 리사이즈 후 top 값
  console.log(event.width);           // 리사이즈 후 width 값
  console.log(event.height);          // 리사이즈 후 height 값
  console.log(event.canceled);       // ESC 취소 여부
});
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'layoutResize'` | 이벤트 타입 |
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
| `paragraph` | `null` | 레이아웃 이벤트에서는 항상 `null` |
| `controller` | `null` | 레이아웃 이벤트에서는 항상 `null` |

**발생 시점**:
- **mouseup (리사이즈 완료)**: `canceled = false`. `left`/`top`/`width`/`height`은 스냅/클램핑이 적용된 최종 값.
- **ESC (리사이즈 취소)**: `canceled = true`. `left`/`top`/`width`/`height`은 `previousLeft`/`previousTop`/`previousWidth`/`previousHeight`와 동일 (시작 상태로 복원됨).

**주의**: 단순 클릭(리사이즈 이동 없음)에서는 `layoutResize` 이벤트가 발생하지 않는다. 이동 임계값(3px)을 초과한 경우에만 발생한다.

### 2.3 LayoutElement 타입

```typescript
type LayoutElement = LayoutDocumentElement | LayoutBoxElement;
```

`LayoutElement`은 `EditManager`에서 레이아웃 선택 대상이 되는 요소의 유니온 타입이다. `<x-layout-paragraph>`은 레이아웃 선택 대상이 아니다.

### 2.4 React API

#### `useEditManager` 훅

```typescript
import { useEditManager } from 'layout-element/react';

function MyComponent() {
  const {
    selectedLayouts,        // LayoutElement[]
    selectedLayoutIds,      // string[]
    selectLayout,           // (target) => boolean
    clearLayoutSelection,   // () => void
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

#### 컴포넌트 Props

```tsx
<LayoutDocument editableLayout={true}>
  <LayoutBox editableLayout={true}>
    {/* ... */}
  </LayoutBox>
</LayoutDocument>
```

| Prop | 타입 | 설명 |
|------|------|------|
| `editableLayout` | `boolean?` | 레이아웃 편집 모드 활성화. `LayoutDocument`, `LayoutBox` 모두 지원 |

---

## 3. 동작 세부 사항

### 3.1 요소 선택 흐름

```
사용자 클릭
    │
    ▼
_onLayoutClick(event)
    ├── event.stopPropagation()     ← 부모 요소로의 이벤트 전파 차단
    ├── _dragMoved === true?        ← 드래그 직후 클릭이면 무시
    │   └── _dragMoved = false; return
    ├── EditManager._setMultiSelect(event.ctrlKey || event.metaKey)
    ├── EditManager.selectLayout(this)
    │   ├── editableLayout 검증 (false면 무시)
    │   ├── 기존 선택 해제 (단일 선택 모드)
    │   │   또는 토글 (다중 선택 모드)
    │   ├── data-selected 속성 설정/해제
    │   └── layoutSelectionChange 이벤트 발생
    └── EditManager._setMultiSelect(false)
```

### 3.2 단일 선택 vs 다중 선택

| 모드 | 조건 | 동작 |
|------|------|------|
| 단일 선택 | 일반 클릭 | 기존 선택 모두 해제 → 클릭한 요소만 선택 |
| 다중 선택 | Ctrl+클릭 / Cmd+클릭 | 이미 선택된 요소 → 선택 해제. 미선택 요소 → 선택 추가 |

### 3.3 `editableLayout` 비활성화 시 정리

`editableLayout`을 `false`로 설정하면:

**`<x-layout-box>`**:
1. `click`, `mousedown`, `mouseenter`, `mouseleave` 이벤트 리스너 제거
2. `data-selected` 속성 제거 (선택 시각적 피드백 해제)
3. `data-hovered` 속성 제거 (호버 시각적 피드백 해제)
4. `cursor` 스타일 초기화
5. `EditManager._unregisterLayout()` 호출 (선택 목록에서 제거, `layoutSelectionChange` 이벤트 발생)

**`<x-layout-document>`**:
1. `click` 이벤트 리스너 제거
2. `data-selected` 속성 제거
3. `EditManager._unregisterLayout()` 호출

### 3.4 `disconnectedCallback` 정리

요소가 DOM에서 제거되면 `EditManager._unregisterLayout()`이 호출되어 선택 목록을 정리한다.

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
│     ├── button !== 0? → 무시                                        │
│     ├── data-selected 없음? → 무시                                   │
│     ├── event.preventDefault()                                       │
│     ├── _isDragging = true                                           │
│     ├── _dragMoved = false                                          │
│     ├── _dragStartMouseX/Y = clientX/Y                               │
│     ├── _dragStartLeft/Top = this.left/top (시작 위치 저장)          │
│     ├── cursor = 'grabbing'                                         │
│     ├── EditManager._startLayoutDrag()                               │
│     │   ├── 선택된 요소 중 중첩 하위 요소 제거 (최상위만 유지)         │
│     │   └── 각 이동 대상의 시작 위치(left/top) 기록                   │
│     └── document에 mousemove, mouseup, keydown 리스너 등록            │
│                                                                     │
│  ② mousemove (드래그 중)                                              │
│     │                                                               │
│     ├── _isDragging 아니면 무시                                       │
│     ├── _dragLastClientX/Y 업데이트                                   │
│     ├── 이동 거리 ≤ 3px? → _dragMoved 유지, return                   │
│     ├── _dragMoved = true                                            │
│     ├── rAF 이미 예약? → return (중복 방지)                           │
│     └── requestAnimationFrame:                                       │
│          ├── _dragRafId = null                                       │
│          ├── dx = lastClientX - startMouseX                           │
│          ├── dy = lastClientY - startMouseY                           │
│          ├── newPos = _computeNewPosition(dx, dy)                    │
│          ├── if (newPos.left !== this.left) this.left = newPos.left  │
│          ├── if (newPos.top !== this.top) this.top = newPos.top       │
│          └── for each other drag target:                              │
│               ├── startPos = EditManager._getDragStartPosition(t)    │
│               ├── tNewPos = t._computeNewPosition(dx, dy, startPos)  │
│               ├── if (tNewPos.left !== t.left) t.left = tNewPos.left │
│               └── if (tNewPos.top !== t.top) t.top = tNewPos.top    │
│                                                                     │
│  ③ mouseup (드래그 완료)                                              │
│     │                                                               │
│     ├── document 리스너 제거 (mousemove, mouseup, keydown)            │
│     ├── rAF 취소 (있으면)                                             │
│     ├── _isDragging = false                                          │
│     ├── cursor = 'grab' 또는 ''                                      │
│     ├── _dragMoved === false? → EditManager._endLayoutDrag(), return │
│     ├── 최종 위치 계산 → this.left/top 설정                           │
│     ├── EditManager._dispatchLayoutMove(this, ...)                   │
│     ├── for each other drag target:                                  │
│     │    ├── tNewPos = t._computeNewPosition(dx, dy, startPos)       │
│     │    ├── t.left/top 설정                                         │
│     │    └── EditManager._dispatchLayoutMove(t, ...)                 │
│     └── EditManager._endLayoutDrag()                                 │
│                                                                     │
│  ③' ESC 키 (드래그 취소)                                              │
│     │                                                               │
│     ├── rAF 취소 (있으면)                                             │
│     ├── document 리스너 제거 (mousemove, mouseup, keydown)            │
│     ├── _isDragging = false                                          │
│     ├── _dragMoved = false                                           │
│     ├── cursor = 'grab' 또는 ''                                       │
│     ├── this.left/top = _dragStartLeft/Top (원래 위치로 복원)         │
│     ├── EditManager._dispatchLayoutMove(this, start, start, canceled) │
│     ├── for each other drag target:                                  │
│     │    ├── t.left/top = startPos (원래 위치로 복원)                 │
│     │    └── EditManager._dispatchLayoutMove(t, start, start, canceled)│
│     └── EditManager._endLayoutDrag()                                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.3 위치 계산: `_computeNewPosition(deltaPxX, deltaPxY, startLeft?, startTop?)`

드래그 중 마우스 이동량(픽셀)을 받아 최종 위치를 계산한다. `position` 모드에 따라 다른 스냅/클램핑 로직을 적용한다.

다중 선택 드래그에서 각 대상 요소의 시작 위치를 독립적으로 전달할 수 있다. `startLeft`/`startTop`을 생략하면 `this._dragStartLeft`/`this._dragStartTop`을 사용한다.

#### 4.3.1 absolute 모드 (mm 좌표)

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
maxLeft = max(0, parentWidth - paddingLeft - paddingRight - width)
maxTop  = max(0, parentHeight - paddingTop  - paddingBottom - height)
    │
    ▼
left = clamp(newLeft, 0, maxLeft)              ← 부모 경계 내로 제한
top  = clamp(newTop,  0, maxTop)
```

- **스냅 없음**: absolute 모드에서는 마우스를 따라 자유롭게 이동한다.
- **경계 클램핑**: 부모의 padding을 고려하여 박스가 부모 영역 밖으로 나가지 않도록 제한한다.
- `parentWidth`, `parentHeight`는 `inheritStyle.parentWidth`, `inheritStyle.parentHeight`에서 가져온다.

#### 4.3.2 static 모드 (컬럼 그리드)

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
```

- **컬럼 스냅**: 박스의 왼쪽 가장자리가 가장 가까운 컬럼에 스냅된다.
- **라인 스냅**: 박스의 위쪽 가장자리가 `lineHeight` 단위로 스냅된다.
- **범위 제한**: 박스가 `columnCount - width` 이상의 컬럼, `maxTop` 이상의 라인으로 이동하지 못한다.
- **`maxTop` 계산**: `editableTextHeight`와 box의 `absHeight`를 사용하여, 박스의 하단이 편집 영역 하단(`editableTextHeight`)을 넘지 않도록 제한한다. 이전 버전에서는 `editableHeight / lineHeight - height`를 사용했으나, 마지막 줄의 `lineHeight - fontSize` (leading) 공간을 고려하지 못해 박스가 하단에 딱 붙지 않는 문제가 있었다.
- `columnCoords`, `lineHeight`, `columnCount`, `editableTextHeight`는 부모의 `GridCalculator`(=`parentModel`)에서 가져온다.
- `parentModel`이 없으면 (예: 박스가 DOM에 연결되지 않은 경우) 시작 위치를 그대로 반환한다.

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
3. **상태 초기화**: `_isDragging = false`, `_dragMoved = false`로 설정한다.
4. **커서 복원**: `cursor`를 `'grab'`(editableLayout 켜짐) 또는 `''`(꺼짐)로 복원한다.
5. **위치 복원**: `left`/`top`을 `_dragStartLeft`/`_dragStartTop`으로 복원한다. setter를 통해 호출되므로 `layout()` + `_rerenderAffectedParagraphs()`도 함께 실행되어 텍스트도 원래 배치로 복원된다.

### 6.2 구현

```typescript
private _onLayoutKeyDown = (event: KeyboardEvent) => {
  if (!this._isDragging) return;
  if (event.key !== 'Escape') return;
  event.preventDefault();

  // 1) rAF 취소
  if (this._dragRafId !== null) {
    cancelAnimationFrame(this._dragRafId);
    this._dragRafId = null;
  }

  // 2) 리스너 해제
  document.removeEventListener('mousemove', this._onLayoutMouseMove);
  document.removeEventListener('mouseup', this._onLayoutMouseUp);
  document.removeEventListener('keydown', this._onLayoutKeyDown);

  // 3) 상태 초기화
  this._isDragging = false;
  this._dragMoved = false;
  this.style.cursor = this._editableLayout ? 'grab' : '';

  // 4) 위치 복원 (setter 호출 → layout() + _rerenderAffectedParagraphs())
  if (this.left !== this._dragStartLeft) this.left = this._dragStartLeft;
  if (this.top !== this._dragStartTop) this.top = this._dragStartTop;
}
```

### 6.3 리스너 수명 주기

| 이벤트 | 등록 시점 | 해제 시점 |
|--------|----------|----------|
| `mousemove` | `_onLayoutMouseDown` | `_onLayoutMouseUp`, `_onLayoutKeyDown(ESC)` |
| `mouseup` | `_onLayoutMouseDown` | `_onLayoutMouseUp`, `_onLayoutKeyDown(ESC)` |
| `keydown` | `_onLayoutMouseDown` | `_onLayoutMouseUp`, `_onLayoutKeyDown(ESC)` |

모든 드래그 종료 경로(mouseup, ESC)에서 세 리스너가 모두 해제됨을 보장한다.

### 6.4 `layoutMove` 이벤트 흐름

```
┌──────────────────────────────────────────────────────────┐
│               드래그 완료 (mouseup)                       │
│                                                          │
│  _onLayoutMouseUp                                        │
│      ├── 리스너 해제 (mousemove, mouseup, keydown)        │
│      ├── rAF 취소                                         │
│      ├── _isDragging = false                              │
│      ├── _dragMoved === false? → return (클릭이었음)       │
│      ├── 최종 위치 계산: _computeNewPosition(delta)        │
│      ├── this.left = left  → layout() + reflow           │
│      ├── this.top  = top   → layout() + reflow           │
│      └── EditManager._dispatchLayoutMove(                 │
│              this, startLeft, startTop, left, top, false)  │
│                        │                                  │
│                        ▼                                  │
│          layoutMove 이벤트 발생                            │
│          (canceled = false, left/top = 최종 위치)          │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│               드래그 취소 (ESC)                           │
│                                                          │
│  _onLayoutKeyDown                                         │
│      ├── rAF 취소                                         │
│      ├── 리스너 해제 (mousemove, mouseup, keydown)        │
│      ├── _isDragging = false, _dragMoved = false         │
│      ├── cursor = 'grab'                                  │
│      ├── this.left = startLeft → layout() + reflow        │
│      ├── this.top  = startTop  → layout() + reflow        │
│      └── EditManager._dispatchLayoutMove(                 │
│              this, startLeft, startTop, startLeft, startTop, true)
│                        │                                  │
│                        ▼                                  │
│          layoutMove 이벤트 발생                            │
│          (canceled = true, left/top = startLeft/startTop) │
└──────────────────────────────────────────────────────────┘
```

**발생 조건**: `_dragMoved === true`일 때만. 3px 이하의 이동(클릭으로 간주)에서는 `layoutMove` 이벤트가 발생하지 않는다.

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
            │ _onLayoutMouseDown  │ ← 선택된 box에서만 동작
            │ (button=0 필터)      │
            └──────────┬──────────┘
                       │
                       ▼
            ┌─────────────────────┐
            │ _onLayoutMouseMove  │ ← rAF로 60fps 쓰로틀링
            │ delta > 3px? →      │    이동 임계값 초과 시 드래그로 인식
            │   _dragMoved = true │
            └──────────┬──────────┘
                       │
                       ▼
            ┌─────────────────────┐
            │ _computeNewPosition │ ← position 모드에 따라 분기
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
            │ this.left = newLeft │ ← setter 호출
            │ this.top  = newTop  │
            └──────────┬──────────┘
                       │
              ┌────────┴────────┐
              │                  │
              ▼                  ▼
    ┌──────────────────┐  ┌───────────────────────────┐
    │   this.layout()  │  │ _rerenderAffectedParagraphs│
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

---

## 9. 제한 사항

- **드래그 대상**: `<x-layout-box>`만 드래그 이동할 수 있다. `<x-layout-document>`는 선택만 가능하다.
- **리사이즈 대상**: `<x-layout-box>`만 리사이즈할 수 있다. `<x-layout-document>`는 리사이즈할 수 없다.
- **리사이즈 방향**: 상/하/좌/우 4방향만 지원한다. 대각선 리사이즈는 지원하지 않는다.
- **리사이즈 단일 요소**: 리사이즈는 항상 단일 요소에만 적용된다. 다중 선택 상태에서도 리사이즈 핸들을 드래그하면 해당 요소만 크기가 변경된다.
- **선택 대상**: `<x-layout-document>`와 `<x-layout-box>`만 선택할 수 있다. `<x-layout-paragraph>`, `<x-layout-image>`, `<x-layout-column>`은 레이아웃 선택 대상이 아니다.
- **중첩 요소 무시**: 다중 선택 드래그 시 선택된 요소들 중 ancestor-descendant 관계에 있으면 가장 상위(ancestor) 요소만 이동하고 하위(descendant) 요소는 무시된다. 하위 요소는 상위 요소와 함께 자연스럽게 이동하므로 별도 이동 처리가 불필요하다. `EditManager.getTopLevelDragTargets()`가 이 필터링을 수행한다.
- **텍스트 편집과 독립**: 레이아웃 선택은 텍스트 편집 포커스와 무관하게 동작한다. 한 단락이 텍스트 편집 중이더라도 레이아웃 요소를 선택할 수 있다.
- **시각적 피드백**: 선택 표시는 `box-shadow`를 사용하므로 요소의 레이아웃에 영향을 주지 않는다. `outline`은 기존 `border`와 충돌할 수 있어 사용하지 않는다.
- **rAF 쓰로틀링**: 드래그 중 위치 업데이트는 `requestAnimationFrame`으로 60fps로 제한된다. 중복 rAF 요청은 무시된다.
- **이동 임계값**: mousedown 후 3px 이하의 이동은 클릭으로 간주하며, 드래그로 인식되지 않는다.
- **`_dragMoved` 플래그**: 드래그 후 `click` 이벤트가 발생하면 `_onLayoutClick`에서 `_dragMoved`를 확인하여 드래그 중 클릭을 무시한다.
- **`parentModel` 필수**: `_computeNewPosition`에서 `position: 'static'` 모드는 `parentModel`(부모의 `GridCalculator`)이 필요하다. 없으면 시작 위치를 그대로 반환한다.
- **`maxTop` 계산**: static 모드에서 박스의 하단이 편집 영역 하단을 넘지 않도록 `editableTextHeight`와 `absHeight`를 사용하여 `maxTop`을 계산한다. `editableHeight`만 사용하면 마지막 줄의 leading 공간이 무시되어 박스가 하단에 딱 붙지 않는다.

---

## 10. 새 세션에서 레이아웃 편집 작업을 위한 참조

### 10.1 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/components/layout/box.element.ts` | 드래그 로직, 리사이즈 로직, 위치 setter, `_computeNewPosition`, `_computeNewSize`, `_rerenderAffectedParagraphs`, `_collectParagraphs` |
| `src/components/layout/document.element.ts` | `editableLayout` 속성, `_onLayoutClick`, `:host([data-selected])` CSS 규칙 |
| `src/edit/edit-manager.ts` | 레이아웃 선택 상태 관리, `selectLayout`, `clearLayoutSelection`, `_startLayoutDrag`, `_endLayoutDrag`, `_startLayoutResize`, `_endLayoutResize`, `_isDraggingLayout`, `_isResizingLayout`, `getTopLevelDragTargets`, `_unregisterLayout`, `layoutSelectionChange` 이벤트, `_dispatchLayoutResize` |
| `src/react/hooks/use-edit-manager.ts` | React 훅: `selectedLayouts`, `selectLayout`, `clearLayoutSelection`, `onLayoutSelectionChange` |
| `src/core/text-layout-engine.ts` | `_layoutTextIntoColumns`, 오버랩 회피, COVER 라인, PART 분할 |
| `src/components/layout/paragraph.element.ts` | `render()`, `_structureDirty`, TextLayoutEngine 생성 |
| `src/components/layout/column.element.ts` | `renderText()`, span 기반 diff 렌더링 |
| `src/utils/check-overlap.ts` | `checkOverlap()`, `mergeOverlapParts()`, `getOverlapSizePX()` |

### 10.2 드래그 관련 private 필드

```typescript
// box.element.ts
private _editableLayout: boolean = false;
private _isDragging: boolean = false;
private _dragMoved: boolean = false;
private _dragStartMouseX: number = 0;
private _dragStartMouseY: number = 0;
private _dragStartLeft: number = 0;      // 드래그 시작 시 left (mm 또는 컬럼 인덱스)
private _dragStartTop: number = 0;        // 드래그 시작 시 top (mm 또는 라인 인덱스)
private _dragLastClientX: number = 0;
private _dragLastClientY: number = 0;
private _dragRafId: number | null = null; // requestAnimationFrame ID

// box.element.ts (리사이즈 상태)
private _isResizing: boolean = false;
private _resizeHandle: 'top' | 'bottom' | 'left' | 'right' | null = null;
private _resizeStartMouseX: number = 0;
private _resizeStartMouseY: number = 0;
private _resizeStartLeft: number = 0;
private _resizeStartTop: number = 0;
private _resizeStartWidth: number = 0;
private _resizeStartHeight: number = 0;
private _resizeMoved: boolean = false;
private _resizeRafId: number | null = null;
private _resizeLastClientX: number = 0;
private _resizeLastClientY: number = 0;
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

### 10.4 드래그에서 `layout()` + `_rerenderAffectedParagraphs()`가 호출되는 경로

```
drag rAF 콜백
  → _computeNewPosition(dx, dy) → { left, top }
  → this.left = left  → setter → layout() + _rerenderAffectedParagraphs()
  → this.top  = top   → setter → layout() + _rerenderAffectedParagraphs()
  → for each other drag target:
      → t._computeNewPosition(dx, dy, startPos) → { left, top }
      → t.left = left → setter → layout() + _rerenderAffectedParagraphs()
      → t.top  = top  → setter → layout() + _rerenderAffectedParagraphs()

ESC 취소
  → this.left = _dragStartLeft → setter → layout() + _rerenderAffectedParagraphs()
  → this.top  = _dragStartTop  → setter → layout() + _rerenderAffectedParagraphs()
  → EditManager._dispatchLayoutMove(this, start, start, canceled=true)
  → for each other drag target:
      → t.left = startPos.left → setter → layout() + _rerenderAffectedParagraphs()
      → t.top  = startPos.top  → setter → layout() + _rerenderAffectedParagraphs()
      → EditManager._dispatchLayoutMove(t, start, start, canceled=true)
  → EditManager._endLayoutDrag()

mouseup
  → _computeNewPosition(deltaX, deltaY) → { left, top }
  → this.left = left  → setter → layout() + _rerenderAffectedParagraphs()
  → this.top  = top   → setter → layout() + _rerenderAffectedParagraphs()
  → EditManager._dispatchLayoutMove(this, start, end, canceled=false)
  → for each other drag target:
      → t._computeNewPosition(dx, dy, startPos) → { left, top }
      → t.left = left → setter → layout() + _rerenderAffectedParagraphs()
      → t.top  = top  → setter → layout() + _rerenderAffectedParagraphs()
      → EditManager._dispatchLayoutMove(t, start, end, canceled=false)
  → EditManager._endLayoutDrag()
```

### 10.5 오버랩 회피 캐시 무효화

`_rerenderAffectedParagraphs()`에서 `_structureDirty = true`를 설정하면, 다음 `paragraph.render()` 호출 시 `TextLayoutEngine.create()`가 재실행되어 `_overlayRects` 캐시가 새로 계산된다. 박스가 이동할 때마다 오버랩 영역이 변하므로 이 캐시 무효화가 필수적이다.

### 10.6 주의사항

- **`_onLayoutClick`과 `_onLayoutMouseDown`의 관계**: `mousedown`은 `data-selected`가 있는 요소에서만 드래그를 시작한다. `click`은 `_dragMoved`가 `true`이면 무시한다. 두 핸들러는 독립적으로 동작한다.
- **`_onLayoutClick`의 `stopPropagation()`**: 클릭이 부모 박스나 문서로 전파되는 것을 막는다. 이로 인해 중첩된 박스를 클릭해도 부모가 함께 선택되지 않는다.
- **`_structureDirty`**: `paragraph.render()`에서 이 플래그가 `true`이면 `layout()`과 `TextLayoutEngine.create()`를 재실행한다. `false`이면 기존 모델을 재사용하여 `layoutText()`만 재실행한다. 드래그 중에는 박스 위치가 변하므로 항상 `true`로 설정해야 한다.
- **`_overlayRects`**: `TextLayoutEngine`이 `_layoutTextIntoColumns()` 시작 시 `null`로 초기화한다. `paragraph.render()`에서 `TextLayoutEngine.create()` 호출 시 `getOverlapSizePX()`를 통해 새로 계산된다.
- **`layoutMove` 이벤트**: 드래그 완료(mouseup) 또는 취소(ESC) 시 `EditManager._dispatchLayoutMove()`를 통해 발생한다. 단순 클릭(이동 임계값 3px 미만)에서는 발생하지 않는다. `canceled` 필드로 완료와 취소를 구분할 수 있다.
- **호버 표시 (`data-hovered`)**: `<x-layout-box>`에만 적용되며, `<x-layout-document>`는 호버 표시를 지원하지 않는다. `mouseenter` 시 조상 요소의 `data-hovered`를 모두 제거하여 가장 안쪽 요소만 호버 표시가 보이도록 한다. `mouseleave` 시 `elementFromPoint`로 마우스 아래의 가장 가까운 `LayoutBoxElement`를 찾아 호버를 복원한다. 이 동작은 중첩된 박스에서 자식→부모로 마우스가 돌아갈 때 부모의 호버가 복원되도록 보장한다.
- **호버와 선택의 우선순위**: `data-selected`가 있는 요소는 `data-hovered`를 표시하지 않는다. `_onLayoutMouseEnter`에서 `hasAttribute('data-selected')`를 먼저 검사하여, 이미 선택된 요소 위에 마우스가 있을 때 파란색 호버 테두리가 빨간색 선택 테두리와 겹치지 않도록 한다. 조상의 `data-hovered` 제거는 `data-selected` 체크 전에 수행되어, 선택된 요소 위에서 마우스가 움직일 때 조상 요소의 호버 표시도 제거된다.
- **드래그/리사이즈 중 hover 차단**: `EditManager._isDraggingLayout()` 또는 `_isResizingLayout()`이 `true`이면 `_onLayoutMouseEnter`와 `_onLayoutMouseLeave`가 early return하여 hover 표시가 전혀 나타나지 않는다. 드래그 이동 중이나 크기 조정 중에 마우스가 다른 박스 위로 이동해도 방해가 되지 않도록 한다. 드래그/리사이즈가 종료되면 `EditManager._endLayoutDrag()`/`_endLayoutResize()`에서 플래그가 해제되어 hover가 정상 동작한다.

---

## 11. 크기 조정 (Resize)

### 11.1 개요

선택된 `<x-layout-box>` 요소는 4개의 리사이즈 핸들을 통해 크기를 조정할 수 있다. 핸들은 상/하/좌/우 가장자리의 중앙에 위치하며, 대각선 리사이즈는 지원하지 않는다.

### 11.2 리사이즈 핸들

선택된 box(`data-selected` 속성 있음)에서만 핸들이 표시된다. 핸들은 Shadow DOM 내부의 `<div>` 요소이며, CSS로 표시/숨김을 제어한다:

- 기본: `.resize-handle { display: none; }`
- 선택 시: `:host([data-selected]) .resize-handle { display: block; }`

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
│     ├── button !== 0? → 무시                                        │
│     ├── data-selected 없음? → 무시                                   │
│     ├── event.preventDefault() + stopPropagation()                   │
│     │   ← stopPropagation으로 _onLayoutMouseDown 전파 차단           │
│     ├── _isResizing = true, _resizeHandle = handle direction        │
│     ├── _resizeMoved = false                                        │
│     ├── _resizeStartMouseX/Y = clientX/Y                            │
│     ├── _resizeStartLeft/Top/Width/Height = 현재 값                   │
│     ├── EditManager._startLayoutResize() ← hover 차단 플래그 설정      │
│     └── document에 mousemove, mouseup, keydown 리스너 등록            │
│                                                                     │
│  ② mousemove (리사이즈 중)                                           │
│     │                                                               │
│     ├── _isResizing 아니면 무시                                       │
│     ├── _resizeLastClientX/Y 업데이트                                 │
│     ├── 이동 거리 ≤ 3px? → _resizeMoved 유지, return                │
│     ├── _resizeMoved = true                                          │
│     ├── rAF 이미 예약? → return (중복 방지)                           │
│     └── requestAnimationFrame:                                       │
│          ├── _resizeRafId = null                                     │
│          ├── dx = lastClientX - startMouseX                           │
│          ├── dy = lastClientY - startMouseY                           │
│          ├── newSize = _computeNewSize(dx, dy)                      │
│          └── if 변경됨: this.left/top/width/height 설정               │
│                                                                     │
│  ③ mouseup (리사이즈 완료)                                            │
│     │                                                               │
│     ├── document 리스너 제거 (mousemove, mouseup, keydown)            │
│     ├── rAF 취소 (있으면)                                             │
│     ├── _isResizing = false, _resizeHandle = null                    │
│     ├── EditManager._endLayoutResize() ← hover 차단 플래그 해제        │
│     ├── _resizeMoved === false? → return (클릭이었음)                 │
│     ├── 최종 크기 계산 → this.left/top/width/height 설정              │
│     └── EditManager._dispatchLayoutResize(                           │
│              this, start, end, canceled=false)                       │
│                                                                     │
│  ③' ESC 키 (리사이즈 취소)                                           │
│     │                                                               │
│     ├── rAF 취소 (있으면)                                             │
│     ├── document 리스너 제거 (mousemove, mouseup, keydown)            │
│     ├── _isResizing = false, _resizeHandle = null                    │
│     ├── EditManager._endLayoutResize() ← hover 차단 플래그 해제        │
│     ├── this.left/top/width/height = 시작 값 복원                     │
│     └── EditManager._dispatchLayoutResize(                           │
│              this, start, start, canceled=true)                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 11.4 `_computeNewSize(deltaPxX, deltaPxY)`

픽셀 델타를 받아 리사이즈 방향(`_resizeHandle`)과 `position` 모드에 따라 새 크기와 위치를 계산한다.

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

리사이즈 핸들의 `mousedown` 이벤트는 `stopPropagation()`으로 버블링을 차단한다. 이로 인해:
- 핸들에서 `mousedown` → 리사이즈 시작 (`_onResizeMouseDown` 실행)
- 핸들의 `stopPropagation()`으로 인해 `_onLayoutMouseDown`이 실행되지 않음
- 결과적으로 리사이즈와 드래그-이동이 동시에 트리거되지 않는다

### 11.7 `editableLayout` 비활성화 시 정리

`editableLayout`을 `false`로 설정하면:
1. 리사이즈 핸들의 `mousedown` 이벤트 리스너가 제거된다
2. 핸들 DOM 요소가 shadow DOM에서 제거된다
3. 기존 드래그 관련 리스너도 제거된다

### 11.8 리사이즈 관련 private 필드

```typescript
// box.element.ts (리사이즈 상태)
private _isResizing: boolean = false;
private _resizeHandle: 'top' | 'bottom' | 'left' | 'right' | null = null;
private _resizeStartMouseX: number = 0;
private _resizeStartMouseY: number = 0;
private _resizeStartLeft: number = 0;
private _resizeStartTop: number = 0;
private _resizeStartWidth: number = 0;
private _resizeStartHeight: number = 0;
private _resizeMoved: boolean = false;
private _resizeRafId: number | null = null;
private _resizeLastClientX: number = 0;
private _resizeLastClientY: number = 0;
private _resizeHandles: HTMLDivElement[] = [];   // 핸들 DOM 요소 참조
```