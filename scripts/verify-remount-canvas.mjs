/**
 * 가상화 재부착 × canvas 렌더 모드 정합성 (브라우저).
 *
 * 재부착(unpark) 문단은 canvas 기본값을 유지하되, 하이브리드 계약
 * (CANVAS_RENDERING.md §6)에 따라 포커스 진입 시 DOM으로 복귀하고 blur 시
 * canvas로 돌아가는 전 계약을 검증한다.
 *
 * 배경 결함 (2026-09-15 수정): 포커스 전환은 render() 게이트 입력
 * (effectiveMode = isFocused ? 'dom' : renderMode)을 바꾸지만 렌더 자체를
 * 예약하지 않았다. 재부착 문단은 컨트롤러가 connectedCallback에서 재생성된
 * 뒤 canvas로 머무는데, 이 상태에서 포커스하면 canvas가 유지되어 span 트리
 * 없이 편집이 불가했다. 수정: _onFocus에서 canvas 모드 문단의 포커스 진입 시
 * markStructureChangedAndRender()로 DOM 복귀 렌더를 예약.
 *
 * 검증 항목:
 * 1. 초기 canvas 렌더 (canvas 요소 존재, 컬럼 없음)
 * 2. park → unpark 재부착 후 canvas 유지 (커서 저장·복원은 파괴되지 않음)
 * 3. 재부착 문단 포커스 → 즉시 DOM 복귀 (컬럼 존재, canvas 제거)
 * 4. 재부착 문단 타이핑 → 커밋 + 커서 이동 (span 트리 정상)
 * 5. blur → canvas 복귀
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-remount-canvas.mjs   # ALL PASS (서버 없으면 자동 기동)
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const BASE_PORT = 5206;

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

const result = await page.evaluate(async () => {
  const out = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 픽스처: 2페이지 문서, 각 페이지에 문단 1개 — 기본 canvas 모드 유지.
  // parkPage는 x-layout-page 대상이 아니라 최상위 박스 대상이다.
  const page = document.createElement('x-layout-page');
  document.body.appendChild(page);
  const mkText = (tag) => `${tag} 재부착canvas검증문단입니다.`.repeat(8);
  const para = (id, content) => ({
    type: 'box', id, position: 'absolute', left: 10, top, width: 170, height: 100,
  });
  const top = (id) => ({ type: 'box', id, position: 'absolute', left: 10, top: 10, width: 170, height: 100 });
  const boxFor = (id, topMm, children) => ({
    type: 'box', id, position: 'absolute', left: 10, top: topMm, width: 170, height: 100, children,
  });
  page.data = {
    width: 190, height: 400, columns: 1, gap: 0,
    paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
    children: [
      boxFor('rc-page-0', 10, { type: 'paragraph', id: 'rc-para-0', content: mkText('P0'), paragraphStyle: {}, textStyle: {} }),
      boxFor('rc-page-1', 120, { type: 'paragraph', id: 'rc-para-1', content: mkText('P1'), paragraphStyle: {}, textStyle: {} }),
    ],
  };
  await page.render();
  await sleep(300);

  // 단계 5 기본값화 상태 실측 — 기본 canvas 모드로 명시 고정한다 (bench 예제는
  // dom 고정이므로 이 검증기가 기본값화 경로를 소유한다).
  const em = page.editManager;
  em.textEditMode = true;

  const stateOf = (p) => ({
    hasCanvasEl: !!p.querySelector('x-layout-canvas'),
    hasColumnEl: !!p.querySelector('x-layout-column'),
    hasController: !!p._editController,
    focused: !!p._editController?.isFocused,
  });

  // ── 1. 초기 canvas 렌더 ──
  const p0 = page.querySelector('#rc-para-0');
  p0.editableText = true;
  await sleep(200);
  p0.flushRender();
  await sleep(200);
  out.initial = stateOf(p0);

  // ── 2. park → unpark 재부착 ──
  // 커서 복원 경로 검증: 포커스 + 커서 설정 → park (컨트롤러 파괴 + 커서 저장)
  em.focusParagraph(p0);
  await sleep(200);
  em._focusedController.setCursor({ textOffset: 7 });
  const savedOffset = em._focusedController.cursorOffset;
  const parkedOk = !!page.parkPage('rc-page-0');
  const focusCleared = em.focusedParagraph === null;
  await sleep(200);
  const restored = page.unparkPage('rc-page-0');
  await restored.render();
  await sleep(300);
  const rp = page.querySelector('#rc-para-0');
  out.park = { parkedOk, focusCleared, savedOffset };
  out.remounted = stateOf(rp);
  out.remountedCursorRestored = rp._editController
    ? rp._editController.cursorOffset === 7
    : false;

  // ── 3. 재부착 문단 포커스 → DOM 복귀 ──
  em.focusParagraph(rp);
  await sleep(300);
  out.refocused = stateOf(rp);

  // ── 4. 재부착 문단 타이핑 → 커밋 ──
  const controller = em.focusedController;
  controller.setCursor({ textOffset: 5 });
  const ta = controller._textarea;
  const before = ta.value;
  ta.value = before.slice(0, 5) + 'Q' + before.slice(5);
  ta.setSelectionRange(5, 6);
  ta.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  await sleep(400);
  out.typed = {
    hasColumnEl: !!rp.querySelector('x-layout-column'),
    committed: rp.engine.plainText.includes('Q'),
  };

  // ── 5. blur → canvas 복귀 ──
  em.blurParagraph();
  await rp.flushRender();
  await sleep(200);
  out.afterBlur = stateOf(rp);

  return out;
});

// 판정
check('1. 초기 canvas 렌더', result.initial.hasCanvasEl && !result.initial.hasColumnEl,
  JSON.stringify(result.initial));
check('2. park 성공', result.park.parkedOk, JSON.stringify(result.park));
check('2b. park 시 포커스 해제', result.park.focusCleared, `focusCleared=${result.park.focusCleared}`);
check('2c. 재부착 후 canvas 유지 (기본값화)',
  result.remounted.hasCanvasEl && !result.remounted.hasColumnEl,
  JSON.stringify(result.remounted));
check('2d. 재부착 후 컨트롤러 재생성', result.remounted.hasController,
  `hasController=${result.remounted.hasController}`);
check('2e. 커서 복원 (offset=7)', result.remountedCursorRestored,
  `savedOffset=${result.park.savedOffset}`);
check('3. 재부착 문단 포커스 → 즉시 DOM 복귀',
  result.refocused.focused && result.refocused.hasColumnEl && !result.refocused.hasCanvasEl,
  JSON.stringify(result.refocused));
check('4. 재부착 문단 타이핑 커밋', result.typed.hasColumnEl && result.typed.committed,
  JSON.stringify(result.typed));
check('5. blur → canvas 복귀', result.afterBlur.hasCanvasEl && !result.afterBlur.hasColumnEl,
  JSON.stringify(result.afterBlur));

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`);
await browser.close();
if (server) server.kill();
process.exit(failures.length === 0 ? 0 : 1);