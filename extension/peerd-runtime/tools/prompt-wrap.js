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

// All fence tag names this module manages. Any occurrence of one of these
// (open OR close, tolerant of internal whitespace and case) inside an
// untrusted body is defanged before interpolation — otherwise hostile
// content containing a literal `</untrusted_web_content>` would terminate
// the fence and smuggle the text after it back as un-fenced "instructions".
// This is a STRUCTURAL break-out defense (attacker bytes can't forge the
// delimiter), distinct from the soft "treat the inside as data" rule the
// system prompt teaches the model.
const FENCE_TAGS = ['untrusted_web_content', 'untrusted_runner_summary'];
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
const neutralizeFence = (body) =>
  typeof body === 'string' ? body.replace(FENCE_RE, '&lt;$1$2') : '';

/**
 * Wrap a text body in the canonical untrusted-content tag.
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
    `<untrusted_web_content origin="${escapeAttr(origin)}" ` +
    `tool="${escapeAttr(tool)}" retrieved_at="${ts}">\n${neutralizeFence(body)}\n` +
    `</untrusted_web_content>`
  );
};

/**
 * Wrap a browser-runner's output (a do/get/check summary / value / rationale)
 * before it crosses BACK into the MAIN agent's privileged context.
 *
 * why: the runner operates on untrusted pages. A prompt-injected page can steer
 * what the runner reports, so its summary is itself untrusted — it must not be
 * read by the main agent as instructions. Same discipline as
 * <untrusted_web_content>, with the tab + goal as context. The main agent USES
 * the information to decide its next step but treats any embedded instruction as
 * page-originated data, never a command.
 *
 * @param {Object} args
 * @param {string} [args.tabUrl]   the tab the runner drove
 * @param {string} [args.goal]     the instruction/query/assertion given to the runner
 * @param {string} args.body       the runner's output text
 * @param {string} [args.retrievedAt]
 * @returns {string}
 */
export const wrapUntrustedRunner = ({ tabUrl, goal, body, retrievedAt }) => {
  const ts = retrievedAt ?? new Date().toISOString();
  return (
    `<untrusted_runner_summary tab="${escapeAttr(tabUrl ?? '')}" ` +
    `goal="${escapeAttr((goal ?? '').slice(0, 160))}" retrieved_at="${ts}">\n${neutralizeFence(body)}\n` +
    `</untrusted_runner_summary>`
  );
};
