# AGENTS.md — layout-element

## Project Overview

Newspaper layout engine implemented as Web Components (Custom Elements). Renders document layouts in the browser — multi-column text, character-by-character text wrapping with overlap avoidance around images, and proportional font width (장평) control — features CSS cannot properly handle.

**Engine-first principle**: The engine tree (`DocumentEngine` → `BoxEngine` → `ParagraphEngine`/`ImageEngine`/`TableEngine`) is the single source of truth for all layout calculations and data. DOM elements delegate `data` getter to `engine.extractData` — they do not independently assemble data from their own properties. When editing occurs, DOM properties are updated, `_layoutStructure()` collects data via `_rawData()` (bypassing `data` getter to avoid circular reference), the engine reprocesses it, and the result propagates back to the DOM through `extractData`.

**Editing support**: Cursor, selection, IME composition, and inline run style editing (bold/italic/size/color via `Ctrl+B`/`Ctrl+I` or `EditManager.applyInlineStyle`/`toggleInlineStyle`) are implemented in `TextEditController` and `TextEditCoordinateMapper`. Inline run editing uses `RunMap` (`src/edit/run-map.ts`) to map plain-text offsets (textarea) ↔ inline runs (`model.textContent`); every text change syncs the run map first, then rebuilds `model.textContent` via `plainToInline`. Text/paragraph style injection goes through `EditManager.applyTextStyle(textPatch?, paragraphPatch?)` — the single entry point decides the injection target by edit state: selection → inline run range; cursor inside a run → that run only; cursor on plain text → paragraph style + cascade to all runs; focused-out selected paragraph/paragraph-box → paragraph style + full cascade. Non-inlinable fields (textAlign, lineGap, verticalAlign, letterSpacing, widthRatio) always go to the paragraph. `normalizeRunMap` unwraps runs identical to the paragraph effective style and merges adjacent same-style runs (auto-run on focus/blur/after injection); cursor and selection positions are preserved. Edit state (focus, events) is managed by per-document `EditManager` instances.

**Style injection layering rule (run-map-mutation is edit-domain work)**: Run map mutation — field override via `applyStyleToRange`, and removal of run fields that became identical to the paragraph effective style after injection — lives in the edit layer (`TextEditController._applyTextStyle` / `run-map.ts`), NOT in the engine. The engine (`ParagraphEngine`) receives only the fully normalized `(string | TextInlineData)[]` via `model.textContent` and owns all wrapping/line-breaking/column computation (`layoutText`). DOM elements only display engine output (`columnContents`). Do not move the "strip paragraph-default run fields" responsibility into `run-map.ts`'s `normalizeRunMap` or into the engine — it is an edit policy; detail in `docs/EDITING_TEXT.md` § 6A.5.1.

## Commands

```bash
npm run dev              # Vite dev server, opens examples/index.html
npm run build            # Vite library build → dist/ (IIFE + React ESM + .d.ts)
npm run build:obfuscate  # build + JavaScript obfuscation (scripts/obfuscate.mjs)
npm run preview          # Preview production build
```

No test runner, linter, or formatter is configured.

## Required Documentation Loading

Before working on any feature, you **must** read the corresponding documentation file first. After completing changes, you **must** also update the documentation to reflect the results.

| Feature Area | Required Reading | When to Load |
|---|---|---|
| Paragraph text rendering | `docs/TEXT_ENGINE.md` | ParagraphEngine, text wrapping, column rendering, character layout, overlap avoidance |
| Font & color management | `docs/RESOURCE.md` | FontLoader, ColorRegistry, CMYK/RGB conversion, font registration |
| Text editing mode | `docs/EDITING_TEXT.md` | TextEditController, TextEditCoordinateMapper, EditManager text-mode API, cursor, selection, IME composition, keyboard shortcuts |
| Layout editing mode | `docs/EDITING_LAYOUT.md` | LayoutEditController, LayoutSelectionController, box positioning, drag/resize, selection |
| Insert mode | `docs/EDITING_INSERT.md` | InsertController, insert mode activation, drag-to-insert, target container selection |
| EditManager events | `docs/EDITING_EVENTS.md` | EditManager event types, payload fields, event dispatch, reentrancy guard |
| Place Gun | `docs/EDITING_PLACE_GUN.md` | PlaceGunController, item loading/unloading, click-to-place, pause, reorder |
| Table editing | `docs/EDITING_TABLE.md` | Table element, cell block selection, cell merge/split, table keyboard shortcuts, TableStructureEditor |
| Rendering performance | `docs/PERFORMANCE.md` | LRU caching, char width cache, style cache, queueMicrotask batch rendering, incremental style sheet update, skeleton layout cache |
| Vanilla JS API reference | `docs/API.md` | Custom Element public API (properties, methods, events), utility functions, constants |
| React component layer | `docs/REACT_COMPONENT.md` | React wrapper components, props, hooks (`useEditManager`, `useLayoutElement`, `useEditableText`) |
| Engine layer (Node.js) | `docs/ENGINE.md` | `src/engine/` classes, ppm injection, RGBA data, overlap detection, Node.js compatibility |

## Build Output

- **IIFE bundle** (`dist/layout-element.iife.js`): Format IIFE, global name `LayoutElement`, entry `src/index.ts`, no React code.
- **React ESM bundle** (`dist/layout-element-react.mjs`): Format ESM, entry `src/react/index.ts`, externalizes `react` and `react/jsx-runtime` (peer dependency).
- **Types**: `vite-plugin-dts` with `insertTypesEntry` — produces `dist/layout-element.d.ts` and per-file `dist/**/*.d.ts`.
- **Path alias**: `@` → `./src/*`.

## Architecture

### Custom Element Tree

```
<x-layout-document>          ← Root. Owns DocumentEngine, coordinates rendering pipeline
  <x-layout-guide-column>    ← Debug grid overlay
  <x-layout-box>             ← Positioned container (static=column-grid | absolute=mm coords)
    <x-layout-paragraph>     ← Multi-column text area with wrapping; owns TextEditController when editableText
      <x-layout-column>      ← Individual text column (rendered text lines)
    <x-layout-image>         ← Canvas-based image crop element
    <x-layout-table>         ← Table container (box content type). Grid + border layer + resize handles
      <x-layout-tr>          ← Table row. height(mm)
        <x-layout-td>        ← Table cell. colspan/rowspan, box-equivalent container
          <x-layout-box>     ← Cell content (paragraph/image/nested-table wrapped in box)

Edit mode elements (in shadow DOM of <x-layout-paragraph>):
  <x-layout-cursor>         ← 1px width cursor element
  <x-layout-selection>      ← Selection highlight element
```

### Rendering Pipeline (3 phases)

1. **`layout()`** — synchronous. `_layoutStructure()` (model data assignment), `_applyStyle()` (CSS styles), `_renderGuideColumns()` (document) / `_renderBorder()` (box/table), `_propagateInheritStyle()` (child style propagation). Table additionally calls `_renderResizeHandles()` and optionally `_renderSelectionOverlay()`.
2. **`render()`** — async. `render()` in document/box sorts children by z-index descending and recurses; `render()` in paragraph calls ParagraphEngine for text wrapping + column DOM update; `render()` in image loads and crops canvas image.
3. **`renderText()`** (on `<x-layout-column>`) — Diff-based character-by-character rendering via ParagraphEngine. Reuses existing spans by `data-source-offset` key.

**Order matters.** `layout()` must complete before `render()`; image elements must render before adjacent text so overlap detection works.

### Key Domain Concepts

- **All measurements are in mm** (millimeters). `LayoutDocumentElement.ppm` (pixels-per-mm, measured from a 100mm `<div>`) is injected into `DocumentEngine.ppm`. Engine computations are mm-only — ppm is optional and only needed for browser display.
- **Column grid system**: `columns: number` = equal-width columns; `columns: number[]` = explicit per-column widths. Same for `gap`.
- **`position: 'static'`** (default): `left` = column index (0-based), `width` = column span count, `height` = line count. **Not mm.**
- **`position: 'absolute'`**: `left`/`top`/`width`/`height` are actual mm values.
- **`BoxRole`** (`BoxData.role`): `'group-article'`, `'body'`, `'image'`, `'title'`, `'caption'`, `'group-image'`, `'header'`, `'ad'`, `'byline'`, `'none'` (default).
- **InheritStyle cascade**: `TextStyle` + `ParagraphStyle` + parent dimensions flow downward. Children override individual fields.
- **Text overflow**: `render-error` CustomEvent with `{ type: 'text-overflow', overflow: number }`. `:host` gets `inset 0 -8px 0 0 #ff0000` when overflow.
- **Render complete**: `render-complete` CustomEvent after every `LayoutParagraphElement.render()`. Payload: `RenderCompleteEventDetail`.
- **printPostData 엔진 전용 API**: 엔진 트리(`DocumentEngine.printPostData`)가 단일 소스. DOM 요소의 `printPostData` getter는 제거되었다. `printPostData`는 엔진 전용 API로, DOM에서 호출하지 않는다. 모든 rect/char 좌표는 **mm 단위 number**. ppm 곱셈은 외부 후처리 시스템이 수행한다.
- **`BoxEngine.contentAbsRect`**: padding 제외한 콘텐츠 영역 절대 사각형 (mm). `ImageEngine.contentAbsRect`로 주입되어 object-fit 계산에 사용.
- **`BoxEngine.absHeight` 테이블 셀 stretch**: 부모가 `TableCellEngine`인 static box는 `gc.contentHeight`(셀 높이 - 셀 패딩)를 반환. DOM `box.element.ts _applyStyle`가 `tdContentHeight`를 height로 사용하는 것과 일치. 일반 static box는 `lineHeight × height - (lineHeight - fontSize)` 공식 유지.
- **`ImageEngine.displayRect`**: `contentAbsRect` + `objectFit` + `originalWidth/Height`로 계산한 이미지 실제 표시 영역 (절대 좌표, mm). 엔진이 단일 소스이며, 브라우저는 이 결과로 canvas에 표시.
- **`ImageEngine.computeOverlap`**: `displayRect`를 기준으로 오버랩 판정. 시그니처는 `(lineRectMm: MmRect)` — imgRectMm 파라미터 제거, 내부적으로 `displayRect` 사용.
- **`verticalAlign` 엔진 좌표 기반 전환 (엔진 우선 원칙)**: 과거에는 `genColumnStyle`이 `flexDirection: column` + `justifyContent`로 브라우저 flexbox에 수직 정렬을 위임했다. 엔진 우선 원칙에 따라 엔진이 각 라인의 절대 y 좌표를 산출하고 DOM은 좌표에 라인을 배치하도록 전환했다. `genColumnStyle`은 `display: block` + `position: relative` 컨테이너로 변경, `genLineStyle(textBlockStyle, columnIndex, lineIndex)`이 `position: absolute` + `top: ${alignOffsetMm + lineIndex × lineHeight}mm`를 적용한다. `buildParagraphPrintPostData`, `getCharRect`, `getOffsetFromPoint` 모두 동일한 `_computeAlignOffsetMm(column, effectiveColumnHeightMm, baseFontSizeMm, columnHeightMm)` 헬퍼를 사용하여 단일 소스를 보장한다. flexbox 정렬은 완전히 제거되었다.
- **static box 렌더링 높이 원칙 — 마지막 라인 line gap 제외**: static box의 렌더링 높이 N라인 = `(N-1) * lineHeight + fontSize` (`BoxEngine.absHeight` 공식). 마지막 라인의 line gap(`= lineHeight - fontSize`)은 렌더링에서 제외된다. **드래그 클램핑, 리사이즈, containment 검사, 좌표 변환 등 static box 높이가 관여하는 모든 계산은 이 원칙을 따라야 한다.** `maxTop = floor((editableTextHeight - fontSize) / lineHeight) - height + 1`, `maxLines = floor((editableTextHeight - fontSize) / lineHeight) + 1`. `fontSize`를 누락하면 "박스가 부모 하단까지 내려가지 않는" 버그가 재발한다. 상세한 적용 대상과 금지 공식은 `RULES.md § 1.8` 참조.
- **`buildParagraphPrintPostData` part.left 누적 오프셋**: `part.left`는 이전 part 끝에서의 갭이므로, printPostData char x 좌표 계산 시 `partStartMm`에 갭과 width를 누적하여 절대 오프셋을 계산.
- **Overlap padding**: `overlapPadding` on `ImageData` — mm values, `number` or `{ top?, right?, bottom?, left? }`. Ellipse-based detection: `ndx² + ndy² ≤ 1`.
- **Overlap mode**: `overlapMode` on `ImageData` — `'path'` (default, pixel contour), `'box'` (solid box), `'none'` (no avoidance). Paragraph-level: `ParagraphData.overlapMode` — `'box'` (default), `'none'` (excludes box from overlay targets).
- **Node.js base64 이미지 자동 디코딩**: `DocumentEngine._buildImageEngine()`에서 `ImageData.url`이 base64 data URI인 경우 pngjs로 자동 디코딩하여 `ImageEngine.rgbaData`에 주입. ESM 환경에서는 `await engine.prepareImageDecoder()` 사전 호출 필요.
- **object-fit 엔진 우선**: `src/engine/object-fit-engine.ts`의 `computeObjectFit()`이 단일 소스. `image.element.ts`는 엔진의 `computeObjectFit`을 사용. `src/utils/image-fit.ts`는 제거되었다.
- **이미지 속성 변경 시 재렌더링**: `overlapPadding`, `overlapMode`, `objectFit`, `originalWidth`, `originalHeight` setter가 `_updateEngine()` + `requestRerenderAffectedParagraphs()`를 호출하여 엔진 데이터 갱신과 paragraph 재렌더링을 트리거.
- **AI processing overlay**: `<x-layout-paragraph>` and `<x-layout-image>` have volatile `aiProcessing: boolean` property. `true` → semi-transparent overlay with shimmer + spinner. Not included in `data` getter. Implemented in `src/utils/ai-processing-overlay.ts`.
- **`extractData` — 엔진 데이터 추출**: 모든 엔진 타입이 `extractData` getter를 통해 현재 상태에서 데이터를 조립하여 반환. `children`은 원본이 아닌 자식 엔진의 `extractData`에서 동적으로 조립. ParagraphEngine은 주입된 스타일만 반환 (effective getter 사용 안 함).
- **`_rawData()` — DOM 프로퍼티 조립**: 모든 DOM 요소가 `_rawData()` 메서드를 가짐. 엔진에 의존하지 않고 DOM 프로퍼티에서 직접 데이터를 조립. `_layoutStructure()`와 `_serializeChildren()`에서 `data` getter 대신 `_rawData()`를 사용하여 순환 참조 방지.
- **DOM `data` getter 위임**: `get data()`는 `engine.extractData`를 반환 (엔진이 없으면 `_rawData()` 폴백). DOM은 엔진이 주는 값만 사용.
- **`effectiveParagraphStyle`/`effectiveTextStyle`**: 내부 소비용 getter. `{ ...DEFAULT, ..._inheritStyle, ..._paragraphStyle }` 순서로 병합 (주입값 → 상속값 → 기본값). `textStyle`/`paragraphStyle` getter도 이 effective getter를 반환.
- **`ImageEngineData`에서 `id` 제거**: `id`/`zIndex`는 `ImageEngine._id`/`_zIndex` 필드에서 관리. `ImageEngineData`는 순수 계산용 타입이므로 메타데이터 제외.

### Managers (ColorRegistry and FontLoader are singletons; EditManager is per-document. All must init before rendering.)

- **`ColorRegistry`**: Loads `color.json` → CMYK→RGB→hex. `getCSSColor(name)` returns hex. **`'default'` name is prohibited** — throws `Error`. Fallback: `_defaultColor` (K100 black).
- **`FontLoader`**: Loads `fonts.json` → registers `FontFace` objects. `base64Data` takes precedence over `ttfFilename`. Uses `opentype.js` for char width measurement. `getFontFamily(fontName?)` returns dynamic `FontFace.family`.
- **`EditManager`**: Per-document instance created in `LayoutDocumentElement` constructor. Dispatches events: `focusChange`, `textChange`, `styleChange`, `selectionStart`, `selectionEnd`, `cursorMove`, `layoutSelectionChange`, `layoutMove`, `layoutResize`, `layoutAdd`, `layoutRemove`, `insert`, `insertCancel`, `modeChange`, `boxPropertyChange`, `contextMenu`, `placeGunChange`, `placeGunBefore`, `placeGunAfter`, `cellSelectionChange`. Provides `focusParagraph()` / `blurParagraph()` API. `reset()` clears all edit state (not event listeners).

## Important Constraints

### Git Commits — Explicit Request Only

- **Never commit unless the user explicitly requests it.** Even if previous commits were made in the same session, each commit requires its own explicit instruction.
- Commits must only stage files relevant to the current change. Do not stage unrelated modified files (e.g., `examples/index.html`, `docs/` unless directly changed by the task).
- Follow the repo's commit message style: `type: description` (e.g., `fix: ...`, `refactor: ...`, `feat: ...`).

### Engine-First Principle

> **CRITICAL — Read before any engine or DOM modification.**
> Violating these rules breaks the architecture and causes data synchronization bugs.
> See `RULES.md § 3` for enforcement details.

#### Architecture Boundary

The system has two layers:

| Layer | Role | Knows about |
|---|---|---|
| **Engine** (`src/engine/`) | Pure computation — layout calculation, data extraction | Own data + child engines. **NOT DOM.** |
| **DOM** (`src/components/`) | Rendering — displays engine results | Own engine + DOM children (for rendering only) |

The engine layer is designed for future **canvas rendering** — it must remain DOM-free so it can render without DOM elements.

#### Hard Rules

1. **Engines MUST NOT reference DOM elements.** No `HTMLElement` parameters, no `localName`, no `items`, no `_rawData()` calls from within `src/engine/`. Engines receive **pure data** (`BoxData`, `TableRowData`, etc.) only.

2. **Engines MUST NOT store `children` in `_data`.** `engine.layout(childrenData)` receives children as a **parameter** — a pure data array. `engine.data` setter receives only the element's own properties (no `children` field). This prevents stale `_data.children` synchronization bugs.

3. **`engine.layout()` signature**: `layout(ctx, childrenData, resources?, docStyle?)` for `BoxEngine`; `layout(childrenData?)` for `DocumentEngine` and `TableEngine`. The `childrenData` parameter is the **only** source of child data during layout.

4. **DOM elements pass children data to engine**: `engine.layout(this.items.map(e => e._rawData()))`. This is a **temporary** DOM-era pattern. When canvas rendering replaces DOM, the engine will read from its own child engine tree directly.

5. **`extractData` assembles children from child engines**: `_childEngines.map(e => e.extractData)`, NOT from `_data.children`. This is the engine's single source for external data extraction.

6. **DOM property setters update engine first**: `box.left = 50` → `this._left = 50` → `_syncEngineBoxData()` → `engine.data = { ..., left: 50 }` (no children) → `layout()`. The engine is always up-to-date before rendering.

7. **`_rawData()` excludes `children`** for elements that have engines (`Box`, `Document`, `Table`). It returns only the element's own properties. Children are assembled by `extractData` or passed via `layout(childrenData)`.

8. **Leaf elements** (`Paragraph`, `Image`) have no child engines. Their `_rawData()` may include content/properties but not children. Their engines are created by parent `BoxEngine` (which has the required context: `inheritStyle`, `parentAbsRect`, `resources`, `overlayEngines`).

- The engine tree is the single source of truth for all layout calculations **and data extraction**. DOM elements delegate `data` getter to `engine.extractData` — they do not independently assemble data from their own properties.
- When editing occurs: DOM property update → `_layoutStructure()` → `_rawData()` (not `data` getter, to avoid circular reference) → `engine.data` setter (own props only) → `engine.layout(childrenData)` → `extractData` returns updated data.
- **`extractData` getter**: Every engine type (`DocumentEngine`, `BoxEngine`, `ParagraphEngine`, `ImageEngine`, `TableEngine`, `TableCellEngine`) has an `extractData` getter that assembles the current engine state into the corresponding data type (`DocumentData`, `BoxData`, etc.). Children are dynamically assembled from child engines' `extractData`, not from `_data.children`.
- **`_rawData()` method**: Every DOM element has a `_rawData()` method that assembles data from DOM properties without engine dependency. For elements with child engines (`Box`, `Document`, `Table`), `_rawData()` excludes `children`. Used by `_layoutStructure()` to avoid circular reference when `data` getter delegates to `engine.extractData`.
- **`data` getter delegation**: `get data()` returns `engine.extractData` if engine exists, otherwise falls back to `_rawData()`.
- **Default values via effective getters**: Engine getters (`effectiveParagraphStyle`, `effectiveTextStyle`, `effectiveOverlapMode`, etc.) merge injected values → inherited values → default values. These getters are for **internal layout computation only** — they are NOT used by `extractData`. DOM receives data from the engine where `paragraphStyle`/`textStyle` contain injected values only (not merged with inherited/default).
- **`sourceParagraphStyle`/`sourceTextStyle` removed**: `_paragraphStyle`/`_textStyle` store injected values only (no merge with parent styles). `effectiveParagraphStyle`/`effectiveTextStyle` getters perform the merge: `{ ...DEFAULT, ..._inheritStyle, ..._paragraphStyle }`.

### `extractData` — Engine Data Extraction

- **`DocumentEngine.extractData`**: Returns `DocumentData` with `children` dynamically assembled from `childBoxEngines.map(e => e.extractData)`. Padding values use getter defaults (`?? 0`).
- **`BoxEngine.extractData`**: Returns `BoxData` with all fields defaulted via getters (`position ?? 'static'`, `zIndex ?? 0`, `role ?? 'none'`, `borderTopWidth ?? 0`, `borderStyle ?? DEFAULT_BORDER_STYLE`, `priority ?? 0`, `backgroundOpacity ?? 1`, `lock ?? false`, etc.). `children` dynamically assembled from `childEngines.map(e => e.extractData)`.
- **`ParagraphEngine.extractData`**: Returns `ParagraphData` assembled from the engine's actual internal state — **not** the merged `effectiveParagraphStyle`/`effectiveTextStyle`. `paragraphStyle`/`textStyle` iterate over the injected `_paragraphStyle`/`_textStyle` objects only (주입값 only, excludes inherited and default values), returning `undefined` when the injected object is empty. `column`/`gap` are the adjusted `_columnWidths`/`_gaps` (in table cells, parent `gridCalculator` values; outside, injected values). `overlapMode ?? 'box'`, `zIndex ?? 0`. No caching — a fresh `ParagraphData` object is built on every access.
- **`ImageEngine.extractData`**: Returns `ImageData` with all fields defaulted via effective getters (`dpi ?? DEFAULT_IMAGE_DPI`, `overlapMode ?? 'path'`, `objectFit ?? 'cover'`, `x/y/width/height ?? 0`, `zIndex ?? 0`).
- **`TableEngine.extractData`**: Returns `TableData` with `children` assembled from `rowEngines` → `cellEngines` → `boxEngine.extractData`. `borders` from `borderStore.toTableBorders()`.
- **`TableCellEngine.extractData`**: Returns `TableCellData` with defaults (`colspan ?? 1`, `rowspan ?? 1`, `padding ?? 0`). `children` from `boxEngine.extractData`. Border fields removed — borders are managed by `TableBorderStore` on the parent `TableEngine`.
- **`TableBorderStore` — 테이블 면 기반 보더 관리**: 테이블 보더는 셀이 아닌 테이블이 면(face) 단위로 관리. `TableBorderStore`가 `hFaces[line][col]` (수평, `(rowCount+1) × colCount`) / `vFaces[row][line]` (수직, `rowCount × (colCount+1)`) 배열을 보유. 셀의 border getter/setter는 부모 테이블 스토어에 위임. `setCellBorder(cellEngine, side, face)` / `getCellBorder(cellEngine, side)` / `resetCellBorder(cellEngine, side)`. Last-write-wins. 병합 셀 getter는 여러 면 조회 시 값이 섞여 있으면 `undefined`. 보더 위치: 내부는 셀 경계 중심(`y/x - width/2`), 외곽 상단/좌측은 안쪽으로만(`y/x`), 외곽 하단/우측은 안쪽으로만(`y/x - width`). `BorderSegment.lineIndex`로 외곽 판정.

### `findEngineById()` — Engine Tree Search

- **`DocumentEngine.findEngineById(id)`**: Recursively searches the entire engine tree (BoxEngine, ParagraphEngine, ImageEngine, TableEngine). Traverses nested boxes and table cell boxes.
- **`BoxEngine.findEngineById(id)`**: Searches self + child engines + nested child boxes + table cell boxes.
- **`TableCellEngine.findEngineById(id)`**: Delegates to `boxEngine.findEngineById()`.
- **`TableCellEngine.findBoxEngineById(id)`**: Returns `this._boxEngine` if `this._boxEngine.data.id === id` (the cell's own boxEngine, not a child). `BoxEngine.findBoxEngineById` searches `childEngines` only, so it cannot find the cell's boxEngine itself — `LayoutBoxElement._findParentEngine()` returns the `TableCellEngine` (not its `boxEngine`) to ensure the correct lookup.
- Existing `findBoxEngineById(id)` (BoxEngine-only search) is retained for `BoxEngineParent` interface compatibility.

### ID Auto-Generation

- **DOM `data` setter**: All DOM elements (`document`, `box`, `paragraph`, `image`, `table`, `tr`, `td`) auto-generate `id` via `genUUID()` in the `data` setter when `data.id` is `undefined`. This ensures id is assigned immediately upon data injection, before `engine.layout()`.
- **`connectedCallback`**: `genUUID()` calls removed from all elements' `connectedCallback`. ID generation is now exclusively handled by `data` setter (for DOM) or engine (for Node.js standalone).
- **Engine fallback**: `_buildBoxEngine`, `_buildParagraphEngine`, `_buildImageEngine`, `_buildTableEngine` still auto-generate `id` via `generateEngineId()` when `data.id` is `undefined`, for Node.js standalone usage without DOM.
- **`_syncEngineIdsToDom()`**: After `engine.layout()`, engine-generated IDs are written back to DOM elements recursively (`_syncEngineIdsToDomRecursive`). This covers nested boxes, paragraphs, images, and tables.

### `_syncEngineIdsToDom()` — Engine ID Write-Back

- Called after `engine.layout()` in `document._layoutStructure()`.
- Top-level boxes: `engineBoxes[i].data.id` → `domBoxes[i].id`.
- Recursive: `_syncEngineIdsToDomRecursive(engineBox, domBox)` traverses child engines and matches by `localName` (not `instanceof`, to avoid circular import issues).
- Matches `x-layout-box`, `x-layout-paragraph`, `x-layout-image`, `x-layout-table` by `localName` string comparison.

### `disconnectedCallback` — No Engine Splice

- **`disconnectedCallback` must NOT splice the element's engine from the parent's `childEngines`/`childBoxEngines`.**
- Reason: `data` setter's ID-keyed reconcile uses `appendChild` to reorder existing children. `appendChild` fires `disconnectedCallback` → `connectedCallback` within the same parent. Splicing the engine during this transient disconnect causes `_buildTree`'s `findBoxEngineById` to miss the existing engine and create a new one, losing engine state (rgbaData, _layoutCache, etc.).
- `DocumentEngine._buildTree()` rebuilds the entire engine tree on every `layout()` call, so manual splice is redundant.
- Applied to: `LayoutBoxElement`, `LayoutParagraphElement`, `LayoutImageElement`.

### `disconnectedCallback` — Image Cache Preservation

- **`LayoutImageElement.disconnectedCallback` must NOT call `_clearImageCache()`.**
- During `data` setter reconcile, `appendChild` triggers `disconnectedCallback`. Clearing the cache forces async re-loading (`await _resolveUrl + await _loadImage`), causing image flicker.
- Image cache is invalidated only on URL change (`data`/`url` setter) or explicit `_clearImageCache()` call.

### `disconnectedCallback` — Cursor/Selection Preservation

- **`LayoutParagraphElement.disconnectedCallback` saves cursor offset and selection** via `_savedCursorOffset` / `_savedSelection` before destroying `_editController`.
- **`connectedCallback` restores them** when recreating `_editController`, then clears the saved values.
- This prevents cursor jump during `data` setter reconcile.

### `HOST_STYLE_ID` — Style Element Identification

- All layout elements (`box`, `column`, `table`, `td`, `tr`, `paragraph`) use `HOST_STYLE_ID = '__layout_host_style__'` to identify their own `<style>` element in shadow DOM.
- `_applyStyle()` queries `style#${HOST_STYLE_ID}` instead of bare `querySelector('style')`.
- Reason: AI processing overlay adds its own `<style>` element (`OVERLAY_STYLE_ID`). Without ID-based query, `_applyStyle()` could pick up the AI overlay style and overwrite it, losing `:host` rules.
- `removeAiProcessingOverlay()` also removes its own style element (`OVERLAY_STYLE_ID`) to prevent accumulation across disconnect/reconnect cycles.

### `ParagraphEngine.updateOverlayContext()` — Cache-Preserving Overlay Update

- `updateOverlayContext(overlayEngines, parentAbsRect, inheritStyle)` updates overlay context while preserving `_layoutCache`.
- Use this instead of `data` setter (which calls `resetIncrementalState()` → `_layoutCache = null`) when only overlay positions changed.
- `_computeLayoutInputHash()` includes overlay positions, so if positions are unchanged, `layoutText()` returns cached result in O(1).
- Used in: `LayoutParagraphElement.render()` else branch, `DocumentEngine._refreshParagraphOverlays()`.

### `DocumentEngine._refreshParagraphOverlays()` — Overlay Refresh

- Called after `_buildTree()`. Updates all paragraph overlay contexts.
- Uses `updateOverlayContext()` (not `data` setter) to preserve `_layoutCache`.
- **Traverses `TableEngine` children**: `rowEngines` → `cellEngines` → `cellEngine.boxEngine` → recursive `_refreshParagraphOverlays([cellBox])`. TableEngine is not in `BoxEngine.childBoxEngines`, so explicit traversal is required.
- **No `overlayEngines.length > 0` guard**: All paragraphs are refreshed, including those with zero overlays. This ensures paragraphs that previously had overlays but no longer do are updated (stale overlayEngines cleared).

### `DocumentEngine._buildParagraphEngine()` — No `layoutText()`

- `_buildParagraphEngine` does NOT call `layoutText()`. It only calls `layoutStructure()`.
- `layoutText()` is executed once in `_refreshParagraphOverlays()`.
- Reason: Previously `_buildParagraphEngine` called `layoutText()`, then `_refreshParagraphOverlays` called `data` setter → `resetIncrementalState()` → `_layoutCache = null`, discarding the first `layoutText()` result. Now there is a single `layoutText()` execution.

### `ParagraphEngine.data` setter — Table Cell column/gap Adjustment (Engine-First)

- The `data` setter checks `options.parentBox?.parent.isTableCellEngine` and, if true, uses `parentBox.gridCalculator.columnWidth`/`gaps` instead of `options.column`/`options.gap`.
- This ensures table cell paragraphs use the cell's actual width (from `TableEngine.layout()`) regardless of any explicit `column`/`gap` stored in `ParagraphData`.
- The adjustment happens entirely in the engine — DOM (`LayoutParagraphElement._layoutStructure`) passes `parentBox` via `ParagraphEngineData` and does not perform any cell-width adjustment itself.
- `extractData` returns the adjusted `_columnWidths`/`_gaps`, so `document.data` round-trips preserve the cell-width-corrected values.
- `TableCellEngine` exposes `readonly isTableCellEngine = true` as a duck-type identifier (used instead of `instanceof` to avoid a circular import between `paragraph-engine.ts` and `table-engine.ts`).

### `TableEngine.buildCellBoxEngines()` — Post-Layout Cell Box Engine Rebuild

- `TableEngine.layout()` rebuilds `_rowEngines` and `TableCellEngine` instances but does **not** rebuild cell box engines (`TableCellEngine.boxEngine`). Cell box engines are only created inside `BoxEngine._buildTableEngine()`, which is called during the parent `BoxEngine.layout()`.
- After table structure edits (merge/split/insert/delete via `TableStructureEditor`), `TableElement._layoutStructure()` calls `engine.layout()` but the parent `BoxEngine.layout()` is never called, so `boxEngine` stays `null` for cells where `prevBoxEngines` label-based restoration fails.
- `TableCellEngine.extractData` returns `this._boxEngine ? [this._boxEngine.extractData] : []` — when `boxEngine` is null, `children` is an empty array, losing cell content data.
- `TableEngine.buildCellBoxEngines(parentBox, ctx)` iterates `gridResolution.placements`, finds matching `TableCellEngine`, and calls `parentBox.buildCellBoxEngine(cellData, cellEngine, ctx)` for each cell to rebuild its `boxEngine`. It reuses existing box engines by ID (`prevBoxEnginesByBoxId`) and creates new ones when needed.
- `BoxEngine.buildCellBoxEngine(data, cellEngine, ctx)` is the public alias of `_buildCellBoxEngine`, exposing cell box engine construction for `TableEngine` to call after its own `layout()`.
- `TableElement._layoutStructure()` calls `this._engine.buildCellBoxEngines(parentBoxEngine, ctx)` immediately after `this._engine.layout(...)` with a fresh `BoxBuildContext`, ensuring `extractData` always returns complete cell content after structure edits.

### `DocumentEngine._buildBoxEngine()` — GC Reuse

- `_buildBoxEngine` checks if the existing `GridCalculatorEngine` has the same parameters via `_gcParamsEqual()`. If equal, the GC instance is reused (skipping `_calcColumnGridCoords`).
- Compared fields: `width`, `height`, `paddingTop/Right/Bottom/Left`, `columns`, `gap` (via `valueEqual`), `paragraphStyle` (reference equality), `textStyle` (reference equality), `isBox`.
- `paragraphStyle`/`textStyle` are from `this._data` (DocumentData), so they are stable references within a single `layout()` call.

### `appendChildData()` — Incremental Addition

- `LayoutBoxElement.appendChildData(child)` and `LayoutDocumentElement.appendChildData(child)` use `_appendChildData(child)` + `requestRerenderAffectedParagraphs()` — NOT `this.data = {...}` round-trip.
- The `data` setter round-trip reconciles ALL existing children (`.data = child` → each child's `layout()` + `render()`), causing O(N) redundant rendering for a single child addition.
- Incremental path: O(1) — only the new child is created + rendered, then affected paragraphs re-render.
- The `data` setter is still used for full-document restores (undo/redo, external data assignment) where ID-keyed reconciliation is needed.

### Diff-based `data` Setter (ID-keyed child reconciliation)

- `LayoutDocumentElement` and `LayoutBoxElement` `data` setters reconcile children by `id`:
  0. Refresh own `GridCalculatorEngine` (`_layoutStructure()`) before any `appendChild` (children's `connectedCallback` reads `parentModel.columnCoords`).
  1. Build `Map<id, element>` from existing children.
  2. For each child: if `id` matches existing element of same tag type → reuse (`element.data = child`), else create new.
  3. Reorder with `appendChild`.
  4. Remove unused elements.
- Elements without `id` in `data` get auto-generated via `genUUID()` in the `data` setter. All elements have `id` guaranteed after `data` setter.

### z-index Range Constraint

- Layout element `zIndex`: `0 ~ 90000` (`Z_INDEX_MAX_LAYOUT`).
- `90001 ~ 99999`: reserved for UI elements (edit handles, labels, overlays, table chrome). See `src/constants/defaults.ts`.
- Role-based override: `role: 'ad'` → `91000` (`Z_INDEX_ROLE_AD`), `role: 'header'` → `91001` (`Z_INDEX_ROLE_HEADER`). Setter and `data` setter's zIndex assignment are blocked when role is `ad`/`header`.
- `Z_INDEX_TEXTAREA = 9999` is intentionally below `90001` (editing affordance, not layout data).

### Other Constraints

- **No `new` on models**: `GridCalculatorEngine.create()` and `ParagraphEngine.create()` are the only way to instantiate. Constructors are `private`.
- **Shadow DOM**: Every element uses `attachShadow({ mode: "open" })`. Styles injected via `styleEl.sheet.insertRule()`.
- **CSSOM invalidation on shadow DOM slot reassignment**: Observed empirically: when `appendChild(x-layout-paragraph)` is called on `x-layout-box`'s shadow DOM, column `cssRules.length` drops from 1→0 synchronously. No `deleteRule` call, no `styleEl.remove()`, and no `_applyStyle()` on the column causes this — it happens during the browser's internal slot re-evaluation. The exact Chromium internal mechanism is unconfirmed (would require browser source verification), but the observable trigger is `appendChild` of a slotted element into a parent shadow DOM. Two defenses: (1) `connectedCallback` clears `_cachedColStyleKey` so reconnecting columns always re-inject styles; (2) `renderText()` also checks `styleEl.sheet.cssRules.length === 0` as a safety net for CSSOM invalidation without reconnect.
- **Column `connectedCallback` cache clear**: `LayoutColumnElement.connectedCallback()` sets `this._cachedColStyleKey = ''` before calling `renderText()`. This ensures that when a column is reconnected to the DOM (e.g. during data setter reconciliation with `appendChild` reorder), the style cache is invalidated and styles are always re-injected.
- **`<slot>` deduplication**: All layout elements with `<slot>` in `_applyStyle()` (`box`, `paragraph`, `table`, `tr`, `td`) guard against accumulation with `!this._shadowRoot.querySelector('slot')`. Without this guard, `needsInit = true` on repeated calls causes `<slot>` accumulation in the shadow DOM.
- **Box `_labelEl` deduplication**: `LayoutBoxElement._applyStyle()` only creates `_labelEl` when it doesn't already exist (`!this._labelEl`). Without this guard, `needsInit = true` on repeated calls creates duplicate label elements.
- **opentype.js char width**: `_charWidthMm()` uses `glyph.advanceWidth / unitsPerEm * fontSize`. `minWidthMm = spaceRatio * fontSize` floor. `genCharStyle()` sets `width`/`maxWidth` in mm, inner span uses `scale: ${widthRatio * 0.88} 1` for 장평.
- **Infinite loop guard**: `_layoutTextIntoColumns()` force-places characters wider than any part width into the first part.
- **`getFontFamily()` is dynamic**: Returns matching `FontFace.family` from registered fonts, not hardcoded.
- **No tests exist**: No test infrastructure. Verify with `npm run build` and `npm run dev`.
- **`noUnusedLocals`/`noUnusedParameters`**: Enabled in tsconfig — dead imports/params cause build errors.
- **TypeScript 7 RC**: `noEmit: true` — `tsc` is type-check only, Vite handles compilation.
- **Key-based span rendering**: `renderText()` uses `data-source-offset` as diff key. `data-offset` (rendered position) coexists for `EditCoordinateMapper`.
- **Optimistic spans**: `data-temporary="true"` spans stripped at start of every `renderText()`.
- **Edited text flows through `model.textContent`**: `paragraph.data.content` getter and `_layoutStructure()` use `this._model?.textContent ?? this._sourceContent`.
- **`paragraph.data` setter triggers `scheduleRender()`**: `layout()` + `_perfStructureChanged = true` + `scheduleRender()`.
- **TextEditContextAdapter** (`@deprecated`): `create()` always returns `null`. Textarea-based fallback is used in all browsers.
- **Box child DOM mutation detection**: `MutationObserver` (`_childObserver`) with `{ childList: true }`. `_rebuildingChildren` flag suppresses during `data` setter. `_pendingData` cache ensures correct `data` getter during setter execution.
- **`contentElement` getter**: Recursively follows `contentType` path to return deepest non-box child. Used by `computeOverlapSizeMm` for safe `overlapPadding`/`canvas`/mm coordinate access in nested box structures.
- **Reparent mode**: `layoutEditMode = { type: 'reparent' }`. `_tryReparent` extracts `box.data`, converts coordinates, clamps via `clampStaticToContainer`/`clampAbsoluteToContainer`, sets zIndex to new container's max + 1, calls `newContainer.appendChildData()`.
- **Container clamp**: `clampStaticToContainer`/`clampAbsoluteToContainer` applied in reparent, insert, and placegun.
- **Tab key interception**: `LayoutDocumentElement._onWindowKeyDown` at `window` capture phase calls `editManager.navigateByTab(shiftKey)`. Returns early if `activeElement` is input/textarea/button/select.
- **LRU char width cache**: `ParagraphEngine._charWidthCache` (capacity 5000), key: `${char}|${fontName}|${fontSize}`.
- **LRU char outer style cache**: `ParagraphEngine._charOuterStyleCache` (capacity 5000), key: `${char}|${widthRatio}|${letterSpacing}|${spaceRatio}`.
- **Skeleton layout cache**: `ParagraphEngine._layoutCache` — input-parameter hash. `resetIncrementalState()` clears it. `updateOverlayContext()` preserves it.
- **queueMicrotask batch rendering**: `scheduleRender()` coalesces multiple `render()` calls. `flushRender()` cancels and runs immediately.
- **Box resize rules**: Minimum size (static: 1단×1라인, absolute: 5mm×5mm). Child-content-based blocking via `_computeChildMinRightMm()`/`_computeChildMinBottomMm()`. Multi-select resize propagates delta.

## Directory Structure

```
src/
  components/     # Custom Elements (each file = one element + customElements.define)
    edit/
      cursor.element.ts      # <x-layout-cursor>
      selection.element.ts   # <x-layout-selection>
      index.ts
    layout/
      box.element.ts
      column.element.ts
      document.element.ts
      guide-column.element.ts
      image.element.ts
      paragraph.element.ts
      table.element.ts
      tr.element.ts
      td.element.ts
      index.ts
    index.ts
  engine/                    # Node.js-compatible pure computation (no DOM/Canvas/FontFace)
    types.ts
    table-grid-resolver.ts
    border-store.ts
    grid-calculator-engine.ts
    image-engine.ts
    image-decoder.ts
    object-fit-engine.ts
    overlap-engine.ts
    box-engine.ts
    table-engine.ts
    paragraph-engine.ts
    document-engine.ts
    font-loader-engine.ts
    color-registry-engine.ts
    index.ts
  edit/
    text-edit-context-adapter.ts
    text-edit-controller.ts
    text-edit-coordinate-mapper.ts
    edit-manager.ts
    layout-edit-controller.ts
    layout-selection-controller.ts
    insert-controller.ts
    place-gun-controller.ts
    table-keyboard-controller.ts
    table-structure-editor.ts
    index.ts
  resource/
    color-registry.ts
    font-loader.ts
    index.ts
  types/
    layout/                  # DocumentData, BoxData, ParagraphData, ImageData, etc.
    style/                   # TextStyle, ParagraphStyle, InheritStyle, etc.
    print/                   # PrintPostData
    edit/                    # CursorPosition, SelectionRange, InsertMode, etc.
    index.ts
  constants/                 # DEFAULT_*, Z_INDEX_* constants, line-break rules
  utils/                     # genUUID, ai-processing-overlay, valueEqual, LRU, containment clamp
  examples/                  # exampleData (demo content for dev)
  react/                     # React wrapper layer (separate ESM build)
    components/              # LayoutDocument, LayoutBox, LayoutParagraph, LayoutImage, LayoutTable, etc.
    hooks/                   # useEditableText, useEditManager, useLayoutElement
    context.tsx
    index.ts
  globals.d.ts
  opentype.d.ts
  index.ts                   # Vanilla entry point
examples/
  index.html
  color.json
  fonts.json
  fonts/
  test/
```

## React Integration

- **Vanilla**: `layout-element` (or `dist/layout-element.iife.js`) — Custom Elements only.
- **React**: `layout-element/react` (or `dist/layout-element-react.mjs`) — React wrappers rendering the same Custom Elements.
- `react` is a peer dependency (`>=19.0.0`). IIFE bundle does not contain React.
- `src/react/` re-exports vanilla API + adds wrapper components, hooks, and context.
- React build does **not** empty `dist/`, preserving IIFE bundle and `.d.ts`.

```ts
import { LayoutDocumentElement } from 'layout-element';
import { LayoutDocument, LayoutBox, LayoutParagraph, LayoutImage, useEditableText } from 'layout-element/react';
```