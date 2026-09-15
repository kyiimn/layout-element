# CANVAS_RENDERING.md — canvas 렌더 전환 계획 (인계 문서)

> **문서 성격**: 설계 계획문. **구현은 아직 시작되지 않았다.** 다른 세션에서
> 이 문서를 기준으로 작업한다. 구현 중 결정 변경이 있으면 이 문서를 갱신할 것.
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
- **이미지·테이블·박스 배경은 DOM 유지**: 1단계는 텍스트 문단만 canvas화.
  이미지는 기존 `<x-layout-image>`(canvas crop) 유지, 오버랩 회피 판정은
  엔진이 계속 소유하므로 상호작용 없다.

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
  for (cmd of _drawList) → ctx.fillText / fillRect(장식선) / drawImage
```

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
| 글자 위치 | span `left=charOffset mm`, 라인 top + `_getCharVerticalOffset` 하단 앵커 | `ctx.fillText(char, x_px, baseline_px)` — 하단 앵커를 baseline 산식으로 변환 (엔진 mm rect의 bottom에서 역산) |
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
여기서 드러난다.

### 4.2 장식선 (decorationRects)

엔진이 mm rect를 이미 산출하므로 `ctx.fillRect(x, y, w, h)` 직접 변환. 색상은
`rect.color`(hex) 또는 `colorName` 재변환. DOM 경로의 `data-deco-key` diff와
달리 드로잉 명령 목록이 항상 재생성되므로 diff 불필요.

### 4.3 하이퍼레이션/오버랩 (텍스트 회피)

오버랩 회피는 **엔진 배치**(파트 분할)가 소유하므로 canvas는 그 결과
(`part.left/width/charOffsets`)를 그리는 것만으로 동일 결과다. 이미지는 별도
DOM(유지)이 canvas 아래/위에 z-index로 배치되거나, 2단계에서 `drawImage`로
흡수한다(오버랩 판정은 `rgbaData` 엔진 픽셀 — 변화 없음).

### 4.4 선택·커서·조합 시각화

| 요소 | 현행 | canvas 모드 |
| --- | --- | --- |
| 커서 (`x-layout-cursor`) | `_updateCursorPosition` → mapper rect | 엔진 `getCharRect`/`getCursorPlacement` mm→px로 위치 계산 (동일 요소 유지) |
| 선택 (`x-layout-selection`) | `getTextRange` (span rect 순회) | 엔진 기반 선택 rect 산출 신설 — 라인 walk(`_cursorLineRanges`)에서 라인 y + charOffsets로 rect 산출 (printPostData와 동일 워크) |
| 조합 밑줄 | span에 deco div 부착 | 엔진 decoRects 경로 재사용 또는 canvas 위 얇은 rect 오버레이 |
| optimistic span | DOM 삽입 즉시 표시 | **대체 필요** — 커밋 전 프레임 피드백은 canvas 부분 재그리기(해당 라인만)로 구현. 또는 편집 중인 문단만 DOM 유지하는 하이브리드(§6) |

---

## 5. 단계별 구현 계획 (각 단계 독립 커밋·검증 원칙)

### 단계 0 — 기반 준비 (기존 인프라 정리)

1. `useEngineCoordinateQueries = true` 전환 + manual QA (한글 IME·영문·혼합) —
   문서 계약(`EDITING_TEXT.md` §3.5.1)대로. `verify-caret-parking` 28P + `verify-ime`
   + `verify-threading-browser` 49P 전수가 이 전환을 방어한다.
2. `getTextRange`/`getFirstColumnRect`/`getLineRect`의 엔진 기반 대응물 설계
   (선택 rect는 `cursorLineRanges` + charOffsets에서 산출).

### 단계 1 — 드로잉 명령 빌더 (Node 검증 가능)

`ParagraphEngine`에 `_drawList` 빌더 추가 (`printPostData`와 동일 워크 — mm 유지).
`verify-engine-node.mjs` 스타일로 **Node에서 명령 목록 검증** (DOM 불필요 —
엔진-우선 원칙 유지). snapshot-layout에 명령 목록 직렬화 추가해 byte-identical
확보.

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

### 단계 5 — 이미지·테이블 흡수, DOM 경로 철거 (별도 감사)

### 각 단계 공통 금지

- DOM 경로 동시 유지 기간(단계 2~4) 중 두 경로의 **좌표 공식 분기 금지** —
  canvas 드로잉은 엔진 게터(printPostData/charOffsets/decoRects)만 소비한다.
  새 좌표 계산을 canvas 쪽에 추가하면 단일 소스 붕괴 (RULES.md §3 위반 —
  감사 §1.5 "판별 규칙" 재인용).
- `verify-canvas-parity` FAIL 상태에서의 다음 단계 진행 금지.

---

## 6. 하이브리드 전략 (전면 전환 전 안전망)

편집 경험이 가장 위험하므로, **포커스 문단만 DOM 유지**하는 하이브리드가
1차 출시 후보다 안전하다:

- 포커스 문단: 기존 DOM span 트리 (커서·optimistic span·조합 밑줄 그대로)
- 비-포커스 문단: canvas 드로잉
- 포커스 전환 시: DOM↔canvas 교체 (문단 1개 — 재렌더 비용 국소)

**효과**: shift 편집 시 하류 프레임(비-포커스)이 canvas 드로잉이 되어 L-2의
96% 재스타일이 소멸하고, 위험(편집 UX)은 포커스 문단의 기존 경로에 고정된다.
이 하이브리드가 단계 2~3의 중간 산출물로 권장된다 (포커스 전환 시
`verify-caret-parking`·`verify-ime` 통과가 조건).

---

## 7. 검증 계획 (신규 스크립트)

| 스크립트 | 목적 | 판정 |
| --- | --- | --- |
| `verify-canvas-parity.mjs` | 동일 문서를 DOM/canvas 양 경로 렌더 → 글자 rect 비교 (ppm 환산) | 글자 rect 오차 ≤1px, 텍스트 내용 동일 |
| `verify-canvas-editing.mjs` | canvas 모드에서 커서 배치·선택 rect·IME 조합 밑줄 | caret-parking 28P 시나리오 재현 ALL PASS |
| `verify-canvas-print-parity.mjs` | canvas 드로잉 명령 === printPostData (같은 엔진 소스) | 명령 목록 일치 |
| 기존 전수 | snapshot-layout (엔진 무변경)·threading·virtualization·page-model 등 | 기존 판정 유지 |

**성능 판정 기준**: 300p 시나리오 8에서 (a) 8b 풀렌더 DOM 257ms → canvas 목표
~50% 이하, (b) 타이핑 rAF p50 33ms → 16.7ms 이하 (60fps), (c) 노드 수 —
span 179,400 소멸. **헤드리스 페인트 비용 특성상 canvas 이득도 헤드리스에서
과소평가될 수 있으므로 실기 측정을 병행할 것** (L-3 contain 교훈 재적용).

---

## 8. 리스크 레지스터

| 리스크 | 영향 | 방어 |
| --- | --- | --- |
| fillText 메트릭 ≠ opentype advanceWidth → 배치 어긋남 | 글자 겹침·간격 오차 | glyph path 경로(§4.3 B안) 폴백 + parity 검증으로 조기 검출. `_charWidthMmFromFont`가 opentype를 소유하므로 드로잉도 같은 소스로 일치시킬 수 있다 |
| 폰트 로드 전 그리기 (폴백 폰트 페인트) | 빈/틀린 화면 | `document.fonts.ready` 게이트 + `verify-visual-render` 확장 |
| 조합(IME) 중 canvas 재그리기 지연 | 조합 텍스트 깜빡임 | 하이브리드(포커스 문단 DOM 유지) 또는 조합 중 프레임 클립 부분 재그리기 — `verify-ime` 재실행 |
| DPR(디바이스 픽셀비)·transform: scale | 흐릿한 텍스트 | canvas 해상도 = mm×ppm×devicePixelRatio, paint 시 scale 환산 — `EditManager.scale` 계약(§VIRTUALIZATION 5) 재적용 |
| 접근성(스크린 리더·브라우저 검색) 상실 | 접근성 저하 | DOM 모드 병행 유지(전환 플래그) — canvas는 성능 모드. 필요 시 aria 텍스트 병기 |
| 워커·오프스크린 캔버스 유혹 | 동기 계약 붕괴 | **Web Worker 재시도 금지 계약 유지** (PERFORMANCE §11.1) — canvas paint는 메인 스레드 |

---

## 9. 선행 조건 체크리스트 (이 세션에서 확인한 것)

- [x] 엔진 mm 단일 소스 인벤토리 (§2) — charOffsets/decoRects/getCharRect/
      getOffsetFromPoint/printPostData 모두 엔진 소유 확인
- [x] 편집 좌표 엔진 전환 플래그 존재 (`useEngineCoordinateQueries`) 확인
- [x] DOM span 구조의 비용 귀속 실측 (§2.2a) — 전환이 맞는 해법인지 정밀 확인
- [x] 폰트 파싱(opentype.js)이 엔진 계층 소유 — glyph path 경로 존재
- [ ] 단계 0: useEngineCoordinateQueries 전환 + manual QA (미수행 — 첫 작업)
- [ ] 드로잉 명령 빌더 (미구현)
- [ ] parity 검증기 (미구현)

---

## 10. 이 문서를 소비하는 에이전트 지침

1. **먼저 읽을 것**: `AGENTS.md` → `RULES.md` §3 (엔진-우선) → `docs/ENGINE.md`
   → `docs/TEXT_ENGINE.md` → `docs/EDITING_TEXT.md` §3.5.1(좌표 플래그) → 이 문서.
2. **단계 진행 원칙**: §5의 단계별 진행, 각 단계 독립 커밋 + 전수 회귀.
   플래그 OFF 경로가 항상 byte-identical이어야 한다 (DOM 경로 철거는 마지막에).
3. **측정 계약**: scripts/README.md 워크플로 (기준선 → 수정 → 검증 → 재측정).
   이 문서의 예상 효과 수치는 가설이다 — 실측으로 확정하고 여기에 기록할 것.
4. **갱신 계약**: 각 단계 완료 시 §9 체크리스트와 판정 수치를 갱신.
   설계 변경(예: fillText→glyph path 전환)은 §4와 함께 갱신.
5. **금지**: DOM span 트리 제거를 canvas 검증 완료 전에 진행할 것. 편집 좌표를
   DOM rect에서 canvas 픽셀로 역산할 것 (엔진 쿼리만 소비). printPostData 좌표
   공식과 다른 별도 canvas 좌표 계산을 만들 것 (단일 소스 붕괴).