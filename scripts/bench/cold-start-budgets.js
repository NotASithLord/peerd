// Install status/cancellation adds 1,308 authored authority bytes, no modules.
// Preview route identifier compaction reduces shipped bytes; timings and the
// package byte ceilings remain independent release gates, with no reserve.
// API-first integration removes six Chrome cold modules; typed run custody adds
// 428 Firefox source bytes / 192 packaged bytes. Exact measured values, no reserve.
// Integrated authority, consent, Discover and recovery fixes are measured
// together below, with no byte reserve; readiness and ownership gates stay fixed.
// Executable cold-start policy constants shared by packaging, static graph
// tests, browser assessment, CI and release promotion. Keep numeric tuning out
// of prose and do not duplicate these ceilings elsewhere.

export const COLD_START_LANES = Object.freeze({
  local: Object.freeze({
    enforcement: 'release-safety',
    timeoutMs: 10_000, graphPolicy: 'ratchet', requireTimingTargets: true,
    chrome: Object.freeze({ fresh: 1, wakes: 1 }),
    firefox: Object.freeze({ fresh: 1, wakes: 1, idleMs: 45_000 }),
  }),
  device: Object.freeze({
    enforcement: 'release-safety',
    timeoutMs: 10_000, graphPolicy: 'ratchet', requireTimingTargets: true,
    chrome: Object.freeze({ fresh: 15, wakes: 15 }),
    firefox: Object.freeze({ fresh: 15, wakes: 15, idleMs: 45_000 }),
  }),
  pr: Object.freeze({
    enforcement: 'release-safety',
    timeoutMs: 10_000, graphPolicy: 'ratchet', requireTimingTargets: true,
    chrome: Object.freeze({ fresh: 7, wakes: 7 }),
    firefox: Object.freeze({ fresh: 7, wakes: 5, idleMs: 45_000 }),
  }),
  main: Object.freeze({
    enforcement: 'release-safety',
    timeoutMs: 10_000, graphPolicy: 'ratchet', requireTimingTargets: true,
    chrome: Object.freeze({ fresh: 15, wakes: 15 }),
    firefox: Object.freeze({ fresh: 7, wakes: 7, idleMs: 45_000 }),
  }),
  release: Object.freeze({
    enforcement: 'release-safety',
    timeoutMs: 10_000, graphPolicy: 'ratchet', requireTimingTargets: true,
    chrome: Object.freeze({ fresh: 15, wakes: 15 }),
    firefox: Object.freeze({ fresh: 7, wakes: 7, idleMs: 45_000 }),
  }),
});

// Complete raw phase contracts. Browser harnesses and policy validation both
// consume this table so a new user-visible readiness phase cannot be measured
// but silently omitted from release evidence (or vice versa).
export const COLD_START_PHASES = Object.freeze({
  chrome: Object.freeze({
    freshProfile: Object.freeze({
      requiredKey: 'fresh', completedKey: 'completed',
      boundary: 'browser-process-launch',
      // Browser process launch is recorded, but it is not service-worker work.
      // The UX gate starts at the first navigation that asks the extension to render.
      usableMetric: 'vaultGateReadyFromNavigationMs',
      metrics: Object.freeze([
        'cdpReadyMs', 'workerTargetMs', 'navigationFromLaunchMs',
        'staticShellFromLaunchMs',
        'bootstrapFromLaunchMs',
        'stateFromLaunchMs', 'vaultGateReadyFromLaunchMs',
        'vaultGateReadyFromWorkerTargetMs', 'vaultGateReadyFromNavigationMs',
      ]),
      ordering: Object.freeze([
        Object.freeze([
          'cdpReadyMs', 'workerTargetMs', 'navigationFromLaunchMs',
          'staticShellFromLaunchMs',
        ]),
        Object.freeze(['staticShellFromLaunchMs', 'vaultGateReadyFromLaunchMs']),
        Object.freeze(['bootstrapFromLaunchMs', 'stateFromLaunchMs']),
      ]),
    }),
    forcedColdWake: Object.freeze({
      requiredKey: 'wakes', completedKey: 'completed',
      boundary: 'confirmed-worker-stop-to-actionable-ui',
      usableMetric: 'vaultGateReadyFromWakeMs',
      metrics: Object.freeze([
        'workerTargetFromWakeMs', 'staticShellFromWakeMs',
        'bootstrapFromWakeMs', 'stateFromWakeMs',
        'vaultGateReadyFromWakeMs',
      ]),
      ordering: Object.freeze([
        Object.freeze(['staticShellFromWakeMs', 'vaultGateReadyFromWakeMs']),
        Object.freeze(['bootstrapFromWakeMs', 'stateFromWakeMs']),
      ]),
    }),
  }),
  firefox: Object.freeze({
    freshProfile: Object.freeze({
      requiredKey: 'fresh', completedKey: 'completed',
      boundary: 'webdriver-session-launch',
      // WebDriver/browser launch remains visible evidence, while the extension
      // budget begins at the exact add-on install boundary.
      usableMetric: 'vaultGateReadyFromInstallMs',
      metrics: Object.freeze([
        'webdriverSessionMs', 'addonInstallMs', 'staticShellFromInstallMs',
        'bootstrapFromInstallMs',
        'stateFromInstallMs', 'vaultGateReadyFromInstallMs',
        'vaultGateReadyFromSessionMs', 'hostRoundTripMs', 'workerAgeAtProbeMs',
      ]),
      ordering: Object.freeze([
        Object.freeze(['staticShellFromInstallMs', 'vaultGateReadyFromInstallMs']),
        Object.freeze(['bootstrapFromInstallMs', 'stateFromInstallMs']),
      ]),
    }),
    idleDiscardWake: Object.freeze({
      requiredKey: 'wakes', completedKey: 'discarded',
      boundary: 'post-idle-navigation-to-actionable-ui',
      usableMetric: 'vaultGateReadyFromWakeMs',
      metrics: Object.freeze([
        'staticShellFromWakeMs',
        'bootstrapFromWakeMs', 'stateFromWakeMs',
        'vaultGateReadyFromWakeMs', 'workerAgeAtProbeMs',
        'hostRoundTripMs',
      ]),
      ordering: Object.freeze([
        Object.freeze(['staticShellFromWakeMs', 'vaultGateReadyFromWakeMs']),
        Object.freeze(['bootstrapFromWakeMs', 'stateFromWakeMs']),
      ]),
    }),
  }),
});

export const COLD_START_COMPARISON = Object.freeze({
  relativeTolerance: 0.1,
  minimumToleranceMs: 100,
});

export const COLD_SOURCE_TARGETS = Object.freeze({
  sidepanel: Object.freeze({ modules: 75, graphBytes: 650_000, entryBytes: 50_000 }),
  home: Object.freeze({ modules: 75, graphBytes: 650_000, entryBytes: 50_000 }),
  offscreen: Object.freeze({ modules: 25, graphBytes: 200_000, entryBytes: 40_000 }),
});

// Final lock publication reuses known locked authority instead of reacquiring
// its retired host: exactly 386 source and 156 packaged bytes per worker.
// Vault bootstrap retirement now rejects pending readiness immediately. The
// measured shared closure adds 556 source bytes and 141 packaged bytes per
// worker target, with no module or timing-budget changes and no reserve.
// The opt-in first tab adds one kernel module (the windows.onCreated owner and
// its kept-window record), the faster side panel close, a same-window Home
// pick and two default settings. Exact, no reserve.
// The first tab owner also knows a reopened window by its tabs (3,630 source
// bytes), and the preview update notice asks for a restart while the setting
// is on (312 source bytes). No module. Exact, no reserve.
// Combined first-tab custody and Discover declaration/read routes: measured
// source and packaged closures, with no reserve or readiness changes.
export const PREVIEW_KERNEL_SOURCE_CONTRACT = Object.freeze({
  // Chrome's authored graph is the same complete closure that Bun packages;
  // import() is not counted as a lazy boundary in an MV3 service worker.
  shared: Object.freeze({ modules: 409, graphBytes: 4_104_517 }),
  target: Object.freeze({ modules: 412, graphBytes: 4_195_880 }),
  // Preview-exclusive update, dweb custody and contributor consent remain
  // fixed authority. This is the exact achieved preview-only closure.
  exclusive: Object.freeze({ modules: 4, graphBytes: 91_563 }),
  entryBytesCeiling: 236,
  directImportsCeiling: 3,
});
export const FIREFOX_KERNEL_SOURCE_CONTRACT = Object.freeze({
  // Exact shared authority closure including synchronous session revocation.
  modules: 91, graphBytes: 682_359, entryBytes: 239, directImports: 3,
});
export const PREVIEW_FIREFOX_KERNEL_SOURCE_CONTRACT = Object.freeze({
  modules: 93, graphBytes: 689_990, entryBytes: 250, directImports: 2,
});

// The offscreen entry is a broker/supervisor, not a feature host. Its former
// absolute ratchet was also never achieved. Pin the real deletion instead: the
// supervisor must stay at least this far below its immediately preceding,
// executable graph while also satisfying the architectural cold-source target.
export const OFFSCREEN_SUPERVISOR_SOURCE_CONTRACT = Object.freeze({
  baseline: Object.freeze({
    modules: 12, graphBytes: 90_502, entryBytes: 31_533, directImports: 5,
  }),
  // 9_049 -> 8_717: the supervisor gained the controller-offer startMessages
  // drain (client.postMessage queues never drain on addEventListener alone).
  minimumReduction: Object.freeze({ modules: 2, graphBytes: 8_717 }),
  // Document extraction settlement is a fixed lease/cancellation boundary,
  // not feature semantics; keep its one explicit lifecycle import visible.
  directImportsCeiling: 6,
});

export const COLD_SOURCE_RATCHETS = Object.freeze({
  // Reviewed pacing, App consent generations and final-send revocation add ten
  // finite authority leaves. Pin their measured complete closure with no reserve;
  // forbidden-owner imports and physical readiness targets remain independent gates.
  // Provider inventory observations now retain exact host and vault custody.
  // Their finite read policy grows existing leaves only; no import or timing
  // gate changes. These are the remeasured combined bytes, with no reserve.
  // The final main integration preserves those authority fixes and removes
  // duplicated legacy implementations. Remeasure without adding graph reserve.
  // Exact Settings/Home/Lab admission and chat-scoped integration metadata
  // repair existing leaves without new modules. Pin their measured closure
  // without reserve; Lab requests retain their narrow payload validators.
  // The opt-in first tab owns windows.onCreated in one small module. Exact.
  // It also knows a reopened window by its tabs. Same module. Exact.
  kernel: Object.freeze({ modules: 409, graphBytes: 4_104_517, entryBytes: 200, directImports: 2 }),
  // The 8,235-byte shared schema/provenance validator rejects partial or
  // corrupt authority state before first-install actions become clickable.
  // Both shells share the exact module; the increase is reviewed integrity
  // code and these achieved values contain no headroom.
  // Two renderer frames separate module registration from the visible rich-app
  // postcondition, preventing a healthy Mithril mount from being replaced by a
  // false terminal failure. Rich-app effect policy stays outside the transport-
  // only vault shell graph. Exact shared-shell values, no reserved headroom.
  // The shared utility now supports abortable pacing sleeps; neither shell gains
  // a module or execution owner. These are the exact measured source bytes.
  // Mithril's unused network API is removed from the single canonical asset;
  // ratchet both shells down to their measured closure rather than retain slack.
  sidepanel: Object.freeze({ modules: 11, graphBytes: 137_969, entryBytes: 396, directImports: 1 }),
  home: Object.freeze({ modules: 11, graphBytes: 138_137, entryBytes: 564, directImports: 1 }),
});

// Cold-start is an observed user-visible outcome, not a bundle-size contest.
// The graph remains protected by achieved no-growth ratchets and dependency
// boundary tests; only actionable readiness carries an absolute target.
export const COLD_START_TIMING_TARGETS = Object.freeze({
  chrome: Object.freeze({ usableMaxMs: 3_000 }),
  firefox: Object.freeze({ usableMaxMs: 3_000 }),
});

export const COLD_GRAPH_RATCHETS = Object.freeze({
  chrome: Object.freeze({
    // Chrome's complete executable MV3 closure is static: runtime import() is
    // not a supported demand boundary. This is the exact achieved minified
    // authored graph in the disposable, module-preserving release staging tree.
    // Pin the measured pacing/consent/revocation closure with no reserve.
    // The first tab owner (background/kernel-first-tab.js) joins it. Exact.
    // Its reopened-window rows add 1,700 packaged bytes and no module. Exact.
    serviceWorker: Object.freeze({
      modules: 405, graphBytes: 2_105_846, entryBytes: 173,
      inputSha256: 'a92fe66eab988f0dd4274f793bde7685b281429cd1540119be4550d785efd8de',
    }),
    // One shared read-only authority schema/provenance validator rejects
    // corrupt or partial state before cold human controls become actionable.
    sidepanel: Object.freeze({ modules: 11, graphBytes: 129_306, entryBytes: 396 }),
    home: Object.freeze({ modules: 11, graphBytes: 129_474, entryBytes: 564 }),
    // The feature-lease supervisor owns only broker/lifecycle code; controller,
    // repository, model, job and dweb owners remain fixed lazy entries. The
    // stamped build identity replaces runtime.getManifest, which Chrome does
    // not expose in an offscreen document.
    // Exact supervisor closure with fixed document-extraction admission and
    // lease-bound Stop settlement; document parsing stays outside this graph.
    // The stamped build facts carry the two first tab defaults.
    offscreen: Object.freeze({ modules: 7, graphBytes: 22_035, entryBytes: 13_293 }),
  }),
  firefox: Object.freeze({
    serviceWorker: Object.freeze({ modules: 91, graphBytes: 428_483, entryBytes: 210 }),
    sidepanel: Object.freeze({ modules: 11, graphBytes: 133_794, entryBytes: 396 }),
    home: Object.freeze({ modules: 11, graphBytes: 133_962, entryBytes: 564 }),
  }),
});

// Packaging runs every channel/browser cell. Preview Chrome carries the real
// dweb loader while Store carries the reviewed stub, so their otherwise equal
// cold graphs differ by the exact generated loader bytes. Keep a separate
// no-growth fence for every shipped cell instead of granting the smaller Store
// build unused headroom.
export const PACKAGE_COLD_GRAPH_RATCHETS = Object.freeze({
  store: COLD_GRAPH_RATCHETS,
  preview: Object.freeze({
    chrome: Object.freeze({
      // The Home routes that block, unblock and list makers (the same durable
      // user peer policy dweb_block writes, with the same A2A consent
      // revocation through the turn relay) add thin handlers to an existing
      // module and no module. Remeasured with no reserve.
      // The first tab owner joins it as one module. Exact.
      // Its reopened-window rows and the restart notice add 1,877 bytes. Exact.
      serviceWorker: Object.freeze({
        modules: 412, graphBytes: 2_221_147, entryBytes: 207,
        inputSha256: '44fb39a6e1e4ebb9e57381dc4d77cbc0f34e2dfb4d6e917b59b22cabbafcb8f6',
      }),
      sidepanel: Object.freeze({ modules: 11, graphBytes: 129_306, entryBytes: 396 }),
      home: Object.freeze({ modules: 11, graphBytes: 129_474, entryBytes: 564 }),
      offscreen: Object.freeze({ modules: 7, graphBytes: 22_117, entryBytes: 13_293 }),
    }),
    // Firefox has no dweb host yet, but Preview still carries its distinct
    // generated channel policy bytes.
    firefox: Object.freeze({
      serviceWorker: Object.freeze({ modules: 93, graphBytes: 433_906, entryBytes: 81 }),
      sidepanel: Object.freeze({ modules: 11, graphBytes: 133_794, entryBytes: 396 }),
      home: Object.freeze({ modules: 11, graphBytes: 133_962, entryBytes: 564 }),
    }),
  }),
});
