// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
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

/** @type {import('/shared/tool-types.js').Tool} */
export const siteClientWriteTool = composeTool("site_client_write", {

  execute: async (args, ctx) => {
    const origin = normalizeSiteOrigin(args?.origin);
    if (!origin) {
      return {
        ok: false,
        error: 'bad_origin: expected a public HTTP(S) site origin',
        outcomeKind: 'pre-effect-failure',
      };
    }
    const authority = /** @type {{readStoredClient?:(origin:string)=>Promise<{ok:boolean,record?:any,error?:string,outcomeKind?:string}>,commitConfirmedClient?:(origin:string)=>Promise<{ok:boolean,op?:string,meta?:any,error?:string,content?:string,outcomeKind?:string}>}|undefined} */ (
      /** @type {any} */ (ctx).siteClientAuthority);
    if (!authority?.readStoredClient || !authority.commitConfirmedClient) {
      return { ok: false, error: 'site_clients_unavailable', outcomeKind: 'pre-effect-failure' };
    }
    if (args?.body !== undefined && typeof args.body !== 'string') {
      return { ok: false, error: 'body_must_be_string', outcomeKind: 'pre-effect-failure' };
    }

    const read = await authority.readStoredClient(origin);
    if (read?.ok !== true) return {
      ok: false, error: read?.error ?? 'site_clients_unavailable',
      outcomeKind: read?.outcomeKind ?? 'pre-effect-failure',
    };
    const prior = read.record ?? null;
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

    const committed = await authority.commitConfirmedClient(origin);
    if (committed?.ok !== true) return {
      ok: false, error: committed?.error ?? 'site_client_write_failed',
      ...(committed?.content ? { content: committed.content } : {}),
      ...(committed?.outcomeKind ? { outcomeKind: committed.outcomeKind } : {}),
    };
    if (committed.op === 'delete') {
      return { ok: true, content: `deleted site client for ${origin}` };
    }
    const meta = committed.meta;
    return {
      ok: true,
      content: JSON.stringify({
        op: committed.op, origin: meta.origin,
        endpoints: meta.endpoints.length, sizeBytes: meta.sizeBytes,
      }, null, 2),
    };
  },
});
