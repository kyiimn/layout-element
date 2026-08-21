/**
 * object-fit 계산 순수 함수.
 *
 * 원본 이미지 크기(mm)와 표시 영역(mm)을 받아, objectFit 프리셋에 따라
 * 표시 영역 내 이미지의 실제 배치 좌표(x, y, width, height)를 계산한다.
 *
 * @file src/engine/object-fit-engine.ts
 */

import type { ImageObjectFit } from "@/types";

/**
 * object-fit 계산 결과 rect (mm 단위, 표시 영역 내 상대 좌표).
 */
export interface ObjectFitRect {
  /** 표시 영역 내 X 오프셋 (mm). 음수면 왼쪽으로 치워져 크롭됨. */
  x: number;
  /** 표시 영역 내 Y 오프셋 (mm). 음수면 위쪽으로 치워져 크롭됨. */
  y: number;
  /** 표시 너비 (mm). 표시 영역보다 크면 초과분 크롭됨. */
  width: number;
  /** 표시 높이 (mm). 표시 영역보다 크면 초과분 크롭됨. */
  height: number;
}

/**
 * object-fit 계산 입력.
 */
export interface ObjectFitInput {
  /** objectFit 프리셋 */
  fit: ImageObjectFit;
  /** 원본 이미지 너비 (mm) */
  originalWidth: number;
  /** 원본 이미지 높이 (mm) */
  originalHeight: number;
  /** 표시 영역 너비 (mm) — box contentAbsRect width */
  boxWidth: number;
  /** 표시 영역 높이 (mm) — box contentAbsRect height */
  boxHeight: number;
}

/**
 * objectFit 프리셋을 표시 위치/크기(mm)로 변환한다.
 *
 * @param input - {@link ObjectFitInput}
 * @returns 표시 영역 내 이미지 배치 rect (mm). 입력이 무효(0 또는 음수)하면 빈 rect.
 *
 * @example
 * computeObjectFit({ fit: 'cover', originalWidth: 100, originalHeight: 50, boxWidth: 80, boxHeight: 80 });
 * // → { x: -60, y: 0, width: 160, height: 80 }
 */
export function computeObjectFit(input: ObjectFitInput): ObjectFitRect {
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