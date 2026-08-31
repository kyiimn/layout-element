/**
 * 한글 음절 `.notdef` 폴백 폭 정합성 검증 (Node).
 *
 * 배경: KS X 1001 완성형 위주 폰트(KMIBMyoungjo 등)는 현대 한글 11,172자 중
 * cmap에 등록되지 않은 음절(`핳` 등 약 8,450자)이 있다. opentype.js
 * `charToGlyph()`는 이런 문자에 `.notdef`(gid 0, 반각 폭)를 반환하므로
 * 폴백 없이는 측정 폭(반각)과 브라우저 표시 폭(폴백 폰트 풀폭)이 어긋나
 * 글자 겹침/줄바꿈 오류가 발생했다.
 *
 * 검증 항목:
 * 1. cmap 미등록 한글 음절('핳' 등)의 폭 === 기준 글자 '가'의 폭
 * 2. cmap 등록 음절('하')은 자체 메트릭 유지 (폴백 미적용)
 * 3. 라틴 등 비한글 문자는 폴백 미적용
 * 4. 한글 호환 자모(U+3131 등, 범위 밖)는 폴백 미적용
 * 5. 글리프가 등록되어 폭이 좁은 음절(뱟 등 cmap 등록 특이 폭)은 자체 메트릭 유지
 * 6. 렌더링 파이프라인 전체: '핳'이 포함된 텍스트의 줄바꿈/charOffsets가
 *    동일 폭 글자('가')로 치환한 텍스트와 byte 동일
 * 7. '가' 글리프가 없는 폰트에서 폴백 포기 → minWidthMm 경로 (회귀 방어)
 *
 * 실행: npx tsx scripts/verify-hangul-glyph-fallback.mjs
 *
 * @file scripts/verify-hangul-glyph-fallback.mjs
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
colorRegistry.init({});

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
 * DocumentEngine + 단일 문단 박스로 엔진 트리를 구성하고 layout을 실행한다.
 *
 * @param {string | object[]} content - 문단 텍스트 (또는 인라인 런 배열)
 * @param {object} [opts] - { boxWidth, boxHeight, columns, fontSize, fontFamily }
 * @returns {object} ParagraphEngine 인스턴스 (layoutText까지 완료된 상태)
 */
function buildPara(content, opts = {}) {
  const {
    boxWidth = 57.7,
    boxHeight = 500,
    columns = 1,
    fontSize = 4,
    fontFamily = 'Myoungjo',
  } = opts;

  const docEngine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize, fontFamily } },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([{
    type: 'box',
    id: 'box', position: 'absolute', left: 10, top: 10, width: boxWidth, height: boxHeight, zIndex: 1,
    children: {
      id: 'para', type: 'paragraph', content, column: columns, gap: 3,
      paragraphStyle: {}, textStyle: {},
    },
  }]);
  const paraEngine = docEngine.childBoxEngines[0].childEngines[0];
  paraEngine.layoutText();
  return paraEngine;
}

// ── 실측 기대값 (측정 스크립트로 사전 검증된 KMIBMyoungjo 메트릭) ──
const upm = 1000;
const GA_ADV_UNITS = 920;         // '가' advanceWidth (0.92em)
const NOTDEF_ADV_UNITS = 500;     // .notdef advanceWidth (0.50em)
const FONT_SIZE = 4;              // mm
const GA_MM = (GA_ADV_UNITS / upm) * FONT_SIZE;        // 3.68
const NOTDEF_MM = (NOTDEF_ADV_UNITS / upm) * FONT_SIZE; // 2.00

console.log('\n=== 한글 음절 .notdef 폴백 폭 검증 (KMIBMyoungjo) ===\n');

// ── Test 1~5: getCharWidths로 공개 측정값 확인 ──
console.log('Test 1~5: 폭 측정 (getCharWidths 경유)');
{
  const para = buildPara('가');
  const gaWidth = para.getCharWidths('가').rawWidth;
  assert(approx(gaWidth, GA_MM, 1e-6), `'가' 폭 === ${GA_MM}mm (got ${gaWidth?.toFixed(4)})`);

  // 1. cmap 미등록 음절 → '가' 폭 폴백
  const unmapped = ['핳', '갃', '밯', '샻', '햏', '쀍'];
  for (const ch of unmapped) {
    const w = para.getCharWidths(ch).rawWidth;
    assert(approx(w, GA_MM, 1e-6), `cmap 미등록 '${ch}' 폭 === '가' 폭 ${GA_MM}mm (got ${w?.toFixed(4)})`);
  }
  // 미등록 음절 폭이 우연히 .notdef 폭과 같으면 폴백이 작동 안 한 것 (0.5em ≠ 0.92em)
  const hhatW = para.getCharWidths('핳').rawWidth;
  assert(!approx(hhatW, NOTDEF_MM, 1e-6), `'핳' 폭이 .notdef 폭 ${NOTDEF_MM}mm가 아님 (폴백 작동 증명)`);

  // 2. cmap 등록 음절은 자체 메트릭 유지
  const mapped = ['하', '한', '글', '삘', '엌', '괘'];
  for (const ch of mapped) {
    const w = para.getCharWidths(ch).rawWidth;
    assert(approx(w, GA_MM, 1e-6), `cmap 등록 '${ch}' 폭 === 자체 메트릭 ${GA_MM}mm (got ${w?.toFixed(4)})`);
  }

  // 3. 비한글 문자는 폴백 미적용 (자체 폭 유지 — .notdef 반각 폭 그대로)
  //    U+0378 (할당되지 않은 코드포인트, cmap에 없음)
  const unassigned = String.fromCodePoint(0x0378);
  const unassignedW = para.getCharWidths(unassigned).rawWidth;
  assert(approx(unassignedW, NOTDEF_MM, 1e-6), `비한글 cmap 미등록 U+0378 폭 === .notdef ${NOTDEF_MM}mm (폴백 미적용, got ${unassignedW?.toFixed(4)})`);

  // 4. 한글 호환 자모(U+3131 ㄱ, 음절 범위 밖)는 폴백 미적용
  const compatJa = para.getCharWidths('ㄱ').rawWidth;
  const compatJaGaIdx = fontLoader.getParsedFont('Myoungjo').charToGlyphIndex('ㄱ');
  const compatJaExpected = (fontLoader.getParsedFont('Myoungjo').charToGlyph('ㄱ').advanceWidth / upm) * FONT_SIZE;
  assert(
    compatJaGaIdx === 0 ? approx(compatJa, NOTDEF_MM, 1e-6) : approx(compatJa, compatJaExpected, 1e-6),
    `한글 자모 'ㄱ'(U+3131, 범위 밖) 폴백 미적용 (idx=${compatJaGaIdx}, got ${compatJa?.toFixed(4)})`,
  );

  // 5. cmap에 등록되어 폭이 특이한 음절은 자체 메트릭 유지 — 폴백이 글리프 존재 음절을 덮어쓰지 않는지.
  //    minWidthMm(2.0mm)보다 넓은 자체 폭을 가진 음절로 검증 (바닥값 마스킹 회피)
  const minWidthMm = 0.5 * FONT_SIZE; // spaceRatio 기본값 0.5
  const wideRegistered = ['륪', '중', '교', '왐', '블'];
  for (const ch of wideRegistered) {
    const parsed = fontLoader.getParsedFont('Myoungjo');
    const idx = parsed.charToGlyphIndex(ch);
    const ownWidth = (parsed.charToGlyph(ch).advanceWidth / upm) * FONT_SIZE;
    const w = para.getCharWidths(ch).rawWidth;
    assert(idx > 0 && ownWidth > minWidthMm && approx(w, ownWidth, 1e-6), `cmap 등록 특이 폭 '${ch}' 자체 메트릭 유지 (idx=${idx}, own=${ownWidth?.toFixed(4)}mm, got ${w?.toFixed(4)})`);
  }
}

// ── Test 6: 렌더링 파이프라인 전체 — 폭 기반 줄바꿈/charOffsets 동일성 ──
console.log('\nTest 6: 렌더링 파이프라인 — 폴백 폭으로 줄바꿈/정렬 동작');
{
  // '핳' 폭이 '가' 폭과 동일하므로, 동일 문자열에서 핳→가 치환 시 배치 geometry도 동일해야 한다.
  // content 글자 자체는 다르므로 left/width/charOffsets만 비교한다.
  const stripContent = (contents) =>
    JSON.stringify(contents.map(column =>
      column.map(line => ({
        flags: { fob: line.firstOfBlock ?? null, fot: line.firstOfText ?? null, eob: line.endOfBlock ?? null, eot: line.endOfText ?? null },
        parts: line.parts.map(p => ({ left: p.left, width: p.width, charOffsets: p.charOffsets, count: p.content.length })),
      })),
    ));
  const withFallback = buildPara('가나다라핳마바사아자차카타파하가나다라핳마바사아자차카타파하');
  const replaced = buildPara('가나다라가마바사아자차카타파하가나다라가마바사아자차카타파하');

  const s1 = stripContent(withFallback.columnContents);
  const s2 = stripContent(replaced.columnContents);
  assert(s1 === s2, `'핳' 포함 텍스트 배치 geometry === '가' 치환 텍스트 배치 (byte 동일)`);

  // 폭 균등성: justify 정렬에서 charOffsets가 균등 간격인지 (폴백 폭이 다른 글자와 어긋나면 간격이 튐)
  const justifyPara = buildPara('핳핳핳핳가나다라', { columns: 1 });
  const parts = justifyPara.columnContents[0][0].parts;
  const offsets = parts[parts.length - 1].charOffsets;
  if (offsets && offsets.length >= 2) {
    const gaps = [];
    for (let i = 1; i < offsets.length; i++) gaps.push(offsets[i] - offsets[i - 1]);
    const maxGap = Math.max(...gaps);
    const minGap = Math.min(...gaps);
    assert(
      (maxGap - minGap) < 1e-6,
      `justify charOffsets 균등 간격 (핳==가 폭 보장, min=${minGap?.toFixed(4)} max=${maxGap?.toFixed(4)})`,
    );
  }

  // getCharRect: '핳'의 rect.width가 '가'와 동일
  const rectPara = buildPara('가핳');
  const gaRect = rectPara.getCharRect(0, 0, 0, 0);
  const hhatRect = rectPara.getCharRect(0, 0, 0, 1);
  if (gaRect && hhatRect) {
    assert(approx(gaRect.width, hhatRect.width, 1e-6), `getCharRect '핳'.width === '가'.width (${gaRect.width?.toFixed(4)} vs ${hhatRect.width?.toFixed(4)})`);
  } else {
    assert(false, `getCharRect 반환 실패 (ga=${!!gaRect}, hhat=${!!hhatRect})`);
  }
}

// ── Test 7: '가' 없는 폰트 — 폴백 포기, minWidthMm 회귀 방어 ──
console.log('\nTest 7: 한글 미지원 폰트 — 폴백 포기 → minWidthMm');
{
  // KMIBMyoungjo에서 한글 cmap을 제거한 스텁 폰트로더 (Latin 글리프만 유지).
  // charToGlyph('가')가 null을 반환해야 폴백 헬퍼가 null → minWidthMm 경로로 되돌린다.
  const parsed = fontLoader.getParsedFont('Myoungjo');
  const latinOnlyFont = {
    unitsPerEm: parsed.unitsPerEm,
    charToGlyph: (ch) => {
      const cp = ch.codePointAt(0);
      if (cp >= 0xac00 && cp <= 0xd7a3) return null; // 한글 글리프 전부 없음 (가 포함)
      return parsed.charToGlyph(ch);
    },
    charToGlyphIndex: (ch) => {
      const cp = ch.codePointAt(0);
      if (cp >= 0xac00 && cp <= 0xd7a3) return 0;    // 한글 전부 미등록 시뮬레이션
      return parsed.charToGlyphIndex(ch);
    },
  };
  const latinOnlyLoader = {
    ready: true,
    init: async () => {},
    getParsedFont: () => latinOnlyFont,
    getFontFamily: () => 'Myoungjo',
  };

  const docEngine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    latinOnlyLoader, colorRegistry, 3.78,
  );
  docEngine.layout([{
    type: 'box',
    id: 'box', position: 'absolute', left: 10, top: 10, width: 57.7, height: 500, zIndex: 1,
    children: { id: 'para', type: 'paragraph', content: '핳', column: 1, gap: 3, paragraphStyle: {}, textStyle: {} },
  }]);
  const paraEngine = docEngine.childBoxEngines[0].childEngines[0];
  paraEngine.layoutText();
  const w = paraEngine.getCharWidths('핳').rawWidth;
  // '가' 글리프가 없으면 폴백 헬퍼가 null → _charWidthMm의 minWidthMm (spaceRatio 0.5 × 4 = 2.0)
  assert(approx(w, 2.0, 1e-6), `'가' 없는 폰트에서 '핳' → minWidthMm 2.0mm (got ${w?.toFixed(4)})`);
}

// ── Summary ──
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===\n`);
process.exit(failCount > 0 ? 1 : 0);