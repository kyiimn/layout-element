/**
 * _layoutColumnsPass 리팩터링 전후 정확성 검증.
 *
 * 동일 입력(시드 고정 텍스트)에 대한 columnContents + overflow 스냅샷을
 * 직렬화하여 출력. 리팩터링 전 커밋과 후 커밋에서 각각 실행해
 * 출력을 비교하여 배치 결과가 byte 단위로 동일한지 확인한다.
 *
 * 실행: npx tsx scripts/snapshot-layout.mjs > /tmp/opencode/snapshot-{before|after}.json
 * 비교: diff /tmp/opencode/snapshot-before.json /tmp/opencode/snapshot-after.json
 *
 * @file scripts/snapshot-layout.mjs
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

// 시드 고정 PRNG — 매 실행 동일 텍스트
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const syllables = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허';

function makeText(charCount, seed) {
  const rand = mulberry32(seed);
  const parts = [];
  let len = 0, wordLen = 0;
  while (len < charCount) {
    parts.push(syllables[Math.floor(rand() * syllables.length)]);
    len++; wordLen++;
    if (wordLen >= 3 && rand() < 0.25) { parts.push(' '); len++; wordLen = 0; }
  }
  return parts.join('');
}

function snapshotCase(text, columns) {
  const engine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );
  engine.layout([{
    type: 'box',
    id: 'box', position: 'absolute', left: 10, top: 10, width: 237, height: 350, zIndex: 1,
    children: {
      id: 'para', type: 'paragraph', content: text, column: columns, gap: 3,
      paragraphStyle: {}, textStyle: {},
    },
  }]);
  const paraEngine = engine.childBoxEngines[0].childEngines[0];
  paraEngine.layoutText();
  return {
    overflow: paraEngine.overflow,
    columns: paraEngine.columnContents.map(column =>
      column.map(line => ({
        flags: {
          firstOfBlock: line.firstOfBlock ?? null,
          firstOfText: line.firstOfText ?? null,
          endOfBlock: line.endOfBlock ?? null,
          endOfText: line.endOfText ?? null,
        },
        parts: line.parts.map(part => ({
          left: part.left,
          width: part.width,
          content: part.content.join(''),
          charOffsets: part.charOffsets,
          inlineStyleCount: part.inlineStyles ? part.inlineStyles.filter(s => s !== undefined).length : -1,
        })),
      })),
    ),
  };
}

const cases = [];
for (const [chars, cols] of [[50, 1], [300, 1], [1000, 2], [1000, 3], [2000, 6]]) {
  cases.push({ label: `${chars}자/${cols}컬럼`, seed: chars * 7 + cols, result: snapshotCase(makeText(chars, chars * 7 + cols), cols) });
}

// 인라인 런 포함 케이스
{
  const text = makeText(400, 99);
  const runs = [];
  for (let i = 0; i < 8; i++) {
    const seg = text.slice(i * 50, (i + 1) * 50);
    if (i % 2 === 0) runs.push({ content: seg, textInlineStyle: { fontWeight: 700 } });
    else runs.push(seg);
  }
  cases.push({ label: '인라인런8개/400자/3컬럼', seed: 99, result: snapshotCase(runs, 3) });
}

console.log(JSON.stringify(cases, null, 1));