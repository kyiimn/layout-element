# layout-element 삽입 모드 (Insert Mode) 상세 명세

> 작성 기준: `src/edit/insert-controller.ts`, `src/edit/edit-manager.ts`, `src/types/edit/insert.type.ts`
>
> 본 문서는 `layout-element` 라이브러리의 삽입 모드(`InsertController`) 기능, 공개 API, 대상 컨테이너 찾기 알고리즘, 좌표 변환, 미리보기, ESC 취소, 레이아웃 편집 모드와의 상호작용을 상세히 기술한다.

---

## 1. 개요 (Overview)

삽입 모드는 문서 표면에서 마우스로 드래그하여 새 요소를 생성하는 기능이다. 사용자가 삽입할 요소의 종류와 배치 모드를 선택하면, `<x-layout-document>` 위에서 드래그한 영역만큼 새 요소가 만들어진다.

- **삽입 가능한 요소**: `box`, `text`, `paragraph`, `image`, `table`
- **배치 모드**: `absolute`(mm 좌표) 또는 `static`(컬럼/라인 그리드)
- **테이블**: `type: 'table'` 시 `tableRows`/`tableCols`로 행/열 수 지정 (기본값 3×3), `tableFillCells`로 각 셀을 paragraph box로 채울지 여부 지정 (기본값 `true`)
- **취소**: 드래그 중 `ESC` 키를 누르면 미리보기 사각형이 제거되고 `insertCancel` 이벤트가 발생한다.

삽입 모드가 활성화되면 문서 요소의 커서가 `crosshair`로 바뀌고, 기존 레이아웃 선택은 자동으로 해제된다. 삽입 모드 중에는 레이아웃 선택과 드래그 이동이 동작하지 않아 삽입 동작과 충돌하지 않는다.

### 1.1 컨트롤러 아키텍처

`InsertController`는 `EditManager.insertMode`가 활성화될 때 생성되어 문서 수준에서 마우스 이벤트를 처리한다. `LayoutEditController`(드래그/리사이즈) 및 `LayoutSelectionController`(클릭 선택)와 분리된 독립 컨트롤러이다.

```
┌─────────────────────────────────────────────────────────────────────┐
│ <x-layout-document>                                                  │
│                                                                      │
│  EditManager (per-document instance)                                             │
│  ├── insertMode: InsertMode | null                                    │
│  ├── _insertController: InsertController | null                       │
│  ├── activateInsert(mode) / deactivateInsert()                        │
│  └── insert / insertCancel 이벤트 발송                                │
│                                                                      │
│  InsertController (삽입 전용)                                          │
│  ├── _document: LayoutDocumentElement                                 │
│  ├── _mode: InsertMode | null                                          │
│  ├── _isDragging: boolean                                             │
│  ├── _lastPreviewRect: { left, top, width, height } | null             │
│  ├── _insertHighlightTarget: LayoutBoxElement | LayoutDocumentElement | null │
│  ├── startDrag(event)                                                  │
│  ├── _findTargetContainer(startX, startY, endX, endY)                  │
│  ├── _finishInsert()                                                   │
│  ├── _cancel()                                                        │
│  ├── _createPreview() / _updatePreview() → rect | null                │
│  ├── _updateInsertHighlight(previewRect) / _clearInsertHighlight()    │
│  └── _removePreview() / _cleanup()                                    │
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
const manager = layoutDocEl.editManager;

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
  type: 'box' | 'text' | 'paragraph' | 'image' | 'table';
  position: 'absolute' | 'static';
  tableRows?: number;       // type === 'table'일 때만 사용 (기본값 3)
  tableCols?: number;       // type === 'table'일 때만 사용 (기본값 3)
  tableFillCells?: boolean; // type === 'table'일 때만 사용 (기본값 true)
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `type` | `'box' \| 'text' \| 'paragraph' \| 'image' \| 'table'` | 삽입할 요소의 종류 |
| `position` | `'absolute' \| 'static'` | 새 요소의 배치 모드 |
| `tableRows` | `number` | 테이블 행 수 (`type === 'table'`일 때만, 기본값 3) |
| `tableCols` | `number` | 테이블 열 수 (`type === 'table'`일 때만, 기본값 3) |
| `tableFillCells` | `boolean` | 각 셀을 paragraph box로 채울지 여부 (`type === 'table'`일 때만, 기본값 `true`). `false`면 빈 셀(`children: []`)로 생성 |

`text`와 `paragraph`는 모두 `<x-layout-paragraph>`를 내부에 생성하지만, `text`는 `type: 'text'` 데이터로, `paragraph`는 `type: 'paragraph'` 데이터로 변환된다. `text` 타입은 `box.element.ts`의 `data` 세터에서 `{ ...child, type: 'paragraph' }`로 변환되며, 이때 `column`/`gap`을 명시적으로 설정하지 않아 부모 모델에서 상속받는다. 실제 렌더링에서는 둘 다 단락 요소로 표시된다.

### 3.2 `InsertType`

```typescript
export type InsertType = 'box' | 'text' | 'paragraph' | 'image' | 'table';
```

삽입할 요소의 타입.

- `'box'`: 빈 박스 컨테이너
- `'text'`: 텍스트 (내부적으로 paragraph로 변환됨)
- `'paragraph'`: 단락
- `'image'`: 이미지
- `'table'`: 표 (`tableRows`/`tableCols`/`tableFillCells` 옵션 사용)

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
│     │       ├── _createPreview()                             │
│     │       ├── _lastPreviewRect = _updatePreview(x,y,x,y)   │
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
│     ├── _lastPreviewRect = _updatePreview()                  │
│     │   → 점선 테두리 반투명 파란색 사각형 위치/크기 갱신     │
│     │   → static 모드: root 요소의 컬럼/라인 그리드에 스냅    │
│     │   → 스냅된 픽셀 rect 반환                              │
│     └── _updateInsertHighlight(_lastPreviewRect)              │
│         → preview rect로 컨테이너 판정                        │
│         → 이전 하이라이트 제거, 새 컨테이너에 reparent-target 설정 │
│         → 레이아웃 편집 reparent와 동일한 주황색 테두리       │
│                                                             │
│  ④ mouseup (드래그 완료)                                      │
│     │                                                        │
│     ├── 이동 거리 < 3px? → _cleanup(), return (클릭으로 간주) │
│     │   (_cleanup이 _clearInsertHighlight() 호출)            │
│     ├── _finishInsert()                                      │
│     │   → _lastPreviewRect로 컨테이너 탐색                    │
│     │   → _resolveInsertContainer(previewRect)               │
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
│     │   └── _cleanup() → _clearInsertHighlight() 호출        │
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

선택은 인쇄 모드와 인서트 모드를 제외하면 항상 활성이다.

---

## 5. 대상 컨테이너 찾기

### 5.1 개요

드래그 영역(또는 스냅된 preview 영역)을 완전히 포함하는 가장 안쪽 유효 컨테이너를 찾는다. **preview rect 기반 판정**: `_updateInsertHighlight`와 `_finishInsert` 모두 `_updatePreview`가 반환한 스냅된 픽셀 rect를 사용하여 컨테이너를 판정한다. 마우스 커서의 raw 픽셀 위치가 아닌, preview가 실제로 그려진 위치를 기준으로 한다.

> **static 모드 그리드 containment 검증**: static 모드(`position: 'static'`)에서는 문서 내 모든 빈(empty) `<x-layout-td>` 셀과 box-only 박스를 순회하며, 각 컨테이너에 대해 `_mmToStatic` + `staticGridContains()`로 요소의 static 그리드 영역(컬럼 인덱스 + 스팬, 라인 인덱스 + 라인 수)이 후보의 컬럼/라인 그리드 안에 완전히 들어오는지 검증한다. 통과한 후보들 중 가장 깊이 중첩된(deepest) 컨테이너를 선택한다. TD 후보는 box 후보보다 우선순위가 높다. `elementsFromPoint` hit test를 사용하지 않고, 오직 그리드 containment로만 판정한다.

> **음수 좌표 처리**: `_screenToContainerMm`이 음수 좌표를 클램핑하지 않고 그대로 반환한다. 요소가 박스 바깥에 있으면 `leftMm`/`topMm`이 음수가 되고, `_mmToStatic`이 음수 `nearestColumn`/`nearestLine`을 반환하여 `staticGridContains`가 `elementLeft < 0` / `elementTop < 0`으로 거부한다. 이로 인해 박스 바깥의 요소가 박스 안으로 잘못 끌려오는 것을 방지한다.

### 5.2 선택 알고리즘

```
  _findTargetContainer(startX, startY, endX, endY)
    │
    ├── 0. static 모드 (position === 'static')
    │   leftPx = min(startX, endX), topPx = min(startY, endY)
    │   widthMm = screenPxToMm(|endX - startX|)
    │   heightMm = screenPxToMm(|endY - startY|)
    │   // 1) 빈 TD 후보 검사 (box보다 더 깊은 중첩)
    │   allTds = _document.querySelectorAll('x-layout-td')
    │   tdCandidates = []
    │   for each td in allTds:
    │     if td.items.length > 0 → skip
    │     if rootBox && !rootBox.contains(td) → skip
    │     rect = td.getBoundingClientRect()
    │     if startX >= rect.left && endX <= rect.right &&
    │        startY >= rect.top && endY <= rect.bottom:
    │       staticCoords = _mmToStatic(leftMm, topMm, widthMm, heightMm, td)
    │       if staticGridContains(td, staticCoords):
    │         tdCandidates.push(td)
    │   deepestTd = tdCandidates 중 parent chain의 LayoutBoxElement/TD 수가 가장 많은 TD
    │   if deepestTd → return deepestTd
    │   // 2) box 후보 검사
    │   allBoxes = _document.querySelectorAll('x-layout-box')
    │   validCandidates = []
    │   for each box in allBoxes:
    │     if box.lock → skip
    │     if box.items has non-box child → skip
    │     if rootBox && !rootBox.contains(box) → skip
    │     { leftMm, topMm } = _screenToContainerMm(leftPx, topPx, box)  // 음수 클램핑 없음
    │     staticCoords = _mmToStatic(leftMm, topMm, widthMm, heightMm, box)  // 클램핑 없음
    │     if staticGridContains(box, staticCoords.left, staticCoords.top,
    │                            staticCoords.width, staticCoords.height):
    │       validCandidates.push(box)
    │   // 가장 깊이 중첩된 박스 선택
    │   deepest = validCandidates 중 parent chain의 LayoutBoxElement 수가 가장 많은 박스
    │   if deepest → return deepest
    │   if rootBox && !rootBox.lock → return rootBox
    │   return _document
    │
    ├── 1. absolute 모드: 네 꼭짓점 정의
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
    ├── 3b. 기하학적 rect containment 폴백 (유효 box 후보가 없는 경우)
    │   hasValidBoxCandidate = fullyHit에 lock되지 않고 non-box 자식 없는 box가 있음?
    │   if !hasValidBoxCandidate:
    │     allBoxes = _document.querySelectorAll('x-layout-box')
    │     for each box in allBoxes:
    │       if box.lock → skip
    │       if box.items has non-box child → skip
    │       if candidates.has(box) → skip
    │       rect = box.getBoundingClientRect()
    │       if startX >= rect.left-1 && endX <= rect.right+1 &&
    │          startY >= rect.top-1 && endY <= rect.bottom+1:
    │         if fullyHit의 다른 박스가 이 box를 포함하지 않음:
    │           fullyHit.push(box)
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
| `<x-layout-td>` | static 모드, `items.length === 0` | 유효한 컨테이너 (box보다 우선) |
| `<x-layout-td>` | static 모드, 자식이 있음 | 유효하지 않음 |
| `<x-layout-td>` | absolute 모드 | 제한 없이 유효 |
| `<x-layout-box>` | `lock` 설정됨 | 건너뜀 |
| `<x-layout-box>` | 자식이 없거나 모든 자식이 `type === 'box'` | 유효한 컨테이너 |
| `<x-layout-box>` | 자식 중 `paragraph`나 `image`가 있음 | 유효하지 않음 |
| `<x-layout-box>` (static 모드) | 요소의 static 그리드 영역이 box의 컬럼/라인 수를 초과 | 유효하지 않음 (더 바깥 컨테이너로 폴백) |

**TD 내 static 삽입 크기 제한**: 컨테이너가 `<x-layout-td>`이고 `position === 'static'`이면, 드래그 박스의 mm 크기(`widthMm`, `heightMm`)가 `td.model.editableWidth`/`td.model.contentHeight`를 초과하면 삽입이 거부된다. 크기가 적합하면 `left=0, top=0, width=1, height=1`로 설정되어 셀을 가득 채운다. absolute 모드로는 제한 없이 기존 절대좌표 로직을 따른다.

단락이나 이미지가 이미 들어 있는 박스 안에 새 박스를 추가하면 기존 콘텐츠와의 모순이 생길 수 있으므로, 그 경우 상위 컨테이너로 거슬러 올라간다. static 모드에서는 추가로, 요소가 차지할 컬럼/라인 영역이 후보 box의 그리드를 벗어나면 상위 컨테이너로 거슬러 올라간다.

### 5.4 폴백: `_getRootContainer()`

드래그 사각형을 완전히 포함하는 컨테이너가 하나도 없으면, `EditManager.editableRootId`로 지정된 루트 box를 반환한다. `editableRootId`가 없으면 문서 루트(`<x-layout-document>`)를 반환한다.

### 5.5 `editableRootId` 제한 — root box 밖으로 삽입 금지

`editableRootId`가 설정되어 있는 경우(root가 document가 아닌 특정 box인 경우), 삽입 드래그 영역이 root box 밖으로 나가는 것을 방지한다.

| 상황 | 동작 |
|------|------|
| static 모드 중심점이 root box 내부 box에 있음 | 해당 box를 컨테이너로 사용 |
| static 모드 중심점이 root box 밖에 있음 | root box 내부 box만 후보 → root box로 폴백 |
| absolute 모드 4꼭짓점이 root box 내부에 있음 | 해당 box를 컨테이너로 사용 |
| absolute 모드 드래그 영역이 root box 밖으로 나감 | root box 자체로 클램핑 (document로 폴백하지 않음) |
| 기하학적 rect containment 폴백 | root box 내부의 box만 후보로 검토 |
| 최종 폴백 | `_getRootContainer()`가 root box 반환 |

**핵심**: `editableRootId` 설정 시 document는 절대 컨테이너로 반환되지 않으며, root box가 최종 클램핑 대상이 된다. root box 자체는 편집 불가(`isBoxEditable`이 `false`)하지만 삽입 컨테이너로는 사용된다.

```typescript
private _getRootContainer(): LayoutDocumentElement | LayoutBoxElement {
  const manager = layoutDocEl.editManager;
  const rootId = manager.editableRootId;
  if (rootId) {
    const rootBox = this._document.querySelector(`#${CSS.escape(rootId)}`) as LayoutBoxElement | null;
    if (rootBox) return rootBox;
  }
  return this._document;
}
```

### 5.5 모든 삽입 타입에 동일 적용

이 로직은 모든 삽입 타입(`box`, `text`, `paragraph`, `image`, `table`)에 동일하게 적용된다.

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
| `table` | `_createTableData(rows, cols, fillCells)` | `<x-layout-table>` (행 높이 5mm, 열 너비 자동 균등 분할). `tableFillCells !== false`(기본값)면 각 셀에 빈 paragraph box, `false`면 빈 셀(`children: []`) |

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

leftMm = screenPxToMm(clientX - rect.left) - containerPaddingLeft
topMm  = screenPxToMm(clientY - rect.top)  - containerPaddingTop
```

- 음수 좌표 클램핑 없음 — 컨테이너 바깥의 좌표는 음수로 반환되어 `staticGridContains`가 거부
- `screenPxToMm(px) = px / (GridCalculator.ppm * manager.scale)` — scale 보정 적용

### 7.2 `_mmToStatic(leftMm, topMm, widthMm, heightMm, container)`

mm 좌표를 static 그리드 좌표로 변환한다. **클램핑 없이 raw 변환만 수행** — 컨테이너 안으로 요소를 끌어당기지 않고, `staticGridContains`가 판정을 담당한다.

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
nearestLine = round((topMm - editAreaTop) / lineHeight)
widthCols   = max(1, round(widthMm / avgColWidth))
heightLines = max(1, round(heightMm / lineHeight))

return { left: nearestColumn, top: nearestLine, width: widthCols, height: heightLines }
```

- `left`: 가장 가까운 컬럼 인덱스 (음수 가능 — 컨테이너 바깥)
- `top`: 가장 가까운 라인 인덱스 (음수 가능)
- `width`: 드래그 영역의 컬럼 수 (최소 1)
- `height`: 드래그 영역의 라인 수 (최소 1)
- **컨테이너 안으로 클램핑하지 않음** — 요소가 컨테이너를 벗어나면 `staticGridContains`가 `false`를 반환하여 더 바깥 컨테이너로 폴백

### 7.3 absolute 모드 최종 값

absolute 모드에서는 mm 값을 소수점 둘째 자리까지 반올림한다.

```
left   = round(leftMm * 100) / 100
top    = round(topMm * 100) / 100
width  = round(widthMm * 100) / 100
height = round(heightMm * 100) / 100
```

absolute 모드에서는 추가로 컨테이너의 편집 영역(`editableWidth`/`contentHeight`)을
초과하지 않도록 클램핑한다:

```
if containerContentW > 0 and left + width > containerContentW:
  width = max(1, round((containerContentW - left) * 100) / 100)
if containerContentH > 0 and top + height > containerContentH:
  height = max(1, round((containerContentH - top) * 100) / 100)
```

> `containerContentW`/`containerContentH`는 `container.model.editableWidth`와
> `container.model.contentHeight`에서 얻는다. `left + width` 또는 `top + height`가
> 컨테이너 영역을 초과하면 `width`/`height`를 남은 공간에 맞춰 축소한다 (최소 1mm).

또한 드래그 시작/끝점 자체도 컨테이너 rect 내부로 클램핑한 뒤 width/height를
계산하므로, 드래그 영역이 컨테이너보다 크게 그려져도 컨테이너 영역을 벗어나지
않는다.

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
  return null

if mode.position === 'static':
  rect = _snapPreviewToGrid(left, top, width, height, _getRootContainer())
else:
  rect = { left, top, width, height }

set previewEl style = rect.*
previewEl.style.display = 'block'
return rect
```

**반환값**: 스냅된 픽셀 rect `{ left, top, width, height }` 또는 `null`(드래그 임계값 미만). 이 rect는 `_updateInsertHighlight`와 `_finishInsert`에서 컨테이너 판정에 사용된다.

### 8.3 static 모드 스냅: `_snapPreviewToGrid`

`position: 'static'`으로 삽입할 때, 미리보기 사각형은 기본적으로 root 요소의 컬럼/라인 그리드에 스냅된다. 단, preview 중심점 아래에 **빈 `<x-layout-td>`**가 있으면 preview를 해당 TD의 경계矩形(bounding rect)으로 클램핑하여 TD에 맞춰진다. 이 경우 그리드 스냅 대신 TD rect 스냅이 적용되며, 사용자가 셀 영역에 정확히 맞춰 삽입할 수 있도록 돕는다.

`position: 'static'`으로 삽입할 때, 미리보기 사각형이 **root 요소**(editableRootId가 지정한 박스, 없으면 document)의 컬럼/라인 그리드에 스냅된다. 특정 박스가 아닌 root 요소 기준이므로, 드래그가 박스 경계를 넘어도 preview가 자유롭게 따라간다.

```
container = _getRootContainer()  // editableRootId 박스 또는 document
model = container.model
columnCoords = model.columnCoords
lineHeight, editableWidth, columnCount = model.*
avgColWidth = editableWidth / columnCount

editAreaLeftMm = columnCoords[0].x1
editAreaTopMm  = columnCoords[0].y1
screenPpm = GridCalculator.ppm * manager.scale

leftMm  = max(0, screenPxToMm(leftPx - rect.left) - containerPaddingLeft)
topMm   = max(0, screenPxToMm(topPx  - rect.top)  - containerPaddingTop)
widthMm  = screenPxToMm(widthPx)
heightMm = screenPxToMm(heightPx)

nearestColumn = round((leftMm - editAreaLeftMm) / avgColWidth)
nearestLine = round((topMm - editAreaTopMm) / lineHeight)
widthCols  = max(1, min(round(widthMm / avgColWidth), columnCount))
heightLines = max(1, round(heightMm / lineHeight))

containerLineCount = floor(editableHeight / lineHeight) + 1  // 마지막 줄 포함

clampedColumn = clamp(nearestColumn, 0, columnCount - widthCols)
clampedLine   = clamp(nearestLine, 0, containerLineCount - heightLines)

startCol = clamp(clampedColumn, 0, columnCount - 1)
endCol   = min(columnCount - 1, startCol + widthCols - 1)
snapLeftMm  = columnCoords[startCol].x1
snapRightMm = columnCoords[endCol].x2
snapLeftPx  = rect.left + (snapLeftMm + containerPaddingLeft) * screenPpm
snapWidthPx = (snapRightMm - snapLeftMm) * screenPpm
snapTopPx   = rect.top + (editAreaTopMm + containerPaddingTop + clampedLine * lineHeight) * screenPpm
snapHeightPx = heightLines * lineHeight * screenPpm

return { left: round(snapLeftPx), top: round(snapTopPx),
         width: round(snapWidthPx), height: round(snapHeightPx) }
```

- **root 요소 기준**: `_getRootContainer()`가 반환한 요소(editableRootId 박스 또는 document)의 그리드로 스냅
- **갭(gap) 반영**: `columnCoords` 배열을 직접 사용하여 컬럼 간 gap을 정확히 반영
- **마지막 라인**: `containerLineCount = floor(editableHeight / lineHeight) + 1` — 마지막 줄은 `lineHeight`보다 짧아도 유효한 배치 영역
- **라인 상한 클램핑**: `clampedLine`을 `containerLineCount - heightLines`로 상한 클램핑하여 preview가 root 하단을 넘지 않도록 함

### 8.4 `_removePreview()` / `_cleanup()`

`_removePreview()`는 미리보기 사각형을 DOM에서 제거하고 `_previewEl`을 `null`로 설정한다. `_cleanup()`은 `_isDragging`과 `_lastPreviewRect`를 초기화하고, `_clearInsertHighlight()`로 컨테이너 하이라이트를 제거한 뒤, `_removePreview()`를 호출하고, `document`에 등록된 `mousemove`/`mouseup`/`keydown` 리스너를 모두 제거한다.

### 8.5 컨테이너 하이라이트 (삽입 드래그 중)

삽입 드래그 중에는 미리보기 사각형과 함께, 현재 preview 영역이 어느 컨테이너에 들어갈 수 있는지를 시각적으로 표시한다. 레이아웃 편집 모드의 reparent 하이라이트와 동일한 `reparent-target` DOM 속성과 주황색(`#ff9800`, 2px) 테두리 CSS를 재사용하여 일관된 시각적 피드백을 제공한다.

| 속성 | 색상 | 적용 대상 | 조건 |
|------|------|----------|------|
| `reparent-target` | 주황 (`#ff9800`, 2px) | box 또는 document | 삽입 드래그 중 preview 영역을 완전히 포함하는 가장 안쪽 유효 컨테이너 |

#### `_updateInsertHighlight(previewRect)`

`_onMouseMove`에서 `_updatePreview()` 직후에 호출된다. **마우스 커서 위치가 아닌 preview rect**로 `_resolveInsertContainer()`를 호출하여 대상 컨테이너를 찾는다 — 이는 mouseup 시점의 `_finishInsert`가 호출하는 것과 **동일한 메서드**(`_resolveInsertContainer`)를 사용하므로, 하이라이트가 가리키는 컨테이너와 실제 삽입되는 컨테이너가 항상 일치한다.

```
_updateInsertHighlight(previewRect)
    │
    ├── _isDragging? → 아니면 return
    ├── previewRect null 또는 width/height ≤ 1? → _clearInsertHighlight(); return
    ├── startX/Y, endX/Y = previewRect 기준 (left, top, left+width, top+height)
    ├── target = _resolveInsertContainer(startX, startY, endX, endY)
    │        → _findTargetContainer과 동일 (단일 진실 공급원)
    ├── _insertHighlightTarget === target? → return (변경 없음)
    ├── 이전 _insertHighlightTarget이 있으면 reparent-target 제거
    ├── target이 있으면 reparent-target 설정
    └── _insertHighlightTarget = target
```

> **단일 진실 공급원 (single source of truth)**: `_resolveInsertContainer()`는 `_finishInsert`(드랍)와 `_updateInsertHighlight`(하이라이트)가 공유하는 컨테이너 결정 메서드다. 내부적으로 `_findTargetContainer`를 호출한다. 두 곳 모두 preview rect를 사용하므로 하이라이트가 가리키는 컨테이너와 실제 삽입되는 컨테이너가 일치한다.

#### `_clearInsertHighlight()`

`_cleanup()` 내에서 호출되어 드래그 종료(mouseup/ESC/임계값 미충족 클릭) 시 하이라이트를 제거한다. 현재 하이라이트 대상의 `reparent-target` 속성을 제거하고 `_insertHighlightTarget`을 `null`로 설정한다.

#### 정적 모드에서의 컨테이너 탐색

`_findTargetContainer()`는 `position: 'static'` 모드에서 **문서 내 모든 빈 `<x-layout-td>` 셀과 box-only 박스**를 순회하며, 각 컨테이너에 대해 `staticGridContains()`로 요소의 static 그리드 영역(컬럼 인덱스 + 스팬, 라인 인덱스 + 라인 수)이 컨테이너의 컬럼/라인 그리드 안에 완전히 들어오는지 검증한다. 통과한 후보들 중 가장 깊이 중첩된(deepest) 컨테이너를 선택하며, TD 후보가 box 후보보다 우선한다. `elementsFromPoint` hit test를 사용하지 않고, 오직 그리드 containment로만 판정한다. `position: 'absolute'` 모드에서는 **네 꼭짓점 containment**로 식별하며, TD 역시 일반 컨테이너로 포함된다.

#### 레이아웃 편집 reparent와의 관계

레이아웃 편집 모드의 reparent 하이라이트(`LayoutEditController._updateReparentHighlight`)와 동일한 DOM 속성(`reparent-target`)과 CSS 규칙을 재사용한다. 두 모드는 상호 배타적으로 동작하므로(삽입 모드 활성화 시 `layoutEditMode = false`), 같은 속성을 공유해도 충돌이 발생하지 않는다. 삽입 모드에서는 드래그 중인 box가 없으므로 `_findReparentContainer`의 box 자신/자손 제외 로직이 불필요하여, `_findTargetContainer`를 그대로 사용한다.

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

삽입 모드가 활성화되면 다음 핸들러가 `layoutDocEl.editManager.insertMode` 가드로 early return하여 레이아웃 선택/드래그/리사이즈가 방해되지 않는다.

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
| `src/edit/insert-controller.ts` | `InsertController`: 삽입 모드의 드래그, 좌표 변환, 요소 생성, 미리보기 관리, 컨테이너 하이라이트(`_updateInsertHighlight(previewRect)`/`_clearInsertHighlight`/`_resolveInsertContainer`), 대상 컨테이너 찾기(`_findTargetContainer` — static 모드: 문서 내 모든 box-only 박스 순회 + `staticGridContains` 그리드 containment 검증, 가장 깊이 중첩된 박스 선택; absolute 모드: 4꼭짓점 containment + 유효 box 후보 폴백), 미리보기 스냅(`_snapPreviewToGrid` — root 요소 기준, `columnCoords`로 갭 반영, 마지막 라인 `lineHeight` 제외) |
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
- **대상 컨테이너 선택은 preview rect 기반**: `_updateInsertHighlight`와 `_finishInsert` 모두 `_updatePreview`가 반환한 스냅된 픽셀 rect를 사용하여 컨테이너를 판정한다. 마우스 커서의 raw 위치가 아닌, preview가 실제로 그려진 위치를 기준으로 한다. absolute 모드에서는 네 꼭짓점 모두가 포함되는 가장 안쪽 컨테이너를 선택한다. static 모드에서는 문서 내 모든 box-only 박스를 순회하며 `staticGridContains()`로 요소의 컬럼/라인 영역이 컨테이너 그리드 안에 완전히 들어오는지 검증하고, 통과한 박스 중 가장 깊이 중첩된 박스를 선택한다. 작은 컨테이너 위에 큰 요소를 그려도 작은 컨테이너가 아닌 상위 컨테이너에 삽입된다.
- **폴백은 EditManager 루트**: 어떤 컨테이너도 preview 영역을 완전히 포함하지 못하면 `editableRootId`의 루트 box, 또는 document 루트로 폴백한다.
- **미리보기는 root 요소 기준 스냅**: static 모드의 preview는 특정 박스가 아닌 root 요소(`_getRootContainer()` — editableRootId 박스 또는 document)의 그리드에 스냅한다. 따라서 드래그가 박스 경계를 넘어도 preview가 자유롭게 따라간다. 갭(gap)은 `columnCoords` 배열로 정확히 반영되며, 마지막 라인의 `lineHeight`는 제외된다.
- **음수 좌표 처리**: `_screenToContainerMm`이 음수 좌표를 클램핑하지 않고 그대로 반환한다. 요소가 박스 바깥에 있으면 `leftMm`/`topMm`이 음수가 되어 `staticGridContains`가 거부하므로, 박스 바깥의 요소가 박스 안으로 잘못 끌려오는 것을 방지한다.