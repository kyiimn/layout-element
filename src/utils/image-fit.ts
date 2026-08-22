import type { ImageObjectFit } from "@/types";

export type ImageFitRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ComputeObjectFitInput = {
  fit: ImageObjectFit;
  originalWidth: number;
  originalHeight: number;
  boxWidth: number;
  boxHeight: number;
};

/**
 * objectFit 프리셋을 표시 위치/크기(mm)로 변환한다.
 *
 * `LayoutImageElement`는 원본 이미지 전체를 `width`×`height`(mm) 크기로
 * 리사이즈하여 박스 내 `(x, y)`에 배치하고, 박스 밖은 캔버스 clip으로
 * 잘린다(= 크롭). 이 함수는 각 objectFit 프리셋에 대해 비율을 유지하면서
 * 박스를 채우거나 맞추는 `x`/`y`/`width`/`height`를 계산한다.
 *
 * @param input - {@link ComputeObjectFitInput}
 * @returns 표시 영역(mm). 입력이 무효(0 또는 음수)하면 빈 rect 반환.
 *
 * @example
 * ```ts
 * // cover: 원본 100×50mm, 박스 80×80mm
 * // imgAspect(2.0) > boxAspect(1.0) → 높이 기준, 좌우 크롭
 * // → { x: -60, y: 0, width: 160, height: 80 }
 * // (160mm 너비를 80mm 박스에 중앙 정렬 → 좌우 40mm씩 크롭)
 * ```
 */
export function computeObjectFitBrowser(input: ComputeObjectFitInput): ImageFitRect {
  const { fit, originalWidth, originalHeight, boxWidth, boxHeight } = input;

  if (originalWidth <= 0 || originalHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  if (fit === 'fill') {
    return { x: 0, y: 0, width: boxWidth, height: boxHeight };
  }

  const imgAspect = originalWidth / originalHeight;
  const boxAspect = boxWidth / boxHeight;

  if (fit === 'cover') {
    if (imgAspect > boxAspect) {
      const height = boxHeight;
      const width = boxHeight * imgAspect;
      return { x: (boxWidth - width) / 2, y: 0, width, height };
    }
    const width = boxWidth;
    const height = boxWidth / imgAspect;
    return { x: 0, y: (boxHeight - height) / 2, width, height };
  }

  if (fit === 'contain') {
    if (imgAspect > boxAspect) {
      const width = boxWidth;
      const height = boxWidth / imgAspect;
      return { x: 0, y: (boxHeight - height) / 2, width, height };
    }
    const height = boxHeight;
    const width = boxHeight * imgAspect;
    return { x: (boxWidth - width) / 2, y: 0, width, height };
  }

  return { x: 0, y: 0, width: originalWidth, height: originalHeight };
}