import { GridCalculator } from "@/core";
import { EditManager } from "./edit-manager";
import { LayoutDocumentElement } from "@/components/layout/document.element";
import { LayoutBoxElement } from "@/components/layout/box.element";
import { BoxData } from "@/types";
import type { InsertMode, InsertEventDetail } from "@/types/edit";

/** 드래그-삽입을 통한 새 요소 생성을 관리하는 컨트롤러. */
export class InsertController {
  private _document: LayoutDocumentElement;
  private _mode: InsertMode | null = null;
  private _isDragging = false;
  private _startClientX = 0;
  private _startClientY = 0;
  private _currentClientX = 0;
  private _currentClientY = 0;
  private _previewEl: HTMLDivElement | null = null;
  private _startContainer: LayoutDocumentElement | LayoutBoxElement | null = null;
  private _boundStartDrag: (event: MouseEvent) => void;
  private _boundOnMouseMove: (event: MouseEvent) => void;
  private _boundOnMouseUp: (event: MouseEvent) => void;
  private _boundOnKeyDown: (event: KeyboardEvent) => void;

  private static readonly DRAG_THRESHOLD = 3;

  constructor(document: LayoutDocumentElement) {
    this._document = document;
    this._boundStartDrag = this.startDrag.bind(this);
    this._boundOnMouseMove = this._onMouseMove.bind(this);
    this._boundOnMouseUp = this._onMouseUp.bind(this);
    this._boundOnKeyDown = this._onKeyDown.bind(this);
  }

  /** 현재 삽입 모드를 반환한다. */
  get mode(): InsertMode | null {
    return this._mode;
  }

  /** 현재 삽입 드래그를 진행 중인지 반환한다. */
  get isDragging(): boolean {
    return this._isDragging;
  }

  /** 삽입 모드를 설정한다. `null`이면 삽입 모드를 해제한다. */
  setMode(mode: InsertMode | null): void {
    if (this._mode && this._isDragging) {
      this._cancel();
    }

    if (this._mode) {
      this._document.removeEventListener('mousedown', this._boundStartDrag);
    }

    this._mode = mode;

    if (mode) {
      // 문서 빈 공간(box가 없는 영역)에서의 mousedown을 처리하기 위해
      // 버블링 단계로 등록한다. box 위에서는 _onLayoutMouseDown이
      // handleInsertMouseDown()을 통해 먼저 startDrag()를 호출하므로
      // _isDragging 가드로 중복 실행을 방지한다.
      this._document.addEventListener('mousedown', this._boundStartDrag);
    }
  }

  /** mousedown 시 호출: 드래그 삽입을 시작한다. */
  startDrag(event: MouseEvent): void {
    if (event.button !== 0) return;
    if (!this._mode) return;
    if (this._isDragging) return;

    event.preventDefault();
    event.stopPropagation();

    this._startClientX = event.clientX;
    this._startClientY = event.clientY;
    this._currentClientX = event.clientX;
    this._currentClientY = event.clientY;

    this._startContainer = this._findTargetContainer(event.clientX, event.clientY, event.clientX, event.clientY);

    this._previewEl = this._createPreview();
    this._updatePreview(this._startClientX, this._startClientY, this._startClientX, this._startClientY);

    this._isDragging = true;

    document.addEventListener('mousemove', this._boundOnMouseMove);
    document.addEventListener('mouseup', this._boundOnMouseUp);
    document.addEventListener('keydown', this._boundOnKeyDown);
  }

  private _onMouseMove(event: MouseEvent): void {
    this._currentClientX = event.clientX;
    this._currentClientY = event.clientY;
    this._updatePreview(this._startClientX, this._startClientY, this._currentClientX, this._currentClientY);
  }

  private _onMouseUp(event: MouseEvent): void {
    event.stopPropagation();
    const dx = event.clientX - this._startClientX;
    const dy = event.clientY - this._startClientY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < InsertController.DRAG_THRESHOLD) {
      this._cleanup();
      return;
    }

    this._finishInsert(event.clientX, event.clientY);
  }

  private _onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this._cancel();
    }
  }

  /** ESC 취소 시 호출: 미리보기를 제거하고 취소 이벤트를 발생시킨다. */
  private _cancel(): void {
    this._cleanup();
    const manager = EditManager.getInstance();
    manager._dispatchInsertCancel();
  }

  /** 삽입을 완료하고 요소를 생성한다. */
  private _finishInsert(endClientX: number, endClientY: number): void {
    if (!this._mode) {
      this._cleanup();
      return;
    }

    const mode = this._mode;

    const startX = Math.min(this._startClientX, endClientX);
    const startY = Math.min(this._startClientY, endClientY);
    const endX = Math.max(this._startClientX, endClientX);
    const endY = Math.max(this._startClientY, endClientY);

    // 드래그 영역을 완전히 포함하는 가장 안쪽 컨테이너를 찾는다
    const container = this._findTargetContainer(startX, startY, endX, endY);
    if (!container) {
      this._cleanup();
      return;
    }

    const widthPx = endX - startX;
    const heightPx = endY - startY;

    const widthMm = EditManager.getInstance().screenPxToMm(widthPx);
    const heightMm = EditManager.getInstance().screenPxToMm(heightPx);

    const { left: leftMm, top: topMm } = this._screenToContainerMm(startX, startY, container);

    const zIndex = this._getNextZIndex(container);

    let left: number;
    let top: number;
    let width: number;
    let height: number;

    if (mode.position === 'static') {
      const staticCoords = this._mmToStatic(leftMm, topMm, widthMm, heightMm, container);
      left = staticCoords.left;
      top = staticCoords.top;
      width = staticCoords.width;
      height = staticCoords.height;
    } else {
      left = Math.round(leftMm * 100) / 100;
      top = Math.round(topMm * 100) / 100;
      width = Math.round(widthMm * 100) / 100;
      height = Math.round(heightMm * 100) / 100;
    }

    if (mode.position === 'absolute') {
      if (width < 1 || height < 1) {
        this._cleanup();
        return;
      }
    } else {
      if (width < 1 || height < 1) {
        this._cleanup();
        return;
      }
    }

    const element = this._createElement(mode, container, left, top, width, height, zIndex);

    this._cleanup();

    const manager = EditManager.getInstance();
    const detail: InsertEventDetail = {
      type: mode.type,
      position: mode.position,
      element,
      container,
      left,
      top,
      width,
      height,
      zIndex,
      canceled: false,
    };
    manager._dispatchInsert(detail);
  }

  /**
   * 드래그 영역을 완전히 포함하는 가장 안쪽 유효 컨테이너를 찾는다.
   *
   * 드래그 사각형의 네 꼭짓점이 모두 포함되는 가장 깊이 중첩된 컨테이너를 반환한다.
   * 어떤 컨테이너도 영역을 완전히 포함하지 못하면 EditManager의 루트 요소를 반환한다.
   *
   * @param startX - 드래그 영역 왼쪽 화면 x좌표 (px)
   * @param startY - 드래그 영역 위쪽 화면 y좌표 (px)
   * @param endX - 드래그 영역 오른쪽 화면 x좌표 (px)
   * @param endY - 드래그 영역 아래쪽 화면 y좌표 (px)
   * @returns 유효한 컨테이너 요소, 또는 루트 요소
   */
  private _findTargetContainer(startX: number, startY: number, endX: number, endY: number): LayoutDocumentElement | LayoutBoxElement {
    const corners = [
      { x: startX, y: startY },
      { x: endX, y: startY },
      { x: startX, y: endY },
      { x: endX, y: endY },
    ];

    // 네 꼭짓점에서 hit test하여 후보 컨테이너 수집
    const candidates = new Map<LayoutDocumentElement | LayoutBoxElement, number>();
    for (const corner of corners) {
      const elements = document.elementsFromPoint(corner.x, corner.y);
      for (const el of elements) {
        if (el instanceof LayoutBoxElement || el instanceof LayoutDocumentElement) {
          const existing = candidates.get(el) ?? 0;
          candidates.set(el, existing + 1);
          break;
        }
      }
    }

    // 네 꼭짓점 모두에서 hit된 후보만 필터링
    const fullyHit: (LayoutDocumentElement | LayoutBoxElement)[] = [];
    for (const [el, count] of candidates) {
      if (count === 4) {
        fullyHit.push(el);
      }
    }

    // 사각형이 각 후보의 경계 내에 완전히 포함되는지 확인
    // 가장 안쪽(깊이 중첩된) 유효 컨테이너를 찾는다
    for (const el of fullyHit) {
      if (el instanceof LayoutDocumentElement) {
        // Document는 항상 포함하므로, 더 안쪽 box가 없을 때의 대상
        continue;
      }
      if (el instanceof LayoutBoxElement) {
        if (el.lock) continue;
        const items = el.items;
        const hasNonBoxChild = items.some(item => item.type !== 'box');
        if (hasNonBoxChild) continue; // 비-box 자식이 있으면 삽입 불가

        const rect = el.getBoundingClientRect();
        if (
          startX >= rect.left && endX <= rect.right &&
          startY >= rect.top && endY <= rect.bottom
        ) {
          return el;
        }
      }
    }

    // Document 요소도 포함 여부 확인
    const docRect = this._document.getBoundingClientRect();
    if (
      startX >= docRect.left && endX <= docRect.right &&
      startY >= docRect.top && endY <= docRect.bottom
    ) {
      // Document 내부에서 box를 찾지 못한 경우 — editableRootId가 있으면 해당 루트 box 확인
      const manager = EditManager.getInstance();
      const rootId = manager.editableRootId;
      if (rootId) {
        const rootBox = this._document.querySelector(`#${CSS.escape(rootId)}`) as LayoutBoxElement | null;
        if (rootBox && !rootBox.lock) {
          const rootRect = rootBox.getBoundingClientRect();
          if (
            startX >= rootRect.left && endX <= rootRect.right &&
            startY >= rootRect.top && endY <= rootRect.bottom
          ) {
            return rootBox;
          }
        }
      }
      return this._document;
    }

    // 드래그 영역이 어느 컨테이너보다 크면 EditManager 루트로 폴백
    return this._getRootContainer();
  }

  /**
   * EditManager에 설정된 루트 컨테이너를 반환한다.
   *
   * `editableRootId`가 설정되어 있으면 해당 ID의 box를 찾고,
   * 없으면 문서 루트(`_document`)를 반환한다.
   *
   * @returns 루트 컨테이너 요소
   */
  private _getRootContainer(): LayoutDocumentElement | LayoutBoxElement {
    const manager = EditManager.getInstance();
    const rootId = manager.editableRootId;
    if (rootId) {
      const rootBox = this._document.querySelector(`#${CSS.escape(rootId)}`) as LayoutBoxElement | null;
      if (rootBox) return rootBox;
    }
    return this._document;
  }

  /** 화면 좌표를 컨테이너 내부 mm 좌표로 변환한다. */
  private _screenToContainerMm(clientX: number, clientY: number, container: LayoutDocumentElement | LayoutBoxElement): { left: number; top: number } {
    const rect = container.getBoundingClientRect();
    const manager = EditManager.getInstance();

    let containerPaddingLeft = 0;
    let containerPaddingTop = 0;

    if (container instanceof LayoutBoxElement) {
      containerPaddingLeft = container.paddingLeft ?? 0;
      containerPaddingTop = container.paddingTop ?? 0;
    }

    const leftMm = Math.max(0, manager.screenPxToMm(clientX - rect.left) - containerPaddingLeft);
    const topMm = Math.max(0, manager.screenPxToMm(clientY - rect.top) - containerPaddingTop);

    return { left: leftMm, top: topMm };
  }

  /** mm 좌표를 static 그리드 좌표로 변환한다. */
  private _mmToStatic(leftMm: number, topMm: number, widthMm: number, heightMm: number, container: LayoutDocumentElement | LayoutBoxElement): { left: number; top: number; width: number; height: number } {
    const model = container.model;
    if (!model) {
      return { left: 0, top: 0, width: 1, height: 1 };
    }

    const { columnCoords, lineHeight, editableWidth, columnCount } = model;
    const avgColWidth = editableWidth / columnCount;

    const editAreaLeft = columnCoords[0]?.x1 ?? 0;
    const editAreaTop = columnCoords[0]?.y1 ?? 0;

    const nearestColumn = Math.round((leftMm - editAreaLeft) / avgColWidth);
    const clampedColumn = Math.max(0, Math.min(columnCount - Math.max(1, Math.round(widthMm / avgColWidth)), nearestColumn));

    const nearestLine = Math.round((topMm - editAreaTop) / lineHeight);
    const clampedLine = Math.max(0, nearestLine);

    const staticWidth = Math.max(1, Math.round(widthMm / avgColWidth));
    const staticHeight = Math.max(1, Math.round(heightMm / lineHeight));

    return {
      left: clampedColumn,
      top: clampedLine,
      width: staticWidth,
      height: staticHeight,
    };
  }

  /** 컨테이너 내에서 다음 zIndex를 계산한다. */
  private _getNextZIndex(container: LayoutDocumentElement | LayoutBoxElement): number {
    const items = container.items;
    if (items.length === 0) return 1;
    return Math.max(...items.map(i => i.zIndex ?? 0)) + 1;
  }

  /** 삽입할 DOM 요소를 생성한다. */
  private _createElement(mode: InsertMode, container: LayoutDocumentElement | LayoutBoxElement, left: number, top: number, width: number, height: number, zIndex: number): HTMLElement {
    const boxEl = document.createElement('x-layout-box') as LayoutBoxElement;

    const boxData: BoxData = {
      type: 'box',
      left,
      top,
      width,
      height,
      position: mode.position,
      zIndex,
    };

    if (mode.type === 'text') {
      boxData.children = { type: 'text', content: '' };
    } else if (mode.type === 'paragraph') {
      boxData.children = { type: 'paragraph', content: '' };
    } else if (mode.type === 'image') {
      boxData.children = { type: 'image', x: 0, y: 0, width: 100, height: 100, dpi: 72, url: '' };
    }

    boxEl.data = boxData;

    container.appendChild(boxEl);

    return boxEl;
  }

  /** 미리보기 사각형 DOM 요소를 생성한다. */
  private _createPreview(): HTMLDivElement {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.border = '2px dashed #1a73e8';
    el.style.backgroundColor = 'rgba(26, 115, 232, 0.1)';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '999999';
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  /** 미리보기 사각형의 위치와 크기를 업데이트한다. */
  private _updatePreview(startX: number, startY: number, currentX: number, currentY: number): void {
    if (!this._previewEl) return;

    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    if (width <= 1 && height <= 1) {
      this._previewEl.style.display = 'none';
      return;
    }

    if (this._mode?.position === 'static' && this._startContainer) {
      const snapped = this._snapPreviewToGrid(left, top, width, height, this._startContainer);
      this._previewEl.style.left = `${snapped.left}px`;
      this._previewEl.style.top = `${snapped.top}px`;
      this._previewEl.style.width = `${snapped.width}px`;
      this._previewEl.style.height = `${snapped.height}px`;
    } else {
      this._previewEl.style.left = `${left}px`;
      this._previewEl.style.top = `${top}px`;
      this._previewEl.style.width = `${width}px`;
      this._previewEl.style.height = `${height}px`;
    }

    this._previewEl.style.display = 'block';
  }

  /** static 모드에서 미리보기를 컬럼/라인 그리드에 스냅한다. */
  private _snapPreviewToGrid(leftPx: number, topPx: number, widthPx: number, heightPx: number, container: LayoutDocumentElement | LayoutBoxElement): { left: number; top: number; width: number; height: number } {
    const model = container.model;
    if (!model) {
      return { left: leftPx, top: topPx, width: widthPx, height: widthPx };
    }

    const manager = EditManager.getInstance();
    const { columnCoords, lineHeight, editableWidth, columnCount } = model;
    const avgColWidth = editableWidth / columnCount;

    const rect = container.getBoundingClientRect();
    let containerPaddingLeft = 0;
    let containerPaddingTop = 0;
    if (container instanceof LayoutBoxElement) {
      containerPaddingLeft = container.paddingLeft ?? 0;
      containerPaddingTop = container.paddingTop ?? 0;
    }

    const editAreaLeftMm = columnCoords[0]?.x1 ?? 0;
    const editAreaTopMm = columnCoords[0]?.y1 ?? 0;
    // mm → 화면 픽셀 (정확히는 ppm*scale)
    const screenPpm = GridCalculator.ppm * manager.scale;
    const editAreaLeftPx = rect.left + editAreaLeftMm * screenPpm;
    const editAreaTopPx = rect.top + editAreaTopMm * screenPpm;

    const leftMm = Math.max(0, manager.screenPxToMm(leftPx - rect.left) - containerPaddingLeft);
    const topMm = Math.max(0, manager.screenPxToMm(topPx - rect.top) - containerPaddingTop);
    const widthMm = manager.screenPxToMm(widthPx);
    const heightMm = manager.screenPxToMm(heightPx);

    const staticCoords = this._mmToStatic(leftMm, topMm, widthMm, heightMm, container);

    const snapLeftPx = editAreaLeftPx + staticCoords.left * avgColWidth * screenPpm;
    const snapTopPx = editAreaTopPx + staticCoords.top * lineHeight * screenPpm;
    const snapWidthPx = staticCoords.width * avgColWidth * screenPpm;
    const snapHeightPx = staticCoords.height * lineHeight * screenPpm;

    return {
      left: Math.round(snapLeftPx),
      top: Math.round(snapTopPx),
      width: Math.round(snapWidthPx),
      height: Math.round(snapHeightPx),
    };
  }

  /** 미리보기 사각형을 제거한다. */
  private _removePreview(): void {
    if (this._previewEl) {
      this._previewEl.remove();
      this._previewEl = null;
    }
  }

  /** 이벤트 리스너와 미리보기를 정리한다. */
  private _cleanup(): void {
    this._isDragging = false;
    this._startContainer = null;
    this._removePreview();
    document.removeEventListener('mousemove', this._boundOnMouseMove);
    document.removeEventListener('mouseup', this._boundOnMouseUp);
    document.removeEventListener('keydown', this._boundOnKeyDown);
  }

  /** 컨트롤러를 완전히 파괴한다. 삽입 모드 해제 시 호출된다. */
  destroy(): void {
    this.setMode(null);
  }
}