// @ts-check

import {
  isAddressableBrowserTab,
  isDenylistedTab,
} from '../peerd-runtime/kernel-turn-authority.js';

const mismatch = () => Object.assign(new Error('introspection authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

const STORAGE_PROOF_PREFIXES = new Set(['vault', 'vault:', 'secret:']);
const STORAGE_PROOF_MAX_KEYS = 256;
const STORAGE_VALUE_TYPES = Object.freeze([
  'null', 'array', 'binary', 'object', 'string', 'number', 'boolean', 'undefined',
]);

/** @param {string} key */
const isProtectedStorageKey = (key) => key === 'vault'
  || key.startsWith('vault.')
  || key.startsWith('vault:')
  || key.startsWith('secret:');

/** @param {unknown} value */
const storageValuePosture = (value) => {
  const type = value === null ? 'null'
    : Array.isArray(value) ? 'array'
      : ArrayBuffer.isView(value) || value instanceof ArrayBuffer ? 'binary'
        : typeof value;
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return {
      type,
      bytes: typeof serialized === 'string'
        ? new TextEncoder().encode(serialized).byteLength
        : 0,
      ...(Array.isArray(value) ? { items: value.length } : {}),
      ...(value && typeof value === 'object' && !Array.isArray(value)
        && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)
        ? { fields: Object.keys(value).length } : {}),
    };
  } catch {
    return { type, bytes: null };
  }
};

/** @param {unknown} value @param {string|undefined} prefix */
const storageInspectionProof = (value, prefix) => {
  const entries = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value) : [];
  const scanned = entries.slice(0, STORAGE_PROOF_MAX_KEYS);
  const byType = Object.fromEntries(STORAGE_VALUE_TYPES.map((type) => [type, {
    entries: 0, knownBytes: 0, unknownBytes: 0,
  }]));
  const protectedPosture = { entries: 0, knownBytes: 0, unknownBytes: 0 };
  let knownBytes = 0;
  let unknownBytes = 0;
  for (const [key, item] of scanned) {
    const posture = storageValuePosture(item);
    const type = Object.hasOwn(byType, posture.type) ? posture.type : 'undefined';
    const bucket = byType[type];
    bucket.entries += 1;
    if (typeof posture.bytes === 'number' && Number.isInteger(posture.bytes)) {
      bucket.knownBytes += posture.bytes;
      knownBytes += posture.bytes;
    } else {
      bucket.unknownBytes += 1;
      unknownBytes += 1;
    }
    if (isProtectedStorageKey(key)) {
      protectedPosture.entries += 1;
      if (typeof posture.bytes === 'number' && Number.isInteger(posture.bytes)) {
        protectedPosture.knownBytes += posture.bytes;
      }
      else protectedPosture.unknownBytes += 1;
    }
  }
  return {
    scope: prefix ?? 'all',
    status: 'metadata-only',
    totalEntries: entries.length,
    scannedEntries: scanned.length,
    omittedEntries: entries.length - scanned.length,
    knownBytes,
    unknownBytes,
    protected: protectedPosture,
    byType,
  };
};

/** @param {unknown} cause */
const messageOf = (cause) => /** @type {{message?:string}} */ (cause)?.message ?? String(cause);

/** @param {Record<string, any>} record */
const projectEngineRecord = (record) => ({
  id: record.id,
  name: record.name,
  ...(record.pinned === true ? { pinned: true } : {}),
  ...(record.persistent === false ? { persistent: false } : {}),
  ...(Array.isArray(record.tags)
    ? { tags: record.tags.filter((tag) => typeof tag === 'string').slice(0, 64) } : {}),
});

/** @param {{binding:any,ctx:any}} input */
export const createIntrospectionToolAuthority = ({ binding, ctx }) => {
  const args = binding.args ?? {};
  const requireOperation = (/** @type {string} */ operation) => {
    if (binding.operation !== operation) throw mismatch();
  };
  const allowedTabs = async () => {
    if (typeof ctx?.tabs?.query !== 'function') throw mismatch();
    const patterns = Array.isArray(ctx?.denylist) ? ctx.denylist : [];
    const tabs = await ctx.tabs.query({});
    /** @type {Array<{id:number,url:string,title:string,active:boolean}>} */
    const admitted = [];
    let hidden = 0;
    for (const tab of tabs) {
      if (!Number.isInteger(tab?.id) || !isAddressableBrowserTab(tab?.url)
          || isDenylistedTab(tab?.url, patterns)) {
        hidden += 1;
        continue;
      }
      admitted.push({
        id: tab.id,
        url: typeof tab.url === 'string' ? tab.url : '',
        title: typeof tab.title === 'string' ? tab.title : '',
        active: tab.active === true,
      });
    }
    return { tabs: admitted, hidden };
  };
  return Object.freeze({
    readActorRoster: async () => {
      requireOperation('turn.introspection.actor-roster');
      const sessionId = ctx?.session?.sessionId;
      /** @type {Array<any>} */
      const engines = [];
      /** @type {string[]} */
      const unavailable = [];
      const sources = [
        ['webvm', ctx?.vmRegistry, ctx?.vmTabTracker, 'vms', 'currentVmId'],
        ['notebook', ctx?.jsRegistry, ctx?.jsTabTracker, 'notebooks', 'currentId'],
        ['pod', ctx?.podRegistry, ctx?.podTabTracker, 'pods', 'currentId'],
        ['app', ctx?.appRegistry, ctx?.appTabTracker, 'apps', 'currentId'],
      ];
      for (const [type, registry, tracker, listKey, currentKey] of sources) {
        if (typeof registry?.snapshot !== 'function') continue;
        try {
          const snapshot = await registry.snapshot({ sessionId });
          const records = Array.isArray(snapshot?.[listKey])
            ? snapshot[listKey].filter((record) => typeof record?.id === 'string') : [];
          engines.push({
            type,
            records: records.map(projectEngineRecord),
            currentId: typeof snapshot?.[currentKey] === 'string'
              ? snapshot[currentKey] : null,
            liveIds: records.flatMap((record) =>
              tracker?.getTabId?.(record.id) == null ? [] : [record.id]),
          });
        } catch (cause) { unavailable.push(`${type}: ${messageOf(cause)}`); }
      }
      /** @type {Array<{id:number,url:string,title:string,active:boolean}>} */
      let tabs = [];
      let restrictedTabsHidden = 0;
      if (ctx?.tabs?.query) {
        try {
          const result = await allowedTabs();
          tabs = result.tabs;
          restrictedTabsHidden = result.hidden;
        } catch (cause) { unavailable.push(`tab: ${messageOf(cause)}`); }
      }
      /** @type {Array<{origin:string,keyed:boolean,formed:boolean}>} */
      let integrations = [];
      if (typeof ctx?.listApiIntegrations === 'function') {
        try {
          const rows = await ctx.listApiIntegrations();
          integrations = Array.isArray(rows) ? rows.flatMap((row) =>
            typeof row?.origin === 'string' ? [{
              origin: row.origin, keyed: row.keyed === true, formed: row.formed === true,
            }] : []) : [];
        } catch (cause) { unavailable.push(`integration: ${messageOf(cause)}`); }
      }
      return {
        engines, tabs, integrations, restrictedTabsHidden, unavailable,
        actorIsolation: ctx?.actorIsolation ?? {
          status: 'unsupported', host: null,
          reason: 'Actor isolation capability was not provided.', retryable: false,
        },
      };
    },
    readProviderPosture: () => {
      requireOperation('turn.introspection.provider-posture');
      return {
        provider: String(ctx?.provider?.name ?? 'unknown'),
        model: String(ctx?.provider?.model ?? 'unknown'),
        hasKey: ctx?.provider?.hasKey === true,
        vaultLocked: ctx?.vault?.isLocked !== false,
      };
    },
    readStorageSnapshot: async (/** @type {string|undefined} */ prefix) => {
      requireOperation('turn.introspection.storage-snapshot');
      const expected = typeof args?.prefix === 'string' ? args.prefix : undefined;
      if (prefix !== expected || typeof ctx?.kv?.list !== 'function'
          || (prefix !== undefined && !STORAGE_PROOF_PREFIXES.has(prefix))) throw mismatch();
      const storagePrefix = prefix === 'vault:' ? 'vault' : prefix;
      return storageInspectionProof(await ctx.kv.list(storagePrefix), prefix);
    },
    readAutomatableTabs: async () => {
      requireOperation('turn.introspection.automatable-tabs');
      return (await allowedTabs()).tabs;
    },
    readDenylistPatterns: () => {
      requireOperation('turn.introspection.denylist-patterns');
      return Array.isArray(ctx?.denylist) ? [...ctx.denylist] : [];
    },
    readAuditEntries: () => {
      requireOperation('turn.introspection.audit-entries');
      if (typeof ctx?.idb?.getAll !== 'function') throw mismatch();
      return ctx.idb.getAll('audit_log');
    },
    readInstalledSkill: (/** @type {string} */ name) => {
      requireOperation('turn.introspection.installed-skill');
      if (name !== String(args?.name ?? '').trim()
          || typeof ctx?.skills?.loadBody !== 'function') throw mismatch();
      return ctx.skills.loadBody(name);
    },
  });
};

export const bindIntrospectionToolAuthority = (
  /** @type {any} */ state, /** @type {any} */ input,
) =>
  createIntrospectionToolAuthority({
    ...input,
    binding: Object.freeze({ operation: input.operation, args: structuredClone(input.args) }),
  });
