// @ts-check
// dweb_install — fetch + verify + install an App a peer is sharing on the dweb.
//
// Fetches the signed bundle over the base mesh, verifies the signature + every
// chunk, and saves it to the user's Library as a sandboxed App (no extension
// access). Running code from a peer, so it CONFIRMS every time (the EXTERNAL
// class confirms under the toggle; the execute below force-confirms when the
// toggle is off). dweb-only.

// why: 'dweb' is the network primitive — outside the base Primitive union (the
// dweb module + its tools are pruned on the store build). ctx.dweb and the
// force-confirm slots (ctx.permission, ctx.confirm) are SW-injected; the
// dweb-side confirm prompt is a richer shape than the base ToolContext's confirm,
// so ctx is narrowed at the use site.
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ConfirmAnswer} ConfirmAnswer */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} DwebToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'dweb', execute: (args: any, ctx: ToolContext) => Promise<DwebToolResult> }} DwebTool */

/**
 * The dweb tools' confirm + dweb slots, injected by the SW only on a
 * dweb-enabled build. confirm here takes the dweb prompt shape (richer than the
 * base ToolContext.confirm); dweb.install is an RPC into the pruned-on-store module.
 * @typedef {{
 *   permission?: { confirmActions?: boolean },
 *   confirm?: (p: { tool: string, kind: string, origins: string[], summary: string, sessionId: string | null }) => Promise<ConfirmAnswer>,
 *   dweb?: { install: (o: { uri: string, name?: string }) => Promise<{ ok?: boolean, error?: string, app?: { id?: string, name?: string }, appId?: string, name?: string }> } | null,
 * }} DwebInstallCtx
 */

/** @type {DwebTool} */
export const dwebInstallTool = {
  name: 'dweb_install',
  primitive: 'dweb',
  dweb: true,
  description: [
    'Install an App a peer is sharing on the dweb (from dweb_discover). Pass its',
    'peerd:// uri. The bundle is fetched over the base mesh, its signature and every',
    'chunk verified, and it is saved to the user\'s Library as a sandboxed App.',
    'CONFIRMS every time — it is code from a peer.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      uri: { type: 'string', description: 'The peerd:// uri from dweb_discover.' },
      name: { type: 'string', description: 'Optional local name for the installed app.' },
    },
    required: ['uri'],
  },
  sideEffect: 'mutate_external',
  origins: () => [],

  execute: async (args, ctx) => {
    // why: narrow ctx to the dweb-only slots (dweb surface + force-confirm) the
    // SW injects for dweb builds — absent/loosely-typed on the base ToolContext.
    const dctx = /** @type {DwebInstallCtx} */ (/** @type {unknown} */ (ctx));
    if (!dctx.dweb) return { ok: false, error: 'dweb_unavailable', content: 'The dweb is not enabled in this build.' };
    const uri = String(args?.uri ?? '').trim();
    if (!uri.startsWith('peerd://')) return { ok: false, error: 'peerd_uri_required', content: 'A peerd:// uri is required (from dweb_discover).' };
    if (dctx.permission?.confirmActions === false && dctx.confirm) {
      const ans = await dctx.confirm({
        tool: 'dweb_install', kind: 'dweb_install', origins: [],
        summary: `Install the app at ${uri.slice(0, 72)}… from a peer? It runs sandboxed, with no extension access.`,
        sessionId: ctx.session?.sessionId ?? null,
      });
      if (ans !== 'yes_once' && ans !== 'yes_session') {
        return { ok: false, error: 'declined', content: 'User declined the install.' };
      }
    }
    const r = await dctx.dweb.install({ uri, name: args?.name });
    if (!r?.ok) return { ok: false, error: r?.error ?? 'install_failed' };
    return {
      ok: true,
      content: JSON.stringify({ installed: true, appId: r.app?.id ?? r.appId ?? null, name: r.app?.name ?? r.name ?? null }, null, 2),
    };
  },
};
