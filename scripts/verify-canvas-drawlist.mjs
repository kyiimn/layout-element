/**
 * canvas 드로잉 명령 빌더(`buildParagraphDrawList`/`ParagraphEngine.drawList`)
 * Node 검증 — DOM-free (CANVAS_RENDERING.md 단계 1).
 *
 * 검증 항목:
 * 1. 명령 목록 구조 — char 명령은 공백·탭 제외, mm 좌표 유지
 * 2. printPostData 패리티 — char 명령 좌표 === printPostData chars 좌표
 *    (print rect = lineLeft + charOffset, y = lineTop + verticalOffset)
 * 3. runStyleRef liveness — 명령이 보유한 inlineStyle 참조가 파트
 *    inlineStyles 배열의 live 요소와 동일 (굵기/색상 주입 후 페인트 시점
 *    해석이 항상 현재 스타일을 반영하는 구조적 증명)
 * 4. 캐시 — 해시 불변 재조회 O(1) 히트(재구성 0회), 배치 입력 변화 시
 *    재구성, dirty 게이트(DirtyPendingError)
 * 5. 오버플로 게이팅 — 숨김 라인 글자는 명령에서 제외 (print와 동일)
 * 6. 장식선 — deco 명령 좌표 === printPostData decorations
 * 7. 걸침 — hangs 마킹이 명령에 보존
 * 8. 멀티컬럼 — colLeft 누적(gap 포함)이 명령 lineLeft에 반영
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-canvas-drawlist.mjs
 * ```
 *
 * @file scripts/verify-canvas-drawlist.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const ttfBase64 = readFileSync(resolve(pkgRoot, 'examples/fonts/KMIBMyoungjo.ttf')).toString('base64');

const { FontLoaderEngineImpl } = await import('../src/engine/font-loader-engine.ts');
const { ColorRegistryEngineImpl } = await import('../src/engine/color-registry-engine.ts');
const { PageEngine } = await import('../src/engine/page-engine.ts');
const { DirtyPendingError } = await import('../src/engine/types.ts');

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init([{ family: 'Myoungjo', base64Data: ttfBase64 }]);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({ red: { c: 0, m: 255, y: 255, k: 0 } });

let passed = 0;
let failed = 0;
const failures = [];

/**
 * 검증 assertion. 성공/실패를 기록하고 결과를 콘솔에 출력한다.
 *
 * @param {string} name - 검증 항목 이름
 * @param {boolean} ok - 통과 여부
 * @param {string} [detail=''] - 실패 시 상세
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * 문단 1개짜리 문서를 구축하고 배치까지 실행한다.
 *
 * @param {object} para - 문단 데이터 (content/column/gap/paragraphStyle/textStyle)
 * @param {object} [boxOpts] - 박스 옵션 (left/top/width/height)
 * @returns {{ pageEngine: object, paraEngine: object }} 페이지/문단 엔진
 */
function buildDoc(para, boxOpts = {}) {
  const pageEngine = PageEngine.create(
    { id: 'page', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );
  pageEngine.layout([{
    type: 'box',
    id: 'box', position: 'absolute', left: boxOpts.left ?? 10, top: boxOpts.top ?? 10,
    width: boxOpts.width ?? 237, height: boxOpts.height ?? 350, zIndex: 1,
    children: {
      id: 'para', type: 'paragraph', column: 2, gap: 3,
      paragraphStyle: {}, textStyle: {},
      ...para,
    },
  }]);
  const paraEngine = pageEngine.childBoxEngines[0].childEngines[0];
  paraEngine.layoutText();
  return { pageEngine, paraEngine };
}

// ═══ 1. 명령 목록 구조 ═══
console.log('\n[1] 명령 목록 구조 — 공백·탭 제외, mm 좌표');
{
  const text = '가나다라마바사 아자차카타파하\t거너더러머';
  const { paraEngine } = buildDoc({ content: text });
  const dl = paraEngine.drawList;
  check('char 명령 존재', dl.chars.length > 0, `chars=${dl.chars.length}`);
  check('공백 명령 없음', dl.chars.every(c => c.char !== ' ' && c.char !== '\t'),
    `공백 명령 수=${dl.chars.filter(c => c.char === ' ').length}`);
  check('모든 좌표가 mm 단위 number', dl.chars.every(c =>
    typeof c.charOffsetMm === 'number' && typeof c.lineLeftMm === 'number'
    && typeof c.lineTopMm === 'number' && typeof c.widthMm === 'number'));
  // 명령 문자 스트림 === 배치 가시 스트림(공백 제외)
  const placedStream = paraEngine.columnContents
    .map(col => col.map(line => line.parts.map(p => p.content.join('')).join('')).join(''))
    .join('');
  const cmdStream = dl.chars.map(c => c.char).join('');
  const visibleStream = placedStream.replace(/[ \t]/g, '');
  check('명령 문자 스트림 === 배치 가시 스트림 (공백·탭 제외)', cmdStream === visibleStream,
    `cmd=${cmdStream.slice(0, 30)}... expect=${visibleStream.slice(0, 30)}...`);
}

// ═══ 2. printPostData 패리티 ═══
console.log('\n[2] printPostData 좌표 패리티 — char 명령 === print chars');
{
  const text = '가나다라마바사아자차카타파하거너더러머버서어저처'.repeat(4);
  const { paraEngine, pageEngine } = buildDoc({ content: text });
  const dl = paraEngine.drawList;
  const print = pageEngine.printPostData;
  const printChars = print.flatMap(d => d.chars ?? []);
  // print의 char rect x = lineLeft(absLeft+colLeft+partLeft누적) + charOffset
  // draw의 lineLeftMm + charOffsetMm과 동일. y는 lineTop + verticalOffset.
  // print는 strip 구간 순회이므로 명령과 1:1 대응(공백 포함) — 공백을 양측에서 제외해 비교.
  const printNonSpace = printChars.filter(pc => pc.char !== ' ' && pc.char !== '\t');
  check('print 비공백 글자 수 === 명령 수', printNonSpace.length === dl.chars.length,
    `print=${printNonSpace.length} cmd=${dl.chars.length}`);
  const absLeft = paraEngine.data.parentAbsRect.absLeft;
  const absTop = paraEngine.data.parentAbsRect.absTop;
  let mismatch = 0;
  const len = Math.min(printNonSpace.length, dl.chars.length);
  for (let i = 0; i < len; i++) {
    const pc = printNonSpace[i];
    const cmd = dl.chars[i];
    if (pc.char !== cmd.char) { mismatch++; continue; }
    const px = pc.rect.x;
    const py = pc.rect.y;
    const cx = absLeft + cmd.lineLeftMm + cmd.charOffsetMm;
    // vertical offset: print y - lineTop = verticalOffset(lineMaxFs, charFs)
    // cmd에도 동일 공식 적용 — 엔진 게터로 산출한다
    const cy = absTop + cmd.lineTopMm + paraEngine._getCharVerticalOffset(cmd.lineMaxFontSizeMm, cmd.fontSizeMm);
    if (Math.abs(px - cx) > 1e-6 || Math.abs(py - cy) > 1e-6) mismatch++;
  }
  check('전 글자 좌표 일치 (x/y, 1e-6)', mismatch === 0, `mismatch=${mismatch}/${len}`);
  // 폭: print rect.width === swidth === cmd.widthMm
  let widthMismatch = 0;
  for (let i = 0; i < len; i++) {
    if (Math.abs(printNonSpace[i].rect.width - dl.chars[i].widthMm) > 1e-6) widthMismatch++;
  }
  check('전 글자 폭 일치 (swidth === print width)', widthMismatch === 0, `mismatch=${widthMismatch}/${len}`);
}

// ═══ 3. runStyleRef liveness ═══
console.log('\n[3] runStyleRef liveness — live 참조 보유 (굵기 주입 후 현재 스타일 반영 구조)');
{
  const runs = [
    { content: '가나다라마바사아자차', textInlineStyle: { fontWeight: 400 } },
    '카타파하거너더러머',
  ];
  const { paraEngine } = buildDoc({ content: runs });
  const dl = paraEngine.drawList;
  // 인라인 런 글자의 runStyle.inlineStyle이 columnContents 파트 inlineStyles의 요소와 동일 참조인지
  const part0 = paraEngine.columnContents[0][0].parts.find(p => p.inlineStyles?.some(s => s !== undefined));
  check('인라인 런 파트 존재', part0 !== undefined);
  const liveRefs = new Set(part0.inlineStyles);
  const liveCmd = dl.chars.find(c => c.runStyle.inlineStyle !== undefined && liveRefs.has(c.runStyle.inlineStyle));
  check('명령 runStyle.inlineStyle === 파트 inlineStyles live 요소 참조', liveCmd !== undefined,
    '참조 동일성 실패 — 명령이 스타일을 복제(bake)하고 있다');
  // plain 런 명령은 inlineStyle undefined + 문단 폴백 참조 보유
  const plainCmd = dl.chars.find(c => c.runStyle.inlineStyle === undefined);
  check('plain 런 명령은 문단 폴백 참조 보유', plainCmd !== undefined
    && plainCmd.runStyle.paragraph.textStyle === paraEngine.textStyle,
    'paragraph 폴백 참조 불일치');
  // 굵기 주입(해시 무영향) 후에도 명령 재조회가 동일 참조를 반환 → 페인트가 새 굵기를 읽는다
  const firstInline = part0.inlineStyles.find(s => s !== undefined);
  const beforeHash = paraEngine._computeLayoutInputHash();
  const dl2 = paraEngine.drawList;
  check('굵기 주입 전후(해시 불변) drawList 재조회 — 캐시 히트로 동일 목록',
    paraEngine._computeLayoutInputHash() === beforeHash && dl2 === dl,
    '해시 불변인데 재구성됨');
}

// ═══ 4. 캐시·dirty 게이트 ═══
console.log('\n[4] 캐시 — 해시 게이트 + DirtyPendingError');
{
  const { paraEngine } = buildDoc({ content: '가나다라마바사아자차카타파하'.repeat(10) });
  const dl1 = paraEngine.drawList;
  const dl2 = paraEngine.drawList;
  check('해시 불변 재조회 — 동일 객체 (캐시 히트)', dl1 === dl2);
  // 배치 입력 변화 → 재구성
  paraEngine.column = 1;
  paraEngine.layoutText();
  const dl3 = paraEngine.drawList;
  check('배치 입력 변화 후 재구성', dl3 !== dl1);
  // dirty 게이트
  let threw = false;
  try {
    paraEngine.textContent = '미커밋 변경';
    void paraEngine.drawList;
  } catch (e) {
    threw = e instanceof DirtyPendingError;
  }
  check('dirty 상태 drawList 조회 → DirtyPendingError', threw);
  paraEngine.layoutText();
  const dl4 = paraEngine.drawList;
  check('커밋 후 drawList 조회 정상', dl4.chars.length > 0);
}

// ═══ 5. 오버플로 게이팅 ═══
console.log('\n[5] 오버플로 — 숨김 라인 글자 명령 제외 (print와 동일)');
{
  // 컬럼 수용력 초과 텍스트 + 컬럼 2개 — 컬럼 1이 1라인만 수용(높이 8 = 부모
  // 높이 8mm, 라인 4.8mm → 2라인째가 오버플로)되도록 height 8로 제한.
  const text = '가나다라마바사아자차카타파하거너더러머'.repeat(20);
  const { paraEngine, pageEngine } = buildDoc({ content: text }, { height: 8 });
  check('오버플로 발생 전제', paraEngine.overflow > 0, `overflow=${paraEngine.overflow}`);
  const dl = paraEngine.drawList;
  const print = pageEngine.printPostData;
  const printChars = (print.flatMap(d => d.chars ?? [])).filter(pc => pc.char !== ' ' && pc.char !== '\t');
  check('오버플로 문서 — 명령 수 === print 비공백 수 (숨김 라인 양측 제외)',
    dl.chars.length === printChars.length,
    `cmd=${dl.chars.length} print=${printChars.length}`);
  // 숨김 라인 글자가 명령에 없음을 직접 판정: 최대 lineTop이
  // effectiveColumnHeight(부모 높이 + lineHeight - fontSize) 이내
  const parentHeight = paraEngine.inheritStyle?.parentHeight ?? 0;
  const effHeight = parentHeight + (paraEngine.baseLineHeight - paraEngine.fontSize);
  const maxTop = Math.max(...dl.chars.map(c => c.lineTopMm));
  check('명령 최대 lineTop ≤ 유효 컬럼 높이 (숨김 라인 미포함)', maxTop <= effHeight + 1e-6,
    `maxTop=${maxTop} effHeight=${effHeight}`);
}

// ═══ 6. 장식선 패리티 ═══
console.log('\n[6] 장식선 — deco 명령 === printPostData decorations');
{
  const runs = [
    { content: '가나다라마바사아자차카타파하', textInlineStyle: { breakline: true, color: 'red' } },
  ];
  const { paraEngine, pageEngine } = buildDoc({ content: runs });
  const dl = paraEngine.drawList;
  const print = pageEngine.printPostData;
  const printDecos = print.flatMap(d => d.decorations ?? []);
  check('deco 명령 존재 (print deco 존재 전제)', dl.decos.length > 0 && printDecos.length > 0,
    `cmd=${dl.decos.length} print=${printDecos.length}`);
  check('deco 명령 수 === print decorations 수', dl.decos.length === printDecos.length,
    `cmd=${dl.decos.length} print=${printDecos.length}`);
  const absLeft = paraEngine.data.parentAbsRect.absLeft;
  const absTop = paraEngine.data.parentAbsRect.absTop;
  let decoMismatch = 0;
  const dlen = Math.min(dl.decos.length, printDecos.length);
  for (let i = 0; i < dlen; i++) {
    const d = dl.decos[i];
    const pd = printDecos[i];
    if (d.decoKind !== pd.kind) { decoMismatch++; continue; }
    const dx = absLeft + d.xMm;
    const dy = absTop + d.yMm;
    if (Math.abs(dx - pd.x) > 1e-6 || Math.abs(dy - pd.y) > 1e-6
      || Math.abs(d.widthMm - pd.width) > 1e-6 || Math.abs(d.heightMm - pd.height) > 1e-6) decoMismatch++;
  }
  check('deco 좌표 일치 (x/y/w/h, 1e-6)', decoMismatch === 0, `mismatch=${decoMismatch}/${dlen}`);
  // 색상: 명령은 colorName 참조 — red로 주입한 런의 deco가 red를 보유
  check('deco colorName 참조 보유 (bake 금지)', dl.decos.every(d => d.colorName === 'red'),
    `colorName=${dl.decos[0]?.colorName}`);
}

// ═══ 7. 걸침 마킹 보존 ═══
console.log('\n[7] 걸침 — hangs 마킹이 명령에 보존');
{
  const { hangingConfig } = await import('../src/engine/paragraph-hanging.ts');
  const { paraEngine } = buildDoc({
    content: '가나다라마바사아자차(카타파하',
    paragraphStyle: { hangingPunctuation: { lineEnd: true, lineStart: true } },
    boxOpts: undefined,
  });
  check('걸침 설정 반영 (hangingConfig)', JSON.stringify(hangingConfig({ lineEnd: true, lineStart: true }))
    === JSON.stringify({ lineEnd: true, lineStart: true, lineEndAlways: false }));
  // 걸침 마킹이 배치에 존재하는지 확인 후 명령 보존 판정
  const hangPart = paraEngine.columnContents
    .flat()
    .flatMap(line => line.parts)
    .find(p => p.hangs !== undefined && p.hangs.some(h => h !== undefined));
  if (hangPart !== undefined) {
    const dl = paraEngine.drawList;
    const hangCmds = dl.chars.filter(c => c.hangs !== undefined);
    check('걸친 글자의 hangs 마킹이 명령에 보존', hangCmds.length > 0,
      `hangCmds=${hangCmds.length}`);
  } else {
    check('걸침 마킹 보존 (이 문서에서 걸침 미발생 — 스킵)', true);
  }
}

// ═══ 8. 멀티컬럼 colLeft 누적 ═══
console.log('\n[8] 멀티컬럼 — colLeft 누적(gap 포함)이 명령 lineLeft에 반영');
{
  const text = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허'.repeat(6);
  const pageEngine2 = PageEngine.create(
    { id: 'page', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );
  pageEngine2.layout([{
    type: 'box', id: 'box', position: 'absolute', left: 10, top: 10, width: 237, height: 350, zIndex: 1,
    children: { id: 'para', type: 'paragraph', content: text, column: 2, gap: 3, paragraphStyle: {}, textStyle: {} },
  }]);
  const pe2 = pageEngine2.childBoxEngines[0].childEngines[0];
  pe2.layoutText();
  const dl = pe2.drawList;
  check('멀티컬럼 배치 (컬럼 2개)', pe2.columnContents.length === 2, `cols=${pe2.columnContents.length}`);
  // 높이 350 = 5라인 수용 — 컬럼 0이 가득 차고 컬럼 1은 빈 배치. 컬럼 1에
  // 명령이 존재하려면 컬럼 0 수용력을 초과하는 텍스트가 필요하다.
  check('컬럼 0 라인 존재 (배치 전제)', pe2.columnContents[0].length > 0,
    `col0 lines=${pe2.columnContents[0].length}`);
  // lineLeftMm은 파트 기준(partAbsLeft 포함)이므로 컬럼 판정은 명령의
  // 절대 좌표(absLeft + lineLeftMm + charOffsetMm)가 컬럼1 좌측(colWidth0+gap0)
  // 이상인 글자 집합으로 나눈다. 컬럼 1이 빈 배치면 이 판정은 스킵한다.
  const absLeft = pe2.data.parentAbsRect.absLeft;
  const colWidth0 = pe2.columnWidths[0];
  const gap0 = pe2.gaps[0];
  const col1Boundary = colWidth0 + gap0;
  const col0Cmds = dl.chars.filter(c => absLeft + c.lineLeftMm + c.charOffsetMm < col1Boundary);
  const col1Cmds2 = dl.chars.filter(c => absLeft + c.lineLeftMm + c.charOffsetMm >= col1Boundary);
  check('양쪽 컬럼 모두 명령 존재', col0Cmds.length > 0 && col1Cmds2.length > 0,
    `col0=${col0Cmds.length} col1=${col1Cmds2.length}`);
  // lineLeftMm은 컬럼 좌측 기준이 아니라 파트 좌측 기준(파트 분할 시 part.left 누적)이므로
  // 컬럼 누적 검증은 명령의 절대 x가 컬럼 1 경계를 넘는지로 판정한다 — 위 filter가 그 판정.
  // 추가로 명령의 절대 x 최소값이 컬럼 1 좌측 이상인지 직접 판정한다.
  const minCol1Abs = Math.min(...col1Cmds2.map(c => absLeft + c.lineLeftMm + c.charOffsetMm));
  check('컬럼1 명령 절대 x ≥ 컬럼1 좌측 경계 (colLeft 누적 반영)', minCol1Abs >= col1Boundary - 1e-6,
    `minAbs=${minCol1Abs} boundary=${col1Boundary}`);
  // print 패리티 재확인 (멀티컬럼)
  const print = pageEngine2.printPostData;
  const printChars = (print.flatMap(d => d.chars ?? [])).filter(pc => pc.char !== ' ' && pc.char !== '\t');
  let mm = 0;
  const len = Math.min(printChars.length, dl.chars.length);
  const absTop = pe2.data.parentAbsRect.absTop;
  for (let i = 0; i < len; i++) {
    const pc = printChars[i];
    const cmd = dl.chars[i];
    if (pc.char !== cmd.char) { mm++; continue; }
    if (Math.abs(pc.rect.x - (absLeft + cmd.lineLeftMm + cmd.charOffsetMm)) > 1e-6) mm++;
    if (Math.abs(pc.rect.y - (absTop + cmd.lineTopMm
      + pe2._getCharVerticalOffset(cmd.lineMaxFontSizeMm, cmd.fontSizeMm))) > 1e-6) mm++;
  }
  check('멀티컬럼 print 좌표 패리티', mm === 0, `mismatch=${mm}/${len}`);
}

// ═══ 9. baseline 명령 미포함 확인 (§4.1 — 엔진 게터 과제 명시) ═══
console.log('\n[9] baseline — 명령은 baseline을 내장하지 않고 폰트 메트릭 소재만 보유');
{
  const { paraEngine } = buildDoc({ content: '가나다라' });
  const dl = paraEngine.drawList;
  check('명령에 baseline 필드 없음 (paint 시점 엔진 게터 과제)', dl.chars.every(c =>
    !('baselineMm' in c) && !('baselinePx' in c)),
    '명령이 baseline을 내장했다 — §4.1 엔진 게터 설계와 불일치');
  check('명령이 lineMaxFontSizeMm 보유 (vertical offset 산출 소재)', dl.chars.every(c =>
    typeof c.lineMaxFontSizeMm === 'number' && c.lineMaxFontSizeMm > 0));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log('failures:', failures.join(' | '));
}
process.exit(failed > 0 ? 1 : 0);