# incremental-render-strategy3 - Work Plan

## TL;DR (For humans)

**What you'll get:** 텍스트 편집 시 변경된 글자만 DOM에 반영하는 증분 렌더링 시스템. 기존에는 한 글자 입력해도 해당 컬럼의 모든 span(수백 개)을 삭제하고 재생성했지만, 이제는 변경된 span만 갱신하여 DOM 조작을 최소화합니다.

**Why this approach:** Key 기반 span 관리(전략 3)를 사용하여 각 span을 소스 오프셋으로 식별합니다. 삽입/삭제 시 기존 span을 최대한 재사용하고 DOM 순서만 조정하여, React의 reconciliation과 유사한 방식으로 동작합니다.

**What it will NOT do:**
- `TextLayoutEngine`의 텍스트 래핑 알고리즘을 변경하지 않습니다
- `EditController`의 편집 로직을 변경하지 않습니다
- `EditCoordinateMapper`를 수정하지 않습니다 (Metis 검증 결과 불필요)
- `paragraph.render()`의 `needsFullRecreate` 판정 로직을 변경하지 않습니다
- 테스트 코드를 추가하지 않습니다 (테스트 인프라 없음)

**Effort:** Medium
**Risk:** Low - 단일 파일 수정, 기존 속성 유지, 호환성 보장
**Decisions to sanity-check:** `data-source-offset`은 diff 내부에서만 사용, `data-offset`은 기존 동작 유지

Your next move: 계획 승인 후 실행. 상세 실행 계획은 아래에 있습니다.

---

> TL;DR (machine): Medium, Low risk, 1 file modified (column.element.ts), key-based span diff rendering using data-source-offset

## Scope
### Must have
- `column.element.ts`의 `renderText()`를 key 기반 diff 렌더링으로 전면 재작성
- 각 span에 `data-source-offset` 속성 추가 (기존 `data-offset` 유지 — EditCoordinateMapper가 사용)
- `data-offset`은 올바른 rendered offset 값을 유지해야 함 (getCharOffsetFromPoint 등이 의존)
- COVER 라인(parts가 빈 라인) 처리: N→0, 0→N 전환 명시적 처리
- 낙관적 span(`data-temporary`): diff에서 제외하고 **제거** (유지하지 않음)
- `<style>` 요소: 갱신 (재생성하지 않음)
- model undefined 시: 기존 라인 요소 모두 제거
- `npm run build` 통과

### Must NOT have (guardrails, anti-slop, scope boundaries)
- `TextLayoutEngine` 수정 금지
- `EditController` 수정 금지
- `EditCoordinateMapper` 수정 금지 (Metis 검증 결과 불필요)
- `paragraph.element.ts` 수정 금지
- `render()`의 `needsFullRecreate` 로직 수정 금지
- `data-offset` 속성 제거 금지
- 새 의존성 추가 금지
- 테스트 파일 생성 금지

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: none (테스트 인프라 없음) + `npm run build` + Playwright 브라우저 검증
- Evidence: .omo/evidence/task-<N>-incremental-render-strategy3.<ext>

## Execution strategy
### Parallel execution waves

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2 | — |
| 2 | 1 | 3 | — |
| 3 | 2 | 4 | — |
| 4 | 3 | F1-F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.

- [ ] 1. `data-source-offset` 속성 추가 + source offset 추적 로직 구현
  What to do: `renderText()`의 span 생성 루프(line 108-116)에서 `charEl.dataset.sourceOffset` 추가. 값은 source offset이어야 함. source offset 추적은 `_rebuildMappings()`와 동일한 3단계 조정 적용:
  1. **첫 파트 선행 공백**: 각 선행 공백마다 `sourceOffset++` (renderedOffset은 증가하지 않음)
  2. **마지막 파트 후행 공백**: 원본 `part.content.join('')`에서 후행 공백 카운트, `sourceOffset += trailingSpaces` (renderedOffset은 증가하지 않음)
  3. **endOfBlock**: `sourceOffset++` (줄바꿈 `\n` 반영)
  현재 `renderText()`는 `renderedOffset`만 추적하므로, `sourceOffset` 변수를 추가하고 위 3단계를 적용. 기존 `data-offset`은 `renderedOffset`으로 계속 설정.
  Must NOT do: 기존 `data-offset` 속성 제거 금지. `renderText()`의 전체 구조 변경 금지. 이 단계에서는 속성 추가와 source offset 추적만 수행.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2
  References:
  - `src/components/layout/column.element.ts:32-119` (renderText 전체)
  - `src/components/layout/column.element.ts:108-116` (span 생성 루프)
  - `src/components/layout/column.element.ts:42-57` (renderedOffset 계산 로직)
  - `src/edit/edit-coordinate-mapper.ts:46-99` (_rebuildMappings — source offset 3단계 조정의 정확한 로직)
  - `src/types/layout/text/text-line.type.ts:22-51` (TextLineData, TextPartData)
  Acceptance criteria:
  1. `npm run build` 통과
  2. Playwright: `document.querySelector('x-layout-column').shadowRoot.querySelector('span[data-source-offset]')`가 null이 아님
  3. Playwright: 각 span의 `data-source-offset` 값이 `_rebuildMappings()`의 `_renderedToSource` 맵과 일치:
  ```javascript
  const mapper = paragraph._editController._mapper;
  const spans = column.shadowRoot.querySelectorAll('span[data-source-offset]:not([data-temporary])');
  for (const span of spans) {
    const sourceOffset = parseInt(span.dataset.sourceOffset);
    const renderedOffset = parseInt(span.dataset.offset);
    const mapped = mapper.sourceOffset(renderedOffset);
    if (mapped !== sourceOffset) throw new Error(`Mismatch: data-source-offset=${sourceOffset}, mapper=${mapped}`);
  }
  ```
  QA scenarios:
  - happy: 빌드 성공 + 모든 span의 source offset이 mapper와 일치. Evidence: .omo/evidence/task-1-incremental-render-strategy3.txt
  - failure: source offset 불일치 시 에러. Evidence: .omo/evidence/task-1-incremental-render-strategy3.txt
  Commit: N | feat(column): add data-source-offset attribute with source offset tracking

- [ ] 2. `renderText()` 헬퍼 메서드 추출
  What to do: `renderText()`의 거대한 단일 메서드를 작은 헬퍼 메서드들로 분해:
  1. `_computeSourceOffsets()`: 각 컬럼의 시작 source offset과 각 span의 source offset 배열을 반환. `_rebuildMappings()`와 동일한 3단계 조정 적용.
  2. `_createLineElement(lineData, textBlockStyle)`: 라인 div 요소 생성 (기존 line 74-76)
  3. `_createPartElement(part, lineData, curPartStyle, partJustify)`: 파트 div 요소 생성 (기존 line 99-106)
  4. `_createSpanElement(char, renderedOffset, sourceOffset)`: span 요소 생성 (기존 line 110-115), `data-offset`과 `data-source-offset` 모두 설정
  5. `_stripSpaces(content, isFirst, isLast)`: 첫/마지막 파트의 공백 제거 (기존 line 92-97)
  Must NOT do: `renderText()`의 공개 API 변경 금지. 메서드는 private. 기존 동작 유지.
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 3
  References:
  - `src/components/layout/column.element.ts:32-119` (renderText 전체)
  - `src/components/layout/column.element.ts:9-11` (_index, _shadowRoot)
  - `src/components/layout/column.element.ts:147-149` (model getter)
  - `src/core/text-layout-engine.ts:848` (genCharStyle)
  - `src/core/text-layout-engine.ts:735` (genLineStyle)
  - `src/core/text-layout-engine.ts:766` (genPartStyle)
  - `src/core/text-layout-engine.ts:703` (genColumnStyle)
  Acceptance criteria: `npm run build` 통과. Playwright에서 편집 모드 활성화 후 텍스트 표시가 기존과 동일.
  QA scenarios:
  - happy: 빌드 성공 + Playwright에서 텍스트 렌더링 정상. Evidence: .omo/evidence/task-2-incremental-render-strategy3.txt
  - failure: 빌드 에러. Evidence: .omo/evidence/task-2-incremental-render-strategy3.txt
  Commit: N | refactor(column): extract renderText helpers

- [ ] 3. `<style>` 요소 갱신 로직 + early return 처리
  What to do:
  1. `renderText()` 시작 시 `innerHTML = ''` 제거. 대신 기존 `<style>` 요소를 찾아서 갱신. 없으면 생성.
  2. `!this.model || this._index === undefined`인 경우: 기존 라인 요소들 모두 제거 (style 요소는 유지).
  3. 기존 라인 요소들을 `_shadowRoot`에서 가져오기 (`<style>` 요소 제외, `data-temporary` span 제외).
  Must NOT do: `EditCoordinateMapper` 수정 금지. `paragraph.element.ts` 수정 금지.
  Parallelization: Wave 3 | Blocked by: 2 | Blocks: 4
  References:
  - `src/components/layout/column.element.ts:33-36` (early return + innerHTML='')
  - `src/components/layout/column.element.ts:59-66` (style 요소 생성)
  - `src/edit/edit-controller.ts:1497-1508` (_createOptimisticSpan — data-temporary 속성)
  Acceptance criteria: `npm run build` 통과. Playwright에서 컬럼 스타일 정상 적용.
  QA scenarios:
  - happy: 빌드 성공 + 컬럼 스타일 정상. Evidence: .omo/evidence/task-3-incremental-render-strategy3.txt
  - failure: 스타일 미적용. Evidence: .omo/evidence/task-3-incremental-render-strategy3.txt
  Commit: N | refactor(column): preserve style element and handle early returns in renderText

- [ ] 4. Key 기반 diff 렌더링 구현
  What to do: `renderText()`에 key 기반 diff 렌더링 구현. 핵심 알고리즘:
  1. 기존 라인 요소들을 `_shadowRoot`에서 가져오기 (`<style>` 제외)
  2. 새 `columnContents`와 기존 DOM 라인을 비교:
     - 라인 수가 같으면: 각 라인의 파트를 비교
     - 라인 수가 다르면: 불필요한 라인 제거, 부족한 라인 추가
  3. 각 파트 내에서 span diff:
     - 기존 span들을 `data-source-offset` 기준으로 Map에 저장
     - **`data-temporary` span은 Map에서 제외하고 즉시 제거** (낙관적 span은 re-render 시 제거됨)
     - 새 content의 각 문자에 대해 source offset 계산
     - 기존 span이 있으면: innerText 갱신, 스타일 갱신, `data-offset` 갱신 (올바른 rendered offset), DOM 순서 조정 (`insertBefore`)
     - 기존 span이 없으면: 새 span 생성
     - 사용되지 않은 기존 span 제거
  4. COVER 라인(parts가 빈 라인) 처리:
     - 새 라인이 COVER (parts.length === 0): 기존 라인의 모든 파트/span 제거, 라인 div만 유지
     - 새 라인이 non-COVER, 기존이 COVER: 모든 파트/span 새로 생성
     - COVER → COVER: 아무 작업 없음
  5. 낙관적 span(`data-temporary="true"`): **제거** (유지하지 않음). `postRender`에서 `_optimisticSpan = null`로 참조가清除되므로 DOM에서도 제거해야 함.
  Must NOT do: `TextLayoutEngine` 수정 금지. `EditCoordinateMapper` 수정 금지. `paragraph.element.ts` 수정 금지. `data-offset` 속성 제거 금지.
  Parallelization: Wave 4 | Blocked by: 3 | Blocks: F1-F4
  References:
  - `src/components/layout/column.element.ts:32-119` (기존 renderText)
  - `src/types/layout/text/text-line.type.ts:22-51` (TextLineData, TextPartData)
  - `src/edit/edit-coordinate-mapper.ts:46-99` (_rebuildMappings — source offset 계산 로직 참고)
  - `src/edit/edit-controller.ts:1497-1508` (_createOptimisticSpan — data-temporary 속성)
  - `src/edit/edit-controller.ts:293` (postRender — _optimisticSpan = null)
  - `src/components/layout/paragraph.element.ts:138-200` (render — needsFullRecreate 판정, renderText 호출)
  Acceptance criteria:
  1. `npm run build` 통과
  2. Playwright: 편집 모드에서 텍스트 입력, 삭제, 커서 이동, 드래그 선택, IME 조합 모두 정상 동작
  3. Playwright: 한 글자 입력 후 기존 span이 재사용됨 (참조 동등성):
  ```javascript
  // 입력 전 span 수집
  const spansBefore = Array.from(column.shadowRoot.querySelectorAll('span[data-source-offset]:not([data-temporary])'));
  // 한 글자 입력 (textarea에 이벤트 발생)
  // re-render 대기
  const spansAfter = Array.from(column.shadowRoot.querySelectorAll('span[data-source-offset]:not([data-temporary])'));
  const reusedCount = spansAfter.filter(s => spansBefore.includes(s)).length;
  // 대부분의 span이 재사용되어야 함 (변경된 라인의 span만 새로 생성)
  ```
  4. Playwright: re-render 후 `data-temporary` span이 DOM에 없음:
  ```javascript
  const tempSpans = column.shadowRoot.querySelectorAll('span[data-temporary]');
  if (tempSpans.length > 0) throw new Error(`${tempSpans.length} stale optimistic spans remain`);
  ```
  QA scenarios:
  - happy: 빌드 성공 + 모든 편집 기능 정상 + span 재사용 확인 + 낙관적 span 제거 확인. Evidence: .omo/evidence/task-4-incremental-render-strategy3.txt
  - failure: any 기능 비정상, 또는 span 재사용 안 됨, 또는 낙관적 span 잔존. Evidence: .omo/evidence/task-4-incremental-render-strategy3.txt
  Commit: N | feat(column): key-based incremental span rendering in renderText

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit — 계획의 모든 todo가 구현되었는지 확인
- [ ] F2. Code quality review — 코드 품질, 타입 안전성, noUnusedLocals 준수
- [ ] F3. Real manual QA — Playwright 브라우저에서 편집 기능 전체 검증
- [ ] F4. Scope fidelity — TextLayoutEngine, EditController, EditCoordinateMapper, paragraph.element.ts 수정 없음 확인

## Commit strategy
모든 작업 완료 후 사용자 승인 시 하나의 커밋으로 통합:
```
feat(column): key-based incremental span rendering

- renderText() rewritten to use key-based span diff (data-source-offset)
- Existing spans reused when content unchanged; only changed spans updated
- data-offset retained for EditCoordinateMapper compatibility
- COVER lines and optimistic spans (data-temporary) handled correctly
- Eliminates full innerHTML='' teardown per render cycle
```

## Success criteria
1. `npm run build` 통과 (0 에러)
2. Playwright에서 편집 모드의 모든 기능 정상 동작 (입력, 삭제, 커서, 선택, IME)
3. `data-source-offset` 속성이 모든 span에 존재하고 값이 정확함
4. `data-offset` 속성이 모든 span에 존재하고 값이 정확한 rendered offset임
5. `TextLayoutEngine`, `EditController`, `EditCoordinateMapper`, `paragraph.element.ts` 수정 없음
6. 한 글자 입력 시 기존 span이 재사용됨 (DOM 참조 동등성)
7. re-render 후 `data-temporary` span이 DOM에 없음
8. `innerHTML = ''`가 발생하지 않음 (DOM 조작 최소화)