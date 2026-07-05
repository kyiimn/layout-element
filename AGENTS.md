# AGENTS.md — layout-element

## Project Overview

Newspaper layout engine implemented as Web Components (Custom Elements). Renders print-style document layouts in the browser — multi-column text, character-by-character text wrapping with overlap avoidance around images, and proportional font width (장평) control — features CSS cannot properly handle.

**Editing support is under development.** Cursor, selection, and IME composition are implemented in `EditController` and `EditCoordinateMapper`. Global edit state (focus, events) is managed by the `EditManager` singleton.

## Commands

```bash
npm run dev      # Vite dev server, opens examples/index.html
npm run build    # Vite library build → dist/ (IIFE format + .d.ts)
npm run preview  # Preview production build
```

No test runner, linter, or formatter is configured.

> **See also**: `RULES.md` for code modification rules, intentional design decisions, and common mistakes to avoid.

## Build Output

- **Format**: IIFE only (`formats: ['iife']` in vite.config.ts)
- **Global name**: `LayoutElement`
- **Entry**: `src/index.ts`
- **Types**: Generated via `vite-plugin-dts` with `rollupTypes` — produces a single bundled `.d.ts`
- **Path alias**: `@` → `./src/*` (both tsconfig.json and vite.config.ts)

## Architecture

### Custom Element Tree

```
<x-layout-document>          ← Root. Owns GridCalculator, coordinates rendering pipeline
  <x-layout-guide-column>    ← Debug grid overlay (hidden in print mode; printPostData for post-processing)
  <x-layout-box>             ← Positioned container (static=column-grid | absolute=mm coords)
    <x-layout-paragraph>     ← Multi-column text area with wrapping; owns EditController when editable
      <x-layout-column>      ← Individual text column (rendered text lines)
    <x-layout-image>         ← Canvas-based image crop element
  <x-layout-vcolumn>         ← Virtual column (temporary, used only during layoutText)

Edit mode elements (in shadow DOM of <x-layout-paragraph>):
  <x-edit-cursor>            ← 1px width cursor element (in src/components/edit/)
  <x-layout-selection>       ← Selection highlight element (in src/components/edit/)
```

### Rendering Pipeline (3 phases)

1. **`layout()`** — synchronous. Build DOM tree, create GridCalculator, calculate column grid coordinates
2. **`render()`** — async. Image loading + canvas crop (recursive to children)
3. **`renderText()`** (inside `render()` via TextLayoutEngine) — character-by-character text wrapping with overlap avoidance

**Order matters.** `layout()` must complete before `render()`; image elements must render before adjacent text so overlap detection works.

### Key Domain Concepts

- **All measurements are in mm** (millimeters). `GridCalculator.ppm` (pixels-per-mm) converts to screen pixels at runtime by measuring a 100mm `<div>`.
- **Column grid system**: `columns: number` = equal-width columns; `columns: number[]` = explicit per-column widths. Same for `gap`.
- **`position: 'static'`** (default): `left` = column index (0-based), `width` = column span count, `height` = line count. **Not mm.**
- **`position: 'absolute'`**: `left`/`top`/`width`/`height` are actual mm values.
- **InheritStyle cascade**: `TextStyle` + `ParagraphStyle` + parent dimensions flow downward. Children override individual fields.
- **Text overflow**: dispatched as `render-error` CustomEvent with `{ type: 'text-overflow', overflow: number }`.
- **Print mode**: `window.matchMedia("print")` — managers expect data injection via setters instead of fetch. Images and guide columns are hidden via `@media print` CSS rules; their rendered positions are collected by `printPostData` for post-processing.

### Managers (Singletons, must init before rendering)

- **`ColorRegistry`**: Loads `color.json` → CMYK→RGB conversion → injects CSS variables `--colorman-{name}`. In print mode, receives `CMYKColorSet` via `init()` instead of fetching.
- **`FontLoader`**: Loads `fonts.json` → registers `FontFace` objects. In print mode, uses `base64Data` instead of `ttfFilename`. Hardcoded return value `getFontFamily()` → `'Myoungjo'`.
- **`EditManager`**: Singleton (`src/edit/edit-manager.ts`) that manages global edit state. Tracks focused paragraph/controller, dispatches events (`focusChange`, `textChange`, `styleChange`, `selectionStart`, `selectionEnd`, `cursorMove`). Provides `focusParagraph()` / `blurParagraph()` API for programmatic focus control. `EditController` instances register/unregister with it.

## Important Constraints

- **No `new` on models**: `GridCalculator.create()` and `TextLayoutEngine.create()` are the only way to instantiate. Constructors are `private`.
- **Shadow DOM**: Every element uses `attachShadow({ mode: "open" })`. Styles are injected programmatically via `styleEl.sheet.insertRule()`, not in HTML templates.
- **Virtual columns are temporary**: `<x-layout-vcolumn>` is created during `layoutText()` for measurement and removed immediately after. Never persist these.
- **Canvas `measureText()` for char width**: `_charWidthPx()` uses Canvas `measureText().width` (advance width) clamped to `maxWidthPx = widthRatio * fontSizePx` for layout calculations. `genCharStyle()` uses both `maxWidth: ${widthRatio}em` (layout box) and `scale: ${widthRatio} 1` (glyph shape) to implement 장평.
- **Infinite loop guard**: `_layoutTextIntoColumns()` force-places characters wider than any available part width into the first part, preventing infinite loops.
- **Cursor position in whitespace**: `getNearestOffsetFromPoint()` detects trailing whitespace (past row's rightmost span) and leading whitespace (before row's leftmost span) clicks to place cursor after last char or before first char respectively, bypassing midpoint logic.
- **ImageData coordinates are pixels, not mm**: `x`, `y`, `width`, `height` in `ImageData` refer to source image pixels. `dpi` converts them to mm.
- **`getFontFamily()` is hardcoded**: Currently returns `'Myoungjo'` regardless of input. Font family mapping is not implemented.
- **No tests exist**: There is no test infrastructure. No `vitest`, no `jest`, no test files.
- **ColorRegistry without stylesheet**: `ColorRegistry.init()` sets `_ready = true` even when no stylesheet is available (SSR, test environments). Color data is accessible via `colorMap` but CSS variables are not injected.
- **Guide column printPostData**: `LayoutGuideColumnElement` has a `printPostData` getter that returns position/size data for print post-processing, matching the pattern of other layout elements.
- **EditManager singleton**: `EditManager.getInstance()` manages focus across all editable paragraphs. Only one paragraph can be focused at a time. `EditController` auto-registers on construction and auto-unregisters on `destroy()`.
- **Key-based span rendering**: `column.element.ts` `renderText()` uses `data-source-offset` as the reconciliation key for span diff rendering. Existing spans are reused when content unchanged; only changed spans are updated. `data-offset` (rendered offset) is retained for `EditCoordinateMapper` compatibility.
- **`data-source-offset` vs `data-offset`**: `data-source-offset` = source string position (used as diff key). `data-offset` = rendered position (used by EditCoordinateMapper for click-to-cursor mapping). Both attributes coexist on every span.
- **Optimistic spans are temporary**: `data-temporary="true"` spans are stripped at the start of every `renderText()` call and recreated by `EditController` as needed.
- **EditContextAdapter**: `src/edit/edit-context-adapter.ts` bridges the browser EditContext API (Chrome 121+) with the layout engine. `EditContextAdapter.create()` returns `null` if the API is not supported.

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
    edit-context-adapter.ts  # Browser EditContext API adapter
    edit-controller.ts       # EditController (cursor, selection, IME composition)
    edit-coordinate-mapper.ts # EditCoordinateMapper (click-to-offset mapping)
    edit-manager.ts          # EditManager singleton (global edit state)
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
  globals.d.ts               # JSX intrinsic elements for React interop
  index.ts                   # Entry point: exports components, core, resource, types, constants, examples
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
- **Print mode**: Detected via `window.matchMedia("print")`. In print mode, both managers skip `fetch()` and expect data injection. The document element's `connectedCallback` returns early — you must call `.layout()` and `.render()` manually after data injection. Images and guide columns are hidden via `@media print` CSS rules (`visibility: hidden` / `display: none`); their rendered positions and sizes are instead collected via `printPostData` getters for post-processing outside the browser.
- **TypeScript 7 RC**: `typescript: ^7.0.1-rc` is configured. The `noEmit: true` setting means `tsc` is type-check only; actual compilation is handled by Vite.
- **`noUnusedLocals` and `noUnusedParameters`** are enabled in tsconfig — dead imports or unused params will cause build errors.
- **Cursor width is 1px**: The `<x-edit-cursor>` element has a fixed width of 1px and does not blink.
- **Korean IME composition**: EditController handles IME composition via `compositionstart`, `compositionupdate`, and `compositionend` events. This is essential for Korean text input on Windows (TSF), macOS, and Linux (IBus).
- **Mouse coordinate freshness**: `_onMouseMove` stores the latest `clientX`/`clientY` on every mousemove event and reads them from the `requestAnimationFrame` callback, ensuring drag selection follows the cursor accurately during fast movement.
- **EditManager events**: Use `EditManager.getInstance().addEventListener(type, listener)` to subscribe to edit events. Types: `focusChange`, `textChange`, `styleChange`, `selectionStart`, `selectionEnd`, `cursorMove`. The old `selectionChange` event was removed.
- **Programmatic focus**: Use `EditManager.getInstance().focusParagraph(target, options?)` and `blurParagraph(target?)` instead of calling `paragraph.editable` or `controller.focus()` directly.

Keyboard shortcut documentation has been moved to `docs/EDITING.md` Section 4.