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
| 100자/1컬럼 | 0.245ms (T1 후 0.220ms) | `_layoutColumnsPass` 68%, `_computeCharOffsets` 15% |
| 500자/1컬럼 | 0.339ms (T1 후 0.358ms) | |
| 1000자/1컬럼 | 0.668ms (T1 후 0.603ms) | |
| 2000자/1컬럼 | 0.997ms (T1 후 0.967ms) | 선형 스케일, 캐시 정상 동작 |
| 1000자/6컬럼 | 0.691ms (T1 후 0.661ms) | |
| 인라인 런 10개/500자 | 0.434ms (T1 후 0.397ms) | |

**해석**: 문단 스켈레톤 캐시(`_layoutCache`)·prefix 캐시·charWidth LRU가 정상
동작한다. 엔진 계층의 키 입력 경로에 회귀 없음.

### 2.2 `scripts/benchmark-browser.mjs` (헤드리스)

| 시나리오 | 수치 | 판정 |
| --- | --- | --- |
| 1. 타이핑 — 입력 동기 | p95 2.80ms (T1 후 3.10ms) | ✅ 60fps 이내 |
| **1b. 타이핑 rAF 프레임 델타** | **p95 33.40ms** (T1 후 동일) | **✗ 프레임 드랍 (30fps)** |
| 2. 오버랩 이미지 이동 | p95 15.80ms | ✅ (한계 근접) |
| 4. 인라인 글자크기 | p95 26.90ms | △ 30fps 수준 |
| 7c. layoutText (캐시 히트) | p95 0.80ms | ✅ 캐시 히트 8/8 |
| 7d. renderText (DOM diff) | p95 6.50ms | ✅ |
| 8a. 300p 빌드 (data assign) | 193.5ms (T1 후 179.9ms, T2 후 179.2ms) | 초기 로드 비용 |
| 8b. 300p 풀렌더 | 257.9ms (T1 후 264.2ms, T2 후 259.7ms, spans 179,400) | 초기 로드 비용 |
| 8c. park 297페이지 | 256.7ms (T1 후 255.6ms, T2 후 244.9ms, spans → 1,794, 100:1) | 가상화 효과 정상 |
| 8d. 재마운트 20p | avg 8.38ms / p95 11.10ms (T1 후 avg 8.55ms / p95 10.70ms, T2 후 avg 9.01ms / p95 11.00ms) | ✅ |
| 8e. 300p 타이핑 — 입력 동기 | p95 2.50ms (T1 후 2.50ms, T2 후 1.80ms) | ✅ |
| **8e. 300p 타이핑 rAF 델타** | **p95 33.30ms** (T1·T2 후 동일) | **△ 30fps 수준** |

**해석**:
- 시나리오 1(단일 문단 2000자, 페이지 구조와 무관)과 시나리오 8e(300p)의
  rAF 델타가 동일하게 ~33ms다 → **프레임 드랍의 주 성분은 DOM 렌더 비용이며
  페이지 수가 직접 원인이 아니다** (마운트 윈도우가 작을 때).
- 헤드리스 SwiftShader 감안 시 실기에서는 훨씬 낮다. 정확한 귀속은
  PERFORMANCE.md § 11.5의 실기 측정(엔진 2.7ms·4% vs DOM 90%+)을 따른다.
- 8a/8b/8c는 초기 로드 1회성 비용으로 양호하다.

### 2.2a T1/T2 적용 후 재검증 — virtualization.html 실측 (2026-09-15, 커밋 cc035e9)

> 사용자 보고 "모든 항목 적용 후에도 눈에 띄는 성능 향상이 없다"에 대한
> 귀속 조사. 판단 기준 페이지: `examples/virtualization.html`
> (30p, 6체인×5프레임, window=1, editableText). 측정 스크립트는 세션
> 아티팩트(일회성) — 재현 계측法은 이 절 각주 참조.

**적용 수정의 작동 검증 (계측 카운터)**:

| 수정 | 타이핑 중 발화 여부 | 판정 |
| --- | --- | --- |
| T1-1 confirmThreadChain 게이트 | **호출 0회/90키** (수정 전에는 페이지 렌더마다 호출) | ✅ 작동. 단 **타이핑 핫패스에는 원래 없던 경로** — 효과는 초기 로드·스크롤·문서 렌더에만 귀속 |
| T1-2 data 재주입 게이트 | 타이핑은 `textContent` setter 경로라 게이트를 지나지 않음 | ✅ 작동하나 **타이핑과 무관** — 효과는 undo/외부 재주입에 귀속 |
| T2-1 페이지 dirty 게이트 | 초기 로드 1회성 경로 | 초기 로드 소폭 개선 (8a 193→179ms) |
| T2-2 공간 우선순위 | progressive OFF 데모라 미발화 | 이 데모에서는 무효 |

**virtualization.html 타이핑 실측 (head 편집 40키, 체인0, window 0/1/2)**:

| window | 입력 동기 | rAF p50 | rAF p95 | 키당 layoutText |
| --- | --- | --- | --- | --- |
| 0 (2-3p 마운트) | avg 8.8~10.2ms | 33~67ms | 117ms | 4~7회 |
| 1 (기본) | avg 9.0ms | 33ms | 200ms | 4~8회 |
| 2 | avg 8.6~8.7ms | 33~50ms | 183~233ms | 4~8회 |

**CDP JS 프로파일러 귀속 (head 40키, window=1)** — 총 샘플 7,008ms 중:

| 구간 | 셀프타임 | 비중 | 귀속 |
| --- | --- | --- | --- |
| `(program)` — 스타일 재계산·리플로우·페인트 | 3,695ms | **53%** | 브라우저 렌더링 (span 스타일 쓰기 후) |
| `_applySpanStyle` (column.element.ts) | 1,249ms | **18%** | **77%가 스레드 flush가 하류 프레임을 재렌더하는 경로** (`flushThreadRelayout → render → renderText`), 23%가 초기 span 생성 |
| `getBoundingClientRect` | 705ms | **10%** | **100% 커서 갱신 `_updateCursorPosition`** (55% `_onInput` 즉시 갱신 + 39% `postRender` 갱신 + 4% 스레드 flush 후) — **키당 2회의 강제 리플로우** |
| `renderText` (diff 본체) | 636ms | 9% | DOM diff 자체 |
| 엔진 전체 (layoutText·charWidth·_layoutColumnsPass 등) | ~200ms | **~3%** | 엔진은 범인 아님 (재확인) |

**결론 (사용자 체감 "향상 없음"의 귀속)**:

1. **적용된 T1/T2 수정은 전부 정상 작동한다** (카운터로 확인). 그러나 이 데모의
   핫패스(타이핑)가 밟는 경로와 수정 경로가 **거의 교차하지 않았다** — T1-1은
   문서 렌더 시리즈, T1-2는 data 재주입, T2-2는 progressive 전용이라 이 데모
   (progressive OFF)에서 발화하지 않는다.
2. **타이핑 병목은 여전히 DOM 3종** (§7.1 재확인): 스타일 재계산·페인트 53% +
   `_applySpanStyle` 18% + **커서 갱신의 강제 리플로우 10%**. 엔진은 3%.
   → 조정 계층 수정(캐시·게이트류)은 이 분포에서 구조적으로 체감 한계가 있다.
3. **신규 실측 발견 — 커서 갱신의 중복 강제 리플로우**: 키 입력마다
   `_updateCursorPosition`이 **2회** (input 핸들러 즉시 1회 + postRender 1회)
   `getBoundingClientRect`를 호출해 리플로우를 강제한다. 이는
   `PERFORMANCE.md §4.4`의 "커서 dirty + rAF 단일 스케줄링" 계약과 어긋나는
   듯한 중복이며, **T1/T2와 무관한 독립 레버**다 (검증 필요 — 아래 후속 카드).
4. **신규 실측 발견 — head 편집의 하류 프레임 전 span 재스타일링**:
   `_applySpanStyle`의 77%가 스레드 flush 재렌더에서 발생. 하류 프레임은
   `contentFrom`이 +1 shift되므로 모든 span의 `data-source-offset`이 바뀌어
   diff가 전체를 재작성한다 — §7.1의 "shift 편집 재계산 필수" 결론의 DOM 측
   확인. 레버는 (a) 체인 분할(이 데모는 이미 5프레임으로 분할됨 — 실측에서
   layoutText 4~8회/키로 확인, 단일 30프레임 체인이라면 6배), (b) 하류
   프레임의 span 스타일 쓰기 스킵 폭 확대 (아래 후속 카드).

**재현 계측法**: Playwright(헤드리스)로 virtualization.html 로드 →
`em.focusParagraph(마운트된 체인 head)` → textarea에 `InputEvent('input')`
30~40회 (매 키 rAF 2회 대기) → CDP `Profiler.start/stop`으로 샘플 수집.
주의: `focusParagraph` 직후 textarea는 전체 선택 상태이므로 반드시
`setSelectionRange(0,0)`으로 붕괴할 것 — 붕괴하지 않으면 첫 키가 스토리
전체(6,261자)를 교체하는 파괴적 워크로드가 되어 측정이 무효화된다 (본 조사
1차 측정에서 실제로 발생).

**후속 레버 (신규, DOM 계층 — 감사 로드맵 Tier 2 확장)**:

- **L-1 (커서 갱신 단일화)**: `_updateCursorPosition`의 input 경로와
  postRender 경로가 같은 프레임에 2회 강제 리플로우를 유도하는지 조사 →
  rAF 병합으로 1회화. `getBoundingClientRect` 셀프타임의 대부분(키당 ~17ms
  샘플)이 여기서 나온다. `PERFORMANCE.md §4.4` 계약과 대조 필요.
- **L-2 (하류 프레임 스타일 쓰기 스킵)**: shift로 `data-source-offset`이
  전부 바뀐 하류 프레임의 `_applySpanStyle`에서, **스타일 키가 실제로
  변하지 않은 span**은 쓰기를 건너뛰는 diff 확장. `_skipSpanStyleIfUnchanged`가
  이미 존재하므로, "offset은 바뀌어도 스타일 문자열은 동일" 판정이 맞는지
  확인 후 적용. 검증: `verify-dom-diff` + snapshot byte-identical + span
  style 미기록 캐시 무결성.
- **L-3 (paint 스코프 축소)**: `(program)` 53%의 정체가 컬럼 단위 스타일
  재계산·페인트라면, 변이가 커서 위치의 컬럼에 국한될 때 페인트 영역을
  좁히는 브라우저 힌트(`contain: layout style` 등) 적용 검토 — 단, 걸침표
  overflow: visible 등 기존 시각 계약과 충돌 여부 선제 확인.

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

> **해결됨 (2026-09-15, T1-1)** — 세 구현: ① 문서 `render()`가 페이지 순회를
> `_suppressThreadConfirm`으로 흡수(layout()과 동일 계약)하고 종료 시점 1회 확정.
> ② 페이지 위임을 게이트화 — `LayoutDocumentElement`의 공개 API
> `isThreadConfirmSuppressed`(흡수 중 판정 비용 O(트리) 생략) +
> `hasUnsyncedThreadFrames()`(문서 스코프 판정. 페이지 `ctx.engine`은 문서
> 소속 시 undefined이므로 검사 주체는 문서 요소)를 거쳐 미동기화 프레임이
> 있을 때만 확정 위임. ③ coordinator `hasUnsyncedThreadFrames`를
> `findEnginesByIds` 일괄 조회(트리 1회 순회)로 전환.
> 검증: verify-threading 114P / verify-threading-browser 49P / verify-page-model /
> verify-caret-parking 28P / snapshot byte-identical. 재측정 §2.2 참조.

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

> **해결됨 (2026-09-15, T1-2)** — `set data`에 레이아웃 입력 동등성 게이트
> (`_dataInputEquivalent`): `content`/`overlayEngines`/`parentAbsRect`/`resources`/
> `parentBox`/`id`/`zIndex` 참조 비교 + `column`/`gap` `valueEqual` +
> `paragraphStyle`/`textStyle`/`inheritStyle` 얕은 필드 비교
> (`styleShallowEqual` — extractData 왕복이 스타일을 매번 새 객체로 조립하는
> 것을 값 비교로 흡수). 게이트 통과 시 `resetIncrementalState()` 생략 +
> `_renderShapePreserved` 보존 + effective dirty만 세움.
> **T1-3 불요**: 값 비교가 왕복을 흡수하므로 스냅샷 계약 변경 없이 해소.
> **첫 주입 구별 필수**: 생성자가 `this._data`를 미리 설정한 뒤 setter를
> 호출하므로 첫 주입이 게이트를 통과하면 초기화가 생략됨(verify-threading [1]
> 실패로 발견) — `_lineHeight !== 0`(완전 경로 통과 후에만 유효한 값)을 게이트
> 조건에 포함해 구별. 실측 근거: `/tmp/opencode/repro-t12.mjs` 재현 → 수정 후
> HEAD 동일(overflow 216).
> 검증: verify-threading 114P / story-reference-refresh 30P / inline-metrics 47P /
> multicolumn / engine-node 25P / dom-diff / hanging-punctuation 82P /
> word-wrap 32P / snapshot byte-identical.

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

> **해결됨 (2026-09-15, T2-1)** — `LayoutPageElement._structureDirty` 플래그를
> 신설했다 (감사 권고의 "페이지 data setter·프로퍼티 setter가 dirty를 세우도록
> PageEngine `_dirty`를 DOM 변경 경로와 연결"을 DOM 계층 플래그로 구현 —
> `PageEngine._dirty`는 `layout()`에서 소각되어 소비 시점에 항상 false라
> 단일 소스가 될 수 없음이 소스 검증으로 확인됨).
>
> 세움 경로: 페이지 `set data` · 프로퍼티 setter 8종(width/height/padding×4/
> columns/gap/paragraphStyle/textStyle) · `appendChildData`/`removeChildData` ·
> 문서 스타일 setter(paragraphStyle/textStyle → `_markAllPagesStructureDirty`) ·
> `unparkPage`(재마운트 재구축). 소각: `page.layout()`.
>
> 게이트: `document.layout()` 루프가
> `page._structureDirty || page.engine?.dirty || !page.engine`일 때만
> `page.layout()` 실행. `_layoutPageOrder`·`adoptPageEngines`·스레드 패스는
> 전 페이지 대상이라 무조건 유지 (감사 권고의 "순서 배치는 유지" 준수).
>
> 안전 규칙: ① 신규/미연결 페이지는 `_structureDirty` 초기값 true + `!page.engine`
> 조건으로 무조건 재구축. ② 문서 data setter reconcile은 페이지마다
> `page.data = child`를 호출하므로 플래그가 자동 세워져 기존 동작 보존.
> ③ 엔진 개별 setter pending은 `page.engine?.dirty`로 흡수.
> 검증: verify-page-model / verify-page-reorder-parked / verify-threading 114P /
> verify-virtualization 47P / verify-progressive-layout 21P / verify-threading-browser /
> verify-dom-diff / verify-caret-parking 28P / snapshot byte-identical.

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
| **T1-1** ✅ 해결됨 (2026-09-15) | 페이지 렌더의 `confirmThreadChain` 위임을 `hasUnsyncedThreadFrames` 게이트 (문서 렌더 종료 시 1회 확정 유지). `hasUnsyncedThreadFrames`를 `findEnginesByIds` 일괄 조회로 전환 | 결함 1 | `page.element.ts`, `document.element.ts`, `thread-relayout-coordinator.ts` | 초기 렌더/스크롤 스케일 O(P²)→O(P) |
| **T1-2** ✅ 해결됨 (2026-09-15) | `ParagraphEngine.set data` 참조 비교 게이트 (동일 참조 6필드 → 소각 스킵, 경량 갱신 경로). 첫 주입 구별 `_lineHeight !== 0` 포함 | 결함 2 | `paragraph-engine.ts`, `paragraph-text-utils.ts` (`styleShallowEqual`) | data 재주입·undo 시 전 문단 재배치 제거, 스레드 체인 전이 차단 |
| **T1-3** ✅ 불요 판정 (2026-09-15) | T1-2의 얕은 필드 비교가 extractData 왕복을 흡수 — 스냅샷 계약("추출 데이터는 스냅샷") 보존이 우선. 참조 재사용은 미실시 | 결함 2 | — | T1-2로 우회 경로 해소 |

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
| **T2-1** ✅ 해결됨 (2026-09-15) | `document.layout()` 페이지 dirty 게이트 — `LayoutPageElement._structureDirty`(DOM 계층 플래그) + `page.engine?.dirty` 소비, 문서 스타일 setter·unpark 경로 연결 | 결함 3 | LO "첫 invalid 페이지부터" (§5.3) |
| **T2-2** ✅ 해결됨 (2026-09-15) | progressive 펌프에 **공간 우선순위** 추가 — 청크 시작 시 뷰포트 교차 페이지를 앞순위로 소진 (`_displayPriority` + `visualViewport` rect). 인터럽트는 입력 기반 유지 (flush 관문, 타이머 기반 중단 없음 — tdf#141556 교훈). 최종 수렴 상태는 순서 무관이라 표시 결과 동일 | DOM 레이턴시 | LO SwLayAction IsShortCut + SwLayIdle, 실측 963→14ms (§5.3) |
| **T2-3** ✅ 불요 판정 (2026-09-15, 실측 근거) | 런 단위 셰이핑 폭 캐시 — `benchmark-hotloop.mjs` 실측에서 `_charWidthMm` 잔여 비용(키당 0.46ms, 36.6%)은 **캐시 히트 후의 키 문자열 생성+LRU 조회 비용**이며(561k 호출, 히트 지배), 폰트 메트릭 미스는 키당 0.67µs(28회)로 노이즈. 런 단위 캐시(Scribus ShapedTextCache형)가 새로 잡을 비용이 이 구조에 없음 | §5.4 갭 | Scribus ShapedTextCache (§5.2) |
| **T2-4** ✅ 불요 판정 (2026-09-15, 실측 근거) | `_charWidthCache` 전역 공유 — 실측 근거 부재. 문단 인스턴스당 LRU 5000이 이미 폰트 미스 경로를 소진하며(위 T2-3 실측), 전역 공유는 참조 경합과 캐시 키 분리(char\|font\|size) 복잡성만 추가. 재측정에서 회귀 없음 | VIRTUALIZATION 2.3 | InDesign IStoryService 글리프 캐시 |
| **T2-5** ✅ 불요 판정 (2026-09-15, 소스 근거) | 배치 편집 밸브 (`setReflow(false)` 상당) — T1-1이 문서 render/layout 시리즈의 체인 확정을 흡수 플래그+게이트로 **1회로 통합**했고, T1-2가 data 재주입의 캐시 소각(체인 전체 재배치 트리거)을 차단했다. Scribus 밸브의 목적(문서 재구축 중 체인 재배치를 마지막 1회로 지연)은 이미 달성 — 추가 밸브는 이중 제어 | 결함 1·2 완화 | Scribus 24배 실측 (§5.2) |

### 6.4 Tier 3 — 정책/경고 (적용 시 후속)

- **레이아웃 결과 eviction 금지** ✅ 계약화 (2026-09-15, RULES.md §5.4 신설) —
  LO 2025 전환(§5.3)과 동일하게 `_layoutCache`를 대형 문서 지원 명분으로 축출하는
  정책을 만들지 않는다. 소스 검증 결과 축출 정책이 **이미 존재하지 않음**
  (`_layoutCache`는 인스턴스 필드 — LRU/용량 상한 없음)을 확인했고, 스레드 스킵
  판정(`hasLayoutCache` 조건)이 eviction을 구조적으로 금지하므로 구현이 아닌
  **금지 규칙 신설**로 계약화했다. 소각은 명시적 무효화 경로(resetIncrementalState /
  updateThreadContext 변경 감지 / textContent setter)만 허용.
  메모리가 재검증 분기보다 싸다 (실측 근거 존재).
- **영구 페이지 분할 캐시** ✅ 불요 판정 (2026-09-15, 소스 근거) — LO SwLayoutCache의
  목적은 "문서 열기 시 직렬 발견식(sequential discovery) 재배치 제거"다. 본 엔진의
  스레드 배치는 `threads[].content`(story) + `contentFrom` 연쇄가 **선언형 입력**이라
  발견식이 구조적으로 부재 — `ThreadEngine.layoutThreads`는 story를 feed-forward로
  배치하고, `_threadInputUnchanged` 스킵 판정이 O(1) 참조 비교로 재배치를 소진한다.
  페이지별 첫 박스/스토리 오프셋 힌트를 저장 데이터에 직렬화해도 생략할 재계산이
  없다. 문서 로드 시 초기 배치는 어차피 O(스토리) 1회 필수 작업이다.
- **스크롤 중 이미지 프록시 품질** (InDesign 표시 3단계, §5.1) — 사용자가 제외 (미적용).
- **페이지 자동 증감 게이트** (InDesign Smart Text Reflow 조건, §5.1) — 사용자가 제외
  (미적용). 오버플로우 자동 페이지 추가 기능을 만든다면 키 입력 단위가 아니어야 한다.
- **경우에 따른 싼 모드 폴백** (InDesign 단행 조판기 전환, §5.1) ✅ 불요 판정
  (2026-09-15, 소스 근거) — InDesign이 이 폴백을 쓰는 이유는 인라인 오브젝트
  text-wrap과 문단 조판기의 **환형 의존성**이라 해소 불가능하기 때문이다. 본 엔진은
  동일 함정을 이미 **핀 포인트 가드**로 해소했다: 걸침 패스가 오버랩 파트 라인을
  스킵하고 금칙 폴백으로 돌아가고(`_applyHangingPunctuation` 엣지 게이트 —
  verify-hanging-punctuation 항목 10), 프레임 경계 금칙 교정이 워드 글자를
  건너뛴다(`_boundaryCorrection` 워드 가드 — "워드 무결성 > 금칙"). 병리 결합 시
  문단 단위 단행 전환은 기존 가드의 세분화일 뿐 이중 분기·배치 모드 전환 비용만
  추가한다 — 폴백 밸브가 필요한 실제 정체(무한 수렴 실패 등)는 현재 가드 구조에서
  발생 경로가 없다.

### 6.4a 후속 레버 — DOM 계층 (2026-09-15 실측으로 신설, §2.2a 참조)

> T1/T2 적용 후에도 체감 개선이 없었던 원인: **타이핑 핫패스의 병목은 조정
> 계층이 아니라 DOM 3종** (프로그램 53% + `_applySpanStyle` 18% + 커서 갱신
> 강제 리플로우 10%, 엔진 3%). 아래 레버는 이 분포에 직접 대응한다.

| ID | 작업 | 실측 근거 (§2.2a) | 검증 |
| --- | --- | --- | --- |
| **L-1** ✅ 해결됨 (2026-09-15) | 커서 갱신 단일화 — `_onInput`의 optimistic-span 동기 `_updateCursorPosition`/`_updateSelection`을 `_scheduleCursorSelectionUpdate()` rAF 스케줄로 교체 (postRender의 `_cancelCursorSelectionUpdate`가 커밋 프레임에서 소비해 갱신 1회 수렴). postRender 소량 동기 배치(threshold ≤8)는 기존 실측 계약(6.4→14.6ms)이라 유지. 조합(IME) 경로는 현행 유지 | GBCR 셀프타임 705ms 중 100%가 커서 갱신, 키당 2회 구조 | `verify-caret-parking.mjs` (28P — 커서 내비게이션 변경 시 선행 필수) + `verify-ime.mjs` | **실측: GBCR 705→316ms (−55%), `_onInput` 기원 GBCR 소멸(잔존 86%가 postRender 기원). 입력 동기 10.1→0.49ms.** 회귀: caret-parking 28P·IME·dom-diff·multicolumn·pending-style 31P·threading 114P·threading-browser 49P·overflow-clamp 24P·visual-render·engine-node 전부 PASS |
| **L-2** ✅ 해결됨 (2026-09-15, 설계 전환) | 하류 프레임 스타일 쓰기 스킵 → **전제 실측으로 설계 변경**: head 1키 시프트 시 하류 프레임 재적용 span의 **96%가 "같은 슬롯에 다른 글자"**(글자변경 4,210/4,378 — 불변 4%뿐). 원인은 span 재사용 키(`data-source-offset`)가 **프레임 로컬 고정**이라 콘텐츠 시프트가 슬롯 내 글자 교체로 나타나는 구조적 필연 — 키를 절대 공간으로 바꾸면 mapper 8곳·컨트롤러·검증기 전역 변경이라 비용>이득. **구현**: `genCharStyleFlatCss` 신설(치수 스타일의 직렬화 문자열 LRU 캐시) + `getCachedCharFlatStyleTop`(수직 앵커 캐시 — 호출 순서 계약: FlatCss 먼저) + `_applySpanStyle` full 모드를 `cssText=''`+`Object.assign(객체)`에서 `cssText=캐시문자열` 단일 쓰기로 전환 (dataset 스냅샷 6종·getCharWidths 2단 캐시는 스킵 판정 전제라 유지) | `_applySpanStyle` 1,249ms 중 77%가 스레드 flush 재렌더 경로, 재적용 span의 96%가 글자 변경 | `verify-dom-diff.mjs` + snapshot byte-identical + `verify-threading.mjs` | **실측: _applySpanStyle 1,249→1,127ms (−10%, 3회 측정 중앙값)**. snapshot byte-identical. 회귀: dom-diff·threading 114P·threading-browser 49P·IME·caret-parking 28P·multicolumn·tab-single-source·inline-metrics 47P·text-decoration 60P·hanging 82P·visual-render·engine-node 전부 PASS. **한계**: 개선이 −10%에 그친 이유는 셀프타임의 지배 성분이 CSSOM cssText 파싱 자체라 문자열 쓰기도 파싱이 필요하기 때문 — 잔여 성분(dataset 쓰기·getCharWidths)은 스킵 판정 전제로 불가피. **프레임 p50 33ms의 주 성분은 이 함수가 아니라 (program)(스타일 재계산·페인트)이며, 이는 하류 프레임의 실제 DOM 변이량(라인 경계 이동)이 결정 — 추가 절감 레버는 체인 분할뿐(§7.1 결론 재확인)** |
| **L-3** ✅ 재적용 (2026-09-15, 사용자 판정) | CSS `contain` (layout/paint/style) — page 요소 루트 div에 적용. 정합성 검증 전부 통과(visual-render 7P·hanging-punctuation-browser 11P·caret-parking 28P·virtualization 47P — 걸침표 페인트 클립 충돌 없음 실측). 헤드리스 벤치마크에서 JS 시간 개선 미검출이지만 **이는 정상** — contain의 목적은 JS 실행이 아니라 **브라우저 페인트·컴포지트 범위 클립**(사용자 지정: 화면 렌더링상의 이점이 목적). 체감 효과는 사용자의 실제 화면에서 판단: 스크롤(뷰포트 밖 마운트 페이지 페인트 스킵)·스타일/레이아웃 검토 국한(한 페이지 변이가 다른 페이지 검토로 번지지 않음)이 기대 이득. 체감 개선이 없으면 사용자 판단으로 제거 (재적용/제거 비용 1줄) | `(program)` 3,695ms (53%) — 페인트·컴포지트 성분 | `verify-visual-render.mjs` + `verify-hanging-punctuation-browser.mjs` |

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

## 6.6 인계 과제 1 — CSS `contain` 체감 검증 (다른 에이전트 처리용)

> **상태**: 이미 적용 완료(`page.element.ts` `_applyStyle` — 루트 div에
> `contain: layout paint style` 1줄). 이 장은 **체감 검증·원복 절차**를
> 인계하는 문서다. 코드 변경이 아니라 **평가와 판단**이 과제다.

### 6.6.1 무엇이 적용되어 있는가

`LayoutPageElement._applyStyle()` 말미 (`page.element.ts`, "L-3" 주석 표식):

```ts
this._root.style.contain = 'layout paint style';
```

- `layout`: 페이지 내부(박스·문단·이미지)의 레이아웃이 이웃 페이지에 역영향을
  주지 않음을 브라우저에 보증 — 한 페이지의 변이가 다른 페이지의 레이아웃
  검토로 번지지 않는다.
- `paint`: 페이지 경계에서 페인트를 클립 — **스크롤 시 뷰포트 밖 마운트
  페이지의 페인트 스킵** (PageMountManager가 park하지 않은 마운트 페이지에 유효).
- `style`: counter 등 스타일 스코프 (우리는 미사용 — 사실상 무영향, 미래 안전용).

**측정 가능성 경계 (이 실험의 핵심 교훈)**: contain의 이득은 JS 실행 시간이
아니라 **브라우저 페인트·컴포지트 범위 클립**이다. 헤드리스(SwiftShader)
벤치마크는 JS 시간만 보므로 개선이 검출되지 않는 것이 정상이다 (실측: 8a/8b/8d
노이즈 밴드, 1b/8e rAF p95 불변). **체감 검증은 실제 화면에서 수행한다.**

### 6.6.2 시각 계약 충돌 목록 (이미 실측으로 해소 — 원복 시 재사용)

| 충돌 후보 | 판정 | 검증 |
| --- | --- | --- |
| 걸침표(행말/행두) 컬럼 밖 페인트 | **충돌 없음** — paint 클립 범위는 page 루트 div이고 걸침 돌출은 컬럼 밖이지만 **페이지 안쪽** | `verify-hanging-punctuation-browser.mjs` **11P** (걸침 span `shadowRoot.elementFromPoint` 도달 실측) |
| 커서·textarea·optimistic span 오버레이 (paragraph shadow root) | 클립 대상 아님 — 커서/textarea는 문단 내부에 배치 | `verify-caret-parking.mjs` **28P** (커서 px 좌표 고정) |
| `contain: size` | **금지** — `:host`가 `fit-content`이고 mm 크기가 동적 결정이라 정면충돌. 적용하지 않음 | — |

### 6.6.3 체감 검증 절차 (판단 기준)

1. **비교 방법**: 동일 문서·동일 작업을 contain ON/OFF로 교차 수행
   (DevTools에서 `document.querySelector('#page-root...').style.contain` 토글,
   또는 코드 주석 처리). 페이지 수가 큰 문서(30p+)에서:
   - 스크롤 부드러움 (뷰포트 밖 페이지가 화면에 들어올 때의 페인트 지연)
   - 편집 중 다른 페이지가 같이 깜빡이거나 밀리는지
   - DevTools Performance 패널의 Paint / Recalc Style 영역 감소 (레코드 비교)
2. **판정**: 체감 개선이 없으면 제거 (1줄). 개선이 있으면 유지 + 아래 갱신.
3. **문서 갱신 계약**: 판정 결과를 이 카드에 스탬프 (ON 유지 / OFF 제거 + 실측 근거).

### 6.6.4 원복/재적용 (비용 1줄)

- 제거: `this._root.style.contain = 'layout paint style';` 삭제 (주석 포함).
- 재적용: 동일 줄 복원. 두 경우 모두 `tsc --noEmit` + 위 표의 검증 3종 재실행.

---

## 6.7 인계 과제 2 — 체인 분할 (다른 에이전트 처리용 설계)

> **상태 (2026-09-15)**: **옵션 B(자동 감지 분할) 구현 완료** —
> `src/engine/auto-thread-splitter.ts` + `DocumentEngine._ensureAutoThreads()`,
> 검증 `verify-chain-split.mjs` 33P + 전수 회귀 PASS. 구현 기록 §6.7.5-a.
> 이 장은 설계 배경·계약을 남긴다. 남은 것은 **체감 측정**(실기)뿐이다.

> **배경**: §2.2a + L-1/L-2 완료 후 남은 유일한 구조 레버. §7.1 결론("shift
> 편집의 재쓰기는 필수 — 남는 레버는 체인 분할·윈도우 축소")과 L-2 한계 실측이
> 모두 이 레버를 가리킨다. **윈도우 축소와 엔진·DOM 최적화는 소진됐다.**

### 6.7.1 체인이란 — 데이터 구조 (구현 전 필독)

스레드 = InDesign식 텍스트 흐름. `src/types/layout/thread.type.ts`:

- `content` — 스토리(연속 텍스트) 전체. **head 프레임(첫 문단)의 엔진이 소유**.
- `paragraphIds` — 흐름 순서대의 프레임 문단 id 배열 = **체인**.
- 문서 계층: `DocumentData.threads: ThreadData[]` — 문서 엔진이 소유하며
  페이지 경계를 가로질러 프레임을 조회한다 (`DocumentEngine._layoutThreads`).

`ThreadEngine`이 프레임을 순서대로 배치(feed-forward)하며, 앞 프레임의
tail(`overflowContentFrom`)이 다음 프레임의 시작점(`contentFrom`)이다.
체인 끝 프레임에 잔여(overset)가 남으면 빨간 테두리(overset tail 표시).

### 6.7.2 왜 체인이 타이핑 비용의 직접 레버인가

**한 체인 = 타이핑 1키의 재계산 단위.** 어떤 프레임에서든 글자를 쓰면
소속 체인의 하류 프레임 전부가 feed-forward로 재배치되고(shift 편집 시
상류도), 마운트된 프레임은 DOM span 전체 재작성(라인 경계가 전부 이동)된다.

§11.5 실측(30프레임 **단일 체인** 데모): head 타이핑 롱태스크 합 ~468ms(window=1),
~308ms(window=0) — **윈도우 축소는 마운트 DOM만 줄이고 체인(30프레임)은 그대로**.
엔진은 끝쪽이 6배 저렴(50→8ms)해도 체감의 90%는 마운트 윈도우 DOM 비용이라
체감이 위치와 무관. **체인 길이 = 키당 비용 배수**가 구조적 결론이다.

L-2 전제 실측(이 문서 §6.4a)도 재확인: head 시프트 시 하류 프레임 재적용 span의
**96%가 "같은 슬롯에 다른 글자"** — 이는 체인이 길수록 키당 DOM 변이량이
비례한다는 뜻이다.

### 6.7.3 체인 분할 = 기사 단위 정책 (엔진 변경 아님)

**핵심**: 신문 텍스트 흐름은 무한 체인이 아니라 **기사(article) 단위**다.
기사가 5페이지를 차지하면 그 5프레임만 하나의 체인. 서로 다른 기사는 서로 다른
체인 — **키 입력의 재계산·재렌더 범위가 기사 안으로 한정**된다.

| 체인 구성 | 키당 재배치 | 30p 문서 체감 |
| --- | --- | --- |
| 단일 30프레임 체인 | 30프레임 | 느림 (§11.5 실측) |
| **6체인 × 5프레임** | **5프레임** | **체인당 6배 절감** |

**이것은 엔진 변경이 아니다** — `threads[].paragraphIds`를 어떻게 끊느냐의
**데이터 구성 정책**이고, feed-forward·범위-증명 스킵 등 스레드 배치 메커니즘은
전부 그대로 작동한다. **기능 훼손도 없다** — 각 체인은 독립 story로 완전한
스레딩이며, 기사가 늘어 넘치면 그 기사의 마지막 프레임에 overset tail(빨간
테두리)로 표시된다. **단점**: 기사가 늘어 흐름을 이어야 하면 체인 정의를
갱신해야 한다 (자동 흐름은 체인 경계에서 끊긴다).

### 6.7.4 구현 옵션 (검증 상태 포함)

| 옵션 | 방법 | 위치 | 검증 상태 |
| --- | --- | --- | --- |
| **A** | 문서 작성 시 기사별로 `threads[]` 분할 정의 | 호스트 데이터 생성 | **✅ 이미 검증** — `virtualization.html`이 A 구조로 동작 중 (6체인×5프레임), `verify-threading` 114P·`verify-threading-browser` 49P·`verify-page-model` 13P가 이 구조를 방어 |
| **B** | 자동 분할 — 기사 박스 감지로 프레임 그룹별 체인 생성 | 라이브러리 정책 | **✅ 구현 완료 (2026-09-15)** — `src/engine/auto-thread-splitter.ts` 신설 + `DocumentEngine._ensureAutoThreads()` 주입. 검증 `verify-chain-split.mjs` 33P. 상세 §6.7.5-a |
| C | 편집 UI에서 사용자가 체인 끊기 (InDesign UX) | 호스트 UI | 미착수 (호스트 영역) |

### 6.7.5 옵션 B 설계 — 자동 감지 분할

**감지 근거(단일 소스)**: 기사 그룹의 식별자는 이미 존재한다.

- `BoxData.role === 'group-article'` — 기사 그룹 컨테이너 (`box.type.ts`).
- `BoxData.contentUid` — 박스가 담은 콘텐츠의 외부 식별자(기사 UID). Place Gun이
  기사 주입 시 body/title box의 paragraph에 기사 UID를 기록한다
  (`EDITING_PLACE_GUN.md` §4.3 — 케이스 1: group-article 내 title/body).
- `BoxEngine.groupMember` — 이 박스+하위 박스의 contentUid/groupMember 합산
  getter (`box-engine.ts:411`). group-article box는 소속 기사 UID를 보유한다.

**분할 알고리즘 (권고, 엔진-우선)**:

1. 문서 엔진 트리에서 `role === 'group-article'` 박스를 수집 — 기존 단일 소스
   `findBoxEnginesByRole('group-article')` (`page-engine.ts:393`, 재귀 순회·
   테이블 셀 관통 포함).
2. 각 group-article 내 `role === 'body'` 박스들의 paragraph(스레드 프레임)를
   **문서 순서**로 수집 → 체인 1개. `contentUid`가 있으면 `thread.id = uid`를
   제안 키로 사용 (`ThreadEngine.threadKeyOf`는 id 우선 — 체인 식별 안정화).
3. group-article 밖의 잔여 프레임은 기존 방식(단일 체인 또는 호스트 정의) 유지 —
   기존 `threads` 데이터와 병합 시 **id 충돌·중복 소속 금지**
   (`ThreadEngine.validate`의 first-claim-wins가 방어하되, 새 체인이 기존
   프레임을 이중 소속시키면 story 소실 — RULES §1.10).
4. `content`(story) 산출: 체인의 head 프레임에 배치될 텍스트 소스를 호스트
   데이터(기사 본문)에서 취한다 — 엔진이 story를 발명하지 않는다(단일 소스 계약).

**계약·주의사항**:

- 자동 분할은 **문서 로드/구조 변경 시점의 정책**이다 — 편집 중 체인 재정의는
  스레드 writeback(identity 계약: `threads[].content` 원본 객체 기록,
  document-engine.ts `_writebackThreadStory`)과 충돌할 수 있으므로, 분할은
  문서 구성 시점(데이터 조립)에서 수행하는 것이 안전하다.
- 분할로 기존 체인이 쪼개지면 `ThreadEngine`의 커밋 기록(`_committedByThread`,
  키 = threadKeyOf)이 어긋난다 — 키가 바뀌면 스킵 판정은 자연 폴백(재배치)이라
  정확성은 안전하나, **분할 직후 1회 전체 배치 비용**이 발생한다 (예상 가능).
- `pageNumber`/스프레드(`spreadPages`) 배치와 무관 — 체인은 텍스트 흐름만
  소유하고 페이지 순서 배치는 `_layoutPageOrder`가 소유한다.
- **금지**: DOM에서 체인을 추론하지 말 것 — 엔진 트리(mm 데이터)만 소스로 쓸 것
  (엔진-우선 원칙, RULES.md §3).

**검증 계획 (신규 스크립트 권장: `scripts/verify-chain-split.mjs`)**:

1. group-article N개 문서에서 자동 분할 결과 = 기사별 프레임 그룹 (N체인).
2. 기사 A 프레임 타이핑 → **기사 A 체인만 재배치** (다른 체인 `skipped: true`
   실측 — `_threadInputUnchanged` 스킵 판정이 체인 스코프로 수렴하는지 카운터).
3. 기사 경계 프레임(마지막 프레임 overset) 표시 — 빨간 테두리가 체인 tail에만.
4. 기존 단일 체인 문서(threads 1개)와 byte-identical 회귀 (분할 정책 OFF 경로).
5. park/unpark × 분할 체인 — story 보존·체인 유지 (`verify-virtualization` K 시나리오 확장).
6. printPostData 패리티 — 분할 체인 배치가 단일 체인 배치와 출력 동일.

**측정 판정**: 시나리오 8(300p) + virtualization.html에서 head 타이핑 rAF p50·
롱태스크 합을 체인 길이(30/5/3프레임)별로 측정 — 체인 길이와 비례하는지 확인
(§11.5의 윈도우 비례 실측과 대칭 구조).

### 6.7.5-a 옵션 B 구현 기록 (2026-09-15)

**구현 파일**:

| 파일 | 역할 |
| --- | --- |
| `src/engine/auto-thread-splitter.ts` (신설) | `collectAutoThreadChains(pages, existingThreads)` — 순수 함수. group-article 감지 → body 박스(트리 선순회·테이블 셀 관통)의 첫 문단을 그룹핑 키별 수집 → 문서 순서 체인 조립. DOM 참조 0 (Node.js 호환) |
| `src/engine/document-engine.ts` | `_ensureAutoThreads()` — `layout()` 진입 시 자동 체인을 `engine.data.threads`에 materialize. **명시적 threads 존재 시 정책 OFF** (기존 동작 byte-identical) |
| `scripts/verify-chain-split.mjs` (신설) | 33항목 — N체인 생성/체인 스코프 타이핑 스킵/페이지 경계 그룹핑/정책 OFF byte-identical/보수 게이트 5종/writeback identity/print 패리티 |

**핵심 설계 결정**:

1. **주입점 = `DocumentEngine.layout()`** — 모든 스레드 소비자
   (thread-relayout-coordinator 3곳, document.element `_relayoutThreads`,
   edit-manager `transferCursorToOwningThreadFrame`)가 `engine.data.threads`를
   직접 읽으므로, 엔진 데이터에 materialize하면 소비자 변경 0건으로 자동 체인이
   타이핑 전파·story writeback·커서 이관 전 경로에 보인다. 호스트 데이터 객체는
   변이하지 않는다 (엔진-우선, RULES §3).
2. **story 무발명** — 자동 체인의 `content`는 `undefined`이며
   `ThreadEngine` step-1 폴백(`thread.content ?? head.textContent`)이 head
   프레임이 소유한 텍스트를 story로 쓴다. Place Gun이 주입한 기사 본문이
   그대로 story가 된다. 이후 편집 writeback은 `originOf`가 materialize된
   객체를 되찾아 기록한다 (materialize는 최초 1회, 이후 재사용 — identity 계약,
   verify-chain-split [6d] 실측).
3. **그룹핑 키** — body 박스의 `contentUid`(기사 UID) 우선: 페이지 경계를
   넘는 동일 기사를 하나의 체인으로 묶는다 ([3] 실측). contentUid가 없으면
   소속 group-article 박스 id로 폴백 ([7] 실측).
4. **head 선규칙** — 첫 "내용이 있는" 프레임을 head로 (비어 있는 head는
   story 폴백이 ''를 소멸시키는 것을 방지).
5. **보수 게이트** — ① 체인 ≥2프레임 ② 기존 threads 소속 프레임 제외
   (first-claim-wins) ③ id 없는 문단 제외 ④ 전 프레임 빈 기사 제외 ⑤
   보호 게이트: head 이후 프레임이 비-스레드 + 비어있지 않으면(사용자가 넣은
   독립 콘텐츠) 체인에서 제외. 이전 분할 결과는 `isThreadFrame`이라 재수집됨
   (멱등).

**검증 결과 (2026-09-15)**:

| 검증 | 결과 |
| --- | --- |
| `verify-chain-split.mjs` (신설) | **33P** — §6.7.5 검증 계획 1·2·3·6 + 보수 게이트 |
| `verify-threading.mjs` | 114P — 기존 스레딩 회귀 없음 |
| `verify-story-reference-refresh.mjs` | 30P |
| `verify-engine-node.mjs` | 25P — 순수 함수 DOM-free 유지 |
| `snapshot-layout.mjs` | **byte-identical** (스냅샷 시나리오는 group-article 미사용 문서 — 정책 OFF 경로 확인) |
| `verify-threading-browser.mjs` | ALL PASS (49항목) |
| `verify-virtualization.mjs` | ALL PASS (47항목 — K 시나리오 park × 스레드 포함) |
| `verify-dom-diff.mjs` / `verify-multicolumn.mjs` / `verify-page-model.mjs` | ALL PASS |

**§6.7.5 검증 계획 대조**: 1(기사별 N체인)·2(체인 스코프 타이핑 스킵)·
3(tail 유일성)·6(print 패리티)은 verify-chain-split으로 통과. 4(단일 체인
문서 byte-identical)는 정책 OFF 게이트 + snapshot으로 통과. 5(park/unpark ×
분할 체인)는 기존 verify-virtualization K 시나리오가 명시적 체인을 방어하며,
자동 체인은 materialize가 엔진 데이터에만 존재하므로 park(엔진 생존)과
무충돌 — 별도 확장 시나리오는 향후 필요 시 추가.

**미해결 후속**: 체인 길이별 체감 측정(§6.7.5 측정 판정 — virtualization.html
30p 체인 vs 기사 분할 체인 비교)은 실기 사용자 워크플로에서 판단 (L-3 contain과
동일 — 호스트 마이그레이션 후 측정 의미가 있다).

### 6.7.6 순서 권고

1. **A 구조 확인**(기존): `virtualization.html` — 이미 동작.
2. **B(자동 분할) 구현**: `DocumentEngine` 또는 데이터 조립 유틸에서
   `findBoxEnginesByRole` 기반 체인 생성 (호스트가 threads를 안 넘겨도 동작).
3. 검증 계획 1~6 + 전수 회귀 (§6.5 목록).
4. 체감 검증은 실기에서 — L-3 contain과 함께 판단.

### 6.7.7 현행 동작 정리 (사용자 질의 "내부적으로 알아서 동작하는가"에 대한 답)

**현행 엔진은 체인을 절대 자동으로 만들지 않는다** — 체인은 전적으로 호스트가
데이터에서 명시적으로 정의해야 한다:

```ts
doc.data = {
  pages: [...],
  threads: [{ id: 'story-1', paragraphIds: ['p1','p2','p3'], content: '스토리 본문...' }],
}
```

- `threads`가 데이터에 없으면 `ThreadEngine` no-op (document-engine.ts —
  `if (!threads || threads.length === 0) return []`) → 각 문단이 **자기
  `content`로 독립 배치**된다 (흐름 없음).
- 엔진은 `threads[]` 정의를 **그대로 소비**만 한다 — 어떤 프레임들이 하나의
  흐름인지를 엔진이 추론하지 않는다.
- `virtualization.html` 데모도 직접 정의한 예 (6체인을 코드로 생성 — role
  기반이 아님).

**옵션 B(§6.7.5)는 이 "명시적 정의"를 라이브러리 자동화로 대체하는 신기능이며
미구현이다.** B 구현 전까지는 데이터에서 명시적으로 구분지어줘야 한다.

> **업데이트 (2026-09-15)** — 옵션 B 구현 완료. 이제 호스트가 `threads`를
> 넘기지 않아도 `group-article` 감지로 자동 체인화된다. 아래 §6.7.5-a 참조.

### 6.7.8 사용자 UI 흐름의 생태계 실측 (B가 왜 필수적인가)

사용자가 **UI로 텍스트를 넣는** 실제 워크플로에서의 스레딩 현황 (grep 실측):

| 흐름 단계 | 현황 | 스레딩 개입 |
| --- | --- | --- |
| 레이아웃 UI 호스트 | `threads` 필드를 생성/전파하는 코드 **0건** (`apps/layout-ui/src` grep 실측) | 없음 |
| Place Gun 기사 주입 (`_injectIntoGroupArticle`, place-gun-controller.ts:230) | title/body box의 **paragraph.content만 설정** + `contentUid` 기록 | 없음 — threads 정의·story writeback 모두 없음 |
| 주입된 기사 렌더 | 각 문단이 자기 content로 **독립 배치** (스레딩 없음 상태) | 없음 |
| 흐름(체인) 생성 | 호스트가 `threads[]`를 데이터에 명시해야 함 | 호스트 수동 |

**결론 — 사용자의 지적이 정확하다**: 자동 처리(B)가 없으면, 사용자가 UI로
넣은 기사는 스레딩 없이 프레임별 독립 배치로 렌더되므로 "페이지를 넘어가는
텍스트 흐름"은 **사실상 동작하지 않는다**. 체인 분할의 체감 이득은 B(자동
감지 분할)가 구현될 때만 UI 워크플로에서 실현된다 — A(호스트 수동 정의)는
데모/스크립트 환경의 방식이고 사용자 UI 흐름에는 적용되지 않는다.

따라서 인계 과제 2의 **핵심 산출은 B(자동 감지 분할) 구현**이며, 이것이
기능의 실제 동작을 만든다. 감지 근거(`group-article` role + `contentUid`)는
UI 주입 흐름이 이미 기록하는 값이므로, 주입된 기사를 자동으로 체인화할 수
있는 데이터는 존재한다 — 부족한 것은 이 데이터를 `threads[]`로 조립하는
정책 구현뿐이다.

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