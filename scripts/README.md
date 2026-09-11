# scripts/ — 벤치마크 및 검증 도구

성능 최적화·버그 수정 작업에서 사용하는 측정/검증 harness 모음.
**모든 최적화는 측정 데이터로 근거를 확보하고, 모든 수정은 정합성 검증을 통과해야 한다.**

## 빠른 참조

| 스크립트 | 분류 | 측정/검증 대상 | 종료 기준 |
|---|---|---|---|
| `benchmark-typing.mjs` | 벤치마크 (Node) | 엔진 `layoutText` 타이핑 패스별 시간 | 수치 기록 (비교용) |
| `benchmark-hotloop.mjs` | 벤치마크 (Node) | `_layoutColumnsPass` 핫 루프 세분 계측 | 수치 기록 |
| `benchmark-browser.mjs` | 벤치마크 (브라우저) | 전체 파이프라인 5 시나리오 + 프레임 시간 | 60fps 예산 16.7ms |
| `snapshot-layout.mjs` | 정합성 (엔진) | `columnContents` + `overflow` 직렬화 | **byte 동일** |
| `verify-dom-diff.mjs` | 정합성 (DOM) | DOM ↔ 엔진 텍스트/span 무결성 | ALL PASS |
| `verify-visual-render.mjs` | 정합성 (화면) | 실제 렌더 검증 — rect 기반 표시성 (호스트 CSS rule stale/0폭/클립 감지) | ALL PASS |
| `verify-ime.mjs` | 정합성 (IME) | 한글 조합 커밋/취소/혼합 | ALL PASS (서버 없으면 자동 기동) |
| `verify-multicolumn.mjs` | 정합성 (멀티컬럼) | prefix 캐시 경로 === 전체 재래핑 | ALL PASS |
| `verify-inline-metrics.mjs` | 정합성 (엔진) | 인라인 `letterSpacing`/`widthRatio`/`spaceRatio` 런 오버라이드 — 폭 공식/캐시 해시/printPostData/extractData/스타일 조회/런 맵 병합/오버랩 회피(파트 분할·좁은 영역 COVER) | ALL PASS |
| `verify-text-decoration.mjs` | 정합성 (엔진) | 텍스트 장식 `underline`/`breakline`/`outline` — 장식선 rect 산출(구간 병합·듀얼 트랙)/색상 폴백/캐시 무효화/printPostData decorations+chars.outline/화면-인쇄 패리티/스타일 조회/런 맵 병합/OFF 기준선 | ALL PASS |
| `verify-style-revert.mjs` | 정합성 (스타일) | 인라인 회귀 주입 범위 (selection/캐스케이드 통일) | ALL PASS (서버 없으면 자동 기동) |
| `verify-pending-style.mjs` | 정합성 (스타일) | pending style 라이프사이클 — blur 재포커스 유지(핵심)/커서 이동·selection 해제/타이핑·paste 적용/연속 타이핑 유지 | ALL PASS (서버 없으면 자동 기동) |
| `verify-hangul-glyph-fallback.mjs` | 정합성 (엔진) | cmap 미등록 한글 음절 폭 폴백 (`가` 폭 대체) | ALL PASS |
| `verify-hanging-punctuation.mjs` | 정합성 (엔진) | 걸침표(행말/행두) — OFF 기준선 byte 동일/금칙 대체 배치/trailing run/justify/getCharRect/print 패리티/히트테스트/엣지 게이트/블록 경계/prefix 캐시/API | ALL PASS |
| `verify-line-gap-mode.mjs` | 정합성 (엔진) | 행간 고정값 모드 (`lineGapMode` ratio/fixed/fixed-min) — 기본값 byte 동일/fixed 균일 라인+absHeight/fixed-min 스케일업/오버랩 근사 방향/오버플로우↔absHeight/verticalAlign/해시 충돌(lgm:·lg:)/개별 setter/GC 정합/두 층위/flipLayout/prefix 캐시/extractData | ALL PASS |
| `verify-hanging-punctuation-browser.mjs` | 정합성 (브라우저) | 걸침표 ON 실제 화면 페인트 — 파트 밖 span rect/overflow 해제/원상 복구 | ALL PASS |
| `verify-overlap-inline-fontsize.mjs` | 정합성 (엔진) | 인라인 fontSize 오버라이드 컬럼의 오버랩 판정 rect — per-line 높이 기준 | ALL PASS |
| `verify-image-displayrect-cache.mjs` | 정합성 (엔진) | 이미지 displayRect(objectFit/none x/y/w/h) 변화 시 오버랩 회피 재계산 — layout input hash 무효화 | ALL PASS |
| `verify-image-edit-mode.mjs` | 정합성 (브라우저) | 이미지 편집 모드 전 동작 — dblclick 진입(일반/레이아웃 모드), 부모 box 빨간테두리+라벨 숨김, 드래그/objectFit 자동전환, 휠 비율 유지, ESC 취소/복귀, Tab 순회, selection 이동 시 포커스 상실, 클램핑, **extractData/printPostData 3소스 일치, 오버랩 회피 갱신 A/B** | ALL PASS |
| `verify-overlap-none.mjs` | 정합성 (엔진) | overlapMode 'none' 시맨틱 — 단일 관문(computeOverlapSizeMm)에서 NONE 조기 반환, box/path 회피 유지 | ALL PASS |
| `verify-threading.mjs` | 정합성 (엔진) | 텍스트 스레딩 — 비-스레드 회귀/단일 프레임 기준선/feed-forward/콘텐츠 무결성/런 슬라이싱/pull-back/extractData round-trip/overset/threadTail 마킹/**지오메트리 행렬 81조합**/childrenData 삼분 계약/writeback 방어/printPostData 패리티/**변경 감지 스킵**/**프레임 경계 금칙 교정**/**테이블 셀 프레임 행 삭제** | ALL PASS |
| `verify-threading-browser.mjs` | 정합성 (브라우저) | 스레딩 화면 진실 — 초기 로드 3계층(엔진↔DOM span)/타이핑 전파 seam/테두리 tail 분기/round-trip 체인 동등/**타이핑 스트레스 flush 통합**/**IME 조합 × flush**/**키보드 프레임 경계 이동(절대 좌표계)** | ALL PASS |
| `verify-print-image-overlap.mjs` | 정합성 (엔진) | 이미지/오버랩 수정의 printPostData 반영 — 모드별 print 좌표 === displayRect, objectFit 갱신, overlapMode none 관통 | ALL PASS |
| `verify-right-indent-tab.mjs` | 정합성 (엔진) | 좌우 밀기 탭(`\t`) 배치·정렬·print 스킵 | ALL PASS |
| `verify-right-indent-tab-browser.mjs` | 정합성 (브라우저) | Shift+Tab 키 삽입·DOM 렌더·커서 | ALL PASS |
| `verify-right-indent-tab-composition.mjs` | 정합성 (브라우저) | 탭 라인 한글 조합 표시·우측 정렬·이탈 방지 | ALL PASS |
| `verify-right-indent-tab-guide.mjs` | 정합성 (브라우저) | 탭 점선 가이드 (편집 모드 전용 표시·원복) | ALL PASS |
| `verify-right-indent-tab-single-source.mjs` | 정합성 (원칙) | 탭 좌표 단일 소스: DOM === 엔진 === print | ALL PASS |
| `verify-engine-node.mjs` | 정합성 (Node) | 엔진 계층 DOM-free 동작 | ALL PASS |
| `verify-obfuscated.mjs` | 정합성 (빌드) | 난독화 IIFE 번들 로딩 | ALL PASS |
| `obfuscate.mjs` | 빌드 | IIFE 번들 난독화 | build 완료 |

---

## 벤치마크

### `benchmark-typing.mjs` — 엔진 타이핑 패스별 실측 (Node)

**목적**: 키스트로크당 `layoutText()` 내부 패스(`_parseContents`, `_layoutColumnsPass`, `_applyLineBreakRules`, `_computeCharOffsets`)별 소요 시간 분해. 엔진 계층만 측정하므로 DOM/리플로우 영향이 없다 — **병목이 엔진인지 DOM인지 분리**하는 첫 단계.

**실행**:
```bash
npx tsx scripts/benchmark-typing.mjs
```

**사용 시점**: 엔진 최적화 전/후 기준선 비교. 문자 수(100/500/1000/2000)별 키스트로크당 시간을 출력한다.

**결과 해석**: 패스별 시간이 키 수에 선형 증가하면 O(N) 문제, 상수면 캐시 효과. 2000자 기준 이전 기록: 최적화 전 2.53ms/키 → 현재 0.31ms/키 (엔진만).

---

### `benchmark-hotloop.mjs` — 핫 루프 세분 계측 (Node)

**목적**: 매 글자마다 실행되는 `_layoutColumnsPass` 내부 비용 요소별 시간 분해:
1. `_charWidthMm` (캐시 키 문자열 생성 + LRU 조회)
2. `_createLineWithParts` (오버랩 체크 포함)
3. 글자 수 기반 전체 처리량

**실행**:
```bash
npx tsx scripts/benchmark-hotloop.mjs
```

**사용 시점**: `benchmark-typing`에서 엔진 병목이 확인됐을 때, **그 안의 어떤 연산**이 지배적인지 좁히는 2단계. 핫 루프 최적화(`a0baa7f`, 57% 개선)와 2단 캐시(`d149f52`, 누적 88% 개선)의 근거 데이터를 만들었다.

---

### `benchmark-browser.mjs` — 브라우저 전체 파이프라인 벤치마크 (Playwright)

**목적**: 사용자 상호작용 → 엔진 → DOM 렌더링까지 **실제 프레임 시간** 측정. 5개 시나리오 + 분해 계측:

| 시나리오 | 측정 | 측정 기준 |
|---|---|---|
| 1. 텍스트 편집(타이핑) | 입력 이벤트 dispatch 동기 시간 + rAF 프레임 델타 | dirty layout 정착 후 1키/프레임 (실사용 패턴) |
| 2. 오버랩 이미지 이동 | box `left` 변경 → `render-complete`까지 | 프레임 시간 |
| 3. 인라인 스타일 주입 | 절반 선택 → bold/italic/color 주입/해제 | `render-complete` 프레임 시간 |
| 4. 인라인 글자크기 | 절반 선택 → fontSize 지정/수정/제거 | `render-complete` 프레임 시간 |
| 5. 정렬 변경 | `paragraphStyle.textAlign` 전환 | `render-complete` 프레임 시간 |
| 6. 분해: focus/applyInlineStyle | 각 단계의 순수 동기 시간 | setTimeout 오염 제거 |
| 7. 분해: 파이프라인 | runMap → textContent → layoutText → renderText | 단계별 동기 시간 + 캐시 히트 여부 |

**실행**:
```bash
npx tsx scripts/benchmark-browser.mjs
```
dev server(5175 → 5173 → 자동 스폰)를 자동 탐지한다. `examples/bench.html`의 `window.bench` API를 구동한다.

**측정 원칙 (이전 세션에서 학습한 함정들)**:
- `render-complete` 대기 시간은 **rAF/microtask 지연이 포함**된다 — "동기 작업 시간"과 별도 항목으로 해석
- 타이핑은 **dirty layout 정착 후(rAF 2회) 측정** — 직전 커밋의 리플로우가 다음 키 측정을 오염시킨다
- 스크립트 내 `setTimeout`이 타이밍 윈도우 안에 있으면 측정 오염 — 시나리오 6/7은 rAF 대기 없이 순수 동기만 측정

**판정 기준**: 60fps 프레임 예산 **16.7ms** (p95). 현재 기록 (2000자 문단, 3컬럼):

| 시나리오 | p95 | 판정 |
|---|---|---|
| 타이핑 | ~9ms | ✓ 60fps |
| 오버랩 이미지 이동 | ~14ms | ✓ 60fps |
| 인라인 스타일 주입 | ~12ms | ✓ 60fps |
| 정렬 변경 | ~10ms | ✓ 60fps |
| 인라인 글자크기 | ~22ms | 1회성 액션 (라인 수 변화 → 구조적 비용) |

---

## 정합성 검증

**최적화/버그 수정의 커밋 조건**: 아래 검증들이 모두 통과해야 한다. 측정 개선은 "정합성이 깨지지 않은 상태에서의 개선"일 때만 의미가 있다.

### `snapshot-layout.mjs` — 엔진 배치 결과 byte 비교 (Node)

**목적**: 리팩터링 전후 **엔진 출력이 byte 단위로 동일**한지 검증. 시드 고정 텍스트 5개 시나리오의 `columnContents` + `overflow`를 직렬화한다.

**실행**:
```bash
npx tsx scripts/snapshot-layout.mjs > /tmp/opencode/snapshot-after.json
diff /tmp/opencode/snapshot-before.json /tmp/opencode/snapshot-after.json
# → 출력 없으면 IDENTICAL
```

**사용 시점**: 엔진 코드(`paragraph-engine.ts` 등)를 건드리는 모든 변경. **주의**: 엔진 출력만 검증하므로 DOM 재사용 경로(`renderText` diff)의 결함은 잡지 못한다 — `verify-dom-diff`를 함께 실행.

**한계**: 스냅샷 시나리오에 포함되지 않은 케이스(trailing `\n`, 멀티컬럼 흐름)는 검증 못함 — 버그 수정 시 해당 시나리오를 관련 verify 스크립트에 추가할 것.

### `verify-dom-diff.mjs` — DOM 렌더 정합성 (브라우저)

**목적**: 엔진이 계산한 텍스트와 실제 렌더된 DOM이 일치하는지. 스냅샷이 커버하지 못하는 **DOM 재사용/diff 경로**를 검증:

1. **fontSize 5/6/undefined 주입·수정·제거** — 라인 수 변화(25→28→31→25)가 diff 렌더에서 정확히 반영되는지
2. **타이핑 + wrap 경계 혼합** — 줄바꿈 발생 키스트로크의 span 재배치
3. **trailing `\n`** — 문단 끝 엔터의 빈 라인 렌더, 커서 폴백, extractData round-trip 보존
4. **span 무결성** — `data-source-offset` 단조 증가, 무중복
5. **커서 rect 조회** — mapper가 DOM 재사용 후에도 올바른 span을 찾는지

**검증 방식**: DOM 가시 텍스트(라인별) === 엔진 가시 텍스트(strip 규칙 반영). **주의 — 오탐 교훈**: 엔진 `part.content`는 `string[]`(글자 배열)이므로 `join('')` 필요, 첫/마지막 파트의 leading/trailing space strip 규칙을 renderText와 동일하게 적용해야 한다.

**dev server 방어 (포트 오인 사고 교훈)**: 포트만으로 서버를 판별하면 **다른 앱의 Vite 서버**(예: `apps/layout-ui`, 5173)를 layout-element 서버로 오인한다 — SPA fallback이 존재하지 않는 경로에도 앱 index를 200으로 반환하므로 `res.ok`로는 판별 불가 (실제 사고: BENCH_READY 타임아웃 30초, `x-layout-document` null TypeError). probe는 **HTML title까지 검증**(`Layout Element Benchmark`)하고, 어느 포트에도 정상 서버가 없으면 **자체 스폰**(포트 5198) 후 종료 시 정리한다.

**실행**:
```bash
npx tsx scripts/verify-dom-diff.mjs   # ALL PASS / exit 1 (서버 없으면 자동 기동)
```

### `verify-visual-render.mjs` — 실제 화면 렌더 검증 (브라우저)

**목적**: `verify-dom-diff.mjs`는 DOM↔엔진 **데이터** 일치를 보지만, **데이터는 있는데 화면에 안 보이는** 결함 클래스는 잡지 못한다. 실제 회귀 사례: M-1 수정이 box `inheritStyle` 캐스케이드를 억제하면서 단락의 자체 `layout()`이 생략 → 호스트 CSS `:host` rule이 `width: 0mm`에 고정 → span 수천 개가 존재해도 화면에 텍스트 없음 (데이터 비교로는 무장애 통과).

이 스크립트는 `getBoundingClientRect()`(실제 레이아웃 결과) 기반으로 검증한다:

1. **A. 단락 표시성**: 내용 있는 단락 전부 화면에 표시 span 존재 (3단 본문 회귀 감지)
2. **B. 멀티컬럼**: 컬럼 수 === 엔진 `columnContents` 수, 각 컬럼에 화면 텍스트
3. **C. 호스트 CSS 정합**: 내용 있는 단락의 `:host` rule width ≠ `0mm`, rule ↔ 실제 rect 정합 (M-1 회귀 직접 감지)
4. **D. 표 셀**: 각 td의 셀 단락이 화면에 텍스트
5. **E. 타이핑 체인**: 입력 1글자 → textarea 커밋 → 새 span 화면 rect (렌더 체인 실측)

**판별 원칙**: 스팬 존재가 아니라 **비어있지 않은 화면 사각형**이 기준 — 사용자가 "본다"는 것의 프로그래밍적 정의.

**dev server 방어 (포트 오인 사고 교훈)**: `verify-dom-diff.mjs`와 동일한 2중 방어 — probe가 HTML title(`Layout Element Demo`)까지 검증해 타 앱 Vite 서버의 SPA fallback 200을 걸러내고, 정상 서버가 없으면 **자체 스폰**(포트 5197) 후 종료 시 정리한다. 실제 사고: layout-ui 서버(5173)를 잡아 A-D 시나리오가 "0개 요소"로 공허하게 통과하고 E 시나리오에서 `editManager` null으로 폭발 — 요소가 없으면 **통과가 아님**에 주의.

**실행**:
```bash
npx tsx scripts/verify-visual-render.mjs   # ALL PASS (서버 없으면 자동 기동)
```

### `verify-ime.mjs` — 한글 IME 조합 정합성 (브라우저)

**목적**: IME 조합 최적화(조합 중 렌더 지연, optimistic span) 후에도 조합 동작이 정확한지:

1. 조합 중 optimistic span 존재 + 커서 위치
2. 조합 커밋 후 DOM === 엔진 (`한`, `한글` 연속)
3. **조합 취소(compositioncancel) 원상 복원**
4. 영문+한글 혼합 시퀀스 (`한글abc력xy`)
5. 조합 중 엔진 dirty 유지, 커서 매핑

**이벤트 시뮬레이션**: Playwright는 OS IME를 구동하지 못해 **Chromium 실제 이벤트 시퀀스를 모방**한다: `compositionstart → (compositionupdate + input(isComposing))× → compositionend + input`. **한계**: 브라우저/IME별 이벤트 순서 차이는 커버하지 못함 — 실사용 체감 이상 시 이 시퀀스를 해당 환경에 맞춰 확장할 것.

**실행**:
```bash
npx tsx scripts/verify-ime.mjs   # 11항목 ALL PASS (서버 없으면 자동 기동)
```

**dev server 방어 (포트 오인 사고 교훈)**: `verify-multicolumn.mjs`와 동일한 2중 방어 — probe가 HTML title(`Layout Element Benchmark`)까지 검증해 타 앱 Vite 서버의 SPA fallback 200을 걸러내고, 정상 서버가 없으면 **자체 스폰**(포트 5200) 후 종료 시 정리한다. 리포트(2026-09)가 지적한 HEAD 프로브 전용 취약 3종 중 두 번째 이식 사례.

### `verify-multicolumn.mjs` — 멀티컬럼 타이핑 정합성 (브라우저)

**목적**: prefix 캐시(`_applyPrefixCache`)가 앞 단을 재사용할 때 뒷 단 재래핑 시작 위치가 정확한지. 결함이 있으면 **앞 단 마지막 글자들이 현재 단으로 당겨와 렌더**된다 (3단 문서의 2·3단 타이핑 시 "3글자 왔다갔다" 버그).

**시나리오** (신문 형태 재현 환경 — 컬럼당 18라인 × 3단 가득):
- **A**: 2단 첫 위치(컬럼 경계, 가장 취약) 타이핑 — 캐시 경로 결과 === `resetIncrementalState()` 후 전체 재래핑 결과 (DOM 바이트 비교)
- **B**: 2단 중간 타이핑
- **C**: 3단 중간 타이핑
- **D**: 2단 중간 백스페이스 (삭제 경로)

**중요 — 벤치마크 맹점 교훈**: 기존 bench 문단(높이 500mm)은 텍스트가 **1단에만** 들어가 멀티컬럼 흐름을 테스트하지 못했다. 이 스크립트는 `paraBox.height = 18`(라인 수)으로 축소해 실제 3단 흐름을 만든다. 멀티컬럼 관련 검증은 반드시 이 재현 환경을 사용할 것.

**dev server 방어 (포트 오인 사고 교훈)**: `verify-hanging-punctuation-browser.mjs`와 동일한 2중 방어 — probe가 HTML title(`Layout Element Benchmark`)까지 검증해 타 앱 Vite 서버의 SPA fallback 200을 걸러내고, 정상 서버가 없으면 **자체 스폰**(포트 5198) 후 종료 시 정리한다. 실제 사고: layout-ui 서버(5173)를 잡아 BENCH_READY 타임아웃 30초.

**실행**:
```bash
npx tsx scripts/verify-multicolumn.mjs   # 15항목 ALL PASS (서버 없으면 자동 기동)
```

### `verify-inline-metrics.mjs` — 인라인 letterSpacing/widthRatio/spaceRatio 전 파이프라인 (엔진)

**목적**: `TextInlineStyle`의 자간/장평/공백비율 런 오버라이드가 전 소비 경로에 반영되는지 — 폭 계산(`getCharWidths`), 배치(줄바꿈 위치), 레이아웃 캐시 해시 무효화, `printPostData` 글자별 추출, `extractData` round-trip, 커서 스타일 조회(`getEffectiveStyleAt`/`getCommonStyleInRange`), 런 맵 병합/해제 판정. 런 필드만 변경됐을 때 `_layoutCache` 해시가 stale 히트로 재래핑을 생략하면 print/화면이 옛 배치를 유지하는 버그 클래스를 방어한다.

**검증 항목** (47항목):
1. 폭 공식 — 오버라이드 `swidth === rawWidth × widthRatio + letterSpacing × fontSize`, 공백 `spaceRatio × fontSize × widthRatio + letterSpacing × fontSize`
2. 배치 — 폭 증가 오버라이드 런이 더 많은 라인 생성 + 배치 폭 합계 ≤ 파트 폭
3. 캐시 해시 — 런 widthRatio 변경 시 재래핑(라인 수 변화), 동일 입력 재주입은 캐시 히트
4. printPostData — 오버라이드 런 글자의 widthRatio/letterSpacing/spaceRatio가 런 값, plain 런은 문단 기본
5. extractData — 런 스타일 3개 필드 round-trip 보존
6. 스타일 조회 — 커서/범위 공통 스타일이 per-run 값 오버라이드, 혼합 범위는 상이 필드 제외
7. 런 맵 병합 — 3개 필드 값 상이 인접 런 미병합, 동일 스타일 병합
8. normalizeRunMap — 문단 기본과 동일한 런 해제, 상이 필드 존재 시 유지
9. **오버랩 파트 분할** — 오버랩 라인 자유 영역 좌/우 파트 분할 + 좌측 파트 배치 폭 ≤ 파트 폭
10. **오버랩 × 런 widthRatio 확대** — 확대 폭으로 배치해도 모든 파트 폭 준수 + visible 글자 오버랩 영역 0교차
11. **좁은 자유 영역 × 큰 런 폭** — 자유 영역 < 런 글자 폭이면 COVER 처리(오버랩 요소 위 글자 넘침 방지), 오버랩 밖 라인 정상 배치

**실행**:
```bash
npx tsx scripts/verify-inline-metrics.mjs   # 47항목 ALL PASS
```

### `verify-style-revert.mjs` — 인라인 스타일 회귀 주입 범위 (브라우저)

**목적**: `_applyTextStyle`이 문단 상속값과 동일한 값을 주입받을 때(상속 회귀), **적용 범위가 편집 상태에 맞는지** 검증한다. 이력: 회귀 주입이 편집 분기와 무관하게 전체 런 맵에서 필드를 제거해, "문단 fontSize 4 + 런 fontSize 6" 상태에서 런 일부에 4를 주입하면 **런 전체는 물론 다른 런의 오버라이드까지 사라지는** 버그가 있었다.

**시나리오** (7개 인라인 필드 × 6 assertion = 42항목 — fontSize, fontWeight, fontStyle, color, letterSpacing, widthRatio, spaceRatio):
- **selection 경로**: 선택 영역만 회귀 — 선택 밖 런 오버라이드 보존
- **selection 없음 (커서 런 안)**: 전체 런 회귀 (기본 복원 — 의도적 동작). 구 규칙(런 단위 "그 런만" 회귀)은 제거되었다 — `isCascadePath = !hasSelection`으로 캐스케이드 통일 (docs/EDITING_TEXT.md §6A)
- **캐스케이드**(커서가 런 밖): 전체 런 회귀 (기본 복원 — 의도적 동작)
- 무관 필드 런(fontWeight 마커)이 회귀 주입에서 영향받지 않는지

**검증기 작성 주의 (이 세션의 오탐 교훈)**: `focusParagraph(cursorOffset)` → `setCursor`는 **selection을 clear하지 않는다** — selection 시나리오 후 커서 시나리오를 실행하려면 `_cursorModel.selection = null`을 명시해야 분기가 독립적으로 진입한다.

**실행**:
```bash
npx tsx scripts/verify-style-revert.mjs   # 42항목 ALL PASS (7개 인라인 필드, 서버 없으면 자동 기동)
```

**dev server 방어 (포트 오인 사고 교훈)**: `verify-multicolumn.mjs`와 동일한 2중 방어 — probe가 HTML title(`Layout Element Benchmark`)까지 검증해 타 앱 Vite 서버의 SPA fallback 200을 걸러내고, 정상 서버가 없으면 **자체 스폰**(포트 5201) 후 종료 시 정리한다. 리포트(2026-09)가 지적한 HEAD 프로브 전용 취약 3종 중 세 번째 이식 사례.

### `verify-pending-style.mjs` — pending style 라이프사이클 (브라우저)

**목적**: 커서 상태의 툴바 스타일 변경이 pending으로 보관되고, 이후 입력에 적용되는 전 라이프사이클을 검증한다. 특히 **blur → 같은 위치 재포커스 시 pending 유지** 계약(§4.1.7)을 회귀 방어한다 — 버그 이력: `setCursor`가 이동 전 오프셋 비교 없이 `_releasePendingOnCursorMove`를 무조건 호출해, blur 복원(`focusParagraph` 커서 복원) 시 pending이 소실되었음. 수정은 `_releasePendingIfCursorMoved` 가드(이동 전/후 오프셋 동일 시 유지)로 이루어졌다.

**시나리오** (12개 그룹 31항목):
- **A. 설정/조회**: `setPendingNextStyle` → `pendingNextStyle` 조회, 명시적 `undefined` 해제, 재설정 시 `_lastStyleJson` 리셋 (이후 styleChange dedupe 생략 방지)
- **B. blur 재포커스 유지 (핵심)**: blur 직후 커서 보존 → 같은 오프셋 재포커스 시 pending 유지 → 유지된 pending이 타이핑 런(`textInlineStyle.bold`)으로 삽입 → 삽입 직후에도 유지 (연속 타이핑)
- **C. blur → 다른 오프셋 재포커스**: 실제 커서 이동이므로 해제
- **D. mousedown**: 같은 위치(span mid-point 우측 클릭 → +1 규칙) 유지 / 다른 위치 해제
- **E. 화살표 키 이동**: 해제
- **F. selection 형성**: 해제 (pending은 "앞으로 입력될 텍스트"에만 의미)
- **G. pendingBaseStyle**: pending 없으면 현재 삽입점 유효 스타일(시드용), 있으면 currentStyle과 동일
- **H. 붙여넣기**: paste 텍스트가 pending 런으로 삽입
- **I. 커서 이동 해제 후 styleChange 발화**: 툴바가 커서 유효 스타일로 복귀
- **J. 커서 상태 토글 단축키 (§4.1.6)**: Ctrl+U pending 설정(기존 런 무변경)/`pendingStyle` 페이로드/ON-OFF 반복/타이핑 런 적용, Ctrl+Shift+X/O(breakline/outline), selection 상태 런 즉시 토글(pending 미설정), 삽입점 유효 ON + pending 없음 → pending 생성 안 함, pending ON 토글 → 해제
- **K. 커서 상태 증감 단축키 (§4.1.6, InDesign 타이핑 속성)**: Ctrl+Shift+. pending fontSize 증감(기존 런 무변경)/증감 왕복 값 보존(필드 제거 아님)/하한 클램프(SHORTCUT_MIN_FONT_SIZE)/`pendingStyle` 페이로드/해제 후 유효 스타일 기저 재시드/selection 상태 per-run 즉시 적용 위임(pending 미설정)/공개 API `adjustPendingMetric`

**검증기 작성 주의**: 삽입 런의 스타일 필드명은 `i.style`이 아니라 **`i.textInlineStyle`**이다 (`TextInlineData` 계약) — 이를 잘못 읽으면 pending 적용이 정상인데도 FAIL이 난다 (실측 오탐 경험). 또한 명시적 `setPendingNextStyle(undefined)` 해제는 styleChange를 발화하지 않는다 — 발화하는 해제 경로는 커서 이동 해제(`_releasePendingOnCursorMove`)뿐이다.

**실행**:
```bash
npx tsx scripts/verify-pending-style.mjs   # 31항목 ALL PASS (서버 없으면 자동 기동)
```

**dev server 방어 (포트 오인 사고 교훈)**: `verify-multicolumn.mjs`와 동일한 2중 방어 — probe가 HTML title(`Layout Element Benchmark`)까지 검증해 타 앱 Vite 서버의 SPA fallback 200을 걸러내고, 정상 서버가 없으면 **자체 스폰**(포트 5199 — multicolumn의 5198과 충돌 방지) 후 종료 시 정리한다. 실제 사고(2026-09): layout-ui 서버(5173)를 잡아 BENCH_READY 타임아웃 30초 — 초기 버전은 HEAD 프로브만으로 `res.ok` 판정이라 이를 걸러내지 못했다.

### `verify-right-indent-tab.mjs` / `verify-right-indent-tab-browser.mjs` — 좌우 밀기 탭 정합성

**목적**: InDesign의 Shift+Tab(좌우 밀기 탭) 기능 — `\t` 이후 텍스트를 파트 오른쪽 끝에 우측 정렬 — 의 엔진/브라우저 정합성 검증.

**Node 스크립트** (`verify-right-indent-tab.mjs`, 32항목):
1. 탭 파트 보존 + plain text round-trip
2. 우측 정렬 수식 (`lastRight == partWidth`, `tabOffset == partWidth - ΣpostWidths`)
3. justify 문단에서 탭 파트 비분산
4. 다중 탭 collapse
5. trailing tab offset == partWidth
6. `getCharWidths('\t').swidth === 0`
7. printPostData에서 `\t` 제외 + print 좌표 == 엔진 charOffsets
8. 오버랩 파트 내 우측 정렬 (자유 영역 끝 기준, 컬럼 끝 아님)
9. 멀티컬럼 파트 폭 내 유지

**브라우저 스크립트** (`verify-right-indent-tab-browser.mjs`, 10항목): bench.html에서 Shift+Tab 키 이벤트 → 탭 삽입, 0폭/hidden span 렌더링, 커서 위치, textarea 동기화. dev server 필요 (5175 → 5173).

**주의 — 좌표 검증 방식**: DOM `getBoundingClientRect().width`는 `scale: 0.704 1` transform이 반영된 **시각적 glyph 폭**이라 엔진의 배치 폭(`swidth`)과 다르다. 좌표 비교는 span의 `dataset.charOffset` + `dataset.swidth` (엔진 산출값)로 수행한다.

**실행**:
```bash
npx tsx scripts/verify-right-indent-tab.mjs            # Node (엔진)
npx tsx scripts/verify-right-indent-tab-browser.mjs   # 브라우저 (dev server 필요)
```

### `verify-right-indent-tab-single-source.mjs` — 탭 좌표 단일 소스 원칙 (원칙 검증)

**목적**: 엔진 우선/단일 소스 원칙 검증 — 화면 렌더링 좌표와 인쇄(printPostData) 좌표가 모두 엔진의 `_computeCharOffsets()` 단일 루틴에서 나오는지. DOM은 엔진 출력을 받아 표시만 하고, 인쇄 후처리도 동일한 charOffsets를 소비하며, 어느 쪽에서도 정렬 재계산을 하지 않는다. 이렇게 해야 **화면 편집 내역과 실제 출력 내용이 일치**한다. (탭 가이드는 DOM 전용 표시로 이 원칙에서 제외)

**정적 검증** (소스 코드 패턴):
1. `renderText`(DOM)에 정렬 재계산 공식 없음 — `offsetMm` 소스가 엔진 `charOffsets`뿐
2. `buildParagraphPrintPostData`가 `charOffsets[k]`를 소비만 하고 재계산 없음
3. `charOffsets` 쓰기는 `_computeCharOffsets` 단일 지점

**런타임 검증** (탭+긴 텍스트 재배치 후):
- DOM span `dataset.charOffset` === 엔진 `columnContents[].parts[].charOffsets` (전 span, 1e-9 허용 오차)
- `printPostData`에 탭 문자 미포함
- Node에서 print 좌표를 파트 로컬로 환산한 값 === 엔진 `charOffsets` (전 글자, 정밀 수치 비교)

**실행**:
```bash
npx tsx scripts/verify-right-indent-tab-single-source.mjs   # dev server 필요
```

### `verify-engine-node.mjs` — 엔진 Node.js 호환성

**목적**: 브라우저 API(window/document/canvas/FontFace) 없이 엔진 계층(`src/engine/`)이 동작하는지 — **엔진 우선 원칙**(엔진은 DOM을 참조하지 않는다)의 위반을 감지한다.

**실행**:
```bash
npx tsx scripts/verify-engine-node.mjs
```

엔진 코드에 DOM 참조가 추가되면 import/실행 단계에서 실패한다.

### `verify-hangul-glyph-fallback.mjs` — cmap 미등록 한글 음절 폭 폴백

**목적**: 완성형 위주 한글 폰트(KMIBMyoungjo 등)에 cmap이 등록되지 않은 음절(`핳` 등)의 측정 폭이 `.notdef` 반각 폭이 아닌 **기준 글자 `가`의 실측 폭**으로 대체되는지. 폴백이 없으면 측정 폭(반각)과 브라우저 표시 폭(폴백 폰트 풀폭)이 어긋나 글자 겹침/줄바꿈 오류가 발생한다.

**검증 항목** (25항목):
1. 미등록 음절 폭 === `가` 폭 (폴백 작동 + `.notdef` 폭이 아님 증명)
2. cmap 등록 음절은 자체 메트릭 유지 (폴백이 등록 글리프를 덮어쓰지 않음)
3. 비한글/한글 자모(U+3131, 범위 밖)는 폴백 미적용
4. 파이프라인 전체: `핳` 포함 텍스트 배치 geometry === `가` 치환 텍스트 배치 (byte 동일), justify charOffsets 균등 간격, `getCharRect` 폭 동일
5. `가` 글리프가 없는 폰트(스텁) → 폴백 포기, `minWidthMm` 회귀 방어

**실행**:
```bash
npx tsx scripts/verify-hangul-glyph-fallback.mjs   # 25항목 ALL PASS
```

### `verify-hanging-punctuation.mjs` — 걸침표 엔진 전 파이프라인 (엔진)

**목적**: `ParagraphStyle.hangingPunctuation`(행말/행두 걸침)이 금칙 교정에 우선하는 라인 경계 후처리로서 전 소비 경로에 정확히 반영되는지. 걸침은 문장부호를 **컬럼 밖**에 배치하므로 파트 밖 좌표를 다루는 최초의 기능이다 — 기대값은 모두 `getCharWidths` 런타임 실측 폭으로 구성한다 (폭 공식이 들어간 값이므로 사전 계산하면 오탐).

**검증 항목** (55항목):
1. OFF 기준선 — `undefined`/`false`/빈 객체 모두 deep equal (byte-identical 보장)
2. 행말 걸침 — 닫기 부호가 위 줄 끝으로 당겨지고 `charOffset === partWidth`. OFF(금칙)는 같은 이동을 in-flow로 수행
3. 행두 걸침 — 열기 부호가 아래 줄 앞으로 내려가고 `charOffset === -swidth`, 이후 글자 0부터. OFF(금칙)는 같은 이동을 in-flow로
4. justify — 걸침 글자를 분산에서 제외, visibleCount 기준 균등 분산
5. trailing run — 연속 닫기 부호(`).`) 전체 당겨짐 + 스택형 오프셋
6. 캐시 해시 — `hp:` 키로 토글 시 재래핑, 재토글 시 원본 복원 (stale 캐시 방어)
7-9. 소비처 — `getCharRect` 폭(swidth, 음수 방어)/printPostData 패리티/`getOffsetFromPoint` 히트 범위 확장
10. 엣지 게이트 — 오버랩 파트 라인은 걸침 스킵 + 금칙 폴백 (OFF와 deep equal)
11. 블록 경계 — `\n` 경계 쌍은 걸침 마킹만 스킵 (OFF와 deep equal)
12. prefix 캐시 — 2단계 타이핑으로 캐시 적용 경로가 전체 재래핑과 deep equal + 걸침 마킹 보존
13. API — `genColumnStyle` overflow 조건화 / `extractData` round-trip
14. 방향별 설정 — `lineEnd`만 ON이면 행두 교정은 금칙 폴백

**금칙 의미론 주의**: 금칙 패스는 위반 **부호 자체**를 이동한다 (닫기 부호를 위 줄 끝으로 in-flow 당김 / 열기 부호를 아래 줄 앞으로 내림). 계획 단계의 "이웃 글자 push-down/pull-up" 서술과 다르므로 기대값 작성 시 실제 코드(`_applyLineBreakRules`) 기준으로 검증한다.

**실행**:
```bash
npx tsx scripts/verify-hanging-punctuation.mjs   # 55항목 ALL PASS
```

### `verify-hanging-punctuation-browser.mjs` — 걸침표 ON 실제 화면 페인트 (브라우저)

**목적**: 기존 브라우저 검증(dom-diff/visual-render/...)은 걸침 OFF 상태로 동작하므로(회귀 방어), 걸침 ON의 **화면 결과** — 파트 밖 span 페인트, 컬럼/호스트 overflow 해제 — 는 별도 검증이 필요하다.

**핵심 함정**: `overflow: hidden`은 `getBoundingClientRect()`(레이아웃 기하)에 영향 없이 **페인트만 클립**한다. rect 비교로는 클리핑을 감지할 수 없고, 실제 hit-test로 확인해야 한다. 또한 `document.elementFromPoint`는 오픈 섀도우 루트 내부 히트를 **호스트로 리타기팅**한다 — 컬럼 밖 지점에서 `X-LAYOUT-COLUMN`이 반환된 것 자체가 걸침 span이 페인트되었다는 방증(클립되면 뒤의 문단/바디가 나옴)이며, 확정 검증은 `shadowRoot.elementFromPoint`로 섀도우 내부 요소를 직접 조회한다.

**검증 항목** (11항목): OFF 기준(hangs 없음 + overflow hidden) → ON 토글(부호 run 당겨짐 + 스택형 오프셋) → computed overflow visible → 걸침 span DOM(`data-char-offset === partWidth`) → 화면 rect 컬럼 밖 연장 → shadowRoot 히트 도달 → OFF 재토글 원상 복구.

**실행**:
```bash
npx tsx scripts/verify-hanging-punctuation-browser.mjs   # 11항목 ALL PASS (서버 없으면 자체 스폰 — 포트 5198)
```

### `verify-overlap-inline-fontsize.mjs` — 인라인 fontSize 오버라이드 + 오버랩 판정 rect (엔진)

**목적**: 인라인으로 큰 글자(예: 2단 인라인 영역 6mm > 문단 기본 4mm)가 섞인 컬럼에서 오버랩 회피 판정이 **per-line 렌더링 위치**(`getCharRect`/`genLineStyle`와 동일한 라인별 maxFontSize 높이 누적)에서 발생하는지. 이력: `_createLineWithParts`가 라인 rect top을 `lineIndex × baseLineHeight`(균일 가정)로 계산하던 시절, 2단 인라인 큰 글자 문단에서 회피가 실제 위치보다 위의 엉뚱한 라인에서 일어나 텍스트가 오버랩 요소 위로 덮였다.

**검증 항목** (22항목, 실측 글자 폭 기반):
1. 균일 경로 보존 — 오버라이드 없는 오버랩 문단은 기존 회피 위치·결과 유지 (스냅샷 회귀 방어)
2. 사용자 버그 재현 — 2단 big 런 + 중단 오버랩: 파트 분할이 per-line top 라인에서 발생 (균일 가정이면 한 라인 뒤에서 발생)
3. overflow 판정 per-line화 — 큰 글자 컬럼이 균일 가정보다 일찍 참 (DOM visible 판정과 동일 공식)
4. 혼합 라인 누적 top — base→big 전환 라인의 `getCharRect` top (하단 앵커 vertical offset 포함)
5. 하단 COVER + 전 visible 글자 오버랩 영역 밖 (렌더링 관점 최종)

**재현 환경 주의**: 문단은 박스 children이 **단일 객체**일 때만 ParagraphEngine으로 생성되므로 (배열이면 BoxEngine 취급), 오버랩 박스는 문단 박스와 **document 형제 박스**로 둔다. 기대값은 `getCharWidths` 실측 폭('가' 4mm→3.28mm, 6mm→4.92mm, 기본 widthRatio 1) 기반으로 계산한다 — 폭 공식(장평/letterSpacing)이 들어간 값이므로 `advanceWidth` 직접 계산으로 기대값을 만들면 오탐된다.

**실행**:
```bash
npx tsx scripts/verify-overlap-inline-fontsize.mjs   # 22항목 ALL PASS
```

### `verify-image-displayrect-cache.mjs` — 이미지 displayRect 변화 시 오버랩 재계산 (엔진)

**목적**: 이미지 오버랩 판정은 박스 rect가 아닌 **`displayRect`**(objectFit/none x/y/w/h 기반 실제 표시 영역)를 기준으로 수행하는데, `ParagraphEngine`의 `_layoutCache` 입력 해시가 displayRect를 포함하지 않으면 — objectFit 변경이나 `'none'` 모드 좌표 변경 시 박스 rect는 불변이므로 해시가 동일 → stale 캐시 히트로 **회피가 재계산되지 않는다**. 재현: displayRect가 `{20,20,60,30}` → `{30,25,40,20}`으로 변해도 레이아웃이 재사용됨.

검증 항목 (4항목):
1. objectFit cover→contain 변경 후 재레이아웃 결과 변화
2. objectFit none + x/y/w/h 명시 변경 후 재레이아웃 결과 변화
3. none 모드 개별 x setter 변경 후 재레이아웃 결과 변화 (split 라인 변화 실측)
4. displayRect 변화 시 `_computeLayoutInputHash` 변화 (캐시 무효화 메커니즘 직접 확인)

**해시 키 단일 소스**: `_computeLayoutInputHash`와 `_computePrefixHash`가 동일한 오버랩 키(`_overlayHashKey`)를 공유한다 — prefix 캐시와 전체 캐시가 일관되게 무효화되어야 하므로.

**실행**:
```bash
npx tsx scripts/verify-image-displayrect-cache.mjs   # 4항목 ALL PASS
```

### `verify-image-edit-mode.mjs` — 이미지 편집 모드 전 동작 정합성 (브라우저)

**목적**: `ImageEditController` + `EditManager` 이미지 편집 API가 전 요구사항대로 동작하는지 — 이미지 편집 관련 모든 변경(모드 시스템, 시각 피드백, Tab 순회, selection 연동)의 회귀를 방어한다. 전용 검증 페이지(`examples/image-edit-verify.html`, 이미지 2개 + 텍스트 박스 통제 환경)에서 **CDP 신뢰 이벤트**로 검증한다.

**검증 항목** (60항목, 12 시나리오):
1. **일반 모드 dblclick 진입 + 시각 피드백** — 이미지 dblclick → imageEditMode 진입, 부모 box `outline: red` + `.type-label display: none` (텍스트 포커스와 동일 패턴), 이미지 자체 파란 outline 없음/커서 move
2. **ESC 종료** — 일반 모드 진입이면 완전 종료, 레이아웃 모드 진입이면 레이아웃 복귀. 종료 시 `text-focused` 제거 + `selected` 유지
3. **드래그** — objectFit cover→none 자동 전환 (전환 시 표시 영역 스냅샷 고정, 크기 점프 없음), x/y 갱신
4. **클램핑** — 부모 contentAbsRect 밖 드래그 시 `content - w/2` 상한으로 제한
5. **휠** — 1.1배 확대 + 원본 비율 유지 + `imageResize`/`imagePropertyChange` 이벤트
6. **드래그 중 ESC 취소** — 시작 위치 복원 + `imageMove(canceled=true)` + 모드 유지
7. **Tab/Shift+Tab** — 편집 가능 이미지 순회 (포커스 + 부모 box 선택 이동)
8. **selection 이동 → 포커스 상실** — 다른 box 클릭 시 `focusedImage` 해제, 단 이미지 편집 모드는 유지 (다른 이미지 클릭으로 재포커스)
9. **텍스트 편집과 상호 전환** — 텍스트 편집 중 이미지 dblclick → 텍스트 blur + 이미지 편집 전환
10. **데이터 정합성 (3소스 일치)** — 드래그+휼 후 `DOM getter === engine.extractData === printPostData.data === document.data`의 x/y/w/h/objectFit. dirty 가드(`DirtyPendingError`)는 `ensureCommitted()` 후 읽는 계약대로. print rect가 이미지 박스 contentAbsRect 유지(크롭 컨텍스트)도 확인
11. **ESC 취소 복원값의 3소스 일치** — 취소 후 복원값이 DOM/extractData/printPostData 모두 동일
12. **오버랩 회피 갱신 (비-공허 A/B)** — 이미지가 단락을 덮으면 첫 라인이 다중 파트로 분할(회피 발생), 휼 축소+드래그로 치우면 단일 파트 회복 + 해제 영역에 print chars 복귀. **path 모드 시맨틱 주의**: 불투명 픽셀 윤곽만 회피하므로 "이미지 rect 내 char=0"은 box 모드에만 성립하는 잘못된 기대치다 (실측: 첫 라인이 이미지 왼쪽 자유 영역 0~37.6mm + 내부 틈으로 파트 분할). 모드 무관 기준으로 **파트 분할 구조**를 검증한다.

**이 스크립트가 잡은 실제 버그들 (작성 과정)**:
- **가이드 컬럼 wheel 가로채기** — `x-layout-guide-column`이 `pointer-events: auto`여서 신뢰 wheel 히트 테스트가 이미지 대신 가이드를 잡음 → `pointer-events: none` 수정. 합성 이벤트 검증으로는 발견 불가 (target을 직접 지정하므로).
- **휠 폴백 비율 역방향** — `originalWidth` 미설정 이미지의 폴백 ratio가 `h/w`였는데 `nextHeight = nextWidth / ratio`에 넣어 역수가 두 번 적용 → height 폭주 (197.5mm 폭 이미지가 height 1100mm). `w/h`로 수정.
- **Playwright `mouse.wheel` 좌표 옵션 부재** — 시그니처는 `wheel(deltaX, deltaY)`이고 **현재 커서 위치**에서 굴러간다. `{x, y}` 전달은 무시되므로 반드시 `mouse.move()` 후 호출한다.
- **path 모드 회피 오탐 (검증기 작성 교훈)** — "이미지 rect 내 char=0" 기대는 box 모드에만 성립. path 모드는 불투명 픽셀만 회피하므로 이미지 내부 투명 영역에 글자가 올 수 있다 (실측: 첫 라인이 0~37.6mm 자유 영역 + 내부 틈 2파트로 분할). 오버랩 검증은 모드 무관한 **파트 분할 구조** 기준으로 한다.
- **chars 좌표계 오탐** — `buildParagraphPrintPostData`의 char rect는 **문서 절대 mm**(`parentAbsRect.absLeft/absTop` 기준 산출). para rect를 한 번 더 더하면 2배 오프셋이 된다.

**실행**:
```bash
npx tsx scripts/verify-image-edit-mode.mjs   # 46항목 ALL PASS (서버 없으면 자동 스폰)
```

### `verify-overlap-none.mjs` — overlapMode 'none' 시맨틱 (엔진)

**목적**: `computeOverlapSizeMm`는 이미지/문단 오버랩 판정이 모두 수렴하는 **단일 관문**인데, 여기에 `'none'` 분기가 없으면 `path`+RGBA가 아닌 모든 케이스가 box 기하학 판정으로 낙하한다 — `'none'`(회피 없음) 설정이 **box 처리**되는 버그. 재현: `overlapMode: 'none'` 이미지가 라인과 겹쳐도 PART 반환.

수정: 관문에서 `'none'` → `{ direction: 'NONE', parts: [] }` 조기 반환. `BoxEngine.overlayElements`의 목록 제외와 독립적인 세이프티 넷 — 개별 setter 경로에서 목록 캐시가 stale해 `'none'` 요소가 `overlayEngines`에 남아 있어도 시맨틱이 유지된다.

검증 항목 (7항목): 순수 함수 'none'→NONE/'box'→PART, `ImageEngine.computeOverlap` 동일, end-to-end 라인 수 왕복(box 41 → none 33 → box 41).

**실행**:
```bash
npx tsx scripts/verify-overlap-none.mjs   # 7항목 ALL PASS
```

### `verify-threading.mjs` — 텍스트 스레딩 엔진 전 파이프라인 (엔진)

**목적**: `DocumentData.threads`(스레드 = story 콘텐츠 단일 소스 + 프레임 순차 feed-forward)가 전 소비 경로에서 정확히 동작하는지. 스레딩이 없는 문서와의 byte-identical 회귀를 최우선으로 방어한다.

**핵심 설계 교훈 — 지오메트리 행렬**: B1(이중 스킵)·B5(소진 조합)는 단일 시나리오를 우회 통과했다 — 프레임 용량이 잔여보다 작으면 이중 스킵이 배치를 소진시키지 않아 `visibleChars>0` 어설션이 통과한다. 스레딩은 **지오메트리 변수**(컬럼 수·높이·프레임 수·story 길이)가 결함을 은폐할 수 있는 도메인이므로 [11]은 81조합 행렬(columns×height×frames×story)에 공통 어설션 5종을 일괄 적용한다. 이 행렬이 실제로 발견한 결함: 소진 경로의 잔여 중간 프레임까지 `threadTail: true`로 마킹되어 tail이 다중 생성되는 것([8b]의 f=3 단일 시나리오는 이를 우회했다).

검증 항목 (98항목, 18그룹):
1. 비-스레드 회귀 — threads 없는 문단 tail 없음/isThreadFrame false
2. 단일 프레임 기준선 — 스레드 없는 배치와 byte-identical + overset tail
3. 2프레임 feed-forward — head tail이 next contentFrom으로 정확 전달
4. 콘텐츠 무결성 — 배치 중복 없음 + tail 체인 오프셋 정합
5. 런 슬라이싱 — 볼드 런 경계 보존(런 중간 분할 허용)
6. pull-back — story 축소 시 이후 프레임 자동 비워짐
7. extractData round-trip — head만 content 보유, 후속 프레임 생략, threads 보존
8. overset + threadTail — 마지막 프레임 잔여 tail, 중간 프레임은 소비 표시(테두리 비대상)
8b. threadTail 마킹 — 3프레임 체인의 tail 정확히 1개 + 소진 지점 contentFrom
8c. 타이핑 전파 — `relayoutThreads(sources)` 엔진 story writeback + 체인 재배치 + seam 정합(f2 첫 배치 글자 === story[tail]) + 미소속 id story 불변
9. ThreadEngine.validate — 중복 프레임/빈 스레드 필터 + **원본 identity 보존**(중복 제거 시에만 복사)
10. sliceInlineContent 엣지
11. **지오메트리 행렬** — 81조합 × 5어설션(seam 오프셋·seam 문자·단조성·커버·tail 유일성) + **이중 스킵 검출력 증명**(결함 변형에서 어설션이 FAIL함을 확인 — 어설션 자체의 검출력 증명)
12. **childrenData 삼분 계약** — undefined 주입 보존/`[]` 주입 소거/제외 재주입 선택 소거 + 잔여 엔진 identity 보존
13. **writeback 방어** — 중복 소속 프레임 first-claim-wins: 첫 thread만 갱신, 둘째 thread story 보존, 둘째 thread 프레임은 자기 story 배치 유지
14. **printPostData 패리티** — print 첫 글자 === story[contentFrom](seam print 판)/chars 전부 contentAbsRect 내부(mm)/스토리 문자 동일성(strip 규칙 포함 기대 스트림)/getCharRect === print rect(좌표 일치)/R8 로컬 오프셋 0 = story[contentFrom]
15. **스레드 단위 변경 감지 (P1-6)** — 변경 없는 재호출은 `skipped: true`로 프레임 `layoutText`를 통째로 스킵(래핑 카운터 0회 실측)/story 편집(참조 변경)·캐시 무효화(`hasLayoutCache` 소실)는 재배치/재배치 후 시그니처 수렴. 스킵 판정은 **참조 동등성**(story 참조 + contentFrom 연쇄 + hasLayoutCache) — 해시 직렬화 비용 0
16. **relayoutThreads 사이클 (P1-7)** — 첫 배치 후 연속 재호출 모두 스킵 + 배치 상태 byte 불변 (DOM render() 진입의 재실행은 제거 — unsynced 판정이 초기 로드를 방어)
17. **프레임 경계 금칙 교정 (P2-9/10)** — 위반 유도 스토리(story[tail] = 전각 닫기 부호 `」`)에서 A/B: 교정 OFF는 f2 행두금칙 위반 잔존, 교정 ON은 해소 + seam 정합(head tail === f2 contentFrom). 이동은 追い出し(prev 마지막 일반 글자와 닫기 부호를 함께 내보냄 — 라인 경계 `_applyLineBreakRules`와 동일 시맨틱). 워드 가드: prev 마지막이 워드 글자면 위반 잔존 허용(워드 무결성 > 금칙)
18. **테이블 셀 프레임 × 행 삭제 (P2-11)** — 셀 내 2프레임 스레드 체인 배치/행 삭제(라벨 시프트) 후 잔여 프레임 엔진 identity 보존 + threads 데이터로 체인 재배치 + story 배치 지속

**print 스트림 비교 주의 (오탐 방지)**: print chars는 라인 경계 공백(strip 규칙)과 탭이 제외된다 — raw story 슬라이스와 직접 비교하면 오탐이다. `printWalk` 측정 유틸이 print와 동일한 워크(overflow 게이팅 + stripRange + 탭 스킵 + source offset 누적)로 기대 스트림을 산출한다. 또한 **justify 정렬은 charOffsets 차분 ≠ swidth가 기하학적으로 정상**(분산 gap)이므로 getCharRect↔print 폭 비교는 left 정렬 문서로 수행하고, 파트 마지막 글자는 getCharRect가 커서 시맨틱(파트 잔여 폭)을 주는 사전 존재 동작이므로 폭 비교에서 제외한다.

**실행**:
```bash
npx tsx scripts/verify-threading.mjs   # 98항목 ALL PASS
```

### `verify-threading-browser.mjs` — 스레딩 화면 진실 (브라우저)

**목적**: 엔진 검증(verify-threading.mjs)이 증명하지 못하는 "화면 진실"을 검증한다. B3(엔진 트리/DOM model 이원화)·B6(타이핑 미전파·허위 테두리)는 **엔진 게터가 올바른데 DOM span이 0개인 상태**로 발생했다 — 3계층(엔진 게터 → 섀도우 DOM span → :host boxShadow)을 모두 측정해야 "보인다"가 증명된다. `examples/threading.html`(3 스레드 × 프레임 체인)에서 Playwright로 검증한다.

검증 항목 (17항목, 4 시나리오):
1. **초기 로드** — 전 스레드 프레임 `isThreadFrame` + 컬럼 수 일치(엔진↔DOM) + span 글자 수 === 엔진 visibleChars 근사(strip 편차 허용) + 배치 대상 프레임 span 존재(소진 프레임의 빈 렌더는 정상)
2. **타이핑 전파** — head `execCommand('insertText')` → story 갱신 + seam 문자 일치(f2 DOM 첫 글자 === story[f2.contentFrom]) + 체인 일치(f2.from === head tail) + 소스 프레임 편집 파이프라인 렌더 유지. **주의**: tail이 이동하지 않으면 f2 헤드가 불변인 것이 기하학적으로 정상(라인 충전률 불변 시 tail 불변) — 전파 판정은 story 성장+seam+체인의 3각 구조로 한다 (기대값 직관 오탐 방지)
3. **테두리 분기** — 중간 프레임 boxShadow에 빨간 없음 / overset 유도 후 tail만 `rgb(255,0,0)`. **주의**: overset 유도는 `doc.data` setter 경로로 — `engine.data` 직접 주입은 `doc.layout()`의 `_layoutStructure`가 DOM 캐시(`_threads`)로 되돌리므로 스레딩 story 갱신 경로가 아니다
4. **round-trip** — `ensureCommitted` → `engine.extractData` 직렬화 → `doc.data` 재주입 → threads 보존 + 프레임 체인 동등(contentFrom·visibleChars) + 배치 대상 프레임 span 존재

**측정 유틸 모듈화** (`plainOf`/`domTextOf`/`readBoxShadow`/`frameOf`/`threadFrameIds`): 측정 코드 자체의 버그(속성명 혼동, 배열 인덱싱)가 seam 판정을 오측한 실패 모드를 종지한다 — 전 시나리오가 동일 함수를 재사용한다.

**이 스크립트가 잡은 실제 버그 (작성 과정)**:
- **문서 요소 id 덮어쓰기** — `LayoutDocumentElement.data` setter가 id 없는 문서 데이터에 `genUUID()`를 자동 생성해 `this.id`를 덮어써, HTML 마크업이 부여한 `id="doc"`이 난수로 바뀌고 `document.getElementById('doc')`가 null을 반환했다. 수정: 문서 요소 자신의 id는 자동 생성하지 않는다(자식 박스/문단은 reconcile 키로 쓰이므로 유지).

**dev server 방어**: `verify-multicolumn.mjs`와 동일한 2중 방어 — probe가 HTML title(`Threading Demo — 텍스트 스레딩`)까지 검증하고, 정상 서버가 없으면 자체 스폰(포트 5202) 후 종료 시 정리한다.

**검증 항목 확장 (P1-8/P2-12/Phase 3)**: 브라우저 검증은 28항목으로 확장되었다:
5. **타이핑 스트레스 (P1-8)** — 연속 10키 타이핑으로 (a) 마이크로태스크 통합 동작 (b) flush 후 체인 dirty 전부 소진(`hasPendingChanges` 전부 false — 재진입 원천 제거) (c) 스트레스 후 seam 정합. `_flushThreadRelayout`은 `_threadRelayoutFlushing` 플래그로 재진입을 차단하고 flush 종료 시 dirty 잔존을 console.error로 assert한다
6. **IME 조합 × flush (P2-12)** — Chromium 이벤트 모방(compositionstart → update → end)으로 (a) 조합 중 `_isComposing` 유지(flush가 조합 상태를 훼손하지 않음 — `isComposing` 게이트 불필요를 실측으로 확인) (b) 커밋('한')의 story 반영 (c) 커밋 후 체인 seam 정합
7. **키보드 프레임 경계 이동 (Phase 3 — story 절대 좌표계)** — 스레드 프레임의 편집 커서는 story 절대 오프셋(mapper 통일)이다: (a) ArrowRight@head 끝 → f2 포커스 이관 + 커서 유지 (b) ArrowLeft@f2 시작(경계점) → head 이관 (경계점은 이동 방향이 소유 결정) (c) Backspace@f2 시작 → head 마지막 visible 글자 삭제 + head 이관 (d) 클릭 매핑 → 절대 오프셋(f2 첫 span = contentFrom)
8. **f2 클릭(CDP) 진입 → 실제 타이핑 — 컨트롤러 직접 파싱 경로** — `_getSourceOffsetFromEvent`가 span dataset(프레임 로컬)을 직접 파싱한다: 절대 변환이 없으면 f2 클릭이 로컬 오프셋을 커서로 주고, 타이핑이 head 영역에 삽입돼 **"커서만 이동하고 글자가 안 써지는"** 회귀가 난다 (실측 재현). 합성 dispatchEvent로는 span 히트가 재현되지 않으므로 독립 페이지 로드에서 CDP 마우스·키보드로 검증한다: (a) f2 span 클릭 → f2 편집 포커스 (b) 클릭 커서가 절대 오프셋 (c) 실제 타이핑 → f2 화면 렌더 + 포커스 유지
9. **f2 연속 타이핑 — prefix 캐시 좌표계 (비-헤드 프레임)** — `_buildPrefixCache`가 절대 캐럿과 로컬 컬럼 글자수를 비교하면 전 컬럼이 prefix로 분류돼 재배치가 0회가 된다 — **두 번째 키스트로크부터 새 글자가 화면에 안 쓰지는 회귀** (영문: 커서만 이동 / 한글: 조합 span이 커밋 순간 사라지는 플리커 = "원본으로 돌아갔다가"). (a) 영문 5자 연속 타이핑 → "abcde" 전부 렌더 (b) 한글 2단어 연속 조합 → 커밋 전부 렌더

**실행**:
```bash
npx tsx scripts/verify-threading-browser.mjs   # 33항목 ALL PASS (서버 없으면 자동 기동)
```

### `verify-print-image-overlap.mjs` — 이미지/오버랩 수정의 print 반영 (엔진)

**목적**: 화면(엔진 `displayRect`/`columnContents`)과 인쇄(`printPostData`)가 동일한 좌표를 유지하는지 — 엔진-우선 원칙의 최종 목적을 이미지/오버랩 경로에서 검증한다. 기존 print 검증(`verify-right-indent-tab*.mjs`)은 문단 텍스트 좌표만 커버했고, 이미지 displayRect(objectFit/none 좌표)와 오버랩 회피의 print 반영은 검증 공백이었다.

검증 항목 (18항목):
1. **모드별 print 좌표 === displayRect** — cover/contain/fill/none(명시 좌표, w/h 생략 원본 폴백)의 print `data.x/y/w/h`가 objectFit 계산 결과와 일치 (print는 `buildPrintPostData`가 `displayRect`에서 산출하므로 모드 시맨틱이 그대로 반영되어야 함)
2. **objectFit 변경 → print 갱신** — 개별 data setter 경로에서 print 좌표가 stale하지 않고 갱신
3. **overlapMode 'none' → print chars 관통 반영** — box(회피)는 이미지 rect 내부 char ≈ 0, none(관통)은 이미지 rect 내부에 char 존재 (회피 결과가 print chars에 그대로 반영되는지)
4. **print rect === 이미지 박스 contentAbsRect**

**실행**:
```bash
npx tsx scripts/verify-print-image-overlap.mjs   # 18항목 ALL PASS
```

### `verify-obfuscated.mjs` — 난독화 빌드 무결성

**목적**: `npm run build:obfuscate` 결과 IIFE 번들이 (1) 문법 오류 없이 실행되고 (2) `LayoutElement` 전역이 노출되며 (3) 핵심 프로퍼티가 존재하는지. Custom Elements/canvas는 헤드리스가 필요하므로 **로딩 단계만** 검증 — 렌더링은 실제 앱으로 확인.

**실행**:
```bash
npm run build:obfuscate && npx tsx scripts/verify-obfuscated.mjs
```

---

## 빌드 도구

### `obfuscate.mjs` — IIFE 번들 난독화

`npm run build:obfuscate`에서 호출됨. 직접 실행하지 않는다.

---

## 워크플로 (다른 세션에서의 활용법)

### 성능 최적화를 할 때

```text
1. npx tsx scripts/benchmark-browser.mjs        # 현재 상태 기록 (개선 전 기준선)
2. npx tsx scripts/benchmark-typing.mjs         # 병목이 엔진인지 확인
3. (엔진이면) npx tsx scripts/benchmark-hotloop.mjs  # 엔진 내부 어느 연산인지
4. 수정 구현
5. npx tsx scripts/snapshot-layout.mjs > after  # 엔진 출력 byte 동일 확인
6. npx tsx scripts/verify-dom-diff.mjs          # DOM 정합성
7. npx tsx scripts/benchmark-browser.mjs       # 개선 측정 — 전 단계 대비 수치로
```

### 렌더링/편집 버그를 수정할 때

```text
1. 재현 스크립트를 임시로 작성해 버그를 수치/DOM 상태로 capture
2. 수정 구현
3. 관련 verify 스크립트에 **재현 시나리오를 정식 추가** (임시 스크립트는 삭제)
   - 엔진 데이터 문제   → snapshot 시나리오 추가
   - DOM 렌더 문제      → verify-dom-diff 시나리오 추가
   - IME/조합 문제      → verify-ime 시나리오 추가
   - 멀티컬럼 문제      → verify-multicolumn 시나리오 추가
4. 전체 verify + snapshot + benchmark 회귀 확인
```

### 커밋 메시지에 포함할 근거 (기존 커밋 관례)

커밋 메시지에 **실측 수치**를 포함한다 (이전/후 비교 + 어떤 검증을 통과했는지):
```
perf: ... (실측: X ms → Y ms, verify-dom-diff ALL PASS, 스냅샷 byte 동일)
fix: ... (재현: 수정 전 A → 수정 후 B, verify-multicolumn ALL PASS)
```

### 과거 최적화 기록 (참고 기준선)

| 커밋 | 내용 | 결과 |
|---|---|---|
| `7e76d8c` | skeleton 캐시 키 분리 + 1-pass 파싱 | 엔진 1차 |
| `a0baa7f` | 핫 루프 최적화 (클로저 제거, 캐시 키 인라인) | 57% 개선 |
| `d149f52` | 글자 폭 2단 캐시 (문자열 키 제거) | 누적 88% (2000자 0.31ms/키) |
| `6d1890a` | span 델타 적용 + postRender 조건부 지연 | 인라인 스타일 p95 35.9→12.7ms |
| `9a0d2b0` | 정렬 변경 증분 렌더 (센티넬 보존) | 정렬 p95 31.6→12.4ms |
| `7701813` | 라인 수 변화 diff 허용 | fontSize p95 32.5→21.5ms |
| `53c8557` | 한글 IME 조합 최적화 | 조합 음절 29→8.2ms, render 80→10회 |
| `37e32b7` | prefix 캐시 `\n` 누락 수정 | 2·3단 타이핑 글자 당겨옴 버그 |
| `c11850c` | trailing `\n` 빈 블록 보존 | 문단 끝 엔터 커서 폴백 버그 |
| `2fad972` | `_columnLeftOffsets` gap 누락 수정 | 3단 오버랩 오른쪽 치우침 버그 |