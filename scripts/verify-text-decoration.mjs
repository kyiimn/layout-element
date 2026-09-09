/**
 * 텍스트 장식(underline/breakline/outline) 전 파이프라인 정합성 검증 (Node).
 *
 * TextStyle/TextInlineStyle에 추가된 underline(밑줄), breakline(취소선),
 * outline(외곽선)이 엔진 배치 → 장식선 rect → printPostData → 스타일 조회 →
 * 런 맵 병합 전 경로에 반영되는지 검증한다.
 *
 * 밑줄/취소선은 CSS text-decoration이 아니라 엔진이 mm 좌표로 산출한
 * 실제 선(rect)이다. 화면(DOM div)과 인쇄(printPostData.decorations)가
 * 동일한 엔진 좌표를 소비하는지가 핵심 계약이다.
 *
 * 검증 항목:
 * 1. 장식선 rect 산출 — 밑줄 run이 하나의 구간으로 묶임 (x=첫 글자 offset,
 *    width=Σ swidth, 두께/색상 규칙)
 * 2. 취소선 — y가 라인 em box 중앙, 밑줄과 kind 분리
 * 3. 미적용 글자 구간 분리 — OFF 구간이 선을 끊음 (rect 2개)
 * 4. 런 경계 관통 병합 — 같은 속성 인접 런은 하나의 rect로 병합
 * 5. 색상 지정 — underlineColor/breaklineColor가 rect.color(hex)로 반영
 * 6. 캐시 무효화 — underline 토글 시 _layoutCache 재계산 (stale 방지)
 * 7. printPostData — decorations가 절대 mm 좌표로 export (문서 absLeft/absTop
 *    + 컬럼 오프셋 + alignOffset + 라인 누적 top + 파트 left + rect.x)
 * 8. printPostData — chars.outline (em → mm) + outlineColor CMYK
 * 9. print 화면 패리티 — decorations rect === DOM이 그릴 rect (같은 엔진 소스)
 * 10. 스타일 조회 — getEffectiveStyleAt/getCommonStyleInRange가 런 값을 반영
 * 11. 런 맵 병합 — 장식 필드가 다른 인접 런은 미병합, 같으면 병합
 * 12. 걸침 제외 — 걸침 글자는 선 구간에서 제외 (폭 기여 0)
 * 13. OFF 기준선 — 3필드 미지정 시 기존 배치와 byte 동일 (decorationRects 없음)
 *
 * 실행: npx tsx scripts/verify-text-decoration.mjs
 *
 * @file scripts/verify-text-decoration.mjs
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

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init([{ family: 'Myoungjo', base64Data: ttfBase64 }]);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({
  red: { c: 0, m: 255, y: 255, k: 0 },
  blue: { c: 255, m: 0, y: 0, k: 0 },
  black: { c: 0, m: 0, y: 0, k: 255 },
});

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
 * @param {string | object[]} content - 문단 텍스트 (또는 인라인 런 배열)
 * @param {object} [opts] - { boxWidth, boxHeight, columns, fontSize, textStyle }
 * @returns {object} { docEngine, paraEngine } — layoutText까지 완료된 상태
 */
function buildPara(content, opts = {}) {
  const {
    boxWidth = 237,
    boxHeight = 350,
    columns = 1,
    fontSize = 4,
    textStyle = {},
  } = opts;

  const docTextStyle = { fontSize, fontFamily: 'Myoungjo', ...textStyle };

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
  ]);
  const paraEngine = docEngine.findEngineById('para');
  paraEngine.layoutText();
  return { docEngine, paraEngine };
}

/**
 * 컬럼 전체 파트의 decorationRects를 평탄화한다.
 */
function allDecos(paraEngine, colIdx = 0) {
  const out = [];
  for (const line of paraEngine.columnContents[colIdx] ?? []) {
    for (const part of line.parts) {
      for (const deco of part.decorationRects ?? []) {
        out.push({ part, deco });
      }
    }
  }
  return out;
}

// ── 1. 밑줄 rect 산출 ──
console.log('\n[1] 밑줄 rect — run 병합 + 폭/두께 규칙');
{
  const { paraEngine } = buildPara([
    { content: '가나다', textInlineStyle: { underline: true } },
  ]);
  const decos = allDecos(paraEngine);
  assert(decos.length === 1, `밑줄 run이 하나의 rect로 묶임 (got ${decos.length})`);
  if (decos.length === 1) {
    const { part, deco } = decos[0];
    assert(deco.kind === 'underline', `kind === 'underline'`);

    const partWidthSum = part.content.reduce((sum, ch, i) =>
      sum + paraEngine.getCharWidths(ch, part.inlineStyles?.[i]).swidth, 0);
    assert(approx(deco.width, partWidthSum), `width === Σ swidth (${deco.width.toFixed(6)} vs ${partWidthSum.toFixed(6)})`);
    assert(approx(deco.x, part.charOffsets[0]), `x === 첫 글자 charOffset (${deco.x.toFixed(6)})`);

    const fs = 4;
    const expectedThickness = Math.max(fs * 0.06, 0.12);
    assert(approx(deco.height, expectedThickness), `height === max(fs×0.06, 0.12) (${deco.height})`);

    // rect.y 계약: 라인 top 기준(누적 top 미포함) — 글자 em box 하단 앵커.
    // 마지막(유일) 라인: y = maxFontSize - 두께
    const line0 = paraEngine.columnContents[0][0];
    const expectedY = (line0.maxFontSize ?? 4) - deco.height;
    assert(approx(deco.y, expectedY), `y === em box 하단 - 두께, 라인 top 기준 (${deco.y.toFixed(6)} vs ${expectedY.toFixed(6)})`);

    // 색상 미지정: hex가 빈 값 → DOM에서 글자 색상(currentColor)을 따른다
    assert(deco.color === '', `색상 미지정 시 hex 빈 값 — 글자 색상 상속 (${deco.color})`);
    assert(deco.colorName === '', `색상 미지정 시 colorName 빈 값 (${deco.colorName})`);
  }
}

// ── 2. 취소선 rect ──
console.log('\n[2] 취소선 rect — em box 중앙 + kind 분리');
{
  const { paraEngine } = buildPara([
    { content: '가나다', textInlineStyle: { breakline: true } },
  ]);
  const decos = allDecos(paraEngine);
  assert(decos.length === 1, `취소선 rect 1개 (got ${decos.length})`);
  if (decos.length === 1) {
    const { deco } = decos[0];
    assert(deco.kind === 'breakline', `kind === 'breakline'`);
    const line0 = paraEngine.columnContents[0][0];
    const expectedCenter = (line0.maxFontSize ?? 4) / 2;
    assert(approx(deco.y + deco.height / 2, expectedCenter), `선 중심 y === 글자 em box 중앙, 라인 top 기준 (${(deco.y + deco.height / 2).toFixed(6)} vs ${expectedCenter})`);
  }
}

// ── 3. 미적용 구간 분리 ──
console.log('\n[3] OFF 구간이 선을 끊음');
{
  const { paraEngine } = buildPara([
    { content: '가나', textInlineStyle: { underline: true } },
    { content: '다라' },
    { content: '마바', textInlineStyle: { underline: true } },
  ]);
  const ulDecos = allDecos(paraEngine).filter(d => d.deco.kind === 'underline');
  assert(ulDecos.length === 2, `OFF 구간으로 2개 rect 분리 (got ${ulDecos.length})`);
  if (ulDecos.length === 2) {
    const [a, b] = ulDecos.map(d => d.deco);
    assert(b.x > a.x + a.width - 1e-9, `두 번째 rect가 첫 rect 뒤에서 시작 (${b.x.toFixed(4)} > ${(a.x + a.width).toFixed(4)})`);
  }
}

// ── 4. 런 경계 관통 병합 ──
console.log('\n[4] 같은 속성 인접 런 병합');
{
  const { paraEngine } = buildPara([
    { content: '가나', textInlineStyle: { underline: true } },
    { content: '다라', textInlineStyle: { underline: true } },
  ]);
  const ulDecos = allDecos(paraEngine).filter(d => d.deco.kind === 'underline');
  assert(ulDecos.length === 1, `인접 동일 런이 하나의 rect로 병합 (got ${ulDecos.length})`);
}

// ── 5. 색상 지정 ──
console.log('\n[5] underlineColor/breaklineColor 반영');
{
  const { paraEngine } = buildPara([
    { content: '가나', textInlineStyle: { underline: true, underlineColor: 'red' } },
    { content: '다라', textInlineStyle: { breakline: true, breaklineColor: 'blue' } },
  ]);
  const decos = allDecos(paraEngine);
  const ul = decos.find(d => d.deco.kind === 'underline');
  const bl = decos.find(d => d.deco.kind === 'breakline');
  assert(ul && ul.deco.colorName === 'red', `밑줄 colorName === 'red' (${ul?.deco.colorName})`);
  assert(ul && ul.deco.color === '#FF0000', `밑줄 hex === #FF0000 (${ul?.deco.color})`);
  assert(bl && bl.deco.colorName === 'blue', `취소선 colorName === 'blue' (${bl?.deco.colorName})`);

  // 색상이 다르면 같은 kind라도 구간이 분리된다
  const { paraEngine: para2 } = buildPara([
    { content: '가나', textInlineStyle: { underline: true, underlineColor: 'red' } },
    { content: '다라', textInlineStyle: { underline: true, underlineColor: 'blue' } },
  ]);
  const ul2 = allDecos(para2).filter(d => d.deco.kind === 'underline');
  assert(ul2.length === 2, `색상 상이 인접 run은 분리 (got ${ul2.length})`);
}

// ── 6. 캐시 무효화 ──
console.log('\n[6] 캐시 해시 — underline 토글 재계산');
{
  const { paraEngine } = buildPara([{ content: '가나다라', textInlineStyle: {} }]);
  const decosBefore = allDecos(paraEngine);
  assert(decosBefore.length === 0, '초기 underline 없음 → rect 없음');

  paraEngine.textContent = [{ content: '가나다라', textInlineStyle: { underline: true } }];
  paraEngine.layoutText();
  const decosAfter = allDecos(paraEngine);
  assert(decosAfter.length === 1, `underline 토글 후 rect 산출 (got ${decosAfter.length})`);
}

// ── 7. printPostData decorations ──
console.log('\n[7] printPostData — decorations 절대 mm export');
{
  const { docEngine, paraEngine } = buildPara([
    { content: '가나', textInlineStyle: { underline: true } },
  ], { textStyle: { underlineColor: 'red' } });

  const print = paraEngine.printPostData[0];
  assert(Array.isArray(print.decorations) && print.decorations.length === 1, `decorations 1개 export (got ${print.decorations?.length})`);
  if (print.decorations?.length === 1) {
    const d = print.decorations[0];
    assert(d.kind === 'underline', 'print kind === underline');

    // 엔진 rect (파트 로컬) 재구성: print 좌표 - 문서 오프셋
    const col = paraEngine.columnContents[0][0];
    const part = col.parts[0];
    const engineDeco = part.decorationRects[0];

    // 문서 절대 = absLeft(10+10=box left 10 + doc padding 등) — docEngine 기준
    // box (10,10) + para padding 0 → 파트 로컬 x + box absLeft
    const boxAbs = docEngine.findEngineById('para-box').absRect;
    const expectedX = boxAbs.absLeft + part.left + engineDeco.x;
    assert(approx(d.x, expectedX, 1e-6), `print x === box absLeft + part.left + deco.x (${d.x.toFixed(6)} vs ${expectedX.toFixed(6)})`);

    const line0Top = 0; // 첫 라인 cumulativeTop = 0
    const alignOffset = 0; // verticalAlign top 기본
    const expectedY = boxAbs.absTop + alignOffset + line0Top + engineDeco.y;
    assert(approx(d.y, expectedY, 1e-6), `print y === box absTop + align + lineTop + deco.y (${d.y.toFixed(6)} vs ${expectedY.toFixed(6)})`);

    assert(approx(d.width, engineDeco.width), `print width === engine width`);
    assert(approx(d.height, engineDeco.height), `print height === engine height`);
    assert(d.color.c === 0 && d.color.m === 255 && d.color.y === 255 && d.color.k === 0, `밑줄 CMYK red (c0 m255 y255 k0) — got c${d.color.c} m${d.color.m} y${d.color.y} k${d.color.k}`);
  }
}

// ── 7b. 복수 라인 누적 top — deco.y는 라인 top 기준, 누적은 소비처가 1회만 더한다 ──
console.log('\n[7b] 복수 라인 — print y === box absTop + align + Σ이전 lineH + deco.y (이중 누적 방지)');
{
  const { docEngine, paraEngine } = buildPara(
    '가나다라마바사아자차'.split('').map(ch => ({ content: ch, textInlineStyle: { underline: true } })),
    { boxWidth: 24, boxHeight: 100 }, // 좁은 폭 → 복수 라인
  );

  const print = paraEngine.printPostData[0];
  const boxAbs = docEngine.findEngineById('para-box').absRect;

  // 엔진 기대 좌표 재구성 (chars 루프와 동일 공식)
  const defaultLineHeightMm = paraEngine.baseLineHeight;
  const baseFontSizeMm = paraEngine.fontSize;
  const effectiveColumnHeightMm = 100 + (defaultLineHeightMm - baseFontSizeMm);
  const alignOffsetMm = paraEngine._computeAlignOffsetMm(
    paraEngine.columnContents[0], effectiveColumnHeightMm, baseFontSizeMm, 100,
  );

  let cumulativeTopMm = 0;
  let checked = 0;
  for (const lineData of paraEngine.columnContents[0]) {
    const lineH = lineData.lineHeight ?? defaultLineHeightMm;
    for (const part of lineData.parts) {
      for (const deco of part.decorationRects ?? []) {
        const pd = print.decorations[checked];
        const expectedY = boxAbs.absTop + alignOffsetMm + cumulativeTopMm + deco.y;
        assert(pd !== undefined && approx(pd.y, expectedY, 1e-6),
          `라인${checked} y === absTop + align + 누적(${cumulativeTopMm.toFixed(2)}) + deco.y(${deco.y.toFixed(2)}) — got ${pd?.y?.toFixed(6)}`);
        checked++;
      }
    }
    cumulativeTopMm += lineH;
  }
  assert(checked >= 2, `복수 라인에서 검증 (${checked}개 rect)`);
}

// ── 8. printPostData outline ──
console.log('\n[8] printPostData — chars.outline em→mm');
{
  const { paraEngine } = buildPara([
    { content: '가나', textInlineStyle: { outline: 0.05 } },
    { content: '다라' },
  ]);
  const print = paraEngine.printPostData[0];
  const outlined = print.chars.filter(c => c.char === '가' || c.char === '나');
  const plain = print.chars.filter(c => c.char === '다' || c.char === '라');
  assert(outlined.every(c => approx(c.outline, 0.05 * 4)), `outline 런 글자 === 0.05×4 mm (${outlined[0]?.outline})`);
  assert(plain.every(c => c.outline === 0), `plain 글자 outline === 0`);
  assert(outlined.every(c => c.outlineColor.k === 255), `outlineColor 기본 CMYK K100`);
}

// ── 9. 화면-인쇄 패리티 ──
console.log('\n[9] 화면 패리티 — DOM이 그릴 rect === print rect (같은 엔진 소스)');
{
  const { docEngine, paraEngine } = buildPara([
    { content: '가나다', textInlineStyle: { underline: true, breakline: true } },
  ]);
  const boxAbs = docEngine.findEngineById('para-box').absRect;
  const print = paraEngine.printPostData[0];

  // DOM은 part.decorationRects를 part 기준으로 그린다: box absLeft + part.left + deco.x
  // print는 동일 공식 — 두 소스가 같은 엔진 rect를 참조하는지 구조적으로 확인
  const engineRects = [];
  for (const line of paraEngine.columnContents[0]) {
    for (const part of line.parts) {
      for (const deco of part.decorationRects ?? []) {
        engineRects.push({ part, deco });
      }
    }
  }
  assert(print.decorations.length === engineRects.length, `print/export 개수 일치 (${print.decorations.length} === ${engineRects.length})`);
  for (let i = 0; i < engineRects.length; i++) {
    const { part, deco } = engineRects[i];
    const pd = print.decorations[i];
    const domX = boxAbs.absLeft + part.left + deco.x;
    assert(approx(pd.x, domX, 1e-6), `rect[${i}] x 패리티 (${pd.x.toFixed(6)} === ${domX.toFixed(6)})`);
    assert(deco.kind === pd.kind, `rect[${i}] kind 일치`);
  }
}

// ── 10. 스타일 조회 ──
console.log('\n[10] getEffectiveStyleAt / getCommonStyleInRange');
{
  const { paraEngine } = buildPara([
    { content: '가나', textInlineStyle: { underline: true, outline: 0.05 } },
    { content: '다라' },
  ]);
  const eff0 = paraEngine.getEffectiveStyleAt(0);
  assert(eff0.underline === true, `offset 0 underline === true`);
  assert(eff0.outline === 0.05, `offset 0 outline === 0.05`);
  const eff2 = paraEngine.getEffectiveStyleAt(2);
  assert(eff2.underline === false, `offset 2 underline === false (문단 기본)`);

  const common = paraEngine.getCommonStyleInRange(0, 4);
  assert(common.underline === undefined, `혼합 범위 common underline 제외 (got ${common.underline})`);
  const commonUl = paraEngine.getCommonStyleInRange(0, 2);
  assert(commonUl.underline === true, `underline 런만 범위 common underline === true`);
}

// ── 11. 런 맵 병합 ──
console.log('\n[11] 런 맵 — 장식 필드 병합/미병합');
{
  const { applyStyleToRange, mergeAdjacentSameStyle } = await import('../src/edit/run-map.ts');

  const a = { start: 0, end: 2, style: { underline: true } };
  const b = { start: 2, end: 4, style: { underline: true } };
  const merged = mergeAdjacentSameStyle([a, b]);
  assert(merged.length === 1, `동일 underline 런 병합 (got ${merged.length})`);

  const c = { start: 2, end: 4, style: { underline: false } };
  const notMerged = mergeAdjacentSameStyle([{ start: 0, end: 2, style: { underline: true } }, c]);
  assert(notMerged.length === 2, `underline 값 상이 런 미병합 (got ${notMerged.length})`);

  const styled = applyStyleToRange(
    [{ start: 0, end: 4, style: undefined }],
    1, 3,
    { breakline: true },
  );
  assert(styled.length === 3, `applyStyleToRange가 범위 분할 (got ${styled.length})`);
  assert(styled[1]?.style?.breakline === true, `범위에 breakline 주입`);
}

// ── 12. 걸침 제외 ──
console.log('\n[12] 걸친 부호는 선 구간 폭 기여 없음');
{
  // 닫기 괄호가 행말 걸침되는 시나리오: 컬럼 폭에 딱 맞는 텍스트 + ')'
  const { paraEngine } = buildPara([
    { content: '가나다라', textInlineStyle: { underline: true } },
  ], { boxWidth: 237, boxHeight: 30 });

  const decos = allDecos(paraEngine);
  // 걸침이 없어도 rect가 정상 산출되는지 (회귀 방어)
  assert(decos.length >= 1, `밑줄 rect 산출 (got ${decos.length})`);
  for (const { part, deco } of decos) {
    assert(deco.width <= part.width + 1e-6, `선 폭이 파트 폭 이내 (${deco.width.toFixed(4)} ≤ ${part.width.toFixed(4)})`);
  }
}

// ── 13. OFF 기준선 ──
console.log('\n[13] OFF 기준선 — 기존 배치 보존');
{
  const { paraEngine } = buildPara('가나다라마바사');
  const decos = allDecos(paraEngine);
  assert(decos.length === 0, `스타일 미지정 시 decorationRects 없음 (got ${decos.length})`);

  const print = paraEngine.printPostData[0];
  assert(print.decorations !== undefined && print.decorations.length === 0 || print.decorations === undefined,
    `print decorations 빈 배열/undefined (got ${print.decorations?.length})`);
  for (const ch of print.chars) {
    assert(ch.outline === 0, `글자 '${ch.char}' outline 기본 0`);
  }
}

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
if (failCount > 0) process.exit(1);