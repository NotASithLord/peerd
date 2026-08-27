// @ts-check

import { controllerPayloadBytes, parseControllerAuthority } from './structured-clone-size.js';
import {
  KERNEL_ADMINISTRATIVE_ROUTE_NAMES,
  KERNEL_DWEB_ROUTE_NAMES,
  KERNEL_EXECUTABLE_ROUTE_NAMES,
  KERNEL_LOCAL_ROUTE_NAMES,
  KERNEL_REPOSITORY_ROUTE_NAMES,
  KERNEL_SESSION_SUPPORT_ROUTE_NAMES,
} from './kernel-feature-route-inventory.js';

export { KERNEL_ADMINISTRATIVE_ROUTE_NAMES } from './kernel-feature-route-inventory.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const SESSION_READ_BYTES = Number.POSITIVE_INFINITY;
const OWNER_ID = 'peerd-authority-kernel';
const DISPATCH_ID = /^[A-Za-z0-9._-]{8,512}$/;
export const KERNEL_FEATURE_DISPATCH_CAPABILITY = 'feature.dispatch';

export const KERNEL_FEATURE_ROOT_CAPABILITIES = Object.freeze({
  production: Object.freeze(['turn.run', 'runtime.dispatch']),
  semantic: Object.freeze(['semantic.dispatch', 'turn.run']),
  executable: Object.freeze([KERNEL_FEATURE_DISPATCH_CAPABILITY, 'runtime.dispatch']),
  support: Object.freeze([KERNEL_FEATURE_DISPATCH_CAPABILITY]),
  administrative: Object.freeze([KERNEL_FEATURE_DISPATCH_CAPABILITY]),
  repository: Object.freeze([KERNEL_FEATURE_DISPATCH_CAPABILITY]),
  local: Object.freeze([KERNEL_FEATURE_DISPATCH_CAPABILITY]),
  dweb: Object.freeze([KERNEL_FEATURE_DISPATCH_CAPABILITY]),
});

const READ_ROUTES = new Set([
  'app/editor/read', 'app/editor/list', 'lifecycle/assert-opfs-writable',
  'vm/get-meta', 'site-client/list', 'denylist/list', 'commands/list',
  'composer/files', 'composer/tabs', 'session/list', 'session/get',
  'session/contextSnapshots',
  'pod/get-meta', 'export/artifact', 'import/inspect', 'hooks/list',
  'apps/repository/status', 'apps/repository/history', 'apps/repository/diff',
  'models/options', 'models/state-projection', 'openrouter/models', 'local-model/catalog',
  'local-model/probe', 'local-model/status',
  'dweb/base/find', 'dweb/base/heard', 'dweb/base/status', 'dweb/base/updates',
  'dweb/distributed/info', 'dweb/self-prepare-offer', 'dweb/self-read-surface',
  'dweb/self-status',
]);
const LARGE_ROUTES = new Set([
  'app/editor/read', 'app/editor/list', 'app/editor/write', 'app/editor/delete',
  'app/editor-write', 'app/editor-delete', 'composer/files',
  'session/list', 'session/get', 'session/contextSnapshots',
  'export/artifact', 'import/inspect', 'import/apply',
  'dweb/app-install', 'dweb/app-snapshot', 'dweb/app-update',
]);
const effectPolicy = (/** @type {string[]} */ inputKeys, /** @type {number} */ calls = 1,
  /** @type {number} */ inputBytes = 256 * KIB,
  /** @type {number} */ resultBytes = 256 * KIB,
  /** @type {(input:Record<string,any>)=>boolean} */ validate = () => true,
  /** @type {'read'|'commit'} */ risk = 'commit',
  /** @type {(result:unknown)=>boolean} */ validateResult = () => true) => Object.freeze({
  inputBytes, inputKeys: Object.freeze(inputKeys), resultBytes,
  calls, concurrent: 1, validate, validateResult, risk,
});
const readEffectPolicy = (/** @type {string[]} */ inputKeys, /** @type {number} */ calls = 1,
  /** @type {number} */ inputBytes = 256 * KIB,
  /** @type {number} */ resultBytes = 256 * KIB,
  /** @type {(input:Record<string,any>)=>boolean} */ validate = () => true,
  /** @type {(result:unknown)=>boolean} */ validateResult = () => true) =>
  effectPolicy(inputKeys, calls, inputBytes, resultBytes, validate, 'read', validateResult);
const nestedExactKeys = (/** @type {Record<string,any>} */ value,
  /** @type {string[]} */ required, /** @type {string[]} */ optional = []) => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};
/** @param {unknown} value */
export const validAdministrativeHookRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hook = /** @type {Record<string,any>} */ (value);
  if (!nestedExactKeys(hook, ['id', 'event', 'enabled', 'kind', 'doc'], [
    'order', 'match', 'trusted', 'body', 'rule',
  ]) || typeof hook.id !== 'string' || !hook.id || hook.id.length > 128
      || (hook.event !== 'pre-tool-use' && hook.event !== 'post-tool-use')
      || typeof hook.enabled !== 'boolean'
      || typeof hook.doc !== 'string' || hook.doc.length > 64 * KIB
      || (hook.order !== undefined && (!Number.isFinite(hook.order)
        || Math.abs(hook.order) > 1_000_000))
      || (hook.match !== undefined
        && (typeof hook.match !== 'string' || hook.match.length > 1024))) return false;
  if (hook.kind === 'js') {
    return hook.trusted === true && typeof hook.body === 'string'
      && hook.body.trim().length > 0 && hook.body.length <= 64 * KIB
      && hook.rule === undefined;
  }
  if (hook.kind !== 'declarative' || hook.trusted !== undefined || hook.body !== undefined
      || !hook.rule || typeof hook.rule !== 'object' || Array.isArray(hook.rule)) return false;
  const rule = /** @type {Record<string,any>} */ (hook.rule);
  return nestedExactKeys(rule, ['matchArg', 'pattern'], ['onMatch', 'reason'])
    && typeof rule.matchArg === 'string' && rule.matchArg.length > 0
    && rule.matchArg.length <= 256
    && typeof rule.pattern === 'string' && rule.pattern.length <= 4096
    && (rule.onMatch === undefined || rule.onMatch === 'block' || rule.onMatch === 'allow')
    && (rule.reason === undefined
      || (typeof rule.reason === 'string' && rule.reason.length <= 4096));
};
const validAdministrativeHookSource = (/** @type {unknown} */ value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = /** @type {Record<string,any>} */ (value);
  return nestedExactKeys(source, ['markdown'])
    ? typeof source.markdown === 'string' && source.markdown.length <= 256 * KIB
    : nestedExactKeys(source, ['record']) && validAdministrativeHookRecord(source.record);
};
const hookMutationEffects = (/** @type {string} */ operation, /** @type {string[]} */ keys,
  /** @type {(input:Record<string,any>)=>boolean} */ validate) => Object.freeze({
  'administrative.hooks.read': readEffectPolicy([], 1),
  [operation]: effectPolicy(keys, 1, 256 * KIB, 256 * KIB, validate),
});
const ADMINISTRATIVE_EFFECTS = Object.freeze({
  'hooks/list': Object.freeze({
    'administrative.hooks.read': readEffectPolicy([], 1),
  }),
  'hooks/save': hookMutationEffects(
    'administrative.hooks.save', ['source'],
    (/** @type {Record<string,any>} */ input) => validAdministrativeHookSource(input.source),
  ),
  'hooks/remove': hookMutationEffects(
    'administrative.hooks.remove', ['id'],
    (/** @type {Record<string,any>} */ input) => typeof input.id === 'string'
      && input.id.length > 0 && input.id.length <= 128,
  ),
  'hooks/toggle': hookMutationEffects(
    'administrative.hooks.toggle', ['id', 'enabled'],
    (/** @type {Record<string,any>} */ input) => typeof input.id === 'string'
      && input.id.length > 0 && input.id.length <= 128
      && typeof input.enabled === 'boolean',
  ),
  'memory/init': Object.freeze({
    'administrative.memory.probeTab': readEffectPolicy([], 1, 16 * KIB, 64 * KIB),
    'administrative.memory.listApps': readEffectPolicy([], 1, 16 * KIB, 256 * KIB),
    'administrative.memory.commitInit': effectPolicy(
      ['workspace', 'body', 'checklist'], 1, 512 * KIB, 512 * KIB,
      (input) => typeof input.workspace === 'string' && input.workspace.length > 0
        && input.workspace.length <= 4096
        && typeof input.body === 'string' && input.body.length <= 256 * KIB
        && Array.isArray(input.checklist) && input.checklist.length <= 256
        && input.checklist.every((item) => typeof item === 'string' && item.length <= 4096),
    ),
    'administrative.memory.note': effectPolicy(
      ['text'], 4, 32 * KIB, 16 * KIB, (input) => typeof input.text === 'string',
    ),
  }),
  'skills/installGit': Object.freeze({}),
  'skills/installLocal': Object.freeze({
    'administrative.skills.commit': effectPolicy(
      ['text', 'origin', 'replace'], 1, 2 * MIB, 512 * KIB,
      (input) => typeof input.text === 'string' && typeof input.origin === 'string'
        && input.text.length <= MIB && input.origin.length <= 4096
        && typeof input.replace === 'boolean',
    ),
  }),
  'skills/installManifest': Object.freeze({}),
});
const string = (/** @type {unknown} */ value, /** @type {number} */ max = 4096) =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const nullableString = (/** @type {unknown} */ value, /** @type {number} */ max = 4096) =>
  value === null || typeof value === 'string' && value.length <= max;
const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string,any>} */ (value) : null;
const exactKeys = (/** @type {Record<string,any>} */ value, /** @type {string[]} */ keys) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const sessionManifest = (/** @type {unknown} */ value) => {
  if (value === null) return true;
  const manifest = record(value);
  return !!manifest && nestedExactKeys(manifest, [], ['preset', 'allow'])
    && Object.keys(manifest).length > 0
    && (manifest.preset === undefined || string(manifest.preset, 128))
    && (manifest.allow === undefined || Array.isArray(manifest.allow)
      && manifest.allow.length <= 512
      && manifest.allow.every((name) => string(name, 128)));
};
const sessionListCandidate = (/** @type {unknown} */ value) => {
  const session = record(value);
  return !!session && exactKeys(session, [
    'kind', 'sessionId', 'title', 'createdAt', 'lastMessageAt', 'messageCount',
    'archivedAt', 'provider', 'model', 'hasCustomSystemPrompt', 'toolManifest',
  ])
    && ['chat', 'actor', 'spawned'].includes(session.kind)
    && string(session.sessionId, 512)
    && nullableString(session.title, 64 * KIB)
    && Number.isFinite(session.createdAt)
    && Number.isFinite(session.lastMessageAt)
    && Number.isSafeInteger(session.messageCount) && session.messageCount >= 0
    && (session.archivedAt === undefined || Number.isFinite(session.archivedAt))
    && typeof session.provider === 'string' && session.provider.length <= 128
    && typeof session.model === 'string' && session.model.length <= 512
    && typeof session.hasCustomSystemPrompt === 'boolean'
    && sessionManifest(session.toolManifest);
};
const appId = (/** @type {Record<string,any>} */ input) =>
  typeof input.appId === 'string' && input.appId.length <= 256;
const repositoryEffect = (/** @type {string} */ operation, /** @type {string[]} */ keys,
  /** @type {(input:Record<string,any>)=>boolean} */ validate, calls = 1) => Object.freeze({
  [operation]: effectPolicy(keys, calls, 512 * KIB, 8 * MIB, validate),
});
const REPOSITORY_EFFECTS = Object.freeze({
  'apps/repository/status': repositoryEffect('repository.status', ['appId'], appId),
  'apps/repository/history': repositoryEffect(
    'repository.history', ['appId', 'depth'],
    (input) => appId(input) && Number.isInteger(input.depth) && input.depth >= 1 && input.depth <= 100,
  ),
  'apps/repository/diff': repositoryEffect(
    'repository.diff', ['appId', 'from', 'to'],
    (input) => appId(input) && string(input.from, 512) && nullableString(input.to, 512),
  ),
  'apps/repository/commit': repositoryEffect(
    'repository.commit', ['appId', 'message'],
    (input) => appId(input) && string(input.message, 4096),
  ),
  'apps/repository/restore': repositoryEffect(
    'repository.restore', ['appId', 'to'],
    (input) => appId(input) && typeof input.to === 'string' && input.to.length <= 512,
  ),
  'apps/repository/branch': repositoryEffect(
    'repository.branch', ['appId', 'name', 'checkout'],
    (input) => appId(input) && typeof input.name === 'string' && input.name.length <= 512
      && typeof input.checkout === 'boolean',
  ),
  'apps/repository/checkout': repositoryEffect(
    'repository.checkout', ['appId', 'name'],
    (input) => appId(input) && typeof input.name === 'string' && input.name.length <= 512,
  ),
  'apps/repository/link': repositoryEffect(
    'repository.link', ['appId', 'url'],
    (input) => appId(input) && typeof input.url === 'string' && input.url.length <= 4096,
  ),
  'apps/repository/fetch': repositoryEffect('repository.fetch', ['appId'], appId),
  'apps/repository/push': repositoryEffect(
    'repository.push', ['appId', 'branch'],
    (input) => appId(input) && nullableString(input.branch, 512),
  ),
  'apps/import-git': Object.freeze({
    'repository.import': effectPolicy(
      ['name', 'url', 'ref', 'depth'], 1, 64 * KIB, 8 * MIB,
      (input) => nullableString(input.name, 512)
        && typeof input.url === 'string' && input.url.length <= 4096
        && nullableString(input.ref, 512) && Number.isInteger(input.depth)
        && input.depth >= 1 && input.depth <= 500,
    ),
  }),
});
const LOCAL_EFFECTS = Object.freeze({
  'models/state-projection': Object.freeze({}),
  'provider/test': Object.freeze({
    'local.provider.test': effectPolicy(
      ['provider', 'model', 'nativeBody'], 1, 32 * MIB, MIB,
      (input) => string(input.provider, 64) && string(input.model, 256)
        && !!input.nativeBody && typeof input.nativeBody === 'object'
        && !Array.isArray(input.nativeBody),
    ),
    'local.models.ollama': readEffectPolicy([], 1, 16 * KIB, MIB),
    'local.models.observe-ollama': readEffectPolicy(
      ['known', 'reachable', 'count', 'models'], 1, 256 * KIB, 4 * KIB,
      (input) => typeof input.known === 'boolean' && typeof input.reachable === 'boolean'
        && (input.count === null || Number.isSafeInteger(input.count))
        && (input.models === null || Array.isArray(input.models)),
    ),
  }),
  'models/options': Object.freeze({
    'local.models.snapshot': effectPolicy(
      ['sessionId'], 1, 16 * KIB, 512 * KIB,
      (input) => nullableString(input.sessionId, 256),
    ),
    'local.models.ollama': effectPolicy(
      [], 1, 16 * KIB, MIB,
    ),
    'local.models.observe-ollama': readEffectPolicy(
      ['known', 'reachable', 'count', 'models'], 1, 256 * KIB, 4 * KIB,
      (input) => typeof input.known === 'boolean' && typeof input.reachable === 'boolean'
        && (input.count === null || Number.isSafeInteger(input.count))
        && (input.models === null || Array.isArray(input.models)),
    ),
  }),
  'openrouter/models': Object.freeze({
    'local.openrouter.models': effectPolicy([], 1, 16 * KIB, 4 * MIB),
  }),
  'local-model/status': Object.freeze({
    'local.model.status': effectPolicy(
      ['model', 'includeSupport'], 1, 16 * KIB, MIB,
      (input) => nullableString(input.model, 256) && typeof input.includeSupport === 'boolean',
    ),
  }),
  'local-model/catalog': Object.freeze({
    'local.model.catalog': effectPolicy(
      ['includeSupport'], 1, 16 * KIB, MIB,
      (input) => typeof input.includeSupport === 'boolean',
    ),
  }),
  'local-model/probe': Object.freeze({
    'local.model.probe': effectPolicy([], 1, 16 * KIB, MIB),
  }),
  'local-model/init': Object.freeze({
    'local.model.init': effectPolicy(
      ['model'], 1, 16 * KIB, MIB,
      (input) => nullableString(input.model, 256),
    ),
  }),
});
const validPermissionPatch = (/** @type {unknown} */ value) => {
  const patch = record(value);
  return !!patch && nestedExactKeys(patch, [], ['permissionMode', 'confirmActions'])
    && Object.keys(patch).length > 0
    && (!Object.hasOwn(patch, 'permissionMode')
      || patch.permissionMode === 'plan' || patch.permissionMode === 'act')
    && (!Object.hasOwn(patch, 'confirmActions')
      || typeof patch.confirmActions === 'boolean');
};
const RESULT_ERROR_KEYS = new Set(['ok', 'outcomeKnown', 'code', 'error', 'retryable', 'phase']);
const effectResult = (/** @type {(value:unknown)=>boolean} */ validateValue) =>
  (/** @type {unknown} */ value) => {
    const result = record(value);
    if (!result) return false;
    if (result.ok === true) {
      return result.outcomeKnown === true
        && exactKeys(result, ['ok', 'outcomeKnown', 'value']) && validateValue(result.value);
    }
    if (result.ok !== false || typeof result.outcomeKnown !== 'boolean'
        || typeof result.code !== 'string' || !result.code || result.code.length > 128) return false;
    return Object.keys(result).every((key) => RESULT_ERROR_KEYS.has(key))
      && (result.error === undefined || typeof result.error === 'string')
      && (result.retryable === undefined || typeof result.retryable === 'boolean')
      && (result.phase === undefined || result.phase === 'startup' || result.phase === 'run');
  };
const statusValue = (/** @type {string[]} */ statuses,
  /** @type {string|null} */ valueKey = null,
  /** @type {(value:unknown)=>boolean} */ validateValue = () => true) =>
  (/** @type {unknown} */ value) => {
    const result = record(value);
    if (!result) return false;
    if (!statuses.includes(result.status)) return false;
    if (result.status !== 'ok') return exactKeys(result, ['status']);
    return valueKey !== null && exactKeys(result, ['status', valueKey])
      && validateValue(result[valueKey]);
  };
const listResult = effectResult((value) => {
  const result = record(value);
  return !!result && exactKeys(result, ['status', 'candidates'])
    && Array.isArray(result.candidates)
    && (result.status === 'locked' ? result.candidates.length === 0
      : result.status === 'ok' && result.candidates.every(sessionListCandidate));
});
const sessionReadResult = effectResult(statusValue(
  ['locked', 'invalid', 'not-found', 'ok'], 'session',
  (value) => {
    const session = record(value);
    return !!session && string(session.sessionId, 512) && Array.isArray(session.messages);
  },
));
const snapshotsResult = effectResult(statusValue(
  ['locked', 'invalid', 'not-found', 'ok'], 'snapshots', Array.isArray,
));
const modelResult = effectResult(statusValue([
  'locked', 'no-session', 'invalid-model', 'not-found', 'updated',
]));
const permissionResult = effectResult((value) => {
  const result = record(value);
  return !!result && exactKeys(result, ['mode', 'confirmActions'])
    && (result.mode === 'plan' || result.mode === 'act')
    && typeof result.confirmActions === 'boolean';
});
const SUPPORT_EFFECTS = Object.freeze({
  'session/list': Object.freeze({
    'support.sessions.list': readEffectPolicy([], 1, 16 * KIB, 8 * MIB, undefined, listResult),
  }),
  'session/get': Object.freeze({
    'support.session.read': readEffectPolicy(
      ['sessionId'], 1, MIB, SESSION_READ_BYTES,
      (input) => input.sessionId === null
        || typeof input.sessionId === 'string' && input.sessionId.length > 0, sessionReadResult,
    ),
  }),
  'session/contextSnapshots': Object.freeze({
    'support.session.context-snapshots': readEffectPolicy(
      ['sessionId'], 1, 8 * MIB, 8 * MIB,
      (input) => input.sessionId === null
        || typeof input.sessionId === 'string' && input.sessionId.length > 0, snapshotsResult,
    ),
  }),
  'session/setModel': Object.freeze({
    'support.session.model.commit': effectPolicy(
      ['sessionId', 'model'], 1, MIB, 16 * KIB,
      (input) => (input.sessionId === null
        || typeof input.sessionId === 'string' && input.sessionId.length > 0)
        && nullableString(input.model, 200),
      'commit', modelResult,
    ),
  }),
  'permission/set': Object.freeze({
    'support.permission.commit': effectPolicy(
      ['patch'], 1, 16 * KIB, 16 * KIB,
      (input) => validPermissionPatch(input.patch), 'commit', permissionResult,
    ),
  }),
});
const routeOperation = (/** @type {string} */ cluster, /** @type {string} */ route) =>
  `feature.${cluster}.${route.replaceAll('/', '.')}`;
const routePolicy = (/** @type {string} */ cluster, /** @type {string} */ route) => {
  const administrative = cluster === 'administrative';
  const repository = cluster === 'repository';
  const local = cluster === 'local';
  const support = cluster === 'support';
  const large = LARGE_ROUTES.has(route) || route === 'skills/installLocal' || repository;
  const bytes = repository || support && large ? 8 * MIB
    : support ? MIB : large ? 4 * MIB : 256 * KIB;
  const resultBytes = support && route === 'session/get' ? SESSION_READ_BYTES : bytes;
  const operation = routeOperation(cluster, route);
  return Object.freeze({
    inputBytes: bytes,
    resultBytes,
    concurrent: READ_ROUTES.has(route) ? 8 : 1,
    maxDurationMs: route === 'memory/init' ? 30 * 60_000
      : repository || route === 'local-model/init' ? 120_000 : 60_000,
    replayClass: /** @type {'A'|'E'} */ (READ_ROUTES.has(route) ? 'A' : 'E'),
    effects: administrative ? ADMINISTRATIVE_EFFECTS[/** @type {keyof typeof ADMINISTRATIVE_EFFECTS} */ (route)]
      : repository ? REPOSITORY_EFFECTS[/** @type {keyof typeof REPOSITORY_EFFECTS} */ (route)]
        : local ? LOCAL_EFFECTS[/** @type {keyof typeof LOCAL_EFFECTS} */ (route)]
          : support ? SUPPORT_EFFECTS[/** @type {keyof typeof SUPPORT_EFFECTS} */ (route)] : Object.freeze({
      [operation]: effectPolicy(['value'], 1, bytes, bytes),
    }),
  });
};

const routeEntries = [
  ['support', KERNEL_SESSION_SUPPORT_ROUTE_NAMES],
  ['executable', KERNEL_EXECUTABLE_ROUTE_NAMES],
  ['administrative', KERNEL_ADMINISTRATIVE_ROUTE_NAMES],
  ['repository', KERNEL_REPOSITORY_ROUTE_NAMES],
  ['local', KERNEL_LOCAL_ROUTE_NAMES],
  ['dweb', KERNEL_DWEB_ROUTE_NAMES],
].flatMap(([cluster, routes]) => /** @type {readonly string[]} */ (routes).map((route) => [
  `${cluster}\0${route}`, routePolicy(/** @type {string} */ (cluster), route),
]));
const ROUTE_POLICIES = Object.freeze(Object.fromEntries(routeEntries));
const bounded = (/** @type {unknown} */ value, /** @type {number} */ maxBytes) => {
  if (maxBytes === Number.POSITIVE_INFINITY) return true;
  const bytes = controllerPayloadBytes(value, {
    maxDepth: 32,
    maxNodes: Number.isFinite(maxBytes)
      ? Math.max(250_000, Math.ceil(maxBytes / 32)) : Number.POSITIVE_INFINITY,
  });
  return Number.isFinite(bytes) && bytes <= maxBytes;
};
const targetFor = (/** @type {string} */ kind, /** @type {string} */ name,
  /** @type {string|undefined} */ dispatchId = undefined) =>
  `kernel-feature:${kind}:${name}${dispatchId ? `:${dispatchId}` : ''}`;
const parsedAuthority = (/** @type {any} */ policy, /** @type {string} */ target) => Object.freeze({
  ownerId: OWNER_ID,
  sessionId: null,
  instanceId: null,
  origin: null,
  target,
  replayClass: policy.replayClass,
});

/** @param {unknown} value */
export const parseKernelFeatureDispatch = (value) => {
  const input = record(value);
  if (!input || !exactKeys(input, ['cluster', 'route', 'dispatchId', 'message'])
      || typeof input.cluster !== 'string' || typeof input.route !== 'string'
      || typeof input.dispatchId !== 'string' || !DISPATCH_ID.test(input.dispatchId)
      || !record(input.message)) return null;
  const policy = ROUTE_POLICIES[`${input.cluster}\0${input.route}`];
  if (!policy || !bounded(input.message, policy.inputBytes)) return null;
  return Object.freeze({
    cluster: input.cluster,
    route: input.route,
    dispatchId: input.dispatchId, message: input.message,
    policy,
    authority: parsedAuthority(policy, targetFor(input.cluster, input.route, input.dispatchId)),
  });
};

export const parseKernelFeatureCall = (/** @type {string} */ capability,
  /** @type {unknown} */ value) => capability === KERNEL_FEATURE_DISPATCH_CAPABILITY
  ? parseKernelFeatureDispatch(value) : null;

export const kernelFeaturePayloadAllowed = (/** @type {string} */ capability,
  /** @type {unknown} */ value) => parseKernelFeatureCall(capability, value) !== null;

export const kernelFeatureAuthorityFor = (/** @type {string} */ capability,
  /** @type {unknown} */ value) => parseKernelFeatureCall(capability, value)?.authority ?? null;

export const kernelFeatureAuthorityAllowed = (/** @type {string} */ capability,
  /** @type {unknown} */ request, /** @type {unknown} */ value) => {
  const expected = parseKernelFeatureCall(capability, request)?.authority;
  const actual = parseControllerAuthority(value);
  return !!expected && !!actual
    && actual.ownerId === expected.ownerId
    && actual.sessionId === expected.sessionId
    && actual.instanceId === expected.instanceId
    && actual.origin === expected.origin
    && actual.target === expected.target
    && actual.replayClass === expected.replayClass;
};

export const kernelFeatureEffectAllowed = (/** @type {unknown} */ authority,
  /** @type {string} */ operation, /** @type {unknown} */ payload,
  /** @type {unknown} */ request = undefined) => {
  const actual = parseControllerAuthority(authority);
  if (!actual || actual.ownerId !== OWNER_ID || typeof actual.target !== 'string'
      || !actual.target.startsWith('kernel-feature:')) return false;
  const [cluster, route, dispatchId, ...rest] = actual.target
    .slice('kernel-feature:'.length).split(':');
  const parsed = request === undefined ? null : parseKernelFeatureDispatch(request);
  const policy = rest.length === 0 && DISPATCH_ID.test(dispatchId ?? '')
    ? ROUTE_POLICIES[`${cluster}\0${route}`] : null;
  const effect = policy?.effects?.[operation];
  const input = record(payload);
  return !!policy && actual.replayClass === policy.replayClass
    && (!parsed || parsed.cluster === cluster && parsed.route === route
      && parsed.dispatchId === dispatchId && actual.target === parsed.authority.target)
    && actual.sessionId === null && actual.instanceId === null && actual.origin === null
    && !!effect && !!input && exactKeys(input, [...effect.inputKeys]) && effect.validate(input)
    && bounded(input, effect.inputBytes);
};

export const kernelFeatureDispatchIdFromAuthority = (/** @type {unknown} */ authority) => {
  const actual = parseControllerAuthority(authority);
  if (!actual || typeof actual.target !== 'string'
      || !actual.target.startsWith('kernel-feature:')) return null;
  const parts = actual.target.slice('kernel-feature:'.length).split(':');
  return parts.length === 3 && DISPATCH_ID.test(parts[2]) ? parts[2] : null;
};

const refused = (/** @type {string} */ code, /** @type {boolean} */ known = true) =>
  Object.freeze({ ok: false, code, outcomeKnown: known });

export const createKernelFeatureEffectQuota = (/** @type {string} */ capability,
  /** @type {unknown} */ request) => {
  const parsed = parseKernelFeatureCall(capability, request);
  const effects = /** @type {Record<string,any>} */ (parsed?.policy.effects ?? {});
  const calls = new Map();
  const pending = new Map();
  let pendingLoss = 0;
  let settledLoss = false;
  let unknownLoss = false;
  const pendingCap = Object.values(effects).reduce(
    (sum, effect) => sum + Number(/** @type {any} */ (effect).concurrent), 0,
  );
  const admit = (/** @type {string} */ operation, /** @type {unknown} */ payload) => {
    const effect = effects[operation];
    const input = record(payload);
    if (!effect || !input || !exactKeys(input, [...effect.inputKeys])) {
      return refused('feature-effect-denied');
    }
    if (!effect.validate(input)) return refused('feature-effect-denied');
    if (!bounded(input, effect.inputBytes)) return refused('feature-effect-payload-too-large');
    const used = calls.get(operation) ?? 0;
    if (used >= effect.calls) return refused('feature-effect-budget-exhausted');
    const active = pending.get(operation) ?? 0;
    if (active >= effect.concurrent) return refused('feature-effect-concurrency-exhausted');
    calls.set(operation, used + 1);
    pending.set(operation, active + 1);
    if (effect.risk !== 'read') pendingLoss += 1;
    return Object.freeze({ ok: true, outcomeKnown: true });
  };
  const observe = (/** @type {string} */ operation, /** @type {unknown} */ _payload,
    /** @type {unknown} */ result) => {
    const effect = effects[operation];
    if (!effect) return refused('feature-effect-denied', false);
    const active = pending.get(operation) ?? 0;
    if (active > 1) pending.set(operation, active - 1);
    else pending.delete(operation);
    const accepted = bounded(result, effect.resultBytes) && effect.validateResult(result);
    if (effect.risk !== 'read') {
      pendingLoss = Math.max(0, pendingLoss - 1);
      const reply = record(result);
      if (!accepted || reply?.outcomeKnown !== true) unknownLoss = true;
      else if (reply.ok === true || reply.retryable !== true) settledLoss = true;
    }
    return accepted
      ? Object.freeze({ ok: true, outcomeKnown: true })
      : refused(bounded(result, effect.resultBytes)
        ? 'feature-effect-result-invalid' : 'feature-effect-result-too-large', false);
  };
  const custody = () => pendingLoss > 0 || unknownLoss
      ? Object.freeze({ outcomeKnown: false, retryable: false })
      : Object.freeze({ outcomeKnown: true, retryable: !settledLoss });
  return Object.freeze({
    admit,
    observe,
    custody,
    pendingLoss: (/** @type {string} */ operation) => effects[operation]?.risk === 'read'
      ? Object.freeze({ outcomeKnown: true, retryable: true })
      : Object.freeze({ outcomeKnown: false, retryable: false }),
    pendingCap,
  });
};

export const kernelFeatureResultAllowed = (/** @type {string} */ capability,
  /** @type {unknown} */ request, /** @type {unknown} */ result) => {
  const parsed = parseKernelFeatureCall(capability, request);
  const reply = record(result);
  if (!parsed || !reply || typeof reply.ok !== 'boolean'
      || typeof reply.outcomeKnown !== 'boolean'
      || !bounded(reply, parsed.policy.resultBytes)) return false;
  if (reply.ok) {
    return reply.outcomeKnown === true && exactKeys(reply,
      Object.hasOwn(reply, 'value') ? ['ok', 'outcomeKnown', 'value'] : ['ok', 'outcomeKnown']);
  }
  const allowed = new Set(['ok', 'outcomeKnown', 'code', 'error', 'retryable', 'phase']);
  return typeof reply.code === 'string' && reply.code.length > 0 && reply.code.length <= 128
    && Object.keys(reply).every((key) => allowed.has(key))
    && (!Object.hasOwn(reply, 'error') || typeof reply.error === 'string')
    && (!Object.hasOwn(reply, 'retryable') || typeof reply.retryable === 'boolean')
    && (!Object.hasOwn(reply, 'phase') || reply.phase === 'startup' || reply.phase === 'run');
};

const maxPolicyBytes = (/** @type {Record<string,any>} */ policies) => Math.max(
  ...Object.values(policies).map((policy) => policy.inputBytes),
);
export const KERNEL_FEATURE_DISPATCH_OUTER_BYTES = maxPolicyBytes(ROUTE_POLICIES) + KIB;

export const kernelFeatureOuterPayloadCap = (/** @type {string} */ capability) =>
  capability === KERNEL_FEATURE_DISPATCH_CAPABILITY ? KERNEL_FEATURE_DISPATCH_OUTER_BYTES : 0;
