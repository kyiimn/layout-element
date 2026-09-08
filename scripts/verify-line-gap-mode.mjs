/**
 * 행간 고정값 모드 (ParagraphStyle.lineGapMode) 전 파이프라인 정합성 검증 (Node).
 *
 * 배경: `lineGapMode`는 `lineGap`의 해석을 제어한다 — 'ratio'(기존 배율,
 * byte-identical), 'fixed'(고정 mm), 'fixed-min'(최소 보장 mm, 라인
 * maxFontSize가 크면 스케일업). lineHeight 도출은 엔진 단일 소스
 * `computeLineHeightMm()`으로 수렴하고, 캐시 해시는 원시 `lg:`/`lgm:` 키로
 * fixed/fixed-min의 비결정적 base lineHeight를 방어한다.
 *
 * 검증 항목:
 * 1.  기본값 — lineGapMode 생략 ≡ 명시적 'ratio' ≡ 구현 이전 동작 (byte 동일)
 * 2.  fixed — 전 라인 lineHeight === lineGap, 누적 top = i × lineGap,
 *     마지막 라인 높이 = maxFontSize, BoxEngine.absHeight 공식 정합
 * 3.  fixed + 인라인 fontSize 오버라이드 — 라인 높이 불변, 균일 경로 결과 ===
 *     per-line 경로 강제 결과 (fast-path 무결성)
 * 4.  fixed-min — lineGap 5 + 8mm 인라인 런 → 해당 라인만 8, 나머지 5
 * 5.  fixed-min 오버랩 rect 근사 — 근사치 ≥ 실제 방향 보존 (오버랩 회피 안전)
 * 6.  오버플로우 — effectiveColumnHeight 판정 ↔ BoxEngine.absHeight 수용 라인 수 정합
 * 7.  verticalAlign center/bottom — 고정 행간 높이에서 오프셋 정합
 * 8.  해시 충돌 A — (fixed, 6) ↔ (ratio, 1.5) @ fs 4 + 인라인 8mm 런:
 *     base 동일(6)이지만 per-line 상이(6 vs 12) → lgm: 키가 재래핑 트리거
 * 9.  해시 충돌 B — (fixed-min, 3) ↔ (fixed-min, 3.5) + 인라인 3.2mm 런:
 *     base 동일(4)이지만 per-line 상이(3.2 vs 3.5) → lg: 키 방어
 * 10. 개별 setter — engine.paragraphStyle = { lineGapMode, lineGap } +
 *     layoutText() → 정상 재래핑 (개별 setter의 _initLayoutMetrics 방어)
 * 11. GC 정합 — 문서 수준 fixed → gridCalculator.lineHeight === lineGap,
 *     editableTextHeight 수용 라인 수 정합
 * 12. 두 층위 — 문서만 fixed: GC는 문서 스타일, 문단 PE는 문단 스타일을 따름
 * 13. flipLayout — fixed 모드 heightLines 산출 정합
 * 14. prefix 캐시 — 모드 변경 후 타이핑 → lg:/lgm: 키 무효화, 전체 재래핑과 deep equal
 * 15. extractData — 모드 round-trip 보존 + 상속 회귀 제거
 * 16. fixed 계열 lineGap 생략 기본값 — DEFAULT_LINE_GAP_FIXED(6mm),
 *     명시값 우선, ratio 기존 기본값(1.25) 유지, 개별 setter 경로 포함
 *
 * 실행: npx tsx scripts/verify-line-gap-mode.mjs
 *
 * @file scripts/verify-line-gap-mode.mjs
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
const { computeLineHeightMm } = await import('../src/engine/line-height.ts');

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init([{ family: 'Myoungjo', base64Data: ttfBase64 }]);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({});

let passCount = 0;
let failCount = 0;
/**
 * 검증 어설션. 통과/실패를 카운트하고 콘솔에 기록한다.
 *
 * @param {boolean} condition - 검증 조건
 * @param {string} message - 결과 메시지
 * @returns 없음
 * @throws 없음
 */
function assert(condition, message) {
  if (condition) {
    passCount++;
    console.log(`  ✓ ${message}`);
  } else {
    failCount++;
    console.error(`  ✗ ${message}`);
  }
}

/**
 * 부동소수점 근사 비교.
 *
 * @param {number} a - 비교값 1
 * @param {number} b - 비교값 2
 * @param {number} [eps=1e-6] - 허용 오차
 * @returns {boolean} 두 값의 차가 허용 오차 미만이면 `true`
 * @throws 없음
 */
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/**
 * DocumentEngine + 단일 문단 박스로 엔진 트리를 구성하고 layout을 실행한다.
 *
 * @param {string | object[]} content - 문단 텍스트
 * @param {object} [opts] - { boxWidth, boxHeight, columns, fontSize,
 *   paragraphStyle, textStyle, siblings }
 * @returns {object} ParagraphEngine 인스턴스 (layoutText까지 완료된 상태)
 * @throws 없음
 */
function buildPara(content, opts = {}) {
  const {
    boxWidth = 40,
    boxHeight = 26,
    columns = 1,
    fontSize = 4,
    paragraphStyle = {},
    textStyle = {},
    siblings = [],
  } = opts;
  // docLineGap이 명시적으로 undefined인 경우("문서 lineGap 생략")를
  // 구조 분해 기본값과 구분한다 — hasOwnProperty로 전달 여부를 판정한다.
  const docParagraphStyle = Object.prototype.hasOwnProperty.call(opts, 'docLineGap')
    ? (opts.docLineGap === undefined ? { lineGapMode: 'ratio' } : { lineGap: opts.docLineGap })
    : { lineGap: 1.2 };
  const docEngine = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: docParagraphStyle, textStyle: { fontSize, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([
    {
      type: 'box',
      id: 'box', position: 'absolute', left: 10, top: 10, width: boxWidth, height: boxHeight, zIndex: 1,
      children: { id: 'para', type: 'paragraph', content, column: columns, gap: 3, paragraphStyle, textStyle: {} },
    },
    ...siblings,
  ]);
  const paraEngine = docEngine.findEngineById('para');
  paraEngine.layoutText();
  return { paraEngine, docEngine };
}

/**
 * columnContents의 비교용 직렬화. undefined 슬롯은 JSON에서 누락되므로
 * deep equal 비교에 그대로 사용할 수 있다.
 *
 * @param {object} para - ParagraphEngine 인스턴스
 * @returns {string} JSON 직렬화 문자열
 * @throws 없음
 */
const snapshot = (para) => JSON.stringify(para.columnContents);

// ── 실측 폭 프루브 ──
const { paraEngine: probe } = buildPara('가 8.(.', { textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } });
const gaW = probe.getCharWidths('가').swidth;
const baW = probe.getCharWidths('바').swidth;

// ═══ 1. 기본값 — 생략 ≡ 명시적 'ratio' ═══
console.log('\nTest 1: 기본값 — lineGapMode 생략 ≡ 명시적 ratio (byte 동일)');
{
  const content = '가'.repeat(30);
  // 문단 주입 없음(문서 상속 lineGap 1.2 ratio) vs 문단 명시 {1.2, ratio} — 동일 값 비교
  const omitted = buildPara(content, {});
  const explicit = buildPara(content, { paragraphStyle: { lineGap: 1.2, lineGapMode: 'ratio' } });
  const otherGap = buildPara(content, { paragraphStyle: { lineGap: 1.5, lineGapMode: 'ratio' } });

  assert(snapshot(omitted.paraEngine) === snapshot(explicit.paraEngine),
    "문단 주입 생략(상속) === 명시적 'ratio' 동일 값 (byte 동일)");
  assert(snapshot(otherGap.paraEngine) !== snapshot(explicit.paraEngine),
    '다른 lineGap(1.5)은 다른 배치 — 비교 기준 유효성');
  const fs = 4, gap = 1.5;
  assert(approx(otherGap.paraEngine.baseLineHeight, computeLineHeightMm(gap, 'ratio', fs)),
    `baseLineHeight === fs × gap (${otherGap.paraEngine.baseLineHeight})`);
}

// ═══ 2. fixed — 전 라인 고정 높이 + static absHeight 정합 ═══
console.log('\nTest 2: fixed — lineHeight === lineGap (fontSize 무시)');
{
  const FIXED_GAP = 6;
  const content = '가'.repeat(30);
  // static 박스 + 컬럼 기반 그리드로 구성 (absHeight 공식은 static 대상)
  const docEngine = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: FIXED_GAP, lineGapMode: 'fixed' }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([
    { type: 'box', id: 'box', position: 'static', left: 0, top: 0, width: 1, height: 26, zIndex: 1,
      children: { id: 'para', type: 'paragraph', content, textStyle: {} } },
  ]);
  const paraEngine = docEngine.findEngineById('para');
  paraEngine.layoutText();

  const lines = paraEngine.columnContents[0];
  assert(lines.length > 1, `여러 라인 생성 (got ${lines.length})`);
  assert(lines.every(l => approx(l.lineHeight, FIXED_GAP)),
    `전 라인 lineHeight === ${FIXED_GAP}mm`);
  assert(lines.every(l => approx(l.maxFontSize, 4)),
    `maxFontSize는 문단 fontSize 4 유지 (수직 앵커 근거)`);

  // BoxEngine.absHeight = lineHeight × N − (lineHeight − fontSize) — RULES §1.8
  const boxEngine = docEngine.findEngineById('box');
  const N = boxEngine.height;
  assert(approx(boxEngine.absHeight, FIXED_GAP * N - (FIXED_GAP - 4)),
    `absHeight === ${FIXED_GAP}×${N} − (${FIXED_GAP}−4) = ${(FIXED_GAP * N - (FIXED_GAP - 4)).toFixed(2)} (got ${boxEngine.absHeight.toFixed(2)})`);

  // 컬럼 수용: effectiveColumnHeight = parentHeight + (lineHeight − fontSize)
  const parentHeight = paraEngine.inheritStyle.parentHeight;
  assert(approx(parentHeight, boxEngine.absHeight), 'PE parentHeight === box absHeight (수용력 단일 소스)');
}

// ═══ 3. fixed + 인라인 오버라이드 — 균일 경로 === per-line 경로 ═══
console.log('\nTest 3: fixed + 인라인 fontSize 오버라이드 — 라인 높이 불변 + fast-path 무결성');
{
  const FIXED_GAP = 6;
  const content = [
    { content: '가'.repeat(10) },
    { content: '바'.repeat(6), textInlineStyle: { fontSize: 8 } },
    { content: '가'.repeat(30) },
  ];
  const fixed = buildPara(content, { paragraphStyle: { lineGap: FIXED_GAP, lineGapMode: 'fixed' } }).paraEngine;

  const allLines = fixed.columnContents.flat();
  assert(allLines.length >= 3, `인라인 큰 글자 포함 배치 (라인 ${allLines.length}개)`);
  assert(allLines.every(l => approx(l.lineHeight, FIXED_GAP)),
    `인라인 8mm 런이 있어도 전 라인 lineHeight === ${FIXED_GAP}`);
  const bigLine = allLines.find(l => l.parts.some(p => p.inlineStyles?.some(s => s?.fontSize === 8)));
  assert(bigLine !== undefined, '8mm 인라인 런 존재 (전제)');
  assert(approx(bigLine.maxFontSize, 8), '큰 글자 라인의 maxFontSize === 8 (수직 앵커)');
  assert(approx(bigLine.lineHeight, FIXED_GAP), `큰 글자 라인도 lineHeight === ${FIXED_GAP} (고정)`);
}

// ═══ 4. fixed-min — 인라인 큰 글자 라인만 스케일업 ═══
console.log("\nTest 4: fixed-min — max(lineGap, maxFontSize) 스케일업");
{
  const content = [
    { content: '가'.repeat(10) },
    { content: '바'.repeat(6), textInlineStyle: { fontSize: 8 } },
    { content: '가'.repeat(20) },
  ];
  const para = buildPara(content, { paragraphStyle: { lineGap: 5, lineGapMode: 'fixed-min' } }).paraEngine;
  const allLines = para.columnContents.flat();

  const smallLines = allLines.filter(l => !l.parts.some(p => p.inlineStyles?.some(s => s?.fontSize === 8)));
  const bigLines = allLines.filter(l => l.parts.some(p => p.inlineStyles?.some(s => s?.fontSize === 8)));
  assert(smallLines.length > 0 && bigLines.length > 0, '작은/큰 글자 라인 모두 존재 (전제)');
  assert(smallLines.every(l => approx(l.lineHeight, 5)), '작은 글자 라인 lineHeight === 5 (고정값)');
  assert(bigLines.every(l => approx(l.lineHeight, 8)), '큰 글자 라인 lineHeight === 8 (max(5, 8) 스케일업)');

  // fixed-min 무오버라이드 문단: 전 라인 = max(lineGap, fs)
  const plain = buildPara('가'.repeat(30), { paragraphStyle: { lineGap: 5, lineGapMode: 'fixed-min' } }).paraEngine;
  assert(plain.columnContents[0].every(l => approx(l.lineHeight, Math.max(5, 4))),
    "무오버라이드 fixed-min: 전 라인 === max(5, 4) = 5 (균일)");
}

// ═══ 5. fixed-min 오버랩 rect 근사 ≥ 실제 (과도 회피 안전 방향) ═══
console.log('\nTest 5: fixed-min 오버랩 rect 근사 — 근사 ≥ 실제 방향');
{
  // 8mm 인라인 런이 있는 문단 + 오버랩 박스 (문서 형제 박스)
  const content = [
    { content: '가'.repeat(10) },
    { content: '바'.repeat(8), textInlineStyle: { fontSize: 8 } },
    { content: '가'.repeat(20) },
  ];
  const overlay = {
    type: 'box', id: 'ovl', position: 'absolute',
    left: 15, top: 12, width: 20, height: 6, zIndex: 10,
    children: { id: 'ovl-para', type: 'paragraph', content: '오버랩영역', paragraphStyle: {}, textStyle: {} },
  };
  const { paraEngine } = buildPara(content, {
    boxWidth: 40, boxHeight: 60, paragraphStyle: { lineGap: 5, lineGapMode: 'fixed-min' }, siblings: [overlay],
  });

  // 회피 결과의 모든 라인 rect 높이가 확정 per-line 높이 이상이면 근사 방향 안전.
  // 근사치(pendingMax 스캔) ≥ 실제 배치 maxFs이므로 max(lineGap, 근사) ≥ max(lineGap, 실제).
  let rectOk = true;
  for (const column of paraEngine.columnContents) {
    for (const line of column) {
      if (line.lineHeight === undefined || line.lineHeight < 5 - 1e-6) rectOk = false;
    }
  }
  assert(rectOk, '모든 라인 rect/확정 높이 ≥ lineGap (하한 보장)');
  const bigLines = paraEngine.columnContents.flat().filter(l => l.parts.some(p => p.inlineStyles?.some(s => s?.fontSize === 8)));
  assert(bigLines.every(l => approx(l.lineHeight, 8)), '큰 글자 라인 rect 높이 === 8 (스케일업 반영)');
}

// ═══ 6. 오버플로우 판정 ↔ absHeight 정합 (static 박스) ═══
console.log('\nTest 6: 오버플로우 — effectiveColumnHeight ↔ absHeight 공식 정합');
{
  for (const ps of [
    { lineGap: 6, lineGapMode: 'fixed' },
    { lineGap: 3, lineGapMode: 'fixed' },
    { lineGap: 5, lineGapMode: 'fixed-min' },
    { lineGap: 1.2 },
  ]) {
    const content = '가'.repeat(200);
    // static 박스 — absHeight 공식의 대상
    const docEngine = DocumentEngine.create(
      {
        id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
        paragraphStyle: ps, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
      },
      fontLoader, colorRegistry, 3.78,
    );
    docEngine.layout([
      { type: 'box', id: 'box', position: 'static', left: 0, top: 0, width: 1, height: 26, zIndex: 1,
        children: { id: 'para', type: 'paragraph', content, textStyle: {} } },
    ]);
    const paraEngine = docEngine.findEngineById('para');
    paraEngine.layoutText();
    const boxEngine = docEngine.findEngineById('box');
    const L = paraEngine.baseLineHeight;
    const fs = paraEngine.fontSize;
    const label = `[lg=${ps.lineGap}, mode=${ps.lineGapMode ?? 'ratio'}]`;
    // RULES §1.8: absHeight = L × N − (L − fs), N = 박스 height(라인 수)
    assert(approx(boxEngine.absHeight, L * 26 - (L - fs)),
      `${label} absHeight === L×26 − (L−fs) = ${(L * 26 - (L - fs)).toFixed(2)} (got ${boxEngine.absHeight.toFixed(2)})`);
    // PE parentHeight(box absHeight) 수용력과 실제 배치 정합:
    // 배치된 라인 수 ≤ floor((parentHeight − fs) / L) + 1
    const maxFittable = Math.floor((paraEngine.inheritStyle.parentHeight - fs) / L + 1e-9) + 1;
    const placed = paraEngine.columnContents.flat().length;
    assert(placed <= maxFittable, `${label} 배치 라인 수 ${placed} ≤ 공식 수용 ${maxFittable}`);
  }
}

// ═══ 7. verticalAlign center/bottom — 고정 행간 오프셋 ═══
console.log('\nTest 7: verticalAlign — 고정 행간에서 center/bottom 오프셋');
{
  const content = '가'.repeat(20);
  const center = buildPara(content, {
    boxHeight: 40, paragraphStyle: { lineGap: 6, lineGapMode: 'fixed', verticalAlign: 'center' },
  }).paraEngine;
  const top = buildPara(content, {
    boxHeight: 40, paragraphStyle: { lineGap: 6, lineGapMode: 'fixed', verticalAlign: 'top' },
  }).paraEngine;

  const lineCount = center.columnContents[0].length;
  const nLines = top.columnContents[0].length;
  assert(nLines > 0 && lineCount === nLines, `라인 수 불변 (top=${nLines}, center=${lineCount})`);
  // contentHeight = (N−1)×6 + 4; center offset = (parentHeight − contentHeight)/2 > 0
  const parentH = center.inheritStyle.parentHeight;
  const contentH = (nLines - 1) * 6 + 4;
  if (parentH > contentH) {
    const expectedOffset = (parentH - contentH) / 2;
    const alignOffset = center._computeAlignOffsetMm(
      center.columnContents[0], parentH + (6 - 4), 4, parentH,
    );
    assert(approx(alignOffset, expectedOffset),
      `center 오프셋 === (parentH − contentH)/2 = ${expectedOffset.toFixed(3)} (got ${alignOffset.toFixed(3)})`);
  }
}

// ═══ 8. 해시 충돌 A — (fixed, 6) ↔ (ratio, 1.5) base 동일, per-line 상이 ═══
console.log('\nTest 8: 해시 충돌 A — lgm: 키가 모드 전환 재래핑을 트리거');
{
  const content = [
    { content: '가'.repeat(10) },
    { content: '바'.repeat(6), textInlineStyle: { fontSize: 8 } },
    { content: '가'.repeat(30) },
  ];
  const para = buildPara(content, { paragraphStyle: { lineGap: 6, lineGapMode: 'fixed' } }).paraEngine;
  const fixedSnapshot = snapshot(para);
  assert(para.columnContents.flat().every(l => approx(l.lineHeight, 6)), 'fixed 상태: 전 라인 6 (전제)');

  // 동일 lineGap 값 6, 모드만 ratio로 전환 → base = 8 × 1.5 = 12 ≠ 6이라
  // 이 경우 lh가 달라져 재래핑이 자명하다. 진짜 충돌 재현은 fs 4 기준
  // (fixed, 6) → (ratio, 1.5)로 값까지 바꿔 base를 6으로 맞춘다.
  para.paragraphStyle = { lineGap: 1.5, lineGapMode: 'ratio' };
  para.layoutText();
  const ratioLines = para.columnContents.flat();
  const bigLine = ratioLines.find(l => l.parts.some(p => p.inlineStyles?.some(s => s?.fontSize === 8)));
  assert(approx(bigLine.lineHeight, 12),
    `(ratio, 1.5) 전환 → 큰 글자 라인 lineHeight === 12 (8 × 1.5) — fixed 6과 구별`);
  assert(snapshot(para) !== fixedSnapshot, '모드+값 전환 시 배치 변화 (재래핑 발생)');

  // base가 동일한 충돌: (fixed, 6) → (fixed-min, 6) — base 모두 6
  // (fs 4 ≤ 6), 인라인 8 라인은 fixed-min에서 max(6, 8) = 8.
  const para2 = buildPara(content, { paragraphStyle: { lineGap: 6, lineGapMode: 'fixed' } }).paraEngine;
  para2.paragraphStyle = { lineGap: 6, lineGapMode: 'fixed-min' };
  para2.layoutText();
  const minLines = para2.columnContents.flat();
  const bigLine2 = minLines.find(l => l.parts.some(p => p.inlineStyles?.some(s => s?.fontSize === 8)));
  assert(approx(bigLine2.lineHeight, 8),
    `(fixed, 6) → (fixed-min, 6) 전환 → 큰 글자 라인 6 → 8 (lgm: 키가 stale 캐시 방어)`);
}

// ═══ 9. 해시 충돌 B — 동일 mode lineGap 전환 → lg: 원시 키 재래핑 ═══
console.log('\nTest 9: 해시 충돌 B — lg: 원시 키가 lineGap 전환 재래핑을 트리거');
{
  // base 불변식(maxFs ≥ baseFontSize) 하의 실제 상이 케이스:
  // fs 4, 인라인 8(maxFs 8) 라인 — lineGap 3 → 5 전환:
  //   max(3, 8) = 8 → max(5, 8) = 8 (큰 글자 라인 동일)
  //   base = max(3, 4) = 4 → max(5, 4) = 5 (base 변화 → lh: 감지)
  // lineGap이 fs를 crossing하는 전환(3 → 5)은 lh: 로도 잡히지만,
  // fs 이하 구간 전환(3 → 3.5)은 base 동일(4) — 이때 per-line도
  // max(lineGap, maxFs ≥ fs)에서 maxFs ≥ fs 불변식으로 인해 동일하다
  // (maxFs < lineGap ≤ fs 조합은 maxFs ≥ fs와 모순 — 불가능).
  // → lg: 키는 fixed-min의 하한 방어이며, 실측으로는 base 구간 전환을 검증한다.
  const content = [
    { content: '가'.repeat(10) },
    { content: '바'.repeat(6), textInlineStyle: { fontSize: 8 } },
    { content: '가'.repeat(30) },
  ];
  const para = buildPara(content, { paragraphStyle: { lineGap: 3, lineGapMode: 'fixed-min' } }).paraEngine;
  const snapA = snapshot(para);
  const lineA = para.columnContents.flat().find(l => l.parts.some(p => p.inlineStyles?.some(s => s?.fontSize === 8)));
  assert(approx(lineA.lineHeight, 8), `(fixed-min, 3): 인라인 8 라인 === max(3, 8) = 8 (전제)`);
  assert(para.columnContents.flat().filter(l => !l.parts.some(p => p.inlineStyles?.some(s => s?.fontSize === 8))).every(l => approx(l.lineHeight, 4)),
    `(fixed-min, 3): base 라인 === max(3, 4) = 4 (fs 하한)`);

  para.paragraphStyle = { lineGap: 5, lineGapMode: 'fixed-min' };
  para.layoutText();
  const lineB = para.columnContents.flat().find(l => l.parts.some(p => p.inlineStyles?.some(s => s?.fontSize === 8)));
  const baseLineB = para.columnContents.flat().find(l => !l.parts.some(p => p.inlineStyles?.some(s => s?.fontSize === 8)));
  assert(approx(lineB.lineHeight, 8), `(fixed-min, 5): 인라인 8 라인 === max(5, 8) = 8`);
  assert(approx(baseLineB.lineHeight, 5), `(fixed-min, 5): base 라인 === max(5, 4) = 5 — lg: 키가 재래핑 트리거`);
  assert(snapshot(para) !== snapA, 'lineGap 전환 시 배치 변화 (stale 캐시 없음)');
}

// ═══ 10. 개별 setter — engine.paragraphStyle 주입 경로 ═══
console.log('\nTest 10: 개별 setter — paragraphStyle 주입 + layoutText → 정상 재래핑');
{
  const content = '가'.repeat(30);
  const para = buildPara(content, {}).paraEngine;
  const before = snapshot(para);
  assert(para.columnContents.flat().every(l => approx(l.lineHeight, 4 * 1.2)), '초기 ratio 배치 (전제)');

  para.paragraphStyle = { lineGap: 6, lineGapMode: 'fixed' };
  para.layoutText();
  assert(para.columnContents.flat().every(l => approx(l.lineHeight, 6)),
    '개별 setter lineGapMode 주입 → 전 라인 lineHeight 6 (stale 캐시 없음)');
  assert(snapshot(para) !== before, '개별 setter 주입으로 배치 변화 (재래핑 발생)');

  // textStyle 개별 setter도 동일 (fontSize 변경 → lineHeight 갱신)
  para.textStyle = { fontSize: 5 };
  para.layoutText();
  assert(para.columnContents.flat().every(l => approx(l.lineHeight, 6)),
    '개별 textStyle setter (fontSize 5) 후에도 fixed 6 유지 (fontSize 무관)');
}

// ═══ 11. GC 정합 — 문서 수준 fixed → gridCalculator.lineHeight ═══
console.log('\nTest 11: GC — 문서 수준 fixed 모드 → gridCalculator.lineHeight === lineGap');
{
  const docEngine = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 6, lineGapMode: 'fixed' }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([]);
  const gc = docEngine.gridCalculator;
  assert(approx(gc.lineHeight, 6), `gridCalculator.lineHeight === 6 (got ${gc.lineHeight})`);
  assert(approx(gc.lineHeight, computeLineHeightMm(6, 'fixed', 4)), 'computeLineHeightMm 단일 소스 정합');
  // editableTextHeight: height/padding 기반이므로 불변 — lineHeight가 fixed여도 동일
  assert(gc.editableTextHeight > 0, 'editableTextHeight > 0');
}

// ═══ 12. 두 층위 — GC는 문서 스타일, PE는 문단 스타일 ═══
console.log('\nTest 12: 두 층위 — 카스케이드 정합 (문서 fixed + 문단 오버라이드)');
{
  const docEngine = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 8, lineGapMode: 'fixed' }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([
    {
      type: 'box', id: 'box', position: 'absolute', left: 10, top: 10, width: 40, height: 60, zIndex: 1,
      children: { id: 'para', type: 'paragraph', content: '가'.repeat(30), column: 1, gap: 3,
        paragraphStyle: { lineGap: 1.5, lineGapMode: 'ratio' }, textStyle: {} },
    },
  ]);
  const pe = docEngine.findEngineById('para');
  pe.layoutText();
  assert(approx(docEngine.gridCalculator.lineHeight, 8), 'GC lineHeight === 문서 fixed 8');
  assert(approx(pe.baseLineHeight, 4 * 1.5), 'PE baseLineHeight === 문단 ratio 6 (독립)');
  assert(pe.columnContents[0].every(l => approx(l.lineHeight, 6)), '문단 라인 높이 === 6 (문단 스타일)');

  // 카스케이드: 문단이 lineGap만 오버라이드하고 모드를 생략 → 문서 모드(fixed) 상속
  const docEngine2 = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 8, lineGapMode: 'fixed' }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine2.layout([
    {
      type: 'box', id: 'box', position: 'absolute', left: 10, top: 10, width: 40, height: 60, zIndex: 1,
      children: { id: 'para', type: 'paragraph', content: '가'.repeat(30), column: 1, gap: 3,
        paragraphStyle: { lineGap: 3 }, textStyle: {} },
    },
  ]);
  const pe2 = docEngine2.findEngineById('para');
  pe2.layoutText();
  assert(approx(pe2.baseLineHeight, 3), '문단 lineGap만 오버라이드 → 상속 모드 fixed로 3mm 해석 (카스케이드)');
  assert(pe2.columnContents[0].every(l => approx(l.lineHeight, 3)), '라인 높이 === 3 (상속 모드 적용)');
}

// ═══ 13. flipLayout — fixed 모드 heightLines ═══
console.log('\nTest 13: flipLayout — fixed 모드에서 수직 반전 정합');
{
  const docEngine = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 200, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 6, lineGapMode: 'fixed' }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([
    { type: 'box', id: 'b1', position: 'static', left: 0, top: 1, width: 2, height: 5, zIndex: 1,
      children: { id: 'p1', type: 'paragraph', content: '가'.repeat(30), textStyle: {} } },
  ]);
  // FlipLayoutOptions는 { axis } 객체 — 문자열 전달은 axis undefined로 무동작
  const flipped = docEngine.flipLayout({ axis: 'vertical' });
  const flippedBox = flipped.children.find(b => b.id === 'b1');
  // heightLines = innerHeight / lineHeight = 200 / 6 — fixed 모드로 계산
  const expectedTop = 200 / 6 - 1 - 5;
  assert(flippedBox !== undefined, 'flipLayout 결과에 박스 존재');
  assert(approx(flippedBox.top, expectedTop),
    `수직 반전 top === heightLines − top − height = ${expectedTop.toFixed(3)} (got ${flippedBox.top})`);
  // ratio 모드와의 차이 검증: fixed 6은 heightLines = 33.33, ratio 1.25는 40
  const docEngineRatio = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 200, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 1.25 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docEngineRatio.layout([
    { type: 'box', id: 'b1', position: 'static', left: 0, top: 1, width: 2, height: 5, zIndex: 1,
      children: { id: 'p1', type: 'paragraph', content: '가'.repeat(30), textStyle: {} } },
  ]);
  const flippedRatio = docEngineRatio.flipLayout({ axis: 'vertical' });
  assert(approx(flippedRatio.children[0].top, 200 / 5 - 1 - 5),
    'ratio 기준 반전 top === 200/5 − 1 − 5 (모드별 lineHeight 반영)');
}

// ═══ 14. prefix 캐시 — 모드 변경 후 타이핑 무효화 ═══
console.log('\nTest 14: prefix 캐시 — 모드 변경 시 lg:/lgm: 키로 무효화');
{
  const text1 = '가'.repeat(30);
  const OPTS = { boxWidth: 70, boxHeight: 30, columns: 2, paragraphStyle: { lineGap: 6, lineGapMode: 'fixed' } };
  const { paraEngine: on } = buildPara(text1, OPTS);
  on.textContent = text1 + '바';
  on.caretHint = text1.length;
  on.layoutText();
  const typedSnapshot = snapshot(on);

  // 동일 입력 재layoutText → 캐시 히트 (결과 동일)
  on.caretHint = text1.length;
  on.layoutText();
  assert(snapshot(on) === typedSnapshot, '동일 입력 캐시 히트 (결과 동일)');

  // 모드만 변경 → lgm: 키로 prefix 캐시 무효화 → 전체 재래핑과 deep equal
  on.paragraphStyle = { lineGap: 6, lineGapMode: 'fixed-min' };
  on.caretHint = text1.length;
  on.layoutText();
  const full = buildPara(text1 + '바', { ...OPTS, paragraphStyle: { lineGap: 6, lineGapMode: 'fixed-min' } }).paraEngine;
  assert(snapshot(on) === snapshot(full), '모드 변경 후 prefix 캐시 경로 === 전체 재래핑 (deep equal)');
}

// ═══ 15. extractData round-trip ═══
console.log('\nTest 15: extractData — lineGapMode round-trip + 상속 회귀');
{
  const { paraEngine } = buildPara('가'.repeat(10), { paragraphStyle: { lineGap: 6, lineGapMode: 'fixed' } });
  const data = paraEngine.extractData;
  assert(data.paragraphStyle?.lineGapMode === 'fixed', '주입 lineGapMode 보존');
  assert(data.paragraphStyle?.lineGap === 6, '주입 lineGap 보존');

  const omitted = buildPara('가'.repeat(10), {}).paraEngine.extractData;
  assert(omitted.paragraphStyle?.lineGapMode === undefined, '미주입 시 필드 부재 (ratio 기본)');
}

// ═══ 16. fixed 계열 lineGap 생략 기본값 — DEFAULT_LINE_GAP_FIXED ═══
console.log('\nTest 16: fixed/fixed-min lineGap 생략 → 기본 6mm (배율 기본값 mm 재해석 방지)');
{
  const content = '가'.repeat(30);
  // 카스케이드 계약: 상속 lineGap이 없어야 모드별 기본값이 적용된다.
  const fixedDefault = buildPara(content, { docLineGap: undefined, paragraphStyle: { lineGapMode: 'fixed' } }).paraEngine;
  assert(fixedDefault.columnContents[0].every(l => approx(l.lineHeight, 6)),
    `mode만 주입 fixed → 라인 높이 === 6 (DEFAULT_LINE_GAP_FIXED, got ${fixedDefault.columnContents[0][0]?.lineHeight})`);
  assert(approx(fixedDefault.baseLineHeight, 6), 'baseLineHeight === 6');

  const fixedMinDefault = buildPara(content, { docLineGap: undefined, paragraphStyle: { lineGapMode: 'fixed-min' } }).paraEngine;
  assert(fixedMinDefault.columnContents[0].every(l => approx(l.lineHeight, 6)),
    'mode만 주입 fixed-min → 라인 높이 === 6 (기본값)');

  // 문서 자체가 fixed 명시 6 → GC도 6mm (GC getter resolveLineGap)
  const docFixed = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 6, lineGapMode: 'fixed' }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docFixed.layout([]);
  assert(approx(docFixed.gridCalculator.lineHeight, 6), '문서 fixed 명시 6 → GC lineHeight === 6');

  // 문서가 mode만 주입(fixed) → GC도 기본 6mm
  const docFixedDefault = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGapMode: 'fixed' }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docFixedDefault.layout([]);
  assert(approx(docFixedDefault.gridCalculator.lineHeight, 6), '문서 mode만 주입 fixed → GC lineHeight === 6 (기본값)');

  // 명시 lineGap은 항상 유지 (기본값이 덮어쓰지 않음)
  const explicit = buildPara(content, { paragraphStyle: { lineGap: 4, lineGapMode: 'fixed' } }).paraEngine;
  assert(explicit.columnContents[0].every(l => approx(l.lineHeight, 4)),
    '명시 lineGap 4는 유지 (기본값 6이 덮어쓰지 않음)');

  // ratio 모드 생략은 기존 기본값(1.25) 유지 — byte-identical
  const ratioDefault = buildPara(content, { docLineGap: undefined, paragraphStyle: { lineGapMode: 'ratio' } }).paraEngine;
  assert(approx(ratioDefault.baseLineHeight, 4 * 1.25), "mode 'ratio' 생략 lineGap → 기존 1.25 유지");

  // 생략(아무것도 없음) === ratio 명시 — 기존 동작 무손실
  const none = buildPara(content, { docLineGap: undefined, paragraphStyle: {} }).paraEngine;
  assert(approx(none.baseLineHeight, 4 * 1.25), '전부 생략 → 기존 1.25 배율 (기존 동작)');

  // 상속 lineGap이 있으면 그 값이 모드로 해석된다 (카스케이드 — 기본값 적용 대상 아님)
  const inherited = buildPara(content, { paragraphStyle: { lineGapMode: 'fixed' } }).paraEngine;
  assert(approx(inherited.baseLineHeight, 1.2),
    '상속 lineGap 1.2 + mode만 주입 → 상속값 1.2를 fixed로 해석 (카스케이드 우선)');

  // 개별 setter 경로에서도 동일: mode만 주입 (상속 lineGap 없는 환경)
  const { paraEngine: setterPara } = buildPara(content, { docLineGap: undefined, paragraphStyle: {} });
  setterPara.paragraphStyle = { lineGapMode: 'fixed' };
  setterPara.layoutText();
  assert(setterPara.columnContents[0].every(l => approx(l.lineHeight, 6)),
    '개별 setter mode만 주입 → 기본 6mm (stale 캐시 없음)');

  // 캐시 해시 lg: 키가 보정값을 반영 — mode만 주입 → 1.25 → 6 전환 시 재래핑
  const para2 = buildPara(content, { docLineGap: undefined, paragraphStyle: {} }).paraEngine;
  const snapBefore = snapshot(para2);
  para2.paragraphStyle = { lineGapMode: 'fixed' };
  para2.layoutText();
  assert(snapshot(para2) !== snapBefore && para2.columnContents[0].every(l => approx(l.lineHeight, 6)),
    'mode만 주입 전환 → 해시 무효화 + 기본 6mm 재래핑');
}

// ═══ 요약 ═══
console.log(`\n${'═'.repeat(60)}`);
console.log(`결과: ${passCount} 통과, ${failCount} 실패`);
console.log('═'.repeat(60));
if (failCount > 0) process.exit(1);