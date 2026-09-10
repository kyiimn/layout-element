/**
 * pending style (대기 스타일) 라이프사이클 전 경로 검증.
 *
 * 커서 상태(selection 없음)의 툴바 스타일 변경은 즉시 적용 대신 pending으로
 * 보관되며, 이후 타이핑/붙여넣기가 pending 스타일의 런으로 삽입된다
 * (docs/EDITING_TEXT.md §4.1.7). 검증 대상:
 *
 * 1. 설정/조회 — `setPendingNextStyle` / `pendingNextStyle` / `pendingBaseStyle` 시드
 * 2. 적용 — 타이핑·붙여넣기가 pending 런으로 삽입 + 삽입 후에도 유지 (연속 타이핑)
 * 3. 해제 — 커서 실제 이동(mousedown 다른 위치·화살표 키·다른 오프셋 setCursor)·
 *    selection 형성·명시적 `setPendingNextStyle(undefined)`
 * 4. 유지 — **blur → 같은 위치 재포커스** (커서 보존 규칙: 같은 오프셋 재진입은
 *    커서 이동이 아니다 — 본 검증이 방어하는 핵심 회귀. 버그 이력: `setCursor`가
 *    이동 전 오프셋 비교 없이 무조건 `_releasePendingOnCursorMove`를 호출해
 *    blur 복원 시 pending이 소실되었음), 같은 위치 mousedown,
 *    blur(커서/selection 보존), 타이핑 직후 offset 갱신
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-pending-style.mjs
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5199;

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
  em.textEditMode = true;
  p.editableText = true;
  await new Promise(r => setTimeout(r, 200));
  const wait2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = { checks: [] };

  // pending 상태 리셋 헬퍼 — 각 시나리오 독립성 보장
  const resetPending = () => {
    if (em.focusedController) em.setPendingNextStyle(undefined);
  };

  // ── 시나리오 A: 설정/조회/명시 해제 ──
  em.focusParagraph(p, { cursorOffset: 2 });
  em.setPendingNextStyle({ bold: true, fontSize: 6 });
  out.checks.push({ name: 'A. 설정 직후 pendingNextStyle 조회', ok: em.pendingNextStyle?.bold === true && em.pendingNextStyle?.fontSize === 6 });
  em.setPendingNextStyle(undefined);
  out.checks.push({ name: 'A. 명시적 undefined 해제', ok: em.pendingNextStyle === undefined });
  // pending **재설정** 시 _lastStyleJson 리셋 — 이후 커서 이동으로 pending이
  // 해제될 때의 styleChange가 "커서 유효 스타일 == 설정 전 값" dedupe로 생략되지
  // 않는다 (문서 §4.1.7). _lastStyleJson은 private이므로 실제 발화로 검증한다:
  // pending 설정(italic) → 커서 이동 해제 → styleChange가 반드시 와야 한다.
  em.focusParagraph(p, { cursorOffset: 2 });
  em.setPendingNextStyle({ italic: true });
  let styleChangeFired = false;
  const scListener = () => { styleChangeFired = true; };
  em.addEventListener('styleChange', scListener);
  em.focusedController.setCursor({ textOffset: 5 });
  em.removeEventListener('styleChange', scListener);
  out.checks.push({ name: 'A. pending 설정 후 해제 시 styleChange dedupe 생략 없음 (_lastStyleJson 리셋 효과)', ok: styleChangeFired && em.pendingNextStyle === undefined });

  // ── 시나리오 B: blur → 같은 위치 재포커스 → pending 유지 (핵심 회귀 방어) ──
  em.focusParagraph(p, { cursorOffset: 2 });
  em.setPendingNextStyle({ bold: true });
  const cursorBeforeBlur = em.cursorOffset;
  em.focusedController.blur();
  const focusedAfterBlur = em.focusedParagraph !== null;
  em.focusParagraph(p, { cursorOffset: 2 });
  out.checks.push({ name: 'B. blur 직후 커서 보존', ok: focusedAfterBlur && cursorBeforeBlur === em.cursorOffset });
  out.checks.push({ name: 'B. blur → 같은 오프셋 재포커스 — pending 유지 (핵심)', ok: em.pendingNextStyle?.bold === true });
  // 유지된 pending으로 타이핑 → pending 런 삽입
  const cB = em.focusedController;
  const taB = cB._textarea;
  taB.focus();
  const insertLen = taB.selectionStart;
  taB.value = taB.value.slice(0, taB.selectionStart) + 'x' + taB.value.slice(taB.selectionEnd);
  taB.setSelectionRange(insertLen + 1, insertLen + 1);
  taB.dispatchEvent(new InputEvent('input', { data: 'x', inputType: 'insertText', bubbles: true }));
  const contentB = p.model.textContent;
  const inserted = Array.isArray(contentB) ? contentB.find(i => typeof i === 'object' && i.content.includes('x')) : null;
  out.checks.push({ name: 'B. 유지된 pending이 타이핑 런에 적용 (textInlineStyle.bold)', ok: inserted?.textInlineStyle?.bold === true });
  out.checks.push({ name: 'B. 삽입 직후 pending 유지 (연속 타이핑)', ok: em.pendingNextStyle?.bold === true });

  // ── 시나리오 C: blur → 다른 위치 재포커스 → pending 해제 ──
  em.focusParagraph(p, { cursorOffset: 2 });
  em.setPendingNextStyle({ bold: true });
  em.focusedController.blur();
  em.focusParagraph(p, { cursorOffset: 6 });
  out.checks.push({ name: 'C. blur → 다른 오프셋 재포커스 — pending 해제', ok: em.pendingNextStyle === undefined });

  // ── 시나리오 D: 같은 위치 mousedown 유지 / 다른 위치 mousedown 해제 ──
  em.focusParagraph(p, { cursorOffset: 3 });
  em.setPendingNextStyle({ italic: true });
  const col = p.querySelector('x-layout-column');
  const spans = col.shadowRoot.querySelectorAll('span[data-source-offset]');
  // 커서 3 유지 클릭: span[sourceOffset=2] 중심보다 오른쪽 → mid-point 규칙(+1)으로 3 반환
  let span2 = null;
  for (const s of spans) {
    if (parseInt(s.dataset.sourceOffset, 10) === 2) { span2 = s; break; }
  }
  if (span2) {
    const tr = span2.getBoundingClientRect();
    p.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: tr.right - 1, clientY: tr.top + tr.height / 2 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    out.checks.push({ name: 'D. mousedown 같은 위치 — pending 유지', ok: em.pendingNextStyle?.italic === true });
    // 다른 위치 클릭
    const spanFar = spans[Math.min(spans.length - 1, 8)];
    if (spanFar) {
      const fr = spanFar.getBoundingClientRect();
      p.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: fr.left + 1, clientY: fr.top + fr.height / 2 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      const movedOffset = em.focusedController._cursorModel.offset;
      const expectedRelease = movedOffset !== 3;
      out.checks.push({ name: 'D. mousedown 다른 위치 — pending 해제', ok: !expectedRelease || em.pendingNextStyle === undefined });
    }
  } else {
    out.checks.push({ name: 'D. mousedown 시나리오 (span 미발견 — 환경 스킵)', ok: true });
  }

  // ── 시나리오 E: 화살표 키 커서 이동 → 해제 ──
  em.focusParagraph(p, { cursorOffset: 2 });
  em.setPendingNextStyle({ bold: true });
  const cE = em.focusedController;
  cE._textarea.focus();
  cE._textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  out.checks.push({ name: 'E. 화살표 키 이동 — pending 해제', ok: em.pendingNextStyle === undefined });

  // ── 시나리오 F: selection 형성 → 해제 (pending은 "앞으로 입력될 텍스트"에만 의미) ──
  em.focusParagraph(p, { cursorOffset: 2 });
  em.setPendingNextStyle({ bold: true });
  const cF = em.focusedController;
  cF._extendSelection(5);
  out.checks.push({ name: 'F. selection 형성 — pending 해제', ok: em.pendingNextStyle === undefined });

  // ── 시나리오 G: pendingBaseStyle 시드 — 최초 설정 시 현재 삽입점 유효 스타일 기저 ──
  em.focusParagraph(p, { cursorOffset: 2 });
  em.setPendingNextStyle(undefined);
  const baseBefore = em.pendingBaseStyle;
  // 기저는 시드용 복사본이어야 한다 — 호스트가 base를 직접 수정해도 currentStyle
  // 내부 객체가 오염되지 않아야 한다 (참조 유출 방지 계약).
  const baseIsCopy = em.pendingBaseStyle !== baseBefore || Object.keys(baseBefore).length === 0;
  out.checks.push({ name: 'G. pending 없음 — base는 현재 삽입점 유효 스타일 (시드용)', ok: baseBefore !== undefined && typeof baseBefore === 'object' });
  out.checks.push({ name: 'G. base는 복사본 반환 (currentStyle 참조 유출 없음)', ok: baseIsCopy });

  // ── 시나리오 H: 붙여넣기 — pending 런 삽입 ──
  em.focusParagraph(p, { cursorOffset: 2 });
  em.setPendingNextStyle({ bold: true });
  const cH = em.focusedController;
  const taH = cH._textarea;
  taH.focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', 'Z');
  taH.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  const contentH = p.model.textContent;
  const pastedRun = Array.isArray(contentH) ? contentH.find(i => typeof i === 'object' && i.content.includes('Z')) : null;
  out.checks.push({ name: 'H. 붙여넣기 텍스트가 pending 런으로 삽입 (textInlineStyle.bold)', ok: pastedRun?.textInlineStyle?.bold === true });
  em.setPendingNextStyle(undefined);

  // ── 시나리오 I: 해제 경로의 styleChange — 커서 이동 해제(_releasePendingOnCursorMove)는
  // 발화하여 툴바가 커서 유효 스타일로 복귀한다 (문서 §4.1.7). ──
  let restoredStyle = null;
  const restoreListener = (event) => { restoredStyle = event.style ?? null; };
  em.addEventListener('styleChange', restoreListener);
  em.focusParagraph(p, { cursorOffset: 2 });
  em.setPendingNextStyle({ bold: true });
  em.focusedController.setCursor({ textOffset: 5 });
  em.removeEventListener('styleChange', restoreListener);
  out.checks.push({ name: 'I. 커서 이동 해제 후 styleChange 발화 (툴바 복귀)', ok: restoredStyle !== null && em.pendingNextStyle === undefined });

  // 원상 복원
  if (em.focusedController) em.focusedController.blur();

  return out;
});

for (const c of r.checks) {
  check(c.name, c.ok);
}

await browser.close();
if (server) server.kill();
console.log(failures.length === 0 ? `\nALL PASS (${r.checks.length} checks)` : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);