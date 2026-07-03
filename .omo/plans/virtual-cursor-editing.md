# Virtual Cursor WYSIWYG Editing (Strategy B) — v4 (Post-2nd Review)

## TL;DR (For humans)

Implement inline text editing for `x-layout-paragraph` using transparent overlay + virtual cursor (Strategy B). The editing layer is built ON TOP of the existing rendering pipeline — `preTextWrap()`, `genCharStyle()`, overlap detection, and column wrapping remain untouched. Work is decomposed into 15 small, independently testable units.

**Key principle**: Existing source files get minimal additions (data attributes, property toggle, render cleanup fix). All new editing logic lives in new files. Coordinate mapping is in a dedicated `EditCoordinateMapper` class (NOT on `TextLayoutEngine`) to preserve the model/DOM separation.

**Scope**: Only flat `string` content is supported for editing. `(string | TextBlockData)[]` structured content is display-only. Full editing features: cursor navigation (keyboard + mouse), text input (Korean IME), selection (shift+arrow, mouse drag, double/triple click, Ctrl+A), clipboard (Ctrl+C/V/X).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  x-layout-paragraph (Shadow DOM)                             │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Rendering Layer (EXISTING, UNCHANGED)                   │ │
│  │  x-layout-column → line div → part div → span            │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Edit Overlay Layer (NEW)                                │ │
│  │  ┌─────────────────────────────────────────────────────┐│ │
│  │  │  x-layout-cursor  (blinking caret)                  ││ │
│  │  ├─────────────────────────────────────────────────────┤│ │
│  │  │  x-layout-selection (highlight ranges)               ││ │
│  │  ├─────────────────────────────────────────────────────┤│ │
│  │  │  hidden <textarea> (IME input capture)              ││ │
│  │  └─────────────────────────────────────────────────────┘│ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  EditController (NEW, not a Custom Element)              │ │
│  │  - EditContext adapter (primary IME)                    │ │
│  │  - hidden textarea (fallback IME)                       │ │
│  │  - CursorModel (offset, selection)                      │ │
│  │  - Coordinates via EditCoordinateMapper                  │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  EditCoordinateMapper (NEW)                               │ │
│  │  - getCharRect(offset) → DOMRect (paragraph-local)       │ │
│  │  - getCharOffsetFromPoint(x, y) → CursorPosition          │ │
│  │  - getTextRange(start, end) → Rect[] (paragraph-local)    │ │
│  │  - getTextContent(start, end) → string                    │ │
│  │  - sourceOffset(span) → number (maps data-offset→source) │ │
│  │  - Holds reference to paragraph element                    │ │
│  │  - Traverses column shadow roots via querySelector        │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Input flow**: hidden textarea/EditContext → EditController → optimistic span update → (debounced) update model → `paragraph.render()` → EditCoordinateMapper re-positions cursor/selection

**Selection flow**: Shift+Arrow / mouse drag / double-click / triple-click / Ctrl+A → EditController updates `SelectionRange` → `x-layout-selection` renders highlight rectangles → `EditCoordinateMapper.getTextRange()` provides rect geometry (paragraph-local coordinates)

**Clipboard flow**: Ctrl+C/X → EditController gets selected text via `mapper.getTextContent()` → writes to clipboard → Ctrl+V → EditController inserts text

**Re-render lifecycle**: `paragraph.render()` clears old columns and recreates them. After re-render, `EditController.postRender()` calls `EditCoordinateMapper.rebuild()` and re-positions overlay elements.

---

## Critical Design Decisions

### D1: `data-offset` maps to SOURCE text position (not rendered position)

`preTextWrap()` processes the source text: it splits on `\n` (line 280), strips leading/trailing spaces from parts (column.element.ts lines 75-78), and wraps characters. The `data-offset` attribute on each span must map back to the **original `inputContent` string index**, NOT the rendered position.

This means:
- `\n` characters in `inputContent` do NOT get rendered as spans. They split the text into blocks.
- Stripped spaces do NOT get rendered as spans. They are removed from `content` before span creation.
- `data-offset` must be computed by walking `columnContents` and maintaining a running counter that accounts for these gaps.

**Implementation**: `column.element.ts` receives `this.model.columnContents[this._index]` (its own column's lines). To compute global offset, it must sum character counts of ALL preceding columns AND account for `\n` characters that were consumed during `preTextWrap()`. The mapper's `sourceOffset(span)` method converts `data-offset` back to the source string index.

### D2: All coordinate methods return paragraph-local coordinates

`getBoundingClientRect()` returns viewport coordinates. Since `x-layout-selection` and `x-layout-cursor` are positioned `absolute` within the paragraph's shadow root (or as children of the paragraph), all coordinates must be converted to paragraph-local by subtracting `paragraph.getBoundingClientRect()`.

This applies to: `getCharRect()`, `getTextRange()`, cursor positioning, and selection positioning.

### D3: `paragraph.render()` must clear old columns before creating new ones

The existing `paragraph.render()` (lines 137-143) appends columns without removing previous ones. This causes column accumulation on every re-render. T12 adds a `postRender()` hook, but the column cleanup must happen BEFORE new columns are created.

**Fix**: Add `while (this.firstChild) this.removeChild(this.firstChild)` at the start of `render()` (before line 137). This is a BUG FIX in existing code, not just an edit feature. It affects all re-render scenarios, not just editing.

### D4: Newline (`\n`) offset handling

When Enter is pressed, `\n` is inserted into `inputContent`. `preTextWrap()` splits on `\n` to create new blocks (line 280). The `data-offset` on spans must skip positions where `\n` characters exist in the source string. The mapper must handle this by maintaining a mapping between source offsets and rendered offsets.

**V1 approach**: `EditCoordinateMapper.sourceOffset(span)` reads `span.dataset.offset` and adjusts for `\n` characters that were consumed during `preTextWrap()`. This mapping is rebuilt on every `rebuild()` call by walking `columnContents` and tracking the offset delta.

### D5: Composition clears selection

When `compositionstart` fires (Korean IME), any active `SelectionRange` is cleared and the cursor is set to the composition start position. This matches standard browser behavior.

### D6: Paste replaces selection (no optimistic DOM update for replacement)

When pasting text with an active selection: (1) compute `before = inputContent.slice(0, start)` and `after = inputContent.slice(end)`, (2) set `inputContent = before + pastedText + after`, (3) cursor at `start + pastedText.length`, (4) clear selection, (5) debounced re-render. The optimistic DOM update for "replace selection with pasted text" is too complex (removing spans across parts/lines/columns) — rely on the debounced full re-render instead.

---

## Todos

### Batch 1: Types

#### T1. Create CursorPosition type

- **File**: `src/types/edit/cursor.type.ts` (NEW)
- **What**: Define `CursorPosition` type with `textOffset: number` (offset in source text string, including `\n` characters)
- **Why**: All editing operations reference a character offset in the source text. Single source of truth — NOT DOM position, which is destroyed on every re-render.
- **Scope note**: V1 only supports flat `string` content. A future `blockIndex` field may be added for `(string | TextBlockData)[]` support.
- **References**: `TextPartData.content: string[]` (existing, source of truth for character ordering)
- **Accept**: TypeScript compiles, type is exported from `src/types/edit/index.ts`
- **QA**: `npx tsc --noEmit` passes, type is importable from `@/types`
- **Commit**: `feat(edit): add CursorPosition type`

#### T2. Create SelectionRange type

- **File**: `src/types/edit/selection.type.ts` (NEW)
- **What**: Define `SelectionRange` type with `anchor: CursorPosition` and `focus: CursorPosition`. Add helper `static fromOffsets(anchor: number, focus: number): SelectionRange`. Add `normalized(): { start: CursorPosition, end: CursorPosition }` method that returns anchor/focus in document order (start ≤ end).
- **Why**: Text selection needs two cursor positions. The `normalized()` helper is essential for rendering highlights (always need start ≤ end) and for clipboard operations (need the text range in document order).
- **References**: `src/types/edit/cursor.type.ts` (T1)
- **Accept**: TypeScript compiles, exported from `src/types/edit/index.ts`
- **QA**: `npx tsc --noEmit` passes. `SelectionRange.fromOffsets(5, 2).normalized()` returns `{ start: { textOffset: 2 }, end: { textOffset: 5 } }`.
- **Commit**: `feat(edit): add SelectionRange type`

#### T3. Create barrel export

- **File**: `src/types/edit/index.ts` (NEW)
- **What**: Barrel export for `CursorPosition` and `SelectionRange`
- **References**: T1, T2
- **Accept**: `npx tsc --noEmit` passes
- **Commit**: `feat(edit): add edit types barrel export`

### Batch 2: DOM Foundation — Data Attributes, Edit Mode & Render Fix

#### T4. Add data-offset attribute to character spans in column.element.ts

- **File**: `src/components/column.element.ts` (MODIFY — add 1 data attribute + offset counter to span creation loop)
- **What**: In `renderText()`, add `data-offset` to each character `<span>`. The offset is a **rendered position counter** that starts at 0 for the first span in the first column and increments by 1 for each span. This counter does NOT include `\n` characters (which are not rendered) or stripped spaces (which are removed before rendering).
  
  Implementation detail: Before the line loop, compute `let renderedOffset = 0;` by counting `content[j].length` for all spans in preceding columns (from `this.model.columnContents`). Within the loop, set `charEl.dataset.offset = String(renderedOffset++)` for each span.

  **The `EditCoordinateMapper.sourceOffset()` method (T6) will convert `renderedOffset` to source string position** by accounting for `\n` characters and stripped spaces that are not rendered.

- **Why**: Reverse mapping from DOM element to rendered position. A single `data-offset` is more efficient than 3 attributes — reduces DOM overhead from ~60 bytes/span to ~20 bytes/span for 5000+ character documents. The offset is rendered position (not source position) because source position would require complex gap tracking at span creation time.
- **Must-NOT-Have**: No changes to existing style logic, no changes to line/part creation, no changes to `TextLayoutEngine`
- **References**: `column.element.ts` lines 90-97 (span creation loop), `TextLayoutEngine.columnContents` (for computing global rendered offset)
- **Accept**: Rendered spans have `data-offset` attributes; existing rendering unchanged
- **QA**: `querySelectorAll('[data-offset]')` returns all character spans; offsets are monotonically increasing across columns; first span in first column has offset 0
- **Commit**: `feat(edit): add data-offset attribute to character spans`

#### T5. Add editable property, edit mode toggle, and render cleanup to paragraph.element.ts

- **File**: `src/components/paragraph.element.ts` (MODIFY — add 1 property, 1 getter, 1 setter, 1 render fix)
- **What**: 
  1. Add `private _editable: boolean = false` property, `get editable()` getter, `set editable(value: boolean)` setter. When `editable` becomes `true`: create `EditController` instance (passing `this` reference). When `false`: call `EditController.destroy()` and null the reference.
  2. **BUG FIX**: Add `while (this.firstChild) this.removeChild(this.firstChild)` at the start of `render()` (before line 137). This prevents column accumulation on every re-render. This is a general bug fix that benefits all re-render scenarios, not just editing.
  3. After the column creation loop, add: `if (this._editController) this._editController.postRender();`

- **Why**: Editable toggle is the entry point for editing. The render cleanup is a pre-existing bug that would cause duplicate columns on every `render()` call.
- **Must-NOT-Have**: No changes to `layout()`, `overlayElements` getter, or `data` setter
- **References**: `paragraph.element.ts` render method (lines 123-143)
- **Accept**: `paragraph.editable = true` creates EditController, `paragraph.editable = false` destroys it. `render()` called twice doesn't create duplicate columns.
- **QA**: Set `editable` to true then false — no edit overlay remnants, no errors. Call `render()` twice — column count stays correct, no duplicates.
- **Commit**: `feat(edit): add editable property, edit mode toggle, and render cleanup`

### Batch 3: Coordinate Mapping (depends on T4)

#### T6. Create EditCoordinateMapper class

- **File**: `src/edit/edit-coordinate-mapper.ts` (NEW)
- **What**: Class that maps between text offsets and pixel coordinates. Receives a `LayoutParagraphElement` reference at construction. Methods:
  - `getCharRect(offset: number): DOMRect | null` — finds the `<span data-offset="${offset}">` across column shadow roots, returns `getBoundingClientRect()` **converted to paragraph-local coordinates** by subtracting `paragraph.getBoundingClientRect()`. This is critical — the selection/cursor overlay elements are positioned within the paragraph, so all coordinates must be relative to the paragraph, not the viewport.
  - `getCharOffsetFromPoint(x: number, y: number): CursorPosition | null` — iterates all character spans (via column shadow roots), finds the span whose bounding rect contains the point (viewport coordinates), returns `{ textOffset: sourceOffset }` where `sourceOffset` is the **source string position** (not the rendered position). Uses binary search on columns for performance.
  - `getTextRange(startOffset: number, endOffset: number): { top: number, left: number, width: number, height: number }[]` — returns bounding rectangles for all spans from `startOffset` to `endOffset` (inclusive start, exclusive end) in **paragraph-local coordinates**. Groups contiguous spans on the same line into a single rectangle for efficient selection rendering. Handles **cross-column boundaries**: if a selection spans from column 1 to column 2, returns separate rectangles for each column's portion (the column gap is NOT included in any rectangle).
  - `getTextContent(startOffset: number, endOffset: number): string` — extracts the text content between two **source offsets** by reading `span.innerText` from each span in the range. Accounts for `\n` characters between blocks by inserting them at the appropriate positions.
  - **`sourceOffset(renderedOffset: number): number`** — converts a rendered offset (`data-offset` attribute value) to a source string position. This accounts for `\n` characters that were consumed during `preTextWrap()` and stripped spaces. Built by walking `columnContents` and tracking the delta between rendered and source positions.
  - **`renderedOffset(sourceOffset: number): number`** — converts a source string position to a rendered offset (reverse of `sourceOffset`). Used to find the correct `data-offset` span when the cursor is at a source position.
  - `rebuild(): void` — clears cached references AND rebuilds the `sourceOffset`/`renderedOffset` mapping. Called after `paragraph.render()` re-creates all column elements.
  - Private helper `getAllColumns(): LayoutColumnElement[]` — queries paragraph for column elements.
  - Private helper `getSpanByOffset(offset: number): HTMLSpanElement | null` — traverses column shadow roots.
  - Private field `_offsetMap: { sourceToRendered: Map<number, number>, renderedToSource: Map<number, number> }` — bidirectional offset mapping built in `rebuild()`.
  
- **Why**: `TextLayoutEngine` is a pure model class with no DOM references. The mapper must handle three critical coordinate conversions: (1) viewport ↔ paragraph-local for overlay positioning, (2) rendered offset ↔ source string position for the `\n` and space gap, (3) offset ↔ pixel for cursor/selection.
- **Shadow DOM note**: Column elements use `attachShadow({ mode: "open" })`, so `shadowRoot` is accessible. For click events on spans, `event.composedPath()` must be used since `event.target` is retargeted to `x-layout-column` by Shadow DOM.
- **Must-NOT-Have**: No modification to `TextLayoutEngine` (stays pure model)
- **References**: `CursorPosition` (T1), `column.element.ts` data-offset (T4), `TextLayoutEngine.columnContents` (for offset mapping), `TextLayoutEngine._contents` (for `\n` tracking)
- **Accept**: `getCharRect(0)` returns paragraph-local `DOMRect`. `getCharOffsetFromPoint(x, y)` returns source offset. `getTextRange(0, 5)` returns paragraph-local rects. `getTextContent(0, 5)` returns source text (including `\n` if present). `sourceOffset()`/`renderedOffset()` correctly map between source and rendered positions. `rebuild()` clears caches and rebuilds offset map.
- **QA**: After rendering "Hello\nWorld" (two lines): `mapper.sourceOffset(0)` returns 0 (first rendered char = first source char). `mapper.sourceOffset(5)` returns 6 (5th rendered char = char after `\n`). `mapper.renderedOffset(6)` returns 5. `mapper.getTextContent(0, 11)` returns "Hello\nWorld". `mapper.getCharRect(0)` returns coordinates relative to paragraph origin (not viewport).
- **Commit**: `feat(edit): add EditCoordinateMapper for offset↔pixel coordinate mapping`

### Batch 4: Cursor & Selection — Visual Components

#### T7. Create x-layout-cursor custom element

- **File**: `src/components/cursor.element.ts` (NEW)
- **What**: Custom element `<x-layout-cursor>` that renders a blinking vertical line at a given position. Properties: `top: number`, `left: number`, `height: number`, `visible: boolean`. Uses CSS `@keyframes` for blink animation (530ms cycle). Positioned `position: absolute` with `pointer-events: none`. **All coordinates are paragraph-local** (see D2).
- **Why**: Visual cursor indicator for caret position
- **Must-NOT-Have**: No imports from edit code (standalone component)
- **References**: Existing custom elements pattern (`v-column.element.ts` for structure reference)
- **Accept**: Element renders blinking cursor at specified coordinates, `visible` toggle hides/shows, `define` call registers custom element
- **QA**: Cursor appears at (10, 20) with height 16px, blinks at ~530ms intervals, `visible=false` hides it
- **Commit**: `feat(edit): add x-layout-cursor custom element`

#### T8. Create x-layout-selection custom element

- **File**: `src/components/selection.element.ts` (NEW)
- **What**: Custom element `<x-layout-selection>` that renders semi-transparent highlight rectangles. Method: `setRanges(ranges: {top: number, left: number, width: number, height: number}[])` — creates/updates highlight divs. Uses `background-color: rgba(0, 100, 200, 0.3)` by default. Positioned `position: absolute` with `pointer-events: none`. **All coordinates are paragraph-local** (see D2).
- **Why**: Visual selection indicator for text ranges
- **Must-NOT-Have**: No imports from existing edit code
- **References**: `cursor.element.ts` (T7) for pattern reference
- **Accept**: Element renders selection highlights at specified ranges, `setRanges([])` removes all highlights
- **QA**: Selection renders over 3 ranges, `setRanges([])` clears all, re-render with 2 ranges shows 2
- **Commit**: `feat(edit): add x-layout-selection custom element`

### Batch 5: Edit Controller — Skeleton & Cursor Model

#### T9. Create EditController skeleton with CursorModel and hidden textarea

- **File**: `src/edit/edit-controller.ts` (NEW)
- **What**: Class skeleton that manages the editing lifecycle:
  1. **Constructor**: receives `LayoutParagraphElement` reference. Creates `EditCoordinateMapper`. Creates hidden `<textarea>` in paragraph's shadow root for keyboard/IME input capture. Creates `x-layout-cursor` and `x-layout-selection` elements in paragraph's shadow root.
  2. **CursorModel**: internal state `{ offset: number, selection: SelectionRange | null }` with getters.
  3. **`destroy()`**: removes textarea, cursor element, selection element from shadow root. Removes all event listeners.
  4. **Hidden textarea**: positioned `position: absolute; opacity: 0; width: 1px; height: 1px;` near the cursor position (updated on cursor move). Receives keyboard focus when edit mode is active.
  5. **Focus management**: `focus()` / `blur()` methods on the textarea. Click on paragraph → focus textarea.
  6. **Click handler on paragraph**: uses `event.composedPath()` to find the clicked span's `data-offset`, then converts to source offset via `mapper.sourceOffset()`, updates cursor model, and positions cursor element.
  
- **Why**: Central coordinator for all edit state. The textarea must be in the paragraph's shadow root (not in a column's shadow root) so it survives column re-renders.
- **Must-NOT-Have**: No text input handling yet (that's T10). No keyboard navigation yet (that's T11). No selection yet (that's T14). No clipboard yet (that's T15). No EditContext yet (that's T13).
- **References**: `EditCoordinateMapper` (T6), `CursorPosition` (T1), `SelectionRange` (T2), `x-layout-cursor` (T7), `x-layout-selection` (T8)
- **Accept**: `new EditController(paragraphEl)` creates textarea, cursor, selection elements in paragraph shadow root. `destroy()` removes them all. Click on character span moves cursor visually.
- **QA**: After `paragraph.editable = true`, clicking on "H" in "Hello" shows cursor at that position. `paragraph.editable = false` removes all edit overlay elements.
- **Commit**: `feat(edit): add EditController skeleton with cursor model and hidden textarea`

### Batch 6: Edit Controller — Input & Re-render Lifecycle

#### T10. Add optimistic update + debounced re-render to EditController

- **File**: `src/edit/edit-controller.ts` (MODIFY)
- **What**: Implements the two-phase update pattern for text editing:
  
  **Phase 1 — Optimistic immediate update** (every keystroke):
  1. On `input` event from textarea: compute the inserted/deleted text
  2. Immediately update the source text: `this._paragraph.model.inputContent = newText`
  3. Find the affected character span via `mapper.renderedOffset(newSourceOffset)` then `mapper.getSpanByOffset()`
  4. Immediately update that span's `innerText` (optimistic DOM patch)
  5. Move cursor to new offset
  
  **Phase 2 — Debounced full re-render** (~150ms after last keystroke):
  1. Clear debounce timer
  2. Call `paragraph.render()` which clears old columns (T5 fix), re-runs `preTextWrap()`, and creates new columns
  3. `postRender()` is called automatically (T5 hook) → `mapper.rebuild()` + re-position cursor/selection
  4. Re-position cursor element via `mapper.getCharRect(mapper.renderedOffset(currentSourceOffset))`
  
  **During composition** (Korean IME `compositionstart` → `compositionend`):
  1. Set `this._isComposing = true`
  2. **Clear any active selection** (see D5) — set `this._cursorModel.selection = null`, update selection element
  3. Skip optimistic updates — let the textarea/IME handle the composing text
  4. On `compositionend`: apply the final composed text as a single atomic update
  5. Then trigger the debounced re-render

  **Source text update flow**: `this._paragraph.model.inputContent = newText` (setter exists on `TextLayoutEngine`, line 651) → then `this._paragraph.render()` for full re-render. The setter just stores the value; `preTextWrap()` inside `render()` processes it.

- **Why**: `paragraph.render()` is destructive — it recreates all column elements. Full re-render on every keystroke makes Korean IME unusable. The optimistic patch gives immediate visual feedback, while the debounced re-render handles column reflow.
- **Must-NOT-Have**: No modification to `TextLayoutEngine` or existing rendering pipeline
- **References**: `EditController` (T9), `EditCoordinateMapper` (T6), `paragraph.render()` (existing, with T5 cleanup fix), `TextLayoutEngine.inputContent` setter (existing, line 651)
- **Accept**: Typing a character shows immediate visual feedback (optimistic span update). After ~150ms of inactivity, columns reflow. During Korean IME composition, the composing text appears in the textarea and is applied atomically on `compositionend`. Active selection is cleared when composition starts.
- **QA**: Type "Hello" → characters appear immediately, cursor moves right. After typing stops, columns reflow if needed. Type Korean 가 → during composition the hangul jambo appears in textarea, on completion the final character replaces it. With selection active, start composing → selection clears.
- **Commit**: `feat(edit): add optimistic update and debounced re-render to EditController`

#### T11. Add keyboard navigation to EditController

- **File**: `src/edit/edit-controller.ts` (MODIFY)
- **What**: Handle arrow key navigation and basic editing keys:
  - **Arrow keys** (left/right): move cursor by 1 source offset. Up/down: move to same horizontal position in adjacent line (using `getCharOffsetFromPoint`). The source offset accounts for `\n` characters — pressing right at the end of a line moves past the `\n` to the start of the next line.
  - **Home/End**: move cursor to start/end of current line in the source string.
  - **Backspace/Delete**: delete character before/after cursor in source string, optimistic update + debounced re-render.
  - **Enter**: insert `\n` character in `inputContent` at cursor offset. This creates a new block in `preTextWrap()`. Optimistic update: debounced re-render only (no span patch for `\n` since it's not rendered).
  
  Implementation: `keydown` event handler on textarea. Prevent default for handled keys. Update `CursorModel.offset` and re-position cursor element via `mapper.getCharRect(mapper.renderedOffset(newSourceOffset))`.

- **Why**: Arrow keys are essential for cursor navigation within the text.
- **Newline handling** (see D4): `\n` in `inputContent` splits into new blocks during `preTextWrap()`. The `data-offset` on spans skips `\n` positions. When cursor is at a `\n` position, it should appear at the end of the previous line (visually) and pressing Right moves it to the start of the next line.
- **References**: `EditCoordinateMapper` (T6), `CursorModel` (T9)
- **Accept**: Left/right arrow keys move cursor. Backspace deletes character before cursor. Home/End move to line boundaries. Enter creates a new line.
- **QA**: Type "Hello", press left arrow 3 times → cursor at offset 2. Press Home → cursor at offset 0. Press End → cursor at offset 5. Press Enter → "Hello\n" with cursor at offset 6 (start of new line).
- **Commit**: `feat(edit): add keyboard navigation to EditController`

#### T12. Add re-render lifecycle management to EditController

- **File**: `src/edit/edit-controller.ts` (MODIFY)
- **What**: Handle the lifecycle of edit overlay elements across paragraph re-renders:
  1. **`postRender()` method** called by `paragraph.render()` (T5 hook) after column recreation:
     - Calls `this._mapper.rebuild()` (clears cached column references, rebuilds offset map)
     - Re-positions cursor via `this._mapper.getCharRect(this._mapper.renderedOffset(this._cursorModel.offset))`
     - Re-positions selection if active via `this._mapper.getTextRange(startRendered, endRendered)` → `this._selectionElement.setRanges(rects)`
  2. **Textarea focus restoration**: After re-render, restore focus to the hidden textarea if it was focused before.
  3. **Source offset preservation**: `CursorModel.offset` stores **source offsets** (not rendered offsets). After `rebuild()`, the mapper has a fresh `renderedOffset(sourceOffset)` mapping, so cursor positioning always uses the current mapping.

- **Why**: `paragraph.render()` destroys all column elements (after T5 fix: clears then recreates). Without lifecycle management, cursor position references become stale after re-render.
- **Must-NOT-Have**: No changes to `preTextWrap()`, `TextLayoutEngine`, or rendering pipeline. The ONLY change to `paragraph.element.ts` was in T5 (cleanup + postRender hook).
- **References**: `EditController` (T9), `EditCoordinateMapper.rebuild()` (T6), `paragraph.render()` (existing, with T5 fix)
- **Accept**: After re-render, cursor element is re-positioned at the correct source offset. Textarea regains focus. Selection is re-positioned if active.
- **QA**: Type "Hello World", observe cursor at source offset 11. Trigger re-render (e.g., window resize) → cursor still at offset 11, textarea still focused.
- **Commit**: `feat(edit): add re-render lifecycle management to EditController`

### Batch 7: EditContext Adapter

#### T13. Create EditContext adapter

- **File**: `src/edit/edit-context-adapter.ts` (NEW)
- **What**: Adapter that uses the EditContext API when available (Chromium 122+). Provides:
  - `static isSupported(): boolean` — checks `typeof EditContext !== 'undefined'`
  - Constructor takes `EditCoordinateMapper` reference and callbacks (`onTextUpdate`, `onCompositionStart`, `onCompositionEnd`, `onSelectionChange`)
  - Creates `new EditContext()` when supported, attaches event listeners:
    - `textupdate` event → calls `onTextUpdate` callback
    - `characterboundsupdate` event → provides character rects from `mapper.getCharRect()` (**in paragraph-local coordinates** per D2)
    - `compositionstart/end` events → calls composition callbacks
  - `updateBounds()` method — calls `editContext.updateControlBounds()` with paragraph bounding rect, and `editContext.updateSelectionBounds()` with cursor rect
  - `destroy()` — removes event listeners, detaches EditContext
  - Falls back to returning `null` from `create()` factory method when EditContext is not available.

- **Why**: EditContext API provides native IME support without contentEditable, but only in Chromium 122+. Must have clean fallback path.
- **Interface contract with EditController**:
  - EditController calls `EditContextAdapter.create(mapper, callbacks)` at construction
  - If adapter is non-null, EditController delegates text input to adapter and uses `updateBounds()` after cursor moves
  - If adapter is null, EditController uses textarea event listeners directly
- **Must-NOT-Have**: No modification to existing files
- **References**: [EditContext API](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API), `EditCoordinateMapper.getCharRect()` (T6)
- **Accept**: On Chromium: `EditContextAdapter.isSupported()` returns `true`, adapter creates EditContext, receives text updates. On Firefox/Safari: `isSupported()` returns `false`, `create()` returns `null`, no crash.
- **QA**: On Chrome: typing triggers `textupdate` event. On Firefox: adapter returns `null`, EditController falls back to textarea mode gracefully.
- **Commit**: `feat(edit): add EditContext adapter for IME input`

### Batch 8: Selection — Mouse & Keyboard

#### T14. Add selection handling to EditController

- **File**: `src/edit/edit-controller.ts` (MODIFY)
- **What**: Add text selection support via keyboard and mouse:
  
  **Keyboard selection**:
  - **Shift+Arrow keys**: extend selection in the arrow direction. Update `CursorModel.selection` with `SelectionRange.fromOffsets(anchor, newFocus)`. Render selection via `x-layout-selection.setRanges(mapper.getTextRange(startRendered, endRendered))`.
  - **Shift+Home/End**: extend selection to line start/end.
  - **Ctrl+A** (or Cmd+A on Mac): select all text. Set selection from offset 0 to `inputContent.length`.
  - **Escape / click without Shift**: clear selection. Set `CursorModel.selection = null`, call `selectionElement.setRanges([])`.
  - **Typing during selection**: if `CursorModel.selection` is active and user types a character, replace the selected text with the typed character (delete selection range, insert character, move cursor). Clear selection.
  
  **Mouse selection**:
  - **Mouse drag (mousedown → mousemove → mouseup)**: on `mousedown`, record anchor offset (source offset via `mapper.sourceOffset()`). On `mousemove`, compute focus offset via `mapper.getCharOffsetFromPoint(event.clientX, event.clientY)` and update selection. On `mouseup`, finalize selection.
  - **Double-click**: select word at click position. Find word boundaries by scanning source text for whitespace transitions. Korean word boundaries are space-delimited for V1 (see limitation note below).
  - **Triple-click**: select all text in the paragraph (equivalent to Ctrl+A for V1, since newspaper columns don't have traditional "lines" that span the full width).
  
  **Selection rendering**:
  - Call `mapper.getTextRange(startRendered, endRendered)` to get paragraph-local rectangles for the selection highlight.
  - Pass rectangles to `x-layout-selection.setRanges(ranges)`.
  - On selection change, also move the cursor element to the focus position (visual anchor = caret position).
  - **Cross-column selection**: `getTextRange()` returns separate rectangles for each column's portion. The column gap is NOT included in any selection rectangle.
  
  **Cursor blink behavior during selection**:
  - When selection is active, hide the blinking cursor (set `cursor.visible = false`).
  - When selection is cleared, restore blinking cursor at offset.

  **V1 limitation**: Double-click word selection uses whitespace boundaries. Korean compound words without spaces are treated as a single "word". CJK word segmentation is a future enhancement. Mouse drag selection does not auto-scroll (paragraph content is expected to fit within its container per `overflow: hidden`).

- **Why**: Selection is fundamental to text editing. Without it, copy/cut operations have no source, and users cannot select text to delete or replace it.
- **References**: `SelectionRange` (T2), `EditCoordinateMapper.getTextRange()` (T6), `x-layout-selection` (T8), `CursorModel` (T9)
- **Accept**: Shift+Arrow selects text with visual highlight. Ctrl+A selects all. Mouse drag selects range. Double-click selects word. Selection clears on Escape or click. Typing during selection replaces selected text.
- **QA**: Type "Hello World", Shift+Right Arrow 3 times → "Hel" highlighted. Ctrl+A → all text highlighted. Double-click on "World" → "World" highlighted. Click elsewhere → selection cleared. With "Hello" selected, type "Hi" → "Hello" replaced with "Hi".
- **Commit**: `feat(edit): add keyboard and mouse selection handling`

### Batch 9: Clipboard

#### T15. Add clipboard operations to EditController

- **File**: `src/edit/edit-controller.ts` (MODIFY)
- **What**: Add copy, cut, and paste support:
  
  **Copy (Ctrl+C / Cmd+C)**:
  1. Get `SelectionRange` from `CursorModel`. If no selection, no-op (copy nothing for V1).
  2. Get normalized range via `selection.normalized()`.
  3. Call `mapper.getTextContent(start, end)` to extract selected text.
  4. Write to clipboard. **Primary mechanism**: `navigator.clipboard.writeText(text)`. **Fallback**: set `textarea.value = text`, select all in textarea, `document.execCommand('copy')`, clear textarea.
  5. Do NOT modify the text or clear the selection.
  
  **Cut (Ctrl+X / Cmd+X)**:
  1. Same as copy steps 1-4.
  2. Then delete selected text: `inputContent = before + after` where `before = inputContent.slice(0, start)` and `after = inputContent.slice(end)`.
  3. Set cursor offset to `start`, clear selection.
  4. Trigger debounced re-render.
  
  **Paste (Ctrl+V / Cmd+V)**:
  1. If selection is active, delete selected text first (same as cut step 2).
  2. Read pasted text. **Primary mechanism**: listen for `paste` event on textarea → `event.clipboardData.getData('text/plain')`. This is more reliable than `navigator.clipboard.readText()` which requires HTTPS and a user gesture context. The `paste` event fires automatically when Ctrl+V is pressed and the textarea has focus.
  3. Insert pasted text at cursor offset: `inputContent = before + pastedText + after`.
  4. Set cursor offset to `start + pastedText.length`, clear selection.
  5. **No optimistic DOM update for paste** (see D6) — rely on debounced full re-render.
  6. Trigger debounced re-render.
  
  **Paste replacing selection** (see D6):
  1. Get normalized selection range `{ start, end }`.
  2. `inputContent = inputContent.slice(0, start) + pastedText + inputContent.slice(end)`.
  3. Cursor at `start + pastedText.length`, clear selection.
  4. Debounced re-render.

- **Why**: Clipboard operations are essential for text editing. Copy/paste is one of the most frequently used features.
- **Clipboard API note**: `navigator.clipboard.writeText()` is used for copy (works in HTTPS contexts with user gesture). For paste, the `paste` event on the textarea is more reliable than `navigator.clipboard.readText()` because it works in all contexts and doesn't require HTTPS. `document.execCommand('copy')` is the fallback for non-HTTPS contexts.
- **References**: `CursorModel` (T9), `SelectionRange` (T2), `EditCoordinateMapper.getTextContent()` (T6), `EditController` optimistic update (T10)
- **Accept**: Ctrl+C copies selected text to clipboard. Ctrl+X cuts selected text to clipboard and removes it. Ctrl+V inserts clipboard text at cursor position, replacing selection if active. All three work with Korean text including multi-line paste.
- **QA**: Type "Hello World", select "World" (Shift+Arrow or mouse drag), Ctrl+C → clipboard contains "World". Click at offset 5, Ctrl+V → "Hello World" pasted. Select "World", Ctrl+X → clipboard contains "World", text becomes "Hello ". Type "Hello", Ctrl+A, Ctrl+V with "Bye" in clipboard → "Bye" (replaces all).
- **Commit**: `feat(edit): add copy, cut, and paste clipboard operations`

---

## Dependency Matrix

```
T1 ─┐
T2 ─┤─ T3
    │
T4 ─┼─ T6 ─────────────────┐
T5 ─┤                       │
    │                       │
T7 ─┤                       │
T8 ─┤                       │
    │                       │
T9 ─┤───────────────────────┘ (depends on T4, T5, T6, T7, T8)
    │
T10 ─┤ (depends on T9)
T11 ─┤ (depends on T9)
T12 ─┤ (depends on T9, T10)
    │
T13 ── (depends on T6, T9)
    │
T14 ── (depends on T9, T10, T12)  ← selection needs lifecycle management
    │
T15 ── (depends on T9, T10, T14)  ← clipboard needs selection + text update
```

**Parallelizable**:
- T1, T2, T3 can run together (types only)
- T4, T5 can run together (independent DOM changes)
- T7, T8 can run together (independent visual components)

**Sequential**:
- T6 depends on T4 (needs data-offset on spans)
- T9 depends on T4, T5, T6, T7, T8 (integrates everything)
- T10, T11, T12 depend on T9 (extend EditController)
- T13 depends on T6 (needs mapper) and T9 (needs callbacks contract)
- T14 depends on T9, T10, T12 (selection needs cursor model + lifecycle)
- T15 depends on T9, T10, T14 (clipboard needs selection + text update)

---

## Existing File Modifications Summary

| File | Changes | Lines Added (est.) |
|------|---------|---------------------|
| `src/components/column.element.ts` | +1 data attribute (`data-offset`) + offset counter in span loop | ~8 |
| `src/components/paragraph.element.ts` | +1 property, +1 getter, +1 setter, +EditController creation, +render cleanup (bug fix), +postRender hook | ~35 |
| **Total existing modifications** | | **~43** |

## New Files Summary

| File | Purpose | Lines (est.) |
|------|---------|--------------|
| `src/types/edit/cursor.type.ts` | CursorPosition type | ~10 |
| `src/types/edit/selection.type.ts` | SelectionRange type with helpers | ~20 |
| `src/types/edit/index.ts` | Barrel export | ~3 |
| `src/components/cursor.element.ts` | Blinking caret element | ~60 |
| `src/components/selection.element.ts` | Highlight ranges element | ~50 |
| `src/edit/edit-coordinate-mapper.ts` | Offset↔pixel mapping, text range, text extraction, source↔rendered offset conversion | ~160 |
| `src/edit/edit-controller.ts` | Central edit coordinator (skeleton + input + lifecycle + selection + clipboard) | ~550 |
| `src/edit/edit-context-adapter.ts` | EditContext API adapter | ~120 |
| `src/edit/index.ts` | Barrel export | ~3 |
| **Total new code** | | **~976** |

---

## Key Design Decisions

1. **Text offset as cursor model** (not DOM position) — survives re-wraps, maps to/from `columnContents` via `data-offset`
2. **EditCoordinateMapper** (not TextLayoutEngine methods) — preserves model/DOM separation. TextLayoutEngine stays pure model. Mapper holds paragraph reference and traverses Shadow DOM.
3. **Single `data-offset` attribute** — instead of 3 attributes. Reduces DOM overhead from ~60 bytes/span to ~20 bytes/span.
4. **`data-offset` is rendered position** — not source position. The mapper converts between rendered and source offsets via `_offsetMap`. This accounts for `\n` characters and stripped spaces (see D1, D4).
5. **Paragraph-local coordinates** — all overlay elements use coordinates relative to the paragraph element, not the viewport. `getCharRect()` and `getTextRange()` subtract `paragraph.getBoundingClientRect()` from `getBoundingClientRect()` results (see D2).
6. **EditContext API primary** + hidden textarea fallback — best Korean IME support
7. **Single atomic unit during composition** — never split spans during `compositionstart`→`compositionend`. Composition clears active selection (see D5).
8. **Optimistic single-char update + debounced re-wrap** — immediate visual feedback via span `innerText` patch, deferred column adjustment via `paragraph.render()` after ~150ms debounce
9. **No modifications to `preTextWrap()`** — the core rendering pipeline stays intact
10. **Shadow DOM traversal via `composedPath()`** — click events on spans inside column shadow roots are retargeted
11. **Textarea in paragraph shadow root** — survives column re-renders since `paragraph.render()` only replaces child elements (columns), not the shadow root content itself
12. **V1 scope: flat `string` content only** — `CursorPosition.textOffset` is a single number. `(string | TextBlockData)[]` structured content is display-only for now.
13. **Selection rendering via `getTextRange()`** — returns paragraph-local `Rect[]`, handles cross-column boundaries with gaps excluded
14. **Clipboard: `paste` event as primary paste mechanism** — more reliable than `navigator.clipboard.readText()` (requires HTTPS). Copy uses `navigator.clipboard.writeText()` with `execCommand('copy')` fallback
15. **Paste replaces selection via source text manipulation** — no optimistic DOM update for replacement; rely on debounced full re-render (see D6)
16. **Render cleanup bug fix** — `paragraph.render()` now clears old columns before creating new ones (see D3)

---

## Review Issues Resolved

| Issue | Resolution |
|-------|-----------|
| C1: `getCharRect`/`getCharOffsetFromPoint` on TextLayoutEngine violates model/DOM separation | ✅ Moved to `EditCoordinateMapper`. TextLayoutEngine unchanged. |
| C2: T9 too large | ✅ Split into T9-T12. |
| C3: Optimistic update + debounced re-wrap missing | ✅ T10 explicitly implements the two-phase pattern. |
| C4: Shadow DOM click handling | ✅ T9 documents `event.composedPath()`. T6 documents `shadowRoot.querySelector()`. |
| C5: Coordinate system for cross-column selection | ✅ **D2**: All coordinates converted to paragraph-local. `getCharRect()` and `getTextRange()` return paragraph-local rects. |
| C6: `data-offset` computation misalignment | ✅ **D1, D4**: `data-offset` stores rendered position. `EditCoordinateMapper.sourceOffset()`/`renderedOffset()` convert between source and rendered positions. |
| C7: `paragraph.render()` doesn't clear old columns | ✅ **D3**: T5 adds `while (this.firstChild) this.removeChild(this.firstChild)` at start of `render()`. Bug fix. |
| C8: Newline offset handling | ✅ **D4**: `sourceOffset()`/`renderedOffset()` mapping handles `\n` gap. T11 documents Enter key behavior. |
| W1: `TextBlockData` boundaries | ✅ V1 scope: flat `string` content only. |
| W2: Data attributes performance | ✅ Single `data-offset`. |
| W3: EditContext interface contract | ✅ T13 documents the contract. |
| W4: Dependency ordering | ✅ T4 before T6. Matrix updated. |
| W5: Re-render lifecycle | ✅ T12 handles postRender. |
| W6: Composition clears selection | ✅ **D5**: T10 documents clearing selection on `compositionstart`. |
| W7: No auto-scroll in drag selection | ✅ T14 documents V1 limitation. |
| W8: Clipboard API fallback | ✅ T15: `paste` event primary, `navigator.clipboard.writeText()` for copy, `execCommand` fallback. |
| W9: Paste-replace-selection detail | ✅ **D6**: No optimistic DOM update for paste-replace-selection. Rely on debounced re-render. |
| W10: Word boundaries across parts | ✅ T14: scans source text (not DOM) for whitespace boundaries. Korean CJK limitation documented. |