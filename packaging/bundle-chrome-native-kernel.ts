// Chrome MV3 cannot import modules at runtime. Keep source modular, but emit
// one staged kernel file after target pruning, minification, and digest stamp.

import {
  readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  isAbsolute, join, relative, resolve, sep,
} from 'node:path';
import { staticImportSpecifiers } from './static-module-graph.ts';

export const CHROME_NATIVE_KERNEL_ENTRIES = Object.freeze([
  'background/vault-kernel-chrome.js',
  'background/vault-kernel-preview.js',
]);

export const NATIVE_CHROME_BUNDLE_RATCHETS = Object.freeze({
  'background/vault-kernel-chrome.js': Object.freeze({
    // Exact controller/actor lifecycle settlement, isolation admission and
    // stale-generation recovery remain fixed authority work. Tool semantics
    // remain outside this closure. Exact achieved bytes, no headroom.
    // runtime-capability-hosts and semantic-hook-manifest are fixed
    // authority/policy inputs, not controller feature ownership.
    // Source-action child generations are fixed browser custody, not a
    // semantic feature surface.
    bytes: 1_341_048,
    inputs: 400,
    inputSha256: '7b50f453b44f16ac1c81e04c8cfa1de8475ee30934ff9c117158e85f86c264cf',
  }),
  'background/vault-kernel-preview.js': Object.freeze({
    bytes: 1_424_091,
    inputs: 406,
    inputSha256: 'f9ea6444ed31f052cf7f09936b4ecae14276b573b612fb0c981dd11d6c49d5fb',
  }),
});

export const assertNativeChromeBundleRatchet = (
  entryRelative: string,
  result: { bytes: number; inputs: readonly string[]; inputSha256: string },
) => {
  const ratchet = NATIVE_CHROME_BUNDLE_RATCHETS[entryRelative as keyof typeof NATIVE_CHROME_BUNDLE_RATCHETS];
  if (!ratchet) throw new Error(`native Chrome bundle has no ratchet: ${entryRelative}`);
  if (result.inputs.length !== ratchet.inputs || result.inputSha256 !== ratchet.inputSha256) {
    throw new Error(`native Chrome bundle input closure changed for ${entryRelative}: `
      + `${result.bytes} bytes / ${result.inputs.length} inputs / ${result.inputSha256}; expected `
      + `${ratchet.inputs} / ${ratchet.inputSha256}`);
  }
  if (result.bytes > ratchet.bytes) {
    throw new Error(`native Chrome bundle grew to ${result.bytes} bytes; ratchet is ${ratchet.bytes}`);
  }
};

export const NATIVE_CHROME_PRUNED_IMPORTS = Object.freeze([
  './firefox-storage-keepalive.js',
  './repository-local-client.js',
  './direct-actor-host.js',
]);

export const isChromeNativeKernelEntry = (entry: unknown): entry is string =>
  typeof entry === 'string' && CHROME_NATIVE_KERNEL_ENTRIES.includes(entry);

export async function bundleChromeNativeKernel(staging: string, entryRelative: string) {
  if (!isChromeNativeKernelEntry(entryRelative)) {
    throw new Error(`unsupported Chrome native-kernel entry: ${entryRelative}`);
  }
  const entry = join(staging, entryRelative);
  const scratch = join(staging, '.vault-kernel-bundle');
  const stagingRoot = realpathSync(staging);
  rmSync(scratch, { recursive: true, force: true });
  try {
    const buildConfig: Parameters<typeof Bun.build>[0] = {
      entrypoints: [entry],
      outdir: scratch,
      naming: 'vault-kernel.js',
      target: 'browser',
      format: 'esm',
      banner: 'globalThis[Symbol.for("peerd.kernel.bundle-start.v1")]=globalThis.performance?.now?.()??Date.now();',
      minify: { whitespace: true, identifiers: true, syntax: true },
      splitting: false,
      metafile: true,
      plugins: [{
        name: 'fixed-native-bundle-inputs',
        setup(build) {
          build.onResolve({
            filter: /^\.\/.*\.js$/,
          }, (args) => NATIVE_CHROME_PRUNED_IMPORTS.includes(args.path)
            ? { path: args.path, namespace: 'chrome-unreachable-runtime' }
            : undefined);
          build.onLoad({ namespace: 'chrome-unreachable-runtime', filter: /.*/ }, () => ({
            contents: 'export {};\n',
            loader: 'js',
          }));
          build.onResolve({ filter: /^\// }, (args) => {
            if (!args.importer) return undefined;
            const target = resolve(stagingRoot, args.path.slice(1));
            const fromStaging = relative(stagingRoot, target);
            if (fromStaging === '..' || fromStaging.startsWith(`..${sep}`)
                || isAbsolute(fromStaging)) {
              throw new Error(`native Chrome bundle root import escaped staging: ${args.path}`);
            }
            return { path: target };
          });
        },
      }],
    };
    const result = await Bun.build(buildConfig);
    if (!result.success || result.outputs.length !== 1) {
      throw new Error(`native Chrome bundle failed: ${result.logs.join('\n')}`);
    }

    const inputs: string[] = [];
    const leakedInputs: string[] = [];
    const bundledInputs = Object.keys(result.metafile?.inputs ?? {});
    if (bundledInputs.length === 0) throw new Error('native Chrome bundle input ledger missing');
    for (const input of bundledInputs) {
      if (input.startsWith('chrome-unreachable-runtime:')) continue;
      const absolute = realpathSync(resolve(input));
      const fromStaging = relative(stagingRoot, absolute);
      if (fromStaging === '..' || fromStaging.startsWith(`..${sep}`)
          || isAbsolute(fromStaging)) {
        leakedInputs.push(input);
      } else {
        inputs.push(fromStaging.split('\\').join('/'));
      }
    }
    if (leakedInputs.length > 0) {
      throw new Error(`native Chrome bundle input escaped staging: ${leakedInputs.sort().join(', ')}`);
    }
    inputs.sort();
    const inputSha256 = createHash('sha256')
      .update(inputs.map((input) => `input\0${input}\0`).join(''))
      .digest('hex');
    const distributedInputs = inputs.filter((input) => input === 'shared/dweb-loader.js'
      || input.startsWith('peerd-distributed/'));
    if (distributedInputs.length > 0) {
      throw new Error(`native Chrome kernel hosted distributed inputs: ${distributedInputs.join(', ')}`);
    }

    const output = readFileSync(result.outputs[0].path, 'utf8');
    const staticImports = await staticImportSpecifiers(output, entryRelative);
    if (staticImports.length !== 0) {
      throw new Error(`native Chrome bundle retained static imports: ${staticImports.join(', ')}`);
    }
    if (/\bimport\s*\(/.test(output)) {
      throw new Error('native Chrome bundle retained a runtime import');
    }

    writeFileSync(entry, output.endsWith('\n') ? output : `${output}\n`);
    return Object.freeze({
      bytes: statSync(entry).size,
      inputs: Object.freeze(inputs),
      inputSha256,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
