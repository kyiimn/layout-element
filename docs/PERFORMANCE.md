# PERFORMANCE.md — 렌더링 성능 최적화 전략

이 문서는 `layout-element`의 전체 소스에서 발견된 모든 성능 최적화 전략을 체계적으로 정리한다. 각 최적화는 소스의 특정 병목을 해결하기 위해 도입되었으며, 캐시 키, 용량, 제거 정책, 스킵 조건, 배치 동작을 포함한다.

> **엔진 마이그레이션**: `TextLayoutEngine` → `ParagraphEngine`, `GridCalculator` → `GridCalculatorEngine`. 캐시 구조는 동일하나 엔진 클래스명 변경. 상세는 [ENGINE.md](./ENGINE.md) 참고.

> **관련 파일**: `src/engine/paragraph-engine.ts`, `src/engine/grid-calculator-engine.ts`, `src/components/layout/*.ts`, `src/components/edit/*.ts`, `src/edit/*.ts`, `src/resource/*.ts`, `src/utils/*.ts`

---

## 목차

- [1. LRU 캐시 인프라](#1-lru-캐시-인프라)
- [2. 캐싱 전략](#2-캐싱-전략)
  - [2.1 글자 폭 캐시](#21-글자-폭-캐시-_charwidthcache)
  - [2.2 글자 외부 span 스타일 캐시](#22-글자-외부-span-스타일-캐시-_charouterstylecache)
  - [2.3 내부 span 스타일 캐시](#23-내부-span-스타일-캐시-_charinnerstyle)
  - [2.4 GridCalculatorEngine ppm 캐시](#24-gridcalculatorengine-ppm-캐시)
  - [2.5 이미지 3단계 캐시](#25-이미지-3단계-캐시)
  - [2.6 오버랩 rect 캐시](#26-오버랩-rect-캐시-_overlayrectsmm)
  - [2.7 폰트 파싱 캐시 + 시그니처 스킵](#27-폰트-파싱-캐시--시그니처-스킵)
  - [2.8 EditCoordinateMapper 매핑 캐시](#28-editcoordinatemapper-매핑-캐시)
  - [2.9 테이블 border edge 캐시](#29-테이블-border-edge-캐시-_borderedgemap)
- [3. 렌더링 최적화 전략](#3-렌더링-최적화-전략)
  - [3.1 Span 스타일 스킵 조건](#31-span-스타일-스킵-조건-_skipspanstyleifunchanged)
  - [3.2 queueMicrotask 배치 렌더링](#32-queuemicrotask-배치-렌더링-schedulerender)
  - [3.3 증분 스타일 시트 갱신](#33-증분-스타일-시트-갱신-_cachedcolstylekey)
  - [3.4 Diff 기반 데이터 세터](#34-diff-기반-데이터-세터-id-keyed-child-reconciliation)
  - [3.5 Diff 기반 span 렌더링](#35-diff-기반-span-렌더링-data-source-offset-key)
  - [3.6 단락 증분 전체 재생성 가드](#36-단락-증분-전체-재생성-가드-_perfshouldfullrecreate)
  - [3.7 단락 오버플로우 shadow change-gating](#37-단락-오버플로우-shadow-change-gating)
  - [3.8 라인/파트 요소 재사용](#38-라인파트-요소-재사용)
  - [3.9 가이드 컬럼 재사용](#39-가이드-컬럼-재사용)
  - [3.10 임시 span 제거](#310-임시-span-제거)
  - [3.11 AI 처리 오버레이 CSS 토글](#311-ai-처리-오버레이-css-토글)
  - [3.12 Skeleton 레이아웃 캐시](#312-skeleton-레이아웃-캐시-_layoutcache)
  - [3.13 charOffsets 단일 span 구조](#313-charoffsets-단일-span-구조)
- [4. 이벤트/입력 최적화](#4-이벤트입력-최적화)
  - [4.1 TextEditController 디바운스 렌더링](#41-texteditcontroller-디바운스-렌더링-_debouncedrender)
  - [4.2 낙관적 span](#42-낙관적-span-optimistic-span)
  - [4.3 마우스 좌표 최신성](#43-마우스-좌표-최신성)
  - [4.4 커서 dirty + rAF 단일 스케줄링](#44-커서-dirty--raf-단일-스케줄링)
  - [4.5 선택 하이라이트 div 풀 재사용](#45-선택-하이라이트-div-풀-재사용)
  - [4.6 EditManager _dispatching 재진입 가드](#46-editmanager-_dispatching-재진입-가드)
  - [4.7 EditManager _modeChangeSuppressed](#47-editmanager-_modechangesuppressed)
  - [4.8 LayoutEditController rAF 스로틀링](#48-layouteditcontroller-raf-스로틀링)
  - [4.9 LayoutEditController 3px 임계값](#49-layouteditcontroller-3px-임계값)
  - [4.10 LayoutEditController 시작 시 AABB 사전 수집](#410-layouteditcontroller-시작-시-aabb-사전-수집)
  - [4.11 LayoutEditController lockAxis 메모이제이션](#411-layouteditcontroller-lockaxis-메모이제이션)
  - [4.12 LayoutSelectionController marquee rAF + 3px](#412-layoutselectioncontroller-marquee-raf--3px)
  - [4.13 InsertController _lastPreviewRect 재사용](#413-insertcontroller-_lastpreviewrect-재사용)
  - [4.14 InsertController 컨테이너 후보 Map 스코어링](#414-insertcontroller-컨테이너-후보-map-스코어링)
  - [4.15 InsertController 기하 fallback 지연](#415-insertcontroller-기하-fallback-지연)
  - [4.16 PlaceGun 미리보기 요소 재사용](#416-placegun-미리보기-요소-재사용)
  - [4.17 텍스트 영역 스타일 JSON 가드](#417-텍스트-영역-스타일-json-가드)
- [5. 메모리 관리](#5-메모리-관리)
  - [5.1 Image Object URL 생명 주기 추적](#51-image-object-url-생명-주기-추적)
  - [5.2 Image canvas willReadFrequently](#52-image-canvas-willreadfrequently)
- [6. 기하/알고리즘 최적화](#6-기하알고리즘-최적화)
  - [6.1 mergeOverlapParts O(n) 병합](#61-mergeoverlapparts-on-병합)
  - [6.2 타원 기반 픽셀 컬링](#62-타원-기반-픽셀-컬링)
  - [6.3 GridCalculatorEngine editableHeight 정수 절사](#63-gridcalculatorengine-editableheight-정수-절사)
  - [6.4 staticGridContainment 조기 거부](#64-staticgridcontainment-조기-거부)
  - [6.5 flip-layout metricsById Map](#65-flip-layout-metricsbyid-map)
  - [6.6 테이블 seen Set 중복 셀 제거](#66-테이블-seen-set-중복-셀-제거)
  - [6.7 테이블 removeSet 배치 제거](#67-테이블-removeset-배치-제거)
- [7. 렌더링 핫 경로 전체 흐름](#7-렌더링-핫-경로-전체-흐름)
- [8. 캐시 용량 튜닝 가이드](#8-캐시-용량-튜닝-가이드)
- [9. 최적화되지 않은 영역](#9-최적화되지-않은-영역)
- [10. 향후 최적화 후보](#10-향후-최적화-후보)

---

## 1. LRU 캐시 인프라

### `LRU<K, V>` 제네릭 캐시 (`src/utils/lru-cache.ts`)

모든 캐시의 기반이 되는 제네릭 LRU 클래스. `Map`의 삽입 순서를 활용하여 eviction을 구현한다.

| 항목 | 값 |
|---|---|
| 자료구조 | `Map<K, V>` (삽입 순서 보장) |
| 용량 | 생성자 인수 `capacity` (양의 정수) |
| 제거 정책 | LRU — 용량 초과 시 가장 오래 사용되지 않은 항목(첫 번째 항목) 제거 |
| `get(key)` | 값 반환 + 해당 항목을 최근 사용 위치(끝)로 이동 |
| `has(key)` | 존재 여부 확인 (사용 순서 변경 없음) |
| `set(key, value)` | 기존 키면 갱신(위치 이동), 신규 키면 용량 체크 후 삽입 |
| `delete(key)` | 특정 키 삭제 |
| `clear()` | 전체 삭제 |

### 도입 배경

기존 `_charOuterStyleCache`는 `Map` + `size > 5000 → clear()` 전체 삭제 정책을 사용했다. 5000개 임계값 도달 시 **모든 캐시를 한 번에 무효화**하여 대형 문서에서 성능 급감(performance cliff)을 유발했다. LRU eviction은 초과 시 가장 오래된 항목 1개만 제거하므로 캐시 적중률이 안정적으로 유지된다.

---

## 2. 캐싱 전략

### 2.1 글자 폭 캐시 (`_charWidthCache`)

| 항목 | 값 |
|---|---|
| 위치 | `ParagraphEngine._charWidthCache` (`paragraph-engine.ts:69`) |
| 타입 | `LRU<string, number>` |
| 용량 | 5000 |
| 키 | `${char}\|${fontName}\|${fontSize}` |
| 값 | 원본 폰트 메트릭 폭 (mm, 장평 미적용) |
| 호출자 | `_layoutTextIntoColumns`, `genCharStyle`, `getCharWidths` |

레이아웃 핫 루프(`_layoutTextIntoColumns`)에서 매 글자마다 `FontLoader.getParsedFont()` + `parsedFont.charToGlyph()`가 재호출되는 것을 방지. 장평(`widthRatio`)은 키에 포함되지 않는다 (장평 곱셈은 호출자에서 적용하므로 동일 문자/폰트/크기는 장평이 바뀌어도 캐시 적중). `minWidthMm = spaceRatio × fontSize` 하한값은 반환 시점에 적용되어 캐시에 저장되지 않는다.

#### 캐시 무효화 시나리오

| 시나리오 | 캐시 영향 |
|---|---|
| 장평(`widthRatio`) 변경 | 영향 없음 (장평은 호출자에서 적용) |
| 폰트 크기 변경 | 새 `fontSize` 키 → 자동 신규 항목 |
| 폰트 패밀리 변경 | 새 `fontName` 키 → 자동 신규 항목 |
| 자간(`letterSpacing`) 변경 | 영향 없음 (자간은 `genCharStyle`에서 적용) |
| `spaceRatio` 변경 | 영향 없음 (캐시된 값은 원본 폭, 하한값은 반환 시 적용) |
| 새 폰트 로드 | 기존 `fontName` 키는 그대로; 새 `fontName` 키 생성 |
| 단락 제거 | `ParagraphEngine` 인스턴스 소멸 → 캐시도 GC 대상 |

### 2.2 글자 외부 span 스타일 캐시 (`_charOuterStyleCache`)

| 항목 | 값 |
|---|---|
| 위치 | `ParagraphEngine._charOuterStyleCache` (`paragraph-engine.ts:66`) |
| 타입 | `LRU<string, Partial<CSSStyleDeclaration>>` |
| 용량 | 5000 |
| 키 | `${char}\|${widthRatio}\|${letterSpacing}\|${spaceRatio}\|${fontSize}` |
| 값 | `genCharStyle()` 결과 CSS 스타일 객체 |

`genCharStyle()`은 장평을 적용한 최종 `width`를 CSS 값으로 포함하므로 장평이 키에 포함된다. `width` 계산에 `letterSpacing`(`lsMm`)과 `spaceRatio`도 사용되므로 이 값들도 키에 포함된다 — 자간이나 공백 비율이 변경되면 별도 캐시 항목이 생성되어 잘못된 스타일이 반환되는 것을 방지한다. 이전에는 `Map` + `size > 5000 → clear()` 전체 삭제 정책이었으나 LRU eviction으로 변경하여 성능 cliff를 제거.

#### LRU 도입 전후 비교

| 항목 | 이전 (`Map` + `clear()`) | 이후 (`LRU`) |
|---|---|---|
| 제거 시점 | `size > 5000` 도달 시 | `set` 시 용량 초과 시 |
| 제거 범위 | 전체 항목 (5000개 전부) | 가장 오래된 항목 1개 |
| 성능 특성 | 임계값 도달 시 급감 (cliff) | 안정적 (O(1) eviction) |
| 적중률 | 임계값 이후 0% → 재빌드 | 지속적 높은 적중률 |

### 2.3 내부 span 스타일 캐시 (`_charInnerStyle`)

| 항목 | 값 |
|---|---|
| 위치 | `ParagraphEngine._charInnerStyle` / `_charInnerStyleKey` (`paragraph-engine.ts:68-69`) |
| 타입 | 단일 키 메모이제이션 (LRU 아님) |
| 키 | `inner\|${widthRatio}` |

모든 글자의 내부 span은 동일 스타일을 사용하므로(글자 무관, 장평에만 의존) 단일 키 메모이제이션으로 충분하다.

### 2.4 GridCalculatorEngine ppm 캐시

| 항목 | 값 |
|---|---|
| 위치 | `GridCalculatorEngine._ppm` (`grid-calculator-engine.ts:55`) |
| 타입 | `static number \| undefined` (싱글톤) |
| 무효화 | `GridCalculatorEngine.resetPpm()` 호출 시 |

최초 접근 시 100mm `<div>`를 생성하여 `getBoundingClientRect()`로 픽셀 폭을 측정하고 `px/100`을 `_ppm`에 저장. 이후 접근은 DOM 측정 없이 캐시된 값을 반환. 줌/CSS transform 등으로 ppm이 변경될 수 있으므로 `resetPpm()`으로 수동 무효화 필요.

### 2.5 이미지 3단계 캐시

| 단계 | 필드 | 위치 | 설명 |
|---|---|---|---|
| resolved URL | `_cachedResolvedUrl` | `image.element.ts:102` | `urlLoader` 결과를 캐싱하여 재호출 방지 |
| HTMLImageElement | `_cachedImage` + `_cachedImageSrc` | `image.element.ts:84-90` | 로드된 이미지 객체를 재사용하여 네트워크 재요청 방지 |
| 로딩 Promise | `_imageLoadingPromise` | `image.element.ts` | 동일 URL에 대한 동시 로드 요청을 하나의 Promise로 통합 |

캐시 히트 시 동기 `drawImage` 경로로 진행하여 `await` 없이 빈 프레임 없이 즉시 렌더링 (`image.element.ts:237-256`).

### 2.6 오버랩 rect 캐시 (`_overlayRectsMm`)

| 항목 | 값 |
|---|---|
| 위치 | `ParagraphEngine._overlayRectsMm` (`paragraph-engine.ts:77`) |
| 타입 | `Map<LayoutBoxElement, MmRect> \| null` |
| 생명 주기 | `_initStructureAndMeasureColumns()` 시작 시 `null` 리셋, 첫 `_detectOverlapWithCache()` 호출 시 구축 |

한 렌더링 사이클 내에서 오버랩 요소의 rect를 `Map`에 캐싱하여 `getBoundingClientRect()` 호출을 1회로 통합. 라인 수 × 오버랩 요소 수번의 강제 리플로우를 1번으로 감소.

### 2.7 폰트 파싱 캐시 + 시그니처 스킵

| 항목 | 위치 | 설명 |
|---|---|---|
| `_parsedFonts` | `font-loader.ts:42` | `Map<string, opentype.Font>` — 폰트 패밀리별 파싱된 폰트 객체 캐싱 |
| `_lastFontsSignature` | `font-loader.ts:50, 240` | 동일 `Font[]`이 전달되면 `init()` 스킵 (재파싱/재등록 방지) |
| `_ready` | `font-loader.ts` | 초기화 완료 플래그 |

`_computeFontsSignature()`로 폰트 배열의 변경 여부를 판단하여 동일 폰트 데이터 재전달 시 `FontFace` 등록 및 `opentype.parse()`를 전체 스킵한다.

### 2.8 EditCoordinateMapper 매핑 캐시

| 캐시 | 위치 | 키 | 설명 |
|---|---|---|---|
| `_sourceToPlacement` | `text-edit-coordinate-mapper.ts:42` | source offset (`number`) | O(1) source→placement 매핑. 단일 O(n) 빌드 패스 후 O(1) 조회 |
| `_spanCache` | `text-edit-coordinate-mapper.ts:44` | source offset (`number`) | span 요소 캐싱 |
| `_columnSpansCache` | `text-edit-coordinate-mapper.ts:45` | `LayoutColumnElement` | 컬럼별 span 배열 캐싱. `querySelectorAll` 호출을 `rebuild()` 주기당 1회로 통합 |
| `_columnRanges` | `text-edit-coordinate-mapper.ts` | — | 컬럼별 시작/끝 source offset 범위 |
| `_lineSourceOffsets` | `text-edit-coordinate-mapper.ts` | — | 라인별 source offset 시작 위치 |

`rebuild()` 호출 시 모든 캐시가 `clear()`되고 `_rebuildMappings()`로 재구축. `rebuild()`는 `EditController.postRender()`에서 호출되므로 렌더링 후 자동 갱신.

`getNearestOffsetFromPoint()` 내부에서 로컬 `Map<HTMLSpanElement, DOMRect>`를 구축하여 모든 `getBoundingClientRect()` 호출을 단일 패스로 통합한다.

### 2.9 테이블 border edge 캐시 (`_borderEdgeMap`)

| 항목 | 값 |
|---|---|
| 위치 | `table.element.ts:53` |
| 타입 | `Map<string, HTMLDivElement>` |
| 키 | `edge.key` (보더 엣지 고유 키) |

`_renderBorder()`에서 기존 div를 `edge.key`로 재사용하고, 새 엣지 세트에 없는 키의 div만 제거. 매 렌더마다 모든 보더 div를 재생성하는 것을 방지.

---

## 3. 렌더링 최적화 전략

### 3.1 Span 스타일 스킵 조건 (`_skipSpanStyleIfUnchanged`)

| 항목 | 값 |
|---|---|
| 위치 | `LayoutColumnElement._skipSpanStyleIfUnchanged()` (`column.element.ts:172`) |
| 스킵 조건 | `data-offset` === renderedOffset **AND** `data-source-offset` === sourceOffset **AND** inner `textContent` === char |

`renderText()` diff 루프에서 재사용 span의 오프셋/내용이 동일하면 `_applySpanStyle()` 전체 스킵 (`cssText = ''` + `Object.assign` + inner span 갱신 생략).

#### 스킵이 발생하는 시나리오

- **부모 박스 이동**: 박스 위치 변경 → 단락 `layout()` + `render()` → 컬럼 `renderText()` → 텍스트 내용/오프셋 변경 없음 → 모든 재사용 span 스킵
- **오버플로우 상태 변경 없음**: 동일 텍스트 재렌더링 시 전체 스킵
- **스타일 변경 없는 재렌더**: `scheduleRender()` 배치 후 동일 내용 재렌더 시

#### 스킵이 발생하지 않는 시나리오

- **텍스트 편집**: 글자 추가/삭제 → 오프셋 변경 → 스킵 불가
- **장평/자간 변경**: `textStyle` setter가 `_perfStructureChanged = true`를 설정하여 `render()`에서 전체 재생성(`replaceChildren()`)을 트리거 → diff 루프가 아닌 신규 span 생성 경로로 진입
- **컬럼 수 변경**: `_perfShouldFullRecreate()`가 전체 재생성을 트리거 → diff 루프 미진입

### 3.2 queueMicrotask 배치 렌더링 (`scheduleRender`)

| 항목 | 값 |
|---|---|
| 위치 | `LayoutParagraphElement.scheduleRender()` (`paragraph.element.ts:763`) |
| 배치 메커니즘 | `queueMicrotask()` |
| 통합 대상 | `textStyle` / `paragraphStyle` / `column` / `gap` setter, `markStructureChangedAndRender()` |

한 이벤트 루프 틱 내의 다중 `render()` 호출을 `queueMicrotask`로 하나로 통합. `layout()`은 동기적으로 즉시 실행되며 `render()`만 배치된다.

```
이벤트 루프 틱:
  1. textStyle = {...}  → layout() + scheduleRender()  (예약)
  2. column = 3          → layout() + scheduleRender()  (스킵 — 이미 예약됨)
  3. gap = 2             → layout() + scheduleRender()  (스킵 — 이미 예약됨)
  ── 마이크로태스크 ──
  4. render() 실행 (1회)
```

> **주의**: `render()` 내부에서 `editController.postRender()` 및 `render-complete`/`render-error` 이벤트 디스패치가 수행되므로, 배치로 인해 이벤트 발생 시점이 미루어진다. 외부 코드에서 이벤트 리스너를 통해 다음 동작을 결정하는 경우, `queueMicrotask` 지연(일반적으로 <1ms)을 고려해야 한다.

### 3.3 증분 스타일 시트 갱신 (`_cachedColStyleKey`)

| 항목 | 값 |
|---|---|
| 위치 | `LayoutColumnElement._cachedColStyleKey` (`column.element.ts:14`) |
| 비교 방식 | `JSON.stringify(colStyle)` 문자열 비교 |

`renderText()`에서 `:host` CSS rule을 colStyle이 실제로 변경된 경우에만 재구축. 미변경 시 `deleteRule`/`insertRule`/`Object.assign` 스킵.

#### 스킵이 발생하는 시나리오

- 부모 박스 이동 (컬럼 스타일은 위치에 영향받지 않음)
- 텍스트 편집에 의한 재렌더 (컬럼 폭/높이 변경 없음)
- `scheduleRender()` 배치 후 재렌더

#### 스킵이 발생하지 않는 시나리오

- 컬럼 수 변경 (`column` setter)
- 컬럼 간격 변경 (`gap` setter)
- 단락 폭 변경 (상속 스타일 변경)

### 3.4 Diff 기반 데이터 세터 (ID-keyed child reconciliation)

| 요소 | 위치 |
|---|---|
| `LayoutDocumentElement.data` | `document.element.ts:342-406` |
| `LayoutBoxElement.data` | `box.element.ts:550-637` |
| `LayoutTableElement.data` | `table.element.ts:169-197` |
| `LayoutTableRowElement.data` | `tr.element.ts:82-124` |
| `LayoutTableCellElement.data` | `td.element.ts:146-212` |

기존 자식을 `id`로 매핑(`Map<id, element>`), 동일 `id`+동일 태그 타입이면 `element.data = child`로 in-place 갱신, 순서는 `appendChild`로 재정렬, 미사용 `id`는 제거. 전체 자식 재생성(이미지 깜빡임, GC 부하)을 방지.

#### `_pendingData` getter 캐시

`box.element.ts:87-88`, `document.element.ts:35-36` — 데이터 세터 실행 중 `_rebuildingChildren = true`일 때 getter가 `_pendingData`를 반환하여 외부 코드가 중간 상태를 읽지 않도록 방지.

#### `_rebuildingChildren` MutationObserver 가드

`box.element.ts:1743-1761`, `document.element.ts:612-629`, `tr.element.ts:236-244`, `td.element.ts` — `MutationObserver`가 `_rebuildingChildren === true`일 때 콜백을 스킵하여 데이터 세터 실행 중 중복 `layout()` + `render()`를 방지.

#### 박스 value-equal setter 조기 반환

`box.element.ts:749-779` — 각 기하 setter(`left`/`top`/`width`/`height`/`zIndex`)가 `if (this._left === value) return;`로 동일 값 재설정 시 `layout()` + `render()`를 스킵.

#### 박스 영향 단락 재렌더링 microtask 배치

`box.element.ts:1554` — `scheduleRerenderAffectedParagraphs()`는 `_rerenderScheduled` 플래그 + `queueMicrotask`로 배치. 드래그 중이 아닐 때 여러 setter가 연속 호출되어도 `_collectAffectedParagraphs()` AABB 계산을 microtask당 1회로 통합. `scheduleRender()`의 `_renderScheduled` 가드가 단락 중복 `render()`를 방지하므로 실제 렌더링은 1회만 실행.

### 3.5 Diff 기반 span 렌더링 (`data-source-offset` key)

| 항목 | 값 |
|---|---|
| 위치 | `LayoutColumnElement.renderText()` (`column.element.ts:163`) |
| reconciliation key | `span.dataset.sourceOffset` |

기존 span을 `data-source-offset` 기준으로 `Map`에 저장하고, 새 content의 각 문자에 대해 source offset을 계산하여 재사용/갱신/생성/제거. `innerHTML = ''`를 사용하지 않고 `<style>` 요소를 보존.

> **`data-source-offset` vs `data-offset`**: `data-source-offset` = 소스 문자열의 문자 위치 (diff key). `data-offset` = 렌더링된 문자 위치 (`TextEditCoordinateMapper`가 클릭-to-커서 매핑에 사용). 두 속성은 모든 span에 공존.

### 3.6 단락 증분 전체 재생성 가드 (`_perfShouldFullRecreate`)

| 항목 | 값 |
|---|---|
| 위치 | `LayoutParagraphElement._perfShouldFullRecreate()` (`paragraph.element.ts:310`) |
| 조건 | `lineCountBefore === -1 \|\| lineCountBefore !== lineCountAfter \|\| overflowBefore !== overflowAfter` |

`lineCountBefore === -1`(초기 렌더, `resetIncrementalState()` 직후)이거나 라인 수/오버플로우가 변경된 경우에만 `replaceChildren()` + 전체 컬럼 재생성. 변경이 없으면 기존 컬럼의 `renderText()`만 호출.

> **`wasStructureDirty` 제거**: 이전에는 `_perfStructureChanged === true`이면 무조건 전체 재생성이 트리거되었다. 그러나 박스 이동 시 Skeleton 캐시가 히트하면 `columnContents`가 동일 → 라인 수/오버플로우 불변이므로 diff 렌더링으로 충분하다. `wasStructureDirty` 조건을 제거하여 diff 경로로 진입하도록 완화. 단, `resetIncrementalState()`가 `_previousLineCount = -1`로 설정하므로 구조 변경 후 첫 렌더는 여전히 `lineCountBefore === -1` 경로로 전체 재생성된다.

### 3.7 단락 오버플로우 shadow change-gating

| 항목 | 값 |
|---|---|
| 위치 | `LayoutParagraphElement.render()` (`paragraph.element.ts:246-249`) |

오버플로우 상태가 변경된 경우에만 `_applyStyle()` 호출 (하단 inset shadow 스타일 갱신). 미변경 시 스타일시트 재기록 스킵.

### 3.8 라인/파트 요소 재사용

| 항목 | 위치 |
|---|---|
| 라인 div | `column.element.ts:247-249` |
| 파트 div | `column.element.ts:270-277` |

인덱스 기반 재사용 — 기존 `<div>` 자식이 있으면 재사용, 부족하면 생성, 초과하면 제거. 매 렌더마다 모든 라인/파트 div를 재생성하는 것을 방지.

### 3.9 가이드 컬럼 재사용

| 항목 | 위치 |
|---|---|
| 길이 + 속성 비교 | `document.element.ts:227-250` |
| 비가시 조기 반환 | `guide-column.element.ts:53-58` |

기존 가이드 컬럼 수와 새 컬럼 수가 같으면 기존 요소를 재사용하고 `rect`/`fontSize`/`lineHeight`/`visible` 중 변경된 속성만 갱신. 비가시 시 `innerHTML = ''` 후 즉시 반환.

### 3.10 임시 span 제거

`column.element.ts:200-201` — `data-temporary` 속성을 가진 span(IME 조합 중 생성된 임시 span)을 diff 시작 전 모두 제거. diff 렌더링이 임시 span을 잘못 재사용하는 것을 방지.

### 3.11 AI 처리 오버레이 CSS 토글

`ai-processing-overlay.ts:73-85, 105-109` — 오버레이는 한 번만 생성. `setAiProcessingActive()`는 `data-active` 속성만 토글하여 CSS `display`를 변경. `layout()`/`render()`를 트리거하지 않아 비용이 거의 없다.

### 3.12 Skeleton 레이아웃 캐시 (`_layoutCache`)

| 항목 | 값 |
|---|---|
| 위치 | `ParagraphEngine._layoutCache` (`paragraph-engine.ts:81`) |
| 타입 | `{ hash: string; columnContents: TextLineData[][]; overflow: number } \| null` |
| 적용 대상 | `_layoutTextIntoColumns()` 진입부 |

`_layoutTextIntoColumns()`가 호출될 때마다 전체 텍스트를 0번째 컬럼부터 끝까지 재배치하는 것을 방지. `_computeLayoutInputHash()`로 입력 매개변수를 해시화하고, 해시가 동일하면 캐시된 `_columnContents`와 `_overflow`를 반환하여 재배치를 생략.

#### 해시에 포함되는 입력 매개변수

| 매개변수 | 설명 |
|---|---|
| `textContent` | 텍스트 내용 |
| `_columnWidths` + `_gaps` | 컬럼 폭/간격 |
| `_lineHeight` | 줄 높이 (fontSize × lineGap) |
| `widthRatio` | 장평 |
| `letterSpacing` | 자간 |
| `spaceRatio` | 공백 비율 |
| `fontSize` | 폰트 크기 |
| `_inheritStyle.parentHeight` | 단락 높이 (오버플로우 판정) |
| 오버랩 요소 **상대 좌표** (`el.absLeft - paragraph.absLeft`, `el.absTop - paragraph.absTop`) | 단락 기준 상대 위치. 오버랩 요소가 없으면 해시에 포함되지 않음 |
| 오버랩 요소 `absWidth/absHeight` | 오버랩 크기 |
| 오버랩 요소 `overlapMode` | 오버랩 처리 모드 (`'path'`/`'box'`). 모드 변경 시 캐시 무효화 |

> **단락 절대 위치(`paragraph.absLeft`/`absTop`)는 해시에서 제외됨**. 오버랩 판정은 단락 rect와 오버랩 요소 rect의 **상대 기하학**에만 의존하므로, 절대 좌표 대신 오버랩 요소의 단락 기준 상대 좌표를 사용한다. 이로써:
> - **오버랩 없는 박스 이동**: 해시 불변 → 캐시 히트 → 재배치 스킵
> - **부모 박스 통째 이동**: 단락과 오버랩 요소가 동시에 이동 → 상대 좌표 불변 → 캐시 히트
> - **오버랩 요소만 독립 이동**: 상대 좌표 변화 → 캐시 미스 → 재배치 (정확성 유지)

#### 캐시 무효화

- `resetIncrementalState()` 호출 시 `_layoutCache = null` (구조 변경 시)
- 입력 매개변수 변경 시 자동으로 해시가 달라져 캐시 미스 → 전체 재배치
- **이미지 로드 완료 시**: `LayoutImageElement.render()`의 캐시 미스(첫 로드) 경로 완료 후 `_notifyOverlapParagraphs()`가 부모 박스의 `requestRerenderAffectedParagraphs()`를 호출 → `markStructureChangedAndRender()` → `resetIncrementalState()` → 캐시 무효화 → 재배치. 최초 로딩 시 이미지 canvas가 비어 있는 상태에서 단락이 먼저 렌더링되어 오버랩 판정이 누락되는 문제를 해결.

#### 효과

| 시나리오 | 현재 (캐시 없음) | Skeleton 캐시 적용 후 |
|---|---|---|
| 박스 이동 (오버랩 없음, 컬럼 폭 변경 없음) | `_layoutTextIntoColumns()` 2~8ms | 해시 계산 ~0.1ms → **캐시 히트 → 0ms** |
| 부모 박스 통째 이동 (오버랩 요소 포함) | `_layoutTextIntoColumns()` 2~8ms | 상대 좌표 불변 → **캐시 히트 → 0ms** |
| `scheduleRender` 배치 후 동일 입력 재렌더 | `_layoutTextIntoColumns()` 재실행 | **해시 히트 → 0ms** |
| 단락 끝 1글자 타이핑 | 전체 재배치 | 해시 미스 → 전체 재배치 (정확함) |
| 장평/자간 변경 | 전체 재배치 | 해시 미스 → 전체 재배치 (정확함) |
| 오버랩 이미지만 독립 이동 | 전체 재배치 | 상대 좌표 변화 → 해시 미스 → 전체 재배치 (정확함) |
| 이미지 첫 로드 완료 | 오버랩 누락 (canvas 비어있음) | `_notifyOverlapParagraphs()` → 캐시 무효화 → **재배치로 오버랩 정상 적용** |

#### 테이블 `refreshBorder` 증분 갱신

`table.element.ts:473-478` — 보더 속성 변경 시 자식 TD/TR DOM 트리를 재구축하지 않고 `_layoutStructure()` + `_renderBorder()`만 실행.

#### 테이블 리사이즈 중 write-back 스킵

`table.element.ts:289-297` — 리사이즈 핸들 드래그 중 `_resizeState`가 존재할 때 `data` write-back을 스킵하여 레이아웃 스래싱 방지.

### 3.13 charOffsets 단일 span 구조

| 항목 | 값 |
|---|---|
| 위치 | `LayoutColumnElement._applySpanStyle()` (`column.element.ts:163`) |
| 스타일 | `ParagraphEngine.genCharStyleFlat()` (`paragraph-engine.ts:1140`) |
| 적용 조건 | `charOffsetMm !== undefined` (charOffsets 절대 좌표 경로) |

charOffsets 경로에서는 outer/inner 중첩 span 대신 **단일 span**을 사용한다. absolute 배치이므로 outer의 `width`/`textAlign`이 의미 없고, 정렬은 charOffsets가 직접 산출한다. inner의 `scale`/`transformOrigin`을 단일 span에 직접 적용(`genCharStyleFlat()`).

편집 모드(`editableText=true`)에서도 charOffsets가 활성화되어 단일 span + absolute 배치를 사용한다.
임시 span(optimistic, IME 조합)은 `columnContents`에 포함되지 않으므로, 삽입 시 기준 span의
`data-char-offset`과 `data-swidth`로부터 임시 span의 `left`를 동적 계산한다
(`TextEditController._computeTempSpanLeft()`).

flexbox 폴백 경로(`charOffsets === undefined`, 외부에서 임의로 `TextPartData`를 생성한 경우)에서만
기존 outer/inner 중첩 span 구조를 유지한다.

| 항목 | 중첩 span (flexbox) | 단일 span (charOffsets) |
|---|---|---|
| DOM 노드 수 | 글자 수 × 2 | 글자 수 × 1 (**50% 감소**) |
| `_applySpanStyle` DOM 작업 | `querySelector` + inner 생성/갱신 | `textContent` 직접 설정 |
| `_skipSpanStyleIfUnchanged` | `querySelector` + inner textContent 비교 | `textContent` 직접 비교 |
| 스타일 속성 | outer `width`/`textAlign` + inner `scale` | `scale`/`transformOrigin`/`position`/`left` 통합 |
| 편집 모드 | 미사용 (charOffsets 활성화) | 임시 span 동적 offset 계산 |

#### `printPostData` 호환성

`paragraph.element.ts:770-778` — `printPostData`는 inner span 존재 여부로 분기:
- inner 있으면(중첩 span): `inner.textContent`에서 글자, `inner.style.scale`에서 widthRatio 추출
- inner 없으면(단일 span): `span.textContent`에서 글자, `span.style.scale`에서 widthRatio 추출

두 경로 모두 자연스럽게 처리되므로 `printPostData`는 변경 없이 호환됨.

---

## 4. 이벤트/입력 최적화

### 4.1 TextEditController 디바운스 렌더링 (`_debouncedRender`)

| 항목 | 값 |
|---|---|
| 위치 | `text-edit-controller.ts:1860-1868` |
| 메커니즘 | `requestAnimationFrame` → `scheduleRender()` |
| 통합 대상 | 키 입력, Backspace, Delete, Enter, 붙여넣기, 문자 입력 |

`_debounceTimer`에 보류 중인 rAF가 있으면 취소하고 새 rAF 스케줄링. rAF 콜백 내에서 `paragraph.scheduleRender()`를 호출하여 `queueMicrotask` 배치에 참여. blur/compositionstart/compositionupdate 핸들러도 `scheduleRender()`를 사용하여 배치 통합.

Enter/compositionend 핸들러와 같이 `render()` 직후 동기적 커서/선택 갱신이 필요한 경우 `paragraph.flushRender()`를 사용 — 대기 중인 `scheduleRender()` 배치를 취소하고 즉시 `render()`를 실행하여 `postRender()` → `_updateCursorPosition()` 흐름을 동기적으로 보장.

### 4.2 낙관적 span (optimistic span)

| 항목 | 값 |
|---|---|
| 위치 | `text-edit-controller.ts:73, 1768-1800` |

입력 즉시 `_optimisticSpan`에 글자를 삽입하여 사용자에게 시각적 피드백 제공. `render()` 대기 시간 동안 사용자가 입력한 글자를 즉시 볼 수 있으며, `render()` 후 `renderText()`가 실제 span으로 교체.

### 4.3 마우스 좌표 최신성

| 항목 | 값 |
|---|---|
| 위치 | `text-edit-controller.ts:81-83, 607-622` |

`_onMouseMove`가 매 mousemove 이벤트마다 `_lastMouseX`/`_lastMouseY`를 저장하고 `requestAnimationFrame` 콜백에서 읽음. 빠른 마우스 이동 중에도 드래그 선택이 커서를 정확히 따라가도록 보장.

### 4.4 커서 dirty + rAF 단일 스케줄링

| 항목 | 값 |
|---|---|
| 위치 | `cursor.element.ts:15-45` |

`_dirty` 플래그 + 단일 `_rafId`로 커서 위치 변경 시 중복 DOM 스타일 기록을 방지. 이미 스케줄된 rAF가 있으면 재스케줄하지 않음.

### 4.5 선택 하이라이트 div 풀 재사용

| 항목 | 값 |
|---|---|
| 위치 | `selection.element.ts:10, 28-51` |

`_pool: HTMLDivElement[]`를 유지하여 선택 영역 변경 시 미사용 div는 `visibility: hidden`으로 숨기고, 인덱스로 재사용. 범위 수가 증가할 때만 새 div를 생성. 매 선택 변경마다 div를 생성/파괴하는 것을 방지.

### 4.6 EditManager `_dispatching` 재진입 가드

| 항목 | 값 |
|---|---|
| 위치 | `edit-manager.ts:159` (모든 `_dispatch*` 메서드) |

이벤트 리스너가 추가 이벤트를 트리거할 때 무한 루프/중복 처리를 방지. `_dispatching === true`이면 즉시 반환. `try/finally`로 플래그를 리셋.

### 4.7 EditManager `_modeChangeSuppressed`

| 항목 | 값 |
|---|---|
| 위치 | `edit-manager.ts:202, 357-361` |

여러 모드 세터가 내부적으로 연쇄 호출될 때 중간 `modeChange` 이벤트 발생을 억제. 플래그 설정 후 연쇄 호출, 플래그 해제 후 최종 1회만 이벤트 발생.

### 4.8 LayoutEditController rAF 스로틀링

| 항목 | 위치 |
|---|---|
| 드래그 | `layout-edit-controller.ts:717` |
| 리사이즈 | `layout-edit-controller.ts:1095` |

`requestAnimationFrame`으로 박스 위치/크기 갱신을 60fps 이내로 스로틀링. 매 mousemove마다 `layout()` + `render()`를 실행하지 않고 다음 프레임에 1회만 실행.

### 4.9 LayoutEditController 3px 임계값

| 항목 | 위치 |
|---|---|
| 드래그 | `layout-edit-controller.ts:710-713` |
| 리사이즈 | `layout-edit-controller.ts:1089-1093` |

`Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3`일 때만 `dragMoved`/`moved`를 `true`로 설정. 미세한 마우스 이동을 드래그/리사이즈로 처리하지 않음.

### 4.10 LayoutEditController 시작 시 AABB 사전 수집

| 항목 | 위치 |
|---|---|
| 드래그 | `layout-edit-controller.ts:654-655` |
| 리사이즈 | `layout-edit-controller.ts:1054-1055` |

드래그/리사이즈 시작 시 박스의 parent-relative rect를 캡처하고 `state.affectedParagraphs`에 영향받는 단락 집합을 한 번에 수집. 매 프레임마다 재계산하지 않음.

#### Box AABB 필터링 영향 단락 수집

`box.element.ts:1609-1692` — 드래그/리사이즈 중 박스의 AABB와 교차하는 형제 박스의 자식 단락만 수집. 매 setter 호출마다 형제 전체 순회 비용을 줄임.

#### Box 드래그/리사이즈 rAF 배치

`box.element.ts:1585-1597` — `_scheduleDragRerender`로 단일 `requestAnimationFrame`을 스케줄하고 동일 rAF 프레임 내 여러 setter 호출을 1회 갱신으로 배치.

#### 드래그 중 diff 렌더링 경로 (`renderForDrag`)

`box.element.ts:_renderAffectedParagraphs(affected, isDrag=true)` — 드래그/리사이즈 중에는 `markStructureChangedAndFlushRender()` 대신 `paragraph.renderForDrag()`를 호출. `renderForDrag()`는 `_perfStructureChanged`를 `true`로 설정하지 않고 `flushRender()`만 실행.

- **비드래그 경로**(`markStructureChangedAndFlushRender`): `_perfStructureChanged = true` → `render()`에서 `resetIncrementalState()` + `layoutStructure()` + 전체 재생성. 드래그 종료(`flushDragRerender`) 및 비드래그 setter에서 사용.
- **드래그 경로**(`renderForDrag`): `_perfStructureChanged = false` 유지 → `render()`에서 `layoutText()`만 호출 (Skeleton 캐시 히트 시 즉시 반환) → `_perfShouldFullRecreate()`가 `false` → diff 기반 `renderText()` → `_skipSpanStyleIfUnchanged`가 모든 span 스킵.

이로써 드래그 중 매 프레임 `replaceChildren()` + 전체 span 재생성이 발생하던 성능 저하를 해결. 텍스트 내용이 아닌 박스 위치만 변경된 경우 Skeleton 캐시가 히트하면 0ms에 가까운 렌더링.

### 4.11 LayoutEditController lockAxis 메모이제이션

| 항목 | 값 |
|---|---|
| 위치 | `layout-edit-controller.ts:1266-1273, 1329-1336` |

Shift 제약 드래그 중 첫 의미 있는 이동이 발생할 때 잠금 축을 한 번 결정하고 드래그 세션 종료까지 유지. 매 이벤트마다 축을 재계산하지 않음.

### 4.12 LayoutSelectionController marquee rAF + 3px

| 항목 | 값 |
|---|---|
| 위치 | `layout-selection-controller.ts:13-30, 313-335` |

marquee 선택 시 3px 이동 임계값 통과 후에만 `requestAnimationFrame`으로 marquee DOM 갱신을 스케줄링. 매 mousemove마다 marquee를 갱신하지 않음.

### 4.13 InsertController `_lastPreviewRect` 재사용

| 항목 | 값 |
|---|---|
| 위치 | `insert-controller.ts:22, 99, 111-112, 153` |

마지막으로 계산된 미리보기 rect를 저장하고 재사용. 매 mousemove마다 처음부터 미리보기 rect를 재계산하지 않음.

### 4.14 InsertController 컨테이너 후보 Map 스코어링

| 항목 | 값 |
|---|---|
| 위치 | `insert-controller.ts:394-417` |

드래그 영역의 네 모서리에서 `elementsFromPoint`를 호출하고 각 컨테이너의 히트 수를 `Map`으로 스코어링. 가장 깊은 완전 포함 컨테이너를 선택. 모든 요소를 반복적으로 조회하지 않음.

### 4.15 InsertController 기하 fallback 지연

| 항목 | 값 |
|---|---|
| 위치 | `insert-controller.ts:428-463` |

코너 히트 테스트로 유효한 박스 후보를 찾지 못한 경우에만 `querySelectorAll('x-layout-box')` 전체 스캔 실행. 일반적인 경우 비용이 큰 전체 문서 박스 스캔을 지연.

### 4.16 PlaceGun 미리보기 요소 재사용

| 항목 | 값 |
|---|---|
| 위치 | `place-gun-controller.ts:50, 57, 80-85` |

`_previewEl`과 `_highlightTarget` 참조를 유지하여 매 mousemove마다 미리보기 요소를 재생성하지 않음. 필요할 때만 제거.

### 4.17 텍스트 영역 스타일 JSON 가드

| 항목 | 값 |
|---|---|
| 위치 | `text-edit-controller.ts:74, 2083-2084` |

`JSON.stringify`로 직렬화한 스타일 객체를 `_lastStyleJson`과 비교하여 동일하면 textarea 스타일 재적용을 스킵.

---

## 5. 메모리 관리

### 5.1 Image Object URL 생명 주기 추적

| 항목 | 값 |
|---|---|
| 위치 | `image.element.ts:74, 130-134, 260-265` |

`urlLoader`가 `blob:` URL을 반환하거나 `url` 자체가 `blob:`인 경우, `_objectUrl`에 추적. 재렌더 시 새 URL이 기존과 다르면 `URL.revokeObjectURL()`로 이전 URL 해제. `disconnectedCallback`에서도 해제. 메모리 누수 방지.

### 5.2 Image canvas willReadFrequently

| 항목 | 값 |
|---|---|
| 위치 | `image.element.ts:229` |

`canvas.getContext('2d', { willReadFrequently: true })`로 컨텍스트를 요청. 브라우저가 CPU 기반 백엔드(GPU가 아닌)를 선택하여 `getImageData()` 읽기 성능을 최적화. 오버랩 탐지 및 object-fit 렌더링에서 캔버스 픽셀 읽기가 빈번하므로 중요.

---

## 6. 기하/알고리즘 최적화

### 6.1 mergeOverlapParts O(n) 병합

| 항목 | 값 |
|---|---|
| 위치 | `engine/overlap-engine.ts` |

오버랩 파트를 `x1` 기준 정렬 후 O(n) 순회로 겹치는/접하는 구간을 병합. 텍스트 래퍼가 처리해야 할 구간 수를 감소.

### 6.2 타원 기반 픽셀 컬링

| 항목 | 값 |
|---|---|
| 위치 | `engine/overlap-engine.ts` (ellipse detection) |

`overlapPadding`이 설정된 경우 `opaqueColumns: Set<number>`로 불투명 픽셀의 열을 기록. 정규화된 타원 거리(`ndx² + ndy² ≤ 1`) 조건으로만 차단 여부를 판정. 투명 픽셀은 제외. 기하 fallback은 캔버스를 사용할 수 없는 경우에만 사용.

### 6.3 GridCalculatorEngine editableHeight 정수 절사

| 항목 | 값 |
|---|---|
| 위치 | `grid-calculator-engine.ts:150` |

`Math.floor((height - padding) / lineHeight) * lineHeight`로 편집 가능 높이를 항상 lineHeight의 정수 배로 보장. 소수 라인으로 인한 분할 레이아웃을 방지.

### 6.4 staticGridContainment 조기 거부

| 항목 | 값 |
|---|---|
| 위치 | `static-grid-containment.ts:47-63` |

음수 left/top, 무효 width/height, 컬럼/라인 초과 등 부적절한 static 삽입 위치를 즉시 `false` 반환. 전체 검증을 수행하기 전에 빠르게 거부.

### 6.5 flip-layout metricsById Map

| 항목 | 값 |
|---|---|
| 위치 | `flip-layout.ts:45, 254` |

박스 mm 메트릭을 `metricsById` Map으로 미리 주입하여 레이아웃 플립 중 재계산을 방지. `box.lock === true`인 서브트리는 변경 없이 원본 반환.

### 6.6 테이블 seen Set 중복 셀 제거

| 항목 | 값 |
|---|---|
| 위치 | `table-keyboard-controller.ts:607` |

셀 블록 선택 영역 확장 시 `Set<string>`(키 `row-col`)으로 동일 물리 셀의 중복 추가를 방지. 병합된 셀을 스팬할 때 중복을 방지.

### 6.7 테이블 removeSet 배치 제거

| 항목 | 값 |
|---|---|
| 위치 | `table-structure-editor.ts:55, 56-61, 69-77` |

셀 병합 중 제거할 물리적 인덱스를 `Set<string>`으로 수집한 후 역순으로 한 패스에 제거. 같은 행을 반복적으로 splice하는 것을 방지.

---

## 7. 렌더링 핫 경로 전체 흐름

```
이벤트 (스타일 변경 / 박스 이동 / 텍스트 편집)
  │
  ├─ paragraph setter (textStyle/column/gap/...)
  │   ├─ this.layout()          [동기]
  │   ├─ _perfStructureChanged = true
  │   └─ this.scheduleRender()  [queueMicrotask 배치]
  │
  ├─ text edit input
  │   └─ _debouncedRender()     [rAF → scheduleRender → queueMicrotask 배치]
  │
  ├─ text edit (Enter/compositionend — 동기 커서 갱신 필요)
  │   └─ paragraph.flushRender()  [대기 중 배치 취소 + 즉시 render()]
  │
  ├─ box drag/resize
  │   └─ _scheduleDragRerender() [requestAnimationFrame 배치]
  │
  ├─ box setter (비드래그)
  │   └─ scheduleRerenderAffectedParagraphs() [queueMicrotask 배치]
  │
  ── 마이크로태스크 / rAF ──
  │
  └─ paragraph.render()
      ├─ _perfShouldFullRecreate() → 전체 재생성 or 증분?
      │
      ├─ model.layoutText()
      │   └─ _layoutTextIntoColumns()
      │       └─ _charWidthMm() per char
      │           ├─ _charWidthCache 히트? → 즉시 반환
      │           └─ 미스 → opentype.js → 캐시 저장
      │
      └─ column.renderText()
          ├─ colStyle 변경? → _cachedColStyleKey 비교
          │   ├─ 변경 → 스타일 시트 재구축
          │   └─ 미변경 → 스킵
          │
          └─ span diff 루프 (data-source-offset key)
              ├─ 임시 span 제거
              ├─ 라인/파트 div 재사용 (인덱스 기반)
              ├─ 재사용 span + 동일 내용?
              │   ├─ _skipSpanStyleIfUnchanged → true → 스킵
              │   └─ false → _applySpanStyle
              │       ├─ genCharStyle → _charOuterStyleCache (LRU, 키: char|wr|ls|sr)
              │       └─ genCharInnerStyle → 단일 키 메모이제이션
              └─ 신규 span → _createSpanElement
```

---

## 8. 캐시 용량 튜닝 가이드

| 캐시 | 용량 | 근거 |
|---|---|---|
| `_charWidthCache` | 5000 | 한국어 11,172 음절 + ASCII + 기호. 폰트×크기 조합 2~3개 고려 시 충분. |
| `_charOuterStyleCache` | 5000 | `${char}\|${widthRatio}\|${letterSpacing}\|${spaceRatio}` 키. 장평/자간/공백비율 조합 × 고유 문자. |
| `_charInnerStyle` | 1 | 모든 글자 동일 내부 스타일. |
| `_parsedFonts` | 무제한 (`Map`) | 등록된 폰트 패밀리 수는 제한적. |
| `_overlayRectsMm` | 무제한 (`Map`) | 렌더링 사이클당 오버랩 요소 수는 제한적. 매 사이클 재구축. |

### 용량 증설이 필요한 시나리오

- **다국어 문서** (한/영/중/일 혼용): `_charWidthCache` 10000 권장
- **다중 폰트 문서** (3+ 패밀리 동시 사용): `_charWidthCache` 10000 권장
- **다중 장평 문서** (5+ widthRatio): `_charOuterStyleCache` 10000 권장

---

## 9. 최적화되지 않은 영역

| 영역 | 메서드 | 문제 |
|---|---|---|
| `_getAllColumns()` | `EditCoordinateMapper` | 호출마다 `querySelectorAll('x-layout-column')` 수행 |
| `getCharRect()` | `EditCoordinateMapper` | 호출마다 `span.getBoundingClientRect()` 수행 |
| `getCharOffsetFromPoint()` | `EditCoordinateMapper` | binary search 내에서 span마다 `getBoundingClientRect()` 수행 |
| `getTextRange()` | `EditCoordinateMapper` | 선택 영역 계산 시 span마다 `getBoundingClientRect()` 수행 |
| `findVisualLineBounds()` | `EditCoordinateMapper` | Home/End 키 처리 시 span마다 `getBoundingClientRect()` 수행 |
| 라인 rect 측정 | `_detectOverlapWithCache()` | `_overlayRectsMm`는 오버랩 요소만 캐싱, 라인 자체의 rect는 라인마다 측정 |
| `getImageData` 캐싱 | `computeOverlapSizeMm()` | 동일 이미지에 대해 라인마다 `getImageData()` 재호출 |
| `overlayElements` 게터 | `LayoutBoxElement` | 호출마다 오버랩 요소 목록 재계산. `overlapMode === 'none'` 이미지/paragraph는 `checkOverlap()` 이전에 제외. `checkOverlap()`은 mm 좌표(`absLeft`/`absTop`/`absWidth`/`absHeight`) 기반으로 동작하므로 `getBoundingClientRect()` 강제 리플로우 비용이 발생하지 않음 |

---

## 10. 향후 최적화 후보

| 후보 | 설명 | 예상 효과 | 노력 |
|---|---|---|---|
| Web Worker 레이아웃 | `_layoutTextIntoColumns()`를 Web Worker로 이관 | 메인 스레드 블로킹 제거 | 중간-높음 |
| 한국어 정적 폭 테이블 | 11,172 한글 음절 균일 폭(970/1000 em) 룩업 테이블 | 콜드 스타트 시 opentype.js 파싱 생략 | 중간 |
| ~~Skeleton 캐시~~ | ~~Univer 패턴 — 레이아웃 결과 캐시~~ | ~~증분 리플로우~~ | ~~구현됨 (§3.12)~~ |
| `Promise.all` 병렬 렌더 | `LayoutDocumentElement.render()` 순차 await → 병렬 | 이미지 로드 블로킹 해소 | 낮음 |
| 가상화 | 뷰포트 밖 컬럼/라인 DOM 지연 생성 | 다중 페이지 DOM 크기 감소 | 중간 |
| `_getAllColumns()` 캐싱 | `EditCoordinateMapper`에서 컬럼 목록 캐싱 | `querySelectorAll` 호출 감소 | 낮음 |
| `getImageData` 캐싱 | 동일 이미지의 `getImageData()` 결과 캐싱 | 라인당 픽셀 읽기 비용 감소 | 낮음 |