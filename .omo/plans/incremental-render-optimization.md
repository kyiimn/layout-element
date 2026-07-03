# Plan: Incremental Render Optimization

## TL;DR (For humans)

문단 편집 시 줄 수가 변하지 않으면 DOM 재생성과 coordinate mapper 재구축을 스킵하여 타이핑 반응 속도를 크게 개선합니다. 세 가지 레벨의 최적화를 구현합니다:

1. **Line count diff**: `columnContents` 변경 전후 줄 수 비교 → 동일하면 `replaceChildren()` 스킵
2. **Span-level diff**: 변경된 글자만 DOM 업데이트 (기존 span 재사용)
3. **Paragraph-level skip**: 편집된 문단만 재계산, 아래 문단은 줄 수 변화 시에만 재배치

## Motivation

현재 `paragraph.render()`는 편집 시마다:
1. `TextLayoutEngine.layoutText()` 전체 재계산
2. `this.replaceChildren()` — 모든 기존 컬럼 DOM 삭제
3. 새 `<x-layout-column>` 요소 생성
4. 각 컬럼이 shadow DOM에서 모든 span 재생성
5. `EditCoordinateMapper.rebuild()` — 전체 offset 맵 재구축

한 글자 타이핑할 때마다 이 전체 파이프라인이 실행됩니다. 줄 수가 변하지 않으면 대부분의 작업이 불필요합니다.

## Architecture

### Key Insight

문단 편집 시:
- **줄 수 불변** → 아래 문단 위치 변화 없음 → overflow 불변 → DOM 재생성 불필요
- **줄 수 변화** → overflow 가능성 → 전체 재계산 필요 (현재와 동일)

### Approach: Three-Level Optimization

#### Level 1: Line Count Snapshot + Short-Circuit in `paragraph.render()`

`TextLayoutEngine`에 `_previousLineCount` 필드를 추가하고, `layoutText()` 실행 후 줄 수를 비교합니다. 동일하면 `replaceChildren()` + 컬럼 재생성을 스킵하고, `EditCoordinateMapper` 재구축만 실행합니다.

**주의**: 줄 수가 같아도 글자 내용이 바뀌면 span 업데이트가 필요합니다. 따라서 Level 1만으로는 불충분하고 Level 2와 결합해야 합니다.

#### Level 2: Span-Level DOM Diff

`columnContents`의 변경된 부분만 기존 DOM에 반영합니다. 새 span은 추가하고, 사라진 span은 제거하며, 변경된 span은 text content만 업데이트합니다.

#### Level 3: Paragraph-Level Skip (Not in scope for this iteration)

현재 아키텍처에서는 여러 문단이 있는 Box 내에서 한 문단만 편집해도 모든 문단이 재배치됩니다. 이는 Box 레벨의 최적화로, 별도 작업으로 분리합니다.

## TODOs

- [ ] 1. TextLayoutEngine에 line count snapshot 메커니즘 추가
- [ ] 2. ParagraphElement.render()에 line count 비교 로직 추가
- [ ] 3. ColumnElement에 span-level diff 렌더링 메서드 추가
- [ ] 4. EditCoordinateMapper에 incremental rebuild 지원 추가
- [ ] 5. EditController.postRender()에서 composition span 재첨부 로직 업데이트
- [ ] 6. npm run build 통과
- [ ] F1. Oracle 리뷰 — 목표/제약 검증
- [ ] F2. Oracle 리뷰 — 코드 품질 검증

### Task L1: TextLayoutEngine에 line count snapshot 추가

**Where**: `src/core/text-layout-engine.ts`
**What**: 
- `layoutText()` 실행 후 `_previousLineCount`에 현재 줄 수를 저장
- `_previousLineCount` getter 추가
- `_previousOverflow`에 현재 overflow 저장
- `preTextWrap()` 실행 시 두 값을 리셋 (구조가 바뀌므로)

**How**:
```typescript
// TextLayoutEngine에 추가
private _previousLineCount: number = -1;
private _previousOverflow: number = -1;

public get previousLineCount(): number { return this._previousLineCount; }
public get previousOverflow(): number { return this._previousOverflow; }

// layoutText() 끝에 추가
this._previousLineCount = this._columnContents.reduce((sum, col) => sum + col.length, 0);
this._previousOverflow = this._overflow;

// preTextWrap() 안에서 _initStructure() 호출 후 리셋
this._previousLineCount = -1;
this._previousOverflow = -1;
```

**Verification**: `npm run build` 통과, 기존 렌더링 동작 변화 없음

### Task L2: ParagraphElement.render()에 line count 비교 로직 추가

**Where**: `src/components/layout/paragraph.element.ts`
**What**:
- `render()`에서 `layoutText()` 또는 `preTextWrap()` 호출 전후로 line count를 비교
- line count와 overflow가 모두 동일하면 DOM 재생성을 스킵
- 단, `_textDirty` 플래그를 추가하여 텍스트 내용이 변경되었는지 추적
- DOM 스킵 시에도 `postRender()`는 호출 (coordinate mapper 재구축 불필요하지만 cursor 위치 업데이트는 필요)

**How**:
```typescript
// ParagraphElement에 추가
private _textDirty: boolean = true;

// model.inputContent setter에서 (또는 EditController에서) _textDirty = true 설정
// render() 안에서:

render() {
  if (!this.isConnected || !this._model) return;

  const lineCountBefore = this._model.previousLineCount;
  const overflowBefore = this._model.previousOverflow;

  if (this._structureDirty) {
    this._model.preTextWrap();
    this._structureDirty = false;
  } else {
    this._model.layoutText();
  }

  const lineCountAfter = this._model.columnContents.reduce((sum, col) => sum + col.length, 0);
  const overflowAfter = this._model.overflow;
  
  // 구조가 바뀌었거나 줄 수/overflow가 변경된 경우 전체 재렌더링
  const needsFullRender = this._structureDirty || 
    lineCountBefore !== lineCountAfter || 
    overflowBefore !== overflowAfter ||
    lineCountBefore === -1; // 첫 렌더링

  if (needsFullRender || this._textDirty) {
    // 기존 전체 렌더링 경로
    this.replaceChildren();
    const columnContents = this._model.columnContents;
    for (let i = 0; i < columnContents.length; i++) {
      const columnEl = document.createElement('x-layout-column');
      columnEl.index = i;
      this.appendChild(columnEl);
    }
  } else {
    // 증분 업데이트: 기존 컬럼에 변경된 내용만 반영
    const columnEls = this.querySelectorAll('x-layout-column');
    for (let i = 0; i < columnEls.length; i++) {
      const columnEl = columnEls[i] as LayoutColumnElement;
      columnEl.index = i; // index 업데이트
      columnEl.renderText(); // 내부 span diff
    }
  }

  this._textDirty = false;

  if (this._model.overflow > 0) { ... }
  
  if (this._editController) {
    this._editController.postRender();
  }
}
```

**주의**: `_textDirty`는 항상 true로 시작하고, `render()` 완료 후 false로 설정. 다음 편집 시 `EditController`에서 true로 설정. 이렇게 하면 줄 수가 같아도 텍스트 내용이 바뀐 경우에는 증분 업데이트(기존 컬럼 재사용)를 실행합니다.

**Verification**: `npm run build` 통과, 기존 렌더링 동작 유지

### Task L3: ColumnElement에 span-level diff 렌더링 메서드 추가

**Where**: `src/components/layout/column.element.ts`
**What**:
- 기존 `renderText()`는 shadow DOM을 완전히 지우고 재생성 (`this._shadowRoot.innerHTML = ''`)
- 새 메서드 `updateText()`를 추가하여 기존 span을 재사용하면서 변경된 부분만 업데이트
- line 수와 part 구조가 같으면 span의 text content만 업데이트
- line 수나 part 구조가 다르면 기존 `renderText()` fallback

**How**: 
이 태스크는 가장 복잡합니다. 기존 span 구조와 새 `columnContents`를 비교하여:
1. Line div가 같은 수 → 각 line 내부의 part div 구조 비교
2. Part div가 같은 수 → 각 part 내부의 span 수와 내용 비교
3. 내용이 다른 span만 `innerText` 업데이트
4. span 수가 다르면 해당 part만 재구축
5. Line이나 part 수가 다르면 전체 `renderText()` fallback

성능 측정 결과에 따라 복잡도를 조절할 수 있습니다. 초기 구현은:
- line 수가 같고 각 line의 총 span 수가 같으면 → span 내용만 업데이트
- 그 외 → 전체 `renderText()` fallback

**Verification**: `npm run build` 통과, 빠른 타이핑 시 반응 속도 개선 확인

### Task L4: EditCoordinateMapper에 incremental rebuild 지원 추가

**Where**: `src/edit/edit-coordinate-mapper.ts`
**What**:
- 현재 `rebuild()`는 전체 맵을 재구축합니다.
- DOM이 스킵된 경우(줄 수 불변) coordinate mapper도 재구축할 필요가 없습니다.
- `rebuild()`를 `fullRebuild()`와 `lightRebuild()`로 분리:
  - `fullRebuild()`: 현재 동작과 동일 (전체 재구축)
  - `lightRebuild()`: `_spanCache`만 clear (span 참조 갱신), offset 맵은 유지
- `paragraph.render()`에서 DOM 재생성을 스킵한 경우 `lightRebuild()` 호출
- 전체 재생성 시 `fullRebuild()` 호출

**Verification**: `npm run build` 통과, cursor 위치 정확도 유지

### Task L5: EditController.postRender()에서 composition span 재첨부 로직 업데이트

**Where**: `src/edit/edit-controller.ts`
**What**:
- `postRender()`의 composition span 재첨부 로직이 전체 DOM 재생성을 가정하고 있음
- 증분 렌더링 시에는 기존 span이 유지되므로 재첨부가 필요 없을 수 있음
- `_compositionSpan.parentNode` 체크 후 필요한 경우에만 재첨부

**Verification**: 한글 IME 조합 중 타이핑 시 span 유지 확인

### Task L6: Build 통과

**What**: 모든 변경 후 `npm run build`가 오류 없이 통과하는지 확인

### Task F1: Oracle 리뷰 — 목표/제약 검증

**What**: 구현된 최적화가 원래 목표(줄 수 불변 시 재계산 스킵)를 달성했는지, 기존 동작을 깨지 않았는지 검증

### Task F2: Oracle 리뷰 — 코드 품질 검증

**What**: 증분 렌더링 코드의 품질, 엣지 케이스 처리, 메모리 누수 가능성 검증

## Dependencies

```
L1 → L2 → L3 → L4 → L5 → L6 → F1 → F2
```

모든 태스크는 순차적으로 실행해야 합니다 (각 태스크가 이전 태스크의 결과에 의존).

## Constraints

- 기존 렌더링 결과와 시각적으로 동일해야 함 (픽셀 퍼펙트)
- `npm run build` 오류 없이 통과
- 한글 IME 조합, 커서 이동, 선택 영역 등 기존 편집 기능이 정상 동작
- `_structureDirty` 플래그와 `_textDirty` 플래그가 올바르게 관리되어야 함
- overflow 변경 감지가 정확해야 함

## Notepad Paths

- READ/WRITE: `.omo/notepads/incremental-render-optimization/learnings.md`
- READ/WRITE: `.omo/notepads/incremental-render-optimization/issues.md`