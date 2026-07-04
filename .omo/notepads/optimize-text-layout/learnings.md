# Text Layout Engine Optimization Learnings

## Font String Cache (`_getCanvasFont`)

- **Single-entry cache works well**: Font strings only change when `textBlockStyle` changes (which is rare within a render cycle). Most characters use the same font, so hit rate is ~99%+.
- **Key format**: `${fontWeight}|${fontSizePx}|${fontFamily}` — pipe-separated to avoid collisions. Using `fontSizePx` (computed) rather than `fontSize` (input mm) ensures the cache respects ppm differences.
- **No reset needed**: The cache self-invalidates because all dependent variables are included in the key. If any input changes, the key changes and it's a miss.
- **Memory**: ~60 bytes for two strings. No accumulation concern.

## Overlay Rect Cache (`_applyOverlap`)

- **Lazy-init pattern**: `_overlayRects` starts as `null`, becomes a `Map` on first `_applyOverlap` call per `_layoutTextIntoColumns` cycle. Reset to `null` at the top of `_layoutTextIntoColumns`.
- **Early skip is the real win**: Caching rects alone wouldn't help because `getOverlapSizePX` calls `getBoundingClientRect` internally. The key optimization is the early vertical bounds check using cached overlay rects — this skips `getOverlapSizePX` entirely for lines that don't vertically overlap any overlay element (the common case).
- **Must still call `getOverlapSizePX` for overlapping lines**: Image pixel-level transparency detection requires canvas sampling.
- **Memory**: 1-3 overlay elements × ~96 bytes per DOMRect. Cleared every render cycle. No accumulation.

## General

- TypeScript 7 RC `noUnusedLocals`/`noUnusedParameters` enforced — all new variables are used.
- Build format: IIFE via Vite. `npm run build` is the verification command.

## Bug Fixes (text-layout-engine.ts)

### Bug A — Infinite loop when a character exceeds every part width

- **Root cause**: In `_layoutTextIntoColumns`, when `currentPartIdx >= partWidths.length` the engine decremented the content index and retried on a new line. If the character was wider than any part in every possible line, it looped forever.
- **Fix**: After failing to place a character, compute `maxPartWidth`. If `charWidth > maxPartWidth`, force-place the character in the first part of the current line and `break` out of the retry loop. The character is never skipped, just overflows visually.

### Bug B — `_charWidthPx` underestimated narrow characters and spaces

- **Root cause**: `rawWidth` used `metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight`, which measures ink bounds, not advance width. For narrow Latin glyphs and spaces the advance width is larger, so wrapping placed too many characters per line.
- **Fix**: Use `metrics.width` as the raw width measurement. `metrics.width` is the browser’s actual advance width for the current font string.

### Bug C — Double-scaling when `widthRatio ≠ 1`

- **Root cause**: `_updateCharStyleCache` applied both `maxWidth: ${wr}em` and `scale: ${wr} 1`. The `maxWidth` already constrained the layout box to `wr × fontSize`, then `scale` visually scaled it again, producing `wr² × fontSize`. Separately, `_charWidthPx` clamped measured width to `wr × fontSizePx`, which when combined with the CSS scale also produced double-scaled values.
- **Fix**:
  - `_updateCharStyleCache`: set `maxWidth: '1em'` for half-width, full-width, and space styles. `scale: ${wr} 1` remains the single visual width mechanism.
  - `_charWidthPx`: multiply the advance width by `widthRatio` so the wrapping calculation matches the visual scaled width, and remove the `maxWidthPx` clamp (CSS `maxWidth: 1em` now enforces the upper bound).
