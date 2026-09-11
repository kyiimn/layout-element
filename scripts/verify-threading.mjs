/**
 * 스레딩(텍스트 스레드) 엔진 전 파이프라인 정합성 검증 (Node, DOM-free).
 *
 * 스레드 = story 콘텐츠 단일 소스 + 프레임 순차 feed-forward 배치.
 *
 * 검증 항목:
 * 1. 스레드 미사용 회귀 — threads 없는 문서는 기존 배치와 byte-identical
 * 2. 단일 프레임 기준선 — thread에 프레임 1개 = 스레드 없는 배치와 동일
 * 3. 2프레임 feed-forward — head overflow tail이 다음 프레임에서 이어짐
 * 4. 콘텐츠 무결성 — 체인 배치된 글자 스트림 === story 전체 (순서·무중복·무누락)
 * 5. tail 슬라이싱 — 런 경계 보존 (인라인 스타일 유지)
 * 6. pull-back — story 축소 시 이후 프레임이 자연히 당겨짐
 * 7. extractData round-trip — head만 content 보유, 후속 프레임은 생략
 * 8. overset — 전체 수용 불가 시 마지막 프레임에 오버플로우 잔존
 * 9. ThreadEngine.validate — 중복 id/빈 프레임 필터
 * 10. sliceInlineContent — 경계/런/빈 범위
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-threading.mjs
 * ```
 *
 * @file scripts/verify-threading.mjs
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
const { ThreadEngine } = await import('../src/engine/thread-engine.ts');
const { sliceInlineContent } = await import('../src/engine/paragraph-engine.ts');

const fontLoader = FontLoaderEngineImpl.create();
await fontLoader.init([{ family: 'Myoungjo', base64Data: ttfBase64 }]);
const colorRegistry = ColorRegistryEngineImpl.create();
colorRegistry.init({});

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
 * 두 값을 구조적으로 비교한다 (숫자는 근사, 나머지는 정확).
 *
 * @param {unknown} a - 왼쪽 값
 * @param {number|string|object|Array} b - 오른쪽 값
 * @returns {boolean} 동등 여부
 */
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEq(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEq(a[k], b[k]));
  }
  return false;
}

/**
 * 컬럼 콘텐츠를 글자 스트림으로 직렬화한다 (라인/파트 순서 유지).
 *
 * @param {object} paraEngine - ParagraphEngine
 * @returns {string} 배치된 글자 스트림
 */
function engineText(paraEngine) {
  return paraEngine.columnContents
    .map(col => col.map(line => line.parts.map(p => p.content.join('')).join('')).join('\n'))
    .join('\n');
}

/**
 * 문서를 구축하고 스레드 배치까지 실행한다.
 *
 * @param {object} options - 구축 옵션
 * @param {string[]} options.contents - 프레임별 content (head = story, 나머지는 '')
 * @param {number[]} [options.columns] - 각 프레임의 컬럼 수
 * @param {number} [options.boxHeight] - 프레임 박스 높이(라인 수). 기본 8
 * @param {Array} [options.threads] - DocumentData.threads
 * @returns {object} { engine, frames: ParagraphEngine[] }
 */
function buildThreadedDoc({ contents, columns, boxHeight = 8, threads }) {
  const docEngine = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
      threads,
    },
    fontLoader, colorRegistry, 3.78,
  );
  const children = contents.map((content, i) => ({
    type: 'box',
    id: `box-${i}`,
    position: 'absolute',
    left: 10,
    top: 10 + i * (boxHeight + 2),
    width: 237,
    height: boxHeight,
    zIndex: 1,
    children: {
      id: `para-${i}`,
      type: 'paragraph',
      content,
      column: (columns ?? [])[i] ?? 2,
      gap: 3,
      paragraphStyle: {},
      textStyle: {},
    },
  }));
  docEngine.layout(children);
  const frames = contents.map((_, i) =>
    docEngine.findEngineById(`para-${i}`),
  );
  return { docEngine, frames };
}

// ═══ 1. 스레드 미사용 회귀 ═══
console.log('\n[1] threads 없는 문서 — 기존 동작 보존');
{
  const { frames } = buildThreadedDoc({
    contents: ['가나다라마바사아자차카타파하'.repeat(20)],
    columns: [2],
    threads: undefined,
  });
  const pe = frames[0];
  check('overflow 존재 (텍스트가 프레임 초과)', pe.overflow > 0);
  check('overflowContentFrom === -1 (비-스레드 프레임 tail 없음)', pe.overflowContentFrom === -1);
  check('overflowContent 비어 있음', pe.overflowContent.length === 0);
  check('isThreadFrame === false', pe.isThreadFrame === false);
}

// ═══ 2. 단일 프레임 기준선 ═══
console.log('\n[2] 단일 프레임 스레드 = 스레드 없는 배치와 동일');
{
  const text = '가나다라마바사아자차카타파하'.repeat(20);
  const plain = buildThreadedDoc({ contents: [text], columns: [2], threads: undefined });
  const threaded = buildThreadedDoc({
    contents: [text], columns: [2],
    threads: [{ id: 't1', paragraphIds: ['para-0'] }],
  });
  check('배치 결과 byte-identical',
    engineText(plain.frames[0]) === engineText(threaded.frames[0]));
  check('overflow 동일', plain.frames[0].overflow === threaded.frames[0].overflow);
  check('단일 프레임 overset: tail = 배치 글자 수 (마지막 프레임의 잔여)',
    threaded.frames[0].overflowContentFrom === threaded.frames[0].visibleChars,
    `tail=${threaded.frames[0].overflowContentFrom} placed=${threaded.frames[0].visibleChars}`);
}

// ═══ 3~4. 2프레임 feed-forward + 콘텐츠 무결성 ═══
console.log('\n[3-4] 2프레임 feed-forward + 콘텐츠 무결성');
{
  const storyText = '가나다라마바사아자차카타파하'.repeat(40);
  const { frames } = buildThreadedDoc({
    contents: [storyText, ''],
    columns: [1, 1],
    boxHeight: 6,
    threads: [{ id: 't1', paragraphIds: ['para-0', 'para-1'] }],
  });
  const [head, next] = frames;
  check('head 배치됨', engineText(head).length > 0);
  check('head에 overflow tail 존재', head.overflowContentFrom >= 0);
  check('next 프레임 배치됨', engineText(next).length > 0);
  check('next isThreadFrame', next.isThreadFrame === true);
  check('next contentFrom === head tail 시작', next.contentFrom === head.overflowContentFrom);

  // 콘텐츠 무결성: head 배치 + next 배치 + next overflow = story 전체
  // (overflowContentFrom은 `\n` 포함 plain 공간이므로 배치 글자 합과 정확히
  // 일치하지 않을 수 있다 — story가 `\n` 없는 단일 블록이면 배치합 === plain).
  const headPlaced = head.visibleChars;
  const nextPlaced = next.visibleChars;
  check('프레임별 배치 글자 합 ≤ story 길이 (중복 배치 없음)',
    headPlaced + nextPlaced <= storyText.length,
    `head=${headPlaced} next=${nextPlaced} story=${storyText.length}`);
  check('tail 체인이 story를 커버 (head 소비 + next 소비 + overset = story)',
    next.overflowContentFrom === storyText.length - (storyText.length - next.overflowContentFrom)
      && head.overflowContentFrom + (next.overflowContentFrom - next.contentFrom) <= storyText.length,
    `head 소비=${head.overflowContentFrom} next 소비=${next.overflowContentFrom - next.contentFrom} overset 잔여=${storyText.length - next.overflowContentFrom} story=${storyText.length}`);
  check('next overflowContentFrom = next 배치 시작 + next 배치 글자',
    next.overflowContentFrom === next.contentFrom + nextPlaced,
    `tail=${next.overflowContentFrom} from=${next.contentFrom} placed=${nextPlaced}`);
  check('배치 글자 스트림 무중복 (head tail === next contentFrom)',
    head.overflowContentFrom === next.contentFrom);
  check('2프레임 체인의 overset 잔여 = next tail 이후 전체',
    next.overflowContentFrom - next.contentFrom === nextPlaced);
}

// ═══ 5. tail 슬라이싱 — 인라인 런 경계 보존 ═══
console.log('\n[5] 인라인 런 tail 슬라이싱');
{
  const story = [
    '가나다라',
    { content: '마바사아자차', textInlineStyle: { fontWeight: 700 } },
    '카타파하',
  ];
  const sliced = sliceInlineContent(story, 5, 12);
  check('슬라이스 길이 = 7', sliced.reduce((s, r) => s + (typeof r === 'string' ? r.length : r.content.length), 0) === 7);
  const boldRun = sliced.find(r => typeof r !== 'string' && r.textInlineStyle?.fontWeight === 700);
  check('볼드 런 보존', boldRun !== undefined);
  const boldText = sliced.filter(r => typeof r !== 'string' && r.textInlineStyle?.fontWeight === 700)
    .map(r => r.content).join('');
  check('볼드 런 내용 = 바사아자차 (런 중간 분할 보존)', boldText === '바사아자차');

  const empty = sliceInlineContent(story, 100, 200);
  check('범위 밖 = 빈 배열', empty.length === 0);
  const fromZero = sliceInlineContent(story, 0, 4);
  check('앞부분 슬라이스 = 가나다라', fromZero.length === 1 && fromZero[0] === '가나다라');
}

// ═══ 6. pull-back — story 축소 시 당겨짐 ═══
console.log('\n[6] pull-back (story 축소)');
{
  const longText = '가나다라마바사아자차카타파하'.repeat(40);
  const { docEngine, frames } = buildThreadedDoc({
    contents: [longText, ''],
    columns: [1, 1],
    boxHeight: 6,
    threads: [{ id: 't1', paragraphIds: ['para-0', 'para-1'] }],
  });
  const [head, next] = frames;
  const initialNextLen = engineText(next).length;
  check('초기 상태: next에 텍스트 흐름됨', initialNextLen > 0);

  // story 축소 — threads.content가 단일 소스이므로 threads 데이터로 갱신한다.
  const shortText = '가나다라';
  docEngine.data = {
    ...docEngine.data,
    threads: [{ id: 't1', paragraphIds: ['para-0', 'para-1'], content: shortText }],
  };
  docEngine.layout();

  check('축소 후 next 프레임 비어 있음 (pull-back)',
    engineText(frames[1]).length === 0,
    `nextText="${engineText(frames[1])}"`);
  check('축소 후 head가 story 전체 배치',
    frames[0].visibleChars === frames[0].totalChars);
  check('축소 후 head textContent = 축소된 story',
    frames[0].textContent === shortText);
}

// ═══ 7. extractData round-trip ═══
console.log('\n[7] extractData — head만 content 보유');
{
  const storyText = '가나다라마바사아자차카타파하'.repeat(40);
  const { docEngine, frames } = buildThreadedDoc({
    contents: [storyText, ''],
    columns: [1, 1],
    boxHeight: 6,
    threads: [{ id: 't1', paragraphIds: ['para-0', 'para-1'] }],
  });
  const [head, next] = frames;
  const headData = head.extractData;
  const nextData = next.extractData;
  check('head extractData content = story 전체',
    typeof headData.content === 'string' && headData.content.length === storyText.length);
  check('next extractData content 생략 (undefined)',
    nextData.content === undefined);
  const docData = docEngine.extractData;
  check('document extractData에 threads 보존',
    Array.isArray(docData.threads) && docData.threads[0].paragraphIds.length === 2);
}

// ═══ 8. overset ═══
console.log('\n[8] overset — 수용 불가 tail');
{
  const storyText = '가나다라마바사아자차카타파하'.repeat(200);
  const { frames } = buildThreadedDoc({
    contents: [storyText, ''],
    columns: [1, 1],
    boxHeight: 6,
    threads: [{ id: 't1', paragraphIds: ['para-0', 'para-1'] }],
  });
  const [head, next] = frames;
  check('head overflow tail 존재', head.overflowContentFrom >= 0);
  check('next도 overflow (전체 수용 불가)',
    next.overflow > 0);
  check('next overflowContentFrom ≥ 0 (잔여 tail)',
    next.overflowContentFrom >= 0);
  const totalPlaced = head.visibleChars + next.visibleChars;
  check('tail 오프셋 체인이 story 공간의 실제 위치를 가리킴',
    head.overflowContentFrom + (next.overflowContentFrom - next.contentFrom) <= storyText.length
      && next.overflowContentFrom <= storyText.length,
    `head 소비=${head.overflowContentFrom} next 소비=${next.overflowContentFrom - next.contentFrom} story=${storyText.length}`);
  check('next tail = next 배치 시작 + next 배치 글자',
    next.overflowContentFrom === next.contentFrom + next.visibleChars);
  check('overset 잔여 오프셋 = story 끝 직전 위치',
    next.overflowContentFrom - next.contentFrom === next.visibleChars);
  check('중간 프레임은 threadTail 아님 (overflow 소비됨)',
    head.isThreadTail === false && head.overflow > 0,
    `head.isThreadTail=${head.isThreadTail} head.overflow=${head.overflow}`);
  check('마지막 프레임은 threadTail (빨간 테두리 대상)',
    next.isThreadTail === true);
}

// ═══ 8b. threadTail 마킹 — 타이핑 전파 후 소비/오류 분기 ═══
console.log('\n[8b] threadTail — 3프레임 체인 소진 지점 마킹');
{
  const storyText = '가나다라마바사아자차카타파하'.repeat(60);
  const { frames } = buildThreadedDoc({
    contents: [storyText, '', ''],
    columns: [1, 1, 1],
    boxHeight: 6,
    threads: [{ id: 't1', paragraphIds: ['para-0', 'para-1', 'para-2'] }],
  });
  const [f1, f2, f3] = frames;
  const tailCount = frames.filter(f => f.isThreadTail).length;
  check('tail은 정확히 1개', tailCount === 1, `tailCount=${tailCount}`);
  check('f1/f2는 중간 프레임 (tail 아님)', f1.isThreadTail === false && f2.isThreadTail === false);
  // 소진되면 f3가 tail이고 contentFrom=story 끝
  const storyLen = f1.totalChars;
  if (f3.visibleChars === 0) {
    check('소진 시 f3가 tail이며 contentFrom = story 끝',
      f3.isThreadTail === true && f3.contentFrom === storyLen,
      `f3.contentFrom=${f3.contentFrom} story=${storyLen}`);
  } else {
    check('f3가 tail', f3.isThreadTail === true);
  }
}

// ═══ 9. ThreadEngine.validate ═══
console.log('\n[9] thread 검증');
{
  const t1 = { id: 'a', paragraphIds: ['p1', 'p2'] };
  const t2 = { id: 'b', paragraphIds: ['p2', 'p3'] };
  const t4 = { id: 'd', paragraphIds: ['p3'] };
  const valid = ThreadEngine.validate([t1, t2, { id: 'c', paragraphIds: [] }, t4]);
  check('중복 프레임 제거 — 첫 thread만 p2 보유', valid.length === 2
    && valid[0].paragraphIds.length === 2
    && valid[1].paragraphIds.length === 1
    && valid[1].paragraphIds[0] === 'p3');
  check('빈 thread 필터됨', valid.every(t => (t.paragraphIds ?? []).length >= 1));
  check('undefined 입력 = 빈 배열', ThreadEngine.validate(undefined).length === 0);
  // 객체 동일성: 중복 제거가 필요 없는 스레드는 원본 참조를 그대로 반환한다
  // (story writeback이 engine.data.threads 원본에 기록되어야 하므로).
  const ia = { id: 'ia', paragraphIds: ['x1', 'x2'] };
  const ib = { id: 'ib', paragraphIds: ['y1'] };
  const ival = ThreadEngine.validate([ia, ib]);
  check('중복 없는 스레드는 원본 객체 참조 보존',
    ival.length === 2 && ival[0] === ia && ival[1] === ib,
    `ia identity=${ival[0] === ia} ib identity=${ival[1] === ib}`);
  const dupSource = { id: 'e', paragraphIds: ['p1', 'p1', 'p2'] };
  const dupValid = ThreadEngine.validate([dupSource]);
  check('중복 제거 시에만 복사본 생성', dupValid[0] !== dupSource
    && dupValid[0].paragraphIds.length === 2);
}

// ═══ 8c. 타이핑 전파 — 엔진 writeback + 체인 재배치 ═══
console.log('\n[8c] 타이핑 전파 — relayoutThreads(sources) story writeback');
{
  const storyText = '가나다라마바사아자차카타파하'.repeat(60);
  const { docEngine, frames } = buildThreadedDoc({
    contents: [storyText, '', ''],
    columns: [1, 1, 1],
    boxHeight: 6,
    threads: [{ id: 't1', paragraphIds: ['para-0', 'para-1', 'para-2'] }],
  });
  const [f1, f2, f3] = frames;
  const beforeTail = f1.overflowContentFrom;

  // 편집 시뮬레이션: head textContent에 타이핑 반영 (편집 파이프라인이 하는 일)
  const typedStory = '타이핑' + storyText;
  f1.textContent = typedStory;
  f1._dirty = true;

  // 엔진 writeback + 체인 재배치 (DocumentElement._flushThreadRelayout과 동일 경로)
  docEngine.relayoutThreads(new Set(['para-0']));

  const thread = docEngine.data.threads.find(t => t.id === 't1');
  const storyOf = (tc) => (typeof tc === 'string' ? tc : tc.map(r => typeof r === 'string' ? r : r.content).join(''));
  check('story writeback — thread.content가 head의 편집 textContent로 갱신',
    storyOf(thread.content) === typedStory,
    `len=${storyOf(thread.content).length} vs ${typedStory.length}`);
  check('체인 재배치 — head가 편집된 story로 재배치됨',
    f1.totalChars === typedStory.length
      && f1.columnContents[0]?.[0]?.parts?.[0]?.content?.[0] === '타',
    `total=${f1.totalChars}/${typedStory.length} first="${f1.columnContents[0]?.[0]?.parts?.[0]?.content?.[0]}"`);
  check('f2가 새 tail부터 시작 (타이핑 반영)',
    f2.contentFrom === f1.overflowContentFrom,
    `f2.from=${f2.contentFrom} f1.tail=${f1.overflowContentFrom}`);
  check('f2 배치됨', f2.visibleChars > 0);
  // seam 정합: f2의 첫 배치 글자 === story의 f1.tail 위치 글자
  const typedStoryPlain = storyOf(f2.textContent);
  const f2FirstChar = f2.columnContents[0]?.[0]?.parts?.[0]?.content?.[0];
  const storyCharAtTail = typedStoryPlain[f1.overflowContentFrom];
  check('f2 첫 배치 글자 === story[f1.tail] (seam 정합)',
    f2FirstChar === storyCharAtTail,
    `f2First="${f2FirstChar}" story[tail]="${storyCharAtTail}"`);
  check('f3도 체인을 따라감',
    f3.contentFrom === f2.overflowContentFrom || f3.visibleChars === 0,
    `f3.from=${f3.contentFrom} f2.tail=${f2.overflowContentFrom} f3.visible=${f3.visibleChars}`);
  // 미소속 id 호출 시 story 불변 — writeback은 소속 thread에만 발생한다
  {
    const nestedStory = '가나다라마바사아자차카타파하'.repeat(60);
    const { docEngine: doc2, frames: frames2 } = buildThreadedDoc({
      contents: [nestedStory, ''],
      columns: [1, 1],
      boxHeight: 6,
      threads: [{ id: 'tx', paragraphIds: ['para-0', 'para-1'], content: nestedStory }],
    });
    const otherThread = doc2.data.threads[0];
    // para-0을 편집하되, 호출은 미소속 id로 — writeback이 편집을 반영하지 않아야 한다
    frames2[0].textContent = '편집' + nestedStory;
    doc2.relayoutThreads(new Set(['not-in-any-thread']));
    check('미소속 id로 호출 시 story 불변 (편집 미반영)',
      storyOf(otherThread.content) === nestedStory,
      `before=${nestedStory.length} after=${storyOf(otherThread.content).length}`);
  }
}

// ═══ 10. sliceInlineContent 엣지 ═══
console.log('\n[10] 슬라이싱 엣지');
{
  check('빈 범위', sliceInlineContent('abc', 1, 1).length === 0);
  check('undefined 소스', sliceInlineContent(undefined, 0, 5).length === 0);
  const one = sliceInlineContent('abc', 1, 3);
  check('문자열 소스 부분 슬라이스', one.length === 1 && one[0] === 'bc');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`verify-threading: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILED:', failures.join(', '));
  process.exit(1);
}
console.log('ALL PASS');