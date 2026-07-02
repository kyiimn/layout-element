# Plan: Line→Part→Char 텍스트 래핑 구조 리팩토링

**상태**: ✅ 완료  
**날짜**: 2026-07-03  
**관련 이슈**: 오버랩 영역(이미지 등) 주변으로 텍스트가 흘러가는(overlap avoidance) 기능 구현

---

## 배경

기존 `preTextWrap()`은 `<Line>` 안에 `<Char>`를 직접 나열하는 구조였다. 이 구조에서는 오버랩 영역(이미지 등)이 중간에 끼어들 때 글자가 그 영역을 건너뛰어 우측에 이어서 배치되는 것이 불가능했다. `TextLineData.overlapParts`에 겹침 구간 데이터를 저장하고 있었으나, 실제 렌더링에는 반영되지 않았다.

## 목표

Line 내부에 Part 수준을 추가하여, 오버랩 영역 사이의 자유 영역(free region)마다 Part를 생성하고, 글자가 Part 간에 자연스럽게 흐르도록 한다.

## 변경 사항

### 1. 타입 변경 (`src/types/layout/text/text-line.type.ts`)

**추가**:
```typescript
export type TextPartData = {
  content: string[];    // 이 파트에 포함된 글자 배열
  left: number;         // 줄 시작점으로부터의 좌측 여백 (mm)
  width: number;         // 파트의 가로 폭 (mm)
};
```

**수정** (`TextLineData`):
- 제거: `content: string[]`, `left: number`, `right: number`, `overlapParts: OverlapParts[]`
- 추가: `parts: TextPartData[]`
- 유지: `firstOfBlock`, `firstOfText`, `endOfBlock`, `endOfText`, `textBlockStyle`

**유지**: `OverlapParts` 타입 (내부 계산용으로 계속 사용)

### 2. 모델 변경 (`src/model/layout/paragraph.model.ts`)

**새 메서드**:
- `_computeFreeRegions(lineWidth, overlapParts)`: 오버랩 여집합 → 자유 영역 계산
- `_createPartElement(widthPx, marginLeftPx)`: Part div 생성 (inline-flex, overflow:hidden)
- `genPartStyle(textBlockStyle)`: Part 레벨 CSS 스타일 생성 (justifyContent, letterSpacing, font/color)

**수정 메서드**:
- `_applyOverlap()`: 반환 타입 변경 `OverlapParts[]` → `{cover: boolean, overlapParts: OverlapParts[]}`
- `_createLineElement()`: `flexWrap: 'wrap'` → `'nowrap'`, `justifyContent` 제거
- `genLineStyle()`: `justifyContent`, `letterSpacing` 제거 → `genPartStyle()`로 이동
- `preTextWrap()`: 전면 재작성 (아래 알고리즘 참조)

**`preTextWrap()` 새 알고리즘**:

```
for each column:
  create vColumnEl, measure ppm
  
  for each text block:
    [while(true) retry loop for COVER]:
      create lineEl, apply overlap
      if COVER → push empty line, lineEl=null, continue
      if overflow → break
      compute freeRegions from overlapParts
      create Part divs from freeRegions
      create TextPartData[] from freeRegions (px→mm)
      push TextLineData with parts
      break
    
    for each char:
      append char to current Part div
      if scrollWidth > clientWidth (char doesn't fit in Part):
        remove char, try next Part
        if no Part fits → create new line (same while(true) retry loop)
      push char to TextPartData.content
  
  push columnContent to _columnContents
```

### 3. 렌더링 변경 (`src/components/column.element.ts`)

**`renderText()` 재작성**:
- 각 라인마다 `genLineStyle()` + `genPartStyle()` 호출
- 라인 div 내부에 Part div 생성
- Part div에 `width: ${part.width}mm`, `marginLeft: ${part.left}mm` 적용
- Part div 내부에 글자 span 생성
- 블록 마지막 파트의 `justifyContent`를 `flex-start`로 변경 (양끝정렬 방지)
- 첫/마지막 파트의 선행/후행 공백 제거

### 4. 수정한 버그

1. **블록 루프 COVER 무한루프**: `continue`가 외부 블록 루프를 증가시키던 문제 → `while(true)` 재시도 루프로 변경
2. **Char 루프 COVER 크래시**: `partEls=[]` 상태에서 `partEls[0]` 접근 시 undefined → `while(true)` 재시도 루프로 변경
3. **마지막 컬럼 COVER 무한루프**: 오버플로우 시 `while(true)`가 영원히 도는 문제 → COVER 후 오버플로우 체크 시 `break`
4. **오버플로우 시 빈 라인 제거 조건**: `.parts.length < 1` → `.parts.every(p => p.content.length === 0)`
5. **오버플로우 후 `partEls`/`lineEl` null guard**: `!lineEl || partEls.length === 0` 체크 추가

## 영향받는 파일

| 파일 | 변경 유형 |
|------|-----------|
| `src/types/layout/text/text-line.type.ts` | 타입 추가/수정 |
| `src/model/layout/paragraph.model.ts` | 핵심 로직 재작성 |
| `src/components/column.element.ts` | 렌더링 로직 재작성 |

## 영향받지 않는 파일

- `src/utils/check-overlap.ts` — 변경 없음
- `src/components/v-column.element.ts` — 변경 없음
- `src/components/paragraph.element.ts` — 변경 없음 (columnContents 소비 방식 동일)
- `src/components/box.element.ts` — 변경 없음
- `src/components/image.element.ts` — 변경 없음

## 검증

- `npm run build` — 0 에러, 42 모듈 변환 성공
- TypeScript 타입 체크 통과
- 기존 `OverlapParts`, `mergeOverlapParts`, `getOverlapSizePX` 유틸리티 변경 없음
