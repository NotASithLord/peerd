// @ts-check
import { immutableAppRoot } from '/shared/address/immutable-app-root.js';
import { prepareAppBundle } from './loader.js';

/**
 * Fetch and validate a root address without publishing or installing it.
 * @param {{address:string, fetchApp:(uri:string)=>Promise<{manifest:any,payload:Uint8Array}>}} opts
 */
export const fetchImmutableApp = async ({ address, fetchApp }) => {
  const target = immutableAppRoot(address);
  const { manifest, payload } = await fetchApp(target.uri);
  const app = await prepareAppBundle({ uri: target.uri, manifest, payload });
  return { target, manifest, payload, app };
};

/** @param {Awaited<ReturnType<typeof fetchImmutableApp>>} verified */
export const immutableAppSummary = ({ target, manifest, app }) => ({
  ...target,
  // why: display only signed metadata, never a caller-supplied discovery label.
  name: typeof manifest.meta?.name === 'string' && manifest.meta?.name.trim() ? manifest.meta?.name.slice(0, 200) : null,
  type: 'app',
  entryFile: app.entryFile,
  decodedBytes: Object.values(app.files).reduce((sum, bytes) => sum + bytes.byteLength, 0),
  fileCount: Object.keys(app.files).length,
  containsWasm: Object.keys(app.files).some(path => path.endsWith('.wasm')),
});
