# Learnings — Virtual Cursor & Editing

## T2: SelectionRange type
- `CursorPosition` is a plain `type` (not class) with single field `textOffset: number`
- `SelectionRange` is a `class` because it has methods (`fromOffsets`, `normalized()`)
- `fromOffsets` is a static factory: creates `SelectionRange` from bare offset numbers
- `normalized()` returns `{ start, end }` with `start.textOffset <= end.textOffset` regardless of anchor/focus order
- Import convention: relative `./cursor.type` within same `edit/` directory
- The project uses JSDoc comments in Korean for domain-specific concepts

## T6: EditCoordinateMapper
- Coordinate mapping must distinguish **rendered offset** (`data-offset`) from **source offset** (`\n`-aware source string position)
- Offset map should be rebuilt from `columnContents` (not DOM) to account for stripped leading/trailing spaces and `\n` blocks
- `rebuild()` is the only method that mutates internal caches; it must be called after `paragraph.render()` re-creates columns
- All coordinate methods return **paragraph-local** coordinates by subtracting `paragraph.getBoundingClientRect()`
- Shadow DOM traversal uses `column.shadowRoot.querySelector('[data-offset="..."]')`
- `_getAllColumns()` uses `paragraph.querySelectorAll('x-layout-column')` because columns are light-DOM children
- Binary search on columns by horizontal range, then on spans by vertical position, keeps hit testing efficient
- Same-line contiguous spans are merged into one rectangle by comparing `top` and `left + width`
- Span innerText is the source of truth for `getTextContent()`; gaps in source offsets indicate `\n`

## T9: EditController skeleton
- `EditController` is owned by `LayoutParagraphElement` and created/destroyed by the `editable` setter
- The controller lives in the paragraph's shadow root: hidden `<textarea>`, `<x-layout-cursor>`, `<x-layout-selection>`
- Hidden textarea must stay in the **paragraph shadow root** (not column shadow root) so it survives column re-renders
- `EditCoordinateMapper` is created in the constructor and `rebuild()` is called in `postRender()` after columns are recreated
- Cursor model is a private inner type: `{ offset: number; selection: SelectionRange | null }`
- Click handling uses `event.composedPath()` because Shadow DOM retargets the target; find the span with `data-offset`, then convert via `mapper.sourceOffset()`
- Textarea is positioned at the cursor location (`top`/`left`) and styled `opacity: 0; width: 1px; height: 1px;` so mobile keyboards appear near the text
- All listeners are bound once and stored so `destroy()` can remove them and clean up DOM

## T10: Split TextLayoutEngine.preTextWrap() into structure + text phases

- Refactored `src/core/text-layout-engine.ts` so `preTextWrap()` is a backward-compatible wrapper:
  - `layoutStructure()` computes `_contents`, column widths/gaps/lineHeight, and caches `_columnPpm` by measuring virtual columns once.
  - `layoutText()` reuses cached structure and only runs the character-by-character wrapping loop to produce `_columnContents`/`_overflow`.
- `src/components/layout/paragraph.element.ts` now tracks a `_structureDirty` flag:
  - `layout()`, `set data()`, and `set inheritStyle()` set `_structureDirty = true`, so the next `render()` runs `preTextWrap()` (structure + text).
  - Subsequent `render()` calls (e.g. from `EditController._debouncedRender()` / `_onCompositionEnd()`) run only `layoutText()` until structure changes again.
- Key benefit for editing: text-only changes skip repeated DOM measurement of column widths and ppm, reducing re-layout cost per keystroke.
- Hazards avoided:
  - `layoutText()` still creates fresh virtual columns because `_createLineWithParts()` needs real DOM for overlap/overflow measurement, but it reuses cached `_columnPpm` and pre-parsed `_contents`.
  - Public API unchanged: `preTextWrap()` still works for external callers and consumers of `columnContents`.

## Hotfix: textarea.value not synced with model.inputContent

**Bug**: Typing in edit mode didn't reflect text in real-time — text only appeared after blur.

**Root cause**: `EditController` constructor created the hidden `<textarea>` with an empty string value (`""`). The `_onInput` handler computes `before = model.inputContent` (full text) and `after = textarea.value` (just what user typed, e.g. `"X"`). `_computeTextChange` then sees the entire content replaced by a few characters, destroying the model content.

**Fix**: Two locations in `src/edit/edit-controller.ts`:
1. **Constructor** (after line 108): `this._textarea.value = model.inputContent` — initialize textarea value from model content
2. **`postRender()`** (after `this._mapper.rebuild()`): `this._textarea.value = model.inputContent` — re-sync after re-render since `paragraph.render()` recreates columns from model

**Why postRender too**: After a debounced re-render, `paragraph.render()` recreates all columns from `model.inputContent`. If `_onInput` modified the model but the textarea somehow got out of sync (e.g., during composition), `postRender` ensures they stay aligned.
