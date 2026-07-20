# layout-element 삽입 모드 (Insert Mode) 상세 명세

> 작성 기준: `src/edit/insert-controller.ts`, `src/edit/edit-manager.ts`, `src/types/edit/insert.type.ts`
>
> 본 문서는 `layout-element` 라이브러리의 삽입 모드(`InsertController`) 기능, 공개 API, 대상 컨테이너 찾기 알고리즘, 좌표 변환, 미리보기, ESC 취소, 레이아웃 편집 모드와의 상호작용을 상세히 기술한다.

---

## 1. 개요 (Overview)

삽입 모드는 문서 표면에서 마우스로 드래그하여 새 요소를 생성하는 기능이다. 사용자가 삽입할 요소의 종류와 배치 모드를 선택하면, `<x-layout-document>` 위에서 드래그한 영역만큼 새 요소가 만들어진다.

- **삽입 가능한 요소**: `box`, `text`, `paragraph`, `image`
- **배치 모드**: `absolute`(mm 좌표) 또는 `static`(컬럼/라인 그리드)
- **취소**: 드래그 중 `ESC` 키를 누르면 미리보기 사각형이 제거되고 `insertCancel` 이벤트가 발생한다.

삽입 모드가 활성화되면 문서 요소의 커서가 `crosshair`로 바뀌고, 기존 레이아웃 선택은 자동으로 해제된다. 삽입 모드 중에는 레이아웃 선택과 드래그 이동이 동작하지 않아 삽입 동작과 충돌하지 않는다.

### 1.1 컨트롤러 아키텍처

`InsertController`는 `EditManager.insertMode`가 활성화될 때 생성되어 문서 수준에서 마우스 이벤트를 처리한다. `LayoutEditController`(드래그/리사이즈) 및 `LayoutSelectionController`(클릭 선택)와 분리된 독립 컨트롤러이다.

```
┌─────────────────────────────────────────────────────────────────────┐
│ <x-layout-document>                                                  │
│                                                                      │
│  EditManager (singleton)                                             │
│  ├── insertMode: InsertMode | null                                    │
│  ├── _insertController: InsertController | null                       │
│  ├── activateInsert(mode) / deactivateInsert()                        │
│  └── insert / insertCancel 이벤트 발송                                │
│                                                                      │
│  InsertController (삽입 전용)                                          │
│  ├── _document: LayoutDocumentElement                                 │
│  ├── _mode: InsertMode | null                                          │
│  ├── _isDragging: boolean                                             │
│  ├── _startContainer: LayoutDocumentElement | LayoutBoxElement | null  │
│  ├── startDrag(event)                                                  │
│  ├── _findTargetContainer(startX, startY, endX, endY)                  │
│  ├── _finishInsert(endX, endY)                                        │
│  ├── _cancel()                                                        │
│  └── _createPreview() / _updatePreview()                              │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 사전 조건

- 삽입 모드는 `<x-layout-document>` 요소가 DOM에 존재해야 한다. 없으면 `Error`가 발생한다.
- 편집 가능 box가 없는 빈 문서에서도 활성화할 수 있다. 이 경우 `InsertController`가 document를 삽입 컨테이너로 사용하여 첫 box를 그려 넣을 수 있다.
- 비활성화 시에는 `editable-layout` DOM 속성이 있는 box의 커서를 `grab`으로 복원한다.

---

## 2. API

### 2.1 `EditManager.insertMode` getter / setter

```typescript
const manager = EditManager.getInstance();

// 삽입 모드 활성화
manager.insertMode = { type: 'box', position: 'absolute' };

// 삽입 모드 비활성화
manager.insertMode = null;

// 현재 삽입 모드 조회
const mode = manager.insertMode; // InsertMode | null
```

| 동작 | 설명 |
|------|------|
| non-null 설정 | 삽입 모드 활성화, 기존 레이아웃 선택 해제, 편집 가능 box의 커서를 `crosshair`로 변경. 빈 문서(편집 가능 box가 없음)에서도 활성화되어 document에 직접 삽입 가능 |
| `null` 설정 | 삽입 모드 비활성화, 커서 복원 |
| 반복 설정 | 동일한 모드로 다시 설정하면 무시된다 |

`x-layout-document` 요소가 DOM에 없으면 `Error`가 throw된다. 편집 가능 `<x-layout-box>`가 없어도 삽입 모드는 활성화되며, 이 경우 document가 삽입 컨테이너가 된다.

### 2.2 `activateInsert(mode)` / `deactivateInsert()`

```typescript
manager.activateInsert({ type: 'image', position: 'static' });
manager.deactivateInsert();
```

`insertMode = mode`와 `insertMode = null`의 편의 메서드이다.

### 2.3 `InsertController.mode` / `InsertController.isDragging`

```typescript
const controller = manager._insertController; // 내부 접근
controller.mode;        // InsertMode | null
controller.isDragging;  // boolean
```

`mode`는 현재 삽입 모드를, `isDragging`은 드래그 진행 여부를 반환한다. `insertMode`가 활성화되어 있더라도 드래그 중이 아니면 `isDragging`은 `false`이다.

### 2.4 `InsertController.setMode(mode)` / `destroy()`

`setMode(null)`은 삽입 모드를 해제하며 진행 중인 드래그를 취소한다. `destroy()`는 `setMode(null)`을 위임 호출하며, `EditManager`가 삽입 모드를 비활성화할 때 사용된다.

---

## 3. 타입 정의

### 3.1 `InsertMode`

```typescript
import type { InsertMode } from 'layout-element';

interface InsertMode {
  type: 'box' | 'text' | 'paragraph' | 'image';
  position: 'absolute' | 'static';
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'box' \| 'text' \| 'paragraph' \| 'image'` | 삽입할 요소의 종류 |
| `position` | `'absolute' \| 'static'` | 새 요소의 배치 모드 |

`text`와 `paragraph`는 모두 `<x-layout-paragraph>`를 내부에 생성하지만, `text`는 `type: 'text'` 데이터로, `paragraph`는 `type: 'paragraph'` 데이터로 변환된다. `text` 타입은 `box.element.ts`의 `data` 세터에서 `{ ...child, type: 'paragraph' }`로 변환되며, 이때 `column`/`gap`을 명시적으로 설정하지 않아 부모 모델에서 상속받는다. 실제 렌더링에서는 둘 다 단락 요소로 표시된다.

### 3.2 `InsertType`

```typescript
export type InsertType = 'box' | 'text' | 'paragraph' | 'image';
```

삽입할 요소의 타입.

- `'box'`: 빈 박스 컨테이너
- `'text'`: 텍스트 (내부적으로 paragraph로 변환됨)
- `'paragraph'`: 단락
- `'image'`: 이미지

### 3.3 `InsertPosition`

```typescript
export type InsertPosition = 'absolute' | 'static';
```

삽입할 요소의 배치 모드.

- `'absolute'`: mm 좌표 기반 절대 배치
- `'static'`: 컬럼/라인 그리드 기반 배치

### 3.4 `InsertEventDetail`

```typescript
export interface InsertEventDetail {
  type: InsertType;
  position: InsertPosition;
  element: HTMLElement;
  container: HTMLElement;
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex: number;
  canceled: boolean;
}
```

삽입 완료 이벤트의 상세 정보. `insert` 이벤트 리스너로 전달되며, 필드 의미는 [5. 이벤트](#5-이벤트)를 참조한다.

---

## 4. 드래그-삽입 흐름

### 4.1 삽입 모드 생명주기

```
┌─────────────────────────────────────────────────────────────┐
│                    삽입 모드 생명주기                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ① 삽입 모드 활성화                                          │
│     │                                                        │
│     ├── EditManager.insertMode = { type, position }          │
│     ├── 모드 스위칭: layoutEditMode = false, textEditMode = false │
│     ├── 기존 레이아웃 선택 해제                               │
│     ├── InsertController 생성/재사용                         │
│     ├── document에 mousedown 리스너 등록(버블링)             │
│     │   (문서 빈 공간에서의 mousedown 처리)                  │
│     └── 편집 가능한 box의 커서를 crosshair로 변경             │
│                                                             │
│  ② mousedown (box 위에서)                                    │
│     │                                                        │
│     ├── LayoutEditController._onMouseDown (document capture) │
│     ├── insertMode 가드 → EditManager.handleInsertMouseDown  │
│     │   └── InsertController.startDrag(event)                │
│     │       ├── button !== 0? → 무시                        │
│     │       ├── _isDragging? → 무시 (중복 실행 방지)         │
│     │       ├── event.preventDefault() + stopPropagation()   │
│     │       ├── _startClientX/Y = event.clientX/Y            │
│     │       ├── _startContainer = _findTargetContainer(x,y,x,y) │
│     │       ├── _createPreview()                             │
│     │       ├── _isDragging = true                           │
│     │       └── document에 mousemove, mouseup, keydown 등록  │
│     └── return (이후 레이아웃 선택/드래그 로직 건너뜀)      │
│                                                             │
│  ②' mousedown (문서 빈 공간에서)                              │
│     │                                                        │
│     ├── InsertController._boundStartDrag 실행               │
│     │   (box 핸들러가 먼저 startDrag()를 호출하지 않았으므로)  │
│     └── InsertController.startDrag(event)                    │
│         ├── _isDragging 가드로 중복 방지                     │
│         └── (이후 동일)                                     │
│                                                             │
│  ③ mousemove (드래그 중)                                      │
│     │                                                        │
│     ├── _currentClientX/Y 업데이트                            │
│     └── _updatePreview()                                     │
│         → 점선 테두리 반투명 파란색 사각형 위치/크기 갱신     │
│         → static 모드: 컬럼/라인 그리드 스냅                │
│                                                             │
│  ④ mouseup (드래그 완료)                                      │
│     │                                                        │
│     ├── 이동 거리 < 3px? → _cleanup(), return (클릭으로 간주) │
│     ├── 드래그 영역의 네 꼭짓점으로 컨테이너 탐색          │
│     ├── _findTargetContainer(startX, startY, endX, endY)      │
│     │   → 네 꼭짓점 모두 hit된 후보 수집                    │
│     │   → 사각형이 경계 내에 완전히 포함되는지 확인          │
│     │   → 가장 안쪽 유효 컨테이너 반환                     │
│     │   → 없으면 EditManager 루트로 폴백                     │
│     ├── screen 픽셀 → container 내부 mm 변환                 │
│     ├── mm → static 좌표 변환 (static 모드인 경우)            │
│     ├── width/height < 1? → _cleanup(), return               │
│     ├── _createElement(mode, container, left, top, w, h, z)  │
│     │   → <x-layout-box> 생성, children 설정, data 할당       │
│     ├── container.appendChild(boxEl)                         │
│     ├── _cleanup()                                           │
│     └── EditManager._dispatchInsert(detail)                  │
│         → insert 이벤트 발생 (canceled = false)               │
│                                                             │
│  ④' ESC 키 (드래그 취소)                                      │
│     │                                                        │
│     ├── _cancel()                                            │
│     ├── _cleanup()                                           │
│     └── EditManager._dispatchInsertCancel()                   │
│         → insertCancel 이벤트 발생                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 모드 스위칭

`insertMode`가 활성화되면 `EditManager`는 다른 모드를 자동으로 비활성화한다:

| 설정 | 자동 전환 |
|------|-----------|
| `insertMode = (non-null)` | `layoutEditMode = false`, `textEditMode = false` |

`selectableMode`는 항상 독립적으로 동작하며 스위칭 대상이 아니다. 자세한 내용은 `EDITING_LAYOUT.md`의 모드 스위칭 표를 참조한다.

---

## 5. 대상 컨테이너 찾기

### 5.1 개요

드래그 영역(사각형)을 완전히 포함하는 가장 안쪽 유효 컨테이너를 찾는다. 이전에는 드래그 영역의 중심점을 기준으로 컨테이너를 찾았으나, 현재는 **네 꼭짓점 모두**가 포함되는 컨테이너를 선택하여 작은 컨테이너가 큰 삽입을 받아들여 크기가 조정되는 문제를 해결한다.

### 5.2 선택 알고리즘

```
_findTargetContainer(startX, startY, endX, endY)
    │
    ├── 1. 네 꼭짓점 정의
    │   corners = [(startX, startY), (endX, startY), (startX, endY), (endX, endY)]
    │
    ├── 2. 각 꼭짓점에서 elementsFromPoint 호출하여 후보 수집
    │   for each corner:
    │     elements = document.elementsFromPoint(corner.x, corner.y)
    │     for each el in elements:
    │       if el instanceof LayoutBoxElement || el instanceof LayoutDocumentElement:
    │         candidates[el] = (candidates[el] ?? 0) + 1
    │         break (첫 번째 hit만)
    │
    ├── 3. 네 꼭짓점 모두에서 hit된 후보만 필터링
    │   fullyHit = [el for (el, count) in candidates if count === 4]
    │
    ├── 4. 사각형이 각 후보의 경계 내에 완전히 포함되는지 확인
    │   for each el in fullyHit (box 우선, document는 후순위):
    │     if el is LayoutBoxElement:
    │       if el.lock → skip
    │       if el.items has non-box child → skip
    │       rect = el.getBoundingClientRect()
    │       if startX >= rect.left && endX <= rect.right &&
    │          startY >= rect.top && endY <= rect.bottom:
    │         return el
    │
    ├── 5. Document 요소도 포함 여부 확인
    │   docRect = _document.getBoundingClientRect()
    │   if 사각형이 docRect 내에 포함:
    │     if editableRootId 설정됨:
    │       rootBox = querySelector(#rootId)
    │       if rootBox && !rootBox.lock && 사각형이 rootBox 내에 포함:
    │         return rootBox
    │     return _document
    │
    └── 6. 폴백: _getRootContainer()
        → editableRootId의 box, 없으면 _document
```

### 5.3 유효 컨테이너 조건

| 현재 요소 | 조건 | 결과 |
|-----------|------|------|
| `<x-layout-document>` | 항상 | 유효한 컨테이너로 간주 (최후보) |
| `<x-layout-box>` | `lock` 설정됨 | 건너뜀 |
| `<x-layout-box>` | 자식이 없거나 모든 자식이 `type === 'box'` | 유효한 컨테이너 |
| `<x-layout-box>` | 자식 중 `paragraph`나 `image`가 있음 | 유효하지 않음 |

단락이나 이미지가 이미 들어 있는 박스 안에 새 박스를 추가하면 기존 콘텐츠와의 모순이 생길 수 있으므로, 그 경우 상위 컨테이너로 거슬러 올라간다.

### 5.4 폴백: `_getRootContainer()`

드래그 사각형을 완전히 포함하는 컨테이너가 하나도 없으면, `EditManager.editableRootId`로 지정된 루트 box를 반환한다. `editableRootId`가 없으면 문서 루트(`<x-layout-document>`)를 반환한다.

```typescript
private _getRootContainer(): LayoutDocumentElement | LayoutBoxElement {
  const manager = EditManager.getInstance();
  const rootId = manager.editableRootId;
  if (rootId) {
    const rootBox = this._document.querySelector(`#${CSS.escape(rootId)}`) as LayoutBoxElement | null;
    if (rootBox) return rootBox;
  }
  return this._document;
}
```

### 5.5 모든 삽입 타입에 동일 적용

이 로직은 모든 삽입 타입(`box`, `text`, `paragraph`, `image`)에 동일하게 적용된다.

---

## 6. 요소 생성

### 6.1 `_createElement(mode, container, left, top, width, height, zIndex)`

삽입이 완료되면 항상 `<x-layout-box>` 요소를 최상위로 생성한다. 삽입 타입에 따라 박스 내부에 다른 자식 요소를 추가한다.

```typescript
const boxEl = document.createElement('x-layout-box') as LayoutBoxElement;
const boxData: BoxData = {
  type: 'box',
  left,
  top,
  width,
  height,
  position: mode.position,
  zIndex,
};
```

| 삽입 타입 | `boxData.children` | 생성되는 내부 요소 |
|-----------|-------------------|-------------------|
| `box` | `undefined` | 자식 없음, 빈 박스 |
| `text` | `{ type: 'text', content: '' }` | `<x-layout-paragraph>` (`type`을 `'paragraph'`으로 변환, `column`/`gap` 생략 → 부모 모델에서 상속) |
| `paragraph` | `{ type: 'paragraph', content: '' }` | `<x-layout-paragraph>` (단락 데이터, `column`/`gap` 생략 → 부모 모델에서 상속) |
| `image` | `{ type: 'image', x: 0, y: 0, width: 100, height: 100, dpi: 72, url: '' }` | `<x-layout-image>` (100×100px, 72dpi, 빈 url) |

### 6.2 `column`/`gap` 상속

`text`와 `paragraph` 삽입 시 `ParagraphData`의 `column`과 `gap`을 명시적으로 설정하지 않는다. `LayoutParagraphElement._layoutStructure()`에서 `_column`과 `_gap`이 `undefined`이면 부모 `GridCalculator`의 `columnWidth`/`gaps`를 상속받아, static 모드에서는 부모 박스가 차지하는 컬럼 수와 동일한 컬럼 구성을 자동으로 갖게 된다.

### 6.3 구현 순서

중요한 구현 순서:

1. `boxEl.data = boxData`를 먼저 설정
2. 그 다음 `container.appendChild(boxEl)` 호출

`data`를 먼저 설정하면 `connectedCallback`이 실행되기 전에 모든 속성이 준비되어 있어, 요소가 DOM에 연결될 때 초기 레이아웃이 올바르게 계산된다.

### 6.4 zIndex 계산: `_getNextZIndex(container)`

```typescript
const items = container.items;
if (items.length === 0) return 1;
return Math.max(...items.map(i => i.zIndex ?? 0)) + 1;
```

컨테이너 내 기존 자식의 최대 z-index + 1, 자식이 없으면 1이다.

---

## 7. 좌표 변환

### 7.1 `_screenToContainerMm(clientX, clientY, container)`

화면 좌표(픽셀)를 컨테이너 내부의 mm 좌표로 변환한다.

```
containerPaddingLeft/Top = container instanceof LayoutBoxElement ? container.paddingLeft/Top ?? 0 : 0
rect = container.getBoundingClientRect()

leftMm = max(0, screenPxToMm(clientX - rect.left) - containerPaddingLeft)
topMm  = max(0, screenPxToMm(clientY - rect.top)  - containerPaddingTop)
```

- 음수 좌표는 0으로 클램핑
- `screenPxToMm(px) = px / (GridCalculator.ppm * manager.scale)` — scale 보정 적용

### 7.2 `_mmToStatic(leftMm, topMm, widthMm, heightMm, container)`

mm 좌표를 static 그리드 좌표로 변환한다.

```
model = container.model
columnCoords = model.columnCoords
lineHeight    = model.lineHeight
editableWidth = model.editableWidth
columnCount   = model.columnCount
avgColWidth   = editableWidth / columnCount

editAreaLeft = columnCoords[0].x1
editAreaTop  = columnCoords[0].y1

nearestColumn = round((leftMm - editAreaLeft) / avgColWidth)
clampedColumn = clamp(nearestColumn, 0, columnCount - max(1, round(widthMm / avgColWidth)))

nearestLine = round((topMm - editAreaTop) / lineHeight)
clampedLine = max(0, nearestLine)

staticWidth  = max(1, round(widthMm / avgColWidth))
staticHeight = max(1, round(heightMm / lineHeight))

return { left: clampedColumn, top: clampedLine, width: staticWidth, height: staticHeight }
```

- `left`: 가장 가까운 컬럼 인덱스로 스냅, `[0, columnCount - width]` 범위로 클램핑
- `top`: 가장 가까운 라인 인덱스로 스냅, 최소 0
- `width`: 최소 1컬럼
- `height`: 최소 1라인

### 7.3 absolute 모드 최종 값

absolute 모드에서는 mm 값을 소수점 둘째 자리까지 반올림한다.

```
left   = round(leftMm * 100) / 100
top    = round(topMm * 100) / 100
width  = round(widthMm * 100) / 100
height = round(heightMm * 100) / 100
```

### 7.4 model이 없는 경우

`static` 모드로 삽입할 때 `container.model`이 없으면 `{ left: 0, top: 0, width: 1, height: 1 }` 기본값을 사용한다.

---

## 8. 미리보기 사각형

### 8.1 `_createPreview()`

드래그 중 문서 위에 반투명한 점선 파란색 사각형이 표시된다.

| 속성 | 값 |
|------|-----|
| `position` | `fixed` |
| `border` | `2px dashed #1a73e8` |
| `backgroundColor` | `rgba(26, 115, 232, 0.1)` |
| `pointerEvents` | `none` |
| `zIndex` | `999999` |

너비나 높이가 1px 이하면 사각형은 보이지 않는다. 드래그가 끝나거나 취소되면 DOM에서 제거된다.

### 8.2 `_updatePreview(startX, startY, currentX, currentY)`

```
left = min(startX, currentX)
top  = min(startY, currentY)
width  = abs(currentX - startX)
height = abs(currentY - startY)

if width <= 1 && height <= 1:
  previewEl.style.display = 'none'
  return

if mode.position === 'static' && _startContainer:
  snapped = _snapPreviewToGrid(left, top, width, height, _startContainer)
  set left/top/width/height = snapped.*
else:
  set left/top/width/height = (left, top, width, height)

previewEl.style.display = 'block'
```

### 8.3 static 모드 스냅: `_snapPreviewToGrid`

`position: 'static'`으로 삽입할 때, 미리보기 사각형이 컬럼/라인 그리드에 스냅되어 실제 생성될 영역과 정확히 일치하게 표시된다.

```
screenPpm = GridCalculator.ppm * manager.scale
editAreaLeftPx = rect.left + editAreaLeftMm * screenPpm
editAreaTopPx  = rect.top  + editAreaTopMm  * screenPpm

leftMm  = max(0, screenPxToMm(leftPx - rect.left) - containerPaddingLeft)
topMm   = max(0, screenPxToMm(topPx  - rect.top)  - containerPaddingTop)
widthMm  = screenPxToMm(widthPx)
heightMm = screenPxToMm(heightPx)

staticCoords = _mmToStatic(leftMm, topMm, widthMm, heightMm, container)

snapLeftPx  = editAreaLeftPx + staticCoords.left * avgColWidth * screenPpm
snapTopPx   = editAreaTopPx  + staticCoords.top  * lineHeight  * screenPpm
snapWidthPx  = staticCoords.width  * avgColWidth * screenPpm
snapHeightPx = staticCoords.height * lineHeight  * screenPpm

return { left: round(snapLeftPx), top: round(snapTopPx),
         width: round(snapWidthPx), height: round(snapHeightPx) }
```

픽셀 단위로 자유롭게 그리는 대신, 드래그한 영역을 컬럼과 라인 단위로 반올림하여 컨테이너의 편집 영역 내에 클램핑된 위치와 크기로 미리보기가 표시된다.

### 8.4 `_removePreview()` / `_cleanup()`

`_removePreview()`는 미리보기 사각형을 DOM에서 제거하고 `_previewEl`을 `null`로 설정한다. `_cleanup()`은 `_isDragging`과 `_startContainer`를 초기화하고, `_removePreview()`를 호출한 뒤, `document`에 등록된 `mousemove`/`mouseup`/`keydown` 리스너를 모두 제거한다.

---

## 9. 드래그 임계값

이동 거리가 3px 미만이면 클릭으로 간주하여 요소를 생성하지 않는다. 이 값은 레이아웃 드래그 이동과 동일하다.

```typescript
private static readonly DRAG_THRESHOLD = 3;
```

`_onMouseUp`에서 `distance < DRAG_THRESHOLD`이면 `_cleanup()`만 호출하고 return한다.

---

## 10. ESC 취소

### 10.1 동작

드래그 중 ESC 키를 누르면:

1. `event.preventDefault()` + `event.stopPropagation()`
2. `_cancel()` 호출
3. `_cleanup()`으로 미리보기 제거 및 리스너 해제
4. `EditManager._dispatchInsertCancel()`로 `insertCancel` 이벤트 발생

### 10.2 `_onKeyDown(event)`

```typescript
private _onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    this._cancel();
  }
}
```

ESC 키 이외의 입력은 무시한다.

### 10.3 리스너 수명 주기

| 이벤트 | 등록 시점 | 해제 시점 |
|--------|----------|----------|
| `mousemove` | `startDrag` | `_onMouseUp`, `_onKeyDown(ESC)` |
| `mouseup` | `startDrag` | `_onMouseUp`, `_onKeyDown(ESC)` |
| `keydown` | `startDrag` | `_onMouseUp`, `_onKeyDown(ESC)` |

`_cleanup()`이 세 리스너를 모두 해제한다.

---

## 11. 레이아웃 편집 모드와의 상호작용

### 11.1 삽입 모드 활성화 시 레이아웃 기능 억제

삽입 모드가 활성화되면 다음 핸들러가 `EditManager.getInstance().insertMode` 가드로 early return하여 레이아웃 선택/드래그/리사이즈가 방해되지 않는다.

- `LayoutEditController._onMouseDown` — 삽입 모드 중 `EditManager.handleInsertMouseDown()` 위임 후 return
- `LayoutEditController._startResize` — 삽입 모드 중 리사이즈 시작 차단
- `<x-layout-box>`의 `_onLayoutMouseEnter`/`_onLayoutMouseLeave` — 삽입 드래그 중 호버 표시 차단 (`_isInsertDragging()` 가드)

### 11.2 mousedown 위임: `handleInsertMouseDown`

삽입 모드 중 box에서 mousedown하면 `LayoutEditController._onMouseDown`이 `EditManager.handleInsertMouseDown(event)`를 호출한다. 이 메서드는 `InsertController.startDrag(event)`를 위임 호출하며, `startDrag()`는 `event.preventDefault()` + `event.stopPropagation()`을 호출하여 이후 레이아웃 선택/드래그 로직이 실행되지 않도록 한다.

### 11.3 문서 빈 공간 처리

`InsertController`는 `_document`에 버블링 단계로 `mousedown` 리스너를 등록하여, box가 없는 문서 빈 공간에서도 삽입 드래그가 시작되도록 한다.

- box 위에서는 `LayoutEditController._onMouseDown`이 먼저 `startDrag()`를 호출
- `_isDragging` 가드로 중복 실행 방지
- 빈 공간에서는 버블링된 mousedown이 `InsertController._boundStartDrag`를 트리거

### 11.4 커서 변경

삽입 모드 활성화 시 `EditManager.isBoxEditable()`이 true이거나 `editableLayout` DOM 속성이 있는 모든 `<x-layout-box>`의 커서가 `crosshair`로 변경된다. 비활성화 시 `grab`으로 복원된다.

### 11.5 삽입 직후 클릭 무시: `_suppressNextClick`

`_dispatchInsert`와 `_dispatchInsertCancel`은 `_suppressNextClick = true`를 설정한다. 이 플래그는 `LayoutSelectionController._onClick`에서 `_consumeSuppressNextClick()`으로 한 번만 소비되어, 삽입 완료/취소 직후 발생하는 클릭 이벤트가 레이아웃 선택을 해제하지 않도록 방지한다.

---

## 12. 이벤트

삽입 모드에서 발생하는 `insert` / `insertCancel` 이벤트의 명세는 `EDITING_EVENTS.md`를 참조한다.

---

## 13. 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/edit/insert-controller.ts` | `InsertController`: 삽입 모드의 드래그, 좌표 변환, 요소 생성, 미리보기 관리, 대상 컨테이너 찾기 |
| `src/edit/edit-manager.ts` | `insertMode` getter/setter, `activateInsert`, `deactivateInsert`, `handleInsertMouseDown`, `_dispatchInsert`, `_dispatchInsertCancel`, `insert`/`insertCancel` 이벤트 발송, `_suppressNextClick` 플래그 |
| `src/types/edit/insert.type.ts` | `InsertType`, `InsertPosition`, `InsertMode`, `InsertEventDetail` 타입 정의 |

---

## 14. 주의사항

- 삽입 모드는 `<x-layout-document>`가 DOM에 있을 때만 활성화할 수 있다. 없으면 `Error`가 발생한다.
- 삽입 모드는 편집 가능 box가 없는 빈 문서에서도 활성화할 수 있다. 이 경우 `InsertController._findTargetContainer()`가 document를 삽입 컨테이너로 반환하여 첫 box를 document에 직접 그려 넣을 수 있다. 드래그 영역이 어느 box보다 크면 `EditManager.editableRootId`로 지정된 루트 box 또는 document 루트로 폴백한다. 비활성화 시에는 `x-layout-box[editable-layout]` DOM 속성이 있는 box들의 커서를 `grab`으로 복원한다.
- 삽입된 요소는 항상 `<x-layout-box>`로 감싸진다. `text`, `paragraph`, `image` 타입도 마찬가지이다.
- `static` 모드로 삽입할 때 `model`이 없으면 `{ left: 0, top: 0, width: 1, height: 1 }` 기본값을 사용한다.
- `image` 삽입 시 placeholder 이미지는 `100×100px`, `72dpi`, 빈 `url`로 생성된다. 실제 이미지를 표시하려면 삽입 후 `url`을 변경해야 한다.
- 삽입 모드 중에는 레이아웃 선택과 드래그 이동, 리사이즈가 모두 비활성화된다.
- `boxData.children` 설정은 `appendChild`보다 먼저 이루어져야 `connectedCallback` 시점에 올바른 초기 상태를 갖는다.
- **mousedown 캡처/버블링**: `LayoutEditController`의 `mousedown` 리스너는 캡처 단계로 `document.documentElement`에 등록된다. box 위에서 mousedown하면 먼저 `LayoutEditController._onMouseDown`이 `EditManager.handleInsertMouseDown()`을 호출하여 `InsertController.startDrag()`를 위임 실행하고, `startDrag()` 내부의 `_isDragging` 가드로 중복 실행을 방지한다. `InsertController`의 `mousedown` 리스너는 문서(document)에 버블링 단계로 등록되어, box가 없는 문서 빈 공간에서도 삽입 드래그가 시작되도록 한다.
- **대상 컨테이너 선택은 드래그 영역의 네 꼭짓점 기반**: 중심점이 아닌 네 꼭짓점 모두가 포함되는 가장 안쪽 컨테이너를 선택한다. 작은 컨테이너 위에 큰 요소를 그려도 작은 컨테이너가 아닌 상위 컨테이너에 삽입된다.
- **폴백은 EditManager 루트**: 어떤 컨테이너도 드래그 사각형을 완전히 포함하지 못하면 `editableRootId`의 루트 box, 또는 document 루트로 폴백한다.