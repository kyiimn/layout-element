/**
 * 오버플로(숨김) 라인 커서 진입 금지 클램프 검증.
 *
 * paragraph가 오버플로된 경우 화살표 키 이동(ArrowRight/ArrowDown과 Shift·Ctrl
 * 변형)의 착지 offset이 엔진 `maxVisibleCursorOffset` 경계(첫 오버플로 라인
 * 직전)를 넘지 않는지 검증한다. 오버플로 라인은 렌더에서 span 없이
 * display:none으로 유지되므로(docs/TEXT_ENGINE.md §오버플로 라인 DOM 노드 생략),
 * 커서가 그 영역에 들어가면 커서/선택 렌더의 placement 폴백이 깨진다.
 *
 * 검증 대상:
 * 1. 엔진 경계 — hasOverflow + max ∈ (0, plainText.length)
 * 2. 경계 배치 보장 — 경계 offset의 placement가 실제 visible span rect로 해석
 * 3. ArrowRight 반복 — 경계에서 제자리, 경계 밖에서 도달 후 정지
 * 4. Shift+ArrowRight — selection focus ≤ 경계
 * 5. Ctrl+ArrowRight — 단어 점프도 경계로 클램프
 * 6. ArrowDown — 아래 이동 착지 ≤ 경계, 경계에서 제자리, ArrowUp은 자유 이동
 * 7. 오버플로 해제 — 높이 복원 시 max === -1 (클램프 비활성), 텍스트 끝 도달
 * 8. \n 경계 — 마지막 visible 라인이 endOfBlock이면 경계가 \n 위치
 * 9. Ctrl+End — 문서 끝 이동도 경계로 클램프 (단일 블록 텍스트)
 * 10. End/Shift+End — 커서가 경계 위에 있으면 논리 라인이 오버플로 라인이라
 *     그 끝(숨김 영역)에 착지하는 케이스를 경계로 클램프
 *
 * 스레드 프레임 무영향: 클램프 헬퍼는 isThreadFrame에서 null을 반환해
 * 프레임 경계 이관 경로를 건드리지 않는다 — 회귀 방어는
 * scripts/verify-threading-browser.mjs의 키보드 프레임 경계 이동 시나리오와
 * scripts/verify-threading.mjs가 담당한다.
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-overflow-cursor-clamp.mjs
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5203;

/**
 * 후보 URL이 layout-element의 bench 페이지를 실제로 서빙하는지 검증한다.
 * 타 앱 Vite 서버(SPA fallback)의 200 오탐을 title로 걸러낸다.
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
  const paraBox = window.bench.getParaBox();
  const p = paraBox.querySelector('x-layout-paragraph');
  em.textEditMode = true;
  p.editableText = true;
  await new Promise(r => setTimeout(r, 200));
  const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = { checks: [] };
  const push = (name, ok, detail = '') => out.checks.push({ name, ok, detail });

  const press = async (c, key, init = {}) => {
    c._textarea.focus();
    c._textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    await raf2();
  };

  // ── 오버플로 유도: 높이 5라인 × 3컬럼 = 15라인 용량 < 벤치 텍스트 ──
  paraBox.height = 5;
  p.flushRender();
  await raf2();

  const model = p.model;
  const plain = model.plainText;
  const max = model.maxVisibleCursorOffset;
  push('1. 오버플로 존재 (hasOverflow)', model.hasOverflow === true);
  push('1. 경계가 텍스트 내부 (0 < max < plain.length)', max > 0 && max < plain.length, `max=${max}, len=${plain.length}`);

  // ── 2. 경계 배치 보장: 경계 offset의 커서가 마지막 visible 라인에 그려져야 한다 ──
  em.focusParagraph(p, { cursorOffset: max });
  let c = em.focusedController;
  const placement = c._mapper.getCursorPlacement(max, true) ?? c._mapper.getCursorPlacement(max);
  push('2. 경계 offset에 커서 placement 존재', placement !== null);
  if (placement) {
    const rect = c._mapper.getCharRect(placement.sourceOffset);
    push('2. 경계 placement가 visible span rect로 해석 (숨김 span 아님)', rect !== null && rect.width > 0, `src=${placement.sourceOffset}`);
  }

  // ── 3. ArrowRight 반복: 경계에서 제자리 ──
  for (let i = 0; i < 10; i++) await press(c, 'ArrowRight');
  push('3. 경계에서 ArrowRight ×10 — 제자리 (오버플로 진입 없음)', c._cursorModel.offset === max, `offset=${c._cursorModel.offset}, max=${max}`);
  push("3c. 경계에서 bias 'end' 주차 유지 (crossed 숨김 span 참조 차단)", c._cursorModel.bias === 'end', `bias=${c._cursorModel.bias}`);
  const visH = p.getBoundingClientRect().height / (em.scale || 1);
  push('3d. 경계 커서가 visible 영역 내에 렌더', c._cursorEl.top >= 0 && c._cursorEl.top < visH, `top=${c._cursorEl.top}, visH=${visH}`);

  // ── 3b. 경계 밖에서 도달 후 정지 ──
  em.focusParagraph(p, { cursorOffset: Math.max(0, max - 20) });
  c = em.focusedController;
  c._cursorModel.selection = null;
  for (let i = 0; i < 40; i++) await press(c, 'ArrowRight');
  push('3b. max-20에서 ArrowRight ×40 — 경계 도달 후 정지', c._cursorModel.offset === max, `offset=${c._cursorModel.offset}, max=${max}`);

  // ── 4. Shift+ArrowRight: selection focus가 경계를 넘지 않음 ──
  em.focusParagraph(p, { cursorOffset: Math.max(0, max - 2) });
  c = em.focusedController;
  c._cursorModel.selection = null;
  for (let i = 0; i < 5; i++) await press(c, 'ArrowRight', { shiftKey: true });
  const sel = c._cursorModel.selection;
  const selMax = sel ? Math.max(sel.anchor.textOffset, sel.focus.textOffset) : -1;
  push('4. Shift+ArrowRight ×5 — selection focus ≤ 경계', sel !== null && selMax <= max, `focus=${selMax}, max=${max}`);

  // ── 5. Ctrl+ArrowRight: 단어 점프도 클램프 + 이후 Right 수렴 확인 ──
  em.focusParagraph(p, { cursorOffset: 5 });
  c = em.focusedController;
  c._cursorModel.selection = null;
  for (let i = 0; i < 30; i++) await press(c, 'ArrowRight', { ctrlKey: true });
  const afterCtrl = c._cursorModel.offset;
  for (let i = 0; i < 10; i++) await press(c, 'ArrowRight');
  push('5. Ctrl+ArrowRight ×30 + Right ×10 — 경계 수렴 (점프도 ≤ 경계)', afterCtrl <= max && c._cursorModel.offset === max, `afterCtrl=${afterCtrl}, final=${c._cursorModel.offset}, max=${max}`);

  // ── 6. ArrowDown ──
  em.focusParagraph(p, { cursorOffset: Math.max(0, max - 3) });
  c = em.focusedController;
  c._cursorModel.selection = null;
  for (let i = 0; i < 5; i++) await press(c, 'ArrowDown');
  push('6. ArrowDown ×5 — 착지 ≤ 경계', c._cursorModel.offset <= max, `offset=${c._cursorModel.offset}, max=${max}`);

  em.focusParagraph(p, { cursorOffset: max });
  c = em.focusedController;
  for (let i = 0; i < 3; i++) await press(c, 'ArrowDown');
  push('6b. 경계에서 ArrowDown ×3 — 제자리', c._cursorModel.offset === max, `offset=${c._cursorModel.offset}, max=${max}`);

  await press(c, 'ArrowUp');
  push('6c. ArrowUp — 위 방향은 자유 이동 (마지막 visible 라인으로)', c._cursorModel.offset < max && c._cursorModel.offset >= 0, `offset=${c._cursorModel.offset}, max=${max}`);

  // ── 7. 오버플로 해제: 클램프 비활성 ──
  paraBox.height = 500;
  p.flushRender();
  await raf2();
  push('7. 높이 복원 — max === -1 (클램프 비활성)', p.model.maxVisibleCursorOffset === -1, `max=${p.model.maxVisibleCursorOffset}`);
  em.focusParagraph(p, { cursorOffset: Math.max(0, plain.length - 3) });
  c = em.focusedController;
  c._cursorModel.selection = null;
  for (let i = 0; i < 10; i++) await press(c, 'ArrowRight');
  push('7b. 오버플로 없음 — 텍스트 끝까지 이동 (클램프 미개입)', c._cursorModel.offset === plain.length, `offset=${c._cursorModel.offset}, len=${plain.length}`);

  // ── 8. \n 경계: 마지막 visible 라인이 endOfBlock이면 경계가 \n 위치 ──
  // 단일 컬럼 + 높이 28mm(6라인: 4.8×6 − 0.8) — 블록 7개 중 6 visible, 7th 오버플로.
  const d = p.data;
  d.content = '가가가\n나나나\n다다다\n라라라\n마마마\n바바바\n사사사';
  p.data = d;
  p.column = 1;
  paraBox.height = 28;
  p.flushRender();
  await raf2();
  const model8 = p.model;
  const max8 = model8.maxVisibleCursorOffset;
  const diag8 = `parentH=${model8.inheritStyle?.parentHeight}, fs=${model8.fontSize}, lh=${model8.baseLineHeight}`
    + `, lines=${JSON.stringify(model8.columnContents.map(c => c.length))}, vis=${model8.visibleChars}, ovf=${model8.overflow}`;
  // 블록당 4자(3+\n) × 6 visible = 24, plain[23] === '\n' → 경계 23.
  // 주의: 블록 라인 경로에서는 엔진 `_overflow`(문자 카운트)가 증가하지 않는다 —
  // 오버플로 라인은 columnContents에 데이터가 포함되고 라인 높이 기준으로 감지한다
  // (TEXT_ENGINE.md §오버플로 라인 DOM 노드 생략). 그러므로 hasOverflow가 아니라
  // 구조 불변식으로 단언한다.
  push('8. 오버플로 구조 — 6 visible 블록(18자) + overflow 라인 포함 7 라인 (진단: ' + diag8 + ')',
    model8.visibleChars === 18
      && model8.columnContents.length === 1
      && model8.columnContents[0].length === 7);
  push('8. \\n 경계 — max가 \\n 위치(23)', max8 === 23, `max=${max8}, len=${model8.plainText.length}, plain[max]='${model8.plainText[max8]}'`);
  em.focusParagraph(p, { cursorOffset: max8 });
  c = em.focusedController;
  for (let i = 0; i < 5; i++) await press(c, 'ArrowRight');
  push('8b. \\n 경계에서 ArrowRight ×5 — 제자리', c._cursorModel.offset === max8, `offset=${c._cursorModel.offset}, max=${max8}`);

  // ── 9. Ctrl+End: 단일 블록 텍스트에서 문서 끝 = 오버플로 영역 → 경계 클램프 ──
  // 단일 컬럼(~371mm)에 100자/라인 → 1000자 = 9라인 > 높이 28mm(6라인 용량) → 오버플로.
  const d9 = p.data;
  d9.content = '가'.repeat(1000);
  p.data = d9;
  p.flushRender();
  await raf2();
  const model9 = p.model;
  const max9 = model9.maxVisibleCursorOffset;
  const len9 = model9.plainText.length;
  push('9. 오버플로 유지 (진단: lines=' + JSON.stringify(model9.columnContents.map(cc => cc.length)) + ', max=' + max9 + ', len=' + len9 + ')', max9 > 0 && max9 < len9);
  em.focusParagraph(p, { cursorOffset: 2 });
  c = em.focusedController;
  c._cursorModel.selection = null;
  await press(c, 'End', { ctrlKey: true });
  push('9b. Ctrl+End — 경계로 클램프 (텍스트 끝 금지)', c._cursorModel.offset === max9, `offset=${c._cursorModel.offset}, max=${max9}`);
  em.focusParagraph(p, { cursorOffset: 2 });
  c = em.focusedController;
  c._cursorModel.selection = null;
  await press(c, 'End', { ctrlKey: true, shiftKey: true });
  const sel9 = c._cursorModel.selection;
  const sel9Max = sel9 ? Math.max(sel9.anchor.textOffset, sel9.focus.textOffset) : -1;
  push('9c. Shift+Ctrl+End — selection ≤ 경계', sel9 !== null && sel9Max <= max9, `focus=${sel9Max}, max=${max9}`);

  // ── 10. End/Shift+End: 경계 위 커서의 논리 라인이 오버플로 라인 → 클램프 ──
  em.focusParagraph(p, { cursorOffset: max9 });
  c = em.focusedController;
  await press(c, 'End');
  push('10. 경계에서 End — 제자리 (오버플로 라인 끝 금지)', c._cursorModel.offset === max9, `offset=${c._cursorModel.offset}, max=${max9}`);
  em.focusParagraph(p, { cursorOffset: max9 - 5 });
  c = em.focusedController;
  c._cursorModel.selection = null;
  for (let i = 0; i < 5; i++) await press(c, 'ArrowRight');
  await press(c, 'End');
  push('10b. max-5 + Right ×5 + End — 경계에서 정지 (오버플로 라인 끝 착지 없음)', c._cursorModel.offset === max9, `offset=${c._cursorModel.offset}, max=${max9}`);
  em.focusParagraph(p, { cursorOffset: Math.max(0, max9 - 3) });
  c = em.focusedController;
  c._cursorModel.selection = null;
  await press(c, 'End', { shiftKey: true });
  const sel10 = c._cursorModel.selection;
  const sel10Max = sel10 ? Math.max(sel10.anchor.textOffset, sel10.focus.textOffset) : -1;
  push('10c. Shift+End — selection ≤ 경계', sel10 !== null && sel10Max <= max9, `focus=${sel10Max}, max=${max9}`);

  if (em.focusedController) em.focusedController.blur();
  return out;
});

for (const chk of r.checks) {
  check(chk.name, chk.ok, chk.detail ?? '');
}

await browser.close();
if (server) server.kill();
console.log(failures.length === 0 ? `\nALL PASS (${r.checks.length} checks)` : `\n${failures.length} FAILURES`);
if (failures.length > 0) process.exit(1);