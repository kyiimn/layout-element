# Part-Refactor Architectural Decisions

## 2026-07-03: Line→Part→Char 구조 설계 결정

### 결정 1: Part 데이터를 TextLineData 내부에 중첩

**선택**: `TextPartData`를 `TextLineData.parts: TextPartData[]`에 중첩

**대안**: `TextLineData` 평면 구조 유지 + `overlapParts` 배열로 간격 표현

**이유**:
- 렌더링 시 Part별 `<div>`를 생성해야 하므로, Part 데이터가 독립적인 단위로 존재하는 것이 자연스러움
- `left`/`width`를 Part 단위로 지정하면 CSS `marginLeft`/`width`로 직접 매핑 가능
- 평면 구조에서는 `overlapParts`를 렌더링 시 어떻게 처리할지 모호함

### 결정 2: `_computeFreeRegions()`로 오버랩 여집합 계산

**선택**: 오버랩 구간의 여집합(free regions)을 계산하여 Part 생성

**대안**: 각 글자마다 오버랩 구간을 확인하면서 배치

**이유**:
- Part 생성 시 한 번에 계산하면 O(overlapParts)로 충분
- 글자 단위 확인은 O(chars × overlapParts)로 비효율
- free regions를 미리 알면 Part의 `width`/`left`를 정확히 설정 가능

### 결정 3: Part 요소를 가상 컬럼에 실제 DOM 삽입

**선택**: `_createPartElement()`로 Part div를 생성하여 vColumnEl에 삽입 후 `scrollWidth > clientWidth`로 오버플로우 감지

**대안**: 계산식으로 Part 폭을 미리 계산하여 글자 수로 배치

**이유**:
- 장평(`widthRatio`)과 `letterSpacing`이 CSS transform/scale로 적용되어 JavaScript 계산으로는 정확한 폭을 구할 수 없음
- 기존 코드도 DOM 측정 방식을 사용하고 있어 일관성 유지
- `scrollWidth`/`clientWidth`는 브라우저의 실제 렌더링 결과를 반영

### 결정 4: COVERS 시 빈 라인(`parts: []`) 생성

**선택**: 이미지가 라인 전체를 덮으면 `parts: []`인 빈 `TextLineData`를 push하고 다음 라인으로 이동

**대안**: COVER 라인을 건너뛰고 다음 라인에서 텍스트 계속

**이유**:
- 빈 라인이 수직 공간을 차지해야 이미지와 텍스트의 위치 관계가 정확함
- 건너뛰면 텍스트가 이미지 위에 겹쳐 보일 수 있음
- `while(true)` 재시도 루프로 연속 COVER 처리

### 결정 5: 구두점 예외 처리 제거

**선택**: 기존 `(`, `)`, `.`, `,`, `!`, `?`, `'`, `"` 예외 처리 로직을 제거

**이유**:
- Part 기반 래핑에서는 글자가 Part 경계를 넘을 때 자연스럽게 다음 Part로 이동
- 기존 로직은 Line 전체 flex 컨테이너에서 글자가 줄바꿈되는 것을 감지하기 위한 임시방편이었음
- Part 내부에서는 `overflow: hidden` + `scrollWidth > clientWidth`로 정확한 감지 가능

### 결정 6: `genLineStyle()`에서 `justifyContent`/`letterSpacing`을 `genPartStyle()`로 이동

**선택**: Line은 레이아웃 컨테이너(`display:flex; flexDirection:row; nowrap`), Part가 텍스트 정렬/자간 담당

**이유**:
- Line은 여러 Part를 가로로 나열하는 역할만 수행
- `justifyContent: 'space-between'`(양끝정렬)은 Part 내부의 글자 배치에 적용되어야 함
- `letterSpacing`도 Part 내부 글자 간격에 적용
