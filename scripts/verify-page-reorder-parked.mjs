// verify-page-reorder-parked.mjs — A-4 결함 회귀 검증
// parked placeholder가 data setter reconcile 순서를 따라가는지 검증한다.
// 결함 재현 (수정 전): pages [A(parked), B, C]에서 데이터 순서 [C, A, B] 주입
// → mounted만 appendChild 재정렬되고 placeholder는 낡은 인덱스에 잔류
// → _collectPagesData(DOM 순서)가 잘못된 순서를 엔진에 주입.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 5206;

function spawnDevServer() {
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: 'pipe',
    detached: true,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server timeout')), 30000);
    child.stdout.on('data', (d) => {
      if (d.toString().includes('Local:')) { clearTimeout(timer); resolve(child); }
    });
  });
}

let server;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

try {
  server = await spawnDevServer();
  await sleep(1200);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/examples/virtualization.html`);
  await sleep(800);

  // 독립 문서 구성 (예제와 분리)
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const doc = document.createElement('x-layout-document');
    doc.data = {
      id: 'reorder-doc',
      width: 190, height: 300, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      pages: [
        { id: 'pg-A', width: 190, height: 100, columns: 1, gap: 0,
          children: [{ type: 'box', id: 'box-A', position: 'absolute', left: 10, top: 5, width: 170, height: 90,
            children: { type: 'paragraph', content: 'A페이지내용입니다가나다라', paragraphStyle: {}, textStyle: {} } }] },
        { id: 'pg-B', width: 190, height: 300, columns: 1, gap: 0,
          children: [{ type: 'box', id: 'box-B', position: 'absolute', left: 10, top: 5, width: 170, height: 90,
            children: { type: 'paragraph', content: 'B페이지내용입니다가나다라', paragraphStyle: {}, textStyle: {} } }] },
        { id: 'pg-C', width: 190, height: 300, columns: 1, gap: 0,
          children: [{ type: 'box', id: 'box-C', position: 'absolute', left: 10, top: 5, width: 170, height: 90,
            children: { type: 'paragraph', content: 'C페이지내용입니다가나다라', paragraphStyle: {}, textStyle: {} } }] },
      ],
    };
    await doc.render();
    await sleep(300);
    doc.parkPage('pg-A');
    // 데이터 순서 [C, A, B] 주입 — A는 parked (placeholder 이동 검증 대상)
    doc.data = {
      id: 'reorder-doc',
      width: 190, height: 300, columns: 1, gap: 0,
      paragraphStyle: { lineGap: 1.2 }, textStyle: { fontSize: 4 },
      pages: [
        { id: 'pg-C', width: 190, height: 300, columns: 1, gap: 0,
          children: [{ type: 'box', id: 'box-C', position: 'absolute', left: 10, top: 5, width: 170, height: 90,
            children: { type: 'paragraph', content: 'C페이지내용입니다가나다라', paragraphStyle: {}, textStyle: {} } }] },
        { id: 'pg-A', width: 190, height: 300, columns: 1, gap: 0,
          children: [{ type: 'box', id: 'box-A', position: 'absolute', left: 10, top: 5, width: 170, height: 90,
            children: { type: 'paragraph', content: 'A페이지내용입니다가나다라', paragraphStyle: {}, textStyle: {} } }] },
        { id: 'pg-B', width: 190, height: 300, columns: 1, gap: 0,
          children: [{ type: 'box', id: 'box-B', position: 'absolute', left: 10, top: 5, width: 170, height: 90,
            children: { type: 'paragraph', content: 'B페이지내용입니다가나다라', paragraphStyle: {}, textStyle: {} } }] },
      ],
    };
    await sleep(500);
    window.__reorderDoc = doc;
  });

  const result = await page.evaluate(async () => {
    const doc = window.__reorderDoc;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 엔진 수집 순서: _rawData().pages는 _collectPagesData(DOM 순서)의 직접 산출
    const collectOrder = (doc._rawData().pages ?? []).map(p => p.id).join(',');
    const domOrder = Array.from(doc.childNodes)
      .map(n => n.getAttribute && n.getAttribute('data-parked-page') ? n.getAttribute('data-parked-page') : n.id)
      .filter(Boolean).join(',');
    // unpark 후 최종 순서
    doc.unparkPage('pg-A');
    await sleep(300);
    const restoredOrder = doc.items.map(b => b.id).join(',');
    const finalCollect = (doc._rawData().pages ?? []).map(p => p.id).join(',');
    return { collectOrder, domOrder, restoredOrder, finalCollect };
  });

  check('A-4: parked 중 데이터 순서 변경 주입 — 엔진 수집 순서 == 데이터 순서',
    result.collectOrder === 'pg-C,pg-A,pg-B', `collect=${result.collectOrder}`);
  check('A-4: DOM 순서도 데이터 순서와 일치 (placeholder 이동)',
    result.domOrder === 'pg-C,pg-A,pg-B', `dom=${result.domOrder}`);
  check('A-4: unpark 후 최종 순서 보존',
    result.restoredOrder === 'pg-C,pg-A,pg-B', `restored=${result.restoredOrder}`);
  check('A-4: unpark 후 엔진 수집 순서 보존',
    result.finalCollect === 'pg-C,pg-A,pg-B', `final=${result.finalCollect}`);

  await browser.close();
} finally {
  if (server) process.kill(-server.pid);
}

console.log(failures === 0 ? 'ALL PASS' : `FAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);