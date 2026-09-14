/**
 * ParagraphEngine 캐시/해시 서브모듈 — 참조 단위 캐시와 해시 키 구성.
 *
 * `paragraph-engine.ts`의 digest 직렬화 본체, 프리픽스 해시 키 구성 본체,
 * 정적 WeakMap 3종을 본문 그대로 이동한 파일이다. 해시 문자열 규칙
 * (cw:/g:/lh:/lg:/lgm:/wr:/ls:/sr:/fs:/ph:/ta:/va:/in:/hp:/ww: + 조건부
 * tf:/tc:)은 1바이트도 변경하지 않는다 — snapshot byte-identical 계약.
 *
 * 인스턴스 메모(`_lastDigestKey`/`_lastDigest`)와 인스턴스 캐시
 * (`_layoutCache`/`_parsedContentsCache`/`_prefixCache`)는 클래스에 유지된다.
 *
 * @file src/engine/paragraph-hash.ts
 */

import type { TextInlineData } from "@/types";

/**
 * `textContent` 직렬화 다이제스트 캐시 (참조 단위, R-T1 해시 비용 제거).
 * 스레드 체인의 모든 프레임이 동일 스토리 참조를 소유하므로 head가 직렬화하면
 * 나머지 프레임은 O(1) 조회다. 수명은 참조에 귀속되어 GC 안전.
 */
export const _TEXT_DIGEST_BY_REF = new WeakMap<object, string>();

/**
 * plainText 플래트닝 결과 공유 캐시 (참조 단위). 스레드 체인의 전 프레임이
 * 동일 스토리 참조를 소유하므로 체인당 1회만 O(N) 플래트닝한다.
 * 문자열 textContent는 내용 자체가 plainText이므로 캐시 불필요.
 */
export const _PLAIN_TEXT_BY_REF = new WeakMap<object, string>();

/**
 * `_parseContents` 결과(라인 × 런 블록) 공유 캐시 (참조 단위). 파싱 결과는
 * 소스 참조만으로 결정되고, 파서가 런을 **새 객체로 생성**하므로(소스 불변)
 * 체인 엔진 간 배열 공유가 안전하다.
 */
export const _PARSED_CONTENTS_BY_REF = new WeakMap<object, TextInlineData[][]>();

/**
 * 인라인 콘텐츠 배열을 해시용 텍스트 직렬화 segs로 구성한다.
 *
 * 직렬화 규칙은 기존 `_computeLayoutInputHash` 인라인 코드와 byte 동일:
 * 블록 content를 순서대로 push하고, 인라인 스타일 블록은 폭 영향 필드
 * (fontFamily/fontSize/fontStyle/letterSpacing/widthRatio/spaceRatio)만
 * `s:` 키로 이어붙인다. fontWeight/color는 무영향이므로 제외 — 스타일만
 * 변경된 주입(굵게/색상)에서 캐시 히트 → 재래핑 생략 계약을 유지한다.
 *
 * @param tc - 인라인 런 배열 (문자열 블록 + 인라인 런 혼합)
 * @returns join 전 segs 문자열 배열
 * @throws 없음
 */
export function textContentSegs(tc: readonly (string | TextInlineData)[]): string[] {
  const segs: string[] = [];
  for (const block of tc) {
    if (typeof block === "string") {
      segs.push(block);
    } else {
      segs.push(block.content);
      const s = block.textInlineStyle;
      if (s) {
        segs.push(
          "s:" +
            (s.fontFamily ?? "") + "," +
            (s.fontSize ?? "") + "," +
            (s.fontStyle ?? "") + "," +
            (s.letterSpacing ?? "") + "," +
            (s.widthRatio ?? "") + "," +
            (s.spaceRatio ?? ""),
        );
      }
    }
  }
  return segs;
}

/**
 * `_computePrefixHash`의 키 문자열 구성 본체 — 캐럿 이전 컬럼 글자수 비교 키.
 *
 * 측정값(plain, textContent, columnWidths, gaps, effective 스타일 등)은
 * 인자로 주입받아 기존 인라인 코드와 byte 동일한 순서·포맷으로 구성한다.
 *
 * @param m - 프리픽스 해시 측정값 묶음 (엔진 상태 파라미터 주입)
 * @returns 프리픽스 해시 문자열 (`parts.join("|")` 결과)
 * @throws 없음
 */
export function computePrefixHashKey(m: {
  caretOffset: number;
  plainText: string;
  textContent: string | (string | TextInlineData)[];
  columnWidths: number[];
  gaps: number[];
  lineHeight: number;
  lineGap: number;
  lineGapMode: string;
  widthRatio: number;
  letterSpacing: number;
  spaceRatio: number;
  fontSize: number;
  parentHeight: number;
  textAlign: string;
  verticalAlign: string;
  indent: number;
  hangingPunctuation: unknown;
  wordWrap: boolean;
  contentFrom: number;
  tailClampFrom: number;
  overlayKeys: string[];
}): string {
  const parts: string[] = [];
  const prefixText = m.plainText.slice(0, m.caretOffset);
  parts.push("pt:" + prefixText);

  const tc = m.textContent;
  if (typeof tc !== "string") {
    let consumed = 0;
    for (const block of tc) {
      const content = typeof block === "string" ? block : block.content;
      const blockLen = content.length;
      if (consumed >= m.caretOffset) break;
      const end = Math.min(consumed + blockLen, m.caretOffset);
      const slice = content.slice(0, end - consumed);
      parts.push(slice);
      if (typeof block !== "string") {
        const s = block.textInlineStyle;
        if (s) {
          parts.push(
            "s:" + (s.fontFamily ?? "") + "," +
                  (s.fontSize ?? "") + "," +
                  (s.fontStyle ?? "") + "," +
                  (s.letterSpacing ?? "") + "," +
                  (s.widthRatio ?? "") + "," +
                  (s.spaceRatio ?? ""),
          );
        }
      }
      consumed += blockLen;
    }
  }

  for (const overlayKey of m.overlayKeys) {
    parts.push(overlayKey);
  }

  parts.push(
    "cw:" + m.columnWidths.join(","),
    "g:" + m.gaps.join(","),
    "lh:" + m.lineHeight,
    "lg:" + m.lineGap,
    "lgm:" + m.lineGapMode,
    "wr:" + m.widthRatio,
    "ls:" + m.letterSpacing,
    "sr:" + m.spaceRatio,
    "fs:" + m.fontSize,
    "ph:" + m.parentHeight,
    "ta:" + m.textAlign,
    "va:" + m.verticalAlign,
    "in:" + m.indent,
    "hp:" + JSON.stringify(m.hangingPunctuation ?? false),
    "ww:" + (m.wordWrap ?? false),
    ...(m.contentFrom > 0 ? ["tf:" + m.contentFrom] : [] as string[]),
    ...(m.tailClampFrom >= 0 ? ["tc:" + m.tailClampFrom] : [] as string[]),
  );

  return parts.join("|");
}

/**
 * 오버랩 요소 해시 키 배열 구성기 — `_computeLayoutInputHash`의 키 부분
 * 문자열 추출 (`overlayKeysFor(els, pAbsLeft, pAbsTop): string[]`).
 *
 * 개별 키 생성 로직(`overlayHashKey`)의 소유자는 `paragraph-overlap.ts`이며,
 * 엔진은 `overlayKeysFor(els, (el) => this._overlayHashKey(el, ...))`로
 * 위임자를 주입한다 — 해시 모듈은 키 배열 구성만 담당한다.
 *
 * @param els - 오버랩 박스 엔진 배열
 * @param keyFn - 개별 오버랩 요소의 해시 키 생성기 (엔진 위임)
 * @returns 오버랩 요소 해시 키 배열
 * @throws 없음
 */
export function overlayKeysFor<T>(els: readonly T[], keyFn: (el: T) => string): string[] {
  const keys: string[] = [];
  for (const el of els) {
    keys.push(keyFn(el));
  }
  return keys;
}