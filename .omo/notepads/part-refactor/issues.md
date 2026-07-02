# Part-Refactor Known Issues & Edge Cases

## 2026-07-03: 현재 알려진 이슈

### 이슈 1: 좁은 Part에 한 글자도 안 들어가는 경우

**상태**: 부분 처리됨

**설명**: 오버랩으로 인해 Part의 폭이 글자 하나의 폭보다 좁아지면, 해당 Part에 어떤 글자도 넣을 수 없다. 현재 코드는 `partEls[0].scrollWidth > partEls[0].clientWidth`를 확인하고, 실패하면 `idxContentOfBlock--` 후 다음 라인으로 재시도한다.

**잠재적 문제**: 모든 Part가 한 글자 폭보다 좁은 극단적 오버랩 상황에서는 무한 루프가 발생할 수 있다. `while(true)` 재시도 루프에서 새 라인도 COVER인 경우 `continue`로 반복되기 때문.

**완화책**: COVER 후 `vColumnEl.isOverflow` 체크로 루프 탈출. 하지만 오버플로우가 없는 좁은 컬럼에서는 여전히 무한 루프 가능성이 있음.

### 이슈 2: 마지막 컬럼 오버플로우 시 `_overflow` 증가

**상태**: 기존 동작 유지

**설명**: 마지막 컬럼에서 텍스트가 넘치면 `_overflow++`로 카운트만 증가시킨다. `render-error` 이벤트로 외부에 통지된다.

### 이슈 3: `printPostData`와의 연동

**상태**: 확인 필요

**설명**: `LayoutColumnElement`의 `printPostData`가 현재 `TextLineData`의 구조 변화를 반영하지 않을 수 있다. 현재 `column.element.ts`에는 `printPostData`가 정의되어 있지 않아 이슈가 없지만, 향후 프린트 모드에서 Part 구조를 전송해야 할 수 있다.

### 이슈 4: `vColumnEl.isOverflow` 정확도

**상태**: 기존 동작 유지

**설명**: `isOverflow`는 `scrollHeight > clientHeight`로 판단한다. Part 구조에서도 동일하게 동작하지만, COVER 라인(`width: 0`)이 추가될 때마다 scrollHeight가 증가하므로, 연속 COVER가 많으면 실제 텍스트보다 일찍 오버플로우로 판단될 수 있다. 이는 의도된 동작(COVER 공간도 수직 공간을 차지함).

### 이슈 5: `ppm` 변환 정밀도

**상태**: 모니터링 필요

**설명**: `ppm = vColumnEl.getBoundingClientRect().width / this._columnWidths[curColumn]`로 계산한다. `getBoundingClientRect()`는 서브픽셀 정밀도를 반환하므로, `freeRegions`의 픽셀→mm 변환 시 미세한 오차가 누적될 수 있다.

### 이슈 6: 투명 픽셀 감지와 Part 경계

**상태**: 정상 동작

**설명**: `getOverlapSizePX()`는 이미지의 투명 픽셀을 감지하여 `OverlapParts`를 반환한다. 투명 영역은 Part의 자유 영역(free region)으로 처리되어 텍스트가 그 위에 배치될 수 있다. 이는 의도된 동작이다.
