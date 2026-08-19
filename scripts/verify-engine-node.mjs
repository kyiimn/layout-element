/**
 * 엔진 계층 Node.js 호환성 검증 스크립트.
 *
 * 브라우저 환경(window, document, canvas, FontFace) 없이
 * 엔진 계층이 정상 동작하는지 검증한다.
 *
 * 실행: node --experimental-vm-modules scripts/verify-engine-node.mjs
 * 또는: npm run verify:engine (package.json에 스크립트 추가 시)
 *
 * @file scripts/verify-engine-node.mjs
 */

// DOM globals가 없는 순수 Node 환경에서 실행되는지 확인
if (typeof window !== 'undefined' || typeof document !== 'undefined') {
  console.error('FAIL: 이 스크립트는 브라우저가 아닌 Node.js에서 실행되어야 합니다.');
  process.exit(1);
}

import { GridCalculatorEngine } from '../src/engine/grid-calculator-engine.ts';
import { ImageEngine } from '../src/engine/image-engine.ts';
import { computeOverlapSizeMm, checkOverlapMm } from '../src/engine/overlap-engine.ts';
import { BoxEngine } from '../src/engine/box-engine.ts';
import { FontLoaderEngineImpl } from '../src/engine/font-loader-engine.ts';
import { ColorRegistryEngineImpl } from '../src/engine/color-registry-engine.ts';

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

console.log('\n=== Engine Node.js Compatibility Test ===\n');

// ── Test 1: GridCalculatorEngine ──
console.log('Test 1: GridCalculatorEngine');
try {
  const grid = GridCalculatorEngine.create(
    {
      width: 257,
      height: 370,
      columns: 6,
      gap: 3,
      paragraphStyle: { lineGap: 1.2 },
      textStyle: { fontSize: 4 },
      isBox: false,
    },
    3.78,
  );

  assert(grid.columnCount === 6, 'columnCount === 6');
  assert(grid.lineHeight === 4.8, `lineHeight === 4.8 (got ${grid.lineHeight})`);
  assert(grid.columnCoords.length === 6, 'columnCoords.length === 6');
  assert(grid.editableWidth > 0, `editableWidth > 0 (got ${grid.editableWidth})`);
  assert(grid.editableHeight > 0, `editableHeight > 0 (got ${grid.editableHeight})`);
  assert(grid.ppm === 3.78, 'ppm === 3.78 (injected)');
  assert(typeof grid.fontSize === 'number', 'fontSize is number');
  assert(typeof grid.lineGap === 'number', 'lineGap is number');
} catch (e) {
  failCount++;
  console.error(`  ✗ GridCalculatorEngine threw: ${e.message}`);
}

// ── Test 2: ImageEngine with synthetic RGBA ──
console.log('\nTest 2: ImageEngine (RGBA overlap)');
try {
  // 4x4 픽셀, 모두 불투명 (alpha=255)
  const rgbaData = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    rgbaData[i * 4 + 3] = 255; // alpha
  }

  const imgEngine = ImageEngine.create({
    url: 'test.png',
    dpi: 72,
    overlapMode: 'path',
    objectFit: 'cover',
  });

  imgEngine.rgbaData = { data: rgbaData, width: 4, height: 4 };

  const lineRect = {
    left: 0, right: 40, top: 0, bottom: 4.8, width: 40, height: 4.8,
  };
  const imgRect = { absLeft: 0, absTop: 0, absWidth: 40, absHeight: 30 };

  const result = imgEngine.computeOverlap(lineRect, imgRect);
  assert(result.direction === 'COVERS' || result.direction === 'PART', `overlap direction is COVERS or PART (got ${result.direction})`);
  assert(imgEngine.overlapMode === 'path', 'overlapMode === path');
} catch (e) {
  failCount++;
  console.error(`  ✗ ImageEngine threw: ${e.message}`);
}

// ── Test 3: computeOverlapSizeMm (pure function) ──
console.log('\nTest 3: computeOverlapSizeMm (pure function)');
try {
  const lineRect = { left: 0, right: 100, top: 0, bottom: 4.8, width: 100, height: 4.8 };
  const overlay = {
    absRect: { absLeft: 50, absTop: 0, absWidth: 60, absHeight: 30 },
    overlapMode: 'box',
    overlapPadding: undefined,
    image: null,
    contentType: 'image',
  };

  const result = computeOverlapSizeMm(lineRect, overlay);
  // overlay: 50-110, line: 0-100 → overlay covers right part of line → PART
  assert(result.direction === 'PART', `box mode PART (got ${result.direction})`);
  assert(result.parts.length > 0, 'parts not empty');
} catch (e) {
  failCount++;
  console.error(`  ✗ computeOverlapSizeMm threw: ${e.message}`);
}

// ── Test 4: checkOverlapMm ──
console.log('\nTest 4: checkOverlapMm');
try {
  const a = { absLeft: 0, absTop: 0, absWidth: 100, absHeight: 50 };
  const b = { absLeft: 50, absTop: 25, absWidth: 100, absHeight: 50 };
  assert(checkOverlapMm(a, b) === true, 'overlapping rects return true');

  const c = { absLeft: 200, absTop: 200, absWidth: 10, absHeight: 10 };
  assert(checkOverlapMm(a, c) === false, 'non-overlapping rects return false');
} catch (e) {
  failCount++;
  console.error(`  ✗ checkOverlapMm threw: ${e.message}`);
}

// ── Test 5: FontLoaderEngineImpl ──
console.log('\nTest 5: FontLoaderEngineImpl');
try {
  const fontEngine = FontLoaderEngineImpl.create();
  assert(fontEngine.ready === false, 'not ready before init');
  // init without fonts (empty array — should not throw)
  await fontEngine.init([]);
  assert(fontEngine.ready === true, 'ready after init');
  // getParsedFont now throws when not ready or no fonts
  let threw = false;
  try {
    fontEngine.getParsedFont();
  } catch (e) {
    threw = true;
  }
  assert(threw === true, 'getParsedFont throws with no fonts');
} catch (e) {
  failCount++;
  console.error(`  ✗ FontLoaderEngineImpl threw: ${e.message}`);
}

// ── Test 6: ColorRegistryEngineImpl ──
console.log('\nTest 6: ColorRegistryEngineImpl');
try {
  const colorEngine = ColorRegistryEngineImpl.create();
  assert(colorEngine.ready === false, 'not ready before init');
  colorEngine.init({ red: { c: 0, m: 255, y: 255, k: 0 } });
  assert(colorEngine.ready === true, 'ready after init');
  const red = colorEngine.getCSSColor('red');
  assert(red === '#FF0000', `getCSSColor('red') === '#FF0000' (got ${red})`);
  const opacity = colorEngine.getOpacityHex(0.5);
  assert(opacity === '80', `getOpacityHex(0.5) === '80' (got ${opacity})`);
} catch (e) {
  failCount++;
  console.error(`  ✗ ColorRegistryEngineImpl threw: ${e.message}`);
}

// ── Test 7: No DOM globals leaked ──
console.log('\nTest 7: No DOM globals leaked');
try {
  assert(typeof document === 'undefined', 'document is undefined');
  assert(typeof window === 'undefined', 'window is undefined');
  assert(typeof HTMLCanvasElement === 'undefined', 'HTMLCanvasElement is undefined');
  assert(typeof FontFace === 'undefined', 'FontFace is undefined');
} catch (e) {
  failCount++;
  console.error(`  ✗ DOM leak check threw: ${e.message}`);
}

// ── Summary ──
console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===\n`);
process.exit(failCount > 0 ? 1 : 0);