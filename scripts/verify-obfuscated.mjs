/**
 * 난독화된 IIFE 번들의 구조적 무결성 검증.
 * Node vm 컨텍스트에서 번들을 실행하여:
 *   1. 문법 오류 없이 파싱/실행되는지
 *   2. LayoutElement 전역 객체가 노출되는지
 *   3. 핵심 프로퍼티들이 존재하는지
 *
 * 주의: Custom Elements, canvas 등 DOM API는 헤드리스 Chromium이 필요하므로
 * 여기서는 번들의 "로딩" 단계만 검증한다. 실제 렌더링은 app.ts로 검증.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iifePath = path.resolve(__dirname, '..', 'dist', 'layout-element.iife.js');

const code = fs.readFileSync(iifePath, 'utf8');

// IIFE는 (function(){...})({}) 형태. 전역에 LayoutElement를 할당하므로
// 컨텍스트에 빈 window/global을 만들고 실행.
// Custom Elements는 HTMLElement를 상속하므로 stub이 필요.
class HTMLElementStub {}
class HTMLCanvasElementStub {
  constructor() { this.width = 100; this.height = 100; }
  getContext() {
    return {
      measureText: () => ({ width: 10 }),
      getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
      drawImage: () => {},
      font: '',
    };
  }
}
class HTMLDivElementStub {}
class HTMLSpanElementStub {}
class ShadowRootStub {}

const sandbox = {
  window: {},
  self: {},
  globalThis: {},
  console,
  // Custom Elements API stubs
  customElements: { define: () => {} },
  // DOM globals needed by class definitions
  HTMLElement: HTMLElementStub,
  HTMLCanvasElement: HTMLCanvasElementStub,
  HTMLDivElement: HTMLDivElementStub,
  HTMLSpanElement: HTMLSpanElementStub,
  ShadowRoot: ShadowRootStub,
  Event: class { constructor(t, o) { this.type = t; Object.assign(this, o); } preventDefault(){} stopPropagation(){} },
  CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
  MutationObserver: class { constructor(){} observe(){} disconnect(){} },
  ResizeObserver: class { constructor(){} observe(){} disconnect(){} },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  Image: class { constructor(){} },
  document: {
    createElement: (tag) => {
      const el = new HTMLElementStub();
      el.tagName = tag;
      el.style = {};
      el.dataset = {};
      el.getBoundingClientRect = () => ({ left:0, top:0, right:100, bottom:100, width:100, height:100 });
      el.appendChild = () => {};
      el.removeChild = () => {};
      el.remove = () => {};
      el.getContext = HTMLCanvasElementStub.prototype.getContext;
      return el;
    },
    styleSheets: [],
    addEventListener: () => {},
    removeEventListener: () => {},
    fonts: { ready: Promise.resolve() },
  },
  navigator: {},
  window: undefined, // will be set below
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);

try {
  vm.runInContext(code, ctx, { filename: 'layout-element.iife.js' });
  console.log('✓ 번들 실행 성공 (문법 오류 없음)');

  const LayoutElement = ctx.LayoutElement;
  if (!LayoutElement) {
    console.error('✗ LayoutElement 전역 객체가 노출되지 않음');
    process.exit(1);
  }
  console.log('✓ LayoutElement 전역 객체 노출됨');
  console.log('  LayoutElement keys:', Object.keys(LayoutElement).slice(0, 20).join(', '));

  // 핵심 프로퍼티 존재 확인
  // 참고: 과거 심볼 GridCalculator/TextLayoutEngine은 각각
  // GridCalculatorEngine/ParagraphEngine으로 개명되어 engine 레이어로 이동했다.
  const expected = [
    'LayoutDocumentElement', 'LayoutBoxElement', 'LayoutParagraphElement',
    'LayoutImageElement', 'LayoutTableElement',
    'GridCalculatorEngine', 'ParagraphEngine', 'DocumentEngine',
    'ColorRegistry', 'FontLoader', 'EditManager',
  ];
  let missing = [];
  for (const name of expected) {
    if (!(name in LayoutElement)) missing.push(name);
  }
  if (missing.length > 0) {
    console.error('✗ 누락된 프로퍼티:', missing.join(', '));
    process.exit(1);
  }
  console.log(`✓ 핵심 프로퍼티 ${expected.length}개 모두 존재`);
  console.log('\n=== 번들 무결성 검증 통과 ===');
} catch (err) {
  console.error('✗ 번들 실행 실패:', err.message);
  console.error(err.stack);
  process.exit(1);
}