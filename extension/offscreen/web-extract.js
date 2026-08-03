// @ts-check
// offscreen/web-extract.js — HTML → clean markdown for fetch_url.
//
// fetch_url's execute() runs in the SW, which has no DOMParser — so the
// extraction lives in the offscreen document, reached via
// background/offscreen-web-client.js → a 'web/extract' message → this handler
// (the exact shape of the pdf-extract pipeline, its sibling above). The
// pipeline itself is web-extract-core.js (importable without an extension
// context); this module is only the message-handler shell. Same-document
// callers — the headless job runner's `extract:'markdown'` fetch bridge —
// skip the shell and use the core directly (see offscreen.js).
//
// why client-side at all: the hosted "clean content" APIs other agents lean on
// (Firecrawl etc.) are forbidden here — BYOK / no backend / no third party
// sees the user's browsing. This is peerd's privacy-preserving substitute.

import browser from '/vendor/browser-polyfill.js';
import { isTrustedSender } from '/shared/messaging.js';
import { extractWeb } from './web-extract-core.js';

// Gated on isTrustedSender like every sibling handler (pdf/extract, job/run,
// voice) — fail-closed defense-in-depth; see pdf-extract.js's note.
// why cast: the polyfill's OnMessageListener return-type is stricter than this
// fire-and-respond handler (mirrors the sibling listeners).
browser.runtime.onMessage.addListener(/** @type {any} */ ((/** @type {any} */ msg, /** @type {any} */ sender, /** @type {any} */ sendResponse) => {
  if (msg?.type !== 'web/extract') return undefined;
  if (!isTrustedSender(sender)) { sendResponse({ ok: false, error: 'untrusted-sender' }); return true; }
  extractWeb(msg)
    .then((out) => sendResponse(out))
    .catch((e) => sendResponse({ ok: false, error: e?.name ? `${e.name}: ${e.message}` : (e?.message ?? String(e)) }));
  return true;     // async sendResponse contract
}));
