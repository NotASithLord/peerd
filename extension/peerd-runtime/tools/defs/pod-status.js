// @ts-check

/** @type {import('/shared/tool-types.js').Tool} */
export const podStatusTool = {
  name: 'pod_status', primitive: 'pod',
  description: 'Inspect this Pod lifecycle state, cwd, and job table without starting a stopped Pod.',
  schema: { type: 'object', properties: { podId: { type: 'string' } } },
  sideEffect: 'read', origins: () => [],
  execute: async (args, ctx) => {
    const client = /** @type {any} */ (ctx).podClient;
    if (!client?.status) return { ok: false, error: 'pod_unavailable' };
    try { return { ok: true, content: JSON.stringify(await client.status({ sessionId: ctx.session?.sessionId, podId: args?.podId }), null, 2) }; }
    catch (error) { return { ok: false, error: `pod_status_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` }; }
  },
};
