/**
 * 탭 점선 가이드 (편집 모드 전용) 검증.
 * 1. 편집 모드에서 탭 span 가이드 표시 (data-tab-guide="true", 시각 폭 > 0)
 * 2. 비편집 모드에서 가이드 없음 (0폭)
 * 3. 기존 offset 매핑 무결성 (data-char-offset 미변경)
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5175';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', err => console.error('[pageerror]', err.message));
await page.setViewportSize({ width: 1400, height: 900 });
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
  const engine = p.engine;
  em.textEditMode = true;
  p.editableText = true;
  await new Promise(res => setTimeout(res, 200));

  em.blurParagraph();
  await new Promise(res => setTimeout(res, 100));
  engine.textContent = '기사\t─ 홍길동 기자';
  p.flushRender();
  await new Promise(res => setTimeout(res, 300));

  const getTab = (root) => [...root.querySelectorAll('x-layout-column')].flatMap(col =>
    [...col.shadowRoot.querySelectorAll('span[data-source-offset]')]
  ).find(s => s.textContent === '\t');

  const report = (tab) => tab ? {
    guide: tab.dataset.tabGuide,
    cssWidth: tab.style.width,
    visibility: tab.style.visibility,
    bgImage: tab.style.backgroundImage !== '' && tab.style.backgroundImage !== 'none',
    rectWidth: tab.getBoundingClientRect().width,
    charOffsetDataset: tab.dataset.charOffset,
    leftCss: tab.style.left,
    transform: tab.style.transform,
  } : null;

  const out = {};
  // 1. 비편집 모드 (editableText=true지만 포커스/컨트롤러 없는 상태에서 판정은 editableText 기준이라
  //    여기서는 실제 editableText=false로 토글해서 비교)
  out.editableTrue = report(getTab(p));  // editableText=true 상태

  // 2. editableText=false (비편집)
  p.editableText = false;
  await new Promise(res => setTimeout(res, 300));
  // editableText=false로 바꾸면 컨트롤러가 파괴되고 렌더는 유지되어야 하나, 탭 가이드가 없어야 함.
  // editableText=false 시 paragraph가 재렌더되는지 확인 — 재렌더가 없으면 span이 이전 상태 유지될 수 있으므로
  // 명시적으로 재렌더 트리거
  p.flushRender();
  await new Promise(res => setTimeout(res, 300));
  out.editableFalse = report(getTab(p));

  // 3. offset 매핑 무결성 — dataset.charOffset이 여전히 탭 위치
  p.editableText = true;
  await new Promise(res => setTimeout(res, 300));
  const tabAgain = getTab(p);
  out.datasetIntact = tabAgain ? { charOffset: tabAgain.dataset.charOffset } : null;

  // 렌더 반복 시 restyledCount 안정성 (no-op 렌더에서 스타일 재적용 루프 없는지)
  const col = p.querySelector('x-layout-column');
  const beforeCount = col.lastRestyledCount;
  p.flushRender();
  const afterCount = col.lastRestyledCount;

  return { ...out, restyled: { beforeCount, afterCount } };
});

const t = r.editableTrue;
check('G1: 편집 모드에서 가이드 표시', t?.guide === 'true', JSON.stringify(t));
check('G2: 편집 모드에서 탭 span 시각 폭 > 0', t?.rectWidth > 1, `rectWidth=${t?.rectWidth?.toFixed(2)}px`);
check('G3: 점선 배경 적용', t?.bgImage === true, `bg=${t?.bgImage}`);
check('G4: left는 탭 offset 유지 (dataset과 일치)', Math.abs(parseFloat(t?.leftCss ?? '0') - parseFloat(t?.charOffsetDataset ?? '0')) < 0.01, `left=${t?.leftCss} dataset=${t?.charOffsetDataset}`);
check('G5: 비편집 모드에서 가이드 없음', r.editableFalse === null || r.editableFalse.guide !== 'true', JSON.stringify(r.editableFalse));
check('G6: dataset.charOffset 무결성', r.datasetIntact?.charOffset !== undefined, JSON.stringify(r.datasetIntact));
check('G7: no-op 렌더 restyledCount 안정', Math.abs(r.restyled.beforeCount - r.restyled.afterCount) <= 2, `${r.restyled.beforeCount} → ${r.restyled.afterCount}`);

await browser.close();
console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);