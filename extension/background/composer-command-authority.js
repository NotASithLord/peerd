// @ts-check

import { controllerPayloadBytes } from '../shared/structured-clone-size.js';
import {
  COMPOSER_COMMAND_BODY_BYTES,
  COMPOSER_COMMAND_DESCRIPTION_BYTES,
  COMPOSER_COMMAND_LIMIT,
  COMPOSER_COMMAND_NAME_BYTES,
  COMPOSER_COMMAND_RESULT_BYTES,
  composerUtf8Fits,
} from '../shared/composer-reference-policy.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const validCandidate = (/** @type {unknown} */ candidate) => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const value = /** @type {Record<string,unknown>} */ (candidate);
  return typeof value.name === 'string' && NAME_RE.test(value.name)
    && composerUtf8Fits(value.name, COMPOSER_COMMAND_NAME_BYTES)
    && composerUtf8Fits(value.body, COMPOSER_COMMAND_BODY_BYTES)
    && (value.description === undefined
      || composerUtf8Fits(value.description, COMPOSER_COMMAND_DESCRIPTION_BYTES));
};

/**
 * Normalize the only command list that both grants reference reads and crosses
 * into the sealed controller. Invalid or over-budget rows grant nothing.
 * @param {readonly unknown[]} local
 * @param {readonly unknown[]} skills
 */
export const normalizeComposerCommands = (local, skills) => {
  /** @type {Map<string,{name:string,body:string,description:string}>} */
  const candidates = new Map();
  const add = (/** @type {readonly unknown[]} */ rows,
    /** @type {string} */ fallbackDescription) => {
    for (const row of rows) {
      if (!validCandidate(row)) continue;
      const candidate = /** @type {{name:string,body:string,description?:string}} */ (row);
      if (candidates.has(candidate.name)) continue;
      candidates.set(candidate.name, Object.freeze({
        name: candidate.name,
        body: candidate.body,
        description: candidate.description ?? fallbackDescription,
      }));
    }
  };
  add(local, '');
  add(skills, 'from a skill');
  /** @type {Array<{name:string,body:string,description:string}>} */
  const normalized = [];
  for (const candidate of [...candidates.values()]
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (normalized.length >= COMPOSER_COMMAND_LIMIT) break;
    const next = [...normalized, candidate];
    const bytes = controllerPayloadBytes(
      { ok: true, outcomeKnown: true, value: next },
      { maxDepth: 24, maxNodes: 50_000 },
    );
    if (!Number.isFinite(bytes) || bytes > COMPOSER_COMMAND_RESULT_BYTES) continue;
    normalized.push(candidate);
  }
  return Object.freeze(normalized);
};
