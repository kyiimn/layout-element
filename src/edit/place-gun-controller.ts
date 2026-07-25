import { EditManager } from "./edit-manager";
import { LayoutBoxElement } from "@/components/layout/box.element";
import { LayoutParagraphElement } from "@/components/layout/paragraph.element";
import { LayoutImageElement } from "@/components/layout/image.element";
import type { PlaceGunItem, ArticleContent, ImageContent } from "@/types/edit";

/**
 * Place Gun 클릭 배치를 관리하는 컨트롤러.
 *
 * `EditManager.placeGunActive`가 true일 때 box 요소의 `mousedown` 이벤트에서
 * `handleBoxMouseDown`이 호출되어, 장전된 맨 위 항목을 클릭한 box의 기존
 * paragraph/image 요소에 주입한다.
 *
 * 기사(text) 항목의 주입은 클릭한 box의 역할에 따라 3가지 케이스로 분기한다:
 * 1. 조상에 `role === 'group-article'`인 box가 있으면 그 그룹 내의
 *    `title`/`body` box에 각각 제목/본문을 주입한다.
 * 2. 클릭한 box의 role이 `title` 또는 `body`이면 그에 맞는 내용을 주입한다.
 * 3. 그 외는 본문을 주입한다.
 *
 * @example
 * ```ts
 * // EditManager가 관리 — 직접 생성하지 않음
 * manager.loadPlaceGun(items);
 * // → placeGunActive가 true가 되면 자동 attach
 * ```
 */
export class PlaceGunController {
  private _cursorApplied = false;

  /**
   * 문서 커서를 `copy`로 변경한다.
   */
  attach(): void {
    this._applyCursor(true);
  }

  /**
   * 커서를 복원한다.
   */
  detach(): void {
    this._applyCursor(false);
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

    const manager = EditManager.getInstance();
    if (!manager.placeGunActive) return false;

    const nextItem = manager.placeGunItems[0];
    if (!nextItem) return false;

    if (box.lock) return false;

    event.preventDefault();
    event.stopPropagation();

    const item = manager._consumePlaceGunItem();
    if (!item) return false;

    if (item.contentType === 'text') {
      this._injectArticle(box, item);
    } else {
      const imageTarget = this._findImageInBox(box);
      if (imageTarget) {
        this._injectImage(item, imageTarget);
      }
    }

    manager._suppressLayoutClick();
    return true;
  }

  /**
   * 기사 항목을 box에 주입한다.
   *
   * 3가지 케이스로 분기:
   * 1. 조상에 `group-article` box가 있으면 그 그룹 내의 title/body에 주입
   * 2. box의 role이 title/body이면 그에 맞는 내용 주입
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
    if (role === 'title' || role === 'body') {
      const paragraph = this._findParagraphInBox(box);
      if (!paragraph) return;
      const text = role === 'title' ? article.title : article.body;
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
   * group-article box 내의 title/body 하위 box에 데이터를 주입한다.
   *
   * group-article 내에서 `role === 'title'`인 box의 paragraph에 제목을,
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
    const bodyBox = this._findDescendantBoxByRole(groupArticle, 'body');

    if (titleBox) {
      const paragraph = this._findParagraphInBox(titleBox);
      if (paragraph) {
        this._injectText(paragraph, article.title);
        titleBox.contentUid = uid;
        titleBox.requestRerenderAffectedParagraphs();
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
    const data = paragraph.data;
    paragraph.data = { ...data, content: text };
    const model = paragraph.model;
    if (model) {
      model.textContent = text;
    }
    paragraph.markStructureChangedAndRender();
  }

  /**
   * image 요소에 이미지 URL을 주입한다.
   *
   * @param item - 이미지 항목
   * @param target - 주입 대상 image 요소
   */
  private _injectImage(item: PlaceGunItem, target: LayoutImageElement): void {
    const imageContent = item.content as ImageContent;
    const url = item.subType === 'ad'
      ? `/storage/ad/${imageContent.uid}?variant=work`
      : `/storage/image/${imageContent.uid}?variant=work`;
    target.url = url;
    const parentBox = target.parentElement instanceof LayoutBoxElement ? target.parentElement : null;
    parentBox?.requestRerenderAffectedParagraphs();
  }

  /**
   * Place Gun 활성 상태에 따라 문서 커서를 `copy`로 변경하거나 복원한다.
   *
   * @param active - 활성 여부
   */
  private _applyCursor(active: boolean): void {
    if (active === this._cursorApplied) return;
    document.querySelectorAll('x-layout-document').forEach((el) => {
      el.style.cursor = active ? 'copy' : '';
    });
    this._cursorApplied = active;
  }
}