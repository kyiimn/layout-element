import type { TextInlineStyle, TextInlineData } from "@/types";

/**
 * 평문 텍스트와 인라인 스타일 런(run)의 매핑.
 *
 * textarea는 평문만 다룰 수 있으므로, 인라인 스타일은 별도의 런 맵으로 관리한다.
 * 런 맵은 평문의 문자 오프셋 범위(`[start, end)`)와 해당 범위의 스타일을 쌍으로 가진다.
 * `style`이 `undefined`이면 문단 기본 스타일을 사용한다.
 */
export type RunEntry = {
  /** 런 시작 오프셋 (평문 기준, 포함) */
  start: number;
  /** 런 종료 오프셋 (평문 기준, 미포함) */
  end: number;
  /** 이 런에 적용되는 인라인 스타일. undefined면 문단 기본 스타일 */
  style: TextInlineStyle | undefined;
};

export type RunMap = RunEntry[];

/**
 * 평문과 런 맵을 엔진 `content` 타입(`(string | TextInlineData)[]`)으로 변환한다.
 *
 * 인접한 같은 스타일 런은 자동으로 병합되어 하나의 `TextInlineData`가 된다.
 * `style`이 `undefined`인 런은 일반 문자열로, 정의된 `style`이 있는 런은
 * `TextInlineData` 객체로 변환된다.
 *
 * @param text - 평문 전체
 * @param runMap - 런 맵
 * @returns 엔진 `content` 배열
 * @example
 * ```ts
 * plainToInline("ab굵게cd", [
 *   { start: 0, end: 2, style: undefined },
 *   { start: 2, end: 4, style: { fontWeight: 700 } },
 *   { start: 4, end: 6, style: undefined },
 * ])
 * // → ["ab", { content: "굵게", textInlineStyle: { fontWeight: 700 } }, "cd"]
 * ```
 */
export function plainToInline(text: string, runMap: RunMap): (string | TextInlineData)[] {
  if (runMap.length === 0) {
    return [text];
  }

  const result: (string | TextInlineData)[] = [];
  let cursor = 0;

  for (const entry of runMap) {
    if (entry.start > cursor) {
      result.push(text.slice(cursor, entry.start));
      cursor = entry.start;
    }
    if (entry.end > cursor) {
      const content = text.slice(cursor, entry.end);
      if (content.length > 0) {
        if (entry.style === undefined) {
          result.push(content);
        } else {
          result.push({ content, textInlineStyle: entry.style });
        }
      }
      cursor = entry.end;
    }
  }

  if (cursor < text.length) {
    result.push(text.slice(cursor));
  }

  return result;
}

/**
 * 엔진 `content`(`string | (string | TextInlineData)[]`)를 평문과 런 맵으로 분해한다.
 *
 * @param content - 엔진 content
 * @returns 평문과 런 맵
 * @example
 * ```ts
 * inlineToPlain(["ab", { content: "굵게", textInlineStyle: { fontWeight: 700 } }, "cd"])
 * // → { text: "ab굵게cd", runMap: [
 * //   { start: 0, end: 2, style: undefined },
 * //   { start: 2, end: 4, style: { fontWeight: 700 } },
 * //   { start: 4, end: 6, style: undefined },
 * // ] }
 * ```
 */
export function inlineToPlain(content: string | (string | TextInlineData)[]): { text: string; runMap: RunMap } {
  if (typeof content === "string") {
    return { text: content, runMap: [{ start: 0, end: content.length, style: undefined }] };
  }

  let text = "";
  const runMap: RunMap = [];
  for (const item of content) {
    if (typeof item === "string") {
      runMap.push({ start: text.length, end: text.length + item.length, style: undefined });
      text += item;
    } else {
      runMap.push({ start: text.length, end: text.length + item.content.length, style: item.textInlineStyle });
      text += item.content;
    }
  }
  return { text, runMap: mergeAdjacentSameStyle(runMap) };
}

/**
 * 주어진 오프셋이 속한 런의 스타일을 반환한다.
 *
 * @param runMap - 런 맵
 * @param offset - 평문 오프셋
 * @returns 해당 오프셋의 인라인 스타일. `undefined`면 문단 기본 스타일
 */
export function getStyleAtOffset(runMap: RunMap, offset: number): TextInlineStyle | undefined {
  for (const entry of runMap) {
    if (offset >= entry.start && offset < entry.end) {
      return entry.style;
    }
  }
  const last = runMap[runMap.length - 1];
  if (last && offset === last.end) {
    return last.style;
  }
  return undefined;
}

/**
 * 런 맵의 특정 범위에 인라인 스타일을 적용한다.
 *
 * 범위가 기존 런 경계를 가로지르면 해당 런을 분할하고, 범위 내의 런들에
 * 새 스타일을 오버라이드한다. 적용 후 인접한 같은 스타일 런은 병합하여
 * 런 맵을 최소화한다.
 *
 * @param runMap - 원본 런 맵 (변경하지 않음)
 * @param start - 스타일 적용 시작 오프셋 (포함)
 * @param end - 스타일 적용 종료 오프셋 (미포함)
 * @param style - 적용할 인라인 스타일. 기존 스타일 위에 오버라이드된다
 * @returns 새로운 런 맵
 * @example
 * ```ts
 * applyStyleToRange(runMap, 5, 10, { fontWeight: 700 })
 * // → offset 5~9의 텍스트가 굵게 표시되도록 런 맵 갱신
 * ```
 */
export function applyStyleToRange(
  runMap: RunMap,
  start: number,
  end: number,
  style: Partial<TextInlineStyle>,
): RunMap {
  if (start >= end) return runMap;

  const result: RunMap = [];

  for (const entry of runMap) {
    if (entry.end <= start || entry.start >= end) {
      result.push(entry);
      continue;
    }

    if (entry.start < start) {
      result.push({ start: entry.start, end: start, style: entry.style });
    }

    const segStart = Math.max(entry.start, start);
    const segEnd = Math.min(entry.end, end);
    const mergedStyle = entry.style
      ? { ...entry.style, ...style }
      : { ...style } as TextInlineStyle | undefined;
    result.push({
      start: segStart,
      end: segEnd,
      style: mergedStyle && Object.keys(mergedStyle).length > 0 ? mergedStyle : undefined,
    });

    if (entry.end > end) {
      result.push({ start: end, end: entry.end, style: entry.style });
    }
  }

  return mergeAdjacentSameStyle(result);
}

/**
 * 런 맵의 특정 위치에 텍스트가 삽입되거나 삭제될 때 offset을 조정한다.
 *
 * `at` 위치 이후의 모든 런의 `start`/`end`를 `delta`만큼 이동한다.
 * `at` 위치에 걸쳐 있는 런은 `end`만 이동한다 (삽입 시 연장, 삭제 시 단축).
 *
 * @param runMap - 원본 런 맵
 * @param at - 삽입/삭제 위치 (평문 오프셋)
 * @param delta - 길이 변화 (삽입: 양수, 삭제: 음수)
 * @returns 조정된 런 맵
 */
export function shiftRunMap(runMap: RunMap, at: number, delta: number): RunMap {
  if (delta === 0) return runMap;

  const result: RunMap = [];
  for (const entry of runMap) {
    if (entry.end <= at) {
      result.push(entry);
    } else if (entry.start >= at) {
      result.push({ start: entry.start + delta, end: entry.end + delta, style: entry.style });
    } else {
      result.push({ start: entry.start, end: entry.end + delta, style: entry.style });
    }
  }
  return mergeAdjacentSameStyle(result);
}

/**
 * 인접한 같은 스타일 런을 병합하여 런 맵을 정규화한다.
 *
 * @param runMap - 원본 런 맵
 * @returns 정규화된 런 맵 (빈 런 제거 + 인접 동일 스타일 병합)
 */
export function mergeAdjacentSameStyle(runMap: RunMap): RunMap {
  if (runMap.length === 0) return [];

  const result: RunMap = [];
  for (const entry of runMap) {
    if (entry.start >= entry.end) continue;
    const prev = result[result.length - 1];
    if (prev && prev.end === entry.start && inlineStyleEqual(prev.style, entry.style)) {
      prev.end = entry.end;
    } else {
      result.push({ ...entry });
    }
  }
  return result;
}

function inlineStyleEqual(a: TextInlineStyle | undefined, b: TextInlineStyle | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.fontWeight === b.fontWeight &&
    a.fontStyle === b.fontStyle &&
    a.color === b.color
  );
}