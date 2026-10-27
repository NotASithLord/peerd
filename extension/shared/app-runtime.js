// @ts-check
import { AppRuntimeError, normalizeAppRuntime } from './app-runtime-contract.js';
export { AppRuntimeError, normalizeAppRuntime } from './app-runtime-contract.js';

// why: compilation checks this realm's engine and CSP, not merely the presence
// of the WebAssembly namespace. The runner repeats this before any App code.
/** @param {typeof WebAssembly | undefined} [wasm] @returns {string[]} */
export const probeAppRuntime = (wasm = globalThis.WebAssembly) => {
  try {
    if (!wasm) return [];
    new wasm.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]));
    const features = ['wasm-core'];
    try {
      // (module (func (drop (v128.const i32x4 0 0 0 0))))
      // Compilation tests the engine and this realm's CSP without granting
      // threads, shared memory, or any host imports to the App.
      new wasm.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 23, 1, 21, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 11]));
      features.push('wasm-simd');
    } catch { /* core-only engines remain supported */ }
    return features;
  } catch { return []; }
};

/** @type {string[] | undefined} */
let hostFeatures;

/** @param {unknown} value @param {readonly string[]} [supported] */
export const appRuntimeVerdict = (value, supported) => {
  const runtime = normalizeAppRuntime(value);
  if (!runtime) return { status: 'unspecified', message: 'Runtime requirements not specified.', missing: [] };
  if (runtime.schema !== 1) return { status: 'unsupported', message: `Unsupported App runtime schema: ${runtime.schema}.`, missing: [] };
  if (runtime.target !== 'browser-app') return { status: 'unsupported', message: `Unsupported App runtime target: ${runtime.target}. Only browser Apps are supported.`, missing: [] };
  // The host realm and its CSP are stable; catalog polling must not compile a
  // probe per card. Actual runner features are always supplied explicitly.
  const available = supported ?? (hostFeatures ??= probeAppRuntime());
  const missing = runtime.requires.filter((feature) => !available.includes(feature));
  return missing.length
    ? { status: 'unsupported', message: `Required runtime features unavailable: ${missing.join(', ')}.`, missing }
    : { status: 'supported', message: 'Declared runtime requirements are available; the App runner checks again before execution.', missing };
};

/** @param {unknown} value @param {readonly string[]} [supported] */
export const assertAppRuntime = (value, supported) => {
  const verdict = appRuntimeVerdict(value, supported);
  if (verdict.status === 'unsupported') throw new AppRuntimeError(verdict.message, 'app-runtime-unsupported');
  return normalizeAppRuntime(value);
};

/** @param {Record<string,string|Uint8Array>} files */
export const appRuntimeFromFiles = (files) => {
  if (!Object.hasOwn(files, 'peerd.json')) return undefined;
  const raw = files['peerd.json'];
  let text;
  try { text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { throw new AppRuntimeError('peerd.json is not valid UTF-8.'); }
  // Existing declarations contain actor instructions; bound the descriptor
  // without applying the much smaller runtime-field limit to unrelated fields.
  if (text.length > 32_768) throw new AppRuntimeError('peerd.json exceeds the runtime descriptor limit.');
  let declaration;
  try { declaration = JSON.parse(text); }
  catch { throw new AppRuntimeError('peerd.json is not valid JSON.'); }
  return normalizeAppRuntime(declaration?.runtime);
};

/** @param {unknown} expected @param {unknown} actual */
export const assertAppRuntimeAgreement = (expected, actual) => {
  if (JSON.stringify(normalizeAppRuntime(expected)) !== JSON.stringify(normalizeAppRuntime(actual))) {
    throw new AppRuntimeError('App runtime requirements do not match the signed version.', 'app-runtime-mismatch');
  }
};
