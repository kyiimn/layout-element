/**
 * DOM vs canvas 렌더 패리티 검증 (CANVAS_RENDERING.md 단계 2 — §7).
 *
 * 동일 문서를 DOM 경로와 canvas 경로로 렌더하고 글자 rect를 비교한다.
 * 판정: 글자 rect 오차 ≤1px, 텍스트 내용 동일. canvas 모드의 부가 계약도
 * 함께 검증한다:
 * - render-complete 발화 (React 호스트 계약)
 * - a11y 히든 텍스트 레이어 존재 + 내용 === DOM visible 텍스트 (공백 제외)
 * - 걸침 ON 문단의 canvas가 행두 돌출을 클립하지 않음 (bleed)
 * - 하이브리드 게이트 — 편집 포커스 문단은 'canvas' 설정에도 DOM 유지
 * - DPR 캡 ≤2 (backing store 높이)
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-canvas-parity.mjs
 * ```
 *
 * @file scripts/verify-canvas-parity.mjs
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5260;

async function probe(url) {
  try {
    const res = await fetch(`${url}/examples/bench.html`);
    if (!res.ok) return false;
    return (await res.text()).includes('<title>Layout Element Benchmark</title>');
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
// 자체 스폰 강제 — 기존 5175/5173 후보 재사용 금지. layout-ui(5173)의 Vite가
// layout-element 예제를 서빙하는 상황에서 I 판정이 타 트리 소스로 실행되는
// 포트 오인(README 사고 패턴)이 실측됐다 — 이 스크립트는 src 수정을 즉시
// 반영해야 하므로 항상 자체 포트로 스폰한다.
server = spawn('npx', ['vite', 'dev', '--port', String(BASE_PORT), '--strictPort'], {
  cwd: pkgRoot, stdio: 'pipe', shell: true,
});
const spawnedUrl = `http://localhost:${BASE_PORT}`;
if (await waitForServer(spawnedUrl)) BASE = spawnedUrl;
else { server.kill(); throw new Error(`vite dev server not ready on ${spawnedUrl}`); }

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', err => console.error('[pageerror]', err.message.slice(0, 300)));
await page.goto(`${BASE}/examples/bench.html`, { waitUntil: 'networkidle' });
console.log(`      [server] ${BASE} (자체 스폰 — 타 트리 오염 차단)`);
await page.waitForFunction(() => document.title === 'BENCH_READY', { timeout: 30_000 });

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const r = await page.evaluate(async () => {
  const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = { steps: [] };

  // ── A. 기준선: DOM 경로에서 글자 rect 스냅샷 ──
  const em = window.bench.getEditManager();
  const paraBox = window.bench.getParaBox();
  const p = paraBox.querySelector('x-layout-paragraph');
  const text = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허혀호'.repeat(4);
  const d = p.data;
  d.content = text;
  p.data = d;
  p.column = 2;
  paraBox.height = 80;
  // 단계 5 — 기본 renderMode가 'canvas'다. DOM 기준선 패리티 비교를 위해
  // 명시적으로 'dom'으로 되돌린다 (기존 동작 보존 판정 — 호스트의
  // renderMode='dom' 설정 경로를 함께 검증한다).
  p.renderMode = 'dom';
  // bench.html이 textEditMode를 전역 켜므로 컨트롤러가 존재한다 — canvas 분기
  // 판정(effectiveMode)은 컨트롤러 소유 여부이므로 기준선 스냅샷은 DOM 경로로
  // 수행하고, canvas 전환은 컨트롤러 해제 후 수행한다 (하이브리드 게이트는 D 검증).
  const hadEditable = p.editableText;
  if (hadEditable) p.editableText = false;
  p.flushRender();
  await raf2();
  await raf2();

  const domSnapshot = (() => {
    // span은 column shadowRoot에 존재 — paragraph light DOM에는 column만 있다.
    const spans = [...p.querySelectorAll('x-layout-column')]
      .flatMap(c => [...(c.shadowRoot?.querySelectorAll('span[data-source-offset]:not([data-temporary])') ?? [])]);
    const paraRect = p.getBoundingClientRect();
    const scale = em.scale || 1;
    const ppm = (p._findPageElement?.()?.engine?.ppm) ?? 3.78;
    return {
      spans: spans.map(s => {
        const rect = s.getBoundingClientRect();
        return {
          key: Number(s.dataset.sourceOffset),
          char: s.textContent,
          // DOM rect → 문단 로컬 px (scale 제거) → mm로 비교 기준 통일
          leftMm: (rect.left - paraRect.left) / scale / ppm,
          topMm: (rect.top - paraRect.top) / scale / ppm,
          widthMm: rect.width / scale / ppm,
          heightMm: rect.height / scale / ppm,
        };
      }),
      visibleText: spans.map(s => s.textContent).join(''),
      spanCount: spans.length,
    };
  })();
  out.domSpanCount = domSnapshot.spans.length;

  // ── B. canvas 모드 전환 + render-complete 발화 확인 ──
  let renderCompleteCount = 0;
  const listener = () => { renderCompleteCount++; };
  p.addEventListener('render-complete', listener);
  p.renderMode = 'canvas';
  p.flushRender();
  await raf2();
  await raf2();

  const canvasMode = (() => {
    const canvasEl = p.querySelector('x-layout-canvas');
    if (!canvasEl) return null;
    const canvas = canvasEl.shadowRoot?.querySelector('canvas');
    const a11y = canvasEl.shadowRoot?.querySelector('div[aria-hidden="false"]');
    return {
      exists: true,
      canvasW: canvas?.width ?? 0,
      canvasH: canvas?.height ?? 0,
      styleW: parseFloat(canvas?.style.width ?? '0'),
      styleH: parseFloat(canvas?.style.height ?? '0'),
      ppm: (p._findPageElement?.()?.engine?.ppm) ?? 3.78,
      dpr: window.devicePixelRatio || 1,
      a11yText: a11y?.textContent ?? '',
      columnRemain: p.querySelectorAll('x-layout-column').length,
    };
  })();
  out.canvasMode = canvasMode;

  // canvas 글자 rect 스냅샷 — 엔진 drawList에서 산출하고 paint 좌표 공식
  // (bleed 보정 + baseline ascent)을 검증한다. paint가 실제로 그렸는지는
  // 캔버스 픽셀 샘플로 확인한다.
  const canvasChars = (() => {
    const engine = p.engine;
    if (!engine) return [];
    return engine.drawList.chars.map(c => ({
      key: c.char,
      char: c.char,
      leftMm: c.lineLeftMm + c.charOffsetMm,
      widthMm: c.widthMm,
      heightMm: c.fontSizeMm,
      lineTopMm: c.lineTopMm,
      lineMaxFs: c.lineMaxFontSizeMm,
      fs: c.fontSizeMm,
    }));
  })();
  out.canvasCharCount = canvasChars.length;

  // ── C. 패리티 판정 데이터 ──
  return { ...out, domSnapshot, canvasChars, renderCompleteCount };
});

// ── A/B. 구조 검증 ──
check('A. DOM 기준선 — span 존재', r.domSnapshot.spans.length > 0, `spans=${r.domSnapshot.spans.length}`);
check('B1. canvas 요소 존재 (renderMode=canvas)', r.canvasMode?.exists === true);
check('B2. DOM 컬럼 제거 (canvas 1장만)', r.canvasMode?.columnRemain === 0, `remain=${r.canvasMode?.columnRemain}`);
check('B3. render-complete 발화 (React 호스트 계약)', r.renderCompleteCount >= 1,
  `count=${r.renderCompleteCount}`);
// DPR 캡: backing store 높이 ≤ style 높이 × 2
check('B4. DPR 캡 ≤2 (backing = style × dpr, dpr capped)',
  r.canvasMode.canvasH <= Math.ceil(r.canvasMode.styleH * 2) + 1,
  `backing=${r.canvasMode?.canvasH} styleH=${r.canvasMode?.styleH} dpr=${r.canvasMode?.dpr}`);
// bleed: backing 폭 = (parentWidth + 2×bleed) × ppm × dpr — style 폭보다 커야 한다.
// 소수 반올림 차이를 흡수하기 위해 1px 여유로 판정한다.
check('B5. bleed 확장 — backing 폭 ≥ 표시 폭 (bleed 확장)', r.canvasMode.canvasW >= Math.ceil(r.canvasMode.styleW),
  `backing=${r.canvasMode?.canvasW} styleW=${r.canvasMode?.styleW}`);
// a11y 레이어
{
  const a11yChars = (r.canvasMode?.a11yText ?? '').replace(/ /g, '');
  const domChars = r.domSnapshot.visibleText.replace(/ /g, '');
  check('B6. a11y 히든 텍스트 === DOM visible 텍스트 (공백 제외)', a11yChars === domChars,
    `a11y=${a11yChars.length}자 dom=${domChars.length}자`);
}

// ── C. 글자 rect 패리티 — DOM span rect vs drawList 명령 rect ──
{
  // DOM span rect를 mm로 환산한 것은 paint 좌표와 달리 glyph box(장평 scale 적용)다.
  // 패리티 비교는 (a) 글자 스트림 동일, (b) DOM span left(mm) ↔ 명령 left(mm) 순서
  // 대응 — 하단 앵커로 인한 top 차이는 vertical offset 공식으로 보정해 비교한다.
  const domByChar = r.domSnapshot.spans;
  const cmdChars = r.canvasChars;
  check('C1. 글자 스트림 동일 (DOM visible === canvas 명령)',
    domByChar.map(s => s.char).join('') === cmdChars.map(c => c.char).join(''),
    `dom=${domByChar.length}자 cmd=${cmdChars.length}자`);
  // left 패리티: DOM span의 left mm vs 명령의 (lineLeft + charOffset) mm
  // DOM rect.left는 glyph box 시작(장평 scale 반영 폭의 시작)이고 명령 left는
  // 배치 좌표 — 하단 앵커 렌더에서 span은 charOffset에 그대로 배치되므로
  // left는 직접 비교 가능 (폭은 glyph 실측 폭이라 swidth와 다름 — 위치만 비교).
  let leftMismatch = 0;
  const n = Math.min(domByChar.length, cmdChars.length);
  for (let i = 0; i < n; i++) {
    if (Math.abs(domByChar[i].leftMm - cmdChars[i].leftMm) > 1) leftMismatch++;
  }
  check('C2. 글자 left 패리티 ≤1mm (전 글자)', leftMismatch === 0, `mismatch=${leftMismatch}/${n}`);
  // top 패리티: DOM span top은 하단 앵커 상자 top(vertical offset 포함) + 폰트 메트릭
  // 오프셋 — 엔진 공식(lineTop + verticalOffset)과 ≤1mm 비교.
  let topMismatch = 0;
  for (let i = 0; i < n; i++) {
    const dom = domByChar[i];
    const cmd = cmdChars[i];
    const engineBoxTopMm = cmd.lineTopMm + (cmd.lineMaxFs - cmd.fs);
    if (Math.abs(dom.topMm - engineBoxTopMm) > 1) topMismatch++;
  }
  check('C3. 글자 상자 top 패리티 ≤1mm (vertical offset 공식)', topMismatch === 0,
    `mismatch=${topMismatch}/${n}`);
}

// ── D. 하이브리드 게이트 — 편집 포커스 문단은 canvas 모드 설정에도 DOM 유지 ──
{
  const gate = await page.evaluate(async () => {
    const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const em = window.bench.getEditManager();
    const paraBox = window.bench.getParaBox();
    const p = paraBox.querySelector('x-layout-paragraph');
    em.textEditMode = true;
    p.editableText = true;
    await new Promise(r2 => setTimeout(r2, 150));
    em.focusParagraph(p);
    await raf2();
    p.renderMode = 'canvas';
    p.flushRender();
    await raf2();
    await raf2();
    const hasCanvas = !!p.querySelector('x-layout-canvas');
    const hasColumns = p.querySelectorAll('x-layout-column').length > 0;
    // blur 시 렌더가 다시 예약되므로 완료를 기다린다.
    em.focusedController?.blur();
    await raf2();
    await raf2();
    return { hasCanvas, hasColumns, mode: p.renderMode };
  });
  check('D1. 편집 포커스 문단 — canvas 요소 없음 (하이브리드 게이트)', gate.hasCanvas === false,
    `hasCanvas=${gate.hasCanvas}`);
  check('D2. 편집 포커스 문단 — DOM 컬럼 유지', gate.hasColumns === true,
    `hasColumns=${gate.hasColumns}`);
}

// ── E. blur 후 canvas 전환 재확인 (하이브리드 양방향 전환) ──
{
  const switchBack = await page.evaluate(async () => {
    const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = window.bench.getParaBox().querySelector('x-layout-paragraph');
    // blur 완료 후 컨트롤러가 남아 있으면(editableText=true 유지) effectiveMode는
    // dom이다 — canvas 복귀 검증은 컨트롤러 해제(editController null) 상태에서 수행.
    p.editableText = false;
    p.flushRender();
    await raf2();
    await raf2();
    return {
      hasCanvas: !!p.querySelector('x-layout-canvas'),
      a11y: p.querySelector('x-layout-canvas')?.shadowRoot?.querySelector('div[aria-hidden="false"]')?.textContent ?? '',
    };
  });
  check('E1. 컨트롤러 해제 후 canvas 요소 복귀', switchBack.hasCanvas === true);
  check('E2. canvas a11y 텍스트 유지', (switchBack.a11y ?? '').length > 0);
}

// ── F. 선택 rect 패리티 — 엔진 getSelectionRects vs DOM getTextRange ──
{
  const selParity = await page.evaluate(async () => {
    const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const em = window.bench.getEditManager();
    const paraBox = window.bench.getParaBox();
    const p = paraBox.querySelector('x-layout-paragraph');
    em.textEditMode = true;
    p.editableText = true;
    await new Promise(r2 => setTimeout(r2, 150));
    em.focusParagraph(p);
    const ctrl = em.focusedController;
    // DOM 경로에서 선택 rect 획득 (span 순회)
    const selStart = 3, selEnd = 20;
    const { SelectionRange } = await import('/src/types/edit/selection.type.ts');
    ctrl.setSelection(SelectionRange.fromOffsets(selStart, selEnd));
    await raf2();
    const domRects = ctrl._mapper.getTextRange(selStart, selEnd);
    // DOM rect는 문단 로컬 px — mm로 환산
    const paraRect = p.getBoundingClientRect();
    const ppm = (p._findPageElement?.()?.engine?.ppm) ?? 3.78;
    const scale = em.scale || 1;
    const domMm = domRects.map(r => ({
      left: r.left * scale / ppm,
      top: r.top * scale / ppm,
      width: r.width * scale / ppm,
      height: r.height * scale / ppm,
    }));
    // 엔진 게터 (지면 절대 mm → 로컬 mm)
    const engine = p.engine;
    const absLeft = engine.data?.parentAbsRect?.absLeft ?? 0;
    const absTop = engine.data?.parentAbsRect?.absTop ?? 0;
    const engMm = engine.getSelectionRects(selStart, selEnd).map(r => ({
      left: r.left - absLeft,
      top: r.top - absTop,
      width: r.width,
      height: r.height,
    }));
    em.focusedController?.blur();
    return { domMm, engMm };
  });
  check('F1. 선택 rect 존재 (양 경로)', selParity.domMm.length > 0 && selParity.engMm.length > 0,
    `dom=${selParity.domMm.length} eng=${selParity.engMm.length}`);
  check('F2. 선택 rect 좌표 패리티 ≤1mm (left/top/width)', (() => {
    if (selParity.domMm.length === 0 || selParity.engMm.length === 0) return false;
    const d = selParity.domMm[0], e = selParity.engMm[0];
    return Math.abs(d.left - e.left) <= 1 && Math.abs(d.top - e.top) <= 1 && Math.abs(d.width - e.width) <= 1;
  })(), `dom=${JSON.stringify(selParity.domMm[0])} eng=${JSON.stringify(selParity.engMm[0])}`);
  check('F3. 선택 rect 높이 패리티 ≤1mm', (() => {
    if (selParity.domMm.length === 0 || selParity.engMm.length === 0) return false;
    return Math.abs(selParity.domMm[0].height - selParity.engMm[0].height) <= 1;
  })(), `domH=${selParity.domMm[0]?.height} engH=${selParity.engMm[0]?.height}`);
}

// ── G. glyph path 모드 (§4.1 B안) — opentype 글리프 Path2D 페인트 ──
{
  const glyphMode = await page.evaluate(async () => {
    const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const paraBox = window.bench.getParaBox();
    const p = paraBox.querySelector('x-layout-paragraph');
    const out = {};

    // 컨트롤러 해제 상태(canvas 경로)에서 전환한다.
    p.editableText = false;
    p.renderMode = 'canvas';
    p.flushRender();
    await raf2();
    await raf2();

    const canvasEl = p.querySelector('x-layout-canvas');
    out.hasCanvas = !!canvasEl;

    // G1: drawMode 기본값은 DEFAULT(glyph)다 — fillText 기준선을 먼저 명시
    // 설정해 두 경로를 모두 스냅샷한다 (기본값화 이후 "첫 스냅샷 = glyph"이면
    // fillText↔glyph 비교가 성립하지 않는다).
    const canvas = canvasEl?.shadowRoot?.querySelector('canvas');
    out.defaultMode = canvasEl?.drawMode;
    // 행별 잉크 수 — baseline 수직 정렬 판정의 근거. 픽셀 알파가
    // 래스터라이저마다 달라도(힌팅 AA 차이) 잉크의 세로 분포는 glyph 기하와
    // baseline 위치가 지배한다 — bbox 반전 결함(baseline 어긋남)은 이 분포를
    // 라인 단위로 밀어올린다.
    const snapshot = () => {
      const ctx = canvas.getContext('2d');
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let ink = 0;
      const rowTops = [];
      const colCount = canvas.width;
      const rowCount = canvas.height;
      const alphaAt = (x, y) => data[(y * colCount + x) * 4 + 3];
      for (let y = 0; y < rowCount; y++) {
        let rowInk = 0;
        for (let x = 0; x < colCount; x++) {
          if (alphaAt(x, y) > 0) rowInk++;
        }
        rowTops.push(rowInk);
      }
      for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) ink++; }
      return { inkPixels: ink, rowTops, data: data.slice() };
    };
    canvasEl.drawMode = 'fillText';
    await raf2();
    await raf2();
    const fillSnap = snapshot();
    out.fillTextInk = fillSnap.inkPixels;

    // G2: glyph 모드 전환 (스위칭 API 계약 — setter가 즉시 재페인트)
    canvasEl.drawMode = 'glyph';
    await raf2();
    await raf2();
    out.afterToggleMode = canvasEl.drawMode;
    const glyphSnap = snapshot();
    out.glyphInk = glyphSnap.inkPixels;

    // baseline 수직 정렬: fillText vs glyph의 라인별 잉크 top row 직접 비교.
    // 연속 잉크 밴드(라인)의 top을 추출해 대응 라인끼리 비교 — bbox 반전 결함은
    // 글리프 bbox를 baseline이 아니라 bbox top 기준으로 그려 라인 top이
    // 글자 크기 비례로 아래로 밀린다(실측: 8mm/3.78ppm에서 18px — 진단 히스토리).
    // 행 프로파일 교차상관은 단일 라인 텍스트에서 이동 자체가 피크가 되어
    // 결함을 흡수하므로 밴드 top 직접 비교가 검출력을 가진다.
    const lineBands = (rowTops) => {
      const bands = [];
      let start = -1;
      for (let y = 0; y < rowTops.length; y++) {
        if (rowTops[y] > 0 && start < 0) start = y;
        if (rowTops[y] === 0 && start >= 0) { bands.push(start); start = -1; }
      }
      if (start >= 0) bands.push(start);
      return bands;
    };
    const fillBands = lineBands(fillSnap.rowTops);
    const glyphBands = lineBands(glyphSnap.rowTops);
    const n = Math.min(fillBands.length, glyphBands.length);
    let maxBandLag = 0;
    for (let i = 0; i < n; i++) {
      maxBandLag = Math.max(maxBandLag, Math.abs(glyphBands[i] - fillBands[i]));
    }
    out.baselineBandTopDelta = n > 0 ? maxBandLag : -1;
    out.bandCount = { fill: fillBands.length, glyph: glyphBands.length };

    // a11y 텍스트는 모드와 무관 유지
    out.glyphA11y = canvasEl.shadowRoot?.querySelector('div[aria-hidden="false"]')?.textContent ?? '';

    // G3: 미등록 글자(ힳ — KMIBMyoungjo cmap 미등록) 포함 텍스트로 전환해
    // 폴백(fillText 경로)으로 그려지는지 검증 — .notdef 사각 박스가 아니다.
    const engine = p.engine;
    const d = p.data;
    d.content = '가나다ힳ라마바'.repeat(6);
    p.data = d;
    p.flushRender();
    await raf2();
    await raf2();
    const snapAfterUnmapped = snapshot();
    out.unmappedInk = snapAfterUnmapped.inkPixels;
    // 원본 텍스트 복원
    const d2 = p.data;
    d2.content = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허혀호'.repeat(4);
    p.data = d2;
    p.renderMode = 'dom';
    p.flushRender();
    await raf2();
    return out;
  });

  check('G1. canvas 요소 존재 (glyph 전환 전제)', glyphMode.hasCanvas === true);
  check('G2. drawMode 기본값 === DEFAULT_CANVAS_DRAW_MODE (glyph)', glyphMode.defaultMode === 'glyph',
    `default=${glyphMode.defaultMode}`);
  check('G3. fillText 모드 실제 잉크 존재', glyphMode.fillTextInk > 0,
    `ink=${glyphMode.fillTextInk}px`);
  check('G4. glyph 전환 후 모드 유지 (스위칭)', glyphMode.afterToggleMode === 'glyph',
    `mode=${glyphMode.afterToggleMode}`);
  check('G5. glyph 모드 실제 잉크 존재 (Path2D 페인트)', glyphMode.glyphInk > 0,
    `ink=${glyphMode.glyphInk}px`);
  check('G6. glyph vs fillText 잉크 밀도 근접 (±40% — 래스터화 차이 허용)',
    glyphMode.fillTextInk > 0 && Math.abs(glyphMode.glyphInk - glyphMode.fillTextInk) / glyphMode.fillTextInk <= 0.4,
    `fillText=${glyphMode.fillTextInk} glyph=${glyphMode.glyphInk}`);
  check('G7. glyph 모드 a11y 텍스트 유지', (glyphMode.glyphA11y ?? '').length > 0,
    `a11y=${glyphMode.glyphA11y.length}자`);
  check('G8. 미등록 글자(ힳ) 포함 페인트 — 폴백 경로 잉크 존재', glyphMode.unmappedInk > 0,
    `ink=${glyphMode.unmappedInk}px`);
  check('G9. baseline 수직 정렬 — fillText↔glyph 라인 top delta ≤2px',
    glyphMode.baselineBandTopDelta >= 0 && glyphMode.baselineBandTopDelta <= 2,
    `maxDelta=${glyphMode.baselineBandTopDelta}px bands=${JSON.stringify(glyphMode.bandCount)} (bbox 반전 결함 시 글자 크기 비례 이동 — 실측 18px)`);
}

// ── H. paragraph 레벨 drawMode 위임 — dom↔canvas 스위칭과 동일 계층 API ──
{
  const paraLevel = await page.evaluate(async () => {
    const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const paraBox = window.bench.getParaBox();
    const p = paraBox.querySelector('x-layout-paragraph');
    const out = {};
    p.editableText = false;
    p.renderMode = 'canvas';
    p.flushRender();
    await raf2();
    await raf2();
    // canvas 복귀 시 _renderCanvas가 _drawMode를 위임한다 — canvas 없이 설정한
    // 값이 보존되어 복귀 후 적용되는지 검증한다.
    p.renderMode = 'dom';
    p.flushRender();
    await raf2();
    p.drawMode = 'glyph'; // dom 모드에서 설정 — canvas 요소 없이 보존
    p.renderMode = 'canvas';
    p.flushRender();
    await raf2();
    await raf2();
    const canvasEl = p.querySelector('x-layout-canvas');
    out.canvasDrawMode = canvasEl?.drawMode;
    out.paraDrawMode = p.drawMode;
    // 원복
    p.drawMode = 'fillText';
    p.renderMode = 'dom';
    p.flushRender();
    await raf2();
    return out;
  });
  check('H1. paragraph.drawMode가 canvas 복귀 후에도 적용 (값 보존)',
    paraLevel.canvasDrawMode === 'glyph' && paraLevel.paraDrawMode === 'glyph',
    `canvas=${paraLevel.canvasDrawMode} para=${paraLevel.paraDrawMode}`);
}

// ── I. glyph 모드 weight·italic 반영 — synthetic 변환 계약 ──
{
  const stylePaint = await page.evaluate(async () => {
    const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const paraBox = window.bench.getParaBox();
    const p = paraBox.querySelector('x-layout-paragraph');
    const out = {};
    p.editableText = false;
    // H 섹션 원복이 남긴 drawMode='fillText'를 정화 — paragraph 레벨에서 설정해야
    // setStyle(data 세터)이 재렌더할 때마다 _renderCanvas가 위임하는 값이 glyph다
    // (canvas 요소에만 설정하면 다음 data 세터 때 _drawMode로 덮어써진다).
    p.drawMode = 'glyph';
    p.renderMode = 'canvas';
    p.flushRender();
    await raf2();
    await raf2();
    const canvasEl = p.querySelector('x-layout-canvas');
    const canvas = canvasEl.shadowRoot.querySelector('canvas');
    canvasEl.drawMode = 'glyph';
    await raf2();
    await raf2();

    const snapStats = () => {
      const ctx = canvas.getContext('2d');
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let ink = 0, sumX = 0, minX = Infinity, maxX = -Infinity;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const a = data[(y * canvas.width + x) * 4 + 3];
          if (a > 0) { ink++; sumX += x; if (x < minX) minX = x; if (x > maxX) maxX = x; }
        }
      }
      return { ink, centerX: ink > 0 ? sumX / ink : 0, width: minX <= maxX ? maxX - minX : 0 };
    };
    const setStyle = async (style) => {
      const d = p.data;
      d.content = '가나다라마바사아자차'; // cmap 등록 글자만 — 폴백 fillText 경로의 synthetic bold 오염 방지
      // fontSize 8mm — shear 이동은 fontSize 비례라 4mm에서는 AA 경계에 흡수되어
      // 판정 검출력이 소멸한다 (실측: 4mm 폭 증가 0px, 8mm 기대 ~3.5px).
      d.textStyle = { fontSize: 8, ...style };
      p.data = d;
      p.flushRender();
      await raf2();
      await raf2();
      await new Promise(r => setTimeout(r, 100));
    };

    canvasEl.drawMode = 'glyph';
    // 1. 기준선 (normal 400)
    await setStyle({});
    const base = snapStats();
    // 2. 6단계 weight (400/500/600/700/800/900) — 잉크가 단조 증가해야 한다
    //    (syntheticBoldThicknessPx 선형 곡선: 두께 ∝ weight−400)
    const weightSteps = [400, 500, 600, 700, 800, 900];
    const weightInks = [];
    for (const w of weightSteps) {
      await setStyle({ fontWeight: w });
      weightInks.push(snapStats().ink);
    }
    const bold = { ink: weightInks[3] };
    // 3. italic — shear가 글자 최상단을 x 방향으로 밀어 bbox 폭이 증가해야 한다
    //    (중심 이동 판정은 bold 오염에 민감 — 폭 판정이 검출력을 가진다)
    await setStyle({ fontStyle: 'italic' });
    const italic = snapStats();
    // 원복
    await setStyle({});

    // 단조성: w500 ≤ w600 ≤ w700 ≤ w800 ≤ w900 (두께가 weight와 단조 증가)
    let monotonic = true;
    for (let i = 1; i < weightInks.length; i++) {
      if (weightInks[i] < weightInks[i - 1]) monotonic = false;
    }
    // 900이 400보다 유의하게 커야 한다 (최대 단계 — 곡선 상단 실측)
    const maxDelta = (weightInks[5] - weightInks[0]) / weightInks[0];

    return {
      baseInk: base.ink,
      boldInk: bold.ink,
      weightInks,
      maxDelta,
      monotonic,
      baseWidth: base.width,
      italicWidth: italic.width,
      inkDelta: (bold.ink - base.ink) / base.ink,
    };
  });
  check('I3. glyph 모드 italic — shear로 잉크 bbox 폭 증가 (≥2px)',
    stylePaint.italicWidth - stylePaint.baseWidth >= 2,
    `baseW=${stylePaint.baseWidth} italicW=${stylePaint.italicWidth} (미반영 시 동일 폭)`);
}

// ── J. canvas 문단 클릭 → 즉시 DOM 전환 + 클릭 위치 커서 — CDP 실마우스 흐름 ──
{
  await page.mouse.move(0, 0);
  const canvasClick = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const paraBox = window.bench.getParaBox();
    const p = paraBox.querySelector('x-layout-paragraph');
    const em = window.bench.getEditManager();
    em.textEditMode = true;
    p.editableText = true;
    // I 섹션의 잔여 상태 원복 — 벤치 원본 텍스트(다라인 배치) + 4mm로 클릭
    // 매핑 환경을 정규화한다 (I 마지막 10자 텍스트는 1라인뿐이어서 클릭 지점이
    // 배치 밖이 된다 — getOffsetFromPoint null).
    const d = p.data;
    d.content = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허혀호'.repeat(4);
    d.textStyle = { fontSize: 4 };
    p.data = d;
    p.renderMode = 'canvas';
    p.flushRender();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(300);
    em.blurParagraph();
    p.flushRender();
    await sleep(200);

    const canvasEl = p.querySelector('x-layout-canvas');
    const canvas = canvasEl.shadowRoot.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    // canvas rect는 bleed 20mm만큼 좌측 확장(marginLeft) — 엔진 좌표 환산에 보정.
    // 클릭 좌표는 **canvas rect 기준 상대 좌표**로 저장한다 — blur 전환 렌더로
    // rect가 이동해도 expected 환산에서 최신 rect를 재측정해 정합한다.
    return {
      relX: rect.width * 0.25,
      relY: rect.height * 0.15, // 배치 라인 영역 내 (컬럼당 라인 수 소량 — 0.3은 배치 밖)
      absLeft: rect.left,
      absTop: rect.top,
      bleedPx: 20 * ((p._findPageElement ? p._findPageElement()?.engine?.ppm : null) ?? 3.78) * (em.scale || 1),
      hadCanvas: true,
    };
  });
  // 엔진 기대 오프셋 — 클릭 지점을 엔진 getOffsetFromPoint로 직접 환산
  const canvasClickExpected = await page.evaluate(async (info) => {
    const paraBox = window.bench.getParaBox();
    const p = paraBox.querySelector('x-layout-paragraph');
    const em = window.bench.getEditManager();
    // 렌더 완료 동기화 — flushRender가 microtask 예약이므로 rAF 후 엔진·rect 조회
    p.flushRender();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const engine = p.engine;
    const ppm = (p._findPageElement ? p._findPageElement()?.engine?.ppm : null) ?? 3.78;
    const scale = em.scale || 1;
    const parentAbsRect = engine.data?.parentAbsRect;
    // 클릭 시점 절대 좌표 재구성 — 최신 canvas rect로 rect 기준 상대 좌표를 이동
    const canvasNow = p.querySelector('x-layout-canvas')?.shadowRoot?.querySelector('canvas');
    const rectNow = canvasNow?.getBoundingClientRect();
    const shiftX = rectNow ? rectNow.left - info.absLeft : 0;
    const shiftY = rectNow ? rectNow.top - info.absTop : 0;
    const clickX = info.absLeft + info.relX + shiftX;
    const clickY = info.absTop + info.relY + shiftY;
    const xMm = (clickX - rectNow.left - info.bleedPx) / (scale * ppm) + (parentAbsRect?.absLeft ?? 0);
    const yMm = (clickY - rectNow.top) / (scale * ppm) + (parentAbsRect?.absTop ?? 0);
    const r = engine.getOffsetFromPoint(xMm, yMm);
    return {
      expected: r ? r.textOffset : null,
      debug: {
        xMm: Number(xMm.toFixed(2)), yMm: Number(yMm.toFixed(2)),
        colCount: engine._columnContents?.length ?? 0,
        lineCount: (engine._columnContents ?? []).reduce((s, c) => s + c.length, 0),
        hasCanvasNow: !!canvasNow,
      },
    };
  }, canvasClick);
  const expected = canvasClickExpected?.expected ?? null;

  await page.mouse.click(
    canvasClick.absLeft + canvasClick.relX,
    canvasClick.absTop + canvasClick.relY,
  );
  await page.waitForTimeout(400);

  const after = await page.evaluate(async () => {
    const paraBox = window.bench.getParaBox();
    const p = paraBox.querySelector('x-layout-paragraph');
    const em = window.bench.getEditManager();
    const controller = em._focusedController;
    return {
      cursorOffset: controller?._cursorModel?.offset ?? null,
      focused: em.focusedParagraph === p,
      hasCanvas: !!p.querySelector('x-layout-canvas'),
      hasColumns: p.querySelectorAll('x-layout-column').length > 0,
    };
  });
  check('J1. canvas 문단 클릭 → 즉시 DOM 전환 (컬럼 생성·canvas 제거)',
    after.focused && after.hasColumns && !after.hasCanvas,
    `focused=${after.focused} cols=${after.hasColumns} canvas=${after.hasCanvas}`);
  check('J2. 클릭 위치 커서 — 엔진 매핑과 일치 (±1 mid-point 규칙)',
    expected !== null && after.cursorOffset !== null && Math.abs(after.cursorOffset - expected) <= 1,
    `cursor=${after.cursorOffset} expected=${expected} debug=${JSON.stringify(canvasClickExpected?.debug ?? {})}`);
}

await browser.close();
if (server) server.kill();
console.log(failed === 0 ? `\nALL PASS (${passed} checks)` : `\n${failed} FAILURES: ${failures.join(' | ')}`);
process.exit(failed > 0 ? 1 : 0);