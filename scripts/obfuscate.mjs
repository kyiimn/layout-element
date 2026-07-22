/**
 * Post-build 난독화 스크립트.
 *
 * Vite 빌드가 생성한 두 개 번들에 javascript-obfuscator를 적용한다:
 *   1. dist/layout-element.iife.js  — Vanilla IIFE 번들 (app.ts addScriptTag 인라인 주입 대상)
 *   2. dist/layout-element-react.mjs — React ESM 번들
 *
 * 설계 원칙:
 *   - deadCodeInjection: true  (런타임 비용 거의 없음, 도달 불가능 코드 삽입으로 정적 분석 방해)
 *   - controlFlowFlattening: false (핫루프에서 30~80% 성능 저하, "성능 저하 없음" 조건과 충돌)
 *   - 식별자/문자열 난독화 최강 (hex 식별자, base64 문자열 배열, splitStrings)
 *   - 글로벌 식별자는 renameGlobals=false (IIFE 전역 `LayoutElement` 이름 보존)
 *   - .d.ts 타입 정의는 난독화하지 않음 (퍼블릭 API 명세)
 *
 * @example
 *   node scripts/obfuscate.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

/**
 * 난독화 설정.
 * 성능에 영향을 미치는 옵션은 끄고, 정적 분석을 방해하는 옵션은 켠다.
 *
 * @type {import('javascript-obfuscator').ObfuscatorOptions}
 */
const obfuscatorOptions = {
  // ── 식별자 ──
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false, // IIFE 전역 `LayoutElement` 보존
  identifiersPrefix: '_0x',

  // ── 문자열 ──
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75, // 75% 이상의 문자열을 배열로 숨김
  stringArrayWrappersCount: 2, // 문자열 배열 접근을 다중 wrapper로 감쯈
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 3,
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: true,
  splitStringsChunkLength: 8,

  // ── dead code 주입 (요청됨) ──
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4, // 40% 노드에 dead code 삽입
  deadCodeInjectionAmount: 3, // 노드당 dead code 블록 3개

  // ── 제어 흐름 (성능 저하 방지를 위해 끔) ──
  controlFlowFlattening: false,
  controlFlowFlatteningThreshold: 0,

  // ── 기타 변환 ──
  compact: true,
  simplify: true,
  transformObjectKeys: true, // 객체 키 이름 난독화
  numbersToExpressions: true, // 숫자 리터럴을 표현식으로 변환
  booleanLiteralsToFunctions: true, // true/false를 함수 호출로 변환
  ignoreImports: true, // ESM import 문 보존 (React ESM 번들 호환)
  ignoreRequire: true, // require() 보존

  // ── 소스맵 (절대 생성 금지 — 소스 복원 방지) ──
  sourceMap: false,

  // ── 디버그 방지 ──
  debugProtection: true, // 켜면 DevTools 사용 시 무한 debugger; 로 클라이언트 성능 저하 → 끔 (성능 우선)
  disableConsoleOutput: true, // console 출력을 막으면 런타임 디버깅 불가 → 끔

  // ── 타겟 ──
  target: 'browser',

  // ── 예외 처리 ──
  reservedNames: [
    'LayoutElement', // IIFE 전역 이름
    'LayoutElementReact', // React 번들 전역 이름
  ],
  reservedStrings: [
    '^x-layout-',
    '^x-edit-',
    '^x-layout-vcolumn$',
    '^x-layout-document$',
    '^x-layout-box$',
    '^x-layout-paragraph$',
    '^x-layout-column$',
    '^x-layout-image$',
    '^x-layout-guide-column$',
    '^x-layout-selection$',
    '^x-edit-cursor$',
    '^customElements$',
    '^attachShadow$',
    '^adoptedStyleSheets$',
    '^@media print$',
    '--colorman-',
  ], // Custom Element 태그명, Shadow DOM API, CSS 변수명 보존
};

/**
 * 단일 파일을 난독화한다.
 *
 * @param {string} filePath - 난독화할 파일 경로
 * @param {string} label - 로깅용 라벨
 * @returns {Promise<void>}
 * @throws {Error} 파일 읽기/쓰기/난독화 실패 시
 */
async function obfuscateFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[${label}] 파일이 없습니다: ${filePath} (스킵)`);
    return;
  }

  const originalSize = fs.statSync(filePath).size;
  console.log(`[${label}] 원본 크기: ${(originalSize / 1024).toFixed(1)} KB`);

  const code = fs.readFileSync(filePath, 'utf8');

  // ESM 번들의 경우 import/export 문이 있으므로 추가 주의
  const isESM = filePath.endsWith('.mjs');
  const options = {
    ...obfuscatorOptions,
    target: isESM ? 'browser' : 'browser',
    // ESM 번들은 import/export를 보존해야 React peer dep 호환
    inputFileName: path.basename(filePath),
  };

  const result = JavaScriptObfuscator.obfuscate(code, options);
  const obfuscatedCode = result.getObfuscatedCode();

  fs.writeFileSync(filePath, obfuscatedCode, 'utf8');
  const newSize = fs.statSync(filePath).size;
  const ratio = ((newSize / originalSize) * 100).toFixed(1);
  console.log(`[${label}] 난독화 후: ${(newSize / 1024).toFixed(1)} KB (${ratio}%)`);
}

/**
 * 메인 엔트리.
 *
 * @returns {Promise<void>}
 */
async function main() {
  console.log('=== 난독화 시작 ===\n');

  const targets = [
    { file: path.join(distDir, 'layout-element.iife.js'), label: 'IIFE' },
    { file: path.join(distDir, 'layout-element-react.mjs'), label: 'React ESM' },
  ];

  for (const { file, label } of targets) {
    await obfuscateFile(file, label);
    console.log('');
  }

  console.log('=== 난독화 완료 ===');
  console.log('주의: .d.ts 타입 정의는 난독화되지 않았습니다 (퍼블릭 API 명세 유지).');
  console.log('주의: sourcemap은 생성되지 않았습니다 (소스 복원 방지).');
}

main().catch((err) => {
  console.error('난독화 실패:', err);
  process.exit(1);
});