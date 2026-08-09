// @ts-check
// Links a resolved Notebook graph into one module Worker entry.
//
// Firefox extension Workers can import packaged modules, but not generated
// child module URLs. The normal resolver remains the policy and IO boundary.
// This linker only sees the already-resolved in-memory sources and emits one
// root module. It has no filesystem or network fallback.

import { ModuleLinkError } from './errors.js';
import { inspectModuleLoads } from './module-import-policy.js';

const ENTRY_ID = '\0peerd:notebook-entry';

/**
 * @param {LinkerInput} input
 */
const loadRollup = async (input) => {
  // why lazy: the engine index is shared by every execution surface. Only
  // Firefox Notebooks should pay the parse and WASM startup cost of the linker.
  const rollupUrl = new URL('../vendor/rollup/rollup.browser.js', import.meta.url).href;
  const { rollup } = await import(rollupUrl);
  return rollup(input);
};

/**
 * @typedef {{
 *   input: string,
 *   treeshake: boolean,
 *   plugins: Array<{
 *     name: string,
 *     resolveId: (source: string, importer?: string) => string | { id: string, external: true },
 *     load: (id: string) => string | Promise<string>,
 *     transform?: (code: string, id: string) => { code: string, map: null } | null,
 *     resolveImportMeta?: (property: string | null, context: { moduleId: string }) => string | null,
 *   }>,
 * }} LinkerInput
 */

/**
 * @param {string} source complete worker entry source
 * @param {Map<string, { blobUrl: string, source: string }>} cache resolved graph
 * @param {readonly string[]} packagedEntryUrls exact packaged module URLs; seal first
 * @param {(input: LinkerInput) => Promise<{ generate: (options: object) => Promise<{ output: Array<any> }>, close: () => Promise<void> }>} [rollupImpl]
 * @param {(url: string) => Promise<string>} [readPackagedModule]
 * @param {number} [entryBodyLine]
 * @returns {Promise<{ source: string, markerNonce: string }>}
 */
export const linkSingleModuleWorkerDetailed = async (
  source, cache, packagedEntryUrls, rollupImpl = /** @type {any} */ (loadRollup),
  readPackagedModule = async (url) => {
    // why bare fetch is safe here: `url` is either an exact trusted entry or a
    // same-extension relative dependency admitted by the virtual loader. User
    // and remote specifiers never reach this branch; the response is packaged
    // extension code, not egress.
    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(url);
    if (!response.ok) throw new ModuleLinkError(`cannot read packaged module '${url}'`);
    return response.text();
  }, entryBodyLine,
) => {
  const sealUrl = packagedEntryUrls[0];
  if (!sealUrl) throw new ModuleLinkError('the realm seal URL is missing');
  const packagedEntries = new Set(packagedEntryUrls);
  const packagedRoot = new URL('/', sealUrl).href;
  const markerNonce = crypto.randomUUID();
  /**
   * @param {'module' | 'body'} kind
   * @param {string} name
   */
  const marker = (kind, name) =>
    `/*__peerd_module:${markerNonce}:${kind}:${encodeURIComponent(name)}__*/`;
  const sources = new Map([[ENTRY_ID, source]]);
  const sourceNames = new Map([[ENTRY_ID, 'notebook.js']]);
  for (const [path, entry] of cache) {
    if (sources.has(entry.blobUrl)) {
      throw new ModuleLinkError(`duplicate generated module URL for ${path}`);
    }
    sources.set(entry.blobUrl, entry.source);
    sourceNames.set(entry.blobUrl, path.startsWith('http') ? path : `./${path}`);
  }

  let bundle;
  try {
    bundle = await rollupImpl({
      input: ENTRY_ID,
      // why false: provenance is a security input. An apparently unused remote
      // edge still makes the whole run compute-only and must not disappear as a
      // side effect of optimization.
      treeshake: false,
      plugins: [{
        name: 'peerd-notebook-virtual-graph',
        resolveId: (specifier, importer) => {
          if (sources.has(specifier)) return specifier;
          if (packagedEntries.has(specifier)) return specifier;
          if (importer?.startsWith(packagedRoot)) {
            const resolved = new URL(specifier, importer).href;
            if (resolved.startsWith(packagedRoot)) return resolved;
          }
          throw new ModuleLinkError(`unresolved static import '${specifier}'`);
        },
        load: async (id) => {
          const loaded = sources.get(id);
          if (loaded !== undefined) return loaded;
          if (id.startsWith(packagedRoot)) {
            sourceNames.set(id, new URL(id).pathname);
            return readPackagedModule(id);
          }
          throw new ModuleLinkError(`module '${id}' is outside the resolved graph`);
        },
        transform: (code, id) => {
          const name = sourceNames.get(id);
          if (!name) return null;
          let marked = `${marker('module', name)}\n${code}`;
          const bodyLine = Number.isInteger(entryBodyLine) ? Number(entryBodyLine) : null;
          if (id === ENTRY_ID && bodyLine !== null && bodyLine > 0) {
            const lines = marked.split('\n');
            lines.splice(bodyLine, 0, marker('body', name));
            marked = lines.join('\n');
          }
          return { code: marked, map: null };
        },
        resolveImportMeta: (property, { moduleId }) => {
          const url = sourceNames.get(moduleId) ?? 'notebook.js';
          if (property === 'url') return JSON.stringify(url);
          if (property === null) return `Object.freeze({ url: ${JSON.stringify(url)} })`;
          return null;
        },
      }],
    });
    const generated = await bundle.generate({ format: 'es', sourcemap: false });
    const chunks = generated.output.filter((item) => item.type === 'chunk');
    if (chunks.length !== 1) throw new ModuleLinkError(`linker emitted ${chunks.length} worker chunks`);
    const linked = String(chunks[0].code);
    const loads = inspectModuleLoads(linked);
    if (loads.length > 0) {
      throw new ModuleLinkError('the linked worker retained a child module edge');
    }
    const sealCall = linked.indexOf('applyRealmSeal(globalThis)');
    const workerBody = linked.indexOf('const NOTEBOOK_ID');
    if (sealCall < 0 || workerBody < 0 || sealCall > workerBody) {
      throw new ModuleLinkError('the linked worker does not apply the realm seal first');
    }
    // The generated graph has no module edges left. Firefox runs it as a blob
    // module Worker inside the opaque sandbox host, avoiding the privileged
    // extension module-worker loader while preserving top-level ESM syntax.
    return { source: `'use strict';\n${linked}`, markerNonce };
  } catch (error) {
    if (error instanceof ModuleLinkError) throw error;
    let detail = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    // Generated URLs are host plumbing. Keep errors actionable for both the
    // person and the model by translating them back to source-facing names.
    for (const [id, name] of sourceNames) detail = detail.replaceAll(id, name);
    throw new ModuleLinkError(detail);
  } finally {
    await bundle?.close();
  }
};

/**
 * Compatibility wrapper for hosts and tests that need only the linked source.
 * @param {string} source
 * @param {Map<string, { blobUrl: string, source: string }>} cache
 * @param {readonly string[]} packagedEntryUrls
 * @param {any} [rollupImpl]
 * @param {(url: string) => Promise<string>} [readPackagedModule]
 * @param {number} [entryBodyLine]
 */
export const linkSingleModuleWorker = async (
  source, cache, packagedEntryUrls, rollupImpl, readPackagedModule, entryBodyLine,
) => (await linkSingleModuleWorkerDetailed(
  source, cache, packagedEntryUrls, rollupImpl, readPackagedModule, entryBodyLine,
)).source;
