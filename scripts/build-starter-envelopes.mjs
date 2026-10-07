// Run with Bun's extension import resolver: bun --preload ./tests/setup.ts scripts/build-starter-envelopes.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { buildAppExport } from '../extension/peerd-engine/export.js';
import { packagedStarter, starterKeys } from '../extension/shared/starter-catalog.js';
const root = new URL('../extension/peerd-engine/starters/', import.meta.url);
export async function starterEnvelope(key) {
  const names = key === 'wasm-image' ? ['index.html', 'app.js', 'filter.wasm', 'filter.wat'] : ['index.html', 'app.js'];
  const files = Object.fromEntries(await Promise.all(names.map(async path => [path, new Uint8Array(await readFile(new URL(`${key}/${path}`, root)))])));
  const envelope = await buildAppExport({ record: { name: packagedStarter(key).name, entryFile: 'index.html', fileKinds: key === 'wasm-image' ? { 'filter.wasm': 'binary' } : {} }, files });
  // Packaged unsigned examples use a reproducible epoch, not a publication date.
  envelope.manifest.created = 0;
  return envelope;
}

if (import.meta.main) for (const key of starterKeys) await writeFile(new URL(`${key}.peerd`, root), JSON.stringify(await starterEnvelope(key)) + '\n');
