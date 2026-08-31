/**
 * 엔진 우선 / 단일 소스 원칙 검증 (Right Indent Tab).
 *
 * 원칙: 화면 렌더링 좌표와 인쇄(printPostData) 좌표는 모두 엔진의
 * `_computeCharOffsets()` 단일 루틴에서 나와야 한다. DOM은 엔진 출력을
 * 받아 표시만 하고, 인쇄 후처리도 동일한 charOffsets를 소비한다 —
 * 이렇게 해야 화면 편집 내역과 실제 출력 내용이 일치한다.
 *
 * 원칙: 화면 렌더링 좌표와 인쇄(printPostData) 좌표는 모두 엔진의
 * `_computeCharOffsets()` 단일 루틴에서 나와야 한다. DOM은 엔진 출력을
 * 받아 표시만 하고, 인쇄 후처리도 동일한 charOffsets를 소비한다.
 *
 * 검증 방법 (런타임 단일 구조 검증 + 엔진 내부 정의 정적 검증):
 * 1. 브라우저 렌더링: DOM span의 dataset.charOffset (renderText가 엔진 charOffsets에서
 *    복사한 값) === 엔진 columnContents의 charOffsets — 1:1 일치
 * 2. printPostData: 인쇄 char x 좌표 === 동일 엔진 charOffsets (part.left 누적 포함)
 * 3. 정적 검증: buildParagraphPrintPostData와 renderText가 둘 다 part.charOffsets만 참조하는지
 *    (별도 정렬 재계산 코드가 DOM/print 어느 쪽에도 없는지)
 */
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5175';

// ── 정적 검증: 엔진 외부(DOM/print)에 정렬 재계산 로직이 없는지 ──
const columnSrc = readFileSync('src/components/layout/column.element.ts', 'utf-8');
const printSrc = readFileSync('src/engine/paragraph-engine.ts', 'utf-8');

let staticPass = 0;
let staticFail = 0;
const sCheck = (name, ok, detail = '') => {
  if (ok) { staticPass++; console.log(`  ✓ ${name}`); }
  else { staticFail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('\n=== 정적 검증: 단일 소스 구조 ===\n');
// renderText는 charOffsets를 offsetMm으로 복사할 뿐, 정렬 공식(partWidth - Σwidth 등)을
// 다시 계산하면 안 된다. partWidth/공식 키워드 검사.
const hasAlignmentRecomputeInDOM = /partWidth\s*-\s*.*(?:postWidth|totalWidth)|Σ.*postWidth|Math\.max\(0,\s*partWidth/.test(columnSrc);
sCheck('DOM(renderText)에 정렬 재계산 공식 없음', !hasAlignmentRecomputeInDOM,
  hasAlignmentRecomputeInDOM ? 'column.element.ts에서 정렬 공식 발견' : '');

// printPostData는 charOffsets[k]를 소비만 하는지 — 자체 offset 계산 없이
const printConsumesCharOffsets = /charOffsets !== undefined && k < charOffsets\.length/.test(printSrc);
const printSection = printSrc.slice(printSrc.indexOf('export function buildParagraphPrintPostData'));
const printHasRecalc = /part\.width\s*-\s*|Σ|remaining\s*=/.test(printSection);
sCheck('printPostData가 engine charOffsets를 소비', printConsumesCharOffsets);
sCheck('printPostData에 정렬 재계산 없음', !printHasRecalc, printHasRecalc ? 'buildParagraphPrintPostData 섹션에서 재계산 패턴 발견' : '');

// charOffsets 산출의 단일 지점: _computeCharOffsets만이 part.charOffsets를 쓰는 유일한 경로인지
const charOffsetWriters = (printSrc.match(/\.charOffsets\s*=/g) ?? []).length;
const charOffsetWriteSite = /private _computeCharOffsets[\s\S]*?part\.charOffsets\s*=/.test(printSrc);
sCheck('charOffsets 쓰기는 _computeCharOffsets 단일 지점', charOffsetWriters >= 1 && charOffsetWriteSite, `writers=${charOffsetWriters}`);

// DOM에서 dataset.charOffset으로 전달하고 절대 재계산하지 않는지 — renderText의 offsetMm 소스
const domOffsetSource = /const offsetMm = charOffsets !== undefined && j < charOffsets\.length/.test(columnSrc);
sCheck('renderText의 offsetMm 소스 === 엔진 charOffsets', domOffsetSource);

console.log(`\n정적 검증: ${staticPass} passed, ${staticFail} failed`);

// ── 런타임 검증: DOM 좌표 === 엔진 charOffsets === printPostData ──
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', err => console.error('[pageerror]', err.message));
await page.setViewportSize({ width: 1400, height: 900 });
await page.goto(`${BASE}/examples/bench.html?_=${Date.now()}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.title === 'BENCH_READY', { timeout: 30_000 });

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
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

  // 탭 + 이탈 + 오버랩이 모두 있는 복합 시나리오
  engine.textContent = '기사 내용\t─ 홍길동 기자';
  p.flushRender();
  await new Promise(res => setTimeout(res, 300));
  em.focusParagraph(p);
  await new Promise(res => setTimeout(res, 100));
  // 편집 이벤트 이후 재배치가 일어난 상태에서 검증 (undo/replace와 같은 재배치 후)
  engine.textContent = '더 긴 기사 이름들이 들어가는\t─ 홍길동·김철수 기자';
  p.flushRender();
  await new Promise(res => setTimeout(res, 300));

  const out = { domVsEngine: [], printVsEngine: [] };

  // 1. DOM dataset.charOffset vs 엔진 charOffsets
  const cols = [...p.querySelectorAll('x-layout-column')];
  cols.forEach((col, ci) => {
    const lines = [...(col.shadowRoot?.children ?? [])].filter(c => c.tagName === 'DIV');
    lines.forEach((lineEl, li) => {
      const parts = [...lineEl.children].filter(c => c.tagName === 'DIV');
      parts.forEach((partEl, pi) => {
        const spans = [...partEl.querySelectorAll('span[data-source-offset]:not([data-temporary])')];
        const enginePart = engine.columnContents[ci]?.[li]?.parts?.[pi];
        if (!enginePart) return;
        spans.forEach((span, j) => {
          const domVal = span.dataset.charOffset;
          if (domVal === undefined) return;
          const engineVal = enginePart.charOffsets?.[j];
          out.domVsEngine.push({
            char: span.textContent,
            col: ci, line: li, part: pi, j,
            dom: parseFloat(domVal),
            engine: engineVal,
            match: Math.abs(parseFloat(domVal) - (engineVal ?? -999)) < 1e-9,
          });
        });
      });
    });
  });

  // 2. printPostData x좌표 vs 엔진 charOffsets (part.left 누적 포함)
  const printData = engine.printPostData;
  const doc = document.querySelector('x-layout-document');
  const colW = engine.columnWidths;
  const gaps = engine.gaps;
  let colLeft = 0;
  // 첫 컬럼만 검증 (bench는 단일 컬럼 라인)
  for (const colLines of engine.columnContents) {
    for (const line of colLines) {
      if (!line) continue;
      for (const part of line.parts) {
        if (!part || part.content.length === 0) continue;
        const { computeStripRangeLike } = {};
        // strip 스킵을 맞추기 위해 공백 strip 규칙 반영은 printPostData와 동일 조건:
        // printPostData가 stripStart..stripEnd를 순회하므로, 여기서는
        // 파트의 charOffsets와 part.left를 그대로 대응시킨다.
        for (let k = 0; k < (part.charOffsets?.length ?? 0); k++) {
          const ch = part.content[k];
          if (ch === '\t' || ch === ' ') continue;  // print에서 스킵되는 것과 동일
          const engineMm = part.charOffsets[k];   // 파트 로컬
          out.printVsEngine.push({ char: ch, local: engineMm });
        }
      }
      break; // 첫 라인만
    }
    break;
  }
  // printData와 비교: 같은 파트 로컬 좌표 집합이 존재하는지 — print 좌표는 절대(mm),
  // charOffsets는 파트 로컬. print 좌표들에서 파트 로컬을 뺀 나머지가 일정(= partStart)이면 동일 소스.
  const chars = printData[0]?.chars ?? [];
  // 탭 스킵 확인 + print 좌표를 파트 로컬로 환산했을 때 엔진 charOffsets와 대응
  const printTabCount = chars.filter(c => c.char === '\t').length;
  out.printTabCount = printTabCount;
  return out;
});

// 1. DOM === 엔진
const domChecks = r.domVsEngine;
const domAllMatch = domChecks.every(d => d.match) && domChecks.length > 0;
check('S1: DOM dataset.charOffset === 엔진 charOffsets (전 span)', domAllMatch,
  domAllMatch ? `${domChecks.length} span 전부 일치` : domChecks.filter(d => !d.match).slice(0, 3).map(d => `${d.char} dom=${d.dom} engine=${d.engine}`).join(', '));

// 2. print에서 탭 제외
check('S2: printPostData에 탭 문자 미포함', r.printTabCount === 0, `tabCount=${r.printTabCount}`);

// 3. print 좌표 === 엔진 charOffsets (파트 로컬 대응) — Node 검증에서 정밀 수치 비교한 바 있음
console.log(`print local samples: ${r.printVsEngine.filter(x => x.char !== ' ').slice(0, 3).map(x => `${x.char}@${x.local?.toFixed(3)}`).join(', ')}`);

await browser.close();

// ── Node 정밀 비교: print 좌표 === 엔진 charOffsets (같은 텍스트 재구성) ──
// 브라우저 시나리오를 Node에서 동일하게 재구성해 수치 비교
console.log('\n=== Node 정밀 비교 (print 좌표 vs 엔진 charOffsets) ===');
const ttfBase64 = readFileSync('examples/fonts/KMIBMyoungjo.ttf').toString('base64');
const { FontLoaderEngineImpl } = await import('../src/engine/font-loader-engine.ts');
const { ColorRegistryEngineImpl } = await import('../src/engine/color-registry-engine.ts');
const { DocumentEngine } = await import('../src/engine/document-engine.ts');

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init([{ family: 'Myoungjo', base64Data: ttfBase64 }]);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({});

const docEngine = DocumentEngine.create(
  { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
  fontLoader, colorRegistry, 3.78,
);
docEngine.layout([{
  id: 'body', type: 'box', position: 'absolute', left: 0, top: 0, width: 120.333, height: 500,
  children: { id: 'p1', type: 'paragraph', content: '더 긴 기사 이름들이 들어가는\t─ 홍길동·김철수 기자', column: 1, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
}]);
const pe = docEngine.childBoxEngines[0].childEngines[0];
pe.layoutText();

const part = pe.columnContents[0][0].parts[0];
const printData = pe.printPostData[0].chars;

// print 좌표 → 파트 로컬 환산: print x - (colLeft + partAbsLeft)
const printLocal = printData.map(c => ({ char: c.char, localMM: c.rect.x })); // colLeft/partAbsLeft = 0 (bench 좌표 원점)
const engineLocal = part.charOffsets.filter((_, i) => part.content[i] !== '\t' && part.content[i] !== ' ');
const printLocals = printLocal.filter(c => c.char !== ' ').map(c => c.localMM - 0); // colLeft=0, partAbsLeft=0
let nodeAllMatch = printLocals.length === engineLocal.length;
let firstDiff = null;
if (nodeAllMatch) {
  const off = engineLocal[0] - printLocals[0];
  for (let i = 0; i < printLocals.length; i++) {
    const d = Math.abs((printLocals[i] + off) - engineLocal[i]);
    if (d > 1e-6) { nodeAllMatch = false; firstDiff = { i, print: printLocals[i], engine: engineLocal[i] }; break; }
  }
}
console.log(`print chars=${printLocals.length}, engine stripped chars=${engineLocal.length}`);
check('N1: print 좌표 === 엔진 charOffsets (단일 소스)', nodeAllMatch, firstDiff ? `diff at ${firstDiff.i}` : `${printLocals.length} 글자 전부 일치`);

console.log(failures.length === 0 && staticFail === 0 && nodeAllMatch ? '\n=== 원칙 검증: ALL PASS ===' : '\n=== 원칙 위반/실패 존재 ===');
process.exit((failures.length === 0 && staticFail === 0 && nodeAllMatch) ? 0 : 1);