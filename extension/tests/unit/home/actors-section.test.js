// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ActorsSection } from '/home/actors-section.js';

const OVERVIEW = {
  ok: true,
  roots: [{
    session: { sessionId: 'chat-a', title: 'Compare launch plans', model: 'anthropic/sonnet' },
    busy: true,
    activity: 'Coordinating isolated actor work…',
    topology: {
      actors: {
        'tu-web': {
          sessionId: 'web-a', rootSessionId: 'chat-a', parentSessionId: 'chat-a',
          parentToolUseId: 'tu-web', kind: 'web', instanceId: 'web',
          task: 'Read the pricing page', grantedTools: ['read_page'],
          messages: [], streaming: true,
        },
      },
      spawned: { byToolUse: {}, sessions: {
        child: {
          sessionId: 'child', rootSessionId: 'chat-a', parentSessionId: 'chat-a',
          task: 'Compare warranty terms', grantedTools: [], messages: [], running: true,
        },
      } },
      asyncTasks: {},
    },
  }],
};

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync();
};

describe('home.actors', () => {
  it('shows every active context and opens an exact boundary inspector', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    /** @type {string[]} */
    const opened = [];
    const send = async () => OVERVIEW;
    m.mount(root, { view: () => m(ActorsSection, {
      send,
      onOpenSession: (/** @type {string} */ sessionId) => opened.push(sessionId),
      currentSessionId: 'chat-a',
    }) });
    await flush();
    try {
      expect(root.querySelectorAll('.actor-space-room').length).toBe(1);
      expect(root.querySelectorAll('.actor-space-node').length).toBe(3);
      const stats = root.querySelectorAll('.actor-space-stat');
      expect(stats[0].querySelector('strong')?.textContent).toBe('1');
      expect(stats[0].querySelector('span')?.textContent).toBe('orchestrator');
      expect(stats[1].querySelector('strong')?.textContent).toBe('2');
      expect(stats[1].querySelector('span')?.textContent).toBe('isolated actors');
      expect(root.querySelector('.actor-space-node.is-bound')).toBeTruthy();
      expect(root.querySelector('.actor-space-node.is-subactor')).toBeTruthy();

      /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-node.is-bound')).click();
      m.redraw.sync();
      const selected = /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-node.is-bound'));
      const panel = root.querySelector('.actor-space-inspector');
      expect(panel?.textContent).toContain('one web tab · read_page');
      expect(root.querySelector('.actor-space-inspector')?.textContent).toContain('Dedicated keyless worker');
      expect(selected.getAttribute('aria-expanded')).toBe('true');
      expect(selected.getAttribute('aria-controls')).toBe(panel?.id);
      expect(root.querySelector('[aria-live="polite"]')?.textContent).toContain('details shown');

      selected.focus();
      /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-inspector-close')).click();
      m.redraw.sync();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(document.activeElement).toBe(selected);
      expect(selected.getAttribute('aria-expanded')).toBe('false');

      /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-open-chat')).click();
      expect(opened).toEqual(['chat-a']);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('names the chat destination and announces a manual refresh', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    /** @type {(value: any) => void} */
    let finishRefresh = () => {};
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls === 1) return OVERVIEW;
      return new Promise((resolve) => { finishRefresh = resolve; });
    };
    m.mount(root, { view: () => m(ActorsSection, {
      send, onOpenSession: () => {}, currentSessionId: 'chat-a', chatOwnedBySidePanel: true,
    }) });
    await flush();
    try {
      const destination = /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-open-chat'));
      expect(destination.textContent).toBe('Current in side panel');
      expect(destination.disabled).toBe(true);

      const refresh = /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-refresh'));
      refresh.click();
      m.redraw.sync();
      expect(refresh.textContent).toBe('Refreshing…');
      expect(root.querySelector('[aria-live="polite"]')?.textContent).toContain('Refreshing actor activity');
      finishRefresh(OVERVIEW);
      await flush();
      expect(root.querySelector('[aria-live="polite"]')?.textContent).toContain('Actor activity refreshed');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('moves focus to stable controls when polling removes a running actor', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let calls = 0;
    m.mount(root, { view: () => m(ActorsSection, {
      send: async () => (++calls === 1 ? OVERVIEW : { ok: true, roots: [] }),
      onOpenSession: () => {},
    }) });
    await flush();
    try {
      /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-node.is-subactor')).focus();
      /** @type {HTMLButtonElement} */ (root.querySelector('.actor-space-refresh')).click();
      await flush();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(document.activeElement).toBe(root.querySelector('.actor-space-refresh'));
      expect(root.querySelector('[aria-live="polite"]')?.textContent).toContain('Actor finished');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('stays useful as a permanent empty monitor', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, { view: () => m(ActorsSection, {
      send: async () => ({ ok: true, roots: [] }), onOpenSession: () => {},
    }) });
    await flush();
    try {
      expect(root.querySelector('.actor-space-empty')?.textContent).toContain('The instance is quiet');
      expect(root.textContent).toContain('Every active orchestrator');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
