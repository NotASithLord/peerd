// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { createSessionStore } from '/peerd-runtime/index.js';
import { idb } from '/peerd-egress/index.js';
import { SessionsView } from '/sidepanel/components/sessions-view.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync();
};

describe('sidepanel sessions accessible actions', () => {
  it('names Archive for its persisted chat and archives without switching', async () => {
    const store = createSessionStore({ idb });
    const messageId = crypto.randomUUID();
    const root = document.createElement('div');
    const session = await store.create();
    try {
      await store.appendMessage(session.sessionId, {
        role: 'user', id: messageId, when: Date.now(), content: document.title || 'Untitled chat',
      });
      const title = (await store.get(session.sessionId))?.title;
      expect(!!title).toBe(true);
      /** @type {any[]} */
      const sent = [];
      let navigations = 0;
      document.body.appendChild(root);
      m.mount(root, { view: () => m(SessionsView, {
        state: { session: { sessionId: session.sessionId } },
        onNavigateToChat: () => { navigations += 1; },
        send: async (/** @type {any} */ message) => {
          sent.push(message);
          if (message.type === 'session/archive') await store.archive(message.sessionId);
          return { ok: true, sessions: (await store.list()).filter((row) => row.sessionId === session.sessionId)
            .map((row) => ({ sessionId: row.sessionId, title: row.title,
              lastMessageAt: row.createdAt, messageCount: row.messages.length, archived: !!row.archivedAt })) };
        },
      }) });
      const loadDeadline = performance.now() + 2_000;
      while (performance.now() < loadDeadline && !root.querySelector('.session-archive')) await settle();
      const archive = /** @type {HTMLButtonElement} */ (root.querySelector('.session-archive'));
      expect(archive.getAttribute('aria-label')).toBe(`Archive chat “${title}”`);
      expect(archive.title).toBe('Archive');
      archive.click();
      const archiveDeadline = performance.now() + 2_000;
      while (performance.now() < archiveDeadline && root.querySelector('.session-row')) await settle();
      expect(root.querySelector('.session-row')).toBe(null);
      expect(sent.filter((message) => message.type !== 'session/list')).toEqual([
        { type: 'session/archive', sessionId: session.sessionId },
      ]);
      expect(!!(await store.get(session.sessionId))?.archivedAt).toBe(true);
      expect(navigations).toBe(0);
    } finally {
      try { m.mount(root, null); }
      finally {
        root.remove();
        try { await idb.del('session_messages', messageId); }
        finally { await idb.del('sessions', session.sessionId); }
      }
    }
  });
});
