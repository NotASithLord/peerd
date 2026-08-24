// @ts-check
// site_client_write — propose a durable SITE CLIENT write (DESIGN-19), gated on
// USER CONFIRMATION. The agent-facing door to persisting a derived client, and
// the lethal-trifecta seam: an AGENT cannot persist a client on its own.
//
// The tool builds a confirm-gated proposal (core.buildClientWriteProposal) and
// round-trips the DOSSIER + a summarized code delta to the side panel via
// ctx.confirm before anything touches IDB. The dossier is the consent surface (a
// raw-JS diff is not glanceable); the byte/line deltas frame the code change. A
// rejection persists nothing. An empty body deletes the client.
//
// sideEffect 'write' so the six-gate chain treats it like any mutation; the
// confirm here (renders the dossier diff) layers on top of the gates.

import {
  normalizeSiteOrigin,
  buildClientWriteProposal,
} from '../../site-clients/core.js';
import { siteClientOriginRefusal } from './site-client-origin.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const siteClientWriteTool = {
  name: 'site_client_write',
  primitive: 'web',
  description: [
    'Persist (or patch, or delete) the SITE CLIENT for an origin — the user must',
    'CONFIRM before it saves. Provide the origin, a short DOSSIER (summary + endpoint',
    'inventory + observed auth posture), and the client MODULE source. The module body',
    'runs inside site_client_run and must RETURN an object of named ops (do NOT use',
    '`export`; end with e.g. `return { listCharges: () => site.fetch("/v1/charges") }`);',
    'it uses the injected `site.fetch`. Derive the dossier + module from a',
    'site_capture digest or from what you learned driving the site. NEVER put',
    'credentials in the module — the session rides the origin at the boundary. An empty',
    'body deletes the stored client. Propose a PATCH here whenever a site_client_run',
    'failed and you found the right call by driving the page.',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['origin'],
    properties: {
      origin: { type: 'string', description: 'The site origin (e.g. https://api.example.com).' },
      summary: { type: 'string', description: 'Short prose: what the site is, what the client covers, quirks. Shown to the user for consent.' },
      endpoints: {
        type: 'array',
        description: 'Endpoint inventory: [{ method, path, note }]. Paths are TEMPLATES (/v1/charges/:id).',
        items: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            path: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
      auth: { type: 'string', enum: ['session', 'bearer', 'none', 'unknown'], description: 'Observed auth POSTURE — never a value.' },
      deriver: { type: 'string', enum: ['probe', 'capture-cdp', 'capture-tap'], description: 'How the client was derived (fidelity signal).' },
      body: { type: 'string', description: 'The client module source. Empty string deletes the stored client.' },
    },
  },
  sideEffect: 'write',
  // IDB write, no web origin touched here — the origin/egress gates have nothing
  // to check. The safety is the confirm round-trip below.
  // Declare the target origin so the gates that already exist actually fire on it:
  // `origins: () => []` told the denylist hook there was nothing to check, so a
  // site client for a denylisted origin could be read/written while every other
  // path to that origin was refused. site_client_run already declared it - these
  // two had drifted.
  origins: (args) => {
    const o = normalizeSiteOrigin(args?.origin);
    return o ? [o] : [];
  },

  execute: async (args, ctx) => {
    const origin = normalizeSiteOrigin(args?.origin);
    if (!origin) {
      return {
        ok: false,
        error: 'bad_origin: expected a public HTTP(S) site origin',
        outcomeKind: 'pre-effect-failure',
      };
    }
    const refusal = await siteClientOriginRefusal(origin, ctx);
    if (refusal) return refusal;
    const store = /** @type {import('../../site-clients/store.js').SiteClientStore | undefined} */ (
      /** @type {any} */ (ctx).siteClients);
    if (!store) {
      return { ok: false, error: 'site_clients_unavailable', outcomeKind: 'pre-effect-failure' };
    }
    if (args?.body !== undefined && typeof args.body !== 'string') {
      return { ok: false, error: 'body_must_be_string', outcomeKind: 'pre-effect-failure' };
    }

    const prior = await store.get(origin).catch(() => null);
    // The prior-record read yielded. Do not use its bytes to build a prompt if
    // the actor lost custody during IDB.
    const postReadRefusal = await siteClientOriginRefusal(origin, ctx);
    if (postReadRefusal) return postReadRefusal;
    /** @type {ReturnType<typeof buildClientWriteProposal>} */
    let proposal;
    try {
      proposal = buildClientWriteProposal({
        dossier: {
          origin,
          summary: typeof args?.summary === 'string' ? args.summary : (prior?.meta.summary ?? ''),
          endpoints: Array.isArray(args?.endpoints) ? args.endpoints : (prior?.meta.endpoints ?? []),
          auth: args?.auth ?? prior?.meta.auth ?? 'unknown',
          deriver: args?.deriver ?? prior?.meta.deriver ?? 'probe',
        },
        body: typeof args?.body === 'string' ? args.body : (prior?.body ?? ''),
        prior,
        origin: 'agent',
      });
    } catch (e) {
      return {
        ok: false,
        error: `invalid_site_client: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`,
        outcomeKind: 'pre-effect-failure',
      };
    }

    if (proposal.op === 'noop') return { ok: true, content: 'no change (identical to the stored client).' };

    // Confirm round-trip — the DOSSIER + summarized deltas are the consent surface.
    const confirmAny = /** @type {((p: Record<string, unknown>, signal?: AbortSignal) => Promise<'yes_once'|'yes_session'|'no'|boolean>) | undefined} */ (
      /** @type {unknown} */ (ctx.confirm));
    if (!confirmAny) {
      return {
        ok: false,
        error: 'declined',
        content: 'No confirmation channel available for a site-client write.',
        outcomeKind: 'pre-effect-failure',
      };
    }
    const ans = await confirmAny({
      tool: 'site_client_write',
      sideEffect: 'write',
      kind: 'site_client_write',
      // The proposal carries the full module `body` + `prevBody` + dossier so the
      // confirm UI can render the executable code (not just this one-line summary) —
      // the code is the dangerous half, so the summary NAMES it as runnable JS rather
      // than reading like a benign prose edit.
      proposal,
      summary: `${proposal.op} site client ${origin} — persists ${proposal.bodyBytesAfter}B of `
        + `RUNNABLE JS (was ${proposal.bodyBytesBefore}B) + ${proposal.dossier.endpoints.length} endpoint(s) `
        + `(+${proposal.endpointDelta.added}/−${proposal.endpointDelta.removed}). Review the module before allowing.`,
      // Name the origin on the card: a confirm that lists no origin cannot be
      // audited against one, and this write persists runnable JS for that site.
      origins: [origin],
      sessionId: ctx.session?.sessionId ?? null,
    }, ctx.abortSignal);
    if (ans !== 'yes_once' && ans !== 'yes_session' && ans !== true) {
      return {
        ok: false,
        error: 'site_client_write_rejected',
        content: 'User declined the site-client write.',
        outcomeKind: 'pre-effect-failure',
      };
    }
    if (ctx.abortSignal?.aborted) {
      return {
        ok: false,
        error: 'site_client_write_aborted: the turn stopped during confirmation',
        outcomeKind: 'pre-effect-failure',
      };
    }
    // Confirmation is intentionally unbounded human time. Reauthorize after it
    // and immediately before the mutation; approval is not durable custody.
    const postConfirmRefusal = await siteClientOriginRefusal(origin, ctx);
    if (postConfirmRefusal) return postConfirmRefusal;
    if (ctx.abortSignal?.aborted) {
      return {
        ok: false,
        error: 'site_client_write_aborted: the turn stopped before mutation',
        outcomeKind: 'pre-effect-failure',
      };
    }

    try {
      if (proposal.op === 'delete') {
        await store.remove(origin);
        return { ok: true, content: `deleted site client for ${origin}` };
      }
      const meta = await store.put({ dossier: proposal.dossier, body: proposal.body });
      return { ok: true, content: JSON.stringify({ op: proposal.op, origin: meta.origin, endpoints: meta.endpoints.length, sizeBytes: meta.sizeBytes }, null, 2) };
    } catch (e) {
      return { ok: false, error: `site_client_write_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
