/**
 * overlapMode 'none' 시맨틱 검증 (Node).
 *
 * `computeOverlapSizeMm`는 모든 오버랩 판정(이미지/문단)이 수렴하는 단일
 * 관문이다. 이 관문에 `'none'` 분기가 없으면 — `path`+RGBA가 아닌 모든
 * 경우가 box 기하학 판정으로 낙하 — `'none'`(회피 없음) 설정이 box 처리된다.
 * 재현: `overlapMode: 'none'` 이미지가 라인과 겹쳐도 PART 반환.
 *
 * 검증 항목 (7항목):
 *  1. 순수 함수: 'none' → NONE / 'box' → PART/COVERS (회귀 방어)
 *  2. ImageEngine.computeOverlap: 'none' → NONE / 'box' → PART
 *  3. end-to-end: box(회피 라인 수 증가) → none(라인 수 감소) → box(회복) 왕복
 *
 * 실행: npx tsx scripts/verify-overlap-none.mjs
 *
 * @file scripts/verify-overlap-none.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ttfBase64 = readFileSync(resolve(pkgRoot, 'examples/fonts/KMIBMyoungjo.ttf')).toString('base64');

const { FontLoaderEngineImpl } = await import(`${pkgRoot}/src/engine/font-loader-engine.ts`);
const { ColorRegistryEngineImpl } = await import(`${pkgRoot}/src/engine/color-registry-engine.ts`);
const { DocumentEngine } = await import(`${pkgRoot}/src/engine/document-engine.ts`);
const { ImageEngine } = await import(`${pkgRoot}/src/engine/image-engine.ts`);
const { computeOverlapSizeMm } = await import(`${pkgRoot}/src/engine/overlap-engine.ts`);

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init([{ family: 'Myoungjo', base64Data: ttfBase64 }]);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({});

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failCount++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── Test 1: 순수 함수 computeOverlapSizeMm — 'none' → NONE ──
console.log('\nTest 1: computeOverlapSizeMm overlapMode none');
{
  const lineRect = { left: 0, right: 50, top: 10, bottom: 14, width: 50, height: 4 };
  const overlayRect = { absLeft: 10, absTop: 0, absWidth: 30, absHeight: 30 };
  const r = computeOverlapSizeMm(lineRect, {
    absRect: overlayRect, overlapMode: 'none', overlapPadding: undefined,
    image: null, contentType: 'image',
  });
  check("'none' → direction NONE (회피 없음)", r.direction === 'NONE', `${r.direction}`);

  const rb = computeOverlapSizeMm(lineRect, {
    absRect: overlayRect, overlapMode: 'box', overlapPadding: undefined,
    image: null, contentType: 'image',
  });
  check("'box' → PART/COVERS (기존 동작 유지)", rb.direction !== 'NONE', `${rb.direction}`);
}

// ── Test 2: ImageEngine.computeOverlap — overlapMode 'none' 이미지 ──
console.log('\nTest 2: ImageEngine.computeOverlap overlapMode none');
{
  const img = ImageEngine.create({ url: '', dpi: 72, overlapMode: 'none', objectFit: 'none', x: 0, y: 0, width: 30, height: 20 });
  img.contentAbsRect = { absLeft: 10, absTop: 0, absWidth: 30, absHeight: 20 };
  img.layout();
  const r = img.computeOverlap({ left: 0, right: 50, top: 5, bottom: 9, width: 50, height: 4 });
  check("이미지 'none' → NONE", r.direction === 'NONE', `${r.direction}`);

  const imgBox = ImageEngine.create({ url: '', dpi: 72, overlapMode: 'box', objectFit: 'none', x: 0, y: 0, width: 30, height: 20 });
  imgBox.contentAbsRect = { absLeft: 10, absTop: 0, absWidth: 30, absHeight: 20 };
  imgBox.layout();
  const rb = imgBox.computeOverlap({ left: 0, right: 50, top: 5, bottom: 9, width: 50, height: 4 });
  check("이미지 'box' → PART (회귀 방어)", rb.direction !== 'NONE', `${rb.direction}`);
}

// ── Test 3: end-to-end — 라인 수 기반: 회피가 있으면 라인 수 증가 ──
console.log('\nTest 3: end-to-end — overlapMode 전환별 문단 라인 수 변화');
{
  const SYLLABLES = '가나다라마바사아자차카타파하';
  const docEngine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([
    {
      type: 'box', id: 'para-box', position: 'absolute', left: 10, top: 10, width: 70, height: 60, zIndex: 1,
      children: { id: 'para', type: 'paragraph', content: SYLLABLES.repeat(30), column: 2, gap: 3, paragraphStyle: {}, textStyle: {} },
    },
    {
      type: 'box', id: 'img-box', position: 'absolute', left: 30, top: 20, width: 40, height: 30, zIndex: 10,
      contentType: 'image',
      children: { id: 'img', type: 'image', url: '', dpi: 72, overlapMode: 'box', objectFit: 'none', x: 0, y: 0, width: 40, height: 30 },
    },
  ]);
  const paraEngine = docEngine.findEngineById('para');
  const imgEngine = docEngine.findEngineById('img');
  const lineCount = () => paraEngine.columnContents.reduce((sum, col) => sum + col.length, 0);

  const linesBox = lineCount();
  check('box 모드: 회피로 라인 수 증가 확인', linesBox > 0, `라인 ${linesBox}`);

  // 개별 setter 경로 시뮬레이션 — DocumentEngine.layout 재호출 없음
  imgEngine.data = { ...imgEngine.data, overlapMode: 'none' };
  imgEngine.layout();
  paraEngine.layoutText();
  const linesNone = lineCount();
  check("'none' 변경: 라인 수 감소 (박스 존재 무시)", linesNone < linesBox, `라인 ${linesBox} → ${linesNone}`);

  // 복원
  imgEngine.data = { ...imgEngine.data, overlapMode: 'box' };
  imgEngine.layout();
  paraEngine.layoutText();
  check("'box' 복원: 라인 수 회복", lineCount() === linesBox, `라인 ${linesBox} → ${lineCount()}`);
}

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
