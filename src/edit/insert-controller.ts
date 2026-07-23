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
  /**
   * 삽입 드래그 중 현재 하이라이트된 컨테이너.
   * `null`이면 하이라이트 없음. 드래그 영역이 다른 컨테이너를 가리키면 이전 하이라이트를
   * 제거하고 새 컨테이너에 `reparent-target` 속성을 설정한다.
   * 레이아웃 편집 모드의 reparent 하이라이트와 동일한 속성/CSS를 재사용한다.
   */
  private _insertHighlightTarget: LayoutDocumentElement | LayoutBoxElement | null = null;
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

  /**
   * 삽입 모드를 설정한다. `null`이면 삽입 모드를 해제한다.
   *
   * 드래그 중에 mode가 변경된 경우(예: position select로 static ↔ absolute 전환)
   * 드래그를 취소하지 않고 `_mode`만 갱신하여 자연스럽게 이어지도록 한다.
   * 미리보기는 다음 mousemove에서 새 mode의 position에 맞춰 갱신된다.
   */
  setMode(mode: InsertMode | null): void {
    if (this._mode && this._isDragging && !mode) {
      // 드래그 중에 삽입 모드 해제 시에만 취소
      this._cancel();
    }

    if (this._mode && !this._isDragging) {
      this._document.removeEventListener('mousedown', this._boundStartDrag);
    }

    this._mode = mode;

    if (mode && !this._isDragging) {
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
    this._updateInsertHighlight();
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
    const container = this._resolveInsertContainer(startX, startY, endX, endY);
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

    manager._dispatchLayoutAdd({
      element,
      container,
      source: 'insert',
    });
  }

  /**
   * 현재 드래그 영역에 대해 삽입될 컨테이너를 결정한다.
   *
   * `_finishInsert`(드랍)와 `_updateInsertHighlight`(드래그 중 하이라이트)가
   * 공유하는 단일 진실 공급원(single source of truth). 이 메서드를 통해
   * 하이라이트가 가리키는 컨테이너와 실제 삽입되는 컨테이너가 항상 일치한다.
   *
   * 내부적으로 `_findTargetContainer`를 호출하며, 후보가 없으면 `null`을
   * 반환하여 호출자가 early return 하도록 한다.
   *
   * @param startX - 드래그 영역 왼쪽 화면 x좌표 (px)
   * @param startY - 드래그 영역 위쪽 화면 y좌표 (px)
   * @param endX - 드래그 영역 오른쪽 화면 x좌표 (px)
   * @param endY - 드래그 영역 아래쪽 화면 y좌표 (px)
   * @returns 삽입 대상 컨테이너. 후보가 없으면 `null`.
   */
  private _resolveInsertContainer(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): LayoutDocumentElement | LayoutBoxElement | null {
    return this._findTargetContainer(startX, startY, endX, endY);
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
    // static 모드에서는 마우스 픽셀 위치가 그리드 스냅 후 의미가 없으므로,
    // 드래그 영역의 중심점으로 컨테이너를 식별한다. 꼭짓점은 box 경계선 밖에
    // 놓일 수 있지만 중심점은 box 내부에 있으므로 box를 컨테이너로 찾을 수 있다.
    // absolute 모드에서는 mm 좌표가 정확하므로 기존 4꼭짓점 containment를 사용한다.
    if (this._mode?.position === 'static') {
      const centerX = (startX + endX) / 2;
      const centerY = (startY + endY) / 2;

      // elementsFromPoint는 가장 안쪽 요소부터 바깥쪽 순으로 반환한다.
      // 안쪽 box가 paragraph/image 자식을 가지면 삽입 불가능하므로 거르고,
      // 더 바깥의 box-only 컨테이너를 찾을 때까지 순회한다.
      const centerElements = document.elementsFromPoint(centerX, centerY);
      for (const el of centerElements) {
        if (el instanceof LayoutBoxElement) {
          if (el.lock) continue;
          const hasNonBoxChild = el.items.some(item => item.type !== 'box');
          if (hasNonBoxChild) continue;
          return el;
        }
        if (el instanceof LayoutDocumentElement) {
          // document보다 먼저 유효한 box가 나오면 그 box를 쓴다.
          // document가 먼저 나오면(드래그 영역 중심이 box 밖) document로 폴백.
          break;
        }
      }
    }

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

    // elementsFromPoint hit test가 경계선 위 점에서 신뢰할 수 없는 경우
    // (드래그 영역이 박스 경계에 딱 맞아떨어질 때 꼭짓점이 경계선 위에 놓임),
    // 기하학적 rect containment로 후보를 보충한다.
    // _document 내의 모든 x-layout-box를 순회하며 드래그 영역을 완전히 포함하는
    // 가장 안쪽 박스를 찾는다.
    //
    // fullyHit에 box가 있더라도, 그 box들이 모두 비-box 자식(paragraph/image)을
    // 가져서 삽입 불가능하다면 폴백을 실행해야 한다. 그렇지 않으면 안쪽 box가
    // 거절된 후 부모 box-only 컨테이너를 찾지 못하고 document로 폴백한다.
    const hasValidBoxCandidate = fullyHit.some(
      el => el instanceof LayoutBoxElement && !el.lock && !el.items.some(i => i.type !== 'box'),
    );
    if (!hasValidBoxCandidate) {
      const allBoxes = this._document.querySelectorAll<LayoutBoxElement>('x-layout-box');
      for (const box of allBoxes) {
        if (candidates.has(box)) continue; // 이미 hit test에서 처리됨
        if (box.lock) continue;
        const items = box.items;
        const hasNonBoxChild = items.some(item => item.type !== 'box');
        if (hasNonBoxChild) continue;

        const rect = box.getBoundingClientRect();
        // 작은 허용 오차(1px)로 경계선 위 점의 서브픽셀 문제를 흡수한다.
        if (
          startX >= rect.left - 1 && endX <= rect.right + 1 &&
          startY >= rect.top - 1 && endY <= rect.bottom + 1
        ) {
          // 이 박스를 포함하는 다른 후보 박스가 있으면 더 안쪽이므로 우선순위가 낮다.
          // fullyHit에 이미 있는 박스가 이 박스를 포함하는지 확인.
          let isOuter = false;
          for (const hitEl of fullyHit) {
            if (hitEl instanceof LayoutBoxElement && hitEl !== box && hitEl.contains(box)) {
              isOuter = true;
              break;
            }
          }
          if (!isOuter) {
            fullyHit.push(box);
          }
        }
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

    boxEl.requestRerenderAffectedParagraphs();

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
    const { columnCoords, lineHeight, columnCount } = model;

    const rect = container.getBoundingClientRect();
    let containerPaddingLeft = 0;
    let containerPaddingTop = 0;
    if (container instanceof LayoutBoxElement) {
      containerPaddingLeft = container.paddingLeft ?? 0;
      containerPaddingTop = container.paddingTop ?? 0;
    }

    const editAreaTopMm = columnCoords[0]?.y1 ?? 0;
    const screenPpm = GridCalculator.ppm * manager.scale;
    const editAreaTopPx = rect.top + editAreaTopMm * screenPpm;

    const leftMm = Math.max(0, manager.screenPxToMm(leftPx - rect.left) - containerPaddingLeft);
    const topMm = Math.max(0, manager.screenPxToMm(topPx - rect.top) - containerPaddingTop);
    const widthMm = manager.screenPxToMm(widthPx);
    const heightMm = manager.screenPxToMm(heightPx);

    const staticCoords = this._mmToStatic(leftMm, topMm, widthMm, heightMm, container);

    // columnCoords를 직접 사용하여 gap을 정확히 반영
    const startCol = staticCoords.left;
    const endCol = Math.min(columnCount - 1, startCol + staticCoords.width - 1);
    const snapLeftMm = columnCoords[startCol]?.x1 ?? 0;
    const snapRightMm = columnCoords[endCol]?.x2 ?? 0;
    const snapLeftPx = rect.left + (snapLeftMm + containerPaddingLeft) * screenPpm;
    const snapWidthPx = (snapRightMm - snapLeftMm) * screenPpm;
    const snapTopPx = editAreaTopPx + staticCoords.top * lineHeight * screenPpm;
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

  /**
   * 삽입 드래그 중 커서 영역이 들어갈 수 있는 컨테이너에 하이라이트를 토글한다.
   *
   * 드래그 영역의 네 꼭짓점을 기반으로 `_findTargetContainer`와 동일한 알고리즘으로
   * 대상 컨테이너를 찾는다. 이전 하이라이트 대상과 새 대상이 다르면 이전
   * `reparent-target` 속성을 제거하고 새 대상에 설정한다. 레이아웃 편집 모드의
   * reparent 하이라이트와 동일한 속성/CSS를 재사용하여 일관된 시각적 피드백을 제공한다.
   *
   * @example
   * // 드래그 중 mousemove 마다 호출되어 후보 컨테이너를 주황색 테두리로 표시
   * controller._onMouseMove(event);  // → _updateInsertHighlight() 내부 호출
   */
  private _updateInsertHighlight(): void {
    if (!this._isDragging) return;

    const startX = Math.min(this._startClientX, this._currentClientX);
    const startY = Math.min(this._startClientY, this._currentClientY);
    const endX = Math.max(this._startClientX, this._currentClientX);
    const endY = Math.max(this._startClientY, this._currentClientY);

    // 드래그 임계값 미만이면 하이라이트를 갱신하지 않는다 (미리보기와 동일)
    if (endX - startX <= 1 && endY - startY <= 1) {
      this._clearInsertHighlight();
      return;
    }

    const target = this._resolveInsertContainer(startX, startY, endX, endY);

    if (this._insertHighlightTarget === target) return;

    if (this._insertHighlightTarget) {
      this._insertHighlightTarget.removeAttribute('reparent-target');
    }
    if (target) {
      target.setAttribute('reparent-target', '');
    }
    this._insertHighlightTarget = target;
  }

  /**
   * 삽입 하이라이트를 제거한다.
   * 드래그 종료(mouseup/ESC) 및 `_cleanup` 시 호출된다.
   */
  private _clearInsertHighlight(): void {
    if (this._insertHighlightTarget) {
      this._insertHighlightTarget.removeAttribute('reparent-target');
      this._insertHighlightTarget = null;
    }
  }

  /** 이벤트 리스너와 미리보기를 정리한다. */
  private _cleanup(): void {
    this._isDragging = false;
    this._startContainer = null;
    this._clearInsertHighlight();
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