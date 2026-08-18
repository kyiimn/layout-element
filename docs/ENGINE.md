# Engine Layer — Node.js 호환 순수 계산 엔진

> 본 문서는 `src/engine/` 계층의 아키텍처, API 레퍼런스, 마이그레이션 가이드를 기술한다.

---

## 1. 개요

`layout-element` 라이브러리의 수치 계산을 DOM/Canvas/FontFace 의존성 없이 수행하는 순수 엔진 계층. 브라우저와 Node.js 양쪽에서 동일한 결과를 보장하며, PDF 생성 등 서버 사이드 렌더링을 지원한다.

### 설계 원칙

- **Model-View 분리**: 엔진은 순수 계산, Custom Element는 디스플레이/캐싱/편집
- **ppm 외부 주입 (옵셔널)**: `DocumentEngine` 생성 시 ppm을 파라미터로 전달. 브라우저는 100mm div 측정, Node는 PDF 엔진 설정값. **엔진 연산은 mm 단위로만 동작하므로 ppm이 없어도 정상 작동** — ppm은 브라우저 요소가 화면 렌더링을 위해 참조하는 용도.
- **RGBA 데이터 주입**: `ImageEngine`은 canvas `getImageData()` 또는 `pngjs.decode()` 결과를 `Uint8Array`로 받음
- **엔진 캐싱 / 엘리먼트 DOM 캐싱**: 엔진은 연산 결과(글리프 폭, 레이아웃 결과, 오버랩 결과) 캐싱, 엘리먼트는 DOM 노드(span, div) 캐싱
- **자체 트리 관리**: 엔진 간 직접 참조로 부모-자식 트리 구성. `DocumentEngine.layout()` 하나로 전체 엔진 트리 자동 구축

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
| `printPostData` | `PrintPostData[]` | z-index 정렬된 자식 printPostData (mm 단위) |

#### 퍼블릭 세터

| 세터 | 타입 | 설명 |
|------|------|------|
| `data` | `DocumentData` | 데이터 갱신 시 트리 재구축 필요 |
| `ppm` | `number` | ppm 업데이트 (줌 레벨 변경) |
| `childBoxEngines` | `BoxEngine[]` | 자식 박스 엔진 교체 |

#### 퍼블릭 메서드

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `layout()` | `(): void` | `DocumentData`로부터 전체 엔진 트리 재구축 |

#### 내부 메커니즘

- `_createGridCalculator()`: `GridCalculatorEngine` 생성 (`isBox: false`)
- `_buildTree(data)`: 최상위 `BoxEngine` 자식들 생성, 각 박스는 재귀적으로 하위 엔진 구축
- `_buildBoxEngine(boxData, parent)`: 박스별 `GridCalculatorEngine` 생성 (`isBox: true`), static 박스는 부모 그리드에서 컬럼/갭 슬라이스
- `_buildParagraphEngine(paraData, parentBox)`: `parentBox.overlayElements`로 오버레이 계산
- `_buildInheritStyle()`: 문서 텍스트/단락 스타일 + 부모 dimensions/padding 머지
- `printPostData`: 자식 박스를 z-index로 정렬 후 각 박스의 `printPostData` 위임

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
console.log(engine.printPostData);  // mm 단위
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

컬럼 그리드 좌표 계산. 기존 `GridCalculator`의 순수 버전.

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
| `editableTextHeight` | `number` | 편집 가능 텍스트 높이 (lineHeight - fontSize 추가 후 1e-6 반올림) |
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
- `editableTextHeight`는 `lineHeight - fontSize` 추가 후 부동소수점 오류 방지를 위해 1e-6 반올림

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
| `printPostData` | `PrintPostData[]` | z-index 정렬된 자식 printPostData (mm 단위) |

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
- `printPostData`: 자식을 z-index 정렬, 각 엔진 printPostData 위임, `DEFAULT_BORDER_STYLE` 폴백

---

### 2.4 `ImageEngine`

이미지 오버랩 판정. RGBA 데이터 주입 방식:

- **브라우저**: `canvas.getContext('2d').getImageData()` → `Uint8Array`
- **Node.js**: `pngjs.decode(buffer)` → `Uint8Array`

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
| `rgbaData` | `RgbaData \| null` | RGBA 픽셀 데이터 |
| `overlapMode` | `OverlapMode` | `'path'` / `'box'` / `'none'` |
| `overlapPadding` | `number \| { top?, right?, bottom?, left? } \| undefined` | 오버랩 패딩 (mm) |
| `dpi` | `number` | DPI (기본 72) |

#### 퍼블릭 세터

| 세터 | 타입 | 설명 |
|------|------|------|
| `data` | `ImageEngineData` | 데이터 갱신 |
| `rgbaData` | `RgbaData \| null` | RGBA 데이터 주입 |

#### 퍼블릭 메서드

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `computeOverlap` | `(lineRectMm: MmRect, imgRectMm: AbsRect): OverlapResult` | 라인과 이미지의 오버랩 판정 |
| `layout` | `(): { cropRectMm: AbsRect; displayRectMm: AbsRect }` | 크롭/디스플레이 영역 계산 |
| `buildPrintPostData` | `(absRect: AbsRect, imageData: ImageData): PrintPostData[]` | printPostData 생성 (mm 단위) |

#### 내부 메커니즘

- `'path'` 모드: 픽셀 단위 투명도 판정
- `'box'` 모드: 박스 rect 기반 기하학적 판정
- `overlapPadding` 설정 시 ellipse 기반 판정 (`ndx² + ndy² ≤ 1`)
- `_findOpaqueColumnsEllipse()`: 패딩 정규화 거리로 타원형 패딩 영역
- `_findOpaqueColumnsSimple()`: 패딩 없는 투명도 스캔
- `_mergeOverlapParts()`: 인접 오버랩 범위 머지
- `DEFAULT_IMAGE_DPI = 72`

---

### 2.5 `ParagraphEngine`

텍스트 래핑 엔진. 기존 `TextLayoutEngine`의 순수 버전 + 엔진 쿼리 API.

#### 타입

```ts
interface ParagraphEngineData {
  content: string
  column: number | number[]
  gap: number | number[]
  paragraphStyle: ParagraphStyle
  textStyle: TextStyle
  inheritStyle: InheritStyle
  overlayEngines: BoxEngine[]
  parentAbsRect: AbsRect
  resources: EngineResources
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
| `inheritStyle` | `InheritStyle` | 상속 스타일 |
| `textContent` | `string` | 현재 텍스트 (편집 반영) |
| `contents` | `TextBlockData[]` | 텍스트 블록 배열 |
| `textStyle` | `TextStyle` | 텍스트 스타일 |
| `paragraphStyle` | `ParagraphStyle` | 단락 스타일 |
| `columnCount` | `number` | 컬럼 수 |
| `columnContents` | `TextLineData[][]` | 컬럼별 라인 데이터 |
| `gaps` | `number[]` | 갭 배열 |
| `lineHeight` | `number` | 라인 높이 |
| `overflow` | `number` | 오버플로우 라인 수 |
| `widthRatio` | `number` | 장평 비율 |
| `spaceRatio` | `number` | 스페이스 비율 |
| `indent` | `number` | 들여쓰기 |
| `columnWidths` | `number[]` | 컬럼 너비 배열 |
| `previousLineCount` | `number` | 이전 렌더 라인 수 |
| `previousOverflow` | `number` | 이전 오버플로우 |
| `scale` | `number` | 스케일 (현재 no-op) |
| `overlapMode` | `ParagraphOverlapMode` | 단락 오버랩 모드 |
| `printPostData` | `PrintPostData[]` | 문자별 printPostData (mm 단위) |

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
- 스켈레톤 캐시: `_computeLayoutInputHash()`로 입력 해시 → 동일하면 재레이아웃 스킵
- LRU 캐시 (capacity 5000):
  - 문자 폭: key `${char}|${fontName}|${fontSize}`
  - 문자 외부 스타일: key `${char}|${widthRatio}|${letterSpacing}|${spaceRatio}|${fontSize}`
- 한글 금칙문자 규칙: `_applyLineBreakRules()` (`LINE_START_FORBIDDEN` / `LINE_END_FORBIDDEN`)
- `_detectOverlapWithCache()`: 렌더 사이클별 오버레이 rect 캐싱
- `_createLineWithParts()`: 오버랩 파트에서 자유 영역 계산, `minCharWidthMm = widthRatio * fontSize + letterSpacing`
- 커서/오프셋 쿼리: `getCharRect`, `getOffsetFromPoint`, `getCursorPlacement`
- `buildParagraphPrintPostData()`: 문자별 print data 생성
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

| 멤버 | 타입 | 설명 |
|------|------|------|
| `absRect` | `AbsRect` | 셀 절대 rect |
| `isDocument` | `false` | 셀 식별 |
| `gridCalculator` | `null` | 셀은 그리드 계산기 없음 |
| `overlayElements` | `[]` | 셀은 오버레이 없음 |
| `childBoxEngines` | `BoxEngine[]` | 셀 내부 박스 엔진 |
| `boxEngine` | `BoxEngine \| undefined` | 셀 내부 박스 엔진 getter/setter |
| `setCellMetrics` | `(x, y, width, height, cellLabel, labels): void` | 셀 메트릭 설정 |
| `x`, `y`, `width`, `height` | `number` | 셀 좌표/크기 |
| `cellLabel`, `labels` | — | 셀 라벨 |

#### `TableRowEngine`

| 멤버 | 타입 | 설명 |
|------|------|------|
| `setRowMetrics` | `(y, height, _contentWidth, rowIndex): void` | 행 메트릭 설정 |
| `y`, `height`, `rowIndex` | `number` | 행 좌표/높이/인덱스 |
| `cellEngines` | `TableCellEngine[]` | 셀 엔진 getter/setter |

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

- **Lazy creation**: 엔진은 `_layoutStructure()` / `_updateEngine()`에서 최초 생성 후 `.data = ...` setter로 재사용
- **Parent 구축**: `box.element.ts._buildParentEngineParent()`가 부모 요소에서 `DocumentEngine`/`BoxEngine`/`TableCellEngine` 추출
- **Overlay wiring**: `paragraph.element.ts`가 `overlayElements` 박스의 `BoxEngine`을 수집해 `ParagraphEngineData.overlayEngines`로 전달
- **RGBA injection**: `image.element.ts._feedRgbaToEngine()`가 canvas `getImageData()`를 `ImageEngine.rgbaData`에 주입

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

## 6. 마이그레이션 가이드

### 6.1 `GridCalculator` → `GridCalculatorEngine`

| 기존 | 새 엔진 |
|------|---------|
| `GridCalculator.create({ element, ... })` | `GridCalculatorEngine.create({ ...opts, isBox }, ppm?)` |
| `GridCalculator.ppm` (static, DOM 측정) | `engine.ppm` (인스턴스 필드, 외부 주입, 옵셔널) |
| `instanceof LayoutBoxElement` 체크 | `opts.isBox: boolean` |

### 6.2 `TextLayoutEngine` → `ParagraphEngine`

| 기존 | 새 엔진 |
|------|---------|
| `TextLayoutEngine.create({ paragraphEl, rootNode, ... })` | `ParagraphEngine.create({ overlayEngines, parentAbsRect, resources, ... })` |
| `paragraphEl.overlayElements` (DOM) | `data.overlayEngines: BoxEngine[]` |
| `paragraphEl.absLeft/absTop` (DOM) | `data.parentAbsRect: AbsRect` |
| `FontLoader.getInstance()` | `resources.fontLoader: FontLoaderEngine` |
| `getOverlapSizeMm(lineRect, el)` | `computeOverlapSizeMm(lineRect, { absRect, overlapMode, image })` |

### 6.3 `getOverlapSizeMm()` → `computeOverlapSizeMm()`

| 기존 | 새 엔진 |
|------|---------|
| `getOverlapSizeMm(lineRect, overlayElement: LayoutBoxElement)` | `computeOverlapSizeMm(lineRect, overlay: OverlapInput)` |
| `overlayElement.canvas.getContext('2d').getImageData()` | `image.rgbaData: Uint8Array` |
| `overlayElement.absLeft/absTop/absWidth/absHeight` | `overlay.absRect: AbsRect` |

> `getOverlapSizeMm`는 `src/utils/check-overlap.ts`에서 **제거됨**. `src/utils/check-overlap.ts`에는 `checkOverlap`, `MmRect`, `mergeOverlapParts`만 남음.

### 6.4 ppm 접근 방식 변경

| 기존 | 새 방식 |
|------|---------|
| `GridCalculator.ppm` (전역 static) | `layoutDocumentElement.ppm` (요소 인스턴스) |
| `GridCalculator.ppm * manager.scale` | `manager.docEl.ppm * manager.scale` |
| `GridCalculator.ppm` (엔진 내부) | `DocumentEngine.ppm` / `EngineResources.ppm` (옵셔널) |

### 6.5 `TextEditCoordinateMapper`

피처 플래그 `TextEditCoordinateMapper.useEngineCoordinateQueries`:

- `false` (기본값): 기존 DOM `getBoundingClientRect()` 경로
- `true`: `ParagraphEngine.getCharRect()` 엔진 쿼리 경로 (mm → ppm 변환)

```ts
// 전환
TextEditCoordinateMapper.useEngineCoordinateQueries = true;
```

---

## 7. Node.js 사용 예시

```ts
import { DocumentEngine, FontLoaderEngineImpl, ColorRegistryEngineImpl } from 'layout-element';
import { readFileSync } from 'fs';
import { PNG } from 'pngjs';

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

// 3. 레이아웃 계산 (전체 엔진 트리 자동 구축)
engine.layout();
const grid = engine.gridCalculator;
console.log(grid.columnCoords);  // mm 단위 컬럼 좌표
console.log(grid.lineHeight);    // 4.8

// 4. printPostData (mm 단위)
console.log(engine.printPostData);

// 5. 이미지 오버랩 (pngjs 사용)
const png = PNG.sync.read(readFileSync('photo.png'));
// ImageEngine에 RGBA 주입
imageEngine.rgbaData = { data: new Uint8Array(png.data), width: png.width, height: png.height };
```

---

## 8. 검증

```bash
npm run verify:engine   # Node.js 호환성 테스트 (25개 assertion)
npm run build           # IIFE + React ESM 빌드
```

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

## 9. 엔진 내보내기 (`src/index.ts`)

vanilla 진입점에서 명시적 engine 내보내기:

**값**:
`GridCalculatorEngine`, `ImageEngine`, `checkOverlapMm`, `computeOverlapSizeMm`, `engineMergeOverlapParts` (alias), `BoxEngine`, `TableEngine`, `TableRowEngine`, `TableCellEngine`, `ParagraphEngine`, `DocumentEngine`, `FontLoaderEngineImpl`, `ColorRegistryEngineImpl`

**타입**:
`GridRect`, `AbsRect`, `EngineMmRect` (alias), `OverlapDirection`, `OverlapResult`, `OverlapInput`, `ImageEngineRef`, `BoxContentType`, `FontLoaderEngine`, `ParsedFont`, `ColorRegistryEngine`, `EngineResources`, `GridCalculatorEngineOptions`, `ImageEngineData`, `ImageLayoutResult`, `BoxLayoutResult`, `TableLayoutResult`, `ParagraphLayoutResult`, `DocumentLayoutResult`, `LayoutResult`, `EngineCursorPlacement` (alias), `RgbaData`

> `MmRect`과 `CursorPlacement`은 `@/core`/`@/utils` 및 `@/edit`에 동일 이름이 있어 alias 처리됨.

---

## 10. 디렉토리 구조

```
src/engine/
  types.ts                    # 공유 타입 (AbsRect, MmRect, OverlapResult, EngineResources 등)
  grid-calculator-engine.ts   # 컬럼 그리드 계산 (ppm 옵셔널)
  image-engine.ts             # 이미지 오버랩 (RGBA 데이터 기반)
  overlap-engine.ts           # 순수 오버랩 판정 함수
  box-engine.ts               # 박스 좌표/오버랩 요소 계산
  table-engine.ts             # 테이블 그리드 해석 + TableCellEngine (BoxEngineParent 구현)
  paragraph-engine.ts         # 텍스트 래핑 + 엔진 쿼리 API + printPostData (mm)
  document-engine.ts          # 문서 루트 (ppm/리소스 관리, 트리 자동 구축)
  font-loader-engine.ts       # opentype.js 전용 (FontFace 없음)
  color-registry-engine.ts    # CMYK→RGB 변환 + get() (fetch 없음)
  index.ts                    # 진입점
```

---

## 11. 상수 (엔진이 사용하는 기본값)

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