# INCREMENTAL_REFLOW.md — 스레드 체인 타이핑 비용: 근본 원인 분석과 유효 레버

> **문서 성격**: 근본 원인 분석 + 유효 레버 목록 (측정 기반).
> 초안의 "라인 식별자 캐시(text-identity resync)" 방식은 **shift 편집에서
> 성립하지 않음이 증명**되어 폐기했다 (아래 §3). 이 문서는 무엇이 안 되는지,
> 무엇이 남는지를 기록한다.
>
> **관련 문서**: `docs/VIRTUALIZATION.md` (§7 후속 단계), `docs/PERFORMANCE.md`,
> `docs/TEXT_ENGINE.md`, `RULES.md § 3` (엔진-우선 원칙)

---

## 0. 요약 (TL;DR)

30프레임 체인 head 타이핑 1타의 실측 귀속 (헤드리스, longtask 합산 ~460ms):

| 구간 | 실측 | 성질 |
|---|---|---|
| 엔진 feed-forward 30프레임 | ~50ms | O(체인) — 아래 §3により削減 불가 판명 |
| 마운트 3문단 DOM 재쓰기·강제 리플로우·페인트 | ~400ms | O(이동 span) — 아래 §3により削減 불가 판명 |
| 해시·파싱·후처리·writeback (프레임당 합산) | 수 ms | 이미 최적 — 손댈 곳 없음 (실측: hash 0.1, parse 0.9, 후처리 ~0.3ms) |

**결론**: shift 편집(+1 삽입)은 모든 줄의 텍스트와 모든 위치의 글자를 바꾼다.
출력 자체가 전부 달라지므로 재계산·재쓰기는 정보이론적으로 필수다.
남는 레버는 **범위**(몇 프레임을, 몇 페이지를)뿐이다:
윈도우 3→2페이지에 490ms→308ms 실측. 체인 분할도 같은 축이다.
그리고 §5의 범위-증명 demand는 엔진 범위를 체인 전체에서 편집점 이후로 좁힌다.

---

## 1. 목표 / 비목표

### 목표

- 키스트로크당 작업량을 **범위**로 줄인다 (체인 길이, 마운트 윈도우).
- 실기(헤드리스가 아닌) 기준으로 프레임 예산에 접근한다.
  헤드리스(SwiftShader) 수치는 실기보다 5~10배 부풀려져 있다 —
  최종 판정은 실기 DevTools Performance 패널이다.

### 비목표

- 출력이 전부 달라지는 shift 편집의 재계산·재쓰기 자체를 없애기 (불가능, §3).
- Web Worker 이관 (동기 계약과 구조 충돌 — `VIRTUALIZATION.md` §3).
- 보이는 하류 프레임의 동기 갱신 생략 (WYSIWYG 위반).

---

## 2. 측정 기록 (재현 조건)

- 픽스처: `examples/virtualization.html` — 30페이지 단일 스레드 체인,
  story 약 43,700자, 페이지당 ~1,000자.
- 방법: head 프레임 포커스 → `execCommand('insertText')` 1타 →
  `PerformanceObserver(longtask)` 합산 + `layoutText` 래퍼 계측 +
  CDP CPU 프로파일.
- 결과:
  - 30/30 프레임 `layoutText` 호출, 합산 ~51ms (개별 1~6ms).
  - 마운트 3문단 `render-complete`, 롱태스크 합 ~460ms.
  - CDP: `(program)` 61% (네이티브 DOM/스타일/레이아웃/페인트),
    JS 함수들은 모두 한 자릿수 %.
  - 위치별: head 468ms / middle 776ms(노이즈) / tail 472ms —
    엔진 전체 재계산 수는 6→3→1로 다르지만 합계는 같다 (DOM이 지배).
  - A/B: span 전체 재생성 강제 vs diff 경로 = 484ms vs 458ms (유의차 없음).
    overflow 카운트 재생성 제거 시도는 이 실측으로 원복했다.

---

## 3. 불가능 결과 (증명 스케치)

### 3.1 출력-동일성 재사용은 shift 편집에 성립하지 않는다

+1 삽입은 모든 줄의 텍스트를 바꾼다 (각 줄이 앞 줄 끝 글자를 물려받음).
따라서 텍스트 동일성(text-identity) 기반 줄 캐시·span 재사용은
shift 편집에서 적중할 수 없다. 초안 설계의核心 전제였으므로 폐기한다.
(유니코드 주기성 같은 병적 예외 제외.)

### 3.2 체인 prefix 생략의 조건 (범위-증명으로 해소됨)

`contentFrom(K)` = `tail(K-1)`이며 tail은 배치를 돌려봐야 안다 — 원칙적으로
prefix 생략은 불가능해 보인다. 그러나 **커밋된 tail은 범위 증명으로 재사용
가능**하다: 편집 범위 `[Ps, Pe)` (writeback 시 prefix/suffix `memcmp`로 산출,
O(story))보다 완전히 앞에 끝나는 프레임(`committed tail ≤ Ps`)은 slice가
불변임이 보장되므로, 배치·렌더를 모두 생략해도 정확하다. 즉:

- clean ⟺ `committedTail(F) ≤ Ps` (+ `hasLayoutCache` + `isThreadFrame`,
  기존 `_threadInputUnchanged`의 (c)(d) 조건 재사용).
- clean 프레임은 `textContent` 재주입도 스킵한다 (구 참조 유지 →
  `_layoutCache`·R-T2 유효, `_dirty` 불변 → 기존 assert·read 계약 유지).
  단, 구 story 문자열 pinning 방지를 위해 연속 스킵 50회 상한
  (초과 시 새 참조만 주입하고 레이아웃은 스킵 — 차후 재계산).
- dirty 프레임부터 순차 배치한다. 시작 `contentFrom`은 마지막 clean 프레임의
  커밋 tail (정확함). clamp 교정(`correctedFrames`)이 clean 프레임을 건드리면
  해당 프레임을 dirty로 전환하고 계속한다 (희귀 경로, 기존 루프가 그대로 처리).
- exhausted 경로는 항상 실행한다 (조기 종료라 저렴하고, story 길이 변화에
  민감하므로).
- 소스 없는 패스(`_relayoutThreads` 초기 동기화 등)는 `Ps = 0` (오늘과 동일).

이로써 키스트로크당 엔진 범위는 O(체인) → O(편집점 이후 + 마운트 윈도우)로
줄고, parked dirty는 §5의 demand 캐스케이드가 처리한다.

### 3.3 DOM 재쓰기 생략은 픽셀이 달라서 안 된다

shift되면 각 위치의 글자가 바뀐다 — span `textContent` 재쓰기는 필수다
(이미 동일값 가드됨). dataset·위치 쓰기도 마찬가지다.
남는 것은 쓰기 단가(브라우저 영역)와 강제 리플로우 횟수뿐이다.

---

## 4. 유효 레버 (순위 순)

### 4.1 체인 분할 (코드 변경 없음 — 즉시)

키당 재계산 프레임 수 = 소속 체인 길이. 30개 단일 체인 → 기사·섹션 단위
체인으로 나누면 비례 감소한다. 가장 큰 즉시 효과.
실측 (`examples/virtualization.html`, head 타이핑, 헤드리스 longtask 합산):
30프레임 단일 체인 458~484ms → 6체인×5프레임 89~139ms (평균 약 117ms,
약 4배). 엔진 전체 재계산도 30프레임 분산 호출에서 소속 체인 수회로 축소.

### 4.2 마운트 윈도우 축소 (설정 — 즉시, 실측됨)

마운트 3→2페이지에 490ms→308ms (헤드리스). `PageMountManager({ window })`
또는 데모 상단 select. 스크롤 여백과 맞바꾼다 (0이면 급스크롤 시 빈틈 노출).

### 4.3 실기 측정 후 분할 확정 (절차)

헤드리스 수치는 네이티브 구간을 부풀린다. 실기 Performance 패널에서
엔진 feed-forward vs DOM(쓰기·리플로우·페인트) vs 커서 배치를 분리하고,
초과 구간부터 판다. 이 문서의 수치는 우선순위용이지 목표값이 아니다.

### 4.4 마이크로 최적화 (측정 후 개별 판단 — 선행 구현 금지)

- 비포커스 문단의 mapper 재구축 지연: `postRender`는 매 렌더마다 재구축한다.
  포커스·선택이 없으면 생략하고 클릭·포커스 진입 시 재구축하는 방식.
  예상 수 ms/키. stale mapper 클릭 오매핑 리스크가 있어 단독 스위트로 검증 필수.
- `_computeLayoutInputHash` story 전체 직렬화 (프레임·렌더당 2회):
  sub-ms로 보이나 참조 동등 fast path 가능성은 측정 후 판단.
- 위 2건은 각각 독립 A/B 실측에서 유의차를 보여야만 채택한다
  (근거 없는 최적화 금지 원칙).

### 4.5 break-derivation 연구 스파이크 (boxed — 착수 조건부)

shift를 텍스트가 아니라 **break 위치**로 전파하는 방식:
이전 break + δ로 새 break를 유도하고 줄 내용만 슬라이싱한다.
성공하면 엔진 상수를 2~3배 낮출 수 있으나, 오버랩/cover/justify/indent/
clamp/overset-cut 엣지에서 정확성 입증 부담이 크다.
**착수 조건**: 4.3 실기 측정에서 엔진 구간이 지배적일 때만.
**중단 조건**: 2주 내 byte-identical 게이트(`snapshot-layout` +
`verify-threading` 104) 미통과 시 폐기.

### 4.6 범위-증명 demand — **구현 완료 (2026-09-14)**

§3.2의 범위 증명을 키스트로크 경로에 적용한다. 효과: 키당 엔진
O(체인 전체) → O(편집점 이후 + 마운트 윈도우). DOM은 기존대로 마운트 분만
렌더한다 (분리 프레임 DOM 없음 — 가상화와 동일 원칭).

#### 구현 결과 (실측·게이트 포함)

- `ThreadEngine`: `ThreadLayoutOptions{editPsByThreadKey, pinnedFrameIds}`,
  `_committedByThread`(프레임별 커밋 체인 기록), `_staleSkippedByThread`,
  `threadKeyOf`, `hasStaleSkippedFrames`, `_isFrameClean(chain, engines, i,
  editPs, pinned)` — strict `committedTail(F) < Ps` && `hasLayoutCache` &&
  최후 프레임 항상 배치(tail 의존성 보존), pinned는 무조건 배치.
  `ThreadLayoutResult.laidOutFrameIds` 추가.
- `DocumentEngine._writebackThreadStory`: 평문 공간 `memcmp`로 Ps 맵 산출
  (`ParagraphEngine.plainTextOf` — 인라인 런 배열 대응, 정적 참조 캐시로
  체인당 1회 O(N)) → `_layoutThreads({editPsByThreadKey, pinnedFrameIds})`.
- `relayoutThreads(sources, pinned)` / `ensureThreadFramesFresh(ids): boolean`:
  stale 스킵 프레임 존재 시 Ps=0 전체 재배치 + dirty 커밋 후 true 반환.
- DOM: `document.element._flushThreadRelayout`이 focused 문단 id를 pinned로
  전달하고, 렌더 범위를 `laidOut ?? affectedFrames` ∩ mounted로 필터.
- 편집 진입점: `EditManager.focusParagraph`이 항상(재포커스 포함) 가드를
  발화하고, 신선화가 실제 일어났으면 focused 문단을 `flushRender`/
  `scheduleRender`한다 — postRender의 `modelText !== textarea.value` 동기화가
  runMap/textarea를 신 모델에 따라가게 한다.

#### 스킵 프레임 편집 소싱 버그 (실측 → 해소)

스킵된 프레임은 **구 story 참조 + 구 배치**를 함께 유지한다(자기모순 없음).
그러나 (a) 스킵 프레임이 이후 편집 소스가 되면 커밋이 구 내용 기반으로
이뤄져 다른 프레임 편집을 덮어쓰고, (b) 스킵된 상태의 렌더는 span diff
생략으로 textarea/runMap 동기화까지 건너뛴다. 실측: 6체인×5프레임 스트레스
타이핑 후 head IME 커밋(`ㅎ`→`한`)이 story 2343→2334 리버트(−9자).
`focusParagraph` 무조건 가드 + flush로 해소 (`verify-threading-browser`
"조합 커밋 후 story에 반영" FAIL → ALL PASS).

#### 쓰기 경로 (키스트로크)

1. `_writebackThreadStory(sources)`에서 편집 범위를 산출한다:
   구 story vs 소스 `textContent`의 prefix/suffix `memcmp` → `[Ps, Pe)`
   (O(story), 수백 µs). 다중 소스는 합집합. 텍스트 불변(스타일·지오메트리
   변경)이면 인덱스 모드 (소스 프레임부터 dirty). 시그니처 변경 없음.
2. `_layoutOneThread` 루프에 clean 판정을 삽입한다 (구현은 strict 부등호):
   `committedTail(F) < Ps` (`≤`가 아님 — tail == Ps인 경계 프레임은
   append-at-end로 slice가 확장될 수 있어 dirty로 처리한다) &&
   `hasLayoutCache` && `isThreadFrame`이면
   `textContent` 재주입·`updateThreadContext`·`layoutText`를 전부 스킵한다.
   커밋 체인(`storyLen`, `contentFrom[]` — 스레드별 Map에 보관)은
   배치된 프레임만 갱신하고 스킵 프레임은 기존값을 유지한다.
   스킵된 프레임의 `_dirty`는 그대로이므로 기존 dev assert·
   `DirtyPendingError` 계약이 유지된다.
3. clamp 교정이 clean 프레임을 건드리면 dirty 전환 후 계속한다 (기존 루프가
   그대로 처리 — 희귀 경로). exhausted 경로는 항상 실행한다 (조기 종료라 저렴).
4. 결과에 `laidOutFrameIds: string[]`를 추가한다 (이번 패스에 실제 배치한
   프레임. additive 필드 — 기존 테스트는 deep-equal 없이 필드 읽기만 하므로
   안전). `_flushThreadRelayout`은 렌더 대상을
   `affectedFrames` → `laidOut ∩ mounted ∪ corrected ∩ mounted`로 좁힌다
   (소스 제외 규칙 유지). dev assert는 `laidOut` 범위로 스코프한다.

#### 읽기 경로 (demand 캐스케이드) — **감사 결론: 별도 캐스케이드 불필요**

스킵 상태 자체가 유효한 과거 스냅샷이므로 읽기에 캐스케이드가 필요 없다
(아래 스냅샷 일관성 참조). 당초 스펙의 아래 2항은 **구현하지 않기로 확정**
한다 (재구현 금지 — 근거와 함께 기록):

- `unparkPage()` ensure: 복원된 프레임이 구 story 참조를 들고 있어도 그
  slice 배치는 증명상 유효하므로 화면·좌표가 정확하다. 편집 소스가 되는
  순간 `focusParagraph` 가드가 신선화한다. K 섹션 실측이 round-trip을 보증.
- `ensureCommitted()` 스레드 캐스케이드: `ensureCommitted`/`_ensureSubtreeCommitted`
  는 문단 엔진을 건드리지 않는다 (편집 파이프라인 소유 — 커밋→이벤트 순서
  계약). 스킵 프레임은 `_dirty`가 아니므로 읽기 계약을 위반하지 않는다.

- story vs 배치 불일치 시나리오는 존재하지 않는다:
  스킵 프레임은 구 story 참조 + 구 배치를 함께 유지하므로 (둘 다 유효한
  과거 스냅샷) 자기모순이 없다. 새 story로의 전이는 캐스케이드가 원자 수행한다.

#### 메모리 상한 — **상한·백필 모두 불필요로 확정 (재구현 금지)**

스킵 프레임은 구 story 문자열을 pin하지만 프레임당 최대 1개 참조만 보유하고
(다음 스킵·재주입 시 교체), 참조가 끊긴 구 story는 GC가 회수하므로 누수가
없다. 당초 스펙의 "연속 스킵 50회 상한"과 "idle 백필"은 구현하지 않는다 —
stale 상태가 유효한 스냅샷이라 백필할 것이 없고, 상한은 불필요한 복잡도다.

#### 스냅샷 일관성 (검증된 사실 + 감사 잔여 주의점)

분리 프레임의 `extractData.content`는 비-head에서 `undefined`이며, 그
스냅샷이 `_buildTree`로 재주입돼도 `_buildParagraphEngine`의
`?? pe.textContent` 가드가 story를 보존한다 (스레드+park 섹션 K 실측).
head의 구 story + `threads[].content` 신 story가 공존해도 복원 시
스레드가 이긴다 (단일 소스 원칙 — 기존 동작).

**잔여 주의점 (코드 감사 확인, 자가 치유됨)**: head가 스킵된 상태(예: tail
타이핑 중 head 스킵)에서 `document.data`를 읽으면 `head.content`는 구 story
텍스트인 반면 `threads[].content`는 신 story다 — 스냅샷 내부의 한시적
불일치다. 복원 시 `thread.content`가 권위를 가지므로(`storyContent =
thread.content ?? head.textContent`) story 소실 없이 자가 치유된다. 호스트는
`head.content`를 story 진실로 취급하면 안 된다 — story 권위는 항상
`threads[].content`다.

---

## 5. 폐기된 대안 (재발 방지 기록)

| 대안 | 폐기 이유 (실측/증명) |
|---|---|
| 텍스트 동일성 라인 캐시 (초안 §3) | §3.1 — shift 편집에서 적중 불가 |
| 요구 기반 스레드 연기 (구버전) | tail 의존성만으로는 범위 축소 불가 — §3.2 범위 증명으로 해소되어 §4.6 스펙으로 승격 |
| overflow 카운트 재생성 제거 | A/B 484 vs 458ms — 병목이 아님. 원복됨 |
| span 전체 재생성 vs diff 논쟁 | 같은 A/B — 둘 다 아님 |
| Web Worker 레이아웃 이관 | 동기 계약·증분 캐시와 구조 충돌 (수차례 실패 이력) |
| 보이는 하류 비동기 전파 | WYSIWYG 위반 |

---

## 6. 검증 게이트 (현행 유지)

- 엔진 변경 시: `snapshot-layout.mjs` byte 동일 + `verify-threading.mjs` (104)
  + 관련 엔진 스위트 (inline/line-gap/hanging/word-wrap/decoration).
- DOM·편집 변경 시: `verify-dom-diff` / `verify-visual-render` /
  `verify-threading-browser.mjs` (35) / `verify-image-edit-mode` /
  `verify-caret-parking.mjs` (커서 변경 시 선행) / `verify-virtualization.mjs` (47).
- 성능 주장 시: 동일 페이지 A/B + `benchmark-browser.mjs` 기록.
  헤드리스 수치 단독으로 최적화 채택 금지 (§4.3).
- §4.6 구현 시 추가 게이트: `verify-threading.mjs` 전체(특히 스킵 판정·
  clamp 교정·pull-back 항목) + `verify-threading-browser.mjs` +
  `verify-virtualization.mjs` K 섹션 (스토리 보존·체인 전파·복원 정합) +
  unpark 캐스케이드 시간 측정 (J remount 지표에 스레드 체인 케이스 추가).

- §4.6 구현 완료 검증 기록 (2026-09-14): `verify-threading` 104 ALL PASS,
  `verify-threading-browser` ALL PASS (35항목 — 스킵 프레임 편집 소싱 버그
  해소 포함), `verify-virtualization` 47 ALL PASS (K4 범위-증명 prefix skip
  layouts=0 포함), `verify-dom-diff` / `verify-multicolumn` /
  `verify-caret-parking` (28) / `verify-ime` / `verify-pending-style` (31) /
  `verify-image-edit-mode` (64) / `verify-visual-render` (7) ALL PASS,
  `snapshot-layout` 3회 연속 byte-identical (결정론 확인), `tsc` 0 에러,
  `vite build` 통과. 실측: 6체인×5프레임 head 타이핑 키당 avg 56.4~59.3ms /
  p50 54.8~58.5ms / p90 63.2ms (헤드리스, rAF 2프레임 대기 포함 — §4.3 참조,
  실기 기준값 아님. 체인 분할만 적용한 117ms 대비 약 2배 개선).
