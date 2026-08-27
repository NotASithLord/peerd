// @ts-check

import {
  buildClientWriteProposal,
  normalizeSiteOrigin,
} from '/peerd-runtime/kernel-turn-authority.js';
import {
  browserDocumentIdentity,
  originOfUrl,
  resolveTargetTab,
} from '/peerd-runtime/browser-authority.js';

const mismatch = () => Object.assign(new Error('site-client authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

const refusal = () => ({
  ok: false,
  error: 'site_client_origin_refused: this actor does not own that site client origin',
  outcomeKind: 'pre-effect-failure',
});

const expectedTimeout = (/** @type {unknown} */ value) => Math.min(
  60_000, Math.max(1000, Number(value ?? 30_000)),
);

/** @param {string} origin */
const relatedOrigins = (origin) => {
  const origins = [origin];
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^www\./, '');
    const apiHost = `api.${host}`;
    if (apiHost !== url.hostname) origins.push(`${url.protocol}//${apiHost}`);
  } catch { /* the exact origin remains */ }
  return origins;
};

/** @param {{call:any,ctx:any,signal?:AbortSignal}} input */
export const createSiteClientToolAuthority = ({ call, ctx, signal }) => {
  const args = call?.args ?? {};
  const expectedOrigin = normalizeSiteOrigin(args.origin);
  /** @type {any} */
  let priorForWrite;
  let priorLoaded = false;
  const requireTool = (/** @type {string[]} */ names) => {
    if (!names.includes(call?.name)) throw mismatch();
  };
  const requireOrigin = (/** @type {string} */ origin) => {
    if (!expectedOrigin || origin !== expectedOrigin) throw mismatch();
  };
  const authorized = async (/** @type {string} */ origin) => {
    try { return await ctx?.authorizeSiteClientOrigin?.(origin) === true; }
    catch { return false; }
  };
  const readRecord = async (/** @type {string} */ origin) => {
    if (!await authorized(origin)) return { refused: true, record: null };
    if (!ctx?.siteClients?.get) return { unavailable: true, record: null };
    const record = await ctx.siteClients.get(origin).catch(() => null);
    if (!await authorized(origin)) return { refused: true, record: null };
    return { record };
  };
  return Object.freeze({
    readStoredClient: async (/** @type {string} */ origin) => {
      requireTool(['site_client_read', 'site_client_write']);
      requireOrigin(origin);
      const read = await readRecord(origin);
      if (read.refused) return refusal();
      if (read.unavailable) return { ok: false, error: 'site_clients_unavailable' };
      if (call.name === 'site_client_write') {
        priorForWrite = read.record;
        priorLoaded = true;
        return { ok: true, record: read.record };
      }
      if (!read.record) return { ok: false, error: `no_site_client: none stored for ${origin}` };
      return { ok: true, record: read.record };
    },
    runStoredClient: async (/** @type {string} */ origin,
      /** @type {string} */ code, /** @type {number} */ timeoutMs) => {
      requireTool(['site_client_run']);
      requireOrigin(origin);
      if (code !== args.code || timeoutMs !== expectedTimeout(args.timeoutMs)) throw mismatch();
      const ownerSessionId = ctx?.session?.sessionId;
      const client = ctx?.jsOffscreenClient;
      const runs = ctx?.scriptRuns;
      const abortSignal = signal ?? ctx?.abortSignal;
      if (!client?.execHeadless) return { ok: false, error: 'site_client_run_unavailable' };
      if (typeof ownerSessionId !== 'string' || !ownerSessionId) {
        return { ok: false, error: 'no_owner_session' };
      }
      if (!runs) return { ok: false, error: 'site_client_run_registry_unavailable' };
      if (abortSignal?.aborted) {
        return { ok: false, error: 'site_client_run_aborted: the turn was stopped before the run started' };
      }
      const read = await readRecord(origin);
      if (read.refused) return refusal();
      if (read.unavailable) return { ok: false, error: 'site_clients_unavailable' };
      if (!read.record) return {
        ok: false,
        error: `no_site_client: none stored for ${origin} — derive one first (site_capture + site_client_write), or just drive the page.`,
      };
      if (abortSignal?.aborted) {
        return { ok: false, error: 'site_client_run_aborted: the turn stopped while loading the client' };
      }
      const wrapped = `const client = await (async () => {\n${read.record.body}\n})();\n${code}`;
      const runId = runs.mintRunId(ownerSessionId);
      runs.register(runId, abortSignal, ownerSessionId, { site: true });
      const onAbort = () => { void client.abortHeadless?.(runId, ownerSessionId); };
      if (abortSignal && client.abortHeadless) {
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
      }
      let result;
      try {
        result = await client.execHeadless(wrapped, {
          timeoutMs, siteFetch: origin, ownerSessionId, runId, signal: abortSignal,
        });
      } catch (cause) {
        if (!await authorized(origin)) return refusal();
        if (!abortSignal?.aborted) {
          await ctx.siteClients.recordRun(origin, { ok: false }).catch(() => {});
          if (!await authorized(origin)) return refusal();
        }
        const error = /** @type {{name?:string,message?:string}} */ (cause);
        return abortSignal?.aborted
          ? { ok: false, error: 'site_client_run_aborted: the turn was stopped during the run' }
          : { ok: false, error: `site_client_run_failed: ${error?.name ?? 'Error'}: ${error?.message ?? String(cause)}` };
      } finally {
        runs.release(runId);
        if (abortSignal && client.abortHeadless) {
          abortSignal.removeEventListener?.('abort', onAbort);
        }
      }
      if (!await authorized(origin)) return refusal();
      const declined = typeof result?.error === 'string' && /declined/i.test(result.error);
      const cancelled = abortSignal?.aborted === true;
      if (!declined && !cancelled) {
        await ctx.siteClients.recordRun(origin, { ok: !result?.error }).catch(() => {});
        if (!await authorized(origin)) return refusal();
      }
      if (cancelled) {
        return { ok: false, error: 'site_client_run_aborted: the turn was stopped during the run' };
      }
      return { ok: true, result };
    },
    commitConfirmedClient: async (/** @type {string} */ origin) => {
      requireTool(['site_client_write']);
      requireOrigin(origin);
      if (!priorLoaded || !ctx?.siteClients || typeof ctx?.confirm !== 'function') {
        return {
          ok: false, error: 'declined',
          content: 'No confirmation channel available for a site-client write.',
          outcomeKind: 'pre-effect-failure',
        };
      }
      const proposal = buildClientWriteProposal({
        dossier: {
          origin,
          summary: typeof args.summary === 'string'
            ? args.summary : (priorForWrite?.meta.summary ?? ''),
          endpoints: Array.isArray(args.endpoints)
            ? args.endpoints : (priorForWrite?.meta.endpoints ?? []),
          auth: args.auth ?? priorForWrite?.meta.auth ?? 'unknown',
          deriver: args.deriver ?? priorForWrite?.meta.deriver ?? 'probe',
        },
        body: typeof args.body === 'string' ? args.body : (priorForWrite?.body ?? ''),
        prior: priorForWrite ?? null,
        origin: 'agent',
      });
      if (proposal.op === 'noop') throw mismatch();
      const answer = await ctx.confirm({
        tool: 'site_client_write', sideEffect: 'write', kind: 'site_client_write',
        proposal,
        summary: `${proposal.op} site client ${origin} — persists ${proposal.bodyBytesAfter}B of `
          + `RUNNABLE JS (was ${proposal.bodyBytesBefore}B) + ${proposal.dossier.endpoints.length} endpoint(s) `
          + `(+${proposal.endpointDelta.added}/−${proposal.endpointDelta.removed}). Review the module before allowing.`,
        origins: [origin], sessionId: ctx.session?.sessionId ?? null,
      }, signal ?? ctx?.abortSignal);
      if (answer !== 'yes_once' && answer !== 'yes_session' && answer !== true) {
        return {
          ok: false, error: 'site_client_write_rejected',
          content: 'User declined the site-client write.',
          outcomeKind: 'pre-effect-failure',
        };
      }
      const abortSignal = signal ?? ctx?.abortSignal;
      if (abortSignal?.aborted) return {
        ok: false, error: 'site_client_write_aborted: the turn stopped during confirmation',
        outcomeKind: 'pre-effect-failure',
      };
      if (!await authorized(origin)) return refusal();
      if (abortSignal?.aborted) return {
        ok: false, error: 'site_client_write_aborted: the turn stopped before mutation',
        outcomeKind: 'pre-effect-failure',
      };
      if (proposal.op === 'delete') {
        await ctx.siteClients.remove(origin);
        return { ok: true, op: 'delete' };
      }
      const meta = await ctx.siteClients.put({
        dossier: proposal.dossier, body: proposal.body,
      });
      return { ok: true, op: proposal.op, meta };
    },
    startOwnedCapture: async () => {
      requireTool(['site_capture']);
      if (args.action !== 'start') throw mismatch();
      return captureOwned('start', ctx);
    },
    stopOwnedCapture: async () => {
      requireTool(['site_capture']);
      if (args.action !== 'stop') throw mismatch();
      return captureOwned('stop', ctx);
    },
  });
};

/** @param {'start'|'stop'} action @param {any} ctx */
const captureOwned = async (action, ctx) => {
  const capture = ctx?.siteCapture;
  if (!capture?.start || !capture?.stop) return { ok: false, error: 'site_capture_unavailable' };
  const ownedTabId = typeof ctx?.activeTab?.id === 'number' ? ctx.activeTab.id : null;
  let tab;
  try {
    tab = await resolveTargetTab({}, ctx);
  } catch (cause) {
    if (ownedTabId !== null) {
      try { await capture.cancel?.({ tabId: ownedTabId }); } catch { /* preserve refusal */ }
    }
    throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), {
      outcomeKnown: true, retryable: false,
    });
  }
  const origin = originOfUrl(tab?.url);
  if (!tab?.id || !/^https?:\/\//.test(origin)) {
    if (ownedTabId !== null) {
      try { await capture.cancel?.({ tabId: ownedTabId }); } catch { /* stable refusal */ }
    }
    return {
      ok: false,
      error: 'site_capture_discarded: the owned tab has no web origin; the capture was canceled and its data discarded.',
    };
  }
  const origins = relatedOrigins(origin);
  if (action === 'start') {
    const result = await capture.start({
      tabId: tab.id, origins, documentId: tab.peerdDocumentId,
      expectedDocument: browserDocumentIdentity(tab),
    });
    return { ok: true, origin, tap: result?.tap };
  }
  const digest = await capture.stop({ tabId: tab.id, origins });
  return { ok: true, origin, digest };
};

export const bindSiteClientToolAuthority = (
  /** @type {any} */ state, /** @type {any} */ input,
) => state.authority ??= createSiteClientToolAuthority(input);
