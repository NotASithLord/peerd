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
import { siteClientOriginRefusal } from './site-client-origin.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const siteClientReadTool = composeTool("site_client_read", {
  execute: async (args, ctx) => {
    const origin = normalizeSiteOrigin(args?.origin);
    if (!origin) return { ok: false, error: 'bad_origin: expected a public HTTP(S) site origin' };
    const refusal = await siteClientOriginRefusal(origin, ctx);
    if (refusal) return refusal;
    const store = /** @type {import('../../site-clients/store.js').SiteClientStore | undefined} */ (
      /** @type {any} */ (ctx).siteClients);
    if (!store) return { ok: false, error: 'site_clients_unavailable' };
    const record = await store.get(origin).catch(() => null);
    // IDB yielded after the first check. Re-read live custody before record
    // bytes cross into the model result; a tab may have moved meanwhile.
    const postReadRefusal = await siteClientOriginRefusal(origin, ctx);
    if (postReadRefusal) return postReadRefusal;
    if (!record) return { ok: false, error: `no_site_client: none stored for ${origin}` };
    const header = stalenessHeader(record.meta);
    const endpoints = record.meta.endpoints?.length
      ? record.meta.endpoints.map((e) => `  ${e.method} ${e.path}${e.note ? ` — ${e.note}` : ''}`).join('\n')
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
