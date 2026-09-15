/**
 * 스레드 체인 재배치 오케스트레이션 공용 유틸 (C-1 통합).
 *
 * `LayoutDocumentElement`와 `LayoutPageElement`(독립 루트 폴백)가 각각 복사해
 * 유지하던 `_flushThreadRelayout`/`_syncThreadFramesToDom`의 본체 로직을
 * 단일 소스로 통합한다. 요소는 엔진 소스와 EditManager만 주입하고,
 * 재진입 차단·microtask 예약·affected 프레임 산출·writeback·DOM 동기화의
 * 의사결정은 이 유틸이 소유한다 (감사 C-1 — 양쪽 사본의 발산 원인 제거).
 *
 * 성능 계약 (감사 B-1):
 * - DOM 문단 조회는 1회 querySelectorAll + Map 구축으로 프레임당 선형 탐색을
 *   제거한다 (구 키 입력당 O(F×P) → O(P + F)).
 * - dirty 소진 assert는 DEV 빌드에서만 트리 순회를 수행한다 — 프로덕션 키
 *   입력 경로에서 전체 엔진 트리 순회를 제거한다.
 *
 * @file src/utils/thread-relayout-coordinator.ts
 */

import type { DocumentEngine } from "@/engine";
import { ParagraphEngine as PEClass } from "@/engine";
import type { LayoutParagraphElement } from "@/components";

/** flush 실행 컨텍스트 — 요소별로 달라지는 2개 소스만 주입한다. */
export interface ThreadRelayoutContext {
  /** 스레드 소유 엔진 (document 엔진 또는 독립 루트의 위임 엔진) */
  engine: DocumentEngine | undefined;
  /** 포커스 문단 id getter (pinned 전달용). 없으면 undefined */
  focusedParagraphId: string | undefined;
  /** 문서/페이지 요소 스코프의 전체 문단 순회 */
  queryParagraphs(): Iterable<LayoutParagraphElement>;
}

/** flush 종료 시 영향 프레임 dirty 소진 검사를 수행할지 (기본 false). */
export const THREAD_RELAYOUT_ASSERT = (() => {
  try {
    const g = globalThis as Record<string, unknown>;
    return g.__LAYOUT_ELEMENT_DEBUG_THREAD_FLUSH__ === true;
  } catch {
    return false;
  }
})();

/**
 * 예약된 스레드 체인 재배치를 실행한다 (document/page 공용 본체).
 *
 * 1. story writeback + 체인 재배치 — `engine.relayoutThreads(sources, pinned)`
 * 2. 스레드 프레임 DOM model 동기화 (Map 조회 — O(P) 1회 구축)
 * 3. 실제 배치된 프레임 중 소스를 제외한 DOM 재렌더 (소스는 편집 파이프라인이
 *    렌더). `laidOutFrameIds`가 없는 결과(전체 스킵 등)가 하나라도 있으면
 *    기존 동작(영향 프레임 전체)으로 폴백한다.
 *
 * @param ctx - 엔진·포커스 소스
 * @param sources - 편집이 발생한 프레임 id 집합
 */
export function flushThreadRelayout(ctx: ThreadRelayoutContext, sources: Set<string>): void {
  const engine = ctx.engine;
  const threads = engine?.data.threads;
  if (!engine || !threads || threads.length === 0) return;

  const affectedFrames = new Set<string>();
  for (const thread of threads) {
    const frameIds = thread.paragraphIds ?? [];
    if (!frameIds.some(id => sources.has(id))) continue;
    for (const id of frameIds) affectedFrames.add(id);
  }
  if (affectedFrames.size === 0) return;

  const focusedId = ctx.focusedParagraphId;
  const pinned = focusedId !== undefined && focusedId !== ''
    ? new Set<string>([focusedId])
    : undefined;
  const results = engine.relayoutThreads(sources, pinned);
  syncThreadFramesToDom(ctx);

  const correctedFrames = new Set<string>();
  let laidOut: Set<string> | null = new Set<string>();
  for (const result of results) {
    for (const id of result.correctedFrames ?? []) correctedFrames.add(id);
    if (result.laidOutFrameIds === undefined) {
      laidOut = null;
    } else if (laidOut !== null) {
      for (const id of result.laidOutFrameIds) laidOut.add(id);
    }
  }
  const renderSet = laidOut ?? affectedFrames;
  const domById = buildDomParagraphMap(ctx);
  for (const frameId of renderSet) {
    if (sources.has(frameId) && !correctedFrames.has(frameId)) continue;
    const domPe = domById.get(frameId);
    if (domPe) {
      domPe.render();
    }
  }

  // dirty 소진 assert — debug 게이트 (B-1b: 프로덕션 키 입력 경로의 트리
  // 순회 제거). 온 상태에서만 findEnginesByIds(전체 트리 순회)를 수행한다.
  if (THREAD_RELAYOUT_ASSERT) {
    const pendingLookup = engine.findEnginesByIds(affectedFrames);
    for (const frameId of affectedFrames) {
      const pe = pendingLookup.get(frameId);
      if (pe instanceof PEClass && pe.hasPendingChanges) {
        console.error(
          `[layout-element] thread relayout incomplete: frame ${frameId} still has pending changes after flush`,
        );
      }
    }
  }
}

/**
 * 스레딩 프레임 DOM model을 엔진 트리 PE(스레드 배치 완료 상태)로 동기화한다
 * (document/page 공용 본체).
 *
 * @param ctx - 스레드 소유 엔진이 있는 컨텍스트
 */
export function syncThreadFramesToDom(ctx: ThreadRelayoutContext): void {
  const engine = ctx.engine;
  const threads = engine?.data.threads;
  if (!engine || !threads || threads.length === 0) return;

  const frameIds = new Set<string>();
  for (const thread of threads) {
    for (const frameId of thread.paragraphIds ?? []) {
      if (frameId) frameIds.add(frameId);
    }
  }
  const engineLookup = engine.findEnginesByIds(frameIds);

  const domById = buildDomParagraphMap(ctx);
  const synced = new Set<string>();
  for (const thread of threads) {
    for (const frameId of thread.paragraphIds ?? []) {
      if (synced.has(frameId)) continue;
      synced.add(frameId);
      const enginePe = engineLookup.get(frameId);
      if (!(enginePe instanceof PEClass) || !enginePe.isThreadFrame) continue;
      const domPe = domById.get(frameId);
      if (domPe) {
        domPe.syncThreadEngine(enginePe);
      }
    }
  }
}

/**
 * 스레드 프레임 중 엔진 트리 PE가 아직 스레드 배치가 적용되지 않은 것이 있는지
 * (document/page 공용 본체).
 *
 * 프레임 전체를 `findEnginesByIds` 일괄 조회로 검사한다 — 프레임당
 * `findEngineById`(전체 엔진 트리 탐색)를 반복하면 검사 자체가 O(트리×F)가
 * 되므로(감사 결함 1 수정 방향 b), 트리 순회 1회로 줄인다.
 *
 * @param ctx - 스레드 소유 엔진이 있는 컨텍스트
 * @returns 미적용 스레드 프레임이 있으면 true
 */
export function hasUnsyncedThreadFrames(ctx: ThreadRelayoutContext): boolean {
  const engine = ctx.engine;
  const threads = engine?.data.threads;
  if (!engine || !threads || threads.length === 0) return false;
  const frameIds = new Set<string>();
  for (const thread of threads) {
    for (const frameId of thread.paragraphIds ?? []) {
      if (frameId) frameIds.add(frameId);
    }
  }
  if (frameIds.size === 0) return false;
  const engineLookup = engine.findEnginesByIds(frameIds);
  for (const frameId of frameIds) {
    const enginePe = engineLookup.get(frameId);
    if (enginePe instanceof PEClass && !enginePe.isThreadFrame) {
      return true;
    }
  }
  return false;
}

/**
 * 컨텍스트 스코프의 문단 요소를 id → 요소 Map으로 구축한다 (B-1a).
 * querySelectorAll 1회 + O(P) 구축 — 프레임당 Array.find O(P)를 O(1) 조회로
 * 교체한다.
 *
 * @param ctx - 문단 스코프 (document 또는 page 요소)
 * @returns id → 문단 요소 맵
 */
function buildDomParagraphMap(ctx: ThreadRelayoutContext): Map<string, LayoutParagraphElement> {
  const map = new Map<string, LayoutParagraphElement>();
  for (const p of ctx.queryParagraphs()) {
    if (p.id) map.set(p.id, p);
  }
  return map;
}