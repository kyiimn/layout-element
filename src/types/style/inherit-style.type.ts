import { ParagraphStyle } from "./paragraph-style.type";
import { TextStyle } from "./text-style.type";

/**
 * 부모에서 자식으로 전달되는 **캐스케이딩 스타일 컨텍스트**.
 *
 * `TextStyle`과 `ParagraphStyle`의 합집합에 부모 치수와 패딩 정보를 추가한 타입.
 *
 * 스타일 캐스케이드 흐름:
 * ```
 * DocumentData
 *   ├── textStyle: { fontSize: 4, fontFamily: "Noto Sans", color: "#000" }
 *   └── paragraphStyle: { lineGap: 1.2, textAlign: "justify" }
 *         ↓
 *   LayoutDocumentElement가 InheritStyle 생성
 *         ↓
 *   자식 BoxData:
 *     자체 textStyle/paragraphStyle이 없으면 → InheritStyle 그대로 사용
 *     자체 값이 있으면 → 해당 필드만 오버라이드
 *         ↓
 *   손자 ParagraphData:
 *     paragraphStyle: { textAlign: "center" }  ← textAlign만 오버라이드
 *     나머지(fontSize, fontFamily, lineGap 등)는 상속값 유지
 * ```
 */
export type InheritStyle = TextStyle & ParagraphStyle & {
  /** 부모 컨테이너 너비 (mm) */
  parentWidth: number;

  /** 부모 컨테이너 높이 (mm) */
  parentHeight: number;

  /** 부모의 상단 패딩 (mm) */
  paddingTop?: number;

  /** 부모의 우측 패딩 (mm) */
  paddingRight?: number;

  /** 부모의 하단 패딩 (mm) */
  paddingBottom?: number;

  /** 부모의 좌측 패딩 (mm) */
  paddingLeft?: number;
};