// Deterministic content identity for the private kernel <-> controller channel.
// The generated module is stamped after release minification, so a surviving
// offscreen document from any other packaged build cannot handshake with the
// new authority kernel even when the extension URL is unchanged.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { collectStaticModuleGraph } from './static-module-graph.ts';
import {
  SEMANTIC_HOST_CORE_BUILD_ENTRIES,
} from './semantic-host-entries.ts';

export const CONTROLLER_BUILD_ENTRIES = Object.freeze([
  // The supervisor and every demand-owned operation host enforce the same
  // build/lease authority. A stale offscreen document must be rejected when
  // any of these bytes change, not only when the sealed controller changes.
  'offscreen/offscreen.js',
  'offscreen/feature-lease-host.js',
  'offscreen/supervisor-channels.js',
  'offscreen/actor-channel-host.js',
  'offscreen/actor-runner.js',
  'offscreen/actor-worker.js',
  'offscreen/actor-worker-runtime.js',
  'offscreen/voice-channel-host.js',
  'offscreen/local-model.js',
  'offscreen/job-runner.js',
  // job-runner emits these imports into its generated sealed Worker source;
  // they are executable custody roots rather than static graph children.
  'engine-tabs/notebook-tab/realm-seal.js',
  'engine-tabs/notebook-tab/notebook-std.js',
  'engine-tabs/notebook-tab/notebook-wasi.js',
  'offscreen/doc-extract.js',
  'offscreen/web-extract-core.js',
  'offscreen/web-extract.js',
  'offscreen/repository-host.js',
  // Per-offer module Workers are selected through new URL(), which the static
  // graph intentionally does not follow. Bind their executable bytes directly.
  'offscreen/repository-worker.js',
  // Name the App-file policy as an operation root in its own right. It is
  // currently a static child of repository-worker, but keeping the root explicit
  // prevents a later lazy-load refactor from silently dropping digest custody.
  'offscreen/repository-app-files.js',
  'offscreen/artifact-host.js',
  'offscreen/artifact-worker.js',
  'background/offscreen-artifact-client.js',
  'background/repository-client.js',
  'background/offscreen-controller-client.js',
  'background/direct-controller-client.js',
  'background/direct-actor-host.js',
  'background/firefox-storage-keepalive.js',
  'background/repository-local-client.js',
  // Kernel-side reverse authority for turn.run is not a child of a controller
  // client, so bind it as an explicit root rather than letting authority drift
  // behind a stale host.
  'background/controller-turn-bridge.js',
  'background/kernel-demand-plane.js',
  'background/kernel-production-runtime.js',
  'background/kernel-turn-authority-adapter.js',
  'background/kernel-semantic-authority.js',
  'background/kernel-semantic-control.js',
  'background/kernel-administrative-control.js',
  'background/kernel-support-control.js',
  'background/kernel-session-authority.js',
  'background/kernel-repository-control.js',
  'background/kernel-local-control.js',
  'offscreen/controller-shell.js',
  'offscreen/controller-bootstrap.js',
  'offscreen/controller-worker.js',
  'offscreen/controller-runtime.js',
  'offscreen/controller-compose-runtime.js',
  'offscreen/kernel-runtime-host.js',
  'offscreen/kernel-administrative-host.js',
  'offscreen/kernel-support-host.js',
  'offscreen/kernel-repository-host.js',
  'offscreen/kernel-local-host.js',
  // The vault authority loads this fixed KDF graph only for passphrase demand.
  'shared/argon2id.js',
  // Demand-owned sealed vault realm. Its bootstrap has no static feature
  // edges, so bind the fixed runtime graph explicitly.
  'offscreen/vault-authority-worker.js',
  'offscreen/vault-authority-runtime.js',
  'offscreen/document-conversion-worker.js',
  // Runtime-selected repository/model/document/voice implementations remain
  // part of the same host identity even though they stay off the cold graph.
  'peerd-engine/export.js',
  'peerd-engine/repository.js',
  'peerd-runtime/offscreen.js',
  'peerd-runtime/voice/transcriber-picker.js',
  'vendor/isomorphic-git/index.js',
  'vendor/muse-glimmer/muse-glimmer.js',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/readability/Readability-readerable.js',
  'vendor/readability/Readability.js',
  'vendor/tesseract/tesseract.esm.min.js',
  'vendor/transformers/transformers.js',
  'vendor/turndown/turndown.browser.es.js',
  // Fixed-literal dynamic import evaluated only after a committed turn. It is
  // digest-bound separately so the prompt controller stays cold-small.
  'offscreen/controller-turn-runtime.js',
  // Fixed-literal dynamic semantic dispatcher and its reviewed route bodies.
  // It must be bound even though the cold graph collector excludes lazy edges.
  ...SEMANTIC_HOST_CORE_BUILD_ENTRIES,
] as const);

export const CONTROLLER_OPTIONAL_BUILD_ENTRIES = Object.freeze([
  'offscreen/dweb-base.js',
  'offscreen/dweb-custody-host.js',
  'offscreen/dweb-transfer-host.js',
  'background/kernel-preview-addon.js',
  // Firefox preview/dev owns its contributor registration in a distinct
  // background entry, so bind that channel-specific authority shell too.
  'background/vault-kernel-firefox-preview.js',
  'background/kernel-contributor-owner.js',
  'offscreen/contributor-channel-addon.js',
  'peerd-runtime/controller-contributor.js',
  'shared/contributor-channel.js',
  'peerd-distributed/index.js',
  'offscreen/semantic-routes/contributor.js',
] as const);

export const CONTROLLER_BUILD_ASSETS = Object.freeze([
  'peerd-provider/system-prompt.txt',
  'peerd-provider/system-prompt-dweb.txt',
  // Runtime-selected executable children of the controller-owned local-model
  // and voice hosts are not visible to the static module graph.
  'vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs',
  'vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm',
  'vendor/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs',
  'vendor/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm',
  'vendor/vad-web/vad.worklet.bundle.min.js',
  'vendor/vad-web/silero_vad_legacy.onnx',
  'vendor/vad-web/silero_vad_v5.onnx',
  // Document workers execute under the digest-custodied offscreen operation
  // but are selected by library URLs rather than authored module imports.
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/tesseract/worker.min.js',
] as const);

// These are the generated identity leaves, not merely modules that re-export
// the identity. Keep digest normalization and artifact stamping on this one
// shared list so moving the leaf cannot make those two operations disagree.
export const CONTROLLER_BUILD_STAMP_MODULES = Object.freeze([
  'controller-build.js',
  'build-config.js',
] as const);
const CONTROLLER_BUILD_STAMP_PATHS = new Set(
  CONTROLLER_BUILD_STAMP_MODULES.map((name) => `shared/${name}`),
);

export const controllerBuildDigest = async (root: string): Promise<string> => {
  const absoluteRoot = resolve(root);
  const files = new Set<string>();
  for (const entry of [...CONTROLLER_BUILD_ENTRIES, ...CONTROLLER_OPTIONAL_BUILD_ENTRIES]) {
    const absolute = join(absoluteRoot, entry);
    if (!existsSync(absolute)) continue;
    for (const file of await collectStaticModuleGraph(absoluteRoot, absolute)) files.add(file);
  }
  for (const asset of CONTROLLER_BUILD_ASSETS) {
    const absolute = join(absoluteRoot, asset);
    if (existsSync(absolute)) files.add(absolute);
  }

  const hash = createHash('sha256');
  hash.update('peerd-controller-build-v1\0');
  for (const file of [...files].sort()) {
    const rel = relative(absoluteRoot, file).split('\\').join('/');
    let bytes = readFileSync(file);
    if (CONTROLLER_BUILD_STAMP_PATHS.has(rel)) {
      const source = bytes.toString('utf8');
      if (!/CONTROLLER_BUILD_DIGEST\s*=\s*['"][a-f0-9]{64}['"]/.test(source)) {
        throw new Error('controller build digest stamp is missing');
      }
      const normalized = source.replace(
        /(CONTROLLER_BUILD_DIGEST\s*=\s*['"])[a-f0-9]{64}(['"])/,
        `$1${'0'.repeat(64)}$2`,
      );
      bytes = Buffer.from(normalized);
    }
    hash.update(rel);
    hash.update('\0');
    hash.update(String(bytes.byteLength));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
};

export const writeControllerBuildIdentity = async (root: string): Promise<string> => {
  const digest = await controllerBuildDigest(root);
  for (const name of CONTROLLER_BUILD_STAMP_MODULES) {
    const path = join(root, 'shared', name);
    const source = readFileSync(path, 'utf8');
    const stamped = source.replace(
      /(CONTROLLER_BUILD_DIGEST\s*=\s*['"])[a-f0-9]{64}(['"])/,
      `$1${digest}$2`,
    );
    if (stamped === source && !source.includes(digest)) {
      throw new Error(`controller build digest stamp is missing from ${name}`);
    }
    writeFileSync(path, stamped);
  }
  return digest;
};
