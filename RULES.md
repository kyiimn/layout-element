# RULES.md — layout-element

본 파일은 코드 수정 시 반드시 지켜야 할 규칙과, 과거 작업에서 확인된
"실제 버그가 아닌 의도적 설계" 및 "피해야 할 실수"를 기록한다.
새로운 버그 수정이나 기능 추가 전 반드시 이 파일을 확인해야 한다.

---

## 1. 텍스트 레이아웃 엔진 규칙

### 1.1 `_charWidthPx()` 측정 방식

- **반드시 `metrics.width` (advance width)를 사용할 것.**
  `actualBoundingBoxLeft + actualBoundingBoxRight`는 잉크 영역만 측정하므로
  좁은 라틴 문자(i, l, j)와 공백의 폭을 과소측정하여 텍스트 오버플로우를 유발한다.
- **`maxWidthPx = widthRatio * fontSizePx`로 상한 클램프.**
  `_charWidthPx`는 `Math.min(Math.max(rawWidth, minWidthPx), maxWidthPx)`를 반환한다.
  `maxWidthPx`는 CSS `maxWidth: ${widthRatio}em`과 일치해야 한다.
- **`rawWidth * widthRatio`를 곱하지 말 것.** `maxWidthPx` 클램프가 장평 비율을 반영한다.
  `rawWidth * widthRatio`를 하면 `maxWidthPx` 클램프와 이중 적용이 된다.

### 1.2 `genCharStyle()` 스타일 생성

- **`maxWidth`는 `${widthRatio}em`이어야 함.** 장평 비율이 0.8이면
  글자의 최대 레이아웃 박스 너비도 0.8em이 되어야 한다.
- **`scale: ${widthRatio} 1`도 함께 사용.** `scale`은 글자 모양 자체를
  수평으로 축소하여 장평 효과를 시각적으로 구현한다.
  `maxWidth`는 레이아웃 박스 너비를 제한하고, `scale`은 글자 모양을 축소한다.
  둘 다 함께 사용해야 장평이 올바르게 적용된다.
- **`minWidth`는 유지:** 공백/전각 `0.5em`, 반각 `0.35em`.
  0폭 문자가 렌더링되는 것을 방지한다.
  `minWidth`는 em 단위이므로 `fontSize`에만 비례하고 `widthRatio`의 영향을 받지 않는다.

### 1.3 `_layoutTextIntoColumns()` 무한 루프 방지

- **문자가 모든 파트 너비보다 클 경우 강제 배치해야 함.**
  `currentPartIdx >= partWidths.length`일 때
  `charWidth > maxPartWidth`이면 첫 번째 파트에 강제로 배치하고 `break`한다.
  이 가드를 제거하면 열 너비보다 넓은 문자가 들어올 때 무한 루프가 발생한다.

### 1.4 `GridCalculator.ppm` 직접 교체 금지

- `GridCalculator.ppm`은 줌, CSS transform 등에 의해
  런타임에 변경될 수 있다. 측정 시점의 ppm을 캐싱하더라도
  `GridCalculator.ppm` 자체를 대체해서는 안 된다.
- `static resetPpm()`은 ppm 재측정을 위한 공개 API이다.

### 1.5 COVER 라인은 의도적으로 세로 공간을 차지함

- COVER 라인(이미지가 라인 전체를 덮는 경우)은 `parts: []`이지만
  라인 자체는 세로 공간을 차지한다. 이것은 버그가 아님.
  COVER 라인의 `scrollHeight`를 0으로 만들면 안 된다.

### 1.6 `_overlayRects` 캐시 수명 주기

- `_overlayRects`는 `_layoutTextIntoColumns()` 시작 시 `null`로 리셋.
- `_initStructure()`에서도 `null`로 리셋.
- 첫 `_applyOverlap()` 호출 시 `Map` 생성 후 모든 오버랩 요소를 한 번 측정.
- 이후 동일 렌더링 사이클 내에서는 `Map.get(el)`로 재사용.
- 이 캐시를 제거하면 라인마다 `getBoundingClientRect()`가 호출되어
  강제 리플로우가 발생한다.

### 1.6.1 `getOverlapSizeMm` — 중첩 box의 이미지 참조 시 `contentElement` 사용

- **`getOverlapSizeMm()`의 `overlayElement`는 항상 `LayoutBoxElement`이다.**
  `overlayElements`가 `LayoutBoxElement[]`를 반환하기 때문이다.
- **`contentType === 'image'`가 `true`여도 `items[0]`이 `LayoutImageElement`가 아닐 수 있다.**
  `contentType`은 단일 자식 box를 재귀적으로 파고들어 판정하므로,
  `box(A) → box(B) → image(C)` 구조에서 `A.contentType === 'image'`이지만
  `A.items[0]`은 `box(B)`이다.
- **`items[0] as LayoutImageElement` 캐스트는 이 경우 잘못된 요소를 참조한다.**
  canvas, overlapPadding 모두 box(B)에서 읽히므로 `undefined`가 되고,
  픽셀 탐지가 skip되어 기하학적 폴백(전체 박스 rect 사용)으로 떨어진다.
- **반드시 `targetElement.contentElement`를 사용하여 실제 image 요소를 얻을 것.**
  `contentElement`는 `contentType`과 동일한 재귀 경로를 따라가므로
  중첩 box 구조에서도 올바른 `LayoutImageElement`를 반환한다.
- **canvas 픽셀 매핑에도 이미지 요소의 rect(`imgRect`)를 사용해야 함.**
  박스 rect(`r2`)는 중첩 box에서 실제 이미지보다 클 수 있으므로,
  `r2`를 사용하면 canvas 픽셀과 화면 좌표의 매핑이 어긋난다.

### 1.7 폰트 문자열 캐시

- `_getCanvasFont()`의 단일 항목 캐시(`_lastFontKey`/`_lastFontString`)는
  히트율 약 99%를 달성한다. Map 기반 캐시로 교체할 필요 없음.
- 키: `${fontWeight}|${fontSizePx}|${fontFamily}`
- `fontSizePx`(계산된 픽셀값)를 키에 사용해 ppm 차이를 반영한다.

### 1.8 `preTextWrap()`은 제거됨

- 이전의 `preTextWrap()` → `_createColumnSkeleton()` + `_fillTextContent()`
  2단계 프로세스는 제거되었다.
- 현재 파이프라인: `resetIncrementalState()` → `layoutStructure()` → `layoutText()`
- `layoutText()`가 `_layoutTextIntoColumns()`를 호출하여
  라인 생성, 오버랩 감지, 글자 배치를 한 번에 수행한다.
- `ColumnSkeleton` 타입, `_refillTextContent()`, `_recreateColumnDOM()`,
  `_resetSkeletonText()`, `_reRenderColumns()`는 모두 제거되었다.

---

## 2. 편집 컨트롤러 규칙

### 2.1 `_onMouseMove` 마우스 좌표 저장

- **모든 mousemove 이벤트에서 `clientX`/`clientY`를 인스턴스에 저장할 것.**
  `requestAnimationFrame` 콜백 내에서 `event.clientX`를 직접 읽으면
  첫 번째 이벤트의 좌표만 사용되어 빠른 드래그 시 선택 영역이 뒤처진다.
- `this._lastMouseX`/`this._lastMouseY`에 저장하고
  rAF 콜백에서는 저장된 값을 읽는다.
- `_onMouseDown`에서도 초기값을 설정해야 한다.

### 2.2 커서 위치 — 빈 공간 클릭

- **줄 끝 빈 공간 클릭 → 마지막 글자 뒤에 커서 위치.**
  `getNearestOffsetFromPoint()`에서 `x >= rightmostRight`이면
  항상 `rightmostSource + 1`을 반환한다. midpoint 로직을 거치지 않는다.
- **줄 앞 빈 공간 클릭 → 첫 글자 앞에 커서 위치.**
  `x <= leftmostLeft`이면 항상 `leftmostSource`를 반환한다.
- 이 두 검사는 midpoint 검사 **이전**에 수행되어야 한다.
- `content.length`를 초과하는 offset을 반환하지 않도록 경계 검사 필수.

### 2.3 커서 높이 — 공백 문자 앞

- 공백 문자 span은 `getBoundingClientRect().height === 0`이다.
  커서 높이를 `rect.height`에서 가져오면 공백 앞에서 커서가 보이지 않는다.
- `rect.height <= 1`이면 `getFirstColumnRect().fontSize`를 폴백으로 사용한다.
- 커서 `top` 위치는 `_resolveFallbackTop()`으로 결정하며, 폴백 우선순위는:
  1. 인접 일반 문자(`sourceOffset ± 1`)의 `rect.top` — 같은 라인에 가시 문자가 있으면 사용
  2. `getLineInfoBySourceOffset` + `getLineRect`로 구한 라인 div의 `top` — 라인 div는
     height≈0 span과 무관하게 `lineHeight` 높이를 가지므로 올바른 top을 반환
  3. `getCharRect(sourceOffset).top` — height≈0 span이라도 top은 라인 상단과 일치
  4. `getFirstColumnRect().top` — 빈 단락 등의 최종 폴백
- **주의**: `rect.top - cursorHeight`를 사용하면 안 된다. 라인 끝의 스페이스처럼
  인접 가시 문자가 모두 height≈0이면 `rect.top - cursorHeight`가 위 라인 쪽으로
  커서를 올려버리는 버그가 발생한다 (엔터 → 가나다 → 스페이스 두 번 시나리오).

### 2.3.1 라인 끝 커서 배치 — phantom end placement

- trailing space 없이 끝나는 라인의 마지막 가시 문자 다음 offset은
  다음 라인 첫 글자의 offset과 **동일**하다 (예: `...21일(현지...`에서
  `일` = offset 30, `(` = offset 31). 
- `_sourceToPlacement`는 이 offset에 대해 다음 라인 첫 글자의
  `atEndOfChar: false` placement를 설정한다.
- 라인 끝에서 커서가 마지막 가시 문자의 **오른쪽**에 배치되려면
  이전 라인 마지막 가시 문자를 `atEndOfChar: true`로 참조해야 하지만,
  같은 offset에 두 가지 placement가 충돌하므로 별도 맵
  `_lineEndPlacements`에 phantom end placement를 저장한다.
- `getCursorPlacement(offset, preferLineEnd=true)`로 조회하면
  `_lineEndPlacements`를 우선하여 라인 끝 배치를 반환한다.
- `_updateCursorPosition`은 기본 조회에서 `preferLineEnd=true`를 사용하고,
  `crossRightState === 'crossed'`일 때만 `preferLineEnd=false`로
  다음 라인 첫 글자의 왼쪽에 배치한다.

### 2.3.2 스페이스 문자 커서 배치

- **중간 스페이스**(단어 사이): 커서가 스페이스 **앞**(왼쪽)에 배치된다.
  `_rebuildMappings`에서 가시 문자와 동일하게 `atEndOfChar: false`로 설정된다.
- **라인 마지막 스페이스**(trailing space): 커서가 스페이스 **뒤**(이전 가시 문자의 오른쪽)에 배치된다.
  `_rebuildMappings`에서 trailing space 처리 시 `atEndOfChar: true`로 설정된다.
- **endOfBlock의 trailing space**: 라인 마지막 스페이스와 동일하게 `atEndOfChar: true`로 설정된다.
- **금지**: `placement.atEndOfChar === false`일 때 span 텍스트가 `' '`인지 검사하여
  강제로 `atEndOfChar: true`로 바꾸면 안 된다. 이는 모든 중간 스페이스를 뒤로 밀어버려
  ArrowRight로 스페이스 → 다음 글자 이동 시 커서가 뒤로(왼쪽으로) 가는 버그를 발생시킨다.
- **crossed 상태에서 trailing space 처리**: ArrowRight cross 메커니즘의 crossed 상태에서
  현재 offset이 trailing space인 경우(`getCursorPlacement(offset, false).sourceOffset !== offset`),
  `atEndOfChar: false`로 강제하면 이전 가시 문자의 **앞**에 커서가 배치되어
  "한 글자 앞으로 돌아옴" 버그가 발생한다. 이 경우 다음 offset의 placement를 참조하여
  다음 라인 첫 글자의 왼쪽에 배치해야 한다.

### 2.4 커서 너비

- `<x-edit-cursor>`는 고정 1px 너비. 깜빡이지 않음.
- 2px로 변경하면 인접 문자와 겹쳐 보인다.

### 2.5 `_computeTextChange` 모호성은 버그가 아님

- `_onKeydown`이 Backspace/Delete를 `preventDefault()`하므로
  `_onInput`에서 삭제 케이스가 발생하지 않는다.
  `_computeTextChange`의 삭제 처리 부족은 모바일 키보드에서만 영향이 있으며
  현재 워크플로우에서는 버그가 아니다.

### 2.6 인쇄 모드는 제거됨

- **인쇄 모드(`_isPrint`, `window.matchMedia("print")`)는 완전히 제거되었다.**
- `ColorRegistry`와 `FontLoader`는 더 이상 `window.matchMedia("print")`를 확인하지 않는다.
- `printPostData`는 인쇄 모드가 아닌 **후처리 시스템용 데이터 export API**로 유지된다.
- 엔진이 계산한 mm 좌표를 외부 시스템(PDF 생성, 윤전기 제어 등)에 전달하기 위한 목적이며, 인쇄 모드와 무관하게 항상 사용 가능하다.

### 2.7 Zero-height span(공백 문자)과 좌표 계산

- **공백 문자의 span은 `getBoundingClientRect().height === 0`이다.**
  `width`도 0에 가깝고 `top` 값이 실제 텍스트 줄과 다르다.
  모든 좌표 계산 메서드에서 이 속성을 반드시 고려해야 한다.
- **`_computeVerticalOffset`**: `cursorRect.height`가 0이면
  `getFirstColumnRect().fontSize`를 lineHeight 폴백으로 사용해야 한다.
  `height === 0`이면 `direction * lineHeight === 0`이 되어
  상하 이동이 불가능해진다.
- **`_computeVerticalOffset`**: `getNearestOffsetFromPoint`는
  현재 시각적 줄의 문자를 반환할 수 있다.
  반환값이 현재 오프셋과 같으면 `null`을 반환해야 한다 (이동 없음).
  또한 `isOnDifferentLine()` 검사로 같은 줄의 문자를 걸러내야 한다.
- **`findVisualLineBounds`**: 공백 span을 anchor로 사용하면
  `anchorRect.top`이 실제 텍스트 줄과 다른 값을 가진다.
  `anchorRect.height <= 1`일 때 가장 가까운 가시 span의 `top`을 사용해야 하며,
  `lineSpans` 수집 시 `height <= 1`인 span을 제외해야 한다.
- **`_updateCursorPosition`**: `rect.height <= 1`이면
  `getFirstColumnRect().fontSize`를 커서 높이 폴백으로 사용하고
  `_resolveFallbackTop()`으로 커서 top을 결정해야 한다.
  `_resolveFallbackTop`은 인접 가시 문자 → 라인 div top → span rect.top →
  첫 컬럼 top 순서로 폴백한다 (§2.3 참조).
  **`rect.top - cursorHeight`를 폴백으로 사용하면 안 된다** — 라인 끝 스페이스처럼
  인접 가시 문자가 모두 height≈0일 때 위 라인 쪽으로 커서가 올라가는 버그가 발생한다.

### 2.8 편집 기능 회귀 방지 — 기능 추가/수정 시 필수 검증

편집 컨트롤러(`EditController`)와 좌표 매퍼(`EditCoordinateMapper`)를 수정할 때,
다음 시나리오를 **반드시** 브라우저에서 수동 검증해야 한다:

1. **ArrowLeft / ArrowRight**: 한 글자씩 이동
2. **ArrowUp / ArrowDown**: 시각적 줄 단위 이동 (공백 앞/뒤에서도)
3. **Home / End**: 시각적 줄 시작/끝 이동 (공백 문자 위에서도)
4. **Ctrl+ArrowLeft / Ctrl+ArrowRight**: 단어 단위 이동
5. **클릭으로 커서 배치**: 공백 문자 위 클릭, 줄 끝 빈 공간 클릭
6. **IME 조합**: 한국어 입력

회귀의 가장 흔한 원인은 **공백 문자의 zero-height span**이다.
좌표 계산, 라인 바운드, 커서 위치 계산에서 `height <= 1`인 span을
일반 문자와 동일하게 처리하면 안 된다.

---

## 2.9 엔진-DOM 동기화 규칙 (엔진 우선 원칙)

### 2.9.1 엔진이 단일 소스 오브 트루스

- **엔진 트리가 모든 레이아웃 계산의 단일 소스다.** DOM 요소는 엔진을 보완하거나 대체하지 않는다.
- **DOM은 엔진 결과를 소비만 한다.** 엔진을 생성/수정하지 않고, 엔진이 계산한 좌표/스타일/레이아웃을 읽어 화면에 반영한다.
- **편집 발생 시**: 편집된 내용을 `DocumentData`/`BoxData`로 직렬화하여 엔진에 전달 → 엔진 재처리 → 결과를 DOM에 전파.
- **DOM에서 엔진 `childEngines`을 수동으로 채우지 말 것.** 엔진 트리가 불완전하면 엔진 트리 구축 로직을 수정해야지 DOM에서 보완하면 안 된다.

### 2.9.2 `disconnectedCallback`에서 `parentElement`는 null

- **DOM 명세에 따라 `disconnectedCallback` 호출 시점에 `this.parentElement`는 이미 null이다.**
- 엔진 트리 정리가 필요한 요소는 `connectedCallback`에서 부모 엔진 참조를 `_parentEngineRef`에 캐싱해야 한다.
- `disconnectedCallback`에서 `this.parentElement?.engine`을 읽으면 항상 `undefined`가 반환되어 dead code가 된다.
- **적용 요소**: `LayoutBoxElement`, `LayoutParagraphElement`, `LayoutImageElement` — 모두 `_parentEngineRef` 패턴 사용.

### 2.9.3 `_layoutCache` 자가 무효화 방지

- **`ParagraphEngine.data` setter는 `resetIncrementalState()`를 호출하여 `_layoutCache`를 null로 만든다.**
- `LayoutParagraphElement.render()`의 else 분기(구조 변경 없음, overlay 위치만 변경)에서 `_layoutStructure()`를 호출하면 `data` setter → `resetIncrementalState()` → `_layoutCache = null`이 되어 캐시가 사실상 동작하지 않는다.
- **해결**: `ParagraphEngine.updateOverlayContext()` 메서드를 사용하여 `_layoutCache`를 보존하면서 overlay 문맥만 경량 갱신한다.
- `_layoutStructure()`는 구조 변경(`_perfStructureChanged === true`) 시에만 호출해야 한다.

### 2.9.4 `_refreshParagraphOverlays` 조건 제거

- **`DocumentEngine._refreshParagraphOverlays()`는 모든 paragraph의 `overlayEngines`를 갱신해야 한다.**
- `overlayEngines.length > 0` 조건을 걸면, 이전에 overlay가 있었지만 현재 사라진 paragraph가 stale `overlayEngines`를 유지한다.
- z-index 변경이나 박스 이동으로 overlay 관계가 사라진 경우, paragraph는 더 이상 존재하지 않는 박스를 오버랩 요소로 처리하게 된다.

### 2.9.5 `gridCalculator!` non-null assertion 금지

- **`DocumentEngine._buildBoxEngine()`에서 `parent.gridCalculator!`를 사용하지 말 것.**
- `TableCellEngine.gridCalculator`는 타입이 `GridCalculatorEngine | null`이므로 `!`로 우회하면 런타임 crash 위험이 있다.
- null-safe 분기(`parentGc = parent.gridCalculator; isStatic && parentGc ? ... : ...`)로 처리할 것.

---

## 3. 후처리 데이터 export 규칙

### 3.1 `ColorRegistry.init()` — 스타일시트 없는 환경

- `globalThis.document?.styleSheets[0]`가 없을 때
  `_ready = true`를 설정하고 `colorMap`을 반환해야 한다.
  CSS 변수 주입은 건너뛰되 색상 데이터 접근은 가능해야 한다.
- 이것을 "초기화 실패"로 처리하면 SSR, 테스트 환경에서
  모든 색상 접근이 throw된다.

### 3.2 모든 레이아웃 요소는 `printPostData` 게터를 가져야 함

- `LayoutDocumentElement`, `LayoutBoxElement`, `LayoutParagraphElement`,
  `LayoutImageElement`, `LayoutGuideColumnElement`, `LayoutTableElement`,
  `LayoutTableRowElement`, `LayoutTableCellElement` — 모두 `printPostData` 게터 필요.
- `printPostData`는 엔진이 계산한 mm 좌표를 `ppm`으로 환산한 픽셀 rect와
  원본 데이터를 외부 후처리 시스템(PDF 생성, 윤전기 제어 등)에 전달하기 위한 API다.
  DOM `getBoundingClientRect()`에 의존하지 않고 엔진 좌표를 사용한다.
- 새 레이아웃 요소를 추가할 때 반드시 `printPostData` 게터를 구현할 것.

---

## 4. 성능 관련 규칙

> **구현된 렌더링 최적화 인프라는 `docs/PERFORMANCE.md`를 참조.** 이 절은 추가 설계 규칙과 잔여 병목을 기록한다.

### 4.1 강제 리플로우 최소화

- `_applyOverlap()`과 `isOverflow` 체크는 라인마다
  `getBoundingClientRect()`를 호출하여 강제 리플로우를 유발한다.
- `_overlayRects` 캐시는 오버랩 요소의 rect를 캐싱하지만
  라인 자체의 rect는 여전히 라인마다 측정된다.
- 향후 최적화 시 라인 rect 측정을 배치로 처리하는 것을 고려할 것.

### 4.2 `getImageData` 캐싱 없음

- `getOverlapSizeMm()`에서 이미지 픽셀 데이터를 라인마다 재읽기한다.
- `overlapPadding`이 설정된 경우 전체 이미지(`sx=0, sw=canvas.width`)를 읽어 열별 불투명 픽셀을 검사하므로, 패딩 없는 경우보다 더 많은 픽셀 데이터를 처리한다.
- 동일 이미지에 대한 `getImageData()` 결과를 캐싱하면 성능 향상 가능.
- 단, 캔버스 크기가 큰 경우 메모리 사용량 주의.

### 4.3 `overlayElements` 게터 캐싱 없음

- `overlayElements` 게터는 호출마다 오버랩 요소 목록을 재계산한다.
- 렌더링 사이클 내에서 캐싱하면 성능 향상 가능.

### 4.4 `getColumnSpans` 캐싱 (구현됨), `getAllColumns` 미구현

- `EditCoordinateMapper._getColumnSpans()`는 `_columnSpansCache`
  (`Map<LayoutColumnElement, HTMLSpanElement[]>`)로 컬럼별 span 목록을 캐싱한다.
- 캐시는 `rebuild()` 호출 시 초기화된다 (`postRender()`에서 호출).
- `getNearestOffsetFromPoint()`는 로컬 `spanRects` Map을 한 번에 구축하여
  모든 `getBoundingClientRect()` 호출을 단일 패스로 통합한다.
  이 Map은 메서드 종료 시 폐기된다 (인스턴스 필드가 아님).
- **여전히 미구현**: `_getAllColumns()`는 호출마다 `querySelectorAll('x-layout-column')`을 수행한다.
- **여전히 미구현**: `getCharRect()`, `getCharOffsetFromPoint()`, `getTextRange()`,
  `findVisualLineBounds()`는 호출마다 `getBoundingClientRect()`를 수행한다.

### 4.5 `renderText` key 기반 증분 렌더링 (구현됨)

- `column.element.ts`의 `renderText()`는 key 기반 diff 렌더링을 사용한다.
- 각 span은 `data-source-offset` 속성을 key로 사용하여 재사용 여부를 결정한다.
- 기존 span이 있으면: `innerText`, 스타일, `data-offset`을 갱신하고 DOM 순서를 `insertBefore`로 조정한다.
- 기존 span이 없으면: 새 span을 생성한다.
- 사용되지 않은 기존 span은 제거한다.
- `innerHTML = ''`는 더 이상 발생하지 않는다.
- `<style>` 요소는 재사용하고 CSS 룰만 갱신한다.
- `data-temporary` span(낙관적 span)은 diff 시작 전 모두 제거된다.
- COVER 라인(`parts: []`)은 라인 div의 모든 자식을 제거하고 빈 div만 유지한다.
- 헬퍼 메서드: `_computeSourceOffsets()`, `_stripSpaces()`, `_createLineElement()`,
  `_applyLineStyle()`, `_createPartElement()`, `_applyPartStyle()`,
  `_createSpanElement()`, `_applySpanStyle()`

### 4.6 `data-source-offset`과 `data-offset`의 구분

- **`data-source-offset`**: 소스 문자열의 문자 위치. key 기반 diff 렌더링의 reconciliation key로 사용.
- **`data-offset`**: 렌더링된 문자 위치. `EditCoordinateMapper`가 클릭-to-커서 매핑에 사용.
- 두 속성은 모든 span에 공존한다.
- `data-offset`을 제거하면 `EditCoordinateMapper`의 `getCharOffsetFromPoint()` 등이 동작하지 않는다.
- `data-source-offset`을 제거하면 diff 렌더링이 모든 span을 새로 생성하게 된다.

### 4.7 `EditCoordinateMapper.rebuild()` 캐시 무효화

- `rebuild()`는 `_renderedToSource`, `_sourceToRendered`, `_spanCache`,
  `_columnSpansCache`, `_columnRanges`, `_columnStartOffsets`를 모두 초기화한다.
- `rebuild()`는 `EditController.postRender()`에서 호출된다.
- 렌더링 후 반드시 `postRender()`가 호출되어야 캐시가 최신 상태를 반영한다.
- `rebuild()` 없이 DOM을 직접 조작하면 캐시가 stale 상태가 된다.

---

## 5. 코드 수정 시 피해야 할 실수

### 5.1 `rawWidth * widthRatio` 곱셈 사용 금지

- `_charWidthPx()`에서 `rawWidth * widthRatio`를 직접 곱하면
  `maxWidthPx` 클램프와 이중 적용이 된다.
  `maxWidthPx = widthRatio * fontSizePx`로 상한을 설정하고
  `Math.min(Math.max(rawWidth, minWidthPx), maxWidthPx)`를 사용한다.

### 5.2 공백 문자에서 `letterSpacing` 제외 금지

- 공백 문자에 `letterSpacing`을 적용하지 않는 변경은
  텍스트 정렬 불일치를 유발한다. 공백에도 `letterSpacing`을 적용한다.

### 5.3 `GridCalculator.ppm` 직접 사용 시 주의

- `GridCalculator.ppm`은 런타임에 변경될 수 있다.
  측정 시점의 값을 캡처하여 사용하되, `GridCalculator.ppm` 자체를
  대체하거나 무시하면 안 된다.

### 5.4 `_charWidthPx`의 `actualBoundingBoxLeft + Right` 사용 금지

- 잉크 영역만 측정하므로 좁은 문자의 폭을 과소측정한다.
  반드시 `metrics.width` (advance width)를 사용한다.

### 5.5 `scale` CSS 속성 제거 금지

- `genCharStyle()`에서 `scale: ${widthRatio} 1`은 글자 모양 자체를
  수평으로 축소하여 장평을 구현하는 핵심 속성이다.
  `maxWidth: ${widthRatio}em`은 레이아웃 박스 너비를 제한하고,
  `scale`은 글자 모양을 축소한다. 둘 다 함께 사용해야 한다.
  `scale`을 제거하면 글자 모양이 축소되지 않아 장평 효과가 사라진다.

---

## 6. 문서 규칙

### 6.1 `docs/TEXT_ENGINE.md`

- `TextLayoutEngine`의 상세 명세 문서.
- 이전 이름 `docs/PARAGRAPH_MODEL.md`에서 변경됨.
- 코드 변경 시 이 문서도 함께 업데이트할 것.
- 한국어로 작성됨. 영어로 번역하지 말 것.

### 6.2 AGENTS.md

- 프로젝트 개요, 아키텍처, 제약사항, 디렉토리 구조를 기술.
- 새 컴포넌트, 새 타입, 새 제약사항이 추가되면 업데이트할 것.
- `Important Constraints` 섹션에 코드 수준의 제약을 기록.
- `Dev Workflow Gotchas` 섹션에 개발 시 주의사항을 기록.
- `src/edit/` 디렉토리에 `edit-manager.ts`, `edit-context-adapter.ts`가 추가됨.
  새 편집 관련 파일이 추가되면 AGENTS.md 디렉토리 구조와 함께 업데이트할 것.

---

## 7. 빌드 및 검증 규칙

### 7.1 빌드 명령

- `npm run build` — Vite IIFE 빌드 + `.d.ts` 타입 선언 생성.
- 빌드 실패 시 수정 후 재빌드. 타입 에러는 `noUnusedLocals`/
  `noUnusedParameters`에 의한 것일 수 있음.

### 7.2 테스트 인프라 없음

- `vitest`, `jest` 등 테스트 러너가 없다.
- 코드 수정 후 반드시 `npm run build`로 검증.
- 시각적 변경은 `npm run dev`로 브라우저에서 확인.

### 7.3 TypeScript 7 RC

- `typescript: ^7.0.1-rc` 사용.
- `noEmit: true` — `tsc`는 타입 체크만, 실제 컴파일은 Vite가 담당.
- `noUnusedLocals`, `noUnusedParameters` 활성화 —
  사용하지 않는 변수/파라미터는 빌드 에러 유발.

### 7.4 React ESM 빌드 추가

- `npm run build`는 `vite.config.ts`(IIFE)와 `vite.config.react.ts`(React ESM)를
  순차적으로 실행한다.
- React 빌드는 `emptyOutDir: false`로 설정되어 있으므로
  IIFE 빌드 결과를 덮어쓰지 않는다.
- React 빌드는 `react`와 `react/jsx-runtime`을 externalize한다.
  React를 번들에 포함시키지 않는다.

---

## 8. z-index 제약사항

### 8.1 레이아웃 요소 z-index 범위 제한

- **레이아웃 요소의 `zIndex`는 `0 ~ 90000` 범위만 사용할 수 있다.**
  `BoxData.zIndex`, `ImageData.zIndex`, `ParagraphData.zIndex` 등
  모델 데이터의 `zIndex` 값은 `90000`을 초과할 수 없다.
- **`90001 ~ 99999`는 예약 범위이다.**
  이 범위는 편집 UI(선택 표시, 리사이즈 핸들, 타입 라벨, 미리보기 오버레이 등)
  등 특수한 용도로만 사용되며, 레이아웃 요소의 `zIndex`로 사용할 수 없다.
- **`100000` 이상의 z-index 값은 사용하지 않는다.**
  과거에 사용하던 `99999999`, `99999998`, `999999` 등의 값은
  예약 범위 내의 값으로 대체되었다.

### 8.2 예약 z-index 값 목록

| 값 | 용도 | 사용 위치 |
|---|---|---|
| `91000` | 광고 역할 고정 z-index (`role: 'ad'`) | `box.element.ts` |
| `91001` | 면머리 역할 고정 z-index (`role: 'header'`) | `box.element.ts` |
| `99999` | 리사이즈 핸들 (resize-handle) | `box.element.ts` |
| `99998` | 타입 라벨 (type-label) | `box.element.ts`, `document.element.ts` |
| `99997` | 삽입 미리보기 오버레이 (insert preview) | `insert-controller.ts` |
| `9999` | 텍스트 편집 textarea (IME 입력) | `text-edit-controller.ts` |

### 8.3 역할(role) 기반 z-index 고정

- **`role: 'ad'`인 box의 `zIndex` getter는 항상 `91000`을 반환한다.**
  `data.zIndex`에 설정된 값은 무시되며, `_zIndex` 내부 필드는 보존되지만
  `zIndex` getter가 `Z_INDEX_ROLE_AD`(91000)을 반환한다.
- **`role: 'header'`인 box의 `zIndex` getter는 항상 `91001`을 반환한다.**
  `data.zIndex`에 설정된 값은 무시되며, `_zIndex` 내부 필드는 보존되지만
  `zIndex` getter가 `Z_INDEX_ROLE_HEADER`(91001)을 반환한다.
- **`role`가 `'ad'` 또는 `'header'`인 경우 `zIndex` setter와 `data` setter의 `zIndex` 할당은 무시된다.**
  역할 고정 z-index는 변경할 수 없다.
- **`role`가 `'ad'` 또는 `'header'`가 아닌 경우** `zIndex` getter는 `_zIndex`를 그대로 반환한다.
- **`role` setter에서 role이 변경되면 `layout()` + `requestRerenderAffectedParagraphs()`가 호출된다.**
  이로 인해 z-index 변경이 시각적으로 즉시 반영된다.
- **`data` getter의 `zIndex` 필드는 `this.zIndex`를 사용하므로** role 기반 오버라이드 값이 자동으로 반영된다.
- **역할 고정 z-index에서 해제될 때(예: `'ad'` → `'none'`)**,
  `_zIndex`는 형제 요소 중 역할 고정 z-index(`91000`, `91001`)를 제외한 최댓값 + 1로 복원된다.
  형제 요소가 없으면 `1`로 설정된다. 복원값은 `Z_INDEX_MAX_LAYOUT`(90000)을 초과할 수 없다.
- **새 요소 생성(`InsertController._getNextZIndex`) 및 reparent(`LayoutEditController._tryReparent`) 시에도**
  형제 요소의 `zIndex` getter 반환값 중 `91000`/`91001`(role 고정)은 0으로 취급하여 계산한다.
  그렇지 않으면 role 기반 고정 z-index가 `Math.max(...)`에 포함되어 새 요소가 항상
  `90000`(`Z_INDEX_MAX_LAYOUT`)에 clamp되어 role 고정 z-index와 경쟁하지 못하는 문제가 발생한다.

### 8.4 새로운 예약 값 추가 시 주의사항

- 예약 범위(`90001 ~ 99999`)에 새 값을 추가할 때는
  기존 값과 충돌하지 않도록 `RULES.md`의 표와 `src/constants/defaults.ts`의
  상수를 함께 업데이트해야 한다.
- 레이아웃 요소의 `zIndex`에 예약 범위 값을 할당하지 말 것.
- CSS `z-index` 속성에 하드코딩된 값 대신 `defaults.ts`의 상수를 사용할 것.

---

## 9. React 래퍼 규칙

### 8.1 Custom Element 공개 API 변경 시 React 래퍼 동기화

- Custom Element의 public API를 수정할 때(세터/게터/이벤트 추가/제거 등)
  `src/react/components/`의 대응하는 React 래퍼 컴포넌트도 반드시 함께 수정할 것.
- API 변경이 React 래퍼에 영향을 주지 않더라도, 검토는 필수.

### 8.2 새 Custom Element 추가 시 React 래퍼 생성

- `src/components/`에 새 Custom Element를 추가하면
  `src/react/components/`에 대응하는 React 래퍼 컴포넌트를 반드시 생성할 것.
- 모든 레이아웃 Custom Element는 React 환경에서도 사용 가능해야 한다.

### 8.3 타입/코어/리소스 재출력 확인

- `src/types/`, `src/engine/`, `src/resource/`, `src/constants/`, `src/edit/`에
  새로운 공개 export를 추가하면 `src/react/index.ts`에서 재출력되는지 확인할 것.
- React 엔트리는 vanilla 라이브러리의 모든 공개 API를 노출해야 한다.

### 8.4 React 의존성 범위 제한

- React 빌드는 `react`와 `react/jsx-runtime`을 externalize한다.
- `src/`에서 `src/react/` 외부 파일이 `react`를 import하면 안 된다.
  IIFE 빌드에 React 코드가 침범하지 않도록 한다.

### 8.5 React 래퍼 변경 후 검증

- `src/react/`의 어떤 파일을 수정한 후에는 반드시 `npm run build`를 실행하여
  IIFE 빌드와 React ESM 빌드가 모두 성공하는지 확인할 것.
- 두 빌드 중 하나라도 실패하면 머지하지 말 것.

### 8.6 `react`는 peer dependency

- `package.json`의 `peerDependencies`에 `react: ">=18.0.0"`이 명시되어 있다.
- `react`는 번들에 포함되지 않으며, 사용하는 프로젝트가 직접 설치해야 한다.