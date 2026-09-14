/**
 * ParagraphEngine 걸침(hanging punctuation) 패스 — 모듈 함수.
 *
 * `paragraph-engine.ts`의 `_applyHangingPunctuation` 패스와 그 전용 헬퍼를
 * 본문 그대로 이동한 파일이다. 클래스 상태(`this._*`)는 `HangPassContext`
 * 인자로 주입하며, 판정 수식·엣지 게이트·`hangs` 마킹 시맨틱은 계획서
 * 계약대로 1바이트도 변경하지 않는다.
 *
 * 소비처:
 * - `paragraph-engine.ts` — private 메서드 위임 (호출부 시그니처 불변)
 *   - `_applyHangingPunctuation()` → `applyHangingPass(ctx)`
 *   - `_hangingConfig()` → `hangingConfig(hangingPunctuation)`
 *   - `_computeHangExtents()` → `computeHangExtents(ctx)`
 * - `genColumnStyle` (public) → `_hangingConfig` 위임 유지
 * - `getOffsetFromPoint` (public) → `_computeHangExtents` 위임 유지
 *
 * @file src/engine/paragraph-hanging.ts
 */

import {
  isHangableLineEnd,
  isHangableLineStart,
  isWordChar,
} from "@/constants";
import type { ParagraphStyle, TextInlineStyle, TextLineData } from "@/types";

/**
 * 좌우 밀기 탭 문자 (`\t`).
 *
 * InDesign의 Shift+Tab(좌우 밀기 탭)과 동일한 의미론을 가지는
 * 특수 마커 문자이다. 레이아웃 폭은 항상 **0**이며, `_computeCharOffsets()`
 * 후처리에서 이 문자 이후의 같은 파트 내 텍스트를 파트 오른쪽 끝에
 * 우측 정렬시키는 기준점으로 사용된다.
 *
 * 폭 0 규칙: 모든 폭 계산 경로(`_charWidthMm`, `_layoutColumnsPass`,
 * `_computeCharOffsets`, `getCharWidths`, `genCharStyle`, `genCharStyleFlat`)는
 * 이 문자를 특수 처리하여 0을 반환해야 한다. 폰트 글리프 조회 폴백
 * (`minWidthMm`)이 적용되면 의도치 않은 공백 폭이 생기므로 금지.
 */
const RIGHT_INDENT_TAB_CHAR = "\t";

/** 걸침 히트테스트 확장 폭 엔트리. */
export interface HangExtent {
  left: number;
  right: number;
}

/**
 * 걸침 패스 컨텍스트 — ParagraphEngine 상태의 파라미터 주입.
 *
 * `applyHangingPass`/`computeHangExtents`가 `this._*` 접근 대신 소비하는
 * 최소 필드 집합이다 (본문의 실제 사용을 전수 확인해 확정).
 */
export interface HangPassContext {
  /** 걸침표 방향별 설정 원값 (effective 체인 결과). */
  hangingPunctuation: ParagraphStyle["hangingPunctuation"];
  /** 컬럼별 라인 데이터 (엔진 `_columnContents`). */
  columns: TextLineData[][];
  /** 컬럼 폭 배열 mm (엔진 `_columnWidths`). */
  columnWidths: number[];
  /** 워드 래핑 ON 여부 (엔진 `wordWrap`). */
  wordWrap: boolean;
  /**
   * 글자 배치 폭 측정기 — 엔진 `getCharWidths(char, inlineStyle).swidth`.
   * `computeHangExtents`가 돌출 폭을 측정할 때 소비한다.
   */
  measureChar: (char: string, inlineStyle?: TextInlineStyle) => number;
}

/**
 * 걸침표(hanging punctuation) 방향별 설정을 정규화한다.
 *
 * `hangingPunctuation` 스타일 값(`true`/`false`/객체)을 방향별 boolean과
 * 강제 걸침 여부로 변환한다.
 *
 * `lineEnd: 'always'`는 **강제 걸침**(InDesign ぶら下げ「強制」/ CSS
 * `force-end`) — `lineEnd: true`(표준 걸침)의 동작을 포함하되, 줄 안에
 * 들어맞는 닫기 부호도 컬럼 밖으로 내보낸다.
 *
 * @param hangingPunctuation - 걸침표 설정 원값 (effective 체인 결과)
 * @returns `{ lineEnd, lineStart, lineEndAlways }` — 각 방향 걸침 ON 여부와
 *   행말 강제 걸침 여부. `lineEndAlways`가 `true`이면 `lineEnd`도 `true`다.
 * @throws 없음
 *
 * @example
 * ```ts
 * // hangingPunctuation: { lineEnd: 'always' } →
 * // { lineEnd: true, lineStart: false, lineEndAlways: true }
 * // hangingPunctuation: true →
 * // { lineEnd: true, lineStart: true, lineEndAlways: false }
 * ```
 */
export function hangingConfig(hangingPunctuation: ParagraphStyle["hangingPunctuation"]): { lineEnd: boolean; lineStart: boolean; lineEndAlways: boolean } {
  if (hangingPunctuation === true) return { lineEnd: true, lineStart: true, lineEndAlways: false };
  if (typeof hangingPunctuation === "object" && hangingPunctuation !== null) {
    const lineEndAlways = hangingPunctuation.lineEnd === "always";
    return { lineEnd: hangingPunctuation.lineEnd === true || lineEndAlways, lineStart: hangingPunctuation.lineStart === true, lineEndAlways };
  }
  return { lineEnd: false, lineStart: false, lineEndAlways: false };
}

/**
 * 라인의 마지막 파트가 컬럼 우측 끝까지 도달하는지 확인한다 (걸침 엣지 게이트).
 *
 * `part.left`는 첫 파트에서 절대 start, 이후 파트에서는 이전 파트 끝에서의
 * 갭이므로, 절대 우측 끝은 `Σ(모든 파트 left) + Σ(모든 파트 width)`로
 * 누적 계산해야 한다.
 *
 * @param line - 검사할 라인
 * @param columnWidth - 컬럼 폭 (mm)
 * @returns 마지막 파트의 절대 우측 끝이 컬럼 폭과 일치하면 `true`
 *
 * @example
 * // 파트 left/width가 [{left: 10, width: 20}, {left: 10, width: 20}]이고
 * // 컬럼 폭 60mm: (10+10)+(20+20) = 60 → true
 * @throws 없음
 */
export function isLastPartAtColumnRightEdge(line: TextLineData, columnWidth: number): boolean {
  let absRight = 0;
  for (const part of line.parts) absRight += part.left + part.width;
  return Math.abs(absRight - columnWidth) < 1e-6;
}

/**
 * 라인의 첫 파트가 컬럼 좌측 끝에서 시작하는지 확인한다 (걸침 엣지 게이트).
 *
 * 문단 indent가 적용된 첫 줄은 `parts[0].left`가 indentMm(> 0)이므로
 * 게이트가 실패한다 — 들여쓴 줄의 왼쪽은 컬럼 밖이 아니기 때문이다.
 *
 * @param line - 검사할 라인
 * @returns 첫 파트의 left가 0이면 `true`
 * @throws 없음
 */
export function isFirstPartAtColumnLeftEdge(line: TextLineData): boolean {
  return Math.abs(line.parts[0].left) < 1e-6;
}

/**
 * 걸침표(hanging punctuation) 규칙을 적용한다.
 *
 * 폭 기준 배치 후 금칙 패스(`_applyLineBreakRules`) **직전에** 실행되는
 * 후처리 패스다. 금칙 교정(push-down/pull-up) 대신 문장부호를 틀 밖으로
 * 내보내 위반 자체를 해소한다 (hang-first).
 *
 * 페어(인접 두 줄)별 결정 순서 — 한 페어에 최대 1회 교정:
 * 1. **행두 걸침**: 위 줄 마지막 글자가 열기 부호(행말 금지)면 아래 줄
 *    앞으로 내보내 왼쪽 밖에 건다. 두 위반(행말 금지 + 아래 줄 행두가
 *    닫기 부호인 충돌 케이스)을 동시에 해소한다.
 * 2. **행말 걸침**: 아래 줄 첫 글자가 닫기 부호(행두 금지)면 아래 줄의
 *    선행 닫기 부호 run 전체를 위 줄 끝으로 당겨 우측 밖에 건다.
 * 3. 둘 다 해당 없으면 금칙 패스가 기존대로 교정한다.
 *
 * `lineEnd: 'always'`(강제 걸침)에서는 위 페어 패스 후 **per-line 패스**가
 * 추가로 실행된다 (InDesign ぶら下げ「強制」/ CSS `force-end` 대응):
 * 4. **행말 강제 걸침**: 블록의 마지막 줄이 아닌 줄의 끝에서, 이미 컬럼
 *    폭 안에 들어맞은 닫기 부호 run도 `hangs='end'`로 마킹해 컬럼 우측
 *    밖으로 내보낸다. 글자 이동은 없다 — 줄 구성은 그대로 두고 마킹만
 *    추가하며, `_computeCharOffsets`가 나머지 글자로 정렬 폭을 다시
 *    채운다. 결과적으로 텍스트 가장자리(부호 직전 글자)가 컬럼 끝에
 *    맞고 부호만 밖으로 튀어나온다.
 *
 * 가드:
 * - 엣지 게이트: 걸침 방향이 컬럼 경계를 벗어나야 한다 (마지막 파트
 *   우측 끝 === 컬럼 폭 / 첫 파트 left === 0). 오버랩 파트 옆 틈으로는
 *   걸치지 않는다.
 * - `curLastPart.content.length >= 2` (행두 걸침): 내보낸 뒤 파트가
 *   빈 상자로 남아 파트 간 갭이 생기는 것을 방지.
 * - `run < nextFirstPart.content.length` (행말 걸침): 아래 줄 첫 파트에
 *   최소 1자 잔존. 전체를 당기면 빈 줄이 된다.
 * - 탭(`\t`) 파트는 걸침하지 않는다 — 좌우 밀기 탭 정렬과 충돌.
 * - 블록 경계 쌍(`curLine.endOfBlock`/`nextLine.firstOfBlock`)은
 *   걸침하지 않는다 — `\n`으로 끊기는 흐름에서 글자를 이동하면
 *   읽기 순서가 훼손된다. 금칙 패스와 정렬 순서를 맞추기 위한
 *   의도된 차이다 (금칙은 기존 동작 보존을 위해 손대지 않는다).
 *
 * 걸침 글자 마킹은 `TextPartData.hangs`(raw content 인덱스 평행 배열)에
 * 기록되고, `_computeCharOffsets`가 정렬 산출 시 이를 소비한다.
 *
 * @param ctx - 걸침 패스 컨텍스트 (엔진 상태 파라미터 주입)
 * @returns 교정을 적용한 페어 키(`${col}:${lineIdx}`) 집합. 금칙 패스가
 *   같은 페어를 재교정해 걸침을 훼손하지 않도록 스킵 목록으로 전달한다.
 *   걸침 기능이 완전 OFF면 빈 집합을 반환한다 (스캔 없음).
 * @throws 없음
 *
 * @example
 * ```ts
 * // "가나다."에서 '.'가 폭 초과로 아래 줄에 내려간 경우 (행말 걸침 ON):
 * // 위 줄: [가, 나, 다, .(hangs='end')] — '.'는 파트 우측 밖에 배치
 * // 아래 줄: [마, 바, ...] — 행두 금칙 위반이 사라짐
 *
 * // "가나다("에서 '('가 위 줄 끝에 남은 경우 (행두 걸침 ON):
 * // 위 줄: [가, 나, 다]
 * // 아래 줄: [(hangs='start'), 가, 나, ...] — '('는 파트 좌측 밖에 배치
 * ```
 */
export function applyHangingPass(ctx: HangPassContext): ReadonlySet<string> {
  const { hangingPunctuation, columns, columnWidths, wordWrap } = ctx;
  const cfg = hangingConfig(hangingPunctuation);
  const corrected = new Set<string>();
  if (!cfg.lineEnd && !cfg.lineStart) return corrected;

  for (let col = 0; col < columns.length; col++) {
    const columnContent = columns[col];
    const columnWidth = columnWidths[col] ?? 0;
    for (let i = 0; i < columnContent.length - 1; i++) {
      const curLine = columnContent[i];
      const nextLine = columnContent[i + 1];

      if (curLine.parts.length === 0) continue;
      if (nextLine.parts.length === 0) continue;

      const curLastPart = curLine.parts[curLine.parts.length - 1];
      const nextFirstPart = nextLine.parts[0];
      if (curLastPart.content.length === 0 || nextFirstPart.content.length === 0) continue;

      if (curLine.endOfBlock === true || nextLine.firstOfBlock === true) continue;

      const key = `${col}:${i}`;
      const curLastChar = curLastPart.content[curLastPart.content.length - 1]!;

      const curHasTab = curLastPart.content.includes(RIGHT_INDENT_TAB_CHAR);
      const nextHasTab = nextFirstPart.content.includes(RIGHT_INDENT_TAB_CHAR);

      // 1) 행두 걸침: 열기 부호를 아래 줄 앞으로 내보내 왼쪽 밖에 건다.
      if (
        cfg.lineStart &&
        isHangableLineStart(curLastChar) &&
        curLastPart.content.length >= 2 &&
        !curHasTab &&
        !nextHasTab &&
        isFirstPartAtColumnLeftEdge(nextLine)
      ) {
        const movedStyle = curLastPart.inlineStyles?.pop();
        curLastPart.hangs?.pop();
        curLastPart.content.pop();

        nextFirstPart.content.unshift(curLastChar);
        if (nextFirstPart.inlineStyles) {
          nextFirstPart.inlineStyles.unshift(movedStyle);
        } else if (movedStyle !== undefined) {
          nextFirstPart.inlineStyles = new Array(nextFirstPart.content.length).fill(undefined);
          nextFirstPart.inlineStyles[0] = movedStyle;
        }
        nextFirstPart.hangs ??= new Array(nextFirstPart.content.length - 1).fill(undefined);
        nextFirstPart.hangs.unshift('start');

        corrected.add(key);
        continue;
      }

      // 2) 행말 걸침: 아래 줄 선행 닫기 부호 run을 위 줄 끝으로 당겨
      //    파트 우측 경계에 건다 — 렌더링 시 첫 부호는 폭의 50%만 밖으로
      //    돌출되고(반각 돌출, _computeCharOffsets), 이후 run은 스택형.
      if (
        cfg.lineEnd &&
        isHangableLineEnd(nextFirstPart.content[0]!) &&
        // word-wrap: 당겨올 글자가 워드 글자(alnum·조인터)면 걸침 교정을
        // 하지 않는다 — 워드 무결성 > 걸침. `undefined` prev의 `.`/`,`
        // 시작 잔여는 isWordChar 계약상 항상 false이므로 이 가드는
        // alnum 시작 잔여만 걸러낸다(조인터 시작 잔여는 eager lookahead상
        // 발생하지 않음).
        !(wordWrap &&
          isWordChar(undefined, nextFirstPart.content[0]!, nextFirstPart.content[1])) &&
        !curHasTab &&
        !nextHasTab &&
        isLastPartAtColumnRightEdge(curLine, columnWidth)
      ) {
        let run = 0;
        while (
          run < nextFirstPart.content.length &&
          isHangableLineEnd(nextFirstPart.content[run]!)
        ) {
          run++;
        }
        if (run > 0 && run < nextFirstPart.content.length) {
          for (let r = 0; r < run; r++) {
            const movedChar = nextFirstPart.content[0]!;
            const movedStyle = nextFirstPart.inlineStyles?.shift();
            nextFirstPart.hangs?.shift();
            nextFirstPart.content.shift();

            curLastPart.content.push(movedChar);
            if (curLastPart.inlineStyles) {
              curLastPart.inlineStyles.push(movedStyle);
            } else if (movedStyle !== undefined) {
              curLastPart.inlineStyles = new Array(curLastPart.content.length - 1).fill(undefined);
              curLastPart.inlineStyles.push(movedStyle);
            }
            curLastPart.hangs ??= new Array(curLastPart.content.length - 1).fill(undefined);
            curLastPart.hangs.push('end');
          }
          corrected.add(key);
        }
      }
    }
  }

  // 4) 행말 강제 걸침 (lineEnd: 'always'): 블록의 마지막 줄이 아닌 줄의
  //    끝에서, 이미 들어맞은 닫기 부호 run도 컬럼 우측 밖으로 내보낸다.
  //    글자 이동 없이 hangs 마킹만 추가한다. 페어 패스(케이스 2)가 당겨온
  //    run과 자연 병합된다 — 뒤에서 앞으로 스캔하며 연속 닫기 부호를
  //    한 번에 마킹한다.
  if (cfg.lineEndAlways) {
    for (let col = 0; col < columns.length; col++) {
      const columnContent = columns[col];
      const columnWidth = columnWidths[col] ?? 0;
      for (let i = 0; i < columnContent.length; i++) {
        const line = columnContent[i];
        // 블록의 마지막 줄(endOfBlock/endOfText)은 좌측 정렬로 렌더링되어
        // 우측 끝을 채우지 않는다 — 강제 걸침하면 텍스트 가장자리가
        // 어긋나므로 제외한다.
        if (line.endOfBlock === true || line.endOfText === true) continue;
        if (!isLastPartAtColumnRightEdge(line, columnWidth)) continue;

        const lastPart = line.parts[line.parts.length - 1];
        if (lastPart.content.includes(RIGHT_INDENT_TAB_CHAR)) continue;

        // 뒤에서 앞으로 연속 닫기 부호 run을 찾아 마킹한다.
        // 기존 hangs='end' 슬롯(케이스 2가 채운 것) 위에서 자연히
        // 멈춘다 — 마킹된 run은 이미 걸침 상태이므로 중복 마킹하지
        // 않고, 그 앞의 미마킹 부호만 추가로 걸친다.
        let k = lastPart.content.length - 1;
        while (k >= 0 && isHangableLineEnd(lastPart.content[k]!)) {
          if (lastPart.hangs?.[k] !== undefined) break;
          k--;
        }
        const runStart = k + 1;
        if (runStart === lastPart.content.length) continue;
        // 최소 1자의 visible 글자가 남아야 한다.
        if (runStart === 0) continue;
        // word-wrap: 마킹 대상 마지막 글자가 워드 글자면 skip — 강제
        // 분할로 인해 라인이 워드 글자로 끝나는 경우, 그 글자를 컬럼
        // 밖으로 내보내면 워드가 시각적으로 쪼개진다.
        if (wordWrap &&
          isWordChar(
            lastPart.content[runStart - 1],
            lastPart.content[lastPart.content.length - 1]!,
            undefined,
          )) {
          continue;
        }

        lastPart.hangs ??= new Array(lastPart.content.length).fill(undefined);
        for (let m = runStart; m < lastPart.content.length; m++) {
          lastPart.hangs[m] = 'end';
        }
        corrected.add(`${col}:${i}`);
      }
    }
  }

  // 5) 행두 걸침 (라인 첫 글자 열기 부호): 라인 시작 파트의 첫 글자가
  //    열기 부호면 좌측 밖으로 내보내 마킹한다 (CSS hanging-punctuation:
  //    first의 전 라인 확장 — 신문 조판 관례). 글자 이동은 없다.
  //    케이스 1이 이미 마킹한 슬롯은 건드리지 않는다. 가드: 첫 파트가
  //    컬럼 좌측 끝(left === 0)에서 시작, 탭 파트 제외, 잔여 1자 파트는
  //    마킹하면 visible 글자가 없어지므로 제외.
  if (cfg.lineStart) {
    for (let col = 0; col < columns.length; col++) {
      const columnContent = columns[col];
      for (let i = 0; i < columnContent.length; i++) {
        const line = columnContent[i];
        const firstPart = line.parts[0];
        if (firstPart === undefined || firstPart.content.length < 2) continue;
        if (firstPart.content[0] === RIGHT_INDENT_TAB_CHAR) continue;
        if (firstPart.content.includes(RIGHT_INDENT_TAB_CHAR)) continue;
        if (firstPart.left !== 0) continue;
        if (!isHangableLineStart(firstPart.content[0]!)) continue;
        if (firstPart.hangs?.[0] !== undefined) continue;

        firstPart.hangs ??= new Array(firstPart.content.length).fill(undefined);
        firstPart.hangs[0] = 'start';
        corrected.add(`${col}:${i}`);
      }
    }
  }
  return corrected;
}

/**
 * 컬럼별 걸침 돌출 폭(mm)을 산출한다.
 *
 * 걸침 글자는 컬럼 경계 밖(좌측 여백/컬럼 간 갭/문서 우측 여백)에
 * 렌더링되므로, 클릭 히트테스트(`getOffsetFromPoint`)의 컬럼 탐색
 * 게이트도 이 돌출 폭만큼 확장해야 한다. 돌출 폭은 라인 배치
 * 결과(`columnContents`의 `hangs` 마킹)에서 온디맨드로 계산한다 —
 * 레이아웃 캐시/프리픽스 캐시 어느 경로로 `_columnContents`가
 * 채워졌든 항상 현재 상태를 반영한다.
 *
 * @param ctx - 걸침 패스 컨텍스트 (measureChar로 폭 측정)
 * @returns 컬럼 인덱스별 `{ left, right }` 돌출 폭 (mm). 걸침 없는
 *   컬럼은 `{ left: 0, right: 0 }`
 * @throws 없음
 */
export function computeHangExtents(ctx: Pick<HangPassContext, "columns" | "columnWidths" | "measureChar">): HangExtent[] {
  const { columns, columnWidths, measureChar } = ctx;
  const extents = columnWidths.map(() => ({ left: 0, right: 0 }));
  for (let c = 0; c < columns.length; c++) {
    const column = columns[c];
    const ext = extents[c];
    if (!column || !ext) continue;
    for (const line of column) {
      for (const part of line.parts) {
        const hangs = part.hangs;
        if (hangs === undefined) continue;
        if (hangs[0] === "start") {
          const w = measureChar(part.content[0]!, part.inlineStyles?.[0]);
          if (w > ext.left) ext.left = w;
        }
        let runRight = 0;
        let firstHangOfRun = true;
        for (let k = part.content.length - 1; k >= 0 && hangs[k] === "end"; k--) {
          const w = measureChar(part.content[k]!, part.inlineStyles?.[k]);
          // 반각 돌출: 첫 부호는 폭의 50%만 밖으로 나가므로 나머지 절반 제외
          runRight += firstHangOfRun ? w * 0.5 : w;
          firstHangOfRun = false;
        }
        if (runRight > ext.right) ext.right = runRight;
      }
    }
  }
  return extents;
}