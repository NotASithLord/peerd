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
        'bootModuleFromLaunchMs', 'bootstrapFromLaunchMs',
        'stateFromLaunchMs', 'vaultGateReadyFromLaunchMs',
        'vaultGateReadyFromWorkerTargetMs', 'vaultGateReadyFromNavigationMs',
      ]),
      ordering: Object.freeze([
        Object.freeze([
          'cdpReadyMs', 'workerTargetMs', 'navigationFromLaunchMs',
          'staticShellFromLaunchMs',
        ]),
        Object.freeze(['staticShellFromLaunchMs', 'bootModuleFromLaunchMs', 'vaultGateReadyFromLaunchMs']),
        Object.freeze(['bootstrapFromLaunchMs', 'stateFromLaunchMs']),
      ]),
    }),
    forcedColdWake: Object.freeze({
      requiredKey: 'wakes', completedKey: 'completed',
      boundary: 'confirmed-worker-stop-to-actionable-ui',
      usableMetric: 'vaultGateReadyFromWakeMs',
      metrics: Object.freeze([
        'workerTargetFromWakeMs', 'staticShellFromWakeMs',
        'bootModuleFromWakeMs', 'bootstrapFromWakeMs', 'stateFromWakeMs',
        'vaultGateReadyFromWakeMs',
      ]),
      ordering: Object.freeze([
        Object.freeze(['staticShellFromWakeMs', 'bootModuleFromWakeMs', 'vaultGateReadyFromWakeMs']),
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
        'bootModuleFromInstallMs', 'bootstrapFromInstallMs',
        'stateFromInstallMs', 'vaultGateReadyFromInstallMs',
        'vaultGateReadyFromSessionMs', 'hostRoundTripMs', 'workerAgeAtProbeMs',
      ]),
      ordering: Object.freeze([
        Object.freeze(['staticShellFromInstallMs', 'bootModuleFromInstallMs', 'vaultGateReadyFromInstallMs']),
        Object.freeze(['bootstrapFromInstallMs', 'stateFromInstallMs']),
      ]),
    }),
    idleDiscardWake: Object.freeze({
      requiredKey: 'wakes', completedKey: 'discarded',
      boundary: 'post-idle-navigation-to-actionable-ui',
      usableMetric: 'vaultGateReadyFromWakeMs',
      metrics: Object.freeze([
        'staticShellFromWakeMs', 'bootModuleFromWakeMs',
        'bootstrapFromWakeMs', 'stateFromWakeMs',
        'vaultGateReadyFromWakeMs', 'workerAgeAtProbeMs',
        'hostRoundTripMs',
      ]),
      ordering: Object.freeze([
        Object.freeze(['staticShellFromWakeMs', 'bootModuleFromWakeMs', 'vaultGateReadyFromWakeMs']),
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

export const PREVIEW_KERNEL_SOURCE_CONTRACT = Object.freeze({
  // Chrome's authored graph is the same complete closure that Bun packages;
  // import() is not counted as a lazy boundary in an MV3 service worker.
  shared: Object.freeze({ modules: 410, graphBytes: 3_992_852 }),
  target: Object.freeze({ modules: 413, graphBytes: 4_082_425 }),
  exclusive: Object.freeze({ modules: 4, graphBytes: 89_773 }),
  entryBytesCeiling: 236,
  directImportsCeiling: 3,
});
export const FIREFOX_KERNEL_SOURCE_CONTRACT = Object.freeze({
  modules: 88, graphBytes: 637_692, entryBytes: 239, directImports: 3,
});
export const PREVIEW_FIREFOX_KERNEL_SOURCE_CONTRACT = Object.freeze({
  modules: 90, graphBytes: 645_789, entryBytes: 250, directImports: 2,
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
});

export const COLD_SOURCE_RATCHETS = Object.freeze({
  // Repository/isomorphic-git moved behind the authenticated lazy host. The
  // browser-neutral vault auto-lock normalizer is one reviewed leaf shared by
  // settings and the authority kernel; it adds no semantic/provider/Git
  // ownership. The graph and entry values are achieved post-split values with
  // no headroom.
  // Chrome delegates the repository to the lazy offscreen owner and Firefox
  // dynamically loads the same controller on first use. The explicit facade
  // types keep downstream App/Git contracts intact without cold-linking it.
  // The supported Chrome/Firefox runtimes provide promise-native extension
  // APIs, so cold authority code uses the 617-byte identity surface instead of
  // parsing the 38KB compatibility implementation on every wake.
  // The agent loop is no longer reachable from the authority graph. Its exact
  // Class-E bridge and quota add one direct assembly edge, but the achieved
  // graph is four modules / ~74KB smaller overall. Values are exact, with no
  // reserved headroom. The exact +892-byte reviewed bridge delta packs large
  // plain session/model/event trees under the unchanged byte grants, avoiding
  // a false 10k-node refusal without widening controller authority.
  // The explicit vault lifecycle collaborators are the single reviewed seam
  // for demand-owned feature leases. The generated build-identity leaf lets Chrome offscreen
  // realms pin the exact background module without the unavailable
  // runtime.getManifest API. The production lease coordinator/protocol/runtime
  // add exactly three cold modules and gate every lazy host operation; this is
  // reviewed authority code, not semantic feature ownership. Values are the
  // achieved post-wiring graph and contain no headroom. Synchronous cold-event
  // ownership and sanitized recovery hints remain fixed authority work.
  // The final authority closure includes exact controller/actor lifecycle
  // settlement, stale-generation fencing, isolation admission and recovery.
  // These are fixed custody edges rather than semantic feature ownership; the
  // achieved value has no reserved headroom.
  // runtime-capability-hosts is fixed host posture; semantic-hook-manifest is
  // fixed bounded authority policy. Neither grows with controller features.
  kernel: Object.freeze({ modules: 410, graphBytes: 3_992_852, entryBytes: 200, directImports: 2 }),
  // The 8,235-byte shared schema/provenance validator rejects partial or
  // corrupt authority state before first-install actions become clickable.
  // Both shells share the exact module; the increase is reviewed integrity
  // code and these achieved values contain no headroom.
  // Two renderer frames separate module registration from the visible rich-app
  // postcondition, preventing a healthy Mithril mount from being replaced by a
  // false terminal failure. Exact shared-shell delta, no reserved headroom.
  sidepanel: Object.freeze({ modules: 11, graphBytes: 144_925, entryBytes: 396, directImports: 1 }),
  home: Object.freeze({ modules: 11, graphBytes: 145_093, entryBytes: 564, directImports: 1 }),
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
    // authored graph, before the disposable one-file package bundle.
    // Exact lifecycle settlement, stale-generation fencing, isolation
    // admission and controller recovery remain fixed authority work. Tool
    // semantics and feature owners remain outside this closure. This is the
    // exact achieved graph with no reserved headroom.
    serviceWorker: Object.freeze({ modules: 407, graphBytes: 2_011_661, entryBytes: 173 }),
    // One shared read-only authority schema/provenance validator rejects
    // corrupt or partial state before cold human controls become actionable.
    sidepanel: Object.freeze({ modules: 11, graphBytes: 136_954, entryBytes: 396 }),
    home: Object.freeze({ modules: 11, graphBytes: 137_122, entryBytes: 564 }),
    // The feature-lease supervisor owns only broker/lifecycle code; controller,
    // repository, model, job and dweb owners remain fixed lazy entries. The
    // stamped build identity replaces runtime.getManifest, which Chrome does
    // not expose in an offscreen document.
    offscreen: Object.freeze({ modules: 6, graphBytes: 19_676, entryBytes: 12_047 }),
  }),
  firefox: Object.freeze({
    serviceWorker: Object.freeze({ modules: 88, graphBytes: 406_651, entryBytes: 210 }),
    sidepanel: Object.freeze({ modules: 11, graphBytes: 140_678, entryBytes: 396 }),
    home: Object.freeze({ modules: 11, graphBytes: 140_846, entryBytes: 564 }),
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
      serviceWorker: Object.freeze({ modules: 413, graphBytes: 2_121_756, entryBytes: 207 }),
      sidepanel: Object.freeze({ modules: 11, graphBytes: 136_954, entryBytes: 396 }),
      home: Object.freeze({ modules: 11, graphBytes: 137_122, entryBytes: 564 }),
      offscreen: Object.freeze({ modules: 6, graphBytes: 19_734, entryBytes: 12_047 }),
    }),
    // Firefox has no dweb host yet, but Preview still carries its distinct
    // generated channel policy bytes.
    firefox: Object.freeze({
      serviceWorker: Object.freeze({ modules: 90, graphBytes: 412_584, entryBytes: 81 }),
      sidepanel: Object.freeze({ modules: 11, graphBytes: 140_678, entryBytes: 396 }),
      home: Object.freeze({ modules: 11, graphBytes: 140_846, entryBytes: 564 }),
    }),
  }),
});
