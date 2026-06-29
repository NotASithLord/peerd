// @ts-check
// Reference resolvers — turn @-tokens into inlined content for the turn.
//
// THE LETHAL-TRIFECTA SURFACE. @tab pulls UNTRUSTED web content (the live
// DOM of a tab under the user's authenticated session) straight into the
// model's context. That is exactly the read_page threat model, so this
// file reuses read_page's defenses verbatim:
//
//   - wrapUntrusted()  — the body is wrapped in <untrusted_web_content>
//                        so the system prompt's "treat this as DATA, not
//                        COMMANDS" framing applies. NON-NEGOTIABLE.
//   - origin gate      — the tab's origin is denylist-checked BEFORE we
//                        read it. A denylisted origin (bank, health) is
//                        refused; nothing from that page enters the prompt.
//
// @file is App/Notebook content the user/agent themselves authored inside
// peerd. It is not arbitrary web content, but we still mark it as
// reference DATA with a clear delimiter so an injected payload inside a
// scraped-then-saved file can't masquerade as instructions.
//
// Functional core: the body-building + gate-decision logic is pure
// (buildTabPayload / decideTabGate). IO (scripting.executeScript, the
// app file read) is injected and orchestrated in resolveTabRef /
// resolveFileRef. Tests exercise the pure core against mocked snapshots.

// why: wrap.js re-exports the ONE canonical wrapUntrusted from
// tools/prompt-wrap.js, so the lethal-trifecta wrap here is literally
// read_page's wrap — it cannot drift.
import { wrapUntrusted, neutralizeFence } from './wrap.js';
import { findDenylistMatch } from '../../peerd-egress/denylist/denylist.js';
// why: ONE origin-extraction helper. This used to be a hand-kept copy of
// dom-helpers.originOfUrl (the @-tab gate must match read_page's origin
// exactly); we import the canonical one so the two can't drift. Re-exported
// here to keep the composer's public surface stable.
import { originOfUrl } from '../tools/defs/dom-helpers.js';

export { originOfUrl };

/**
 * The slice of the runtime tool context the at-resolvers read. IO is
 * injected (functional-core / imperative-shell), so the methods are typed
 * to the calls made here; `appClient` rides off the base ToolContext.
 *
 * @typedef {Object} ComposerRefCtx
 * @property {{
 *   get: (tabId: number) => Promise<{ id?: number, url?: string } | null | undefined>,
 *   query: (q: { active: boolean, currentWindow: boolean }) => Promise<Array<{ id?: number, url?: string }>>,
 * }} tabs
 * @property {{ id?: number } | null} [activeTab]
 * @property {readonly string[]} [denylist]
 * @property {{ executeScript: (opts: { target: { tabId: number }, func: () => any }) => Promise<Array<{ result?: TabSnapshot }>> }} scripting
 * @property {{ readFile?: (args: { path: string, sessionId?: string }) => Promise<string> }} [appClient]
 * @property {{ sessionId?: string }} [session]
 */

/**
 * @typedef {Object} TabSnapshot
 * @property {string} [title]
 * @property {string} url
 * @property {string} [text]
 */

/** @param {string} url @returns {string} */
const hostnameOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

/**
 * Decide whether a tab may be inlined. Pure: same url + patterns → same
 * verdict. The gate is the SAME denylist the DOM tools' origin gate uses.
 *
 * @param {{ url: string, denylist?: readonly string[] }} args
 * @returns {{ allowed: boolean, origin: string, reason?: string, pattern?: string }}
 */
export const decideTabGate = ({ url, denylist = [] }) => {
  const origin = originOfUrl(url);
  // why: extension-internal and browser pages are never web-untrusted and
  // shouldn't be readable as "page content" either — refuse rather than
  // leak chrome:// internals into the prompt.
  if (/^(chrome|about|devtools|chrome-extension|edge|moz-extension):/.test(url)) {
    return { allowed: false, origin, reason: 'unsupported_scheme' };
  }
  const host = hostnameOf(url);
  const hit = host ? findDenylistMatch(host, denylist) : null;
  if (hit) return { allowed: false, origin, reason: 'denylisted', pattern: hit };
  return { allowed: true, origin };
};

/**
 * Build the inlined payload for an @tab reference from an already-captured
 * snapshot. PURE — no IO. This is the function the tests pin: given a
 * snapshot, it must emit an <untrusted_web_content>-wrapped body carrying
 * title/url/text, attributed to the right origin.
 *
 * @param {Object} args
 * @param {TabSnapshot} args.snapshot
 * @param {string} args.origin
 * @param {string} [args.retrievedAt]
 * @returns {string}
 */
export const buildTabPayload = ({ snapshot, origin, retrievedAt }) => {
  const body = [
    `Title: ${snapshot.title ?? ''}`,
    `URL: ${snapshot.url ?? ''}`,
    '',
    '[TEXT]',
    snapshot.text || '(empty)',
  ].join('\n');
  // why: tool='at_tab' (not 'read_page') so an auditor can tell a
  // user-authored @-mention apart from an agent-initiated read_page in
  // the transcript — same wrapper, distinct provenance.
  return wrapUntrusted({ origin, tool: 'at_tab', body, retrievedAt });
};

/**
 * Build the inlined payload for an @file reference. PURE. App/Notebook
 * files are first-party but we still fence them as reference DATA — a
 * file that itself contains scraped web text shouldn't be able to inject
 * instructions just because the user at-mentioned it.
 *
 * @param {Object} args
 * @param {string} args.path
 * @param {string} args.content
 * @returns {string}
 */
export const buildFilePayload = ({ path, content }) =>
  // Defang the closing fence in the body — a file whose content is scraped web
  // text must not be able to emit a literal </peerd_file> and smuggle the text
  // after it back as un-fenced, model-trusted instructions (the same structural
  // break-out defense wrapUntrusted gives @tab).
  `<peerd_file path="${escAttr(path)}">\n${neutralizeFence(content)}\n</peerd_file>`;

/** @param {unknown} s */
const escAttr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── imperative shell: orchestrate IO around the pure core ────────────────

// The injected function for capturing a tab's text. Self-contained — it
// is serialized by chrome.scripting and re-evaluated in the page world,
// so it can close over NOTHING from this module (same rule as read_page).
function captureTabInjected() {
  'use strict';
  const TEXT_CAP = 4000; // ≈1k tokens — same budget as read_page
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'SVG', 'IFRAME']);
  /** @param {Element} el */
  const isVisible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return !(r.width === 0 && r.height === 0);
  };
  /** @type {string[]} */
  const chunks = [];
  let len = 0;
  /** @param {Node} node */
  const visit = (node) => {
    if (len >= TEXT_CAP) return;
    if (node.nodeType === Node.TEXT_NODE) {
      // why: erased cast — a page text node always carries textContent; the
      // strict-null narrowing would force a guard that can never fire here.
      const t = /** @type {string} */ (node.textContent).replace(/\s+/g, ' ').trim();
      if (t) { chunks.push(t); len += t.length + 1; }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {Element} */ (node);
    if (SKIP.has(el.tagName)) return;
    if (!isVisible(el)) return;
    for (const c of el.childNodes) visit(c);
  };
  // why: erased cast — document.body is present in any injected page; keep
  // the original behavior (a null body would throw) without a guard.
  visit(/** @type {Node} */ (document.body));
  return { title: document.title, url: location.href, text: chunks.join(' ').slice(0, TEXT_CAP) };
}

/**
 * Resolve an @tab reference to its wrapped payload. Orchestrates: resolve
 * target tab → gate on origin/denylist → inject capture → build payload.
 *
 * @param {{ arg: string }} ref       arg is '' (active tab) or a tab id string
 * @param {ComposerRefCtx} ctx        runtime tool context (tabs, scripting, denylist, activeTab)
 * @returns {Promise<{ ok: true, content: string, origin: string }|{ ok: false, error: string }>}
 */
export const resolveTabRef = async (ref, ctx) => {
  // Resolve the target tab. Bare @tab → active tab; @tab:<id> → that tab.
  let tab;
  const wantId = ref.arg ? Number(ref.arg) : null;
  try {
    if (wantId != null && Number.isFinite(wantId)) {
      tab = await ctx.tabs.get(wantId);
    } else if (ctx.activeTab?.id) {
      tab = await ctx.tabs.get(ctx.activeTab.id);
    } else {
      const [t] = await ctx.tabs.query({ active: true, currentWindow: true });
      tab = t;
    }
  } catch { tab = null; }
  if (!tab?.id) return { ok: false, error: 'no_target_tab' };

  const gate = decideTabGate({ url: tab.url || '', denylist: ctx.denylist || [] });
  if (!gate.allowed) {
    return { ok: false, error: `tab_blocked: ${gate.reason}${gate.pattern ? ` (${gate.pattern})` : ''}` };
  }

  let snap;
  try {
    const results = await ctx.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureTabInjected,
    });
    snap = results[0]?.result;
  } catch (e) {
    return { ok: false, error: `capture_failed: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}` };
  }
  if (!snap) return { ok: false, error: 'capture_returned_nothing' };

  // why: re-derive the origin from the URL the page reported, not the tab
  // record — a redirect could have moved it. Re-gate to be safe.
  const finalGate = decideTabGate({ url: snap.url || tab.url || '', denylist: ctx.denylist || [] });
  if (!finalGate.allowed) {
    return { ok: false, error: `tab_blocked: ${finalGate.reason}` };
  }
  return {
    ok: true,
    origin: finalGate.origin,
    content: buildTabPayload({ snapshot: snap, origin: finalGate.origin }),
  };
};

/**
 * Resolve an @file reference to its wrapped payload. Reads from the App
 * file store via the injected appClient (same surface app_read_file uses).
 *
 * @param {{ arg: string }} ref       arg is the file path
 * @param {ComposerRefCtx} ctx
 * @returns {Promise<{ ok: true, content: string }|{ ok: false, error: string }>}
 */
export const resolveFileRef = async (ref, ctx) => {
  const path = ref.arg;
  if (!path) return { ok: false, error: 'path_required' };
  if (!ctx.appClient?.readFile) return { ok: false, error: 'file_store_unavailable' };
  try {
    const content = await ctx.appClient.readFile({ path, sessionId: ctx.session?.sessionId });
    return { ok: true, content: buildFilePayload({ path, content }) };
  } catch (e) {
    return { ok: false, error: `file_read_failed: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}` };
  }
};

/**
 * Resolve every reference in a parsed composer and splice the inlined
 * payloads into the message. References are replaced back-to-front so the
 * earlier tokens' offsets stay valid. A reference that fails to resolve is
 * left as its raw text plus an inline note — the turn still proceeds.
 *
 * @param {import('./parse.js').RefToken[]} refs
 * @param {string} text     the original composer text
 * @param {ComposerRefCtx} ctx      runtime tool context
 * @returns {Promise<{ text: string, resolved: Array<{ raw: string, ok: boolean, error?: string }> }>}
 */
export const resolveAllRefs = async (refs, text, ctx) => {
  /** @type {Array<{ raw: string, ok: boolean, error?: string }>} */
  const resolved = [];
  // Resolve first (in source order, so audit reads naturally)...
  /** @type {Array<{ ok: true, content: string } | { ok: false, error: string }>} */
  const payloads = [];
  for (const ref of refs) {
    const r = ref.kind === 'tab'
      ? await resolveTabRef(ref, ctx)
      : await resolveFileRef(ref, ctx);
    payloads.push(r);
    resolved.push({ raw: ref.raw, ok: r.ok, error: r.ok ? undefined : r.error });
  }
  // ...then splice back-to-front to keep offsets stable.
  let out = text;
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i];
    const r = payloads[i];
    const replacement = r.ok
      ? `\n${r.content}\n`
      : `${ref.raw} (could not resolve: ${r.error})`;
    out = out.slice(0, ref.start) + replacement + out.slice(ref.end);
  }
  return { text: out, resolved };
};
