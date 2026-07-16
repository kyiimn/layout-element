import type { TextEditCoordinateMapper } from "./text-edit-coordinate-mapper";

/**
 * Adapter that bridges the browser EditContext API with the layout engine.
 *
 * Uses EditContext (Chromium 122+) when available for native IME support.
 * Falls back gracefully — `create()` returns `null` on unsupported browsers,
 * allowing TextEditController to use its textarea-based fallback path.
 */
export class TextEditContextAdapter {
  private _editContext: BrowserEditContext | null;
  private _mapper: TextEditCoordinateMapper;
  private _callbacks: EditContextCallbacks;

  private _boundOnTextUpdate: (e: Event) => void;
  private _boundOnCharacterBoundsUpdate: (e: Event) => void;
  private _boundOnCompositionStart: () => void;
  private _boundOnCompositionEnd: (e: Event) => void;

  private constructor(
    editContext: BrowserEditContext,
    mapper: TextEditCoordinateMapper,
    callbacks: EditContextCallbacks,
  ) {
    this._editContext = editContext;
    this._mapper = mapper;
    this._callbacks = callbacks;

    // Bind handlers so we can remove them later in destroy()
    this._boundOnTextUpdate = this._onTextUpdate.bind(this);
    this._boundOnCharacterBoundsUpdate = this._onCharacterBoundsUpdate.bind(this);
    this._boundOnCompositionStart = this._onCompositionStart.bind(this);
    this._boundOnCompositionEnd = this._onCompositionEnd.bind(this);

    // Attach event listeners
    this._editContext.addEventListener("textupdate", this._boundOnTextUpdate);
    this._editContext.addEventListener("characterboundsupdate", this._boundOnCharacterBoundsUpdate);
    this._editContext.addEventListener("compositionstart", this._boundOnCompositionStart);
    this._editContext.addEventListener("compositionend", this._boundOnCompositionEnd);
  }

  /** Returns `true` when the browser provides the EditContext API (Chromium 122+). */
  static isSupported(): boolean {
    return "EditContext" in globalThis;
  }

  /**
   * Factory method. Creates an `TextEditContextAdapter` when the EditContext API
   * is available, otherwise returns `null`.
   */
  static create(
    mapper: TextEditCoordinateMapper,
    callbacks: EditContextCallbacks,
  ): TextEditContextAdapter | null {
    if (!TextEditContextAdapter.isSupported()) {
      return null;
    }

    // EditContext is guaranteed to exist by isSupported() check above.
    const EditContextCtor = (globalThis as unknown as { EditContext: new () => BrowserEditContext }).EditContext;
    const editContext = new EditContextCtor();
    return new TextEditContextAdapter(editContext, mapper, callbacks);
  }

  /** Returns the underlying EditContext instance (for attaching to an element). */
  get editContext(): BrowserEditContext | null {
    return this._editContext;
  }

  /**
   * Informs the browser of the editable region's position (paragraph bounding rect)
   * and the current cursor/selection position.
   *
   * Must be called after layout changes or when the viewport scrolls.
   */
  updateBounds(paragraphRect: DOMRect, cursorRect: DOMRect): void {
    if (!this._editContext) return;

    this._editContext.updateControlBounds(paragraphRect);
    this._editContext.updateSelectionBounds(cursorRect);
  }

  /** Detaches all event listeners and releases the EditContext reference. */
  destroy(): void {
    if (!this._editContext) return;

    this._editContext.removeEventListener("textupdate", this._boundOnTextUpdate);
    this._editContext.removeEventListener("characterboundsupdate", this._boundOnCharacterBoundsUpdate);
    this._editContext.removeEventListener("compositionstart", this._boundOnCompositionStart);
    this._editContext.removeEventListener("compositionend", this._boundOnCompositionEnd);

    this._editContext = null;
  }

  // --- Event handlers ---

  private _onTextUpdate(e: Event): void {
    const event = e as TextUpdateEvent;
    this._callbacks.onTextUpdate(
      event.updateText,
      event.updateRangeStart,
      event.updateRangeEnd,
    );
  }

  private _onCharacterBoundsUpdate(e: Event): void {
    if (!this._editContext) return;

    const event = e as CharacterBoundsUpdateEvent;
    const start = event.updateRangeStart;
    const end = event.updateRangeEnd;

    const bounds: CharacterBoundsInfo[] = [];

    for (let i = start; i < end; i++) {
      const rect = this._mapper.getCharRect(i);
      if (rect) {
        bounds.push({
          start: i,
          end: i + 1,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        });
      }
    }

    if (bounds.length > 0) {
      this._editContext.updateCharacterBounds(start, bounds);
    }
  }

  private _onCompositionStart(): void {
    this._callbacks.onCompositionStart();
  }

  private _onCompositionEnd(e: Event): void {
    const event = e as CompositionEndEvent;
    this._callbacks.onCompositionEnd(event.data ?? "");
  }
}

// --- Callback type ---

export interface EditContextCallbacks {
  onTextUpdate: (text: string, replaceStart: number, replaceEnd: number) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (text: string) => void;
  onSelectionChange: (start: number, end: number) => void;
}

// --- EditContext API type declarations (browser global, not imported) ---

/** Minimal type for the browser EditContext API (Chromium 122+). */
interface BrowserEditContext extends EventTarget {
  updateControlBounds(bounds: DOMRect): void;
  updateSelectionBounds(bounds: DOMRect): void;
  updateCharacterBounds(start: number, bounds: CharacterBoundsInfo[]): void;
}

/** Shape of the `textupdate` event from the EditContext API. */
interface TextUpdateEvent extends Event {
  updateText: string;
  updateRangeStart: number;
  updateRangeEnd: number;
}

/** Shape of the `characterboundsupdate` event from the EditContext API. */
interface CharacterBoundsUpdateEvent extends Event {
  updateRangeStart: number;
  updateRangeEnd: number;
}

/** Shape of the `compositionend` event from the EditContext API. */
interface CompositionEndEvent extends Event {
  data?: string;
}

/** Shape passed to `editContext.updateCharacterBounds()`. */
interface CharacterBoundsInfo {
  start: number;
  end: number;
  left: number;
  top: number;
  width: number;
  height: number;
}