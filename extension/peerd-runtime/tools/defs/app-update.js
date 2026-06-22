// @ts-check
// app_update — modify an existing App.
//
// Convenience: replace the entry file's content (HTML) and/or rename.
// For granular updates to a SPECIFIC file (style.css, script.js,
// data.json), use app_write_file. For deleting a non-entry file,
// app_delete_file.

const MAX_HTML_CHARS = 1_000_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const appUpdateTool = {
  name: 'app_update',
  primitive: 'app',
  description: [
    'Update an existing App: replace its entry file (index.html by',
    'default) with new HTML, and/or rename/retag. If the user has the',
    'app\'s tab open, it reloads automatically so the change shows live.',
    'Without an explicit `appId`, targets the chat\'s current app.',
    '',
    'For per-file edits (e.g. just style.css), use app_write_file.',
    'For granular file ops, use app_read_file / app_list_files /',
    'app_delete_file.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      appId: { type: 'string', description: 'App id to update (default: current).' },
      name: { type: 'string', description: 'New display name.' },
      html: { type: 'string', description: 'Replacement entry-file content.' },
      tags: { type: 'array', items: { type: 'string' } },
      entryFile: { type: 'string', description: 'Switch the entry to a different file.' },
    },
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls.
    const appClient = /** @type {{ update?: (opts: { appId?: string, name?: string, html?: string, tags?: string[], entryFile?: string, sessionId?: string }) => Promise<{ id: string, name: string, entryFile: string, updatedAt: number } | null | undefined> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient?.update) return { ok: false, error: 'app_not_available' };
    if (typeof args?.html === 'string' && args.html.length > MAX_HTML_CHARS) {
      return { ok: false, error: `html_too_large: ${args.html.length} > ${MAX_HTML_CHARS}` };
    }
    try {
      const record = await appClient.update({
        appId: args.appId,
        name: args.name,
        html: args.html,
        tags: args.tags,
        entryFile: args.entryFile,
        sessionId: ctx.session?.sessionId,
      });
      if (!record) return { ok: false, error: 'app_not_found' };
      return {
        ok: true,
        content: JSON.stringify({
          id: record.id,
          name: record.name,
          entryFile: record.entryFile,
          updatedAt: record.updatedAt,
        }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: `app_update_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
