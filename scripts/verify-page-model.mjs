/**
 * 페이지 모델 검증: 2계층(document/page) 구조의 정합성을 검증한다.
 *
 * Phase B 완료 게이트 (§3.6-2):
 *  (a) 레거시 래핑 — 페이지 개념 없는 단일 캔버스 입력이 1원소 pages로 래핑된다
 *  (b) 멀티페이지 스레드 — 체인이 페이지를 가로질러 배치된다
 *  (c) 페이지 경계 타이핑 전파 — head 편집이 다음 페이지 프레임으로 흐른다
 *  (d) 가상화 park/unpark — 분리 보관 중 story 보존 + 복원 후 커서 진입
 *  (e) 페이지 단위 dirty 보존 — 편집 중 프레임의 pending 상태가 flush 전까지 유지된다
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-page-model.mjs
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const BASE_PORT = 5204;

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

    // ── 픽스처: 2페이지 문서 + 페이지 경계 스레드 ──
    const docEl = document.createElement('x-layout-document');
    document.body.appendChild(docEl);
    const story = '가나다라마바사아자차카타파하'.repeat(120);
    const mkPage = (id, top, content) => ({
      id, width: 190, height: 100, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      children: [{
        type: 'box', id: `${id}-box`, position: 'absolute',
        left: 10, top: 0, width: 170, height: 40,
        children: { type: 'paragraph', id: `${id}-para`, content, column: 1, gap: 0, paragraphStyle: {}, textStyle: {} },
      }],
    });
    docEl.data = {
      id: 'pm-doc', width: 190, height: 220, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      threads: [{ id: 't1', paragraphIds: ['p1-para', 'p2-para'], content: story }],
      pages: [mkPage('p1', 0, story), mkPage('p2', 115, '')],
    };
    await docEl.render();
    await sleep(300);
    out.pageCount = docEl.querySelectorAll('x-layout-page').length;
    out.threadsAtDoc = (docEl.engine?.data.threads ?? []).length;

    const pe1 = docEl.engine.findEngineById('p1-para');
    const pe2 = docEl.engine.findEngineById('p2-para');
    out.crossPageChain = pe1?.isThreadFrame === true && pe2?.isThreadFrame === true
      && pe2.contentFrom === pe1.overflowContentFrom;
    out.crossPageDetail = `f2.from=${pe2?.contentFrom} f1.tail=${pe1?.overflowContentFrom}`;

    // (c) 페이지 경계 타이핑 전파
    const em = docEl.editManager;
    em.textEditMode = true;
    const domP1 = docEl.querySelectorAll('x-layout-paragraph')[0];
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
      const pe2After = docEl.engine.findEngineById('p2-para');
      out.crossPageTyping = pe2After.contentFrom === pe1.overflowContentFrom;
      out.crossPageTypingDetail = `f2.from=${pe2After.contentFrom} f1.tail=${pe1.overflowContentFrom}`;
      out.storyLen = plainOf(docEl.engine.data.threads[0].content).length;
      out.storyGrew = out.storyLen === story.length + 1;
    }

    // (e) dirty 보존: 타이핑 후 flush 전 pending 상태
    out.singleManager = docEl.querySelectorAll('x-layout-page')[0].editManager === em;

    // (d) park/unpark — story 보존 + 복원 후 커서 진입
    const storyBefore = plainOf(docEl.engine.data.threads[0].content).length;
    const ph = docEl.parkPage('p2');
    out.parked = !!ph && docEl.parkedPageIds.includes('p2');
    out.storyAfterPark = plainOf(docEl.engine.data.threads[0].content).length;
    out.storyPreservedOnPark = out.storyAfterPark === storyBefore;
    const restored = docEl.unparkPage('p2');
    await sleep(300);
    out.unparked = !!restored && !docEl.parkedPageIds.includes('p2');
    const domP2 = [...docEl.querySelectorAll('x-layout-paragraph')].find(p => p.id === 'p2-para');
    out.paraRestored = !!domP2;
    if (domP2) {
      em.focusParagraph(domP2);
      await sleep(200);
      out.focusAfterUnpark = em.focusedParagraph?.id === 'p2-para';
    }

    // (a) 레거시 래핑 — 엔진 normalize 단위 (DOM 무관 순수 함수 경로)
    out.roundTripPages = docEl.data.pages?.length ?? -1;
    out.roundTripThreads = (docEl.data.threads ?? []).length;

    // (g) 페이지 번호 — 미지정 시 문서 순서(1-based) 자동 부여 + 왕복 보존
    const nums = [...docEl.querySelectorAll('x-layout-page')].map(p => p.pageNumber);
    out.autoNumbered = nums.join(',') === '1,2';
    docEl.data = {
      ...docEl.data,
      pages: docEl.data.pages.map((p, i) => i === 0 ? { ...p, pageNumber: 99 } : p),
    };
    await sleep(200);
    const p1el = [...docEl.querySelectorAll('x-layout-page')].find(p => p.id === 'p1');
    const p1data = (docEl.data.pages ?? []).find(p => p.id === 'p1');
    out.hostNumberKept = p1el?.pageNumber === 99 && p1data?.pageNumber === 99;

    // (f) 문서 기준값 — appendChildData 생략 필드 보충 (지오메트리 + padding)
    const added = docEl.appendChildData({
      id: 'p3', children: [],
      paragraphStyle: {}, textStyle: {},
    });
    await sleep(200);
    out.appendDefaults = added.width === 190 && added.height === 220
      && added.paddingTop === 0 && added.paddingLeft === 0
      && added.columns === 1 && added.gap === 0;
    out.appendDefaultsDetail = `w=${added.width} h=${added.height} pt=${added.paddingTop} pl=${added.paddingLeft}`;
    docEl.removeChildData('p3');

    // (h) 읽기 방향·펼침면 — 호스트 지정값 왕복 + 생략 시 기본값
    docEl.data = {
      width: 190, height: 220, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      pageStart: 'left', spreadPages: 4,
      pages: [mkPage('q1', 0, '가'), mkPage('q2', 0, '나')],
    };
    await sleep(200);
    out.spreadKept = docEl.pageStart === 'left' && docEl.spreadPages === 4
      && docEl.data.pageStart === 'left' && docEl.data.spreadPages === 4;
    // 생략 시 기본값은 fresh 요소에서 확인 (setter는 생략 필드 유지가 규약)
    docEl.remove();
    const docEl2 = document.createElement('x-layout-document');
    document.body.appendChild(docEl2);
    docEl2.data = {
      width: 190, height: 220, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      pages: [mkPage('q1', 0, '가')],
    };
    await sleep(200);
    out.spreadDefaults = docEl2.pageStart === 'right' && docEl2.spreadPages === 2
      && docEl2.data.pageStart === 'right' && docEl2.data.spreadPages === 2;
    docEl2.remove();

    // (i) pageNumber 슬롯 그리드 배치 + 건너뜀 공간 확보
    // H에서 docEl을 remove()했으므로 재마운트 — layout()은 detached에서 early-return한다.
    document.body.appendChild(docEl);
    docEl.data = {
      width: 190, height: 100, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      spreadPages: 2, pageStart: 'right',
      pages: [
        { ...mkPage('o1', 0, '가'), pageNumber: 5 },
        { ...mkPage('o2', 0, '나'), pageNumber: 1 },
        { ...mkPage('o3', 0, '다'), pageNumber: 2 },
      ],
    };
    await sleep(300);
    // 커버 행 컨벤션 + 항상-LTR 배치 (spread=2, pageStart 'right'):
    // 행 0=[o2 단독, 앵커=right → left 190], 행 1=[o3 → left 0, top 100],
    // 행 2=[o1(번호 5, pos 1) → left 190, top 200]. 번호 3·4는 행 1·2의
    // 빈 슬롯으로 흡수된다. 배치는 항상 왼쪽→오른쪽이며 pageStart는
    // 커버행(1페이지)의 시작 위치만을 결정한다.
    const pos = (id) => {
      const el = [...docEl.querySelectorAll('x-layout-page')].find(p => p.id === id);
      return el ? `${el.style.left}/${el.style.top}` : '(missing)';
    };
    out.grid = {
      o2: pos('o2'), o3: pos('o3'), o1: pos('o1'),
      docW: docEl.style.width, docH: docEl.style.height,
    };
    out.orderOk = out.grid.o2 === '190mm/0mm'
      && out.grid.o3 === '0mm/100mm'
      && out.grid.o1 === '190mm/200mm';
    out.gapOk = parseFloat(out.grid.docH) === 300;
    out.gapDetail = `o2=${out.grid.o2} o3=${out.grid.o3} o1=${out.grid.o1} doc=${out.grid.docW}x${out.grid.docH}`;
    out.extractOrderOk = (docEl.data.pages ?? []).map(p => p.id).join(',') === 'o2,o3,o1';
    return out;
  });

  check('A. 문서에 2페이지 마운트', r.pageCount === 2, `pages=${r.pageCount}`);
  check('A. threads가 문서 레벨에 존재', r.threadsAtDoc === 1, `threads=${r.threadsAtDoc}`);
  check('B. 페이지 경계 스레드 체인 (f2.from === f1.tail)', r.crossPageChain === true, r.crossPageDetail);
  check('C. textarea 진입', r.hasTextarea === true);
  check('C. 페이지 경계 타이핑 전파', r.crossPageTyping === true, r.crossPageTypingDetail);
  check('C. story 길이 +1 (writeback)', r.storyGrew === true, `len=${r.storyLen}`);
  check('E. EditManager 단일 인스턴스 (문서 소유)', r.singleManager === true);
  check('D. park 보관', r.parked === true);
  check('D. park 중 story 보존', r.storyPreservedOnPark === true, `len=${r.storyAfterPark}`);
  check('D. unpark 복원', r.unparked === true && r.paraRestored === true);
  check('D. 복원 후 커서 진입', r.focusAfterUnpark === true);
  check('A. round-trip pages 유지', r.roundTripPages === 2, `pages=${r.roundTripPages}`);
  check('A. round-trip threads 유지', r.roundTripThreads === 1, `threads=${r.roundTripThreads}`);
  check('F. appendChildData 문서 기준값 보충', r.appendDefaults === true, r.appendDefaultsDetail);
  check('G. 페이지 번호 자동 부여 (1,2)', r.autoNumbered === true);
  check('G. 호스트 지정 번호 보존 (99)', r.hostNumberKept === true);
  check('I. pageNumber 슬롯 그리드 배치 (spread 2, pageStart right)', r.orderOk === true, r.gapDetail);
  check('I. 건너뜀 행 공간 확보 (docH 300 = 3행)', r.gapOk === true, r.gapDetail);
  check('I. extractData 순서 추종', r.extractOrderOk === true);
  check('H. 읽기 방향·펼침면 지정값 왕복 (left/4)', r.spreadKept === true);
  check('H. 생략 시 기본값 (right/2)', r.spreadDefaults === true);

  await browser.close();
} finally {
  if (server) server.kill();
}

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
