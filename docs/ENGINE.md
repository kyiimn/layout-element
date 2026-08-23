# Engine Layer — Node.js 호환 순수 계산 엔진

> 본 문서는 `src/engine/` 계층의 아키텍처, API 레퍼런스, Node.js 사용 예시를 기술한다.

---

## 1. 개요

`layout-element` 라이브러리의 수치 계산을 DOM/Canvas/FontFace 의존성 없이 수행하는 순수 엔진 계층. 브라우저와 Node.js 양쪽에서 동일한 결과를 보장하며, PDF 생성 등 서버 사이드 렌더링을 지원한다.

### 설계 원칙

- **Model-View 분리**: 엔진은 순수 계산, Custom Element는 디스플레이/캐싱/편집
- **ppm 외부 주입 (옵셔널)**: `DocumentEngine` 생성 시 ppm을 파라미터로 전달. 브라우저는 100mm div 측정, Node는 PDF 엔진 설정값. **엔진 연산은 mm 단위로만 동작하므로 ppm이 없어도 정상 작동** — ppm은 브라우저 요소가 화면 렌더링을 위해 참조하는 용도.
- **RGBA 데이터 주입**: `ImageEngine`은 canvas `getImageData()` 또는 `pngjs.decode()` 결과를 `Uint8Array`로 받음
- **엔진 캐싱 / 엘리먼트 DOM 캐싱**: 엔진은 연산 결과(글리프 폭, 레이아웃 결과, 오버랩 결과) 캐싱, 엘리먼트는 DOM 노드(span, div) 캐싱
- **자체 트리 관리**: 엔진 간 직접 참조로 부모-자식 트리 구성. `DocumentEngine.layout()` 하나로 전체 엔진 트리 자동 구축
- **엔진 우선 원칙**: 엔진 트리가 모든 레이아웃 계산의 유일한 진실 공급원이며, DOM 요소는 엔진 결과를 소비하기만 한다

---

## 2. 엔진 클래스 API 레퍼런스

### 2.1 `DocumentEngine`

문서 루트 엔진. ppm, 폰트, 색상 리소스를 주입받아 하위 엔진으로 전파.

#### 팩토리

```ts
static create(
  data: DocumentData,
  fontLoader: FontLoaderEngine,
  colorRegistry: ColorRegistryEngine,
  ppm?: number,
): DocumentEngine
```

> **ppm은 옵셔널**. Node.js에서 DOM 없이 연산할 때 생략 가능. 엔진의 모든 연산(그리드 계산, 텍스트 래핑, 오버랩, 좌표, printPostData)은 mm 단위로만 동작.

#### 퍼블릭 게터

| 게터 | 타입 | 설명 |
|------|------|------|
| `data` | `DocumentData` | 문서 데이터 |
| `extractData` | `DocumentData` | 엔진 현재 상태에서 조립한 문서 데이터. `children`은 자식 박스 엔진의 `extractData`에서 동적 조립. padding은 getter 기본값 적용 |
| `ppm` | `number` | pixels-per-mm (0 if not injected) |
| `width` | `number` | 문서 너비 (mm) |
| `height` | `number` | 문서 높이 (mm) |
| `paddingTop/Right/Bottom/Left` | `number` | 패딩 (mm) |
| `gridCalculator` | `GridCalculatorEngine` | 문서 레벨 그리드 계산기 |
| `childBoxEngines` | `BoxEngine[]` | 최상위 박스 엔진 배열 |
| `absRect` | `AbsRect` | `{ absLeft: 0, absTop: 0, absWidth: width, absHeight: height }` |
| `isDocument` | `true` | 루트 식별 |
| `overlayElements` | `[]` | 루트는 오버레이 없음 |
| `resources` | `{ ppm, fontLoader, colorRegistry }` | 하위 엔진에 전파되는 리소스 번들 |
| `printPostData` | `PrintPostData[]` | z-index 정렬된 자식 printPostData (mm 단위). 후처리 시스템용 데이터 export |

#### 퍼블릭 세터

| 세터 | 타입 | 설명 |
|------|------|------|
| `data` | `DocumentData` | 데이터 갱신 시 트리 재구축 필요 |
| `ppm` | `number` | ppm 업데이트 (줌 레벨 변경) |
| `childBoxEngines` | `BoxEngine[]` | 자식 박스 엔진 교체 |

#### 퍼블릭 메서드

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `layout()` | `(): void` | `DocumentData`로부터 전체 엔진 트리 재구축. Node.js에서 base64 data URI 이미지의 rgbaData를 자동 주입 |
| `prepareImageDecoder()` | `(): Promise<boolean>` | Node.js ESM 환경에서 pngjs 사전 로드. `layout()` 전 호출 필요. 브라우저 no-op |
| `findBoxEngineById(id)` | `(id: string): BoxEngine \| undefined` | 직계 박스 엔진 중 ID 검색 (`BoxEngineParent` 인터페이스 구현) |
| `findEngineById(id)` | `(id: string): BoxEngine \| ParagraphEngine \| ImageEngine \| TableEngine \| undefined` | 엔진 트리 전체 재귀 검색. 모든 엔진 타입 포함. 테이블 셀 내부 박스도 순회 |

#### 내부 메커니즘

- `_buildTree(data)`: 최상위 `BoxEngine` 자식들 생성, 각 박스는 재귀적으로 하위 엔진 구축. 기존 `childBoxEngines`에서 ID로 엔진 재사용.
- `_buildBoxEngine(boxData, parent)`: 박스별 `GridCalculatorEngine` 생성 (`isBox: true`), static 박스는 부모 그리드에서 컬럼/갭 슬라이스. **GC 파라미터 동일 시 인스턴스 재사용** (`_gcParamsEqual`).
- `_buildParagraphEngine(paraData, parentBox)`: `parentBox.overlayElements`로 오버레이 계산. `layoutStructure()`만 호출, **`layoutText()`는 호출하지 않음** — `_refreshParagraphOverlays`에서 단일 실행.
- `_refreshParagraphOverlays(boxEngines)`: 모든 단락의 overlay 문맥을 `updateOverlayContext()`로 갱신 (`_layoutCache` 보존). `TableEngine` 내부 셀 박스도 순회.
- `_buildInheritStyle()`: 문서 텍스트/단락 스타일 + 부모 dimensions/padding 머지
- `printPostData`: 자식 박스를 z-index로 정렬 후 각 박스의 `printPostData` 위임. mm 단위 좌표를 후처리 시스템에 제공

#### 사용 예시

```ts
import { DocumentEngine, FontLoaderEngineImpl, ColorRegistryEngineImpl } from 'layout-element';

// Node.js (ppm 없이)
const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init(fontsArray);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init(cmykColorSet);

const engine = DocumentEngine.create(
  documentData,
  fontLoader,
  colorRegistry,
  // ppm 생략 가능
);
engine.layout();
console.log(engine.gridCalculator.columnCoords);  // mm 단위
console.log(engine.printPostData);  // mm 단위. 후처리 시스템용 데이터 export
```

```ts
// 브라우저 (ppm 포함)
const engine = DocumentEngine.create(
  documentData,
  fontLoader,
  colorRegistry,
  3.78,  // ppm
);
```

---

### 2.2 `GridCalculatorEngine`

컬럼 그리드 좌표 계산 엔진.

#### 팩토리

```ts
static create(data: GridCalculatorEngineOptions, ppm?: number): GridCalculatorEngine
```

#### 퍼블릭 게터

| 게터 | 타입 | 설명 |
|------|------|------|
| `ppm` | `number` | pixels-per-mm |
| `textStyle` | `TextStyle` | 텍스트 스타일 |
| `paragraphStyle` | `ParagraphStyle` | 단락 스타일 |
| `columnCount` | `number` | 컬럼 수 |
| `columnCoords` | `GridRect[]` | 컬럼 좌표 배열 (`{ x1, y1, x2, y2 }`) |
| `columnWidth` | `number[]` | 컬럼 너비 배열 |
| `gaps` | `number[]` | 컬럼 간격 배열 |
| `lineHeight` | `number` | 라인 높이 (fontSize * lineGap) |
| `editableWidth` | `number` | 편집 가능 너비 (mm) |
| `editableHeight` | `number` | 편집 가능 높이 (mm, lineHeight의 정수 배로 내림) |
| `editableTextHeight` | `number` | 텍스트 배치 가능 높이 (mm). padding 제외 전체 높이로, 마지막 라인 fontSize 높이 규칙 반영 |
| `contentHeight` | `number` | 콘텐츠 높이 |
| `fontSize` | `number` | 폰트 크기 |
| `lineGap` | `number` | 라인 갭 |

#### 퍼블릭 세터

| 세터 | 타입 | 설명 |
|------|------|------|
| `data` | `GridCalculatorEngineOptions` | 데이터 갱신 시 컬럼 좌표 재계산 |
| `ppm` | `number` | ppm 업데이트 |

#### 내부 메커니즘

- `_calcColumnGridCoords()`: `columns`/`gap`/`padding`에서 `GridRect[]` 계산
- `columns: number` = 동일 너비 컬럼, `columns: number[]` = 명시적 컬럼 너비
- `isBox === true`일 때 첫/마지막 명시적 컬럼 너비에서 좌/우 패딩만큼 감소
- `editableHeight`는 `lineHeight`의 정수 배로 내림
- `editableTextHeight`는 padding 제외 전체 높이(`height - paddingTop - paddingBottom`)로, 마지막 라인이 `lineHeight`가 아닌 `fontSize`만큼만 차지하는 규칙(`BoxEngine.absHeight = lineHeight * height - (lineHeight - fontSize)`)을 정확히 반영하여 N 라인 Box가 N 라인을 모두 수용하도록 보장

---

### 2.3 `BoxEngine`

박스 절대 좌표/오버랩 요소 계산. 부모 엔진과 직접 참조로 실시간 좌표 반영.

#### 타입

```ts
type BoxEngineParent = DocumentEngine | BoxEngine | TableCellEngine
```

#### 팩토리

```ts
static create(data: BoxData, parent: BoxEngineParent): BoxEngine
```

#### 퍼블릭 게터

| 게터 | 타입 | 설명 |
|------|------|------|
| `data` | `BoxData` | 박스 데이터 |
| `extractData` | `BoxData` | 엔진 현재 상태에서 조립한 박스 데이터. 모든 필드에 getter 기본값 적용 (`position ?? 'static'`, `zIndex ?? 0`, `borderTopWidth ?? 0`, `borderStyle ?? DEFAULT_BORDER_STYLE`, `priority ?? 0`, `backgroundOpacity ?? 1`, `lock ?? false`). `children`은 자식 엔진의 `extractData`에서 동적 조립 |
| `parent` | `BoxEngineParent` | 부모 엔진 참조 |
| `position` | `BoxPosition` | `'static'` 또는 `'absolute'` |
| `left` | `number` | static=컬럼 인덱스, absolute=mm |
| `top` | `number` | static=라인 카운트, absolute=mm |
| `width` | `number` | static=컬럼 스팬, absolute=mm |
| `height` | `number` | static=라인 카운트, absolute=mm |
| `zIndex` | `number` | role override: `'ad'`→91000, `'header'`→91001 |
| `role` | `BoxRole` | 박스 역할 |
| `paddingTop/Right/Bottom/Left` | `number` | 패딩 (mm) |
| `relLeft` | `number` | 부모 기준 상대 좌측 (mm) |
| `relTop` | `number` | 부모 기준 상대 상단 (mm) |
| `absLeft` | `number` | 절대 좌측 (mm) |
| `absTop` | `number` | 절대 상단 (mm) |
| `absWidth` | `number` | 절대 너비 (mm) |
| `absHeight` | `number` | 절대 높이 (mm) |
| `absRect` | `AbsRect` | `{ absLeft, absTop, absWidth, absHeight }` |
| `contentType` | `BoxContentType` | `'image'` / `'paragraph'` / `'table'` / `null` |
| `contentElement` | `ImageEngine \| ParagraphEngine \| TableEngine \| null` | 최深 콘텐츠 엔진 |
| `overlayElements` | `BoxEngine[]` | 오버레이 박스 엔진 배열 |
| `childEngines` | `(BoxEngine \| ImageEngine \| ParagraphEngine \| TableEngine)[]` | 자식 엔진 배열 |
| `childBoxEngines` | `BoxEngine[]` | 자식 박스 엔진만 필터링 |
| `gridCalculator` | `GridCalculatorEngine \| null` | 박스 레벨 그리드 계산기 |
| `isDocument` | `false` | 박스 식별 |
| `printPostData` | `PrintPostData[]` | z-index 정렬된 자식 printPostData (mm 단위). 후처리 시스템용 데이터 export |
| `absRect` | `AbsRect` | 박스 절대 사각형 (mm). padding 포함 |
| `contentAbsRect` | `AbsRect` | 콘텐츠 영역 절대 사각형 (mm). padding 제외. ImageEngine absRect 전달용 |

#### 퍼블릭 세터

| 세터 | 타입 | 설명 |
|------|------|------|
| `data` | `BoxData` | 데이터 갱신 |
| `parent` | `BoxEngineParent` | 부모 엔진 교체 (reparent/flip 시) |
| `childEngines` | `(BoxEngine \| ImageEngine \| ParagraphEngine \| TableEngine)[]` | 자식 엔진 교체 |
| `gridCalculator` | `GridCalculatorEngine \| null` | 그리드 계산기 교체 |

#### 내부 메커니즘

- 부모 엔진을 참조로 저장 → 좌표 게터가 live 부모 상태를 읽음
- static: `left` = 컬럼 인덱스, `width` = 컬럼 스팬, `height` = 라인 카운트
- absolute: `left`/`top`/`width`/`height` = mm
- `overlayElements`: 부모 오버레이 + 형제 박스(z-index 더 높고 공간 겹침, `overlapMode !== 'none'`) 머지
- `contentType`/`contentElement`: 단일 중첩 박스를 재귀 통과
- `absRect`: 박스 절대 사각형 (mm). padding 포함.
- `contentAbsRect`: 콘텐츠 영역 절대 사각형 (mm). padding 제외. `LayoutImageElement.absLeft/absTop/absWidth/absHeight`와 동일 공식. ImageEngine `buildPrintPostData`에 전달.
- `printPostData`: 자식을 z-index 정렬, 각 엔진 printPostData 위임, `extractData` 사용. mm 단위 좌표를 후처리 시스템에 제공. ImageEngine 자식에는 `this.contentAbsRect`를 전달 (이미지 영역, 부모 box 전체 영역 아님).
- `findBoxEngineById(id)`: 직계 자식 박스 엔진 중 ID 검색 (`BoxEngineParent` 인터페이스 구현).
- `findEngineById(id)`: 자신 + 자식 엔진 + 중첩 박스 + 테이블 셀 내부 박스까지 재귀 검색. 모든 엔진 타입(BoxEngine, ParagraphEngine, ImageEngine, TableEngine) 포함.

---

### 2.4 `ImageEngine`

이미지 오버랩 판정. RGBA 데이터 주입 방식:

- **브라우저**: `LayoutImageElement._feedRgbaToEngine()`가 원본 이미지 픽셀을 임시 canvas에서 추출하여 `ImageEngine.rgbaData`에 주입
- **Node.js**: `DocumentEngine._buildImageEngine()`에서 base64 data URI 자동 디코딩 (pngjs 사용)

#### 엔진 우선 object-fit

엔진이 object-fit 계산을 수행한다. `ImageEngine.contentAbsRect` (부모 box의 콘텐츠 영역)와
`objectFit`/`originalWidth`/`originalHeight`로 `displayRect` (이미지 실제 표시 영역)를 계산한다.
브라우저는 엔진의 `displayRect` 결과를 사용하여 canvas에 표시한다.

`computeOverlap()`은 `displayRect`를 기준으로 오버랩을 판정한다.
`overlapMode: 'path'`일 때 원본 RGBA를 `displayRect`에 매핑하여 픽셀 단위 판정을 수행한다.

#### Node.js 자동 rgbaData 주입

Node.js 환경에서 `ImageData.url`이 base64 data URI(`data:image/png;base64,...`)인 경우,
`DocumentEngine.layout()` 호출 시 `ImageEngine.rgbaData`가 자동 주입된다.
이를 통해 `overlapMode: 'path'`가 정상 동작한다 (rgbaData 없으면 box 모드로 폴백).

**ESM / tsx ESM 환경**: `await engine.prepareImageDecoder()`를 `layout()` 호출 전에 실행해야 한다.
`import("pngjs")`는 비동기이므로, 동기 `layout()` 안에서 pngjs를 사용하려면 사전 로드가 필요하다.

**CommonJS 환경**: `globalThis.require('pngjs')`로 동기 로드되므로 `prepareImageDecoder()` 호출 불필요.

#### 타입

```ts
interface RgbaData { data: Uint8Array; width: number; height: number }
```

#### 팩토리

```ts
static create(data: ImageEngineData): ImageEngine
```

#### 퍼블릭 게터

| 게터 | 타입 | 설명 |
|------|------|------|
| `data` | `ImageEngineData` | 이미지 데이터 |
| `extractData` | `ImageData` | 엔진 현재 상태에서 조립한 이미지 데이터. 모든 필드에 기본값 적용 (`dpi ?? DEFAULT_IMAGE_DPI`, `overlapMode ?? 'path'`, `objectFit ?? 'cover'`, `x/y/width/height ?? 0`, `zIndex ?? 0`). `id`/`zIndex`는 엔진 필드에서 가져옴 |
| `id` | `string \| undefined` | 이미지 고유 식별자 (엔진 필드에서 관리, `ImageEngineData`에 포함되지 않음) |
| `zIndex` | `number \| undefined` | 렌더링 순서 (엔진 필드에서 관리) |
| `rgbaData` | `RgbaData \| null` | RGBA 픽셀 데이터 (원본 이미지) |
| `contentAbsRect` | `AbsRect \| null` | 부모 box 콘텐츠 영역 (object-fit 계산용) |
| `displayRect` | `AbsRect` | object-fit으로 계산한 이미지 실제 표시 영역 (절대 좌표, mm) |
| `overlapMode` | `OverlapMode` | `'path'` / `'box'` / `'none'` (effective getter, 기본값 `'path'`) |
| `overlapPadding` | `number \| { top?, right?, bottom?, left? } \| undefined` | 오버랩 패딩 (mm) |
| `dpi` | `number` | DPI (기본 72) |
| `effectiveOverlapMode` | `OverlapMode` | 내부 소비용: `overlapMode ?? 'path'` |
| `effectiveObjectFit` | `ImageObjectFit` | 내부 소비용: `objectFit ?? 'cover'` |
| `effectiveX/Y/Width/Height` | `number` | 내부 소비용: `x/y/width/height ?? 0` |
| `effectiveOriginalWidth/Height` | `number` | 내부 소비용: `originalWidth/Height ?? 0` |

#### 퍼블릭 세터

| 세터 | 타입 | 설명 |
|------|------|------|
| `data` | `ImageEngineData` | 데이터 갱신 |
| `rgbaData` | `RgbaData \| null` | RGBA 데이터 주입 (원본 이미지 픽셀) |
| `contentAbsRect` | `AbsRect \| null` | 부모 box 콘텐츠 영역 주입 (object-fit 계산용) |

#### 퍼블릭 메서드

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `computeOverlap` | `(lineRectMm: MmRect): OverlapResult` | 라인과 이미지 `displayRect`의 오버랩 판정 |
| `layout` | `(): { cropRectMm: AbsRect; displayRectMm: AbsRect }` | 크롭/디스플레이 영역 계산 |
| `buildPrintPostData` | `(absRect: AbsRect): PrintPostData[]` | 후처리 시스템용 printPostData 생성 (mm 단위). `extractData`를 사용하여 ImageData 조립 |

#### 내부 메커니즘

- `displayRect`: `contentAbsRect` + `objectFit` + `originalWidth/Height`로 `computeObjectFit()` 계산
- `computeOverlap()`: `displayRect`를 `absRect`로 사용하여 `computeOverlapSizeMm()`에 위임
- `'path'` 모드 + RGBA 데이터: `displayRect`에 매핑된 픽셀 단위 투명도 판정
- `'box'` 모드: `displayRect` 기반 기하학적 판정
- `overlapPadding` 설정 시 ellipse 기반 판정 (`ndx² + ndy² ≤ 1`)
- `DEFAULT_IMAGE_DPI = 72`
- **`ImageEngineData`에서 `id`/`zIndex` 제거**: `id`/`zIndex`는 `ImageEngine._id`/`_zIndex` 필드에서 관리. `ImageEngineData`는 순수 계산용 타입이므로 메타데이터 제외. 엔진 생성 후 `id`/`zIndex` setter로 설정.

---

### 2.5 `ParagraphEngine`

텍스트 래핑 엔진 + 엔진 쿼리 API.

#### 타입

```ts
interface ParagraphEngineData {
  id?: string
  zIndex?: number
  content: string | (string | TextBlockData)[]
  column: number | number[]
  gap: number | number[]
  paragraphStyle: ParagraphStyle  // 주입값만 (부모 스타일과 병합하지 않음)
  textStyle: TextStyle            // 주입값만 (부모 스타일과 병합하지 않음)
  inheritStyle: InheritStyle      // 부모에서 상속된 스타일 + 부모 치수
  overlayEngines: BoxEngine[]
  parentAbsRect: AbsRect
  resources: EngineResources
  parentBox?: BoxEngine           // 부모 박스 엔진. 테이블 셀 내부 column/gap 보정용
}
```

#### 팩토리

```ts
static create(data: ParagraphEngineData): ParagraphEngine
```

#### 퍼블릭 메서드

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `layoutStructure` | `(): void` | 단락 구조 레이아웃 |
| `layoutText` | `(): void` | 텍스트 컬럼 래핑 실행 |
| `resetIncrementalState` | `(): void` | 스켈레톤 캐시 초기화 |
| `updateOverlayContext` | `(overlayEngines, parentAbsRect, inheritStyle): void` | 오버랩 문맥 경량 갱신 (`_layoutCache` 보존) |
| `genColumnStyle` | `(idx: number): Partial<CSSStyleDeclaration>` | 컬럼 CSS 스타일 생성 |
| `genLineStyle` | `(textBlockStyle?): Partial<CSSStyleDeclaration>` | 라인 CSS 스타일 |
| `genPartStyle` | `(textBlockStyle?): Partial<CSSStyleDeclaration>` | 파트 CSS 스타일 |
| `genCharStyle` | `(char, textBlockStyle?): Partial<CSSStyleDeclaration>` | 문자 외부 CSS 스타일 |
| `genCharInnerStyle` | `(): Partial<CSSStyleDeclaration>` | 문자 내부 CSS 스타일 |
| `genCharStyleFlat` | `(char, textBlockStyle?): Partial<CSSStyleDeclaration>` | 평탄화 문자 스타일 |
| `getCharWidths` | `(char, textBlockStyle?): { rawWidth, swidth, widthRatio }` | 문자 폭 정보 |
| `getCharRect` | `(sourceOffset: number): MmRect \| null` | 특정 오프셋 문자의 mm 단위 rect |
| `getOffsetFromPoint` | `(xMm, yMm): CursorPosition \| null` | 좌표→오프셋 매핑 |
| `getCursorPlacement` | `(sourceOffset, preferLineEnd?): CursorPlacement \| null` | 커서 배치 정보 |

#### 퍼블릭 게터

| 게터 | 타입 | 설명 |
|------|------|------|
| `data` | `ParagraphEngineData` | 엔진 데이터 |
| `extractData` | `ParagraphData` | 엔진 현재 상태에서 조립한 단락 데이터. `paragraphStyle`/`textStyle`은 `effectiveParagraphStyle`/`effectiveTextStyle`이 아닌 주입값 `_paragraphStyle`/`_textStyle`만 순회하여 조립 (상속값/기본값 제외, 빈 객체면 `undefined`). `column`/`gap`은 보정된 `_columnWidths`/`_gaps`를 반환 (테이블 셀 내부에서는 부모 `gridCalculator` 기준, 그 외는 주입값). `overlapMode ?? 'box'`, `zIndex ?? 0`. 캐시 없음 — 매 호출마다 새 `ParagraphData` 객체 생성 |
| `id` | `string \| undefined` | 단락 고유 식별자 (엔진 필드에서 관리) |
| `zIndex` | `number \| undefined` | 렌더링 순서 (엔진 필드에서 관리) |
| `inheritStyle` | `InheritStyle` | 상속 스타일 |
| `textContent` | `string` | 현재 텍스트 (편집 반영) |
| `contents` | `TextBlockData[]` | 텍스트 블록 배열 |
| `textStyle` | `TextStyle` | 텍스트 스타일 (effective getter 반환: 주입값 → 상속값 → 기본값 병합) |
| `paragraphStyle` | `ParagraphStyle` | 단락 스타일 (effective getter 반환: 주입값 → 상속값 → 기본값 병합) |
| `effectiveParagraphStyle` | `ParagraphStyle` | 내부 소비용: `{ ...DEFAULT, ..._inheritStyle, ..._paragraphStyle }` |
| `effectiveTextStyle` | `TextStyle` | 내부 소비용: `{ ...DEFAULT, ..._inheritStyle, ..._textStyle }` |
| `columnCount` | `number` | 컬럼 수 |
| `columnContents` | `TextLineData[][]` | 컬럼별 라인 데이터 |
| `gaps` | `number[]` | 갭 배열 |
| `lineHeight` | `number` | 라인 높이 |
| `overflow` | `number` | 오버플로우 라인 수 |
| `widthRatio` | `number` | 장평 비율 (effective getter) |
| `spaceRatio` | `number` | 스페이스 비율 (effective getter) |
| `indent` | `number` | 들여쓰기 (effective getter) |
| `fontSize` | `number` | 폰트 크기 (effective getter) |
| `columnWidths` | `number[]` | 컬럼 너비 배열 |
| `previousLineCount` | `number` | 이전 렌더 라인 수 |
| `previousOverflow` | `number` | 이전 오버플로우 |
| `scale` | `number` | 스케일 (현재 no-op) |
| `overlapMode` | `ParagraphOverlapMode` | 단락 오버랩 모드 |
| `printPostData` | `PrintPostData[]` | 문자별 printPostData (mm 단위). 후처리 시스템용 데이터 export. `verticalAlign`(top/center/bottom) 오프셋을 char rect.y에 반영. `letterSpacing`/`spaceRatio` 필드 포함. 내부 소비는 `effectiveParagraphStyle`/`effectiveTextStyle` getter 사용 |

#### 퍼블릭 세터

| 세터 | 타입 | 설명 |
|------|------|------|
| `data` | `ParagraphEngineData` | 데이터 갱신 (캐시 초기화) |
| `inheritStyle` | `InheritStyle` | 상속 스타일 |
| `textContent` | `string` | 텍스트 갱신 (편집) |
| `overlapMode` | `ParagraphOverlapMode` | 오버랩 모드 |
| `scale` | `number` | 스케일 (no-op) |

#### 내부 메커니즘

- `_layoutTextIntoColumns()`: 문자 단위 래핑
- **`data` setter column/gap 보정**: `parentBox`가 제공되고 `parentBox.parent`가 `TableCellEngine`(`isTableCellEngine === true`)인 경우, `parentBox.gridCalculator`의 `columnWidth`/`gaps`를 사용하여 column/gap을 보정한다. 테이블 셀 내부 paragraph는 명시적 `column`/`gap` 값과 무관하게 셀 크기에 맞춰진다. 보정된 값은 `_columnWidths`/`_gaps`에 저장되며 `extractData`에서 반환된다.
- 스켈레톤 캐시: `_computeLayoutInputHash()`로 입력 해시 → 동일하면 재레이아웃 스킵
- LRU 캐시 (capacity 5000):
  - 문자 폭: key `${char}|${fontName}|${fontSize}`
  - 문자 외부 스타일: key `${char}|${widthRatio}|${letterSpacing}|${spaceRatio}|${fontSize}`
- 한글 금칙문자 규칙: `_applyLineBreakRules()` (`LINE_START_FORBIDDEN` / `LINE_END_FORBIDDEN`)
- `_detectOverlapWithCache()`: 렌더 사이클별 오버레이 rect 캐싱
- `_createLineWithParts()`: 오버랩 파트에서 자유 영역 계산, `minCharWidthMm = widthRatio * fontSize + letterSpacing`
- 커서/오프셋 쿼리: `getCharRect`, `getOffsetFromPoint`, `getCursorPlacement`
- `buildParagraphPrintPostData()`: 문자별 print data 생성. mm 단위 좌표를 후처리 시스템에 제공
- `data` setter 호출 시 `resetIncrementalState()` 자동 실행

---

### 2.6 `TableEngine`

테이블 그리드 해석. `resolveTableGrid()` 래핑.

#### 팩토리

```ts
static create(data: TableData, parentBox: BoxEngine): TableEngine
```

#### 퍼블릭 게터

| 게터 | 타입 | 설명 |
|------|------|------|
| `data` | `TableData` | 테이블 데이터 |
| `extractData` | `TableData` | 엔진 현재 상태에서 조립한 테이블 데이터. `children`은 `rowEngines` → `cellEngines` → `boxEngine.extractData`에서 동적 조립 |
| `gridResolution` | `GridResolution \| null` | 그리드 배치 결과 |
| `rowEngines` | `TableRowEngine[]` | 행 엔진 배열 |
| `cellEngines` | `TableCellEngine[]` | 셀 엔진 배열 |
| `parentBox` | `BoxEngine` | 부모 박스 엔진 |

#### 퍼블릭 세터

| 세터 | 타입 | 설명 |
|------|------|------|
| `data` | `TableData` | 데이터 갱신 |

#### 퍼블릭 메서드

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `layout` | `(): void` | 부모 박스 콘텐츠 너비/높이로 그리드 계산 |

#### `TableCellEngine`

`BoxEngineParent` 인터페이스 구현 — 중첩 박스가 셀을 부모로 인식.

`readonly isTableCellEngine = true` 식별자를 가진다. `ParagraphEngine.data` setter가 `parentBox.parent`가 `TableCellEngine`인지 확인할 때 `instanceof` 대신 이 식별자를 사용한다 (순환 import 회피).

| 멤버 | 타입 | 설명 |
|------|------|------|
| `absRect` | `AbsRect` | 셀 절대 rect. `TableEngine.layout()`에서 `parentAbsRect`를 설정하면 페이지 기준 절대 좌표, 미설정 시 테이블 상대 좌표 |
| `isDocument` | `false` | 셀 식별 |
| `gridCalculator` | `GridCalculatorEngine \| null` | 셀 단일 컬럼 그리드 계산기 |
| `overlayElements` | `[]` | 셀은 오버레이 없음 |
| `childBoxEngines` | `BoxEngine[]` | 셀 내부 박스 엔진 |
| `boxEngine` | `BoxEngine \| null` | 셀 내부 박스 엔진 getter/setter |
| `parentAbsRect` | setter | `TableEngine.layout()`에서 상위 박스의 절대 rect를 주입 |
| `setCellMetrics` | `(x, y, width, height, cellLabel, labels): void` | 셀 메트릭 설정 |
| `x`, `y`, `width`, `height` | `number` | 셀 좌표/크기 |
| `cellLabel` | `string` | 셀 라벨 (예: `"A1"`). `TableEngine.layout()`에서 산출 |
| `labels` | `string[]` | 셀이 커버하는 모든 라벨. span 셀의 경우 복수 |
| `extractData` | `TableCellData` | 엔진 현재 상태에서 조립한 셀 데이터. 기본값 적용 (`colspan ?? 1`, `rowspan ?? 1`, `borderWidth ?? 0`, `borderStyle ?? 'solid'`, `padding ?? 0`). `children`은 `boxEngine.extractData`에서 조립 |
| `findBoxEngineById` | `(id): BoxEngine \| undefined` | 셀 내부 박스 엔진 ID 검색 |
| `findEngineById` | `(id): BoxEngine \| ParagraphEngine \| ImageEngine \| TableEngine \| undefined` | 셀 내부 박스에서 재귀 검색 |

셀의 `gridCalculator`는 `columns: 1`인 단일 컬럼 그리드이며, `TableEngine.layout()`에서 셀 메트릭 계산 후 생성된다. 이를 통해 셀 내부 BoxEngine은 `BoxEngineParent.gridCalculator`를 통해 좌표를 계산한다. `parentAbsRect`가 주입되면 `absRect`는 페이지 기준 절대 좌표를 반환하므로, 셀 내부 박스의 `BoxEngine.absRect`도 누적된 페이지 절대 좌표가 된다.

#### `TableRowEngine`

| 멤버 | 타입 | 설명 |
|------|------|------|
| `setRowMetrics` | `(y, height, _contentWidth, rowIndex, rowLabel): void` | 행 메트릭 설정 |
| `y`, `height`, `rowIndex` | `number` | 행 좌표/높이/인덱스 |
| `rowLabel` | `string` | 행 라벨 (예: `"A"`). `TableEngine.layout()`에서 산출 |
| `cellEngines` | `TableCellEngine[]` | 셀 엔진 getter/setter |

`TableEngine.layout()`은 그리드 해석 후 각 행의 `rowLabel`을 산출하고, 각 셀에 `cellLabel`과 병합(span) 시 커버하는 전체 `labels`를 계산한다.

---

### 2.7 `FontLoaderEngineImpl`

Node.js 호환 폰트 로더. `FontFace`/`fetch` 없이 동작.

#### 팩토리

```ts
static create(): FontLoaderEngineImpl
```

#### 퍼블릭 게터

| 게터 | 타입 | 설명 |
|------|------|------|
| `ready` | `boolean` | 초기화 완료 여부 |

#### 퍼블릭 메서드

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `init` | `(fonts: Font[]): Promise<void>` | 폰트 배열로 초기화 |
| `getParsedFont` | `(fontName?: string): ParsedFont \| null` | opentype.js 파싱 폰트 |
| `getFontFamily` | `(fontName?: string): string` | FontFace.family (없으면 첫 폰트) |

#### 내부 메커니즘

- `opentype.js` 동적 `import("opentype.js")` 로드
- `base64Data` 있는 폰트만 파싱, `ttfFilename`-only 폰트 스킵
- `atob()`로 base64 디코딩 → `opentype.parse(bytes.buffer)`
- `getParsedFont()` 첫 폰트 폴백
- `getFontFamily()` ready 아닐 시 throw

---

### 2.8 `ColorRegistryEngineImpl`

Node.js 호환 색상 레지스트리. `fetch` 없이 동작.

#### 팩토리

```ts
static create(): ColorRegistryEngineImpl
```

#### 퍼블릭 게터

| 게터 | 타입 | 설명 |
|------|------|------|
| `ready` | `boolean` | 초기화 완료 여부 |

#### 퍼블릭 메서드

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `init` | `(colorSet: CMYKColorSet): void` | CMYK 색상 세트로 초기화 |
| `getCSSColor` | `(name: string): string` | `#RRGGBB` 헥스 반환 |
| `getOpacityHex` | `(opacity: number): string` | 불투명도 헥스 |
| `get` | `(name: string): CMYKColor` | CMYK 색상 객체 반환 (`{ c, m, y, k }`) |

#### 내부 메커니즘

- `_colorSet` / `_defaultColor` 저장
- `init()` 기본 색상 `{ c:0, m:0, y:0, k:255 }`
- `_cmykToRgb()`: CMYK [0,1] 클램프 후 변환
- `_rgbHex()`: 대문자 `#RRGGBB`
- ready 아닐 시 throw

---

### 2.9 순수 오버랩 함수 (`overlap-engine.ts`)

| 함수 | 시그니처 | 설명 |
|------|----------|------|
| `checkOverlapMm` | `(a: AbsRect, b: AbsRect): boolean` | AABB 교차 판정 |
| `computeOverlapSizeMm` | `(lineRectMm: MmRect, overlay: OverlapInput): OverlapResult` | 오버랩 크기 계산 |
| `mergeOverlapParts` | `(parts: OverlapParts[]): OverlapParts[]` | 인접 오버랩 파트 머지 |

`OverlapInput` = `{ absRect, overlapMode, overlapPadding?, image?, contentType }`

---

### 2.10 공유 타입 (`types.ts`)

| 타입 | 정의 |
|------|------|
| `AbsRect` | `{ absLeft, absTop, absWidth, absHeight }` |
| `MmRect` | `{ left, right, top, bottom, width, height }` |
| `GridRect` | `{ x1, y1, x2, y2 }` |
| `OverlapDirection` | `"NONE" \| "COVERS" \| "PART"` |
| `OverlapResult` | `{ direction, parts: OverlapParts[] }` |
| `OverlapInput` | `{ absRect, overlapMode, overlapPadding?, image?, contentType }` |
| `ImageEngineRef` | `{ rgbaData, overlapMode, overlapPadding? }` |
| `BoxContentType` | `"image" \| "paragraph" \| "table" \| null` |
| `FontLoaderEngine` | 인터페이스 |
| `ParsedFont` | 인터페이스 |
| `ColorRegistryEngine` | 인터페이스 |
| `EngineResources` | `{ ppm, fontLoader, colorRegistry }` |
| `RgbaData` | `{ data: Uint8Array; width: number; height: number }` |
| `CursorPlacement` | `{ sourceOffset: number; atEndOfChar: boolean }` — 커서 배치 정보. 엔진에서 원본 정의, `@/edit` 계층이 소비 |

---

## 3. 엔진 트리 구축

`DocumentEngine.layout()` 하나로 `DocumentData`에서 전체 엔진 트리를 자동 구축한다. DOM 요소 없이 연산 가능.

```
DocumentEngine (root, owns ppm + resources)
  ├─ GridCalculatorEngine (isBox: false)
  └─ BoxEngine[] (top-level boxes)
       ├─ GridCalculatorEngine (isBox: true, columns sliced from parent for static)
       ├─ BoxEngine[] (nested boxes, recursive)
       ├─ ParagraphEngine (for paragraph/text content)
       │    └─ overlayEngines: BoxEngine[] (sibling boxes with higher z-index)
       ├─ ImageEngine (for image content)
       │    └─ rgbaData injected by browser element or pngjs
       └─ TableEngine (for table content)
            └─ TableRowEngine[]
     └─ TableCellEngine[] (implements BoxEngineParent)
                       ├─ GridCalculatorEngine (columns: 1)
                       └─ BoxEngine (cell content, recursive)
```

### 좌표 전파

- 모든 좌표 게터(`absLeft`, `absTop`, `absWidth`, `absHeight`)는 부모 엔진 참조를 통해 live 누적 좌표 계산
- `BoxEngine.parent` setter로 reparent/flip 후 부모 교체 가능
- `DocumentEngine.absRect` = `{ 0, 0, width, height }`

### 리소스 전파

- `EngineResources = { ppm, fontLoader, colorRegistry }`
- `DocumentEngine.resources`로 하위 엔진에 전파
- `ParagraphEngine`은 `ParagraphEngineData.resources`로 수신
- `BoxEngine.printPostData`는 문서 엔진까지 올라가 `_colorRegistry` 접근

### printPostData 단일화 (mm)

- 엔진 트리(`DocumentEngine.printPostData`)가 단일 소스. 모든 rect/char 좌표는 **mm 단위**.
- `LayoutDocumentElement.printPostData`는 `DocumentEngine.printPostData` 엔진 트리 결과를 위임한다. box/paragraph/image/table/td/tr 엘리먼트의 개별 `printPostData` getter는 제거되었다.
- `<x-layout-guide-column>`은 DOM 전용 요소(엔진 트리에 없음)이므로 `LayoutDocumentElement.printPostData`에서 별도 수집한다.
- ppm 곱셈은 외부 후처리 시스템이 수행한다. 엔진은 mm만 다룬다.

---

## 4. 브라우저 어댑터

브라우저 환경에서 `LayoutDocumentElement`는 싱글톤 `FontLoader`/`ColorRegistry`를 엔진 인터페이스에 맞게 변환하는 어댑터를 사용한다. 이 어댑터들은 `document.element.ts` 내부에 private으로 정의되어 외부로 노출되지 않는다.

### `FontLoaderSingletonAdapter implements FontLoaderEngine`

- `constructor(fl: FontLoader)`
- `get ready(): boolean`
- `async init(fonts: Font[]): Promise<void>`
- `getParsedFont(fontName?): ParsedFont | null`
- `getFontFamily(fontName?): string`

### `ColorRegistrySingletonAdapter implements ColorRegistryEngine`

- `constructor(cr: ColorRegistry)`
- `get ready(): boolean`
- `init(colorSet: CMYKColorSet): void`
- `get(name: string): CMYKColor`
- `getCSSColor(name: string): string`
- `getOpacityHex(opacity: number): string`

---

## 5. 엔진과 Custom Element 연동

각 Custom Element는 대응하는 엔진 인스턴스를 소유하고 `engine` 게터로 노출한다.

| Element | Engine | 엔진 생성 시점 |
|---------|--------|---------------|
| `LayoutDocumentElement` | `DocumentEngine` | `_layoutStructure()` |
| `LayoutBoxElement` | `BoxEngine` + `GridCalculatorEngine` | `_layoutStructure()` / `_updateEngine()` |
| `LayoutParagraphElement` | `ParagraphEngine` | `_layoutStructure()` |
| `LayoutImageElement` | `ImageEngine` | `_updateEngine()` |
| `LayoutTableElement` | `TableEngine` | `_updateEngine()` |
| `LayoutTableCellElement` | `TableCellEngine` + `GridCalculatorEngine` | `table.element.ts` 엔진 구축 시 |
| `LayoutColumnElement` | (없음) | 부모 `ParagraphEngine` 위임 |
| `LayoutGuideColumnElement` | (없음) | `GridRect` 타입만 사용 |

### 엔진 접근 패턴

- **Document builds the engine tree**: `LayoutDocumentElement._layoutStructure()`는 `DocumentEngine.layout()`을 호출하여 `DocumentData`로부터 전체 엔진 트리를 구축. 이후 자식 `LayoutBoxElement`는 같은 트리의 `BoxEngine` 인스턴스를 재사용.
- **Box attaches to tree engine**: `LayoutBoxElement._layoutStructure()`는 부모 엔진(`DocumentEngine`/`BoxEngine`/`TableCellEngine.boxEngine`)에서 `findBoxEngineById(this.id)`로 미리 구축된 `BoxEngine`을 찾아 연결. `id`가 없거나 트리에 없는 경우(`appendChildData`로 새로 추가된 경우)에만 새 `BoxEngine`을 생성하고 부모 `childEngines`에 등록.
- **Reuse in place**: 좌표/크기/role/zIndex 등의 setter가 실행되면 `LayoutBoxElement`는 `BoxEngine.data`를 갱신하여 같은 엔진 인스턴스를 재사용. `_updateEngine()`은 새 엔진을 만들지 않고 기존 엔진의 `data`/`parent`만 갱신.
- **Parent 구축**: `box.element.ts._findParentEngine()`이 부모 요소에서 `DocumentEngine`/`BoxEngine`/`TableCellEngine` 추출. 테이블 셀 내부 박스는 `TableCellEngine` 자체를 부모 엔진으로 받으며, `TableCellEngine.findBoxEngineById(id)`가 셀의 `boxEngine` 자체를 반환한다 (BoxEngine.findBoxEngineById는 자식만 검색하므로 셀 내부 박스를 찾지 못함).
- **Overlay wiring**: `paragraph.element.ts`가 `overlayElements` 박스의 `BoxEngine`을 수집해 `ParagraphEngineData.overlayEngines`로 전달
- **RGBA injection**: `image.element.ts._feedRgbaToEngine()`가 원본 이미지 픽셀을 임시 canvas에서 추출하여 `ImageEngine.rgbaData`에 주입. canvas 렌더링 결과가 아닌 원본 픽셀을 주입한다.
- **object-fit**: 엔진의 `ImageEngine.displayRect`가 단일 소스. `image.element.ts._applyObjectFit()`는 엔진의 `displayRect`를 사용하여 `x/y/width/height`를 설정. 브라우저 canvas는 이 값으로 표시만 수행.

### `engine` 게터 (퍼블릭 API)

모든 주요 요소에 `engine` 게터가 추가되었다:

```ts
LayoutDocumentElement.engine: DocumentEngine | undefined
LayoutBoxElement.engine: BoxEngine | undefined
LayoutParagraphElement.engine: ParagraphEngine | undefined
LayoutImageElement.engine: ImageEngine | undefined
LayoutTableElement.engine: TableEngine | undefined
LayoutTableCellElement.engine: TableCellEngine | undefined
```

> **참고**: `model` 게터는 하위 호환용으로 유지되며, `GridCalculatorEngine` (document/box/td) 또는 `ParagraphEngine` (paragraph)을 반환한다.

---

## 6. Node.js 사용 예시

```ts
import { DocumentEngine, FontLoaderEngineImpl, ColorRegistryEngineImpl } from 'layout-element';
import { readFileSync } from 'fs';

// 1. 리소스 초기화
const fontLoader = FontLoaderEngineImpl.create();
const fontBase64 = readFileSync('Myoungjo.ttf').toString('base64');
await fontLoader.init([{ family: 'Myoungjo', weight: 400, style: 'normal', base64Data: fontBase64 }]);

const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({ black: { c: 0, m: 0, y: 0, k: 255 } });

// 2. 문서 엔진 생성 (ppm 생략 가능 — 엔진 연산은 mm 단위)
const engine = DocumentEngine.create(
  { width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' }, children: [...] },
  fontLoader,
  colorRegistry,
  // ppm 생략 — Node.js에서 불필요
);

// 3. 이미지 디코더 사전 로드 (ESM / tsx ESM 환경에서 필수)
//    CommonJS 환경에서는 생략 가능 (globalThis.require로 동기 로드)
await engine.prepareImageDecoder();

// 4. 레이아웃 계산 (전체 엔진 트리 자동 구축 + base64 이미지 rgbaData 자동 주입)
engine.layout();
const grid = engine.gridCalculator;
console.log(grid.columnCoords);  // mm 단위 컬럼 좌표
console.log(grid.lineHeight);    // 4.8

// 5. printPostData (mm 단위). 후처리 시스템용 데이터 export
console.log(engine.printPostData);
```

### base64 이미지 overlapMode: 'path' 자동 처리

`ImageData.url`에 base64 data URI를 전달하면, `layout()` 호출 시
`ImageEngine.rgbaData`가 자동 주입된다. 별도로 `imageEngine.rgbaData = ...`를
호출할 필요가 없다.

```ts
const docData = {
  // ...
  children: [{
    type: 'box',
    // ...
    children: {
      type: 'image',
      url: 'data:image/png;base64,iVBORw0KGgo...',  // base64 data URI
      dpi: 72,
      overlapMode: 'path',  // ← rgbaData 자동 주입으로 path 모드 정상 동작
    }
  }]
};

await engine.prepareImageDecoder();  // ESM 환경 필수
engine.layout();  // ImageEngine.rgbaData 자동 주입됨
```

---

## 7. 검증

```bash
npm run verify:engine   # Node.js 호환성 테스트 (25개 assertion)
npm run build           # IIFE + React ESM + Engine ESM 빌드
```

### 엔진 번들

- `dist/layout-element-engine.mjs` (ESM): 엔진 진입점 `src/engine/index.ts`.
- **`opentype.js`는 external**: 엔진 번들에서 제외되어 사용자가 peer dependency로 설치.
  번들 크기 393KB → 74KB (81% 감소), 브라우저 의존 API 5건 → 0건.
- **`pngjs`, `module`도 external**: Node.js 환경에서만 사용.

### Node.js 요구사항

- **Node.js >= 16**: `font-loader-engine.ts`가 `atob()` 전역을 사용 (Node.js 16+ 전역 제공).
- `package.json`의 `engines.node` 필드에 명시.

### `verify:engine` 테스트 항목 (7개, 25개 assertion)

| # | 테스트 | Assertion 수 |
|---|--------|-------------|
| 1 | `GridCalculatorEngine` | 8 |
| 2 | `ImageEngine` with synthetic RGBA | 2 |
| 3 | `computeOverlapSizeMm` pure function | 2 |
| 4 | `checkOverlapMm` | 2 |
| 5 | `FontLoaderEngineImpl` | 3 |
| 6 | `ColorRegistryEngineImpl` | 4 |
| 7 | No DOM globals leaked | 4 |

---

## 8. 엔진보내기 (`src/index.ts`)

vanilla 진입점에서 명시적 engine보내기:

**값**:
`GridCalculatorEngine`, `ImageEngine`, `checkOverlapMm`, `computeOverlapSizeMm`, `engineMergeOverlapParts` (alias), `BoxEngine`, `TableEngine`, `TableRowEngine`, `TableCellEngine`, `ParagraphEngine`, `DocumentEngine`, `FontLoaderEngineImpl`, `ColorRegistryEngineImpl`, `computeObjectFit`, `prepareImageDecoder`, `decodeBase64ImageToRgba`, `decodeBase64ImageToRgbaSync`, `isNodeJs`, `parseDataUri`

**타입**:
`GridRect`, `AbsRect`, `EngineMmRect` (alias), `OverlapDirection`, `OverlapResult`, `OverlapInput`, `ImageEngineRef`, `BoxContentType`, `FontLoaderEngine`, `ParsedFont`, `ColorRegistryEngine`, `EngineResources`, `GridCalculatorEngineOptions`, `ImageEngineData`, `ImageLayoutResult`, `BoxLayoutResult`, `TableLayoutResult`, `ParagraphLayoutResult`, `DocumentLayoutResult`, `LayoutResult`, `EngineCursorPlacement` (alias), `RgbaData`, `ObjectFitRect`, `ObjectFitInput`

> `MmRect`과 `CursorPlacement`은 `@/core`/`@/utils` 및 `@/edit`에 동일 이름이 있어 alias 처리됨.
>
> **`CursorPlacement` 원본 정의 위치**: `src/engine/types.ts` (엔진 계층).
> `@/edit/text-edit-coordinate-mapper.ts`는 `@/engine/types`에서 `import type`하여 재export.
> 엔진이 `@/edit` 계층에 타입 의존성을 갖지 않도록 분리됨.

---

## 9. 디렉토리 구조

```
src/engine/
  types.ts                    # 공유 타입 (AbsRect, MmRect, OverlapResult, EngineResources, CursorPlacement 등)
  grid-calculator-engine.ts   # 컬럼 그리드 계산 (ppm 옵셔널)
  image-engine.ts             # 이미지 오버랩 (RGBA 데이터 기반, object-fit displayRect 계산)
  image-decoder.ts            # Node.js base64 → RGBA 디코딩 (pngjs, module.createRequire)
  object-fit-engine.ts        # object-fit 순수 계산 (cover/contain/fill/none)
  overlap-engine.ts           # 순수 오버랩 판정 함수
  box-engine.ts               # 박스 좌표/오버랩 요소 계산
  table-engine.ts             # 테이블 그리드 해석 + TableCellEngine (BoxEngineParent 구현)
  paragraph-engine.ts         # 텍스트 래핑 + 엔진 쿼리 API + printPostData (mm)
  document-engine.ts          # 문서 루트 (ppm/리소스 관리, 트리 자동 구축, base64 이미지 자동 디코딩, CryptoUuid 로컬 인터페이스)
  font-loader-engine.ts       # opentype.js 전용 (FontFace 없음, atob 전역 사용 — Node.js 16+ 필요, module.createRequire 지원)
  color-registry-engine.ts    # CMYK→RGB 변환 + get() (fetch 없음)
  index.ts                    # 진입점
```

---

## 10. 상수 (엔진이 사용하는 기본값)

`src/constants/defaults.ts`:

| 상수 | 값 | 설명 |
|------|----|------|
| `DEFAULT_BORDER_STYLE` | `'solid'` | 기본 보더 스타일 |
| `DEFAULT_FONT_SIZE` | `4` | 기본 폰트 크기 (mm) |
| `DEFAULT_LINE_GAP` | `1.25` | 기본 라인 갭 |
| `DEFAULT_PPM` | `96 / 25.4` | 기본 ppm (96 DPI) |
| `DEFAULT_IMAGE_DPI` | `72` | 기본 이미지 DPI |
| `DEFAULT_SPACE_RATIO` | `0.5` | 기본 스페이스 비율 |
| `DEFAULT_LETTER_SPACING` | `-0.1` | 기본 자간 |
| `DEFAULT_WIDTH_RATIO` | `0.8` | 기본 장평 |
| `DEFAULT_INDENT` | `0` | 기본 들여쓰기 |
| `DEFAULT_TEXT_ALIGN` | `'justify'` | 기본 정렬 |
| `DEFAULT_VERTICAL_ALIGN` | `'top'` | 기본 수직 정렬 |
| `Z_INDEX_ROLE_AD` | `91000` | 광고 역할 z-index |
| `Z_INDEX_ROLE_HEADER` | `91001` | 헤더 역할 z-index |

---

## 11. 엔진 우선 원칙 (Engine-First Principle)

`layout-element`의 핵심 아키텍처 규칙이다. 엔진 트리가 모든 레이아웃 계산의 유일한 진실 공급원이며, DOM 요소는 그 결과를 표시하고 WYSIWYG 편집에 사용할 뿐이다.

- 엔진 트리(`DocumentEngine` → `BoxEngine` → `ParagraphEngine` / `ImageEngine` / `TableEngine`)가 모든 레이아웃 계산의 단일 진실 공급원이다.
- DOM 요소는 엔진 결과를 표시와 WYSIWYG 편집을 위해 소비한다.
- DOM 요소는 절대 엔진 트리를 만들거나 수정하지 않는다.
- 편집이 발생하면 편집된 콘텐츠를 `DocumentData` / `BoxData`로 직렬화하고, 엔진이 이를 다시 처리한 뒤 결과를 DOM에 전파한다.
- DOM 요소는 `engine.childEngines`를 DOM 자식으로부터 수동으로 채우는 등 엔진 트리를 우회해서는 안 된다.
- **테이블 셀 내부 column/gap 보정은 엔진이 수행**: `ParagraphEngine.data` setter가 `parentBox.parent`가 `TableCellEngine`인지 확인하고, 맞으면 `parentBox.gridCalculator`의 `columnWidth`/`gaps`로 column/gap을 보정한다. DOM은 보정을 수행하지 않으며, 엔진에 `parentBox`를 전달하기만 한다.
- 구체적인 구현 규칙은 `RULES.md` 섹션 3을 참조한다.
