# AGENTS.md — layout-element

## Project Overview

Newspaper layout engine implemented as Web Components (Custom Elements). Renders print-style document layouts in the browser — multi-column text, character-by-character text wrapping with overlap avoidance around images, and proportional font width (장평) control — features CSS cannot properly handle.

**Editing support is under development.** Cursor, selection, and IME composition are implemented in `TextEditController` and `TextEditCoordinateMapper`. Global edit state (focus, events) is managed by the `EditManager` singleton.

## Commands

```bash
npm run dev      # Vite dev server, opens examples/index.html
npm run build    # Vite library build → dist/ (IIFE + React ESM + .d.ts)
npm run preview  # Preview production build
```

No test runner, linter, or formatter is configured.

> **See also**: `RULES.md` for code modification rules, intentional design decisions, and common mistakes to avoid.

## Required Documentation Loading

Before working on any feature, you **must** read the corresponding documentation file first. After completing changes, you **must** also update the documentation to reflect the results.

| Feature Area | Required Reading | When to Load |
|---|---|---|
| Paragraph text rendering | `docs/TEXT_ENGINE.md` | Any request, modification, or work involving TextLayoutEngine, text wrapping, column rendering, character layout, or overlap avoidance |
| Font & color management | `docs/RESOURCE.md` | Any request, modification, or work involving FontLoader, ColorRegistry, CMYK/RGB conversion, CSS variable injection, or font registration |
| Text editing mode | `docs/EDITING_TEXT.md` | Any request, modification, or work involving TextEditController, TextEditCoordinateMapper, EditManager, cursor, selection, IME composition, or keyboard shortcuts |
| Layout editing mode | `docs/EDITING_LAYOUT.md` | Any request, modification, or work involving layout editing, box positioning, interactive layout changes, or drag/resize |

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
- **Types**: Generated via `vite-plugin-dts` with `rollupTypes` — produces a single bundled `dist/layout-element.d.ts`
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
- **`BoxRole`** (`BoxData.role`): 박스의 의미적 역할. `<x-layout-box>`의 `role` 속성으로 설정되며, 렌더링 및 레이아웃 배치 시 참조된다. 가능한 값: `'group-article'` (기사 그룹 컨테이너), `'body'` (본문 영역), `'image'` (이미지 영역), `'title'` (제목 영역), `'caption'` (캡션 영역), `'group-image'` (이미지 그룹 컨테이너), `'header'` (면머리 그룹 컨테이너), `'ad'` (광고 이미지 영역).
- **InheritStyle cascade**: `TextStyle` + `ParagraphStyle` + parent dimensions flow downward. Children override individual fields.
- **Text overflow**: dispatched as `render-error` CustomEvent with `{ type: 'text-overflow', overflow: number }`.
- **Overlap padding**: `overlapPadding` on `ImageData` adds padding around opaque image pixels during overlap detection. Values in mm; `number` applies equally to all sides, `{ top?, right?, bottom?, left? }` allows asymmetric padding. Uses per-column ellipse detection: for each opaque pixel, normalized distance `(ndx² + ndy² ≤ 1)` determines if the pixel's padding zone reaches the text line. Transparent pixels are excluded. Each opaque column's blocking range is extended horizontally by `padLeft`/`padRight`.
- **Print mode**: `window.matchMedia("print")` — managers expect data injection via setters instead of fetch. Images and guide columns are hidden via `@media print` CSS rules; their rendered positions are collected by `printPostData` for post-processing. Editing features (`editableLayout`, `editableText`) are completely blocked in print mode — setters return early without creating controllers or event listeners.

### Managers (Singletons, must init before rendering)

- **`ColorRegistry`**: Loads `color.json` → CMYK→RGB conversion → injects CSS variables `--colorman-{name}`. In print mode, receives `CMYKColorSet` via `init()` instead of fetching.
- **`FontLoader`**: Loads `fonts.json` → registers `FontFace` objects. In print mode, uses `base64Data` instead of `ttfFilename`. Hardcoded return value `getFontFamily()` → `'Myoungjo'`.
- **`EditManager`**: Singleton (`src/edit/edit-manager.ts`) that manages global edit state. Tracks focused paragraph/controller, dispatches events (`focusChange`, `textChange`, `styleChange`, `selectionStart`, `selectionEnd`, `cursorMove`, `layoutSelectionChange`). Provides `focusParagraph()` / `blurParagraph()` API for programmatic focus control. `TextEditController` instances register/unregister with it. **Mode switching**: Each mode setter deactivates other modes when activated — `layoutEditMode = true` switches `textEditMode = false` and `insertMode = null`; `textEditMode = true` switches `layoutEditMode = false` and `insertMode = null`; `insertMode = (non-null)` switches both `layoutEditMode = false` and `textEditMode = false`. `selectableMode` is always independent. **Selection mode**: `selectableMode` property enables box selection (click to select) independently from `layoutEditMode` (drag/resize). `selectLayout()` uses `isBoxSelectable()` which checks lock/root/role/id filters without requiring `layoutEditMode`. Drag/resize still require `layoutEditMode = true`. **Selection controller**: `LayoutSelectionController` handles click-to-select independently from `LayoutEditController` which handles drag/resize. Clicking empty space (no box) clears all selection.

## Important Constraints

- **No `new` on models**: `GridCalculator.create()` and `TextLayoutEngine.create()` are the only way to instantiate. Constructors are `private`.
- **Shadow DOM**: Every element uses `attachShadow({ mode: "open" })`. Styles are injected programmatically via `styleEl.sheet.insertRule()`, not in HTML templates.
- **Virtual columns are temporary**: `<x-layout-vcolumn>` is created during `layoutText()` for measurement and removed immediately after. Never persist these.
- **Canvas `measureText()` for char width**: `_charWidthPx()` uses Canvas `measureText().width` (advance width) clamped to `maxWidthPx = widthRatio * fontSizePx` for layout calculations. `genCharStyle()` uses both `maxWidth: ${widthRatio}em` (layout box) and `scale: ${widthRatio} 1` (glyph shape) to implement 장평.
- **Infinite loop guard**: `_layoutTextIntoColumns()` force-places characters wider than any available part width into the first part, preventing infinite loops.
- **Cursor position in whitespace**: `getNearestOffsetFromPoint()` detects trailing whitespace (past row's rightmost span) and leading whitespace (before row's leftmost span) clicks to place cursor after last char or before first char respectively, bypassing midpoint logic.
- **ImageData coordinates are pixels, not mm**: `x`, `y`, `width`, `height` in `ImageData` refer to source image pixels. `dpi` converts them to mm. `overlapPadding` values are in mm and internally converted to screen pixels via `GridCalculator.ppm`.
- **overlapPadding uses ellipse-based detection**: When `overlapPadding` is set on an image, `getOverlapSizePX()` uses per-column ellipse detection instead of simple rectangle intersection. Each opaque pixel's distance to the text line is normalized by the directional padding values (`ndx = dx/horizPad`, `ndy = dy/vertPad`), and pixels within the elliptical padding zone (`ndx² + ndy² ≤ 1`) are considered overlapping. This creates a naturally rounded padding zone around the image's opaque shape, not a rectangular bounding box. Transparent areas do not block text. Falls back to geometric expanded rectangle when canvas is unavailable.
- **`getFontFamily()` is hardcoded**: Currently returns `'Myoungjo'` regardless of input. Font family mapping is not implemented.
- **No tests exist**: There is no test infrastructure. No `vitest`, no `jest`, no test files.
- **ColorRegistry without stylesheet**: `ColorRegistry.init()` sets `_ready = true` even when no stylesheet is available (SSR, test environments). Color data is accessible via `colorMap` but CSS variables are not injected.
- **Guide column printPostData**: `LayoutGuideColumnElement` has a `printPostData` getter that returns position/size data for print post-processing, matching the pattern of other layout elements.
- **EditManager singleton**: `EditManager.getInstance()` manages focus across all editableText paragraphs. Only one paragraph can be focused at a time. `TextEditController` auto-registers on construction and auto-unregisters on `destroy()`.
- **Key-based span rendering**: `column.element.ts` `renderText()` uses `data-source-offset` as the reconciliation key for span diff rendering. Existing spans are reused when content unchanged; only changed spans are updated. `data-offset` (rendered offset) is retained for `EditCoordinateMapper` compatibility.
- **`data-source-offset` vs `data-offset`**: `data-source-offset` = source string position (used as diff key). `data-offset` = rendered position (used by TextEditCoordinateMapper for click-to-cursor mapping). Both attributes coexist on every span.
- **Optimistic spans are temporary**: `data-temporary="true"` spans are stripped at the start of every `renderTextWithDiff()` call and recreated by `TextEditController` as needed.
- **TextEditContextAdapter**: `src/edit/text-edit-context-adapter.ts` bridges the browser EditContext API (Chrome 121+) with the layout engine. `TextEditContextAdapter.create()` returns `null` if the API is not supported.
- **Box child DOM mutation detection**: `<x-layout-box>` uses a `MutationObserver` (`_childObserver`) with `{ childList: true }` to detect direct DOM additions/removals of children (`x-layout-box`, `x-layout-paragraph`, `x-layout-image`). When children are added or removed via DOM manipulation (not through the `data` setter), the observer triggers `layout()` + `render()` automatically, mirroring the behavior of the `data` setter. The `_rebuildingChildren` flag suppresses observer callbacks during `data` setter execution to avoid redundant layout passes.

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
    edit-manager.ts          # EditManager singleton (global edit state)
    layout-edit-controller.ts # LayoutEditController (drag/resize/select in edit mode)
    layout-selection-controller.ts # LayoutSelectionController (click-to-select in selectable mode)
    insert-controller.ts     # InsertController (drag-to-insert)
    index.ts
  resource/
    color-registry.ts        # ColorRegistry (CMYK→RGB singleton)
    font-loader.ts           # FontLoader (font loading singleton)
    index.ts
  types/
    layout/                  # DocumentData, BoxData, ParagraphData, ImageData, GuideColumnData, TextData
      box.type.ts
      document.type.ts
      guide-column.type.ts
      image.type.ts
      paragraph.type.ts
      text.type.ts
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
    edit/                    # CursorPosition, SelectionRange, EditModel
      cursor.type.ts
      selection.type.ts
      index.ts
    index.ts
  constants/                 # Constants: DEFAULT_FONT_SIZE, DEFAULT_PPM, etc.
    defaults.ts
    index.ts
  utils/                     # checkOverlap, getOverlapSizePX, genUUID
    check-overlap.ts
    gen-uuid.ts
    random.ts                # genRandom() helper (not exported by utils/index.ts)
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
      index.ts
    hooks/                   # React hooks for editable text state and manager access
      use-editable-text.ts
      use-edit-manager.ts
      use-layout-element.ts
      index.ts
    context.tsx              # React Context provider for layout options
    index.ts                 # React entry point: re-exports vanilla library + React layer
  globals.d.ts               # JSX intrinsic elements for React interop
  index.ts                   # Vanilla entry point: exports components, core, resource, types, constants, examples
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
- **TypeScript 7 RC**: `typescript: ^7.0.1-rc` is configured. The `noEmit: true` setting means `tsc` is type-check only; actual compilation is handled by Vite.
- **`noUnusedLocals` and `noUnusedParameters`** are enabled in tsconfig — dead imports or unused params will cause build errors.
- **Cursor width is 1px**: The `<x-edit-cursor>` element has a fixed width of 1px and does not blink.
- **Korean IME composition**: TextEditController handles IME composition via `compositionstart`, `compositionupdate`, and `compositionend` events. This is essential for Korean text input on Windows (TSF), macOS, and Linux (IBus).
- **Mouse coordinate freshness**: `_onMouseMove` stores the latest `clientX`/`clientY` on every mousemove event and reads them from the `requestAnimationFrame` callback, ensuring drag selection follows the cursor accurately during fast movement.
- **EditManager events**: Use `EditManager.getInstance().addEventListener(type, listener)` to subscribe to edit events. Types: `focusChange`, `textChange`, `styleChange`, `selectionStart`, `selectionEnd`, `cursorMove`. The old `selectionChange` event was removed.
- **Programmatic focus**: Use `EditManager.getInstance().focusParagraph(target, options?)` and `blurParagraph(target?)` instead of calling `paragraph.editableText` or `controller.focus()` directly.

Keyboard shortcut documentation has been moved to `docs/EDITING_TEXT.md` Section 4.

## React Integration

The library ships two separate builds:

- **Vanilla**: `layout-element` (or `dist/layout-element.iife.js`) — Custom Elements only, no React code.
- **React**: `layout-element/react` (or `dist/layout-element-react.mjs`) — React wrappers that render the same Custom Elements.

### Directory structure

`src/react/` is kept in a separate build. It re-exports everything from the vanilla entry point (`@/types`, `@/core`, `@/resource`, `@/constants`, `@/components`, `@/edit`) and adds React-specific wrappers:

- `components/` — one wrapper component per Custom Element (`LayoutDocument`, `LayoutBox`, `LayoutParagraph`, `LayoutImage`, `LayoutGuideColumn`).
- `hooks/` — `useEditable`, `useEditManager`, `useLayoutElement`.
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
  useEditable,
} from 'layout-element/react';
```

```tsx
<LayoutImage
  data={imageData}
  overlapPadding={{ top: 2, right: 5, bottom: 2, left: 5 }}
/>
```

`react` is a peer dependency (`>=18.0.0`). The IIFE bundle does not bundle or reference React.