// @ts-check
// Skill registry — the core deliverable.
//
// It owns the PROGRESSIVE-DISCLOSURE contract:
//   - at startup it loads only skill DESCRIPTIONS (cheap) into an
//     in-memory index, by reading the meta store. No skill body is
//     deserialized. `describeForPrompt()` renders these into the system-
//     prompt block. This is the <200-line lean-memory budget in action.
//   - on invocation `loadBody(name)` reads the full SKILL.md body from
//     the body store (expensive) — and ONLY then.
//
// The registry is the imperative shell's coordinator: it caches metas in
// memory for the SW lifetime (rebuilt cheaply on cold start from the
// store) and delegates persistence to the injected store (store.js, or
// feature 01's workspace store once integrated).
//
// SAFETY: the registry never executes anything. Installing a skill only
// records text. A skill's `allowedTools` are advisory metadata — the
// registry exposes them for display but the dispatcher's six gates remain
// the sole authority on what a tool call may do. A skill cannot widen
// egress or auto-run code by being installed; it can only add instruction
// text the model may later read.

import { parseSkillMd, SkillParseError } from './parse.js';

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
  /** @type {Map<string, import('./store.js').SkillMeta> | null} */
  let cache = null;

  // Lazily hydrate the in-memory description index from the meta store.
  // Cold SW start pays one getAll over META ONLY — bodies stay on disk.
  const ensureCache = async () => {
    if (cache) return cache;
    cache = new Map();
    for (const meta of await store.listMeta()) cache.set(meta.id, meta);
    return cache;
  };

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
    const c = await ensureCache();
    if (c.has(parsed.name) && !opts.replace) {
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
    c.set(meta.id, meta);
    _audit({ type: 'skill_installed', details: { name: meta.id, source: meta.source, origin: meta.origin } }).catch(() => {});
    return meta;
  };

  /**
   * List installed skill metas (descriptions only — never bodies).
   * @returns {Promise<import('./store.js').SkillMeta[]>}
   */
  const list = async () => [...(await ensureCache()).values()]
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
    const lines = enabled.map((s) => `  ${s.name} — ${oneLine(s.description)}`);
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
    const c = await ensureCache();
    const meta = c.get(name);
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
    const c = await ensureCache();
    const meta = c.get(name);
    if (!meta) throw new SkillNotFoundError(name);
    const next = { ...meta, enabled: !!enabled };
    const body = await store.getBody(name);
    await store.put(next, body ?? '');
    c.set(name, next);
    return next;
  };

  /**
   * Uninstall (reversibility — every install is removable). Idempotent.
   * @param {string} name
   */
  const remove = async (name) => {
    const c = await ensureCache();
    if (!c.has(name)) return false;
    await store.remove(name);
    c.delete(name);
    _audit({ type: 'skill_removed', details: { name } }).catch(() => {});
    return true;
  };

  /**
   * Enabled skills surfaced as composer slash commands — the feature-04
   * integration point (composer/command-sources.js skillRegistrySource
   * depends only on this method; see docs/COMMANDS-DESIGN.md).
   *
   * why the body routes through load_skill instead of inlining the skill
   * body: progressive disclosure is the whole point of the skills tier —
   * the command stays cheap (one instruction line), and the full
   * instructions load only when the agent calls the tool. A local
   * .peerd/commands/ entry of the same name shadows these (earlier source
   * wins in mergeSources), so users can always override.
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
 * @param {string} s
 */
const oneLine = (s) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}…` : flat;
};

/**
 * @typedef {ReturnType<typeof createSkillRegistry>} SkillRegistry
 */
