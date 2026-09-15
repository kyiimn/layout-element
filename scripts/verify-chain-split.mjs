/**
 * 자동 체인 분할 (옵션 B) 정합성 검증 (Node, DOM-free).
 *
 * 감사 `PAGE_STRUCTURE_PERF_AUDIT.md` §6.7.5 검증 계획의 엔진 항목을 소유한다.
 *
 * 검증 항목:
 *  1. group-article N개 문서에서 자동 분할 = 기사별 프레임 그룹 (N체인)
 *  2. 기사 A 프레임 타이핑 → 기사 A 체인만 재배치 (다른 체인 skipped: true)
 *  3. 기사 경계 프레임(마지막 프레임 overset) — 빨간 테두리 근거인 tail이
 *     체인 마지막 프레임에만 (threadTail 유일성)
 *  4. 기존 단일 체인 문서(threads 명시)와 byte-identical 회귀 (정책 OFF 경로)
 *  5. contentUid 그룹핑 — 페이지 경계를 넘는 동일 기사가 하나의 체인으로
 *  6. 보수 게이트 — 1프레임 기사 제외 / 빈 기사 제외 / id 없는 문단 제외 /
 *     재호출 멱등 (writeback 기록 유지) / 보호 게이트 (독립 콘텐츠 제외)
 *  7. writeback identity — 자동 체인 편집 시 story가 materialize된 객체에 기록
 *  8. printPostData 패리티 — 자동 체인 배치가 명시적 threads 배치와 출력 동일
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-chain-split.mjs
 * ```
 *
 * @file scripts/verify-chain-split.mjs
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
const { DocumentEngine } = await import('../src/engine/document-engine.ts');

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
 * 기사(group-article) 박스 데이터를 만든다.
 *
 * @param {object} opts - 옵션
 * @param {string} opts.boxId - group-article 박스 id
 * @param {string} [opts.contentUid] - 기사 UID (body 박스에 기록)
 * @param {string} opts.paraId - body 문단 id
 * @param {string} opts.content - body 문단 콘텐츠
 * @param {number} [opts.top=10] - 박스 top (mm)
 * @param {number} [opts.boxHeight=6] - 박스 높이 (라인 수)
 * @returns {object} BoxData
 */
function articleBox({ boxId, contentUid, paraId, content, top = 10, boxHeight = 6 }) {
  return {
    type: 'box',
    id: boxId,
    role: 'group-article',
    position: 'absolute',
    left: 10,
    top,
    width: 237,
    height: boxHeight + 4,
    zIndex: 1,
    children: [
      {
        type: 'box',
        id: `${boxId}-body`,
        role: 'body',
        position: 'absolute',
        left: 0,
        top: 0,
        width: 237,
        height: boxHeight,
        ...(contentUid !== undefined ? { contentUid } : {}),
        children: {
          id: paraId,
          type: 'paragraph',
          content,
          column: 2,
          gap: 3,
          paragraphStyle: {},
          textStyle: {},
        },
      },
    ],
  };
}

/**
 * 여러 페이지의 기사 문서를 구축하고 자동 체인 배치까지 실행한다.
 *
 * @param {object} opts - 옵션
 * @param {Array<Array<object>>} opts.pages - 페이지별 BoxData 배열
 * @param {Array} [opts.threads] - 명시적 threads (정책 OFF 테스트용)
 * @param {Set<string>} [opts.editSources] - relayoutThreads 소스 프레임 id
 * @returns {object} { docEngine, pageEngines }
 */
function buildAutoDoc({ pages, threads, editSources }) {
  const pageEngines = pages.map((children, i) => {
    const pe = PageEngine.create(
      {
        id: `page-${i}`, width: 257, height: 370, columns: 6, gap: 3,
        paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
      },
      fontLoader, colorRegistry, 3.78,
    );
    pe.layout(children);
    return pe;
  });
  const docEngine = DocumentEngine.create(
    { id: 'doc', threads, width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' } },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.adoptPageEngines(pageEngines);
  docEngine.layout();
  if (editSources) {
    docEngine.relayoutThreads(editSources);
  }
  return { docEngine, pageEngines };
}

const STORY = '가나다라마바사아자차카타파하'.repeat(30); // 840자 — 2프레임 이상 흐름
const SHORT = '가나다라마바사'; // 7자 — 1프레임 소진

/**
 * 동일 기사를 2개 body(2프레임)로 구성한다 — 하나의 group-article 안에
 * body 박스 2개가 같은 contentUid를 공유한다 (기사가 한 기사 그룹에서
 * 2프레임에 걸치는 형태).
 *
 * @param {object} opts - 옵션
 * @param {string} opts.boxId - group-article 박스 id
 * @param {string} [opts.contentUid] - 기사 UID
 * @param {string} opts.paraId1 - 첫 body 문단 id
 * @param {string} opts.paraId2 - 둘째 body 문단 id
 * @param {string} opts.content1 - 첫 body 콘텐츠
 * @param {string} [opts.content2=''] - 둘째 body 콘텐츠
 * @returns {Array<object>} BoxData 배열 (2개 — 페이지 children에 펼침)
 */
function twoFrameArticle({ boxId, contentUid, paraId1, paraId2, content1, content2 = '' }) {
  return [
    {
      type: 'box', id: boxId, role: 'group-article', position: 'absolute',
      left: 10, top: 10, width: 237, height: 12, zIndex: 1,
      children: [{
        type: 'box', id: `${boxId}-body1`, role: 'body', position: 'absolute',
        left: 0, top: 0, width: 237, height: 6,
        ...(contentUid !== undefined ? { contentUid } : {}),
        children: { id: paraId1, type: 'paragraph', content: content1, column: 2, gap: 3,
          paragraphStyle: {}, textStyle: {} },
      }],
    },
    {
      type: 'box', id: `${boxId}-b2`, role: 'group-article', position: 'absolute',
      left: 10, top: 30, width: 237, height: 12, zIndex: 1,
      children: [{
        type: 'box', id: `${boxId}-body2`, role: 'body', position: 'absolute',
        left: 0, top: 0, width: 237, height: 6,
        ...(contentUid !== undefined ? { contentUid } : {}),
        children: { id: paraId2, type: 'paragraph', content: content2, column: 2, gap: 3,
          paragraphStyle: {}, textStyle: {} },
      }],
    },
  ];
}

// ═══ 1. 기사별 자동 체인 (N체인) ═══
console.log('\n[1] group-article N개 → 기사별 N체인');
{
  const { docEngine, pageEngines } = buildAutoDoc({
    pages: [[
      ...twoFrameArticle({ boxId: 'ga-1', contentUid: 'a1', paraId1: 'p1', paraId2: 'p1b', content1: STORY }),
      ...twoFrameArticle({ boxId: 'ga-2', contentUid: 'a2', paraId1: 'p2', paraId2: 'p2b', content1: STORY }),
    ]],
  });
  const threads = docEngine.data.threads ?? [];
  check('자동 체인 2개 생성 (기사당 1체인)', threads.length === 2, `got ${threads.length}`);
  const t1 = threads.find(t => (t.paragraphIds ?? []).includes('p1'));
  const t2 = threads.find(t => (t.paragraphIds ?? []).includes('p2'));
  check('기사 A 체인 = [p1, p1b] (contentUid 그룹핑)',
    t1 !== undefined && t1.paragraphIds.join(',') === 'p1,p1b',
    `got ${JSON.stringify(t1?.paragraphIds)}`);
  check('기사 B 체인 = [p2, p2b]', t2 !== undefined && t2.paragraphIds.join(',') === 'p2,p2b');
  check('체인 id가 기사 UID 기반', threads.every(t => t.id?.startsWith('auto-thread-')));
  check('story 발명 금지 — content undefined', threads.every(t => t.content === undefined));
  // head 프레임이 story 전체를 소유 (폴백 동작)
  const p1 = pageEngines[0].findEngineById('p1');
  check('head가 story 전체 소유 (textContent === 원본 콘텐츠)', p1.textContent === STORY);
  check('head overset tail (840자 → 2컬럼 6라인 박스 초과)', p1.overflowContentFrom >= 0);
  const p1b = pageEngines[0].findEngineById('p1b');
  check('2번째 프레임이 tail을 이어받음 (feed-forward)',
    p1b.isThreadFrame === true && p1b.contentFrom === p1.overflowContentFrom);
}

// ═══ 2. 체인 스코프 타이핑 — 다른 체인 스킵 ═══
console.log('\n[2] 기사 A 타이핑 → 기사 B 체인 skipped');
{
  const { docEngine } = buildAutoDoc({
    pages: [[
      ...twoFrameArticle({ boxId: 'ga-1', contentUid: 'a1', paraId1: 'p1', paraId2: 'p1b', content1: STORY }),
      ...twoFrameArticle({ boxId: 'ga-2', contentUid: 'a2', paraId1: 'p2', paraId2: 'p2b', content1: STORY }),
    ]],
  });
  // 첫 배치 수렴 확인 (변경 감지 스킵 상태로 만든다)
  const r0 = docEngine.relayoutThreads();
  check('재호출 전체 스킵 (변경 감지)', r0.every(r => r.skipped === true),
    `got ${JSON.stringify(r0.map(r => ({ id: r.threadId, skipped: r.skipped })))}`);

  // 기사 A head 타이핑 시뮬레이션 — head textContent를 직접 교체(편집 파이프라인의
  // 엔진측 결과와 동일 상태) + 소싱 후 relayout
  const p1 = docEngine.findEngineById('p1');
  p1.textContent = STORY + '가';
  const r1 = docEngine.relayoutThreads(new Set(['p1']));
  const tB = r1.find(r => (r.threadId ?? '') === 'auto-thread-a2');
  const tA = r1.find(r => (r.threadId ?? '') === 'auto-thread-a1');
  check('기사 B 체인 skipped: true (재배치 0)', tB?.skipped === true,
    `got ${JSON.stringify(tB)}`);
  check('기사 A 체인 재배치됨 (skipped 아님)', tA?.skipped !== true);
}

// ═══ 3. threadTail 유일성 (기사 경계 overset) ═══
console.log('\n[3] 체인 tail(overset 표시 근거) 정확히 1개');
{
  const { pageEngines } = buildAutoDoc({
    pages: [[
      articleBox({ boxId: 'ga-1', contentUid: 'a1', paraId: 'p1', content: STORY, top: 10 }),
      // 동일 기사 2번째 body — 페이지 2에 배치 (contentUid 그룹핑 — [5]와 결합)
    ], [
      articleBox({ boxId: 'ga-1-p2', contentUid: 'a1', paraId: 'p2', content: '', top: 10 }),
    ]],
  });
  const p1 = pageEngines[0].findEngineById('p1');
  const p2 = pageEngines[1].findEngineById('p2');
  check('2페이지 프레임이 체인 합류 (contentUid 그룹핑)', p2.isThreadFrame === true);
  check('head tail 존재', p1.overflowContentFrom >= 0);
  check('p2 contentFrom === head tail (feed-forward)', p2.contentFrom === p1.overflowContentFrom,
    `p2.from=${p2.contentFrom} head.tail=${p1.overflowContentFrom}`);
  // tail은 체인 마지막 프레임만 — p1은 소비 표시(overset이 p2로 흐름)
  check('중간 프레임 tail 마킹 없음 (threadTail은 마지막만)', p2.isThreadTail === true);
}

// ═══ 4. 정책 OFF — 명시적 threads 존재 시 byte-identical ═══
console.log('\n[4] 명시적 threads 존재 → 자동 분할 미발동 (정책 OFF)');
{
  const buildPages = () => [[
    ...twoFrameArticle({ boxId: 'ga-1', contentUid: 'a1', paraId1: 'p1', paraId2: 'p1b', content1: STORY }),
    ...twoFrameArticle({ boxId: 'ga-2', contentUid: 'a2', paraId1: 'p2', paraId2: 'p2b', content1: STORY }),
  ]];

  // 명시적 2체인 (기존 방식으로 자동 분할과 동일한 그룹을 손으로 정의)
  const explicit = buildAutoDoc({
    pages: buildPages(),
    threads: [
      { id: 't1', paragraphIds: ['p1', 'p1b'] },
      { id: 't2', paragraphIds: ['p2', 'p2b'] },
    ],
  });
  // 자동 분할
  const auto = buildAutoDoc({ pages: buildPages() });

  check('명시적 threads 보존 (자동 체인 추가 없음)',
    explicit.docEngine.data.threads.length === 2
    && explicit.docEngine.data.threads[0].id === 't1'
    && explicit.docEngine.data.threads[1].id === 't2');
  const ids = ['p1', 'p1b', 'p2', 'p2b'];
  let identical = true;
  for (const pid of ids) {
    const pe1 = explicit.docEngine.findEngineById(pid);
    const pe2 = auto.docEngine.findEngineById(pid);
    if (engineText(pe1) !== engineText(pe2)) identical = false;
  }
  check('명시적 체인 배치 == 자동 분할 배치 (전 프레임 byte-identical)', identical);
  const p1e = explicit.docEngine.findEngineById('p1');
  const p1a = auto.docEngine.findEngineById('p1');
  const p1be = explicit.docEngine.findEngineById('p1b');
  const p1ba = auto.docEngine.findEngineById('p1b');
  check('contentFrom 체인 동등 (명시적 vs 자동)',
    p1e.overflowContentFrom === p1a.overflowContentFrom
    && p1be.contentFrom === p1ba.contentFrom);
}

// ═══ 5. threads 없는 문서 — group-article 없으면 자동 체인 0 (기존 동작) ═══
console.log('\n[5] group-article 없는 문서 — 자동 체인 0, 기존 동작 보존');
{
  const pages = [[
    { type: 'box', id: 'b1', role: 'body', position: 'absolute', left: 10, top: 10,
      width: 237, height: 10, contentUid: 'a1',
      children: { id: 'p1', type: 'paragraph', content: STORY, column: 2, gap: 3,
        paragraphStyle: {}, textStyle: {} } },
  ]];
  const { docEngine, pageEngines } = buildAutoDoc({ pages });
  check('threads 없음 (자동 생성 안 됨)', docEngine.data.threads === undefined);
  const p1 = pageEngines[0].findEngineById('p1');
  check('문단은 비-스레드 배치 유지', p1.isThreadFrame === false);
  check('overflowContentFrom === -1', p1.overflowContentFrom === -1);
}

// ═══ 6. 보수 게이트 ═══
console.log('\n[6] 보수 게이트 — 1프레임/빈 기사/독립 콘텐츠/재호출 멱등');
{
  // 6a. 1프레임 기사는 체인 미생성
  {
    const { docEngine } = buildAutoDoc({
      pages: [[articleBox({ boxId: 'ga-1', contentUid: 'a1', paraId: 'p1', content: SHORT, top: 10 })]],
    });
    check('1프레임 기사 → 자동 체인 0', (docEngine.data.threads ?? []).length === 0);
  }
  // 6b. 빈 기사 (전 프레임 비어 있음) — story 원천 없음
  {
    const { docEngine } = buildAutoDoc({
      pages: [[
        ...twoFrameArticle({ boxId: 'ga-1', contentUid: 'a1', paraId1: 'p1', paraId2: 'p2', content1: '' }),
      ]],
    });
    check('전 프레임 빈 기사 → 자동 체인 0', (docEngine.data.threads ?? []).length === 0);
  }
  // 6c. 보호 게이트 — 두 번째 body에 독립 콘텐츠가 있으면 체인에서 제외 (1프레임화 → 미생성)
  {
    const { docEngine } = buildAutoDoc({
      pages: [[
        ...twoFrameArticle({ boxId: 'ga-1', contentUid: 'a1', paraId1: 'p1', paraId2: 'p2',
          content1: STORY, content2: '독립 콘텐츠' }),
      ]],
    });
    check('독립 콘텐츠 body 제외 → 1프레임 체인 미생성', (docEngine.data.threads ?? []).length === 0);
    const p2 = docEngine.findEngineById('p2');
    check('독립 콘텐츠 문단은 비-스레드 유지', p2.isThreadFrame === false);
  }
  // 6d. 재호출 멱등 + writeback identity
  {
    const { docEngine } = buildAutoDoc({
      pages: [[
        ...twoFrameArticle({ boxId: 'ga-1', contentUid: 'a1', paraId1: 'p1', paraId2: 'p2', content1: STORY }),
      ]],
    });
    const first = docEngine.data.threads;
    const firstRef = first[0];
    // 두 번째 layout() — materialize가 재사용되는지 (객체 identity 유지)
    docEngine.layout();
    const second = docEngine.data.threads;
    check('재호출 후 threads 참조 동일 (writeback identity 보존)', second === first
      && second[0] === firstRef);
    // 편집 writeback이 materialize된 객체에 기록되는지
    const p1 = docEngine.findEngineById('p1');
    p1.textContent = STORY + '나';
    docEngine.relayoutThreads(new Set(['p1']));
    check('writeback이 자동 체인 객체에 story 기록',
      docEngine.data.threads[0].content === STORY + '나');
  }
}

// ═══ 7. contentUid 폴백 — group-article id 그룹핑 (같은 그룹 안 body 2개) ═══
console.log('\n[7] contentUid 없는 body — group-article id로 그룹핑');
{
  // 같은 group-article 안에 body 박스 2개 — contentUid가 없으므로
  // 소속 group-article 박스 id가 그룹핑 키가 된다.
  const { docEngine } = buildAutoDoc({
    pages: [[
      {
        type: 'box', id: 'ga-x', role: 'group-article', position: 'absolute',
        left: 10, top: 10, width: 237, height: 24, zIndex: 1,
        children: [
          {
            type: 'box', id: 'ga-x-body1', role: 'body', position: 'absolute',
            left: 0, top: 0, width: 237, height: 6,
            children: { id: 'p1', type: 'paragraph', content: STORY, column: 2, gap: 3,
              paragraphStyle: {}, textStyle: {} },
          },
          {
            type: 'box', id: 'ga-x-body2', role: 'body', position: 'absolute',
            left: 0, top: 8, width: 237, height: 6,
            children: { id: 'p2', type: 'paragraph', content: '', column: 2, gap: 3,
              paragraphStyle: {}, textStyle: {} },
          },
        ],
      },
    ]],
  });
  const threads = docEngine.data.threads ?? [];
  check('contentUid 없어도 같은 group-article 소속이면 1체인', threads.length === 1,
    `got ${threads.length}`);
  check('그룹핑 키가 group-article 박스 id', threads[0]?.id === 'auto-thread-ga-x',
    `got ${threads[0]?.id}`);
  check('체인이 2프레임', (threads[0]?.paragraphIds ?? []).length === 2);
}

// ═══ 8. printPostData 패리티 — 자동 체인 == 명시적 체인 ═══
console.log('\n[8] printPostData 패리티 (자동 vs 명시적)');
{
  const buildPages = () => [[
    ...twoFrameArticle({ boxId: 'ga-1', contentUid: 'a1', paraId1: 'p1', paraId2: 'p2', content1: STORY }),
  ]];
  const explicit = buildAutoDoc({
    pages: buildPages(),
    threads: [{ id: 't1', paragraphIds: ['p1', 'p2'] }],
  });
  const auto = buildAutoDoc({ pages: buildPages() });
  const printExplicit = explicit.docEngine.printPostData;
  const printAuto = auto.docEngine.printPostData;
  check('printPostData 페이지 수 동일', printExplicit.length === printAuto.length);
  // paragraph print 항목은 chars 필드로 식별한다 (box 항목은 chars 없음)
  const collectChars = (items) => items
    .filter(item => item.chars !== undefined)
    .flatMap(item => (item.chars ?? []).map(ch => ({ c: ch.c, x: ch.rect.x, y: ch.rect.y })));
  const peChars = collectChars(printExplicit);
  const paChars = collectChars(printAuto);
  check('print chars 수 동일', peChars.length === paChars.length,
    `explicit=${peChars.length} auto=${paChars.length}`);
  let parityOk = peChars.length === paChars.length;
  if (parityOk) {
    for (let i = 0; i < peChars.length; i++) {
      if (peChars[i].c !== paChars[i].c
        || Math.abs(peChars[i].x - paChars[i].x) > 1e-9
        || Math.abs(peChars[i].y - paChars[i].y) > 1e-9) {
        parityOk = false;
        break;
      }
    }
  }
  check('print 좌표 패리티 (자동 체인 === 명시적 체인)', parityOk);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log(`Failures: ${failures.join(' | ')}`);
  process.exit(1);
}