/**
 * 이미지 displayRect 변화 → 오버랩 회피 재계산 정합성 검증 (Node).
 *
 * `ParagraphEngine`의 `_layoutCache` 입력 해시는 오버랩 요소를 박스 rect +
 * overlapMode + hasRgba + overlapPadding으로 해싱한다. 이미지 오버랩 판정
 * (`ImageEngine.computeOverlap`)은 **`displayRect`**(objectFit/none x/y/w/h
 * 기반 실제 표시 영역)를 기준으로 수행하므로, displayRect를 해시가 포함하지
 * 않으면 objectFit 변경/'none' 모드 좌표 변경 시 박스 rect는 불변 → 해시
 * 동일 → stale 캐시 히트로 회피가 재계산되지 않는다 (재현: split 라인 0→0).
 *
 * 검증 항목:
 *  1. objectFit cover→contain 변경 후 재레이아웃 결과 변화
 *  2. objectFit none + x/y/w/h 명시 변경 후 재레이아웃 결과 변화
 *  3. none 모드 개별 x setter 변경 후 재레이아웃 결과 변화
 *  4. displayRect 변화 시 layout input hash 변화 (캐시 무효화 메커니즘 직접 확인)
 *
 * 실행: npx tsx scripts/verify-image-displayrect-cache.mjs
 *
 * @file scripts/verify-image-displayrect-cache.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ttfBase64 = readFileSync(resolve(pkgRoot, 'examples/fonts/KMIBMyoungjo.ttf')).toString('base64');

const { FontLoaderEngineImpl } = await import(`${pkgRoot}/src/engine/font-loader-engine.ts`);
const { ColorRegistryEngineImpl } = await import(`${pkgRoot}/src/engine/color-registry-engine.ts`);
const { DocumentEngine } = await import(`${pkgRoot}/src/engine/document-engine.ts`);

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init([{ family: 'Myoungjo', base64Data: ttfBase64 }]);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({});

let passCount = 0, failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failCount++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SYLLABLES = '가나다라마바사아자차카타파하';
const text = SYLLABLES.repeat(30);

const docEngine = DocumentEngine.create(
  { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
  fontLoader, colorRegistry, 3.78,
);

docEngine.layout([
  {
    type: 'box', id: 'para-box', position: 'absolute', left: 10, top: 10, width: 70, height: 60, zIndex: 1,
    children: { id: 'para', type: 'paragraph', content: text, column: 2, gap: 3, paragraphStyle: {}, textStyle: {} },
  },
  {
    type: 'box', id: 'img-box', position: 'absolute', left: 30, top: 20, width: 40, height: 30, zIndex: 10,
    contentType: 'image',
    children: { id: 'img', type: 'image', url: '', dpi: 72, overlapMode: 'box', objectFit: 'cover', originalWidth: 80, originalHeight: 40 },
  },
]);

const paraEngine = docEngine.findEngineById('para');
const imgEngine = docEngine.findEngineById('img');
if (!paraEngine || !imgEngine) { console.log('FAIL: engines not found'); process.exit(1); }

// overlapParts가 split된 라인 수로 회피 강도를 측정한다
const splitLineCount = () => paraEngine.columnContents.flat().filter(l => (l.parts?.length ?? 0) > 1).length;
const layoutSig = () => JSON.stringify(paraEngine.columnContents);

const sig1 = layoutSig();
const split1 = splitLineCount();
console.log(`\n[초기] objectFit=cover, displayRect=${JSON.stringify(imgEngine.displayRect)}, 회피 split 라인: ${split1}`);

// 이미지 엔진 데이터 갱신이 단락 재레이아웃으로 이어지려면 단락 엔진이 다시 layoutText를 돌려야 한다.
// DOM 경로에서는 requestRerenderAffectedParagraphs → render → layoutText.
// 여기서는 (a) 해시가 바뀌는지, (b) 재레이아웃 시 결과가 달라지는지를 검증한다.

// ── Test 1: objectFit cover → contain (displayRect 축소) ──
imgEngine.data = { ...imgEngine.data, objectFit: 'contain' };
imgEngine.layout();
paraEngine.layoutText();  // DOM의 requestRerenderAffectedParagraphs 경로가 하는 일
const sig2 = layoutSig();
const split2 = splitLineCount();
check('objectFit cover→contain 후 재레이아웃: 레이아웃 결과 변화 (stale 캐시 아님)', sig2 !== sig1,
  `split 라인 ${split1} → ${split2}, displayRect ${JSON.stringify(imgEngine.displayRect)}`);

// ── Test 2: objectFit none + x/y/w/h 명시 (displayRect 재배치) ──
imgEngine.data = { ...imgEngine.data, objectFit: 'none', x: 5, y: 2, width: 20, height: 10 };
imgEngine.layout();
paraEngine.layoutText();
const sig3 = layoutSig();
const split3 = splitLineCount();
check('objectFit none + x/y/w/h 변경 후 재레이아웃: 레이아웃 결과 변화', sig3 !== sig2,
  `split 라인 ${split2} → ${split3}, displayRect ${JSON.stringify(imgEngine.displayRect)}`);

// ── Test 3: none 모드에서 개별 setter x 변경 ──
imgEngine.x = 30;
imgEngine.layout();
paraEngine.layoutText();
const sig4 = layoutSig();
const split4 = splitLineCount();
check('none 모드 x 개별 setter 변경 후 재레이아웃: 레이아웃 결과 변화', sig4 !== sig3,
  `split 라인 ${split3} → ${split4}, displayRect ${JSON.stringify(imgEngine.displayRect)}`);

// ── Test 4: displayRect 변화 시 layout input hash 변화 (캐시 무효화 메커니즘) ──
// _layoutCache 히트 여부로 검증: 해시가 바뀌면 캐시가 miss되어야 한다.
// (Test 1-3의 layoutText가 이미 이를 관통하지만, 해시 자체를 직접 확인)
const hashBefore = paraEngine._computeLayoutInputHash();
imgEngine.x = 45;  // none 모드에서 displayRect 변화
imgEngine.layout();
const hashAfter = paraEngine._computeLayoutInputHash();
check('none 모드 x 변경: layout input hash 변화 (캐시 무효화)', hashBefore !== hashAfter,
  hashBefore === hashAfter ? '해시 동일 — stale 캐시 히트 위험!' : '해시 변화 확인');

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);
