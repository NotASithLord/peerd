// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// site_client_read — read a stored SITE CLIENT's dossier + module source so the
// actor can inspect it before running, or before proposing a patch (DESIGN-19).
//
// The module SOURCE is UNTRUSTED-PROVENANCE (derived from page/response bytes),
// so it comes back FENCED — reading a client to patch it must not let its bytes
// re-enter as instructions. Web-actor-only, same tier as site_client_run.

import { wrapUntrusted } from '../prompt-wrap.js';
import { normalizeSiteOrigin, stalenessHeader } from '../../site-clients/core.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const siteClientReadTool = composeTool("site_client_read", {
  execute: async (args, ctx) => {
    const origin = normalizeSiteOrigin(args?.origin);
    if (!origin) return { ok: false, error: 'bad_origin: expected a public HTTP(S) site origin' };
    const authority = /** @type {{readStoredClient?:(origin:string)=>Promise<{ok:boolean,record?:any,error?:string,outcomeKind?:string}>}|undefined} */ (
      /** @type {any} */ (ctx).siteClientAuthority);
    if (!authority?.readStoredClient) return { ok: false, error: 'site_clients_unavailable' };
    const read = await authority.readStoredClient(origin);
    if (read?.ok !== true) return {
      ok: false, error: read?.error ?? 'site_clients_unavailable',
      ...(read?.outcomeKind ? { outcomeKind: read.outcomeKind } : {}),
    };
    const record = read.record;
    if (!record) return { ok: false, error: `no_site_client: none stored for ${origin}` };
    const header = stalenessHeader(record.meta);
    const endpoints = record.meta.endpoints?.length
      ? record.meta.endpoints.map((/** @type {{method:string,path:string,note?:string}} */ e) =>
        `  ${e.method} ${e.path}${e.note ? `: ${e.note}`: ''}`).join('\n')
      : '  (none recorded)';
    const fenced = wrapUntrusted({
      origin: `site-client(${origin})`,
      tool: 'site_client_read',
      body: [
        `summary: ${record.meta.summary || '(none)'}`,
        `auth posture: ${record.meta.auth}`,
        'endpoints:', endpoints,
        '',
        '--- module source ---',
        record.body,
      ].join('\n'),
    });
    return { ok: true, content: `${header}\n${fenced}` };
  },
});
