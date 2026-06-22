// @ts-check
// js_list — enumerate Notebooks available to this chat.

import { serializeListResult } from './columnar.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const jsListTool = {
  name: 'js_list',
  primitive: 'notebook',
  description: [
    'List all Notebooks in the user\'s peerd install. Returns id,',
    'name, pinned, createdAt, lastUsedAt, and whether the Notebook is',
    'currently live (has an open tab). Also returns this chat\'s',
    'currentNotebookId — the default for js_notebook if you don\'t pass an',
    'explicit `notebook`. Use when deciding to reuse vs spawn fresh.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: jsRegistry / jsTabTracker ride the opaque ctx contract (not on the
    // ToolContext typedef); narrow to the surface this tool reads.
    const jsRegistry = /** @type {{ snapshot: (opts: { sessionId?: string }) => Promise<{ notebooks: Array<Record<string, any>>, currentId: string | null }> } | undefined} */ (
      /** @type {any} */ (ctx).jsRegistry);
    const jsTabTracker = /** @type {{ getTabId: (id: string) => number | null | undefined } | undefined} */ (
      /** @type {any} */ (ctx).jsTabTracker);
    if (!jsRegistry) return { ok: false, error: 'js_registry_unavailable' };
    const sessionId = ctx.session?.sessionId;
    const snap = await jsRegistry.snapshot({ sessionId });
    const notebooks = snap.notebooks.map((s) => ({
      id: s.id,
      name: s.name,
      pinned: s.pinned,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      live: jsTabTracker?.getTabId(s.id) != null,
      isCurrent: s.id === snap.currentId,
    }));
    return {
      ok: true,
      content: serializeListResult({
        currentNotebookId: snap.currentId,
        count: notebooks.length,
        notebooks,
      }, 'notebooks'),
    };
  },
};
