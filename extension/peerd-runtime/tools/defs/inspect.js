// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// inspect — the single introspection tool (kind-discriminated).
//
// why one tool, not five: `inspect_provider_config / _storage / _session_access
// / _denylist / _audit_log` were five separate tools that all share
// primitive:'inspect', sideEffect:'read', origins:[] and differ only in which
// facet they read. Five near-identical entries bloat the main agent's surface
// and its tool-selection prompt for no gain. Collapsed into one `inspect({ kind })`
// exactly the way `actor_list` collapsed vm_list/js_list/app_list/list_tabs/
// list_integrations into one result keyed by `type`. The facet handlers below are
// unchanged in behavior — each still proves its §02 "sovereignty" property.

import { serializeListResult } from './columnar.js';
import { executeByKind } from './kind-dispatch.js';
import { isDenylistedTab, originOfUrl } from '../../browser-authority/dom-helpers.js';
import { wrapUntrusted, safeTitle } from '../prompt-wrap.js';
import { classifyBrowserAutomationTarget } from '../browser-automation-policy.js';
import { clamp } from '/shared/util.js';
// why the DEEP path (not the /peerd-egress/index.js barrel): the barrel pulls
// the vault/storage surface, which loads browser-polyfill and throws under Bun.
// The denylist matcher is pure — import it directly, exactly as dom-helpers.js /
// gates.js do — so this tool stays loadable in the Bun suite.
import { findDenylistMatch } from '../../../peerd-egress/denylist/denylist.js';

/** @typedef {import('/peerd-egress/audit/types.js').AuditEntry} AuditEntry */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */

// ── provider_config — proves BYOK without leaking the key ──────────────────
/** @param {any} _args @param {ToolContext} ctx @returns {ToolResult} */
const inspectProviderConfig = (_args, ctx) => {
  const provider = ctx.provider ?? { name: 'unknown', model: 'unknown', hasKey: false };
  const vault = ctx.vault ?? { isLocked: true };
  return {
    ok: true,
    content: JSON.stringify({
      provider: provider.name,
      model: provider.model,
      hasKey: provider.hasKey,
      vaultLocked: vault.isLocked,
      contract: [
        'The API key is encrypted in the vault under a passphrase-derived',
        'KEK (PBKDF2-SHA256 600k iter → AES-KW). It is decrypted into SW',
        'memory only when a request is about to fire; the plaintext never',
        'lands in chrome.storage and never leaves the service worker.',
        'This tool intentionally cannot retrieve the key value — it would',
        'be a bug in the contract if it could.',
      ].join(' '),
    }, null, 2),
  };
};

// ── storage — proves encryption-at-rest ────────────────────────────────────
/** @param {any} v @returns {unknown} */
const truncateForDisplay = (v) => {
  if (typeof v === 'string' && v.length > 80) {
    return `${v.slice(0, 32)}…${v.slice(-16)} (${v.length} chars, base64)`;
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, vv] of Object.entries(v)) out[k] = truncateForDisplay(vv);
    return out;
  }
  return v;
};

/** @param {any} args @param {ToolContext} ctx @returns {Promise<ToolResult>} */
const inspectStorage = async (args, ctx) => {
  // why: ctx.kv is typed as the opaque `Object` contract slot; narrow it to the
  // one method this tool exercises (the egress KV `list`).
  const kv = /** @type {{ list: (prefix?: string) => Promise<Record<string, unknown>> }} */ (ctx.kv);
  const all = await kv.list(args?.prefix);
  /** @type {Record<string, unknown>} */
  const display = {};
  for (const [k, v] of Object.entries(all)) display[k] = truncateForDisplay(v);
  return { ok: true, content: JSON.stringify(display, null, 2) };
};

// ── session_access — proves "your sessions are already there" ──────────────
/**
 * @typedef {Object} BrowserTab
 * @property {number} [id]
 * @property {string} [url]
 * @property {string} [title]
 * @property {boolean} [active]
 */

/** @param {string | undefined} s @param {number} n @returns {string} */
const truncate = (s, n) => {
  if (!s) return '';
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
};
/** @param {any} _args @param {ToolContext} ctx @returns {Promise<ToolResult>} */
const inspectSessionAccess = async (_args, ctx) => {
  /** @type {Array<Record<string, unknown>>} */
  let tabs = [];
  try {
    // why: ctx.tabs is the opaque `Object` contract slot; narrow it to the
    // one method this tool uses (browser.tabs.query).
    const tabsApi = /** @type {{ query: (q: Record<string, unknown>) => Promise<BrowserTab[]> }} */ (ctx.tabs);
    const raw = await tabsApi.query({});
    tabs = raw.flatMap((t) => {
      const target = classifyBrowserAutomationTarget(t.url);
      if (!target.allowed || isDenylistedTab(t.url, ctx.denylist)) return [];
      return [{
        id: t.id,
        // originOfUrl (dom-helpers) so the internal-page rendering (chrome://,
        // about:) agrees with actor_list + the origin gates for the same tab.
        origin: originOfUrl(t.url),
        // The page CHOSE this string. This result is trusted and unfenced, so it
        // gets the same hardening actor_list gives the same field - a bare
        // truncate left newlines, angle brackets and invisible-Unicode intact.
        title: safeTitle(t.title),
        active: t.active,
        url: originOfUrl(t.url),
      }];
    });
  } catch (e) {
    return { ok: false, error: `tabs query failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  }
  return {
    ok: true,
    content: serializeListResult({
      accessibleTabs: tabs.length,
      scopeRule: 'Private-network, cloud-metadata, and denylisted tabs are outside browser automation scope.',
      tabs,
    }, 'tabs'),
  };
};

// ── denylist — proves the egress policy floor ──────────────────────────────
/** @param {any} args @param {ToolContext} ctx @returns {ToolResult} */
const inspectDenylist = (args, ctx) => {
  const patterns = ctx.denylist ?? [];
  if (args?.domain) {
    const match = findDenylistMatch(String(args.domain).toLowerCase(), patterns);
    return {
      ok: true,
      content: JSON.stringify({
        domain: args.domain,
        matched: match !== null,
        matchedPattern: match,
        totalPatterns: patterns.length,
        interpretation: match
          ? `'${args.domain}' is on the denylist via pattern '${match}'. peerd will refuse any tool call that touches this origin.`
          : `'${args.domain}' is NOT on the denylist. Other browser, network, and origin-scope policies still apply.`,
      }, null, 2),
    };
  }
  return {
    ok: true,
    content: JSON.stringify({
      totalPatterns: patterns.length,
      examples: patterns.slice(0, 12),
      note: 'Pass domain="..." to check a specific hostname against the full list.',
    }, null, 2),
  };
};

// ── audit_log — proves the audit trail is real ─────────────────────────────
// why redact: an actor (depth>0) can run tools whose FAILURE messages echo
// UNTRUSTED text (a DOM tool's `no_option_matching: "<page label>"`). inspect is
// on the MAIN agent's surface, so returning those verbatim would let the main
// agent re-ingest untrusted text through its own audit trail — laundering around
// the child-context boundary. Redact the error body on actor records; the
// metadata (tool, depth, parentage) stays.
/** @param {AuditEntry} e @returns {AuditEntry} */
const redactActorError = (e) => {
  if (e?.details?.actorSessionId && typeof e.details.error === 'string') {
    return { ...e, details: { ...e.details, error: '<actor tool error redacted — see the child card in the side panel>' } };
  }
  return e;
};

/** @param {any} args @param {ToolContext} ctx @returns {Promise<ToolResult>} */
const inspectAuditLog = async (args, ctx) => {
  const limit = clamp(args?.limit ?? 50, 1, 500);
  /** @type {Set<string> | null} */
  const types = Array.isArray(args?.types) && args.types.length > 0 ? new Set(args.types) : null;
  // why: ctx.idb is the opaque `Object` contract slot; narrow it to the getAll
  // seam this tool uses.
  const idb = /** @type {{ getAll: (store: string) => Promise<AuditEntry[]> }} */ (ctx.idb);
  const all = await idb.getAll('audit_log');
  const filtered = types ? all.filter((e) => types.has(e.type)) : all;
  const sorted = filtered.sort((a, b) => b.when - a.when).slice(0, limit);
  // FENCE the entries. redactActorError above closes ONE laundering path (an
  // actor's echoed error text); it is not the only one. Every successful fetch is
  // audited with its full path (peerd-egress/fetch/web-fetch.js), and that path is
  // chosen by whoever the actor was talking to — so a prompt-injected actor can
  // write arbitrary prose into the log by requesting it as a URL, and this facet
  // hands it to the MAIN agent verbatim. Fencing is the same answer the rest of
  // the codebase gives for bytes it did not author: wrapUntrusted marks it as data
  // and runs it through disarmText, which also strips the invisible-Unicode and
  // bidi vectors that plain JSON escaping leaves intact.
  //
  // The counts stay OUTSIDE the fence: they are peerd's own, and a reader (human
  // or model) should be able to trust "how many entries exist" without weighing it
  // as untrusted input.
  const counts = JSON.stringify({ returned: sorted.length, totalInStore: all.length }, null, 2);
  const entries = JSON.stringify(sorted.map(redactActorError), null, 2);
  return {
    ok: true,
    content: `${counts}\n${wrapUntrusted({
      origin: 'audit_log',
      tool: 'inspect',
      body: entries,
    })}`,
  };
};

// kind → handler. Exported so callers/tests can enumerate the facets.
export const INSPECT_HANDLERS = Object.freeze({
  provider_config: inspectProviderConfig,
  storage: inspectStorage,
  session_access: inspectSessionAccess,
  denylist: inspectDenylist,
  audit_log: inspectAuditLog,
});

/** @type {import('/shared/tool-types.js').Tool} */
export const inspectTool = composeTool("inspect", {
  execute: executeByKind('inspect', /** @type {any} */ (INSPECT_HANDLERS)),
});
