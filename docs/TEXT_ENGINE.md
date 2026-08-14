# TextLayoutEngine 상세 명세

> 작성 기준: `src/core/text-layout-engine.ts` 및 관련 타입, 컴포넌트, 유틸리티 소스 코드
>
> 본 문서는 `TextLayoutEngine`의 렌더링 파이프라인, 텍스트 측정, 오버랩 회피, 데이터 구조, DOM 계층, 스타일 생성, 공개 API를 상세히 기술한다.

---

## 1. 개요 (Overview)

`TextLayoutEngine`은 신문 레이아웃 엔진의 핵심 텍스트 래핑 모델이다.
입력된 텍스트를 다중 컬럼 구조에 맞게 줄바꿈하고, 이미지 등 다른 요소와의 겹침을 회피하며,
글자 단위로 DOM에 배치할 수 있는 `TextLineData[][]`를 생성한다.

인스턴스는 `TextLayoutEngine.create(options)` 팩토리 메서드로만 생성할 수 있다. 직접 `new` 사용은 금지되며,
생성자가 `private`이기 때문이다.

```ts
const model = TextLayoutEngine.create({
  content: "...",
  column: 2,
  gap: 3,
  paragraphStyle: { textAlign: 'justify', lineGap: 1.2 },
  textStyle: { widthRatio: 0.95 },
  inheritStyle: { ... },
  paragraphEl: paragraphElement,
  rootNode: shadowRoot,
});
```

핵심 특징:

- 모든 레이아웃 크기는 **mm**(밀리미터) 단위이다.
- `ppm`(pixels-per-mm)을 통해 화면 픽셀로 변환한다.
- 텍스트 래핑은 **폰트 메트릭(`glyph.advanceWidth`)** 기반으로 수행한다. DOM `scrollWidth > clientWidth` 방식은 사용하지 않는다.
- 오버랩 회피는 실제 렌더링된 요소의 `getBoundingClientRect()`를 기준으로 계산한다.
- 한 렌더링 사이클 내에서 오버랩 요소의 `DOMRect`를 캐싱하여 반복 측정을 줄인다.

---

## 2. 3단계 렌더링 파이프라인

`TextLayoutEngine`은 다음 3단계 파이프라인으로 동작한다.

```mermaid
flowchart TD
    A[입력 콘텐츠] -->|_parseContents| B[TextBlockData[]]
    B -->|_layoutTextIntoColumns| C[TextLineData[][]<br/>줄, 파트, 글자 배치 완료]
    C -->|columnContents| D[LayoutColumnElement.renderText]
```

### 2.1 Phase 1: 파싱 (`_parseContents`)

입력 콘텐츠를 `\n` 단위로 분리하여 `TextBlockData[]`로 변환한다.

- 단순 문자열: `{ content: "..." }`로 래핑 후 분리
- 배열: 각 원소가 `string`이면 `{ content: "..." }`로 변환, `TextBlockData`이면 그대로 사용 후 분리
- 분리된 각 블록은 독립적인 줄바꿈 단위가 된다.

결과는 `this._contents`에 저장된다.

### 2.2 Phase 2: 구조 측정 (`layoutStructure` / `_initStructureAndMeasureColumns`)

`_initStructureAndMeasureColumns()`에서 컬럼 폭, 간격, 줄 높이를 계산하고, 가상 컬럼을 생성해 컬럼별 `ppm`을 측정한 뒤 제거한다.

- `_columnWidths`, `_gaps`, `_lineHeight` 초기화
- 각 컬럼마다 `x-layout-vcolumn`을 임시로 생성해 `ppm` 측정
- 측정 후 가상 컬럼 제거

### 2.3 Phase 3: 텍스트 배치 (`layoutText` / `_layoutTextIntoColumns`)

`_layoutTextIntoColumns()`가 전체 래핑을 담당한다. 이 메서드 안에서 다음 작업이 한 번에 이루어진다.

1. `_parseContents()`로 최신 텍스트 반영
2. 컬럼별 가상 컬럼 생성
3. 라인 단위로 `_createLineWithParts()` 호출 (오버랩 감지 + 자유 영역 분할 + 파트 생성)
4. 글자를 `partWidths`와 `_charWidthPx()`로 비교해 배치
5. 블록 경계, 오버플로우, COVER 라인, 무한 루프 방지 처리
6. 결과를 `_columnContents`에 저장

---

## 3. `layoutText()` 흐름

`layoutText()`는 전체 텍스트 래핑을 수행하는 공개 메서드이다.

```mermaid
flowchart TD
    Start([layoutText]) --> Reset[_overlayRects = null<br/>_columnContents = []<br/>_overflow = 0]
    Reset --> Parse[_parseContents]
    Parse --> Count{columnCount >= 1?}
    Count -->|No| End1[return]
    Count -->|Yes| Loop{각 컬럼}
    Loop --> CreateVC[가상 컬럼 생성<br/>x-layout-vcolumn]
    CreateVC --> InitState[partWidths, cumulativeWidths<br/>currentPartIdx 초기화]
    InitState --> BlockLoop{각 TextBlockData}
    BlockLoop --> NeedLine{새 라인 필요?}
    NeedLine -->|Yes| CreateLine[_createLineWithParts]
    CreateLine --> Cover{cover?}
    Cover -->|Yes| PushCover[columnContent.push<br/>빈 파트 라인]
    PushCover --> Overflow1{isOverflow?}
    Overflow1 -->|Yes| ColumnBreak1[break]
    Overflow1 -->|No| NeedLine
    Cover -->|No| PushLine[columnContent.push<br/>lineEl, partEls, partWidths]
    PushLine --> CharLoop{각 문자}
    CharLoop --> Width[_charWidthPx + letterSpacing]
    Width --> TryPart[현재 파트에 적용]
    TryPart --> Fits{cumulative + charWidth <= partWidth?}
    Fits -->|Yes| PlaceChar[content.push char]
    Fits -->|No| NextPart[다음 파트 시도]
    NextPart --> Fits2{맞는 파트?}
    Fits2 -->|Yes| PlaceChar2[content.push char]
    Fits2 -->|No| NewLine[_createLineWithParts]
    NewLine --> Fits3{맞는 파트?}
    Fits3 -->|Yes| PlaceChar3[content.push char]
    Fits3 -->|No| InfiniteGuard{charWidth > maxPartWidth?}
    InfiniteGuard -->|Yes| ForcePlace[첫 번째 파트에 강제 배치]
    InfiniteGuard -->|No| RemoveEmpty[빈 마지막 줄 제거<br/>재시도]
    ForcePlace --> CharLoop
    RemoveEmpty --> NewLine
    PlaceChar --> CharLoop
    PlaceChar2 --> CharLoop
    PlaceChar3 --> CharLoop
    CharLoop -->|완료| BlockLoop
    BlockLoop -->|완료| EndOfText[endOfText 플래그 설정]
    EndOfText --> RemoveVC[가상 컬럼 제거]
    RemoveVC --> Cache[_columnContents.push]
    Cache --> Loop
    Loop -->|완료| End2([end])
    ColumnBreak1 --> EndOfText
```

각 컬럼 처리 상세:

1. `x-layout-vcolumn` 생성
2. `index`, `model`, `parentElement` 설정
3. `rootNode`에 삽입
4. `ppm = _columnPpm[curColumn]` (구조 측정 단계에서 미리 측정)
5. `_layoutTextIntoColumns()`가 라인 생성, 오버랩 감지, 글자 배치를 수행
6. `endOfText` 조건이면 마지막 라인에 `endOfText = true` 설정
7. 가상 컬럼 제거
8. `_columnContents.push(columnContent)`

---

## 4. 증분 상태와 재생성

`TextLayoutEngine`은 증분 렌더링을 지원하지 않는다. 텍스트 내용이 바뀌면 `layoutText()`를 다시 호출해 전체 래핑을 재계산한다.

### 4.1 상태 초기화 (`resetIncrementalState`)

구조 변경 후 전체 재생성을 보장하기 위해 `_previousLineCount`와 `_previousOverflow`를 `-1`로 되돌린다.

```ts
public resetIncrementalState() {
  this._previousLineCount = -1;
  this._previousOverflow = -1;
}
```

### 4.2 `textContent` 변경 흐름

```mermaid
flowchart TD
    Start([textContent = value]) --> SetValue[_textContent 갱신]
    SetValue --> Caller[호출자가 layoutStructure + layoutText 호출]
    Caller --> InitStruct[_initStructureAndMeasureColumns<br/>컬럼/ppm 재측정]
    InitStruct --> LayoutText[_layoutTextIntoColumns<br/>전체 재래핑]
    LayoutText --> Render[LayoutColumnElement.renderText]
```

`textContent` 세터는 값만 갱신하고, 실제 래핑은 호출자가 `layoutStructure()`와 `layoutText()`를 명시적으로 호출할 때 수행된다.

---

## 5. 오버랩 회피 메커니즘

### 5.1 개념

이미지 등 다른 요소가 텍스트 영역과 겹칠 때, `TextLayoutEngine`은 두 가지 상황을 구분한다.

- **COVER**: 라인 전체가 덮여 글자를 배치할 수 없음
- **PART**: 라인 일부가 덮임

### 5.2 `_detectOverlapWithCache()`

`overlayElements`(부모 박스의 오버랩 요소 + 더 높은 zIndex를 가진 형제 박스)를 순회하며 겹침을 계산한다.

```ts
private _detectOverlapWithCache(lineEl: HTMLElement): { cover: boolean; overlapParts: OverlapParts[] }
```

동작:

1. `_overlayRects`가 null이면 모든 오버랩 요소를 한 번만 `getBoundingClientRect()`로 측정해 `Map`에 저장
2. 각 오버랩 요소에 대해 `getOverlapSizePX(lineEl, el)` 호출
3. `COVERS`가 하나라도 있으면 `cover = true`
4. `PART`면 `overlapParts`에 병합
5. `cover`인 경우 `lineEl.style.width = '0'` 설정, `maxWidth`도 동일하게 설정

이미지 픽셀 탐색이 먼저 수행된다. `getOverlapSizePX`가 `COVERS`를 반환해야 기하학적 COVER 판정으로 이어진다. 투명 영역만 겹치면 COVER로 처리되지 않는다.

### 5.2.1 오버랩 요소 변경 시 단락 재렌더링 트리거

`overlayElements` 게터는 호출 시점에 평가되므로, 오버랩 요소(형제 박스/이미지)가 추가·제거·zIndex 변경되면 기존 단락들이 새 오버랩 관계를 반영하도록 재렌더링되어야 한다.

`LayoutBoxElement`는 `requestRerenderAffectedParagraphs()` 메커니즘을 통해 이를 처리한다. 다음 경로에서 호출된다:

| 경로 | 메서드 | 호출 시점 |
|------|--------|----------|
| 박스 zIndex 변경 | `LayoutBoxElement.zIndex` setter | `layout()` 후 |
| 박스/단락/이미지 추가 (public API) | `LayoutBoxElement.appendChildData()` | `appendChild()` 후 |
| 박스 `data` setter (자식 일괄 구축) | `LayoutBoxElement.data` setter | `render()` 후 |
| 이미지 zIndex 변경 | `LayoutImageElement.zIndex` setter | `render()` 후 |
| 이미지 overlapPadding 변경 | `LayoutImageElement.overlapPadding` setter | `render()` 후 |

`requestRerenderAffectedParagraphs()` → `scheduleRerenderAffectedParagraphs()` → `_collectAffectedParagraphs()` → `_renderAffectedParagraphs()` 흐름으로 동작한다:

1. **`_collectAffectedParagraphs()`**: 자식 박스를 재귀 탐색하여 모든 단락 수집 + 형제 박스의 자식 단락도 수집 (오버랩 영향 반영)
2. **`_renderAffectedParagraphs()`**: 수집된 단락의 `markStructureChangedAndRender()` 호출 → `_perfStructureChanged = true` + `render()` → `TextLayoutEngine`이 새 `overlayElements`로 재평가

> **주의**: `appendChildData()`는 각 자식 추가마다 `requestRerenderAffectedParagraphs()`를 호출한다. `data` setter는 자식을 일괄 추가한 후 마지막에 한 번만 호출하여 중복 렌더링을 방지한다. `_appendChildData()` (private)는 `data` setter에서만 호출되므로 별도로 호출하지 않는다.

### 5.3 `_computeFreeRegions()`

오버랩 영역의 여집합으로부터 텍스트가 배치될 수 있는 자유 영역을 계산한다.

```ts
private _computeFreeRegions(lineWidth: number, overlapParts: OverlapParts[]): FreeRegion[]
```

```ts
type FreeRegion = { start: number; end: number }; // pixels
```

알고리즘:

1. 오버랩이 없으면 `[{ start: 0, end: lineWidth }]` 반환
2. 정렬된 overlapParts를 순회하며 `prevEnd`부터 `overlap.x1` 사이 구간을 자유 영역으로 추가
3. `prevEnd`를 `max(prevEnd, overlap.x2)`로 갱신
4. 마지막 오버랩 이후 남은 공간도 자유 영역으로 추가

### 5.4 `_createLineWithParts()`

라인 하나를 생성하고 오버랩을 감지해 파트를 구성한다.

```ts
private _createLineWithParts(
  vColumnEl: HTMLElement,
  textBlockStyle: TextBlockStyle | undefined,
  ppm: number,
  isFirstInColumn: boolean,
  isFirstOfBlock: boolean,
): {
  cover: boolean;
  overflow: boolean;
  lineEl: HTMLDivElement | null;
  partEls: HTMLDivElement[];
  partWidths: number[];
  lineData: TextLineData;
}
```

주요 작업:

1. `_createLineElement()`로 라인 요소 생성
2. `_detectOverlapWithCache()`으로 오버랩 감지
3. COVER면 빈 `TextLineData` 반환
4. OVERFLOW면 플래그만 반환 (lineEl은 DOM에 유지)
5. `lineWidth`를 px에서 mm로 변환 (`getBoundingClientRect().width / ppm`)
6. `overlapParts`를 px에서 mm로 변환 (`x1 / ppm`, `x2 / ppm`)
7. `_computeFreeRegions()`로 자유 영역 계산 (mm 단위)
8. **문단 첫 줄 들여쓰기**: `isFirstOfBlock`이 `true`이면(각 문단/block의 첫 줄) 첫 자유 영역의 `start`를 `fontSize × indent`만큼 오른쪽으로 밀어준다. `indent`는 `TextStyle.indent`(0.0~1.0)이며 `fontSize`에 대한 비율이다.
9. **좁은 자유 영역 필터링**: 글자 하나가 들어갈 수 없는 좁은 자유 영역은 제외한다. 기준은 전각 문자 폭 상한(`widthRatio × fontSize + letterSpacing × fontSize`). 이 필터링이 없으면 무한 루프 가드가 좁은 틈에 글자를 강제 배치하여 파트 폭을 넘어 렌더링되는 현상이 발생한다. 필터링 후 남은 자유 영역이 없으면 COVER로 처리된다.
10. 자유 영역별 `TextPartData`, `partEls`, `partWidths` 생성 (모두 mm 단위)
11. 파트 사이 간격은 `marginLeft`로 설정 (mm 단위 CSS)

### 5.5 COVER vs PART 시각적 예시

```text
CASE A: COVER (라인 전체 덮임)

    ┌─────────────────────────────────────┐
    │           TEXT LINE                 │  ← 이미지가 라인 전체를 덮음
    └─────────────────────────────────────┘
              ↓
    lineEl.style.width = '0'
    parts: []
    lineEl: null

CASE B: PART (라인 일부 덮임)

    ┌─────┬───────────┬───────────────────┐
    │FREE │  OVERLAP  │       FREE        │
    │     │  (IMAGE)  │                   │
    └─────┴───────────┴───────────────────┘
      ↑        ↑            ↑
    Part0   covered      Part1
    left=0              left=overlap_end
    width=100           width=200

CASE C: FREE (오버랩 없음)

    ┌─────────────────────────────────────┐
    │           FREE SPACE                │
    └─────────────────────────────────────┘
              ↓
    parts: [{ left: 0, width: lineWidth }]
```

### 5.6 자유 영역 계산 예시

```text
lineWidth = 300px
overlapParts = [{ x1: 80, x2: 120 }, { x1: 200, x2: 240 }]

    0        80   120       200   240     300
    ├────────┤────┤─────────┤────┤───────┤
    │ FREE 1 │OL1 │  FREE 2 │OL2 │ FREE 3│
    └────────┘────┘─────────┘────┘───────┘

freeRegions = [
  { start: 0,   end: 80  },
  { start: 120, end: 200 },
  { start: 240, end: 300 }
]
```

---

## 6. 글자 폭 측정 (`_charWidthMm()`)

### 6.1 개요

`_charWidthMm()`는 폰트 메트릭 테이블(`hmtx`)을 직접 파싱하여 문자의 advance width를 mm 단위로 반환한다. opentype.js로 파싱된 폰트 객체에서 `glyph.advanceWidth / unitsPerEm * fontSize`로 계산한다. 같은 TTF 파일을 사용하는 한 환경(브라우저 엔진/OS/DPI)에 무관하게 동일한 값을 반환하므로, 모니터 작업 결과가 서버 재렌더링/윤전기 인쇄물과 동일하게 보장된다.

```ts
private _charWidthMm(char: string, textBlockStyle?: TextBlockStyle): number {
  const fontSize = textBlockStyle?.fontSize || this._textStyle?.fontSize || this._inheritStyle?.fontSize || DEFAULT_FONT_SIZE;
  const minWidthMm = this.spaceRatio * fontSize;

  if (char === ' ') {
    return minWidthMm;
  }

  const fontWidth = this._charWidthMmFromFont(char, textBlockStyle, fontSize);
  if (fontWidth !== null) {
    return Math.max(fontWidth, minWidthMm);
  }

  return minWidthMm;
}

private _charWidthMmFromFont(char: string, textBlockStyle: TextBlockStyle | undefined, fontSize: number): number | null {
  const fontLoader = FontLoader.getInstance();
  const fontName = textBlockStyle?.fontFamily;
  const parsedFont = fontLoader.getParsedFont(fontName);
  if (!parsedFont) return null;

  const glyph = parsedFont.charToGlyph(char);
  if (!glyph || glyph.advanceWidth === undefined || glyph.advanceWidth === null) {
    return null;
  }

  return (glyph.advanceWidth / parsedFont.unitsPerEm) * fontSize;
}
```

### 6.2 핵심 포인트

- `glyph.advanceWidth / unitsPerEm * fontSize`로 mm 폭을 직접 계산한다. ppm 변환을 거치지 않으므로 환경(브라우저 엔진/OS/DPI)에 완전히 무관하며, 같은 TTF 파일을 사용하는 한 클라이언트 ↔ 서버 간 동일한 결과를 보장한다.
- **장평(`widthRatio`) 처리**: `_charWidthMm`은 **원본 폭(장평 미적용)**을 반환. 장평 곱셈은 호출자(`_layoutTextIntoColumns` 줄바꿈 계산, `genCharStyle` DOM `width`)에서 각각 적용한다. DOM은 외부 span에 `width`로 정확히 고정하고 내부 span에 `scale`로 glyph 축소를 적용하여 측정값과 렌더링을 결정론적으로 일치시킨다 — 마지막 글자가 틀을 넘어가는 현상을 방지한다.
- **`Math.round()`를 사용하지 않는다.** 부동소수점 정밀도를 보존하여 서로 다른 scale에서 동일한 줄바꿈 결과를 보장한다.
- **최소 폭(`minWidthMm`)**: 결함 글리프(0폭/비정상적 narrow) 방어. `spaceRatio × fontSize`를 바닥값으로 사용한다.
- **공백 처리**: 공백은 폰트 메트릭 조회 없이 `spaceRatio * fontSize`로 고정한다.

### 6.3 폰트 파싱 실패 시 폴백

- 폰트 파싱에 실패했거나 특정 글리프를 찾을 수 없는 경우 `_charWidthMmFromFont`가 `null`을 반환하고 `_charWidthMm`은 `minWidthMm` 바닥값을 사용한다.
- `FontLoader._parsed === false`이면 이후 모든 폰트 조회 시도가 즉시 `null`을 반환하여 불필요한 오버헤드를 방지한다.
- **`base64Data`가 없는 폰트**: `ttfFilename` 경로의 폰트는 별도 fetch가 필요하므로 파싱 캐시에서 누락될 수 있다. 화면 모드에서 `base64Data`가 우선되므로 대부분의 케이스가 커버된다.

---

## 7. `_layoutTextIntoColumns()` 글자 배치 알고리즘

### 7.1 흐름

`_layoutTextIntoColumns()`는 다음 순서로 동작한다.

1. `_parseContents()`로 최신 `_contents` 생성
2. `_columnContents`, `_overflow`, `_overlayRects` 초기화
3. 각 컬럼마다 가상 컬럼 생성
4. 각 블록의 각 문자에 대해
   - 현재 파트에 배치 가능하면 배치
   - 안 되면 다음 파트 시도
   - 전 파트가 안 되면 새 라인 생성 후 재시도
   - 새 라인에서도 안 되면 무한 루프 방지 처리
5. 컬럼이 꽉 차면 다음 컬럼으로 이동. 마지막 컬럼이면 `_overflow` 증가
6. 마지막 컬럼 처리 후 `endOfText` 플래그 설정
7. **`_applyLineBreakRules()` 후처리** — 한글 조판 금칙문자 규칙 적용 (§22 참조)

### 7.2 블록 경계 처리

`\n`으로 분리된 각 블록은 새 라인에서 시작한다.

```ts
if (idxBlock !== beforeIdxBlock) idxContentOfBlock = 0;
```

블록이 바뀌면 `idxContentOfBlock`를 0으로 재설정하고, 새 라인을 생성한다.
블록의 마지막 문자가 배치되면 `endOfBlock = true`를 설정한다.

### 7.3 letterSpacing 처리

```ts
const letterSpacingEm = this._textStyle?.letterSpacing || this._inheritStyle?.letterSpacing || 0;
const letterSpacingFontSize = block.textBlockStyle?.fontSize || this._textStyle?.fontSize || this._inheritStyle?.fontSize || DEFAULT_FONT_SIZE;
const letterSpacingMm = letterSpacingEm * letterSpacingFontSize;
```

`letterSpacing`은 em 단위로 지정되며, 실제 mm 폭은 `letterSpacing * fontSize`로 계산된다 (mm 단위).
각 문자 폭에 `letterSpacingMm`를 더해 파트 가용 폭(mm)과 비교한다.

### 7.4 오버플로우 처리

- 마지막 컬럼이 아닌 경우: 비어 있지 않은 마지막 줄은 유지하고, 빈 줄은 제거한 뒤 다음 컬럼으로 이동
- 마지막 컬럼인 경우: `_overflow++`

```ts
if (vColumnEl.isOverflow) {
  if (curColumn < this._columnWidths.length - 1) {
    if (idxContentOfBlock < block.content.length - 1) {
      columnContent = this._removeTrailingEmptyLine(columnContent);
    }
    break;
  } else {
    this._overflow++;
  }
}
```

### 7.5 무한 루프 방지

문자가 모든 파트 폭보다 넓으면, 해당 문자를 새 라인의 첫 번째 파트에 강제로 배치하고 재시도 루프를 빠져나간다.

```ts
if (currentPartIdx >= partWidths.length) {
  const maxPartWidth = partWidths.length > 0 ? Math.max(...partWidths) : 0;
  if (charWidth > maxPartWidth + 1e-6) {
    columnContent[columnContent.length - 1].parts[0].content.push(char);
    break;
  }
  // ... 기존 재시도 로직
}
```

이 guard는 컬럼 폭보다 넓은 문자(드문 경우)가 있을 때 무한 루프를 방지한다.

### 7.6 빈 마지막 줄 제거

`_removeTrailingEmptyLine()`은 마지막 줄의 모든 파트가 비어 있으면 해당 줄을 제거한다.

```ts
private _removeTrailingEmptyLine(columnContent: TextLineData[]): TextLineData[] {
  if (columnContent.length > 0 && columnContent[columnContent.length - 1].parts.every(p => p.content.length === 0)) {
    return columnContent.slice(0, columnContent.length - 1);
  }
  return columnContent;
}
```

---

## 8. 오버랩 rect 캐시 (`_overlayRects`)

### 8.1 목적

한 번의 렌더링 사이클 내에서 동일한 오버랩 요소에 대해 `getBoundingClientRect()`를 반복 호출하지 않도록 캐싱한다.

### 8.2 생명 주기

```mermaid
flowchart LR
    A[_initStructureAndMeasureColumns] -->|_overlayRects = null| B[_layoutTextIntoColumns]
    B -->|_overlayRects = null| C[_detectOverlapWithCache 첫 호출]
    C -->|Map 생성| D[이후 _detectOverlapWithCache 호출]
    D -->|Map.get(el)| E[재사용]
    E -->|다음 렌더링 사이클| A
```

### 8.3 동작

```ts
private _overlayRects: Map<LayoutBoxElement, DOMRect> | null = null;
```

```ts
if (this._overlayRects === null) {
  this._overlayRects = new Map();
  for (const el of overlapEls) {
    this._overlayRects.set(el, el.getBoundingClientRect());
  }
}
```

`_detectOverlapWithCache()`가 처음 호출될 때 모든 오버랩 요소를 한 번 측정해 `Map`에 저장한다. 이후 호출에서는 `this._overlayRects.get(el)`로 재사용한다.

---

## 9. 데이터 구조

### 9.1 `TextLayoutEngineOptions`

```ts
type TextLayoutEngineOptions = {
  content: string | (string | TextBlockData)[];
  column: number | number[];
  gap: number | number[];
  paragraphStyle: ParagraphStyle;
  textStyle: TextStyle;
  inheritStyle: InheritStyle;
  paragraphEl: LayoutParagraphElement;
  rootNode: Node;
};
```

### 9.2 `TextLineData`

```ts
export type TextLineData = {
  firstOfBlock?: boolean;
  firstOfText?: boolean;
  endOfBlock?: boolean;
  endOfText?: boolean;
  parts: TextPartData[];
  textBlockStyle?: TextBlockStyle;
};
```

플래그 조합:

| firstOfBlock | endOfBlock | firstOfText | endOfText | 의미 |
| :---: | :---: | :---: | :---: | ------ |
| ✓ | ✓ | ✓ | ✓ | 전체 텍스트가 한 줄 |
| ✓ | | ✓ | | 첫 블록의 첫 줄 |
| | ✓ | | | 어떤 블록의 마지막 줄 |
| ✓ | | | | 새 블록의 시작 줄 |
| | | | ✓ | 전체 텍스트의 마지막 줄 |

### 9.3 `TextPartData`

```ts
export type TextPartData = {
  content: string[]; // 글자 배열
  left: number;      // mm 단위 좌측 여백
  width: number;     // mm 단위 폭
};
```

### 9.4 `OverlapParts`

```ts
export type OverlapParts = { x1: number; x2: number; };
```

픽셀 단위의 겹침 구간이다.

### 9.5 `FreeRegion`

```ts
type FreeRegion = { start: number; end: number };
```

`_computeFreeRegions()`의 반환 타입. 픽셀 단위이다.

---

## 10. DOM 구조 계층

### 10.1 전체 트리

```text
<x-layout-document>
  └── <x-layout-box>
        └── <x-layout-paragraph>
              ├── #shadow-root
              │     ├── <style>
              │     ├── <slot>
              │     ├── <x-layout-vcolumn>    (임시, 측정 중에만 존재)
              │     │     ├── #shadow-root
              │     │     │     └── <style>
              │     │     └── <div>           (line)
              │     │           └── <div>     (part)
              │     │                 └── <span>  (char)
              │     └── <x-layout-column>
              │           ├── #shadow-root
              │           │     └── <style>
              │           └── <div>           (line)
              │                 └── <div>     (part)
              │                       └── <span>  (char)
              └── (slot을 통해 박스 자식 접근)
```

### 10.2 ASCII 다이어그램

```text
┌─────────────────────────────────────────┐
│      <x-layout-paragraph>               │
│  ┌─────────────────────────────────┐    │
│  │  #shadow-root                   │    │
│  │                                 │    │
│  │  ┌─────────────────────────┐    │    │
│  │  │ <x-layout-vcolumn>      │    │    │
│  │  │  (측정용, 임시)          │    │    │
│  │  │  ┌─────┐ ┌─────┐ ┌────┐ │    │    │
│  │  │  │line │ │line │ │line│ │    │    │
│  │  │  │ ┌─┐ │ │ ┌─┐ │ │ ┌┐ │ │    │    │
│  │  │  │ │p│ │ │ │p│ │ │ │p│ │ │    │    │
│  │  │  │ │┌┐│ │ │ │┌┐│ │ │ └┘ │ │    │    │
│  │  │  │ ││c││ │ │ ││c││ │ │    │ │    │    │
│  │  │  │ │└┘│ │ │ │└┘│ │ │    │ │    │    │
│  │  │  └─────┘ └─────┘ └────┘ │    │    │
│  │  └─────────────────────────┘    │    │
│  │            ↓ 측정 완료 후 제거    │    │
│  │  ┌─────────────────────────┐    │    │
│  │  │ <x-layout-column>       │    │    │
│  │  │  (실제 렌더링)           │    │    │
│  │  │  ┌─────┐ ┌─────┐ ┌────┐ │    │    │
│  │  │  │line │ │line │ │line│ │    │    │
│  │  │  │ ┌─┐ │ │ ┌─┐ │ │ ┌┐ │ │    │    │
│  │  │  │ │p│ │ │ │p│ │ │ │p│ │ │    │    │
│  │  │  │ │┌┐│ │ │ │┌┐│ │ │ └┘ │ │    │    │
│  │  │  │ ││c││ │ │ ││c││ │ │    │ │    │    │
│  │  │  │ │└┘│ │ │ │└┘│ │ │    │ │    │    │
│  │  │  └─────┘ └─────┘ └────┘ │    │    │
│  │  └─────────────────────────┘    │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘

legend:
  line = <div>  (flex row)
  p    = <div>  (part, inline-flex)
  c    = <span> (char, inline-block)
```

---

## 11. 스타일 생성

### 11.1 `genColumnStyle(idx)`

컬럼의 absolute positioning 스타일을 생성한다.

```ts
public genColumnStyle(idx: number): Partial<CSSStyleDeclaration>
```

주요 계산:

- `left`: 이전 컬럼들의 너비 + 간격 합
- `width`, `minWidth`, `maxWidth`, `flex`: `columnWidths[idx]`
- `height`, `minHeight`, `maxHeight`: `inheritStyle.parentHeight`
- `justifyContent`: `verticalAlign`에 따라 `center`, `flex-end`, `flex-start`

### 11.2 `genLineStyle(textBlockStyle?)`

줄(line) 요소의 스타일을 생성한다.

```ts
public genLineStyle(textBlockStyle?: TextBlockStyle): Partial<CSSStyleDeclaration>
```

- `display: 'flex'`, `flexDirection: 'row'`, `flexWrap: 'nowrap'`, `flexShrink: '0'`
- `height`: `_lineHeight` mm
- `fontSize` override가 줄 높이보다 크면 `alignItems: 'center'` 및 높이 조정

### 11.3 `genPartStyle(textBlockStyle?)`

파트(part) 요소의 스타일을 생성한다.

```ts
public genPartStyle(textBlockStyle?: TextBlockStyle): Partial<CSSStyleDeclaration>
```

- `display: 'inline-flex'`, `flexDirection: 'row'`, `alignItems: 'baseline'`
- `letterSpacing`: em 단위
- `textAlign` → `justify-content` 매핑
  - `'left'` → `flex-start`
  - `'right'` → `flex-end`
  - `'center'` → `center`
  - `'justify'` → `space-between`
- `textBlockStyle`이 있으면 폰트, 크기, 색상, 정렬 오버라이드

### 11.4 `genCharStyle(char)`

글자(char) 요소의 외부 span 스타일을 생성한다. 이중 span 구조에서 외부 span을 담당한다.

```ts
public genCharStyle = (char: string): Partial<CSSStyleDeclaration>
```

외부 span과 내부 span의 이중 구조를 사용한다:

```html
<span data-source-offset="N" style="width: 3.2mm; overflow: hidden; display: inline-block;">
  <span data-char-inner style="scale: 0.8 1; display: inline-block;">
    한
  </span>
</span>
```

**외부 span** (`genCharStyle` 반환):
- `display: 'inline-block'`
- `width`: `${rawWidth × widthRatio}mm` (정확한 폭 고정)
- `overflow: 'hidden'` (glyph 넘침 방지)
- `textAlign`: `'center'`

**내부 span** (`genCharInnerStyle` 반환):
- `display: 'inline-block'`
- `scale`: `${widthRatio * 0.88} 1` (glyph 모양 수평 축소 — 장평)
- `transformOrigin`: `'0 center'`

> **보정 계수 `0.88`**: opentype.js의 `advanceWidth`(레이아웃 폭, side bearing 포함)와 브라우저 실제 렌더링 glyph 너비(hinting/subpixel 등으로 약간 좁음) 간의 미세한 차이를 보정하는 경험적 값. 이 보정이 없으면 외부 span의 `width`보다 내부 glyph가 약간 넓게 렌더링되어 글자가 오버플로우하거나 인접 글자와 살짝 겹치는 현상이 발생한다. **절대 변경하거나 제거해서는 안 된다.** 제거 시 시각적 정렬이 깨진다.

`width`와 `scale`은 분리되어 작동한다:
- 외부 span의 `width`는 `_charWidthMm(char)`으로 측정한 원본 폭에 장평을 곱해 정확히 고정한다. 측정값과 DOM 렌더링이 결정론적으로 일치하며, 마지막 글자가 틀을 넘어가는 현상을 방지한다.
- 내부 span의 `scale`은 glyph 모양을 수평으로 `wr × 0.88`배 축소한다. 시각적 장평 효과.
- 공백은 `fontSize × spaceRatio`로 고정한다 (폰트 메트릭 무시).
- 문자별 Map 캐시(`_charOuterStyleCache`, 키 `${char}|${widthRatio}`)로 재계산을 생략한다.

---

## 12. 측정 단위

### 12.1 mm와 px의 관계

- 모든 레이아웃 크기는 **mm** 단위이다.
- DOM 요소의 `getBoundingClientRect()`는 **px** 단위이므로, ppm으로 나누어 mm로 변환한다.
- `ppm`(pixels-per-mm) = px / mm

### 12.2 ppm 측정

```ts
const ppm = vColumnEl.getBoundingClientRect().width / this._columnWidths[curColumn];
```

가상 컬럼의 실제 렌더링 너비(px)를 컬럼 너비(mm)로 나누어 구한다.

### 12.3 단위 변환 예시

| mm 값 | ppm | px 값 |
| ------- | ----- | ------- |
| 50 mm | 3.78 | 189 px |
| 30 mm | 3.78 | 113.4 px |
| 100 mm | 3.78 | 378 px |

### 12.4 데이터 단위

- `TextPartData.left`, `TextPartData.width`: **mm**
- `FreeRegion.start`, `FreeRegion.end`: **mm**
- `OverlapParts.x1`, `OverlapParts.x2`: **px** (`getOverlapSizePX()` 반환값. `_createLineWithParts()`에서 mm로 변환하여 사용)
- DOM 파트 요소의 `width`, `marginLeft`: **mm** (CSS `Nmm` 형식)
- `_charWidthMm()` 반환값: **mm**
- `_layoutTextIntoColumns()` 내 `partWidths`, `cumulativeWidths`, `charWidth`, `letterSpacingMm`: **mm**

### 12.5 scale 무관성

텍스트 래핑 계산의 모든 산술은 mm 단위로 수행된다. mm는 CSS `transform: scale(s)`의 영향을 받지 않는 절대 단위이므로, scale이 변경되어도 줄바꿈 결과(줄당 문자 수, 컬럼당 줄 수)가 동일하게 보장된다. 폰트 메트릭 기반 문자 폭 측정(`glyph.advanceWidth / unitsPerEm * fontSize`)은 ppm 변환을 거치지 않으므로 환경에 완전히 무관하며, DOM에서 px로 측정한 값은 ppm으로 나누어 mm로 변환한다. 따라서 scale에 무관한 결과를 보장한다.

#### 12.5.1 `getBoundingClientRect()` 정규화

CSS `transform: scale(s)`가 적용된 환경에서 `getBoundingClientRect()`는 scale이 곱해진 viewport 픽셀을 반환한다. 서브픽셀 렌더링 정밀도는 scale에 비례하므로(예: scale=0.5면 반픽셀 단위, scale=2면 2배 정밀도), scale마다 측정값이 미세하게 달라져 텍스트 배치가 어긋나는 원인이 된다.

이를 방지하기 위해 모든 `getBoundingClientRect()` 결과는 `EditManager.scale`로 나누어 **scale=1 기준 픽셀 좌표**로 정규화한 뒤 사용한다. 정규화는 다음 세 경로에 적용된다:

1. **ppm 측정** (`_initStructureAndMeasureColumns`): 가상 컬럼의 렌더링 폭을 scale로 나누어 ppm을 계산한다. 폰트 메트릭 기반 `_charWidthMm()`은 ppm에 무관하게 동일한 mm 값을 반환하므로, 오버랩이 없는 라인의 글자 배치도 일관된다.
2. **오버랩 rect 캐시** (`_detectOverlapWithCache`): 오버랩 요소의 rect를 scale로 나누어 캐싱한다. 라인 rect도 동일한 scale로 나누어 비교하므로, 모든 scale에서 동일한 겹침 판정 결과를 보장한다.
3. **`getOverlapSizePX()`**: 내부에서 `getBoundingClientRect()`를 다시 호출하므로, scale 파라미터를 받아 r1/r2를 정규화한다. canvas 픽셀 매핑(`canvas.width / r2.width`)도 정규화된 r2.width 기준으로 수행되어 scale 무관하다.

`TextLayoutEngine.scale` 프로퍼티를 통해 scale 값을 받으며, `LayoutParagraphElement.render()`가 `layoutDocEl.editManager.scale`을 읽어 `model.scale`에 설정한 후 `layoutStructure()`/`layoutText()`를 호출한다. `EditManager.setScale()`은 모든 paragraph의 `markStructureChangedAndRender()`를 호출하므로, scale 변경 시 자동으로 재렌더링되어 새 scale이 반영된다.

---

## 13. 공개 API 참조

### 13.1 정적 메서드

| 메서드 | 설명 |
|--------|------|
| `TextLayoutEngine.create(...)` | 팩토리 메서드. `new` 대신 사용 |

### 13.2 공개 메서드

| 메서드 | 반환 타입 | 설명 |
| -------- | ----------- | ------ |
| `layoutText()` | `void` | 전체 텍스트 래핑 수행. `_columnContents` 생성 |
| `layoutStructure()` | `void` | 컬럼 폭, 간격, ppm 등 구조 데이터 측정 및 캐싱 |
| `resetIncrementalState()` | `void` | 증분 렌더링 상태 초기화. `_previousLineCount`, `_previousOverflow`를 -1로 설정 |
| `genColumnStyle(idx)` | `Partial<CSSStyleDeclaration>` | 컬럼 absolute positioning 스타일 |
| `genLineStyle(...)` | `Partial<CSSStyleDeclaration>` | 줄(line) 스타일 |
| `genPartStyle(...)` | `Partial<CSSStyleDeclaration>` | 파트(part) 스타일 |
| `genCharStyle(char: string)` | `Partial<CSSStyleDeclaration>` | 글자(char) 스타일 |

### 13.3 세터

| 세터 | 타입 | 설명 |
| ------ | ------ | ------ |
| `data` | `TextLayoutEngineOptions` | 모델 전체 데이터 설정. 컬럼, 스타일, 콘텐츠 갱신. `_initLayoutMetrics()` 호출 |
| `inheritStyle` | `InheritStyle` | 상속 스타일 설정. `_initLayoutMetrics()` 호출 |
| `textContent` | `string \| (string \| TextBlockData)[]` | 텍스트 콘텐츠 갱신. 래핑은 호출자가 직접 실행 |

### 13.4 게터/세터 (scale)

| 멤버 | 타입 | 설명 |
| ------ | ----------- | ------ |
| `scale` (get) | `number` | 현재 화면 배율. `getBoundingClientRect()` 결과를 scale=1 기준으로 정규화하는 데 사용 |
| `scale` (set) | `number` | 화면 배율 설정. `layoutStructure()`/`layoutText()` 호출 전에 설정해야 scale 무관한 래핑이 보장됨. 0 이하이면 1로 취급 |

### 13.5 게터

| 게터 | 반환 타입 | 설명 |
| ------ | ----------- | ------ |
| `contents` | `TextBlockData[]` | `\n`으로 분리된 텍스트 블록 배열 |
| `inheritStyle` | `InheritStyle` | 상속 스타일 |
| `textStyle` | `TextStyle` | 단락 수준 텍스트 스타일 |
| `paragraphStyle` | `ParagraphStyle` | 단락 레이아웃 스타일 |
| `columnCount` | `number` | 컬럼 수 |
| `columnContents` | `TextLineData[][]` | 컬럼별 줄 데이터. 컬럼 요소가 렌더링에 사용 |
| `gaps` | `number[]` | 컬럼 간 간격(mm) 배열 |
| `lineHeight` | `number` | 줄 높이(mm) |
| `overflow` | `number` | 오버플로우된 문자 수 |
| `widthRatio` | `number` | 장평 비율 |
| `spaceRatio` | `number` | 공백 너비 비율 (em 단위). 기본값: 0.15 |
| `indent` | `number` | 첫 줄 들여쓰기 비율 (fontSize 대비, 0.0~1.0). 기본값: 0 |
| `columnWidths` | `number[]` | 컬럼별 너비(mm) 배열 |
| `textContent` | `string \| (string \| TextBlockData)[]` | 현재 입력 콘텐츠 |
| `previousLineCount` | `number` | 이전 렌더링 사이클의 총 줄 수 |
| `previousOverflow` | `number` | 이전 렌더링 사이클의 오버플로우 문자 수 |

---

## 14. 비공개 메서드 참조

| 메서드 | 설명 |
| -------- | ------ |
| `_initLayoutMetrics()` | 레이아웃 상태 초기화. `_lineHeight` 계산, `_columnContents`/`_overflow` 리셋 |
| `_initStructureAndMeasureColumns()` | 컬럼 폭/간격/lineHeight 계산, 가상 컬럼 생성 후 ppm 측정 및 제거 |
| `_parseContents()` | 입력 콘텐츠를 `\n` 단위로 분리하여 `_contents` 생성 |
| `_layoutTextIntoColumns()` | 메인 래핑 메서드. 라인 생성, 오버랩 적용, 글자 배치를 한 번에 수행. 종료 시 `_applyLineBreakRules()` 호출 |
| `_createLineWithParts(...)` | 라인 DOM 생성 + 오버랩 감지 + 파트/데이터 생성 |
| `_createLineElement(textBlockStyle?)` | 줄 DOM 요소 생성 |
| `_computeFreeRegions(lineWidth, overlapParts)` | 오버랩 영역의 여집합으로 자유 영역 계산 |
| `_detectOverlapWithCache(lineEl)` | 오버랩 요소와의 겹침 계산. COVER/PART 판정. `_overlayRects` 캐시 사용 |
| `_charWidthMm(char, textBlockStyle?)` | 폰트 메트릭(`glyph.advanceWidth / unitsPerEm * fontSize`)으로 문자 폭을 mm로 직접 계산. `minWidthMm` 바닥값 적용. `Math.round()` 없음 |
| `_charWidthMmFromFont(char, textBlockStyle?, fontSize)` | `FontLoader.getParsedFont()`로 폰트 객체 조회 후 글리프 advance width 계산. 폰트/글리프 누락 시 `null` |
| `_createPartElement(widthMm, marginLeftMm)` | 파트 DOM 요소 생성. mm 단위 CSS 적용 |
| `_removeTrailingEmptyLine(columnContent)` | 빈 파트만 있는 마지막 줄 제거 |
| `_applyLineBreakRules()` | 한글 조판 금칙문자(행두/행말 금지) 후처리. 인접 줄 경계의 금칙 위반 교정 (§22 참조) |

---

## 15. 상수 및 기본값

`src/constants/defaults.ts`에서 정의된 상수:

| 상수 | 값 | 설명 |
| ------ | ----- | ------ |
| `DEFAULT_FONT_SIZE` | `4` | 기본 글자 크기 (mm) |
| `DEFAULT_LINE_GAP` | `1` | 기본 행간 배율 |
| `DEFAULT_FONT_STYLE` | `'normal'` | 기본 폰트 스타일 |
| `DEFAULT_FONT_WEIGHT` | `400` | 기본 폰트 굵기 |
| `DEFAULT_PPM` | `96 / 25.4` | 기본 pixels-per-mm |
| `DEFAULT_IMAGE_DPI` | `72` | 기본 이미지 DPI |
| `DEFAULT_SPACE_RATIO` | `0.15` | 기본 공백 너비 비율 (em) |

`_lineHeight` 계산:

```ts
const fontSize = this.textStyle?.fontSize || this.inheritStyle?.fontSize || DEFAULT_FONT_SIZE;
const lineGap = this.paragraphStyle?.lineGap || this.inheritStyle?.lineGap || DEFAULT_LINE_GAP;
this._lineHeight = fontSize * lineGap;
```

---

## 16. 코드 예시

### 16.1 기본 사용

```ts
const model = TextLayoutEngine.create({
  content: "신문 본문 텍스트입니다.\n두 번째 단락입니다.",
  column: 2,
  gap: 3,
  paragraphStyle: { textAlign: 'justify', lineGap: 1.2 },
  textStyle: { widthRatio: 0.95 },
  inheritStyle: {
    parentWidth: 180,
    parentHeight: 260,
    fontSize: 4,
    fontFamily: 'Myoungjo',
  },
  paragraphEl,
  rootNode,
});

model.layoutStructure();
model.layoutText();
console.log(model.columnContents);
console.log(model.overflow);
```

### 16.2 텍스트 갱신

```ts
model.textContent = "새로운 텍스트입니다.";
model.layoutStructure();
model.layoutText();
```

---

## 17. 오버랩 회피 상세 다이어그램

### 17.1 이미지와 라인의 수직/수평 관계

```text
컬럼 (가상 컬럼)
┌────────────────────────────────────────┐
│ line 0  ┌────────────────────────┐     │
│         │                        │     │
│ line 1  │      IMAGE BOX         │     │
│         │      (zIndex 높음)     │     │
│ line 2  │                        │     │
│         └────────────────────────┘     │
│ line 3                               │
│ line 4                               │
└────────────────────────────────────────┘

line 0: FREE → parts = [{ left:0, width:colWidth }]
line 1: COVER → parts = [], width=0
line 2: COVER → parts = [], width=0
line 3: PART  → parts = [{left:0, width:x1}, {left:x2, width:colWidth-x2}]
line 4: FREE  → parts = [{ left:0, width:colWidth }]
```

### 17.2 픽셀 단위 겹침 탐지 (`getOverlapSizePX`)

이미지 요소인 경우 캔버스 픽셀 데이터를 사용하여 불투명 픽셀이 있는 열을 탐지한다.

```text
baseElement (line)        targetElement (image box)
┌─────────────────┐       ┌─────────────────────┐
│                 │       │                     │
│    ┌────────────┼───────┼────┐                │
│    │            │       │    │                │
│    │  겹치는 영역│       │    │                │
│    │            │       │    │                │
│    └────────────┼───────┼────┘                │
│                 │       │                     │
└─────────────────┘       └─────────────────────┘
        ↑
   intersectionStart, intersectionEnd
        ↑
   relStart = intersectionStart - r1.left
   relEnd   = intersectionEnd - r1.left
```

불투명 픽셀이 있는 열을 연속 구간으로 그룹화하여 `OverlapParts[]`를 생성한다.

### 17.3 overlapPadding: 타원 기반 패딩 감지

`ImageData.overlapPadding`이 설정된 경우, `getOverlapSizePX()`는 단순 사각형 교차 대신 **타원 기반 패딩 감지**를 사용한다.

#### 타입

```ts
overlapPadding?: number | { top?: number; right?: number; bottom?: number; left?: number }
```

값은 mm 단위이며, `GridCalculator.ppm`을 통해 화면 픽셀로 변환된다. `number`이면 상하좌우 동일하게 적용된다.

#### 알고리즘

1. **수직 샘플링 범위**: 텍스트 줄의 위아래로 `padBottom`/`padTop`만큼 확장하여 캔버스 픽셀을 샘플링한다.
2. **타원 거리 검사**: 각 불투명 픽셀에 대해 텍스트 줄까지의 정규화 거리를 계산한다:
   - `ndx = dx / horizPad` (픽셀이 줄 왼쪽이면 `horizPad = padRight`, 오른쪽이면 `padLeft`)
   - `ndy = dy / vertPad` (픽셀이 줄 위쪽이면 `vertPad = padBottom`, 아래쪽이면 `padTop`)
   - `ndx² + ndy² ≤ 1`이면 해당 픽셀의 열을 차단 열로 표시
3. **수평 패딩 확장**: 각 차단 열의 범위를 `padLeft`만큼 왼쪽으로, `padRight`만큼 오른쪽으로 확장한다.
4. **병합**: `mergeOverlapParts()`로 겹치는 범위를 병합한다.

#### 특징

- **투명 영역 제외**: 알파가 0인 픽셀은 차단 영역에서 제외된다. 정사각형이 아닌 이미지에서 투명 영역 주변으로 텍스트가 자연스럽게 흐른다.
- **비대칭 패딩**: `{ top: 2, right: 5, bottom: 2, left: 5 }` 형태로 각 방향마다 다른 패딩 값을 설정할 수 있다.
- **캔버스 없는 경우 폴백**: 캔버스를 사용할 수 없으면 기하학적 확장 사각형(`expandedR2`)으로 폴백한다.

#### 방향 의미

| 패딩 값 | 의미 |
|----------|------|
| `padTop` | 이미지 상단에서 아래로 뻗어나가는 패딩 (아래쪽 텍스트 줄을 차단) |
| `padBottom` | 이미지 하단에서 위로 뻗어나가는 패딩 (위쪽 텍스트 줄을 차단) |
| `padLeft` | 이미지 왼쪽에서 오른쪽으로 뻗어나가는 패딩 (오른쪽 텍스트 줄을 차단) |
| `padRight` | 이미지 오른쪽에서 왼쪽으로 뻗어나가는 패딩 (왼쪽 텍스트 줄을 차단) |

---

## 18. 연관 컴포넌트와의 관계

### 18.1 `LayoutParagraphElement`

- `layout()`에서 `TextLayoutEngine.create()` 또는 `model.data = ...` 호출
- `render()`에서 `model.layoutStructure()`와 `model.layoutText()` 호출
- `render()`에서 `columnContents` 길이만큼 `<x-layout-column>` 생성
- `overlayElements` 게터가 `_detectOverlapWithCache()`에 사용될 오버랩 요소 제공

**paragraph 위치와 `paddingTop`**: `_applyStyle()`에서 paragraph의 CSS `top`은 부모 box의 `inheritStyle.paddingTop`을 그대로 사용한다 (`top: ${paddingTop}mm`). 라인 그리드(=`lineHeight` 단위)로의 강제 스냅은 수행하지 않는다 — 사용자가 `paddingTop`을 명시적으로 설정한 것은 의도적으로 라인 그리드에서 벗어난 여백을 원한다는 뜻으로 해석하기 때문이다. `paddingTop = 0`(기본값)이면 `top: 0mm`가 되어 자연스럽게 라인 그리드에 정렬된다. `relTop` 게터도 동일하게 `paddingTop`을 그대로 반환한다. `LayoutImageElement`도 같은 방식으로 동작한다.

#### Public API (셋터/게터)

| 프로퍼티 | 타입 | 셋터 동작 | 설명 |
|---|---|---|---|
| `column` | `number \| number[] \| undefined` | 값 변경 시 `layout()` + `_perfStructureChanged = true` + `render()` | 하위 컬럼 그리드 정의. `undefined`면 부모 컬럼 상속 |
| `gap` | `number \| number[] \| undefined` | 값 변경 시 `layout()` + `_perfStructureChanged = true` + `render()` | 하위 컬럼 간격. `undefined`면 부모 간격 상속 |
| `textStyle` | `TextStyle` | 값 변경 시 `layout()` + `_perfStructureChanged = true` + `render()` | 글자 스타일 |
| `paragraphStyle` | `ParagraphStyle` | 값 변경 시 `layout()` + `_perfStructureChanged = true` + `render()` | 문단 스타일 |
| `inheritStyle` | `InheritStyle \| undefined` | 값 변경 시 `layout()` | 상속 스타일 |
| `editableText` | `boolean` | `true` → `TextEditController` 생성, `false` → 제거 | 편집 모드 활성화 |

`column`과 `gap` 셋터는 `ParagraphData`의 `column`/`gap` 필드와 동일한 타입을 사용한다. 각 프로퍼티는 독립적으로 부모 상속 여부를 판단한다: `_column !== undefined`면 자체 컬럼 값을 사용하고, `_gap !== undefined`면 자체 간격 값을 사용한다. 어느 하나가 `undefined`이면 해당 값만 부모에서 상속받는다.

### 18.2 `LayoutColumnElement`

- `connectedCallback()`에서 `renderText()` 호출
- `renderText()`에서 `model.columnContents[index]`로 줄 데이터 획득
- `genColumnStyle()`, `genLineStyle()`, `genPartStyle()`, `genCharStyle()` 사용
- 마지막 파트 + `endOfBlock`이면 `justify-content: flex-start`로 조정
- 양 끝 공백 제거 (단, 텍스트 블록(`\n`으로 분리된 각 블록)의 맨 앞/맨 끝 공백은 유지 — `firstOfBlock`/`endOfBlock` 플래그로 제어)
- **오버플로우 라인 `display: none` 처리**:
  - `renderText()`에서 각 라인의 누적 높이(mm)를 계산하여 컬럼 높이(`model.inheritStyle.parentHeight`, mm)를 초과하는 라인을 감지한다
  - 라인 높이는 `_getLineHeightMm()` 헬퍼로 `lineEl.style.height`에서 추출 (폴백: `model.lineHeight`)
  - 초과한 라인에는 `lineEl.style.display = 'none'`을 적용하여 시각적으로 숨긴다
  - `columnHeightMm`이 0이면(부모 높이 미설정) 오버플로우 판정을 생략한다
  - mm 기반 계산이므로 scale에 무관하게 동작한다
- **key 기반 증분 렌더링** (commit cec32e4):
  - `data-source-offset` 속성을 key로 사용하여 기존 span 재사용
  - `data-offset` (rendered offset)은 `EditCoordinateMapper` 호환성을 위해 유지
  - 기존 span이 있으면 `innerText`, 스타일, `data-offset` 갱신 + DOM 순서 조정
  - 기존 span이 없으면 새 span 생성
  - 사용되지 않은 span 제거
  - `data-temporary` span(낙관적 span)은 diff 시작 전 제거
  - `<style>` 요소는 재사용, CSS 룰만 갱신
  - COVER 라인(`parts: []`)은 라인 div의 자식을 모두 제거
  - 헬퍼 메서드: `computePerfSourceOffsets()`, `_stripSpaces()`,
    `_createLineElement()`, `_applyLineStyle()`, `_getLineHeightMm()`,
    `_createPartElement()`, `_applyPartStyle()`,
    `_createSpanElement()`, `_applySpanStyle()`
  - `innerHTML = ''`는 더 이상 발생하지 않음

### 18.3 `LayoutVirtualColumnElement`

- `_initStructureAndMeasureColumns()`와 `_layoutTextIntoColumns()`에서 임시로 생성
- `isOverflow`로 컬럼 높이 초과 여부 감지. **mm 기반 판정**: children 수 × `model.lineHeight`(mm)와 `model.inheritStyle.parentHeight`(mm)를 직접 비교하여 scale에 무관한 오버플로우 판정을 보장한다. **부동소수점 오차 tolerance**: 비교 시 `containerHeightMm + 1e-6` 기준을 사용하여, `editableTextHeight` 계산에서 발생하는 부동소수점 오차(예: `15 × 4.8 = 72` vs `parentHeight = 71.99999999999999`)로 인해 15줄이 꽉 찬 컬럼이 overflow로 잘못 판정되는 현상을 방지한다. 이 기준은 `LayoutParagraphElement._computeRenderStats()`의 `accumulatedHeightMm + lineHeightMm > parentHeight + 1e-6`과 동일하다.
- 측정 완료 후 제거됨

---

## 19. 주의사항 및 제약

- `TextLayoutEngine`은 `create()`로만 인스턴스화해야 한다.
- `layoutText()`는 `layoutStructure()`가 먼저 호출되어 `_columnWidths`, `_gaps`, `_columnPpm`, `_lineHeight`가 준비된 상태에서 실행해야 한다.
- 이미지 오버랩 탐지는 `LayoutImageElement.canvas`가 존재할 때만 픽셀 수준으로 수행한다.
- `overlapPadding`이 설정된 이미지는 타원 기반 감지를 사용한다. 캔버스가 없으면 기하학적 확장 사각형으로 폴백하며, 이 경우 투명 영역 구분이 불가능하다.
- 텍스트 오버플로우는 마지막 컬럼에서 `_overflow`로 집계되며 `render-error` 이벤트로 통지된다. 오버플로우된 라인은 `renderText()`에서 `display: none` 처리되어 시각적으로 숨겨진다. `_createLineWithParts()`가 overflow를 반환한 경우에도 라인 데이터를 `columnContent`에 포함시켜, `_computeRenderStats()`가 라인 기반 오버플로우를 감지할 수 있도록 한다. 이는 텍스트 끝의 `\n`으로 인해 발생하는 빈 라인 오버플로우도 감지하기 위함이다.
- 오버플로우 발생 시 `LayoutParagraphElement`의 `:host`에 하단 8px 빨간 inset shadow(`inset 0 -8px 0 0 #ff0000`)가 자동 적용되어 사용자에게 오버플로우를 시각적으로 알린다. 인쇄 모드에서는 적용되지 않는다. 오버플로우가 해제되면 shadow도 자동 제거된다.
- 폰트 메트릭 테이블에서 직접 읽은 advance width를 사용하므로 브라우저 렌더링 파이프라인 차이에서 오는 불일치가 발생하지 않는다. 폰트 파싱에 실패하면 `minWidthMm` 바닥값으로 폴백한다.
- `LayoutParagraphElement.render()` 완료 후 항상 `render-complete` 커스텀 이벤트가 디스패치된다. 오버플로우 발생 여부와 무관하게 렌더링 결과를 통지하며, 페이로드는 `RenderCompleteEventDetail` 타입을 따른다. 배치된 글자/라인 수(`placed.chars`, `placed.lines`), 오버플로우 여부 및 통계(`overflow.hasOverflow`, `overflow.chars`, `overflow.lines`), 컬럼 수(`columnCount`)를 포함한다. `render-error`와 독립적으로 동작하며 기존 이벤트에 영향을 주지 않는다.

---

## 20. 텍스트 정렬별 오버랩 회피 유효성

오버랩 회피와 텍스트 래핑은 `textAlign` 값(정렬 방식)과 무관하게 동일하게 동작한다.
이 섹션에서는 왜 모든 정렬(`left`, `right`, `center`, `justify`)에서 이미지 회피와 오버플로우 감지가 올바르게 작동하는지 설명한다.

### 20.1 오버랩 회피는 정렬과 무관하다

`_detectOverlapWithCache()`과 `_computeFreeRegions()`는 모두 **물리적 픽셀 좌표**를 기준으로 계산된다.

```ts
private _detectOverlapWithCache(lineEl: HTMLElement): { cover: boolean; overlapParts: OverlapParts[] }
private _computeFreeRegions(lineWidth: number, overlapParts: OverlapParts[]): FreeRegion[]
```

- `_detectOverlapWithCache()`은 `getBoundingClientRect()`로 라인과 이미지의 실제 렌더링 영역을 측정한다. `_overlayRects` 캐시를 사용한다.
- `_computeFreeRegions()`은 겹침 구간의 여집합을 기하학적으로 계산한다.
- 두 메서드 모두 `textAlign`, `justifyContent`와 같은 정렬 속성을 읽지 않는다.

따라서 동일한 이미지와 동일한 텍스트 내용이라면, `textAlign`이 `left`이든 `right`이든, `center`이든 `justify`이든 생성되는 `TextPartData`의 `left`과 `width` 값은 동일하다.

### 20.2 Canvas 기반 오버플로우 감지도 정렬과 무관하다

`_layoutTextIntoColumns()`에서 글자 하나를 추가하기 전, 다음 조건으로 초과 여부를 판단한다.

```ts
if (cumulativeWidths[currentPartIdx] + charWidth <= partWidths[currentPartIdx] + 1e-6) {
  // 현재 파트에 배치
}
```

`charWidth`는 폰트 메트릭으로 계산한 고정값이다. `partWidths`는 `_createLineWithParts()`에서 자유 영역 픽셀 폭으로 결정된다. 둘 다 정렬에 영향을 받지 않는다.

즉, `space-between`이든 `center`이든 `flex-end`이든 같은 글자들이 들어 있으면 총 너비는 같고, 파트 폭도 같다. 따라서 래핑 결과는 모든 정렬에서 동일하다.

또한 글자 배치 순서는 항상 **왼쪽에서 오른쪽**이다. 정렬은 배치가 끝난 뒤 CSS로 시각적으로만 이동시키므로 래핑 결과에 영향을 주지 않는다.

### 20.3 정렬은 어디에서 적용되는가

정렬은 모델이 아니라 렌더링 단계에서 `genPartStyle()`과 `LayoutColumnElement.renderText()`가 생성하는 CSS에 반영된다.

#### `genPartStyle()`의 매핑

| textAlign | justifyContent |
| :-------- | :------------- |
| `left`    | `flex-start`   |
| `right`   | `flex-end`     |
| `center`  | `center`       |
| `justify` | `space-between` |

`textBlockStyle?.textAlign`이 명시되면 그 값으로 `justifyContent`가 재정의된다.

#### `LayoutColumnElement.renderText()`의 마지막 줄 처리

블록의 마지막 줄(`endOfBlock`)이면 일부 정렬에 대해 시각적 조정이 추가된다.

```ts
let partJustify = curPartStyle.justifyContent;
if (p === line.parts.length - 1 && endOfBlock && partJustify === 'space-between') {
  partJustify = 'flex-start';  // justify: 마지막 줄은 왼쪽 정렬
}
switch (textBlockStyle?.textAlign) {
  case 'center': partJustify = 'center'; break;  // center: 그대로 유지
  case 'right': partJustify = 'flex-end'; break; // right: 그대로 유지
  default: break;
}
```

| textAlign | 마지막 줄 처리 | 시각적 결과 |
| :-------- | :------------- | :---------- |
| `left`    | 재정의 없음 (`flex-start`) | 마지막 줄 왼쪽 정렬 |
| `right`   | `flex-end`로 명시 유지 | 마지막 줄 오른쪽 정렬 |
| `center`  | `center`로 명시 유지 | 마지막 줄 가운데 정렬 |
| `justify` | `space-between` → `flex-start` | 마지막 줄 왼쪽 정렬 |

이 조정은 모두 래핑이 완료된 뒤 **CSS 시각 정렬**만 바꾸는 것이다. `TextPartData.content`에 들어 있는 글자 배열과 파트의 `width` 값은 변하지 않는다.

### 20.4 정렬별 오버랩 예시

아래 예시는 동일한 이미지와 동일한 텍스트를 두고, 정렬만 바꿨을 때 렌더링이 어떻게 달라지는지 보여준다.
파트 경계(자유 영역)는 모두 동일하고, 글자 배치도 동일하다. 달라지는 것은 파트 내부에서 글자가 정렬되는 위치뿐이다.

```text
textAlign = 'left' (flex-start)

컬럼
┌────────────────────────────────────────┐
│ line 0  ┌──────────┐                   │
│         │  IMAGE   │ 텍스트 텍스트     │
│ line 1  │          │                   │
│ line 2  └──────────┘ 텍스트            │
│ line 3                               │
└────────────────────────────────────────┘

텍스트는 항상 자유 영역 안에서 왼쪽부터 배치된다.
```

```text
textAlign = 'right' (flex-end)

컬럼
┌────────────────────────────────────────┐
│ line 0  ┌──────────┐           텍스트 │
│         │  IMAGE   │ 텍스트           │
│ line 1  │          │                  │
│ line 2  └──────────┘      텍스트      │
│ line 3                               │
└────────────────────────────────────────┘

같은 자유 영역 안에서 글자가 오른쪽으로 밀린다.
```

```text
textAlign = 'center'

컬럼
┌────────────────────────────────────────┐
│ line 0  ┌──────────┐     텍스트       │
│         │  IMAGE   │   텍스트 텍스트  │
│ line 1  │          │                  │
│ line 2  └──────────┘    텍스트       │
│ line 3                               │
└────────────────────────────────────────┘

같은 자유 영역 안에서 글자가 가운데로 배치된다.
```

```text
textAlign = 'justify' (space-between)

컬럼
┌────────────────────────────────────────┐
│ line 0  ┌──────────┐ 텍스트    텍스트│
│         │  IMAGE   │                  │
│ line 1  │          │ 텍스트           │
│ line 2  └──────────┘ 텍스트    텍스트 │
│ line 3                               │
└────────────────────────────────────────┘

자유 영역의 양끝에 글자가 붙고, 중간 공백이 늘어진다.
```

모든 경우에 이미지와 겹치는 영역(COVER/PART)은 완전히 동일하게 계산되며, 텍스트는 그 영역을 피해서만 배치된다.

### 20.5 정렬 영향 요약

| 관심사 | 정렬에 영향받는가 | 이유 |
| :----- | :--------------- | :--- |
| 오버랩 영역 계산 | 아니오 | `_detectOverlapWithCache()`이 `_overlayRects`의 `DOMRect`로 물리 좌표만 사용 |
| 자유 영역 분할 | 아니오 | `_computeFreeRegions()`이 기하 여집합만 계산 |
| 글자 래핑 | 아니오 | `_charWidthPx()`와 `partWidths`는 정렬과 무관 |
| 글자 배치 순서 | 아니오 | 항상 왼쪽에서 오른쪽으로 추가 |
| 파트의 `left` / `width` | 아니오 | `_createLineWithParts()`의 geometry는 정렬과 무관 |
| 시각적 정렬 위치 | 예 | `genPartStyle()`의 `justifyContent` 매핑과 `renderText()`의 오버라이드 |
| 마지막 줄 처리 | 예 | `justify`일 때만 `flex-start`로 강제 |

결론적으로, TextLayoutEngine의 핵심 기능인 오버랩 회피와 텍스트 래핑은 어떤 `textAlign` 값이 오든 정확하게 동작한다. 정렬은 최종 렌더링 단계에서 시각적 위치만 바꾼다.

---

## 21. 렌더링 성능 최적화 전략

`TextLayoutEngine`과 연관 컴포넌트들은 렌더링 성능을 향상하기 위해 6가지 최적화 전략을 사용한다. 각 전략은 강제 리플로우(`getBoundingClientRect()`) 호출을 최소화하거나 DOM 조작을 줄이는 것을 목표로 한다.

### 21.1 폰트 메트릭 기반 문자 폭 측정

**대상:** `_charWidthMm()` (`src/core/text-layout-engine.ts:205`)

**문제:** DOM 기반 문자 폭 측정(`scrollWidth > clientWidth`)은 강제 리플로우를 유발한다. 문자마다 span을 생성하고 측정하면 O(n)번의 리플로우가 발생한다.

**해결:** 폰트 메트릭 테이블에서 `glyph.advanceWidth / unitsPerEm * fontSize`로 직접 계산하여 DOM 조작 없이 순수 계산으로 문자 폭을 구한다. ppm 변환을 거치지 않으므로 환경에 완전히 무관하다.

```ts
private _charWidthMm(char: string, textBlockStyle?: TextBlockStyle): number {
  const fontSize = textBlockStyle?.fontSize || this._textStyle?.fontSize || this._inheritStyle?.fontSize || DEFAULT_FONT_SIZE;
  const minWidthMm = this.spaceRatio * fontSize;

  if (char === ' ') {
    return minWidthMm;
  }

  const fontWidth = this._charWidthMmFromFont(char, textBlockStyle, fontSize);
  if (fontWidth !== null) {
    return Math.max(fontWidth, minWidthMm);
  }

  return minWidthMm;
}
```

**핵심 포인트:**
- `glyph.advanceWidth / unitsPerEm * fontSize`로 mm 폭을 직접 계산 — ppm 변환 없이 환경에 무관한 mm 값을 반환.
- `Math.round()`를 사용하지 않음 — 부동소수점 정밀도를 보존하여 서로 다른 scale에서 동일한 줄바꿈 결과를 보장.
- `minWidthMm` 바닥값 — 결함 글리프(0폭/누락) 방지 (`spaceRatio × fontSize`).

**효과:** 텍스트 래핑 계산 시 DOM 조작 없이 순수 계산으로 처리. O(n)번의 강제 리플로우 제거. 환경에 무관한 줄바꿈 보장.

> **참고:** 문자 폭 측정의 상세한 규칙은 섹션 6을 참조.

### 21.2 오버랩 rect 캐시 (`_overlayRects`)

**대상:** `_detectOverlapWithCache()` (`src/core/text-layout-engine.ts:215`)

**문제:** 각 라인마다 오버랩 요소(이미지 등)와의 겹침을 검사할 때 `getBoundingClientRect()`를 호출하면 라인 수 × 오버랩 요소 수만큼 강제 리플로우가 발생한다.

**해결:** 한 렌더링 사이클 내에서 오버랩 요소의 rect를 `Map`에 캐싱하여 첫 호출 시 한 번만 측정한다.

```ts
private _overlayRects: Map<LayoutBoxElement, DOMRect> | null = null;
```

```ts
if (this._overlayRects === null) {
  this._overlayRects = new Map();
  for (const el of overlapEls) {
    this._overlayRects.set(el, el.getBoundingClientRect());
  }
}
```

**생명 주기:**
1. `_initStructureAndMeasureColumns()` 시작 시 `null`로 리셋.
2. `_layoutTextIntoColumns()` 시작 시 `null`로 리셋.
3. 첫 `_detectOverlapWithCache()` 호출 시 `Map` 생성 후 모든 오버랩 요소를 한 번에 측정.
4. 이후 동일 렌더링 사이클 내에서는 `Map.get(el)`로 재사용.
5. 다음 렌더링 사이클 시작 시 1번으로 돌아감.

**효과:** 오버랩 요소의 `getBoundingClientRect()` 호출을 렌더링 사이클당 1번으로 통합. 라인 수 × 오버랩 요소 수번의 강제 리플로우를 1번으로 감소.

> **참고:** 상세한 내용은 섹션 8을 참조.

### 21.3 배치 vcolumn ppm 측정

**대상:** `_initStructureAndMeasureColumns()` (`src/core/text-layout-engine.ts:344`)

**문제:** 컬럼마다 개별적으로 가상 컬럼(`<x-layout-vcolumn>`)을 생성/측정/제거하면 컬럼 수만큼의 강제 리플로우가 발생한다.

**해결:** 모든 컬럼의 가상 컬럼을 한 번에 생성하고, 한 번의 루프에서 ppm을 측정한 뒤 한 번에 제거한다.

```ts
private _initStructureAndMeasureColumns() {
  // ...
  this._columnPpm = [];
  const vColumnEls: LayoutVirtualColumnElement[] = [];
  for (let curColumn = 0; curColumn < this.columnCount; curColumn++) {
    const vColumnEl = document.createElement('x-layout-vcolumn');
    vColumnEl.index = curColumn;
    vColumnEl.model = this;
    vColumnEl.parentElement = this._paragraphElement;
    this._rootNode.appendChild(vColumnEl);
    vColumnEls.push(vColumnEl);
  }

  for (let i = 0; i < vColumnEls.length; i++) {
    const ppm = vColumnEls[i].getBoundingClientRect().width / this._columnWidths[i];
    this._columnPpm.push(ppm);
  }

  for (const vColumnEl of vColumnEls) {
    vColumnEl.remove();
  }
}
```

**핵심 포인트:**
- 모든 가상 컬럼을 DOM에 추가한 후 한 번에 측정 — 브라우저가 배치를 한 번에 처리.
- 측정 완료 후 한 번에 제거.
- 이전 방식(컬럼마다 생성/측정/제거)은 O(columns)번의 강제 리플로우를 유발했음.

**효과:** O(columns)번의 강제 리플로우를 1번으로 통합.

### 21.4 key 기반 증분 span 렌더링

**대상:** `LayoutColumnElement.renderText()` (`src/components/layout/column.element.ts`)

**문제:** 편집 시 `renderText()`가 컬럼의 Shadow DOM을 전체 재구축(`innerHTML = ''`)하면 모든 span(수백 개)이 삭제되고 재생성된다. 이는 DOM 조작 비용과 가비지 컬렉션 부하를 유발한다.

**해결:** `data-source-offset` 속성을 reconciliation key로 사용하여 기존 span을 재사용하고 변경된 span만 갱신한다.

**알고리즘:**

1. **`<style>` 요소 보존:** `innerHTML = ''` 대신 기존 `<style>` 요소를 찾아서 CSS 룰만 갱신.
2. **낙관적 span 제거:** `data-temporary` 속성을 가진 span(IME 조합 중 생성된 임시 span)을 diff 시작 전 모두 제거.
3. **기존 라인 요소 수집:** `<style>`을 제외한 `<div>` 라인 요소들을 수집.
4. **라인 단위 diff:** 라인 수가 같으면 기존 라인 div 재사용, 다르면 불필요한 라인 제거/부족한 라인 추가.
5. **파트 단위 diff:** 각 라인 내에서 파트 div를 재사용.
6. **span 단위 diff (핵심):**
   - 기존 span들을 `data-source-offset` 기준으로 `Map`에 저장.
   - 새 content의 각 문자에 대해 source offset 계산.
   - 기존 span이 있으면: `innerText`, 스타일, `data-offset`을 갱신하고 DOM 순서를 `insertBefore`로 조정.
   - 기존 span이 없으면: 새 span 생성.
   - 사용되지 않은 기존 span 제거.
7. **COVER 라인 처리:** `parts: []`인 라인은 라인 div의 모든 자식을 제거하고 빈 div만 유지.

```ts
// 기존 span을 key로 수집
const existingSpans = new Map<string, HTMLSpanElement>();
const currentSpans = partEl.querySelectorAll(':scope > span[data-source-offset]');
for (const span of currentSpans) {
  const key = span.dataset.sourceOffset;
  if (key !== undefined) existingSpans.set(key, span);
}

// 새 content로 diff
for (let j = 0; j < content.length; j++) {
  const char = content[j];
  const thisCharSourceOffset = String(curSourceOffset);
  const existingSpan = existingSpans.get(thisCharSourceOffset);

  let charEl: HTMLSpanElement;
  if (existingSpan) {
    charEl = existingSpan;
    this._applySpanStyle(charEl, char, curRenderedOffset, curSourceOffset);
    existingSpans.delete(thisCharSourceOffset);
  } else {
    charEl = this._createSpanElement(char, curRenderedOffset, curSourceOffset);
  }

  if (nextRef === charEl) {
    nextRef = charEl.nextSibling;
  } else {
    partEl.insertBefore(charEl, nextRef);
  }

  curRenderedOffset++;
  curSourceOffset++;
}

// 사용되지 않은 span 제거
for (const unusedSpan of existingSpans.values()) {
  unusedSpan.remove();
}
```

**`data-source-offset` vs `data-offset`:**
- `data-source-offset`: 소스 문자열의 문자 위치. diff 렌더링의 reconciliation key로 사용.
- `data-offset`: 렌더링된 문자 위치. `EditCoordinateMapper`가 클릭-to-커서 매핑에 사용.
- 두 속성은 모든 span에 공존하며, `data-offset`은 기존 동작 호환성을 위해 유지됨.

**헬퍼 메서드:**
- `computePerfSourceOffsets()`: 컬럼 시작 위치의 rendered/source offset 계산.
- `_stripSpaces()`: 첫/마지막 파트의 선행/후행 공백 제거. 단, `firstOfBlock`이 true이면 선행 공백을 유지하고, `endOfBlock`이 true이면 후행 공백을 유지한다 (텍스트 블록의 맨 앞/맨 끝 공백은 사용자 의도일 수 있으므로 제거하지 않음).
- `_createLineElement()` / `_applyLineStyle()`: 라인 div 생성/스타일 갱신.
- `_createPartElement()` / `_applyPartStyle()`: 파트 div 생성/스타일 갱신.
- `_createSpanElement()` / `_applySpanStyle()`: span 생성/스타일 갱신.

**효과:** 한 글자 입력 시 변경된 라인의 span만 갱신되고 나머지는 재사용. `innerHTML = ''`가 발생하지 않음. DOM 조작과 가비지 컬렉션 부하 최소화.

### 21.5 `EditCoordinateMapper` 캐싱

**대상:** `EditCoordinateMapper` (`src/edit/edit-coordinate-mapper.ts`)

**문제:** 편집 모드에서 커서 이동, 클릭, 드래그 선택 시 `querySelectorAll`과 `getBoundingClientRect()`가 반복 호출된다. 드래그 선택은 매 프레임(`requestAnimationFrame`)마다 좌표를 계산하므로 성능 영향이 크다.

**해결:** 두 가지 캐싱을 도입한다.

#### 21.6.1 `_columnSpansCache` — 컬럼별 span 목록 캐시

```ts
private _columnSpansCache: Map<LayoutColumnElement, HTMLSpanElement[]> = new Map();
```

`_getColumnSpans(column)`은 첫 호출 시 `querySelectorAll('[data-offset]:not([data-temporary])')`을 수행하고 결과를 캐싱한다. 이후 동일 컬럼에 대한 호출은 캐시된 배열을 반환한다.

```ts
private _getColumnSpans(column: LayoutColumnElement): HTMLSpanElement[] {
  const cached = this._columnSpansCache.get(column);
  if (cached) return cached;
  const spans = Array.from(column.shadowRoot.querySelectorAll('[data-offset]:not([data-temporary])')) as HTMLSpanElement[];
  this._columnSpansCache.set(column, spans);
  return spans;
}
```

**캐시 무효화:** `rebuild()` 호출 시 `_columnSpansCache.clear()`로 초기화. `rebuild()`는 `EditController.postRender()`에서 호출되므로 렌더링 후 캐시가 자동으로 갱신됨.

#### 21.6.2 `spanRects` — 로컬 rect 맵 (getNearestOffsetFromPoint)

`getNearestOffsetFromPoint()` 내에서 로컬 `Map<HTMLSpanElement, DOMRect>`를 구축하여 모든 `getBoundingClientRect()` 호출을 단일 패스로 통합한다.

```ts
const spanRects = new Map<HTMLSpanElement, DOMRect>();
for (const s of spans) {
  spanRects.set(s, s.getBoundingClientRect());
}
```

이 Map은 메서드 종료 시 폐기된다 (인스턴스 필드가 아님). 행 탐지, 가장 가까운 span 탐색, rightmost/leftmost span 검사, midpoint 로직이 모두 동일한 `DOMRect`를 재사용한다.

**이전 방식:** 각 검사마다 개별적으로 `getBoundingClientRect()`를 호출하여 3번의 패스가 발생했음.

**효과:** 드래그 선택 시 매 프레임 `getBoundingClientRect()` 호출을 span 수 × 3번에서 span 수 × 1번으로 감소. `querySelectorAll` 호출을 `rebuild()` 주기당 1번으로 통합.

### 21.6 최적화 전략 요약

| 전략 | 대상 | 문제 | 해결 | 효과 |
|------|------|------|------|------|
| 폰트 메트릭 측정 | `_charWidthMm()` | DOM 기반 측정의 O(n) 리플로우 | `glyph.advanceWidth / unitsPerEm * fontSize`로 mm 단위 직접 계산 | DOM 조작 없이 순수 계산, 환경 무관 |
| 오버랩 rect 캐시 | `_detectOverlapWithCache()` | 라인×오버랩 요소 수의 리플로우 | `Map`에 오버랩 요소 rect 캐싱 | 리플로우를 사이클당 1번으로 통합 |
| 배치 vcolumn 측정 | `_initStructureAndMeasureColumns()` | 컬럼마다 개별 측정 | 모든 컬럼을 한 번에 생성/측정/제거 | O(columns)번 리플로우를 1번으로 통합 |
| key 기반 증분 렌더링 | `renderText()` | 전체 DOM 재구축 (`innerHTML = ''`) | `data-source-offset` key로 span 재사용 | 변경된 span만 갱신, DOM 조작 최소화 |
| Mapper 캐싱 | `EditCoordinateMapper` | 반복 `querySelectorAll` / `getBoundingClientRect` | `_columnSpansCache` + 로컬 `spanRects` Map | 드래그 시 프레임당 리플로우 감소 |

### 21.7 캐시 생명 주기 다이어그램

```mermaid
flowchart TD
    subgraph TextLayoutEngine["TextLayoutEngine 캐시"]
        T1["_initStructureAndMeasureColumns()"] -->|"_overlayRects = null"| T2["_layoutTextIntoColumns()"]
        T2 -->|"_overlayRects = null"| T3["_detectOverlapWithCache() 첫 호출"]
        T3 -->|"Map 생성 + 일괄 측정"| T4["이후 _detectOverlapWithCache() 호출"]
        T4 -->|"Map.get(el) 재사용"| T5["다음 렌더링 사이클"]
        T5 --> T1

        T1 -->|"vcolumn 일괄 생성"| T6["ppm 일괄 측정"]
        T6 -->|"vcolumn 일괄 제거"| T7["_columnPpm[] 확정"]
    end

    subgraph StyleCache["스타일 캐시"]
        F1["genCharStyle(char) 첫 호출"] -->|"key `${char}|${wr}` 미스"| F2["style 생성"]
        F2 -->|"_charOuterStyleCache.set"| F3["이후 genCharStyle() 호출"]
        F3 -->|"cache hit"| F4["_charOuterStyleCache.get 반환"]
        F4 -->|"다음 렌더링 사이클"| F1
    end

    subgraph ColumnElement["LayoutColumnElement 캐시"]
        C1["renderText() 호출"] -->|"data-temporary span 제거"| C2["기존 span Map 구축"]
        C2 -->|"data-source-offset key"| C3["span diff: 재사용/갱신/생성/제거"]
        C3 -->|"<style> 요소 보존"| C4["다음 renderText() 호출"]
        C4 --> C1
    end

    subgraph EditMapper["EditCoordinateMapper 캐시"]
        E1["postRender() → rebuild()"] -->|"_columnSpansCache.clear()"| E2["_getColumnSpans() 첫 호출"]
        E2 -->|"querySelectorAll + 캐싱"| E3["이후 _getColumnSpans() 호출"]
        E3 -->|"캐시된 배열 반환"| E4["getNearestOffsetFromPoint()"]
        E4 -->|"spanRects 로컬 Map 구축"| E5["단일 패스로 모든 rect 측정"]
        E5 -->|"메서드 종료 시 폐기"| E6["다음 postRender()"]
        E6 --> E1
    end
```

### 21.8 여전히 최적화되지 않은 영역

다음 영역은 현재 캐싱되지 않아 향후 최적화 후보이다:

| 영역 | 메서드 | 문제 |
|------|--------|------|
| `_getAllColumns()` | `EditCoordinateMapper` | 호출마다 `querySelectorAll('x-layout-column')` 수행 |
| `getCharRect()` | `EditCoordinateMapper` | 호출마다 `span.getBoundingClientRect()` 수행 |
| `getCharOffsetFromPoint()` | `EditCoordinateMapper` | binary search 내에서 span마다 `getBoundingClientRect()` 수행 |
| `getTextRange()` | `EditCoordinateMapper` | 선택 영역 계산 시 span마다 `getBoundingClientRect()` 수행 |
| `findVisualLineBounds()` | `EditCoordinateMapper` | Home/End 키 처리 시 span마다 `getBoundingClientRect()` 수행 |
| 라인 rect 측정 | `_detectOverlapWithCache()` | `_overlayRects`는 오버랩 요소만 캐싱, 라인 자체의 rect는 라인마다 측정 |
| `getImageData` 캐싱 | `getOverlapSizePX()` | 동일 이미지에 대해 라인마다 `getImageData()` 재호출 |
| `overlayElements` 게터 | `LayoutBoxElement` | 호출마다 오버랩 요소 목록 재계산 |

---

## 22. 한글 조판 금칙문자 줄바꿈 규칙

한글과 CJK 조판에는 서양의 hyphenation 개념 대신 **금칙(禁則)** 규칙이 있다. 줄의 시작(행두)이나 끝(행말)에 특정 문자가 오는 것을 금지하는 규칙이다. `TextLayoutEngine`은 `_layoutTextIntoColumns()`가 폭 기준으로 글자를 배치한 뒤, **후처리 패스** `_applyLineBreakRules()`로 이 규칙을 적용한다.

### 22.1 금칙문자 테이블

상수 테이블은 `src/constants/line-break.ts`에 정의되어 있으며 `@/constants`에서 재export된다.

```ts
export const LINE_START_FORBIDDEN: ReadonlySet<string>;  // 행두 금지
export const LINE_END_FORBIDDEN: ReadonlySet<string>;     // 행말 금지
export function isLineStartForbidden(char: string): boolean;
export function isLineEndForbidden(char: string): boolean;
```

| 분류 | 문자 |
|------|------|
| **행두 금지** (줄 시작 X) | `. , ) ] } ） ］ ｝ 〕 』 」 】 》 ’ ” ' "` |
| **행말 금지** (줄 끝 X) | `( [ { （ ［ ｛ 〔 『 「 【 《 ‘ “ ' "` |

> 따옴표(`'` `"`)는 곡선(`’ ” ‘ “`)과 직선(`' "`) 모두 양쪽에 포함된다.

### 22.2 후처리 알고리즘 (`_applyLineBreakRules`)

`_layoutTextIntoColumns()` 종료 직전, `_previousLineCount`/`_previousOverflow` 계산 전에 호출된다.

```mermaid
flowchart TD
    Start([_applyLineBreakRules]) --> ColLoop{각 컬럼}
    ColLoop --> LineLoop{각 인접 줄 쌍<br/>curLine, nextLine}
    LineLoop --> SkipCheck{COVER 또는 빈 라인?}
    SkipCheck -->|Yes| LineLoop
    SkipCheck -->|No| GetChars[curLastChar<br/>nextFirstChar]
    GetChars --> StartCheck{nextFirstChar<br/>행두 금지?}
    StartCheck -->|Yes| Conflict1{curLastChar<br/>행말 금지?}
    Conflict1 -->|Yes, 충돌| LineLoop
    Conflict1 -->|No, 안전| MoveDown[위 줄 마지막 →<br/>아래 줄 앞으로]
    MoveDown --> LineLoop
    StartCheck -->|No| EndCheck{curLastChar<br/>행말 금지?}
    EndCheck -->|Yes| Conflict2{nextFirstChar<br/>행두 금지?}
    Conflict2 -->|Yes, 충돌| LineLoop
    Conflict2 -->|No, 안전| MoveUp[아래 줄 첫 글자 →<br/>위 줄 뒤로]
    MoveUp --> LineLoop
    EndCheck -->|No| LineLoop
    LineLoop -->|완료| ColLoop
    ColLoop -->|완료| End([end])
```

#### 교정 규칙

1. **행두 금지 위반** (아래 줄의 첫 글자가 행두 금지):
   - 위 줄의 마지막 글자를 아래 줄 앞으로 이동
   - 단, 위 줄 마지막 글자 자체가 행말 금지면 **이동하지 않음** (두 금칙 충돌 시 안전 쪽 택함)
   - 단, 위 줄 마지막 파트에 글자가 2개 이상 있어야 함 (1개면 이동 후 빈 줄 방지)

2. **행말 금지 위반** (위 줄의 마지막 글자가 행말 금지):
   - 아래 줄의 첫 글자를 위 줄 뒤로 이동
   - 단, 아래 줄 첫 글자 자체가 행두 금지면 **이동하지 않음** (충돌 회피)

3. **스킵 조건**:
   - COVER 라인 (`parts: []`)
   - 빈 라인 (모든 파트의 `content`가 빈 배열)
   - 마지막 파트 또는 첫 파트가 빈 배열

4. **단일 패스**: 한 번의 순회로 처리. 이동으로 인해 새로 발생하는 위반은 추가 패스 없이 허용한다. 시각적으로 1글자 어긋남이 전체 깨짐보다 낫기 때문이다.

### 22.3 설계 결정: 후처리 방식 채택 이유

`_layoutTextIntoColumns()`는 이미 매우 복잡한 문자 배치 로직을 가진다:

- 3곳에서 줄바꿈 발생 (첫 라인, 다음 파트 시도, 새 라인 생성)
- 무한 루프 방지 가드 (charWidth > maxPartWidth 시 강제 배치)
- COVER/PART/오버플로우 분기 처리
- `endOfBlock`/`endOfText` 플래그 설정

이 로직에 직접 금칙 검사를 끼워넣으면:
- 분기가 기하급수적으로 늘어남
- 무한 루프 가드와 금칙 이동이 충돌할 위험
- 기존 동작 회귀 가능성

후처리 방식은:
- 기존 배치 로직 변경 없음 (회귀 위험 최소)
- 금칙 검사 로직 독립 (테스트/수정 용이)
- 단일 패스로 성능 영향 미미 (O(라인 수))

### 22.4 한계

- **컬럼 경계 미처리**: 마지막 컬럼의 마지막 줄과 첫 컬럼의 첫 줄은 다른 컬럼이므로 검사하지 않는다. (컬럼 간 텍스트 흐름은 없으므로 올바름)
- **블록 경계 미처리**: `\n`으로 분리된 블록 경계에서는 금칙을 검사하지 않는다. 블록은 독립적인 단락이므로, 블록 끝의 행말 금지 문자는 의도된 것이다.
- **넘침 허용**: 이동한 글자가 파트 폭을 초과해도 허용한다. 래핑 재계산을 하지 않으므로 시각적으로 1글자 정도 넘칠 수 있다.
- **동일 문자 양쪽 포함**: 따옴표(`'` `"`)는 행두·행말 양쪽에 포함된다. 이 경우 충돌 회피 규칙이 적용되어 이동하지 않는다.
