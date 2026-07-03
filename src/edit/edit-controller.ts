import type { LayoutParagraphElement } from "@/components/paragraph.element";

export class EditController {
  private _paragraph: LayoutParagraphElement;

  constructor(paragraph: LayoutParagraphElement) {
    this._paragraph = paragraph;
  }

  destroy(): void {
    // Will be implemented in T9
  }

  postRender(): void {
    // Will be implemented in T9
  }
}