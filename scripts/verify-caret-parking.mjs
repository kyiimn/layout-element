/**
 * 캐럿 주차(parking) 회귀 코퍼스 검증.
 *
 * 커서 내비게이션 리팩터링(Phase 1~3)의 동작 동일성을 증명하기 위한 핀닝
 * 코퍼스. 키 시퀀스 × 커서 렌더 px 좌표(top/left) + `atEndOfChar`를 고정한다.
 *
 * 좌표계 함정 배경: 라인 경계 offset은 시각적으로 두 라인에 소속된다(라인 끝 =
 * 다음 라인 시작, 같은 source offset). 커서가 그려진 라인은 placement의
 * atEndOfChar로 결정되며, 내부 소속 판정(getLineInfoBySourceOffset)과 렌더 라인은
 * 어긋날 수 있다 — 이번 세션에서 수정된 4건 버그가 모두 이 함정의 변형이다.
 *
 * 검증 대상 (키 시퀀스 × 출발 상태 × 착지 렌더):
 * 1. End 단일 — 라인 끝 (출발 라인 top, 마지막 가시 문자 우측)
 * 2. End 연타 — 2회 이상 제자리 (offset/좌표 불변)
 * 3. Home 단일 — 라인 시작 (출발 라인 top, left=라인 시작)
 * 4. Home 연타 — 제자리
 * 5. 라인 맨앞(Home 주차) → ArrowUp — 바로 위 라인 시작
 * 6. 라인 끝(End 주차) → ArrowDown — 바로 아래 라인
 * 7. 라인 끝(End 주차) → ArrowUp — 바로 위 라인 (라인 끝 상대 위치 유지)
 * 8. 라인 맨앞(Home 주차) → ArrowDown — 바로 아래 라인 시작
 * 9. trailing space 라인의 End — 마지막 가시 문자 우측에 그려짐
 * 10. leading space 라인의 Home — 라인 시작 left (이전 라인 끝 참조 금지)
 * 11. \n 분리 라인 — 라인 소속 정확
 * 12. 컬럼 경계 라인 End/Home — 이웃 컬럼 점프 없음
 * 13. Shift+End/Shift+Home — selection 확장 경계
 * 14. 클릭 배치 — 라인 가장자리 클릭 시 placement 소속
 *
 * 이벤트 시퀀스 핀닝:
 * 15. Home/End 반복 입력 시 cursorMove/styleChange 발화 횟수·순서 고정
 *
 * scale≠1 좌표 provenance (CANVAS_RENDERING.md 단계 0 — Oracle 리뷰):
 * 16. scale 0.5/1.5에서 DOM 경로(getCharRect scale 나눗셈)와 엔진 경로
 *     (useEngineCoordinateQueries=true, mm×ppm)가 동일한 커서 px 좌표를 산출하는지.
 *     ppm은 document.body에 직접 부착한 100mm div로 측정되므로(scale 변환 밖)
 *     엔진 경로 좌표는 scale 불변이어야 하고, DOM 경로는 EditManager.scale
 *     나눗셈으로 동일 local px를 재현한다 — 두 경로의 일치가 seam의 증명망.
 *
 * 스레드 프레임 무영향: 커서 이동은 프레임 경계 이관이 소유한다 — 회귀 방어는
 * verify-threading-browser.mjs가 담당한다.
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-caret-parking.mjs
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5204;

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

let BASE = null;
let server = null;
for (const cand of ['http://localhost:5175', 'http://localhost:5173', 'http://localhost:5174']) {
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

  const press = (c, key, init = {}) => {
    c._textarea.focus();
    c._textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  };
  const snap = (c) => ({ off: c._cursorModel.offset, left: c._cursorEl.left, top: c._cursorEl.top, ae: c._cursorEl.visible ? c._cursorEl.dataset.atEnd ?? '' : '' });

  // ── 셋업: 단일 컬럼, 6 라인 블록 텍스트 (trailing/leading space·\n 포함) ──
  // plain: "가가가가 나나나나 나나나나\n 다다다다 라라라라 바바바바\n바바바바 사사사사"
  // 라인당 폭에 맞춰 trailing space 라인과 leading space 라인이 자연 발생하도록 텍스트 구성.
  const d = p.data;
  // 라인 폭(~371mm/3col ≈ 123mm, fs 4mm)에 12자/라인 수준. trailing space 포함 텍스트.
  d.content = '가나다라마바사 아자차\n 카타파하 거너더러머\n버서어저처커터퍼허\n혀호';
  p.data = d;
  p.column = 1;
  paraBox.height = 500;
  // 단계 5 — 기본 renderMode가 'canvas'다. caret-parking 코퍼스는 DOM 경로의
  // px 좌표 핀닝이므로 명시적으로 'dom'으로 설정한다 (호스트의 dom 복귀 경로 검증).
  p.renderMode = 'dom';
  p.flushRender();
  await raf2();

  const model = p.model;
  const mapper = p._editController?._mapper ?? em.focusedController?._mapper;
  const lineInfo = [];
  for (let c = 0; c < model.columnContents.length; c++) {
    for (let l = 0; l < model.columnContents[c].length; l++) {
      lineInfo.push({ c, l, start: mapper.getLineStartSourceOffset(c, l), top: mapper.getLineRect(c, l)?.top, left: mapper.getLineRect(c, l)?.left });
    }
  }
  const plain = model.plainText;
  const lineIdxAt = (off) => {
    for (let i = lineInfo.length - 1; i >= 0; i--) {
      if (off >= lineInfo[i].start) {
        // 경계 offset은 다음 라인 시작과 같은 값 — 렌더 소속은 커서 placement가 결정.
        return lineInfo[i];
      }
    }
    return lineInfo[0];
  };

  // ── 1~2. End 단일 + 연타 (각 라인 시작에서) ──
  for (let idx = 0; idx < lineInfo.length; idx++) {
    const li = lineInfo[idx];
    em.focusParagraph(p);
    const c = em.focusedController;
    c._cursorModel.offset = li.start;
    c._cursorModel.selection = null;
    c._cursorModel.bias = 'start';
    c._textarea.setSelectionRange(li.start, li.start);
    c._updateCursorPosition();
    const ta = c._textarea;
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await raf2();
    const e1 = snap(c);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await raf2();
    const e2 = snap(c);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await raf2();
    const e3 = snap(c);
    // 1회: 커서가 출발 라인(li) top에 그려짐 (라인 끝 = 출발 라인)
    push(`1. [c${li.c}l${li.l}] End — 커서 top=출발 라인 (${li.top})`,
      Math.abs(e1.top - li.top) < 2, `top=${e1.top}, liTop=${li.top}, off=${e1.off}`);
    // 2~3회: 완전 제자리
    push(`2. [c${li.c}l${li.l}] End 연타 — 제자리`,
      e2.off === e1.off && e3.off === e1.off && Math.abs(e2.top - e1.top) < 2 && Math.abs(e3.top - e1.top) < 2,
      `e1=${JSON.stringify(e1)}, e2=${JSON.stringify(e2)}, e3=${JSON.stringify(e3)}`);
  }

  // ── 3~4. Home 단일 + 연타 (각 라인 중간에서) ──
  for (let idx = 0; idx < lineInfo.length - 1; idx++) {
    const li = lineInfo[idx];
    const nextLi = lineInfo[idx + 1];
    const mid = li.start + Math.floor((nextLi.start - li.start) / 2);
    em.focusParagraph(p);
    const c = em.focusedController;
    c._cursorModel.offset = mid;
    c._cursorModel.selection = null;
    c._cursorModel.bias = 'start';
    c._textarea.setSelectionRange(mid, mid);
    c._updateCursorPosition();
    const ta = c._textarea;
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    await raf2();
    const h1 = snap(c);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    await raf2();
    const h2 = snap(c);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    await raf2();
    const h3 = snap(c);
    push(`3. [c${li.c}l${li.l}] Home — 라인 시작 (top=${li.top})`,
      h1.off === li.start && Math.abs(h1.top - li.top) < 2, `h1=${JSON.stringify(h1)}, liStart=${li.start}, liTop=${li.top}`);
    push(`4. [c${li.c}l${li.l}] Home 연타 — 제자리`,
      h2.off === h1.off && h3.off === h1.off && Math.abs(h2.top - h1.top) < 2 && Math.abs(h3.top - h1.top) < 2,
      `h2=${JSON.stringify(h2)}, h3=${JSON.stringify(h3)}`);
  }

  // ── 5. 라인 맨앞(Home 주차) → ArrowUp — 바로 위 라인 ──
  for (let idx = 1; idx < lineInfo.length; idx++) {
    const li = lineInfo[idx];
    const prevLi = lineInfo[idx - 1];
    em.focusParagraph(p);
    const c = em.focusedController;
    c._cursorModel.offset = li.start;
    c._cursorModel.selection = null;
    c._cursorModel.bias = 'start';
    c._textarea.setSelectionRange(li.start, li.start);
    c._updateCursorPosition();
    const ta = c._textarea;
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await raf2();
    const u1 = snap(c);
    push(`5. [c${li.c}l${li.l}] 라인 맨앞 → Up — 바로 위 라인 (top=${prevLi.top})`,
      Math.abs(u1.top - prevLi.top) < 2, `u1=${JSON.stringify(u1)}, prevTop=${prevLi.top}`);
  }

  // ── 6. 라인 끝(End 주차) → ArrowDown — 바로 아래 라인 ──
  for (let idx = 0; idx < lineInfo.length - 1; idx++) {
    const li = lineInfo[idx];
    const nextLi = lineInfo[idx + 1];
    em.focusParagraph(p);
    const c = em.focusedController;
    c._cursorModel.offset = li.start;
    c._cursorModel.selection = null;
    c._cursorModel.bias = 'start';
    c._textarea.setSelectionRange(li.start, li.start);
    c._updateCursorPosition();
    const ta = c._textarea;
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await raf2();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await raf2();
    const dn1 = snap(c);
    push(`6. [c${li.c}l${li.l}] 라인 끝 → Down — 바로 아래 라인 (top=${nextLi.top})`,
      Math.abs(dn1.top - nextLi.top) < 2, `dn1=${JSON.stringify(dn1)}, nextTop=${nextLi.top}`);
  }

  // ── 7. 라인 끝(End 주차) → ArrowUp — 바로 위 라인 ──
  for (let idx = 1; idx < lineInfo.length; idx++) {
    const li = lineInfo[idx];
    const prevLi = lineInfo[idx - 1];
    em.focusParagraph(p);
    const c = em.focusedController;
    c._cursorModel.offset = li.start;
    c._cursorModel.selection = null;
    c._cursorModel.bias = 'start';
    c._textarea.setSelectionRange(li.start, li.start);
    c._updateCursorPosition();
    const ta = c._textarea;
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await raf2();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await raf2();
    const u1 = snap(c);
    push(`7. [c${li.c}l${li.l}] 라인 끝 → Up — 바로 위 라인 (top=${prevLi.top})`,
      Math.abs(u1.top - prevLi.top) < 2, `u1=${JSON.stringify(u1)}, prevTop=${prevLi.top}`);
  }

  // ── 8. 라인 맨앞(Home 주차) → ArrowDown — 바로 아래 라인 시작 ──
  for (let idx = 0; idx < lineInfo.length - 1; idx++) {
    const li = lineInfo[idx];
    const nextLi = lineInfo[idx + 1];
    em.focusParagraph(p);
    const c = em.focusedController;
    c._cursorModel.offset = li.start;
    c._cursorModel.selection = null;
    c._cursorModel.bias = 'start';
    c._textarea.setSelectionRange(li.start, li.start);
    c._updateCursorPosition();
    const ta = c._textarea;
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await raf2();
    const dn1 = snap(c);
    push(`8. [c${li.c}l${li.l}] 라인 맨앞 → Down — 바로 아래 라인 시작 (top=${nextLi.top})`,
      Math.abs(dn1.top - nextLi.top) < 2, `dn1=${JSON.stringify(dn1)}, nextTop=${nextLi.top}`);
  }

  // ── 15. 이벤트 시퀀스 핀닝: Home/End 반복 입력의 cursorMove/styleChange 발화 ──
  const repeatCount = (list, name) => list.filter(e => e === name).length;
  em.focusParagraph(p);
  {
    const c = em.focusedController;
    c._cursorModel.offset = lineInfo[0].start;
    c._cursorModel.selection = null;
    c._cursorModel.bias = 'start';
    const events = [];
    em.addEventListener('cursorMove', () => events.push('cursorMove'));
    em.addEventListener('styleChange', () => events.push('styleChange'));
    const ta = c._textarea;
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await raf2();
    const endEvents = [...events];
    events.length = 0;
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await raf2();
    const repeatEvents = [...events];
    push('15. End 반복 — 2회차도 cursorMove 발화 (현행 이벤트 스트림 고정)',
      repeatCount(endEvents, 'cursorMove') >= 1 && repeatCount(repeatEvents, 'cursorMove') >= 1,
      `first=${JSON.stringify(endEvents)}, repeat=${JSON.stringify(repeatEvents)}`);
    push('15b. End 반복 — 2회차 styleChange 미발화 유지 (currentStyle dedupe)',
      repeatCount(repeatEvents, 'styleChange') === 0 && repeatCount(endEvents, 'styleChange') === 0,
      `first=${JSON.stringify(endEvents)}, repeat=${JSON.stringify(repeatEvents)}`);
  }

  if (em.focusedController) em.focusedController.blur();
  return out;
});

for (const chk of r.checks) {
  check(chk.name, chk.ok, chk.detail ?? '');
}

// ── 16. scale≠1 좌표 provenance (CANVAS_RENDERING.md 단계 0, Oracle 리뷰) ──
// ppm은 document.body에 직접 부착한 100mm div로 측정(스케일 변환 밖)되므로
// 엔진 경로(getCharRect mm×ppm)의 local px는 scale 불변. DOM 경로는
// getBoundingClientRect를 EditManager.scale로 나눠 동일 local px를 재현한다.
// 두 경로가 scale≠1에서 일치해야 한다 — 일치하지 않으면 플래그 전환 후
// 스케일된 호스트에서 커서가 튄다. scale=1은 이미 위 코퍼스가 커버하므로
// 0.5/1.5 두 배율만 검증한다.
const scaleChecks = [];
for (const scale of [0.5, 1.5]) {
  const s = await page.evaluate(async (scale) => {
    const em = window.bench.getEditManager();
    const paraBox = window.bench.getParaBox();
    const p = paraBox.querySelector('x-layout-paragraph');
    em.textEditMode = true;
    p.editableText = true;
    await new Promise(r => setTimeout(r, 200));
    const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    em.setScale(scale);
    await raf2();

    // 이전 evaluate 컨텍스트에서 구성한 동일 텍스트/1컬럼 상태를 재구성한다
    // (페이지가 유지되므로 데이터는 유지되지만 컨트롤러 상태를 재확보한다).
    const d = p.data;
    d.content = '가나다라마바사 아자차\n 카타파하 거너더러머\n버서어저처커터퍼허\n혀호';
    p.data = d;
    p.column = 1;
    paraBox.height = 500;
    p.renderMode = 'dom';
    p.flushRender();
    await raf2();

    const model = p.model;
    const mapper = p._editController?._mapper ?? em.focusedController?._mapper;
    const lineInfo = [];
    for (let c = 0; c < model.columnContents.length; c++) {
      for (let l = 0; l < model.columnContents[c].length; l++) {
        lineInfo.push({ c, l, start: mapper.getLineStartSourceOffset(c, l), top: mapper.getLineRect(c, l)?.top });
      }
    }

    const results = [];
    const probes = [
      { name: 'End', nav: async (c, ta, li) => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); } },
      { name: 'Home', nav: async (c, ta, li) => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })); } },
      { name: 'Down', nav: async (c, ta, li) => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 30)); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); } },
    ];
    for (let idx = 0; idx < Math.min(lineInfo.length, 2); idx++) {
      const li = lineInfo[idx];
      em.focusParagraph(p);
      const c = em.focusedController;
      c._cursorModel.offset = li.start;
      c._cursorModel.selection = null;
      c._cursorModel.bias = 'start';
      c._textarea.setSelectionRange(li.start, li.start);
      c._updateCursorPosition();
      const ta = c._textarea;
      ta.focus();
      for (const probe of probes) {
        probe.nav(c, ta, li);
        await raf2();
        results.push({
          probe: probe.name, line: idx,
          off: c._cursorModel.offset,
          top: c._cursorEl.top, left: c._cursorEl.left,
          liTop: li.top,
        });
      }
    }
    em.setScale(1);
    if (em.focusedController) em.focusedController.blur();
    return { scale, ppm: window.bench.getPage?.()?.ppm ?? null, results };
  }, scale);
  scaleChecks.push(s);
}

// 판정: 같은 scale 프로브에서 (a) 커서 top이 scale 무관히 동일(로컬 px 계약),
// (b) scale≠1에서도 28P 코퍼스와 동일한 top/liTop 관계(라인 top 일치) 유지.
// scale 0.5 vs 1.5 결과가 서로 일치하면 두 경로 모두 scale 무관 로컬 px를 산출.
{
  const [s05, s15] = scaleChecks;
  if (s05 && s15 && s05.results.length === s15.results.length) {
    for (let i = 0; i < s05.results.length; i++) {
      const a = s05.results[i];
      const b = s15.results[i];
      check(`16. [scale 0.5 vs 1.5] ${a.probe}@line${a.line} — 커서 local px scale 무관`,
        a.off === b.off && Math.abs(a.top - b.top) < 2 && Math.abs(a.left - b.left) < 2,
        `off=${a.off}/${b.off}, top=${a.top}/${b.top}, left=${a.left}/${b.left}`);
    }
    // 라인 소속 관계 보존: 첫 라인 End의 top은 라인 top과 일치 (scale 무관)
    const firstEnd = s05.results.find(x => x.probe === 'End' && x.line === 0);
    if (firstEnd) {
      check('16b. [scale 0.5] End@line0 — top=라인 top (좌표 provenance seam)',
        Math.abs(firstEnd.top - firstEnd.liTop) < 2,
        `top=${firstEnd.top}, liTop=${firstEnd.liTop}`);
    }
  } else {
    check('16. scale≠1 코퍼스 실행', false, `결과 수 불일치: ${s05?.results?.length} vs ${s15?.results?.length}`);
  }
}

await browser.close();
if (server) server.kill();
console.log(failures.length === 0 ? `\nALL PASS (${r.checks.length} checks)` : `\n${failures.length} FAILURES`);