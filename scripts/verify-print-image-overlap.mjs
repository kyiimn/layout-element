/**
 * 화면(print 이외 렌더링) === print(printPostData) 정합성 검증 (Node).
 *
 * 엔진-우선 원칙의 최종 목적 — 화면과 인쇄 출력이 동일 데이터를 유지 — 중
 * 이미지/오버랩 경로의 print 반영을 검증한다. 기존 print 검증
 * (verify-right-indent-tab*.mjs)은 문단 텍스트 좌표만 커버했고,
 * 이미지 displayRect(objectFit/none 좌표)와 오버랩 회피의 print 반영은
 * 검증 공백이었다.
 *
 * 검증 항목:
 *  1. 이미지 printPostData 좌표 === displayRect (모드별: cover/contain/fill/none)
 *     - print data.x/y/w/h가 objectFit 계산 결과를 그대로 반영하는지
 *     - 'none' 모드의 명시적 x/y/w/h가 print에 그대로 가는지
 *  2. objectFit 변경 → print 좌표 갱신 (stale print 방지)
 *  3. overlapMode 'none' → 문단 라인 배치 변화가 print chars에 반영
 *     - 'box'(회피) vs 'none'(관통)의 print char y 좌표 분포 차이
 *  4. print rect === contentAbsRect (이미지 rect가 박스 영역인지)
 *
 * 실행: npx tsx scripts/verify-print-image-overlap.mjs
 *
 * @file scripts/verify-print-image-overlap.mjs
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

let passCount = 0;
let failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failCount++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/** 문서를 만들고 print에서 이미지 항목을 찾는 헬퍼. */
function buildDoc(imageChild) {
  const docEngine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([
    {
      type: 'box', id: 'para-box', position: 'absolute', left: 10, top: 10, width: 70, height: 60, zIndex: 1,
      children: { id: 'para', type: 'paragraph', content: '가나다라마바사아자차카타파하'.repeat(30), column: 2, gap: 3, paragraphStyle: {}, textStyle: {} },
    },
    {
      type: 'box', id: 'img-box', position: 'absolute', left: 30, top: 20, width: 40, height: 30, zIndex: 10,
      contentType: 'image',
      children: imageChild,
    },
  ]);
  return docEngine;
}

/** print 배열에서 이미지 항목(data.type === 'image')을 추출한다. */
function findImagePrint(printData) {
  return printData.find(p => p.data.type === 'image');
}

// ── Test 1: 모드별 이미지 print 좌표 === displayRect ──
console.log('\nTest 1: 이미지 print 좌표 === displayRect (모드별)');
{
  const cases = [
    {
      name: 'cover',
      child: { id: 'img', type: 'image', url: '', dpi: 72, objectFit: 'cover', originalWidth: 80, originalHeight: 40 },
      // box 40×30 (aspect 1.33) vs 원본 80×40 (aspect 2) → cover: h=30, w=60, x=(40-60)/2=-10
      expect: { x: -10, y: 0, width: 60, height: 30 },
    },
    {
      name: 'contain',
      child: { id: 'img', type: 'image', url: '', dpi: 72, objectFit: 'contain', originalWidth: 80, originalHeight: 40 },
      expect: { x: 0, y: 5, width: 40, height: 20 }, // box 40×30, img 2:1 → w=40 h=20 y=(30-20)/2
    },
    {
      name: 'fill',
      child: { id: 'img', type: 'image', url: '', dpi: 72, objectFit: 'fill', originalWidth: 80, originalHeight: 40 },
      expect: { x: 0, y: 0, width: 40, height: 30 }, // box 꽉 채움
    },
    {
      name: 'none (명시 좌표)',
      child: { id: 'img', type: 'image', url: '', dpi: 72, objectFit: 'none', x: 5, y: 2, width: 20, height: 10 },
      expect: { x: 5, y: 2, width: 20, height: 10 },
    },
    {
      name: 'none (w/h 생략 → 원본 1:1)',
      child: { id: 'img', type: 'image', url: '', dpi: 72, objectFit: 'none', x: 3, y: 1, originalWidth: 25, originalHeight: 15 },
      expect: { x: 3, y: 1, width: 25, height: 15 },
    },
  ];

  for (const c of cases) {
    const docEngine = buildDoc(c.child);
    const imgEngine = docEngine.findEngineById('img');
    const imgPrint = findImagePrint(docEngine.printPostData);
    if (!imgPrint) { check(`${c.name}: print 이미지 항목 존재`, false); continue; }

    const d = imgPrint.data;
    const ok = approx(d.x, c.expect.x) && approx(d.y, c.expect.y)
      && approx(d.width, c.expect.width) && approx(d.height, c.expect.height);
    check(`${c.name}: print x/y/w/h === displayRect 기대값`, ok,
      `print=(${d.x},${d.y},${d.width},${d.height}) 기대=(${c.expect.x},${c.expect.y},${c.expect.width},${c.expect.height})`);

    // displayRect와의 직접 일치 (상대 좌표 = displayRect - contentAbsRect)
    const dr = imgEngine.displayRect;
    const box = docEngine.findEngineById('img-box');
    const content = box.contentAbsRect;
    check(`${c.name}: print 좌표 === displayRect - contentAbsRect`,
      approx(d.x, dr.absLeft - content.absLeft) && approx(d.y, dr.absTop - content.absTop)
      && approx(d.width, dr.absWidth) && approx(d.height, dr.absHeight));
  }
}

// ── Test 2: objectFit 변경 → print 좌표 갱신 (stale print 방지) ──
console.log('\nTest 2: objectFit 변경 시 print 좌표 갱신');
{
  const docEngine = buildDoc({ id: 'img', type: 'image', url: '', dpi: 72, objectFit: 'cover', originalWidth: 80, originalHeight: 40 });
  const imgEngine = docEngine.findEngineById('img');

  const before = findImagePrint(docEngine.printPostData).data;
  check('초기 cover: print 반영', approx(before.width, 60) && approx(before.height, 30) && approx(before.x, -10),
    `(${before.x},${before.y},${before.width},${before.height})`);

  // objectFit contain으로 변경 (개별 data setter 경로)
  imgEngine.data = { ...imgEngine.data, objectFit: 'contain' };
  imgEngine.layout();
  docEngine.ensureCommitted();
  const after = findImagePrint(docEngine.printPostData).data;
  check('contain 변경: print 좌표 갱신', approx(after.width, 40) && approx(after.height, 20) && approx(after.y, 5),
    `(${after.x},${after.y},${after.width},${after.height}) — 변경 전 (${before.width},${before.height})`);
}

// ── Test 3: overlapMode 'none' → 문단 라인 배치가 print chars에 반영 ──
console.log('\nTest 3: overlapMode none → print chars 라인 배치 반영');
{
  // 이미지 rect (절대좌표): img-box left=30 top=20 w=40 h=30 → {30,20}~{70,50}
  const IMG_RECT = { left: 30, top: 20, right: 70, bottom: 50 };

  // 'box' 모드 문서: 회피 발생 → 이미지 rect 내부 char 수가 적어야 함
  const docBox = buildDoc({ id: 'img', type: 'image', url: '', dpi: 72, overlapMode: 'box', objectFit: 'none', x: 0, y: 0, width: 40, height: 30 });
  const printBox = docBox.printPostData.find(p => p.data.type === 'paragraph');
  const charsBox = printBox.chars ?? [];
  const insideBox = charsBox.filter(c =>
    c.rect.x >= IMG_RECT.left && c.rect.x < IMG_RECT.right
    && c.rect.y >= IMG_RECT.top && c.rect.y < IMG_RECT.bottom).length;

  // 'none' 모드 문서: 회피 없음 → 이미지 rect 내부에 char가 그대로 존재
  const docNone = buildDoc({ id: 'img', type: 'image', url: '', dpi: 72, overlapMode: 'none', objectFit: 'none', x: 0, y: 0, width: 40, height: 30 });
  const printNone = docNone.printPostData.find(p => p.data.type === 'paragraph');
  const charsNone = printNone.chars ?? [];
  const insideNone = charsNone.filter(c =>
    c.rect.x >= IMG_RECT.left && c.rect.x < IMG_RECT.right
    && c.rect.y >= IMG_RECT.top && c.rect.y < IMG_RECT.bottom).length;

  check('box 모드: print chars 존재', charsBox.length > 0, `chars ${charsBox.length}개`);
  check('none 모드: print chars 존재', charsNone.length > 0, `chars ${charsNone.length}개`);
  check('box(회피): 이미지 영역 내부 print char 수 ≈ 0', insideBox < insideNone,
    `이미지 rect 내부 char — box ${insideBox}개 vs none ${insideNone}개`);
  check('none(관통): 이미지 영역 내부에 print char 존재', insideNone > 0,
    `이미지 rect 내부 ${insideNone}개 — 회피 없음이 print에 반영`);
  check('전체 char 수: none ≥ box (관통 문서가 더 많은 글자를 수용)',
    charsNone.length >= charsBox.length, `none ${charsNone.length}자 ≥ box ${charsBox.length}자`);
}

// ── Test 4: print rect === 이미지 박스 contentAbsRect ──
console.log('\nTest 4: print rect === 이미지 박스 contentAbsRect');
{
  const docEngine = buildDoc({ id: 'img', type: 'image', url: '', dpi: 72, objectFit: 'cover', originalWidth: 80, originalHeight: 40 });
  const box = docEngine.findEngineById('img-box');
  const content = box.contentAbsRect;
  const imgPrint = findImagePrint(docEngine.printPostData);

  check('print rect === contentAbsRect (박스 영역)',
    approx(imgPrint.rect.x, content.absLeft) && approx(imgPrint.rect.y, content.absTop)
    && approx(imgPrint.rect.width, content.absWidth) && approx(imgPrint.rect.height, content.absHeight),
    `rect=(${imgPrint.rect.x},${imgPrint.rect.y},${imgPrint.rect.width},${imgPrint.rect.height})`);
}

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount > 0 ? 1 : 0);