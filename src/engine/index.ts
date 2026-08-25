/**
 * 엔진 계층 진입점.
 *
 * 이 모듈은 Node.js 호환 순수 계산 엔진을 내보낸다.
 * DOM, Canvas, FontFace 등 브라우저 의존 API를 사용하지 않으며,
 * 모든 수치 계산(크기, 위치, 스타일 상속, 텍스트 배치, 오버랩)을 담당한다.
 *
 * @file src/engine/index.ts
 */

export * from "./types";
export * from "./table-grid-resolver";
export * from "./border-store";
export * from "./grid-calculator-engine";
export * from "./image-engine";
export * from "./image-decoder";
export * from "./object-fit-engine";
export * from "./overlap-engine";
export * from "./box-engine";
export * from "./table-engine";
export * from "./paragraph-engine";
export * from "./document-engine";
export * from "./font-loader-engine";
export * from "./color-registry-engine";