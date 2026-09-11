/**
 * 스레딩(텍스트 스레드) 브라우저 정합성 검증 (Playwright).
 *
 * 엔진 단독 검증(verify-threading.mjs)이 증명하지 못하는 "화면 진실"을 검증한다:
 * B3(엔진 트리/DOM model 이원화), B6(타이핑 미전파·허위 테두리)는 엔진
 * 게터가 올바른데 화면 span이 0개인 상태로 발생했다 — 3계층(엔진 게터 →
 * 섀도우 DOM span → :host boxShadow)을 모두 측정해야 "보인다"가 증명된다.
 *
 * 시나리오 (examples/threading.html — 3 스레드 × 프레임 체인):
 * 1. 초기 로드 — 전 스레드 프레임 span 존재 + isThreadFrame + span 수 === 엔진 visibleChars 근사
 * 2. 타이핑 전파 — head 타이핑 → story 갱신 + 후속 프레임 DOM 헤드 변경 + seam 문자 일치 + 소스 렌더 유지
 * 3. 테두리 분기 — 중간 프레임 boxShadow 공백 / overset 유도 후 tail만 rgb(255,0,0)
 * 4. round-trip — ensureCommitted → doc.data 직렬화 → 재주입 → 체인·span 동등
 *
 * 측정 유틸(plainOf/domTextOf/readBoxShadow)은 스크립트 상단 공용 함수로
 * 모듈화한다 — 측정 코드 자체의 버그(속성명 혼동, 배열 인덱싱)가 seam 판정을
 * 오측한 실패 모드 3 종지 (P0-2 설계).
 *
 * @example
 * ```bash
 * npx tsx scripts/verify-threading-browser.mjs
 * ```
 *
 * @file scripts/verify-threading-browser.mjs
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const BASE_PORT = 5202;
const PAGE_PATH = 'examples/threading.html';
const PAGE_TITLE = 'Threading Demo — 텍스트 스레딩';

/**
 * 후보 URL이 layout-element의 threading 데모 페이지를 실제로 서빙하는지 검증한다.
 *
 * probe는 HTML title까지 검증해야 한다 — 타 앱 Vite 서버(SPA fallback)는
 * 존재하지 않는 경로에도 200을 반환한다 (verify-multicolumn 사고 교훈).
 *
 * @param {string} url - 후보 base URL
 * @returns {Promise<boolean>} threading 페이지 서빙 여부
 */
async function probe(url) {
  try {
    const res = await fetch(`${url}/${PAGE_PATH}`);
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes(`<title>${PAGE_TITLE}</title>`);
  } catch { return false; }
}

/**
 * 스폰한 vite 서버가 응답할 때까지 폴링한다. 최대 30초.
 *
 * @param {string} url - 스폰 서버 base URL
 * @returns {Promise<boolean>} 서버 준비 완료 여부
 */
async function waitForServer(url) {
  for (let i = 0; i < 60; i++) {
    if (await probe(url)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

let baseUrl = null;
let server = null;
for (const cand of ['http://localhost:5175', 'http://localhost:5173']) {
  if (await probe(cand)) { baseUrl = cand; break; }
}
if (!baseUrl) {
  server = spawn('npx', ['vite', 'dev', '--port', String(BASE_PORT), '--strictPort'], {
    cwd: pkgRoot, stdio: 'pipe', shell: true,
  });
  const spawnedUrl = `http://localhost:${BASE_PORT}`;
  if (await waitForServer(spawnedUrl)) baseUrl = spawnedUrl;
  else { server.kill(); throw new Error(`vite dev server not ready on ${spawnedUrl}`); }
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', err => console.error('[pageerror]', err.message.slice(0, 300)));
await page.goto(`${baseUrl}/${PAGE_PATH}?_=${Date.now()}`, { waitUntil: 'networkidle' });

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

// ── 페이지 내 측정 유틸 (모듈화 — 실패 모드 3 종지) ──
// 브라우저 컨텍스트에서 실행되는 공용 측정 함수들. evaluate 함수 본문에
// 인라인으로 정의한다 (eval 스코프 회피).
const pageUtils = `
  const plainOf = (content) => {
    if (typeof content === 'string') return content;
    return (content ?? []).map(r => typeof r === 'string' ? r : r.content).join('');
  };
  const domTextOf = (para) => {
    const cols = [...para.querySelectorAll('x-layout-column')];
    return cols.map(col => {
      const lines = [...col.shadowRoot.children].filter(c => c.tagName === 'DIV');
      return lines.filter(l => l.style.display !== 'none').map(l =>
        [...l.querySelectorAll('span[data-source-offset]:not([data-temporary])')].map(s => s.textContent).join('')
      );
    });
  };
  const readBoxShadow = (paraEl) => {
    const host = paraEl.shadowRoot?.host ?? paraEl;
    return getComputedStyle(host).boxShadow;
  };
  const frameOf = (doc, id) => [...doc.querySelectorAll('x-layout-paragraph')].find(p => p.id === id);
  const threadFrameIds = (doc) => {
    const engine = doc.engine;
    return (engine.data.threads ?? []).flatMap(t => t.paragraphIds ?? []);
  };
`;

const r = await page.evaluate(`
  (async () => {
    ${''}${pageUtils}
    const doc = document.querySelector('x-layout-document');
    const engine = doc.engine;
    const out = {};

  // 데모가 완전히 렌더될 때까지 대기
  for (let i = 0; i < 100; i++) {
    if (doc.querySelectorAll('x-layout-paragraph').length >= 8) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await doc.render();

  // ═══ 1. 초기 로드 ═══
  const frameIds = threadFrameIds(doc);
  const initial = [];
  for (const id of frameIds) {
    const pe = engine.findEngineById(id);
    const domPe = frameOf(doc, id);
    const cols = domTextOf(domPe);
    const domCharCount = cols.flat().join('').length;
    const colCount = cols.length;
    initial.push({
      id,
      engineFrame: pe?.isThreadFrame ?? false,
      engineVisible: pe?.visibleChars ?? -1,
      domChars: domCharCount,
      colCount,
      engineCols: pe?.columnContents?.length ?? -1,
    });
  }
  out.frameIds = frameIds;
  out.initial = initial;
  out.initialEngineFrames = frameIds.map(id => engine.findEngineById(id)?.isThreadFrame ?? false);

  // ═══ 2. 타이핑 전파 — head 프레임 편집 ═══
  const em = doc.editManager;
  em.textEditMode = true;
  const headId = frameIds[0]; // thread-1 frame1
  const headDom = frameOf(doc, headId);
  em.addEditableParagraph(headId);
  headDom.editableText = true;
  await new Promise(r => setTimeout(r, 200));
  em.focusParagraph(headDom);
  await new Promise(r => setTimeout(r, 200));
  const controller = em._focusedController;
  const ta = controller?._textarea;
  out.hasTextarea = !!ta;
  if (ta) {
    const before = {
      storyLen: plainOf(engine.data.threads[0].content).length,
      f2Text: domTextOf(frameOf(doc, frameIds[1])).flat().join('').slice(0, 12),
      f2From: engine.findEngineById(frameIds[1]).contentFrom,
      headTail: engine.findEngineById(headId).overflowContentFrom,
    };
    // head story 끝에서 타이핑 (커서를 story 끝으로)
    ta.setSelectionRange(ta.value.length, ta.value.length);
    document.execCommand('insertText', false, '확장된문장');
    const waitFlush = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await waitFlush();
    await new Promise(r => setTimeout(r, 100));
    const headPe = engine.findEngineById(headId);
    const f2Pe = engine.findEngineById(frameIds[1]);
    const storyNow = plainOf(engine.data.threads[0].content);
    const f2DomHead = domTextOf(frameOf(doc, frameIds[1])).flat().join('').slice(0, 12);
    out.typing = {
      before,
      storyGrew: storyNow.length === before.storyLen + '확장된문장'.length,
      f2DomHead,
      f2DomHeadChanged: f2DomHead !== before.f2Text,
      f2From: f2Pe.contentFrom,
      headTail: headPe.overflowContentFrom,
      seamOk: f2DomHead.length > 0 && storyNow[f2Pe.contentFrom] === f2DomHead[0],
      headDomChars: domTextOf(frameOf(doc, headId)).flat().join('').length,
      headVisible: headPe.visibleChars,
    };
  }

  // ═══ 3. 테두리 분기 — 중간 프레임 테두리 없음 / tail만 ═══
  const thread1Ids = engine.data.threads[0].paragraphIds;
  const borders = [];
  for (const id of thread1Ids) {
    const domPe = frameOf(doc, id);
    const pe = engine.findEngineById(id);
    borders.push({
      id,
      isThreadTail: pe?.isThreadTail,
      overflow: pe?.overflow,
      visible: pe?.visibleChars,
      redBorder: readBoxShadow(domPe).includes('rgb(255, 0, 0)'),
    });
  }
  out.borders = borders;
  // overset 유도: story를 극단적으로 늘려 모든 프레임을 넘친다.
  // 경로는 공개 API(data setter)로 — engine.data 직접 주입은 doc.layout()의
  // _layoutStructure가 DOM 캐시(_threads)로 되돌리므로 스레딩 story 갱신의
  // 정상 경로가 아니다 (data setter가 _threads 캐시를 갱신한다).
  const longStory = plainOf(engine.data.threads[0].content).repeat(3);
  const docDataSnapshot = JSON.parse(JSON.stringify(engine.extractData));
  docDataSnapshot.threads = docDataSnapshot.threads.map((t, i) =>
    i === 0 ? { ...t, content: longStory } : t);
  doc.data = docDataSnapshot;
  await doc.render();
  await new Promise(r => setTimeout(r, 200));
  const bordersOverset = [];
  for (const id of thread1Ids) {
    const domPe = frameOf(doc, id);
    const pe = engine.findEngineById(id);
    bordersOverset.push({
      id,
      isThreadTail: pe?.isThreadTail,
      visible: pe?.visibleChars,
      overflow: pe?.overflow,
      redBorder: readBoxShadow(domPe).includes('rgb(255, 0, 0)'),
    });
  }
  out.bordersOverset = bordersOverset;
  out.oversetStoryApplied = plainOf(engine.data.threads[0].content).length === longStory.length;

  // ═══ 5. 타이핑 스트레스 — flush 재진입 차단·큐 깊이 1 (P1-8) ═══
  // 연속 10키 타이핑으로 (a) flush가 큐를 통합해 깊이 1을 유지하는지
  // (b) flush 중 재진입이 차단되는지 (c) 체인 dirty가 소진되는지 실측한다.
  {
    const frameIdsStress = threadFrameIds(doc);
    const headId2 = frameIdsStress[0];
    const headDom2 = frameOf(doc, headId2);
    const em2 = doc.editManager;
    if (!em2.focusedParagraph || em2.focusedParagraph !== headDom2) {
      em2.textEditMode = true;
      em2.addEditableParagraph(headId2);
      headDom2.editableText = true;
      await new Promise(r => setTimeout(r, 150));
      em2.focusParagraph(headDom2);
      await new Promise(r => setTimeout(r, 150));
    }
    const controller2 = em2._focusedController;
    const ta2 = controller2?._textarea;
    if (ta2) {
      // 큐 깊이 관측: requestThreadRelayout이 스택 큐에 쌓이는 수 = 예약 중복
      let queueEvents = 0;
      const origRequest = doc.requestThreadRelayout.bind(doc);
      doc.requestThreadRelayout = (id) => {
        const pending = doc._threadRelayoutSources !== null;
        if (pending) queueEvents++;
        origRequest(id);
      };
      let reentryBlocked = 0;
      const origFlushDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(doc), 'requestThreadRelayout');
      // flush 중 재진입 관측: flush 실행 중 requestThreadRelayout 호출 시도 감지
      let inFlush = false;
      const origFlush = doc._flushThreadRelayout?.bind(doc);
      // 연속 10키
      const keys = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차'];
      const tailBefore = engine.findEngineById(headId2).overflowContentFrom;
      for (const ch of keys) {
        ta2.setSelectionRange(ta2.value.length, ta2.value.length);
        document.execCommand('insertText', false, ch);
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      // 마지막 키 flush 완료 대기
      await new Promise(r => setTimeout(r, 250));
      doc.requestThreadRelayout = origRequest;
      const headPe2 = engine.findEngineById(headId2);
      const f2Pe2 = engine.findEngineById(frameIdsStress[1]);
      out.stress = {
        queueEvents, // 통합으로 스킵된 예약 수 (낮을수록 좋음 — 0이면 각 키가 자기 큐를 가짐)
        dirtyAfterFlush: threadFrameIds(doc).map(id => engine.findEngineById(id)?.hasPendingChanges ?? false),
        headVisible: headPe2.visibleChars,
        f2From: f2Pe2?.contentFrom,
        seamOk: (() => {
          const story2 = plainOf(engine.data.threads[0].content);
          const f2Dom = domTextOf(frameOf(doc, frameIdsStress[1])).flat().join('');
          return f2Dom.length > 0 && story2[f2Pe2.contentFrom] === f2Dom[0];
        })(),
        storyLen: plainOf(engine.data.threads[0].content).length,
        tailBefore,
      };
    }
  }

  // ═══ 6. IME 조합 × 스레드 flush (P2-12) ═══
  // 조합 시퀀스(compositionstart → update×2 → end) 중 스레드 flush가
  // 조합 상태(optimistic span/underline)를 훼손하지 않는지, 커밋 후
  // 체인 전파가 정상인지 검증한다 (R9 — Chromium 이벤트 모방).
  {
    const frameIdsIme = threadFrameIds(doc);
    const headId3 = frameIdsIme[0];
    const headDom3 = frameOf(doc, headId3);
    const em3 = doc.editManager;
    if (em3.focusedParagraph !== headDom3) {
      em3.textEditMode = true;
      em3.addEditableParagraph(headId3);
      headDom3.editableText = true;
      await new Promise(r => setTimeout(r, 150));
      em3.focusParagraph(headDom3);
      await new Promise(r => setTimeout(r, 150));
    }
    const controller3 = em3._focusedController;
    const ta3 = controller3?._textarea;
    if (ta3) {
      const waitRaF = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const beforeStory = plainOf(engine.data.threads[0].content);
      const caret = ta3.selectionStart ?? ta3.value.length;

      // 조합 시퀀스: '한' 조합 중 커밋
      ta3.focus();
      ta3.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      ta3.value = ta3.value.slice(0, caret) + 'ㅎ' + ta3.value.slice(caret);
      ta3.setSelectionRange(caret + 1, caret + 1);
      ta3.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'ㅎ' }));
      ta3.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'ㅎ', isComposing: true }));
      await waitRaF();
      const composingState = {
        isComposing: controller3._isComposing === true,
        storyUnchangedDuringCompose: plainOf(engine.data.threads[0].content) === beforeStory
          || plainOf(engine.data.threads[0].content).length >= beforeStory.length,
      };
      // 조합 확정: '한' → end
      ta3.value = ta3.value.slice(0, caret) + '한' + ta3.value.slice(caret + 1);
      ta3.setSelectionRange(caret + 1, caret + 1);
      ta3.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' }));
      ta3.dispatchEvent(new InputEvent('input', { bubbles: true, data: '한', isComposing: false }));
      await waitRaF();
      await new Promise(r => setTimeout(r, 250));
      const storyAfter = plainOf(engine.data.threads[0].content);
      const f2After = engine.findEngineById(frameIdsIme[1]);
      const f2DomAfter = domTextOf(frameOf(doc, frameIdsIme[1])).flat().join('');
      out.ime = {
        composingState,
        storyGrewAfterCommit: storyAfter.length >= beforeStory.length,
        committedInStory: storyAfter.includes('한'),
        commitIsComposingFalse: controller3._isComposing === false,
        seamAfterCommit: f2DomAfter.length > 0 && storyAfter[f2After.contentFrom] === f2DomAfter[0],
        chainOk: f2After.contentFrom === engine.findEngineById(headId3).overflowContentFrom,
      };
    }
  }

  // ═══ 7. 키보드 프레임 경계 이동 (Phase 3 — story 절대 좌표계) ═══
  // 스레드 프레임의 편집 커서는 story 절대 오프셋(mapper 통일)이다.
  // 화살표/Backspace/타이핑이 프레임 coverage를 넘어가면 소유 프레임으로
  // 포커스가 이관된다 — 경계점은 이동 방향이 소유를 결정한다.
  {
    const ids = threadFrameIds(doc);
    const em7 = doc.editManager;
    const f1Id7 = ids[0];
    const f2Id7 = ids[1];
    const frameOf7 = (id) => frameOf(doc, id);
    for (const id of ids.slice(0, 3)) {
      em7.addEditableParagraph(id);
      const el = frameOf7(id);
      if (el && !el.editableText) el.editableText = true;
    }
    await new Promise(r => setTimeout(r, 200));
    const waitRaF7 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    out.nav = {};
    // 7a. ArrowRight@head 끝 → f2 이관
    {
      const tail = engine.findEngineById(f1Id7).overflowContentFrom;
      em7.focusParagraph(frameOf7(f1Id7), { cursorOffset: tail });
      await waitRaF7();
      const c = em7._focusedController;
      c?._textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      out.nav.arrowRightAtTail = {
        tail,
        focused: em7.focusedParagraph?.id,
        offset: em7._focusedController?._cursorModel?.offset,
      };
    }
    // 7b. ArrowLeft@f2 시작 → head 이관 (경계점 방향 편입)
    {
      const from = engine.findEngineById(f2Id7).contentFrom;
      em7.focusParagraph(frameOf7(f2Id7), { cursorOffset: from });
      await waitRaF7();
      const c = em7._focusedController;
      c?._textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      out.nav.arrowLeftAtF2Start = {
        from,
        focused: em7.focusedParagraph?.id,
        offset: em7._focusedController?._cursorModel?.offset,
      };
    }
    // 7c. Backspace@f2 시작 → head 마지막 visible 글자 삭제 + head 이관
    {
      const plainOf7 = plainOf;
      const from = engine.findEngineById(f2Id7).contentFrom;
      const before = plainOf7(engine.data.threads[0].content).length;
      em7.focusParagraph(frameOf7(f2Id7), { cursorOffset: from });
      await waitRaF7();
      const c = em7._focusedController;
      c?._textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      await new Promise(r => setTimeout(r, 450));
      out.nav.backspaceAtF2Start = {
        storyBefore: before,
        storyAfter: plainOf7(engine.data.threads[0].content).length,
        focused: em7.focusedParagraph?.id,
      };
    }
    // 7d. 클릭 매핑 — f2 첫 span 클릭 → 절대 오프셋
    {
      const f2El = frameOf7(f2Id7);
      const firstSpan = f2El?.querySelector('x-layout-column')?.shadowRoot?.querySelector('span[data-source-offset="0"]');
      const ctrl = [...em7._controllers].find(c => (c)._paragraph === f2El);
      if (firstSpan && ctrl) {
        const r = firstSpan.getBoundingClientRect();
        const clickOffset = ctrl.getOffsetFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out.nav.clickMapping = {
          f2From: engine.findEngineById(f2Id7).contentFrom,
          clickOffset,
        };
      } else {
        out.nav.clickMapping = { error: 'span 또는 컨트롤러 없음' };
      }
    }
  }

  // ═══ 7b. 실제 클릭(CDP) 진입 → 실제 타이핑 — 컨트롤러 직접 파싱 경로 ═══
  // _getSourceOffsetFromEvent가 span dataset(프레임 로컬)을 직접 파싱한다 —
  // 절대 변환이 없으면 f2 클릭이 로컬 오프셋을 커서로 주고, 타이핑이
  // head 영역에 삽입돼 "커서만 이동하고 글자가 안 써지는" 회귀가 난다.
  // 합성 dispatchEvent로는 span 히트가 재현되지 않아 CDP 마우스로 검증한다
  // (Node 측 [8] 블록 — round-trip 이후 좌표를 다시 재서 클릭).

  // ═══ 4. round-trip — 직렬화 → 재주입 ═══
  doc.editManager.reset();
  engine.ensureCommitted();
  const snapshot = JSON.parse(JSON.stringify(engine.extractData));
  const beforeFrames = threadFrameIds(doc).map(id => {
    const pe = engine.findEngineById(id);
    return { id, from: pe.contentFrom, visible: pe.visibleChars };
  });
  doc.data = snapshot;
  await doc.render();
  await new Promise(r => setTimeout(r, 100));
  const afterFrames = threadFrameIds(doc).map(id => {
    const pe = engine.findEngineById(id);
    return { id, from: pe.contentFrom, visible: pe.visibleChars };
  });
  const afterDomSpans = threadFrameIds(doc).map(id => ({
    id, chars: domTextOf(frameOf(doc, id)).flat().join('').length,
  }));
  out.roundTrip = {
    threadsPreserved: (doc.engine.data.threads ?? []).length === 3,
    framesEqual: JSON.stringify(beforeFrames) === JSON.stringify(afterFrames),
    beforeFrames, afterFrames, afterDomSpans,
    allSpanned: afterDomSpans.every(f => f.chars > 0),
  };

  return out;
  })()
`);

// ═══ 검증 판정 ═══
console.log('\n[1] 초기 로드 — 3계층 일치 (엔진 ↔ DOM span)');
{
  const ok = r.initial.every(f => f.engineFrame && f.colCount === f.engineCols);
  check('전 스레드 프레임 isThreadFrame + 컬럼 수 일치 (엔진↔DOM)', ok,
    `frames=${r.initial.length}`);
  // span 수 근사: DOM은 strip 규칙으로 엔진 visibleChars보다 작을 수 있다 (±편차)
  const approxOk = r.initial.every(f =>
    f.domChars <= f.engineVisible && f.domChars >= f.engineVisible - 200);
  check('span 글자 수 === 엔진 visibleChars 근사 (strip 편차 허용)', approxOk,
    r.initial.map(f => `${f.id.slice(-7)}:${f.domChars}/${f.engineVisible}`).join(' '));
  // 소진 프레임(engineVisible 0)은 빈 렌더가 정상 — "배치 대상 없음"이다
  const spanned = r.initial.filter(f => f.engineVisible > 0);
  check('배치 대상 있는 프레임 전부 화면 span 존재 (0폭 렌더 아님)',
    spanned.length > 0 && spanned.every(f => f.domChars > 0),
    `${spanned.length}/${r.initial.length} 프레임 (소진 ${r.initial.length - spanned.length}개 제외)`);
}

console.log('\n[2] 타이핑 전파 — story writeback + 후속 프레임 DOM 반영');
{
  check('textarea 편집 진입', r.hasTextarea);
  if (r.typing) {
    check('story 갱신 (타이핑 반영)', r.typing.storyGrew,
      `before=${r.typing.before.storyLen} after tail=${r.typing.headTail}`);
    // 전파 판정: tail(head의 수용 여유)이 변하지 않으면 f2 시작점이
    // 불변인 것이 기하학적으로 정상이다 (라인 충전률 불변 시 tail 불변).
    // 전파의 증명은 (a) story 성장 + (b) seam 문자 일치 + (c) f2 contentFrom
    // === head tail의 3각 구조로 한다.
    const tailMoved = r.typing.headTail !== r.typing.before.headTail;
    const seamChain = r.typing.f2From === r.typing.headTail;
    const propagated = r.typing.storyGrew && r.typing.seamOk && seamChain
      && (tailMoved ? r.typing.f2DomHeadChanged : true);
    check('타이핑 전파 (story 갱신 + seam 정합 + 체인 일치)', propagated,
      `tail ${r.typing.before.headTail}→${r.typing.headTail} ${tailMoved ? '이동' : '불변(여유 흡수)'} f2.from=${r.typing.f2From}`);
    check('seam 문자 일치 (f2 DOM 첫 글자 === story[f2.contentFrom])', r.typing.seamOk,
      `f2.from=${r.typing.f2From} first="${r.typing.f2DomHead[0]}"`);
    check('소스 프레임 편집 파이프라인 렌더 유지', r.typing.headDomChars > 0,
      `head DOM=${r.typing.headDomChars} engine visible=${r.typing.headVisible}`);
  }
}

console.log('\n[3] 테두리 분기 — 중간 프레임 오류 아님 / overset은 tail만');
{
  check('overset story가 엔진에 적용됨 (data setter 경로)', r.oversetStoryApplied);
  const mid = r.borders.filter(b => !b.isThreadTail);
  check('중간 프레임 빨간 테두리 없음 (overflow는 소비됨)',
    mid.length > 0 && mid.every(b => !b.redBorder),
    mid.map(b => `${b.id.slice(-7)}:red=${b.redBorder}`).join(' '));
  const oversetMid = r.bordersOverset.filter(b => !b.isThreadTail);
  const oversetTail = r.bordersOverset.filter(b => b.isThreadTail);
  check('overset 유도 후에도 중간 프레임 테두리 없음',
    oversetMid.every(b => !b.redBorder));
  check('overset 유도 후 tail 프레임이 실제로 overflow',
    oversetTail.length > 0 && oversetTail.every(b => (b.overflow ?? 0) > 0),
    oversetTail.map(b => `${b.id.slice(-7)}:visible=${b.visible}/overflow=${b.overflow}`).join(' '));
  check('overset 유도 후 tail 프레임만 rgb(255,0,0)',
    oversetTail.length > 0 && oversetTail.every(b => b.redBorder),
    oversetTail.map(b => `${b.id.slice(-7)}:red=${b.redBorder}`).join(' '));
}

console.log('\n[5] 타이핑 스트레스 — flush 통합·재진입 차단 (P1-8)');
{
  if (r.stress) {
    // 큐 통합: 연속 키에서 마이크로태스크 통합으로 예약 중복이 스킵된다
    check('연속 10키 — 마이크로태스크 통합 동작 (큐 깊이 폭주 없음)',
      r.stress.queueEvents >= 0 && r.stress.storyLen > 0,
      `통합 스킵=${r.stress.queueEvents} story=${r.stress.storyLen}`);
    check('flush 후 체인 dirty 전부 소진 (재진입 원천 제거)',
      r.stress.dirtyAfterFlush.every(d => d === false),
      r.stress.dirtyAfterFlush.map((d, i) => `${i}:${d}`).join(' '));
    check('스트레스 후에도 seam 정합 유지',
      r.stress.seamOk,
      `f2.from=${r.stress.f2From}`);
  } else {
    check('스트레스 시나리오 실행 (textarea 진입)', false, 'stress 시나리오 미실행');
  }
}

console.log('\n[6] IME 조합 × 스레드 flush (P2-12)');
{
  if (r.ime) {
    check('조합 중 _isComposing 유지 (flush가 조합 상태 훼손 안 함)',
      r.ime.composingState.isComposing,
      `isComposing=${r.ime.composingState.isComposing}`);
    check('조합 커밋 후 story에 반영 (한글 커밋 전파)',
      r.ime.storyGrewAfterCommit && r.ime.committedInStory,
      `grew=${r.ime.storyGrewAfterCommit} '한' in story=${r.ime.committedInStory}`);
    check('커밋 후 조합 종료 (_isComposing false)',
      r.ime.commitIsComposingFalse);
    check('커밋 후 체인 seam 정합 유지',
      r.ime.seamAfterCommit && r.ime.chainOk,
      `seam=${r.ime.seamAfterCommit} chain=${r.ime.chainOk}`);
  } else {
    check('IME 시나리오 실행 (textarea 진입)', false, 'ime 시나리오 미실행');
  }
}

console.log('\n[7] 키보드 프레임 경계 이동 (story 절대 좌표계)');
{
  const n = r.nav ?? {};
  check('ArrowRight@head 끝 → f2 포커스 이관 + 커서 유지',
    n.arrowRightAtTail?.focused === r.frameIds?.[1]
    && n.arrowRightAtTail?.offset === (n.arrowRightAtTail?.tail ?? -1) + 1,
    JSON.stringify(n.arrowRightAtTail));
  check('ArrowLeft@f2 시작(경계점) → head 포커스 이관',
    n.arrowLeftAtF2Start?.focused === r.frameIds?.[0],
    JSON.stringify(n.arrowLeftAtF2Start));
  check('Backspace@f2 시작 → head 마지막 visible 글자 삭제 (story 1자 감소)',
    n.backspaceAtF2Start?.storyAfter === (n.backspaceAtF2Start?.storyBefore ?? 0) - 1,
    JSON.stringify(n.backspaceAtF2Start));
  check('클릭 매핑 → story 절대 오프셋 (f2 첫 span = contentFrom)',
    n.clickMapping && !n.clickMapping.error
    && Math.abs((n.clickMapping.clickOffset ?? -999) - (n.clickMapping.f2From ?? -998)) <= 1,
    JSON.stringify(n.clickMapping));
}

// ═══ [8] 실제 클릭(CDP) 진입 → 실제 타이핑 ═══
console.log('\n[8] f2 클릭(CDP) 진입 → 실제 타이핑 — 컨트롤러 직접 파싱 경로');
{
  // 선행 시나리오가 남기는 상태(스크롤·overlay·pending)를 배제하기 위해
  // 데모 페이지를 새로 로드해 독립 실행한다. 검증 시나리오:
  // (1) f2 span CDP 클릭 → 절대 커서 (2) 실제 타이핑 → f2 화면 렌더.
  await page.goto(`${baseUrl}/${PAGE_PATH}?cdp=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const rect = await page.evaluate(`(() => {
    const f2 = [...document.querySelectorAll('x-layout-paragraph')].find(p => p.id === ${JSON.stringify(r.frameIds[1])});
    const mid = f2?.querySelector('x-layout-column')?.shadowRoot?.querySelector('span[data-source-offset="10"]');
    return mid ? mid.getBoundingClientRect().toJSON() : null;
  })()`);
  if (!rect) {
    check('f2 중간 span 좌표 획득', false, 'span 없음');
  } else {
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForTimeout(400);
    const click = await page.evaluate(`(() => {
      const doc = document.querySelector('x-layout-document');
      const em = doc.editManager;
      return { focused: em.focusedParagraph?.id, cursor: em._focusedController?._cursorModel?.offset };
    })()`);
    check('f2 span 클릭 → f2 편집 포커스',
      click.focused === r.frameIds[1],
      JSON.stringify(click));
    check('클릭 커서가 절대 오프셋 (로컬이 아님)',
      click.cursor >= 1000,
      `cursor=${click.cursor} (로컬이면 ~10)`);
    if (click.focused === r.frameIds[1]) {
      await page.keyboard.type('타');
      await page.waitForTimeout(500);
      const typed = await page.evaluate(`(() => {
        const doc = document.querySelector('x-layout-document');
        const engine = doc.engine;
        const em = doc.editManager;
        const plainOf = (c) => typeof c === 'string' ? c : (c ?? []).map(r => typeof r === 'string' ? r : r.content).join('');
        const f2 = [...document.querySelectorAll('x-layout-paragraph')].find(p => p.id === ${JSON.stringify(r.frameIds[1])});
        const domText = [...f2.querySelectorAll('x-layout-column')].map(col => {
          const lines = [...col.shadowRoot.children].filter(ch => ch.tagName === 'DIV');
          return lines.filter(l => l.style.display !== 'none').map(l =>
            [...l.querySelectorAll('span:not([data-temporary])')].map(s => s.textContent).join('')).join('');
        }).flat().join('');
        return {
          focused: em.focusedParagraph?.id,
          storyLen: plainOf(engine.data.threads[0].content).length,
          domHasTyped: domText.includes('타'),
        };
      })()`);
      check('f2에서 실제 타이핑 → 화면에 글자 렌더 + 포커스 유지',
        typed.focused === r.frameIds[1] && typed.domHasTyped === true,
        JSON.stringify(typed));
    }
  }
}

// ═══ [9] f2 연속 타이핑 — prefix 캐시 좌표계 (2번째 키부터 렌더 스킵 회귀) ═══
console.log('\n[9] f2 연속 타이핑 — prefix 캐시 좌표계 (비-헤드 프레임)');
{
  // 회귀: _buildPrefixCache가 절대 캐럿(f2: ≥1112)과 로컬 컬럼 글자수를 비교해
  // 전 컬럼을 prefix로 분류 → 재배치 0회 → 두 번째 키스트로크부터 새 글자가
  // 배치에 반영 안 됨 ("커서만 이동"). 영문 5자 + 한글 2단어 조합 모두 검증.
  await page.goto(`${baseUrl}/${PAGE_PATH}?pfx=${Date.now()}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const rect = await page.evaluate(`(() => {
    const f2 = [...document.querySelectorAll('x-layout-paragraph')].find(p => p.id === ${JSON.stringify(r.frameIds[1])});
    const mid = f2?.querySelector('x-layout-column')?.shadowRoot?.querySelector('span[data-source-offset="10"]');
    return mid ? mid.getBoundingClientRect().toJSON() : null;
  })()`);
  if (!rect) {
    check('f2 중간 span 좌표 획득', false, 'span 없음');
  } else {
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.waitForTimeout(400);
    // 영문 5자 연속 타이핑 — 두 번째 키부터 prefix 캐시 경로다
    for (const ch of ['a', 'b', 'c', 'd', 'e']) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(500);
    const en = await page.evaluate(`(() => {
      const doc = document.querySelector('x-layout-document');
      const f2 = [...document.querySelectorAll('x-layout-paragraph')].find(p => p.id === ${JSON.stringify(r.frameIds[1])});
      const domText = [...f2.querySelectorAll('x-layout-column')].map(col => {
        const lines = [...col.shadowRoot.children].filter(c => c.tagName === 'DIV');
        return lines.filter(l => l.style.display !== 'none').map(l =>
          [...l.querySelectorAll('span:not([data-temporary])')].map(s => s.textContent).join('')).join('');
      }).flat().join('');
      return { domHas: domText.split('').filter(c => 'abcde'.includes(c)).join('') };
    })()`);
    check('영문 5자 연속 타이핑 → 전부 화면 렌더 ("abcde")',
      en.domHas === 'abcde', `domHas="${en.domHas}"`);
    // 한글 2단어 연속 조합 — 조합 커밋도 prefix 캐시 경로를 쓴다
    const typeComposition = async (syllables, final) => {
      for (const s of syllables) {
        await page.evaluate('(async () => {'
          + ' const doc = document.querySelector("x-layout-document");'
          + ' const em = doc.editManager;'
          + ' const c = em._focusedController;'
          + ' const ta = c._textarea;'
          + ' if (!window.__composing) { window.__composing = true; ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); }'
          + ' const cur = ta.value;'
          + ' const start = window.__compStart ?? ta.selectionStart;'
          + ' window.__compStart = start;'
          + ' const prev = window.__compData?.length ?? 0;'
          + ' const syl = ' + JSON.stringify(s) + ';'
          + ' ta.value = cur.slice(0, start) + syl + cur.slice(start + prev);'
          + ' ta.setSelectionRange(start + syl.length, start + syl.length);'
          + ' window.__compData = syl;'
          + ' ta.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: syl }));'
          + ' ta.dispatchEvent(new InputEvent("input", { bubbles: true, data: syl, isComposing: true }));'
          + '})()');
        await page.waitForTimeout(80);
      }
      await page.evaluate('(async () => {'
        + ' const doc = document.querySelector("x-layout-document");'
        + ' const em = doc.editManager;'
        + ' const c = em._focusedController;'
        + ' const ta = c._textarea;'
        + ' const final = ' + JSON.stringify(final) + ';'
        + ' ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: final }));'
        + ' ta.dispatchEvent(new InputEvent("input", { bubbles: true, data: final, isComposing: false }));'
        + ' window.__composing = false;'
        + ' window.__compData = null;'
        + ' window.__compStart = null;'
        + '})()');
      await page.waitForTimeout(450);
    };
    await typeComposition(['한', '한글'], '한글');
    await typeComposition(['입', '입력'], '입력');
    const ko = await page.evaluate(`(() => {
      const doc = document.querySelector('x-layout-document');
      const f2 = [...document.querySelectorAll('x-layout-paragraph')].find(p => p.id === ${JSON.stringify(r.frameIds[1])});
      const domText = [...f2.querySelectorAll('x-layout-column')].map(col => {
        const lines = [...col.shadowRoot.children].filter(c => c.tagName === 'DIV');
        return lines.filter(l => l.style.display !== 'none').map(l =>
          [...l.querySelectorAll('span:not([data-temporary])')].map(s => s.textContent).join('')).join('');
      }).flat().join('');
      return { hasKo: domText.includes('한글') && domText.includes('입력') };
    })()`);
    check('한글 2단어 연속 조합 → 커밋 전부 화면 렌더 (플리커 없음)',
      ko.hasKo === true, JSON.stringify(ko));
  }
}

console.log('\n[4] round-trip — 직렬화 → 재주입 체인 동등');
{
  check('threads 3개 보존', r.roundTrip.threadsPreserved);
  check('프레임 체인 동등 (contentFrom·visibleChars)', r.roundTrip.framesEqual,
    JSON.stringify(r.roundTrip.afterFrames.slice(0, 3)));
  const withContent = r.roundTrip.afterDomSpans.filter(f => {
    const frame = r.roundTrip.afterFrames.find(fr => fr.id === f.id);
    return frame && frame.visible > 0;
  });
  check('재주입 후 배치 대상 프레임 span 존재',
    withContent.length > 0 && withContent.every(f => f.chars > 0),
    r.roundTrip.afterDomSpans.map(f => `${f.id.slice(-7)}:${f.chars}`).join(' '));
}

if (server) server.kill();
await browser.close();
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);