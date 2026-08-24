// Executable cold-start policy constants shared by packaging, static graph
// tests, browser assessment, CI and release promotion. Keep numeric tuning out
// of prose and do not duplicate these ceilings elsewhere.

export const COLD_START_LANES = Object.freeze({
  local: Object.freeze({
    enforcement: 'release-safety',
    timeoutMs: 10_000, graphPolicy: 'target', requireTimingTargets: true,
    chrome: Object.freeze({ fresh: 1, wakes: 1 }),
    firefox: Object.freeze({ fresh: 1, wakes: 1, idleMs: 45_000 }),
  }),
  pr: Object.freeze({
    enforcement: 'release-safety',
    timeoutMs: 10_000, graphPolicy: 'target', requireTimingTargets: true,
    chrome: Object.freeze({ fresh: 7, wakes: 7 }),
    firefox: Object.freeze({ fresh: 7, wakes: 5, idleMs: 45_000 }),
  }),
  main: Object.freeze({
    enforcement: 'release-safety',
    timeoutMs: 10_000, graphPolicy: 'target', requireTimingTargets: true,
    chrome: Object.freeze({ fresh: 15, wakes: 15 }),
    firefox: Object.freeze({ fresh: 7, wakes: 7, idleMs: 45_000 }),
  }),
  release: Object.freeze({
    enforcement: 'release-safety',
    timeoutMs: 10_000, graphPolicy: 'target', requireTimingTargets: true,
    chrome: Object.freeze({ fresh: 15, wakes: 15 }),
    firefox: Object.freeze({ fresh: 7, wakes: 7, idleMs: 45_000 }),
  }),
});

// Local evidence contract for the intended one-module Chrome cutover artifact.
// It is deliberately separate from release lanes and changes no live ratchet.
export const NATIVE_FLOOR_CONTRACT = Object.freeze({
  schema: 1,
  runtimeTarget: 'native-floor',
  runtimeSurface: 'home',
  coldBudgetMode: 'native-target',
  browser: 'chrome',
  channel: 'store',
  freshProcesses: 3,
  confirmedStopWakes: 3,
  bundledStaticModules: 1,
  hostQuiescenceWindowMs: 1_000,
  hostLoad1PerCpuMax: 0.75,
  hostBusyFractionMax: 0.35,
  liveManifestClaimed: false,
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

// A target cutover cannot be approved from an absolute budget alone. The
// remaining comparison gate must interleave base/head on one host and browser
// population while the candidate harness packages both clean source roots with
// identical tooling. The path exists behind an explicit local comparison mode;
// `ready` stays false until a reviewed physical run proves it and required CI
// can switch without weakening the absolute ratchet.
export const COLD_START_TARGET_CUTOVER = Object.freeze({
  ready: false,
  unmetGate: 'interleaved-candidate-base',
  packagingContract: 'packageArtifact({ sourceRoot, artifactRoot, channel, browser, version })',
});

export const COLD_SOURCE_TARGETS = Object.freeze({
  // Native ESM cluster seams are deliberate: the kernel statically owns only
  // small authority adapters while sealed feature implementations remain
  // fixed-literal lazy entries. A 76-module ceiling preserves that modular
  // shape; the byte and 26 direct-edge ceilings still prevent a facade from
  // smuggling a rich feature graph back into first wake. 450 KB -> 460 KB:
  // the reviewed denylist-editor/DNR-custody and skills metadata-authority
  // adapters (route migration; no feature implementation pulled cold).
  // 76 -> 80 modules, 460 KB -> 500 KB: origin-credential custody with the
  // full DPoP key lifecycle — credential injection and nonextractable key
  // custody are kernel-owned duties, not demand-loadable feature code.
  kernel: Object.freeze({ modules: 80, graphBytes: 500_000, entryBytes: 40_000, directImports: 26 }),
  sidepanel: Object.freeze({ modules: 75, graphBytes: 650_000, entryBytes: 50_000 }),
  home: Object.freeze({ modules: 75, graphBytes: 650_000, entryBytes: 50_000 }),
  offscreen: Object.freeze({ modules: 25, graphBytes: 200_000, entryBytes: 40_000 }),
});

// Preview is the common authority kernel plus one target-owned slice. Keep the
// slice shrinking independently of common-kernel work: an absolute Preview
// total conflates those two graphs and the old total was never an achieved
// measurement. The baseline is the first executable target slice; the required
// reduction is the deletion already achieved while retaining update custody.
export const PREVIEW_KERNEL_SOURCE_CONTRACT = Object.freeze({
  exclusiveBaseline: Object.freeze({ modules: 3, graphBytes: 24_723 }),
  minimumReduction: Object.freeze({ modules: 0, graphBytes: 9_071 }),
  entryBytesCeiling: 146,
  directImportsCeiling: 2,
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

export const LEGACY_COLD_SOURCE_RATCHETS = Object.freeze({
  // Repository/isomorphic-git moved behind the authenticated lazy host. The
  // browser-neutral vault auto-lock normalizer is one reviewed leaf shared by
  // legacy settings and the future authority kernel; it adds exactly one
  // module without adding any semantic/provider/Git ownership. The graph and
  // entry values are the achieved post-split values with no headroom.
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
  // The explicit vault lifecycle collaborators add the measured 864-byte graph
  // delta (455 bytes in the entry) while preserving legacy fallback behavior;
  // they are the single seam where the feature-lease cutover will attach. The
  // additional 466-byte generated build-identity leaf lets Chrome offscreen
  // realms pin the exact background module without the unavailable
  // runtime.getManifest API. The production lease coordinator/protocol/runtime
  // add exactly three cold modules and gate every lazy host operation; this is
  // reviewed authority code, not semantic feature ownership. Values are the
  // achieved post-wiring graph and contain no headroom. The three additional
  // cold-listener modules replace 33 duplicate browser registrations with one
  // synchronous fan-in per event and persist only sanitized recovery hints;
  // they add no semantic/provider/Git ownership.
  // 4_316_649 -> 4_319_311: the legacy-lane fixes that made every turn's
  // controller handshake and lease lifecycle survive host replacement (state
  // contract retryable placeholder, connect retry, leased-client refcount,
  // scope-tightened realm retirement), plus the live actor-isolation getter
  // that unfroze the snapshot's capability projection.
  kernel: Object.freeze({ modules: 456, graphBytes: 4_319_560, entryBytes: 467_968, directImports: 111 }),
  // The 8,235-byte shared schema/provenance validator rejects partial or
  // corrupt authority state before first-install actions become clickable.
  // Both shells share the exact module; the increase is reviewed integrity
  // code and these achieved values contain no headroom.
  // Two renderer frames separate module registration from the visible rich-app
  // postcondition, preventing a healthy Mithril mount from being replaced by a
  // false terminal failure. Exact shared-shell delta, no reserved headroom.
  sidepanel: Object.freeze({ modules: 11, graphBytes: 157_565, entryBytes: 407, directImports: 1 }),
  home: Object.freeze({ modules: 11, graphBytes: 157_733, entryBytes: 575, directImports: 1 }),
});

// A cold authority wake is a UX boundary: shell, bootstrap, state, and the
// actionable vault gate must each finish within three seconds on the pinned
// local browser/toolchain. Byte ceilings support this outcome; they do not
// justify a more complicated architecture when the timing gate already passes.
export const COLD_START_TARGETS = Object.freeze({
  chrome: Object.freeze({
    // 200 KB remains the simplification goal, not a reason to add brittle
    // indirection. The release guard permits the current straightforward ESM
    // design only while it remains below 300 KB and meets the 3-second gate.
    serviceWorker: Object.freeze({ modules: 80, graphBytes: 300_000, entryBytes: 30_000 }),
    sidepanel: Object.freeze({ modules: 75, graphBytes: 300_000, entryBytes: 50_000 }),
    home: Object.freeze({ modules: 75, graphBytes: 300_000, entryBytes: 50_000 }),
    offscreen: Object.freeze({ modules: 25, graphBytes: 100_000, entryBytes: 25_000 }),
    timing: Object.freeze({ usableMaxMs: 3_000 }),
  }),
  firefox: Object.freeze({
    serviceWorker: Object.freeze({ modules: 80, graphBytes: 300_000, entryBytes: 30_000 }),
    sidepanel: Object.freeze({ modules: 75, graphBytes: 300_000, entryBytes: 50_000 }),
    home: Object.freeze({ modules: 75, graphBytes: 300_000, entryBytes: 50_000 }),
    timing: Object.freeze({ usableMaxMs: 3_000 }),
  }),
});

export const LEGACY_COLD_GRAPH_RATCHETS = Object.freeze({
  chrome: Object.freeze({
    // The agent loop moved behind the sealed lazy turn controller; the explicit
    // vault lifecycle seam remains in the entry. The generated 213-byte build
    // identity leaf is shared with exact background provenance. Exact
    // four-cell measurement, with no reserved headroom.
    serviceWorker: Object.freeze({ modules: 450, graphBytes: 1_680_949, entryBytes: 188_885 }),
    // One shared read-only authority schema/provenance validator rejects
    // corrupt or partial state before cold human controls become actionable.
    sidepanel: Object.freeze({ modules: 11, graphBytes: 140_331, entryBytes: 407 }),
    home: Object.freeze({ modules: 11, graphBytes: 140_499, entryBytes: 575 }),
    // The feature-lease supervisor owns only broker/lifecycle code; controller,
    // repository, model, job and dweb owners remain fixed lazy entries. The
    // stamped build identity replaces runtime.getManifest, which Chrome does
    // not expose in an offscreen document.
    offscreen: Object.freeze({ modules: 9, graphBytes: 32_741, entryBytes: 15_570 }),
  }),
  firefox: Object.freeze({
    serviceWorker: Object.freeze({ modules: 447, graphBytes: 1_660_833, entryBytes: 186_250 }),
    sidepanel: Object.freeze({ modules: 11, graphBytes: 140_331, entryBytes: 407 }),
    home: Object.freeze({ modules: 11, graphBytes: 140_499, entryBytes: 575 }),
  }),
});

// Packaging runs every channel/browser cell. Preview Chrome carries the real
// dweb loader while Store carries the reviewed stub, so their otherwise equal
// cold graphs differ by the exact generated loader bytes. Keep a separate
// no-growth fence for every shipped cell instead of granting the smaller Store
// build unused headroom.
export const LEGACY_PACKAGE_COLD_GRAPH_RATCHETS = Object.freeze({
  store: LEGACY_COLD_GRAPH_RATCHETS,
  preview: Object.freeze({
    chrome: Object.freeze({
      serviceWorker: Object.freeze({ modules: 453, graphBytes: 1_714_810, entryBytes: 188_885 }),
      sidepanel: Object.freeze({ modules: 11, graphBytes: 140_331, entryBytes: 407 }),
      home: Object.freeze({ modules: 11, graphBytes: 140_499, entryBytes: 575 }),
      offscreen: Object.freeze({ modules: 9, graphBytes: 32_741, entryBytes: 15_570 }),
    }),
    // Firefox has no dweb host yet, but Preview still carries its distinct
    // generated channel policy bytes.
    firefox: Object.freeze({
      serviceWorker: Object.freeze({ modules: 447, graphBytes: 1_660_859, entryBytes: 186_250 }),
      sidepanel: Object.freeze({ modules: 11, graphBytes: 140_331, entryBytes: 407 }),
      home: Object.freeze({ modules: 11, graphBytes: 140_499, entryBytes: 575 }),
    }),
  }),
});
