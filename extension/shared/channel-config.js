// @ts-check
// GENERATED FILE — do not edit. Source of truth: packaging/default-settings.mjs
// (regenerate with `bun run gen:dev`; the packaging script regenerates the
// staged copy per channel). The checked-in copy is the DEV default —
// preview channel — so "load unpacked → refresh" needs no build step.
//
// why this exists: the store/preview split is decided at PACKAGE TIME. The
// store artifact's copy of this file has DWEB_ENABLED = false and
// contains no dweb keys; the dweb module itself is absent
// from that artifact's tree. Core code gates dweb UI/calls on
// DWEB_ENABLED and reads defaults from CHANNEL_DEFAULTS — never from
// a runtime "which channel am I" probe, and never exposed to the agent or
// to skills (spec §11: settings are the only abstraction).

export const CHANNEL = "preview";
export const DWEB_ENABLED = true;

export const CHANNEL_DEFAULTS = Object.freeze({
  voiceEnabled: false,
  voiceVariant: "base",
  voiceEngine: "auto",
  voiceSilenceMs: 1500,
  voiceOnboardingDismissed: false,
  ocrEnabled: false,
  devMode: false,
  reasoningEnabled: true,
  reasoningEffort: "medium",
  providerName: "anthropic",
  providerModel: "",
  openrouterModels: [],
  advancedAutomationEnabled: true,
  runnerModel: "",
  spendLimitUsd: 0,
  pricingOverrides: {},
  confirmWebWrites: true,
  autoMemoryEnabled: true,
  autoResumeInterruptedTurns: true,
  providerFailoverEnabled: true,
  providerFallbacks: [],
  vaultAutoLockMs: 2700000,
  auditLogMaxEntries: 20000,
  dwebEnabled: true,
});
