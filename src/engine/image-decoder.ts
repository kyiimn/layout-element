/**
 * Node.js 환경에서 base64 data URI를 RGBA 픽셀 데이터로 디코딩하는 유틸리티.
 *
 * @file src/engine/image-decoder.ts
 */

import type { RgbaData } from "./image-engine";

interface PngJsModule {
  PNG: {
    sync: {
      read(input: Buffer): { data: Buffer; width: number; height: number };
    };
  };
}

let _pngjs: PngJsModule | null = null;
let _syncRequireTried = false;

export function isNodeJs(): boolean {
  return typeof globalThis !== 'undefined'
    && typeof (globalThis as { window?: unknown }).window === 'undefined'
    && typeof (globalThis as { Buffer?: unknown }).Buffer !== 'undefined';
}

export function parseDataUri(url: string): { mime: string; base64: string } | null {
  if (!url.startsWith('data:')) return null;
  const commaIdx = url.indexOf(',');
  if (commaIdx < 0) return null;
  const header = url.substring(5, commaIdx);
  const base64 = url.substring(commaIdx + 1);
  const semiIdx = header.indexOf(';');
  const mime = semiIdx >= 0 ? header.substring(0, semiIdx) : header;
  if (!mime.startsWith('image/')) return null;
  return { mime, base64 };
}

function decodeBase64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

function tryGetPngJsSync(): PngJsModule | null {
  if (_pngjs) return _pngjs;
  if (_syncRequireTried) return null;
  _syncRequireTried = true;

  if (!isNodeJs()) return null;

  const g = globalThis as { require?: (id: string) => unknown };
  if (typeof g.require !== 'function') return null;

  try {
    _pngjs = g.require('pngjs') as PngJsModule;
    return _pngjs;
  } catch {
    return null;
  }
}

async function ensurePngJsAsync(): Promise<PngJsModule | null> {
  if (_pngjs) return _pngjs;
  if (!isNodeJs()) return null;

  const sync = tryGetPngJsSync();
  if (sync) return sync;

  // ESM / tsx ESM / 번들된 ESM 환경: module.createRequire 사용
  try {
    const moduleMod = await import("module");
    if (typeof moduleMod.createRequire === 'function') {
      let reqUrl: string;
      try { reqUrl = import.meta.url; } catch { reqUrl = ''; }
      if (!reqUrl) {
        const g = globalThis as { __filename?: string };
        const proc = (process as { cwd?: () => string });
        const cwd = typeof proc.cwd === 'function' ? proc.cwd() : '/';
        reqUrl = g.__filename ?? ('file://' + cwd + '/');
      }
      const requireFn = moduleMod.createRequire(reqUrl);
      _pngjs = requireFn('pngjs') as PngJsModule;
      return _pngjs;
    }
  } catch { /* fallback below */ }

  // Fallback: dynamic import
  try {
    const mod = await import("pngjs");
    _pngjs = mod as unknown as PngJsModule;
    return _pngjs;
  } catch {
    return null;
  }
}

export async function prepareImageDecoder(): Promise<boolean> {
  const mod = await ensurePngJsAsync();
  return mod !== null;
}

export function decodeBase64ImageToRgbaSync(url: string): RgbaData | null {
  if (!isNodeJs()) return null;
  const parsed = parseDataUri(url);
  if (!parsed) return null;

  const pngjs = tryGetPngJsSync();
  if (!pngjs) return null;

  try {
    const buffer = decodeBase64ToBuffer(parsed.base64);
    const result = pngjs.PNG.sync.read(buffer);
    return {
      data: new Uint8Array(result.data),
      width: result.width,
      height: result.height,
    };
  } catch {
    return null;
  }
}

export async function decodeBase64ImageToRgba(url: string): Promise<RgbaData | null> {
  if (!isNodeJs()) return null;
  const parsed = parseDataUri(url);
  if (!parsed) return null;

  const pngjs = await ensurePngJsAsync();
  if (!pngjs) return null;

  try {
    const buffer = decodeBase64ToBuffer(parsed.base64);
    const result = pngjs.PNG.sync.read(buffer);
    return {
      data: new Uint8Array(result.data),
      width: result.width,
      height: result.height,
    };
  } catch {
    return null;
  }
}