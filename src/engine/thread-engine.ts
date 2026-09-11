/**
 * 스레딩 오케스트레이터 (Node.js 호환, DOM-free).
 *
 * 문서의 각 `ThreadData`를 프레임 순서대로 순회하며 텍스트를 feed-forward한다:
 * 1. head 프레임이 story 전체 콘텐츠를 소유 (`textContent = thread.content`)
 * 2. head `layoutText()` 실행 → `overflowContent` tail 산출
 * 3. tail을 다음 프레임에 `textContent`로 주입 + `updateThreadContext({ contentFrom })`
 * 4. 마지막 프레임의 tail은 thread 자체 오버플로우 (수용 불가)
 *
 * pull-back(이전 프레임에 여유가 생겨 다음 프레임 텍스트가 당겨지는)은
 * head가 항상 전체 story를 소유하므로 재배치가 자연히 당겨온다.
 *
 * @file src/engine/thread-engine.ts
 */

import type { ThreadData } from "@/types";
import type { ParagraphEngine } from "./paragraph-engine";
import { isLineStartForbidden, isLineEndForbidden, isWordChar } from "@/constants/line-break";

/**
 * 스레드 프레임 순차 배치 결과.
 */
export interface ThreadLayoutResult {
  /** 스레드 id */
  threadId?: string;
  /** 배치 완료된 프레임 문단 id 목록 */
  frames: string[];
  /** 수용되지 않은 tail이 남은 마지막 프레임 id. 전부 수용되면 undefined */
  oversetAt?: string;
  /** 입력 불변으로 재배치를 스킵했으면 true (변경 감지 성능 최적화) */
  skipped?: boolean;
  /** 경계 교정 clamp로 재배치된 프레임 id (DOM 재렌더 대상 통지용) */
  correctedFrames?: string[];
}

/**
 * 스레딩 오케스트레이터. `create()` 팩토리로만 생성한다.
 */
export class ThreadEngine {
  /**
   * 스레드별 마지막 배치 입력 시그니처 (변경 감지 캐시).
   * 프레임 엔진 textContent 참조는 배열 인덱스(프레임 순서)로 매핑한다 —
   * 재배치마다 story 전체를 직렬화하는 해시 구성 비용(R3)을 참조 비교로
   * 대체하기 위해서다. contentFrom 연쇄는 각 프레임 게터에서 읽는다.
   */
  private readonly _lastInputByThread = new Map<string, unknown[]>();

  private constructor() {}

  /**
   * 정적 팩토리 메서드.
   *
   * @returns ThreadEngine 인스턴스
   */
  public static create(): ThreadEngine {
    return new this();
  }

  /**
   * 문서 스레드 데이터를 검증한다.
   *
   * - 프레임 id가 1개 미만이면 유효하지 않음
   * - 중복 프레임 id 금지 (한 문단은 최대 1개 thread 소속)
   *
   * 중복 제거가 필요한 스레드만 새 객체를 만들고, 나머지는 **원본 객체
   * 참조를 그대로 반환**한다 — story writeback(`relayoutThreads`)이
   * `engine.data.threads`의 원본에 기록되어야 하므로 객체 identity가
   * 보존되어야 한다.
   *
   * @param threads - 검증할 스레드 배열
   * @returns 유효한 스레드 배열 (무효 항목 제외)
   */
  public static validate(threads: ThreadData[] | undefined): ThreadData[] {
    if (!threads || !Array.isArray(threads)) return [];
    const seen = new Set<string>();
    const valid: ThreadData[] = [];
    for (const thread of threads) {
      const ids = (thread.paragraphIds ?? []).filter(Boolean);
      if (ids.length < 1) continue;
      const unique = ids.filter(id => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (unique.length < 1) continue;
      valid.push(unique.length === ids.length ? thread : { ...thread, paragraphIds: unique });
    }
    return valid;
  }

  /**
   * 문단 id로 ParagraphEngine을 찾는다.
   * 스레드 프레임은 테이블 셀 내부에도 존재할 수 있으므로 문서 트리 전체를
   * 재귀 순회한다.
   *
   * @param id - 문단 id
   * @returns 일치하는 ParagraphEngine 또는 undefined
   */
  private _findParagraphEngine(
    findEngineById: (id: string) => { extractData?: unknown } | undefined,
    id: string,
  ): ParagraphEngine | undefined {
    const found = findEngineById(id);
    return found as ParagraphEngine | undefined;
  }

  /**
   * 문서의 모든 스레드를 순차 배치한다.
   *
   * 각 스레드에 대해:
   * 1. 프레임 엔진들을 문서 트리에서 조회 (누락 프레임은 스킵)
   * 2. head 프레임의 `textContent`를 story 전체로 갱신 (pull-back의 근거)
   * 3. 프레임 순서대로 `layoutText()` → tail을 다음 프레임에 주입
   *
   * @param threads - 문서 스레드 배열 (검증 후)
   * @param findEngineById - 엔진 트리 id 검색 함수 (DocumentEngine.findEngineById)
   * @returns 스레드별 배치 결과 배열
   */
  public layoutThreads(
    threads: ThreadData[],
    findEngineById: (id: string) => { extractData?: unknown } | undefined,
  ): ThreadLayoutResult[] {
    // validate와 동일한 first-claim-wins로 프레임 소속을 확정한다 —
    // 한 프레임이 여러 thread에 중복 소속되면 첫 유효 thread만 소유한다.
    // 소속이 확정되지 않으면 (a) head의 textContent를 다른 thread의 story로
    // 덮어쓰거나 (b) 다른 thread 소유 프레임의 배치를 재배치해 story 소실이
    // 발생한다 (writeback 방어와 짝을 이루는 소유권 단일 소스).
    const seenFrames = new Set<string>();
    const valid = ThreadEngine.validate(threads).map(thread => {
      const ids = (thread.paragraphIds ?? []).filter(id => !seenFrames.has(id));
      for (const id of ids) seenFrames.add(id);
      return ids.length === (thread.paragraphIds ?? []).length
        ? thread
        : { ...thread, paragraphIds: ids };
    }).filter(thread => (thread.paragraphIds ?? []).length > 0);
    if (valid.length === 0) return [];

    const results: ThreadLayoutResult[] = [];
    for (const thread of valid) {
      const result = this._layoutOneThread(thread, findEngineById);
      results.push(result);
    }
    return results;
  }

  /**
   * 단일 스레드를 순차 배치한다.
   *
   * @param thread - 대상 스레드
   * @param findEngineById - 엔진 트리 id 검색 함수
   * @returns 배치 결과
   */
  private _layoutOneThread(
    thread: ThreadData,
    findEngineById: (id: string) => { extractData?: unknown } | undefined,
  ): ThreadLayoutResult {
    const frameIds = thread.paragraphIds ?? [];
    const engines: ParagraphEngine[] = [];
    for (const frameId of frameIds) {
      const engine = this._findParagraphEngine(findEngineById, frameId);
      if (engine && this._isParagraphEngine(engine)) {
        engines.push(engine);
      }
    }
    if (engines.length === 0) {
      return { threadId: thread.id, frames: [] };
    }

    // 1. 모든 프레임이 story 전체를 textContent로 소유한다.
    //    배치 시작점은 contentFrom(plain 오프셋) 단일 소스로 제어한다 —
    //    tail 슬라이싱 주입과 contentFrom 스킵을 함께 쓰면 이중으로 건너뛴다.
    //    head의 contentFrom = 0 (pull-back의 근거: story 축소 시 이후 프레임이
    //    자연히 비워진다).
    const head = engines[0];
    const storyContent = thread.content ?? head.textContent;
    for (const engine of engines) {
      if (engine.textContent !== storyContent) {
        engine.textContent = storyContent;
      }
    }

    // 1.5 변경 감지 (참조 동등성 — 해시 직렬화 비용 0):
    //    (a) 전 프레임이 story 전체를 동일 참조로 소유
    //    (b) 전 프레임 contentFrom이 이전 배치의 연쇄와 동일
    //    (c) 전 프레임 hasLayoutCache — 배치 입력이 바뀌면 data setter가
    //        resetIncrementalState()로 캐시를 지우므로, 캐시 존재가
    //        "지오메트리·스타일·오버랩·story 모두 불변"의 증명이다.
    //    세 조건이 성립하면 updateThreadContext+layoutText를 통째로
    //    스킵한다 — layoutText의 내부 캐시 히트조차 해시 문자열 구성
    //    비용(story 전체 직렬화, 프레임당)을 지불하므로 (R3).
    const threadKey = thread.id ?? frameIds.join('\u0000');
    const lastInput = this._lastInputByThread.get(threadKey);
    if (lastInput !== undefined
      && this._threadInputUnchanged(engines, lastInput)) {
      const placedFrames = engines.map(e => e.id ?? '');
      const oversetAt = engines[engines.length - 1].isThreadTail
        && engines[engines.length - 1].overflowContentFrom >= 0
        ? placedFrames[placedFrames.length - 1]
        : undefined;
      return { threadId: thread.id, frames: placedFrames, oversetAt, skipped: true };
    }

    // 2. 순차 feed-forward 배치 — 이전 프레임의 tail 오프셋이 다음 시작점.
    //    threadTail: 중간 프레임의 overflow는 다음 프레임으로 흘러 소비되므로
    //    오류가 아니다. 마지막 프레임(또는 소진 지점)만 tail로 마킹한다.
    const storyPlainLen = head.totalChars;
    const placedFrames: string[] = [];
    const correctedFrames: string[] = [];
    const contentFromChain: number[] = [];
    let oversetAt: string | undefined;
    let contentFrom = 0;
    let exhausted = false;

    for (let i = 0; i < engines.length; i++) {
      const engine = engines[i];
      const isLastFrame = i === engines.length - 1;
      if (exhausted) {
        // story 소진 — 잔여 프레임은 story 끝부터 시작해 배치 대상이 없다
        // (pull-back: 축소된 story의 이전 배치 결과를 비운다).
        // threadTail은 마지막 프레임에만 마킹한다 — 소진 경로의 중간
        // 프레임까지 tail로 마킹하면 체인에 tail이 여러 개 생겨
        // "tail 정확히 1개" 계약(RULES §1.10)이 깨진다.
        engine.updateThreadContext({ contentFrom: storyPlainLen, isThreadFrame: true, threadTail: isLastFrame });
        engine.layoutText();
        contentFromChain.push(engine.contentFrom);
        continue;
      }

      // 1.75 프레임 경계 금칙 교정 (P2-9/10) — 직전 프레임의 tail과 이번
      // 프레임의 시작이 라인 경계를 이룬다. 프레임 배치는 독립 실행되므로
      // `_applyLineBreakRules`가 이 경계를 교정하지 못한다.
      //
      // 교정은 **배치 입력 인코딩**(단일소스)이다: prev의 배치 상한
      // (tailClampFrom)을 지정해 **재배치**하면 prev tail이 clamp 위치에서
      // 재산출되고, 이번 프레임의 contentFrom은 그 tail을 그대로 받으므로
      // 체인 무중복이 구조적으로 성립한다. 출력(columnContents)을 사후
      // 변이하는 방식(shiftVisibleTail)은 charOffsets 재산출을 우회해
      // getCharRect/print 좌표를 붕괴시키므로 금지한다 (엔진우선 원칙).
      // clamp는 prev가 이번 contentFrom까지 배치한 상태에서 시작하므로
      // clamp만 줄이면 tail이 그만큼 당겨진다 (단방향 수렴, cap 2회).
      if (i > 0 && contentFrom > 0) {
        const prevEngine = engines[i - 1];
        let clamp = contentFrom;
        let corrected = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          const pull = this._boundaryCorrection(prevEngine, engine, clamp);
          if (pull === 0) break;
          clamp -= pull;
          if (clamp <= prevEngine.contentFrom) { clamp = prevEngine.contentFrom; break; }
          prevEngine.updateThreadContext({ tailClampFrom: clamp });
          prevEngine.layoutText();
          corrected = true;
        }
        if (corrected && prevEngine.id) correctedFrames.push(prevEngine.id);
        // prev 재배치 확정 — clamp가 풀리지 않았다면 이번 프레임 시작은
        // prev의 새 tail이다. prev가 clamp 해제(소진 등)면 contentFrom 유지.
        const newTail = prevEngine.overflowContentFrom;
        if (clamp !== contentFrom && newTail >= 0) {
          contentFrom = newTail;
        } else {
          contentFrom = clamp;
        }
      }

      engine.updateThreadContext({ contentFrom, isThreadFrame: true, threadTail: isLastFrame });
      engine.layoutText();
      contentFromChain.push(engine.contentFrom);

      const engineId = engine.id ?? '';
      const nextFrom = engine.overflowContentFrom;
      if (nextFrom >= 0 && !isLastFrame) {
        contentFrom = nextFrom;
        placedFrames.push(engineId);
      } else {
        if (nextFrom >= 0) {
          oversetAt = engineId;
        } else {
          // tail 없음 = story 소진 — 남은 프레임을 이후 이터레이션의
          // exhausted 경로에서 빈 배치로 확정한다 (break하지 않는다).
          exhausted = true;
        }
        placedFrames.push(engineId);
      }
    }

    // 배치 후 다음 스킵 판정용 시그니처를 기록한다 — story 참조 +
    // 이번에 확정된 contentFrom 연쇄. 프레임별 hasLayoutCache는 판정 시점에
    // 게터로 읽는다 (배치 직후 캐시 존재, 이후 data setter가 지우면
    // 다음 판정이 실패해 재배치된다).
    this._lastInputByThread.set(threadKey, [storyContent, ...contentFromChain]);

    return { threadId: thread.id, frames: placedFrames, oversetAt, correctedFrames: correctedFrames.length > 0 ? correctedFrames : undefined };
  }

  /**
   * 스레드 배치 입력이 이전 배치와 동일한지 판정한다 (스킵 가능 여부).
   *
   * @param engines - 프레임 엔진 배열 (스레드 순서)
   * @param lastInput - 이전 배치의 시그니처: [story 참조, contentFrom...]
   * @returns 입력이 불변이면 true
   */
  private _threadInputUnchanged(engines: ParagraphEngine[], lastInput: unknown[]): boolean {
    if (engines.length !== lastInput.length - 1) return false;
    const storyRef = lastInput[0];
    for (let i = 0; i < engines.length; i++) {
      const engine = engines[i];
      if (engine.textContent !== storyRef) return false;
      if (engine.contentFrom !== lastInput[i + 1]) return false;
      if (!engine.hasLayoutCache) return false;
      if (!engine.isThreadFrame) return false;
    }
    return true;
  }

  /**
   * 프레임 경계 금칙·워드 교정량을 계산한다.
   *
   * 프레임 경계(직전 프레임 마지막 visible 라인 ↔ 이번 프레임 첫 라인)는
   * 라인 경계와 동일한 금칙 시맨틱을 따른다 — 프레임 배치가 독립 실행되므로
   * `_applyLineBreakRules`가 이 경계를 보지 못해, ThreadEngine이 경계에서만
   * 교정한다. 이동은 追い出し 단방향(직전 프레임의 마지막 visible 글자를
   * contentFrom 앞으로 내보냄)이므로 head는 길어지지 않고 재배치가 유한
   * 수렴한다. 워드 글자는 이동하지 않는다 (워드 무결성 > 금칙 — 기존
   * 컨벤션의 경계 판).
   *
   * @param prevEngine - 직전 프레임 엔진 (배치 완료 상태)
   * @param nextEngine - 이번 프레임 엔진 (아직 이번 배치 전 — 이전 배치 상태)
   * @param contentFrom - 이번 프레임의 예상 시작 오프셋 (prev tail)
   * @returns contentFrom에서 빼야 할 이동 글자 수 (0이면 교정 없음)
   */
  private _boundaryCorrection(
    prevEngine: ParagraphEngine,
    nextEngine: ParagraphEngine,
    contentFrom: number,
  ): number {
    if (contentFrom <= 0) return 0;

    // 이번 프레임의 "첫 배치 글자" — 이번 배치는 아직이므로 story에서
    // contentFrom 위치의 글자를 직접 읽는다 (스레드 프레임은 story 전체를
    // textContent로 소유하므로 plain 인덱싱이 정확하다).
    const plain = nextEngine.plainText;
    const nextFirst = plain[contentFrom];
    if (nextFirst === undefined) return 0;

    const prevLast = this._lastVisibleChar(prevEngine);
    if (prevLast === undefined) return 0;

    // 행말금칙: prev가 열기 부호로 끝남 → 마지막 글자를 next로 내보낸다.
    if (isLineEndForbidden(prevLast)) {
      if (isWordChar(undefined, prevLast, nextFirst)) return 0;
      return 1;
    }
    // 행두금칙: next가 닫기 부호로 시작함 → prev 마지막 일반 글자와 닫기
    // 부호를 함께 내보낸다 (追い出し — 라인 경계의 `_applyLineBreakRules`가
    // outChar 뒤에 금칙 글자를 붙여 내보내는 것과 동일 시맨틱). 1자만
    // 내보내면 next 행두가 여전히 금칙 글자다.
    if (isLineStartForbidden(nextFirst)) {
      const prevSecond = this._secondLastVisibleChar(prevEngine);
      if (prevSecond !== undefined && isWordChar(prevSecond, prevLast, nextFirst)) {
        // 워드 무결성 > 금칙: 내보낼 prev 마지막 글자가 워드를 구성하면
        // 교정을 건너뛴다 (행두 위반 잔존 허용 — 기존 라인 경계 규칙과 동일).
        return 0;
      }
      if (prevLast !== undefined && isLineStartForbidden(prevLast)) {
        // prev 마지막 글자 자체가 닫기 부호면 이미 "붙을 짝"이 없다 —
        // 이동 없음 (무한 이동 방지).
        return 0;
      }
      return 2;
    }
    return 0;
  }

  /**
   * 마지막 visible 라인의 마지막 글자 (경계 금칙 판정용).
   *
   * @param engine - 배치 완료 상태의 프레임 엔진
   * @returns 마지막 visible 글자 (없으면 undefined)
   */
  private _lastVisibleChar(engine: ParagraphEngine): string | undefined {
    const line = engine.lastVisibleLine;
    if (line === undefined) return undefined;
    for (let p = line.parts.length - 1; p >= 0; p--) {
      const part = line.parts[p];
      if (part.content.length > 0) return part.content[part.content.length - 1];
    }
    return undefined;
  }

  /**
   * 마지막 visible 라인의 끝에서 두 번째 글자 (워드 가드 판정용).
   *
   * @param engine - 배치 완료 상태의 프레임 엔진
   * @returns 끝에서 두 번째 visible 글자 (없으면 undefined)
   */
  private _secondLastVisibleChar(engine: ParagraphEngine): string | undefined {
    const line = engine.lastVisibleLine;
    if (line === undefined) return undefined;
    const chars: string[] = [];
    for (const part of line.parts) chars.push(...part.content);
    return chars.length >= 2 ? chars[chars.length - 2] : undefined;
  }

  /**
   * duck-type 판정: ParagraphEngine인지 (instanceof 회피 — 순환 import 방지).
   *
   * @param engine - 판정 대상 엔진
   * @returns ParagraphEngine이면 true
   */
  private _isParagraphEngine(engine: unknown): engine is ParagraphEngine {
    const candidate = engine as Partial<ParagraphEngine>;
    return typeof candidate.layoutText === 'function'
      && typeof candidate.updateThreadContext === 'function'
      && 'columnContents' in candidate;
  }
}

