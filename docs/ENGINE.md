# Engine Layer — Node.js 호환 순수 계산 엔진

> 본 문서는 `src/engine/` 계층의 아키텍처, 사용법, 마이그레이션 가이드를 기술한다.

---

## 1. 개요

`layout-element` 라이브러리의 수치 계산을 DOM/Canvas 의존성 없이 수행하는 순수 엔진 계층. 브라우저와 Node.js 양쪽에서 동일한 결과를 보장하며, PDF 생성 등 서버 사이드 렌더링을 지원한다.

### 설계 원칙

- **Model-View 분리**: 엔진은 순수 계산, Custom Element는 디스플레이/캐싱/편집
- **ppm 외부 주입**: `DocumentEngine` 생성 시 ppm을 파라미터로 전달. 브라우저는 100mm div 측정, Node는 PDF 엔진 설정값
- **RGBA 데이터 주입**: `ImageEngine`은 canvas `getImageData()` 또는 `pngjs.decode()` 결과를 `Uint8Array`로 받음
- **엔진 캐싱 / 엘리먼트 DOM 캐싱**: 엔진은 연산 결과(글리프 폭, 레이아웃 결과, 오버랩 결과) 캐싱, 엘리먼트는 DOM 노드(span, div) 캐싱

---

## 2. 엔진 클래스

### 2.1 `DocumentEngine`

문서 루트 엔진. ppm, 폰트, 색상 리소스를 주입받아 하위 엔진으로 전파.

```ts
import { DocumentEngine, FontLoaderEngineImpl, ColorRegistryEngineImpl } from 'layout-element';

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init(fontsArray);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init(cmykColorSet);

const engine = DocumentEngine.create(
  documentData,    // DocumentData
  3.78,            // ppm (pixels-per-mm)
  fontLoader,      // FontLoaderEngine
  colorRegistry,   // ColorRegistryEngine
);
engine.layout();
```

### 2.2 `GridCalculatorEngine`

컬럼 그리드 좌표 계산. 기존 `GridCalculator`의 순수 버전.

```ts
import { GridCalculatorEngine } from 'layout-element';

const grid = GridCalculatorEngine.create(
  { width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 }, isBox: false },
  3.78,  // ppm
);
grid.columnCoords;  // GridRect[]
grid.lineHeight;    // 4.8
```

### 2.3 `BoxEngine`

박스 절대 좌표/오버랩 요소 계산.

```ts
const boxEngine = BoxEngine.create(boxData, parentEngineParent, resources);
boxEngine.absRect;        // { absLeft, absTop, absWidth, absHeight }
boxEngine.overlayElements; // BoxEngine[]
```

### 2.4 `ImageEngine`

이미지 오버랩 판정. RGBA 데이터 주입 방식:

- **브라우저**: `canvas.getContext('2d').getImageData()` → `Uint8Array`
- **Node**: `pngjs.decode(buffer)` → `Uint8Array`

```ts
const imgEngine = ImageEngine.create({ url: 'photo.png', dpi: 72, overlapMode: 'path', objectFit: 'cover' });
imgEngine.rgbaData = { data: uint8Array, width: 800, height: 600 };
const result = imgEngine.computeOverlap(lineRectMm, imgRectMm);
```

### 2.5 `ParagraphEngine`

텍스트 래핑 엔진. 기존 `TextLayoutEngine`의 순수 버전 + 엔진 쿼리 API.

```ts
const paraEngine = ParagraphEngine.create({
  content: '본문 텍스트',
  column: 2, gap: 3,
  paragraphStyle: { textAlign: 'justify', lineGap: 1.2 },
  textStyle: { widthRatio: 0.95 },
  inheritStyle: { parentWidth: 180, parentHeight: 260, fontSize: 4 },
  overlayEngines: [],       // BoxEngine[]
  parentAbsRect: { absLeft: 0, absTop: 0, absWidth: 180, absHeight: 260 },
  resources: { ppm: 3.78, fontLoader, colorRegistry },
});
paraEngine.layoutText();
paraEngine.columnContents;  // TextLineData[][]
paraEngine.getCharRect(0);  // MmRect | null
```

### 2.6 `TableEngine`

테이블 그리드 해석. 기존 `resolveTableGrid()` 래핑.

### 2.7 `FontLoaderEngineImpl` / `ColorRegistryEngineImpl`

Node.js 호환 리소스 엔진. `FontFace`/`fetch` 없이 동작.

---

## 3. 마이그레이션 가이드

### 3.1 `GridCalculator` → `GridCalculatorEngine`

| 기존 | 새 엔진 |
|------|---------|
| `GridCalculator.create({ element, ... })` | `GridCalculatorEngine.create({ ...opts, isBox }, ppm)` |
| `GridCalculator.ppm` (static, DOM 측정) | `engine.ppm` (인스턴스 필드, 외부 주입) |
| `instanceof LayoutBoxElement` 체크 | `opts.isBox: boolean` |

### 3.2 `TextLayoutEngine` → `ParagraphEngine`

| 기존 | 새 엔진 |
|------|---------|
| `TextLayoutEngine.create({ paragraphEl, rootNode, ... })` | `ParagraphEngine.create({ overlayEngines, parentAbsRect, resources, ... })` |
| `paragraphEl.overlayElements` (DOM) | `data.overlayEngines: BoxEngine[]` |
| `paragraphEl.absLeft/absTop` (DOM) | `data.parentAbsRect: AbsRect` |
| `FontLoader.getInstance()` | `resources.fontLoader: FontLoaderEngine` |
| `getOverlapSizeMm(lineRect, el)` | `computeOverlapSizeMm(lineRect, { absRect, overlapMode, image })` |

### 3.3 `getOverlapSizeMm()` → `computeOverlapSizeMm()`

| 기존 | 새 엔진 |
|------|---------|
| `getOverlapSizeMm(lineRect, overlayElement: LayoutBoxElement)` | `computeOverlapSizeMm(lineRect, overlay: OverlapInput)` |
| `overlayElement.canvas.getContext('2d').getImageData()` | `image.rgbaData: Uint8Array` |
| `overlayElement.absLeft/absTop/absWidth/absHeight` | `overlay.absRect: AbsRect` |

### 3.4 `TextEditCoordinateMapper`

피처 플래그 `TextEditCoordinateMapper.useEngineCoordinateQueries`:

- `false` (기본값): 기존 DOM `getBoundingClientRect()` 경로
- `true`: `ParagraphEngine.getCharRect()` 엔진 쿼리 경로

```ts
// 전환
TextEditCoordinateMapper.useEngineCoordinateQueries = true;
```

---

## 4. Node.js 사용 예시

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

// 2. 문서 엔진 생성 (ppm 주입)
const engine = DocumentEngine.create(
  { width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' }, children: [] },
  72 / 25.4,  // 72 DPI → ppm
  fontLoader,
  colorRegistry,
);

// 3. 레이아웃 계산
engine.layout();
const grid = engine.gridCalculator;
console.log(grid.columnCoords);  // mm 단위 컬럼 좌표
```

---

## 5. 검증

```bash
npm run verify:engine   # Node.js 호환성 테스트 (25개)
npm run build           # IIFE + React ESM 빌드
```

---

## 6. 디렉토리 구조

```
src/engine/
  types.ts                    # 공유 타입 (AbsRect, MmRect, OverlapResult, EngineResources 등)
  grid-calculator-engine.ts   # 컬럼 그리드 계산 (ppm 주입)
  image-engine.ts             # 이미지 오버랩 (RGBA 데이터 기반)
  overlap-engine.ts           # 순수 오버랩 판정 함수
  box-engine.ts               # 박스 좌표/오버랩 요소 계산
  table-engine.ts             # 테이블 그리드 해석
  paragraph-engine.ts         # 텍스트 래핑 + 엔진 쿼리 API
  document-engine.ts          # 문서 루트 (ppm/리소스 관리)
  font-loader-engine.ts       # opentype.js 전용 (FontFace 없음)
  color-registry-engine.ts    # CMYK→RGB 변환 (fetch 없음)
  index.ts                    # 진입점
```