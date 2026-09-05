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

export const PREVIEW_KERNEL_SOURCE_CONTRACT = Object.freeze({
  // Chrome's authored graph is the same complete closure that Bun packages;
  // import() is not counted as a lazy boundary in an MV3 service worker.
  shared: Object.freeze({ modules: 403, graphBytes: 4_049_987 }),
  target: Object.freeze({ modules: 406, graphBytes: 4_140_738 }),
  // Preview-exclusive update, dweb custody and contributor consent remain
  // fixed authority. This is the exact achieved preview-only closure.
  exclusive: Object.freeze({ modules: 4, graphBytes: 91_595 }),
  entryBytesCeiling: 236,
  directImportsCeiling: 3,
});
export const FIREFOX_KERNEL_SOURCE_CONTRACT = Object.freeze({
  // Exact shared authority closure after live actor-isolation projection and
  // named executable route groups replaced duplicated host literals. The
  // retired-store list includes the unreachable pre-Git checkpoint database.
  modules: 87, graphBytes: 656_319, entryBytes: 239, directImports: 3,
});
export const PREVIEW_FIREFOX_KERNEL_SOURCE_CONTRACT = Object.freeze({
  modules: 89, graphBytes: 663_950, entryBytes: 250, directImports: 2,
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
  // Exact achieved authority graph: controller/tool semantics, completed
  // migration ledgers remain outside it; pass-through composition aliases are
  // deleted. The only construction-time deferrals are restored-tab liveness
  // transitions and the goal-runner bind; every other exact relay fails unbound.
  // Browser-child generations, runtime-capability-hosts and the semantic hook
  // manifest are fixed custody/policy inputs, not feature ownership.
  kernel: Object.freeze({ modules: 403, graphBytes: 4_049_987, entryBytes: 200, directImports: 2 }),
  // The 8,235-byte shared schema/provenance validator rejects partial or
  // corrupt authority state before first-install actions become clickable.
  // Both shells share the exact module; the increase is reviewed integrity
  // code and these achieved values contain no headroom.
  // Two renderer frames separate module registration from the visible rich-app
  // postcondition, preventing a healthy Mithril mount from being replaced by a
  // false terminal failure. Rich-app effect policy stays outside the transport-
  // only vault shell graph. Exact shared-shell values, no reserved headroom.
  sidepanel: Object.freeze({ modules: 11, graphBytes: 143_628, entryBytes: 396, directImports: 1 }),
  home: Object.freeze({ modules: 11, graphBytes: 143_796, entryBytes: 564, directImports: 1 }),
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
    // Exact lifecycle settlement, stale-generation fencing, isolation
    // admission and controller recovery remain fixed authority work. Tool
    // semantics and feature owners remain outside this closure. This is the
    // exact achieved graph with no reserved headroom. The source-action child
    // generation and bounded hostile-response reads are fixed browser custody
    // and do not grow with tool count. Finite relay validation is fixed owner
    // assembly, not a feature-selected dispatcher.
    serviceWorker: Object.freeze({
      modules: 400, graphBytes: 2_040_165, entryBytes: 173,
      inputSha256: '7b50f453b44f16ac1c81e04c8cfa1de8475ee30934ff9c117158e85f86c264cf',
    }),
    // One shared read-only authority schema/provenance validator rejects
    // corrupt or partial state before cold human controls become actionable.
    sidepanel: Object.freeze({ modules: 11, graphBytes: 135_725, entryBytes: 396 }),
    home: Object.freeze({ modules: 11, graphBytes: 135_893, entryBytes: 564 }),
    // The feature-lease supervisor owns only broker/lifecycle code; controller,
    // repository, model, job and dweb owners remain fixed lazy entries. The
    // stamped build identity replaces runtime.getManifest, which Chrome does
    // not expose in an offscreen document.
    // Exact supervisor closure with fixed document-extraction admission and
    // lease-bound Stop settlement; document parsing stays outside this graph.
    offscreen: Object.freeze({ modules: 7, graphBytes: 22_022, entryBytes: 13_318 }),
  }),
  firefox: Object.freeze({
    serviceWorker: Object.freeze({ modules: 87, graphBytes: 416_064, entryBytes: 210 }),
    sidepanel: Object.freeze({ modules: 11, graphBytes: 139_449, entryBytes: 396 }),
    home: Object.freeze({ modules: 11, graphBytes: 139_617, entryBytes: 564 }),
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
      serviceWorker: Object.freeze({
        modules: 406, graphBytes: 2_155_077, entryBytes: 207,
        inputSha256: 'f9ea6444ed31f052cf7f09936b4ecae14276b573b612fb0c981dd11d6c49d5fb',
      }),
      sidepanel: Object.freeze({ modules: 11, graphBytes: 135_725, entryBytes: 396 }),
      home: Object.freeze({ modules: 11, graphBytes: 135_893, entryBytes: 564 }),
      offscreen: Object.freeze({ modules: 7, graphBytes: 22_080, entryBytes: 13_318 }),
    }),
    // Firefox has no dweb host yet, but Preview still carries its distinct
    // generated channel policy bytes.
    firefox: Object.freeze({
      serviceWorker: Object.freeze({ modules: 89, graphBytes: 421_463, entryBytes: 81 }),
      sidepanel: Object.freeze({ modules: 11, graphBytes: 139_449, entryBytes: 396 }),
      home: Object.freeze({ modules: 11, graphBytes: 139_617, entryBytes: 564 }),
    }),
  }),
});
