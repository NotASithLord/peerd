// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { encodeDidKey } from '/shared/address/did.js';
import { discoveryAddress } from '/home/discovery-address.js';
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

describe('home.discover Explore controls', () => {
  it('bounds rendered cards, filters signed WASM hints, and never installs through browsing', async () => {
    const root = document.createElement('div'); document.body.appendChild(root);
    const apps = Array.from({length:130}, (_,i) => ({dwapp_id:`app-${i}`,name:`App ${i}`,publisher:`publisher-${i % 7}`,
      description:`Description ${i}`,size:1000,includes_wasm:i % 3 === 0 ? true : i % 3 === 1 ? false : null,uri:`peerd://publisher/hash-${i}`}));
    /** @type {string[]} */ const writes = [];
    const send = async (/** @type {any} */ message) => {
      if (message.type === 'dweb/base/heard') return {ok:true,apps};
      if (message.type === 'apps/list') return {ok:true,apps:[]};
      if (message.type === 'dweb/base/status') return {ok:true,did:null};
      writes.push(message.type); return {ok:true};
    };
    /** @param {string} label */
    const click = async label => {
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')].find(b => b.textContent === label)).click();
      await settle();
    };
    m.mount(root,{view:()=>m(DiscoverSection,{send})});
    try {
      await settle(); expect(root.querySelectorAll('.disc-card').length).toBe(24);
      const before = [...root.querySelectorAll('.disc-name')].map(el=>el.textContent).join(',');
      /** @type {HTMLButtonElement} */ (root.querySelector('.disc-refresh')).click(); await settle();
      expect([...root.querySelectorAll('.disc-name')].map(el=>el.textContent).join(',')).toBe(before);
      await click('Show more'); await click('Show more'); await click('Show more');
      expect(root.querySelectorAll('.disc-card').length).toBe(96);
      await click('Next Apps'); expect(root.querySelectorAll('.disc-card').length).toBe(24);
      expect(root.textContent).toContain('Showing 97–120');
      await click('Previous Apps'); expect(root.querySelectorAll('.disc-card').length).toBe(96);
      const filter = /** @type {HTMLSelectElement} */ (root.querySelector('select'));
      filter.value='unknown'; filter.dispatchEvent(new Event('change',{bubbles:true})); await settle();
      expect([...root.querySelectorAll('.disc-card')].every(card=>card.textContent?.includes('WebAssembly not specified'))).toBe(true);
      await click('Shuffle'); expect(writes.length).toBe(0);
    } finally {m.mount(root,null);root.remove();}
  });
});

describe('home.discover polling custody', () => {
it('preserves existing card nodes and pending effects when a refreshed catalog adds or removes peers', async () => {
  const root = document.createElement('div'); document.body.appendChild(root);
  const first = {dwapp_id:'pending',name:'Pending App',publisher:'publisher-a',uri:'peerd://a/hash'};
  let apps = [first];
  /** @type {(value:any)=>void} */ let finish = () => {};
  const effect = new Promise(resolve=>{finish=resolve;});
  const send = async (/** @type {any} */ message) => {
    if (message.type === 'dweb/base/heard') return {ok:true,apps};
    if (message.type === 'apps/list') return {ok:true,apps:[]};
    if (message.type === 'dweb/base/status') return {ok:true,did:null};
    if (message.type === 'dweb/base/install') return effect;
    return {ok:false};
  };
  m.mount(root,{view:()=>m(DiscoverSection,{send})});
  try {
    await settle();
    const original = root.querySelector('.disc-card');
    /** @type {HTMLButtonElement} */ (original?.querySelector('button')).click(); await settle();
    apps = [{dwapp_id:'new',name:'New App',publisher:'publisher-b',uri:'peerd://b/hash'}];
    /** @type {HTMLButtonElement} */ (root.querySelector('.disc-refresh')).click(); await settle();
    expect(root.querySelector('.disc-card')).toBe(original);
    expect(original?.textContent).toContain('Installing');
    expect(root.querySelectorAll('.disc-card').length).toBe(2);
    finish({ok:false,outcomeKnown:false}); await settle();
    /** @type {HTMLButtonElement} */ (root.querySelector('.disc-refresh')).click(); await settle();
    expect(root.querySelector('.disc-card')).toBe(original);
    expect(original?.textContent).toContain('Refresh to reconcile');
  } finally {finish({ok:false});m.mount(root,null);root.remove();}
});

});


describe('home.discover immutable address copy', () => {
  const publisher = encodeDidKey(new Uint8Array(32));
  const hash = 'a'.repeat(64);
  const originalApp = { dwapp_id: 'copy-app', name: 'Copy App', publisher, version_id: hash,
    uri: `peerd://${publisher}/${hash}`, slug: 'copy-app', seq: 1 };
  /** @param {any} clipboard @param {(fixture:any)=>Promise<void>} run */
  const withCopy = async (clipboard, run) => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    let app = { ...originalApp };
    /** @type {any[]} */ const calls = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const send = async (/** @type {any} */ message) => {
      calls.push(message);
      if (message.type === 'dweb/base/heard') return { ok: true, apps: [app] };
      if (message.type === 'apps/list') return { ok: true, apps: [] };
      if (message.type === 'dweb/base/status') return { ok: true, did: null };
      return { ok: false };
    };
    m.mount(root, { view: () => m(DiscoverSection, { send }) });
    try {
      await settle();
      await run({ root, calls, update: (/** @type {any} */ next) => { app = next; } });
    } finally {
      m.mount(root, null); root.remove();
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete /** @type {any} */ (navigator).clipboard;
    }
  };

  it('copies only the exact canonical revision without network or install effects', async () => {
    /** @type {string[]} */ const writes = [];
    await withCopy({ writeText: async (/** @type {string} */ text) => { writes.push(text); } }, async ({ root, calls }) => {
      const before = calls.length;
      root.querySelector('.disc-copy-address').click(); await settle();
      expect(writes).toEqual([discoveryAddress(originalApp)]);
      expect(calls.length).toBe(before);
      expect(root.textContent).toContain('Paste it into Peerd Discover');
      expect(root.textContent).toContain(discoveryAddress(originalApp));
    });
  });

  for (const clipboard of [undefined, { writeText: async () => { throw new Error('permission denied raw error'); } }]) {
    it('reports unavailable or rejected clipboard access without claiming success', async () => {
      await withCopy(clipboard, async ({ root }) => {
        root.querySelector('.disc-copy-address').click(); await settle();
        expect(root.textContent).toContain('Could not copy. Select this address');
        expect(root.textContent.includes('Copied this exact revision')).toBe(false);
        expect(root.textContent.includes('permission denied raw error')).toBe(false);
        expect(root.querySelector('.disc-copy-address').disabled).toBe(false);
      });
    });
  }

  it('disables copying when current discovery coordinates disagree', async () => {
    let writes = 0;
    await withCopy({ writeText: async () => { writes++; } }, async ({ root, update }) => {
      update({ ...originalApp, version_id: 'b'.repeat(64) });
      root.querySelector('.disc-refresh').click(); await settle();
      expect(root.querySelector('.disc-copy-address').disabled).toBe(true);
      root.querySelector('.disc-copy-address').click(); await settle();
      expect(writes).toBe(0);
    });
  });

  it('never labels a refreshed revision as copied when an older clipboard request completes', async () => {
    /** @type {(value?:any)=>void} */ let release = () => {};
    const pending = new Promise(resolve => { release = resolve; });
    /** @type {string[]} */ const writes = [];
    await withCopy({ writeText: async (/** @type {string} */ text) => { writes.push(text); await pending; } }, async ({ root, update }) => {
      try {
        root.querySelector('.disc-copy-address').click(); await settle();
        const revision = 'b'.repeat(64);
        update({ ...originalApp, seq: 2, version_id: revision, uri: `peerd://${publisher}/${revision}` });
        root.querySelector('.disc-refresh').click(); await settle();
        release(); await settle();
        expect(root.textContent.includes('Copied this exact revision')).toBe(false);
        root.querySelector('.disc-copy-address').click(); await settle();
        expect(writes).toEqual([discoveryAddress(originalApp), discoveryAddress({ publisher, version_id: revision, uri: `peerd://${publisher}/${revision}` })]);
      } finally { release(); }
    });
  });
});
