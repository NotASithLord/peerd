// @ts-check

// Preview/dev Firefox alone installs the optional Contributor Metrics owner.
// Store Firefox imports only kernel-firefox-addon.js, keeping this feature and
// its schema out of the shipped event-page cold graph.
import './kernel-firefox-addon.js';

const CONTRIBUTOR_RECORD_KEY = 'contributor_metrics.aggregate.v1';
const CONTRIBUTOR_ACTIVE_CONSENT_KEY = 'contributor_metrics.active.v1';
const CONTRIBUTOR_STORAGE_DEADLINE_MS = 750;

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
  const boundedGet = (/** @type {string} */ key) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (/** @type {any} */ callback, /** @type {any} */ value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); callback(value);
    };
    const timer = setTimeout(() => finish(
      reject, new Error('contributor-storage-timeout'),
    ), CONTRIBUTOR_STORAGE_DEADLINE_MS);
    Promise.resolve().then(() => kv.get(key)).then(
      (value) => finish(resolve, value), (cause) => finish(reject, cause),
    );
  });
  const active = /** @type {any} */ (await boundedGet(CONTRIBUTOR_ACTIVE_CONSENT_KEY));
  if (active?.version !== 1 || typeof active.generation !== 'string'
      || active.generation.length === 0 || active.generation.length > 200) {
    return Object.freeze({ enabled: false, generation: null });
  }
  const record = await boundedGet(CONTRIBUTOR_RECORD_KEY);
  const consent = record?.consent;
  return Object.freeze(consent?.enabled === true && consent.schemaVersion === 1
      && consent.disclosureVersion === 1 && typeof consent.generation === 'string'
      && consent.generation.length > 0 && consent.generation.length <= 200
      && consent.generation === active.generation
      && record?.version === 1 && record.aggregate && typeof record.aggregate === 'object'
    ? { enabled: true, generation: consent.generation }
    : { enabled: false, generation: null });
};

/**
 * @param {Object} [loaders]
 * @param {()=>Promise<any>} [loaders.contributorOwner]
 * @param {()=>Promise<any>} [loaders.contributorSemantic]
 */
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
