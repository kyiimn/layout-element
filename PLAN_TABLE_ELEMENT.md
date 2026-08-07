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
 *   [60, 40], // colWidths
 * );
 * // result.placements[0] → { gridCol: 0, gridRow: 0, spanCols: 2, x: 0, y: 0, width: 100, height: 10 }
 * // result.placements[1] → { gridCol: 2, gridRow: 0, spanCols: 1, x: 100, y: 0, width: ... }
 * // (위 예시는 컬럼이 2개뿐이므로 colspan=2가 전체 차지 → 두 번째 셀은 다음 행으로)
 */
export function resolveTableGrid(
  rows: TableRowData[],
  contentWidth: number,
  colWidthsInput: number | number[] | undefined,
): GridResolution;
```

### 4.2 구현 의사 코드 (개발자용)

```
function resolveTableGrid(rows, contentWidth, colWidthsInput):
  rowHeights = rows.map(r => r.height)

  // 1. 컬럼 수 계산
  maxCellsInRow = max(rows.map(r => r.children.length))
  if colWidthsInput is number[]:
    colCount = colWidthsInput.length
  else if colWidthsInput is number:
    colCount = maxCellsInRow
  else: // undefined
    colCount = maxCellsInRow

  // 2. colWidths 정규화
  if colWidthsInput is number[]:
    colWidths = colWidthsInput
  else if colWidthsInput is number:
    colWidths = new Array(colCount).fill(colWidthsInput)
  else:
    eachWidth = contentWidth / colCount
    colWidths = new Array(colCount).fill(eachWidth)

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
| `src/react/components/layout-table.tsx` | LayoutTable, LayoutTR, LayoutTD React 래퍼 |

### 수정 파일
| 파일 | 수정 내용 |
|---|---|
| `src/types/layout/box.type.ts` | `BoxData.children` 유니온에 `TableData` 추가 |
| `src/types/layout/index.ts` | `table.type` export 추가 |
| `src/types/print/post-data.type.ts` | `PrintPostData` 제네릭에 `TableData`/`TableRowData`/`TableCellData` 추가, `PrintPostBorderEdge`/`PrintPostDiagonal` 신규 타입 |
| `src/constants/defaults.ts` | `Z_INDEX_TABLE_BORDER`, `Z_INDEX_TABLE_DIAGONAL`, `Z_INDEX_TABLE_RESIZE`, `MIN_TABLE_COL_WIDTH`, `MIN_TABLE_ROW_HEIGHT` 상수 |
| `src/core/index.ts` | table-grid-resolver, border-resolver export |
| `src/components/layout/box.element.ts` | `appendChildData`, `_appendChildData`, `data` setter, `_serializeChildren`, `contentType`, `contentElement`에 table 분기 추가, `[hide-resize]` 속성 지원 (전략 B), `hideResizeHandles` setter, `_collectParagraphs`에 table/TR/TD 재귀 추가 (섹션 8.8.5), `printPostData` 순회 시 table/TR/TD 포함 (섹션 8.9.9) |
| `src/components/layout/index.ts` | table/tr/td export |
| `src/edit/edit-manager.ts` | `LayoutElement` 타입에 `LayoutTableCellElement` 추가, 관련 함수 시그니처 일반화 |
| `src/edit/layout-selection-controller.ts` | TD 선택 인식 |
| `src/edit/layout-edit-controller.ts` | TD 드래그 시 부모 box 승격, TD 개별 리사이즈 비활성화 (테이블 리사이즈는 LayoutTableElement가 자체 처리) |
| `src/edit/insert-controller.ts` | TD를 insert 타겟으로 인식 |
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

### Phase 5: React 래퍼
26. `src/react/components/layout-table.tsx` 작성
27. `src/react/index.ts` export 추가

### Phase 6: 빌드 검증
28. `npm run build` — IIFE + React ESM + .d.ts 생성 확인
29. `npm run build:obfuscate` — 난독화 빌드 확인

### Phase 7: 문서화
30. `docs/API.md` 갱신
31. `docs/TEXT_ENGINE.md` 갱신
32. `docs/EDITING_LAYOUT.md` 갱신 (셀/행 리사이즈 동작 포함)
33. `docs/EDITING_INSERT.md` 갱신
34. `docs/REACT_COMPONENT.md` 갱신
35. `AGENTS.md` 갱신

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

1. **~~TD 리사이즈 UX~~** → **해결**: 마우스 드래그로 셀 너비/행 높이 조정 지원 (섹션 8A 참조). 부모 box 리사이즈 + 개별 colWidths/rowHeights 핸들 조정 모두 1차 구현에 포함.
2. **행 높이 합 vs box 높이**: `sum(rowHeights)` ≠ box 콘텐츠 높이일 때 비례 정규화 권장 + `render-error` 경고.
3. **대각선 색상/두께 소스**: 1차는 `borderTop`(또는 첫 선언된 보더 엣지) 재사용. 별도 `diagonalColor`/`diagonalWidth` 필드 추가 검토.
4. **중첩 테이블 깊이 제한**: 무한 중첩 방지를 위한 깊이 제한 (예: 5단계) 검토.
5. **TD lock**: `TableCellData`에 `lock?: boolean` 필드 추가 여부. 추가 시 `_isBoxOrAncestorLocked` 확장 필수.
6. **`LayoutElement` 타입 확장 영향도**: `edit-manager.ts`/`layout-edit-controller.ts`의 box-특화 함수들을 TD로 일반화하는 작업 범위. 1차는 TD 편집 기능을 최소화(선택만)하여 영향도 제한 권장.

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