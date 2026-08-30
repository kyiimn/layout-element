/**
 * IME 조합 경로 DOM 정합성 검증.
 *
 * 조합 중 렌더를 compositionend까지 지연하는 최적화(_onCompositionUpdate가
 * optimistic span만 갱신) 후에도 다음이 정합한지 검사한다:
 * 1. 조합 커밋 후 DOM 텍스트 === 엔진 텍스트
 * 2. 조합 취소(compositioncancel) 시 원상 복원
 * 3. 조합 중 optimistic span 표시 + 커서 위치
 * 4. 영문 타이핑 + 한글 조합 혼합 시퀀스 정합
 * 5. 조합 중 span source-offset 무결성
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-ime.mjs
 * ```
 */
import { chromium } from '@playwright/test';

const BASE = await (async () => {
  for (const port of [5175, 5173]) {
    try {
      const res = await fetch(`http://localhost:${port}/examples/bench.html`, { method: 'HEAD' });
      if (res.ok) return `http://localhost:${port}`;
    } catch { /* probe next */ }
  }
  throw new Error('dev server not found');
})();

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', err => console.error('[pageerror]', err.message.slice(0, 300)));
await page.goto(`${BASE}/examples/bench.html`, { waitUntil: 'networkidle' });
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
  await new Promise(r => setTimeout(r, 200));
  em.focusParagraph(p);
  await new Promise(r => setTimeout(r, 200));
  const controller = em._focusedController;
  const ta = controller?._textarea;
  if (!ta) return { error: 'no ta' };

  const wait2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  /** DOM 가시 텍스트 (컬럼/라인 순). data-temporary 낙관 span도 포함하지 않는다. */
  const domText = () => {
    const cols = [...p.querySelectorAll('x-layout-column')];
    return cols.map(col => {
      const lines = [...col.shadowRoot.children].filter(c => c.tagName === 'DIV');
      return lines.filter(l => l.style.display !== 'none')
        .map(l => [...l.querySelectorAll('span[data-source-offset]:not([data-temporary])')]
          .map(s => s.textContent).join(''))
        .join('\n');
    }).join('\n');
  };

  /** 엔진 가시 텍스트 (renderText strip 규칙 적용). */
  const engineText = () => {
    return engine.columnContents.map(col => col.map(line => {
      if (!line || (line.parts ?? []).length === 0) return null;
      let text = '';
      line.parts.forEach((pt, idx) => {
        let c = Array.isArray(pt.content) ? pt.content.join('') : String(pt.content);
        const isFirst = idx === 0;
        const isLast = idx === line.parts.length - 1;
        if (isFirst && line.firstOfBlock !== true) c = c.replace(/^ +/, '');
        if (isLast && line.endOfBlock !== true) c = c.replace(/ +$/, '');
        text += c;
      });
      return text;
    }).filter(t => t !== null).join('\n')).join('\n');
  };

  const spanIntegrity = () => {
    let prev = -1, monotonic = true, dups = 0;
    const seen = new Set();
    for (const col of p.querySelectorAll('x-layout-column')) {
      for (const s of col.shadowRoot.querySelectorAll('span[data-source-offset]:not([data-temporary])')) {
        const off = parseInt(s.dataset.sourceOffset, 10);
        if (seen.has(off)) dups++;
        seen.add(off);
        if (off < prev) monotonic = false;
        prev = off;
      }
    }
    return { monotonic, dups };
  };

  const compose = async (jamos, withInput = true) => {
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const start = controller._compositionStartOffset;
    for (const syl of jamos) {
      const cur = ta.value;
      const prev = controller._compositionData?.length ?? 0;
      ta.value = cur.slice(0, start) + syl + cur.slice(start + prev);
      ta.setSelectionRange(start + syl.length, start + syl.length);
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: syl }));
      if (withInput) ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: syl, isComposing: true }));
      await new Promise(r => setTimeout(r, 30));
    }
  };
  const commitCompose = async (finalData) => {
    ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: finalData }));
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: finalData }));
    await wait2();
  };
  const cancelCompose = async () => {
    ta.dispatchEvent(new CompositionEvent('compositioncancel', { bubbles: true }));
    await wait2();
  };

  em.focusParagraph(p, { cursorOffset: ta.value.length });
  await wait2();
  const out = {};

  // ── 1. 조합 커밋 정합 ('한글입력' 단어 2개) ──
  const before = ta.value;
  await compose(['ㅎ', '하', '한']);
  // 1a. 조합 중: optimistic span 존재 + 커서 위치
  out.composingState = {
    hasOptimisticSpan: !!(controller._optimisticSpan && controller._optimisticSpan.parentNode),
    optimisticText: controller._optimisticSpan?.textContent ?? null,
    cursorOffset: controller._cursorModel.offset,
    composingFlag: controller._isComposing,
  };
  await commitCompose('한');
  out.afterCommit1 = {
    domEngineMatch: domText() === engineText(),
    span: spanIntegrity(),
    taValueEndsWith: ta.value.slice(-1),
  };

  await compose(['ㄱ', '그', '글']);
  await commitCompose('글');
  out.afterCommit2 = {
    domEngineMatch: domText() === engineText(),
    span: spanIntegrity(),
    taEndsWith: ta.value.slice(-2),
  };

  // ── 2. 조합 취소 원상 복원 ──
  const beforeCancel = ta.value;
  await compose(['ㅇ', '이', '입']);
  await cancelCompose();
  out.afterCancel = {
    restored: ta.value === beforeCancel,
    domEngineMatch: domText() === engineText(),
    span: spanIntegrity(),
  };

  // ── 3. 영문 + 한글 혼합 ──
  const seq = [];
  // 영문 3키
  for (const ch of ['a', 'b', 'c']) {
    const b = ta.value;
    const offset = ta.selectionStart ?? b.length;
    ta.value = b.slice(0, offset) + ch + b.slice(ta.selectionEnd ?? offset);
    ta.setSelectionRange(offset + 1, offset + 1);
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await wait2();
  }
  // 한글 1단어
  await compose(['ㄹ', '려', '력']);
  await commitCompose('력');
  // 영문 2키
  for (const ch of ['x', 'y']) {
    const b = ta.value;
    const offset = ta.selectionStart ?? b.length;
    ta.value = b.slice(0, offset) + ch + b.slice(ta.selectionEnd ?? offset);
    ta.setSelectionRange(offset + 1, offset + 1);
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await wait2();
  }
  seq.push({
    domEngineMatch: domText() === engineText(),
    span: spanIntegrity(),
    taTail: ta.value.slice(-8),
  });
  out.mixed = seq;

  // ── 4. 커서 조회 정합 (혼합 후) ──
  const probe = [0, 1, Math.floor(ta.value.length / 3), Math.floor(ta.value.length / 2), ta.value.length - 1];
  out.cursorProbes = probe.map(off => ({ off, ok: controller._mapper.getCursorPlacement(off) !== null || controller._mapper.getCharRect(off) !== null }));

  // ── 5. 조합 중 caretHint 상태 (커밋 시 prefix 캐시 활용) ──
  await compose(['ㅅ', '수', '순']);
  out.composingCacheHint = {
    engineDirty: engine.hasPendingChanges,
    hasLayoutCache: engine.hasLayoutCache,
  };
  await commitCompose('순');
  out.afterCommit3 = { domEngineMatch: domText() === engineText(), cacheHit: engine.hasLayoutCache };

  // 원상 복원
  ta.value = before;
  em.focusParagraph(p, { cursorOffset: before.length });
  controller._runMap = [{ start: 0, end: before.length, style: undefined }];
  p.model.textContent = before;
  p.flushRender();
  await wait2();

  return out;
});

if (r.error) { console.log('ERROR:', r.error); process.exit(1); }

check('1a. 조합 중 optimistic span 존재', r.composingState.hasOptimisticSpan, `text="${r.composingState.optimisticText}"`);
check('1a. 조합 중 커서 위치 (start+data.length)', r.composingState.cursorOffset >= 0 && r.composingState.composingFlag);
check('1b. 커밋 후 DOM===엔진 (한)', r.afterCommit1.domEngineMatch, `ta="${r.afterCommit1.taValueEndsWith}"`);
check('1b. 커밋 후 span 무결성', r.afterCommit1.span.monotonic && r.afterCommit1.span.dups === 0);
check('1c. 연속 커밋 DOM===엔진 (한글)', r.afterCommit2.domEngineMatch && r.afterCommit2.taEndsWith === '한글');
check('2. 조합 취소 원상 복원', r.afterCancel.restored && r.afterCancel.domEngineMatch && r.afterCancel.span.dups === 0);
check('3. 영문+한글 혼합 정합', r.mixed[0].domEngineMatch, `tail="${r.mixed[0].taTail}"`);
check('3. 혼합 후 span 무결성', r.mixed[0].span.monotonic && r.mixed[0].span.dups === 0);
check('4. 커서 조회 전 경로 유효', r.cursorProbes.every(c => c.ok));
check('5. 조합 중 엔진 dirty 유지', r.composingCacheHint.engineDirty);
check('5. 커밋 후 DOM===엔진 (순)', r.afterCommit3.domEngineMatch);

await browser.close();
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);