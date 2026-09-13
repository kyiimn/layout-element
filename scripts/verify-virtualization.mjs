/**
 * DOM 가상화 검증: park/unpark, data 세터 부활 방지(G1), 재마운트 커서 복원(P1),
 * detach 서브트리 정리(P3), PageMountManager 마운트 윈도우.
 *
 * P1~P4 보강(parkPage/unparkPage/_collectChildrenData/_unregisterLayoutSubtree/
 * PageMountManager)의 정합성을 브라우저에서 검증한다. 회귀(기존 경로)는
 * verify-dom-diff/pending-style/visual-render/multicolumn/image-edit-mode/
 * caret-parking이 커버한다.
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-virtualization.mjs
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const BASE_PORT = 5203;

const BASE_URL_CANDIDATES = [
  'http://localhost:5175',
  'http://localhost:5173',
];

/**
 * 후보 URL이 layout-element의 bench 페이지를 실제로 서빙하는지 검증한다.
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

/** 스폰한 vite 서버가 응답할 때까지 폴링한다. 최대 30초. */
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
    stdio: 'pipe',
    shell: true,
  });
  const spawnedUrl = `http://localhost:${BASE_PORT}`;
  if (await waitForServer(spawnedUrl)) {
    baseUrl = spawnedUrl;
  } else {
    server.kill();
    throw new Error(`vite dev server not ready on ${spawnedUrl}`);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', err => console.error('[pageerror]', err.message));
await page.goto(`${baseUrl}/examples/bench.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.title === 'BENCH_READY', { timeout: 30_000 });

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// ── 픽스처: 6페이지 문서 (page-5는 이미지 페이지) ──
const r = await page.evaluate(async () => {
  const out = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  document.body.style.margin = '0';

  const text = (tag) => `${tag} 가상화검증문단입니다.`.repeat(12);
  const para = (content) => ({ type: 'paragraph', content, paragraphStyle: {}, textStyle: {} });
  const doc = document.createElement('x-layout-document');
  document.body.appendChild(doc);
  const item = (id, top, children) => ({
    type: 'box', id, position: 'absolute', left: 10, top, width: 170, height: 100, children,
  });
  doc.data = {
    width: 190, height: 700,
    columns: 1, gap: 0,
    paragraphStyle: { lineGap: 1.2 },
    textStyle: { fontSize: 4 },
    children: [
      item('page-0', 0, para(text('P0'))),
      item('page-1', 115, para(text('P1'))),
      item('page-2', 230, para(text('P2'))),
      item('page-3', 345, para(text('P3'))),
      {
        type: 'box', id: 'page-4', position: 'absolute', left: 10, top: 460, width: 170, height: 100,
        children: [{
          type: 'box', id: 'page-4-inner', position: 'absolute', left: 5, top: 5, width: 160, height: 90,
          children: para(text('P4')),
        }],
      },
      {
        type: 'box', id: 'page-5', position: 'absolute', left: 10, top: 575, width: 170, height: 100,
        children: {
          type: 'image', x: 0, y: 0, width: 50, height: 50, objectFit: 'cover',
          originalWidth: 1, originalHeight: 1, dpi: 72,
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        },
      },
    ],
  };
  await doc.render();
  await sleep(300);

  const em = doc.editManager;
  em.textEditMode = true;
  const byId = (id) => doc.querySelector('x-layout-box') && [...doc.querySelectorAll('x-layout-box')].find(b => b.id === id);
  const domText = (pageBox) => {
    const p = pageBox.querySelector('x-layout-paragraph');
    if (!p) return null;
    return [...p.querySelectorAll('x-layout-column')]
      .map(col => [...col.shadowRoot.querySelectorAll('span[data-source-offset]')]
        .map(s => s.textContent).join('')).join('');
  };
  const engText = (pageBox) => {
    const p = pageBox.querySelector('x-layout-paragraph');
    return p ? p.engine.plainText : null;
  };
  const allMatch = () => byIds().every(id => {
    const box = byId(id);
    if (!box || !box.querySelector('x-layout-paragraph')) return true;
    return domText(box) === engText(box);
  });
  const byIds = () => ['page-0', 'page-1', 'page-2', 'page-3', 'page-4', 'page-5'];
  out.A = {
    items: doc.items.length,
    engines: doc.engine.childBoxEngines.length,
    textMatch: allMatch(),
  };

  // ── B. park ──
  const page2 = byId('page-2');
  const ph2 = doc.parkPage('page-2');
  out.B = {
    placeholder: ph2 instanceof HTMLDivElement && ph2.getAttribute('data-parked-page') === 'page-2',
    items: doc.items.length,
    parked: JSON.stringify(doc.parkedPageIds),
    engines: doc.engine.childBoxEngines.length,
    extractChildren: doc.data.children.length,
    hasPage2: doc.data.children.some(c => c.id === 'page-2'),
    placeholderIndex: Array.from(doc.childNodes).indexOf(ph2),
    othersMatch: ['page-0', 'page-1', 'page-3', 'page-4'].every(id => domText(byId(id)) === engText(byId(id))),
  };

  // ── C. G1: 보관 중 data 세터 풀 라운드트립 ──
  doc.data = doc.data;
  await sleep(300);
  out.C = {
    items: doc.items.length,
    parked: JSON.stringify(doc.parkedPageIds),
    engines: doc.engine.childBoxEngines.length,
    othersMatch: ['page-0', 'page-1', 'page-3', 'page-4'].every(id => domText(byId(id)) === engText(byId(id))),
  };

  // ── D. 보관 페이지 편집 후 unpark ──
  const edited = doc.data;
  edited.children.find(c => c.id === 'page-2').children.content = text('P2-EDITED');
  doc.data = edited;
  await sleep(300);
  const stillParked = JSON.stringify(doc.parkedPageIds);
  const restored = doc.unparkPage('page-2');
  await restored.render();
  await sleep(300);
  out.D = {
    stillParked,
    restored: restored && restored.id === 'page-2',
    items: doc.items.length,
    order: doc.items.map(b => b.id).join(','),
    parked: JSON.stringify(doc.parkedPageIds),
    textMatch: domText(byId('page-2')) === engText(byId('page-2')),
    edited: engText(byId('page-2')).startsWith('P2-EDITED'),
  };

  // ── E. P1: 커서 복원 + 예약 렌더 ──
  const p1 = byId('page-1').querySelector('x-layout-paragraph');
  p1.editableText = true;
  await sleep(200);
  em.focusParagraph(p1);
  await sleep(200);
  em._focusedController.setCursor({ textOffset: 10 });
  const savedOffset = em._focusedController.cursorOffset;
  doc.parkPage('page-1');
  const focusCleared = em.focusedParagraph === null;
  const p1el = doc.unparkPage('page-1');
  let renderCalls = 0;
  const origRender = p1el.querySelector('x-layout-paragraph').render.bind(p1el.querySelector('x-layout-paragraph'));
  p1el.querySelector('x-layout-paragraph').render = (...a) => { renderCalls++; return origRender(...a); };
  await sleep(400);
  const p1restored = byId('page-1').querySelector('x-layout-paragraph');
  out.E = {
    savedOffset,
    focusCleared,
    controllerRecreated: !!p1restored._editController,
    cursorRestored: p1restored._editController && p1restored._editController.cursorOffset === 10,
    scheduledRender: renderCalls >= 1,
    textMatch: domText(byId('page-1')) === engText(byId('page-1')),
  };
  em.blurParagraph();

  // ── F. P3: detach 서브트리 정리 ──
  const inner = byId('page-4-inner');
  em.selectLayout(inner);
  const selBefore = em.selectedLayouts.length;
  let selDispatches = 0;
  const selListener = () => { selDispatches++; };
  em.addEventListener('layoutSelectionChange', selListener);
  doc.parkPage('page-4');
  em.removeEventListener('layoutSelectionChange', selListener);
  const img = byId('page-5').querySelector('x-layout-image');
  em.focusImage(img);
  const imgModeBefore = em.imageEditMode;
  doc.parkPage('page-5');
  out.F = {
    selBefore,
    selAfter: em.selectedLayouts.length,
    selDispatches,
    imgModeBefore,
    focusedImageCleared: em.focusedImage === null,
    imgModeOff: em.imageEditMode === false,
  };
  doc.unparkPage('page-4');
  doc.unparkPage('page-5');
  await sleep(300);

  // ── H. parked 오버레이 회피 (핵심) ──
  // 텍스트 박스(z1)와 교차하는 이미지 박스(z10, box 모드)를 최상위 형제로 둔다.
  // overlayElements는 엔진 트리 기준이므로 이미지 페이지 분리 후에도 회피해야 한다.
  const docH = document.createElement('x-layout-document');
  document.body.appendChild(docH);
  const hovText = '회피검증본문가나다라.'.repeat(40);
  docH.data = {
    width: 190, height: 300, columns: 1, gap: 0,
    paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
    children: [
      { type: 'box', id: 'hov-text', position: 'absolute', left: 10, top: 10, width: 170, height: 100, zIndex: 1,
        children: { type: 'paragraph', content: hovText, paragraphStyle: {}, textStyle: {} } },
      // objectFit none + 명시 rect: displayRect가 입력 그대로 확정되어
      // 경계 일치(line top == image top) 같은 기하학적 우연을 피한다.
      // cover 모드는 비율 맞춤으로 rect가 재계산되어 테스트가 비결정적이 된다.
      { type: 'box', id: 'hov-img', position: 'absolute', left: 60, top: 30, width: 80, height: 60, zIndex: 10,
        children: { type: 'image', x: 0, y: 2, width: 80, height: 56, objectFit: 'none',
          originalWidth: 1, originalHeight: 1, overlapMode: 'box',
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } },
    ],
  };
  await docH.render();
  await sleep(400);
  const hovPara = () => docH.querySelector('x-layout-box#hov-text, #hov-text') && [...docH.querySelectorAll('x-layout-box')].find(b => b.id === 'hov-text').querySelector('x-layout-paragraph');
  const hovDomText = () => {
    const p = hovPara();
    return [...p.querySelectorAll('x-layout-column')]
      .map(col => [...col.shadowRoot.querySelectorAll('span[data-source-offset]')].map(s => s.textContent).join('')).join('');
  };
  const hovSplit = () => hovPara().engine.columnContents[0].some(l => l.parts.length > 1);
  const H1 = { split: hovSplit(), match: hovDomText() === hovPara().engine.plainText };
  // 이미지 페이지 분리 → 텍스트 재계산(콘텐츠 변경으로 캐시 무효화 강제) → 회피 유지?
  docH.parkPage('hov-img');
  const pd = hovPara().data;
  pd.content = pd.content + '가';
  hovPara().data = pd;
  await sleep(500);
  const H2 = {
    split: hovSplit(),
    match: hovDomText() === hovPara().engine.plainText,
    engines: docH.engine.childBoxEngines.length,
  };
  // print-equivalent: 가시 글자 중심이 이미지 rect 안에 없음 (0.05mm 엡실론)
  const imgRect = docH.engine.childBoxEngines.find(e => e.data.id === 'hov-img')
    .childEngines[0].displayRect;
  const ix0 = imgRect.absLeft + 0.05, ix1 = imgRect.absLeft + imgRect.absWidth - 0.05;
  const iy0 = imgRect.absTop + 0.05, iy1 = imgRect.absTop + imgRect.absHeight - 0.05;
  const spanned = new Set([...hovPara().querySelectorAll('x-layout-column')]
    .flatMap(col => [...col.shadowRoot.querySelectorAll('span[data-source-offset]')]
      .map(s => Number(s.dataset.sourceOffset))));
  let inside = 0, checked = 0;
  for (const off of spanned) {
    const rc = hovPara().engine.getCharRect(off);
    if (!rc) continue;
    checked++;
    const cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
    if (cx > ix0 && cx < ix1 && cy > iy0 && cy < iy1) inside++;
  }
  const H3 = { checked, inside };
  docH.unparkPage('hov-img');
  await sleep(400);
  const H4 = { split: hovSplit(), match: hovDomText() === hovPara().engine.plainText };
  docH.remove();
  out.H = { H1, H2, H3, H4 };

  // ── G. PageMountManager ──
  // 주의: bench 페이지(상단 bench 문서와 검증 문서를 공유)이므로 절대 스크롤
  // 좌표가 아니라 scrollIntoView로 대상 페이지를 뷰포트에 둔다.
  const { PageMountManager } = await import('/src/utils/page-mount-manager.ts');
  const mgr = new PageMountManager({ document: doc, window: 1 });
  mgr.attach();
  await sleep(500);
  const scrollPageIntoView = (id, block) => {
    const box = byId(id);
    const node = box ?? doc.querySelector(`div[data-parked-page="${id}"]`);
    if (node) node.scrollIntoView({ block: block ?? 'start' });
  };
  const page0H = byId('page-0').offsetHeight;
  scrollPageIntoView('page-5', 'end');
  await sleep(600);
  const mountedBottom = mgr.mountedIds;
  const ph0 = doc.querySelector('div[data-parked-page="page-0"]');
  const gBottom = {
    mounted: mountedBottom.join(','),
    page0Parked: !mountedBottom.includes('page-0'),
    page5Mounted: mountedBottom.includes('page-5'),
    placeholderSized: !!ph0 && Math.abs(ph0.offsetHeight - page0H) <= 1,
  };
  scrollPageIntoView('page-0', 'start');
  await sleep(600);
  const gTop = {
    page0Remounted: mgr.mountedIds.includes('page-0'),
    textMatch: domText(byId('page-0')) === engText(byId('page-0')),
  };
  mgr.pin('page-1');
  scrollPageIntoView('page-5', 'end');
  await sleep(600);
  const pinnedKept = mgr.mountedIds.includes('page-1');
  mgr.unpin('page-1');
  scrollPageIntoView('page-4', 'center');
  await sleep(600);
  const unpinnedGone = !mgr.mountedIds.includes('page-1');
  // G1 + 매니저: 플레이스홀더 존재 상태에서 data 세터 — 부활 없음
  const mountedBefore = mgr.mountedIds.length;
  doc.data = doc.data;
  await sleep(300);
  const gRoundTrip = {
    mountedCountStable: mgr.mountedIds.length === mountedBefore,
    engines: doc.engine.childBoxEngines.length,
    extractChildren: doc.data.children.length,
  };
  mgr.detach();
  // 원복: 전부 마운트
  for (const id of [...doc.parkedPageIds]) {
    const el = doc.unparkPage(id);
    if (el) await el.render();
  }
  await sleep(300);
  out.G = {
    ...gBottom, ...gTop, pinnedKept, unpinnedGone, ...gRoundTrip,
    allRemounted: doc.items.length === 6,
    finalMatch: byIds().every(id => {
      const box = byId(id);
      if (!box || !box.querySelector('x-layout-paragraph')) return true;
      return domText(box) === engText(box);
    }),
  };

  // ── J. 성능 이득 실측 (30페이지) ──
  const docJ = document.createElement('x-layout-document');
  document.body.appendChild(docJ);
  const jchildren = [];
  for (let i = 0; i < 30; i++) {
    jchildren.push({
      type: 'box', id: `jpage-${i}`, position: 'absolute', left: 10, top: i * 115, width: 170, height: 100,
      children: { type: 'paragraph', content: `페이지${i}번-가상화성능측정용본문가나다라.`.repeat(35), paragraphStyle: {}, textStyle: {} },
    });
  }
  const tFull0 = performance.now();
  docJ.data = {
    width: 190, height: 30 * 115, columns: 1, gap: 0,
    paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 }, children: jchildren,
  };
  await docJ.render();
  await sleep(500);
  const tFull1 = performance.now();
  const countSpans = () => docJ.querySelectorAll('x-layout-box').length === 0 ? 0 :
    [...docJ.querySelectorAll('x-layout-paragraph')].reduce((n, p) =>
      n + [...p.querySelectorAll('x-layout-column')].reduce((m, col) =>
        m + col.shadowRoot.querySelectorAll('span[data-source-offset]').length, 0), 0);
  const fullSpans = countSpans();
  const tPark0 = performance.now();
  const parkedIds = [];
  for (let i = 0; i < 30; i++) {
    if (i < 14 || i > 16) {
      const ph = docJ.parkPage(`jpage-${i}`);
      if (ph) { ph.style.width = '644px'; ph.style.height = '378px'; parkedIds.push(`jpage-${i}`); }
    }
  }
  const tPark1 = performance.now();
  const windowedSpans = countSpans();
  const remountMs = [];
  for (const id of ['jpage-0', 'jpage-14', 'jpage-29']) {
    const t0 = performance.now();
    const el = docJ.unparkPage(id);
    if (el) await el.render();
    remountMs.push(Math.round((performance.now() - t0) * 10) / 10);
  }
  await sleep(300);
  const sampleMatch = ['jpage-0', 'jpage-14', 'jpage-29'].every(id => {
    const box = [...docJ.querySelectorAll('x-layout-box')].find(b => b.id === id);
    const p = box.querySelector('x-layout-paragraph');
    const dom = [...p.querySelectorAll('x-layout-column')]
      .map(col => [...col.shadowRoot.querySelectorAll('span[data-source-offset]')].map(s => s.textContent).join('')).join('');
    return dom === p.engine.plainText;
  });
  docJ.remove();
  out.J = {
    fullRenderMs: Math.round(tFull1 - tFull0),
    fullSpans,
    parkTotalMs: Math.round((tPark1 - tPark0) * 10) / 10,
    parkedCount: parkedIds.length,
    windowedSpans,
    remountMs,
    sampleMatch,
  };

  window.__vdoc = doc;

  return out;
});

// ── I. 리사이즈 기반 attach/detach ──
// 리사이즈는 IO를 재발화한다. 엔진(mm)은 무영향이어야 하고 마운트 집합만 변한다.
// 뷰포트 변경은 Node 컨텍스트(page.setViewportSize)에서 수행하므로 단계별 evaluate로 나눈다.
const ri1 = await page.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const { PageMountManager } = await import('/src/utils/page-mount-manager.ts');
  const doc = window.__vdoc;
  const mgr2 = new PageMountManager({ document: doc, window: 1 });
  mgr2.attach();
  window.__mgr2 = mgr2;
  const box = [...doc.querySelectorAll('x-layout-box')].find(b => b.id === 'page-2');
  if (box) box.scrollIntoView({ block: 'center' });
  await sleep(600);
  const domText = (pageBox) => {
    const p = pageBox.querySelector('x-layout-paragraph');
    return [...p.querySelectorAll('x-layout-column')]
      .map(col => [...col.shadowRoot.querySelectorAll('span[data-source-offset]')].map(s => s.textContent).join('')).join('');
  };
  return { baseMounted: mgr2.mountedIds.join(','), baseMatch: domText(box) === box.querySelector('x-layout-paragraph').engine.plainText };
});
await page.setViewportSize({ width: 800, height: 300 });
const ri2 = await page.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(800);
  const m = window.__mgr2;
  const doc = window.__vdoc;
  let smallMatch = true;
  if (m.mountedIds.includes('page-2')) {
    const box = [...doc.querySelectorAll('x-layout-box')].find(b => b.id === 'page-2');
    const p = box.querySelector('x-layout-paragraph');
    const dom = [...p.querySelectorAll('x-layout-column')]
      .map(col => [...col.shadowRoot.querySelectorAll('span[data-source-offset]')].map(s => s.textContent).join('')).join('');
    smallMatch = dom === p.engine.plainText;
  }
  return { smallMounted: m.mountedIds.join(','), smallCount: m.mountedIds.length, smallMatch };
});
await page.setViewportSize({ width: 800, height: 1400 });
const ri3 = await page.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(800);
  const m = window.__mgr2;
  return { largeMounted: m.mountedIds.join(','), largeCount: m.mountedIds.length };
});
await page.setViewportSize({ width: 800, height: 600 });
await page.evaluate(async () => {
  await new Promise(r => setTimeout(r, 600));
  window.__mgr2.detach();
});

// ── 판정 ──
check('A. 기준선: 6페이지 마운트', r.A.items === 6, `items=${r.A.items}`);
check('A. 기준선: 엔진 6엔트리', r.A.engines === 6, `engines=${r.A.engines}`);
check('A. 기준선: DOM===엔진 (전 페이지)', r.A.textMatch === true);
check('B. park: 플레이스홀더 교체', r.B.placeholder === true);
check('B. park: items 5개 (6-1)', r.B.items === 5, `items=${r.B.items}`);
check('B. park: parkedPageIds', r.B.parked === '["page-2"]', r.B.parked);
check('B. park: 엔진 6유지', r.B.engines === 6, `engines=${r.B.engines}`);
check('B. park: extractData 6유지 + page-2 포함', r.B.extractChildren === 6 && r.B.hasPage2 === true);
check('B. park: 플레이스홀더가 원래 인덱스(2)', r.B.placeholderIndex === 2, `idx=${r.B.placeholderIndex}`);
check('B. park: 나머지 페이지 정합', r.B.othersMatch === true);
check('C. G1: data 세터 후 부활 없음 (items 5)', r.C.items === 5, `items=${r.C.items}`);
check('C. G1: 보관 유지', r.C.parked === '["page-2"]', r.C.parked);
check('C. G1: 엔진 6유지', r.C.engines === 6, `engines=${r.C.engines}`);
check('C. G1: 나머지 페이지 정합', r.C.othersMatch === true);
check('D. 보관 중 편집: 보관 유지', r.D.stillParked === '["page-2"]', r.D.stillParked);
check('D. unpark 복원 + 순서 보존', r.D.restored === true && r.D.items === 6 && r.D.order === 'page-0,page-1,page-2,page-3,page-4,page-5', `order=${r.D.order}`);
check('D. unpark 후 편집 텍스트 반영 + 정합', r.D.textMatch === true && r.D.edited === true);
check('E. P1: detach 시 포커스 해제 (설계 동작)', r.E.savedOffset === 10 && r.E.focusCleared === true, `saved=${r.E.savedOffset}`);
check('E. P1: 컨트롤러 재생성 + 커서 복원', r.E.controllerRecreated === true && r.E.cursorRestored === true);
check('E. P1: 재부착 예약 렌더 실행', r.E.scheduledRender === true);
check('E. P1: 복원 후 정합', r.E.textMatch === true);
check('F. P3: 자식 선택 1개', r.F.selBefore === 1, `sel=${r.F.selBefore}`);
check('F. P3: detach 시 선택 해제 + 1회 dispatch', r.F.selAfter === 0 && r.F.selDispatches === 1, `after=${r.F.selAfter},dispatch=${r.F.selDispatches}`);
check('F. P3: 이미지 모드 진입', r.F.imgModeBefore === true);
check('F. P3: detach 시 이미지 포커스 해제 + 모드 종료', r.F.focusedImageCleared === true && r.F.imgModeOff === true);
check('G. 매니저: 하단 스크롤 시 page-0 분리 + page-5 유지', r.G.page0Parked === true && r.G.page5Mounted === true, `mounted=${r.G.mounted}`);
check('G. 매니저: 플레이스홀더 footprint 유지', r.G.placeholderSized === true);
check('G. 매니저: 상단 복귀 시 재마운트 + 정합', r.G.page0Remounted === true && r.G.textMatch === true);
check('G. 매니저: pin 유지', r.G.pinnedKept === true);
check('G. 매니저: unpin 후 분리', r.G.unpinnedGone === true);
check('G. 매니저+G1: data 세터 후 마운트 수 안정 + 엔진 완결', r.G.mountedCountStable === true && r.G.engines === 6 && r.G.extractChildren === 6);
check('G. 매니저: 전 페이지 복원 + 최종 정합', r.G.allRemounted === true && r.G.finalMatch === true);
check('H. 오버랩 기준선: 교차 라인 파트 분할 + 정합', r.H.H1.split === true && r.H.H1.match === true);
check('H. 핵심: 분리 상태 재계산도 회피 유지 + 정합', r.H.H2.split === true && r.H.H2.match === true && r.H.H2.engines === 2);
check('H. 핵심: 가시 글자 이미지 rect 침범 0', r.H.H3.checked > 0 && r.H.H3.inside === 0, `checked=${r.H.H3.checked}`);
check('H. 복원 후 회피 + 정합', r.H.H4.split === true && r.H.H4.match === true);
check('I. 기준선(600px): page-2 중심 윈도우', ri1.baseMounted.includes('page-2') && ri1.baseMatch === true, `mounted=${ri1.baseMounted}`);
check('I. 축소(300px): 마운트 축소 + 정합', ri2.smallCount < 6 && ri2.smallMatch === true, `mounted=${ri2.smallMounted}`);
check('I. 확대(1400px): 마운트 확대', ri3.largeCount > ri2.smallCount, `large=${ri3.largeMounted} small=${ri2.smallMounted}`);
check('J. 픽스처 규모', r.J.fullSpans > 10000, `spans=${r.J.fullSpans}, fullRender=${r.J.fullRenderMs}ms`);
check('J. 윈도우 노드 절감', r.J.windowedSpans < r.J.fullSpans * 0.25, `${r.J.windowedSpans}/${r.J.fullSpans} (park ${r.J.parkTotalMs}ms)`);
check('J. 재마운트 비용', r.J.remountMs.every(ms => ms < 1000) && r.J.sampleMatch === true, `remount=[${r.J.remountMs.join(',')}]ms`);

await browser.close();
if (server) server.kill();
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);
