// @ts-check
// site_client_read — read a stored SITE CLIENT's dossier + module source so the
// actor can inspect it before running, or before proposing a patch (DESIGN-19).
//
// The module SOURCE is UNTRUSTED-PROVENANCE (derived from page/response bytes),
// so it comes back FENCED — reading a client to patch it must not let its bytes
// re-enter as instructions. Web-actor-only, same tier as site_client_run.

import { wrapUntrusted } from '../prompt-wrap.js';
import { normalizeSiteOrigin, stalenessHeader } from '../../site-clients/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const siteClientReadTool = {
  name: 'site_client_read',
  primitive: 'web',
  description: [
    'Read the stored SITE CLIENT for an origin — its dossier (what it covers, auth',
    'posture, staleness) and its module source — before running or patching it. The',
    'source is shown fenced (it is derived, untrusted data). Use this to understand',
    'what a client does, then site_client_run to use it or site_client_write to fix it.',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['origin'],
    properties: {
      origin: { type: 'string', description: 'The site origin whose client to read.' },
    },
  },
  sideEffect: 'read',
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
    if (!origin) return { ok: false, error: `bad_origin: ${args?.origin}` };
    const store = /** @type {import('../../site-clients/store.js').SiteClientStore | undefined} */ (
      /** @type {any} */ (ctx).siteClients);
    if (!store) return { ok: false, error: 'site_clients_unavailable' };
    const record = await store.get(origin).catch(() => null);
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
};
