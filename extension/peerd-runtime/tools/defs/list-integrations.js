// @ts-check
// list_integrations — enumerate the API integrations the orchestrator can address.
//
// DESIGN-18 P2. The discovery surface for API actors (the analog of list_tabs for
// tabs): an integration is reached by message_actor("<origin>", …), but unlike a tab
// it has no browser-visible presence, so the agent needs a way to SEE which origins it
// has already formed an integration for (this chat) and which the user has stored a key
// for (so the agent prefers an authenticated integration over an anonymous fetch). The
// SW computes the list (chat-formed bindings ∪ vault origin:<origin> keys); this tool is
// a thin read over ctx.listApiIntegrations. Main-agent only (hidden from actors).

/** @type {import('/shared/tool-types.js').Tool} */
export const listIntegrationsTool = {
  name: 'list_integrations',
  primitive: 'tab',
  description: [
    'List the API integrations you can address with message_actor("<origin>", goal).',
    'Each is an origin-locked, fetch-only API actor that accumulates what it learns.',
    'Includes origins you have already worked this chat (formed:true) and origins the',
    'user has stored an API key for (keyed:true — the key is attached automatically,',
    'same-origin, and you never see it). Prefer a keyed integration for an API that',
    'needs auth. To form a NEW one, just message its origin — it auto-forms.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: listApiIntegrations is an optional SW-injected capability (absent in tests /
    // non-SW dispatch); narrow off the contract slot and fail soft if unwired.
    const list = /** @type {{ listApiIntegrations?: () => Promise<Array<{ origin: string, keyed: boolean, formed: boolean }>> }} */ (ctx).listApiIntegrations;
    if (typeof list !== 'function') {
      return { ok: true, content: JSON.stringify({ count: 0, integrations: [] }, null, 2) };
    }
    let integrations;
    try { integrations = await list(); }
    catch (e) { return { ok: false, error: `list_integrations_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` }; }
    return {
      ok: true,
      content: JSON.stringify({ count: integrations.length, integrations }, null, 2),
    };
  },
};
