import type {
  DocumentData,
  BoxData,
  ParagraphData,
  TextData,
  ImageData,
  TableData,
} from "@/types";

/**
 * 배치 반전 축.
 * - `'horizontal'`: 좌우 반전 (X축 기준 대칭).
 * - `'vertical'`: 상하 반전 (Y축 기준 대칭).
 * - `'both'`: 상하 + 좌우 동시 반전 (180도 회전과 동일).
 */
export type FlipAxis = 'horizontal' | 'vertical' | 'both';

/**
 * {@link flipLayoutData} 옵션.
 */
export type FlipLayoutOptions = {
  /**
   * 반전 축.
   */
  axis: FlipAxis;

  /**
   * 반전 root 박스의 `id`.
   * 지정된 경우 해당 `id`를 가진 Box가 root가 되며, **그 Box의 하위 요소들만** 반전한다.
   * root 박스 자체(위치/보더/패딩)는 반전하지 않는다.
   * 생략 시 문서(document)가 root이며, 문서의 하위 박스들만 반전한다.
   */
  targetId?: string;
};

/**
 * 각 박스 id별 실제 mm 크기 정보.
 *
 * static 박스의 `width`/`height`는 컬럼 span 수 / 라인 수이지 mm가 아니므로,
 * absolute 자식 반전 시 부모 박스의 mm 내부 영역을 알기 위해 외부에서 주입해야 한다.
 * `LayoutDocumentElement.flipLayout()`이 DOM에서 `absWidth`/`absHeight`를 수집하여 전달한다.
 *
 * @internal
 */
export type BoxMetricsById = Map<string, { absWidth: number; absHeight: number }>;

/**
 * `number | number[]` 형태의 단 설정 배열을 좌우 반전한다.
 * - `number` (균등): 대칭이므로 그대로 유지.
 * - `number[]` (개별): 배열을 역순으로 뒤집는다.
 * - `undefined`: 그대로.
 *
 * `columns`와 `gap` 모두에 사용된다.
 *
 * @param value - 원본 단 설정
 * @returns 반전된 단 설정
 *
 * @internal
 */
function flipNumberArray(value: number | number[]): number | number[];
function flipNumberArray(value: number | number[] | undefined): number | number[] | undefined;
function flipNumberArray(value: number | number[] | undefined): number | number[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  return [...value].reverse();
}

/**
 * 박스의 방향별 보더 속성을 상하/좌우 교환한다.
 *
 * @param data - 반전할 박스 데이터 (원본을 변경하지 않고 새 객체 반환)
 * @param axis - 반전 축
 * @returns 보더 방향이 교환된 새 박스 데이터
 *
 * @internal
 */
function flipBoxBorders<T extends BoxData>(data: T, axis: FlipAxis): T {
  const result = { ...data };

  if (axis === 'horizontal' || axis === 'both') {
    const tmp = result.borderLeftWidth;
    result.borderLeftWidth = result.borderRightWidth;
    result.borderRightWidth = tmp;
  }

  if (axis === 'vertical' || axis === 'both') {
    const tmp = result.borderTopWidth;
    result.borderTopWidth = result.borderBottomWidth;
    result.borderBottomWidth = tmp;
  }

  return result;
}

/**
 * 박스의 방향별 패딩 속성을 상하/좌우 교환한다.
 *
 * @param data - 반전할 박스 데이터 (원본을 변경하지 않고 새 객체 반환)
 * @param axis - 반전 축
 * @returns 패딩 방향이 교환된 새 박스 데이터
 *
 * @internal
 */
function flipBoxPadding<T extends BoxData>(data: T, axis: FlipAxis): T {
  const result = { ...data };

  if (axis === 'horizontal' || axis === 'both') {
    const tmp = result.paddingLeft;
    result.paddingLeft = result.paddingRight;
    result.paddingRight = tmp;
  }

  if (axis === 'vertical' || axis === 'both') {
    const tmp = result.paddingTop;
    result.paddingTop = result.paddingBottom;
    result.paddingBottom = tmp;
  }

  return result;
}

/**
 * 컨테이너의 메트릭 정보.
 *
 * absolute 박스의 `left`/`top` 좌표 기준이 부모 컨테이너 종류에 따라 다르다:
 * - 부모가 **document**: `inheritStyle.paddingLeft`가 전달되지 않으므로
 *   자식 absolute 박스의 `left`는 **문서 전체 기준(padding 포함)**이다.
 *   → 반전 시 `width - left - width` 사용.
 * - 부모가 **box**: `inheritStyle.paddingLeft`가 전달되므로
 *   자식 absolute 박스의 `left`는 **부모 padding 내부 기준**이다.
 *   → 반전 시 `innerWidth - left - width` 사용.
 *
 * static 박스의 `width`/`height`는 컬럼 span 수 / 라인 수이므로,
 * `absWidth`/`absHeight`는 외부에서 주입받은 mm 값(`BoxMetricsById`)에서 가져온다.
 *
 * @internal
 */
interface ContainerMetrics {
  /** 컬럼 수 (static 자식 반전용) */
  columns: number;
  /** 라인 수 (static 자식 반전용) */
  heightLines: number;
  /** padding 제외 내부 너비 mm (box 부모일 때 absolute 자식 반전용) */
  innerWidth: number;
  /** padding 제외 내부 높이 mm (box 부모일 때 absolute 자식 반전용) */
  innerHeight: number;
  /** padding 포함 전체 너비 mm (document 부모일 때 absolute 자식 반전용) */
  width: number;
  /** padding 포함 전체 높이 mm (document 부모일 때 absolute 자식 반전용) */
  height: number;
  /** 부모가 document이면 true, box이면 false */
  isDocument: boolean;
}

/**
 * DocumentData에서 컨테이너 메트릭을 추출한다.
 *
 * @param data - 문서 데이터
 * @returns 컨테이너 메트릭
 *
 * @internal
 */
function documentMetrics(data: DocumentData): ContainerMetrics {
  const columns =
    typeof data.columns === 'number' ? data.columns : data.columns.length;
  const innerWidth = data.width - (data.paddingLeft ?? 0) - (data.paddingRight ?? 0);
  const innerHeight = data.height - (data.paddingTop ?? 0) - (data.paddingBottom ?? 0);
  const fontSize = data.textStyle?.fontSize ?? 4;
  const lineGap = data.paragraphStyle?.lineGap ?? 1.25;
  const lineHeight = fontSize * lineGap;
  const heightLines = innerHeight / lineHeight;
  return {
    columns,
    heightLines,
    innerWidth,
    innerHeight,
    width: data.width,
    height: data.height,
    isDocument: true,
  };
}

/**
 * BoxData에서 컨테이너 메트릭을 추출한다.
 *
 * static 박스의 mm 크기는 `BoxMetricsById`에서 조회한다.
 * absolute 박스는 `width`/`height`가 곧 mm 크기이다.
 *
 * @param box - 박스 데이터
 * @param metricsById - 각 박스 id별 mm 크기 map
 * @returns 컨테이너 메트릭
 *
 * @internal
 */
function boxMetrics(box: BoxData, metricsById: BoxMetricsById): ContainerMetrics {
  if (box.position === 'absolute') {
    return {
      columns: box.width,
      heightLines: box.height,
      innerWidth: box.width - (box.paddingLeft ?? 0) - (box.paddingRight ?? 0),
      innerHeight: box.height - (box.paddingTop ?? 0) - (box.paddingBottom ?? 0),
      width: box.width,
      height: box.height,
      isDocument: false,
    };
  }

  const injected = box.id ? metricsById.get(box.id) : undefined;
  const absWidth = injected?.absWidth ?? box.width;
  const absHeight = injected?.absHeight ?? box.height;
  return {
    columns: box.width,
    heightLines: box.height,
    innerWidth: absWidth - (box.paddingLeft ?? 0) - (box.paddingRight ?? 0),
    innerHeight: absHeight - (box.paddingTop ?? 0) - (box.paddingBottom ?? 0),
    width: absWidth,
    height: absHeight,
    isDocument: false,
  };
}

/**
 * 단일 BoxData를 반전한다.
 *
 * `position` 값에 따라 좌표 반전 방식이 다르다:
 * - `'static'`: `left`는 컬럼 인덱스, `width`는 컬럼 span 수.
 *   - 좌우 반전: `left = columnCount - left - width`
 *   - 상하 반전: `top = totalLines - top - height`
 * - `'absolute'`: `left`/`top`/`width`/`height` 모두 mm 단위.
 *   - document 부모: `left = containerWidth - left - width` (padding 포함 전체)
 *   - box 부모: `left = innerWidth - left - width` (padding 제외)
 *
 * 보더/패딩 방향도 함께 교환한다.
 * 자식도 재귀적으로 반전한다.
 *
 * `box.lock === true`이면 해당 박스와 그 **하위 요소 전체**를 반전에서 제외하고
 * 원본 그대로 반환한다. 조상 box 중 하나라도 lock이면 하위 전부에 적용되므로,
 * 이 함수는 lock 박스를 만나는 즉시 원본을 반환한다.
 *
 * @param box - 반전할 박스 데이터
 * @param axis - 반전 축
 * @param container - 부모 컨테이너 메트릭
 * @param metricsById - 각 박스 id별 mm 크기 map
 * @returns 반전된 새 박스 데이터 (lock 박스는 원본 그대로)
 *
 * @internal
 */
function flipBox(
  box: BoxData,
  axis: FlipAxis,
  container: ContainerMetrics,
  metricsById: BoxMetricsById,
): BoxData {
  if (box.lock) return box;

  let result = { ...box };

  if (result.position === 'absolute') {
    const refWidth = container.isDocument ? container.width : container.innerWidth;
    const refHeight = container.isDocument ? container.height : container.innerHeight;
    if (axis === 'horizontal' || axis === 'both') {
      result.left = refWidth - result.left - result.width;
    }
    if (axis === 'vertical' || axis === 'both') {
      result.top = refHeight - result.top - result.height;
    }
  } else {
    if (axis === 'horizontal' || axis === 'both') {
      result.left = container.columns - result.left - result.width;
    }
    if (axis === 'vertical' || axis === 'both') {
      result.top = container.heightLines - result.top - result.height;
    }
  }

  result = flipBoxBorders(result, axis);
  result = flipBoxPadding(result, axis);

  const childContainer = boxMetrics(result, metricsById);
  result.children = flipChildren(result.children, axis, childContainer, metricsById);

  return result;
}

/**
 * BoxData의 children을 재귀적으로 반전한다.
 *
 * @param children - 원본 children
 * @param axis - 반전 축
 * @param container - 부모 박스의 컨테이너 메트릭
 * @param metricsById - 각 박스 id별 mm 크기 map
 * @returns 반전된 children
 *
 * @internal
 */
function flipChildren(
  children: BoxData[] | ParagraphData | TextData | ImageData | TableData | undefined,
  axis: FlipAxis,
  container: ContainerMetrics,
  metricsById: BoxMetricsById,
): BoxData[] | ParagraphData | TextData | ImageData | TableData | undefined {
  if (children === undefined) return undefined;

  if (Array.isArray(children)) {
    return children.map((child) => flipBox(child, axis, container, metricsById));
  }

  if (children.type === 'paragraph') {
    return flipParagraph(children as ParagraphData, axis);
  }

  return children;
}

/**
 * ParagraphData의 단 설정(column/gap)을 좌우 반전한다.
 *
 * @param para - 원본 문단 데이터
 * @param axis - 반전 축
 * @returns 단 설정이 반전된 새 문단 데이터
 *
 * @internal
 */
function flipParagraph(para: ParagraphData, axis: FlipAxis): ParagraphData {
  if (axis !== 'horizontal' && axis !== 'both') {
    return para;
  }

  const result = { ...para };
  result.column = flipNumberArray(result.column);
  result.gap = flipNumberArray(result.gap);
  return result;
}

/**
 * 트리에서 `targetId`를 가진 박스를 찾아 **그 박스의 하위 요소들만** 반전한다.
 *
 * `box.lock === true`이면 해당 박스와 하위 전체를 반전에서 제외하고
 * 원본 그대로 반환한다. lock 박스가 `targetId`와 일치하더라도
 * 하위 요소는 반전되지 않는다.
 *
 * @param box - 순회 중인 박스
 * @param targetId - 반전 root 박스 id
 * @param axis - 반전 축
 * @param container - 현재 컨테이너 메트릭
 * @param metricsById - 각 박스 id별 mm 크기 map
 * @returns root 박스의 하위 요소들만 반전된 새 박스 (lock 박스는 원본 그대로)
 *
 * @internal
 */
function flipBoxIfTarget(
  box: BoxData,
  targetId: string,
  axis: FlipAxis,
  _container: ContainerMetrics,
  metricsById: BoxMetricsById,
): BoxData {
  if (box.lock) return box;

  if (box.id === targetId) {
    const result = { ...box };
    const childContainer = boxMetrics(result, metricsById);
    result.children = flipChildren(result.children, axis, childContainer, metricsById);
    return result;
  }

  const result = { ...box };
  const childContainer = boxMetrics(result, metricsById);
  result.children = flipChildrenIfTarget(result.children, targetId, axis, childContainer, metricsById);
  return result;
}

/**
 * BoxData children 중 `targetId`를 가진 박스를 재귀적으로 찾아 하위 요소를 반전한다.
 *
 * @param children - 순회 중인 children
 * @param targetId - 반전 root 박스 id
 * @param axis - 반전 축
 * @param container - 부모 박스의 컨테이너 메트릭
 * @param metricsById - 각 박스 id별 mm 크기 map
 * @returns root 박스의 하위 요소들만 반전된 children
 *
 * @internal
 */
function flipChildrenIfTarget(
  children: BoxData[] | ParagraphData | TextData | ImageData | TableData | undefined,
  targetId: string,
  axis: FlipAxis,
  container: ContainerMetrics,
  metricsById: BoxMetricsById,
): BoxData[] | ParagraphData | TextData | ImageData | TableData | undefined {
  if (children === undefined) return undefined;

  if (Array.isArray(children)) {
    return children.map((child) => flipBoxIfTarget(child, targetId, axis, container, metricsById));
  }

  return children;
}

/**
 * 문서 레이아웃 데이터의 배치를 좌우/상하/상하좌우 반전한다.
 *
 * 순수 함수: 입력 데이터 트리를 변환하여 새 트리를 반환한다. 원본은 변경하지 않는다.
 *
 * `targetId`가 지정된 경우 해당 `id`를 가진 박스가 **root**가 되며,
 * **root 박스의 하위 요소들만** 반전한다. root 박스 자체(위치/보더/패딩)는 유지된다.
 *
 * `targetId`를 생략하면 문서(document)가 root이며, 문서의 하위 박스들만 반전한다.
 *
 * ## 반전 범위 (root의 하위 요소)
 *
 * - **Box 위치/크기**: `position` 모드에 따라 좌표 변환
 *   - `static`: `left = columnCount - left - width`, `top = totalLines - top - height`
 *   - `absolute`: 부모가 document면 `left = containerWidth - left - width` (padding 포함),
 *     부모가 box면 `left = innerWidth - left - width` (padding 제외)
 * - **Box 보더/패딩 방향**: 상하/좌우 교환
 * - **Paragraph 단 설정**: `column`/`gap` 배열 역순 (좌우 반전 시)
 * - **하위 Box 트리**: 재귀적으로 전체 추적
 *
 * ## 반전 제외 (lock 박스)
 *
 * - **Box `lock`**: `box.lock === true`인 박스와 그 **하위 요소 전체**는 반전에서 제외된다.
 *   조상 박스 중 하나라도 lock이면 하위 전부가 제외된다.
 *   lock 박스의 위치/크기/보더/패딩/자식 모두 원본 그대로 유지된다.
 *
 * ## 반전 제외 (leaf 컨텐츠)
 *
 * - **Image**: 내부 설정은 반전하지 않음
 * - **Table**: 셀 배치/순서/병합/보더 방향은 반전하지 않음
 * - **Text content**: LTR 유지, 거울 모드 아님
 *
 * ## metricsById 파라미터
 *
 * static 박스의 `width`/`height`는 컬럼 span 수 / 라인 수이지 mm가 아니다.
 * 따라서 absolute 자식 반전 시 부모 박스의 mm 내부 영역을 알기 위해
 * 각 박스 id별 실제 mm 크기(`absWidth`/`absHeight`)를 외부에서 주입해야 한다.
 * `LayoutDocumentElement.flipLayout()`이 DOM에서 수집하여 전달한다.
 *
 * @param data - 원본 문서 데이터
 * @param options - 반전 옵션
 * @param options.axis - 반전 축
 * @param options.targetId - 반전 root 박스 id. 생략 시 문서가 root.
 * @param metricsById - 각 박스 id별 mm 크기 map. static 박스의 absolute 자식 반전에 필요.
 * @returns 반전된 새 문서 데이터
 * @throws {Error} `targetId`가 지정되었으나 트리에서 해당 id를 가진 박스를 찾지 못한 경우
 *
 * @example
 * ```ts
 * // 문서의 하위 박스들을 좌우 반전
 * const flipped = flipLayoutData(doc, { axis: 'horizontal' }, metricsById);
 * documentEl.data = flipped;
 *
 * // 특정 박스의 하위 요소들만 상하 반전
 * const flipped = flipLayoutData(doc, { axis: 'vertical', targetId: 'box-42' }, metricsById);
 * documentEl.data = flipped;
 * ```
 */
export function flipLayoutData(
  data: DocumentData,
  options: FlipLayoutOptions,
  metricsById: BoxMetricsById,
): DocumentData {
  const { axis, targetId } = options;
  const result: DocumentData = { ...data };
  const container = documentMetrics(result);

  const children = result.children ?? [];
  if (targetId === undefined) {
    result.children = children.map((box) => flipBox(box, axis, container, metricsById));
  } else {
    let found = false;
    const newChildren = children.map((box) => {
      const flipped = flipBoxIfTarget(box, targetId, axis, container, metricsById);
      if (flipped !== box) found = true;
      return flipped;
    });

    if (!found) {
      throw new Error(
        `flipLayoutData: targetId "${targetId}"를 가진 박스를 찾을 수 없습니다.`,
      );
    }
    result.children = newChildren;
  }

  return result;
}