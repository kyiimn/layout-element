import type { TextInlineStyle, TextInlineData, TextStyle } from "@/types";

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
    const len = itemLength(item);
    runMap.push({ start: text.length, end: text.length + len, style: itemStyle(item) });
    text += typeof item === "string" ? item : item.content;
  }
  return { text, runMap: mergeAdjacentSameStyle(runMap) };
}

/**
 * 엔진 `content`에서 런 맵만 추출한다.
 *
 * `inlineToPlain`의 평문 문자열 생성을 제외한 런 맵 동기화 전용 헬퍼.
 * `TextEditController`는 텍스트 입력/삭제/IME 확정 후 `model.textContent`를
 * `insertTextIntoInline`/`deleteTextFromInline`으로 갱신하므로, 런 맵은 이
 * 결과에서 재추출하면 항상 `model.textContent`와 일관된다 — delta-sync
 * (`shiftRunMap` + `applyStyleToRange`)가 런 경계에서 발생시키던 불일치를
 * 회피한다.
 *
 * @param content - 엔진 content
 * @returns `content`에 정확히 대응하는 런 맵 (인접 동일 스타일 병합됨)
 *
 * @example
 * ```ts
 * runMapFromContent(["ab", { content: "굵게", textInlineStyle: { fontWeight: 700 } }, "cd"])
 * // → [
 * //   { start: 0, end: 2, style: undefined },
 * //   { start: 2, end: 4, style: { fontWeight: 700 } },
 * //   { start: 4, end: 6, style: undefined },
 * // ]
 * ```
 */
export function runMapFromContent(content: string | (string | TextInlineData)[]): RunMap {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ start: 0, end: content.length, style: undefined }];
  }

  let offset = 0;
  const runMap: RunMap = [];
  for (const item of content) {
    const len = itemLength(item);
    runMap.push({ start: offset, end: offset + len, style: itemStyle(item) });
    offset += len;
  }
  return mergeAdjacentSameStyle(runMap);
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

/**
 * 런 맵을 문단 기본 스타일 기준으로 정규화한다.
 *
 * 1. 문단 유효 텍스트 스타일과 **정의된 필드가 모두 동일한** 런은 해제한다
 *    (`style: undefined`로 복귀) — 문단과 차이가 없는 런은 인라인 구조를
 *    유지할 의미가 없다.
 * 2. 인접한 동일 스타일 런을 병합한다 (`mergeAdjacentSameStyle`과 동일 규칙).
 *
 * 텍스트 길이를 변경하지 않으므로 모든 오프셋은 불변이다.
 *
 * @param runMap - 원본 런 맵
 * @param paragraphTextStyle - 문단의 유효 텍스트 스타일 (`ParagraphEngine.effectiveTextStyle`)
 * @returns 정규화된 새 런 맵
 */
export function normalizeRunMap(runMap: RunMap, paragraphTextStyle: TextStyle): RunMap {
  const result: RunMap = [];
  for (const entry of runMap) {
    if (entry.start >= entry.end) continue;

    let style: TextInlineStyle | undefined = entry.style;
    if (style && inlineStyleMatchesParagraph(style, paragraphTextStyle)) {
      style = undefined;
    }

    const prev = result[result.length - 1];
    if (prev && prev.end === entry.start && inlineStyleEqual(prev.style, style)) {
      prev.end = entry.end;
    } else {
      result.push({ start: entry.start, end: entry.end, style });
    }
  }
  return result;
}

/**
 * 런의 인라인 스타일이 문단 유효 텍스트 스타일과 동일한지 판정한다.
 *
 * 런에 정의된 모든 필드가 문단 기본과 같으면 `true`. 런에 정의되지 않은
 * 필드(undefined)는 문단 기본을 따르는 것이므로 비교에서 제외한다.
 */
function inlineStyleMatchesParagraph(
  style: TextInlineStyle,
  paragraphTextStyle: TextStyle,
): boolean {
  if (style.fontFamily !== undefined && style.fontFamily !== paragraphTextStyle.fontFamily) return false;
  if (style.fontSize !== undefined && style.fontSize !== paragraphTextStyle.fontSize) return false;
  if (style.fontWeight !== undefined && style.fontWeight !== paragraphTextStyle.fontWeight) return false;
  if (style.fontStyle !== undefined && style.fontStyle !== paragraphTextStyle.fontStyle) return false;
  if (style.color !== undefined && style.color !== paragraphTextStyle.color) return false;
  return true;
}

/**
 * patch를 상속 스타일 기준으로 해석한다 — 상속 회귀(inherit revert) 규칙.
 *
 * 1. patch 필드 값이 **undefined** → "해당 필드의 오버라이드 제거" 의미로 해석해
 *    제거 목록에 넣는다.
 * 2. patch 필드 값이 inheritStyle의 같은 필드와 **동일** → 명시적 오버라이드가
 *    기본에 불과하므로 제거 목록에 넣는다 (기본을 따르는 중복 방지).
 * 3. 나머지 필드는 일반 주입값으로 유지한다.
 *
 * @param patch - 적용할 부분 스타일. `undefined` 값은 오버라이드 제거 의미
 * @param inheritStyle - 대상 paragraph의 상속 스타일 (null 필드 허용)
 * @returns 정리된 patch. 이 값들을 그대로 주입하면 상속 회귀가 반영된다
 */
export function resolvePatchAgainstInherit<T extends Record<string, unknown>>(
  patch: T,
  inheritStyle: Record<string, unknown> | undefined,
): T {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) continue;
    if (inheritStyle && inheritStyle[key] === value) continue;
    result[key] = value;
  }
  return result as T;
}

/**
 * 런 맵에서 지정 필드의 오버라이드를 제거한다 (상속 회귀).
 *
 * 모든 런의 `style`에서 `fields`에 해당하는 키를 delete한다. 제거 후 빈 스타일이
 * 된 런은 `style: undefined`로 정리되고, 인접 동일 런은 병합된다.
 * 텍스트 길이를 변경하지 않으므로 오프셋은 불변이다.
 *
 * @param runMap - 원본 런 맵
 * @param fields - 제거할 필드명 배열
 * @returns 정리된 새 런 맵
 */
export function stripRunFields(runMap: RunMap, fields: readonly string[]): RunMap {
  const result: RunMap = [];
  for (const entry of runMap) {
    if (!entry.style) {
      result.push({ ...entry });
      continue;
    }
    const style = { ...entry.style };
    for (const field of fields) {
      delete style[field as keyof TextInlineStyle];
    }
    const cleanedStyle = Object.keys(style).length > 0 ? style : undefined;
    const prev = result[result.length - 1];
    if (prev && prev.end === entry.start && inlineStyleEqual(prev.style, cleanedStyle)) {
      prev.end = entry.end;
    } else {
      result.push({ start: entry.start, end: entry.end, style: cleanedStyle });
    }
  }
  return result;
}

/**
 * 인라인 콘텐츠 배열의 지정 위치에 텍스트를 제자리 삽입한다.
 *
 * 편집 델타 경로가 `plainToInline()` 전체 재구축(문단 전체 O(N) 런 배열 신규 생성)
 * 대신 사용한다. 아이템 단위 슬라이스 스플라이스이므로 비용은 문단 길이가 아닌
 * **변경 런 수에 비례**한다. 삽입된 텍스트의 스타일은 `insertStyle`로 결정된다:
 * - `undefined`(미지정): 삽입점 직전 런의 스타일을 이어받는다 (타이핑 연속성).
 *   경계 분할이 필요하면 런을 분할한다.
 * - 지정됨: 해당 스타일의 런을 삽입하고 인접 동일 스타일 런을 병합한다.
 *
 * @param content - 원본 인라인 콘텐츠 (변경하지 않음)
 * @param at - 삽입 위치 (평문 오프셋. `\n` 포함 평문 기준)
 * @param text - 삽입할 텍스트. `\n`을 포함할 수 있다 (엔진 `_parseContents`가 라인 분할)
 * @param insertStyle - 삽입 텍스트에 적용할 인라인 스타일. `undefined`면 직전 런 스타일 이어받기
 * @returns 삽입 반영된 새 콘텐츠 배열. 원본은 불변
 * @throws 삽입 위치가 평문 길이를 벗어나면 Error
 * @example
 * ```ts
 * const content = ["ab", { content: "굵게", textInlineStyle: { fontWeight: 700 } }, "cd"];
 * insertTextIntoInline(content, 2, "XY");
 * // → ["abXY", { content: "굵게", textInlineStyle: { fontWeight: 700 } }, "cd"]
 * ```
 */
export function insertTextIntoInline(
  content: string | (string | TextInlineData)[],
  at: number,
  text: string,
  insertStyle?: TextInlineStyle,
): (string | TextInlineData)[] {
  if (text.length === 0) return cloneInlineContent(content);
  if (at < 0) throw new Error(`insertTextIntoInline: at(${at}) is negative`);
  const items = typeof content === "string" ? [content] : content;
  return spliceTextIntoRuns(items, at, 0, text, insertStyle);
}

/**
 * 인라인 콘텐츠의 평문에서 지정 범위를 제자리 삭제한다.
 *
 * 편집 델타 경로가 `plainToInline()` 전체 재구축 대신 사용한다. 삭제 후
 * 경계가 맞닿은 동일 스타일 런은 병합한다.
 *
 * @param content - 원본 인라인 콘텐츠 (변경하지 않음)
 * @param start - 삭제 시작 위치 (평문 오프셋, 포함)
 * @param deleteCount - 삭제할 문자 수. `\n`을 포함할 수 있다 (줄 병합)
 * @returns 삭제 반영된 새 콘텐츠 배열. 원본은 불변
 * @throws `start + deleteCount`가 평문 길이를 벗어나면 Error
 * @example
 * ```ts
 * const content = ["ab", { content: "굵게", textInlineStyle: { fontWeight: 700 } }, "cd"];
 * deleteTextFromInline(content, 2, 2);
 * // → ["abcd"] — 굵게 런 삭제 후 인접 일반 런과 병합
 * ```
 */
export function deleteTextFromInline(
  content: string | (string | TextInlineData)[],
  start: number,
  deleteCount: number,
): (string | TextInlineData)[] {
  if (deleteCount <= 0) return cloneInlineContent(content);
  if (start < 0) throw new Error(`deleteTextFromInline: start(${start}) is negative`);
  const items = typeof content === "string" ? [content] : content;
  return spliceTextIntoRuns(items, start, deleteCount, undefined, undefined);
}

/**
 * 인라인 콘텐츠에 (삭제 → 삽입) 스플라이스를 한 패스에 적용한다.
 *
 * `insertTextIntoInline`/`deleteTextFromInline`의 공통 코어. 스타일이 다른 런
 * 경계에 삽입하면 런을 분할하고, 인접 동일 스타일 런은 병합한다. 문자열 아이템은
 * `style: undefined` 런으로 취급한다. 평문 전체를 재조립하지 않고 아이템 단위로
 * 슬라이스하므로 문단 길이가 아닌 변경 런 수에 비례한다.
 *
 * @param items - 인라인 콘텐츠 아이템 배열 (변경하지 않음)
 * @param at - 편집 시작 위치 (평문 오프셋. `\n` 포함 평문 기준)
 * @param deleteCount - 삭제할 문자 수 (0 이상)
 * @param insertText - 삽입할 텍스트. `\n` 포함 가능. `undefined`면 삭제 전용
 * @param insertStyle - 삽입 텍스트에 적용할 스타일. `undefined`면 삽입점 직전
 *   런의 스타일을 이어받는다 (커서 앞 글자와 동일 스타일 연속성)
 * @returns 편집 반영된 새 콘텐츠 배열
 * @throws `at`/`deleteCount`가 평문 범위를 벗어나면 Error
 */
function spliceTextIntoRuns(
  items: readonly (string | TextInlineData)[],
  at: number,
  deleteCount: number,
  insertText: string | undefined,
  insertStyle: TextInlineStyle | undefined,
): (string | TextInlineData)[] {
  let remaining = at;
  let index = 0;
  while (index < items.length) {
    const len = itemLength(items[index]);
    if (remaining < len) break;
    remaining -= len;
    index++;
  }
  if (index >= items.length && remaining > 0) {
    throw new Error(`spliceTextIntoRuns: at(${at}) exceeds plain length`);
  }

  const result: (string | TextInlineData)[] = [];
  for (let i = 0; i < index; i++) result.push(items[i]);

  let toDelete = deleteCount;

  if (toDelete > 0) {
    // 삭제: 삽입점이 걸친 아이템부터 순서대로 좌측 보존 → 삽입 → 우측 보존
    let offset = remaining;
    let inserted = false;
    while ((toDelete > 0 || (insertText !== undefined && !inserted)) && index < items.length) {
      const item = items[index];
      const len = itemLength(item);
      if (offset > 0) {
        result.push(sliceItem(item, 0, offset));
      }
      if (!inserted && insertText !== undefined && insertText.length > 0) {
        const style = insertStyle !== undefined ? insertStyle : itemStyleAtStart(item, remaining);
        result.push({ content: insertText, textInlineStyle: style });
        inserted = true;
      }
      const take = Math.min(toDelete, len - offset);
      toDelete -= take;
      const tailStart = offset + take;
      if (tailStart < len) {
        result.push(sliceItem(item, tailStart, len));
      }
      offset = 0;
      index++;
    }
    if (toDelete > 0) {
      throw new Error(`spliceTextIntoRuns: delete range [${at}, ${at + deleteCount}) exceeds plain length`);
    }
    if (insertText !== undefined && !inserted) {
      // 삽입점이 아이템 경계에 정확히 걸친 경우 (삭제 범위 소진 후)
      const style = insertStyle !== undefined
        ? insertStyle
        : boundaryRunStyle(items, index - 1);
      if (insertText.length > 0) result.push({ content: insertText, textInlineStyle: style });
    }
  } else if (insertText !== undefined && insertText.length > 0) {
    // 삭제 없음: 삽입점이 걸친 단일 아이템을 좌/우로 분할하고 사이에 삽입
    if (index < items.length) {
      const item = items[index];
      const len = itemLength(item);
      if (remaining > 0) result.push(sliceItem(item, 0, remaining));
      const style = insertStyle !== undefined
        ? insertStyle
        : remaining > 0 ? itemStyleAtStart(item, remaining) : itemStyleAtBoundary(items, index);
      result.push({ content: insertText, textInlineStyle: style });
      if (remaining < len) result.push(sliceItem(item, remaining, len));
      index++;
    } else {
      const style = insertStyle !== undefined ? insertStyle : boundaryRunStyle(items, index - 1);
      result.push({ content: insertText, textInlineStyle: style });
    }
  }

  while (index < items.length) {
    result.push(items[index]);
    index++;
  }

  return mergeInlineItems(result);
}

/** 아이템의 평문 길이를 반환한다. */
function itemLength(item: string | TextInlineData): number {
  return typeof item === "string" ? item.length : item.content.length;
}

/** 아이템의 [from, to) 부분 문자열을 같은 타입으로 잘라낸다. */
function sliceItem(item: string | TextInlineData, from: number, to: number): string | TextInlineData {
  if (typeof item === "string") return item.slice(from, to);
  return { content: item.content.slice(from, to), textInlineStyle: item.textInlineStyle };
}

/** 인라인 아이템의 스타일을 반환한다 (문자열이면 undefined). */
function itemStyle(item: string | TextInlineData | undefined): TextInlineStyle | undefined {
  return typeof item === "string" || item === undefined ? undefined : item.textInlineStyle;
}

/**
 * 삽입점이 아이템 중간에 걸친 경우 삽입 텍스트의 스타일을 결정한다.
 *
 * 걸친 아이템의 스타일을 이어받는다 — 타이핑 연속성(직전 글자와 같은 런에
 * 이어짐)과 런 분할 최소화를 위한 규칙이다.
 */
function itemStyleAtStart(
  item: string | TextInlineData,
  _offsetInItem: number
): TextInlineStyle | undefined {
  return itemStyle(item);
}

/**
 * 삽입점이 아이템 경계(삭제 없음)인 경우 삽입 텍스트의 스타일을 결정한다.
 *
 * 직전 아이템의 스타일을 이어받는다 — 커서 앞 글자와 동일 스타일 연속성.
 */
function itemStyleAtBoundary(
  items: readonly (string | TextInlineData)[],
  boundaryIndex: number,
): TextInlineStyle | undefined {
  return itemStyle(boundaryIndex > 0 ? items[boundaryIndex - 1] : undefined);
}

/**
 * 지정 인덱스의 이전 아이템 기준으로 삽입 텍스트의 스타일을 결정한다.
 *
 * 직전 아이템 스타일을 이어받는다. 삽입점이 문단 시작이면 `undefined`
 * (문단 기본)이다.
 */
function boundaryRunStyle(
  items: readonly (string | TextInlineData)[],
  prevIndex: number,
): TextInlineStyle | undefined {
  if (prevIndex < 0) return undefined;
  return itemStyle(items[prevIndex]);
}

/**
 * 인라인 아이템 배열을 정규화한다 — 빈 아이템 제거 + 셸 객체 문자열 환원 + 인접 동일 스타일 병합.
 *
 * 스플라이스 결과에 생긴 빈 조각(`content: ""`)을 제거하고, `textInlineStyle`이
 * 없는 셸 객체(`{content}` 뿐인 `TextInlineData`)는 문단 기본 스타일 런과 동일하므로
 * 일반 문자열로 환원한다. 환원된 문자열은 인접 문자열과 병합되고, 스타일이 같은
 * 경계 런도 하나로 합쳐 엔진 입력 형식을 유지한다.
 *
 * @param items - 정규화할 인라인 아이템 배열 (변경하지 않음)
 * @returns 정규화된 새 아이템 배열
 */
function mergeInlineItems(items: (string | TextInlineData)[]): (string | TextInlineData)[] {
  const result: (string | TextInlineData)[] = [];
  for (const raw of items) {
    const hasContent = typeof raw === "string" ? raw.length > 0 : raw.content.length > 0;
    if (!hasContent) continue;
    // 셸 객체는 일반 문자열로 환원한다 — 저장 데이터에 스타일 없는 객체가
    // 문자 단위로 누적되는 것을 근원에서 차단한다.
    const item: string | TextInlineData =
      typeof raw !== "string" && raw.textInlineStyle === undefined ? raw.content : raw;
    const prev = result[result.length - 1];
    if (prev !== undefined && typeof prev === "string" && typeof item === "string") {
      result[result.length - 1] = prev + item;
      continue;
    }
    const prevStyle = itemStyle(prev);
    const curStyle = itemStyle(item);
    if (prev !== undefined && prevStyle !== undefined && curStyle !== undefined &&
        inlineStyleEqual(prevStyle, curStyle) &&
        typeof prev !== "string" && typeof item !== "string") {
      prev.content += item.content;
      continue;
    }
    result.push(typeof item === "string" ? item : { content: item.content, textInlineStyle: item.textInlineStyle });
  }
  return result;
}

/**
 * 저장된 인라인 콘텐츠를 정규화한다 — 셸 객체 문자열 환원 + 인접 문자열 병합
 * + 인접 동일 스타일 런 병합.
 *
 * 런 맵 기준으로는 정규화된 상태여도 저장된 content 배열에는 과거 편집 경로가
 * 남긴 스타일 없는 셸 객체(예: `{ content: "s" }`)가 누적되어 있을 수 있다.
 * `normalizeRunMap`/`normalizeNow`의 early return이 이를 정리하지 못하므로,
 * content 기준 정규화가 필요한 곳(예: `TextEditController.normalizeNow`)에서
 * 이 함수를 사용한다. 텍스트 길이를 변경하지 않으므로 오프셋은 불변이다.
 *
 * @param content - 원본 인라인 콘텐츠 (변경하지 않음)
 * @returns 정규화된 새 콘텐츠
 * @example
 * ```ts
 * normalizeInlineContent(["abc", { content: "d" }, { content: "ef" }])
 * // → ["abcdef"] — 셸 객체 해제 + 인접 문자열 병합
 * normalizeInlineContent([
 *   "ab",
 *   { content: "굵게", textInlineStyle: { fontWeight: 700 } },
 *   { content: "!", textInlineStyle: { fontWeight: 700 } },
 * ])
 * // → ["ab", { content: "굵게!", textInlineStyle: { fontWeight: 700 } }]
 * ```
 */
export function normalizeInlineContent(
  content: string | (string | TextInlineData)[],
): (string | TextInlineData)[] {
  const items = typeof content === "string" ? [content] : content;
  return mergeInlineItems(items);
}

/** 인라인 콘텐츠를 얕게 복제한다 (no-op 편집용). */
function cloneInlineContent(content: string | (string | TextInlineData)[]): (string | TextInlineData)[] {
  if (typeof content === "string") return [content];
  const result: (string | TextInlineData)[] = [];
  for (const item of content) {
    result.push(typeof item === "string" ? item : { ...item });
  }
  return result;
}
