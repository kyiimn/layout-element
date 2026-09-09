/**
 * 멀티컬럼 문서의 타이핑 정합성 검증 (prefix 캐시 경로).
 *
 * 3단 문서의 2·3단 중간 타이핑 시 _applyPrefixCache가 캐시된 앞 단을
 * 재사용할 때, 뒤 단의 재래핑 시작 위치가 정확한지 검증한다.
 * 결함이 있으면 앞 단 마지막 글자들이 현재 단으로 당겨와 렌더된다.
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-multicolumn.mjs
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5198;

/**
 * 후보 URL이 layout-element의 bench 페이지를 실제로 서빙하는지 검증한다.
 *
 * probe는 HTML title까지 검증해야 한다 — 타 앱 Vite 서버(SPA fallback)는
 * 존재하지 않는 경로에도 200을 반환한다 (실제 사고: layout-ui 서버를
 * 잡아 BENCH_READY 타임아웃).
 *
 * @param {string} url - 후보 base URL
 * @returns {Promise<boolean>} bench 페이지 서빙 여부
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
const page = await browser.newPage();
page.on('pageerror', err => console.error('[pageerror]', err.message.slice(0, 300)));
await page.goto(`${baseUrl}/examples/bench.html?_=${Date.now()}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.title === 'BENCH_READY', { timeout: 30_000 });

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const r = await page.evaluate(async () => {
  const em = window.bench.getEditManager();
  const p = window.bench.getParaBox().querySelector('x-layout-paragraph');
  const engine = p.engine;
  em.textEditMode = true;
  p.editableText = true;
  await new Promise(r => setTimeout(r, 200));
  em.focusParagraph(p);
  await new Promise(r => setTimeout(r, 200));
  const controller = em._focusedController;
  const ta = controller?._textarea;
  if (!ta) return { error: 'no ta' };
  const wait2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // 신문 형태: 컬럼당 ~18라인, 텍스트 3단 가득
  const paraBox = window.bench.getParaBox();
  paraBox.height = 18;
  const sentence = '신문 기사 본문 문장의 한글 텍스트 예제로 다양한 글자들을 포함하고 있습니다. ';
  const blocks = [];
  for (let i = 0; i < 6; i++) blocks.push(sentence.repeat(2));
  const longText = blocks.join('\n');
  p.content = longText;
  p.flushRender();
  await wait2();

  const domColTexts = () => {
    const cols = [...p.querySelectorAll('x-layout-column')];
    return cols.map(col => {
      const lines = [...col.shadowRoot.children].filter(c => c.tagName === 'DIV');
      return lines.filter(l => l.style.display !== 'none').map(l =>
        [...l.querySelectorAll('span[data-source-offset]:not([data-temporary])')].map(s => s.textContent).join('')
      );
    });
  };
  const engineColLens = () => engine.columnContents.map(col =>
    col.reduce((s, line) => s + (line?.parts ?? []).reduce((ps, pt) => ps + pt.content.length, 0), 0));

  const out = { steps: [] };
  if (engineColLens()[1] === 0) return { error: 'multi-column not established', lens: engineColLens() };

  // ── 시나리오 A: 2단 첫 글자 위치 타이핑 (경계) ──
  const colStartOffset = (colIdx) => {
    const plain = ta.value;
    let plainOffset = 0;
    for (let c = 0; c <= colIdx; c++) {
      if (c < colIdx) {
        for (const line of engine.columnContents[c]) {
          for (const part of line.parts) plainOffset += part.content.length;
          if (line.endOfBlock && plain[plainOffset] === '\n') plainOffset++;
        }
      }
    }
    return plainOffset;
  };

  const typeAt = async (offset, ch) => {
    const before = ta.value;
    ta.value = before.slice(0, offset) + ch + before.slice(offset);
    ta.setSelectionRange(offset + 1, offset + 1);
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return controller._cursorModel.offset;
  };

  const snapshot = () => JSON.stringify(domColTexts());

  // 시나리오 A: 2단 첫 위치에서 3키
  let cursor = colStartOffset(1);
  em.focusParagraph(p, { cursorOffset: cursor });
  await wait2();
  const resultsA = [];
  for (const ch of ['X', 'Y', 'Z']) {
    cursor = await typeAt(cursor, ch);
    resultsA.push({
      ch,
      cached: snapshot(),
      col2First: domColTexts()[1][0]?.slice(0, 8),
      prefixCacheActive: !!engine._prefixCache,
    });
    // 각 키 후 전체 재래핑 기준과 비교
    engine.resetIncrementalState();
    p.flushRender();
    await wait2();
    resultsA[resultsA.length - 1].full = snapshot();
    resultsA[resultsA.length - 1].match = resultsA[resultsA.length - 1].cached === resultsA[resultsA.length - 1].full;
    // 다음 키를 위한 커서 재설정 (flush 후 offset 유지됨)
    em.focusParagraph(p, { cursorOffset: controller._cursorModel.offset });
    await wait2();
  }
  out.scenarioA = resultsA;

  // 시나리오 B: 2단 중간에서 3키 (경계 아님)
  const col2Start = colStartOffset(1);
  const midCol2 = col2Start + Math.floor(engineColLens()[1] / 2);
  em.focusParagraph(p, { cursorOffset: midCol2 });
  await wait2();
  const resultsB = [];
  let cursorB = midCol2;
  for (const ch of ['가', '나', '다']) {
    cursorB = await typeAt(cursorB, ch);
    const cached = snapshot();
    engine.resetIncrementalState();
    p.flushRender();
    await wait2();
    const full = snapshot();
    resultsB.push({ ch, match: cached === full });
    em.focusParagraph(p, { cursorOffset: controller._cursorModel.offset });
    await wait2();
  }
  out.scenarioB = resultsB;

  // 시나리오 C: 3단 중간 타이핑
  const col3Start = colStartOffset(2);
  const midCol3 = col3Start + Math.floor(engineColLens()[2] / 2);
  em.focusParagraph(p, { cursorOffset: midCol3 });
  await wait2();
  const resultsC = [];
  let cursorC = midCol3;
  for (const ch of ['R', 'S', 'T']) {
    cursorC = await typeAt(cursorC, ch);
    const cached = snapshot();
    engine.resetIncrementalState();
    p.flushRender();
    await wait2();
    const full = snapshot();
    resultsC.push({ ch, match: cached === full });
    em.focusParagraph(p, { cursorOffset: controller._cursorModel.offset });
    await wait2();
  }
  out.scenarioC = resultsC;

  // 시나리오 D: 2단 중간 + 백스페이스 (삭제 경로)
  const delCursor = col2Start + Math.floor(engineColLens()[1] / 3);
  em.focusParagraph(p, { cursorOffset: delCursor });
  await wait2();
  const resultsD = [];
  for (let i = 0; i < 3; i++) {
    const before = ta.value;
    const offset = controller._cursorModel.offset;
    ta.value = before.slice(0, offset - 1) + before.slice(offset);
    ta.setSelectionRange(offset - 1, offset - 1);
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cached = snapshot();
    engine.resetIncrementalState();
    p.flushRender();
    await wait2();
    const full = snapshot();
    resultsD.push({ match: cached === full });
    em.focusParagraph(p, { cursorOffset: controller._cursorModel.offset });
    await wait2();
  }
  out.scenarioD = resultsD;

  // 원상 복원
  paraBox.height = 500;

  return out;
});

if (r.error) { console.log('ERROR:', r.error); process.exit(1); }

for (const s of r.scenarioA) {
  check(`A(2단 첫 위치, ${s.ch}): 캐시 경로 === 전체 재래핑`, s.match, `cached col2="${s.col2First}"`);
  check(`A(2단 첫 위치, ${s.ch}): prefix 캐시 동작`, s.prefixCacheActive);
}
for (const s of r.scenarioB) {
  check(`B(2단 중간, ${s.ch}): 캐시 경로 === 전체 재래핑`, s.match);
}
for (const s of r.scenarioC) {
  check(`C(3단 중간, ${s.ch}): 캐시 경로 === 전체 재래핑`, s.match);
}
for (let i = 0; i < r.scenarioD.length; i++) {
  check(`D(2단 중간 백스페이스 #${i + 1}): 캐시 경로 === 전체 재래핑`, r.scenarioD[i].match);
}

if (server) server.kill();
await browser.close();
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);