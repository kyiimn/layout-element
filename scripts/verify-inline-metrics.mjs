/**
 * 인라인 letterSpacing/widthRatio/spaceRatio 오버라이드의 전 파이프라인 정합성 검증 (Node).
 *
 * 배경: 세 필드가 `TextInlineStyle`에 추가되어 런 단위 오버라이드가 가능해졌다.
 * 폭 계산, 캐시 해시, printPostData, extractData, 커서 스타일 조회, 런 맵
 * 병합이 모두 per-run 값을 반영하는지 검증한다.
 *
 * 검증 항목:
 * 1. 폭 공식 — `getCharWidths(char, inlineStyle)`가 런 오버라이드를 반영:
 *    `swidth = rawWidth × widthRatio + letterSpacing × fontSize`
 *    공백은 `spaceRatio × fontSize × widthRatio + letterSpacing × fontSize`
 * 2. 배치 반영 — 런 오버라이드로 문자당 폭이 변하면 줄바꿈 위치(라인 길이)가 달라진다
 * 3. 해시 무효화 — 런 필드 변경 시 `_layoutCache`가 재계산된다 (stale 캐시 방지)
 * 4. printPostData — 글자별 widthRatio/letterSpacing/spaceRatio가 런 값으로 추출
 * 5. extractData — 런 스타일의 3개 필드가 content 배열에 그대로 보존 (round-trip)
 * 6. 스타일 조회 — `getEffectiveStyleAt`/`getCommonStyleInRange`가 런 값을 오버라이드
 * 7. 런 맵 병합 — 3개 필드가 다른 인접 런은 병합되지 않고, 같으면 병합된다
 *
 * 실행: npx tsx scripts/verify-inline-metrics.mjs
 *
 * @file scripts/verify-inline-metrics.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const ttfBase64 = readFileSync(resolve(pkgRoot, 'examples/fonts/KMIBMyoungjo.ttf')).toString('base64');

const { FontLoaderEngineImpl } = await import('../src/engine/font-loader-engine.ts');
const { ColorRegistryEngineImpl } = await import('../src/engine/color-registry-engine.ts');
const { DocumentEngine } = await import('../src/engine/document-engine.ts');
const { ParagraphEngine } = await import('../src/engine/paragraph-engine.ts');

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init([{ family: 'Myoungjo', base64Data: ttfBase64 }]);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({ red: { c: 0, m: 255, y: 255, k: 0 } });

let passCount = 0;
let failCount = 0;
function assert(condition, message) {
  if (condition) {
    passCount++;
    console.log(`  ✓ ${message}`);
  } else {
    failCount++;
    console.error(`  ✗ ${message}`);
  }
}

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/**
 * DocumentEngine + 문단 박스로 엔진 트리를 구성하고 layout을 실행한다.
 *
 * 문단은 박스의 children이 단일 객체일 때만 ParagraphEngine으로 생성되므로
 * (배열이면 전부 BoxEngine 취급), 문단을 단일 children 객체로 둔다.
 *
 * @param {string | object[]} content - 문단 텍스트 (또는 인라인 런 배열)
 * @param {object[]} [siblingBoxes] - document 형제 박스 (오버랩 요소, document 절대좌표)
 * @param {object} [opts] - { boxWidth, boxHeight, columns, fontSize, docLetterSpacing, docWidthRatio, docSpaceRatio }
 * @returns {object} { docEngine, paraEngine } — layoutText까지 완료된 상태
 */
function buildPara(content, siblingBoxes = [], opts = {}) {
  const {
    boxWidth = 237,
    boxHeight = 350,
    columns = 1,
    fontSize = 4,
    docLetterSpacing,
    docWidthRatio,
    docSpaceRatio,
  } = opts;

  const docTextStyle = { fontSize, fontFamily: 'Myoungjo' };
  if (docLetterSpacing !== undefined) docTextStyle.letterSpacing = docLetterSpacing;
  if (docWidthRatio !== undefined) docTextStyle.widthRatio = docWidthRatio;
  if (docSpaceRatio !== undefined) docTextStyle.spaceRatio = docSpaceRatio;

  const docEngine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: docTextStyle },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([
    {
      type: 'box',
      id: 'para-box', position: 'absolute', left: 10, top: 10, width: boxWidth, height: boxHeight, zIndex: 1,
      children: {
        id: 'para', type: 'paragraph', content, column: columns, gap: 3,
        paragraphStyle: {}, textStyle: {},
      },
    },
    ...siblingBoxes,
  ]);
  const paraEngine = docEngine.findEngineById('para');
  paraEngine.layoutText();
  return { docEngine, paraEngine };
}

/**
 * 지정 rect(문서 절대좌표)와 교차하는 visible 글자 수를 센다.
 *
 * @param {object} para - ParagraphEngine
 * @param {number} totalChars - 전체 글자 수
 * @param {number} x1 - rect 좌측 (mm)
 * @param {number} x2 - rect 우측 (mm)
 * @param {number} y1 - rect 상단 (mm)
 * @param {number} y2 - rect 하단 (mm)
 * @returns {number} 교차 글자 수
 */
function countCharsInRect(para, totalChars, x1, x2, y1, y2) {
  let count = 0;
  for (let off = 0; off < totalChars; off++) {
    const r = para.getCharRect(off);
    if (!r) continue;
    if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) count++;
  }
  return count;
}

// ── 1. 폭 공식: getCharWidths per-run 오버라이드 ──
console.log('\n[1] getCharWidths 폭 공식 — per-run 오버라이드');
{
  const { paraEngine } = buildPara('가');
  const engine = paraEngine;

  // 기본값: 문단 effective (letterSpacing -0.1, widthRatio 0.8, spaceRatio 0.5)
  const base = engine.getCharWidths('가');
  const manualBase = base.rawWidth * 0.8 + -0.1 * 4;
  assert(approx(base.swidth, manualBase), `기본 swidth === raw×0.8 + (-0.1×4) (${base.swidth.toFixed(6)} vs ${manualBase.toFixed(6)})`);

  // 런 오버라이드: widthRatio 1.0, letterSpacing 0.2, spaceRatio 0.25
  const ov = { widthRatio: 1.0, letterSpacing: 0.2, spaceRatio: 0.25 };
  const styled = engine.getCharWidths('가', ov);
  const manualStyled = base.rawWidth * 1.0 + 0.2 * 4;
  assert(approx(styled.swidth, manualStyled), `오버라이드 swidth === raw×1.0 + (0.2×4) (${styled.swidth.toFixed(6)} vs ${manualStyled.toFixed(6)})`);
  assert(styled.widthRatio === 1.0, 'getCharWidths가 per-run widthRatio를 반환');

  // 공백 폭: spaceRatio 오버라이드 반영
  const spaceStyled = engine.getCharWidths(' ', ov);
  const manualSpace = 0.25 * 4 * 1.0 + 0.2 * 4;
  assert(approx(spaceStyled.swidth, manualSpace), `공백 swidth === 0.25×4×1.0 + 0.2×4 (${spaceStyled.swidth.toFixed(6)})`);

  // 미지정 필드는 문단 기본 유지
  const partial = engine.getCharWidths('가', { widthRatio: 1.0 });
  const manualPartial = base.rawWidth * 1.0 + -0.1 * 4;
  assert(approx(partial.swidth, manualPartial), `부분 오버라이드: letterSpacing는 기본값 유지 (${partial.swidth.toFixed(6)})`);
}

// ── 2. 배치 반영: 줄바꿈 위치 변화 ──
console.log('\n[2] 배치(줄바꿈) — 런 폭 오버라이드가 라인 분할에 반영');
{
  const SYLLABLES = '가나다라마바사아자차카타파하';
  const makeText = (n) => Array.from({ length: n }, (_, i) => SYLLABLES[i % 14]).join('');

  const { paraEngine: plainEngine } = buildPara(makeText(60), [], { boxWidth: 60, boxHeight: 500 });
  const { paraEngine: wideEngine } = buildPara(
    [{ content: makeText(60), textInlineStyle: { widthRatio: 1.0, letterSpacing: 0.1 } }],
    [],
    { boxWidth: 60, boxHeight: 500 },
  );

  const plainLines = plainEngine.columnContents[0].length;
  const wideLines = wideEngine.columnContents[0].length;
  assert(wideLines > plainLines, `폭 증가 오버라이드가 더 많은 라인 생성 (plain ${plainLines} < wide ${wideLines})`);

  // 런 배치 폭 합계 === 파트 폭 이내 (오버플로우 없이 정확히 분할)
  const widePart = wideEngine.columnContents[0][0].parts[0];
  let sum = 0;
  for (let i = 0; i < widePart.content.length; i++) {
    const style = widePart.inlineStyles[i];
    const { swidth } = wideEngine.getCharWidths(widePart.content[i], style);
    sum += swidth;
  }
  assert(sum <= widePart.width + 1e-6, `첫 라인 배치 폭 합계 ≤ 파트 폭 (${sum.toFixed(4)} ≤ ${widePart.width.toFixed(4)})`);
}

// ── 3. 해시 무효화: _layoutCache stale 방지 ──
console.log('\n[3] 캐시 해시 — 런 필드 변경 시 재계산');
{
  const SYLLABLES = '가나다라마바사아자차카타파하';
  const makeText = (n) => Array.from({ length: n }, (_, i) => SYLLABLES[i % 14]).join('');

  const { paraEngine } = buildPara([{ content: makeText(30), textInlineStyle: { widthRatio: 1.0 } }], [], { boxWidth: 60, boxHeight: 500 });
  const linesBefore = paraEngine.columnContents[0].length;
  assert(paraEngine.hasLayoutCache, '초기 layout 후 _layoutCache 존재');

  // 런 필드 변경 (textContent setter는 캐시를 유지하므로 해시가 무효화 판정해야 함)
  paraEngine.textContent = [{ content: makeText(30), textInlineStyle: { widthRatio: 0.5 } }];
  paraEngine.layoutText();
  const linesAfter = paraEngine.columnContents[0].length;
  assert(linesAfter !== linesBefore, `widthRatio 런 변경 후 재래핑 (라인 수 ${linesBefore} → ${linesAfter})`);

  // 동일 스타일 재주입은 캐시 히트로 라인 수 불변
  const styleRef = { content: makeText(30), textInlineStyle: { widthRatio: 0.5 } };
  paraEngine.textContent = [styleRef];
  paraEngine.layoutText();
  assert(paraEngine.columnContents[0].length === linesAfter, '동일 입력 재주입은 캐시 히트로 동일 결과');
}

// ── 4. printPostData — 글자별 런 값 추출 ──
console.log('\n[4] printPostData — per-char 런 값 추출');
{
  const runStyle = { widthRatio: 1.0, letterSpacing: 0.2, spaceRatio: 0.25, color: 'red' };
  const { paraEngine } = buildPara(
    ['가', { content: '나다', textInlineStyle: runStyle }, '라'],
    [],
    { boxWidth: 60, boxHeight: 100 },
  );
  const posts = paraEngine.printPostData;
  const chars = posts[0].chars;
  assert(chars.length === 4, `printPostData에 전 글자 포함 (${chars.length}개)`);

  const charNa = chars[1]; // '나' — 오버라이드 런
  assert(charNa.char === '나', "chars[1] === '나'");
  assert(charNa.widthRatio === 1.0, `오버라이드 런 print widthRatio === 1.0 (${charNa.widthRatio})`);
  assert(approx(charNa.letterSpacing, 0.2), `오버라이드 런 print letterSpacing === 0.2 (${charNa.letterSpacing})`);
  assert(approx(charNa.spaceRatio, 0.25), `오버라이드 런 print spaceRatio === 0.25 (${charNa.spaceRatio})`);

  const charGa = chars[0]; // '가' — plain 런 (문단 기본)
  assert(approx(charGa.widthRatio, 0.8), `plain 런 print widthRatio === 문단 기본 0.8 (${charGa.widthRatio})`);
  assert(approx(charGa.letterSpacing, -0.1), `plain 런 print letterSpacing === 문단 기본 -0.1 (${charGa.letterSpacing})`);
  assert(approx(charGa.spaceRatio, 0.5), `plain 런 print spaceRatio === 문단 기본 0.5 (${charGa.spaceRatio})`);
}

// ── 5. extractData — 런 스타일 round-trip ──
console.log('\n[5] extractData — 런 스타일 round-trip 보존');
{
  const runStyle = { widthRatio: 1.0, letterSpacing: 0.2, spaceRatio: 0.25 };
  const { paraEngine } = buildPara(
    ['가', { content: '나다', textInlineStyle: { ...runStyle } }, '라'],
    [],
    { boxWidth: 60, boxHeight: 100 },
  );
  const data = paraEngine.extractData;
  const content = data.content;
  assert(Array.isArray(content), 'extractData content가 배열');
  const styled = content.find((item) => typeof item !== 'string');
  assert(styled !== undefined, '스타일 런이 content에 보존');
  assert(styled.textInlineStyle.widthRatio === 1.0, 'extractData 런 widthRatio 보존');
  assert(styled.textInlineStyle.letterSpacing === 0.2, 'extractData 런 letterSpacing 보존');
  assert(styled.textInlineStyle.spaceRatio === 0.25, 'extractData 런 spaceRatio 보존');
  assert(styled.content === '나다', 'extractData 런 content 보존');
}

// ── 6. 스타일 조회 — getEffectiveStyleAt / getCommonStyleInRange ──
console.log('\n[6] 커서 스타일 조회 — per-run 오버라이드');
{
  const { paraEngine } = buildPara(
    ['가나', { content: '다라', textInlineStyle: { widthRatio: 1.0, letterSpacing: 0.05 } }, '마바'],
    [],
    { boxWidth: 60, boxHeight: 100 },
  );

  const plainEff = paraEngine.getEffectiveStyleAt(0); // '가'
  assert(approx(plainEff.widthRatio, 0.8), `plain 위치 effective widthRatio === 0.8 (${plainEff.widthRatio})`);
  assert(approx(plainEff.letterSpacing, -0.1), `plain 위치 effective letterSpacing === -0.1 (${plainEff.letterSpacing})`);

  const styledEff = paraEngine.getEffectiveStyleAt(3); // '다'
  assert(styledEff.widthRatio === 1.0, `오버라이드 위치 effective widthRatio === 1.0 (${styledEff.widthRatio})`);
  assert(approx(styledEff.letterSpacing, 0.05), `오버라이드 위치 effective letterSpacing === 0.05 (${styledEff.letterSpacing})`);

  // 범위 공통 스타일: [0,2)는 전부 plain → widthRatio 0.8
  const commonPlain = paraEngine.getCommonStyleInRange(0, 2);
  assert(approx(commonPlain.widthRatio, 0.8), `plain 범위 공통 widthRatio === 0.8 (${commonPlain.widthRatio})`);

  // 범위 [2,4)는 전부 오버라이드 → widthRatio 1.0
  const commonStyled = paraEngine.getCommonStyleInRange(2, 4);
  assert(commonStyled.widthRatio === 1.0, `오버라이드 범위 공통 widthRatio === 1.0 (${commonStyled.widthRatio})`);
  assert(approx(commonStyled.letterSpacing, 0.05), `오버라이드 범위 공통 letterSpacing === 0.05 (${commonStyled.letterSpacing})`);

  // 범위가 두 런에 걸치면 상이 필드는 제외됨
  const commonMixed = paraEngine.getCommonStyleInRange(1, 3);
  assert(commonMixed.widthRatio === undefined, '혼합 범위 공통 widthRatio 제외 (undefined)');
}

// ── 7. 런 맵 병합 — run-map.ts 정합성 ──
console.log('\n[7] 런 맵 병합 — 신규 필드 판정');
{
  const { plainToInline, inlineToPlain } = await import('../src/edit/run-map.ts');

  // 필드 값이 다른 인접 런은 병합되지 않는다
  const contentA = [
    { content: '가나', textInlineStyle: { widthRatio: 1.0 } },
    { content: '다라', textInlineStyle: { widthRatio: 0.9 } },
  ];
  const { runMap: mapA } = inlineToPlain(contentA);
  assert(mapA.length === 2, `widthRatio 상이 인접 런 미병합 (2개 유지, ${mapA.length}개)`);

  // 필드 값이 같은 인접 런은 병합된다
  const contentB = [
    { content: '가나', textInlineStyle: { widthRatio: 1.0, letterSpacing: 0.1 } },
    { content: '다라', textInlineStyle: { widthRatio: 1.0, letterSpacing: 0.1 } },
  ];
  const { runMap: mapB } = inlineToPlain(contentB);
  assert(mapB.length === 1, `동일 스타일 인접 런 병합 (1개, ${mapB.length}개)`);

  // plainToInline round-trip이 필드를 보존한다
  const rebuilt = plainToInline('가나다라', mapA);
  assert(rebuilt.length === 2, 'plainToInline round-trip 런 수 보존');
  assert(rebuilt[1].textInlineStyle.widthRatio === 0.9, 'plainToInline round-trip widthRatio 보존');
}

// ── 8. normalizeRunMap — 문단 기본과 동일한 런 해제 ──
console.log('\n[8] normalizeRunMap — 문단 기본 동일값 런 해제');
{
  const { normalizeRunMap } = await import('../src/edit/run-map.ts');
  const paragraphStyle = { widthRatio: 0.8, letterSpacing: -0.1, spaceRatio: 0.5, fontSize: 4 };

  // 문단 기본과 동일한 값 → 해제 (undefined)
  const runMapSame = [{ start: 0, end: 2, style: { widthRatio: 0.8, letterSpacing: -0.1, spaceRatio: 0.5 } }];
  const normSame = normalizeRunMap(runMapSame, paragraphStyle);
  assert(normSame[0].style === undefined, '문단 기본과 동일한 런은 해제 (undefined)');

  // 하나라도 다르면 유지
  const runMapDiff = [{ start: 0, end: 2, style: { widthRatio: 0.8, letterSpacing: 0.0 } }];
  const normDiff = normalizeRunMap(runMapDiff, paragraphStyle);
  assert(normDiff[0].style !== undefined && normDiff[0].style.letterSpacing === 0.0, '상이 필드가 있으면 런 유지');
}

// ── 9. 오버랩 회피 × per-run 폭 필드 — 파트 분할/자유 영역 필터 ──
console.log('\n[9] 오버랩 회피 — per-run widthRatio/letterSpacing 폭으로 파트 분할');
{
  // 문단 박스: abs (10,10) ~ (50,70). 1단 40mm. base '가' swidth = 2.544mm.
  // 오버랩 박스: abs x 20~30 (컬럼 로컬 10~20), y 14.8~24.4 → 라인1/2 교차.
  // → 라인1/2 자유 영역 [0,10] + [20,40] → 파트 2개 (left=0, left=10(갭)).
  const SYLLABLES = '가나다라마바사아자차카타파하';
  const makeText = (n) => Array.from({ length: n }, (_, i) => SYLLABLES[i % 14]).join('');

  const probe = buildPara('가', [], { boxWidth: 40, boxHeight: 60 });
  const baseW = probe.paraEngine.getCharWidths('가').swidth; // 2.544
  const basePerLine = Math.floor((10 + 1e-6) / baseW); // 좌측 파트 [0,10]에 3자

  const overlayBox = {
    type: 'box', id: 'ovl', position: 'absolute',
    left: 20, top: 14.8, width: 10, height: 9.6, zIndex: 10,
    children: { id: 'ovl-para', type: 'paragraph', content: '오버랩', paragraphStyle: {}, textStyle: {} },
  };
  const { paraEngine } = buildPara(
    makeText(basePerLine * 6),
    [overlayBox],
    { boxWidth: 40, boxHeight: 60 },
  );
  const col = paraEngine.columnContents[0];
  const l1 = col[1];
  assert(l1 && l1.parts.length === 2, `오버랩 라인 파트 2개 (좌측+우측, got ${l1?.parts.length})`);
  assert(l1 && approx(l1.parts[0].left, 0) && approx(l1.parts[0].width, 10),
    `좌측 파트 [0,10] (got left=${l1?.parts[0].left.toFixed(2)}, w=${l1?.parts[0].width.toFixed(2)})`);
  assert(l1 && approx(l1.parts[1].left, 10) && approx(l1.parts[1].width, 20),
    `우측 파트 left=10(갭), w=20 (got left=${l1?.parts[1].left.toFixed(2)}, w=${l1?.parts[1].width.toFixed(2)})`);

  // 좌측 파트 [0,10]의 배치 폭 합계는 base 글자 3자 × 2.544 = 7.632 ≤ 10
  let leftSum = 0;
  for (let i = 0; i < l1.parts[0].content.length; i++) {
    const { swidth } = paraEngine.getCharWidths(l1.parts[0].content[i], l1.parts[0].inlineStyles[i]);
    leftSum += swidth;
  }
  assert(leftSum <= 10 + 1e-6, `좌측 파트 배치 폭 ≤ 파트 폭 (${leftSum.toFixed(3)} ≤ 10)`);
}

// ── 10. 오버랩 회피 × 런 widthRatio 확대 — 파트 폭 준수 ──
console.log('\n[10] 오버랩 + 런 widthRatio 1.0 — 확대 폭으로 파트 분할, 오버랩 영역 0교차');
{
  const SYLLABLES = '가나다라마바사아자차카타파하';
  const makeText = (n) => Array.from({ length: n }, (_, i) => SYLLABLES[i % 14]).join('');

  // 문단 기본 widthRatio 0.8 (swidth 2.544). 런 오버라이드 widthRatio 1.0 → 3.28mm.
  const probe = buildPara([{ content: '가', textInlineStyle: { widthRatio: 1.0 } }], [], { boxWidth: 40, boxHeight: 60 });
  const wideW = probe.paraEngine.getCharWidths('가', { widthRatio: 1.0 }).swidth; // 3.28

  const overlayBox = {
    type: 'box', id: 'ovl2', position: 'absolute',
    left: 20, top: 14.8, width: 10, height: 9.6, zIndex: 10,
    children: { id: 'ovl2-para', type: 'paragraph', content: '오버랩', paragraphStyle: {}, textStyle: {} },
  };
  const runChars = Math.ceil(40 / wideW) * 6; // 파트 없이 계산한 여유분
  const { paraEngine } = buildPara(
    [{ content: makeText(runChars), textInlineStyle: { widthRatio: 1.0 } }],
    [overlayBox],
    { boxWidth: 40, boxHeight: 60 },
  );

  // 오버랩 라인(1/2)의 각 파트 배치 폭이 파트 폭을 준수하는지
  const col = paraEngine.columnContents[0];
  let allFit = true;
  let totalPlaced = 0;
  for (const line of [col[1], col[2]]) {
    for (const part of line.parts) {
      let sum = 0;
      for (let i = 0; i < part.content.length; i++) {
        const { swidth } = paraEngine.getCharWidths(part.content[i], part.inlineStyles[i]);
        sum += swidth;
      }
      if (sum > part.width + 1e-6) allFit = false;
      totalPlaced += part.content.length;
    }
  }
  assert(allFit, '오버랩 라인 모든 파트 배치 폭 ≤ 파트 폭 (per-run widthRatio 반영)');

  // visible 글자가 오버랩 영역(abs 20~30, 14.8~24.4)과 교차하지 않는지
  const inOverlay = countCharsInRect(paraEngine, runChars, 20, 30, 14.8, 24.4);
  assert(inOverlay === 0, `visible 글자 오버랩 영역 교차 0개 (got ${inOverlay})`);
}

// ── 11. 좁은 자유 영역 × 런 폭 — COVER 처리 (강제 배치 방지) ──
console.log('\n[11] 좁은 자유 영역 + 큰 런 폭 — 런 폭 기준 COVER (글자 넘침 방지)');
{
  const SYLLABLES = '가나다라마바사아자차카타파하';
  const makeText = (n) => Array.from({ length: n }, (_, i) => SYLLABLES[i % 14]).join('');

  // 런: fontSize 6 + widthRatio 1.0 → '가' swidth = 6.72 - 0.6 = 6.12mm… 실측 사용.
  // 오버랩으로 5mm 자유 영역만 남기면: 문단 fs 기준 임계치였다면 영역 유지(4.8 ≤ 5) →
  // 6.12mm 글자 강제 배치 → 오버랩 위로 넘침. 런 폭 기준이면 COVER → 다음 라인.
  const probe = buildPara([{ content: '가', textInlineStyle: { fontSize: 6, widthRatio: 1.0 } }], [], { boxWidth: 40, boxHeight: 60 });
  const bigW = probe.paraEngine.getCharWidths('가', { fontSize: 6, widthRatio: 1.0 }).swidth;

  // 컬럼 40mm. 런 fontSize 6 → 라인 높이 7.2mm (per-line).
  // 오버랩이 좌측 36mm 차지 (abs 10~46) → 자유 영역 [36,40] = 4mm.
  // 라인 rect (fs 6 기준 7.2mm): line0 10~17.2, line1 17.2~24.4, line2 24.4~31.6.
  // 오버랩 top 14.8 → line0~2 모두 교차. 자유 영역 4mm < 런 글자 폭(~4.92mm) →
  // COVER. 문단 fs 4 기준 임계치(3.12mm)였다면 4mm 영역이 유지되어 글자가
  // 강제 배치 → 오버랩 위로 넘친다. line3 (31.6~38.8, 오버랩 bottom 24.4 아래)은
  // 정상 배치.
  const overlayBox = {
    type: 'box', id: 'ovl3', position: 'absolute',
    left: 10, top: 14.8, width: 36, height: 9.6, zIndex: 10,
    children: { id: 'ovl3-para', type: 'paragraph', content: '오버랩', paragraphStyle: {}, textStyle: {} },
  };
  const { paraEngine } = buildPara(
    [{ content: makeText(40), textInlineStyle: { fontSize: 6, widthRatio: 1.0 } }],
    [overlayBox],
    { boxWidth: 40, boxHeight: 60 },
  );
  const col = paraEngine.columnContents[0];

  // 라인0~2 (오버랩 교차, 자유 영역 4mm < 런 글자 폭) → COVER (빈 파트)
  const covered = [col[0], col[1], col[2]].every(l => l && l.parts.length === 0);
  assert(covered,
    `라인0~2 자유 영역 4mm < 런 글자 폭 ${bigW.toFixed(2)}mm → COVER 처리 (got parts=${[col[0], col[1], col[2]].map(l => l?.parts.length).join(',')})`);
  assert(bigW > 4, `런 글자 폭이 자유 영역보다 큰 전제 성립 (${bigW.toFixed(2)} > 4)`);

  // 라인3 (오버랩 아래)은 정상 배치
  assert(col[3] && col[3].parts.length > 0 && col[3].parts[0].content.length > 0,
    `라인3 (오버랩 아래) 정상 배치 (${col[3]?.parts[0]?.content.length ?? 0}자)`);
}

// ── 결과 ──
console.log(`\n${failCount === 0 ? 'ALL PASS' : 'FAILURES'} (${passCount} pass, ${failCount} fail)`);
process.exit(failCount === 0 ? 0 : 1);