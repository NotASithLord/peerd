// @ts-check
// toolbox_write — persist a durable TOOLBOX module (design js-superpower/06),
// gated on USER CONFIRMATION: the same posture as site_client_write, because
// the danger class is the same — the agent persisting EXECUTABLE code it may
// have authored on a turn whose context held fenced web bytes. A rejection
// persists nothing.
//
// The body's imports are resolution-checked at write time (the resolver's
// transform via ctx.toolboxParseCheck) BEFORE the user is asked — a module with
// an unresolvable import fails the WRITE, not some future run, and the user is
// never prompted to approve one. This is an IMPORT-RESOLUTION check, NOT a
// syntax check: a JS syntax error does not fail the write (eval is CSP-blocked,
// so there is no in-realm parser here).
//
// sideEffect 'write' so the six-gate chain treats it like any mutation; the
// confirm here layers on top of the gates (site-client-write.js is the twin).

import { buildToolboxWriteProposal } from '../../toolbox/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const toolboxWriteTool = {
  name: 'toolbox_write',
  primitive: 'notebook',
  description: [
    'Save (or update) a reusable ES module in your TOOLBOX — the user must',
    'CONFIRM before it persists. Later runs import it:',
    "import { helper } from 'peerd:toolbox/<name>' (script and notebook runs",
    'only). Write a real module with `export`s; it may import peerd:std or',
    'other toolbox modules. It runs under the CALLING run\'s capabilities —',
    'storing it grants nothing. Name: [a-z0-9-]{1,64}. Unresolvable imports',
    'fail the write. To fix a broken module, rewrite it wholesale here.',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['name', 'code'],
    properties: {
      name: { type: 'string', description: 'Module name ([a-z0-9-]{1,64}); the import specifier tail.' },
      description: { type: 'string', description: 'Short prose: what the module does. Shown to the user for consent and on toolbox_list.' },
      code: { type: 'string', description: 'The full module source (ES module — use export).' },
    },
  },
  sideEffect: 'write',
  // IDB write, no web origin touched — the origin/egress gates have nothing to
  // check. The safety is the confirm round-trip below.
  origins: () => [],

  execute: async (args, ctx) => {
    // why: toolbox/toolboxParseCheck ride the opaque ctx contract (not on
    // ToolContext); narrow to what this tool touches.
    const c = /** @type {{ toolbox?: import('../../toolbox/store.js').ToolboxStore, toolboxParseCheck?: (name: string, body: string) => Promise<void> }} */ (
      /** @type {unknown} */ (ctx));
    const store = c.toolbox;
    if (!store) return { ok: false, error: 'toolbox_unavailable' };

    /** @type {ReturnType<typeof buildToolboxWriteProposal>} */
    let proposal;
    /** @type {Awaited<ReturnType<typeof store.get>>} */
    let prior = null;
    try {
      prior = await store.get(typeof args?.name === 'string' ? args.name.trim() : '').catch(() => null);
      proposal = buildToolboxWriteProposal({
        name: args?.name,
        description: args?.description,
        code: args?.code,
        prior,
        moduleCount: (await store.listMeta()).length,
      });
    } catch (e) {
      return { ok: false, error: `invalid_toolbox_module: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (proposal.op === 'noop') return { ok: true, content: 'no change (identical to the stored module).' };

    // Import-resolution check BEFORE the confirm: a module with an unresolvable
    // import never reaches the user, and never persists (a JS syntax error is
    // NOT caught — see makeToolboxParseCheck). The dep is part of the tool's
    // contract — FAIL CLOSED when a ctx assembly lacks it (skipping would
    // silently drop both the import-resolution guarantee and the '../'
    // namespace-escape refusal that rides the same check).
    if (!c.toolboxParseCheck) return { ok: false, error: 'toolbox_unavailable' };
    try { await c.toolboxParseCheck(proposal.name, proposal.body); }
    catch (e) {
      return { ok: false, error: `toolbox_parse_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }

    // Confirm round-trip — the SUMMARY (op, byte counts, export delta, the
    // module's own description) is the consent surface, and it NAMES the body
    // as runnable JS so it never reads like a prose edit. why no "review the
    // code" instruction: the confirm card renders only this summary — it must
    // not tell the user to inspect source the UI doesn't show.
    const confirmAny = /** @type {((p: Record<string, unknown>) => Promise<'yes_once'|'yes_session'|'no'|boolean>) | undefined} */ (
      /** @type {unknown} */ (ctx.confirm));
    if (!confirmAny) return { ok: false, error: 'declined', content: 'No confirmation channel available for a toolbox write.' };
    const ans = await confirmAny({
      tool: 'toolbox_write',
      sideEffect: 'write',
      kind: 'toolbox_write',
      proposal,
      summary: `${proposal.op} toolbox module '${proposal.name}' — persists ${proposal.bodyBytesAfter}B of `
        + `RUNNABLE JS (was ${proposal.bodyBytesBefore}B), exporting ${proposal.exports.length} name(s) `
        + `(+${proposal.exportDelta.added}/−${proposal.exportDelta.removed}).`
        + `${proposal.description ? ` Agent's description: ${proposal.description}` : ''}`,
      origins: [],
      sessionId: ctx.session?.sessionId ?? null,
    });
    if (ans !== 'yes_once' && ans !== 'yes_session' && ans !== true) {
      return { ok: false, error: 'toolbox_write_rejected', content: 'User declined the toolbox write.' };
    }

    try {
      const meta = await store.put({ name: proposal.name, description: proposal.description, body: proposal.body });
      return { ok: true, content: JSON.stringify({ op: proposal.op, name: meta.name, exports: meta.exports, sizeBytes: meta.sizeBytes }, null, 2) };
    } catch (e) {
      return { ok: false, error: `toolbox_write_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
