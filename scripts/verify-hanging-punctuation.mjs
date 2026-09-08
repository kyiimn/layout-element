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
  assert(approx(part0.charOffsets[12], W_END - dotW * 0.5), `걸침 글자 charOffset === partWidth - 반각 ${W_END.toFixed(3)} - 0.5×${dotW.toFixed(3)} (got ${part0.charOffsets[12]?.toFixed(3)})`);
  assert(approx(part0.charOffsets[0], 0) && approx(part0.charOffsets[11], 11 * gaW),
    'visible 글자 오프셋 좌측 정렬 유지 (0, 11×가폭)');
  assert(on.columnContents[0][1].parts[0].content[0] === '바',
    `아래 줄이 '.'로 시작하지 않음 ('${on.columnContents[0][1].parts[0].content[0]}')`);

  const offLine0 = off.columnContents[0][0];
  // OFF(금칙) 시 폭 게이트: '.' pull-up이 파트 폭을 초과하므로 追い出시로
  // 전환 — 마지막 '가'가 '.'와 함께 다음 줄로 내려간다 (라인 폭 초과 없음).
  assert(offLine0.parts[0].content.length === 11,
    `OFF(금칙) 追い出시 — 폭 위반 시 '가'+'.'가 함께 다음 줄로 (${offLine0.parts[0].content.length}자, 라인 폭 이내)`);
  const offLine1 = off.columnContents[0][1];
  assert(offLine1.parts[0].content[0] === '가' && offLine1.parts[0].content[1] === '.',
    `OFF(금칙) 追い出시 — 아래 줄이 "가."로 시작 ('${offLine1.parts[0].content[0]}${offLine1.parts[0].content[1]}')`);
  let offSum = 0;
  for (let i = 0; i < offLine0.parts[0].content.length; i++) offSum += off.getCharWidths(offLine0.parts[0].content[i]).swidth;
  assert(offSum <= offLine0.parts[0].width + 1e-6,
    `OFF(금칙) 라인 폭 위반 없음 (${offSum.toFixed(3)} ≤ ${offLine0.parts[0].width.toFixed(3)})`);
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

  // 반각 돌출: visible이 채우는 폭은 첫 걸침 부호의 안쪽 절반만큼 줄어든다
  const visibleRemaining = Math.max(0, W_END - 0.5 * dotW - 12 * gaW);
  const gap = visibleRemaining / 11;
  let ok = true;
  for (let i = 0; i < 12; i++) {
    const expected = i * gaW + i * gap;
    if (!approx(part0.charOffsets[i], expected, 1e-9)) { ok = false; break; }
  }
  assert(ok, 'visible 12자가 균등 간격으로 전체 폭 분산 (걸침 글자 제외 + 반각 돌출 기대치와 일치)');
  assert(approx(part0.charOffsets[12], W_END - 0.5 * dotW), `걸침 '.' offset === partWidth - 반각 (got ${part0.charOffsets[12]?.toFixed(3)})`);
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
  // 반각 돌출: 첫 부호(')')는 폭의 50%만 밖으로, 둘째('.')는 전체 폭 스택형
  assert(approx(part0.charOffsets[12], W_RUN - 0.5 * parenW), `첫 걸침 offset === partWidth - 반각 (got ${part0.charOffsets[12]?.toFixed(3)})`);
  assert(approx(part0.charOffsets[13], W_RUN + 0.5 * parenW),
    `둘째 걸침 offset 스택형 === partWidth + 반각 + ')'폭 (got ${part0.charOffsets[13]?.toFixed(3)})`);
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
  assert(approx(rect.left, 10 + W_END - 0.5 * dotW),
    `걸침 '.' left === 파트 경계 - 반각 (반각 돌출) ${10 + W_END}mm 문서 절대좌표 (got ${rect?.left?.toFixed(3)})`);
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
  // 반각 돌출: '.'의 왼쪽 끝은 파트 경계 - 반각에서 시작
  const dotLeft = 10 + W_END - 0.5 * dotW;
  const leftHalf = on.getOffsetFromPoint(dotLeft + 0.25 * dotW, yLine0);
  const rightHalf = on.getOffsetFromPoint(dotLeft + 0.75 * dotW, yLine0);
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
  const line1Part = on.columnContents[0][1]?.parts[0];
  // 폭 게이트 + 追い出시: '.' pull-up이 축소 파트 폭을 초과하므로 마지막
  // '가'가 '.'와 함께 다음 줄로 내려간다. 라인 폭 위반은 없다.
  assert(line1Part && line1Part.content[0] === '가' && line1Part.content[1] === '.',
    `게이트 실패 + 폭 위반 시 追い出시 — 아래 줄이 "가."로 시작 ('${line1Part?.content[0] ?? '?'}${line1Part?.content[1] ?? ''}')`);
  let t10Sum = 0;
  for (const ch of line0Part.content) t10Sum += on.getCharWidths(ch).swidth;
  assert(t10Sum <= line0Part.width + 1e-6,
    `追い出시 후 라인 폭 위반 없음 (${t10Sum.toFixed(3)} ≤ ${line0Part.width.toFixed(3)})`);
  assert(on.columnContents.flat().every(line => line.parts.every(p => p.hangs === undefined || p.hangs.every(h => h === undefined))),
    '폴백(追い出시) 경로에서 걸침 마킹 없음 (hangs 전무)');
  assert(snapshot(on) === snapshot(off), '게이트 실패 시 OFF(금칙 폴백)와 deep equal');
}

// ═══ 11. 블록 경계 — `\n` 경계 쌍 걸침 스킵 ═══
console.log('\nTest 11: 블록 경계 — \\n 경계 쌍은 걸침/이동하지 않음');
{
  const content = ga12 + '\n.' + '바'.repeat(5);
  const on = buildPara(content, { boxWidth: W_END, hangingPunctuation: true, textAlign: 'left' });
  const off = buildPara(content, { boxWidth: W_END, textAlign: 'left' });

  const line0 = on.columnContents[0][0];
  const line1 = on.columnContents[0][1];
  // 블록 경계 쌍의 금칙(기존 동작)에 폭 게이트가 적용된다 — '.' pull-up이
  // 폭을 초과하면 追い出시로 전환, 마지막 '가'가 함께 내려간다.
  const line1First = line1?.parts[0]?.content[0];
  const line1Second = line1?.parts[0]?.content[1];
  assert(line1First === '가' && line1Second === '.',
    `블록 경계 쌍 폭 게이트 — '.' pull-up 초과 시 '가'+'.'가 함께 아래로 ('${line1First ?? '?'}${line1Second ?? ''}')`);
  assert(line0.parts[0].hangs === undefined, '블록 경계 쌍은 걸침 마킹하지 않음 (hang 패스 스킵)');
  assert(snapshot(on) === snapshot(off), '블록 경계에서 OFF(기존 동작)와 deep equal');
}

// ═══ 12. prefix 캐시 — 타이핑 경로 걸침 보존 ═══
console.log('\nTest 12: prefix 캐시 — 타이핑 경로에서 걸침 마킹 보존 + 전체 재래핑과 deep equal');
{
  const COL_W = 33.5; // (70 - 3) / 2
  const charsPerLine = Math.floor((COL_W + 1e-6) / gaW);
  // 행두 걸침(케이스 1) 기반 캐시 시나리오: col0 라인3의 마지막 글자가
  // '('(행말금칙)이 되도록 배치한다. 행말금칙은 배치 단계 追い出し가 다루지
  // 않으므로 후처리 걸침 패스가 '('를 라인4 시작 왼쪽 밖으로 내보내
  // hangs='start' 마킹한다 — prefix 캐시 경로의 마킹 보존을 검증한다.
  // 라인4는 마지막 라인이 아니므로 같은 컬럼 내 페어 (라인3, 라인4)가
  // 형성된다. 2단계 타이핑으로 캐시 구축 → 적용을 검증한다.
  const boundaryIdx = 4 * charsPerLine;
  const text1 = '가'.repeat(boundaryIdx - 1) + '(' + '가'.repeat(30);

  const OPTS = { boxWidth: 70, boxHeight: 30, columns: 2, hangingPunctuation: true, textAlign: 'left' };
  const on = buildPara(text1, OPTS);
  const hangLineIdx = 4; // '('가 내려와 왼쪽 밖에 걸치는 라인
  const line4 = on.columnContents[0][hangLineIdx];
  assert(line4.parts[0].content[0] === '(' && line4.parts[0].hangs?.[0] === 'start',
    `컬럼1에 행두 걸침 발생 (전제 — ${boundaryIdx - 1}번째 글자 '('가 라인3 끝)`);

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

  const line4After = on.columnContents[0][hangLineIdx];
  assert(line4After.parts[0].content[0] === '(' && line4After.parts[0].hangs?.[0] === 'start',
    '재사용된 컬럼1의 행두 걸침 마킹 보존');
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

// ═══ 15. 강제 걸침 (lineEnd: 'always') — 들어맞는 닫기 부호도 컬럼 밖으로 ═══
console.log("\nTest 15: 강제 걸침 — lineEnd: 'always' 시 들어맞은 닫기 부호도 걸침");
{
  // 컬럼 폭: 12자 + '.' 1개가 여유롭게 들어감 (오버플로우 없음)
  const W_FIT = 12 * gaW + 1.5 * dotW;
  const content = ga12 + '.' + '바'.repeat(24);

  const std = buildPara(content, { boxWidth: W_FIT, hangingPunctuation: { lineEnd: true }, textAlign: 'justify' });
  const forced = buildPara(content, { boxWidth: W_FIT, hangingPunctuation: { lineEnd: 'always' }, textAlign: 'justify' });

  // 전제: 모든 줄이 컬럼 끝에 닿고(엣지 게이트), 어떤 줄도 '.'를 다음 줄로 넘기지
  // 않는다 — 표준 걸침은 마킹이 없어야 한다.
  const stdLine0 = std.columnContents[0][0];
  assert(stdLine0.parts[0].content.at(-1) === '.', "전제: 라인1이 '.'로 끝남 (오버플로우 없음)");
  assert(stdLine0.parts[0].hangs?.every(h => h === undefined) ?? true, '표준 걸침(true): 들어맞으면 마킹 없음');

  // 강제 걸침: 라인1의 '.'가 hangs='end'로 마킹된다
  const forcedLine0 = forced.columnContents[0][0];
  const lastIdx = forcedLine0.parts[0].content.length - 1;
  assert(forcedLine0.parts[0].content[lastIdx] === '.', "강제: 라인1 마지막 글자 '.'");
  assert(forcedLine0.parts[0].hangs?.[lastIdx] === 'end', "강제: 들어맞은 '.'에 hangs='end' 마킹");
  assert(forcedLine0.parts[0].hangs?.[lastIdx - 1] === undefined, "강제: '.' 직전 visible 글자는 마킹 없음");

  // 마킹된 부호는 정렬에서 제외 — visible 글자들이 첫 부호의 안쪽 절반을
  // 제외한 폭까지 다시 채운다. visible 끝 ≈ partWidth - 0.5×부호폭.
  const p0 = forcedLine0.parts[0];
  const widths = forced.getCharWidths(p0.content[lastIdx - 1]);
  const dotWid = forced.getCharWidths(p0.content[lastIdx]).swidth;
  const visibleEnd = p0.charOffsets[lastIdx - 1] + widths.swidth;
  assert(approx(visibleEnd, p0.width - 0.5 * dotWid, gaW * 0.5),
    `강제: visible 텍스트 가장자리가 파트 폭 - 반각을 채움 (${visibleEnd.toFixed(3)} ≈ ${(p0.width - 0.5 * dotWid).toFixed(3)})`);
  assert(approx(p0.charOffsets[lastIdx], p0.width - 0.5 * dotWid),
    `강제: '.' 오프셋 === partWidth - 반각 (경계 50% 돌출, got ${p0.charOffsets[lastIdx]?.toFixed(3)})`);

  // 표준과 강제의 줄 구성은 동일해야 한다 (글자 이동 없음 — 마킹만 추가)
  const stdContents = std.columnContents.map(col => col.map(l => l.parts.map(p => p.content.join(''))));
  const forcedContents = forced.columnContents.map(col => col.map(l => l.parts.map(p => p.content.join(''))));
  assert(JSON.stringify(stdContents) === JSON.stringify(forcedContents),
    '강제 걸침은 줄 구성/글자 배치를 변경하지 않음 (마킹만 추가)');

  // 블록 마지막 줄(endOfBlock)은 강제 걸침 제외 — 좌측 정렬 줄은 우측 끝을 안 채움
  // 첫 블록이 2줄 이상이면 블록 '중간' 줄이 존재한다 (한 줄 블록은 그 줄이
  // 곧 endOfBlock이라 제외 대상). 블록 마지막 줄도 닫기 부호로 끝나게 하여
  // 제외 동작을 부호가 있는 줄에서 검증한다.
  const contentBlock = ga12 + '.' + '바'.repeat(24) + '.' + '\n' + ga12 + '.';
  const forcedBlock = buildPara(contentBlock, { boxWidth: W_FIT, hangingPunctuation: { lineEnd: 'always' }, textAlign: 'justify' });
  const blockLines = forcedBlock.columnContents[0];
  const blockMidLine = blockLines[0];
  const blockLastLine = blockLines.find(l => l.endOfBlock === true && l.parts[0].content.at(-1) === '.');
  assert(blockMidLine.endOfBlock !== true, '전제: 라인1은 블록 중간 줄 (endOfBlock 아님)');
  assert(blockLastLine !== undefined, '전제: 닫기 부호로 끝나는 블록 마지막 줄 존재');
  const midLast = blockMidLine.parts[0].content.length - 1;
  const lastLastIdx = blockLastLine.parts[0].content.length - 1;
  assert(blockMidLine.parts[0].content.at(-1) === '.' && blockMidLine.parts[0].hangs?.[midLast] === 'end',
    '블록 중간 줄의 마지막 닫기 부호는 강제 걸침');
  assert(blockLastLine.parts[0].hangs?.[lastLastIdx] === undefined || blockLastLine.parts[0].hangs === undefined,
    '블록 마지막 줄(endOfBlock)은 강제 걸침 제외');

  // 텍스트 마지막 줄(endOfText)도 제외
  const contentTail = ga12 + '.' + '바'.repeat(24) + '.' + '\n';
  const forcedTail = buildPara(contentTail, { boxWidth: W_FIT, hangingPunctuation: { lineEnd: 'always' }, textAlign: 'justify' });
  const lastCol = forcedTail.columnContents[forcedTail.columnContents.length - 1];
  const lastLine = lastCol[lastCol.length - 1];
  const tlLast = lastLine.parts[0].content.length - 1;
  assert(lastLine.endOfText === true || lastLine.endOfBlock === true, '전제: 마지막 줄 플래그');
  assert(lastLine.parts[0].hangs?.[tlLast] === undefined || lastLine.parts[0].hangs === undefined,
    '텍스트 마지막 줄(endOfText)은 강제 걸침 제외');

  // 행두 걸침(lineStart)에는 'always' 확장이 없다 — lineStart만으로는 강제 패스 미동작
  const startOnlyAlways = buildPara(content, { boxWidth: W_FIT, hangingPunctuation: { lineStart: true }, textAlign: 'justify' });
  const startLine0 = startOnlyAlways.columnContents[0][0];
  assert(startLine0.parts[0].hangs?.[lastIdx] === undefined || startLine0.parts[0].hangs === undefined,
    "lineStart: 'always' 아님 — 행말 강제 걸침 미발생");

  // 캐시 해시: 'always' ↔ true 토글 시 재래핑 (stale 캐시 없음)
  const toggled = buildPara(content, { boxWidth: W_FIT, hangingPunctuation: { lineEnd: true }, textAlign: 'justify' });
  toggled.paragraphStyle = { textAlign: 'justify', hangingPunctuation: { lineEnd: 'always' } };
  toggled.layoutText();
  const toggledLine0 = toggled.columnContents[0][0];
  const tLast = toggledLine0.parts[0].content.length - 1;
  assert(toggledLine0.parts[0].hangs?.[tLast] === 'end', "캐시: true → 'always' 전환 시 강제 마킹 적용 (stale 캐시 없음)");

  // extractData round-trip: 'always' 보존
  assert(forced.extractData.paragraphStyle?.hangingPunctuation?.lineEnd === 'always',
    "extractData round-trip: lineEnd === 'always' 보존");
}

// ═══ 16. 라인 첫 글자 열기 부호 행두 걸침 (케이스 5) ═══
console.log('\nTest 16: 행두 걸침(케이스 5) — 라인 첫 글자 열기 부호가 좌측 밖으로');
{
  // 시나리오: 12자/라인 폭에서 '바' 런이 24자(2라인) 차고, 그 다음 '('가
  // 새 라인의 첫 글자가 된다 (열기 부호는 행두 허용이므로 배치/금칙으로는
  // 이동하지 않음). 케이스 5가 첫 파트 첫 글자를 hangs='start'로 마킹해
  // 좌측 밖으로 내보낸다.
  const W_START_LINE = 12 * gaW + 0.2;
  const content = ga12 + '바'.repeat(24) + '(' + '나'.repeat(20);
  const on = buildPara(content, { boxWidth: W_START_LINE, hangingPunctuation: { lineStart: true }, textAlign: 'left' });

  // '('로 시작하는 라인 찾기
  let parenLine = null;
  for (let c = 0; c < on.columnContents.length && parenLine === null; c++) {
    for (let li = 0; li < on.columnContents[c].length; li++) {
      const fp = on.columnContents[c][li].parts[0];
      if (fp && fp.content[0] === '(') { parenLine = on.columnContents[c][li]; break; }
    }
  }
  assert(parenLine !== null, "전제: '('로 시작하는 라인 존재");
  const fp = parenLine.parts[0];
  assert(fp.hangs?.[0] === 'start', "케이스 5: 라인 첫 '('에 hangs='start' 마킹");
  assert(fp.content.length >= 2, '케이스 5 가드: 첫 파트 잔여 1자 이상');

  // offset: '('는 -swidth (파트 좌측 밖), 이후 글자는 0부터
  const openWid = on.getCharWidths('(').swidth;
  assert(approx(fp.charOffsets?.[0] ?? 99, -openWid),
    `케이스 5: '(' offset === -swidth ${(-openWid).toFixed(3)} (got ${fp.charOffsets?.[0]?.toFixed(3)})`);
  assert(approx(fp.charOffsets?.[1] ?? -1, 0), '케이스 5: 두 번째 글자는 in-flow 0부터');

  // OFF 시 마킹 없음 (라인 첫 열기 부호는 in-flow 유지)
  const off = buildPara(content, { boxWidth: W_START_LINE, textAlign: 'left' });
  let offParenLine = null;
  for (let c = 0; c < off.columnContents.length && offParenLine === null; c++) {
    for (let li = 0; li < off.columnContents[c].length; li++) {
      const fp2 = off.columnContents[c][li].parts[0];
      if (fp2 && fp2.content[0] === '(') { offParenLine = off.columnContents[c][li]; break; }
    }
  }
  const ofp = offParenLine?.parts[0];
  assert(ofp?.hangs === undefined || ofp?.hangs?.[0] === undefined, 'OFF: 라인 첫 열기 부호 마킹 없음 (in-flow)');
  assert(approx(ofp?.charOffsets?.[0] ?? -1, 0), 'OFF: 라인 첫 열기 부호 offset in-flow 0');

  // lineEnd만 ON이면 케이스 5 미동작
  const endOnly = buildPara(content, { boxWidth: W_START_LINE, hangingPunctuation: { lineEnd: true }, textAlign: 'left' });
  let endOnlyParen = null;
  for (let c = 0; c < endOnly.columnContents.length && endOnlyParen === null; c++) {
    for (let li = 0; li < endOnly.columnContents[c].length; li++) {
      const fp3 = endOnly.columnContents[c][li].parts[0];
      if (fp3 && fp3.content[0] === '(') { endOnlyParen = endOnly.columnContents[c][li]; break; }
    }
  }
  assert(endOnlyParen?.parts[0]?.hangs?.[0] === undefined || endOnlyParen?.parts[0]?.hangs === undefined,
    "lineEnd만 ON: 케이스 5 미동작 (라인 첫 '(' 마킹 없음)");
}

console.log(`\n${failCount === 0 ? 'ALL PASS' : 'FAIL'} (${passCount} pass, ${failCount} fail)`);
process.exit(failCount === 0 ? 0 : 1);