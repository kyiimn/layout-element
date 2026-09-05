import { LayoutDocumentElement } from "@/components/layout/document.element";
import { LayoutImageElement } from "@/components/layout/image.element";
import { EditManager } from "./edit-manager";
import type { ImageObjectFit } from "@/types/layout/image.type";

/** 휠 한 틱당 크기 배율. 위로 굴리면 확대, 아래로 굴리면 축소. */
const WHEEL_SCALE_FACTOR = 1.1;

/**
 * 이미지 좌표/크기 getter 값을 number로 정규화한다.
 *
 * `LayoutImageElement`의 x/y/width/height getter는 엔진 미구축 초기
 * 라이프사이클에서 undefined를 반환할 수 있다. 편집 조작은 렌더링 완료된
 * 이미지에만 수행되므로 0으로 수렴시켜도 안전하다.
 *
 * @param value - 이미지 getter 값
 * @returns undefined가 0으로 대체된 값
 */
function num(value: number | undefined): number {
  return value ?? 0;
}

/**
 * 이미지 드래그(위치 이동) 세션 상태.
 */
interface ImageDragState {
  /** 드래그 시작 시점 마우스 clientX/Y */
  startMouseX: number;
  startMouseY: number;
  /** 드래그 시작 시점 이미지 x/y (mm, 부모 contentAbsRect 기준 상대) */
  startX: number;
  startY: number;
  /** rAF 콜백이 읽을 최신 마우스 좌표 */
  lastClientX: number;
  lastClientY: number;
  /** rAF ID. 중복 스케줄링 방지 */
  rafId: number | null;
  /** 드래그 중 단락 재렌더링 배치 추적 대상 부모 박스 */
  parentBox: LayoutImageElement["parentElement"];
}

/**
 * 이미지 편집 컨트롤러.
 *
 * `EditManager.imageEditMode`가 활성화되면 이미지의 **드래그 위치 이동**(x/y)과
 * **휠 크기 조절**(width/height)을 처리한다.
 *
 * ## 동작
 *
 * - **드래그**: mousedown → mousemove로 이미지 x/y를 mm 단위로 이동.
 *   부모 박스 contentAbsRect로 클램핑되어 이미지가 박스 밖으로 완전히 벗어나지 않는다.
 * - **휠**: wheel 이벤트로 width/height를 확대/축소. 기본은 원본 비율 유지,
 *   Shift 키를 누르면 현재 비율 그대로 확대/축소한다.
 * - **objectFit 자동 전환**: 첫 드래그/휠 조작 시 `objectFit`이 `'none'`이 아니면
 *   현재 표시 영역(displayRect)을 x/y/width/height에 고정한 뒤 `'none'`으로 전환한다.
 *   사용자가 직접 수정을 시작하면 자동맞춤에서 사용자정의로 전환된다.
 * - **ESC**: 드래그 중이면 시작 시점 위치로 복원(canceled=true 이벤트),
 *   드래그 중이 아니면 이미지 편집 모드를 해제하고 이전 모드로 복귀한다.
 *
 * ## 이벤트 위임
 *
 * `mousedown`/`wheel`을 capture phase로 문서 요소에 등록하고 `composedPath()`로
 * shadow DOM 내부의 이미지까지 추적한다. LayoutEditController와 동일한 위임 패턴.
 *
 * @example
 * ```ts
 * const manager = layoutDocEl.editManager;
 * manager.imageEditMode = true;
 * manager.focusImage(imageElement);  // 드래그/휠 조작 활성화
 * manager.blurImage();                // 포커스 해제 (모드 유지)
 * ```
 */
export class ImageEditController {
  /** 이벤트 리스너가 등록되는 루트 요소 (문서 요소) */
  private _document: LayoutDocumentElement;
  /** 이 컨트롤러가 속한 EditManager 인스턴스 */
  private _manager: EditManager;
  /** 컨트롤러 활성화 여부 */
  private _attached = false;

  /** 진행 중인 드래그 상태. null이면 드래그 중 아님 */
  private _dragState: ImageDragState | null = null;
  /** 드래그 중인 이미지 */
  private _dragImage: LayoutImageElement | null = null;
  /** 드래그 시작 시점 이미지 원본 상태 (ESC 복원용) */
  private _dragSnapshot: {
    x: number;
    y: number;
    objectFit: ImageObjectFit;
  } | null = null;
  /** 드래그 임계값(3px)을 넘어 실제 이동이 시작되었는지 여부 */
  private _dragMoved = false;

  /**
   * @param doc - 이벤트 리스너가 등록될 문서 요소
   * @param manager - 이 컨트롤러가 속한 EditManager 인스턴스
   */
  constructor(doc: LayoutDocumentElement, manager: EditManager) {
    this._document = doc;
    this._manager = manager;
  }

  /** 컨트롤러를 활성화하여 문서 레벨 이벤트 리스너를 등록한다. */
  attach(): void {
    if (this._attached) return;
    this._attached = true;
    this._document.addEventListener('mousedown', this._onMouseDown, true);
    this._document.addEventListener('wheel', this._onWheel, true);
    document.addEventListener('keydown', this._onKeyDown, true);
  }

  /** 컨트롤러를 비활성화하고 진행 중인 조작을 취소한 뒤 리스너를 제거한다. */
  detach(): void {
    if (!this._attached) return;
    this._attached = false;
    this._document.removeEventListener('mousedown', this._onMouseDown, true);
    this._document.removeEventListener('wheel', this._onWheel, true);
    document.removeEventListener('keydown', this._onKeyDown, true);
    this._cancelDrag();
  }

  /** 컨트롤러를 완전히 파괴한다. `detach()`와 동일하다. */
  destroy(): void {
    this.detach();
  }

  // ─── Event Detection Helpers ──────────────────────────────────

  /**
   * 이벤트 발생 경로에서 이미지 요소를 찾는다.
   *
   * @param event - 마우스/휠 이벤트
   * @returns 경로상의 이미지 요소. 없으면 null
   */
  private _findImageFromEvent(event: Event): LayoutImageElement | null {
    for (const el of event.composedPath()) {
      if (el instanceof LayoutImageElement) return el;
    }
    return null;
  }

  // ─── Mouse Down (Drag Start) ─────────────────────────────────

  /**
   * mousedown 이벤트 핸들러.
   *
   * 이미지 편집 모드에서 이미지 위에서 좌클릭하면 해당 이미지에 포커스를
   * 부여(이미 포커스된 이미지면 유지)하고 드래그 세션을 시작한다.
   * 삽입 모드, Place Gun, 스페이스(팬) 상태에서는 무시한다.
   *
   * @param event - mousedown 마우스 이벤트
   */
  private _onMouseDown = (event: MouseEvent): void => {
    const manager = this._manager;
    if (manager.insertMode) return;
    if (manager.placeGunActive) return;
    if (manager.spacePressed) return;
    if (event.button !== 0) return;

    const image = this._findImageFromEvent(event);
    if (!image) return;
    if (!manager.isImageEditable(image)) return;

    event.preventDefault();
    event.stopPropagation();

    if (manager.focusedImage !== image) {
      manager.focusImage(image);
    }

    this._startDrag(event, image);
  };

  /**
   * 이미지 드래그 세션을 시작한다.
   *
   * 현재 표시 위치를 스냅샷으로 저장하고, 부모 박스의 단락 재렌더링 배치
   * 추적을 활성화한 뒤 document 레벨 mousemove/mouseup 리스너를 등록한다.
   *
   * @param event - mousedown 이벤트
   * @param image - 드래그 대상 이미지 요소
   */
  private _startDrag(event: MouseEvent, image: LayoutImageElement): void {
    const parentBox = image.parentElement;
    parentBox?.startDragTracking();

    this._dragImage = image;
    this._dragMoved = false;
    this._dragSnapshot = {
      x: num(image.x),
      y: num(image.y),
      objectFit: image.objectFit,
    };
    this._dragState = {
      startMouseX: event.clientX,
      startMouseY: event.clientY,
      startX: num(image.x),
      startY: num(image.y),
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      rafId: null,
      parentBox,
    };
    image.style.cursor = 'grabbing';

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
  }

  // ─── Mouse Move ───────────────────────────────────────────────

  /**
   * 드래그 중 mousemove 이벤트 핸들러.
   *
   * rAF로 스로틀링하여 60fps 이내로 이미지 위치를 갱신한다.
   * 임계값(3px)을 넘으면 objectFit을 'none'으로 전환한 뒤 x/y 갱신을 시작한다.
   *
   * @param event - mousemove 마우스 이벤트
   */
  private _onMouseMove = (event: MouseEvent): void => {
    const state = this._dragState;
    const image = this._dragImage;
    if (!state || !image) return;

    state.lastClientX = event.clientX;
    state.lastClientY = event.clientY;

    const deltaX = state.lastClientX - state.startMouseX;
    const deltaY = state.lastClientY - state.startMouseY;
    if (!this._dragMoved && (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)) {
      this._dragMoved = true;
      this._ensureObjectFitNone(image, 'drag');
    }
    if (!this._dragMoved) return;
    if (state.rafId !== null) return;

    state.rafId = requestAnimationFrame(() => {
      state.rafId = null;
      if (!this._dragMoved || !this._dragImage) return;

      const manager = this._manager;
      const dxMm = manager.screenDeltaToMm(state.lastClientX - state.startMouseX);
      const dyMm = manager.screenDeltaToMm(state.lastClientY - state.startMouseY);

      const nextX = this._clampX(state.startX + dxMm);
      const nextY = this._clampY(state.startY + dyMm);
      if (image.x !== nextX) image.x = nextX;
      if (image.y !== nextY) image.y = nextY;
    });
  };

  /**
   * 드래그 종료(mouseup) 이벤트 핸들러.
   *
   * 실제 이동이 있었으면 부모 박스의 보류된 단락 재렌더링을 확정하고
   * `imageMove` 커밋 이벤트를 발생시킨다. 클릭 수준 이동이면 조용히 종료한다.
   *
   * @param event - mouseup 마우스 이벤트
   */
  private _onMouseUp = (event: MouseEvent): void => {
    const image = this._dragImage;
    const state = this._dragState;
    if (!image || !state) return;

    this._teardownDragListeners(state);

    const moved = this._dragMoved;
    const previous = { x: state.startX, y: state.startY };

    this._dragState = null;
    this._dragImage = null;
    this._dragSnapshot = null;
    this._dragMoved = false;

    image.style.cursor = '';
    state.parentBox?.flushDragRerender();

    if (!moved) return;

    event.stopPropagation();
    this._manager._suppressLayoutClick();
    this._manager._dispatchImageMove(
      image,
      previous,
      { x: num(image.x), y: num(image.y) },
      false,
    );
  };

  // ─── Keyboard (ESC) ───────────────────────────────────────────

  /**
   * keydown 이벤트 핸들러.
   *
   * 드래그 중 ESC: 드래그를 취소하고 시작 시점 위치로 복원한다 (canceled=true).
   * 드래그 중이 아닌 ESC: 이미지 편집 모드를 해제하고 이전 모드로 복귀한다.
   *
   * @param event - 키보드 이벤트
   */
  private _onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (this._dragState) {
      this._cancelDrag();
      return;
    }
    this._manager._exitImageEditModeWithRestore();
  };

  /**
   * 진행 중인 드래그를 취소하고 시작 시점 위치로 복원한다.
   *
   * 복원 후 canceled=true인 `imageMove` 커밋 이벤트를 발생시킨다.
   */
  private _cancelDrag(): void {
    const image = this._dragImage;
    const state = this._dragState;
    const snapshot = this._dragSnapshot;
    if (!image || !state) return;

    this._teardownDragListeners(state);
    this._dragState = null;
    this._dragImage = null;
    this._dragSnapshot = null;
    this._dragMoved = false;

    if (!snapshot) return;

    if (image.x !== snapshot.x) image.x = snapshot.x;
    if (image.y !== snapshot.y) image.y = snapshot.y;
    if (image.objectFit !== snapshot.objectFit) image.objectFit = snapshot.objectFit;

    image.style.cursor = '';
    state.parentBox?.flushDragRerender();

    this._manager._dispatchImageMove(
      image,
      { x: snapshot.x, y: snapshot.y },
      { x: snapshot.x, y: snapshot.y },
      true,
    );
  }

  /**
   * 드래그 세션의 document 레벨 리스너를 제거하고 대기 중인 rAF를 취소한다.
   *
   * @param state - 드래그 상태
   */
  private _teardownDragListeners(state: ImageDragState): void {
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
  }

  // ─── Wheel (Resize) ───────────────────────────────────────────

  /**
   * wheel 이벤트 핸들러.
   *
   * 포커스된 이미지 위에서 휠을 굴리면 크기를 조절한다.
   * objectFit이 'none'이 아니면 먼저 전환한 뒤 조절한다.
   *
   * - 기본: 원본 비율(originalWidth/originalHeight) 유지 확대/축소
   * - Shift: 현재 비율 유지 확대/축소
   * - 크기 상한은 부모 박스 크기의 3배, 하한은 1mm
   *
   * @param event - wheel 이벤트
   */
  private _onWheel = (event: WheelEvent): void => {
    const manager = this._manager;
    if (manager.insertMode) return;
    if (manager.placeGunActive) return;
    if (manager.spacePressed) return;

    const image = manager.focusedImage;
    if (!image) return;
    if (!this._findImageFromEvent(event)) return;

    event.preventDefault();
    event.stopPropagation();

    const before = { width: num(image.width), height: num(image.height) };
    this._ensureObjectFitNone(image, 'wheel');

    const factor = event.deltaY < 0 ? WHEEL_SCALE_FACTOR : 1 / WHEEL_SCALE_FACTOR;
    const originalRatio = this._getOriginalRatio(image);
    const currentWidth = num(image.width) || 1;
    const currentHeight = num(image.height) || 1;
    // 폴백 비율은 originalRatio와 동일한 w/h 방향이어야 한다.
    // (h/w를 쓰면 nextHeight = nextWidth / (h/w)로 역수가 두 번 적용되어
    // height가 폭주한다 — originalWidth 미설정 이미지에서 재현.)
    const ratio = originalRatio !== null ? originalRatio : currentWidth / currentHeight;

    let nextWidth: number;
    let nextHeight: number;
    if (event.shiftKey) {
      nextWidth = this._clampDimension(currentWidth * factor);
      nextHeight = currentHeight * (nextWidth / currentWidth);
    } else {
      nextWidth = this._clampDimension(currentWidth * factor);
      nextHeight = nextWidth / ratio;
    }

    if (currentWidth === nextWidth && currentHeight === nextHeight) return;

    this._setProp(image, 'width', nextWidth, 'wheel');
    this._setProp(image, 'height', nextHeight, 'wheel');
    this._manager._dispatchImageResize(image, before, { width: nextWidth, height: nextHeight });
  };

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * 이미지가 objectFit 'none'이 아니면 현재 표시 영역을 유지한 채 'none'으로 전환한다.
   *
   * 사용자가 드래그/휠로 직접 수정을 시작하는 순간 자동 전환된다.
   * 전환 전 displayRect(자동 계산값)를 x/y/width/height에 고정하므로
   * 화면이 점프하지 않는다.
   *
   * @param image - 대상 이미지 요소
   * @param source - 전환 원인 ('drag' | 'wheel')
   */
  private _ensureObjectFitNone(image: LayoutImageElement, source: 'drag' | 'wheel'): void {
    if (image.objectFit === 'none') return;
    // 전환 직전 displayRect(자동 계산값)를 읽어 x/y/width/height에 고정한다.
    const currentX = image.x;
    const currentY = image.y;
    const currentWidth = image.width;
    const currentHeight = image.height;

    this._setProp(image, 'objectFit', 'none', source);

    image.x = currentX;
    image.y = currentY;
    image.width = currentWidth;
    image.height = currentHeight;
  }

  /**
   * 이미지 속성을 변경하고 `imagePropertyChange` 이벤트를 발생시킨다.
   *
   * @param image - 대상 이미지 요소
   * @param prop - 변경할 속성
   * @param value - 새 값
   * @param source - 변경 원인
   */
  private _setProp(
    image: LayoutImageElement,
    prop: 'width' | 'height' | 'objectFit',
    value: number | ImageObjectFit,
    source: 'drag' | 'wheel',
  ): void {
    if (prop === 'objectFit') {
      const fitValue = value as ImageObjectFit;
      const oldValue = image.objectFit;
      if (oldValue === fitValue) return;
      image.objectFit = fitValue;
      this._manager._dispatchImagePropertyChange({
        image,
        property: 'objectFit',
        oldValue,
        newValue: fitValue,
        source,
      });
      return;
    }
    const oldValue = num(image[prop]);
    if (oldValue === value) return;
    image[prop] = value as number;
    this._manager._dispatchImagePropertyChange({
      image,
      property: prop,
      oldValue,
      newValue: value as number,
      source,
    });
  }

  /**
   * 드래그 x 좌표를 그대로 반환한다 (제한 없음).
   *
   * InDesign 시맨틱: 박스는 크롭 윈도우일 뿐 이미지 이동 범위를 제한하지
   * 않는다. 이미지가 박스 밖으로 나간 부분은 캔버스가 contentAbsRect로
   * 클리핑하고(`_drawImage`), 오버랩 판정도 displayRect를 contentAbsRect로
   * 클램핑하므로(`ImageEngine.computeOverlap`) 데이터 정합성은 이동 범위와
   * 무관하게 유지된다.
   *
   * @param x - 드래그로 계산된 x (mm)
   * @returns 클램핑 없는 x (mm)
   */
  private _clampX(x: number): number {
    return x;
  }

  /**
   * 드래그 y 좌표를 그대로 반환한다 (제한 없음).
   * {@link _clampX}와 동일한 InDesign 시맨틱 — 박스 밖 이동 허용.
   *
   * @param y - 드래그로 계산된 y (mm)
   * @returns 클램핑 없는 y (mm)
   */
  private _clampY(y: number): number {
    return y;
  }

  /**
   * width/height를 최소 크기(1mm) 이상으로만 클램핑한다.
   *
   * 상한은 없다 (InDesign 시맨틱 — 크기 제한 없음). 1mm 하한은 0/음수로
   * 수렴해 이미지를 되돌릴 수 없게 되는 것만 방지한다.
   *
   * @param value - 클램핑 전 값 (mm)
   * @returns 최소 1mm가 보장된 값 (mm)
   */
  private _clampDimension(value: number): number {
    return Math.max(1, value);
  }

  /**
   * 이미지 원본 비율(width/height)을 반환한다.
   *
   * @param image - 대상 이미지
   * @returns 원본 비율. originalWidth/originalHeight 미설정 시 null
   */
  private _getOriginalRatio(image: LayoutImageElement): number | null {
    if (image.originalWidth && image.originalHeight) {
      return image.originalWidth / image.originalHeight;
    }
    return null;
  }
}