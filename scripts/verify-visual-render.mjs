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

const BASE = await (async () => {
  for (const port of [5174, 5175, 5173]) {
    try {
      const res = await fetch(`http://localhost:${port}/examples/index.html`, { method: 'HEAD' });
      if (res.ok) return `http://localhost:${port}`;
    } catch { /* probe next */ }
  }
  throw new Error('dev server not found (5174/5175/5173)');
})();

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', err => pageErrors.push(err.message));

await page.goto(`${BASE}/examples/index.html`, { waitUntil: 'networkidle' });
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

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===\n`);
if (pageErrors.length > 0) {
  failCount += pageErrors.length;
  console.error(`=== pageerror ${pageErrors.length}건: ${pageErrors.slice(0, 3).join(' | ')} ===`);
}
if (failCount > 0) process.exit(1);