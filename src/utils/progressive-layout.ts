/**
 * ③′ 시분할 프로그레시브 레이아웃 — 옵션 리졸버 + 청크 스케줄링 프리미티브.
 *
 * 초기 로드·풀 리플로우의 **표시 패스(렌더)**를 페이지 단위 청크로 분할한다.
 * 엔진 구축(`page.layout()`)은 동기 유지 — `document.layout()`이 반환되는
 * 시점에 엔진 트리·스레드 배치·`extractData`/`printPostData`가 완결된다.
 * 시분할은 표시(pass of `page.render()`)만 담당하므로 각 청크의 동기 계약
 * (`renderText`의 즉시 `columnContents` 읽기, `flushRender`)은 기존과 동일하다.
 *
 * 스케줄링 선택 근거 (VIRTUALIZATION §3 — Web Worker 실패 역사 + §7.1 실측):
 * - `queueMicrotask`: 렌더링으로 양보하지 않으므로 실격 — 세션이 하나의 롱태스크가 된다.
 * - `requestIdleCallback`: 배경 탭에서 starve (fallback 없으면 세션이 완결되지 않는다).
 * - `setTimeout(0)` + 인라인 시간 예산: 예측 가능하고 환경 무관. 300p 기준
 *   페이지당 렌더 ~0.83ms(헤드리스) → 예산 8ms면 청크당 ~9페이지, 31청크 ≈ 400ms.
 *
 * 테스트 훅: `globalThis.__LAYOUT_ELEMENT_PROGRESSIVE_IDLE__`를 지정하면
 * yield가 즉시 resolve된다 (검증 스크립트에서 타이밍 의존 제거).
 *
 * @example
 * ```ts
 * // 문서 요소가 progressive 표시 패스를 펌프할 때
 * for (;;) {
 *   while (queue.size && performance.now() - t0 < PROGRESSIVE_CHUNK_BUDGET_MS) {
 *     const id = queue.keys().next().value;
 *     queue.delete(id);
 *     // ... el.render() 등 청크 작업
 *   }
 *   if (!queue.size) break;
 *   await progresssiveIdleYield(); // 다음 태스크로 양보
 * }
 * ```
 */

/** 문서 요소의 progressive 옵션 해석 결과. */
export interface ProgressiveLayoutResolvedOptions {
  /** 시분할 활성 여부 (`progressive: false` → 스케줄링 없음, 동기 경로 유지) */
  readonly enabled: boolean;
  /** 청크 사이 양복 지연 (setTimeout 지연 ms). 0이면 다음 태스크 즉시. */
  readonly chunkDelayMs: number;
  /** 한 청크의 동기 작업 예산 (ms). 초과 시 다음 태스크로 양보. */
  readonly chunkBudgetMs: number;
}

/** 기본 청크 예산 — 60fps 프레임의 절반 (타이핑 커밋과 겹쳐도 롱태스크 회피). */
export const PROGRESSIVE_CHUNK_BUDGET_MS = 8;

/** 기본 청크 간 지연 — setTimeout(0)은 중첩 깊이 5 이후 ~4ms로 클램프된다. */
export const PROGRESSIVE_CHUNK_DELAY_MS = 0;

/**
 * `progressive` 프로퍼티 값을 스케줄링 옵션으로 환산한다.
 *
 * - `undefined` → 비활성 (기존 동기 경로, byte-identical)
 * - `false` → 비활성
 * - `true` → 활성 (기본 예산/지연)
 * - 숫자 → 활성 + 사용자 지정 청크 간 지연 (음수·NaN은 기본값)
 *
 * @param progressive - 문서 요소에 주입된 원본 값
 * @returns 정규화된 스케줄링 옵션
 * @throws 없음 — 모든 입력을 정규화하여 반환한다
 * @example
 * ```ts
 * const opts = resolveProgressiveOptions(element.progressive);
 * if (opts.enabled) { /* 시분할 표시 패스 *\/ }
 * ```
 */
export function resolveProgressiveOptions(
  progressive: boolean | undefined,
): ProgressiveLayoutResolvedOptions {
  if (progressive !== true) {
    return { enabled: false, chunkDelayMs: 0, chunkBudgetMs: PROGRESSIVE_CHUNK_BUDGET_MS };
  }
  return {
    enabled: true,
    chunkDelayMs: PROGRESSIVE_CHUNK_DELAY_MS,
    chunkBudgetMs: PROGRESSIVE_CHUNK_BUDGET_MS,
  };
}

/**
 * 청크 사이의 양보 Promise. 테스트 훅(`__LAYOUT_ELEMENT_PROGRESSIVE_IDLE__ === true`)
 * 이면 즉시 resolve되어 검증 스크립트가 실측 타이밍 없이 세션을 관찰할 수 있다.
 *
 * @param delayMs - 청크 간 지연 (ms)
 * @returns 다음 태스크로 양보가 완료된 후 resolve되는 Promise
 * @example
 * ```ts
 * // 대용량 문서 초기 로드 중 청크 사이
 * await progressiveIdleYield(options.chunkDelayMs);
 * ```
 */
export function progressiveIdleYield(delayMs: number): Promise<void> {
  const g = globalThis as { __LAYOUT_ELEMENT_PROGRESSIVE_IDLE__?: boolean };
  if (g.__LAYOUT_ELEMENT_PROGRESSIVE_IDLE__ === true) {
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    setTimeout(() => resolve(), Math.max(0, delayMs));
  });
}