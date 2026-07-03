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
