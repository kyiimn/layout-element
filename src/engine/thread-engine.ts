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

import type { ThreadData, TextInlineData } from "@/types";
import type { ParagraphEngine } from "./paragraph-engine";

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
}

/**
 * 스레딩 오케스트레이터. `create()` 팩토리로만 생성한다.
 */
export class ThreadEngine {
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
    const valid = ThreadEngine.validate(threads);
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

    // 2. 순차 feed-forward 배치 — 이전 프레임의 tail 오프셋이 다음 시작점.
    //    threadTail: 중간 프레임의 overflow는 다음 프레임으로 흘러 소비되므로
    //    오류가 아니다. 마지막 프레임(또는 소진 지점)만 tail로 마킹한다.
    const storyPlainLen = plainLength(storyContent);
    const placedFrames: string[] = [];
    let oversetAt: string | undefined;
    let contentFrom = 0;
    let exhausted = false;

    for (let i = 0; i < engines.length; i++) {
      const engine = engines[i];
      const isLastFrame = i === engines.length - 1;
      if (exhausted) {
        // story 소진 — 잔여 프레임은 story 끝부터 시작해 배치 대상이 없다
        // (pull-back: 축소된 story의 이전 배치 결과를 비운다).
        engine.updateThreadContext({ contentFrom: storyPlainLen, isThreadFrame: true, threadTail: true });
        engine.layoutText();
        continue;
      }
      engine.updateThreadContext({ contentFrom, isThreadFrame: true, threadTail: isLastFrame });
      engine.layoutText();

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

    return { threadId: thread.id, frames: placedFrames, oversetAt };
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

/**
 * 콘텐츠의 plain 길이(`\n` 포함 편집 공간)를 계산한다.
 *
 * @param content - 콘텐츠 (string 또는 인라인 런 배열)
 * @returns plain 길이
 */
function plainLength(content: string | (string | TextInlineData)[] | undefined): number {
  if (content === undefined) return 0;
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const item of content) {
    total += typeof item === 'string' ? item.length : item.content.length;
  }
  return total;
}