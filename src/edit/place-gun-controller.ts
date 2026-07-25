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
 * 클릭한 box에 매칭되는 paragraph/image 요소가 있으면 그 요소에
 * 항목의 데이터를 주입한다. 매칭되는 요소가 없으면 항목을 소비하지
 * 않고 no-op로 종료한다.
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
   * `LayoutBoxElement`의 `mousedown` 핸들러에서 `placeGunActive`일 때
   * 호출된다. box의 `contentType`이 항목의 contentType과 일치하면
   * 그 자식 요소에 데이터를 주입한다. 매칭되지 않으면 항목을 소비하지
   * 않고 no-op로 종료한다.
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

    const target = this._findTargetInBox(box, nextItem);
    if (!target) return false;

    event.preventDefault();
    event.stopPropagation();

    const item = manager._consumePlaceGunItem();
    if (!item) return false;

    this._injectItem(item, target);
    manager._suppressLayoutClick();
    return true;
  }

  /**
   * box 내에서 항목 contentType과 매칭되는 paragraph/image 자식 요소를 찾는다.
   *
   * @param box - 검색할 box 요소
   * @param item - 장전된 항목
   * @returns 매칭된 요소. 없으면 `null`.
   */
  private _findTargetInBox(
    box: LayoutBoxElement,
    item: PlaceGunItem,
  ): LayoutParagraphElement | LayoutImageElement | null {
    if (box.lock) return null;
    if (item.contentType === 'text' && box.contentType === 'paragraph') {
      return box.items.find(
        (child): child is LayoutParagraphElement => child instanceof LayoutParagraphElement,
      ) ?? null;
    }
    if (item.contentType === 'image' && box.contentType === 'image') {
      return box.items.find(
        (child): child is LayoutImageElement => child instanceof LayoutImageElement,
      ) ?? null;
    }
    return null;
  }

  /**
   * 항목의 데이터를 대상 요소에 주입한다.
   *
   * @param item - 주입할 항목
   * @param target - 주입 대상 요소
   */
  private _injectItem(
    item: PlaceGunItem,
    target: LayoutParagraphElement | LayoutImageElement,
  ): void {
    const parentBox = target.parentElement instanceof LayoutBoxElement ? target.parentElement : null;

    if (item.contentType === 'text' && target instanceof LayoutParagraphElement) {
      const articleContent = item.content as ArticleContent;
      const body = articleContent.body;
      const data = target.data;
      target.data = { ...data, content: body };
      const model = target.model;
      if (model) {
        model.textContent = body;
      }
      target.markStructureChangedAndRender();
      parentBox?.requestRerenderAffectedParagraphs();
      return;
    }
    if (item.contentType === 'image' && target instanceof LayoutImageElement) {
      const imageContent = item.content as ImageContent;
      const url = item.subType === 'ad'
        ? `/storage/ad/${imageContent.uid}?variant=work`
        : `/storage/image/${imageContent.uid}?variant=work`;
      target.url = url;
      parentBox?.requestRerenderAffectedParagraphs();
      return;
    }
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