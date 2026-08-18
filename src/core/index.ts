// 기존 GridCalculator/TextLayoutEngine은 삭제됨 — 대신 @/engine의 클래스 사용.
// 마이그레이션 가이드는 docs/ENGINE.md 참조.
export * from "./table-grid-resolver";
export * from "./border-resolver";

export {
  GridCalculatorEngine,
  ImageEngine,
  BoxEngine,
  TableEngine,
  ParagraphEngine,
  DocumentEngine,
  FontLoaderEngineImpl,
  ColorRegistryEngineImpl,
  computeOverlapSizeMm,
  checkOverlapMm,
} from "@/engine";