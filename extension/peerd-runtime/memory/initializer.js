// @ts-check
// /init — workspace scanner + initial AGENTS.md drafter.
//
// The browser-native twist on Claude Code's /init: a peerd "workspace"
// is NOT just a file tree. It is a browsing context. So the scanner
// composes THREE probes, any of which may be absent:
//
//   1. @tab   — the live page the user is in: URL, title, headings,
//               a snippet of visible text (read via the user's logged-in
//               session — a superpower a CLI agent does not have).
//   2. WebVM  — the sandboxed Linux FS: top-level entries, package
//               manifests, README — the closest thing to a classic repo.
//   3. apps   — peerd Apps the user has built in this workspace.
//
// drafting is PURE: probes in → markdown out. The SW does the IO
// (reading the tab, listing the VM FS) and feeds the results here. The
// resulting draft is a WRITE PROPOSAL surfaced for user confirmation
// before it is persisted — /init never silently writes memory.

import { normalizeWorkspace } from './memory.js';

/**
 * @typedef {Object} ProbePackageJson  parsed package.json (validated JSON; fields optional)
 * @property {string} [name]
 * @property {string} [version]
 * @property {string} [description]
 * @property {Record<string, string>} [scripts]
 */

/**
 * @typedef {Object} ProbeApp  one peerd App in the workspace
 * @property {string} id
 * @property {string} [name]
 * @property {string} [description]
 */

/**
 * @typedef {Object} WorkspaceProbe
 * @property {string} [workspace]   resolved workspace key
 * @property {Object} [tab]         live-tab context
 * @property {string} [tab.url]
 * @property {string} [tab.title]
 * @property {string[]} [tab.headings]
 * @property {string} [tab.textSnippet]
 * @property {Object} [vm]          WebVM filesystem context
 * @property {string} [vm.id]             VM instance id (workspace-key fallback: `vm:<id>`)
 * @property {string[]} [vm.entries]      top-level dir listing
 * @property {string} [vm.readme]         README contents (truncated)
 * @property {ProbePackageJson} [vm.packageJson]    parsed package.json, if any
 * @property {ProbeApp[]} [apps]      peerd Apps in the workspace
 */

const MAX_README_CHARS = 1200;
const MAX_SNIPPET_CHARS = 600;
const MAX_HEADINGS = 12;
const MAX_ENTRIES = 40;

/**
 * Pick the workspace key for an /init run. Explicit wins; else the tab
 * origin; else a VM id; else a generic label. Pure.
 *
 * @param {WorkspaceProbe} probe
 * @returns {string}
 */
export const resolveWorkspaceKey = (probe) => {
  if (probe?.workspace) return normalizeWorkspace(probe.workspace);
  if (probe?.tab?.url) {
    const ws = normalizeWorkspace(probe.tab.url);
    if (ws) return ws;
  }
  if (probe?.vm?.id) return `vm:${probe.vm.id}`;
  return 'workspace';
};

/**
 * Draft an initial AGENTS.md from a workspace probe. Pure: deterministic
 * for a given probe. The draft is intentionally a SKELETON the user (and
 * the agent, in later turns) refines — it captures what was observed and
 * leaves labelled TODO slots, rather than hallucinating facts.
 *
 * @param {WorkspaceProbe} probe
 * @param {Object} [opts]
 * @param {string} [opts.nowIso]
 * @returns {{ workspace: string, body: string, sources: string[], checklist: string[] }}
 */
export const draftAgentsMd = (probe = {}, { nowIso } = {}) => {
  const workspace = resolveWorkspaceKey(probe);
  const ts = nowIso ?? new Date().toISOString();
  const sources = [];
  const lines = [];

  lines.push(`# AGENTS.md — ${workspace}`);
  lines.push('');
  lines.push('> Persistent project memory for peerd. Auto-drafted by /init;');
  lines.push('> edit freely. Loaded into the system prompt at session start.');
  lines.push('');

  // ── Overview, sourced from whichever probe is richest ────────────────
  lines.push('## Overview');
  const overview = [];
  if (probe.tab?.title) { overview.push(`- Live context: **${clip(probe.tab.title, 120)}**`); }
  if (probe.tab?.url) { overview.push(`- URL: ${probe.tab.url}`); sources.push('tab'); }
  if (probe.vm?.packageJson?.name) {
    const versionSuffix = probe.vm.packageJson.version ? ` v${probe.vm.packageJson.version}` : '';
    overview.push(`- Package: **${probe.vm.packageJson.name}**${versionSuffix}`);
    sources.push('vm:package.json');
  }
  if (probe.vm?.packageJson?.description) overview.push(`- ${clip(probe.vm.packageJson.description, 160)}`);
  if (overview.length === 0) overview.push('- TODO: one-line description of this workspace.');
  lines.push(...overview);
  lines.push('');

  // ── Live page snapshot (@tab) — the browser-native superpower ────────
  if (probe.tab && (probe.tab.headings?.length || probe.tab.textSnippet)) {
    lines.push('## Live page snapshot');
    if (probe.tab.headings?.length) {
      lines.push('Headings observed:');
      for (const h of probe.tab.headings.slice(0, MAX_HEADINGS)) lines.push(`- ${clip(h, 100)}`);
    }
    if (probe.tab.textSnippet) {
      lines.push('');
      lines.push('Excerpt:');
      lines.push(`> ${clip(collapseWs(probe.tab.textSnippet), MAX_SNIPPET_CHARS).replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }

  // ── Filesystem (WebVM) ───────────────────────────────────────────────
  if (probe.vm?.entries?.length) {
    sources.push('vm:fs');
    lines.push('## Filesystem (WebVM)');
    for (const e of probe.vm.entries.slice(0, MAX_ENTRIES)) lines.push(`- ${e}`);
    if (probe.vm.entries.length > MAX_ENTRIES) lines.push(`- …(+${probe.vm.entries.length - MAX_ENTRIES} more)`);
    lines.push('');
  }
  if (probe.vm?.readme) {
    sources.push('vm:README');
    lines.push('## README (excerpt)');
    lines.push(clip(probe.vm.readme, MAX_README_CHARS));
    lines.push('');
  }
  if (probe.vm?.packageJson?.scripts && Object.keys(probe.vm.packageJson.scripts).length) {
    lines.push('## Scripts');
    for (const [k, v] of Object.entries(probe.vm.packageJson.scripts)) lines.push(`- \`${k}\`: ${clip(String(v), 100)}`);
    lines.push('');
  }

  // ── Apps in the workspace ────────────────────────────────────────────
  if (probe.apps?.length) {
    sources.push('apps');
    lines.push('## peerd Apps');
    for (const a of probe.apps) lines.push(`- ${a.name ?? a.id}${a.description ? ` — ${clip(a.description, 100)}` : ''}`);
    lines.push('');
  }

  // ── Conventions slot — left for the user/agent to fill ───────────────
  lines.push('## Conventions');
  lines.push('- TODO: coding style, commands, gotchas the agent should remember.');
  lines.push('');
  lines.push(`<!-- drafted by /init at ${ts} from: ${sources.join(', ') || 'no probes'} -->`);

  const checklist = deriveChecklist(probe);
  return { workspace, body: lines.join('\n'), sources, checklist };
};

/**
 * Derive a feature checklist seed for the initializer journal from the
 * probe — e.g. package scripts become "wire up: <script>" candidates.
 * Pure; best-effort. Empty array is fine.
 *
 * @param {WorkspaceProbe} probe
 * @returns {string[]}
 */
export const deriveChecklist = (probe = {}) => {
  const items = [];
  const scripts = probe.vm?.packageJson?.scripts;
  if (scripts) {
    for (const k of Object.keys(scripts)) {
      if (/^(test|build|dev|start|lint)$/.test(k)) items.push(`verify \`${k}\` runs clean`);
    }
  }
  if (probe.tab?.url) items.push(`document the goal for ${probe.tab.url}`);
  return items;
};

// ── tiny pure string helpers ───────────────────────────────────────────

/** @param {unknown} s @param {number} n */
const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
/** @param {unknown} s */
const collapseWs = (s) => String(s ?? '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
