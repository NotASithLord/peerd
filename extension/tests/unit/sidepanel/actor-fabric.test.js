// @ts-check
// Actor Fabric component contract: self-hiding at rest, live topology at work,
// keyboard-native disclosure, and an inspectable authority/boundary detail.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ActorFabric } from '/sidepanel/components/actor-fabric.js';

/** @param {Record<string, any>} attrs */
const mount = (attrs) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(ActorFabric, attrs) });
  m.redraw.sync();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

describe('ActorFabric', () => {
  it('renders nothing while no isolated actor is live', () => {
    const view = mount({ session: { sessionId: 'chat', messages: [] } });
    try { expect(view.root.querySelector('.actor-fabric')).toBe(null); }
    finally { view.unmount(); }
  });

  it('distinguishes a bound actor from a temporary subactor without color', () => {
    const view = mount({
      session: { sessionId: 'chat', messages: [{ toolUses: [{ id: 'tu-web' }] }] },
      actors: {
        'tu-web': {
          sessionId: 'web-1', rootSessionId: 'chat', parentSessionId: 'chat',
          kind: 'web', instanceId: 'web', task: 'compare the page price',
          visibleTools: ['read_page'], streaming: true, messages: [],
        },
      },
      spawned: { sessions: {
        child: {
          sessionId: 'child', parentSessionId: 'chat', task: 'compare plans',
          rootSessionId: 'chat', running: true, visibleTools: ['script'], messages: [],
        },
      } },
      asyncTasks: {},
    });
    try {
      expect(view.root.querySelectorAll('.actor-fabric-node').length).toBe(3); // root + two actors
      expect(view.root.querySelectorAll('.actor-fabric-node.is-root').length).toBe(1);
      expect(view.root.querySelectorAll('.actor-fabric-node.is-bound').length).toBe(1);
      expect(view.root.querySelectorAll('.actor-fabric-node.is-subactor').length).toBe(1);
      expect(view.root.querySelector('.actor-fabric-working')?.textContent).toBe('2 isolated actors working');
      expect(view.root.querySelector('.actor-fabric-node.is-root .actor-fabric-boundary-chip')?.textContent).toBe('main context');
    } finally { view.unmount(); }
  });

  it('selects a node for practical scope and boundary inspection', () => {
    const view = mount({
      session: { sessionId: 'chat', messages: [{ toolUses: [{ id: 'tu-api' }] }] },
      actors: {
        'tu-api': {
          sessionId: 'api-1', rootSessionId: 'chat', parentSessionId: 'chat',
          kind: 'web', instanceId: 'https://api.example', task: 'read the catalog',
          visibleTools: ['fetch_url'], streaming: true, messages: [],
        },
      },
    });
    try {
      const node = /** @type {HTMLButtonElement} */ (view.root.querySelector('[data-node-id="actor:api-1"]'));
      expect(node.getAttribute('aria-pressed')).toBe('false');
      expect(view.root.querySelector('.actor-fabric-detail')).toBe(null);
      node.click();
      m.redraw.sync();
      expect(node.getAttribute('aria-pressed')).toBe('true');
      expect(view.root.querySelector('.actor-fabric-facts')?.textContent).toContain('one origin · fetch_url');
      expect(view.root.querySelector('.actor-fabric-facts')?.textContent).toContain('fenced reply');
      expect(view.root.querySelector('.actor-fabric-detail')?.getAttribute('role')).toBe('region');
      expect(view.root.querySelector('.actor-fabric-announcer')?.textContent).toContain('details shown');
    } finally { view.unmount(); }
  });

  it('uses a native disclosure button and respects the user collapse', () => {
    const view = mount({
      session: { sessionId: 'chat', messages: [] },
      asyncTasks: { chat: [{ taskId: 'as-1', task: 'work', status: 'running' }] },
    });
    try {
      const toggle = /** @type {HTMLButtonElement} */ (view.root.querySelector('.actor-fabric-toggle'));
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      toggle.click();
      m.redraw.sync();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(view.root.querySelector('.actor-fabric-body')).toBe(null);
    } finally { view.unmount(); }
  });

  it('drops its completion cache when the viewed chat changes', () => {
    const attrs = /** @type {any} */ ({
      session: { sessionId: 'chat-a', messages: [{ toolUses: [{ id: 'tu-a' }] }] },
      actors: {
        'tu-a': {
          sessionId: 'actor-a', rootSessionId: 'chat-a', parentSessionId: 'chat-a',
          kind: 'web', instanceId: 'web', task: 'private task',
          visibleTools: ['read_page'], streaming: true, messages: [],
        },
      },
    });
    const view = mount(attrs);
    try {
      expect(view.root.querySelector('.actor-fabric')?.textContent).toContain('private task');
      attrs.session = { sessionId: 'chat-b', messages: [] };
      attrs.actors = {};
      m.redraw.sync();
      expect(view.root.querySelector('.actor-fabric')).toBe(null);
    } finally { view.unmount(); }
  });
});
