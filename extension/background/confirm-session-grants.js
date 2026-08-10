// @ts-check
// Confirmation session-grant policy. Kept pure so the safety distinction
// between a reusable convenience grant and a one-shot recovery decision is
// executable in tests instead of being implicit in service-worker branches.

import { confirmGrantKey } from './confirm-grant-key.js';

/** @typedef {Map<string, Set<string>>} ConfirmGrantStore */

/**
 * @param {{ prompt: { tool: string, origins?: string[], oneShot?: boolean },
 *   sessionId: string | null, ephemeral: boolean, grants: ConfirmGrantStore }} input
 * @returns {'yes_session' | null}
 */
export const cachedSessionConfirmAnswer = ({ prompt, sessionId, ephemeral, grants }) => {
  if (prompt.oneShot === true || ephemeral || !sessionId) return null;
  return grants.get(sessionId)?.has(confirmGrantKey(prompt)) ? 'yes_session' : null;
};

/**
 * @param {{ prompt: { tool: string, origins?: string[], oneShot?: boolean },
 *   sessionId: string | null, ephemeral: boolean, answer: string,
 *   grants: ConfirmGrantStore }} input
 * @returns {boolean} whether a standing grant was stored
 */
export const rememberSessionConfirmAnswer = ({
  prompt, sessionId, ephemeral, answer, grants,
}) => {
  if (prompt.oneShot === true || ephemeral || !sessionId || answer !== 'yes_session') return false;
  if (!grants.has(sessionId)) grants.set(sessionId, new Set());
  grants.get(sessionId)?.add(confirmGrantKey(prompt));
  return true;
};

/**
 * Fail closed if a stale or forged UI returns a standing answer for a one-shot
 * prompt. The current UI never offers that answer, but the authority boundary
 * still enforces the contract independently.
 *
 * @param {{ oneShot?: boolean }} prompt
 * @param {'yes_once'|'yes_session'|'no'} answer
 * @returns {'yes_once'|'yes_session'|'no'}
 */
export const normalizeOneShotConfirmAnswer = (prompt, answer) =>
  prompt.oneShot === true && answer === 'yes_session' ? 'yes_once' : answer;

/**
 * Resolve one confirmation through the standing-grant boundary. `request` is
 * lazy so a valid ordinary grant avoids opening the channel, while one-shot
 * decisions always reach it.
 *
 * @param {{ prompt: { tool: string, origins?: string[], oneShot?: boolean },
 *   sessionId: string | null, ephemeral: boolean, grants: ConfirmGrantStore,
 *   request: () => Promise<'yes_once'|'yes_session'|'no'> }} input
 * @returns {Promise<'yes_once'|'yes_session'|'no'>}
 */
export const answerWithSessionConfirmGrant = async ({
  prompt, sessionId, ephemeral, grants, request,
}) => {
  const cached = cachedSessionConfirmAnswer({ prompt, sessionId, ephemeral, grants });
  if (cached) return cached;
  const answer = await request();
  rememberSessionConfirmAnswer({ prompt, sessionId, ephemeral, answer, grants });
  return normalizeOneShotConfirmAnswer(prompt, answer);
};
