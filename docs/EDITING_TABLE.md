# layout-element 표(table) 편집 상세 명세

> 작성 기준: `src/components/layout/table.element.ts`, `src/components/layout/tr.element.ts`, `src/components/layout/td.element.ts`, `src/edit/table-keyboard-controller.ts`, `src/edit/table-structure-editor.ts`, `src/edit/layout-selection-controller.ts`, `src/edit/layout-edit-controller.ts`, `src/components/layout/box.element.ts`, `src/components/layout/document.element.ts`, `src/core/table-grid-resolver.ts`, `src/core/border-resolver.ts`, `src/types/layout/table.type.ts`, `src/types/edit/table-selection.type.ts`, `src/constants/defaults.ts`
>
> 본 문서는 `layout-element` 라이브러리의 표(table) 요소 렌더링, 셀 블록 선택, 마우스 리사이즈, 키보드 단축키, 구조 편집(병합/삽입/삭제), 이벤트 충돌 처리, 구현 제약사항을 상세히 기술한다.
>
> **관련 문서**:
> - **`EDITING_LAYOUT.md`**: 레이아웃 편집 모드(`LayoutEditController`, `LayoutSelectionController`) 상세 명세
> - **`EDITING_EVENTS.md`**: `EditManager` 이벤트 상세 명세
> - **`EDITING_TEXT.md`**: 텍스트 편집 모드 상세 명세

---

## 1. 개요 (Overview)

표(table)는 신문 레이아웃에서 데이터를 행렬 형태로 배치하는 요소이다. CSS grid로는 처리할 수 없는 mm 단위 정밀 좌표, colspan/rowspan 병합, border-collapse, 인쇄 post-processing을 지원한다.

표는 독립된 레이아웃 요소가 아니라 `<x-layout-box>`의 content type이다. box가 표의 위치/크기/배경/외곽 테두리를 정의하고, `<x-layout-table>`은 box 내부 영역을 행×열 그리드로 분할하여 셀을 배치한다.

### 1.1 요소 계층

```
<x-layout-box contentType="table">
  <x-layout-table>               ← 그리드 컨테이너, border 렌더링, resize handle, selection overlay
    <x-layout-tr>                ← 행. height(mm)
      <x-layout-td>              ← 셀. colspan/rowspan, border 선언, padding, 배경색, 대각선
        <x-layout-box>           ← 셀 내용 컨테이너 (static box, cell 크기에 자동 맞춤)
          <x-layout-paragraph>   ← 단락 (텍스트)
          <x-layout-image>       ← 이미지
          <x-layout-table>       ← 중첩 표 (재귀 가능)
```

### 1.2 렌더링 파이프라인

```
box.layout() → table.layout() → _layoutStructure() (GridResolution 갱신)
                             → _applyStyle() (:host CSS)
                             → _renderBorder() (border-collapse 레이어)
                             → _renderResizeHandles() (편집 모드에서만)
                             → _renderSelectionOverlay() (selection 있을 때)
                             → _propagateInheritStyle() → tr.layout() → td.layout() → box.layout()
box.render() → table.render() → tr.render() → td.render() → box.render()
```

`table.layout()`은 자식 TR의 `layout()`을 순차 호출하고, 각 TR은 TD의 `layout()`을, 각 TD는 내부 box의 `layout()`을 호출한다. `layout()` 완료 후 `render()`가 비동기로 실행된다.

---

## 2. 데이터 모델

### 2.1 TableData

```typescript
type TableData = {
  type: 'table';
  id?: string;
  colWidths?: number | number[];  // mm. number=균등, number[]=개별. 생략 시 자동 분할
  children: TableRowData[];
};
```

### 2.2 TableRowData

```typescript
type TableRowData = {
  type: 'tr';
  id?: string;
  height: number;          // mm
  children: TableCellData[];
};
```

### 2.3 TableCellData

```typescript
type TableCellData = {
  type: 'td';
  id?: string;
  colspan?: number;        // 기본 1
  rowspan?: number;        // 기본 1
  borderTop?: CellBorderEdge;
  borderRight?: CellBorderEdge;
  borderBottom?: CellBorderEdge;
  borderLeft?: CellBorderEdge;
  backgroundColor?: string;     // ColorRegistry CMYK 색상 이름
  backgroundOpacity?: number;   // 0~1, 기본 1
  diagonals?: Array<'tl-br' | 'tr-bl'>;
  paddingTop?: number;          // mm
  paddingRight?: number;        // mm
  paddingBottom?: number;        // mm
  paddingLeft?: number;         // mm
  children: BoxData[];          // 반드시 box로 감싸야 함
};
```

### 2.4 CellBorderEdge

```typescript
type CellBorderEdge = {
  width: number;           // mm
  color: string;           // ColorRegistry CMYK 이름
  style?: BoxBorderStyle;  // 'solid' | 'dashed' | ..., 기본 'solid'
};
```

---

## 3. 그리드 계산 (GridResolution)

### 3.1 resolveTableGrid

`src/core/table-grid-resolver.ts`의 `resolveTableGrid()`는 TableData에서 논리 그리드를 계산한다.

**입력**: `colWidths`, `rows`(TableRowData[]), `containerWidth`(mm), `containerHeight`(mm)

**출력** (`GridResolution`):
- `rowCount`, `colCount`: 논리 행/열 수
- `colWidths`: 정규화된 열 너비 배열 (mm). 합 = containerWidth
- `rowHeights`: 정규화된 행 높이 배열 (mm). 합 = containerHeight
- `placements`: 각 셀의 배치 정보 (`gridRow`, `gridCol`, `spanRows`, `spanCols`, `x`, `y`, `width`, `height`, `cell`)

### 3.2 normalizeWidths

`normalizeWidths(values, targetSize, minSize)`는 배열의 합을 `targetSize`로 맞추되, 각 값이 `minSize` 이하로 내려가지 않도록 보장한다.

- 합이 targetSize보다 크면: 비례 축소, 단 minSize 미만 값은 minSize로 고정하고 남은 여분을 다른 값에서 차감
- 합이 targetSize보다 작으면: 비례 확대
- minSize 보장: `MIN_TABLE_COL_WIDTH = 5mm`, `MIN_TABLE_ROW_HEIGHT = 5mm`

### 3.3 colspan/rowspan 처리

`resolveTableGrid`는 각 TD의 `colspan`/`rowspan`을 읽어 논리 그리드에 배치한다. 병합된 셀은 하나의 placement로 표현되며, `spanRows`/`spanCols`에 병합 범위가 기록된다. 병합된 영역의 논리 좌표는 모두 같은 placement에 매핑된다.

### 3.4 셀 라벨 (Cell Labels)

각 TD는 `cellLabel` 속성과 `cellLabels` 배열을 가진다.

- `cellLabel`: 대표 라벨 (예: `"A1"`). 행은 A, B, C... (알파벳), 열은 1, 2, 3... (숫자)
- `cellLabels`: colspan/rowspan으로 커버하는 모든 논리 좌표의 라벨 배열 (예: `["A1", "A2", "B1", "B2"]` for 2×2 merge)

라벨 규칙:
- 행: 0→A, 1→B, 2→C, ..., 25→Z, 26→AA, 27→AB, ... (26진법 변환)
- 열: 0→1, 1→2, 2→3, ...
- 라벨 형식: `{행 라벨}{열 번호}` (예: `A1`, `B3`, `AA12`)

`_coordToLabel(coord)`와 `_labelToCoord(label)`는 `TableKeyboardController`에서 좌표↔라벨 양방향 변환을 담당한다.

---

## 4. 셀 블록 선택 (Cell Block Selection)

### 4.1 선택 모델

```typescript
type TableCellSelection = {
  mode: 'single' | 'range' | 'all';
  anchor: CellCoord;      // 선택 시작 좌표
  focus: CellCoord;       // 현재 커서 위치 (range 모드에서 영역 확장)
  selectMode?: 'cell' | 'row' | 'col';  // F7/F8로 선택된 행/열 모드
};

type CellCoord = { row: number; col: number };
```

### 4.2 F5 — 셀 블록 모드 토글

F5 키는 다음 순서로 모드를 전환한다:

| 현재 상태        | F5 결과  | 설명                                    |
| ---------------- | -------- | --------------------------------------- |
| 선택 없음        | `single` | 현재 셀 단일 선택, paragraph blur       |
| `single`         | `range`  | range 모드 진입 (anchor = focus = 현재) |
| `range`          | `all`    | 전체 셀 선택                            |
| `all`            | `single` | 다시 현재 셀 단일 선택                  |

**현재 셀 결정** (`_getCurrentCellCoord`):
1. 이미 selection이 있으면 `selection.focus` 반환
2. `EditManager.focusedParagraph`가 TD 내부 단락이면 해당 셀 좌표 반환
3. `EditManager.selectedLayouts`에서 TD 내부 box를 찾으면 해당 셀 좌표 반환
4. 위 모두 실패 시 `{row: 0, col: 0}` 반환

**진입 시**: `handleF5`는 `EditManager.focusedParagraph`가 있으면 `blurParagraph()`를 호출하여 텍스트 편집 포커스를 해제한다. 이는 셀 블록 모드가 텍스트 편집과 충돌하지 않도록 보장한다.

### 4.3 F7 — 열 선택

`handleF7(currentCell)`: 현재 셀의 열 전체를 range 모드로 선택. `selectMode: 'col'`.

```
anchor: { row: 0, col: currentCell.col }
focus:  { row: maxRow, col: currentCell.col }
```

### 4.4 F8 — 행 선택

`handleF8(currentCell)`: 현재 셀의 행 전체를 range 모드로 선택. `selectMode: 'row'`.

```
anchor: { row: currentCell.row, col: 0 }
focus:  { row: currentCell.row, col: maxCol }
```

### 4.5 방향키 — 셀 이동

`handleArrowKey(direction)`: `single` 또는 `range` 모드에서 focus 셀을 이동.

- `single` 모드: anchor와 focus 모두 이동 (셀 단일 선택 이동)
- `range` 모드: focus만 이동 (선택 영역 확장/축소)
- `all` 모드: 동작 안 함
- `selectMode: 'row'`일 때 좌/우 방향키는 동작 안 함 (행 모드에서 열 이동 무의미)
- `selectMode: 'col'`일 때 상/하 방향키는 동작 안 함
- **colspan/rowspan 고려**: 이동하려는 논리 좌표가 병합된 셀 내부이면 같은 셀로 판정하여 건너뛰고, 도달한 셀의 좌상단 좌표로 정규화
- 경계 클램핑: `row >= 0`, `col >= 0`, `row <= rowCount - 1`, `col <= colCount - 1`

### 4.6 ESC — 셀 블록 종료

`handleEscape()`:
1. `selection.focus` 셀의 TD를 찾는다
2. `_updateSelection(null)`로 셀 블록 해제
3. TD 내부 첫 번째 box를 `selectLayout(box)`로 선택
4. box 내부 첫 번째 paragraph를 `focusParagraph(para)`로 포커스

이렇게 하면 ESC 후 텍스트 편집 모드로 자연스럽게 전환되어 해당 셀의 텍스트를 바로 편집할 수 있다.

### 4.7 셀 클릭 — range 모드에서 single 전환

**레이아웃 편집 모드에서만 동작**. 셀 블록이 활성(range 또는 all) 상태에서 마우스로 다른 셀을 클릭하면:
- `LayoutEditController._onMouseDown`과 `LayoutSelectionController._onMouseDown` 모두 클릭된 TD의 `cellLabel`을 좌표로 변환
- `kc.selection`을 `{ mode: 'single', anchor: coord, focus: coord, selectMode: 'cell' }`로 설정
- 클릭된 TD의 첫 번째 box를 `selectLayout(box)`로 선택
- `event.preventDefault()` + `event.stopPropagation()`으로 다른 핸들러 실행 차단

비편집 모드에서는 셀 클릭 시 셀 블록 전환이 동작하지 않고, 기존 box 선택 동작이 우선한다.

**제약**: Playwright의 `mouse.click()`은 shadow DOM 내부에서 `mousedown` 이벤트를 발생시키지 않을 수 있어, 자동화 테스트에서는 `pointerdown`을 직접 dispatch해야 정상 동작한다.

### 4.8 셀 드래그 — range 모드 셀 블록 선택

**레이아웃 편집 모드에서만 동작**. table 내부 TD에서 마우스 드래그를 시작하면:
- 시작 셀을 anchor로 `range` 모드 셀 블록 설정
- `_cellDrag` 상태 시작 (tableEl, anchor, startX/Y, moved=false)
- `pointermove` 리스너 등록
- 드래그 중(3px 이상 이동): `elementsFromPoint`로 마우스 아래 TD를 찾아 focus 좌표 갱신
  - range 영역 확장 + overlay 갱신
  - 선택된 모든 셀의 box를 `selectLayout(boxes)` 배열로 EditManager selection에 동기화
- 드래그 없음(단일 클릭): `single` 모드로 전환
- `pointerup` 시 리스너 제거 + `_cellDrag` 해제

### 4.9 테이블 외부 클릭 — 셀 블록 해제

`LayoutSelectionController._onMouseDown`에서:
- `composedPath()`에 `LayoutTableElement`가 있고, `kc.selection`이 활성이지만 TD를 찾지 못한 경우 → `kc.selection = null` + overlay 클리어
- `composedPath()`에 `LayoutTableElement`가 없고, 다른 table에 `kc.selection`이 있는 경우 → 모든 table의 `kc.selection` 클리어
- table 영역 클릭이지만 selectable box를 찾지 못한 경우 → marquee 시작 안 함

### 4.10 range 모드와 EditManager selection 동기화

`_updateSelection`과 `_onCellDragMove`에서 range/all 모드일 때:
- `_getSelectedCells()`로 선택된 모든 셀의 TD를 수집
- 각 TD의 첫 번째 box를 배열로 수집
- `selectLayout(boxes)` 배열 호출로 모든 box를 EditManager selection에 반영
- single 모드는 focus 셀의 box만 `selectLayout(box)`로 선택

---

## 5. 마우스 리사이즈

### 5.1 리사이즈 핸들

`_renderResizeHandles()`는 `layoutEditMode`가 true일 때만 실행된다. table의 shadow DOM에 두 종류의 핸들을 생성한다:

**열(수직) 핸들** — `data-handle="v-{col}"`:
- 위치: 각 열 경계의 x 좌표 (누적 colWidths)
- 크기: `HIT_WIDTH(8px)` 너비, 테이블 전체 높이
- 커서: `ew-resize`
- z-index: `Z_INDEX_TABLE_RESIZE = 99992`

**행(수평) 핸들** — `data-handle="h-{row}"`:
- 위치: 각 행 경계의 y 좌표 (누적 rowHeights)
- 크기: 테이블 전체 너비, `HIT_WIDTH(8px)` 높이
- 커서: `ns-resize`

### 5.2 리사이즈 동작

`_startTableResize` (pointerdown 리스너):
1. `editManager.layoutEditMode`가 true인지 확인
2. `composedPath()`에서 `.table-resize-handle`을 찾음
3. `data-handle` 속성에서 방향(v/h)과 인덱스 추출
4. `_resizeState` 저장 (시작 마우스 좌표, 시작 colWidths/rowHeights)
5. document에 `pointermove`, `pointerup`, `keydown` 리스너 추가

`_onTableResizeMouseMove`:
- 3px 이상 이동 시 `moved = true`
- `requestAnimationFrame`으로 리사이즈 적용 (60fps 제한)
- `event.preventDefault()`로 text selection 방지

`_applyColumnResize(col, deltaMm)`:
- `col-1`과 `col`의 너비를 deltaMm만큼 조정 (총합 유지)
- `MIN_TABLE_COL_WIDTH(5mm)` 보장
- `this.colWidths` 갱신 → `layout()` + `render()` → `notifyTablePropertyChange()`

`_applyRowResize(row, deltaMm)`:
- `row-1`과 `row`의 높이를 deltaMm만큼 조정 (총합 유지)
- `MIN_TABLE_ROW_HEIGHT(5mm)` 보장
- `this._rows[row-1].height`와 `this._rows[row].height` 갱신 → `layout()` + `render()`

`_onTableResizeMouseUp`:
- 리스너 제거
- `_resizeState = null`
- 선택 overlay가 있으면 `_renderSelectionOverlay` 재호출 (좌표 갱신)

### 5.3 ESC 취소

`_onTableResizeKeyDown`:
- ESC 키 시: 시작 시점의 colWidths/rowHeights로 복원 → `layout()` + `render()` → 리스너 제거

### 5.4 colspan/rowspan과 리사이즈

colspan/rowspan이 있는 행/열도 리사이즈 가능하다. 이전에는 colspan된 영역의 경계가 disabled 처리되었으나, 이는 사용자가 리사이즈할 수 없는 문제를 유발하여 제거되었다. colspan된 셀의 열 너비를 변경하면 `normalizeWidths`가 전체 합을 유지하므로 정상 동작한다.

### 5.5 text selection 방지

리사이즈 핸들과 레이어에 `user-select: none`을 적용하고, `_startTableResize`와 `_onTableResizeMouseMove`에서 `event.preventDefault()`를 호출하여 드래그 중 텍스트 선택을 방지한다.

---

## 6. 키보드 단축키 전체 목록

### 6.1 모든 모드에서 동작 (셀 블록 비활성 포함)

| 키    | 조건                           | 동작                     |
| ----- | ------------------------------ | ------------------------ |
| F5    | table 내부 또는 TD 내부 box 선택 | 셀 블록 모드 진입/토글  |
| F7    | table 내부 또는 TD 내부 box 선택 | 현재 열 전체 선택        |
| F8    | table 내부 또는 TD 내부 box 선택 | 현재 행 전체 선택        |
| ESC   | 셀 블록 활성                   | 셀 블록 종료 + paragraph 포커스 |

F5/F7/F8은 `_getCurrentCellCoord()`로 현재 셀을 결정한 후 처리한다. 셀 블록이 없어도 TD 내부 box가 선택되어 있으면 현재 셀을 찾을 수 있다.

### 6.2 셀 블록 활성 시 동작 (모든 모드)

| 키              | 모드             | 동작                           |
| --------------- | ---------------- | ------------------------------ |
| ←↑↓→            | single, range    | focus 셀 이동 (병합 셀 건너뛰기) |
| Alt+←→          | single, range    | 열 너비 리사이즈 (1mm 단위)    |
| Alt+↑↓           | single, range    | 행 높이 리사이즈 (1mm 단위)    |
| Ctrl+Alt+↑      | single, range    | 위쪽에 행 추가                  |
| Ctrl+Alt+↓      | single, range    | 아래쪽에 행 추가                |
| Ctrl+Alt+←      | single, range    | 왼쪽에 열 추가                  |
| Ctrl+Alt+→      | single, range    | 오른쪽에 열 추가                |
| M               | single, range    | 셀 병합/해제 토글              |
| W               | range            | 선택 영역 열 너비 균등 분할    |
| H               | range            | 선택 영역 행 높이 균등 분할    |

모든 단축키는 `editManager.layoutEditMode`와 무관하게 동작한다.

### 6.3 Alt+arrow 리사이즈 상세

`handleAltArrowKey(direction)`: 병합된 셀의 placement를 찾아 `spanCols`/`spanRows`를 확인한 후, 끝열/끝행(`rightEdge`/`bottomEdge`)과 좌상단 열/행(`leftEdge`/`topEdge`)을 기준으로 동작.

**열 리사이즈**:

| 방향         | 기본 동작 (오른쪽 이웃 있음)             | 반전 동작 (오른쪽 이웃 없음)            |
| ------------ | ---------------------------------------- | --------------------------------------- |
| Alt+→        | 끝열 너비 +1, 오른쪽 -1 (현재 늘림)       | 끝열 너비 -1, 왼쪽 +1 (현재 줄임)        |
| Alt+←        | 끝열 너비 -1, 오른쪽 +1 (현재 줄임)       | 좌상단 열 너비 +1, 왼쪽 -1 (현재 늘림)  |

**행 리사이즈**:

| 방향         | 기본 동작 (아래 이웃 있음)               | 반전 동작 (아래 이웃 없음)              |
| ------------ | --------------------------------------- | --------------------------------------- |
| Alt+↓        | 끝행 높이 +1, 아래 -1 (현재 늘림)        | 끝행 높이 -1, 위 +1 (현재 줄임)          |
| Alt+↑        | 끝행 높이 -1, 아래 +1 (현재 줄임)        | 좌상단 행 높이 +1, 위 -1 (현재 늘림)     |

`TABLE_KEYBOARD_RESIZE_STEP = 1` (mm 단위). 리사이즈 후 `_refreshOverlay()`로 selection overlay를 갱신한다.

**제약**: 단일 열/행 테이블에서는 리사이즈 불가.

---

## 7. 구조 편집 (TableStructureEditor)

### 7.1 셀 병합/해제 토글 (handleMerge)

`M` 키는 현재 셀의 병합 상태에 따라 토글 동작:

- **병합된 셀** (colspan > 1 또는 rowspan > 1): `unmergeCell()` 호출 → 1×1 셀로 분할
- **병합되지 않은 셀** (colspan=1, rowspan=1) + `range` 모드: `mergeCells()` 호출 → 병합
- **병합되지 않은 셀** + `single` 모드: 동작 안 함

#### mergeCells(selection)

- `mode === 'single'`이면 동작 안 함 (2셀 이상 필요)
- 선택 영역의 `minRow~maxRow`, `minCol~maxCol` 범위 계산
- 좌상단 셀을 병합 셀로 설정: `colspan = maxCol - minCol + 1`, `rowspan = maxRow - minRow + 1`
- **좌상단 셀의 자식 box만 유지**, 나머지 셀의 자식은 삭제 (이동하지 않음)
- 병합된 셀(좌상단 제외) 제거
- `_applyNewData()`로 전체 데이터 갱신 (기존 TR 모두 제거 후 재생성)
- 병합 후 selection을 병합 셀의 좌상단 좌표로 single 모드 이동

#### unmergeCell(cellCoord)

- 병합된 셀을 `spanRows × spanCols` 개의 1×1 셀로 분할
- 첫 번째 셀(좌상단)만 원본 자식 box 유지, 나머지는 빈 box 생성
- `_applyNewData()`로 전체 데이터 갱신

### 7.2 행 삽입

#### insertRowBelow() / insertRowAbove()

현재 셀 기준으로 아래/위에 행을 삽입. 외부에서도 호출 가능.

**삽입 규칙**:
- 새 행의 높이: 현재 행의 높이를 상승
- 새 행의 셀: 현재 행의 셀 구조(border, 배경색, padding, colspan)를 복제
- `rowspanCovered` 맵을 사용하여 각 셀의 논리 위치 추적
- **병합된 셀 처리**:
  - 삽입 위치 이전 행에서 rowspan이 삽입 위치를 가로지르면 rowspan +1
  - 새 행에서 `insertOccupied` 위치(rowspan으로 덮인 위치)에는 셀을 생성하지 않음
  - `sourceOccupied` 위치(원본 행에서 rowspan으로 덮인 위치)에는 빈 셀을 채움

**외부 호출**:
```typescript
tableEl.keyboardController.insertRowBelow();
tableEl.keyboardController.insertRowAbove();
tableEl.structureEditor.insertRowBelow();
tableEl.structureEditor.insertRowAbove();
```

### 7.3 열 삽입

#### insertColRight() / insertColLeft()

현재 셀 기준으로 오른쪽/왼쪽에 열을 삽입. 외부에서도 호출 가능.

**삽입 규칙**:
- 새 열의 너비: 현재 열의 너비를 복제
- 새 열의 셀: 현재 열의 셀 구조(border, 배경색, padding)를 복제
- `colspanCovered` 맵을 사용하여 각 셀의 논리 위치 추적
- **병합된 셀 처리**:
  - `isRight`일 때: focusCol이 병합 셀의 끝점이면 새 셀 추가, 중간이면 colspan +1
  - `!isRight`일 때: focusCol이 병합 셀의 시작점이면 새 셀 추가, 중간이면 colspan +1

**외부 호출**:
```typescript
tableEl.keyboardController.insertColRight();
tableEl.keyboardController.insertColLeft();
tableEl.structureEditor.insertColRight();
tableEl.structureEditor.insertColLeft();
```

### 7.4 행/열 삭제

#### deleteRow() / deleteCol()

현재 셀 기준으로 행/열을 삭제. 외부에서도 호출 가능. 단축키는 없음.

**행 삭제 규칙**:
- rowspan > 1인 셀이 삭제되면 다음 행으로 이동 (rowspan - 1)
- 이전 행의 rowspan이 삭제 행을 가로지르면 rowspan - 1
- 행 높이 정규화 (`normalizeWidths`)

**열 삭제 규칙**:
- colspan > 1인 셀의 중간 열을 삭제하면 colspan - 1
- `colWidths`에서 해당 열 제거

**외부 호출**:
```typescript
tableEl.keyboardController.deleteRow();
tableEl.keyboardController.deleteCol();
tableEl.structureEditor.deleteRow();
tableEl.structureEditor.deleteCol();
```

### 7.5 너비/높이 균등 분할

#### equalizeWidth(selection)

- 선택 영역의 열 너비 합을 열 수로 나누어 균등 분할
- `colWidths` 갱신 → `notifyTablePropertyChange()`

#### equalizeHeight(selection)

- 선택 영역의 행 높이 합을 행 수로 나누어 균등 분할
- `this._tableEl.rows[r].height`(데이터)와 `this._tableEl.items[r].height`(DOM 요소) 모두 갱신
- `layout()` + `render()` → `notifyTablePropertyChange()`

### 7.6 빈 셀 / 빈 박스 생성

`_createEmptyCell()`: 기본 빈 `TableCellData`를 생성 (자식 없음).

`_createEmptyBox()`: 빈 box(빈 paragraph 포함) 생성.

```typescript
// _createEmptyBox()
{
  type: 'box',
  left: 0, top: 0, width: 1, height: 1,
  position: 'static', zIndex: 1,
  children: { type: 'paragraph', content: '' }
}
```

### 7.7 데이터 갱신 (_applyNewData)

`_applyNewData(newData)`: 기존 TR을 모두 제거한 후 `table.data = newData`를 설정. 이 방식은 ID 기반 reconciliation으로 인한 box shadow DOM 손상을 방지한다.

---

## 8. Selection Overlay

### 8.1 렌더링

`_renderSelectionOverlay(selection)`:
- `selection`이 null이면 `_clearSelectionOverlay()` 호출 후 return
- shadow DOM에 `_selectionLayerEl` (div, `pointerEvents: none`, `zIndex: Z_INDEX_TABLE_SELECTION = 99989`) 생성
- `_getSelectionCoords(selection)`로 선택된 모든 논리 좌표 계산
- 각 좌표에 대해 `_findPlacementAt(coord)`로 placement 위치/크기를 구함
- 각 셀에 100%×100% 반투명 사각형 오버레이 생성:
  - `backgroundColor: rgba(0, 100, 200, 0.3)` — 텍스트 선택 색상과 동일
  - `pointerEvents: none`
  - `data-cell` 속성: `"{row}-{col}"`

### 8.2 커서 표시 (range 모드)

range 모드에서 focus 셀의 중앙에 빨간색 원형 커서를 표시:
- 크기: 10px × 10px
- 색상: `red`
- `borderRadius: 50%` (원형)
- 위치: `(placement.x + placement.width/2) * ppm - 5`, `(placement.y + placement.height/2) * ppm - 5`
- `data-cell-cursor` 속성: `"{row}-{col}"`

single 모드에서는 커서 원이 표시되지 않는다.

### 8.3 갱신 시점

Selection overlay는 다음 시점에 갱신된다:
- `_updateSelection()` — 키보드/마우스로 selection 변경 시
- `_refreshOverlay()` — Alt+arrow 리사이즈 후
- `_onTableResizeMouseUp` — 마우스 리사이즈 완료 후
- `layout()` — layout() 호출 시 selection이 있으면 자동 갱신 (외부 요인: parent box 이동, data setter 등)

---

## 9. Border 렌더링 (border-collapse)

### 9.1 resolveTableBorders

`src/core/border-resolver.ts`의 `resolveTableBorders(edges)`는 인접 셀의 border 선언을 바탕으로 border-collapse 규칙으로 단일 border 라인을 결정한다.

- 각 셀은 `borderTop`, `borderRight`, `borderBottom`, `borderLeft`를 선언
- 인접한 두 셀의 border는 동일 엣지를 공유 (A.borderRight ↔ B.borderLeft)
- border-collapse: 더 두꺼운 border가 우선, 같으면 첫 번째 셀의 border 사용

### 9.2 Border 레이어

`_renderBorder()`는 shadow DOM에 `_borderLayerEl`을 생성:
- `pointerEvents: none`
- `zIndex: Z_INDEX_TABLE_BORDER = 99990`
- 각 border edge를 div 요소로 렌더링 (mm → px 변환)
- `borderWidth = 0`인 edge는 렌더링하지 않음

### 9.3 인쇄 모드

`@media print`에서 border 레이어는 숨김 처리되지 않는다. border 좌표/크기는 `printPostData`로 수집되어 외부 post-processing에서 사용된다.

---

## 10. TD 내부 Box 특수 처리

### 10.1 static box 자동 맞춤

TD 내부의 `position: 'static'` box는 TD의 content 영역(padding 제외)에 100%로 자동 맞춤된다. box의 `_layoutStructure()`가 parent(TD)의 `GridCalculator`를 통해 columnCoords를 읽어 `left=0, top=0, width=tdContentWidth, height=tdContentHeight`로 설정한다.

### 10.2 resize handle 숨김

TD 내부 static box는 `[td-static]` 속성이 설정된다:
- `_updateTdStaticAttr()`: `editableLayout === true && parentElement instanceof LayoutTableCellElement && position === 'static'`일 때 설정
- 호출 시점: `connectedCallback`, `position` setter, `editableLayout` setter
- CSS rule: `:host([td-static]) .resize-handle { display: none !important; }`
- CSS rule: `:host([td-static]) .type-label { display: none !important; }`
- CSS rule: `:host([td-static][selected])` / `:host([td-static][hovered])` — selected/hovered box-shadow는 유지 (시각적 선택 상태는 표시)

### 10.3 absolute box

TD 내부 `position: 'absolute'` box는 `[td-static]` 속성이 설정되지 않으므로 resize handle과 type-label이 정상 표시된다. absolute box는 TD 내부에서 자유롭게 위치/크기를 조정할 수 있다.

### 10.4 상위 요소 선택 화살표 (_selectParent)

TD 내부 box의 type-label에 있는 parent-btn(상위 선택 화살표)을 클릭하면:
- `_selectParent()`는 parentElement 체인을 따라 올라가 첫 번째 `LayoutBoxElement`를 찾는다
- 체인: box → TD → TR → table → table parent box
- 찾은 box를 `selectLayout()`으로 선택

### 10.5 appendChildData

`td.appendChildData(child)`:
- `_layoutStructure()`를 먼저 호출하여 TD의 `GridCalculator` columnCoords를 갱신한다
- 새 box를 생성하고 `box.data = child`를 설정 (전체 초기화 파이프라인 실행)
- box를 TD에 appendChild

### 10.6 TD에 요소 삽입/배치/재부모 룰

table box(`contentType === 'table'`)에는 다른 요소를 추가할 수 없다. 모든 컨트롤러(InsertController, PlaceGunController, LayoutEditController)에서 `contentType === 'table'`인 box를 후보에서 제외한다.

TD에 요소를 삽입/배치/재부모할 때의 룰:

| 시나리오                | absolute position   | static position                                         |
| ----------------------- | ------------------- | ------------------------------------------------------- |
| **요소 생성 (드래그 삽입)** | 제한 없음 (기존 룰) | 비어있는 TD만, 드래그 box ≤ TD 크기, 위반 시 거부       |
| **요소 패턴 (PlaceGun)**    | 제한 없음           | 비어있는 TD만, 크기 무관, `left=0,top=0,width=1,height=1` |
| **Reparent**                | 제한 없음           | 비어있는 TD만, 크기 무관, `left=0,top=0,width=1,height=1` |
| **Preview (드래그 중)**     | 기존 룰             | TD 위에서 TD bounding rect에 스냅 (grid line 무시)      |

- **비어있는 TD**: `td.items.length === 0` (자식 box가 없는 TD)
- **static box auto-fill**: TD에 static box를 삽입하면 `left=0, top=0, width=1, height=1`로 설정되어 TD content 영역에 자동 맞춤됨
- **요소 생성 시 크기 검증**: 드래그한 box의 mm 크기가 TD의 `model.editableWidth`/`model.contentHeight`를 초과하면 거부 (cleanup, no insertion)
- **Preview 스냅**: static 모드에서 드래그 중 TD 위에 있으면, preview rect를 TD의 bounding rect에 클램핑 (grid line 스냅 무시)

---

## 11. 이벤트 처리 및 충돌 방지

### 11.1 keydown 이벤트 흐름

```
window capture (document.element.ts _onWindowKeyDown)
  → F5: layoutEditMode && (inTable || hasSelectedBoxInTd) → preventDefault
  → Alt+arrow: hasSelectedBoxInTd → preventDefault (모든 table 순회)
  ↓
document capture (table.element.ts _onTableKeyDown)
  → inTable || hasSelectedBoxInTd → handleKeyDown → stopPropagation if handled
  ↓
target element (기본 동작 또는 무시)
```

**window keydown 블로커** (`document.element.ts`):
- F5: `layoutEditMode`가 true이고, 이벤트가 table 내부에서 발생했거나 TD 내부 box가 선택되어 있을 때만 `preventDefault`
- Alt+arrow: TD 내부 box가 선택되어 있을 때만 `preventDefault` (모든 table 순회하여 selection 확인)
- table 외부에서는 브라우저 기본 동작이 차단되지 않는다

**document keydown 핸들러** (`table.element.ts _onTableKeyDown`):
- `inTable` (이벤트 target이 table 내부) 또는 `hasSelectedBoxInTd` (TD 내부 box 선택)인 경우만 `handleKeyDown` 호출
- `handleKeyDown`이 true를 반환하면 `stopPropagation()`으로 전파 중단

### 11.2 mousedown 이벤트 흐름

```
document capture (LayoutSelectionController._onMouseDown) — 항상 활성
  → table-resize-handle 체크 → return
  → table cell block 처리 (kc.selection 활성 시)
  → table cell block 클리어 (모든 table 순회)
  → _findSelectableBoxFromEvent → box 찾으면 return
  → table 영역이면 marquee 시작 안 함
  → marquee 시작 (빈 영역)
  ↓
document capture (LayoutEditController._onMouseDown) — layoutEditMode 시 활성
  → table-resize-handle 체크 → return
  → table cell block 처리 (kc.selection 활성 시) → stopPropagation
  → _findEditableBoxFromEvent → box 찾으면 drag/resize 시작
```

**등록 순서**: `LayoutSelectionController`가 `EditManager` 생성자에서 먼저 등록, `LayoutEditController`가 `layoutEditMode` setter에서 나중에 등록. 같은 element에 같은 phase로 등록된 리스너는 등록 순서대로 실행.

### 11.3 pointerdown (table resize)

`table.element.ts`의 `_startTableResize`는 table element 자체에 `pointerdown` 리스너로 등록. resize handle의 `pointer-events: auto`로 이벤트를 수신하고, `composedPath()`에서 handle을 찾아 리사이즈를 시작한다.

### 11.4 모드 전환 시 셀 블록 처리

`_onModeChange`:
- `layoutEditMode`가 true → `_activateTableEditing()` → `layout()` (resize handle 렌더링)
- `layoutEditMode`가 false → `_deactivateTableEditing()`:
  - resize state 취소, resize handle/layer 제거
  - `_resizeListenerRegistered = false` (재활성화 시 리스너 재등록 보장)
  - `layout()` 호출 (handle 제거 반영)
  - **셀 블록 selection은 클리어하지 않음** — ESC나 외부 클릭으로 별도 해제 필요

### 11.5 _collectParagraphs (텍스트 리플로우)

`LayoutEditController._collectParagraphs`는 box drag/resize 시 영향받는 paragraph를 수집하여 재렌더링한다. table 내부 paragraph도 포함되도록 `'table'` 타입 재귀 처리가 추가되어 있다:

```typescript
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

이렇게 하지 않으면 box drag/resize 시 table 내부 paragraph의 텍스트 overlap이 갱신되지 않는다.

---

## 12. 구현 제약사항 및 한계

### 12.1 셀 내용은 반드시 box로 감싸야 함

`TableCellData.children`은 `BoxData[]`만 허용한다. paragraph/image/table을 직접 넣을 수 없고 반드시 box로 감싸야 한다. 이는 TD의 `GridCalculator`가 box 배치 컨텍스트로 동작하기 위함이다.

### 12.2 셀 블록 모드는 모달 서브 상태

셀 블록 활성 시(`kc.selection != null`), TD 내부 box의 마우스 drag/resize가 차단된다. `_onMouseDown`에서 `preventDefault()` + `stopPropagation()`을 호출하기 때문이다. 이는 의도된 동작이다 — 셀 블록 모드는 grid 구조 조작(merge/resize)에 집중하고, box drag는 ESC로 셀 블록을 종료한 후 수행해야 한다.

### 12.3 테이블은 부모 box를 가득 채움

테이블은 부모 box의 content 영역(box width/height - padding)을 가득 채운다. row heights의 합은 containerHeight에 맞춰 정규화되고, col widths의 합은 containerWidth에 맞춰 정규화된다. 개별 행/열의 크기를 독립적으로 설정할 수 없다 — 항상 비율로 동작한다.

### 12.4 MIN_TABLE_COL_WIDTH / MIN_TABLE_ROW_HEIGHT

- 열 너비 최소: 5mm (`MIN_TABLE_COL_WIDTH`)
- 행 높이 최소: 5mm (`MIN_TABLE_ROW_HEIGHT`)
- `normalizeWidths`가 이 값들을 보장하지만, 테이블 전체 크기가 너무 작으면 정규화가 불가능할 수 있다 (5mm × 열 수 > containerWidth).

### 12.5 중첩 표 지원

TD 내부 box에 다시 표를 넣을 수 있다 (중첩 표). `_collectParagraphs`, `contentType` getter, `_selectParent` 모두 중첩 표를 재귀적으로 처리한다. 단, 중첩 표의 keydown 이벤트는 부모 표의 `_onTableKeyDown`도 수신할 수 있다 (DOM 트리에 둘 다 포함되므로 `inTable`이 true).

### 12.6 다중 표 처리

document 내 여러 표가 있을 때:
- 각 표는 자체 `TableKeyboardController`와 `_onTableKeyDown` 리스너를 가진다
- `_onTableKeyDown`의 `inTable` 체크(`this.contains(target)`)로 자신의 표 내부 이벤트만 처리
- `hasSelectedBoxInTd`는 모든 표의 TD 내부 box를 확인하므로, 다른 표의 cell block도 처리할 수 있다 — 하지만 `handleKeyDown`에서 `_selection` 체크로 자신의 selection만 처리
- window keydown 블로커는 모든 표를 순회하여 `kc.selection`이 있는 경우 `preventDefault`

### 12.7 printPostData

인쇄 모드에서 table, TR, TD는 각각 `printPostData` getter를 제공한다. border 레이어의 좌표/크기, 대각선 정보, 배경색 정보를 post-processing용으로 수집한다.

### 12.8 F5 브라우저 새로고침 충돌

F5는 table 내부에서 셀 블록 단축키로 사용되므로, table 내부 또는 TD 내부 box 선택 시 브라우저 새로고침을 차단한다. table 외부에서는 브라우저 새로고침이 정상 동작한다.

### 12.9 cellLabel 형식 제약

cellLabel은 `{행 알파벳}{열 번호}` 형식이어야 한다 (예: `A1`, `B3`, `AA12`). `_labelToCoord`는 정규식 `/^([A-Z]+)(\d+)$/`으로 파싱하므로, 소문자나 다른 형식의 라벨은 인식하지 못한다. 표가 26행 이상이면 `AA`, `AB`... 로 확장된다.

### 12.10 _resizeListenerRegistered 리셋

`_deactivateTableEditing`에서 `_resizeListenerRegistered = false`로 리셋하지 않으면, layoutEditMode를 토글한 후 resize handle이 표시되지만 pointerdown 리스너가 재등록되지 않아 리사이즈가 동작하지 않는다. 이 리셋은 layoutEditMode 토글 후에도 resize가 정상 동작하도록 보장한다.

### 12.11 _applyNewData에서 TR 전체 재생성

`_applyNewData`는 기존 TR을 모두 제거한 후 `table.data = newData`를 설정한다. 이는 ID 기반 reconciliation으로 인한 box shadow DOM style sheet 손상을 방지하기 위함이다. 병합/분할/삽입/삭제 후 항상 이 방식으로 데이터를 갱신한다.

### 12.12 colspan/rowspan DOM attribute 동기화

TR은 `height` attribute를, TD는 `colspan`/`rowspan` attribute를 `observedAttributes`로 감지한다. property → attribute, attribute → property 양방향 동기화가 구현되어 있다. `data` setter에서도 attribute를 설정한다.

---

## 13. 공개 API

### 13.1 LayoutTableElement

```typescript
class LayoutTableElement extends HTMLElement {
  // 속성
  get data(): TableData;
  set data(value: TableData);

  get colWidths(): number | number[] | undefined;
  set colWidths(value: number | number[] | undefined);

  get rows(): TableRowData[];
  get gridResolution(): GridResolution | null;
  get inheritStyle(): InheritStyle | undefined;
  set inheritStyle(value: InheritStyle | undefined);

  get items(): LayoutTableRowElement[];
  get type(): 'table';
  get editManager(): EditManager | null;

  // 편집 제어
  get keyboardController(): TableKeyboardController | null;
  get structureEditor(): TableStructureEditor | null;
  _activateTableEditing(): void;
  _deactivateTableEditing(): void;

  // Selection overlay
  _renderSelectionOverlay(selection: TableCellSelection | null): void;
  _clearSelectionOverlay(): void;

  // 구조 변경 알림
  notifyTablePropertyChange(): void;

  // 자식 추가
  appendChildData(child: TableRowData): LayoutTableRowElement;

  // 인쇄
  get printPostData(): PrintPostData[];
}
```

### 13.2 TableKeyboardController

```typescript
class TableKeyboardController {
  get selection(): TableCellSelection | null;
  set selection(value: TableCellSelection | null);

  get active(): boolean;
  activate(): void;
  deactivate(): void;

  getSelectedCells(): LayoutTableCellElement[];
  handleKeyDown(event: KeyboardEvent): boolean;

  // 구조 편집 (외부 호출 가능)
  handleMerge(): void;
  insertRowBelow(): void;
  insertRowAbove(): void;
  insertColRight(): void;
  insertColLeft(): void;
  deleteRow(): void;
  deleteCol(): void;
}
```

### 13.3 TableStructureEditor

```typescript
class TableStructureEditor {
  // 병합/해제
  mergeCells(selection: TableCellSelection): void;
  unmergeCell(cellCoord: CellCoord): void;

  // 행/열 삽입
  insertRowBelow(): void;
  insertRowAbove(): void;
  insertColRight(): void;
  insertColLeft(): void;

  // 행/열 삭제
  deleteRow(): void;
  deleteCol(): void;

  // 너비/높이 균등 분할
  equalizeWidth(selection: TableCellSelection): void;
  equalizeHeight(selection: TableCellSelection): void;

  // 레거시 API (호환성 유지)
  insertRowOrCol(target: 'row' | 'col', index?: number, count?: number, size?: number): void;
  deleteRowOrCol(target: 'row' | 'col', index?: number, count?: number): void;
}
```

### 13.4 LayoutTableCellElement

```typescript
class LayoutTableCellElement extends HTMLElement {
  get data(): TableCellData;
  set data(value: TableCellData);

  get colspan(): number;
  set colspan(value: number);
  get rowspan(): number;
  set rowspan(value: number);

  get cellLabel(): string;
  get cellLabels(): string[];

  get borderTop(): CellBorderEdge | undefined;
  get borderRight(): CellBorderEdge | undefined;
  get borderBottom(): CellBorderEdge | undefined;
  get borderLeft(): CellBorderEdge | undefined;

  get backgroundColor(): string | undefined;
  set backgroundColor(value: string | undefined);
  get backgroundOpacity(): number | undefined;
  set backgroundOpacity(value: number | undefined);

  get diagonals(): Array<'tl-br' | 'tr-bl'> | undefined;
  set diagonals(value: Array<'tl-br' | 'tr-bl'> | undefined);

  get paddingTop(): number;
  set paddingTop(value: number);
  // paddingRight, paddingBottom, paddingLeft 동일

  get items(): LayoutBoxElement[];
  get contentType(): 'box' | 'paragraph' | 'image' | 'table' | undefined;
  get contentElement(): LayoutBoxElement | LayoutParagraphElement | LayoutImageElement | null;

  appendChildData(child: BoxData): LayoutBoxElement;
  get printPostData(): PrintPostData[];
}
```

### 13.5 LayoutTableRowElement

```typescript
class LayoutTableRowElement extends HTMLElement {
  get data(): TableRowData;
  set data(value: TableRowData);

  get height(): number;
  set height(value: number);

  get rowIndex(): number;
  get rowLabel(): string;

  get items(): LayoutTableCellElement[];
  get type(): 'tr';

  appendChildData(child: TableCellData): LayoutTableCellElement;
  get printPostData(): PrintPostData[];
}
```

---

## 14. 상수

```typescript
const Z_INDEX_TABLE_SELECTION = 99989;  // selection overlay
const Z_INDEX_TABLE_BORDER = 99990;     // border-collapse 레이어
const Z_INDEX_TABLE_DIAGONAL = 99991;   // 대각선
const Z_INDEX_TABLE_RESIZE = 99992;     // resize handle

const MIN_TABLE_COL_WIDTH = 5;           // mm
const MIN_TABLE_ROW_HEIGHT = 5;          // mm
const TABLE_KEYBOARD_RESIZE_STEP = 1;    // mm (Alt+arrow)

const HIT_WIDTH = 8;                     // px (resize handle 히트 영역)
```

---

## 15. 요소 삽입 모드를 통한 테이블 생성

### 15.1 InsertMode 확장

`InsertType`에 `'table'`이 추가되었다. `InsertMode`에 `tableRows`/`tableCols`/`tableFillCells` optional 필드가 추가되었다.

```typescript
interface InsertMode {
  type: 'box' | 'text' | 'paragraph' | 'image' | 'table';
  position: 'absolute' | 'static';
  tableRows?: number;        // 기본값 3
  tableCols?: number;        // 기본값 3
  tableFillCells?: boolean;  // 기본값 true — false면 빈 셀(children: [])로 생성
}
```

### 15.2 테이블 생성 동작

`InsertController._createElement`에서 `mode.type === 'table'`일 때:
- `_createTableData(rows, cols, fillCells)`로 `TableData` 생성
- `tableFillCells !== false`(기본값)이면 각 셀은 빈 box(빈 paragraph 포함)를 자식으로 가짐
- `tableFillCells === false`면 각 셀은 빈 셀(`children: []`)로 생성 — 사용자가 직접 셀에 요소를 삽입해야 함
- 행 높이 기본값: 5mm
- 열 너비: 자동 균등 분할 (생성 후 `colWidths`로 조정 가능)
- box의 `children`에 `TableData`를 설정

### 15.3 사용 방법

```typescript
// 기본값 (3행 3열, 셀을 paragraph로 채움)으로 테이블 생성
editManager.insertMode = { type: 'table', position: 'static' };

// 5행 4열 테이블 생성
editManager.insertMode = { type: 'table', position: 'static', tableRows: 5, tableCols: 4 };

// absolute 위치에 테이블 생성
editManager.insertMode = { type: 'table', position: 'absolute', tableRows: 2, tableCols: 2 };

// 빈 셀로 테이블 생성 (셀에 paragraph box를 채우지 않음)
editManager.insertMode = { type: 'table', position: 'static', tableRows: 3, tableCols: 3, tableFillCells: false };
```

드래그로 영역을 그린 후 mouseup하면 해당 영역에 테이블이 생성된다. `tableRows`/`tableCols`를 생략하면 기본값(3×3)이, `tableFillCells`를 생략하면 `true`가 사용된다. 생성 후 `insertRowBelow`/`insertColRight`/`deleteRow`/`deleteCol` 등으로 행/열을 조정할 수 있다.