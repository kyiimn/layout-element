/**
 * Right Indent Tab 브라우저 E2E 검증 (최종본).
 *
 * 검증 전략:
 * - Phase 1 (데이터 주입): model.textContent 직접 설정 + flushRender → 엔진/DOM 검증
 * - Phase 2 (키 입력): Shift+Tab keydown → 탭 삽입/커서 검증
 *
 * 좌표 검증은 DOM getBoundingClientRect(transform 반영) 대신
 * span의 dataset.charOffset + dataset.swidth (엔진 산출값)로 비교한다.
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5175';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', err => console.error('[pageerror]', err.message));
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
  em.textEditMode = true;
  p.editableText = true;
  await new Promise(res => setTimeout(res, 200));
  em.blurParagraph();

  const engine = p.engine;
  const byline = '기사 내용입니다\t─ 홍길동 기자';
  engine.textContent = byline;
  p.flushRender();
  await new Promise(res => setTimeout(res, 300));

  const out = {};
  const line = engine.columnContents[0]?.[0];
  const part = line?.parts?.[0];
  out.joined = part ? part.content.join('') : null;
  out.lineCount = engine.columnContents.reduce((s, c) => s + c.length, 0);

  const spans = [...p.querySelectorAll('x-layout-column')].flatMap(col =>
    [...col.shadowRoot.querySelectorAll('span[data-source-offset]')]
  );
  const tabSpan = spans.find(s => s.textContent === '\t');
  out.tabSpanExists = tabSpan !== undefined;
  out.tabSpanRectWidth = tabSpan ? tabSpan.getBoundingClientRect().width : null;
  out.tabSpanVisibility = tabSpan ? tabSpan.style.visibility : null;
  out.tabSpanCssWidth = tabSpan ? tabSpan.style.width : null;

  // 좌표 검증: post-tab 첫 글자와 마지막 글자 span의 dataset (엔진 산출) 기준
  const visibleSpans = spans.filter(s => s.textContent !== '\t' && s.textContent !== ' ');
  const lastVisible = visibleSpans[visibleSpans.length - 1];
  const tabIdxInSpans = spans.indexOf(tabSpan);
  const firstAfterTab = tabIdxInSpans >= 0 ? spans.slice(tabIdxInSpans + 1).find(s => s.textContent !== ' ') : null;
  if (lastVisible && part) {
    out.lastCharLeftMm = parseFloat(lastVisible.dataset.charOffset);
    out.lastCharSwidth = parseFloat(lastVisible.dataset.swidth);
    out.lastCharRightMm = out.lastCharLeftMm + out.lastCharSwidth;
    out.partWidthMm = part.width;
  }
  if (firstAfterTab) {
    out.firstAfterTabLeftMm = parseFloat(firstAfterTab.dataset.charOffset);
  }

  // 탭의 dataset
  if (tabSpan) {
    out.tabLeftMm = parseFloat(tabSpan.dataset.charOffset);
  }

  // ── Shift+Tab 키 삽입 ──
  em.focusParagraph(p, { cursorOffset: byline.length });
  await new Promise(res => setTimeout(res, 200));
  const controller = em._focusedController;
  const ta = controller._textarea;
  ta.focus();
  ta.setSelectionRange(byline.length, byline.length);
  ta.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
  }));
  await new Promise(res => setTimeout(res, 400));

  out.modelPlainText = engine.plainText;
  out.cursorOffsetAfterInsert = controller.cursorOffset;
  out.taValue = ta.value;

  return out;
});

check('E1: 엔진에 탭 보존', r.joined?.includes('\t') ?? false, `joined="${(r.joined ?? '').slice(0, 25)}"`);
check('E2: 바이라인 1라인 배치', r.lineCount === 1, `lines=${r.lineCount}`);
check('E3: 탭 span DOM 존재', r.tabSpanExists);
check('E4: 탭 span 0폭 (CSS)', r.tabSpanCssWidth === '0mm', `cssWidth=${r.tabSpanCssWidth}, rect=${r.tabSpanRectWidth}`);
check('E5: 탭 span visibility hidden', r.tabSpanVisibility === 'hidden', `vis=${r.tabSpanVisibility}`);
check('E6: 탭 이후 텍스트 우측 정렬 (mm)', Math.abs((r.lastCharRightMm ?? -1) - (r.partWidthMm ?? -2)) < 0.05, `lastRight=${r.lastCharRightMm?.toFixed(3)} vs partWidth=${r.partWidthMm?.toFixed(3)}`);
check('E6b: 탭 위치 = 우측 세그먼트 시작', r.tabLeftMm !== undefined && Math.abs(r.tabLeftMm - (r.firstAfterTabLeftMm ?? -99)) < 0.01, `tabLeft=${r.tabLeftMm?.toFixed(3)} vs firstAfterTab=${r.firstAfterTabLeftMm?.toFixed(3)}`);
check('E7: Shift+Tab으로 끝에 탭 삽입', r.modelPlainText === '기사 내용입니다\t─ 홍길동 기자\t', `plain="${r.modelPlainText}"`);
check('E8: 커서가 삽입된 탭 뒤', r.cursorOffsetAfterInsert === r.modelPlainText.length, `cursor=${r.cursorOffsetAfterInsert}, len=${r.modelPlainText.length}`);
check('E9: textarea와 model 동기화', r.taValue === r.modelPlainText);

await browser.close();
console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);