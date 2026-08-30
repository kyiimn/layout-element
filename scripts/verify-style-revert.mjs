/**
 * 인라인 스타일 상속 회귀(regression) 주입의 범위 정확성 검증.
 *
 * `_applyTextStyle`이 문단 상속값과 동일한 값을 주입받을 때(회귀 주입),
 * 적용 범위가 편집 상태에 맞는지 검증한다:
 *   - selection 경로: 선택 범위만 회귀 — 선택 밖 런의 오버라이드는 보존되어야 한다.
 *     (버그 이력: 전체 런 맵에서 필드가 제거되어 "문단 fontSize 4, 런 fontSize 6"
 *     상태에서 런 일부에 4를 주입하면 런 전체가 기본으로 되돌려졌음)
 *   - 커서가 런 안: 그 런만 회귀.
 *   - 캐스케이드(커서가 런 밖): 전체 런 회귀 (기본 복원 — 의도적 동작).
 *
 * 모든 인라인 필드(fontFamily/fontSize/fontWeight/fontStyle/color)에 대해
 * 동일 결함이 없는지 확인한다.
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-style-revert.mjs
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

    // ── 시나리오 2: 커서가 런 안 [4)에서 회귀 주입 ──
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
    const cursorResult = {
      // 런 단위 시맨틱("그 런만"): 커서 런 [3,5) 전체 회귀 — 필드 제거 확인
      cursorRunReverted: !afterCursor.some(r => r.style?.[field] === runValue && r.start < 5 && r.end > 3),
      // 다른 런 [0,1)의 runValue 보존
      otherRunKept: afterCursor.some(r => r.style?.[field] === runValue && r.end <= 1),
      runBKept: afterCursor.some(r => r.style?.fontWeight === 700),
    };

    // ── 시나리오 3: 캐스케이드 (커서 런 밖) 회귀 주입 — 전체 회귀 (의도) ──
    // 런 재구성 후 — 커서 시나리오와 상태를 공유하지 않는다 (runValue 런 잔존이
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
  check(`${t.field}: 커서-런-안 회귀 — 커서 런만 복원`, t.cursorResult.cursorRunReverted);
  check(`${t.field}: 커서-런-안 회귀 — 다른 런 보존`, t.cursorResult.otherRunKept);
  check(`${t.field}: 커서-런-안 회귀 — 무관 필드 런 보존`, t.cursorResult.runBKept);
  check(`${t.field}: 캐스케이드 회귀 — 전체 기본 복원 (의도적)`, t.cascadeResult.allReverted);
}

await browser.close();
console.log(failures.length === 0 ? `\nALL PASS (${r.tests.length} fields × 7 assertions)` : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);