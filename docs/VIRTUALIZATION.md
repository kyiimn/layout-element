# VIRTUALIZATION.md — 수백 페이지 문서 가상화 및 대규모 문서 스케일 대응 (인계 문서)

> **문서 성격**: 분석·설계 문서. **구현은 별도 에이전트가 수행한다.**
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
   **G1~G3 보강 선행** (§4, §5).
2. **② 페이지 모델** — 나머지 문제 전부의 데이터적 기반. G1의 근본 해소.
3. **③′ 시분할 프로그레시브 레이아웃** — Web Worker의 **대체** 수단.
   Worker 이관은 수차례 시도 끝에 실패했으며(역사적 사실), 이 코드베이스 구조상
   실패가 필연이었던 이유가 분석됨 (§3).

실행 순서: **① (P1~P4 보강) → ② → ③′ → ④~⑥**.

---

## 1. 수백 페이지 문서 처리 시 문제점 (진단)

### 1.1 전제

`DocumentData`는 **페이지 개념이 없는 단일 캔버스 모델**이다 — `src/types/layout`에
`page` 심볼 0건 (grep 실측). `width`/`height` 한 세트. 수백 페이지 문서는
"최상위 박스 수백 개"라는 **관례**로만 표현되고, 이 전부가 하나의
`<x-layout-document>` shadow DOM 안에 산다.

### 1.2 구조적 문제

| #   | 문제                                                                                                                                                                                                                                     | 근거                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1.1 | **페이지 추상화 부재** — 페이지 경계, 페이지 간 흐름, "현재 페이지"가 데이터 모델에 없음. 페이지 단위 편집 UI(이동/썸네일/잠금)를 만들 근거가 엔진에 없음                                                                                      | `DocumentData` = width/height 1개             |
| 1.2 | **전역 O(N) 경로 다수** — `DocumentEngine._buildTree()`가 `layout()`마다 전 트리를 순회하며 자식마다 `findBoxEngineById`(재귀 선형 검색) → 최상위 박스 N개에 O(N²) 성분                                                                          | `document-engine.ts:938-978`                  |
| 1.3 | **`_refreshParagraphOverlays` 무조건 전체 갱신** — overlay 수와 무관하게 모든 문단을 순회. 한 페이지만 바뀌어도 수백 페이지 문단 전체에 `updateOverlayContext` + 해시 재계산 호출                                                              | `document-engine.ts:976`, AGENTS.md 명시        |
| 1.4 | **풀 스냅샷 라운드트립** — undo/redo·외부 데이터 주입이 `data` setter 전체 reconcile 경로. 문서 1회 교체 = 전 페이지 reconciliation + 전 엔진 `layout()`                                                                                         | AGENTS.md "data setter는 풀 복원용"         |
| 1.5 | **스레딩 체인 순차 배치** — `ThreadEngine.layoutThreads()`가 프레임(=페이지)을 순차 feed-forward. 1페이지 타이핑 → 체인 후속 페이지 전부 재배치. `relayoutThreads(sourceFrameIds)`로 편집점 이후만 제한하는 부분 완화 존재                       | `document-engine.ts:987-1024`                 |
| 1.6 | **EditManager 전역 단일** — 포커스/커서/모드가 문서당 1세트. 페이지 단위 활성화 개념 없음                                                                                                                                                        | AGENTS.md Managers                          |

### 1.3 성능 문제

| #   | 문제                                                                                                                                                                                                 | 규모 환산                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 2.1 | **메인 스레드 글자 단위 래핑** — `_layoutTextIntoColumns()`가 문자당 폭 측정+배치. 풀 리플로우 시 전체 문자 수에 비례해 메인 스레드 점유                                                                               | A4 300p × 7,500자 ≈ **225만 자** → 수십 초 블로킹            |
| 2.2 | **증분 캐시가 문단 단위에서 끝남** — Skeleton(`_layoutCache`)/prefix 캐시는 문단 내부 최적화. 페이지/문서 스케일 증분 없음. 1.3과 결합해 국소 변경이 전역 순회를 유발                                                          | PERFORMANCE.md §3.12                                      |
| 2.3 | **캐시가 엔진 인스턴스별** — `_charWidthCache`(LRU 5,000)가 `ParagraphEngine`당 존재. 문단 수백 개면 동일 폰트 메트릭을 문단마다 중복 계산+보관 (전역 공유 아님)                                                                   | `paragraph-engine.ts:69`                                    |
| 2.4 | **rgbaData 문서 수명 유지** — 오버랩 판정용 RGBA 픽셀 배열을 엔진이 계속 보유. A4 300dpi 1장 ≈ 33MB → 이미지 300장이면 ~10GB급 잠재 메모리. `opaqueRowBitmap`만으로 판정 가능한데 원본이 같이 살아 있음                              | AGENTS.md rgbaData 계약                                   |
| 2.5 | **렌더 순차 await** — `LayoutDocumentElement.render()`가 이미지 로드를 순차 await → 한 장 지연이 전체 렌더 지연                                                                                                            | `document.element.ts:661-663`, PERFORMANCE.md §10 후보       |
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

- `DocumentData`에 `pages: PageData[]` 추가(각 page = 기존 박스 컨테이너 데이터), `DocumentEngine` → `PageEngine[]` → 기존 `BoxEngine` 트리.
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
| **document**    | ppm 측정, placeGun mousedown, **window keydown(capture)**, layout+render (`document.element.ts:186-192`)                           | 3개 리스너 전부 제거 + `editManager.reset()` (`:194-198`)                                                                                                            | ✅ 완전                | — (루트는 detach 안 함)                                                            |
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

#### G1 — `document.data` 세터가 언마운트된 박스를 "부활"시킴 (치명)

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
(`document.element.ts:660-663`) 문서 렌더 1회 후 해소. 페이지 단위 마운트에서 z 겹침은
드물어 실질 영향 작음.

### 4.3 가상화에 유리한 기존 설계 (그대로 수혜)

1. **엔진 무 splice 원칙** — box/paragraph/image 모두 disconnect 시 엔진을 부모 트리에서 떼지 않음. 페이지를 DOM에서 떼도 엔진 트리·`_layoutCache`·`columnContents`·rgbaData가 전부 생존 → **재마운트 비용 ≈ 0에 수렴**(layout은 Skeleton 해시 히트, renderText는 전 span 스킵).
2. **커서/선택 save-restore** — transient disconnect용으로 구현된 메커니즘이 그대로 재마운트에 적용됨.
3. **엔진이 완결적** — `findEngineById`, 스레딩 writeback, `printPostData`/`ensureCommitted`는 전부 엔진 트리 기반. **언마운트 페이지 포함 전체 문서 스냅샷·내보내기가 정상 동작**.
4. **mm 좌표계** — ppm/줌 변화가 언마운트 페이지에 영향 없음.
5. **`items` = 마운트된 자식만** — 문서 `render()`가 자연스럽게 마운트 분만 순회. 별도 컬링 불필요.

### 4.4 구현 전 보강 (P1~P4)

| 보강 | 내용                                                                                                                                                                                                                                     | 범위                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **P1**   | G2 — paragraph `connectedCallback`에서 `_savedCursorOffset` 복원 시 `queueMicrotask(() => this.render())` 스케줄 (기존 `_renderScheduled` 가드로 배치 병합됨)                                                                                     | paragraph.element.ts 수 줄        |
| **P2**   | G1 — 임시 방어: 가상화 활성 시 `document.data` 세터 대신 페이지 스코프 복원 경로 사용을 **호스트 계약으로 문서화**. 근본 해결은 페이지 모델(②)                                                                                                      | 문서화 + 향후 페이지 모델         |
| **P3**   | G3 — detach 시 EditManager가 이 요소를 타깃으로 하는 활성 모드(imageEditMode/placeGun/insert)면 취소하는 방어 코드                                                                                                                               | edit-manager + 각 콜백          |
| **P4**   | 마운트 매니저 유틸: IntersectionObserver로 뷰포트 ±1~2페이지 윈도우 유지, 재마운트 순서 `appendChild → layout(자동) → render()` 고정. 마운트 단위는 **최상위 박스(페이지 컨테이너)** — 부모-자식 connectedCallback 순서가 DOM 삽입 순서를 따르므로 서브트리 통째 마운트만 안전 | 신규 유틸 또는 호스트           |

**P4를 호스트 유틸로 먼저 만들어 실험한 뒤 페이지 모델에 흡수하는 순서를 권한다.**
G1이 남아 있는 상태에서는 "마운트 매니저 + data 세터 금지 계약"으로 동작하지만,
페이지 모델이 들어오면 마운트 단위·데이터 경로·스레딩이 한 곳에 정리되어 P2 계약이 자연 소멸한다.

---

## 5. transform: scale 호환성 — 이미 검증됨

**결론: 상관없다. 오히려 이 코드베이스는 `transform: scale`을 이미 1급 시민으로 다루며,
실제 호스트 앱(layout-ui)이 지금 그 방식으로 운영 중이다.** 가상화와 스케일은 서로 다른
축이라 충돌하지 않는다.

### 5.1 검증된 사실

| 계층               | 증거                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **엔진**               | 모든 계산이 mm-only. `transform: scale`은 엔진 수학에 전혀 들어가지 않음 (`grid-calculator-engine.ts:9`)                                                                                                                                          |
| **ppm 측정**           | `_measurePpm()`이 측정 div를 `document.body`에 직접 붙임(`position:absolute; top:-10000px`, `document.element.ts:270-286`) — **호스트의 scaled 컨테이너 밖**에서 측정하므로 호스트 transform이 ppm을 오염시키지 않음                                       |
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

## 7. 인계 에이전트를 위한 실행 순서 제안

1. **[준비]** `benchmark-browser.mjs`에 300p 시나리오 + 스케일 시나리오 추가 → 기준선 확보
2. **[P1]** paragraph 재부착 render 스케줄 (수 줄) → `verify-dom-diff.mjs` 통과 확인
3. **[P3]** detach 시 활성 모드 취소 방어 → `verify-image-edit-mode.mjs`, `verify-pending-style.mjs` 회귀 확인
4. **[P4]** 마운트 매니저 유틸(호스트 또는 라이브러리) — BCR 기반 판정, IO rootMargin 스케일 환산, `appendChild → layout → render()` 순서 고정
5. **[P2]** 가상화 활성 시 `document.data` 세터 금지 계약 문서화 (본 문서 §4.4 인용)
6. **[① 완료 판정]** 300p 시나리오에서 노드 수·메모리·재마운트 p95 재측정
7. **[② 페이지 모델]** 위 로드맵대로 — 이후 P2 계약 소멸, ③′ 이후 단계 순차 적용