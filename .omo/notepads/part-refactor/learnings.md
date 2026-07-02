# Part-Refactor Learnings

## 2026-07-03: Line→Part→Char 구조 리팩토링

### 핵심 발견

1. **DOM 측정 기반 텍스트 래핑**: `preTextWrap()`은 가상 컬럼(`<x-layout-vcolumn>`)을 DOM에 임시 삽입하고 `getBoundingClientRect()`, `scrollWidth`, `clientWidth`로 실제 렌더링 크기를 측정한다. Part 요소도 실제 DOM에 삽입해야 오버플로우를 감지할 수 있다.

2. **`_computeFreeRegions()` 픽셀→mm 변환**: `overlapParts`는 픽셀 단위 좌표다. `freeRegions`도 픽셀로 계산 후 `ppm`(pixels-per-mm)으로 나누어 mm 단위의 `TextPartData.left`와 `TextPartData.width`로 변환한다.

3. **COVER 시 `lineEl.style.width = '0'`**: COVER 직후에 `lineEl.getBoundingClientRect().width`는 0이 되므로, COVER 분기에서는 `freeRegions` 계산을 건너뛰어야 한다.

4. **`while(true)` 재시도 루프 필수**: 연속 COVER(여러 줄이 모두 이미지에 덮이는 경우)를 처리하려면 재시도 루프가 필요. 단순 `continue`는 외부 블록 루프를 증가시켜 텍스트를 건너뛰는 버그를 유발한다.

5. **오버플로우 + COVER 무한루프 방지**: 마지막 컬럼에서 모든 라인이 COVER인 경우, COVER 후 `vColumnEl.isOverflow`를 체크하여 루프를 빠져나가야 한다.

6. **`partEls=[]` 시 char 루프 크래시**: COVER 직후 `partEls`가 빈 배열이 되면 `partEls[currentPartIdx]` 접근 시 `undefined.appendChild()` 크래시 발생. `while(true)` 재시도 루프로 해결.

7. **`genLineStyle()`에서 스타일 이동**: `justifyContent`와 `letterSpacing`이 Line 수준에서 Part 수준(`genPartStyle()`)으로 이동했다.

### 성능 관찰

- 대부분의 라인은 오버랩이 없어 Part 1개만 가지므로 오버헤드는 미미
- 문자 단위 DOM 측정은 텍스트가 길면 성능 저하 가능

### 기존 동작과의 차이

| 항목 | 기존 | 변경 후 |
|------|------|---------|
| TextLineData.content | `string[]` | 제거 → `parts: TextPartData[]` |
| TextLineData.left/right | `number` (항상 0) | 제거 → Part 단위 `left`/`width` |
| TextLineData.overlapParts | `OverlapParts[]` | 제거 → 내부 처리 |
| 오버랩 회피 | 저장만, 미반영 | Part 단위 marginLeft/width로 실제 회피 |
| Line DOM | `<div> → <span>×N` | `<div> → <div>×N → <span>×N` |
| 구두점 처리 | 예외 처리 로직 존재 | 제거 (Part 기반으로 자연 처리) |
