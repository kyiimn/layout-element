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
| `verify-ime.mjs` | 정합성 (IME) | 한글 조합 커밋/취소/혼합 | ALL PASS |
| `verify-multicolumn.mjs` | 정합성 (멀티컬럼) | prefix 캐시 경로 === 전체 재래핑 | ALL PASS |
| `verify-style-revert.mjs` | 정합성 (스타일) | 인라인 회귀 주입 범위 (selection/런/캐스케이드) | ALL PASS |
| `verify-right-indent-tab.mjs` | 정합성 (엔진) | Right Indent Tab(`\t`) 배치·정렬·print 스킵 | ALL PASS |
| `verify-right-indent-tab-browser.mjs` | 정합성 (브라우저) | Shift+Tab 키 삽입·DOM 렌더·커서 | ALL PASS |
| `verify-right-indent-tab-composition.mjs` | 정합성 (브라우저) | 탭 라인 한글 조합 표시·우측 정렬·이탈 방지 | ALL PASS |
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

**실행**:
```bash
npx tsx scripts/verify-dom-diff.mjs   # ALL PASS / exit 1
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
npx tsx scripts/verify-ime.mjs   # 11항목 ALL PASS
```

### `verify-multicolumn.mjs` — 멀티컬럼 타이핑 정합성 (브라우저)

**목적**: prefix 캐시(`_applyPrefixCache`)가 앞 단을 재사용할 때 뒷 단 재래핑 시작 위치가 정확한지. 결함이 있으면 **앞 단 마지막 글자들이 현재 단으로 당겨와 렌더**된다 (3단 문서의 2·3단 타이핑 시 "3글자 왔다갔다" 버그).

**시나리오** (신문 형태 재현 환경 — 컬럼당 18라인 × 3단 가득):
- **A**: 2단 첫 위치(컬럼 경계, 가장 취약) 타이핑 — 캐시 경로 결과 === `resetIncrementalState()` 후 전체 재래핑 결과 (DOM 바이트 비교)
- **B**: 2단 중간 타이핑
- **C**: 3단 중간 타이핑
- **D**: 2단 중간 백스페이스 (삭제 경로)

**중요 — 벤치마크 맹점 교훈**: 기존 bench 문단(높이 500mm)은 텍스트가 **1단에만** 들어가 멀티컬럼 흐름을 테스트하지 못했다. 이 스크립트는 `paraBox.height = 18`(라인 수)으로 축소해 실제 3단 흐름을 만든다. 멀티컬럼 관련 검증은 반드시 이 재현 환경을 사용할 것.

**실행**:
```bash
npx tsx scripts/verify-multicolumn.mjs   # 15항목 ALL PASS
```

### `verify-style-revert.mjs` — 인라인 스타일 회귀 주입 범위 (브라우저)

**목적**: `_applyTextStyle`이 문단 상속값과 동일한 값을 주입받을 때(상속 회귀), **적용 범위가 편집 상태에 맞는지** 검증한다. 이력: 회귀 주입이 편집 분기와 무관하게 전체 런 맵에서 필드를 제거해, "문단 fontSize 4 + 런 fontSize 6" 상태에서 런 일부에 4를 주입하면 **런 전체는 물론 다른 런의 오버라이드까지 사라지는** 버그가 있었다.

**시나리오** (4개 인라인 필드 × 7 assertion = 28항목):
- **selection 경로**: 선택 영역만 회귀 — 선택 밖 런 오버라이드 보존
- **커서가 런 안**: 그 런만 회귀 (런 단위 시맨틱) — 다른 런 보존
- **캐스케이드**(커서가 런 밖): 전체 런 회귀 (기본 복원 — 의도적 동작)
- 무관 필드 런(fontWeight 마커)이 회귀 주입에서 영향받지 않는지

**검증기 작성 주의 (이 세션의 오탐 교훈)**: `focusParagraph(cursorOffset)` → `setCursor`는 **selection을 clear하지 않는다** — selection 시나리오 후 커서 시나리오를 실행하려면 `_cursorModel.selection = null`을 명시해야 분기가 독립적으로 진입한다.

**실행**:
```bash
npx tsx scripts/verify-style-revert.mjs   # 28항목 ALL PASS
```

### `verify-right-indent-tab.mjs` / `verify-right-indent-tab-browser.mjs` — Right Indent Tab 정합성

**목적**: InDesign의 Shift+Tab(Right Indent Tab) 기능 — `\t` 이후 텍스트를 파트 오른쪽 끝에 우측 정렬 — 의 엔진/브라우저 정합성 검증.

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

### `verify-engine-node.mjs` — 엔진 Node.js 호환성

**목적**: 브라우저 API(window/document/canvas/FontFace) 없이 엔진 계층(`src/engine/`)이 동작하는지 — **엔진 우선 원칙**(엔진은 DOM을 참조하지 않는다)의 위반을 감지한다.

**실행**:
```bash
npx tsx scripts/verify-engine-node.mjs
```

엔진 코드에 DOM 참조가 추가되면 import/실행 단계에서 실패한다.

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