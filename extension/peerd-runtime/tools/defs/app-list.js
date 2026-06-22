// @ts-check
// app_list — enumerate saved Apps.

import { serializeListResult } from './columnar.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const appListTool = {
  name: 'app_list',
  primitive: 'app',
  description: [
    'List all peerd-built Apps the user has. Returns id, name, tags,',
    'createdAt, updatedAt, sizeBytes, plus whether each app is',
    'currently open in a tab. Also returns this chat\'s currentAppId',
    '(the app the agent most recently created or updated). Cheap —',
    'reads from metadata, not from app bodies.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: appRegistry / appTabTracker ride the opaque ctx contract (not on the
    // ToolContext typedef); narrow to the surface this tool reads.
    const appRegistry = /** @type {{ snapshot: (opts: { sessionId?: string }) => Promise<{ apps: Array<Record<string, any>>, currentId: string | null }> } | undefined} */ (
      /** @type {any} */ (ctx).appRegistry);
    const appTabTracker = /** @type {{ getTabId: (id: string) => number | null | undefined } | undefined} */ (
      /** @type {any} */ (ctx).appTabTracker);
    if (!appRegistry) return { ok: false, error: 'app_registry_unavailable' };
    const sessionId = ctx.session?.sessionId;
    const snap = await appRegistry.snapshot({ sessionId });
    const apps = snap.apps.map((a) => ({
      id: a.id,
      name: a.name,
      tags: a.tags,
      sizeBytes: a.sizeBytes,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      live: appTabTracker?.getTabId(a.id) != null,
      isCurrent: a.id === snap.currentId,
    }));
    return {
      ok: true,
      content: serializeListResult({
        currentAppId: snap.currentId,
        count: apps.length,
        apps,
      }, 'apps'),
    };
  },
};
