# 대화 기록: x-layout-table 요소 설계

---

## 사용자

새로운 요소를 추가합니다.
x-layout-table 요소를 추가합니다.
html의 table과 같이 <x-layout-tr><x-layout-td>태그가 함께 추가될것이고,
tr에서 높이지정, table태그의 특정속성에 셀별 너비지정을 합니다(colwidth를 table에 속성에서 처리).
td에 각 방향별 border, border-width, border-color을 지정할수 있는데,
인접해 있는 셀과 border 정보를 공유합니다. 예를 들어 A셀 오른쪽에 B셀이 있다면 A셀의 오른쪽 border과 B셀의 왼쪽 border은 동일합니다.
그리고 html의 table과 마찬가지로 colspan, rowspan을 지원해야 합니다.
table 및 tr, td의 높이/너비는 다른 항목과 마찬가지로 mm단위를 사용하고 셀별로 배경색 및 배경투명도 지정이 가능합니다.
각 셀은 box와 동일하게 작동합니다. (paragraph box 및 image box 삽입 가능, table 중첩 가능)
셀에 좌상-우하 및 우상-좌하 대각선 가능.
속성이나 렌더링 등은 기존 다른 요소의 스타일.. 룰을 따름.
구현은 하지 말고 이러한 요소를 추가하는것에 대한 설계를 해주세요.

---

## Sisyphus

I read this as **evaluation/design**: propose a design for `x-layout-table` + `x-layout-tr` + `x-layout-td` elements that fit the existing layout-element architecture. No implementation.

Let me ground the design in the actual codebase patterns before proposing.

(codegraph 탐색 및 파일 읽기 수행)

---

# `<x-layout-table>` 요소 설계

## 1. 요소 트리 및 개요

```
<x-layout-table>              ← 테이블 컨테이너. colWidths, 행/열 그리드 관리, border-collapse 레이어 보유
  <x-layout-tr>               ← 행. height(mm) 지정
    <x-layout-td>             ← 셀. colspan/rowspan, 4방향 border 선언, 대각선, box-equivalent 컨테이너
      <x-layout-box>          ← box와 동일하게 paragraph/image/nested-table을 자식으로 가짐
        <x-layout-paragraph> | <x-layout-image> | <x-layout-table>
```

세 요소 모두 `attachShadow({ mode: "open" })` + `styleEl.sheet.insertRule()` 방식을 기존 요소와 동일하게 사용합니다. `<x-layout-table>`과 `<x-layout-tr>`은 구조용 컨테이너이고, **`<x-layout-td>`가 실제 box-equivalent 컨테이너**입니다.

## 2. 데이터 모델 (Type 정의)

`src/types/layout/table.type.ts` (신규) — 기존 `box.type.ts`의 스타일/보더 모델을 재사용하되, 방향별로 확장합니다.

(타입 정의 생략 — 문서 참조)

## 3. 좌표계 및 그리드 해석

### 3.1 테이블 외부 배치
`<x-layout-table>` 자체는 기존 box와 동일하게 부모의 `GridCalculator` 위에 배치됩니다.

### 3.2 테이블 내부 그리드 (TableGridResolver)
신규 유틸 `src/core/table-grid-resolver.ts`에서 colspan/rowspan을 고려하여 셀들의 실제 (x, y, width, height)를 계산.

## 4. 보더 모델 — 인접 셀 공유 (border-collapse)

### 4.1 엣지 해석 (BorderResolver)
- 수평 엣지: 셀 (r,c)의 borderBottom ≡ 셀 (r+1,c)의 borderTop
- 수직 엣지: 셀 (r,c)의 borderRight ≡ 셀 (r,c+1)의 borderLeft
- 충돌 시 결정적 우선순위 적용

### 4.2 렌더링 (테이블 shadow DOM의 border layer)
`<x-layout-table>`의 shadow DOM에 별도 보더 레이어를 두고, 해석된 각 엣지를 하나의 div로 렌더링.

## 5. 대각선 (Diagonals)
TD shadow DOM에 SVG 또는 div+transform으로 렌더링.

## 6. 렌더링 파이프라인 (기존 3단계 패턴 준수)

## 7. 편집 시스템 통합 (box-equivalent 동작)

## 8. React 래퍼

## 9. 문서화/인덱스 갱신

## 10. 해결 필요 설계 포인트 (Open Questions)

---

## 사용자

rows, cells 라는 속성보다는 기존의 다른요소와 같이 children으로 명명하는게 낫겠습니다.
그리고 셀의 children에는 BoxData[]만 있으면 될것같습니다. 어차피 Box아래에 paragraph, image, table가 오기때문에... 오히려 cell 아래에 paragraph, image, table가 바로 오면 처리가 더 어렵습니다.
TableData에는 left, top, position, width, height, backgroundcolor, backgroundopacity, border... 등 box 필드는 필요없습니다. 어차피 box안에 있어야 하기때문에 box에서 정의하면 됩니다.

---

## Sisyphus

좋은 피드백입니다. 세 가지 변경 사항으로 설계가 상당히 간소화됩니다:

1. `rows`/`cells` → `children` (기존 명명법과 일치)
2. `TableCellData.children` = `BoxData[]` 전용 (콘텐츠는 항상 box로 래핑됨)
3. `TableData`에서 box 필드 제거 — table은 box 안의 **콘텐츠 타입**이며, box가 위치/배경/외곽선 테두리를 정의합니다.

이는 table을 `ParagraphData`/`ImageData`와 동급의 "box 내 콘텐츠"로 만들어 아키텍처를 기존 패턴과 훨씬 일치시킵니다. 수정된 설계입니다.

(수정된 설계 제시 — table을 box 내 콘텐츠 타입으로 격하)

---

## 사용자

셀 내에서는 기본적으로 1단으로 처리합니다. 만약 단을 나눌꺼라면 그 안의 paragraph에서 재정의하면 됩니다.

---

## Sisyphus

좋습니다. 이는 TD의 GridCalculator 역할을 단순화합니다 — TD는 **1단 컨테이너 컨텍스트**만 제공하고, 다단이 필요하면 그 안의 paragraph가 자체 `columns`/`gap` 설정으로 재정의합니다.

TD는 `columns: 1` 단일 컨테이너 컨텍스트만 제공. 다단은 paragraph가 기존 방식대로 자체 `columns`/`gap`으로 재정의. TD GridCalculator 역할 단순화, 기존 paragraph 다단 파이프라인 그대로 재사용.

---

## 사용자

보더 충돌에 대해서는 나중에 등장하는 값을 우선으로 합니다. 그리고 추후 직접 border 설정을 주입하면 그것을 따릅니다.
A 오른쪽에 B가 있을때 A의 오른쪽 border를 설정하면 B의 왼쪽 border까지 적용.. 그리고 공유하는것임. 렌더링때는 하나만 렌더링.
각 row의 첫번째 col만.. 왼쪽 오른쪽을 다 그리고, 그 이후부터는 오른쪽 border만 렌더링하는것을 규칙으로.

---

## Sisyphus

## 4. 보더 모델 (수정)

### 4.1 보더 공유 규칙
A셀 오른쪽에 B셀이 인접할 때 인접한 두 셀의 맞닿은 엣지는 동일한 보더를 가짐.

### 4.2 충돌 해결 규칙
나중에 등장하는 셀의 값을 우선. 직접 border 설정 주입이 있으면 최우선.

### 4.3 렌더링 규칙 (행 우선, 좌→우)
- 첫 번째 col: left + right 둘 다 렌더링
- 두 번째 col 이후: right만 렌더링
- 수평 엣지도 동일 로직을 행 단위로 적용

---

## 사용자

다른 요소들의 구현과 마찬가지로 자지구레한건 shadow root로 숨기고 실제 밖으로는 <x-layout-table><x-layout-tr><x-layout-td><x-layout-box>만 노출하도록...

---

## Sisyphus

기존 요소 패턴과 일치시키는 DOM 캡슐화 규칙을 반영합니다.

모든 내부 구현(보더 레이어, 대각선, 스타일 시트, 캔버스 등)은 각 요소의 shadow root 내부에 캡슐화하고, 외부(light DOM)에는 네 가지 태그만 노출합니다.

shadow root 캡슐화로 외부에는 `<x-layout-table>`/`<x-layout-tr>`/`<x-layout-td>`/`<x-layout-box>` 네 태그만 노출. 보더 레이어, 대각선, 스타일 등 자잘한 구현은 기존 요소와 동일하게 shadow root 내부에 숨김. MutationObserver, data setter reconciliation 등 기존 메커니즘 그대로 동작.

---

## 사용자

지금까지 사항을 그린필드에서 개발이 가능하도록 개발 계획 문서로 작성해주세요. 최대한 상세하게... 기본적인 알고리즘, class 소스 구성 등 멍청한 AI모델에게 던져줘도 개발할수 있을만큼 최대한 상세하게...

---

## Sisyphus

개발 계획 문서를 작성하기 전에, 계획을 정확하게 만들기 위해 몇 가지 기존 패턴을 확인하겠습니다.

(기존 코드 패턴 분석 후 `docs/PLAN_TABLE_ELEMENT.md` 작성)

개발 계획 문서를 `docs/PLAN_TABLE_ELEMENT.md`에 작성했습니다.

13개 섹션 + 부록으로 구성된 상세 개발 계획:

| 섹션 | 내용 |
|---|---|
| **0. 선수 지식** | 기존 아키텍처 요약 |
| **1. 요소 트리** | 외부 노출 DOM 4태그 + shadow DOM 캡슐화 맵 |
| **2. 타입 정의** | TableData/TableRowData/TableCellData/CellBorderEdge 전체 소스 |
| **3. 상수** | Z_INDEX 상수 |
| **4. TableGridResolver** | colspan/rowspan 그리드 배치 알고리즘 |
| **5. BorderResolver** | 보더 공유/중복 제거 알고리즘 |
| **6. 커스텀 요소** | 3개 요소의 클래스 멤버 + 핵심 메서드 상세 구현 |
| **7. 기존 요소 수정** | box의 table 인식 |
| **8. 편집 통합** | LayoutElement 타입 확장 등 |
| **9. React 래퍼** | LayoutTable/TR/TD 컴포넌트 |
| **10. 파일 레이아웃** | 신규/수정 파일 명세 |
| **11. 구현 순서** | Phase 1~7 단계별 작업 |
| **12. 검증 체크리스트** | 30개 확인 항목 |
| **13. 해결 필요 포인트** | Open Questions |

---

## 사용자

layout 편집모드에서는 마우스를 이용하여 셀너비, row 높이를 조정할수 있도록...

---

## Sisyphus

기존 box 리사이즈는 8개 핸들 div를 shadow root에 생성하고, mousedown 시 핸들 방향을 읽어 BoxResizeState로 관리하며, requestAnimationFrame 안에서 mm 단위로 box.left/top/width/height를 갱신합니다. 테이블 셀/행 리사이즈도 같은 패턴으로 설계하되, box가 아니라 colWidths/rowHeights를 조정한다는 점이 다릅니다.

(8A 섹션 추가: 테이블 셀/행 리사이즈 — 핸들 렌더링, TableResizeState, mousedown/mousemove/mouseup/keydown 핸들러, 너비/높이 재분배 알고리즘, ESC 취소, 최소 크기 상수 등)

---

## 사용자

셀에 box요소가 들어있게되면 box의 resizer와 중첩되게 되고 사실상 table를 선택하지 않는 이상 resizer를 노출할수도 없고, 편집도 불가능합니다.
이것은 사용자 편의성 면에서 굉장히 불리합니다. 어떤 전략이 있을까요??

---

## Sisyphus

핵심 문제를 정확히 짚으셨습니다. 현재 설계의 충돌 지점을 정리하면:

**충돌 시나리오**: TD 안의 box가 TD를 채우면 → box의 8개 resize-handle이 TD 테두리(=table 경계선)에 위치 → table의 수직/수평 handle과 동일한 위치에 겹침.

## 전략 후보

- **전략 A**: table resizer 항상 표시 + z-index 우선
- **전략 B**: TD를 채우는 box의 resizer 비활성화
- **전략 C**: 계층적 선택 모델 + 더블클릭 전환
- **전략 D**: box resizer 위치 오프셋
- **전략 E**: table resizer를 외부 오버레이로 분리
- **전략 F**: TD 안의 box는 리사이즈 불가, 이동만 가능

## 추천 조합: B + C

1. table resizer는 편집 모드에서 항상 표시
2. TD를 채우는 box의 resizer 자동 비활성화
3. TD 안의 복수 box / 부분 배치 box는 resizer 유지
4. 계층적 선택으로 box resizer 노출 제어

---

## 사용자

네. 그렇게 하여 반영해주세요.

---

## Sisyphus

(B+C 조합 전략을 8A 섹션에 반영 — 8A.0 핸들 중첩 문제 해결 전략, isBoxFillingCell 판별 알고리즘, [hide-resize] 속성, hideResizeHandles setter, _updateChildBoxResizeVisibility 등 추가)

---

## 사용자

지금 설계에서 table내의 paragraph의 경우도 overlap 처리에는 문제가 없나요?

---

## Sisyphus

핵심 문제를 발견했습니다. overlap 처리 흐름을 분석한 결과, table 컨테이너에서 overlap이 TD 경계를 넘어 오작동할 위험이 있습니다.

## 분석

기존 overlap 흐름:
1. paragraph.overlayElements → parentElement(box).overlayElements + parentElement.items 중 zIndex 높은 형제 box
2. box.overlayElements → 재귀적으로 parentElement.overlayElements + parentElement.items

table 컨텍스트에서의 문제:
1. TD에 overlayElements getter가 없음 → 런타임 에러
2. TD/TR/table에 type 프로퍼티가 없음 → 재귀가 document까지 계속 올라감
3. TR에 items getter가 없음 → 에러
4. 인접 TD가 overlap 대상에 포함됨 → 잘못된 동작

## 해결 방안

TD를 overlap 재귀의 종료점으로 지정 (최초 설계):
- TD overlayElements → 빈 배열 반환 (부모로 올라가지 않음)
- TR/table overlayElements → 빈 배열 반환 (안전망)
- TD/TR/table type 프로퍼티 추가
- TR/table items getter 추가

(8.8 섹션 추가)

---

## 사용자

table은 하나의 덩어리로 생각해야 하기때문에 table과 동급이거나 상위에 이미지등이 있으면 overlap 처리를 해야 합니다.

---

## Sisyphus

좋은 지적입니다. table은 하나의 덩어리(=부모 box의 콘텐츠)이므로, table의 형제 또는 상위에 있는 image box가 table 내부 paragraph의 overlap 대상이 되어야 합니다. 즉, TD가 overlap 재귀를 차단하면 안 됩니다.

## 수정된 흐름

TD/TR/table은 overlayElements에서 부모로 재귀를 계속 올라가되, 자신의 items는 overlay 대상에서 제외. 인접 TD 제외는 box.overlayElements의 기존 i.type === 'box' 필터로 자동 처리.

(8.8 섹션을 "table을 하나의 덩어리로 처리"로 전면 수정 — TD/TR/table이 부모로 재귀 전달, type 프로퍼티로 인접 TD 자동 제외)

---

## 사용자

printpostdata 추출을 위해 하위에 있는 box, paragraph, image 등에 절대 위치를 제공해야 합니다.
그리고 table 자체도 border나 배경 색상등의 정보를 제공해야 합니다.

---

## Sisyphus

기존 printPostData 패턴을 분석했습니다. box는 자신의 rect + 색상 + data를 PrintPostData로 push하고, 자식들의 printPostData를 재귀적으로 합칩니다. 모든 rect는 getBoundingClientRect() 기반 픽셀 좌표(= 절대 위치)입니다.

(8.9 섹션 추가: PrintPostData — 인쇄 후처리용 데이터 추출)

---

## 사용자

제가 table 자체라고 표현한 것은 table, tr, td 모두를 지칭하는 것입니다.

---

## Sisyphus

이전 설계에서 TableData의 backgroundColor/border 필드를 제거했던 것과 충돌하는 요청입니다. 사용자의 의도를 정확히 반영하기 위해 확인하겠습니다.

(질문: table/TR에 시각적 필드 추가 vs 기존 정보를 printPostData에 포함)

---

## 사용자

borderedge가 뭔가요?

---

## Sisyphus

borderEdges의 정의부터 명확히 하고, 질문에 다시 답변해 주시겠어요?

## borderEdges란?

이전 설계에서 정의한 테이블 셀 간 그리드 라인(border-collapse 레이어) 정보입니다. BorderResolver가 인접 셀의 방향별 보더 선언을 해석하여 중복을 제거한 엣지 집합을 생성하는데, 각 엣지가 borderEdge입니다.

(3×2 테이블 예시로 borderEdge 설명)

(재질문: table/TR에 시각적 필드 추가 vs 기존 정보를 printPostData에 포함)

---

## 사용자

이미 있는 정보들에 대한 것입니다. 새로운 속성의 추가는 없습니다.

---

## Sisyphus

명확합니다. "table 자체도 border/배경 정보를 제공해야 한다"는 말씀은 기존에 이미 가지고 있는 정보(table의 borderEdges, TD의 border/배경/diagonals)를 각 요소의 printPostData에 포함하라는 의미이며, 새로운 데이터 모델 필드 추가는 없습니다.

8.9 섹션은 이미 이 방향으로 작성되어 있습니다. (6.3의 TD printPostData 반환 타입 수정, 검증 체크리스트 12.8 추가, 파일 레이아웃/Phase 갱신)

---

## 사용자

계획 파일의 위치는 최상위여야 합니다. docs는 아닙니다.

---

## Sisyphus

PLAN_TABLE_ELEMENT.md를 패키지 최상위로 이동했습니다.

---

## 사용자

지금의 대화도 있는 그대로 모두 추출하여 파일로 기록해주세요.