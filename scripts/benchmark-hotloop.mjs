/**
 * _layoutColumnsPass 핫 루프 세분 계측.
 *
 * 대상: 매 글자마다 발생하는 비용 요소별 시간 분해
 * 1. _charWidthMm (캐시 키 문자열 생성 + LRU 조회 포함)
 * 2. _createLineWithParts (오버랩 체크 포함)
 * 3. 클로저/pushCharToPart — 측정을 위해 별도 카운터로 글자 수 추적
 *
 * 실행: npx tsx scripts/benchmark-hotloop.mjs
 * @file scripts/benchmark-hotloop.mjs
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
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
colorRegistry.init({});

// ── 세분 계측 ──
const stats = {
  charWidth: { totalMs: 0, calls: 0 },
  createLine: { totalMs: 0, calls: 0 },
  charWidthFromFont: { totalMs: 0, calls: 0 },
};

const p = ParagraphEngine.prototype;
{
  const orig = p._charWidthMm;
  p._charWidthMm = function (...args) {
    const t0 = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      stats.charWidth.totalMs += performance.now() - t0;
      stats.charWidth.calls++;
    }
  };
}
{
  const orig = p._createLineWithParts;
  p._createLineWithParts = function (...args) {
    const t0 = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      stats.createLine.totalMs += performance.now() - t0;
      stats.createLine.calls++;
    }
  };
}
{
  const orig = p._charWidthMmFromFont;
  p._charWidthMmFromFont = function (...args) {
    const t0 = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      stats.charWidthFromFont.totalMs += performance.now() - t0;
      stats.charWidthFromFont.calls++;
    }
  };
}

// ── 벤치마크 ──
const syllables = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허';
function makeText(charCount) {
  const parts = [];
  let len = 0, wordLen = 0;
  while (len < charCount) {
    parts.push(syllables[Math.floor(Math.random() * syllables.length)]);
    len++; wordLen++;
    if (wordLen >= 3 && Math.random() < 0.25) { parts.push(' '); len++; wordLen = 0; }
  }
  return parts.join('');
}

function run(label, charCount, columns, keystrokes) {
  for (const s of Object.values(stats)) { s.totalMs = 0; s.calls = 0; }

  const text = makeText(charCount);
  const engine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );
  engine.layout([{
    type: 'box',
    id: 'box', position: 'absolute', left: 10, top: 10, width: 237, height: 350, zIndex: 1,
    children: {
      id: 'para', type: 'paragraph', content: text, column: columns, gap: 3,
      paragraphStyle: {}, textStyle: {},
    },
  }]);
  const paraEngine = engine.childBoxEngines[0].childEngines[0];
  paraEngine.layoutText();

  // 타이핑 시뮬레이션
  let layoutTotal = 0;
  for (let i = 0; i < keystrokes; i++) {
    const current = typeof paraEngine.textContent === 'string'
      ? paraEngine.textContent
      : paraEngine.textContent.map(b => typeof b === 'string' ? b : b.content).join('');
    paraEngine.textContent = current + '가나다라마'[i % 5];
    const t0 = performance.now();
    paraEngine.layoutText();
    layoutTotal += performance.now() - t0;
  }

  const layoutPassMs = layoutTotal
    - stats.charWidth.totalMs
    - stats.createLine.totalMs;

  console.log(`\n── ${label} (${charCount}자, ${columns}컬럼, ${keystrokes}키) ──`);
  console.log(`layoutText 총:            ${layoutTotal.toFixed(1)}ms (키당 ${(layoutTotal / keystrokes).toFixed(3)}ms)`);
  console.log(`_charWidthMm:             ${stats.charWidth.totalMs.toFixed(1)}ms (${stats.charWidth.calls}회, 키당 ${(stats.charWidth.totalMs / keystrokes).toFixed(3)}ms, ${(stats.charWidth.totalMs / layoutTotal * 100).toFixed(1)}%)`);
  console.log(`_createLineWithParts:      ${stats.createLine.totalMs.toFixed(1)}ms (${stats.createLine.calls}회, 키당 ${(stats.createLine.totalMs / keystrokes).toFixed(3)}ms, ${(stats.createLine.totalMs / layoutTotal * 100).toFixed(1)}%)`);
  console.log(`_charWidthMmFromFont:     ${stats.charWidthFromFont.totalMs.toFixed(1)}ms (${stats.charWidthFromFont.calls}회)`);
  console.log(`나머지 (클로저/배치 등):   ${layoutPassMs.toFixed(1)}ms (키당 ${(layoutPassMs / keystrokes).toFixed(3)}ms, ${(layoutPassMs / layoutTotal * 100).toFixed(1)}%)`);
}

console.log('핫 루프 세분 계측');
run('2000자/1컬럼', 2000, 1, 300);
run('2000자/6컬럼', 2000, 6, 300);