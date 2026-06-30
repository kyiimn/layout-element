import { LayoutBoxElement, LayoutImageElement } from "@/components";

export const checkOverlap = (baseElement: HTMLElement, targetElement: HTMLElement) => {
  const r1 = baseElement.getBoundingClientRect();
  const r2 = targetElement.getBoundingClientRect();

  const isIntersceting = (
    r1.right > r2.left &&
    r1.left < r2.right &&
    r1.bottom > r2.top &&
    r1.top < r2.bottom
  );
  return isIntersceting;
}

export const getOverlapSizePX = (baseElement: HTMLElement, targetElement: HTMLElement): {
  direction: "NONE" | "COVERS" | "LEFT" | "RIGHT", width: number;
} => {
  const r1 = baseElement.getBoundingClientRect();
  const r2 = targetElement.getBoundingClientRect();
  if (r1.bottom <= r2.top || r1.top >= r2.bottom) {
    return { direction: 'NONE', width: 0 };
  }

  const intersectionStart = Math.max(r1.left, r2.left);
  const intersectionEnd = Math.min(r1.right, r2.right);
  const rawOverlapWidth = intersectionEnd - intersectionStart;
  if (rawOverlapWidth <= 0) {
    return { direction: 'NONE', width: 0 };
  }

  const center1 = r1.left + (r1.width / 2);
  const center2 = r2.left + (r2.width / 2);
  if (r2.left <= r1.left && r2.right >= r1.right) {
    return { direction: 'COVERS', width: rawOverlapWidth };
  }

  let direction: "RIGHT" | "LEFT" = (center2 > center1) ? "RIGHT" : "LEFT";
  if ((targetElement as LayoutBoxElement).contentType === 'image') {
    const imageEl = (targetElement as LayoutBoxElement).items[0] as LayoutImageElement;
    if (imageEl.canvas) {
      const canvas = imageEl.canvas;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        const scaleX = canvas.width / r2.width;
        const scaleY = canvas.height / r2.height;

        const relativeX = intersectionStart - r2.left;
        const relativeY = Math.max(r1.top, r2.top) - r2.top; // 수직 겹침 시작점
        const relativeHeight = Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top);

        // 정수 좌표로 변환 (픽셀 데이터 접근을 위해)
        const sx = Math.floor(relativeX * scaleX);
        const sy = Math.floor(relativeY * scaleY);
        const sw = Math.ceil(rawOverlapWidth * scaleX);
        const sh = Math.ceil(relativeHeight * scaleY);

        // 캔버스 범위를 벗어나지 않도록 클램핑
        if (sw <= 0 || sh <= 0) return { direction: "NONE", width: 0 };

        try {
          // 겹치는 영역의 픽셀 데이터 추출
          const imageData = ctx.getImageData(sx, sy, sw, sh);
          const pixels = imageData.data;
          const width = imageData.width;
          const height = imageData.height;

          let minX = width; // 불투명 픽셀 중 가장 왼쪽 X (Target이 Right일 때 사용)
          let maxX = -1;    // 불투명 픽셀 중 가장 오른쪽 X (Target이 Left일 때 사용)
          let foundPixel = false;

          // 픽셀 순회 (알파값 확인)
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const alphaIndex = (y * width + x) * 4 + 3; // R, G, B, A 중 Alpha 위치
              if (pixels[alphaIndex] > 0) { // 투명하지 않음 (Threshold 조절 가능, 예: > 10)
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                foundPixel = true;
              }
            }
          }

          if (!foundPixel) return { direction: "NONE", width: 0 };

          let pixelOverlapWidth = 0;
          if (direction === "LEFT") {
            pixelOverlapWidth = (maxX + 1) / scaleX;
          } else if (direction === "RIGHT") {
            const emptyLeftSpace = minX / scaleX;
            pixelOverlapWidth = rawOverlapWidth - emptyLeftSpace;
          }
          return { direction, width: pixelOverlapWidth };
        } catch (e) { }
      }
    }
  }
  return { direction, width: rawOverlapWidth };
}