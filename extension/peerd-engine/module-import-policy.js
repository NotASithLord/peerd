// @ts-check
// Fail-closed import syntax preflight for packages that do not permit remote
// modules. A grammar-correct parser is the security boundary here. Handwritten
// token scanners cannot reliably distinguish regexes, division, methods, and
// import expressions across all valid JavaScript.

import { Parser } from '/vendor/acorn/acorn.mjs';
import {
  ModuleSyntaxError,
  RemoteModuleImportsUnavailableError,
  UnsupportedNativeModuleImportError,
} from './errors.js';

const ALLOWED_PEERD_MODULES = new Set(['peerd:std', 'peerd:wasi']);

/**
 * Apply the string cleanup required before URL parsing. The canonicalizer
 * below delegates special-scheme slash and query behavior to the platform URL
 * parser so the resolver fetches the same URL the native loader would parse.
 * @param {string} specifier
 */
export const normalizeModuleSpecifier = (specifier) => specifier
  .replace(/[\t\n\r]/g, '')
  .replace(/^[\u0000-\u0020]+/, '');

/** @param {string} specifier */
export const canonicalModuleSpecifier = (specifier) => {
  const normalized = normalizeModuleSpecifier(specifier);
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch { /* local and bare specifiers are not absolute URLs */ }
  // Scheme-relative special URLs also treat backslashes as path separators.
  // Only canonicalize the authority/path portion so query bytes stay intact.
  const boundary = normalized.search(/[?#]/);
  const prefix = boundary < 0 ? normalized : normalized.slice(0, boundary);
  const suffix = boundary < 0 ? '' : normalized.slice(boundary);
  return /^[\\/]{2}/.test(prefix) ? `${prefix.replace(/\\/g, '/')}${suffix}` : normalized;
};

/** @param {string} specifier */
export const isRemoteModuleSpecifier = (specifier) =>
  /^https?:/i.test(canonicalModuleSpecifier(specifier));

/** @param {string} specifier */
const isAllowedLocalSpecifier = (specifier) => {
  if (ALLOWED_PEERD_MODULES.has(specifier)) return true;
  const normalized = canonicalModuleSpecifier(specifier);
  if (normalized.startsWith('./') || normalized.startsWith('../')) return true;
  // A plain bare name is left to the static native loader. Known builtins are
  // rewritten by the resolver before that point.
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
    && !normalized.startsWith('/')
    && !normalized.startsWith('\\');
};

/** @param {unknown} node */
const literalString = (node) => {
  const candidate = /** @type {{ type?: string, value?: unknown }} */ (node);
  return candidate?.type === 'Literal' && typeof candidate.value === 'string'
    ? candidate.value
    : null;
};

/**
 * @param {string} source
 * @param {{ allowReturnOutsideFunction?: boolean }} [options]
 * @returns {Array<{
 *   kind: 'static' | 'dynamic', specifier: string | null, hasOptions: boolean,
 *   start: number, end: number, specifierStart: number, specifierEnd: number,
 * }>}
 */
export const inspectModuleLoads = (source, { allowReturnOutsideFunction = false } = {}) => {
  let root;
  try {
    root = /** @type {Record<string, unknown>} */ (Parser.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction,
    }));
  } catch (error) {
    throw new ModuleSyntaxError(
      /** @type {{ message?: string }} */ (error)?.message ?? String(error),
    );
  }
  /** @type {Array<Record<string, unknown>>} */
  const pending = [root];
  /** @type {Array<{
   *   kind: 'static' | 'dynamic', specifier: string | null, hasOptions: boolean,
   *   start: number, end: number, specifierStart: number, specifierEnd: number,
   * }>} */
  const loads = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.type === 'ImportExpression') {
      const sourceNode = /** @type {Record<string, unknown>} */ (node.source);
      loads.push({
        kind: 'dynamic',
        specifier: literalString(sourceNode),
        hasOptions: node.options !== null && node.options !== undefined,
        start: /** @type {number} */ (node.start),
        end: /** @type {number} */ (node.end),
        specifierStart: /** @type {number} */ (sourceNode.start),
        specifierEnd: /** @type {number} */ (sourceNode.end),
      });
    } else if (node.type === 'ImportDeclaration'
      || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration') {
      const sourceNode = /** @type {Record<string, unknown>} */ (node.source);
      const specifier = literalString(sourceNode);
      if (specifier !== null) {
        const attributes = Array.isArray(node.attributes) ? node.attributes : node.assertions;
        loads.push({
          kind: 'static', specifier, hasOptions: Array.isArray(attributes) && attributes.length > 0,
          start: /** @type {number} */ (node.start),
          end: /** @type {number} */ (node.end),
          specifierStart: /** @type {number} */ (sourceNode.start),
          specifierEnd: /** @type {number} */ (sourceNode.end),
        });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object') {
            pending.push(/** @type {Record<string, unknown>} */ (child));
          }
        }
      } else if (value && typeof value === 'object') {
        pending.push(/** @type {Record<string, unknown>} */ (value));
      }
    }
  }
  return loads.sort((a, b) => a.start - b.start);
};

/**
 * Reject native module loads the resolver cannot safely route. Import options
 * and every dynamic import are refused in every channel. Packaged MV3 workers
 * cannot complete the dynamic blob-import hop, so accepting the syntax would
 * defer a deterministic failure into the worker. Store and web also refuse
 * literal external specifiers. Supported literal static imports continue
 * normally.
 * @param {string} source
 * @param {boolean | undefined} remoteModulesEnabled
 * @param {{ allowReturnOutsideFunction?: boolean }} [options]
 */
export const assertRemoteModulePolicy = (source, remoteModulesEnabled, options) => {
  for (const load of inspectModuleLoads(source, options)) {
    if (load.hasOptions || load.kind === 'dynamic') {
      throw new UnsupportedNativeModuleImportError();
    }
    const specifier = /** @type {string} */ (load.specifier);
    if (isAllowedLocalSpecifier(specifier)) continue;
    if (isRemoteModuleSpecifier(specifier)) {
      if (remoteModulesEnabled === true) continue;
      throw new RemoteModuleImportsUnavailableError(specifier);
    }
    // The resolver only routes local paths, builtins, and
    // audited HTTP(S). Every other scheme or absolute path would reach the
    // native loader directly.
    throw new UnsupportedNativeModuleImportError();
  }
};
