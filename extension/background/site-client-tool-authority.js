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
import { canonicalStructuredClone } from '/shared/canonical-clone-digest.js';

const mismatch = () => Object.assign(new Error('site-client authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

const refusal = () => ({
  ok: false,
  error: 'site_client_origin_refused: this actor does not own that site client origin',
  performed: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure',
});

const preEffectFailure = (/** @type {string} */ error,
  /** @type {boolean} */ retryable = true) => ({
  ok: false, error, performed: false, outcomeKnown: true,
  outcomeKind: 'pre-effect-failure', retryable,
});

const completedRefusal = () => ({
  ...refusal(), performed: true, executionDispatched: true,
  outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
});

const expectedTimeout = (/** @type {unknown} */ value) => Math.min(
  60_000, Math.max(1000, Number(value ?? 30_000)),
);

const sameStoredClient = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  try {
    return canonicalStructuredClone(left, { maxBytes: 2 * 1024 * 1024 })
      === canonicalStructuredClone(right, { maxBytes: 2 * 1024 * 1024 });
  } catch { return false; }
};

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

/** @param {{binding:any,ctx:any,signal?:AbortSignal,shared?:any}} input */
export const createSiteClientToolAuthority = ({ binding, ctx, signal, shared = {} }) => {
  const args = binding.args ?? {};
  const expectedOrigin = normalizeSiteOrigin(args.origin);
  const requireOperation = (/** @type {string} */ operation) => {
    if (binding.operation !== operation) throw mismatch();
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
      requireOperation('turn.site-client.read');
      requireOrigin(origin);
      const read = await readRecord(origin);
      if (read.refused) return refusal();
      if (read.unavailable) return { ok: false, error: 'site_clients_unavailable' };
      shared.priorForWrite = read.record;
      shared.priorLoaded = true;
      return { ok: true, record: read.record };
    },
    runStoredClient: async (/** @type {string} */ origin,
      /** @type {string} */ code, /** @type {number} */ timeoutMs) => {
      requireOperation('turn.site-client.run');
      requireOrigin(origin);
      if (code !== args.code || timeoutMs !== expectedTimeout(args.timeoutMs)) throw mismatch();
      const ownerSessionId = ctx?.session?.sessionId;
      const client = ctx?.jsOffscreenClient;
      const runs = ctx?.scriptRuns;
      const abortSignal = signal ?? ctx?.abortSignal;
      if (!client?.execHeadless) return preEffectFailure('site_client_run_unavailable');
      if (typeof ownerSessionId !== 'string' || !ownerSessionId) {
        return preEffectFailure('no_owner_session', false);
      }
      if (!runs) return preEffectFailure('site_client_run_registry_unavailable');
      if (abortSignal?.aborted) {
        return preEffectFailure(
          'site_client_run_aborted: the turn was stopped before the run started', false,
        );
      }
      const read = await readRecord(origin);
      if (read.refused) return refusal();
      if (read.unavailable) return preEffectFailure('site_clients_unavailable');
      if (!read.record) return preEffectFailure(
        `no_site_client: none stored for ${origin} — derive one first (site_capture + site_client_write), or just drive the page.`,
      );
      if (abortSignal?.aborted) {
        return preEffectFailure(
          'site_client_run_aborted: the turn stopped while loading the client', false,
        );
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
        const custody = /** @type {{executionDispatched?:boolean,outcomeKnown?:boolean,outcomeKind?:string}} */ (cause);
        if (custody?.executionDispatched === true || custody?.outcomeKnown === false
            || custody?.outcomeKind === 'transport-lost') {
          // why: a stored client may have completed authenticated writes before
          // its sealed execution channel disappeared. Preserve the host-loss
          // verdict so neither the model nor lifecycle recovery may retry it.
          const failure = cause instanceof Error ? cause : new Error(String(cause));
          Object.assign(failure, {
            performed: true,
            executionDispatched: true,
            outcomeKnown: false,
            outcomeKind: 'transport-lost',
            retryable: false,
          });
          throw failure;
        }
        if (!await authorized(origin)) return refusal();
        if (!abortSignal?.aborted) {
          await ctx.siteClients.recordRun(origin, { ok: false }).catch(() => {});
          if (!await authorized(origin)) return refusal();
        }
        const error = /** @type {{name?:string,message?:string}} */ (cause);
        return abortSignal?.aborted
          ? preEffectFailure(
            'site_client_run_aborted: the turn was stopped during the run', false,
          )
          : preEffectFailure(
            `site_client_run_failed: ${error?.name ?? 'Error'}: ${error?.message ?? String(cause)}`,
          );
      } finally {
        runs.release(runId);
        if (abortSignal && client.abortHeadless) {
          abortSignal.removeEventListener?.('abort', onAbort);
        }
      }
      if (result?.siteOutcomeUnknown === true) {
        throw Object.assign(
          new Error(result.siteOutcomeError ?? result.error ?? 'Site write outcome is unknown'),
          {
            executionDispatched: true,
            outcomeKnown: false,
            outcomeKind: 'transport-lost',
            retryable: false,
          },
        );
      }
      // The sealed program has returned, so any authenticated HTTP mutation it
      // issued has already crossed the physical edge. A concurrent Stop or
      // ownership change may suppress its value, but cannot rewrite custody as
      // a safe pre-effect refusal.
      const stillAuthorized = await authorized(origin);
      if (!stillAuthorized) return completedRefusal();
      const declined = typeof result?.error === 'string' && /declined/i.test(result.error);
      const cancelled = abortSignal?.aborted === true;
      if (!declined && !cancelled) {
        await ctx.siteClients.recordRun(origin, { ok: !result?.error }).catch(() => {});
        if (!await authorized(origin)) return completedRefusal();
      }
      if (cancelled) {
        return {
          ok: false, error: 'site_client_run_completed_after_stop',
          performed: true, executionDispatched: true,
          outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
        };
      }
      return { ok: true, result };
    },
    commitConfirmedClient: async (/** @type {string} */ origin) => {
      requireOperation('turn.site-client.commit');
      requireOrigin(origin);
      if (!shared.priorLoaded || !ctx?.siteClients || typeof ctx?.confirm !== 'function') {
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
            ? args.summary : (shared.priorForWrite?.meta.summary ?? ''),
          endpoints: Array.isArray(args.endpoints)
            ? args.endpoints : (shared.priorForWrite?.meta.endpoints ?? []),
          auth: args.auth ?? shared.priorForWrite?.meta.auth ?? 'unknown',
          deriver: args.deriver ?? shared.priorForWrite?.meta.deriver ?? 'probe',
        },
        body: typeof args.body === 'string' ? args.body : (shared.priorForWrite?.body ?? ''),
        prior: shared.priorForWrite ?? null,
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
      const livePermission = typeof ctx.readAuthorityPermission === 'function'
        ? await ctx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
        : ctx.permission;
      if (livePermission?.mode !== 'act') return {
        ok: false, code: 'plan_mode_refused', retryable: false,
        error: 'permission changed before the site-client write',
        outcomeKind: 'pre-effect-failure',
      };
      if (!await authorized(origin)) return refusal();
      const live = await ctx.siteClients.get(origin).catch(() => undefined);
      if (!await authorized(origin)) return refusal();
      if (!sameStoredClient(live ?? null, shared.priorForWrite ?? null)) {
        return {
          ok: false, code: 'site_client_write_conflict', retryable: false,
          error: 'The stored site client changed after it was reviewed; read it again before writing.',
          outcomeKind: 'pre-effect-failure',
        };
      }
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
      requireOperation('turn.site-client.capture-start');
      return captureOwned('start', ctx, signal ?? ctx?.abortSignal);
    },
    stopOwnedCapture: async () => {
      requireOperation('turn.site-client.capture-stop');
      return captureOwned('stop', ctx, signal ?? ctx?.abortSignal);
    },
  });
};

/** @param {'start'|'stop'} action @param {any} ctx @param {AbortSignal|undefined} signal */
const captureOwned = async (action, ctx, signal) => {
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
  if (signal?.aborted) throw Object.assign(
    new Error('site capture stopped before mutation'),
    { outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false },
  );
  if (action === 'start') {
    const result = await capture.start({
      tabId: tab.id, origins, documentId: tab.peerdDocumentId,
      expectedDocument: browserDocumentIdentity(tab),
    });
    if (signal?.aborted) {
      try { await capture.cancel?.({ tabId: tab.id, reason: 'turn_stopped' }); }
      catch (cause) {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        throw Object.assign(failure, {
          performed: true, outcomeKnown: false,
          outcomeKind: 'host-lost', retryable: false,
        });
      }
      throw Object.assign(new Error('site capture start was rolled back after Stop'), {
        outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
      });
    }
    return { ok: true, origin, tap: result?.tap };
  }
  const digest = await capture.stop({ tabId: tab.id, origins });
  return { ok: true, origin, digest };
};

export const bindSiteClientToolAuthority = (
  /** @type {any} */ state, /** @type {any} */ input,
) => createSiteClientToolAuthority({
  ...input,
  binding: Object.freeze({ operation: input.operation, args: structuredClone(input.args) }),
  shared: state,
});
