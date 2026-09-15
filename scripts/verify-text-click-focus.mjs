/**
 * 텍스트편집모드 클릭-포커스 정합성 검증 (브라우저).
 *
 * 텍스트편집모드에서 미포커스 paragraph를 단일 클릭하면 즉시 포커스가 이동하고
 * 클릭 위치에 커서가 설정되는지 검증한다 (더블클릭 진입 불필요 계약).
 *
 * 검증 항목:
 * 1. 클릭 전 미포커스 전제
 * 2. 단일 클릭 → 즉시 포커스 이동 (EditManager.focusedParagraph)
 * 3. 부모 box `text-focused` 속성 설정 (선택/라벨 시각 상태)
 * 4. 커서가 클릭한 span의 소스 오프셋에 설정 (±1 — mid-point 우측 클릭 규칙)
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-text-click-focus.mjs   # ALL PASS (서버 없으면 자동 기동)
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5210;

const BASE_URL_CANDIDATES = ['http://localhost:5175', 'http://localhost:5173'];

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
    cwd: pkgRoot, stdio: 'pipe', shell: true,
  });
  const spawnedUrl = `http://localhost:${BASE_PORT}`;
  if (await waitForServer(spawnedUrl)) baseUrl = spawnedUrl;
  else { server.kill(); throw new Error(`vite dev server not ready on ${spawnedUrl}`); }
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', err => console.error('[pageerror]', err.message));
await page.goto(`${baseUrl}/examples/bench.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.title === 'BENCH_READY', { timeout: 30_000 });

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// 1) 텍스트편집모드 진입 (포커스 없음 상태로 만듦)
await page.evaluate(async () => {
  const em = window.bench.getEditManager();
  em.textEditMode = true;
  // 클릭 대상이 DOM span(data-source-offset)이다 — bench 문단이 기본 canvas
  // 모드면 컬럼이 없어 클릭 대상을 찾을 수 없다. dom 고정이 계약이다.
  for (const p of document.querySelectorAll('x-layout-paragraph')) {
    p.renderMode = 'dom';
    p.flushRender();
  }
  await new Promise(r => setTimeout(r, 300));
  em.blurParagraph();
  await new Promise(r => setTimeout(r, 200));
});

// 2) paragraph의 두 번째 라인 첫 span을 클릭 (미포커스 상태)
const result = await page.evaluate(async () => {
  const p = window.bench.getParaBox().querySelector('x-layout-paragraph');
  // 컬럼은 paragraph의 light DOM 자식이다 (DOM 모드 — slot으로 shadow에 투영)
  let col = p.querySelector('x-layout-column');
  if (!col || !col.shadowRoot) {
    // 디버그 정보 수집
    const info = {
      renderMode: p.renderMode,
      lightChildren: Array.from(p.children).map(c => c.tagName),
      editable: p.editableText,
    };
    throw new Error('column not found: ' + JSON.stringify(info));
  }
  const spans = col.shadowRoot.querySelectorAll('span[data-source-offset]:not([data-temporary])');
  const target = spans[3]; // 4번째 글자
  if (!target) throw new Error('span not found, count=' + spans.length);
  const rect = target.getBoundingClientRect();

  // 클릭 전 상태
  const em = window.bench.getEditManager();
  const before = {
    focused: em.focusedParagraph === p,
    textFocused: p.parentElement.hasAttribute('text-focused'),
  };

  // 단일 클릭 시뮬레이션 (mousedown + mouseup + click)
  const opts = { bubbles: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
  target.dispatchEvent(new MouseEvent('mousedown', opts));
  target.dispatchEvent(new MouseEvent('mouseup', opts));
  target.dispatchEvent(new MouseEvent('click', opts));

  await new Promise(r => setTimeout(r, 300));

  const controller = em._focusedController;
  return {
    before,
    after: {
      focused: em.focusedParagraph === p,
      textFocused: p.parentElement.hasAttribute('text-focused'),
      hasController: controller !== null,
    },
    cursorOffset: controller ? controller._cursorModel.offset : null,
    expectedOffset: Number(target.dataset.sourceOffset) + (p.engine?.contentFrom ?? 0),
    spanKey: Number(target.dataset.sourceOffset),
  };
});

check('클릭 전 미포커스', !result.before.focused && !result.before.textFocused,
  `focused=${result.before.focused}, textFocused=${result.before.textFocused}`);
check('클릭 후 즉시 포커스 이동', result.after.focused,
  `focused=${result.after.focused}, hasController=${result.after.hasController}`);
check('부모 box text-focused 설정', result.after.textFocused, `textFocused=${result.after.textFocused}`);
check('커서 offset 설정됨 (클릭 위치 ±1)', result.cursorOffset !== null &&
  Math.abs(result.cursorOffset - (result.expectedOffset)) <= 1,
  `cursorOffset=${result.cursorOffset}, expected≈${result.expectedOffset} (span local ${result.spanKey})`);

// 3) 다른 paragraph로 포커스 이동도 즉시 동작하는지 (2개 문단이 있으면)
const second = await page.evaluate(async () => {
  const em = window.bench.getEditManager();
  const paragraphs = Array.from(document.querySelectorAll('x-layout-page x-layout-paragraph'));
  if (paragraphs.length < 2) return { skipped: true };
  const [p0, p1] = paragraphs;
  // p1 클릭 → 포커스 이동
  const col = p1.shadowRoot.querySelector('x-layout-column');
  if (!col) return { skipped: true };
  const spans = col.shadowRoot.querySelectorAll('span[data-source-offset]:not([data-temporary])');
  if (spans.length === 0) return { skipped: true };
  const target = spans[0];
  const rect = target.getBoundingClientRect();
  const opts = { bubbles: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
  target.dispatchEvent(new MouseEvent('mousedown', opts));
  target.dispatchEvent(new MouseEvent('mouseup', opts));
  target.dispatchEvent(new MouseEvent('click', opts));
  await new Promise(r => setTimeout(r, 300));
  return {
    skipped: false,
    focusedP1: em.focusedParagraph === p1,
    p0Released: !p0.parentElement.hasAttribute('text-focused'),
    p1Focused: p1.parentElement.hasAttribute('text-focused'),
  };
});

if (second.skipped) {
  console.log('SKIP  두번째 paragraph 클릭 테스트 (paragraph 1개뿐)');
} else {
  check('다른 paragraph 클릭 → 포커스 이동', second.focusedP1, `focusedP1=${second.focusedP1}`);
  check('이전 paragraph text-focused 해제', second.p0Released, `p0Released=${second.p0Released}`);
  check('새 paragraph text-focused 설정', second.p1Focused, `p1Focused=${second.p1Focused}`);
}

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`);
await browser.close();
if (server) server.kill();
process.exit(failures.length === 0 ? 0 : 1);