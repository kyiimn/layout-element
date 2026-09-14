# VIRTUALIZATION.md — 수백 페이지 문서 가상화 및 대규모 문서 스케일 대응 (인계 문서)

> **문서 성격**: 분석·설계 + 구현 기록. **P1~P4 보강은 구현 완료**
> (사용자 지시로 하위 에이전트 위임 없이 직접 구현 — `paragraph.element.ts`,
> `edit-manager.ts`/`box.element.ts`, `page.element.ts`,
> `src/utils/page-mount-manager.ts`, `src/constants/defaults.ts`).
> 이 문서는 세션 전체에서 실측·검증된 사실만을 담는다. 모든 줄 번호·시그니처는 작성 시점
> (main 브랜치) 기준이며, 구현 전 최신 코드와 대조할 것.
>
> **관련 문서**: `docs/PERFORMANCE.md` (기존 최적화 총람), `docs/TEXT_ENGINE.md`,
> `docs/EDITING_TEXT.md`, `docs/ENGINE.md`, `RULES.md § 3` (엔진-우선 원칙)

---

## 0. 요약 (TL;DR)

단일 페이지 전제(페이지 개념 없는 단일 캔버스 모델) 위에 문단 단위 캐싱·diff 최적화는
견고하다. 반면 **문서 스케일 축** — DOM 노드 총량, 전역 O(N) 경로, 메모리 상주 픽셀 —
에는 대응이 없고, `PERFORMANCE.md § 10`의 가상화는 "미구현 후보"로 명시되어 있다.

해법 축 3개:

1. **① DOM 가상화** — 즉시 효과, 엔진 무변경. 콜백 감사 결과 구현 가능하나
   **G1~G3 보강 선행** (§4, §5) → **보강 구현 완료 (P1~P4, §4.4 참조)**.
2. **② 페이지 모델** — 나머지 문제 전부의 데이터적 기반. G1의 근본 해소.
3. **③′ 시분할 프로그레시브 레이아웃** — Web Worker의 **대체** 수단.
   Worker 이관은 수차례 시도 끝에 실패했으며(역사적 사실), 이 코드베이스 구조상
   실패가 필연이었던 이유가 분석됨 (§3).

실행 순서: **① (P1~P4 보강) → ② → ③′ → ④~⑥**.

---

## 1. 수백 페이지 문서 처리 시 문제점 (진단)

### 1.1 전제

`PageData`는 **페이지 개념이 없는 단일 캔버스 모델**이다 — `src/types/layout`에
`page` 심볼 0건 (grep 실측). `width`/`height` 한 세트. 수백 페이지 문서는
"최상위 박스 수백 개"라는 **관례**로만 표현되고, 이 전부가 하나의
`<x-layout-page>` shadow DOM 안에 산다.

### 1.2 구조적 문제

| #   | 문제                                                                                                                                                                                                                                     | 근거                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1.1 | **페이지 추상화 부재** — 페이지 경계, 페이지 간 흐름, "현재 페이지"가 데이터 모델에 없음. 페이지 단위 편집 UI(이동/썸네일/잠금)를 만들 근거가 엔진에 없음                                                                                      | `PageData` = width/height 1개             |
| 1.2 | **전역 O(N) 경로 다수** — `PageEngine._buildTree()`가 `layout()`마다 전 트리를 순회하며 자식마다 `findBoxEngineById`(재귀 선형 검색) → 최상위 박스 N개에 O(N²) 성분                                                                          | `page-engine.ts:938-978`                  |
| 1.3 | **`_refreshParagraphOverlays` 무조건 전체 갱신** — overlay 수와 무관하게 모든 문단을 순회. 한 페이지만 바뀌어도 수백 페이지 문단 전체에 `updateOverlayContext` + 해시 재계산 호출                                                              | `page-engine.ts:976`, AGENTS.md 명시        |
| 1.4 | **풀 스냅샷 라운드트립** — undo/redo·외부 데이터 주입이 `data` setter 전체 reconcile 경로. 문서 1회 교체 = 전 페이지 reconciliation + 전 엔진 `layout()`                                                                                         | AGENTS.md "data setter는 풀 복원용"         |
| 1.5 | **스레딩 체인 순차 배치** — `ThreadEngine.layoutThreads()`가 프레임(=페이지)을 순차 feed-forward. 1페이지 타이핑 → 체인 후속 페이지 전부 재배치. `relayoutThreads(sourceFrameIds)`로 편집점 이후만 제한하는 부분 완화 존재                       | `page-engine.ts:987-1024`                 |
| 1.6 | **EditManager 전역 단일** — 포커스/커서/모드가 문서당 1세트. 페이지 단위 활성화 개념 없음                                                                                                                                                        | AGENTS.md Managers                          |

### 1.3 성능 문제

| #   | 문제                                                                                                                                                                                                 | 규모 환산                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 2.1 | **메인 스레드 글자 단위 래핑** — `_layoutTextIntoColumns()`가 문자당 폭 측정+배치. 풀 리플로우 시 전체 문자 수에 비례해 메인 스레드 점유                                                                               | A4 300p × 7,500자 ≈ **225만 자** → 수십 초 블로킹            |
| 2.2 | **증분 캐시가 문단 단위에서 끝남** — Skeleton(`_layoutCache`)/prefix 캐시는 문단 내부 최적화. 페이지/문서 스케일 증분 없음. 1.3과 결합해 국소 변경이 전역 순회를 유발                                                          | PERFORMANCE.md §3.12                                      |
| 2.3 | **캐시가 엔진 인스턴스별** — `_charWidthCache`(LRU 5,000)가 `ParagraphEngine`당 존재. 문단 수백 개면 동일 폰트 메트릭을 문단마다 중복 계산+보관 (전역 공유 아님)                                                                   | `paragraph-engine.ts:69`                                    |
| 2.4 | **rgbaData 문서 수명 유지** — 오버랩 판정용 RGBA 픽셀 배열을 엔진이 계속 보유. A4 300dpi 1장 ≈ 33MB → 이미지 300장이면 ~10GB급 잠재 메모리. `opaqueRowBitmap`만으로 판정 가능한데 원본이 같이 살아 있음                              | AGENTS.md rgbaData 계약                                   |
| 2.5 | **렌더 순차 await** — `LayoutPageElement.render()`가 이미지 로드를 순차 await → 한 장 지연이 전체 렌더 지연                                                                                                            | `page.element.ts:661-663`, PERFORMANCE.md §10 후보       |
| 2.6 | **printPostData 전체 직렬화** — 스냅샷이 문서 전체 char 좌표 조립. 내보내기 시 메모리 스파이크 + `ensureCommitted`까지 전체 커밋 요구                                                                                             | AGENTS.md 엔진 전용 API                                   |

### 1.4 렌더링 문제

| #   | 문제                                                                                                                                                                                                                              | 규모 환산                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 3.1 | **글자당 span DOM — 최대 병목**                                                                                                                                                                                                       | 225만 글자 = 225만 span. 브라우저 실용 한계 수백 배 초과 |
| 3.2 | **가상화 부재** — 뷰포트 밖 페이지까지 전부 DOM 생성                                                                                                                                                                                    | PERFORMANCE.md §10 "미구현 후보"                |
| 3.3 | **Shadow DOM 수천 개** — 컬럼마다 shadow root + 개별 `<style>` sheet. CSSOM invalidation 방어 코드(connectedCallback `_cachedColStyleKey` 클리어, renderText `cssRules.length===0` 체크)가 이미 존재한다는 것 자체가 규모 문제의 방증          | `column.element.ts`                             |
| 3.4 | **좌표 쿼리 강제 리플로우** — `getCharRect`/`getTextRange` 등이 span마다 `getBoundingClientRect()`. 대형 선택·스크롤 시 레이아웃 스래싱                                                                                                    | PERFORMANCE.md §9 명시                          |
| 3.5 | **문서 단위 렌더 위상** — `render()` z-index 정렬 + 재귀 + 문단마다 `render-complete` 이벤트                                                                                                                                             | box/paragraph render 재귀                       |

---

## 2. 해결 로드맵 (우선순위)

### ① DOM 가상화 — 가장 큰 수확, 엔진 무변경

- 엔진 트리는 **전체 문서 유지**(엔진은 DOM-free — 이 설계의 수혜자가 가상화), **DOM만 뷰포트 근처 페이지 ±1~2개** 마운트.
- IntersectionObserver → 페이지 박스 `connectedCallback`/`disconnectedCallback` 경로로 attach/detach.
- 효과: 225만 span → 화면 페이지 분만(≈1.5만). **노드 수 3~4자릿수 절감**, 2.4/3.3/3.5 동시 완화.

### ② 페이지 모델

- `PageData`에 `pages: PageData[]` 추가(각 page = 기존 박스 컨테이너 데이터), `PageEngine` → `PageEngine[]` → 기존 `BoxEngine` 트리.
- 1.2/1.3/1.4의 O(N) 경로가 **페이지 단위로 스코프다운**. 스레딩은 이미 페이지 간 흐름 개념이라 `relayoutThreads(sourceFrameIds)`를 페이지 진입점으로 승격.
- 마이그레이션: 기존 `children`(최상위 박스)을 단일 page로 래핑하는 호환 레이어 → 검증 스크립트(verify-threading, verify-multicolumn)로 byte-identical 확인.

### ③′ 시분할 프로그레시브 레이아웃 (Web Worker 대체)

- 초기 로드: 뷰포트 페이지만 동기 레이아웃+렌더, 나머지는 `requestIdleCallback`/`scheduler.yield()`로 **페이지 단위 청크** 처리.
- 편집 중: 기존 prefix 캐시 + rAF 병합 경로 그대로 (Worker 불필요 영역).
- 풀 리래핑 트리거(폰트/장평/문서 폭 변경): 페이지 청크로 분할해 블록 제거.
- 동기 계약은 청크 단위로 지켜지므로 기존 소비자(mapper, 커서, IME) 수정 불필요.

### ④ rgbaData 다운사이징

- 오버랩 판정 진실은 `opaqueRowBitmap`(다운샘플 비트맵)이므로, **원본 rgbaData는 판정 완료 후 해제**하고 URL 재주입 시 재추출하는 LRU(활성 페이지 기준 10~20장) 도입.
- 엔진 계약 유지: "DOM 로드 실패 시 엔진 픽셀 소각 금지" 원칙은 그대로, 보관 정책만 페이지 스코프화.

### ⑤ 문서 스케일 스케줄러

- 문단별 `queueMicrotask` 배치를 **문서 단위 스케줄러**로 통합: 우선순위 큐(뷰포트 내 편집 > 뷰포트 내 갱신 > 뷰포트 밖 > 프리페치 프리레이아웃).

### ⑥ 히스토리/상태 스코프화

- undo/redo를 풀 스냅샷 대신 **커맨드 패치**(run-map 델타 스플라이스 기반) 단위로.
- EditManager 편집 상태를 활성 페이지로 한정, 비활성 페이지 컨트롤러 언마운트.

---

## 3. Web Worker 이관 — 실패 역사와 구조적 원인 (③′으로 대체됨)

> **역사적 사실**: Web Worker 이관은 과거 수차례 시도되었으나 모두 실패했다.
> 현재 `src/`에 Worker 관련 심볼 0건 (grep 실측: `Worker|postMessage|transferable` 무매치),
> 브랜치/커밋 흔적도 없음 — 완전히 철거된 상태. 다시 시도하지 말 것. 아래는 그 이유다.

### 3.1 동기 계약 — 가장 큰 벽

```
_layoutStructure() → engine.layout() → render() → renderText() → model.columnContents[i]
```

전부 **동기 체인**. `renderText()`는 `this.model.columnContents[this._index]`를 즉시 읽고,
`TextEditCoordinateMapper`와 커서/선택 배치는 렌더 완료 직후 동기 rect를 요구한다.
`DirtyPendingError` 가드(`ensureCommitted()`)의 존재 자체가 "읽는 시점엔 엔진이 커밋돼 있다"는
동기 전제다. Worker로 가는 순간 `layoutText()`가 Promise가 되고 **모든 소비자가 비동기로 전염**된다.
특히 IME 조합은 같은 프레임 시각 피드백이 없으면 글자가 깜빡이며, optimistic span만으로
Worker 왕복 지연(rAF 1~2프레임)을 못 막는다. Enter/compositionend가 의도적으로 동기
`flushRender()`를 쓰는 현행 설계가 통째로 재검토 대상이 된다.

### 3.2 입력 측면 — 엔진 트리가 DOM에서 점진적으로 공급됨

엔진은 "문서 전체를 받아 한 번에 계산"하는 배치 모델이 아니다.

- `engine.layout(this.items.map(e => e._rawData()))` — 자식 데이터가 **DOM 프로퍼티에서** 조립
- `data` setter의 ID-keyed reconcile, `_syncEngineIdsToDom()`, `prevCellBoxEnginesById` 스태시 — **DOM ↔ 엔진 양방향 동기화**가 수명 주기에 박여 있음
- `updateOverlayContext(overlayEngines, ...)` — `BoxEngine` **인스턴스 참조**를 직접 받음(Map 키가 엔진 객체 identity)

Worker는 참조를 받을 수 없으므로 변경마다 전체 structured clone 필요 → **clone 비용 > layout 비용**,
Worker 쪽 엔진은 매번 캐시 콜드(`_layoutCache`/`_prefixCache`/`_charWidthCache` 전부 소멸).
증분 최적화의 이득이 전부 사라진다.

### 3.3 상태 이중화 — 엔진-우선 원칙과 정면충돌

Worker용 엔진 트리를 유지하면 **엔진 트리가 두 개**가 된다. "엔진 트리가 단일 소스"(RULES.md §3)가
깨지고 두 트리 간 reconcile이 새로운 버그 클래스가 된다. `verify-engine-node.mjs`가 증명하는 것은
"DOM 없이 계산 가능"까지이지 "DOM-fed 증분 계약 없이 동작 가능"이 아니라는 간극이 여기서 드러난다.

### 3.4 Worker가 여전히 유효한 좁은 틈 (선택, 동기 계약 무관)

동기 계약과 무관하고 입출력이 자기완결적인 곳만 안전하다:

| 대상                                             | 이유                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **이미지 디코드 + rgbaData/opaqueRowBitmap 추출** | 입력: URL 바이트, 출력: 다운샘플 비트맵. `createImageBitmap`/OffscreenCanvas로 33MB 픽셀 추출·스캔을 메인 스레드에서 회피. `_feedRgbaToEngine` 비동기 흐름에 자연 결합 |
| **printPostData 직렬화(내보내기)**                   | 풀 문서 일괄 변환 — 배치 모델이라 Worker 모델과 정확히 일치. 증분 동기화 불필요                                                                                       |

**레이아웃 자체는 여기에 넣지 않는다.**

---

## 4. DOM 가상화 — 연결/해제 콜백 전수 감사 결과

> 구현 가능. 단, "콜백이 미구현"이 문제가 아니라 **G1~G3 보강(P1~P3)이 선행**되어야 한다.
> 현행 콜백이 겨냥한 것은 **data 세터 reconcile 중 appendChild 재정렬이 유발하는 순간적(ms급)
> disconnect**다(각 요소 주석에 명시). 가상화의 **장기(분~시간급) detach**는 미검증 영역이며
> 아래 공백이 여기서 드러난다.

### 4.1 요소별 감사 결과 (main 브랜치 실측)

| 요소        | connectedCallback                                                                                                            | disconnectedCallback                                                                                                                                            | 대칭성                 | detach 시 생존 상태                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| **document**    | ppm 측정, placeGun mousedown, **window keydown(capture)**, layout+render (`page.element.ts:186-192`)                           | 3개 리스너 전부 제거 + `editManager.reset()` (`:194-198`)                                                                                                            | ✅ 완전                | — (루트는 detach 안 함)                                                            |
| **box**         | editManager 캐싱, 마우스 리스너 3개, layout, td-static 속성 (`box.element.ts:108-118`)                                           | 리스너 3개 제거, `_unregisterLayout(this)`(선택 해제), ref 해제 (`:147-161`)                                                                                          | ✅ 완전                | **엔진 유지**(splice 안 함), 렌더 결과 유지                                            |
| **paragraph**   | editManager 캐싱, layout, AI 오버레이, **TextEditController 재생성 + 커서/선택 복원** (`paragraph.element.ts:78-95`)                 | AI 오버레이 제거, **커서 offset/bias/selection 저장 → controller.destroy()**(전 리스너·textarea·커서·선택 요소 정리, `text-edit-controller.ts:305-365`), 엔진 splice 안 함 (`:124-137`) | ✅ 완전                | 엔진+`_layoutCache`+`columnContents` 유지, 편집 상태 save/restore 이관                       |
| **image**       | AI 오버레이 생성 (`image.element.ts:125-128`)                                                                                    | AI 오버레이 제거만. 캐시 보존이 주석으로 명시된 설계 ("disconnectedCallback은 DOM 분리일 뿐 파괴가 아니다", `:130-153`)                                                  | ✅ 완전                | 3단계 이미지 캐시 + rgbaData 전부 유지                                                  |
| **column**      | 스타일 캐시 클리어 + `renderText()` (`column.element.ts:108-111`)                                                                  | **빈 몸체** `{ }` (`:113`)                                                                                                                                                | ✅ (할 일 없음이 맞음) | 전역 리스너·매니저 참조 없음. 재부착 시 renderText diff 재사용                               |
| **table**       | layout + modeChange 리스너 + 키보드 편집 활성 (`table.element.ts:83-93`)                                                         | 리스너 제거 + 편집 비활성 (`:95-102`)                                                                                                                              | ✅ 완전                | 엔진 유지                                                                          |
| **tr**          | layout (`tr.element.ts:42-44`)                                                                                                 | 빈 몸체 (`:46-47`)                                                                                                                                                  | ✅ (할 일 없음)        | 전역 상태 없음                                                                     |
| **td**          | 마우스 리스너 2개 + layout (`td.element.ts:68-72`)                                                                              | 리스너 2개 제거 (`:74-77')                                                                                                                                          | ✅ 완전                | 엔진 유지                                                                          |

**사용자 인상 교정**: 빈 콜백(column/tr)은 결함이 아니라 "해제할 전역 상태가 없어서" 정확히
비어 있는 것이다. 나머지는 전부 대칭이다.

### 4.2 가상화 관점의 공백 (G1~G4, 심각도 순)

#### G1 — `page.data` 세터가 언마운트된 박스를 "부활"시킴 (치명)

`data` 세터의 ID-keyed reconcile은 **DOM에 있는 자식**만 `existingById`에 수집한다.
가상화로 페이지를 떼어내면 그 id가 맵에 없어 → 새 요소를 생성해 **전부 다시 마운트**한다.
즉 가상화 활성 상태에서 undo/restore 등 풀 복원 경로를 쓰는 순간 가상화가 무효화된다
(엔진은 id로 재사용되지만 DOM 전체 재생성 = 원래 제거하려던 비용 전액 발생).
**단독 최대 장벽이며, 페이지 모델(②)이 필요한 실무적 이유다.**

#### G2 — 재부착 시 render() 미호출 → 복원된 커서가 잘못된 위치에 놓일 수 있음 (중간)

paragraph의 connectedCallback은 `layout()`만 호출하고 `render()`는 호출하지 않는다
(`paragraph.element.ts:80`). 텍스트 자체는 컬럼의 connectedCallback → `renderText()`가
diff 재사용으로 복원하므로 화면엔 나온다. 그러나 재생성된 TextEditController의 mapper
rebuild는 `paragraph.render()`의 postRender에서 일어나는데, 재부착 직후 아무도 render를
부르지 않으므로 **복원된 커서/선택 좌표가 다음 렌더까지 부정확**할 수 있다. 기존 reconcile
흐름에서는 직후에 문서 렌더가 돌아 가려졌던 공백이다.

#### G3 — 활성 편집 모드가 detach된 요소를 참조 (중간)

`_unregisterLayout`은 레이아웃 **선택**만 해제한다 (`edit-manager.ts:2867-2876`).
이미지 편집 모드, PlaceGun 프리뷰, Insert 컨트롤러의 타깃 참조는 detach 시 자동 해제되지
않는다. 컨트롤러 destroy가 `_unregister`로 편집 컨트롤러 등록은 정리하지만
(`text-edit-controller.ts:306`), 매니저가 쥔 **모드별 타깃 참조**는 별도다.
페이지를 떼기 전 blur/취소가 호스트 계약으로 필요하다.

#### G4 — 재부착 시 z-순서 (경미)

재삽입된 박스는 DOM 끝에 붙지만, `render()`가 zIndex 정렬을 소유하므로
(`page.element.ts:660-663`) 문서 렌더 1회 후 해소. 페이지 단위 마운트에서 z 겹침은
드물어 실질 영향 작음.

### 4.3 가상화에 유리한 기존 설계 (그대로 수혜)

1. **엔진 무 splice 원칙** — box/paragraph/image 모두 disconnect 시 엔진을 부모 트리에서 떼지 않음. 페이지를 DOM에서 떼도 엔진 트리·`_layoutCache`·`columnContents`·rgbaData가 전부 생존 → **재마운트 비용 ≈ 0에 수렴**(layout은 Skeleton 해시 히트, renderText는 전 span 스킵).
2. **커서/선택 save-restore** — transient disconnect용으로 구현된 메커니즘이 그대로 재마운트에 적용됨.
3. **엔진이 완결적** — `findEngineById`, 스레딩 writeback, `printPostData`/`ensureCommitted`는 전부 엔진 트리 기반. **언마운트 페이지 포함 전체 문서 스냅샷·내보내기가 정상 동작**.
4. **mm 좌표계** — ppm/줌 변화가 언마운트 페이지에 영향 없음.
5. **`items` = 마운트된 자식만** — 문서 `render()`가 자연스럽게 마운트 분만 순회. 별도 컬링 불필요.

### 4.4 구현 전 보강 (P1~P4) — 구현 완료

| 보강 | 내용 | 범위 |
| ---- | ---- | ---- |
| **P1** ✅ | G2 — paragraph `connectedCallback`에서 `_savedCursorOffset` 복원 시 `scheduleRender()` 호출 (`paragraph.element.ts`). `_renderScheduled` 가드로 병합되며 캐시 히트 시 span diff 스킵. 계획안(`queueMicrotask` 직접 호출)과 동일 효과이며 기존 배치 메커니즘을 재사용. | paragraph.element.ts 수 줄 |
| **P2** ✅ (계획보다 강하게 구현) | G1 — 호스트 계약 문서화에 그치지 않고 **분리 보관소(`_parkedPages`) + `parkPage()`/`unparkPage()`/`parkedPageIds` 공개 API**를 `LayoutPageElement`에 구현. `data` setter는 보관 id의 DOM 재생성을 스킵하고 보관 스냅샷·분리 요소 프로퍼티를 갱신하며, 보관 중 삭제된 페이지는 보관소·플레이스홀더와 함께 정리. `_layoutStructure()`는 `_collectChildrenData()`로 플레이스홀더 위치의 보관 데이터를 합류시켜 엔진 자식 순서를 보존 (보관 0건이면 기존 경로와 byte-identical). `_syncEngineIdsToDom()`은 위치 기반 → id 기반 매칭으로 전환 (보관 항목 스킵 + id-less DOM write-back 폴백 유지). 공유 계약 상수 `PARKED_PAGE_ATTR`는 `src/constants/defaults.ts`에 위치 (임포트 사이클 방지). | page.element.ts + constants |
| **P3** ✅ | G3 — `EditManager._unregisterLayoutSubtree(root)` 신설 + `box.disconnectedCallback`에서 호출. 서브트리 내 잔류 레이아웃 선택을 배치 정리(1회 dispatch)하고, 분리 서브트리 안의 포커스 이미지는 `blurImage()` + `imageEditMode = false`로 종료. 텍스트 포커스는 문단 컨트롤러 destroy → `_unregister()` 기존 경로가 담당. 활성 상태가 없으면 fast path 즉시 복귀로 reconcile churn 무비용. PlaceGun/Insert 타깃은 라이브 hit-test 방식이라 detach 시 참조 불가 — 호스트 계약으로 남김 (당초 계획에서 축소). | edit-manager.ts + box.element.ts |
| **P4** ✅ (라이브러리 유틸로 구현) | `src/utils/page-mount-manager.ts` — `PageMountManager` 클래스 (attach/detach/refresh/pin/unpin/mountedIds/pinnedIds). IntersectionObserver + **인덱스 윈도우(가시 ±N)** 방식이라 rootMargin 스케일 환산이 불필요 (§5.3 항목 2의 대안 채택). 마운트: `unparkPage()` + `void box.render()` (텍스트·테이블은 connectedCallback 자가 복원, 비동기 페인트만 확정). 언마운트: 분리 전 `offsetWidth/offsetHeight` + absolute 위치를 플레이스홀더에 지정. 요소 클래스 런타임 임포트 없이 `import type` + `localName` 판정으로 utils 배럴 순환 방지. `pin()`으로 편집 중 페이지 고정 (IME 조합 상태 보호 — 호스트가 focusChange에서 pin/unpin). | src/utils/page-mount-manager.ts (신규) |

G4(z-순서)는 미대응 — 문서 렌더 1회 후 해소되며 페이지 단위 마운트에서 실질 영향이
없으므로 의도적 제외.

**당초 권고("P4를 호스트 유틸로 먼저 실험")에서 변경**: P2를 실제 보관소로 구현하면서
`data` 세터 금지 계약이 불필요해졌으므로 (보관 페이지는 스킵+스냅샷 갱신),
매니저를 라이브러리 유틸로 직접 구현했다. 페이지 모델(②)이 들어오면 마운트 단위·데이터
경로·스레딩이 한 곳에 정리된다는 전망은 유지된다.

---

## 5. transform: scale 호환성 — 이미 검증됨

**결론: 상관없다. 오히려 이 코드베이스는 `transform: scale`을 이미 1급 시민으로 다루며,
실제 호스트 앱(layout-ui)이 지금 그 방식으로 운영 중이다.** 가상화와 스케일은 서로 다른
축이라 충돌하지 않는다.

### 5.1 검증된 사실

| 계층               | 증거                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **엔진**               | 모든 계산이 mm-only. `transform: scale`은 엔진 수학에 전혀 들어가지 않음 (`grid-calculator-engine.ts:9`)                                                                                                                                          |
| **ppm 측정**           | `_measurePpm()`이 측정 div를 `document.body`에 직접 붙임(`position:absolute; top:-10000px`, `page.element.ts:270-286`) — **호스트의 scaled 컨테이너 밖**에서 측정하므로 호스트 transform이 ppm을 오염시키지 않음                                       |
| **EditManager**        | `_scale` 필드 + `setScale()`/`resetScale()` 전용 API (`edit-manager.ts:243-498`). `screenPxToMm() = px / (ppm × scale)`                                                                                                                              |
| **편집 좌표**          | `TextEditCoordinateMapper`가 모든 rect 변환에서 `manager.scale`로 나눔(6지점: 292, 396, 417, 561, 688행). 커서/textarea 배치도 동일 (`text-edit-controller.ts:2643-2671`)                                                                               |
| **드래그/삽입**        | PlaceGun·Insert가 `screenPpm = ppm × scale` (`place-gun-controller.ts:860`, `insert-controller.ts:757`), reparent 델타도 scale 보정 (`layout-edit-controller.ts:2554`)                                                                                  |
| **엔진 쿼리 모드**     | 엔진 mm rect → 화면 px 변환도 `(mm × ppm) / scale` (`text-edit-coordinate-mapper.ts:417-425`)                                                                                                                                                          |
| **호스트 앱 실사용**   | `layout-editor.tsx:1345` `transform: scale(${previewScale})` + `:1139` `setScale(previewScale)`, `page-thumbnail-grid.tsx:83-84` — **프로덕션에서 이 조합으로 동작 중**                                                                                   |

### 5.2 왜 충돌하지 않는가 — 책임 분리

```
transform: scale(s)  →  브라우저 컴포지트 단계만 변경 (layout/reflow 유발 안 함)
                        엔진·캐시·charWidth·columnContents 전부 무영향

가상화               →  DOM 마운트/언마운트만 변경
                        엔진 트리는 mm-only라 detach 페이지도 계산 유지
```

확대/축소 시 엔진 재계산 0, 언마운트 페이지 무영향. 줌 변경 = 컴포지트만 갱신 →
가상화 윈도우(마운트 페이지 집합)는 커버리지 변화분만 조정.

### 5.3 주의점 4가지 (경미, 구현 시 반영)

1. **마운트 판정은 반드시 `getBoundingClientRect` 기반** — BCR은 transform 반영 좌표를 반환하므로
   "뷰포트 ∩ 페이지 rect" 판정이 스케일을 자동 보정. `scrollTop`/`offsetTop` 같은 레이아웃 좌표
   역산 방식은 금지. IntersectionObserver도 내부적으로 transform 반영 geometry를 쓰므로 안전.
2. **IO `rootMargin`은 스케일 인지 px로 계산** — `mm × ppm × scale`로 환산(root 좌표계는
   scaled 서브트리 밖). 줌 변경 시 rootMargin만 갱신. rootMargin 없이 BCR 기반 판정만으로도 가능.
3. **ppm과 scale은 다른 것 — 호출 계약 유지**: 호스트 `transform: scale` → `setScale()`만
   (ppm 불변). 브라우저 줌/환경 변화 → `resetPpm()`. 이 구분이 흐트러지면(예: scale을 ppm에
   반영) 편집 좌표가 이중 보정됨.
4. **축소에서 동시 가시 페이지 수 증가** — 300페이지를 10% 축소로 전체 조감하면 사실상 전체
   마운트와 동일해짐. 이는 scale 문제가 아니라 가상화의 본질적 한계로, 전체 조감용은
   페이지 모델(②) 이후 썸네일 렌더 경로(엔진 `printPostData`/축소 canvas)로 분리.
   호스트 `page-thumbnail-grid.tsx`가 썸네일에서 setScale을 쓰는 것과 같은 맥락.

---

## 6. 측정 & 검증 계획

> `scripts/README.md` 워크플로 (기준선 측정 → 수정 → 검증 → 재측정) 준수.

### 6.1 기준선 확보

1. `benchmark-browser.mjs`에 **300페이지 시나리오** 추가 (현행 5 시나리오는 문서 스케일 미포함)
2. `snapshot-layout.mjs`로 페이지 수 × 메모리/시간 곡선 확보

### 6.2 각 단계 판정 기준

| 단계        | 스크립트                                   | 판정 기준                                                                                       |
| ----------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| P1~P4 보강    | `verify-dom-diff.mjs`, `verify-visual-render.mjs` | detach→reattach 후 DOM↔엔진 정합, 재마운트 소요시간(캐시 히트 시 ms급), **G1 재발 여부**(data 세터 호출 후 노드 수 불변) |
| ① 가상화      | benchmark (마운트/언마운트 시나리오 추가)        | 노드 수(3~4자릿수 절감), 재마운트 p95                                                             |
| ③′ 시분할     | benchmark (콜드 리래핑 시나리오)                 | 풀 리래핑 p95, 첫 paint 지연                                                                     |
| ④ rgbaData    | 힙 스냅샷                                    | 이미지 수 × 상주 픽셀 메모리                                                                      |
| **scale 곱하기** | 신규 시나리오                                 | `scale 0.5 / 1.0 / 2.0` × (마운트 → 편집 → 언마운트 → 재마운트 → 커서 복원) — 커서 px가 scale 보정된 위치에 복원되는지. 줌 변경 직후 재마운트 시 `setScale` 갱신이 마운트 판정에 반영되는지 |

### 6.3 회귀 방지

- 커서 내비게이션 관련 변경 시 `scripts/verify-caret-parking.mjs` 선행 실행 (기존 규칙).
- 페이지 모델 마이그레이션 시 `verify-threading.mjs`, `verify-multicolumn.mjs`로
  byte-identical 확인.
- 모든 최적화는 실측 데이터로 근거 확보 (AGENTS.md 측정·검증 하니스 원칙).

---

## 7. 실행 순서 — P1~P4 완료, 검증 완료

1. **[완료]** P1 (paragraph 재부착 render 스케줄), P3 (detach 서브트리 정리),
   P2 (parked 보관소 + data 세터 스킵 + id 기반 sync), P4 (`PageMountManager`) —
   `npm run build` + `tsc --noEmit` + `verify-engine-node.mjs` 통과.
2. **[완료]** 회귀 6종 ALL PASS (구현 세션 실측):
   `verify-dom-diff` / `verify-pending-style`(31) / `verify-visual-render`(7) /
   `verify-multicolumn` / `verify-image-edit-mode`(64) / `verify-caret-parking`(28).
3. **[완료]** 신규 `scripts/verify-virtualization.mjs` 47항목 ALL PASS —
   park/unpark 엔진 완결, G1 부활 방지, 보관 중 편집 반영, P1 커서 복원+예약 렌더,
   P3 선택·이미지 포커스 정리, 매니저 윈도우·pin·footprint,
   **H (parked 오버레이 회피)**: 분리 상태 재계산도 파트 분할 유지 + 가시 글자
   이미지 rect 침범 0, **I (리사이즈)**: 축소 시 마운트 축소·확대 시 확대,
   **J (성능)**: 30페이지 22,750 span → 윈도우 2,310 (약 10%, park 13.2ms),
   페이지당 재마운트(unpark+render) ~1~10ms,
   **K (스레드+park)**: 분리+layout 후 story 보존·체인 유지, 분리 상태 체인
   전파(contentFrom +1), 복원 후 slice 안정+정합. 상세는
   `scripts/README.md`의 해당 섹션 참조.
4. **[완료]** 검증 중 발견된 매니저 결함 1건 수정 — **IO flapping**:
   mm 기반 fractional px 경계에 페이지가 정확히 걸리면 반올림 노이즈로
   intersection이 0/1 토글되어 park/unpark이 무한 반복됨 (IO 로그 실측).
   대책 3종: (1) 2px 히스테리시스 밴드(`rootMargin`, root 좌표계라 스케일 무관),
   (2) rAF 병합 적용 (IO 배치당 DOM surgery 금지 — 최신 `_visible` 기준 프레임당
   1회), (3) 플레이스홀더 fractional 사이징 (`getBoundingClientRect/scale`,
   `scale` 옵션, 기본 1 — `offsetWidth` 정수 반올림이 이웃을 경계 너머로 민다).
5. **[완료 — 2026-09-14]** `benchmark-browser.mjs`에 300p + 마운트/언마운트
   시나리오 추가 (시나리오 8) → 노드 수·메모리·재마운트 p95 측정 (§6.2).
   실측 (헤드리스, 300p×600자): 빌드 172.5ms / 풀렌더 249.4ms
   (spans 179,400, nodes 909) / park 297p 232.7ms (spans →1,794, 100:1,
   nodes →315) / 재마운트 20p avg 7.44ms·p95 9.10ms (J 밴드와 동일 —
   스케일 무관) / 300p 타이핑 입력 동기 p95 3.30ms / JS 힙 평탄.
   방법론 주의: `performance.memory`·`getDOMCounters`는 분리 보관 트리를
   JS 참조로 유지하는 한 감소하지 않는다 — 가상화의 메모리 story는
   "파괴"가 아니라 "분리+보유"이며, 프로세스 RSS급 해제를 원하면 보관
   트리 eviction(LRU)이 필요하다 (미구현 — 향후 과제 후보).
   상세는 `scripts/README.md`의 시나리오 8 섹션 참조.
6. **[② 페이지 모델 — 완료 (2026-09-14)]** `DocumentData.pages` 1급화 +
 `DocumentEngine`(스레드 문서 소유·페이지 스코프 배치) + `<x-layout-document>`
 (EditManager·park·스레드 소유) + 레거시 호환(`normalizeDocumentData`).
 스레드 정의·EditManager·보관 단위가 문서로 이동했고, threads·EditManager·
 park을 문서 스코프에서 검증하는 `verify-page-model.mjs` 13항목이 ALL PASS.
7. **[③′ 시분할 프로그레시브 레이아웃 — 완료 (2026-09-15)]** `progressive`
   프로퍼티 + 페이지 단위 청크 표시 패스 구현 — 상세는 § 8 참조.
8. **[③′ 이후]** rgbaData 다운사이징 등 순차 적용.
9. **[근본 원인 분석 완료]** 스레드 체인 타이핑 비용의 결론: shift 편집은
   모든 줄의 텍스트·위치를 바꾸므로 재계산·재쓰기가 필수이며, 남는 레버는
   범위(체인 분할·마운트 윈도우 축소)뿐이다. 텍스트 동일성 기반 라인 캐시
   초안은 shift 편집에서 성립하지 않음이 증명되어 폐기됐다.

### 7.1 스레드 체인 타이핑 비용 귀속 (실측)

30프레임 단일 체인 데모에서 키스트로크당 비용을 위치별·윈도우별로 실측했다
(헤드리스, `longtask` 합산):

| 조건 | 롱태스크 합 | 엔진 전체 재계산 |
|---|---|---|
| head 타이핑, window=1 (3p 마운트) | ~468ms | 30프레임 중 유의미 전체 재계산 다수 |
| tail 타이핑, window=1 | ~472ms | 1프레임만 전체 재계산 (슬라이스-로컬 해시로 나머지 히트) |
| head 타이핑, window=0 (2p 마운트) | ~308ms | 동일 체인 (30프레임) |

결론:
- **위치 무관성이 정상이다.** 엔진은 끝쪽이 6배 저렴하지만(50ms→8ms), 전체의
  90%를 차지하는 마운트 윈도우 DOM 비용(span 쓰기 + 강제 리플로우 + 페인트
  커밋)이 위치와 무관하므로 체감이 같다. 사용자의 "끝쪽도 같다"는 관측이 맞다.
- **윈도우 크기가 직접 비례한다.** 마운트 3→2페이지에 490ms→308ms (페이지당
  약 160ms, 헤드리스). 타이핑 체감의 즉시 레버는 윈도우 축소와 체인 분할이다.
- 헤드리스(SwiftShader) 수치는 실기보다 5~10배 부풀려져 있다. 실기 분할은
   P1에서 완료했다 — headed Chromium + RTX 5070 Ti 실측으로 키당 귀속이
   닫혔다 (엔진 layoutText 2.7ms·4% 대 DOM측 90% 이상).
- 시도 후 revert한 것: overflow 카운트 변화 시 span 전체 재생성 제거 —
  동일 페이지 A/B(강제 recreate vs diff)에서 484ms vs 458ms로 유의미한 차이
  없음이 실측되어 원복했다 (근거 없는 최적화 금지 원칙).

---

## 8. ③′ 시분할 프로그레시브 레이아웃 — 구현 기록 (2026-09-15)

### 8.1 설계 (Oracle 리뷰 반영)

**원칙**: 엔진 구축은 동기 유지, **표시 패스만 시분할**.

- `document.layout()`이 반환되는 시점에 엔진 트리·스레드 배치·스냅샷 읽기
  (`extractData`/`printPostData`)가 완결된다 — 단일 소스 불변식·dirty 계약에
  새 가드 불필요. Worker 이관 실패(§ 3)의 동기 계약을 청크 단위로 지킨다.
- 청크 내 동기 계약은 기존 `render()`와 동일 — `renderText`가
  `columnContents`를 즉시 읽고, `flushRender`(Enter/compositionend)는 무변경.
- **스케줄링**: `setTimeout(0)` + 인라인 8ms 예산 (`performance.now()`).
  `queueMicrotask`는 렌더링으로 양보하지 않아 실격 (세션이 하나의 롱태스크가
  된다), `requestIdleCallback`은 배경 탭에서 starve. 300p 기준 페이지당
  렌더 ~0.83ms → 청크당 ~9페이지, 31청크 ≈ 400ms 벽시계.

### 8.2 공개 API

| API | 위치 | 계약 |
| --- | --- | --- |
| `progressive` 프로퍼티 (document) | `document.element.ts` | `true` → 초기 로드·풀 리플로우의 표시 패스를 페이지 청크로 펌프. `false`/`undefined`는 기존 동기 경로 (byte-identical). 세터는 플래그만 갱신 (재배치 트리거 없음), 세션 중 해제 시 남은 대기열 동기 소진. |
| `flushProgressiveLayout()` (document) | `document.element.ts` | 대기열을 동기 소진하는 편집 진입 관문. 타이핑·IME는 포커스를 요하므로 `EditManager._requestFocus`/`focusImage` 상단 호출로 전 경로 방어. |
| `progressiveIdleYield(delayMs)` | `src/utils/progressive-layout.ts` | 청크 사이 양보 Promise. 테스트 훅 `__LAYOUT_ELEMENT_PROGRESSIVE_IDLE__ = true`로 즉시 resolve (검증 스크립트의 타이밍 의존 제거). |

### 8.3 동작 구조

```
doc.data = bigData (progressive=true)
  ├─ reconcile 루프: 각 page.data setter → 엔진 구축은 동기 (page.layout() 유지),
  │   표시 패스(page.render())만 _deferDisplayPass로 억제
  ├─ this.layout(): 구조 패스 + adoptPageEngines + 스레드 패스 + frame 동기 (동기)
  ├─ 최종 render() → _enqueueDisplayPass() → _pumpDisplayPass()
  │   └─ 시간 예산 내 동기 렌더(void el.render()) → 예산 초과 시 setTimeout(0) 양보 → 반복
  └─ 펌프 중 park(언마운트)된 페이지는 isConnected skip, IO 재마운트는
     connectedCallback이 자체 표시 패스 수행 (대기열 중복 항목은 건너뛴다)
```

- **스레드 확정 시점**: `document.layout()` 내에서 페이지 엔진 편입 →
  `engine.layout()`(스레드) → `_syncThreadFramesToDom`이 기존과 동일하게
  동작하므로 스레드 프레임 문단은 **스레드 배치 후** 표시된다 (동기 경로와
  동일한 표시 출력). `PageMountManager` 없이 progressive 단독 사용 시
  언마운트 페이지가 없으므로 전 페이지가 펌프로 표시된다.
- **verify-progressive-layout.mjs 21항목 ALL PASS** — (a) OFF 기준선
  byte-identical(span 816), (b) ON 세션 완결(엔진 완결 + 체인 + 패리티),
  (c) 재주입 3페이지 표시, (d) park/unpark 재마운트 표시 패스 + story 보존,
  (e) textStyle 교체 DOM 수렴, (f) 타이핑 seam 정합, (g) flush 관문
  (커서 좌표계 보장).