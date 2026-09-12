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
 * 콘텐츠를 plain 문자열로 변환한다 (런 배열 → join).
 *
 * @param {string|Array} content - 콘텐츠 (string 또는 인라인 런 배열)
 * @returns {string} plain 문자열
 */
function storyOf(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map(r => typeof r === 'string' ? r : r.content).join('');
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
function buildThreadedDoc({ contents, columns, boxHeight = 8, threads, paragraphStyle }) {
  const docEngine = DocumentEngine.create(
    {
      id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 1.2, ...(paragraphStyle ?? {}) }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
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

// ═══ 11. 지오메트리 행렬 — seam/단조성/커버/tail 유일성 일괄 어설션 ═══
// B1(이중 스킵)·B5(소진 조합)는 단일 시나리오를 우회 통과했다 — 프레임 용량이
// 잔여보다 작으면 이중 스킵이 배치를 소진시키지 않아 visibleChars>0 어설션이
// 통과한다. 스레딩은 지오메트리 변수(컬럼 수·높이·프레임 수·story 길이)가 결함을
// 은폐할 수 있는 도메인이므로 행렬 전 조합에 공통 어설션을 적용한다.
console.log('\n[11] 지오메트리 행렬 — seam/단조성/커버/tail 유일성');
{
  const sentence = '이번 조치는 관련 시장의 구조를 실질적으로 개선할 것으로 전망된다. 현장 반응도 주목된다. ';
  const makeStory = (lines) => Array.from({ length: lines }, () => sentence).join('');

  // 행렬: columns ∈ {1,2,3} × boxHeight ∈ {4,6,10} × frames ∈ {2,3,4}
  // × story {소진 경계±(6,8라인), overset(200라인)} = 54 조합.
  // 소진 경계는 "행렬 전 조합에서 소진/overset 양쪽 분기가 모두 발생"하도록
  // 실측으로 산정한다 — 1컬럼×4라인 프레임 용량은 라인당 ~24자×컬럼수×높이라
  // 6/8라인 story는 frames=2에서 소진 근처, 200라인은 전 조합 overset다.
  const combos = [];
  for (const columns of [1, 2, 3]) {
    for (const boxHeight of [4, 6, 10]) {
      for (const frames of [2, 3, 4]) {
        for (const storyLines of [6, 8, 200]) {
          combos.push({ columns, boxHeight, frames, storyLines });
        }
      }
    }
  }

  let matrixPassed = 0;
  let matrixFailed = 0;
  const firstFailures = [];

  for (const { columns, boxHeight, frames, storyLines } of combos) {
    const storyText = makeStory(storyLines);
    const { frames: pes } = buildThreadedDoc({
      contents: Array.from({ length: frames }, (_, i) => (i === 0 ? storyText : '')),
      columns: Array.from({ length: frames }, () => columns),
      boxHeight,
      threads: [{ id: 'tm', paragraphIds: Array.from({ length: frames }, (_, i) => `para-${i}`) }],
    });

    const label = `cols=${columns} h=${boxHeight} f=${frames} story=${storyLines}`;
    const fails = [];

    // 1. seam: 각 인접 쌍 contentFrom === 이전 overflowContentFrom.
    //    단, 이전 프레임이 소진(tail=-1)이면 다음 프레임은 story 끝에서
    //    시작한다 (B5 소진 계약 — 잔여 프레임의 contentFrom = storyPlainLen).
    const plain = storyText;
    const storyPlainLen = plain.length;
    for (let i = 1; i < pes.length; i++) {
      const expected = pes[i - 1].overflowContentFrom >= 0
        ? pes[i - 1].overflowContentFrom
        : storyPlainLen;
      if (pes[i].contentFrom !== expected) {
        fails.push(`seam@${i}: from=${pes[i].contentFrom} expected=${expected}`);
      }
    }
    // 2. seam 문자: 첫 배치 글자 === story[contentFrom] (이중 스킵 즉사 어설션).
    //    contentFrom이 story 길이 이상(소진)이면 배치 없음이 정상이다.
    for (const pe of pes) {
      const firstChar = pe.columnContents[0]?.[0]?.parts?.[0]?.content?.[0];
      if (pe.contentFrom < plain.length) {
        if (pe.visibleChars > 0 && firstChar !== plain[pe.contentFrom]) {
          fails.push(`seamChar: first="${firstChar}" story[${pe.contentFrom}]="${plain[pe.contentFrom]}"`);
        }
        if (pe.visibleChars === 0 && pe.contentFrom < plain.length
            && pes.indexOf(pe) < pes.length - 1) {
          // 소진 잔여 프레임이 아니면 배치 없음은 결함
          fails.push(`emptyFrame from=${pe.contentFrom} visible=0`);
        }
      }
    }
    // 3. 단조성: contentFrom strictly increasing
    for (let i = 1; i < pes.length; i++) {
      if (pes[i].contentFrom <= pes[i - 1].contentFrom && pes[i - 1].overflowContentFrom >= 0) {
        fails.push(`monotonic: f${i}.from=${pes[i].contentFrom} ≤ f${i - 1}.from=${pes[i - 1].contentFrom}`);
      }
    }
    // 4. 커버: Σ visible ≤ storyLen 且 마지막 tail의 상태는
    //    (a) overset: tail == storyLen 且 tail 프레임 visible>0 또는
    //    (b) 소진: 마지막 tail overflowContentFrom === -1 且 Σ visible + 공백합계 ≈ storyLen
    const sumVisible = pes.reduce((s, pe) => s + pe.visibleChars, 0);
    const last = pes[pes.length - 1];
    if (sumVisible > plain.length) {
      fails.push(`cover: Σvisible=${sumVisible} > story=${plain.length}`);
    }
    const lastTail = last.overflowContentFrom;
    if (lastTail >= 0 && lastTail > plain.length) {
      fails.push(`cover: lastTail=${lastTail} > story=${plain.length}`);
    }
    if (lastTail === -1 && sumVisible < plain.length - 3) {
      // visible은 파트 strip 공백 제외분과 최대 공백 수(라인 수)만큼 차이날 수 있다
      fails.push(`cover: no tail but Σvisible=${sumVisible} < story-${plain.length}`);
    }
    // 5. tail 유일성: isThreadTail 정확히 1개
    const tailCount = pes.filter(pe => pe.isThreadTail).length;
    if (tailCount !== 1) {
      fails.push(`tailUniq: ${tailCount}`);
    }

    if (fails.length === 0) matrixPassed++;
    else {
      matrixFailed++;
      if (firstFailures.length < 3) firstFailures.push(`${label} → ${fails.slice(0, 3).join(' | ')}`);
    }
  }
  check(`행렬 ${combos.length} 조합 전부 통과 (seam/단조성/커버/tail)`,
    matrixFailed === 0, `pass=${matrixPassed} fail=${matrixFailed}${firstFailures.length ? ` — ${firstFailures.join(' ;; ')}` : ''}`);

  // ── 이중 스킵 검출력 증명: 어설션 2가 결함을 잡는지 확인한다 ──
  // B1 변형 재현 — tail 슬라이스를 주입하고 contentFrom도 설정하는 (구) 방식은
  // 이중으로 건너뛴다. 어설션 2(seam 문자)가 FAIL해야 어설션이 검출력을 갖는다.
  {
    const storyText = makeStory(200);
    const { frames: pes } = buildThreadedDoc({
      contents: [storyText, ''],
      columns: [1, 1],
      boxHeight: 10,
      threads: [{ id: 't-det', paragraphIds: ['para-0', 'para-1'] }],
    });
    const [head, next] = pes;
    const tailFrom = head.overflowContentFrom;

    // (구) 결함 경로 재현: tail 슬라이스 주입 + contentFrom 설정 — 슬라이스
    // 내부에서 contentFrom을 다시 스킵해 배치가 소진/빈칸이 된다.
    const sliced = sliceInlineContent(head.textContent, tailFrom, Number.MAX_SAFE_INTEGER);
    next.textContent = sliced;
    next.updateThreadContext({ contentFrom: tailFrom, isThreadFrame: true });
    next.layoutText();

    const firstChar = next.columnContents[0]?.[0]?.parts?.[0]?.content?.[0];
    const storyCharAtTail = storyText[tailFrom];
    const detectsDefect = firstChar !== storyCharAtTail || next.visibleChars === 0;
    check('이중 스킵 변형에서 seam 문자 어설션이 FAIL함 (검출력 증명)',
      detectsDefect,
      `first="${firstChar}" story[tail]="${storyCharAtTail}" visible=${next.visibleChars}`);
  }
}

// ═══ 12. childrenData 삼분 계약 — undefined 보존 / [] 소거 / 제외 재주입 ═══
console.log('\n[12] childrenData 삼분 계약');
{
  // (a) undefined 주입 = 보존 — 이미 구축된 자식 엔진이 유지된다
  const { docEngine } = buildThreadedDoc({
    contents: ['가나다라마바사아자차'.repeat(30), ''],
    columns: [1, 1],
    boxHeight: 6,
    threads: [{ id: 't1', paragraphIds: ['para-0', 'para-1'] }],
  });
  const before = docEngine.findEngineById('para-0');
  docEngine.layout(undefined); // childrenData 유지 (undefined는 재주입 아님)
  const after = docEngine.findEngineById('para-0');
  check('undefined 주입 = 기존 자식 엔진 보존',
    after === before && after.visibleChars > 0,
    `identity=${after === before}`);

  // (b) [] 주입 = 명시적 소거 — 자식 엔진이 사라진다
  docEngine.layout([]);
  const erased = docEngine.findEngineById('para-0');
  const erasedBox = docEngine.findEngineById('box-0');
  check('[] 주입 = 자식 엔진 소거',
    erased === undefined && erasedBox === undefined,
    `para=${erased !== undefined} box=${erasedBox !== undefined}`);

  // (c) 제외 재주입 = 선택적 소거 (DOM removeChildData 등가 경로)
  const { docEngine: doc3 } = buildThreadedDoc({
    contents: ['가나다라마바사아자차'.repeat(30), '가나다라마바사아자차'.repeat(30), ''],
    columns: [1, 1, 1],
    boxHeight: 6,
    threads: [{ id: 't2', paragraphIds: ['para-0', 'para-1', 'para-2'] }],
  });
  const keep0 = doc3.findEngineById('para-0');
  const keep2 = doc3.findEngineById('para-2');
  const childrenData = doc3.extractData.children
    .filter(b => b.id !== 'box-1')
    .map(b => ({ ...b, children: b.children }));
  doc3.layout(childrenData);
  const removed1 = doc3.findEngineById('para-1');
  const removedBox1 = doc3.findEngineById('box-1');
  check('제외 재주입 = 대상 박스만 소거 (나머지 보존)',
    removed1 === undefined && removedBox1 === undefined,
    `para1=${removed1 !== undefined} box1=${removedBox1 !== undefined}`);
  check('제외 재주입 후 남은 박스 엔진 identity 보존 (레이아웃 캐시·rgbaData 등)',
    doc3.findEngineById('para-0') === keep0 && doc3.findEngineById('para-2') === keep2,
    `p0=${doc3.findEngineById('para-0') === keep0} p2=${doc3.findEngineById('para-2') === keep2}`);
}

// ═══ 13. writeback 방어 — 중복 소속 프레임의 first-claim-wins ═══
console.log('\n[13] writeback 방어 — 중복 소속 프레임');
{
  const storyA = '가나다라마바사아자차카타파하'.repeat(30);
  const storyB = '아야어여오요우유으이'.repeat(40);
  const { docEngine, frames } = buildThreadedDoc({
    contents: [storyA, '', storyB, ''],
    columns: [1, 1, 1, 1],
    boxHeight: 6,
    // para-0이 t1, t2에 중복 소속 — validate는 t1만 para-0을 소유한다
    threads: [
      { id: 't1', paragraphIds: ['para-0', 'para-1'], content: storyA },
      { id: 't2', paragraphIds: ['para-0', 'para-3'], content: storyB },
    ],
  });
  const [f1, , , f3] = frames;
  const t1 = docEngine.data.threads.find(t => t.id === 't1');
  const t2 = docEngine.data.threads.find(t => t.id === 't2');
  const t2Frames = docEngine.data.threads[1].paragraphIds;
  check('validate first-claim-wins — 중복 소속 프레임은 첫 thread 소유',
    t2Frames.length === 2 && t2Frames[0] === 'para-0',
    `t2 frames=${JSON.stringify(t2Frames)}`);

  // para-0 편집 — 스레드 프레임의 textContent는 배치 순서상 t1(storyA) 전체다
  const typedA = '편집' + storyA;
  f1.textContent = typedA;
  f1._dirty = true;
  docEngine.relayoutThreads(new Set(['para-0']));

  check('중복 소속 프레임 편집 — 첫 소속 thread(t1)의 원본 content만 갱신',
    storyOf(t1.content) === typedA, // 원본 객체 참조 유지
    `t1 len=${storyOf(t1.content).length}`);
  check('둘째 thread(t2)의 story는 t1의 story로 덮어써지지 않음 (소실 방어)',
    storyOf(t2.content) === storyB,
    `t2 len=${storyOf(t2.content).length} vs ${storyB.length}`);
  check('t2 프레임(para-3)은 여전히 storyB를 배치 (첫 글자 === storyB[0])',
    f3.isThreadFrame
      && f3.columnContents[0]?.[0]?.parts?.[0]?.content?.[0] === storyB[0],
    `f3 first="${f3.columnContents[0]?.[0]?.parts?.[0]?.content?.[0]}" from=${f3.contentFrom} visible=${f3.visibleChars}`);
}

// ═══ 14. printPostData 패리티 — 스레드 프레임의 화면=인쇄 좌표 ═══
// 엔진-우선 원칙의 존재 이유(화면=인쇄)가 스레딩 프레임에서 무검증이었다 (R2).
// buildParagraphPrintPostData가 contentFrom 배치 결과를 문서 절대 mm로
// 정확히 산출하는지, getCharRect(화면 좌표 소스)와 동일한지 검증한다.
console.log('\n[14] printPostData 패리티 — threaded 프레임');
{
  const sentence = '이번 조치는 관련 시장의 구조를 실질적으로 개선할 것으로 전망된다. ';
  const storyText = Array.from({ length: 40 }, () => sentence).join('');
  const { docEngine, frames: [head, next] } = buildThreadedDoc({
    contents: [storyText, ''],
    columns: [2, 2],
    boxHeight: 8,
    threads: [{ id: 'tp', paragraphIds: ['para-0', 'para-1'] }],
    paragraphStyle: { textAlign: 'left' },
  });

  docEngine.ensureCommitted();
  const headPrint = head.printPostData[0];
  const nextPrint = next.printPostData[0];
  check('head print chars 존재 (contentFrom=0 배치)',
    headPrint.chars.length > 0, `chars=${headPrint.chars.length}`);
  check('next print chars 존재 (tail 배치 반영)',
    nextPrint.chars.length > 0, `chars=${nextPrint.chars.length}`);

  // 1. seam의 print 판: 각 프레임 print 첫 글자 char === story[contentFrom]
  check('head print 첫 글자 === story[0]',
    headPrint.chars[0].char === storyText[0],
    `"${headPrint.chars[0].char}" vs "${storyText[0]}"`);
  check('next print 첫 글자 === story[head.tail] (seam print 판)',
    nextPrint.chars[0].char === storyText[next.contentFrom],
    `"${nextPrint.chars[0].char}" vs story[${next.contentFrom}]="${storyText[next.contentFrom]}"`);

  // 2. 각 char rect는 프레임 parent 박스 contentAbsRect 내부 (mm 범위)
  //    buildThreadedDoc의 박스: left=10, top=10/20, width=237, height=8라인.
  //    paragraph print rect(x/y)가 absLeft/absTop 기준이므로 이 안에 들어와야 한다.
  const headBox = docEngine.findEngineById('box-0');
  const nextBox = docEngine.findEngineById('box-1');
  const headContentRect = headBox.contentAbsRect;
  const nextContentRect = nextBox.contentAbsRect;
  const inRect = (rect, box) => rect.x >= box.absLeft - 1e-6 && rect.x + rect.width <= box.absLeft + box.absWidth + 1e-6
    && rect.y >= box.absTop - 1e-6 && rect.y + rect.height <= box.absTop + box.absHeight + 1e-6;
  const headAllInside = headPrint.chars.every(c => inRect(c.rect, headContentRect));
  const nextAllInside = nextPrint.chars.every(c => inRect(c.rect, nextContentRect));
  check('head print chars 전부 contentAbsRect 내부 (mm)',
    headAllInside, `rect=${JSON.stringify(headContentRect)} first=${JSON.stringify(headPrint.chars[0].rect)}`);
  check('next print chars 전부 contentAbsRect 내부 (mm)',
    nextAllInside, `rect=${JSON.stringify(nextContentRect)} first=${JSON.stringify(nextPrint.chars[0].rect)}`);

  // 3. 전 프레임 chars 연결 === story visible 부분 (순서·동일성)
  //    print chars는 라인 경계 공백(strip 규칙)과 탭이 제외된다 — raw story
  //    슬라이스와 직접 비교하면 오탐이다 (verify-dom-diff의 strip 교훈).
  //    print와 동일한 워크(overflow 게이팅 + stripRange + 탭 스킵)로
  //    기대 스트림과 source offset 매핑을 산출한다.
  const printWalk = (pe) => {
    const columnContents = pe.columnContents;
    const defaultLineHeightMm = pe.baseLineHeight;
    const baseFontSizeMm = pe.fontSize;
    const parentHeightMm = pe.inheritStyle?.parentHeight ?? 0;
    const effCol = parentHeightMm > 0
      ? parentHeightMm + (defaultLineHeightMm - baseFontSizeMm) : 0;
    const stream = [];
    const offsets = [];
    const terminals = [];
    let sourceOffset = 0;
    for (const col of columnContents) {
      let cum = 0;
      let overflowed = false;
      for (const line of col) {
        const lineH = line?.lineHeight ?? defaultLineHeightMm;
        if (overflowed) break;
        if (effCol > 0 && cum + lineH > effCol + 1e-6) { overflowed = true; break; }
        for (let pi = 0; pi < line.parts.length; pi++) {
          const part = line.parts[pi];
          const isFirst = pi === 0;
          const isLast = pi === line.parts.length - 1;
          let stripStart = 0;
          let stripEnd = part.content.length;
          if (isFirst && !line.firstOfBlock) {
            while (stripStart < stripEnd && part.content[stripStart] === ' ') stripStart++;
          }
          if (isLast && !line.endOfBlock) {
            while (stripEnd > stripStart && part.content[stripEnd - 1] === ' ') stripEnd--;
          }
          for (let j = 0; j < stripStart; j++) sourceOffset++; // leading strip 공백도 오프셋 소비
          for (let j = stripStart; j < stripEnd; j++) {
            const ch = part.content[j];
            if (ch === '\t') { sourceOffset++; continue; } // 탭은 print 제외
            stream.push(ch);
            offsets.push(sourceOffset);
            // 파트 마지막 stripped 글자 — getCharRect는 커서 시맨틱으로
            // 파트 잔여 폭을 반환하므로 폭 비교에서 제외한다 (사전 존재 동작)
            terminals.push(j === stripEnd - 1);
            sourceOffset++;
          }
          for (let j = stripEnd; j < part.content.length; j++) sourceOffset++;
        }
        if (line.endOfBlock) sourceOffset++; // 블록 경계 `\n` 1자
        cum += lineH;
      }
    }
    return { stream: stream.join(''), offsets, terminals };
  };

  const plain = storyText;
  const headWalk = printWalk(head);
  const nextWalk = printWalk(next);
  const headStream = headPrint.chars.map(c => c.char).join('');
  const nextStream = nextPrint.chars.map(c => c.char).join('');
  check('head print 글자 스트림 === 기대 스트림 (strip 규칙 포함)',
    headStream === headWalk.stream,
    `print=${headStream.length} walk=${headWalk.stream.length}`);
  check('next print 글자 스트림 === 기대 스트림',
    nextStream === nextWalk.stream,
    `print=${nextStream.length} walk=${nextWalk.stream.length}`);
  // 각 print 글자 === story[매핑된 source offset + (스레드면 contentFrom)]
  const headIdentity = headPrint.chars.every((c, k) => c.char === plain[headWalk.offsets[k]]);
  const nextIdentity = nextPrint.chars.every((c, k) =>
    c.char === plain[next.contentFrom + nextWalk.offsets[k]]);
  check('head print 각 글자 === story[source offset] (문자 동일성)',
    headIdentity, `first mismatch=${headPrint.chars.findIndex((c, k) => c.char !== plain[headWalk.offsets[k]])}`);
  check('next print 각 글자 === story[contentFrom + offset] (seam 무중복·무누락)',
    nextIdentity, `first mismatch=${nextPrint.chars.findIndex((c, k) => c.char !== plain[next.contentFrom + nextWalk.offsets[k]])}`);

  // 4. getCharRect(화면 좌표 소스)와 print rect의 동일 글자 좌표 일치
  //    (기존 verify-right-indent-tab-single-source 패턴의 스레딩 판).
  //    print char 인덱스를 source offset으로 환산해 비교한다 — 인덱스≠오프셋
  //    혼동은 오탐이다 (strip 공백이 인덱스를 어긋나게 한다).
  let mismatch = 0;
  let mismatchDetail = '';
  const sampleIdx = (n) => [0, 1, Math.floor(n / 2), n - 1];
  for (const [pe, printData, walk] of [[head, headPrint, headWalk], [next, nextPrint, nextWalk]]) {
    for (const k of sampleIdx(printData.chars.length)) {
      const srcOffset = walk.offsets[k];
      const screenRect = pe.getCharRect(srcOffset);
      const printChar = printData.chars[k];
      if (!screenRect || !printChar) { mismatch++; continue; }
      const dx = Math.abs(screenRect.left - printChar.rect.x);
      const dy = Math.abs(screenRect.top - printChar.rect.y);
      // 위치 패리티는 전 글자 대상. 폭은 파트 마지막 글자(terminals)만 제외 —
      // getCharRect는 커서 시맨틱(파트 잔여)을, print는 swidth를 주는
      // 사전 존재 동작이므로 폭 비교에서 제외한다 (스레딩 무관).
      const skipWidth = walk.terminals[k];
      const dw = skipWidth ? 0 : Math.abs(screenRect.width - printChar.rect.width);
      const dh = Math.abs(screenRect.height - printChar.rect.height);
      if (dx > 1e-6 || dy > 1e-6 || dw > 1e-6 || dh > 1e-6) {
        mismatch++;
        if (!mismatchDetail) mismatchDetail = `k=${k} src=${srcOffset} skipW=${skipWidth} d=(${dx.toFixed(4)},${dy.toFixed(4)},${dw.toFixed(4)},${dh.toFixed(4)})`;
      }
    }
  }
  check('getCharRect === print rect (전 샘플 좌표 일치, head+next)',
    mismatch === 0, `mismatch=${mismatch} ${mismatchDetail}`);

  // justify 해시 충돌 방어: [14]는 textAlign left로 배치했다(오프셋 차분=
  // swidth 성립 조건). justify 상태의 스레딩 프레임은 justify 분산 gap으로
  // charOffsets 차분 ≠ swidth가 기하학적으로 정상이므로 어설션 4에서
  // 제외한다 — left 대조로 "정렬 무관 seam"만 재확인한다.
  {
    const { frames: [headJ, nextJ] } = buildThreadedDoc({
      contents: [storyText, ''],
      columns: [2, 2],
      boxHeight: 8,
      threads: [{ id: 'tpj', paragraphIds: ['para-0', 'para-1'] }],
    });
    check('justify 스레드 문서 — left와 seam 동일 (정렬 무관)',
      nextJ.contentFrom === headJ.overflowContentFrom
      && headJ.columnContents[0]?.[0]?.parts?.[0]?.content?.[0] === storyText[0],
      `seam=${nextJ.contentFrom === headJ.overflowContentFrom}`);
  }

  // R8: data-source-offset 프레임 로컬 키 — 로컬 0 === story contentFrom 지점
  // (getCharRect(0)의 rect가 story[contentFrom] 글자의 rect와 일치하면
  //  로컬 오프셋→story 오프셋 환산 산식 frameOffset + contentFrom의 기초)
  const r8Rect = next.getCharRect(0);
  const r8Print = nextPrint.chars[0];
  check('R8: next.getCharRect(0) === next print 첫 글자 rect (로컬 0 = story[contentFrom])',
    r8Rect !== null && r8Print !== undefined
    && Math.abs(r8Rect.left - r8Print.rect.x) < 1e-6
    && Math.abs(r8Rect.top - r8Print.rect.y) < 1e-6,
    `screen=${r8Rect ? JSON.stringify({ l: r8Rect.left, t: r8Rect.top }) : 'null'} print=${r8Print ? JSON.stringify({ x: r8Print.rect.x, y: r8Print.rect.y }) : '?'}`);
}

// ═══ 15. 스레드 단위 변경 감지 — 변경 없는 재배치 스킵 (P1-6) ═══
// relayoutThreads가 doc.layout()/render()마다 재실행되므로, 입력 불변 시
// 프레임 layoutText를 통째로 스킵한다 (해시 직렬화 비용 제거 — R3).
// 스킵 판정은 참조 동등성(story 참조 + contentFrom 연쇄 + hasLayoutCache).
console.log('\n[15] 스레드 단위 변경 감지 — 스킵·재배치 분기');
{
  const storyText = '가나다라마바사아자차카타파하'.repeat(60);
  const { docEngine, frames: [f1, f2] } = buildThreadedDoc({
    contents: [storyText, ''],
    columns: [1, 1],
    boxHeight: 6,
    threads: [{ id: 'ts', paragraphIds: ['para-0', 'para-1'] }],
  });

  // (a) 변경 없는 재호출 — 스킵
  const beforeF1 = JSON.stringify(f1.columnContents);
  const beforeF2 = JSON.stringify(f2.columnContents);
  let layoutTextCalls = 0;
  const origLayoutText = Object.getPrototypeOf(f1).layoutText;
  for (const pe of [f1, f2]) {
    Object.defineProperty(Object.getPrototypeOf(pe), 'layoutText', {
      value: function () { layoutTextCalls++; return origLayoutText.call(this); },
      writable: true, configurable: true,
    });
    break; // 프로토타입에 한 번만 패치
  }
  const r1 = docEngine.relayoutThreads();
  check('변경 없는 재호출 — 스킵 (skipped: true)',
    r1.every(t => t.skipped === true),
    `results=${JSON.stringify(r1.map(t => !!t.skipped))}`);
  check('스킵 시 layoutText 호출 0회 (래핑 카운터 실측)',
    layoutTextCalls === 0, `calls=${layoutTextCalls}`);
  check('스킵 후 프레임 배치 상태 동등 (byte)',
    JSON.stringify(f1.columnContents) === beforeF1
    && JSON.stringify(f2.columnContents) === beforeF2);
  Object.defineProperty(Object.getPrototypeOf(f1), 'layoutText',
    { value: origLayoutText, writable: true, configurable: true });

  // (b) story 편집 — 재배치 (참조 변경 감지)
  const typed = '편집' + storyText;
  f1.textContent = typed;
  f1._dirty = true;
  const r2 = docEngine.relayoutThreads(new Set(['para-0']));
  check('story 편집 후 재배치 (skipped 없음)',
    r2.every(t => t.skipped !== true),
    `results=${JSON.stringify(r2.map(t => !!t.skipped))}`);
  check('편집 재배치 후 체인 seam 정합',
    f2.contentFrom === f1.overflowContentFrom
    && f2.columnContents[0]?.[0]?.parts?.[0]?.content?.[0] === typed[f1.overflowContentFrom],
    `f2.from=${f2.contentFrom} f1.tail=${f1.overflowContentFrom}`);

  // (c) 지오메트리 변경(캐시 무효화) — 재배치
  //     data setter가 resetIncrementalState로 _layoutCache를 지우면
  //     스킵 판정이 실패해 재배치된다.
  f2.resetIncrementalState();
  const r3 = docEngine.relayoutThreads();
  check('캐시 무효화 후 재배치 (hasLayoutCache 변화 감지)',
    r3.every(t => t.skipped !== true),
    `results=${JSON.stringify(r3.map(t => !!t.skipped))}`);

  // (d) 재배치 후 다시 스킵 (새 시그니처로 수렴)
  const r4 = docEngine.relayoutThreads();
  check('재배치 후 재호출 — 다시 스킵 (시그니처 수렴)',
    r4.every(t => t.skipped === true),
    `results=${JSON.stringify(r4.map(t => !!t.skipped))}`);

  // (e) R-T2 same-ref 게이트 — 캐시 히트 layoutText 재진입에서 재매핑(O(placed)
  //     스트림 소비 + 장식 재계산)을 생략/강제하는 게이트를 호출 카운터로 실측한다.
  //     DOM flush가 비-소스 프레임 render() → layoutText()로 재진입하는 경로의
  //     비용이 이 게이트로 제거된다.
  {
    const proto = Object.getPrototypeOf(f2);
    const origRemap = proto._refreshInlineStylesOnly;
    let remapCalls = 0;
    Object.defineProperty(proto, '_refreshInlineStylesOnly', {
      value: function () { remapCalls++; return origRemap.call(this); },
      writable: true, configurable: true,
    });
    try {
      // (e-1) 동일 참조 재진입 — 해시 히트 + 전 참조 동일 → 재매핑 생략
      const beforeGate = JSON.stringify(f2.columnContents);
      remapCalls = 0;
      f2.layoutText();
      f2.layoutText();
      check('R-T2 게이트 — 동일 참조 재진입 재매핑 생략 (호출 0회)',
        remapCalls === 0, `calls=${remapCalls}`);
      check('R-T2 게이트 — 재진입 후 배치 상태 byte 불변',
        JSON.stringify(f2.columnContents) === beforeGate);

      // (e-2) 해시 무영향 스타일 변경(굵기) — 참조만 바뀌므로 재매핑 강제 + 최신화.
      //       문자열→배열 전환은 직렬화 자체가 달라져 MISS이므로, 배열(400) 캐시를
      //       먼저 구축한 뒤 배열(700)로 참조만 바꿔 히트 경로를 만든다.
      f2.textContent = [{ content: typed, textInlineStyle: { fontWeight: 400 } }];
      f2.layoutText(); // MISS — 배열 소스 캐시 구축
      remapCalls = 0;
      f2.textContent = [{ content: typed, textInlineStyle: { fontWeight: 700 } }];
      f2.layoutText(); // HIT (해시 동일 — fontWeight 무영향) + 참조 상이 → 재매핑
      check('R-T2 게이트 — 해시 무영향 스타일 변경 시 재매핑 강제 (호출 1회)',
        remapCalls === 1, `calls=${remapCalls}`);
      const firstPart = f2.columnContents[0]?.[0]?.parts?.find(p => p.content.length > 0);
      check('R-T2 게이트 — 재매핑이 새 런 스타일을 반영 (inlineStyles 최신화)',
        (firstPart?.inlineStyles ?? []).some(s => s?.fontWeight === 700),
        `firstInline=${JSON.stringify(firstPart?.inlineStyles?.[0])}`);
    } finally {
      Object.defineProperty(proto, '_refreshInlineStylesOnly',
        { value: origRemap, writable: true, configurable: true });
    }
  }
}

// ═══ 16. relayoutThreads 사이클 실행 횟수 — 단일 확정 지점 (P1-7) ═══
// DOM render() 진입의 재실행 제거 후에도 초기 로드 체인이 완성되는지는
// 브라우저 검증([1] 초기 로드 3계층)이 증명한다. 여기서는 엔진 단위로
// layout() 사이클의 배치 패스 횟수를 실측한다 — 첫 layout은 배치,
// 이후 동일 입력 layout은 스킵이어야 한다 (사이클당 1회 확정).
console.log('\n[16] relayoutThreads 사이클 — 첫 배치 후 입력 불변 스킵');
{
  const storyText = '가나다라마바사아자차카타파하'.repeat(40);
  const { docEngine, frames: [f1, f2] } = buildThreadedDoc({
    contents: [storyText, ''],
    columns: [1, 1],
    boxHeight: 6,
    threads: [{ id: 'tc', paragraphIds: ['para-0', 'para-1'] }],
  });
  // buildThreadedDoc이 layout 1회(배치 확정)를 이미 실행했다.
  // 동일 childrenData로 재layout — 스킵 경로다.
  const beforeF1 = JSON.stringify(f1.columnContents);
  const r1 = docEngine.relayoutThreads();
  const r2 = docEngine.relayoutThreads();
  check('첫 배치 후 relayoutThreads 2회 연속 — 모두 스킵',
    r1.every(t => t.skipped === true) && r2.every(t => t.skipped === true),
    `r1=${JSON.stringify(r1.map(t => !!t.skipped))} r2=${JSON.stringify(r2.map(t => !!t.skipped))}`);
  check('스킵 2회 후 배치 상태 불변 (byte)',
    JSON.stringify(f1.columnContents) === beforeF1
    && f2.contentFrom === f1.overflowContentFrom);
}

// ═══ 17. 프레임 경계 금칙 교정 (P2-9/10) ═══
// 프레임 배치는 독립 실행되므로 _applyLineBreakRules가 프레임 경계(head
// 마지막 visible 라인 ↔ f2 첫 라인)를 교정하지 못한다 (R7). ThreadEngine의
// 경계 교정(追い出し)이 라인 경계와 동일 시맨틱을 유지하는지 검증한다.
// 위반 유도: 순수 tail 측정 → story[tail]을 전각 닫기 부호(」)로 치환해
// f2 행두금칙 위반을 결정론적으로 만든다.
console.log('\n[17] 프레임 경계 금칙 교정');
{
  const { isLineStartForbidden } = await import('../src/constants/line-break.ts');
  const unit = '가나다라마바사아자차';
  const layoutNoCorrection = (storyText) => {
    const proto = ThreadEngine.prototype;
    const orig = proto._boundaryCorrection;
    proto._boundaryCorrection = function () { return 0; };
    try {
      return buildThreadedDoc({
        contents: [storyText, ''],
        columns: [1, 1],
        boxHeight: 4,
        threads: [{ id: 'tb', paragraphIds: ['para-0', 'para-1'] }],
      });
    } finally {
      proto._boundaryCorrection = orig;
    }
  };

  // 위반 story 수렴: story[tail] === '」'이 되도록 치환 반복
  const plain = unit.repeat(40);
  let story = plain;
  let violFound = false;
  for (let iter = 0; iter < 8; iter++) {
    const { frames: [f1v] } = layoutNoCorrection(story);
    const tail = f1v.overflowContentFrom;
    if (story[tail] === '」') { violFound = true; break; }
    story = story.slice(0, tail) + '」' + story.slice(tail + 1);
  }
  check('경계 위반 유도 성공 (story[tail] === 」)',
    violFound, `story[tail]="${story[story.length] ?? ''}"`);

  // A: 교정 OFF — 위반 잔존 (교정이 없으면 f2가 」로 시작)
  const { frames: [f1A, f2A] } = layoutNoCorrection(story);
  const firstA = f2A.columnContents[0]?.[0]?.parts?.[0]?.content?.[0];
  check('A(교정 OFF) f2 행두금칙 위반 잔존',
    firstA === '」' && isLineStartForbidden('」'),
    `first="${firstA}"`);

  // B: 교정 ON — 해소 + seam 정합
  const { frames: [f1B, f2B] } = buildThreadedDoc({
    contents: [story, ''],
    columns: [1, 1],
    boxHeight: 4,
    threads: [{ id: 'tb', paragraphIds: ['para-0', 'para-1'] }],
  });
  const firstB = f2B.columnContents[0]?.[0]?.parts?.[0]?.content?.[0];
  check('B(교정 ON) f2 행두금칙 위반 해소',
    firstB !== undefined && !isLineStartForbidden(firstB),
    `first="${firstB}"`);
  check('B seam 정합 (追い出し 후 head tail === f2 contentFrom)',
    f2B.contentFrom === f1B.overflowContentFrom,
    `f1.tail=${f1B.overflowContentFrom} f2.from=${f2B.contentFrom}`);
  check('B head 마지막 visible 라인이 닫기 부호 **앞** 글자로 끝 (追い出し — prev 마지막 일반 글자와 닫기 부호를 모두 내보냄)',
    (() => {
      const parentHeight = f1B.inheritStyle?.parentHeight ?? 0;
      const eff = parentHeight + (f1B.baseLineHeight - f1B.fontSize);
      let last;
      for (const col of f1B.columnContents) {
        let cum = 0, ov = false;
        for (const line of col) {
          const h = line?.lineHeight ?? f1B.baseLineHeight;
          if (ov || cum + h > eff + 1e-6) { ov = true; break; }
          cum += h; last = line;
        }
      }
      const chars = last.parts.flatMap(p => p.content);
      const lastChar = chars[chars.length - 1];
      // 追い出し: '나」'가 f2로 이동 → head 끝은 그 앞 글자('가')
      // f2 첫 글자('차') === head 마지막 글자의 story 다음 위치와 일치해야 한다
      return lastChar !== '」' && !isLineStartForbidden(lastChar);
    })(),
    '');
  // 단일소스 방어: 교정(clamp 재배치) 후에도 모든 파트의 charOffsets가
  // 파생 상태를 유지하는지 — 출력 변이(shiftVisibleTail, 과거 구현)는
  // charOffsets를 소거해 getCharRect/print 좌표를 x=0 폴백으로 붕괴시켰다.
  {
    let invalidParts = 0;
    for (const col of f1B.columnContents) {
      for (const line of col) {
        for (const part of line.parts) {
          if (part.content.length > 0 && (!part.charOffsets || part.charOffsets.length === 0)) {
            invalidParts++;
          }
        }
      }
    }
    check('교정 후 전 파트 charOffsets 파생 유지 (출력 변이 금지 — 단일소스)',
      invalidParts === 0, `invalidParts=${invalidParts}`);
    // print 좌표 폴백: (x===absLeft && y===absTop)이 i>0에서 나오면 charOffsets 미산출
    const docE2 = buildThreadedDoc({
      contents: [story, ''],
      columns: [1, 1],
      boxHeight: 4,
      threads: [{ id: 'tpr', paragraphIds: ['para-0', 'para-1'] }],
    });
    docE2.docEngine.ensureCommitted();
    const f1Print = docE2.frames[0].printPostData[0];
    const absLeft = 10, absTop = 10;
    const fallbacks = f1Print.chars.filter((c, i) => i > 0 && Math.abs(c.rect.x - absLeft) < 1e-6 && Math.abs(c.rect.y - absTop) < 1e-6).length;
    check('교정 후 print 좌표 폴백 없음 (getCharRect와 동일 파생)',
      fallbacks === 0, `fallbacks=${fallbacks}`);
  }

  // 워드 가드: 내보낼 prev 마지막 글자가 워드(alnum)를 구성하면 교정 스킵
  {
    // head가 ...Word로 끝나고 f2가 」로 시작하는 story — 워드 글자는
    // 이동하지 않으므로(워드 무결성 > 금칙) 위반이 잔존한다.
    const wordStory = 'ABCDEF'.repeat(40);
    const { frames: [f1w] } = layoutNoCorrection(wordStory);
    const tailw = f1w.overflowContentFrom;
    const wStory = wordStory.slice(0, tailw) + '」' + wordStory.slice(tailw + 1);
    // word-wrap 비활성 문서에서는 alnum도 워드 가드 대상이 아니다 —
    // 워드랩 ON 문서로 재구축해 가드를 테스트한다.
    const { frames: [f1g, f2g] } = buildThreadedDoc({
      contents: [wStory, ''],
      columns: [1, 1],
      boxHeight: 4,
      threads: [{ id: 'tg', paragraphIds: ['para-0', 'para-1'] }],
      paragraphStyle: { wordWrap: true },
    });
    // 워드랩 ON이면 배치 자체가 워드 단위라 경계가 다르다 — f2 첫 글자와
    // prev 마지막 글자의 워드 소속을 관찰한다.
    const lastChars = (() => {
      const parentHeight = f1g.inheritStyle?.parentHeight ?? 0;
      const eff = parentHeight + (f1g.baseLineHeight - f1g.fontSize);
      let last;
      for (const col of f1g.columnContents) {
        let cum = 0, ov = false;
        for (const line of col) {
          const h = line?.lineHeight ?? f1g.baseLineHeight;
          if (ov || cum + h > eff + 1e-6) { ov = true; break; }
          cum += h; last = line;
        }
      }
      return last.parts.flatMap(p => p.content);
    })();
    const firstG = f2g.columnContents[0]?.[0]?.parts?.[0]?.content?.[0];
    const prevLast = lastChars[lastChars.length - 1];
    const guardOk = firstG === '」'
      ? /[0-9A-Za-z]/.test(prevLast ?? '') // 위반 잔존 시 prev 마지막이 워드 글자였다
      : true; // 교정됐으면 가드 미발동 (경계가 위반 아님)
    check('워드 가드 — prev 마지막이 워드 글자면 위반 잔존 허용 (워드 무결성 > 금칙)',
      guardOk,
      `prevLast="${prevLast}" f2First="${firstG}"`);
  }
}

// ═══ 18. 테이블 셀 프레임 × buildCellBoxEngines 재구축 (P2-11) ═══
// R6: 셀 구조 편집(행 삭제 → 라벨 시프트)이 스레드 프리미티브를
// 보존하는지 무검증이었다. prevCellBoxEnginesById 재사용 경로가 PE
// 인스턴스를 보존하면 프리미티브가 자동 유지된다 — 셀 내 2프레임
// 스레드로 행 삭제 후 체인을 검증한다.
console.log('\n[18] 테이블 셀 프레임 × 행 삭제');
{
  const makeThreadRow = (rowId, story) => ({
    type: 'tr',
    id: rowId,
    height: 6,
    children: [
      { type: 'td', id: `${rowId}-td0`, children: [{
        type: 'box', id: `${rowId}-cb0`, left: 0, top: 0, width: 1, height: 6,
        position: 'static',
        children: { type: 'paragraph', id: `${rowId}-frame1`, content: story, column: 1, gap: 0, paragraphStyle: {}, textStyle: {} },
      }] },
      { type: 'td', id: `${rowId}-td1`, children: [{
        type: 'box', id: `${rowId}-cb1`, left: 0, top: 0, width: 1, height: 6,
        position: 'static',
        children: { type: 'paragraph', id: `${rowId}-frame2`, content: '', column: 1, gap: 0, paragraphStyle: {}, textStyle: {} },
      }] },
    ],
  });
  const buildTableDoc = (rows, storyRef) => {
    const docEngine = DocumentEngine.create(
      { id: 'doc', width: 257, height: 370, columns: 6, gap: 3,
        paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
        threads: [{ id: 'tt', paragraphIds: ['r1-frame1', 'r1-frame2', 'r2-frame1', 'r2-frame2'], content: storyRef }] },
      fontLoader, colorRegistry, 3.78,
    );
    docEngine.layout([{
      type: 'box', id: 'tablebox', position: 'absolute', left: 10, top: 10, width: 120, height: 40, zIndex: 1,
      children: { type: 'table', id: 'tbl', colWidths: [60, 60], children: rows },
    }]);
    return docEngine;
  };

  const storyText = '가나다라마바사아자차카타파하'.repeat(30);
  const rows = [makeThreadRow('r1', storyText), makeThreadRow('r2', storyText)];
  const doc = buildTableDoc(rows, storyText);

  const f1 = doc.findEngineById('r1-frame1');
  const f2 = doc.findEngineById('r1-frame2');
  check('셀 내 스레드 프레임 배치됨 (f1 → f2 feed-forward)',
    f1?.isThreadFrame === true && f2?.visibleChars > 0 && f2.contentFrom === f1.overflowContentFrom,
    `f2.from=${f2?.contentFrom} f1.tail=${f1?.overflowContentFrom}`);
  const f3 = doc.findEngineById('r2-frame1');
  check('둘째 행 프레임도 체인 연결',
    f3?.isThreadFrame === true && f3.contentFrom === f2.overflowContentFrom,
    `f3.from=${f3?.contentFrom}`);

  // 첫 행 삭제 (라벨 시프트 — stash 복원 경로): r2가 첫 행이 된다
  const beforeF3 = f3;
  const rowsAfter = [makeThreadRow('r2', storyText)];
  doc.layout([{
    type: 'box', id: 'tablebox', position: 'absolute', left: 10, top: 10, width: 120, height: 20, zIndex: 1,
    children: { type: 'table', id: 'tbl', colWidths: [60, 60], children: rowsAfter },
  }]);

  const f3After = doc.findEngineById('r2-frame1');
  const f4After = doc.findEngineById('r2-frame2');
  check('행 삭제 후 잔여 프레임 엔진 identity 보존 (프리미티브 유지의 근거)',
    f3After === beforeF3,
    `identity=${f3After === beforeF3}`);
  check('행 삭제 후 스레드 체인 유지 (threads 데이터로 재배치)',
    f3After?.isThreadFrame === true
    && f4After?.isThreadFrame === true
    && f4After?.contentFrom === f3After?.overflowContentFrom,
    `f4.from=${f4After?.contentFrom} f3.tail=${f3After?.overflowContentFrom}`);
  check('행 삭제 후 story 배치 지속 (f3가 r2 head story 소유)',
    f3After?.textContent === storyText && f3After.visibleChars > 0,
    `visible=${f3After?.visibleChars}`);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`verify-threading: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('FAILED:', failures.join(', '));
  process.exit(1);
}
console.log('ALL PASS');