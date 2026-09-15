# CANVAS_RENDERING.md — canvas 렌더 전환 계획 (인계 문서)

> **문서 성격**: 설계 계획문. **구현 완료 (2026-09-15)** — 단계 0~5 전체 완료.
> 구현 중 결정 변경이 있으면 이 문서를 갱신할 것.
>
> **개정 이력**: 2026-09-15 — Oracle 아키텍처 리뷰 반영(수정안 5건). 주요 변경:
> §3.2 드로잉 캐시 키 결함 정정(fontWeight/color 제외 계약과 충돌 → runStyleRef
> 페인트 시점 해석), §4.1 baseline 엔진 게터 신설 요구, §4.4 IME 조합 밑줄
> decoRects 주장 정정, §5 단계 0 회귀 전수 확대 + scale≠1 코퍼스, 단계 5
> 재범위화(철거→기본값화), §6 하이브리드 영구 아키텍처 격상, §7 패리티 확대,
> §8 리스크 4건 추가(메모리/DPR, 걸침 클립, 이벤트 계약, a11y 필수).
>
> 2026-09-15 (2차) — **범위 확정: canvas는 문단에만 한정** (사용자 결정).
> 이미지·테이블 흡수(`drawImage`) 제외 — §3.1·§3.2·§4.3·단계 5·§6에 반영.
> 근거: 프로파일 지배 성분이 글자 span 자체(§1.2), 이미지는 이미 canvas crop,
> 테이블 보더는 DOM 오버레이 결합이 깊어 비용 대비 이득 없음.
>
> **작성 근거**: 성능 감사(`PAGE_STRUCTURE_PERF_AUDIT.md` §2.2a)의 프로파일러
> 귀속 — 타이핑 핫패스의 주 성분이 `(program)`(스타일 재계산·레이아웃·페인트)
> 53% + `_applySpanStyle` 18%이며, L-1/L-2로 조정 계층·쓰기 비용은 소진됐다.
> 남은 지배 성분은 **글자 단위 span DOM 자체**(300p 문서 span 179,400개)이고,
> 이의 구조적 해법이 canvas 렌더링이다 (AGENTS.md: "The engine layer is designed
> for future canvas rendering — it must remain DOM-free").
>
> **관련 문서**: `docs/ENGINE.md` (엔진 계층 계약), `docs/TEXT_ENGINE.md`
> (문단 배치·좌표 계약), `docs/EDITING_TEXT.md` (편집 좌표계), `docs/PERFORMANCE.md`
> §11 (문서 스케일 최적화 총람), `PAGE_STRUCTURE_PERF_AUDIT.md` §2.2a (프로파일 귀속).

---

## 0. 요약 (TL;DR)

**왜 canvas인가**: 현재 렌더는 `column → line div → part div → char span → text`의
3~4층 DOM 트리에 글자당 span을 놓는다. 300p 문서에서 span 179,400개 — 스타일
재계산·레이아웃·페인트가 노드 수에 비례한다(프로파일 `(program)` 53%). shift 편집
시 하류 프레임 span의 96%가 재작성되는 것(L-2 실측)도 이 구조의 필연이다. canvas는
**드로잉 명령이 노드가 아니다** — span 수와 무관하게 페인트 비용이 정산되고,
스타일 재계산·DOM 레이아웃 트리가 아예 존재하지 않는다.

**왜 지금 가능한가**: 엔진이 이미 canvas가 필요한 모든 것을 mm 단위 단일 소스로
소유한다 — `columnContents`(라인/파트/글자), `charOffsets`(글자별 x 좌표),
`getCharRect`(글자 mm rect), `getOffsetFromPoint`(히트테스트),
`decorationRects`(장식선), `printPostData`(인쇄 좌표). DOM은 이 출력을
표시만 하는 상태로 이미 정리됐다.

**전략**: 전면 교체가 아니라 **문단 단위 하이브리드** — paragraph 요소의 shadow
DOM(span 트리)을 canvas 1장으로 교체하는 경로부터 시작해, 편집 좌표·선택을 엔진
쿼리로 전환한 뒤 필요하면 확장한다. 단계마다 검증 스크립트로 동작 동일성을 핀닝한다.

**예상 효과**: 페인트·스타일 재계산이 span 수에서 분리된다. 타이핑 rAF p50 33ms
(하류 프레임 전 span 재작성)의 주 성분인 `(program)`이 소멸 방향으로 이동하며,
노드 수 자체가 3~4자릿수 감소한다 (§VIRTUALIZATION 1.4의 225만 span 한계 해소).

**리스크**: 텍스트 품질(글꼴 렌더 차이), 편집 시각화(커서/선택/조합 밑줄)의
좌표 재구현, 접근성·텍스트 선택 브라우저 네이티브 기능 상실, 줌/스케일 픽셀
정합. 각 항목은 §5의 단계별 방어로 다룬다.

---

## 1. 현재 렌더 구조와 비용 귀속 (왜 전환인가)

### 1.1 현행 렌더 파이프라인 (3~4층 DOM)

```
ParagraphEngine.layoutText()                    ← 엔진 (mm 단일 소스, 빠름 — 3%)
  columnContents: TextLineData[][]               ← 라인/파트/글자 + charOffsets + decoRects
LayoutParagraphElement.render()
  └ x-layout-column (shadow root)
      └ lineEl   (div, position:absolute, top=mm)      ← 1계층: 라인
        └ partEl  (div, position:relative)               ← 2계층: 파트 (오버랩 분할·런)
          └ charEl (span, position:absolute, left=mm)    ← 3계층: 글자
            └ textContent = 글자 1개
```

노드 수: 300p 문서 풀렌더 기준 **span 179,400 + lineEl ~5,700 + partEl ~11,000**
(§2.2 시나리오 8b — spans=179,400, nodes=910은 마운트 윈도우 기준).

### 1.2 프로파일러 귀속 (감사 §2.2a, L-1/L-2 적용 후)

| 성분 | 셀프타임 | 본질 |
| --- | --- | --- |
| `(program)` — 스타일 재계산·레이아웃·페인트 | ~4,200ms (53%) | **노드 수에 비례** — DOM 트리가 존재하는 한 제거 불가 |
| `_applySpanStyle` | ~1,127ms (18%) | 글자 span 스타일 쓰기 — L-2로 −10%, 남은 것은 CSSOM 파싱 자체 |
| `getBoundingClientRect` | ~316ms (10%) | 편집 좌표의 DOM 측정 — 엔진 쿼리로 대체 가능 (§5.2) |
| `renderText` diff | ~633ms (9%) | 3층 순회 + span diff |
| 엔진 전체 (layoutText 등) | ~200ms (3%) | 이미 최적화 완료 |

**결론**: JS 최적화는 소진됐다. `(program)`이 지배하는 이상, 노드 수를 없애는
것(= canvas)만이 구조적 해법이다.

### 1.3 canvas 전환이 해소하는 것 / 하지 않는 것

| 해소 | 해소 안 됨 (별도 과제) |
| --- | --- |
| 스타일 재계산·레이아웃 트리 (span 수 비례) | 엔진 layoutText (3% — 이미 빠름, 유지) |
| span 스타일 쓰기 (CSSOM 파싱) | shift 편집 시 하류 프레임 **드로잉 명령 재생성** 비용(새 비용 항목 — §4.3) |
| 225만 span 한계 (가상화 없이도 대형 문서) | 체인 길이에 비례하는 **엔진 재배치 비용** (체인 분할 — §6.7) |
| 페인트·컴포지트 (프레임당) | 커서·선택·IME의 좌표 쿼리 (엔진 쿼리 전환 — §5.2) |

---

## 2. 전환의 기반이 되는 단일 소스 인벤토리 (이미 준비된 것)

canvas 드로잉에 필요한 모든 데이터는 이미 엔진이 mm 단위로 산출한다. 아래는
전환 설계의 참조 목록 — **이 게터들을 소비해 그리는 것이 canvas 경로이며,
좌표 공식을 재계산하는 것은 금지**이다 (엔진-우선 원칙, RULES.md §3).

| 데이터 | 소유 엔진 API | 캔버스 드로잉 의미 |
| --- | --- | --- |
| `columnContents: TextLineData[][]` | `ParagraphEngine` | 라인/파트/글자 순회 (드로잉 명령 소스) |
| `part.charOffsets[i]` | `_computeCharOffsets()` | 글자 x 좌표 (파트 기준 mm) — absolute 배치와 동일 공식 |
| `part.left`/`part.width` | `_createLineWithParts()` | 파트 위치/폭 (오버랩 회피 분할 반영) |
| `line.maxFontSize`/`lineHeight` | `_computePerLineHeights()` | 라인 y 좌표/높이 (`genLineStyle`과 동일) |
| `getCharRect(sourceOffset)` | `paragraph-engine.ts:3750` | 글자 절대 mm rect (히트테스트·커서용) |
| `getOffsetFromPoint(xMm, yMm)` | `paragraph-engine.ts:3872` | 클릭→오프셋 (걸침 히트 범위 포함) |
| `getCursorPlacement(offset, preferLineEnd)` | `paragraph-engine.ts:3993` | 커서 배치 (bias·phantom end) |
| `part.decorationRects` | `_computeDecorations()` | 밑줄/취소선 rect (mm) |
| `printPostData` / `buildParagraphPrintPostData` | `paragraph-print.ts` | 글자별 폰트·색상(CMYK)·장평 — **canvas 드로잉 명령의 직접 전신** |
| `ImageEngine.rgbaData`/`displayRect` | image-engine.ts | 이미지 비트맵 + 표시 rect |
| `TableEngine` border/grid | `TableBorderStore` | 테이블 보더 세그먼트 |
| `FontLoaderEngine.getParsedFont()` | `font-loader-engine.ts:138` | opentype.js 파싱 폰트 — glyph path·advance 소유 |
| `ColorRegistry.getCSSColor()` | color-registry.ts | CMYK→hex |

**핵심 통찰**: `printPostData`가 이미 "글자별 위치·폰트·장평·색상"을 mm로
완성하고 있다. canvas 렌더 = **printPostData의 화면판 드로잉 명령으로의 전환**
이며, 새 좌표 계산은 거의 필요하지 않다.

---

## 3. 아키텍처 설계

### 3.1 목표 아키텍처 (문단 단위 canvas)

```
LayoutParagraphElement (커서·textarea·selection 오버레이 유지)
  └ x-layout-canvas (신설, shadow root 내)
      ├ <canvas> (컬럼 그리드 전체 1장)      ← 텍스트·장식선·배경 드로잉
      ├ x-layout-cursor                      ← 기존 오버레이 유지 (엔진 좌표로 배치)
      ├ x-layout-selection                   ← 기존 오버레이 유지
      └ textarea (편집 입력, 1x1 투명)       ← 유지
```

- **드로잉 단위 = 문단** (column 아님): 컬럼들은 한 canvas에 컬럼 좌표만 달리
  그린다. 이유: 커서/textarea/selection이 문단 단위 좌표계를 유지하는 현재
  편집 계약(`EDITING_TEXT.md` 좌표계 메모)을 최소 변경으로 유지하기 위함.
- **이미지·테이블·박스 배경은 DOM 영구 유지**: canvas는 텍스트 문단에만
  한정한다(단계 5 범위 확정 — 흡수 계획 없음). 이미지는 기존
  `<x-layout-image>`(canvas crop) 유지, 오버랩 회피 판정은 엔진이 계속
  소유하므로 상호작용 없다.

### 3.2 드로잉 명령 모델 — "layout 캐시"의 canvas 버전

현재 `_layoutCache`(입력 해시 → columnContents)를 소비하는 DOM diff
(span 재사용)를 canvas에서는 **드로잉 명령 목록 재사용**으로 치환한다:

```
ParagraphEngine에 신설 (권고 위치: paragraph-engine.ts 또는 paragraph-canvas.ts):
  _drawList: DrawCommand[]       ← columnContents + charOffsets + decorations에서
  _drawListHash: string          ← _computeLayoutInputHash와 동일 키 (cw/g/lh/lg/... 전부)

layoutText() 말미에:
  if (해시 불변 && _drawList 존재) → 드로잉 생략 (캐시 히트)
  else → _drawList 재구성 (columnContents 순회 — printPostData와 동일 워크)

canvas.paint():
  for (cmd of _drawList) → ctx.fillText / fillRect(장식선)  — drawImage 없음
  (canvas는 문단 텍스트·장식선만 — 이미지 흡수 제외, 단계 5 범위 확정)
```

> ⚠️ **수정 (2026-09-15 Oracle 리뷰) — 위 `_computeLayoutInputHash` 재용설계는 결함.
> 결함 1 — 폰트/색상 무효화 누락**: `_computeLayoutInputHash`는
> `fontWeight`/`color`를 **의도적으로 제외**한다 (`paragraph-hash.ts:44`,
> "fontWeight/color는 무영향이므로 제외 — 스타일만 변경된 주입(굵게/색상)에서
> 캐시 히트 → 재래핑 생략 계약"). 이는 레이아웃(래핑)에는 옳지만, 드로잉 명령은
> 굵기·색상을 글자별로 소비한다. 위 규칙대로면 굵게/색상 주입이 캐시 히트 →
> **옛 굵기/색으로 페인트되는 stale 버그**가 구조적으로 발생한다. `textDecoration`
> 도 해시에 없어(decoRects는 layoutText 내부 계산, paragraph-engine.ts:1608)
> 동일 위험. 또한 `_refreshInlineStylesOnly()`(paragraph-engine.ts:1649)는
> skeleton 캐시 히트 시 `part.inlineStyles`를 **제자리(in-place)** 갱신하므로
> 참조 동일성 기반 캐싱으로도 막을 수 없다.
>
> **수정된 설계**: DrawCommand가 굵기/색상을 내장하지 않는다 —
> `(char, mm rect, runStyleRef)` 구조로 **live `inlineStyles` 참조만 보유**하고
> 폰트(weight/family/style)·색상(hex)은 **페인트 시점에 해석**한다
> (ColorRegistry 재변환 포함). 구조적으로 stale 불가능하며 페인트 시점 해석
> 비용은 O(placed) 조회 수준으로 미미하다. 굽는(bake) 방식을 택할 경우에만
> 슈퍼셋 키(레이아웃 해시 + fontWeight/color/textDecoration + ColorRegistry
> 버전) + `_refreshInlineStylesOnly` 호출 시 무효화를 강제한다.

- `DrawCommand`는 `printPostData.chars`와 같은 정보(char, mm rect, font, color,
  widthRatio, letterSpacing)지만 **px 변환 없이 mm 유지** — paint 시점에 ppm×scale로
  변환 (엔진-우선: mm 단일 소스, 화면은 표시만).
- **dirty 페인트**: 문단 rect만 클립해 다시 그린다 — shift 편집 시 하류 프레임도
  "드로잉 명령 재생성(엔진 O(placed)) + 1회 fillText 루프"이며 span 96% 재스타일
  (L-2 실측)과 달리 **스타일 재계산 트리가 없다**.

### 3.3 폰트 렌더 경로 (품질 리스크의 핵심)

2가지 경로가 있고, 2단계로 전환한다:

| 경로 | 방법 | 장단점 |
| --- | --- | --- |
| **A. ctx.fillText** (1단계) | `ctx.font = '700 15px Myoungjo'` + `document.fonts` 로드 폰트 사용. 장평은 글자별 `ctx.scale`+translate로 구현 | 브라우저 서브픽셀 렌더(힌팅·LCD 서브픽셀)를 그대로 얻는다. 단 현재 DOM 경로의 `scale(wr*0.88)` 정밀 재현과 글자별 정밀 mm 배치 검증 필요 |
| **B. glyph path** (2단계, 필요 시) | `getParsedFont()`의 opentype glyph path를 `ctx.fillPath`로 드로잉 — 인쇄(printPostData)와 동일 소스 | 폰트 메트릭과 100% 일치, subpixel 안 함 — 대량 텍스트에서 느릴 수 있음. 인쇄 패리티에는 유리 |

**폰트 로딩 계약**: `FontLoader`가 `document.fonts`에 등록한 `FontFace`를 canvas
`fillText`가 그대로 사용한다(패밀리명 동일). 로드 완료 전 그리면 폴백 폰트로
그려지므로, **`document.fonts.ready` 또는 폰트별 loaded 이후에만 paint**를
허용하는 게이트가 필요하다 (`verify-visual-render`의 "빈 화면 사각형" 판별이
이를 잡는다).

### 3.4 편집 좌표 전환 — 준비된 플래그

`TextEditCoordinateMapper.useEngineCoordinateQueries`(기본 false)가 이미 존재
(`text-edit-coordinate-mapper.ts:34`) — `getCharRect`가 `ParagraphEngine.getCharRect()`
(mm→ppm 변환)로 전환된다. canvas 전환은 이 플래그 전환을 **전제 조건**으로 한다:

- 커서 배치·히트테스트가 DOM span을 참조하지 않게 되어야 canvas 전환 후에도
  커서가 정확하다.
- `getOffsetFromPoint`는 이미 엔진 소유(mm) — 클릭 매핑 전환 가능.
- **미전환 API** (`getTextRange` 선택 rect, `getFirstColumnRect`, `getLineRect`,
  `getSpanByOffset`, `data-offset` 클릭 파싱)는 canvas 모드용 엔진/드로잉리스트
  기반으로 보완해야 한다 (§5.2 단계 2).

---

## 4. 상세 설계 — 파트별 전환 계약

### 4.1 텍스트 글자 (fillText vs glyph path)

| 요소 | DOM 현행 | canvas 구현 |
| --- | --- | --- |
| 글자 위치 | span `left=charOffset mm`, 라인 top + `_getCharVerticalOffset` 하단 앵커 | `ctx.fillText(char, x_px, baseline_px)` — baseline은 **엔진 게터로 소비** (§2/§10 규칙): opentype `getParsedFont().ascender/unitsPerEm` 기반 `getCharBaselineMm(sourceOffset)` 신설 또는 DrawCommand에 baseline mm를 엔진이 직접 산출해 포함. DOM rect bottom 역산은 금지 — rect bottom에서 ascent 비율로 역산하는 것은 엔진 게터 밖의 새 좌표 공식이며 §10 금지 5항(별도 좌표 계산) 위반이다 |
| 장평 (widthRatio) | `scale: wr*0.88 1` + transformOrigin "0 center" | 글자별 `ctx.save(); ctx.translate(x, baseline); ctx.scale(wr*0.88, 1); fillText(...)` — 0.88 보정 계수 유지 |
| 자간 (letterSpacing) | 폭에 포함 (`swidth = raw*wr + ls*fs`) | 글자별 개별 배치이므로 좌표에 이미 반영 — fillText에 추가 처리 불필요 |
| 공백 | `spaceRatio*fs` 고정 폭 span | 드로잉 생략 (좌표만 소비) — 히트테스트는 엔진 `getOffsetFromPoint`가 담당 |
| 탭 (Right Indent Tab) | 0폭 마커 + 점선 가이드(편집 모드) | 드로잉 생략 + 가이드는 canvas에 선 드로잉(편집 모드만) |
| outline | `webkitTextStroke` | `ctx.strokeText`(lineWidth=outline*fs*2, strokeStyle) — fill과 stroke 순서 정밀 비교 필요 |
| 컬러 | CMYK→hex | 동일 (ColorRegistry 재사용) |
| 인라인 폰트 | fontFamily/fontWeight/fontStyle span 스타일 | `ctx.font` 조합 — 런별로 fillText 호출 단위 묶음 |

**핀닝 검증 필수**: DOM 경로와 canvas 경로가 같은 문서를 **픽셀 오차 ≤1px**로
그리는지 — `verify-canvas-parity.mjs` 신설 권장 (동일 데이터로 두 경로 렌더 →
글자 rect 비교). 폰트 메트릭(opentype advanceWidth)과 fillText 실측 폭의 차이가
여기서 드러난다. 추가 요구(Oracle 리뷰):
- **커널링/리처처리 구조적 등가 확인**: DOM 경로는 글자별 절대 배치 span이므로
  크로스-글자 셰이핑(커널링·리처처리)이 원래 없다 — fillText 1글자 호출도
  동일하게 무셰이핑. 양 경로가 구조적으로 등가이므로 ≤1px rect 패리티가
  성립한다. (단 이것은 **위치** 패리티다 — 래스터화 품질은 §7 픽셀 스팟
  체크로 별도 검증)
- **CJK 폴백 스택 동일성**: 엔진은 미등록 한글 음절의 폭을 기준 글자 `가`의
  advanceWidth로 대체하고(AGENTS.md 한글 글리프 폴백), 브라우저는 폰트에
  없는 글자를 시스템 폴백 글리프로 페인트한다. `ctx.font` 조합이 DOM span의
  `font-family` 폴백 스택과 **동일한 스택 문자열**을 사용해야 패리티가
  성립한다 — 베어 패밀리명만 넣으면 폴백 글리프 지점에서 패리티가 파열된다.
  패리티 코퍼스에 미등록 한글 음절 + 라틴 혼합 케이스 필수.

### 4.2 장식선 (decorationRects)

엔진이 mm rect를 이미 산출하므로 `ctx.fillRect(x, y, w, h)` 직접 변환. 색상은
`rect.color`(hex) 또는 `colorName` 재변환. DOM 경로의 `data-deco-key` diff와
달리 드로잉 명령 목록이 항상 재생성되므로 diff 불필요.

### 4.3 하이퍼레이션/오버랩 (텍스트 회피)

오버랩 회피는 **엔진 배치**(파트 분할)가 소유하므로 canvas는 그 결과
(`part.left/width/charOffsets`)를 그리는 것만으로 동일 결과다. 이미지는 별도
DOM으로 **영구 유지**한다 — canvas는 문단에만 한정(단계 5 범위 확정)이며
`drawImage` 흡수는 하지 않는다(오버랩 판정은 `rgbaData` 엔진 픽셀 — 변화 없음).

### 4.4 선택·커서·조합 시각화

> ⚠️ **정정 (2026-09-15 Oracle 리뷰)** — 조합 밑줄 행의 원래 주장
> ("엔진 decoRects 경로 재사용")은 **틀렸다**: decoRects는 `layoutText()` 내부에서
> **커밋된 런**만으로 계산된다(paragraph-engine.ts:1608). 조합 중 텍스트는
> 커밋 전이며 엔진이 배치한 적이 없으므로 decoRects로는 밑줄을 그릴 수 없다.
> 하이브리드(§6)에서는 조합이 항상 DOM 문단(포커스 문단)에서 일어나므로 문제가
> 없지만, 전면 canvas 모드에서는 조합 시각화에 신설 경로(엔진 조합 레이아웃 API
> 또는 canvas 측 `ctx.measureText` 기반 ad-hoc 밑줄)가 필요하다. 이것이
> §6의 "하이브리드 = 편집 문서의 영구 아키텍처" 결론의 근거다.

| 요소 | 현행 | canvas 모드 |
| --- | --- | --- |
| 커서 (`x-layout-cursor`) | `_updateCursorPosition` → mapper rect | 엔진 `getCharRect`/`getCursorPlacement` mm→px로 위치 계산 (동일 요소 유지) |
| 선택 (`x-layout-selection`) | `getTextRange` (span rect 순회) | 엔진 기반 선택 rect 산출 신설 — 아래 **선택 rect 산출 계약** 준수 |
| 조합 밑줄 | span에 deco div 부착 | 하이브리드: DOM 유지 (포커스 문단). 전면 canvas: decoRects **불가** — 신설 경로 필요 (위 정정 참조) |
| optimistic span | DOM 삽입 즉시 표시 | 하이브리드에서는 **구조적으로 유지** — optimistic span(`_optimisticSpanUpdate`, controller:1996)·`_shiftFollowingSpans`·조합 temp span은 DOM 전용 메커니즘이며 하이브리드 아래 항상 포커스 문단(DOM)에서만 실행된다. 전면 canvas에서 optimistic span은 대체 필요 (커밋 전 라인 부분 재그리기) |

**선택 rect 산출 계약 (엔진 게터 재유도 금지)**:
1. **verticalAlign/멀티컬럼**: 라인 y는 "라인 인덱스 × lineHeight"가 아니라
   `parentAbsRect.absTop + _computeAlignOffsetMm(...) + 누적 lineHeight`이며
   컬럼 x는 `columnLeftOffset(c)` — 반드시 `getCharRect`
   (paragraph-engine.ts:3750)와 동일 헬퍼(`_computeAlignOffsetMm`)를 재사용하고
   선택 빌더에서 재유도하지 않는다 (§10 금지 5항).
2. **라인 내 혼합 폰트 크기**: 현행 DOM `getTextRange`는 같은 라인 내 크기가
   다른 런을 **분리된 rect로 유지**한다 (mapper:615-617 — 하단 앵커로 top이
   다름). 단순 "라인 y + charOffsets" 균일 높이 rect는 눈에 보이는 회귀다 —
   런별 `_getCharVerticalOffset(lineMaxFs, charFs)`를 적용해야 한다.
3. **걸침 (hanging punctuation)**: 걸친 글자는 파트 경계 밖에 렌더링된다
   (행말 `charOffset = partWidth - 0.5×w₀`, 행두 `-swidth`). 엔진
   `getCharRect`는 걸침 폭을 반영한다(:3792-3794) — 선택 rect 산출도 동일
   게터를 소비해야 하며, 누락 시 걸친 글자가 선택 하이라이트에서 빠진다.
   또한 행두 걸침은 컬럼 기준 **음수 x**에 페인트되므로 canvas가 문단 경계로
   클립하면 컬럼 0의 행두 글자가 잘린다 (DOM은 `:host overflow: visible`로
   생존) — canvas bleed 여백/no-clip 정책 필수 (§8 리스크).
4. **선택 범위 가정 명시**: 선택은 문단(스레드 프레임) 단위다 —
   `getTextRange`도 `absOff = srcOff + contentFrom`으로 **현재 프레임의 span만**
   순회한다. 엔진 기반 산출도 이 프레임 로컬 가정을 그대로 상속하며
   프레임 간 선택은 현재 코드베이스에 존재하지 않는다. 이 가정을 위반하는
   변경(프레임 간 선택 신설)이 생기면 이 계약을 재검토한다.
5. **패리티**: `verify-canvas-parity`에 **선택 rect 패리티**를 추가한다 —
   기존 설계는 글자 rect만 비교하므로 선택 rect 회귀가 검증망을 통과한다 (§7).

---

## 5. 단계별 구현 계획 (각 단계 독립 커밋·검증 원칙)

### 단계 0 — 기반 준비 (✅ 완료 2026-09-15)

> **완료 기록**: `useEngineCoordinateQueries = true` 전환 + scale≠1 코퍼스 신설 +
> 전수 회귀 17 스크립트 ALL PASS. 구현 과정에서 발견·수정한 결함 3건:
> 1. **엔진 경로 원점 차감 누락** — `getCharRect`는 지면 절대 mm(parentAbsRect
>    포함)를 반환하므로 문단 로컬 변환에 `parentAbsRect` 원점 차감이 필요했다
>    (플래그 OFF 기간 동안 이 경로가 검증되지 않은 채 남아 있었다).
> 2. **엔진 경로 scale 나눗셈 이중 보정** — ppm은 document.body 직접 측정
>    (transform 밖)이라 mm×ppm은 이미 로컬 px. `EditManager.scale` 나눗셈은
>    스케일 호스트에서 커서를 어긋나게 했다 (scale≠1 코퍼스가 발견).
> 3. **배치 조회의 오프셋 공간 불일치** — `cursorLineRanges` walk는
>    endOfBlock마다 `\n`을 소비하지만 `getCharRect`/columnContents는 소비하지
>    않는다. 라인 소속은 walk 공간에서, 배치 참조 오프셋은 columnContents
>    공간에서 산출하도록 mapper가 두 공간을 정합시켰다 (walk→cc 역보정).
> 추가 정정: `getCursorPlacement`(engine)가 구 `_findLineBySourceOffset`
> (파트 합산, `\n` 미소비)를 쓰면 엔터 이후 라인 소속이 1 오프셋 어긋난다 —
> 소속 판정도 walk range 기반으로 정정 + `getCharRect` strip 위치 폴백 정정
> (leading strip→첫 visible 좌측, trailing strip→마지막 visible 우측 경계).
> `verify-threading-browser` [13] 판정을 atEndOfChar 시맨틱 반영으로 정밀화.
> **실행 방어막**: caret-parking 35P(28P + scale≠1 7P)·ime 25P·threading-browser
> 49P·overflow-clamp 24P·word-wrap 32P·hanging browser+engine 93P·inline-metrics
> 47P·visual-render 7P·dom-diff·multicolumn 15P·pending-style 31P·style-revert
> 42P·threading 114P·engine-node 25P·virtualization 47P·right-indent-tab-browser·
> page-reorder·progressive 21P — 전부 ALL PASS + tsc clean.

1. ✅ `useEngineCoordinateQueries = true` 전환 — 회귀 방어망은 **브라우저 전수**
   (caret-parking·ime·threading-browser·overflow-clamp·word-wrap·hanging
   browser·inline-metrics·visual-render)로 실행 완료.
2. ✅ **scale≠1 코퍼스** — `verify-caret-parking` 16항목(0.5/1.5 배율 커서 local
   px scale 무관성 + 라인 top provenance seam) 신설. DOM 경로는 `EditManager.scale`
   나눗셈, 엔진 경로는 mm×ppm(scale 불변) — 두 경로의 일치를 scale≠1에서 핀닝.
3. `getTextRange`/`getFirstColumnRect`/`getLineRect`의 엔진 기반 대응물 설계
   (선택 rect는 §4.4의 선택 rect 산출 계약을 따른다) — **아래 미전환 API 설계** 참조.

**미전환 API 엔진 기반 대응물 설계 (단계 0 산출물)** — 플래그 전환 후에도
다음 3개 API는 DOM 기반이다(optimistic span·selection 폴백이 소비). canvas
모드에서는 다음 계약으로 대체한다:

| API | 현행 소비처 | 엔진 기반 대응물 설계 |
| --- | --- | --- |
| `getTextRange(start, end)` | 선택 rect 렌더 (`_updateSelection`) | 엔진 신설 `getSelectionRects(start, end)` — cursorLineRanges walk로 소속 라인별 charOffsets + `_computeAlignOffsetMm` + `_getCharVerticalOffset`(런별 분리 높이) + 걸침 폭(getCharRect와 동일)으로 rect 산출. §4.4 계약 1~3항 준수. 패리티: `verify-canvas-parity` 선택 rect 비교 |
| `getFirstColumnRect()` | 커서 폴백 top/fontSize (controller:2567·2602·2662) | 엔진 게터 `getFirstLineMetrics()` — 첫 컬럼 첫 라인의 `{top: alignOffsetMm, left: 0, fontSize: maxFontSize}`. 커서 폴백 경로는 엔진 mm×ppm으로 변환 |
| `getLineRect(col, line)` | 커서 폴백·빈 라인 배치 (controller:2563) | 엔진 게터 `getLineMetrics(col, line)` — `genLineStyle`과 동일 산식(`alignOffsetMm + cumulativeTop`, 폭 = columnWidths[col])을 number로 반환. DOM 측정 제거 — genLineStyle 산식 재유도가 아닌 엔진 게터로 단일 소스 유지 |
| `getSpanByOffset(off)` | optimistic span 앵커 (controller:2026) | 하이브리드 아래 optimistic span은 **DOM 전용 불변식**(§6)이므로 DOM 경로 유지 — canvas 대응 불필요. 전면 canvas 전환 시에만 커밋 전 라인 부분 재그리기로 대체 |

### 단계 1 — 드로잉 명령 빌더 (Node 검증 가능)

`ParagraphEngine`에 `_drawList` 빌더 추가 — **§3.2 수정 설계(runStyleRef +
페인트 시점 폰트/색상 해석)를 전제로 한다.** `_computeLayoutInputHash`를 그대로
캐시 키로 재용하면 굵게/색상 주입에서 stale 페인트가 발생한다(§3.2 결함 참조).
`verify-engine-node.mjs` 스타일로 **Node에서 명령 목록 검증** (DOM 불필요 —
엔진-우선 원칙 유지). snapshot-layout에 명령 목록 직렬화 추가해 byte-identical
확보. baseline이 명령에 포함된다면 opentype ascender 기반 엔진 산출(§4.1)을
Node에서도 검증한다.

### 단계 2 — 문단 canvas 렌더러 (DOM 병행, 피처 플래그)

`x-layout-canvas` 신설 + `LayoutParagraphElement.renderMode: 'dom' | 'canvas'`
플래그. DOM 경로는 전부 유지(기본 'dom') — 플래그 'canvas'일 때만 전환.
`verify-canvas-parity.mjs` (DOM vs canvas 글자 rect 픽셀 비교) + `verify-visual-render`
확장(화면 사각형 존재 판정을 canvas 포함).

### 단계 3 — 편집 좌표·시각화 전환

커서/선택/히트테스트를 엔진 쿼리 경로로. `verify-caret-parking` + `verify-ime` +
`verify-threading-browser` 전수를 canvas 모드로 재실행 — **커서 px 좌표 핀닝이
전환의 정확성 증명망**이다.

### 단계 4 — 성능 실측·스케일 확장

`benchmark-browser.mjs`에 canvas 시나리오 추가(시나리오 8 대응: 300p 빌드·
타이핑 rAF·메모리). 기대: `_applySpanStyle`·`(program)`의 span 비례 성분 소멸.
300p 풀렌더가 DOM의 258ms에서 명령 생성+paint로 수렴하는지 실측.

### 단계 5 — canvas **기본값화** (철거 아님 — 재범위화, 이미지·테이블 흡수 제외)

> ⚠️ **재범위화 (2026-09-15 Oracle 리뷰)** — 원래의 "DOM 경로 철거"는 **시기상조**이며
> 편집 문서에서는 구조적으로 비목표다. 이유 3가지:
> 1. **패리티 오라클 소멸**: `verify-canvas-parity`는 DOM 경로를 비교 기준으로
>    사용한다 — DOM을 철거하면 검증망이 무너진다. DOM 경로는 상시
>    참조 구현(reference implementation)으로 유지한다.
> 2. **편집 표면은 DOM 전용 메커니즘 의존**: optimistic span·조합 temp span·
>    `_shiftFollowingSpans`는 DOM 구조 전용이다(§4.4 정정). 편집 중인 문단은
>    하이브리드(§6)로 DOM을 유지하는 것이 영구 아키텍처이다.
> 3. **접근성 폴백**: DOM 모드는 스크린리더·브라우저 검색의 최종 폴백이다.
>
> ⚠️ **범위 확정 (2026-09-15 사용자 결정)** — **canvas는 문단(paragraph)에만
> 한정한다. 이미지·테이블 흡수(`drawImage`)는 제외한다.**
> 근거: (a) 프로파일 귀속(§1.2)의 지배 성분은 **글자 span 자체**다 — 이미지와
> 테이블은 span 트리 밖에 있으며 전환 이득이 없다, (b) `x-layout-image`는 이미
> canvas crop으로 렌더된다(흡수 시 이중 캔버스), (c) 테이블 보더/셀 그리드는
> `TableBorderStore` 엔진 소유지만 DOM 오버레이(리사이즈 핸들·선택)와의
> 결합이 깊어 흡수 비용 대비 이득이 없다, (d) 오버랩 회피 판정은 엔진이
> 계속 소유하므로 이미지가 DOM이어도 상호작용 결함이 없다.
> 재범위화된 단계 5의 목표는 "canvas 기본값화"다 — 비-포커스/읽기전용
> 문단의 기본 `renderMode`를 `'canvas'`로 전환하고, DOM 경로는
> (a) 포커스 문단, (b) 패리티 오라클, (c) 접근성 폴백으로 남는다.

### 각 단계 공통 금지

- DOM 경로 동시 유지 기간(단계 2~4) 중 두 경로의 **좌표 공식 분기 금지** —
  canvas 드로잉은 엔진 게터(printPostData/charOffsets/decoRects)만 소비한다.
  새 좌표 계산을 canvas 쪽에 추가하면 단일 소스 붕괴 (RULES.md §3 위반 —
  감사 §1.5 "판별 규칙" 재인용).
- `verify-canvas-parity` FAIL 상태에서의 다음 단계 진행 금지.

---

## 6. 하이브리드 전략 (전면 전환 전 안전망 → **편집 문서의 영구 아키텍처**)

> ⚠️ **격상 (2026-09-15 Oracle 리뷰)** — 하이브리드는 단계 5 철거를 기다리는
> 과도기 안전망이 아니라 **편집 가능한 문서의 영구 아키텍처**로 결정한다.
> 근거: (a) optimistic span·조합 temp span은 DOM 전용 메커니즘이고 커밋 전
> 텍스트는 엔진이 배치하지 않으므로(decoRects 불가, §4.4 정정) 전면 canvas의
> 조합·optimistic 시각화는 신설 API가 필요한데 그 비용 대비 이득이 없다,
> (b) 포커스 문단이 DOM이면 이 문제들이 구조적으로 소멸한다,
> (c) 비-포커스 문단(타이핑 핫패스의 96% 재스타일 대상, L-2 실측)이 canvas가
> 되면 성능 목표는 달성된다 — 하이브리드가 원래 목표를 정확히 커버한다.
>
> **범위 확정 (2026-09-15 사용자 결정)** — canvas는 **문단에만 한정**한다.
> 하이브리드 경계는 문단 단위 DOM↔canvas 스왑이며 이미지·테이블은 항상 DOM이다.

편집 경험이 가장 위험하므로, **포커스 문단만 DOM 유지**하는 하이브리드가
1차 출시 후보다 안전하다:

- 포커스 문단: 기존 DOM span 트리 (커서·optimistic span·조합 밑줄 그대로)
- 비-포커스 문단: canvas 드로잉
- 포커스 전환 시: DOM↔canvas 교체 (문단 1개 — 재렌더 비용 국소)

**효과**: shift 편집 시 하류 프레임(비-포커스)이 canvas 드로잉이 되어 L-2의
96% 재스타일이 소멸하고, 위험(편집 UX)은 포커스 문단의 기존 경로에 고정된다.
이 하이브리드가 단계 2~3의 중간 산출물로 권장된다 (포커스 전환 시
`verify-caret-parking`·`verify-ime` 통과가 조건).

**추가 설계 확정 (Oracle 리뷰)**:
- **하이브리드는 단계 3 없이 동작한다** — 비-포커스 canvas 문단에는
  커서/선택이 없고, 클릭→포커스 전환은 `getNearestOffsetFromPoint`가
  이미 엔진에 위임하므로(mapper:563 → engine.getOffsetFromPoint) 오늘
  동작한다. 단계 2 산출물로 즉시 출하 가능하며, 단계 3은 그 후
  비-포커스 클릭 매핑을 포함해 정교화한다.
- **포커스 전환 프레임의 커서 연속성**: DOM↔canvas 교체 프레임에
  `getSpanByOffset`가 null을 반환하면 커서 폴백 체인(`getLineRect`/
  `getFirstColumnRect`, controller:2554-2589)도 DOM 기반이므로 커서가
  1프레임 소실될 수 있다 — **단계 0(엔진 좌표 플래그)이 포커스 전환보다
  선행**되어야 하며, 이는 이미 §5 단계 순서로 보장된다. 교체 프레임 커서는
  엔진 `getCursorPlacement`로 직접 배치한다.
- **불변식 명시**: optimistic span·조합 temp span은 **항상 DOM 모드 문단에서만
  실행된다** — 부작용이 아니라 하이브리드의 구조적 불변식이다. 컨트롤러는
  이 가정을 코드로 강제한다(포커스 문단 renderMode === 'dom' 게이트).
- **선택 범위**: 선택은 문단(프레임) 단위로만 존재한다 — DOM+canvas 문단에
  걸친 선택은 현재 코드베이스에 없으며, 이 가정 위반 변경 시 §4.4 계약 4항을
  재검토한다.

---

## 7. 검증 계획 (신규 스크립트)

| 스크립트 | 목적 | 판정 |
| --- | --- | --- |
| `verify-canvas-parity.mjs` | 동일 문서를 DOM/canvas 양 경로 렌더 → 글자 rect 비교 (ppm 환산) | 글자 rect 오차 ≤1px, 텍스트 내용 동일. **+ 선택 rect 패리티 추가** (Oracle 리뷰 — §4.4 계약 2항: 런별 분리 높이, 3항: 걸침 폭 포함, 1항: `_computeAlignOffsetMm` 재사용 산출) |
| `verify-canvas-editing.mjs` | canvas 모드에서 커서 배치·선택 rect·IME 조합 밑줄 | caret-parking 28P 시나리오 재현 ALL PASS |
| `verify-canvas-print-parity.mjs` | canvas 드로잉 명령 === printPostData (같은 엔진 소스) | 명령 목록 일치 — 단 색상 비교는 **구조 비교**(colorName 기준)만 허용. canvas는 hex, printPostData는 CMYK이므로 리터럴 색상 비교는 오탐낸다 |
| 기존 전수 | snapshot-layout (엔진 무변경)·threading·virtualization·page-model 등 | 기존 판정 유지 |

**패리티 확대 요구 (Oracle 리뷰)**:
- **픽셀 스팟 체크**: rect 패리티는 위치만 검증한다 — 래스터화 품질(힌팅,
  LCD 서브픽셀 vs 그레이스케일 AA)은 별도다. 샘플 문단 1개에 대해
  `verify-visual-render` 스타일 스크린샷 스팟 비교를 추가해 "그려진 모양"을
  가정이 아닌 실측으로 확인한다.
- **폴백 글리프 코퍼스**: 미등록 한글 음절(엔진 `가` 폭 대체 + 브라우저
  시스템 폴백 글리프) + 라틴 혼합 케이스를 코퍼스에 포함하고, `ctx.font`가
  DOM span과 동일 폴백 스택 문자열을 사용하는지 검증한다 (§4.1).
- **`render-complete`/`render-error` 계약**: canvas 경로도 동일 이벤트를
  발화해야 한다 (React 호스트가 `render-complete`에 의존). 오버플로
  (`:host` 빨강 inset 계약)도 canvas 모드에서 유지한다.
- **접근성 병기 필수**: "필요 시"가 아니라 canvas 모드의 **기본 구성**이다 —
  문단당 히든 텍스트 레이어 1개(plain text + aria)는 글자 span 트리 대비
  수백 배 저렴하고 find-in-page·스크린리더·복사를 회복한다.

**성능 판정 기준**: 300p 시나리오 8에서 (a) 8b 풀렌더 DOM 257ms → canvas 목표
~50% 이하, (b) 타이핑 rAF p50 33ms → 16.7ms 이하 (60fps), (c) 노드 수 —
span 179,400 소멸. **헤드리스 페인트 비용 특성상 canvas 이득도 헤드리스에서
과소평가될 수 있으므로 실기 측정을 병행할 것** (L-3 contain 교훈 재적용).

---

## 8. 리스크 레지스터

| 리스크 | 영향 | 방어 |
| --- | --- | --- |
| **드로잉 캐시 stale (굵기/색상)** | 굵게/색상 주입 후 옛 스타일 페인트 | §3.2 수정 설계 — runStyleRef + 페인트 시점 해석. 구조적으로 stale 불가 |
| fillText 메트릭 ≠ opentype advanceWidth → 배치 어긋남 | 글자 겹침·간격 오차 | glyph path 경로(§4.3 B안) 폴백 + parity 검증으로 조기 검출. `_charWidthMmFromFont`가 opentype를 소유하므로 드로잉도 같은 소스로 일치시킬 수 있다 |
| 폰트 로드 전 그리기 (폴백 폰트 페인트) | 빈/틀린 화면 | `document.fonts.ready` 게이트 + `verify-visual-render` 확장. 게이트는 **폰트별 `FontFace.loaded`** 기준으로도 가능해야 한다 — `document.fonts.ready`는 1회 해석되므로 후행 추가 폰트(동적 재초기화)를 커버하지 못한다 |
| **canvas 메모리·DPR 정책** | 문단당 backing store 과다 — 페이지 크기 프레임 @DPR2 ≈ 14MB, 마운트 윈도우 합산 100MB+ 가능 | (a) **DPR 캡 ≤2**, (b) backing store는 **로컬 px** 기준으로 하고 호스트 `scale`은 CSS transform 적용 (DOM 경로와 동일 컴포지팅 — 줌이 GPU 저렴, backing store 불변), (c) `matchMedia('(resolution)')` 변경(모니터 이동·브라우저 줌) 시만 재페인트, (d) parkPage 언마운트 시 canvas 해제 |
| **걸침 클립** | 행두 걸침은 컬럼 기준 음수 x — canvas가 문단 경계로 클립하면 컬럼 0의 행두 글자가 잘린다 (DOM은 `:host overflow: visible`로 생존) | canvas bleed 여백 또는 no-clip 정책 — 걸침 ON 문단의 canvas 경계를 행두 돌출량(`-swidth`)만큼 확장. 패리티 코퍼스에 걸침 케이스 필수 |
| 조합(IME) 중 canvas 재그리기 지연 | 조합 텍스트 깜빡임 | 하이브리드(포커스 문단 DOM 유지)가 영구 아키텍처이므로(§6) 조합은 항상 DOM 경로 — 이 리스크는 하이브리드 아래 구조적으로 소멸 |
| DPR(디바이스 픽셀비)·transform: scale | 흐릿한 텍스트 | canvas 해상도 = mm×ppm×devicePixelRatio, paint 시 scale 환산 — `EditManager.scale` 계약(§VIRTUALIZATION 5) 재적용. + 위 메모리/DPR 정책 (캡 ≤2, CSS transform 스케일링) |
| **이벤트 계약 소실** | React 호스트가 `render-complete`·`render-error`에 의존 — canvas 경로가 발화하지 않으면 호스트 파이프라인 멈춤 | canvas 모드에서 동일 이벤트 발화 강제 (§7). 오버플로 표시 계약(`:host` inset)도 유지 |
| 접근성(스크린 리더·브라우저 검색) 상실 | 접근성 저하 | DOM 모드 병행 유지(전환 플래그) — canvas는 성능 모드. **히든 텍스트 레이어 병기는 필수** (§7) |
| 워커·오프스크린 캔버스 유혹 | 동기 계약 붕괴 | **Web Worker 재시도 금지 계약 유지** (PERFORMANCE §11.1) — canvas paint는 메인 스레드 |

---

## 9. 선행 조건 체크리스트 (이 세션에서 확인한 것)

- [x] 엔진 mm 단일 소스 인벤토리 (§2) — charOffsets/decoRects/getCharRect/
      getOffsetFromPoint/printPostData 모두 엔진 소유 확인
- [x] 편집 좌표 엔진 전환 플래그 존재 (`useEngineCoordinateQueries`) 확인
- [x] DOM span 구조의 비용 귀속 실측 (§2.2a) — 전환이 맞는 해법인지 정밀 확인
- [x] 폰트 파싱(opentype.js)이 엔진 계층 소유 — glyph path 경로 존재
- [x] **Oracle 아키텍처 리뷰 완료 (2026-09-15)** — 판정 "sound with amendments".
      발견 결함: 드로잉 캐시 키의 fontWeight/color 제외 충돌(§3.2), 조합 밑줄
      decoRects 주장 오류(§4.4), baseline 역산의 단일 소스 위반(§4.1).
      발견 함정: 선택 rect 런별 높이/걸침 클립/프레임 로컬 가정(§4.4),
      scale≠1 좌표 provenance(§5 단계 0), 메모리/DPR 정책 부재(§8).
      수정안 전부 본 문서에 반영 완료 — 인용 검증: paragraph-hash.ts:44
      (fontWeight/color 제외 주석), paragraph-engine.ts:1649
      (_refreshInlineStylesOnly in-place 갱신), mapper:615-617 (런별 분리 rect)
- [ ] 단계 0: useEngineCoordinateQueries 전환 + manual QA — **✅ 완료 (2026-09-15,
      회귀 전수 17 스크립트 ALL PASS + scale≠1 코퍼스 — §5 완료 기록)**
- [ ] 드로잉 명령 빌더 (미구현 — §3.2 수정 설계 전제) — **✅ 완료 (2026-09-15,
      단계 1): `src/engine/paragraph-canvas.ts` 신설 — `DrawCommand`
      (char/deco 유니온, mm 단위) + `buildParagraphDrawList` 순수 함수 +
      `ParagraphEngine.drawList` 해시 게이트 캐시 게터
      (`_computeLayoutInputHash` 히트 → O(1), `resetIncrementalState`에서
      무효화). runStyleRef 설계(live inlineStyle + 문단 폴백 참조만 보유,
      폰트/색상 미내장)로 굵기/색상 주입(해시 무영향)에서 stale 페인트가
      구조적으로 불가능. 공백·탭 드로잉 생략, 오버플로 게이팅(print와 동일),
      deco colorName 참조(bake 금지). 검증: `verify-canvas-drawlist.mjs`
      31P ALL PASS — print 패리티(x/y/w 1e-6)·runStyleRef liveness(참조 동일성
      실측)·캐시 히트·DirtyPendingError 게이트·오버플로 제외·deco 좌표·
      멀티컬럼 colLeft 누적·baseline 미내장 확인. snapshot-layout에 drawList
      직렬화 추가(좌표·폰트크기·hangs·hasInlineStyle) — 기존 columnContents
      출력과 byte-identical 확인 + 2회 실행 결정론 확인. 전수 회귀 15 스크립트
      ALL PASS. baseline 게터 — **✅ 단계 2에서 완료**: `getCharAscentMm`
      (opentype ascender/unitsPerEm, `ParsedFont.ascender` 옵셔널 추가,
      폴백 0.8) — paint가 소비**
- [ ] parity 검증기 (미구현 — 선택 rect 패리티 + 폴백 글리프 코퍼스 포함) —
      **✅ 1차 완료 (2026-09-15, 단계 2): `verify-canvas-parity.mjs` 14P ALL
      PASS — 글자 스트림 동일 + left/top 패리티 ≤1mm(전 글자, vertical offset
      공식 보정) + render-complete 발화 + a11y 히든 텍스트 === DOM visible +
      DPR 캡 ≤2 + bleed 확장 + 하이브리드 게이트(포커스 문단 DOM 유지·컨트롤러
      해제 후 canvas 복귀). 미완성(단계 3 범위): 선택 rect 패리티(엔진
      getSelectionRects 신설 후), 폴백 글리프 코퍼스(미등록 한글 음절 + 폰트
      스택 동일성), 픽셀 스팟 체크(스크린샷 비교)**
- [ ] 단계 2: 문단 canvas 렌더러 — **✅ 완료 (2026-09-15)**:
      `src/components/layout/canvas.element.ts` 신설(`x-layout-canvas` —
      drawList 페인트, runStyleRef 페인트 시점 해석, DPR 캡 ≤2, 좌우 bleed
      20mm, 폰트별 로드 게이트 + document.fonts.ready 재페인트, a11y 히든
      텍스트 레이어, resolution listener 재페인트). `LayoutParagraphElement
      .renderMode` 플래그('dom' 기본) + canvas 분기 + 하이브리드 게이트
      (편집 컨트롤러 소유 문단은 항상 DOM — §6 불변식 코드 강제) + canvas↔DOM
      스왑. mapper `getCharOffsetFromPoint` canvas 분기(엔진
      `getOffsetFromPoint` 위임 — 클라이언트 px → 지면 절대 mm 환산).
      `render-complete` 동일 발화. 전수 회귀 19 스크립트 ALL PASS + tsc clean
- [ ] 단계 3: 편집 좌표·시각화 전환 — **✅ 완료 (2026-09-15)**:
      **커서 위치 불일치 근본 결함 발견·수정** — `getCharRect`의 오프셋 공간
      (columnContents 파트 합산, `\n` 미소비)이 커서 모델 공간(plain — textarea·
      walk와 정렬)과 endOfBlock마다 1씩 어긋나 `\n` 이후 라인에서 커서가 한
      글자 뒤/한 라인 아래에 그려졌다. 수정: `getCharRect`가 plain 공간 입력을
      받아 내부에서 `_ccShiftFor`로 cc 공간 보정(이전 endOfBlock 수 카운트),
      `getCursorPlacement` preferLineEnd는 라인 끝 주차 시맨틱 유지(lv 참조 —
      클릭 중간 offset은 same-line 가드가 default 폴백으로 소유), mapper의
      자체 walk 역보정 제거(단일 소스 위임 — 이중 보정 제거). **선택 rect
      엔진 게터 신설**: `getSelectionRects(start, end)` — walk 기반 라인 소속 +
      `_computeAlignOffsetMm`(verticalAlign) + `columnLeftOffset` + 런별
      `_getCharVerticalOffset` 분리 높이(§4.4 계약 1~3항 준수), strip 경계
      폴백(getCharRect와 동일). mapper `getTextRange` canvas 분기(엔진 mm →
      paragraph local px 변환). 검증: caret-parking 28P ALL PASS(수정으로
      FAIL 5건 해소) + `verify-canvas-parity` 선택 rect 패리티 F1~F3 추가
      (DOM getTextRange vs 엔진 getSelectionRects ≤1mm — 17P ALL PASS) +
      전수 회귀 15 스크립트 ALL PASS
- [ ] 단계 4: 성능 실측·스케일 확장 — **✅ 완료 (2026-09-15)**:
      `benchmark-browser.mjs` 시나리오 8f 신설(canvas 모드 실측). 300p 문서
      실측(헤드리스): 8a 빌드 189.3ms / 8b 풀렌더 269.5ms spans=179,400 /
      8c park 244.3ms spans 179,400→1,794 / 8d 재마운트 p95 10.6ms /
      8e DOM 타이핑 입력 동기 p95 0.6ms·rAF 16.8ms / **8f-1 canvas 전환
      201.5ms(윈도우 3p, canvases=3, spans 감소) / 8f-2 canvas 타이핑 입력
      동기 p95 0.5ms·rAF 16.7ms** — 타이핑 핫패스에서 canvas가 DOM과 동등
      이하 수준. 헤드리스 페인트 과소평가 경고(§7)에 따라 실기 측정 병행 권장
- [ ] 단계 5: canvas 기본값화 (철거 아님) — **✅ 완료 (2026-09-15)**:
      `DEFAULT_PARAGRAPH_RENDER_MODE = 'canvas'` 신설(constants/defaults.ts) —
      문단 기본 renderMode가 canvas. 하이브리드 게이트(§6)가 포커스 문단을
      자동으로 DOM 복귀하므로 편집 UX는 DOM 경로 유지. 호스트가 명시적
      `renderMode = 'dom'` 설정 시 기존 동작. 검증망 구성: parity 17P(참조
      구현 비교)·drawlist 31P·caret-parking 28P(DOM 참조) + canvas 모드 전용
      판정은 parity의 canvas 전환 시나리오가 담당.
      **2026-09-15 (2차) — 예제 기본값화 확정**: 예제 페이지의 `renderMode =
      'dom'` 고정(virtualization·threading·bench)과 실험 토글 버튼
      (index·virtualization의 "canvas 렌더")을 철거하고 기본값을 그대로
      소비한다 — 하이브리드 게이트 + `_onFocus` DOM 복귀 렌더
      (verify-remount-canvas 9항목)가 편집 UX를 소유하므로 토글이 불필요하다.
      bench는 시나리오 1~7의 DOM 수치 전제 때문에만 dom 고정을 유지하고,
      300p 시나리오 8의 비-포커스 문단은 기본값(canvas)을 소비한다.
      DOM span을 전제하는 회귀 스크립트(caret-parking·virtualization
      A/H/J/K·progressive-layout·threading-browser·pending-style·
      hanging-browser·right-indent-tab 계열·text-click-focus)는 스크립트
      자체에 `renderMode = 'dom'` 고정을 명시한다 — 검증 대상 경로가 DOM이면
      고정 계약이다 (예제 구성에 의존하지 않는다). 전수 회귀 ALL PASS.

---

## 10. 이 문서를 소비하는 에이전트 지침

1. **먼저 읽을 것**: `AGENTS.md` → `RULES.md` §3 (엔진-우선) → `docs/ENGINE.md`
   → `docs/TEXT_ENGINE.md` → `docs/EDITING_TEXT.md` §3.5.1(좌표 플래그) → 이 문서.
2. **단계 진행 원칙**: §5의 단계별 진행, 각 단계 독립 커밋 + 전수 회귀.
   플래그 OFF 경로가 항상 byte-identical이어야 한다. DOM 경로는 철거 대상이
   아니라 **상시 참조 구현**으로 유지한다 (단계 5 재범위화 — §5, §6).
3. **측정 계약**: scripts/README.md 워크플로 (기준선 → 수정 → 검증 → 재측정).
   이 문서의 예상 효과 수치는 가설이다 — 실측으로 확정하고 여기에 기록할 것.
4. **갱신 계약**: 각 단계 완료 시 §9 체크리스트와 판정 수치를 갱신.
   설계 변경(예: fillText→glyph path 전환)은 §4와 함께 갱신.
5. **금지**: DOM span 트리 제거를 canvas 검증 완료 전에 진행할 것. 편집 좌표를
   DOM rect에서 canvas 픽셀로 역산할 것 (엔진 쿼리만 소비). printPostData 좌표
   공식과 다른 별도 canvas 좌표 계산을 만들 것 (단일 소스 붕괴).
6. **추가 금지 (2026-09-15 Oracle 리뷰)**:
   - DrawCommand에 굵기/색상을 내장하고 레이아웃 해시만으로 캐시 무효화할 것
     (§3.2 결함 재발 — runStyleRef + 페인트 시점 해석 또는 슈퍼셋 키).
   - baseline을 DOM rect bottom에서 역산할 것 — 엔진 게터
     (`getCharBaselineMm` 또는 명령 내장 baseline)로만 소비 (§4.1).
   - 커밋 전 텍스트(IME 조합·optimistic)를 decoRects/columnContents로
     시각화할 것 — 불가능하다 (§4.4 정정). 포커스 문단은 DOM(§6 영구).
   - 선택 rect를 "라인 y × charOffsets" 균일 높이로 산출할 것 — 런별
     `_getCharVerticalOffset`와 걸침 폭, `_computeAlignOffsetMm` 재사용 필수
     (§4.4 계약).
   - canvas를 문단 경계로 클립하고 걸친 글자를 잘라낼 것 — bleed 여백 정책
     필수 (§8 걸침 클립).
   - backing store를 scale 반영 크기로 재조정할 것 — 로컬 px + CSS transform
     (§8 메모리/DPR). DPR은 캡 ≤2.