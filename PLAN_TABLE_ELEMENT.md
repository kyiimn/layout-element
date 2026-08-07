# 개발 계획: `<x-layout-table>` 요소

> **목적**: 기존 `layout-element` 패키지에 HTML `<table>`-style 표 요소를 추가한다. 본 문서는 그린필드 개발자(또는 AI 모델)가 구현을 수행할 수 있도록 알고리즘, 타입 정의, 클래스 구성, 파일 레이아웃, 통합 지점, 검증 단계를 모두 포함한다.

---

## 0. 선수 지식 (기존 아키텍처 요약)

본 문서는 다음 기존 패턴을 그대로 준수한다. 구현 전 반드시 숙지할 것.

### 0.1 측정 단위
- **모든 레이아웃 좌표/크기는 mm 단위**. 픽셀 변환은 `GridCalculator.ppm`(pixels-per-mm, 100mm `<div>` 측정) 사용.

### 0.2 Shadow DOM 캡슐화
- 모든 커스텀 요소는 `attachShadow({ mode: "open" })` 사용.
- 스타일은 HTML 템플릿이 아닌 `styleEl.sheet.insertRule()` 로 프로그래밍 방식 주입.
- 외부(light DOM)에는 의미론적 태그만 노출, 내부 구현(border div, 대각선, handle 등)은 shadow root에 숨김.

### 0.3 3단계 렌더링 파이프라인
각 요소의 `layout()` → `render()` 순서를 따른다:
1. **`layout()`** (동기): `_layoutStructure()` → `_applyStyle()` → `_renderBorder()` (또는 요소별 구조 렌더) → `_propagateInheritStyle()`.
2. **`render()`** (비동기): 자식 정렬(zIndex) 후 재귀. 요소별 특수 렌더(이미지 로딩, 텍스트 래핑 등).
3. 부모의 `layout()` 완료 후 자식 `layout()` → `render()` 순서 보장.

### 0.4 InheritStyle 캐스케이드
`InheritStyle = TextStyle & ParagraphStyle & { parentWidth, parentHeight, padding* }`. 부모가 `_propagateInheritStyle()` 로 자식에 전달. 자식은 자체 스타일로 개별 필드 오버라이드.

### 0.5 data setter (ID-keyed child reconciliation)
기존 `LayoutBoxElement`/`LayoutDocumentElement` 의 `data` setter 패턴:
1. `_rebuildingChildren = true` 로 MutationObserver 억제.
2. 부모 GridCalculator 갱신(`_layoutStructure()`) — 자식이 `connectedCallback` → `layout()` → `relLeft` getter 시 stale coords 방지.
3. 기존 자식을 `Map<id, element>` 로 빌드.
4. 새 children 순회: id 매칭 시 재사용(`element.data = child`), 미매칭 시 `appendChildData` 로 생성.
5. 순서 맞추기 위해 `appendChild` 재배치.
6. 새 children에 없는 기존 요소 제거.
7. `layout()` + `render()` 호출.
8. `finally` 블록에서 `_rebuildingChildren = false`.

### 0.6 보더 렌더링 (기존 box)
`_renderBorder()` 는 `borderColor` 설정 시 4방향별 `<div>` 를 shadow root에 생성. 각 div는 외곽 positioning div + 내부 border-side div 구조. `ppm` 으로 mm→px 변환. `ColorRegistry.getCSSColor(colorName)` 로 CMYK 이름 → `#RRGGBB` 변환.

### 0.7 MutationObserver
`_childObserver = new MutationObserver(callback)` with `{ childList: true }`. 직접 DOM 조작(append/remove) 감지 시 `layout()` + `render()` 자동 트리거. `data` setter 실행 중에는 `_rebuildingChildren` 플래그로 억제.

### 0.8 편집 통합
- `LayoutElement = LayoutBoxElement` 타입. EditManager/LayoutEditController/LayoutSelectionController 가 box 중심 동작.
- `editManager` getter: 부모 체인 탐색해 `LayoutDocumentElement.editManager` 반환.
- `isBoxEditable()`/`isBoxSelectable()`: lock, editableRoot, role, id 필터 적용.
- `_isBoxOrAncestorLocked()`: 조상 lock 전파 검사.

### 0.9 주요 제약
- `GridCalculator.create()` / `TextLayoutEngine.create()` 만 인스턴스화 가능 (constructor private).
- `noUnusedLocals` / `noUnusedParameters` 활성화 — dead import/param 빌드 에러.
- TypeScript 7 RC, `noEmit: true` (tsc는 타입체크만, 컴파일은 Vite).
- zIndex 레이아웃 요소: 0~90000. 90001~99999 예약(UI 요소).

---

## 1. 요소 트리 및 DOM 구조

### 1.1 외부 노출 DOM (light DOM)
```html
<x-layout-box>                    <!-- 부모 box. 위치/배경/외곽 border 정의 -->
  <x-layout-table>                <!-- box의 콘텐츠. 내부 그리드 + 셀 border 관리 -->
    <x-layout-tr>                 <!-- 행. height(mm) -->
      <x-layout-td>               <!-- 셀. 자체 GridCalculator(columns=1). box들 자식 -->
        <x-layout-box>            <!-- 셀 내 box. paragraph/image/nested-table 감싸기 -->
          <x-layout-paragraph> <!-- 또는 image, table -->
          </x-layout-paragraph>
        </x-layout-box>
      </x-layout-td>
    </x-layout-tr>
  </x-layout-table>
</x-layout-box>
```

### 1.2 Shadow DOM (외부 비노출)
| 요소 | shadow root 내부 | light DOM 자식 |
|---|---|---|
| `<x-layout-table>` | `<style>`, `<div class="border-layer">`(보더 엣지 div들), `<slot>` | `<x-layout-tr>` |
| `<x-layout-tr>` | `<style>`, `<slot>` | `<x-layout-td>` |
| `<x-layout-td>` | `<style>`, 대각선 SVG/div, `<slot>` | `<x-layout-box>` |
| `<x-layout-box>` | 기존 동일 | paragraph/image/table(중첩) |

---

## 2. 타입 정의

### 2.1 신규 파일: `src/types/layout/table.type.ts`

```typescript
import type { BoxData, BoxBorderStyle } from "./box.type";

/**
 * 테이블 데이터. box의 콘텐츠 타입(`BoxData.children`에 직접 지정).
 *
 * 테이블 자체의 위치/크기/배경/외곽 테두리는 부모 box가 정의한다.
 * 테이블은 부모 box의 콘텐츠 영역(box width/height - padding)을 가득 채우며,
 * 내부를 colWidths × 행 높이 그리드로 분할한다.
 *
 * @example
 * // box 안에 3컬럼 테이블
 * const box: BoxData = {
 *   type: 'box', left: 0, top: 0, width: 3, height: 10,
 *   children: {
 *     type: 'table',
 *     colWidths: [40, 30, 30],
 *     children: [
 *       { type: 'tr', height: 5, children: [
 *         { type: 'td', children: [{ type: 'box', left: 0, top: 0, width: 1, height: 5, children: { type: 'paragraph', content: 'A' } }] },
 *         { type: 'td', children: [{ type: 'box', ... }] },
 *       ]},
 *     ],
 *   },
 * };
 */
export type TableData = {
  /** 타입 식별자 (리터럴) */
  type: 'table';

  /** 고유 식별자 (선택) */
  id?: string;

  /**
   * 컬럼별 너비(mm).
   * - `number` = 모든 컬럼 동일 너비
   * - `number[]` = 컬럼별 개별 너비. 합이 부모 box 콘텐츠 폭과 일치 권장.
   * - 누락 시 콘텐츠 폭을 컬럼 수로 균등 분할.
   * @unit mm
   */
  colWidths?: number | number[];

  /** 행 데이터 (자식). 기존 명명 규칙에 따라 `children` 사용 */
  children: TableRowData[];
};

/**
 * 테이블 행 데이터.
 *
 * @example
 * { type: 'tr', height: 10, children: [cell1, cell2, cell3] }
 */
export type TableRowData = {
  /** 타입 식별자 (리터럴) */
  type: 'tr';

  /** 고유 식별자 (선택) */
  id?: string;

  /**
   * 행 높이.
   * @unit mm
   */
  height: number;

  /** 셀 데이터 (자식) */
  children: TableCellData[];
};

/**
 * 테이블 셀 데이터.
 *
 * 각 셀은 box들을 자식으로 가지며(paragraph/image/nested-table은 항상 box로 감싸임),
 * 자체 GridCalculator(columns=1)를 보유하여 cell 내부를 box 배치 컨텍스트로 동작시킨다.
 * 셀 자체의 테두리는 방향별로 선언하며 인접 셀과 공유된다.
 * 실제 테두리 렌더링은 부모 table이 담당하고, 셀은 선언만 보유한다.
 *
 * @example
 * {
 *   type: 'td',
 *   colspan: 2,
 *   borderTop: { width: 1, color: 'black' },
 *   borderRight: { width: 1, color: 'black' },
 *   borderBottom: { width: 1, color: 'black' },
 *   borderLeft: { width: 1, color: 'black' },
 *   backgroundColor: 'lightgray',
 *   diagonals: ['tl-br'],
 *   children: [{ type: 'box', ... }],
 * }
 */
export type TableCellData = {
  /** 타입 식별자 (리터럴) */
  type: 'td';

  /** 고유 식별자 (선택) */
  id?: string;

  /** 열 병합. 기본 1 */
  colspan?: number;

  /** 행 병합. 기본 1 */
  rowspan?: number;

  /**
   * 방향별 테두리 엣지 선언.
   * 인접 셀과 공유됨 — A.borderRight와 B.borderLeft는 동일 엣지.
   * 테이블 렌더 단계에서 border-collapse 레이어로 한 번만 그려진다.
   * 셀 자체는 테두리를 렌더링하지 않고 선언만 보유한다.
   */
  borderTop?: CellBorderEdge;
  borderRight?: CellBorderEdge;
  borderBottom?: CellBorderEdge;
  borderLeft?: CellBorderEdge;

  /**
   * 배경색. ColorRegistry에 등록된 CMYK 색상 이름 사용.
   * `ColorRegistry.getCSSColor()` 가 `#RRGGBB` hex로 변환.
   */
  backgroundColor?: string;

  /** 배경색 투명도 (0~1). 생략 시 1(불투명) */
  backgroundOpacity?: number;

  /**
   * 대각선. 셀 내부에 그려진다 (보더 공유 대상 아님).
   * - `'tl-br'`: 좌상→우하
   * - `'tr-bl'`: 우상→좌하
   * 복수 지정 가능 (X 표시).
   */
  diagonals?: Array<'tl-br' | 'tr-bl'>;

  /** 셀 내부 상단 여백 (mm) */
  paddingTop?: number;

  /** 셀 내부 우측 여백 (mm) */
  paddingRight?: number;

  /** 셀 내부 하단 여백 (mm) */
  paddingBottom?: number;

  /** 셀 내부 좌측 여백 (mm) */
  paddingLeft?: number;

  /** 셀 내용. BoxData[]만 허용 — paragraph/image/table은 항상 box로 감싸임 */
  children: BoxData[];
};

/**
 * 단일 엣지 테두리 선언.
 *
 * @example
 * { width: 1, color: 'black', style: 'solid' }
 */
export type CellBorderEdge = {
  /** 두께. @unit mm */
  width: number;

  /** 색상 (ColorRegistry CMYK 이름) */
  color: string;

  /** 스타일. 기본 'solid' */
  style?: BoxBorderStyle;
};
```

### 2.2 기존 타입 수정

#### `src/types/layout/box.type.ts`
`BoxData.children` 유니온에 `TableData` 추가:
```typescript
// 변경 전:
children?: BoxData[] | ParagraphData | TextData | ImageData;

// 변경 후:
children?: BoxData[] | ParagraphData | TextData | ImageData | TableData;
```
import 구문에 `import { TableData } from "./table.type";` 추가.

#### `src/types/layout/index.ts`
```typescript
export * from "./box.type";
export * from "./document.type";
export * from "./guide-column.type";
export * from "./image.type";
export * from "./paragraph.type";
export * from "./render-complete-event.type";
export * from "./table.type";   // ← 추가
export * from "./text/text-block.type";
export * from "./text/text-line.type";
export * from "./text.type";
```

---

## 3. 상수 추가

### `src/constants/defaults.ts`
```typescript
/**
 * 테이블 보더 레이어 z-index.
 * 셀 배경 위, 셀 컨텐츠(box) 아래에 위치.
 * Z_INDEX_RESIZE_HANDLE(99999) 미만, Z_INDEX_TEXTAREA(9999) 미만 범위에서 예약.
 */
export const Z_INDEX_TABLE_BORDER = 99990;

/** 테이블 대각선 z-index. 셀 컨텐츠 위, 보더 레이어와 독립. */
export const Z_INDEX_TABLE_DIAGONAL = 99991;

/** 테이블 리사이즈 핸들 레이어 z-index. 핸들이 보더/대각선 위에 표시. */
export const Z_INDEX_TABLE_RESIZE = 99992;

/** 테이블 컬럼 최소 너비 (mm). 리사이즈 시 이하로 축소 불가. */
export const MIN_TABLE_COL_WIDTH = 5;

/** 테이블 행 최소 높이 (mm). 리사이즈 시 이하로 축소 불가. */
export const MIN_TABLE_ROW_HEIGHT = 5;
```

### `src/constants/index.ts`
`defaults.ts` 의 모든 export가 이미 re-export되는지 확인 (기존 패턴 준수). 신규 상수 자동 포함.

---

## 4. TableGridResolver — 그리드 배치 알고리즘

### 4.1 신규 파일: `src/core/table-grid-resolver.ts`

colspan/rowspan을 고려하여 각 셀의 실제 그리드 위치와 mm 좌표/크기를 계산하는 유틸리티. HTML `<table>` placement 알고리즘과 동일.

```typescript
import type { TableRowData, TableCellData } from "@/types";

/**
 * 셀의 그리드 배치 결과.
 */
export type CellPlacement = {
  /** 원본 셀 데이터 */
  cell: TableCellData;

  /** 셀이 차지하는 시작 그리드 열 인덱스 (0부터) */
  gridCol: number;

  /** 셀이 차지하는 시작 그리드 행 인덱스 (0부터) */
  gridRow: number;

  /** 차지하는 열 개수 (colspan) */
  spanCols: number;

  /** 차지하는 행 개수 (rowspan) */
  spanRows: number;

  /** 셀의 mm 좌표 (테이블 기준) */
  x: number;

  /** 셀의 mm 좌표 (테이블 기준) */
  y: number;

  /** 셀의 mm 너비 */
  width: number;

  /** 셀의 mm 높이 */
  height: number;
};

/**
 * 행 높이 배열.
 */
export type RowHeights = number[];

/**
 * 컬럼 너비 배열.
 */
export type ColWidths = number[];

/**
 * 그리드 해석 결과.
 */
export type GridResolution = {
  /** 각 행의 높이 */
  rowHeights: RowHeights;

  /** 각 컬럼의 너비 */
  colWidths: ColWidths;

  /** 총 그리드 행 수 */
  rowCount: number;

  /** 총 그리드 열 수 */
  colCount: number;

  /** 셀 배치 결과 (TR 순서, TD 순서) */
  placements: CellPlacement[];

  /** 오류/경고 메시지 (빈 배열 = 정상) */
  warnings: string[];
};

/**
 * 테이블 그리드를 해석하여 각 셀의 배치와 mm 좌표를 계산한다.
 *
 * 알고리즘 (HTML table placement와 동일):
 * 1. rows 배열에서 각 행의 height를 읽어 rowHeights 구성.
 * 2. colWidths 정규화:
 *    - number (단일 값): 모든 컬럼 동일 너비. 컬럼 수 = 모든 행의 셀 수 중 최대값.
 *    - number[]: 컬럼별 개별 너비. 컬럼 수 = 배열 길이.
 *    - 누락: 테이블 콘텐츠 폭을 컬럼 수로 균등 분할.
 * 3. 컬럼 수 확정 후 (rows × maxCols) 점유 배열 생성 (boolean[][]).
 * 4. 각 행을 순서대로 순회:
 *    - 행 내 셀을 순서대로 순회:
 *      a. 점유 배열에서 첫 빈 슬롯 탐색 (gridCol 증가).
 *      b. colspan, rowspan 확정 (기본 1).
 *      c. 해당 영역 점유 표시.
 *      d. x = sum(colWidths[0..gridCol-1])
 *         y = sum(rowHeights[0..gridRow-1])
 *         width = sum(colWidths[gridCol..gridCol+spanCols-1])
 *         height = sum(rowHeights[gridRow..gridRow+spanRows-1])
 *      e. CellPlacement 생성.
 * 5. 경고 검사:
 *    - colspan/rowspan이 그리드 범위 범위 초과 → warning + clamp.
 *    - colWidths 합 ≠ 콘텐츠 폭 → warning (비례 정규화는 호출자가 수행).
 *    - 빈 슬롯 없음 → warning + 셀 스킵.
 *
 * @param rows - 행 데이터 배열 (TableRowData[])
 * @param contentWidth - 부모 box의 콘텐츠 폭 (mm). colWidths 정규화 기준.
 * @param contentHeight - 부모 box의 콘텐츠 높이 (mm). rowHeights 정규화 기준.
 * @param colWidthsInput - 사용자 지정 colWidths (number | number[] | undefined)
 * @returns 그리드 해석 결과
 *
 * @example
 * const result = resolveTableGrid(
 *   [{ type: 'tr', height: 10, children: [
 *     { type: 'td', colspan: 2, children: [...] },
 *     { type: 'td', children: [...] },
 *   ]}],
 *   100, // contentWidth mm
 *   80,  // contentHeight mm
 *   [60, 40], // colWidths
 * );
 * // result.placements[0] → { gridCol: 0, gridRow: 0, spanCols: 2, x: 0, y: 0, width: 100, height: 10 }
 * // result.placements[1] → { gridCol: 2, gridRow: 0, spanCols: 1, x: 100, y: 0, width: ... }
 * // (위 예시는 컬럼이 2개뿐이므로 colspan=2가 전체 차지 → 두 번째 셀은 다음 행으로)
 */
export function resolveTableGrid(
  rows: TableRowData[],
  contentWidth: number,
  contentHeight: number,
  colWidthsInput: number | number[] | undefined,
): GridResolution;
```

### 4.2 구현 의사 코드 (개발자용)

```
function resolveTableGrid(rows, contentWidth, contentHeight, colWidthsInput):
  rowHeights = rows.map(r => r.height)

  // 1. 컬럼 수 계산
  maxCellsInRow = max(rows.map(r => r.children.length))
  if colWidthsInput is number[]:
    colCount = colWidthsInput.length
  else if colWidthsInput is number:
    colCount = maxCellsInRow
  else: // undefined
    colCount = maxCellsInRow

  // 2. colWidths 정규화 — 엄격한 크기 관리
  //    규칙: 합 = contentWidth, 최소 MIN_TABLE_COL_WIDTH 보장
  if colWidthsInput is number[]:
    colWidths = normalizeWidths(colWidthsInput, contentWidth, MIN_TABLE_COL_WIDTH)
  else if colWidthsInput is number:
    // 단일 값: 모든 컬럼 동일 너비
    colWidths = new Array(colCount).fill(colWidthsInput)
    colWidths = normalizeWidths(colWidths, contentWidth, MIN_TABLE_COL_WIDTH)
  else:
    // undefined: 균등 분할
    eachWidth = contentWidth / colCount
    colWidths = new Array(colCount).fill(eachWidth)

  // 3. rowHeights 정규화 — 합 = contentHeight, 최소 MIN_TABLE_ROW_HEIGHT 보장
  rowHeights = normalizeWidths(rowHeights, contentHeight, MIN_TABLE_ROW_HEIGHT)

  // ... 이하 기존 점유 배열 + 배치 로직 ...
```

#### normalizeWidths — 셀 크기 정규화 알고리즘

```
/**
 * 셀 너비/높이 배열을 정규화한다.
 *
 * 규칙:
 * 1. 합 = targetSize (테이블 크기를 넘지 않음)
 * 2. 각 셀 >= minSize (최소 크기 보장)
 * 3. 최초 데이터 주입 시: 앞순서 셀의 크기를 우선시, 나머지 조정
 * 4. 최소 크기로도 targetSize 초과 시: 균등하게 축소
 *
 * 알고리즘:
 * 1. 각 셀 크기를 minSize로 clamp (최소 보장).
 * 2. 앞순서 셀부터 순회하며 크기 확정:
 *    - remaining = targetSize - (이미 확정된 셀 크기 합)
 *    - remainingCount = 아직 확정되지 않은 셀 수
 *    - 현재 셀 크기 = min(original, remaining - (remainingCount-1) * minSize)
 *      (남은 셀들이 최소 크기를 가질 공간을 남겨둠)
 *    - 현재 셀 크기 < minSize → minSize로 설정 (최소 보장)
 * 3. 마지막 셀: remaining 전부 할당 (나머지).
 * 4. 정규화 후 합이 targetSize와 일치하는지 확인.
 * 5. 모든 셀이 minSize인데 합 > targetSize → 균등 축소:
 *    - scale = targetSize / sum
 *    - 각 셀 = max(minSize, original * scale)
 *    - 단, scale 후에도 minSize 보장 (이 경우 합 > targetSize 가능 → warning)
 *
 * @param inputs - 원본 셀 크기 배열
 * @param targetSize - 목표 합 (contentWidth 또는 contentHeight)
 * @param minSize - 최소 셀 크기 (MIN_TABLE_COL_WIDTH 또는 MIN_TABLE_ROW_HEIGHT)
 * @returns 정규화된 셀 크기 배열
 *
 * @example
 * // 3개 셀, 합 100mm, 최소 5mm
 * // 원본 [60, 30, 30] → 합 120 > 100
 * // 앞순서 우선: 셀0 = min(60, 100 - 2*5) = 60 → 남은 40
 * //   셀1 = min(30, 40 - 1*5) = 30 → 남은 10
 * //   셀2 = 10 (나머지)
 * // 결과: [60, 30, 10] (합=100)
 *
 * // 원본 [50, 50, 50] → 합 150 > 100, 앞순서 우선 시도:
 * //   셀0 = min(50, 100 - 2*5) = 50 → 남은 50
 * //   셀1 = min(50, 50 - 1*5) = 45 → 남은 5
 * //   셀2 = 5 (나머지)
 * // 결과: [50, 45, 5] (합=100, 최소 5mm 보장)
 *
 * // 원본 [100, 100, 100] → 합 300 >> 100, 앞순서 우선:
 * //   셀0 = min(100, 100 - 2*5) = 90 → 남은 10
 * //   셀1 = min(100, 10 - 5) = 5 → 남은 5
 * //   셀2 = 5
 * // 결과: [90, 5, 5] (합=100, 최소 보장)
 */
function normalizeWidths(inputs, targetSize, minSize):
  n = inputs.length

  // 케이스 1: 합이 targetSize 이하 → 그대로 사용 (부족분은 마지막 셀에 추가 또는 비율 배분)
  sum = inputs.reduce((a, b) => a + b, 0)
  if sum === targetSize:
    // 각 셀 minSize 보장
    result = inputs.map(v => Math.max(v, minSize))
    // minSize 보정 후 합이 변할 수 있으므로 마지막 셀로 조정
    diff = targetSize - result.reduce((a, b) => a + b, 0)
    result[n-1] += diff
    return result

  // 케이스 2: 합 > targetSize → 앞순서 우선 정규화
  result = new Array(n).fill(0)
  remaining = targetSize
  for i = 0 to n - 2:
    remainingCount = n - i - 1
    // 남은 셀들이 최소 크기를 가질 공간 확보
    maxForThis = remaining - remainingCount * minSize
    result[i] = Math.max(minSize, Math.min(inputs[i], maxForThis))
    remaining -= result[i]
  // 마지막 셀: 나머지 전부 (최소 보장)
  result[n-1] = Math.max(minSize, remaining)

  // 케이스 3: 모든 셀이 minSize인데 합 > targetSize → 균등 축소
  if result.every(v => v === minSize) AND result.reduce(...) > targetSize:
    // n * minSize > targetSize → 비례 축소
    scale = targetSize / (n * minSize)
    result = result.map(v => Math.max(minSize, v * scale))
    // 경고: 최소 크기를 보장하면 합이 targetSize 초과 불가피
    warnings.push(`Cannot fit ${n} cells (min ${minSize}mm each) into ${targetSize}mm`)

  return result
```

#### 점유 배열 + 셀 배치 로직

```
  // 3. 점유 배열 (colCount × rowCount)
  occupied = 2D array [rowCount][colCount] = false

  // 4. 셀 배치
  placements = []
  warnings = []
  for r = 0 to rows.length - 1:
    gridCol = 0
    for cell in rows[r].children:
      // 첫 빈 슬롯 탐색
      while gridCol < colCount AND occupied[r][gridCol]:
        gridCol++
      if gridCol >= colCount:
        warnings.push(`Row ${r}: 빈 슬롯 없음, 셀 스킵`)
        continue

      spanCols = cell.colspan ?? 1
      spanRows = cell.rowspan ?? 1

      // clamp
      if gridCol + spanCols > colCount:
        warnings.push(`Row ${r}: colspan ${spanCols}이 그리드 범위 초과, ${colCount - gridCol}로 clamp`)
        spanCols = colCount - gridCol
      if r + spanRows > rowCount:
        spanRows = rowCount - r

      // 점유 표시
      for dr = 0 to spanRows - 1:
        for dc = 0 to spanCols - 1:
          occupied[r + dr][gridCol + dc] = true

      // mm 좌표 계산
      x = sum(colWidths[0..gridCol-1])
      y = sum(rowHeights[0..r-1])
      width = sum(colWidths[gridCol..gridCol+spanCols-1])
      height = sum(rowHeights[r..r+spanRows-1])

      placements.push({ cell, gridCol, gridRow: r, spanCols, spanRows, x, y, width, height })
      gridCol += spanCols

  // 5. 경고
  if sum(colWidths) !== contentWidth:
    warnings.push(`colWidths 합(${sum(colWidths)})이 콘텐츠 폭(${contentWidth})과 불일치`)

  return { rowHeights, colWidths, rowCount: rows.length, colCount, placements, warnings }
```

### 4.3 Export
`src/core/index.ts`:
```typescript
export * from "./table-grid-resolver";
```

`resolveTableGrid`와 함께 `normalizeWidths`도 export되어 `TableStructureEditor`가 insertRowOrCol 시 사용:

```typescript
// src/core/table-grid-resolver.ts
export function normalizeWidths(
  inputs: number[],
  targetSize: number,
  minSize: number,
): number[];
```

---

## 5. BorderResolver — 보더 공유 알고리즘

### 5.1 신규 파일: `src/core/border-resolver.ts`

인접 셀의 보더 선언을 해석하여 중복 없는 엣지 집합을 생성.

```typescript
import type { CellPlacement, GridResolution } from "./table-grid-resolver";
import type { CellBorderEdge } from "@/types";

/**
 * 해석된 단일 보더 엣지.
 */
export type ResolvedBorderEdge = {
  /** 엣지 식별 키: "h-{row}-{col}" (수평) | "v-{row}-{col}" (수직) */
  key: string;

  /** 엣지 방향 */
  direction: 'horizontal' | 'vertical';

  /** 시작 X (mm, 테이블 기준) */
  x: number;

  /** 시작 Y (mm, 테이블 기준) */
  y: number;

  /** 엣지 길이 (mm). 수평=너비, 수직=높이 */
  length: number;

  /** 보더 두께 (mm) */
  width: number;

  /** 보더 색상 (ColorRegistry 이름) */
  color: string;

  /** 보더 스타일 */
  style: 'solid' | 'dotted' | 'dashed';
};

/**
 * 보더 해석 결과.
 */
export type BorderResolution = {
  /** 렌더링 대상 엣지들 (중복 제거됨) */
  edges: ResolvedBorderEdge[];

  /** 충돌 경고 */
  warnings: string[];
};

/**
 * 테이블 셀들의 보더 선언을 해석하여 렌더링 대상 엣지 집합을 생성한다.
 *
 * 공유 규칙:
 * - A.borderRight와 B.borderLeft는 동일 엣지 (인접 셀).
 * - 충돌 시 (양쪽 다 선언하고 값이 다름): 나중 등장 셀 우선.
 *   - 수직 엣지: (r, c).borderRight vs (r, c+1).borderLeft → (r, c+1) 우선.
 *   - 수평 엣지: (r, c).borderBottom vs (r+1, c).borderTop → (r+1, c) 우선.
 * - 직접 주입된 override가 있으면 최우선.
 *
 * 렌더링 규칙 (중복 제거):
 * - 수직 엣지: 각 row의 col=0은 left+right, col≥1은 right만.
 * - 수평 엣지: row=0은 top+bottom, row≥1은 bottom만.
 *
 * @param grid - resolveTableGrid() 결과
 * @param overrides - 직접 주입된 엣지 override (key → CellBorderEdge). 선택.
 * @returns 보더 해석 결과
 *
 * @example
 * const borderResult = resolveTableBorders(gridResult);
 * // borderResult.edges → 렌더링할 엣지들
 * tableElement._renderBorderLayer(borderResult.edges);
 */
export function resolveTableBorders(
  grid: GridResolution,
  overrides?: Map<string, CellBorderEdge>,
): BorderResolution;
```

### 5.2 구현 의사 코드

```
function resolveTableBorders(grid, overrides):
  edges = Map<key, ResolvedBorderEdge>
  warnings = []

  // placements를 (gridRow, gridCol) 로 인덱싱
  cellMap = Map<"r-c", CellPlacement>
  for p in grid.placements:
    for dr = 0 to p.spanRows - 1:
      for dc = 0 to p.spanCols - 1:
        cellMap.set(`${p.gridRow + dr}-${p.gridCol + dc}`, p)
        // (동일 placement가 여러 슬롯에 매핑 — span 영역)

  // 1. 모든 셀의 4방향 엣지 수집 + 충돌 해결
  // 수직 엣지: "v-{r}-{c}" = 열 c의 왼쪽(=열 c-1의 오른쪽)
  //   - (r, c-1).borderRight ≡ (r, c).borderLeft
  //   - 충돌 시 (r, c).borderLeft 우선 (나중 등장)
  // 수평 엣지: "h-{r}-{c}" = 행 r의 위쪽(=행 r-1의 아래쪽)
  //   - (r-1, c).borderBottom ≡ (r, c).borderTop
  //   - 충돌 시 (r, c).borderTop 우선 (나중 등장)

  // 처리 순서: 행 → 열 순서로 순회 (나중 등장 = 더 큰 r 또는 더 큰 c)
  for r = 0 to grid.rowCount - 1:
    for c = 0 to grid.colCount - 1:
      p = cellMap.get(`${r}-${c}`)
      if p == null: continue

      cell = p.cell

      // --- 수직 엣지 (left) ---
      // 엣지 키: "v-{r}-{c}" — 열 c의 왼쪽 경계
      if c === 0 OR cell.colspan 경계 (p의 첫 열):
        // 왼쪽 엣지는 이 셀이 소유
        edgeKey = `v-${r}-${c}`
        candidate = cell.borderLeft
        // override 확인
        if overrides.has(edgeKey):
          candidate = overrides.get(edgeKey)
        // 충돌 해결: 이전 셀의 borderRight가 있으면,
        //   이 셀(borderLeft)이 나중 등장이므로 우선 — candidate 유지
        //   (단, 이 셀에 borderLeft 선언이 없으면 이전 셀 값 사용)
        if candidate == null:
          // 이전 셀의 borderRight 확인 (수직: 같은 행, 열 c-1)
          prevP = cellMap.get(`${r}-${c-1}`)
          if prevP: candidate = prevP.cell.borderRight
        if candidate != null AND candidate.width > 0:
          edges.set(edgeKey, makeVerticalEdge(edgeKey, p.x, p.y_top, p.height_total, candidate))

      // --- 수직 엣지 (right) ---
      // 엣지 키: "v-{r}-{c + spanCols - 1 + 1}" = "v-{r}-{lastCol+1}"
      rightCol = p.gridCol + p.spanCols
      edgeKey = `v-${r}-${rightCol}`
      candidate = cell.borderRight
      if overrides.has(edgeKey):
        candidate = overrides.get(edgeKey)
      // 다음 셀의 borderLeft가 있으면 그것이 나중 등장 → 우선
      nextP = cellMap.get(`${r}-${rightCol}`)
      if nextP AND nextP.cell.borderLeft != null:
        candidate = nextP.cell.borderLeft  // 나중 등장 우선
      if candidate != null AND candidate.width > 0:
        edges.set(edgeKey, makeVerticalEdge(edgeKey, p.x + p.width, p.y_top, p.height_total, candidate))

      // --- 수평 엣지 (top) ---
      // 엣지 키: "h-{r}-{c}" — 행 r의 위쪽 경계
      if r === 0 OR p의 첫 행:
        edgeKey = `h-${r}-${c}`
        candidate = cell.borderTop
        if overrides.has(edgeKey):
          candidate = overrides.get(edgeKey)
        if candidate == null:
          // 이전 행의 borderBottom 확인
          prevP = cellMap.get(`${r-1}-${c}`)
          if prevP: candidate = prevP.cell.borderBottom
        if candidate != null AND candidate.width > 0:
          edges.set(edgeKey, makeHorizontalEdge(edgeKey, p.x_left, p.y, p.width_total, candidate))

      // --- 수평 엣지 (bottom) ---
      bottomRow = p.gridRow + p.spanRows
      edgeKey = `h-${bottomRow}-${c}`
      candidate = cell.borderBottom
      if overrides.has(edgeKey):
        candidate = overrides.get(edgeKey)
      // 다음 행의 borderTop이 있으면 나중 등장 우선
      nextP = cellMap.get(`${bottomRow}-${c}`)
      if nextP AND nextP.cell.borderTop != null:
        candidate = nextP.cell.borderTop
      if candidate != null AND candidate.width > 0:
        edges.set(edgeKey, makeHorizontalEdge(edgeKey, p.x_left, p.y + p.height, p.width_total, candidate))

  // 2. 렌더링 대상 필터링 (중복 제거 규칙)
  // 수직: 각 row의 col=0은 left+right, col≥1은 right만
  //   → 모든 left 엣지 중 col=0만 유지 (나머지 제거)
  // 수평: row=0은 top+bottom, row≥1은 bottom만
  //   → 모든 top 엣지 중 row=0만 유지
  //
  // 단, colspan/rowspan으로 인해 엣지가 복잡할 수 있으므로,
  // "첫 col/row의 외곽 엣지 + 각 col/row의 right/bottom 엣지" 규칙을 적용.
  // 구현: edgeMap에서 키 패턴으로 필터링
  //   - 수직 "v-{r}-{c}": c===0 OR c가 렌더링 대상(각 셀의 rightCol)이면 유지
  //   - 수평 "h-{r}-{c}": r===0 OR r가 렌더링 대상(각 셀의 bottomRow)이면 유지

  filteredEdges = []
  renderTargetCols = Set of all rightCol values (수직 right 엣지들)
  renderTargetRows = Set of all bottomRow values (수평 bottom 엣지들)

  for [key, edge] in edges:
    [dir, r, c] = parseKey(key)
    if dir === 'v':
      if c === 0 OR renderTargetCols.has(c): filteredEdges.push(edge)
      // c===0: 첫 col의 left. c in renderTargetCols: 각 col의 right.
      // 중간 col의 left 엣지는 이전 col의 right와 동일하므로 제거.
    else: // 'h'
      if r === 0 OR renderTargetRows.has(r): filteredEdges.push(edge)

  return { edges: filteredEdges, warnings }
```

### 5.3 헬퍼 함수

```
function makeVerticalEdge(key, x, y, height, border: CellBorderEdge): ResolvedBorderEdge {
  return {
    key, direction: 'vertical',
    x, y, length: height,
    width: border.width,
    color: border.color,
    style: border.style ?? 'solid',
  }
}

function makeHorizontalEdge(key, x, y, width, border: CellBorderEdge): ResolvedBorderEdge {
  return {
    key, direction: 'horizontal',
    x, y, length: width,
    width: border.width,
    color: border.color,
    style: border.style ?? 'solid',
  }
}
```

### 5.4 Export
`src/core/index.ts`:
```typescript
export * from "./border-resolver";
```

---

## 6. 커스텀 요소 구현

### 6.1 `<x-layout-table>` — `src/components/layout/table.element.ts`

```typescript
export class LayoutTableElement extends HTMLElement {
  // Shadow root (open mode)
  private _shadowRoot: ShadowRoot;

  // 스타일 규칙 참조 (:host)
  private _styleRule?: CSSStyleRule;

  // 보더 레이어 컨테이너 div
  private _borderLayerEl: HTMLDivElement | null = null;

  // 보더 엣지 div 맵 (key → div). diff 기반 갱신용.
  private _borderEdgeMap: Map<string, HTMLDivElement> = new Map();

  // 자식 observer (TR 추가/제거 감지)
  private _childObserver: MutationObserver | null = null;
  private _rebuildingChildren = false;
  private _pendingData: TableData | null = null;

  // 데이터 필드
  private _colWidths?: number | number[];
  private _rows: TableRowData[] = [];

  // InheritStyle (부모 box에서 전파받음)
  private _inheritStyle?: InheritStyle;

  // 그리드 해석 결과 캐시
  private _gridResolution?: GridResolution;

  // 보더 해석 결과 캐시
  private _borderResolution?: BorderResolution;

  // 직접 주입된 보더 override
  private _borderOverrides: Map<string, CellBorderEdge> = new Map();

  // 부모 box 참조 (콘텐츠 폭/높이 얻기 위함)
  // → parentElement가 LayoutBoxElement

  // 인쇄 모드 플래그
  private _isPrint: boolean = window.matchMedia("print").matches;

  constructor();
  connectedCallback();
  disconnectedCallback();

  static get observedAttributes(): readonly string[];
  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null): void;

  // ─── data getter/setter ───
  get data(): TableData;
  set data(data: TableData);

  // ─── 속성 getter/setter ───
  get colWidths(): number | number[] | undefined;
  set colWidths(value: number | number[] | undefined);

  // ─── 렌더링 파이프라인 ───
  /**
   * 동기 렌더링 1단계. 부모 box의 콘텐츠 영역을 가득 채우도록
   * :host 스타일 적용, 자식 TR에 좌표 부여, 보더 레이어 갱신.
   */
  layout(): void;

  /**
   * 비동기 렌더링. 자식 TR render() 재귀 호출.
   */
  async render(): Promise<void>;

  // ─── private 메서드 ───
  private _layoutStructure(): void;
  private _applyStyle(): void;
  private _renderBorder(): void;
  private _renderBorderLayer(edges: ResolvedBorderEdge[]): void;
  private _propagateInheritStyle(): void;

  // ─── 자식 관리 ───
  /**
   * TR 데이터를 받아 x-layout-tr 요소를 생성/추가.
   * 기존 box.appendChildData 패턴과 동일.
   */
  appendChildData(child: TableRowData): LayoutTableRowElement;

  private _appendChildData(child: TableRowData): void;
  private _serializeChildren(): TableRowData[];
  private _startChildObserver(): void;
  private _stopChildObserver(): void;
  private _onChildMutation(): void;

  // ─── 그리드/보더 갱신 ───
  /**
   * 부모 box의 콘텐츠 폭/높이를 읽어 TableGridResolver 실행.
   * 결과를 _gridResolution에 캐시.
   */
  private _resolveGrid(): GridResolution | null;

  /**
   * _gridResolution 기반으로 BorderResolver 실행.
   * _borderOverrides를 override로 전달.
   */
  private _resolveBorders(): BorderResolution | null;

  /**
   * 보더 override 주입.
   * @param key - 엣지 키 ("h-r-c" | "v-r-c")
   * @param edge - 보더 엣지 선언
   */
  setBorderOverride(key: string, edge: CellBorderEdge): void;

  clearBorderOverride(key: string): void;

  // ─── 리사이즈 핸들 (섹션 8A) ───
  /** 리사이즈 핸들 레이어 div */
  private _resizeHandleLayerEl: HTMLDivElement | null = null;
  /** 핸들 div 배열 */
  private _resizeHandleEls: HTMLDivElement[] = [];
  /** 리사이즈 상태 (null = 비활성) */
  private _resizeState: TableResizeState | null = null;
  /** resolveTableGrid()로 계산된 정규화된 colWidths 캐시 */
  private _resolvedColWidths: number[] = [];

  /**
   * 편집 모드에서 컬럼/행 경계선에 리사이즈 핸들을 렌더링.
   * colspan/rowspan 셀이 걸친 경계는 disabled 처리.
   * @param grid - resolveTableGrid() 결과
   */
  private _renderResizeHandles(grid: GridResolution): void;

  /** mousedown → 리사이즈 시작 */
  private _startTableResize(event: MouseEvent): void;
  /** mousemove → rAF 내에서 colWidths/rowHeights 갱신 */
  private _onTableResizeMouseMove: (event: MouseEvent) => void;
  /** mouseup → 리사이즈 종료 */
  private _onTableResizeMouseUp: (event: MouseEvent) => void;
  /** ESC → 리사이즈 취소 (원래 값 복원) */
  private _onTableResizeKeyDown: (event: KeyboardEvent) => void;

  /**
   * 수직 핸들 드래그: 열 col과 col+1 너비 재분배 (총폭 유지).
   * @param col - 경계 왼쪽 열 인덱스
   * @param deltaMm - 마우스 이동량 (mm)
   */
  private _applyColumnResize(col: number, deltaMm: number): void;

  /**
   * 수평 핸들 드래그: 행 row와 row+1 높이 재분배 (총높이 유지).
   * @param row - 경계 위쪽 행 인덱스
   * @param deltaMm - 마우스 이동량 (mm)
   */
  private _applyRowResize(row: number, deltaMm: number): void;

  /** 부모 box의 boxPropertyChange 이벤트 발생 (외부 통지) */
  private _notifyTablePropertyChange(): void;

  // ─── EditManager 접근 ───
  /**
   * 부모 체인 탐색하여 LayoutDocumentElement.editManager 반환.
   * box와 동일 패턴.
   */
  get editManager(): EditManager | null;

  // ─── overlap 호환성 (섹션 8.8) ───
  /** 타입 식별자. overlap 재귀에서 parentElement.type 체크용. */
  get type(): 'table';

  /** TR 자식 배열. overlap 호환성 + 자식 순회용. */
  get items(): LayoutTableRowElement[];

  /** overlap — 부모로 재귀 전달 (table은 하나의 덩어리, 섹션 8.8). */
  get overlayElements(): LayoutBoxElement[];

  // ─── printPostData (섹션 8.9) ───
  /**
   * 인쇄 후처리용 데이터. table rect + borderEdges(셀 간 그리드 라인) + 자식 TR 재귀.
   * @returns PrintPostData[] — table 항목 + TR 항목들
   */
  get printPostData(): PrintPostData[];
}
```

```typescript
private _layoutStructure(): void {
  if (!this.isConnected) return;

  // 부모 box의 콘텐츠 폭/높이 계산
  const parentBox = this.parentElement;
  if (!(parentBox instanceof LayoutBoxElement)) {
    // 테이블은 반드시 box 내에 있어야 함
    this._gridResolution = null;
    return;
  }

  // 부모 box의 컨텐츠 영역 = absWidth - paddingLeft - paddingRight
  // (absHeight - paddingTop - paddingBottom)
  // 부모 box의 GridCalculator 또는 프로퍼티에서 읽기
  const contentWidth = parentBox.absWidth
    - (parentBox.paddingLeft ?? 0) - (parentBox.paddingRight ?? 0);
  const contentHeight = parentBox.absHeight
    - (parentBox.paddingTop ?? 0) - (parentBox.paddingBottom ?? 0);

  // 그리드 해석
  this._gridResolution = resolveTableGrid(
    this._rows,
    contentWidth,
    this._colWidths,
  );

  // 경고 → render-error 이벤트
  if (this._gridResolution.warnings.length > 0) {
    this.dispatchEvent(new CustomEvent('render-error', {
      detail: { type: 'table-grid', warnings: this._gridResolution.warnings },
    }));
  }

  // 자식 TR에 좌표 부여 (TR의 data setter 호출)
  // TR은 자체적으로 좌표를 계산하지 않고 table이 부여한 값 사용
  for (let i = 0; i < this._rows.length; i++) {
    const trEl = this.children[i] as LayoutTableRowElement | undefined;
    if (trEl && trEl.localName === 'x-layout-tr') {
      const rowData = this._rows[i];
      const rowHeight = rowData.height;
      const y = this._gridResolution.rowHeights
        .slice(0, i).reduce((sum, h) => sum + h, 0);
      trEl._setRowMetrics(y, rowHeight, contentWidth);
    }
  }
}
```

#### 6.1.2 `_renderBorder()` 상세

```typescript
private _renderBorder(): void {
  if (!this.isConnected) return;

  // 보더 해석
  this._borderResolution = this._resolveBorders();
  if (!this._borderResolution) return;

  // border-layer div 보장
  if (!this._borderLayerEl) {
    const layer = document.createElement('div');
    layer.classList.add('border-layer');
    layer.style.position = 'absolute';
    layer.style.top = '0';
    layer.style.left = '0';
    layer.style.width = '100%';
    layer.style.height = '100%';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = String(Z_INDEX_TABLE_BORDER);
    this._shadowRoot.appendChild(layer);
    this._borderLayerEl = layer;
  }

  // 엣지 diff 렌더링
  this._renderBorderLayer(this._borderResolution.edges);
}
```

#### 6.1.3 `_renderBorderLayer(edges)` 상세

```typescript
private _renderBorderLayer(edges: ResolvedBorderEdge[]): void {
  const ppm = GridCalculator.ppm;
  const colorRegistry = ColorRegistry.getInstance();
  const layer = this._borderLayerEl!;
  const newKeys = new Set<string>();

  for (const edge of edges) {
    newKeys.add(edge.key);

    // 기존 div 재사용 또는 생성
    let div = this._borderEdgeMap.get(edge.key);
    const isNew = !div || !div.isConnected;
    if (isNew) {
      div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.pointerEvents = 'none';
      layer.appendChild(div);
      this._borderEdgeMap.set(edge.key, div);
    }

    // 스타일 갱신
    const cssColor = colorRegistry.getCSSColor(edge.color);
    const widthPx = Math.ceil(edge.width * ppm);
    const lengthPx = edge.length * ppm;

    if (edge.direction === 'horizontal') {
      // 수평 엣지: top border로 표현
      div.style.left = `${edge.x * ppm}px`;
      div.style.top = `${edge.y * ppm}px`;
      div.style.width = `${lengthPx}px`;
      div.style.height = '0';
      div.style.borderTop = `${widthPx}px ${edge.style} ${cssColor}`;
      div.style.borderBottom = 'none';
      div.style.borderLeft = 'none';
      div.style.borderRight = 'none';
    } else {
      // 수직 엣지: left border로 표현
      div.style.left = `${edge.x * ppm}px`;
      div.style.top = `${edge.y * ppm}px`;
      div.style.width = '0';
      div.style.height = `${lengthPx}px`;
      div.style.borderLeft = `${widthPx}px ${edge.style} ${cssColor}`;
      div.style.borderTop = 'none';
      div.style.borderBottom = 'none';
      div.style.borderRight = 'none';
    }
  }

  // 제거된 엣지 정리
  for (const [key, div] of this._borderEdgeMap) {
    if (!newKeys.has(key)) {
      div.remove();
      this._borderEdgeMap.delete(key);
    }
  }
}
```

#### 6.1.4 `data` setter 상세

```typescript
set data(data: TableData) {
  this._rebuildingChildren = true;
  this._pendingData = data;
  try {
    if (data.id !== undefined) this.id = data.id;
    this._colWidths = data.colWidths;
    this._rows = data.children ?? [];

    // 기존 자식 reconcile (ID-keyed, box 패턴과 동일)
    const existingChildren = Array.from(this.children)
      .filter((c): c is LayoutTableRowElement =>
        c instanceof LayoutTableRowElement);
    const existingById = new Map<string, LayoutTableRowElement>();
    for (const child of existingChildren) {
      if (child.id) existingById.set(child.id, child);
    }

    const usedIds = new Set<string>();
    for (let i = 0; i < this._rows.length; i++) {
      const rowData = this._rows[i];
      const childId = rowData.id;

      if (childId && existingById.has(childId)) {
        const existingEl = existingById.get(childId)!;
        usedIds.add(childId);
        existingEl.data = rowData;
        if (existingEl !== this.children[i]) {
          this.appendChild(existingEl);
        }
      } else {
        this._appendChildData(rowData);
        if (childId) usedIds.add(childId);
      }
    }

    // 미사용 기존 요소 제거
    for (const child of existingChildren) {
      if (child.id && !usedIds.has(child.id)) {
        child.remove();
      }
    }

    this.layout();
    void this.render();
  } finally {
    this._rebuildingChildren = false;
    this._pendingData = null;
  }
}
```

### 6.2 `<x-layout-tr>` — `src/components/layout/tr.element.ts`

```typescript
export class LayoutTableRowElement extends HTMLElement {
  private _shadowRoot: ShadowRoot;
  private _styleRule?: CSSStyleRule;

  // table이 부여하는 행 메트릭
  private _y: number = 0;       // mm, 테이블 기준
  private _height: number = 0;  // mm
  private _width: number = 0;    // mm (테이블 콘텐츠 폭)

  // 행 데이터
  private _cells: TableCellData[] = [];
  private _inheritStyle?: InheritStyle;

  private _childObserver: MutationObserver | null = null;
  private _rebuildingChildren = false;
  private _pendingData: TableRowData | null = null;

  constructor();
  connectedCallback();
  disconnectedCallback();

  static get observedAttributes(): readonly string[];
  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null): void;

  get data(): TableRowData;
  set data(data: TableRowData);

  get height(): number;
  set height(value: number);

  /**
   * table이 TR에 행 메트릭을 부여하는 내부 메서드.
   * table._layoutStructure()에서 호출됨.
   * @param y - 테이블 기준 y 좌표 (mm)
   * @param height - 행 높이 (mm)
   * @param width - 테이블 콘텐츠 폭 (mm)
   */
  _setRowMetrics(y: number, height: number, width: number): void;

  layout(): void;
  async render(): Promise<void>;

  private _layoutStructure(): void;
  private _applyStyle(): void;
  private _propagateInheritStyle(): void;

  /**
   * TD 데이터를 받아 x-layout-td 요소를 생성/추가.
   */
  appendChildData(child: TableCellData): LayoutTableCellElement;
  private _appendChildData(child: TableCellData): void;
  private _serializeChildren(): TableCellData[];
  private _startChildObserver(): void;
  private _stopChildObserver(): void;
  private _onChildMutation(): void;

  get editManager(): EditManager | null;

  // ─── overlap 호환성 (섹션 8.8) ───
  /** 타입 식별자. */
  get type(): 'tr';

  /** TD 자식 배열. overlap 호환성 + 자식 순회용. */
  get items(): LayoutTableCellElement[];

  /** overlap — 부모로 재귀 전달 (table은 하나의 덩어리, 섹션 8.8). */
  get overlayElements(): LayoutBoxElement[];

  // ─── printPostData (섹션 8.9) ───
  /**
   * 인쇄 후처리용 데이터. TR 자체 항목 없음 (시각적 요소 없음), TD 재귀만.
   * @returns PrintPostData[] — TD 항목들 (TR 항목 제외)
   */
  get printPostData(): PrintPostData[];
}
```

#### 6.2.1 `_layoutStructure()` 상세

```typescript
private _layoutStructure(): void {
  if (!this.isConnected) return;

  // 자식 TD에 좌표 부여
  // TD의 좌표는 table의 _gridResolution에서 계산됨.
  // table이 TR에 _setRowMetrics로 전달한 후,
  // TR은 자신의 cells와 table의 placements를 매칭하여 TD에 메트릭 부여.
  //
  // 단, TR은 table의 gridResolution을 직접 알지 못하므로,
  // table._layoutStructure()에서 각 TD에 직접 메트릭을 부여하는 방식이 더 단순.
  // → table이 placement를 순회하며 해당 TD 요소에 _setCellMetrics() 호출.
  // TR의 _layoutStructure()는 스타일만 적용.
}
```

> **설계 결정**: TD의 메트릭(x, y, width, height)은 table이 `resolveTableGrid()` 결과에서 직접 부여한다. TR은 행의 y/height만 알고, 개별 TD 좌표는 table이 관리. 이유: gridResolution이 table에 캐시되어 있고, placement 순회가 table에서 자연스럽기 때문.

#### 6.2.2 `_applyStyle()` 상세

```typescript
private _applyStyle(): void {
  if (!this.isConnected) return;

  if (!this._styleRule) {
    const styleEl = document.createElement('style');
    this._shadowRoot.appendChild(styleEl);
    if (!styleEl.sheet) throw new Error("stylesheet is not initialized");
    styleEl.sheet.insertRule(":host { display: block; position: absolute; }", 0);
    this._styleRule = styleEl.sheet.cssRules[0] as CSSStyleRule;

    // slot 추가 (light DOM TD 투영)
    this._shadowRoot.appendChild(document.createElement('slot'));
  }

  Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
    this._styleRule.style,
    {
      position: 'absolute',
      top: `${this._y}mm`,
      left: '0',
      width: `${this._width}mm`,
      height: `${this._height}mm`,
    },
  );
}
```

### 6.3 `<x-layout-td>` — `src/components/layout/td.element.ts`

```typescript
export class LayoutTableCellElement extends HTMLElement {
  private _shadowRoot: ShadowRoot;
  private _styleRule?: CSSStyleRule;

  // 자체 GridCalculator (columns=1)
  private _model?: GridCalculator;

  // table이 부여하는 셀 메트릭
  private _x: number = 0;       // mm, 테이블 기준
  private _y: number = 0;       // mm, 테이블 기준
  private _width: number = 0;    // mm
  private _height: number = 0;   // mm

  // 셀 데이터 필드
  private _colspan: number = 1;
  private _rowspan: number = 1;
  private _borderTop?: CellBorderEdge;
  private _borderRight?: CellBorderEdge;
  private _borderBottom?: CellBorderEdge;
  private _borderLeft?: CellBorderEdge;
  private _backgroundColor?: string;
  private _backgroundOpacity?: number;
  private _diagonals?: Array<'tl-br' | 'tr-bl'>;
  private _paddingTop: number = 0;
  private _paddingRight: number = 0;
  private _paddingBottom: number = 0;
  private _paddingLeft: number = 0;
  private _children: BoxData[] = [];

  // 대각선 요소
  private _diagonalEls: HTMLDivElement[] = [];

  private _inheritStyle?: InheritStyle;

  private _childObserver: MutationObserver | null = null;
  private _rebuildingChildren = false;
  private _pendingData: TableCellData | null = null;

  private _isPrint: boolean = window.matchMedia("print").matches;

  constructor();
  connectedCallback();
  disconnectedCallback();

  static get observedAttributes(): readonly string[];
  attributeChangedCallback(name: string, _oldVal: string | null, newVal: string | null): void;

  get data(): TableCellData;
  set data(data: TableCellData);

  // ─── 속성 getter/setter ───
  get colspan(): number;
  set colspan(value: number);

  get rowspan(): number;
  set rowspan(value: number);

  get backgroundColor(): string | undefined;
  set backgroundColor(value: string | undefined);

  get backgroundOpacity(): number | undefined;
  set backgroundOpacity(value: number | undefined);

  get diagonals(): Array<'tl-br' | 'tr-bl'> | undefined;
  set diagonals(value: Array<'tl-br' | 'tr-bl'> | undefined);

  get paddingTop(): number;
  set paddingTop(value: number);
  // ... paddingRight, paddingBottom, paddingLeft 동일 패턴

  // 보더 getter (읽기 전용, table이 해석용으로 읽음)
  get borderTop(): CellBorderEdge | undefined;
  get borderRight(): CellBorderEdge | undefined;
  get borderBottom(): CellBorderEdge | undefined;
  get borderLeft(): CellBorderEdge | undefined;

  // ─── 메트릭 부여 (table이 호출) ───
  /**
   * table이 TD에 셀 메트릭을 부여하는 내부 메서드.
   * table._layoutStructure()에서 resolveTableGrid() 결과로 호출됨.
   */
  _setCellMetrics(x: number, y: number, width: number, height: number): void;

  // ─── 렌더링 파이프라인 ───
  layout(): void;
  async render(): Promise<void>;

  private _layoutStructure(): void;
  private _applyStyle(): void;
  private _renderDiagonals(): void;
  private _propagateInheritStyle(): void;

  // ─── 자식 관리 (box와 동일 패턴) ───
  /**
   * Box 데이터를 받아 x-layout-box 요소를 생성/추가.
   * box.appendChildData와 동일 시그니처.
   */
  appendChildData(child: BoxData): LayoutBoxElement;
  private _appendChildData(child: BoxData): void;
  private _serializeChildren(): BoxData[];
  private _startChildObserver(): void;
  private _stopChildObserver(): void;
  private _onChildMutation(): void;

  // ─── box-equivalent 인터페이스 ───
  /**
   * 부모 체인 탐색하여 LayoutDocumentElement.editManager 반환.
   */
  get editManager(): EditManager | null;

  // ─── overlap 호환성 (섹션 8.8) ───
  /** 타입 식별자. overlap 재귀에서 parentElement.type 체크 + i.type === 'box' 필터용. */
  get type(): 'td';

  /**
   * TD의 overlap 대상을 반환.
   * TD는 부모로 재귀를 전달 — table은 하나의 덩어리이므로 table 외부의
   * 형제/상위 box가 overlap 대상에 포함되어야 한다.
   * TD 자신의 items(TD 내 box들)은 overlay 후보에 추가하지 않는다 —
   * 이는 자식 box의 overlayElements에서 처리됨.
   */
  get overlayElements(): LayoutBoxElement[];

  /**
   * 부모 모델(TD 자체의 GridCalculator) 반환.
   * 자식 box의 _layoutStructure()에서 사용.
   */
  get model(): GridCalculator | undefined;

  /**
   * 컨텐츠 타입 식별. box와 동일 패턴.
   */
  get contentType(): 'box' | 'paragraph' | 'image' | undefined;

  /**
   * 가장 깊은 컨텐츠 요소 반환. box.contentElement와 동일.
   */
  get contentElement(): LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | LayoutTableCellElement;

  /**
   * items (자식 box 배열). box.items와 동일.
   */
  get items(): LayoutBoxElement[];

  // ─── 전략 B: box resizer 숨김 제어 ───
  /**
   * TD 내 자식 box들의 resizer 표시/숨김을 갱신.
   * TD를 꽉 채우는 box는 resizer 숨김 ([hide-resize] 속성 부여).
   * 부분 배치 box는 resizer 표시.
   * layout()에서 호출된다.
   */
  private _updateChildBoxResizeVisibility(): void;

  // ─── printPostData (섹션 8.9) ───
  /**
   * 인쇄 후처리용 데이터. TD rect + backgroundColor + diagonals + 자식 box 재귀.
   * @returns PrintPostData[] — TD 항목 + 자식 box/paragraph/image 항목들
   */
  get printPostData(): PrintPostData[];
}
```

#### 6.3.0 `isBoxFillingCell` 유틸 (전략 B)

`src/utils/table-utils.ts` (신규) 또는 `td.element.ts` 내부:

```typescript
/**
 * TD 안의 box가 TD 컨텐츠 영역을 가득 채우는지 판별.
 * 가득 채우면 box resizer를 숨김 (table resizer로 대체, 전략 B).
 *
 * @param box - TD 안의 box
 * @param td - 부모 TD
 * @returns true = TD 꽉 채움 (box resizer 숨김)
 */
function isBoxFillingCell(box: LayoutBoxElement, td: LayoutTableCellElement): boolean;
```

`src/utils/index.ts`에 export 추가.

#### 6.3.1 `_layoutStructure()` 상세

```typescript
private _layoutStructure(): void {
  if (!this.isConnected) return;

  // 자체 GridCalculator (columns=1, box와 동일 패턴)
  this._model ??= GridCalculator.create({
    element: this,
    width: 0, height: 0, columns: 1, gap: 0,
    paragraphStyle: {}, textStyle: {},
  });

  this._model.data = {
    element: this,
    paddingTop: this._paddingTop,
    paddingRight: this._paddingRight,
    paddingBottom: this._paddingBottom,
    paddingLeft: this._paddingLeft,
    columns: 1,   // ← 항상 1단. 다단은 paragraph가 재정의.
    gap: 0,
    paragraphStyle: this._inheritStyle ?? {},
    textStyle: this._inheritStyle ?? {},
    width: this._width,
    height: this._height,
  };
}
```

#### 6.3.2 `_applyStyle()` 상세

```typescript
private _applyStyle(): void {
  if (!this.isConnected) return;

  if (!this._styleRule) {
    const styleEl = document.createElement('style');
    this._shadowRoot.appendChild(styleEl);
    if (!styleEl.sheet) throw new Error("stylesheet is not initialized");

    // :host 규칙
    styleEl.sheet.insertRule(":host {}", 0);
    // 인쇄 모드에서 대각선 숨김
    styleEl.sheet.insertRule("@media print { .diagonal { display: none !important; } }", 1);

    this._styleRule = styleEl.sheet.cssRules[0] as CSSStyleRule;

    // slot 추가 (light DOM box 투영)
    this._shadowRoot.appendChild(document.createElement('slot'));
  }

  const colorRegistry = ColorRegistry.getInstance();
  Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(
    this._styleRule.style,
    {
      display: 'block',
      boxSizing: 'border-box',
      position: 'absolute',
      left: `${this._x}mm`,
      top: `${this._y}mm`,
      width: `${this._width}mm`,
      height: `${this._height}mm`,
      backgroundColor: this._backgroundColor
        ? colorRegistry.getCSSColor(this._backgroundColor) +
          colorRegistry.getOpacityHex(this._backgroundOpacity ?? 1)
        : 'transparent',
      // overflow: 'hidden', // 내용 clipping 필요 시
    },
  );
}
```

#### 6.3.3 `_renderDiagonals()` 상세

```typescript
private _renderDiagonals(): void {
  if (!this.isConnected) return;

  // 기존 대각선 제거
  for (const el of this._diagonalEls) el.remove();
  this._diagonalEls = [];

  if (!this._diagonals || this._diagonals.length === 0) return;
  if (this._isPrint) return; // 인쇄 모드에서 숨김

  const ppm = GridCalculator.ppm;
  const widthPx = this._width * ppm;
  const heightPx = this._height * ppm;

  // 대각선 색상/두께: borderTop(또는 첫 선언된 보더) 재사용
  // 또는 별도 diagonalColor 필드 사용 (설계 검토 후 결정)
  const edge = this._borderTop ?? this._borderLeft ?? this._borderRight ?? this._borderBottom;
  if (!edge) return; // 보더 없으면 대각선 색 없음

  const colorRegistry = ColorRegistry.getInstance();
  const cssColor = colorRegistry.getCSSColor(edge.color);
  const widthPx = Math.max(1, Math.ceil((edge.width ?? 1) * ppm));

  for (const dir of this._diagonals) {
    const div = document.createElement('div');
    div.classList.add('diagonal');
    div.style.position = 'absolute';
    div.style.pointerEvents = 'none';
    div.style.zIndex = String(Z_INDEX_TABLE_DIAGONAL);

    if (dir === 'tl-br') {
      // 좌상→우하: transform rotate
      const lengthPx = Math.sqrt(widthPx * widthPx + heightPx * heightPx);
      const angleRad = Math.atan2(heightPx, widthPx);
      div.style.width = `${lengthPx}px`;
      div.style.height = `${widthPx}px`;
      div.style.left = '0';
      div.style.top = '0';
      div.style.transformOrigin = 'top left';
      div.style.transform = `rotate(${angleRad}rad)`;
      div.style.backgroundColor = cssColor;
    } else {
      // tr-bl: 우상→좌하
      const lengthPx = Math.sqrt(widthPx * widthPx + heightPx * heightPx);
      const angleRad = Math.atan2(heightPx, widthPx);
      div.style.width = `${lengthPx}px`;
      div.style.height = `${widthPx}px`;
      div.style.right = '0';
      div.style.top = '0';
      div.style.transformOrigin = 'top right';
      div.style.transform = `rotate(-${angleRad}rad)`;
      div.style.backgroundColor = cssColor;
    }

    this._shadowRoot.appendChild(div);
    this._diagonalEls.push(div);
  }
}
```

#### 6.3.4 `_setCellMetrics()` 상세

```typescript
_setCellMetrics(x: number, y: number, width: number, height: number): void {
  const changed = this._x !== x || this._y !== y
    || this._width !== width || this._height !== height;
  this._x = x;
  this._y = y;
  this._width = width;
  this._height = height;
  if (changed && this.isConnected) {
    this.layout();
  }
}
```

#### 6.3.5 `data` setter 상세

```typescript
set data(data: TableCellData) {
  this._rebuildingChildren = true;
  this._pendingData = data;
  try {
    if (data.id !== undefined) this.id = data.id;
    this._colspan = data.colspan ?? 1;
    this._rowspan = data.rowspan ?? 1;
    this._borderTop = data.borderTop;
    this._borderRight = data.borderRight;
    this._borderBottom = data.borderBottom;
    this._borderLeft = data.borderLeft;
    this._backgroundColor = data.backgroundColor;
    this._backgroundOpacity = data.backgroundOpacity;
    this._diagonals = data.diagonals;
    this._paddingTop = data.paddingTop ?? 0;
    this._paddingRight = data.paddingRight ?? 0;
    this._paddingBottom = data.paddingBottom ?? 0;
    this._paddingLeft = data.paddingLeft ?? 0;
    this._children = data.children ?? [];

    // 자식 box reconcile (ID-keyed, box 패턴과 동일)
    const existingChildren = this.items;
    const existingById = new Map<string, LayoutBoxElement>();
    for (const child of existingChildren) {
      if (child.id) existingById.set(child.id, child);
    }

    const usedIds = new Set<string>();
    for (let i = 0; i < this._children.length; i++) {
      const childData = this._children[i];
      const childId = childData.id;

      if (childId && existingById.has(childId)) {
        const existingEl = existingById.get(childId)!;
        usedIds.add(childId);
        existingEl.data = childData;
        if (existingEl !== this.children[i]) {
          this.appendChild(existingEl);
        }
      } else {
        this._appendChildData(childData);
        if (childId) usedIds.add(childId);
      }
    }

    for (const child of existingChildren) {
      if (child.id && !usedIds.has(child.id)) {
        child.remove();
      }
    }

    this.layout();
    void this.render();
  } finally {
    this._rebuildingChildren = false;
    this._pendingData = null;
  }
}
```

#### 6.3.6 `appendChildData()` 상세

```typescript
appendChildData(child: BoxData): LayoutBoxElement {
  const boxEl = document.createElement('x-layout-box');
  boxEl.data = child;
  this.appendChild(boxEl);
  return boxEl;
}

private _appendChildData(child: BoxData): void {
  const boxEl = document.createElement('x-layout-box');
  boxEl.data = child;
  this.appendChild(boxEl);
}
```

#### 6.3.7 `items` / `model` / `editManager` getter

```typescript
get items(): LayoutBoxElement[] {
  return Array.from(this.children)
    .filter((c): c is LayoutBoxElement => c instanceof LayoutBoxElement);
}

get model(): GridCalculator | undefined {
  return this._model;
}

get editManager(): EditManager | null {
  let el: Element | null = this.parentElement;
  while (el) {
    if (el instanceof LayoutDocumentElement) return el.editManager;
    el = el.parentElement;
  }
  return null;
}
```

### 6.4 Custom Element 등록

#### `src/components/layout/index.ts`
```typescript
// 기존 export 유지 + 신규 추가
export * from "./table.element";
export * from "./tr.element";
export * from "./td.element";
```

각 요소 파일 하단에서 `customElements.define()`:
```typescript
// table.element.ts 하단
customElements.define('x-layout-table', LayoutTableElement);

// tr.element.ts 하단
customElements.define('x-layout-tr', LayoutTableRowElement);

// td.element.ts 하단
customElements.define('x-layout-td', LayoutTableCellElement);
```

---

## 7. 기존 요소 수정

### 7.1 `LayoutBoxElement` — table을 콘텐츠로 인식

#### `appendChildData()` 확장
```typescript
// 기존: box, paragraph, text, image 처리
// 추가: table 처리

appendChildData(child: BoxData | ParagraphData | TextData | ImageData | TableData):
    LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | LayoutTableElement {
  // ... 기존 box/paragraph/text/image 분기 ...
  else if (child.type === 'table') {
    const tableEl = document.createElement('x-layout-table');
    tableEl.data = child;
    this.appendChild(tableEl);
    this.requestRerenderAffectedParagraphs();
    return tableEl;
  }
}

private _appendChildData(child: BoxData | ParagraphData | TextData | ImageData | TableData): void {
  // ... 동일 ...
  else if (child.type === 'table') {
    const tableEl = document.createElement('x-layout-table');
    tableEl.data = child;
    this.appendChild(tableEl);
  }
}
```

#### `data` setter — 자식 reconcile 시 table 타입 인식
```typescript
// _appendChildData 및 reconcile 로직에서 child.type === 'table' 분기 추가
// targetType = child.type === 'text' ? 'paragraph' : child.type;
// existingEl.localName === 'x-layout-' + targetType
// → 'x-layout-table' 매칭
```

#### `_serializeChildren()` — table 직렬화 포함
```typescript
private _serializeChildren(): BoxData[] | ParagraphData | TextData | ImageData | TableData | undefined {
  const items = this.items.map(e => e.data).filter(e => !!e)
    as (BoxData | ParagraphData | TextData | ImageData | TableData)[];
  // ... 기존 로직 (단일/배열 반환) ...
}
```

#### `contentType` / `contentElement` — table 인식
```typescript
get contentType(): 'box' | 'paragraph' | 'image' | 'table' | undefined {
  // 기존 로직 + table 분기
  const child = this.items[0];
  if (child instanceof LayoutTableElement) return 'table';
  // ... 기존 ...
}

get contentElement(): LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | LayoutTableElement {
  // 기존 로직 + table 분기
}
```

### 7.2 `LayoutDocumentElement` — children 유니온에 TableData
`DocumentData.children` 은 `BoxData[]` 만 허용하므로 document 레벨에서 table이 직접 자식일 수 없음 (box로 감싸야 함). **수정 불필요**.

### 7.3 `LayoutBoxElement` — table 콘텐츠 영역 계산
box가 table을 콘텐츠로 가질 때, table은 box의 `absWidth - paddingLeft - paddingRight` / `absHeight - paddingTop - paddingBottom` 영역을 사용. 기존 box의 컨텐츠 영역 계산 로직이 이미 padding을 고려하므로 추가 수정 불필요. 다만, table이 box의 전체 콘텐츠 영역을 차지하므로 box의 다른 자식(paragraph 등)과 공존하지 않음을 전제.

---

## 8. 편집 시스템 통합

### 8.1 `LayoutElement` 타입 확장

`src/edit/edit-manager.ts`:
```typescript
// 변경 전:
export type LayoutElement = LayoutBoxElement;

// 변경 후:
export type LayoutElement = LayoutBoxElement | LayoutTableCellElement;
```

### 8.2 `isBoxEditable` / `isBoxSelectable` 일반화

`LayoutTableCellElement`가 box 호환 인터페이스(`editManager`, `lock`, `id`, `role`, `parentElement`)를 구현하므로, 기존 `isBoxEditable(box: LayoutBoxElement)` 시그니처를 `LayoutElement`로 확장.

```typescript
isBoxEditable(box: LayoutElement): boolean {
  if (!this._layoutEditMode) return false;
  if (this._isBoxOrAncestorLocked(box)) return false;
  if (!this._isWithinEditableRoot(box)) return false;
  // role/id 필터는 LayoutTableCellElement에서 undefined 반환 (셀은 role 없음)
  if (box instanceof LayoutBoxElement) {
    if (this._editableRoles !== null && !this._editableRoles.has(box.role)) return false;
    if (this._editableBoxIds !== null && !this._editableBoxIds.has(box.id)) return false;
  }
  return true;
}
```

### 8.3 `_isBoxOrAncestorLocked` — table/tr/td 순회

```typescript
private _isBoxOrAncestorLocked(box: LayoutElement): boolean {
  let current: Element | null = box;
  while (current) {
    if (current instanceof LayoutBoxElement && current.lock) return true;
    if (current instanceof LayoutTableCellElement && current.lock) return true;
    // table, tr은 lock 미지원 (box/TD만 lock 보유)
    current = current.parentElement;
  }
  return false;
}
```

### 8.4 LayoutSelectionController — TD 선택

TD 클릭 시 box와 동일 선택 동작. `_findSelectableBoxFromEvent` 가 `LayoutTableCellElement` 도 인식하도록 확장.

### 8.5 LayoutEditController — TD 드래그/리사이즈

- **드래그 이동**: TD 개별 이동 불가. 테이블 전체(=부모 box) 이동만 허용. TD mousedown 시 부모 box를 드래그 타겟으로 승격.
- **리사이즈**: TD 개별 리사이즈는 불가. **셀 너비/행 높이 조정은 `<x-layout-table>`이 자체 리사이즈 핸들로 처리** (섹션 8A 참조). 부모 box 리사이즈는 기존대로 동작.
- **Reparent**: TD를 다른 컨테이너로 reparent 불가 (테이블 구조 고정). TD 내부의 box는 reparent 가능.

### 8.6 InsertController — TD를 insert 타겟으로

`_findTargetContainer` 가 `LayoutTableCellElement` 도 컨테이너로 인식. TD에 box 삽입 시 `td.appendChildData(boxData)` 호출.

### 8.7 EditManager 이벤트

`layoutAdd` / `layoutRemove` / `layoutSelectionChange` 등의 이벤트에 TD 포함. TD 선택/추가/제거 시 기존 이벤트 페이로드에 TD를 `LayoutElement` 타입으로 전달. **테이블 구조 변경(colWidths/rowHeights 조정) 시 `boxPropertyChange` 이벤트**를 부모 box에 대해 발생시켜 외부(React/undo-redo)가 데이터 변경을 감지하도록 함.

### 8.8 Overlap 처리 — table을 하나의 덩어리로 처리 (중요)

table 컨테이너에서 기존 overlap 알고리즘이 올바르게 동작하도록 수정한다. 핵심 원칙: **table은 하나의 덩어리(=부모 box의 콘텐츠)로 취급**하며, table과 동급(형제)이거나 상위에 있는 image box는 table 내부 paragraph의 overlap 대상이 되어야 한다. 단, **인접 TD의 box는 overlap 대상에서 제외**한다.

#### 8.8.1 문제 분석

기존 overlap 흐름:
```
paragraph.overlayElements
  → this.parentElement(box).overlayElements  (재귀)
    → box.parentElement.overlayElements      (재귀)
      → ... → document 까지 올라감
  + this.parentElement.items 중 zIndex 높은 형제 box
```

table 컨텍스트에서의 구조:
```
TD
  box1 (paragraph, zIndex=1)
    paragraph  ← parentElement=box1
  box2 (image, zIndex=2)
    image
```

여기서 `paragraph.overlayElements`는 `box1.overlayElements`를 호출하고, `box1.parentElement`는 **TD**이다. 기존 `LayoutBoxElement.overlayElements`는 `this.parentElement.overlayElements`를 재귀적으로 호출하는데:

1. **TD에 `overlayElements` getter가 없음** → `undefined` spread → 런타임 에러.
2. **TD/TR/table에 `type` 프로퍼티가 없음** → `this.parentElement.type !== 'document'` 가 `undefined !== 'document'` = true → 재귀가 document까지 계속 올라감.
3. **TR/table에 `items` getter가 없음** → `TR.items` 접근 시 에러.
4. **인접 TD가 overlap 대상에 포함됨** → 재귀가 TR까지 올라가면 `TR.items`(=형제 TD들)이 overlay 후보로 수집됨 → 인접 TD의 box 주변으로 텍스트가 흐르려 시도 → **TD는 시각적으로 분리된 셀이므로 이는 잘못된 동작**.

#### 8.8.2 해결 방안 — table을 하나의 덩어리로, 인접 TD는 제외

**원칙**:
- TD/TR/table은 `overlayElements`에서 **부모로 재귀를 계속** 올라간다 (table 외부의 형제/상위 box를 overlap 대상에 포함).
- 인접 TD 제외는 `box.overlayElements`의 기존 `i.type === 'box'` 필터로 자동 처리 — TD/TR/table은 `type`이 `'td'`/`'tr'`/`'table'`이므로 `i.type === 'box'` 필터에서 제외됨.
- table의 형제 box(동급)는 overlap 대상에 포함되어야 하므로, table의 부모 box에서 `items`를 순회할 때 table 자신(`type === 'table'`)은 제외되지만 **table의 형제 box들(`type === 'box'`)은 포함**됨.

**수정 1: TD/TR/table에 `type` 프로퍼티 추가**

`box.overlayElements` 내부 `this.parentElement.type !== 'document'` 체크 및 `i.type === 'box'` 필터를 위해:
```typescript
// LayoutTableCellElement
get type(): 'td' { return 'td'; }

// LayoutTableRowElement
get type(): 'tr' { return 'tr'; }

// LayoutTableElement
get type(): 'table' { return 'table'; }
```

이제:
- `box.parentElement.type`이 `'td'`이므로 `!== 'document'` = true → 재귀 계속.
- `box.overlayElements`의 `this.parentElement.items.filter(i => i.type === 'box')`에서 TD/TR/table은 `type !== 'box'`이므로 자동 제외 → 인접 TD의 box가 overlay 후보에서 제외됨.

**수정 2: TD/TR/table에 `overlayElements` getter 추가 (재귀 허용)**

TD/TR/table은 부모로 재귀를 계속 올라가되, 자신의 `items`에서 overlay 대상을 추가하지 않는다 (TD/TR/table은 컨테이너이며, 그 안의 box는 자식 box의 `overlayElements`에서 처리됨).

```typescript
// LayoutTableCellElement
/**
 * TD의 overlap 대상을 반환.
 * TD는 overlap 재귀를 부모로 계속 전달한다 — table은 하나의 덩어리이므로
 * table 외부의 형제/상위 box가 overlap 대상에 포함되어야 한다.
 * TD 자신의 items(TD 내 box들)은 overlay 후보에 추가하지 않는다 —
 * 이는 자식 box의 overlayElements에서 처리됨.
 *
 * @returns 부모(TR)의 overlayElements (재귀)
 */
get overlayElements(): LayoutBoxElement[] {
  if (!this.parentElement) return [];
  // 부모로 재귀 — TD 자신의 items는 추가하지 않음
  // (자식 box의 overlayElements가 TD.items를 처리함)
  return (this.parentElement as HTMLElement & { overlayElements?: LayoutBoxElement[] }).overlayElements ?? [];
}
```

```typescript
// LayoutTableRowElement
/**
 * TR의 overlap 대상을 반환.
 * 부모(table)로 재귀 전달.
 */
get overlayElements(): LayoutBoxElement[] {
  if (!this.parentElement) return [];
  return (this.parentElement as HTMLElement & { overlayElements?: LayoutBoxElement[] }).overlayElements ?? [];
}
```

```typescript
// LayoutTableElement
/**
 * table의 overlap 대상을 반환.
 * 부모(box)로 재귀 전달. table은 하나의 덩어리이므로
 * table 외부의 형제/상위 box가 overlap 대상에 포함됨.
 */
get overlayElements(): LayoutBoxElement[] {
  if (!this.parentElement) return [];
  return (this.parentElement as HTMLElement & { overlayElements?: LayoutBoxElement[] }).overlayElements ?? [];
}
```

> **설계 의도**: TD/TR/table은 `overlayElements`에서 부모로 재귀만 전달하고, 자신의 `items`는 overlay 후보에 추가하지 않는다. 이는 기존 `box.overlayElements`의 `this.parentElement.items.filter(i => i.type === 'box')`가 box 형제만 필터링하므로, TD/TR/table의 items(=TD/TR)는 `type !== 'box'`로 자동 제외되기 때문. 단, **table의 부모 box**에서 table의 형제 box들은 `type === 'box'`이므로 overlay 후보에 포함됨 → table 외부의 image box가 table 내 paragraph의 overlap 대상이 됨.

**수정 3: TR/table에 `items` getter 추가**

`box.overlayElements`에서 `this.parentElement.items` 접근 시 필요 (TD/TR/table이 parentElement인 경우):

```typescript
// LayoutTableRowElement
/**
 * TR의 자식 TD 배열.
 */
get items(): LayoutTableCellElement[] {
  return Array.from(this.children)
    .filter((c): c is LayoutTableCellElement => c instanceof LayoutTableCellElement);
}
```

```typescript
// LayoutTableElement
/**
 * table의 자식 TR 배열.
 */
get items(): LayoutTableRowElement[] {
  return Array.from(this.children)
    .filter((c): c is LayoutTableRowElement => c instanceof LayoutTableRowElement);
}
```

> **주의**: TD의 `items`는 이미 섹션 6.3에 정의됨 (자식 box 배열). TR/table의 `items`는 TD/TR을 반환하며, 이들은 `type !== 'box'`이므로 `box.overlayElements`의 필터에서 자동 제외됨.

#### 8.8.3 수정 후 overlap 흐름 (table 컨텍스트)

```
paragraph (TD 내 box1 내부)
  └→ paragraph.overlayElements
       └→ box1.overlayElements
            └→ box1.parentElement(TD).overlayElements
                 └→ TD.parentElement(TR).overlayElements
                      └→ TR.parentElement(table).overlayElements
                           └→ table.parentElement(부모 box).overlayElements  ← 기존 재귀 진입
                                └→ 부모 box.parentElement.overlayElements (계속)
                                + 부모 box.parentElement.items 중 zIndex 높은 형제 box
                                  → table의 형제 box(image 등) 포함 ✓
            + box1.parentElement(TD).items 중 zIndex > box1.zIndex이고 type === 'box'인 box
              → 같은 TD 내의 box2(image) 포함 ✓
              → TD 자신은 type === 'td'이므로 제외 ✓
       → 결과: [box2(같은 TD 내 image), 형제 box(table 외부 image), ...]

같은 TD 내 image box → overlap 대상 ✓
table 외부(형제/상위) image box → overlap 대상 ✓ (table은 하나의 덩어리)
인접 TD의 box → overlap 대상에서 제외 ✓ (TR.items의 TD는 type !== 'box'로 필터)
```

#### 8.8.4 `getOverlapSizePX` 호환성

`getOverlapSizePX`는 `targetElement.contentType === 'image'` 체크 후 `contentElement`로 canvas 접근. TD 내 box가 image를 감싸는 경우:
- `box.contentType` → `'image'` (기존 box 패턴)
- `box.contentElement` → `LayoutImageElement` (기존 box 패턴)
- `imageEl.canvas`, `imageEl.overlapPadding` → 기존 동작

TD 내 box는 기존 `LayoutBoxElement` 인스턴스이므로 `contentType`/`contentElement`/`overlayElements`가 모두 기존 동작을 그대로 수행. **추가 수정 불필요**. `getOverlapSizePX`의 시그니처(`targetElement: LayoutBoxElement`)도 TD 내 box는 `LayoutBoxElement`이므로 그대로 호환. table 외부의 image box도 `LayoutBoxElement`이므로 호환.

#### 8.8.5 `_collectAffectedParagraphs` 호환성

`LayoutBoxElement._collectAffectedParagraphs()`는 box 이동/리사이즈 시 영향받는 paragraph를 수집. box가 TD 내부에 있는 경우:
- `box.parentElement` = TD (`LayoutTableCellElement`)
- `this.parentElement.items` → TD의 items (같은 TD 내 box들)
- 형제 box 순회 → `_collectParagraphs` 재귀

기존 `_collectParagraphs`는 `element.type` 체크:
```typescript
if (element.type === 'paragraph') { ... }
if (element.type === 'box') { ... }
```

TD 내 box는 `type === 'box'`이므로 정상 동작. **추가 수정 불필요**. 단, TD 자신이 이동하는 경우(=table 리사이즈)의 paragraph 수집은 table 리사이즈 핸들러가 `this.layout()` → TD `_setCellMetrics()` → TD `layout()` → box `layout()` → paragraph `render()` 체인으로 처리 (8A.13 참조).

**table 외부 box 이동 시 table 내 paragraph 수집**: table 외부의 box가 이동하여 table과 overlap하게 되면, `_collectAffectedParagraphs`가 table 내부까지 수집해야 함. 이를 위해 `_collectParagraphs`에 table/TR/TD 재귀 처리 추가:
```typescript
// _collectParagraphs 확장 (box.element.ts 수정)
if (element.type === 'box') {
  for (const child of (element as LayoutBoxElement).items) {
    this._collectParagraphs(child, set);
  }
}
// 추가: table 타입 처리
if (element.type === 'table') {
  for (const tr of (element as LayoutTableElement).items) {
    for (const td of tr.items) {
      for (const box of td.items) {
        this._collectParagraphs(box, set);
      }
    }
  }
}
```

#### 8.8.6 검증 시나리오

| 시나리오 | 기대 동작 | 검증 방법 |
|---|---|---|
| TD 내 image box + paragraph box | paragraph가 같은 TD 내 image 주변으로 흐름 | 텍스트가 image 영역 회피 |
| 인접 TD에 image box | paragraph가 인접 TD image 주변으로 흐르지 않음 | 텍스트가 TD 경계 내에서만 렌더링 |
| **table 외부(형제)에 image box** | **paragraph가 table 외부 image 주변으로 흐름** | **table 전체가 하나의 덩어리로 image overlap 적용** |
| **table 상위(box 조상)에 image box** | **paragraph가 상위 image 주변으로 흐름** | **재귀적으로 상위 box까지 overlap 적용** |
| TD 내 복수 box (image + paragraph) | paragraph가 같은 TD 내 image 주변으로 흐름 | overlap 정상 동작 |
| 중첩 테이블 (TD 내 table) | 중첩 테이블 내 paragraph가 중첩 TD 내 image + 외부 image 모두 주변으로 흐름 | 재귀 동작 |

### 8.9 PrintPostData — 인쇄 후처리용 데이터 추출 (중요)

table/TR/TD가 `printPostData` getter를 구현하여 기존 box의 `printPostData` 재귀 체인에 통합된다. 인쇄 후처리 시스템이 table 구조(보더 레이어, 셀 배경, 대각선)와 내부 box/paragraph/image의 절대 위치를 모두 수집할 수 있도록 한다.

#### 8.9.1 기존 `printPostData` 패턴

기존 `LayoutBoxElement.printPostData`:
```typescript
get printPostData() {
  const data: PrintPostData[] = [];
  const rect = this.getBoundingClientRect();
  // 자신의 rect + borderColor + backgroundColor + data를 push
  data.push({ color, backgroundColor, backgroundOpacity, data: this.data, rect });
  // 자식들을 zIndex 오름차순 정렬 후 재귀
  const sortedItems = [...this.items].sort((a, b) => a.zIndex - b.zIndex);
  for (const item of sortedItems) {
    data.push(...item.printPostData);  // ← table/TR/TD도 여기에 포함되어야 함
  }
  return data;
}
```

모든 rect는 `getBoundingClientRect()` 기반 **절대 픽셀 좌표**(viewport + scroll). TD 내 box는 TD 기준 상대 위치로 렌더링되지만 `getBoundingClientRect()`가 이미 절대 좌표를 반환하므로 **추가 변환 불필요**.

#### 8.9.2 문제: table/TR/TD에 `printPostData` getter 없음

box의 `sortedItems` 순회 시 `item.printPostData`에 접근하는데, table이 box의 자식(`BoxData.children`에 `TableData` 포함)이 되면:
- `item`이 `LayoutTableElement`인 경우 → `printPostData` 없음 → `undefined` spread → 에러.
- TD 내 box의 `sortedItems`에는 box/paragraph/image만 있으므로 TD 자체는 순회 대상이 아님. 단, TD가 box의 `items`에 포함되는 경우는 없음 (TD는 항상 TR의 자식).

따라서 **table에 `printPostData` getter가 필수**이며, TR/TD도 table의 재귀 체인에 포함되어야 함.

#### 8.9.3 `PrintPostData` 타입 확장

`PrintPostData`의 제네릭 `T`에 `TableData`/`TableRowData`/`TableCellData` 추가:

```typescript
// src/types/print/post-data.type.ts 수정
export type PrintPostData<T = BoxData | ImageData | ParagraphData | TableData | TableRowData | TableCellData> = {
  color?: CMYKColor;
  backgroundColor?: CMYKColor;
  backgroundOpacity?: number;
  data: T;
  rect: PrintPostDataRect;
  chars?: PrintPostDataChar[];
  // ─── 테이블 전용 필드 (data.type === 'table' | 'td'인 경우) ───
  /**
   * 테이블 보더 엣지 정보.
   * `data.type === 'table'`인 경우에만 사용.
   * resolveTableBorders()로 해석된 엣지들의 절대 픽셀 좌표 + 색상/두께/스타일.
   * 인쇄 후처리 시스템이 테이블 그리드 라인을 재현할 때 사용.
   */
  borderEdges?: PrintPostBorderEdge[];
  /**
   * 셀 대각선 정보.
   * `data.type === 'td'`인 경우에만 사용.
   * 인쇄 후처리 시스템이 셀 내 대각선을 재현할 때 사용.
   */
  diagonals?: PrintPostDiagonal[];
};
```

신규 타입:
```typescript
/** 인쇄용 보더 엣지 정보 (절대 픽셀 좌표) */
export type PrintPostBorderEdge = {
  direction: 'horizontal' | 'vertical';
  x: number;  // 픽셀 (절대)
  y: number;  // 픽셀 (절대)
  length: number;  // 픽셀
  width: number;  // 보더 두께 (픽셀)
  color: CMYKColor;
  style: 'solid' | 'dotted' | 'dashed';
};

/** 인쇄용 대각선 정보 (절대 픽셀 좌표) */
export type PrintPostDiagonal = {
  direction: 'tl-br' | 'tr-bl';
  x1: number; y1: number;  // 시작점 (픽셀, 절대)
  x2: number; y2: number;  // 끝점 (픽셀, 절대)
  width: number;  // 선 두께 (픽셀)
  color: CMYKColor;
};
```

#### 8.9.4 `LayoutTableElement.printPostData`

```typescript
get printPostData(): PrintPostData[] {
  const data: PrintPostData[] = [];
  if (this._isPrint) {
    // 인쇄 모드에서는 table 자체가 숨김 처리되므로 rect가 0일 수 있음.
    // 단, 자식 TD/box의 rect는 정상이므로 재귀는 수행.
  }

  const ppm = GridCalculator.ppm;
  const colorRegistry = ColorRegistry.getInstance();
  const tableRect = this.getBoundingClientRect();

  // 1. table 자체의 PrintPostData (보더 레이어 + data)
  // table은 box 필드(backgroundColor 등)를 가지지 않으므로,
  // table 자체의 배경/외곽 border는 부모 box가 담당.
  // table의 printPostData는 보더 엣지(셀 간 그리드 라인)만 제공.
  const borderEdges: PrintPostBorderEdge[] = [];
  if (this._borderResolution) {
    for (const edge of this._borderResolution.edges) {
      borderEdges.push({
        direction: edge.direction,
        x: tableRect.x + window.scrollX + edge.x * ppm,
        y: tableRect.y + window.scrollY + edge.y * ppm,
        length: edge.length * ppm,
        width: Math.ceil(edge.width * ppm),
        color: colorRegistry.get(edge.color),
        style: edge.style,
      });
    }
  }

  data.push({
    data: this.data,  // TableData
    rect: {
      x: tableRect.x + window.scrollX,
      y: tableRect.y + window.scrollY,
      width: tableRect.width,
      height: tableRect.height,
    },
    borderEdges: borderEdges.length > 0 ? borderEdges : undefined,
  });

  // 2. 자식 TR 재귀 (zIndex 순서 무관 — TR은 DOM 순서)
  for (const tr of this.items) {
    data.push(...tr.printPostData);
  }

  return data;
}
```

#### 8.9.5 `LayoutTableRowElement.printPostData`

```typescript
get printPostData(): PrintPostData[] {
  const data: PrintPostData[] = [];
  // TR 자체는 렌더링 요소가 아니므로 자신의 PrintPostData를 push하지 않음.
  // 자식 TD 재귀만 수행.
  for (const td of this.items) {
    data.push(...td.printPostData);
  }
  return data;
}
```

> TR은 시각적 요소가 없으므로(배경/보더 없음) `PrintPostData`에 자신의 항목을 추가하지 않는다. TD 재귀만 전달.

#### 8.9.6 `LayoutTableCellElement.printPostData`

```typescript
get printPostData(): PrintPostData[] {
  const data: PrintPostData[] = [];
  const rect = this.getBoundingClientRect();
  const colorRegistry = ColorRegistry.getInstance();

  // 1. TD 자체의 PrintPostData (배경색 + 대각선 + data)
  const diagonals: PrintPostDiagonal[] = [];
  if (this._diagonals && this._diagonals.length > 0) {
    const ppm = GridCalculator.ppm;
    const edge = this._borderTop ?? this._borderLeft ?? this._borderRight ?? this._borderBottom;
    if (edge) {
      const color = colorRegistry.get(edge.color);
      const widthPx = Math.max(1, Math.ceil((edge.width ?? 1) * ppm));
      const x1 = rect.x + window.scrollX;
      const y1 = rect.y + window.scrollY;
      const x2 = x1 + rect.width;
      const y2 = y1 + rect.height;
      for (const dir of this._diagonals) {
        if (dir === 'tl-br') {
          diagonals.push({ direction: 'tl-br', x1, y1, x2, y2, width: widthPx, color });
        } else {
          diagonals.push({ direction: 'tr-bl', x1: x2, y1, x2: x1, y2, width: widthPx, color });
        }
      }
    }
  }

  data.push({
    backgroundColor: this._backgroundColor
      ? colorRegistry.get(this._backgroundColor)
      : undefined,
    backgroundOpacity: this._backgroundOpacity,
    data: this.data,  // TableCellData
    rect: {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
    },
    diagonals: diagonals.length > 0 ? diagonals : undefined,
  });

  // 2. 자식 box 재귀 (zIndex 오름차순 — 기존 box 패턴과 동일)
  const sortedItems = [...this.items].sort((a, b) => a.zIndex - b.zIndex);
  for (const item of sortedItems) {
    data.push(...item.printPostData);
  }

  return data;
}
```

#### 8.9.7 절대 위치 보장

TD 내 box의 `getBoundingClientRect()`는 viewport 기준 절대 좌표를 반환. table/TR/TD의 `position: absolute` + mm 단위 CSS가 누적되어도 `getBoundingClientRect()`가 최종 렌더링 위치를 정확히 반환하므로, **TD 내 box/paragraph/image의 `printPostData` rect는 자동으로 절대 위치**가 됨. 추가 변환 불필요.

```
부모 box.rect (절대) → table.rect (절대) → TR.rect (절대) → TD.rect (절대) → TD 내 box.rect (절대)
```

각 요소의 `getBoundingClientRect()`가 CSS `position: absolute` + `top`/`left` 누적을 반영하여 viewport 기준 절대 좌표를 반환. `window.scrollX`/`window.scrollY`를 더해 document 기준 절대 좌표로 변환 (기존 box 패턴과 동일).

#### 8.9.8 `ColorRegistry.get()` 호환성

기존 `ColorRegistry.get(colorName)` 는 CMYK 이름 → `CMYKColor` 변환. table 보더/대각선/셀 배경의 `color` 필드는 `ColorRegistry` 이름을 사용하므로 그대로 호환. `get()`이 등록되지 않은 이름에 대해 폴백 값을 반환하는지 확인 필요 (기존 box `printPostData`가 `colorRegistry.get(this.borderColor)`를 사용하므로 동일 동작).

#### 8.9.9 box의 `sortedItems` 순회 수정

`LayoutBoxElement.printPostData`의 `sortedItems` 순회 시 table이 포함되어야 함. 기존 코드:
```typescript
const sortedItems = [...this.items].sort((a, b) => a.zIndex - b.zIndex);
for (const item of sortedItems) {
  data.push(...item.printPostData);
}
```

`this.items`는 `LayoutBoxElement[]`를 반환하므로 table은 포함되지 않음. **table도 순회 대상에 포함**하도록 수정:

```typescript
// box.printPostData 수정
const allChildren = Array.from(this.children)
  .filter((c): c is HTMLElement & { printPostData: PrintPostData[]; zIndex: number } =>
    c instanceof LayoutBoxElement || c instanceof LayoutTableElement
    || c instanceof LayoutParagraphElement || c instanceof LayoutImageElement
  );
const sortedChildren = allChildren.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
for (const child of sortedChildren) {
  data.push(...child.printPostData);
}
```

> **대안**: `items` getter가 table도 포함하도록 확장. 단, 기존 `items`는 `LayoutBoxElement[]`를 반환하므로 시그니처 변경이 필요. 또는 `printPostData` 내부에서만 `Array.from(this.children)`로 직접 순회. **권장**: `printPostData` 내부에서 `Array.from(this.children)`로 직접 순회하여 `items` 시그니처 변경 최소화.

#### 8.9.10 검증 시나리오

| 시나리오 | 기대 동작 | 검증 방법 |
|---|---|---|
| table의 `printPostData` | table rect + borderEdges 포함 | borderEdges 배열에 셀 간 그리드 라인 정보 |
| TD의 `printPostData` | TD rect + backgroundColor + diagonals 포함 | 배경색/대각선 정보 포함 |
| TR의 `printPostData` | TR 자체 항목 없음, TD 재귀만 | TR 항목은 0개, TD 항목들 포함 |
| TD 내 box의 `printPostData` | 절대 위치 rect | getBoundingClientRect() 기반 절대 좌표 |
| TD 내 paragraph의 `printPostData` | 절대 위치 rect + chars | 글자별 절대 위치 |
| TD 내 image의 `printPostData` | 절대 위치 rect | 이미지 절대 위치 |
| 중첩 테이블 | 중첩 TD 내 box도 절대 위치 | 재귀 동작 |
| 인쇄 모드 | table 보더/대각선은 `@media print`로 숨김, `printPostData`는 정보 제공 | `printPostData`는 인쇄 모드에서도 호출됨 |

---

## 8A. 테이블 셀/행 리사이즈 (Layout Edit Mode)

layout 편집 모드에서 마우스로 **셀 너비(colWidths)와 행 높이(rowHeights)를 조정**하는 기능. 기존 box의 `.resize-handle` + `BoxResizeState` 패턴과 동일한 아키텍처를 사용하되, box가 아닌 **테이블 그리드 메트릭**을 조작한다.

### 8A.0 핸들 중첩 문제 해결 전략 (B+C 조합)

TD 안에 box가 들어가면 box의 resize-handle이 TD 테두리(=table 경계선)에 위치하여 table 리사이즈 핸들과 중첩된다. 또한 box가 TD를 덮어 table을 직접 선택하기 어렵다. 이를 해결하기 위해 **전략 B(TD를 채우는 box의 resizer 비활성화) + 전략 C(계층적 선택 모델)** 을 조합한다.

#### 전략 B: TD를 채우는 box의 resizer 자동 비활성화

TD 안의 box가 TD 컨텐츠 영역을 가득 채우는 배치일 때, 해당 box의 resize-handle을 숨긴다. box 크기는 TD(=table 그리드)에 종속되므로 box 자체 리사이즈는 무의미하며, table 리사이즈 핸들로 대체한다.

**"TD 꽉 채움" 판별 알고리즘**:

```typescript
/**
 * TD 안의 box가 TD 컨텐츠 영역을 가득 채우는지 판별.
 * 가득 채우면 box resizer를 숨김 (table resizer로 대체).
 *
 * @param box - TD 안의 box
 * @param td - 부모 TD
 * @returns true = TD 꽉 채움 (box resizer 숨김)
 */
function isBoxFillingCell(box: LayoutBoxElement, td: LayoutTableCellElement): boolean {
  const tdModel = td.model;
  if (!tdModel) return false;

  if (box.position === 'static') {
    // static: width = 컬럼 span 수. TD 컬럼 수와 일치하고 height = TD 높이이면 꽉 채움
    const tdColCount = tdModel.columnCount;
    const tdContentHeight = tdModel.contentHeight;
    return box.width === tdColCount
      && Math.abs(box.absHeight - tdContentHeight) < 0.1; // mm 오차 0.1mm
  } else {
    // absolute: box width/height가 TD 컨텐츠 영역과 일치하면 꽉 채움
    const tdContentWidth = tdModel.editableWidth;
    const tdContentHeight = tdModel.editableHeight;
    return Math.abs(box.width - tdContentWidth) < 0.1
      && Math.abs(box.height - tdContentHeight) < 0.1
      && Math.abs(box.left) < 0.1
      && Math.abs(box.top) < 0.1;
  }
}
```

**box resizer 숨김/표시 제어**:

`LayoutBoxElement`에 `[hide-resize]` 속성 추가. CSS 규칙:
```css
@media screen {
  :host([hide-resize]) .resize-handle { display: none !important; }
}
```

TD의 `layout()` 시 자식 box마다 `isBoxFillingCell` 판별 → `true`면 box에 `[hide-resize]` 속성 부여, `false`면 제거. box가 TD를 꽉 채우지 않는 경우(복수 box, 부분 배치 absolute box)는 resizer 유지.

#### 전략 C: 계층적 선택 모델 + table resizer 항상 표시

**table resizer는 선택 여부와 무관하게 편집 모드에서 항상 표시**. box resizer는 box 선택 시에만 표시 (기존 방식 유지). table resizer의 z-index를 box resizer보다 높게 설정하여, 겹치는 영역에서 table resizer가 클릭 우선권을 가짐.

| 상태 | table resizer | box resizer |
|---|---|---|
| 편집 모드 진입 (미선택) | 표시 | 숨김 |
| box 선택 (TD 꽉 채움) | 표시 | 숨김 (`[hide-resize]`) |
| box 선택 (부분 배치) | 표시 | 표시 (별도 영역) |
| table 선택 | 표시 | 숨김 |

**z-index 우선순위**:
```
Z_INDEX_TABLE_RESIZE (99992) > Z_INDEX_RESIZE_HANDLE (99999)
```
> **주의**: `Z_INDEX_RESIZE_HANDLE`은 99999로 기존 예약값. table resizer를 별도 레이어(`.table-resize-layer`)에서 `pointer-events: auto`로 관리하므로, 동일 z-index여도 레이어가 box shadow root 외부(table shadow root)에 있으면 DOM 순서상 우선. 단, box resizer가 table resizer와 시각적으로 겹칠 때 클릭 우선권을 보장하려면 table resizer 레이어를 **box보다 나중에 렌더링되는 위치**에 배치하거나, 명시적으로 더 높은 z-index를 사용. 기존 `Z_INDEX_RESIZE_HANDLE`(99999)은 box shadow root 내부이고 `Z_INDEX_TABLE_RESIZE`(99992)는 table shadow root 내부이므로, **서로 다른 shadow root**에 있어 z-index 직접 비교가 무의미. 대신 **DOM 트리 순서와 shadow root 호스트 요소의 z-index** 로 결정. table이 box의 부모이거나 형제이므로, table의 `:host` z-index를 box보다 높게 설정하거나, `pointer-events` 제어로 클릭 우선권 확보.
>
> **실용적 해결**: table resizer 레이어의 `pointer-events: auto` 핸들이 box 위에 시각적으로 표시되어야 하므로, table `:host`에 `z-index`를 box보다 높게 부여하거나, box가 `[hide-resize]` 상태일 때 resizer가 없으므로 중첩 자체가 발생하지 않음. **전략 B가 중첩을 원천 제거하므로 z-index 충돌은 대부분 해결됨**. 부분 배치 box의 resizer는 TD 테두리와 떨어져 있으므로 table resizer와 중첩하지 않음.

#### 동작 흐름 예시

```
시나리오: 3×2 테이블, 각 TD에 box 1개씩 (TD 꽉 채움)

1. 편집 모드 진입
   → table resizer 표시 (수직 2개, 수평 1개)
   → box resizer 숨김 (TD 꽉 채운 box → [hide-resize])

2. 사용자가 수직 핸들 드래그
   → colWidths 재분배, TD 크기 변경, box 자동으로 TD에 맞춰 리사이즈

3. 사용자가 특정 box 클릭 (선택)
   → box resizer 숨김 유지 (TD 꽉 채운 상태 → [hide-resize])
   → table resizer 유지 (항상 표시)
   → box 드래그 이동은 가능

4. 사용자가 TD 안에 새 box 삽입 (InsertController)
   → TD 안에 box 2개 → 기존 box + 새 box 모두 TD 꽉 채우지 않음
   → [hide-resize] 제거 → box resizer 표시
   → table resizer 유지 (별도 영역, 중첩 없음)
```

### 8A.1 리사이즈 핸들

테이블 shadow root에 **별도 핸들 레이어**(`.table-resize-layer`)를 border-layer 위에 배치. 두 종류 핸들:

| 핸들 종류 | 위치 | 방향 | 조작 대상 | 커서 |
|---|---|---|---|---|
| 수직 핸들 (`data-handle="v-{col}"`) | 컬럼 경계선(열 c와 c+1 사이) | 세로 | `colWidths[c]` ↔ `colWidths[c+1]` 재분배 | `ew-resize` |
| 수평 핸들 (`data-handle="h-{row}"`) | 행 경계선(행 r과 r+1 사이) | 가로 | `rowHeights[r]` ↔ `rowHeights[r+1]` 재분배 | `ns-resize` |

**핸들 표시 조건** (전략 C: 항상 표시):
- `layoutEditMode === true` (편집 모드에서만)
- 부모 box가 `editableLayout` 속성 보유 (기존 box와 동일)
- **table 선택 여부와 무관하게 항상 표시**
- 인쇄 모드에서는 미표시 (`@media print` 로 숨김)

**핸들 비활성화 조건**:
- `colspan`/`rowspan` 셀이 해당 경계선에 걸쳐 있는 경우 → 해당 핸들 비활성화(opacity 0.3, `pointer-events: none`). 두 인접 컬럼/행이 동일 셀에 병합되어 있으면 경계를 이동할 수 없음.
- 부모 box 또는 조상이 `lock`인 경우 → 모든 핸들 비활성화.

### 8A.2 핸들 렌더링 — `LayoutTableElement._renderResizeHandles()`

```typescript
/**
 * 테이블 그리드 경계선에 리사이즈 핸들을 렌더링한다.
 * 편집 모드일 때만 호출된다.
 *
 * 핸들 위치 계산:
 * - 수직 핸들: 열 c의 오른쪽 경계 x = sum(colWidths[0..c]).
 *   핸들 영역: x ± HIT_WIDTH/2, y=0, height=총 테이블 높이.
 * - 수평 핸들: 행 r의 아래쪽 경계 y = sum(rowHeights[0..r]).
 *   핸들 영역: y ± HIT_WIDTH/2, x=0, width=총 테이블 너비.
 *
 * HIT_WIDTH = 8px (기존 box resize-handle과 동일).
 *
 * @param grid - resolveTableGrid() 결과 (활성 핸들 판별용)
 */
private _renderResizeHandles(grid: GridResolution): void;
```

#### 핸들 DOM 구조
```html
<!-- shadow root 내부 -->
<div class="table-resize-layer">
  <!-- 수직 핸들: 각 컬럼 경계 -->
  <div class="table-resize-handle" data-handle="v-0" style="left:60px; top:0; width:8px; height:120px; cursor:ew-resize"></div>
  <div class="table-resize-handle" data-handle="v-1" style="left:100px; ..."></div>
  <!-- 수평 핸들: 각 행 경계 -->
  <div class="table-resize-handle" data-handle="h-0" style="top:50px; left:0; width:200px; height:8px; cursor:ns-resize"></div>
  <div class="table-resize-handle" data-handle="h-1" style="top:100px; ..."></div>
</div>
```

CSS 규칙 (`styleEl.sheet.insertRule()`):
```css
@media screen {
  .table-resize-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 99992; }
}
@media screen {
  .table-resize-handle { position: absolute; pointer-events: auto; display: none; }
}
@media screen {
  :host([editable-layout]) .table-resize-handle { display: block; }
}
@media screen {
  .table-resize-handle[disabled] { opacity: 0.3; pointer-events: none; }
}
@media print {
  .table-resize-layer { display: none !important; }
}
```

#### 활성 핸들 판별 알고리즘

```
function getActiveVerticalHandles(grid):
  // colspan 셀이 걸친 열 경계는 비활성
  disabledCols = Set<number>
  for p in grid.placements:
    if p.spanCols > 1:
      // 셀이 gridCol..gridCol+spanCols-1 을 점유
      // 내부 경계 (gridCol+1 .. gridCol+spanCols-1) 비활성
      for c in range(p.gridCol + 1, p.gridCol + p.spanCols):
        disabledCols.add(c)

  activeHandles = []
  for c in 1 to grid.colCount - 1:  // 1~colCount-1 (첫 열 왼쪽/마지막 열 오른쪽은 테이블 외곽=부모 box 담당)
    disabled = disabledCols.has(c)
    activeHandles.push({ col: c, disabled })
  return activeHandles

function getActiveHorizontalHandles(grid):
  // rowspan 셀이 걸친 행 경계는 비활성
  disabledRows = Set<number>
  for p in grid.placements:
    if p.spanRows > 1:
      for r in range(p.gridRow + 1, p.gridRow + p.spanRows):
        disabledRows.add(r)

  activeHandles = []
  for r in 1 to grid.rowCount - 1:
    disabled = disabledRows.has(r)
    activeHandles.push({ row: r, disabled })
  return activeHandles
```

### 8A.3 리사이즈 상태 — TableResizeState

`LayoutTableElement`가 자체적으로 리사이즈 상태를 관리 (LayoutEditController가 box 리사이즈를 관리하는 것과 대응되지만, 테이블 메트릭은 table이 소유하므로 table이 관리).

```typescript
interface TableResizeState {
  /** 리사이즈 중인지 */
  isResizing: boolean;
  /** 핸들 종류: 'v-{col}' (수직) | 'h-{row}' (수평) */
  handle: string | null;
  /** 3px 임계값 통과 여부 */
  moved: boolean;
  /** 시작 마우스 X (clientX) */
  startMouseX: number;
  /** 시작 마우스 Y (clientY) */
  startMouseY: number;
  /** 시작 시 colWidths 스냅샷 (수직 핸들용) */
  startColWidths: number[];
  /** 시작 시 rowHeights 스냅샷 (수평 핸들용) */
  startRowHeights: number[];
  /** rAF용 최신 clientX */
  lastClientX: number;
  /** rAF용 최신 clientY */
  lastClientY: number;
  /** requestAnimationFrame ID */
  rafId: number | null;
}
```

### 8A.4 리사이즈 시작 — `_startTableResize(event)`

`<x-layout-table>`에 mousedown 이벤트 리스너 추가. `composedPath()`로 핸들 요소 탐색 (기존 `_getResizeHandle` 패턴).

```typescript
private _startTableResize(event: MouseEvent): void {
  // 편집 모드 + lock 체크
  const editManager = this.editManager;
  if (!editManager?.layoutEditMode) return;
  if (this._isPrint) return;
  const parentBox = this.parentElement;
  if (parentBox instanceof LayoutBoxElement && parentBox.lock) return;
  if (parentBox instanceof LayoutBoxElement && !parentBox.editableLayout) return;

  // 핸들 요소 탐색
  let handleEl: HTMLElement | null = null;
  for (const el of event.composedPath()) {
    if (el instanceof HTMLElement && el.classList.contains('table-resize-handle')) {
      handleEl = el;
      break;
    }
  }
  if (!handleEl) return;
  if (handleEl.hasAttribute('disabled')) return;

  const handle = handleEl.getAttribute('data-handle')!;
  event.preventDefault();
  event.stopPropagation();

  // 상태 초기화
  this._resizeState = {
    isResizing: true,
    handle,
    moved: false,
    startMouseX: event.clientX,
    startMouseY: event.clientY,
    startColWidths: [...this._resolvedColWidths],
    startRowHeights: [...this._gridResolution!.rowHeights],
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    rafId: null,
  };

  editManager._startLayoutResize(); // 기존 API 재사용

  document.addEventListener('mousemove', this._onTableResizeMouseMove);
  document.addEventListener('mouseup', this._onTableResizeMouseUp);
  document.addEventListener('keydown', this._onTableResizeKeyDown);
}
```

### 8A.5 리사이즈 중 — `_onTableResizeMouseMove`

```typescript
private _onTableResizeMouseMove = (event: MouseEvent): void => {
  if (!this._resizeState || !this._resizeState.isResizing) return;
  this._resizeState.lastClientX = event.clientX;
  this._resizeState.lastClientY = event.clientY;

  const dx = event.clientX - this._resizeState.startMouseX;
  const dy = event.clientY - this._resizeState.startMouseY;
  if (!this._resizeState.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
    this._resizeState.moved = true;
  }
  if (!this._resizeState.moved) return;
  if (this._resizeState.rafId !== null) return;

  this._resizeState.rafId = requestAnimationFrame(() => {
    if (!this._resizeState) return;
    this._resizeState.rafId = null;
    const ppm = GridCalculator.ppm;
    const handle = this._resizeState.handle!;
    if (handle.startsWith('v-')) {
      const col = parseInt(handle.slice(2));
      const deltaMm = (this._resizeState.lastClientX - this._resizeState.startMouseX) / ppm;
      this._applyColumnResize(col, deltaMm);
    } else if (handle.startsWith('h-')) {
      const row = parseInt(handle.slice(2));
      const deltaMm = (this._resizeState.lastClientY - this._resizeState.startMouseY) / ppm;
      this._applyRowResize(row, deltaMm);
    }
  });
};
```

### 8A.6 너비/높이 재분배 알고리즘

#### 컬럼 너비 재분배 (`_applyColumnResize`)

```
/**
 * 수직 핸들 드래그: 열 col과 col+1의 너비를 재분배.
 * 총 너비는 유지 (colWidths[col] + colWidths[col+1] = 일정).
 *
 * @param col - 경계 왼쪽 열 인덱스 (1 ≤ col ≤ colCount-2)
 * @param deltaMm - 마우스 이동량 (mm). 양수=오른쪽(열 col 확장, col+1 축소)
 */
function _applyColumnResize(col, deltaMm):
  state = this._resizeState
  oldLeft = state.startColWidths[col]
  oldRight = state.startColWidths[col + 1]
  total = oldLeft + oldRight
  minSize = MIN_TABLE_COL_WIDTH  // 5mm

  newLeft = clamp(oldLeft + deltaMm, minSize, total - minSize)
  newRight = total - newLeft

  if newLeft === oldLeft: return  // 변경 없음

  // colWidths 갱신
  newColWidths = [...state.startColWidths]
  newColWidths[col] = newLeft
  newColWidths[col + 1] = newRight

  this._colWidths = newColWidths
  // layout() 재실행 → gridResolution 갱신 → TD 메트릭 갱신 → 보더/핸들 갱신
  // → TD layout() → 자식 box [hide-resize] 재평가 (전략 B)
  this.layout()
  void this.render()

  // boxPropertyChange 이벤트 (부모 box 통해 외부 통지)
  this._notifyTablePropertyChange()
```

#### 행 높이 재분배 (`_applyRowResize`)

```
/**
 * 수평 핸들 드래그: 행 row와 row+1의 높이를 재분배.
 * 총 높이는 유지 (rowHeights[row] + rowHeights[row+1] = 일정).
 *
 * @param row - 경계 위쪽 행 인덱스 (1 ≤ row ≤ rowCount-2)
 * @param deltaMm - 마우스 이동량 (mm). 양수=아래쪽(행 row 확장, row+1 축소)
 */
function _applyRowResize(row, deltaMm):
  state = this._resizeState
  oldTop = state.startRowHeights[row]
  oldBottom = state.startRowHeights[row + 1]
  total = oldTop + oldBottom
  minSize = MIN_TABLE_ROW_HEIGHT  // 5mm

  newTop = clamp(oldTop + deltaMm, minSize, total - minSize)
  newBottom = total - newTop

  if newTop === oldTop: return

  // TR height 갱신
  // rowHeights는 TableData에 직접 저장되지 않음 — 각 TR의 height에 저장.
  // table이 자식 TR 요소의 height 속성을 갱신.
  const trEl = this.children[row] as LayoutTableRowElement | undefined
  const nextTrEl = this.children[row + 1] as LayoutTableRowElement | undefined
  if trEl: trEl.height = newTop
  if nextTrEl: nextTrEl.height = newBottom

  // layout() 재실행
  this.layout()
  void this.render()
  this._notifyTablePropertyChange()
```

### 8A.7 리사이즈 종료 — `_onTableResizeMouseUp`

```typescript
private _onTableResizeMouseUp = (event: MouseEvent): void => {
  if (!this._resizeState) return;
  // rAF 취소
  if (this._resizeState.rafId !== null) {
    cancelAnimationFrame(this._resizeState.rafId);
    this._resizeState.rafId = null;
  }
  const moved = this._resizeState.moved;
  const editManager = this.editManager;
  this._resizeState = null;

  document.removeEventListener('mousemove', this._onTableResizeMouseMove);
  document.removeEventListener('mouseup', this._onTableResizeMouseUp);
  document.removeEventListener('keydown', this._onTableResizeKeyDown);

  if (editManager) {
    editManager._endLayoutResize();
  }

  if (moved) {
    // 최종 layout + render + 핸들 갱신
    this.layout();
    void this.render();
    this._notifyTablePropertyChange();
  }
};
```

### 8A.8 ESC 취소 — `_onTableResizeKeyDown`

```typescript
private _onTableResizeKeyDown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape' || !this._resizeState) return;
  // rAF 취소
  if (this._resizeState.rafId !== null) {
    cancelAnimationFrame(this._resizeState.rafId);
    this._resizeState.rafId = null;
  }
  // 원래 값 복원
  const state = this._resizeState;
  this._resizeState = null;
  if (state.handle.startsWith('v-')) {
    this._colWidths = state.startColWidths;
  } else if (state.handle.startsWith('h-')) {
    // TR height 복원
    for (let i = 0; i < state.startRowHeights.length; i++) {
      const trEl = this.children[i] as LayoutTableRowElement | undefined;
      if (trEl) trEl.height = state.startRowHeights[i];
    }
  }
  this.layout();
  void this.render();

  document.removeEventListener('mousemove', this._onTableResizeMouseMove);
  document.removeEventListener('mouseup', this._onTableResizeMouseUp);
  document.removeEventListener('keydown', this._onTableResizeKeyDown);
};
```

### 8A.9 편집 모드 진입/종료 시 핸들 표시/숨김

`LayoutTableElement`에 `editableLayout` 속성 추가 (부모 box의 `editableLayout` 연동):
- 부모 box가 `editableLayout=true`가 되면 → table에 `[editable-layout]` 속성 부여 → CSS로 핸들 표시.
- 부모 box가 `editableLayout=false`가 되면 → table 속성 제거 → 핸들 숨김.

이 연동은 `LayoutBoxElement._applyEditableLayout()`에서 table 자식에게 전파하거나, EditManager의 `_updateEditableLayoutAll()`이 table 요소도 순회하도록 확장.

### 8A.10 TD 내 box resizer 숨김 제어 (전략 B 구현)

#### `LayoutBoxElement` 수정

`LayoutBoxElement`에 `[hide-resize]` 속성 지원 추가:
```css
/* box.shadowRoot 내 CSS 규칙 추가 */
@media screen {
  :host([hide-resize]) .resize-handle { display: none !important; }
}
```

새 메서드:
```typescript
/**
 * TD 안의 box가 TD를 꽉 채울 때 resizer를 숨긴다.
 * @param hide - true면 숨김, false면 표시
 */
set hideResizeHandles(hide: boolean) {
  if (hide) {
    this.setAttribute('hide-resize', '');
  } else {
    this.removeAttribute('hide-resize');
  }
}
```

#### `LayoutTableCellElement._updateChildBoxResizeVisibility()`

TD의 `layout()` 시 자식 box마다 `isBoxFillingCell` 판별하여 `[hide-resize]` 제어:

```typescript
/**
 * TD 내 자식 box들의 resizer 표시/숨김을 갱신.
 * TD를 꽉 채우는 box는 resizer 숨김 (table resizer로 대체).
 * 부분 배치 box는 resizer 표시.
 * layout()에서 호출된다.
 */
private _updateChildBoxResizeVisibility(): void {
  for (const box of this.items) {
    const filling = isBoxFillingCell(box, this);
    box.hideResizeHandles = filling;
  }
}
```

`LayoutTableCellElement.layout()` 파이프라인에 추가:
```typescript
layout(): void {
  this._layoutStructure();
  this._applyStyle();
  this._renderDiagonals();
  this._propagateInheritStyle();
  this._updateChildBoxResizeVisibility();  // ← 추가 (전략 B)
}
```

### 8A.11 최소 크기 상수

`src/constants/defaults.ts`:
```typescript
/** 테이블 컬럼 최소 너비 (mm). 리사이즈 시 이하로 축소 불가. */
export const MIN_TABLE_COL_WIDTH = 5;

/** 테이블 행 최소 높이 (mm). 리사이즈 시 이하로 축소 불가. */
export const MIN_TABLE_ROW_HEIGHT = 5;
```

### 8A.12 외부 통지 — `_notifyTablePropertyChange`

```typescript
private _notifyTablePropertyChange(): void {
  const parentBox = this.parentElement;
  if (parentBox instanceof LayoutBoxElement) {
    const editManager = parentBox.editManager;
    editManager?._dispatchBoxPropertyChange(parentBox, 'table-grid');
  }
}
```

기존 `boxPropertyChange` 이벤트 재사용. 페이로드에 `property: 'table-grid'` 추가하여 테이블 구조 변경임을 명시. 외부(React/undo-redo)는 이 이벤트를 받아 `box.data` getter로 갱신된 TableData를 읽음.

### 8A.13 리사이즈 중 텍스트 리렌더

셀 너비/높이 변경 시 TD 내 paragraph가 자동 리렌더되어야 함 (텍스트 재래핑).
- `this.layout()` → TD `_setCellMetrics()` → TD `layout()` → 자식 box `layout()` → paragraph `render()` 호출.
- 기존 box 리사이즈의 `_collectAffectedParagraphs`/`_renderAffectedParagraphs` 패턴과 동일하게, table도 리사이즈 중 영향받는 paragraph를 수집하여 rAF 후 일괄 리렌더 권장 (성능 최적화).
- 1차 구현은 `this.layout()` + `this.render()` 전체 재실행으로 단순화 가능 (table 규모가 작으므로).

---

## 8B. 키보드 기반 레이아웃 편집 (Cell Block, Resize, Structure)

layout 편집 모드에서 **키보드**로 셀 블록 지정, 셀 크기 조절, 셀 구조 변경(merge/split/insert/delete)을 수행하는 기능. 마우스 기반 리사이즈(8A)와 상호 보완하며, 외부 편집기 툴바에서도 동일 기능을 호출할 수 있도록 **외부 함수 API를 함께 제공**한다.

### 8B.0 설계 개요

| 기능 그룹 | 트리거 | 설명 |
|---|---|---|
| 셀 블록 지정 | F5 (1/2/3회), F7, F8 | 단일 셀 → 범위 선택 → 전체 선택. F7=열, F8=행 |
| 셀 크기 조절 | Alt + 방향키 | 표 전체 크기 유지하며 해당 줄/칸 크기 조절 |
| 셀 구조 변경 | M, S, W, H, Alt+Insert, Alt+Delete | merge, split, 너비 균등, 높이 균등, 행/열 추가·삭제 |
| 외부 API | `TableKeyboardController` + `TableStructureEditor` public 메서드 | 툴바/외부 편집기에서 동일 기능 호출 |

**활성 조건**: `editManager.layoutEditMode === true` 이고 포커스가 table 내부에 있을 때. **텍스트 편집 모드에서도 셀 블록 지정(F5/F7/F8)과 방향키 범위 확장, ESC 해제, Alt+방향키 크기 조절은 동작**한다. 단, **셀 구조 변경(M/S/W/H/Alt+Insert/Alt+Delete)은 셀 블록 선택이 활성 상태일 때만 동작**하므로, 텍스트 편집 중 일반 키 입력과 충돌하지 않는다.

**더블클릭 텍스트 편집 진입과 셀 블록의 관계**:
- 더블클릭은 셀 블록 활성 여부와 무관하게 텍스트 편집 모드로 진입한다 (`_onDblClick`은 셀 블록을 해제하지 않음).
- 텍스트 편집 모드 진입 후 셀 블록이 활성 상태이면 **테이블 제어가 우선** — 방향키는 셀 블록 range 확장으로 동작하고, 텍스트 커서 이동으로 처리되지 않는다.
- 셀 블록이 비활성 상태이면 방향키는 텍스트 커서 이동으로 동작한다 (TableKeyboardController가 미처리 → TextEditController로 전파).
- 즉, 더블클릭 텍스트 편집 진입은 우선시하되, 셀 블록이 활성화되어 있으면 테이블 제어가 우선한다.

### 8B.1 셀 블록 지정 모델 — `TableCellSelection`

#### 신규 타입: `src/types/edit/table-selection.type.ts`

```typescript
/**
 * 셀 블록 선택 모드.
 * F5 입력 횟수에 따라 전환.
 */
export type CellBlockMode = 'single' | 'range' | 'all';

/**
 * 셀 블록 선택 상태.
 * F5(1/2/3회)로 모드 전환, 방향키로 범위 확장, F7/F8으로 행/열 전체 선택.
 *
 * @example
 * // F5 1회 → 현재 셀 1개 선택 (회색 원)
 * { mode: 'single', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }
 * // F5 2회 → 범위 선택 모드 (빨간 원), 방향키로 확장
 * { mode: 'range', anchor: { row: 0, col: 0 }, focus: { row: 2, col: 1 } }
 * // F5 3회 → 전체 셀 선택
 * { mode: 'all', anchor: { row: 0, col: 0 }, focus: { row: maxRow, col: maxCol } }
 */
export type TableCellSelection = {
  /** 선택 모드 */
  mode: CellBlockMode;
  /** 선택 시작점 (anchor). 단일/범위 모드에서 사용. */
  anchor: CellCoord;
  /** 선택 끝점 (focus = 커서 위치). 범위 모드에서 방향키로 이동. */
  focus: CellCoord;
  /** 행 전체 선택 (F8). mode='range'이고 anchor.col=0, focus.col=colCount-1 */
  /** 열 전체 선택 (F7). mode='range'이고 anchor.row=0, focus.row=rowCount-1 */
  /** 행/열 전체 선택 플래그 (F7/F8 판별용) */
  selectMode?: 'cell' | 'row' | 'col';
};

/**
 * 셀 그리드 좌표 (row, col). colspan/rowspan을 고려한 **논리 좌표**.
 * 물리적 TD 요소는 하나의 셀이 여러 좌표를 점유할 수 있음 (colspan/rowspan).
 */
export type CellCoord = {
  /** 행 인덱스 (0부터) */
  row: number;
  /** 열 인덱스 (0부터) */
  col: number;
};

/**
 * 셀 블록 선택 변경 이벤트 페이로드.
 * EditManager를 통해 `tableCellSelectionChange` 이벤트로 dispatch.
 */
export type TableCellSelectionChangeDetail = {
  /** 선택 상태 (null = 선택 해제) */
  selection: TableCellSelection | null;
  /** 선택된 셀 요소 배열 (논리 좌표 → 물리 TD 매핑 결과) */
  selectedCells: LayoutTableCellElement[];
  /** 이벤트 소스 */
  source: 'keyboard' | 'programmatic';
};
```

#### `src/types/edit/index.ts`에 export 추가:
```typescript
export * from "./table-selection";
```

### 8B.2 셀 블록 시각 표시

선택된 셀에 **원(circle) 표시**를 shadow DOM에 렌더링. 기존 box의 `<x-layout-selection>`과 유사하나, table 전용으로 TD shadow root가 아닌 **table shadow root의 별도 레이어**에 배치 (TD는 border/배경만 소유, 선택 표시는 table이 중앙 관리).

| 모드 | 시각 | 설명 |
|---|---|---|
| `single` | 회색 원 | 선택된 셀 1개에 회색 원 오버레이 |
| `range` | 빨간 원 | 선택된 범위의 모든 셀에 빨간 원 오버레이 |
| `all` | 빨간 원 | 전체 셀에 빨간 원 오버레이 |
| F7 (열 전체) | 빨간 원 | 선택된 열의 모든 셀에 빨간 원 |
| F8 (행 전체) | 빨간 원 | 선택된 행의 모든 셀에 빨간 원 |

#### 선택 레이어 DOM 구조 (table shadow root 내부)
```html
<!-- shadow root 내부, border-layer 위, resize-layer 아래 -->
<div class="table-selection-layer">
  <!-- 각 선택된 셀마다 원 div -->
  <div class="table-selection-circle" data-cell="0-0"
       style="left:0; top:0; width:60px; height:50px; border-radius:50%; border:2px solid gray;">
  </div>
  <div class="table-selection-circle" data-cell="0-1"
       style="left:60px; top:0; width:40px; height:50px; border-radius:50%; border:2px solid red;">
  </div>
</div>
```

CSS 규칙 (`styleEl.sheet.insertRule()`):
```css
@media screen {
  .table-selection-layer {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    pointer-events: none; z-index: 99989;
  }
}
@media screen {
  .table-selection-circle {
    position: absolute; pointer-events: none;
    border-radius: 50%; border-width: 2px; border-style: solid;
    box-sizing: border-box; opacity: 0.5;
  }
}
@media print {
  .table-selection-layer { display: none !important; }
}
```

> **z-index**: `Z_INDEX_TABLE_SELECTION = 99989` (신규 상수). border-layer(99990) **아래**에 배치하여 보더 라인이 선택 원 위에 표시되도록 함. resize-layer(99992)보다 아래.

### 8B.3 TableKeyboardController — 키보드 입력 처리

#### 신규 파일: `src/edit/table-keyboard-controller.ts`

`LayoutTableElement`가 소유하는 컨트롤러. 편집 모드 진입 시 생성, 종료 시 파괴. 키보드 이벤트를 셀 블록 선택/크기 조절/구조 변경 액션으로 라우팅.

```typescript
import type { EditManager } from "./edit-manager";
import type { LayoutTableElement } from "@/components/layout/table.element";
import type { TableCellSelection, CellCoord, CellBlockMode } from "@/types";

/**
 * 테이블 키보드 편집 컨트롤러.
 *
 * layout 편집 모드에서 키보드 입력을 처리:
 * - F5: 셀 블록 지정 (1회=단일, 2회=범위, 3회=전체)
 * - F7: 열 전체 선택 (F5 상태에서)
 * - F8: 행 전체 선택 (F5 상태에서)
 * - Alt+방향키: 셀 크기 조절 (표 전체 크기 유지)
 * - M: 셀 병합 (merge)
 * - S: 셀 분할 (split) — 대화상자 호출
 * - W: 선택 셀 너비 균등 배분
 * - H: 선택 셀 높이 균등 배분
 * - Alt+Insert: 행/열 추가
 * - Alt+Delete: 행/열 삭제
 * - 방향키: 범위 선택 모드에서 focus 이동
 * - ESC: 셀 블록 선택 해제
 *
 * 구조 변경(M/S/W/H/Insert/Delete)은 `TableStructureEditor`의 public 메서드로 위임.
 * 외부 툴바도 동일 메서드를 호출하여 일관된 동작 보장.
 */
export class TableKeyboardController {
  private _tableEl: LayoutTableElement;
  private _editManager: EditManager;
  private _selection: TableCellSelection | null = null;
  private _structureEditor: TableStructureEditor;
  private _active: boolean = false;

  /**
   * @param tableEl - 제어할 테이블 요소
   * @param editManager - 소속 EditManager
   */
  constructor(tableEl: LayoutTableElement, editManager: EditManager);

  /** 컨트롤러 활성화 (편집 모드 진입 시) */
  activate(): void;

  /** 컨트롤러 비활성화 (편집 모드 종료 시) */
  deactivate(): void;

  /** 현재 셀 블록 선택 상태 */
  get selection(): TableCellSelection | null;
  set selection(value: TableCellSelection | null);

  // ─── 키보드 이벤트 핸들러 ───
  /**
   * keydown 이벤트 처리. table 요소의 keydown 리스너로 등록.
   * @returns true = 이벤트 처리됨(handled), false = 미처리(전파 허용)
   */
  handleKeyDown(event: KeyboardEvent): boolean;

  // ─── F5 셀 블록 지정 ───
  /**
   * F5 입력 처리. 입력 횟수에 따라 모드 전환.
   *
   * @param currentCell - 현재 커서 위치의 셀 (또는 anchor 셀)
   * @example
   * // F5 1회: single 모드 → 현재 셀 1개 (회색 원)
   * controller.handleF5({ row: 0, col: 0 });
   * // → selection = { mode: 'single', anchor: {0,0}, focus: {0,0} }
   *
   * // F5 2회: range 모드 (빨간 원), 방향키로 확장 가능
   * controller.handleF5({ row: 0, col: 0 });
   * // → selection = { mode: 'range', anchor: {0,0}, focus: {0,0} }
   *
   * // F5 3회: all 모드 (전체 셀 빨간 원)
   * controller.handleF5({ row: 0, col: 0 });
   * // → selection = { mode: 'all', anchor: {0,0}, focus: {maxRow,maxCol} }
   */
  handleF5(currentCell: CellCoord): void;

  /**
   * F7: 열 전체 선택.
   * 현재 focus.col의 모든 행을 선택.
   * @param currentCell - 현재 커서 위치
   */
  handleF7(currentCell: CellCoord): void;

  /**
   * F8: 행 전체 선택.
   * 현재 focus.row의 모든 열을 선택.
   * @param currentCell - 현재 커서 위치
   */
  handleF8(currentCell: CellCoord): void;

  // ─── 방향키 (범위 선택 모드) ───
  /**
   * 범위 선택 모드에서 focus 이동.
   * single/all 모드에서는 무시.
   *
   * @param direction - 이동 방향
   * @returns true = 이동 성공, false = 경계 도달
   */
  handleArrowKey(direction: 'up' | 'down' | 'left' | 'right'): boolean;

  // ─── Alt+방향키 (셀 크기 조절) ───
  /**
   * Alt+방향키: 표 전체 크기를 유지하면서 해당 셀의 줄/칸 크기 조절.
   *
   * - Alt+Left/Right: focus.col의 너비 축소/확장 (인접 col에서 차감/추가, 총폭 유지)
   * - Alt+Up/Down: focus.row의 높이 축소/확장 (인접 row에서 차감/추가, 총높이 유지)
   *
   * 단위: 1mm per key press. 연속 입력 시 1mm씩 누적.
   * 최소 크기(MIN_TABLE_COL_WIDTH/MIN_TABLE_ROW_HEIGHT) 보장.
   *
   * @param direction - 조절 방향
   * @example
   * // focus.col=1, Alt+Right → col 1 너비 +1mm, col 2 너비 -1mm
   * controller.handleAltArrowKey('right');
   */
  handleAltArrowKey(direction: 'up' | 'down' | 'left' | 'right'): void;

  // ─── 구조 변경 (TableStructureEditor 위임) ───
  /**
   * M: 선택한 셀들을 하나로 합침.
   * range/all 모드에서만 동작. 선택된 셀들의 논리 영역을 모두 커버하는
   * 단일 셀로 병합 (colspan = 선택 열 수, rowspan = 선택 행 수).
   */
  handleMerge(): void;

  /**
   * S: 현재 셀을 지정한 줄/칸 수로 나누는 대화상자 호출.
   * 사용자에게 행/열 분할 수를 입력받은 후 `TableStructureEditor.splitCell()` 실행.
   * 대화상자는 외부에서 제공하는 것을 전제로, 콜백 기반으로 구현.
   */
  handleSplit(): void;

  /**
   * W: 선택한 셀들의 너비를 균등하게 배분.
   * 선택된 열들의 총 너비를 선택 열 수로 균등 분할.
   */
  handleEqualizeWidth(): void;

  /**
   * H: 선택한 셀들의 높이를 균등하게 배분.
   * 선택된 행들의 총 높이를 선택 행 수로 균등 분할.
   */
  handleEqualizeHeight(): void;

  /**
   * Alt+Insert: 현재 위치에 줄(행) 또는 칸(열)을 추가.
   * @param target - 'row' | 'col'. 지정하지 않으면 focus 위치 기준
   *                 (focus.row인 경우 행, focus.col인 경우 열 — 외부에서 지정)
   */
  handleInsertRowOrCol(target: 'row' | 'col'): void;

  /**
   * Alt+Delete: 현재 위치의 줄(행) 또는 칸(열)을 삭제.
   * @param target - 'row' | 'col'
   */
  handleDeleteRowOrCol(target: 'row' | 'col'): void;

  // ─── ESC ───
  /** 셀 블록 선택 해제 */
  handleEscape(): void;

  // ─── 내부 유틸 ───
  /**
   * 논리 좌표(row, col) → 물리 TD 요소 매핑.
   * colspan/rowspan으로 인해 여러 논리 좌표가 동일 TD에 매핑될 수 있음.
   * @param coord - 논리 좌표
   * @returns 해당 좌표를 점유하는 TD 요소 (없으면 null)
   */
  private _getCellAt(coord: CellCoord): LayoutTableCellElement | null;

  /**
   * 선택 영역에 포함되는 모든 물리 TD 요소 배열 반환.
   * range 모드: anchor~focus 사각형 영역 내 모든 논리 좌표 → TD 매핑.
   * all 모드: 전체 셀.
   * single 모드: focus 셀 1개.
   * @returns 선택된 TD 요소 배열 (중복 제거)
   */
  private _getSelectedCells(): LayoutTableCellElement[];

  /**
   * 선택 상태를 갱신하고 시각 표시 + 이벤트 dispatch.
   */
  private _updateSelection(selection: TableCellSelection | null): void;

  /**
   * table shadow root의 selection-layer에 원 표시 렌더링.
   * 기존 원 div 제거 후 새 선택 영역에 맞춰 생성.
   */
  private _renderSelectionOverlay(): void;
}
```

#### `handleKeyDown` 라우팅 로직

```typescript
/**
 * keydown 이벤트 처리.
 *
 * 동작 규칙:
 * - **모든 모드에서 동작**: F5(셀 블록), F7/F8(행/열 선택), ESC(해제), Alt+방향키(크기 조절).
 *   이 키들은 텍스트 편집 모드에서도 동작한다 (기능키 + Alt 조합은 텍스트 입력과 충돌하지 않음).
 * - **셀 블록 선택 활성 시에만 동작**: 방향키(범위 확장), M/S/W/H(구조 변경), Alt+Insert/Delete(행/열 추가/삭제).
 *   셀 블록이 비활성 상태에서는 무시 → 텍스트 편집 모드의 일반 키 입력으로 전파.
 *
 * 이벤트 등록은 **capture phase** 로 등록하여 TextEditController의 textarea keydown보다
 * 먼저 수신한다. 처리한 키는 `stopPropagation()` 으로 textarea 전파를 차단.
 *
 * @returns true = 처리됨, false = 미처리 (전파 허용)
 */
handleKeyDown(event: KeyboardEvent): boolean {
  if (!this._active) return false;

  const key = event.key;
  const alt = event.altKey;
  const ctrl = event.ctrlKey;
  const shift = event.shiftKey;

  // ESC: 셀 블록 선택 해제 (모든 모드에서 동작)
  // 셀 블록이 활성 → 해제하고 이벤트 소비
  // 셀 블록 비활성 → 미처리 (TextEditController ESC가 처리: 선택 해제 또는 textEditMode=false)
  if (key === 'Escape') {
    if (this._selection) {
      this.handleEscape();
      return true;
    }
    return false;
  }

  // F5: 셀 블록 지정 (모든 모드에서 동작)
  if (key === 'F5') {
    event.preventDefault();
    event.stopPropagation();
    const current = this._getCurrentCellCoord();
    if (current) this.handleF5(current);
    return true;
  }

  // F7: 열 전체 선택 (모든 모드에서 동작)
  if (key === 'F7') {
    event.preventDefault();
    event.stopPropagation();
    const current = this._getCurrentCellCoord();
    if (current) this.handleF7(current);
    return true;
  }

  // F8: 행 전체 선택 (모든 모드에서 동작)
  if (key === 'F8') {
    event.preventDefault();
    event.stopPropagation();
    const current = this._getCurrentCellCoord();
    if (current) this.handleF8(current);
    return true;
  }

  // Alt + 방향키: 셀 크기 조절 (모든 모드에서 동작)
  if (alt && !ctrl && !shift) {
    if (key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); this.handleAltArrowKey('left'); return true; }
    if (key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); this.handleAltArrowKey('right'); return true; }
    if (key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); this.handleAltArrowKey('up'); return true; }
    if (key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); this.handleAltArrowKey('down'); return true; }
    // Alt+Insert: 행/열 추가 (셀 블록 활성 시에만)
    if (key === 'Insert' && this._selection) {
      event.preventDefault();
      event.stopPropagation();
      const target = this._selection.selectMode === 'col' ? 'col' : 'row';
      this.handleInsertRowOrCol(target);
      return true;
    }
    // Alt+Delete: 행/열 삭제 (셀 블록 활성 시에만)
    if (key === 'Delete' && this._selection) {
      event.preventDefault();
      event.stopPropagation();
      const target = this._selection.selectMode === 'col' ? 'col' : 'row';
      this.handleDeleteRowOrCol(target);
      return true;
    }
    return false;
  }

  // 이하 키들은 셀 블록 선택이 활성 상태일 때만 동작
  // 텍스트 편집 모드 + 셀 블록 비활성 → 미처리 → TextEditController로 전파 (텍스트 커서 이동)
  // 텍스트 편집 모드 + 셀 블록 활성 → 테이블 제어 우선 (방향키 range 확장, M/S/W/H 구조 변경)
  if (!this._selection) return false;

  // 방향키: 범위 선택 모드에서 focus 이동 (range 모드만)
  // 텍스트 편집 모드에서도 셀 블록이 활성이면 테이블 제어 우선 —
  // 텍스트 커서 이동이 아닌 셀 블록 range 확장으로 동작.
  if (!alt && !ctrl && !shift && this._selection.mode === 'range') {
    if (key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); this.handleArrowKey('left'); return true; }
    if (key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); this.handleArrowKey('right'); return true; }
    if (key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); this.handleArrowKey('up'); return true; }
    if (key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); this.handleArrowKey('down'); return true; }
  }

  // 구조 변경 키 (대소문자 구분 없음, 셀 블록 활성 시에만)
  if (!alt && !ctrl && !shift) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'm') { event.preventDefault(); event.stopPropagation(); this.handleMerge(); return true; }
    if (lowerKey === 's') { event.preventDefault(); event.stopPropagation(); this.handleSplit(); return true; }
    if (lowerKey === 'w') { event.preventDefault(); event.stopPropagation(); this.handleEqualizeWidth(); return true; }
    if (lowerKey === 'h') { event.preventDefault(); event.stopPropagation(); this.handleEqualizeHeight(); return true; }
  }

  return false;
}
```

#### F5 모드 전환 알고리즘

```typescript
/**
 * F5 입력 처리. 입력 횟수에 따라 모드 전환.
 *
 * 알고리즘:
 * 1. 현재 selection이 null 또는 mode !== single → single 모드 (1회)
 * 2. 현재 mode === single → range 모드 (2회)
 * 3. 현재 mode === range → all 모드 (3회)
 * 4. 현재 mode === all → single 모드 (다시 1회부터)
 */
handleF5(currentCell: CellCoord): void {
  const grid = this._tableEl.gridResolution;
  if (!grid) return;

  const maxRow = grid.rowCount - 1;
  const maxCol = grid.colCount - 1;

  if (!this._selection || this._selection.mode === 'all') {
    // 1회 (또는 all → 재시작): single
    this._updateSelection({
      mode: 'single',
      anchor: { ...currentCell },
      focus: { ...currentCell },
      selectMode: 'cell',
    });
  } else if (this._selection.mode === 'single') {
    // 2회: range
    this._updateSelection({
      mode: 'range',
      anchor: { ...currentCell },
      focus: { ...currentCell },
      selectMode: 'cell',
    });
  } else if (this._selection.mode === 'range') {
    // 3회: all
    this._updateSelection({
      mode: 'all',
      anchor: { row: 0, col: 0 },
      focus: { row: maxRow, col: maxCol },
      selectMode: 'cell',
    });
  }
}
```

#### F7/F8 행/열 전체 선택 알고리즘

```typescript
/**
 * F7: 열 전체 선택.
 * focus.col의 모든 행을 선택.
 */
handleF7(currentCell: CellCoord): void {
  const grid = this._tableEl.gridResolution;
  if (!grid) return;
  const maxRow = grid.rowCount - 1;

  this._updateSelection({
    mode: 'range',
    anchor: { row: 0, col: currentCell.col },
    focus: { row: maxRow, col: currentCell.col },
    selectMode: 'col',
  });
}

/**
 * F8: 행 전체 선택.
 * focus.row의 모든 열을 선택.
 */
handleF8(currentCell: CellCoord): void {
  const grid = this._tableEl.gridResolution;
  if (!grid) return;
  const maxCol = grid.colCount - 1;

  this._updateSelection({
    mode: 'range',
    anchor: { row: currentCell.row, col: 0 },
    focus: { row: currentCell.row, col: maxCol },
    selectMode: 'row',
  });
}
```

#### 방향키 (범위 선택 모드) 알고리즘

```typescript
/**
 * 범위 선택 모드에서 focus 이동.
 * anchor는 고정, focus만 이동.
 */
handleArrowKey(direction: 'up' | 'down' | 'left' | 'right'): boolean {
  if (!this._selection || this._selection.mode !== 'range') return false;
  const grid = this._tableEl.gridResolution;
  if (!grid) return false;

  const focus = { ...this._selection.focus };
  switch (direction) {
    case 'up':    focus.row = Math.max(0, focus.row - 1); break;
    case 'down':  focus.row = Math.min(grid.rowCount - 1, focus.row + 1); break;
    case 'left':  focus.col = Math.max(0, focus.col - 1); break;
    case 'right': focus.col = Math.min(grid.colCount - 1, focus.col + 1); break;
  }

  // selectMode가 'row'면 열 이동 무시, 'col'이면 행 이동 무시
  if (this._selection.selectMode === 'row' && (direction === 'left' || direction === 'right')) {
    return false;
  }
  if (this._selection.selectMode === 'col' && (direction === 'up' || direction === 'down')) {
    return false;
  }

  this._updateSelection({
    ...this._selection,
    focus,
  });
  return true;
}
```

#### Alt+방향키 (셀 크기 조절) 알고리즘

```typescript
/**
 * Alt+방향키: 표 전체 크기를 유지하면서 해당 셀의 줄/칸 크기 조절.
 *
 * - Alt+Right: focus.col 너비 +1mm, focus.col+1 너비 -1mm (총폭 유지)
 * - Alt+Left:  focus.col 너비 -1mm, focus.col+1 너비 +1mm (총폭 유지)
 * - Alt+Down:  focus.row 높이 +1mm, focus.row+1 높이 -1mm (총높이 유지)
 * - Alt+Up:    focus.row 높이 -1mm, focus.row+1 높이 +1mm (총높이 유지)
 *
 * 단위: 1mm per key press.
 * 최소 크기 보장: MIN_TABLE_COL_WIDTH / MIN_TABLE_ROW_HEIGHT.
 * 경계 도달 시 인접 col/row가 없으면 무시.
 */
handleAltArrowKey(direction: 'up' | 'down' | 'left' | 'right'): void {
  if (!this._selection) return;
  const grid = this._tableEl.gridResolution;
  if (!grid) return;

  const STEP_MM = 1; // 1mm per key press
  const focus = this._selection.focus;

  if (direction === 'right' || direction === 'left') {
    // 컬럼 너비 조절
    const col = focus.col;
    const adjacentCol = direction === 'right' ? col + 1 : col;
    const targetCol = direction === 'right' ? col : col - 1;

    // 인접 col이 없으면 무시 (경계)
    if (targetCol < 0 || adjacentCol >= grid.colCount) return;

    const currentWidth = grid.colWidths[targetCol];
    const adjacentWidth = grid.colWidths[adjacentCol];
    const total = currentWidth + adjacentWidth;
    const minSize = MIN_TABLE_COL_WIDTH;

    let newTarget: number;
    let newAdjacent: number;
    if (direction === 'right') {
      // targetCol 확장, adjacentCol 축소
      newTarget = Math.min(currentWidth + STEP_MM, total - minSize);
      newAdjacent = total - newTarget;
    } else {
      // targetCol 축소, adjacentCol 확장
      newTarget = Math.max(currentWidth - STEP_MM, minSize);
      newAdjacent = total - newTarget;
    }

    if (newTarget === currentWidth) return; // 변경 없음

    // colWidths 갱신 → table._colWidths setter
    const newColWidths = [...grid.colWidths];
    newColWidths[targetCol] = newTarget;
    newColWidths[adjacentCol] = newAdjacent;
    this._tableEl.colWidths = newColWidths;
    // table.layout() + render()는 colWidths setter가 호출
    this._tableEl.notifyTablePropertyChange();
  } else {
    // 행 높이 조절
    const row = focus.row;
    const adjacentRow = direction === 'down' ? row + 1 : row;
    const targetRow = direction === 'down' ? row : row - 1;

    if (targetRow < 0 || adjacentRow >= grid.rowCount) return;

    const currentHeight = grid.rowHeights[targetRow];
    const adjacentHeight = grid.rowHeights[adjacentRow];
    const total = currentHeight + adjacentHeight;
    const minSize = MIN_TABLE_ROW_HEIGHT;

    let newTarget: number;
    let newAdjacent: number;
    if (direction === 'down') {
      newTarget = Math.min(currentHeight + STEP_MM, total - minSize);
      newAdjacent = total - newTarget;
    } else {
      newTarget = Math.max(currentHeight - STEP_MM, minSize);
      newAdjacent = total - newTarget;
    }

    if (newTarget === currentHeight) return;

    // TR height 갱신
    const trEl = this._tableEl.children[targetRow] as LayoutTableRowElement | undefined;
    const adjacentTrEl = this._tableEl.children[adjacentRow] as LayoutTableRowElement | undefined;
    if (trEl) trEl.height = newTarget;
    if (adjacentTrEl) adjacentTrEl.height = newAdjacent;
    this._tableEl.layout();
    void this._tableEl.render();
    this._tableEl.notifyTablePropertyChange();
  }
}
```

### 8B.4 TableStructureEditor — 셀 구조 변경 (외부 API)

#### 신규 파일: `src/edit/table-structure-editor.ts`

구조 변경(merge/split/insert/delete/equalize) 로직을 캡슐화. `TableKeyboardController`가 내부적으로 호출하며, **외부 편집기 툴바에서도 동일 인스턴스의 public 메서드를 직접 호출**할 수 있다.

```typescript
import type { LayoutTableElement } from "@/components/layout/table.element";
import type { LayoutTableCellElement } from "@/components/layout/td.element";
import type { TableCellSelection, CellCoord } from "@/types";
import type { TableData, TableRowData, TableCellData, BoxData } from "@/types";

/**
 * 테이블 구조 변경 편집기.
 *
 * 셀 병합(merge), 분할(split), 너비/높이 균등 배분(equalize),
 * 행/열 추가(insert), 행/열 삭제(delete)를 수행한다.
 *
 * 키보드 컨트롤러(TableKeyboardController)와 외부 편집기 툴바가
 * 동일한 public 메서드를 호출하여 일관된 동작을 보장한다.
 *
 * 모든 구조 변경 후:
 * - table.data 갱신 (data setter → reconciliation → layout + render)
 * - boxPropertyChange 이벤트 dispatch (외부 undo/redo 감지)
 * - tableCellSelectionChange 이벤트 dispatch (선택 상태 갱신)
 */
export class TableStructureEditor {
  private _tableEl: LayoutTableElement;
  private _editManager: EditManager;

  /**
   * @param tableEl - 대상 테이블 요소
   * @param editManager - 소속 EditManager
   */
  constructor(tableEl: LayoutTableElement, editManager: EditManager);

  // ─── Merge ───
  /**
   * 선택한 셀들을 하나로 합친다.
   *
   * 알고리즘:
   * 1. 선택 영역(anchor~focus 사각형)의 모든 논리 좌표를 수집.
   * 2. 영역 내 첫 번째 셀(좌상단)을 병합 셀로 사용.
   * 3. 병합 셀의 colspan = 선택 열 수, rowspan = 선택 행 수.
   * 4. 영역 내 나머지 셀들의 children(box)을 병합 셀로 이동.
   * 5. 나머지 셀들을 children 배열에서 제거.
   * 6. table.data 갱신.
   *
   * @param selection - 셀 블록 선택 상태
   * @throws {Error} selection이 null이거나 single 모드인 경우
   * @example
   * // 2×2 영역 병합
   * editor.mergeCells({ mode: 'range', anchor: {row:0,col:0}, focus: {row:1,col:1} });
   * // → (0,0) 셀이 colspan=2, rowspan=2로 변경, (0,1)/(1,0)/(1,1) 셀 제거
   */
  mergeCells(selection: TableCellSelection): void;

  // ─── Split ───
  /**
   * 현재 셀을 지정한 줄/칸 수로 나눈다.
   *
   * 알고리즘:
   * 1. 대상 셀의 colspan/rowspan을 읽어 현재 점유 영역 계산.
   * 2. splitRows × splitCols 만큼 새 셀 생성.
   * 3. 원본 셀의 children(box)을 첫 번째 새 셀로 이동.
   * 4. 나머지 새 셀은 빈 children([])으로 생성.
   * 5. 원본 셀을 첫 번째 새 셀로 교체, 나머지 새 셀들을 TR에 추가.
   * 6. colWidths/rowHeights 재계산 (필요 시).
   * 7. table.data 갱신.
   *
   * @param cellCoord - 분할할 셀의 논리 좌표
   * @param splitRows - 분할할 행 수
   * @param splitCols - 분할할 열 수
   * @throws {Error} splitRows/splitCols가 1 미만이거나 원본 셀 영역을 초과하는 경우
   * @example
   * // (0,0) 셀(colspan=2, rowspan=2)을 2×2로 분할
   * editor.splitCell({row:0,col:0}, 2, 2);
   * // → 4개의 1×1 셀로 분할
   */
  splitCell(cellCoord: CellCoord, splitRows: number, splitCols: number): void;

  // ─── Equalize Width ───
  /**
   * 선택한 셀들의 너비를 균등하게 배분한다.
   *
   * 알고리즘:
   * 1. 선택된 열들의 총 너비 계산 (colWidths 합).
   * 2. 선택 열 수로 균등 분할.
   * 3. colWidths 갱신.
   * 4. table.layout() + render().
   *
   * @param selection - 셀 블록 선택 상태
   * @example
   * // 3개 열 너비 균등 배분
   * editor.equalizeWidth({ mode: 'range', anchor: {row:0,col:0}, focus: {row:0,col:2} });
   */
  equalizeWidth(selection: TableCellSelection): void;

  // ─── Equalize Height ───
  /**
   * 선택한 셀들의 높이를 균등하게 배분한다.
   *
   * 알고리즘:
   * 1. 선택된 행들의 총 높이 계산 (rowHeights 합).
   * 2. 선택 행 수로 균등 분할.
   * 3. 각 TR의 height 갱신.
   * 4. table.layout() + render().
   *
   * @param selection - 셀 블록 선택 상태
   */
  equalizeHeight(selection: TableCellSelection): void;

  // ─── Insert Row/Col ───
  /**
   * 현재 위치에 줄(행) 또는 칸(열)을 추가한다.
   *
   * 행 추가 알고리즘:
   * 1. rowIndex 위치에 새 TableRowData 추가.
   * 2. 새 행의 children: 각 col에 빈 TD 생성 (colspan=1, rowspan=1, children=[]).
   * 3. colWidths 유지 (행 추가는 colWidths 영향 없음).
   * 4. 기존 행 중 rowspan이 추가 위치를 걸치는 셀이 있으면 rowspan 증가.
   * 5. table.data 갱신.
   *
   * 열 추가 알고리즘:
   * 1. colIndex 위치에 새 컬럼 추가.
   * 2. 모든 행의 TD 사이에 빈 TD 삽입.
   * 3. colWidths에 새 너비 추가 (인접 col에서 균등 분할 또는 기본값).
   * 4. 기존 셀 중 colspan이 추가 위치를 걸치는 셀이 있으면 colspan 증가.
   * 5. table.data 갱신.
   *
   * @param target - 'row' | 'col'
   * @param index - 추가할 위치 (0부터). 생략 시 현재 focus 위치 기준.
   * @param count - 추가할 개수. 기본 1.
   * @example
   * // 2행 위치에 1행 추가
   * editor.insertRowOrCol('row', 2, 1);
   */
  insertRowOrCol(target: 'row' | 'col', index?: number, count?: number): void;

  // ─── Delete Row/Col ───
  /**
   * 현재 위치의 줄(행) 또는 칸(열)을 삭제한다.
   *
   * 행 삭제 알고리즘:
   * 1. rowIndex 위치의 TableRowData 제거.
   * 2. 삭제된 행에 rowspan 셀이 있던 경우:
   *    - rowspan > 1인 셀이 위 행에 걸쳐 있으면 rowspan 감소.
   *    - 삭제된 행이 셀의 시작 행이면 셀을 다음 행으로 이동 + rowspan 감소.
   * 3. table.data 갱신.
   *
   * 열 삭제 알고리즘:
   * 1. 모든 행의 TD 중 colIndex 위치 셀 제거.
   * 2. colspan/rowspan 조정 (행 삭제와 동일 로직).
   * 3. colWidths에서 해당 열 너비 제거.
   * 4. table.data 갱신.
   *
   * @param target - 'row' | 'col'
   * @param index - 삭제할 위치. 생략 시 현재 focus 위치 기준.
   * @param count - 삭제할 개수. 기본 1.
   * @throws {Error} 마지막 행/열 삭제 시도 (최소 1개 유지)
   */
  deleteRowOrCol(target: 'row' | 'col', index?: number, count?: number): void;

  // ─── 내부 유틸 ───
  /**
   * 현재 table.data를 읽어 구조 변경 후 새 TableData를 반환.
   * data setter를 통해 reconciliation + layout + render 수행.
   */
  private _applyNewData(newData: TableData): void;

  /**
   * 논리 좌표 → 물리 TD 요소 + 해당 행/열에서의 인덱스 매핑.
   */
  private _getPhysicalCell(coord: CellCoord): {
    tdEl: LayoutTableCellElement;
    trIndex: number;
    tdIndex: number;
  } | null;

  /**
   * 선택 영역의 논리 좌표 집합 반환.
   * anchor~focus 사각형 내 모든 (row, col) 쌍.
   */
  private _getSelectionCoords(selection: TableCellSelection): CellCoord[];

  /**
   * 빈 TD 데이터 생성.
   * @param colWidth - 기본 너비 (열 추가 시 사용)
   */
  private _createEmptyCell(): TableCellData;

  /**
   * 빈 행 데이터 생성.
   * @param colCount - 열 수
   */
  private _createEmptyRow(colCount: number, colWidth?: number): TableRowData;
}
```

#### Merge 알고리즘 상세

```typescript
/**
 * 선택한 셀들을 하나로 합친다.
 *
 * 알고리즘:
 * 1. 선택 영역의 모든 논리 좌표 수집 (anchor~focus 사각형).
 * 2. 영역 내 첫 번째 셀(좌상단)을 병합 셀로 사용.
 * 3. 병합 셀의 colspan = 선택 열 수, rowspan = 선택 행 수.
 * 4. 영역 내 나머지 셀들의 children(box)을 병합 셀로 이동.
 * 5. 나머지 셀들을 children 배열에서 제거.
 * 6. table.data 갱신.
 */
mergeCells(selection: TableCellSelection): void {
  if (!selection || selection.mode === 'single') {
    throw new Error("mergeCells requires range or all selection");
  }

  const coords = this._getSelectionCoords(selection);
  if (coords.length < 2) return; // 단일 셀은 병합 불필요

  // 선택 영역의 행/열 범위
  const minRow = Math.min(...coords.map(c => c.row));
  const maxRow = Math.max(...coords.map(c => c.row));
  const minCol = Math.min(...coords.map(c => c.col));
  const maxCol = Math.max(...coords.map(c => c.col));
  const spanRows = maxRow - minRow + 1;
  const spanCols = maxCol - minCol + 1;

  // 현재 table.data 읽기
  const currentData = this._tableEl.data;
  const newRows = currentData.children.map(tr => ({
    ...tr,
    children: tr.children.map(td => ({ ...td, children: [...td.children] })),
  }));

  // 병합 대상 셀 찾기 (좌상단)
  const mergeCell = this._getPhysicalCell({ row: minRow, col: minCol });
  if (!mergeCell) return;

  const mergeTd = newRows[mergeCell.trIndex].children[mergeCell.tdIndex];
  mergeTd.colspan = spanCols;
  mergeTd.rowspan = spanRows;

  // 영역 내 나머지 셀의 children을 병합 셀로 이동 + 제거
  const allChildren: BoxData[] = [...mergeTd.children];
  for (const coord of coords) {
    if (coord.row === minRow && coord.col === minCol) continue;
    const phys = this._getPhysicalCell(coord);
    if (!phys) continue;
    const td = newRows[phys.trIndex].children[phys.tdIndex];
    allChildren.push(...td.children);
  }
  mergeTd.children = allChildren;

  // 나머지 셀 제거 (각 TR에서 중복 셀 제거)
  // 주의: colspan/rowspan으로 인해 한 셀이 여러 좌표를 점유할 수 있음.
  // 제거 대상: mergeCell이 아닌, 선택 영역 내 물리 셀.
  const removeSet = new Set<string>();
  for (const coord of coords) {
    if (coord.row === minRow && coord.col === minCol) continue;
    const phys = this._getPhysicalCell(coord);
    if (!phys) continue;
    const key = `${phys.trIndex}-${phys.tdIndex}`;
    removeSet.add(key);
  }

  // 각 TR에서 제거 대상 TD 제거
  for (let r = 0; r < newRows.length; r++) {
    const tdIndicesToRemove: number[] = [];
    for (let c = 0; c < newRows[r].children.length; c++) {
      if (removeSet.has(`${r}-${c}`)) {
        tdIndicesToRemove.push(c);
      }
    }
    // 역순 제거 (인덱스 밀림 방지)
    for (const idx of tdIndicesToRemove.reverse()) {
      newRows[r].children.splice(idx, 1);
    }
  }

  this._applyNewData({ ...currentData, children: newRows });
}
```

#### Split 알고리즘 상세

```typescript
/**
 * 현재 셀을 지정한 줄/칸 수로 나눈다.
 *
 * 알고리즘:
 * 1. 대상 셀의 colspan/rowspan을 읽어 현재 점유 영역 계산.
 * 2. splitRows × splitCols 만큼 새 셀 생성.
 * 3. 원본 셀의 children(box)을 첫 번째 새 셀로 이동.
 * 4. 나머지 새 셀은 빈 children([])으로 생성.
 * 5. 원본 셀을 새 셀들로 교체 — **각 행마다 적절한 위치에 배치**:
 *    - splitRows=1: 모든 새 셀을 원본 셀이 있던 행의 같은 위치에 나열.
 *    - splitRows>1: splitCols개씩 각 행에 분산 배치.
 *      원본 셀이 row R~R+rowspan-1 을 점유하고 있으면,
 *      행 R에 splitCols개의 새 셀, 행 R+1에 splitCols개, ... 행 R+splitRows-1에 splitCols개.
 *      단, 원본 셀이 단일 행의 셀(rowspan=1)이었는데 splitRows>1이면
 *      새 행이 필요하므로 TR 자체를 추가 생성해야 함 (이 케이스는 지원하지 않음 —
 *      splitRows는 원본 rowspan 이하만 허용).
 * 6. colWidths/rowHeights 재계산 (필요 시).
 * 7. table.data 갱신.
 *
 * @throws {Error} splitRows > 원본 rowspan 인 경우 (새 행 생성 불가)
 * @throws {Error} splitCols > 원본 colspan 인 경우
 */
splitCell(cellCoord: CellCoord, splitRows: number, splitCols: number): void {
  if (splitRows < 1 || splitCols < 1) {
    throw new Error("splitRows and splitCols must be >= 1");
  }
  if (splitRows === 1 && splitCols === 1) return; // 분할 불필요

  const phys = this._getPhysicalCell(cellCoord);
  if (!phys) return;

  const currentData = this._tableEl.data;
  const newRows = currentData.children.map(tr => ({
    ...tr,
    children: tr.children.map(td => ({ ...td, children: [...td.children] })),
  }));

  const originalTd = newRows[phys.trIndex].children[phys.tdIndex];
  const originalColspan = originalTd.colspan ?? 1;
  const originalRowspan = originalTd.rowspan ?? 1;

  if (splitCols > originalColspan) {
    throw new Error(`splitCols (${splitCols}) exceeds cell colspan (${originalColspan})`);
  }
  if (splitRows > originalRowspan) {
    throw new Error(`splitRows (${splitRows}) exceeds cell rowspan (${originalRowspan}) — cannot create new rows`);
  }

  // 새 셀들의 colspan/rowspan 계산
  // 각 새 셀의 colspan = floor(originalColspan / splitCols), 나머지 분배
  // 각 새 셀의 rowspan = floor(originalRowspan / splitRows), 나머지 분배
  const baseColspan = Math.floor(originalColspan / splitCols);
  const colRemainder = originalColspan % splitCols;
  const baseRowspan = Math.floor(originalRowspan / splitRows);
  const rowRemainder = originalRowspan % splitRows;

  // 새 셀 배열 생성 (splitRows × splitCols)
  // [r][c] 형태의 2D 배열
  const newCellsGrid: TableCellData[][] = [];
  for (let r = 0; r < splitRows; r++) {
    const row: TableCellData[] = [];
    const cellRowspan = baseRowspan + (r < rowRemainder ? 1 : 0);
    for (let c = 0; c < splitCols; c++) {
      const cellColspan = baseColspan + (c < colRemainder ? 1 : 0);
      if (r === 0 && c === 0) {
        // 첫 번째 새 셀: 원본 셀의 children 이동
        row.push({
          ...originalTd,
          colspan: cellColspan,
          rowspan: cellRowspan,
          children: [...originalTd.children],
        });
      } else {
        // 나머지: 빈 셀
        row.push({
          ...this._createEmptyCell(),
          colspan: cellColspan,
          rowspan: cellRowspan,
        });
      }
    }
    newCellsGrid.push(row);
  }

  // 원본 셀 제거
  newRows[phys.trIndex].children.splice(phys.tdIndex, 1);

  // 새 셀들을 각 행에 배치
  // splitRows=1: 첫 행(원본 행)에 splitCols개의 셀을 원본 위치에 삽입
  // splitRows>1: 각 행(원본 rowspan 범위 내)에 splitCols개씩 삽입
  //
  // 주의: 원본 셀이 row R에 있고 rowspan=originalRowspan이면,
  // 분할된 셀들은 행 R, R+1, ..., R+splitRows-1 에 배치.
  // 각 행의 삽입 위치는 원본 셀의 gridCol 위치에 해당하는 곳.
  //
  // 단순화 전략: 각 행의 children 배열 끝에 추가 (HTML table의 느슨한 배치 허용).
  // TableGridResolver가 점유 배열 기반으로 재배치하므로, TD의 물리적 순서가
  // 논리적 순서와 정확히 일치할 필요는 없음 — 첫 빈 슬롯에 배치되기 때문.
  for (let r = 0; r < splitRows; r++) {
    const targetRowIndex = phys.trIndex + r;
    if (targetRowIndex >= newRows.length) {
      // 원본 rowspan 범위 내이므로 이 케이스는 발생하지 않아야 함
      throw new Error(`split target row ${targetRowIndex} out of range`);
    }
    // 각 행의 원본 셀 위치(phys.tdIndex)에 분할된 셀들 삽입
    // 첫 행만 원래 위치에, 나머지 행은 적절한 위치(빈 슬롯)에 추가
    if (r === 0) {
      // 원본 행: 원본 위치에 splitCols개 삽입
      newRows[targetRowIndex].children.splice(phys.tdIndex, 0, ...newCellsGrid[r]);
    } else {
      // rowspan으로 걸친 행: 해당 행의 적절한 위치에 삽입
      // gridCol 위치를 기준으로 삽입 위치 결정
      // 단순화: children 배열의 원본 gridCol에 해당하는 위치에 추가
      // (TableGridResolver가 재배치하므로 정확한 위치 보장 불필요)
      // → 행의 끝에 추가하는 것이 가장 안전
      newRows[targetRowIndex].children.push(...newCellsGrid[r]);
    }
  }

  this._applyNewData({ ...currentData, children: newRows });
}
```

> **주의**: `splitRows > 1`이면 분할된 셀들이 여러 행에 걸쳐 배치됩니다. 원본 셀이 `rowspan > 1`인 경우에만 `splitRows > 1`이 허용되며, 원본 `rowspan=1`인 셀을 행 방향으로 분할하려면 새 행이 필요하므로 에러를 발생시킵니다. `TableGridResolver`는 점유 배열 기반으로 셀을 첫 빈 슬롯에 배치하므로, TD의 물리적 순서가 논리적 순서와 정확히 일치하지 않아도 됩니다 — 행 내에서 빈 슬롯을 순서대로 채우기 때문입니다.

#### Insert Row 알고리즘 상세

```typescript
/**
 * 현재 위치에 줄(행) 또는 칸(열)을 추가한다.
 *
 * 행 추가:
 * 1. rowIndex 위치에 새 TableRowData 추가.
 * 2. 새 행의 height: **사용자 지정값을 존중**, 나머지 행 균등 축소 (최소 보장).
 *    - 새 행 height = rowIndex 행의 height 복사 (또는 외부에서 지정)
 *    - 기존 행들의 height 합 + 새 행 height > contentHeight → 기존 행들 축소
 *    - normalizeWidths([기존 height들..., 새 height], contentHeight, MIN_TABLE_ROW_HEIGHT)
 * 3. 새 행의 children: 각 col에 빈 TD 생성 (colspan=1, rowspan=1, children=[]).
 * 4. 기존 행 중 rowspan이 추가 위치를 걸치는 셀이 있으면 rowspan 증가.
 * 5. table.data 갱신.
 *
 * 열 추가:
 * 1. colIndex 위치에 새 컬럼 추가.
 * 2. 새 열 너비: **사용자 지정값을 존중**, 나머지 열 균등 축소 (최소 보장).
 *    - 새 열 너비 = 인접 col의 너비 또는 외부에서 지정
 *    - 기존 colWidths + 새 열 너비 > contentWidth → 기존 colWidths 축소
 *    - normalizeWidths([기존 colWidths..., 새 너비], contentWidth, MIN_TABLE_COL_WIDTH)
 * 3. 모든 행의 TD 사이에 빈 TD 삽입.
 * 4. 기존 셀 중 colspan이 추가 위치를 걸치는 셀이 있으면 colspan 증가.
 * 5. table.data 갱신.
 *
 * @param target - 'row' | 'col'
 * @param index - 추가할 위치 (0부터). 생략 시 현재 focus 위치 기준.
 * @param count - 추가할 개수. 기본 1.
 * @param size - 새 행/열의 크기(mm). 생략 시 인접 행/열의 크기 복사.
 */
insertRowOrCol(target: 'row' | 'col', index?: number, count: number = 1, size?: number): void {
  const grid = this._tableEl.gridResolution;
  if (!grid) return;

  const currentData = this._tableEl.data;

  if (target === 'row') {
    const rowIndex = index ?? this._tableEl.keyboardController?.selection?.focus.row ?? 0;
    const colCount = grid.colCount;
    const newRows = [...currentData.children];

    // 새 행의 height 결정: 사용자 지정값 존중, 미지정 시 인접 행 복사
    const newRowHeight = size ?? newRows[rowIndex]?.height ?? MIN_TABLE_ROW_HEIGHT;

    // 기존 rowHeights + 새 행 height 정규화 (총 contentHeight 유지, 최소 보장)
    const allHeights = [...grid.rowHeights];
    for (let i = 0; i < count; i++) {
      allHeights.splice(rowIndex + i, 0, newRowHeight);
    }
    const normalizedHeights = normalizeWidths(allHeights, allHeights.reduce((a, b) => a + b, 0), MIN_TABLE_ROW_HEIGHT);

    // 새 행 생성
    for (let i = 0; i < count; i++) {
      const insertIndex = rowIndex + i;
      const newRow = this._createEmptyRow(colCount);
      newRow.height = normalizedHeights[insertIndex];
      newRows.splice(insertIndex, 0, newRow);
    }

    // 기존 행들의 height 정규화 결과 반영
    for (let r = 0; r < newRows.length; r++) {
      if (r >= rowIndex && r < rowIndex + count) continue; // 새 행은 이미 설정됨
      // 기존 행의 height를 정규화된 값으로 갱신
      const origIndex = r < rowIndex ? r : r - count;
      newRows[r].height = normalizedHeights[r];
    }

    // rowspan이 추가 위치를 걸치는 셀의 rowspan 증가
    for (let r = 0; r < rowIndex; r++) {
      for (const td of newRows[r].children) {
        const rowspan = td.rowspan ?? 1;
        if (r + rowspan > rowIndex) {
          td.rowspan = rowspan + count;
        }
      }
    }

    this._applyNewData({ ...currentData, children: newRows });
  } else {
    // 열 추가
    const colIndex = index ?? this._tableEl.keyboardController?.selection?.focus.col ?? 0;
    const newRows = currentData.children.map(tr => ({ ...tr, children: [...tr.children] }));

    // 새 열 너비 결정: 사용자 지정값 존중, 미지정 시 인접 col 복사
    const newColWidth = size ?? grid.colWidths[colIndex] ?? MIN_TABLE_COL_WIDTH;

    // 기존 colWidths + 새 열 너비 정규화 (총 contentWidth 유지, 최소 보장)
    const allWidths = [...grid.colWidths];
    for (let i = 0; i < count; i++) {
      allWidths.splice(colIndex + i, 0, newColWidth);
    }
    const contentWidth = allWidths.reduce((a, b) => a + b, 0);
    const normalizedWidths = normalizeWidths(allWidths, contentWidth, MIN_TABLE_COL_WIDTH);

    for (const tr of newRows) {
      const newCell = this._createEmptyCell();
      tr.children.splice(colIndex, 0, newCell);
    }

    // colspan이 추가 위치를 걸치는 셀의 colspan 증가
    for (const tr of newRows) {
      for (const td of tr.children) {
        const colspan = td.colspan ?? 1;
        // 셀의 시작 열이 colIndex 이전이고, 끝 열이 colIndex 이후면 colspan 증가
        // (실제 구현 시 논리 좌표 기반 판별)
      }
    }

    this._applyNewData({ ...currentData, colWidths: normalizedWidths, children: newRows });
  }
}
```

#### Delete Row 알고리즘 상세

```typescript
/**
 * 현재 위치의 줄(행) 또는 칸(열)을 삭제한다.
 *
 * 행 삭제:
 * 1. rowIndex 위치의 TableRowData 제거.
 * 2. 삭제된 행에 rowspan 셀이 있던 경우 rowspan 조정.
 * 3. table.data 갱신.
 */
deleteRowOrCol(target: 'row' | 'col', index?: number, count: number = 1): void {
  const grid = this._tableEl.gridResolution;
  if (!grid) return;

  const currentData = this._tableEl.data;

  if (target === 'row') {
    if (grid.rowCount <= count) {
      throw new Error("Cannot delete all rows — at least 1 row must remain");
    }
    const rowIndex = index ?? this._tableEl.keyboardController?.selection?.focus.row ?? 0;
    const newRows = [...currentData.children];

    // 삭제할 행의 셀 중 rowspan > 1인 셀 처리
    for (const td of newRows[rowIndex].children) {
      const rowspan = td.rowspan ?? 1;
      if (rowspan > 1) {
        // 셀이 아래 행까지 걸쳐 있음 → 다음 행으로 셀 이동 + rowspan 감소
        if (rowIndex + 1 < newRows.length) {
          const movedTd: TableCellData = {
            ...td,
            rowspan: rowspan - 1,
            children: td.children, // children은 이미 복사됨
          };
          // 다음 행의 적절한 위치에 삽입
          // (단순화: 다음 행의 children 앞에 추가)
          newRows[rowIndex + 1].children.unshift(movedTd);
        }
      }
    }

    // 행 제거
    newRows.splice(rowIndex, count);

    this._applyNewData({ ...currentData, children: newRows });
  } else {
    // 열 삭제
    if (grid.colCount <= count) {
      throw new Error("Cannot delete all columns — at least 1 column must remain");
    }
    const colIndex = index ?? this._tableEl.keyboardController?.selection?.focus.col ?? 0;
    const newRows = currentData.children.map(tr => ({ ...tr, children: [...tr.children] }));
    const newColWidths = [...grid.colWidths];

    for (let i = 0; i < count; i++) {
      const deleteIndex = colIndex;
      newColWidths.splice(deleteIndex, 1);
      for (const tr of newRows) {
        if (deleteIndex < tr.children.length) {
          tr.children.splice(deleteIndex, 1);
        }
      }
    }

    this._applyNewData({ ...currentData, colWidths: newColWidths, children: newRows });
  }
}
```

### 8B.5 LayoutTableElement 통합

`LayoutTableElement`에 키보드 컨트롤러 + 구조 편집기 통합.

#### 클래스 멤버 추가

```typescript
// LayoutTableElement에 추가

/** 키보드 편집 컨트롤러 (편집 모드에서만 활성) */
private _keyboardController: TableKeyboardController | null = null;

/** 구조 편집기 (편집 모드에서만 활성) */
private _structureEditor: TableStructureEditor | null = null;

/** 셀 블록 선택 레이어 div */
private _selectionLayerEl: HTMLDivElement | null = null;

/** 선택 원 div 맵 (key → div) */
private _selectionCircleMap: Map<string, HTMLDivElement> = new Map();

/**
 * 그리드 해석 결과 getter (외부 접근용).
 * TableKeyboardController/TableStructureEditor가 gridResolution에 접근할 때 사용.
 * private 필드 `_gridResolution` 을 안전하게 노출.
 * @returns 현재 그리드 해석 결과 (미연결 시 undefined)
 */
get gridResolution(): GridResolution | undefined {
  return this._gridResolution;
}

/**
 * 정규화된 colWidths getter (외부 접근용).
 * 리사이즈/키보드 크기 조절 시 현재 colWidths를 읽을 때 사용.
 */
get resolvedColWidths(): number[] {
  return this._resolvedColWidths;
}

/**
 * 키보드 컨트롤러 getter (외부 접근용).
 * 외부 편집기 툴바가 structureEditor의 public 메서드를 호출할 때 사용.
 */
get keyboardController(): TableKeyboardController | null {
  return this._keyboardController;
}

/**
 * 구조 편집기 getter (외부 접근용).
 * 외부 편집기 툴바가 merge/split/insert/delete/equalize를 호출할 때 사용.
 * @example
 * // 외부 툴바에서 병합 실행
 * const editor = tableEl.structureEditor;
 * if (editor && tableEl.keyboardController?.selection) {
 *   editor.mergeCells(tableEl.keyboardController.selection);
 * }
 */
get structureEditor(): TableStructureEditor | null {
  return this._structureEditor;
}

/**
 * boxPropertyChange 이벤트 dispatch (외부 접근용).
 * TableKeyboardController/TableStructureEditor가 구조 변경 후 외부 통지할 때 사용.
 * private 메서드 `_notifyTablePropertyChange` 를 안전하게 노출.
 */
notifyTablePropertyChange(): void {
  this._notifyTablePropertyChange();
}
```

#### 편집 모드 진입/종료 시 컨트롤러 생성/파괴

```typescript
/**
 * 편집 모드 진입 시 키보드 컨트롤러 + 구조 편집기 활성화.
 * EditManager의 modeChange 이벤트 리스너 또는
 * 부모 box의 editableLayout setter에서 호출.
 */
private _activateTableEditing(): void {
  if (this._isPrint) return;
  const editManager = this.editManager;
  if (!editManager?.layoutEditMode) return;

  if (!this._structureEditor) {
    this._structureEditor = new TableStructureEditor(this, editManager);
  }
  if (!this._keyboardController) {
    this._keyboardController = new TableKeyboardController(this, editManager);
  }
  this._keyboardController.activate();
  // capture phase 로 등록: TextEditController의 textarea keydown보다
  // 먼저 수신하여 F5/F7/F8/Alt+방향키/셀 블록 제어 키를 우선 처리.
  // capture=true 이므로 textarea(자식)로 이벤트가 전달되기 전에 가로챔.
  this.addEventListener('keydown', this._onTableKeyDown, true);
}

/**
 * 편집 모드 종료 시 컨트롤러 비활성화.
 */
private _deactivateTableEditing(): void {
  // capture phase 로 등록했으므로 capture=true 로 제거
  this.removeEventListener('keydown', this._onTableKeyDown, true);
  this._keyboardController?.deactivate();
  // selection 해제
  this._clearSelectionOverlay();
}

/**
 * keydown 이벤트 리스너 (바인딩된 화살표 함수).
 * capture phase 에서 호출됨.
 */
private _onTableKeyDown = (event: KeyboardEvent): void => {
  if (this._keyboardController) {
    const handled = this._keyboardController.handleKeyDown(event);
    if (handled) {
      // 처리된 이벤트는 더 이상 전파하지 않음 (textarea 도달 차단)
      event.stopPropagation();
    }
  }
};
```

#### 선택 오버레이 렌더링

```typescript
/**
 * 셀 블록 선택 오버레이를 렌더링.
 * TableKeyboardController._renderSelectionOverlay()에서 호출.
 * @param selection - 선택 상태 (null = 해제)
 */
_renderSelectionOverlay(selection: TableCellSelection | null): void {
  // 기존 원 제거
  this._clearSelectionOverlay();
  if (!selection) return;

  const grid = this.gridResolution;
  if (!grid) return;

  // selection-layer 보장
  if (!this._selectionLayerEl) {
    const layer = document.createElement('div');
    layer.classList.add('table-selection-layer');
    layer.style.position = 'absolute';
    layer.style.top = '0';
    layer.style.left = '0';
    layer.style.width = '100%';
    layer.style.height = '100%';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = String(Z_INDEX_TABLE_SELECTION);
    this._shadowRoot.appendChild(layer);
    this._selectionLayerEl = layer;
  }

  const ppm = GridCalculator.ppm;
  const coords = this._getSelectionCoords(selection);
  const color = selection.mode === 'single' ? 'gray' : 'red';

  for (const coord of coords) {
    const placement = this._findPlacementAt(coord);
    if (!placement) continue;

    const circle = document.createElement('div');
    circle.classList.add('table-selection-circle');
    circle.style.position = 'absolute';
    circle.style.left = `${placement.x * ppm}px`;
    circle.style.top = `${placement.y * ppm}px`;
    circle.style.width = `${placement.width * ppm}px`;
    circle.style.height = `${placement.height * ppm}px`;
    circle.style.borderRadius = '50%';
    circle.style.border = `2px solid ${color}`;
    circle.style.boxSizing = 'border-box';
    circle.style.opacity = '0.5';
    circle.style.pointerEvents = 'none';
    circle.setAttribute('data-cell', `${coord.row}-${coord.col}`);

    this._selectionLayerEl.appendChild(circle);
    this._selectionCircleMap.set(`${coord.row}-${coord.col}`, circle);
  }
}

private _clearSelectionOverlay(): void {
  for (const [, circle] of this._selectionCircleMap) {
    circle.remove();
  }
  this._selectionCircleMap.clear();
}

/**
 * 논리 좌표에 해당하는 CellPlacement 반환.
 */
private _findPlacementAt(coord: CellCoord): CellPlacement | null {
  const grid = this.gridResolution;
  if (!grid) return null;
  for (const p of grid.placements) {
    if (coord.row >= p.gridRow && coord.row < p.gridRow + p.spanRows
      && coord.col >= p.gridCol && coord.col < p.gridCol + p.spanCols) {
      return p;
    }
  }
  return null;
}

/**
 * 선택 영역의 모든 논리 좌표 반환.
 */
private _getSelectionCoords(selection: TableCellSelection): CellCoord[] {
  const minRow = Math.min(selection.anchor.row, selection.focus.row);
  const maxRow = Math.max(selection.anchor.row, selection.focus.row);
  const minCol = Math.min(selection.anchor.col, selection.focus.col);
  const maxCol = Math.max(selection.anchor.col, selection.focus.col);
  const coords: CellCoord[] = [];
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      coords.push({ row: r, col: c });
    }
  }
  return coords;
}
```

### 8B.6 EditManager 이벤트 확장

#### 신규 이벤트: `tableCellSelectionChange`

```typescript
// src/edit/edit-manager.ts에 추가

/** 테이블 셀 블록 선택 변경 이벤트 타입 */
export const TABLE_CELL_SELECTION_CHANGE = 'tableCellSelectionChange' as const;

// 이벤트 리스너 타입에 추가
type EditManagerEventListener = (
  event: CustomEvent<TableCellSelectionChangeDetail>
) => void;

// dispatch 허용 타입에 추가
type DispatchableEvent = 'tableCellSelectionChange' | ...기존;
```

`TableKeyboardController._updateSelection()`에서 dispatch:
```typescript
private _updateSelection(selection: TableCellSelection | null): void {
  this._selection = selection;
  this._renderSelectionOverlay();
  const selectedCells = selection ? this._getSelectedCells() : [];
  this._editManager.dispatchEvent(new CustomEvent('tableCellSelectionChange', {
    detail: {
      selection,
      selectedCells,
      source: 'keyboard',
    },
  }));
}
```

외부(React/툴바)는 `editManager.addEventListener('tableCellSelectionChange', listener)`로 선택 상태 변화를 감지.

### 8B.7 상수 추가

`src/constants/defaults.ts`:
```typescript
/** 테이블 셀 블록 선택 레이어 z-index. border-layer(99990) 아래. */
export const Z_INDEX_TABLE_SELECTION = 99989;

/** 키보드 셀 크기 조절 단위 (mm per key press). */
export const TABLE_KEYBOARD_RESIZE_STEP = 1;
```

### 8B.8 외부 API 사용 예시

외부 편집기 툴바에서 키보드 기능을 직접 호출하는 예시:

```typescript
/**
 * 외부 툴바에서 테이블 셀 병합 실행.
 * @param tableEl - 대상 테이블 요소
 * @example
 * // 툴바의 "셀 병합" 버튼 클릭 시
 * function onMergeButtonClick(tableEl: LayoutTableElement) {
 *   const editor = tableEl.structureEditor;
 *   const controller = tableEl.keyboardController;
 *   if (!editor || !controller) return;
 *   const selection = controller.selection;
 *   if (!selection || selection.mode === 'single') {
 *     alert('병합할 셀을 먼저 선택하세요 (F5).');
 *     return;
 *   }
 *   editor.mergeCells(selection);
 * }
 */
```

```typescript
/**
 * 외부 툴바에서 행 추가 실행.
 * @param tableEl - 대상 테이블 요소
 * @param index - 추가할 행 위치 (생략 시 현재 선택 위치)
 * @example
 * // 툴바의 "행 추가" 버튼 클릭 시
 * function onInsertRowClick(tableEl: LayoutTableElement, index?: number) {
 *   const editor = tableEl.structureEditor;
 *   if (!editor) return;
 *   editor.insertRowOrCol('row', index, 1);
 * }
 */
```

```typescript
/**
 * 외부 툴바에서 셀 분할 실행.
 * @param tableEl - 대상 테이블 요소
 * @param splitRows - 분할할 행 수
 * @param splitCols - 분할할 열 수
 * @example
 * // 툴바의 "셀 분할" 버튼 클릭 시 (대화상자에서 입력받은 값)
 * function onSplitButtonClick(tableEl: LayoutTableElement, splitRows: number, splitCols: number) {
 *   const editor = tableEl.structureEditor;
 *   const controller = tableEl.keyboardController;
 *   if (!editor || !controller?.selection) return;
 *   const focus = controller.selection.focus;
 *   editor.splitCell(focus, splitRows, splitCols);
 * }
 */
```

### 8B.9 편집 모드 진입/종료 연동

`LayoutTableElement`는 부모 box의 `editableLayout` 상태 변화를 감지하여 컨트롤러를 활성화/비활성화한다. 이 연동은 두 가지 방식으로 구현 가능:

**방식 A (권장): EditManager modeChange 이벤트 리스너**
```typescript
// LayoutTableElement.connectedCallback()에서
this.editManager?.addEventListener('modeChange', this._onModeChange);

private _onModeChange = (event: CustomEvent): void => {
  const { mode } = event.detail;
  if (mode.layoutEditMode) {
    this._activateTableEditing();
  } else {
    this._deactivateTableEditing();
  }
};
```

**방식 B: 부모 box editableLayout 전파**
- `LayoutBoxElement._applyEditableLayout()`가 table 자식에게 `[editable-layout]` 속성 부여 시 table이 `attributeChangedCallback`에서 컨트롤러 활성화.

> **권장**: 방식 A. EditManager가 중앙에서 편집 상태를 관리하므로, modeChange 이벤트가 가장 신뢰할 수 있는 트리거.

### 8B.10 셀 블록 선택과 box 선택의 공존 정책

셀 블록(F5)이 활성 상태에서 TD 내 box를 마우스로 클릭할 때의 동작 정책.

#### 정책

1. **셀 블록 선택 영역 내의 TD에 속한 box 클릭** → **셀 블록 유지**
   - 셀 블록 선택 상태를 해제하지 않음.
   - box 선택으로 전환하지 않음.
   - box 클릭 이벤트는 `stopPropagation()` 없이 전파되되, LayoutSelectionController가 셀 블록 활성 상태를 확인하고 box 선택을 수행하지 않음.
   - 사용자는 셀 블록 유지 상태에서 구조 변경(M/S/W/H) 등을 계속 수행 가능.

2. **셀 블록 선택 영역 외부의 box 또는 빈 공간 클릭** → **box 선택으로 전환**
   - 셀 블록 선택 해제 (`selection = null`, 원 제거).
   - 기존 LayoutSelectionController가 box 선택 수행.
   - 일반적인 box 편집 동작으로 전환.

3. **table 외부 클릭** → **셀 블록 + box 선택 모두 해제**
   - 셀 블록 선택 해제.
   - 기존 box 선택 해제 (빈 공간 클릭 규칙).
   - table 내부는 TD가 absolute로 가득 채우므로 "TD 외부 빈 공간"은 존재하지 않음.
4. **마키 선택 시작** → **셀 블록 해제**
   - 마키는 table 외부 빈 공간에서 시작되므로, 마키 시작 시점(`_onMouseDown`)에 셀 블록 해제.
   - 마키 도중 셀 블록이 시각적으로 유지되는 혼선 방지.
5. **더블클릭 텍스트 편집 진입** → **셀 블록 유지**
   - `_onDblClick`은 셀 블록 활성 여부와 무관하게 텍스트 편집 모드로 진입.
   - 텍스트 편집 모드 진입 후 셀 블록이 활성이면 **테이블 제어 우선** (방향키 = 셀 블록 range 확장).
   - 셀 블록이 비활성이면 방향키 = 텍스트 커서 이동.

#### 구현 — `LayoutSelectionController._onMouseDown` 확장

> **주의**: 기존 `_onMouseDown`은 `pointerdown` 이벤트에 등록되어 있으며 시그니처가 `PointerEvent` 이다 (MouseEvent가 아님). 또한 box 선택은 `_onClick`에서 수행하므로, 셀 블록 유지 시 `stopPropagation()` 으로 `_onClick` 도달을 차단해야 한다.

```typescript
/**
 * 셀 블록이 활성 상태인지 확인하고, 클릭 대상이 선택 영역 내인지 판별.
 * @param target - 클릭 대상 요소
 * @returns true = 셀 블록 유지 (box 선택 수행 안 함), false = 기존 동작
 */
private _shouldPreserveCellBlock(target: Element): boolean {
  // table 요소 탐색
  const tableEl = target.closest('x-layout-table') as LayoutTableElement | null;
  if (!tableEl) return false; // table 외부

  const controller = tableEl.keyboardController;
  if (!controller?.selection) return false; // 셀 블록 비활성

  // table 내부 클릭은 항상 TD 내부 (TD가 absolute로 table 콘텐츠 영역을 가득 분할)
  // TD가 셀 블록 선택 영역 내인지 확인
  const tdEl = target.closest('x-layout-td') as LayoutTableCellElement | null;
  if (!tdEl) return false; // 안전장치 (정상적으로는 발생하지 않음)

  const selectedCells = controller.getSelectedCells();
  return selectedCells.includes(tdEl);
}

// _onMouseDown 내부 수정:
// 기존: pointerdown 이벤트, 시그니처 PointerEvent
// 수정: 셀 블록 공존 체크를 textEditMode 조기 return **이전**에 배치
//       (텍스트 편집 모드에서도 셀 블록 유지 동작해야 하므로)
private _onMouseDown = (event: PointerEvent): void => {
  const manager = this._manager;
  if (manager.insertMode) return;
  if (manager.placeGunActive) return;
  if (manager.spacePressed) return;
  if (event.button !== 0) return;

  // ─── 셀 블록 공존 체크 (textEditMode 조기 return 이전) ───
  // 텍스트 편집 모드에서도 셀 블록이 활성이면 유지 동작 수행
  const target = event.target as Element;
  if (this._shouldPreserveCellBlock(target)) {
    // 선택 영역 내 TD의 box 클릭 → 셀 블록 유지, box 선택 방지
    event.preventDefault();
    event.stopPropagation(); // _onClick 도달 차단 → box 선택 수행 안 함
    return;
  }

  // ─── 기존 로직 ───
  if (manager.textEditMode && manager.focusedParagraph) return;

  const box = this._findSelectableBoxFromEvent(event);
  if (box) return;

  const isInsideDocument = event.composedPath().some(
    (el) => el instanceof LayoutDocumentElement
  );
  if (!isInsideDocument) return;

  // ─── 마키 시작 시 셀 블록 해제 ───
  // 마키 선택은 table 외부 빈 공간에서 시작되므로, 셀 블록이 활성이면 해제.
  // (table 내부는 TD가 가득 채우므로 마키 시작 위치는 항상 table 외부)
  const path = event.composedPath();
  const tableEl = path.find(
    (el) => el instanceof LayoutTableElement
  ) as LayoutTableElement | undefined;
  if (tableEl?.keyboardController?.selection) {
    tableEl.keyboardController.selection = null;
  }

  this._marqueePending = true;
  this._marqueeAdditive = event.ctrlKey || event.metaKey;
  event.preventDefault();
  this._marquee = {
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    rectEl: null,
    lastX: event.clientX,
    lastY: event.clientY,
    rafId: null,
    highlightedBoxes: new Set(),
  };

  window.addEventListener('pointermove', this._onMarqueeMouseMove, true);
  window.addEventListener('pointerup', this._onMarqueeMouseUp, true);
  window.addEventListener('pointercancel', this._onMarqueeMouseUp, true);
};
```

#### `_onClick` 확장 — 영역 외부/빈 공간 클릭 시 셀 블록 해제

기존 `_onClick`에서 box를 찾지 못한 경우(빈 공간) 또는 셀 블록 영역 외부 box 클릭 시, 셀 블록을 해제한다.

```typescript
private _onClick = (event: MouseEvent): void => {
  const manager = this._manager;
  if (manager.insertMode) return;
  if (manager._consumeSuppressNextClick()) return;

  if (this._marqueePending) {
    this._marqueePending = false;
    return;
  }

  const path = event.composedPath();
  if (path.some((el) => el instanceof Element && el.closest('.parent-btn'))) return;

  const box = this._findSelectableBoxFromEvent(event);

  if (!box) {
    // 빈 공간 클릭
    const isInsideDocument = event.composedPath().some(
      (el) => el instanceof LayoutDocumentElement
    );
    if (isInsideDocument) {
      // ─── 셀 블록 해제 (기존 clearLayoutSelection 이전) ───
      // table 외부 클릭 시 셀 블록 해제
      // (table 내부는 TD가 가득 채우므로 빈 공간 = table 외부)
      const tableEl = path.find(
        (el) => el instanceof LayoutTableElement
      ) as LayoutTableElement | undefined;
      if (tableEl?.keyboardController?.selection) {
        tableEl.keyboardController.selection = null;
      }
      // ─── 기존 box 선택 해제 ───
      manager.clearLayoutSelection(false);
      manager.blurParagraph();
    }
    return;
  }

  // ─── 셀 블록 영역 외부 box 클릭 시 해제 ───
  // box가 table 내부에 있지만 셀 블록 선택 영역 외부인 경우
  // (_onMouseDown에서 _shouldPreserveCellBlock=false로 통과한 경우)
  const tableEl = path.find(
    (el) => el instanceof LayoutTableElement
  ) as LayoutTableElement | undefined;
  if (tableEl?.keyboardController?.selection) {
    // 영역 외부 box 클릭 → 셀 블록 해제
    tableEl.keyboardController.selection = null;
  }

  // ─── 기존 box 선택 로직 ───
  if (manager.layoutEditMode && manager.isBoxEditable(box)) return;
  if (box.hasAttribute('text-focused')) return;

  event.stopPropagation();
  if (this._isEventFromDescendantLayout(event, box)) return;

  box.removeAttribute('hovered');
  manager._setMultiSelect(event.ctrlKey || event.metaKey);
  manager.selectLayout(box);
  manager._setMultiSelect(false);
};
```

#### `TableKeyboardController.getSelectedCells()` public 메서드

`_getSelectedCells()` private 메서드를 public으로 노출:

```typescript
/**
 * 선택 영역에 포함되는 모든 물리 TD 요소 배열 반환.
 * LayoutSelectionController가 셀 블록 유지 판별 시 사용.
 * @returns 선택된 TD 요소 배열 (중복 제거)
 */
getSelectedCells(): LayoutTableCellElement[] {
  return this._getSelectedCells();
}
```

#### 동작 흐름 예시

```
시나리오: 3×3 테이블, F5로 (0,0)~(1,1) 범위 선택 (빨간 원 4개)

1. 사용자가 (0,0) TD 내 box 클릭
   → _onMouseDown: _shouldPreserveCellBlock → true (선택 영역 내 TD)
   → stopPropagation() → _onClick 도달 차단
   → 셀 블록 유지, box 선택 수행 안 함
   → 텍스트 편집 모드여도 동일 (textEditMode 조기 return 이전에 체크)

2. 사용자가 (2,2) TD 내 box 클릭 (선택 영역 외부)
   → _onMouseDown: _shouldPreserveCellBlock → false (선택 영역 아님)
   → _onClick 도달 → box 찾음 → 셀 블록 해제 → 기존 box 선택 수행

3. 사용자가 table 외부 빈 공간 클릭
   → _onMouseDown: _shouldPreserveCellBlock → false (table 외부)
   → 마키 시작 전 셀 블록 해제
   → _onClick 도달 → box 못 찾음 → 셀 블록 해제(이미 해제됨) + clearLayoutSelection

4. 사용자가 table 외부 빈 공간 드래그 (마키 선택)
   → _onMouseDown: _shouldPreserveCellBlock → false (table 외부)
   → 마키 시작 전 셀 블록 해제
   → 마키 선택 진행

5. 사용자가 paragraph 더블클릭 (텍스트 편집 진입)
   → _onDblClick: textEditMode = true (셀 블록 유지)
   → 텍스트 편집 모드 + 셀 블록 활성 → 방향키 = 셀 블록 range 확장 (테이블 제어 우선)
   → 텍스트 편집 모드 + 셀 블록 비활성 → 방향키 = 텍스트 커서 이동
```

### 8B.11 검증 시나리오

| 시나리오 | 트리거 | 기대 동작 | 검증 방법 |
|---|---|---|---|
| F5 1회 | F5 | 현재 셀 1개 선택, 회색 원 표시 | selection.mode='single', 원 1개 |
| F5 2회 | F5 | 범위 선택 모드, 빨간 원 표시 | selection.mode='range', 방향키로 확장 |
| F5 3회 | F5 | 전체 셀 선택, 빨간 원 | selection.mode='all', 모든 셀에 원 |
| F5 4회 | F5 | single 모드로 재시작 | 모드 순환 |
| F7 | F7 | 열 전체 선택 | selectMode='col', 해당 열 모든 셀 |
| F8 | F8 | 행 전체 선택 | selectMode='row', 해당 행 모든 셀 |
| 방향키 (range) | ↑↓←→ | focus 이동, 선택 영역 확장 | focus 좌표 변경 |
| Alt+→ | Alt+Right | focus.col 너비 +1mm, 인접 col -1mm | colWidths 변경, 총폭 유지 |
| Alt+← | Alt+Left | focus.col 너비 -1mm, 인접 col +1mm | colWidths 변경, 총폭 유지 |
| Alt+↓ | Alt+Down | focus.row 높이 +1mm, 인접 row -1mm | rowHeights 변경, 총높이 유지 |
| Alt+↑ | Alt+Up | focus.row 높이 -1mm, 인접 row +1mm | rowHeights 변경, 총높이 유지 |
| M | M | 선택 셀 병합 | colspan/rowspan 증가, 셀 수 감소 |
| S | S | 분할 대화상자 호출 | 콜백으로 splitCell 실행 |
| W | W | 선택 열 너비 균등 배분 | colWidths 균등 |
| H | H | 선택 행 높이 균등 배분 | rowHeights 균등 |
| Alt+Insert | Alt+Insert | 행/열 추가 | 행/열 수 증가 |
| Alt+Delete | Alt+Delete | 행/열 삭제 | 행/열 수 감소 |
| ESC | ESC | 셀 블록 선택 해제 | selection=null, 원 제거 |
| 선택된 TD 내 box 클릭 | 마우스 | 셀 블록 유지, box 선택 수행 안 함 | selection 유지, box 선택 미발생 |
| 선택 영역 외부 box 클릭 | 마우스 | 셀 블록 해제, box 선택으로 전환 | selection=null, box 선택 발생 |
| table 외부 클릭 | 마우스 | 셀 블록 + box 선택 모두 해제 | selection=null, box 선택 해제 |
| 텍스트 편집 중 F5 | F5 | 셀 블록 지정 동작 | selection 갱신 (텍스트 입력과 충돌 없음) |
| 텍스트 편집 중 M | M | 셀 블록 활성 시에만 동작 | 셀 블록 비활성 → 무시, 텍스트 입력으로 처리 |
| 텍스트 편집 중 Alt+→ | Alt+Right | 셀 크기 조절 동작 | colWidths 변경 (텍스트 입력과 충돌 없음) |
| 외부 API: mergeCells | 툴바 버튼 | 키보드 M과 동일 동작 | 동일 결과 |
| 외부 API: insertRowOrCol | 툴바 버튼 | 키보드 Alt+Insert와 동일 | 동일 결과 |
| 외부 API: splitCell | 툴바 버튼 | 키보드 S와 동일 (대화상자 없이 직접 호출) | 동일 결과 |
| 텍스트 편집 모드 | F5 | 비활성 (이벤트 무시) | 처리 안 됨 |
| 인쇄 모드 | F5 | 비활성 | 컨트롤러 미생성 |

---

## 9. React 래퍼

### 9.1 신규 파일: `src/react/components/layout-table.tsx`

```tsx
import * as React from 'react';
import type { TableData, TableRowData, TableCellData } from '@/types';

export interface LayoutTableProps {
  data: TableData;
  ref?: React.Ref<LayoutTableElement>;
}

export interface LayoutTRProps {
  data: TableRowData;
  ref?: React.Ref<LayoutTableRowElement>;
}

export interface LayoutTDProps {
  data: TableCellData;
  ref?: React.Ref<LayoutTableCellElement>;
}

export const LayoutTable = /* ref 전달 + data prop 매핑 컴포넌트 */;
export const LayoutTR = /* 동일 패턴 */;
export const LayoutTD = /* 동일 패턴 */;
```

기존 `LayoutBox`/`LayoutParagraph` 컴포넌트와 동일 패턴 (forwardRef, useEffect로 data setter 호출, cleanup으로 disconnectedCallback 보장).

### 9.2 `src/react/index.ts`
```typescript
export * from "./components/layout-table";
// 기존 export 유지
```

---

## 10. 파일 레이아웃 요약

### 신규 파일
| 파일 | 역할 |
|---|---|
| `src/types/layout/table.type.ts` | TableData, TableRowData, TableCellData, CellBorderEdge 타입 |
| `src/core/table-grid-resolver.ts` | resolveTableGrid() — 그리드 배치 알고리즘 |
| `src/core/border-resolver.ts` | resolveTableBorders() — 보더 공유/중복 제거 알고리즘 |
| `src/components/layout/table.element.ts` | LayoutTableElement — 테이블 컨테이너, 보더 레이어, 리사이즈 핸들/상태 관리, `type`/`items`/`overlayElements`/`printPostData` getter |
| `src/components/layout/tr.element.ts` | LayoutTableRowElement — 행, `type`/`items`/`overlayElements`/`printPostData` getter |
| `src/components/layout/td.element.ts` | LayoutTableCellElement — 셀 (box-equivalent), `_updateChildBoxResizeVisibility()` (전략 B), `isBoxFillingCell` 판별, `type`/`overlayElements`/`printPostData` getter |
| `src/utils/table-utils.ts` | `isBoxFillingCell` 유틸 (전략 B — TD 꽉 채움 판별) |
| `src/types/edit/table-selection.type.ts` | `TableCellSelection`, `CellBlockMode`, `CellCoord`, `TableCellSelectionChangeDetail` 타입 (섹션 8B) |
| `src/edit/table-keyboard-controller.ts` | `TableKeyboardController` — 키보드 입력 처리 (F5/F7/F8/Alt+방향키/M/S/W/H/Alt+Insert/Delete/ESC), 셀 블록 선택 관리, 선택 오버레이 렌더링 (섹션 8B) |
| `src/edit/table-structure-editor.ts` | `TableStructureEditor` — 셀 구조 변경 (merge/split/equalize/insert/delete), 외부 API public 메서드 제공 (섹션 8B) |
| `src/react/components/layout-table.tsx` | LayoutTable, LayoutTR, LayoutTD React 래퍼 |

### 수정 파일
| 파일 | 수정 내용 |
|---|---|
| `src/types/layout/box.type.ts` | `BoxData.children` 유니온에 `TableData` 추가 |
| `src/types/layout/index.ts` | `table.type` export 추가 |
| `src/types/print/post-data.type.ts` | `PrintPostData` 제네릭에 `TableData`/`TableRowData`/`TableCellData` 추가, `PrintPostBorderEdge`/`PrintPostDiagonal` 신규 타입 |
| `src/constants/defaults.ts` | `Z_INDEX_TABLE_BORDER`, `Z_INDEX_TABLE_DIAGONAL`, `Z_INDEX_TABLE_RESIZE`, `Z_INDEX_TABLE_SELECTION`, `MIN_TABLE_COL_WIDTH` (5mm), `MIN_TABLE_ROW_HEIGHT` (5mm), `TABLE_KEYBOARD_RESIZE_STEP` 상수 |
| `src/core/index.ts` | table-grid-resolver, border-resolver export |
| `src/components/layout/box.element.ts` | `appendChildData`, `_appendChildData`, `data` setter, `_serializeChildren`, `contentType`, `contentElement`에 table 분기 추가, `[hide-resize]` 속성 지원 (전략 B), `hideResizeHandles` setter, `_collectParagraphs`에 table/TR/TD 재귀 추가 (섹션 8.8.5), `printPostData` 순회 시 table/TR/TD 포함 (섹션 8.9.9) |
| `src/components/layout/index.ts` | table/tr/td export |
| `src/edit/edit-manager.ts` | `LayoutElement` 타입에 `LayoutTableCellElement` 추가, 관련 함수 시그니처 일반화, `tableCellSelectionChange` 이벤트 추가 (섹션 8B) |
| `src/edit/layout-selection-controller.ts` | TD 선택 인식 |
| `src/edit/layout-edit-controller.ts` | TD 드래그 시 부모 box 승격, TD 개별 리사이즈 비활성화 (테이블 리사이즈는 LayoutTableElement가 자체 처리) |
| `src/edit/insert-controller.ts` | TD를 insert 타겟으로 인식 |
| `src/components/layout/table.element.ts` | `TableKeyboardController`/`TableStructureEditor` 통합, `_activateTableEditing`/`_deactivateTableEditing`, 선택 오버레이 렌더링 (`_renderSelectionOverlay`/`_clearSelectionOverlay`/`_findPlacementAt`/`_getSelectionCoords`), `keyboardController`/`structureEditor` getter (섹션 8B) |
| `src/react/index.ts` | table 래퍼 export |
| `docs/API.md` | table/tr/td API 문서 |
| `docs/TEXT_ENGINE.md` | TD 내 paragraph 렌더링 설명 |
| `docs/EDITING_LAYOUT.md` | TD 선택, 셀 너비/행 높이 리사이즈 동작, 테이블 reparent |
| `docs/EDITING_INSERT.md` | TD insert 타겟 |
| `docs/REACT_COMPONENT.md` | LayoutTable/TR/TD 컴포넌트 |
| `AGENTS.md` | 디렉토리 구조, Custom Element Tree, BoxData.children 유니온 갱신 |

---

## 11. 구현 순서 (권장 단계)

### Phase 1: 타입 + 코어 알고리즘 (검증 가능 단위)
1. `src/types/layout/table.type.ts` 작성
2. `src/types/layout/index.ts` export 추가
3. `src/types/layout/box.type.ts` `children` 유니온 확장
4. `src/core/table-grid-resolver.ts` 작성 + 단위 테스트(임시)
5. `src/core/border-resolver.ts` 작성 + 단위 테스트(임시)
6. `src/core/index.ts` export 추가
7. `src/constants/defaults.ts` 상수 추가

### Phase 2: 커스텀 요소 (렌더링 확인 + overlap/printPostData 호환성)
8. `src/types/print/post-data.type.ts` `PrintPostData` 제네릭 확장 + `PrintPostBorderEdge`/`PrintPostDiagonal` 타입 추가
9. `src/components/layout/td.element.ts` 작성 (type/overlayElements/printPostData getter 포함 — 섹션 8.8, 8.9)
10. `src/components/layout/tr.element.ts` 작성 (type/items/overlayElements/printPostData getter 포함)
11. `src/components/layout/table.element.ts` 작성 (type/items/overlayElements/printPostData getter 포함)
12. `src/components/layout/index.ts` export 추가 + customElements.define
13. `src/components/layout/box.element.ts` table 인식 수정, `printPostData` 순회 시 table 포함

### Phase 3: dev 예제 추가
13. `src/examples/example-data.ts` 에 table 예제 데이터 추가
14. `examples/index.html` 에 table 데모 추가
15. `npm run dev` 로 렌더링 확인

### Phase 4: 편집 통합 (선택 + 드래그)
16. `src/edit/edit-manager.ts` LayoutElement 확장
17. `src/edit/layout-selection-controller.ts` TD 선택
18. `src/edit/layout-edit-controller.ts` TD 드래그 시 부모 box 승격
19. `src/edit/insert-controller.ts` TD insert 타겟
20. `npm run dev` 로 편집 동작 확인

### Phase 4.5: 테이블 리사이즈 (셀 너비/행 높이 + 중첩 해결)
21. `src/constants/defaults.ts` `MIN_TABLE_COL_WIDTH`/`MIN_TABLE_ROW_HEIGHT`/`Z_INDEX_TABLE_RESIZE` 상수 추가
22. `src/components/layout/table.element.ts` 리사이즈 핸들 렌더링(`_renderResizeHandles`), 활성 핸들 판별 알고리즘, `TableResizeState`, mousedown/mousemove/mouseup/keydown 핸들러, `_applyColumnResize`/`_applyRowResize` 구현
23. `src/components/layout/box.element.ts` `[hide-resize]` 속성 CSS 규칙 + `hideResizeHandles` setter 추가 (전략 B)
24. `src/components/layout/td.element.ts` `isBoxFillingCell` 유틸 + `_updateChildBoxResizeVisibility()` 구현, `layout()`에 호출 추가 (전략 B)
25. `LayoutBoxElement` editableLayout 전파 시 table 자식에 `[editable-layout]` 속성 부여
26. `src/edit/edit-manager.ts` `_dispatchBoxPropertyChange`에 `table-grid` property 지원
27. `npm run dev` 로 리사이즈 동작 확인 (수직/수평 핸들, colspan/rowspan 비활성, ESC 취소, 최소 크기, TD 꽉 채운 box resizer 숨김)

### Phase 4.6: 키보드 기반 레이아웃 편집 (섹션 8B)
28. `src/types/edit/table-selection.type.ts` 작성 (`TableCellSelection`, `CellBlockMode`, `CellCoord`, `TableCellSelectionChangeDetail`)
29. `src/types/edit/index.ts` export 추가
30. `src/constants/defaults.ts` `Z_INDEX_TABLE_SELECTION`/`TABLE_KEYBOARD_RESIZE_STEP` 상수 추가
31. `src/edit/table-structure-editor.ts` 작성 — `TableStructureEditor` 클래스 (merge/split/equalizeWidth/equalizeHeight/insertRowOrCol/deleteRowOrCol public 메서드)
32. `src/edit/table-keyboard-controller.ts` 작성 — `TableKeyboardController` 클래스 (handleKeyDown 라우팅, F5/F7/F8 모드 전환, 방향키 focus 이동, Alt+방향키 크기 조절, 구조 변경 키 위임, ESC 해제, 선택 오버레이 렌더링)
33. `src/components/layout/table.element.ts`에 `_keyboardController`/`_structureEditor`/`_selectionLayerEl`/`_selectionCircleMap` 멤버 추가, `keyboardController`/`structureEditor` getter, `_activateTableEditing`/`_deactivateTableEditing`/`_onTableKeyDown`/`_renderSelectionOverlay`/`_clearSelectionOverlay`/`_findPlacementAt`/`_getSelectionCoords` 구현, EditManager modeChange 이벤트 리스너 연동
34. `src/edit/edit-manager.ts` `tableCellSelectionChange` 이벤트 타입 + dispatch 지원 추가
35. `npm run dev`로 키보드 편집 동작 확인 (F5 1/2/3회 모드 전환, F7/F8 행/열 선택, 방향키 범위 확장, Alt+방향키 크기 조절, M/S/W/H/Alt+Insert/Alt+Delete, ESC 해제, 외부 API 호출)

### Phase 5: React 래퍼
36. `src/react/components/layout-table.tsx` 작성
37. `src/react/index.ts` export 추가

### Phase 6: 빌드 검증
38. `npm run build` — IIFE + React ESM + .d.ts 생성 확인
39. `npm run build:obfuscate` — 난독화 빌드 확인

### Phase 7: 문서화
40. `docs/API.md` 갱신
41. `docs/TEXT_ENGINE.md` 갱신
42. `docs/EDITING_LAYOUT.md` 갱신 (셀/행 리사이즈 동작, 키보드 편집 포함)
43. `docs/EDITING_INSERT.md` 갱신
44. `docs/REACT_COMPONENT.md` 갱신
45. `AGENTS.md` 갱신

---

## 12. 검증 체크리스트

### 12.1 타입/컴파일
- [ ] `npm run build` 성공 (tsc noEmit 타입체크 + Vite 컴파일)
- [ ] `noUnusedLocals`/`noUnusedParameters` 위반 없음
- [ ] `.d.ts` 에 TableData/TableRowData/TableCellData/CellBorderEdge export 포함
- [ ] `dist/layout-element.iife.js` 에 table/tr/td 포함
- [ ] `dist/layout-element-react.mjs` 에 LayoutTable/TR/TD 포함

### 12.2 렌더링
- [ ] 단일 셀 테이블 렌더링 (1×1)
- [ ] 다중 셀 (3×3) 균등 분할
- [ ] colWidths 명시적 지정 (비대칭)
- [ ] colspan 병합 (2셀 병합)
- [ ] rowspan 병합 (2행 병합)
- [ ] colspan + rowspan 동시
- [ ] 셀 배경색 + 투명도
- [ ] 셀 내 paragraph 렌더링 (1단)
- [ ] 셀 내 paragraph 다단 (paragraph.columns=3)
- [ ] 셀 내 image 렌더링
- [ ] 중첩 테이블 (table in box in td in table)

### 12.3 보더
- [ ] 단일 셀 4방향 보더
- [ ] 인접 셀 공유 (A.right = B.left, 하나만 렌더링)
- [ ] 첫 col left+right, 이후 col right만
- [ ] 첫 row top+bottom, 이후 row bottom만
- [ ] 충돌 시 나중 등장 우선 (B.borderLeft > A.borderRight)
- [ ] override 주입 시 최우선
- [ ] 보더 없음 (선언 누락) → 엣지 생략
- [ ] 인쇄 모드에서 보더 숨김

### 12.2A 셀 크기 관리 (정규화 규칙)
- [ ] 최소 셀 너비 = 5mm (MIN_TABLE_COL_WIDTH)
- [ ] 최소 셀 높이 = 5mm (MIN_TABLE_ROW_HEIGHT)
- [ ] 최초 데이터 주입 시 colWidths 합 = contentWidth (테이블 크기 유지)
- [ ] 최초 데이터 주입 시 rowHeights 합 = contentHeight (테이블 크기 유지)
- [ ] 최초 주입 시 colWidths 합 > contentWidth → 앞순서 셀 우선, 나머지 조정
- [ ] 최초 주입 시 rowHeights 합 > contentHeight → 앞순서 셀 우선, 나머지 조정
- [ ] 앞순서 셀 우선 시 나머지 셀 최소 5mm 보장
- [ ] 최소 크기로도 contentWidth 초과 시 균등 축소 + warning
- [ ] 최소 크기로도 contentHeight 초과 시 균등 축소 + warning
- [ ] 마우스 리사이즈 시 colWidths 합 = contentWidth 유지 (인접 col에서 차감/추가)
- [ ] 마우스 리사이즈 시 rowHeights 합 = contentHeight 유지 (인접 row에서 차감/추가)
- [ ] 마우스 리사이즈 시 최소 5mm 이하 축소 불가
- [ ] Alt+방향키 리사이즈 시 총폭/총높이 유지
- [ ] Alt+방향키 리사이즈 시 최소 5mm 이하 축소 불가
- [ ] 행/열 추가 시 새 행/열 크기 존중, 나머지 균등 축소
- [ ] 행/열 추가 시 나머지 셀 최소 5mm 보장
- [ ] 행/열 삭제 시 남은 셀들 크기 재분배 (총 크기 유지)

### 12.4 대각선
- [ ] tl-br 대각선
- [ ] tr-bl 대각선
- [ ] X (두 대각선)
- [ ] 인쇄 모드에서 숨김

### 12.5 편집 (선택/드래그/insert)
- [ ] TD 클릭 선택
- [ ] TD 내 box 클릭 시 box 선택
- [ ] TD 내 paragraph 더블클릭 → 텍스트 편집 모드
- [ ] InsertController가 TD를 insert 타겟으로 인식
- [ ] TD 내 box reparent (다른 TD로 이동)
- [ ] TD lock 전파 (조상 lock 시 하위 편집 차단)
- [ ] 부모 box 드래그 시 테이블 전체 이동
- [ ] 부모 box 리사이즈 시 테이블 재배치

### 12.5A 테이블 리사이즈 (셀 너비/행 높이)
- [ ] 편집 모드 진입 시 수직/수평 핸들 표시
- [ ] 편집 모드 종료 시 핸들 숨김
- [ ] 인쇄 모드에서 핸들 숨김
- [ ] **table resizer는 선택 여부와 무관하게 항상 표시** (전략 C)
- [ ] 수직 핸들 드래그 → colWidths 재분배 (총폭 유지)
- [ ] 수평 핸들 드래그 → rowHeights 재분배 (총높이 유지)
- [ ] 최소 너비/높이(5mm) 이하 축소 불가
- [ ] colspan 셀이 걸친 열 경계 핸들 비활성화
- [ ] rowspan 셀이 걸친 행 경계 핸들 비활성화
- [ ] ESC 키 리사이즈 취소 (원래 값 복원)
- [ ] 리사이즈 중 TD 내 paragraph 자동 리렌더 (텍스트 재래핑)
- [ ] 리사이즈 종료 시 `boxPropertyChange` 이벤트 발생
- [ ] 조상 box lock 시 모든 핸들 비활성화

### 12.5B 핸들 중첩 해결 (전략 B+C)
- [ ] TD를 꽉 채우는 box의 resizer 숨김 (`[hide-resize]`)
- [ ] TD를 꽉 채우는 box 드래그 이동 가능 (resizer만 숨김)
- [ ] TD 안에 복수 box 시 모든 box resizer 표시 (부분 배치)
- [ ] 부분 배치 box resizer와 table resizer 시각적 중첩 없음
- [ ] box 선택 시 table resizer 유지 (숨기지 않음)
- [ ] TD 꽉 채움 판별 정확성 (static/absolute 모두)

### 12.5C 키보드 기반 레이아웃 편집 (섹션 8B)
- [ ] F5 1회 → single 모드, 현재 셀 1개 선택 (회색 원)
- [ ] F5 2회 → range 모드 (빨간 원), 방향키로 확장 가능
- [ ] F5 3회 → all 모드, 전체 셀 선택 (빨간 원)
- [ ] F5 4회 → single 모드로 재시작 (모드 순환)
- [ ] F7 → 열 전체 선택 (selectMode='col')
- [ ] F8 → 행 전체 선택 (selectMode='row')
- [ ] 범위 선택 모드에서 방향키 → focus 이동, 선택 영역 확장
- [ ] F7 상태에서 좌우 방향키 → 열 이동 (행 이동 무시)
- [ ] F8 상태에서 상하 방향키 → 행 이동 (열 이동 무시)
- [ ] Alt+→ → focus.col 너비 +1mm, 인접 col -1mm (총폭 유지)
- [ ] Alt+← → focus.col 너비 -1mm, 인접 col +1mm (총폭 유지)
- [ ] Alt+↓ → focus.row 높이 +1mm, 인접 row -1mm (총높이 유지)
- [ ] Alt+↑ → focus.row 높이 -1mm, 인접 row +1mm (총높이 유지)
- [ ] Alt+방향키 최소 크기 보장 (MIN_TABLE_COL_WIDTH/MIN_TABLE_ROW_HEIGHT)
- [ ] M → 선택 셀 병합 (colspan/rowspan 증가, 셀 수 감소)
- [ ] M → 병합된 셀의 children(box) 이동 정상
- [ ] S → 분할 대화상자 호출 → splitCell 실행
- [ ] S → 분할 후 셀 수 증가, colspan/rowspan 감소
- [ ] W → 선택 열 너비 균등 배분
- [ ] H → 선택 행 높이 균등 배분
- [ ] Alt+Insert → 행/열 추가 (행/열 수 증가)
- [ ] Alt+Delete → 행/열 삭제 (행/열 수 감소)
- [ ] Alt+Delete → 마지막 행/열 삭제 시 에러 (최소 1개 유지)
- [ ] ESC → 셀 블록 선택 해제 (selection=null, 원 제거)
- [ ] 텍스트 편집 모드에서 F5 → 셀 블록 지정 동작 (텍스트 입력과 충돌 없음)
- [ ] 텍스트 편집 모드에서 F7/F8 → 행/열 선택 동작
- [ ] 텍스트 편집 모드에서 Alt+방향키 → 셀 크기 조절 동작
- [ ] 텍스트 편집 모드에서 ESC → 셀 블록 활성 시 해제, 비활성 시 TextEditController ESC 전파
- [ ] 텍스트 편집 모드에서 M/S/W/H → 셀 블록 활성 시에만 동작, 비활성 시 텍스트 입력으로 처리
- [ ] 텍스트 편집 모드에서 Alt+Insert/Delete → 셀 블록 활성 시에만 동작
- [ ] 인쇄 모드에서 키보드 컨트롤러 미생성
- [ ] 셀 블록 선택된 TD 내 box 클릭 → 셀 블록 유지, box 선택 수행 안 함
- [ ] 셀 블록 선택된 TD 내 box 클릭 시 _onClick 도달 차단 (stopPropagation)
- [ ] 셀 블록 선택된 TD 내 box 클릭 시 텍스트 편집 모드여도 셀 블록 유지 동작
- [ ] 셀 블록 선택 영역 외부 box 클릭 → 셀 블록 해제, box 선택으로 전환
- [ ] table 외부 클릭 → 셀 블록 + box 선택 모두 해제
- [ ] 마키 선택 시작 시 셀 블록 해제 (_onMouseDown)
- [ ] 더블클릭 텍스트 편집 진입 시 셀 블록 유지 (_onDblClick이 셀 블록 해제 안 함)
- [ ] 텍스트 편집 모드 + 셀 블록 활성 → 방향키 = 셀 블록 range 확장 (테이블 제어 우선)
- [ ] 텍스트 편집 모드 + 셀 블록 비활성 → 방향키 = 텍스트 커서 이동 (TextEditController로 전파)
- [ ] 외부 API: `tableEl.structureEditor.mergeCells(selection)` → 키보드 M과 동일
- [ ] 외부 API: `tableEl.structureEditor.insertRowOrCol('row')` → 키보드 Alt+Insert와 동일
- [ ] 외부 API: `tableEl.structureEditor.splitCell(coord, rows, cols)` → 키보드 S와 동일
- [ ] 외부 API: `tableEl.structureEditor.equalizeWidth(selection)` → 키보드 W와 동일
- [ ] 외부 API: `tableEl.structureEditor.equalizeHeight(selection)` → 키보드 H와 동일
- [ ] 외부 API: `tableEl.structureEditor.deleteRowOrCol('col')` → 키보드 Alt+Delete와 동일
- [ ] `tableCellSelectionChange` 이벤트 dispatch 정상
- [ ] 편집 모드 종료 시 컨트롤러 비활성화 + 선택 오버레이 제거

### 12.6 데이터 직렬화
- [ ] `box.data` getter → TableData 포함
- [ ] `td.data` getter → TableCellData
- [ ] `tr.data` getter → TableRowData
- [ ] ID-keyed reconciliation (동일 id 유지)
- [ ] undo/redo 시 이미지 캐시 유지 (box 패턴과 동일)

### 12.7 Overlap 처리 (table 컨텍스트)
- [ ] TD 내 image box + paragraph box → paragraph가 같은 TD 내 image 주변으로 흐름
- [ ] 인접 TD에 image box → paragraph가 인접 TD image 주변으로 흐르지 않음
- [ ] **table 외부(형제)에 image box → paragraph가 table 외부 image 주변으로 흐름 (table은 하나의 덩어리)**
- [ ] **table 상위(box 조상)에 image box → paragraph가 상위 image 주변으로 흐름 (재귀)**
- [ ] TD 내 복수 box (image + paragraph) → overlap 정상 동작
- [ ] 중첩 테이블 (TD 내 table) → 중첩 TD 내 image + 외부 image 모두 overlap 적용
- [ ] `TD/TR/table.type` 프로퍼티 반환 (`'td'`/`'tr'`/`'table'`)
- [ ] `TD/TR/table.overlayElements` 부모로 재귀 전달
- [ ] `TD/TR/table.items` getter 정상 동작
- [ ] `_collectParagraphs`에 table/TR/TD 재귀 처리 추가됨

### 12.8 PrintPostData (인쇄 후처리)
- [ ] table `printPostData` → table rect + borderEdges(셀 간 그리드 라인) 포함
- [ ] TR `printPostData` → TR 자체 항목 없음, TD 재귀만
- [ ] TD `printPostData` → TD rect + backgroundColor + diagonals + 자식 box 재귀
- [ ] TD 내 box `printPostData` → 절대 위치 rect (getBoundingClientRect 기반)
- [ ] TD 내 paragraph `printPostData` → 절대 위치 rect + chars
- [ ] TD 내 image `printPostData` → 절대 위치 rect
- [ ] 중첩 테이블 → 중첩 TD 내 box도 절대 위치
- [ ] `PrintPostData` 타입에 `TableData`/`TableRowData`/`TableCellData` 제네릭 추가
- [ ] `PrintPostBorderEdge`/`PrintPostDiagonal` 신규 타입 정의
- [ ] box `printPostData` 순회 시 table/TR/TD 포함 (`Array.from(this.children)` 직접 순회)

---

## 13. 해결 필요 설계 포인트 (구현 전 결정)

1. **~~TD 리사이즈 UX~~** → **해결**: 마우스 드래그로 셀 너비/행 높이 조정 지원 (섹션 8A 참조). 부모 box 리사이즈 + 개별 colWidths/rowHeights 핸들 조정 모두 1차 구현에 포함. 키보드 기반 크기 조절(Alt+방향키)도 섹션 8B에 추가.
2. **행 높이 합 vs box 높이**: `sum(rowHeights)` ≠ box 콘텐츠 높이일 때 비례 정규화 권장 + `render-error` 경고.
3. **대각선 색상/두께 소스**: 1차는 `borderTop`(또는 첫 선언된 보더 엣지) 재사용. 별도 `diagonalColor`/`diagonalWidth` 필드 추가 검토.
4. **중첩 테이블 깊이 제한**: 무한 중첩 방지를 위한 깊이 제한 (예: 5단계) 검토.
5. **TD lock**: `TableCellData`에 `lock?: boolean` 필드 추가 여부. 추가 시 `_isBoxOrAncestorLocked` 확장 필수.
6. **`LayoutElement` 타입 확장 영향도**: `edit-manager.ts`/`layout-edit-controller.ts`의 box-특화 함수들을 TD로 일반화하는 작업 범위. 1차는 TD 편집 기능을 최소화(선택만)하여 영향도 제한 권장.
7. **~~Split 대화상자 UI~~** → **해결**: `handleSplit()`은 콜백 기반으로 설계되어 있으나, 실제 대화상자 UI(행/열 분할 수 입력)는 외부에서 제공해야 함. 외부 편집기가 대화상자를 띄우고 `splitCell(coord, rows, cols)`를 직접 호출하는 방식. 1차 구현은 대화상자 없이 `splitCell()` public API만 제공.
8. **~~Alt+Insert/Delete 행/열 판별~~** → **해결**: `selectMode`가 `'col'`(F7)이면 열, `'row'`(F8)이면 행, 기본(`'cell'`)은 행으로 판별. `handleKeyDown`에서 `selectMode` 기반 분기.
9. **~~셀 블록 선택과 box 선택의 공존~~** → **해결**: 섹션 8B.10에서 정책 확정 — 선택된 TD 내 box 클릭 시 셀 블록 유지, 영역 외부 클릭 시 셀 블록 해제 + box 선택으로 전환. `LayoutSelectionController._shouldPreserveCellBlock()`으로 판별.
10. **~~키보드 컨트롤러 활성화 조건~~** → **해결**: 텍스트 편집 모드에서도 F5/F7/F8/Alt+방향키/ESC 동작 (셀 블록 지정은 텍스트 입력과 충돌하지 않음). 구조 변경(M/S/W/H/Alt+Insert/Delete)은 셀 블록 활성 시에만 동작. keydown 리스너는 capture phase로 등록하여 TextEditController보다 먼저 수신.
11. **Insert/Delete 시 colspan/rowspan 조정 알고리즘**: 행/열 추가·삭제 시 기존 셀의 colspan/rowspan이 추가/삭제 위치를 걸치면 증가/감소시켜야 함. 1차 구현은 기본 케이스(단일 span 셀)만 처리하고, 복잡한 중첩 span 케이스는 warning + 클램프. 구체 알고리즘은 구현 단계에서 보강.

---

## 부록 A: 의사 코드의 TypeScript 변환 가이드

개발자는 위 의사 코드를 다음 원칙으로 변환:

1. **타입 명시**: 모든 변수/매개변수/반환값에 TypeScript 타입 명시.
2. **JSDoc 필수**: 모든 함수/클래스/인터페이스에 `@param`/`@returns`/`@throws` 포함. 복잡한 로직은 `@example` 추가.
3. **`noUnusedLocals` 준수**: 임시 변수/미사용 매개변수 즉시 제거.
4. **에러 처리**: `throw new Error()` 로 명시적 에러. silent failure 금지.
5. **Shadow DOM**: `this.attachShadow({ mode: "open" })` 로 초기화, `styleEl.sheet.insertRule()` 로 스타일 주입.
6. **Custom Element 라이프사이클**: `connectedCallback`/`disconnectedCallback`/`attributeChangedCallback` 구현.
7. **mm→px 변환**: `GridCalculator.ppm` 사용. `Math.ceil()` 로 픽셀 반올림 (기존 box 패턴).
8. **색상**: `ColorRegistry.getInstance().getCSSColor(name)` + `getOpacityHex(opacity)` 사용.
9. **GridCalculator**: `GridCalculator.create()` 로만 인스턴스화. `private constructor` 강제.
10. **InheritStyle**: 부모 → 자식 전파는 `_propagateInheritStyle()` 에서 수행.

---

이 문서는 그린필드 개발자가 위에서 아래로 순차적으로 읽으며 구현할 수 있도록 작성되었다. Phase 1~7 순서로 진행하고, 각 Phase 완료 시 검증 체크리스트의 해당 항목을 확인할 것.