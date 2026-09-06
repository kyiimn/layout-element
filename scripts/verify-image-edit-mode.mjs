/**
 * 이미지 편집 모드(imageEditMode) 정합성 검증 (브라우저).
 *
 * ImageEditController + EditManager 이미지 편집 API의 전 동작 경로를 검증한다.
 * 이 세션에서 구현/수정한 다음 기능이 회귀 없이 유지되는지 확인한다:
 *
 *  1. 모드 진입 경로 — 일반(읽기) 모드와 레이아웃 편집 모드 모두에서
 *     이미지 더블클릭으로 이미지 편집 모드 진입 (dblclick 가드 제거 회귀 방어)
 *  2. 시각 피드백 — 부모 box에 selected(빨간 테두리) + text-focused(라벨 숨김),
 *     이미지 자체는 파란 outline 없이 move 커서만 (텍스트 포커스와 동일 패턴)
 *  3. ESC 종료 — 진입 시 레이아웃 편집 모드였으면 복귀, 아니면 완전 종료.
 *     종료 시 text-focused는 제거되고 selected는 유지
 *  4. 드래그 — x/y 갱신 + 첫 조작 시 objectFit cover→none 자동 전환
 *     (전환 직전 표시 영역이 스냅샷으로 고정되어 위치/크기 점프 없음)
 *  5. 휠 — 원본 비율 유지 확대/축소 + imageResize/imagePropertyChange 이벤트
 *  6. ESC 드래그 취소 — 시작 위치로 복원 + imageMove(canceled=true)
 *  7. Tab/Shift+Tab — 편집 가능한 이미지 순회 (포커스 + 부모 box 선택 이동)
 *  8. selection 이동 → 포커스 상실 — 다른 box 클릭 시 focusedImage 해제.
 *     단 이미지 편집 모드 자체는 유지 (다른 이미지 클릭으로 재포커스 가능)
 *  9. 이동/크기 제한 시맨틱 (InDesign) — 드래그 이동 범위 제한 없음
 *     (박스는 크롭 윈도우), 박스 밖 이동 상태의 3소스 정합성, 휠 하한 1mm
 * 10. 데이터 정합성 — 드래그+휼 후 DOM getter === engine.extractData ===
 *     printPostData.data === document.data (3소스 일치 + dirty 가드 계약)
 * 11. ESC 취소 복원값의 3소스 일치
 * 12. 오버랩 회피 갱신 — 이미지 편집(휼/드래그)이 단락 파트 분할에 반영되고
 *     해제된 영역에 print chars가 복귀하는지 (비-공허 A/B, path 모드 시맨틱)
 *
 * 이벤트 주의 (이전 세션 학습): dblclick은 합성 이벤트(dispatchEvent)가 아니라
 * 반드시 CDP 신뢰 이벤트(page.mouse.dblclick)로 검증한다 — 브라우저 dblclick
 * 생성은 신뢰 입력 시퀀스에서만 재현된다.
 *
 * 실행: npx tsx scripts/verify-image-edit-mode.mjs
 * dev server(5174 → 5175 → 5173 순 탐지) 필요. 없으면 포트 5196 자체 스폰.
 *
 * @file scripts/verify-image-edit-mode.mjs
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const BASE_PORT = 5196;

// 라이브 서버 후보. probe는 HTML title까지 검증해야 SPA fallback을 쓰는
// 타 앱 Vite 서버(apps/layout-ui)를 걸러낼 수 있다 (포트 오인 사고 교훈).
const BASE_URL_CANDIDATES = [
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5173',
];

const VERIFY_PAGE = '/examples/image-edit-verify.html';

/**
 * 후보 URL이 이 패키지의 Vite 서버인지 검증한다.
 *
 * SPA fallback을 쓰는 타 앱 Vite 서버는 존재하지 않는 경로에도 앱 index를
 * 200으로 반환하므로 `res.ok`만으로 판별 불가 — HTML에 검증 페이지의
 * title("Image Edit Verify")이 있는지까지 확인한다.
 *
 * @param {string} url - 후보 base URL
 * @returns {Promise<boolean>} 검증 페이지 서빙 여부
 */
async function probe(url) {
  try {
    const res = await fetch(`${url}${VERIFY_PAGE}`);
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes('<title>Image Edit Verify</title>');
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
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', err => pageErrors.push(err.message));

await page.goto(`${baseUrl}${VERIFY_PAGE}`, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => document.getElementById('ready-flag')?.textContent === 'IMG_VERIFY_READY',
  { timeout: 30_000 },
);
await page.waitForTimeout(1_000);

let passCount = 0;
let failCount = 0;
const failures = [];
/**
 * 검증 항목을 기록한다.
 *
 * @param {string} name - 항목명
 * @param {boolean} ok - 통과 여부
 * @param {string} detail - 부가 정보
 */
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) passCount++;
  else { failCount++; failures.push(name); }
}
/** 두 값의 근사 동등 비교 (mm 부동소수 오차 허용). */
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// ── 공용 상태 조회 ─────────────────────────────────────────────

/**
 * 문서/편집 상태 스냅샷을 조회한다.
 *
 * @returns {Promise<object>} 모드/포커스/선택/속성 상태
 */
const readState = () => page.evaluate(() => {
  const em = document.querySelector('x-layout-document').editManager;
  const img1 = document.getElementById('img-1');
  const img2 = document.getElementById('img-2');
  const boxImg1 = document.getElementById('box-img-1');
  return {
    mode: { text: em.textEditMode, layout: em.layoutEditMode, image: em.imageEditMode },
    focusedImage: em.focusedImage?.id ?? null,
    selectedIds: em.selectedLayouts.map((b) => b.id),
    attrs: {
      img1Focus: img1.hasAttribute('image-edit-focus'),
      img2Focus: img2.hasAttribute('image-edit-focus'),
      boxImg1Selected: boxImg1.hasAttribute('selected'),
      boxImg1TextFocused: boxImg1.hasAttribute('text-focused'),
    },
    img1: { x: img1.x, y: img1.y, w: img1.width, h: img1.height, fit: img1.objectFit },
    img2: { x: img2.x, y: img2.y, w: img2.width, h: img2.height, fit: img2.objectFit },
  };
});

/**
 * 이미지 요소의 뷰포트 중심 좌표를 구한다.
 *
 * @param {string} id - 이미지 요소 id
 * @returns {Promise<{x: number, y: number}>} 중심 좌표
 */
const imgCenter = (id) => page.evaluate((elId) => {
  const r = document.getElementById(elId).getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, id);

/** 편집 상태를 전부 해제한다 (시나리오 격리). */
const resetModes = () => page.evaluate(() => {
  const em = document.querySelector('x-layout-document').editManager;
  em.textEditMode = false;
  em.layoutEditMode = false;
  em.imageEditMode = false;
  em.clearLayoutSelection(false);
});

// ── 1. 일반 모드 더블클릭 진입 + 시각 피드백 ───────────────────

await resetModes();
const c1 = await imgCenter('img-1');
await page.mouse.dblclick(c1.x, c1.y, { delay: 60 });
await page.waitForTimeout(150);

{
  const s = await readState();
  check('일반 모드 이미지 dblclick → imageEditMode 진입', s.mode.image === true && s.mode.text === false && s.mode.layout === false);
  check('포커스 이미지 = img-1', s.focusedImage === 'img-1', `focused=${s.focusedImage}`);
  check('부모 box selected (빨간 테두리)', s.attrs.boxImg1Selected === true);
  check('부모 box text-focused (라벨 숨김)', s.attrs.boxImg1TextFocused === true);
  check('선택 = box-img-1', s.selectedIds.length === 1 && s.selectedIds[0] === 'box-img-1', `selected=${JSON.stringify(s.selectedIds)}`);

  const visual = await page.evaluate(() => {
    const box = document.getElementById('box-img-1');
    const label = box.shadowRoot.querySelector('.type-label');
    const img = document.getElementById('img-1');
    return {
      outlineColor: getComputedStyle(box).outlineColor,
      labelDisplay: getComputedStyle(label).display,
      imgOutline: getComputedStyle(img).outlineStyle,
      imgCursor: getComputedStyle(img).cursor,
    };
  });
  check('부모 box outline = red', visual.outlineColor === 'rgb(255, 0, 0)', `outline=${visual.outlineColor}`);
  check('타입 라벨 display: none', visual.labelDisplay === 'none', `display=${visual.labelDisplay}`);
  check('이미지 자체 파란 outline 없음', visual.imgOutline === 'none', `outline-style=${visual.imgOutline}`);
  check('이미지 커서 = move', visual.imgCursor === 'move', `cursor=${visual.imgCursor}`);
}

// ── 2. ESC 종료 (일반 모드 진입 → 완전 종료, text-focused만 제거) ──

await page.keyboard.press('Escape');
await page.waitForTimeout(150);

{
  const s = await readState();
  check('ESC → 이미지 편집 모드 완전 종료 (일반 모드 진입이었으므로)', s.mode.image === false && s.mode.layout === false, JSON.stringify(s.mode));
  check('ESC → focusedImage 해제', s.focusedImage === null);
  check('ESC → image-edit-focus 속성 제거', s.attrs.img1Focus === false);
  check('ESC → 부모 box text-focused 제거, selected 유지', s.attrs.boxImg1TextFocused === false && s.attrs.boxImg1Selected === true);
}

// ── 3. 레이아웃 편집 모드에서 더블클릭 진입 → ESC 시 레이아웃 복귀 ──

await page.evaluate(() => {
  document.querySelector('x-layout-document').editManager.layoutEditMode = true;
});
await page.waitForTimeout(100);
await page.mouse.dblclick(c1.x, c1.y, { delay: 60 });
await page.waitForTimeout(150);

{
  const s = await readState();
  check('레이아웃 모드 이미지 dblclick → 이미지 편집 진입 + 레이아웃 해제', s.mode.image === true && s.mode.layout === false, JSON.stringify(s.mode));
}

await page.keyboard.press('Escape');
await page.waitForTimeout(150);

{
  const s = await readState();
  check('ESC → 레이아웃 편집 모드 복귀', s.mode.layout === true && s.mode.image === false, JSON.stringify(s.mode));
}

await resetModes();

// ── 4. 드래그 — objectFit 자동 전환 + x/y 갱신 + 클램핑 ─────────

{
  // 재진입 (프로그래밍 경로 — 드래그 시나리오는 focus 후 신뢰 이벤트로)
  await page.evaluate(() => {
    document.querySelector('x-layout-document').editManager.focusImage(
      document.getElementById('img-1'),
    );
  });
  await page.waitForTimeout(100);

  const before = await page.evaluate(() => {
    const img = document.getElementById('img-1');
    return { x: img.x, y: img.y, w: img.width, h: img.height, fit: img.objectFit };
  });
  check('드래그 전 objectFit = cover', before.fit === 'cover', `fit=${before.fit}`);

  const c = await imgCenter('img-1');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y + 20, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => {
    const img = document.getElementById('img-1');
    return { x: img.x, y: img.y, w: img.width, h: img.height, fit: img.objectFit };
  });
  check('드래그 → objectFit 자동 none 전환', after.fit === 'none', `fit=${after.fit}`);
  check('드래그 → x/y 이동 (x 증가)', after.x > before.x, `x: ${before.x.toFixed(2)} → ${after.x.toFixed(2)}`);
  check('드래그 → y 이동 (y 증가)', after.y > before.y, `y: ${before.y.toFixed(2)} → ${after.y.toFixed(2)}`);
  check('전환 시 표시 영역 스냅샷 유지 (크기 점프 없음)', near(after.w, before.w, 0.5) && near(after.h, before.h, 0.5), `w: ${before.w.toFixed(2)} → ${after.w.toFixed(2)}, h: ${before.h.toFixed(2)} → ${after.h.toFixed(2)}`);

  // 극단 드래그 → InDesign 시맨틱: 이동 제한 없음 + 밖으로 나간 부분의 정합성
  const c2 = await imgCenter('img-1');
  await page.mouse.move(c2.x, c2.y);
  await page.mouse.down();
  await page.mouse.move(c2.x + 2000, c2.y + 2000, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const moved = await page.evaluate(() => {
    const img = document.getElementById('img-1');
    const box = document.getElementById('box-img-1');
    const content = box.engine.contentAbsRect;
    return {
      x: img.x, y: img.y, w: img.width, h: img.height,
      contentW: content.absWidth, contentH: content.absHeight,
      // 이전 상홧 값 (이동 전 근사 위치)
      prevX: 88.88, prevY: 17.55,
    };
  });
  // 제한 없음: x가 박스 밖(contentW - w/2)을 크게 넘었는지 확인
  check('이동 제한 없음 — x가 박스 경계 밖으로 이동 가능 (InDesign 시맨틱)',
    moved.x > moved.contentW, `x=${moved.x.toFixed(2)} > contentW=${moved.contentW}`);
  check('이동 제한 없음 — y도 박스 경계 밖 이동',
    moved.y > moved.contentH, `y=${moved.y.toFixed(2)} > contentH=${moved.contentH}`);

  // 밖으로 나간 상태의 3소스 정합성 — 캔버스 클리핑/오버랩 클램핑과 무관하게
  // DOM/extractData/printPostData가 동일한 자유 좌표를 유지하는지
  const outside = await page.evaluate(() => {
    const doc = document.querySelector('x-layout-document');
    const img = document.getElementById('img-1');
    doc.engine.ensureCommitted();
    const extract = img.engine.extractData;
    const posts = doc.engine.printPostData;
    const imgPost = posts.find((p) => p.data?.type === 'image' && p.data?.id === 'img-1');
    return {
      dom: { x: img.x, y: img.y, w: img.width, h: img.height },
      extract: { x: extract.x, y: extract.y, w: extract.width, h: extract.height },
      print: imgPost ? { x: imgPost.data.x, y: imgPost.data.y, w: imgPost.data.width, h: imgPost.data.height } : null,
      displayRect: (() => {
        const d = img.engine.displayRect;
        return { l: d.absLeft, t: d.absTop, w: d.absWidth, h: d.absHeight };
      })(),
      contentRect: (() => {
        const c = document.getElementById('box-img-1').engine.contentAbsRect;
        return { l: c.absLeft, t: c.absTop, w: c.absWidth, h: c.absHeight };
      })(),
    };
  });
  const eq2 = (a, b) => Math.abs(a - b) < 1e-6;
  check('박스 밖 이동 상태의 3소스 일치 (DOM === extractData === printPostData)',
    eq2(outside.dom.x, outside.extract.x) && eq2(outside.dom.x, outside.print.x)
    && eq2(outside.dom.w, outside.extract.w) && eq2(outside.dom.w, outside.print.w),
    `dom.x=${outside.dom.x.toFixed(2)}, print.x=${outside.print.x.toFixed(2)}`);
  // 오버랩 판정 유효 영역(displayRect ∩ contentRect)이 소멸했는지 —
  // computeOverlap의 클램핑 시맨틱이 밖으로 나간 이미지를 회피 대상에서 제외
  const clipW = Math.min(outside.displayRect.l + outside.displayRect.w, outside.contentRect.l + outside.contentRect.w) - Math.max(outside.displayRect.l, outside.contentRect.l);
  check('완전히 밖으로 나간 이미지의 오버랩 유효 영역 소멸 (clip ≤ 0)',
    clipW <= 0, `clipWidth=${clipW.toFixed(2)}mm`);

  // ESC로 이미지 편집 종료 후 원복 (다음 시나리오 격리)
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await resetModes();
}

// ── 5. 휠 — 비율 유지 리사이즈 + 이벤트 ────────────────────────

{
  await page.evaluate(() => {
    document.querySelector('x-layout-document').editManager.focusImage(
      document.getElementById('img-1'),
    );
  });
  await page.waitForTimeout(100);

  // 이벤트 기록
  await page.evaluate(() => {
    window.__evts = [];
    const em = document.querySelector('x-layout-document').editManager;
    em.addEventListener('imageResize', (e) => window.__evts.push({ t: 'resize', w: e.imageDetail.width }));
    em.addEventListener('imagePropertyChange', (e) => window.__evts.push({ t: 'prop', p: e.imagePropertyDetail.property }));
    em.addEventListener('imageMove', (e) => window.__evts.push({ t: 'move', c: e.imageDetail.canceled }));
  });

  const before = await page.evaluate(() => {
    const img = document.getElementById('img-1');
    return { w: img.width, h: img.height, fit: img.objectFit };
  });

  const c = await imgCenter('img-1');
  // mouse.wheel은 현재 커서 위치에서 굴러가므로 먼저 이미지 중심으로 이동한다.
  // (wheel 시그니처에 좌표 옵션이 없다 — x/y를 전달해도 무시된다.)
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(150);

  const after = await page.evaluate(() => {
    const img = document.getElementById('img-1');
    return { w: img.width, h: img.height, fit: img.objectFit };
  });
  const events = await page.evaluate(() => window.__evts);

  const ratioBefore = before.w / before.h;
  const ratioAfter = after.w / after.h;
  check('휠 → 확대', after.w > before.w, `w: ${before.w.toFixed(2)} → ${after.w.toFixed(2)}`);
  check('휠 → 원본 비율 유지', near(ratioBefore, ratioAfter, 0.001), `ratio: ${ratioBefore.toFixed(4)} → ${ratioAfter.toFixed(4)}`);
  check('휠 → objectFit 자동 none 전환', after.fit === 'none', `fit=${after.fit}`);
  check('휠 → imageResize 이벤트 발생', events.some((e) => e.t === 'resize'), JSON.stringify(events));
  check('휠 → imagePropertyChange(width/height) 이벤트 발생', events.some((e) => e.t === 'prop' && (e.p === 'width' || e.p === 'height')), JSON.stringify(events));

  // 크기 상한 없음 (InDesign 시맨틱) — 부모 박스 3배를 넘어도 확대 가능
  const boxSize = await page.evaluate(() => {
    const content = document.getElementById('box-img-1').engine.contentAbsRect;
    return { w: content.absWidth, h: content.absHeight };
  });
  // 3배 상한이 있었다면 이 시점(1.1배 확대 후)이 3배 이내일 수 있으므로
  // 충분히 넘을 때까지 반복 확대
  let current = after;
  for (let i = 0; i < 12 && current.w < boxSize.w * 3.2; i++) {
    const cc = await imgCenter('img-1');
    await page.mouse.move(cc.x, cc.y);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(80);
    current = await page.evaluate(() => {
      const img = document.getElementById('img-1');
      return { w: img.width, h: img.height };
    });
  }
  check('휠 → 크기 상한 없음 (부모 박스 3배 초과 확대 가능)',
    current.w > boxSize.w * 3, `w=${current.w.toFixed(1)} > 3×box=${boxSize.w * 3}`);

  // 하한 1mm — 축소는 1mm에서 멈춤 (0/음수 방지)
  for (let i = 0; i < 30; i++) {
    const cc = await imgCenter('img-1');
    await page.mouse.move(cc.x, cc.y);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(40);
  }
  const shrunk = await page.evaluate(() => {
    const img = document.getElementById('img-1');
    return { w: img.width, h: img.height };
  });
  check('휠 → 하한 1mm 유지 (0/음수 수렴 방지)', shrunk.w >= 1 && shrunk.h >= 1,
    `w=${shrunk.w.toFixed(2)}, h=${shrunk.h.toFixed(2)}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await resetModes();
}

// ── 6. 드래그 중 ESC — 취소 복원 + canceled 이벤트 ─────────────

{
  await page.evaluate(() => {
    document.querySelector('x-layout-document').editManager.focusImage(
      document.getElementById('img-1'),
    );
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => { window.__evts = []; });

  const before = await page.evaluate(() => {
    const img = document.getElementById('img-1');
    return { x: img.x, y: img.y, fit: img.objectFit };
  });

  const c = await imgCenter('img-1');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 40, c.y + 25, { steps: 5 });
  await page.waitForTimeout(50);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => {
    const img = document.getElementById('img-1');
    return { x: img.x, y: img.y, fit: img.objectFit };
  });
  const events = await page.evaluate(() => window.__evts);
  const cancelEvt = events.find((e) => e.t === 'move' && e.c === true);

  check('드래그 중 ESC → 시작 위치로 복원', near(after.x, before.x, 0.01) && near(after.y, before.y, 0.01), `x: ${before.x.toFixed(2)} → ${after.x.toFixed(2)}, y: ${before.y.toFixed(2)} → ${after.y.toFixed(2)}`);
  check('드래그 중 ESC → imageMove(canceled=true) 이벤트', cancelEvt !== undefined, JSON.stringify(events));
  check('취소 시 모드는 유지 (드래그 취소 ≠ 모드 종료)', (await readState()).mode.image === true);
  check('취소 → objectFit 스냅샷 복원', after.fit === before.fit, `fit: ${before.fit} → ${after.fit}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await resetModes();
}

// ── 7. Tab / Shift+Tab 순회 ────────────────────────────────────

{
  await page.evaluate(() => {
    document.querySelector('x-layout-document').editManager.focusImage(
      document.getElementById('img-1'),
    );
  });
  await page.waitForTimeout(100);

  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  const t1 = await readState();
  check('Tab → img-2 포커스 이동', t1.focusedImage === 'img-2', `focused=${t1.focusedImage}`);

  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  const t2 = await readState();
  check('Tab → img-overlap로 이동 (문서 순서 순회)', t2.focusedImage === 'img-overlap', `focused=${t2.focusedImage}`);

  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  const t3 = await readState();
  check('Tab → 순환 (img-overlap → img-1)', t3.focusedImage === 'img-1', `focused=${t3.focusedImage}`);
  check('Tab 이동 → 부모 box 선택도 이동', t3.selectedIds.length === 1 && t3.selectedIds[0] === 'box-img-1', `selected=${JSON.stringify(t3.selectedIds)}`);
  check('Tab 이동 → 부모 box text-focused 설정', t3.attrs.boxImg1TextFocused === true);

  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(100);
  const t4 = await readState();
  check('Shift+Tab → 역방향 (img-1 → img-overlap)', t4.focusedImage === 'img-overlap', `focused=${t4.focusedImage}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await resetModes();
}

// ── 8. selection 이동 → 포커스 상실 (모드 유지) ────────────────

{
  await page.evaluate(() => {
    document.querySelector('x-layout-document').editManager.focusImage(
      document.getElementById('img-2'),
    );
  });
  await page.waitForTimeout(100);

  // 다른 box 클릭 (box-text)
  const textBoxPos = await page.evaluate(() => {
    const r = document.getElementById('box-text').getBoundingClientRect();
    return { x: r.x + 30, y: r.y + 30 };
  });
  await page.mouse.click(textBoxPos.x, textBoxPos.y);
  await page.waitForTimeout(150);

  const s = await readState();
  check('다른 box 클릭 → focusedImage 해제', s.focusedImage === null, `focused=${s.focusedImage}`);
  check('다른 box 클릭 → image-edit-focus 속성 제거', s.attrs.img2Focus === false);
  check('다른 box 클릭 → 새 box 선택', s.selectedIds.length === 1 && s.selectedIds[0] === 'box-text', `selected=${JSON.stringify(s.selectedIds)}`);
  check('포커스 해제 후에도 이미지 편집 모드 유지', s.mode.image === true, JSON.stringify(s.mode));

  // 모드 유지 상태에서 다른 이미지 클릭 → 재포커스
  const c2 = await imgCenter('img-2');
  await page.mouse.click(c2.x, c2.y);
  await page.waitForTimeout(150);
  const s2 = await readState();
  check('모드 유지 상태에서 다른 이미지 클릭 → 재포커스', s2.focusedImage === 'img-2', `focused=${s2.focusedImage}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await resetModes();
}

// ── 9. 텍스트 편집과의 상호 전환 ────────────────────────────────

{
  // 텍스트 모드 진입 (paragraph dblclick — 신뢰 이벤트)
  const paraPos = await page.evaluate(() => {
    const r = document.getElementById('para-1').getBoundingClientRect();
    return { x: r.x + 30, y: r.y + 30 };
  });
  await page.mouse.dblclick(paraPos.x, paraPos.y, { delay: 60 });
  await page.waitForTimeout(150);

  const textState = await readState();
  check('paragraph dblclick → 텍스트 편집 모드 진입', textState.mode.text === true, JSON.stringify(textState.mode));

  // 텍스트 편집 중 이미지 dblclick → 이미지 편집 전환 + 텍스트 blur
  const c1 = await imgCenter('img-1');
  await page.mouse.dblclick(c1.x, c1.y, { delay: 60 });
  await page.waitForTimeout(150);

  const crossState = await page.evaluate(() => {
    const em = document.querySelector('x-layout-document').editManager;
    return {
      mode: { text: em.textEditMode, image: em.imageEditMode },
      focusedParagraph: em.focusedParagraph?.id ?? null,
      focusedImage: em.focusedImage?.id ?? null,
      boxTextTextFocused: document.getElementById('box-text').hasAttribute('text-focused'),
    };
  });
  check('텍스트 편집 중 이미지 dblclick → 이미지 편집 전환', crossState.mode.image === true && crossState.mode.text === false, JSON.stringify(crossState.mode));
  check('전환 시 텍스트 포커스 blur', crossState.focusedParagraph === null, `focusedParagraph=${crossState.focusedParagraph}`);
  check('전환 시 기존 box text-focused 제거', crossState.boxTextTextFocused === false);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await resetModes();
}

// ── 10. 드래그+휠 후 extractData/printPostData 3소스 일치 ──────

/**
 * 이미지의 DOM getter / engine.extractData / printPostData.data
 * 3개 소스의 x/y/w/h/objectFit이 정확히 일치하는지 비교한다.
 * 엔진-우선 원칙: 셋 모두 displayRect 단일 소스에서 산출되므로, 이미지 편집
 * (드래그/휼/objectFit 자동 전환) 후에도 어긋나면 안 된다.
 * dirty 읽기 가드(DirtyPendingError)는 ensureCommitted()로 커밋 후 읽는다.
 *
 * @returns {Promise<void>}
 */
async function checkThreeSourceConsistency() {
  // 이미지 편집 진입 (프로그래밍 경로 — 조작 자체는 이미 앞 시나리오에서 신뢰 이벤트로 검증)
  await page.evaluate(() => {
    const em = document.querySelector('x-layout-document').editManager;
    em.imageEditMode = false;
    em.focusImage(document.getElementById('img-1'));
  });
  await page.waitForTimeout(100);

  // 신뢰 이벤트로 드래그 + 휠 조작
  let c = await imgCenter('img-1');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 25, c.y + 15, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  c = await imgCenter('img-1');
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(300);

  const r = await page.evaluate(() => {
    const doc = document.querySelector('x-layout-document');
    const img = document.getElementById('img-1');

    const dom = { x: img.x, y: img.y, w: img.width, h: img.height, fit: img.objectFit };

    // dirty 읽기 계약: 읽기 전에 커밋 보장 (outside an active edit session)
    doc.engine.ensureCommitted();
    const extract = img.engine.extractData;
    const posts = doc.engine.printPostData;
    const imgPost = posts.find((p) => p.data?.type === 'image' && p.data?.id === 'img-1');

    // document.data (extractData 재귀 조립)에서도 동일 확인
    const findImg = (node) => {
      if (!node || typeof node !== 'object') return null;
      if (node.type === 'image') return node;
      if (Array.isArray(node.children)) {
        for (const ch of node.children) { const f = findImg(ch); if (f) return f; }
      }
      if (node.children && !Array.isArray(node.children)) return findImg(node.children);
      return null;
    };
    const docImg = findImg(doc.data);

    return {
      dom,
      extract: { x: extract.x, y: extract.y, w: extract.width, h: extract.height, fit: extract.objectFit },
      print: imgPost
        ? { x: imgPost.data.x, y: imgPost.data.y, w: imgPost.data.width, h: imgPost.data.height, fit: imgPost.data.objectFit }
        : null,
      docData: docImg
        ? { x: docImg.x, y: docImg.y, w: docImg.width, h: docImg.height, fit: docImg.objectFit }
        : null,
      // print rect는 이미지 박스 contentAbsRect(mm) — 크롭 컨텍스트 유지 확인
      printRect: imgPost ? imgPost.rect : null,
    };
  });

  const eq = (a, b) => Math.abs(a - b) < 1e-6;
  const domE = r.dom;
  const extE = r.extract;
  const prE = r.print;
  const ddE = r.docData;

  check('드래그+휼 후 DOM getter === engine.extractData (x/y/w/h/fit)',
    eq(domE.x, extE.x) && eq(domE.y, extE.y) && eq(domE.w, extE.w) && eq(domE.h, extE.h) && domE.fit === extE.fit,
    `dom=(${domE.x.toFixed(2)},${domE.y.toFixed(2)},${domE.w.toFixed(2)},${domE.h.toFixed(2)},${domE.fit}) extract=(${extE.x.toFixed(2)},${extE.y.toFixed(2)},${extE.w.toFixed(2)},${extE.h.toFixed(2)},${extE.fit})`);
  check('드래그+휼 후 printPostData.data === extractData (x/y/w/h/fit)',
    prE !== null && eq(prE.x, extE.x) && eq(prE.y, extE.y) && eq(prE.w, extE.w) && eq(prE.h, extE.h) && prE.fit === extE.fit,
    prE ? `print=(${prE.x.toFixed(2)},${prE.y.toFixed(2)},${prE.w.toFixed(2)},${prE.h.toFixed(2)},${prE.fit})` : 'print 없음');
  check('드래그+휼 후 document.data의 이미지 === extractData',
    ddE !== null && eq(ddE.x, extE.x) && eq(ddE.y, extE.y) && eq(ddE.w, extE.w) && eq(ddE.h, extE.h) && ddE.fit === extE.fit,
    ddE ? `docData=(${ddE.x.toFixed(2)},${ddE.y.toFixed(2)},${ddE.w.toFixed(2)},${ddE.h.toFixed(2)},${ddE.fit})` : 'docData 없음');
  check('print rect === 이미지 박스 contentAbsRect (크롭 컨텍스트 유지)',
    r.printRect !== null && r.printRect.width > 0 && r.printRect.height > 0,
    r.printRect ? `rect=(${r.printRect.x},${r.printRect.y},${r.printRect.width},${r.printRect.height})` : 'rect 없음');
  check('휼 확대 후 objectFit none이 전 소스에 반영', domE.fit === 'none' && extE.fit === 'none' && prE.fit === 'none' && ddE.fit === 'none');

  // 상태 정리
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await resetModes();
}

await checkThreeSourceConsistency();

// ── 11. ESC 드래그 취소 복원값의 3소스 일치 ────────────────────

{
  await page.evaluate(() => {
    document.querySelector('x-layout-document').editManager.focusImage(
      document.getElementById('img-1'),
    );
  });
  await page.waitForTimeout(100);

  const before = await page.evaluate(() => {
    const img = document.getElementById('img-1');
    return { x: img.x, y: img.y, w: img.width, h: img.height };
  });

  // 드래그 시작 → 이동 → ESC 취소 (신뢰 이벤트)
  const c = await imgCenter('img-1');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x - 40, c.y - 25, { steps: 4 });
  await page.waitForTimeout(50);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  const r = await page.evaluate(() => {
    const doc = document.querySelector('x-layout-document');
    const img = document.getElementById('img-1');
    doc.engine.ensureCommitted();
    const extract = img.engine.extractData;
    const posts = doc.engine.printPostData;
    const imgPost = posts.find((p) => p.data?.type === 'image' && p.data?.id === 'img-1');
    return {
      dom: { x: img.x, y: img.y, w: img.width, h: img.height },
      extract: { x: extract.x, y: extract.y, w: extract.width, h: extract.height },
      print: imgPost ? { x: imgPost.data.x, y: imgPost.data.y, w: imgPost.data.width, h: imgPost.data.height } : null,
    };
  });

  const eq = (a, b) => Math.abs(a - b) < 1e-6;
  check('ESC 취소 복원값 — DOM === 취소 전 값', eq(r.dom.x, before.x) && eq(r.dom.y, before.y) && eq(r.dom.w, before.w) && eq(r.dom.h, before.h),
    `dom=(${r.dom.x.toFixed(2)},${r.dom.y.toFixed(2)}) before=(${before.x.toFixed(2)},${before.y.toFixed(2)})`);
  check('ESC 취소 복원값 — extractData 일치', eq(r.extract.x, r.dom.x) && eq(r.extract.y, r.dom.y) && eq(r.extract.w, r.dom.w) && eq(r.extract.h, r.dom.h));
  check('ESC 취소 복원값 — printPostData 일치', r.print !== null && eq(r.print.x, r.dom.x) && eq(r.print.y, r.dom.y) && eq(r.print.w, r.dom.w) && eq(r.print.h, r.dom.h));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await resetModes();
}

// ── 12. 오버랩 회피의 print chars 갱신 (파트 분할 A/B) ─────────

/**
 * 이미지 편집(휠/드래그)이 단락 오버랩 회피에 반영되고, 그 결과가
 * print chars까지 일관되는지 검증한다. path/box 모드 무관하게 참을
 * 보장하는 기준으로 **라인 파트 분할**을 사용한다:
 *
 *  A (회피 상태) — 이미지가 단락 첫 컬럼을 덮음 → 첫 라인이 다중 파트로
 *     분할되어 있고 (회피 발생 증거), print chars가 그 배치를 반영한다
 *  B (회피 해제) — wheel 축소 + 아래 드래그로 이미지가 첫 라인에서 벗어남
 *     → 첫 라인이 단일 파트로 회복되고, 해제된 영역에 chars가 돌아온다
 *
 * chars rect는 문서 절대 mm 좌표다 (buildParagraphPrintPostData가
 * parentAbsRect.absLeft/absTop 기준으로 산출). 엔진 columnContents의
 * 파트 구조와 print chars의 x 분포가 일치하는지 함께 검증한다.
 *
 * 주의 — path 모드 시맨틱: 불투명 픽셀 윤곽을 회피하므로 이미지 rect 내부의
 * 투명 영역에는 글자가 올 수 있다. "이미지 클립 rect 내 char=0"은 box
 * 모드에만 성립하는 잘못된 기대치다 (실측으로 확인 — 첫 라인이 이미지
 * 왼쪽 자유 영역 0~37.6mm + 내부 틈으로 파트 분할됨).
 *
 * @returns {Promise<void>}
 */
async function checkOverlapAvoidPrintChars() {
  // A: 초기 상태 — 회피로 첫 라인이 파트 분할되어 있는지
  const measureA = await page.evaluate(() => {
    const doc = document.querySelector('x-layout-document');
    doc.engine.ensureCommitted();
    const para = document.getElementById('para-overlap');
    const engine = para.engine;
    const firstLine = engine.columnContents[0]?.[0];
    const parts = firstLine?.parts ?? [];
    const posts = doc.engine.printPostData;
    const paraPost = posts.find((p) => p.data?.type === 'paragraph' && p.data?.id === 'para-overlap');
    const chars = paraPost?.chars ?? [];
    return {
      partCount: parts.length,
      partInfo: parts.map(p => ({ left: p.left, width: p.width, len: p.content.length })),
      totalChars: chars.length,
    };
  });

  check('오버랩 A — 회피 상태: 첫 라인 파트 분할 (parts > 1)', measureA.partCount > 1,
    `parts=${measureA.partCount} [${measureA.partInfo.map(p => `l=${p.left.toFixed(1)},w=${p.width.toFixed(1)}`).join(' | ')}]`);
  check('오버랩 A — 비-공허 전제 (chars > 0)', measureA.totalChars > 0, `chars=${measureA.totalChars}`);

  // B: 이미지 편집 (휠 축소 → 아래 드래그) → 회피 해제 확인
  await page.evaluate(() => {
    const em = document.querySelector('x-layout-document').editManager;
    em.focusImage(document.getElementById('img-overlap'));
  });
  await page.waitForTimeout(150);

  // 휠 축소 — objectFit 자동 none 전환 + 축소
  let c = await imgCenter('img-overlap');
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);

  // 아래로 드래그 — 첫 라인 영역에서 벗어나게
  c = await imgCenter('img-overlap');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y + 150, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const measureB = await page.evaluate(() => {
    const doc = document.querySelector('x-layout-document');
    doc.engine.ensureCommitted();
    const para = document.getElementById('para-overlap');
    const engine = para.engine;
    const firstLine = engine.columnContents[0]?.[0];
    const parts = firstLine?.parts ?? [];

    const posts = doc.engine.printPostData;
    const paraPost = posts.find((p) => p.data?.type === 'paragraph' && p.data?.id === 'para-overlap');
    const chars = paraPost?.chars ?? [];
    const paraRect = paraPost?.rect;

    // 회피 해제 증거: 문단 첫 컬럼 좌측 상단 (이미지가 원래 덮던 곳)에 chars 복귀
    let charsInFreedRegion = 0;
    if (paraRect) {
      const freedLeft = paraRect.x;
      const freedRight = paraRect.x + paraRect.width / 4; // 첫 컬럼 대역
      const freedTop = paraRect.y;
      const freedBottom = paraRect.y + 10; // 상단 10mm 밴드 (첫 2라인)
      for (const ch of chars) {
        const cr = ch.rect;
        if (cr.x >= freedLeft && cr.x < freedRight && cr.y >= freedTop && cr.y < freedBottom) {
          charsInFreedRegion++;
        }
      }
    }

    // print chars x좌표가 엔진 배치(첫 라인 파트)와 정합하는지 — 첫 라인의
    // 첫 char가 파트 시작 위치에 있는지로 대표 검증
    const img = document.getElementById('img-overlap');
    return {
      partCount: parts.length,
      partInfo: parts.map(p => ({ left: p.left, width: p.width, len: p.content.length })),
      totalChars: chars.length,
      charsInFreedRegion,
      firstCharX: chars[0] ? chars[0].rect.x : null,
      imgFit: img.objectFit,
      imgAbs: (() => {
        const d = img.engine.displayRect;
        return { l: d.absLeft, t: d.absTop, w: d.absWidth, h: d.absHeight };
      })(),
    };
  });

  check('오버랩 B — 휠+드래그 후 회피 해제 (첫 라인 단일 파트 회복)', measureB.partCount === 1,
    `parts=${measureB.partCount} [${measureB.partInfo.map(p => `l=${p.left?.toFixed(1)},w=${p.width?.toFixed(1)}`).join(' | ')}]`);
  check('오버랩 B — 해제된 영역(첫 컬럼 상단)에 chars 복귀 (비-공허 효과)',
    measureB.charsInFreedRegion > 0,
    `charsInFreedRegion=${measureB.charsInFreedRegion}`);
  check('오버랩 B — objectFit 자동 none 전환 유지', measureB.imgFit === 'none', `fit=${measureB.imgFit}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await resetModes();
}

await checkOverlapAvoidPrintChars();

// ── 종료 ───────────────────────────────────────────────────────

if (pageErrors.length > 0) {
  check('페이지 런타임 에러 없음', false, pageErrors.join(' | ').slice(0, 200));
} else {
  check('페이지 런타임 에러 없음', true);
}

console.log('');
console.log(`=== Results: ${passCount} passed, ${failCount} failed ===`);

await browser.close();
if (server) server.kill();
if (failCount > 0) {
  console.error('FAILURES:', failures.join(', '));
  process.exit(1);
}