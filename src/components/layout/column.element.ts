import { LayoutParagraphElement } from "./paragraph.element";
import { ColorRegistry } from "@/resource";
import type { TextLineData, TextPartData } from "@/types/layout/text/text-line.type";
import type { TextInlineStyle } from "@/types/style/text-inline-style.type";

const HOST_STYLE_ID = '__layout_host_style__';

/**
 * 인라인 스타일의 변경 감지용 키. 정의된 필드만 `key=value`로 직렬화한다.
 * `undefined`/빈 스타일은 `''`로 정규화하여 "주입 없음" 상태도 비교 가능하게 한다.
 *
 * @param style - 직렬화할 인라인 스타일 (선택)
 * @returns 변경 감지용 키 문자열
 * @throws 없음
 * @example
 * ```ts
 * _inlineStyleKey({ fontWeight: 700 });            // → "fontWeight=700"
 * _inlineStyleKey({ fontSize: 7, color: 'red' });  // → "fontSize=7|color=red"
 * _inlineStyleKey(undefined);                      // → ""
 * ```
 */
function _inlineStyleKey(style: TextInlineStyle | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.fontFamily !== undefined) parts.push(`fontFamily=${style.fontFamily}`);
  if (style.fontSize !== undefined) parts.push(`fontSize=${style.fontSize}`);
  if (style.fontWeight !== undefined) parts.push(`fontWeight=${style.fontWeight}`);
  if (style.fontStyle !== undefined) parts.push(`fontStyle=${style.fontStyle}`);
  if (style.color !== undefined) parts.push(`color=${style.color}`);
  return parts.join('|');
}

/**
 * 치수(width/height/top)에 영향을 주는 인라인 필드만 직렬화한 키.
 * `fontFamily`/`fontSize`만 포함 — `fontWeight`/`fontStyle`/`color`는
 * `genCharStyleFlat`의 치수 계산에 무영향이므로 델타 판별에서 제외한다.
 *
 * @param style - 직렬화할 인라인 스타일 (선택)
 * @returns 치수 영향 필드 키. fontWeight 등만 변경 시 기존 키와 동일
 */
function _dimensionKey(style: TextInlineStyle | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.fontFamily !== undefined) parts.push(`fontFamily=${style.fontFamily}`);
  if (style.fontSize !== undefined) parts.push(`fontSize=${style.fontSize}`);
  return parts.join('|');
}

/**
 * inlineKey 변경이 "치수 무영향 필드의 값 변경/추가"인지 검사한다.
 * 오버라이드 **제거**(정의 필드 감소)는 기존 style 속성이 잔존하므로
 * full 재적용이 필요하다. 이 함수는 그 안전 판정을 제공한다.
 *
 * @param prevKey - 이전 인라인 키 (`_inlineStyleKey` 직렬화)
 * @param nextKey - 새 인라인 키
 * @returns 안전하면 true (inline-only 모드 사용 가능)
 *
 * @example
 * ```ts
 * _isNonDestructiveInlineDelta('fontSize=5', 'fontSize=5|fontWeight=700'); // → true (추가)
 * _isNonDestructiveInlineDelta('fontSize=5|fontWeight=700', 'fontSize=5');  // → false (제거 → full)
 * _isNonDestructiveInlineDelta('fontWeight=400', 'fontWeight=700');        // → true (값 변경)
 * ```
 */
function _isNonDestructiveInlineDelta(prevKey: string, nextKey: string): boolean {
  if (prevKey === '') return true;
  const prevFields = new Set(prevKey.split('|').map(f => f.split('=')[0]));
  const nextFields = new Set(nextKey.split('|').map(f => f.split('=')[0]));
  for (const field of prevFields) {
    if (!nextFields.has(field)) return false;
  }
  return true;
}

/**
 * 텍스트 컬럼 렌더링 요소. `<x-layout-column>` 커스텀 엘리먼트.
 *
 * `TextLayoutEngine`에서 생성된 `TextLineData[]`를 받아 각 줄을 렌더링한다.
 * `LayoutParagraphElement.renderText()`에서 동적으로 생성된다.
 */
export class LayoutColumnElement extends HTMLElement {
  private _index?: number;
  private _shadowRoot: ShadowRoot;
  private _cachedColStyleKey: string = '';
  /** 직전 renderText에서 실제 스타일이 재적용된 span 수 (postRender 지연 판정용). */
  private _lastRestyledCount: number = 0;

  constructor() {
    super();

    this._index = this.getAttribute("index") ? parseInt(this.getAttribute("index")!, 10) : undefined;
    this._shadowRoot = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this._cachedColStyleKey = '';
    this.renderText();
  }

  disconnectedCallback() { }

  attributeChangedCallback(name: string, oldval: string | null, newval: string | null) {
    if (name === 'index' && oldval !== newval) {
      this.index = newval ? parseInt(newval, 10) : undefined;
    }
  }

  /**
   * 성능 최적화: 소스 오프셋 계산. diff 렌더링에서 기존 span 재사용을 위해
   * 현재 컬럼 이전의 렌더링된 오프셋과 소스 오프셋을 계산한다.
   */
  private _computePerfSourceOffsets(): { renderedOffset: number; sourceOffset: number } {
    let renderedOffset = 0;
    let sourceOffset = 0;
    const model = this.model!;
    for (let c = 0; c < this._index!; c++) {
      const colLines = model.columnContents[c] || [];
      for (const line of colLines) {
        for (let p = 0; p < line.parts.length; p++) {
          const original = line.parts[p].content;
          let content = original;
          if (p === 0) {
            while (content.length > 0 && content[0] === ' ') { sourceOffset++; content = content.slice(1); }
          }
          if (p === line.parts.length - 1) {
            let trailingSpaces = 0;
            for (let i = content.length - 1; i >= 0 && content[i] === ' '; i--) trailingSpaces++;
            sourceOffset += trailingSpaces;
            while (content.length > 0 && content[content.length - 1] === ' ') content = content.slice(0, content.length - 1);
          }
          renderedOffset += content.length;
          sourceOffset += content.length;
        }
        if (line.endOfBlock && sourceOffset < model.plainText.length && model.plainText[sourceOffset] === '\n') sourceOffset++;
      }
    }
    return { renderedOffset, sourceOffset };
  }

  /** 줄의 양 끝 공백을 제거하여 렌더링된 문자열을 정리한다. */
  private _stripSpaces(content: string[], isFirst: boolean, isLast: boolean, firstOfBlock: boolean = false, endOfBlock: boolean = false): string[] {
    let result = content;
    if (isFirst && !firstOfBlock) {
      while (result.length > 0 && result[0] === ' ') { result = result.slice(1); }
    }
    if (isLast && !endOfBlock) {
      while (result.length > 0 && result[result.length - 1] === ' ') { result = result.slice(0, result.length - 1); }
    }
    return result;
  }

  /** 줄(line) DOM 요소를 생성하고 `genLineStyle()`으로 스타일을 적용한다. */
  private _createLineElement(lineIndex: number): HTMLDivElement {
    const lineEl = document.createElement('div');
    this._applyLineStyle(lineEl, lineIndex);
    return lineEl;
  }

  /** 줄 요소에 `genLineStyle()` 결과를 적용하여 기존 스타일을 갱신한다. */
  private _applyLineStyle(lineEl: HTMLDivElement, lineIndex: number): void {
    const curLineStyle = this.model!.genLineStyle(this._index, lineIndex) || {};
    lineEl.style.cssText = '';
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(lineEl.style, curLineStyle);
  }

  /**
   * 줄 요소의 실제 렌더링 높이(mm)를 반환한다.
   * 라인별 높이가 있는 경우(`lineData.lineHeight`) 우선 사용하고,
   * 없으면 DOM 스타일, 최종적으로 `model.baseLineHeight`로 폴백한다.
   * @param lineEl - 높이를 측정할 줄 DOM 요소
   * @param lineData - 해당 라인의 TextLineData (선택)
   * @returns 줄 높이(mm)
   */
  private _getLineHeightMm(lineEl: HTMLDivElement, lineData?: TextLineData): number {
    if (lineData?.lineHeight !== undefined && lineData.lineHeight > 0) {
      return lineData.lineHeight;
    }
    const heightStr = lineEl.style.height;
    if (heightStr) {
      const parsed = parseFloat(heightStr);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return this.model!.baseLineHeight;
  }

  /** 파트(part) DOM 요소를 생성하고 `genPartStyle()` 결과를 적용한다. */
  private _createPartElement(part: TextPartData, lineData: TextLineData, curPartStyle: Record<string, string>, partJustify: string | undefined): HTMLDivElement {
    const partEl = document.createElement('div');
    this._applyPartStyle(partEl, part, lineData, curPartStyle, partJustify);
    return partEl;
  }

  /**
   * 파트 요소에 스타일, 너비, `marginLeft`, `justifyContent`를 적용한다.
   *
   * `part.charOffsets`가 정의되어 있으면 flexbox 정렬을 우회하고
   * `justify-content: flex-start` + `position: relative` + `height: 100%`로 설정하여
   * 각 span이 `position: absolute; left: ${charOffset}mm; top: 0`으로 정확히 배치되도록 한다.
   * `height: 100%`는 absolute 자식이 플로우에서 벗어나 part div가 높이를 잃지 않도록 보장한다.
   * `charOffsets`가 없으면 기존 flexbox `justify-content` 정렬 경로를 유지한다.
   */
  private _applyPartStyle(partEl: HTMLDivElement, part: TextPartData, _lineData: TextLineData, curPartStyle: Record<string, string>, partJustify: string | undefined): void {
    partEl.style.cssText = '';
    const useCharOffsets = part.charOffsets !== undefined;
    const effectiveJustify = useCharOffsets ? 'flex-start' : (partJustify || curPartStyle.justifyContent);
    Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(partEl.style, {
      ...curPartStyle,
      width: `${part.width}mm`,
      marginLeft: `${part.left}mm`,
      justifyContent: effectiveJustify,
      ...(useCharOffsets && { position: 'relative', height: '100%' }),
    });
  }

  /** 글자(span) DOM 요소를 생성하고 `genCharStyle()` 결과와 오프셋 속성을 적용한다. */
  private _createSpanElement(char: string, renderedOffset: number, sourceOffset: number, charOffsetMm: number | undefined, inlineStyle: TextInlineStyle | undefined, lineMaxFontSize: number): HTMLSpanElement {
    const charEl = document.createElement('span');
    this._applySpanStyle(charEl, char, renderedOffset, sourceOffset, charOffsetMm, inlineStyle, lineMaxFontSize);
    return charEl;
  }

  /**
   * 글자 요소에 `genCharStyle()` 스타일, `data-offset`, `data-source-offset`, `innerText`를 적용한다.
   *
   * `inlineStyle`이 제공되면 `genCharStyle`/`getCharWidths`에 전달하여 런별
   * `fontSize`/`fontFamily` 오버라이드가 span 폭에 반영되도록 한다. 이는
   * `_layoutTextIntoColumns`의 줄바꿈 계산(`_charWidthMm(char, inlineStyle)`)과
   * 동일한 폭을 사용하도록 보장한다.
   *
   * `charOffsetMm`가 제공되면(정렬 계산 경로) span에 `position: absolute; left: ${charOffsetMm}mm; top: 0`를
   * 적용하여 부모 파트 기준 절대 좌표로 직접 배치한다. flexbox 자연 위치 연산을 거치지 않으므로
   * 브라우저 렌더링 결과가 계산된 `charOffsets[j]`와 정확히 일치한다.
   * `top: 0`은 수직 정렬을 부모 part div(`alignItems: baseline`이 무시되므로 부모 top 기준)에 맡긴다 —
   * 폰트 메트릭 기반 렌더링에서 span 높이는 `lineHeight`와 일치하므로 top=0이면 시각적으로 올바르다.
   *
   * charOffsets 경로에서는 **단일 span** 구조를 사용한다 — outer/inner 중첩 없이
   * `scale`/`transformOrigin`을 이 span에 직접 적용(`genCharStyleFlat`). absolute 배치이므로
   * outer의 `width`/`textAlign`이 의미 없고, 정렬은 charOffsets가 직접 산출한다.
   * DOM 노드 수 절반, querySelector/inner span 갱신 비용 제거.
   *
   * `charOffsetMm === undefined`이면 레거시 flexbox 정렬 경로를 유지한다 (outer/inner 중첩).
   *
   * @param charEl - 스타일을 적용할 글자 span DOM 요소
   * @param char - 현재 글자
   * @param renderedOffset - 렌더링 오프셋 (data-offset)
   * @param sourceOffset - 소스 오프셋 (data-source-offset)
   * @param charOffsetMm - 절대 정렬 오프셋 (undefined = 레거시 경로)
   * @param inlineStyle - 인라인 런 스타일 오버라이드
   * @param lineMaxFontSize - 이 글자가 속한 라인의 최대 폰트 크기 (mm)
   * @param mode - 델타 적용 모드 (기본값 'full' — 전체 재적용)
   * @throws {Error} `inlineStyle.color`가 `'default'`인 경우 `ColorRegistry.getCSSColor()`가 throw
   *
   * @example
   * ```ts
   * // 전체 적용 (span 신규 생성/구조 변경): mode 생략
   * this._applySpanStyle(charEl, '가', 10, 10, 2.5, undefined, 4);
   *
   * // fontWeight만 주입된 경우: 위치 재적용 생략
   * this._applySpanStyle(charEl, '가', 10, 10, 2.5, { fontWeight: 700 }, 4, 'inline-only');
   *
   * // 정렬 변경으로 left만 바뀐 경우: 스타일 재적용 생략
   * this._applySpanStyle(charEl, '가', 10, 10, 3.1, undefined, 4, 'position-only');
   * ```
   */
  private _applySpanStyle(
    charEl: HTMLSpanElement,
    char: string,
    renderedOffset: number,
    sourceOffset: number,
    charOffsetMm: number | undefined,
    inlineStyle: TextInlineStyle | undefined,
    lineMaxFontSize: number,
    mode: 'full' | 'inline-only' | 'position-only' = 'full',
  ): void {
    if (mode === 'inline-only') {
      // 위치/치수/문자는 이미 동일(_skipSpanStyleIfUnchanged가 charOffset/char 비교 완료).
      // 런 오버라이드 필드(fontWeight/fontStyle/color/fontSize)만 적용하고
      // dataset 스냅샷만 갱신한다. left/top/width 쓰기와 cssText 초기화를 건너뛴다.
      // 식별 필드(offset/sourceOffset/char)는 skip 실패 원인과 무관하게 항상 동기화한다 —
      // text 대체+스타일 주입이 동시에 일어나도 EditCoordinateMapper의 data-offset가
      // 최신을 유지해야 한다.
      this._applyInlineOverrides(charEl, inlineStyle);
      charEl.dataset.offset = String(renderedOffset);
      charEl.dataset.sourceOffset = String(sourceOffset);
      if (charEl.textContent !== char) charEl.textContent = char;
      if (charOffsetMm !== undefined) charEl.dataset.charOffset = String(charOffsetMm);
      charEl.dataset.inlineKey = _inlineStyleKey(inlineStyle);
      const { rawWidth, swidth } = this.model!.getCharWidths(char, inlineStyle);
      charEl.dataset.owidth = String(rawWidth);
      charEl.dataset.swidth = String(swidth);
      charEl.dataset.lineMaxFs = String(lineMaxFontSize);
      charEl.dataset.dimKey = _dimensionKey(inlineStyle);
      return;
    }

    if (mode === 'position-only' && charOffsetMm !== undefined) {
      // 정렬 변경 등으로 charOffset만 바뀐 경우: left 재적용만.
      // top은 수직 위치가 불변인 경우 쓰기를 생략한다 — 쓰기 자체가
      // style dirty 플래그를 세워 리플로우 범위를 넓히기 때문이다.
      const flatStyle = this.model!.genCharStyleFlat(char, inlineStyle, lineMaxFontSize);
      const newLeft = `${charOffsetMm}mm`;
      if (charEl.style.left !== newLeft) charEl.style.left = newLeft;
      const newTop = flatStyle.top ?? '0';
      if (charEl.style.top !== newTop) charEl.style.top = newTop;
      charEl.dataset.offset = String(renderedOffset);
      charEl.dataset.sourceOffset = String(sourceOffset);
      if (charEl.textContent !== char) charEl.textContent = char;
      charEl.dataset.charOffset = String(charOffsetMm);
      const { rawWidth, swidth } = this.model!.getCharWidths(char, inlineStyle);
      charEl.dataset.owidth = String(rawWidth);
      charEl.dataset.swidth = String(swidth);
      return;
    }

    charEl.style.cssText = '';

    if (charOffsetMm !== undefined) {
      const flatStyle = this.model!.genCharStyleFlat(char, inlineStyle, lineMaxFontSize);
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(charEl.style, flatStyle);
      charEl.style.position = 'absolute';
      charEl.style.left = `${charOffsetMm}mm`;
      charEl.style.top = flatStyle.top ?? '0';
      charEl.textContent = char;

      // flexbox→charOffsets 전환 시 기존 inner span 제거
      const existingInner = charEl.querySelector<HTMLSpanElement>(':scope > span[data-char-inner]');
      if (existingInner) existingInner.remove();
    } else {
      const charStyle = this.model!.genCharStyle(char, inlineStyle, lineMaxFontSize);
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(charEl.style, charStyle);
      let inner = charEl.querySelector<HTMLSpanElement>(':scope > span[data-char-inner]');
      if (!inner) {
        inner = document.createElement('span');
        inner.dataset.charInner = 'true';
        charEl.appendChild(inner);
      }
      const innerStyle = this.model!.genCharInnerStyle();
      inner.style.cssText = '';
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(inner.style, innerStyle);
      inner.textContent = char;
    }

    charEl.dataset.offset = String(renderedOffset);
    charEl.dataset.sourceOffset = String(sourceOffset);
    if (charOffsetMm !== undefined) {
      charEl.dataset.charOffset = String(charOffsetMm);
    } else {
      delete charEl.dataset.charOffset;
    }
    // diff 스킵 판정용: 직전 인라인 스타일 스냅샷. 적용 후 갱신해야 다음 렌더에서
    // 변경 감지(_skipSpanStyleIfUnchanged)가 동작한다.
    charEl.dataset.inlineKey = _inlineStyleKey(inlineStyle);
    charEl.dataset.dimKey = _dimensionKey(inlineStyle);
    charEl.dataset.lineMaxFs = String(lineMaxFontSize);

    const { rawWidth, swidth } = this.model!.getCharWidths(char, inlineStyle);
    charEl.dataset.owidth = String(rawWidth);
    charEl.dataset.swidth = String(swidth);

    // 인라인 스타일: 문단 기본 대비 오버라이드 필드만 span에 직접 적용
    this._applyInlineOverrides(charEl, inlineStyle);
  }

  /**
   * 탭 span에 편집 모드 전용 점선 가이드를 적용한다.
   *
   * 갭 시작점은 같은 파트에서 탭 **앞쪽**에 위치한 마지막 span의 우측 끝
   * (`data-char-offset + data-swidth`)이고, 끝점은 탭 span 자체의
   * `data-char-offset`(= 우측 정렬 세그먼트 시작)이다. 탭 span은
   * `position: absolute; left: 탭offset`인데, 이 left와 `data-char-offset`을
   * 건드리면 다음 렌더 diff의 positionChanged 판정과 충돌하므로
   * `transform: translateX(-gapWidth)`로 시각적으로만 갭 시작 위치로 옮긴다.
   *
   * **편집 모드에서만 표시**한다 (`x-layout-paragraph`의 `editableText` 판정).
   * dataset은 변경하지 않고 style만 건드리며, 인쇄(printPostData)에는 영향이 없다.
   *
   * @param tabEl - 탭 문자 span
   * @returns void
   */
  private _applyTabGuideStyle(tabEl: HTMLSpanElement): void {
    // 편집 모드가 아니면 가이드를 표시하지 않는다.
    // 이전 렌더에서 가이드가 켜져 있었다면 인라인 스타일이 잔존하므로(genCharStyleFlat의
    // visibility:hidden 경로만으로는 해제되지 않음) 원복해야 한다.
    const paragraph = this.parentElement as { editableText?: boolean; localName?: string } | null;
    const wasGuided = tabEl.dataset.tabGuide === 'true';
    const isEditable = paragraph?.localName === 'x-layout-paragraph' && paragraph.editableText === true;
    if (!isEditable) {
      if (wasGuided) {
        tabEl.dataset.tabGuide = 'false';
        tabEl.style.transform = '';
        tabEl.style.width = '0mm';
        tabEl.style.minWidth = '0mm';
        tabEl.style.maxWidth = '0mm';
        tabEl.style.backgroundImage = 'none';
        tabEl.style.visibility = 'hidden';
        tabEl.style.opacity = '';
      }
      return;
    }

    // 갭 시작: 탭 span 기준 **앞쪽** 형제 중 문자 오프셋을 가진 마지막 span의 우측 끝.
    // 우측 정렬 세그먼트 span들은 탭보다 DOM 뒤에 있으므로, 탭 위치까지만 역순 스캔해야
    // 우측 글자의 offset을 잘못 잡는 것을 방지한다.
    // 스트리핑된 공백/`\n` span은 charOffset dataset이 없어 자동으로 건너뛴다.
    // swidth에 장평 스케일(widthRatio × 0.88)을 곱한다 — dataset.swidth는 장평 미적용
    // 배치 폭이고 실제 시각 우측 끝은 스케일 적용 후이므로, 점선이 이전 글자에 침범하지 않는다.
    const flatScaleX = this.model ? this.model.widthRatio * 0.88 : 1;
    const siblings = Array.from(tabEl.parentElement?.children ?? []) as HTMLElement[];
    const tabIdxInDom = siblings.indexOf(tabEl);
    let gapStartMm: number | null = null;
    for (let i = tabIdxInDom - 1; i >= 0; i--) {
      const el = siblings[i];
      if (!(el instanceof HTMLSpanElement)) continue;
      const off = el.dataset.charOffset;
      if (off === undefined) continue;
      gapStartMm = parseFloat(off) + parseFloat(el.dataset.swidth ?? '0') * flatScaleX;
      break;
    }
    if (gapStartMm === null) {
      // 탭 앞에 가시 span이 없다(라인/문단 시작부터 탭) — 갭의 시작은 파트 왼쪽 끝(0)이다.
      // 이때도 탭 위치까지 점선을 그려야 한다.
      gapStartMm = 0;
    }

    const tabOffsetStr = tabEl.dataset.charOffset;
    if (tabOffsetStr === undefined) return;
    const tabOffsetMm = parseFloat(tabOffsetStr);
    if (Number.isNaN(tabOffsetMm)) return;

    const gapWidthMm = gapStartMm !== null && !Number.isNaN(gapStartMm) && gapStartMm < tabOffsetMm
      ? tabOffsetMm - gapStartMm
      : 0;

    // 갭이 없으면(탭이 좌측 세그먼트에 바짝 붙은 케이스) 가이드 없음.
    if (gapWidthMm <= 0.01) {
      tabEl.dataset.tabGuide = 'false';
      tabEl.style.transform = '';
      tabEl.style.width = '0mm';
      tabEl.style.minWidth = '0mm';
      tabEl.style.maxWidth = '0mm';
      tabEl.style.backgroundImage = 'none';
      tabEl.style.visibility = 'hidden';
      return;
    }

    // 시각 확장: left/data-char-offset은 건드리지 않고, width를 갭 폭으로 늘린 뒤
    // transform으로 갭 시작 위치로 옮긴다.
    // 점선 색은 fixed 색(#888)을 쓴다 — color: transparent(currentColor 무효화)와
    // 함께 currentColor를 쓰면 점선까지 투명해져 보이지 않는다.
    // scale 개별 프로퍼티(genCharStyleFlat의 장평 스케일)를 1로 리셋한다 — 탭 span은
    // 시각 글자가 없어 장평이 무의미하고, scale은 translateX와 무관하게 배경 폭을
    // 압축해 갭 전체를 덮지 못한다. scale=1이면 translate와 width가 1:1 대응된다.
    tabEl.dataset.tabGuide = 'true';
    tabEl.style.scale = '1 1';
    tabEl.style.width = `${gapWidthMm}mm`;
    tabEl.style.minWidth = '0mm';
    tabEl.style.maxWidth = `${gapWidthMm}mm`;
    tabEl.style.visibility = 'visible';
    tabEl.style.color = 'transparent';
    tabEl.style.overflow = 'hidden';
    const lineH = parseFloat(tabEl.style.lineHeight || '');
    const guideHeightMm = Number.isNaN(lineH) ? (this.model?.fontSize ?? 4) : lineH;
    tabEl.style.height = `${guideHeightMm}mm`;
    tabEl.style.backgroundImage =
      'repeating-linear-gradient(to right, #888 0, #888 0.7mm, transparent 0.7mm, transparent 1.4mm)';
    tabEl.style.backgroundSize = '100% 0.3mm';
    tabEl.style.backgroundRepeat = 'no-repeat';
    // 라인의 상하 중간에 점선을 배치한다 — 배경 밴드 높이(0.3mm)의 절반만큼 보정한
    // 중앙 정렬. %는 (박스 높이 - 이미지 높이) 기준으로 해석되므로 50%가 중앙.
    tabEl.style.backgroundPosition = '0 calc(50% - 0.15mm)';
    tabEl.style.opacity = '0.45';
    tabEl.style.transform = `translateX(${-gapWidthMm}mm)`;
    tabEl.style.transformOrigin = '0 center';
  }

  /**
   * 인라인 스타일 오버라이드 필드를 span에 적용한다.
   *
   * 라인/파트는 문단 기본 스타일만 갖고, 런별 차이(폰트/크기/굵기/기울임/색상)는
   * 글자 span에 직접 반영된다. `fontFamily`는 등록 폰트 패밀리명이므로
   * 브라우저가 그대로 해석한다.
   *
   * `color`는 `ColorRegistry`에 등록된 CMYK 색상 이름(예: `'K100'`, `'red'`)이다.
   * 문단 수준 color(`paragraph.element.ts _applyStyle`)와 동일하게
   * `ColorRegistry.getCSSColor()`로 `#RRGGBB` hex로 변환하여 적용한다.
   * 변환하지 않으면 CSS가 인식하지 못하는 색상 이름은 무시되어 색상이 적용되지 않는다.
   *
   * 하단 앵커: 글자 하단을 라인의 fontSize 영역 하단(행간 제외)에 고정한다.
   * `lineMaxFontSize`는 해당 라인의 최대 폰트 크기로, 라인 높이에서 lineGap
   * 부분을 제외한 실제 글자 영역의 하단 기준이다.
   * 인라인 폰트가 라인 최대값보다 작으면 아래로 내려 하단을 맞추고,
   * 인라인 폰트가 라인 최대값보다 크면(동일 라인에 더 큰 폰트가 있는 경우)
   * 위로 밀려 윗라인을 침범할 수 있다.
   *
   * @param charEl - 스타일을 적용할 글자 span DOM 요소
   * @param inlineStyle - 인라인 런 스타일 오버라이드 (정의된 필드만 적용)
   * @param lineMaxFontSize - 이 글자가 속한 라인의 최대 폰트 크기 (mm)
   * @throws {Error} `inlineStyle.color`가 `'default'`인 경우 `ColorRegistry.getCSSColor()`가 throw
   * @example
   * ```ts
   * // inlineStyle = { color: 'K100' }
   * // → charEl.style.color = '#000000' (ColorRegistry.getCSSColor('K100'))
   * ```
   */
  private _applyInlineOverrides(charEl: HTMLSpanElement, inlineStyle: TextInlineStyle | undefined): void {
    if (!inlineStyle) return;

    if (inlineStyle.fontFamily) {
      charEl.style.fontFamily = inlineStyle.fontFamily;
    }
    if (inlineStyle.fontWeight !== undefined) {
      charEl.style.fontWeight = String(inlineStyle.fontWeight);
    }
    if (inlineStyle.fontStyle !== undefined) {
      charEl.style.fontStyle = inlineStyle.fontStyle;
    }
    if (inlineStyle.color) {
      charEl.style.color = ColorRegistry.getInstance().getCSSColor(inlineStyle.color);
    }
    if (inlineStyle.fontSize !== undefined && inlineStyle.fontSize !== this.model!.fontSize) {
      charEl.style.fontSize = `${inlineStyle.fontSize}mm`;
      charEl.style.lineHeight = `${inlineStyle.fontSize}mm`;
      charEl.style.display = 'inline-block';
      charEl.style.height = `${inlineStyle.fontSize}mm`;
    }
  }

  /**
   * 재사용 span에서 글자/오프셋이 모두 동일하면 스타일 재적용을 스킵한다.
   * `genCharStyle()`는 이미 LRU 캐시되어 있어 객체 생성 비용은 낮지만,
   * `Object.assign(style, ...)` + `cssText = ''` + inner span 처리는 매 span마다
   * DOM 쓰기를 발생시키므로 변경이 없으면 전체 스킵한다.
   *
   * `charOffsetMm`가 변경되면 스킵하지 않는다 (정렬 변경 시 재적용 필요).
   *
   * charOffsets 경로(단일 span)에서는 `textContent`를 직접 비교하고,
   * flexbox 경로(중첩 span)에서는 inner span의 `textContent`를 비교한다.
   *
   * @param charEl - 재사용 대상 span
   * @param char - 현재 글자
   * @param renderedOffset - 현재 렌더링 오프셋
   * @param sourceOffset - 현재 소스 오프셋
   * @param charOffsetMm - 절대 정렬 오프셋 (undefined = 레거시 경로)
   * @returns 스킵했으면 `true`, 스타일을 적용했으면 `false`
   */
  private _skipSpanStyleIfUnchanged(
    charEl: HTMLSpanElement,
    char: string,
    renderedOffset: number,
    sourceOffset: number,
    charOffsetMm?: number,
    inlineStyle?: TextInlineStyle,
    lineMaxFontSize?: number,
  ): boolean {
    if (
      charEl.dataset.offset === String(renderedOffset) &&
      charEl.dataset.sourceOffset === String(sourceOffset)
    ) {
      const existingCharOffset = charEl.dataset.charOffset;
      const newCharOffsetStr = charOffsetMm !== undefined ? String(charOffsetMm) : undefined;
      if (existingCharOffset === newCharOffsetStr) {
        const inlineKey = _inlineStyleKey(inlineStyle);
        if ((charEl.dataset.inlineKey ?? '') !== inlineKey) return false;
        const newLmfs = lineMaxFontSize !== undefined ? String(lineMaxFontSize) : '';
        if ((charEl.dataset.lineMaxFs ?? '') !== newLmfs) return false;
        if (charOffsetMm !== undefined) {
          return charEl.textContent === char;
        }
        const inner = charEl.querySelector<HTMLSpanElement>(':scope > span[data-char-inner]');
        return inner !== null && inner.textContent === char;
      }
    }
    return false;
  }

  /**
   * Diff 기반 텍스트 렌더링: 기존 span 요소를 `data-source-offset` 키로 재사용하며
   * 변경된 부분만 업데이트한다. COVER 라인(`parts: []`)은 라인 div의 자식을 모두 제거한다.
   *
   * 오버플로우 라인은 part/span DOM 노드 생성을 생략하고 lineEl만 `display: none`으로 유지한다.
   * 단, diff 렌더링의 인덱스 매칭을 위해 lineEl 자체는 보존한다.
   */
  renderText() {
    if (!this.isConnected) return;

    // Preserve existing <style> element instead of innerHTML = ''
    const existingStyleEl = this._shadowRoot.querySelector<HTMLStyleElement>(`style#${HOST_STYLE_ID}`);

    if (!this.model || this._index === undefined) {
      // Early return: remove line elements only, keep <style>
      const lineEls = Array.from(this._shadowRoot.children).filter(
        (child): child is HTMLDivElement => child.tagName === 'DIV'
      );
      for (const el of lineEls) el.remove();
      return;
    }

    const lines = this.model.columnContents[this._index] || [];
    const colStyle = this.model.genColumnStyle(this._index);

    const { renderedOffset, sourceOffset } = this._computePerfSourceOffsets();

    // Reuse or create <style> element
    const styleEl = existingStyleEl || document.createElement('style');
    if (!existingStyleEl) {
      styleEl.id = HOST_STYLE_ID;
      this._shadowRoot.appendChild(styleEl);
    }
    const colStyleKey = JSON.stringify(colStyle);
    const rulesInvalidated = styleEl.sheet && styleEl.sheet.cssRules.length === 0;
    if (styleEl.sheet && (colStyleKey !== this._cachedColStyleKey || rulesInvalidated)) {
      this._cachedColStyleKey = colStyleKey;
      while (styleEl.sheet.cssRules.length > 0) {
        styleEl.sheet.deleteRule(0);
      }
      styleEl.sheet.insertRule(":host {}", 0);
      const rule = styleEl.sheet.cssRules[0] as CSSStyleRule;
      rule.style.cssText = '';
      Object.assign<CSSStyleDeclaration, Partial<CSSStyleDeclaration>>(rule.style, colStyle);
    }

    // Remove data-temporary spans (created by TextEditController) before collecting existing lines
    const temporarySpans = this._shadowRoot.querySelectorAll('span[data-temporary]');
    for (const span of temporarySpans) span.remove();

    // Collect existing line elements for diff rendering (Task 4)
    const existingLineEls = Array.from(this._shadowRoot.children).filter(
      (child): child is HTMLDivElement => child.tagName === 'DIV'
    );

    let curRenderedOffset = renderedOffset;
    let curSourceOffset = sourceOffset;
    let restyledCount = 0;

    const columnHeightMm = this.model.inheritStyle?.parentHeight ?? 0;
    const baseLineHeightMm = this.model.baseLineHeight;
    const baseFontSizeMm = this.model.fontSize;
    // 엔진(_createLineWithParts)의 overflow 판정과 동일 기준:
    // effectiveColumnHeight = parentHeight + (lineHeight - fontSize)
    const effectiveColumnHeightMm = columnHeightMm + (baseLineHeightMm - baseFontSizeMm);
    let accumulatedHeightMm = 0;
    let hasOverflowed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const { endOfBlock } = line;
      const curPartStyle = this.model.genPartStyle() || {};
      const lineMaxFontSize = line.maxFontSize ?? baseFontSizeMm;

      const lineEl = i < existingLineEls.length
        ? existingLineEls[i]
        : this._createLineElement(i);
      if (i < existingLineEls.length) {
        this._applyLineStyle(lineEl, i);
      } else {
        this._shadowRoot.appendChild(lineEl);
      }

      // 마지막 라인은 lineHeight가 아닌 maxFontSize만큼만 높이를 차지한다.
      // BoxEngine.absHeight = lineHeight * height - (lineHeight - fontSize)
      const isLastLineInColumn = i === lines.length - 1;
      if (isLastLineInColumn && lineEl.style.height !== `${lineMaxFontSize}mm`) {
        lineEl.style.height = `${lineMaxFontSize}mm`;
      }

      const lineHeightMm = this._getLineHeightMm(lineEl, line);
      // 한 번 overflow 발생 후 이후 라인이 마지막 라인 높이 규칙(fontSize)으로
      // 다시 visible로 잘못 판정되는 것을 방지한다.
      const isOverflow = hasOverflowed
        || (effectiveColumnHeightMm > 0 && accumulatedHeightMm + lineHeightMm > effectiveColumnHeightMm + 1e-6);
      lineEl.style.display = isOverflow ? 'none' : '';

      if (!isOverflow) {
        accumulatedHeightMm += lineHeightMm;
      } else {
        hasOverflowed = true;
      }

      if (isOverflow) {
        while (lineEl.firstChild) lineEl.firstChild.remove();

        const advanced = this._computeSkippedLineOffsets(line, curRenderedOffset, curSourceOffset);
        curRenderedOffset = advanced.renderedOffset;
        curSourceOffset = advanced.sourceOffset;
        continue;
      }

      if (line.parts.length === 0) {
        while (lineEl.firstChild) lineEl.firstChild.remove();
        if (endOfBlock && curSourceOffset < this.model!.plainText.length && this.model!.plainText[curSourceOffset] === '\n') curSourceOffset++;
        continue;
      }

      const existingPartEls = Array.from(lineEl.children).filter(
        (child): child is HTMLDivElement => child.tagName === 'DIV'
      );

      for (let p = 0; p < line.parts.length; p++) {
        const part = line.parts[p];
        const original = part.content;
        const isFirst = p === 0;
        const isLast = p === line.parts.length - 1;

        let leadingSpaces = 0;
        if (isFirst && line.firstOfBlock !== true) {
          for (let k = 0; k < original.length && original[k] === ' '; k++) leadingSpaces++;
          curSourceOffset += leadingSpaces;
        }

        const content = this._stripSpaces(part.content, isFirst, isLast, line.firstOfBlock === true, line.endOfBlock === true);

        let partJustify = curPartStyle.justifyContent;
        if (isLast && endOfBlock && partJustify === 'space-between') {
          partJustify = 'flex-start';
        }

        const partEl = p < existingPartEls.length
          ? existingPartEls[p]
          : this._createPartElement(part, line, curPartStyle as Record<string, string>, partJustify);
        if (p < existingPartEls.length) {
          this._applyPartStyle(partEl, part, line, curPartStyle as Record<string, string>, partJustify);
        } else {
          lineEl.appendChild(partEl);
        }

        const existingSpans = new Map<string, HTMLSpanElement>();
        const currentSpans = partEl.querySelectorAll(':scope > span[data-source-offset]') as NodeListOf<HTMLSpanElement>;
        for (const span of currentSpans) {
          const key = span.dataset.sourceOffset;
          if (key !== undefined) existingSpans.set(key, span);
        }

        let nextRef: Node | null = partEl.firstChild;

        const charOffsets = part.charOffsets;
        const inlineStyles = part.inlineStyles;

        for (let j = 0; j < content.length; j++) {
          const char = content[j];
          const thisCharSourceOffset = String(curSourceOffset);
          const existingSpan = existingSpans.get(thisCharSourceOffset);

          const offsetMm = charOffsets !== undefined && j < charOffsets.length
            ? charOffsets[j]
            : undefined;
          const charInlineStyle = inlineStyles !== undefined && j < inlineStyles.length
            ? inlineStyles[j]
            : undefined;

          let charEl: HTMLSpanElement;
          if (existingSpan) {
            charEl = existingSpan;
            if (!this._skipSpanStyleIfUnchanged(charEl, char, curRenderedOffset, curSourceOffset, offsetMm, charInlineStyle, lineMaxFontSize)) {
              const newInlineKey = _inlineStyleKey(charInlineStyle);
              const inlineKeyChanged = (charEl.dataset.inlineKey ?? '') !== newInlineKey;
              const lineMaxFsChanged = (charEl.dataset.lineMaxFs ?? '') !== String(lineMaxFontSize);
              const positionChanged = offsetMm !== undefined && charEl.dataset.charOffset !== String(offsetMm);
              const pathSwitched = (charEl.dataset.charOffset !== undefined) !== (offsetMm !== undefined);
              const dimKeyChanged = (charEl.dataset.dimKey ?? '') !== _dimensionKey(charInlineStyle);
              // 같은 data-source-offset 슬롯에 다른 글자가 배치되면 폭이 달라질 수
              // 있으므로(탭의 0폭 등) position-only로 left만 갱신해서는 안 된다.
              // full 재적용으로 width/minWidth/visibility까지 새로 계산한다.
              const charChanged = charEl.textContent !== char;

              let mode: 'full' | 'inline-only' | 'position-only';
              if (pathSwitched || dimKeyChanged || lineMaxFsChanged || charChanged || (inlineKeyChanged && positionChanged)) {
                mode = 'full';
              } else if (inlineKeyChanged) {
                // inlineKey 전체는 다르지만 치수·경로·라인MaxFs 불변 → 오버라이드 필드만 갱신.
                // 오버라이드 "제거"도 이 경로로 처리한다 — 적용 대상 필드가 정의 필드만이므로,
                // 제거는 full 재적용이 필요한 것이 아니라 기본값 적용이 필요한 것이다.
                // 그러나 fontWeight 700→undefined 시 기존 style.fontWeight='700'이 잔존하므로
                // full 경로의 cssText 재초기화가 필요하다. 따라서 inline-only가 안전한 경우는
                // "치수 무영향 필드(fontWeight/fontStyle/color)의 값 변경/추가"로 한정한다.
                const prevKey = charEl.dataset.inlineKey ?? '';
                const nextKey = newInlineKey;
                const isSafeInlineDelta = _isNonDestructiveInlineDelta(prevKey, nextKey);
                mode = isSafeInlineDelta ? 'inline-only' : 'full';
              } else if (positionChanged) {
                mode = 'position-only';
              } else {
                mode = 'full';
              }
              this._applySpanStyle(charEl, char, curRenderedOffset, curSourceOffset, offsetMm, charInlineStyle, lineMaxFontSize, mode);
              restyledCount++;
            }
            existingSpans.delete(thisCharSourceOffset);
          } else {
            charEl = this._createSpanElement(char, curRenderedOffset, curSourceOffset, offsetMm, charInlineStyle, lineMaxFontSize);
            restyledCount++;
          }

          if (nextRef === charEl) {
            nextRef = charEl.nextSibling;
          } else {
            partEl.insertBefore(charEl, nextRef);
          }

          if (char === '\t') {
            this._applyTabGuideStyle(charEl);
          }

          curRenderedOffset++;
          curSourceOffset++;
        }

        for (const unusedSpan of existingSpans.values()) {
          unusedSpan.remove();
        }

        if (isLast && line.endOfBlock !== true) {
          const afterLeading: string[] = isFirst ? original.slice(leadingSpaces) : original;
          let trailingSpaces = 0;
          for (let k = afterLeading.length - 1; k >= 0 && afterLeading[k] === ' '; k--) trailingSpaces++;
          curSourceOffset += trailingSpaces;
        }
      }

      for (let p = line.parts.length; p < existingPartEls.length; p++) {
        existingPartEls[p].remove();
      }

      if (endOfBlock && curSourceOffset < this.model!.plainText.length && this.model!.plainText[curSourceOffset] === '\n') curSourceOffset++;
    }

    for (let i = lines.length; i < existingLineEls.length; i++) {
      existingLineEls[i].remove();
    }

    this._lastRestyledCount = restyledCount;
  }

  /**
   * 렌더링에서 생략된(오버플로우) 라인의 part content를 순회하며
   * `renderedOffset`/`sourceOffset`을 렌더링하지 않은 만큼 advance시킨다.
   *
   * `renderText()`의 정상 part 렌더링 경로와 동일한 공백/`\n` 처리를 미러링하여
   * 이후 라인의 `data-source-offset` diff 키가 정확히 일치하도록 보장한다.
   *
   * @param line - 생략된 라인 데이터
   * @param renderedOffset - 현재 렌더링 오프셋
   * @param sourceOffset - 현재 소스 오프셋
   * @returns 갱신된 오프셋
   * @example
   * const adv = this._computeSkippedLineOffsets(line, 10, 20);
   * // adv.renderedOffset === 14, adv.sourceOffset === 24
   */
  private _computeSkippedLineOffsets(
    line: TextLineData,
    renderedOffset: number,
    sourceOffset: number,
  ): { renderedOffset: number; sourceOffset: number } {
    let curRendered = renderedOffset;
    let curSource = sourceOffset;

    for (let p = 0; p < line.parts.length; p++) {
      const original = line.parts[p].content;
      const isFirst = p === 0;
      const isLast = p === line.parts.length - 1;

      let leadingSpaces = 0;
      if (isFirst && line.firstOfBlock !== true) {
        for (let k = 0; k < original.length && original[k] === ' '; k++) leadingSpaces++;
        curSource += leadingSpaces;
      }

      const content = this._stripSpaces(
        original,
        isFirst,
        isLast,
        line.firstOfBlock === true,
        line.endOfBlock === true,
      );

      curRendered += content.length;
      curSource += content.length;

      if (isLast && line.endOfBlock !== true) {
        const afterLeading: string[] = isFirst ? original.slice(leadingSpaces) : original;
        let trailingSpaces = 0;
        for (let k = afterLeading.length - 1; k >= 0 && afterLeading[k] === ' '; k--) trailingSpaces++;
        curSource += trailingSpaces;
      }
    }

    if (line.endOfBlock && curSource < this.model!.plainText.length && this.model!.plainText[curSource] === '\n') {
      curSource++;
    }

    return { renderedOffset: curRendered, sourceOffset: curSource };
  }

  static get observedAttributes() { return ['index']; }

  get index() { return this._index; }
  get zIndex() { return 0; }
  get type() { return 'column' as const; }

  /**
   * 직전 renderText에서 스타일이 재적용된 span 수.
   * 큰 값은 layout이 크게 dirty 상태임을 뜻한다 — postRender의 커서/선택
   * rect 읽기 강제 리플로우 회피 지연 여부 판정에 사용한다.
   */
  get lastRestyledCount(): number { return this._lastRestyledCount; }

  get parentElement() {
    return super.parentElement as LayoutParagraphElement;
  }

  get left() {
    const width = this.model?.columnWidths.slice(0, this._index).reduce((a, b) => a + b, 0) || 0;
    const gap = this.model?.gaps.slice(0, this._index).reduce((a, b) => a + b, 0) || 0;
    return gap + width;
  }

  get top() { return 0; }

  get absLeft(): number {
    return this.parentElement.absLeft + this.left;
  }

  get absTop(): number {
    return this.parentElement.absTop;
  }

  get model() {
    return this.parentElement.model;
  }

  /**
   * 이 컬럼의 shadow DOM 내에서 `display: none`이 아닌 line div의 수를 반환한다.
   *
   * `renderText()`가 오버플로우된 줄을 `display: none`으로 숨기므로,
   * 이 게터는 실제로 화면에 보이는 줄 수만 센다. `TextLayoutEngine`이 paragraph
   * 자체 `textStyle.fontSize`와 `paragraphStyle.lineGap`을 곱해 계산한
   * `lineHeight`(mm)를 기준으로 렌더링된 결과이므로, document 기본 스타일이
   * 아닌 paragraph 자체 스타일 기반의 가시 라인 수이다.
   *
   * 외부 코드는 shadow DOM 내부 구조(line div 등)를 직접 순회하지 않고
   * 이 게터를 통해 캡슐화된 가시 라인 수만 가져올 수 있다.
   *
   * @returns 보이는 라인 수. 컬럼이 연결되지 않았거나 line div가 없으면 0.
   * @example
   * const column = paragraph.columnEl[0];
   * if (column) {
   *   const visible = column.visibleLineCount;
   *   console.log(`첫 번째 단의 보이는 라인 수: ${visible}`);
   * }
   */
  get visibleLineCount(): number {
    let count = 0;
    for (const child of this._shadowRoot.children) {
      if (child.tagName === 'DIV' && (child as HTMLDivElement).style.display !== 'none') {
        count++;
      }
    }
    return count;
  }

  set index(index: number | undefined) {
    this._index = index;
    this.renderText();
  }
}
customElements.define('x-layout-column', LayoutColumnElement);
