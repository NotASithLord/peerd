// @ts-check

import { SkillParseError } from '../shared/skill-document.js';
import {
  createKernelSkillPersistence,
  KernelSkillExistsError,
} from './kernel-skill-persistence.js';

export { KernelSkillExistsError, SkillParseError };

export class KernelSkillInstallError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'SkillInstallError'; }
}

/** @param {Parameters<typeof createKernelSkillPersistence>[0]} deps */
export const createKernelSkillInstaller = (deps = {}) => {
  const persistence = createKernelSkillPersistence(deps);
  return Object.freeze({
    install: (/** @type {string} */ text, /** @type {any} */ options = {}) =>
      persistence.commit(text, options),
  });
};
