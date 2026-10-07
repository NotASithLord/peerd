import { evalIn, waitFor, openExtPage } from './e2e-harness.mjs';
// Render-only proof. Real composed CSV/WASM execution is in the browser suite.
export const STARTER_VISUAL_STATES = [false, true].flatMap(narrow => ['home', 'review', 'empty', 'no-results', 'publisher'].map(mode => ({
  name: `discovery-${mode}${narrow ? '-narrow' : ''}`, kind:'visual', phase:'post-unlock', responder:null,
  async run(ctx, rec) {
    const fixture = mode === 'home' || mode === 'review'
      ? `tests/fixtures/starters.html${mode === 'review' ? '?starter=wasm-image' : ''}`
      : `tests/fixtures/explore.html${mode === 'empty' ? '?empty=1' : ''}`;
    const page = await openExtPage(ctx, fixture);
    try {
      await page.send('Emulation.setDeviceMetricsOverride',{width:narrow?320:960,height:narrow?1450:900,deviceScaleFactor:1,mobile:false});
      const ready = await waitFor(()=>evalIn(page, mode === 'home' ? `document.body.textContent.includes('Add and open Commons')`
        : mode === 'review' ? `document.body.textContent.includes('Apply: add local copy')`
        : mode === 'empty' ? `document.body.textContent.includes('No peer Apps discovered yet')` : `document.querySelectorAll('.disc-card').length === 3`),{budgetMs:8000,pollMs:80});
      if (!ready) throw new Error(`Discovery ${mode} did not render`);
      if (mode === 'no-results') await evalIn(page, `(()=>{const input=document.querySelector('input');input.value='no-such-app';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      if (mode === 'publisher') await evalIn(page, `document.querySelector('details.disc-publisher').open=true`);
      if (mode === 'no-results') {
        const filtered = await waitFor(()=>evalIn(page,`document.body.textContent.includes('No matching Apps') && document.querySelectorAll('.disc-card').length === 0`),{budgetMs:4000,pollMs:50});
        if (!filtered) throw new Error('No-results state did not settle');
      }
      rec.check('discovery surface fits narrow and wide viewport', await evalIn(page,`document.documentElement.scrollWidth <= innerWidth`));
      if (mode === 'home' || mode === 'review') rec.check('starter review has no install, run or network grant',await evalIn(page,`window.__starterFixtureCalls.every(type=>['apps/list','import/inspect'].includes(type))`));
      await rec.visualPage(`discovery-${mode}${narrow ? '-narrow' : ''}`,page);
    } finally { try { page.close(); } catch {} }
  },
})));
