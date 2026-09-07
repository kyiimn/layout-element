/**
 * 걸침표 브라우저 렌더링 검증 — 걸침 ON 상태의 실제 화면 페인트 (Node).
 *
 * 기존 브라우저 검증(dom-diff/visual-render/ime/multicolumn/...)은 걸침
 * OFF 상태로 동작하므로(회귀 방어), 걸침 ON의 **화면 결과** — 파트 밖
 * span 페인트, 컬럼/호스트 overflow 해제 — 는 별도 검증이 필요하다.
 *
 * 핵심 함정: `overflow: hidden`은 `getBoundingClientRect()`(레이아웃
 * 기하)에는 영향을 주지 않고 **페인트만 클립**한다. 따라서 rect 비교로는
 * 클리핑을 감지할 수 없고, 실제 hit-test인 `document.elementFromPoint`로
 * 걸침 글자 위의 최상위 페인트 요소가 걸침 span 자체인지를 확인해야 한다
 * (클립되었다면 hit이 span에 도달할 수 없다).
 *
 * 검증 항목:
 * 1.  OFF 상태 — hangs 마킹 없음 + overflow 'hidden' (기존 동작 보존)
 * 2.  ON 토글 — 문단 스타일 주입만으로 재래핑 + 닫기 부호 run이 위 줄
 *     끝으로 당겨짐 (엔진 columnContents)
 * 3.  아래 줄이 부호로 시작하지 않음 + 걸침 run 스택형 오프셋
 * 4.  ON 상태 컬럼/문단 호스트 overflow 'visible' (computed style)
 * 5.  걸침 span DOM 존재 + data-char-offset === partWidth (엔진 → DOM 반영)
 * 6.  걸침 span 화면 rect가 컬럼 밖으로 연장 (rect 기반)
 * 7.  elementFromPoint(걸침 span 중심) === 걸침 span — 실제 페인트 확인
 * 8.  OFF 재토글 — 원상 복구 (hangs 소멸 + overflow 'hidden')
 *
 * 실행: npx tsx scripts/verify-hanging-punctuation-browser.mjs
 *       (dev server 없으면 자체 스폰 — 포트 5198)
 *
 * @file scripts/verify-hanging-punctuation-browser.mjs
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5198;

// 라이브 서버 후보. probe는 HTML title까지 검증해야 한다 — 타 앱 Vite
// 서버(SPA fallback)는 존재하지 않는 경로에도 200을 반환한다.
/**
 * 후보 URL이 layout-element의 bench 페이지를 실제로 서빙하는지 검증한다.
 *
 * @param {string} url - 후보 base URL
 * @returns {Promise<boolean>} bench 페이지 서빙 여부
 * @throws 없음
 */
async function probe(url) {
  try {
    const res = await fetch(`${url}/examples/bench.html`);
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes('<title>Layout Element Benchmark</title>');
  } catch { return false; }
}

/**
 * 스폰한 vite 서버가 응답할 때까지 폴링한다. 최대 30초.
 *
 * @param {string} url - 스폰 서버 base URL
 * @returns {Promise<boolean>} 서버 준비 완료 여부
 * @throws 없음
 */
async function waitForServer(url) {
  for (let i = 0; i < 60; i++) {
    if (await probe(url)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

let baseUrl = null;
let server = null;
for (const cand of ['http://localhost:5175', 'http://localhost:5173']) {
  if (await probe(cand)) { baseUrl = cand; break; }
}
if (!baseUrl) {
  server = spawn('npx', ['vite', 'dev', '--port', String(BASE_PORT), '--strictPort'], {
    cwd: pkgRoot, stdio: 'pipe', shell: true,
  });
  const spawnedUrl = `http://localhost:${BASE_PORT}`;
  if (await waitForServer(spawnedUrl)) baseUrl = spawnedUrl;
  else { server.kill(); throw new Error(`vite dev server not ready on ${spawnedUrl}`); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', err => console.error('[pageerror]', err.message));
await page.goto(`${baseUrl}/examples/bench.html?_=${Date.now()}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.title === 'BENCH_READY', { timeout: 30_000 });

const failures = [];
/**
 * 검증 체크. 통과/실패를 콘솔에 기록하고 실패 목록에 수집한다.
 *
 * @param {string} name - 체크 이름
 * @param {boolean} ok - 통과 여부
 * @param {string} [detail=''] - 부가 정보
 * @returns 없음
 * @throws 없음
 */
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const r = await page.evaluate(async () => {
  const out = {};
  const p = window.bench.getParaBox().querySelector('x-layout-paragraph');

  const engine = p.engine;
  const colW = engine.columnWidths[0];
  const gaW = engine.getCharWidths('가').swidth;
  const dotW = engine.getCharWidths('.').swidth;
  const perLine = Math.floor((colW + 1e-6) / gaW);
  out.colW = colW; out.gaW = gaW; out.dotW = dotW; out.perLine = perLine;

  // 닫기 부호 6개 run — 일부가 라인에 in-flow로 들어가도(perLine 후 잔여
  // 폭 < 1자 폭 < 6×부호 폭) 최소 1개는 걸침으로 당겨진다.
  const text = '가'.repeat(perLine) + '.'.repeat(6) + '바'.repeat(40);
  engine.textContent = text;
  p.flushRender();
  await new Promise(res => setTimeout(res, 300));

  // ── OFF 기준 ──
  const offPart = engine.columnContents[0][0].parts[0];
  out.offLine0Len = offPart.content.length;
  out.offHasHangs = offPart.hangs !== undefined;
  out.offColOverflow = getComputedStyle(p.querySelector('x-layout-column')).overflow;
  out.offHostOverflow = getComputedStyle(p).overflow;

  // ── ON 토글 ──
  await new Promise(res => {
    const done = () => { p.removeEventListener('render-complete', done); res(); };
    p.addEventListener('render-complete', done);
    setTimeout(res, 1500);
    p.paragraphStyle = { hangingPunctuation: true };
    p.flushRender();
  });

  const onPart = engine.columnContents[0][0].parts[0];
  out.onLine0Len = onPart.content.length;
  const hangs = onPart.hangs ?? [];
  out.onHangCount = hangs.filter(h => h === 'end').length;
  let firstHung = -1;
  for (let i = 0; i < hangs.length; i++) { if (hangs[i] === 'end') { firstHung = i; break; } }
  out.firstHungIdx = firstHung;
  out.partWidth = onPart.width;
  out.firstHungOffset = firstHung >= 0 ? onPart.charOffsets[firstHung] : null;
  const hungOffsets = [];
  for (let i = firstHung; i >= 0 && i < hangs.length && hangs[i] === 'end'; i++) {
    hungOffsets.push(onPart.charOffsets[i]);
  }
  out.hungOffsets = hungOffsets;
  out.onLine1First = engine.columnContents[0][1]?.parts[0]?.content[0];
  out.onColOverflow = getComputedStyle(p.querySelector('x-layout-column')).overflow;
  out.onHostOverflow = getComputedStyle(p).overflow;

  // 걸침 span DOM — data-char-offset(엔진 산출 mm)가 partWidth 이상
  const col0 = p.querySelector('x-layout-column');
  const spans = [...col0.shadowRoot.querySelectorAll('span[data-source-offset]')];
  const hungSpan = spans.find(s => {
    const off = parseFloat(s.dataset.charOffset);
    return Number.isFinite(off) && off >= onPart.width - 1e-6;
  });
  out.hungSpanExists = hungSpan !== undefined;
  if (hungSpan) {
    out.hungSpanOffsetAttr = parseFloat(hungSpan.dataset.charOffset);
    const rect = hungSpan.getBoundingClientRect();
    const colRect = col0.getBoundingClientRect();
    out.hungRect = {
      left: rect.left, right: rect.right, top: rect.top,
      bottom: rect.bottom, width: rect.width, height: rect.height,
    };
    out.colRect = { left: colRect.left, right: colRect.right };
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    // document.elementFromPoint는 섀도우 내부 히트를 호스트로 리타기팅한다.
    // 컬럼 밖 지점에서 X-LAYOUT-COLUMN이 반환된다는 것 자체가 걸침 span이
    // 페인트되었다는 방증이다 (클립되면 뒤의 문단/바디가 나옴).
    // 확정 검증은 shadowRoot.elementFromPoint로 섀도우 내부 요소를 직접 조회.
    const docHit = document.elementFromPoint(cx, cy);
    const shadowHit = col0.shadowRoot.elementFromPoint(cx, cy);
    out.hitEl = {
      docHitTag: docHit ? docHit.tagName : null,
      shadowHitTag: shadowHit ? shadowHit.tagName : null,
      isHungSpan: shadowHit === hungSpan,
      inHungSpan: shadowHit !== null && hungSpan.contains(shadowHit),
    };
  }

  // ── OFF 재토글 (원상 복구) ──
  await new Promise(res => {
    const done = () => { p.removeEventListener('render-complete', done); res(); };
    p.addEventListener('render-complete', done);
    setTimeout(res, 1500);
    p.paragraphStyle = {};
    p.flushRender();
  });
  out.reHasHangs = engine.columnContents[0][0].parts[0].hangs !== undefined;
  out.reColOverflow = getComputedStyle(col0).overflow;
  out.reHostOverflow = getComputedStyle(p).overflow;

  return out;
});

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

console.log(`(실측: 가=${r.gaW.toFixed(4)}mm, .=${r.dotW.toFixed(4)}mm, colW=${r.colW.toFixed(3)}mm, ${r.perLine}자/라인, OFF 라인0 ${r.offLine0Len}자)\n`);

check('B1: OFF 상태 걸침 마킹 없음', r.offHasHangs === false, `hangs=${r.offHasHangs}`);
check('B2: OFF 상태 overflow hidden (기존 동작)', r.offColOverflow === 'hidden' && r.offHostOverflow === 'hidden',
  `col=${r.offColOverflow}, host=${r.offHostOverflow}`);
check('B3: ON 토글 — 닫기 부호 run이 위 줄 끝으로 당겨짐', r.onHangCount >= 1 && r.onLine0Len === r.perLine + 6,
  `hang=${r.onHangCount}, 라인0 ${r.onLine0Len}자 (기대 ${r.perLine + 6})`);
check('B4: 아래 줄이 부호로 시작하지 않음', r.onLine1First === '바', `first='${r.onLine1First}'`);
check('B5: 첫 걸침 offset === partWidth', r.firstHungIdx >= 0 && approx(r.firstHungOffset, r.partWidth),
  `offset=${r.firstHungOffset?.toFixed(3)} vs partWidth=${r.partWidth?.toFixed(3)}`);
check('B6: 걸침 run 스택형 오프셋', r.hungOffsets.length >= 2 && r.hungOffsets.slice(1).every((v, i) => approx(v - r.hungOffsets[i], r.dotW)),
  `offsets=[${r.hungOffsets.map(v => v.toFixed(2)).join(', ')}]`);
check('B7: ON 상태 overflow visible (클리핑 해제)', r.onColOverflow === 'visible' && r.onHostOverflow === 'visible',
  `col=${r.onColOverflow}, host=${r.onHostOverflow}`);
check('B8: 걸침 span DOM 존재 + 엔진 좌표 반영', r.hungSpanExists && approx(r.hungSpanOffsetAttr, r.partWidth),
  `data-char-offset=${r.hungSpanOffsetAttr?.toFixed(3)}`);
check('B9: 걸침 span 화면 rect가 컬럼 밖으로 연장',
  r.hungRect && r.hungRect.left >= r.colRect.right - 1.0 && r.hungRect.right > r.colRect.right + 1.0 && r.hungRect.width > 0 && r.hungRect.height > 0,
  `span[${r.hungRect?.left.toFixed(1)},${r.hungRect?.right.toFixed(1)}]px, col right=${r.colRect?.right.toFixed(1)}px`);
check('B10: 걸침 span 실제 페인트 — document 히트가 컬럼 호스트로 리타기팅 + shadowRoot 히트가 span 도달',
  r.hitEl !== null
    && r.hitEl.docHitTag === 'X-LAYOUT-COLUMN'
    && (r.hitEl.isHungSpan || r.hitEl.inHungSpan),
  JSON.stringify(r.hitEl));
check('B11: OFF 재토글 원상 복구 (hangs 소멸 + overflow hidden)',
  r.reHasHangs === false && r.reColOverflow === 'hidden' && r.reHostOverflow === 'hidden',
  `hangs=${r.reHasHangs}, col=${r.reColOverflow}, host=${r.reHostOverflow}`);

if (server) server.kill();
await browser.close();
console.log(failures.length === 0 ? `\nALL PASS (${11 - failures.length}/11)` : `\nFAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);