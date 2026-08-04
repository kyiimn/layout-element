# opentype.js 마이그레이션 작업 진행 상황

> 작성일: 2026-08-04
> 작성자: Sisyphus (GLM 5.2)

## 1. 배경

신문 레이아웃 엔진(`layout-element`)에서 텍스트 문자 폭 측정을 Canvas `measureText()`에서 opentype.js 폰트 메트릭 직접 파싱으로 마이그레이션. 목적: 클라이언트(브라우저) ↔ 서버(Playwright) ↔ 윤전기 인쇄물 간 조판 결과 일치 보장.

## 2. 완료된 작업 (커밋됨: 0e58929, 5f5158a, 97d27f4)

### 2.1 opentype.js 의존성 추가
- `package.json`: `peerDependencies`에 `opentype.js: ^1.3.4` 추가
- `src/opentype.d.ts`: opentype.js 모듈 타입 선언 (Font, Glyph, parse)

### 2.2 FontLoader 확장 (`src/resource/font-loader.ts`)
- 정적 import `opentype.js` (필수 의존성)
- `_parseOpentypeFonts()`: `base64Data` 또는 `ttfFilename`에서 폰트를 fetch하여 `opentype.parse()`로 파싱
  - `base64Data`가 있으면 base64에서 직접 파싱
  - `ttfFilename`만 있으면 fetch로 ArrayBuffer 로드 후 파싱
- `_opentypeFonts: Map<family, OpentypeFont>` 캐싱
- `getOpenTypeFont(fontName?)` public API 추가
- `opentypeEnabled` getter 추가
- `_opentypeEnabled` 상태 관리 (init 완료 후 true)

### 2.3 TextLayoutEngine 수정 (`src/core/text-layout-engine.ts`)
- **canvas 관련 코드 제거**: `_canvas`, `_ctx`, `_getCachedFontString`, `_updatePerfCharStyleCache`, canvas 모드 캐시 필드 모두 제거
- **`_charWidthMm()`**: opentype.js 폰트 메트릭만 사용 (canvas 폴백 제거)
  - 공백: `spaceRatio * fontSize` 반환
  - 일반: `_charWidthMmViaOpentype()` → `glyph.advanceWidth / unitsPerEm * fontSize` 반환 (장평 미적용 원본)
  - 폰트 조회 실패 시: `minWidthMm` 반환
- **`_charWidthMmViaOpentype()`**: `FontLoader.getOpenTypeFont()` → `charToGlyph(char)` → advanceWidth 계산
- **줄바꿈 계산** (`_layoutTextIntoColumns`):
  - `charWidth = rawCharWidth * widthRatio + letterSpacingMm` (장평 + 자간)
  - `partWidths`와 직접 비교 (보정 없음)
- **`genCharStyle()`**: `_genOpentypeOuterStyle()`만 반환 (canvas 모드 분기 제거)
- **`genCharInnerStyle()`** 추가: 내부 span용 `scale: ${wr} 1` 스타일
- **`_genOpentypeOuterStyle()`**: 외부 span 스타일
  - `width = owidth * widthRatio + letterSpacingMm` (장평 + 자간을 width에 포함)
  - `min-width`, `max-width` 동일값 고정
  - `overflow: hidden`
  - 공백: `spaceRatio * fontSize * widthRatio + letterSpacingMm`
- **`getCharWidths()`** public 메서드 추가: `{ owidth, swidth }` 반환
  - `owidth`: 원본 폭 (장평 미적용)
  - `swidth`: `owidth * widthRatio + letterSpacingMm` (장평 + 자간, DOM width와 동일)
- **`genPartStyle()`**: `letterSpacing` CSS 속성 제거 (width에 이미 포함됨)
- **캐시**: `_opentypeOuterStyleCache` (문자별 Map), `_opentypeInnerStyle` (장평별)

### 2.4 ColumnElement 수정 (`src/components/layout/column.element.ts`)
- **이중 span 구조**: 외부 span(width 고정 + overflow:hidden) + 내부 span(scale transform)
  - `genCharStyle()` → 외부 span 스타일
  - `genCharInnerStyle()` → 내부 span 스타일
  - `inner.textContent = char` (innerText 대신 textContent 사용 — 공백 보존)
- **data 속성**: `data-owidth`, `data-swidth` 추가 (디버깅용)
- `TEXT_MEASUREMENT_MODE` 분기 제거 (항상 opentype 모드)

### 2.5 ParagraphElement 수정 (`src/components/layout/paragraph.element.ts`)
- `printPostData`: 내부 span에서 `textContent`로 글자 추출, 내부 span의 `scale`에서 `widthRatio` 추출

### 2.6 금칙문자 규칙 수정 (`_applyLineBreakRules`)
- **행두 금지** (`.`, `,`, `)` 등): 행두 금지 문자를 **이전 라인 마지막으로 보냄**
  - 이전: 현재 라인 마지막 글자를 다음 라인으로 보냄 (잘못됨)
  - 수정: `nextFirstChar`를 `curLastPart`로 push
- **행말 금지** (`(`, `[` 등): 행말 금지 문자를 **다음 라인 첫 글자로 보냄**
  - 이전: 다음 라인 첫 글자를 현재 라인으로 가져옴 (잘못됨)
  - 수정: `curLastChar`를 `nextFirstPart`로 unshift

### 2.7 문서 업데이트
- `docs/TEXT_ENGINE.md` §6, §11.4: opentype 모드 설명, 이중 span 구조 문서화
- `docs/RESOURCE.md` §2.6, §2.9: FontLoader opentype.js API 문서화
- `src/constants/defaults.ts`: `TEXT_MEASUREMENT_MODE` 상수 (현재 미사용이지만 향후 canvas 모드 복귀용 보존)

## 3. 미커밋 작업 (작업 폴더에 있음)

다음 파일들이 수정되었으나 아직 커밋되지 않음:
- `src/core/text-layout-engine.ts` — canvas 제거, opentype 전용, 금칙문자 수정, 이중 span 구조, letterSpacing width 포함
- `src/components/layout/column.element.ts` — 이중 span 구조, data-owidth/data-swidth
- `src/components/layout/paragraph.element.ts` — printPostData 수정
- `docs/TEXT_ENGINE.md` — 문서 업데이트
- `examples/fonts.json` — 사용자 수정 (중앙신문명조 폰트 추가)
- `examples/index.html` — 사용자 수정 (샘플 데이터 변경)

## 4. 남은 문제점

### 4.1 미세한 폭 넘침 (2건)

데모 페이지(`examples/index.html`, dev 서버 5174 포트)에서 2건의 폭 넘침 발생:

1. **li=18, "," (diff=0.84px)**: `"가와 컴퓨팅 용량 부족으로 인프라 투자를 확대하고 있고,"`
   - 쉼표가 라인 마지막에서 0.84px 넘침
2. **li=36, "." (diff=2.41px)**: `"수익성의 지속 가능성에 주목해야 할 시기\"라고 분석했다."`
   - 마침표가 라인 마지막에서 2.41px 넘침

**원인 분석**:
- 줄바꿈 계산과 DOM 렌더링 간 미세한 불일치
- `letterSpacing`을 `width`에 포함시키는 방식에서, 마지막 글자에도 `letterSpacing`이 포함되어 있어 실제보다 넓게 계산
- DOM에서는 `space-between` 정렬이 마지막 글자를 컬럼 끝에 밀어붙이면서 미세하게 넘침

**해결 방향**:
- 줄바꿈 계산에서 마지막 글자의 `letterSpacing`을 제외하는 것이 정확하지만, 배치 시점에 마지막인지 알 수 없음
- `partWidths`에서 `letterSpacingMm`을 한 번 차감하는 보정 방식(`partWidths + letterSpacingMm`)은 이전에 시도했으나, `textBlockStyle` 유무에 따른 `_charWidthMm` 값 차이로 인해 실패
- **근본 해결**: 줄바꿈 후 검증 단계 추가 — 배치된 라인의 실제 DOM 폭(`sum(swidth)`)이 `partWidths`를 초과하면 마지막 글자를 다음 라인으로 이동. 이전에 `_fixLineOverflow()`로 시도했으나 `getCharWidths`와 `_charWidthMm` 간 불일치로 실패. canvas 폴백 제거 후 재시도 가능.

### 4.2 letterSpacing 처리 방식

현재: `letterSpacing`을 각 span의 `width`에 포함 (`swidth = owidth * widthRatio + letterSpacingMm`)

이전 시도:
- `marginRight`로 `letterSpacing`을 별도 적용 → `space-between` 정렬과 충돌하여 넘침 폭증 (70건)
- 마지막 글자 `marginRight` 제거 → 넘침 폭증 (11건)
- `partWidths + letterSpacingMm` 보정 → `textBlockStyle` 불일치로 실패

현재 방식이 가장 안정적 (2건 넘침)이지만, 마지막 글자의 `letterSpacing` 포함 여부가 미세 불일치의 원인.

### 4.3 공백 폭 장평 적용

`_genOpentypeypeOuterStyle`에서 공백은 `spaceRatio * fontSize * widthRatio + letterSpacingMm`로 계산. 장평이 공백에도 적용됨. 이전에 공백에 장평이 적용되지 않아 넘침이 발생했던 버그를 수정했음.

## 5. 개발 환경

- 데모 페이지: `npx vite dev` → `http://localhost:5174/examples/index.html` (IPv6 `[::1]`로 접근)
- 테스트 페이지: `examples/test-width.html` (빌드된 번들 사용, `http://localhost:5288`)
- 빌드: `npx vite build` → `dist/layout-element.iife.js` (453.70 KB)
- 타입체크: `npx tsc --noEmit` (통과)

## 6. 다음 세션에서 이어할 작업

1. **미세 넘침 2건 해결**: 줄바꿈 후 검증 단계(`_fixLineOverflow`) 재시도. canvas 폴백 제거 후 `getCharWidths`와 `_charWidthMm`이 일치하므로 정상 동작 예상
2. **커밋**: 미커밋 작업 정리 후 커밋
3. **문서 업데이트**: 최종 상태 반영
4. **`TEXT_MEASUREMENT_MODE` 상수 정리**: 현재 미사용. 제거하거나 향후 canvas 모드 복귀용 보존 결정 필요