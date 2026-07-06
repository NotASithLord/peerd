// @ts-check
// background/confirm-grant-key.js — the session-grant key for a confirm
// prompt (R5: origin-BOUND grants).
//
// "Yes for this session" used to be keyed by tool name alone, so one
// approval of `click` on site A silently covered `click` on every other
// site that chat visited. The grant key now folds in the prompt's first
// origin whenever the dispatcher computed one (tool.origins(args, ctx) —
// the pinned tab's origin for DOM tools, the target host for web
// writes), so a session grant means "this tool ON this origin". Tools
// that genuinely have no origin (memory writes, VM ops) keep the bare
// tool key — there is no cross-site surface to scope.
//
// Pure (values in, string out) — bun-tested.

/**
 * @param {{ tool: string, origins?: string[] }} prompt
 * @returns {string}
 */
export const confirmGrantKey = (prompt) => {
  const origin = Array.isArray(prompt?.origins) && prompt.origins[0]
    ? String(prompt.origins[0])
    : '';
  return origin ? `${prompt.tool}|${origin}` : prompt.tool;
};
