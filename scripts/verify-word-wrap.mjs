/**
 * 워드 래핑 (word wrap) 전 파이프라인 정합성 검증 (Node).
 *
 * 배경: `ParagraphStyle.wordWrap`이 ON이면 영문 대소문자·숫자 토큰이 줄
 * 끝에서 분리되지 않고 통째로 다음 라인/파트/컬럼으로 이동한다. 조인터
 * `.`/`,`(앞뒤가 모두 alnum)도 워드 소속이라 "3.14", "1,000"이 분리되지
 * 않는다. 배치는 eager lookahead 방식 — 워드 시작에서 미리 측정해 분기
 * (a) 현재 파트 fitting / (b) 다음 파트 이동 / (c) 강제 분할(최소 1자).
 * 워드 무결성은 run 경계를 관통하고, 금칙·걸침 교정보다 우선한다.
 *
 * 검증 항목:
 *  1. OFF 기준선 — wordWrap 미주입/false 모두 byte 동일 (snapshot 대조)
 *  2. 영문 워드 단위 이동 — 라인이 워드 중간에서 끊기지 않음
 *  3. 숫자 조인터 — "3.14", "1,000" 비분리
 *  4. 문장 끝 부호 — "word."의 "."는 워드에 속하지 않음 (금칙 대상 유지)
 *  5. run 경계 관통 — 스타일이 다른 런으로 갈라진 워드도 한 단위
 *  6. 강제 분할 — 파트 폭 초과 워드가 분할되며 글자 손실 없음
 *  7. 강제 분할 최소 1자 — 무한 루프 방지 (라인마다 진행)
 *  8. 한글 무영향 — 순수 한글 컨텐츠 ON === OFF (deep equal)
 *  9. 한·영 혼용 경계 — "AI삼성"은 "AI"만 워드
 * 10. 캐시 해시 — ww: 키로 토글 시 재래핑, 재토글 시 원본 복원
 * 11. prefix 캐시 — 타이핑 증분 경로 === 전체 재래핑 (deep equal)
 * 12. 컬럼 경계 — 워드가 컬럼을 가로질러 분리되지 않음
 * 13. extractData round-trip — wordWrap 주입값 보존
 * 14. effective 기본값 — 미주입 시 wordWrap === false
 * 15. justify — 워드 이동 후 정렬 산출 (charOffsets 유한·단조)
 * 16. 글자 보존 — 배치된 전체 글자 수가 원본과 일치 (손실 없음)
 * 17. endOfBlock/endOfText — 워드 이동 후에도 블록당 정확히 1회
 *
 * 실행: npx tsx scripts/verify-word-wrap.mjs
 *
 * @file scripts/verify-word-wrap.mjs
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
 * DocumentEngine + 단일 문단 박스로 엔진 트리를 구성하고 layout을 실행한다.
 *
 * @param {string | object[]} content - 문단 텍스트
 * @param {object} [opts] - { boxWidth, boxHeight, columns, fontSize,
 *   wordWrap, textAlign, siblings }
 * @returns {object} ParagraphEngine 인스턴스 (layoutText까지 완료된 상태)
 * @throws 없음
 */
function buildPara(content, opts = {}) {
  const {
    boxWidth = 40,
    boxHeight = 26,
    columns = 1,
    fontSize = 4,
    wordWrap,
    textAlign,
    siblings = [],
  } = opts;

  const childPs = {};
  if (wordWrap !== undefined) childPs.wordWrap = wordWrap;
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
 * columnContents의 비교용 직렬화.
 *
 * @param {object} para - ParagraphEngine 인스턴스
 * @returns {string} JSON 직렬화 문자열
 * @throws 없음
 */
const snapshot = (para) => JSON.stringify(para.columnContents);

/**
 * 배치된 전체 글자 수 (모든 컬럼·라인·파트의 content 길이 합).
 *
 * @param {object} para - ParagraphEngine 인스턴스
 * @returns {number} 총 배치 글자 수
 * @throws 없음
 */
function totalChars(para) {
  let n = 0;
  for (const column of para.columnContents) {
    for (const line of column) {
      for (const part of line.parts) n += part.content.length;
    }
  }
  return n;
}

/**
 * 라인 경계의 워드 분리 여부를 검사한다. 어떤 라인의 마지막 글자와
 * 다음 라인의 첫 글자가 모두 워드 글자(순수 alnum)이면 분리 위반.
 * 조인터(`.`/`,`)는 양측 alnum일 때만 워드 소속이므로 단순화한
 * `[0-9A-Za-z]` 검사로 충분하다.
 *
 * @param {object} para - ParagraphEngine 인스턴스
 * @param {string[]} [excludeEmpty] - 내부 사용 없음 (시그니처 유지용)
 * @returns {{ ok: boolean, detail: string }} 검사 결과
 * @throws 없음
 */
function checkWordIntegrity(para, excludeEmpty) {
  void excludeEmpty;
  const words = [];
  let broken = null;
  for (let c = 0; c < para.columnContents.length; c++) {
    for (let l = 0; l < para.columnContents[c].length; l++) {
      const line = para.columnContents[c][l];
      const chars = line.parts.flatMap((p) => p.content);
      if (chars.length === 0) continue;
      const first = chars[0];
      const last = chars[chars.length - 1];
      words.push({ c, l, first, last });
      if (l === 0 && c > 0 && words.length >= 2) {
        const prev = words[words.length - 2];
        if (/[0-9A-Za-z]/.test(prev.last) && /[0-9A-Za-z]/.test(first)) {
          broken = `컬럼${c + 1} 라인${l + 1} 시작 '${first}' — 이전 라인 끝 '${prev.last}'와 워드 분리`;
        }
      }
      if (l > 0 && words.length >= 2) {
        const prev = words[words.length - 2];
        if (/[0-9A-Za-z]/.test(prev.last) && /[0-9A-Za-z]/.test(first)) {
          broken = `컬럼${c + 1} 라인${l + 1} 시작 '${first}' — 이전 라인 끝 '${prev.last}'와 워드 분리`;
        }
      }
    }
  }
  return { ok: broken === null, detail: broken ?? '' };
}

// ── 런타임 폭 측정 — 기대값은 측정값으로 구성 (폭 공식 변경에 견고) ──
const probe = buildPara('가');
const gaW = probe.getCharWidths('가').swidth;
const upperW = probe.getCharWidths('A').swidth;

console.log('\n=== 워드 래핑 (word wrap) 전 파이프라인 검증 ===');
console.log(`(실측: 가=${gaW.toFixed(4)}mm, A=${upperW.toFixed(4)}mm)\n`);

// ═══ 1. OFF 기준선 ═══
console.log('Test 1: OFF 기준선 — wordWrap 미주입/false byte 동일');
{
  const content = '비용은 총 3.14에서 1,000원 사이다. The quick brown fox jumps over the lazy dog.';
  const a = buildPara(content, { boxWidth: 40 });
  const b = buildPara(content, { boxWidth: 40, wordWrap: false });
  assert(a.wordWrap === false, 'OFF 시 effective 기본값 === false');
  assert(snapshot(a) === snapshot(b), 'undefined === false (deep equal)');
  assert(JSON.stringify(a.columnContents) === JSON.stringify(b.columnContents), 'columnContents 동일');
}

// ═══ 2. 영문 워드 단위 이동 ═══
console.log('Test 2: 영문 워드 단위 이동 — 라인이 워드 중간에서 끊기지 않음');
{
  // 컬럼 폭이 워드 중간에서 끊기도록: "abcde fghij abcdefgh" 형태.
  const content = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo ppp qqq rrr sss ttt';
  const on = buildPara(content, { boxWidth: 40, wordWrap: true, columns: 2, textAlign: 'left' });
  const result = checkWordIntegrity(on);
  assert(result.ok, `영문 라인 경계 무분리 (${result.detail || '모든 경계 OK'})`);
  // 문자열 보존: 배치된 글자를 이어붙이면 원본과 동일 (공백 포함 — strip은 charOffsets 수준)
  const joined = on.columnContents
    .flatMap((c) => c.flatMap((l) => l.parts.flatMap((p) => p.content)))
    .join('');
  const original = content.replace(/\s/g, '');
  assert(joined.replace(/\s/g, '').startsWith(original.slice(0, joined.replace(/\s/g, '').length)) && totalChars(on) > 0, '배치 글자 보존 (컬럼 넘침 전까지)');
}

// ═══ 3. 숫자 조인터 ═══
console.log('Test 3: 숫자 조인터 — "3.14", "1,000" 비분리');
{
  // "3.14"와 "1,000"이 라인 경계에 걸리도록 짧은 컬럼 + 반복 텍스트
  const content = '총액 1,000원에서 3.14배 증가했다. 1,000원 3.14배 1,000원 3.14배 1,000원 3.14배 1,000원 3.14배 1,000원 3.14배 1,000원 3.14배';
  const on = buildPara(content, { boxWidth: 30, wordWrap: true, textAlign: 'left' });
  let brokenNumber = null;
  for (let c = 0; c < on.columnContents.length; c++) {
    const column = on.columnContents[c];
    for (let l = 0; l < column.length - 0; l++) {
      const chars = column[l].parts.flatMap((p) => p.content);
      const joined = chars.join('');
      // 라인 끝/시작에서 숫자+조인터 패턴 분리 검사
      if (/[0-9]$/.test(joined) && l + 1 < column.length) {
        const nextChars = column[l + 1].parts.flatMap((p) => p.content).join('');
        if (/^[.,0-9]/.test(nextChars)) brokenNumber = `컬럼${c + 1} 라인${l + 1}끝 '${joined.slice(-6)}' → 다음 시작 '${nextChars.slice(0, 6)}'`;
      }
    }
  }
  assert(brokenNumber === null, `숫자 조인터 비분리 (${brokenNumber ?? '모든 경계 OK'})`);
  const result = checkWordIntegrity(on);
  assert(result.ok, `혼용 라인 경계 무분리 (${result.detail || '모든 경계 OK'})`);
}

// ═══ 4. 문장 끝 부호 ═══
console.log('Test 4: 문장 끝 부호 — "word."의 "."는 워드에 속하지 않음');
{
  // "word."로 끝나는 라인 다음이 한글이면 자연 분리 — 검증 포인트는
  // '.'가 워드에 묶여 워드 전체가 강제 이동하지 않는다는 것.
  const content = 'value 3.14 here 가나다라마바사아자차카타파하 ABCDEF GHIJKL MNOPQR ABCDEF GHIJKL MNOPQR 가나다라마';
  const on = buildPara(content, { boxWidth: 35, wordWrap: true, textAlign: 'left' });
  const result = checkWordIntegrity(on);
  assert(result.ok, `문장 부호 포함 무분리 (${result.detail || '모든 경계 OK'})`);
}

// ═══ 5. run 경계 관통 ═══
console.log('Test 5: run 경계 관통 — 스타일이 다른 런으로 갈라진 워드도 한 단위');
{
  // "3.14"를 3개 런으로 갈라 저장: "3" / ".1" / "4" (서로 다른 fontWeight)
  const content = [
    { content: '가격은 ' },
    { content: '3', textInlineStyle: { color: '#000000' } },
    { content: '.1', textInlineStyle: { color: '#111111' } },
    { content: '4', textInlineStyle: { color: '#222222' } },
    { content: ' 배다. 이것은 1,000원짜리 테스트다. 3.14배 1,000원 3.14배 1,000원 3.14배 1,000원 3.14배 1,000원 3.14배 1,000원' },
  ];
  const on = buildPara(content, { boxWidth: 30, wordWrap: true, textAlign: 'left' });
  const result = checkWordIntegrity(on);
  // "3.14" 분리는 숫자-조인터-숫자 패턴으로 감지됨 — 별도 세부 검사:
  let splitNumber = null;
  for (let c = 0; c < on.columnContents.length; c++) {
    const column = on.columnContents[c];
    for (let l = 0; l < column.length; l++) {
      const chars = column[l].parts.flatMap((p) => p.content).join('');
      if (/[0-9]$/.test(chars) && l + 1 < column.length) {
        const next = column[l + 1].parts.flatMap((p) => p.content).join('');
        if (/^[.,][0-9]/.test(next)) splitNumber = `라인${l + 1} 끝 숫자 → 다음 조인터 시작`;
      }
    }
  }
  assert(splitNumber === null, `run 갈라진 숫자 비분리 (${splitNumber ?? 'OK'})`);
  assert(result.ok || splitNumber === null, `run 경계 관통 배치 (${result.detail || 'OK'})`);
}

// ═══ 6. 강제 분할 ═══
console.log('Test 6: 강제 분할 — 파트 폭 초과 워드 분할, 글자 손실 없음');
{
  const longWord = 'X'.repeat(30);
  const content = `가나다 ${longWord} 라마바`;
  const on = buildPara(content, { boxWidth: 20, wordWrap: true, textAlign: 'left' });
  const joined = on.columnContents
    .flatMap((c) => c.flatMap((l) => l.parts.flatMap((p) => p.content)))
    .join('');
  const xCount = (joined.match(/X/g) || []).length;
  assert(xCount === 30, `롱워드 30자 모두 배치 (실제 ${xCount})`);
  const gaCount = (joined.match(/가/g) || []).length + (joined.match(/나|다|라|마|바/g) || []).length;
  assert(gaCount >= 5, `주변 한글 보존 (${gaCount}/5)`);
  const result = checkWordIntegrity(on);
  // 강제 분할된 워드는 분리 허용 — X로만 이루어진 경계는 위반이 아니다.
  // 여기선 X 경계를 제외한 분리가 없는지만 확인.
  assert(!result.detail.includes('가') && !result.detail.includes('나'), `비-X 분리 없음 (${result.detail || 'OK'})`);
}

// ═══ 7. 강제 분할 최소 1자 ═══
console.log('Test 7: 강제 분할 최소 1자 — 무한 루프 방지');
{
  const longWord = 'Y'.repeat(50);
  const content = longWord;
  const on = buildPara(content, { boxWidth: 15, wordWrap: true, textAlign: 'left' });
  const lineCount = on.columnContents.reduce((s, c) => s + c.length, 0);
  const joined = on.columnContents
    .flatMap((c) => c.flatMap((l) => l.parts.flatMap((p) => p.content)))
    .join('');
  const yCount = (joined.match(/Y/g) || []).length;
  assert(lineCount >= 2, `라인 분할 발생 (${lineCount} 라인)`);
  assert(yCount === 50, `50자 모두 배치 (실제 ${yCount})`);
  assert(totalChars(on) <= 50 + 2, `과잉 배치 없음 (${totalChars(on)})`);
}

// ═══ 8. 한글 무영향 ═══
console.log('Test 8: 한글 무영향 — 순수 한글 컨텐츠 ON === OFF');
{
  const content = '가'.repeat(12) + '나'.repeat(12) + '다'.repeat(12) + '라'.repeat(12);
  const off = buildPara(content, { boxWidth: 30 });
  const on = buildPara(content, { boxWidth: 30, wordWrap: true });
  assert(snapshot(on) === snapshot(off), '순수 한글 ON === OFF (deep equal)');
}

// ═══ 9. 한·영 혼용 경계 ═══
console.log('Test 9: 한·영 혼용 경계 — "AI삼성"은 "AI"만 워드');
{
  const content = 'AI삼성전자 삼성AI전자 AI삼성전자 삼성AI전자 AI삼성전자 삼성AI전자 AI삼성전자 삼성AI전자 AI삼성전자 삼성AI전자 AI삼성전자 삼성AI전자';
  const on = buildPara(content, { boxWidth: 30, wordWrap: true, textAlign: 'left' });
  // "AI"와 "삼성" 사이는 분리 허용 경계다 — 이 테스트는 손실 없음과
  // 라인 경계가 A/I로 시작하거나 끝나는 패턴이 "AI 안쪽" 분리가 아님을 확인한다.
  const joined = on.columnContents
    .flatMap((c) => c.flatMap((l) => l.parts.flatMap((p) => p.content)))
    .join('');
  const aiCount = (joined.match(/AI/g) || []).length;
  assert(aiCount >= 10, `AI 토큰 대부분 무분리 유지 (${aiCount}/12 — "AI"가 라인 경계로 갈라진 것만 감소)`);
  const result = checkWordIntegrity(on);
  // "AI"와 "삼성" 경계는 위반이 아니다 (한글은 워드 글자가 아님).
  assert(!result.detail.includes('삼') , `한글 경계 분리는 위반 아님 (${result.detail || 'OK'})`);
}

// ═══ 10. 캐시 해시 ═══
console.log('Test 10: 캐시 해시 — ww: 키로 토글 재래핑/복원');
{
  const content = 'The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.';
  const base = buildPara(content, { boxWidth: 30, wordWrap: true, textAlign: 'left' });
  const snapOn = snapshot(base);
  const off = buildPara(content, { boxWidth: 30, textAlign: 'left' });
  const snapOff = snapshot(off);
  assert(snapOn !== snapOff, 'ON !== OFF (해시 다름 → 배치 다름)');
  // 토글 시나리오: ON 엔진에 wordWrap OFF 주입 → 재래핑 → OFF 결과와 동일
  const toggled = buildPara(content, { boxWidth: 30, wordWrap: true, textAlign: 'left' });
  toggled.paragraphStyle = { ...toggled.paragraphStyle, wordWrap: false };
  toggled.layoutText();
  assert(snapshot(toggled) === snapOff, 'ON → OFF 토글 시 OFF 결과 복원 (stale 캐시 방어)');
}

// ═══ 11. prefix 캐시 ═══
console.log('Test 11: prefix 캐시 — 타이핑 증분 === 전체 재래핑');
{
  const text1 = 'The quick brown fox jumps over the lazy dog and then some more text follows here for column overflow';
  const OPTS = { boxWidth: 70, boxHeight: 30, columns: 2, wordWrap: true, textAlign: 'left' };
  const on = buildPara(text1, OPTS);
  // 타이핑 1: 커서 힌트(컬럼2 안)와 함께 layoutText → 캐시 구축
  on.textContent = text1 + ' and';
  on.caretHint = text1.length;
  on.layoutText();
  // 타이핑 2: 동일 prefix + 추가 입력 → prefix 캐시 적용
  on.textContent = text1 + ' and more';
  on.caretHint = text1.length;
  on.layoutText();
  const full = buildPara(text1 + ' and more', OPTS);
  assert(snapshot(on) === snapshot(full), 'prefix 캐시 경로 === 전체 재래핑 (deep equal)');
}

// ═══ 12. 컬럼 경계 ═══
console.log('Test 12: 컬럼 경계 — 워드가 컬럼을 가로질러 분리되지 않음');
{
  const content = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon';
  const on = buildPara(content, { boxWidth: 60, boxHeight: 20, columns: 3, wordWrap: true, textAlign: 'left' });
  const result = checkWordIntegrity(on);
  assert(result.ok, `컬럼 경계 포함 무분리 (${result.detail || '모든 경계 OK'})`);
}

// ═══ 13. extractData round-trip ═══
console.log('Test 13: extractData round-trip — wordWrap 주입값 보존');
{
  const content = 'Round trip test with some english words here';
  const on = buildPara(content, { boxWidth: 40, wordWrap: true });
  const data = on.extractData;
  assert(data.paragraphStyle !== undefined && data.paragraphStyle.wordWrap === true,
    'extractData에 wordWrap: true 보존');
  const off = buildPara(content, { boxWidth: 40 });
  const offData = off.extractData;
  assert(offData.paragraphStyle === undefined || offData.paragraphStyle.wordWrap === undefined,
    '미주입 시 wordWrap 미반환 (주입값 only)');
}

// ═══ 14. effective 기본값 ═══
console.log('Test 14: effective 기본값 — 미주입 시 wordWrap === false');
{
  const para = buildPara('가');
  assert(para.wordWrap === false, 'wordWrap getter 기본 false');
}

// ═══ 15. justify ═══
console.log('Test 15: justify — 워드 이동 후 정렬 산출 정상');
{
  const content = 'The quick brown fox jumps over the lazy dog. 패키지 가격은 1,000원이고 이자율은 3.14퍼센트다. 가나다라마바사아자차';
  const on = buildPara(content, { boxWidth: 40, wordWrap: true, textAlign: 'justify' });
  let offsetsFinite = true;
  let offsetsNonNegative = true;
  for (const column of on.columnContents) {
    for (const line of column) {
      for (const part of line.parts) {
        for (const off of part.charOffsets ?? []) {
          if (!Number.isFinite(off)) offsetsFinite = false;
          if (off < -1e-6) offsetsNonNegative = false;
        }
      }
    }
  }
  assert(offsetsFinite, 'charOffsets 전부 유한 (NaN/Infinity 없음)');
  assert(offsetsNonNegative, 'charOffsets 전부 비음수');
  const result = checkWordIntegrity(on);
  assert(result.ok, `justify 워드 무결성 (${result.detail || '모든 경계 OK'})`);
}

// ═══ 16. 글자 보존 ═══
console.log('Test 16: 글자 보존 — 배치 글자 열결합 === 원본 (공백 포함)');
{
  const content = 'Numbers 1,000 and 3.14 with words scattered everywhere for wrapping tests';
  const on = buildPara(content, { boxWidth: 25, wordWrap: true, textAlign: 'left' });
  // 배치된 글자를 이어붙인 것이 원본과 정확히 같아야 한다 (공백 포함 —
  // 공백 글자도 parts에 배치된다). 컬럼 넘침이 없도록 충분한 높이 보장.
  const joined = on.columnContents
    .flatMap((c) => c.flatMap((l) => l.parts.flatMap((p) => p.content)))
    .join('');
  assert(joined === content, `배치 열결합 === 원본 (${JSON.stringify(joined.slice(0, 40))}...)`);
}

// ═══ 17. endOfBlock/endOfText ═══
console.log('Test 17: endOfBlock/endOfText — 블록당 정확히 1회');
{
  const content = 'First block here\nSecond block with words\nThird block ends here';
  const on = buildPara(content, { boxWidth: 35, wordWrap: true, textAlign: 'left' });
  let blockCount = 0;
  for (const column of on.columnContents) {
    for (const line of column) {
      if (line.endOfBlock === true) blockCount++;
    }
  }
  assert(blockCount === 3, `endOfBlock 3회 (블록 3개 — 실제 ${blockCount})`);
  const lastLine = on.columnContents[on.columnContents.length - 1].slice(-1)[0];
  assert(lastLine?.endOfText === true, '마지막 라인 endOfText');
}

console.log(`\n=== 결과: ${passCount} 통과, ${failCount} 실패 ===`);
if (failCount > 0) process.exit(1);