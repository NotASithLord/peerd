// @ts-check

const mismatch = () => Object.assign(new Error('dweb authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {unknown} cause */
const knownFailure = (cause) => {
  if (cause && typeof cause === 'object') {
    Object.assign(cause, { outcomeKnown: true });
    return cause;
  }
  return Object.assign(new Error(String(cause)), { outcomeKnown: true });
};

/** @param {{call:any,ctx:any,signal?:AbortSignal}} input */
export const createDwebToolAuthority = ({ call, ctx, signal }) => {
  const args = call?.args ?? {};
  const requireTool = (/** @type {string} */ name) => {
    if (call?.name !== name) throw mismatch();
  };
  const dwebFor = (/** @type {string} */ name) => {
    requireTool(name);
    if (!ctx?.dweb) return null;
    return ctx.dweb;
  };
  const confirmForced = async (/** @type {any} */ prompt) => {
    if (ctx?.permission?.confirmActions !== false || typeof ctx?.confirm !== 'function') return true;
    let answer;
    try { answer = await ctx.confirm(prompt, signal ?? ctx.abortSignal); }
    catch (cause) {
      // why: confirmation happens before mesh or app-library mutation.
      throw knownFailure(cause);
    }
    return answer === 'yes_once' || answer === 'yes_session';
  };
  return Object.freeze({
    discoverApps: () => dwebFor('dweb_discover')?.discover()
      ?? { ok: false, error: 'dweb_unavailable' },
    readPeers: () => dwebFor('dweb_peers')?.peers()
      ?? { ok: false, error: 'dweb_unavailable' },
    publishConfirmedApp: async (/** @type {string} */ appId) => {
      const dweb = dwebFor('dweb_share');
      if (appId !== String(args?.appId ?? '').trim()) throw mismatch();
      if (!dweb) return { ok: false, error: 'dweb_unavailable' };
      const confirmed = await confirmForced({
        tool: 'dweb_share', kind: 'dweb_publish', origins: [],
        summary: `Publish app "${appId}" to the dweb app store? Peers will be able to discover and install it.`,
        sessionId: ctx?.session?.sessionId ?? null,
      });
      if (!confirmed) return { ok: false, error: 'declined', declined: true };
      return dweb.share(appId);
    },
    installConfirmedApp: async (
      /** @type {string} */ uri, /** @type {string|undefined} */ name,
    ) => {
      const dweb = dwebFor('dweb_install');
      if (uri !== String(args?.uri ?? '').trim() || name !== args?.name) throw mismatch();
      if (!dweb) return { ok: false, error: 'dweb_unavailable' };
      const confirmed = await confirmForced({
        tool: 'dweb_install', kind: 'dweb_install', origins: [],
        summary: `Install the app at ${uri.slice(0, 72)}… from a peer? It runs sandboxed, with no extension access.`,
        sessionId: ctx?.session?.sessionId ?? null,
      });
      if (!confirmed) return { ok: false, error: 'declined', declined: true };
      return dweb.install({ uri, name });
    },
    setPeerBlocked: (
      /** @type {string} */ did, /** @type {boolean} */ block,
      /** @type {string|undefined} */ reason,
    ) => {
      const dweb = dwebFor('dweb_block');
      if (did !== String(args?.did ?? '').trim() || block !== (args?.block !== false)
          || reason !== args?.reason) throw mismatch();
      return dweb?.block({ did, block, reason })
        ?? { ok: false, error: 'dweb_unavailable' };
    },
    setDiscoveryEnabled: (/** @type {boolean} */ enabled) => {
      const dweb = dwebFor('dweb_discovery');
      if (enabled !== args?.enabled) throw mismatch();
      return dweb?.setDiscovery({ enabled })
        ?? { ok: false, error: 'dweb_unavailable' };
    },
  });
};

export const bindDwebToolAuthority = (/** @type {any} */ state, /** @type {any} */ input) =>
  state.authority ??= createDwebToolAuthority(input);
