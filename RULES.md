# RULES.md — layout-element

본 파일은 코드 수정 시 반드시 지켜야 할 규칙과, 의도적 설계 결정, 피해야 할 실수를 기록한다.

---

## 1. 텍스트 레이아웃 엔진 규칙

### 1.1 `_charWidthMm()` 측정 방식

- **반드시 `glyph.advanceWidth / unitsPerEm * fontSize`를 사용할 것.** `actualBoundingBoxLeft + actualBoundingBoxRight`는 잉크 영역만 측정하여 좁은 문자(i, l, j)와 공백의 폭을 과소측정한다.
- **`minWidthMm = spaceRatio * fontSize` 하한 클램프.** 0폭 문자가 렌더링되는 것을 방지한다.
- **`rawWidth * widthRatio`를 곱하지 말 것.** `maxWidthMm = widthRatio * fontSize` 상한 클램프가 장평 비율을 반영한다. 이중 적용 방지.

### 1.2 `genCharStyle()` 스타일 생성

- **`maxWidth`는 `${widthRatio}em`, `scale: ${widthRatio * 0.88} 1` 함께 사용.** `maxWidth`는 레이아웃 박스 너비 제한, `scale`은 글자 모양 축소. 둘 다 함께 사용해야 장평 적용.
- **`scale` 제거 금지.** 글자 모양이 축소되지 않아 장평 효과가 사라진다.
- **`minWidth` 유지:** 공백/전각 `0.5em`, 반각 `0.35em`. `fontSize`에만 비례, `widthRatio` 영향 없음.

### 1.3 `_layoutTextIntoColumns()` 무한 루프 방지

- 문자가 모든 파트 너비보다 클 경우(`charWidth > maxPartWidth`) 첫 번째 파트에 강제 배치 후 `break`. 이 가드를 제거하면 무한 루프 발생.

### 1.4 COVER 라인은 세로 공간을 차지함

- COVER 라인(이미지가 라인 전체를 덮음)은 `parts: []`이지만 라인 자체는 세로 공간을 차지한다. 버그가 아님. `scrollHeight`를 0으로 만들면 안 됨.

### 1.5 `_overlayRectsMm` 캐시 수명 주기

- `_layoutTextIntoColumns()` 시작 시 `null` 리셋.
- 첫 `_detectOverlapWithCache` 호출 시 `Map` 생성 후 모든 오버랩 요소 측정.
- 이후 동일 렌더링 사이클 내에서는 `Map.get(el)`로 재사용.
- 제거 시 라인마다 `absRect` 게터가 호출되어 성능 저하.

### 1.6 중첩 box의 이미지 참조 시 `contentElement` 사용

- `contentType === 'image'`가 `true`여도 `items[0]`이 `LayoutImageElement`가 아닐 수 있다 (`box(A) → box(B) → image(C)` 구조).
- `items[0] as LayoutImageElement` 캐스트는 잘못된 요소를 참조한다.
- **반드시 `contentElement` 게터를 사용하여 실제 image 요소를 얻을 것.** `contentElement`는 `contentType`과 동일한 재귀 경로를 따른다.
- canvas 픽셀 매핑에도 이미지 요소의 rect를 사용해야 함.

### 1.7 `_layoutCache` 보존 규칙

- `ParagraphEngine.data` setter는 `resetIncrementalState()`를 호출하여 `_layoutCache`를 null로 만든다.
- overlay 위치만 변경된 경우 `data` setter 대신 `updateOverlayContext()`를 사용하여 `_layoutCache`를 보존한다.
- `_layoutStructure()`는 구조 변경(`_perfStructureChanged === true`) 시에만 호출해야 한다.
- `updateOverlayContext()`는 `_overlayRectsMm`만 null로 리셋하고 `_layoutCache`를 보존한다.
- `_computeLayoutInputHash()`가 overlay 위치를 포함하므로, 위치가 동일하면 `layoutText()`가 캐시 hit로 O(1) 스킵.

### 1.8 static box 렌더링 높이 원칙 — 마지막 라인 line gap 제외

> **CRITICAL — 이 원칙은 드래그 클램핑, 리사이즈, containment 검사, 좌표 변환 등
> static box의 높이가 관여하는 모든 계산에서 일관되게 적용되어야 한다.
> 위반 시 "박스가 부모 하단까지 내려가지 않는" 버그가 반복적으로 재발한다.**

**원칙**: static box의 렌더링 높이 N라인 = `(N-1) * lineHeight + fontSize`.
마지막 라인의 line gap(= `lineHeight - fontSize`)은 렌더링에서 제외된다.

이는 `BoxEngine.absHeight`의 공식(`lineHeight * height - (lineHeight - fontSize)`)과 동일하며,
`ParagraphEngine._computeAlignOffsetMm`의 `contentHeightMm = (visibleLineCount - 1) * lineHeight + fontSize`와도 일치한다.

**파생 공식** — 박스의 렌더링 하단(top 기준)이 부모의 `editableTextHeight`를 넘지 않아야 할 때:

```
(top + height - 1) * lineHeight + fontSize ≤ editableTextHeight

maxTop      = floor((editableTextHeight - fontSize) / lineHeight) - height + 1
maxLines    = floor((editableTextHeight - fontSize) / lineHeight) + 1
maxHeight   = floor((editableTextHeight - fontSize) / lineHeight) - top + 1
```

**절대 금지** — 다음 공식들은 `fontSize`를 무시하여 마지막 라인의 line gap만큼
클램핑이 너무 일찍 걸리거나 containment가 너무 빡빡하게 잡힌다:

```
// WRONG — fontSize 누락
maxTop      = floor(editableTextHeight / lineHeight) - height
maxLines    = floor(editableTextHeight / lineHeight) + 1
containerLineCount = floor(editableHeight / lineHeight) + 1
```

**적용 대상** (모두 `parentModel.fontSize`와 `editableTextHeight`를 사용):

| 위치 | 계산 | 올바른 공식 |
|---|---|---|
| `layout-edit-controller.ts` `_computeNewPosition` | `maxTop` (드래그 이동) | `floor((editableTextHeight - fontSize) / lineHeight) - height + 1` |
| `layout-edit-controller.ts` `_computeNewSize` | `maxLines` (리사이즈) | `floor((editableTextHeight - fontSize) / lineHeight) + 1` |
| `static-grid-containment.ts` `clampStaticToContainer` | `containerLineCount` | `floor((editableTextHeight - fontSize) / lineHeight) + 1` |
| `static-grid-containment.ts` `staticGridContains` | `containerLineCount` | `floor((editableTextHeight - fontSize) / lineHeight) + 1` |

**새 코드 작성 시 체크리스트**:
- [ ] static box 높이 계산에 `fontSize`가 포함되어 있는가?
- [ ] `editableTextHeight`를 사용하고 있는가? (`editableHeight`가 아님 — 전자는 padding 제외 전체 높이, 후자는 lineHeight 배수로 버림된 값)
- [ ] 드래그/리사이즈/containment/삽입/재배치(reparent) 중 하나라도 static 좌표를 다룬다면 위 표의 공식을 적용했는가?

---

## 2. 편집 컨트롤러 규칙

### 2.1 마우스 좌표 저장

- 모든 mousemove 이벤트에서 `clientX`/`clientY`를 인스턴스에 저장. `requestAnimationFrame` 콜백에서 `event.clientX`를 직접 읽으면 첫 번째 이벤트의 좌표만 사용되어 빠른 드래그 시 선택 영역이 뒤처진다.

### 2.2 커서 위치 — 빈 공간 클릭

- 줄 끝 빈 공간 클릭 → 마지막 글자 뒤에 커서 위치 (`x >= rightmostRight` → `rightmostSource + 1`).
- 줄 앞 빈 공간 클릭 → 첫 글자 앞에 커서 위치 (`x <= leftmostLeft` → `leftmostSource`).
- 두 검사는 midpoint 검사 **이전**에 수행.

### 2.3 커서 높이 — 공백 문자

- 공백 문자 span은 `getBoundingClientRect().height === 0`이다.
- `rect.height <= 1`이면 `getFirstColumnRect().fontSize`를 lineHeight 폴백으로 사용.
- 커서 `top` 위치는 `_resolveFallbackTop()`으로 결정. 우선순위: 인접 가시 문자 `rect.top` → 라인 div `top` → span `rect.top` → 첫 컬럼 `top`.
- **`rect.top - cursorHeight` 사용 금지.** 라인 끝 스페이스처럼 인접 가시 문자가 모두 height≈0일 때 위 라인으로 커서가 올라가는 버그 발생.

### 2.4 라인 끝 커서 배치 — phantom end placement

- trailing space 없이 끝나는 라인의 마지막 가시 문자 다음 offset은 다음 라인 첫 글자의 offset과 동일.
- `_lineEndPlacements` 맵에 phantom end placement를 별도 저장.
- `getCursorPlacement(offset, preferLineEnd=true)`로 조회 시 라인 끝 배치 우선 반환.
- `crossRightState === 'crossed'`일 때만 `preferLineEnd=false`로 다음 라인 첫 글자 왼쪽에 배치.

### 2.5 스페이스 문자 커서 배치

- **중간 스페이스**: 커서가 스페이스 **앞**(왼쪽). `atEndOfChar: false`.
- **라인 마지막 trailing space**: 커서가 스페이스 **뒤**. `atEndOfChar: true`.
- **금지**: `placement.atEndOfChar === false`일 때 span 텍스트가 `' '`인지 검사하여 강제로 `true`로 바꾸면 안 됨. 모든 중간 스페이스를 뒤로 밀어버려 ArrowRight 시 커서가 뒤로 가는 버그 발생.

### 2.6 커서 너비

- `<x-layout-cursor>`는 고정 1px 너비. 깜빡이지 않음. 2px 이상은 인접 문자와 겹쳐 보임.

### 2.7 Zero-height span 주의사항

- 공백 문자의 span은 `height === 0`, `width ≈ 0`, `top` 값이 실제 텍스트 줄과 다름.
- 모든 좌표 계산 메서드에서 이 속성을 반드시 고려해야 함.
- `_computeVerticalOffset`: `height === 0`이면 `fontSize`를 lineHeight 폴백으로 사용. 반환값이 현재 offset과 같으면 `null` 반환 (이동 없음).
- `findVisualLineBounds`: `anchorRect.height <= 1`일 때 가장 가까운 가시 span의 `top` 사용. `lineSpans` 수집 시 `height <= 1` span 제외.

### 2.8 편집 기능 회귀 방지 — 필수 검증

편집 컨트롤러/좌표 매퍼 수정 시 브라우저에서 수동 검증:
1. ArrowLeft / ArrowRight 한 글자씩 이동
2. ArrowUp / ArrowDown 시각적 줄 단위 이동 (공백 앞/뒤에서도)
3. Home / End 시각적 줄 시작/끝 이동
4. Ctrl+ArrowLeft / Ctrl+ArrowRight 단어 단위 이동
5. 클릭으로 커서 배치 (공백 위, 줄 끝 빈 공간)
6. IME 조합 (한국어 입력)

회귀의 가장 흔한 원인: **공백 문자의 zero-height span**을 일반 문자와 동일하게 처리.

---

## 3. 엔진-DOM 동기화 규칙 (엔진 우선 원칙)

> **CRITICAL — 본 섹션의 규칙 위반은 아키텍처를 파괴한다.**
> 엔진은 향후 canvas 렌더링으로 전환되므로, DOM 의존성이 추가되면 전환이 불가능해진다.

### 3.0 엔진/DOM 경계 — 절대 규칙 (위반 시 PR 반려)

1. **엔진은 DOM을 참조하지 않는다.** `src/engine/` 내에서 `HTMLElement`, `localName`, `items`, `_rawData()`, `querySelector`, `getAttribute`, `style` 등 DOM API/요소를 사용하지 않는다. 엔진은 **순수 데이터**만 다룬다.

2. **엔진은 `_data.children`을 저장하지 않는다.** `engine.layout(childrenData)`로 자식 데이터를 **파라미터**로 받는다. `engine.data` setter는 자신의 속성만 설정한다. `_data.children`을 읽어 자식 엔진을 구축하는 것은 금지.

3. **DOM 요소는 `this._children`/`this._rows`/`this._cells`를 저장하지 않는다.** 자식 데이터가 필요할 때 `this.items.map(e => e._rawData())`로 그때그때 수집한다. 저장하면 부모-자식 간 동기화 문제가 발생한다.

4. **`engine.layout()` 시그니처:**
   - `BoxEngine.layout(ctx, childrenData, resources?, docStyle?)`
   - `DocumentEngine.layout(childrenData?)`
   - `TableEngine.layout(rowsData?)`
   - `childrenData`는 순수 데이터 배열만 허용. DOM 요소 배열(`HTMLElement[]`) 전달 금지.

5. **DOM → 엔진 데이터 전달 경로:**
   ```
   _layoutStructure()
     → engine.data = { ...ownProps }  // children 제외
     → engine.layout(this.items.map(e => e._rawData()))  // 자식 데이터만 파라미터로
   ```
   이 경로는 DOM 렌더링을 위한 **잠정적 중간 상태**다. canvas 전환 후 제거된다.

6. **엔진 → 외부 데이터 추출:** `extractData`는 `_childEngines.map(e => e.extractData)`로 자식 엔진에서 조립. `_data.children`에서 읽지 않는다.

7. **새 엔진 추가/수정 시 체크리스트:**
   - [ ] `src/engine/` 내에서 DOM import/참조가 없는가?
   - [ ] `engine.data` setter에 `children` 필드가 없는가?
   - [ ] `engine.layout()`이 자식 데이터를 파라미터로 받는가?
   - [ ] `extractData`가 자식 엔진에서 조립하는가?

### 3.1 엔진이 단일 소스 오브 트루스

- 엔진 트리가 모든 레이아웃 계산의 단일 소스다. DOM은 엔진을 보완/대체하지 않는다.
- DOM은 엔진 결과를 소비만 한다. 엔진을 생성/수정하지 않는다.
- 편집 발생 시: 편집된 내용 → `DocumentData`/`BoxData` 직렬화 → 엔진 재처리 → 결과 DOM 전파.
- DOM에서 엔진 `childEngines`을 수동으로 채우지 말 것.
- **DOM 요소는 `this._children`/`this._rows`/`this._cells`를 저장하지 않는다.** 자식 데이터는 `this.items.map(e => e._rawData())`로 그때그때 수집. 저장 시 부모-자식 동기화 버그 발생.
- **엔진은 `_data.children`을 저장하지 않는다.** `engine.layout(childrenData)` 파라미터로만 자식 데이터 수신.

### 3.2 `disconnectedCallback` — 엔진 splice 금지

- `disconnectedCallback`에서 엔진을 부모의 `childEngines`/`childBoxEngines`에서 splice하지 않는다.
- `data` setter의 ID-keyed reconcile이 `appendChild`로 자식을 재배치할 때 `disconnectedCallback` → `connectedCallback`이 같은 부모 내에서 발생. splice 시 `findBoxEngineById`가 기존 엔진을 못 찾아 새 엔진 생성 → 엔진 상태(rgbaData, _layoutCache 등) 손실.
- `DocumentEngine._buildTree()`가 전체 트리를 재구축하므로 splice는 불필요.

### 3.3 `disconnectedCallback` — 이미지 캐시 보존

- `LayoutImageElement.disconnectedCallback`에서 `_clearImageCache()` 호출 금지.
- reconcile 중 `appendChild` → `disconnectedCallback` → 캐시 삭제 → 비동기 재로딩 → 이미지 깜빡임.
- 이미지 캐시는 URL 변경(`data`/`url` setter) 또는 명시적 `_clearImageCache()` 호출 시에만 무효화.

### 3.4 `disconnectedCallback` — 커서/선택 보존

- `LayoutParagraphElement.disconnectedCallback`는 `_editController` 파괴 전 `_savedCursorOffset`/`_savedSelection`에 커서 offset과 selection을 저장.
- `connectedCallback`은 `_editController` 재생성 후 저장된 값을 복원, 그 후 저장값 클리어.
- `data` setter reconcile 중 커서 점프 방지.

### 3.5 `HOST_STYLE_ID` — style 요소 식별

- 모든 레이아웃 요소는 `HOST_STYLE_ID = '__layout_host_style__'`로 자신의 `<style>` 요소를 식별.
- `_applyStyle()`은 `querySelector('style')` 대신 `querySelector('style#${HOST_STYLE_ID}')` 사용.
- AI processing overlay가 별도의 `<style>` 요소(`OVERLAY_STYLE_ID`)를 추가. ID 기반 조회가 없으면 AI overlay style을 잡아 `:host` 규칙을 덮어씀.
- `removeAiProcessingOverlay()`도 자신의 style 요소(`OVERLAY_STYLE_ID`)를 제거하여 누적 방지.

### 3.6 `_refreshParagraphOverlays` — 모든 단락 갱신

- `overlayEngines.length > 0` 가드를 두지 않는다. 모든 단락을 갱신해야 이전에 overlay가 있었지만 현재 사라진 단락의 stale `overlayEngines`가 제거된다.
- `updateOverlayContext()`를 사용하여 `_layoutCache`를 보존. 입력 해시 동일 시 `layoutText()`가 캐시 hit.
- `TableEngine` 내부 셀 박스도 순회: `rowEngines` → `cellEngines` → `cellEngine.boxEngine` → 재귀.

### 3.7 `_buildParagraphEngine` — `layoutText()` 미호출

- `_buildParagraphEngine`은 `layoutStructure()`만 호출. `layoutText()`는 호출하지 않는다.
- `layoutText()`는 `_refreshParagraphOverlays()`에서 단일 실행.
- 이중 실행 시 첫 결과가 `resetIncrementalState()`로 버려지는 문제 방지.

### 3.8 `_buildBoxEngine` — GC 재사용

- `_gcParamsEqual()`로 기존 `GridCalculatorEngine`의 파라미터 비교. 동일 시 인스턴스 재사용, `_calcColumnGridCoords` 재실행 스킵.
- 비교 필드: `width`, `height`, `padding*`, `columns`, `gap` (`valueEqual`), `paragraphStyle` (참조 비교), `textStyle` (참조 비교), `isBox`.

### 3.9 `appendChildData` — 증분 추가

- `appendChildData()`는 `this.data = {...}` round-trip을 사용하지 않는다.
- `_appendChildData(child)` + `requestRerenderAffectedParagraphs()` — O(1) 증분 추가.
- `data` setter round-trip은 O(N) — 모든 기존 자식 reconcile + 중복 렌더링.
- `data` setter는 전체 복원(undo/redo, 외부 데이터 할당) 시에만 사용.

### 3.10 `gridCalculator!` non-null assertion 금지

- `TableCellEngine.gridCalculator`는 `GridCalculatorEngine | null` 타입. `!`로 우회하면 런타임 crash 위험.
- null-safe 분기(`parentGc = parent.gridCalculator; isStatic && parentGc ? ... : ...`)로 처리.

---

## 4. 후처리 데이터 export 규칙

### 4.1 `ColorRegistry.init()` — 스타일시트 없는 환경

- `globalThis.document?.styleSheets[0]`가 없을 때 `_ready = true` 설정, `colorMap` 반환. CSS 변수 주입은 건너뛰되 색상 데이터 접근 가능해야 함. SSR/테스트 환경에서 throw 방지.

### 4.2 모든 레이아웃 요소는 `printPostData` 게터 필요

- `LayoutDocumentElement`, `LayoutBoxElement`, `LayoutParagraphElement`, `LayoutImageElement`, `LayoutGuideColumnElement`, `LayoutTableElement`, `LayoutTableRowElement`, `LayoutTableCellElement` — 모두 `printPostData` 게터.
- 엔진 mm 좌표를 `ppm`으로 환산한 픽셀 rect + 원본 데이터. DOM `getBoundingClientRect()` 미의존.
- 새 레이아웃 요소 추가 시 반드시 구현.

---

## 5. 성능 관련 규칙

> **구현된 렌더링 최적화 인프라는 `docs/PERFORMANCE.md` 참조.**

### 5.1 `renderText` key 기반 증분 렌더링

- `data-source-offset`을 reconciliation key로 사용. 기존 span 재사용 시 `innerText`, 스타일, `data-offset`만 갱신.
- `innerHTML = ''` 사용 금지. `<style>` 요소는 재사용, CSS 룰만 갱신.
- `data-temporary` span은 diff 시작 전 제거.
- COVER 라인(`parts: []`)은 라인 div의 모든 자식 제거, 빈 div만 유지.

### 5.2 `data-source-offset` vs `data-offset`

- `data-source-offset`: 소스 문자열 위치. diff 렌더링 key.
- `data-offset`: 렌더링된 문자 위치. `EditCoordinateMapper` 클릭-to-커서 매핑용.
- 두 속성은 모든 span에 공존. 제거 시 각 기능이 동작하지 않음.

### 5.3 `EditCoordinateMapper.rebuild()` 캐시 무효화

- `rebuild()`는 `_renderedToSource`, `_sourceToRendered`, `_spanCache`, `_columnSpansCache`, `_columnRanges`, `_columnStartOffsets` 초기화.
- `postRender()`에서 호출됨. 렌더링 후 반드시 `postRender()` 호출 필요.
- `rebuild()` 없이 DOM 직접 조작 시 캐시 stale.

---

## 6. z-index 제약사항

### 6.1 레이아웃 요소 z-index 범위

- 레이아웃 요소 `zIndex`: `0 ~ 90000` (`Z_INDEX_MAX_LAYOUT`).
- `90001 ~ 99999`: 예약 범위 (편집 UI, 오버레이, 테이블 크롬 등).
- `100000` 이상 사용 금지.

### 6.2 예약 z-index 값

| 값 | 용도 | 사용 위치 |
|---|---|---|
| `91000` | 광고 역할 고정 (`role: 'ad'`) | `box.element.ts` |
| `91001` | 면머리 역할 고정 (`role: 'header'`) | `box.element.ts` |
| `99999` | 리사이즈 핸들 | `box.element.ts` |
| `99998` | 타입 라벨 | `box.element.ts`, `document.element.ts` |
| `99997` | 삽입 미리보기 오버레이 | `insert-controller.ts` |
| `9999` | 텍스트 편집 textarea (IME) | `text-edit-controller.ts` |

### 6.3 역할 기반 z-index 고정

- `role: 'ad'` → `zIndex` getter 항상 `91000` 반환. `zIndex` setter 및 `data` setter의 `zIndex` 할당 무시.
- `role: 'header'` → 항상 `91001` 반환. 동일 규칙.
- role 해제 시 `_zIndex`를 형제 중 역할 고정 값 제외한 최댓값 + 1로 복원 (`Z_INDEX_MAX_LAYOUT` 한계).
- 새 요소 생성 / reparent 시 `91000`/`91001`은 0으로 취급하여 `max` 계산.

---

## 7. 빌드 및 검증 규칙

### 7.1 빌드

- `npm run build` — Vite IIFE 빌드 + React ESM 빌드 + `.d.ts` 생성.
- 빌드 실패 시 `noUnusedLocals`/`noUnusedParameters` 확인.
- TypeScript 7 RC: `noEmit: true` — `tsc`는 타입 체크만, Vite가 컴파일.
- React 빌드는 `emptyOutDir: false` — IIFE 빌드 결과 보존.

### 7.2 테스트 인프라 없음

- 코드 수정 후 `npm run build`로 검증. 시각적 변경은 `npm run dev`로 브라우저 확인.

---

## 8. React 래퍼 규칙

### 8.1 Custom Element API 변경 시 React 래퍼 동기화

- Custom Element public API 수정 시 `src/react/components/`의 대응 래퍼도 검토/수정.

### 8.2 새 Custom Element 추가 시 React 래퍼 생성

- `src/components/`에 새 Custom Element 추가 시 `src/react/components/`에 대응 래퍼 생성.

### 8.3 공개 export 재출력 확인

- `src/types/`, `src/engine/`, `src/resource/`, `src/constants/`, `src/edit/`에 새 공개 export 추가 시 `src/react/index.ts`에서 재출력 확인.

### 8.4 React 의존성 범위 제한

- `src/react/` 외부 파일이 `react`를 import하지 않음. IIFE 빌드에 React 코드 침범 방지.
- `react`는 peer dependency (`>=19.0.0`). 번들에 포함되지 않음.

### 8.5 React 래퍼 변경 후 빌드 검증

- `src/react/` 수정 후 `npm run build` 실행. IIFE + React ESM 빌드 모두 성공 확인.