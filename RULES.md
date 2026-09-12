# RULES.md — layout-element

본 파일은 코드 수정 시 반드시 지켜야 할 규칙과, 의도적 설계 결정, 피해야 할 실수를 기록한다.

---

## 1. 텍스트 레이아웃 엔진 규칙

### 1.1 `_charWidthMm()` 측정 방식

- **반드시 `glyph.advanceWidth / unitsPerEm * fontSize`를 사용할 것.** `actualBoundingBoxLeft + actualBoundingBoxRight`는 잉크 영역만 측정하여 좁은 문자(i, l, j)와 공백의 폭을 과소측정한다.
- **`minWidthMm = spaceRatio * fontSize` 하한 클램프.** 0폭 문자가 렌더링되는 것을 방지한다.
- **`rawWidth * widthRatio`를 곱하지 말 것.** `maxWidthMm = widthRatio * fontSize` 상한 클램프가 장평 비율을 반영한다. 이중 적용 방지.
- **cmap 미등록 한글 음절은 `가` 폭 폴백.** opentype.js `charToGlyph()`는 cmap에 없는 문자에 `.notdef`(반각 폭)를 반환하므로, `charToGlyphIndex() === 0`인 한글 완성형 음절(U+AC00~U+D7A3)은 기준 글자 `가`(U+AC00)의 `advanceWidth`로 대체한다. 이 폴백을 제거하면 미등록 음절(`핳` 등)이 반각으로 측정되어 화면 표시(풀폭 폴백 폰트)와 어긋나고 글자 겹침이 재발한다. `가` 글리프가 없는 폰트는 기존 `minWidthMm` 경로 유지. 검증: `scripts/verify-hangul-glyph-fallback.mjs`.

### 1.2 `genCharStyle()` 스타일 생성

- **`maxWidth`는 `${widthRatio}em`, `scale: ${widthRatio * 0.88} 1` 함께 사용.** `maxWidth`는 레이아웃 박스 너비 제한, `scale`은 글자 모양 축소. 둘 다 함께 사용해야 장평 적용.
- **`scale` 제거 금지.** 글자 모양이 축소되지 않아 장평 효과가 사라진다.
- **`minWidth` 유지:** 공백/전각 `0.5em`, 반각 `0.35em`. `fontSize`에만 비례, `widthRatio` 영향 없음.

### 1.3 `_layoutTextIntoColumns()` 무한 루프 방지

- 문자가 모든 파트 너비보다 클 경우(`charWidth > maxPartWidth`) 첫 번째 파트에 강제 배치 후 `break`. 이 가드를 제거하면 무한 루프 발생.

### 1.4 COVER 라인은 세로 공간을 차지함

- COVER 라인(이미지가 라인 전체를 덮음)은 `parts: []`이지만 라인 자체는 세로 공간을 차지한다. 버그가 아님. `scrollHeight`를 0으로 만들면 안 됨.

### 1.5 `_overlayRectsMm` 캐시 수명 주기

- `_layoutTextIntoColumns()` 시작 시 `null` 리셋.
- 첫 `_detectOverlapWithCache` 호출 시 `Map` 생성 후 모든 오버랩 요소 측정.
- 이후 동일 렌더링 사이클 내에서는 `Map.get(el)`로 재사용.
- 제거 시 라인마다 `absRect` 게터가 호출되어 성능 저하.

### 1.6 중첩 box의 이미지 참조 시 `contentElement` 사용

- `contentType === 'image'`가 `true`여도 `items[0]`이 `LayoutImageElement`가 아닐 수 있다 (`box(A) → box(B) → image(C)` 구조).
- `items[0] as LayoutImageElement` 캐스트는 잘못된 요소를 참조한다.
- **반드시 `contentElement` 게터를 사용하여 실제 image 요소를 얻을 것.** `contentElement`는 `contentType`과 동일한 재귀 경로를 따른다.
- canvas 픽셀 매핑에도 이미지 요소의 rect를 사용해야 함.

### 1.7 `_layoutCache` 보존 규칙

- `ParagraphEngine.data` setter는 `resetIncrementalState()`를 호출하여 `_layoutCache`를 null로 만든다.
- overlay 위치만 변경된 경우 `data` setter 대신 `updateOverlayContext()`를 사용하여 `_layoutCache`를 보존한다.
- `_layoutStructure()`는 구조 변경(`_perfStructureChanged === true`) 시에만 호출해야 한다.
- `updateOverlayContext()`는 `_overlayRectsMm`만 null로 리셋하고 `_layoutCache`를 보존한다.
- `_computeLayoutInputHash()`가 overlay 위치를 포함하므로, 위치가 동일하면 `layoutText()`가 캐시 hit로 O(1) 스킵.

### 1.8 static box 렌더링 높이 원칙 — 마지막 라인 line gap 제외

> **CRITICAL — 이 원칙은 드래그 클램핑, 리사이즈, containment 검사, 좌표 변환 등
> static box의 높이가 관여하는 모든 계산에서 일관되게 적용되어야 한다.
> 위반 시 "박스가 부모 하단까지 내려가지 않는" 버그가 반복적으로 재발한다.**

**원칙**: static box의 렌더링 높이 N라인 = `(N-1) * lineHeight + fontSize`.
마지막 라인의 line gap(= `lineHeight - fontSize`)은 렌더링에서 제외된다.

이는 `BoxEngine.absHeight`의 공식(`lineHeight * height - (lineHeight - fontSize)`)과 동일하며,
`ParagraphEngine._computeAlignOffsetMm`의 `contentHeightMm = (visibleLineCount - 1) * lineHeight + fontSize`와도 일치한다.

**파생 공식** — 박스의 렌더링 하단(top 기준)이 부모의 `editableTextHeight`를 넘지 않아야 할 때:

```
(top + height - 1) * lineHeight + fontSize ≤ editableTextHeight

maxTop      = floor((editableTextHeight - fontSize) / lineHeight) - height + 1
maxLines    = floor((editableTextHeight - fontSize) / lineHeight) + 1
maxHeight   = floor((editableTextHeight - fontSize) / lineHeight) - top + 1
```

**절대 금지** — 다음 공식들은 `fontSize`를 무시하여 마지막 라인의 line gap만큼
클램핑이 너무 일찍 걸리거나 containment가 너무 빡빡하게 잡힌다:

```
// WRONG — fontSize 누락
maxTop      = floor(editableTextHeight / lineHeight) - height
maxLines    = floor(editableTextHeight / lineHeight) + 1
containerLineCount = floor(editableHeight / lineHeight) + 1
```

**적용 대상** (모두 `parentModel.fontSize`와 `editableTextHeight`를 사용):

| 위치 | 계산 | 올바른 공식 |
|---|---|---|
| `layout-edit-controller.ts` `_computeNewPosition` | `maxTop` (드래그 이동) | `floor((editableTextHeight - fontSize) / lineHeight) - height + 1` |
| `layout-edit-controller.ts` `_computeNewSize` | `maxLines` (리사이즈) | `floor((editableTextHeight - fontSize) / lineHeight) + 1` |
| `static-grid-containment.ts` `clampStaticToContainer` | `containerLineCount` | `floor((editableTextHeight - fontSize) / lineHeight) + 1` |
| `static-grid-containment.ts` `staticGridContains` | `containerLineCount` | `floor((editableTextHeight - fontSize) / lineHeight) + 1` |

**새 코드 작성 시 체크리스트**:
- [ ] static box 높이 계산에 `fontSize`가 포함되어 있는가?
- [ ] `editableTextHeight`를 사용하고 있는가? (`editableHeight`가 아님 — 전자는 padding 제외 전체 높이, 후자는 lineHeight 배수로 버림된 값)
- [ ] 드래그/리사이즈/containment/삽입/재배치(reparent) 중 하나라도 static 좌표를 다룬다면 위 표의 공식을 적용했는가?

### 1.9 걸침표(hanging punctuation) 패스 불변식

- **걸침 패스 → 금칙 패스 순서와 skip set**: `_applyHangingPunctuation()`는 `_applyLineBreakRules()` **직전에** 실행되고, 교정한 페어 키(`${col}:${lineIdx}`) 집합을 반환한다. 금칙 패스는 이 집합(`skipPairs`)의 페어를 재교정하지 않는다. 이 순서/위임을 깨면 금칙 이동이 걸침 마킹(`hangs`)을 훼손하거나 같은 페어를 두 번 교정한다. prefix 캐시 경로(`_applyPrefixCache`)에도 동일 배선이 필요하다.
- **엣지 게이트는 컬럼 경계로**: 걸침은 마지막 파트의 절대 우측 끝 === 컬럼 폭(행말)/첫 파트 `left === 0`(행두)일 때만 허용한다. `part.left`는 이후 파트에서 **갭 상대값**이므로, 우측 끝 판정은 반드시 `Σ(모든 파트 left) + Σ(모든 파트 width)` 누적 공식으로 한다 — 마지막 파트만 더하면 오버랩 파트 라인에서 오탐.
- **`hangs`는 raw content 인덱스 평행 배열**: `inlineStyles`와 동일한 인덱싱. 라인 경계 후처리(걸침/금칙)에서 `content`를 `push`/`pop`/`shift`/`unshift`할 때 `hangs`와 `inlineStyles`를 항상 함께 이동해야 한다. 하나라도 빠지면 걸침 마킹이 한 칸 어긋나고 `_computeCharOffsets`/`getCharRect`가 잘못된 글자를 걸침으로 처리한다.
- **걸침 글자의 폭은 offset 차분 금지**: 걸침 글자의 `charOffsets[k]`는 파트 경계 부근/밖(partWidth 부근 이상 또는 음수)이므로 `part.width - offset`류 차분은 부호 폭의 절반만큼 어긋난다. 폭 소비처(`getCharRect`, `getOffsetFromPoint`)는 걸침 글자를 `hangs`로 판별해 `getCharWidths().swidth`로 계산한다. `buildParagraphPrintPostData`는 이미 swidth 기반이므로 변경 금지.
- **행말 걸침은 반각 돌출**: 첫 걸침 부호의 offset은 `partWidth - 0.5 × swidth` — 부호 폭의 50%만 컬럼 밖으로 나간다 (InDesign ぶら下げ二分 방식). visible 정렬 기준 폭도 `partWidth - 0.5 × w₀`로 줄어든다. run의 둘째 부호부터 전체 폭 스택형. 히트 범위/`_computeHangExtents`의 우측 돌출량은 run 폭 합에서 첫 부호 폭의 절반을 뺀 몫이다. 행두 걸침('start')은 기존 전각(-swidth)을 유지한다.
- **OFF는 byte-identical**: `hangingPunctuation` 미설정/`false`/빈 객체 모두 기존 배치와 byte 단위로 동일해야 한다. 걸침 관련 코드를 건드릴 때마다 `snapshot-layout.mjs` byte 비교로 회귀를 확인한다. 검증: `scripts/verify-hanging-punctuation.mjs` (Test 1), 스냅샷 전후 비교.
- **클리핑 해제는 조건부**: 걸침 ON 시에만 `genColumnStyle`의 컬럼 overflow와 paragraph `:host` overflow가 `'visible'`로 전환된다. OFF 시 기존 `'hidden'` 방어 동작을 절대 제거하지 않는다.
- **강제 걸침(`lineEnd: 'always'`)은 마킹만 추가**: per-line 패스는 글자를 이동하지 않는다 — 페어 패스(케이스 1/2)와 달리 줄 구성/라인 수가 표준 걸침(`true`)과 동일해야 한다. 블록 마지막 줄(`endOfBlock`/`endOfText`)은 좌측 정렬 줄이므로 강제 걸침에서 **제외**한다. `'always'`는 행말 전용 확장이며 `lineStart`에는 없다. `'always'` ↔ `true` 토글 시 캐시 해시(`hp:` JSON.stringify)가 달라져 재래핑되어야 한다. 검증: `scripts/verify-hanging-punctuation.mjs` (Test 15).
- **행두금칙은 라인 폭 위반을 만들지 않는다**: 행두금칙(`isLineStartForbidden`) 1차 해소는 배치 단계 `_layoutColumnsPass`의 追い出し(직전 라인 마지막 글자를 금칙 글자와 함께 새 라인으로 내보냄)가 담당한다. 후처리 `_applyLineBreakRules`의 pull-up은 **폭 게이트**를 통과해야 하며(합친 글자 폭 ≤ 파트 폭), 초과 시 追い出し 폴백(위 줄 마지막 글자를 아래로)으로 전환한다 — 잔여 1자 파트만 기존 넘침 pull-up을 허용한다. 어떤 경로든 후처리 교정으로 **다음 줄의 파트 폭을 초과해선 안 된다** (초과 전이 방지). 검증: `scripts/verify-hanging-punctuation.mjs` (Test 2/10/11 — 라인 폭 위반 없음 어설션).
- **라인 첫 열기 부호 행두 걸침(케이스 5)은 마킹만 추가**: `lineStart` ON 시 라인 시작 파트의 첫 글자가 열기 부호면 `hangs[0]='start'`로 마킹해 좌측 밖(`-swidth`)으로 내보낸다 — 글자 이동은 없다 (열기 부호는 행두 허용이므로 배치·금칙과 무관). 가드: 첫 파트 `left === 0`, 잔여 2자 이상, 탭 제외, 케이스 1 마킹 중복 스킵. 검증: `scripts/verify-hanging-punctuation.mjs` (Test 16).

### 1.10 텍스트 스레딩(threading) 불변식

- **story 단일 소스**: 스레드(`DocumentData.threads`)의 `content`가 story 전체의 단일 소스다. head 프레임만 `textContent`로 전체를 소유하고, 후속 프레임은 `extractData`가 `content: undefined`를 반환한다 (중복 소유 → restore 시 텍스트 중복 버그 방지). 새 필드 추가 시 이 계약을 유지한다.
- **tail의 단일 소스는 라인 높이 순회**: `_captureThreadTail()`은 `columnContents`를 라인 높이 순서로 순회해 visible 라인 글자 수(`endOfBlock` 라인 뒤 `\n` 1자 포함)를 tail 시작점으로 기록한다. 배치 커서(`_layoutColumnsPass` 종료 상태)는 배치 완료 시 블록 범위를 벗어나므로 **배치 커서 기반 tail 산출은 금지** — 이 엔진의 `overflow`는 라인 높이 판정이지 배치 중단이 아니다.
- **tail 오프셋은 story plain 공간 절대값**: `overflowContentFrom` = `contentFrom + visible 라인 글자 수`. 다음 프레임의 `contentFrom`과 정확히 일치해야 한다 (체인 무중복).
- **`contentFrom > 0` 조건부 해시 키**: `_computeLayoutInputHash`/`_computePrefixHash`의 `tf:` 키는 `contentFrom > 0`일 때만 포함한다 — 비-스레딩 문단의 해시가 기존과 byte 동일해야 한다. 검증: `snapshot-layout.mjs` byte 비교.
- **`_layoutCache`에 tail 포함**: `overflowContentFrom`을 캐시에 저장하고 히트 경로에서 복원한다. 누락 시 캐시 히트 경로에서 tail이 소실되어 feed-forward가 중단된다 (실제 회귀 경험).
- **DOM content setter 가드**: 스레드 프레임(`isThreadFrame`)의 `LayoutParagraphElement.content` setter는 외부 주입을 무시한다 — story 단일 소스 계약.
- **`updateThreadContext` 변경 시 캐시 무효화**: `contentFrom`/`isThreadFrame` 변경은 배치 입력의 변화이므로 `_layoutCache`/`_prefixCache`를 무효화한다.
- **스레드 없으면 no-op**: `_layoutThreads()`는 threads가 없으면 즉시 반환한다. 모든 스레딩 코드 경로는 threads 존재 게이트를 유지해야 한다. 검증: `scripts/verify-threading.mjs` (55항목).
- **중간 프레임 overflow는 오류가 아니다 (`isThreadTail`)**: 스레드 중간 프레임의 overflow는 다음 프레임으로 흘러 소비된다. 빨간 테두리(`_hasOverflow`)/`render-error`는 `isThreadTail === true`(체인 마지막 또는 소진 지점)에서만 발동한다. 기본값 `true`로 비-스레드 프레임의 기존 동작을 보존한다. DOM 게이트를 제거하면 모든 스레드 프레임에 허위 테두리가 표시된다.
- **타이핑 전파는 story writeback으로**: 편집 프레임의 `model.textContent`가 story의 새 진실이다 — `DocumentEngine.relayoutThreads(sourceFrameIds)`가 `_writebackThreadStory`로 `thread.content`에 기록한 뒤 체인을 재배치한다. **story writeback은 엔진이 소유한다** (엔진-우선 원칙) — DOM 계층이 threads 데이터를 직접 mutate하면 안 된다. 편집 프레임 자체의 DOM은 편집 파이프라인이 소유하므로 재렌더 대상에서 제외한다.
- **`ThreadEngine.validate`는 원본 identity를 보존**: 중복 프레임 제거가 필요한 스레드만 복사본을 만든다. 무조건 복사하면 writeback이 복사본에 기록되어 `engine.data.threads` 원본에 반영되지 않는다 (story 소실 버그). 검증: `scripts/verify-threading.mjs` [9].
- **중복 소속 프레임은 first-claim-wins (배치·writeback 동일 소속 판정)**: 한 프레임이 여러 thread에 소속되면 첫 유효 thread만 그 프레임을 소유한다 — `ThreadEngine.validate`(데이터 정합성)와 `layoutThreads`(배치 소유권 확정)과 `DocumentEngine._writebackThreadStory`(story 기록)가 동일한 소속 판정을 사용해야 한다. 하나라도 다르면 (a) 다른 thread의 story가 head textContent로 덮어써지거나 (b) 편집 writeback이 다른 thread의 story를 오염시킨다 (실측 재현: verify-threading [13]). 검증: `scripts/verify-threading.mjs` [13].
- **BoxEngine `childrenData` 삼분 계약**: `childrenData` setter/`layout(ctx)` 주입값의 의미는 3분기다 — **`undefined` = 보존** (DOM `_rawData()` 경로가 children을 의도적으로 제외하므로 이미 구축된 자식 엔진—스레드 프레임 포함—을 유지한다) / **`[]` = 명시적 소거** (childEngines를 비운다) / **데이터 주입 = 구축·재사용** (id 키 reconcile). 이 가드는 `=== undefined`로 판정한다 — falsy 체크(`!childrenData`)는 `[]` 소거를 보존으로 오분류해 자기 계약을 위반한다 (실측 재현: verify-threading [12]). 소거의 실제 경로는 문서 레벨 `[]` 주입이 아니라 **박스 제외 재주입**(DOM `removeChildData` 등가)이다. 새 가드는 자기 경계의 반대 시나리오(소거)를 반드시 같이 테스트한다. 검증: `scripts/verify-threading.mjs` [12].
- **소진 경로의 threadTail은 마지막 프레임에만**: story 소진 시 잔여 프레임은 `contentFrom = storyPlainLen`으로 빈 배치를 확정한다. 이때 `threadTail`은 **마지막 프레임에만** 마킹한다 — 소진 잔여 중간 프레임까지 `true`로 마킹하면 체인에 tail이 여러 개 생겨 "tail 정확히 1개" 계약이 깨지고 테두리가 여러 프레임에 표시된다 (지오메트리 행렬이 발견: frames≥3 × 소진 조합). 검증: `scripts/verify-threading.mjs` [11] (행렬 어설션 5).
- **스레드 단위 변경 감지는 참조 동등성**: `ThreadEngine`은 스레드당 마지막 배치 시그니처(story 참조 + contentFrom 연쇄)를 기록하고, 재호출 시 **참조 비교**(textContent 참조 + contentFrom + `hasLayoutCache`)로 재배치를 스킵한다. `layoutText()`의 내부 캐시 히트조차 해시 구성에 story 전체 직렬화 비용을 지불하므로(R3), 입력 불변 스킵은 `layoutText` 호출 자체를 건너뛴다. 캐시 무효화 경로(data setter의 `resetIncrementalState`)가 `hasLayoutCache`를 지우므로, 캐시 존재가 "지오메트리·스타일·오버랩·story 모두 불변"의 증명이다. 검증: `scripts/verify-threading.mjs` [15] (래핑 카운터 0회 실측).
- **텍스트 파생 캐시는 참조 단위 공유 — 주입 배열 in-place 변이 금지 (R-T1/T3)**: 해시의 텍스트 직렬화(`_textContentDigest`), `plainText` 플래트닝, `_parseContents` 결과는 **정적 WeakMap에 소스 참조 단위**로 캐시한다. 스레드 체인의 전 프레임이 동일 스토리 참조를 소유하므로 체인당 1회만 O(N) 작업을 수행한다 — 인스턴스 캐시는 `textContent` setter마다 무효화되어 체인에서 F×O(N)으로 증폭된다(실측: 캐시 히트 재매핑 체인 Σ 6.12ms → 0.02ms). 전제는 **내용 변경은 항상 새 참조 주입**(편집 파이프라인이 새 배열/문자열을 만들어 주입 — 현재 코드베이스 계약)이며, 주입 배열을 소비자가 in-place 변이하면 다이제스트·파싱·플래트닝이 stale해진다. 이 전제는 기존 `_parsedContentsCache`/`_plainTextCache`가 이미 사용하던 참조 동등성 전제와 동일하다. 비-스레딩 문단은 동일 입력에 캐시 히트만 반복하므로 해시가 byte 동일하다. 검증: 스냅샷 byte 동일 + `verify-threading.mjs` [15](e).
- **캐시 히트 재매핑은 same-ref 게이트 (R-T2)**: `_layoutCache`는 `textContentRef`와 effective 스타일 참조(`effTextStyleRef`/`effParagraphStyleRef`)를 함께 저장하고, 히트 시 전부 동일 참조면 `_refreshInlineStylesOnly`(O(placed) 스트림 재매핑 + 장식 재계산)를 생략한다. 해시 일치만으로는 불충분하다 — `tf:` 키가 `contentFrom > 0` 조건부라 비-헤드 프레임은 소스 참조가 달라도 해시가 동일할 수 있고, 굵기·색상 같은 해시 무영향 스타일 변경은 effective 게터가 새 병합 객체를 만들어 effective 참조만 바뀐다. 참조 미저장 캐시는 `undefined !== value`로 안전 폴백(재매핑 실행)한다. 게이트가 stale을 만들지 않는 것은 `verify-threading.mjs` [15](e)가 증명한다 (해시 무영향 스타일 변경 → 재매핑 강제 + inlineStyles 최신화).
- **스레드 프레임 조회는 배치 조회로 — id→engine 맵 캐시 금지 (P2-2)**: 체인 배치(`ThreadEngine.layoutThreads`의 `batchLookup`)·DOM 동기화(`_syncThreadFramesToDom`)·flush는 `DocumentEngine.findEnginesByIds(ids)`로 트리를 **1회만 순회**해 전 프레임 엔진을 수집한다. generation 기반 id→engine 맵 캐시는 금지다 — `_removeBoxFromParent` 등 엔진 트리 변이 경로 중 generation을 증가시키지 않는 직접 splice가 있어 무효화 누수로 stale 엔진을 반환할 수 있다. 배치 조회는 순회 순서·첫 일치 우선 시맨틱이 `findEngineById`와 동일하므로 조회 결과가 동등하다. 검증: `verify-threading.mjs` 전 시나리오(체인 seam·identity).
- **overset 소비 상한은 중간 프레임 한정 (P2)**: 스토리가 체인 용량을 초과하면 중간 프레임의 배치 패스가 잔여를 전부 방문해 `overflow++`로 카운트한다 — 프레임당 O(N)이 체인에서 F×O(N)으로 증폭된다. 중간 프레임(`threadTail === false`이고 clamp 재배치가 아닌 프레임)은 첫 overflow 라인 생성 시점에서 배치를 종료하고(`_oversetCutFrom` 기록 — 라인 생성 루프 + 배치 루프 4사이트), `_captureThreadTail`이 cut 이후의 non-newline 잔여를 해석적으로 산출한다. **tail 프레임(`threadTail === true`)과 비-스레드 문단은 컷이 없다** — 단일 프레임 기준선(byte-identical)과 overset tail 계약이 이 경로에 의존한다. cut 후 `_overflow`는 해석 산출(잔여 non-newline + 1)로 대체되며, 소비처가 `> 0` 판정뿐(테두리 게이트는 별도 라인 순회)이므로 계약이 유지된다. clamp 재배치 프레임도 컷에서 제외다 — clamp 이후 글자는 다음 프레임 소속이라 잔여 해석이 성립하지 않는다. 검증: `verify-threading.mjs` (단일 프레임 기준선 [2] byte-identical + 행렬 [11] + print 패리티 [14]), 스냅샷 byte 동일.
- **프레임 경계 금칙 교정은 배치 입력 인코딩(출력 변이 금지)**: 프레임 배치는 독립 실행되므로 `_applyLineBreakRules`가 프레임 경계(head 마지막 visible 라인 ↔ f2 첫 라인)를 교정하지 못한다 (R7). 교정은 **`tailClampFrom`(배치 상한)을 지정해 prev를 재배치**하는 방식이다 — 배치 결과는 항상 입력의 순수 함수이고 `charOffsets`·tail·`contentFrom`이 전부 재파생되어 체인 무중복이 구조적으로 성립한다. **배치된 출력(`columnContents`)을 사후 변이하는 교정은 금지** — 과거 구현(`shiftVisibleTail`)이 `charOffsets` 평행 배열을 소거해 getCharRect/print 좌표가 x=0 폴백으로 붕괴한 실측 회귀가 있다. clamp가 배치를 제한하면 `_captureThreadTail`의 소진(-1) 판정은 우회하고 tail은 clamp 위치로 확정된다 (해시 키 `tc:`, 캐시 저장 포함). 워드 글자는 clamp하지 않는다 (워드 무결성 > 금칙). DOM flush는 교정된 prev(`correctedFrames`)를 소스 제외에서 제외하고 재렌더한다. 검증: `scripts/verify-threading.mjs` [17] (A/B + seam + **charOffsets 파생 유지·print 폴백 방어**).
- **`updateOverlayContext`는 parentWidth 변화 시 컬럼 폭을 재계산한다**: `columnWidths`는 `data` setter의 `_applyColumnGapFromData`에서만 계산된다 — 경량 갱신(`updateOverlayContext`)이 `inheritStyle.parentWidth`만 바꾸면, 초기 reconcile 시간차에 parentWidth 0으로 생성된 PE의 **음수 columnWidths((0-Σgap)/N)**가 REUSE 판정(`structureUnchanged`는 갱신된 parentWidth를 비교하므로 통과)을 우회해 영구 고착된다 — 실측 회귀: 1322자 문단이 315개 빈 라인(음수 폭)으로 렌더, verify-ime 전 항목 붕괴 (bisect: childrenData 보존 가드가 치유용 wipe 재생성을 막으면서 발화). 재계산 조건은 `oldParentWidth !== newParentWidth` — 실제 폭 변화에만 O(N) 비용을 지불한다. 검증: `scripts/verify-ime.mjs` (전 시나리오), 스냅샷 byte 비교 (비-변화 경로 무영향).
- **스레드 프레임의 편집 좌표계는 story 절대 공간**: `TextEditCoordinateMapper`의 placement·라인·컬럼 맵은 `contentFrom` 기준으로 구축된다 (비-스레딩은 0 — 항등 변환, 스냅샷 byte 방어). 렌더 span(`data-source-offset`)과 엔진 쿼리(`getCharRect`/`getOffsetFromPoint`)는 프레임 **로컬** 공간을 쓰므로 mapper가 변환을 소유한다 — 컨트롤러/호스트 API(`setCursor`·`focusParagraph({cursorOffset})`·클릭 매핑)는 **절대** 오프셋만 다룬다. 프레임 경계 이동은 `EditManager.transferCursorToOwningThreadFrame`이 소유 프레임으로 이관하고, 경계점은 이동 방향이 소유를 결정한다. IME 조합 중 이관 금지. 검증: `scripts/verify-threading-browser.mjs` [7].
- **prefix 캐시의 컬럼 경계 계산은 프레임 로컬 공간**: `caretHint`는 story 절대 plain 오프셋(계약 유지)이지만 `_buildPrefixCache`의 컬럼 글자수 누적은 로컬(0 기반)이므로 **비교 전에 `caretOffset - contentFrom`으로 환산**한다. 누락 시 절대 캐럿(f2: ≥1112)이 항상 전 컬럼 문자수보다 커서 전 컬럼이 prefix로 분류 → `startColumn === columnCount` → 재배치 0회 — **비-헤드 프레임의 두 번째 키스트로크부터 새 글자가 배치에 반영되지 않는다** (커서만 이동, 한글은 조합 span이 글자를 보였다 커밋 순간 사라지는 플리커로 나타남). 방어 2종: (a) 전 컬럼 prefix(`prefixColumnCount >= columnCount`)면 캐시 생성 거부 (b) `\n` 인덱싱·`_plainOffsetToContentsPos` 재개 위치는 `contentFrom`을 더한 절대값. 검증: `scripts/verify-threading-browser.mjs` [9] (영문 연속 타이핑 + 한글 연속 조합).

---

## 2. 편집 컨트롤러 규칙

### 2.1 마우스 좌표 저장

- 모든 mousemove 이벤트에서 `clientX`/`clientY`를 인스턴스에 저장. `requestAnimationFrame` 콜백에서 `event.clientX`를 직접 읽으면 첫 번째 이벤트의 좌표만 사용되어 빠른 드래그 시 선택 영역이 뒤처진다.

### 2.2 커서 위치 — 빈 공간 클릭

- 줄 끝 빈 공간 클릭 → 마지막 글자 뒤에 커서 위치 (`x >= rightmostRight` → `rightmostSource + 1`).
- 줄 앞 빈 공간 클릭 → 첫 글자 앞에 커서 위치 (`x <= leftmostLeft` → `leftmostSource`).
- 두 검사는 midpoint 검사 **이전**에 수행.

### 2.3 커서 높이 — 공백 문자

- 공백 문자 span은 `getBoundingClientRect().height === 0`이다.
- `rect.height <= 1`이면 `getFirstColumnRect().fontSize`를 lineHeight 폴백으로 사용.
- 커서 `top` 위치는 `_resolveFallbackTop()`으로 결정. 우선순위: 인접 가시 문자 `rect.top` → 라인 div `top` → span `rect.top` → 첫 컬럼 `top`.
- **`rect.top - cursorHeight` 사용 금지.** 라인 끝 스페이스처럼 인접 가시 문자가 모두 height≈0일 때 위 라인으로 커서가 올라가는 버그 발생.

### 2.4 라인 끝 커서 배치 — phantom end placement

- trailing space 없이 끝나는 라인의 마지막 가시 문자 다음 offset은 다음 라인 첫 글자의 offset과 동일.
- `_lineEndPlacements` 맵에 phantom end placement를 별도 저장.
- `getCursorPlacement(offset, preferLineEnd=true)`로 조회 시 라인 끝 배치 우선 반환.
- `crossRightState === 'crossed'`일 때만 `preferLineEnd=false`로 다음 라인 첫 글자 왼쪽에 배치.

### 2.5 스페이스 문자 커서 배치

- **중간 스페이스**: 커서가 스페이스 **앞**(왼쪽). `atEndOfChar: false`.
- **라인 마지막 trailing space**: 커서가 스페이스 **뒤**. `atEndOfChar: true`.
- **금지**: `placement.atEndOfChar === false`일 때 span 텍스트가 `' '`인지 검사하여 강제로 `true`로 바꾸면 안 됨. 모든 중간 스페이스를 뒤로 밀어버려 ArrowRight 시 커서가 뒤로 가는 버그 발생.

### 2.6 커서 너비

- `<x-layout-cursor>`는 고정 1px 너비. 깜빡이지 않음. 2px 이상은 인접 문자와 겹쳐 보임.

### 2.7 Zero-height span 주의사항

- 공백 문자의 span은 `height === 0`, `width ≈ 0`, `top` 값이 실제 텍스트 줄과 다름.
- 모든 좌표 계산 메서드에서 이 속성을 반드시 고려해야 함.
- `_computeVerticalOffset`: `height === 0`이면 `fontSize`를 lineHeight 폴백으로 사용. 반환값이 현재 offset과 같으면 `null` 반환 (이동 없음).
- `findVisualLineBounds`: `anchorRect.height <= 1`일 때 가장 가까운 가시 span의 `top` 사용. `lineSpans` 수집 시 `height <= 1` span 제외.

### 2.8 편집 기능 회귀 방지 — 필수 검증

편집 컨트롤러/좌표 매퍼 수정 시 브라우저에서 수동 검증:
1. ArrowLeft / ArrowRight 한 글자씩 이동
2. ArrowUp / ArrowDown 시각적 줄 단위 이동 (공백 앞/뒤에서도)
3. Home / End 시각적 줄 시작/끝 이동
4. Ctrl+ArrowLeft / Ctrl+ArrowRight 단어 단위 이동
5. 클릭으로 커서 배치 (공백 위, 줄 끝 빈 공간)
6. IME 조합 (한국어 입력)

회귀의 가장 흔한 원인: **공백 문자의 zero-height span**을 일반 문자와 동일하게 처리.

---

## 3. 엔진-DOM 동기화 규칙 (엔진 우선 원칙)

> **CRITICAL — 본 섹션의 규칙 위반은 아키텍처를 파괴한다.**
> 엔진은 향후 canvas 렌더링으로 전환되므로, DOM 의존성이 추가되면 전환이 불가능해진다.

### 3.0 엔진/DOM 경계 — 절대 규칙 (위반 시 PR 반려)

1. **엔진은 DOM을 참조하지 않는다.** `src/engine/` 내에서 `HTMLElement`, `localName`, `items`, `_rawData()`, `querySelector`, `getAttribute`, `style` 등 DOM API/요소를 사용하지 않는다. 엔진은 **순수 데이터**만 다룬다.

2. **엔진은 `_data.children`을 저장하지 않는다.** `engine.layout(childrenData)`로 자식 데이터를 **파라미터**로 받는다. `engine.data` setter는 자신의 속성만 설정한다. `_data.children`을 읽어 자식 엔진을 구축하는 것은 금지.

3. **DOM 요소는 `this._children`/`this._rows`/`this._cells`를 저장하지 않는다.** 자식 데이터가 필요할 때 `this.items.map(e => e._rawData())`로 그때그때 수집한다. 저장하면 부모-자식 간 동기화 문제가 발생한다.

4. **`engine.layout()` 시그니처:**
   - `BoxEngine.layout(ctx, childrenData, resources?, docStyle?)`
   - `DocumentEngine.layout(childrenData?)`
   - `TableEngine.layout(rowsData?)`
   - `childrenData`는 순수 데이터 배열만 허용. DOM 요소 배열(`HTMLElement[]`) 전달 금지.

5. **DOM → 엔진 데이터 전달 경로:**
   ```
   _layoutStructure()
     → engine.data = { ...ownProps }  // children 제외
     → engine.layout(this.items.map(e => e._rawData()))  // 자식 데이터만 파라미터로
   ```
   이 경로는 DOM 렌더링을 위한 **잠정적 중간 상태**다. canvas 전환 후 제거된다.

6. **엔진 → 외부 데이터 추출:** `extractData`는 `_childEngines.map(e => e.extractData)`로 자식 엔진에서 조립. `_data.children`에서 읽지 않는다.

7. **새 엔진 추가/수정 시 체크리스트:**
   - [ ] `src/engine/` 내에서 DOM import/참조가 없는가?
   - [ ] `engine.data` setter에 `children` 필드가 없는가?
   - [ ] `engine.layout()`이 자식 데이터를 파라미터로 받는가?
   - [ ] `extractData`가 자식 엔진에서 조립하는가?

### 3.1 엔진이 단일 소스 오브 트루스

- 엔진 트리가 모든 레이아웃 계산의 단일 소스다. DOM은 엔진을 보완/대체하지 않는다.
- DOM은 엔진 결과를 소비만 한다. 엔진을 생성/수정하지 않는다.
- 편집 발생 시: 편집된 내용 → `DocumentData`/`BoxData` 직렬화 → 엔진 재처리 → 결과 DOM 전파.
- DOM에서 엔진 `childEngines`을 수동으로 채우지 말 것.
- **DOM 요소는 `this._children`/`this._rows`/`this._cells`를 저장하지 않는다.** 자식 데이터는 `this.items.map(e => e._rawData())`로 그때그때 수집. 저장 시 부모-자식 동기화 버그 발생.
- **엔진은 `_data.children`을 저장하지 않는다.** `engine.layout(childrenData)` 파라미터로만 자식 데이터 수신.

### 3.2 `disconnectedCallback` — 엔진 splice 금지

- `disconnectedCallback`에서 엔진을 부모의 `childEngines`/`childBoxEngines`에서 splice하지 않는다.
- `data` setter의 ID-keyed reconcile이 `appendChild`로 자식을 재배치할 때 `disconnectedCallback` → `connectedCallback`이 같은 부모 내에서 발생. splice 시 `findBoxEngineById`가 기존 엔진을 못 찾아 새 엔진 생성 → 엔진 상태(rgbaData, _layoutCache 등) 손실.
- `DocumentEngine._buildTree()`가 전체 트리를 재구축하므로 splice는 불필요.

### 3.3 `disconnectedCallback` — 이미지 캐시 보존

- `LayoutImageElement.disconnectedCallback`에서 `_clearImageCache()` 호출 금지.
- reconcile 중 `appendChild` → `disconnectedCallback` → 캐시 삭제 → 비동기 재로딩 → 이미지 깜빡임.
- 이미지 캐시는 URL 변경(`data`/`url` setter) 또는 명시적 `_clearImageCache()` 호출 시에만 무효화.

### 3.4 `disconnectedCallback` — 커서/선택 보존

- `LayoutParagraphElement.disconnectedCallback`는 `_editController` 파괴 전 `_savedCursorOffset`/`_savedSelection`에 커서 offset과 selection을 저장.
- `connectedCallback`은 `_editController` 재생성 후 저장된 값을 복원, 그 후 저장값 클리어.
- `data` setter reconcile 중 커서 점프 방지.

### 3.5 `HOST_STYLE_ID` — style 요소 식별

- 모든 레이아웃 요소는 `HOST_STYLE_ID = '__layout_host_style__'`로 자신의 `<style>` 요소를 식별.
- `_applyStyle()`은 `querySelector('style')` 대신 `querySelector('style#${HOST_STYLE_ID}')` 사용.
- AI processing overlay가 별도의 `<style>` 요소(`OVERLAY_STYLE_ID`)를 추가. ID 기반 조회가 없으면 AI overlay style을 잡아 `:host` 규칙을 덮어씀.
- `removeAiProcessingOverlay()`도 자신의 style 요소(`OVERLAY_STYLE_ID`)를 제거하여 누적 방지.

### 3.6 `_refreshParagraphOverlays` — 모든 단락 갱신

- `overlayEngines.length > 0` 가드를 두지 않는다. 모든 단락을 갱신해야 이전에 overlay가 있었지만 현재 사라진 단락의 stale `overlayEngines`가 제거된다.
- `updateOverlayContext()`를 사용하여 `_layoutCache`를 보존. 입력 해시 동일 시 `layoutText()`가 캐시 hit.
- `TableEngine` 내부 셀 박스도 순회: `rowEngines` → `cellEngines` → `cellEngine.boxEngine` → 재귀.

### 3.7 `_buildParagraphEngine` — `layoutText()` 미호출

- `_buildParagraphEngine`은 `layoutStructure()`만 호출. `layoutText()`는 호출하지 않는다.
- `layoutText()`는 `_refreshParagraphOverlays()`에서 단일 실행.
- 이중 실행 시 첫 결과가 `resetIncrementalState()`로 버려지는 문제 방지.

### 3.8 `_buildBoxEngine` — GC 재사용

- `_gcParamsEqual()`로 기존 `GridCalculatorEngine`의 파라미터 비교. 동일 시 인스턴스 재사용, `_calcColumnGridCoords` 재실행 스킵.
- 비교 필드: `width`, `height`, `padding*`, `columns`, `gap` (`valueEqual`), `paragraphStyle` (참조 비교), `textStyle` (참조 비교), `isBox`.

### 3.9 `appendChildData` — 증분 추가

- `appendChildData()`는 `this.data = {...}` round-trip을 사용하지 않는다.
- `_appendChildData(child)` + `requestRerenderAffectedParagraphs()` — O(1) 증분 추가.
- `data` setter round-trip은 O(N) — 모든 기존 자식 reconcile + 중복 렌더링.
- `data` setter는 전체 복원(undo/redo, 외부 데이터 할당) 시에만 사용.

### 3.10 `gridCalculator!` non-null assertion 금지

- `TableCellEngine.gridCalculator`는 `GridCalculatorEngine | null` 타입. `!`로 우회하면 런타임 crash 위험.
- null-safe 분기(`parentGc = parent.gridCalculator; isStatic && parentGc ? ... : ...`)로 처리.

---

## 4. 후처리 데이터 export 규칙

### 4.1 `ColorRegistry.init()` — 스타일시트 없는 환경

- `globalThis.document?.styleSheets[0]`가 없을 때 `_ready = true` 설정, `colorMap` 반환. CSS 변수 주입은 건너뛰되 색상 데이터 접근 가능해야 함. SSR/테스트 환경에서 throw 방지.

### 4.2 모든 레이아웃 요소는 `printPostData` 게터 필요

- `LayoutDocumentElement`, `LayoutBoxElement`, `LayoutParagraphElement`, `LayoutImageElement`, `LayoutGuideColumnElement`, `LayoutTableElement`, `LayoutTableRowElement`, `LayoutTableCellElement` — 모두 `printPostData` 게터.
- 엔진 mm 좌표를 `ppm`으로 환산한 픽셀 rect + 원본 데이터. DOM `getBoundingClientRect()` 미의존.
- 새 레이아웃 요소 추가 시 반드시 구현.

---

## 5. 성능 관련 규칙

> **구현된 렌더링 최적화 인프라는 `docs/PERFORMANCE.md` 참조.**

### 5.1 `renderText` key 기반 증분 렌더링

- `data-source-offset`을 reconciliation key로 사용. 기존 span 재사용 시 `innerText`, 스타일, `data-offset`만 갱신.
- `innerHTML = ''` 사용 금지. `<style>` 요소는 재사용, CSS 룰만 갱신.
- `data-temporary` span은 diff 시작 전 제거.
- COVER 라인(`parts: []`)은 라인 div의 모든 자식 제거, 빈 div만 유지.

### 5.2 `data-source-offset` vs `data-offset`

- `data-source-offset`: 소스 문자열 위치. diff 렌더링 key.
- `data-offset`: 렌더링된 문자 위치. `EditCoordinateMapper` 클릭-to-커서 매핑용.
- 두 속성은 모든 span에 공존. 제거 시 각 기능이 동작하지 않음.

### 5.3 `EditCoordinateMapper.rebuild()` 캐시 무효화

- `rebuild()`는 `_renderedToSource`, `_sourceToRendered`, `_spanCache`, `_columnSpansCache`, `_columnRanges`, `_columnStartOffsets` 초기화.
- `postRender()`에서 호출됨. 렌더링 후 반드시 `postRender()` 호출 필요.
- `rebuild()` 없이 DOM 직접 조작 시 캐시 stale.

---

## 6. z-index 제약사항

### 6.1 레이아웃 요소 z-index 범위

- 레이아웃 요소 `zIndex`: `0 ~ 90000` (`Z_INDEX_MAX_LAYOUT`).
- `90001 ~ 99999`: 예약 범위 (편집 UI, 오버레이, 테이블 크롬 등).
- `100000` 이상 사용 금지.

### 6.2 예약 z-index 값

| 값 | 용도 | 사용 위치 |
|---|---|---|
| `91000` | 광고 역할 고정 (`role: 'ad'`) | `box.element.ts` |
| `91001` | 면머리 역할 고정 (`role: 'header'`) | `box.element.ts` |
| `99999` | 리사이즈 핸들 | `box.element.ts` |
| `99998` | 타입 라벨 | `box.element.ts`, `document.element.ts` |
| `99997` | 삽입 미리보기 오버레이 | `insert-controller.ts` |
| `9999` | 텍스트 편집 textarea (IME) | `text-edit-controller.ts` |

### 6.3 역할 기반 z-index 고정

- `role: 'ad'` → `zIndex` getter 항상 `91000` 반환. `zIndex` setter 및 `data` setter의 `zIndex` 할당 무시.
- `role: 'header'` → 항상 `91001` 반환. 동일 규칙.
- role 해제 시 `_zIndex`를 형제 중 역할 고정 값 제외한 최댓값 + 1로 복원 (`Z_INDEX_MAX_LAYOUT` 한계).
- 새 요소 생성 / reparent 시 `91000`/`91001`은 0으로 취급하여 `max` 계산.

---

## 7. 빌드 및 검증 규칙

### 7.1 빌드

- `npm run build` — Vite IIFE 빌드 + React ESM 빌드 + `.d.ts` 생성.
- 빌드 실패 시 `noUnusedLocals`/`noUnusedParameters` 확인.
- TypeScript 7 RC: `noEmit: true` — `tsc`는 타입 체크만, Vite가 컴파일.
- React 빌드는 `emptyOutDir: false` — IIFE 빌드 결과 보존.

### 7.2 테스트 인프라 없음

- 코드 수정 후 `npm run build`로 검증. 시각적 변경은 `npm run dev`로 브라우저 확인.

---

## 8. React 래퍼 규칙

### 8.1 Custom Element API 변경 시 React 래퍼 동기화

- Custom Element public API 수정 시 `src/react/components/`의 대응 래퍼도 검토/수정.

### 8.2 새 Custom Element 추가 시 React 래퍼 생성

- `src/components/`에 새 Custom Element 추가 시 `src/react/components/`에 대응 래퍼 생성.

### 8.3 공개 export 재출력 확인

- `src/types/`, `src/engine/`, `src/resource/`, `src/constants/`, `src/edit/`에 새 공개 export 추가 시 `src/react/index.ts`에서 재출력 확인.

### 8.4 React 의존성 범위 제한

- `src/react/` 외부 파일이 `react`를 import하지 않음. IIFE 빌드에 React 코드 침범 방지.
- `react`는 peer dependency (`>=19.0.0`). 번들에 포함되지 않음.

### 8.5 React 래퍼 변경 후 빌드 검증

- `src/react/` 수정 후 `npm run build` 실행. IIFE + React ESM 빌드 모두 성공 확인.