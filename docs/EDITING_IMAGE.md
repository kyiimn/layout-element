# 이미지 편집 모드 (Image Edit Mode)

> 작성 기준: `src/edit/image-edit-controller.ts`, `src/edit/edit-manager.ts` (Image Edit Mode 섹션), `src/edit/layout-selection-controller.ts` (`_onDblClick`)

이미지 편집 모드는 레이아웃 편집/텍스트 편집과 **상호 배타적인 독립 편집 모드**다.
활성화되면 이미지를 마우스로 직접 조작할 수 있다:

- **드래그**: 이미지 표시 위치(x/y, mm) 이동
- **휠**: 이미지 크기(width/height) 조절
- **objectFit 자동 전환**: 사용자가 직접 수정을 시작하는 순간 `cover`/`contain`/`fill`에서 사용자정의(`none`)로 전환. 전환 직전 `displayRect`(자동 계산값)를 x/y/width/height에 고정하므로 화면이 점프하지 않는다.

## 1. 왜 독립 모드인가

레이아웃 편집 모드의 하위 모드로 넣으면 box 드래그/리사이즈 핸들러와 이미지 드래그가 같은 mousedown 이벤트를 두고 경쟁한다. box의 mousedown 핸들러(`LayoutEditController`)가 먼저 이벤트를 소비하므로 box 안의 이미지를 독립적으로 조작할 수 없다. 따라서 이미지 편집 모드가 활성화되면 레이아웃 편집 모드는 **비활성화**되고, 이미지 편집 컨트롤러(`ImageEditController`)가 문서 레벨 mousedown/wheel 이벤트를 독점한다.

```
textEditMode │ layoutEditMode │ imageEditMode │ insertMode   (동시에 하나만 활성)
```

## 2. 진입/종료 흐름

일반(읽기) 모드와 레이아웃 편집 모드 **모두**에서 이미지 더블클릭으로 진입한다.
레이아웃 편집 모드에서 진입했으면 ESC 종료 시 레이아웃 편집 모드로 복귀한다.

```
이미지 더블클릭 (일반 모드 또는 레이아웃 편집 모드)
    │
    ▼
LayoutSelectionController._onDblClick
    ├── 이미지 경로 → manager.focusImage(image, { fromLayoutEditMode: layoutEditMode })
    └── (기존) paragraph 경로 → textEditMode 진입
    │
    ▼
EditManager.focusImage()
    ├── lock/편집 루트 검사
    ├── 다른 모드(text/layout/insert) 비활성화
    ├── _imageEditMode = true
    ├── image-edit-focus 속성 설정 (시각 피드백: 파란 outline + move 커서)
    ├── ImageEditController.attach() (mousedown/wheel capture 리스너 등록)
    └── modeChange 이벤트 (imageEditMode: true)
    │
    ▼
이미지 조작 (드래그/휠)
    │
    ▼
ESC
    ├── 드래그 중이면: 드래그 취소 + 시작 위치로 복원 (imageMove canceled=true)
    └── 드래그 중이 아니면: _exitImageEditModeWithRestore()
        ├── 진입 시 레이아웃 편집 모드였으면 → layoutEditMode = true (복귀)
        └── 아니면 모든 모드 종료
```

프로그래밍 방식 진입/종료:

```ts
const manager = layoutDocEl.editManager;

// 진입 (레이아웃 편집 모드에서 호출했다면 ESC 시 레이아웃 편집으로 복귀)
manager.focusImage(imageElement, { fromLayoutEditMode: true });
manager.focusImage('image-id');           // ID로도 가능

// 포커스만 해제 (모드 유지 — 다른 이미지를 클릭해 계속 편집)
manager.blurImage();

// 모드 완전 종료
manager.imageEditMode = false;
```

## 3. 드래그 (위치 이동)

`mousedown`(좌클릭) → `mousemove` 시 이미지 x/y를 갱신한다.

- **rAF 스로틀링**: `requestAnimationFrame`으로 각 프레임당 1회 갱신 (60fps).
- **3px 임계값**: 임계값 미만 이동은 클릭으로 간주해 드래그를 시작하지 않는다 (`LayoutEditController`와 동일 기준).
- **임계값 통과 시 objectFit 자동 전환**: `_ensureObjectFitNone()`이 전환 직전 displayRect를 x/y/width/height에 고정한 뒤 `none`으로 전환한다.
- **이동 범위 제한 없음 (InDesign 시맨틱)**: 박스는 크롭 윈도우일 뿐 이미지
  이동을 제한하지 않는다. 이미지를 박스 밖으로 완전히 밀어낼 수도 있다.
  밖으로 나간 부분은 렌더링에서 캔버스가 contentAbsRect로 클리핑하고,
  오버랩 판정도 `displayRect ∩ contentAbsRect`만 사용하므로(`computeOverlap`
  클램핑) 데이터 정합성은 이동 범위와 무관하게 유지된다.
- **mm 변환**: `EditManager.screenDeltaToMm()`으로 픽셀 델타를 mm로 환산 (`transform: scale` 보정 포함).
- **종료**: `mouseup` 시 `imageMove` 커밋 이벤트. `_suppressLayoutClick()`으로 후속 click이 레이아웃 선택을 건드리지 않게 차단.
- **ESC 취소**: 시작 위치/objectFit으로 복원 후 `imageMove(canceled: true)` 이벤트.

드래그 중 오버랩 단락 재렌더링은 부모 박스의 `startDragTracking()`/`flushDragRerender()` 배치 경로를 따른다 (box 드래그와 동일한 성능 특성).

## 4. 휠 (크기 조절)

포커스된 이미지 위에서 `wheel` 이벤트로 크기를 조절한다.

| 조작 | 동작 |
|------|------|
| 휠 위로 (`deltaY < 0`) | 1.1배 확대 |
| 휠 아래로 (`deltaY > 0`) | 1/1.1배 축소 |
| Shift + 휠 | 현재 비율 유지 확대/축소 |
| 기본 | 원본 비율(`originalWidth/originalHeight`) 유지. 미설정 시 현재 비율 사용 |

- **objectFit 자동 전환**: 휠 조작 시작 시점에도 `_ensureObjectFitNone()`이 적용된다.
- **크기 상한 없음 (InDesign 시맨틱)**, **하한 1mm** (0/음수로 수렴해 되돌릴 수
  없게 되는 것만 방지).
- **이벤트**: `width`/`height` 각각 `imagePropertyChange`, 완료 시 `imageResize` 커밋 이벤트.

## 5. EditManager API

| API | 설명 |
|---|---|
| `imageEditMode: boolean` (getter/setter) | 모드 활성 여부. `false` 설정 시 포커스/컨트롤러 해제 + modeChange |
| `focusedImage: LayoutImageElement \| null` (getter) | 현재 포커스된 이미지 |
| `focusImage(target, { fromLayoutEditMode? }): boolean` | 모드 진입 + 포커스. lock/편집 루트 위반이면 `false` |
| `blurImage(target?): boolean` | 포커스만 해제 (모드 유지) |
| `isImageEditable(image): boolean` | lock/편집 루트 검사 (모드 활성 상태에서만 `true`) |

`focusImage`는 모드 진입 자체를 수행하므로 `isImageEditable()`과 달리 모드 활성 여부를 검사하지 않는다 — `textEditMode = true` → `focusParagraph()` 순서와 동일한 패턴이다.

## 6. 이벤트

| 이벤트 | 페이로드 (`imageDetail`/`imagePropertyDetail`) | 발생 시점 |
|---|---|---|
| `imageMove` | `image`, `previousX/Y`, `x/y`, `canceled` | 드래그 mouseup 완료 / ESC 취소 |
| `imageResize` | `image`, `previousWidth/Height`, `width/height` | 휠 조절 적용 후 |
| `imagePropertyChange` | `image`, `property`(`x`/`y`/`width`/`height`/`objectFit`), `oldValue`, `newValue`, `source`(`drag`/`wheel`) | 개별 속성 변경 시 |
| `modeChange` | `EditModeState.imageEditMode` 추가 | 모드 전환 시 |

`EditModeState`에 `imageEditMode: boolean` 필드가 추가되었다. 기존 세 모드와 마찬가지로 하나만 활성화되며, 다른 모드 진입 시 자동으로 해제된다.

```ts
manager.addEventListener('imageMove', (e) => {
  const { image, previousX, x, canceled } = e.imageDetail!;
  pushUndoStack({ type: 'image-move', image, from: previousX, to: x, canceled });
});
```

## 7. 시각 피드백

이미지 편집 포커스의 시각 표현은 텍스트 편집 포커스와 동일한 패턴을 따른다 —
**부모 box에 빨간 테두리(`selected`) + 타입 라벨 숨김(`text-focused`)**.

`EditManager.focusImage()`가 `_selectBoxForImage()`로 부모 box를 선택한다:

- `selected` 속성 → `outline: red solid 1px` (기본 선택 테두리)
- `text-focused` 속성 → `.type-label { display: none }` (라벨 숨김)

이미지 요소 자체는 `image-edit-focus` 속성으로 **커서만** `move`로 변경한다
(별도 테두리 없음). `blurImage()`/모드 종료 시 부모 box의 `text-focused`만
제거되고 레이아웃 선택(`selected`)은 유지된다 — 텍스트 포커스 해제와 동일한 동작.

## 7A. 포커스 상실 규칙 — selection 이동

레이아웃 선택이 포커스된 이미지의 부모 box 외부로 이동하면 이미지 편집 포커스는
자동으로 해제된다 (`_releaseImageFocusIfBoxDeselected`).

- `selectLayout`/`selectLayoutExclusive`/`clearLayoutSelection(false)` 호출 시
  새 선택이 부모 box를 포함하지 않으면 `blurImage()`가 자동 호출된다.
- 이미지 편집 **모드**는 유지된다 — 다른 이미지를 클릭하면 그 이미지로 포커스가
  이동하고, box를 클릭하면 포커스만 해제된 채 모드가 남아 Tab/이미지 클릭으로
  재진입할 수 있다.

## 7B. Tab / Shift+Tab 순회

텍스트 편집 모드의 paragraph 순회와 동일한 패턴으로 이미지 편집 모드에서
Tab/Shift+Tab으로 이미지를 순회한다 (`EditManager.navigateByTab`).

- `_flattenImages`가 문서의 모든 편집 가능한 이미지를 Pre-order DFS + zIndex 정렬로
  수집한다 (표 내부 이미지는 `_flattenTableImages`가 grid 순서로 수집).
- 현재 `focusedImage` 위치에서 순방향/역방향으로 이동하며, 마지막에서 순환한다.
- 포커스 이동마다 `_selectBoxForImage`로 부모 box 선택도 함께 이동한다.

## 8. 제약

- **lock**: 조상 box에 lock이 있으면 편집 불가 (`focusImage`가 `false` 반환).
- **편집 루트**: `editableRootId` 밖의 이미지는 편집 불가.
- **`showPlaceholderBorders`/스케일 보정**: `screenDeltaToMm`이 `ppm × scale` 기반으로 동작하므로 줌 환경에서도 정확하다.
- **빈 캔버스/로드 실패**: DOM 로드 실패 시에도 엔진 `rgbaData`가 유지되므로(엔진-우선 원칙) 오버랩 판정이 깨지지 않는다. 이미지 편집은 표시 rect만 조작하므로 픽셀 데이터에 영향을 주지 않는다.

## 9. 핵심 파일

| 파일 | 역할 |
|---|---|
| `src/edit/image-edit-controller.ts` | `ImageEditController`: mousedown/wheel capture 위임, 드래그 세션 상태, rAF 스로틀링, 클램핑, ESC 취소, objectFit 자동 전환 |
| `src/edit/edit-manager.ts` | `imageEditMode`/`focusedImage`/`focusImage`/`blurImage`/`isImageEditable`, `_dispatchImageMove`/`_dispatchImageResize`/`_dispatchImagePropertyChange`, 모드 상호 배타 처리 |
| `src/edit/layout-selection-controller.ts` | `_onDblClick` 이미지 경로: layoutEditMode에서 이미지 더블클릭 → `focusImage` |
| `src/components/layout/image.element.ts` | `image-edit-focus` 속성 스타일 (파란 outline + move 커서) |
| `src/types/edit/layout.type.ts` | `EditModeState.imageEditMode`, `ImagePropertyChangeEventDetail`, `ImagePropertyName` |