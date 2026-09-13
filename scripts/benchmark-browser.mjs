/**
 * 브라우저 전체 파이프라인 성능 벤치마크 (Playwright).
 *
 * 측정: 사용자 상호작용 → layoutText → renderText(DOM diff) 전체 프레임 시간.
 * 시나리오:
 *   1. 텍스트 편집 (연속 타이핑)
 *   2. 오버랩 항목(이미지 박스) 이동 — 재래핑 유발
 *   3. 인라인 스타일 주입 (bold/italic/color + 해제)
 *   4. 인라인 글자크기 주입/수정/제거
 *   5. 문단 정렬 변경
 *   8. 대규모 문서 가상화 (300p 빌드·풀렌더·park·재마운트·타이핑·메모리)
 *      — bench 문서를 교체하므로 마지막에 실행
 *
 * 실행: npx tsx scripts/benchmark-browser.mjs
 * (vite dev server 자동 시작/종료)
 *
 * @file scripts/benchmark-browser.mjs
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const BASE_PORT = 5199;
const BASE_URL_CANDIDATES = [
  'http://localhost:5175', // layout-element dev server
  'http://localhost:5173',
  `http://localhost:${BASE_PORT}`,
];

async function probe(url) {
  try {
    const res = await fetch(url + '/examples/bench.html');
    return res.ok;
  } catch { return false; }
}

let baseUrl = null;
let server = null;
for (const cand of BASE_URL_CANDIDATES) {
  if (await probe(cand)) { baseUrl = cand; break; }
}
if (!baseUrl) {
  server = spawn('npx', ['vite', 'dev', '--port', String(BASE_PORT), '--strictPort'], {
    cwd: pkgRoot,
    stdio: 'pipe',
    shell: true,
  });
  // 서버 ready 대기 — 실제 HTTP 응답으로 확인
  for (let i = 0; i < 60; i++) {
    if (await probe(`http://localhost:${BASE_PORT}`)) { baseUrl = `http://localhost:${BASE_PORT}`; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!baseUrl) throw new Error('vite server not ready');
}

const results = [];

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const n = sorted.length;
  const avg = sorted.reduce((a, b) => a + b, 0) / n;
  const p50 = sorted[Math.floor(n * 0.5)];
  const p95 = sorted[Math.floor(n * 0.95)];
  const max = sorted[n - 1];
  return { n, avg, p50, p95, max };
}

function printResult(label, s) {
  console.log(
    `  ${label.padEnd(24)} n=${String(s.n).padStart(4)}  ` +
    `avg=${s.avg.toFixed(2).padStart(8)}ms  ` +
    `p50=${s.p50.toFixed(2).padStart(8)}ms  ` +
    `p95=${s.p95.toFixed(2).padStart(8)}ms  ` +
    `max=${s.max.toFixed(2).padStart(8)}ms`,
  );
  results.push({ label, ...s });
}

try {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));

  console.log('페이지 로드...');
  await page.goto(baseUrl + '/examples/bench.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.title === 'BENCH_READY', { timeout: 30_000 });
  console.log('준비 완료.\n');

  console.log('=== 브라우저 전체 파이프라인 벤치마크 (2000자 문단, 3컬럼) ===\n');

  // 0. warmup — 폰트/캐시 초기화
  const warmup = await page.evaluate(() => window.bench.typeText(10));
  console.log(`(warmup ${warmup.length}키 완료)\n`);

  // 1. 텍스트 편집 — 입력 동기 시간 + rAF 프레임 델타
  const typeTimes = await page.evaluate(() => window.bench.typeText(150));
  printResult('1. 텍스트 편집(타이핑) — 입력 동기', stats(typeTimes));
  const typingFrames = await page.evaluate(() => window.bench._lastTypingFrames ?? []);
  printResult('1b. 타이핑 rAF 프레임 델타', stats(typingFrames));

  // 2. 오버랩 이미지 이동
  const moveTimes = await page.evaluate(() => window.bench.moveImage(100));
  printResult('2. 오버랩 이미지 이동', stats(moveTimes));

  // 3. 인라인 스타일 주입/해제
  const styleTimes = await page.evaluate(() => window.bench.inlineStyle(24));
  printResult('3. 인라인 스타일 주입', stats(styleTimes));

  // 4. 인라인 글자크기
  const fsTimes = await page.evaluate(() => window.bench.inlineFontSize(18));
  printResult('4. 인라인 글자크기', stats(fsTimes));

  // 5. 정렬 변경
  const alignTimes = await page.evaluate(() => window.bench.alignChange(30));
  printResult('5. 정렬 변경', stats(alignTimes));

  // 6. 분해 계측: 인라인 스타일 시나리오 단계별
  const bd = await page.evaluate(() => window.bench.breakdownInlineStyle(10));
  printResult('6a. focusParagraph+selection (동기)', stats(bd.focusTimes));
  printResult('6b. applyInlineStyle (동기)', stats(bd.applyTimes));

  // 7. 분해 계측: applyInlineStyle 파이프라인 단계별 (동기)
  const bd2 = await page.evaluate(() => window.bench.breakdownApplyStyle(8));
  printResult('7a. applyStyleToRange+plainToInline', stats(bd2.runMap));
  printResult('7b. textContent setter (엔진)', stats(bd2.textContentSetter));
  printResult('7c. layoutText (캐시 히트)', stats(bd2.layoutText));
  printResult('7d. renderText (DOM diff)', stats(bd2.renderText));
  printResult('7e. 전체 합계 (동기)', stats(bd2.full));
  console.log(`    (캐시 히트: ${bd2.cacheHit.filter(Boolean).length}/${bd2.cacheHit.length})`);

  // 8. 대규모 문서 가상화 (300p + 마운트/언마운트) — 노드 수·메모리·재마운트 p95
  console.log('\n=== 8. 대규모 문서 가상화 (300p, bench 문서 교체) ===\n');
  const build = await page.evaluate(() => window.bench.large.buildLargeDoc(300, 600));
  console.log(`  8a. 300p 빌드 (data assign): ${build.assignMs.toFixed(1)}ms`);
  const memBase = await page.evaluate(() => window.bench.large.memoryMB());
  console.log(`  메모리(빌드 직후): ${memBase === null ? 'N/A' : memBase.toFixed(1) + 'MB'}`);

  // 8b. 풀렌더 시도 (풀마운트 기준선 — 시간 초과 시 infeasible 기록이 자체로 근거)
  page.setDefaultTimeout(280000);
  let full = null;
  try {
    full = await page.evaluate(() => window.bench.large.renderAll());
    console.log(`  8b. 300p 풀렌더: ${full.renderMs.toFixed(1)}ms  spans=${full.spans}  nodes=${full.nodes}`);
  } catch (e) {
    console.log(`  8b. 300p 풀렌더: 시간 초과/실패 — 풀마운트 불가 근거 (${String(e).slice(0, 120)})`);
  } finally {
    page.setDefaultTimeout(30000);
  }
  const memFull = await page.evaluate(() => window.bench.large.memoryMB());
  console.log(`  메모리(풀렌더 후): ${memFull === null ? 'N/A' : memFull.toFixed(1) + 'MB'}`);

  // 8c. 윈도우 3p만 남기고 park
  const parked = await page.evaluate(() => window.bench.large.parkAllBut(['bigpage-0', 'bigpage-1', 'bigpage-2']));
  console.log(`  8c. park ${parked.parked}페이지: ${parked.parkMs.toFixed(1)}ms  spans=${parked.spans}  nodes=${parked.nodes}`);
  const memParked = await page.evaluate(() => window.bench.large.memoryMB());
  console.log(`  메모리(윈도우 3p): ${memParked === null ? 'N/A' : memParked.toFixed(1) + 'MB'}`);

  // 8d. 재마운트 사이클 20페이지 (unpark + render, 페이지별)
  const sampleIds = await page.evaluate(() => {
    const L = window.bench.large;
    return L.pageIds.filter((_, i) => i >= 5 && i % 15 === 5).slice(0, 20);
  });
  const remountTimes = await page.evaluate((ids) => window.bench.large.remountCycle(ids), sampleIds);
  printResult('8d. 재마운트 (unpark+render)', stats(remountTimes));

  // 8e. 마운트 페이지 타이핑 (300p 엔진 트리 하에서)
  const typed = await page.evaluate(() => window.bench.large.typeInPage(150, 20));
  printResult('8e. 300p 문서 타이핑 — 입력 동기', stats(typed.inputTimes));
  printResult('8e. 300p 타이핑 rAF 델타', stats(typed.frameDeltas));

  // ── 요약 ──
  console.log('\n── 요약 (60fps 프레임 예산 16.7ms 기준) ──');
  for (const r of results) {
    const verdict = r.p95 <= 16.7 ? '✓ 60fps 이내' : (r.p95 <= 33.4 ? '△ 30fps 수준' : '✗ 프레임 드랍');
    console.log(`  ${r.label.padEnd(24)} p95=${r.p95.toFixed(2)}ms  ${verdict}`);
  }

  await browser.close();
} finally {
  if (server) {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    try { server.kill('SIGKILL'); } catch {}
  }
}

console.log('\n완료.');