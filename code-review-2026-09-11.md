# 최근 3일 커밋 코드 리뷰 — 발견 사항 및 수정 작업 지침

> **문서 목적**: 이 문서는 2026-09-08 ~ 2026-09-11 사이에 커밋된 37개 커밋(`0c6e92a^..HEAD`)에 대한
> 코드 리뷰 결과를 기록한 후속 작업 에이전트에게 전달하기 위한 것입니다. 각 발견 사항은
> 증거(파일:라인, 커밋 해시, 실측 결과)와 함께 기록되어 있으며, §7의 작업 지침에 따라
> 수정을 진행하면 됩니다. **모든 발견 사항은 본 세션에서 실측 검증된 것입니다** —
> 추측이나 문서 해석이 아니라 소스 코드 정독, 런타임 실험, 브라우저 실측, 검증 스크립트
> 실행에 근거합니다.
>
> **주의**: 원칙 위반 여부 판정은 이 리뷰가 수행한 시점 기준입니다. 후속 작업 전에
> `git log --oneline -5`로 리뷰 시점(HEAD = 9660109) 이후 커밋이 없는지 먼저 확인하세요.

## 1. 분석 범위 및 방법

### 1.1 분석 대상 커밋 범위

- 범위: `0c6e92a^..HEAD` (base: 7cee9db, HEAD: 9660109)
- 기간: 2026-09-08 06:11 ~ 2026-09-11 00:31 (KST)
- 커밋 수: 37개, src/ 변경 +5,211줄 (docs/scripts 포함 총 규모는 더 큼)
- 규모별 주요 변경 파일:
  - `src/engine/paragraph-engine.ts` (+1,228줄) — 걸침표·워드 래핑·장식 패스·lineGapMode
  - `src/edit/text-edit-controller.ts` (+426줄) — pending style·조합 중 장식·낙관적 span 앵커
  - 신규 파일: `src/engine/line-height.ts` (93줄), `src/constants/line-break.ts` (195줄)
  - 신규 검증 스크립트 5종 (hanging 2종·line-gap-mode·pending-style·text-decoration·word-wrap)

### 1.2 기능별 커밋 그룹

| 기능            | 커밋                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 걸침표 (걸림 방지 규칙)     | 0c6e92a(타입·상수) → 9a2282b(엔진 패스) → 06af826(DOM/편집 연동) → 1089867(검증 harness) → 173facf, 6cee5e0(문서/예제) → 4f678c0(강제 모드·반각 타입) → 681efc1(강제·반각·행두 엔진) → 46c5123, 2404624(검증 확장·문서) → dc337c2(예제 토글)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 행간 고정 모드     | a43f31d (lineGapMode ratio/fixed/fixed-min + line-height.ts 단일 소스 신설)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 워드 래핑        | bf17cdd(타입·isWordChar) → b961d84(엔진 eager lookahead) → 9072196(편집 라우팅) → 0b35435(문서) → 2a1166c(검증 harness)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 텍스트 장식       | 19abf23(타입·상수) → 965879b(엔진 _computeDecorations 패스) → 8385df9(DOM/편집 연동) → 18d4e01(검증 harness) → 19c3985(문서) → ba7613c(deco.y 라인 top 기준 계약) → 58cf512(stripStart 인덱싱 수정) → 1c43756+a2be4c8(기본값 상수 주입) → 868303e(장식 색상 '' 상속 체인·undefined 키 폴백) → d6ba0c9(문단 캐스케이드 누락 수정)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| pending 스타일   | b0b3c4b(라이프사이클+캐스케이드 통일) → 09f0c2f(검증 harness) → 2d81b1a(verify-style-revert 갱신) → 4f0bc56(낙관적 span 하단 앵커) → 9660109(조합 중 장식)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 기타            | cd9c294(단축키 증감량 호스트 주입), 38f02c6/82828ca(검증 스크립트 갱신), d118d93(verify-multicolumn dev server 방어)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 1.3 검증 방법 (이 리뷰의 신뢰도 근거)

1. **소스 정독**: `paragraph-engine.ts`(4,779줄) 변경 부분 전체, `text-edit-controller.ts` 편집·조합·pending 경로, `edit-manager.ts` 캐스케이드, `run-map.ts`, `column.element.ts` 장식 렌더링, 신규 파일 2종 전체.
2. **git 아카이브 실측**: `git log -L`, `git show`로 각 발견 사항의 도입 커밋 특정.
3. **병렬 에이전트 감사 2건**:
   - 심볼 사용여부 전수조사 (최근 3일 신규 export/상수/메서드 ~50종, USED/SRC-UNUSED/DEAD 판정, UNUSED 주장은 2회 이상 교차 grep으로 이중 확인)
   - 단일소스 감사 (엔진 vs DOM/편집 레이어 기하 공식 중복, VIOLATION/JUSTIFIED-DUPLICATION/COMPLIANT 판정, file:line 인용)
4. **엔진 런타임 실험**: Node에서 DocumentEngine을 직접 구동해 word-wrap 가드 도달가능성 실측 (§5.4).
5. **브라우저 실측**: Playwright + 자체 스폰 Vite 서버로 bench.html 구동, pending style 핵심 3시나리오 실측 (§5.6).
6. **검증 스크립트 실행**: tsc --noEmit, verify-text-decoration(60), verify-word-wrap(32), verify-hanging-punctuation(82), verify-inline-metrics(47), verify-line-gap-mode(69) — 전부 통과.

---

## 2. 요약 — 발견 사항 총람

| #   | 분류              | 심각도 | 항목                                                                                                    | 커밋   | §    |
| --- | ----------------- | ------ | ------------------------------------------------------------------------------------------------------- | ------ | ---- |
| F1  | 데드코드          | 중     | `_createOptimisticSpan` 장식 블록 이중 중복 — 첫 블록 항상 소실                                            | 9660109 | 5.1  |
| F2  | 논리 결함         | 중     | 금칙 pull-up 폭 게이트가 배치 공식과 불일치 (raw 폭 합산 vs raw×widthRatio+letterSpacing)                  | 681efc1 | 5.2  |
| F3  | 단일소스 드리프트 | 중     | 조합 중 장식 색상 폴백 체인이 엔진보다 1단계 누락 (`eff.underlineColor`/`eff.breaklineColor`)               | 9660109 | 5.3  |
| F4  | 검증 인프라       | 중     | `verify-pending-style.mjs`가 dev-server 방어(제목 검증+자체 스폰) 없이 추가되어 layout-ui 서버 환경에서 실행 불가 | 09f0c2f | 5.6  |
| F5  | 데드코드          | 저     | `DEFAULT_HANGING_PUNCTUATION` 상수 전체 무참조 — 엔진이 `false` 리터럴 하드코딩                            | 4f678c0 | 5.7  |
| F6  | 데드코드          | 저     | `_pendingNextStyleKeepOnCursorMove` — `true` 설정 경로 없음(가드 도달불가)                                 | b0b3c4b | 5.8  |
| F7  | 데드코드          | 저     | `_clearCompositionUnderline`의 CSS `textDecoration` 정리 잔존 — 설정 경로가 사라져 no-op                   | 9660109 | 5.9  |
| F8  | 문서-동작 불일치  | 저     | word-wrap 가드 3종의 주석이 설명하는 `.`/`,` 시작 잔여 시나리오는 발생하지도 않고 가드도 차단 불가          | b961d84 | 5.4  |
| F9  | 유지보수 위험     | 저     | `INLINE_FIELDS` 14필드 목록 3곳 중복 — d6ba0c9가 수리한 버그가 바로 이 유형의 드리프트                      | 965879b | 5.10 |
| F10 | 사소              | 최저   | `effectiveTextStyle` JSDoc 이중 중복, `_charSwidthAt` 파라미터명 인덱스 공간 오기술                          | 868303e/965879b | 5.11 |

**엔진우선·단일소스 원칙 위반은 발견되지 않았습니다** (§6 참조). 발견 4건(F1~F4)은 수정 권장이고,
F5~F10은 정리 권장입니다.

---

## 3. 리뷰 시점 검증 상태 (수정 전 기준선)

후속 작업 에이전트는 수정 전에 이 기준선을 재확인해야 합니다. 본 리뷰 시점(HEAD=9660109)에서:

| 검증                                    | 결과    |
| --------------------------------------- | ------- |
| `npx tsc --noEmit`                      | 통과    |
| `npx tsx scripts/verify-text-decoration.mjs`  | 60/60 통과 |
| `npx tsx scripts/verify-word-wrap.mjs`        | 32/32 통과 |
| `npx tsx scripts/verify-hanging-punctuation.mjs` | 82/82 통과 |
| `npx tsx scripts/verify-inline-metrics.mjs`   | 47/47 통과 |
| `npx tsx scripts/verify-line-gap-mode.mjs`     | 69/69 통과 |
| `npx tsx scripts/verify-pending-style.mjs`     | **실패(타임아웃)** — F4 참조. 기능 자체는 브라우저 수동 실측으로 대체 검증 통과(§5.6) |

주의: Node 기반 검증 스크립트(hanging·word-wrap·text-decoration·inline-metrics·line-gap-mode)는
dev server 없이 동작하므로 언제든 실행 가능합니다. 브라우저 기반 스크립트는 dev server 의존성이
있으므로 §5.6의 주의사항을 먼저 읽으세요.

---

## 4. 준수 확인 결과 (위반 없음 항목)

아래는 의심하여 조사했으나 **문제가 없음을 확인**한 항목입니다. 후속 작업 시 재조사하지 않아도 됩니다.

### 4.1 lineHeight 단일 소스 (a43f31d)

`computeLineHeightMm`/`resolveLineGap`(`src/engine/line-height.ts`)이 모든 lineHeight 계산의
단일 소스로 동작:

- 소비처: `ParagraphEngine._initLayoutMetrics`(:405)·`_createLineWithParts`(:1479)·`_computePerLineHeights`(:1974)·`_confirmLineHeight`(:2206), `GridCalculatorEngine._calcColumnGridCoords`(:88), `DocumentEngine._documentContainerMetrics`(:579)
- grep으로 하드코딩된 재구현(`maxFontSizeMm * lineGap` 등) 부재 확인 — 유일한 공식 구현은 line-height.ts:91뿐
- `DEFAULT_LINE_GAP_MODE`/`DEFAULT_LINE_GAP_FIXED` 모두 사용처 있음
- `effectiveParagraphStyle`(:4193-4198)에서 `DEFAULT_PARAGRAPH_STYLE_NO_LINE_GAP` 스키마 + `resolveLineGap` 후보정 패턴이 배율→mm footgun 방어 계약대로 동작

### 4.2 장식 DOM 렌더링 (8385df9)

`column.element.ts:401-441` `_renderDecorationRects` — 엔진 `part.decorationRects`를 mm 값 그대로
CSS(`left/top/width/height`에 `${x}mm` 문자열)로 통과만 한다. 재계산 없음, mm→px 변환 없음
(CSS가 mm 단위를 네이티브 지원), 엔진 데이터 없을 때 폴백 합성 없음(기존 deco div 제거만).
**COMPLIANT.**

### 4.3 낙관적 span 하단 앵커 (4f0bc56)

`_getOptimisticTopMm`(text-edit-controller.ts:2275-2282)는 공식을 복제하지 않고 엔진 메서드
`model._getCharVerticalOffset(lineMaxFs, charFs)`에 **위임**한다. 폭 계산 `_computeTempSpanWidthMm`도
`model.getCharWidths().swidth` 위임, span 스타일도 `model.genCharStyleFlat` 위임.
이 커밋은 단일소스 원칙의 모범 사례로 오히려 긍정 평가할 만하다. **COMPLIANT.**

### 4.4 printPostData decorations (965879b)

`buildParagraphPrintPostData`(paragraph-engine.ts:4728-4766)가 엔진 rect에서만 조립.
DOM은 print 좌표에 관여하지 않음. **COMPLIANT.**

### 4.5 d6ba0c9 문단 캐스케이드 누락 수정

`_applyParagraphLevelStyle`의 런 스탬프 조건을 INLINE_FIELDS 전체 검사로 확장한 수정 자체는
element setter 경유 + 엔진 effective 비교 기준 유지로 원칙 준수. 단, 이 수정이 드러낸 구조적
문제는 F9로 별도 기록.

### 4.6 걸침표·금칙 엔진 패스 구조 (9a2282b, 681efc1)

`_applyHangingPunctuation`(:700) → `_applyLineBreakRules(skipPairs)`(:1676-1677) →
`_computeDecorations`(:1680) 순서와, 전체/캐시히트(:1758)/prefix(:1937) 3경로 모두에서
장식 패스가 호출되는 구조는 정합. `hangs` 마킹과 `charOffsets` 제외 처리, skip set 전달도
설계 계약(TEXT_ENGINE §23)과 일치. 단, 폭 게이트 공식은 F2로 별도 기록.

---

## 5. 발견 사항 상세

### 5.1 [F1 · 중] `_createOptimisticSpan` 장식 블록 이중 중복 — 데드코드

- **위치**: `src/edit/text-edit-controller.ts:2316-2326` (데드) / `:2336-2343` (유효)
- **도입**: 9660109 "fix: 조합 중 장식 스타일 미반영 수정"
- **내용**:

```
2316    if (model) {
2317-2326  // "엔진 _computeDecorations와 동일 규칙(두께/y/색상)으로 선 div를 그린다" 주석
             // → _applyOptimisticDecorations(span, lineMaxFs, inlineStyle) 호출
2331    span.textContent = char;      ← textContent 할당이 자식 노드 전체를 교체
2336    if (model) {                  ← 동일한 판정·동일한 호출이 반복됨 (유효 경로)
2341      _applyOptimisticDecorations(span, lineMaxFs, inlineStyle);
2343    }
```

- **근거**: `span.textContent = char`는 기존 자식 노드를 전부 교체하므로, 첫 블록이 `span.appendChild`로
  붙인 장식 div(`opt-underline`/`opt-breakline`)는 다음 줄에서 **항상 폐기**된다. 두 번째 블록의
  주석(":2332-2335")이 스스로 그 원인을 설명한다 ("textContent **이후에** 적용한다 — 먼저 붙인
  장식 div가 사라진다").
- **커밋 메시지와의 불일치**: 9660109 커밋 메시지는 "textContent 이후에 적용(순서 버그 해소)"이라고
  기술했으나 실제 diff는 **이동이 아니라 추가**였다. 원래 순서 버그는 두 번째 블록으로 해소되었고
  첫 블록은 원본 그대로 남아 데드코드가 됐다.
- **영향**:
  1. 기능 오작동은 없음(두 번째 블록이 항상 최종 상태를 만들므로).
  2. **성능 낭비**: pending/런 장식이 활성 상태에서 한글 조합이 일어나면 매 조합 업데이트마다
     장식 div를 생성→즉시 폐기하는 DOM 할당이 발생한다. 타이핑 핫 루프의 불필요한 GC 부하.
  3. 인접한 두 주석(":2317-2319"와 ":2332-2335")이 서로 다른 설명을 달아, 향후 유지보수 시
     "어느 블록이 진짜인지" 혼동을 유발한다.
- **수정 지침**: `:2316-2326` 블록(주석 포함) 삭제. `:2332-2335` 주석은 유지. 삭제 후
  `verify-ime.mjs`(브라우저) 또는 수동 조합 시나리오로 장식이 조합 중 표시됨을 재확인.

### 5.2 [F2 · 중] 금칙 pull-up 폭 게이트가 배치 공식과 불일치 — 논리 결함

- **위치**: `src/engine/paragraph-engine.ts:892-898` (`_partContentWidthMm`), 소비처 `:1047-1049`
- **도입**: 681efc1 "feat: 걸침 강제 모드·반각 돌출·행두 괄호 걸침 + 행두금칙 追い出し"
- **내용**: `_applyLineBreakRules`의 pull-up 분기에서 "금칙 글자를 위 줄에 올려도 파트 폭을
  초과하지 않는지" 미리 계산하는 게이트:

```ts
// :1047-1049
const nextCharWidth = this._charWidthMm(nextFirstChar, nextFirstPart.inlineStyles?.[0]);
const curUsedWidth = this._partContentWidthMm(curLastPart);
const fits = curUsedWidth + nextCharWidth <= curLastPart.width + 1e-6;

// :892-898 — _partContentWidthMm (JSDoc: "배치 패스와 동일한 폭 공식")
private _partContentWidthMm(part: TextPartData): number {
  let sum = 0;
  for (let i = 0; i < part.content.length; i++) {
    sum += this._charWidthMm(part.content[i]!, part.inlineStyles?.[i]);   // raw 폭만
  }
  return sum;
}
```

- **문제**: `_charWidthMm`의 계약은 "**장평 미적용** raw 폭"이다(:445-453, `genCharStyle`:3284가
  `raw × widthRatio + letterSpacing`를 적용하는 것과 대조). 실제 배치에서 글자가 소비하는 폭은
  charLoop(:2550) 기준 `rawCharWidth × inlineWr + letterSpacingMm`이다. 즉 게이트가 판정하는
  폭과 배치가 실제로 소비하는 폭이 다르다:
  - **기본값(letterSpacing=-0.1em, widthRatio=1)**: 게이트가 라인 글자 수 × (−fontSize×0.1)만큼
    **과소평가** → `fits`가 실제보다 자주 false → 들어맞는 pull-up을 놓친다(교정 누락, 양성이지만
    걸침/금칙 동작이 의도보다 보수적).
  - **widthRatio > 1(장평 확대)**: 게이트가 실제보다 **과대낙관** → pull-up이 파트 폭을 초과할 수
    있다. 걸침·금칙은 후처리 패스라 폭 재검증이 없고(코드 주석 :1067-1068이 스스로 인정),
    `_computeCharOffsets`의 justify가 실측 폭으로 정렬을 다시 계산하므로 컬럼 끝 돌출 또는
    인접 파트와의 간격 침범으로 표시된다.
- **JSDoc 불일치**: `_partContentWidthMm` JSDoc은 "배치 패스와 동일한 폭 공식(`_charWidthMm`)을
  글자별로 누적한다"고 주장하지만, 배치 패스의 공식은 `_charWidthMm` 그 자체가 아니라
  `_charWidthMm × widthRatio + letterSpacing`이다. 주석이 잘못된 것이다.
- **수정 지침**: `_partContentWidthMm`이 per-char로 `inlineWr`/`inlineLsMm`을 적용하도록 수정
  (charLoop :2512-2515의 런별 오버라이드 해석 `inlineStyle?.widthRatio ?? baseWr` 등과 동일
  규칙 사용). `nextCharWidth`(:1047)도 동일 공식 적용. **수정 후 반드시
  `verify-hanging-punctuation.mjs`(82항목)와 `verify-word-wrap.mjs`(32항목)을 재실행** —
  기본 스타일에서 게이트 판정이 바뀌므로 걸침 교정 빈도에 영향이 있다. 기대치가 달라지는
  항목이 있다면 그것이 올바른 방향(배치 공식과의 정합)인지 개별 확인 후 스크립트 기대치를
  갱신한다.

### 5.3 [F3 · 중] 조합 중 장식 색상 폴백 체인 누락 — 단일소스 드리프트

- **위치**: `src/edit/text-edit-controller.ts:2426, 2432` (편집 레이어) vs
  `src/engine/paragraph-engine.ts:2071-2082` (엔진)
- **도입**: 9660109
- **내용**: 밑줄/취소선 색상 결정 폴백 체인이 두 층위에서 다르다.

```
엔진 (_computeDecorations, firstNonEmpty 4단계):
  런 underlineColor → 문단 eff.underlineColor → 런 color → 문단 eff.color

편집 레이어 (_applyOptimisticDecorations):
  inlineStyle?.underlineColor ?? inlineStyle?.color ?? eff.color
  (문단 eff.underlineColor 단계 누락 — breaklineColor도 동일, :2432)
```

- **영향**: 문단이 `underlineColor`/`breaklineColor`를 설정하고 런이 비워둔 경우, 조합 중(IME
  composition) 미리보기 선 색이 확정 렌더와 다르게 나타난다. 조합 확정 후 엔진 rect로 교체되면
  바로잡히지만, 조합 중 깜빡임으로 사용자에게 보인다.
- **복제 자체는 정당**: 조합 중 텍스트는 엔진이 아직 배치하지 않았으므로 해당 글자의
  `decorationRects`가 존재하지 않고, 편집 레이어가 임시 기하를 만드는 것이 구조상 불가피하다
  (코드 주석 :2404 "확정 렌더가 도착하면 임시 span과 함께 제거되고 엔진 rect로 교체된다").
  문제는 복제가 공식(두께/y)까지만 일치하고 **색상 체인만 1단계 짧다**는 것이다.
- **수정 지침**(두 안 중 택일):
  1. 최소 수정: `:2426`을 `inlineStyle?.underlineColor ?? eff.underlineColor ?? inlineStyle?.color ?? eff.color`
     로, `:2432`를 `inlineStyle?.breaklineColor ?? eff.breaklineColor ?? inlineStyle?.color ?? eff.color`
     로 확장. 단, 엔진의 `firstNonEmpty`는 `''`(DEFAULT_TEXT_STYLE 기본)도 skip하므로 `??`가 아니라
     `firstNonEmpty`와 동등한 처리가 필요하다 — 편집 레이어에 국소 helper를 만들거나 엔진이
     `firstNonEmpty`를 export하는 것이 정확하다.
  2. 구조적 수정(권장): 두께/y/색상 결정 전체를 공유 순수 함수(예: `computeDecorationGeometry(fs, lineMaxFs, kind)`)
     로 추출해 엔진·편집 양쪽이 소비. AGENTS.md상 run-map mutation 정책은 편집 레이어 소관이므로
     **정책은 편집 레이어에 두고 공식만 공유**한다.
- **수정 후 검증**: `verify-text-decoration.mjs`(60항목) 재실행 + 수동 조합 시나리오
  (문단 underlineColor 설정 상태에서 조합 중 선 색 실측).

### 5.4 [F8 · 저] word-wrap 가드 3종 — 주석이 설명하는 시나리오가 불가능

- **위치**: `src/engine/paragraph-engine.ts:760-764`(행말 걸침), `:1036-1041`(금칙 pull-up),
  `:1067-1071`(追い出し) — 모두 `isWordChar(undefined, char, next)` 형태
- **도입**: b961d84
- **내용**: 세 가드의 주석은 "강제 분할 잔여(`.14159` 등)가 걸침으로 컬럼 밖에 배치되는 것을
  막는다"고 설명한다. 그러나:
  1. `isWordChar` 계약(`src/constants/line-break.ts:180-195`)상 `prev === undefined`이면
     `.`/`,`는 **항상 false**다. 즉 이 가드들은 주석이 경고하는 "잔여가 `.`/`,`로 시작" 케이스를
     구조적으로 차단할 수 없다(가드가 항상 통과).
  2. 실측(Node에서 DocumentEngine 구동, "3.14159265358979" 반복 + 강제 분할 유도): 모든 라인 시작이
     alnum(`"3.1"`, `"141"`, `"159"`…)이고 `.`/`,` 시작 라인은 **0건**. eager lookahead가 조인터를
     mid-word로 배치하므로 분할점이 조인터보다 앞에 오는 경우가 없어, 해당 시나리오 자체가
     발생하지 않는다.
- **영향**: 동작 결함 없음. alnum 잔여 방어는 정상 작동한다. 다만 "발생하지 않는 시나리오를
  방어한다"는 주석은 유지보수 오독을 유발한다.
- **수정 지침**: 주석만 정정("조인터 시작 잔여는 eager lookahead상 발생하지 않으며, 이 가드는
  alnum 잔여의 걸침/금칙 대상 여부를 판정한다")하거나, 가드를 `isAlnumCode(char)`로 단순화.
  엔진 로직 변경은 최소화할 것 — `verify-word-wrap.mjs`가 byte 비교를 하지 않지만 OFF 기준선
  snapshot 대조가 있으므로, 가드 단순화 시 반드시 재실행.

### 5.5 [F10 · 최저] `_charSwidthAt` 파라미터명 인덱스 공간 오기술

- **위치**: `src/engine/paragraph-engine.ts:2124-2140`
- **내용**: JSDoc/파라미터명은 "stripped 글자 인덱스"이나 실제로는 raw 인덱스를 받아
  `part.content[strippedIdx]`/`part.hangs[strippedIdx]`(raw 평행 배열)를 조회한다. 호출부(:2087)도
  raw 인덱스 `i`를 전달하므로 동작은 정확하다. 그러나 직전 호출 `_charOffsetMmAt(part, i - stripStart, stripStart)`
  는 stripped로 변환해서 전달한다 — 같은 루프에서 두 헬퍼가 다른 인덱스 공간을 쓰는데 한쪽
  이름이 반대로 기술되어 있다. 58cf512(deco x stripStart 이중 오프셋 버그)와 같은 부류의
  실수를 유발할 수 있는 지점이다.
- **수정 지침**: 파라미터명을 `rawIdx`로 개명하고 JSDoc 정정. 동작 변경 없음(타입·컴파일 확인만).

### 5.6 [F4 · 중] `verify-pending-style.mjs` dev-server 방어 부재 — 검증 인프라

- **위치**: `scripts/verify-pending-style.mjs:25-33`
- **도입**: 09f0c2f (9/10)
- **내용**: 스크립트는 `http://localhost:5175` → `5173` 순으로 `HEAD` 프로브만 하고(`res.ok` 판정),
  정상 서버가 없으면 `throw new Error('dev server not found')`한다. 다음 날 같은 패턴이 문제를
  일으킨 전력이 있음에도 방어 없이 추가됐다:
  - 9/9 d118d93이 verify-multicolumn에 이식한 2중 방어: ① 응답 HTML의
    `<title>Layout Element Benchmark</title>` 검증(타 앱 Vite의 SPA fallback이 존재하지 않는
    경로에도 200을 반환하는 것을 걸러냄) ② 정상 서버 없으면 포트 5198 자체 스폰 + 종료 시
    `server.kill()` 정리.
  - **실제 재현(본 리뷰 세션)**: layout-ui의 dev server가 5173을 점유한 환경에서 실행하면 SPA
    폴백 HTML에 접속해 `document.title === 'BENCH_READY'` 대기 30초만에 타임아웃으로 실패한다.
    브라우저로 확인하면 `window.bench`가 undefined인 타 앱이 로드된다.
  - **기능 자체는 정상**: 자체 Vite 서버(5199)를 띄워 Playwright로 핵심 3시나리오를 실측한
    결과 전부 통과 — ① setPendingNextStyle/pendingNextStyle 설정·조회, ② blur → 같은 오프셋
    재포커스 시 pending 유지(핵심 회귀 방어), ③ 커서 실제 이동 시 해제.
- **수정 지침**: `verify-multicolumn.mjs:14-70`의 `probe()`(제목 검증)·`waitForServer()`·자체
  스폰·정리 패턴을 그대로 이식. 스크립트 최상단의 BASE 탐지 블록을 교체한다.
- **참고 — 동일 취약점이 있는 다른 스크립트**: `verify-ime.mjs`, `verify-style-revert.mjs`도
  같은 `for (const port of [5175, 5173])` 하드코딩 프로브를 쓴다(grep 확인). 이 3종은 9/9 방어
  이식 대상에서 누락됐다. 방어 이식 시 함께 처리할지는 작업 범위 합의 후 결정(최소한
  verify-pending-style은 즉시 필요).
  - 반면 `verify-dom-diff.mjs`, `verify-hanging-punctuation-browser.mjs`, `benchmark-browser.mjs`,
    `verify-image-edit-mode.mjs`, `verify-visual-render.mjs`는 이미 `async function probe` 방어를 갖추고 있다.

### 5.7 [F5 · 저] `DEFAULT_HANGING_PUNCTUATION` — 무참조 상수

- **위치**: 정의 `src/constants/defaults.ts:28`, 위반 `src/engine/paragraph-engine.ts:85`
- **도입**: 4f678c0 (9/8)
- **내용**: 전수조사 결과 src/·scripts/·examples/·react/ 어디에서도 무참조.
  `DEFAULT_PARAGRAPH_STYLE`은 `hangingPunctuation: false`를 **리터럴로 하드코딩**한다(:85).
  바로 아래 `wordWrap: DEFAULT_WORD_WRAP`(:86)이 상수를 쓰는 것과 대조적이다.
- **영향**: 기능 문제 없음(값 동일). 그러나 같은 시기 커밋(a2be4c8·1c43756)이 확립한
  "기본값은 defaults.ts 상수로 주입" 패턴을 걸침 필드만 어긴 것이다. 걸침 기본값을 바꾸는
  미래 커밋이 defaults.ts만 고치면 엔진에 반영되지 않는 드리프트를 만든다.
- **수정 지침**(택일):
  1. `:85`를 `hangingPunctuation: DEFAULT_HANGING_PUNCTUATION`으로 교체(패턴 정합, 권장 — 1줄).
  2. 상수를 삭제.
  어느 쪽이든 `tsc --noEmit` + 스냅샷 계열 검증으로 OFF 기준선 불변 확인.

### 5.8 [F6 · 저] `_pendingNextStyleKeepOnCursorMove` — 도달불가 가드

- **위치**: `src/edit/text-edit-controller.ts:125`(선언), `:2849`(가드)
- **도입**: b0b3c4b
- **내용**: `false` 초기화만 존재하고 `true`로 설정하는 코드가 전체 코드베이스에 없다.
  따라서 `:2849`의 `if (this._pendingNextStyleKeepOnCursorMove) return false` 분기는 도달불가.
  JSDoc(:2836) 스스로 "내부 옵션, 현재 미사용"이라고 인정한다.
- **수정 지침**: 미래 확정 계획이 없다면 필드·가드·JSDoc 삭제. 계획이 있다면 TODO 링크와
  함께 남기되 `verify-pending-style.mjs`의 항목 계약에 영향 없음을 확인.
  (pending 해제 동작 자체는 이 가드 없이도 전 경로에서 정상 — 실측 완료.)

### 5.9 [F7 · 저] `_clearCompositionUnderline`의 CSS text-decoration 정리 잔존 — no-op

- **위치**: `src/edit/text-edit-controller.ts:2047-2052`
- **도입**: 9660109
- **내용**: 9660109가 조합 중 밑줄을 CSS `text-decoration` 방식에서 엔진 규칙 장식 div
  (`opt-underline`) 방식으로 교체하면서, **설정 경로(`span.style.textDecoration = 'underline'`)는
  삭제했지만 해제 경로의 정리 코드를 남겼다**. 이제 어떤 span도 `textDecoration`/
  `textUnderlineOffset` 인라인 스타일을 가지지 않으므로 두 분기는 no-op다.
- **수정 지침**: 두 분기 삭제(장식 div 제거 루프 `:2053-2055`는 유지 — 이건 유효 경로다).
  만약 구버전 렌더 잔존 방어로 남기고 싶다면 "9660109 이전 CSS text-decoration 경로 잔존 방어"라는
  주석을 명시할 것.

### 5.10 [F9 · 저] `INLINE_FIELDS` 14필드 목록 3곳 중복 — 유지보수 위험

- **위치**:
  - `src/edit/edit-manager.ts:939-944` (INLINE_FIELDS + PARAGRAPH_FIELDS)
  - `src/edit/text-edit-controller.ts:2970-2975` (INLINE_FIELDS, :3015 PARAGRAPH_FIELDS)
  - `src/engine/paragraph-engine.ts:4371-4376` (getCommonStyleInRange의 INLINE_FIELDS)
- **도입**: 장식 6필드 추가 시 965879b가 3곳 모두에 필드를 추가(현재는 세 복사본 모두 14필드로
  일치함을 확인). d6ba0c9가 수리한 버그(stale underline:false 등 8필드만 검사)가 바로 이 목록의
  **드리프트**였는데, 수리 방식이 "목록을 다시 일치시키는" 것이어서 중복 구조는 그대로다.
- **영향**: 다음 필드 추가 시 3곳 동시 갱신을 요구하며, 누락하면 d6ba0c9와 동일한 부분 적용 버그가
  재발한다.
- **수정 지침**: `src/constants/defaults.ts`에 `TEXT_INLINE_STYLE_FIELDS`(읽기 전용 배열)를
  상수로 두고 3곳이 import하도록 통합. 순서가 상이하지만(:939 계열은 fontFamily 우선,
  :4371은 color 우선) 전 필드 집합만 사용하므로 순서 통합은 무해하다. `noUnusedLocals` 빌드
  영향 없음.

### 5.11 [F10 · 최저] `effectiveTextStyle` JSDoc 이중 중복

- **위치**: `src/engine/paragraph-engine.ts:4203-4218`
- **도입**: 868303e — undefined 키 폴백 추가 시 이전 JSDoc 블록(:4203-4207)을 교체하지 않고
  새 블록(:4208-4218)을 위에 쌓았다.
- **수정 지침**: 구 블록 삭제. 동작 영향 없음.

---

## 6. 단일소스·엔진우선 원칙 판정 요약

| 검사 대상                                      | 판정                                   | 근거                                        |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------------- |
| lineHeight 공식 (a43f31d)                      | 준수 — 단일 소스 확립                   | §4.1                                        |
| 장식 rect DOM 렌더링 (8385df9)                  | 준수 (COMPLIANT)                        | §4.2                                        |
| 낙관적 span 기하 (4f0bc56)                      | 준수 (위임 패턴)                        | §4.3                                        |
| printPostData decorations (965879b)            | 준수 (COMPLIANT)                        | §4.4                                        |
| 조합 중 장식 기하 복제 (9660109)                | **정당한 복제** (JUSTIFIED-DUPLICATION) | §5.3 — 단, 색상 체인만 드리프트(F3)          |
| 걸침표 엔진 패스 구조 (9a2282b/681efc1)         | 준수                                   | §4.6 — 단, 폭 게이트 공식 불일치(F2)         |

**결론: 원칙 위반(엔진이 DOM을 참조·DOM이 기하를 재계산·이중 데이터 소스)은 없다.**
발견된 것은 동일 규칙의 "복제물 간 드리프트"(F3)와 "검증 로직 공식 불일치"(F2)이다.
둘 다 단일소스를 깨는 방향의 위험이므로 수정 우선순위는 높다.

---

## 7. 후속 작업 지침 (수정 실행 에이전트용)

### 7.1 작업 순서 및 검증 계획

각 작업은 독립 커밋으로 분리할 것 (repo 컨벤션 `type: description`, 커밋은 사용자 명시 요청 시에만).

**Wave 1 — 중 (수정 권장, 이 순서대로)**

1. **F1** 데드 장식 블록 삭제 (`text-edit-controller.ts:2316-2326`)
   - 검증: `tsc --noEmit` + 브라우저 조합 시나리오(장식 활성 상태에서 한글 조합 중 밑줄 표시).
     회귀: `verify-text-decoration.mjs`(60).
2. **F3** 색상 체인 정렬 (§5.3 지침)
   - 검증: `verify-text-decoration.mjs`(60) + 조합 중 선 색 실측. 엔진 `firstNonEmpty` export
     또는 공유 헬퍼 접근이면 엔진 파일도 함께 수정되므로 회귀로 `verify-inline-metrics.mjs`(47)도 실행.
3. **F2** 폭 게이트 공식 정합화 (§5.2 지침)
   - **가장 신중해야 할 수정**. 회귀: `verify-hanging-punctuation.mjs`(82) + `verify-word-wrap.mjs`(32)
     반드시 재실행. 기대치 변동 항목은 개별 판단 후 스크립트 갱신. Node 기반이라 dev server 불필요.
4. **F4** verify-pending-style 방어 이식 (§5.6 지침, `verify-multicolumn.mjs:14-70` 참조)
   - 검증: layout-ui 서버가 5173 점유 중인 환경에서 실행해 자체 스폰 경로로 ALL PASS 확인.
     (이 리뷰 세션에서는 수동 실측 3/3 통과했으므로 스크립트만 고치면 된다.)
   - 선택: `verify-ime.mjs`, `verify-style-revert.mjs`도 동일 이식 여부는 사용자 확인 후 결정.

**Wave 2 — 저 (정리)**

5. **F5** `DEFAULT_HANGING_PUNCTUATION` 사용 또는 삭제
6. **F7** textDecoration 정리 no-op 삭제
7. **F6** `_pendingNextStyleKeepOnCursorMove` 삭제 (사용자에게 계획 확인 후)
8. **F8** word-wrap 가드 주석 정정
9. **F9** INLINE_FIELDS 상수 통합
10. **F10** `_charSwidthAt` 개명 + JSDoc, effectiveTextStyle JSDoc 중복 제거

Wave 2 전체는 `tsc --noEmit` + 해당 영역 검증 스크립트로 충분하다.

### 7.2 반드시 지켜야 할 제약

- **엔진우선 원칙**: F2·F3 수정 모두 엔진 계산(`src/engine/`)을 기준으로 맞춘다. 편집 레이어가
  엔진 출력을 소비하는 구조를 역류시키지 않는다.
- **수정 최소화**: 버그 수정에 리팩터링을 섞지 않는다. F1은 삭제만, F2는 공식만, F3은 체인만.
- **커밋 규칙** (AGENTS.md): 사용자가 명시적으로 요청할 때만 커밋. 관련 파일만 스테이징.
  메시지 스타일 `fix: ...` / `refactor: ...` / `test: ...`.
- **검증 실패 시**: 이 문서의 기준선(§3)과 비교해 원인이 본 수정에서 비롯했는지 구분하고,
  기대치 갱신이 필요하면 그 논리를 커밋 메시지에 남긴다.
- **문서 갱신** (AGENTS.md 계약): F1·F3 수정 시 `docs/EDITING_TEXT.md` §2.7·§8.2(조합 장식) 갱신.
  F2 수정 시 `docs/TEXT_ENGINE.md` §22(금칙 폭 게이트) 갱신. F4 수정 시 `scripts/README.md`의
  스크립트 노트 갱신.

### 7.3 예상 소요 및 위험도

| 작업 | 난이도 | 위험도 | 주의점                                                      |
| ---- | ------ | ------ | ------------------------------------------------------------ |
| F1   | 매우 쉬움 | 낮음    | 삭제 후 조합 장식 표시 재확인 (두 번째 블록이 유효 경로임을 확인) |
| F3   | 쉬움   | 낮음    | `''` skip 의미가 `??`와 다름 — `firstNonEmpty` 등가 구현 필요 |
| F2   | 보통   | **중간**  | 걸침 82·워드래핑 32 기대치가 달라질 수 있음 — 개별 판단 근거 필수 |
| F4   | 쉬움   | 낮음    | `server.kill()` 누출 없음 확인 (스크립트가 실패 경로에서도 정리) |
| Wave 2 | 쉬움 | 낮음    | F9는 3 파일 import 변경 — `noUnusedLocals` 재확인                |

---

## 8. 부록 — 원본 분석 데이터

### 8.1 심볼 사용여부 전수조사 결과 요약 (에이전트 감사)

판정 기준: **USED** = 정의 파일 밖 src/에서 참조 · **SRC-UNUSED** = 정의 파일 내부에서만
소비되거나 scripts/만 참조 · **DEAD** = 전체 무참조

| 심볼                                         | 판정        | 비고                                                             |
| --------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| `resolveLineGap`, `computeLineHeightMm`        | USED        | 5개 소비처, 단일 소스 계약 충족 (§4.1)                             |
| `isLineStartForbidden` 외 line-break 헬퍼 6종  | USED        | paragraph-engine 다수 호출                                         |
| `LINE_START_FORBIDDEN`, `LINE_END_FORBIDDEN`, `HANG_LINE_END`, `HANG_LINE_START` | SRC-UNUSED | export되었으나 파일 내부 헬퍼만 소비 — 비공개화 권장 |
| `isAlnumCode`, `isWordChar`                    | USED        | paragraph-engine 10+ 호출                                          |
| `DEFAULT_LINE_GAP_MODE`, `DEFAULT_LINE_GAP_FIXED` | USED     | line-height.ts·GC·DocumentEngine                                   |
| **`DEFAULT_HANGING_PUNCTUATION`**             | **DEAD**    | F5 — 엔진이 `false` 리터럴 사용                                     |
| `DEFAULT_WORD_WRAP`                            | USED        | paragraph-engine:86 등                                             |
| `DEFAULT_UNDERLINE` 등 장식 기본값 6종        | USED        | paragraph-engine DEFAULT_TEXT_STYLE 주입                           |
| `SHORTCUT_*` 상수 5종 + `ShortcutMetricSteps` | USED        | edit-manager.shortcutSteps·text-edit-controller                    |
| `DECORATION_THICKNESS_RATIO`, `DECORATION_MIN_THICKNESS_MM` | USED | 엔진+편집 양측 소비(공유 상수 — 양호)                    |
| `PrintPostDecoration`, `chars.outline`, `decorations` 필드 | USED | 엔진 조립 + verify 스크립트 소비                      |
| `TextDecorationRect`, `decorationRects`, `hangs` | USED       | 엔진→DOM 데이터 흐름 확립                                          |
| 장식 6필드(underline 등)                       | USED        | 엔진·편집·run-map·column 전 층위 소비                              |
| `setPendingNextStyle`/`pendingNextStyle`/`pendingBaseStyle` | SRC-UNUSED(의도적) | 호스트(layout-ui) 대향 공개 API — b0b3c4b 계약, EDITING_TEXT §4.1.7. **데드코드 아님** |
| `shortcutSteps`                                | USED        | text-edit-controller 8 호출부                                      |
| `_releasePendingIfCursorMoved`                | USED        | 3 내부 호출부                                                      |
| **`_pendingNextStyleKeepOnCursorMove`**       | **DEAD-in-practice** | F6 — `true` 설정 경로 없음                              |

### 8.2 단일소스 감사 판정 (에이전트 감사)

| 항목                                       | 판정                 | 핵심 근거 (file:line)                                            |
| ------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| column.element.ts `_renderDecorationRects` | COMPLIANT            | :402 엔진 rect 통과 소비, :422-429 mm→CSS 문자열만, 폴백 합성 없음    |
| 조합 중 장식 `_applyOptimisticDecorations` | JUSTIFIED-DUPLICATION | 두께/y 공식·상수 동일(엔진:2067 ↔ 편집:2420). 단 색상 체인 드리프트 → F3 |
| 낙관적 span 하단 앵커 `_getOptimisticTopMm` | COMPLIANT (위임)     | :2280 `model._getCharVerticalOffset` 호출 — 공식 복제 아님           |

### 8.3 원본 발견 목록 (리뷰 세션 최종 보고서 요약)

이 문서 §2 표와 동일 내용이며, 리뷰 세션에서 사용자에게 보고된 원문 문구는 다음과 같다:

- 중 4건: F1 이중 장식 블록, F2 폭 게이트 불일치, F3 색상 체인 누락, F4 검증 스크립트 방어 부재
- 저 5건: F5 무참조 상수, F6 도달불가 가드, F7 no-op 정리, F8 주석-동작 불일치, F9 목록 3곳 중복
- 최저 2건: F10 파라미터명 오기술, effectiveTextStyle JSDoc 중복
- 원칙 위반: 없음 — lineHeight 단일 소스·장식 렌더링·하단 앵커 위임·printPostData 모두 준수 확인

---

*작성: 2026-09-11 코드 리뷰 세션 (HEAD=9660109 기준). 분석 방법·검증 결과 원본은 §1.3 참조.*