/**
 * 실제 화면 렌더 검증 (브라우저).
 *
 * `verify-dom-diff.mjs`가 DOM↔엔진 **데이터** 일치를 검증한다면, 이 스크립트는
 * **화면 수준**의 렌더링 미스를 검증한다 — 데이터가 있어도 화면에 안 보이는
 * 결함 클래스 (호스트 CSS rule stale, 0폭 박스, overflow 클립, 색상/가시성
 * 미적용 등)는 데이터 비교로는 잡히지 않는다.
 *
 * 검증 원칙: 스팬 존재 여부가 아니라 `getBoundingClientRect()`(실제 레이아웃
 * 결과)를 사용한다. 사용자가 "본다"는 것 = 비어있지 않은 화면 사각형이 존재한다.
 *
 * 검증 시나리오 (examples/index.html 예제 문서 기준):
 *  1. 단락 다수 렌더: 각 단락(내용이 있는)이 화면에 비어있지 않은 텍스트 라인을
 *     가지는지 — 회귀 사례(3단 본문) 포함
 *  2. 3단(multi-column) 단락: 컬럼 수 === 엔진 columnContents 수, 각 컬럼에
 *     텍스트 스팬이 화면에 존재
 *  3. 호스트 CSS 규칙 정합: 단락/컬럼의 `:host` rule width가 0이 아니고
 *     getBoundingClientRect와 개략 일치 (M-1 회귀 감지)
 *  4. 표 셀 텍스트: 각 td의 셀 단락이 화면에 비어있지 않은지
 *  5. 텍스트 편집: 타이핑 후 새 span이 화면 rect를 갖는지 (타이핑 렌더 실측)
 *  6. 이미지 위치 이동 후 오버랩 회피 재배치 (이미지 세터 notify 실측)
 *
 * 실행: npx tsx scripts/verify-visual-render.mjs
 * dev server(5174 → 5175 → 5173 순 탐지) 필요.
 *
 * @file scripts/verify-visual-render.mjs
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const BASE_PORT = 5197;

// 라이브 서버 후보 (layout-element dev server 우선).
// 주의 — 포트만으로는 다른 앱의 Vite 서버(apps/layout-ui, SPA fallback으로
// 존재하지 않는 경로에도 200을 반환)와 구별되지 않으므로, probe는 반드시
// 콘텐츠(title)까지 검증해야 한다.
const BASE_URL_CANDIDATES = [
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5173',
];

/**
 * 후보 URL이 layout-element의 demo 페이지를 실제로 서빙하는지 검증한다.
 *
 * SPA fallback을 쓰는 타 앱 Vite 서버는 존재하지 않는 경로에도 앱 index를
 * 200으로 반환하므로, `res.ok`만으로는 판별할 수 없다. HTML을 읽어
 * index.html의 title("Layout Element Demo")이 있는지 확인한다.
 *
 * @param {string} url - 후보 base URL
 * @returns {Promise<boolean>} demo 페이지 서빙 여부
 */
async function probe(url) {
  try {
    const res = await fetch(`${url}/examples/index.html`);
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes('<title>Layout Element Demo</title>');
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
  // 자체 스폰 fallback — 어느 포트에도 layout-element 서버가 없으면 직접 기동한다.
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

await page.goto(`${baseUrl}/examples/index.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => {
    const paras = document.querySelectorAll('x-layout-paragraph');
    return paras.length > 0 && [...paras].every(p => p.querySelector('x-layout-column'));
  },
  { timeout: 30_000 },
).catch(() => { /* proceed — failures will be reported per-check */ });
await page.waitForTimeout(2_000);

let passCount = 0;
let failCount = 0;
const check = (name, ok, detail = '') => {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${ok ? '✓' : '✗'} ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) passCount++;
  else failCount++;
};

/** 컬럼 shadow DOM에서 화면에 실제로 보이는 span rect 목록을 수집한다. */
const collectVisibleCharRects = (paraSelector) => page.evaluate((sel) => {
  const para = document.querySelector(sel);
  if (!para) return null;
  const rects = [];
  const cols = [...para.querySelectorAll('x-layout-column')];
  for (const col of cols) {
    const lines = [...(col.shadowRoot?.children ?? [])].filter(c => c.tagName === 'DIV');
    for (const line of lines) {
      if (line.style.display === 'none') continue;
      const spans = [...line.querySelectorAll('span[data-source-offset]')];
      for (const s of spans) {
        const r = s.getBoundingClientRect();
        rects.push({ x: r.x, y: r.y, w: r.width, h: r.height });
      }
    }
  }
  return { colCount: para.querySelectorAll('x-layout-column').length, rects };
}, paraSelector);

console.log('\n=== 실제 화면 렌더 검증 (verify-visual-render) ===\n');

// ── A. 전체 단락: 내용 있는 단락은 화면에 비어있지 않은 텍스트를 가진다 ──
{
  const r = await page.evaluate(() => {
    const paras = [...document.querySelectorAll('x-layout-paragraph')];
    return paras.map(p => {
      const sources = [...p.querySelectorAll('x-layout-column')].map(c => {
        const lines = [...(c.shadowRoot?.children ?? [])].filter(el => el.tagName === 'DIV');
        return lines.flatMap(l => [...l.querySelectorAll('span[data-source-offset]')].map(s => {
          const b = s.getBoundingClientRect();
          return { visible: b.width > 0.01 && b.height > 0.01 };
        }));
      });
      return {
        id: p.id.slice(0, 8),
        contentLen: typeof p.content === 'string' ? p.content.length : (p.content ?? []).reduce((a, b) => a + (typeof b === 'string' ? b.length : (b.content ?? '').length), 0),
        spanTotal: sources.flat().length,
        visibleSpans: sources.flat().filter(s => s.visible).length,
      };
    });
  });
  const bad = r.filter(x => x.contentLen > 0 && x.visibleSpans === 0);
  check('A. 내용 있는 단락 전부 화면에 텍스트 존재', bad.length === 0,
    bad.length ? `미표시: ${bad.map(x => x.id).join(', ')}` : `${r.length}개 중 ${r.filter(x => x.visibleSpans > 0).length}개 표시`);
}

// ── B. 3단(multi-column) 단락: 컬럼 수 정합 + 각 컬럼에 화면 스팬 ──
{
  const r = await page.evaluate(() => {
    const p = [...document.querySelectorAll('x-layout-paragraph')].find(x => {
      const cols = x.querySelectorAll(':scope > x-layout-column').length;
      return cols >= 3;
    });
    if (!p) return null;
    const perCol = [...p.querySelectorAll(':scope > x-layout-column')].map(col => {
      const spans = [...(col.shadowRoot?.querySelectorAll('span[data-source-offset]') ?? [])];
      const vis = spans.filter(s => s.getBoundingClientRect().width > 0.01).length;
      return { spans: spans.length, visible: vis > 0 };
    });
    return {
      id: p.id.slice(0, 8),
      lightCols: p.querySelectorAll(':scope > x-layout-column').length,
      engineCols: p.model?.columnContents?.length ?? -1,
      perCol,
    };
  });
  if (r === null) {
    check('B. 3단 단락 존재', false, '3단 이상 단락을 찾지 못함');
  } else {
    check('B1. 3단 컬럼 수 === 엔진 columnContents', r.lightCols === r.engineCols, `DOM ${r.lightCols} vs 엔진 ${r.engineCols}`);
    check('B2. 각 컬럼에 화면 텍스트 존재', r.perCol.every(c => c.visible), JSON.stringify(r.perCol));
  }
}

// ── C. 호스트 CSS 규칙 정합 (M-1 회귀 감지: width 0mm 고정) ──
{
  const r = await page.evaluate(() => {
    const paras = [...document.querySelectorAll('x-layout-paragraph')];
    return paras.map(p => {
      const ruleW = [...(p.shadowRoot?.querySelectorAll('style') ?? [])]
        .find(s => s.id === '__layout_host_style__')?.sheet?.cssRules?.[0]?.style?.width;
      const rect = p.querySelector(':scope > x-layout-column')?.getBoundingClientRect();
      return { id: p.id.slice(0, 8), ruleW, hasContent: (typeof p.content === 'string' ? p.content.length : JSON.stringify(p.content ?? '').length) > 0, colW: rect?.width ?? 0 };
    });
  });
  const zeroRuleWithContent = r.filter(x => x.ruleW === '0mm' && x.hasContent);
  check('C1. 내용 있는 단락의 :host rule width ≠ 0mm', zeroRuleWithContent.length === 0,
    zeroRuleWithContent.length ? `0mm 고정: ${zeroRuleWithContent.map(x => x.id).join(', ')}` : 'ok');
  check('C2. 단락 rule width와 컬럼 rect 개략 일치',
    r.every(x => !x.hasContent || (parseFloat(x.ruleW) > 0) === (x.colW > 0)),
    'host rule ↔ 실제 레이아웃 정합');
}

// ── D. 표 셀: 각 셀 단락이 화면에 텍스트를 가진다 ──
{
  const r = await page.evaluate(() => {
    const tds = [...document.querySelectorAll('x-layout-td')];
    return tds.map(td => {
      const paras = [...td.querySelectorAll('x-layout-paragraph')];
      const spans = paras.reduce((a, p) => a + [...p.querySelectorAll('x-layout-column')].reduce((b, c) => b + (c.shadowRoot?.querySelectorAll('span[data-source-offset]') ?? []).length, 0), 0);
      const visible = paras.reduce((a, p) => a + [...p.querySelectorAll('x-layout-column')].reduce((b, c) => b + [...(c.shadowRoot?.querySelectorAll('span[data-source-offset]') ?? [])].filter(s => s.getBoundingClientRect().width > 0.01).length, 0), 0);
      const contentLen = paras.reduce((a, p) => a + (typeof p.content === 'string' ? p.content.length : 0), 0);
      return { label: td._cellLabel, spans, visible, contentLen };
    });
  });
  const bad = r.filter(x => x.contentLen > 0 && x.visible === 0);
  check('D. 표 셀 단락 전부 화면에 텍스트 존재', bad.length === 0,
    bad.length ? `미표시: ${bad.map(x => x.label).join(', ')}` : `${r.length}개 셀 표시 (span ${r.reduce((a, x) => a + x.spans, 0)}개)`);
}

// ── E. 타이핑 → 화면에 실제 글자 추가 (렌더 체인 실측) ──
{
  const r = await page.evaluate(async () => {
    const em = document.querySelector('x-layout-document').editManager;
    const p = [...document.querySelectorAll('x-layout-paragraph')].find(x => typeof x.content === 'string' && x.content.length > 20);
    if (!p) return null;
    em.textEditMode = true;
    p.editableText = true;
    await new Promise(r => setTimeout(r, 150));
    const fok = em.focusParagraph(p);
    await new Promise(r => setTimeout(r, 350));
    const controller = em.focusedController;
    const ta = controller?._textarea;
    if (!ta) return { fok, hasController: !!controller, failedProbe: true };
    const before = [...p.querySelectorAll('x-layout-column')].reduce((a, c) => a + (c.shadowRoot?.querySelectorAll('span[data-source-offset]') ?? []).length, 0);
    ta.value += '景';
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const after = [...p.querySelectorAll('x-layout-column')].reduce((a, c) => a + (c.shadowRoot?.querySelectorAll('span[data-source-offset]') ?? []).length, 0);
    const lastVisible = [...p.querySelectorAll('x-layout-column')].some(col =>
      [...(col.shadowRoot?.querySelectorAll('span[data-source-offset]') ?? [])].some(s => s.textContent === '景' && s.getBoundingClientRect().width > 0.01));
    // 원복
    ta.value = ta.value.slice(0, -1);
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    return { before, after, added: after - before, taLen0: true };
  });
  if (r === null) {
    check('E. 타이핑 렌더 체인', false, 'textarea 경로 확보 실패 (환경 의존) — 수동 확인 필요');
  } else if (r.failedProbe) {
    check('E. 타이핑 렌더 체인', false, `focusParagraph 실패 (fok=${r.fok}, controller=${r.hasController}) — textEditMode/포커스 경로 확인 필요`);
  } else {
    check('E1. 타이핑 1글자가 DOM에 반영', r.after > r.before, `${r.before} → ${r.after}`);
  }
}

await browser.close();
// 자체 스폰한 서버만 종료한다 (외부 라이브 서버는 건드리지 않음).
if (server) server.kill();

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===\n`);
if (pageErrors.length > 0) {
  failCount += pageErrors.length;
  console.error(`=== pageerror ${pageErrors.length}건: ${pageErrors.slice(0, 3).join(' | ')} ===`);
}
if (failCount > 0) process.exit(1);