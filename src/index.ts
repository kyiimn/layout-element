export * from "./components";
export * from "./core";
export * from "./edit";
export * from "./resource";
export * from "./types";
export * from "./constants";
export * from "./utils";
export * from "./examples";

// 엔진 계층: 기존 타입과 충돌하지 않는 새 심볼만 내보냄.
// Rect(MmRect)는 @/core와 @/utils에서 이미 내보내짐.
// CursorPlacement는 @/edit에서 이미 내보내짐.
// 엔진의 GridRect, AbsRect, OverlapResult, OverlapInput, BoxContentType,
// EngineResources, FontLoaderEngine, ColorRegistryEngine, ParsedFont,
// GridCalculatorEngineOptions, ImageEngineData, ImageLayoutResult,
// BoxLayoutResult, TableLayoutResult, ParagraphLayoutResult,
// DocumentLayoutResult, LayoutResult, CursorPlacement(재사용) 등은
// 엔진 전용 새 심볼이므로 충돌 없음.
export {
  type GridRect,
  type AbsRect,
  type MmRect as EngineMmRect,
  type OverlapDirection,
  type OverlapResult,
  type OverlapInput,
  type ImageEngineRef,
  type BoxContentType,
  type FontLoaderEngine,
  type ParsedFont,
  type ColorRegistryEngine,
  type EngineResources,
  type GridCalculatorEngineOptions,
  type ImageEngineData,
  type ImageLayoutResult,
  type BoxLayoutResult,
  type TableLayoutResult,
  type ParagraphLayoutResult,
  type DocumentLayoutResult,
  type LayoutResult,
  type CursorPlacement as EngineCursorPlacement,
  GridCalculatorEngine,
  ImageEngine,
  type RgbaData,
  checkOverlapMm,
  computeOverlapSizeMm,
  mergeOverlapParts as engineMergeOverlapParts,
  BoxEngine,
  TableEngine,
  TableRowEngine,
  TableCellEngine,
  ParagraphEngine,
  DocumentEngine,
  FontLoaderEngineImpl,
  ColorRegistryEngineImpl,
} from "./engine";