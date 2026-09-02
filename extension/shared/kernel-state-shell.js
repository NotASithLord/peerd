// @ts-check

import {
  validateKernelStateProjection,
} from './kernel-state-contract.js';

/** @param {unknown} value @returns {value is Record<string, any>} */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @returns {Record<string, any>|null} */
export const normalizeColdStateSnapshot = (value) => {
  if (!record(value)) return null;
  const validated = validateKernelStateProjection(value);
  return validated.ok ? validated.state : null;
};

/** @param {unknown} current @param {unknown} next @param {ReadonlySet<string>} [retired]
 * @param {string|null} [replacementEpoch] */
export const coldStateIsCurrent = (current, next, retired = new Set(), replacementEpoch = null) => {
  const prior = record(current) ? current.projection : null;
  const incoming = record(next) ? next.projection : null;
  if (!record(incoming)) return !record(prior);
  if (retired.has(String(incoming.authorityEpoch))) return false;
  return !record(prior) || incoming.authorityEpoch === prior.authorityEpoch
    ? !record(prior) || incoming.generation >= prior.generation
    : incoming.authorityEpoch === replacementEpoch;
};

/**
 * Stateful custody for rich extension pages. A projected authority may advance
 * monotonically on its current Port. A different authority epoch is accepted
 * only after the owning surface explicitly begins a Port replacement; once the
 * replacement lands, the old epoch is retired and cannot recapture the page via
 * a delayed Port event or state/get reply.
 */
export const makeKernelStateCustody = () => {
  /** @type {Record<string, any>|null} */
  let current = null;
  let replacementAllowed = false;
  let sourceGeneration = 0;
  const retired = new Set();

  const beginReplacement = () => {
    replacementAllowed = true;
    sourceGeneration += 1;
  };
  const capture = () => sourceGeneration;

  /** @param {unknown} value @param {number} [source] @param {boolean} [replace] */
  const adopt = (value, source = sourceGeneration, replace = false) => {
    if (source !== sourceGeneration) return null;
    const normalized = normalizeColdStateSnapshot(value);
    if (!normalized) return null;
    const incomingEpoch = normalized.projection?.authorityEpoch;
    const replacementEpoch = (replacementAllowed || replace) && typeof incomingEpoch === 'string'
      ? incomingEpoch : null;
    if (!coldStateIsCurrent(current, normalized, retired, replacementEpoch)) return null;

    const priorEpoch = current?.projection?.authorityEpoch;
    const replaced = typeof priorEpoch === 'string' && typeof incomingEpoch === 'string'
      && priorEpoch !== incomingEpoch;
    if (replaced) retired.add(priorEpoch);
    current = normalized;
    replacementAllowed = false;
    return Object.freeze({ state: normalized, replaced });
  };

  return Object.freeze({ adopt, beginReplacement, capture });
};
