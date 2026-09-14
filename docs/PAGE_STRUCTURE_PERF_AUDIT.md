# PAGE_STRUCTURE_PERF_AUDIT.md — 페이지 구조 적용 후 성능 하락 감사 보고서

> **문서 성격**: 성능 감사 + 외부 DTP 리서치 종합 보고서. 2026-09-15 세션에서
> codegraph 소스 검증 + 벤치마크 실측 + 외부 리서치(librarian, 출처 링크 포함)로
> 수집한 사실만 기록한다. 다른 에이전트가 이 문서 하나로 배경·근거·수정 방향을
> 자기완결적으로 소비할 수 있도록 작성되었다.
>
> **기준 커밋**: `78cc592` (2026-09-15, "docs: AGENTS.md 문서 테이블 통합").
> 아래 모든 `file:line` 인용은 이 커밋 기준이다. 코드가 바뀌면 반드시 대조할 것.
>
> **관련 문서**: `docs/PERFORMANCE.md` (기존 최적화 총람 + 문서 스케일 §11)
> (가상화·페이지 모델 설계·실측 이력), `docs/TEXT_ENGINE.md` §27 (스레드 flush 생명주기),
> `RULES.md` §3 (엔진-우선 원칙).
>
> **주의**: 이 문서의 결함 카드는 "수정 지시"가 아니라 "감사 발견"이다.
> 구현 전에 RULES.md(캐시·엔진-우선·data setter 계약)와 scripts/README.md
> (측정 워크플로: 기준선 → 수정 → 검증 → 재측정)를 반드시 따를 것.

---

## 0. 요약 (TL;DR)

**문제**: `<x-layout-document>` + `pages` 배열로 다중 페이지 구조(Phase B, 커밋
`928d845`)를 적용한 뒤 체감 성능이 크게 하락했다는 보고.

**결론** (실측 + 소스 검증 기반):

1. **엔진(문단 배치)은 범인이 아니다.** Node 타이핑 벤치마크 키당 0.25~1.0ms,
   브라우저 입력 동기 p95 2.8ms. 병목은 DOM 렌더(페인트·리플로우)이며 이는
   PERFORMANCE.md § 11.5 측정 데이터(엔진 layoutText 2.7ms·4% vs DOM 90%+, 실기
   headed Chromium + 실 GPU)과 일치한다. → **DOM 최적화는 여전히 최우선 과제이며
   본 감사의 새로운 발견과 별개로 진행되어야 한다.**
2. **그러나 페이지 구조 계층이 불필요한 전역 재계산 경로를 추가했다.** 아래
   4개 결함은 소스로 검증되었으며, "한 페이지의 변경이 전 문서 재작업으로
   전이"되는 반(反)패턴이다. 이것이 "페이지 구조 적용 후 하락"의 체감 원인에
   가장 부합하는 구조적 설명이다.
3. 외부 DTP(InDesign/Scribus/LibreOffice Writer)는 공통적으로 **"dirty 단위
   최소화 + 첫 손상 지점부터 재개 + 화면 밖은 지연 처리"** 정책을 쓴다.
   우리 엔진의 문단 스켈레톤 캐시는 이미 이 모델과 동등하나, **문서·페이지
   계층에서 그 이점을 상쇄하는 경로**가 존재한다 (§4 결함 카드).

**하락폭 실측 관련 주의**: 이번 세션에는 "페이지 구조 적용 이전" 기준선
벤치마크 수치가 없었다 (적용 전 시나리오 측정은 진행하지 않음 — 기존 기록은
적용 후 상태의 것). 본 문서는 하락폭 수치가 아니라 **하락을 유발하는 구조적
지점의 소스 검증**을 담는다. 기준선 비교가 필요하면 §6.1 절차를 따를 것.

---

## 1. 감사 범위와 방법

| 항목 | 내용 |
| --- | --- |
| 대상 | `packages/layout-element` (신문 레이아웃 엔진, Web Components) |
| 트리거 | 사용자 보고: "페이지 구조를 적용하며 성능이 굉장히 하락했습니다" |
| 방법 | (a) codegraph 소스 검증 (file:line 인용 전부 verbatim 확인), (b) 벤치마크 실측 (`benchmark-typing.mjs` Node, `benchmark-browser.mjs` 헤드리스), (c) 기존 실측 기록 소비 (PERFORMANCE.md § 11.5), (d) 외부 DTP 리서치 (librarian, 출처 링크 포함) |
| 한계 | ① 하락 "이전 vs 이후" 직접 비교 측정 없음. ② 헤드리스 벤치마크 수치는 SwiftShader로 5~10배 부풀려져 있음 (PERFORMANCE.md § 11.5 방법론 주의). ③ 호스트 앱(layout-ui)은 여전히 레거시 단일 `<x-layout-page>` 사용 중이므로(layout-editor.tsx:1350), "페이지 구조 적용"의 실제 사용처는 호스트 마이그레이션 진행 상황에 따라 다름 — 결함은 라이브러리 구조 자체에 있으므로 마이그레이션 완료 시점에 그대로 발화한다. |

---

## 2. 실측 결과 (2026-09-15, 기준 커밋 78cc592)

### 2.1 `scripts/benchmark-typing.mjs` (Node, 엔진 전용)

| 시나리오 | 키당 총 경과 | 비고 |
| --- | --- | --- |
| 100자/1컬럼 | 0.245ms | `_layoutColumnsPass` 68%, `_computeCharOffsets` 15% |
| 500자/1컬럼 | 0.339ms | |
| 1000자/1컬럼 | 0.668ms | |
| 2000자/1컬럼 | 0.997ms | 선형 스케일, 캐시 정상 동작 |
| 1000자/6컬럼 | 0.691ms | |
| 인라인 런 10개/500자 | 0.434ms | |

**해석**: 문단 스켈레톤 캐시(`_layoutCache`)·prefix 캐시·charWidth LRU가 정상
동작한다. 엔진 계층의 키 입력 경로에 회귀 없음.

### 2.2 `scripts/benchmark-browser.mjs` (헤드리스)

| 시나리오 | 수치 | 판정 |
| --- | --- | --- |
| 1. 타이핑 — 입력 동기 | p95 2.80ms | ✅ 60fps 이내 |
| **1b. 타이핑 rAF 프레임 델타** | **p95 33.40ms** | **✗ 프레임 드랍 (30fps)** |
| 2. 오버랩 이미지 이동 | p95 15.80ms | ✅ (한계 근접) |
| 4. 인라인 글자크기 | p95 26.90ms | △ 30fps 수준 |
| 7c. layoutText (캐시 히트) | p95 0.80ms | ✅ 캐시 히트 8/8 |
| 7d. renderText (DOM diff) | p95 6.50ms | ✅ |
| 8a. 300p 빌드 (data assign) | 193.5ms | 초기 로드 비용 |
| 8b. 300p 풀렌더 | 257.9ms (spans 179,400) | 초기 로드 비용 |
| 8c. park 297페이지 | 256.7ms (spans → 1,794, 100:1) | 가상화 효과 정상 |
| 8d. 재마운트 20p | avg 8.38ms / p95 11.10ms | ✅ |
| 8e. 300p 타이핑 — 입력 동기 | p95 2.50ms | ✅ |
| **8e. 300p 타이핑 rAF 델타** | **p95 33.30ms** | **△ 30fps 수준** |

**해석**:
- 시나리오 1(단일 문단 2000자, 페이지 구조와 무관)과 시나리오 8e(300p)의
  rAF 델타가 동일하게 ~33ms다 → **프레임 드랍의 주 성분은 DOM 렌더 비용이며
  페이지 수가 직접 원인이 아니다** (마운트 윈도우가 작을 때).
- 헤드리스 SwiftShader 감안 시 실기에서는 훨씬 낮다. 정확한 귀속은
  PERFORMANCE.md § 11.5의 실기 측정(엔진 2.7ms·4% vs DOM 90%+)을 따른다.
- 8a/8b/8c는 초기 로드 1회성 비용으로 양호하다.

### 2.3 기존 측정 데이터 소비 (PERFORMANCE.md § 11.5)

- §7.1 스레드 체인 타이핑 비용 귀속: **shift 편집은 모든 줄의 텍스트·위치가
  바뀌므로 재계산·재쓰기가 필수**. 남는 레버는 (a) 마운트 윈도우 축소,
  (b) 체인 분할뿐으로 증명됨. 텍스트 동일성 기반 라인 캐시 초안은 shift
  편집에서 성립하지 않음이 증명되어 폐기됨 — **동일 아이디어 재시도 금지**.
- §7 실행 순서: P1~P4(가상화 보강)·② 페이지 모델·③′ 시분할 progressive는
  구현 완료. rgbaData 다운사이징(④)·문서 스케일 스케줄러(⑤)·히스토리
  스코프화(⑥)는 미구현 후보로 남아 있다.

---

## 3. 현재 캐시 인벤토리 (무엇이 캐시되고, 언제 깨지는가)

구현 전 **반드시** 이 표와 RULES.md 캐시 계약을 먼저 읽을 것. 결함 카드의
"수정 방향"은 이 표의 무효화 조건을 전제로 설계되었다.

### 3.1 문단 엔진 (ParagraphEngine, `src/engine/paragraph-engine.ts`)

| 캐시 | 위치 | 내용 | 무효화 조건 |
| --- | --- | --- | --- |
| `_layoutCache` (스켈레톤) | :405 | 입력 파라미터 해시 → columnContents | **`set data` (:3963)에서 무조건 소각** (결함 2), `resetIncrementalState()` (:3256) |
| `_prefixCache` | 인스턴스 필드 | 캐럿 이전 접두사 배치 (타이핑 증분) | `set data`·`_layoutTextIntoColumns` 재배치 시 |
| `_charWidthCache` | 인스턴스 LRU 5000 | `${char}\|${font}\|${fontSize}` → 폭(mm) | 소각 없음 (LRU 축출만). **엔진 인스턴스당 존재 — 문단 간 미공유** (PERFORMANCE § 11.1) |
| `_charOuterStyleCache` | 인스턴스 LRU 5000 | 글자 외부 span 스타일 문자열 | 소각 없음 |
| `_TEXT_DIGEST_BY_REF` | **static** (모듈) :298 | textContent 참조 → 직렬화 digest | 참조 교체 시에만 (스레드 체인 전 프레임이 동일 참조 공유 — 체인당 1회만 O(N) 직렬화) |
| `_PLAIN_TEXT_BY_REF` | **static** :306 | textContent 참조 → plain 문자열 | 동일 (체인 F×O(N) → 체인당 O(N) 완화) |
| `_PARSED_CONTENTS_BY_REF` | **static** :314 | textContent 참조 → 파싱 결과(라인×런 블록) | 동일 (파서가 새 객체 생성이라 체인 간 배열 공유 안전) |
| `_effectivePsCache`/`_effectiveTsCache` | :428-432 | effective 스타일 병합 결과 | dirty 플래그로 무효화 (`_effectivePsDirty`/`_effectiveTsDirty`) |
| `_overlayRectsMm` | | 오버랩 rect 계산 결과 | `updateOverlayContext`·`resetIncrementalState` |

### 3.2 스레드 엔진 (ThreadEngine, `src/engine/thread-engine.ts`)

| 캐시 | 위치 | 내용 | 비고 |
| --- | --- | --- | --- |
| `_threadInputUnchanged` 스킵 판정 | :395-407, :561 | 전 프레임 (a) 동일 story 참조 (b) 동일 contentFrom 연쇄 (c) `hasLayoutCache` → 스킵 | **(c)가 핵심**: PE 캐시 소각(결함 2)이 이 스킵을 깨뜨려 체인 전체 재배치로 전이된다 |
| `_committedByThread` (범위-증명 스킵) | :371, :449 | 커밋 contentFrom 연쇄 — 편집 시작점(Ps)보다 커밋 tail이 앞이면 해당 프레임 slice 불변 → 스킵 | InDesign "첫 손상부터 재개" 모델과 동등. **이미 잘 설계됨** |
| `_lastInputByThread` | :531 | 스킵 판정용 시그니처 [story 참조, contentFrom...] | |
| `_staleSkippedByThread` | :455 | 스킵 프레임의 "DOM 렌더·runMap 동기 스킵" 집합 | 포커스 진입 시 `ensureThreadFramesFresh`가 동기화 |

### 3.3 문서/페이지/박스 계층

| 캐시 | 위치 | 내용 | 무효화 조건 |
| --- | --- | --- | --- |
| GC 재사용 (`_gcParamsEqual`) | `BoxEngine._gcParamsEqual` :1463 | GridCalculator 파라미터 동일 시 인스턴스 재사용 | 파라미터 변경 시 |
| `BoxEngine._absRectCache` | :68 | absRect (부모/자기 generation 키) | `_markDirty` 시 |
| `BoxEngine._overlayElementsCache` | :79 | 오버랩 대상 박스 배열 | generation 합계 변화 시 |
| DOM `scheduleRender` (queueMicrotask) | paragraph.element.ts:1124 | 한 틱 렌더 배치 | 렌더 직후 |
| DOM `renderText` diff (`data-source-offset`) | column | span 재사용 diff | 콘텐츠 오프셋 변화 |
| `_perfShouldFullRecreate` 가드 | paragraph.element.ts:516+ | 라인 수·오버플로우 불변 시 span 전체 재생성 회피 | |
| parked 페이지 보관소 | document/page.element | detach DOM 보관 (엔진·캐시 생존) | unpark 복원 |

### 3.4 이미 존재하는 완화 장치 (감사에서 정상 동작 확인)

- `BoxEngine._buildParagraphEngine`의 `structureUnchanged` 가드
  (box-engine.ts:1234-1243) — 6필드 참조 비교 후 불변이면 **캐시를 보존하는
  `updateOverlayContext` 경로**로 빠진다. 단 **결함 2의 가드 우회 경로**가 있다.
- `ParagraphEngine.updateOverlayContext` (:3225) — `_layoutCache` 보존 갱신.
- `PageEngine._refreshParagraphOverlays` (page-engine.ts:1072) —
  `overlayChanged`일 때만 `updateOverlayContext + layoutText`, 아니면
  `!hasLayoutCache`일 때만 `layoutText`.
- `flushThreadRelayout` (thread-relayout-coordinator.ts:55) — 키 입력당
  O(F×P) 제거(감사 B-1), DOM 문단 맵 1회 구축, dirty 소진 assert는
  `THREAD_RELAYOUT_ASSERT` debug 게이트로 프로덕션 경로 숨김.
- `requestThreadRelayout` microtask 배치 (document.element.ts:623) — 타이핑
  경로는 문서 스코프로 잘 스코프다운되어 있음 (이 경로엔 회귀 없음).

---

## 4. 발견된 결함 카드 (소스 검증 완료)

> 심각도 순. 각 카드: 증상 → 근거(file:line) → 전파 경로 → 수정 방향(권고) →
> 검증 방법. **수정 방향은 설계 권고이며, 구현 전 RULES.md 계약 확인 필수.**

### 결함 1 (치명) — `confirmThreadChain`이 페이지 수만큼 중복 실행

**증상**: N개 페이지를 가진 문서가 렌더될 때마다 스레드 확정(재배치+DOM 동기화)
검사가 문서 전체 규모로 N회 실행된다. 스레드가 없는 문서는 조기 반환
(`_relayoutThreads`가 `threads.length === 0` 즉시 return, document.element.ts:603)이라
사실상 무해하지만, **스레드를 쓰는 신문 문서(이 프로젝트의 주 사용례)에서는
페이지 수에 비례하는 이차 비용**이다.

**근거** (전부 verbatim 확인):

1. `page.element.ts:649-665` — `LayoutPageElement.render()` 마지막:
   ```ts
   if (this._findDocumentElement()) {
     this._delegateThreadChainConfirm();     // ← 무조건 (문서 소속 시)
   } else if (this._hasUnsyncedThreadFrames()) { ... }  // 독립 루트만 게이트 있음
   ```
   **독립 루트 분기와 달리 문서 분기에는 `hasUnsyncedThreadFrames` 게이트가 없다.**
2. `page.element.ts:719-727` — `_delegateThreadChainConfirm`은
   `docEl.confirmThreadChain()`으로 위임.
3. `document.element.ts:612-616` — `confirmThreadChain()`:
   ```ts
   if (this._suppressThreadConfirm) return;  // ← 문서 layout() 중에만 흡수
   this._relayoutThreads();                  // engine.relayoutThreads() — 전 스레드 패스
   this._syncThreadFramesToDom();            // 전체 트리 순회 + DOM 맵 구축
   ```
   **`_suppressThreadConfirm`는 문서 `layout()` 중에만 세워진다. `render()` 시리즈에는
   흡수 장치가 없다.**
4. `document.element.ts:301-318` — 비-progressive `render()`는
   `for (const page of this.items) await page.render()`로 페이지를 직렬 순회한다.
   → 페이지마다 (a)가 호출된다.
5. 각 (a) 호출의 실질 비용:
   - `_relayoutThreads` (document.element.ts:601-605) →
     `DocumentEngine.relayoutThreads()` (document-engine.ts:256) →
     `_layoutThreads` (:235) → `ThreadEngine.layoutThreads` (thread-engine.ts:280).
     `validate` 후 스레드별 `_layoutOneThread` — 스킵 판정(`_threadInputUnchanged`,
     thread-engine.ts:561)이 통과하면 O(F) 참조 비교로 싸게 끝난다. **단, 캐시가
     소각된 프레임이 하나라도 있으면 `hasLayoutCache` 조건 실패 → 해당 체인
     전체 재배치** (결함 2와 결합).
   - `_syncThreadFramesToDom` (thread-relayout-coordinator.ts:116-143) →
     `engine.findEnginesByIds(frameIds)` (document-engine.ts:185 — **전체 엔진
     트리 순회**) + `buildDomParagraphMap(ctx)` (:175-180 —
     `querySelectorAll('x-layout-paragraph')` **문서 전체** + Map 구축) —
     **페이지당 1회씩 반복**.
   - `_pumpDisplayPass` (document.element.ts:338-359, progressive)도
     `void page.render()`를 페이지별 호출하므로 동일 중복 발생.

**비용 환산**: 마운트 P페이지 × (전체 엔진 트리 순회 + 문서 전체
querySelectorAll + 스레드 스킵 판정). P=300, 문단 ~10/페이지면
페이지 1개 렌더에 트리 순회 ~3,000 노드 × 300회 = **백만 단위 연산이 초기
렌더 한 사이클에**. 마운트 윈도우(±N)가 커지면(축소 조망) 즉시 증폭.

**수정 방향 (권고)**:
- (a) 문서 `render()` 시리즈에도 `_suppressThreadConfirm`와 동등한 흡수
  플래그를 두고, **문서 렌더 종료 시 1회만** `confirmThreadChain`을 실행한다
  (독립 루트의 `hasUnsyncedThreadFrames` 게이트를 문서 분기에도 적용하는 것이
  최소 변경). 이미 document.render() 마지막에
  `if (this._hasUnsyncedThreadFrames()) this.confirmThreadChain()`(:314-316)이
  있으므로, **페이지 렌더의 위임을 "unsynced 프레임 존재 시에만" 게이트하면
  중복이 사라진다.**
- (b) `hasUnsyncedThreadFrames` (coordinator :152-165)는 프레임마다
  `findEngineById`(전체 트리 탐색)를 호출한다 — `findEnginesByIds` 일괄 조회로
  바꾸면 검사 자체가 O(트리) 1회로 줄어든다. (a)를 적용하면 이 호출 빈도도
  자연 감소한다.

**검증**: `scripts/verify-threading.mjs`, `verify-threading-browser.mjs`,
`verify-page-model.mjs` 전체. 추가로 `confirmThreadChain` 호출 카운트 계측을
벤치마크 시나리오 8(300p)에 넣어 호출 수가 페이지 수와 무관하게 일정(1회)으로
떨어지는지 확인.

---

### 결함 2 (치명) — `ParagraphEngine.set data` 무조건 캐시 소각

**증상**: 데이터 재주입(undo/redo, 외부 동기화, 호스트 `element.data = applied`)
한 번으로 **전체 문단의 레이아웃 캐시가 소각**되고, 다음 `layoutText()`에서
해시 비교 대상 캐시가 없어 전 문단이 O(자릿수) 완전 재배치된다. 스레드 체인에서는
`_threadInputUnchanged`의 `hasLayoutCache` 조건(thread-engine.ts:568)까지 깨져
**체인 전체 재배치로 전이**된다 (결함 1과 곱연산).

**근거**:

1. `paragraph-engine.ts:3963-3989` — `set data`는 참조 동등성 가드 없이:
   ```ts
   set data(options: ParagraphEngineData) {
     this._lineHeight = 0;
     this._data = options;
     ...
     this._plainTextCache = null;
     this._styleRuns = null;
     this._parsedContentsCache = null;
     this._prefixCache = null;         // ← 타이핑 증분 캐시까지 소각
     ...
     this.resetIncrementalState();     // ← _layoutCache = null (:3268)
   }
   ```
   **반사실 검증 완료**: 소각 후 `_layoutTextIntoColumns` (:1536-1558)는
   `_layoutCache && hash === inputHash` 비교 자체가 불가능하다 (캐시가 null).
   "입력이 동일해도 캐시가 죽어 있으면 히트할 수 없다" — 가드 없는 소각이 곧
   재계산 보증이다.
2. **가드 우회 경로 (반사실 재현 논리)**: `BoxEngine._buildParagraphEngine`
   (box-engine.ts:1234-1266)의 `structureUnchanged`는 6개 필드
   (`content`, `column`, `gap`, `paragraphStyle`, `textStyle`,
   `inheritStyle.parentWidth/Height`)를 **전부 참조 비교**한다. 그런데
   `ParagraphEngine.extractData` (:4815-4842)는 `paragraphStyle`/`textStyle`를
   **호출마다 새 객체로 조립**한다 ("No caching — a fresh ParagraphData object
   is built on every access", AGENTS.md). 따라서
   `extractData → data setter` 왕복(= 스냅샷 round-trip, PERFORMANCE § 11.1)은
   **내용이 동일해도 참조가 항상 달라** `structureUnchanged`가 구조적으로 실패한다.
   → `pe.data = {...}` → 캐시 전면 소각.
3. DOM 경로도 동일: `LayoutParagraphElement.set data` (paragraph.element.ts:619-661)는
   `this._perfStructureChanged = true` (:650)를 항상 세운다. `render()` (:407-413)는
   이 플래그에서 `_layoutStructure()`(엔진 data 재주입) → PE 캐시 소각 →
   `layoutText()` 완전 재배치로 이어진다.
4. **완화 장치가 이미 존재**하는데 결함이 그 위에 얹힌다:
   `updateOverlayContext` (:3225-3249)는 `_layoutCache`를 보존하는 경량 갱신
   경로다. data setter에도 "불변 시 경량 갱신" 분기가 없을 뿐이다.

**수정 방향 (권고)** — 엔진-우선 원칙(RULES.md §3) 유지 전제:

- `set data` 상단에 필드별 참조 비교 게이트를 추가한다 (전부 참조 비교 —
  `ParagraphEngineData`는 이미 엔진이 소유한 객체 참조를 받는 계약이므로
  깊은 비교 불필요):
  `content === old.content && inheritStyle === old.inheritStyle &&
   paragraphStyle === old.paragraphStyle && textStyle === old.textStyle &&
   column/gap/parentAbsRect/resources/parentBox 동일` →
  캐시 소각 없이 `_effectivePsDirty`/`_effectiveTsDirty`만 세우고 return.
- 또는 (호스트 round-trip이 주범이라면) `extractData`가 스타일 객체를
  **동일 참조로 재사용**하도록 조립 시점에 `this._paragraphStyle` 참조를
  그대로 반환하게 한다 (단, 이는 "추출 데이터는 스냅샷" 계약 변경이므로
  소비처가 없는지 먼저 확인 — 편집 중 필드 mutate가 있는지 감사 필요).
- 주의: `textContent` setter도 캐시 무효화를 수행하나, 이는 진짜 편집 경로이고
  prefix 캐시가 증분을 담당하므로 손대지 않는다.

**검증**: `scripts/verify-inline-metrics.mjs`, `verify-threading.mjs`,
`verify-multicolumn.mjs`, `verify-engine-node.mjs`. 추가 시나리오:
"동일 내용 data 재주입 2회 → 2회째 `layoutText` 완전 재배치 0건" 단언
(계측 또는 `_layoutColumnsPass` 호출 카운트).

---

### 결함 3 (중간) — `document.layout()`이 dirty 게이트 없이 전 페이지 재구축

**증상**: 문서 소유의 임의 변경(페이지 추가/삭제/재배치, 문서 스타일, data
reconcile)이 **전 페이지의 `layout()` + 전 문서 데이터 재조립**을 유발한다.
"한 페이지의 변경이 O(전 문서)"가 되는 경로다.

**근거**:

1. `document.element.ts:270-293` — `layout()`:
   ```ts
   this._layoutStructure();              // ← _collectPagesData(): 전 페이지 _rawData()/extractData
   this._applyStyle();
   for (const page of this.items) {
     page.layout();                       // ← 무조건 전 페이지 (dirty 검사 없음)
   }
   this._layoutPageOrder();
   this._engine?.adoptPageEngines(...);  // 페이지 번호 정렬 + 매핑
   this._engine?.layout();               // 스레드 패스
   this._syncThreadFramesToDom();
   ```
2. `_collectPagesData` (document.element.ts:566-596) — 마운트 페이지 전부
   `_rawData()`(전 박스 트리 조립) + parked 페이지는
   `ensureCommitted` + `extractData`(엔진 스냅샷 조립, :585-590).
   **문서 layout() 1회 = 전체 문서 깊이 직렬화 1회.**
3. `page.layout()` (page.element.ts:629-643)은 매번
   `_layoutStructure()` → `PageEngine.data` setter → `_buildTree`
   (자식마다 `findBoxEngineById` 재귀 선형 검색 — PERFORMANCE § 11.1의
   O(N²) 성분) → `_refreshParagraphOverlays`(전 문단 순회)를 실행한다.
4. **dirty 집계는 이미 존재한다**: `PageEngine._dirty` + `layout()`의
   `this._dirty = false` (page-engine.ts:781) + `DocumentEngine.dirty`
   (document-engine.ts:125-127, "소유 페이지 엔진 dirty의 집계") +
   `ensureCommitted` (:212-216). **집계는 있으나 `document.layout()`의
   페이지 루프가 이를 소비하지 않는다.**

**수정 방향 (권고)**:
- `document.layout()`의 루프를 `if (page.engine?.dirty || page._structureDirty)`
  게이트로 변경한다 (페이지 data setter·프로퍼티 setter가 dirty를 세우도록
  PageEngine `_dirty`를 DOM 요소 변경 경로와 연결).
- 단, 페이지 순서(`_layoutPageOrder`)·스프레드 배치는 전 페이지 대상이므로
  게이트는 "페이지 내부 layout"에만 적용하고 순서 배치는 유지한다.
- `_collectPagesData`는 DocumentEngine.data setter가 페이지 배열을 필요로
  하는 한 전 수집이 요구된다 — 다만 `_rawData()` 결과 캐싱(페이지별
  "마지막 수집 세대" 비교)으로 직렬화 비용 자체를 줄일 수 있다. **높은
  구조 변경이므로 Tier 1이 아니라 Tier 2로** — 결함 1·2와 별개로, 먼저
  호출 빈도를 줄이는 편이 저렴하다.

**검증**: `scripts/verify-page-model.mjs`, `verify-page-reorder-parked.mjs`,
`verify-threading.mjs`, `snapshot-layout.mjs` (전후 byte 동일).

---

### 결함 4 (경도) — 페이지 렌더 직렬 await + 문서 단위 비일관 스코프

**증상**: `document.render()`가 페이지를 직렬 `await`로 순회한다
(:311-313). 이미지 로드 등 진짜 비동기는 필요하나, 텍스트 렌더도 직렬로
묶여 초기 로드/스크롤 시 레이턴시가 페이지 수에 선형 누적된다.
progressive 모드(`_pumpDisplayPass`, :338)는 시간 분할로 이를 완화하나
**기본 경로(off)는 그대로 직렬**이다.

**수정 방향 (권고)**: progressive 기본화 검토 또는 텍스트 전용 페이지의
동기 병렬 렌더. 단, 렌더 순서가 오버랩 판정(이미지 → 텍스트)에 영향을
주므로 (AGENTS.md "Order matters"), 병렬화는 이미지 우선 순서를 보존하는
범위에서만.

---

### 검증된 정상 경로 (감사에서 명시적으로 "문제 없음" 판정)

| 경로 | 근거 |
| --- | --- |
| 타이핑 → 스레드 재배치 경로 스코프다운 | `requestThreadRelayout` microtask 배치 + `flushThreadRelayout` 소스 프레임 한정 + 범위-증명 스킵. **페이지 구조로 인한 회귀 없음** |
| park/unpark 가상화 | 벤치마크 8c/8d — park 297p 257ms(1회성), 재마운트 p95 11ms. 엔진 캐시·rgbaData detached 생존 설계 정상 |
| 엔진 캐시 3종 (스켈레톤/prefix/charWidth) | benchmark-typing 키당 ≤1ms, benchmark 7c 캐시 히트 8/8 |
| `flushThreadRelayout` 최적화 이력 | 감사 B-1(O(F×P) 제거)·A-6(스킵 프레임 참조 신선화) 반영 완료 |

---

## 5. 외부 DTP 리서치 — InDesign / Scribus / LibreOffice Writer

> 출처: librarian 리서치 (2026-09-14~15). Scribus는 커밋
> [`d2c57c0`](https://github.com/scribusproject/scribus/blob/d2c57c0dd89b0b1e8ec06dcf41b8849a53d14dd7/scribus/pageitem_textframe.cpp),
> LibreOffice는 커밋
> [`31eabe1`](https://github.com/LibreOffice/core/blob/31eabe1e534a70a2b7d5c39eb31e56a75c17be3b/sw/source/core/layout/layact.cxx)
> 기준 소스 검증. InDesign은 폐쇄 소스 — SDK 문서(pikor.pro 미러)·특허
> (US 7949951)·공식 help·Adobe 엔지니어 발언 기반.

### 5.1 Adobe InDesign

| 정책 | 내용 | 출처 |
| --- | --- | --- |
| **무효화 단위 = 스토리** | 텍스트는 story(`ITextModel`)에 소유. 조판 결과(wax 라인)도 **페이지가 아니라 story에 귀속**. 손상은 `(story, text range)`로 표현 — 한 스토리 편집이 다른 스토리 캐시를 건드리지 않는다 | [ITextModel](http://www.pikor.pro/class_i_text_model.html), [ITextStoryThread](http://www.pikor.pro/class_i_text_story_thread.html) |
| **라인 단위 damage + 문단 스코프 재조판** | 조편 단위 WaxLine마다 damage 플래그. 수리는 **첫 손상 라인부터 문단 앞까지 되돌린 뒤 재조판** | 특허 [US 7949951](https://patents.google.com/patent/US7949951) |
| **첫 손상 프레임 추적** | `IFrameList::GetFirstDamagedFrame()` — "조판 엔진이 어디서부터 다시 조판할지 결정" | [IFrameList](http://www.pikor.pro/class_i_frame_list.html) |
| **조판은 지연·중단 가능** | `ITextParcelList::Recompose(interruptCheck)` — `kRR_Interrupted` 반환. 조판은 필요 시점까지 지연. 문서 수준 `recompose()` 강제 API 존재 | [ITextParcelList](http://www.pikor.pro/class_i_text_parcel_list.html) |
| **지연 무효화 배치** | `IWaxStrand::NewDeferredInval/AddDeferredInval/EndDeferredInval` — 여러 편집을 하나의 damage 범위로 병합 | [IWaxStrand](http://www.pikor.pro/class_i_wax_strand.html) |
| 글리프 캐시 | `IStoryService` — 스토리 범위별 글리프 배열+폭 사전 할당, `ClearGlyphCache()` | [IStoryService](http://www.pikor.pro/class_i_story_service.html) |
| Smart Text Reflow 게이트 | 페이지 자동 증감은 마스터 프레임 또는 "2페이지 이상 스레딩된 story" 조건에서만. 페이지 구조 변경을 키 입력마다 허용하지 않는다 | [Adobe help](https://helpx.adobe.com/indesign/desktop/add-and-manage-text/add-and-import-text/thread-text-frames.html) |
| 표시 품질 3단계 | Fast(이미지 회색)/Typical(72ppi 프록시, 기본)/High — **조판과 화면 렌더 분리**, 화면은 프록시 품질 | [ViewDisplaySettings](https://developer.adobe.com/indesign/uxp/dom/api/v/view-display-settings/) |
| 단락 조판기 폴백 | 인라인 오브젝트 text-wrap이 있으면 해당 문단은 **조용히 단행 조판기로 전환** (환형 의존성 해결 불가 → 싼 모드 폴백) | [CreativePro](https://creativepro.com/the-great-paragraph-composer-paradox/) |
| Server 배치 | 멀티스레드 아님 — 인스턴스 풀 + 세션 재사용으로 처리량 확보 | [FAQ](https://www.adobe.com/products/indesignserver/faq.html) |
| idle 스케줄러 | `IIdleTask::RunTask(appFlags, IdleTimer)` — 메인 루프 패스마다 시간 예산 내 수행, 예산 소진 시 양보 | [IIdleTask.h](http://www.pikor.pro/_i_idle_task_8h_source.html) |

### 5.2 Scribus (소스 검증)

| 정책 | 내용 | 출처 |
| --- | --- | --- |
| **아이템 단위 dirty 비트** | `PageItem::invalid` 플래그 1개 (`bool invalid {true}` — pageitem.h L1395). 페이지 dirty 없음, 체인 단위 배치 | [pageitem.h](https://github.com/scribusproject/scribus/blob/d2c57c0dd89b0b1e8ec06dcf41b8849a53d14dd7/scribus/pageitem.h#L1395) |
| **첫 invalid 프레임부터 전방 재배치** | `layout()`이 체인을 역주행해 첫 invalid를 찾고 거기서부터 전방 배치. valid 접두사는 `firstChar`/`m_maxChars` 결과 재사용 | [pageitem_textframe.cpp L1185-1210](https://github.com/scribusproject/scribus/blob/d2c57c0dd89b0b1e8ec06dcf41b8849a53d14dd7/scribus/pageitem_textframe.cpp#L1185) |
| **문단 단위·전방향 전용 무효화** | 편집 시 `firstItem`을 문단 시작으로 스냅 → 해당 프레임부터 **체인 끝까지** invalid. 이전 프레임은 절대 무효화 안 함 | [slotInvalidateLayout L3174-3197](https://github.com/scribusproject/scribus/blob/d2c57c0dd89b0b1e8ec06dcf41b8849a53d14dd7/scribus/pageitem_textframe.cpp#L3174) |
| **셰이핑 캐시 2단계** | HarfBuzz 결과를 블록(문단) 단위 `ShapedTextCache`에 캐시, **편집 시 해당 블록만 무효화**. "레이아웃은 표시/인쇄 시점에만 재생성"이 설계 문서에 명시 | [shapedtextcache.cpp](https://github.com/scribusproject/scribus/blob/d2c57c0dd89b0b1e8ec06dcf41b8849a53d14dd7/scribus/text/shapedtextcache.cpp), [design.txt L44-46](https://github.com/scribusproject/scribus/blob/d2c57c0dd89b0b1e8ec06dcf41b8849a53d14dd7/scribus/text/design.txt#L44-L46) |
| **그리기 시점 지연 배치** | 화면: 컬링 영역과 교차하는 invalid 프레임만 `layout()` (canvas.cpp L1444-1454). 화면 밖 invalid는 그냥 둔다 | [canvas.cpp L1415](https://github.com/scribusproject/scribus/blob/d2c57c0dd89b0b1e8ec06dcf41b8849a53d14dd7/scribus/canvas.cpp#L1415) |
| **⚠ 역방향 무효화 O(N²) 교훈** | 체인 `link()` 시 이전 프레임을 `frameOverflows`가 풀릴 때까지 역주행 무효화 → 긴 체인 빌드가 이차 비용. 107p 실측 0.95s/페이지 → `setReflow(false)` 밸브로 **24배** 개선 | [pageitem.cpp L1176-1190](https://github.com/scribusproject/scribus/blob/d2c57c0dd89b0b1e8ec06dcf41b8849a53d14dd7/scribus/pageitem.cpp#L1176), [포럼 실측](https://forums.scribus.net/index.php/topic,6918.0.html) |

### 5.3 LibreOffice Writer (소스 검증)

| 정책 | 내용 | 출처 |
| --- | --- | --- |
| **프레임 단위 타입별 dirty 비트** | `SwFrame`: INVALID_SIZE/PRTAREA/POS/LINENUM/ALL. `SwPageFrame`은 5비트(content/layout/fly×3). **멱등 무효화**: 이미 invalid면 no-op — 무효화 폭풍이 캐스케이드 못 함 | [pagefrm.hxx L72-76](https://github.com/LibreOffice/core/blob/31eabe1e534a70a2b7d5c39eb31e56a75c17be3b/sw/source/core/inc/pagefrm.hxx#L72-L76), [frame.hxx L777](https://github.com/LibreOffice/core/blob/31eabe1e534a70a2b7d5c39eb31e56a75c17be3b/sw/source/core/inc/frame.hxx#L777) |
| **`SwLayAction`: 첫 invalid 페이지부터 + 화면 밖 스킵** | 루프 시작점이 "첫 invalid 페이지" (`while (!pPage->IsInvalid()) pPage = pPage->GetNext()`). 동기 패스는 **화면 밖 페이지를 스킵**(IsShortCut), 남은 invalid는 idle가 마무리 | [layact.cxx L489, L1059](https://github.com/LibreOffice/core/blob/31eabe1e534a70a2b7d5c39eb31e56a75c17be3b/sw/source/core/layout/layact.cxx#L489) |
| **Turbo 단일 프레임 경로** | 등록된 invalid가 1개뿐이면 페이지 순회 없이 **그 프레임만 재조판 후 반환** | [layact.cxx L373-390](https://github.com/LibreOffice/core/blob/31eabe1e534a70a2b7d5c39eb31e56a75c17be3b/sw/source/core/layout/layact.cxx#L373) |
| **idle 조판 (SwLayIdle)** | 스펠/워드카운트를 가시 영역 우선 수행 후 idle 조판. **인터럽트는 입력 기반**(타이머 금지 — 타이머 쓰면 같은 페이지에서 스타브되는 버그 tdf#141556 실측) | [viewsh.cxx L835](https://github.com/LibreOffice/core/blob/31eabe1e534a70a2b7d5c39eb31e56a75c17be3b/sw/source/core/view/viewsh.cxx#L835), [layact.cxx L2401](https://github.com/LibreOffice/core/blob/31eabe1e534a70a2b7d5c39eb31e56a75c17be3b/sw/source/core/layout/layact.cxx#L2401) |
| **실측: 963ms → 14ms** | 300p 문서 paste로 전 페이지 invalid → LOK 동기 전체 조판 963ms hang. "가시 페이지만 동기, 나머지 299p는 idle" 수정으로 **14ms** | [vmiklos.hu](https://vmiklos.hu/blog/sw-anyinput-lok.html) |
| **SwCache LRU + 가시 영역 보호** | 텍스트 라인(SwParaPortion)·보더·폰트 캐시가 공용 SwCache LRU. **"가상 첫 포인터"로 가시 영역 항목을 축출 보호** | [swcache.hxx L22-44](https://github.com/LibreOffice/core/blob/31eabe1e534a70a2b7d5c39eb31e56a75c17be3b/sw/source/core/inc/swcache.hxx#L22-L44) |
| **⚠ 축출 제거 전환 (2025)** | 문단 라인 LRU를 **통째로 제거**하고 프레임 직접 소유로 전환 — "eviction + 재생성 분기가 메모리 절감보다 비쌌다" (1000p 실측) | [commit 62af1f9b3c11](https://www.mail-archive.com/libreoffice@lists.freedesktop.org/msg361228.html) |
| **영구 페이지 분할 캐시** | 파일에 "매 페이지 상단 문단 인덱스"를 저장 — 열 때 페이지 수와 콘텐츠 배치를 사전 확정, 직렬 발견식 흐름 제거 | [laycache.cxx L58-66](https://github.com/LibreOffice/core/blob/31eabe1e534a70a2b7d5c39eb31e56a75c17be3b/sw/source/core/layout/laycache.cxx#L58-L66) |

### 5.4 외부 공통 패턴 ↔ 우리 엔진 대응표

| 외부 패턴 | 우리 엔진 현황 (기준 커밋 78cc592) | 갭 |
| --- | --- | --- |
| dirty 단위 = 스토리/프레임 (페이지 아님) | 문단 스켈레톤 캐시 + 스레드 범위-증명 스킵은 동등. **문서·페이지 계층에 dirty 소비 없음** (결함 1·3) | **큼** |
| 첫 손상부터 재개 (뒤로 무효화 금지) | ThreadEngine `_committedByThread`로 동등 구현 완료 | 없음 (문서화만 필요) |
| 조판 지연 + idle 양보(입력 기반) | progressive 시분할 구현(③′) — 다만 **시간 분할일 뿐, 화면 밖 우선순위 없음** | 중간 |
| 화면 밖 프레임은 invalid로 방치 | parked 페이지 = 엔진 유지·DOM 분리로 **동등 이상** (재마운트 p95 11ms) | 없음 |
| 멱등 무효화 (invalid에 invalid 금지) | `set data` 무조건 소각 — **반대 정책** (결함 2) | **큼** |
| 블록 단위 셰이핑 캐시 | 문자 단위 charWidth LRU(전역 아님, 인스턴스별)만 | 중간 |
| 가시 영역 LRU 보호 | 없음 | 작음 |
| 레이아웃 결과 eviction 금지(소유 선호) | `_layoutCache`는 소유형 — LO 전환과 방향 일치 | 없음 |
| 영구 페이지 분할 캐시 | 없음 (문서 저장 데이터에 힌트 없음) | 중간 |

---

## 6. 적용 로드맵 (우선순위 + 검증 계약)

### 6.1 측정 절차 (모든 수정의 전제 — scripts/README.md 워크플로)

1. **기준선**: `npx tsx scripts/benchmark-browser.mjs` (시나리오 1·8) +
   `benchmark-typing.mjs` + `snapshot-layout.mjs > /tmp/opencode/snapshot.json`.
   페이지 구조 "이전"과 비교해야 한다면 단일 `<x-layout-page>` 사용 예제로
   동일 문서를 구성해 측정한다 (적용 전 기록이 없으므로 새로 확보).
2. **수정** (아래 Tier 순서대로, 한 카드씩).
3. **검증**: 카드별 지정 회귀 스크립트 + 관련 문서 전 수동 대조
   (아래 §6.3 목록). snapshot byte-identical 확인.
4. **재측정** + 이 문서 §2 표 갱신.

### 6.2 Tier 1 — 즉시 (낮은 노력, 직접 원인)

| ID | 작업 | 대응 결함 | 핵심 파일 | 예상 효과 |
| --- | --- | --- | --- | --- |
| **T1-1** | 페이지 렌더의 `confirmThreadChain` 위임을 `hasUnsyncedThreadFrames` 게이트 (문서 렌더 종료 시 1회 확정 유지). `hasUnsyncedThreadFrames`를 `findEnginesByIds` 일괄 조회로 전환 | 결함 1 | `page.element.ts:658-663`, `document.element.ts:301-318`, `thread-relayout-coordinator.ts:152-180` | 초기 렌더/스크롤 스케일 O(P²)→O(P) |
| **T1-2** | `ParagraphEngine.set data` 참조 비교 게이트 (동일 참조 6필드 → 소각 스킵, 경량 갱신 경로) | 결함 2 | `paragraph-engine.ts:3963-3989` | data 재주입·undo 시 전 문단 재배치 제거, 스레드 체인 전이 차단 |
| **T1-3** | `extractData` 스타일 참조 재사용 검토 (T1-2와 트레이드오프 — 스냅샷 계약 확인 후 택일) | 결함 2 | `paragraph-engine.ts:4815-4842` | T1-2의 우회 경로 제거 |

**T1-2 상세 설계 노트** (구현 에이전트용):
- 게이트 조건: `options`와 `this._data`의 필드 전부 참조 비교
  (`content`, `inheritStyle`, `paragraphStyle`, `textStyle`, `resources`,
  `parentBox`, `parentAbsRect` — `ParagraphEngineData`는 엔진 내부 주입 계약이라
  참조 안정성이 이미 성립하는 경로에서만 호출된다).
- 통과 시: `_data = options` 교체 후 `resetIncrementalState()` **생략**하고
  `_effectivePsDirty`/`_effectiveTsDirty`만 세운다. `_applyColumnGapFromData`
  재계산은 보존(컬럼 파생값은 parentWidth 의존).
- 실패 시: 기존 경로 그대로.
- **주의**: 이 게이트는 "동일 데이터 재주입"만 잡는다. 진짜 편집 경로
  (`textContent` setter)는 손대지 않는다. `preserveRenderShapeAcrossReset`
  (:3256-3263)와의 상호작용 확인 필요 — 게이트 통과 시 해당 플래그도 보존해야
  정렬 변경 증분(§3.16)이 유지된다.

### 6.3 Tier 2 — 구조적 (중기)

| ID | 작업 | 대응 | 참조 외부 패턴 |
| --- | --- | --- | --- |
| **T2-1** | `document.layout()` 페이지 dirty 게이트 (`PageEngine._dirty` 소비 + DOM 변경 경로와 연결) | 결함 3 | LO "첫 invalid 페이지부터" (§5.3) |
| **T2-2** | 동기=가시 페이지 / idle=나머지 이원화 (progressive의 시간 분할에 **공간 우선순위** 추가: 뷰포트 교차 페이지 우선 펌프, 인터럽트는 입력 기반) | DOM 레이턴시 | LO SwLayAction IsShortCut + SwLayIdle, 실측 963→14ms (§5.3) |
| **T2-3** | 블록(런) 단위 셰이핑 폭 캐시 — `_charWidthCache` 위에 (런 텍스트+스타일) 키 캐시 | §5.4 갭 | Scribus ShapedTextCache (§5.2) |
| **T2-4** | `_charWidthCache` 전역 공유 검토 (문단 인스턴스당 LRU 5000 → 폰트 로더 스코프) | PERFORMANCE § 11.1 | InDesign IStoryService 글리프 캐시 |
| **T2-5** | 배치 편집 밸브 (`setReflow(false)` 상당) — 문서 재구축 시 체인 재배치 마지막 1회로 지연 | 결함 1·2 완화 | Scribus 24배 실측 (§5.2) |

### 6.4 Tier 3 — 정책/경고 (적용 시 후속)

- **레이아웃 결과 eviction 금지**: LO 2025 전환(§5.3)과 동일하게
  `_layoutCache`를 대형 문서 지원 명분으로 축출하는 정책을 만들지 않는다.
  메모리가 재검증 분기보다 싸다 (실측 근거 존재).
- **영구 페이지 분할 캐시**: 문서 저장 데이터에 페이지별 첫 박스/스토리
  오프셋 힌트 직렬화 → 복원 시 초기 배치 확정 (LO SwLayoutCache, §5.3).
- **스크롤 중 이미지 프록시 품질** (InDesign 표시 3단계, §5.1).
- **페이지 자동 증감 게이트** (InDesign Smart Text Reflow 조건, §5.1) —
  오버플로우 자동 페이지 추가 기능을 만든다면 키 입력 단위가 아니어야 한다.
- **경우에 따른 싼 모드 폴백** (InDesign 단행 조판기 전환, §5.1) — 오버랩
  회피+워드랩+걸침표가 병리적으로 결합할 때의 문단 단위 폴백 밸브.

### 6.5 수정 시 필수 회귀 목록 (한 번에 전부)

```
verify-threading.mjs           (스레드 정합 — T1-1/T1-2/T2-5)
verify-threading-browser.mjs   (화면 진실)
verify-page-model.mjs          (문서·페이지 계층 — T1-1/T2-1)
verify-page-reorder-parked.mjs (parked 순서 — T2-1/T2-2)
verify-progressive-layout.mjs  (시분할 — T2-2)
verify-multicolumn.mjs         (prefix 캐시 경로 — T1-2)
verify-inline-metrics.mjs      (인라인 오버라이드 전 파이프라인 — T1-2)
verify-engine-node.mjs         (Node DOM-free — T1-2)
verify-caret-parking.mjs       (커서 회귀 — 전 수정의 선행 기준선)
verify-dom-diff.mjs            (DOM↔엔진 정합 — T1-2)
verify-hanging-punctuation.mjs / verify-word-wrap.mjs  (해시 키 영향 — T1-2)
snapshot-layout.mjs            (전후 byte 동일)
benchmark-browser.mjs          (시나리오 8 — T1-1 효과 확인)
```

---

## 7. 이 문서를 소비하는 에이전트를 위한 지침

1. **먼저 읽을 것**: `AGENTS.md` (전체) → `RULES.md` §1.8·§3·§1.9·§1.10 →
   `docs/PERFORMANCE.md` § 11.5 → `docs/TEXT_ENGINE.md` §27 → 이 문서.
2. **구현 순서**: §6.2 Tier 1부터 한 카드씩. 카드 하나 = 커밋 하나 원칙.
3. **원칙 준수**: 엔진-우선(RULES.md §3 — 엔진은 DOM 부착 금지, data setter는
   자기 속성만), 측정 워크플로(scripts/README.md), 근거 없는 최적화 금지
   (PERFORMANCE § 11.5의 "diff 경로 유지" 판정 교훈).
4. **이 문서의 갱신 계약**: 수정 커밋마다 (a) §2 표에 재측정 수치 추가,
   (b) 해당 결함 카드에 "해결됨(커밋)" 스탬프, (c) §6 표 상태 갱신.
   기준 커밋(`78cc592`) 이후 file:line 드리프트가 있으면 대조 후 수정할 것.
5. **금지 사항**: 결함 카드의 "수정 방향"은 설계 권고다 — 실제 구현 시
   RULES.md·AGENTS.md 계약과 충돌하면 계약이 우선하고, 이 문서의 해당 카드를
   실측 근거와 함께 갱신할 것.