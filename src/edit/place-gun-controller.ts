import { EditManager } from "./edit-manager";
import { LayoutBoxElement } from "@/components/layout/box.element";
import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import { LayoutImageElement } from "@/components/layout/image.element";
import { LayoutDocumentElement } from "@/components/layout/document.element";
import { LayoutTableCellElement } from "@/components/layout/td.element";
import { staticGridContains, clampStaticToContainer, clampAbsoluteToContainer } from "@/utils";
import { DEFAULT_IMAGE_DPI, Z_INDEX_INSERT_PREVIEW, Z_INDEX_ROLE_AD, Z_INDEX_ROLE_HEADER, Z_INDEX_MAX_LAYOUT } from "@/constants";
import type { PlaceGunItem, ArticleContent, ImageContent, ElementPatternContent, StylePatternContent } from "@/types/edit";
import type { BoxData } from "@/types/layout/box.type";

/**
 * Place Gun 클릭 배치를 관리하는 컨트롤러.
 *
 * `EditManager.placeGunActive`가 true일 때 box 요소의 `mousedown` 이벤트에서
 * `handleBoxMouseDown`이 호출되어, 장전된 맨 위 항목을 클릭한 box의 기존
 * paragraph/image 요소에 주입한다.
 *
 * 기사(text) 항목의 주입은 클릭한 box의 역할에 따라 3가지 케이스로 분기한다:
 * 1. 조상에 `role === 'group-article'`인 box가 있으면 그 그룹 내의
 *    `title`/`byline`/`body` box에 각각 제목/검별/본문을 주입한다.
 * 2. 클릭한 box의 role이 `title`/`byline`/`body`이면 그에 맞는 내용을 주입한다.
 * 3. 그 외는 본문을 주입한다.
 *
 * 이미지/광고(image) 항목의 주입도 동일한 패턴으로 3가지 케이스로 분기한다:
 * 1. 조상에 `role === 'group-image'`인 box가 있으면 그 그룹 내의
 *    `image`/`caption` box에 각각 이미지 URL/캡션을 주입한다.
 * 2. 클릭한 box의 role이 `image` 또는 `caption`이면 그에 맞는 내용을 주입한다.
 * 3. 그 외는 image 요소에 URL을, paragraph 요소에 캡션을 주입한다.
 *
 * @example
 * ```ts
 * // EditManager가 관리 — 직접 생성하지 않음
 * manager.loadPlaceGun(items);
 * // → placeGunActive가 true가 되면 자동 attach
 * ```
 */
export class PlaceGunController {
  private _manager: EditManager;
  private _cursorApplied = false;

  /**
   * element 패턴 배치 미리보기 박스.
   *
   * 다음으로 쏠 항목의 `contentType === 'element'`일 때만 표시된다.
   * mousemove 시 마우스 위치 + 패턴 boxData의 width/height로 점선 박스를 그린다.
   * detach, mousedown(배치), 항목 변경, 일시정지 시 제거된다.
   */
  private _previewEl: HTMLDivElement | null = null;

  /**
   * 현재 하이라이트 중인 컨테이너 요소.
   * `reparent-target` DOM 속성(주황색 테두리)으로 배치될 부모를 표시한다.
   * InsertController 삽입 하이라이트와 동일한 속성/CSS를 재사용한다.
   */
  private _highlightTarget: LayoutDocumentElement | LayoutBoxElement | LayoutTableCellElement | null = null;

  private _boundOnMouseMove: (event: MouseEvent) => void;

  /**
   * @param manager - 이 컨트롤러가 속한 EditManager 인스턴스
   */
  constructor(manager: EditManager) {
    this._manager = manager;
    this._boundOnMouseMove = this._onMouseMove.bind(this);
  }

  /**
   * 문서 커서를 `copy`로 변경하고 element 패턴 preview용 mousemove 리스너를 등록한다.
   */
  attach(): void {
    this._applyCursor(true);
    document.addEventListener('mousemove', this._boundOnMouseMove);
  }

  /**
   * 커서를 복원하고 preview를 제거하며 mousemove 리스너를 해제한다.
   */
  detach(): void {
    this._applyCursor(false);
    this._removePreview();
    this._clearHighlight();
    document.removeEventListener('mousemove', this._boundOnMouseMove);
  }

  /**
   * document 빈 공간의 mousedown 이벤트를 처리하여 element 패턴 항목을 주입한다.
   *
   * element 항목만 처리하며, 다른 contentType은 무시한다.
   * 클릭 위치를 document 내부 mm 좌표로 변환하여 새 box를 생성한다.
   *
   * @param doc - mousedown이 발생한 document 요소
   * @param event - mousedown 이벤트
   * @returns 주입 성공 여부
   */
  handleDocumentMouseDown(doc: LayoutDocumentElement, event: MouseEvent): boolean {
    if (event.button !== 0) return false;

    const manager = this._manager;
    if (!manager.placeGunActive) return false;

    const nextItem = manager.placeGunItems[0];
    if (!nextItem) return false;

    if (nextItem.contentType !== 'element') return false;

    event.preventDefault();
    event.stopPropagation();

    this._removePreview();
    this._clearHighlight();

    manager._dispatchPlaceGunBefore(nextItem, doc);

    const item = manager._consumePlaceGunItem();
    if (!item) return false;

    this._injectElementPattern(item, event);

    manager._dispatchPlaceGunAfter(item, doc, true);

    manager._suppressLayoutClick();
    return true;
  }

  /**
   * box의 mousedown 이벤트를 처리하여 Place Gun 항목을 주입한다.
   *
   * @param box - mousedown이 발생한 box 요소
   * @param event - mousedown 이벤트
   * @returns 주입 성공 여부. 매칭 실패 시 `false`.
   */
  handleBoxMouseDown(box: LayoutBoxElement, event: MouseEvent): boolean {
    if (event.button !== 0) return false;

    const manager = this._manager;
    if (!manager.placeGunActive) return false;

    const nextItem = manager.placeGunItems[0];
    if (!nextItem) return false;

    if (box.lock) return false;

    event.preventDefault();
    event.stopPropagation();

    this._removePreview();
    this._clearHighlight();

    manager._dispatchPlaceGunBefore(nextItem, box);

    const item = manager._consumePlaceGunItem();
    if (!item) return false;

    if (item.contentType === 'text') {
      this._injectArticle(box, item);
    } else if (item.contentType === 'element') {
      this._injectElementPattern(item, event);
    } else if (item.contentType === 'style') {
      const paragraph = this._findParagraphInBox(box);
      if (!paragraph) {
        manager._dispatchPlaceGunAfter(item, box, false);
        manager._suppressLayoutClick();
        return false;
      }
      this._injectStylePattern(box, item);
    } else {
      this._injectImageOrAd(box, item);
    }

    manager._dispatchPlaceGunAfter(item, box, true);

    manager._suppressLayoutClick();
    return true;
  }

  /**
   * 기사 항목을 box에 주입한다.
   *
   * 3가지 케이스로 분기:
   * 1. 조상에 `group-article` box가 있으면 그 그룹 내의 title/byline/body에 주입
   * 2. box의 role이 title/byline/body이면 그에 맞는 내용 주입
   * 3. 그 외는 본문을 paragraph에 주입
   *
   * @param box - 클릭한 box 요소
   * @param item - 기사 항목
   */
  private _injectArticle(box: LayoutBoxElement, item: PlaceGunItem): void {
    const article = item.content as ArticleContent;
    const uid = article.uid;

    const groupArticle = this._findAncestorByRole(box, 'group-article');
    if (groupArticle) {
      this._injectIntoGroupArticle(groupArticle, article, uid);
      return;
    }

    const role = box.role;
    if (role === 'title' || role === 'byline' || role === 'body') {
      const paragraph = this._findParagraphInBox(box);
      if (!paragraph) return;
      const text = role === 'title' ? article.title : role === 'byline' ? article.byline : article.body;
      this._injectText(paragraph, text);
      box.contentUid = uid;
      box.requestRerenderAffectedParagraphs();
      return;
    }

    const paragraph = this._findParagraphInBox(box);
    if (!paragraph) return;
    this._injectText(paragraph, article.body);
    box.contentUid = uid;
    box.requestRerenderAffectedParagraphs();
  }

  /**
   * group-article box 내의 title/byline/body 하위 box에 데이터를 주입한다.
   *
   * group-article 내에서 `role === 'title'`인 box의 paragraph에 제목을,
   * `role === 'byline'`인 box의 paragraph에 검별을,
   * `role === 'body'`인 box의 paragraph에 본문을 주입한다.
   * 각 box의 contentUid에 기사 UID를 저장하고, group-article의
   * groupMember에 기사 UID를 추가한다.
   *
   * @param groupArticle - group-article role의 box
   * @param article - 기사 content 객체
   * @param uid - 기사 UID
   */
  private _injectIntoGroupArticle(
    groupArticle: LayoutBoxElement,
    article: ArticleContent,
    uid: string,
  ): void {
    const titleBox = this._findDescendantBoxByRole(groupArticle, 'title');
    const bylineBox = this._findDescendantBoxByRole(groupArticle, 'byline');
    const bodyBox = this._findDescendantBoxByRole(groupArticle, 'body');

    if (titleBox) {
      const paragraph = this._findParagraphInBox(titleBox);
      if (paragraph) {
        this._injectText(paragraph, article.title);
        titleBox.contentUid = uid;
        titleBox.requestRerenderAffectedParagraphs();
      }
    }

    if (bylineBox) {
      const paragraph = this._findParagraphInBox(bylineBox);
      if (paragraph) {
        this._injectText(paragraph, article.byline);
        bylineBox.contentUid = uid;
        bylineBox.requestRerenderAffectedParagraphs();
      }
    }

    if (bodyBox) {
      const paragraph = this._findParagraphInBox(bodyBox);
      if (paragraph) {
        this._injectText(paragraph, article.body);
        bodyBox.contentUid = uid;
        bodyBox.requestRerenderAffectedParagraphs();
      }
    }

    const members = groupArticle.groupMember;
    if (!members.includes(uid)) {
      groupArticle.groupMember = [...members, uid];
    }
  }

  /**
   * box의 조상 중 지정된 role을 가진 가장 가까운 box를 찾는다.
   *
   * @param box - 탐색 시작 box
   * @param role - 찾을 role
   * @returns 매칭된 조상 box. 없으면 `null`.
   */
  private _findAncestorByRole(box: LayoutBoxElement, role: string): LayoutBoxElement | null {
    let current: Element | null = box.parentElement;
    while (current) {
      if (current instanceof LayoutBoxElement && current.role === role) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  /**
   * box의 자손 중 지정된 role을 가진 첫 번째 box를 찾는다.
   *
   * @param box - 탐색 시작 box
   * @param role - 찾을 role
   * @returns 매칭된 자손 box. 없으면 `null`.
   */
  private _findDescendantBoxByRole(box: LayoutBoxElement, role: string): LayoutBoxElement | null {
    const found = box.querySelector<LayoutBoxElement>(`x-layout-box[role="${role}"]`);
    return found ?? null;
  }

  /**
   * box 내의 첫 번째 paragraph 자식 요소를 찾는다.
   *
   * 중첩 box인 경우 `contentType`이 'paragraph'이면 그 내부 paragraph를 반환하고,
   * 직접 paragraph 자식이 있으면 그것을 반환한다.
   *
   * @param box - 검색할 box
   * @returns paragraph 요소. 없으면 `null`.
   */
  private _findParagraphInBox(box: LayoutBoxElement): LayoutParagraphElement | null {
    if (box.contentType === 'paragraph') {
      return box.items.find(
        (child): child is LayoutParagraphElement => child instanceof LayoutParagraphElement,
      ) ?? null;
    }
    return box.querySelector<LayoutParagraphElement>('x-layout-paragraph');
  }

  /**
   * box 내의 첫 번째 image 자식 요소를 찾는다.
   *
   * @param box - 검색할 box
   * @returns image 요소. 없으면 `null`.
   */
  private _findImageInBox(box: LayoutBoxElement): LayoutImageElement | null {
    if (box.contentType === 'image') {
      return box.items.find(
        (child): child is LayoutImageElement => child instanceof LayoutImageElement,
      ) ?? null;
    }
    return box.querySelector<LayoutImageElement>('x-layout-image');
  }

  /**
   * paragraph에 텍스트를 주입한다.
   *
   * `paragraph.data` setter로 content를 설정하고, model이 있으면
   * `model.textContent`를 직접 갱신한 후 `markStructureChangedAndRender()`로
   * 재렌더링한다.
   *
   * @param paragraph - 주입 대상 paragraph
   * @param text - 주입할 텍스트
   */
  private _injectText(paragraph: LayoutParagraphElement, text: string): void {
    paragraph.content = text;
    this._manager.notifyTextChange(paragraph);
  }

  /**
   * image 요소에 이미지 데이터를 주입한다.
   *
   * 원본 이미지의 픽셀 크기를 dpi로 mm 변환하여 `originalWidth`/`originalHeight`
   * (mm)로 설정하고 `objectFit: 'cover'`로 지정한다. `x`/`y`/`width`/`height`는
   * `LayoutImageElement`의 `data` setter가 `objectFit` + 박스 크기로 자동 계산한다.
   *
   * @param imageEl - 주입 대상 image 요소
   * @param image - 이미지 content 객체 (px 단위 width/height/dpi 포함)
   * @param box - image 요소를 포함하는 box
   */
  private _applyImageToElement(
    imageEl: LayoutImageElement,
    image: ImageContent,
    box: LayoutBoxElement,
  ): void {
    void box;
    const data = imageEl.data;
    const dpi = image.dpi || data.dpi || DEFAULT_IMAGE_DPI;
    const origWidthMm = (image.width / dpi) * 25.4;
    const origHeightMm = (image.height / dpi) * 25.4;

    imageEl.data = {
      ...data,
      x: undefined,
      y: undefined,
      width: undefined,
      height: undefined,
      dpi,
      url: image.url,
      originalWidth: origWidthMm,
      originalHeight: origHeightMm,
      objectFit: 'cover',
    };
    void imageEl.render();
  }

  /**
   * 이미지/광고 항목을 box에 주입한다.
   *
   * 3가지 케이스로 분기:
   * 1. 조상에 `group-image` box가 있으면 그 그룹 내의 image/caption에 주입
   * 2. box의 role이 image/caption이면 그에 맞는 내용 주입
   * 3. 그 외는 image 요소에 URL, paragraph 요소에 캡션을 주입
   *
   * @param box - 클릭한 box 요소
   * @param item - 이미지/광고 항목
   */
  private _injectImageOrAd(box: LayoutBoxElement, item: PlaceGunItem): void {
    const image = item.content as ImageContent;
    const uid = image.uid;

    const groupImage = this._findAncestorByRole(box, 'group-image');
    if (groupImage) {
      this._injectIntoGroupImage(groupImage, image, uid);
      return;
    }

    const role = box.role;
    if (role === 'image') {
      const imageEl = this._findImageInBox(box);
      if (!imageEl) return;
      this._applyImageToElement(imageEl, image, box);
      box.contentUid = uid;
      box.requestRerenderAffectedParagraphs();
      return;
    }
    if (role === 'caption') {
      const paragraph = this._findParagraphInBox(box);
      if (!paragraph) return;
      this._injectText(paragraph, image.caption);
      box.contentUid = uid;
      box.requestRerenderAffectedParagraphs();
      return;
    }

    const imageEl = this._findImageInBox(box);
    if (imageEl) {
      this._applyImageToElement(imageEl, image, box);
      box.contentUid = uid;
      box.requestRerenderAffectedParagraphs();
      return;
    }

    const paragraph = this._findParagraphInBox(box);
    if (paragraph) {
      this._injectText(paragraph, image.caption);
      box.contentUid = uid;
      box.requestRerenderAffectedParagraphs();
    }
  }

  /**
   * group-image box 내의 image/caption 하위 box에 데이터를 주입한다.
   *
   * group-image 내에서 `role === 'image'`인 box의 image 요소에 URL을,
   * `role === 'caption'`인 box의 paragraph에 캡션을 주입한다.
   * 각 box의 contentUid에 UID를 저장하고, group-image의
   * groupMember에 UID를 추가한다.
   *
   * @param groupImage - group-image role의 box
   * @param image - 이미지 content 객체
   * @param uid - 이미지/광고 UID
   * @param url - 이미지/광고 URL
   */
  private _injectIntoGroupImage(
    groupImage: LayoutBoxElement,
    image: ImageContent,
    uid: string,
  ): void {
    const imageBox = this._findDescendantBoxByRole(groupImage, 'image');
    const captionBox = this._findDescendantBoxByRole(groupImage, 'caption');

    if (imageBox) {
      const imageEl = this._findImageInBox(imageBox);
      if (imageEl) {
        this._applyImageToElement(imageEl, image, imageBox);
        imageBox.contentUid = uid;
        imageBox.requestRerenderAffectedParagraphs();
      }
    }

    if (captionBox) {
      const paragraph = this._findParagraphInBox(captionBox);
      if (paragraph) {
        this._injectText(paragraph, image.caption);
        captionBox.contentUid = uid;
        captionBox.requestRerenderAffectedParagraphs();
      }
    }

    const members = groupImage.groupMember;
    if (!members.includes(uid)) {
      groupImage.groupMember = [...members, uid];
    }
  }

  /**
   * 클릭 위치에서 요소 패턴을 주입할 컨테이너를 찾는다.
   *
   * `elementsFromPoint`로 클릭 위치의 요소 목록을 가져와,
   * box-only 컨테이너(비-box 자식이 없는 box)를 찾는다.
   * 찾지 못하면 document로 폴백한다.
   *
   * `editableRootId`가 설정된 경우 root box 내부의 box만 허용한다.
   *
   * static 모드에서는 추가로, 클릭 좌표 + 패턴 크기(width 컬럼 스팬, height 라인 수)로
   * 계산한 요소 영역이 후보 box의 컬럼/라인 그리드 안에 완전히 들어오는지 검증한다.
   * 벗어나면 더 바깥 컨테이너로 폴백한다.
   *
   * @param clientX - 클릭 X 좌표
   * @param clientY - 클릭 Y 좌표
   * @param position - 패턴 배치 모드 (`'static'` 또는 `'absolute'`)
   * @param patternWidth - 패턴의 width (static: 컬럼 스팬 수, absolute: mm)
   * @param patternHeight - 패턴의 height (static: 라인 수, absolute: mm)
   * @returns 주입 컨테이너 (box 또는 document)
   */
  private _findPatternContainer(
    clientX: number,
    clientY: number,
    position: 'static' | 'absolute',
    patternWidth: number,
    patternHeight: number,
  ): LayoutDocumentElement | LayoutBoxElement | LayoutTableCellElement | null {
    const manager = this._manager;
    const rootId = manager.editableRootId;
    const rootBox = rootId
      ? manager.docEl.querySelector(`#${CSS.escape(rootId)}`) as LayoutBoxElement | null
      : null;

    const elements = document.elementsFromPoint(clientX, clientY);
    for (const el of elements) {
      if (el instanceof LayoutTableCellElement) {
        if (position === 'static' && el.items.length > 0) continue;
        if (rootBox && !rootBox.contains(el)) continue;
        if (position === 'static') {
          const model = el.model;
          const colCount = model?.columnCount ?? 1;
          const lineCount = model?.contentHeight && model.lineHeight
            ? Math.floor(model.contentHeight / model.lineHeight) + 1
            : patternHeight;
          const span = Math.max(1, Math.min(patternWidth, colCount));
          if (patternHeight > lineCount) continue;
          const { left: leftMm, top: topMm } = this._screenToContainerMm(clientX, clientY, el);
          const staticCoords = this._mmToStatic(leftMm, topMm, el);
          if (!staticGridContains(el, staticCoords.left, staticCoords.top, span, patternHeight)) {
            continue;
          }
        }
        return el;
      }
      if (el instanceof LayoutBoxElement) {
        if (el.lock) continue;
        const hasNonBoxChild = el.items.some(item => item.type !== 'box');
        if (hasNonBoxChild) continue;
        if (el.contentType === 'table') continue;
        if (rootBox && !rootBox.contains(el)) continue;

        if (position === 'static') {
          const { left: leftMm, top: topMm } = this._screenToContainerMm(clientX, clientY, el);
          const staticCoords = this._mmToStatic(leftMm, topMm, el);
          const span = Math.max(1, Math.min(patternWidth, el.model?.columnCount ?? 1));
          if (!staticGridContains(el, staticCoords.left, staticCoords.top, span, patternHeight)) {
            continue;
          }
        }
        return el;
      }
      if (el instanceof LayoutDocumentElement) {
        break;
      }
    }

    if (rootBox && !rootBox.lock) {
      return rootBox;
    }
    return manager.docEl;
  }

  /**
   * 화면 좌표를 컨테이너 내부 mm 좌표로 변환한다.
   *
   * 컨테이너의 padding을 고려하여 편집 영역 기준 좌표를 반환한다.
   *
   * @param clientX - 화면 X 좌표
   * @param clientY - 화면 Y 좌표
   * @param container - 주입 대상 컨테이너
   * @returns 컨테이너 편집 영역 기준 (left, top) mm 좌표
   */
  private _screenToContainerMm(
    clientX: number,
    clientY: number,
    container: LayoutDocumentElement | LayoutBoxElement | LayoutTableCellElement,
  ): { left: number; top: number } {
    const rect = container.getBoundingClientRect();
    const manager = this._manager;

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

  /**
   * mm 좌표를 static 그리드 좌표(컬럼 인덱스, 줄 수)로 변환한다.
   *
   * 컨테이너의 GridCalculator에서 컬럼 좌표와 lineHeight를 가져와 계산한다.
   *
   * @param leftMm - 컨테이너 편집 영역 기준 X mm 좌표
   * @param topMm - 컨테이너 편집 영역 기준 Y mm 좌표
   * @param container - 주입 대상 컨테이너
   * @returns { left: 컬럼 인덱스, top: 줄 수 }
   */
  private _mmToStatic(
    leftMm: number,
    topMm: number,
    container: LayoutDocumentElement | LayoutBoxElement | LayoutTableCellElement,
  ): { left: number; top: number } {
    const model = container.model;
    if (!model) return { left: 0, top: 0 };

    const { columnCoords, lineHeight, editableWidth, columnCount } = model;
    const avgColWidth = editableWidth / columnCount;

    const editAreaLeft = columnCoords[0]?.x1 ?? 0;
    const editAreaTop = columnCoords[0]?.y1 ?? 0;

    const nearestColumn = Math.round((leftMm - editAreaLeft) / avgColWidth);
    const nearestLine = Math.round((topMm - editAreaTop) / lineHeight);

    return { left: nearestColumn, top: nearestLine };
  }

  /**
   * 요소 패턴을 클릭 위치에 주입한다.
   *
   * `_findPatternContainer`로 컨테이너를 찾고, position에 따라 좌표를 계산한다:
   * - absolute: 클릭 위치를 컨테이너 내부 mm 좌표로 변환
   * - static: `_mmToStatic`으로 컬럼 인덱스와 줄 수 계산
   *
   * @param item - 요소 패턴 항목
   * @param event - mousedown 이벤트
   */
  private _injectElementPattern(item: PlaceGunItem, event: MouseEvent): void {
    const content = item.content as ElementPatternContent;
    const { boxData, position } = content;

    const container = this._findPatternContainer(event.clientX, event.clientY, position, boxData.width, boxData.height);
    if (!container) return;

    const { left: leftMm, top: topMm } = this._screenToContainerMm(event.clientX, event.clientY, container);

    let left: number;
    let top: number;
    let width = boxData.width;
    let height = boxData.height;
    if (position === 'absolute') {
      const clamped = clampAbsoluteToContainer(container, leftMm, topMm, width, height);
      left = clamped.left;
      top = clamped.top;
      width = clamped.width;
      height = clamped.height;
    } else if (container instanceof LayoutTableCellElement) {
      left = 0;
      top = 0;
      width = 1;
      height = 1;
    } else {
      const result = this._mmToStatic(leftMm, topMm, container);
      const clamped = clampStaticToContainer(container, result.left, result.top, width, height);
      left = clamped.left;
      top = clamped.top;
      width = clamped.width;
      height = clamped.height;
    }

    const zIndex = this._getNextZIndex(container);

    const newBoxData: BoxData = {
      ...boxData,
      left,
      top,
      width,
      height,
      zIndex,
    };

    const newBoxEl = document.createElement('x-layout-box') as LayoutBoxElement;
    newBoxEl.data = newBoxData;
    container.appendChild(newBoxEl);
    newBoxEl.requestRerenderAffectedParagraphs();

    this._manager._dispatchLayoutAdd({
      element: newBoxEl,
      container,
      source: 'insert',
    });
  }

  /**
   * 스타일 패턴을 클릭한 paragraph에 주입한다.
   *
   * 클릭한 box 내의 paragraph를 찾아 textStyle/paragraphStyle을 덮어쓴다.
   *
   * @param box - 클릭한 box 요소
   * @param item - 스타일 패턴 항목
   */
  private _injectStylePattern(box: LayoutBoxElement, item: PlaceGunItem): void {
    const content = item.content as StylePatternContent;
    const paragraph = this._findParagraphInBox(box);
    if (!paragraph) return;

    const data = paragraph.data;
    paragraph.data = {
      ...data,
      textStyle: { ...data.textStyle, ...content.textStyle },
      paragraphStyle: { ...data.paragraphStyle, ...content.paragraphStyle },
    };
    paragraph.markStructureChangedAndRender();
    this._manager.notifyTextChange(paragraph);
  }

  /**
   * 컨테이너 내 자식 요소들의 최대 zIndex + 1을 반환한다.
   *
   * role 고정 zIndex(ad/header)는 제외하고 계산한다.
   *
   * @param container - 주입 대상 컨테이너
   * @returns 새 box의 zIndex
   */
  private _getNextZIndex(container: LayoutDocumentElement | LayoutBoxElement | LayoutTableCellElement): number {
    const items = container.items;
    if (items.length === 0) return 1;
    const maxZ = Math.max(...items.map(i => {
      const z = i.zIndex ?? 0;
      if (z === Z_INDEX_ROLE_AD || z === Z_INDEX_ROLE_HEADER) return 0;
      return z;
    }));
    return Math.min(maxZ + 1, Z_INDEX_MAX_LAYOUT);
  }

  /**
   * mousemove 이벤트 핸들러.
   *
   * 다음으로 쏠 항목이 `contentType === 'element'`일 때만 preview를 갱신한다.
   * 항목이 없거나 element가 아니면 preview를 제거한다.
   *
   * @param event - mousemove 이벤트
   */
  private _onMouseMove(event: MouseEvent): void {
    const manager = this._manager;
    if (!manager.placeGunActive) {
      this._removePreview();
      this._clearHighlight();
      return;
    }

    const nextItem = manager.placeGunItems[0];
    if (!nextItem || nextItem.contentType !== 'element') {
      this._removePreview();
      this._clearHighlight();
      return;
    }

    const docRect = manager.docEl.getBoundingClientRect();
    if (
      event.clientX < docRect.left ||
      event.clientX > docRect.right ||
      event.clientY < docRect.top ||
      event.clientY > docRect.bottom
    ) {
      this._removePreview();
      this._clearHighlight();
      return;
    }

    const content = nextItem.content as ElementPatternContent;
    const { boxData, position } = content;

    const container = this._findPatternContainer(event.clientX, event.clientY, position, boxData.width, boxData.height);
    if (!container) {
      this._removePreview();
      this._clearHighlight();
      return;
    }

    this._updateHighlight(container);
    this._updatePreview(event.clientX, event.clientY, position, boxData);
  }

  /**
   * 미리보기 점선 박스 DOM 요소를 생성한다.
   *
   * InsertController의 `_createPreview`와 동일한 스타일(`2px dashed #1a73e8`,
   * `rgba(26, 115, 232, 0.1)` 배경)을 사용하여 시각적 일관성을 유지한다.
   *
   * @returns 생성된 미리보기 div 요소
   */
  private _createPreview(): HTMLDivElement {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.border = '2px dashed #1a73e8';
    el.style.backgroundColor = 'rgba(26, 115, 232, 0.1)';
    el.style.pointerEvents = 'none';
    el.style.zIndex = String(Z_INDEX_INSERT_PREVIEW);
    el.style.display = 'none';
    document.body.appendChild(el);
    return el;
  }

  /**
   * 미리보기 사각형을 제거한다.
   */
  private _removePreview(): void {
    if (this._previewEl) {
      this._previewEl.remove();
      this._previewEl = null;
    }
  }

  /**
   * 배치될 부모 컨테이너를 `reparent-target` 속성으로 하이라이트한다.
   * 이전 하이라이트 대상과 다르면 이전 속성을 제거하고 새 컨테이너에 설정한다.
   *
   * @param target - 하이라이트할 컨테이너 (box, document 또는 TD)
   */
  private _updateHighlight(target: LayoutDocumentElement | LayoutBoxElement | LayoutTableCellElement): void {
    if (this._highlightTarget === target) return;
    this._clearHighlight();
    target.setAttribute('reparent-target', '');
    this._highlightTarget = target;
  }

  /**
   * 컨테이너 하이라이트를 제거한다.
   */
  private _clearHighlight(): void {
    if (this._highlightTarget) {
      this._highlightTarget.removeAttribute('reparent-target');
      this._highlightTarget = null;
    }
  }

  /**
   * 미리보기 박스의 화면 위치와 크기를 계산하여 갱신한다.
   *
   * position 분기:
   * - `absolute`: 마우스 위치를 컨테이너 mm 좌표로 변환 → ppm으로 화면 px 변환.
   *   박스 좌상단을 마우스 위치로, 크기는 boxData.width/height(mm)를 ppm으로 변환.
   * - `static`: `_mmToStatic`으로 컬럼 인덱스/줄 수를 구하고,
   *   컬럼 span × 컬럼 너비, 줄 수 × lineHeight로 화면 px 크기 계산.
   *
   * @param clientX - 마우스 화면 X 좌표 (px)
   * @param clientY - 마우스 화면 Y 좌표 (px)
   * @param container - 배치 대상 컨테이너
   * @param position - 패턴 배치 모드 ('static' | 'absolute')
   * @param boxData - 패턴 BoxData (width/height 사용)
   */
  private _updatePreview(
    clientX: number,
    clientY: number,
    position: 'static' | 'absolute',
    boxData: BoxData,
  ): void {
    if (!this._previewEl) {
      this._previewEl = this._createPreview();
    }

    const manager = this._manager;
    const rootId = manager.editableRootId;
    const rootEl = rootId
      ? manager.docEl.querySelector(`#${CSS.escape(rootId)}`) as LayoutBoxElement | null
      : null;
    const root = (rootEl && !rootEl.lock) ? rootEl : manager.docEl;
    const rect = root.getBoundingClientRect();
    const screenPpm = manager.docEl.ppm * manager.scale;

    const cx = Math.max(rect.left, Math.min(clientX, rect.right));
    const cy = Math.max(rect.top, Math.min(clientY, rect.bottom));

    let rootPaddingLeft = 0;
    let rootPaddingTop = 0;
    if (root instanceof LayoutBoxElement) {
      rootPaddingLeft = root.paddingLeft ?? 0;
      rootPaddingTop = root.paddingTop ?? 0;
    }

    if (position === 'absolute') {
      const leftMm = Math.max(0, manager.screenPxToMm(cx - rect.left) - rootPaddingLeft);
      const topMm = Math.max(0, manager.screenPxToMm(cy - rect.top) - rootPaddingTop);

      const leftPx = rect.left + (leftMm + rootPaddingLeft) * screenPpm;
      const topPx = rect.top + (topMm + rootPaddingTop) * screenPpm;
      const widthPx = boxData.width * screenPpm;
      const heightPx = boxData.height * screenPpm;

      this._previewEl.style.left = `${Math.round(leftPx)}px`;
      this._previewEl.style.top = `${Math.round(topPx)}px`;
      this._previewEl.style.width = `${Math.round(widthPx)}px`;
      this._previewEl.style.height = `${Math.round(heightPx)}px`;
      this._previewEl.style.display = 'block';
      return;
    }

    const model = root.model;
    if (!model) {
      this._previewEl.style.display = 'none';
      return;
    }

    const leftMm = Math.max(0, manager.screenPxToMm(cx - rect.left) - rootPaddingLeft);
    const topMm = Math.max(0, manager.screenPxToMm(cy - rect.top) - rootPaddingTop);

    const { columnCoords, lineHeight, editableWidth, columnCount } = model;
    const avgColWidth = editableWidth / columnCount;
    const editAreaLeftMm = columnCoords[0]?.x1 ?? 0;
    const editAreaTopMm = columnCoords[0]?.y1 ?? 0;

    const nearestColumn = Math.round((leftMm - editAreaLeftMm) / avgColWidth);
    const nearestLine = Math.round((topMm - editAreaTopMm) / lineHeight);
    const span = Math.max(1, Math.min(boxData.width, columnCount));

    const containerLineCount = lineHeight > 0
      ? Math.floor(Math.round((model.editableHeight / lineHeight) * 1e6) / 1e6) + 1
      : 0;
    const clampedLine = Math.max(0, Math.min(Math.max(0, containerLineCount - boxData.height), nearestLine));

    const startCol = Math.max(0, Math.min(nearestColumn, columnCount - span));
    const endCol = Math.min(columnCount - 1, startCol + span - 1);
    const snapLeftMm = columnCoords[startCol]?.x1 ?? 0;
    const snapRightMm = columnCoords[endCol]?.x2 ?? 0;

    const leftPx = rect.left + (snapLeftMm + rootPaddingLeft) * screenPpm;
    const topPx = rect.top + (editAreaTopMm + rootPaddingTop + clampedLine * lineHeight) * screenPpm;
    const widthPx = (snapRightMm - snapLeftMm) * screenPpm;
    const heightPx = boxData.height * lineHeight * screenPpm;

    this._previewEl.style.left = `${Math.round(leftPx)}px`;
    this._previewEl.style.top = `${Math.round(topPx)}px`;
    this._previewEl.style.width = `${Math.round(widthPx)}px`;
    this._previewEl.style.height = `${Math.round(heightPx)}px`;
    this._previewEl.style.display = 'block';
  }

  /**
   * Place Gun 활성 상태에 따라 이 컨트롤러가 관리하는 문서의 커서를 `copy`로 변경하거나 복원한다.
   *
   * @param active - 활성 여부
   */
  private _applyCursor(active: boolean): void {
    if (active === this._cursorApplied) return;
    // EditManager는 per-document 인스턴스이므로 자신이 관리하는 문서 요소만 변경한다.
    this._manager.docEl.style.cursor = active ? 'copy' : '';
    this._cursorApplied = active;
  }
}