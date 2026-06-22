// @ts-check
// app_open — focus or spawn the tab for an App.

/** @type {import('/shared/tool-types.js').Tool} */
export const appOpenTool = {
  name: 'app_open',
  primitive: 'app',
  description: [
    'Open an App in a tab. It opens in the BACKGROUND and a "go there" card',
    'appears in the chat (peerd never yanks the user to a new tab — they click',
    'to go). Becomes the chat\'s current app for follow-up app_update calls.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'App id to open.' },
    },
    required: ['appId'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.appId !== 'string') return { ok: false, error: 'appId_required' };
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls.
    const appClient = /** @type {{ open?: (opts: { appId: string, sessionId?: string, focus?: boolean }) => Promise<string> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient?.open) return { ok: false, error: 'app_not_available' };
    try {
      const id = await appClient.open({
        appId: args.appId,
        sessionId: ctx.session?.sessionId,
        focus: false,   // background + chat card, never steal focus (DESIGN-12)
      });
      return { ok: true, content: JSON.stringify({ opened: id }, null, 2) };
    } catch (e) {
      return { ok: false, error: `app_open_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
