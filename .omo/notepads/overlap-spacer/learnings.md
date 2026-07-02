# overlap-spacer learnings

## Implementation summary

- Added `SpacerData` type and `spacers: SpacerData[]` field to `TextLineData` in `src/types/layout/text/text-line.type.ts`.
- Added `BoxModel` import in `src/model/layout/paragraph.model.ts` to convert px spacer widths to mm via `BoxModel.ppm`.
- Implemented spacer insertion in `ParagraphModel.preTextWrap()`:
  - For each character appended to a measurement line, check its x-range against the line's `overlapParts` (px, relative to the line's left edge).
  - On overlap, remove the character from the line, insert an inline-block spacer span with width `(part.x2 - charStartX) / BoxModel.ppm` mm, and re-append the character after the spacer.
  - Record the spacer in `lineData.spacers` with `beforeIndex` set to the content length before the character was added.
  - Use a while loop with a max iteration of `overlapParts.length + 1` to handle multiple overlapping regions in sequence.
  - If the spacer causes the line to overflow (`charRect.x === firstCharRect.x` or line width smaller than char width), remove the spacers inserted for this character, remove the character, create a new line, re-apply overlap, and retry the character on the new line.
- Updated `LayoutColumnElement.renderText()` in `src/components/column.element.ts`:
  - Adjust each spacer's `beforeIndex` by subtracting the number of leading trimmed spaces.
  - Filter out spacers with out-of-bounds adjusted indices.
  - Iterate through content positions `0..content.length`, inserting spacer spans before the character at the matching index, and also handle spacers with `beforeIndex === content.length` at the end.
  - Spacer elements are `<span>` with `display: inline-block; width: {width}mm`.

## Bug fix iteration

- Fixed contradictory DOM manipulation in spacer insertion: now remove `charEl`, append spacer, then append `charEl` after the spacer so the character sits immediately after the spacer instead of being moved to the end of the line.
- Tracked spacer DOM elements in a local `charSpacers` array per character, so overflow cleanup removes exactly the spacers created for the current character from both the DOM and `lineData.spacers`.
- On overflow move to a new line, the character is re-appended to the new line and the overlap-spacer while loop runs again against the new line's `overlapParts`. No duplicate `idxContentOfBlock--` after a successful move.
- Punctuation branch now also cleans up any spacers created for the punctuation character before dropping it.

## Build verification

- `npx vite build` passes with no new errors.

## Coordinate notes

- `overlapParts` values are pixels relative to the line element's left edge.
- `BoxModel.ppm` is a static getter returning pixels per mm.
- Spacer widths stored in `TextLineData.spacers` are in mm so the renderer can use them directly.
