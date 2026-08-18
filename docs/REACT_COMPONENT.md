# API Reference — React Component Layer

이 문서는 `layout-element/react` 패키지(`dist/layout-element-react.mjs`)의 **React
래퍼 API**에 대한 전체 레퍼런스입니다.

- **`react` 18+** 가 peer dependency입니다.
- **바닐라 JS API**는 [`API.md`](./API.md)를 참고하세요. 본 문서에서 다루는 모든
  React 컴포넌트는 내부적으로 동일한 Custom Element를 사용합니다.
- 이 React 레이어는 **데이터 변경 시 효과(effect)** 로 동기화하므로, props가 같으면
  setter를 호출하지 않습니다.

## 목차

1. [빠른 시작](#빠른-시작)
2. [설치 / Import](#설치--import)
3. [Provider / Context](#provider--context)
   - [`LayoutProvider`](#layoutprovider)
   - [`useLayoutContext`](#uselayoutcontext)
4. [컴포넌트](#컴포넌트)
   - [`<LayoutDocument>`](#layoutdocument)
   - [`<LayoutBox>`](#layoutbox)
   - [`<LayoutParagraph>`](#layoutparagraph)
   - [`<LayoutImage>`](#layoutimage)
   - [`<LayoutGuideColumn>`](#layoutguidecolumn)
   - [`<LayoutTable>`](#layouttable)
   - [`<LayoutTableRow>`](#layouttablerow)
   - [`<LayoutTableCell>`](#layouttablecell)
   - [`<Logo>`](#logo)
5. [Hooks](#hooks)
   - [`useEditManager`](#useeditmanager)
   - [`useLayoutElement`](#uselayoutelement)
   - [`useEditableText`](#useeditabletext)
6. [타입 재노출](#타입-재노출)
7. [전체 예제](#전체-예제)

---

## 빠른 시작

```tsx
import {
  LayoutProvider, useLayoutContext,
  LayoutDocument, LayoutBox, LayoutParagraph, LayoutImage,
  useEditManager,
} from 'layout-element/react';
import { exampleData } from 'layout-element';

function App() {
  return (
    <LayoutProvider>
      <Newspaper data={exampleData} />
    </LayoutProvider>
  );
}

function Newspaper({ data }: { data: DocumentData }) {
  return (
    <LayoutDocument
      data={data}
      width={data.width}
      height={data.height}
      onRenderError={(e) => console.warn('overflow:', e.detail)}
    />
  );
}
```

---

## 설치 / Import

```bash
npm install layout-element
# peer: react ^18.0.0, react-dom ^18.0.0
```

```tsx
// ESM (권장)
import {
  LayoutProvider,
  LayoutDocument, LayoutBox, LayoutParagraph, LayoutImage, LayoutGuideColumn,
  useEditManager, useLayoutElement, useEditableText,
} from 'layout-element/react';
```

```tsx
// 타입 (TypeScript 사용 시)
import type {
  LayoutDocumentProps, LayoutBoxProps, LayoutParagraphProps,
  LayoutImageProps, LayoutGuideColumnProps,
  UseEditManagerReturn, UseEditManagerOptions,
  LayoutContextValue, LayoutProviderProps,
} from 'layout-element/react';
```

> `layout-element/react`는 `react`와 `react/jsx-runtime`을 **external**로 처리합니다.
> 번들에 React가 포함되지 않습니다.

---

## Provider / Context

### `LayoutProvider`

`ColorRegistry`와 `FontLoader`를 자동으로 초기화하는 React Provider.
**모든 Layout 컴포넌트의 부모**에 위치해야 합니다.

```tsx
import { LayoutProvider } from 'layout-element/react';

<LayoutProvider>
  <App />
</LayoutProvider>
```

#### Props: `LayoutProviderProps`

| Prop | 타입 | 필수 | 설명 |
|---|---|---|---|
| `colorSet` | `CMYKColorSet` | 선택 | 인쇄 모드 또는 명시적 주입. 미지정 시 `color.json`을 fetch. |
| `fonts` | `Font[]` | 선택 | 인쇄 모드용 인라인 폰트 데이터. 미지정 시 `fonts.json`을 fetch. |
| `children` | `ReactNode` | 필수 | 자식 컴포넌트. |

#### 내부 동작

- 화면 모드 (`colorSet` / `fonts` 미지정): `ColorRegistry.init()` + `FontLoader.init()`
  모두 기본 fetch로 호출.
- 인쇄 모드 (둘 중 하나 명시): 둘 다 `init({ ... })` 형태로 데이터 주입.
- `useEffect` 내부에서 `initialize()` 호출 → 완료 시 `ready: true`, 에러 시 `error: Error` 노출.

#### 예제

```tsx
// 화면 모드
<LayoutProvider>
  <Newspaper />
</LayoutProvider>

// 인쇄 모드 (PostScript/PDF 생성 시)
<LayoutProvider
  colorSet={{
    black: { c: 0, m: 0, y: 0, k: 255 },
    red:   { c: 0, m: 255, y: 255, k: 0 },
  }}
  fonts={[
    { family: 'Myoungjo', weight: 400, style: 'normal', base64Data: '...' },
  ]}
>
  <Newspaper />
</LayoutProvider>
```

### `useLayoutContext`

`LayoutContext`의 값을 반환하는 훅.

```tsx
import { useLayoutContext } from 'layout-element/react';

const { ready, error, colorRegistry, fontLoader } = useLayoutContext();
```

#### 반환값: `LayoutContextValue`

| 필드 | 타입 | 설명 |
|---|---|---|
| `ready` | `boolean` | `ColorRegistry` + `FontLoader` 초기화 완료 여부. |
| `error` | `Error \| null` | 초기화 중 발생한 에러. |
| `colorRegistry` | `ColorRegistry` | 싱글턴 인스턴스. |
| `fontLoader` | `FontLoader` | 싱글턴 인스턴스. |

#### 예외

`LayoutProvider` 외부에서 호출 시:
```
Error: useLayoutContext must be used within a LayoutProvider
```

#### 예제

```tsx
function LoadingGate({ children }: { children: ReactNode }) {
  const { ready, error } = useLayoutContext();
  if (error) return <div>Error: {error.message}</div>;
  if (!ready) return <Spinner />;
  return <>{children}</>;
}
```

---

## 컴포넌트

### `<LayoutDocument>`

**문서 루트** 컴포넌트. `<x-layout-document>`를 감쌉니다.

```tsx
import { LayoutDocument } from 'layout-element/react';
import type { LayoutDocumentProps } from 'layout-element/react';

const ref = useRef<LayoutDocumentElement>(null);
<LayoutDocument ref={ref} {...props} />;
```

#### Props: `LayoutDocumentProps`

| Prop | 타입 | 단위 | 필수 | 설명 |
|---|---|---|---|---|
| `data` | `DocumentData` | — | **필수** | 문서 전체 데이터. 변경 시 자식 트리 재구축. |
| `width` | `number` | mm | 선택 | `data.width` 미지정 시 폴백. |
| `height` | `number` | mm | 선택 | `data.height` 미지정 시 폴백. |
| `paddingTop` | `number` | mm | 선택 | 상단 여백. |
| `paddingRight` | `number` | mm | 선택 | 우측 여백. |
| `paddingBottom` | `number` | mm | 선택 | 하단 여백. |
| `paddingLeft` | `number` | mm | 선택 | 좌측 여백. |
| `columns` | `number \| number[]` | — | 선택 | 균등 분할 또는 명시적 폭. |
| `gap` | `number \| number[]` | mm | 선택 | 컬럼 간격. |
| `paragraphStyle` | `ParagraphStyle` | — | 선택 | 전역 문단 스타일. |
| `textStyle` | `TextStyle` | — | 선택 | 전역 텍스트 스타일. |
| `visibleGuide` | `boolean` | — | 선택 | 가이드 컬럼 표시. |
| `onRenderError` | `(event: CustomEvent) => void` | — | 선택 | `render-error` 이벤트 핸들러. |
| `onInnerSizeChange` | `(innerWidth: number, innerHeight: number) => void` | — | 선택 | 패딩 제외 크기 변경 시 호출. |
| `children` | `ReactNode` | — | 선택 | 자식 (보통 비워두고 `data.children`으로 트리 구성). |

#### 동기화 동작

| Prop 변경 | 호출되는 setter |
|---|---|
| `data` | `element.data = data` (자식 트리 재구축) |
| `width` | `element.width = width` |
| `height` | `element.height = height` |
| `paddingTop` | `element.paddingTop = paddingTop` |
| `paddingRight` | `element.paddingRight = paddingRight` |
| `paddingBottom` | `element.paddingBottom = paddingBottom` |
| `paddingLeft` | `element.paddingLeft = paddingLeft` |
| `columns` | `element.columns = columns` |
| `gap` | `element.gap = gap` |
| `paragraphStyle` | `element.paragraphStyle = paragraphStyle` |
| `textStyle` | `element.textStyle = textStyle` |
| `visibleGuide` | `element.visibleGuide = visibleGuide` |

> **미지정(undefined) props는 setter를 호출하지 않습니다** — 부분 업데이트 안전.

#### Ref

`forwardRef<LayoutDocumentElement, LayoutDocumentProps>` — 내부 요소에 직접 접근:

```tsx
const ref = useRef<LayoutDocumentElement>(null);
useEffect(() => {
  console.log(ref.current?.items); // LayoutBoxElement[]
}, []);
```

#### 이벤트

```tsx
<LayoutDocument
  data={data}
  onRenderError={(e) => {
    const detail = e.detail as { id: string; overflow: number };
    console.warn(`Paragraph ${detail.id} overflow: ${detail.overflow}`);
  }}
/>
```

#### 예제

```tsx
function Newspaper({ data }: { data: DocumentData }) {
  return (
    <LayoutDocument
      data={data}
      onInnerSizeChange={(w, h) => console.log('inner:', w, h)}
      onRenderError={(e) => console.warn('overflow', e.detail)}
    />
  );
}
```

---

### `<LayoutBox>`

위치 지정 가능한 컨테이너. `<x-layout-box>`를 감쌉니다.

```tsx
import { LayoutBox } from 'layout-element/react';
import type { LayoutBoxProps } from 'layout-element/react';
```

#### Props: `LayoutBoxProps`

| Prop | 타입 | 단위 | 필수 | 설명 |
|---|---|---|---|---|
| `data` | `BoxData` | — | **필수** | 박스 데이터. |
| `left` | `number` | mm (static: 컬럼 인덱스) | 선택 | 좌측 위치. |
| `top` | `number` | mm | 선택 | 상단 위치. |
| `width` | `number` | mm (static: 컬럼 수) | 선택 | 너비. |
| `height` | `number` | mm (static: 줄 수) | 선택 | 높이. |
| `position` | `'static' \| 'absolute'` | — | 선택 | 배치 모드. |
| `zIndex` | `number` | — | 선택 | z-index. |
| `backgroundColor` | `string` | — | 선택 | 배경색. |
| `borderTopWidth` | `number` | mm | 선택 | 상단 테두리 두께. |
| `borderRightWidth` | `number` | mm | 선택 | 우측 테두리 두께. |
| `borderBottomWidth` | `number` | mm | 선택 | 하단 테두리 두께. |
| `borderLeftWidth` | `number` | mm | 선택 | 좌측 테두리 두께. |
| `borderStyle` | `'solid' \| 'dotted' \| 'dashed'` | — | 선택 | 테두리 스타일. |
| `borderColor` | `string` | — | 선택 | 테두리 색상. |
| `paddingTop` | `number` | mm | 선택 | 내부 상단 여백. |
| `paddingRight` | `number` | mm | 선택 | 내부 우측 여백. |
| `paddingBottom` | `number` | mm | 선택 | 내부 하단 여백. |
| `paddingLeft` | `number` | mm | 선택 | 내부 좌측 여백. |
| `editableLayout` | `boolean` | — | 선택 | 레이아웃 편집 활성화. |
| `role` | `BoxRole` | — | 선택 | 의미적 역할. |
| `groupMember` | `string[]` | — | 선택 | 그룹 멤버 ID. |
| `priority` | `number` | — | 선택 | 우선순위. |
| `children` | `ReactNode` | — | 선택 | 자식 요소들. |

> **Note**: `lock` 프로퍼티는 React wrapper의 `LayoutBoxProps`에 **포함되어 있지
> 않습니다**. 박스 잠금을 사용하려면 `data` 객체에 `lock: true`를 포함시키세요:
> ```tsx
> <LayoutBox data={{ type: 'box', left: 0, top: 0, width: 3, height: 10, lock: true }} />
> ```

#### Ref

`forwardRef<LayoutBoxElement, LayoutBoxProps>`

#### 예제

```tsx
<LayoutBox
  data={{
    type: 'box',
    left: 0, top: 0, width: 3, height: 12,
    role: 'body',
    borderColor: 'black',
    borderBottomWidth: 0.5,
  }}
  paddingLeft={5}
  editableLayout
>
  <LayoutParagraph data={{ type: 'paragraph', content: '본문' }} />
</LayoutBox>
```

---

### `<LayoutParagraph>`

다중 컬럼 텍스트 영역. `<x-layout-paragraph>`를 감쌉니다.

```tsx
import { LayoutParagraph } from 'layout-element/react';
import type { LayoutParagraphProps } from 'layout-element/react';
```

#### Props: `LayoutParagraphProps`

| Prop | 타입 | 단위 | 필수 | 설명 |
|---|---|---|---|---|
| `data` | `ParagraphData` | — | **필수** | 단락 데이터. |
| `editableText` | `boolean` | — | 선택 | 텍스트 편집 활성화. 인쇄 모드에서는 무시. |
| `aiProcessing` | `boolean` | — | 선택 | AI 처리 중 오버레이 토글. `true` 시 반투명 오버레이 + shimmer/spinner 애니메이션. `pointer-events: auto`로 마우스 이벤트 차단. `data`에 포함되지 않는 휘발성 속성. |
| `onRenderError` | `(event: CustomEvent) => void` | — | 선택 | 오버플로우 등 render-error 핸들러. |
| `children` | `ReactNode` | — | 선택 | 자식. |

#### 동기화 동작

| Prop 변경 | 호출 |
|---|---|
| `data` | `element.data = data` |
| `editableText` | `element.editableText = editableText` |
| `aiProcessing` | `element.aiProcessing = aiProcessing` |

> `editableText`는 `EditManager`로 단락에 포커스를 주는 게 더 권장됩니다. 컴포넌트
> prop 방식은 "편집 가능 영역"으로 표시만 합니다.

#### Ref

`forwardRef<LayoutParagraphElement, LayoutParagraphProps>`

#### 예제

```tsx
<LayoutParagraph
  data={{
    type: 'paragraph',
    content: '본문 텍스트...',
    column: 3, gap: 3,
  }}
  onRenderError={(e) => console.warn('overflow', e.detail)}
/>
```

---

### `<LayoutImage>`

이미지 크롭. `<x-layout-image>`를 감쌉니다. children은 받지 않습니다.

```tsx
import { LayoutImage } from 'layout-element/react';
import type { LayoutImageProps } from 'layout-element/react';
```

#### Props: `LayoutImageProps`

| Prop | 타입 | 단위 | 필수 | 설명 |
|---|---|---|---|---|
| `data` | `ImageData` | — | **필수** | 이미지 데이터. |
| `x` | `number` | px | 선택 | 크롭 시작 X. |
| `y` | `number` | px | 선택 | 크롭 시작 Y. |
| `width` | `number` | px | 선택 | 크롭 너비. |
| `height` | `number` | px | 선택 | 크롭 높이. |
| `dpi` | `number` | DPI | 선택 | 해상도. |
| `url` | `string` | — | 선택 | 이미지 URL. |
| `zIndex` | `number` | — | 선택 | z-index. |
| `overlapPadding` | `number \| { top?, right?, bottom?, left? }` | mm | 선택 | 텍스트 회피 패딩. |
| `overlapMode` | `OverlapMode` | — | 선택 | 오버랩 처리 모드 (`'path'` \| `'box'` \| `'none'`). 기본값 `'path'`. | |
| `aiProcessing` | `boolean` | — | 선택 | AI 처리 중 오버레이 토글. `true` 시 반투명 오버레이 + shimmer/spinner 애니메이션. `pointer-events: auto`로 마우스 이벤트 차단. `data`에 포함되지 않는 휘발성 속성. |

#### Ref

`forwardRef<LayoutImageElement, LayoutImageProps>`

#### 예제

```tsx
<LayoutImage
  data={{
    type: 'image',
    x: 0, y: 0,
    width: 800, height: 600,
    dpi: 300,
    url: '/photo.jpg',
  }}
  overlapPadding={{ top: 2, right: 5, bottom: 2, left: 5 }}
/>
```

---

### `<LayoutGuideColumn>`

텍스트 줄 위치 가이드. `<x-layout-guide-column>`를 감쌉니다.

```tsx
import { LayoutGuideColumn } from 'layout-element/react';
import type { LayoutGuideColumnProps } from 'layout-element/react';
```

#### Props: `LayoutGuideColumnProps`

| Prop | 타입 | 단위 | 필수 | 설명 |
|---|---|---|---|---|
| `rect` | `Rect` | mm | 선택 | 위치/크기 한 번에 갱신. |
| `visible` | `boolean` | — | 선택 | 표시 여부. |
| `fontSize` | `number` | mm | 선택 | 글자 크기 (가이드 라인 높이). |
| `lineHeight` | `number` | mm | 선택 | 라인 간격. |

> `Rect`: `{ x1, y1, x2, y2 }` (mm).

#### Ref

`forwardRef<LayoutGuideColumnElement, LayoutGuideColumnProps>`

> 일반적으로 사용자가 직접 사용하지 않습니다. `<LayoutDocument>`가 자동으로
> 자식으로 만듭니다.

---

### `<LayoutTable>`

`<x-layout-table>` 요소의 React 래퍼. 표 컨테이너.

```tsx
import { LayoutTable } from 'layout-element/react';

<LayoutTable data={tableData} colWidths={[30, 40, 30]} />
```

#### Props

| Prop           | Type                    | 설명                                    |
| -------------- | ----------------------- | --------------------------------------- |
| `data`         | `TableData`             | 표 데이터 (필수)                         |
| `colWidths`    | `number \| number[]`    | 열 너비 (mm). number=균등, number[]=개별 |
| `inheritStyle` | `Record<string, unknown>` | 상속 스타일                            |
| `children`     | `React.ReactNode`       | 자식 요소                               |

---

### `<LayoutTableRow>`

`<x-layout-tr>` 요소의 React 래퍼. 표 행.

```tsx
import { LayoutTableRow } from 'layout-element/react';

<LayoutTableRow data={rowData} height={10} />
```

#### Props

| Prop       | Type            | 설명              |
| ---------- | --------------- | ----------------- |
| `data`     | `TableRowData`  | 행 데이터 (필수)  |
| `height`   | `number`        | 행 높이 (mm)      |
| `children` | `React.ReactNode` | 자식 요소       |

---

### `<LayoutTableCell>`

`<x-layout-td>` 요소의 React 래퍼. 표 셀.

```tsx
import { LayoutTableCell } from 'layout-element/react';

<LayoutTableCell data={cellData} colspan={2} backgroundColor="black" />
```

#### Props

| Prop               | Type              | 설명                         |
| ------------------ | ----------------- | ---------------------------- |
| `data`             | `TableCellData`   | 셀 데이터 (필수)             |
| `colspan`          | `number`          | 열 병합 수                   |
| `rowspan`          | `number`          | 행 병합 수                   |
| `backgroundColor`  | `string`          | 배경색 (ColorRegistry 이름)  |
| `backgroundOpacity`| `number`          | 배경 투명도 (0~1)            |
| `paddingTop`       | `number`          | 상단 여백 (mm)               |
| `paddingRight`     | `number`          | 우측 여백 (mm)              |
| `paddingBottom`    | `number`          | 하단 여백 (mm)              |
| `paddingLeft`      | `number`          | 좌측 여백 (mm)              |
| `children`         | `React.ReactNode` | 자식 요소                    |

---

### `<Logo>`

라이브러리 식별용 로고 SVG 컴포넌트. 레이아웃 엔진과 무관한 순수 표시용
컴포넌트로, `currentColor`를 따라 색이 결정됩니다.

```tsx
import { Logo } from 'layout-element/react';
import type { LogoProps } from 'layout-element/react';
```

#### Props: `LogoProps`

| Prop | 타입 | 필수 | 설명 |
|---|---|---|---|
| `className` | `string` | 선택 | SVG에 전달할 CSS 클래스. |

#### 예제

```tsx
<Logo className="text-slate-900" />
```

---

## Hooks

### `useEditManager`

`EditManager` 싱글턴에 구독하여 React 상태로 노출하는 메인 훅. **편집기** UI를 만들 때
가장 많이 쓰입니다.

```tsx
import { useEditManager } from 'layout-element/react';
import type {
  UseEditManagerReturn, UseEditManagerOptions,
} from 'layout-element/react';

const {
  focusedParagraph, focusedController, cursorOffset, selection, currentStyle,
  selectedLayouts, selectedLayoutIds,
  focusParagraph, blurParagraph, selectLayout, clearLayoutSelection,
} = useEditManager({
  onTextChange: (e) => console.log('text changed', e),
  onLayoutSelectionChange: (e) => console.log('selected', e.selectedLayouts),
});
```

#### 옵션: `UseEditManagerOptions`

| 키 | 시그니처 | 발생 시점 |
|---|---|---|
| `onFocusChange` | `(e: EditManagerEvent) => void` | 포커스 변경 |
| `onTextChange` | `(e: EditManagerEvent) => void` | 텍스트 변경 |
| `onStyleChange` | `(e: EditManagerEvent) => void` | 스타일 변경 |
| `onSelectionStart` | `(e: EditManagerEvent) => void` | 선택 시작 |
| `onSelectionEnd` | `(e: EditManagerEvent) => void` | 선택 종료 |
| `onCursorMove` | `(e: EditManagerEvent) => void` | 커서 이동 |
| `onLayoutSelectionChange` | `(e: EditManagerEvent) => void` | 레이아웃 선택 변경 |
| `onLayoutMove` | `(e: EditManagerEvent) => void` | 박스 이동 |

#### 반환값: `UseEditManagerReturn`

| 필드 | 타입 | 설명 |
|---|---|---|
| `focusedParagraph` | `LayoutParagraphElement \| null` | 포커스된 단락. |
| `focusedController` | `TextEditController \| null` | 포커스된 컨트롤러. |
| `cursorOffset` | `number \| null` | 커서 소스 오프셋. |
| `selection` | `SelectionRange \| null` | 선택 영역. |
| `currentStyle` | `CurrentStyle \| null` | 커서 위치의 유효 스타일. |
| `selectedLayouts` | `LayoutElement[]` | 선택된 박스들. |
| `selectedLayoutIds` | `string[]` | 선택된 박스 ID들. |
| `focusParagraph` | `(target, options?) => boolean` | 단락 포커스. |
| `blurParagraph` | `(target?) => boolean` | 포커스 해제. |
| `selectLayout` | `(target) => boolean` | 레이아웃 선택. |
| `clearLayoutSelection` | `(preserveFocusedBox?: boolean) => void` | 레이아웃 선택 해제. `preserveFocusedBox=false`면 포커스 박스도 해제. |

#### 메서드 시그니처

```ts
focusParagraph(
  target: LayoutParagraphElement | string,
  options?: { cursorOffset?: number; selection?: SelectionRange },
): boolean;

blurParagraph(target?: LayoutParagraphElement | string): boolean;

selectLayout(
  target: LayoutElement | string | (LayoutElement | string)[]
): boolean;

clearLayoutSelection(preserveFocusedBox?: boolean): void;
```

#### 내부 동작

- `EditManager`의 8개 이벤트(`focusChange`, `textChange`, ...)를 모두 구독.
- 각 이벤트 발생 시 `syncState()`로 React state를 매니저와 동기화.
- 옵션의 콜백은 `optionsRef`를 통해 최신 closure 사용.
- 컴포넌트 언마운트 시 모든 리스너 자동 해제.

#### 예제: 텍스트 편집기 UI

```tsx
function EditorToolbar() {
  const { focusedParagraph, currentStyle, focusParagraph, blurParagraph } =
    useEditManager({
      onTextChange: (e) => console.log('text changed'),
    });

  if (!focusedParagraph || !currentStyle) return <p>단락을 클릭하세요</p>;

  return (
    <div>
      <span>Font: {currentStyle.textStyle.fontFamily}</span>
      <span>Size: {currentStyle.textStyle.fontSize}mm</span>
      <button onClick={() => blurParagraph()}>Blur</button>
    </div>
  );
}

function ParagraphList({ paragraphs }: { paragraphs: LayoutParagraphElement[] }) {
  const { focusParagraph, selection } = useEditManager();
  return (
    <>
      {paragraphs.map((p) => (
        <button key={p.id} onClick={() => focusParagraph(p, { cursorOffset: 0 })}>
          {p.id}
        </button>
      ))}
      <pre>{JSON.stringify(selection, null, 2)}</pre>
    </>
  );
}
```

#### 예제: 레이아웃 선택 패널

```tsx
function SelectionInspector() {
  const { selectedLayouts, selectedLayoutIds, clearLayoutSelection } =
    useEditManager({
      onLayoutSelectionChange: (e) => {
        console.log('now selected:', e.selectedLayouts?.length);
      },
    });

  return (
    <div>
      <p>Selected: {selectedLayoutIds.join(', ')}</p>
      <button onClick={clearLayoutSelection}>Clear</button>
    </div>
  );
}
```

---

### `useLayoutElement`

Custom Element 인스턴스 ref를 생성하고 `customElements.define`을 한 번만 실행하도록
보장하는 내부용 훅. **대부분의 경우 직접 사용할 일은 없으며**, 커스텀 wrapper 컴포넌트를
만들 때 사용합니다.

```tsx
import { useLayoutElement } from 'layout-element/react';
import type { UseLayoutElementReturn } from 'layout-element/react';

const { ref, define } = useLayoutElement<MyElement>();
```

#### 반환값: `UseLayoutElementReturn<T>`

| 필드 | 타입 | 설명 |
|---|---|---|
| `ref` | `RefObject<T \| null>` | DOM에 부착될 요소 ref. |
| `define` | `(name: string, constructor: Constructor<T>) => void` | 한 번만 `customElements.define` 실행. |

#### 내부 동작

- `define`은 `useCallback`으로 메모이즈되며, `customElements.get(name)`이 falsy일 때만
  `customElements.define`을 호출 (중복 정의 방지).
- ref는 unmount 시 null로 클리어됨.

#### 예제: 커스텀 wrapper 컴포넌트

```tsx
import { forwardRef, useEffect } from 'react';
import { useLayoutElement } from 'layout-element/react';

class MyBoxElement extends HTMLElement { /* ... */ }
customElements.define('my-box', MyBoxElement);

interface MyBoxProps { data: BoxData; }

export const MyBox = forwardRef<MyBoxElement, MyBoxProps>(
  function MyBox({ data }, ref) {
    const { ref: innerRef, define } = useLayoutElement<MyBoxElement>();
    useEffect(() => {
      define('my-box', MyBoxElement);
    }, [define]);

    useEffect(() => {
      if (innerRef.current) (innerRef.current as any).data = data;
    }, [innerRef, data]);

    useEffect(() => {
      if (typeof ref === 'function') ref(innerRef.current);
      else if (ref) ref.current = innerRef.current;
    }, [ref, innerRef]);

    return <my-box ref={innerRef} />;
  },
);
```

---

### `useEditableText`

`<x-layout-paragraph>` ref에 대해 `editableText` 상태를 토글하는 작은 헬퍼 훅.
`useEffect` 클린업에서 `false`로 자동 리셋.

```tsx
import { useEditableText } from 'layout-element/react';
import type { UseEditableTextOptions } from 'layout-element/react';

const paragraphRef = useRef<LayoutParagraphElement>(null);
useEditableText({ ref: paragraphRef, editableText: true });
```

#### 옵션: `UseEditableTextOptions`

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `ref` | `RefObject<LayoutParagraphElement \| null>` | **필수** | 단락 ref. |
| `editableText` | `boolean` | **필수** | 편집 모드. |

#### 예제

```tsx
function EditableParagraph({ data }: { data: ParagraphData }) {
  const ref = useRef<LayoutParagraphElement>(null);
  useEditableText({ ref, editableText: true });

  return <LayoutParagraph ref={ref} data={data} />;
}
```

> 일반적으로 `useEditableText`보다 `EditManager.focusParagraph()`를 권장합니다.
> 매니저가 포커스, 선택, 이벤트, IME 등을 모두 통합 관리합니다.

---

## 타입 재노출

`layout-element/react`는 바닐라 API의 모든 타입을 다시 export합니다. 엔진 클래스(`DocumentEngine`, `BoxEngine`, `ParagraphEngine`, `ImageEngine`, `TableEngine`, `GridCalculatorEngine`, `FontLoaderEngineImpl`, `ColorRegistryEngineImpl`)도 `layout-element/react`에서 재노출되어 바닐라 진입점과 동일하게 import할 수 있습니다.

```ts
// Components
export type {
  LayoutDocumentElement, LayoutBoxElement, LayoutParagraphElement,
  LayoutImageElement, LayoutGuideColumnElement, LayoutColumnElement,
  LayoutCursorElement, LayoutSelectionElement,
};

// Core
export type { GridCalculatorEngine, ParagraphEngine, Rect };

// Resource
export type { ColorRegistry, FontLoader, ColorLoaderFn, FontLoaderFn };

// Edit
export type {
  EditManager, EditManagerEvent, EditManagerEventType, EditManagerEventListener,
  LayoutElement,
  TextEditController, TextEditCoordinateMapper, CurrentStyle,
  InsertController, LayoutEditController,
};

// Layout types
export type {
  DocumentData, BoxData, ParagraphData, TextData, ImageData, GuideColumnData,
  TextBlockData, TextPartData, TextLineData, OverlapParts,
  BoxPosition, BoxBorderStyle, BoxRole,
};

// Style types
export type {
  TextStyle, ParagraphStyle, TextBlockStyle, InheritStyle,
  TextAlign, VerticalAlign,
};

// Print types
export type {
  PrintPostData, PrintPostDataRect, ColorMap,
  RGBColor, CMYKColor, CMYKColorSet,
};

// Edit types
export type {
  CursorPosition, SelectionRange, InsertMode, InsertEventDetail, InsertType, InsertPosition,
};

// Constants
export {
  DEFAULT_BORDER_STYLE, DEFAULT_FONT_SIZE, DEFAULT_FONT_STYLE, DEFAULT_FONT_WEIGHT,
  DEFAULT_LINE_GAP, DEFAULT_PPM, DEFAULT_IMAGE_DPI, DEFAULT_SPACE_RATIO,
  DEFAULT_LETTER_SPACING, DEFAULT_WIDTH_RATIO, DEFAULT_TEXT_ALIGN, DEFAULT_VERTICAL_ALIGN,
  Z_INDEX_MAX_LAYOUT, Z_INDEX_RESIZE_HANDLE, Z_INDEX_TYPE_LABEL,
  Z_INDEX_INSERT_PREVIEW, Z_INDEX_AI_PROCESSING, Z_INDEX_TEXTAREA,
  Z_INDEX_ROLE_AD, Z_INDEX_ROLE_HEADER,
};

// Utils (`@/utils`를 `export *`로 재노출)
export {
  checkOverlap, computeOverlapSizeMm, mergeOverlapParts, genUUID,
  createAiProcessingOverlay, setAiProcessingActive, isAiProcessingActive, removeAiProcessingOverlay,
};
```

> 위 트리는 단순화된 형태입니다. 정확한 export 목록은 패키지 진입점
> (`src/react/index.ts`)을 참고하세요. `@/utils`의 모든 export가
> `export *`로 재노출되지만, `genRandom`은 `utils/index.ts`에서
> export되지 않아 포함되지 않습니다.

---

## 전체 예제

### 신문 1면 + 편집기

```tsx
import {
  LayoutProvider, useLayoutContext,
  LayoutDocument, LayoutBox, LayoutParagraph, LayoutImage,
  useEditManager,
} from 'layout-element/react';
import { exampleData, type DocumentData } from 'layout-element';
import { useState } from 'react';

export function App() {
  return (
    <LayoutProvider>
      <EditorShell />
    </LayoutProvider>
  );
}

function EditorShell() {
  const { ready, error } = useLayoutContext();
  const [data, setData] = useState<DocumentData>(exampleData);

  if (error) return <div>Error: {error.message}</div>;
  if (!ready) return <div>Loading...</div>;

  return (
    <div style={{ display: 'flex' }}>
      <LayoutDocument
        data={data}
        onRenderError={(e) => console.warn('overflow', e.detail)}
      />
      <Toolbar onChange={setData} />
    </div>
  );
}

function Toolbar({ onChange }: { onChange: (d: DocumentData) => void }) {
  const {
    focusedParagraph, currentStyle, cursorOffset, selection,
    selectedLayouts,
    focusParagraph, blurParagraph, selectLayout, clearLayoutSelection,
  } = useEditManager({
    onTextChange: (e) => {
      const paragraph = e.paragraph;
      onChange((prev) => ({
        ...prev,
        children: prev.children?.map((box) =>
          box.id === paragraph.parentElement?.id
            ? { ...box, children: [(box.children?.[0] as any) ?? null].filter(Boolean) }
            : box,
        ),
      }));
    },
  });

  return (
    <aside style={{ width: 280, padding: 12, background: '#f5f5f5' }}>
      <h3>Toolbar</h3>

      <section>
        <h4>Focus</h4>
        {focusedParagraph
          ? (
            <>
              <p>Paragraph: {focusedParagraph.id}</p>
              <p>Offset: {cursorOffset}</p>
              <p>Font: {currentStyle?.textStyle.fontFamily}</p>
              <button onClick={() => blurParagraph()}>Blur</button>
            </>
          )
          : <p>No focus</p>}
      </section>

      <section>
        <h4>Selection</h4>
        {selection
          ? <pre>{JSON.stringify(selection.normalized(), null, 2)}</pre>
          : <p>No selection</p>}
      </section>

      <section>
        <h4>Layout</h4>
        <button onClick={() => clearLayoutSelection()}>Clear</button>
        <p>Selected: {selectedLayouts.map((b) => b.id).join(', ') || '-'}</p>
      </section>
    </aside>
  );
}
```

### 데이터 동적 변경 + 컬럼 조정

```tsx
import { useState, useEffect } from 'react';
import { LayoutDocument, LayoutBox, LayoutParagraph } from 'layout-element/react';
import type { DocumentData } from 'layout-element';

function DynamicNewspaper() {
  const [columns, setColumns] = useState(5);
  const [data, setData] = useState<DocumentData>({
    width: 210, height: 297,
    columns: 5, gap: 3,
    paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10,
    paragraphStyle: { lineGap: 1.2, textAlign: 'justify' },
    textStyle: { fontFamily: 'Myoungjo', fontSize: 4, color: 'black' },
    children: [],
  });

  useEffect(() => {
    setData((d) => ({ ...d, columns }));
  }, [columns]);

  return (
    <>
      <input
        type="range" min={2} max={10} value={columns}
        onChange={(e) => setColumns(+e.target.value)}
      />
      <LayoutDocument
        data={data}
        columns={columns}
        gap={3}
        onInnerSizeChange={(w, h) => console.log('inner:', w, h)}
      />
    </>
  );
}
```

### 인쇄 모드 진입

```tsx
import { LayoutProvider, LayoutDocument } from 'layout-element/react';
import type { CMYKColorSet, Font } from 'layout-element';

const printColors: CMYKColorSet = {
  black: { c: 0, m: 0, y: 0, k: 255 },
  red:   { c: 0, m: 255, y: 255, k: 0 },
};

const printFonts: Font[] = [
  // base64 인코딩된 TTF 데이터
];

function PrintView({ documentData }: { documentData: DocumentData }) {
  return (
    <LayoutProvider colorSet={printColors} fonts={printFonts}>
      <LayoutDocument data={documentData} />
    </LayoutProvider>
  );
}
```

### ref로 직접 접근

```tsx
import { useRef, useEffect } from 'react';
import {
  LayoutDocument, LayoutBox, LayoutParagraph,
} from 'layout-element/react';
import type {
  LayoutDocumentElement, LayoutBoxElement, LayoutParagraphElement,
} from 'layout-element';

function WithRefs() {
  const docRef = useRef<LayoutDocumentElement>(null);
  const boxRef = useRef<LayoutBoxElement>(null);
  const paragraphRef = useRef<LayoutParagraphElement>(null);

  useEffect(() => {
    console.log(docRef.current?.model?.columnCoords);
    console.log(boxRef.current?.absWidth);
    console.log(paragraphRef.current?.columnEl);
  }, []);

  return (
    <LayoutDocument ref={docRef} data={exampleData}>
      <LayoutBox ref={boxRef} data={{ type: 'box', left: 0, top: 0, width: 3, height: 12 }}>
        <LayoutParagraph
          ref={paragraphRef}
          data={{ type: 'paragraph', content: 'Hello' }}
        />
      </LayoutBox>
    </LayoutDocument>
  );
}
```

---

## React ↔ Vanilla 매핑

| React API | Vanilla JS 대응 |
|---|---|
| `<LayoutDocument>` | `<x-layout-document>` (LayoutDocumentElement) |
| `<LayoutBox>` | `<x-layout-box>` (LayoutBoxElement) |
| `<LayoutParagraph>` | `<x-layout-paragraph>` (LayoutParagraphElement) |
| `<LayoutImage>` | `<x-layout-image>` (LayoutImageElement) |
| `<LayoutGuideColumn>` | `<x-layout-guide-column>` (LayoutGuideColumnElement) |
| `<Logo>` | (대응 없음 — React 전용 순수 SVG 컴포넌트) |
| `LayoutProvider` | `ColorRegistry.init()` + `FontLoader.init()` |
| `useLayoutContext` | `ColorRegistry.getInstance()` + `FontLoader.getInstance()` 직접 접근 |
| `useEditManager` | `layoutDocEl.editManager.addEventListener(...)` |
| `useLayoutElement` | `customElements.define` (보통 자동) |
| `useEditableText` | `element.editableText = true` 직접 |

---

## 주의사항

1. **JSX Intrinsic Elements**: `globals.d.ts`가 `<x-layout-document>` 등 7개 태그를
   `DetailedHTMLProps`로 등록합니다. `data` 속성과 `role`/`groupMember`/`priority`/
   `lock`/`onTextOverflow`가 자동 인식됩니다. wrapper 컴포넌트(`<LayoutDocument>`)를
   사용하면 이런 한계를 우회할 수 있습니다.

2. **forwardRef**: 모든 wrapper는 `forwardRef`로 작성되어 `ref` prop을 지원합니다.

3. **effect 의존성**: 각 prop은 자체 `useEffect`에 의해 동기화되므로, prop이 같으면
   setter가 호출되지 않습니다 (strict equality).

4. **useLayoutElement의 define**: SSR 환경에서는 `customElements`가 없을 수 있어
   try/catch가 필요할 수 있습니다.

5. **데이터 동기화 트랩**: `data` prop을 매 렌더마다 새 객체로 전달하면 setter가
   항상 호출되어 자식 트리가 재구축됩니다. 안정 참조를 유지하세요.

6. **children vs data.children**: `<LayoutDocument>`에 `data`로 트리를 주입할 때
   children prop도 같이 주면 안 됩니다. 한 가지 경로만 사용하세요.

7. **인쇄 모드**: `LayoutProvider`에 `colorSet`/`fonts`를 주입하면 자동으로 인쇄 모드로
   동작합니다.

8. **React 19+ 호환성**: 컴포넌트는 React 18+ 환경에서 동작합니다. React 19의
   `use()` hook, ref-as-prop 변경 등은 forwardRef 패턴과 호환됩니다.
