// @ts-check

import {
  buildClientWriteProposal,
  normalizeSiteOrigin,
  normalizeSiteClientRun,
  normalizeSiteClientContracts,
  validateSiteClientValue,
  canonicalSiteClientJson,
  siteClientValidatedOperations,
} from '/peerd-runtime/kernel-turn-authority.js';
import {
  browserDocumentIdentity,
  originOfUrl,
  resolveTargetTab,
} from '/peerd-runtime/browser-authority.js';
import { sameCanonicalStructuredClone } from '/shared/canonical-clone-digest.js';

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
  const args = { ...binding.args,
    ...(binding.args?.clientOperation !== undefined ? { operation: binding.args.clientOperation } : {}) };
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
    let record;
    try { record = await ctx.siteClients.get(origin); }
    catch { return { unavailable: true, record: null }; }
    if (!await authorized(origin)) return { refused: true, record: null };
    return { record };
  };
  return Object.freeze({
    readStoredClient: async (/** @type {string} */ origin) => {
      requireOperation('turn.site-client.read');
      requireOrigin(origin);
      const read = await readRecord(origin);
      if (read.refused) return refusal();
      if (read.unavailable) return preEffectFailure('site_clients_unavailable');
      shared.priorForWrite = read.record;
      shared.priorLoaded = true;
      return { ok: true, record: read.record };
    },
    runStoredClient: async (/** @type {string} */ origin,
      /** @type {string|undefined} */ code, /** @type {number} */ timeoutMs,
      /** @type {any} */ options = {}) => {
      requireOperation('turn.site-client.run');
      requireOrigin(origin);
      const expectedOptions = Object.fromEntries(['mode', 'operation', 'input', 'revision']
        .filter(key => args[key] !== undefined).map(key => [key, args[key]]));
      if (code !== args.code || timeoutMs !== expectedTimeout(args.timeoutMs)
          || !sameCanonicalStructuredClone(options, expectedOptions, { maxBytes: 64_000 })) throw mismatch();
      let request;
      try { request = normalizeSiteClientRun({ ...options, code }); }
      catch { return preEffectFailure('site_client_run_invalid', false); }
      const typed = request.kind !== 'legacy';
      const ownerSessionId = ctx?.session?.sessionId;
      const client = ctx?.jsOffscreenClient;
      const runs = ctx?.scriptRuns;
      const abortSignal = signal ?? ctx?.abortSignal;
      if (!client?.execHeadless) return preEffectFailure('site_client_run_unavailable');
      if (typeof ownerSessionId !== 'string' || !ownerSessionId) return preEffectFailure('no_owner_session', false);
      if (!runs || typed && !runs.siteReadFailureFor) return preEffectFailure('site_client_run_registry_unavailable');
      if (abortSignal?.aborted) return preEffectFailure('site_client_run_aborted: the turn was stopped before the run started', false);
      const read = await readRecord(origin);
      if (read.refused) return refusal();
      if (read.unavailable) return preEffectFailure('site_clients_unavailable');
      if (!read.record) return preEffectFailure(
        `no_site_client: none stored for ${origin}: derive one first (site_capture + site_client_write), or just drive the page.`,
      );
      if (abortSignal?.aborted) return preEffectFailure('site_client_run_aborted: the turn stopped while loading the client', false);
      const record = read.record;
      const revision = record.meta?.revision ?? '';
      let contracts = { operations: /** @type {any[]} */ ([]), validationCases: /** @type {any[]} */ ([]) };
      if (typed) {
        if (revision !== request.revision) return preEffectFailure('site_client_revision_stale', false);
        try { contracts = normalizeSiteClientContracts(record.meta.operations, record.meta.validationCases); }
        catch { return preEffectFailure('site_client_contract_invalid', false); }
      }
      const started = Date.now();
      // why: the sealed program cannot choose its own read policy. The live SW
      // registry supplies it to site-fetch/call, including sticky failure state
      // that remains observable when hostile JS catches a denied request.
      /** @param {string} source @returns {Promise<{ok:boolean,result?:any,readFailure?:string|null,error?:string,performed?:boolean,outcomeKnown?:boolean,outcomeKind?:string,retryable?:boolean,executionDispatched?:boolean}>} */
      const runCode = async (source) => {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0 || abortSignal?.aborted) return preEffectFailure('site_client_run_aborted_or_timed_out', false);
        const wrapped = `const client = await (async () => {\n${record.body}\n})();\n${source}`;
        const runId = runs.mintRunId(ownerSessionId);
        runs.register(runId, abortSignal, ownerSessionId, typed ? { site: true, siteReadOnly: true } : { site: true });
        const onAbort = () => { void client.abortHeadless?.(runId, ownerSessionId); };
        if (abortSignal && client.abortHeadless) {
          if (abortSignal.aborted) onAbort();
          else abortSignal.addEventListener('abort', onAbort, { once: true });
        }
        let result;
        let readFailure;
        try {
          result = await client.execHeadless(wrapped, {
            timeoutMs: typed ? remaining : timeoutMs, siteFetch: origin, ownerSessionId, runId, signal: abortSignal,
          });
          readFailure = typed ? runs.siteReadFailureFor(runId) : null;
        } catch (cause) {
          const custody = /** @type {{executionDispatched?:boolean,outcomeKnown?:boolean,outcomeKind?:string}} */ (cause);
          if (custody?.executionDispatched === true || custody?.outcomeKnown === false
              || custody?.outcomeKind === 'transport-lost') {
            // why: host loss never becomes a retryable refusal, even after Stop.
            const failure = cause instanceof Error ? cause : new Error(String(cause));
            Object.assign(failure, { performed: true, executionDispatched: true,
              outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false });
            throw failure;
          }
          if (!await authorized(origin)) return refusal();
          if (!typed && !abortSignal?.aborted) {
            await ctx.siteClients.recordRun(origin, { ok: false, revision, signal: abortSignal }).catch(() => {});
            if (!await authorized(origin)) return refusal();
          }
          return preEffectFailure(abortSignal?.aborted ? 'site_client_run_aborted: the turn was stopped during the run'
            : 'site_client_run_failed: the sealed client failed', !abortSignal?.aborted);
        } finally {
          runs.release(runId);
          abortSignal?.removeEventListener?.('abort', onAbort);
        }
        if (result?.siteOutcomeUnknown === true) throw Object.assign(
          new Error(result.siteOutcomeError ?? result.error ?? 'Site write outcome is unknown'),
          { performed: true, executionDispatched: true, outcomeKnown: false,
            outcomeKind: 'transport-lost', retryable: false },
        );
        if (!await authorized(origin)) return completedRefusal();
        const declined = typeof result?.error === 'string' && /declined/i.test(result.error);
        const cancelled = abortSignal?.aborted === true;
        if (!typed && !declined && !cancelled) {
          await ctx.siteClients.recordRun(origin, { ok: !result?.error, revision, signal: abortSignal }).catch(() => {});
          if (!await authorized(origin)) return completedRefusal();
        }
        if (cancelled) return {
          ok: false, error: 'site_client_run_completed_after_stop', performed: true,
          executionDispatched: true, outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
        };
        return { ok: true, result, readFailure };
      };
      if (!typed) return runCode(code ?? '');
      const operation = contracts.operations.find((/** @type {any} */ op) => op.name === request.operation);
      const invoke = (/** @type {string} */ name, /** @type {any} */ input) => {
        const key = JSON.stringify(name);
        return `if (!client || !Object.hasOwn(client, ${key}) || typeof client[${key}] !== 'function') throw new Error('named operation missing');\nreturn await client[${key}](${canonicalSiteClientJson(input)});`;
      };
      const completedFailure = (/** @type {string} */ error) => ({
        ok: false, error, performed: true, executionDispatched: true,
        outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
      });
      const canRecord = async () => !abortSignal?.aborted && await authorized(origin);
      if (request.kind === 'operation') {
        if (!operation?.readOnly || !siteClientValidatedOperations(record.meta).includes(operation.name)) {
          return preEffectFailure('site_client_operation_not_validated', false);
        }
        let input;
        try { input = validateSiteClientValue(request.input, operation.inputSchema); }
        catch { return preEffectFailure('site_client_input_invalid', false); }
        let executed;
        try { executed = await runCode(invoke(operation.name, input)); }
        catch (cause) {
          if (await canRecord()) await ctx.siteClients.recordRun(origin, { ok: false, revision, signal: abortSignal }).catch(() => {});
          throw cause;
        }
        if (!executed.ok) {
          if (!executed.error?.startsWith('site_client_origin_refused') && await canRecord()) {
            await ctx.siteClients.recordRun(origin, { ok: false, revision, signal: abortSignal }).catch(() => {});
          }
          return executed;
        }
        let value;
        try {
          if (executed.result?.error || executed.readFailure) throw new Error('read failed');
          value = validateSiteClientValue(executed.result?.value, operation.outputSchema);
        } catch {
          if (await canRecord()) await ctx.siteClients.recordRun(origin, { ok: false, revision, signal: abortSignal }).catch(() => {});
          return completedFailure(executed.readFailure ?? 'site_client_output_invalid');
        }
        if (!await canRecord()) return completedRefusal();
        await ctx.siteClients.recordRun(origin, { ok: true, revision, signal: abortSignal }).catch(() => {});
        const fresh = await readRecord(origin);
        if (fresh.refused) return completedRefusal();
        if (abortSignal?.aborted) return completedFailure('site_client_run_completed_after_stop');
        if (fresh.record?.meta.revision !== revision
            || !siteClientValidatedOperations(fresh.record.meta).includes(operation.name)) {
          return completedFailure('site_client_revision_stale');
        }
        return { ok: true, typedResult: { schema: 1, origin, revision, operation: operation.name,
          inputValidated: true, outputValidated: true, readOnly: true, result: value } };
      }
      const cases = contracts.validationCases;
      if (!cases.length || !contracts.operations.some((/** @type {any} */ op) => op.readOnly
          && new Set(cases.filter((/** @type {any} */ item) => item.operation === op.name)
            .map((/** @type {any} */ item) => canonicalSiteClientJson(item.input))).size >= 2)) {
        return preEffectFailure('site_client_validation_cases_required: declare two distinct inputs for a read operation', false);
      }
      if (!ctx.siteClients.beginValidation || !ctx.siteClients.recordValidation
          || !ctx.siteClients.revokeValidation) return preEffectFailure('site_client_validation_unavailable', false);
      const attempt = await ctx.siteClients.beginValidation(origin, revision, abortSignal).catch(() => null);
      if (abortSignal?.aborted) return preEffectFailure('site_client_validation_aborted', false);
      if (!attempt) return preEffectFailure('site_client_revision_stale', false);
      const receipts = [];
      for (const [index, item] of cases.entries()) {
        if (!await authorized(origin)) return receipts.length ? completedRefusal() : refusal();
        if (abortSignal?.aborted) return preEffectFailure('site_client_validation_aborted', false);
        let executed;
        try { executed = await runCode(invoke(item.operation, item.input)); }
        catch (cause) {
          if (await canRecord()) await ctx.siteClients.recordRun(origin, { ok: false, revision, signal: abortSignal }).catch(() => {});
          throw cause;
        }
        const contract = contracts.operations.find((/** @type {any} */ op) => op.name === item.operation);
        let ok = executed.ok && !executed.result?.error && !executed.readFailure;
        try {
          ok = ok && canonicalSiteClientJson(validateSiteClientValue(executed.result?.value, contract.outputSchema))
            === canonicalSiteClientJson(item.expected);
        } catch { ok = false; }
        receipts.push({ index, operation: item.operation, ok });
        if (!ok) {
          if (!executed.error?.startsWith('site_client_origin_refused') && await canRecord()) {
            await ctx.siteClients.recordValidation(origin, { revision, attempt, cases: receipts, signal: abortSignal }).catch(() => {});
          }
          return executed.ok ? completedFailure(executed.readFailure ?? 'site_client_validation_failed') : executed;
        }
      }
      if (!await authorized(origin)) return completedRefusal();
      if (abortSignal?.aborted) return completedFailure('site_client_validation_completed_after_stop');
      // why: Stop during the awaited IDB transaction must abort promotion, not
      // merely hide a success envelope after the durable proof was written.
      const meta = await ctx.siteClients.recordValidation(origin, {
        revision, attempt, cases: receipts, signal: abortSignal,
      }).catch(() => null);
      if (abortSignal?.aborted) {
        if (meta) await ctx.siteClients.revokeValidation(origin, { revision, attempt });
        return completedFailure('site_client_validation_completed_after_stop');
      }
      if (!meta) return completedFailure('site_client_revision_stale');
      if (!await authorized(origin) || abortSignal?.aborted) {
        await ctx.siteClients.revokeValidation(origin, { revision, attempt });
        return abortSignal?.aborted ? completedFailure('site_client_validation_completed_after_stop') : completedRefusal();
      }
      return { ok: true, validationResult: { schema: 1, origin, revision,
        status: 'validated', validatedOperations: siteClientValidatedOperations(meta), cases: receipts,
        evidence: 'declared cases and schemas; no independent business-outcome judgment' } };
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
          operations: args.operations !== undefined ? args.operations : shared.priorForWrite?.meta.operations ?? [],
          validationCases: args.validationCases !== undefined ? args.validationCases : shared.priorForWrite?.meta.validationCases ?? [],
        },
        body: typeof args.body === 'string' ? args.body : (shared.priorForWrite?.body ?? ''),
        prior: shared.priorForWrite ?? null,
        origin: 'agent',
      });
      if (proposal.op === 'noop') throw mismatch();
      const answer = await ctx.confirm({
        tool: 'site_client_write', sideEffect: 'write', kind: 'site_client_write',
        proposal,
        summary: `${proposal.op} site client ${origin}: persists ${proposal.bodyBytesAfter}B of `
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
      let live;
      try { live = await ctx.siteClients.get(origin); }
      catch { return preEffectFailure('site_clients_unavailable'); }
      if (!await authorized(origin)) return refusal();
      if (!sameCanonicalStructuredClone(live ?? null, shared.priorForWrite ?? null, {
        maxBytes: 2 * 1024 * 1024,
      })) {
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
