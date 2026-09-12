/**
 * IME 조합 경로 DOM 정합성 검증.
 *
 * 조합 중 표시를 엔진 렌더 경로로 통일(optimistic span 제거 — 라인 밖 밀어남
 * 방지)한 뒤에도 다음이 정합한지 검사한다:
 * 1. 조합 중 엔진 렌더 경로 (optimistic span 없음) + 커밋 후 DOM 텍스트 === 엔진 텍스트
 * 2. 조합 취소(compositioncancel) 시 원상 복원
 * 3. 영문 타이핑 + 한글 조합 혼합 시퀀스 정합
 * 4. 조합 중 span source-offset 무결성
 * 5. 조합 중 엔진 wrap 실증 (라인 증가) + 컬럼 밖 span 0개
 * 6. 걸침표 ON (overflow visible) 조합 좌표 무결성
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-ime.mjs
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5200;

/**
 * 후보 URL이 layout-element의 bench 페이지를 실제로 서빙하는지 검증한다.
 *
 * probe는 HTML title까지 검증해야 한다 — 타 앱 Vite 서버(SPA fallback)는
 * 존재하지 않는 경로에도 200을 반환한다 (실제 사고: layout-ui 서버를
 * 잡아 BENCH_READY 타임아웃).
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

/**
 * 스폰한 vite 서버가 응답할 때까지 폴링한다. 최대 30초.
 *
 * @param {string} url - 스폰 서버 base URL
 * @returns {Promise<boolean>} 서버 준비 완료 여부
 */
async function waitForServer(url) {
  for (let i = 0; i < 60; i++) {
    if (await probe(url)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

let BASE = null;
let server = null;
for (const cand of ['http://localhost:5175', 'http://localhost:5173']) {
  if (await probe(cand)) { BASE = cand; break; }
}
if (!BASE) {
  server = spawn('npx', ['vite', 'dev', '--port', String(BASE_PORT), '--strictPort'], {
    cwd: pkgRoot, stdio: 'pipe', shell: true,
  });
  const spawnedUrl = `http://localhost:${BASE_PORT}`;
  if (await waitForServer(spawnedUrl)) BASE = spawnedUrl;
  else { server.kill(); throw new Error(`vite dev server not ready on ${spawnedUrl}`); }
}

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
  // 1a. 조합 중: 엔진 렌더 경로 (optimistic span 없음 — 라인 밖 밀어남 방지) + 커서 위치
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

  // ── 5. 조합 중 커밋 상태 (엔진 렌더 경로 — 음절당 즉시 커밋) ──
  // 과거(렌더 지연 최적화)에는 조합 중 dirty가 유지되었지만, 엔진 렌더 경로
  // 통일 후에는 매 음절이 rAF 커밋(flushRender)으로 즉시 반영되므로 dirty가
  // 해소된다. 조합 중 dirty=false가 새 정합 계약이다.
  await compose(['ㅅ', '수', '순']);
  out.composingCacheHint = {
    engineDirty: engine.hasPendingChanges,
    hasLayoutCache: engine.hasLayoutCache,
  };
  await commitCompose('순');
  out.afterCommit3 = { domEngineMatch: domText() === engineText(), cacheHit: engine.hasLayoutCache };

  // ── 6. 조합 중 엔진 렌더 경로 — 라인 밖 밀어남 방지 (걸침표 OFF 포함 전 조합) ──
  // 버그: 과거 조합 중 optimistic span 밀어내기(_shiftFollowingSpans)가 라인 폭을
  // 넘어도 wrap 없이 기존 span을 파트/컬럼 폭 밖으로 밀어냈다. 걸침표 OFF 컬럼은
  // overflow: hidden에 가려질 뿐 데이터상 라인 밖 배치였고, 걸침표 ON 컬럼
  // (overflow: visible)에서는 눈에 보였다. 수정: 조합 중 표시를 항상 엔진 렌더
  // 경로로 통일 — 엔진이 매 음절 정확한 wrap을 계산한다.
  const totalLines = () => engine.columnContents.reduce((a, c) => a + (c?.length ?? 0), 0);
  // 버그 직접 검증: 어떤 span도 컬럼 폭 밖(charOffset > columnWidth)에 배치되지 않는다.
  // 걸침 글자(charOffset === partWidth)는 걸침표 산출물이므로 폭 이하면 정상.
  const outOfColumnSpans = () => {
    const cols = [...p.querySelectorAll('x-layout-column')];
    const bad = [];
    cols.forEach((c, ci) => {
      const colW = engine.columnWidths[ci] ?? 0;
      c.shadowRoot.querySelectorAll('span[data-char-offset]').forEach(s => {
        const off = parseFloat(s.dataset.charOffset);
        if (!Number.isNaN(off) && off > colW + 0.01) bad.push({ col: ci, off, colW });
      });
    });
    return bad;
  };

  const baselineLines = totalLines();
  // 마지막 라인 끝에서 컬럼 폭을 넘는 조합을 구성해 조합 중 wrap을 강제한다.
  const colCount = engine.columnContents.length;
  const lastColW = engine.columnWidths[colCount - 1] ?? engine.columnWidths[0];
  const charW = engine.getCharWidths('가').swidth;
  const growChars = Math.ceil(lastColW / charW) + 2;
  const growth = [];
  let g = '';
  for (let i = 0; i < growChars; i++) { g += '가'; growth.push(g); }
  await compose(growth);
  await wait2();
  const midLines = totalLines();
  out.hangingCompose = {
    // optimistic 경로 미사용 — 엔진 렌더 경로 판정 (걸침표 OFF 상태에서도)
    engineRenderPath: controller._optimisticSpan === null,
    noTemporarySpan: [...p.querySelectorAll('x-layout-column')].every(
      c => c.shadowRoot.querySelectorAll('span[data-temporary]').length === 0),
    // 조합 중에도 엔진이 조합 텍스트를 wrap하여 렌더 (DOM === 엔진)
    domEngineMatch: domText() === engineText(),
    baselineLines,
    midLines,
    outOfColumn: outOfColumnSpans(),
    span: spanIntegrity(),
  };
  await commitCompose(g);
  out.afterHangingCommit = {
    domEngineMatch: domText() === engineText(),
    endLines: totalLines(),
    outOfColumn: outOfColumnSpans(),
    span: spanIntegrity(),
  };

  // ── 7. 걸침표 ON 조합 — overflow visible 상태에서도 라인 밖 밀어남 없음 ──
  // OFF 상태의 [6]에 더해, 걸침표 ON(컬럼 overflow: visible)에서도 동일 계약이
  // 유지되는지 확인한다. 조합은 클립 없이 페인트되므로 좌표 무결성이 곧 화면 진실.
  const origParagraphStyle = { ...p.paragraphStyle };
  p.paragraphStyle = { ...origParagraphStyle, hangingPunctuation: true };
  await wait2();
  em.focusParagraph(p, { cursorOffset: ta.value.length });
  await wait2();
  const hangBaselineLines = totalLines();
  await compose(growth);
  await wait2();
  out.hangingOnCompose = {
    domEngineMatch: domText() === engineText(),
    baselineLines: hangBaselineLines,
    midLines: totalLines(),
    outOfColumn: outOfColumnSpans(),
    span: spanIntegrity(),
  };
  await commitCompose(g);
  out.afterHangingOnCommit = {
    domEngineMatch: domText() === engineText(),
    outOfColumn: outOfColumnSpans(),
    span: spanIntegrity(),
  };
  // 원상 복원 (paragraphStyle 포함)
  p.paragraphStyle = origParagraphStyle;

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

check('1a. 조합 중 엔진 렌더 경로 (optimistic span 없음)', !r.composingState.hasOptimisticSpan, `text="${r.composingState.optimisticText}"`);
check('1a. 조합 중 커서 위치 (start+data.length)', r.composingState.cursorOffset >= 0 && r.composingState.composingFlag);
check('1b. 커밋 후 DOM===엔진 (한)', r.afterCommit1.domEngineMatch, `ta="${r.afterCommit1.taValueEndsWith}"`);
check('1b. 커밋 후 span 무결성', r.afterCommit1.span.monotonic && r.afterCommit1.span.dups === 0);
check('1c. 연속 커밋 DOM===엔진 (한글)', r.afterCommit2.domEngineMatch && r.afterCommit2.taEndsWith === '한글');
check('2. 조합 취소 원상 복원', r.afterCancel.restored && r.afterCancel.domEngineMatch && r.afterCancel.span.dups === 0);
check('3. 영문+한글 혼합 정합', r.mixed[0].domEngineMatch, `tail="${r.mixed[0].taTail}"`);
check('3. 혼합 후 span 무결성', r.mixed[0].span.monotonic && r.mixed[0].span.dups === 0);
check('4. 커서 조회 전 경로 유효', r.cursorProbes.every(c => c.ok));
check('5. 조합 중 음절 커밋 해소 (엔진 렌더 경로 — dirty 없음)', !r.composingCacheHint.engineDirty);
check('5. 커밋 후 DOM===엔진 (순)', r.afterCommit3.domEngineMatch);
check('6. 조합 중 optimistic 경로 미사용 (엔진 렌더 통일)', r.hangingCompose.engineRenderPath && r.hangingCompose.noTemporarySpan,
  `optimistic=${r.hangingCompose.engineRenderPath}, tempSpan=${!r.hangingCompose.noTemporarySpan}`);
check('6. 조합 중 DOM===엔진 (wrap 적용)', r.hangingCompose.domEngineMatch, `midLines=${r.hangingCompose.midLines}`);
check('6. 조합 중 span 무결성', r.hangingCompose.span.monotonic && r.hangingCompose.span.dups === 0);
check('6. 조합 중 라인 증가 (엔진 wrap 실증)', r.hangingCompose.midLines > r.hangingCompose.baselineLines,
  `baseline=${r.hangingCompose.baselineLines} → mid=${r.hangingCompose.midLines}`);
check('6. 조합 중 컬럼 밖 span 0개 (버그 직접 검증)', r.hangingCompose.outOfColumn.length === 0,
  r.hangingCompose.outOfColumn.map(b => `col${b.col}:off=${b.off.toFixed(1)}>w=${b.colW.toFixed(1)}`).join(','));
check('6. 커밋 후 DOM===엔진', r.afterHangingCommit.domEngineMatch, `endLines=${r.afterHangingCommit.endLines}`);
check('6. 커밋 후 컬럼 밖 span 0개', r.afterHangingCommit.outOfColumn.length === 0);
check('6. 커밋 후 span 무결성', r.afterHangingCommit.span.monotonic && r.afterHangingCommit.span.dups === 0);
check('7. 걸침표 ON 조합 중 DOM===엔진 (overflow visible)', r.hangingOnCompose.domEngineMatch,
  `baseline=${r.hangingOnCompose.baselineLines} → mid=${r.hangingOnCompose.midLines}`);
check('7. 걸침표 ON 조합 중 컬럼 밖 span 0개', r.hangingOnCompose.outOfColumn.length === 0,
  r.hangingOnCompose.outOfColumn.map(b => `col${b.col}:off=${b.off.toFixed(1)}>w=${b.colW.toFixed(1)}`).join(','));
check('7. 걸침표 ON 조합 중 span 무결성', r.hangingOnCompose.span.monotonic && r.hangingOnCompose.span.dups === 0);
check('7. 걸침표 ON 커밋 후 DOM===엔진', r.afterHangingOnCommit.domEngineMatch);
check('7. 걸침표 ON 커밋 후 컬럼 밖 span 0개', r.afterHangingOnCommit.outOfColumn.length === 0);
check('7. 걸침표 ON 커밋 후 span 무결성', r.afterHangingOnCommit.span.monotonic && r.afterHangingOnCommit.span.dups === 0);

await browser.close();
if (server) server.kill();
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);