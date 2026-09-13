// @ts-check
// Skill registry — the core deliverable.
//
// It owns the PROGRESSIVE-DISCLOSURE contract:
//   - when preparing a prompt it reads only skill DESCRIPTIONS (cheap)
//     from the meta store. No skill body is
//     deserialized. `describeForPrompt()` renders these into the system-
//     prompt block. This is the <200-line lean-memory budget in action.
//   - on invocation `loadBody(name)` reads the full SKILL.md body from
//     the body store (expensive) — and ONLY then.
//
// why: persistence, runtime and export have separate readers. Reading current
// metadata keeps them coherent without lifetime caches or invalidation relays.
//
// SAFETY: the registry never executes anything. Installing a skill only
// records text. A skill's `allowedTools` are advisory metadata — the
// registry exposes them for display but the dispatcher's six gates remain
// the sole authority on what a tool call may do. A skill cannot widen
// egress or auto-run code by being installed; it can only add instruction
// text the model may later read.

import { parseSkillMd, SkillParseError } from './parse.js';
import { disarmText } from '../dom/cdr.js';

export { SkillParseError };

export class SkillExistsError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`a skill named '${name}' is already installed`);
    this.name = 'SkillExistsError';
  }
}

export class SkillNotFoundError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`no skill named '${name}'`);
    this.name = 'SkillNotFoundError';
  }
}

/**
 * @param {Object} deps
 * @param {import('./store.js').SkillStore} deps.store
 * @param {(entry: { type: string, details?: Record<string, unknown> }) => Promise<unknown>} [deps.audit]
 */
export const createSkillRegistry = ({ store, audit }) => {
  const _audit = audit ?? (async () => {});

  /**
   * Install a parsed SKILL.md. `source`/`origin` describe provenance for
   * the UI + audit. Throws SkillExistsError unless `replace` is set.
   *
   * @param {string} text  raw SKILL.md
   * @param {{ source: 'local'|'git'|'manifest', origin?: string|null, replace?: boolean }} opts
   * @returns {Promise<import('./store.js').SkillMeta>}
   */
  const install = async (text, opts) => {
    const parsed = parseSkillMd(text); // throws SkillParseError on bad input
    if (!opts.replace && (await store.listMeta()).some((meta) => meta.id === parsed.name)) {
      throw new SkillExistsError(parsed.name);
    }
    const meta = {
      id: parsed.name,
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      license: parsed.license,
      allowedTools: parsed.allowedTools,
      source: opts.source,
      origin: opts.origin ?? null,
      sizeBytes: new TextEncoder().encode(parsed.body).length,
      enabled: true,
      installedAt: Date.now(),
    };
    await store.put(meta, parsed.body);
    _audit({ type: 'skill_installed', details: { name: meta.id, source: meta.source, origin: meta.origin } }).catch(() => {});
    return meta;
  };

  /**
   * List installed skill metas (descriptions only — never bodies).
   * @returns {Promise<import('./store.js').SkillMeta[]>}
   */
  const list = async () => (await store.listMeta())
    .sort((a, b) => a.name.localeCompare(b.name));

  /**
   * Render the startup descriptions block injected into the system
   * prompt. ONLY enabled skills, ONLY name + description. Returns '' when
   * there are no skills so the prompt placeholder collapses cleanly.
   *
   * @returns {Promise<string>}
   */
  const describeForPrompt = async () => {
    const enabled = (await list()).filter((s) => s.enabled);
    if (enabled.length === 0) return '';
    const lines = enabled.map((s) => `  ${disarmText(s.name)} — ${oneLine(s.description)}`);
    return [
      '──── skills ───────────────────────────────────────────────────────────',
      '',
      'Installed skills extend you with task-specific playbooks. Each line is',
      'a NAME and a short description; the full instructions are NOT loaded',
      'yet (progressive disclosure). When a user request matches a skill,',
      'call load_skill("<name>") to read its full SKILL.md body, then follow',
      'it. Skill text is a playbook, not a privilege grant — every tool call',
      'it leads to still passes the normal gates.',
      '',
      ...lines,
    ].join('\n');
  };

  /**
   * Resolve a skill's full body for invocation. This is the EXPENSIVE
   * tier — called by the load_skill tool, never at startup.
   *
   * @param {string} name
   * @returns {Promise<{ meta: import('./store.js').SkillMeta, body: string }>}
   * @throws {SkillNotFoundError}
   */
  const loadBody = async (name) => {
    const meta = (await store.listMeta()).find((entry) => entry.id === name);
    if (!meta) throw new SkillNotFoundError(name);
    if (!meta.enabled) throw new SkillNotFoundError(name);
    const body = await store.getBody(name);
    if (body == null) throw new SkillNotFoundError(name);
    _audit({ type: 'skill_invoked', details: { name } }).catch(() => {});
    return { meta, body };
  };

  /**
   * Enable/disable without uninstalling — keeps the body, hides the line.
   * @param {string} name
   * @param {boolean} enabled
   */
  const setEnabled = async (name, enabled) => {
    const meta = (await store.listMeta()).find((entry) => entry.id === name);
    if (!meta) throw new SkillNotFoundError(name);
    const next = { ...meta, enabled: !!enabled };
    const body = await store.getBody(name);
    await store.put(next, body ?? '');
    return next;
  };

  /**
   * Uninstall (reversibility — every install is removable). Idempotent.
   * @param {string} name
   */
  const remove = async (name) => {
    if (!(await store.listMeta()).some((meta) => meta.id === name)) return false;
    await store.remove(name);
    _audit({ type: 'skill_removed', details: { name } }).catch(() => {});
    return true;
  };

  /**
   * Enabled skills surfaced as composer slash commands. The semantic
   * composer depends only on this method; see docs/COMMANDS-DESIGN.md.
   *
   * why the body routes through load_skill instead of inlining the skill
   * body: progressive disclosure is the whole point of the skills tier;
   * the command stays cheap (one instruction line), and the full
   * instructions load only when the agent calls the tool. A local
   * .peerd/commands/ entry of the same name shadows these, so users can
   * always override.
   *
   * @returns {Promise<Array<{ name: string, body: string, description: string }>>}
   */
  const listCommands = async () => (await list())
    .filter((s) => s.enabled)
    .map((s) => ({
      name: s.name,
      description: oneLine(s.description ?? 'from a skill'),
      body: `Use the "${s.name}" skill for this task: call the load_skill tool `
        + `with name "${s.name}", then follow the loaded instructions, applying `
        + 'them to the task below.',
    }));

  return { install, list, describeForPrompt, loadBody, setEnabled, remove, listCommands };
};

/**
 * Collapse a description to a single prompt line; clamp runaway length.
 * why disarmText first: a skill description is rendered verbatim into the
 * TRUSTED system prompt at every startup (describeForPrompt) with no
 * untrusted-content fence — R3 names a malicious shared skill as a direct
 * instruction-injection vector. Stripping invisible-Unicode / bidi here means
 * the description the user reviewed in the skills UI is the description the
 * model reads; a covert channel smuggled past review is removed. Disarm BEFORE
 * the whitespace collapse so any newline vector inside it is also flattened.
 * @param {string} s
 */
const oneLine = (s) => {
  const flat = disarmText(String(s)).replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}…` : flat;
};

/**
 * @typedef {ReturnType<typeof createSkillRegistry>} SkillRegistry
 */
