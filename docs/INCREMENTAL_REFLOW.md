# INCREMENTAL_REFLOW.md — 스레드 체인 재배치(flush) 라이프사이클

타이핑 → 체인 재배치 → DOM 동기의 파이프라인 계약. 스레딩의 기본 메커니즘(story 단일 소스,
범위-증명 스킵, 프레임 경계 교정)은 `RULES.md §1.10`과 `docs/TEXT_ENGINE.md` 스레딩 장을
참조하고, 이 문서는 **재배치 요청 → flush 실행의 스케줄링 계약**을 소유한다.

## 1. flush 파이프라인 개요

```
편집(타이핑/붙여넣기/IME 커밋)
  → controller가 engine PE 갱신 (textContent setter, dirty)
  → LayoutDocumentElement.requestThreadRelayout(sourceFrameId)   [또는 page.element의 독립 루트 폴백]
  → (microtask 통합 — 틱 내 다중 소스를 1개 Set으로 병합)
  → _flushThreadRelayout(sources)
      → flushThreadRelayout(coordinator)                          [src/utils/thread-relayout-coordinator.ts]
          1. writeback: engine.relayoutThreads(sources, pinned)
             - _writebackThreadStory: 소스 frame textContent → threads[].content (first-claim-wins)
             - ThreadEngine._layoutOneThread: step-1 참조 신선화(A-6) → 변경 감지 스킵
               → step-2 feed-forward + 범위-증명 스킵 + 경계 금칙 교정(tailClampFrom)
          2. syncThreadFramesToDom: DOM model ← 엔진 트리 PE 이관
          3. 영향 프레임 재렌더 (소스 프레임은 편집 파이프라인이 렌더 — 제외)
      → (debug 게이트 THREAD_RELAYOUT_ASSERT에서만) dirty 소진 assert
```

## 2. flush 재진입 계약 — "flush 중 파생 relayout은 다음 microtask로 이월된다" (E-2)

### 계약 본문

**flush 실행 중 파생되는 `requestThreadRelayout`은 이번 flush에 재진입하지 않고
다음 microtask로 이월된다.** 소유자는 **요소별 인스턴스 상태**
(`_threadRelayoutFlushing` — `LayoutDocumentElement`/`LayoutPageElement` 각각 보유)
이며, 공용 coordinator(`flushThreadRelayout`)가 아니다. coordinator는 상태를
소유하지 않는다 — document와 page(독립 루트 폴백)가 동시에 존재할 수 있고,
flush는 항상 **소유 요소의 컨텍스트**로 실행되기 때문이다.

### 왜 요소가 소유하는가

- `requestThreadRelayout`은 요소 메서드다 — 예약 큐(`_threadRelayoutSources`)와
  재진입 게이트가 같은 요소 인스턴스에 있어야 소스 수집과 차단이 원자적으로 묶인다.
- coordinator(`flushThreadRelayout`)는 주입 컨텍스트(`ThreadRelayoutContext`)만
  소비하는 순수 함수다 — 플래그를 넣으면 요소별 재진입 상태가 coordinator로
  누수되어 C-1의 "요소는 엔진 소스와 EditManager만 주입" 계약이 깨진다.
- flush 종료 시 dirty 잔존 검사(`THREAD_RELAYOUT_ASSERT`, dev 옵트인)가
  "플래그로 차단된 파생 relayout이 유실되지 않았는지"를 검증한다 — 차단은
  유실이 아니라 **이월**임을 이 assert가 증명한다 (체인 dirty 전부 소진 계약).

### 이월 시맨틱

```
microtask A: _flushThreadRelayout(sources={p0})  ← _threadRelayoutFlushing = true
                flush 중 재렌더 → requestThreadRelayout('p1') 호출
                → 기존 Set에 add는 되지만(같은 microtask 예약은 이미 소비 중)
                  flush 재진입은 _threadRelayoutFlushing으로 차단
microtask B: 다음 편집/렌더가 requestThreadRelayout('p2') → 새 예약 → flush B가 소진
```

flush 중 파생 relayout이 유실될 수 있는 경로는 없다 — (a) 파생 요청이 이미
실행 중인 microtask 예약(`_threadRelayoutSources`)에 병합되면 **다음 예약 flush**가
소비하고, (b) 예약이 이미 소비된 뒤 도착한 요청은 자체 microtask를 새로 예약한다.
무한 재귀가 없는 이유는 재유발 요청이 (i) 즉시 실행되지 않고 (ii) 다음 flush에서
소진된다는 2단 구조이며, verify-threading-browser [5]가 스트레스 시나리오로
"flush 후 체인 dirty 전부 소진"을 실측한다.

### 계약 검증

- `scripts/verify-threading-browser.mjs` [5] (타이핑 스트레스): 마이크로태스크
  통합 + flush 후 `hasPendingChanges` 전부 false (재진입 원천 제거) + seam 정합.
- `THREAD_RELAYOUT_ASSERT` (dev 옵트인 `__LAYOUT_ELEMENT_DEBUG_THREAD_FLUSH__`):
  flush 종료 시 영향 프레임 dirty 잔존을 console.error로 감시한다.

## 3. 관련 규칙

- `RULES.md §1.10` — story 단일 소스, first-claim-wins, 범위-증명 스킵,
  참조 신선화(A-6), clamp 단방향 수렴(A-10).
- `src/utils/thread-relayout-coordinator.ts` — flush 본체 단일 소스 (C-1).
- 요소 측 소유물: `_threadRelayoutSources`(예약 큐) + `_threadRelayoutFlushing`(재진입 게이트).