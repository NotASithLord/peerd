// @ts-check

// Store Firefox omits this Preview-only owner.
import './kernel-firefox-addon.js';

const CONTRIBUTOR_RECORD_KEY = 'contributor_metrics.aggregate.v1';
const CONTRIBUTOR_ACTIVE_CONSENT_KEY = 'contributor_metrics.active.v1';
const CONTRIBUTOR_STATE_PREFIX = 'contributor_metrics.state.v2.';
const CONTRIBUTOR_STORAGE_DEADLINE_MS = 750;
const CONTRIBUTOR_MAX_STATE_SNAPSHOTS = 128;
const CONTRIBUTOR_MAX_REVISION = 8_000_000_000_000_000;
const DISARMED = Object.freeze({ enabled: false, generation: null });
const exactKeys = (/** @type {unknown} */ value, /** @type {string[]} */ keys) =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const armFromRecord = (/** @type {any} */ record,
  /** @type {string|null} */ expectedGeneration = null) => {
  const consent = record?.consent;
  return Object.freeze(exactKeys(record, ['version', 'consent', 'aggregate'])
      && record.version === 1
      && exactKeys(consent, ['enabled', 'schemaVersion', 'disclosureVersion', 'generation'])
      && consent.enabled === true && consent.schemaVersion === 1
      && consent.disclosureVersion === 1 && typeof consent.generation === 'string'
      && consent.generation.length > 0 && consent.generation.length <= 200
      && (expectedGeneration === null || consent.generation === expectedGeneration)
      && record.aggregate && typeof record.aggregate === 'object'
      && !Array.isArray(record.aggregate)
    ? { enabled: true, generation: consent.generation }
    : { enabled: false, generation: null });
};

/** @template T @param {()=>Promise<T>} loader */
const deferredModule = (loader) => {
  /** @type {Promise<T>|null} */ let pending = null;
  return () => {
    pending ??= Promise.resolve().then(loader).catch((cause) => {
      pending = null;
      throw cause;
    });
    return pending;
  };
};

const firefoxContributorArm = async (/** @type {any} */ kv) => {
  const bounded = (/** @type {()=>Promise<any>} */ operation) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (/** @type {any} */ callback, /** @type {any} */ value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); callback(value);
    };
    const timer = setTimeout(() => finish(
      reject, new Error('contributor-storage-timeout'),
    ), CONTRIBUTOR_STORAGE_DEADLINE_MS);
    Promise.resolve().then(operation).then(
      (value) => finish(resolve, value), (cause) => finish(reject, cause),
    );
  });
  const snapshots = /** @type {Record<string, any>} */ (
    await bounded(() => kv.list(CONTRIBUTOR_STATE_PREFIX))
  );
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)
      || Object.keys(snapshots).length > CONTRIBUTOR_MAX_STATE_SNAPSHOTS) {
    return DISARMED;
  }
  /** @type {{key:string,value:any}|null} */ let latest = null;
  let latestProposalRevision = 0;
  for (const [key, value] of Object.entries(snapshots)) {
    const valid = key.startsWith(CONTRIBUTOR_STATE_PREFIX)
      && value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join('\0')
        === ['committed', 'record', 'revision', 'state', 'version'].join('\0')
      && value.version === 2 && Number.isSafeInteger(value.revision) && value.revision > 0
      && value.revision <= CONTRIBUTOR_MAX_REVISION
      && typeof value.committed === 'boolean'
      && ['active', 'revoked'].includes(value.state)
      && (value.state === 'revoked' ? value.record === null : !!value.record);
    if (!valid) return DISARMED;
    if (!value.committed) latestProposalRevision = Math.max(
      latestProposalRevision, value.revision,
    );
    if (value.committed && (!latest || value.revision > latest.value.revision
        || value.revision === latest.value.revision && key > latest.key)) latest = { key, value };
  }
  // why: an unresolved write may become a revocation after this realm dies.
  if (latestProposalRevision >= (latest?.value.revision ?? 0)
      && latestProposalRevision > 0) {
    return DISARMED;
  }
  if (latest) return latest.value.state === 'active'
    ? armFromRecord(latest.value.record) : DISARMED;
  const active = /** @type {any} */ (
    await bounded(() => kv.get(CONTRIBUTOR_ACTIVE_CONSENT_KEY))
  );
  if (active?.version !== 1 || typeof active.generation !== 'string'
      || active.generation.length === 0 || active.generation.length > 200) {
    return DISARMED;
  }
  return armFromRecord(
    await bounded(() => kv.get(CONTRIBUTOR_RECORD_KEY)), active.generation,
  );
};

/** @param {{contributorOwner?:()=>Promise<any>, contributorSemantic?:()=>Promise<any>}} [loaders] */
export const makeKernelFirefoxContributor = ({
  contributorOwner = () => import('./kernel-contributor-owner.js'),
  contributorSemantic = () => import('../offscreen/semantic-routes/contributor.js'),
} = {}) => {
  const loadContributorOwner = deferredModule(contributorOwner);
  const loadContributorSemantic = deferredModule(contributorSemantic);
  return (/** @type {any} */ deps) => {
  /** @type {Promise<any>|null} */ let ownerPromise = null;
  const owner = () => {
    ownerPromise ??= Promise.all([
      loadContributorOwner(), loadContributorSemantic(),
    ]).then(([ownerModule, semanticModule]) => {
      if (typeof ownerModule.createPreviewContributorRoutes !== 'function'
          || typeof semanticModule.dispatchContributorSemanticRoute !== 'function') {
        throw new TypeError('kernel-firefox-contributor-invalid');
      }
      return ownerModule.createPreviewContributorRoutes({
        ...deps, offscreenUrl: null, featureHost: null,
        dispatchSemanticRoute: semanticModule.dispatchContributorSemanticRoute,
      });
    }).catch((cause) => { ownerPromise = null; throw cause; });
    return ownerPromise;
  };
  const route = (/** @type {string} */ name) => async (
    /** @type {any} */ message, /** @type {any} */ sender,
  ) => {
    const admitted = name === 'contributor/feedback'
      ? deps.sidepanelUi(sender) || deps.homeUi(sender)
      : deps.optionsUi(sender);
    if (!admitted) return name === 'contributor/feedback'
      ? { ok: false, error: 'trusted-chat-sender-required', outcomeKnown: true }
      : { ok: false, code: 'contributor-channel-admission-denied', outcomeKnown: true };
    return (await owner()).routes[name](message, sender);
  };
    return Object.freeze({
      routes: Object.freeze({
        'contributor/status': route('contributor/status'),
        'contributor/enable': route('contributor/enable'),
        'contributor/disable': route('contributor/disable'),
        'contributor/feedback': route('contributor/feedback'),
      }),
      arm: () => firefoxContributorArm(deps.kv),
      recordWebSettlement: async (/** @type {any} */ input) =>
        (await owner()).recordWebSettlement(input),
      drainPending: async () => (await owner()).drainPending(),
      pending: async () => (await owner()).pending(),
    });
  };
};

const contributor = makeKernelFirefoxContributor();

const root = /** @type {any} */ (globalThis);
const addonId = Symbol.for('peerd.kernel.firefox-addon.v1');
const guard = root[addonId];
if (typeof guard !== 'function' || Object.hasOwn(guard, 'contributor')) {
  throw new Error('kernel-firefox-contributor-addon-owner-conflict');
}
const previewGuard = (/** @type {any[]} */ ...args) => guard(...args);
Object.defineProperties(previewGuard, Object.getOwnPropertyDescriptors(guard));
Object.defineProperty(previewGuard, 'contributor', {
  enumerable: true, value: contributor,
});
root[addonId] = Object.freeze(previewGuard);
