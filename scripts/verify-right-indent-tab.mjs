/**
 * 좌우 밀기 탭 (`\t`) 정합성 검증 (Node).
 *
 * 검증 항목:
 * 1. 탭 문자가 파트 content에 보존된다 (plain text round-trip)
 * 2. 탭 이후 텍스트가 파트 오른쪽 끝에 우측 정렬된다
 * 3. 탭 자체의 offset = 우측 세그먼트 시작 위치
 * 4. justify 문단에서도 탭 파트는 좌/우 분할 (비분산)
 * 5. 다중 탭: 첫 탭 기준 collapse
 * 6. trailing tab: offset == partWidth
 * 7. 탭 폭 0 (getCharWidths)
 * 8. printPostData에서 '\t' 문자가 출력에 없음
 * 9. 오버랩(파트 분할) 환경: 탭은 현재 파트의 오른쪽 끝에만 정렬
 * 10. 멀티컬럼: 탭 파트가 컬럼 파트 폭 내에 유지됨
 *
 * 실행: npx tsx scripts/verify-right-indent-tab.mjs
 *
 * @file scripts/verify-right-indent-tab.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const ttfBase64 = readFileSync(resolve(pkgRoot, 'examples/fonts/KMIBMyoungjo.ttf')).toString('base64');

const { FontLoaderEngineImpl } = await import('../src/engine/font-loader-engine.ts');
const { ColorRegistryEngineImpl } = await import('../src/engine/color-registry-engine.ts');
const { DocumentEngine } = await import('../src/engine/document-engine.ts');

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init([{ family: 'Myoungjo', base64Data: ttfBase64 }]);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({});

let passCount = 0;
let failCount = 0;
function assert(condition, message) {
  if (condition) {
    passCount++;
    console.log(`  ✓ ${message}`);
  } else {
    failCount++;
    console.error(`  ✗ ${message}`);
  }
}

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/**
 * DocumentEngine + 단일 문단 박스로 엔진 트리를 구성하고 layout을 실행한다.
 * `children`은 단일 paragraph 객체로 전달한다 (BoxEngine이 content engine으로 구성).
 * @param {string} content - 문단 텍스트
 * @param {object} opts - { boxWidth, boxHeight, paragraphStyle, textStyle, column }
 * @returns {{ docEngine: DocumentEngine, paraEngine: ParagraphEngine }}
 */
function buildDoc(content, opts = {}) {
  const {
    boxWidth = 57.7,
    boxHeight = 500,
    paragraphStyle = {},
    textStyle = {},
    column = 1,
  } = opts;

  const docEngine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );

  docEngine.layout([
    {
      id: 'body', type: 'box', position: 'absolute', left: 0, top: 0, width: boxWidth, height: boxHeight,
      children: {
        id: 'p1', type: 'paragraph', content, column, gap: 3,
        paragraphStyle: { lineGap: 1.2, ...paragraphStyle },
        textStyle: { fontSize: 4, fontFamily: 'Myoungjo', ...textStyle },
      },
    },
  ]);

  const bodyBox = docEngine.childBoxEngines[0];
  const paraEngine = bodyBox.childEngines[0];
  paraEngine.layoutText();
  return { docEngine, paraEngine };
}

/** 문단 엔진의 첫 컬럼 첫 라인 첫 파트를 반환한다. */
function firstPart(engine) {
  return engine.columnContents[0]?.[0]?.parts?.[0] ?? null;
}

/** 파트 내 특정 글자의 우측 끝 x (mm) 를 charOffsets로 계산한다. */
function charRight(engine, part, idx) {
  return part.charOffsets[idx] + engine.getCharWidths(part.content[idx]).swidth;
}

console.log('\n=== 좌우 밀기 탭 Verification ===\n');

// ── 1. 탭 문자 파트 보존 + 단일 라인 배치 ──
{
  const { paraEngine } = buildDoc('기사 내용\t─ 홍길동 기자');
  assert(paraEngine !== null, 'T1: 문단 엔진 발견');
  const part = firstPart(paraEngine);
  assert(part !== null, 'T1: 파트 존재');
  const joined = part.content.join('');
  assert(joined.includes('\t'), `T1: 파트 content에 '\\t' 보존`);
  assert(paraEngine.plainText.includes('\t'), 'T1: plainText round-trip에 \\t 포함');
  const totalLines = paraEngine.columnContents.reduce((s, col) => s + col.length, 0);
  assert(totalLines === 1, `T1: 바이라인 1라인 배치 (got ${totalLines}) — 탭이 줄바꿈을 유발하지 않음`);
}

// ── 2. 탭 이후 텍스트 우측 정렬 ──
{
  const { paraEngine } = buildDoc('기사 내용\t─ 홍길동 기자');
  const part = firstPart(paraEngine);
  const content = part.content;
  const tabIdx = content.indexOf('\t');
  assert(tabIdx !== -1, 'T2: 탭 인덱스 발견');
  const offsets = part.charOffsets;
  assert(offsets !== undefined && offsets.length === content.length, 'T2: charOffsets 길이 일치');

  const lastIdx = content.length - 1;
  const lastRight = charRight(paraEngine, part, lastIdx);
  assert(
    approx(lastRight, part.width, 0.01),
    `T2: 우측 세그먼트 끝 == partWidth (${lastRight.toFixed(3)} vs ${part.width.toFixed(3)})`,
  );
  assert(approx(offsets[0], 0, 1e-6), `T2: 첫 글자 좌측 정렬 (offset=${offsets[0].toFixed(3)})`);

  let postWidths = 0;
  for (let i = tabIdx + 1; i < content.length; i++) postWidths += paraEngine.getCharWidths(content[i]).swidth;
  const expectedTabOffset = part.width - postWidths;
  assert(
    approx(offsets[tabIdx], expectedTabOffset, 0.01),
    `T2: 탭 offset == partWidth - ΣpostWidths (${offsets[tabIdx].toFixed(3)} vs ${expectedTabOffset.toFixed(3)})`,
  );

  let leftWidths = 0;
  for (let i = 0; i < tabIdx; i++) leftWidths += paraEngine.getCharWidths(content[i]).swidth;
  assert(
    offsets[tabIdx] >= leftWidths - 1e-6,
    `T2: 세그먼트 비-겹침 (tabOffset ${offsets[tabIdx].toFixed(3)} >= leftEnd ${leftWidths.toFixed(3)})`,
  );
}

// ── 3. justify 문단에서 탭 파트 비분산 ──
{
  const { paraEngine } = buildDoc('기사 내용\t─ 홍길동 기자', { paragraphStyle: { textAlign: 'justify' } });
  const part = firstPart(paraEngine);
  const content = part.content;
  const offsets = part.charOffsets;
  const tabIdx = content.indexOf('\t');

  let postWidths = 0;
  for (let i = tabIdx + 1; i < content.length; i++) postWidths += paraEngine.getCharWidths(content[i]).swidth;
  const expectedStart = part.width - postWidths;
  assert(
    approx(offsets[tabIdx + 1], expectedStart, 0.01),
    `T3: justify 문단에서도 탭 세그먼트 우측 정렬 (${offsets[tabIdx + 1].toFixed(3)} vs ${expectedStart.toFixed(3)})`,
  );

  const w0 = paraEngine.getCharWidths(content[0]).swidth;
  assert(approx(offsets[1], w0, 0.01), `T3: 좌측 세그먼트 분산 없음 (${offsets[1].toFixed(3)} vs ${w0.toFixed(3)})`);
}

// ── 4. 다중 탭 collapse ──
{
  const { paraEngine } = buildDoc('제목\t\t페이지');
  const part = firstPart(paraEngine);
  const content = part.content;
  const offsets = part.charOffsets;
  const firstTab = content.indexOf('\t');
  const secondTab = content.indexOf('\t', firstTab + 1);

  assert(firstTab !== -1 && secondTab !== -1, 'T4: 다중 탭 존재');
  assert(
    offsets[secondTab] >= offsets[firstTab] - 1e-6,
    `T4: 두 번째 탭이 첫 탭 위치 이후 (${offsets[secondTab].toFixed(3)} >= ${offsets[firstTab].toFixed(3)})`,
  );

  const lastIdx = content.length - 1;
  const lastRight = charRight(paraEngine, part, lastIdx);
  assert(approx(lastRight, part.width, 0.01), `T4: 마지막 글자 우측 끝 == partWidth (${lastRight.toFixed(3)})`);
}

// ── 5. trailing tab ──
{
  const { paraEngine } = buildDoc('기사 내용\t');
  const part = firstPart(paraEngine);
  const content = part.content;
  const tabIdx = content.indexOf('\t');
  const offsets = part.charOffsets;
  assert(tabIdx === content.length - 1, 'T5: trailing tab 위치');
  assert(
    approx(offsets[tabIdx], part.width, 0.01),
    `T5: trailing tab offset == partWidth (${offsets[tabIdx].toFixed(3)} vs ${part.width.toFixed(3)})`,
  );
}

// ── 6. 탭 폭 0 ──
{
  const { paraEngine } = buildDoc('가\t나');
  const { swidth } = paraEngine.getCharWidths('\t');
  assert(swidth === 0, `T6: getCharWidths('\\t').swidth === 0 (got ${swidth})`);
}

// ── 7. printPostData에서 '\t' 제외 ──
{
  const { paraEngine } = buildDoc('기사 내용\t─ 홍길동 기자');
  const printData = paraEngine.printPostData;
  assert(Array.isArray(printData) && printData.length === 1, 'T7: printPostData [{data, rect, chars}] 반환');
  const chars = printData[0].chars;
  const tabChars = chars.filter((p) => p.char === '\t');
  assert(tabChars.length === 0, `T7: printPostData.chars에 '\\t' 없음 (got ${tabChars.length})`);
  const nonTab = chars.map((p) => p.char).join('');
  assert(nonTab === '기사 내용─ 홍길동 기자', `T7: print 텍스트에서 탭 제거 (got "${nonTab}")`);

  const firstCharRect = chars[0];
  assert(approx(firstCharRect.rect.x, 0, 0.01), `T7: 첫 글자 x == 0 (${firstCharRect.rect.x.toFixed(3)})`);

  const lastPrint = chars[chars.length - 1];
  const lastRight = lastPrint.rect.x + lastPrint.rect.width;
  const part = firstPart(paraEngine);
  assert(
    approx(lastRight, part.width, 0.05),
    `T7: print 마지막 글자 우측 끝 == partWidth (${lastRight.toFixed(3)} vs ${part.width.toFixed(3)})`,
  );
}

// ── 8. 오버랩 환경: 파트 분할 시 탭은 현재 파트 내 정렬 ──
{
  const docEngine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([
    {
      id: 'body', type: 'box', position: 'absolute', left: 0, top: 0, width: 60, height: 500,
      children: {
        id: 'p1', type: 'paragraph', content: '첫 줄 텍스트입니다\t─ 기자', column: 1, gap: 3,
        paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
      },
    },
    {
      id: 'img', type: 'box', position: 'absolute', left: 0, top: 0, width: 30, height: 4.8, zIndex: 100,
      children: [],
    },
  ]);

  const bodyBox = docEngine.childBoxEngines.find((b) => b.data.id === 'body');
  const paraEngine = bodyBox.childEngines[0];
  paraEngine.layoutText();

  assert(paraEngine !== null, 'T8: 문단 엔진 발견');
  const line0 = paraEngine.columnContents[0]?.[0];
  assert(line0 !== undefined, 'T8: 첫 라인 존재');

  const joined = line0.parts.map((p) => p.content.join('')).join('|');
  const hasTab = joined.includes('\t');
  assert(hasTab, `T8: 첫 라인(오버랩)에 탭 포함 (parts="${joined.slice(0, 40)}")`);

  if (hasTab) {
    const tabPartIdx = line0.parts.findIndex((p) => p.content.includes('\t'));
    const tabPart = line0.parts[tabPartIdx];
    const content = tabPart.content;
    const lastIdx = content.length - 1;
    const lastRight = tabPart.charOffsets[lastIdx] + paraEngine.getCharWidths(content[lastIdx]).swidth;
    assert(
      approx(lastRight, tabPart.width, 0.05),
      `T8: 오버랩 파트 내 우측 정렬 — 파트[${tabPartIdx}] ${lastRight.toFixed(3)} vs width ${tabPart.width.toFixed(3)}`,
    );
    // 오버랩이 적용되어 파트 폭이 컬럼 전체 폭(60mm)보다 좁아야 한다
    assert(
      tabPart.width < 59.9,
      `T8: 오버랩으로 파트 폭 축소 (partWidth=${tabPart.width.toFixed(1)} < 컬럼 60mm) — 탭은 컬럼 끝이 아니라 자유 영역 끝에 정렬`,
    );
  }
}

// ── 9. 멀티컬럼: 모든 탭 파트가 컬럼 파트 폭 내 우측 정렬 ──
{
  const { paraEngine } = buildDoc('첫컬럼 텍스트가 길어서 넘어가는 상황입니다\t─ 기자명', {
    boxWidth: 57.7,
    boxHeight: 20,
    column: 2,
  });
  assert(paraEngine !== null, 'T9: 문단 엔진 발견');
  let checked = false;
  let allOk = true;
  for (let c = 0; c < paraEngine.columnContents.length; c++) {
    const column = paraEngine.columnContents[c];
    for (let li = 0; li < column.length; li++) {
      const line = column[li];
      for (const part of line.parts) {
        const idx = part.content.indexOf('\t');
        if (idx === -1) continue;
        checked = true;
        const content = part.content;
        const lastIdx = content.length - 1;
        const lastRight = part.charOffsets[lastIdx] + paraEngine.getCharWidths(content[lastIdx]).swidth;
        if (!approx(lastRight, part.width, 0.05)) {
          allOk = false;
          console.error(`    T9 fail detail: col=${c} line=${li} lastRight=${lastRight.toFixed(3)} width=${part.width.toFixed(3)}`);
        }
      }
    }
  }
  assert(checked, 'T9: 탭 파트 발견');
  assert(allOk, 'T9: 모든 탭 파트가 컬럼 파트 폭 내 우측 정렬');
}

// ── 결과 ──
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===\n`);
if (failCount > 0) process.exit(1);