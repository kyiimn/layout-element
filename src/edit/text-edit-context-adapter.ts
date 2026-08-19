import type { TextEditCoordinateMapper } from "./text-edit-coordinate-mapper";
import { EditManager } from "./edit-manager";

/**
 * Adapter that bridges the browser EditContext API with the layout engine.
 *
 * @deprecated Safari에서 EditContext API가 구현될 때까지 사용하지 않습니다.
 *
 * EditContext API는 Chromium 122+에서만 구현되어 있고 Safari/Firefox는 미지원.
 * 크로스 브라우저 지원이 확보될 때까지 `TextEditController`는 textarea 기반
 * fallback 경로만 사용합니다. 이 어댑터는 `TextEditController`에 연결되어
 * 있지 않으며(dead code), 모든 브라우저에서 textarea 경로로 동작합니다.
 *
 * Safari가 EditContext API를 구현하면 이 어댑터를 활성화하고 textarea
 * 경로를 우회하도록 `TextEditController`에 연결 작업을 수행해야 합니다.
 * 그 전까지는 이 파일을 사용하지 마십시오.
 */
export class TextEditContextAdapter {
  private _editContext: BrowserEditContext | null;
  private _mapper: TextEditCoordinateMapper;
  private _manager: EditManager;
  private _callbacks: EditContextCallbacks;

  private _boundOnTextUpdate: (e: Event) => void;
  private _boundOnCharacterBoundsUpdate: (e: Event) => void;
  private _boundOnCompositionStart: () => void;
  private _boundOnCompositionEnd: (e: Event) => void;

  private constructor(
    editContext: BrowserEditContext,
    mapper: TextEditCoordinateMapper,
    manager: EditManager,
    callbacks: EditContextCallbacks,
  ) {
    this._editContext = editContext;
    this._mapper = mapper;
    this._manager = manager;
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

  /**
   * Returns `true` when the browser provides the EditContext API (Chromium 122+).
   *
   * @deprecated Safari에서 EditContext API가 구현될 때까지 사용하지 않습니다.
   */
  static isSupported(): boolean {
    return "EditContext" in globalThis;
  }

  /**
   * Factory method. Creates an `TextEditContextAdapter` when the EditContext API
   * is available, otherwise returns `null`.
   *
   * @deprecated Safari에서 EditContext API가 구현될 때까지 항상 `null`을
   * 반환합니다. 크로스 브라우저 지원이 확보되면 이 가드를 제거하고
   * 실제 `EditContext` 인스턴스를 생성하도록 복원하십시오.
   *
   * @param _mapper - 좌표 변환에 사용할 TextEditCoordinateMapper
   * @param _manager - 이 adapter가 속한 EditManager 인스턴스
   * @param _callbacks - EditContext 이벤트 콜백
   * @returns 항상 `null` (사용 중단 상태).
   */
  static create(
    _mapper: TextEditCoordinateMapper,
    _manager: EditManager,
    _callbacks: EditContextCallbacks,
  ): TextEditContextAdapter | null {
    return null;
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

    // getCharRect는 paragraph local coordinate(transform: scale 적용 전)를 반환하므로,
    // EditContext API가 요구하는 viewport coordinate로 변환하기 위해 scale을 곱한다.
    const scale = this._manager.scale;
    const paragraphRect = this._mapper.paragraph.getBoundingClientRect();
    const bounds: CharacterBoundsInfo[] = [];

    for (let i = start; i < end; i++) {
      const rect = this._mapper.getCharRect(i);
      if (rect) {
        bounds.push({
          start: i,
          end: i + 1,
          left: rect.left * scale + paragraphRect.left,
          top: rect.top * scale + paragraphRect.top,
          width: rect.width * scale,
          height: rect.height * scale,
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