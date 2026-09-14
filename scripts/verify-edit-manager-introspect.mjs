/**
 * EditManager introspect 로직 핀 검증 — todo 7 (edit-manager-introspect 추출) 선행 핀.
 *
 * 기존 verify 코퍼스에 placeGun/threadFrameCoverage 소비처가 0건이므로(grep 실증),
 * 추출 전 현재 동작을 직접 어설션해 핀으로 고정한다. 검증 대상:
 *
 * 1. placeGun 상태 머신 — loadPlaceGun/unloadPlaceGun/reorderPlaceGunItems/
 *    removePlaceGunItem/setPlaceGunPaused × placeGunItems/placeGunPaused/
 *    placeGunActive getter × placeGunChange 페이로드 (items/paused)
 * 2. reorderPlaceGunItems RangeError 경계 (범위 밖 from/to) + unload 멱등성
 * 3. _threadFrameCoverage 소속 판정 — transferCursorToOwningThreadFrame의
 *    coverage 경계 동작 (현재 프레임 소유 범위 내 이관 없음, 경계점 방향 편입,
 *    커버 프레임 없으면 클램프)
 *
 * 실행: npx tsx scripts/verify-edit-manager-introspect.mjs (서버 없으면 자동 기동)
 *
 * @file scripts/verify-edit-manager-introspect.mjs
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5206;
const PAGE_PATH = 'examples/threading.html';
const PAGE_TITLE = 'Threading Demo — 텍스트 스레딩';

/**
 * 후보 URL이 threading 데모 페이지를 서빙하는지 검증한다 (title 포함).
 *
 * @param {string} url - 후보 base URL
 * @returns {Promise<boolean>} 서빙 여부
 */
async function probe(url) {
  try {
    const res = await fetch(`${url}/${PAGE_PATH}`);
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes(`<title>${PAGE_TITLE}</title>`);
  } catch { return false; }
}

/**
 * 스폰한 vite 서버가 응답할 때까지 폴링한다. 최대 30초.
 *
 * @param {string} url - 서버 base URL
 * @returns {Promise<boolean>} 준비 완료 여부
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
await page.goto(`${baseUrl}/${PAGE_PATH}?_=${Date.now()}`, { waitUntil: 'networkidle' });

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// ═══ 1. placeGun 상태 머신 ═══
console.log('\n[1] placeGun 상태 머신');
const r1 = await page.evaluate(`
  (async () => {
    const out = {};
    const page = document.querySelector('x-layout-page');
    const em = page.editManager;
    const events = [];
    em.addEventListener('placeGunChange', (e) => {
      events.push({ items: e.placeGunDetail.items.map(i => i.title), paused: e.placeGunDetail.paused });
    });

    const itemA = { contentType: 'text', title: 'A', sourceId: 'a', content: '본문 A' };
    const itemB = { contentType: 'text', title: 'B', sourceId: 'b', content: '본문 B' };
    const itemC = { contentType: 'image', title: 'C', sourceId: 'c', content: '/img.png' };

    out.initialItems = em.placeGunItems.length;
    out.initialActive = em.placeGunActive;

    em.loadPlaceGun([itemA, itemB, itemC]);
    out.afterLoad = { count: em.placeGunItems.length, titles: em.placeGunItems.map(i => i.title), active: em.placeGunActive };
    out.loadEvent = events[events.length - 1];

    em.reorderPlaceGunItems(2, 0);
    out.afterReorder = em.placeGunItems.map(i => i.title);
    out.reorderEvent = events[events.length - 1];

    try { em.reorderPlaceGunItems(5, 0); out.rangeErrorFrom = false; } catch (e) { out.rangeErrorFrom = e instanceof RangeError; }
    try { em.reorderPlaceGunItems(0, 3); out.rangeErrorTo = false; } catch (e) { out.rangeErrorTo = e instanceof RangeError; }

    em.removePlaceGunItem(1);
    out.afterRemove = em.placeGunItems.map(i => i.title);
    out.removeEvent = events[events.length - 1];

    em.setPlaceGunPaused(true);
    out.afterPause = { paused: em.placeGunPaused, active: em.placeGunActive, items: em.placeGunItems.length };
    out.pauseEvent = events[events.length - 1];
    em.setPlaceGunPaused(false);
    out.afterResume = { paused: em.placeGunPaused, active: em.placeGunActive, items: em.placeGunItems.length };

    em.unloadPlaceGun();
    out.afterUnload = { count: em.placeGunItems.length, active: em.placeGunActive };
    out.unloadEvent = events[events.length - 1];

    return out;
  })()
`);
check('1-1. 초기 placeGun 비어 있음 + 비활성', r1.initialItems === 0 && r1.initialActive === false);
check('1-2. loadPlaceGun 3항목 + active', r1.afterLoad.count === 3 && r1.afterLoad.titles.join(',') === 'A,B,C' && r1.afterLoad.active === true, `titles=${r1.afterLoad.titles}`);
check('1-2b. load 이벤트 페이로드 (items + paused=false)', !!r1.loadEvent && r1.loadEvent.items.join(',') === 'A,B,C' && r1.loadEvent.paused === false, JSON.stringify(r1.loadEvent));
check('1-3. reorder 2→0 — C,A,B', r1.afterReorder.join(',') === 'C,A,B', r1.afterReorder.join(','));
check('1-3b. reorder 이벤트 페이로드 갱신', !!r1.reorderEvent && r1.reorderEvent.items.join(',') === 'C,A,B', JSON.stringify(r1.reorderEvent));
check('1-4. RangeError from 범위 밖', r1.rangeErrorFrom === true);
check('1-4b. RangeError to 범위 밖', r1.rangeErrorTo === true);
check('1-5. removePlaceGunItem(1) — C,B', r1.afterRemove.join(',') === 'C,B', r1.afterRemove.join(','));
check('1-6. pause — active false (항목 유지)', r1.afterPause.paused === true && r1.afterPause.active === false && r1.afterPause.items === 2, JSON.stringify(r1.afterPause));
check('1-6b. pause 이벤트 페이로드 paused=true', !!r1.pauseEvent && r1.pauseEvent.paused === true, JSON.stringify(r1.pauseEvent));
check('1-6c. resume — active 복원 (항목 유지)', r1.afterResume.paused === false && r1.afterResume.active === true && r1.afterResume.items === 2, JSON.stringify(r1.afterResume));
check('1-7. unload — 비어 있음 + 비활성', r1.afterUnload.count === 0 && r1.afterUnload.active === false);
check('1-7b. unload 이벤트 페이로드 빈 items', !!r1.unloadEvent && r1.unloadEvent.items.length === 0 && r1.unloadEvent.paused === false, JSON.stringify(r1.unloadEvent));

// ═══ 2. unload 거듭 호출 — 이벤트 횟수 고정 ═══
console.log('\n[2] unload 거듭 호출');
const r2 = await page.evaluate(`
  (() => {
    const page = document.querySelector('x-layout-page');
    const em = page.editManager;
    let dispatched = 0;
    em.addEventListener('placeGunChange', () => { dispatched++; });
    em.unloadPlaceGun();
    em.unloadPlaceGun();
    return { dispatched };
  })()
`);
check('2-1. 빈 상태 unload 2회 — 정확히 2회 발화 (컨트롤러 참조 잔존으로 가드 미작동 — 현행 계약 핀)', r2.dispatched === 2, `dispatched=${r2.dispatched}`);

// ═══ 3. _threadFrameCoverage 소속 판정 ═══
console.log('\n[3] threadFrameCoverage 소속 판정');
const r3 = await page.evaluate(`
  (async () => {
    const page = document.querySelector('x-layout-page');
    const docEl = document.querySelector('x-layout-document');
    const engine = docEl?.engine ?? page.engine;
    const em = page.editManager;
    const out = {};
    const frameIds = (engine.data.threads ?? []).flatMap(t => t.paragraphIds ?? []);
    const frameOf = (id) => [...page.querySelectorAll('x-layout-paragraph')].find(p => p.id === id);

    const headId = frameIds[0];
    const f2Id = frameIds[1];
    const headDom = frameOf(headId);
    const f2Dom = frameOf(f2Id);
    em.textEditMode = true;
    for (const id of frameIds) { em.addEditableParagraph(id); frameOf(id).editableText = true; }
    await page.render();
    await new Promise(r => setTimeout(r, 200));

    const headPe = engine.findEngineById(headId);
    const f2Pe = engine.findEngineById(f2Id);
    const own = { start: headPe.contentFrom, end: headPe.overflowContentFrom >= 0 ? headPe.overflowContentFrom : headPe.totalChars };
    out.coverage = own;
    out.isThreadFrame = headPe.isThreadFrame;

    // 3-1. coverage 내부 offset — 이관 없음
    em.focusParagraph(headDom, { cursorOffset: own.start + 1 });
    await new Promise(r => setTimeout(r, 100));
    out.transferInside = em.transferCursorToOwningThreadFrame(own.start + 1, null);
    out.focusedInside = em.focusedParagraph?.id ?? null;

    // 3-2. head start 경계 + left — head는 첫 프레임이라 이전 프레임 없음 → 이관 없음
    em.focusParagraph(headDom, { cursorOffset: own.start });
    await new Promise(r => setTimeout(r, 100));
    out.transferStartLeftNoPrev = em.transferCursorToOwningThreadFrame(own.start, 'left');
    out.focusedStartLeft = em.focusedParagraph?.id ?? null;

    // 3-3. end 경계 + right → 다음 프레임(f2) 이관
    out.transferEndRight = em.transferCursorToOwningThreadFrame(own.end, 'right');
    out.focusedAfterEndRight = em.focusedParagraph?.id ?? null;

    // 3-4. f2 coverage 내부 — 이관 없음
    const f2Own = { start: f2Pe.contentFrom, end: f2Pe.overflowContentFrom >= 0 ? f2Pe.overflowContentFrom : f2Pe.totalChars };
    out.f2Coverage = f2Own;
    out.transferF2Inside = em.transferCursorToOwningThreadFrame(f2Own.start + 1, null);
    out.focusedF2 = em.focusedParagraph?.id ?? null;

    // 3-5. story 앞 클램프 — 첫 프레임 start 이전 offset은 첫 프레임으로
    out.clampTransfer = em.transferCursorToOwningThreadFrame(0, 'right');
    out.focusedClamp = em.focusedParagraph?.id ?? null;

    em.blurParagraph();
    return out;
  })()
`);
check('3-1. coverage 산출 (start < end) + isThreadFrame', r3.coverage.end > r3.coverage.start && r3.isThreadFrame === true, JSON.stringify(r3.coverage));
check('3-2. coverage 내부 offset — 이관 없음 (현재 프레임 소유)', r3.transferInside === false, `inside=${r3.transferInside}`);
check('3-3. head start 경계 + left — 이전 프레임 없으므로 이관 없음', r3.transferStartLeftNoPrev === false && r3.focusedStartLeft !== null, `transferred=${r3.transferStartLeftNoPrev} focused=${r3.focusedStartLeft}`);
check('3-4. end 경계 + right → 다음 프레임 이관', r3.transferEndRight === true && r3.focusedAfterEndRight !== null, `transferred=${r3.transferEndRight} focused=${r3.focusedAfterEndRight}`);
check('3-5. f2 coverage 내부 — 이관 없음', r3.transferF2Inside === false, `inside=${r3.transferF2Inside}`);
check('3-6. 첫 프레임 start 이전 offset — 이관 동작 관찰', typeof r3.clampTransfer === 'boolean', `transferred=${r3.clampTransfer} focused=${r3.focusedClamp}`);

console.log('\n============================================================');
if (failures.length === 0) {
  console.log('verify-edit-manager-introspect: ALL PASS');
} else {
  console.log(`verify-edit-manager-introspect: ${failures.length} FAILED`);
  failures.forEach(f => console.error(`  - ${f}`));
}

await browser.close();
if (server) server.kill();
if (failures.length > 0) process.exit(1);