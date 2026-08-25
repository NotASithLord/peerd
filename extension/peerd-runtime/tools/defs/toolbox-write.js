// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// toolbox_write — persist a durable TOOLBOX module (design js-superpower/06),
// gated on USER CONFIRMATION: the same posture as site_client_write, because
// the danger class is the same — the agent persisting EXECUTABLE code it may
// have authored on a turn whose context held fenced web bytes. A rejection
// persists nothing.
//
// The body is parsed before the user is asked. Local, builtin, and toolbox
// imports are resolution-checked. Preview remote specifier policy and the
// direct graph-count limit are checked without fetching third-party source, so
// remote availability and transitive dependencies remain runtime checks.
//
// sideEffect 'write' so the six-gate chain treats it like any mutation; the
// confirm here layers on top of the gates (site-client-write.js is the twin).

import { buildToolboxWriteProposal } from '../../toolbox/core.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const toolboxWriteTool = composeTool("toolbox_write", {

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

    // Parse and supported-resolution check before confirm. The dependency is
    // part of the tool contract, so fail closed when a context lacks it.
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
    const confirmAny = /** @type {((p: Record<string, unknown>, signal?: AbortSignal) => Promise<'yes_once'|'yes_session'|'no'|boolean>) | undefined} */ (
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
    }, ctx.abortSignal);
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
});
