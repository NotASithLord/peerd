// @ts-check
// Design 02 (2a) — extract:'markdown' on the bridged fetch, through the REAL
// extraction pipeline (vendored Readability + Turndown via
// /offscreen/web-extract-core.js), for BOTH bridge hosts:
//
//   - headless (script): the real job-runner sealed worker, with the SAME
//     production adapter offscreen.js injects (extractMarkdownLocal) — so a
//     regression in the adapter or the pipeline itself fails HERE, not just
//     against stubs (job-runner.test.js pins the relay shape with stubs).
//   - notebook tab: the sealed-realm fixture worker with the test page playing
//     the tab host + SW route — the same applyFetchExtract ∘ extractMarkdownLocal
//     composition service-worker.js injects as applyWebExtract.
//
// The spec's parity check: both hosts must return the SAME markdown for the
// same fixture. What stays glue-only (entry files this page cannot import):
// notebook-tab.js's relay lines and service-worker.js's applyWebExtract
// composition — their threading is pinned by tests/background/routes-engine
// .test.ts and tests/engine-tabs/notebook-tab/notebook-neutralizers.test.ts.

import { describe, it, expect } from '../../../framework.js';
import { runJob } from '/offscreen/job-runner.js';
import { applyFetchExtract } from '/shared/fetch-extract.js';
import { extractMarkdownLocal } from '/offscreen/web-extract-core.js';

const FIXTURES = '/tests/unit/engine-tabs/notebook-tab/fixtures';

// An article long enough to clear Readability's isProbablyReaderable
// threshold (three ~330-char paragraphs), ASCII-only so btoa can carry it
// over the same base64 wire shape the audited fetch uses.
const PARAGRAPH = 'The web actor drives pages, but code mode wants the readable page as data. '
  + 'This paragraph exists to push the document over the readerability threshold, '
  + 'so the shipped heuristic treats it as a real article rather than a listing or '
  + 'a dashboard. Extraction then hands the article body to the converter, and the '
  + 'bridge returns clean markdown to the sealed realm.';
const ARTICLE_HTML = '<html><head><title>Extract Parity Fixture</title></head><body><article>'
  + `<h2>The readable core</h2><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p><p>${PARAGRAPH}</p>`
  + '</article></body></html>';
const ARTICLE_URL = 'https://site.example/post';

// The audited-fetch wire result BOTH hosts start from (the sw/web-fetch shape)
// — extraction is a post-step on this, never part of the fetch itself.
const rawFetchResult = () => ({
  ok: true, status: 200, statusText: 'OK',
  headers: { 'content-type': 'text/html; charset=utf-8' },
  bodyB64: btoa(ARTICLE_HTML),
});

/** Run the headless (script) host against the real pipeline. */
const headlessExtract = async () => {
  const r = await runJob(
    {
      code: [
        `const res = await peerd.egress.fetch("${ARTICLE_URL}", { extract: "markdown" });`,
        'return { text: await res.text(), extracted: res.extracted, contentType: res.contentType };',
      ].join('\n'),
    },
    {
      sendToSW: async (type) => (type === 'sw/web-fetch' ? rawFetchResult() : { ok: false }),
      extractMarkdown: extractMarkdownLocal,
    },
  );
  expect(r.error).toBe(null);
  return /** @type {{ text: string, extracted: boolean, contentType: string }} */ (r.value);
};

/** Run the notebook-tab host path (sealed-realm fixture + host-played relay). */
const tabExtract = async () => {
  const worker = new Worker(`${FIXTURES}/seal-probe-worker.js`, { type: 'module' });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for extract-result')), 15000);
      worker.addEventListener('message', async (ev) => {
        const m = ev.data;
        if (!m || typeof m !== 'object') return;
        if (m.type === 'fixture-ready') {
          worker.postMessage({ type: 'extract-fetch', url: ARTICLE_URL });
          return;
        }
        if (m.type === 'fetch-request') {
          // Play notebook-tab.js's relay + the SW route: the audited fetch
          // returns the raw wire result, then the SAME composed extract step
          // the SW injects (applyWebExtract) runs over the real pipeline.
          const resp = await applyFetchExtract(rawFetchResult(), {
            extract: m.extract, url: m.url, extractMarkdown: extractMarkdownLocal,
          });
          worker.postMessage({
            type: 'fetch-response', rid: m.rid,
            ok: resp?.ok ?? false, status: resp?.status ?? 0,
            statusText: resp?.statusText ?? '', headers: resp?.headers ?? null,
            bodyB64: resp?.bodyB64 ?? null, error: resp?.error ?? null,
            ...(typeof resp?.extracted === 'boolean' ? { extracted: resp.extracted } : {}),
          });
          return;
        }
        if (m.type === 'extract-result') {
          clearTimeout(timer);
          resolve(m.fetch);
        }
      });
      worker.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`worker error: ${e.message || 'failed to load'}`));
      }, { once: true });
    });
    return /** @type {{ ok: boolean, extracted: boolean, contentType: string, text: string, error?: string }} */ (result);
  } finally { worker.terminate(); }
};

describe('extract:\'markdown\' through the REAL pipeline (design 02 host parity)', () => {
  it('headless host: the sealed script worker gets real Readability+Turndown markdown', async () => {
    const v = await headlessExtract();
    expect(v.extracted).toBe(true);
    expect(v.contentType).toBe('text/markdown');
    expect(v.text).toContain('readerability threshold');   // article text survived
    expect(v.text.includes('<p>')).toBe(false);            // markdown, not markup
  });

  it('notebook tab path returns the SAME markdown for the same fixture (parity between hosts)', async () => {
    const headless = await headlessExtract();
    const tab = await tabExtract();
    expect(tab.error).toBe(undefined);
    expect(tab.ok).toBe(true);
    expect(tab.extracted).toBe(true);
    expect(tab.contentType).toBe('text/markdown');
    expect(tab.text).toBe(headless.text);   // the spec's parity check
  });
});
