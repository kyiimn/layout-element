# AGENTS.md — layout-element

## Project Overview

Newspaper layout engine implemented as Web Components (Custom Elements). Renders print-style document layouts in the browser — multi-column text, character-by-character text wrapping with overlap avoidance around images, and proportional font width (장평) control — features CSS cannot properly handle.

**Editing support is under development.** Cursor, selection, and IME composition are implemented in `TextEditController` and `TextEditCoordinateMapper`. Edit state (focus, events) is managed by per-document `EditManager` instances — each `LayoutDocumentElement` owns its own `EditManager`, created automatically in `connectedCallback`.

## Commands

```bash
npm run dev              # Vite dev server, opens examples/index.html
npm run build            # Vite library build → dist/ (IIFE + React ESM + .d.ts)
npm run build:obfuscate  # build + JavaScript obfuscation (scripts/obfuscate.mjs)
npm run preview          # Preview production build
```

No test runner, linter, or formatter is configured.

> **See also**: `RULES.md` for code modification rules, intentional design decisions, and common mistakes to avoid.

## Required Documentation Loading

Before working on any feature, you **must** read the corresponding documentation file first. After completing changes, you **must** also update the documentation to reflect the results.

| Feature Area | Required Reading | When to Load |
|---|---|---|
| Paragraph text rendering | `docs/TEXT_ENGINE.md` | Any request, modification, or work involving TextLayoutEngine, text wrapping, column rendering, character layout, or overlap avoidance |
| Font & color management | `docs/RESOURCE.md` | Any request, modification, or work involving FontLoader, ColorRegistry, CMYK/RGB conversion, CSS variable injection, or font registration |
| Text editing mode | `docs/EDITING_TEXT.md` | Any request, modification, or work involving TextEditController, TextEditCoordinateMapper, EditManager text-mode API, cursor, selection, IME composition, or keyboard shortcuts |
| Layout editing mode | `docs/EDITING_LAYOUT.md` | Any request, modification, or work involving layout editing, box positioning, interactive layout changes, drag/resize, or selection (LayoutEditController, LayoutSelectionController) |
| Insert mode | `docs/EDITING_INSERT.md` | Any request, modification, or work involving InsertController, insert mode activation, drag-to-insert, target container selection, or element creation during insert |
| EditManager events | `docs/EDITING_EVENTS.md` | Any request, modification, or work involving EditManager event types, payload fields, event dispatch, `addEventListener`/`removeEventListener`, `_dispatching` reentrancy guard, or `_suppressNextClick` click suppression |
| Place Gun | `docs/EDITING_PLACE_GUN.md` | Any request, modification, or work involving Place Gun, PlaceGunItem, PlaceGunController, item loading/unloading, click-to-place, pause, or reorder |
| Vanilla JS API reference | `docs/API.md` | Any request, modification, or work involving Custom Element public API (properties, methods, events), paragraph/image element public properties, utility functions, or constants |
| React component layer | `docs/REACT_COMPONENT.md` | Any request, modification, or work involving React wrapper components (`LayoutDocument`, `LayoutBox`, `LayoutParagraph`, `LayoutImage`), their props, or hooks (`useEditManager`, `useLayoutElement`, `useEditableText`) |

**Rule**: Load the doc → understand current state → implement changes → update the doc to reflect what changed.

## Mandatory Documentation Updates

When you make **any** of the following changes, you **must** update the corresponding `docs/` file(s) before completing the work:

| Change Type | Examples | Must Update |
|---|---|---|
| **Feature added** | New property, method, event, mode, or capability | Relevant `docs/*.md` + `AGENTS.md` if architecture changed |
| **Feature modified** | Behavior change, parameter/return type change, algorithm update | Relevant `docs/*.md` |
| **Feature removed** | Deleted property, method, event, or capability | Relevant `docs/*.md` |
| **Interface changed** | New/removed/renamed type, class, function signature, or export | Relevant `docs/*.md` + `AGENTS.md` if directory structure changed |
| **Public API changed** | New/changed/removed `EditManager` API, `BoxData` field, `ParagraphData` field, custom element attribute/property | Relevant `docs/*.md` |

**Rule**: If a user-visible behavior, API surface, or data shape changed, the docs **must** reflect it. "Should work the same" is not documentation — if the code changed, verify the docs still match.

## Build Output

- **IIFE bundle** (`dist/layout-element.iife.js`)
  - Format: IIFE (`formats: ['iife']` in `vite.config.ts`)
  - Global name: `LayoutElement`
  - Entry: `src/index.ts`
  - Does **not** contain React code
- **React ESM bundle** (`dist/layout-element-react.mjs`)
  - Format: ESM (`formats: ['es']` in `vite.config.react.ts`)
  - Entry: `src/react/index.ts`
  - Externalizes `react` and `react/jsx-runtime` (peer dependency)
- **Types**: Generated via `vite-plugin-dts` with `insertTypesEntry` — produces a bundled `dist/layout-element.d.ts` (entry) and per-file `dist/**/*.d.ts`
- **Path alias**: `@` → `./src/*` (both tsconfig.json and vite.config.ts)

## Architecture

### Custom Element Tree

```
<x-layout-document>          ← Root. Owns GridCalculator, coordinates rendering pipeline
  <x-layout-guide-column>    ← Debug grid overlay (hidden in print mode; printPostData for post-processing)
  <x-layout-box>             ← Positioned container (static=column-grid | absolute=mm coords)
    <x-layout-paragraph>     ← Multi-column text area with wrapping; owns TextEditController when editableText
      <x-layout-column>      ← Individual text column (rendered text lines)
    <x-layout-image>         ← Canvas-based image crop element
  <x-layout-vcolumn>         ← Virtual column (temporary, used only during layoutText)

Edit mode elements (in shadow DOM of <x-layout-paragraph>):
  <x-edit-cursor>            ← 1px width cursor element (in src/components/edit/)
  <x-layout-selection>       ← Selection highlight element (in src/components/edit/)
```

### Rendering Pipeline (3 phases)

1. **`layout()`** — synchronous. Calls `_layoutStructure()` (model data assignment), `_applyStyle()` (CSS styles), `_renderGuideColumns()`/`_renderBorder()` (structural DOM), `_propagateInheritStyle()` (child style propagation). Each element decomposes layout into these private sub-methods.
2. **`render()`** — async. Delegates to element-specific rendering: `render()` in document/box sorts children by z-index and recurses; `render()` in paragraph calls TextLayoutEngine for text wrapping + column DOM update; `render()` in image loads and crops canvas image.
3. **`renderText()`** (on `<x-layout-column>`) — Diff-based character-by-character rendering inside `render()` via TextLayoutEngine. Reuses existing spans by `data-source-offset` key.

**Order matters.** `layout()` must complete before `render()`; image elements must render before adjacent text so overlap detection works.

### Key Domain Concepts

- **All measurements are in mm** (millimeters). `GridCalculator.ppm` (pixels-per-mm) converts to screen pixels at runtime by measuring a 100mm `<div>`.
- **Column grid system**: `columns: number` = equal-width columns; `columns: number[]` = explicit per-column widths. Same for `gap`.
- **`position: 'static'`** (default): `left` = column index (0-based), `width` = column span count, `height` = line count. **Not mm.**
- **`position: 'absolute'`**: `left`/`top`/`width`/`height` are actual mm values.
- **`BoxRole`** (`BoxData.role`): 박스의 의미적 역할. `<x-layout-box>`의 `role` 속성으로 설정되며, 렌더링 및 레이아웃 배치 시 참조된다. 가능한 값: `'group-article'` (기사 그룹 컨테이너), `'body'` (본문 영역), `'image'` (이미지 영역), `'title'` (제목 영역), `'caption'` (캡션 영역), `'group-image'` (이미지 그룹 컨테이너), `'header'` (면머리 그룹 컨테이너), `'ad'` (광고 이미지 영역), `'byline'` (기자정보 영역).
- **InheritStyle cascade**: `TextStyle` + `ParagraphStyle` + parent dimensions flow downward. Children override individual fields.
- **Text overflow**: dispatched as `render-error` CustomEvent with `{ type: 'text-overflow', overflow: number }`. 오버플로우 발생 시 `:host`에 하단 8px 빨간 inset shadow(`inset 0 -8px 0 0 #ff0000`)가 자동 적용된다. 인쇄 모드에서는 미적용.
- **Render complete**: `LayoutParagraphElement.render()` 완료 후 항상 `render-complete` CustomEvent가 디스패치된다. 페이로드는 `RenderCompleteEventDetail` 타입(`{ type: 'paragraph', id, placed: { chars, lines }, overflow: { hasOverflow, chars, lines }, columnCount }`). `render-error`와 독립적으로 동작하며 기존 이벤트에 영향을 주지 않는다.
- **Overlap padding**: `overlapPadding` on `ImageData` adds padding around opaque image pixels during overlap detection. Values in mm; `number` applies equally to all sides, `{ top?, right?, bottom?, left? }` allows asymmetric padding. Uses per-column ellipse detection: for each opaque pixel, normalized distance `(ndx² + ndy² ≤ 1)` determines if the pixel's padding zone reaches the text line. Transparent pixels are excluded. Each opaque column's blocking range is extended horizontally by `padLeft`/`padRight`.
- **Print mode**: `window.matchMedia("print")` — managers expect data injection via setters instead of fetch. Images and guide columns are hidden via `@media print` CSS rules; their rendered positions are collected by `printPostData` for post-processing. Editing features (`editableLayout`, `editableText`) are completely blocked in print mode — setters return early without creating controllers or event listeners.
- **AI processing overlay**: `<x-layout-paragraph>`와 `<x-layout-image>`는 휘발성 `aiProcessing: boolean` property를 가진다. `true`로 설정하면 요소를 반투명 오버레이(`rgba(255,255,255,0.55)`)로 덮고 shimmer + spinner 애니메이션을 표시한다. 오버레이는 `pointer-events: auto`로 마우스 이벤트를 가로채 요소 조작을 차단한다. `data` getter에 포함되지 않으므로 저장/직렬화 시 자동 제외되는 휘발성 속성이다. `layout()`/`render()`를 트리거하지 않아 비용이 거의 없다. 인쇄 모드에서는 `@media print`로 숨김 처리된다. 오버레이 구현은 `src/utils/ai-processing-overlay.ts`의 헬퍼 함수들(`createAiProcessingOverlay`, `setAiProcessingActive`, `isAiProcessingActive`, `removeAiProcessingOverlay`)이 담당한다.

### Managers (Singletons, must init before rendering)

- **`ColorRegistry`**: Loads `color.json` → CMYK→RGB conversion → injects CSS variables `--colorman-{name}`. In print mode, receives `CMYKColorSet` via `init()` instead of fetching.
- **`FontLoader`**: Loads `fonts.json` → registers `FontFace` objects. In print mode, receives `Font[]` via `init()` and uses `base64Data` (`data:font/ttf;base64,...` URI) to register fonts without server requests (only fonts with `base64Data` are loaded). In screen mode, fetches `fonts.json` via `_loadServer()` (or a custom loader registered via `registerLoader()`) and registers fonts using `base64Data` when present, falling back to `ttfFilename` otherwise — i.e., `base64Data` takes precedence in both modes. `registerLoader(loader)` / `resetLoader()` allow replacing the default `fetch('fonts.json')` with a custom async loader (e.g., API endpoint). `init()` uses `_computeFontsSignature()` to skip redundant re-initialization when the same `Font[]` is passed again. Hardcoded return value `getFontFamily()` → `'Myoungjo'`.
- **`EditManager`**: Singleton (`src/edit/edit-manager.ts`) that manages global edit state. Tracks focused paragraph/controller, dispatches events (`focusChange`, `textChange`, `styleChange`, `selectionStart`, `selectionEnd`, `cursorMove`, `layoutSelectionChange`, `layoutMove`, `layoutResize`, `layoutAdd`, `layoutRemove`, `insert`, `insertCancel`, `modeChange`). Provides `focusParagraph()` / `blurParagraph()` API for programmatic focus control. `TextEditController` instances register/unregister with it. **Selection rules**: Selection is always active (except in print mode and insert mode). No `selectableMode` toggle needed — `LayoutSelectionController` is always attached. Clicking inside the document on empty space (not on a box) clears all selection and blurs text focus; clicking outside the document (e.g., toolbar) does nothing. **Mode switching**: Each mode setter deactivates other modes when activated — `layoutEditMode = true` (or `{ type: 'move' }`) switches `textEditMode = false` and `insertMode = null`; `layoutEditMode = { type: 'reparent' }` enables reparent mode; `textEditMode = true` switches `layoutEditMode = false` and `insertMode = null`; `insertMode = (non-null)` switches both `layoutEditMode = false` and `textEditMode = false`. **Selection preservation across mode switches**: Mode switches do NOT clear selection. Exiting layout edit mode preserves the current selection (the `editableLayout` setter no longer calls `_unregisterLayout`). **Text edit mode selection**: Entering text edit mode reduces multi-selection to single selection — if any selected box has `contentType === 'paragraph'`, the topmost such box remains selected; otherwise, the topmost selected element remains. The remaining paragraph receives focus via `focusParagraph()`. **Insert mode**: Entering insert mode clears all selection (including focused box via `clearLayoutSelection(false)`). **Focused box selection preservation**: When a paragraph receives text-edit focus, its parent `<x-layout-box>` is automatically selected via `_selectBoxForParagraph()`. This selection persists through blur (focus leaving the paragraph, but not moving to another paragraph) and mode switches. `clearLayoutSelection(preserveFocusedBox)` preserves the focused paragraph's parent box using `_lastFocusedBox` fallback when `_focusedController` is already null. Only `_unregister` (controller destruction) or `clearLayoutSelection(false)` (empty space click, insert mode) clears `_lastFocusedBox`. **Layout add/remove events**: `layoutAdd` dispatched when a layout element is added to the DOM (insert mode or reparent). `layoutRemove` dispatched when a layout element is removed from the DOM (reparent). Both include `source` field (`'insert'`, `'reparent'`, or `'programmatic'`).
## Important Constraints

- **No `new` on models**: `GridCalculator.create()` and `TextLayoutEngine.create()` are the only way to instantiate. Constructors are `private`.
- **Shadow DOM**: Every element uses `attachShadow({ mode: "open" })`. Styles are injected programmatically via `styleEl.sheet.insertRule()`, not in HTML templates.
- **Virtual columns are temporary**: `<x-layout-vcolumn>` is created during `layoutText()` for measurement and removed immediately after. Never persist these.
- **Canvas `measureText()` for char width**: `_charWidthPx()` uses Canvas `measureText().width` (advance width) clamped to `maxWidthPx = widthRatio * fontSizePx` for layout calculations. `genCharStyle()` uses both `maxWidth: ${widthRatio}em` (layout box) and `scale: ${widthRatio} 1` (glyph shape) to implement 장평.
- **Infinite loop guard**: `_layoutTextIntoColumns()` force-places characters wider than any available part width into the first part, preventing infinite loops.
- **Cursor position in whitespace**: `getNearestOffsetFromPoint()` detects trailing whitespace (past row's rightmost span) and leading whitespace (before row's leftmost span) clicks to place cursor after last char or before first char respectively, bypassing midpoint logic.
- **ImageData coordinates depend on objectFit**: `x`, `y`, `width`, `height` in `ImageData` are now **optional**. Their meaning depends on `objectFit`:
  - `objectFit !== 'none'` (cover/contain/fill, default): `x`/`y`/`width`/`height` are **source image pixels** for cropping. `dpi` converts them to mm. These are internal rendering values, not exposed to UI. When `originalWidth`/`originalHeight` are set, `_computeObjectFit` automatically computes the crop region.
  - `objectFit === 'none'`: `x`/`y`/`width`/`height` are **mm-based display position and size** within the box. The entire original image is rendered at the specified position/size. When omitted, defaults to `x=0, y=0, width=absWidth, height=absHeight` (full box).
  `overlapPadding` values are always in mm and internally converted to screen pixels via `GridCalculator.ppm`.
- **Image Object URL lifecycle**: When `urlLoader` returns a `blob:` URL (or `url` itself is `blob:`), `LayoutImageElement` tracks it in `_objectUrl` and calls `URL.revokeObjectURL()` on re-render (when the new URL differs) and in `disconnectedCallback`. This prevents memory leaks from un-revoked Object URLs. External code should not revoke blob URLs passed to `LayoutImageElement` until after the element is disconnected.
- **overlapPadding uses ellipse-based detection**: When `overlapPadding` is set on an image, `getOverlapSizePX()` uses per-column ellipse detection instead of simple rectangle intersection. Each opaque pixel's distance to the text line is normalized by the directional padding values (`ndx = dx/horizPad`, `ndy = dy/vertPad`), and pixels within the elliptical padding zone (`ndx² + ndy² ≤ 1`) are considered overlapping. This creates a naturally rounded padding zone around the image's opaque shape, not a rectangular bounding box. Transparent areas do not block text. Falls back to geometric expanded rectangle when canvas is unavailable.
- **Custom URL loader for images**: `LayoutImageElement.urlLoader` is a static `URLLoader` member shared by all image instances. When set, `render()` passes `ImageData.url` through the loader to obtain the actual URL to load (sync or async). When unset, the original URL is used directly (default behavior). Returning `null`/`undefined` from the loader skips loading. Useful for CDN rewriting, signed-URL fetching, or returning inline `data:` URLs in print mode.
- **`getFontFamily()` is hardcoded**: Currently returns `'Myoungjo'` regardless of input. Font family mapping is not implemented.
- **No tests exist**: There is no test infrastructure. No `vitest`, no `jest`, no test files.
- **ColorRegistry without stylesheet**: `ColorRegistry.init()` sets `_ready = true` even when no stylesheet is available (SSR, test environments). Color data is accessible via `colorMap` but CSS variables are not injected.
- **Guide column printPostData**: `LayoutGuideColumnElement` has a `printPostData` getter that returns position/size data for print post-processing, matching the pattern of other layout elements.
- **EditManager per-document instance**: `LayoutDocumentElement.editManager` is an `EditManager` instance created in `connectedCallback` and destroyed in `disconnectedCallback`. Each document owns its own edit state (scale, rootId, mode, focus, selection, Place Gun). `TextEditController` receives the EditManager in its constructor and auto-registers/auto-unregisters on construction/`destroy()`. Box and paragraph elements access their EditManager via the `editManager` getter (parent chain walk to `LayoutDocumentElement`). **`reset()` method**: `LayoutEditor` unmount 시 호출하여 잔류 편집 상태(선택, 포커스, 모드, 컨트롤러, 필터, Place Gun, scale)를 전체 초기화한다. 이벤트 리스너는 제거하지 않는다 (React `useEffect` cleanup이 담당). 종료 시 `modeChange` 이벤트 발생.
- **Key-based span rendering**: `column.element.ts` `renderText()` uses `data-source-offset` as the reconciliation key for span diff rendering. Existing spans are reused when content unchanged; only changed spans are updated. `data-offset` (rendered offset) is retained for `EditCoordinateMapper` compatibility.
- **`data-source-offset` vs `data-offset`**: `data-source-offset` = source string position (used as diff key). `data-offset` = rendered position (used by TextEditCoordinateMapper for click-to-cursor mapping). Both attributes coexist on every span.
- **Optimistic spans are temporary**: `data-temporary="true"` spans are stripped at the start of every `renderTextWithDiff()` call and recreated by `TextEditController` as needed.
- **Edited text flows through `model.textContent`**: When text is edited via `TextEditController`, only `model.textContent` is updated — `paragraph._sourceContent` remains the original setter value. Both `paragraph.data.content` getter and `_layoutStructure()` use `this._model?.textContent ?? this._sourceContent` to ensure the current rendered/edited text is always used, not the stale original. Without this, `layout()` triggered by a parent box move would overwrite `model.textContent` with the original empty string, erasing all user input.
- **TextEditContextAdapter**: `src/edit/text-edit-context-adapter.ts` bridges the browser EditContext API (Chrome 121+) with the layout engine. `TextEditContextAdapter.create()` returns `null` if the API is not supported.
- **Box child DOM mutation detection**: `<x-layout-box>` and `<x-layout-document>` both use a `MutationObserver` (`_childObserver`) with `{ childList: true }` to detect direct DOM additions/removals of children. When children are added or removed via DOM manipulation (not through the `data` setter), the observer triggers `layout()` + `render()` automatically, mirroring the behavior of the `data` setter. The `_rebuildingChildren` flag suppresses observer callbacks during `data` setter execution to avoid redundant layout passes. The `_pendingData` cache ensures the `data` getter returns the correct full data during setter execution (when intermediate child states may be inconsistent), preventing stale reads by external code.
- **Diff-based `data` setter (ID-keyed child reconciliation)**: `LayoutDocumentElement` and `LayoutBoxElement` `data` setters no longer unconditionally remove + recreate all children. Instead, they reconcile by `id`:
  0. Refresh own `GridCalculator` (`_layoutStructure()`) so `columnCoords` reflects the new `width`/`columns`/`gap`/`padding`. This must happen **before** any `appendChild`, because `appendChild` synchronously fires the child's `connectedCallback` → `layout()` → `relLeft`/`relTop` getters, which read `parentModel.columnCoords[this.left]`. Without this step, children read stale (or default `columns=1`) coordinates and crash on `undefined.x1`.
  1. Build a `Map<id, element>` from existing children (`this.items`).
  2. For each child in the new `data.children`:
     - If `id` matches an existing element of the same tag type → reuse it: set `element.data = child` (in-place update, preserving image cache and avoiding flicker).
     - Otherwise → create a new element via `appendChildData` / `document.createElement` + `.data = child`.
  3. Reorder reused elements with `appendChild` to match the new children order.
  4. Remove any existing elements whose `id` is not present in the new children set.

  This prevents image flicker during undo/redo and other full-document restores, because `LayoutImageElement` with the same `url` keeps its cached `HTMLImageElement` (`urlChanged === false` → `_clearImageCache()` skipped). Elements without an `id` are always recreated (no stable identity to match).
- **`appendChildData`**: `LayoutBoxElement` and `LayoutDocumentElement` expose a public `appendChildData(data)` method that creates a new child element from data (`BoxData`/`ParagraphData`/`TextData`/`ImageData`), sets its `data` property (running the full initialization pipeline: `_layoutStructure` → `_applyStyle` → `_renderBorder` → `_propagateInheritStyle` → `render`), appends it, and returns the created element. Used by `InsertController._createElement` and `LayoutEditController._tryReparent` to ensure new elements are fully initialized in the parent's `GridCalculator` context.
- **`contentElement` getter**: `LayoutBoxElement.contentElement` recursively follows the same path as `contentType` to return the deepest non-box child (`LayoutImageElement` or `LayoutParagraphElement`). When `contentType === 'image'` but the actual image is nested inside child boxes (e.g., `headerBox → imageBox → image`), `items[0]` is a `LayoutBoxElement`, not the image. `getOverlapSizePX` uses `contentElement` to safely access `overlapPadding`, `canvas`, and the image's own `getBoundingClientRect()` for pixel mapping — using `items[0]` directly causes canvas to be `undefined`, falling back to geometric overlap with the full box rect and breaking text layout in all columns.
- **Reparent mode**: `layoutEditMode = { type: 'reparent' }` enables free drag that can move boxes to different containers. During drag, boxes inside the parent use normal `left`/`top` updates (text reflow active); when dragged outside, `box.style.transform` is used to preserve rendering size. On mouseup, `_tryReparent` extracts `box.data`, converts coordinates to the new container's coordinate system (preserving original `position`/`width`/`height`), sets `zIndex` to the new container's max + 1, removes the old box, and calls `newContainer.appendChildData()` to create a fully-initialized new box. The `reparent-target` DOM attribute (orange `#ff9800` 2px border) highlights the candidate container during drag. **Insert mode** reuses the same `reparent-target` attribute and CSS to highlight the candidate container during insert drag (`InsertController._updateInsertHighlight(previewRect)` calls `_findTargetContainer` on the snapped preview rect (not raw mouse coords); `_clearInsertHighlight` removes it on cleanup).
- **z-index range constraint**: Layout element `zIndex` values must be in the range `0 ~ 90000`. The range `90001 ~ 99999` is reserved for special-purpose UI elements (edit handles, labels, overlays) and must not be used for layout data. Values at or above `100000` are not used. See `RULES.md` Section 8 for the reserved value table and `src/constants/defaults.ts` for the constants (`Z_INDEX_MAX_LAYOUT`, `Z_INDEX_RESIZE_HANDLE`, `Z_INDEX_TYPE_LABEL`, `Z_INDEX_INSERT_PREVIEW`, `Z_INDEX_AI_PROCESSING`, `Z_INDEX_TEXTAREA`).
- **Role-based z-index override**: When `BoxData.role` is `'ad'`, the `zIndex` getter returns `91000` (`Z_INDEX_ROLE_AD`); when `'header'`, it returns `91001` (`Z_INDEX_ROLE_HEADER`). The `_zIndex` internal field is preserved but the getter overrides it. **The `zIndex` setter and `data` setter's `zIndex` assignment are both blocked when `_role` is `'ad'` or `'header'`** — the fixed value cannot be changed. When the role is removed from `'ad'`/`'header'` (e.g., changed to `'none'`), `_zIndex` is restored to `max(siblings' non-override zIndex) + 1` (or `1` if no siblings), clamped to `Z_INDEX_MAX_LAYOUT`(90000). The `role` setter calls `layout()` + `requestRerenderAffectedParagraphs()` on change so the visual update is immediate. **New element creation (`InsertController._getNextZIndex`) and reparent (`LayoutEditController._tryReparent`) also exclude role-fixed z-index values (91000/91001) when computing `max(siblings' zIndex)` — these values are treated as 0 so that new elements get `max + 1` instead of being clamped to `Z_INDEX_MAX_LAYOUT`(90000).**

## Directory Structure

```
src/
  components/     # Custom Elements (each file = one element + customElements.define)
    edit/
      cursor.element.ts      # <x-edit-cursor> (1px width cursor element)
      selection.element.ts   # <x-layout-selection> (selection highlight element)
      index.ts
    layout/
      box.element.ts
      column.element.ts
      document.element.ts
      guide-column.element.ts
      image.element.ts
      paragraph.element.ts
      v-column.element.ts
      index.ts
    index.ts
  core/
    grid-calculator.ts       # GridCalculator (column grid calculation)
    text-layout-engine.ts    # TextLayoutEngine (text wrapping engine)
    index.ts
  edit/
    text-edit-context-adapter.ts  # TextEditContextAdapter (Browser EditContext API adapter)
    text-edit-controller.ts       # TextEditController (cursor, selection, IME composition)
    text-edit-coordinate-mapper.ts # TextEditCoordinateMapper (click-to-offset mapping)
    edit-manager.ts          # EditManager (per-document edit state)
    layout-edit-controller.ts # LayoutEditController (drag/resize/select in edit mode)
    layout-selection-controller.ts # LayoutSelectionController (click-to-select)
    insert-controller.ts     # InsertController (drag-to-insert)
    place-gun-controller.ts  # PlaceGunController (click-to-place from loaded items)
    index.ts
  resource/
    color-registry.ts        # ColorRegistry (CMYK→RGB singleton)
    font-loader.ts           # FontLoader (font loading singleton)
    index.ts
  types/
    layout/                  # DocumentData, BoxData, ParagraphData, ImageData, GuideColumnData, TextData, RenderCompleteEventDetail
      box.type.ts
      document.type.ts
      guide-column.type.ts
      image.type.ts
      paragraph.type.ts
      text.type.ts
      render-complete-event.type.ts  # RenderCompleteEventDetail (render-complete event payload)
      text/
        text-block.type.ts
        text-line.type.ts
      index.ts
    style/                   # TextStyle, ParagraphStyle, InheritStyle, TextBlockStyle
      color.type.ts
      font.type.ts
      inherit-style.type.ts
      paragraph-style.type.ts
      text-block-style.type.ts
      text-style.type.ts
      index.ts
    print/                   # PrintPostData (for post-processing)
      color-map.type.ts
      post-data.type.ts
      index.ts
    edit/                    # CursorPosition, SelectionRange, EditModel, InsertMode, LayoutEditType, PlaceGunItem, PlaceGunChangeEventDetail
      cursor.type.ts
      selection.type.ts
      insert.type.ts
      layout.type.ts
      place-gun.type.ts
      index.ts
    index.ts
  constants/                 # Constants: DEFAULT_FONT_SIZE, DEFAULT_PPM, z-index reservations, etc.
    defaults.ts              # DEFAULT_*, Z_INDEX_* constants
    line-break.ts            # LINE_START_FORBIDDEN / LINE_END_FORBIDDEN + isLineStartForbidden / isLineEndForbidden (한글 금칙문자)
    index.ts
  utils/                     # checkOverlap, getOverlapSizePX, genUUID, ai-processing-overlay, objectFit, valueEqual, staticGridContains
    ai-processing-overlay.ts   # createAiProcessingOverlay, setAiProcessingActive, isAiProcessingActive, removeAiProcessingOverlay
    check-overlap.ts
    gen-uuid.ts
image-fit.ts               # computeObjectFit (objectFit 프리셋 → mm 좌표/크기 변환)
value-equal.ts             # valueEqual (number | number[] 깊은 동등성 비교)
static-grid-containment.ts # staticGridContains (static 좌표계 컬럼/라인 그리드 containment 검증, 마지막 줄 lineHeight 제외 + 1)
random.ts                  # genRandom() helper (not exported by utils/index.ts)
    index.ts
  examples/                  # exampleData (demo content for dev)
    example-data.ts
    index.ts
  react/                     # React wrapper layer (separate ESM build)
    components/              # React wrapper components for each Custom Element
      layout-document.tsx
      layout-box.tsx
      layout-paragraph.tsx
      layout-image.tsx
      layout-guide-column.tsx
      logo.tsx                 # Logo (SVG mark component for dev/demo)
      index.ts
    hooks/                   # React hooks for editable text state and manager access
      use-editable-text.ts
      use-edit-manager.ts
      use-layout-element.ts
      index.ts
    context.tsx              # React Context provider for layout options
    index.ts                 # React entry point: re-exports vanilla library + React layer
  globals.d.ts               # JSX intrinsic elements for React interop
  index.ts                   # Vanilla entry point: exports components, core, resource, types, constants, utils, examples
examples/
  index.html                 # Dev demo page
  color.json                 # CMYK color definitions (fetched at runtime)
  fonts.json                 # Font metadata (fetched at runtime)
  fonts/                     # TTF font files
  test/                      # Test images
```

## Dev Workflow Gotchas

- **Managers must init**: `ColorRegistry.getInstance().init()` and `FontLoader.getInstance().init()` must be called and awaited before setting `document.data`. Without this, `getCSSColor()` and `getFontFamily()` throw. `ColorRegistry.init()` sets `_ready = true` even when no stylesheet is available (SSR, test environments) — color data is accessible via `colorMap` but CSS variables are not injected.
- **`examples/color.json` and `examples/fonts.json`**: Served by Vite dev server. The fetch URLs are relative (`color.json`, `fonts.json`), so they must be co-located with the HTML page.
- **Print mode**: Detected via `window.matchMedia("print")`. In print mode, both managers skip `fetch()` and expect data injection. The document element's `connectedCallback` assigns an `id` (auto-generated via `genUUID()` if absent) **before** returning early — you must call `.layout()` and `.render()` manually after data injection. Images and guide columns are hidden via `@media print` CSS rules (`visibility: hidden` / `display: none`); their rendered positions and sizes are instead collected via `printPostData` getters for post-processing outside the browser. Editing features (`editableLayout`, `editableText`) are completely blocked in print mode — setters return early without creating controllers or event listeners.
- **TypeScript 7 RC**: `typescript: ^7.0.2` is configured. The `noEmit: true` setting means `tsc` is type-check only; actual compilation is handled by Vite.
- **`noUnusedLocals` and `noUnusedParameters`** are enabled in tsconfig — dead imports or unused params will cause build errors.
- **Cursor width is 1px**: The `<x-edit-cursor>` element has a fixed width of 1px and does not blink.
- **Korean IME composition**: TextEditController handles IME composition via `compositionstart`, `compositionupdate`, and `compositionend` events. This is essential for Korean text input on Windows (TSF), macOS, and Linux (IBus).
- **Mouse coordinate freshness**: `_onMouseMove` stores the latest `clientX`/`clientY` on every mousemove event and reads them from the `requestAnimationFrame` callback, ensuring drag selection follows the cursor accurately during fast movement.
- **EditManager events**: Use `layoutDocEl.editManager.addEventListener(type, listener)` to subscribe to edit events. Types: `focusChange`, `textChange`, `styleChange`, `selectionStart`, `selectionEnd`, `cursorMove`, `layoutSelectionChange`, `layoutMove`, `layoutResize`, `layoutAdd`, `layoutRemove`, `insert`, `insertCancel`, `modeChange`, `boxPropertyChange`, `contextMenu`, `placeGunChange`, `placeGunBefore`, `placeGunAfter`. The old `selectionChange` event was removed. **modeChange** is dispatched when `textEditMode`/`layoutEditMode`/`insertMode` changes; payload includes `previousMode` and `mode` (`EditModeState`). **contextMenu**: dispatched on `contextmenu` DOM event (right-click) inside the document. `LayoutSelectionController._onContextMenu` applies selection rules (already-selected box → preserve selection; unselected box → clear + select; empty space → clear) then dispatches via `_dispatchContextMenu`. Payload `contextMenuDetail` includes `element` (LayoutBoxElement | LayoutDocumentElement | null), `mouseX`/`mouseY` (clientX/clientY), and `selectedLayouts` (current selection after update). **placeGunBefore/placeGunAfter**: dispatched by `PlaceGunController.handleBoxMouseDown` — `placeGunBefore` fires before item consumption/injection, `placeGunAfter` fires after injection completes. Both include `item` (PlaceGunItem) and `box` (target HTMLElement); `placeGunAfter` also includes `success` (boolean). **Double-click mode switch**: Double-clicking a paragraph in any mode (except insert mode and print mode) switches to text edit mode and focuses the paragraph at the click position. `LayoutSelectionController._onDblClick` handles this.
- **Programmatic focus**: Use `layoutDocEl.editManager.focusParagraph(target, options?)` and `blurParagraph(target?)` instead of calling `paragraph.editableText` or `controller.focus()` directly.

Keyboard shortcut documentation has been moved to `docs/EDITING_TEXT.md` Section 4.

## React Integration

The library ships two separate builds:

- **Vanilla**: `layout-element` (or `dist/layout-element.iife.js`) — Custom Elements only, no React code.
- **React**: `layout-element/react` (or `dist/layout-element-react.mjs`) — React wrappers that render the same Custom Elements.

### Directory structure

`src/react/` is kept in a separate build. It re-exports everything from the vanilla entry point (`@/types`, `@/core`, `@/resource`, `@/constants`, `@/components`, `@/edit`) and adds React-specific wrappers:

- `components/` — one wrapper component per Custom Element (`LayoutDocument`, `LayoutBox`, `LayoutParagraph`, `LayoutImage`, `LayoutGuideColumn`), plus `Logo` (SVG mark for dev/demo).
- `hooks/` — `useEditableText`, `useEditManager`, `useLayoutElement`.
- `context.tsx` — React Context provider for layout options.

### Build output

`npm run build` runs two Vite builds sequentially:

1. `vite build` — produces `dist/layout-element.iife.js` and `dist/layout-element.d.ts` from `src/index.ts`.
2. `vite build --config vite.config.react.ts` — produces `dist/layout-element-react.mjs` from `src/react/index.ts`, externalizing `react` and `react/jsx-runtime`.

The React build does **not** empty `dist/`, so the IIFE bundle and `.d.ts` from the first build are preserved.

### Usage

```ts
// Vanilla (IIFE or ESM default)
import { LayoutDocumentElement } from 'layout-element';

// React wrappers
import {
  LayoutDocument,
  LayoutBox,
  LayoutParagraph,
  LayoutImage,
  useEditableText,
} from 'layout-element/react';
```

```tsx
<LayoutImage
  data={imageData}
  overlapPadding={{ top: 2, right: 5, bottom: 2, left: 5 }}
/>
```

`react` is a peer dependency (`>=19.0.0`). The IIFE bundle does not bundle or reference React.