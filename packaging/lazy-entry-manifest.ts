// Fixed packaged entry points that are intentionally outside an HTML/manifest
// static graph. Keep this list small and explicit: arbitrary dynamic imports are
// runtime capability boundaries and must not be followed by packaging.
//
// Every module entry below must exist in every channel/browser package and its
// complete static dependency graph must resolve inside that exact staged tree.
import { SEMANTIC_HOST_BUILD_ENTRIES } from './semantic-host-entries.ts';

export const PACKAGED_LAZY_MODULE_ENTRIES = Object.freeze([
  // Agent/controller execution realms.
  'offscreen/actor-worker.js',
  'offscreen/actor-channel-host.js',
  'offscreen/actor-runner.js',
  'offscreen/controller-worker.js',
  'shared/argon2id.js',
  'offscreen/vault-authority-worker.js',
  'offscreen/vault-authority-runtime.js',
  'offscreen/controller-runtime.js',
  'offscreen/controller-turn-runtime.js',
  'offscreen/controller-shell.js',
  'offscreen/controller-bootstrap.js',
  ...SEMANTIC_HOST_BUILD_ENTRIES,
  'background/direct-controller-client.js',
  'background/kernel-semantic-runtime.js',
  'background/kernel-turn-production-runtime.js',
  'background/kernel-rich-runtime.js',
  'background/kernel-production-runtime.js',
  'background/kernel-administrative-runtime.js',
  'background/kernel-local-routes.js',
  'background/kernel-executable-runtime.js',
  'background/kernel-executable-live.js',
  'background/kernel-executable-transfer-live.js',
  'background/kernel-dweb-custody-runtime.js',
  'background/kernel-dweb-route-runtime.js',
  'background/firefox-storage-keepalive.js',
  'peerd-egress/ui.js',
  'offscreen/repository-host.js',
  'offscreen/repository-app-files.js',
  'background/repository-local-client.js',
  'offscreen/job-runner.js',
  'offscreen/web-extract-core.js',
  'offscreen/toolbox-parse.js',
  'offscreen/artifact-host.js',
  'offscreen/artifact-worker.js',
  'offscreen/local-model.js',
  'offscreen/pdf-extract.js',
  'offscreen/doc-extract.js',
  'offscreen/web-extract.js',
  // Preview's deliberate long-lived mesh lease starts this graph on demand;
  // Store packages the same inert host but never loads it.
  'offscreen/dweb-base.js',
  // Firefox event pages load this directly on first repository use; Chrome
  // reaches the same graph through repository-host.js.
  'peerd-engine/repository.js',

  // Rich UI loaded only after the minimal vault shell is actionable.
  'sidepanel/sidepanel.js',
  'home/home.js',

  // Fixed module Workers spawned by their owning engine tabs.
  'engine-tabs/notebook-tab/linker-worker.js',
  'engine-tabs/pod-tab/pod-job-worker.js',
] as const);

// Fixed non-module worker assets selected by libraries at runtime. Their own
// loaders are vendor-controlled, so packaging verifies byte presence rather
// than attempting to parse them as Peerd ES-module graphs.
export const PACKAGED_LAZY_ASSET_ENTRIES = Object.freeze([
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/tesseract/worker.min.js',
] as const);
