// Channel-aware default settings — the single schema both channels'
// CHANNEL_DEFAULTS are generated from. PACKAGE-TIME INPUT ONLY: nothing in
// the extension imports this file; packaging/gen-channel-config.ts flattens it
// per channel into extension/shared/channel-config.js (and into the staged
// copy of each artifact).
//
// Each key maps to { store, preview } values. A key present for only one
// channel is OMITTED from the other channel's CHANNEL_DEFAULTS entirely —
// there is no runtime conditional; the field simply doesn't exist in
// that package.
//
// THE PRINCIPLE (spec §11): safety defaults stay strict across both
// channels; only FRICTION defaults relax on preview. Egress allowlist
// posture, the sensitive-site denylist, vault encryption — none of those
// are settings here, and none may become channel-conditional. The
// channel boundary is friction tolerance, not safety floor.
//
// Also: don't proliferate channel-conditional values. Every store/preview
// divergence is a small permanent maintenance tax — add one only when it
// genuinely serves the audience split. Most keys below are deliberately
// identical.
//
// Migration semantics are Option A (spec §11): a stored value always wins
// over CHANNEL_DEFAULTS, even if it happens to equal an old default. New
// defaults reach existing users only when they reset the setting.

export const defaults = {
  // (backgroundTabsEnabled is GONE, 2026-06-12: agent-opened tabs are
  // background ALWAYS — the agent never steals focus. No toggle, no shim.)

  // Voice stays opt-in on BOTH channels: enabling triggers a large model
  // download (Moonshine WASM) and a mic-permission flow. Auto-enabling
  // that on preview wouldn't serve technical users, it would just
  // surprise them. (Deliberate deviation from the spec's illustrative
  // "voice auto-on for preview" example.)
  voiceEnabled: { store: false, preview: false },
  // why: peerd ships exactly ONE Moonshine model — `base`, the more
  // accurate of upstream's two real variants (there is no 'small'/'tiny'
  // shipped). The key is retained for storage back-compat; any other
  // value is coerced to `base` at every read (normalizeVariant). The old
  // 'small' default here was the source of the recurring "Unknown voice
  // model variant" crash — it pinned a model that doesn't exist.
  voiceVariant: { store: 'base', preview: 'base' },
  // why: Web Speech (browser SpeechRecognition) is the DEFAULT engine —
  // instant, no download. Moonshine (~250 MB WASM, fully on-device) is an
  // OPT-IN PRIVACY UPGRADE, not the auto pick, even when vendored + SRI-pinned.
  //   'auto'       — prefer Web Speech; fall back to Moonshine only when Web
  //                  Speech is unavailable (Firefox has no SpeechRecognition).
  //   'web-speech' — force the browser engine (cloud-routed on most browsers).
  //   'moonshine'  — force local Moonshine; the privacy choice.
  // 'auto' on both channels: engine choice is a friction/privacy preference,
  // not a safety floor. Unknown stored values coerce to 'auto' (normalizeEngine).
  voiceEngine: { store: 'auto', preview: 'auto' },
  voiceSilenceMs: { store: 1500, preview: 1500 },
  voiceOnboardingDismissed: { store: false, preview: false },

  // OCR for scanned PDFs (read_pdf's heavy path). Opt-in on BOTH channels for
  // the same reason as voice: enabling triggers a multi-MB engine download.
  // The default reader (pdf.js text layer) needs no download and is always on;
  // this flag only governs the on-device OCR engine for image-only PDFs.
  ocrEnabled: { store: false, preview: false },

  // Verbose VM diagnostics (Settings → Behavior). OFF by default on BOTH
  // channels — its own UI copy already calls it "extra noise". On, it surfaces
  // the one-time wrapper install/verify output in the WebVM terminal at boot;
  // it does NOT trace the shell (no `set -x` — that used to leak peerd's
  // internal markers + bridge plumbing into every interactive command). The
  // verify results reach the boot LOG regardless, so debugging keeps its signal.
  devMode: { store: false, preview: false },

  // why: extended thinking renders a collapsible "Reasoning" section —
  // the premium feel. On for everyone.
  reasoningEnabled: { store: true, preview: true },

  // Anthropic output_config.effort. 'medium' by owner call (2026-06-12):
  // in a browser harness, long invisible deliberation reads as a hang —
  // medium trades some up-front reasoning depth for earlier, visible
  // tool action. The chat mode-row dial raises it per task.
  reasoningEffort: { store: 'medium', preview: 'medium' },

  // Empty on fresh install — NO provider is assumed. The first provider the
  // user configures auto-activates (provider/setKey for keyed providers,
  // ensureActiveProvider for a reachable keyless daemon at first chat). Until
  // then the Settings "Default model for new chats" section stays hidden and
  // chats can't start, instead of silently defaulting to Anthropic with no key.
  providerName: { store: '', preview: '' },
  providerModel: { store: '', preview: '' },

  // Curated OpenRouter model ids the chat model-picker offers (OpenRouter is
  // a gateway to hundreds of models — too many to dump in a dropdown, so the
  // user checks the ones they want in Settings). Empty = fall back to the
  // small built-in OpenRouter catalog until they curate. Same on both channels.
  openrouterModels: { store: [], preview: [] },

  // Whether tool contexts get the CDP pool (snapshot refs, page_exec on
  // Trusted-Types sites, page_keys, runner pre-seeding). The `debugger`
  // PERMISSION is required at install where it ships — Chrome refuses to
  // treat it as optional ("Permission 'debugger' cannot be listed as
  // optional") — so the user-facing control is this SETTING.
  //
  // Channel-split (2026-06-13 directive): CDP is the DEFAULT only in
  // preview/dev; the store package is scripting-first. The initial store
  // Chrome package ships WITHOUT the `debugger` permission (gen-manifest.ts
  // STORE_STRIPPED_PERMISSIONS), so advancedAutomationOn() is hard-false
  // there regardless of this value — but we set store:false EXPLICITLY so
  // that when CDP is re-added to a store update post-approval, users opt in
  // via Settings → Advanced rather than being silently auto-enrolled.
  // preview/dev stay ON (the quality path for technical users). Firefox has
  // no chrome.debugger API, so the setting is moot there on either channel.
  advancedAutomationEnabled: { store: false, preview: true },

  // Page-reader (get/check) runner model override. '' is NO override — the
  // runner resolves to the active provider's fast default (Haiku on Anthropic
  // via adapter.defaultRunnerModel; resolveRunnerModel), NOT the chat model.
  // So out of the box page reads ride Haiku while `do` and chat keep the
  // stronger model. A non-empty value pins a specific SAME-PROVIDER model id;
  // runRunner falls back to the inherited chat model when the runner blows its
  // step budget or refuses. Once the local WebGPU runner is downloaded it
  // becomes the resolved default here automatically. Same on both channels.
  runnerModel: { store: '', preview: '' },

  // Cost telemetry: the meter is always on; the hard limit is opt-in.
  spendLimitUsd: { store: 0, preview: 0 },
  pricingOverrides: { store: {}, preview: {} },

  // Confirm before NON-GET web egress (POST/PUT/PATCH/DELETE) — from both the
  // call_api tool and the WebVM's HTTP bridge. ON by default on BOTH channels:
  // this is the anti-exfiltration gate (a prompt-injected agent can't silently
  // POST in-context data to an arbitrary host), so it's a safety floor, not a
  // friction knob (spec §11 — does not diverge). The user can approve a single
  // write or all writes for the session; turning it OFF is a deliberate,
  // risk-acknowledged choice in Settings. GET reads are never gated.
  confirmWebWrites: { store: true, preview: true },

  // Auto-memory: when a session wraps up (archive / switch-away with
  // real substance), a cheap clean-context call proposes durable-note
  // SUGGESTIONS the user approves in Context → Memory — nothing is
  // auto-written. Default ON on both channels: the gate this switch
  // controls is the background model spend, not memory writes (those
  // always require the per-note approval), and the calls respect
  // spendLimitUsd. Not a safety divergence candidate.
  autoMemoryEnabled: { store: true, preview: true },

  // ── Resilience ──────────────────────────────────────────────────────
  // Auto-resume a turn the browser session reclaimed mid-flight. MV3
  // evicts the service worker aggressively, so a long turn can die between
  // the model call and a durable end state; the transcript is persisted
  // per-delta but nothing re-drives it. ON: reopening the chat (or
  // unlocking the vault) continues an INTERRUPTED turn from where it left
  // off. Only fires on genuine infrastructure interruptions (a user Stop
  // is never resumed), at most once per dead turn, and the continuation
  // respects spendLimitUsd. Not a safety divergence — same on both channels.
  autoResumeInterruptedTurns: { store: true, preview: true },

  // Provider failover (switch-and-continue). When the active provider stays
  // overloaded past the adapter's own retries, or returns a HARD usage
  // limit (out of credit / over a cap), switch to a configured fallback
  // provider and keep the turn going rather than failing it. The switch
  // only ever happens BEFORE any model output streamed (never mid-answer).
  // ON by default, but a no-op until the user lists a fallback below — so
  // out of the box behavior is unchanged.
  providerFailoverEnabled: { store: true, preview: true },

  // Ordered fallback PROVIDER names tried when failover fires (each uses
  // that provider's default model; requires its own key/daemon). Empty =
  // no failover. Same on both channels.
  providerFallbacks: { store: [], preview: [] },

  // Idle vault auto-lock, in milliseconds. 0 = never (the unwrapped DK
  // stays live until SW death / browser close). 45min on BOTH channels —
  // this is a safety default, not a friction default, so it does not
  // diverge (spec §11). Re-unlock is one passkey tap once PRF is enrolled.
  // The SW applies it via vault.setAutoLockMs() in loadSettings().
  vaultAutoLockMs: { store: 2700000, preview: 2700000 },

  // Audit-log retention cap (entry count; oldest pruned first, amortized
  // on append — peerd-egress/audit/retention.js). NOT a user setting:
  // the SW reads it straight from CHANNEL_DEFAULTS at audit-log
  // construction, so stored settings never override it; it lives here so
  // a channel COULD diverge. Retention depth isn't a safety floor
  // (the log is local-only diagnostics with capped reads everywhere), so
  // divergence would be legal — but nothing needs one today.
  auditLogMaxEntries: { store: 20000, preview: 20000 },

  // ── preview-only keys ──────────────────────────────────────────────
  // Dweb participation is ON BY DEFAULT on the dev/preview package (owner
  // call, 2026-06-13 — supersedes the earlier "opt-in even on preview",
  // spec §12). Preview ships to contributors and early testers; making
  // them toggle dweb on before the demo is pure friction, and the channel
  // boundary IS friction tolerance, not a safety floor (see the file
  // header) — same posture as `advancedAutomationEnabled: { preview: true }`. NOT a safety
  // relaxation: the dweb module is preview-channel-only (the store package
  // prunes it and sets DWEB_ENABLED=false, so this key is absent there
  // entirely from CHANNEL_DEFAULTS), identity needs an unlocked vault, and
  // NOTHING connects until the user explicitly joins a room (the bridge's
  // consent gate). On = the dweb UI is live and the commons opens without
  // a pre-step; it does not auto-connect anywhere.
  dwebEnabled: { preview: true },
};
