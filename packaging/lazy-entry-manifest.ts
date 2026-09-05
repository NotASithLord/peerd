// Fixed packaged entry points that are intentionally outside an HTML/manifest
// static graph. Keep this list small and explicit: arbitrary dynamic imports are
// runtime capability boundaries and must not be followed by packaging.
//
// Each target selects the mandatory roots plus its explicit channel additions.
// Every selected root and its complete static graph must resolve in that staged
// tree; the union remains exported for source-wide completeness tests.
import { SEMANTIC_HOST_CORE_BUILD_ENTRIES } from './semantic-host-entries.ts';

export const PACKAGED_MANDATORY_LAZY_MODULE_ENTRIES = Object.freeze([
  // Agent/controller execution realms.
  'offscreen/actor-worker.js',
  'offscreen/actor-channel-host.js',
  'offscreen/actor-runner.js',
  'offscreen/controller-worker.js',
  'shared/argon2id.js',
  'offscreen/vault-authority-worker.js',
  'offscreen/vault-authority-runtime.js',
  'offscreen/controller-runtime.js',
  'offscreen/controller-compose-runtime.js',
  'offscreen/supervisor-channels.js',
  'offscreen/feature-lease-host.js',
  'offscreen/voice-channel-host.js',
  'offscreen/kernel-runtime-host.js',
  'offscreen/kernel-administrative-host.js',
  'offscreen/kernel-support-host.js',
  'offscreen/kernel-repository-host.js',
  'offscreen/kernel-local-host.js',
  'offscreen/controller-turn-runtime.js',
  'offscreen/controller-shell.js',
  'offscreen/controller-bootstrap.js',
  ...SEMANTIC_HOST_CORE_BUILD_ENTRIES,
  'background/offscreen-controller-client.js',
  'background/direct-controller-client.js',
  'background/kernel-demand-plane.js',
  'background/kernel-semantic-runtime.js',
  'background/kernel-executable-runtime.js',
  'background/kernel-provider-key-route.js',
  'background/kernel-credential-routes.js',
  'background/kernel-administrative-control.js',
  'background/kernel-support-control.js',
  'background/kernel-session-authority.js',
  'background/kernel-skill-persistence.js',
  'background/kernel-memory-init-probe.js',
  'background/kernel-turn-production-runtime.js',
  'background/kernel-rich-runtime.js',
  'background/kernel-production-runtime.js',
  'background/kernel-turn-authority-adapter.js',
  'background/kernel-local-control.js',
  'background/kernel-executable-live.js',
  'background/kernel-executable-transfer-live.js',
  'background/kernel-dweb-route-runtime.js',
  'background/firefox-storage-keepalive.js',
  'background/direct-actor-host.js',
  'background/repository-local-client.js',
  'peerd-egress/ui.js',
  'offscreen/repository-host.js',
  'offscreen/repository-worker.js',
  'offscreen/repository-app-files.js',
  'background/kernel-repository-control.js',
  'background/kernel-keyed-origin-authority.js',
  'offscreen/job-runner.js',
  'offscreen/actor-worker-runtime.js',
  'offscreen/web-extract-core.js',
  'offscreen/artifact-host.js',
  'offscreen/artifact-worker.js',
  'peerd-engine/artifact.js',
  'offscreen/local-model.js',
  'peerd-runtime/offscreen.js',
  'peerd-runtime/voice/transcriber-picker.js',
  'offscreen/pdf-extract.js',
  'offscreen/doc-extract.js',
  'offscreen/document-conversion-worker.js',
  'offscreen/web-extract.js',
  // Firefox event pages load this directly on first repository use; Chrome
  // reaches the same graph through repository-host.js.
  'peerd-engine/repository.js',
  'peerd-engine/export.js',

  // Vendor module roots selected by authored runtime loaders.
  'vendor/cheerpx/cx.esm.js',
  'vendor/isomorphic-git/index.js',
  'vendor/muse-glimmer/muse-glimmer.js',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/readability/Readability-readerable.js',
  'vendor/readability/Readability.js',
  'vendor/tesseract/tesseract.esm.min.js',
  'vendor/transformers/transformers.js',
  'vendor/turndown/turndown.browser.es.js',

  // Rich UI loaded only after the minimal vault shell is actionable.
  'sidepanel/sidepanel.js',
  'home/home.js',

  // Fixed module Workers spawned by their owning engine tabs.
  'engine-tabs/notebook-tab/linker-worker.js',
  'engine-tabs/pod-tab/pod-job-worker.js',
] as const);

export const PACKAGED_PREVIEW_LAZY_MODULE_ENTRIES = Object.freeze([
  // Store deliberately leaves the guarded Lab import unavailable. Preview
  // carries it along with the contributor execution plane.
  'home/eval-section.js',
  'background/kernel-contributor-owner.js',
  'offscreen/contributor-channel-addon.js',
  'offscreen/semantic-routes/contributor.js',
  'peerd-runtime/controller-contributor.js',
  'shared/contributor-channel.js',
] as const);

export const PACKAGED_PREVIEW_CHROME_LAZY_MODULE_ENTRIES = Object.freeze([
  // Only Preview Chrome has the mesh host and distributed implementation.
  'offscreen/dweb-base.js',
  'peerd-distributed/index.js',
] as const);

export const PACKAGED_STORE_UNAVAILABLE_RUNTIME_MODULE_ENTRIES = Object.freeze([
  // The module remains so Home can catch its rejected import; its eval/ static
  // closure is intentionally pruned from Store and must never be seeded there.
  'home/eval-section.js',
  // The shared offscreen broker keeps one channel-gated import spelling while
  // Store prunes the complete contributor owner.
  'offscreen/contributor-channel-addon.js',
] as const);

export const PACKAGED_LAZY_MODULE_ENTRIES = Object.freeze([
  ...PACKAGED_MANDATORY_LAZY_MODULE_ENTRIES,
  ...PACKAGED_PREVIEW_LAZY_MODULE_ENTRIES,
  ...PACKAGED_PREVIEW_CHROME_LAZY_MODULE_ENTRIES,
] as const);

// Fixed non-module worker assets selected by libraries at runtime. Their own
// loaders are vendor-controlled, so packaging verifies byte presence rather
// than attempting to parse them as Peerd ES-module graphs.
export const PACKAGED_LAZY_ASSET_ENTRIES = Object.freeze([
  'vendor/pdfjs/pdf.worker.min.mjs',
  'vendor/tesseract/worker.min.js',
] as const);

export const packagedLazyModuleEntries = (
  dweb: boolean,
  contributor = true,
): readonly string[] => Object.freeze([
  ...PACKAGED_MANDATORY_LAZY_MODULE_ENTRIES,
  ...(contributor ? PACKAGED_PREVIEW_LAZY_MODULE_ENTRIES : []),
  ...(dweb ? PACKAGED_PREVIEW_CHROME_LAZY_MODULE_ENTRIES : []),
]);

export const packagedUnavailableRuntimeModuleEntries = (
  dweb: boolean,
  contributor = true,
): readonly string[] => Object.freeze([
  ...(!contributor ? PACKAGED_STORE_UNAVAILABLE_RUNTIME_MODULE_ENTRIES : []),
  ...(!dweb ? ['offscreen/dweb-base.js'] : []),
]);
