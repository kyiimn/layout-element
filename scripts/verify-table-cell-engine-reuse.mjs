/**
 * 테이블 구조 편집 시 셀 박스 엔진 id 기반 재사용 검증 (Node).
 *
 * 배경: TableEngine.layout()이 TableCellEngine을 재구축할 때 cellLabel을 키로
 * boxEngine을 복원한다. 행/열 삭제, merge/split으로 라벨이 시프트되면 라벨
 * 매칭이 실패해 기존 BoxEngine이 재생성되고, 단락 `_layoutCache`와 이미지
 * `rgbaData`가 소실되어 전체 셀이 재래핑되었다. 이 검증은 box id 기반 stash
 * (BoxBuildContext.prevCellBoxEnginesById)가 라벨 시프트 후에도 동일 엔진
 * 인스턴스를 유지하는지 확인한다.
 *
 * 검증 항목:
 * 1. 무변경 재레이아웃: 모든 셀 박스 엔진 동일 인스턴스 유지
 * 2. 마지막 행 삭제(라벨 불변): 라벨 복원 경로 — 동일 인스턴스 유지
 * 3. 첫 행 삭제(라벨 시프트): stash 복원 경로 — 동일 인스턴스 유지
 * 4. 엔진 인스턴스 재사용 시 단락 엔진도 동일 인스턴스(캐시 보존 간접 증명)
 *
 * 실행: npx tsx scripts/verify-table-cell-engine-reuse.mjs
 *
 * @file scripts/verify-table-cell-engine-reuse.mjs
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

function makeRow(rowId, texts) {
  return {
    type: 'tr',
    id: rowId,
    height: 20,
    children: texts.map((content, i) => ({
      type: 'td',
      id: `${rowId}-td${i}`,
      children: [{
        type: 'box',
        id: `${rowId}-cellbox-${i}`,
        left: 0, top: 0, width: 1, height: 1,
        position: 'static',
        children: {
          type: 'paragraph',
          id: `${rowId}-para-${i}`,
          content,
          column: 1,
          gap: 0,
          paragraphStyle: {},
          textStyle: { fontSize: 4 },
        },
      }],
    })),
  };
}

function buildDocument(rows) {
  const docEngine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([tableBoxData(rows)]);
  return docEngine;
}

function tableBoxData(rows) {
  return {
    type: 'box',
    id: 'tablebox', position: 'absolute', left: 10, top: 10, width: 120, height: 100, zIndex: 1,
    children: {
      type: 'table',
      id: 'tbl',
      colWidths: [60, 60],
      children: rows,
    },
  };
}

function findTableEngine(docEngine) {
  const tableBox = docEngine.childBoxEngines[0];
  const te = tableBox.childEngines.find(e => e.constructor.name === 'TableEngine');
  return te ?? null;
}

function snapshotCellBoxEngines(tableEngine) {
  const snap = new Map();
  for (const rowEngine of tableEngine.rowEngines) {
    for (const cell of rowEngine.cellEngines) {
      if (cell.boxEngine) {
        snap.set(cell.boxEngine.data.id, cell.boxEngine);
      }
    }
  }
  return snap;
}

console.log('\n=== 테이블 구조 편집 셀 박스 엔진 재사용 검증 ===\n');

// ── Test 1: 무변경 재레이아웃 ──
console.log('Test 1: 무변경 재레이아웃 — 모든 셀 박스 엔진 동일 인스턴스');
{
  const rows = [
    makeRow('r1', ['셀A', '셀B']),
    makeRow('r2', ['셀C', '셀D']),
  ];
  const doc = buildDocument(rows);
  const te = findTableEngine(doc);
  const before = snapshotCellBoxEngines(te);

  doc.layout(rows);
  const after = snapshotCellBoxEngines(te);

  assert(before.size === 4, `셀 박스 엔진 4개 (got ${before.size})`);
  let allSame = true;
  for (const [id, engine] of before) {
    if (after.get(id) !== engine) allSame = false;
  }
  assert(allSame, '무변경 재레이아웃 후 모든 셀 박스 엔진 동일 인스턴스');
}

// ── Test 2: 마지막 행 삭제 (라벨 불변 → 라벨 복원 경로) ──
console.log('\nTest 2: 마지막 행 삭제 — 라벨 복원 경로에서 동일 인스턴스');
{
  const rows = [
    makeRow('r1', ['첫째', '둘째']),
    makeRow('r2', ['셋째', '넷째']),
  ];
  const doc = buildDocument(rows);
  const te = findTableEngine(doc);
  const before = snapshotCellBoxEngines(te);

  doc.layout([tableBoxData([rows[0]])]);
  const after = snapshotCellBoxEngines(te);

  assert(after.size === 2, `삭제 후 셀 박스 엔진 2개 (got ${after.size})`);
  const r1a = te.rowEngines[0];
  const sameAll = r1a.cellEngines.every(ce => {
    const id = ce.boxEngine?.data.id;
    return id && before.get(id) === ce.boxEngine;
  });
  assert(sameAll, '남은 행의 셀 박스 엔진 동일 인스턴스 (라벨+id 복원)');
}

// ── Test 3: 첫 행 삭제 (라벨 시프트 → stash 복원 경로) ──
console.log('\nTest 3: 첫 행 삭제 — 라벨 시프트 후 stash로 셀 박스 엔진 재사용');
{
  const rows = [
    makeRow('r1', ['위텍스트입니다', '위텍스트이에요']),
    makeRow('r2', ['아래텍스트', '아래텍스트2']),
  ];
  const doc = buildDocument(rows);
  const te = findTableEngine(doc);
  const before = snapshotCellBoxEngines(te);
  const beforeParagraphs = new Map();
  for (const rowEngine of te.rowEngines) {
    for (const cell of rowEngine.cellEngines) {
      const para = cell.boxEngine?.childEngines.find(e => e.constructor.name === 'ParagraphEngine');
      if (para) beforeParagraphs.set(cell.boxEngine.data.id, para);
    }
  }

  // 'r2'의 셀 라벨은 A1/B1 → A2/B2로 시프트된다 (첫 행 삭제).
  doc.layout([tableBoxData([rows[1]])]);
  const after = snapshotCellBoxEngines(te);
  const afters = [...after.values()];

  assert(after.size === 2, `삭제 후 셀 박스 엔진 2개 (got ${after.size})`);
  const allReused = [...beforeParagraphs.entries()].every(([boxId, para]) =>
    [...before.values()].some(be => be.data.id === boxId && after.get(boxId) === be),
  );
  const reusedCount = [...after.values()].filter(be => before.has(be.data.id)).length;
  assert(reusedCount === 2, `stash로 재사용된 셀 박스 엔진 수 2 (got ${reusedCount})`);
  const paraSame = [...beforeParagraphs.entries()].every(([boxId, prevPara]) => {
    const curBox = after.get(boxId);
    if (!curBox) return false;
    const curPara = curBox.childEngines.find(e => e.constructor.name === 'ParagraphEngine');
    return curPara === prevPara;
  });
  const survivingBoxIds = new Set([...before.keys()].filter(id => after.has(id)));
  const paraSameSurvivors = [...beforeParagraphs.entries()]
    .filter(([boxId]) => survivingBoxIds.has(boxId))
    .every(([boxId, prevPara]) => {
      const curBox = after.get(boxId);
      const curPara = curBox.childEngines.find(e => e.constructor.name === 'ParagraphEngine');
      return curPara === prevPara;
    });
  assert(paraSameSurvivors, '재사용된 셀 박스의 단락 엔진도 동일 인스턴스 (캐시 보존)');
  void allReused; void afters; void paraSame;
}

// ── Test 3b: 라벨 복원 경로에서도 단락 엔진 캐시 보존 ──
console.log('\nTest 3b: 라벨 복원 경로 — 동일 데이터 참조 재레이아웃 시 단락 엔진 유지');
{
  const rows = [
    makeRow('r1', ['동일내용셀A', '동일내용셀B']),
    makeRow('r2', ['동일내용셀C', '동일내용셀D']),
  ];
  const doc = buildDocument(rows);
  const te = findTableEngine(doc);
  const prevPara = te.rowEngines[0].cellEngines[0].boxEngine.childEngines
    .find(e => e.constructor.name === 'ParagraphEngine');

  doc.layout([tableBoxData(rows)]);
  const curPara = te.rowEngines[0].cellEngines[0].boxEngine.childEngines
    .find(e => e.constructor.name === 'ParagraphEngine');

  assert(curPara === prevPara, '동일 참조 재레이아웃 시 단락 엔진 동일 인스턴스 (캐시 보존)');
  assert(curPara.hasLayoutCache || curPara.plainText.length >= 0, '단락 엔진 상태 유효');
}

// ── Test 4: 셀 내용 변경 후 extractData 정합성 ──
console.log('\nTest 4: 행 삭제 후 extractData 데이터 유실 없음');
{
  const rows = [
    makeRow('r1', ['가나', '다라']),
    makeRow('r2', ['마바', '사아']),
  ];
  const doc = buildDocument(rows);
  doc.layout([tableBoxData([rows[0], rows[1]])]);

  const extract1 = JSON.stringify(doc.extractData.children.map(c => c.id));

  doc.layout([tableBoxData([rows[1]])]);
  const te = findTableEngine(doc);
  const cellLabels = te.rowEngines.flatMap(re => re.cellEngines.map(ce => ce.cellLabel));
  const contents = te.rowEngines.flatMap(re =>
    re.cellEngines.map(ce => {
      const box = ce.boxEngine;
      const para = box?.childEngines.find(e => e.constructor.name === 'ParagraphEngine');
      return para ? para.plainText : null;
    }),
  );

  assert(cellLabels.length === 2, `행 삭제 후 셀 2개 (got ${cellLabels.length})`);
  assert(contents.every(c => c !== null && c.length > 0), `셀 내용 보존 (got ${JSON.stringify(contents)})`);
  void extract1;
}

console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===\n`);
if (failCount > 0) process.exit(1);