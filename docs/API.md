# API Reference — Vanilla JS

이 문서는 `layout-element` 패키지의 **바닐라 JavaScript API**(Custom Element 기반)에 대한
전체 레퍼런스입니다. 모든 측정은 **mm(밀리미터)** 단위이며, 픽셀 변환 비율(`ppm`)은 런타임에
`GridCalculator.ppm`을 통해 측정됩니다.

- **두 가지 빌드 출력**을 사용합니다:
  - **IIFE 번들**(`dist/layout-element.iife.js`): `LayoutElement` 전역 네임스페이스로 노출
  - **ESM 진입점**(`layout-element`): `import { ... } from 'layout-element'`
- **React** 레이어는 별도 문서 [`REACT_COMPONENT.md`](./REACT_COMPONENT.md)를 참고하세요.

---

## 목차

1. [빠른 시작](#빠른-시작)
2. [Custom Elements](#custom-elements)
   - [`<x-layout-document>`](#x-layout-document)
   - [`<x-layout-box>`](#x-layout-box)
   - [`<x-layout-paragraph>`](#x-layout-paragraph)
   - [`<x-layout-image>`](#x-layout-image)
   - [`<x-layout-table>`](#x-layout-table)
   - [`<x-layout-tr>`](#x-layout-tr)
   - [`<x-layout-td>`](#x-layout-td)
    - [`<x-layout-column>`](#x-layout-column)
    - [`<x-layout-guide-column>`](#x-layout-guide-column)
   - [`<x-layout-cursor>`](#x-layout-cursor)
   - [`<x-layout-selection>`](#x-layout-selection)
3. [Core](#core)
   - [`GridCalculator`](#gridcalculator)
   - [`TextLayoutEngine`](#textlayoutengine)
   - [`Rect`](#rect)
4. [Resource Managers](#resource-managers)
   - [`ColorRegistry`](#colorregistry)
   - [`FontLoader`](#fontloader)
5. [Edit](#edit)
   - [`EditManager`](#editmanager)
   - [`TextEditController`](#texteditcontroller)
   - [`TextEditCoordinateMapper`](#texteditcoordinatemapper)
    - [`InsertController`](#insertcontroller)
    - [`LayoutEditController`](#layouteditcontroller)
    - [`PlaceGunController`](#placeguncontroller)
    - [`TableKeyboardController`](#tablekeyboardcontroller)
    - [`TableStructureEditor`](#tablestructureeditor)
6. [Types](#types)
   - [Layout](#layout-types)
   - [Style](#style-types)
   - [Print](#print-types)
   - [Edit](#edit-types)
7. [Constants](#constants)
8. [Utilities](#utilities)
   - [`flipLayoutData`](#fliplayoutdata)
9. [Examples](#examples)
10. [이벤트 레퍼런스](#이벤트-레퍼런스)

---

## 빠른 시작

```html
<!DOCTYPE html>
<html>
<head>
  <script src="./dist/layout-element.iife.js"></script>
</head>
<body>
  <x-layout-document id="doc"></x-layout-document>
  <script>
    // 1. 리소스 매니저 초기화 (필수)
    await LayoutElement.ColorRegistry.getInstance().init();
    await LayoutElement.FontLoader.getInstance().init();

    // 2. 데이터 주입
    const doc = document.getElementById('doc');
    doc.data = {
      width: 210, height: 297,        // A4 (mm)
      columns: 6, gap: 3,             // 6-컬럼 그리드
      paddingTop: 10, paddingRight: 10,
      paddingBottom: 10, paddingLeft: 10,
      paragraphStyle: { lineGap: 1.2, textAlign: 'justify' },
      textStyle: { fontFamily: 'Myoungjo', fontSize: 4, color: 'black' },
      children: [
        {
          type: 'box',
          left: 0, top: 0, width: 3, height: 30,
          children: { type: 'text', content: '제목', textStyle: { fontSize: 8 } },
        },
      ],
    };
  </script>
</body>
</html>
```

> **ESM 사용 시**:
> ```ts
> import {
>   LayoutDocumentElement, ColorRegistry, FontLoader,
> } from 'layout-element';
> ```

---

## Custom Elements

모든 요소는 Shadow DOM(`mode: 'open'`)을 사용하며, 자동 등록을 위해 모듈을 import만 하면
`customElements.define`이 호출됩니다. React 환경이 아니라면 `useLayoutElement` 훅이 없으므로
직접 `<x-layout-document>` 마크업을 사용하세요.

### `<x-layout-document>`

**루트 컨테이너**. 문서 전체의 사이즈, 컬럼 그리드, 기본 스타일을 정의하고 자식 박스 트리를
조율합니다.

#### Class: `LayoutDocumentElement`

```ts
/**
 * 문서 루트 요소. `<x-layout-document>` 커스텀 엘리먼트.
 *
 * `DocumentData`를 받아 전체 렌더링 파이프라인을 조율한다.
 *
 * 렌더링 파이프라인:
 * 1. `layout()` (동기) — DOM 트리 구축, 자식 박스 생성, `GridCalculator` 생성
 * 2. `render()` (비동기) — 이미지 로딩 후 자식 박스 렌더링
 *
 * @example
 * const doc: LayoutDocumentElement = document.querySelector('x-layout-document')!;
 * doc.data = {
 *   width: 210, height: 297,
 *   columns: 6, gap: 3,
 *   paragraphStyle: { lineGap: 1.2 },
 *   textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
 *   children: [/* ... *\/],
 * };
 */
class LayoutDocumentElement extends HTMLElement
```

#### 메서드

| 메서드 | 시그니처 | 설명 |
|---|---|---|
| `layout()` | `(): this \| null` | DOM 트리/스타일/가이드 컬럼을 재구성. `connectedCallback`에서 자동 호출. |
| `render()` | `(): Promise<this \| null>` | 자식 박스를 z-index 역순으로 비동기 렌더링. `layout()` 완료 후 호출. |
| `appendChild<T>(node)` | `(node: T): T` | 박스/단락/이미지 자식에 `InheritStyle` 자동 전파. |
| `flipLayout(options)` | `(options: FlipLayoutOptions): void` | 문서 또는 지정된 박스의 **하위 요소** 배치를 좌우/상하/상하좌우 반전. `targetId` 지정 시 해당 박스가 root, 생략 시 문서가 root. root 자체(위치/보더/패딩)는 유지되고 하위만 반전. 반전 전 편집 상태(포커스, 선택)를 해제한 후 `data` setter 적용. |

#### 데이터 프로퍼티 (setter / getter)

| 이름 | 타입 | 단위 | 설명 |
|---|---|---|---|
| `data` | `DocumentData` | — | 한 번에 모든 필드 갱신. 자식 박스는 ID 기반 diff로 재구성 (같은 ID는 in-place 업데이트, 새 ID는 생성, 없는 ID는 제거). `data.id`가 전달되면 요소의 `id`에 반영. |
| `id` | `string` | — | 요소 고유 식별자. `connectedCallback` 시점에 `id`가 없으면 `genUUID()`로 자동 할당. `data.id` setter로도 갱신 가능. |
| `width` | `number` | mm | 문서 너비. |
| `height` | `number` | mm | 문서 높이. |
| `paddingTop` | `number` | mm | 상단 여백. |
| `paddingRight` | `number` | mm | 우측 여백. |
| `paddingBottom` | `number` | mm | 하단 여백. |
| `paddingLeft` | `number` | mm | 좌측 여백. |
| `columns` | `number \| number[]` | — | 균등 분할 개수 또는 명시적 컬럼 폭 배열. |
| `gap` | `number \| number[]` | mm | 균등 간격 또는 명시적 간격 배열. |
| `paragraphStyle` | `ParagraphStyle` | — | 문서 전역 문단 스타일. |
| `textStyle` | `TextStyle` | — | 문서 전역 텍스트 스타일. |
| `innerWidth` | `number` (get) | mm | `width - paddingLeft - paddingRight`. |
| `innerHeight` | `number` (get) | mm | `height - paddingTop - paddingBottom`. |

#### 게터 (계산 프로퍼티)

| 이름 | 타입 | 설명 |
|---|---|---|
| `items` | `LayoutBoxElement[]` | 직속 자식 박스 (`<x-layout-box>`) 배열. |
| `model` | `GridCalculator \| undefined` | 컬럼 그리드 계산기. |
| `visibleGuide` | `boolean` | 가이드 컬럼 표시 여부. |
| `type` | `'document'` | 타입 리터럴. |
| `zIndex` | `number` | 항상 0. |

#### 가시성 / 인쇄 모드

| 이름 | 타입 | 설명 |
|---|---|---|
| `visibleGuide` (set) | `boolean` | 가이드 컬럼의 표시 여부 토글. |
| `printPostData` (get) | `PrintPostData[]` | 인쇄 후처리용 위치/데이터 배열. 인쇄 모드에서 사용. 자식 요소를 z-index **오름차순**(낮은 것부터)으로 재귀 수집하여 반환. PDF 콘텐츠 스트림은 나중에 추가된 것이 위에 렌더링되므로, CSS z-index 동작(낮은 것이 먼저 그려지고 높은 것이 위에 덮임)과 일치함. |

#### 인쇄 모드 동작

- `window.matchMedia("print").matches`가 `true`이면 `connectedCallback`은 `id` 자동 할당 직후 즉시 리턴 (`layout()`/`render()` 생략).
- 사용자가 `data`를 직접 주입한 뒤 `layout()`과 `render()`를 수동 호출해야 함.
- 편집 기능(`editableLayout`, `editableText`)은 인쇄 모드에서 완전히 차단됨.

#### 예제

```ts
// 1. 컬럼 수 동적 변경
doc.columns = 5;
doc.gap = 4;

// 2. 패딩 변경
doc.paddingTop = 15;

// 3. 자식 직접 추가
const box = document.createElement('x-layout-box') as LayoutBoxElement;
  box.data = {
    type: 'box', left: 0, top: 0, width: 2, height: 10,
    children: { type: 'text', content: 'Hello' },
  };
doc.appendChild(box);

// 4. 인쇄 모드 후처리 데이터 수집
const postData = doc.printPostData;

// 5. 배치 반전
doc.flipLayout({ axis: 'horizontal' });                           // 문서의 하위 박스들을 좌우 반전
doc.flipLayout({ axis: 'vertical' });                             // 문서의 하위 박스들을 상하 반전
doc.flipLayout({ axis: 'both' });                                 // 180도 회전
doc.flipLayout({ axis: 'horizontal', targetId: 'box-42' });       // box-42의 하위 요소들만 좌우 반전
```

---

### `<x-layout-box>`

**위치 지정 가능한 컨테이너**. 컬럼 그리드(`position: 'static'`) 또는 mm 좌표
(`position: 'absolute'`)로 배치되며, 자식으로 여러 박스(`BoxData[]`) 또는 하나의 콘텐츠 요소(`ParagraphData`, `TextData`, `ImageData`)를 가질 수 있습니다. 박스 자식과 콘텐츠 자식을 같은 배열에 섞을 수 없습니다.

#### Class: `LayoutBoxElement`

```ts
/**
 * 위치 지정 가능한 컨테이너. `<x-layout-box>` 커스텀 엘리먼트.
 *
 * `position` 값에 따라 `left`/`width` 의미가 달라진다:
 * - `'static'`: `left` = 컬럼 인덱스, `width` = 컬럼 span
 * - `'absolute'`: mm 좌표
 *
 * @example
 * // 그리드 모드: 1번 컬럼부터 3개 컬럼 차지
 * const box = document.createElement('x-layout-box') as LayoutBoxElement;
 * box.data = {
 *   type: 'box', position: 'static', left: 1, top: 0, width: 3, height: 10,
 *   children: { type: 'paragraph', content: '본문' },
 * };
 */
class LayoutBoxElement extends HTMLElement
```

#### 메서드

| 메서드 | 시그니처 | 설명 |
|---|---|---|
| `layout()` | `(): void` | 좌표/스타일/테두리/상속 스타일 재계산. `data` setter에서 자동 호출. |
| `render()` | `(): Promise<void>` | 자식 박스를 z-index 역순으로 비동기 렌더링. |
| `appendChild<T>(node)` | `(node: T): T` | 자식에 `InheritStyle` 자동 전파 (paragraph는 텍스트 영역). |
| `convertPosition(target)` | `(target: 'static' \| 'absolute'): void` | 좌표계를 변환 (예: 드래그 중 자동 호출). |
| `requestRerenderAffectedParagraphs()` | `(): void` | 오버랩 영향 단락 즉시 재렌더링. |

#### 데이터 프로퍼티 (setter / getter)

| 이름 | 타입 | 단위 | 의미 |
|---|---|---|---|
| `data` | `BoxData` | — | 한 번에 갱신. 자식은 ID 기반 diff로 재구성 (같은 ID는 in-place 업데이트, 새 ID는 생성, 없는 ID는 제거). |
| `left` | `number` | mm (static: 컬럼 인덱스) | 좌측 위치. |
| `top` | `number` | mm | 상단 위치. |
| `width` | `number` | mm (static: 컬럼 수) | 너비. |
| `height` | `number` | mm (static: 줄 수) | 높이. |
| `position` | `'static' \| 'absolute'` | — | 배치 모드. |
| `zIndex` | `number` | — | 렌더링 순서. |
| `backgroundColor` | `string \| undefined` | — | 배경색. `ColorRegistry`에 등록된 CMYK 색상 이름만 사용 가능. |
| `backgroundOpacity` | `number \| undefined` | 0~1 | 배경색 투명도. CSS `opacity`와 동일 범위. 생략 시 1(불투명). |
| `borderTopWidth` | `number` | mm | 상단 테두리 두께. |
| `borderRightWidth` | `number` | mm | 우측 테두리 두께. |
| `borderBottomWidth` | `number` | mm | 하단 테두리 두께. |
| `borderLeftWidth` | `number` | mm | 좌측 테두리 두께. |
| `borderStyle` | `'solid' \| 'dotted' \| 'dashed'` | — | 테두리 스타일. |
| `borderColor` | `string \| undefined` | — | 테두리 색상. `ColorRegistry`에 등록된 CMYK 색상 이름만 사용 가능. |
| `paddingTop` | `number` | mm | 내부 상단 여백. |
| `paddingRight` | `number` | mm | 내부 우측 여백. |
| `paddingBottom` | `number` | mm | 내부 하단 여백. |
| `paddingLeft` | `number` | mm | 내부 좌측 여백. |
| `role` | `BoxRole` | — | 의미적 역할 (예: `'body'`, `'image'`, `'title'`). |
| `contentUid` | `string \| undefined` | — | 콘텐츠 외부 식별자(UID). 렌더링/레이아웃에 영향 없는 단순 메타정보. |
| `groupMember` | `string[]` | — | 그룹 멤버 ID 배열. |
| `priority` | `number` | — | 정렬 우선순위. |
| `lock` | `boolean` | — | 편집 잠금. |
| `editableLayout` | `boolean` | — | 레이아웃 편집 가능 여부. |
| `inheritStyle` (set) | `InheritStyle \| undefined` | — | 부모에서 전파받은 캐스케이드 스타일. |

#### 계산 게터

| 이름 | 타입 | 단위 | 설명 |
|---|---|---|---|
| `relLeft` | `number` | mm | 부모 기준 좌측 위치. |
| `relTop` | `number` | mm | 부모 기준 상단 위치. |
| `absLeft` | `number` | mm | 루트 기준 절대 좌측. |
| `absTop` | `number` | mm | 루트 기준 절대 상단. |
| `absWidth` | `number` | mm | 절대 너비 (그리드 모드는 컬럼 폭 합). |
| `absHeight` | `number` | mm | 절대 높이 (그리드 모드는 lineHeight × 줄 수). |
| `parentModel` | `GridCalculator \| undefined` | — | 부모 계산기. |
| `items` | `(Box \| Paragraph \| Image)[]` | — | 직속 자식 요소 배열. |
| `overlayElements` | `LayoutBoxElement[]` | — | 오버랩된 형제 박스들. |
| `contentType` | `'image' \| 'paragraph' \| null` | — | 자식이 1개일 때 그 타입. |
| `type` | `'box'` | — | 타입 리터럴. |

#### `data` setter 동작

- 모든 필드를 갱신하고 자식을 ID 기반 diff로 재구성합니다.
- 같은 `id`를 가진 기존 자식 요소는 `element.data = child`로 in-place 업데이트 (재생성 없음, 이미지 캐시 유지).
- 새 `id`를 가진 자식은 새로 생성하여 `appendChild`합니다.
- 새 `children`에 없는 `id`를 가진 기존 자식은 제거합니다.
- 자식 순서는 `appendChild`로 재배열합니다.
- `id`가 없는 자식은 항상 새로 생성됩니다 (안정적 식별자가 없음).
- `_rebuildingChildren` 플래그로 `MutationObserver`의 중복 트리거를 억제합니다.
- `lock: true`면 box 자신과 모든 자손이 편집에서 제외됩니다 (drag/resize/text edit 모두).
- `data.lock === true`일 때만 잠금으로 설정됩니다. `data.lock`이 `undefined` 또는 `false`이면 기존 잠금 상태와 무관하게 **잠금이 해제**됩니다. (role 전환 등으로 `setBoxLockDeep(false)`가 `delete next.lock`을 수행해 `data.lock`이 `undefined`가 되는 경우를 안전하게 처리하기 위함입니다.)

#### 예제

```ts
const box = document.createElement('x-layout-box') as LayoutBoxElement;
box.data = {
  type: 'box',
  position: 'static',
  left: 0, top: 0, width: 3, height: 12,
  role: 'body',
  borderColor: 'black',
  borderBottomWidth: 0.5,
  paddingLeft: 5,
  children: { type: 'text', content: '제목', textStyle: { fontSize: 8 } },
};
parentBox.appendChild(box);

// 그리드 → 절대 좌표 변환
box.convertPosition('absolute');
console.log(box.left, box.top, box.width, box.height); // mm 값
```

#### MutationObserver

`<x-layout-box>`는 `{ childList: true }` 옵션의 `MutationObserver`를 등록하여
`appendChild`/`removeChild`로 직접 자식을 조작해도 자동으로 `layout()` + `render()`를
수행합니다. `data` setter를 통한 재구축 시에는 `_rebuildingChildren` 플래그로
중복 호출을 방지합니다.

#### Attributes

| 속성 | 타입 | 설명 |
|---|---|---|
| `role` | `BoxRole` | `role` setter/getter와 동기화. |
| `content-uid` | `string` | `contentUid` setter/getter와 동기화. 단순 메타정보. |
| `group-member` | `string` | 쉼표 구분 그룹 멤버 ID. |
| `priority` | `number` | 우선순위. |
| `lock` | `boolean` | 잠금. |
| `selected` | `boolean` | 선택 상태 (편집기에서 토글). |
| `hovered` | `boolean` | 호버 상태. |
| `editable-layout` | `boolean` | 편집 가능 상태. |
| `border` | `boolean` | `borderColor` 설정 시 자동 부여. |

---

### `<x-layout-paragraph>`

**다중 컬럼 텍스트 영역**. `TextLayoutEngine`이 텍스트를 래핑하고, 각 컬럼을
`<x-layout-column>`으로 렌더링합니다. 오버플로우 발생 시 `render-error` 커스텀 이벤트를
디스패치합니다.

#### Class: `LayoutParagraphElement`

```ts
/**
 * 다중 컬럼 텍스트 영역. `<x-layout-paragraph>` 커스텀 엘리먼트.
 *
 * @example
 * const p = document.createElement('x-layout-paragraph') as LayoutParagraphElement;
 * p.data = {
 *   type: 'paragraph',
 *   content: '안녕하세요',
 *   column: 3, gap: 3,
 * };
 */
class LayoutParagraphElement extends HTMLElement
```

#### 메서드

| 메서드 | 시그니처 | 설명 |
|---|---|---|
| `layout()` | `(): void` | 모델/스타일 갱신. `data` setter에서 자동 호출. |
| `render()` | `(): void` | 텍스트 래핑 + 컬럼 DOM 갱신. 오버플로우 시 `render-error` 디스패치. |
| `markStructureChangedAndRender()` | `(): void` | 구조 변경 플래그 설정 후 `render()`. 외부 컨트롤러가 단락을 다시 그릴 때 사용. |

#### 데이터 프로퍼티

| 이름 | 타입 | 단위 | 설명 |
|---|---|---|---|
| `data` | `ParagraphData` | — | 한 번에 갱신. `content` 필드는 렌더링된 실제 텍스트를 반환 (편집 반영). |
| `content` | `string \| (string \| TextBlockData)[]` | — | 텍스트 콘텐츠 단독 갱신/조회. setter는 `_sourceContent`와 `model.textContent`(`string`인 경우)를 동시에 동기화한 뒤 `markStructureChangedAndRender()`로 재렌더링까지 수행. `data` setter는 이 setter를 거치지 않고 내부 필드를 직접 갱신 후 `layout()` 호출 (중복 렌더링 방지). |
| `column` | `number \| number[]` (via `data`) | — | 하위 컬럼 그리드 (생략 시 부모 상속). |
| `gap` | `number \| number[]` (via `data`) | mm | 하위 컬럼 간격. |
| `zIndex` | `number` (via `data`) | — | 렌더링 순서. |
| `overlapMode` (set) | `ParagraphOverlapMode` | — | 다른 paragraph가 이 paragraph를 감싼 박스를 텍스트 회피 대상으로 취급할지 제어 (`'box'` \| `'none'`). 기본값 `'box'`. `'none'`으로 설정하면 다른 paragraph가 이 박스와 겹쳐도 텍스트를 회피하지 않는다. 변경 시 부모 `requestRerenderAffectedParagraphs()` 호출. byline처럼 본문과 시각적으로 겹치되 텍스트 회피가 필요 없는 영역에 사용. |
| `textStyle` (set) | `TextStyle` | — | 글자 스타일. 변경 시 구조 재계산 + 재렌더링. 기존 값과 같으면 no-op. |
| `paragraphStyle` (set) | `ParagraphStyle` | — | 문단 스타일. 변경 시 구조 재계산 + 재렌더링. 기존 값과 같으면 no-op. |
| `editableText` (set) | `boolean` | — | 텍스트 편집 모드. 인쇄 모드에서는 무시됨. |
| `aiProcessing` (set) | `boolean` | — | AI 처리 중 오버레이 토글. `true` 시 반투명 오버레이 + shimmer/spinner 애니메이션 표시. `pointer-events: auto`로 마우스 이벤트 차단. `data` getter에 포함되지 않는 휘발성 속성 (저장/직렬화 시 제외). `layout()`/`render()` 미호출. |
| `inheritStyle` (set) | `InheritStyle \| undefined` | — | 상위 캐스케이드 스타일. |

#### 계산 게터

| 이름 | 타입 | 설명 |
|---|---|---|
| `model` | `TextLayoutEngine \| undefined` | 텍스트 래핑 엔진. |
| `columnEl` | `LayoutColumnElement[]` | 렌더링된 컬럼 요소들. |
| `textStyle` | `TextStyle` | 단락의 글자 스타일. |
| `paragraphStyle` | `ParagraphStyle` | 단락의 문단 스타일. |
| `relLeft` / `relTop` | `number` (mm) | 부모 기준 상대 위치. |
| `absLeft` / `absTop` | `number` (mm) | 루트 기준 절대 위치. |
| `absWidth` / `absHeight` | `number` (mm) | 절대 크기 (InheritStyle 기준). |
| `overlayElements` | `LayoutBoxElement[]` | 오버랩된 형제 박스. |
| `type` | `'paragraph'` | 타입 리터럴. |
| `zIndex` | `number` | 렌더링 순서. |
| `printPostData` | `PrintPostData<ParagraphData>[]` | 인쇄 후처리 데이터. paragraph rect + `chars` 배열 (글자별 rect/폰트/장평/색상). |

#### `render-error` 이벤트

```ts
paragraph.addEventListener('render-error', (e) => {
  const detail = (e as CustomEvent<{ id: string; type: 'text-overflow'; overflow: number }>).detail;
  console.warn(`Paragraph ${detail.id} 오버플로우 ${detail.overflow}자`);
});
```

#### `data` getter 동작

- `content` 필드는 렌더링된 실제 텍스트를 반환한다.
  - 모델이 생성된 후(렌더링 완료)에는 `model.textContent` 값을 사용한다.
  - 편집 모드에서 텍스트가 수정된 경우, 수정된 내용이 `content`에 반영된다.
  - 모델이 아직 없는 초기 상태에서는 setter로 전달된 원본 콘텐츠를 반환한다.

#### `data` setter 동작

- `content` 변경 → 전체 텍스트 재생성.
- 구조 변경이 감지되면 `_perfStructureChanged` 플래그가 켜져 다음 `render()`에서
  모든 `<x-layout-column>`을 다시 만듭니다. 변경이 없는 부분(같은 `data-source-offset`)은
  diff로 재사용됩니다.

#### 예제

```ts
const p = document.createElement('x-layout-paragraph') as LayoutParagraphElement;
p.data = {
  type: 'paragraph',
  content: [
    '첫 번째 단락. ',
    { content: '굵은 텍스트', textBlockStyle: { fontWeight: 700, fontSize: 5 } },
    ' 다시 기본 텍스트.',
  ],
  column: 3,
  gap: 3,
  textStyle: { fontSize: 4 },
};
box.appendChild(p);

// 텍스트 편집 활성화 (인쇄 모드 X)
p.editableText = true;
```

---

### `<x-layout-image>`

**이미지 크롭 렌더링**. `<canvas>`를 사용해 원본 이미지의 `(x, y, width, height)` 영역을
`dpi`로 mm 단위 변환하여 표시합니다. `overlapPadding`으로 텍스트 회피 영역을 지정할 수
있습니다.

#### Class: `LayoutImageElement`

```ts
/**
 * 이미지 크롭 렌더링. `<x-layout-image>` 커스텀 엘리먼트.
 *
 * @example
 * const img = document.createElement('x-layout-image') as LayoutImageElement;
 * img.data = {
 *   type: 'image',
 *   x: 0, y: 0, width: 800, height: 600,  // 픽셀
 *   dpi: 300,
 *   url: '/sample.png',
 *   overlapPadding: { top: 2, right: 5, bottom: 2, left: 5 },
 * };
 */
class LayoutImageElement extends HTMLElement
```

#### 메서드

| 메서드 | 시그니처 | 설명 |
|---|---|---|
| `layout()` | `(): void` | DOM/스타일 갱신. |
| `render()` | `(): Promise<void>` | 원본 이미지 로드 후 `<canvas>`에 배치. 캐싱된 이미지가 있으면 동기 `drawImage`만 수행. |

#### 렌더링 모델 — clip-as-crop

`LayoutImageElement`는 원본 이미지 전체를 `width`×`height`(mm) 크기로 리사이즈하여 박스 내 `(x, y)` 위치에 배치한다. 캔버스 크기 = 박스 크기이므로 박스 밖 영역은 자동으로 clip되어 크롭 효과를 낸다. `objectFit`은 렌더링에 사용되지 않으며 편집 UI 메타데이터로만 보존된다.

#### 데이터 프로퍼티

| 이름 | 타입 | 단위 | 설명 |
|---|---|---|---|
| `data` | `ImageData` | — | 한 번에 갱신. |
| `x` | `number \| undefined` | mm | 박스 내 이미지 표시 시작 X. 음수면 박스 왼쪽으로 치워져 원본 오른쪽이 크롭. `undefined` 시 0. |
| `y` | `number \| undefined` | mm | 박스 내 이미지 표시 시작 Y. 음수면 박스 위쪽으로 치워져 원본 아래쪽이 크롭. `undefined` 시 0. |
| `width` | `number \| undefined` | mm | 이미지 표시 너비. 원본을 이 크기로 리사이즈. `undefined` 시 `absWidth`. |
| `height` | `number \| undefined` | mm | 이미지 표시 높이. 원본을 이 크기로 리사이즈. `undefined` 시 `absHeight`. |
| `dpi` | `number` | DPI | 캔버스 렌더링 해상도 (mm→canvas px 변환 전용). 원본 메타데이터의 dpi와 무관. |
| `url` | `string \| undefined` | — | 이미지 URL. `urlLoader`가 설정되면 로더를 거쳐 변환. |
| `zIndex` | `number` | — | 렌더링 순서. |
| `overlapPadding` | `number \| { top?, right?, bottom?, left? }` | mm | 텍스트 회피 패딩. |
| `overlapMode` | `OverlapMode` | — | 오버랩 처리 모드 (`'path'` \| `'box'` \| `'none'`). 기본값 `'path'`. `'path'`=불투명 픽셀 윤곽 따라 흐름, `'box'`=박스 rect 기준 회피(투명 영역도 차단), `'none'`=오버랩 회피 없음(텍스트가 이미지 아래에 쓰여짐). | |
| `objectFit` | `ImageObjectFit` | — | 편집 UI 메타데이터 ONLY (`'cover'` \| `'fill'` \| `'contain'` \| `'none'`). `LayoutImageElement` 렌더링 미사용. 편집 UI가 이 값으로 `x`/`y`/`width`/`height`를 계산. 기본값 `'cover'`. |
| `originalWidth` | `number \| undefined` | mm | 원본 이미지 너비 (mm). Place Gun에서 `px / dpi × 25.4`로 변환하여 주입. |
| `originalHeight` | `number \| undefined` | mm | 원본 이미지 높이 (mm). Place Gun에서 `px / dpi × 25.4`로 변환하여 주입. |
| `aiProcessing` (set) | `boolean` | — | AI 처리 중 오버레이 토글. `true` 시 반투명 오버레이 + shimmer/spinner 애니메이션 표시. `pointer-events: auto`로 마우스 이벤트 차단. `data` getter에 포함되지 않는 휘발성 속성 (저장/직렬화 시 제외). `layout()`/`render()` 미호출. |

#### 게터

| 이름 | 타입 | 설명 |
|---|---|---|
| `canvas` | `HTMLCanvasElement \| undefined` | 렌더링된 캔버스. |
| `absLeft` / `absTop` | `number` (mm) | 절대 위치. |
| `absWidth` | `number` (mm) | 절대 너비. `inheritStyle.parentWidth`(부모 editableWidth, 이미 padding 차감됨)을 그대로 사용. 위치 보정은 `relLeft`(`paddingLeft`)에서 처리. |
| `absHeight` | `number` (mm) | 절대 높이. `inheritStyle.parentHeight`를 그대로 사용. |
| `type` | `'image'` | 타입 리터럴. |
| `printPostData` | `PrintPostData[]` | 인쇄 후처리 데이터. |

#### `overlapPadding` 사용

- `number` → 4방향 동일.
- `{ top, right, bottom, left }` → 방향별 지정.
- **타원형 감지**: 불투명 픽셀 주변을 `(ndx² + ndy² ≤ 1)` 타원으로 패딩 적용.
  투명 픽셀은 텍스트를 막지 않음.
- `overlapPadding` 또는 `zIndex` 변경 시 형제 단락을 재렌더링하여
  텍스트가 새 영역을 회피하도록 함.

#### `overlapMode` 사용

- `'path'` (기본값): 캔버스 불투명 픽셀 윤곽을 따라 텍스트가 흐른다. 투명 영역은 통과.
- `'box'`: 이미지를 박스처럼 취급하여 박스 rect 기준으로 텍스트가 회피한다. `overlapPadding` 적용. 투명 영역도 차단.
- `'none'`: 오버랩 회피를 하지 않는다. 텍스트가 이미지 아래에 그대로 쓰여지고 이미지가 그 위를 덮는다. `overlayElements`에서 제외되어 `TextLayoutEngine`이 오버랩 요소로 취급하지 않음.
- `overlapMode` 변경 시 `layout()` + `render()` + 부모 `requestRerenderAffectedParagraphs()` 호출.

#### 이미지 재렌더링 트리거

이미지 캔버스(`absWidth` × `absHeight`)와 크롭 영역(`x`, `y`, `width`, `height`,
`objectFit`)이 바뀌면 `render()`를 다시 호출하여 픽셀을 다시 그려야 한다.
`LayoutImageElement`는 다음 상황에서 자동으로 `render()`를 호출한다.

| 트리거 | 경로 | 비고 |
|---|---|---|
| `data` setter | `layout()` + `render()` | `objectFit`, `x`/`y`/`width`/`height`, `url`, `originalWidth`/`originalHeight` 등 일괄 갱신 |
| `x`, `y`, `width`, `height`, `dpi`, `url`, `originalWidth`, `originalHeight` setter | `render()` | 단일 필드 변경 (기존 값과 같으면 no-op) |
| `objectFit` setter | (없음) | 메타데이터만 갱신. 렌더링 미영향. 편집 UI가 별도로 `x`/`y`/`width`/`height`를 갱신. |
| `zIndex`, `overlapPadding`, `overlapMode` setter | `layout()` + `render()` + 부모 `requestRerenderAffectedParagraphs()` | 형제 단락 텍스트 회피 재계산 |
| `inheritStyle` setter | `layout()` + `render()` | 상위 box의 크기/여백 변경 시. `absWidth`/`absHeight`가 `inheritStyle.parentWidth`/`parentHeight`에 의존하므로 캔버스 픽셀을 다시 그려야 함 |

**상위 box 크기/여백 변경 경로**:

```
box.width = N  (또는 height/top/left/paddingTop/...)
  → box.layout()
    → box._propagateInheritStyle()
      → childImage.inheritStyle = newStyle
        → childImage.layout() + childImage.render()  ← 캔버스 재그리기
  → box.scheduleRerenderAffectedParagraphs()  ← 형제 단락 텍스트 회피
```

> **참고**: `LayoutBoxElement.scheduleRerenderAffectedParagraphs()`는
> 단락만 수집한다. 자식 image는 `_propagateInheritStyle()` 경로로
> `inheritStyle` setter가 `render()`를 호출하므로 별도 수집이 불필요하다.

#### 이미지 로딩 캐싱 및 깜빡임 방지

> **일반 단락/컬럼 렌더링 최적화는 `docs/PERFORMANCE.md`를 참조.** 이 절은 이미지 특화 로딩/깜빡임 방지 캐싱을 다룬다.

`render()`가 호출될 때마다 `new Image()`를 만들고 `onload`를 기다리면 상위 box
크기 변경 등 빈번한 재렌더링에서 비효율적이며, 캔버스를 비운 뒤 이미지를 다시
그리는 동안 빈 프레임이 노출되어 깜빡임이 발생한다. `LayoutImageElement`는
두 가지 최적화로 이를 해결한다.

**1. 이미지 캐싱** — 한 번 로드한 `HTMLImageElement`를 재사용

| 내부 필드 | 설명 |
|---|---|
| `_cachedImage` | 로드된 `HTMLImageElement` |
| `_cachedImageSrc` | `_cachedImage`가 로드된 resolved URL (캐시 키) |
| `_imageLoadingPromise` | 진행 중인 로드 Promise. 같은 URL에 대한 동시 `render()` 호출 시 중복 네트워크 요청 방지 |
| `_cachedResolvedUrl` | `_resolveUrl()` 결과 캐시. `url`이 바뀌지 않으면 매 `await` 없이 동기 경로로 진행 |

**2. 깜빡임 방지 렌더링** — 캔버스를 먼저 비우지 않음

| 최적화 | 기존 동작 | 개선 동작 |
|---|---|---|
| 캔버스 초기화 | `render()` 시작 시 `canvas.width = canvas.width`로 전체 초기화 | 초기화 제거. `_drawImage()`에서 필요 시에만 크기 변경 |
| 캔버스 크기 변경 | 매 `render()`마다 `width`/`height` 설정 (내용 지워짐) | 새 크기가 기존과 다를 때만 설정. 같으면 `clearRect` + `drawImage` |
| resolved URL | 매 `render()`마다 `await _resolveUrl()` | `_cachedResolvedUrl`로 캐시. 히트 시 `await` 없음 |
| 캐시 히트 drawImage | `await` 후 `drawImage` | 완전 동기 `drawImage` (빈 프레임 없음) |

**캐시 히트/미스 동작**:

- **히트**: `_cachedImageSrc === resolvedUrl` → 완전 동기 `drawImage`. `await`/네트워크/빈 프레임 없음.
- **미스**: `_loadImage()`로 새 `HTMLImageElement` 로드 → 캐싱 → `drawImage`.

**캐시 무효화 시점** (`_clearImageCache()` 호출):

- `url` setter — 새 URL로 교체 시
- `data` setter — `data.url`이 기존 값과 다를 때
- `disconnectedCallback` — DOM에서 제거 시
- `render()`에서 `resolvedUrl`이 `null`/`undefined`일 때 (로드 불가 상태)

> `urlLoader`가 매번 다른 URL을 반환하는 경우(예: 서명 URL 갱신) 캐시가 계속
> 미스 처리된다. `urlLoader`는 같은 원본 URL에 대해 안정적인 결과를 반환하는
> 것이 권장된다.

#### Object URL 수명주기 (메모리 누수 방지)

`urlLoader`가 `blob:` URL(`URL.createObjectURL()` 결과)을 반환하거나 `url` 자체가
`blob:` 스킴인 경우, `LayoutImageElement`는 해당 Object URL을 추적하여 DOM에서
분리될 때 `URL.revokeObjectURL()`로 해제한다. 이중 등록된 Object URL은 새 URL이
로드될 때 이전 것을 먼저 해제한다.

| 시점 | 동작 |
|---|---|
| `render()`에서 `resolvedUrl.startsWith('blob:')` | `_objectUrl`에 저장. 이전 `_objectUrl`이 있고 새 URL과 다르면 `revokeObjectURL` 호출 |
| `disconnectedCallback` | DOM 분리 시 `_objectUrl`이 있으면 `revokeObjectURL` 후 `undefined`로 초기화 |

> **주의**: 외부 코드에서 `URL.createObjectURL()`로 만든 blob URL을 `url`에
> 전달한 뒤 직접 `revokeObjectURL()`을 호출하면, `LayoutImageElement`가 이미지를
> 로드하기 전에 URL이 무효화될 수 있다. Object URL의 해제는
> `LayoutImageElement`에 위임하거나, 로드 완료 후에 수행해야 한다.

#### 예제

```ts
// 단방향 패딩
img.overlapPadding = 5;
// 비대칭 패딩
img.overlapPadding = { top: 2, right: 8, bottom: 2, left: 3 };
```

---

### `<x-layout-table>`

**표 컨테이너**. `<x-layout-box>`의 `children`에 `TableData`로 지정되면, 부모 box의
콘텐츠 영역을 가득 채우며 내부를 `colWidths` × 행 높이 그리드로 분할한다.
렌더링·셀 블록 선택·리사이즈·구조 편집(병합/삽입/삭제)에 대한 상세 명세는
`EDITING_TABLE.md`를 참조.

#### Class: `LayoutTableElement`

```ts
class LayoutTableElement extends HTMLElement
```

#### 데이터 프로퍼티 (setter / getter)

| 프로퍼티 | 타입 | 설명 |
|---|---|---|
| `data` | `TableData` | 표 데이터. setter에서 `id`·`colWidths`·`rows`를 설정하고 `layout()` + `render()`를 트리거. ID 기반 diff 재구성. |

#### 게터 (계산 프로퍼티)

| 게터 | 타입 | 설명 |
|---|---|---|
| `rows` | `TableRowData[]` | 현재 행 데이터 배열. 리사이즈/구조 편집 후에도 최신값 유지. |
| `colWidths` | `number \| number[] \| undefined` | 컬럼별 너비. `undefined`=자동 균등 분할, `number`=모든 열 동일, `number[]`=개별. |
| `resolvedColWidths` | `number[]` | `resolveTableGrid`로 정규화된 실제 열 너비 배열(mm). |
| `gridResolution` | `GridResolution \| undefined` | 현재 그리드 해석 결과. |
| `keyboardController` | `TableKeyboardController \| null` | 셀 블록 선택·키보드 단축키 컨트롤러. 레이아웃 편집 모드에서 활성. |
| `structureEditor` | `TableStructureEditor \| null` | 행/열 삽입·삭제·병합·분할 외부 API. 레이아웃 편집 모드에서 활성. |
| `inheritStyle` | `InheritStyle \| undefined` | 부모 box에서 전달받은 상속 스타일. `tr` → `td` → 셀 내부 box로 전파. |
| `items` | `LayoutTableRowElement[]` | 직계 자식 TR 요소 배열. |
| `type` | `'table'` | 요소 타입 식별자. |
| `zIndex` | `number` | 항상 `0` — 부모 box의 zIndex를 따르므로 정렬에 영향 없음. |
| `editManager` | `EditManager \| null` | 부모 체인에서 `LayoutDocumentElement.editManager` 조회. |
| `absLeft` | `number` | 문서 기준 절대 X 좌표(mm). 부모 box에서 상속. |
| `absTop` | `number` | 문서 기준 절대 Y 좌표(mm). 부모 box에서 상속. |
| `absWidth` | `number` | 절대 너비(mm). 부모 box의 콘텐츠 영역 너비. |
| `absHeight` | `number` | 절대 높이(mm). 부모 box의 콘텐츠 영역 높이. |

#### 메서드

| 메서드 | 시그니처 | 설명 |
|---|---|---|
| `layout()` | `(): void` | 그리드 재계산 + 스타일 적용 + 보더 렌더 + 리사이즈 핸들 + 상속 전파. |
| `render()` | `(): Promise<void>` | 자식 TR의 `render()`를 순차 호출. |
| `appendChildData(child)` | `(child: TableRowData): LayoutTableRowElement` | 새 TR을 생성하여 추가. |
| `setBorderOverride(key, edge)` | `(key: string, edge: CellBorderEdge): void` | 보더 엣지 수동 오버라이드. |
| `clearBorderOverride(key)` | `(key: string): void` | 보더 오버라이드 제거. |
| `notifyTablePropertyChange()` | `(): void` | `boxPropertyChange` 이벤트 트리거. |

#### 그리드 계산

`_layoutStructure()`에서 `resolveTableGrid()` 호출 후 산출된 `rowHeights`/`colWidths`를
원본 데이터에 write-back하여, 이후 `layout()`이 리사이즈된 값을 입력으로 사용하도록 한다.
리사이즈 핸들 드래그 중(`_resizeState` 활성)에는 write-back하지 않는다.

자세한 알고리즘은 `EDITING_TABLE.md` §3 참조.

---

### `<x-layout-tr>`

**표 행**. `<x-layout-table>`의 직계 자식으로, `height`(mm)와 셀 배열을 가진다.

#### Class: `LayoutTableRowElement`

```ts
class LayoutTableRowElement extends HTMLElement
```

#### 데이터 프로퍼티

| 프로퍼티 | 타입 | 설명 |
|---|---|---|
| `data` | `TableRowData` | 행 데이터. `height` + `children`(TableCellData[]). ID 기반 diff 재구성. |
| `height` | `number` | 행 높이(mm). 변경 시 `layout()`. |

#### 게터

| 게터 | 타입 | 설명 |
|---|---|---|
| `rowIndex` | `number` | 0-based 행 인덱스. |
| `rowLabel` | `string` | 행 라벨 (A, B, C, ...). |
| `items` | `LayoutTableCellElement[]` | 직계 자식 TD 요소 배열. |
| `inheritStyle` | `InheritStyle \| undefined` | 부모 table에서 전달받은 상속 스타일. |
| `editManager` | `EditManager \| null` | 부모 체인에서 조회. |
| `absLeft` | `number` | 문서 기준 절대 X 좌표(mm). 부모 table에서 상속. |
| `absTop` | `number` | 문서 기준 절대 Y 좌표(mm). 부모 table의 `absTop` + 자체 `_y`. |
| `absWidth` | `number` | 절대 너비(mm). 자체 `_width`. |
| `absHeight` | `number` | 절대 높이(mm). 자체 `_height`. |

#### 메서드

| 메서드 | 시그니처 | 설명 |
|---|---|---|
| `layout()` | `(): void` | 구조 + 스타일 + 상속 전파 + 자식 TD `layout()`. |
| `render()` | `(): Promise<void>` | 자식 TD의 `render()` 순차 호출. |
| `appendChildData(child)` | `(child: TableCellData): LayoutTableCellElement` | 새 TD 생성하여 추가. |

---

### `<x-layout-td>`

**표 셀**. `<x-layout-tr>`의 자식으로, box 배치 컨텍스트(`GridCalculator` `columns=1`)를
가지며 paragraph/image/nested-table을 box로 감싸서 자식으로 둔다.

#### Class: `LayoutTableCellElement`

```ts
class LayoutTableCellElement extends HTMLElement
```

#### Attributes

| 속성 | 타입 | 설명 |
|---|---|---|
| `colspan` | `number` | 열 병합 수. 기본 1. |
| `rowspan` | `number` | 행 병합 수. 기본 1. |

#### 데이터 프로퍼티

| 프로퍼티 | 타입 | 설명 |
|---|---|---|
| `data` | `TableCellData` | 셀 데이터. `colspan`/`rowspan`/보더/배경/대각선/패딩/`children`(BoxData[]). ID 기반 diff 재구성. |

#### 게터

| 게터 | 타입 | 설명 |
|---|---|---|
| `colspan` | `number` | 열 병합 수. |
| `rowspan` | `number` | 행 병합 수. |
| `borderTop` | `CellBorderEdge \| undefined` | 상단 보더 엣지. |
| `borderRight` | `CellBorderEdge \| undefined` | 우측 보더 엣지. |
| `borderBottom` | `CellBorderEdge \| undefined` | 하단 보더 엣지. |
| `borderLeft` | `CellBorderEdge \| undefined` | 좌측 보더 엣지. |
| `backgroundColor` | `string \| undefined` | 배경색 (ColorRegistry CMYK 이름). |
| `backgroundOpacity` | `number \| undefined` | 배경색 투명도 (0~1). |
| `diagonals` | `Array<'tl-br' \| 'tr-bl'> \| undefined` | 대각선 방향. |
| `paddingTop/Right/Bottom/Left` | `number` | 셀 내부 여백(mm). |
| `cellLabel` | `string` | 셀 라벨 (예: "A1"). |
| `cellLabels` | `string[]` | 병합된 전체 셀 라벨 배열. |
| `model` | `GridCalculator \| undefined` | 셀 내부 그리드 계산기. |
| `contentType` | `'box' \| 'paragraph' \| 'image' \| 'table' \| undefined` | 첫 번째 자식 box의 콘텐츠 타입. |
| `contentElement` | `LayoutBoxElement \| LayoutParagraphElement \| LayoutImageElement \| null` | 가장 깊은 콘텐츠 요소. |
| `items` | `LayoutBoxElement[]` | 직계 자식 box 요소 배열. |
| `inheritStyle` | `InheritStyle \| undefined` | 부모 tr에서 전달받은 상속 스타일. |
| `editManager` | `EditManager \| null` | 부모 체인에서 조회. |
| `absLeft` | `number` | 문서 기준 절대 X 좌표(mm). 부모 TR의 `absLeft` + 자체 `_x`. |
| `absTop` | `number` | 문서 기준 절대 Y 좌표(mm). 부모 TR의 `absTop` + 자체 `_y`. |
| `absWidth` | `number` | 절대 너비(mm). 자체 `_width`. |
| `absHeight` | `number` | 절대 높이(mm). 자체 `_height`. |

#### 메서드

| 메서드 | 시그니처 | 설명 |
|---|---|---|
| `layout()` | `(): void` | 구조 + 스타일 + 대각선 + placeholder border + 상속 전파 + 자식 box `layout()`. |
| `render()` | `(): Promise<void>` | 자식 box의 `render()` 순차 호출. |
| `appendChildData(child)` | `(child: BoxData): LayoutBoxElement` | 새 box 생성하여 추가. |

#### Placeholder border

보더가 선언되지 않은 면에 회색(`#aaaaaa`) 점선 placeholder border를 렌더링한다.
`EditManager.showPlaceholderBorders`가 `false`면 렌더링하지 않는다.
인쇄 모드에서도 렌더링하지 않는다. 자세한 내용은 `EDITING_TABLE.md` 참조.

> **우선순위**: `selected` > `hovered` > `reparent-target` > placeholder. box는 CSS attribute selector로 해당 상태일 때 placeholder 규칙이 제외되며, td는 `_renderPlaceholderBorder()`가 해당 속성을 감지해 div를 제거한다. 즉, 선택/호버/리페런트 타겟 상태에서는 placeholder border가 표시되지 않고 실제 상태 표시(outline)만 보인다. selected와 hovered가 동시에 있으면 selected(빨간 실선)가 우선한다.

---

### `<x-layout-column>`

**단락 내부의 실제 텍스트 컬럼**. `LayoutParagraphElement`가 `TextLayoutEngine`의
`columnContents[i]`를 소비하여 생성합니다. 외부에서 직접 만들지 않습니다.

#### Class: `LayoutColumnElement`

```ts
class LayoutColumnElement extends HTMLElement
```

#### Attributes

| 속성 | 타입 | 설명 |
|---|---|---|
| `index` | `number` | 컬럼 인덱스 (0-based). |

#### 게터

| 이름 | 타입 | 설명 |
|---|---|---|
| `index` | `number \| undefined` | 컬럼 인덱스. |
| `left` / `top` (mm) | `number` | 부모 단락 내 상대 위치. |
| `absLeft` / `absTop` (mm) | `number` | 루트 기준 절대 위치. |
| `model` | `TextLayoutEngine \| undefined` | 부모 단락의 모델. |
| `parentElement` | `LayoutParagraphElement` | 부모 단락. |
| `zIndex` | `0` | 항상 0. |
| `type` | `'column'` | 타입 리터럴. |

#### 메서드

| 메서드 | 시그니처 | 설명 |
|---|---|---|
| `renderText()` | `(): void` | `data-source-offset` 키로 diff 렌더링. 기존 span 재사용. |

> **Note**: `<x-layout-column>`은 `LayoutParagraphElement`가 관리하며, 직접 생성하지
> 마세요. `paragraph.data`를 변경하면 `render()`가 자동으로 컬럼 DOM을 갱신합니다.

---

### `<x-layout-guide-column>`

**텍스트 줄 위치 가이드**. 편집 모드에서 텍스트 줄의 위치/높이를 시각적으로 보여주는
오버레이입니다. 인쇄 모드에서는 자동 숨김 처리됩니다.

각 가이드 라인은 `position: absolute`로 `top: ${lineHeight * j}mm` 위치에 배치된다.
이전에는 flexbox `gap`으로 라인 간격을 구현했으나, 브라우저의 mm→px 하위픽셀 변환
오차가 라인이 아래로 갈수록 누적되어 static box의 수학적 `top` 계산(`lineHeight * top`)과
어긋나는 문제가 있었다. absolute positioning으로 변경하여 계산식과 정확히 일치하도록
수정했다.

#### Class: `LayoutGuideColumnElement`

```ts
class LayoutGuideColumnElement extends HTMLElement
```

#### 데이터 프로퍼티

| 이름 | 타입 | 단위 | 설명 |
|---|---|---|---|
| `rect` | `Rect` | mm | 한 번에 위치/크기 갱신. |
| `left` / `top` | `number` | mm | 위치. |
| `width` / `height` | `number` | mm | 크기. |
| `fontSize` | `number` | mm | 가이드 라인 높이 (글자 크기). |
| `lineHeight` | `number` | mm | 라인 간격. |
| `visible` | `boolean` | — | 표시 여부. |
| `data` (get) | `GuideColumnData` | — | 데이터 직렬화. |
| `printPostData` (get) | `PrintPostData[]` | 인쇄 후처리. |

#### 예제

```ts
const guide = document.createElement('x-layout-guide-column') as LayoutGuideColumnElement;
guide.rect = { x1: 10, y1: 10, x2: 100, y2: 200 };  // mm
guide.fontSize = 4;
guide.lineHeight = 5;
guide.visible = true;
document.body.appendChild(guide);
```

---

### `<x-layout-cursor>`

**편집 커서 오버레이**. `TextEditController`가 단락 shadow DOM에 추가하는 1px 폭의
세로 라인입니다. 깜빡임 없음.

#### Class: `LayoutCursorElement`

```ts
/**
 * 편집 커서. `<x-layout-cursor>` 커스텀 엘리먼트.
 *
 * 좌표는 단락 로컬(px) 기준이다. `pointer-events: none`.
 * `requestAnimationFrame`을 통해 변경을 디바운스한다.
 */
class LayoutCursorElement extends HTMLElement
```

#### 데이터 프로퍼티

| 이름 | 타입 | 단위 | 설명 |
|---|---|---|---|
| `top` | `number` | px | 단락 로컬 좌표. |
| `left` | `number` | px | 단락 로컬 좌표. |
| `height` | `number` | px | 커서 높이. |
| `visible` | `boolean` | — | 표시 여부. |

> **자동 관리**: `TextEditController`가 마우스/키보드 이벤트에 따라 `top`/`left`/`height`를
> 갱신합니다. 직접 조작할 필요는 없습니다.

---

### `<x-layout-selection>`

**선택 영역 하이라이트 오버레이**. `TextEditController`가 관리합니다.

#### Class: `LayoutSelectionElement`

```ts
/**
 * 선택 영역 하이라이트. `<x-layout-selection>` 커스텀 엘리먼트.
 *
 * 모든 좌표는 단락 로컬(px) 기준.
 */
class LayoutSelectionElement extends HTMLElement
```

#### 메서드

| 메서드 | 시그니처 | 설명 |
|---|---|---|
| `setRanges(ranges)` | `(ranges: { top, left, width, height }[]): void` | 하이라이트 영역을 설정. 빈 배열이면 모두 제거. |

#### 내부 동작

- 사각형 풀(`_pool`)을 유지하며, `setRanges` 호출 시 기존 사각형을 재사용하거나 새로 생성.
- 각 사각형의 색상은 `rgba(0, 100, 200, 0.3)`.

---

## Core

### `GridCalculator`

문서/박스 단위의 컬럼 그리드와 픽셀-mm 변환 비율을 계산하는 모델.

```ts
class GridCalculator {
  static create(data: GridCalculatorOptions): GridCalculator;
  static get ppm: number;       // 픽셀/mm 변환 비율 (캐싱됨)
  static resetPpm(): void;       // 캐시 무효화 (zoom/transform 후 호출)

  get textStyle: TextStyle;
  get paragraphStyle: ParagraphStyle;
  get columnCount: number;
  get columnCoords: Rect[];      // 각 컬럼의 (x1, y1, x2, y2)
  get columnWidth: number[];     // 각 컬럼의 폭
  get gaps: number[];           // 컬럼 간 간격
  get lineHeight: number;        // fontSize × lineGap
  get editableWidth: number;     // mm
  get editableHeight: number;    // mm
  get editableTextHeight: number; // editableHeight + (lineHeight - fontSize)
  get fontSize: number;         // 상속 또는 기본값 (4)
  get lineGap: number;          // 상속 또는 기본값 (1.25)

  set data(data: GridCalculatorOptions): void;
}
```

#### 정적 메서드

```ts
/**
 * GridCalculator 인스턴스를 생성한다. `new` 직접 사용 금지.
 *
 * @param data - width, height, padding, columns, gap, paragraphStyle, textStyle
 * @returns 새 GridCalculator 인스턴스
 */
static create(data: GridCalculatorOptions): GridCalculator;
```

```ts
/**
 * 픽셀/mm 변환 비율. 100mm div를 만들어 측정한 후 캐싱.
 *
 * @returns 픽셀/mm (예: 보통 3.78)
 * @throws 픽셀이 0 이하일 때 (DOM 측정 실패)
 *
 * @example
 * const px = mm * GridCalculator.ppm;
 */
static get ppm: number;
```

```ts
/**
 * ppm 캐시 무효화. zoom 변경, CSS transform, 인쇄 전환 시 호출.
 */
static resetPpm(): void;
```

#### `data` setter

```ts
/**
 * 입력 데이터를 갱신하고 컬럼 그리드 좌표를 재계산.
 *
 * @param data - element, width, height, padding, columns, gap, paragraphStyle, textStyle
 */
set data(data: GridCalculatorOptions): void;
```

#### 사용 예제

```ts
const calc = GridCalculator.create({
  element: docEl,
  width: 210, height: 297,
  paddingTop: 10, paddingLeft: 10, paddingRight: 10, paddingBottom: 10,
  columns: 6, gap: 3,
  paragraphStyle: { lineGap: 1.2 },
  textStyle: { fontSize: 4 },
});

console.log(calc.columnCoords);    // Rect[6]
console.log(calc.editableWidth);   // 190 - 3*5 = 175 (mm)
console.log(calc.lineHeight);      // 4 × 1.2 = 4.8 (mm)
```

### `TextLayoutEngine`

다중 컬럼 텍스트 래핑, 오버랩 회피, 스타일 생성을 담당하는 모델.

```ts
class TextLayoutEngine {
  static create(options: TextLayoutEngineOptions): TextLayoutEngine;

  // 렌더링 파이프라인
  layoutStructure(): void;     // 컬럼 폭/ppm 측정
  layoutText(): void;          // 문자 단위 줄바꿈
  resetIncrementalState(): void; // _previousLineCount = -1, _previousOverflow = -1

  // 스타일 생성
  genColumnStyle(idx: number): Partial<CSSStyleDeclaration>;
  genLineStyle(textBlockStyle?: TextBlockStyle): Partial<CSSStyleDeclaration>;
  genPartStyle(textBlockStyle?: TextBlockStyle): Partial<CSSStyleDeclaration>;
  genCharStyle(char: string): Partial<CSSStyleDeclaration>;

  // 게터
  get textContent: string | (string | TextBlockData)[];
  get contents: TextBlockData[];
  get inheritStyle: InheritStyle;
  get textStyle: TextStyle;
  get paragraphStyle: ParagraphStyle;
  get columnCount: number;
  get columnContents: TextLineData[][];  // 컬럼별 줄 데이터
  get gaps: number[];
  get lineHeight: number;
  get overflow: number;          // 컨테이너 밖으로 밀려난 문자 수
  get previousLineCount: number;
  get previousOverflow: number;
  get widthRatio: number;        // 장평 (기본 0.8)
  get spaceRatio: number;        // 공백 너비 (em, 기본 0.25)
  get indent: number;             // 문단 첫 줄 들여쓰기 비율 (fontSize 대비, 기본 0)
  get columnWidths: number[];

  // 세터
  set inheritStyle(value: InheritStyle): void;
  set data(options: TextLayoutEngineOptions): void;
  set textContent(value: string | (string | TextBlockData)[]): void;
}
```

#### `layoutStructure()`

```ts
/**
 * 구조적 레이아웃만 계산하고 캐싱. DOM 측정에 의존.
 * 내부적으로 `initStructureAndMeasureColumns()` 호출.
 */
public layoutStructure(): void;
```

#### `layoutText()`

```ts
/**
 * 문자 단위 줄바꿈 렌더링 실행. `layoutStructure()`가 먼저 호출되어야 함.
 * 내부적으로 `_layoutTextIntoColumns()` 호출.
 */
public layoutText(): void;
```

#### `resetIncrementalState()`

```ts
/**
 * 증분 렌더링 상태 초기화. 구조 변경 후 전체 재생성을 보장.
 * `_previousLineCount`와 `_previousOverflow`를 -1로 설정.
 */
public resetIncrementalState(): void;
```

#### `genColumnStyle(idx)`

```ts
/**
 * 컬럼 스타일 생성 (Flexbox 컨테이너).
 *
 * @param idx - 컬럼 인덱스 (0-based)
 * @returns column 위치/크기/수직 정렬을 포함한 CSS 스타일
 */
public genColumnStyle(idx: number): Partial<CSSStyleDeclaration>;
```

#### `genLineStyle(textBlockStyle?)`

```ts
/**
 * 줄 스타일 생성.
 *
 * - `lineGap` → `height` (mm) 계산
 * - `textBlockStyle` → 폰트/색상/높이 오버라이드
 *
 * @param textBlockStyle - 블록 단위 스타일 (선택)
 * @returns 줄(line) CSS 스타일
 */
public genLineStyle(textBlockStyle?: TextBlockStyle): Partial<CSSStyleDeclaration>;
```

#### `genPartStyle(textBlockStyle?)`

```ts
/**
 * 파트(part, 줄 내부 세그먼트) 스타일 생성.
 *
 * - `letterSpacing` → em 단위 적용
 * - `textAlign` → `justify-content` 매핑
 *   ('justify' → 'space-between')
 * - `textBlockStyle` → 폰트/색상/정렬 오버라이드
 *
 * @param textBlockStyle - 블록 단위 스타일 (선택)
 * @returns 파트(part) CSS 스타일
 */
public genPartStyle(textBlockStyle?: TextBlockStyle): Partial<CSSStyleDeclaration>;
```

#### `genCharStyle(char)`

```ts
/**
 * 글자(span) 스타일 생성.
 *
 * - `widthRatio` → CSS `scale` 적용 (장평)
 * - 반각 문자 → `min-width: 0.35em`
 * - 전각 문자 → `min-width: 0.15em`
 * - 공백 → `min-width: ${spaceRatio}em`
 *
 * @param char - 단일 글자
 * @returns 글자(span) CSS 스타일
 */
public genCharStyle: (char: string) => Partial<CSSStyleDeclaration>;
```

#### `columnContents`

`TextLineData[][]` — 컬럼별 줄 데이터. `LayoutColumnElement`가 이 데이터를 소비하여
DOM을 만듭니다. **읽기 전용**으로 취급하세요.

#### `overflow`

컨테이너 밖으로 밀려난(잘린) 문자 수. `> 0`이면 `paragraph`가 `render-error` 이벤트를
디스패치합니다.

#### 예제

```ts
const engine = TextLayoutEngine.create({
  content: 'Hello, world!',
  column: 3, gap: 3,
  paragraphStyle: { lineGap: 1.2, textAlign: 'justify' },
  textStyle: { fontSize: 4, fontFamily: 'Myoungjo', color: 'black' },
  inheritStyle: { parentWidth: 100, parentHeight: 200 },
  paragraphEl: paragraphEl,
  rootNode: paragraphEl.shadowRoot!,
});

engine.layoutStructure();
engine.layoutText();

console.log(engine.columnContents); // TextLineData[][]
console.log(engine.overflow);        // 0
```

### `Rect`

```ts
type Rect = {
  /** 좌측 경계 (mm) */
  x1: number;
  /** 상단 경계 (mm) */
  y1: number;
  /** 우측 경계 (mm) */
  x2: number;
  /** 하단 경계 (mm) */
  y2: number;
};
```

`GridCalculator.columnCoords`의 원소 타입. 가이드 컬럼의 위치 지정에도 사용됩니다.

---

## Resource Managers

### `ColorRegistry`

CMYK 색상 데이터 로드 + RGB 변환 + CSS 변수 주입을 관리하는 **싱글톤**.

```ts
class ColorRegistry {
  static getInstance(): ColorRegistry;
  static registerLoader(loader: ColorLoaderFn): void;
  static resetLoader(): void;

  init(colorSet?: CMYKColorSet): Promise<ColorMap[]>;
  getCSSColor(name: string): string;
  get(name: string): CMYKColor;
  get colorMap: ColorMap[];
  get ready: boolean;
}

type ColorLoaderFn = () => Promise<CMYKColorSet>;
```

#### 정적 메서드

```ts
/**
 * 싱글톤 인스턴스 반환.
 */
static getInstance(): ColorRegistry;
```

```ts
/**
 * 커스텀 색상 로더 등록. 기본 `fetch('color.json')` 대신 사용.
 *
 * @param loader - CMYKColorSet을 반환하는 비동기 함수
 *
 * @example
 * ColorRegistry.registerLoader(async () => {
 *   const res = await fetch('/api/v1/colors');
 *   return res.json() as Promise<CMYKColorSet>;
 * });
 */
static registerLoader(loader: ColorLoaderFn): void;
```

```ts
/**
 * 커스텀 로더 제거. 기본 `fetch('color.json')`로 복귀.
 */
static resetLoader(): void;
```

#### 인스턴스 메서드

```ts
/**
 * 색상 데이터를 로드하고 CSS 변수를 주입.
 *
 * - 화면 모드: `_loadServer()` (커스텀 로더 또는 `color.json` fetch)
 * - 인쇄 모드: `colorSet` 인자 직접 사용
 * - stylesheet이 없으면 (SSR/test) `_ready = true`만 설정하고 colorMap은 반환
 *
 * @param colorSet - 인쇄 모드에서 사용할 CMYKColorSet
 * @returns ColorMap[] (RGB-CMYK 쌍)
 * @throws {Error} 인쇄 모드인데 `colorSet`이 없을 때
 *
 * @example
 * // 화면 모드
 * await ColorRegistry.getInstance().init();
 *
 * // 인쇄 모드
 * await ColorRegistry.getInstance().init({ black: { c:0, m:0, y:0, k:255 } });
 */
async init(colorSet?: CMYKColorSet): Promise<ColorMap[]>;
```

```ts
/**
 * CSS 색상 문자열 반환.
 *
 * 등록된 색상 이름이면 해당 색상의 `#RRGGBB` hex 문자열을 반환한다.
 * 등록되지 않은 이름이나 CSS 색상 문자열(`#000`, `rgb(...)`)은
 * 기본 색상 hex로 폴백된다. 스타일 필드(`TextStyle.color`,
 * `BoxData.backgroundColor` 등)에는 등록된 색상 이름만 사용해야 한다.
 *
 * 반환값이 hex 문자열이므로 `getOpacityHex()`로 생성한 2자리 alpha hex를
 * 뒤에 결합하여 `#RRGGBBAA` 형태의 투명도 포함 색상을 만들 수 있다.
 *
 * @param name - CMYKColorSet에 등록된 색상 이름
 * @returns `#RRGGBB` hex 문자열. 등록되지 않은 이름은 기본 색상 hex
 * @throws {Error} `ready === false`일 때
 *
 * @example
 * const bg = registry.getCSSColor('red');
 * // → '#FF0000'
 *
 * registry.getCSSColor('#000000');   // → 기본 색상 hex (폴백)
 * registry.getCSSColor('unknown');   // → 기본 색상 hex (폴백)
 *
 * // 투명도 결합
 * const bg50 = registry.getCSSColor('red') + registry.getOpacityHex(0.5);
 * // → '#FF000080'
 */
getCSSColor(name: string): string;

/**
 * 0~1 투명도 값을 2자리 hex alpha 문자열로 변환.
 *
 * CSS `opacity`와 동일한 0~1 범위를 받아 `00`(완전 투명) ~ `FF`(완전 불투명)
 * hex 2자리로 변환한다. `getCSSColor()`가 반환한 `#RRGGBB` hex 뒤에 결합하여
 * `#RRGGBBAA` 8자리 hex 색상을 만드는 데 사용한다. 범위를 벗어나면 clamp.
 *
 * @param opacity - 0~1 투명도. 음수는 0, 1 초과는 1로 clamp.
 * @returns 2자리 hex alpha 문자열 (`00`~`FF`)
 *
 * @example
 * registry.getOpacityHex(0);    // → '00'
 * registry.getOpacityHex(0.5);  // → '80'
 * registry.getOpacityHex(1);    // → 'FF'
 */
getOpacityHex(opacity: number): string;
```

```ts
/**
 * CMYK 색상값 반환.
 *
 * @param name - CMYK 색상 이름
 * @returns 해당 색상의 CMYK 값 또는 기본값
 * @throws {Error} `ready === false`일 때
 */
get(name: string): CMYKColor;
```

#### 게터

| 이름 | 타입 | 설명 |
|---|---|---|
| `colorMap` | `ColorMap[]` | RGB-CMYK 쌍 배열. |
| `ready` | `boolean` | 초기화 완료 여부. |

#### 예제

```ts
// 기본 사용
const registry = ColorRegistry.getInstance();
await registry.init();

box.borderColor = 'red';      // '#FF0000'로 렌더링
const cmyk = registry.get('red');  // { c:0, m:255, y:255, k:0 }

// 배경색 + 투명도
box.backgroundColor = 'red';
box.backgroundOpacity = 0.5;   // getCSSColor('red') + getOpacityHex(0.5) → '#FF000080'

// 인쇄 모드: 데이터 주입
const colorSet: CMYKColorSet = {
  red: { c: 0, m: 255, y: 255, k: 0 },
  blue: { c: 255, m: 0, y: 0, k: 0 },
};
await registry.init(colorSet);
```

### `FontLoader`

폰트 로드 + `FontFace` API 등록을 관리하는 **싱글톤**.

```ts
class FontLoader {
  static getInstance(): FontLoader;
  static registerLoader(loader: FontLoaderFn): void;
  static resetLoader(): void;

  init(fonts?: Font[]): Promise<FontFace[]>;
  getFontFamily(fontFamily?: string): string;
  get fontFaces: FontFace[];
  get ready: boolean;
}

type FontLoaderFn = () => Promise<Font[]>;
```

#### 정적 메서드

```ts
/**
 * 커스텀 폰트 로더 등록. 기본 `fetch('fonts.json')` 대신 사용.
 *
 * @param loader - Font[]을 반환하는 비동기 함수
 *
 * @example
 * FontLoader.registerLoader(async () => {
 *   const res = await fetch('/api/v1/fonts');
 *   return res.json() as Promise<Font[]>;
 * });
 */
static registerLoader(loader: FontLoaderFn): void;
```

```ts
/**
 * 커스텀 로더 제거.
 */
static resetLoader(): void;
```

#### 인스턴스 메서드

```ts
/**
 * 폰트 데이터를 로드하고 `FontFace` API로 등록.
 *
 * - 화면 모드: `ttfFilename` 또는 `base64Data` 사용
 * - 인쇄 모드: `base64Data`만 사용
 *
 * @param fonts - 인쇄 모드에서 사용할 Font 배열
 * @returns 로드된 FontFace[] 배열
 * @throws {Error} 인쇄 모드인데 `fonts`가 없을 때
 *
 * @example
 * // 화면 모드
 * await FontLoader.getInstance().init();
 *
 * // 인쇄 모드
 * await FontLoader.getInstance().init([
 *   { family: 'Myoungjo', weight: 400, style: 'normal', base64Data: '...' },
 * ]);
 */
async init(fonts?: Font[]): Promise<FontFace[]>;
```

```ts
/**
 * 폰트 패밀리명 반환.
 *
 * `FontLoader`에 등록된 `Font` 중 `family`가 `fontName`과 일치하는 폰트를
 * 찾아 해당 `FontFace.family`를 반환한다. 일치하는 폰트가 없으면 등록된
 * 첫 번째 폰트의 `FontFace.family`로 폴백된다. 스타일 필드의
 * `fontFamily` 값은 `Font.family` 값이어야 하며, CSS `font-family`
 * 키워드(`"serif"` 등)는 매칭되지 않아 폴백된다.
 *
 * @param fontName - 등록된 Font.family 값
 * @returns 일치하는 FontFace.family, 또는 등록된 첫 폰트의 family
 * @throws {Error} `ready === false`일 때
 *
 * @example
 * const family = FontLoader.getInstance().getFontFamily('Myoungjo');
 * // → 등록된 FontFace.family 중 'Myoungjo'와 일치하는 값
 */
getFontFamily(fontName?: string): string;
```

#### 게터

| 이름 | 타입 | 설명 |
|---|---|---|
| `fontFaces` | `FontFace[]` | 등록된 FontFace 배열. |
| `ready` | `boolean` | 초기화 완료 여부. |

> **폰트 패밀리 매칭**: `getFontFamily(fontName)`는 등록된 `Font` 중
> `family`가 `fontName`과 일치하는 폰트를 찾아 `FontFace.family`를
> 반환합니다. 일치하는 폰트가 없으면 등록된 첫 번째 폰트로
> 폴백됩니다. 스타일 필드(`TextStyle.fontFamily`,
> `TextBlockStyle.fontFamily`)에는 `FontLoader`에 등록된
> `Font.family` 값만 사용해야 합니다.

#### 예제

```ts
await FontLoader.getInstance().init();
console.log(FontLoader.getInstance().ready); // true

// 등록된 Font.family로 폰트 패밀리 조회
const family = FontLoader.getInstance().getFontFamily('Myoungjo');
// → 등록된 'Myoungjo' FontFace.family

// 미등록 폰트는 첫 폰트로 폴백
FontLoader.getInstance().getFontFamily('serif'); // → 등록된 첫 폰트
```

---

## Edit

### `EditManager`

전역 편집 상태를 관리하는 **싱글톤**. 포커스, 선택, 편집 모드, 레이아웃 선택, 삽입 모드
모두를 이 매니저로 제어합니다.

```ts
class EditManager {
  static getInstance(): EditManager;

  // 이벤트
  addEventListener(type: EditManagerEventType, listener: EditManagerEventListener): void;
  removeEventListener(type: EditManagerEventType, listener: EditManagerEventListener): void;

  // 텍스트 포커스
  focusParagraph(target, options?): boolean;
  blurParagraph(target?): boolean;
  deactivateAll(): void;

  // 텍스트 편집 모드
  get textEditMode: boolean;
  set textEditMode(value: boolean): void;
  setEditableTextRoles(roles: BoxRole[] | null): void;
  get editableTextRoles: ReadonlySet<BoxRole> | null;
  setEditableTextBoxIds(ids: string[] | null): void;
  get editableTextBoxIds: ReadonlySet<string> | null;
  setEditableParagraphIds(ids: string[] | null): void;
  get editableParagraphIds: ReadonlySet<string> | null;
  addEditableParagraph(id: string): void;
  removeEditableParagraph(id: string): void;

  // 레이아웃 편집 모드
  get layoutEditMode: boolean;
  set layoutEditMode(value: boolean): void;
  setEditableRoles(roles: BoxRole[] | null): void;
  get editableRoles: ReadonlySet<BoxRole> | null;
  setEditableBoxIds(ids: string[] | null): void;
  get editableBoxIds: ReadonlySet<string> | null;
  addEditableBox(id: string): void;
  removeEditableBox(id: string): void;
  setEditableRootId(id: string | null): void;
  get editableRootId: string | null;

  // 레이아웃 선택
  selectLayout(target): boolean;
  selectLayoutExclusive(target: LayoutElement | string): boolean;
  clearLayoutSelection(preserveFocusedBox?: boolean): void;
  get selectedLayouts: LayoutElement[];
  get selectedLayoutIds: string[];

  // 삽입 모드
  get insertMode: InsertMode | null;
  set insertMode(mode: InsertMode | null): void;
  activateInsert(mode: InsertMode): void;
  deactivateInsert(): void;
  handleInsertMouseDown(event: MouseEvent): void;

  // Place Gun
  get placeGunItems: PlaceGunItem[];
  get placeGunPaused: boolean;
  get placeGunActive: boolean;
  loadPlaceGun(items: readonly PlaceGunItem[]): void;
  unloadPlaceGun(): void;
  removePlaceGunItem(index: number): void;
  reorderPlaceGunItems(from: number, to: number): void;
  setPlaceGunPaused(paused: boolean): void;

  // 상태 조회
  get focusedParagraph: LayoutParagraphElement | null;
  get focusedController: TextEditController | null;
  get cursorOffset: number | null;
  get selection: SelectionRange | null;
  get currentStyle: CurrentStyle | null;
  get controllers: Set<TextEditController>;

  // 휘발성 표시 토글
  get showPlaceholderBorders: boolean;
  set showPlaceholderBorders(value: boolean): void;

  // 판별
  isParagraphEditable(paragraph: LayoutParagraphElement): boolean;
  isBoxEditable(box: LayoutBoxElement): boolean;

  // 라이프사이클
  /** 모든 편집 상태를 초기화. LayoutEditor unmount 시 호출하여 싱글톤의 잔류 상태를 제거. */
  reset(): void;
}
```

#### `showPlaceholderBorders`

```ts
get showPlaceholderBorders(): boolean;
set showPlaceholderBorders(value: boolean): void;
```

보더가 없는 box/td의 회색(`#aaaaaa`) 점선 placeholder border 및 document 가이드 컬럼 표시 여부를 토글한다. **휘발성** — `BoxData`/`TableData`에 저장되지 않으며 편집 세션 중에만 적용된다. 기본값 `true`. `selected` > `hovered` > `reparent-target` > placeholder 순으로 우선하며, 해당 상태에서는 placeholder border가 표시되지 않는다.

- `true`: 보더 없는 box/td에 placeholder border 표시, 가이드 컬럼 표시
- `false`: placeholder border 숨김, 가이드 컬럼 숨김

setter 호출 시 기존 box/td에 즉시 적용되며, 이후 추가되는 요소도 `connectedCallback`에서 현재 상태를 상속받는다. 편집 중 실제 내역만 확인하고 싶을 때 `false`로 설정한다.

#### 이벤트

```ts
type EditManagerEventType =
  | 'focusChange'           // 포커스 변경
  | 'textChange'            // 텍스트 변경
  | 'styleChange'           // 스타일 변경
  | 'selectionStart'        // 선택 시작
  | 'selectionEnd'          // 선택 종료
  | 'cursorMove'            // 커서 이동
  | 'layoutSelectionChange' // 레이아웃 선택 변경
  | 'layoutMove'            // 레이아웃 이동
  | 'layoutResize'          // 레이아웃 리사이즈
  | 'insert'                // 삽입 완료
  | 'insertCancel';         // 삽입 취소
  | 'modeChange'            // 모드 전환
  | 'boxPropertyChange'    // Box 속성 변경
  | 'placeGunChange';       // Place Gun 상태 변경

interface EditManagerEvent {
  type: EditManagerEventType;
  paragraph: LayoutParagraphElement;
  controller: TextEditController | null;
  previousParagraph?: LayoutParagraphElement | null;
  previousController?: TextEditController | null;
  selectedLayouts?: LayoutElement[];
  previousLayouts?: LayoutElement[];
  layoutElement?: LayoutElement;
  previousLeft?: number; top?: number; left?: number;
  previousWidth?: number; width?: number; previousHeight?: number; height?: number;
  canceled?: boolean;
}

type EditManagerEventListener = (event: EditManagerEvent) => void;
```

#### 텍스트 포커스

```ts
/**
 * 단락에 포커스 설정.
 *
 * - `editableText = false`인 단락이면 자동으로 `true`로 만들어 컨트롤러를 생성.
 * - `options.selection`이 있으면 우선 적용.
 * - `options.cursorOffset`만 있으면 그 오프셋으로 커서 이동.
 *
 * @param target - 단락 요소 또는 ID
 * @param options - { cursorOffset?, selection? }
 * @returns 성공 여부
 */
focusParagraph(
  target: LayoutParagraphElement | string,
  options?: { cursorOffset?: number; selection?: SelectionRange },
): boolean;
```

```ts
/**
 * 포커스 해제. `target` 생략 시 현재 포커스된 단락.
 *
 * @param target - 단락 요소 또는 ID (선택)
 * @returns 성공 여부
 */
blurParagraph(target?: LayoutParagraphElement | string): boolean;
```

```ts
/**
 * 모든 단락의 편집 모드를 비활성화.
 */
deactivateAll(): void;
```

#### 텍스트 편집 모드

```ts
/**
 * 텍스트 편집 모드 활성 여부.
 *
 * `true`이면 `isParagraphEditable()` 통과 시 단락 편집 가능.
 * `false`이면 모든 단락이 편집 불가, 포커스 해제.
 *
 * @example
 * const manager = layoutDocEl.editManager;
 * manager.setEditableTextRoles(['body', 'title']);
 * manager.textEditMode = true;
 * // → 부모 box role이 'body' 또는 'title'인 paragraph만 편집 가능
 */
get textEditMode: boolean;
set textEditMode(value: boolean): void;
```

```ts
/**
 * 텍스트 편집 허용 box role 집합. null이면 role 제한 없음.
 *
 * @param roles - 허용할 BoxRole 배열. null이면 제한 해제.
 */
setEditableTextRoles(roles: BoxRole[] | null): void;
```

```ts
/**
 * 텍스트 편집 허용 box id 집합. null이면 제한 없음.
 */
setEditableTextBoxIds(ids: string[] | null): void;
```

```ts
/**
 * 텍스트 편집 허용 paragraph id 집합. null이면 제한 없음.
 */
setEditableParagraphIds(ids: string[] | null): void;
```

```ts
/**
 * 단일 paragraph id를 허용 목록에 추가.
 */
addEditableParagraph(id: string): void;
```

```ts
/**
 * 단일 paragraph id를 허용 목록에서 제거.
 */
removeEditableParagraph(id: string): void;
```

```ts
/**
 * 해당 paragraph가 텍스트 편집 가능한지 판별.
 *
 * 판별 규칙 (AND):
 * 1. textEditMode === true
 * 2. 조상 box 중 lock 없음
 * 3. editableRootId가 설정돼 있으면 root 내부에 있어야 함
 * 4. editableTextRoles !== null이면 부모 box role이 포함돼야 함
 * 5. editableTextBoxIds !== null이면 부모 box id가 포함돼야 함
 * 6. editableParagraphIds !== null이면 paragraph id가 포함돼야 함
 */
isParagraphEditable(paragraph: LayoutParagraphElement): boolean;
```

#### 레이아웃 편집 모드

```ts
/**
 * 레이아웃 편집 모드 활성 여부.
 *
 * `true`이면 `isBoxEditable()` 통과 시 박스 드래그/리사이즈 가능.
 */
get layoutEditMode: boolean;
set layoutEditMode(value: boolean): void;
```

```ts
/**
 * 레이아웃 편집 허용 role 집합. null이면 role 제한 없음.
 */
setEditableRoles(roles: BoxRole[] | null): void;
```

```ts
/**
 * 레이아웃 편집 허용 box id 집합. null이면 제한 없음.
 */
setEditableBoxIds(ids: string[] | null): void;
```

```ts
/**
 * 단일 box id를 허용 목록에 추가.
 */
addEditableBox(id: string): void;
```

```ts
/**
 * 단일 box id를 허용 목록에서 제거.
 */
removeEditableBox(id: string): void;
```

```ts
/**
 * 편집 루트 box id.
 *
 * `null`이 아니면 해당 box 내부의 요소만 편집 가능, 루트 box 자체는 이동/리사이즈 불가.
 *
 * @example
 * manager.setEditableRootId('box-1');
 * manager.setEditableRoles(['body']);
 * manager.layoutEditMode = true;
 * // → box-1 내부의 role='body' box만 편집 가능
 */
setEditableRootId(id: string | null): void;
```

```ts
/**
 * 해당 box가 레이아웃 편집 가능한지 판별.
 */
isBoxEditable(box: LayoutBoxElement): boolean;
```

#### 레이아웃 선택

```ts
/**
 * 레이아웃 요소를 선택.
 *
 * - `editableLayout`이 켜진 box만 선택 가능.
 * - `target`은 단일/배열 모두 지원. ID 문자열도 가능.
 *
 * @param target - 단일 요소, ID, 또는 그 배열
 * @returns 선택 성공 여부
 */
selectLayout(target: LayoutElement | string | (LayoutElement | string)[]): boolean;
```

```ts
/**
 * 단일 요소를 명시적으로 단일 선택한다. `multiSelect` 상태와 무관하게
 * 기존 선택을 모두 제거하고 대상만 선택하여 `layoutSelectionChange`를 1회 발생시킨다.
 * 컨텍스트 메뉴 우클릭 등 clear+select를 원자적으로 수행해야 하는 경우 사용한다.
 *
 * @param target - 선택할 단일 요소 또는 ID
 * @returns 선택 성공 여부. 대상이 검증을 통과하지 못하면 `false`
 */
selectLayoutExclusive(target: LayoutElement | string): boolean;
```

```ts
/**
 * 레이아웃 선택 모두 해제.
 * @param preserveFocusedBox - true(기본값)면 포커스 박스 선택 유지, false면 전체 해제
 */
clearLayoutSelection(preserveFocusedBox?: boolean): void;
```

```ts
/** 현재 선택된 레이아웃 요소들 */
get selectedLayouts: LayoutElement[];

/** 현재 선택된 레이아웃 요소들의 ID 배열 */
get selectedLayoutIds: string[];
```

#### Tab 탐색

```ts
/**
 * Tab/Shift+Tab 키로 문서 내 요소를 순회한다.
 *
 * - `textEditMode === true`: 편집 가능한 paragraph 사이에서 포커스를 이동.
 * - `textEditMode === false`: 선택 가능한 box 사이에서 단일 선택을 이동.
 * - 후보가 없거나 인쇄 모드/삽입 모드면 `false`를 반환하고 아무 동작도 하지 않는다.
 *
 * @param shiftKey - true면 역방향(Shift+Tab), false면 순방향(Tab)
 * @returns 이동 성공 여부
 */
navigateByTab(shiftKey: boolean): boolean;
```

탐색 순서:

1. 문서 전체를 전위 순회(pre-order DFS)로 평면화한다.
2. 같은 깊이의 형제는 `zIndex` 오름차순으로 정렬한다.
3. 표 내부 셀은 `gridRow` → `gridCol` 순서로 탐색한다.
4. 마지막 후보에서 Tab을 누르면 처음으로 돌아가고, 첫 번째 후보에서 Shift+Tab을 누르면 마지막으로 이동한다.

```ts
// 키 이벤트 핸들러에서 직접 호출
window.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const moved = layoutDocEl.editManager.navigateByTab(e.shiftKey);
    if (!moved) {
      console.log('이동할 후보가 없거나 현재 모드에서 Tab이 차단됨');
    }
  }
});
```

> **참고**: `<x-layout-document>`는 `window` capture phase에서 Tab 키를 가로채서
> `navigateByTab`을 자동 호출하므로, 일반적으로 외부에서 별도 핸들러를 달 필요는 없다.

#### 삽입 모드

```ts
/**
 * 삽입 모드. null이면 비활성.
 *
 * `null`이 아닌 값을 설정하면 드래그-삽입 모드가 활성화되어
 * 문서 표면에서 드래그로 새 요소를 그릴 수 있다.
 *
 * 빈 문서(편집 가능 box가 0개)에서도 활성화된다. 이 경우 document가
 * 삽입 컨테이너로 사용되어 첫 box를 그려 넣을 수 있다.
 */
get insertMode: InsertMode | null;
set insertMode(mode: InsertMode | null): void;
```

```ts
/** 삽입 모드 활성화. insertMode = mode와 동일. */
activateInsert(mode: InsertMode): void;

/** 삽입 모드 비활성화. insertMode = null과 동일. */
deactivateInsert(): void;

/** 레이아웃 편집 핸들러에서 mousedown 위임. */
handleInsertMouseDown(event: MouseEvent): void;
```

#### 상태 조회 게터

| 이름 | 타입 | 설명 |
|---|---|---|
| `focusedParagraph` | `LayoutParagraphElement \| null` | 포커스된 단락. |
| `focusedController` | `TextEditController \| null` | 포커스된 컨트롤러. |
| `cursorOffset` | `number \| null` | 현재 커서 오프셋 (소스 텍스트). |
| `selection` | `SelectionRange \| null` | 현재 선택 영역. |
| `currentStyle` | `CurrentStyle \| null` | 커서 위치의 유효 스타일. |
| `controllers` | `Set<TextEditController>` | 등록된 모든 컨트롤러. |

#### 예제

```ts
const manager = layoutDocEl.editManager;

// 텍스트 포커스
manager.focusParagraph('paragraph-1', { cursorOffset: 5 });

// 편집 모드 + 허용 범위
manager.setEditableTextRoles(['body', 'title']);
manager.textEditMode = true;

// 레이아웃 편집 모드 + 루트 제한
manager.setEditableRootId('root-box');
manager.setEditableRoles(['body']);
manager.layoutEditMode = true;

// 이벤트 구독
manager.addEventListener('textChange', (e) => {
  console.log('Text changed in', e.paragraph.id);
});
manager.addEventListener('layoutSelectionChange', (e) => {
  console.log('Selected:', e.selectedLayouts?.map(b => b.id));
});
manager.addEventListener('insert', (e) => {
  console.log('Inserted', e.layoutElement);
});
```

### `TextEditController`

단락 편집 상태(커서, 선택, IME 입력, 클립보드)를 관리하는 컨트롤러. `paragraph.editableText = true`
설정 시 자동 생성됩니다.

```ts
class TextEditController {
  constructor(paragraph: LayoutParagraphElement);

  // 게터
  get cursorOffset: number;
  get selection: SelectionRange | null;
  get currentStyle: CurrentStyle;

  // 제어
  focus(): void;
  blur(): void;
  setCursor(position: CursorPosition): void;
  setSelection(range: SelectionRange): void;
  destroy(): void;
  postRender(_fullRebuild?: boolean): void;
}

type CurrentStyle = {
  textStyle: TextStyle;
  paragraphStyle: ParagraphStyle;
};
```

#### 게터

```ts
/**
 * 커서의 현재 소스 텍스트 오프셋 (0-based).
 */
get cursorOffset: number;
```

```ts
/**
 * 현재 선택 영역. 선택이 없으면 null.
 */
get selection: SelectionRange | null;
```

```ts
/**
 * 현재 커서 위치에서 유효한 TextStyle/ParagraphStyle.
 *
 * 단락의 기본 스타일 + InheritStyle + 커서 위치 블록의 textBlockStyle을 모두 병합.
 *
 * @returns 현재 스타일
 */
get currentStyle: CurrentStyle;
```

#### 메서드

```ts
/**
 * 컨트롤러에 포커스. EditManager._requestFocus 호출.
 */
focus(): void;
```

```ts
/**
 * 컨트롤러 포커스 해제. EditManager._releaseFocus 호출.
 */
blur(): void;
```

```ts
/**
 * 외부에서 커서 위치 설정.
 *
 * @param position - { textOffset: number }
 *
 * @example
 * controller.setCursor({ textOffset: 10 });
 */
setCursor(position: CursorPosition): void;
```

```ts
/**
 * 외부에서 선택 영역 설정.
 *
 * @param range - SelectionRange
 */
setSelection(range: SelectionRange): void;
```

```ts
/**
 * 컨트롤러 제거. 이벤트 리스너, DOM, EditManager 등록 모두 해제.
 */
destroy(): void;
```

```ts
/**
 * 단락 `render()` 직후 호출되어 좌표 매퍼를 재구축하고 커서/선택을 다시 배치.
 *
 * @param _fullRebuild - DOM이 새로 생성됐으면 true (현재는 항상 full rebuild)
 */
postRender(_fullRebuild?: boolean): void;
```

#### IME / Composition

`compositionstart`, `compositionupdate`, `compositionend` 이벤트를 처리하여 한국어,
일본어, 중국어 IME 입력을 지원합니다. composition 중에는 textarea와 렌더링된 텍스트가
동기화되지 않으며, `compositionend` 시점에 적용됩니다.

#### 마우스 인터랙션

- **단일 클릭**: 가장 가까운 오프셋으로 커서 이동.
- **드래그**: 선택 영역 설정.
- **더블 클릭**: 단어 단위 선택.
- **트리플 클릭**: 줄 단위 선택.

#### 키보드 인터랙션

| 키 | 동작 |
|---|---|
| `←` `→` `↑` `↓` | 단일 글자 이동 |
| `Home` / `End` | 줄 시작/끝 |
| `Shift + 화살표` | 선택 확장 |
| `Ctrl/Cmd + A` | 전체 선택 |
| `Backspace` / `Delete` | 삭제 |
| `Enter` | 단락 분리 (`\n`) |
| `Ctrl/Cmd + Z` / `Shift + Z` | Undo/Redo |
| `Ctrl/Cmd + C/X/V` | 클립보드 |

### `TextEditCoordinateMapper`

소스 텍스트 오프셋 ↔ 렌더링된 DOM 좌표 간의 양방향 매핑.

```ts
class TextEditCoordinateMapper {
  constructor(paragraph: LayoutParagraphElement);

  rebuild(): void;
  sourceOffset(renderedOffset: number): number | null;
  renderedOffset(sourceOffset: number): number | null;
  getCharRect(offset: number): DOMRect | null;
  getCharOffsetFromPoint(x: number, y: number): CursorPosition | null;
  getNearestOffsetFromPoint(x: number, y: number): CursorPosition | null;
  getTextRange(startOffset: number, endOffset: number): { top, left, width, height }[];
  getTextContent(startOffset: number, endOffset: number): string;
  getFirstColumnRect(): { top, left, fontSize } | null;
  findVisualLineBounds(sourceOffset: number): { start, end } | null;
  getSpanByOffset(offset: number): HTMLSpanElement | null;
}
```

#### 메서드

```ts
/**
 * 매퍼를 다시 빌드. `postRender()`에서 호출.
 */
rebuild(): void;
```

```ts
/**
 * 렌더링 오프셋 → 소스 오프셋.
 *
 * @param renderedOffset - 화면에 보이는 글자 위치
 * @returns 소스 텍스트의 문자 오프셋 또는 null
 */
sourceOffset(renderedOffset: number): number | null;
```

```ts
/**
 * 소스 오프셋 → 렌더링 오프셋.
 *
 * @param sourceOffset - 소스 텍스트의 문자 오프셋
 * @returns 화면에 보이는 글자 위치 또는 null
 */
renderedOffset(sourceOffset: number): number | null;
```

```ts
/**
 * 소스 오프셋의 글자 사각형 좌표 (viewport 기준).
 *
 * @param offset - 소스 오프셋
 * @returns DOMRect 또는 null
 */
getCharRect(offset: number): DOMRect | null;
```

```ts
/**
 * 화면 좌표 → 가장 가까운 소스 오프셋 (정확한 hit test).
 *
 * @param x - viewport X (px)
 * @param y - viewport Y (px)
 * @returns CursorPosition 또는 null
 */
getCharOffsetFromPoint(x: number, y: number): CursorPosition | null;
```

```ts
/**
 * 화면 좌표 → 가장 가까운 소스 오프셋 (대략적 hit test).
 * 공백 영역(줄의 처음/끝)도 처리.
 */
getNearestOffsetFromPoint(x: number, y: number): CursorPosition | null;
```

```ts
/**
 * 텍스트 범위를 화면 사각형 배열로 변환 (선택 하이라이트용).
 *
 * @param startOffset - 시작 오프셋
 * @param endOffset - 끝 오프셋
 * @returns 단락 로컬 px 좌표 사각형 배열
 */
getTextRange(startOffset: number, endOffset: number): {
  top: number; left: number; width: number; height: number;
}[];
```

```ts
/**
 * 소스 오프셋 범위의 실제 텍스트 (공백·줄바꿈 포함).
 */
getTextContent(startOffset: number, endOffset: number): string;
```

```ts
/**
 * 첫 번째 컬럼의 위치/글자 크기.
 */
getFirstColumnRect(): { top: number; left: number; fontSize: number } | null;
```

```ts
/**
 * 특정 오프셋이 속한 시각적 줄의 시작/끝 오프셋.
 */
findVisualLineBounds(sourceOffset: number): { start: number; end: number } | null;
```

```ts
/**
 * 렌더링 오프셋에 해당하는 DOM span 요소.
 */
getSpanByOffset(offset: number): HTMLSpanElement | null;
```

### `InsertController`

`EditManager.insertMode`가 활성화되었을 때 마우스 드래그로 새 요소를 그려서 삽입하는
컨트롤러. 일반적으로 직접 인스턴스화하지 않습니다.

```ts
class InsertController {
  constructor(document: LayoutDocumentElement);

  get mode: InsertMode | null;
  setMode(mode: InsertMode | null): void;
  startDrag(event: MouseEvent): void;
  destroy(): void;
}
```

```ts
/**
 * 컨트롤러의 현재 모드.
 */
get mode: InsertMode | null;
```

```ts
/**
 * 모드 변경. null이면 비활성.
 */
setMode(mode: InsertMode | null): void;
```

```ts
/**
 * mousedown 이벤트 위임.
 */
startDrag(event: MouseEvent): void;
```

```ts
/**
 * 컨트롤러 제거.
 */
destroy(): void;
```

### `LayoutEditController`

레이아웃 편집 모드에서 마우스/키보드 인터랙션을 처리하는 컨트롤러. `EditManager`가
자동으로 생성/관리합니다.

```ts
class LayoutEditController {
  constructor(doc: HTMLElement);

  attach(): void;
  detach(): void;
  destroy(): void;
}
```

```ts
/**
 * 이벤트 리스너를 등록하고 편집 모드를 활성화.
 */
attach(): void;
```

```ts
/**
 * 이벤트 리스너를 해제하고 편집 모드를 비활성.
 */
detach(): void;
```

```ts
/**
 * 컨트롤러 완전 제거.
 */
destroy(): void;
```

---

### `PlaceGunController`

Place Gun 클릭 배치를 관리하는 컨트롤러. `EditManager.placeGunActive`가 true일 때
문서 클릭을 감지하여 장전된 맨 위 항목을 클릭 위치의 기존 요소에 주입한다.

> **참고**: `EditManager`가 자동으로 `attach()`/`detach()`를 관리하므로 직접 호출할 필요가 없다.

```ts
class PlaceGunController {
  attach(): void;
  detach(): void;
}
```

#### 동작

- `attach()`: 문서 커서를 `copy`로 변경
- `detach()`: 커서 복원
- `handleBoxMouseDown(box, event)`: box의 mousedown 이벤트에서 호출. 매칭되는 기존 요소에 데이터 주입 (새 요소 생성 안 함)

#### 매칭 규칙

| 항목 contentType | 매칭 대상 box `contentType` | 주입 대상 자식 요소 |
|------------------|----------------------------|---------------------|
| `'text'` | `'paragraph'` | `LayoutParagraphElement` |
| `'image'` | `'image'` | `LayoutImageElement` |

매칭되는 요소가 없으면 항목을 소비하지 않고 no-op로 종료한다.

#### 데이터 주입

| 항목 contentType | 주입 동작 |
|------------------|-----------|
| `'text'` | `paragraph.content = item.content.body` + `EditManager.notifyTextChange(paragraph)` |
| `'image'` | `image.url = subType === 'ad' ? /storage/ad/{uid} : /storage/image/{uid}` (url setter가 자동으로 `render()` 호출) |

자세한 내용은 [`EDITING_PLACE_GUN.md`](./EDITING_PLACE_GUN.md) 참조.

---

### `TableKeyboardController`

표 키보드 단축키·셀 블록 선택·구조 편집 컨트롤러. `LayoutTableElement.keyboardController`로 접근.

```ts
class TableKeyboardController {
  // 셀 블록 selection
  get selection(): TableCellSelection | null;
  set selection(value: TableCellSelection | null): void;

  get active(): boolean;
  activate(): void;
  deactivate(): void;

  // 셀 블록 설정 (외부 호출)
  selectCell(td: LayoutTableCellElement): void;

  getSelectedCells(): LayoutTableCellElement[];
  handleKeyDown(event: KeyboardEvent): boolean;

  // 구조 편집 (selection이 null이면 no-op)
  handleMerge(): void;
  insertRowBelow(): void;
  insertRowAbove(): void;
  insertColRight(): void;
  insertColLeft(): void;
  deleteRow(): void;
  deleteCol(): void;
}
```

#### `selectCell(td)`

TD 요소를 전달하여 셀 블록 단일 선택을 설정한다. TD의 `cellLabel`에서 좌표를 추출하여 `selection`을 설정하고 overlay를 갱신한다. 다른 테이블의 기존 selection은 해제한다.

```ts
const td = tableEl.querySelector('x-layout-td');
tableEl.keyboardController.selectCell(td);
```

#### selection 가드

`insertRowBelow`/`insertRowAbove`/`insertColRight`/`insertColLeft`/`deleteRow`/`deleteCol`은 `selection`이 `null`이면 즉시 return한다. 셀 블록 모드에서만 동작한다.

자세한 내용은 [`EDITING_TABLE.md`](./EDITING_TABLE.md) 참조.

---

### `TableStructureEditor`

표 구조 편집 외부 API. `LayoutTableElement.structureEditor`로 접근. selection 가드 없이 직접 호출 가능.

```ts
class TableStructureEditor {
  mergeCells(selection: TableCellSelection): void;
  unmergeCell(cellCoord: CellCoord): void;

  insertRowBelow(): void;
  insertRowAbove(): void;
  insertColRight(): void;
  insertColLeft(): void;

  deleteRow(): void;
  deleteCol(): void;

  equalizeWidth(selection: TableCellSelection): void;
  equalizeHeight(selection: TableCellSelection): void;
}
```

#### 행/열 삽입 동작

- 행 삽입: 현재 행의 높이를 1/2로 분할 (기존 행 절반, 새 행 절반). `MIN_TABLE_ROW_HEIGHT`(5mm) 보장.
- 열 삽입: 현재 열의 너비를 1/2로 분할 (기존 열 절반, 새 열 절반). `MIN_TABLE_COL_WIDTH`(5mm) 보장.

자세한 내용은 [`EDITING_TABLE.md`](./EDITING_TABLE.md) 참조.

---

## Types

### Layout Types

#### `DocumentData`

```ts
type DocumentData = {
  id?: string;                         // 고유 식별자 (선택). 미지정 시 connectedCallback에서 genUUID()로 자동 생성.
  width: number;                       // mm (필수)
  height: number;                      // mm (필수)
  paddingTop?: number;                 // 기본 0
  paddingRight?: number;               // 기본 0
  paddingBottom?: number;              // 기본 0
  paddingLeft?: number;                // 기본 0
  columns: number | number[];          // 균등 분할 또는 명시적 폭
  gap: number | number[];              // 균등 간격 또는 명시적 간격
  paragraphStyle: ParagraphStyle;      // 필수
  textStyle: TextStyle;                // 필수
  children?: BoxData[];
};
```

#### `BoxData`

```ts
type BoxData = {
  type: 'box';
  id?: string;
  left: number;        // mm (static: 컬럼 인덱스)
  top: number;         // mm
  width: number;       // mm (static: 컬럼 수)
  height: number;      // mm (static: 줄 수)
  position?: 'static' | 'absolute';  // 기본 'static'
  zIndex?: number;
  backgroundColor?: string;   // ColorRegistry 등록 이름
  backgroundOpacity?: number; // 0~1, 생략 시 1
  borderTopWidth?: number;
  borderRightWidth?: number;
  borderBottomWidth?: number;
  borderLeftWidth?: number;
  borderColor?: string;
  borderStyle?: 'solid' | 'dotted' | 'dashed';
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  role?: BoxRole;
  contentUid?: string;
  groupMember?: string;
  priority?: number;
  lock?: boolean;
  children?: BoxData[] | ParagraphData | TextData | ImageData | TableData;
};

type BoxPosition = 'static' | 'absolute';
type BoxBorderStyle = 'solid' | 'dotted' | 'dashed';
type BoxRole =
  | 'group-article' | 'body' | 'image' | 'title' | 'caption'
  | 'group-image' | 'header' | 'ad' | 'byline' | 'none';
```

#### `ParagraphData`

```ts
type ParagraphOverlapMode = 'box' | 'none';

type ParagraphData = {
  type: 'paragraph';
  id?: string;
  column?: number | number[];
  gap?: number | number[];
  content: string | (string | TextBlockData)[];
  paragraphStyle?: ParagraphStyle;
  textStyle?: TextStyle;
  zIndex?: number;
  overlapMode?: ParagraphOverlapMode;
};
```

`overlapMode` — 다른 paragraph가 이 paragraph를 감싼 박스를 텍스트 회피 대상으로 취급할지 제어. 기본값 `'box'` (회피 대상). `'none'`으로 설정하면 다른 paragraph가 이 박스와 겹쳐도 텍스트를 회피하지 않는다. byline처럼 본문과 시각적으로 겹치되 텍스트 회피가 필요 없는 영역에 사용. UI에서 직접 설정하지 않고, box의 `role`이 `'byline'`으로 변경되면 layout-editor에서 내부 paragraph의 `overlapMode`를 `'none'`으로 자동 설정한다.

#### `TextData`

```ts
type TextData = {
  type: 'text';
  id?: string;
  content: string;
  paragraphStyle?: ParagraphStyle;
  textStyle?: TextStyle;
};
```

#### `TextBlockData` / `TextPartData` / `TextLineData`

```ts
type TextBlockData = {
  content: string;
  textBlockStyle?: TextBlockStyle;
};

type OverlapParts = { x1: number; x2: number };

type TextPartData = {
  content: string[];
  left: number;     // mm (오버랩 회피 여백)
  width: number;    // mm
};

type TextLineData = {
  firstOfBlock?: boolean;
  firstOfText?: boolean;
  endOfBlock?: boolean;
  endOfText?: boolean;
  parts: TextPartData[];
  textBlockStyle?: TextBlockStyle;
};
```

`TextLineData`는 **내부 전용** — `TextLayoutEngine`이 자동 생성합니다.

#### `ImageData`

`x`/`y`/`width`/`height`는 모두 **mm 단위**로 통일됩니다. 원본 이미지 전체를 `width`×`height`(mm) 크기로 리사이즈하여 박스 내 `(x, y)`에 배치하고, 박스 밖은 캔버스 clip으로 잘립니다(= 크롭). `objectFit`은 편집 UI가 `x`/`y`/`width`/`height`를 계산할 때 참조하는 메타데이터이며 `LayoutImageElement` 렌더링에서는 사용하지 않습니다.

```ts
type ImageObjectFit = 'cover' | 'fill' | 'contain' | 'none';

type OverlapMode = 'path' | 'box' | 'none';

type ImageData = {
  type: 'image';
  id?: string;
  /** 박스 내 이미지 표시 시작 X (mm). 음수면 원본 오른쪽이 크롭. 생략 시 0. */
  x?: number;
  /** 박스 내 이미지 표시 시작 Y (mm). 음수면 원본 아래쪽이 크롭. 생략 시 0. */
  y?: number;
  /** 이미지 표시 너비 (mm). 원본을 이 크기로 리사이즈. 생략 시 박스 너비(absWidth). */
  width?: number;
  /** 이미지 표시 높이 (mm). 원본을 이 크기로 리사이즈. 생략 시 박스 높이(absHeight). */
  height?: number;
  /** 캔버스 렌더링 해상도 (DPI). mm→canvas px 변환 전용. */
  dpi: number;
  /** 이미지 URL. urlLoader가 설정되면 로더를 거쳐 변환. */
  url: string;
  /** 렌더링 순서 (z-index). */
  zIndex?: number;
  /** 오버랩 감지 시 이미지 불투명 픽셀 주변 패딩 (mm). */
  overlapPadding?: number | {
    top?: number; right?: number; bottom?: number; left?: number;
  };
  /**
   * 오버랩 처리 모드. 'path'=불투명 픽셀 윤곽 따라 흐름(기본값),
   * 'box'=박스 rect 기준 회피, 'none'=오버랩 회피 없음.
   */
  overlapMode?: OverlapMode;
  /** 원본 이미지 너비 (mm). Place Gun에서 px/dpi×25.4로 변환하여 주입. */
  originalWidth?: number;
  /** 원본 이미지 높이 (mm). Place Gun에서 px/dpi×25.4로 변환하여 주입. */
  originalHeight?: number;
  /**
   * object-fit 동작 (편집 UI 메타데이터). LayoutImageElement 렌더링 미사용.
   * 편집 UI가 이 값으로 x/y/width/height를 계산. 기본값 'cover'.
   */
  objectFit?: ImageObjectFit;
};
```

#### `TableData`

표 데이터. `BoxData.children`에 직접 지정. 테이블 자체의 위치/크기는 부모 box가 정의하며,
테이블은 부모 box의 콘텐츠 영역을 가득 채운다.

```ts
type TableData = {
  type: 'table';
  id?: string;
  /**
   * 컬럼별 너비(mm).
   * - `number` = 모든 컬럼 동일 너비
   * - `number[]` = 컬럼별 개별 너비. 합이 부모 box 콘텐츠 폭과 일치 권장.
   * - 누락 시 콘텐츠 폭을 컬럼 수로 균등 분할.
   */
  colWidths?: number | number[];
  /** 행 데이터. */
  children: TableRowData[];
};
```

#### `TableRowData`

```ts
type TableRowData = {
  type: 'tr';
  id?: string;
  /** 행 높이(mm). */
  height: number;
  /** 셀 데이터. */
  children: TableCellData[];
};
```

#### `TableCellData`

각 셀은 box들을 자식으로 가지며(paragraph/image/nested-table은 항상 box로 감싸임),
자체 `GridCalculator`(columns=1)를 보유하여 cell 내부를 box 배치 컨텍스트로 동작시킨다.

```ts
type CellBorderEdge = {
  width: number;                                    // 두께(mm)
  color: string;                                    // ColorRegistry CMYK 이름
  style?: 'solid' | 'dotted' | 'dashed';            // 기본 'solid'
};

type TableCellData = {
  type: 'td';
  id?: string;
  colspan?: number;                                 // 열 병합. 기본 1
  rowspan?: number;                                 // 행 병합. 기본 1
  /** 방향별 보더 엣지 선언. 인접 셀과 공유됨. 테이블 렌더 단계에서 border-collapse로 한 번만 그려짐. */
  borderTop?: CellBorderEdge;
  borderRight?: CellBorderEdge;
  borderBottom?: CellBorderEdge;
  borderLeft?: CellBorderEdge;
  backgroundColor?: string;                         // ColorRegistry CMYK 이름
  backgroundOpacity?: number;                       // 0~1, 생략 시 1
  /** 대각선. 셀 내부에 그려짐. 복수 지정 가능(X 표시). */
  diagonals?: Array<'tl-br' | 'tr-bl'>;
  paddingTop?: number;                             // mm, 기본 0
  paddingRight?: number;                            // mm, 기본 0
  paddingBottom?: number;                           // mm, 기본 0
  paddingLeft?: number;                             // mm, 기본 0
  /** 셀 내용. BoxData[]만 허용. */
  children: BoxData[];
};
```

#### `GuideColumnData`

```ts
type GuideColumnData = {
  type: 'guide-column';
  id?: string;
  left: number;
  top: number;
  width: number;
  height: number;
  visible: boolean;
  fontSize: number;
  lineHeight: number;
};
```

### Style Types

#### `TextStyle`

```ts
type TextStyle = {
  color?: string;          // CSS 색상 또는 CMYK 이름
  fontFamily?: string;
  fontWeight?: number;     // 기본 400
  fontStyle?: 'normal' | 'italic';
  fontSize?: number;       // mm, 기본 4
  letterSpacing?: number;  // em
  widthRatio?: number;     // 장평, 기본 0.8
  spaceRatio?: number;     // 공백 최소 너비 (em), 기본 0.25
  indent?: number;         // 문단 첫 줄 들여쓰기 (fontSize 대비 비율, 0.0~1.0), 기본 0
};
```

#### `ParagraphStyle`

```ts
type ParagraphStyle = {
  lineGap?: number;        // lineHeight = fontSize × lineGap, 기본 1.25
  verticalAlign?: 'top' | 'center' | 'bottom';  // 기본 'top'
  textAlign?: 'left' | 'right' | 'center' | 'justify';  // 기본 'justify'
};
```

#### `TextBlockStyle`

```ts
type TextBlockStyle = {
  fontFamily?: string;
  fontSize?: number;       // mm
  fontWeight?: number;
  color?: string;
  textAlign?: 'left' | 'right' | 'center' | 'justify';
};
```

#### `InheritStyle`

```ts
type InheritStyle = TextStyle & ParagraphStyle & {
  parentWidth: number;     // mm
  parentHeight: number;    // mm
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
};
```

### Print Types

#### `PrintPostData`

```ts
type PrintPostData<T = BoxData | ImageData | ParagraphData> = {
  color?: CMYKColor;       // 인쇄용 CMYK 색상
  data: T;                 // 원본 데이터. data.type이 요소 종류 구분자
  rect: PrintPostDataRect;
  chars?: PrintPostDataChar[];  // paragraph 전용. 글자별 렌더링 정보
};

type PrintPostDataRect = {
  x: number;      // viewport 픽셀
  y: number;
  width: number;
  height: number;
};

type PrintPostDataChar = {
  char: string;              // 글자
  rect: PrintPostDataRect;   // 글자별 위치·크기 (픽셀)
  fontFamily: string;        // CSS font-family
  fontSize: string;           // 폰트 크기 (mm 또는 px)
  fontWeight: string;        // CSS font-weight
  widthRatio: number;        // 장평 비율 (CSS scale에서 추출)
  color: CMYKColor;           // CMYK 색상 (ColorRegistry에서 색상 명칭으로 조회)
};
```

`PrintPostDataChar.color` 결정 우선순위 (화면 렌더링 `genPartStyle()`의 CSS 상속과 동일):

1. `lineData.textBlockStyle.color` — 블록 단위 오버라이드
2. `paragraph.textStyle.color` — 단락 수준 글자 스타일
3. `paragraph.inheritStyle.color` — 부모에서 상속된 색상
4. `ColorRegistry.get('default')` — 폴백 (`_defaultColor`, `init()` 후 `{ c:0, m:0, y:0, k:255 }`)

`textBlockStyle.color`만 확인하면 단락 레벨(`textStyle.color`)이나 상속(`inheritStyle.color`)으로 색상을 지정한 일반 텍스트가 검은색 default로 폴백되어, 검은 배경 박스 안의 흰 글자가 보이지 않는 버그가 발생한다.

#### `ColorMap`

```ts
type ColorMap = {
  rgb: RGBColor;
  cmyk: CMYKColor;
};

type RGBColor = { r: number; g: number; b: number };
type CMYKColor = { c: number; m: number; y: number; k: number };
type CMYKColorSet = { [name: string]: CMYKColor };
```

### Edit Types

#### `CursorPosition`

```ts
type CursorPosition = {
  textOffset: number;  // 0-based, '\n' 포함
};
```

#### `SelectionRange`

```ts
class SelectionRange {
  readonly anchor: CursorPosition;
  readonly focus: CursorPosition;

  constructor(anchor: CursorPosition, focus: CursorPosition);

  /** 오프셋 두 개로 SelectionRange 생성 */
  static fromOffsets(anchor: number, focus: number): SelectionRange;

  /** anchor/focus를 문서 순서대로 정렬 */
  normalized(): { start: CursorPosition; end: CursorPosition };
}
```

#### `InsertMode` / `InsertEventDetail`

```ts
type InsertType = 'box' | 'text' | 'paragraph' | 'image';
type InsertPosition = 'absolute' | 'static';

interface InsertMode {
  type: InsertType;
  position: InsertPosition;
}

interface InsertEventDetail {
  type: InsertType;
  position: InsertPosition;
  element: HTMLElement;    // 삽입된 박스
  container: HTMLElement;  // 부모
  left: number;            // static: 컬럼 인덱스, absolute: mm
  top: number;             // static: 라인 인덱스, absolute: mm
  width: number;
  height: number;
  zIndex: number;
  canceled: boolean;       // ESC로 취소 시 true
}
```

#### `LayoutElement` (EditManager 보조 타입)

```ts
type LayoutElement = LayoutBoxElement;
```

#### `PlaceGunItem` / `PlaceGunChangeEventDetail`

```ts
type PlaceGunContentType = 'text' | 'image';
type PlaceGunSubType = 'article' | 'image' | 'ad';

type ArticleContent = {
  uid: string;       // 기사 고유 식별자
  title: string;     // 기사 제목
  body: string;       // 기사 본문 텍스트
};

type ImageContent = {
  uid: string;        // 이미지/광고 고유 식별자
  caption: string;    // 이미지/광고 설명 (캡션)
  url: string;         // 이미지/광고 접근 URL
  /** 원본 이미지 너비 (픽셀). Place Gun 주입 시 ImageData.originalWidth로 전달. */
  width: number;
  /** 원본 이미지 높이 (픽셀). Place Gun 주입 시 ImageData.originalHeight로 전달. */
  height: number;
  /** 이미지 해상도 (DPI). Place Gun 주입 시 ImageData.dpi로 전달. */
  dpi: number;
};

type PlaceGunItem = {
  contentType: PlaceGunContentType;
  subType: PlaceGunSubType;        // URL 패턴 결정용
  title: string;                    // 패널 표시용 제목
  sourceId: string;                 // 원본 컨텐츠 고유 식별자
  content: ArticleContent | ImageContent;
};

type PlaceGunChangeEventDetail = {
  items: PlaceGunItem[];
  paused: boolean;
};
```

자세한 Place Gun 동작 명세는 [`EDITING_PLACE_GUN.md`](./EDITING_PLACE_GUN.md) 참조.

---

## Constants

`@/constants`에서 export되는 모든 상수:

| 이름 | 값 | 단위 | 설명 |
|---|---|---|---|
| `DEFAULT_BORDER_STYLE` | `'solid'` | — | 박스 테두리 기본 스타일. |
| `DEFAULT_FONT_SIZE` | `4` | mm | 글자 크기 기본값. |
| `DEFAULT_FONT_STYLE` | `'normal'` | — | 폰트 스타일 기본값. |
| `DEFAULT_FONT_WEIGHT` | `400` | — | 폰트 굵기 기본값. |
| `DEFAULT_LINE_GAP` | `1.25` | — | `lineHeight = fontSize × lineGap`. |
| `DEFAULT_PPM` | `96 / 25.4` | px/mm | 화면 DPI 기준 픽셀/mm 비율. |
| `DEFAULT_IMAGE_DPI` | `72` | DPI | 이미지 기본 해상도. |
| `DEFAULT_SPACE_RATIO` | `0.25` | em | 공백 최소 너비. |
| `DEFAULT_LETTER_SPACING` | `-0.1` | em | 자간. |
| `DEFAULT_WIDTH_RATIO` | `0.8` | — | 장평 (글자 가로폭 비율). |
| `DEFAULT_TEXT_ALIGN` | `'justify'` | — | 양쪽 정렬. |
| `DEFAULT_VERTICAL_ALIGN` | `'top'` | — | 상단 정렬. |
| `Z_INDEX_MAX_LAYOUT` | `90000` | — | 레이아웃 요소 zIndex 최댓값. 90001 이상은 예약 범위. |
| `Z_INDEX_RESIZE_HANDLE` | `99999` | — | 예약: 리사이즈 핸들. |
| `Z_INDEX_TYPE_LABEL` | `99998` | — | 예약: 타입 라벨. |
| `Z_INDEX_INSERT_PREVIEW` | `99997` | — | 예약: 삽입 미리보기 오버레이. |
| `Z_INDEX_AI_PROCESSING` | `99996` | — | 예약: AI 처리 중 오버레이. |
| `Z_INDEX_TEXTAREA` | `9999` | — | 예약: 텍스트 편집 textarea (IME 입력). |
| `Z_INDEX_ROLE_AD` | `91000` | — | 역할 고정 z-index: 광고 (ad). |
| `Z_INDEX_ROLE_HEADER` | `91001` | — | 역할 고정 z-index: 면머리 (header). |

---

## Utilities

`@/utils`에서 export되는 함수들. 패키지 진입점(`src/index.ts`)이 `export * from './utils'`로
재노출하므로 `import { genUUID, checkOverlap } from 'layout-element'`로 직접 가져올 수 있다.

> `genRandom`은 `@/utils/random.ts`에 존재하지만 `utils/index.ts`에서 export되지 않으므로
> 패키지 진입점에서도 사용할 수 없다.

### `checkOverlap(base, target)`

```ts
/**
 * 두 요소의 화면 사각형이 교차하는지 검사.
 *
 * @param baseElement - 기준 요소
 * @param targetElement - 대상 요소
 * @returns 화면상 교차 여부
 */
const checkOverlap: (base: HTMLElement, target: HTMLElement) => boolean;
```

### `mergeOverlapParts(parts)`

```ts
/**
 * 인접한 오버랩 구간을 병합.
 *
 * @param parts - 오버랩 구간 배열
 * @returns 병합된 구간 배열
 */
const mergeOverlapParts: (parts: OverlapParts[]) => OverlapParts[];
```

### `getOverlapSizeMm(lineRectMm, overlayElement)`

```ts
/**
 * 오버랩 크기 계산 (mm 좌표계). 이미지 overlapPadding 적용 시 타원형 감지.
 *
 * @param lineRectMm - 라인 영역 (mm)
 * @param overlayElement - LayoutBoxElement (보통 이미지 박스)
 * @returns { direction: 'NONE' | 'COVERS' | 'PART', parts: OverlapParts[] }
 */
const getOverlapSizeMm: (
  lineRectMm: MmRect,
  overlayElement: LayoutBoxElement,
) => { direction: 'NONE' | 'COVERS' | 'PART', parts: OverlapParts[] };
```

### `genUUID()`

```ts
/**
 * 랜덤 ID 생성 (`Date.now()` 기반 BigInt → base36).
 * 박스/단락/이미지 요소의 기본 id로 사용.
 */
const genUUID: () => string;
```

### `genRandom(min?, max?)`

```ts
/** `Math.random()` 기반 헬퍼. 패키지 진입점에서 export되지 않음. */
const genRandom: (min?: number, max?: number) => number;
```

### `flipLayoutData(data, options, metricsById)`

```ts
/**
 * 문서 레이아웃 데이터의 배치를 좌우/상하/상하좌우 반전한다.
 * 순수 함수: 입력 데이터 트리를 변환하여 새 트리를 반환한다. 원본은 변경하지 않는다.
 *
 * targetId 지정 시 해당 id를 가진 박스가 root가 되며, root 박스의 하위 요소들만 반전한다.
 * root 박스 자체(위치/보더/패딩)는 유지된다.
 * targetId 생략 시 문서가 root이며, 문서의 하위 박스들만 반전한다.
 *
 * 반전 범위 (root의 하위 요소):
 * - Box 위치/크기 (position static/absolute 분기)
 *   - absolute + document 부모: left = containerWidth - left - width (padding 포함)
 *   - absolute + box 부모: left = innerWidth - left - width (padding 제외)
 * - Paragraph 단 설정 (column/gap 배열 역순, 좌우 반전 시)
 * - Box 보더/패딩 방향 교환 (T↔B, L↔R)
 * - 하위 Box 트리 재귀 반전
 *
 * 반전 제외 (leaf 컨텐츠):
 * - Image 내부 설정 (x/y/width/height/크롭/objectFit)
 * - Table 셀 배치/순서/병합/보더 방향
 * - Text content (LTR 유지, 거울 모드 아님)
 *
 * metricsById: static 박스의 width/height는 컬럼 span 수 / 라인 수이지 mm가 아니다.
 * 따라서 absolute 자식 반전 시 부모 박스의 mm 내부 영역을 알기 위해
 * 각 박스 id별 실제 mm 크기를 외부에서 주입해야 한다.
 * LayoutDocumentElement.flipLayout()이 DOM에서 수집하여 전달한다.
 *
 * @param data - 원본 문서 데이터
 * @param options - 반전 옵션
 * @param options.axis - 반전 축 ('horizontal' | 'vertical' | 'both')
 * @param options.targetId - 반전 root 박스 id. 생략 시 문서가 root.
 * @param metricsById - 각 박스 id별 mm 크기 map. static 박스의 absolute 자식 반전에 필요.
 * @returns 반전된 새 문서 데이터
 * @throws {Error} targetId가 지정되었으나 해당 id를 가진 박스를 찾지 못한 경우
 *
 * @example
 * // 문서의 하위 박스들을 좌우 반전
 * const flipped = flipLayoutData(doc, { axis: 'horizontal' }, metricsById);
 * documentEl.data = flipped;
 *
 * // 특정 박스의 하위 요소들만 상하 반전
 * const flipped = flipLayoutData(doc, { axis: 'vertical', targetId: 'box-42' }, metricsById);
 * documentEl.data = flipped;
 *
 * // 180도 회전 (상하+좌우)
 * const flipped = flipLayoutData(doc, { axis: 'both' }, metricsById);
 * documentEl.data = flipped;
 */
function flipLayoutData(
  data: DocumentData,
  options: FlipLayoutOptions,
  metricsById: BoxMetricsById,
): DocumentData;
```

#### `FlipAxis`

```ts
type FlipAxis = 'horizontal' | 'vertical' | 'both';
```

#### `FlipLayoutOptions`

```ts
type FlipLayoutOptions = {
  axis: FlipAxis;
  targetId?: string;
};
```

#### `BoxMetricsById`

```ts
type BoxMetricsById = Map<string, { absWidth: number; absHeight: number }>;
```

### AI Processing Overlay 헬퍼

`<x-layout-paragraph>`와 `<x-layout-image>`의 AI 처리 중 오버레이를 관리하는 4개 함수.
모든 함수는 shadow DOM 내부에 오버레이 요소를 생성/토글/제거한다.

#### `createAiProcessingOverlay(shadowRoot)`

```ts
/**
 * AI 처리 중 오버레이를 shadow DOM에 생성한다.
 * shadow root에 `<style>`과 `<div>`를 한 번만 주입한다.
 * 오버레이는 기본적으로 `display: none` 상태이며, `setAiProcessingActive`로 활성화한다.
 *
 * @param shadowRoot - 오버레이를 삽입할 shadow root
 * @throws stylesheet 생성에 실패한 경우
 *
 * @example
 * createAiProcessingOverlay(this._shadowRoot);
 */
function createAiProcessingOverlay(shadowRoot: ShadowRoot): void;
```

#### `setAiProcessingActive(shadowRoot, active)`

```ts
/**
 * AI 처리 중 오버레이의 활성화 상태를 토글한다.
 * 오버레이가 shadow DOM에 없으면 아무 작업도 수행하지 않는다.
 * `layout()`/`render()`를 트리거하지 않으므로 비용이 거의 없다.
 *
 * @param shadowRoot - 오버레이가 위치한 shadow root
 * @param active - `true`면 오버레이 표시, `false`면 숨김
 *
 * @example
 * setAiProcessingActive(this._shadowRoot, true);  // AI 처리 시작
 * setAiProcessingActive(this._shadowRoot, false); // AI 처리 완료
 */
function setAiProcessingActive(shadowRoot: ShadowRoot, active: boolean): void;
```

#### `isAiProcessingActive(shadowRoot)`

```ts
/**
 * AI 처리 중 오버레이의 현재 활성화 상태를 반환한다.
 * 오버레이가 shadow DOM에 없으면 `false`를 반환한다.
 *
 * @param shadowRoot - 오버레이가 위치한 shadow root
 * @returns 활성화 여부. 오버레이 미존재 시 `false`
 *
 * @example
 * if (isAiProcessingActive(this._shadowRoot)) { /* AI 처리 중 *\/ }
 */
function isAiProcessingActive(shadowRoot: ShadowRoot): boolean;
```

#### `removeAiProcessingOverlay(shadowRoot)`

```ts
/**
 * AI 처리 중 오버레이를 shadow DOM에서 제거한다.
 * `disconnectedCallback` 등에서 호출하여 잔류 DOM을 정리한다.
 * 오버레이가 없으면 아무 작업도 수행하지 않는다.
 *
 * @param shadowRoot - 오버레이가 위치한 shadow root
 *
 * @example
 * disconnectedCallback() {
 *   removeAiProcessingOverlay(this._shadowRoot);
 * }
 */
function removeAiProcessingOverlay(shadowRoot: ShadowRoot): void;
```

---

## Examples

`@/examples`에서 export되는 데모 데이터:

```ts
export const exampleData: DocumentData;  // 신문 1면 데모
```

`exampleData`는 5-컬럼 신문 레이아웃으로, 다음을 포함합니다:
- 제목 (10mm 큰 글씨)
- 3개 본문 단락 (이미지 오버랩 회피 포함)
- 광고 박스 (외곽선)

```ts
import { exampleData } from 'layout-element';

const doc = document.querySelector('x-layout-document')!;
doc.data = exampleData;
```

---

## 이벤트 레퍼런스

| 이벤트 | 발생 시점 | 대상 | `detail` |
|---|---|---|---|
| `render-error` | 단락 오버플로우 시 | `<x-layout-paragraph>` | `{ id, type: 'text-overflow', overflow: number }` |
| EditManager `focusChange` | 포커스 변경 | `EditManager` | `{ paragraph, controller, previousParagraph, previousController }` |
| EditManager `textChange` | 텍스트 변경 | `EditManager` | `{ paragraph, controller }` |
| EditManager `styleChange` | 스타일 변경 | `EditManager` | `{ paragraph, controller }` |
| EditManager `selectionStart` | 선택 시작 | `EditManager` | `{ paragraph, controller }` |
| EditManager `selectionEnd` | 선택 종료 | `EditManager` | `{ paragraph, controller }` |
| EditManager `cursorMove` | 커서 이동 | `EditManager` | `{ paragraph, controller }` |
| EditManager `layoutSelectionChange` | 레이아웃 선택 변경 | `EditManager` | `{ selectedLayouts, previousLayouts, ... }` |
| EditManager `layoutMove` | 박스 이동 | `EditManager` | `{ layoutElement, previousLeft, left, previousTop, top, canceled }` |
| EditManager `layoutResize` | 박스 리사이즈 | `EditManager` | `{ layoutElement, previousWidth, width, previousHeight, height }` |
| EditManager `insert` | 삽입 완료 | `EditManager` | `InsertEventDetail` (extend with `type`, `paragraph`, `controller`) |
| EditManager `insertCancel` | 삽입 취소 | `EditManager` | `{ type: 'insertCancel', ... }` |

이벤트는 모두 `bubbles: true, composed: true` (DOM 표준)이며, Shadow DOM 경계를
가로질러 전파됩니다.

---

## 인쇄 모드 가이드

인쇄 모드(`window.matchMedia("print").matches === true`)에서는 다음이 달라집니다:

1. **자동 로딩 비활성**: `ColorRegistry`와 `FontLoader`는 `fetch`를 호출하지 않음.
2. **수동 데이터 주입**: `init({...})` 호출 시 `colorSet`/`fonts`를 명시.
3. **렌더링 수동**: `<x-layout-document>`의 `connectedCallback`이 즉시 리턴하므로
   `data` 설정 후 `layout()` + `render()`를 수동 호출.
4. **이미지/가이드 숨김**: `@media print` CSS 규칙으로 `visibility: hidden`.
5. **편집 차단**: `editableLayout`/`editableText` setter는 인쇄 모드에서 무시.
6. **printPostData**: 각 요소의 화면상 위치/크기를 `printPostData` getter로 수집하여
   후처리 시스템에 전달.

```ts
// 인쇄 모드 진입
const colorSet = { black: { c:0, m:0, y:0, k:255 } };
const fonts = [
  { family: 'Myoungjo', weight: 400, style: 'normal' as const, base64Data: '...' },
];
await ColorRegistry.getInstance().init(colorSet);
await FontLoader.getInstance().init(fonts);

const doc = document.querySelector('x-layout-document')!;
doc.data = printDocumentData;
doc.layout();
await doc.render();

const postData = doc.printPostData;
// → 외부 인쇄 시스템에 전달
```

---

## 추가 참고

- **렌더링 파이프라인**: `layout()` (동기, 모델/스타일/DOM 구축) → `render()` (비동기, 이미지/텍스트).
- **단락 성능 최적화**: `data-source-offset` 키 기반 diff 렌더링. 변경이 없는 span은 재사용.
- **이미지 오버랩**: `overlapPadding`이 설정되면 타원형(`ndx² + ndy² ≤ 1`)으로 텍스트 회피 영역 계산.
- **lock 의미**: 박스 자신과 모든 자손이 drag/resize/text edit에서 제외됨.
- **편집기 자동 생성**: `paragraph.editableText = true` 시 `TextEditController`가 자동 생성되고 `EditManager`에 등록.
- **React 사용자**: [`REACT_COMPONENT.md`](./REACT_COMPONENT.md) 참고.
