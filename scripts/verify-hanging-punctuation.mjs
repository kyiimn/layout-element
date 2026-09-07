/**
 * 걸침표 (hanging punctuation) 전 파이프라인 정합성 검증 (Node).
 *
 * 배경: 걸침은 금칙(禁則) 교정에 우선하는 라인 경계 후처리다. 금칙 패스는
 * 행두 금지 위반(닫기 부호가 아래 줄 시작)을 부호를 위 줄 끝으로 당겨
 * in-flow 넘침을 허용하는 방식으로, 행말 금지 위반(열기 부호가 위 줄 끝)을
 * 부호를 아래 줄 앞으로 내리는 방식으로 교정한다. 걸침은 **같은 이동**을
 * 수행하되 부호를 틀 밖(행말: 파트 우측, 행두: 파트 좌측)에 배치해
 * visible 글자가 전체 폭을 활용하도록 한다.
 *
 * 검증 항목:
 * 1.  OFF 기준선 — hangingPunctuation 미주입/false/빈 객체 모두 byte 동일
 * 2.  행말 걸침 — 닫기 부호가 위 줄 끝으로 당겨지고 charOffset === partWidth.
 *     금칙(OFF)은 같은 이동을 in-flow(charOffset === Σ visible 폭)로 수행
 * 3.  행두 걸침 — 열기 부호가 아래 줄 앞으로 내려가고 charOffset === -swidth,
 *     이후 글자 offset 0부터. 금칙(OFF)은 같은 이동을 in-flow(offset 0)로 수행
 * 4.  정렬 산출 — left/justify 모두 걸침 글자를 폭 합계/분배에서 제외하고
 *     visible 글자만 정렬. justify는 걸침 글자를 뺀 visibleCount 기준 분배
 * 5.  trailing run — 여러 닫기 부호(").")가 연속하면 전체가 당겨지고
 *     오프셋이 스택형 (offset[i+1] === offset[i] + width[i])
 * 6.  캐시 해시 — 같은 텍스트로 ON 토글 시 재래핑 (hp: 해시), 재토글 시
 *     원본 복원 (stale 캐시 방어)
 * 7.  getCharRect — 걸침 글자 폭이 실측 swidth(> 0), 좌표가 파트 경계 밖
 * 8.  printPostData 패리티 — 걸침 글자 print rect === getCharRect (mm)
 * 9.  getOffsetFromPoint — 걸침 글자 클릭 히트 범위가 파트 밖까지 확장
 *     (좌측 절반 → 걸침 글자, 우측 절반 → 다음 오프셋)
 * 10. 엣지 게이트 — 오버랩으로 마지막 파트가 컬럼 우측 끝에 닿지 않는
 *     라인은 걸침하지 않고 금칙 폴백 (OFF 결과와 deep equal)
 * 11. 블록 경계 — `\n` 경계 쌍은 걸침 마킹하지 않음. 글자 이동은 기존
 *     금칙 동작(경계 쌍도 처리)이 그대로 수행되므로 OFF와 deep equal
 * 12. prefix 캐시 — 타이핑 경로에서 걸침 마킹이 보존되고 전체 재래핑과
 *     deep equal
 * 13. API — genColumnStyle overflow 조건화, extractData round-trip,
 *     effective 기본값 false
 * 14. 방향별 설정 — lineEnd만 ON일 때 행두 교정은 금칙 폴백 유지
 *     (라인 수 불변 ON/OFF 동일성은 Test 2에서 함께 검증)
 *
 * 실행: npx tsx scripts/verify-hanging-punctuation.mjs
 *
 * @file scripts/verify-hanging-punctuation.mjs
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
/**
 * 검증 어설션. 통과/실패를 카운트하고 콘솔에 기록한다.
 *
 * @param {boolean} condition - 검증 조건
 * @param {string} message - 결과 메시지
 * @returns 없음
 * @throws 없음
 */
function assert(condition, message) {
  if (condition) {
    passCount++;
    console.log(`  ✓ ${message}`);
  } else {
    failCount++;
    console.error(`  ✗ ${message}`);
  }
}

/**
 * 부동소수점 근사 비교.
 *
 * @param {number} a - 비교값 1
 * @param {number} b - 비교값 2
 * @param {number} [eps=1e-6] - 허용 오차
 * @returns {boolean} 두 값의 차가 허용 오차 미만이면 `true`
 * @throws 없음
 */
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/**
 * DocumentEngine + 단일 문단 박스로 엔진 트리를 구성하고 layout을 실행한다.
 *
 * @param {string | object[]} content - 문단 텍스트
 * @param {object} [opts] - { boxWidth, boxHeight, columns, fontSize,
 *   hangingPunctuation, textAlign, siblings }
 * @returns {object} ParagraphEngine 인스턴스 (layoutText까지 완료된 상태)
 * @throws 없음
 */
function buildPara(content, opts = {}) {
  const {
    boxWidth = 40,
    boxHeight = 26,
    columns = 1,
    fontSize = 4,
    hangingPunctuation,
    textAlign,
    siblings = [],
  } = opts;

  const childPs = {};
  if (hangingPunctuation !== undefined) childPs.hangingPunctuation = hangingPunctuation;
  if (textAlign !== undefined) childPs.textAlign = textAlign;

  const docEngine = DocumentEngine.create(
    { id: 'doc', width: 257, height: 370, columns: 6, gap: 3, paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.layout([
    {
      type: 'box',
      id: 'box', position: 'absolute', left: 10, top: 10, width: boxWidth, height: boxHeight, zIndex: 1,
      children: {
        id: 'para', type: 'paragraph', content, column: columns, gap: 3,
        paragraphStyle: childPs, textStyle: {},
      },
    },
    ...siblings,
  ]);
  const paraEngine = docEngine.findEngineById('para');
  paraEngine.layoutText();
  return paraEngine;
}

/**
 * columnContents의 비교용 직렬화. hangs의 undefined 슬롯은 JSON에서 누락되므로
 * OFF 기준선과의 deep equal 비교에 그대로 사용할 수 있다.
 *
 * @param {object} para - ParagraphEngine 인스턴스
 * @returns {string} JSON 직렬화 문자열
 * @throws 없음
 */
const snapshot = (para) => JSON.stringify(para.columnContents);

// ── 런타임 폭 측정 — 기대값은 측정값으로 구성 (폭 공식 변경에 견고) ──
const probe = buildPara('가');
const gaW = probe.getCharWidths('가').swidth;
const dotW = probe.getCharWidths('.').swidth;
const openW = probe.getCharWidths('(').swidth;
const baW = probe.getCharWidths('바').swidth;
const parenW = probe.getCharWidths(')').swidth;

// 행말 걸침용 컬럼 폭: 12자 딱 들어가고 '.'는 안 들어감
const W_END = 12 * gaW + 0.5 * dotW;
// 행두 걸침용 컬럼 폭: 12자 + '('까지 들어가고 '바'는 안 들어감
const W_START = 12 * gaW + openW + 0.5 * baW;
// trailing run용 컬럼 폭: 12자 딱 들어가고 ')'와 '.' 둘 다 안 들어감
// (min 폭의 0.9배 마진 — 어느 부호가 더 좁든 둘 다 초과)
const W_RUN = 12 * gaW + 0.9 * Math.min(parenW, dotW);

const ga12 = '가'.repeat(12);

console.log('\n=== 걸침표 (hanging punctuation) 전 파이프라인 검증 ===');
console.log(`(실측: 가=${gaW.toFixed(4)}mm, .=${dotW.toFixed(4)}mm, (=${openW.toFixed(4)}mm, 바=${baW.toFixed(4)}mm, )=${parenW.toFixed(4)}mm)\n`);

// ═══ 1. OFF 기준선 — 주입 형태 무관 byte 동일 ═══
console.log('Test 1: OFF 기준선 — hangingPunctuation undefined/false/{} 모두 동일');
{
  const content = ga12 + '.' + '바'.repeat(5);
  const a = buildPara(content, { boxWidth: W_END });
  const b = buildPara(content, { boxWidth: W_END, hangingPunctuation: false });
  const c = buildPara(content, { boxWidth: W_END, hangingPunctuation: {} });
  assert(a.paragraphStyle.hangingPunctuation === false, 'OFF 시 effective 기본값 === false');
  assert(snapshot(a) === snapshot(b), 'undefined === false (deep equal)');
  assert(snapshot(a) === snapshot(c), 'undefined === {} 빈 설정 (deep equal)');
}

// ═══ 2. 행말 걸침 ═══
console.log('\nTest 2: 행말 걸침 — 닫기 부호 당겨짐 + 금칙 push-down 대체');
{
  const content = ga12 + '.' + '바'.repeat(5);
  const on = buildPara(content, { boxWidth: W_END, hangingPunctuation: true, textAlign: 'left' });
  const off = buildPara(content, { boxWidth: W_END, textAlign: 'left' });

  const line0 = on.columnContents[0][0];
  const part0 = line0.parts[0];
  assert(part0.content.length === 13 && part0.content[12] === '.',
    `위 줄 끝에 '.' 당겨짐 (content ${part0.content.length}자, 마지막='${part0.content[part0.content.length - 1]}')`);
  assert(part0.hangs?.[12] === 'end', "hangs[12] === 'end'");
  assert(approx(part0.charOffsets[12], W_END), `걸침 글자 charOffset === partWidth ${W_END.toFixed(3)} (got ${part0.charOffsets[12]?.toFixed(3)})`);
  assert(approx(part0.charOffsets[0], 0) && approx(part0.charOffsets[11], 11 * gaW),
    'visible 글자 오프셋 좌측 정렬 유지 (0, 11×가폭)');
  assert(on.columnContents[0][1].parts[0].content[0] === '바',
    `아래 줄이 '.'로 시작하지 않음 ('${on.columnContents[0][1].parts[0].content[0]}')`);

  const offLine0 = off.columnContents[0][0];
  assert(offLine0.parts[0].content.length === 13,
    `OFF(금칙) 시 '.'가 위 줄 끝으로 in-flow 당겨짐 — ${offLine0.parts[0].content.length}자 (넘침 허용)`);
  assert(approx(offLine0.parts[0].charOffsets[12], 12 * gaW),
    `OFF: '.' offset in-flow ${12 * gaW} (got ${offLine0.parts[0].charOffsets[12]?.toFixed(3)}) — ON은 partWidth ${W_END} 밖`);
  const totalLines = (p) => p.columnContents.reduce((s, c) => s + c.length, 0);
  assert(totalLines(on) === totalLines(off), `라인 수 불변 (ON ${totalLines(on)} === OFF ${totalLines(off)})`);
}

// ═══ 3. 행두 걸침 ═══
console.log('\nTest 3: 행두 걸침 — 열기 부호 내려감 + 금칙 pull-up 대체');
{
  const content = ga12 + '(' + '바'.repeat(6);
  const on = buildPara(content, { boxWidth: W_START, hangingPunctuation: true, textAlign: 'left' });
  const off = buildPara(content, { boxWidth: W_START, textAlign: 'left' });

  const line0 = on.columnContents[0][0];
  const line1 = on.columnContents[0][1];
  assert(line0.parts[0].content.length === 12 && line0.parts[0].content[11] === '가',
    `위 줄에서 '(' 제거 (content ${line0.parts[0].content.length}자)`);
  assert(line1.parts[0].content[0] === '(' && line1.parts[0].hangs?.[0] === 'start',
    "아래 줄 앞에 '(' + hangs[0] === 'start'");
  assert(approx(line1.parts[0].charOffsets[0], -openW),
    `걸침 글자 charOffset === -swidth ${(-openW).toFixed(3)} (got ${line1.parts[0].charOffsets[0]?.toFixed(3)})`);
  assert(approx(line1.parts[0].charOffsets[1], 0) && approx(line1.parts[0].charOffsets[2], baW),
    '이후 글자 오프셋 0부터 시작 (걸침 글자가 자리 안 차지)');

  const offLine0 = off.columnContents[0][0];
  const offLine1 = off.columnContents[0][1];
  assert(offLine0.parts[0].content.length === 12,
    `OFF(금칙) 시 '('가 아래 줄 앞으로 내려감 — 위 줄 ${offLine0.parts[0].content.length}자 (in-flow)`);
  assert(offLine1.parts[0].content[0] === '(' && offLine1.parts[0].hangs === undefined,
    "OFF: 아래 줄이 '('로 시작하되 걸침 마킹 없음 (금칙 branch 2)");
  assert(approx(offLine1.parts[0].charOffsets[0], 0),
    `OFF: '(' offset 0 (in-flow) — ON은 -swidth ${(-openW).toFixed(3)} 밖`);
}

// ═══ 4. justify — 걸침 글자 분산 제외 ═══
console.log('\nTest 4: justify — 걸침 글자를 분배에서 제외, visible 기준 균등 분산');
{
  const content = ga12 + '.' + '바'.repeat(5);
  const on = buildPara(content, { boxWidth: W_END, hangingPunctuation: true }); // 기본 justify
  const part0 = on.columnContents[0][0].parts[0];

  const visibleRemaining = Math.max(0, W_END - 12 * gaW);
  const gap = visibleRemaining / 11;
  let ok = true;
  for (let i = 0; i < 12; i++) {
    const expected = i * gaW + i * gap;
    if (!approx(part0.charOffsets[i], expected, 1e-9)) { ok = false; break; }
  }
  assert(ok, 'visible 12자가 균등 간격으로 전체 폭 분산 (걸침 글자 제외 기대치와 일치)');
  assert(approx(part0.charOffsets[12], W_END), `걸침 '.' offset === partWidth (got ${part0.charOffsets[12]?.toFixed(3)})`);
}

// ═══ 5. trailing run — 연속 닫기 부호 스택형 걸침 ═══
console.log('\nTest 5: trailing run — ")." 연속 닫기 부호 전체 당겨짐 + 스택형 오프셋');
{
  const content = ga12 + ').' + '바'.repeat(5);
  const on = buildPara(content, { boxWidth: W_RUN, hangingPunctuation: true, textAlign: 'left' });
  const part0 = on.columnContents[0][0].parts[0];

  assert(part0.content.length === 14 && part0.content[12] === ')' && part0.content[13] === '.',
    `위 줄에 run 전체 당겨짐 (14자, [12]=')' [13]='.')`);
  assert(part0.hangs?.[12] === 'end' && part0.hangs?.[13] === 'end', "hangs[12], hangs[13] === 'end'");
  assert(approx(part0.charOffsets[12], W_RUN), `첫 걸침 offset === partWidth (got ${part0.charOffsets[12]?.toFixed(3)})`);
  assert(approx(part0.charOffsets[13], W_RUN + parenW),
    `둘째 걸침 offset 스택형 === partWidth + ')'폭 (got ${part0.charOffsets[13]?.toFixed(3)})`);
  assert(on.columnContents[0][1].parts[0].content[0] === '바', "아래 줄이 ')'로 시작하지 않음");
}

// ═══ 6. 캐시 해시 — 토글 시 재래핑, 재토글 시 원복 ═══
console.log('\nTest 6: 캐시 해시 — hangingPunctuation 토글 시 stale 캐시 없음');
{
  const content = ga12 + '.' + '바'.repeat(5);
  const para = buildPara(content, { boxWidth: W_END, textAlign: 'left' });
  const offSnapshot = snapshot(para);

  para.paragraphStyle = { textAlign: 'left', hangingPunctuation: true };
  para.layoutText();
  const hungLine0 = para.columnContents[0][0].parts[0];
  assert(hungLine0.content.length === 13 && hungLine0.hangs?.[12] === 'end',
    'ON 주입만으로 재래핑 발생 (캐시 해시 hp: 무효화)');

  para.paragraphStyle = { textAlign: 'left' };
  para.layoutText();
  assert(snapshot(para) === offSnapshot, 'OFF 재주입 시 원본 배치로 정확히 복원 (stale 캐시 없음)');
}

// ═══ 7~9. 소비처 — getCharRect / printPostData / getOffsetFromPoint ═══
console.log('\nTest 7: getCharRect — 걸침 글자 폭이 실측 swidth (음수 폭 방어)');
{
  const content = ga12 + '.' + '바'.repeat(5);
  const on = buildPara(content, { boxWidth: W_END, hangingPunctuation: true, textAlign: 'left' });
  const rect = on.getCharRect(12); // '.'의 source offset
  assert(rect !== null, 'getCharRect(12) !== null');
  assert(approx(rect.width, dotW) && rect.width > 0,
    `걸침 '.' 폭 === 실측 ${dotW.toFixed(3)}mm (got ${rect?.width?.toFixed(3)})`);
  assert(approx(rect.left, 10 + W_END),
    `걸침 '.' left === 파트 우측 밖 ${10 + W_END}mm 문서 절대좌표 (got ${rect?.left?.toFixed(3)})`);
}

console.log('\nTest 8: printPostData 패리티 — 걸침 글자 print rect === getCharRect');
{
  const content = ga12 + '.' + '바'.repeat(5);
  const on = buildPara(content, { boxWidth: W_END, hangingPunctuation: true, textAlign: 'left' });
  const print = on.printPostData;
  const dotChar = print[0].chars.find(c => c.char === '.');
  const rect = on.getCharRect(12);
  assert(dotChar !== undefined, 'printPostData에 걸침 글자 포함');
  assert(approx(dotChar.rect.x, rect.left, 1e-9) && approx(dotChar.rect.width, rect.width, 1e-9),
    `print rect === getCharRect (x=${dotChar?.rect.x.toFixed(3)}, w=${dotChar?.rect.width.toFixed(3)})`);
}

console.log('\nTest 9: getOffsetFromPoint — 걸침 글자 히트 범위 파트 밖 확장');
{
  const content = ga12 + '.' + '바'.repeat(5);
  const on = buildPara(content, { boxWidth: W_END, hangingPunctuation: true, textAlign: 'left' });
  const yLine0 = 12; // 라인0 (10~14.8mm) 중앙 부근
  const leftHalf = on.getOffsetFromPoint(10 + W_END + 0.25 * dotW, yLine0);
  const rightHalf = on.getOffsetFromPoint(10 + W_END + 0.75 * dotW, yLine0);
  assert(leftHalf?.textOffset === 12, `걸침 글자 좌측 절반 클릭 → offset 12 (got ${leftHalf?.textOffset})`);
  assert(rightHalf?.textOffset === 13, `걸침 글자 우측 절반 클릭 → offset 13 (got ${rightHalf?.textOffset})`);
}

// ═══ 10. 엣지 게이트 — 오버랩 파트 라인은 걸침 금지, 금칙 폴백 ═══
console.log('\nTest 10: 엣지 게이트 — 마지막 파트가 컬럼 우측 끝 미도달 시 걸침 스킵');
{
  // 축소된 자유 영역 S: perFit자 '가' + 0.5×dotW — '.'는 확실히 안 들어감.
  // 오버랩 박스가 [S, W_END]를 덮어 라인0 파트가 [0, S]가 된다.
  const perFit = Math.floor((W_END - 8) / gaW);
  const S = perFit * gaW + 0.5 * dotW;
  const overlayW = W_END - S;
  const overlay = {
    type: 'box', id: 'ovl', position: 'absolute',
    left: 10 + S, top: 11, width: overlayW, height: 3, zIndex: 10,
    children: { id: 'ovl-para', type: 'paragraph', content: '오버랩', paragraphStyle: {}, textStyle: {} },
  };
  const content = '가'.repeat(perFit) + '.' + '바'.repeat(5);
  const on = buildPara(content, { boxWidth: W_END, hangingPunctuation: true, textAlign: 'left', siblings: [overlay] });
  const off = buildPara(content, { boxWidth: W_END, textAlign: 'left', siblings: [overlay] });

  const line0 = on.columnContents[0][0];
  const absRight = line0.parts.reduce((s, p) => s + p.left + p.width, 0);
  assert(absRight < W_END - 1e-3, `라인0 마지막 파트 절대 우측 끝 ${absRight.toFixed(2)}mm < 컬럼 폭 ${W_END.toFixed(2)}mm (전제)`);
  const anyHang = on.columnContents.flat().some(line => line.parts.some(p => p.hangs?.some(h => h !== undefined)));
  assert(!anyHang, '게이트 실패 라인은 걸침 미발생 (hangs 전무)');
  const line0Part = line0.parts[0];
  const lastIdx = line0Part.content.length - 1;
  assert(line0Part.content[lastIdx] === '.' && line0Part.hangs === undefined,
    "게이트 실패 시 '.'는 금칙 폴백으로 위 줄 끝에 in-flow 당겨짐 (hangs 마킹 없음)");
  assert(approx(line0Part.charOffsets[lastIdx], lastIdx * gaW),
    `폴백 '.' offset in-flow ${lastIdx * gaW} (got ${line0Part.charOffsets[lastIdx]?.toFixed(3)}) — 파트 폭 ${line0Part.width} 내부`);
  assert(snapshot(on) === snapshot(off), '게이트 실패 시 OFF(금칙 폴백)와 deep equal');
}

// ═══ 11. 블록 경계 — `\n` 경계 쌍 걸침 스킵 ═══
console.log('\nTest 11: 블록 경계 — \\n 경계 쌍은 걸침/이동하지 않음');
{
  const content = ga12 + '\n.' + '바'.repeat(5);
  const on = buildPara(content, { boxWidth: W_END, hangingPunctuation: true, textAlign: 'left' });
  const off = buildPara(content, { boxWidth: W_END, textAlign: 'left' });

  const line0 = on.columnContents[0][0];
  const lastChar = line0.parts[0].content[line0.parts[0].content.length - 1];
  assert(lastChar === '.', "블록 경계 쌍은 금칙(기존 동작)이 처리 — '.'가 in-flow로 당겨짐");
  assert(line0.parts[0].hangs === undefined, '블록 경계 쌍은 걸침 마킹하지 않음 (hang 패스 스킵)');
  assert(snapshot(on) === snapshot(off), '블록 경계에서 OFF(기존 동작)와 deep equal');
}

// ═══ 12. prefix 캐시 — 타이핑 경로 걸침 보존 ═══
console.log('\nTest 12: prefix 캐시 — 타이핑 경로에서 걸침 마킹 보존 + 전체 재래핑과 deep equal');
{
  const COL_W = 33.5; // (70 - 3) / 2
  const charsPerLine = Math.floor((COL_W + 1e-6) / gaW);
  // col0 라인4(0-based)의 첫 글자가 '.'가 되도록 — 라인4는 마지막 라인이
  // 아니므로 같은 컬럼 내 페어 (라인3, 라인4)가 형성되고 '.'가 라인3 끝으로
  // 당겨진다. prefix 캐시는 "1회 layoutText로 구축 → 다음 layoutText에서
  // 적용"이므로 2단계 타이핑으로 검증한다.
  const boundaryIdx = 4 * charsPerLine;
  const text1 = '가'.repeat(boundaryIdx) + '.' + '가'.repeat(30);

  const OPTS = { boxWidth: 70, boxHeight: 30, columns: 2, hangingPunctuation: true, textAlign: 'left' };
  const on = buildPara(text1, OPTS);
  const hangLineIdx = 3; // '.'가 당겨져 끝에 걸치는 라인
  const line3 = on.columnContents[0][hangLineIdx];
  assert(line3.parts[0].hangs?.[line3.parts[0].content.length - 1] === 'end',
    `컬럼1에 걸침 발생 (전제 — ${boundaryIdx}번째 글자 '.'가 라인4 시작)`);

  // 타이핑 1: 커서 힌트(컬럼2 안)와 함께 layoutText → 전체 재래핑 + 캐시 구축
  on.textContent = text1 + '바';
  on.caretHint = text1.length; // text1.length < text1+'바'.length, 컬럼2 안
  on.layoutText();

  // 타이핑 2: 동일 prefix + 추가 입력 → prefix 캐시 적용 (컬럼1 재사용)
  const text2 = text1 + '바나';
  on.textContent = text2;
  on.caretHint = text1.length;
  on.layoutText();

  const full = buildPara(text2, OPTS);
  assert(snapshot(on) === snapshot(full), 'prefix 캐시 경로 === 전체 재래핑 (deep equal)');

  const line3After = on.columnContents[0][hangLineIdx];
  assert(line3After.parts[0].hangs?.[line3After.parts[0].content.length - 1] === 'end',
    '재사용된 컬럼1의 걸침 마킹 보존');
}

// ═══ 13. API — genColumnStyle / extractData / effective 기본값 ═══
console.log('\nTest 13: API — genColumnStyle overflow 조건화 + extractData round-trip');
{
  const content = ga12 + '.' + '바'.repeat(5);
  const on = buildPara(content, { boxWidth: W_END, hangingPunctuation: true });
  const off = buildPara(content, { boxWidth: W_END });
  const onDirOnly = buildPara(content, { boxWidth: W_END, hangingPunctuation: { lineEnd: true } });

  assert(on.genColumnStyle(0).overflow === 'visible', "ON 시 컬럼 overflow === 'visible' (클리핑 해제)");
  assert(off.genColumnStyle(0).overflow === 'hidden', "OFF 시 컬럼 overflow === 'hidden' (기존 동작)");
  assert(onDirOnly.genColumnStyle(0).overflow === 'visible', "방향별 객체 설정도 overflow === 'visible'");

  assert(on.extractData.paragraphStyle?.hangingPunctuation === true, 'extractData round-trip: 주입값 true 보존');
  assert(onDirOnly.extractData.paragraphStyle?.hangingPunctuation?.lineEnd === true, 'extractData round-trip: 객체 설정 보존');
  assert(off.extractData.paragraphStyle?.hangingPunctuation === undefined, 'extractData: 미주입 시 필드 부재');
}

// ═══ 14. 방향별 설정 — lineEnd만 ON 시 행두 걸침 미발생 ═══
console.log('\nTest 14: 방향별 설정 — lineEnd만 ON이면 행두 교정은 금칙 폴백');
{
  const contentEnd = ga12 + '.' + '바'.repeat(5);
  const endOnly = buildPara(contentEnd, { boxWidth: W_END, hangingPunctuation: { lineEnd: true }, textAlign: 'left' });
  const both = buildPara(contentEnd, { boxWidth: W_END, hangingPunctuation: true, textAlign: 'left' });
  assert(snapshot(endOnly) === snapshot(both), 'lineEnd 단일 설정 === 전체 ON (행말 시나리오 동일)');

  const contentStart = ga12 + '(' + '바'.repeat(6);
  const endOnlyStart = buildPara(contentStart, { boxWidth: W_START, hangingPunctuation: { lineEnd: true }, textAlign: 'left' });
  const offStart = buildPara(contentStart, { boxWidth: W_START, textAlign: 'left' });
  const startLine1 = endOnlyStart.columnContents[0][1];
  assert(startLine1.parts[0].content[0] === '(' && startLine1.parts[0].hangs === undefined,
    "lineEnd만 ON 시 '('는 금칙 폴백으로 아래 줄 앞에 in-flow (걸침 마킹 없음)");
  assert(approx(startLine1.parts[0].charOffsets[0], 0), "폴백 '(' offset in-flow 0 (행두 걸침 -swidth 아님)");
  assert(snapshot(endOnlyStart) === snapshot(offStart), '행두 시나리오에서 lineEnd-only === OFF');
}

console.log(`\n${failCount === 0 ? 'ALL PASS' : 'FAIL'} (${passCount} pass, ${failCount} fail)`);
process.exit(failCount === 0 ? 0 : 1);