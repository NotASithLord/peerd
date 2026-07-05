// @ts-check
// kind-dispatch.js — the shared scaffolding for kind-discriminated tools.
//
// why: `inspect({kind})` and `sandbox_create({kind})` (and any future fold of a
// per-kind tool family) share the exact same dispatch shape: a frozen
// kind → handler map, a schema enum derived from its keys, and an execute that
// refuses an unknown kind with the valid kinds listed. Two hand-rolled copies
// were already drifting risks (one gains validation the other misses; the
// refusal wording — which the model's recovery keys on — forks). One helper,
// one wording.

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */

/**
 * The kind values of a handler map, for the schema's enum.
 * @param {Record<string, unknown>} handlers
 * @returns {string[]}
 */
export const kindEnum = (handlers) => Object.keys(handlers);

/**
 * Build the execute for a kind-discriminated tool: looks up args.kind in
 * `handlers`, refuses an unknown/missing kind with the valid list, and
 * otherwise delegates (args pass through untouched — per-kind validation
 * stays in the handler, where the kind's contract lives).
 *
 * @param {string} toolName  for the refusal message
 * @param {Record<string, (args: any, ctx: ToolContext) => ToolResult | Promise<ToolResult>>} handlers
 * @returns {(args: any, ctx: ToolContext) => Promise<ToolResult>}
 */
export const executeByKind = (toolName, handlers) => async (args, ctx) => {
  const kind = args?.kind;
  const handler = typeof kind === 'string' ? handlers[kind] : undefined;
  if (!handler) {
    return { ok: false, error: `${toolName}: unknown kind ${JSON.stringify(kind)} — expected one of ${kindEnum(handlers).join(', ')}.` };
  }
  return handler(args, ctx);
};
