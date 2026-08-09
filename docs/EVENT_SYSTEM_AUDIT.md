# EditManager 이벤트 시스템 결함 감사 보고서

> **감사 일자**: 2026-08-10
> **감사 대상**: `layout-element` 패키지의 `EditManager` 이벤트 시스템 전체
> **감사 방법**: Explore 에이전트(코드 매핑) + Oracle 에이전트(심층 추론 분석) 2단계 위임
> **검증 범위**: 아래 8개 파일의 이벤트 디스패치, 트리거, 상태 가드, 플래그 수명주기 전수 조사

---

## 검증 대상 파일

| 파일 | 역할 |
|------|------|
| `src/edit/edit-manager.ts` | EditManager 싱글톤 — 19개 이벤트 타입 디스패치, 재진입 가드, 클릭 억제, 모드 전환 |
| `src/edit/text-edit-controller.ts` | 텍스트 편집 이벤트 트리거 (focus/blur, textChange, cursorMove, selection, IME) |
| `src/edit/layout-edit-controller.ts` | 레이아웃 드래그/리사이즈/reparent 이벤트 트리거 |
| `src/edit/layout-selection-controller.ts` | 클릭/더블클릭/우클릭 선택 처리 |
| `src/edit/insert-controller.ts` | 삽입 모드 이벤트 트리거 |
| `src/edit/place-gun-controller.ts` | Place Gun 클릭 배치 이벤트 트리거 |
| `src/edit/table-keyboard-controller.ts` | 셀 블록 선택 이벤트 트리거 |
| `src/components/layout/box.element.ts` | Box 속성 변경 이벤트 트리거 (role, contentUid, groupMember, priority, zIndex) |

---

## 결함 요약 표

| ID  | 심각도 | 카테고리 | 위치 | 한 줄 요약 |
|-----|--------|----------|------|-----------|
| C1  | Critical | 느슨한 제약 | edit-manager.ts:1712, 1741, 1824 | `_suppressNextClick` 타임아웃 없음 — 다음 무관 클릭을 조용히 삼킴 |
| C2  | Critical | 이벤트 꼬임 | edit-manager.ts:2340, 263, 2243, 1708, 565 | 전역 `_dispatching` 가드가 연쇄 이벤트를 조용히 삼킴 |
| C3  | Critical | 논리적 하자 | edit-manager.ts:1621-1631 | `insertMode` isDragging 우회로 두 모드 동시 활성 |
| H1  | High | 누락된 디스패치 | edit-manager.ts:479-487 | `_unregister`가 `layoutSelectionChange` 미발생 — 고아 선택 |
| H2  | High | 이벤트 꼬임 | layout-edit-controller.ts:2132, 2139 | `_tryReparent`가 DOM 제거 후 `layoutRemove` 발생 — 문서-코드 불일치 |
| H3  | High | 누락된 디스패치 | layout-edit-controller.ts:537 | `_cloneBoxForAltDrag`가 `layoutAdd` 미발생 |
| H4  | High | 누락된 디스패치 | text-edit-controller.ts:1636-1654 | `_onCompositionCancel` 이벤트 미발생 — 상태 분기 |
| H5  | High | 이중 발생 | text-edit-controller.ts:820-821, 1051-1052 | `cursorMove` 비반복 키에서 이중 발생 (KeyDown + KeyUp) |
| H6  | High | 이중 발생 | layout-selection-controller.ts:757-758 | `_onContextMenu`가 `layoutSelectionChange` 2회 연속 발생 |
| M1  | Medium | 누락된 디스패치 | text-edit-controller.ts:744-748 | `_selectAll` (Ctrl+A) `selectionStart`/`selectionEnd` 미발생 |
| M2  | Medium | 누락된 디스패치 | text-edit-controller.ts:762-763 | `_clearSelection` (ESC) `selectionEnd` 미발생 |
| M3  | Medium | 논리적 하자 | edit-manager.ts:534, 486 | `_releaseFocus`/`_unregister`가 해제 컨트롤러를 `controller`로 전달 |
| M4  | Medium | 논리적 하자 | edit-manager.ts:1035-1048 | `_selectBoxForParagraph` 조건부 디스패치 — 이전 상태에 의존 |
| M5  | Medium | 느슨한 제약 | edit-manager.ts:357-360 | `reset()` setter 우회 — 부작용 건너뜀, 유지보수 위험 |
| M6  | Medium | 이벤트 꼬임 | text-edit-controller.ts:716 | `_onBlur` blur 중 `textChange` 발생 — `focusChange`와 인터리브 |
| M7  | Medium | 느슨한 제약 | edit-manager.ts:2342 | `_dispatch` 빈 리스너 체크 불일치 |
| M8  | Medium | 논리적 하자 | edit-manager.ts:572 | `notifyTextChange` 공개 API가 `null`을 `controller`로 전달 |
| L1  | Low | 이벤트 꼬임 | layout-selection-controller.ts:721-729 | 더블클릭 5개 이벤트 폭발 |
| L2  | Low | 논리적 하자 | text-edit-controller.ts:662-664 | 더블클릭 `selectionStart` 의미론적 중복 |

**총계**: Critical 3건, High 6건, Medium 8건, Low 2건 (총 19건)

---

## Critical (3건)

### C1. `_suppressNextClick` 타임아웃 없음 — 다음 무관 클릭을 조용히 삼킴

| 항목 | 내용 |
|------|------|
| **심각도** | Critical |
| **카테고리** | 느슨한 제약 (Loosely constrained logic) |
| **위치** | `src/edit/edit-manager.ts:1712` (설정), `:1741` (설정), `:1824-1830` (소비), `:382` (reset에서만 초기화) |

#### 결함 상세

`_suppressNextClick` 플래그는 `_dispatchInsert` (1712)와 `_dispatchInsertCancel` (1741)에서 `true`로 설정됩니다. 이 플래그는 `_consumeSuppressNextClick()` (1824-1830)이 `_onClick` (`layout-selection-controller.ts:642`)에서 소비하거나, `reset()` (382)에서만 `false`로 초기화됩니다.

`_suppressLayoutClick`은 200ms 타임아웃(`:1794`)을 가지고 있지만, `_suppressNextClick`은 **타임아웃도, 다른 리셋 경로도 없습니다**. 클릭 이벤트가 발생하지 않으면(ESC 취소, 마우스 이동 후 해제, `preventDefault`로 인한 click 미발생 등) 플래그가 다음 클릭까지 무기한 `true`로 남습니다.

#### 재현 시나리오

1. 사용자가 삽입 드래그를 시작한 후 ESC를 누름 → `_dispatchInsertCancel()`이 `_suppressNextClick = true` 설정
2. 클릭 이벤트가 발생하지 않음 (ESC는 click을 발생시키지 않음; `_suppressLayoutClick`이 click을 이미 소비했거나, 사용자가 마우스를 문서 영역 밖으로 이동 후 해제)
3. 사용자가 5초 후 툴바 버튼이나 무관한 박스를 클릭
4. `_onClick` (`layout-selection-controller.ts:642`)이 `_consumeSuppressNextClick()` 호출 → `true` 반환 → **클릭이 조용히 무시됨**

#### 영향

다음 정당한 사용자 액션(박스 선택, 툴바 클릭)이 삼켜집니다. 사용자는 앱이 "죽은" 것처럼 느낍니다 — 피드백 없이 한 번의 클릭이 무시됩니다. 툴바 컨텍스트에서는 버튼의 자체 클릭 핸들러가 발생할 수 있지만(툴바는 `_onClick` 범위 밖), 문서 내부를 클릭하면 선택이 멈춰 있습니다.

#### 수정 제안

200ms 타임아웃을 미러링하거나, `_suppressNextClick`을 `_suppressLayoutClick()`으로 완전히 통합:

```typescript
// _dispatchInsert / _dispatchInsertCancel에서 _suppressNextClick = true 대신:
this._suppressLayoutClick();
```

또는 타임아웃 추가:

```typescript
if (this._suppressNextClickTimer !== null) clearTimeout(this._suppressNextClickTimer);
this._suppressNextClickTimer = setTimeout(() => {
  this._suppressNextClick = false;
}, 200);
```

---

### C2. `_dispatching` 전역 재진입 가드가 리스너의 연쇄 이벤트를 조용히 삼킴

| 항목 | 내용 |
|------|------|
| **심각도** | Critical |
| **카테고리** | 이벤트 꼬임 (Event tangling risk) |
| **위치** | `src/edit/edit-manager.ts:2340` (`_dispatch`), `:263` (`_dispatchModeChange`), `:2243` (`_dispatchLayoutSelection`), `:1708` (`_dispatchInsert`), `:565` (`notifyTextChange`) 외 19개 디스패처 전체 |

#### 결함 상세

하나의 `_dispatching` 불린이 **모든 19개 이벤트 타입을 가드**합니다. 이벤트 X의 리스너가 동기적으로 상태 변경을 통해 이벤트 Y(다른 타입)를 발생시키려 하면, Y의 디스패처 상단 `if (this._dispatching) return;`에 의해 **조용히 무시**됩니다.

#### 재현 시나리오

1. 외부 UI가 `layoutSelectionChange` 리스너를 등록. 이 리스너는 특정 조건에서 `manager.focusParagraph(relatedParagraph)`를 호출하여 관련 단락을 함께 포커스
2. `focusParagraph` → `_requestFocus` → `_selectBoxForParagraph` → `_dispatchLayoutSelection` (2243): `if (this._dispatching) return;` — **포커스를 위한 `layoutSelectionChange`가 무시됨**
3. 이어서 `_dispatch('focusChange', ...)` (2340): `if (this._dispatching) return;` — **`focusChange`도 무시됨**
4. 단락은 포커스되었지만(커서 표시, `focusedController` 설정) `focusChange`나 `layoutSelectionChange` 이벤트가 발생하지 않음 → 외부 UI 상태 분기

#### 영향

리스너가 프로그래밍적으로 EditManager 상태를 구동하는 정당한 패턴(예: `layoutSelectionChange`에 의해 트리거되는 "그룹 내 모든 단락 선택" 액션)에서 2차 이벤트가 조용히 손실됩니다. 내부적으로 상태는 변경되지만 외부 관찰자는 알 수 없습니다. 이는 **오류도, 로그도, 증상도 없이 조용한 상태 분기를 일으키는 가장 교활한 버그 클래스**입니다.

#### 수정 제안

타입별 재진입 가드(`Set<EditManagerEventType>`)로 변경. 동일 타입의 true 재진입은 방지하면서 다른 타입의 연쇄는 허용:

```typescript
private _dispatchingTypes = new Set<EditManagerEventType>();

// 각 디스패처에서:
if (this._dispatchingTypes.has(type)) return;
this._dispatchingTypes.add(type);
try {
  // ... 리스너 호출 ...
} finally {
  this._dispatchingTypes.delete(type);
}
```

---

### C3. `insertMode` setter가 `isDragging`일 때 교차 비활성화를 건너뜀 — 두 모드 동시 활성

| 항목 | 내용 |
|------|------|
| **심각도** | Critical |
| **카테고리** | 논리적 하자 (Logical defect) |
| **위치** | `src/edit/edit-manager.ts:1621-1631` |

#### 결함 상세

`insertMode`가 `this._insertController?.isDragging === true`일 때 non-null 값으로 설정되면, 1625-1631 블록 전체가 건너뛰어집니다:

- `layoutEditMode = false`가 **호출되지 않음**
- `textEditMode = false`가 **호출되지 않음**
- `clearLayoutSelection(false)`가 **호출되지 않음**
- 박스 커서가 `crosshair`로 설정되지 않음 (1638-1642도 `!isDragging`으로 가드됨)

#### 재현 시나리오

1. 사용자가 `layoutEditMode = true` (move 모드) 상태에서 박스를 드래그
2. 드래그 중 외부 코드(또는 키보드 단축키 핸들러)가 `manager.insertMode = 'box'` 호출
3. `isDragging`이 `true` → 교차 비활성화 건너뜀 → `_layoutEditMode === true` AND `_insertMode === 'box'`가 **동시에 활성**
4. 박스 드래그는 여전히 활성(`LayoutEditController`의 드래그 상태), `InsertController`도 모드가 설정됨
5. mouseup 시: 어느 컨트롤러가 처리하는가? `LayoutEditController._onMouseUp`이 `layoutMove` 발생; `InsertController._onMouseUp`이 `insert` + `layoutAdd` 발생 → **둘 다 동일 mouseup에 대해 발생**
6. 사용자는 하나의 마우스 액션에서 박스 이동 AND 새 요소 삽입을 동시에 겪음

#### 영향

불가능 상태 — 두 편집 모드가 동시 활성. 동일 사용자 액션에 대한 이중 이벤트 디스패치. AGENTS.md에 문서화된 불변 조건 "각 모드 setter는 활성화 시 다른 모드를 비활성화"를 위반합니다.

#### 수정 제안

`isDragging` 우회는 커서 변경과 `clearLayoutSelection`(진행 중인 드래그를 방해하므로)만 건너뛰고, 다른 모드 비활성화는 반드시 실행:

```typescript
if (mode) {
  this._modeChangeSuppressed = true;
  this.layoutEditMode = false;
  this.textEditMode = false;
  this._modeChangeSuppressed = false;
  if (!isDragging) {
    this.clearLayoutSelection(false);
    // ... 커서 변경 ...
  }
  // ... 컨트롤러 생성 ...
}
```

---

## High (6건)

### H1. `_unregister`가 `layoutSelectionChange`를 발생시키지 않음 — 단락 파괴 후 고아 선택

| 항목 | 내용 |
|------|------|
| **심각도** | High |
| **카테고리** | 누락된 디스패치 (Missing dispatch) |
| **위치** | `src/edit/edit-manager.ts:479-487` |

#### 결함 상세

포커스된 컨트롤러가 파괴될 때(`_unregister`), `_clearBoxSelectionForParagraph(previousParagraph)` (483)를 호출하지만, 이 메서드는 `text-focused` 속성만 제거합니다(`:1057-1063`). `selected` 속성은 제거하지 않고, `layoutSelectionChange`도 발생시키지 않습니다. 부모 박스가 `_selectedLayouts`에 `selected` 속성과 함께 잔류하지만, 그 선택을 정당화했던 단락은 더 이상 존재하지 않습니다.

#### 재현 시나리오

1. 사용자가 단락을 더블클릭 → 텍스트 편집 모드 진입, 단락 포커스, 부모 박스 선택(`selected` + `text-focused`)
2. 외부 코드가 단락의 박스를 DOM에서 제거(예: 언두/리두, 또는 `disconnectedCallback`을 통해 컨트롤러를 파괴하는 "박스 삭제" 명령)
3. `TextEditController.destroy()` → `_unregister()` (479): `_clearBoxSelectionForParagraph`가 `text-focused`만 제거. `_focusedController = null`. `focusChange` 발생 (486)
4. 부모 박스가 여전히 `selected` 속성을 가지고 `_selectedLayouts`에 잔류. 하지만 단락은 사라짐
5. `layoutSelectionChange` 미발생. 외부 UI는 박스가 정당하게 선택된 것으로 인식하지만, 선택은 고아 상태

#### 영향

고아 선택 상태. 외부 UI가 제거되었어야 할 박스를 선택된 것으로 표시. 박스가 DOM에서 제거된 경우 `_selectedLayouts`가 분리된 요소 참조를 보유 → 메모리 누수 가능성.

#### 수정 제안

```typescript
// _unregister 내부, 포커스된 컨트롤러 파괴 시:
if (this._focusedController === controller) {
  const previousParagraph = controller['_paragraph'] as LayoutParagraphElement;
  const parentBox = previousParagraph?.parentElement;
  this._clearBoxSelectionForParagraph(previousParagraph);
  if (parentBox instanceof LayoutBoxElement && this._selectedLayouts.includes(parentBox)) {
    const previousLayouts = [...this._selectedLayouts];
    parentBox.removeAttribute('selected');
    this._selectedLayouts = this._selectedLayouts.filter(el => el !== parentBox);
    this._dispatchLayoutSelection(previousLayouts);
  }
  this._lastFocusedBox = null;
  this._focusedController = null;
  this._dispatch('focusChange', controller, previousParagraph, controller);
}
```

---

### H2. `_tryReparent`가 `layoutRemove` 이벤트 전에 DOM에서 요소를 제거 — 문서-코드 불일치

| 항목 | 내용 |
|------|------|
| **심각도** | High |
| **카테고리** | 이벤트 꼬임 (Event tangling risk) |
| **위치** | `src/edit/layout-edit-controller.ts:2132` (remove), `:2139` (dispatch) |

#### 결함 상세

`box.remove()`가 2132에서 실행되고, `_dispatchLayoutRemove`가 2139에서 발생합니다. `layoutRemove` 리스너가 실행될 때 `box`는 이미 DOM에서 분리되어 있습니다(`box.parentElement === null`). 이벤트 페이로드의 `element` 필드가 분리된 요소를 가리킵니다.

AGENTS.md는 "`layoutRemove` 이벤트는 요소가 DOM에서 제거되기 **직전**에 발생한다"고 서술하지만, 코드는 제거 후에 발생합니다 — 문서-코드 불일치.

#### 재현 시나리오

1. 사용자가 컨테이너 A에서 컨테이너 B로 박스를 드래그(reparent)
2. `_tryReparent`: `box.remove()` (2132) — 박스 분리
3. `_dispatchLayoutRemove({ element: box, previousContainer, source: 'reparent' })` (2139)
4. 리스너가 `event.element.parentElement` 확인 → `null`. `event.previousContainer.contains(event.element)` → `false`. 제거 애니메이션을 하려는 리스너는 불가능 — 요소가 이미 원본 부모에서 사라짐

#### 영향

제거 전 컨텍스트를 검사해야 하는 리스너(애니메이션, 언두 스냅샷, 로깅)가 잘못된 데이터를 받습니다. `layoutRemove` 중 요소의 원래 DOM 위치를 재구성하려는 언두/리두 시스템이 실패합니다.

#### 수정 제안

`layoutRemove`를 `box.remove()` **이전**에 발생:

```typescript
const previousContainer = box.parentElement;
if (previousContainer) {
  manager._dispatchLayoutRemove({
    element: box,
    previousContainer: previousContainer as HTMLElement,
    source: 'reparent',
  });
}
box.remove();
const newBox = newContainer.appendChildData(boxData) as LayoutBoxElement;
manager._dispatchLayoutAdd({
  element: newBox,
  container: newContainer as HTMLElement,
  source: 'reparent',
});
```

---

### H3. `_cloneBoxForAltDrag`가 `layoutAdd`를 발생시키지 않음

| 항목 | 내용 |
|------|------|
| **심각도** | High |
| **카테고리** | 누락된 디스패치 (Missing dispatch) |
| **위치** | `src/edit/layout-edit-controller.ts:537` |

#### 결함 상세

Alt+드래그로 박스를 복제합니다. `parent.appendChildData(newData)` (537)가 복제본을 생성하고 DOM에 완전히 초기화합니다. 하지만 `_dispatchLayoutAdd`가 복제된 박스에 대해 **한 번도 호출되지 않습니다**. 발생하는 유일한 이벤트는 `layoutSelectionChange`(`selectLayout` via 548)와 후속 드래그의 `layoutMove`뿐입니다.

#### 재현 시나리오

1. 사용자가 Alt를 누르고 선택된 박스를 드래그 → `_cloneBoxForAltDrag`가 `appendChildData` (537)로 복제본 생성
2. 복제본이 DOM에 존재. `layoutAdd` 이벤트 없음
3. 사용자가 마우스 해제 → 복제본에 대해 `layoutMove` 발생
4. 외부 UI(레이어 패널, 언두 스택)가 `layoutAdd`로 복제본을 인식하지 못함 → `layoutMove`에서만 참조된 요소를 발견

#### 영향

`layoutAdd`에 의존하여 새 요소를 학습하는 언두/리두 시스템, 레이어 패널, 외부 상태 추적이 Alt-드래그 복제본을 완전히 놓침. 복제본은 DOM에 존재하지만 외부 모델에는 없음.

#### 수정 제안

```typescript
const created = parent.appendChildData(newData);
if (created instanceof LayoutBoxElement) {
  clonedTargets.push(created);
  manager._dispatchLayoutAdd({
    element: created,
    container: parent,
    source: 'insert',
  });
}
```

---

### H4. `_onCompositionCancel`이 `textChange`/`cursorMove`를 발생시키지 않음 — 상태 분기

| 항목 | 내용 |
|------|------|
| **심각도** | High |
| **카테고리** | 누락된 디스패치 (Missing dispatch) |
| **위치** | `src/edit/text-edit-controller.ts:1636-1654` |

#### 결함 상세

IME 조합이 취소될 때(예: 한국어 IME 조합 중 ESC, 또는 조합 중 포커스 탈취), `_onCompositionCancel`이 `model.textContent`를 `this._compositionBeforeContent`로 복원(1642), 커서 오프셋 리셋(1644), 재렌더(1651), 커서 위치 업데이트(1652)합니다. 하지만 `_manager._notifyTextChange(this)`나 `_manager._notifyCursorMove(this)`를 **호출하지 않습니다**.

#### 재현 시나리오

1. 사용자가 한국어 입력: "안녕" — 조합 중 `model.textContent`가 진행 중인 조합으로 업데이트됨
2. 사용자가 ESC → `_onCompositionCancel`이 `model.textContent`를 조합 전 문자열로 복원
3. DOM이 복원된 텍스트로 재렌더. 하지만 `textChange` 이벤트 미발생
4. 외부 UI(글자 수 표시, 자동저장, 협업 동기화)가 여전히 진행 중인 조합 텍스트를 표시. 다음 정당한 텍스트 편집까지 상태 분기 지속

#### 영향

외부 상태 추적(글자 수, 자동저장, 협업 동기화)이 실제 렌더링된 텍스트에서 분기. 분기는 다음 텍스트 편집이 `textChange`를 트리거할 때까지 지속.

#### 수정 제안

```typescript
this._paragraph.render();
this._updateCursorPosition();
this._manager._notifyTextChange(this);
this._manager._notifyCursorMove(this);
```

---

### H5. `cursorMove`가 비반복 키에서 이중 발생 (KeyDown + KeyUp)

| 항목 | 내용 |
|------|------|
| **심각도** | High |
| **카테고리** | 이중 발생 (Double-fire) |
| **위치** | `src/edit/text-edit-controller.ts:820-821` (KeyDown), `:1051-1052` (KeyUp) |

#### 결함 상세

단일 ArrowLeft/Right/Up/Down/Home/End 탭에 대해:
- KeyDown이 `_notifyCursorMove(this)`를 821에서 발생(`!event.repeat && isCursorKey` 가드 — 새 탭에 대해 true)
- KeyUp이 `_notifyCursorMove(this)`를 1052에서 발생(`cursorKeys.includes(event.key)` 가드만 — `!event.repeat` 체크 없음, KeyUp은 반복되지 않음)

#### 재현 시나리오

1. 사용자가 ArrowLeft를 한 번 탭(누름 + 해제)
2. KeyDown: `!event.repeat` = true, `isCursorKey` = true → `_notifyCursorMove` 발생 (821)
3. KeyUp: `cursorKeys.includes("ArrowLeft")` = true → `_notifyCursorMove` 재발생 (1052)
4. 하나의 키 입력에 대해 동일 오프셋으로 2개의 `cursorMove` 이벤트

#### 영향

`cursorMove`에 반응하는 외부 UI(커서 위치 표시, 자동저장, 협업 커서 동기화)가 이중 작업 수행. 협업 편집에서 중복 커서 동기화 메시지 발생. 데이터 손상은 아니지만 빠른 키 입력 시 누적되는 노이즈/성능 이슈.

#### 수정 제안

KeyUp 디스패치(1051-1053) 제거 — KeyDown이 이미 처리. 또는 KeyUp에서 오프셋이 실제로 변경된 경우에만 발생(마지막 디스패치된 오프셋 추적 필요).

---

### H6. `_onContextMenu`가 `layoutSelectionChange`를 2회 연속 발생

| 항목 | 내용 |
|------|------|
| **심각도** | High |
| **카테고리** | 이중 발생 (Double-fire) |
| **위치** | `src/edit/layout-selection-controller.ts:757-758` |

#### 결함 상세

미선택 박스 우클릭 시 `clearLayoutSelection(false)` (757, `layoutSelectionChange` 발생 — 빈 선택) 후 `selectLayout(box)` (758, `layoutSelectionChange` 발생 — 새 선택). 두 이벤트가 백투백으로 발생.

#### 재현 시나리오

1. 박스 A가 선택됨. 사용자가 박스 B(미선택)를 우클릭
2. `clearLayoutSelection(false)` → `layoutSelectionChange` (`selectedLayouts: [], previousLayouts: [A]`)
3. `selectLayout(B)` → `layoutSelectionChange` (`selectedLayouts: [B], previousLayouts: []`)
4. 외부 UI가 선택 깜빡임(A → 빈 → B)을 봄. 언두 시스템이 하나의 액션에 2개 엔트리 생성

#### 영향

선택 변경을 애니메이션하는 외부 UI가 깜빡임을 봄. `layoutSelectionChange`에 스냅샷하는 언두 시스템이 하나의 사용자 액션에 2개 언두 엔트리 생성. 성능 민감 리스너가 이중 작업 수행.

#### 수정 제안

배치된 선택 업데이트 사용 — 하나의 작업으로 clear + select, 한 번만 디스패치:

```typescript
if (!isSelected) {
  const previousLayouts = [...manager.selectedLayouts];
  for (const el of previousLayouts) {
    el.removeAttribute('selected');
    el.removeAttribute('text-focused');
  }
  manager._selectedLayouts = [box];
  box.setAttribute('selected', '');
  manager._dispatchLayoutSelection(previousLayouts);
}
```

또는 `selectLayoutExclusive(box)` 메서드 추가 — clear+select를 원자적으로 수행.

---

## Medium (8건)

### M1. `_selectAll` (Ctrl+A)이 `selectionStart`/`selectionEnd` 미발생

| 항목 | 내용 |
|------|------|
| **심각도** | Medium |
| **카테고리** | 누락된 디스패치 |
| **위치** | `src/edit/text-edit-controller.ts:744-748` |

#### 결함 상세

Ctrl+A가 `_selectAll()` (746)을 호출하여 선택을 전체 범위로 설정하지만 선택 이벤트를 발생시키지 않습니다. 그 후 `_notifyCursorMove(this)`만 발생(747). 선택은 내부적으로 `[0, length]`이지만 외부 UI는 커서 이동만 학습하고 선택을 학습하지 못함.

#### 재현 시나리오

1. 사용자가 Ctrl+A
2. `_selectAll()`이 `selection = [0, content.length]`, `offset = content.length` 설정
3. `_notifyCursorMove` 발생 — 외부 UI가 커서 위치 표시 갱신
4. `selectionStart`/`selectionEnd` 미발생 — "X자 선택됨" 표시가 없음

#### 영향

선택 의존 UI(글자 수, 복사 버튼 활성화, 외부 패널 선택 하이라이트)가 Ctrl+A에 대해 업데이트되지 않음. 다음 선택 이벤트까지 분기.

#### 수정 제안

```typescript
// _selectAll 내부 또는 Ctrl+A 핸들러에서:
this._manager._notifySelectionStart(this);
this._manager._notifySelectionEnd(this);
```

---

### M2. `_clearSelection` (ESC)이 `selectionEnd` 미발생

| 항목 | 내용 |
|------|------|
| **심각도** | Medium |
| **카테고리** | 누락된 디스패치 |
| **위치** | `src/edit/text-edit-controller.ts:762-763` |

#### 결함 상세

선택이 존재할 때 ESC를 누르면 `_clearSelection()` (763)이 `selection = null`로 설정하지만 이벤트를 발생시키지 않습니다. 선택은 내부적으로 제거되지만 외부 UI는 통지받지 못합니다.

#### 재현 시나리오

1. 사용자가 텍스트 선택(예: 단어 더블클릭)
2. ESC → `_clearSelection()`이 `selection = null`
3. `selectionEnd` 미발생. 외부 UI가 여전히 선택이 활성으로 표시
4. 시각적 선택 하이라이트는 제거되지만 외부 상태 추적은 여전히 선택이 존재한다고 인식

#### 영향

선택 의존 외부 UI(툴바 버튼, 글자 수, 협업 선택 동기화)가 ESC로 선택이 제거되어도 업데이트되지 않음. 다음 선택 이벤트까지 분기.

#### 수정 제안

```typescript
_clearSelection(): void {
  const hadSelection = this._cursorModel.selection !== null;
  this._cursorModel.selection = null;
  this._selectionEl.setRanges([]);
  this._textarea.setSelectionRange(this._cursorModel.offset, this._cursorModel.offset);
  this._updateCursorPosition();
  if (hadSelection) {
    this._manager._notifySelectionEnd(this);
  }
}
```

---

### M3. `_releaseFocus`/`_unregister`가 해제 중인 컨트롤러를 `controller`로 전달 — 오인 가능한 페이로드

| 항목 | 내용 |
|------|------|
| **심각도** | Medium |
| **카테고리** | 논리적 하자 |
| **위치** | `src/edit/edit-manager.ts:534` (`_releaseFocus`), `:486` (`_unregister`) |

#### 결함 상세

두 메서드 모두 `controller`를 **해제 중인 컨트롤러**(null이 아님)로 설정하여 `focusChange`를 발생시킵니다. 이벤트 페이로드의 `controller` 필드는 `TextEditController` 타입(인터페이스에서 non-nullable). `event.controller`를 확인하여 포커스 획득/해제를 판단하는 외부 리스너는 두 경우 모두 non-null 컨트롤러를 봅니다.

#### 재현 시나리오

1. 단락 A가 포커스됨. 사용자가 빈 공간 클릭 → `blurParagraph()` → `_releaseFocus(controllerA)`
2. `focusChange` 발생: `controller: controllerA`, `previousController: controllerA`
3. 외부 리스너가 `event.controller` 확인 → `controllerA` (non-null). 리스너는 포커스가 획득된 것으로 오인
4. `manager.focusedController === null`을 확인해야만 해제됨을 인식 — 문서화되지 않은 주의점

#### 영향

`event.controller`를 사용하여 포커스 변경에 반응하는 리스너(포커스된 단락 하이라이트, 편집 툴바 활성화)가 blur를 focus로 잘못 처리. 리스너는 이벤트 페이로드가 아닌 `manager.focusedController`를 확인해야 함 — 문서화되지 않은 주의점.

#### 수정 제안

해제/unregister 시 `null`을 `controller`로 전달:

```typescript
// _releaseFocus:
this._dispatch('focusChange', null as unknown as TextEditController, previousParagraph, controller);
// _unregister:
this._dispatch('focusChange', null as unknown as TextEditController, previousParagraph, controller);
```

또는 `EditManagerEvent.controller` 타입을 `TextEditController | null`로 변경하고 `null` 전달.

---

### M4. `_selectBoxForParagraph` 조건부 디스패치 — 이벤트 발생 여부가 이전 상태에 의존

| 항목 | 내용 |
|------|------|
| **심각도** | Medium |
| **카테고리** | 논리적 하자 |
| **위치** | `src/edit/edit-manager.ts:1035-1048` |

#### 결함 상세

부모 박스가 이미 유일한 선택 레이아웃인 경우(`_selectedLayouts.length === 1 && _selectedLayouts[0] === parentBox`), `text-focused` 속성을 추가하고 `layoutSelectionChange`를 발생시키지 않고 반환(1035-1038). 그렇지 않으면 디스패치. 동일한 논리 액션(단락 포커스)이 이전 선택 상태에 따라 `layoutSelectionChange` 이벤트를 발생시키거나 발생시키지 않을 수 있음.

#### 재현 시나리오

1. 박스 A가 선택됨(레이아웃 클릭). 사용자가 박스 A 내 단락을 더블클릭
2. `_selectBoxForParagraph`: `_selectedLayouts.length === 1 && _selectedLayouts[0] === A` → true → `text-focused` 추가, 반환. `layoutSelectionChange` 없음
3. 텍스트 포커스 상태를 `layoutSelectionChange`로 추적하는 외부 UI가 업데이트되지 않음
4. 비교: 박스 B가 선택되어 있던 경우, `_selectBoxForParagraph`가 `layoutSelectionChange` 발생. 외부 UI 업데이트됨

#### 영향

텍스트 포커스 상태를 `layoutSelectionChange`로 추적하는 외부 UI가 박스가 이미 선택된 경우 전환을 놓침. `text-focused` 속성은 DOM에 설정되지만 외부 상태 추적은 학습하지 못함.

#### 수정 제안

항상 디스패치하거나, 별도의 `textFocusChange` 이벤트 추가. 중복 디스패치가 우려되면 리스너가 중복 제거 — 하지만 이벤트는 일관성을 위해 항상 발생해야 함.

---

### M5. `reset()`이 setter를 우회 — 부작용 건너뜀, 유지보수 위험

| 항목 | 내용 |
|------|------|
| **심각도** | Medium |
| **카테고리** | 느슨한 제약 |
| **위치** | `src/edit/edit-manager.ts:357-360` |

#### 결함 상세

`reset()`이 `_textEditMode = false` (357), `_layoutEditMode = false` (358), `_insertMode = null` (360)을 직접 필드 할당으로 설정하여 setter를 우회합니다. setter의 부작용(`_applyEditableTextToAllParagraphs`, `_applyEditableLayoutToAllBoxes`, `_updateControllers`, 커서 리셋)이 **호출되지 않습니다**. 대신 `reset()`이 389-398에서 박스/단락을 수동 순회하여 `editableLayout = false` / `editableText = false` 설정 — 부분적 동등. 하지만 `_updateControllers()`(`layoutEditMode` setter가 1170에서 호출)는 호출되지 않음.

#### 재현 시나리오

1. 문서가 레이아웃 편집 모드, `_layoutEditController` 활성
2. `reset()` 호출(React unmount)
3. `_layoutEditMode = false` (358) — 직접 할당
4. `_layoutEditController.destroy()` (375) — 컨트롤러 파괴
5. 하지만 `_updateControllers()`가 호출되지 않음 — `_updateControllers`가 정리했을 컨트롤러 내부 상태가 잔류
6. 수동 순회(389-393)가 박스의 `editableLayout = false` 설정 — 박스 측 정리. 하지만 EditManager 측 컨트롤러 상태(`_dragTargets`, `_dragStartPositions`)는 354-355에서 별도 정리. 현재는 작동하지만 취약 — 향후 `layoutEditMode` setter에 새 부작용이 추가되면 `reset()`이 조용히 건너뜀

#### 영향

현재는 `reset()`이 관련 상태를 수동 정리하므로 작동. 하지만 유지보수 위험 — 모드 setter에 새 부작용이 추가되면 `reset()`이 조용히 건너뛰어 상태 누수 발생.

#### 수정 제안

setter를 호출(`_modeChangeSuppressed = true`로 중간 이벤트 억제)하거나, `reset()`이 setter에 새 부작용이 추가될 때마다 업데이트되어야 함을 명확히 문서화:

```typescript
this._modeChangeSuppressed = true;
try {
  this.textEditMode = false;
  this.layoutEditMode = false;
  this.insertMode = null;
} finally {
  this._modeChangeSuppressed = false;
}
```

---

### M6. `_onBlur`가 blur 중 `textChange` 발생 — 새 포커스의 `focusChange`와 인터리브

| 항목 | 내용 |
|------|------|
| **심각도** | Medium |
| **카테고리** | 이벤트 꼬임 |
| **위치** | `src/edit/text-edit-controller.ts:716` |

#### 결함 상세

IME 조합 중 단락이 포커스를 잃을 때 `_onBlur`가 `_manager._notifyTextChange(this)` (716)를 호출합니다. 이는 **포커스를 잃는 단락**에 대한 `textChange`를 발생시킵니다. blur가 다른 단락이 포커스를 얻는 것에 의해 발생한 경우(예: 사용자가 단락 A에서 조합 중 단락 B 클릭), 시퀀스는:
1. 단락 A의 `_onBlur` → `_notifyTextChange(A)` → A에 대한 `textChange`
2. 단락 A의 `_blurInternal` → `_releaseFocus(A)` → A에 대한 `focusChange` (해제)
3. 단락 B의 `_onFocus` → `_requestFocus(B)` → `layoutSelectionChange` + B에 대한 `focusChange`

A에 대한 `textChange`가 A의 해제 `focusChange` **이전**에 발생합니다.

#### 재현 시나리오

1. 사용자가 단락 A에서 한국어 조합 중(IME 활성)
2. 단락 B 클릭
3. 단락 A의 `_onBlur` 발생: A에 대한 `textChange`(조합된 텍스트), then `_blurInternal` → `focusChange` (A 해제)
4. 단락 B의 `_onFocus` 발생: `layoutSelectionChange` + `focusChange` (B 획득)

#### 영향

A에 대한 `textChange`가 A가 여전히 `focusedController`인 동안 발생(해제 전). `textChange`를 처리하고 `focusedController`를 읽는 외부 UI가 A를 올바르게 연결하지만, 순서가 취약 — `textChange` 리스너가 포커스 이동을 유발하는 재렌더를 트리거하면 인터리브가 예측 불가능해짐.

#### 수정 제안

`_notifyTextChange` 호출을 `_blurInternal` / `_releaseFocus` 완료 **이후**로 이동. 또는 `textChange`가 blur 중 발생할 수 있음을 문서화하고 리스너는 `textChange` 중 `focusedController` 상태에 의존하지 않도록 권고.

---

### M7. `_dispatch` 빈 리스너 체크 불일치

| 항목 | 내용 |
|------|------|
| **심각도** | Medium |
| **카테고리** | 느슨한 제약 |
| **위치** | `src/edit/edit-manager.ts:2342` |

#### 결함 상세

`_dispatch`(private 텍스트 이벤트 디스패처)는 `if (!listeners) return;` (2342)만 체크하고 `listeners.size === 0`은 체크하지 않습니다. 다른 디스패처(`_dispatchModeChange` 266, `_dispatchLayoutSelection` 2245, `_dispatchInsert` 1710, `notifyTextChange` 567)는 모두 `!listeners || listeners.size === 0` 체크. 빈 Set은 `!listeners` 체크를 통과하지만 for-of 루프는 실행되지 않음 — 기능적으로 동등하지만 불일치.

#### 영향

기능적 버그는 아님 — 빈 Set의 for-of 루프는 실행되지 않음. 하지만 불일치意味着 `_dispatch`가 빈 리스너 세트에 대해 `_dispatching = true`로 설정하고 즉시 `false`로 복원하는 반면, 다른 디스패처는 `_dispatching`을 건드리기 전에 short-circuit. 향후 변경이 리스너 체크와 `_dispatching` 설정 사이에 로직을 추가하면, `_dispatch`가 리스너가 없어도 해당 로직을 실행.

#### 수정 제안

```typescript
if (!listeners || listeners.size === 0) return;
```

---

### M8. `notifyTextChange` 공개 API가 `null`을 `controller`로 전달 — 타입 안전성 구멍

| 항목 | 내용 |
|------|------|
| **심각도** | Medium |
| **카테고리** | 논리적 하자 |
| **위치** | `src/edit/edit-manager.ts:572` |

#### 결함 상세

`notifyTextChange`(공개 API 경로, PlaceGun 주입 및 AI fit에서 사용)가 `controller: null as unknown as TextEditController` (572)로 설정. `EditManagerEvent.controller` 타입은 `TextEditController` (non-nullable). 외부 리스너가 `event.controller.someProperty`에 접근하면 null 접근으로 TypeError.

#### 재현 시나리오

1. PlaceGun이 단락에 콘텐츠 주입 → `manager.notifyTextChange(paragraph)` 호출
2. `textChange` 발생: `controller: null` (`TextEditController`로 캐스트)
3. 리스너가 `event.controller.model` 접근 → TypeError: Cannot read property 'model' of null

#### 영향

`textChange` 리스너가 null 체크 없이 `event.controller`에 접근하면 공개 API 경로(PlaceGun, AI fit) vs 내부 경로(TextEditController, 실제 컨트롤러 전달)에서 crash.

#### 수정 제안

`EditManagerEvent.controller` 타입을 `TextEditController | null`로 변경하고 `null`을 `as unknown as` 캐스트 없이 전달. 리스너는 null 체크 필수.

---

## Low (2건)

### L1. 더블클릭이 5개 이벤트 폭발

| 항목 | 내용 |
|------|------|
| **심각도** | Low |
| **카테고리** | 이벤트 꼬임 |
| **위치** | `src/edit/layout-selection-controller.ts:721-729` |

#### 결함 상세

단락 더블클릭 시: `modeChange` (721) → `layoutSelectionChange` (722, via `focusParagraph` → `_selectBoxForParagraph`) → `focusChange` (722, via `focusParagraph` → `_requestFocus`) → `cursorMove` (728, via `setCursor`) → `styleChange` (728, via `setCursor` → `_emitStyleChange`). 하나의 사용자 액션에 5개 이벤트.

#### 영향

버그는 아님 — 각 이벤트는 실제 상태 변경을 나타냄. 하지만 각 이벤트에 독립적으로 반응하는 외부 UI가 하나의 더블클릭에 5배 작업 수행. 리스너가 재렌더를 트리거하면 느린 장치에서 성능 이슈.

#### 수정 제안

이벤트가 모두 의미론적으로 올바른 경우 수정 불필요. 성능 이슈 시 배치 고려. 외부 UI 구현자를 위해 예상 시퀀스 문서화.

---

### L2. 더블클릭 단어 선택 시 `selectionStart` 의미론적 중복

| 항목 | 내용 |
|------|------|
| **심각도** | Low |
| **카테고리** | 논리적 하자 |
| **위치** | `src/edit/text-edit-controller.ts:662-664` |

#### 결함 상세

단어 선택을 위한 더블클릭이 `selectionStart`, `selectionEnd`, `cursorMove`를 발생(662-664). `selectionStart`는 의미론적으로 선택의 드래그 시작을 위한 것. 더블클릭은 드래그가 아님 — 이산 액션. 더블클릭에 `selectionStart`를 발생시키는 것은 의미론적으로 오해의 소지.

#### 영향

드래그 선택과 더블클릭 선택을 구별하는 외부 UI(각각에 다른 UI 표시)가 `selectionStart`만으로는 신뢰할 수 없음. 사소한 의미론적 이슈, 데이터 손상 없음.

#### 수정 제안

이산 선택 액션(더블클릭, Ctrl+A)을 위한 별도 `selectionSet` 이벤트 고려, 또는 `selectionStart`가 입력 방법과 무관하게 모든 선택 생성에 대해 발생함을 문서화.

---

## 수정 우선순위 권장

```
C1 → C3 → C2 → H2 → H1 → H3 → H4 → H5/H6 → M-series
```

### 우선순위 근거

- **C1, C3**: 실사용자 테스트에서 가장 발현 가능성이 높음(클릭 무시, 불가능 모드 상태). 즉시 수정 권장.
- **C2**: 가장 교활함(조용한 이벤트 손실). 리스너가 연쇄 이벤트를 트리거하는 패턴이 덜 흔하지만, 발생 시 외부 상태가 조용히 분기되어 원인 추적이 매우 어려움. 아키텍처 수준의 수정 필요.
- **H2**: 언두/리두 시스템이 의존하는 이벤트 순서 계약 위반. 데이터 무결성에 영향.
- **H1, H3**: 외부 상태 추적이 요소를 놓침(고아 선택, 복제본 미인식).
- **H4**: 한국어 IME 사용자에게 직접 영향(IME 취소 시 상태 분기).
- **H5, H6**: 노이즈/성능 이슈. 기능 손상은 아니지만 사용자 경험 저하.
- **M-series**: 타입 안전성, 문서 일관성, 유지보수 위험. 즉시 수정 불필요하지만 향후 리팩토링 시 일괄 처리 권장.

---

## 부록: 감사 방법론

### 1단계: 코드 매핑 (Explore 에이전트 × 2, 병렬)

- **에이전트 A** (`bg_a973483b`): `src/edit/edit-manager.ts` 전체(2647라인)를 읽고 모든 디스패치 메서드, 플래그 수명주기, setter, 공개 API를 라인 번호와 함께 verbatim 추출
- **에이전트 B** (`bg_c1a5fbb9`): 7개 컨트롤러/요소 파일의 모든 이벤트 트리거 호출 지점을 라인 번호와 함께 verbatim 추출, 파일별 위험 노트 작성

### 2단계: 심층 분석 (Oracle 에이전트)

- 두 explore 에이전트의 출력을 Oracle에 전달
- Oracle이 17개 교차 점검 항목에 대해 소스 대조 검증 수행:
  - 모든 디스패치 메서드의 `_dispatching` 가드 사용
  - 모든 플래그 수명주기의 stale-state 시나리오
  - 모든 다중 이벤트 시퀀스의 순서 정확성
  - 모든 누락된 디스패치 식별
  - 모든 이중 발생 시나리오 식별
  - 모드 setter 교차 비활성화 논리의 정확성/완전성
  - `_suppressNextClick` vs `_suppressLayoutClick` 상호작용 엣지 케이스
  - 포커스/선택/blur 순서 일관성
  - reparent 이벤트 시퀀싱
  - `_dispatching` 재진입 가드의 합법적 연쇄 이벤트에 대한 영향

### 검증 체크리스트

- [x] 모든 디스패치 메서드의 `_dispatching` 가드 확인
- [x] 모든 플래그 lifecycle의 stale-state 시나리오 확인
- [x] 모든 다중 이벤트 시퀀스의 순서 정확성 확인
- [x] 모든 누락된 디스패치 식별
- [x] 모든 이중 발생 시나리오 식별
- [x] 모드 setter 교차 비활성화 논리 검증
- [x] 클릭 억제 메커니즘 상호작용 엣지 케이스 확인
- [x] 포커스/선택/blur 순서 일관성 확인
- [x] reparent 이벤트 시퀀싱 확인
- [x] 재진입 가드의 연쇄 이벤트 영향 확인