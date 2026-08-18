# layout-element Place Gun 상세 명세

> **엔진 마이그레이션**: `GridCalculator` → `GridCalculatorEngine`, ppm 접근 방식 변경. 상세는 [ENGINE.md](./ENGINE.md) 참고.

> 작성 기준: `src/edit/edit-manager.ts`, `src/edit/place-gun-controller.ts`, `src/types/edit/place-gun.type.ts`
>
> 본 문서는 `layout-element` 라이브러리의 Place Gun 기능(장전, 클릭 배치, 일시정지, 순서 변경)의 공개 API, 컨트롤러 아키텍처, 배치 알고리즘, 이벤트를 상세히 기술한다.

---

## 1. 개요 (Overview)

Place Gun은 InDesign의 "Place Gun" 개념을 차용한 기능으로, 여러 컨텐츠 항목을 메모리에 장전(Load)한 뒤 문서 표면에서 클릭할 때마다 장전된 순서대로 하나씩 배치한다.

- **장전 가능한 컨텐츠**: `text`(단락), `image`(이미지), `element`(요소 패턴), `style`(스타일 패턴)
- **배치 방식**: 단일 클릭(드래그 아님). 클릭 위치에 이미 매칭되는 요소가 있으면 그 요소에 데이터를 주입한다. element 항목은 새 box를 생성하여 주입한다.
- **매칭 규칙**: 클릭 위치의 box 자식이 항목 contentType과 일치해야 함
  - `text` 항목 → box의 `contentType`이 `'paragraph'`인 자식 paragraph
  - `image` 항목 → box의 `contentType`이 `'image'`인 자식 image
  - `element` 항목 → 클릭한 box의 부모에 새 box 생성하여 주입 (기존 요소 매칭 없음)
  - `style` 항목 → 클릭한 box 내의 paragraph에 스타일 주입
- **비매칭 시 no-op**: 매칭되는 요소가 없으면 항목을 소비하지 않고 아무 동작도 하지 않는다 (element 항목은 매칭 없이 항상 새 box를 생성하므로 제외)
- **일시정지**: 장전된 항목이 있어도 배치를 일시정지할 수 있음
- **순서 변경**: 외부 UI에서 리스트 재정렬 (EditManager API로 반영)
- **취소**: 항목 삭제, 전체 비우기

Place Gun이 활성 상태(항목 ≥ 1, 일시정지 아님)이면 문서 커서가 `copy`로 변경되고, 문서 클릭 시 맨 위 항목이 배치된다.

### 1.1 컨트롤러 아키텍처

```
┌─────────────────────────────────────────────────────────────────────┐
│ <x-layout-document>                                                  │
│                                                                      │
│  EditManager (per-document instance)                                             │
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
const manager = layoutDocEl.editManager;

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
export type PlaceGunContentType = 'text' | 'image' | 'element' | 'style';
```

### 3.2 `PlaceGunSubType`

```typescript
export type PlaceGunSubType = 'article' | 'image' | 'ad' | 'element' | 'style';
```

이미지/광고의 URL 패턴을 결정한다.

### 3.3 `ArticleContent` / `ImageContent`

```typescript
export type ArticleContent = {
  uid: string;   // 기사 고유 식별자
  title: string; // 기사 제목
  body: string;   // 기사 본문 텍스트
  byline: string; // 기자명(검별). 빈 문자열일 수 있다.
};

export type ImageContent = {
  uid: string;      // 이미지/광고 고유 식별자
  caption: string;   // 이미지/광고 설명 (캡션)
  url: string;       // 이미지/광고 접근 URL
  width: number;     // 원본 이미지 너비 (픽셀). 주입 시 ImageData.originalWidth로 전달
  height: number;    // 원본 이미지 높이 (픽셀). 주입 시 ImageData.originalHeight로 전달
  dpi: number;       // 이미지 해상도 (DPI). 주입 시 ImageData.dpi로 전달
};
```

`contentType === 'text'`인 항목의 `content`는 `ArticleContent`, `contentType === 'image'`인 항목의 `content`는 `ImageContent`, `contentType === 'element'`인 항목의 `content`는 `ElementPatternContent`, `contentType === 'style'`인 항목의 `content`는 `StylePatternContent`이다.

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
| `contentType` | `'text' \| 'image' \| 'element' \| 'style'` | 컨텐츠 종류 (배치 매칭용) |
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
│     │   ├── text → paragraph.content = item.content.body      │
│     │   │        + EditManager.notifyTextChange(paragraph)    │
│     │   ├── image → image.url = subType별 URL               │
│     │   │        + box.contentUid = uid → boxPropertyChange  │
│     │   ├── element → container.appendChild(newBox)          │
│     │   │        + EditManager._dispatchLayoutAdd            │
│     │   └── style → paragraph.data = {...}                   │
│     │            + EditManager.notifyTextChange(paragraph)   │
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

### 4.3 기사(text) 데이터 주입

기사 항목(`contentType === 'text'`)은 클릭한 box의 역할에 따라 3가지 케이스로 분기한다.

#### 케이스 1: 조상에 `group-article` box가 있는 경우

클릭한 box의 조상 중 `role === 'group-article'`인 box가 있으면, 그 group-article 내에서 title/byline/body box를 찾아 각각 주입한다.

| 대상 box (role) | 주입 내용 | contentUid |
|-----------------|----------|-----------|
| group-article 내 `role === 'title'` box의 paragraph | `article.title` | 기사 UID |
| group-article 내 `role === 'byline'` box의 paragraph | `article.byline` | 기사 UID |
| group-article 내 `role === 'body'` box의 paragraph | `article.body` | 기사 UID |

추가로 group-article box의 `groupMember` 배열에 기사 UID를 추가한다.

#### 케이스 2: 클릭한 box의 role이 `title`/`byline`/`body`인 경우

group-article 하위가 아니지만 box 자체의 role이 `title`/`byline`/`body`이면 그에 맞는 내용을 주입한다.

| box role | 주입 내용 | contentUid |
|----------|----------|-----------|
| `title` | `article.title` | 기사 UID |
| `byline` | `article.byline` | 기사 UID |
| `body` | `article.body` | 기사 UID |

#### 케이스 3: 그 외

box의 paragraph에 `article.body`를 주입하고, box의 `contentUid`에 기사 UID를 저장한다.

#### 주입 공통 동작

`paragraph.data` setter로 content를 설정하고, model이 있으면 `model.textContent`를 직접 갱신한 후 `markStructureChangedAndRender()`로 재렌더링한다. `model.textContent`를 직접 설정하는 이유: `paragraph.data` setter는 `_sourceContent`만 설정하고 `layout()`을 호출하지만, model이 이미 존재하면 `_layoutStructure()`가 `model.textContent`(이전 텍스트)를 사용하고 `_sourceContent`를 무시한다.

부모 box의 `requestRerenderAffectedParagraphs()`로 오버랩된 다른 paragraph를 갱신한다. `notifyTextChange()`로 `textChange` 이벤트가 발생하므로 호스트는 `documentData` 동기화와 undo/redo 히스토리 push를 수행할 수 있다. `box.contentUid` 설정 시 `boxPropertyChange` 이벤트도 발생한다.

### 4.4 이미지/광고(image) 데이터 주입

이미지/광고 항목(`contentType === 'image'`)은 클릭한 box의 역할에 따라 3가지 케이스로 분기한다. `ImageContent`의 `url`/`width`/`height`/`dpi` 필드를 사용해 이미지 요소에 데이터를 주입한다.

#### 케이스 1: 조상에 `group-image` box가 있는 경우

클릭한 box의 조상 중 `role === 'group-image'`인 box가 있으면, 그 group-image 내에서 image/caption box를 찾아 각각 주입한다.

| 대상 box (role) | 주입 내용 | contentUid |
|-----------------|----------|-----------|
| group-image 내 `role === 'image'` box의 image 요소 | `_applyImageToElement(image, imageBox)` (url, originalWidth, originalHeight, dpi, objectFit='cover') | UID |
| group-image 내 `role === 'caption'` box의 paragraph | `image.caption` | UID |

추가로 group-image box의 `groupMember` 배열에 UID를 추가한다.

#### 케이스 2: 클릭한 box의 role이 `image` 또는 `caption`인 경우

group-image 하위가 아니지만 box 자체의 role이 `image`/`caption`이면 그에 맞는 내용을 주입한다.

| box role | 주입 대상 | 주입 내용 | contentUid |
|----------|----------|----------|-----------|
| `image` | image 요소 | `_applyImageToElement(image, box)` | UID |
| `caption` | paragraph 요소 | `image.caption` | UID |

#### 케이스 3: 그 외

box 내의 image 요소가 있으면 `_applyImageToElement`로 이미지 데이터를 주입하고, paragraph 요소가 있으면 `image.caption`을 주입한다. box의 `contentUid`에 UID를 저장한다.

#### 주입 공통 동작

이미지 주입은 `_applyImageToElement(imageEl, image, box)` 헬퍼를 사용한다. 이 헬퍼는 `imageEl.data`를 `{ ...data, dpi, url, originalWidth, originalHeight, objectFit: 'cover' }`로 갱신한다 — 단순히 `url` setter만 호출하는 것이 아니라 원본 이미지 픽셀 크기(`originalWidth`/`originalHeight`)와 `dpi`, `objectFit: 'cover'`를 함께 설정하여 `LayoutImageElement.render()`에서 `_computeObjectFit`이 자동으로 크롭 영역을 계산하도록 한다. 이후 `void imageEl.render()`로 렌더링을 트리거한다.

paragraph 주입은 `_injectText` 헬퍼를 사용한다. 부모 box의 `requestRerenderAffectedParagraphs()`로 오버랩된 다른 paragraph를 갱신한다. 이미지 주입(`_applyImageToElement`) 자체는 EditManager 이벤트를 발생시키지 않지만, 호출부에서 `box.contentUid = uid`를 설정해 `boxPropertyChange` 이벤트가 발생하므로 호스트는 `documentData` 동기화와 undo/redo 히스토리 push를 수행할 수 있다.

### 4.5 요소 패턴(element) 주입

요소 패턴 항목(`contentType === 'element'`)은 클릭한 box의 부모 컨테이너에 새 box를 생성하여 주입한다. `ElementPatternContent`의 `boxData`와 `position`을 사용한다.

주입 완료 후 `EditManager._dispatchLayoutAdd({ element, container, source: 'insert' })`로 `layoutAdd` 이벤트를 발생시킨다. 호스트(예: `LayoutEditor`)는 이 이벤트를 구독하여 `documentData` 동기화와 undo/redo 히스토리 push를 수행한다.

#### 컨테이너 찾기: `_findPatternContainer`

`_findPatternContainer(clientX, clientY, position, patternWidth, patternHeight)`는 클릭 위치에서 요소 패턴을 주입할 컨테이너를 찾는다. `elementsFromPoint`로 클릭 위치의 요소 목록을 가져와, box-only 컨테이너(비-box 자식이 없는 box) 또는 `<x-layout-td>` 셀을 찾는다. 찾지 못하면 document로 폴백한다. `editableRootId`가 설정된 경우 root box 내부의 컨테이너만 허용한다.

| 컨테이너 | static 모드 | absolute 모드 |
|----------|-------------|---------------|
| `<x-layout-td>` | `items.length === 0`일 때만 허용, 패턴이 TD 그리드(1컬럼) 안에 들어와야 함 | 제한 없이 허용 |
| `<x-layout-box>` | 비-box 자식이 없어야 하며, 패턴이 box 그리드 안에 들어와야 함 | 비-box 자식이 없어야 함 |

**static 모드 그리드 containment 검증**: `position === 'static'`일 때는 추가로, 클릭 좌표 + 패턴 크기(`patternWidth` 컬럼 스팬, `patternHeight` 라인 수)로 계산한 요소 영역이 후보 컨테이너의 컬럼/라인 그리드 안에 완전히 들어오는지 `staticGridContains()`로 검증한다. 요소가 후보 컨테이너의 컬럼 수나 라인 수를 초과하면 더 바깥 컨테이너로 폴백한다. 이는 InsertController의 static 모드 containment 검증과 동일한 로직이며, absolute 모드의 네 꼭짓점 containment와 대응된다.

**TD 내 static 패턴 주입**: 컨테이너가 `<x-layout-td>`이고 `position === 'static'`이면, 최종 `boxData.left = 0`, `boxData.top = 0`, `boxData.width = 1`, `boxData.height = 1`로 설정되어 셀 전체를 채운다. absolute 모드로는 지정된 `boxData.left`/`boxData.top`(mm)과 원래 크기로 주입된다.

#### element 패턴 미리보기 (preview)

Place Gun이 활성 상태이고 다음으로 쏠 항목의 `contentType === 'element'`일 때, 마우스 커서를 따라 점선 박스 미리보기가 표시된다. Insert 모드의 미리보기와 동일한 스타일(`2px dashed #1a73e8`, `rgba(26, 115, 232, 0.1)` 배경, `Z_INDEX_INSERT_PREVIEW`)을 사용한다.

- **mousemove**: `PlaceGunController._onMouseMove`가 마우스 위치에서 배치될 컨테이너(`_findPatternContainer`)와 좌표를 계산하여 preview 박스의 화면 위치/크기를 갱신한다. 동시에 `_updateHighlight`로 배치될 부모 컨테이너에 `reparent-target` 속성(주황색 `#ff9800` 2px 테두리)을 설정하여 시각적으로 표시한다. 이전 하이라이트 대상과 다르면 이전 속성을 제거하고 새 컨테이너에 설정한다.
- **absolute 패턴**: 마우스 위치를 root 요소 기준 mm 좌표로 변환 → 점선 박스 좌상단을 마우스 위치로, 크기는 `boxData.width`/`height`(mm)를 `manager.docEl.ppm × scale`로 화면 px 변환.
- **static 패턴**: root 요소의 컬럼/라인 그리드에 스냅. `columnCoords[startCol].x1` ~ `columnCoords[endCol].x2`로 스냅된 x범위, `줄 수 × lineHeight`로 높이를 화면 px로 변환. 컬럼 span은 `boxData.width`(컬럼 개수)를 사용하며 컨테이너의 컬럼 수를 초과하지 않도록 클램핑. 라인 상한은 `containerLineCount - boxData.height`로 클램핑하여 preview가 root 하단을 넘지 않도록 함.
- **root 요소 기준**: preview는 `editableRootId`가 지정한 박스(없으면 document)의 그리드에 스냅한다. 특정 박스 기준이 아니므로 마우스가 박스 경계를 넘어도 자유롭게 따라간다.
- **표시 조건**: `placeGunActive === true` && 다음 항목 `contentType === 'element'` && 마우스 커서가 `<x-layout-document>` 영역 내 && `_findPatternContainer`가 컨테이너를 반환. 항목이 없거나 element가 아니거나 커서가 문서 밖이거나 컨테이너를 찾지 못하면 preview 및 하이라이트 제거.
- **제거 시점**: `detach()`(Place Gun 비활성화), `handleBoxMouseDown`/`handleDocumentMouseDown` 배치 직전, mousemove에서 조건 불만족 시. preview 제거와 하이라이트 제거는 항상 함께 수행된다.

#### absolute 패턴

클릭한 위치를 부모 컨테이너 기준 mm 좌표로 변환하여 `boxData.left`/`boxData.top`으로 설정한다. `manager.docEl.ppm`으로 픽셀→mm 변환을 수행한다.

#### static 패턴

클릭한 위치에서 컬럼 인덱스와 줄 수를 계산한다. 부모의 `GridCalculatorEngine`에서 `columnCoords`와 `lineHeight`를 가져와:
1. 클릭 x 좌표가 어느 컬럼에 속하는지 인덱스(`left`) 계산
2. 클릭 y 좌표가 컬럼 상단에서 몇 줄째인지(`top`) 계산: `Math.round((y - columnY1) / lineHeight)`

계산된 `left`/`top`으로 `boxData`를 갱신하여 새 box를 생성한다.

### 4.6 스타일 패턴(style) 주입

스타일 패턴 항목(`contentType === 'style'`)은 클릭한 box 내의 첫 번째 paragraph를 찾아 `StylePatternContent`의 `textStyle`/`paragraphStyle`을 기존 스타일에 덮어쓴다. `paragraph.data` setter로 갱신 후 `markStructureChangedAndRender()`로 재렌더링한다. 이후 `EditManager.notifyTextChange(paragraph)`로 `textChange` 이벤트를 발생시켜 호스트가 `documentData` 동기화와 undo/redo 히스토리 push를 수행하도록 한다.

---

## 5. 커서 변경

Place Gun이 활성 상태면 이 컨트롤러가 속한 `EditManager`가 관리하는 `<x-layout-document>` 요소의 `style.cursor`가 `'copy'`로 설정된다. 비활성(비었거나 일시정지)이면 빈 문자열로 복원된다.

`PlaceGunController`는 per-document `EditManager`에 귀속되므로, 다른 문서 요소의 커서는 변경하지 않는다 — 다른 문서는 자신의 `EditManager`/`PlaceGunController` 인스턴스가 독립적으로 커서를 관리한다.

---

## 6. 이벤트

`placeGunChange` 이벤트 명세는 `EDITING_EVENTS.md`를 참조한다.

---

## 7. 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/edit/edit-manager.ts` | `EditManager`: Place Gun 상태(`_placeGunItems`, `_placeGunPaused`), 공개 API(`loadPlaceGun`, `unloadPlaceGun`, `removePlaceGunItem`, `reorderPlaceGunItems`, `setPlaceGunPaused`), `_consumePlaceGunItem`, `_syncPlaceGunController`, `_dispatchPlaceGunChange` |
| `src/edit/place-gun-controller.ts` | `PlaceGunController`: `handleBoxMouseDown` (box에서 호출), 기사 3케이스 분기 주입(`_injectArticle`), 이미지 주입(`_injectImageOrAd` → `_applyImageToElement`), 요소 패턴 주입(`_injectElementPattern`), 스타일 패턴 주입(`_injectStylePattern`), 커서 변경, element 패턴 미리보기(`_onMouseMove`/`_createPreview`/`_updatePreview`/`_removePreview`) |
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
- **element 패턴 미리보기**: Place Gun 활성 상태에서 다음 항목이 `contentType === 'element'`일 때만 마우스 커서를 따라 점선 박스가 표시된다. text/image/style 항목일 때는 preview가 표시되지 않는다. 일시정지(`placeGunPaused === true`) 시에는 `placeGunActive === false`가 되어 preview도 제거된다.