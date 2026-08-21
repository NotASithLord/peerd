// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { DiscoverSection } from '/home/discover-section.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync?.();
};

describe('home.discover effect custody', () => {
  it('renders a bounded discovery failure instead of an empty-network lie', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const send = async (/** @type {any} */ message) => {
      if (message.type === 'dweb/base/status') return { ok: true, did: null };
      if (message.type === 'apps/list') return { ok: true, apps: [] };
      return { ok: false, error: 'raw offscreen host epoch' };
    };
    m.mount(root, { view: () => m(DiscoverSection, { send }) });
    try {
      await settle();
      expect(root.textContent).toContain('could not refresh peer apps');
      expect(root.textContent.includes('raw offscreen host epoch')).toBe(false);
      expect(root.textContent.includes('Nothing shared yet')).toBe(false);
      expect(root.querySelector('[role="alert"]')).toBeTruthy();
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('does not expose or replay an install whose outcome is unconfirmed', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = {
      dwapp_id: 'dwapp-1', uri: 'peerd://did:key:zPeer/app', name: 'Peer App',
      slug: 'app', seq: 1, publisher: 'did:key:zPeer', version_id: 'v1',
    };
    let catalogHasApp = false;
    /** @type {any[]} */
    const calls = [];
    const send = async (/** @type {any} */ message) => {
      calls.push(message);
      if (message.type === 'dweb/base/status') return { ok: true, did: 'did:key:zSelf' };
      if (message.type === 'dweb/base/heard') return { ok: true, apps: [app] };
      if (message.type === 'apps/list') {
        return { ok: true, apps: catalogHasApp ? [{
          id: 'local-app', dweb: {
            uri: app.uri, dwapp_id: app.dwapp_id, version_id: app.version_id, seq: app.seq,
          },
        }] : [] };
      }
      if (message.type === 'dweb/base/install') return {
        ok: false, error: 'raw renderer transport text', outcomeKnown: false,
        outcomeKind: 'unknown', retryable: false,
      };
      if (message.type === 'apps/open') return { ok: true };
      return { ok: false };
    };
    m.mount(root, { view: () => m(DiscoverSection, { send }) });
    try {
      await settle();
      const install = /** @type {HTMLButtonElement} */ (
        [...root.querySelectorAll('button')].find((entry) => entry.textContent === 'Install')
      );
      install.click();
      await settle();
      expect(root.textContent).toContain('could not confirm whether the install finished');
      expect(root.textContent.includes('raw renderer transport text')).toBe(false);
      const reconcile = /** @type {HTMLButtonElement} */ (
        [...root.querySelectorAll('button')].find((entry) => entry.textContent === 'Refresh to reconcile')
      );
      expect(reconcile.disabled).toBe(true);
      reconcile.click();
      await settle();
      expect(calls.filter((call) => call.type === 'dweb/base/install').length).toBe(1);
      /** @type {HTMLButtonElement} */ (root.querySelector('button.disc-refresh')).click();
      await settle();
      expect(root.textContent).toContain('Refresh to reconcile');
      expect(calls.filter((call) => call.type === 'dweb/base/install').length).toBe(1);
      catalogHasApp = true;
      /** @type {HTMLButtonElement} */ (root.querySelector('button.disc-refresh')).click();
      await settle();
      expect(root.textContent).toContain('Open ↗');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('keeps an unknown update fenced until the exact announced version lands', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const announced = {
      dwapp_id: 'dwapp-update', uri: 'peerd://did:key:zPeer/update', name: 'Peer App',
      slug: 'app', seq: 2, publisher: 'did:key:zPeer', version_id: 'v2',
    };
    let localVersion = 'v1';
    let localSeq = 1;
    /** @type {any[]} */
    const calls = [];
    const send = async (/** @type {any} */ message) => {
      calls.push(message);
      if (message.type === 'dweb/base/status') return { ok: true, did: 'did:key:zSelf' };
      if (message.type === 'dweb/base/heard') return { ok: true, apps: [announced] };
      if (message.type === 'apps/list') return { ok: true, apps: [{
        id: 'local-app', dweb: {
          uri: announced.uri, dwapp_id: announced.dwapp_id,
          version_id: localVersion, seq: localSeq,
        },
      }] };
      if (message.type === 'dweb/base/update-app') return {
        ok: false, outcomeKnown: false, outcomeKind: 'unknown', retryable: false,
      };
      return { ok: false };
    };
    m.mount(root, { view: () => m(DiscoverSection, { send }) });
    try {
      await settle();
      const update = /** @type {HTMLButtonElement} */ (
        [...root.querySelectorAll('button')].find((entry) => entry.textContent === 'Update')
      );
      update.click();
      await settle();
      expect(root.textContent).toContain('Refresh to reconcile');

      for (let index = 0; index < 2; index += 1) {
        /** @type {HTMLButtonElement} */ (root.querySelector('button.disc-refresh')).click();
        await settle();
        expect(root.textContent).toContain('Refresh to reconcile');
      }
      expect(calls.filter((call) => call.type === 'dweb/base/update-app').length).toBe(1);

      localVersion = 'v2';
      localSeq = 2;
      /** @type {HTMLButtonElement} */ (root.querySelector('button.disc-refresh')).click();
      await settle();
      expect(root.textContent.includes('Refresh to reconcile')).toBe(false);
      expect(root.textContent).toContain('Open ↗');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
