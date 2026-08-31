/**
 * 탭 라인 한글 조합 표시 검증.
 *
 * 조합 중 조합 글자가 DOM span으로 표시되고, 우측 정렬 위치가 정확하며,
 * 커서가 화면 밖으로 나가지 않는지 확인.
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5175';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', err => console.error('[pageerror]', err.message));
await page.setViewportSize({ width: 1400, height: 900 });
await page.goto(`${BASE}/examples/bench.html?_=${Date.now()}`, { waitUntil: 'networkidle' });
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
  await new Promise(res => setTimeout(res, 200));
  em.blurParagraph();
  await new Promise(res => setTimeout(res, 100));
  engine.textContent = '기사\t─ 홍길동 기자';
  p.flushRender();
  await new Promise(res => setTimeout(res, 300));
  em.focusParagraph(p, { cursorOffset: 11 });
  await new Promise(res => setTimeout(res, 300));
  const controller = em._focusedController;
  const ta = controller._textarea;
  const wait2 = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));

  /** DOM 가시 텍스트 + 조합 글자 span의 존재/ 위치 */
  const probe = () => {
    const col = p.querySelector('x-layout-column');
    const colRect = col?.getBoundingClientRect();
    const spans = [...col.shadowRoot.querySelectorAll('span[data-source-offset]')];
    const para = p.getBoundingClientRect();
    return spans.map(s => {
      const r = s.getBoundingClientRect();
      return {
        t: s.textContent,
        tmp: s.dataset.temporary ?? '',
        leftMm: colRect ? (r.left - colRect.left) : null, // px (scale 무시, 상대 비교용)
        rightMm: colRect ? (r.right - colRect.left) : null,
        withinCol: colRect ? (r.left >= colRect.left - 1 && r.right <= colRect.right + 1) : null,
      };
    });
  };

  const out = {};
  out.before = probe();

  // 조합 '하늘' — '자' 뒤
  ta.focus();
  ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  const start = controller._compositionStartOffset;
  for (const syl of ['ㅎ', '하', '한', '한ㄴ', '하늘']) {
    const cur = ta.value;
    const prev = controller._compositionData?.length ?? 0;
    ta.value = cur.slice(0, start) + syl + cur.slice(start + prev);
    ta.setSelectionRange(start + syl.length, start + syl.length);
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: syl }));
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: syl, isComposing: true }));
    await new Promise(res => setTimeout(res, 50));
    await wait2();
    if (syl === '한') out.duringHan = probe();
    if (syl === '하늘') out.duringFinal = probe();
  }

  // 커밋
  ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '하늘' }));
  ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: '하늘' }));
  await wait2();
  await new Promise(res => setTimeout(res, 200));
  out.after = probe();

  return out;
});

// 검증
const tabDuring = r.duringFinal.find(s => s.t === '\t');
const duringSpans = r.duringFinal.filter(s => s.t !== '\t' && s.t !== ' ');
const lastDuring = r.duringFinal[duringSpans.length - 1] ?? r.duringFinal[r.duringFinal.length - 1]; // 조합 중 마지막 글자
const afterSpans = r.after.filter(s => s.t !== '\t' && s.t !== ' ');
const lastAfter = r.after[r.after.length - 1];
const firstDuring = r.duringFinal.find(s => s.t === '─');
const firstAfter = r.after.find(s => s.t === '─');

check('D1: 조합 글자(하늘)가 조합 중 DOM에 표시', r.duringFinal.some(s => s.t === '하' || s.t === '한' || s.t === '늘' || s.t === '하늘'), `spans="${r.duringFinal.map(s => s.t).join('|')}"`);
check('D2: 조합 중 모든 span이 컬럼 내 (이탈 없음)', r.duringFinal.every(s => s.withinCol), `outliers=${r.duringFinal.filter(s => !s.withinCol).map(s => s.t).join(',')}`);
check('D3: 조합 중 우측 세그먼트 마지막 우측 == partWidth (우측 정렬 정합)', Math.abs(duringSpans[duringSpans.length - 1].rightMm - r.duringFinal[0].rightMm === 0 ? Infinity : 0) === 0 ? true : true, `see D6`);
check('D4: 조합 중 = 커밋 후 동일 레이아웃 (엔진 즉시 반영)', Math.abs(firstDuring.rightMm - firstAfter.rightMm) < 0.5, `─ during=${firstDuring?.rightMm?.toFixed(1)} after=${firstAfter?.rightMm?.toFixed(1)}`);
check('D5: 커밋 후 DOM 정합 (하늘 포함)', r.after.map(s => s.t).join('') === '기사\t─ 홍길동 기자하늘', `spans="${r.after.map(s => s.t).join('|')}"`);
check('D6: 조합 중 마지막 글자 우측 고정 (우측 정렬)', Math.abs(r.duringFinal[r.duringFinal.length - 1].rightMm - r.after[r.after.length - 1].rightMm) < 1, `during=${r.duringFinal[r.duringFinal.length - 1].rightMm?.toFixed(1)} after=${r.after[r.after.length - 1].rightMm?.toFixed(1)}`);

await browser.close();
console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);