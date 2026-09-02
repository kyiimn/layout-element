/**
 * DOM 정합성 검증: 라인 수 변화 시 diff 렌더링이 올바른지 검사한다.
 *
 * 스냅샷(scripts/snapshot-layout.mjs)은 엔진 `columnContents`만 검증하므로
 * DOM 재사용 경로의 결함(stale span, 누락/중복 문자)을 잡지 못한다. 이
 * 스크립트는 실제 렌더된 DOM과 엔진이 계산한 텍스트를 직접 비교한다.
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-dom-diff.mjs
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const BASE_PORT = 5198;

// 라이브 서버 후보 (layout-element dev server 우선).
// 주의 — 포트만으로는 다른 앱의 Vite 서버(apps/layout-ui, SPA fallback으로
// 존재하지 않는 경로에도 200을 반환)와 구별되지 않으므로, probe는 반드시
// 콘텐츠(title)까지 검증해야 한다.
const BASE_URL_CANDIDATES = [
  'http://localhost:5175',
  'http://localhost:5173',
];

/**
 * 후보 URL이 layout-element의 bench 페이지를 실제로 서빙하는지 검증한다.
 *
 * SPA fallback을 쓰는 타 앱 Vite 서버는 존재하지 않는 경로에도 앱 index를
 * 200으로 반환하므로, `res.ok`만으로는 판별할 수 없다. HTML을 읽어
 * bench.html의 title("Layout Element Benchmark")이 있는지 확인한다.
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
page.on('pageerror', err => console.error('[pageerror]', err.message));
await page.goto(`${baseUrl}/examples/bench.html`, { waitUntil: 'networkidle' });
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
  const { SelectionRange } = await import('/src/types/edit/selection.type');

  const half = Math.floor(ta.value.length / 2);
  const out = {};

  /** DOM에서 가시 텍스트를 컬럼/라인 순서로 수집한다. */
  const domVisibleText = () => {
    const cols = [...p.querySelectorAll('x-layout-column')];
    return cols.map(col => {
      const lines = [...col.shadowRoot.children].filter(c => c.tagName === 'DIV');
      return lines
        .filter(l => l.style.display !== 'none')
        .map(l => {
          const spans = [...l.querySelectorAll('span[data-source-offset]')];
          return spans.map(s => s.textContent).join('');
        });
    });
  };

  /** 엔진이 계산한 가시 텍스트를 라인별로 수집한다 (renderText와 동일한 strip 규칙). */
  const engineVisibleText = () => {
    return engine.columnContents.map(col =>
      col.map(line => {
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
      }).filter(t => t !== null)
    );
  };

  /** DOM span의 source-offset이 정렬 상태를 유지하는지 검사한다. */
  const spanOffsetsSorted = () => {
    const cols = [...p.querySelectorAll('x-layout-column')];
    let prev = -1;
    let monotonic = true;
    let duplicates = 0;
    const seen = new Set();
    for (const col of cols) {
      for (const s of col.shadowRoot.querySelectorAll('span[data-source-offset]')) {
        const off = parseInt(s.dataset.sourceOffset, 10);
        if (seen.has(off)) duplicates++;
        seen.add(off);
        if (off < prev) monotonic = false;
        prev = off;
      }
    }
    return { monotonic, duplicates };
  };

  const waitSettle = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // ── 시나리오 A: fontSize 주입/수정/제거 (라인 수 변화 25→28→31→25) ──
  const seq = [5, 6, undefined];
  const results = [];
  for (const fs of seq) {
    em.focusParagraph(p, { selection: SelectionRange.fromOffsets(0, half) });
    await new Promise(r => setTimeout(r, 30));
    em.applyInlineStyle({ fontSize: fs });
    await waitSettle();

    const dom = domVisibleText();
    const eng = engineVisibleText();
    const domFlat = dom.map(c => c.join('')).join('\n');
    const engFlat = eng.map(c => c.join('')).join('\n');
    const sorted = spanOffsetsSorted();
    results.push({
      fontSize: String(fs),
      domEngineMatch: domFlat === engFlat,
      monotonic: sorted.monotonic,
      duplicates: sorted.duplicates,
      domColCount: dom.length,
      domLineCounts: dom.map(c => c.length),
      engLineCounts: eng.map(c => c.length),
    });
  }
  out.fontSizeSeq = results;

  // ── 시나리오 B: 라인 수 변화 + 텍스트 편집 혼합 (wrap 경계 타이핑) ──
  // fontSize 5 주입 상태에서 커서를 끝에 두고 타이핑 — 줄바꿈 발생 키가
  // diff 경로에서 정합한지.
  em.focusParagraph(p, { selection: SelectionRange.fromOffsets(0, half) });
  await new Promise(r => setTimeout(r, 30));
  em.applyInlineStyle({ fontSize: 5 });
  await waitSettle();

  em.focusParagraph(p);
  await new Promise(r => setTimeout(r, 50));
  const typeResults = [];
  for (let i = 0; i < 12; i++) {
    const before = ta.value;
    const offset = ta.selectionStart ?? before.length;
    ta.value = before.slice(0, offset) + '가' + before.slice(ta.selectionEnd ?? offset);
    ta.setSelectionRange(offset + 1, offset + 1);
    ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  const dom2 = domVisibleText();
  const eng2 = engineVisibleText();
  typeResults.push({
    domEngineMatch: dom2.map(c => c.join('')).join('\n') === eng2.map(c => c.join('')).join('\n'),
    sorted: spanOffsetsSorted(),
    domSpans: p.querySelectorAll('span[data-source-offset]').length,
  });
  out.typingDuringWrap = typeResults;

  // ── 시나리오 C: fontSize 제거 후 원 상태 복원 확인 ──
  em.focusParagraph(p, { selection: SelectionRange.fromOffsets(0, half) });
  await new Promise(r => setTimeout(r, 30));
  em.applyInlineStyle({ fontSize: undefined });
  await waitSettle();
  const dom3 = domVisibleText();
  const eng3 = engineVisibleText();
  out.cleanupMatch = dom3.map(c => c.join('')).join('\n') === eng3.map(c => c.join('')).join('\n');

  // ── 시나리오 D: trailing \n (문단 끝 엔터) — 빈 라인 렌더/매핑/round-trip ──
  p.content = '가나다\n마바사\n';
  p.flushRender();
  await waitSettle();
  const trailingDom = domVisibleText();
  const trailingEng = engineVisibleText();
  const trailingBefore = ta.value;
  out.trailingNewline = {
    domEngineMatch: trailingDom.map(c => c.join('')).join('\n') === trailingEng.map(c => c.join('')).join('\n'),
    lineCount: engine.columnContents[0].length,
    // 마지막 빈 라인에 커서 → 라인 rect 폴백이 새 빈 라인을 가리키는지
    cursorLine: (() => {
      const li = controller._mapper.getLineInfoBySourceOffset(8);
      return li ? li.lineIndex : null;
    })(),
  };
  // round-trip: extractData 재주입 후에도 trailing \n 보존
  const dataBefore = JSON.stringify(p.data);
  p.data = JSON.parse(dataBefore);
  p.flushRender();
  await waitSettle();
  out.trailingNewline.roundTrip = JSON.stringify(p.data) === dataBefore && ta.value.endsWith('\n');

  // 원상 복원 (이후 시나리오 없음 — trailing 텍스트 유지)

  // 커서 위치 조회 정합성 (mapper가 DOM 재사용 후에도 올바른 span을 찾는지)
  // 현재 텍스트(trailing \n 포함 8자) 기준 오프셋으로 조회한다.
  const curLen = ta.value.length;
  const probeOffsets = [0, 1, Math.floor(curLen / 4), curLen - 2, curLen - 1];
  out.cursorRects = probeOffsets.map(off => {
    const rect = controller._mapper.getCharRect(off);
    const line = controller._mapper.getLineInfoBySourceOffset(off);
    return { off, found: rect !== null || line !== null };
  });

  return out;
});

// ── 판정 ──
for (const s of r.fontSizeSeq) {
  check(`fontSize=${s.fontSize}: DOM 텍스트 === 엔진 텍스트`, s.domEngineMatch);
  check(`fontSize=${s.fontSize}: span source-offset 단조 증가`, s.monotonic);
  check(`fontSize=${s.fontSize}: 중복 span 없음`, s.duplicates === 0, `dups=${s.duplicates}`);
}
for (const s of r.typingDuringWrap) {
  check('타이핑+wrap 혼합: DOM 텍스트 === 엔진 텍스트', s.domEngineMatch);
  check('타이핑+wrap 혼합: span 정렬 유지', s.sorted.monotonic && s.sorted.duplicates === 0);
}
check('fontSize 제거 후 원상 복원 일치', r.cleanupMatch);
check('D. trailing \\n: DOM===엔진 (빈 라인 포함)', r.trailingNewline.domEngineMatch, `lines=${r.trailingNewline.lineCount}`);
check('D. trailing \\n: 커서 폴백이 마지막 빈 라인 가리킴', r.trailingNewline.cursorLine === r.trailingNewline.lineCount - 1, `cursorLine=${r.trailingNewline.cursorLine}`);
check('D. trailing \\n: extractData round-trip 보존', r.trailingNewline.roundTrip);
check('커서 rect 조회 전 경로 유효', r.cursorRects.every(c => c.found), JSON.stringify(r.cursorRects.filter(c => !c.found)));

await browser.close();
// 자체 스폰한 서버만 종료한다 (외부 라이브 서버는 건드리지 않음).
if (server) server.kill();
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);