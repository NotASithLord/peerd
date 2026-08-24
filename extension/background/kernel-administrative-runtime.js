// @ts-check

import {
  makeKernelHooksRoutes, makeKernelMemoryInitRoutes, makeKernelSkillInstallRoutes,
} from './kernel-administrative-routes.js';
import {
  exportHooks, listHooks, loadUserHooks, registerHook, removeHook, saveUserHook,
  parseHookMarkdown, DEFAULT_HOOKS, createMemoryStore, makeInitOrchestrator,
} from '/peerd-runtime/administrative.js';
import { createKernelSkillsAuthority } from './kernel-skills-authority.js';
import {
  KernelSkillExistsError, KernelSkillInstallError, SkillParseError,
} from './kernel-skills-authority.js';

/** @param {Record<string,any>} deps */
export const createKernelAdministrativeRuntime = (deps) => {
  for (const hook of DEFAULT_HOOKS) registerHook(hook);
  const hooksReady = loadUserHooks({ kv: deps.kv });
  const skills = createKernelSkillsAuthority({
    canWrite: () => deps.canWrite('skills'),
    audit: deps.auditLog.append,
    pushState: deps.pushState,
  });
  const memory = createMemoryStore({ idb: deps.idb });
  const init = makeInitOrchestrator({
    tabs: deps.browser.tabs,
    scripting: deps.browser.scripting,
    listApps: deps.listApps,
    memory,
    confirm: async (/** @type {any} */ prompt) => {
      const ownerSessionId = await deps.sessionCache.sessionGet('currentSessionId') ?? null;
      return deps.confirm({
        toolName: 'init', description: prompt.summary ?? 'Create project memory',
        origins: [], sideEffect: 'write', proposal: prompt.proposal,
        sessionId: ownerSessionId, ownerSessionId, dispatchId: null,
      });
    },
    postChatNote: deps.postChatNote,
    getDenylist: deps.getDenylist,
  });
  return Object.freeze({
    ...makeKernelHooksRoutes({
      load: async () => {
        await hooksReady;
        return {
          auditLog: deps.auditLog, kv: deps.kv, listHooks, DEFAULT_HOOKS,
          parseHookMarkdown, saveUserHook, removeHook, exportHooks,
          canWrite: () => deps.canWrite('hooks'),
        };
      },
    }),
    ...makeKernelSkillInstallRoutes({
      skillRegistry: { install: skills.install },
      canWrite: () => deps.canWrite('skills'),
      pushState: deps.pushState,
      REMOTE_SKILL_INSTALL: false,
      installFromLocal: (/** @type {any} */ { registry },
        /** @type {any} */ { text, origin, replace }) => {
        if (typeof text !== 'string' || !text.trim()) {
          throw new KernelSkillInstallError('local install requires SKILL.md text');
        }
        return registry.install(text, { source: 'local', origin: origin ?? 'local', replace });
      },
      installFromGit: async () => { throw new KernelSkillInstallError('remote install disabled'); },
      installFromManifest: async () => {
        throw new KernelSkillInstallError('remote install disabled');
      },
      SkillExistsError: KernelSkillExistsError,
      SkillParseError,
      SkillInstallError: KernelSkillInstallError,
    }),
    ...makeKernelMemoryInitRoutes({
      runInit: async () => {
        if (deps.vault.isLocked()) throw deps.lockedError();
        const posture = await deps.denylistReady();
        if (!posture.ok) throw new Error('denylist policy unavailable');
        return init.runInit();
      },
      canWrite: () => deps.canWrite('memory'),
      postChatNote: deps.postChatNote,
    }),
  });
};
