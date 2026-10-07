// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { StarterSection } from '/home/starter-section.js';
import { StarterReview } from '/options/sections/starter-review.js';
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); m.redraw.sync(); };
/** @param {()=>boolean} ready */
const until = async ready => { const end = performance.now() + 5000; while (!ready()) { if (performance.now() > end) throw new Error('starter state did not settle'); await flush(); } };
/** @param {any} component @param {any} attrs */
const mount = (component, attrs) => { const root = document.createElement('div'); document.body.append(root); m.mount(root, { view: () => m(component, attrs) }); return { root, close: () => { m.mount(root, null); root.remove(); } }; };
/** @param {HTMLElement} root @param {string} text */
const button = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text);

describe('packaged starters', () => {
  it('network-off Home shows local examples without enabling, installing or executing, and retains installed Commons', async () => {
    const calls = /** @type {any[]} */ ([]);
    const view = mount(StarterSection, { enabled: false, send: async (/** @type {any} */ message) => { calls.push(message); return { ok: true, apps: [{id:'app-commons',dweb:{seed:'commons'}}] }; } });
    try {
      await until(() => !!button(view.root, 'Open Commons'));
      expect(view.root.textContent).toContain('CSV Lab');
      expect(view.root.textContent).toContain('WebAssembly Image Lab');
      expect(calls.map(call => call.type)).toEqual(['apps/list']);
      button(view.root, 'Open Commons')?.click(); await flush();
      expect(calls[1]).toEqual({type:'apps/open',appId:'app-commons'});
    } finally { view.close(); }
  });
  it('missing Commons stays disabled while networking is off', async () => {
    const view = mount(StarterSection, { enabled:false, send:async () => ({ok:true,apps:[]}) });
    try { await flush(); expect(button(view.root, 'Add and open Commons')?.disabled).toBe(true); }
    finally { view.close(); }
  });
  it('Options inspects packaged data and requires Apply, then a separate Library action', async () => {
    const calls = /** @type {any[]} */ ([]);
    const view = mount(StarterReview, { starter:'wasm-image', send:async (/** @type {any} */ message) => {
      calls.push(message);
      return message.type === 'import/inspect' ? {ok:true,summary:{kind:'app',size:93,fileCount:4}} : {ok:true,kind:'app',id:'app-copy'};
    } });
    try {
      await until(() => !!button(view.root, 'Apply: add local copy'));
      expect(calls.map(call => call.type)).toEqual(['import/inspect']);
      button(view.root, 'Apply: add local copy')?.click(); await flush();
      expect(calls.map(call => call.type)).toEqual(['import/inspect','import/apply']);
      expect(calls[1].envelope).toBe(calls[0].envelope);
      expect(button(view.root, 'Apply: add local copy')).toBe(undefined);
      expect(view.root.textContent).toContain('Local copy added');
      expect(!!button(view.root, 'View in Library')).toBe(true);
    } finally { view.close(); }
  });
  it('an in-flight Apply cannot be duplicated by another click', async () => {
    let applied = 0;
    /** @type {(value:any)=>void} */ let release = () => {};
    const view = mount(StarterReview, { starter:'csv-lab', send:async (/** @type {any} */ message) => {
      if (message.type === 'import/inspect') return {ok:true,summary:{kind:'app',size:2,fileCount:2}};
      applied++; return new Promise(resolve => { release = resolve; });
    } });
    try {
      await until(() => !!button(view.root, 'Apply: add local copy'));
      const apply = button(view.root, 'Apply: add local copy');
      apply?.click(); apply?.click(); await flush();
      expect(applied).toBe(1);
      expect(button(view.root, 'Adding…')?.disabled).toBe(true);
      release({ok:true,kind:'app',id:'app-copy'}); await flush();
      expect(view.root.textContent).toContain('Local copy added');
    } finally { release({ok:false,outcomeKnown:false}); view.close(); }
  });
  it('missing, malformed, rejected and unknown apply replies clear the payload without claiming failure or retrying', async () => {
    for (const result of [null, undefined, {ok:true}, {ok:true,kind:'app'}, {ok:true,kind:'app',id:''}, {ok:false,outcomeKnown:false}, 'throw']) {
      let applied = 0;
      const view = mount(StarterReview, { starter:'csv-lab', send:async (/** @type {any} */ message) => {
        if (message.type === 'import/inspect') return {ok:true,summary:{kind:'app',size:2,fileCount:2}};
        applied++; if (result === 'throw') throw new Error('lost'); return result;
      } });
      try {
        await until(() => !!button(view.root, 'Apply: add local copy'));
        button(view.root, 'Apply: add local copy')?.click(); await flush();
        expect(applied).toBe(1);
        expect(button(view.root, 'Apply: add local copy')).toBe(undefined);
        expect(view.root.textContent).toContain('Check your Library');
        expect(view.root.textContent?.includes('starter was not added')).toBe(false);
      } finally { view.close(); }
    }
  });
});
