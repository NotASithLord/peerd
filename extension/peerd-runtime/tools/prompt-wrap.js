// @ts-check
// Untrusted-content wrapping (per DESIGN.md §4.3).
//
// Web tool output (read_page, screenshot, anything that pulls text from
// a page the user/agent navigated to) gets wrapped in a structured tag
// before being handed back to the model. The agent's system prompt
// teaches it to treat text inside these tags as DATA, not as COMMANDS —
// raising the bar against prompt injection sourced from page content.
//
// This is one part of a defense-in-depth chain:
//   - Egress allowlist (safeFetch)   — locks the CREDENTIALED provider path
//                                      (open-web webFetch is allowlist-free)
//   - SSRF / private-network block   — no LAN / loopback / metadata targets
//   - Denylist                       — won't touch banking/health/etc.
//   - Plan/Act + denylist            — scope-limits what the agent may act on
//   - Untrusted wrap (this file)     — clear data/instruction boundary
//   - User confirmation gate         — explicit ack on side-effects
//
// The wrap happens at the tool boundary — read_page calls this in its
// execute(), not in the agent loop — so it's impossible to forget when
// adding a new web-sourced tool.

import { escapeAttr } from '/shared/util.js';
import { disarmText } from '../dom/cdr.js';

// All fence tag names this module manages. Any occurrence of one of these
// (open OR close, tolerant of internal whitespace and case) inside an
// untrusted body is defanged before interpolation — otherwise hostile
// content containing a literal `</untrusted_web_content>` would terminate
// the fence and smuggle the text after it back as un-fenced "instructions".
// This is a STRUCTURAL break-out defense (attacker bytes can't forge the
// delimiter), distinct from the soft "treat the inside as data" rule the
// system prompt teaches the model.
// peerd_file is the @-mention file fence: an inlined
// App/Notebook file is reference DATA, and its body may itself be scraped web
// text, so it gets the same structural break-out defense.
const FENCE_TAGS = ['untrusted_web_content', 'peerd_file'];
const FENCE_RE = new RegExp(`<(\\s*/?\\s*)(${FENCE_TAGS.join('|')})\\b`, 'gi');

/**
 * Defang this module's own fence delimiters inside an untrusted body.
 * Encodes only the leading `<` of a recognized tag token (open or close),
 * turning `</untrusted_web_content>` into `&lt;/untrusted_web_content>` — no
 * longer a parseable closing tag — while leaving every OTHER `<` in the
 * body (legitimate code, markup the user wants to read) untouched. Returns
 * '' for a non-string so callers can pass a possibly-undefined body.
 *
 * @param {unknown} body
 * @returns {string}
 */
export const neutralizeFence = (body) =>
  typeof body === 'string' ? body.replace(FENCE_RE, '&lt;$1$2') : '';

/**
 * Wrap a text body in the canonical untrusted-content tag.
 *
 * The body is DISARMED before it is fenced (dom/cdr.js): bytes that are
 * invisible to the human who approved the read but fully visible to the model
 * — zero-width joiners spelling a hidden instruction, bidi overrides that
 * reorder what the text says, Unicode tag-block characters smuggling plain
 * ASCII, control bytes — are stripped here.
 *
 * why HERE and not at each producer: this function is already the one place
 * every untrusted body must pass through, and the header above states that as
 * the design property ("impossible to forget when adding a new web-sourced
 * tool"). Hanging CDR off the same chokepoint inherits that guarantee instead
 * of starting a second list of callsites to keep in sync. The two passes are
 * siblings with one job each and no overlap: disarmText removes bytes that
 * render as NOTHING, neutralizeFence defangs the delimiter an attacker would
 * use to break OUT of the fence.
 *
 * Deliberately the UNIVERSAL sweep only. The markup-specific pass (HTML
 * comments) is destructive on source code and diffs, which are also fenced
 * here, so it stays opt-in at the markup producers via disarmMarkup.
 *
 * @param {Object} args
 * @param {string} args.origin
 * @param {string} args.tool
 * @param {string} args.body
 * @param {string} [args.retrievedAt]   ISO timestamp; default now
 * @returns {string}
 */
export const wrapUntrusted = ({ origin, tool, body, retrievedAt }) => {
  const ts = retrievedAt ?? new Date().toISOString();
  return (
    `<untrusted_web_content origin="${escapeAttr(disarmText(origin))}" ` +
    `tool="${escapeAttr(tool)}" retrieved_at="${ts}">\n${neutralizeFence(disarmText(body))}\n` +
    `</untrusted_web_content>`
  );
};

/**
 * Harden a page-controlled label (a tab's document.title) for a TRUSTED tool
 * result - one that is NOT fenced, and so has no envelope telling the model to
 * treat it as data.
 *
 * why it lives here rather than beside one caller: two tool surfaces hand the
 * orchestrator page-authored titles (actor_list's `name`, inspect's
 * session_access `title`), and they had drifted - one hardened, one raw
 * `truncate` - which is exactly how the un-hardened one becomes the way in. One
 * definition next to the other untrusted-text primitives keeps them from
 * drifting again.
 *
 * The order matters: collapse whitespace (kills the newline vector), disarm
 * (strips the invisible-Unicode and bidi bytes escaping leaves intact), truncate,
 * and only then escape - escaping last means the cut can never split an entity
 * in half.
 *
 * @param {string | undefined | null} title
 * @param {number} [max]
 * @returns {string}
 */
export const safeTitle = (title, max = 60) => {
  const collapsed = disarmText(String(title ?? '').replace(/\s+/g, ' ').trim());
  const cut = collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
  return escapeAttr(cut);
};
