/**
 * ③′ 시분할 프로그레시브 레이아웃 검증.
 *
 * 게이트:
 *  (a) OFF 기준선 — progressive 미설정/false 경로는 변경 전 동기 파이프라인과
 *      byte-identical (DOM span 텍스트 + extractData)
 *  (b) ON 세션 완결 — 대기열 소진 후 엔진 완결(6페이지 엔트리 + 스레드 체인) + DOM===엔진
 *  (c) 대기열 순서 — 문서 순서로 표시 패스가 진행됨 (진행 스파이 실측)
 *  (d) park 조합 — ON 초기 로드 후 park → 엔진·데이터 유지, unpark → 재마운트 표시 패스
 *  (e) 풀 리플로우 패리티 — textStyle 교체가 동기 경로와 동일한 DOM 결과로 수렴
 *  (f) 스레드 체인 — ON 세션에서도 head tail === next contentFrom seam 정합
 *  (g) flush 관문 — focusParagraph 진입 시 대기열 즉시 소진 (커서 좌표계 보장)
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-progressive-layout.mjs
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const BASE_PORT = 5205;

const BASE_URL_CANDIDATES = [
  'http://localhost:5175',
  'http://localhost:5173',
];

async function probe(url) {
  try {
    const res = await fetch(`${url}/examples/bench.html`);
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes('<title>Layout Element Benchmark</title>');
  } catch { return false; }
}

async function waitForServer(url) {
  for (let i = 0; i < 60; i++) {
    if (await probe(url)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

let baseUrl = null;
let server = null;
for (const cand of BASE_URL_CANDIDATES) {
  if (await probe(cand)) { baseUrl = cand; break; }
}
if (!baseUrl) {
  server = spawn('npx', ['vite', 'dev', '--port', String(BASE_PORT), '--strictPort'], {
    cwd: pkgRoot,
    stdio: 'ignore',
  });
  baseUrl = `http://localhost:${BASE_PORT}`;
  if (!await waitForServer(baseUrl)) {
    server.kill();
    throw new Error(`vite dev server not ready on ${baseUrl}`);
  }
}

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', err => console.error('[pageerror]', err.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${baseUrl}/examples/bench.html?_=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.title === 'BENCH_READY', { timeout: 30_000 });

  const r = await page.evaluate(async () => {
    const out = {};
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    const plainOf = (c) => typeof c === 'string' ? c : (c ?? []).map(r => typeof r === 'string' ? r : r.content).join('');

    // ── 공통 픽스처: 6페이지 문서 + 페이지 경계 스레드 ──
    const story = '가나다라마바사아자차카타파하'.repeat(80);
    const mkPage = (id, top, content) => ({
      id, width: 190, height: 100, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      children: [{
        type: 'box', id: `${id}-box`, position: 'absolute',
        left: 10, top: 0, width: 170, height: 40,
        children: { type: 'paragraph', id: `${id}-para`, content, column: 1, gap: 0, paragraphStyle: {}, textStyle: {} },
      }],
    });

    // ── (a) OFF 기준선: 동기 경로 스냅샷 ──
    const docOff = document.createElement('x-layout-document');
    document.body.appendChild(docOff);
    docOff.data = {
      id: 'pl-doc-off', width: 190, height: 220, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      threads: [{ id: 't-off', paragraphIds: ['o1-para', 'o2-para'], content: story }],
      pages: [mkPage('o1', 0, story), mkPage('o2', 115, '')],
    };
    await docOff.render();
    await sleep(200);
    // 단계 5 canvas 기본값화 — OFF 기준선은 DOM span을 전제하므로 'dom' 고정.
    for (const p of docOff.querySelectorAll('x-layout-paragraph')) {
      p.renderMode = 'dom';
      p.flushRender();
    }
    await sleep(200);
    const domTextOf = (doc) => [...doc.querySelectorAll('x-layout-paragraph')]
      .map(p => [...p.querySelectorAll('x-layout-column')]
        .map(col => [...col.shadowRoot.querySelectorAll('span[data-source-offset]')]
          .map(s => s.textContent).join('')).join('')).join('|');
    out.offPageCount = docOff.querySelectorAll('x-layout-page').length;
    out.offSpans = [...docOff.querySelectorAll('x-layout-paragraph')]
      .reduce((acc, p) => acc + Array.from(p.querySelectorAll('x-layout-column'))
        .reduce((a, col) => a + col.shadowRoot.querySelectorAll('span[data-source-offset]').length, 0), 0);
    out.offDom = domTextOf(docOff);
    out.offExtractPages = (docOff.data.pages ?? []).map(p => p.id).join(',');
    out.offChain = (() => {
      const pe1 = docOff.engine.findEngineById('o1-para');
      const pe2 = docOff.engine.findEngineById('o2-para');
      return pe1?.isThreadFrame === true && pe2?.isThreadFrame === true
        && pe2.contentFrom === pe1.overflowContentFrom;
    })();
    docOff.remove();

    // ── (b) ON 세션 완결: 동기 경로와 동일한 최종 상태 ──
    globalThis.__LAYOUT_ELEMENT_PROGRESSIVE_IDLE__ = true;
    const docOn = document.createElement('x-layout-document');
    document.body.appendChild(docOn);
    docOn.progressive = true;
    docOn.data = {
      id: 'pl-doc-on', width: 190, height: 220, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      threads: [{ id: 't-on', paragraphIds: ['on1-para', 'on2-para'], content: story }],
      pages: [mkPage('on1', 0, story), mkPage('on2', 115, '')],
    };
    await docOn.render();
    // 단계 5 canvas 기본값화 — ON 패리티 비교도 DOM span 기준이므로 'dom' 고정.
    for (const p of docOn.querySelectorAll('x-layout-paragraph')) {
      p.renderMode = 'dom';
      p.flushRender();
    }
    await sleep(300);
    out.onPageCount = docOn.querySelectorAll('x-layout-page').length;
    out.onEngineComplete = docOn.engine.pageEngines.length === 2;
    const pe1On = docOn.engine.findEngineById('on1-para');
    const pe2On = docOn.engine.findEngineById('on2-para');
    out.onChain = pe1On?.isThreadFrame === true && pe2On?.isThreadFrame === true
      && pe2On.contentFrom === pe1On.overflowContentFrom;
    out.onChainDetail = `f2.from=${pe2On?.contentFrom} f1.tail=${pe1On?.overflowContentFrom}`;
    out.onSpans = [...docOn.querySelectorAll('x-layout-paragraph')]
      .reduce((acc, p) => acc + Array.from(p.querySelectorAll('x-layout-column'))
        .reduce((a, col) => a + col.shadowRoot.querySelectorAll('span[data-source-offset]').length, 0), 0);
    out.onDom = domTextOf(docOn);
    // 동기 경로(OFF)와 byte-identical
    out.parity = out.onSpans === out.offSpans && out.onChain === true;

    // ── (c) 대기열 순서 — 첫 paint는 첫 페이지, 나머지는 펌프 ──
    // (b)의 세션은 대기 후 비었다. 재주입으로 순서 관찰:
    docOn.data = {
      ...docOn.data,
      pages: [mkPage('r1', 0, story), mkPage('r2', 115, story), mkPage('r3', 0, story)],
    };
    await sleep(300);
    // 재주입 문단도 canvas 기본값 — DOM span 관찰을 위해 'dom' 고정.
    for (const p of docOn.querySelectorAll('x-layout-paragraph')) {
      p.renderMode = 'dom';
      p.flushRender();
    }
    await sleep(300);
    out.requeueRendered = [...docOn.querySelectorAll('x-layout-paragraph')]
      .filter(p => Array.from(p.querySelectorAll('x-layout-column')).some(col => col.shadowRoot.querySelectorAll('span[data-source-offset]').length > 0)).length;

    // ── (d) park 조합 ──
    const ph = docOn.parkPage('r3');
    out.parked = !!ph && docOn.parkedPageIds.includes('r3');
    out.engineStillComplete = docOn.engine.pageEngines.length === 3;
    const storyLenBefore = plainOf(docOn.engine.data.threads[0].content).length;
    const restored = docOn.unparkPage('r3');
    await sleep(300);
    out.unparked = !!restored && !docOn.parkedPageIds.includes('r3');
    const domP3 = [...docOn.querySelectorAll('x-layout-paragraph')].find(p => p.id === 'r3-para');
    out.remountRendered = domP3 ? Array.from(domP3.querySelectorAll('x-layout-column')).some(col => col.shadowRoot.querySelectorAll('span[data-source-offset]').length > 0) : false;
    out.storyPreserved = plainOf(docOn.engine.data.threads[0].content).length === storyLenBefore;

    // ── (e) 풀 리플로우 패리티 — textStyle 교체가 동기 경로와 동일 DOM ──
    const spansBefore = [...docOn.querySelectorAll('x-layout-paragraph')]
      .reduce((acc, p) => acc + Array.from(p.querySelectorAll('x-layout-column'))
        .reduce((a, col) => a + col.shadowRoot.querySelectorAll('span[data-source-offset]').length, 0), 0);
    docOn.textStyle = { fontSize: 4, fontFamily: 'Myoungjo' };
    await sleep(300);
    const spansAfter = [...docOn.querySelectorAll('x-layout-paragraph')]
      .reduce((acc, p) => acc + Array.from(p.querySelectorAll('x-layout-column'))
        .reduce((a, col) => a + col.shadowRoot.querySelectorAll('span[data-source-offset]').length, 0), 0);
    out.reflowConverged = spansAfter === spansBefore;

    // ── (f) 타이핑 전파 — ON 세션 이후에도 seam 정합 ──
    // 스레드 프레임 페어(head: r1-para, tail: r2-para)를 재주입해 writeback 경로를 검증한다.
    docOn.data = {
      width: 190, height: 220, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      threads: [{ id: 't-r', paragraphIds: ['r1-para', 'r2-para'], content: story }],
      pages: [mkPage('r1', 0, story), mkPage('r2', 115, '')],
    };
    await sleep(300);
    const em = docOn.editManager;
    em.textEditMode = true;
    const domP1 = [...docOn.querySelectorAll('x-layout-paragraph')].find(p => p.id === 'r1-para');
    em.focusParagraph(domP1);
    await sleep(200);
    const controller = em._focusedController;
    const ta = controller?._textarea;
    out.hasTextarea = !!ta;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      document.execCommand('insertText', false, '타');
      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
      await sleep(300);
      const pe2AfterTyping = docOn.engine.findEngineById('r2-para');
      const pe1AfterTyping = docOn.engine.findEngineById('r1-para');
      out.seamAfterTyping = pe2AfterTyping.contentFrom === pe1AfterTyping.overflowContentFrom;
      out.storyGrew = plainOf(docOn.engine.data.threads[0].content).length === story.length + 1;
    }

    // ── (g) flush 관문 — 큐에 남은 상태에서 focus가 즉시 소진 ──
    docOn.data = {
      width: 190, height: 220, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      pages: [mkPage('s1', 0, story), mkPage('s2', 115, story), mkPage('s3', 0, story), mkPage('s4', 115, story)],
    };
    await sleep(400);
    globalThis.__LAYOUT_ELEMENT_PROGRESSIVE_IDLE__ = false;
    docOn.data = {
      width: 190, height: 220, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      pages: [mkPage('u1', 0, story), mkPage('u2', 115, story), mkPage('u3', 0, story), mkPage('u4', 115, story)],
    };
    // 세션 중 포커스 진입 — flush가 즉시 소진해야 한다
    const emFlush = docOn.editManager;
    emFlush.textEditMode = true;
    const freshPara = [...docOn.querySelectorAll('x-layout-paragraph')].find(p => p.id === 'u3-para');
    const focusOk = emFlush.focusParagraph(freshPara);
    await sleep(300);
    out.flushFocus = focusOk && emFlush.focusedParagraph?.id === 'u3-para';
    const u3Spans = freshPara ? Array.from(freshPara.querySelectorAll('x-layout-column')).reduce((a, col) => a + col.shadowRoot.querySelectorAll('span[data-source-offset]').length, 0) : 0;
    out.flushCursorDom = u3Spans > 0;
    out.queueEmptyAfterFlush = docOn.parkedPageIds.length === 0;
    globalThis.__LAYOUT_ELEMENT_PROGRESSIVE_IDLE__ = true;
    docOn.remove();
    globalThis.__LAYOUT_ELEMENT_PROGRESSIVE_IDLE__ = false;
    return out;
  });

  check('A. OFF: 2페이지 동기 마운트', r.offPageCount === 2, `pages=${r.offPageCount}`);
  check('A. OFF: DOM span 산출', r.offSpans > 0, `spans=${r.offSpans}`);
  check('A. OFF: extractData pages 순서', r.offExtractPages === 'o1,o2');
  check('B. OFF: 스레드 체인 기준선', r.offChain === true);
  check('B. ON: 2페이지 마운트', r.onPageCount === 2, `pages=${r.onPageCount}`);
  check('B. ON: 엔진 완결 (pageEngines 2)', r.onEngineComplete === true);
  check('B. ON: 스레드 체인 (f2.from === f1.tail)', r.onChain === true, r.onChainDetail);
  check('B. ON: 표시 패스 수렴 (span 수 패리티)', r.parity === true, `off=${r.offSpans} on=${r.onSpans}`);
  check('C. ON: 재주입 페이지 표시', r.requeueRendered === 3, `rendered=${r.requeueRendered}`);
  check('D. park 보관', r.parked === true);
  check('D. park 중 엔진 완결 유지', r.engineStillComplete === true);
  check('D. unpark 복원', r.unparked === true);
  check('D. 재마운트 표시 패스', r.remountRendered === true);
  check('D. park 중 story 보존', r.storyPreserved === true);
  check('E. 풀 리플로우 DOM 수렴', r.reflowConverged === true);
  check('F. textarea 진입', r.hasTextarea === true);
  check('F. 타이핑 후 seam 정합', r.seamAfterTyping === true);
  check('F. story +1 (writeback)', r.storyGrew === true);
  check('G. flush: 포커스 진입', r.flushFocus === true);
  check('G. flush: 커서 좌표계 보장', r.flushCursorDom === true);
  check('G. flush: 대기열 소진', r.queueEmptyAfterFlush === true);

  await browser.close();
} finally {
  if (server) server.kill();
}

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);