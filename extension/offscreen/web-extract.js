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

export { extractWeb as handleWebExtract } from './web-extract-core.js';
