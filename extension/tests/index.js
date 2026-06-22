// @ts-check
// Test module manifest.
//
// New test files must be added here explicitly. Static imports give us
// load-time errors for missing files (instead of silent skips) and keep
// the test set legible in one place.
//
// Layout mirrors the module structure: tests/unit/<module>/<file>.test.js.

// --- shared ---
import './unit/shared/util.test.js';

// --- peerd-egress ---
import './unit/peerd-egress/audit-retention.test.js';
import './unit/peerd-egress/denylist.test.js';
import './unit/peerd-egress/safe-fetch.test.js';
import './unit/peerd-egress/vault.test.js';
import './unit/peerd-egress/vault-blob-idb.test.js';
import './unit/peerd-egress/vault-kdf.test.js';
import './unit/peerd-egress/vault-prf.test.js';
import './unit/peerd-egress/web-fetch.test.js';
// Real WebAuthn ceremonies — the ceremony tests register only under the
// CDP harness (virtual authenticators + injected flag); a manual
// runner.html shows one documentation test naming the gate.
import './unit/peerd-egress/webauthn-virtual.test.js';

// --- peerd-provider ---
import './unit/peerd-provider/sse-parser.test.js';
import './unit/peerd-provider/from-anthropic.test.js';
import './unit/peerd-provider/to-anthropic.test.js';
import './unit/peerd-provider/anthropic-adapter.test.js';
import './unit/peerd-provider/ollama-adapter.test.js';
import './unit/peerd-provider/ollama-recommend.test.js';

// --- peerd-runtime ---
import './unit/peerd-runtime/sessions-store.test.js';
import './unit/peerd-runtime/agent-loop.test.js';
import './unit/peerd-runtime/subagent-spawn.test.js';
import './unit/peerd-runtime/dispatcher.test.js';
import './unit/peerd-runtime/introspection-tools.test.js';
import './unit/peerd-runtime/query-dom.test.js';
import './unit/peerd-runtime/dom-walk.test.js';
import './unit/peerd-runtime/page-eval.test.js';
import './unit/peerd-runtime/page-exec.test.js';
import './unit/peerd-runtime/page-keys.test.js';
import './unit/peerd-runtime/prompt-wrap.test.js';
import './unit/peerd-runtime/system-prompt.test.js';
import './unit/peerd-runtime/tool-manifests.test.js';
import './unit/peerd-runtime/redact.test.js';
import './unit/peerd-runtime/trim.test.js';
import './unit/peerd-runtime/clock/now.test.js';
import './unit/peerd-runtime/clock/context.test.js';
import './unit/peerd-runtime/clock/tools.test.js';
import './unit/peerd-runtime/web/policy.test.js';
import './unit/peerd-runtime/web/tools.test.js';
import './unit/peerd-runtime/voice/model-store.test.js';
import './unit/peerd-runtime/voice/manager.test.js';
import './unit/peerd-runtime/voice/transcriber.test.js';
import './unit/peerd-runtime/voice/engine-picker.test.js';
import './unit/peerd-runtime/vm-tools.test.js';

// --- peerd-engine ---
import './unit/peerd-engine/overlay.test.js';

// --- chassis: notebook-tab ---
import './unit/notebook-tab/notebook-seal.test.js';
import './unit/notebook-tab/notebook-output-render.test.js';

// --- chassis: offscreen (headless JS jobs / js_run) ---
import './unit/offscreen/job-runner.test.js';

// --- background (SW chassis: tab trackers + RPC clients + live SW routes) ---
import './unit/background/vm-tab-close.test.js';
import './unit/background/state-get.test.js';

// --- peerd-distributed ---
// (none yet — dweb surface reserved for V2+)

// --- sidepanel (chassis) ---
// Mithril component tests: real components mounted against a fake SW
// send(). They need a live DOM, so they belong on this surface, not bun.
import './unit/sidepanel/hooks-view.test.js';
import './unit/sidepanel/denylist-view.test.js';
import './unit/sidepanel/onboarding-view.test.js';
import './unit/sidepanel/mode-selector.test.js';
import './unit/sidepanel/goal-toggle.test.js';
import './unit/sidepanel/goal-bar.test.js';
import './unit/sidepanel/memory-suggestions.test.js';
import './unit/sidepanel/tools-chip.test.js';
import './unit/sidepanel/attachments.test.js';
import './unit/sidepanel/message-list.test.js';

// --- home (chassis): the full-tab Library page ---
import './unit/home/library-section.test.js';
import './unit/home/contacts-section.test.js';
