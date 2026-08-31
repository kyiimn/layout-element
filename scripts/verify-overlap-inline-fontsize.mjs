/**
 * 인라인 fontSize 오버라이드가 있는 컬럼의 오버랩 판정 rect 정합성 검증 (Node).
 *
 * 배경: `_createLineWithParts`가 라인 rect top을 `lineIndex × lineHeight`
 * (문단 기본 균일 높이)로 계산하던 시절, 인라인으로 큰 글자가 섞인 컬럼에서
 * 렌더링 라인 위치(per-line maxFontSize 높이 누적)와 오버랩 판정 위치가
 * 어긋났다. 2단 paragraph의 2단 인라인 영역을 1단보다 큰 글자로 설정하면
 * 2단 라인들이 실제보다 위에 있다고 판정해 오버랩 회피가 엉뚱한 라인에서
 * 일어났다.
 *
 * 검증 항목:
 * 1. 균일 경로 보존 — 인라인 오버라이드 없는 오버랩 문단은 오버랩 회피
 *    (파트 left 밀림)가 기존 균일 높이 위치 기준으로 발생
 * 2. 사용자 버그 재현 — 2단 인라인 큰 글자 + 오버랩 요소: 회피가 per-line
 *    렌더링 위치(`getCharRect` top과 동일)에서 발생. 균일 가정이면 회피가
 *    한 라인 뒤(엉뚱한 라인)에서 일어나 텍스트가 요소 위로 덮임
 * 3. overflow 판정 per-line화 — 큰 글자 컬럼이 균일 가상보다 일찍 참
 * 4. 혼합 라인 누적 top — base 라인 다음 big 라인의 rect top
 * 5. 오버랩 + 큰 글자 단일 소스 — visible 글자 전부 오버랩 영역 밖
 *
 * 실행: npx tsx scripts/verify-overlap-inline-fontsize.mjs
 *
 * @file scripts/verify-overlap-inline-fontsize.mjs
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

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const SYLLABLES = '가나다라마바사아자차카타파하';
function makeText(n) {
  const p = [];
  for (let i = 0; i < n; i++) p.push(SYLLABLES[i % SYLLABLES.length]);
  return p.join('');
}

/**
 * DocumentEngine + 문단 박스로 엔진 트리를 구성하고 layout을 실행한다.
 *
 * 문단은 박스의 children이 단일 객체일 때만 ParagraphEngine으로 생성되므로
 * (배열이면 전부 BoxEngine 취급), 문단 박스와 오버랩 박스를 document의
 * 형제 박스로 둔다. 형제 박스 중 zIndex가 높고 교차하는 것이 문단 박스의
 * `overlayElements` → ParagraphEngine `overlayEngines`가 된다.
 *
 * @param {string | object[]} content - 문단 텍스트 (또는 인라인 런 배열)
 * @param {object[]} [siblingBoxes] - document 형제 박스 (오버랩 요소, document 절대좌표)
 * @param {object} [opts] - { boxWidth, boxHeight, columns, fontSize }
 * @returns {object} ParagraphEngine 인스턴스 (layoutText까지 완료된 상태)
 */
function buildPara(content, siblingBoxes = [], opts = {}) {
  const {
    boxWidth = 70,
    boxHeight = 60,
    columns = 2,
    fontSize = 4,
  } = opts;

  const docEngine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize, fontFamily: 'Myoungjo' } },
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
  return paraEngine;
}

// ── 실측 기반 레이아웃 상수 (getCharWidths로 사전 측정) ──
// '가' swidth: fontSize 4 → 2.544mm, fontSize 6 → 3.816mm (widthRatio/letterSpacing 반영값)
const BASE_FS = 4;
const BIG_FS = 6;
const LINE_GAP = 1.2;
const BASE_LH = BASE_FS * LINE_GAP;   // 4.8
const BIG_LH = BIG_FS * LINE_GAP;     // 7.2
const BOX_TOP = 10;                   // 문단 박스 abs top
const BOX_W = 70, BOX_H = 60;
const COL_W = (BOX_W - 3) / 2;        // 33.5 (2단, gap 3)

const probe = buildPara('가', [], {});
const baseCharW = probe.getCharWidths('가').swidth;
const bigProbe = buildPara('가', [], { fontSize: BIG_FS });
const bigCharW = bigProbe.getCharWidths('가').swidth;
const BASE_PER_LINE = Math.floor((COL_W + 1e-6) / baseCharW);  // 13
const BIG_PER_LINE = Math.floor((COL_W + 1e-6) / bigCharW);    // 8

/**
 * 지정 rect(x1~x2, y1~y2, 문서 절대좌표)와 교차하는 visible 글자 수를 센다.
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

console.log('\n=== 인라인 fontSize 오버라이드 + 오버랩 판정 rect 정합성 검증 ===');
console.log(`(실측: baseCharW=${baseCharW.toFixed(3)}mm, bigCharW=${bigCharW.toFixed(3)}mm, base ${BASE_PER_LINE}자/라인, big ${BIG_PER_LINE}자/라인)\n`);

// ═══ Test 1: 균일 경로 보존 — 오버라이드 없는 오버랩 문단 ═══
console.log('Test 1: 인라인 오버라이드 없는 오버랩 문단 — 균일 높이 회피 (기존 동작 보존)');
{
  // 오버랩: abs x 10~25, y 15~24. col0 라인 top = 10 + i×4.8:
  //   line1 (14.8~19.6), line2 (19.6~24.4) 교차 → col0 로컬 [0,15] 덮음
  //   → 자유 영역 [15, 33.5] → 파트 1개, left=15.
  //   line0 (10~14.8), line3 (24.4~29.2)는 미교차 → left=0.
  const overlayBox = {
    type: 'box', id: 'ovl', position: 'absolute',
    left: 10, top: 15, width: 15, height: 9, zIndex: 10,
    children: { id: 'ovl-para', type: 'paragraph', content: '오버랩', paragraphStyle: {}, textStyle: {} },
  };
  const para = buildPara(makeText(BASE_PER_LINE * 4), [overlayBox], {});
  const col0 = para.columnContents[0];

  const line1 = col0[1], line2 = col0[2], line0 = col0[0], line3 = col0[3];
  assert(line1.parts.length === 1 && approx(line1.parts[0].left, 15),
    `라인1 (14.8~19.6) 오버랩 회피: 파트 1개, left=15 (got parts=${line1.parts.length}, left=${line1.parts[0]?.left.toFixed(2)})`);
  assert(line2.parts.length === 1 && approx(line2.parts[0].left, 15),
    `라인2 (19.6~24.4) 오버랩 회피: 파트 1개, left=15 (got left=${line2.parts[0]?.left.toFixed(2)})`);
  assert(line0.parts.length === 1 && approx(line0.parts[0].left, 0) && line3.parts.length === 1 && approx(line3.parts[0].left, 0),
    `라인0/3 (오버랩 밖) 파트 left=0 (회피 없음, got line0=${line0.parts[0]?.left.toFixed(1)} line3=${line3.parts[0]?.left.toFixed(1)})`);
  assert(col0.every(line => approx(line.lineHeight ?? BASE_LH, BASE_LH)),
    `모든 라인 높이 === base ${BASE_LH}mm (균일 경로)`);
}

// ═══ Test 2: 사용자 버그 직접 재현 — 2단 big 런 + 중단 오버랩 ═══
console.log('\nTest 2: 2단 인라인 큰 글자 + 오버랩 — 회피가 per-line 렌더링 위치에서 발생');
{
  // 1단: base 156자 (12라인 × 13자, 컬럼 가득). 2단: big 런이 흐름.
  // 2단 라인 top = 10 + i×7.2 (per-line BIG_LH):
  //   line0: 10.0~17.2  line1: 17.2~24.4  line2: 24.4~31.6  line3: 31.6~38.8
  // 오버랩: abs x 51~61 (2단 로컬 4.5~14.5 → 자유 [0,4.5]+[14.5,33.5], 파트 2개),
  //         y 26~30 → per-line line2 (24.4~31.6)만 교차.
  // 레거시(균일 4.8 가정)였다면 2단 라인 top = 10+i×4.8: line3 (24.4~29.2)이
  // 교차로 판정되고 line2는 미교차 → 실제 렌더링(line2가 24.4~31.6에 있음)과
  // 어긋나 텍스트가 오버랩 위로 덮임 — 본 버그.
  const col1Chars = BASE_PER_LINE * 12; // 156자 — 1단 가득
  const bigChars = BIG_PER_LINE * 5;    // 40자 — 2단 5라인
  const overlayBox = {
    type: 'box', id: 'ovl2', position: 'absolute',
    left: 51, top: 26, width: 10, height: 4, zIndex: 10,
    children: { id: 'ovl2-para', type: 'paragraph', content: '오버랩', paragraphStyle: {}, textStyle: {} },
  };
  const para = buildPara(
    [makeText(col1Chars), { content: makeText(bigChars), textInlineStyle: { fontSize: BIG_FS } }],
    [overlayBox],
  );

  const c0 = para.columnContents[0];
  const c1 = para.columnContents[1] ?? [];
  assert(c0.length === 12, `1단 base 156자 → 12라인 가득 (got ${c0.length})`);
  // line2가 파트 분할([0~4.5]에 1자 + [14.5~33.5]에 4자)되어 라인당 글자 수가
  // 줄어듦 → 40자는 6라인에 배치됨 (파트 분할 전이라면 5라인).
  assert(c1.length === 6, `2단 big 40자 → 6라인 (line2 파트 분할 반영, got ${c1.length})`);
  assert(c1.every(line => approx(line.lineHeight ?? 0, BIG_LH)),
    `2단 모든 라인 높이 === ${BIG_LH}mm (인라인 ${BIG_FS}mm 런)`);

  // 핵심: 2단 line2 (24.4~31.6)만 오버랩(26~30)과 교차 → 파트 2개
  const l2 = c1[2];
  const l2Split = l2 && l2.parts.length === 2 && approx(l2.parts[0].left, 0) && approx(l2.parts[0].width, 4.5);
  assert(l2Split,
    `2단 line2 (per-line top 24.4~31.6) 오버랩 교차 → 파트 2개 [0~4.5]+[14.5~33.5] (got ${l2 ? l2.parts.map(p => p.left.toFixed(1) + '~' + (p.left + p.width).toFixed(1)).join(' ') : 'n/a'})`);

  // line0/1/3은 오버랩 밖 → 단일 파트 left=0
  const [l0, l1, l3] = [c1[0], c1[1], c1[3]];
  assert(l0.parts.length === 1 && approx(l0.parts[0].left, 0) && l1.parts.length === 1 && approx(l1.parts[0].left, 0),
    `2단 line0/1 (오버랩 위) 파트 1개 left=0 — 레거시였다면 이 라인들이 회피됨`);
  assert(l3.parts.length === 1 && approx(l3.parts[0].left, 0),
    `2단 line3 (per-line top 31.6~38.8, 오버랩 밖) 파트 1개 left=0 — 레거시(균일)는 이 라인을 회피함`);

  // 2단 첫 글자 rect top === 10 (per-line 렌더링 좌표와 판정 좌표 일치)
  const firstBig = para.getCharRect(col1Chars);
  assert(firstBig && approx(firstBig.top, BOX_TOP), `2단 첫 글자 rect top === ${BOX_TOP}mm (getCharRect ↔ 판정 rect 일치, got ${firstBig?.top.toFixed(2)})`);

  // visible 글자 중 오버랩 영역(51~61, 26~30)과 교차 0개 — 렌더링 관점 최종 검증
  const inOverlay = countCharsInRect(para, col1Chars + bigChars, 51, 61, 26, 30);
  assert(inOverlay === 0, `visible 글자 중 오버랩 영역 교차 0개 (got ${inOverlay})`);
}

// ═══ Test 3: overflow 판정 per-line화 ═══
console.log('\nTest 3: 큰 글자 컬럼의 overflow 판정 — per-line 높이 누적');
{
  // base 99자: 8라인(13×7=91 + 8자). 균일/둘 다 1단에 전부.
  const para = buildPara(makeText(99), [], {});
  assert(para.columnContents[0].length === 8 && (para.columnContents[1] ?? []).length === 0,
    `base 99자: 1단 8라인, 2단 0라인 (got ${para.columnContents[0].length}/${(para.columnContents[1] ?? []).length})`);

  // big 99자: 라인 7.2mm. 컬럼 수용 60.8 → 8 visible (cum 57.6), 9번째 64.8 초과 → 2단 흐름.
  // 균일 가정이었다면 12라인까지 1단에 들어감 — per-line 판정이 4라인 일찍 넘김.
  const bigRun = { content: makeText(99), textInlineStyle: { fontSize: BIG_FS } };
  const paraBig = buildPara([bigRun], [], {});
  const b0 = paraBig.columnContents[0].length;
  const b1 = (paraBig.columnContents[1] ?? []).length;
  assert(b0 === 8 && b1 === 5,
    `big 99자: 1단 8라인(per-line overflow) + 2단 5라인 (got ${b0}/${b1})`);
  assert(b0 < 12, `1단 라인 수(${b0}) < 균일 가정(12) — per-line overflow 판정 작동 증명`);
}

// ═══ Test 4: 혼합 라인 누적 top — base 라인 다음 big 라인 ═══
console.log('\nTest 4: base→big 라인 전환 — 누적 top 정확성');
{
  // 단일 컬럼 33.5mm. run1 base 18자 → line0 13자(가득), line1에 base 5자.
  // run2 big 런이 line1에 이어짐 (base 5자 + big 글자들).
  // line0 높이 4.8 (base만), line1 높이 7.2 (big 포함 max).
  // line1 첫 글자(전체 13번째) rect top = 10 + 4.8 = 14.8
  const para = buildPara(
    [makeText(18), { content: makeText(18), textInlineStyle: { fontSize: BIG_FS } }],
    [],
    { boxWidth: COL_W, boxHeight: 100, columns: 1 },
  );
  const col = para.columnContents[0];
  assert(approx(col[0].lineHeight ?? 0, BASE_LH), `라인0 높이 === ${BASE_LH} (base만)`);
  assert(approx(col[1].lineHeight ?? 0, BIG_LH), `라인1 높이 === ${BIG_LH} (base+big 혼합, big max)`);

  const r = para.getCharRect(13);
  // 라인1 첫 글자는 base(4mm) 글자 — 하단 앵커 원칙에 따라 라인의 max fontSize(6)
  // 영역 하단에 맞추기 위해 verticalOffset = 6-4 = 2mm 내려감.
  assert(r && approx(r.top, BOX_TOP + BASE_LH + (BIG_FS - BASE_FS)),
    `라인1 첫 (base) 글자 rect top === ${BOX_TOP + BASE_LH + (BIG_FS - BASE_FS)}mm (누적 top + 하단 앵커 offset 2mm, got ${r?.top.toFixed(2)})`);

  // line1: base 5자(offset 13~17) + big 글자. line1의 base 5자 폭 = 5×2.544=12.72
  // big 글자가 (33.5-12.72)/3.816 ≈ 5.4 → 5자 들어감 → line1 총 10자 (offset 13~22)
  // line2 첫 글자 = offset 23 → top = 10 + 4.8 + 7.2 = 22 (line2는 big 전체 → offset 0)
  const rLine2 = para.getCharRect(23);
  assert(rLine2 && approx(rLine2.top, BOX_TOP + BASE_LH + BIG_LH),
    `라인2 첫 글자 rect top === ${BOX_TOP + BASE_LH + BIG_LH}mm (4.8+7.2 누적, got ${rLine2?.top.toFixed(2)})`);
}

// ═══ Test 5: 오버랩 + 큰 글자 혼합 — 하단 COVER ═══
console.log('\nTest 5: 오버랩 + 큰 글자 혼합 — 전 visible 글자가 오버랩 밖 (단일 소스)');
{
  // 2단. 1단 base 12라인(156자) + 2단 big 5라인(40자).
  // 오버랩: x 46~81 (2단 전폭 덮음), y 40~46 → 2단 line4 (38.8~46) 교차 → COVER
  // → line4는 cover 라인 (빈 파트). line3 (31.6~38.8) 미교차.
  const col1Chars = BASE_PER_LINE * 12;
  const bigChars = BIG_PER_LINE * 5;
  const overlayBox = {
    type: 'box', id: 'ovl3', position: 'absolute',
    left: 46, top: 40, width: 35, height: 6, zIndex: 10,
    children: { id: 'ovl3-para', type: 'paragraph', content: '오버랩', paragraphStyle: {}, textStyle: {} },
  };
  const para = buildPara(
    [makeText(col1Chars), { content: makeText(bigChars), textInlineStyle: { fontSize: BIG_FS } }],
    [overlayBox],
  );
  const c1 = para.columnContents[1] ?? [];
  const l4 = c1[4];
  assert(l4 && l4.parts.length === 0, `2단 line4 (per-line top 38.8~46, 오버랩 40~46 COVER) 빈 파트 (got parts=${l4?.parts.length})`);
  const l3 = c1[3];
  assert(l3 && l3.parts.length === 1 && approx(l3.parts[0].left, 0), `2단 line3 (31.6~38.8, 오버랩 위) 정상 파트`);

  const inOverlay = countCharsInRect(para, col1Chars + bigChars, 46, 81, 40, 46);
  assert(inOverlay === 0, `visible 글자 중 하단 오버랩 영역 교차 0개 (got ${inOverlay})`);
}

console.log(`\n=== 결과: ${passCount} PASS / ${failCount} FAIL ===\n`);
if (failCount > 0) process.exit(1);