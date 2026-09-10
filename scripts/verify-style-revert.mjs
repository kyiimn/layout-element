/**
 * 인라인 스타일 상속 회귀(regression) 주입의 범위 정확성 검증.
 *
 * `_applyTextStyle`이 문단 상속값과 동일한 값을 주입받을 때(회귀 주입),
 * 적용 범위가 편집 상태에 맞는지 검증한다:
 *   - selection 경로: 선택 범위만 회귀 — 선택 밖 런의 오버라이드는 보존되어야 한다.
 *     (버그 이력: 전체 런 맵에서 필드가 제거되어 "문단 fontSize 4, 런 fontSize 6"
 *     상태에서 런 일부에 4를 주입하면 런 전체가 기본으로 되돌려졌음)
 *   - selection 없음 (커서 위치와 무관, 캐스케이드 통일): 전체 런 회귀
 *     (기본 복원 — 의도적 동작). 구 규칙(커서가 런 안이면 그 런만)은 제거되었다 —
 *     `isCascadePath = !hasSelection`로 통일되었다 (docs/EDITING_TEXT.md §6A).
 *
 * 모든 인라인 필드(fontFamily/fontSize/fontWeight/fontStyle/color/
 * letterSpacing/widthRatio/spaceRatio)에 대해 동일 결함이 없는지 확인한다.
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-style-revert.mjs
 * ```
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5201;

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
  const { SelectionRange } = await import('/src/types/edit/selection.type');

  // 문단 자체 스타일: 기본 상속값과 동일하게 (회귀 판정 조건)
  // bench doc 상속: fontSize 4, fontFamily 중앙신문명조, fontWeight 400, fontStyle normal
  const inheritStyle = p.model.inheritStyle;
  const out = { inherit: { fontSize: inheritStyle.fontSize, fontWeight: inheritStyle.fontWeight, fontStyle: inheritStyle.fontStyle } };

  /**
   * 필드별 회귀 주입 시나리오를 실행하고 런 맵 상태를 반환한다.
   * @param {string} field - 인라인 필드명
   * @param {*} runValue - 런에 줄 오버라이드 값 (inherit과 다른 값)
   * @param {*} paragraphValue - 문단 자체 스타일에 명시할 값 (inherit과 동일해야 회귀 판정)
   */
  const scenario = async (field, runValue, paragraphValue) => {
    p.content = '가나다라마바사아자차카타파하';
    p.textStyle = { [field]: paragraphValue };
    p.flushRender();
    await wait2();
    em.focusParagraph(p);
    await new Promise(r => setTimeout(r, 200));
    const controller = em._focusedController;
    const runs = () => controller._runMap.map(r => ({ start: r.start, end: r.end, style: { ...r.style } }));

    // 런 A [0,5) field=runValue, 런 B [10,13) fontWeight 700 (무관 필드 보존 확인용)
    em.focusParagraph(p, { selection: SelectionRange.fromOffsets(0, 5) });
    em.applyInlineStyle({ [field]: runValue });
    await wait2();
    em.focusParagraph(p, { selection: SelectionRange.fromOffsets(10, 13) });
    em.applyInlineStyle({ fontWeight: 700 });
    await wait2();
    const before = runs();

    // ── 시나리오 1: selection [1,3)에 회귀 값 주입 ──
    em.focusParagraph(p, { selection: SelectionRange.fromOffsets(1, 3) });
    em.applyTextStyle({ [field]: paragraphValue });
    await wait2();
    const afterSel = runs();
    const selResult = {
      // 선택 밖 런 A [3,5)의 runValue 보존
      runARestKept: afterSel.some(r => r.style?.[field] === runValue && r.start < 5 && r.end > 3),
      // [1,3) 영역이 회귀(필드 없음 또는 기본) — fontSize 4 주입 후 필드 제거 확인
      selectedReverted: !afterSel.some(r => r.start >= 1 && r.end <= 3 && r.style?.[field] === runValue),
      // 런 B fontWeight 보존
      runBKept: afterSel.some(r => r.style?.fontWeight === 700),
    };

    // ── 시나리오 2: selection 없음 (캐스케이드 통일) — 커서가 런 안 [4)에 있어도 ──
    // 구 규칙(런 단위 "그 런만" 회귀)은 제거되었다 — selection 없으면 커서 위치와
    // 무관하게 paragraph 전역 적용(캐스케이드)이 의도적 동작이다
    // (docs/EDITING_TEXT.md §6A: isCascadePath = !hasSelection).
    // setCursor는 selection을 clear하지 않으므로, 실사용(키보드 커서 이동)과
    // 동일하게 selection을 먼저 clear한다 — clear 없이는 분기 1(selection 경로)이
    // 우선 실행되어 시나리오 2의 전제가 깨진다.
    em.focusParagraph(p);
    await new Promise(r => setTimeout(r, 50));
    const controller2 = em._focusedController;
    controller2._cursorModel.selection = null;
    controller2._syncTextareaSelection();
    controller2.setCursor({ textOffset: 4 });
    await wait2();
    em.applyTextStyle({ [field]: paragraphValue });
    await wait2();
    const afterCursor = runs();
    // field === 'fontWeight'이면 회귀 주입 대상 필드와 런 B 마커가 동일 필드이므로
    // 전체 캐스케이드 회귀가 런 B까지 정리하는 것은 의도적 동작이다 — 보존 기대를
    // 적용할 수 없다 (이 경우 마커 검증은 다른 필드 테스트가 커버한다).
    const cursorResult = {
      // 캐스케이드 회귀: 전체 런에서 필드 제거 (의도적 기본 복원 — 커서가 런 안이어도 동일)
      allReverted: !afterCursor.some(r => r.style?.[field] === runValue),
      // 무관 필드 런 B fontWeight 보존 — 회귀 주입은 명시된 필드만 건드린다
      // (field === fontWeight 제외: 마커 자체가 회귀 대상 필드이므로)
      runBKept: field === 'fontWeight'
        ? !afterCursor.some(r => r.style?.fontWeight === 700)
        : afterCursor.some(r => r.style?.fontWeight === 700),
    };

    // ── 시나리오 3: 캐스케이드 (커서 런 밖) 회귀 주입 — 전체 회귀 (의도) ──
    // 런 재구성 후 — 시나리오 2와 상태를 공유하지 않는다 (runValue 런 잔존이
    // allReverted 검사를 오염시킨다). selection을 clear하고 커서를 런 밖에 둔다.
    p.content = '가나다라마바사아자차카타파하';
    p.textStyle = { [field]: paragraphValue };
    p.flushRender();
    await wait2();
    em.focusParagraph(p);
    await new Promise(r => setTimeout(r, 200));
    em.focusParagraph(p, { selection: SelectionRange.fromOffsets(0, 5) });
    em.applyInlineStyle({ [field]: runValue });
    await wait2();
    em.focusParagraph(p);
    await new Promise(r => setTimeout(r, 50));
    const controller3 = em._focusedController;
    controller3._cursorModel.selection = null;
    controller3.setCursor({ textOffset: 7 });
    await wait2();
    em.applyTextStyle({ [field]: paragraphValue });
    await wait2();
    const afterCascade = controller3._runMap;
    const cascadeResult = {
      // 캐스케이드 회귀는 전체 런에서 필드 제거 (의도적 기본 복원)
      allReverted: !afterCascade.some(r => r.style?.[field] === runValue),
    };

    return { field, before, selResult, cursorResult, cascadeResult };
  };

  // bench 상속값 확인 후 필드별 시나리오 (inherit과 동일한 paragraphValue = 회귀 판정)
  out.tests = [];
  // fontSize: inherit 4 → run 6, paragraph 4
  out.tests.push(await scenario('fontSize', 6, inheritStyle.fontSize));
  // fontWeight: inherit 400 → run 700, paragraph 400
  out.tests.push(await scenario('fontWeight', 700, inheritStyle.fontWeight));
  // fontStyle: inherit normal → run italic, paragraph normal
  out.tests.push(await scenario('fontStyle', 'italic', inheritStyle.fontStyle));
  // color: inherit는 빈값일 수 있음 — 문단에 명시 후 런에 다른 값, 회귀는 그 값
  out.tests.push(await scenario('color', 'red', inheritStyle.color ?? ''));
  // letterSpacing: inherit -0.1 → run 0.2, paragraph -0.1 (인라인 오버라이드 가능 필드)
  out.tests.push(await scenario('letterSpacing', 0.2, inheritStyle.letterSpacing ?? -0.1));
  // widthRatio: inherit 0.8 → run 1.0, paragraph 0.8
  out.tests.push(await scenario('widthRatio', 1.0, inheritStyle.widthRatio ?? 0.8));
  // spaceRatio: inherit 0.5 → run 0.25, paragraph 0.5
  out.tests.push(await scenario('spaceRatio', 0.25, inheritStyle.spaceRatio ?? 0.5));

  // 원상 복원
  p.textStyle = {};
  p.content = '가나다라마바사';
  p.flushRender();

  return out;
});

for (const t of r.tests) {
  check(`${t.field}: selection 회귀 — 선택 밖 런 오버라이드 보존`, t.selResult.runARestKept);
  check(`${t.field}: selection 회귀 — 선택 영역만 기본 복원`, t.selResult.selectedReverted);
  check(`${t.field}: selection 회귀 — 무관 필드(fontWeight) 런 보존`, t.selResult.runBKept);
  check(`${t.field}: 캐스케이드(커서 런 안) 회귀 — 전체 기본 복원 (의도적)`, t.cursorResult.allReverted);
  check(`${t.field}: 캐스케이드(커서 런 안) 회귀 — 무관 필드 런 보존`, t.cursorResult.runBKept);
  check(`${t.field}: 캐스케이드 회귀 — 전체 기본 복원 (의도적)`, t.cascadeResult.allReverted);
}

await browser.close();
if (server) server.kill();
console.log(failures.length === 0 ? `\nALL PASS (${r.tests.length} fields × 6 assertions)` : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);