# INCREMENTAL_REFLOW.md — 라인 단위 증분 리플로우 상세 설계

> **문서 성격**: 상세 설계 (미구현). 스레드 체인 타이핑 비용의 근본 해결책.
> 구현 전 최신 코드와 대조할 것. 모든 줄 번호·시그니처는 작성 시점(main) 기준.
>
> **관련 문서**: `docs/VIRTUALIZATION.md` (§7 후속 단계), `docs/PERFORMANCE.md`
> (§3.6/§3.12/§3.14 캐시 전제), `docs/TEXT_ENGINE.md` (래핑 파이프라인),
> `docs/EDITING_TEXT.md` (§6A 런 모델), `RULES.md § 3` (엔진-우선 원칙)

---

## 0. 요약 (TL;DR)

키스트로크당 비용 = **엔진 O(체인 전체 글자) + DOM O(이동한 span)**.
30프레임 체인 head 타이핑 실측: 엔진 30프레임 재계산(~50ms headless) +
마운트 3개 문단 span 재쓰기·강제 리플로우·페인트(~400ms headless).
가상화·diff·캐시는 "같은 일을 효율적으로"일 뿐 작업량 자체를 줄이지 못한다.

근본 방향: **줄 단위 증분** — 1글자 삽입이 바꾸는 것은 줄바꿈 경계 몇 개뿐이고
나머지 99% 줄은 글자序列 그대로다. 줄 동일성을 판정해 같은 줄은 손대지 않는다:

- **Phase 1 (엔진)**: 라인 캐시 + suffix-match resync → 체인 전파 O(전체 글자) → O(변화된 줄).
- **Phase 2 (DOM)**: 줄 div 키 매칭 이동 → 이동 span 전수 재쓰기 → 줄당 1회 이동 + dataset 갱신.
- **Phase 3 (조건부)**: 요구 기반 스레드 연기 — Phase 1+2 측정 후에도 체인 패스가
  예산 초과일 때만. 아마 불필요하다 (§5 근거).

---

## 1. 목표 / 비목표

### 목표

- 스레드 체인 타이핑 키스트로크당 메인스레드 점유를 프레임 예산(16.7ms) 안으로.
  판정: `benchmark-browser.mjs` 타이핑 시나리오 + 스레드 30체인 롱태스크 합산.
- 화면·인쇄·추출 결과 byte-identical (`snapshot-layout`, `verify-*` 전종).

### 비목표

- Web Worker 이관 (동기 계약과 구조 충돌 — `VIRTUALIZATION.md` §3).
- 줄바꿈 알고리즘 자체의 변경 (금칙·걸침·워드랩 시맨틱 불변).
- `content-visibility` 등 브라우저 휴리스틱 의존 (결정적 동작 유지).

---

## 2. 핵심 발견 (설계의 근거)

### 2.1 줄은 위치-독립 데이터다

`TextLineData`/`TextPartData` (`src/types/layout/text/text-line.type.ts`)는
**절대 source offset을 어디에도 저장하지 않는다**: parts의 content/inlineStyles/
charOffsets(파트 상대)/hangs/decorationRects(상대 rect)/left/width,
line의 flags/maxFontSize/lineHeight. 모든 소비처(`getCharRect`, `renderText`,
mapper, printPostData)는 누적走査로 오프셋을 복원한다.

帰結: 줄 객체는 story shift에 불변 — **참조 그대로 이어붙이면 재사용**된다.
조정할 오프셋이 없다. 캐시는 줄 객체 참조를 공유하고 (추가 메모리 없음),
재사용 줄에 대한 후처리 변이는 copy-on-write로 막는다 (§3.5).

### 2.2 dataset 쓰기는 스타일 무효화를 일으키지 않는다 (실측)

`data-source-offset`/`data-offset`/`data-char-offset`/`data-inline-key` 등
속성 선택자는 소스 전체에서 **JS `querySelector(All)`에만** 등장하고 CSS에는
없다 (grep 실측: mapper 2곳, controller 2곳, column 2곳).
따라서 이동 span의 dataset 갱신은 DOM 변이일 뿐 recalc·layout을 유발하지 않는다.
Phase 2가 span 텍스트·스타일 쓰기를 생략하고 dataset만 갱신하는 근거다.

### 2.3 후처리는 이미 영역 제한을 받는다

- `_applyLineBreakRules(skipPairs?)` — 스킵 집합을 받는다. 이음매 쌍만
  처리하는 데 그대로 쓴다.
- `_applyHangingPunctuation()` — 스킵을 안 받는다 (반환만 한다).
  Phase 1에서 동일 패턴의 스킵 파라미터를 추가한다 (소규모, §3.5).
- `_computeCharOffsets`/`_computePerLineHeights`/`_computeDecorations` —
  `columnContents` 위의 순수 함수. 재사용 줄은 스킵하고, 정렬 전용 변경 시
  `_computeCharOffsets`만 단독 호출한다 (§3.6).

---

## 3. Phase 1 — 엔진 라인 캐시

### 3.1 캐시 레코드

```ts
// ParagraphEngine 인스턴스 필드 (개념; 정확한 주거는 구현자가 정한다)
_lineCache: {
  paramsKey: string;          // §3.2 — 지오메트리·스타일·금칙 입력
  sourceText: string | (string | TextInlineData)[];  // 커밋 시점 원문 (참조+내용)
  lines: CachedLine[];        // 커밋된 columnContents 평탄화 (참조 공유)
} | null;

CachedLine = {
  key: string;                // §3.3 라인 식별자
  line: TextLineData;         // 최종(후처리 완료) 객체 참조
  colIdx: number;             // 배치 당시 컬럼 인덱스
  startX: number;             // 라인 시작 x (파트 left 누적 전)
};
```

### 3.2 paramsKey (캐시 전체 게이트)

`_computeLayoutInputHash`와 **동일 입력 집합**을 single source로 공유한다
(중복 정의 금지 — 기존 헬퍼를 재사용하거나 분리하되 양쪽이 같은 함수를 본다):

- 컬럼 폭/간격, 줄높이 입력(`fontSize`/`lineGap`/`lineGapMode`), 컬럼 높이
- 배치 영향 인라인 필드 (`fontFamily`/`fontSize`/`fontStyle`/`letterSpacing`/
  `widthRatio`/`spaceRatio` — 해시와 동일 목록)
- 금칙·걸침·워드랩 파라미터, 오버랩 상대 좌표 (`_overlayHashKey` 재사용)
- `contentFrom`은 키에 넣지 않는다 — 슬라이스 시작 이동은 resync 탐색이
  처리한다 (§3.4). 단, `contentFrom` 자체는 라인 탐색의 하한으로 쓴다.

paramsKey 불일치 → 기존 전체 배치 경로 (오늘의 동작과 byte-identical).

**`textAlign`은 라인 키에서 제외한다.** 정렬은 줄바꿈이 아니라 `charOffsets`
에만 영향을 준다. 정렬 전용 변경 감지
(paramsKey 동일 + align만 다름) 시에는 `_computeCharOffsets()`만 재실행한다
(기존 `preserveRenderShapeAcrossReset` DOM 경로와 짝을 이룬다).

### 3.3 lineKey (줄 식별자)

최종(후처리 완료) 줄에 대해 커밋 시 1회 계산한다:

```
lineKey = join(\u0000, [
  JSON.stringify(part.content 배열),   // 조인 모호성(['ab','c'] vs ['a','bc']) 방지
  part left[] / width[],
  글자별 배치 영향 스타일 키 (해시와 동일 필드 목록),
  columnWidth, lineGapParams, breakParams, overlayKey,
])
```

- 정렬·장식선 색상 등 배치 무영향 필드는 제외한다 (재사용 범위 최대화).
- 동일 텍스트 반복 줄(`가\n가\n…`)의 키 충돌은 정당하다 — DOM 매칭은
  키별 FIFO 큐로 소비한다. 뒤바뀌어도 내용·스타일이 동일하고 source offset은
  dataset으로 갱신되므로 시각·정합 무영향 (§4.3).

### 3.4 resync 알고리즘 (핵심)

입력: 새 plain 텍스트 `N`, 캐시 `(paramsKey, sourceText O, lines[])`.
`paramsKey` 일치 전제 (불일치면 전체 배치).

1. **공통 prefix**: `memcmp(N, O)`로 첫 차이 오프셋 `D`를 구한다 (O(n), 수 µs).
   `D`를 포함하는 줄 이전까지의 줄은 그대로 재사용한다 (O(1) 이어붙이기).
2. **재배치 + 재동기화**: `D`를 포함한 줄부터 기존 charLoop로 배치한다.
   줄을 하나 완성할 때마다 resync를 시도한다:
   - 후보: 캐시의 `colIdx`·`startX`가 현재 루프 상태와 같은 줄
     (해시셋 조회, 통상 수 개).
   - 확정: `newPlain[newPos:] == oldPlain[oldPos:]` suffix `memcmp` 1회.
     `memcmp`는 불일치 시 첫 글자에서 탈락하므로 실패 비용 O(1) 수준.
     단일 연속 편집(타이핑·붙여넣기·삭제·실행취소 모두 해당)에서는
     suffix가 동일하므로 첫 후보에서 확정된다.
   - 확정 시 캐시 잔여 줄을 **참조 그대로** 이어붙이고 종료한다.
3. **이음매 처리** (§3.5): 마지막 재배치 줄 + 첫 재사용 줄 쌍에 대해서만
   금칙·걸침 규칙을 적용한다 (copy-on-write — 아래).
4. 커밋: 새 `columnContents`를 평탄화해 캐시로 저장 (참조 공유).
   `_buildPrefixCache`는 기존대로 호출한다 (caret 기반 prefix 캐시와 공존 —
   caret 연속 타이핑은 prefix 경로가, 그 외 편집은 라인 경로가 담당.
   둘 다 히트 가능하면 prefix 우선).

복잡도: `O(바뀐 줄 × 줄 길이 + memcmp 전체 1~2회)`.
30프레임 체인 head 타이핑 실측 Puzzle의 답: 프레임당 suffix 1회 `memcmp`
(약 40k자 ≈ 0.1ms) + 이어붙이기 → 체인 전체 수 ms로 수렴한다.

### 3.5 변이 규율 ( correctness의 핵심)

- **캐시 줄은 절대 직접 변이하지 않는다.** 후처리 패스는 재배치된
  **새 줄 객체**에만 적용한다. 이음매 쌍 처리 시 재사용 줄이 필요하면
  해당 줄 1개만 복제한다 (copy-on-write, O(줄)).
- `_applyLineBreakRules`의 기존 `skipPairs`에 이음매 쌍만 남기고 전부
  스킵으로 전달한다.
- `_applyHangingPunctuation`에 동일 패턴의 선택적 skip 파라미터를 추가한다.
  (현재 시그니처 `(): ReadonlySet<string>` — `paragraph-engine.ts:814`.)
- `_computeCharOffsets`/`_computePerLineHeights`/`_computeDecorations`는
  재사용 줄에 대해 스킵한다 (저장된 최종값 사용). 단, 정렬 전용 변경 시에는
  `_computeCharOffsets`만 전체에 재실행한다 (§3.2).
- `verticalAlign: center/bottom` 다중 패스(`_layoutTextIntoColumns` 3-iteration
  루프): 배치는 캐시로 1회 수행하고, 반복문은 align 오프셋 계산에만 쓴다
  (구현자 과제 — 카운트 기반 오프셋은 재배치 없이 산출 가능. 기존
  verticalAlign 커버리지로 회귀 확인).

### 3.6 무효화표

| 변경 | 경로 | 근거 |
|---|---|---|
| 텍스트 편집 (타이핑·paste·삭제·IME·undo) | resync (§3.4) | 단일 연속 편집은 suffix 동일 |
| 장평·자간·폰트·컬럼폭·금칙·걸침·오버랩 상대좌표 | 전체 배치 | paramsKey 불일치 (오늘과 동일) |
| 굵기·색상 (배치 무영향) | 기존 `_refreshInlineStylesOnly` 경로 | 해시 제외 필드 — 그대로 |
| 정렬 전용 | `_computeCharOffsets`만 | 키 제외 (§3.2) |
| `contentFrom` (스레드) | resync 탐색이 흡수 | 슬라이스 시작 이동 = 탐색 하한 이동 |
| `data` setter 구조 변경 | `resetIncrementalState()`가 캐시도 함께 비운다 | 오늘과 동일. 단, 캐시 비움은 `_layoutCache`와 함께 `_lineCache`도 포함하도록 확장 |

### 3.7 안전장치

- `ParagraphEngine.lineCacheEnabled` 정적 토글 (기본 true) — 프로덕션
  이스케이프 해치. 검증 스위트는 ON/OFF 양쪽이 아니라 ON 기준으로만 돌리고,
  OFF는 긴급 차단용이다.
- DEV 전용 불변 어서션 (릴리스에서 제거): 후처리 패스가 캐시 참조 줄을
  변이하려 하면 throw. COW 위반을 구현 단계에서 검출한다.

---

## 4. Phase 2 — DOM 줄 단위 reconciliation

### 4.1 줄 div 키 매칭

- 엔진이 `TextLineData.lineKey?: string`을 채운다 (커밋 시, §3.3 키).
  소비처는 DOM뿐이다 (`printPostData`는 parts를 읽으므로 무영향.
  `snapshot-layout` 직렬화에 필드가 추가되지만 전후 일관되어 판정에 무영향 —
  스냅샷 비교는 동일 버전끼리 수행한다).
- `renderText()`의 라인 루프를 인덱스 재사용 → 키 매칭으로 전환한다:
  기존 div를 `dataset.lineKey` Map에 모으고, 엔진 줄 순서대로
  히트한 div를 `insertBefore` 체인으로 이동, 미스는 생성(`_createLineElement`
  기존 경로), 잉여는 제거한다.
- 히트한 줄의 파트 구조는 키 동등성으로 보장되므로 파트 div는 기존처럼
  인덱스 재사용한다 (코드 변경 없음).

### 4.2 span 작업 축소

히트한 줄의 span에 대해서는 텍스트·스타일 쓰기를 생략하고
**`data-source-offset`/`data-offset` dataset 갱신만** 수행한다:

- 텍스트 동일성은 키가 보장한다 (그래도 기존 `textContent !== char` 가드는
  유지한다 — 값싼 벨트-앤드-브레이스).
- 스타일 동일성은 키가 보장한다 (배치 영향 필드 전부 포함).
  단, 인라인 전용 변경(굵기 토글 등)은 레이아웃 키가 같아 **줄 히트가 발생
  하므로**, span별 기존 모드 판별(`inline-only` 등)은 그대로 수행한다 —
  즉 줄 히트는 오프셋·위치 쓰기를 생략하는 조건이지 스타일 판별을 생략하는
  조건이 아니다.
- 위치(`left`/`top`) 쓰기는 줄 div 이동 1회로 대체된다. span `left`는
  파트 상대(불변)이므로 손대지 않는다.
- dataset 쓰기는 §2.2 실측대로 recalc·layout을 유발하지 않는다.

### 4.3 오버플로우 flip 처리

기존 라인 분기(`isOverflow` → 자식 제거 + 오프셋 스킵 / visible → span diff)를
그대로 둔다. 줄 이동과 무관하게 줄별 현재 상태로 동작하므로 flip이
자동 처리된다. `_perfShouldFullRecreate`는 변경하지 않는다
(overflow 카운트 제거 시도는 A/B 실측 무의미로 원복됨 — §7.1이 아니라
본 문서 §6의 회귀 스위트가 flip 커버리지를 담보한다).

### 4.4 매퍼·커서 계약

- `_sourceToPlacement`/`_lineRanges`는 엔진 데이터 기반이라 DOM 이동과
  무관 — 기존 `postRender` 재구축 그대로.
- `_spanCache`/`_columnSpansCache`는 source offset 키라 줄 이동 후 stale하다.
  증분 경로의 `invalidateSpanCache()` 뒤에 **컬럼당 1회 bulk 재스캔**으로
  재구축한다 (전체 재생성 경로와 동일 비용 — 측정 후, 필요하면 증분 수술로
  후속 최적화).
- 커서/선택 배치 rect 읽기는 그대로 둔다 (필수 강제 리플로우 1회).
  `POST_RENDER_DEFER_THRESHOLD` rAF 지연 정책도 그대로 둔다.
- 낙관적 span(IME 임시)은 기존처럼 `renderText` 시작 시점에 제거한다
  (줄 이동 전에 수행되어야 한다 — 순서 유지).
- 장식선 rect div (`_renderDecorationRects`): 파트별 재생성 여부와 비용을
  구현 시 측정하고, 줄 히트 시 스킵 가능하면 스킵한다 (장식 데이터는 줄에
  저장되어 있으므로 동일성 보장 가능 — 구현자 판단, 측정 필수).

---

## 5. Phase 3 — 요구 기반 스레드 연기 (조건부)

**게이트**: Phase 1+2 완료 후에도 체인 패스(`relayoutThreads` 전체)가
지속적으로 8ms를 초과할 때만 진행한다. 아래 수학상 아마 불필요하다:

> Phase 1이 있으면 전체 체인 패스는 프레임당 suffix `memcmp` 1회 +
> 이어붙이기로 수렴한다. 30프레임 × 평균 잔여 수만 자 `memcmp` ≈ 수백 µs.
> 즉 풀 패스 자체가 싸지므로 연기 machinery의 복잡도를 감당할 이유가 없다.
> 이 장은 그 경우의 설계 스케치로만 남긴다.

스케치 (게이트 통과 시 상세화):

- 상태: 스레드별 `committedStoryRef` + 프레임별 `committedContentFrom[]`.
  키스트로크마다 writeback 후 story 참조 비교로 dirty 플래그만 세운다
  (O(프레임), 레이아웃 없음).
- 요구 시(`render`·`extractData`·`printPostData`·언마운트 해제 전):
  뒤로 clean anchor까지 거슬러 올라가 앞으로 배치한다. anchor는 보통 head
  (`contentFrom = 0` 확정)이다.
- 모든 읽기 경로는 기존 `ensureCommitted` 계열로 수렴시킨다
  (`DirtyPendingError` 계약 확장).
- `correctedFrames`(clamp가 prev 프레임을 바꾸는 경우): cascade 결과에 포함해
  마운트된 해당 프레임을 재렌더한다 (기존 `_relayoutThreads` 하류 로직 재사용).
- idle 백필 (`requestIdleCallback`): 분리 프레임의 dirty를 미리 해소해
  스크롤 진입을 웜 상태로 둔다.

---

## 6. 검증 게이트 (페이즈별, 전부 ALL PASS 필수)

### Phase 1 (엔진 출력 불변 + 속도)

| 스크립트 | 판정 |
|---|---|
| `snapshot-layout.mjs` 전후 byte 동일 | **라인 캐시가 엔진 출력을 바꾸지 않음** — 최강 게이트 |
| `verify-threading.mjs` (104) | prefix 캐시·지오메트리 행렬·금칙 교정 — 후처리 스킵 정확성 |
| `verify-multicolumn.mjs` | prefix 경로 동등성 |
| `verify-inline-metrics` / `verify-line-gap-mode` / `verify-hanging-punctuation` / `verify-word-wrap` / `verify-text-decoration.mjs` | 배치 영향 필드·후처리 스킵 정확성 |
| `verify-hangul-glyph-fallback` / `verify-overlap-inline-fontsize` / `verify-image-displayrect-cache` / `verify-overlap-none` / `verify-print-image-overlap` / `verify-right-indent-tab.mjs` | 폭·오버랩·print 패리티 |
| `benchmark-typing.mjs` + `benchmark-browser.mjs` 타이핑 | 키당 시간 감소 기록 (목표: 스레드 30체인 롱태스크 합산 절반 이하) |

### Phase 2 (DOM 정합 + 속도)

| 스크립트 | 판정 |
|---|---|
| `verify-dom-diff.mjs` | span 무결성 (단조성·무중복·DOM≡엔진) — 줄 이동 후 dataset 정합의 직접 증명 |
| `verify-visual-render.mjs` | rect 기반 화면 진실 |
| `verify-threading-browser.mjs` (33) | tail·seam·타이핑 스트레스·IME×flush — 스레드+DOM 결합 |
| `verify-image-edit-mode.mjs` | 오버랩 파트 분할 구조 |
| `verify-caret-parking.mjs` (28) | 이동된 줄에서의 커서 매핑 (선행 실행 규칙) |
| `verify-pending-style.mjs` / `verify-style-revert.mjs` / `verify-ime.mjs` / `verify-overflow-cursor-clamp.mjs` | 편집 경로 회귀 |
| `verify-virtualization.mjs` (40) | H(parts+match) — 이동된 줄의 파트 정합 |
| `benchmark-browser.mjs` 전 시나리오 | p95 회귀 없음 + 타이핑 개선 기록 |

---

## 7. 리스크와 완화

| 리스크 | 완화 |
|---|---|
| COW 위반 (캐시 줄 변이) | DEV 전용 불변 어서션 (§3.7) + `snapshot-layout` byte gate |
| 키 충돌 오매칭 | 키에 폭·스타일·금칙 입력 포함 + `\u0000` 구분자. DOM은 FIFO 큐 소비 — 뒤바뀌어도 내용 동일 |
| IME 조합 중 resync | 조합 커밋도 일반 편집으로 취급 (suffix-match가 흡수). 낙관적 span은 DOM 전용이라 무관 |
| undo/redo 풀 라운드트립 | 동일 참조면 skeleton 히트, 아니면 resync. `data` setter 경로 변경 없음 |
| 테이블 셀 문단 | 동일 `ParagraphEngine` — 특별 취급 불필요 |
| `center`/`bottom` 다중 패스 | 배치 1회 + 오프셋 계산 반복으로 리팩터 (§3.5). 기존 verticalAlign 커버리지로 회귀 확인 |
| print/export 패리티 | 최종 줄 객체를 읽으므로 무영향. `verify-print-image-overlap` + 스레드 print 항목으로 검증 |
| 스냅샷 byte 증가 (`lineKey` 필드) | 비교는 동일 버전끼리 — 판정 무영향. 문서에 기록 |
| `_spanCache` 재스캔 비용 회귀 | Phase 2 측정 항목. 초과 시 증분 수술을 후속 과제로 (선행 구현 금지) |
| suffix 탐색 최악 O(n²) | `memcmp` 조기 탈락 + 후보 해시셋. 병적 입력(동일 짧은 줄 수천 개)은 FIFO+dataset 갱신으로 정합 유지, 속도는 측정 후 판단 |

---

## 8. 롤아웃 순서

1. **Phase 1** 엔진 라인 캐시 → §6 Phase 1 게이트 전부 + `snapshot-layout` byte 동일.
2. **Phase 2** DOM 줄 reconciliation → §6 Phase 2 게이트 전부 + 벤치마크 기록.
3. **측정 후 Phase 3 판단** (§5 게이트: 체인 패스 8ms 초과 지속 시에만).
4. 각 페이즈 완료 시 본 문서의 상태를 갱신한다 (구현됨/측정치).
