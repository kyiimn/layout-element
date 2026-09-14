/**
 * 스킵 프레임 참조 신선화(refreshStoryReference) 전제 실증 (Node, DOM-free).
 *
 * 감사 A-6 (5단계 계획 W1): ThreadEngine 범위-증명 스킵이 프레임에 남기는
 * 구 story 참조를 상태 자체에서 제거하는 `ParagraphEngine.refreshStoryReference`
 * 의 전제 4종을 실증한다. 전제가 깨지면(폴백 조건) 즉시 W1 진행을 중단한다.
 *
 * 검증 항목:
 * 1. 폴백 판정 지점 (§1-b) — 참조 신선화 후 `_threadInputUnchanged`가 소비하는
 *    참조 비교(`engine.textContent === storyRef`)가 통과하는가. 관측 프록시:
 *    신선화된 체인에서 변경 없는 `relayoutThreads()` 재호출이 `skipped: true`.
 * 2. (a) 참조 교체 후 `hasLayoutCache` 유지 — 캐시 존재가 스킵 판정
 *    (`_isFrameClean`)의 3조건(지오메트리·스타일·오버랩·story 불변 증명)에
 *    그대로 쓰인다.
 * 3. (b) `_layoutCache` 히트 유지 — 해시 무영향 참조 교체(동일 직렬화)에서
 *    layoutText 재진입이 캐시 히트로 재래핑을 생략한다. digest는 새 참조로
 *    1회 재계산 후 정적 WeakMap(`_TEXT_DIGEST_BY_REF`)에 수렴한다.
 * 4. (c) `hasPendingChanges` 불변 (`_dirty` 미설정) — 신선화가 dirty·파생
 *    배치 무효화를 일으키지 않는다.
 * 5. 직접 유도 메모 무효화 — `_plainTextCache`/`_styleRuns`는 참조 키가 없는
 *    직접 유도물이다. 참조만 교체하면 (i) `_boundaryCorrection`의
 *    `nextEngine.plainText[contentFrom]` 금칙 판정이 구 story 글자를 읽고
 *    (ii) 편집 진입 시 `model.plainText`가 구 plain을 textarea/runMap에
 *    공급한다 (f2bbe8b 롤백 버그의 메모 경로 부활). 신선화는 이 2종을
 *    반드시 무효화해야 한다 — 정적 참조 캐시(`_PLAIN_TEXT_BY_REF`)로
 *    재계산은 체인당 O(N) 1회 후 O(1) 수렴한다.
 * 6. 엔진 소멸 증명 — 스킵 프레임의 "구 story 참조" 상태가 시스템에서
 *    소멸함: 범위-증명 스킵 패스 후 (i) 전 프레임 textContent === 현재 story
 *    참조 (ii) `hasStaleSkippedFrames` 소멸(다음 스킵 판정 통과 세척)
 *    (iii) 스킵 프레임을 편집 소스로 writeback 시 신 story가 기록된다.
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-story-reference-refresh.mjs
 * ```
 *
 * @file scripts/verify-story-reference-refresh.mjs
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
const { ThreadEngine } = await import('../src/engine/thread-engine.ts');

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
 * 콘텐츠를 plain 문자열로 변환한다 (런 배열 → join).
 *
 * @param {string|Array} content - 콘텐츠 (string 또는 인라인 런 배열)
 * @returns {string} plain 문자열
 */
function storyOf(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map(r => (typeof r === 'string' ? r : r.content)).join('');
}

/**
 * 3프레임 스레드 체인 문서를 구축한다 (head/f2/f3 — 범위-증명 스킵은 중간
 * 프레임에서만 발생하므로 최소 3프레임이 필요하다).
 *
 * @param {object} [options] - 구축 옵션
 * @param {string} [options.story] - head story (기본: 한글 반복 240자)
 * @returns {{ docEngine: object, pageEngine: object, frames: object[],
 *             threadKey: string }} 엔진과 프레임 배열
 */
function buildChain({ story = '가나다라마바사아자차카타파하'.repeat(20) } = {}) {
  const pageEngine = PageEngine.create(
    {
      id: 'page', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  const boxHeight = 6;
  const children = [0, 1, 2].map(i => ({
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
      content: i === 0 ? story : '',
      column: 1,
      gap: 3,
      paragraphStyle: {},
      textStyle: {},
    },
  }));
  pageEngine.layout(children);
  const docEngine = DocumentEngine.create(
    {
      id: 'doc',
      threads: [{ id: 't1', paragraphIds: ['para-0', 'para-1', 'para-2'] }],
      width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.adoptPageEngines([pageEngine]);
  docEngine.layout();
  const frames = [0, 1, 2].map(i => pageEngine.findEngineById(`para-${i}`));
  return { docEngine, pageEngine, frames, threadKey: 't1' };
}

// ═══ 1. 폴백 판정 지점 — 참조 신선화가 스킵 판정을 통과시키는가 ═══
console.log('\n[1] 폴백 판정 — refreshStoryReference 후 참조 비교 통과 (A-6 전제)');
{
  const { docEngine, frames: [head, f2, f3] } = buildChain();
  check('체인 구축 — head 배치됨', head.visibleChars > 0, `visible=${head.visibleChars}`);
  check('체인 구축 — f2 배치됨 (feed-forward)', f2.visibleChars > 0 && f2.contentFrom > 0);
  check('체인 구축 — f3 배치됨 (feed-forward)', f3.visibleChars > 0 && f3.contentFrom > 0);

  // 변경 없는 재호출 — 기준 스킵 (스킵 판정이 참조 비교로 성립함을 확인)
  const r0 = docEngine.relayoutThreads();
  check('기준: 변경 없는 재호출은 스킵 (skipped: true)', r0.every(t => t.skipped === true));

  // 핵심 실증: 참조만 교체(내용 동일 새 배열) 후 스킵 판정 통과 여부.
  // 같은 내용의 새 참조를 신선화하면 _threadInputUnchanged의
  // `engine.textContent === storyRef`가 참조 상이로 실패해야 정상이다 —
  // story 참조 자체가 신선화 대상이므로 thread.content도 같은 참조로 맞춘다.
  const oldStory = head.textContent;
  const sameContentNewRef = [...oldStory];
  check('동일 내용 새 참조 — 참조 상이 실증', sameContentNewRef !== oldStory
    && storyOf(sameContentNewRef) === storyOf(oldStory));

  for (const pe of [head, f2, f3]) pe.refreshStoryReference(sameContentNewRef);
  // thread.content도 신규 참조로 갱신 (writeback 시맨틱 흉내 — 편집 파이프라인이
  // 새 참조를 만들어 주입한다는 계약과 동일)
  const thread = docEngine.data.threads.find(t => t.id === 't1');
  thread.content = sameContentNewRef;

  // 수렴 시퀀스: 첫 재호출은 _lastInputByThread 시그니처가 구 참조라 전체
  // 배치로 새 시그니처를 기록하고, 두 번째 재호출부터 참조 비교가 통과해
  // 스킵한다 (편집 패스 직후의 실제 수렴 순서와 동일).
  const r1 = docEngine.relayoutThreads();
  check('참조 신선화 후 첫 재호출 — 시그니처 재수렴 (전체 배치)',
    r1.every(t => t.skipped !== true),
    `results=${JSON.stringify(r1.map(t => !!t.skipped))}`);
  const r2 = docEngine.relayoutThreads();
  check('폴백 판정: 재수렴 후 재호출은 스킵 판정 통과 (skipped: true)',
    r2.every(t => t.skipped === true),
    `results=${JSON.stringify(r2.map(t => !!t.skipped))}`);
  check('수렴 후 전 프레임 textContent === 신 story 참조',
    [head, f2, f3].every(pe => pe.textContent === sameContentNewRef));
}

// ═══ 2. (a)+(c) 캐시·dirty 불변 — 신선화가 배치 상태를 보존하는가 ═══
console.log('\n[2] 참조 교체 후 hasLayoutCache 유지 + hasPendingChanges 불변');
{
  const { frames: [head, f2] } = buildChain();
  const f2LayoutBefore = JSON.stringify(f2.columnContents);
  const f2TailBefore = f2.overflowContentFrom;
  check('신선화 전 f2 hasLayoutCache', f2.hasLayoutCache === true);
  check('신선화 전 f2 hasPendingChanges === false', f2.hasPendingChanges === false);

  // head 편집(문두 삽입 — f2/f3 slice가 변하므로 신선화 시나리오와 다름).
  // 여기서는 "구 story 참조 유지 스킵 프레임"을 만들기 위해 f3 영역 편집을 유도:
  // f3 tail 뒤(문장 끝) 삽입은 f2의 committed tail보다 뒤 → f2 clean 스킵.
  const oldStory = head.textContent;
  const oldPlain = storyOf(oldStory);
  const newStory = [...oldStory];
  newStory.push('추가');
  // f3가 소진 상태면 삽입이 f3 slice 내부라도 f2 clean 성립이 애매하다 —
  // 이 시나리오는 계획서 §1의 단위 실증(프레임 1개 대상 참조 교체)으로 좁힌다.
  const r = (() => {
    head.textContent = newStory;
    head._dirty = true;
    return undefined;
  })();

  // f2는 구 참조를 유지한 채 남는다 (현행 동작 — 스킵 프레임 구 story 참조)
  check('현행 스킵 프레임은 구 story 참조를 보유 (f2.textContent !== 신 story)',
    f2.textContent !== newStory, 'f2가 재주입됐다면 스킵이 아니었다는 뜻');

  // f2에 대해 계획의 신선화를 수동 적용 — 캐시·dirty 불변 실증
  f2.refreshStoryReference(newStory);
  check('(a) 참조 교체 후 hasLayoutCache 유지', f2.hasLayoutCache === true);
  check('(c) 참조 교체 후 hasPendingChanges 불변 (false)', f2.hasPendingChanges === false);
  check('참조 교체 후 textContent === 신 story 참조', f2.textContent === newStory);
  check('참조 교체 후 배치 상태 byte 보존',
    JSON.stringify(f2.columnContents) === f2LayoutBefore
    && f2.overflowContentFrom === f2TailBefore);

  // 신선화된 f2의 직접 유도 메모 — stale 방어 실증
  check('(5-i) plainText 무효화 — 신 story plain 반환',
    f2.plainText === storyOf(newStory),
    `plain=${JSON.stringify(String(f2.plainText).slice(0, 12))}… vs 신 story`);
  check('(5-ii) plainText !== 구 story plain',
    f2.plainText !== oldPlain || oldPlain === storyOf(newStory));
  void r;
}

// ═══ 3. (b) 해시 무영향 참조 교체 — _layoutCache 히트 유지 ═══
console.log('\n[3] 해시 무영향 참조 교체 — layoutText 캐시 히트 유지');
{
  // bold 전환은 폭 무영향 필드(fontWeight)만 바꾼다 — digest 직렬화 규칙이
  // fontFamily/fontSize/fontStyle/letterSpacing/widthRatio/spaceRatio만
  // 포함하므로 해시가 동일하다. 캐시 히트 → 재래핑 생략 (R-T2는 참조
  // 비교로 재매핑 강제 — 별도 계약, 여기서는 재래핑 생략만 실증).
  const runStory = [
    '가나다라마바사아자차카타파하'.repeat(10),
    { content: '마바사아', textInlineStyle: { fontWeight: 700 } },
  ];
  const { frames: [head, f2] } = buildChain({ story: runStory });
  void f2;

  const runs = head.textContent;
  if (typeof runs === 'string') {
    check('런 배열 스토리 전제 (스킵: 이 그룹은 배열에서만 성립)', false,
      'textContent가 문자열 — 런 배열로 빌드되지 않음');
  } else {
    // fontWeight 700 → 700은 같은 값이므로 **내용 동등 새 참조**로 해시 무영향
    // 참조 교체를 만든다 (bold "전환"이 아니라 동일 직렬화 참조 복제).
    const sameSerialNewRef = runs.map(item =>
      (typeof item === 'string'
        ? item
        : { content: item.content, textInlineStyle: { ...item.textInlineStyle } }));
    check('동일 직렬화 새 참조 — 참조 상이', sameSerialNewRef !== runs
      && storyOf(sameSerialNewRef) === storyOf(runs));

    // 캐시 히트 판정은 _layoutTextIntoColumns 내부(해시 비교 후 조기 반환)에
    // 있으므로, 실제 재래핑 작업(_layoutColumnsPass — 히트 시 0회)을 카운트한다.
    const proto = Object.getPrototypeOf(head);
    const origPass = proto._layoutColumnsPass;
    let wrapCalls = 0;
    Object.defineProperty(proto, '_layoutColumnsPass', {
      value: function (...args) { wrapCalls++; return origPass.apply(this, args); },
      writable: true, configurable: true,
    });
    try {
      // 기준: 동일 참조 재진입은 캐시 히트로 재래핑 생략
      head.layoutText();
      const baseWrapCalls = wrapCalls;
      check('기준: 동일 참조 layoutText 재진입 — 재래핑 생략 (캐시 히트)',
        baseWrapCalls === 0, `wrapCalls=${baseWrapCalls}`);

      // 참조만 신선화 (동일 직렬화) → 해시 무영향 → 캐시 히트 유지
      head.refreshStoryReference(sameSerialNewRef);
      wrapCalls = 0;
      head.layoutText();
      check('(b) 해시 무영향 참조 교체 — 재래핑 생략 (캐시 히트 유지)',
        wrapCalls === 0, `wrapCalls=${wrapCalls}`);

      // 대조군: 내용 변경 참조 교체는 재래핑된다 (digest 변화 → 해시 미스)
      const contentChanged = sameSerialNewRef.map(item =>
        (typeof item === 'string'
          ? item
          : { content: item.content + '가', textInlineStyle: { ...item.textInlineStyle } }));
      head.refreshStoryReference(contentChanged);
      wrapCalls = 0;
      head.layoutText();
      check('대조군: 내용 변경 참조 교체는 재래핑 (해시 미스 자가 치유)',
        wrapCalls >= 1, `wrapCalls=${wrapCalls}`);
    } finally {
      Object.defineProperty(proto, '_layoutColumnsPass',
        { value: origPass, writable: true, configurable: true });
    }
  }
}

// ═══ 4. 시스템 상태 소멸 — 범위-증명 스킵 패스 후 구 story 참조 소멸 ═══
console.log('\n[4] 스킵 프레임 구 story 참조의 시스템 소멸 (ThreadEngine 연동)');
{
  // 4프레임 체인으로 f2/f3를 중간 프레임(스킵 가능)으로 만든다.
  const story = '가나다라마바사아자차카타파하'.repeat(30);
  const pageEngine = PageEngine.create(
    {
      id: 'page', width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  const boxHeight = 6;
  const children = [0, 1, 2, 3].map(i => ({
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
      content: i === 0 ? story : '',
      column: 1,
      gap: 3,
      paragraphStyle: {},
      textStyle: {},
    },
  }));
  pageEngine.layout(children);
  const docEngine = DocumentEngine.create(
    {
      id: 'doc',
      threads: [{ id: 't4', paragraphIds: ['para-0', 'para-1', 'para-2', 'para-3'] }],
      width: 257, height: 370, columns: 6, gap: 3,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4, fontFamily: 'Myoungjo' },
    },
    fontLoader, colorRegistry, 3.78,
  );
  docEngine.adoptPageEngines([pageEngine]);
  docEngine.layout();
  const frames = [0, 1, 2, 3].map(i => pageEngine.findEngineById(`para-${i}`));
  const [head, , , f4] = frames;
  const te = docEngine._threadEngine;
  check('4프레임 체인 구축 — f2/f3 중간 프레임 배치', frames[1].contentFrom > 0 && frames[2].contentFrom > 0);

  // f4(마지막 프레임)에서 편집 — f2/f3는 범위-증명 clean 스킵 대상
  const plain = storyOf(head.textContent);
  const ps = f4.contentFrom + Math.max(0, f4.visibleChars - 2); // f4 slice 끝부분
  const editedPlain = plain.slice(0, ps) + 'X' + plain.slice(ps);
  const editedRuns = [...head.textContent];
  // 런 배열 끝에 'X' 삽입 (편집 파이프라인이 새 배열을 만드는 것과 동일)
  editedRuns.push('X');
  head.textContent = editedRuns;
  head._dirty = true;
  // writeback이 계산하는 editPs와 동일한 조건: f2/f3 committed tail < ps
  const committed = te._committedByThread.get('t4');
  check('편집 위치가 f2/f3 committed tail 뒤 (clean 스킵 전제)',
    committed !== undefined && committed.contentFrom[1] < ps && committed.contentFrom[2] < ps,
    `ps=${ps} f2tail=${committed?.contentFrom[1]} f3tail=${committed?.contentFrom[2]}`);

  docEngine.relayoutThreads(new Set(['para-0']));
  const newStoryRef = docEngine.data.threads.find(t => t.id === 't4').content;
  check('스킵 패스 후 전 프레임이 현재 story 참조를 소유 (구 참조 소멸)',
    frames.every(pe => pe.textContent === newStoryRef),
    `refs=${frames.map(pe => pe.textContent === newStoryRef).join(',')}`);
  check('스킵 패스 후 stale 집합 소멸 (다음 스킵 판정 세척)',
    te.hasStaleSkippedFrames('t4') === false);

  // 다음 패스는 전체 스킵 — 참조 비교가 전부 통과함의 증명
  const r = docEngine.relayoutThreads();
  check('소멸 후 변경 없는 재호출 — 전체 스킵 (참조 비교 통과)',
    r.every(t => t.skipped === true),
    `results=${JSON.stringify(r.map(t => !!t.skipped))}`);

  // 스킵 프레임(f2)을 편집 소스로 writeback — 신 story가 기록되는가 (롤백 방어)
  const storyBefore = storyOf(newStoryRef);
  const f2Edited = [...frames[1].textContent];
  f2Edited.push('Y');
  frames[1].textContent = f2Edited;
  frames[1]._dirty = true;
  docEngine.relayoutThreads(new Set(['para-1']));
  const afterWriteback = storyOf(docEngine.data.threads.find(t => t.id === 't4').content);
  check('스킵 프레임 편집 소싱 — 신 story 기록 (구 story 롤백 없음)',
    afterWriteback === storyBefore + 'Y' && afterWriteback.length === storyBefore.length + 1,
    `before=${storyBefore.length} after=${afterWriteback.length}`);
  check('하류 편집(X) 보존 (f2bbe8b 회귀 방어)', afterWriteback.includes('X'));
}

// ═══ 5. 직접 유도 메모 stale 실증 — 참조만 교체하면 안 되는 이유 ═══
console.log('\n[5] 직접 유도 메모 — 참조 교체의 stale 위험과 무효화 방어');
{
  const { frames: [head] } = buildChain();
  // plainText/스타일 런 메모를 구 story로 채운다 (경로: _boundaryCorrection·
  // 편집 컨트롤러 textarea 동기 — 실제 소비 시나리오)
  const oldPlain = head.plainText; // 메모 채움
  void oldPlain;
  const oldRuns = head.getInlineStyleAt(0); // _styleRuns 메모 채움
  void oldRuns;

  const oldStory = head.textContent;
  // bold 전환(해시 무영향) 새 참조 — 내용 동일하므로 plain은 동일하다.
  // stale 판정은 "메모가 새 참조를 반영하는가"로 한다: 무효화 후 재산출이
  // 새 참조를 소스로 하는지.
  const bolded = (typeof oldStory === 'string')
    ? [{ content: oldStory, textInlineStyle: { fontWeight: 700 } }]
    : oldStory.map(item => (typeof item === 'string'
      ? { content: item, textInlineStyle: { fontWeight: 700 } }
      : { ...item, textInlineStyle: { ...(item.textInlineStyle ?? {}), fontWeight: 700 } }));
  head.refreshStoryReference(bolded);
  const plainAfter = head.plainText;
  check('plainText 메모가 신 참조에서 재산출 (stale 메모 아님)',
    plainAfter === storyOf(bolded));
  check('getInlineStyleAt이 신 참조의 bold 런을 반환 (_styleRuns 재구축)',
    head.getInlineStyleAt(0)?.fontWeight === 700);
}

// ═══ 종합 ═══
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`ALL PASS — ${passed}항목 (A-6 전제 실증 완료: 진행 경로 확정)`);
  console.log('폴백 판정: refreshStoryReference가 스킵 판정 참조 비교를 통과 — §1-b 폴백 불요');
} else {
  console.log(`FAILED — ${failed}/${passed + failed}항목`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('폴백 판정: 전제 실증 실패 — 3종 봉합을 계약으로 굳히는 §1-b 폴백으로 전환');
  process.exit(1);
}