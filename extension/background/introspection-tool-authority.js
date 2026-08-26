// @ts-check

import {
  isAddressableBrowserTab,
  isDenylistedTab,
} from '../peerd-runtime/kernel-turn-authority.js';

const mismatch = () => Object.assign(new Error('introspection authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

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

/** @param {{call:any,ctx:any}} input */
export const createIntrospectionToolAuthority = ({ call, ctx }) => {
  const args = call?.args ?? {};
  const requireTool = (/** @type {string} */ name) => {
    if (call?.name !== name) throw mismatch();
  };
  const requireInspect = (/** @type {string} */ kind) => {
    requireTool('inspect');
    if (args?.kind !== kind) throw mismatch();
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
      requireTool('actor_list');
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
      requireInspect('provider_config');
      return {
        provider: String(ctx?.provider?.name ?? 'unknown'),
        model: String(ctx?.provider?.model ?? 'unknown'),
        hasKey: ctx?.provider?.hasKey === true,
        vaultLocked: ctx?.vault?.isLocked !== false,
      };
    },
    readStorageSnapshot: (/** @type {string|undefined} */ prefix) => {
      requireInspect('storage');
      const expected = typeof args?.prefix === 'string' ? args.prefix : undefined;
      if (prefix !== expected || typeof ctx?.kv?.list !== 'function') throw mismatch();
      return ctx.kv.list(prefix);
    },
    readAutomatableTabs: async () => {
      requireInspect('session_access');
      return (await allowedTabs()).tabs;
    },
    readDenylistPatterns: () => {
      requireInspect('denylist');
      return Array.isArray(ctx?.denylist) ? [...ctx.denylist] : [];
    },
    readAuditEntries: () => {
      requireInspect('audit_log');
      if (typeof ctx?.idb?.getAll !== 'function') throw mismatch();
      return ctx.idb.getAll('audit_log');
    },
    readInstalledSkill: (/** @type {string} */ name) => {
      requireTool('load_skill');
      if (name !== String(args?.name ?? '').trim()
          || typeof ctx?.skills?.loadBody !== 'function') throw mismatch();
      return ctx.skills.loadBody(name);
    },
  });
};

export const bindIntrospectionToolAuthority = (
  /** @type {any} */ state, /** @type {any} */ input,
) =>
  state.authority ??= createIntrospectionToolAuthority(input);
