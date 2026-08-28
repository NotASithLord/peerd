// @ts-check

import {
  activateUserHook,
  compileUserHook,
  deactivateUserHook,
  deriveChecklist,
  draftAgentsMd,
  exportHooks,
  listHooks,
  loadUserHooks,
  parseHookMarkdown,
  parseSkillMd,
  resolveWorkspaceKey,
} from '/peerd-runtime/controller-administrative.js';
import { makeSerialLane } from '/shared/cold-util.js';
import { DEFAULT_HOOK_MANIFEST } from '/shared/default-hook-manifest.js';

class AdministrativeEffectError extends Error {
  /** @param {string} operation @param {any} result */
  constructor(operation, result) {
    super(`${operation}: ${result?.error ?? result?.code ?? 'administrative effect failed'}`);
    this.name = 'AdministrativeEffectError';
    this.code = result?.code ?? 'administrative-effect-failed';
    this.outcomeKnown = result?.outcomeKnown === true;
  }
}

const effectValue = async (/** @type {any} */ context, /** @type {string} */ operation,
  /** @type {Record<string,unknown>} */ payload) => {
  const result = await context.effects.call(operation, payload);
  if (result?.ok !== true || result.outcomeKnown !== true) {
    throw new AdministrativeEffectError(operation, result);
  }
  return result.value;
};
const note = async (/** @type {any} */ context, /** @type {string} */ text) => {
  try { await context.effects.call('administrative.memory.note', { text }); } catch {}
};
const serializeHook = (/** @type {any} */ hook) => ({
  id: hook.id,
  event: hook.event,
  enabled: hook.enabled !== false,
  order: hook.order ?? 100,
  match: hook.match ?? '*',
  isDefault: false,
  kind: hook._record?.kind ?? 'builtin',
  doc: hook._record?.doc ?? hook.description ?? '',
  unsupported: hook.unsupported === true,
  unsupportedReason: hook.unsupportedReason ?? '',
});

const defaultIds = new Set(DEFAULT_HOOK_MANIFEST.map((hook) => hook.id));
const defaultHooks = DEFAULT_HOOK_MANIFEST.map(({ description, ...hook }) => ({
  ...hook, isDefault: true, kind: 'builtin', doc: description,
}));
// Durable records are the cross-realm truth. Reload on every administrative
// call so a transfer import performed in the SW becomes visible immediately;
// semantic turns independently read the same KV key at turn admission.
const ensureHooks = (/** @type {any} */ context) => loadUserHooks({
  kv: { get: () => effectValue(context, 'administrative.hooks.read', {}) },
});
const hookWrites = makeSerialLane();
const mutateHook = (/** @type {string} */ route) => async (
  /** @type {any} */ message, /** @type {any} */ context,
) => hookWrites(async () => {
  await ensureHooks(context);
  const hasUserRecord = (/** @type {string} */ id) => exportHooks()
    .some((record) => record.id === id);
  if (route === 'hooks/remove'
      && defaultIds.has(message?.id) && !hasUserRecord(message.id)) {
    return { ok: false, error: 'cannot remove a default hook' };
  }
  if (route === 'hooks/toggle'
      && defaultIds.has(message?.id) && !hasUserRecord(message.id)) {
    return { ok: false, error: 'cannot disable a built-in hook' };
  }
  try {
    if (route === 'hooks/save') {
      const record = typeof message?.markdown === 'string'
        ? parseHookMarkdown(message.markdown)
        : message?.record;
      compileUserHook(record);
      const source = typeof message?.markdown === 'string'
        ? { markdown: message.markdown }
        : { record: message?.record };
      const result = await effectValue(context, 'administrative.hooks.save', { source });
      if (result?.ok !== true) return result ?? { ok: false, error: 'save-failed' };
      activateUserHook(record);
      return { ok: true, id: record.id };
    }
    if (route === 'hooks/remove') {
      const result = await effectValue(context, 'administrative.hooks.remove', { id: message?.id });
      if (result?.ok !== true) return result ?? { ok: false, error: 'remove-failed' };
      deactivateUserHook(message.id);
      return { ok: true };
    }
    const record = exportHooks().find((candidate) => candidate.id === message?.id);
    if (!record) return { ok: false, error: 'not-found' };
    const next = { ...record, enabled: message?.enabled === true };
    compileUserHook(next);
    const result = await effectValue(context, 'administrative.hooks.toggle', {
      id: message.id, enabled: next.enabled,
    });
    if (result?.ok !== true) return result ?? { ok: false, error: 'toggle-failed' };
    activateUserHook(next);
    return { ok: true };
  } catch (cause) {
    if (cause instanceof AdministrativeEffectError) {
      if (cause.code === 'administrative-hooks-limit' && cause.outcomeKnown) {
        return { ok: false, code: cause.code, error: cause.message, outcomeKnown: true };
      }
      throw cause;
    }
    return { ok: false, error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
  }
});

const runMemoryInit = async (/** @type {any} */ context) => {
  const [tabProbe, apps] = await Promise.all([
    effectValue(context, 'administrative.memory.probeTab', {}),
    effectValue(context, 'administrative.memory.listApps', {}),
  ]);
  const probe = {
    tab: tabProbe?.tab ?? undefined,
    apps: Array.isArray(apps) ? apps : [],
  };
  const workspace = resolveWorkspaceKey(probe);
  const { body, sources, checklist } = draftAgentsMd(probe);
  await note(context, `/init scanned workspace **${workspace}** (sources: ${sources.join(', ') || 'none'}). `
    + 'Review the proposed AGENTS.md and confirm to save it to project memory.');
  if (typeof tabProbe?.warning === 'string' && tabProbe.warning) {
    await note(context, tabProbe.warning);
  }
  const result = /** @type {any} */ (await effectValue(
    context,
    'administrative.memory.commitInit',
    { workspace, body, checklist: checklist.length ? checklist : deriveChecklist(probe) },
  ));
  if (result?.rejected) {
    await note(context, '/init cancelled — nothing was saved.');
    return result;
  }
  if (result?.ok !== true) {
    await note(context, `/init failed: ${result?.error ?? 'memory write could not be completed'}`);
    return result;
  }
  await note(context, `/init saved AGENTS.md for **${workspace}** and started an initializer journal. `
    + 'It now loads into context at the start of every session here.');
  return result;
};

const installLocalSkill = async (/** @type {any} */ message, /** @type {any} */ context) => {
  if (typeof message?.text !== 'string' || !message.text.trim()) {
    return { ok: false, error: 'install-failed', detail: 'local install requires SKILL.md text' };
  }
  try {
    parseSkillMd(message.text);
  }
  catch (cause) {
    return {
      ok: false,
      error: 'parse-failed',
      detail: /** @type {{message?:string}} */ (cause)?.message ?? String(cause),
    };
  }
  const result = /** @type {any} */ (await effectValue(
    context,
    'administrative.skills.commit',
    {
      text: message.text,
      origin: typeof message.origin === 'string' ? message.origin : 'local',
      replace: message.replace === true,
    },
  ));
  return result?.ok === true
    ? { ok: true, skill: result.skill }
    : result ?? { ok: false, error: 'install-failed' };
};

export const routes = Object.freeze({
  'hooks/list': async (/** @type {any} */ _message, /** @type {any} */ context) => {
    await ensureHooks(context);
    return { ok: true, hooks: [...defaultHooks, ...listHooks().map(serializeHook)] };
  },
  'hooks/save': mutateHook('hooks/save'),
  'hooks/remove': mutateHook('hooks/remove'),
  'hooks/toggle': mutateHook('hooks/toggle'),
  'memory/init': async (/** @type {any} */ _message, /** @type {any} */ context) => {
    try { return await runMemoryInit(context); }
    catch (cause) {
      await note(context, `/init failed: ${/** @type {{message?:string}} */ (cause)?.message ?? String(cause)}`);
      return { ok: false, error: 'init-failed' };
    }
  },
  'skills/installGit': async () => ({ ok: false, error: 'remote-install-disabled' }),
  'skills/installLocal': installLocalSkill,
  'skills/installManifest': async () => ({ ok: false, error: 'remote-install-disabled' }),
});
