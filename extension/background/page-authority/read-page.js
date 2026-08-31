// @ts-check

// read_page: read the DOM of the target tab.
//
// Returns a structured snapshot wrapped in <untrusted_web_content>:
//   - title, url
//   - visible text (computed-style-filtered, capped at ~8KB so a
//     giant page doesn't blow the context window)
//   - interactables: inputs, buttons, links: each with a CSS selector
//     the agent can pass back to click/type
//
// The injected function runs in the page's JS world. It cannot close
// over any module-scope variable from this file: chrome.scripting
// serializes the function body and runs it from scratch.

import {
  disarmMarkup,
  excerptFooter,
  excerptRelevant,
  originOfUrl,
  pagingFooter,
  resolveTargetTab,
  scriptingTarget,
  windowText,
  wrapUntrusted,
} from '/peerd-runtime/browser-authority.js';

// Content mode shares fetch_url's body budget: one read costs like one fetch.
const CONTENT_BODY_CHARS = 16_000;

/** @type {Readonly<{execute:(args:any,ctx:any)=>Promise<any>}>} */
export const readPageTool = Object.freeze({

  execute: async (args, ctx) => {
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };

    // why: ToolContext types `scripting` as the opaque chrome.scripting slot;
    // narrow it to the typed API surface for the executeScript call.
    const scripting = /** @type {typeof chrome.scripting} */ (ctx.scripting);

    // mode:'content': the RENDERED page's readable core as markdown. Grabs the
    // live DOM's outerHTML (post-JS, unlike fetch_url which sees served bytes)
    // and routes it through the SAME offscreen Readability+Turndown extractor
    // and the SAME spill-and-page machinery fetch_url uses. FAIL-OPEN: a
    // non-readerable page, a missing extractor (Firefox), or an extraction
    // error all fall through to the default snapshot below: content mode is
    // an optimization, never a gate on reading the page.
    if (args?.mode === 'content') {
      const webClient = /** @type {{ extractMarkdown?: (s: { html: string, url?: string }) => Promise<{ readerable: boolean, markdown?: string, title?: string | null }> } | undefined} */ (
        /** @type {any} */ (ctx).webOffscreenClient);
      if (webClient?.extractMarkdown) {
        try {
          const grabbed = (await scripting.executeScript({ target: scriptingTarget(tab), func: readOuterHtmlInjected }))[0]?.result;
          if (grabbed?.html) {
            // CDR (dom/cdr.js) on the way in AND on the way out. In: the grabbed
            // DOM is page markup, so the MARKUP sweep (comments too) applies.
            // Out: extraction PARSES that markup, decoding `&#8203;`: plain
            // ASCII the first sweep correctly left alone, into a literal
            // zero-width byte, so the second pass is what closes the entity
            // channel. Both run BEFORE any windowing or caching below, because
            // the paging footer reports character offsets into this string and
            // resultStore keeps it for read_result to page back later.
            const ex = await webClient.extractMarkdown({ html: disarmMarkup(grabbed.html), url: grabbed.url || tab.url });
            const markdown = disarmMarkup(ex.markdown);
            if (ex.readerable && markdown.trim()) {
              const origin = originOfUrl(grabbed.url || tab.url);
              const resultStore = /** @type {{ key?: () => string, put?: (r: object) => Promise<void> } | undefined} */ (
                /** @type {any} */ (ctx).resultStore);
              // Query-relevant excerpt when the caller named what it's after
              // (markdown is always prose here); else the head+tail window. Same
              // spill contract: full markdown stored + pageable either way.
              const query = typeof args.query === 'string' ? args.query.trim() : '';
              const excerpt = query ? excerptRelevant(markdown, query, CONTENT_BODY_CHARS) : null;
              const win = windowText(markdown, CONTENT_BODY_CHARS);
              let text = excerpt ? excerpt.excerpt : win.window;
              const truncated = excerpt ? excerpt.excerpted : win.windowed;
              /** @type {string | null} */
              let footer = null;
              if (truncated && resultStore?.key && resultStore?.put) {
                const cacheKey = resultStore.key();
                try {
                  await resultStore.put({
                    key: cacheKey, url: grabbed.url || tab.url, format: 'markdown', text: markdown,
                    ownerSessionId: ctx.session?.sessionId ?? null,
                    producer: 'read_page', fenced: true, originLabel: origin,
                  });
                  footer = excerpt
                    ? excerptFooter({ key: cacheKey, total: excerpt.total, passagesShown: excerpt.passagesShown, passagesTotal: excerpt.passagesTotal, query })
                    : pagingFooter({ key: cacheKey, total: win.total, headChars: win.headChars, tailChars: win.tailChars });
                } catch { /* spill failed: the window/excerpt (with its elision markers) still ships */ }
              } else if (truncated && !resultStore) {
                text = markdown.slice(0, CONTENT_BODY_CHARS);
              }
              const fenced = wrapUntrusted({
                origin, tool: 'read_page',
                body: JSON.stringify({
                  mode: 'content', url: grabbed.url || tab.url,
                  ...(ex.title ? { title: ex.title } : {}),
                  format: 'markdown', truncated, body: text,
                  // the RAW DOM was clipped at 2MB before extraction: the
                  // readable core may be missing its tail (distinct from
                  // `truncated`, which only means the markdown was windowed).
                  ...(grabbed.htmlTruncated ? { htmlTruncated: true } : {}),
                }, null, 2),
              });
              return { ok: true, content: footer ? `${fenced}\n${footer}` : fenced };
            }
          }
        } catch { /* fail-open to the snapshot below */ }
      }
    }

    let scriptResult;
    try {
      const results = await scripting.executeScript({
        target: scriptingTarget(tab),
        func: readPageInjected,
      });
      scriptResult = results[0]?.result;
    } catch (e) {
      return { ok: false, error: `script_inject_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    if (!scriptResult) return { ok: false, error: 'script_returned_nothing' };

    const origin = originOfUrl(scriptResult.url || tab.url);
    const body = formatPageBody(scriptResult);
    return {
      ok: true,
      content: wrapUntrusted({ origin, tool: 'read_page', body }),
    };
  },
});

/**
 * @typedef {Object} PageInteractable
 * @property {string} kind
 * @property {string} selector
 * @property {string} [label]
 * @property {string} [placeholder]
 * @property {string} [value]
 * @property {string} [href]
 */

/**
 * @typedef {Object} PageSnapshot
 * @property {string} title
 * @property {string} url
 * @property {string} text
 * @property {PageInteractable[]} interactables
 */

// Stringify the snapshot for the model. Plain text with a few section
// headers so the model can navigate it without parsing JSON.
/** @param {PageSnapshot} snap */
const formatPageBody = (snap) => {
  const lines = [
    `Title: ${snap.title}`,
    `URL: ${snap.url}`,
    '',
    '[TEXT]',
    snap.text || '(empty)',
    '',
    '[INTERACTABLES]',
  ];
  if (!snap.interactables || snap.interactables.length === 0) {
    lines.push('(none detected)');
  } else {
    for (const el of snap.interactables) {
      const parts = [el.kind];
      if (el.label) parts.push(`label="${el.label}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.value) parts.push(`value="${el.value}"`);
      if (el.href) parts.push(`href="${el.href}"`);
      parts.push(`selector=${el.selector}`);
      lines.push(`- ${parts.join(' ')}`);
    }
  }
  return lines.join('\n');
};

// ───────────────────────────────────────────────────────────────────────
// Injected functions: run in the page world. Self-contained.
// ───────────────────────────────────────────────────────────────────────
// content mode's grabber: the rendered DOM, serialized. Capped so a pathological
// page doesn't blow the executeScript result channel (the offscreen extractor
// caps again).
function readOuterHtmlInjected() {
  // why: serialized by chrome.scripting.executeScript and re-evaluated in the
  // page's classic-script world; the calling module's strict mode doesn't
  // carry across. Opt in here (same note as readPageInjected below).
  'use strict';
  const MAX = 2_000_000;
  const raw = document.documentElement ? document.documentElement.outerHTML : '';
  const clipped = raw.length > MAX;
  return {
    html: clipped ? raw.slice(0, MAX) : raw,
    // why: flag the clip so the caller never reports a complete read when the
    // raw DOM's tail was dropped here: before the extractor ever saw it, so no
    // downstream truncation signal would otherwise fire.
    htmlTruncated: clipped,
    url: location.href,
    title: document.title || '',
  };
}

function readPageInjected() {
  // why: serialized by chrome.scripting.executeScript and re-evaluated
  // in the page's classic-script world; the calling module's strict
  // mode doesn't carry across. Opt in here.
  'use strict';
  const TEXT_CAP = 4000;          // ≈1k tokens: keeps rate-limit pressure down
  const INTERACTABLE_CAP = 100;   // selectors are more useful per byte than raw text
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'SVG', 'IFRAME',
  ]);
  const isVisible = (/** @type {Element} */ el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  };
  const cssEscape = (/** @type {string} */ s) => (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(s)
    : String(s).replace(/(["\\\[\]\.#\(\)\s])/g, '\\$1');
  const selectorFor = (/** @type {Element} */ el) => {
    if (el.id) return `#${cssEscape(el.id)}`;
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${cssEscape(testId)}"]`;
    const name = el.getAttribute('name');
    if (name) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
    const aria = el.getAttribute('aria-label');
    if (aria) return `[aria-label="${cssEscape(aria)}"]`;
    // Fall back: tag + nth-of-type within parent.
    let nth = 1;
    /** @type {Element | null} */
    let sib = el;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === el.tagName) nth += 1;
    }
    return `${el.tagName.toLowerCase()}:nth-of-type(${nth})`;
  };
  const labelOf = (/** @type {Element} */ el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    if (el.id) {
      const lbl = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      // why: erased cast: textContent is string|null; .trim() on null throws
      // at runtime exactly as before, the cast only quiets the static check.
      if (lbl) return /** @type {string} */ (lbl.textContent).trim();
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    return '';
  };
  const textOf = (/** @type {Element} */ el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);

  /** @type {string[]} */
  const textChunks = [];
  let textLen = 0;
  /** @type {PageInteractable[]} */
  const interactables = [];

  const visit = (/** @type {Node} */ node) => {
    if (textLen >= TEXT_CAP && interactables.length >= INTERACTABLE_CAP) return;
    if (node.nodeType === Node.COMMENT_NODE) return;
    if (node.nodeType === Node.TEXT_NODE) {
      // why: erased cast: a TEXT_NODE always has string textContent; the
      // nodeType guard above guarantees it, but TS types Node.textContent as
      // string|null.
      const t = /** @type {string} */ (node.textContent).replace(/\s+/g, ' ').trim();
      if (t && textLen < TEXT_CAP) {
        textChunks.push(t);
        textLen += t.length + 1;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {HTMLElement} */ (node);
    if (SKIP_TAGS.has(el.tagName)) return;
    if (!isVisible(el)) return;

    const tag = el.tagName.toLowerCase();
    if (interactables.length < INTERACTABLE_CAP) {
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        interactables.push({
          kind: tag,
          selector: selectorFor(el),
          label: labelOf(el),
          placeholder: el.getAttribute('placeholder') || '',
          // why: erased cast: the tag check above already constrained el to a
          // value-bearing form control; HTMLElement has no `value`.
          value: /** @type {HTMLInputElement} */ (el).value || '',
        });
      } else if (tag === 'button' || el.getAttribute('role') === 'button') {
        interactables.push({
          kind: 'button',
          selector: selectorFor(el),
          label: textOf(el) || labelOf(el),
        });
      } else if (tag === 'a' && el.getAttribute('href')) {
        interactables.push({
          kind: 'link',
          selector: selectorFor(el),
          label: textOf(el),
          href: el.getAttribute('href') || '',
        });
      }
    }

    for (const c of el.childNodes) visit(c);
  };

  visit(document.body);

  return {
    title: document.title,
    url: location.href,
    text: textChunks.join(' ').slice(0, TEXT_CAP),
    interactables,
  };
}
