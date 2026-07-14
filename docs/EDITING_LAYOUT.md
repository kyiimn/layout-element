# layout-element 레이아웃 편집 모드 상세 명세

> 작성 기준: `src/edit/edit-manager.ts`, `src/components/layout/document.element.ts`, `src/components/layout/box.element.ts`, `src/react/hooks/use-edit-manager.ts`
>
> 본 문서는 `layout-element` 라이브러리의 레이아웃 편집 모드 기능, 공개 API, 선택 동작, 시각적 피드백, React 연동 방법을 상세히 기술한다.

---

## 1. 개요 (Overview)

레이아웃 편집 모드는 `<x-layout-document>`와 `<x-layout-box>` 요소를 시각적으로 선택할 수 있는 기능이다. 텍스트 편집 모드(`editableText`)가 단락 내부의 텍스트를 수정하는 기능이라면, 레이아웃 편집 모드(`editableLayout`)는 레이아웃 구조 요소 자체를 선택하여 조작하는 기능이다.

### 1.1 레이아웃 편집 모드 아키텍처

`editableLayout` 속성이 `true`로 설정되면:

1. **클릭 리스너 등록**: 요소에 `click` 이벤트 리스너가 등록된다.
2. **선택 처리**: 클릭 시 `EditManager.selectLayout()`을 호출하여 요소를 선택한다.
3. **시각적 피드백**: 선택된 요소에 `data-selected` 속성이 설정되고, Shadow DOM의 `:host([data-selected])` 규칙에 의해 빨간색 `box-shadow`가 표시된다.
4. **이벤트 전파 차단**: 클릭 이벤트가 `stopPropagation()`되어 부모 요소까지 선택이 전파되지 않는다.

```
┌─────────────────────────────────────────────────────┐
│ <x-layout-document editableLayout>                  │
│   ┌──────────────────┐  ┌──────────────────┐        │
│   │ <x-layout-box    │  │ <x-layout-box    │        │
│   │  editableLayout> │  │  editableLayout> │        │
│   │  [data-selected] │  │                  │        │
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

| 동작 | 설명 |
|------|------|
| `true` 설정 | `click` 리스너 등록. 요소 클릭 시 `EditManager`를 통해 선택 처리 |
| `false` 설정 | `click` 리스너 해제. `data-selected` 속성 제거. `EditManager`에서 등록 해제 |
| `disconnectedCallback` | `EditManager._unregisterLayout()` 호출하여 선택 상태 정리 |

#### 선택 동작

| 입력 | 동작 |
|------|------|
| **클릭** | 기존 선택을 모두 해제하고 클릭한 요소만 선택 |
| **Ctrl+클릭** (또는 **Cmd+클릭**) | 기존 선택에 추가. 이미 선택된 요소를 다시 클릭하면 선택 해제(토글) |
| **클릭** (이벤트 전파) | `stopPropagation()`으로 부모 요소의 클릭 이벤트 차단. 중첩된 box를 클릭해도 document가 함께 선택되지 않음 |

#### 시각적 피드백

선택된 요소에는 `data-selected=""` 속성이 설정되며, Shadow DOM 내부에 다음 CSS 규칙이 적용된다:

```css
:host([data-selected]) {
  box-shadow: red 0px 0px 0px 1px inset, red 0px 0px 0px 1px;
}
```

- **inset shadow**: 요소 내부에 1px 빨간 테두리
- **outset shadow**: 요소 외부에 1px 빨간 테두리
- 기존 `border`가 있는 요소에서도 선택 표시가 정상적으로 보인다
- `outline` 대신 `box-shadow`를 사용하는 이유: `outline`은 기존 `border`와 겹칠 때 표시되지 않을 수 있기 때문

> **중요**: `:host[data-selected]`(대괄호가 속성 선택자를 감싸지 않은 형식)는 Shadow DOM에서 작동하지 않는다. 반드시 `:host([data-selected])` 형식을 사용해야 한다.

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
  } = useEditManager({
    onLayoutSelectionChange: (event) => {
      console.log('Selection changed:', event.selectedLayouts);
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

1. `click` 이벤트 리스너 제거
2. `data-selected` 속성 제거 (시각적 피드백 해제)
3. `EditManager._unregisterLayout()` 호출 (선택 목록에서 제거, `layoutSelectionChange` 이벤트 발생)

### 3.4 `disconnectedCallback` 정리

요소가 DOM에서 제거되면 `EditManager._unregisterLayout()`이 호출되어 선택 목록을 정리한다.

### 3.5 EditManager의 텍스트 편집과 레이아웃 선택의 관계

텍스트 편집(`focusParagraph`)과 레이아웃 선택(`selectLayout`)은 독립적으로 동작한다. 단락 포커스 변경이 레이아웃 선택에 영향을 주지 않으며, 반대도 마찬가지다.

---

## 4. 키보드 단축키

> 레이아웃 편집 모드는 현재 마우스 클릭으로만 요소를 선택할 수 있다. 키보드 단축키는 아직 구현되지 않았다.

| 입력 | 동작 | 구현 여부 |
|------|------|-----------|
| 클릭 | 단일 선택 | ✅ |
| Ctrl+클릭 / Cmd+클릭 | 다중 선택 (토글) | ✅ |
| Escape | 전체 선택 해제 | ❌ |
| Delete | 선택된 요소 삭제 | ❌ |
| 방향키 | 선택 이동 | ❌ |

---

## 5. 제한 사항

- **선택 대상**: `<x-layout-document>`와 `<x-layout-box>`만 선택할 수 있다. `<x-layout-paragraph>`, `<x-layout-image>`, `<x-layout-column>`은 레이아웃 선택 대상이 아니다.
- **텍스트 편집과 독립**: 레이아웃 선택은 텍스트 편집 포커스와 무관하게 동작한다. 한 단락이 텍스트 편집 중이더라도 레이아웃 요소를 선택할 수 있다.
- **시각적 피드백**: 선택 표시는 `box-shadow`를 사용하므로 요소의 레이아웃에 영향을 주지 않는다. `outline`은 기존 `border`와 충돌할 수 있어 사용하지 않는다.