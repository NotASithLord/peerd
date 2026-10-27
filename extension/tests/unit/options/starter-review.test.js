// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { makeOptionsApp } from '/options/components/options-app-core.js';
import { StarterReview } from '/options/sections/starter-review.js';
import { OUTCOME_UNKNOWN_USER_FAILURE } from '/shared/bounded-module-load.js';
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); m.redraw.sync(); };
/** @param {()=>boolean} ready */
const until = async ready => { const end = performance.now() + 5000; while (!ready()) { if (performance.now() > end) throw new Error('starter state did not settle'); await flush(); } };
/** @param {any} component @param {any} attrs */
const mount = (component, attrs) => { const root = document.createElement('div'); document.body.append(root); m.mount(root, { view: () => m(component, attrs) }); return { root, close: () => { m.mount(root, null); root.remove(); } }; };
/** @param {HTMLElement} root @param {string} text */
const button = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text);

describe('packaged starters', () => {
  it('actual Settings shell mounts ordinary transfer and remounts each starter review under its own title', async () => {
    const originalParam = m.route.param;
    /** @type {string|undefined} */ let starter;
    m.route.param = () => starter;
    const calls = /** @type {any[]} */ ([]);
    /** @type {ReturnType<typeof mount>|undefined} */ let view;
    try {
      view = mount(makeOptionsApp(), { section:'transfer', state:{vault:{initialized:true,locked:false}}, send:async (/** @type {any} */ message) => {
        calls.push(message);
        return message.type === 'import/inspect' ? {ok:true,summary:{kind:'app',size:93,fileCount:4}} : {ok:true};
      } });
      const root = view.root;
      const title = () => root.querySelector('.options-page > h2')?.textContent;
      expect(!!root.querySelector('#exppass')).toBe(true);
      expect(title()).toBe('Backup & restore');
      starter = 'csv-lab'; await flush();
      await until(() => !!button(root, 'Add to Library'));
      expect(root.textContent).toContain('Tables and charts');
      // The line under the name says what the app does, as Discover's tile does.
      expect(root.querySelector('.starter-review h3 + p')?.textContent).toBe('Explore tables, numbers and a chart, all on your device.');
      // Discover's Try opens this page, and it only adds the app.
      expect(title()).toBe('Try an app');
      const first = calls.filter(call => call.type === 'import/inspect')[0].envelope;
      starter = 'wasm-image'; await flush();
      await until(() => !!button(root, 'Add to Library'));
      expect(root.textContent).toContain('Desaturator');
      expect(root.querySelector('.starter-review h3 + p')?.textContent).toBe('Make a picture gray, or black and white, all on your device.');
      expect(calls.filter(call => call.type === 'import/inspect').length).toBe(2);
      expect(calls.filter(call => call.type === 'import/inspect')[1].envelope === first).toBe(false);
      starter = undefined; await flush();
      expect(!!view.root.querySelector('#exppass')).toBe(true);
      expect(title()).toBe('Backup & restore');
      expect(calls.some(call => call.type === 'import/apply')).toBe(false);
    } finally { try { view?.close(); } finally { m.route.param = originalParam; } }
  });
  it('after an add peerd confirms, Go to Library leads and the line says that another add makes a second copy', async () => {
    const view = mount(StarterReview, { starter:'csv-lab', send:async (/** @type {{type:string}} */ message) =>
      message.type === 'import/inspect' ? {ok:true,summary:{kind:'app',size:2,fileCount:2}} : {ok:true,kind:'app',id:'app-copy'} });
    try {
      await until(() => !!button(view.root, 'Add to Library'));
      expect(button(view.root, 'Go to Library')?.classList.contains('secondary')).toBe(true);
      button(view.root, 'Add to Library')?.click(); await flush();
      expect(view.root.querySelector('[role="status"]')?.textContent)
        .toBe('Added to your Library. Open it from there. If you add it again, you get a second copy.');
      expect(button(view.root, 'Go to Library')?.classList.contains('secondary')).toBe(false);
    } finally { view.close(); }
  });
  it('Options inspects packaged data and requires Add to Library, then a separate Library action', async () => {
    const calls = /** @type {any[]} */ ([]);
    const view = mount(StarterReview, { starter:'wasm-image', send:async (/** @type {any} */ message) => {
      calls.push(message);
      return message.type === 'import/inspect' ? {ok:true,summary:{kind:'app',size:93,fileCount:4}} : {ok:true,kind:'app',id:'app-copy'};
    } });
    try {
      await until(() => !!button(view.root, 'Add to Library'));
      expect(calls.map(call => call.type)).toEqual(['import/inspect']);
      button(view.root, 'Add to Library')?.click(); await flush();
      expect(calls.map(call => call.type)).toEqual(['import/inspect','import/apply']);
      expect(calls[1].envelope).toBe(calls[0].envelope);
      expect(button(view.root, 'Add to Library')).toBe(undefined);
      expect(view.root.textContent).toContain('Added to your Library.');
      expect(!!button(view.root, 'Go to Library')).toBe(true);
    } finally { view.close(); }
  });
  it('an in-flight Add to Library cannot be duplicated by another click', async () => {
    let applied = 0;
    /** @type {(value:any)=>void} */ let release = () => {};
    const view = mount(StarterReview, { starter:'csv-lab', send:async (/** @type {any} */ message) => {
      if (message.type === 'import/inspect') return {ok:true,summary:{kind:'app',size:2,fileCount:2}};
      applied++; return new Promise(resolve => { release = resolve; });
    } });
    try {
      await until(() => !!button(view.root, 'Add to Library'));
      const apply = button(view.root, 'Add to Library');
      apply?.click(); apply?.click(); await flush();
      expect(applied).toBe(1);
      expect(button(view.root, 'Adding…')?.disabled).toBe(true);
      release({ok:true,kind:'app',id:'app-copy'}); await flush();
      expect(view.root.textContent).toContain('Added to your Library.');
    } finally { release({ok:false,outcomeKnown:false}); view.close(); }
  });
  it('says what the app is in plain words, with no package jargon; a failure says what failed, then what to do', async () => {
    /** @param {unknown} inspect */
    const reviewOf = (inspect) => mount(StarterReview, { starter:'csv-lab', send:async (/** @type {{type:string}} */ message) =>
      message.type === 'import/inspect' ? inspect : {ok:false,error:'import-rejected'} });
    const view = reviewOf({ok:true,summary:{kind:'app',size:7920,fileCount:5}});
    try {
      await until(() => !!button(view.root, 'Add to Library'));
      const text = view.root.textContent ?? '';
      expect(view.root.querySelector('h3')?.textContent).toBe('Tables and charts');
      expect(text).toContain('Comes with peerd. It runs on this device and needs no network.');
      for (const jargon of ['Peerd', 'App', 'bundle bytes', 'files;', 'packaged', 'local copy']) expect(text.includes(jargon)).toBe(false);
      button(view.root, 'Add to Library')?.click(); await flush();
      expect(view.root.querySelector('[role="alert"]')?.textContent).toBe('peerd could not add the app to your Library. Reload the page, then try again.');
    } finally { view.close(); }
    const unchecked = reviewOf({ok:false,error:'raw inspection text'});
    try {
      await until(() => !!unchecked.root.querySelector('[role="alert"]'));
      expect(unchecked.root.querySelector('[role="alert"]')?.textContent).toBe('peerd could not check this app. Reload the page, then try again.');
      expect(button(unchecked.root, 'Add to Library')).toBe(undefined);
    } finally { unchecked.close(); }
  });
  it('missing, malformed, rejected and unknown apply replies clear the payload without claiming failure or retrying', async () => {
    for (const result of [null, undefined, {ok:true}, {ok:true,kind:'app'}, {ok:true,kind:'app',id:''}, {ok:false,outcomeKnown:false}, {ok:false,outcomeKnown:false,error:OUTCOME_UNKNOWN_USER_FAILURE}, 'throw']) {
      let applied = 0;
      const view = mount(StarterReview, { starter:'csv-lab', send:async (/** @type {any} */ message) => {
        if (message.type === 'import/inspect') return {ok:true,summary:{kind:'app',size:2,fileCount:2}};
        applied++; if (result === 'throw') throw new Error('lost'); return result;
      } });
      try {
        await until(() => !!button(view.root, 'Add to Library'));
        button(view.root, 'Add to Library')?.click(); await flush();
        expect(applied).toBe(1);
        expect(button(view.root, 'Add to Library')).toBe(undefined);
        expect(view.root.textContent).toContain('peerd is not sure the app was added. Check your Library before you add it again.');
        expect(/Refresh|reconcile/.test(view.root.textContent ?? '')).toBe(false);
        expect(view.root.textContent?.includes('starter was not added')).toBe(false);
      } finally { view.close(); }
    }
  });
});
