# layout-element Place Gun 상세 명세

> 작성 기준: `src/edit/edit-manager.ts`, `src/edit/place-gun-controller.ts`, `src/types/edit/place-gun.type.ts`
>
> 본 문서는 `layout-element` 라이브러리의 Place Gun 기능(장전, 클릭 배치, 일시정지, 순서 변경)의 공개 API, 컨트롤러 아키텍처, 배치 알고리즘, 이벤트를 상세히 기술한다.

---

## 1. 개요 (Overview)

Place Gun은 InDesign의 "Place Gun" 개념을 차용한 기능으로, 여러 컨텐츠 항목을 메모리에 장전(Load)한 뒤 문서 표면에서 클릭할 때마다 장전된 순서대로 하나씩 배치한다.

- **장전 가능한 컨텐츠**: `text`(단락), `image`(이미지)
- **배치 방식**: 단일 클릭(드래그 아님). 클릭 위치에 이미 매칭되는 요소가 있으면 그 요소에 데이터를 주입한다. 새 요소를 생성하지 않는다.
- **매칭 규칙**: 클릭 위치의 box 자식이 항목 contentType과 일치해야 함
  - `text` 항목 → box의 `contentType`이 `'paragraph'`인 자식 paragraph
  - `image` 항목 → box의 `contentType`이 `'image'`인 자식 image
- **비매칭 시 no-op**: 매칭되는 요소가 없으면 항목을 소비하지 않고 아무 동작도 하지 않는다
- **일시정지**: 장전된 항목이 있어도 배치를 일시정지할 수 있음
- **순서 변경**: 외부 UI에서 리스트 재정렬 (EditManager API로 반영)
- **취소**: 항목 삭제, 전체 비우기

Place Gun이 활성 상태(항목 ≥ 1, 일시정지 아님)이면 문서 커서가 `copy`로 변경되고, 문서 클릭 시 맨 위 항목이 배치된다.

### 1.1 컨트롤러 아키텍처

```
┌─────────────────────────────────────────────────────────────────────┐
│ <x-layout-document>                                                  │
│                                                                      │
│  EditManager (singleton)                                             │
│  ├── placeGunItems: PlaceGunItem[]                                    │
│  ├── placeGunPaused: boolean                                          │
│  ├── placeGunActive: boolean (get — items > 0 && !paused)            │
│  ├── _placeGunController: PlaceGunController | null                   │
│  ├── loadPlaceGun(items) / unloadPlaceGun()                           │
│  ├── removePlaceGunItem(index) / reorderPlaceGunItems(from, to)       │
│  ├── setPlaceGunPaused(paused)                                        │
│  ├── _consumePlaceGunItem() → PlaceGunItem | null                     │
│  ├── _syncPlaceGunController()                                        │
│  └── placeGunChange 이벤트 발송                                       │
│                                                                      │
│  PlaceGunController (클릭 배치 전용)                                   │
│  ├── attach() / detach() (커서 변경만)                                │
│  ├── handleBoxMouseDown(box, event) [box에서 호출]                    │
│  ├── _findTargetInBox(box, item)                                      │
│  ├── _injectItem(item, target)                                        │
│  └── _applyCursor(active)                                             │
│                                                                      │
│  LayoutBoxElement                                                      │
│  ├── _onPlaceGunMouseDown (mousedown 리스너)                           │
│  └── placeGunActive 시 EditManager.handlePlaceGunMouseDown 위임        │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 사전 조건

- Place Gun은 인쇄 모드에서 완전히 차단된다 (`_isPrint` 가드).
- `<x-layout-document>` 요소가 DOM에 없으면 클릭 배치가 동작하지 않는다 (no-op).

---

## 2. API

### 2.1 장전 / 비우기

```typescript
const manager = EditManager.getInstance();

// 장전
manager.loadPlaceGun([
  { contentType: 'text', title: '기사1', sourceId: 'a1', content: '내용...' },
  { contentType: 'image', title: '사진1', sourceId: 'i1', content: '/img/1.png' },
]);

// 전체 비우기
manager.unloadPlaceGun();
```

| 메서드 | 설명 |
|--------|------|
| `loadPlaceGun(items)` | 항목들을 장전. 기존 항목은 모두 교체. `placeGunPaused`도 `false`로 리셋. 빈 배열이면 `unloadPlaceGun()`과 동일. |
| `unloadPlaceGun()` | 모든 항목 비우기 + 일시정지 해제 + 컨트롤러 제거. |

### 2.2 상태 조회

```typescript
manager.placeGunItems;    // PlaceGunItem[] (얕은 복사)
manager.placeGunPaused;   // boolean
manager.placeGunActive;   // boolean (items.length > 0 && !paused)
```

### 2.3 항목 조작

```typescript
// 개별 삭제
manager.removePlaceGunItem(0);

// 순서 변경 (3번째 → 맨 위)
manager.reorderPlaceGunItems(2, 0);
```

| 메서드 | 설명 |
|--------|------|
| `removePlaceGunItem(index)` | 지정 인덱스 항목 삭제. 컨트롤러가 자동 동기화됨. |
| `reorderPlaceGunItems(from, to)` | `from` 인덱스 항목을 `to` 인덱스로 이동. 맨 위(0) = 다음 쏠 항목. |

### 2.4 일시정지

```typescript
manager.setPlaceGunPaused(true);   // 일시정지 — 커서 복원, 클릭 무시
manager.setPlaceGunPaused(false);  // 재개 — 커서 copy, 클릭 배치 활성
```

### 2.5 항목 소비 (내부)

`_consumePlaceGunItem()`은 `PlaceGunController`가 클릭 배치를 완료한 후 호출한다. 맨 위 항목을 제거하고 반환하며, 리스트가 비면 컨트롤러가 자동 비활성화된다.

---

## 3. 타입 정의

### 3.1 `PlaceGunContentType`

```typescript
export type PlaceGunContentType = 'text' | 'image';
```

### 3.2 `PlaceGunSubType`

```typescript
export type PlaceGunSubType = 'article' | 'image' | 'ad';
```

이미지/광고의 URL 패턴을 결정한다.

### 3.3 `ArticleContent` / `ImageContent`

```typescript
export type ArticleContent = {
  uid: string;   // 기사 고유 식별자
  title: string; // 기사 제목
  body: string;   // 기사 본문 텍스트
};

export type ImageContent = {
  uid: string;      // 이미지/광고 고유 식별자
  caption: string;   // 이미지/광고 설명 (캡션)
};
```

`contentType === 'text'`인 항목의 `content`는 `ArticleContent`이고, `contentType === 'image'`인 항목의 `content`는 `ImageContent`이다.

### 3.4 `PlaceGunItem`

```typescript
export type PlaceGunItem = {
  contentType: PlaceGunContentType;
  subType: PlaceGunSubType;
  title: string;
  sourceId: string;
  content: ArticleContent | ImageContent;
};
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `contentType` | `'text' \| 'image'` | 컨텐츠 종류 (배치 매칭용) |
| `subType` | `'article' \| 'image' \| 'ad'` | 세부 종류 (URL 패턴 결정용) |
| `title` | `string` | 패널 표시용 제목 |
| `sourceId` | `string` | 원본 컨텐츠 고유 식별자 |
| `content` | `ArticleContent \| ImageContent` | 본문 데이터 객체 |

### 3.5 `PlaceGunChangeEventDetail`

```typescript
export type PlaceGunChangeEventDetail = {
  items: PlaceGunItem[];
  paused: boolean;
};
```

`placeGunChange` 이벤트 payload. 상세는 `EDITING_EVENTS.md` 참조.

---

## 4. 클릭 배치 흐름

### 4.1 Place Gun 생명 주기

```
┌─────────────────────────────────────────────────────────────┐
│                    Place Gun 생명 주기                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ① 항목 장전                                                 │
│     │                                                        │
│     ├── EditManager.loadPlaceGun(items)                     │
│     ├── _placeGunItems = items, _placeGunPaused = false      │
│     ├── _syncPlaceGunController()                           │
│     │   ├── placeGunActive === true?                         │
│     │   │   ├── yes → PlaceGunController 생성/재사용, attach() │
│     │   │   └── no → (빈 리스트면 컨트롤러 detach)             │
│     └── _dispatchPlaceGunChange() → placeGunChange 이벤트    │
│                                                             │
│  ② 커서 변경                                                  │
│     ├── attach() 시 document 커서를 'copy'로 변경           │
│     └── detach() 시 커서 복원                                │
│                                                             │
│  ③ 문서 클릭 (box mousedown)                                   │
│     │                                                        │
│     ├── LayoutBoxElement._onPlaceGunMouseDown                │
│     │   (box 자체의 mousedown 이벤트)                        │
│     ├── placeGunActive 가드 → 비활성이면 무시                │
│     ├── EditManager.handlePlaceGunMouseDown(box, event)      │
│     │   → PlaceGunController.handleBoxMouseDown(box, event)  │
│     ├── _findTargetInBox(box, nextItem)                      │
│     │   → box.contentType === 항목 contentType 매칭         │
│     │   → 매칭 없으면 return (항목 소비 안 함, no-op)        │
│     ├── event.preventDefault() + stopPropagation()          │
│     ├── manager._consumePlaceGunItem()                      │
│     │   → 맨 위 항목 제거 + placeGunChange 디스패치          │
│     ├── _injectItem(item, target)                           │
│     │   ├── text → paragraph.data = {...data, content}      │
│     │   │        + model.textContent = item.content.body     │
│     │   │        + markStructureChangedAndRender()           │
│     │   └── image → image.url = subType별 URL               │
│     └── manager._suppressLayoutClick()                      │
│         → 후속 클릭 이벤트가 선택을 해제하지 않도록 방지      │
│                                                             │
│  ④ 항목 모두 소진                                             │
│     ├── _consumePlaceGunItem() 후 items.length === 0         │
│     ├── _syncPlaceGunController() → detach() + 커서 복원    │
│     └── placeGunChange 이벤트                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 매칭 요소 찾기

`LayoutBoxElement`의 `mousedown` 이벤트 핸들러(`_onPlaceGunMouseDown`)가 `placeGunActive`일 때 `EditManager.handlePlaceGunMouseDown`을 호출한다. box 자체의 이벤트이므로 `event.target`이 shadow DOM 내부 요소여도 `this`(box)가 항상 정확하다.

`_findTargetInBox(box, item)`은 box의 `contentType`과 항목의 contentType을 매칭한다.

| 항목 contentType | box contentType | 매칭 대상 자식 요소 |
|------------------|-----------------|---------------------|
| `'text'` | `'paragraph'` | `LayoutParagraphElement` |
| `'image'` | `'image'` | `LayoutImageElement` |

**매칭되지 않는 경우**:
- box가 lock되어 있음 → 건너뜀
- box의 `contentType`이 `null`(빈 box) 또는 항목 contentType과 불일치 → 건너뜀
- 이벤트 경로에 box가 없음 → `null` 반환 (no-op)

### 4.3 데이터 주입

매칭된 요소에 항목의 데이터를 주입한다. 새 요소를 생성하지 않는다.

| 항목 contentType | 주입 동작 |
|------------------|-----------|
| `'text'` | `paragraph.data = {...currentData, content: item.content.body}` + `model.textContent = item.content.body` + `markStructureChangedAndRender()` |
| `'image'` | `image.url = subType === 'ad' ? /storage/ad/{uid}?variant=work : /storage/image/{uid}?variant=work` (url setter가 자동으로 `render()` 호출) |

`content`는 객체이며, text 항목은 `ArticleContent`(`{uid, title, body}`)에서 `body`를 추출하여 paragraph에 주입한다. image 항목은 `ImageContent`(`{uid, caption}`)에서 `uid`를 추출하고 `subType`으로 URL 패턴을 결정한다.

`model.textContent`를 직접 설정하는 이유: `paragraph.data` setter는 `_sourceContent`만 설정하고 `layout()` → `_layoutStructure()`를 호출하지만, model이 이미 존재하면 `_layoutStructure()`가 `model.textContent`(이전 텍스트)를 사용하고 `_sourceContent`를 무시한다. 따라서 model의 textContent를 직접 갱신해야 주입된 content가 렌더링에 반영된다.

주입 후 부모 box의 `requestRerenderAffectedParagraphs()`를 호출하여 오버랩된 다른 paragraph가 갱신되도록 한다.

---

## 5. 커서 변경

Place Gun이 활성 상태면 `<x-layout-document>`의 `style.cursor`가 `'copy'`로 설정된다. 비활성(비었거나 일시정지)이면 빈 문자열로 복원된다.

---

## 6. 이벤트

`placeGunChange` 이벤트 명세는 `EDITING_EVENTS.md`를 참조한다.

---

## 7. 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/edit/edit-manager.ts` | `EditManager`: Place Gun 상태(`_placeGunItems`, `_placeGunPaused`), 공개 API(`loadPlaceGun`, `unloadPlaceGun`, `removePlaceGunItem`, `reorderPlaceGunItems`, `setPlaceGunPaused`), `_consumePlaceGunItem`, `_syncPlaceGunController`, `_dispatchPlaceGunChange` |
| `src/edit/place-gun-controller.ts` | `PlaceGunController`: `handleBoxMouseDown` (box에서 호출), 매칭된 paragraph/image 요소에 데이터 주입, 커서 변경 |
| `src/components/layout/box.element.ts` | `LayoutBoxElement`: `_onPlaceGunMouseDown` mousedown 리스너, `placeGunActive` 시 `EditManager.handlePlaceGunMouseDown` 위임 |
| `src/types/edit/place-gun.type.ts` | `PlaceGunContentType`, `PlaceGunItem`, `PlaceGunChangeEventDetail` 타입 정의 |

---

## 8. 주의사항

- **인쇄 모드 차단**: `loadPlaceGun()`은 인쇄 모드에서 no-op이다. `_isPrint` 가드로 차단.
- **드래그 아님**: Place Gun은 단일 클릭으로 배치한다. 드래그(영역 그리기)는 `InsertController`의 역할이다.
- **새 요소 생성 안 함**: 클릭 위치에 매칭되는 기존 paragraph/image 요소가 있으면 그 요소에 데이터를 주입한다. 매칭되는 요소가 없으면 항목을 소비하지 않고 no-op로 종료한다. 새 박스/요소를 생성하지 않는다.
- **매칭 규칙**: text 항목은 `contentType === 'paragraph'`인 box의 paragraph 자식에만 매칭되고, image 항목은 `contentType === 'image'`인 box의 image 자식에만 매칭된다. 빈 box(`contentType === null`)에는 매칭되지 않는다.
- **항목 소비는 매칭 시에만**: 매칭되는 요소를 찾은 후에만 `_consumePlaceGunItem()`이 호출된다. 매칭 실패 시 항목은 리스트에 그대로 남는다.
- **컨트롤러 자동 관리**: `loadPlaceGun`/`unloadPlaceGun`/`setPlaceGunPaused`가 자동으로 `PlaceGunController`를 attach/detach한다. 직접 `attach()`/`detach()`를 호출할 필요가 없다.
- **클릭 억제**: 배치 후 `manager._suppressLayoutClick()`을 호출하여 후속 클릭이 빈 공간 클릭으로 처리되어 선택이 해제되는 것을 방지한다.