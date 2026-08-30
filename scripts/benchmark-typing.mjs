/**
 * ParagraphEngine 타이핑 성능 벤치마크.
 *
 * 실측: 키스트로크당 layoutText() 내부 패스별 소요 시간.
 * 목적: 최적화 전/후 비교용 기준선 수립 — 이론이 아닌 데이터로 병목 식별.
 *
 * 실행: npx tsx scripts/benchmark-typing.mjs
 *
 * @file scripts/benchmark-typing.mjs
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

// ── 폰트 로드 (TTF → base64) ──
const ttfPath = resolve(pkgRoot, 'examples/fonts/KMIBMyoungjo.ttf');
const ttfBase64 = readFileSync(ttfPath).toString('base64');

const { FontLoaderEngineImpl } = await import('../src/engine/font-loader-engine.ts');
const { ColorRegistryEngineImpl } = await import('../src/engine/color-registry-engine.ts');
const { DocumentEngine } = await import('../src/engine/document-engine.ts');

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init([
  { family: 'Myoungjo', base64Data: ttfBase64 },
]);

const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({});

// ── 계측: private 메서드 성능 측정 (프로토타입 패치) ──
const { ParagraphEngine } = await import('../src/engine/paragraph-engine.ts');

const PASS_NAMES = [
  '_computeLayoutInputHash',
  '_parseContents',
  '_layoutColumnsPass',
  '_applyLineBreakRules',
  '_computeCharOffsets',
  '_computePerLineHeights',
  '_computePrefixHash',
  '_buildPrefixCache',
  '_applyPrefixCache',
];

const passStats = new Map(); // name → { totalMs, calls }
for (const name of PASS_NAMES) {
  passStats.set(name, { totalMs: 0, calls: 0 });
}

function instrument(prototype) {
  for (const name of PASS_NAMES) {
    const orig = prototype[name];
    if (typeof orig !== 'function') continue;
    const stats = passStats.get(name);
    prototype[name] = function (...args) {
      const t0 = performance.now();
      try {
        return orig.apply(this, args);
      } finally {
        stats.totalMs += performance.now() - t0;
        stats.calls++;
      }
    };
  }
}
instrument(ParagraphEngine.prototype);

function resetStats() {
  for (const [, s] of passStats) { s.totalMs = 0; s.calls = 0; }
}

function printStats(label, keystrokes) {
  console.log(`\n── ${label} (키스트로크 ${keystrokes}회) ──`);
  console.log('패스                          호출수    총 ms     키당 ms     비중');
  console.log('─────────────────────────────────────────────────────────────');
  let grandTotal = 0;
  const rows = [];
  for (const [name, s] of passStats) {
    if (s.calls === 0) continue;
    grandTotal += s.totalMs;
    rows.push({ name, calls: s.calls, totalMs: s.totalMs });
  }
  rows.sort((a, b) => b.totalMs - a.totalMs);
  for (const r of rows) {
    const perKeystroke = (r.totalMs / keystrokes).toFixed(4);
    const pct = grandTotal > 0 ? ((r.totalMs / grandTotal) * 100).toFixed(1) : '0.0';
    console.log(
      r.name.padEnd(30) +
      String(r.calls).padStart(6) +
      r.totalMs.toFixed(2).padStart(10) +
      perKeystroke.padStart(11) +
      (pct + '%').padStart(8),
    );
  }
  console.log('─────────────────────────────────────────────────────────────');
  console.log(
    'TOTAL'.padEnd(30) +
    ''.padStart(6) +
    grandTotal.toFixed(2).padStart(10) +
    (grandTotal / keystrokes).toFixed(4).padStart(11),
  );
}

// ── 문서 구성 ──
// 신문 기사 스타일: 257×370mm 문서, 다단 문단
function makeCharPool() {
  // 한글 음절 대표 샘플 + 공백 (실제 텍스트 분포 근사)
  const syllables = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허';
  const pool = [];
  for (const s of syllables) pool.push(s);
  return pool;
}

function makeText(charCount) {
  const pool = makeCharPool();
  const parts = [];
  let len = 0;
  let wordLen = 0;
  while (len < charCount) {
    const ch = pool[Math.floor(Math.random() * pool.length)];
    parts.push(ch);
    len++;
    wordLen++;
    // 랜덤 공백 삽입 (워드 평균 3~6자)
    if (wordLen >= 3 && Math.random() < 0.25) {
      parts.push(' ');
      len++;
      wordLen = 0;
    }
  }
  return parts.join('');
}

function buildBoxData(text, columns) {
  return {
    type: 'box',
    id: 'bench-box',
    position: 'absolute',
    left: 10,
    top: 10,
    width: 237,
    height: 350,
    zIndex: 1,
    children: {
      id: 'bench-para',
      type: 'paragraph',
      content: text,
      column: columns,
      gap: 3,
      paragraphStyle: {},
      textStyle: {},
    },
  };
}

function createEngine(text, columns) {
  const docData = {
    id: 'bench-doc',
    width: 257,
    height: 370,
    columns: 6,
    gap: 3,
    paragraphStyle: { lineGap: 1.2 },
    textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
  };
  const engine = DocumentEngine.create(docData, fontLoader, colorRegistry, 3.78);
  engine.layout([buildBoxData(text, columns)]);
  return engine;
}

function runTypingBenchmark(label, charCount, columns, keystrokes) {
  const text = makeText(charCount);

  const engine = createEngine(text, columns);

  // 문단 엔진 찾기
  const boxEngine = engine.childBoxEngines[0];
  const paraEngine = boxEngine.childEngines.find(e => e.constructor.name === 'ParagraphEngine');
  if (!paraEngine) throw new Error('ParagraphEngine not found');

  // 초기 렌더 (타이핑 시뮬레이션 전 1회)
  paraEngine.layoutText();

  resetStats();

  // 타이핑 시뮬레이션: 문단 끝에 1글자씩 추가 (가장 흔한 케이스)
  const t0 = performance.now();
  for (let i = 0; i < keystrokes; i++) {
    const current = typeof paraEngine.textContent === 'string'
      ? paraEngine.textContent
      : paraEngine.textContent.map(b => typeof b === 'string' ? b : b.content).join('');
    const ch = '가나다라마'[i % 5];
    // 문단 끝에 삽입
    paraEngine.textContent = current + ch;
    paraEngine.layoutText();
  }
  const totalMs = performance.now() - t0;

  console.log(`\n${'='.repeat(62)}`);
  console.log(`${label}: ${charCount}자, 컬럼 ${columns}개, 키스트로크 ${keystrokes}회`);
  console.log(`전체 경과: ${totalMs.toFixed(1)}ms (키당 ${(totalMs / keystrokes).toFixed(3)}ms)`);
  printStats(label, keystrokes);

  return paraEngine;
}

// ── 실행 ──
console.log('ParagraphEngine 타이핑 성능 벤치마크');
console.log(`Node ${process.version}`);

// 1. 문단 크기별 (컬럼 1개 고정)
runTypingBenchmark('100자/1컬럼', 100, 1, 200);
runTypingBenchmark('500자/1컬럼', 500, 1, 200);
runTypingBenchmark('1000자/1컬럼', 1000, 1, 200);
runTypingBenchmark('2000자/1컬럼', 2000, 1, 200);

// 2. 컬럼 수별 (1000자 고정)
runTypingBenchmark('1000자/2컬럼', 1000, 2, 200);
runTypingBenchmark('1000자/3컬럼', 1000, 3, 200);
runTypingBenchmark('1000자/6컬럼', 1000, 6, 200);

// 3. 인라인 런 포함 (500자, 10개 런)
{
  const text = makeText(500);
  // 10개 인라인 런: 50자마다 bold 스타일
  const runs = [];
  for (let i = 0; i < 10; i++) {
    const seg = text.slice(i * 50, (i + 1) * 50);
    if (i % 2 === 0) {
      runs.push({ content: seg, textInlineStyle: { fontWeight: 700 } });
    } else {
      runs.push(seg);
    }
  }

  const docData = buildBoxData(runs, 3);
  const engine = DocumentEngine.create(
    {
      id: 'bench-doc',
      width: 257,
      height: 370,
      columns: 6,
      gap: 3,
      paragraphStyle: { lineGap: 1.2 },
      textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader,
    colorRegistry,
    3.78,
  );
  engine.layout([docData]);
  const boxEngine = engine.childBoxEngines[0];
  const paraEngine = boxEngine.childEngines[0];

  paraEngine.layoutText();
  resetStats();

  const keystrokes = 200;
  const t0 = performance.now();
  for (let i = 0; i < keystrokes; i++) {
    // 런 배열 끝에 1글자 추가 (마지막 런이 plain string이므로 단순 append)
    const current = paraEngine.textContent;
    if (Array.isArray(current)) {
      const next = [...current];
      const last = next[next.length - 1];
      const ch = '가나다라마'[i % 5];
      if (typeof last === 'string') {
        next[next.length - 1] = last + ch;
      } else {
        next.push(ch);
      }
      paraEngine.textContent = next;
    } else {
      paraEngine.textContent = current + '가';
    }
    paraEngine.layoutText();
  }
  const totalMs = performance.now() - t0;

  console.log(`\n${'='.repeat(62)}`);
  console.log(`인라인 런 10개/500자/3컬럼: 키스트로크 ${keystrokes}회`);
  console.log(`전체 경과: ${totalMs.toFixed(1)}ms (키당 ${(totalMs / keystrokes).toFixed(3)}ms)`);
  printStats('인라인런', keystrokes);
}

console.log('\n완료.');